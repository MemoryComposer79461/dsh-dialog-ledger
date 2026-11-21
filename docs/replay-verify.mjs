#!/usr/bin/env node
/**
 * @file replay-verify.mjs
 * @role C14–C16（机主 S-7 修订版，2026-11-13）「原文重放式对账」校验器。
 *
 * @why 为什么必须有它：
 *   0.9.0 里没有行内 entryHash（S-6 已否决），所以 C14「台账与原文逐字段一致」不能靠
 *   "重算行哈希"来验。S-7 改成 **从原文重放**：拿源会话事件重新算出"这一行应该长什么样"，
 *   再和台账行逐字段比。本文件就是那个重放器，也是 C15/C16 的变异/破坏自检台。
 *   全包此前没有任何重放实现（判据执行清单 §4.1 已核实），C14–C16 在本文件存在之前**不许声称绿**。
 *
 * 用法（离线日检 / 手工触发；**不进 tick**，S-7 约束）：
 *   node docs/replay-verify.mjs --root=<账库根> --sessions=<sessions 目录> [--json] [--maxDetail=N]
 *   node docs/replay-verify.mjs ... --count            # 只统计轮数/行数（C01 型四数），不深比
 *   node docs/replay-verify.mjs ... --fields           # 逐字段重放比对（C14；也是默认模式）
 *   node docs/replay-verify.mjs ... --mutate=<kind>    # 自检：改台账 1 行 1 字段 → 必须红（C15）
 *   node docs/replay-verify.mjs ... --destroy=<kind>   # 自检：破坏账库 → 必须红（C16）
 *   node docs/replay-verify.mjs ... --originals        # C09：每份「原始事件.json」与重放字节逐字节相等
 *   node docs/replay-verify.mjs ... --views            # C10：每份「完整原文.md」正文 hash 独立复算
 *
 *   --mutate=<kind>：sid / turn / ts / seq / status / doc / attachment / code（8 种）
 *        C14 的 7 个比对面（sid/turn/ts/seq/status/doc/attachment）逐一注入，
 *        外加身份锚 `code`（改编码必须也被抓住）。
 *   --destroy=<kind>：delete-row（删整行）/ extra-row（追加伪造行）/
 *        delete-attachment（删附件）/ flip-attachment-byte（改附件一字节）
 *        兼容别名：del-row / add-forged-row / del-attachment
 *
 * 退出码（与 docs/工具-交叉核验封板.mjs 的 0/1/2 风格一致，并新增 3 区分"校验器自身失效"）：
 *   0 = 全绿
 *   1 = 有红（台账与原文不一致）或**变异/破坏自检如期变红**
 *   2 = 用法/环境错误（参数、root/ledger、lib 加载失败）
 *   3 = 自检（mutate/destroy）**没有**如期变红 → 这是"校验器本身失效"的信号，必须与 1 区分；
 *       基线不绿、克隆副本不绿、找不到可注入目标时同样给 3（自检无法成立，绝不当作通过）。
 *
 * 读什么 / 不写什么：
 *   · 原文侧：lib/legacy.js 的 `scanSessionSources` + `readSourceTurns`（与 ingest 同一套选源规则：
 *     v4 优先、v3 只读历史源、v3+v4 并存时按 resolvePairPrefixes 决定要不要补前缀）；
 *     **只算已闭合轮**（与 ingest 一致：未闭合只进 .pending.jsonl，不进台账）。
 *   · 台账侧：lib/ledger.js 的 `readAll(root, {requireLedgerRows:true})`。
 *     ⚠ 必须同时传 `repairTornTail:false`：默认的"撕裂尾巴自愈"会**截断账文件**，
 *       而本工具是只读校验器（与 reconcile 同一条纪律），不许动账库一个字节。
 *   · 附件：把台账 `attachment.sha256` 与第 3 级原文目录里的实际文件重算比对
 *     （删附件 → ATTACHMENT_MISSING；改一字节 → ATTACHMENT_HASH_MISMATCH）。
 *   · 普通模式**零写盘**；`--mutate/--destroy` 只在 `os.tmpdir()` 的**克隆副本**上动手
 *     （账文件复制、原文/附件硬链接，写前先 unlink，绝不透写原账库），结束后删临时目录。
 *
 * 口径与已知限制（审计必读，别把"没判"当"判过"）：
 *   1) **身份字段（code/gen/seq）的可重放性**：`seq=nextSeq(同 s12+gen)`、`gen=nextGen(同 s12 撞车才 B/C)`，
 *      严格复算要求"本账库 = 由 --sessions 这一份语料一次性/按序入账"。本工具按
 *      `scanSessionSources` 的顺序全量重放分配，能严格复现正常入账；如果某轮是"事后补写"导致
 *      序号顺序与轮次顺序不一致，会报 FIELD_MISMATCH seq（这是如实反映，不放宽）。
 *      单会话抽查不在本版范围内（全量模式才谈得上重算身份），要抽查请用 `--count`。
 *   2) `ts`/日期段使用的时区偏移：优先取台账行自带的 `dateOffset`（ingest 写下的 cfg.offsetMinutes），
 *      该会话没有台账行时退回 `--offset-minutes`（默认 480）。
 *   3) v3 源：只读、绝不写。v3-only 源与 ingest 口径一致**参与比对**（src=session.v3.jsonl.zstd）；
 *      v3+v4 并存里被 v4 覆盖、又不需要补前缀的那个 v3 文件**不参与比对**，但会在报告里
 *      **显式列出**（`skipped.v3` + notes），不静默跳过。加 `--v3=skip` 可显式排除所有 v3 源
 *      （对应的 v3 台账行同步排除并计数，两侧对称，避免"假红"）。
 *   4) 源文件坏帧/坏行：`readTurnsFrom` 会继续解后续帧，本工具照常重放出已闭合轮；
 *      但会记 `skipped.unparsable`/notes 如实披露（源读不全时账缺轮必须能看见）。
 *   5) `--count` 只比"轮数/行数/唯一性/坏行"（C01 型四数），**不**逐字段、**不**读附件；
 *      数量相等不等于逐字段一致 —— C14 必须用 `--fields`。
 *   6) C09（--originals）：每轮用**同一个** `renderOriginal` 重放出「原始事件.json」字节
 *      （序列化口径 = lib/original.js 的 `buildEventsAttachment`，L420-L431：
 *      事件按 seq 升序、`events.map(JSON.stringify).join('\n') + '\n'`），再与第 3 级原文目录里的
 *      磁盘附件做 **长度 + sha256 + Buffer.equals** 三重比较（默认全量，不抽样）；
 *      默认覆盖"台账里有的行"（配对成功的轮），`--all` 时要求**每一轮重放轮**都有附件（缺失即红）。
 *   7) C10（--views）：**不** import `original.verifyOriginal` / `originalBodyHash`，
 *      本文件独立实现「正文 = 行首 `## 1.` 到文件末尾（含末尾换行）→ sha256 UTF-8 hex」，
 *      遍历 root 下全部 `* 完整原文.md` 与 YAML `正文hash` 比对；
 *      `--views-limit=N` 只用于调试（默认全量，限流时报告里显式标注"不能当 C10 全量证据"）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

// ============================================================================
// 0. 命令行
// ============================================================================

/** 退出码常量。3 是"自检没抓住"专用，不许与 1（有红）混用。 */
const EXIT = Object.freeze({ GREEN: 0, RED: 1, USAGE: 2, SELFCHECK_BROKEN: 3 });

/** C14 的 7 个比对面 + 身份锚 `code`（`--mutate` 支持全集）。 */
const COMPARE_FIELDS = Object.freeze(['sid', 'turn', 'ts', 'seq', 'status', 'doc', 'attachment', 'code']);

/** 自检注入的字段名（与 COMPARE_FIELDS 同集；attachment 的期望落到 attachment.* 子字段）。 */
const MUTATE_KINDS = COMPARE_FIELDS.slice();

/** C16 的四类破坏 + 计划里的别名。 */
const DESTROY_KINDS = Object.freeze(['delete-row', 'extra-row', 'delete-attachment', 'flip-attachment-byte']);
const DESTROY_ALIASES = Object.freeze({
  'del-row': 'delete-row',
  'add-forged-row': 'extra-row',
  'del-attachment': 'delete-attachment',
  'flip-attachment': 'flip-attachment-byte',
});

const argv = process.argv.slice(2);
const hasFlag = (k) => argv.includes(k);
const argOf = (k, d = '') => {
  const a = argv.find((x) => x === k || x.startsWith(k + '='));
  if (!a) return d;
  const i = a.indexOf('=');
  return i < 0 ? true : a.slice(i + 1);
};

const RAW = {
  root: String(argOf('--root', '') || ''),
  sessions: String(argOf('--sessions', '') || ''),
  json: !!argOf('--json', false),
  count: !!argOf('--count', false),
  fields: !!argOf('--fields', false),
  mutate: String(argOf('--mutate', '') || ''),
  destroy: String(argOf('--destroy', '') || ''),
  originals: !!argOf('--originals', false),
  views: !!argOf('--views', false),
  all: hasFlag('--all'),
  viewsLimitRaw: argOf('--views-limit', ''),
  v3mode: String(argOf('--v3', 'include') || 'include'),
  offsetMinutes: Number(argOf('--offset-minutes', 480)),
  maxDetailRaw: argOf('--maxDetail', argOf('--max-detail', 20)),
  help: hasFlag('--help') || hasFlag('-h'),
};

const USAGE = `用法:
  node docs/replay-verify.mjs --root=<账库根> --sessions=<sessions 目录> [--json] [--maxDetail=N]
  node docs/replay-verify.mjs ... --count          # 只统计轮数/行数（不深比）
  node docs/replay-verify.mjs ... --fields         # 逐字段重放比对（C14，默认模式）
  node docs/replay-verify.mjs ... --mutate=<kind>  # 自检：改台账 1 行 1 字段，必须红（C15）
  node docs/replay-verify.mjs ... --destroy=<kind> # 自检：破坏账库，必须红（C16）
  node docs/replay-verify.mjs ... --originals      # C09：每份原始事件.json 与重放序列化逐字节相等
  node docs/replay-verify.mjs --root=<账库根> --views   # C10：正文 hash 独立复算（不需要 --sessions）
  node docs/replay-verify.mjs --help

  --originals        每份「原始事件.json」与源会话重放序列化逐字节相等（C09，默认全量）
  --all              配合 --originals：要求每一轮重放轮都有附件（默认只核台账里有的行）
  --views            每份「完整原文.md」的 YAML 正文hash 可独立复算（C10，默认全量）
  --views-limit=N    配合 --views：只查前 N 份（调试用，不能当 C10 全量证据）
  --mutate kinds : ${MUTATE_KINDS.join(' / ')}
  --destroy kinds: ${DESTROY_KINDS.join(' / ')}（别名 ${Object.keys(DESTROY_ALIASES).join(' / ')}）
  --v3=include|skip  v3 只读源是否参与比对（默认 include；skip 时 v3 台账行同步排除并计数）
  --offset-minutes=N 台账行缺 dateOffset 时的时区偏移（默认 480）
  --maxDetail=N      人读报告最多列几条明细（默认 20）
  --json             只输出机读 JSON 到 stdout（需要人读摘要就去掉 --json 再跑一次）

退出码: 0=全绿 1=有红/自检如期变红 2=用法或环境错误 3=自检未如期变红（校验器自身失效）
口径: seq/gen/code 按 --sessions **全量重放**分配 → --sessions 必须是该账库的全集来源；
      单会话抽查不在本版范围（抽查请用 --count，不看身份字段）。v3 只读、未修改。
注意: 本工具是离线只读校验器，不进 tick；普通模式零写盘，--mutate/--destroy 只在临时克隆副本上动手。`;

function usageExit(msg) {
  if (RAW.json) console.log(JSON.stringify({ ok: false, exitCode: EXIT.USAGE, error: msg }, null, 2));
  else { console.error('[用法错误] ' + msg); console.error(''); console.error(USAGE); }
  process.exitCode = EXIT.USAGE;
  return EXIT.USAGE;
}

// ============================================================================
// 0.1 小工具
// ============================================================================

const sha256Hex = (v) => crypto.createHash('sha256')
  .update(Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')).digest('hex');

/** 单条不符记录。**所有**不符都必须经这里入列（`--mutate` 的失效演练会精确替换本函数）。 */
function addMismatch(list, m) {
  list.push({
    code: typeof m.code === 'string' ? m.code : '',
    kind: String(m.kind || 'FIELD_MISMATCH'),
    field: typeof m.field === 'string' ? m.field : '',
    expected: m.expected === undefined ? '' : m.expected,
    actual: m.actual === undefined ? '' : m.actual,
    ...(m.rowCode ? { rowCode: String(m.rowCode) } : {}),
    ...(m.line ? { line: m.line } : {}),
    ...(m.note ? { note: String(m.note) } : {}),
  });
}

const short = (v, n = 220) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const iso = () => new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/** 跨卷时 link 会失败 —— 退回复制，行为等价（克隆出来的副本可随意破坏）。 */
function linkOrCopy(src, dst) {
  ensureDir(path.dirname(dst));
  try { fs.rmSync(dst, { force: true }); } catch { /* 不存在就算了 */ }
  try { fs.linkSync(src, dst); return 'link'; } catch { fs.copyFileSync(src, dst); return 'copy'; }
}

const readJsonlLines = (text) => text.split('\n');

// ============================================================================
// 1. 读台账（只读：requireLedgerRows 强制"只认真账行"，repairTornTail 关闭防写盘）
// ============================================================================

/**
 * @param {string} root
 * @returns {{rows:object[], ok:boolean, files:number, badLines:number, readErrors:object[],
 *            badLineDetails:object[], dirExists:boolean, emptyProven:boolean}}
 */
function readLedger(root, ledgerMod) {
  const all = ledgerMod.readAll(root, {
    requireLedgerRows: true, // A-10：合法 JSON 但缺账行形状（code/ts）也算坏行，ok=false
    repairTornTail: false,   // ★ 校验器只读：不许截断账尾（默认 true 会写盘）
  });
  return {
    rows: all.records,
    ok: all.ok === true,
    files: all.files,
    badLines: all.badLines,
    readErrors: all.readErrors || [],
    badLineDetails: all.badLineDetails || [],
    dirExists: all.dirExists === true,
    emptyProven: all.emptyProven === true,
  };
}

// ============================================================================
// 2. 从原文重放"应有的轮"
// ============================================================================

/**
 * 重放：`sessions 目录 → 应有的台账行骨架`。
 *
 * 与 index.js 的 ingest 口径逐条对齐（这是 C14 能成立的前提）：
 *   · 选源：`scanSessionSources`（v4 优先；v3-only 作为只读历史源纳入；v3+v4 并存时按
 *     `resolvePairPrefixes` 判定 v4 是否缺前缀，缺则把 v3 里 turn < 主源首轮的轮次补进来）；
 *   · 只算**已闭合**轮（turn/start 有配对 turn/end）；被下一轮 start 顶掉的孤儿轮
 *     （reason='abandoned'）在 readTurnsFrom 里已收进 closed，status 记 partial；
 *   · sid 取会话头 id；s12 = normalizeSessionId(sid)；目录名与头不一致的源按 ingest 一样拒绝；
 *   · 日期段 = 会话开始日（head.createdAt，缺省取首轮 startMs，前缀补历史时取更早的 v3 头）；
 *   · code/gen/seq：按 `scanSessionSources` 顺序全量重放分配（nextGen/nextSeq 与 ingest 同函数）。
 *
 * @param {object} p
 * @param {string} p.sessionsBase
 * @param {Map<string,number>} p.offsetBySid 台账行声明的 dateOffset（按 sid）
 * @param {number} p.defaultOffset
 * @param {boolean} p.includeV3 false 时显式排除 v3 源（--v3=skip）
 * @returns {{turns:object[], sessions:object[], skipped:object, notes:object[]}}
 */
function replayTurns({ sessionsBase, offsetBySid, defaultOffset, includeV3 }, legacyMod, ledgerMod, encoderMod, originalMod) {
  const scanned = legacyMod.scanSessionSources(sessionsBase);
  const prefixByDir = legacyMod.resolvePairPrefixes(scanned.pairs);
  const existing = []; // 身份分配历史（nextGen/nextSeq 的输入）
  const turns = [];
  const sessions = [];
  const notes = [];
  const skipped = { v3: 0, unparsable: 0, unsupported: scanned.unsupported.length, v3Rows: 0, frameFailedSources: 0 };

  // v3/v4 并存对：被 v4 覆盖、且不需要补前缀的 v3 文件 = **不参与比对**（必须显式列出）
  for (const pr of scanned.pairs) {
    const used = prefixByDir.has(pr.dir);
    if (used) {
      notes.push({
        kind: 'V3_PREFIX_USED',
        detail: 'v3+v4 并存且 v4 起点更晚：v3 作为**前缀历史源**参与重放（只读）: ' + pr.dir,
      });
    } else if (!includeV3) {
      skipped.v3++;
      notes.push({ kind: 'V3_EXCLUDED', detail: '--v3=skip：该 v3 源不参与比对: ' + pr.v3 });
    } else {
      skipped.v3++;
      notes.push({
        kind: 'V3_NOT_COMPARED',
        detail: 'v3 不参与比对（被 v4 覆盖，且无需补前缀；只读、未修改）: ' + pr.v3,
      });
    }
  }

  for (const s of scanned.supported) {
    const sourceLabel = path.basename(s.dir) + '/' + legacyMod.sourceFileName(s);

    // --v3=skip：v3 源整体不参与（两侧对称排除，见 readLedger 侧的 v3 行过滤）
    if (!includeV3 && s.source === 'v3') {
      skipped.v3++;
      notes.push({ kind: 'V3_EXCLUDED', detail: '--v3=skip：该 v3 源不参与比对: ' + s.path });
      continue;
    }

    let r;
    try {
      // ★ 纯读：不传 root（给了 root 会追加 .lost.jsonl，违反只读纪律）
      r = legacyMod.readSourceTurns(s, { fromByte: 0 });
    } catch (e) {
      skipped.unparsable++;
      notes.push({ kind: 'SOURCE_READ_FAILED', detail: sourceLabel + ' :: ' + (e && e.message ? e.message : String(e)) });
      continue;
    }

    if (r.formatError) {
      // 认不得的源（坏头/坏魔数）：ingest 也是整源不入账，重放同样不计入"应有轮"，
      // 但必须显式登记，不能静默跳过 —— 否则"账缺轮"与"源读不出"分不清。
      skipped.unparsable++;
      notes.push({ kind: 'SOURCE_UNPARSABLE', detail: sourceLabel + ' :: formatError=' + r.formatError });
      continue;
    }
    const head = r.head;
    if (!head || typeof head.id !== 'string') {
      skipped.unparsable++;
      notes.push({ kind: 'SOURCE_NO_HEAD', detail: sourceLabel });
      continue;
    }
    const sid = String(head.id || s.sid || '');
    const s12 = encoderMod.normalizeSessionId(sid);
    if (!s12) {
      skipped.unparsable++;
      notes.push({ kind: 'SID_UNENCODABLE', detail: sourceLabel + ' :: sid=' + short(sid, 64) });
      continue;
    }
    // ingest 的同一道守卫：目录名与头 id 不一致 = 源被换过/伪造成，整源不入账
    const dirName = path.basename(s.dir || '');
    if (dirName.startsWith('session-') && dirName !== sid) {
      const s12dir = encoderMod.normalizeSessionId(dirName);
      if (s12dir && s12dir !== s12) {
        skipped.unparsable++;
        notes.push({ kind: 'SID_DIR_MISMATCH', detail: sourceLabel + ' :: head=' + short(sid, 64) + ' dir=' + dirName });
        continue;
      }
    }

    if (r.meta && r.meta.failed > 0) {
      skipped.frameFailedSources++;
      notes.push({
        kind: 'SOURCE_FRAME_FAILED',
        detail: sourceLabel + ' :: failedFrames=' + r.meta.failed + '/' + r.meta.frames +
          '（readTurnsFrom 继续解后续帧，已闭合轮照常重放；缺口本身已计入 skipped.unparsable=' + skipped.unparsable + ' 之外）',
      });
    }

    // ---- v3 前缀补历史（与 index.js 的 prefixStartMs/prefixTurnSet 同口径）----
    const prefixFile = prefixByDir.get(s.dir) || '';
    let closed = Array.isArray(r.closed) ? r.closed.slice() : [];
    const prefixTurns = new Set();
    let prefixStartMs = 0;
    if (prefixFile) {
      try {
        const pr = legacyMod.readSourceTurns({ path: prefixFile }, { fromByte: 0 });
        const primaryFirst = closed.length > 0
          ? closed.reduce((m, t) => (t.turn < m ? t.turn : m), closed[0].turn)
          : Number.POSITIVE_INFINITY;
        const pre = (pr && Array.isArray(pr.closed) ? pr.closed : []).filter((t) => t.turn < primaryFirst);
        if (pre.length > 0) {
          for (const t of pre) prefixTurns.add(t.turn);
          closed = pre.concat(closed);
          const prHeadMs = pr.head && Number(pr.head.createdAt) > 0 ? Number(pr.head.createdAt) : 0;
          prefixStartMs = prHeadMs > 0 ? prHeadMs : (pre[0] && pre[0].startMs) || 0;
          notes.push({
            kind: 'V3_PREFIX_ADDED',
            detail: sourceLabel + ' :: 从 v3 补前缀 ' + pre.length + ' 轮（turn< ' + primaryFirst + '）',
          });
        }
      } catch (e) {
        skipped.unparsable++;
        notes.push({ kind: 'V3_PREFIX_FAILED', detail: sourceLabel + ' :: ' + (e && e.message ? e.message : String(e)) });
      }
    }

    // M-01/K-4：日期段取会话最早可信时刻（与 index.js 同口径）min(head.createdAt>0, 首轮 startMs>0, v3 前缀>0)
    const createdCands = [];
    if (Number(head.createdAt) > 0) createdCands.push(Number(head.createdAt));
    if (closed.length > 0 && Number(closed[0].startMs) > 0) createdCands.push(Number(closed[0].startMs));
    if (prefixStartMs > 0) createdCands.push(prefixStartMs);
    const createdAt = createdCands.length ? Math.min(...createdCands) : 0;
    if (!(createdAt > 0)) {
      skipped.unparsable++;
      notes.push({ kind: 'NO_CREATED_AT', detail: sourceLabel });
      continue;
    }

    const offset = Number.isInteger(offsetBySid.get(sid))
      ? offsetBySid.get(sid)
      : (Number.isFinite(defaultOffset) ? defaultOffset : 480);
    const dateSeg = encoderMod.dateSegment(createdAt, offset);
    if (!dateSeg) {
      skipped.unparsable++;
      notes.push({ kind: 'BAD_DATE_SEGMENT', detail: sourceLabel + ' :: createdAt=' + createdAt });
      continue;
    }
    const y = Number(dateSeg.slice(0, 4));
    const m = Number(dateSeg.slice(4, 6));

    const gen = encoderMod.nextGen(existing, s12, sid);
    if (!gen) {
      skipped.unparsable++;
      notes.push({ kind: 'GEN_EXHAUSTED', detail: sourceLabel + ' :: s12=' + s12 });
      continue;
    }

    const sessionRecord = {
      dir: s.dir,
      path: s.path,
      source: s.source,
      version: s.version,
      sid,
      s12,
      gen,
      dateSeg,
      year: y,
      month: m,
      offset,
      createdAt,
      prefixFile,
      turnNos: [],
    };
    const turnByNo = new Map();

    for (const t of closed) {
      if (!t || !Number.isInteger(t.turn)) continue;
      const seq = encoderMod.nextSeq(existing, s12, gen);
      const code = encoderMod.makeCode({ date: dateSeg, s12, gen, seq });
      if (!code) {
        notes.push({ kind: 'MAKE_CODE_FAILED', detail: sourceLabel + ' turn=' + t.turn + ' seq=' + seq });
        continue;
      }
      const fromPrefix = prefixTurns.has(t.turn);
      const status = (t.reason === 'partial' || t.reason === 'abandoned') ? 'partial' : 'ok';
      const rec = {
        sid,
        turn: t.turn,
        startMs: t.startMs,
        endMs: t.endMs,
        reason: t.reason || '',
        seq,
        gen,
        s12,
        dateSeg,
        year: y,
        month: m,
        offset,
        code,
        status,
        fromPrefix,
        src: fromPrefix ? 'session.v3.jsonl.zstd' : legacyMod.sourceFileName(s),
        ts: encoderMod.isoTime(t.startMs, offset),
        doc: originalMod.originalRelPath(y, m, code),
        sessionDir: s.dir,
        sourceLabel,
        attachment: null, // 逐字段模式拿到事件后填（renderOriginal）
        events: 0,
      };
      turns.push(rec);
      turnByNo.set(rec.turn, rec);
      sessionRecord.turnNos.push(rec.turn);
      existing.push({ s12, gen, seq, sid });
    }

    sessionRecord.turnByNo = turnByNo;
    sessions.push(sessionRecord);
  }

  return { turns, sessions, skipped, notes, sourceCount: scanned.supported.length };
}

// ============================================================================
// 3. 逐轮事件流（内存 O(1 轮)）与附件期望值
// ============================================================================

/**
 * 流式取"每轮的全部事件"，语义与 lib/ledger.js 的 `readTurnEventsBatch` 对齐：
 *   · 遇到 `turn/start`：先把上一轮交出（无论它有没有 turn/end —— 被顶掉的孤儿轮也不能丢），
 *     再为**本轮**开新收集器（不在 wanted 里的轮直接丢弃，正文解析完即释放）；
 *   · 只收 `data.turn === 当前轮` 的事件（别的轮次号一律丢弃，防止串轮）；
 *   · 遇到 `turn/end` 且轮号匹配：立刻交出该轮。
 * 为什么不用 readTurnEventsBatch：它一次把**整会话所有轮**的事件留在 Map 里（大会话峰值 =
 * 整份会话正文），而重放只需要"一轮事件 → 渲染附件 → 下一轮"。这里复用 lib/frames.js 的
 * 流式解帧，内存只与单轮大小相关。
 *
 * @param {string} filePath
 * @param {Set<number>} wanted
 * @param {(turn:number, events:object[])=>void} onTurn
 * @returns {object} streamFrames 的统计（frames/ok/failed/badMagic）
 */
function streamTurnEvents(filePath, wanted, onTurn, framesMod) {
  let current = null;
  const emit = () => {
    const cur = current;
    current = null;
    if (cur && wanted.has(cur.num)) onTurn(cur.num, cur.events);
  };
  return framesMod.streamFrames(filePath, 0, (text) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev.type !== 'string') continue;
      const num = ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;
      if (ev.type === 'turn/start' && num !== null) {
        emit();
        current = wanted.has(num) ? { num, events: [ev] } : null;
        continue;
      }
      if (!current) continue;
      if (num !== null && num !== current.num) continue;
      current.events.push(ev);
      if (ev.type === 'turn/end' && num === current.num) emit();
    }
  });
}

/**
 * 用 lib/original.js 的 `renderOriginal`（与 ingest 完全同一个渲染器）算该轮的可重放产物。
 * 这里只负责"渲染一次"，两个消费者各自取自己需要的部分：
 *   · `expectedAttachmentOf`（C14）：只要 `{name,sha256,bytes}`（不保留正文，省内存）；
 *   · `replayAttachmentBytes`（C09）：要**整份字节**（`attachment.content`），与磁盘附件逐字节比。
 * @returns {{rendered:object|null, renderError:string}}
 */
function renderTurnForAttachment(exp, events, originalMod) {
  try {
    return {
      rendered: originalMod.renderOriginal({
        events,
        turn: { turn: exp.turn, startMs: exp.startMs, endMs: exp.endMs, reason: exp.reason },
        code: exp.code,
        sid: exp.sid,
        sessKey: exp.s12 + exp.gen,
        seq: exp.seq,
        offsetMinutes: exp.offset,
      }),
      renderError: '',
    };
  } catch (e) {
    return { rendered: null, renderError: e && e.message ? e.message : String(e) };
  }
}

/** @returns {{attachment:{name:string,sha256:string,bytes:number}|null, renderError:string}} */
function expectedAttachmentOf(exp, events, originalMod) {
  const { rendered, renderError } = renderTurnForAttachment(exp, events, originalMod);
  if (renderError) return { attachment: null, renderError };
  const a = rendered && rendered.attachment;
  if (!a) return { attachment: null, renderError: '' };
  return {
    attachment: { name: String(a.name), sha256: String(a.sha256), bytes: Number(a.bytes) },
    renderError: '',
  };
}

/**
 * C09：重放该轮的「原始事件.json」**字节**。
 *
 * 序列化口径不是本文件自创 —— 直接取 `renderOriginal().attachment.content`，
 * 它由 lib/original.js L420-L431 的 `buildEventsAttachment` 产出：
 *   事件按 seq 升序 → `events.map((ev) => JSON.stringify(ev))` → `lines.join('\n') + '\n'`
 *   （一事件一行、不过滤、键序按原对象、LF 结尾；文件名 `<code> 原始事件.json`）。
 * 落盘端 `writeAttachmentFile`（L971-L1043）写的就是这串 UTF-8 字节，所以这里按 UTF-8 取字节即可。
 *
 * @returns {{buf:Buffer|null, name:string, sha256:string, renderError:string}}
 */
function replayAttachmentBytes(exp, events, originalMod) {
  const { rendered, renderError } = renderTurnForAttachment(exp, events, originalMod);
  if (renderError) return { buf: null, name: '', sha256: '', renderError };
  const a = rendered && rendered.attachment;
  if (!a) return { buf: null, name: `${exp.code} 原始事件.json`, sha256: '', renderError: '' };
  return {
    buf: Buffer.from(String(a.content === undefined ? '' : a.content), 'utf8'),
    name: String(a.name),
    sha256: String(a.sha256),
    renderError: '',
  };
}

// ============================================================================
// 4. 台账侧配对与逐字段比对
// ============================================================================

/** 台账行 → 按 (sid,turn) 与 code 建索引，并检出重复。 */
function indexLedgerRows(rows, mismatches, opts) {
  const byTurnKey = new Map(); // sid#turn → row[]
  const byCode = new Map();    // code → row
  const dupCodes = [];
  const dupTurns = [];
  const seenCode = new Set();
  for (const row of rows) {
    const code = typeof row.code === 'string' ? row.code : '';
    if (seenCode.has(code)) { dupCodes.push(code); continue; }
    seenCode.add(code);
    byCode.set(code, row);
    const key = String(row.sid) + '#' + String(row.turn);
    if (!byTurnKey.has(key)) byTurnKey.set(key, []);
    byTurnKey.get(key).push(row);
    if (byTurnKey.get(key).length > 1) dupTurns.push({ key, row });
  }
  if (opts.reportDuplicates) {
    for (const code of dupCodes) {
      addMismatch(mismatches, {
        code, kind: 'DUPLICATE_CODE', field: 'code',
        expected: 'code 在台账内唯一', actual: '出现多行相同 code',
      });
    }
    for (const d of dupTurns) {
      addMismatch(mismatches, {
        code: typeof d.row.code === 'string' ? d.row.code : '',
        kind: 'DUPLICATE_TURN', field: 'turn',
        expected: '(sid,turn) 在台账内唯一', actual: '(sid,turn) 重复: ' + d.key,
      });
    }
  }
  return { byTurnKey, byCode };
}

/**
 * 配对：先按 ingest 的天然键 (sid,turn)，再对剩下的按 `code` 兜底。
 * 为什么要 code 兜底：`sid`/`turn` 被改的变异行会先脱离 (sid,turn) 键，
 * 若没有兜底就只能报 EXTRA+MISSING（看不到"到底哪个字段被改"）；按 code 认出同一行后
 * 才能报 FIELD_MISMATCH sid/turn —— 这正是 C15 要的那种"改哪个字段就抓哪个字段"。
 */
function pairTurns(expectedTurns, ledgerIndex, opts) {
  const pairs = [];
  const usedRows = new Set();
  const pending = [];
  for (const exp of expectedTurns) {
    if (opts.excludeV3 && exp.src === 'session.v3.jsonl.zstd') continue;
    const key = exp.sid + '#' + exp.turn;
    const list = ledgerIndex.byTurnKey.get(key);
    const row = list ? list.find((r) => !usedRows.has(r)) : null;
    if (row) { pairs.push({ exp, row }); usedRows.add(row); }
    else pending.push(exp);
  }
  const missing = [];
  for (const exp of pending) {
    const row = ledgerIndex.byCode.get(exp.code);
    if (row && !usedRows.has(row)) {
      pairs.push({ exp, row, via: 'code' });
      usedRows.add(row);
    } else {
      missing.push(exp);
    }
  }
  const extra = [];
  for (const row of ledgerIndex.rowsAll) {
    if (usedRows.has(row)) continue;
    if (opts.excludeV3 && row.src === 'session.v3.jsonl.zstd') continue;
    extra.push(row);
  }
  return { pairs, missing, extra };
}

/** 标量字段比对（C14）。 */
function compareScalarFields(exp, row, mismatches) {
  const checks = [
    ['sid', exp.sid, row.sid],
    ['turn', exp.turn, row.turn],
    ['ts', exp.ts, row.ts],
    ['seq', exp.seq, row.seq],
    ['status', exp.status, row.status],
    ['doc', exp.doc, row.doc],
    ['code', exp.code, row.code],
  ];
  for (const [field, expected, actual] of checks) {
    if (!Object.is(expected, actual)) {
      addMismatch(mismatches, {
        code: exp.code, kind: 'FIELD_MISMATCH', field, expected, actual,
        ...(field === 'code' && row.code !== exp.code ? { rowCode: row.code } : {}),
      });
    }
  }
}

/**
 * 附件比对（C14 + C16 的磁盘侧）。
 * 期望值来自 renderOriginal（与 ingest 同一渲染器），磁盘值来自第 3 级原文目录里的实际文件：
 *   · 删附件 → ATTACHMENT_MISSING
 *   · 改一字节 → ATTACHMENT_HASH_MISMATCH（磁盘 sha ≠ 台账记录 sha）
 */
function compareAttachment(exp, row, mismatches, filesRoot) {
  const rowAtt = row.attachment && typeof row.attachment === 'object' && !Array.isArray(row.attachment)
    ? row.attachment : null;
  const expAtt = exp.attachment;

  if (!expAtt && !rowAtt) return;
  if (!expAtt || !rowAtt) {
    addMismatch(mismatches, {
      code: exp.code, kind: 'FIELD_MISMATCH', field: 'attachment',
      expected: expAtt, actual: rowAtt,
    });
    // 期望有附件、台账没记 → 继续按期望名找磁盘文件（能报缺失/哈希不符就一并报）
  } else {
    for (const sub of ['name', 'sha256', 'bytes']) {
      if (!Object.is(expAtt[sub], rowAtt[sub])) {
        addMismatch(mismatches, {
          code: exp.code, kind: 'FIELD_MISMATCH', field: 'attachment.' + sub,
          expected: expAtt[sub], actual: rowAtt[sub],
        });
      }
    }
  }

  // ---- 磁盘侧：以"原文目录 + 附件名"为准，兼容旧行的绝对/相对 path ----
  const docDir = path.dirname(path.join(filesRoot, exp.doc));
  const wantName = (expAtt && expAtt.name)
    || (rowAtt && typeof rowAtt.name === 'string' && rowAtt.name)
    || (exp.code + ' 原始事件.json');
  const candidates = [path.join(docDir, wantName)];
  if (rowAtt && typeof rowAtt.name === 'string' && rowAtt.name) candidates.push(path.join(docDir, rowAtt.name));
  if (rowAtt && typeof rowAtt.path === 'string' && rowAtt.path) candidates.push(path.join(filesRoot, rowAtt.path));
  const uniq = [...new Set(candidates)];
  let found = '';
  for (const c of uniq) {
    try { if (fs.statSync(c).isFile()) { found = c; break; } } catch { /* 继续找 */ }
  }
  if (!found) {
    addMismatch(mismatches, {
      code: exp.code, kind: 'ATTACHMENT_MISSING', field: 'attachment.name',
      expected: wantName, actual: '(原文目录下找不到该附件文件)',
    });
    return;
  }
  let raw;
  try { raw = fs.readFileSync(found); } catch (e) {
    addMismatch(mismatches, {
      code: exp.code, kind: 'ATTACHMENT_UNREADABLE', field: 'attachment.name',
      expected: wantName, actual: '读取失败: ' + (e && e.code ? e.code : String(e)),
    });
    return;
  }
  const diskSha = sha256Hex(raw);
  const wantSha = (rowAtt && typeof rowAtt.sha256 === 'string' && rowAtt.sha256)
    || (expAtt && expAtt.sha256) || '';
  if (wantSha && diskSha !== wantSha) {
    addMismatch(mismatches, {
      code: exp.code, kind: 'ATTACHMENT_HASH_MISMATCH', field: 'attachment.sha256',
      expected: wantSha, actual: diskSha,
      note: '磁盘附件重算 sha256 与台账记录不一致',
    });
  }
  const wantBytes = (rowAtt && Number.isInteger(rowAtt.bytes)) ? rowAtt.bytes
    : (expAtt ? expAtt.bytes : null);
  if (Number.isInteger(wantBytes) && raw.length !== wantBytes) {
    addMismatch(mismatches, {
      code: exp.code, kind: 'ATTACHMENT_BYTES_MISMATCH', field: 'attachment.bytes',
      expected: wantBytes, actual: raw.length,
    });
  }
}

/** 原文（doc）文件是否存在：期望路径来自重放 code，不存在即红（C14 的"原文"侧）。 */
function checkDocExists(exp, mismatches, filesRoot) {
  const abs = path.join(filesRoot, exp.doc);
  try {
    if (fs.statSync(abs).isFile()) return;
  } catch { /* 落到下面报 */ }
  addMismatch(mismatches, {
    code: exp.code, kind: 'DOC_MISSING', field: 'doc',
    expected: exp.doc, actual: '(重放指明的原文文件不存在)',
  });
}

// ============================================================================
// 5. 一次完整核验（普通模式与自检模式共用）
// ============================================================================

/**
 * 台账读侧问题 → `LEDGER_UNREADABLE` 红点（普通模式与 C09 `--originals` 共用同一口径：
 * 读不出账就不知道"台账里有的行"是哪些，绝不能当成功读、更不能据此报绿）。
 */
function reportLedgerProblems(led, mismatches, notes) {
  if (led.ok) return;
  for (const e of led.readErrors.slice(0, 50)) {
    addMismatch(mismatches, {
      code: '', kind: 'LEDGER_UNREADABLE', field: '',
      expected: '台账可完整读取（A-10：坏行/读不出都必须报红）',
      actual: (e.code || 'READ_ERROR') + ' @ ' + (e.file || '') + (e.line ? ':' + e.line : '') +
        (e.error ? ' :: ' + short(e.error, 120) : ''),
    });
  }
  if (led.readErrors.length > 50) {
    notes.push({ kind: 'LEDGER_READ_ERRORS_TRUNCATED', detail: '还有 ' + (led.readErrors.length - 50) + ' 条读取错误未逐条列出' });
  }
}

/**
 * @param {object} opt
 * @param {string} opt.root 账库根（普通模式=用户给的；自检模式=临时克隆根）
 * @param {string} opt.sessionsBase
 * @param {'count'|'fields'} opt.mode
 * @param {boolean} opt.includeV3
 * @param {number} opt.defaultOffset
 * @returns {object}
 */
async function verifyOnce(opt, libs) {
  const t0 = Date.now();
  const { ledgerMod, legacyMod, encoderMod, originalMod, framesMod } = libs;
  const mismatches = [];
  const notes = [];

  // ---- ① 台账 ----
  const led = readLedger(opt.root, ledgerMod);
  if (!led.dirExists) {
    return {
      fatality: 'root/ledger 不存在或不是目录: ' + path.join(opt.root, 'ledger'),
    };
  }
  reportLedgerProblems(led, mismatches, notes);

  // 该会话在台账里声明的时区偏移（ts/日期段重放要用同一口径）
  const offsetBySid = new Map();
  for (const row of led.rows) {
    if (!offsetBySid.has(row.sid) && Number.isInteger(row.dateOffset)) offsetBySid.set(row.sid, row.dateOffset);
  }

  // ---- ② 重放 ----
  const rp = replayTurns({
    sessionsBase: opt.sessionsBase,
    offsetBySid,
    defaultOffset: opt.defaultOffset,
    includeV3: opt.includeV3,
  }, legacyMod, ledgerMod, encoderMod, originalMod);
  notes.push(...rp.notes);

  // 源目录一个可识别会话都没有 → 极可能是 --sessions 指错（空重放 ≠ 账对，不能报绿）
  if (rp.sourceCount === 0) {
    return {
      fatality: 'sessions 目录下没有可识别的会话源（session.v3/v4.jsonl.zstd）: ' + opt.sessionsBase +
        '（--sessions 是否指错？空源不能证明账对）',
    };
  }

  // ---- ③ 台账索引 + 重复检查 ----
  const ledgerIndex = indexLedgerRows(led.rows, mismatches, { reportDuplicates: true });
  ledgerIndex.rowsAll = led.rows;

  // v3 排除模式下的台账侧：v3 行不计入 EXTRA/行数（两侧对称，避免假红）
  const v3RowsExcluded = opt.includeV3 ? 0 : led.rows.filter((r) => r.src === 'session.v3.jsonl.zstd').length;

  // ---- ④ 配对 ----
  const { pairs, missing, extra } = pairTurns(rp.turns, ledgerIndex, { excludeV3: !opt.includeV3 });
  for (const exp of missing) {
    addMismatch(mismatches, {
      code: exp.code, kind: 'MISSING_ROW', field: '',
      expected: exp.code + '（sid=' + exp.sid + ' turn=' + exp.turn + ' 应入账）',
      actual: '(台账里没有这一轮)',
    });
  }
  for (const row of extra) {
    addMismatch(mismatches, {
      code: typeof row.code === 'string' ? row.code : '', kind: 'EXTRA_ROW', field: '',
      expected: '(原文里查无此轮)',
      actual: 'sid=' + String(row.sid) + ' turn=' + String(row.turn) + ' src=' + String(row.src || ''),
    });
  }

  const ledgerRowsInScope = led.rows.length - v3RowsExcluded;
  const replayedInScope = rp.turns.length - (opt.includeV3 ? 0 : rp.turns.filter((t) => t.src === 'session.v3.jsonl.zstd').length);

  // ---- ⑤ 逐字段 / 附件（仅在 fields 模式，且只对配对成功的轮做）----
  let compared = 0;
  if (opt.mode === 'fields' && opt.deep !== false) {
    const pairByExp = new Map();
    for (const p of pairs) pairByExp.set(p.exp.code, p);

    for (const session of rp.sessions) {
      const wanted = new Set(session.turnNos);
      if (wanted.size === 0) continue;
      const mainWanted = new Set([...wanted].filter((n) => {
        const rec = session.turnByNo.get(n);
        return rec && !rec.fromPrefix;
      }));
      const preWanted = new Set([...wanted].filter((n) => {
        const rec = session.turnByNo.get(n);
        return rec && rec.fromPrefix;
      }));

      const handleTurn = (turnNo, events) => {
        const exp = session.turnByNo.get(turnNo);
        if (!exp) return;
        const pair = pairByExp.get(exp.code);
        if (!pair) return; // MISSING_ROW 已报；没有台账行就没有"比对"可做
        exp.events = events.length;
        const { attachment, renderError } = expectedAttachmentOf(exp, events, originalMod);
        exp.attachment = attachment;
        if (renderError) {
          addMismatch(mismatches, {
            code: exp.code, kind: 'RENDER_FAILED', field: 'attachment',
            expected: '可按同一渲染器复算附件', actual: short(renderError, 160),
          });
        }
        compareScalarFields(exp, pair.row, mismatches);
        checkDocExists(exp, mismatches, opt.root);
        compareAttachment(exp, pair.row, mismatches, opt.root);
        compared++;
      };

      const emitted = new Set();
      const onTurn = (turnNo, events) => { emitted.add(turnNo); handleTurn(turnNo, events); };
      let stats;
      try {
        stats = streamTurnEvents(session.path, mainWanted, onTurn, framesMod);
      } catch (e) {
        notes.push({ kind: 'SESSION_STREAM_FAILED', detail: session.sourceLabel + ' :: ' + (e && e.message ? e.message : String(e)) });
        stats = null;
      }
      if (stats && (stats.failed > 0 || stats.badMagic)) {
        notes.push({
          kind: 'SESSION_FRAMES_INCOMPLETE',
          detail: session.sourceLabel + ' :: failed=' + stats.failed + ' badMagic=' + stats.badMagic +
            '（这些字节区间里的轮无法重放；若台账有对应行会被报 MISSING/EXTRA 或附件缺失）',
        });
      }
      if (preWanted.size > 0 && session.prefixFile) {
        try {
          streamTurnEvents(session.prefixFile, preWanted, onTurn, framesMod);
        } catch (e) {
          notes.push({ kind: 'PREFIX_STREAM_FAILED', detail: session.sourceLabel + ' :: ' + (e && e.message ? e.message : String(e)) });
        }
      }
      for (const turnNo of wanted) {
        if (emitted.has(turnNo)) continue;
        const exp = session.turnByNo.get(turnNo);
        if (!exp) continue;
        const pair = pairByExp.get(exp.code);
        if (!pair) continue;
        addMismatch(mismatches, {
          code: exp.code, kind: 'EVENT_MISSING', field: 'attachment',
          expected: '该轮事件可从源文件读出（renderOriginal 的输入）',
          actual: '(流式重放没有交出这一轮的事件)',
          note: '源文件读不全时无法重算附件，按红处理',
        });
      }
    }
  }

  const ok = mismatches.length === 0;
  return {
    ok,
    exitCode: ok ? EXIT.GREEN : EXIT.RED,
    mode: opt.mode,
    root: opt.root,
    sessionsBase: opt.sessionsBase,
    ledgerRows: ledgerRowsInScope,
    ledgerRowsTotal: led.rows.length,
    replayedTurns: replayedInScope,
    replayedTurnsTotal: rp.turns.length,
    compared,
    mismatches,
    skipped: {
      v3: rp.skipped.v3,
      unparsable: rp.skipped.unparsable,
      unsupported: rp.skipped.unsupported,
      v3Rows: v3RowsExcluded,
      frameFailedSources: rp.skipped.frameFailedSources,
    },
    counts: {
      ledgerFiles: led.files,
      ledgerBadLines: led.badLines,
      ledgerReadErrors: led.readErrors.length,
      ledgerDirExists: led.dirExists,
      ledgerEmptyProven: led.emptyProven,
      replayedSessions: rp.sessions.length,
      v4Sources: rp.sessions.filter((s) => s.source === 'v4').length,
      v3Sources: rp.sessions.filter((s) => s.source === 'v3').length,
      v3PrefixSessions: rp.sessions.filter((s) => s.prefixFile).length,
      pairs: pairs.length,
      missing: missing.length,
      extra: extra.length,
      codeUnique: new Set(led.rows.map((r) => r.code)).size === led.rows.length,
      sidTurnUnique: new Set(led.rows.map((r) => String(r.sid) + '#' + String(r.turn))).size === led.rows.length,
    },
    notes,
    elapsedMs: Date.now() - t0,
    // 仅供自检/调试：不进入 --json 的顶层输出
    detail: { pairs, ledgerRows: led.rows, replayed: rp.turns, sessions: rp.sessions, ledger: led },
  };
}

/** count 模式：只比四数与唯一性/坏行，不逐字段、不读附件（deep:false 避免解压事件）。 */
async function verifyCount(opt, libs) {
  const base = await verifyOnce({ ...opt, mode: 'fields', deep: false }, libs);
  if (base.fatality) return base;
  const mismatches = base.mismatches.slice(); // 此时只有坏行/读不出/重复类红
  if (base.replayedTurns !== base.ledgerRows) {
    addMismatch(mismatches, {
      code: '', kind: 'COUNT_MISMATCH', field: '',
      expected: '源已闭合轮数=' + base.replayedTurns,
      actual: '台账行数=' + base.ledgerRows,
      note: '行数不等即红（相等的行也不保证逐字段一致，C14 请用 --fields）',
    });
  }
  // fields 预演里检出的坏行/重复已在上面保留；其余只按计数判定。
  const ok = mismatches.length === 0;
  return {
    ...base,
    ok,
    exitCode: ok ? EXIT.GREEN : EXIT.RED,
    mode: 'count',
    compared: 0,
    mismatches,
    elapsedMs: base.elapsedMs,
    detail: base.detail,
  };
}

// ============================================================================
// 5.5 `--originals`：C09 —— 每份「原始事件.json」与源会话重放序列化逐字节相等
// ============================================================================

/** 字节差异描述（C09 明细里必须能说清"哪里不一样"）。 */
function describeBytesDiff(replayBuf, diskBuf) {
  if (replayBuf.length !== diskBuf.length) {
    return '差异类型=LENGTH_DIFF（重放=' + replayBuf.length + 'B，磁盘=' + diskBuf.length + 'B）';
  }
  let i = 0;
  while (i < replayBuf.length && replayBuf[i] === diskBuf[i]) i++;
  return '差异类型=BYTE_DIFF（首个不同字节 offset=' + i +
    '，重放=0x' + replayBuf[i].toString(16).padStart(2, '0') +
    '，磁盘=0x' + diskBuf[i].toString(16).padStart(2, '0') + '）';
}

/**
 * C09：源会话 → 每轮「原始事件.json」字节 → 与第 3 级原文目录里的磁盘附件逐字节比。
 *
 * **口径出处**（不许自创格式）：`replayAttachmentBytes()` 取的 content 就是 ingest 写盘用的
 * `renderOriginal().attachment.content` = lib/original.js L420-L431 `buildEventsAttachment`：
 *   事件按 seq 升序、`events.map(JSON.stringify).join('\n') + '\n'`（一事件一行、LF 结尾）；
 *   落盘位置 = `originalDir(root,y,m)`（L679-L682），文件名 `<code> 原始事件.json`。
 *
 * 范围：默认只核"台账里有的行"（配对成功的轮）；`--all` 时额外要求**每一轮重放轮**都有附件
 * （没有台账行的轮也核，缺失即红）。判定：全部逐字节相等 → exit 0；任一份不符/缺失 → exit 1。
 */
async function verifyOriginals(opt, libs) {
  const t0 = Date.now();
  const { ledgerMod, legacyMod, encoderMod, originalMod, framesMod } = libs;
  const mismatches = [];
  const notes = [];

  // ---- ① 台账（只读）----
  const led = readLedger(opt.root, ledgerMod);
  if (!led.dirExists) {
    return { fatality: 'root/ledger 不存在或不是目录: ' + path.join(opt.root, 'ledger') };
  }
  reportLedgerProblems(led, mismatches, notes);

  const offsetBySid = new Map();
  for (const row of led.rows) {
    if (!offsetBySid.has(row.sid) && Number.isInteger(row.dateOffset)) offsetBySid.set(row.sid, row.dateOffset);
  }

  // ---- ② 全量重放（与 --fields 同一套：这是 code/doc/事件范围能对上的前提）----
  const rp = replayTurns({
    sessionsBase: opt.sessionsBase,
    offsetBySid,
    defaultOffset: opt.defaultOffset,
    includeV3: opt.includeV3,
  }, legacyMod, ledgerMod, encoderMod, originalMod);
  notes.push(...rp.notes);
  if (rp.sourceCount === 0) {
    return {
      fatality: 'sessions 目录下没有可识别的会话源（session.v3/v4.jsonl.zstd）: ' + opt.sessionsBase +
        '（--sessions 是否指错？空源不能证明附件对）',
    };
  }

  const ledgerIndex = indexLedgerRows(led.rows, mismatches, { reportDuplicates: true });
  ledgerIndex.rowsAll = led.rows;
  const { pairs, missing, extra } = pairTurns(rp.turns, ledgerIndex, { excludeV3: !opt.includeV3 });

  // ---- ③ 覆盖范围：默认=台账里有的行；--all=全部重放轮 ----
  const scope = new Map(); // code → exp
  for (const { exp } of pairs) scope.set(exp.code, exp);
  const scopeLabel = opt.all ? 'all' : 'ledger';
  if (opt.all) {
    for (const exp of rp.turns) {
      if (!opt.includeV3 && exp.src === 'session.v3.jsonl.zstd') continue;
      if (!scope.has(exp.code)) scope.set(exp.code, exp);
    }
  } else if (rp.turns.length > 0 && scope.size === 0) {
    // 台账一行都配不上 → "默认只覆盖台账里有的行"会是空集，空集不能证明 C09 成立。
    return {
      fatality: '--originals 没有可核验的目标：台账里没有任何一行能与重放轮配对' +
        '（要覆盖全部重放轮请加 --all）',
    };
  }
  for (const exp of missing) {
    notes.push({
      kind: 'MISSING_ROW',
      detail: exp.code + (opt.all
        ? '（原文有、台账没有；--all 仍核该轮附件）'
        : '（原文有、台账没有；默认模式不核它的附件）'),
    });
  }
  for (const row of extra) {
    notes.push({ kind: 'EXTRA_ROW', detail: String(row.code || '') + '（台账有、原文查无此轮；无法重放，未核）' });
  }

  // ---- ④ 逐轮重放字节 vs 磁盘附件（同 --fields 的流式读法，内存 O(1 轮)）----
  let checked = 0;   // 真正比过字节的附件数
  let equal = 0;     // 逐字节相等的份数
  let bytesCompared = 0;
  let renderFailed = 0;

  for (const session of rp.sessions) {
    const mainWanted = new Set();
    const preWanted = new Set();
    const wanted = new Set();
    for (const turnNo of session.turnNos) {
      const rec = session.turnByNo.get(turnNo);
      if (!rec || !scope.has(rec.code)) continue;
      wanted.add(turnNo);
      if (rec.fromPrefix) preWanted.add(turnNo); else mainWanted.add(turnNo);
    }
    if (wanted.size === 0) continue;

    const emitted = new Set();
    const handleTurn = (turnNo, events) => {
      emitted.add(turnNo);
      const exp = session.turnByNo.get(turnNo);
      if (!exp || !scope.has(exp.code)) return;
      const rb = replayAttachmentBytes(exp, events, originalMod);
      if (rb.renderError) {
        renderFailed++;
        addMismatch(mismatches, {
          code: exp.code, kind: 'RENDER_FAILED', field: 'attachment',
          expected: '可按同一渲染器重放出该轮「原始事件.json」字节', actual: short(rb.renderError, 160),
        });
        return;
      }
      if (!rb.buf || rb.buf.length === 0) {
        addMismatch(mismatches, {
          code: exp.code, kind: 'ORIGINAL_ATTACHMENT_EMPTY_REPLAY', field: 'attachment',
          expected: '非空事件字节（该轮至少含 turn/start）',
          actual: rb.buf ? '0 字节' : '(渲染器未产出附件)',
        });
        return;
      }
      // 第 3 级原文目录 = 重放 doc 的目录；附件名 = `<code> 原始事件.json`
      const attRel = path.join(path.dirname(exp.doc), rb.name);
      const attAbs = path.join(opt.root, attRel);
      let raw = null;
      try {
        raw = fs.readFileSync(attAbs);
      } catch (e) {
        addMismatch(mismatches, {
          code: exp.code, kind: 'ORIGINAL_ATTACHMENT_MISSING', field: 'attachment',
          expected: attRel,
          actual: '第 3 级原文目录下找不到该附件' + (e && e.code ? '（' + e.code + '）' : ''),
          note: 'C09：每份 原始事件.json 必须存在且可读',
        });
        return;
      }
      checked++;
      bytesCompared += raw.length;
      // C09 三重比较：长度 + sha256 + 逐字节（Buffer.equals）
      const replaySha = sha256Hex(rb.buf);
      const diskSha = sha256Hex(raw);
      const sameLen = raw.length === rb.buf.length;
      if (sameLen && replaySha === diskSha && raw.equals(rb.buf)) { equal++; return; }
      addMismatch(mismatches, {
        code: exp.code, kind: 'ORIGINAL_ATTACHMENT_BYTES_MISMATCH', field: 'attachment.bytes',
        expected: 'sha256=' + replaySha + ' bytes=' + rb.buf.length,
        actual: 'sha256=' + diskSha + ' bytes=' + raw.length,
        note: attRel + ' :: ' + describeBytesDiff(rb.buf, raw),
      });
    };

    let stats;
    try {
      stats = streamTurnEvents(session.path, mainWanted, handleTurn, framesMod);
    } catch (e) {
      notes.push({ kind: 'SESSION_STREAM_FAILED', detail: session.sourceLabel + ' :: ' + (e && e.message ? e.message : String(e)) });
      stats = null;
    }
    if (stats && (stats.failed > 0 || stats.badMagic)) {
      notes.push({
        kind: 'SESSION_FRAMES_INCOMPLETE',
        detail: session.sourceLabel + ' :: failed=' + stats.failed + ' badMagic=' + stats.badMagic +
          '（这些字节区间里的轮无法重放原始事件字节，会以 EVENT_MISSING 报红）',
      });
    }
    if (preWanted.size > 0 && session.prefixFile) {
      try {
        streamTurnEvents(session.prefixFile, preWanted, handleTurn, framesMod);
      } catch (e) {
        notes.push({ kind: 'PREFIX_STREAM_FAILED', detail: session.sourceLabel + ' :: ' + (e && e.message ? e.message : String(e)) });
      }
    }
    for (const turnNo of wanted) {
      if (emitted.has(turnNo)) continue;
      const exp = session.turnByNo.get(turnNo);
      if (!exp) continue;
      addMismatch(mismatches, {
        code: exp.code, kind: 'EVENT_MISSING', field: 'attachment',
        expected: '该轮事件可从源文件读出（重放原始事件字节的输入）',
        actual: '(流式重放没有交出这一轮的事件)',
        note: '源文件读不全时无法重算附件字节，按红处理',
      });
    }
  }

  const ok = mismatches.length === 0;
  const covered = scope.size;
  return {
    ok,
    exitCode: ok ? EXIT.GREEN : EXIT.RED,
    mode: 'originals',
    root: opt.root,
    sessionsBase: opt.sessionsBase,
    ledgerRows: led.rows.length,
    replayedTurns: rp.turns.length,
    compared: checked,
    mismatches,
    notes,
    skipped: {
      v3: rp.skipped.v3,
      unparsable: rp.skipped.unparsable,
      unsupported: rp.skipped.unsupported,
      frameFailedSources: rp.skipped.frameFailedSources,
    },
    counts: {
      scope: scopeLabel,
      covered,
      checked,
      equal,
      replayedSessions: rp.sessions.length,
      pairs: pairs.length,
      missingRows: missing.length,
      extraRows: extra.length,
      bytesCompared,
      renderFailed,
      ledgerFiles: led.files,
      ledgerBadLines: led.badLines,
    },
    stats: { scope: scopeLabel, covered, checked, equal, bytesCompared, renderFailed },
    elapsedMs: Date.now() - t0,
  };
}

// ============================================================================
// 5.6 `--views`：C10 —— 每份「完整原文.md」的正文 hash 可**独立**复算
// ============================================================================

/** C10 正文锚点（契约=行首 `## 1.` 到文件末尾，含该标题）。 */
const VIEW_BODY_ANCHOR = '## 1.';

/**
 * C10 独立正文抽取 —— **不调用** lib/original.js 的 `originalBodyOf`/`originalBodyHash`/
 * `verifyOriginal`（避免"用同一实现证明自己"）。
 *
 * 契约与写端一致（lib/original.js L694-L717 的注释与实现）：
 *   正文 = 从**行首** `## 1.` 起算到文件末尾，含该标题行、含末尾换行；
 * 实现故意换成"按 \n 切行 → 找首个锚点行 → 拼回"，与写端的 `indexOf('\n## 1.')+slice`
 * 不是同一段代码，但结果对同一份文件逐字节等价。
 *
 * @returns {string} 正文；找不到锚点 → ''（调用方按红处理）
 */
function independentBodyOf(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(VIEW_BODY_ANCHOR)) return lines.slice(i).join('\n');
  }
  return '';
}

/**
 * C10 独立 YAML 前置块解析（只取单行标量；不 import `originalFrontMatter`）。
 * 产物格式固定为 `键: 值`（值单引号、`''` 转义），注释行以 `#` 开头（C11 头三行）。
 * @returns {Map<string,string>|null} 不是 `---` 开头/没有结束分隔线 → null
 */
function independentFrontMatterOf(markdown) {
  if (typeof markdown !== 'string') return null;
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null;
  const fields = new Map();
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1).replace(/''/g, "'");
    } else if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    fields.set(key, val);
  }
  return fields;
}

/** 递归收集 root 下全部 `* 完整原文.md`（跳过 `.tmp-` 原子写残留；顺序确定，便于复现）。 */
function collectViewFiles(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (e.name.startsWith('.tmp-')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectViewFiles(full, out);
    else if (e.isFile() && e.name.endsWith(' 完整原文.md')) out.push(full);
  }
}

/**
 * C10：遍历 root 下所有 `* 完整原文.md`，用本文件**独立实现**复算正文 hash，
 * 与 YAML `正文hash` 比对。全部一致 → exit 0；任一不符/不可复算 → exit 1。
 *
 * 独立性：本模式**不加载/不 import 任何 lib**（连 lib 都不读），复算逻辑与解析逻辑都在本文件；
 * 因此不存在"调用 original.verifyOriginal 用同一实现证明自己"的问题。
 */
async function verifyViews(opt) {
  const t0 = Date.now();
  const mismatches = [];
  const notes = [];
  const files = [];
  collectViewFiles(opt.root, files);
  if (files.length === 0) {
    return {
      fatality: 'root 下没有找到任何 * 完整原文.md: ' + opt.root + '（--root 是否指错？空集不能证明 C10 成立）',
    };
  }
  const limit = Number.isInteger(opt.viewsLimit) && opt.viewsLimit > 0 ? opt.viewsLimit : 0;
  const targets = limit > 0 ? files.slice(0, limit) : files;
  if (limit > 0 && files.length > targets.length) {
    notes.push({
      kind: 'VIEWS_LIMIT_APPLIED',
      detail: '--views-limit=' + limit + '：只检查前 ' + targets.length + '/' + files.length +
        ' 份（调试用；此结果不能当 C10 全量证据）',
    });
  }

  let checked = 0;
  let bad = 0;
  let bodyBytes = 0;

  for (const abs of targets) {
    const rel = path.relative(opt.root, abs);
    let raw;
    try {
      raw = fs.readFileSync(abs);
    } catch (e) {
      bad++;
      addMismatch(mismatches, {
        code: '', kind: 'VIEW_UNREADABLE', field: 'file', expected: rel,
        actual: '读取失败: ' + (e && e.code ? e.code : String(e)),
      });
      continue;
    }
    const text = raw.toString('utf8');
    const fallbackCode = path.basename(abs).replace(/ 完整原文\.md$/, '');
    const fm = independentFrontMatterOf(text);
    if (!fm) {
      // 没有 YAML 前置块 → 连"正文hash 字段"都没有，无法做 C10
      bad++;
      addMismatch(mismatches, {
        code: fallbackCode, kind: 'VIEW_YAML_MISSING', field: '正文hash',
        expected: rel + ' 的 `---` YAML 前置块', actual: '(找不到完整 YAML 前置块)',
        note: 'C10：正文hash 必须在 YAML 里，且可独立复算',
      });
      continue;
    }
    const code = String(fm.get('编码') || fallbackCode);
    const yamlHash = String(fm.get('正文hash') || '');
    const body = independentBodyOf(text);
    if (!body) {
      bad++;
      addMismatch(mismatches, {
        code, kind: 'VIEW_NO_BODY_ANCHOR', field: '正文hash',
        expected: rel + ' 正文从行首 ' + VIEW_BODY_ANCHOR,
        actual: '(找不到正文锚点，无法独立复算)',
      });
      continue;
    }
    const actualHash = sha256Hex(body);
    checked++;
    bodyBytes += Buffer.byteLength(body, 'utf8');
    if (!/^[0-9a-f]{64}$/.test(yamlHash)) {
      bad++;
      addMismatch(mismatches, {
        code, kind: 'VIEW_HASH_FIELD_MISSING_OR_BAD', field: '正文hash',
        expected: '64 位小写 sha256（YAML 正文hash）',
        actual: yamlHash ? short(yamlHash, 96) : '(YAML 无 正文hash 字段)',
      });
    } else if (yamlHash !== actualHash) {
      bad++;
      addMismatch(mismatches, {
        code, kind: 'VIEW_BODY_HASH_MISMATCH', field: '正文hash',
        expected: yamlHash, actual: actualHash,
        note: '独立复算（' + rel + '）：正文=行首 ' + VIEW_BODY_ANCHOR + '→EOF（含末尾换行）',
      });
    }
    if (!Buffer.from(text, 'utf8').equals(raw)) {
      notes.push({ kind: 'VIEW_NOT_VALID_UTF8', detail: rel + '（磁盘字节不是合法 UTF-8，按 utf8 重编码后比对）' });
    }
  }

  const ok = mismatches.length === 0;
  return {
    ok,
    exitCode: ok ? EXIT.GREEN : EXIT.RED,
    mode: 'views',
    root: opt.root,
    mismatches,
    notes,
    counts: {
      filesFound: files.length,
      filesChecked: checked,
      filesBad: bad,
      truncated: targets.length < files.length,
      limit,
      bodyBytes,
    },
    stats: {
      filesFound: files.length,
      checked,
      bad,
      bodyBytes,
      independentImplementation: true,
    },
    elapsedMs: Date.now() - t0,
  };
}

// ============================================================================
// 6. 自检：克隆副本 + 变异/破坏 + "必须红"断言
// ============================================================================

/**
 * 克隆"核验所需的最小账库"到临时目录：
 *   · `ledger/*.jsonl` **复制**（要改行，不能共享字节）；
 *   · 每行的原文 .md 与原始事件附件 **硬链接**（同卷 O(1)；跨卷退回复制）；
 *     `delete-attachment`/`flip-attachment-byte` 在副本侧 unlink/重写，原账库字节不动。
 * 返回克隆根 + 原文件见证清单（用于"原账库未被改动"的前后 sha256 对比）+ cleanup。
 */
function cloneAccountLibrary(root, rows) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-replay-verify-'));
  const cloned = { root: tmp, sourceFiles: [], cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } } };

  const ledDir = path.join(root, 'ledger');
  ensureDir(path.join(tmp, 'ledger'));
  for (const name of fs.readdirSync(ledDir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort()) {
    const src = path.join(ledDir, name);
    const dst = path.join(tmp, 'ledger', name);
    fs.copyFileSync(src, dst);
    cloned.sourceFiles.push(src);
  }

  const want = new Map(); // 克隆内相对路径 → 原绝对路径
  const addRel = (abs) => {
    if (typeof abs !== 'string' || !abs) return;
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (!want.has(rel)) want.set(rel, abs);
  };
  for (const row of rows) {
    if (typeof row.doc === 'string' && row.doc) {
      addRel(path.join(root, row.doc));
      // 期望路径（编码日期段）也带上：改 code 的变异要靠它找到原文/附件
      const p = parseCodeSafe(row.code);
      if (p) addRel(path.join(root, originalRelPathSafe(p.date, p.code)));
    }
    if (row.attachment && typeof row.attachment === 'object') {
      if (typeof row.attachment.name === 'string' && row.attachment.name) {
        if (typeof row.doc === 'string' && row.doc) addRel(path.join(path.dirname(path.join(root, row.doc)), row.attachment.name));
      }
      if (typeof row.attachment.path === 'string' && row.attachment.path) addRel(path.join(root, row.attachment.path));
    }
  }
  for (const [rel, abs] of want) {
    try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
    const mode = linkOrCopy(abs, path.join(tmp, rel));
    if (mode === 'link') {
      // 硬链接也算"原账库见证文件"：self-check 期间必须一个字节都不变
      cloned.sourceFiles.push(abs);
    }
  }
  return cloned;
}

/** 期望原文相对路径（与 ingest 同口径：按编码日期段取月）。 */
function originalRelPathSafe(dateSeg, code) {
  const y = Number(String(dateSeg).slice(0, 4));
  const m = Number(String(dateSeg).slice(4, 6));
  const mm = String(m).padStart(2, '0');
  return path.join(`${y}年${mm}月`, `${mm}月总“完整原文”`, `${code} 完整原文.md`);
}

function parseCodeSafe(code) {
  const m = /^(\d{8})-([0-9a-z]{12})-([A-Z])-(\d{8})$/.exec(String(code || ''));
  if (!m) return null;
  return { date: m[1], s12: m[2], gen: m[3], seq: Number(m[4]) };
}

/** 在（克隆）账库里定位某 code 所在文件与行号。 */
function findRowLocation(root, code) {
  const dir = path.join(root, 'ledger');
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    const lines = readJsonlLines(text);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o && o.code === code) return { file, lineNo: i + 1, lines };
    }
  }
  return null;
}

/** 找到某行附件在（克隆）账库里的实际文件（多候选，兼容旧行）。 */
function resolveAttachmentCandidates(root, row) {
  const docRel = typeof row.doc === 'string' && row.doc
    ? row.doc
    : (() => { const p = parseCodeSafe(row.code); return p ? originalRelPathSafe(p.date, row.code) : ''; })();
  const docDir = docRel ? path.dirname(path.join(root, docRel)) : path.join(root);
  const out = [];
  const att = row.attachment && typeof row.attachment === 'object' ? row.attachment : {};
  if (typeof att.name === 'string' && att.name) out.push(path.join(docDir, att.name));
  const p = parseCodeSafe(row.code);
  if (p) out.push(path.join(docDir, `${row.code} 原始事件.json`));
  if (typeof att.path === 'string' && att.path) out.push(path.join(root, att.path));
  return [...new Set(out)];
}

/** 变异：改 1 行 1 个字段（C15）。返回 {label, before, after}。 */
function applyMutation(root, row, kind) {
  const loc = findRowLocation(root, row.code);
  if (!loc) throw new Error('mutate: 克隆副本里定位不到 code=' + row.code);
  const obj = JSON.parse(loc.lines[loc.lineNo - 1]);
  const before = {};
  const after = {};
  const setField = (name, value) => {
    before[name] = obj[name];
    obj[name] = value;
    after[name] = value;
  };
  switch (kind) {
    case 'turn': setField('turn', Number(obj.turn) + 1000); break;
    case 'ts': setField('ts', shiftIso(obj.ts, 3600000)); break;
    case 'seq': setField('seq', Number(obj.seq) + 1); break;
    case 'sid': setField('sid', String(obj.sid) + '-mutated'); break;
    case 'status': setField('status', obj.status === 'ok' ? 'partial' : 'ok'); break;
    case 'doc': {
      const cur = String(obj.doc || '');
      const next = cur.endsWith('完整原文.md')
        ? cur.slice(0, -'完整原文.md'.length) + '完整原文-改.md'
        : (cur || expDocOf(obj.code)) + '.mutated';
      setField('doc', next);
      break;
    }
    case 'attachment': {
      const att = obj.attachment && typeof obj.attachment === 'object' ? { ...obj.attachment } : {};
      att.name = typeof att.name === 'string' && att.name ? att.name : `${obj.code} 原始事件.json`;
      att.sha256 = typeof att.sha256 === 'string' && att.sha256
        ? (att.sha256[0] === '0' ? '1' : '0') + att.sha256.slice(1)
        : '0'.repeat(64);
      before.attachment = obj.attachment;
      obj.attachment = att;
      after.attachment = att;
      break;
    }
    case 'code': {
      const p = parseCodeSafe(obj.code);
      if (!p) throw new Error('mutate=code: 原 code 不合法: ' + obj.code);
      setField('code', `${p.date}-${p.s12}-${p.gen}-${String(p.seq + 1).padStart(8, '0')}`);
      break;
    }
    default: throw new Error('未知 mutate kind: ' + kind);
  }
  loc.lines[loc.lineNo - 1] = JSON.stringify(obj);
  fs.writeFileSync(loc.file, loc.lines.join('\n'), 'utf8');
  return { label: 'code=' + row.code + ' 行#' + loc.lineNo + ' ' + kind, before, after, file: loc.file };
}

/** ISO 时间串平移（保持 +08:00 风格；解析失败则原样返回，反正变异后会红）。 */
function shiftIso(ts, deltaMs) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return String(ts) + 'Z';
  const d = new Date(ms + deltaMs + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}

function expDocOf(code) {
  const p = parseCodeSafe(code);
  return p ? originalRelPathSafe(p.date, code) : '';
}

/** 破坏账库（C16）。返回 {label, target}；target 里带"期望被抓住"的信息。 */
function applyDestroy(root, row, kind) {
  switch (kind) {
    case 'delete-row': {
      const loc = findRowLocation(root, row.code);
      if (!loc) throw new Error('destroy=delete-row: 定位不到 code=' + row.code);
      loc.lines.splice(loc.lineNo - 1, 1);
      fs.writeFileSync(loc.file, loc.lines.join('\n'), 'utf8');
      return { label: '删除整行 code=' + row.code + '（行#' + loc.lineNo + '）', file: loc.file };
    }
    case 'extra-row': {
      // 伪造一行：形状合法（isLedgerRow 会认），但原文里查无此轮 → 只能被抓成 EXTRA_ROW
      const forged = {
        v: 3,
        code: '19700101-000000000000-Z-99999999',
        ts: '1970-01-01T08:00:00+08:00',
        sid: 'session-forged-00000000-0000-0000-0000-000000000000',
        turn: 999999,
        seq: 99999999,
        status: 'ok',
        turnState: 'closed',
        src: 'session.v4.jsonl.zstd',
        doc: expDocOf('19700101-000000000000-Z-99999999'),
        attachment: null,
        docFrom: 0,
        dateOffset: 480,
      };
      const file = path.join(root, 'ledger', '1970-01-01.jsonl');
      fs.writeFileSync(file, JSON.stringify(forged) + '\n', 'utf8');
      return { label: '追加伪造行 code=' + forged.code + '（原文查无此轮）', forgedCode: forged.code, file };
    }
    case 'delete-attachment': {
      const cands = resolveAttachmentCandidates(root, row);
      let hit = '';
      for (const c of cands) { try { if (fs.statSync(c).isFile()) { hit = c; break; } } catch { /* next */ } }
      if (!hit) throw new Error('destroy=delete-attachment: 找不到该行附件文件（code=' + row.code + '）');
      fs.rmSync(hit, { force: true });
      return { label: '删除附件 ' + path.basename(hit) + '（code=' + row.code + '）', file: hit };
    }
    case 'flip-attachment-byte': {
      const cands = resolveAttachmentCandidates(root, row);
      let hit = '';
      for (const c of cands) { try { if (fs.statSync(c).isFile()) { hit = c; break; } } catch { /* next */ } }
      if (!hit) throw new Error('destroy=flip-attachment-byte: 找不到该行附件文件（code=' + row.code + '）');
      const buf = fs.readFileSync(hit);
      if (buf.length === 0) throw new Error('destroy=flip-attachment-byte: 附件是空文件，无法改一字节');
      const i = Math.floor(buf.length / 2);
      buf[i] = buf[i] ^ 0xff;
      // ★ 必须 unlink 后重写：克隆里可能是硬链接，就地写会改到原账库
      fs.rmSync(hit, { force: true });
      fs.writeFileSync(hit, buf);
      return { label: '改附件 1 字节 @' + i + '（' + path.basename(hit) + '，code=' + row.code + '）', file: hit };
    }
    default:
      throw new Error('未知 destroy kind: ' + kind);
  }
}

/** 自检目标选择：返回 {exp, row}（都要在基线里配对成功）。 */
function pickSelfCheckTarget(base, kind) {
  const pairs = (base.detail.pairs || []).filter((p) => p.exp && p.row);
  const needAttachmentFile = kind === 'attachment' || kind === 'delete-attachment' || kind === 'flip-attachment-byte';
  for (const p of pairs) {
    if (!needAttachmentFile) return p;
    if (!p.row.attachment || typeof p.row.attachment !== 'object') continue;
    const cands = resolveAttachmentCandidates(base.root, p.row);
    for (const c of cands) {
      try { if (fs.statSync(c).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/** 自检期望：变异后必须出现"哪条不符"（按 code + field/kind 精确匹配，防"红错了地方"）。 */
function selfCheckExpectation(mode, kind, target, destroyInfo) {
  if (mode === 'mutate') {
    const field = kind; // mutate 的 kind 就是字段名
    return {
      kind: 'FIELD_MISMATCH',
      field,
      code: target.exp.code,
      match: (m) => m.code === target.exp.code &&
        (m.field === field || (field === 'attachment' && String(m.field).startsWith('attachment'))),
    };
  }
  if (kind === 'delete-row') {
    return { kind: 'MISSING_ROW', field: '', code: target.exp.code, match: (m) => m.kind === 'MISSING_ROW' && m.code === target.exp.code };
  }
  if (kind === 'extra-row') {
    const code = destroyInfo.forgedCode;
    return { kind: 'EXTRA_ROW', field: '', code, match: (m) => m.kind === 'EXTRA_ROW' && m.code === code };
  }
  if (kind === 'delete-attachment') {
    return { kind: 'ATTACHMENT_MISSING', field: 'attachment.name', code: target.exp.code, match: (m) => m.kind === 'ATTACHMENT_MISSING' && m.code === target.exp.code };
  }
  // flip-attachment-byte
  return {
    kind: 'ATTACHMENT_HASH_MISMATCH', field: 'attachment.sha256', code: target.exp.code,
    match: (m) => m.kind === 'ATTACHMENT_HASH_MISMATCH' && m.code === target.exp.code,
  };
}

/** 见证文件 sha256 快照（自检后必须逐文件相等）。 */
function witnessHashes(files) {
  const out = new Map();
  for (const f of [...new Set(files)]) {
    try { out.set(f, sha256Hex(fs.readFileSync(f))); } catch { out.set(f, '(缺失)'); }
  }
  return out;
}

/**
 * 跑一次自检。返回 {exitCode, result}：
 *   exit 1 = 如期变红（自检成立）；
 *   exit 3 = 基线不绿 / 克隆不绿 / 变异未被抓住 / 找不到目标 / 动到了原账库。
 */
async function runSelfCheck(opt, libs) {
  const t0 = Date.now();
  const mode = opt.mutate ? 'mutate' : 'destroy';
  const kind = opt.mutate || opt.destroy;
  const report = {
    schema: 'v091-replay-verify/1',
    ok: false,
    exitCode: EXIT.SELFCHECK_BROKEN,
    mode: 'self-check',
    selfCheck: { mode, kind, baselineOk: false, cloneBaselineOk: false, caught: false, expected: null, originalUntouched: null },
    mismatches: [],
    notes: [],
    elapsedMs: 0,
  };

  const led0 = readLedger(opt.root, libs.ledgerMod);
  if (!led0.dirExists) { report.error = 'root/ledger 不存在: ' + path.join(opt.root, 'ledger'); report.exitCode = EXIT.USAGE; return report; }

  let clone = null;
  try {
    clone = cloneAccountLibrary(opt.root, led0.rows);
    const witness = witnessHashes(clone.sourceFiles);

    // ① 克隆副本基线必须绿：不绿就说明"克隆/环境"本身有问题，自检不成立
    const cloneBase = await verifyOnce({
      root: clone.root, sessionsBase: opt.sessionsBase, mode: 'fields',
      includeV3: opt.includeV3, defaultOffset: opt.defaultOffset,
    }, libs);
    report.selfCheck.cloneBaselineOk = cloneBase.ok === true;
    report.selfCheck.baselineOk = cloneBase.ok === true; // 克隆与原件同构，基线以克隆为准
    if (cloneBase.fatality) {
      report.exitCode = EXIT.USAGE;
      report.error = cloneBase.fatality;
      report.selfCheck.reason = 'environment';
      report.selfCheck.message = cloneBase.fatality;
      report.elapsedMs = Date.now() - t0;
      return report;
    }
    if (!cloneBase.ok) {
      report.selfCheck.reason = 'baseline-not-green';
      report.selfCheck.message = '基线（克隆副本）不绿，无法做变异/破坏自检：先让账库全绿再自检';
      report.selfCheck.baselineMismatches = cloneBase.mismatches.slice(0, 20);
      report.elapsedMs = Date.now() - t0;
      return report;
    }

    // ② 选目标 + 注入
    const target = pickSelfCheckTarget(cloneBase, kind);
    if (!target) {
      report.selfCheck.reason = 'no-target';
      report.selfCheck.message = mode === 'mutate'
        ? '找不到可注入该字段的行（例如账库里没有带附件的行）'
        : '找不到可破坏的目标行/附件';
      report.elapsedMs = Date.now() - t0;
      return report;
    }
    report.selfCheck.target = { code: target.exp.code, sid: target.exp.sid, turn: target.exp.turn };

    let destroyInfo = null;
    if (mode === 'mutate') {
      const info = applyMutation(clone.root, target.row, kind);
      report.selfCheck.mutation = { kind, label: info.label, before: info.before, after: info.after };
    } else {
      destroyInfo = applyDestroy(clone.root, target.row, kind);
      report.selfCheck.destroy = { kind, label: destroyInfo.label };
    }

    // ③ 变异后必须红，且必须是"预期那条红"（按 code + field/kind 精确匹配）
    const after = await verifyOnce({
      root: clone.root, sessionsBase: opt.sessionsBase, mode: 'fields',
      includeV3: opt.includeV3, defaultOffset: opt.defaultOffset,
    }, libs);
    const expect = selfCheckExpectation(mode, kind, target, destroyInfo);
    const found = (after.mismatches || []).find((m) => expect.match(m)) || null;
    report.selfCheck.expected = { kind: expect.kind, field: expect.field, code: expect.code };
    report.selfCheck.caught = !!found;
    report.selfCheck.found = found;
    report.selfCheck.mismatchesAfter = after.mismatches.length;
    report.selfCheck.mismatchesInBaseline = 0;

    // ④ 原账库必须一个字节都没动（硬链接被就地写就会在这里暴露）
    const witnessAfter = witnessHashes(clone.sourceFiles);
    const touched = [];
    for (const [f, h] of witness) if (witnessAfter.get(f) !== h) touched.push(f);
    report.selfCheck.originalUntouched = touched.length === 0;
    report.selfCheck.witnessFiles = witness.size;
    if (touched.length > 0) {
      report.selfCheck.reason = 'original-touched';
      report.selfCheck.message = '自检改动到了原账库（绝不允许）：' + touched.slice(0, 5).join(' | ');
      report.elapsedMs = Date.now() - t0;
      return report;
    }

    const ok = report.selfCheck.caught && report.selfCheck.originalUntouched;
    report.exitCode = ok ? EXIT.RED : EXIT.SELFCHECK_BROKEN;
    report.ok = after.ok; // 顶层 ok = 变异后那次核验的结论（这里必定 false）
    report.mismatches = after.mismatches;
    report.ledgerRows = after.ledgerRows;
    report.replayedTurns = after.replayedTurns;
    report.compared = after.compared;
    report.skipped = after.skipped;
    report.counts = after.counts || {};
    report.notes = after.notes;
    report.selfCheck.baseline = {
      ledgerRows: cloneBase.ledgerRows,
      replayedTurns: cloneBase.replayedTurns,
      compared: cloneBase.compared,
      mismatches: cloneBase.mismatches.length,
    };
    if (!report.selfCheck.caught) {
      report.selfCheck.reason = 'not-caught';
      report.selfCheck.message = '校验器失效：变异后没有被抓住（' + expect.kind + ' ' + expect.field + '）';
    }
    report.elapsedMs = Date.now() - t0;
    return report;
  } finally {
    if (clone) clone.cleanup();
  }
}

// ============================================================================
// 7. 报告
// ============================================================================

/** C09 人读摘要。 */
function printOriginalsHuman(result, opt) {
  const L = [];
  const c = result.counts || {};
  L.push('C09 原始事件附件逐字节复核（离线只读，不进 tick）· --originals');
  L.push('  root     = ' + opt.root);
  L.push('  sessions = ' + opt.sessions);
  L.push('');
  L.push('【源】 会话源=' + (c.replayedSessions || 0) + ' ｜ 已闭合轮=' + result.replayedTurns +
    ' ｜ 不可解析=' + ((result.skipped && result.skipped.unparsable) || 0));
  L.push('【账】 行=' + result.ledgerRows + ' ｜ 配对=' + (c.pairs || 0) +
    ' ｜ 缺行=' + (c.missingRows || 0) + ' ｜ 多行=' + (c.extraRows || 0));
  L.push('【比】 范围=' + (c.scope === 'all' ? '全部重放轮（--all）' : '台账里有的行（默认）') +
    ' ｜ 覆盖=' + (c.covered || 0) + ' 份 ｜ 已比=' + (c.checked || 0) +
    ' ｜ 逐字节相等=' + (c.equal || 0) + ' ｜ 不符=' + result.mismatches.length);
  L.push('         （比较口径：长度 + sha256 + Buffer.equals；逐字节，不抽样）');
  L.push('【时】 ' + result.elapsedMs + ' ms');
  if (result.mismatches.length > 0) {
    L.push('');
    L.push('【明细】（最多 ' + opt.maxDetail + ' 条，共 ' + result.mismatches.length + ' 条）');
    result.mismatches.slice(0, opt.maxDetail).forEach((m, i) => {
      L.push('  ' + (i + 1) + '. ' + m.kind + (m.field ? ' 字段=' + m.field : '') +
        (m.code ? '  code=' + m.code : ''));
      L.push('     期望=' + short(m.expected));
      L.push('     实际=' + short(m.actual));
      if (m.note) L.push('     说明=' + short(m.note, 240));
    });
    if (result.mismatches.length > opt.maxDetail) {
      L.push('  …还有 ' + (result.mismatches.length - opt.maxDetail) + ' 条（加大 --maxDetail 可看全）');
    }
  }
  const notes = (result.notes || []).filter((n) => n.kind !== 'V3_PREFIX_USED');
  if (notes.length) {
    L.push('');
    for (const n of notes.slice(0, 8)) L.push('注：' + n.kind + ' :: ' + short(n.detail, 220));
    if (notes.length > 8) L.push('注：…还有 ' + (notes.length - 8) + ' 条');
  }
  L.push('');
  L.push(result.ok
    ? '结论：全绿 —— 每份「原始事件.json」与源会话重放序列化逐字节相等（C09）。'
    : '结论：存在不通过项（见上）。exit=1。');
  console.log(L.join('\n'));
}

/** C10 人读摘要。 */
function printViewsHuman(result, opt) {
  const L = [];
  const c = result.counts || {};
  L.push('C10 视图正文 hash 独立复算（离线只读，不进 tick）· --views');
  L.push('  root = ' + opt.root);
  L.push('');
  L.push('【扫】 * 完整原文.md=' + (c.filesFound || 0) + ' 份 ｜ 已查=' + (c.filesChecked || 0) +
    ' ｜ 有红=' + (c.filesBad || 0) + ' ｜ 不符=' + result.mismatches.length +
    ' ｜ 正文字节=' + (c.bodyBytes || 0));
  L.push('【实现】 正文=行首 `## 1.`→EOF（含末尾换行）→ sha256(UTF-8)；' +
    '复算=本文件独立实现（未调用 original.verifyOriginal / originalBodyHash）');
  L.push('【时】 ' + result.elapsedMs + ' ms');
  if (result.mismatches.length > 0) {
    L.push('');
    L.push('【明细】（最多 ' + opt.maxDetail + ' 条，共 ' + result.mismatches.length + ' 条）');
    result.mismatches.slice(0, opt.maxDetail).forEach((m, i) => {
      L.push('  ' + (i + 1) + '. ' + m.kind + (m.field ? ' 字段=' + m.field : '') +
        (m.code ? '  code=' + m.code : ''));
      L.push('     期望=' + short(m.expected));
      L.push('     实际=' + short(m.actual));
      if (m.note) L.push('     说明=' + short(m.note, 240));
    });
    if (result.mismatches.length > opt.maxDetail) {
      L.push('  …还有 ' + (result.mismatches.length - opt.maxDetail) + ' 条（加大 --maxDetail 可看全）');
    }
  }
  if ((result.notes || []).length) {
    L.push('');
    for (const n of result.notes.slice(0, 8)) L.push('注：' + n.kind + ' :: ' + short(n.detail, 220));
    if (result.notes.length > 8) L.push('注：…还有 ' + (result.notes.length - 8) + ' 条');
  }
  L.push('');
  L.push(result.ok
    ? '结论：全绿 —— 每份「完整原文.md」的 YAML 正文hash 均可独立复算一致（C10）。'
    : '结论：存在不通过项（见上）。exit=1。');
  console.log(L.join('\n'));
}

function printHuman(result, opt) {
  const L = [];
  const maxDetail = opt.maxDetail;
  const isSelf = result.mode === 'self-check';
  L.push('重放核验（离线只读，不进 tick）· C14–C16 · ' + (isSelf ? '自检模式' : '模式=' + result.mode));
  L.push('  root     = ' + opt.root);
  L.push('  sessions = ' + opt.sessions);
  L.push('');

  if (isSelf) {
    const sc = result.selfCheck || {};
    L.push('自检：--' + sc.mode + '=' + sc.kind);
    L.push('【基线】 克隆副本：' + (sc.baselineOk ? '全绿（' +
      (sc.baseline ? sc.baseline.compared + '/' + sc.baseline.replayedTurns + ' 配对，0 不符' : '0 不符') + '）'
      : '不绿 —— 自检不成立'));
    const label = (sc.mutation && sc.mutation.label) || (sc.destroy && sc.destroy.label) || '(无)';
    L.push('【注入】 ' + label);
    if (sc.mutation && sc.mutation.before !== undefined) {
      L.push('         ' + Object.keys(sc.mutation.before).map((k) =>
        k + ': ' + short(sc.mutation.before[k], 120) + ' → ' + short(sc.mutation.after[k], 120)).join('；'));
    }
    if (!sc.baselineOk) {
      L.push('【结果】 ⛔ 自检无法成立：基线（克隆副本）不绿');
      L.push('         原因：' + (sc.message || 'baseline-not-green'));
      const bm = sc.baselineMismatches || [];
      for (const m of bm.slice(0, 5)) {
        L.push('         基线红点: ' + m.kind + (m.field ? ' ' + m.field : '') + (m.code ? ' code=' + m.code : ''));
      }
      if (bm.length > 5) L.push('         …还有 ' + (bm.length - 5) + ' 条');
      L.push('结论：exit=3 —— 自检未完成（先修账库/环境再自检），绝不是通过。');
    } else if (sc.caught) {
      L.push('【结果】 ✅ 如期变红：' + sc.found.kind + ' ' + (sc.found.field || '(行级)') +
        '（code=' + (sc.found.code || '-') + '）');
      L.push('         期望=' + short(sc.found.expected, 160));
      L.push('         实际=' + short(sc.found.actual, 160));
      L.push('【隔离】 原账库未被改动：' + (sc.originalUntouched ? '✓（' + sc.witnessFiles + ' 个见证文件 sha256 前后一致）' : '✗'));
      L.push('结论：校验器有效 —— 注入必红（' + (sc.mode === 'mutate' ? 'C15' : 'C16') + '）。exit=1（预期红）');
    } else {
      L.push('【结果】 ❌ 校验器失效：变异/破坏后未如期变红');
      L.push('         期望抓到: ' + JSON.stringify(sc.expected));
      L.push('         变异后不符总数: ' + (sc.mismatchesAfter === undefined ? '?' : sc.mismatchesAfter));
      L.push('结论：exit=3 —— 自检没有如期变红，先查校验器/环境，不许把这次当通过。' + (sc.message ? '（' + sc.message + '）' : ''));
    }
    L.push('【时】 ' + result.elapsedMs + ' ms');
    console.log(L.join('\n'));
    return;
  }

  const c = result.counts || {};
  L.push('【源】 会话源 ' + (c.replayedSessions || 0) +
    ' 个（v4=' + (c.v4Sources || 0) + ' ｜ v3 只读=' + (c.v3Sources || 0) + '）' +
    ' ｜ 已闭合轮=' + result.replayedTurns +
    ' ｜ 不可解析=' + result.skipped.unparsable +
    ' ｜ v3 不参与比对=' + result.skipped.v3 +
    (c.v3PrefixSessions ? ' ｜ v3 补前缀会话=' + c.v3PrefixSessions : ''));
  L.push('【账】 行=' + result.ledgerRows + ' ｜ 文件=' + (c.ledgerFiles || 0) +
    ' ｜ 坏行=' + (c.ledgerBadLines || 0) +
    ' ｜ code 唯一 ' + (c.codeUnique ? '✓' : '✗') +
    ' ｜ (sid,turn) 唯一 ' + (c.sidTurnUnique ? '✓' : '✗'));
  if (result.mode === 'count') {
    const dev = result.ledgerRows - result.replayedTurns;
    L.push('【比】 源闭合轮=' + result.replayedTurns + ' ｜ 台账行数=' + result.ledgerRows +
      ' ｜ 偏差=' + (dev === 0 ? '0' : (dev > 0 ? '+' : '') + dev) +
      ' ｜ 计数一致 ' + (dev === 0 ? '✓' : '✗'));
    L.push('         （--count 只比四数/唯一性/坏行，不逐字段、不读附件；C14 请用 --fields）');
  } else {
    L.push('【比】 配对=' + result.compared + '/' + result.replayedTurns +
      ' ｜ 不符=' + result.mismatches.length +
      ' ｜ 缺行=' + (c.missing || 0) + ' ｜ 多行=' + (c.extra || 0));
  }
  L.push('【时】 ' + result.elapsedMs + ' ms');

  if (result.mismatches.length > 0) {
    L.push('');
    L.push('【明细】（最多 ' + maxDetail + ' 条，共 ' + result.mismatches.length + ' 条）');
    result.mismatches.slice(0, maxDetail).forEach((m, i) => {
      const code = m.code ? '  code=' + m.code : '';
      L.push('  ' + (i + 1) + '. ' + m.kind + (m.field ? ' 字段=' + m.field : '') + code);
      L.push('     期望=' + short(m.expected));
      L.push('     实际=' + short(m.actual));
      if (m.note) L.push('     说明=' + short(m.note, 200));
    });
    if (result.mismatches.length > maxDetail) L.push('  …还有 ' + (result.mismatches.length - maxDetail) + ' 条');
  }

  const footer = [];
  const sk = result.skipped || { v3: 0, unparsable: 0 };
  if (sk.v3 > 0) {
    const v3notes = (result.notes || []).filter((n) => n.kind === 'V3_NOT_COMPARED' || n.kind === 'V3_EXCLUDED' || n.kind === 'V3_PREFIX_USED');
    footer.push('v3 只读源（显式标注）：' + sk.v3 + ' 个文件不参与比对' +
      (sk.v3Rows ? '；台账 v3 行 ' + sk.v3Rows + ' 行同步排除（--v3=skip）' : ''));
    for (const n of v3notes.slice(0, 5)) footer.push('  · ' + n.kind + ': ' + short(n.detail, 200));
    if (v3notes.length > 5) footer.push('  · …还有 ' + (v3notes.length - 5) + ' 条');
  }
  const otherNotes = (result.notes || []).filter((n) => !String(n.kind).startsWith('V3'));
  for (const n of otherNotes.slice(0, 8)) footer.push('注：' + n.kind + ' :: ' + short(n.detail, 220));
  if (otherNotes.length > 8) footer.push('注：…还有 ' + (otherNotes.length - 8) + ' 条');
  if (sk.unparsable > 0) {
    footer.push('注意：有 ' + sk.unparsable + ' 个源不可解析/被守卫拒绝，其轮次未计入"应有轮"；' +
      '若账里曾有它们的行，会以 EXTRA_ROW 报红（不静默吞掉）。');
  }
  if (footer.length) { L.push(''); L.push(...footer); }
  L.push('');
  L.push(result.ok
    ? (result.mode === 'count'
      ? '结论：全绿 —— 源闭合轮数与台账行数一致、无坏行、无重复。'
      : '结论：全绿 —— 台账与原文重放逐字段一致（C14），附件与原文文件均通过复核；C15/C16 未见红。')
    : '结论：存在不通过项（见上）。exit=1。');
  L.push('边界：seq/gen 按全量重放分配（要求 --sessions 是该账库的全集来源）；v3 只读、未修改；本工具不写账库。');
  console.log(L.join('\n'));
}

// ============================================================================
// 8. main
// ============================================================================

async function main() {
  if (RAW.help) { console.log(USAGE); process.exitCode = EXIT.GREEN; return; }
  // 未知参数一律报错：静默忽略会让"参数写错"变成"跑了个别的模式"（假绿来源）
  const KNOWN_FLAGS = new Set(['--root', '--sessions', '--json', '--count', '--fields',
    '--mutate', '--destroy', '--v3', '--offset-minutes', '--maxDetail', '--max-detail', '--help', '-h',
    '--originals', '--views', '--all', '--views-limit']);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a.split('=')[0]));
  if (unknown.length > 0) return usageExit('未知参数: ' + unknown.join(' '));

  const wantOriginals = RAW.originals;
  const wantViews = RAW.views;
  if (wantOriginals && wantViews) return usageExit('--originals 与 --views 只能选一个');
  if ((wantOriginals || wantViews) && (RAW.count || RAW.fields || RAW.mutate || RAW.destroy)) {
    return usageExit('--originals/--views 不能与 --count/--fields/--mutate/--destroy 组合');
  }
  if (RAW.all && !wantOriginals) return usageExit('--all 只用于 --originals（--views 默认全量）');
  let viewsLimit = 0;
  if (RAW.viewsLimitRaw !== '') {
    if (!wantViews) return usageExit('--views-limit 只用于 --views');
    if (typeof RAW.viewsLimitRaw !== 'string' || !Number.isInteger(Number(RAW.viewsLimitRaw)) || Number(RAW.viewsLimitRaw) < 1) {
      return usageExit('--views-limit=N 必须是正整数（N>=1；不写则全量）');
    }
    viewsLimit = Number(RAW.viewsLimitRaw);
  }
  if (!RAW.root) return usageExit('必须给 --root=<账库根>');
  // --views 是纯磁盘侧复核（root 下所有 完整原文.md），不需要 --sessions，也不需要 ledger/
  if (!wantViews && !RAW.sessions) return usageExit('--sessions=<sessions 目录> 是必须的（--views 除外）');

  if (RAW.count && RAW.fields) return usageExit('--count 与 --fields 只能选一个');
  const mutateKind = RAW.mutate;
  const destroyKind = DESTROY_ALIASES[RAW.destroy] || RAW.destroy;
  if (mutateKind && destroyKind) return usageExit('--mutate 与 --destroy 只能选一个');
  if (mutateKind && !MUTATE_KINDS.includes(mutateKind)) {
    return usageExit('未知 --mutate=' + mutateKind + '（支持：' + MUTATE_KINDS.join(' / ') + '）');
  }
  if (destroyKind && !DESTROY_KINDS.includes(destroyKind)) {
    return usageExit('未知 --destroy=' + RAW.destroy + '（支持：' + DESTROY_KINDS.join(' / ') + '）');
  }
  if ((mutateKind || destroyKind) && RAW.count) return usageExit('--count 不能与 --mutate/--destroy 组合');
  if (!['include', 'skip'].includes(RAW.v3mode)) return usageExit('--v3 只能是 include 或 skip');

  const maxDetailArg = Number(RAW.maxDetailRaw);
  const maxDetail = Number.isInteger(maxDetailArg) && maxDetailArg >= 0 ? maxDetailArg : 20;
  const defaultOffset = Number.isFinite(RAW.offsetMinutes) ? RAW.offsetMinutes : 480;

  const root = path.resolve(RAW.root);
  const sessions = RAW.sessions ? path.resolve(RAW.sessions) : '';
  if (!fs.existsSync(root)) return usageExit('--root 指向的目录不存在: ' + root);
  if (sessions && !fs.existsSync(sessions)) return usageExit('--sessions 指向的目录不存在: ' + sessions);
  if (!wantViews && !fs.existsSync(path.join(root, 'ledger'))) {
    return usageExit('--root 下没有 ledger/ 目录（这不是已 ingest 的账库根）: ' + path.join(root, 'ledger'));
  }

  // ---- 加载 lib（失败一律 exit 2：环境问题不能伪装成"红/绿"）----
  // C10 的 --views 走纯独立实现：不加载任何 lib（连 original.js 都不 import），
  // 从构造上排除"用同一实现证明自己"。
  let libs = null;
  if (!wantViews) {
    try {
      libs = {
        ledgerMod: await mod('lib/ledger.js'),
        legacyMod: await mod('lib/legacy.js'),
        encoderMod: await mod('lib/encoder.js'),
        originalMod: await mod('lib/original.js'),
        framesMod: await mod('lib/frames.js'),
      };
    } catch (e) {
      const msg = 'lib 加载失败（环境错误）: ' + (e && e.message ? e.message : String(e));
      if (RAW.json) console.log(JSON.stringify({ ok: false, exitCode: EXIT.USAGE, error: msg }, null, 2));
      else console.error('[环境错误] ' + msg);
      process.exitCode = EXIT.USAGE;
      return;
    }
  }

  const mode = mutateKind || destroyKind ? 'self-check'
    : wantViews ? 'views'
      : wantOriginals ? 'originals'
        : (RAW.count ? 'count' : 'fields');
  const opt = {
    root, sessions, sessionsBase: sessions, mode,
    includeV3: RAW.v3mode !== 'skip', defaultOffset, maxDetail,
    mutate: mutateKind, destroy: destroyKind, json: RAW.json,
    all: RAW.all, viewsLimit,
  };

  let result;
  try {
    if (mode === 'self-check') result = await runSelfCheck(opt, libs);
    else if (mode === 'views') result = await verifyViews(opt);
    else if (mode === 'originals') result = await verifyOriginals(opt, libs);
    else if (mode === 'count') result = await verifyCount(opt, libs);
    else result = await verifyOnce(opt, libs);
  } catch (e) {
    // 校验器自身异常：不能报绿，也不能报"有红"（会被误读成账有问题）→ exit 2 并说明
    const msg = '校验器执行异常: ' + (e && e.stack ? e.stack : String(e));
    if (RAW.json) console.log(JSON.stringify({ ok: false, exitCode: EXIT.USAGE, error: msg }, null, 2));
    else console.error('[执行异常] ' + msg);
    process.exitCode = EXIT.USAGE;
    return;
  }

  if (result.fatality) return usageExit(result.fatality);

  // ---- 输出 ----
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : EXIT.USAGE;
  if (RAW.json) {
    const out = {
      schema: 'v091-replay-verify/1',
      generatedAt: iso(),
      ok: result.ok === true,
      exitCode,
      mode: result.mode,
      root: result.root,
      sessions: result.sessionsBase,
      ledgerRows: result.ledgerRows === undefined ? null : result.ledgerRows,
      replayedTurns: result.replayedTurns === undefined ? null : result.replayedTurns,
      compared: result.compared === undefined ? null : result.compared,
      mismatches: result.mismatches || [],
      skipped: result.skipped || { v3: 0, unparsable: 0 },
      counts: result.counts || {},
      notes: result.notes || [],
      elapsedMs: result.elapsedMs,
    };
    if (result.selfCheck) out.selfCheck = result.selfCheck;
    if (result.stats) out.stats = result.stats;
    if (result.error) out.error = result.error;
    console.log(JSON.stringify(out, null, 2));
    // --json 的契约：stdout 是**纯**机读 JSON（与人读摘要不混排）；需要人读摘要就去掉 --json 再跑一次
  } else if (result.mode === 'originals') {
    printOriginalsHuman(result, opt);
  } else if (result.mode === 'views') {
    printViewsHuman(result, opt);
  } else {
    printHuman(result, opt);
  }
  process.exitCode = exitCode;
}

await main();
