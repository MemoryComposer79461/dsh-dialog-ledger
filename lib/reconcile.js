/**
 * @file reconcile.js
 * @role 对账骨架 —— **只报不修**（v0.5 D7 / 判据 RC-01…RC-12）。
 * @called-by index.js（周期对账；仅读）
 * @depends node:fs / node:path / node:crypto、./ledger.js、./weekly.js、./week.js、
 *          ./original.js、./sealjournal.js
 *
 * ⚠️ 三条不能违反的约束：
 *   ① **纯只读**：不 mkdir / 不 write / 不 append；调用前后整棵 root 的文件名/大小/
 *       mtime/sha256 必须完全一致（自测里有专门断言）。运行报告由调用方写（selfheal.writeRunReport）。
 *   ② **不裁决、不修复**：对不上就报出来（交人裁决），绝不自动"修账"。
 *   ③ **空数据只能由成功读取证明**（P1-8）：`ledger.ok=false` 时不得把"没读到"当"没有"；
 *      对账结果里原样带出 readErrors/badLines，并让 ok=false。
 *
 * @why 为什么周记账只查文件存在、不读 xlsx：
 *      v1.3 设计明确不引入 xlsx 读取器（零依赖底线）。文件在不在是"可判定"的，
 *      文件内容对不对由周记账自己的封板 hash / 快照复算负责（CH-17/18）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readAll, readLost, readStateEx, stampLocal } from './ledger.js';
import { groupRecords, resolveDoc, readCleanedCodesCompat, monthOfCode } from './weekly.js';
// lite（S-8/P1）：不再依赖 freeze/legacy-marks.js —— lite 从新库起，
// 不做"历史行正面标记"判定；兼容字段保留但恒 0（见 result.legacyMarks）。
import { weekOf, weeklyFileName, weeklyFolderName } from './week.js';
import { draftNameOf } from './weeklystate.js';
import { originalRelPath } from './original.js';
import { verifySealChain } from './sealjournal.js';

/** 对账结果版本（结构变更时 +1；外部工具按此判形状）。 */
export const RECONCILE_VERSION = 1;

/** 全量对账的最长间隔（v0.9.3-re1）：即便一直增量，每 24h 必须整库全核一次。 */
export const FULL_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// v0.9.3-re1 读放大修复：增量对账缓存（纯内存，不落盘 → reconcile 仍是"纯只读"）
// ============================================================================
/**
 * @why 为什么能增量而不丢语义（缓存键的**可证性**）：
 *   reconcile 的读放大全部来自 `resolveDoc → verifyOriginal`（整份原文 + 附件逐字复核）。
 *   `resolveDoc` 的结果只取决于这些输入：记录声明的凭证身份（doc / docFileSha256 / docSha256 /
 *   attachment.sha256/name/bytes）、原文与附件在磁盘上的**物理指纹**（stat：size/mtime/ctime/inode）、
 *   编码复算出的期望路径、清册结论（已清理 RPT 号）。行级缓存键 = 上述输入的完整拼接：
 *     · 台账里**新写入的行** → 键不在缓存 → 必然全量复核（"新写入行必须全核"）；
 *     · 旧行只有"身份没变 + 文件字节没被动过 + 清册结论没变"才命中；
 *     · 文件被删/改/换、或补了清册 → 任一输入变 → 键变 → 重新全量复核。
 *   ⇒ 命中 = 复用"上一次真核过"的结论，绝不把"跳过"当"核过"。
 *   同时保留**每日一次全量**（`FULL_RECONCILE_INTERVAL_MS`）与显式 `full:true` 兜底；
 *   进程重启后缓存为空 → 首次对账自动全量。缓存只在内存，不写任何文件。
 */
const RECONCILE_ROW_CACHE_MAX = 8192; // 内存纪律：键+结论快照约 1 KB/行 → 上限≈8 MB（只影响命中率，不影响正确性）
let reconcileCache = null; // { root, offsetMinutes, rows:Map<key,resolveDoc 结果快照>, lastFullAtMs, lastAtMs }

/** 文件物理指纹（只 stat，不读内容）：不存在 → 'ENOENT'；其它异常 → 'ERR'。 */
function fileStatKey(p) {
  if (!p) return '-';
  try {
    const st = fs.statSync(p);
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'ENOENT' : 'ERR';
  }
}

/** 行级缓存键：resolveDoc 的**全部输入**（身份 + 磁盘物理指纹 + 期望路径 + 清册结论）。 */
function resolveInputKey(root, rec, offsetMinutes, cleaned) {
  const code = String(rec.code || '');
  const docRel = typeof rec.doc === 'string' ? rec.doc : '';
  const docPath = docRel ? path.join(root, docRel) : '';
  const mm = monthOfCode(code, Date.parse(rec.ts), offsetMinutes);
  const computedPath = mm ? path.join(root, originalRelPath(mm.year, mm.month, code)) : '';
  const att = rec.attachment && typeof rec.attachment === 'object' ? rec.attachment : null;
  const attName = att && typeof att.name === 'string' && att.name ? att.name : `${code} 原始事件.json`;
  const attBase = docPath || computedPath;
  const attPath = attBase ? path.join(path.dirname(attBase), attName) : '';
  const cleanedReport = cleaned && cleaned.has(code) ? String(cleaned.get(code)) : '';
  return [
    root, code, docRel, String(rec.ts || ''),
    String(rec.docFileSha256 || ''), String(rec.docSha256 || rec.docHash || ''),
    att ? String(att.sha256 || '') : '', attName,
    att && att.bytes !== undefined ? String(att.bytes) : '',
    cleanedReport,
    fileStatKey(docPath), fileStatKey(computedPath), fileStatKey(attPath),
  ].join('\u0000');
}

/** 缓存值快照（深拷 problems/integrity，避免调用方误改污染缓存）。 */
function snapshotResolved(st) {
  return {
    ...st,
    problems: Array.isArray(st.problems) ? st.problems.slice() : [],
    integrity: st.integrity
      ? { ...st.integrity, problems: Array.isArray(st.integrity.problems) ? st.integrity.problems.slice() : [] }
      : null,
  };
}

/** 第 3 级档案文件名：`<32位编码>[.vN] 完整原文.md` / `... 原始事件.json`（D11/D10）。 */
const ARCHIVE_FILE_RE = /^([0-9]{8}-[0-9a-z]{12}-[A-Z]-[0-9]{8})(?:\.v(\d+))? (完整原文\.md|原始事件\.json)$/;

/** 缺月目录/原文夹时用：给调用方看的相对路径。 */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 封板证据的**结构性校验**（只读；契约 R-03 的 `sealChain` 形状）。
 *
 * @param {string} root
 * @returns {{ok:boolean, verifiable:boolean, lines:number,
 *            breaks:Array<{line:number,reason:string,expected:string,actual:string}>,
 *            events:number, chainBroken:number, badLines:number, readError:string, reason:string,
 *            journalExists:boolean, tornTailRepairable:boolean, stateSealedCount:number, stateOnlyKeys:Array}}
 *
 * @why 为什么这里不再自己算 `prevSealSha256` 链：
 *      lite 线按 S-1/K-5 已把封板链降级为"封板事实"（journal 不再写 prev 链字段），
 *      旧实现逐行比对 prev 哈希 → 从第 2 行起必然"断链"，**是已登记的假红根因**（退役清单 B2）。
 *      v1.0.0-re2 起改为**委托 `verifySealChain()` 的结构性校验**（坏行/重复行/重复键/时间回退/
 *      行数快照不一致/未知 kind），再把违规映射成 R-03 要求的 `{line,reason,expected,actual}`。
 *      这样"谁算链"只有一处实现（sealjournal.js），reconcile 只做形状适配，不会出现两套口径。
 * @why 空册（文件不存在）算 OK 且 `verifiable:false`：还没封过板不是错误，但也不能冒充"验过"。
 * @why v1.0.0-re3（审计② P2-8）：新增 `journalExists / stateSealedCount / stateOnlyKeys /
 *      tornTailRepairable` **透传**（不改任何判定）：对账结果要能回答"是没得验、还是证据被删了、
 *      末行撕裂能不能修"。state 交叉判定在 verifySealChain 里做（只读弱证据，不构成防篡改链）。
 */
export function detailedSealChain(root) {
  const v = verifySealChain(root);
  const violations = Array.isArray(v.violations) ? v.violations : [];
  return {
    ok: !!v.ok,
    verifiable: !!v.verifiable,
    lines: Number(v.events) || 0,
    breaks: violations.map((x) => ({
      line: Number(x && x.line) || 0,
      reason: String((x && x.reason) || 'UNKNOWN'),
      expected: x && x.expected !== undefined ? String(x.expected) : '',
      actual: x && x.actual !== undefined ? String(x.actual) : '',
    })),
    events: Number(v.events) || 0,
    chainBroken: Number(v.chainBroken) || 0,
    badLines: Number(v.badLines) || 0,
    readError: v.readError ? String(v.readError) : '',
    reason: v.reason ? String(v.reason) : '',
    // ★ re3 透传（只读、可观察；旧调用方不读也不受影响）
    journalExists: v.journalExists === true,
    tornTailRepairable: v.tornTailRepairable === true,
    stateSealedCount: Number(v.stateSealedCount) || 0,
    stateOnlyKeys: Array.isArray(v.stateOnlyKeys) ? v.stateOnlyKeys.map((k) => ({ kind: String((k && k.kind) || ''), key: String((k && k.key) || '') })) : [],
  };
}

/** sha256(文件字节)：只读，用于收据链校验与只读性断言。 */
function fileSha256(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
}

/** 静默读 JSON 文件；失败返回 null（不抛错，由调用方计入 breaks）。 */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 递归列出 root 下（深度受限）所有第 3 级档案文件。
 *
 * @param {string} root
 * @param {number} [maxDepth=4]
 * @returns {Array<{file:string, code:string, kind:'view'|'attachment', version:number}>}
 *
 * @why 深度限制 + 跳过 `ledger/`：root 里还有台账、锚目录（若误配）与交接表；
 *      无界递归会在用户把插件根目录指到家目录时扫穿磁盘。
 */
export function listArchiveFiles(root, maxDepth = 4) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const walk = (dir, depth, rel) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const relP = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (e.name === 'ledger' || e.name === '.git' || e.name.startsWith('.')) continue;
        walk(p, depth + 1, relP);
        continue;
      }
      const m = ARCHIVE_FILE_RE.exec(e.name);
      if (!m) continue;
      out.push({
        file: relP,
        code: m[1],
        version: m[2] ? Number(m[2]) : 1,
        kind: m[3] === '原始事件.json' ? 'attachment' : 'view',
      });
    }
  };
  walk(root, 0, '');
  return out;
}

/**
 * 对账主函数（**纯只读**）。
 *
 * @param {{
 *   root:string, offsetMinutes?:number, receiptAnchorRoot?:string, nowMs?:number,
 *   maxDetail?:number, full?:boolean
 * }} p
 *   `full:true` 强制本次整库全量复核（v0.9.3-re1 的"每日一次全量"能力也可显式触发）；
 *   缺省时：缓存可用且距上次全量 <24h → 增量，否则全量。
 *
 * @returns {{
 *   v:number, at:string, root:string, offsetMinutes:number,
 *   mode:'incremental'|'full', verifiedRows:number, cachedRows:number, fullAt:string,
 *   ledgerRows:number, codeUnique:boolean, sidTurnUnique:boolean,
 *   ledgerOk:boolean, readErrors:Array, badLines:number,
 *   originalMissing:Array<{code:string, doc:string, part:'view'|'attachment'}>,
 *   originalOrphan:Array<{file:string, code:string}>,
 *   originalCount:number,
 *   weeklyGroupsExpected:Array<{gid:string, file:string}>,
 *   weeklyGroupsMissing:Array<{gid:string, file:string}>,
 *   lostGaps:{count:number, recordsTail:Array<object>},
 *   receiptBreaks:Array<object>, receiptBreakCount:number,
 *   receiptsChecked:boolean, receiptsNote:string,
 *   sealChain:object,
 *   ok:boolean, okStrict:boolean
 * }}
 *
 * `ok` 口径（缺一不可）：台账读全（无 readErrors/badLines）、code 唯一、(sid,turn) 唯一、
 * 无缺凭证/无孤儿凭证、周记账组文件齐、无 `.lost` 缺口、收据链无断、封板链无断。
 * 注意：`ok=false` 只代表"账实不符或被读坏"，**不代表**数据一定错 —— 要人看明细。
 *
 * ★ v1.0.0-re3（审计② P2-6）：`receiptsChecked:false` + `receiptsNote` 把"没做收据校验"写进结构；
 *   `receiptBreaks` 恒空**不是**"已验"的证据（lite 不校验收据链，见 ⑦ 段注释）。
 */
export function reconcile(p = {}) {
  const root = typeof p.root === 'string' ? p.root : '';
  const offsetMinutes = Number.isFinite(p.offsetMinutes) ? p.offsetMinutes : 480;
  const nowMs = Number.isFinite(p.nowMs) ? p.nowMs : Date.now();
  const maxDetail = Number.isInteger(p.maxDetail) && p.maxDetail > 0 ? p.maxDetail : 1000;

  const result = {
    v: RECONCILE_VERSION,
    at: stampLocal(nowMs, offsetMinutes),
    root,
    offsetMinutes,
    ledgerRows: 0,
    codeUnique: true,
    sidTurnUnique: true,
    ledgerOk: false,
    ledgerEmptyProven: false,
    readErrors: [],
    badLines: 0,
    originalMissing: [],
    // ★ v0.5.1 增补（W5 / legacy 行口径）：**"文件在、但台账没有绑定证据"单列**。
    //   契约 CH-01 规定历史 v0.4 行永不 bound；但"证明不了"≠"凭证丢了"。
    //   两者混在一起，老账库的 `ok` 会永远为 false（闸门变成常态告警）——
    //   这里按"文件是否物理存在"拆开：真的不在 → originalMissing；在但无证据 → legacyUnverifiable。
    legacyUnverifiable: [],
    legacyUnverifiableCount: 0,
    // ★ V0.6 / D18 修正（2026-11-10）：legacy 不能靠"缺字段"判定（删字段即可洗白）。
    //   只有被 `<root>/ledger/.legacy-marks.jsonl` **正面标记过、且行指纹未变**的行才算 legacy。
    //   未标记的无证据行 → 仍进 originalMissing（reason=NO_BINDING_EVIDENCE）。
    legacyMarks: {
      path: '', exists: false, ok: true, chainOk: true, badLines: 0, chainBreakAt: 0,
      count: 0, matched: 0, mismatched: 0, unmarked: 0, orphan: 0,
    },
    unmarkedNoEvidenceCount: 0,
    originalOrphan: [],
    originalCount: 0,
    weeklyGroupsExpected: [],
    weeklyGroupsMissing: [],
    lostGaps: { count: 0, total: 0, covered: 0, countNote: '', recordsTail: [] },
    receiptBreaks: [],
    receiptBreakCount: 0,
    // ★ v1.0.0-re3（审计② P2-6）：**形状诚实化** —— lite 的收据是"日结摘要"，没有链、没有哈希绑定，
    //   对账不做收据校验。`receiptBreaks` 恒空/`receiptBreakCount` 恒 0 是"没验"，不是"验过"；
    //   下面两格把这件事写进结构里，报告文案也不许再写成"收据链: 断 0"。
    receiptsChecked: false,
    receiptsNote: 'lite：收据=日结摘要，无链/无哈希绑定，对账不做收据校验（receiptBreaks 恒空 ≠ 已验）',
    sealChain: {
      ok: false, verifiable: false, lines: 0, breaks: [], events: 0, chainBroken: 0,
      badLines: 0, readError: 'no-root', reason: '',
      journalExists: false, tornTailRepairable: false, stateSealedCount: 0, stateOnlyKeys: [],
    },
    // v0.9.3-re1：对账档位与行级核验计数（增量语义可被观察；ok/okStrict 语义不变）
    mode: 'full',
    verifiedRows: 0,
    cachedRows: 0,
    fullAt: '',
    ok: false,
    okStrict: false,
  };
  if (!root) return result;

  // ①a v0.9.3-re1：本次走全量还是增量（都只读；缓存在内存）
  //   全量的触发：显式 full:true / 无缓存（进程重启/换 root）/ 距上次全量已满 24h。
  const wantFull = p.full === true;
  const cacheUsable = !!(reconcileCache &&
    reconcileCache.root === root && reconcileCache.offsetMinutes === offsetMinutes);
  const fullDue = cacheUsable && (nowMs - reconcileCache.lastFullAtMs >= FULL_RECONCILE_INTERVAL_MS);
  const mode = cacheUsable && !wantFull && !fullDue ? 'incremental' : 'full';

  // ① 台账：读不全时**仍**给出已读到的部分，但 ledgerOk=false + readErrors 原样带出
  // ★ RC-10 / 可审计：对账**只读**。
  //   撕裂尾巴自愈是"写动作"（取证 + 截断），只能发生在**摄入路径**（index.runOnce）。
  //   对账若顺手修账，就违反"前后字节不变"这条硬判据 —— 所以这里显式关掉。
  // A-10（已签）：验账路径只认真账行 —— 合法 JSON 非账行按坏行计，不许静默少算。
  const all = readAll(root, { repairTornTail: false, requireLedgerRows: true });
  result.ledgerRows = all.records.length;
  result.ledgerOk = all.ok;
  result.ledgerEmptyProven = all.emptyProven === true;
  result.readErrors = all.readErrors;
  result.badLines = all.badLines;

  // ② 主键唯一性 + 有效版本投影（D10：同 code 取 max(version)；旧行未标 version 视为 1）
  const codeSet = new Set();
  const turnSet = new Set();
  const byCode = new Map();
  for (const r of all.records) {
    if (!r || typeof r !== 'object') continue;
    const code = typeof r.code === 'string' ? r.code : '';
    if (!code) continue;
    if (codeSet.has(code)) result.codeUnique = false;
    codeSet.add(code);
    const sidTurn = `${r.sid}#${r.turn}`;
    if (turnSet.has(sidTurn)) result.sidTurnUnique = false;
    turnSet.add(sidTurn);
    const v = Number.isInteger(r.version) ? r.version : 1;
    const prev = byCode.get(code);
    if (!prev || v >= (Number.isInteger(prev.version) ? prev.version : 1)) byCode.set(code, r);
  }
  const effective = [...byCode.values()];

  // lite（S-8/P1）：legacy-marks 已冻结，lite 从新库起 → 不做"历史行正面标记"判定。
  // markedCodesSeen 仍保留（兼容字段 orphan 计算用），但不会有人往里加。
  const markedCodesSeen = new Set();

  // ③ 凭证：四态判定（绑定/补记/已清理/缺凭证）；缺 = 既不绑定、也不在清册
  // 契约 R-01：`originalMissing[].part` 三态 `{"view","attachment","both"}`，
  // **同一 code 只出 1 条**：视图+附件都缺 → "both"；只缺一 → 对应值。
  // v0.4 旧行没有 attachment 字段 → 只可能 "view"（其附件不追究）。
  let cleaned = null;
  try { cleaned = readCleanedCodesCompat(root); } catch { cleaned = null; }
  // ★ v0.9.3-re1 读放大修复：只对**新写入 / 身份或磁盘指纹变化**的行跑 resolveDoc（整文件复核）；
  //   其余行复用"上次真核过"的结论（键 = resolveDoc 的全部输入，见 resolveInputKey）；每日全量兜底。
  const prevRows = mode === 'incremental' && reconcileCache ? reconcileCache.rows : null;
  const nextRows = new Map();
  let verifiedRows = 0;
  let cachedRows = 0;
  for (const r of effective) {
    const code = String(r.code);
    const rowKey = resolveInputKey(root, r, offsetMinutes, cleaned);
    let st = prevRows ? prevRows.get(rowKey) : undefined;
    if (st) {
      cachedRows += 1; // 命中 = 复用上次全量复核的结论（**不是**"本次核过"）
    } else {
      st = resolveDoc(root, r, offsetMinutes, cleaned); // 新行/变化行：整文件全量复核
      verifiedRows += 1;
      st = snapshotResolved(st);
    }
    nextRows.set(rowKey, st);
    if (st.state === 'cleaned') continue; // 合法销毁，不算缺
    const ms = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    // ★ 2026-11-09 审计 #6：按**编码日期段**取月（与写端一致），不能按 ts 取月，
    //   否则跨月会话在这里会被展示成"另一个月的路径"。
    const mm = monthOfCode(code, ms, offsetMinutes);
    const computed = mm ? originalRelPath(mm.year, mm.month, code) : '';
    const viewRel = st.rel || (typeof r.doc === 'string' && r.doc) || computed;

    // ★ 契约 R-01 的 `part` 说的是「哪一份文件不在」，不是「校验过不过」。
    //   旧实现拿 `st.state === 'missing'` 当"视图缺"——但 `resolveDoc` 会把**附件缺失**
    //   也算进 `missing`（verifyOriginal 的 ATTACHMENT_MISSING），于是"只缺附件"永远被
    //   报成 `both`，三态退化成两态。这里拆成两个独立事实：
    //     · viewMissing = 视图文件**物理不存在**
    //     · viewBroken  = 视图文件在、但验不过（哈希/身份/附件不符）→ 仍算缺凭证
    let viewExists = false;
    try { viewExists = !!(viewRel && fs.existsSync(path.join(root, viewRel))); } catch { viewExists = false; }
    const viewMissing = !viewExists;
    const viewBroken = st.state === 'missing' && viewExists;

    let attRel = '';
    let attMissing = false;
    const att = r.attachment && typeof r.attachment === 'object' ? r.attachment : null;
    if (att && typeof att.name === 'string' && att.name) {
      attRel = viewRel ? path.join(path.dirname(viewRel), att.name) : att.name;
      try { attMissing = !fs.existsSync(path.join(root, attRel)); } catch { attMissing = false; }
    }
    if (!viewMissing && !viewBroken && !attMissing) continue;

    // lite（S-8/P1）：不做 legacy 标记判定。"视图在但验不过（含历史行缺附件证据）"一律按缺凭证计——
    // 这是保守方向：宁可多报"缺"，不把"证明不了"当作"没问题"。
    const unmarkedNoEvidence = false;

    // 三态判定（同 code 只出 1 条）：
    //   视图不在 + 附件不在 → both；视图不在 → view；视图在而附件不在 → attachment；
    //   视图在但验不过 → view（视图不可用，指向视图文件供人复核）
    let part;
    if (viewMissing) part = attMissing ? 'both' : 'view';
    else if (attMissing) part = 'attachment';
    else part = 'view';

    if (result.originalMissing.length < maxDetail) {
      result.originalMissing.push({
        code,
        doc: part === 'attachment' ? attRel : viewRel,
        part,
        ...(unmarkedNoEvidence ? { reason: 'NO_BINDING_EVIDENCE' } : {}),
      });
    }
  }
  // ①b 提交本轮行缓存快照（只在内存；不写盘 → "对账纯只读"约束不变）+ 结果标注
  let rowsForCache = nextRows;
  if (nextRows.size > RECONCILE_ROW_CACHE_MAX) {
    // 超大库：只留最近 MAX 行，避免长跑内存膨胀（只影响命中率，不影响正确性）。
    rowsForCache = new Map([...nextRows.entries()].slice(-RECONCILE_ROW_CACHE_MAX));
  }
  reconcileCache = {
    root,
    offsetMinutes,
    rows: rowsForCache,
    lastFullAtMs: mode === 'full' ? nowMs : reconcileCache.lastFullAtMs,
    lastAtMs: nowMs,
  };
  result.mode = mode;
  result.verifiedRows = verifiedRows;
  result.cachedRows = cachedRows;
  result.fullAt = stampLocal(reconcileCache.lastFullAtMs, offsetMinutes);

  result.legacyUnverifiableCount = result.legacyUnverifiable.length;
  // lite（S-8/P1）：legacy 基线不读 → 兼容字段恒 0（形状不变，面板/报告不炸）
  result.legacyMarks = {
    path: '', exists: false, ok: true, chainOk: true, badLines: 0, chainBreakAt: 0,
    count: 0, matched: 0, mismatched: 0, unmarked: 0, orphan: 0,
  };

  // ④ 孤儿凭证：第 3 级有文件、台账无对应 code（清理过的文件已被删，不会误报）
  try {
    const archives = listArchiveFiles(root);
    result.originalCount = archives.filter((a) => a.kind === 'view').length;
    for (const a of archives) {
      if (codeSet.has(a.code)) continue;
      if (result.originalOrphan.length < maxDetail) result.originalOrphan.push({ file: a.file, code: a.code });
    }
  } catch { /* 目录读不了：不阻塞对账，交给 ledgerOk/readErrors 语义之外的目录错误 */ }

  // ⑤ 周记账：应存在的组（按台账有效行复算）与缺失文件
  let groups = new Map();
  try {
    groups = groupRecords(effective, offsetMinutes);
  } catch { groups = new Map(); }
  const groupList = [];
  result.weeklyGroupsDraftOnly = result.weeklyGroupsDraftOnly || [];
  for (const [gid, g] of groups) {
    const file = path.join(weeklyFolderName(g.w), weeklyFileName(g.w, g.sessKey));
    const draft = path.join(weeklyFolderName(g.w), draftNameOf(g.w, g.sessKey));
    groupList.push({ gid, file });
    const officialExists = fs.existsSync(path.join(root, file));
    const draftExists = !officialExists && fs.existsSync(path.join(root, draft));
    if (!officialExists && !draftExists && result.weeklyGroupsMissing.length < maxDetail) {
      result.weeklyGroupsMissing.push({ gid, file });
    } else if (draftExists && result.weeklyGroupsDraftOnly.length < maxDetail) {
      // V0.7 两态：草稿存在不等于"已出周账"（对账只认正式名）；但"待封板草稿"是正常态，不记缺失、单列。
      result.weeklyGroupsDraftOnly.push({ gid, draft });
    }
  }
  groupList.sort((a, b) => (a.gid < b.gid ? -1 : 1));
  result.weeklyGroupsExpected = groupList;

  // ⑥ `.lost.jsonl` 缺口
  //
  // ★ P1-03（本机测试报告）：**gate 只计"未被后续读覆盖"的缺口**。
  //   @why 真实 DSH 持续追加写时，tick 有概率撞上"正在写的半截帧"→ 旧实现立即写一条
  //        `retryable=true` 的 truncated-tail，下一 tick 帧补全、该轮正常入账，但这条记录
  //        永远留在 .lost 里 → `gate.knownGaps` 永久 degraded、设备自检永久红。
  //        这是把"正常并发读写的噪声"当成"数据损坏"（红队故障注入 A-half 复现）。
  //   口径（写死）：一条 lost 记录若 **retryable=true** 且该源的**当前游标已越过它的全部缺失区间**
  //        （cursor.offset >= max(missing[].end)，或 >= fileSize/scanSize），即"后续读已经把它补回来了"，
  //        则**不计入 count**（但保留在 total/recordsTail 里作为留证 —— 覆盖不等于抹掉证据）。
  //   gate 的"缺口留痕"只看 count（未覆盖数）；total 供审计看到全过程。
  const lost = readLost(root);
  let cursors = {};
  try {
    const st = readStateEx(root);
    cursors = (st && st.ok && st.state && st.state.sourceCursors && typeof st.state.sourceCursors === 'object')
      ? st.state.sourceCursors : {};
  } catch { cursors = {}; }
  const cursorOffsetOf = (rec) => {
    const file = String((rec && rec.file) || '');
    if (!file) return null;
    const c = cursors[file];
    if (!c || !Number.isInteger(c.offset)) return null;
    return c.offset;
  };
  const recordCovered = (rec) => {
    if (!rec || rec.retryable !== true) return false;
    const off = cursorOffsetOf(rec);
    if (off === null) return false;
    const ends = [];
    if (Array.isArray(rec.missing)) for (const m of rec.missing) {
      if (m && Number.isInteger(m.end)) ends.push(m.end);
    }
    if (!ends.length) {
      // 没有精确缺失区间时，退化为"游标已到 EOF/扫过 scanSize"
      const size = Number.isInteger(rec.fileSize) && rec.fileSize > 0 ? rec.fileSize
        : (Number.isInteger(rec.scanSize) && rec.scanSize > 0 ? rec.scanSize : null);
      if (size === null) return false;
      return off >= size;
    }
    return off >= Math.max(...ends);
  };
  const lostRecords = Array.isArray(lost.records) ? lost.records : [];
  const covered = lostRecords.filter(recordCovered);
  result.lostGaps.total = lostRecords.length;
  result.lostGaps.covered = covered.length;
  result.lostGaps.count = lostRecords.length - covered.length;
  result.lostGaps.countNote = 'count = **未被后续读覆盖**的缺口数（P1-03）；total = 全部留痕记录数；covered = 已被后续读补回、不计入 gate 的瞬态缺口数';
  result.lostGaps.badLines = lost.badLines;
  result.lostGaps.recordsTail = lost.records.slice(-3).map((r) => ({
    at: typeof r.at === 'string' ? r.at : '',
    sid: typeof r.sid === 'string' ? r.sid : '',
    sessDir: typeof r.sessDir === 'string' ? r.sessDir : '',
    reasons: Array.isArray(r.reasons) ? r.reasons : [],
    failedFrames: Number(r.failedFrames) || 0,
    badLines: Number(r.badLines) || 0,
    missingBytes: Array.isArray(r.missing)
      ? r.missing.reduce((s, m) => s + (Number(m.bytes) || 0), 0) : 0,
  }));

  // ⑦ 收据：lite（S-1/§5.5）收据已降级为"日结摘要"，没有前日链、没有哈希绑定 →
  //   对账不再检查收据链（原第 7 项判据并入"不假绿"的重放式对账，C14–C16 已由 S-7 改写）。
  //   `checkReceiptChain` 仍导出给"只读查看历史收据"的工具用，但不再进 ok 公式。
  //   ★ v1.0.0-re3（审计② P2-6）：**形状必须诚实** —— 恒空/恒 0 只表示"没做这项校验"，
  //     不许被读成"收据链已验、断 0"。要验就调 lib/receipt.js 的 verifyReceipts（日结摘要软核对）。
  result.receiptBreaks = [];
  result.receiptBreakCount = 0;
  result.receiptsChecked = false;
  result.receiptsNote = 'lite：收据=日结摘要，无链/无哈希绑定；对账不做收据校验（receiptBreaks 恒空 ≠ 已验）。摘要软核对见 lib/receipt.js: verifyReceipts()';

  // ⑧ 封板证据（lite · S-1/K-5）：链已降级为"封板事实"。
  //   v1.0.0-re2 起 `verifySealChain()` 做**结构性**校验（坏行/重复行/重复键/时间回退/
  //   行数快照不一致/未知 kind），违规逐条进 `breaks`；`verifiable:false` 表示"没有可校验对象"，
  //   不等于"验过"，也不判红（空册 ok:true / 无 journal ok:true & verifiable:false）。
  //   ★ v1.0.0-re3（审计② P2-8）：新增语义**原样消费、不另立口径** ——
  //     · journal 被删但 state 记着已封板 / state 记着的键在 journal 里没有 → verify 判红 → `ok:false`；
  //     · `journalExists / stateSealedCount / stateOnlyKeys / tornTailRepairable` 透传（只读观察）；
  //     · 新字段**不得**造成假红：正常 journal（唯一写者 appendSealEvent 写的）仍然 ok。
  try {
    const v = verifySealChain(root);
    const violations = Array.isArray(v.violations) ? v.violations : [];
    result.sealChain = {
      ok: !!v.ok,
      verifiable: !!v.verifiable,
      reason: v.reason ? String(v.reason) : '',
      lines: Number(v.events) || 0,
      breaks: violations.map((x) => ({
        line: Number(x && x.line) || 0,
        reason: String((x && x.reason) || 'UNKNOWN'),
        expected: x && x.expected !== undefined ? String(x.expected) : '',
        actual: x && x.actual !== undefined ? String(x.actual) : '',
      })),
      events: Number(v.events) || 0,
      chainBroken: Number(v.chainBroken) || 0,
      badLines: Number(v.badLines) || 0,
      readError: v.readError ? String(v.readError) : '',
      // re3 透传（只读；消费方据此区分"没得验/证据缺失/可修撕裂尾"）
      journalExists: v.journalExists === true,
      tornTailRepairable: v.tornTailRepairable === true,
      stateSealedCount: Number(v.stateSealedCount) || 0,
      stateOnlyKeys: Array.isArray(v.stateOnlyKeys)
        ? v.stateOnlyKeys.map((k) => ({ kind: String((k && k.kind) || ''), key: String((k && k.key) || '') }))
        : [],
    };
  } catch (e) {
    result.sealChain = {
      ok: false, verifiable: false, reason: 'read-error',
      lines: 0, breaks: [{ line: 0, reason: 'READ_ERROR', expected: '', actual: e && e.message ? e.message : String(e) }],
      events: 0, chainBroken: 0, badLines: 0, readError: e && e.message ? e.message : String(e),
      journalExists: false, tornTailRepairable: false, stateSealedCount: 0, stateOnlyKeys: [],
    };
  }

  // ★ 契约 RC-01 的 ok 公式（6 项，逐字）：只回答"三数 + 缺口 + 收据链 + 封板链"是否一致。
  //   注意：**不**含 ledgerOk / codeUnique / sidTurnUnique —— 它们是另一组判据（CH-15/16、D7 身份）。
  //   需要"读全 + 唯一性也成立"的调用方用 `okStrict`（= ok 且 ledgerOk 且两个唯一性），
  //   避免把"账没读全"误当"账对了"（P1-8：空数据只能由成功读取证明）。
  //   ★ v1.0.0-re3（审计② P2-6）：公式里 `receiptBreakCount === 0` 在 lite 是**恒真项**
  //     （本版不校验收据）；保留它只为 RC-01 形状不变，**它不是"收据已验"的证据**
  //     （见 result.receiptsChecked=false / receiptsNote）。
  result.ok = result.originalMissing.length === 0 &&
    result.originalOrphan.length === 0 &&
    result.weeklyGroupsMissing.length === 0 &&
    result.lostGaps.count === 0 &&
    result.receiptBreakCount === 0 &&
    result.sealChain.ok === true;
  result.okStrict = result.ok === true &&
    result.ledgerOk === true &&
    result.codeUnique === true &&
    result.sidTurnUnique === true;
  return result;
}

/**
 * 收据链浅检（只读；锚目录为空/不存在 = 功能关闭，返回空数组）。
 *
 * @param {string} [anchorRoot]
 * @returns {Array<{date:string, reason:string, expected?:string, actual?:string}>}
 *
 * @why 为什么只做"链是否连续"：
 *      完整核验要重算每日 ledger sha256 并比对（REC-5 的 `LEDGER_CHANGED`），
 *      那是 `docs/工具-核验收据.mjs` 的职责；对账器每次都重算会拖慢主循环。
 *      这里只查：① 文件能解析；② date 与文件名一致；③ 前一日收据的 sha256 与
 *      `prevReceiptSha256` 对得上（契约 REC-2）；④ 日期不跳日。
 *      收据字段未定稿前按**宽容**口径：字段缺失只记 break，不抛错。
 */
export function checkReceiptChain(anchorRoot) {
  const breaks = [];
  if (typeof anchorRoot !== 'string' || !anchorRoot.trim()) return breaks;
  let names;
  try {
    names = fs.readdirSync(anchorRoot).filter((n) => /^RECEIPT-\d{8}\.json$/.test(n)).sort();
  } catch {
    return breaks; // 锚目录不存在/不可读：功能关闭或未部署，不算断链
  }
  let prevName = '';
  let prevSha = '';
  let prevDate = '';
  for (const n of names) {
    const date = n.slice(8, 16);
    const full = path.join(anchorRoot, n);
    const obj = readJson(full);
    if (!obj || typeof obj !== 'object') {
      breaks.push({ date, reason: 'UNPARSABLE' });
      prevName = n; prevSha = fileSha256(full); prevDate = date;
      continue;
    }
    if (typeof obj.date === 'string' && obj.date !== `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`) {
      breaks.push({ date, reason: 'DATE_MISMATCH', actual: String(obj.date) });
    }
    if (prevName) {
      const want = fileSha256(path.join(anchorRoot, prevName));
      const got = typeof obj.prevReceiptSha256 === 'string' ? obj.prevReceiptSha256 : '';
      if (!got) breaks.push({ date, reason: 'PREV_HASH_MISSING' });
      else if (want && got !== want) breaks.push({ date, reason: 'CHAIN_BREAK', expected: want, actual: got });
      // 日期跳日（中间缺一天）也报：连续两日必相接，缺日 = 有人删过收据
      if (prevDate) {
        const dPrev = Date.parse(`${prevDate.slice(0, 4)}-${prevDate.slice(4, 6)}-${prevDate.slice(6, 8)}T00:00:00Z`);
        const dCur = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
        if (Number.isFinite(dPrev) && Number.isFinite(dCur) && dCur - dPrev > 24 * 3600 * 1000) {
          breaks.push({ date, reason: 'DAY_GAP' });
        }
      }
    }
    prevName = n;
    prevSha = fileSha256(full);
    prevDate = date;
  }
  return breaks;
}

/**
 * 把对账结果渲染成一段可读文本（给日志/工具用；只读，不写盘）。
 * @param {object} r reconcile() 的返回值
 * @returns {string}
 */
export function formatReconcileReport(r) {
  if (!r || typeof r !== 'object') return '对账: 无结果';
  const lines = [];
  lines.push(`对账 ${r.at || ''}｜root=${r.root || ''}｜${r.ok ? 'OK' : 'FAIL'}`);
  lines.push(`台账: ${r.ledgerRows} 行｜code唯一=${r.codeUnique}｜(sid,turn)唯一=${r.sidTurnUnique}｜读全=${r.ledgerOk}` +
    (r.readErrors && r.readErrors.length ? `｜readErrors=${r.readErrors.length}` : '') +
    (r.badLines ? `｜坏行=${r.badLines}` : ''));
  lines.push(`凭证: 实存 ${r.originalCount} 份｜缺 ${r.originalMissing.length}｜孤儿 ${r.originalOrphan.length}` +
    // ★ v0.5.1 / D18：历史行"文件在、但没绑定证据"必须**单列显示**，
    //   不能藏在"缺凭证"里，也不能因为不压 ok 就看不见。
    (Number(r.legacyUnverifiableCount) > 0
      ? `｜历史无证据 ${r.legacyUnverifiableCount} 条（legacy，已基线标记，不计缺）`
      : '') +
    (r.legacyMarks && r.legacyMarks.unmarked > 0
      ? `｜未标记无证据 ${r.legacyMarks.unmarked} 条（按缺凭证计）` : '') +
    (r.legacyMarks && r.legacyMarks.mismatched > 0
      ? `｜基线指纹不符 ${r.legacyMarks.mismatched} 条（按缺凭证计）` : '') +
    (r.legacyMarks && r.legacyMarks.chainOk === false
      ? '｜legacy基线链断裂' : ''));
  for (const m of (r.originalMissing || []).slice(0, 5)) lines.push(`  - 缺凭证[${m.part}] ${m.code} ${m.doc}`);
  for (const m of (r.legacyUnverifiable || []).slice(0, 3)) lines.push(`  - 历史无证据 ${m.code}（${m.reason}）`);
  for (const o of (r.originalOrphan || []).slice(0, 5)) lines.push(`  - 孤儿凭证 ${o.code} ${o.file}`);
  lines.push(`周记账: 应有 ${r.weeklyGroupsExpected.length} 组｜缺 ${r.weeklyGroupsMissing.length}`);
  for (const w of (r.weeklyGroupsMissing || []).slice(0, 5)) lines.push(`  - 缺周账 ${w.gid} ${w.file}`);
  lines.push(`缺口: .lost ${r.lostGaps ? r.lostGaps.count : 0} 条` +
    (r.lostGaps && r.lostGaps.recordsTail && r.lostGaps.recordsTail.length
      ? `｜末条 ${r.lostGaps.recordsTail[r.lostGaps.recordsTail.length - 1].at}` : ''));
  // ★ v1.0.0-re3（审计② P2-6）：旧文案"收据链: 断 0"把"没做这项校验"写成"断 0"（= 验过）。
  if ((r.receiptBreaks || []).length > 0) {
    lines.push(`收据摘要: 断 ${r.receiptBreaks.length}（外部注入；lite 自身不做收据校验）`);
    for (const b of r.receiptBreaks.slice(0, 5)) lines.push(`  - 收据 ${b.date} ${b.reason}`);
  } else {
    lines.push('收据摘要: 未校验（lite · 日结摘要无链/无哈希绑定；receiptBreaks 恒空 ≠ 已验）');
  }
  const sc = r.sealChain || {};
  const sealState = sc.ok === false
    ? 'BROKEN'
    : (sc.verifiable === false ? 'OK（无可校验对象）' : 'OK（结构自洽）');
  lines.push(`封板链: ${sealState}｜事件 ${sc.events || 0}｜断链 ${sc.chainBroken || 0}｜坏行 ${sc.badLines || 0}` +
    (sc.journalExists === false ? '｜journal 不存在' : '') +
    (Number(sc.stateSealedCount) > 0 ? `｜state 记已封板 ${sc.stateSealedCount} 条` : '') +
    (sc.tornTailRepairable === true ? '｜末行撕裂（可在写路径取证+截断修复）' : '') +
    (sc.readError ? `｜读错 ${sc.readError}` : ''));
  for (const b of (sc.breaks || []).slice(0, 5)) lines.push(`  - 封板 ${b.reason}@L${b.line}`);
  return lines.join('\n');
}

/** 供外部工具复算月目录名（避免各处自己拼）。 */
export function monthDirName(year, month) {
  return `${year}年${pad2(month)}月`;
}
