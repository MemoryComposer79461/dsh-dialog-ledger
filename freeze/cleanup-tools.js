/**
 * @file cleanup-tools.js
 * @role **V0.9 Agent 工具的业务逻辑层**：对账 / 库外锚核验 / 清理预览 / 受控清理。
 *
 * @why 为什么单独立一层，而不是把逻辑写进 toolface.js：
 *      toolface 的职责是"注册工具 + 写读日志 + 异常兜底"（外层）；卡片在 toolcards。
 *      把判定逻辑放这里，才能做到 **不依赖 ctx、可单测、可被 CLI/面板复用**。
 *      本文件除 node:fs/path 与既有 lib 模块外零依赖，也不持有任何模块级可变状态 ——
 *      确认短语的校验全部由"现场重算"得出（进程重启/配置热更新后行为仍可解释）。
 *
 * @why 只读三件套一个字节都不许写：
 *      对账（reconcile）在库里可能被误信成"顺手修一下更好"，但账实不符时任何自动修复都会
 *      把"缺凭证"变成"没缺"——那就没法审计了。V0.9 的 AG-01/CT-01 用"整树 sha256 不变"守。
 *
 * @why 清理默认 dryRun:
 *      `runCleanup` 自己的双开关（cleanupAllowPhysicalDelete + dryRun:false）是库里最后一道闸；
 *      工具层再要 **第三重** confirm（短语 = 当前计划重算值），因为 Agent 可能被上下文里的旧计划
 *      误导去"确认一个已经变了的清单"。三重俱备才可能删第一个字节。
 *
 * @depends ./reconcile.js、./cleanup.js、./manifestanchor.js、./layout.js
 */

import fs from 'node:fs';
import path from 'node:path';

import { reconcile } from '../lib/reconcile.js';
import { listOriginals, planCleanup, runCleanup } from './cleanup.js';
import { ANCHOR_FILE, ANCHOR_VERSION, computePackageDigest, readManifest } from './manifestanchor.js';
import { SUBDIR } from '../lib/layout.js';

/** 结果结构版本（结构变更时 +1，外部脚本按此判形状）。 */
export const CLEANUP_TOOLS_VERSION = 1;

/** 失败机器码：与 cleanup.js 的 `E_CLEANUP_*` 同一命名族，便于调用方统一分流。 */
export const E_BAD_ARGS = 'E_BAD_ARGS';
export const E_BAD_ROOT = 'E_BAD_ROOT';
export const E_ROOT_MISSING = 'E_ROOT_MISSING';
export const E_LEDGER_UNREADABLE = 'E_LEDGER_UNREADABLE';
export const E_ANCHOR_UNREADABLE = 'E_ANCHOR_UNREADABLE';
export const E_CLEANUP_FAILED = 'E_CLEANUP_FAILED';
export const E_CLEANUP_TOOL_DISABLED = 'E_CLEANUP_TOOL_DISABLED';
export const E_CLEANUP_DELETE_LOCKED = 'E_CLEANUP_DELETE_LOCKED';
export const E_CLEANUP_CONFIRM_MISMATCH = 'E_CLEANUP_CONFIRM_MISMATCH';

/** 问题清单上限（模型上下文优先；完整明细由落盘报告回答）。 */
const MAX_PROBLEMS = 10;
/** 警告上限（降级提示，不参与 ok 判定）。 */
const MAX_WARNINGS = 5;
/** 锚链"创世"标记：v0.8 现实文件用中文括号，空串是本实现 appendAnchor 的缺省值。 */
const GENESIS_MARKS = Object.freeze(['', '（创世）']);
/** 64 位小写 hex（payloadHash / prevHash / manifestSha256 / 文件 sha）。 */
const HASH_RE = /^[0-9a-f]{64}$/;
/** dry-run 报告名（与 cleanup.js 的 DRY_RUN_RE 同一口径；独立前缀 = 不占正式编号）。 */
const DRY_RUN_RE = /^RPT-DRYRUN-(\d{8})-(\d+)\.md$/;

const msgOf = (e) => String(e && e.message ? e.message : e);
const pad2 = (n) => String(n).padStart(2, '0');
const short = (h) => (typeof h === 'string' && h.length > 16 ? `${h.slice(0, 16)}…` : String(h || ''));

/** 本地日 `YYYYMMDD`（+08:00 口径；与本项目其余模块同一算法，不取本机时区）。 */
function localDate(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** 读目录；不可读返回空数组（只读路径绝不让"读不到"变成崩溃）。 */
function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * root 是否"安全可操作"：非空、绝对路径、且**不是盘符根/UNC 根**。
 *
 * @why 仅判"是字符串"不够：清理工具带删除语义，如果把 `C:\` 当数据总库传进来，
 *      `listOriginals` 会从盘符根开始往下扫。这里先一刀切拒绝，比事后每层再防御便宜得多。
 * @param {unknown} root
 * @returns {boolean}
 */
export function isSafeRoot(root) {
  if (typeof root !== 'string') return false;
  const s = root.trim();
  if (!s) return false;
  try {
    if (!path.isAbsolute(s)) return false;
    if (path.parse(s).root === s) return false; // `C:\`、`\\server\share` 之类的根
  } catch {
    return false;
  }
  return true;
}

/**
 * root 合法性 + 存在性检查。
 * @returns {{ok:true, root:string} | {ok:false, reason:string, root?:string, message?:string}}
 */
export function requireRoot(root) {
  if (!isSafeRoot(root)) {
    return { ok: false, reason: E_BAD_ROOT, message: 'root 必须是非盘符根的绝对路径（拒绝越界操作）' };
  }
  const abs = path.resolve(String(root).trim());
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return { ok: false, reason: E_ROOT_MISSING, root: abs, message: 'root 不存在或不可读：' + msgOf(e) };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: E_BAD_ROOT, root: abs, message: 'root 不是目录' };
  }
  return { ok: true, root: abs };
}

/**
 * 工具入参白名单校验（Host 的 schema 会挡一层，这里再挡一层）。
 *
 * @why schema 的 `additionalProperties: false` 能否被宿主真正执行取决于宿主实现；
 *      而"未知参数被静默忽略"在删除类工具上不可接受 —— 模型以为写了 `confirm`，
 *      实际参数名打错就变成"没确认"。所以本层显式拒绝未知键（AG-05）。
 * @param {unknown} args
 * @param {string[]} allowed
 * @returns {{ok:true, args:object} | {ok:false, reason:string, message:string}}
 */
export function checkToolArgs(args, allowed = []) {
  if (args === undefined || args === null) return { ok: true, args: {} };
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: E_BAD_ARGS, message: '参数必须是对象' };
  }
  const allow = new Set(Array.isArray(allowed) ? allowed : []);
  const unknown = Object.keys(args).filter((k) => !allow.has(k));
  if (unknown.length > 0) {
    return { ok: false, reason: E_BAD_ARGS, message: '未知参数：' + unknown.join('、') };
  }
  return { ok: true, args };
}

/**
 * 归一化清理范围参数（month / sessionKey / limit）。
 * @returns {{ok:true, value:{month?:string, sessionKey?:string, limit?:number}} | {ok:false, reason:string, message:string}}
 */
function normalizeFilters(p) {
  const out = {};
  if (p.month !== undefined) {
    if (typeof p.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) {
      return { ok: false, reason: E_BAD_ARGS, message: 'month 必须形如 YYYY-MM（如 2026-11）' };
    }
    out.month = p.month;
  }
  if (p.sessionKey !== undefined) {
    if (typeof p.sessionKey !== 'string' || !/^[0-9a-z]{12}[A-Z]$/.test(p.sessionKey)) {
      return { ok: false, reason: E_BAD_ARGS, message: 'sessionKey 必须是 13 位（12 位小写字母/数字 + 1 位大写代差）' };
    }
    out.sessionKey = p.sessionKey;
  }
  if (p.limit !== undefined) {
    if (!Number.isInteger(p.limit) || p.limit < 0) {
      return { ok: false, reason: E_BAD_ARGS, message: 'limit 必须是非负整数（0 = 不限）' };
    }
    if (p.limit > 0) out.limit = p.limit;
  }
  return { ok: true, value: out };
}

/** 本工具族的确认短语（唯一格式；人可读、可抄回）。 */
export function confirmPhraseOf({ planned, reportId } = {}) {
  return `DELETE ${Number(planned) || 0} ${String(reportId || '')}`;
}

/** 清册双路径目录序：`清册/`（新布局）优先、一级（老库）兜底 —— 与 cleanup.js:reportScanDirs 同口径。 */
function reportDirs(root) {
  return [path.join(root, SUBDIR.cleanup), root];
}

/**
 * 当日已存在的最新 dry-run 报告编号（扫双路径，取最大序号）。
 *
 * @why 为什么是"当日"：confirm 的语义是"对刚才那次预览的确认"。跨日的预览已经过了一夜，
 *      计划很可能变了；宁可要求重新 preview，也不让隔夜确认落到真删上。
 * @param {{root:string, offsetMinutes?:number, nowMs?:number}} p
 * @returns {string} `RPT-DRYRUN-YYYYMMDD-NN`；当日没有则 `''`
 */
export function latestDryRunId({ root, offsetMinutes = 480, nowMs = Date.now() } = {}) {
  if (!isSafeRoot(root)) return '';
  const day = localDate(Number.isFinite(nowMs) ? nowMs : Date.now(), Number.isFinite(offsetMinutes) ? offsetMinutes : 480);
  let best = null; // {id, serial}
  const seen = new Set();
  for (const dir of reportDirs(path.resolve(String(root).trim()))) {
    for (const name of safeReaddir(dir)) {
      const m = DRY_RUN_RE.exec(name);
      if (!m || m[1] !== day) continue;
      const id = name.replace(/\.md$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      const serial = Number(m[2]);
      if (!best || serial > best.serial) best = { id, serial };
    }
  }
  return best ? best.id : '';
}

/** 失败原因：优先透传 cleanup 族的机器码，其余归一成 E_CLEANUP_FAILED。 */
function reasonOf(e) {
  const code = e && typeof e.code === 'string' ? e.code : '';
  return /^E_CLEANUP_[A-Z0-9_]+$/.test(code) ? code : E_CLEANUP_FAILED;
}

/** 问题收集器：全量收集，返回时截断（调用方可见 truncated 标记）。 */
function makeCollector() {
  const all = [];
  return {
    push(kind, at, detail) {
      const atText = String(at || '');
      // 锚类问题用 `line N` 表达位置；顺手把行号提出成字段（卡片/测试都直接读 line）。
      const m = /^line (\d+)$/.exec(atText);
      all.push({
        kind: String(kind),
        at: atText,
        ...(m ? { line: Number(m[1]) } : {}),
        detail: String(detail || ''),
      });
    },
    list(max) { return all.slice(0, max); },
    all() { return all.slice(); },
    get total() { return all.length; },
  };
}

// ============================================================================
// 一、ledger_reconcile —— 只读对账（紧凑摘要）
// ============================================================================

/**
 * 对账并压成"模型先看的摘要"：计数 + 最多 10 条定位。
 *
 * @param {{root:string, offsetMinutes?:number, receiptAnchorRoot?:string, nowMs?:number}} p
 * @returns {object} `{ok, reason?, at, okStrict, counts, problems, truncated}`
 */
export function compactReconcile(p = {}) {
  const rootCheck = requireRoot(p.root);
  if (!rootCheck.ok) return rootCheck;
  const root = rootCheck.root;
  const offsetMinutes = Number.isFinite(p.offsetMinutes) ? p.offsetMinutes : 480;
  const receiptAnchorRoot = typeof p.receiptAnchorRoot === 'string' ? p.receiptAnchorRoot : '';
  const nowMs = Number.isFinite(p.nowMs) ? p.nowMs : Date.now();

  let r;
  try {
    // maxDetail 压到 100：reconcile 默认 1000 条明细，对工具摘要没意义，还白占内存。
    r = reconcile({ root, offsetMinutes, receiptAnchorRoot, nowMs, maxDetail: 100 });
  } catch (e) {
    return { ok: false, reason: E_LEDGER_UNREADABLE, message: msgOf(e) };
  }

  const c = makeCollector();
  for (const e of (Array.isArray(r.readErrors) ? r.readErrors : [])) {
    const where = String(e && e.file ? e.file : 'ledger') + (e && Number.isInteger(e.line) && e.line > 0 ? ':' + e.line : '');
    c.push('ledger-read-error', where, String((e && e.reason) || ''));
  }
  if (Number(r.badLines) > 0) c.push('bad-line', 'ledger', `台账坏行 ${r.badLines} 行`);
  for (const m of (Array.isArray(r.originalMissing) ? r.originalMissing : [])) {
    c.push('original-missing', m.code, `${m.part} ${m.doc || ''}`.trim());
  }
  for (const o of (Array.isArray(r.originalOrphan) ? r.originalOrphan : [])) {
    c.push('original-orphan', o.code, String(o.file || ''));
  }
  for (const w of (Array.isArray(r.weeklyGroupsMissing) ? r.weeklyGroupsMissing : [])) {
    c.push('weekly-missing', w.gid, String(w.file || ''));
  }
  for (const b of (r.lostGaps && Array.isArray(r.lostGaps.recordsTail) ? r.lostGaps.recordsTail : [])) {
    c.push('lost-gap', String(b.at || 'ledger/.lost.jsonl'), `failedFrames=${b.failedFrames} badLines=${b.badLines}`);
  }
  for (const b of (Array.isArray(r.receiptBreaks) ? r.receiptBreaks : [])) {
    c.push('receipt-break', String(b.date || ''), String(b.reason || ''));
  }
  if (r.sealChain && r.sealChain.ok === false) {
    const breaks = Array.isArray(r.sealChain.breaks) ? r.sealChain.breaks : [];
    if (breaks.length === 0) c.push('seal-break', 'ledger/.seal-journal.jsonl', String(r.sealChain.readError || '封板链异常'));
    for (const b of breaks) c.push('seal-break', 'line ' + String(b.line), String(b.reason || ''));
  }

  const counts = {
    ledgerRows: Number(r.ledgerRows) || 0,
    codeUnique: r.codeUnique === true,
    sidTurnUnique: r.sidTurnUnique === true,
    ledgerOk: r.ledgerOk === true,
    originalCount: Number(r.originalCount) || 0,
    originalMissing: Array.isArray(r.originalMissing) ? r.originalMissing.length : 0,
    originalOrphan: Array.isArray(r.originalOrphan) ? r.originalOrphan.length : 0,
    weeklyGroupsExpected: Array.isArray(r.weeklyGroupsExpected) ? r.weeklyGroupsExpected.length : 0,
    weeklyGroupsMissing: Array.isArray(r.weeklyGroupsMissing) ? r.weeklyGroupsMissing.length : 0,
    lostGaps: r.lostGaps ? Number(r.lostGaps.count) || 0 : 0,
    receiptBreaks: Number(r.receiptBreakCount) || 0,
    sealChainBreaks: r.sealChain ? (Number(r.sealChain.chainBroken) || 0) + (Number(r.sealChain.badLines) || 0) : 0,
  };
  const problems = c.list(MAX_PROBLEMS);
  const truncated = c.total > problems.length;

  // ★ "账没读全"不是"账没问题"（P1-8 口径）：读坏时 ok 必须 false 并给出机器码，
  //   否则模型会把"读到 0 行"误当成"账本本来就是空的"。
  const readable = r.ledgerOk === true && (Number(r.badLines) || 0) === 0
    && (Array.isArray(r.readErrors) ? r.readErrors.length : 0) === 0;
  if (!readable) {
    return {
      ok: false, reason: E_LEDGER_UNREADABLE, at: String(r.at || ''), okStrict: false,
      counts, problems, truncated,
    };
  }
  return {
    ok: r.ok === true,
    at: String(r.at || ''),
    okStrict: r.okStrict === true,
    counts,
    problems,
    truncated,
  };
}

// ============================================================================
// 二、ledger_anchor —— 只读核验库外锚
// ============================================================================

/** 锚行结构合法性 + 链 + 包 payloadHash 复算（内部实现，返回问题/警告/计数/头）。 */
function inspectAnchor({ anchorRoot, file, text }) {
  const c = makeCollector();
  const warnings = [];
  const warn = (line, kind, detail) => {
    if (warnings.length < MAX_WARNINGS) warnings.push({ line, kind, detail: String(detail || '') });
  };
  const lines = String(text).split('\n');
  const parsed = []; // {line, rec}
  let badLines = 0;
  let lastNonEmptyLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = i + 1;
    if (!raw.trim()) continue;
    lastNonEmptyLine = line;
    let rec = null;
    try { rec = JSON.parse(raw); } catch {
      badLines += 1;
      c.push('bad-line', 'line ' + line, 'JSON 解析失败');
      continue;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      badLines += 1;
      c.push('bad-line', 'line ' + line, '不是对象');
      continue;
    }
    if (rec.v !== ANCHOR_VERSION) {
      badLines += 1;
      c.push('bad-line', 'line ' + line, 'v 不是 ' + ANCHOR_VERSION);
      continue;
    }
    if (typeof rec.kind !== 'string' || (rec.kind !== 'package' && rec.kind !== 'ledger-snapshot')) {
      badLines += 1;
      c.push('bad-line', 'line ' + line, '未知 kind：' + String(rec.kind));
      continue;
    }
    parsed.push({ line, rec });
  }

  // ① append-only 形态：末尾半行 = 上次追加被截断的直接证据（只增文件的尾部必须完整）。
  if (text.length > 0 && !String(text).endsWith('\n')) {
    c.push('torn-tail', 'line ' + lastNonEmptyLine, '文件末尾缺少换行（疑似半行追加被截断）');
  }

  // ② package 行：链 + payloadHash 复算
  const pkgRows = parsed.filter((x) => x.rec.kind === 'package');
  const snapRows = parsed.filter((x) => x.rec.kind === 'ledger-snapshot');
  const seenPayload = new Set();
  let prevHash = null;
  let firstPkg = true;
  let verified = 0;
  let unverified = 0;

  for (const { line, rec } of pkgRows) {
    const payload = typeof rec.payloadHash === 'string' ? rec.payloadHash : '';
    const prev = typeof rec.prevHash === 'string' ? rec.prevHash : '';
    if (!HASH_RE.test(payload)) {
      c.push('payload-hash-bad', 'line ' + line, 'payloadHash 不是 64 位 hex：' + short(payload));
    } else if (seenPayload.has(payload)) {
      // append-only 链上的重复 = 版本回退或整行复制；正常 appendAnchor 对同 hash 只会幂等跳过。
      c.push('duplicate-payload', 'line ' + line, 'payloadHash 与更早的包锚重复：' + short(payload));
    }
    if (HASH_RE.test(payload)) seenPayload.add(payload);

    if (firstPkg) {
      if (!GENESIS_MARKS.includes(prev)) {
        // 首条包锚指向一个不存在的"上一条" = 文件前段被删过，这是"只增不改"被破坏。
        c.push('chain-start-missing', 'line ' + line, '首条包锚 prevHash 非创世：' + short(prev));
      }
      firstPkg = false;
    } else if (prev !== prevHash) {
      c.push('chain-break', 'line ' + line, `prevHash 不连续（期望 ${short(prevHash)}，实际 ${short(prev)}）`);
    }
    prevHash = HASH_RE.test(payload) ? payload : prevHash;

    // 逐条 payloadHash 复算：包在盘上时用与出包脚本/版本台账同算法的 computePackageDigest。
    const pkgPath = typeof rec.pkgPath === 'string' ? rec.pkgPath : '';
    let pkgDir = '';
    try {
      if (pkgPath && fs.statSync(pkgPath).isDirectory()) pkgDir = pkgPath;
    } catch { pkgDir = ''; }
    if (!pkgDir) {
      // 降级：包被搬走/清理后不能判红（机主把包搬 U 盘后这里会长期"未复算"）。
      unverified += 1;
      if (pkgPath) warn(line, 'package-missing', '包目录不在盘上，未复算：' + pkgPath);
      continue;
    }
    let digest = null;
    let mf = null;
    try {
      digest = computePackageDigest(pkgDir);
      mf = readManifest(pkgDir);
    } catch (e) {
      unverified += 1;
      warn(line, 'package-unreadable', '包目录读不了，未复算：' + msgOf(e));
      continue;
    }
    if (digest.payloadHash === payload) {
      verified += 1;
    } else {
      c.push('payload-mismatch', 'line ' + line, `payloadHash 复算不符（锚 ${short(payload)}，盘 ${short(digest.payloadHash)}）`);
    }
    const mfSha = typeof rec.manifestSha256 === 'string' ? rec.manifestSha256 : '';
    if (HASH_RE.test(mfSha) && digest.manifestSha256 && mfSha !== digest.manifestSha256) {
      c.push('manifest-mismatch', 'line ' + line, `MANIFEST 文件哈希不符（锚 ${short(mfSha)}，盘 ${short(digest.manifestSha256)}）`);
    }
    if (digest.manifestSha256) {
      // v0.8 口径：总文件数 = payload 文件数 + 3（MANIFEST / 版本台账 / 00-交付清单）。
      if (Number(rec.fileCount) !== digest.files + 3) {
        c.push('file-count-mismatch', 'line ' + line, `fileCount 不符（锚 ${Number(rec.fileCount) || 0}，盘 ${digest.files + 3}）`);
      }
      if (Number(rec.manifestCount) !== mf.count) {
        c.push('manifest-count-mismatch', 'line ' + line, `manifestCount 不符（锚 ${Number(rec.manifestCount) || 0}，盘 ${mf.count}）`);
      }
      if (Number(mf.badLines) > 0) warn(line, 'manifest-bad-lines', `MANIFEST 有 ${mf.badLines} 坏行`);
    }
  }

  // ③ ledger-snapshot 行：v0.8 格式 payloadHash 恒为空，只做结构校验（逐文件复算归恢复演练）。
  for (const { line, rec } of snapRows) {
    const files = rec.files;
    if (!Array.isArray(files)) {
      c.push('snapshot-structure', 'line ' + line, 'files 不是数组');
    } else {
      const bad = files.filter((f) => !f || typeof f !== 'object'
        || typeof f.name !== 'string' || !f.name
        || !HASH_RE.test(String(f.sha256 || ''))
        || !Number.isInteger(f.bytes) || !Number.isInteger(f.rows)).length;
      if (bad > 0) c.push('snapshot-structure', 'line ' + line, `files 有 ${bad} 项字段不合法`);
    }
    const snapPayload = typeof rec.payloadHash === 'string' ? rec.payloadHash : '';
    if (snapPayload) warn(line, 'snapshot-payload-unverifiable', '快照行 payloadHash 非空，但 v0.8 格式无复算算法');
  }

  const all = c.list(MAX_PROBLEMS);
  const problems = all;
  const truncated = c.total > problems.length;
  const last = parsed.length > 0 ? parsed[parsed.length - 1] : null;
  const full = c.all();
  const chainProblems = full.filter((x) => x.kind === 'chain-break' || x.kind === 'chain-start-missing').length;
  const payloadProblems = full.filter((x) => x.kind === 'payload-mismatch' || x.kind === 'payload-hash-bad').length;
  const structural = full.filter((x) => x.kind === 'snapshot-structure' || x.kind === 'bad-line').length;
  const counts = {
    packages: pkgRows.length,
    snapshots: snapRows.length,
    badLines,
    chainBreaks: chainProblems,
    payloadMismatches: payloadProblems,
    structural,
    verifiedPackages: verified,
    unverifiedPackages: unverified,
  };
  return {
    ok: c.total === 0,
    anchorRoot,
    file,
    exists: true,
    entries: parsed.length,
    counts,
    chainOk: chainProblems === 0,
    payloadOk: payloadProblems === 0,
    head: last
      ? {
        line: last.line,
        kind: String(last.rec.kind),
        version: String(last.rec.version || ''),
        payloadHash: String(last.rec.payloadHash || ''),
        at: String(last.rec.at || ''),
      }
      : null,
    problems,
    truncated,
    warnings,
  };
}

/**
 * 只读核验库外锚。
 *
 * @param {{anchorRoot?:string}} p
 * @returns {object} `{ok, reason?, ...}`；未配置 → `anchor-disabled`（降级不抛）
 */
export function verifyAnchor(p = {}) {
  const anchorRoot = typeof p.anchorRoot === 'string' ? p.anchorRoot.trim() : '';
  if (!anchorRoot) return { ok: false, reason: 'anchor-disabled', configured: false, anchorRoot: '' };
  if (!isSafeRoot(anchorRoot)) return { ok: false, reason: E_BAD_ROOT, anchorRoot };
  const abs = path.resolve(anchorRoot);
  const file = path.join(abs, ANCHOR_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'anchor-missing', anchorRoot: abs, file };
    return { ok: false, reason: E_ANCHOR_UNREADABLE, anchorRoot: abs, file, message: msgOf(e) };
  }
  try {
    return inspectAnchor({ anchorRoot: abs, file, text });
  } catch (e) {
    // 解析层不许把"锚文件里有意料之外的形状"变成工具异常（降级不抛）。
    return { ok: false, reason: E_ANCHOR_UNREADABLE, anchorRoot: abs, file, message: msgOf(e) };
  }
}

// ============================================================================
// 三、ledger_cleanup_preview —— 只读预览（零字节写入）
// ============================================================================

/**
 * 圈选"若执行清理会删哪些第 3 级单元"，只读返回。
 *
 * @why 与 `applyCleanup(dryRun:true)` 的区别必须钉死：本函数**不调用 runCleanup**，
 *      因此不会产生 `RPT-DRYRUN-*` 报告文件 —— "看一眼"不应该留下任何产物（CT-01）。
 * @param {{root:string, month?:string, sessionKey?:string, limit?:number}} p
 * @returns {object} `{ok, planned, bytes, byMonth, sample}`
 */
export function previewCleanup(p = {}) {
  const filter = normalizeFilters(p);
  if (!filter.ok) return filter;
  const rootCheck = requireRoot(p.root);
  if (!rootCheck.ok) return rootCheck;
  const root = rootCheck.root;

  let originals = [];
  let selected = [];
  try {
    originals = listOriginals(root);
    selected = planCleanup({ originals, ...filter.value });
  } catch (e) {
    return { ok: false, reason: E_CLEANUP_FAILED, message: msgOf(e) };
  }

  const byMonth = {};
  const sample = [];
  let bytes = 0;
  for (const item of selected) {
    // 一个清理单元 = 视图 md + 同编码事件附件；字节数要把附件算进去，否则"预计释放空间"会偏小。
    let size = Number(item.size) || 0;
    if (item.attachmentExists) {
      try { size += fs.statSync(item.attachmentAbs).size; } catch { /* 附件刚被删就按视图算 */ }
    }
    bytes += size;
    const month = String(item.month || 'unknown');
    if (!byMonth[month]) byMonth[month] = { files: 0, bytes: 0 };
    byMonth[month].files += 1;
    byMonth[month].bytes += size;
    if (sample.length < 5) sample.push({ code: String(item.code), month, bytes: size, rel: String(item.rel) });
  }
  return { ok: true, planned: selected.length, bytes, byMonth, sample };
}

// ============================================================================
// 四、ledger_cleanup_apply —— 受控执行（默认试运行；三重条件才可能真删）
// ============================================================================

/**
 * 受控清理：默认 dryRun（只产 RPT-DRYRUN 报告 + confirm 短语）；显式 dryRun:false 且三重条件
 * （工具总开关 / 物理删除开关 / confirm 短语）全部成立后才调 `runCleanup` 真删。
 *
 * @param {{
 *   root:string, month?:string, sessionKey?:string, limit?:number, offsetMinutes?:number,
 *   dryRun?:boolean, confirm?:string,
 *   cleanupToolEnabled?:boolean, cleanupAllowPhysicalDelete?:boolean
 * }} p
 * @returns {object} 紧凑结果；失败时 `ok:false` + `reason`，且**零删除**
 */
export function applyCleanup(p = {}) {
  const rootCheck = requireRoot(p.root);
  if (!rootCheck.ok) return rootCheck;
  const root = rootCheck.root;
  const filter = normalizeFilters(p);
  if (!filter.ok) return filter;
  const offsetMinutes = Number.isFinite(p.offsetMinutes) ? p.offsetMinutes : 480;

  let dryRun = true;
  if (p.dryRun !== undefined) {
    if (typeof p.dryRun !== 'boolean') {
      return { ok: false, reason: E_BAD_ARGS, message: 'dryRun 必须是布尔（true = 试运行，false = 请求物理删除）' };
    }
    dryRun = p.dryRun;
  }

  // ── 试运行（默认路径）：唯一的写动作是 RPT-DRYRUN 报告（不占正式编号、不写 journal）。
  if (dryRun) {
    let r;
    try {
      r = runCleanup({
        root, ...filter.value, offsetMinutes, dryRun: true, writeReport: true,
      });
    } catch (e) {
      return { ok: false, dryRun: true, reason: reasonOf(e), message: msgOf(e) };
    }
    return {
      ok: true,
      dryRun: true,
      reportId: String(r.reportId || ''),
      planned: Number(r.planned) || 0,
      confirmPhrase: confirmPhraseOf({ planned: r.planned, reportId: r.reportId }),
      reportPath: String(r.path || ''),
      originalsBefore: Number(r.originalsBefore) || 0,
    };
  }

  // ── 物理删除：三重条件，任一不满足 → 零删除。顺序固定，且都在 runCleanup 之前。
  if (p.cleanupToolEnabled !== true) {
    return {
      ok: false, dryRun: false, reason: E_CLEANUP_TOOL_DISABLED, deleted: 0,
      message: '清理工具总开关 cleanupToolEnabled 未开启（默认关闭）；需要机主在插件配置里显式打开',
    };
  }
  if (p.cleanupAllowPhysicalDelete !== true) {
    return {
      ok: false, dryRun: false, reason: E_CLEANUP_DELETE_LOCKED, deleted: 0,
      message: '物理删除开关 cleanupAllowPhysicalDelete 未开启；只开工具总开关不足以真删',
    };
  }

  // 第三重：confirm 必须等于"当前计划"重算出的短语（不认内存里的旧令牌）。
  let selected = [];
  try {
    selected = planCleanup({ originals: listOriginals(root), ...filter.value });
  } catch (e) {
    return { ok: false, dryRun: false, reason: E_CLEANUP_FAILED, deleted: 0, message: msgOf(e) };
  }
  const planned = selected.length;
  const reportId = latestDryRunId({ root, offsetMinutes });
  if (!reportId) {
    return {
      ok: false, dryRun: false, reason: E_CLEANUP_CONFIRM_MISMATCH, deleted: 0, planned, reportId: '',
      hint: '当日没有 RPT-DRYRUN 报告：先调用 dryRun:true 拿 confirmPhrase，再原样传回',
    };
  }
  const expected = confirmPhraseOf({ planned, reportId });
  const confirm = typeof p.confirm === 'string' ? p.confirm.trim() : '';
  if (confirm !== expected) {
    return {
      ok: false, dryRun: false, reason: E_CLEANUP_CONFIRM_MISMATCH, deleted: 0, planned, reportId,
      hint: 'confirm 必须与当前计划重算出的短语完全一致；计划变化后必须重新 dryRun:true 取新短语',
    };
  }

  let r;
  try {
    r = runCleanup({
      root, ...filter.value, offsetMinutes, dryRun: false, cleanupAllowPhysicalDelete: true, writeReport: true,
    });
  } catch (e) {
    // 清册自检不过时 runCleanup 可能在"已经删过文件"之后抛错 —— 这里不谎报零删除。
    return { ok: false, dryRun: false, reason: reasonOf(e), message: msgOf(e), deleted: null, reportId, planned };
  }
  return {
    ok: true,
    dryRun: false,
    reportId: String(r.reportId || ''),
    planned: Number(r.planned) || 0,
    deleted: Number(r.deleted) || 0,
    succeeded: Number(r.succeeded) || 0,
    failed: Number(r.failed) || 0,
    originalsBefore: Number(r.originalsBefore) || 0,
    originalsAfter: Number(r.originalsAfter) || 0,
    reportPath: String(r.path || ''),
    journalPath: String(r.journalPath || ''),
  };
}
