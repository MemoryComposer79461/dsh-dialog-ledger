/**
 * @file backfill.js
 * @role 补记链的**只读计划层**：24h 漏检（mtime 窗口）+ 3 天补记消费者兜底。
 * @called-by Lead 的 index.js 调度（周期性调用；本模块**不写任何东西**）
 * @depends node:fs / node:path / node:crypto、./encoder.js、./ledger.js（只读）、
 *          ./pending.js（只读）、./sealjournal.js（只读）、./legacy.js、./weekly.js（只读分组/补记册解析）
 *
 * 契约依据（v0.5 最终版，`契约-v0.5/v0.5-契约决定记录.md` v3）：
 *   · D2/D3/D4：补记=补充登记（不改文件名/主键、不加 `-B`）；24h 漏检；3 天补记消费者。
 *   · D9：坏 sid / 缺 head / 坏帧 → errors（`{source,kind,detail,fingerprint}`），
 *         fingerprint = sha256("<kind>|<source>|<sourceBytes>|<sourceMtimeMs>|<offset>")，
 *         source = 源文件**绝对路径原字符串**；计划只读，不写 `.errors.jsonl`。
 *   · D10：pending-only（`.pending.jsonl` 单文件追加；无 supersede/version）；
 *         计划必须排除仍 pending 的 `(sid,turn)`；源已闭合但 pending 仍在 → 出 `promotePending`；
 *         历史 v0.4 partial 只读、不追写 → 计划 `legacyPartials` 列出。
 *   · D12/D15：封板 journal 唯一文件 `<root>/ledger/.seal-journal.jsonl`、唯一实现 `lib/sealjournal.js`；
 *         封板后新行 = 有效版本 code − 该 gid `rows[].code` − `supplement.codes[]` − 已有补记册 codes；
 *         **禁止**用 `state.weeklySealed[gid].rows`（计数）判断；journal 缺该 gid 快照 →
 *         不补记、只报 `E_SEAL_SNAPSHOT_MISSING`（BC-10）。
 *   · D13：溢出码先进补记册（overflow-seal）→ 不得再被当"封板后遗漏"。
 *   · BC 判据：BC-03/04/05/07/08/09/10/13/15（正文见 `契约-v0.5/v0.5-验收清单.md` §4）。
 *
 * 三条硬纪律：
 *   ① **只读**：不写台账/state/档案/运行区；计划返回给 Lead，由 Lead 执行入账/补记。
 *   ② **可复算**：计划是纯 JSON；同输入（含显式 `nowMs`）两次 `JSON.stringify` 完全相等
 *      （所有数组稳定排序，不含函数/漂移时间戳）。
 *   ③ **失败不静默**：坏 sid/缺 head/坏帧进 `errors`；快照缺失等诊断进 `problems`（带 `code`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCode, normalizeSessionId } from '../lib/encoder.js';
import { readAll, readState } from '../lib/ledger.js';
import { readPending } from '../lib/pending.js';
import { readSealEvents, sealJournalPath, JOURNAL_FILE } from '../lib/sealjournal.js';
import { scanSessionSources, readSourceTurns } from '../lib/legacy.js';
import { groupRecords, parseSupplementBook, SEAL_STATE_KEY, groupId } from '../lib/weekly.js';
import { weekOf } from '../lib/week.js';
import { stampLocal } from '../freeze/handover.js';

// ============================================================================
// 一、常量
// ============================================================================

/** 计划结构版本（变了就升；Lead/对账按此判兼容）。 */
export const PLAN_VERSION = 1;

/** 24h 漏检窗口（D3：与检测频率无关，只看 mtime）。 */
export const DEFAULT_MISSING_TURN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 3 天补记消费者窗口（D4：按台账有效版本行的 `ts`；BC-07）。 */
export const DEFAULT_SUPPLEMENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** 24h 漏检补录的原因枚举（D2 `lateReason`）。 */
export const MISSING_TURN_REASON = '24h-scan';
/** 3 天补记消费者的原因枚举（D13 允许值之一）。 */
export const SUPPLEMENT_REASON = '3d-scan';

/** D12/D15 封板 journal 文件（相对 root）。 */
export const SEAL_JOURNAL_REL = path.join('ledger', JOURNAL_FILE);
/** D10 pending 证据文件（相对 root）。 */
export const PENDING_FILE_REL = path.join('ledger', '.pending.jsonl');

/** D9 错误类型枚举（本模块只产生前三种 + FRAME_FAILED）。 */
export const ERROR_KINDS = Object.freeze({
  SID_UNENCODABLE: 'SID_UNENCODABLE',
  HEAD_MISSING: 'HEAD_MISSING',
  CODE_FAILED: 'CODE_FAILED',
  FRAME_FAILED: 'FRAME_FAILED',
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// 二、小工具（确定性排序 / 错误与诊断收集 / D9 fingerprint）
// ============================================================================

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** 稳定字符串比较（不用 localeCompare：不同宿主 locale 顺序可能不同）。 */
function cmp(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** D9 标准 fingerprint：`sha256("<kind>|<source>|<sourceBytes>|<sourceMtimeMs>|<offset>")`。 */
export function errorFingerprint({ kind, source, sourceBytes, sourceMtimeMs, offset } = {}) {
  return sha256hex(
    `${str(kind)}|${str(source)}|${num(sourceBytes)}|${num(sourceMtimeMs)}|${num(offset)}`
  );
}

/** 收集一条 D9 errors（同一 fingerprint 只留一条 —— 与 `.errors.jsonl` 幂等规则同口径）。 */
function pushError(errors, { kind, source, sourceBytes, sourceMtimeMs, offset, detail }) {
  if (!Array.isArray(errors)) return null;
  const fp = errorFingerprint({ kind, source, sourceBytes, sourceMtimeMs, offset });
  if (errors.some((e) => e.fingerprint === fp)) return fp;
  errors.push({
    source: str(source),
    kind: str(kind),
    detail: str(detail),
    fingerprint: fp,
    sourceBytes: num(sourceBytes),
    sourceMtimeMs: num(sourceMtimeMs),
    offset: num(offset),
  });
  return fp;
}

/** 收集一条诊断（去重；带可选 `code` 供验收判据抓，如 E_SEAL_SNAPSHOT_MISSING）。 */
function pushProblem(problems, entry) {
  if (!Array.isArray(problems)) return;
  const e = {
    code: str(entry && entry.code),
    kind: str(entry && entry.kind),
    detail: str(entry && entry.detail),
  };
  if (entry && entry.path) e.path = str(entry.path);
  if (entry && entry.sid) e.sid = str(entry.sid);
  if (entry && entry.gid) e.gid = str(entry.gid);
  const key = `${e.code}|${e.kind}|${e.path}|${e.sid}|${e.gid}|${e.detail}`;
  if (problems.some((p) => `${p.code}|${p.kind}|${p.path || ''}|${p.sid || ''}|${p.gid || ''}|${p.detail}` === key)) return;
  problems.push(e);
}

function sortProblems(problems) {
  return problems.slice().sort((a, b) =>
    cmp(a.kind, b.kind) || cmp(a.code, b.code) || cmp(a.path, b.path) ||
    cmp(a.sid, b.sid) || cmp(a.gid, b.gid) || cmp(a.detail, b.detail));
}
function sortErrors(errors) {
  return errors.slice().sort((a, b) => cmp(a.fingerprint, b.fingerprint));
}

/** 会话目录项 → 完整 sid（`session-xxx`）；取不到返回空串。 */
function sidOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.sid === 'string' && entry.sid) return entry.sid;
  if (typeof entry.dir === 'string' && entry.dir) return path.basename(entry.dir);
  const p = str(entry.path);
  return p ? path.basename(path.dirname(p)) : '';
}

/** 读轮次（按 entry 缓存；失败进 errors/problems，不抛）。 */
function readTurnsCached(entry, readTurns, maxBytes, cache, problems, errors) {
  const key = str(entry && entry.path) || String(cache.size);
  if (cache.has(key)) return cache.get(key);
  let r = null;
  const p = str(entry && entry.path);
  const sid = sidOfEntry(entry);
  try {
    const opts = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? { maxBytes: Number(maxBytes) } : {};
    r = readTurns(entry, opts);
  } catch (e) {
    pushError(errors, {
      kind: ERROR_KINDS.FRAME_FAILED, source: p,
      sourceBytes: entry && entry.size, sourceMtimeMs: entry && entry.mtimeMs, offset: 0,
      detail: `读轮次抛错：${e && e.message}`,
    });
    pushProblem(problems, { kind: 'read-error', path: p, sid, detail: String(e && e.message) });
    r = null;
  }
  cache.set(key, r);
  return r;
}

// ============================================================================
// 三、24h 漏检扫描：最近 window 内有变动的会话源（只读；BC-03）
// ============================================================================

/**
 * 扫"最近 windowMs 内有变动"的会话源（BC-03：mtime ∈ [now-windowMs, now]）。
 *
 * @param {string} sessionsBase 形如 `<DSH_HOME>/sessions`
 * @param {{windowMs?:number, maxBytes?:number, filter?:Function, nowMs?:number,
 *          maxDepth?:number, problems?:Array, stats?:object}} [opts]
 * @returns {Array<object>} scanSessionSources 的 supported 条目（按 path 稳定升序）
 *
 * @why `maxBytes`：单源字节上限；超过 → 跳过并记 problem（too-large），**不读**它
 *      （资源纪律：内存 0.7 GB 约束下不得把大文件搬进内存）。
 * @why `nowMs`：显式"现在"；要可复算（同输入同 JSON）必须传。
 */
export function scanRecentlyChanged(sessionsBase, {
  windowMs = DEFAULT_MISSING_TURN_WINDOW_MS,
  maxBytes, filter, nowMs, maxDepth, problems, stats,
} = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Number(windowMs) : DEFAULT_MISSING_TURN_WINDOW_MS;
  const cutoffMs = now - win;
  const out = [];
  const meta = { sessionsBase: str(sessionsBase), windowMs: win, cutoffMs, nowMs: now, total: 0, matched: 0, bySource: { v4: 0, v3: 0 } };

  if (typeof sessionsBase !== 'string' || sessionsBase.length === 0) {
    pushProblem(problems, { kind: 'no-sessions-base', detail: 'sessionsBase 为空，无法扫描' });
    if (stats && typeof stats === 'object') Object.assign(stats, meta);
    return out;
  }
  let scanned;
  try {
    scanned = scanSessionSources(sessionsBase, Number.isInteger(maxDepth) ? { maxDepth } : {});
  } catch (e) {
    pushProblem(problems, { kind: 'scan-error', path: sessionsBase, detail: `scanSessionSources 抛错：${e && e.message}` });
    if (stats && typeof stats === 'object') Object.assign(stats, meta);
    return out;
  }
  const supported = Array.isArray(scanned && scanned.supported) ? scanned.supported : [];
  meta.total = supported.length;
  for (const u of Array.isArray(scanned && scanned.unsupported) ? scanned.unsupported : []) {
    pushProblem(problems, {
      kind: 'unsupported-format', path: str(u && u.path),
      detail: `会话格式 v${num(u && u.version)} 不支持（只读 v4/v3）`,
    });
  }
  for (const entry of supported) {
    if (!entry || typeof entry !== 'object') { pushProblem(problems, { kind: 'bad-entry', detail: 'entry 不是对象' }); continue; }
    const p = str(entry.path);
    const mtime = Number(entry.mtimeMs);
    if (!Number.isFinite(mtime)) { pushProblem(problems, { kind: 'bad-mtime', path: p, sid: sidOfEntry(entry) }); continue; }
    if (mtime < cutoffMs) continue;                    // 窗口外（正常：不扫）
    if (mtime > now) {                                 // 未来 mtime：时钟偏斜/篡改，不静默当"变动"
      pushProblem(problems, { kind: 'future-mtime', path: p, sid: sidOfEntry(entry), detail: `mtimeMs=${mtime} > nowMs=${now}` });
      continue;
    }
    if (Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 && Number(entry.size) > Number(maxBytes)) {
      pushProblem(problems, { kind: 'too-large', path: p, sid: sidOfEntry(entry), detail: `size=${num(entry.size)} > maxBytes=${Number(maxBytes)}` });
      continue;
    }
    if (typeof filter === 'function') {
      let keep;
      try { keep = !!filter(entry); } catch (e) {
        pushProblem(problems, { kind: 'filter-error', path: p, detail: `filter 抛错：${e && e.message}` });
        continue;
      }
      if (!keep) continue;
    }
    out.push(entry);
    if (entry.source === 'v4' || entry.version === 4) meta.bySource.v4++;
    else if (entry.source === 'v3' || entry.version === 3) meta.bySource.v3++;
  }
  out.sort((a, b) => cmp(a.path, b.path));
  meta.matched = out.length;
  if (stats && typeof stats === 'object') Object.assign(stats, meta);
  return out;
}

// ============================================================================
// 四、台账投影：已知 (sid,turn) / 历史 partial（D10 无 supersede）
// ============================================================================

/** 读台账（只读；root 为空→返回空 + problem）。 */
function loadLedgerRecords(root, problems) {
  if (typeof root !== 'string' || root.length === 0) {
    pushProblem(problems, { kind: 'no-root', detail: 'root 为空，无法读台账' });
    return { records: [], badLines: 0 };
  }
  try {
    const r = readAll(root);
    if (r.badLines > 0) pushProblem(problems, { kind: 'ledger-bad-lines', detail: `台账坏行 badLines=${r.badLines}` });
    return { records: Array.isArray(r.records) ? r.records : [], badLines: r.badLines || 0 };
  } catch (e) {
    pushProblem(problems, { kind: 'ledger-read-error', detail: `readAll 抛错：${e && e.message}` });
    return { records: [], badLines: 0 };
  }
}

/** 台账已有的 `(sid,turn)` 集合（D10：闭合闸门以台账为准；历史 partial 也算"已记过、不自动追写"）。 */
export function knownTurnsFromRecords(records) {
  const set = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.sid !== 'string' || !r.sid) continue;
    if (!Number.isInteger(r.turn)) continue;
    set.add(`${r.sid}#${r.turn}`);
  }
  return set;
}

/** 历史 v0.4 partial 行（D10 第 3 条）：只读列出（plan.legacyPartials），不追写。 */
export function legacyPartialsOf(records) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.code !== 'string' || !r.code) continue;
    const isPartial = r.status === 'partial' || r.turnState === 'open';
    if (!isPartial) continue;
    const key = `${r.code}|${r.sid || ''}|${r.turn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: r.code,
      sid: str(r.sid),
      turn: Number.isInteger(r.turn) ? r.turn : 0,
      ts: str(r.ts),
      status: str(r.status),
    });
  }
  out.sort((a, b) => cmp(a.code, b.code));
  return out;
}

// ============================================================================
// 五、D10 pending 读取与 promotePending（只读；backfill 自己不做入账）
// ============================================================================

/**
 * 读 `<root>/ledger/.pending.jsonl`（D10：单文件、追加、无 supersede）。
 *
 * @returns {Array<{sid:string,turn:number,startMs:number,firstSeenAt:string,lastSeenAt:string,
 *                  source:string,sourceSize:number,startByte:number,state:string,line:object}>}
 *          只返回 `state==='pending'` 的行；坏行/读失败进 problems。
 */
export function readPendingTurns(root, { problems, pending } = {}) {
  const out = [];
  let records;
  if (Array.isArray(pending)) {
    records = pending;
  } else {
    if (typeof root !== 'string' || root.length === 0) return out;
    const r = readPending(root);
    if (r.readError) pushProblem(problems, { kind: 'pending-read-error', detail: r.readError });
    if (r.badLines > 0) pushProblem(problems, { kind: 'pending-bad-lines', detail: `pending 坏行=${r.badLines}` });
    records = Array.isArray(r.records) ? r.records : [];
  }
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.state !== 'pending') continue;
    if (typeof rec.sid !== 'string' || !rec.sid || !Number.isInteger(rec.turn)) {
      pushProblem(problems, { kind: 'pending-bad-shape', detail: '缺 state/sid/turn' });
      continue;
    }
    out.push({
      sid: rec.sid,
      turn: rec.turn,
      startMs: num(rec.startMs),
      firstSeenAt: str(rec.firstSeenAt),
      lastSeenAt: str(rec.lastSeenAt),
      source: str(rec.source),
      sourceSize: num(rec.sourceSize),
      startByte: num(rec.startByte),
      state: 'pending',
      line: rec,
    });
  }
  out.sort((a, b) => cmp(a.sid, b.sid) || (a.turn - b.turn));
  return out;
}

/**
 * pending 提升计划（D10）：pending 仍在 + 源已闭合 + 台账尚无该 (sid,turn) 的已闭合行
 * → `promotePending`（由 Lead 入账路径执行：写原文/台账、保留 pending 历史行）。
 * **本函数只读**。
 */
export function findPendingPromotions({
  root, entries, readTurns, pending, maxBytes, knownTurns, records, problems, errors,
} = {}) {
  const out = [];
  const pend = Array.isArray(pending) ? pending : readPendingTurns(root, { problems });
  if (pend.length === 0) return out;
  const read = typeof readTurns === 'function' ? readTurns : readSourceTurns;
  let known;
  if (typeof knownTurns === 'function') known = (sid, turn) => !!knownTurns(sid, turn);
  else if (knownTurns instanceof Set || knownTurns instanceof Map) {
    const set = knownTurns instanceof Map ? new Set([...knownTurns.keys()].map(String)) : knownTurns;
    known = (sid, turn) => set.has(`${sid}#${turn}`);
  } else if (Array.isArray(knownTurns)) {
    const set = new Set(knownTurns.map(String));
    known = (sid, turn) => set.has(`${sid}#${turn}`);
  } else {
    const recs = Array.isArray(records) ? records : loadLedgerRecords(root, problems).records;
    const set = knownTurnsFromRecords(recs);
    known = (sid, turn) => set.has(`${sid}#${turn}`);
  }
  const bySid = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sid = sidOfEntry(entry);
    if (sid) bySid.set(sid, entry);
  }
  const cache = new Map();
  for (const pd of pend) {
    if (known(pd.sid, pd.turn)) continue;      // 台账已有 → 已提升，不再报
    const entry = bySid.get(pd.sid);
    if (!entry) {
      pushProblem(problems, { kind: 'pending-entry-not-scanned', sid: pd.sid, detail: `pending turn=${pd.turn} 的源不在本次扫描结果里` });
      continue;
    }
    const r = readTurnsCached(entry, read, maxBytes, cache, problems, errors);
    if (!r || r.formatError) continue;
    const closed = Array.isArray(r.closed) ? r.closed : [];
    if (!closed.some((t) => t && t.turn === pd.turn)) continue;
    out.push({
      sid: pd.sid,
      turn: pd.turn,
      path: str(entry.path),
      reason: 'source-closed',
      pending: { source: pd.source, sourceSize: pd.sourceSize, startByte: pd.startByte, startMs: pd.startMs },
    });
  }
  out.sort((a, b) => cmp(a.sid, b.sid) || (a.turn - b.turn));
  return out;
}

// ============================================================================
// 六、24h 漏检：对比台账已有 (sid,turn)，找缺失闭合轮（只读；BC-04/BC-05）
// ============================================================================

/**
 * 找"源已闭合、台账未记"的轮次（BC-04）。
 *
 * known 判定：`knownTurns` 支持 Set/Map/数组（元素 `"<sid>#<turn>"`）或谓词；
 * 缺省从 `root` 台账推导（**任何行都算已记过**：D10 历史 partial 只读、不自动追写）。
 * pending 的 `(sid,turn)` 一律排除（D10，交给 promotePending）。
 *
 * @returns {Array<{sid:string,s12:string,path:string,version:number,source:string,
 *   turns:Array<{turn:number,startMs:number,endMs:number,reason:string}>,
 *   reason:'24h-scan',degraded:boolean}>}
 */
export function findMissingTurns({
  root, entries, readTurns, knownTurns, records, pending, maxBytes, problems, errors,
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const read = typeof readTurns === 'function' ? readTurns : readSourceTurns;
  const ledgerRecords = Array.isArray(records)
    ? records
    : (typeof root === 'string' && root.length > 0 ? loadLedgerRecords(root, problems).records : null);

  let hasKnown;
  if (typeof knownTurns === 'function') {
    hasKnown = (sid, turn) => !!knownTurns(sid, turn);
  } else if (knownTurns instanceof Set || knownTurns instanceof Map) {
    const set = knownTurns instanceof Map ? new Set([...knownTurns.keys()].map(String)) : knownTurns;
    hasKnown = (sid, turn) => set.has(`${sid}#${turn}`);
  } else if (Array.isArray(knownTurns)) {
    const set = new Set(knownTurns.map(String));
    hasKnown = (sid, turn) => set.has(`${sid}#${turn}`);
  } else if (ledgerRecords) {
    const set = knownTurnsFromRecords(ledgerRecords);
    hasKnown = (sid, turn) => set.has(`${sid}#${turn}`);
  } else {
    pushProblem(problems, { kind: 'known-turns-unavailable', detail: '既没有 knownTurns 也没有可读台账；为避免重复补录，本次不产计划' });
    return [];
  }

  const pend = Array.isArray(pending) ? pending : readPendingTurns(root, { problems });
  const pendingSet = new Set(pend.map((p) => `${p.sid}#${p.turn}`));

  const out = [];
  const seenSid = new Set();
  const cache = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') { pushProblem(problems, { kind: 'bad-entry', detail: 'entry 不是对象' }); continue; }
    const p = str(entry.path);
    const rawSid = sidOfEntry(entry);
    const s12 = normalizeSessionId(rawSid);
    // D9 SID_UNENCODABLE：无 sid / 归一化后不足 12 位 / 非法字符。
    if (!rawSid.startsWith('session-') || !s12 || s12.length !== 12) {
      pushError(errors, {
        kind: ERROR_KINDS.SID_UNENCODABLE, source: p,
        sourceBytes: entry.size, sourceMtimeMs: entry.mtimeMs, offset: 0,
        detail: `sid=${JSON.stringify(rawSid)} 无法归一成 12 位短 ID（D9：必须留痕，不得静默跳过）`,
      });
      pushProblem(problems, { kind: 'bad-sid', path: p, sid: rawSid, detail: 'sid 无法编码' });
      continue;
    }
    if (seenSid.has(rawSid)) {
      pushProblem(problems, { kind: 'duplicate-sid', path: p, sid: rawSid, detail: '同一 sid 出现多个源，已跳过后者' });
      continue;
    }
    seenSid.add(rawSid);

    const r = readTurnsCached(entry, read, maxBytes, cache, problems, errors);
    if (!r || typeof r !== 'object') continue;
    if (r.formatError) {
      const fe = String(r.formatError);
      const kind = /head/i.test(fe) ? ERROR_KINDS.HEAD_MISSING : ERROR_KINDS.FRAME_FAILED;
      pushError(errors, { kind, source: p, sourceBytes: entry.size, sourceMtimeMs: entry.mtimeMs, offset: 0, detail: `formatError=${fe}` });
      pushProblem(problems, { kind: 'format-rejected', path: p, sid: rawSid, detail: fe });
      continue;
    }
    // D9 HEAD_MISSING：缺会话头 / 缺 createdAt（无法定编码日期段）。
    const head = r.head && typeof r.head === 'object' ? r.head : null;
    if (!head) {
      pushError(errors, { kind: ERROR_KINDS.HEAD_MISSING, source: p, sourceBytes: entry.size, sourceMtimeMs: entry.mtimeMs, offset: 0, detail: '缺会话头（无法定编码日期段）' });
      pushProblem(problems, { kind: 'head-missing', path: p, sid: rawSid });
      continue;
    }
    if (!Number.isFinite(Number(head.createdAt))) {
      pushError(errors, { kind: ERROR_KINDS.HEAD_MISSING, source: p, sourceBytes: entry.size, sourceMtimeMs: entry.mtimeMs, offset: 0, detail: `createdAt 非法：${JSON.stringify(head.createdAt)}` });
      pushProblem(problems, { kind: 'createdat-missing', path: p, sid: rawSid });
      continue;
    }
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    const failed = num(meta.failed);
    const badLines = num(meta.badLines);
    if (failed > 0 || badLines > 0) {
      pushError(errors, {
        kind: ERROR_KINDS.FRAME_FAILED, source: p, sourceBytes: entry.size,
        sourceMtimeMs: entry.mtimeMs, offset: 0,
        detail: `failedFrames=${failed} badLines=${badLines}（可读部分仍参与比对；缺口见 .lost.jsonl）`,
      });
      pushProblem(problems, { kind: 'bad-session', path: p, sid: rawSid, detail: `failedFrames=${failed} badLines=${badLines}` });
    }
    if (meta.stopped) pushProblem(problems, { kind: 'read-stopped', path: p, sid: rawSid, detail: '读取被字节预算截断，轮次可能不全' });

    const turns = [];
    for (const t of Array.isArray(r.closed) ? r.closed : []) {
      if (!t || !Number.isInteger(t.turn)) continue;
      const key = `${rawSid}#${t.turn}`;
      if (hasKnown(rawSid, t.turn)) continue;
      if (pendingSet.has(key)) continue;            // D10：pending 不算缺失
      turns.push({ turn: t.turn, startMs: num(t.startMs), endMs: num(t.endMs), reason: str(t.reason) });
    }
    if (turns.length === 0) continue;
    turns.sort((a, b) => a.turn - b.turn);
    out.push({
      sid: rawSid,
      s12,
      path: p,
      version: num(entry.version),
      source: str(entry.source),
      turns,
      reason: MISSING_TURN_REASON,
      degraded: failed > 0 || badLines > 0 || meta.stopped === true,
    });
  }
  out.sort((a, b) => cmp(a.sid, b.sid) || cmp(a.path, b.path));
  return out;
}

// ============================================================================
// 七、3 天补记消费者：已封板组里"封板后才写入台账"的有效行（D4/D12/D13；BC-07/08/09/10）
// ============================================================================

/** 从 seal 快照行 `rows` 抽 code：支持 `["<code>",…]` / 对象 `{code}` / 字符串。 */
function codeOfSealRow(row) {
  if (typeof row === 'string') return parseCode(row) ? row : '';
  if (Array.isArray(row)) {
    for (const c of row) if (typeof c === 'string' && parseCode(c)) return c;
    return '';
  }
  if (row && typeof row === 'object') {
    for (const k of ['code', '编码', 'CODE']) {
      if (typeof row[k] === 'string' && parseCode(row[k])) return row[k];
    }
  }
  return '';
}

/** 从 journal 事件里抽 seal.rows 的 code 数组（D12 `rows`；没有返回 []）。 */
export function sealRowCodesOf(event) {
  if (!event || typeof event !== 'object' || !Array.isArray(event.rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of event.rows) {
    const code = codeOfSealRow(row);
    if (code && !seen.has(code)) { seen.add(code); out.push(code); }
  }
  out.sort(cmp);
  return out;
}

/** 补记册里的 code（BC-08 幂等：已在补记册的 code 不再计划）。 */
function readSupplementedCodes(root, problems) {
  const set = new Set();
  if (typeof root !== 'string' || root.length === 0) return set;
  let names = [];
  try {
    names = fs.readdirSync(root).filter((n) => /^补记-\d{8}(?:-\d+)?\.md$/.test(n)).sort();
  } catch { return set; }
  for (const name of names) {
    try {
      const parsed = parseSupplementBook(fs.readFileSync(path.join(root, name), 'utf8'));
      for (const e of Array.isArray(parsed && parsed.entries) ? parsed.entries : []) {
        if (e && typeof e.code === 'string' && parseCode(e.code)) set.add(e.code);
      }
    } catch (e) {
      pushProblem(problems, { kind: 'supplement-book-bad', path: path.join(root, name), detail: String(e && e.message) });
    }
  }
  return set;
}

/** 归一化"周封板证据集合"：`{[gid]:event}` 或 `latestSealEvents(root).weekly`。 */
function normalizeSealMap(seals) {
  if (!seals || typeof seals !== 'object') return {};
  if (seals.weekly && typeof seals.weekly === 'object') return seals.weekly;
  const out = {};
  for (const k of Object.keys(seals)) {
    const v = seals[k];
    if (v && typeof v === 'object') out[k] = v;
  }
  return out;
}

/**
 * 默认周封板证据读取（**只读**；唯一来源 = `lib/sealjournal.js` 的 journal）。
 *
 * @returns {{seals:object, journal:{exists:boolean,events:number,badLines:number,readError:string,chainBroken:number}}}
 *          `seals[gid]` = 该 gid 最新一条 `kind:'weekly-seal'` journal 事件（含 `rows`）。
 *
 * @why 不读 state / 旧 `.seals.jsonl` / `ledger/seals/`：
 *      D15 已废止第二份快照与草案文件；state 只是缓存（BC-10 要单独比对，见 findPostSealRows）。
 */
export function readSealsForBackfill(root, { problems } = {}) {
  const seals = {};
  const meta = { exists: false, events: 0, badLines: 0, readError: '', chainBroken: 0 };
  if (typeof root !== 'string' || root.length === 0) {
    pushProblem(problems, { kind: 'no-root', detail: 'root 为空，无法读封板 journal' });
    return { seals, journal: meta };
  }
  let r;
  try {
    r = readSealEvents(root);
  } catch (e) {
    pushProblem(problems, { kind: 'seal-journal-read-error', detail: String(e && e.message) });
    return { seals, journal: meta };
  }
  meta.exists = r.events.length > 0 || !r.readError;
  meta.events = r.events.length;
  meta.badLines = num(r.badLines);
  meta.readError = str(r.readError);
  meta.chainBroken = num(r.chainBroken);
  if (r.readError) pushProblem(problems, { kind: 'seal-journal-read-error', detail: r.readError });
  if (r.badLines > 0) pushProblem(problems, { kind: 'seal-journal-bad-lines', detail: `封板 journal 坏行=${r.badLines}` });
  if (r.chainBroken > 0) pushProblem(problems, { kind: 'seal-journal-chain-broken', detail: `封板 journal 断链=${r.chainBroken}` });
  for (const ev of r.events) {
    if (!ev || typeof ev !== 'object' || ev.kind !== 'weekly-seal') continue;
    const gid = str(ev.gid || ev.key);
    if (!gid) continue;
    seals[gid] = ev;      // journal 同 key 唯一；若出现多条，后写覆盖（旧实现兼容）
  }
  return { seals, journal: meta };
}

/**
 * 已封板组里"封板后才写入台账"的**有效行**（BC-07/08/09/10）。
 *
 * 判定（契约 D4/D12/D15，不得改）：
 *   封板后新行 = 该组 code
 *                − journal 该 gid 的 `rows[].code`
 *                − `supplement.codes[]`（D13 溢出先补记）
 *                − 已有补记册 codes（BC-08 幂等）
 *   **禁止**用 `state.weeklySealed[gid].rows`（计数）判断；state 有封板但 journal 无快照 →
 *   不补记、只报 `E_SEAL_SNAPSHOT_MISSING`（BC-10）。不封板的组一律不产计划（走草稿重生成）。
 *
 * @param {object} p
 * @param {string} p.root
 * @param {object} [p.seals] 周封板证据（`latestSealEvents(root).weekly` 或 `{[gid]:event}`）
 * @param {object[]} [p.records] 台账行（缺省从 root 读）
 * @param {Function} [p.readSeals] 封板证据读取器（Lead 注入；缺省内部只读 journal）
 * @param {number} [p.offsetMinutes=480]
 * @param {number} [p.windowMs=72h] BC-07 窗口（台账行 `ts ∈ [now-windowMs, now]`）
 * @param {number} [p.nowMs] 显式"现在"（可复算必须传）
 * @param {object} [p.stats] 出参：`{sealedGroups, journalEvents, skippedNoSnapshot, skippedStateOnly}`
 * @returns {Array<{gid:string,sessKey:string,week:object,seal:object,basis:'journal-rows',
 *   rows:object[],outOfWindow:object[]}>}
 */
export function findPostSealRows({
  root, seals, records, readSeals, offsetMinutes = 480,
  windowMs = DEFAULT_SUPPLEMENT_WINDOW_MS, nowMs, problems, errors, stats,
} = {}) {
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 480;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Number(windowMs) : DEFAULT_SUPPLEMENT_WINDOW_MS;
  const fromMs = now - win;
  const st = stats && typeof stats === 'object' ? stats : {};

  let recs = records;
  if (!Array.isArray(recs)) recs = loadLedgerRecords(root, problems).records;

  let sealMap;
  if (seals !== undefined && seals !== null) {
    sealMap = normalizeSealMap(seals);
    st.journalEvents = Object.keys(sealMap).length;
  } else if (typeof readSeals === 'function') {
    try {
      sealMap = normalizeSealMap(readSeals());
    } catch (e) {
      pushProblem(problems, { kind: 'read-seals-error', detail: String(e && e.message) });
      sealMap = {};
    }
    st.journalEvents = Object.keys(sealMap).length;
  } else {
    const loaded = readSealsForBackfill(root, { problems });
    sealMap = loaded.seals;
    st.journalEvents = loaded.journal.events;
    pushProblem(problems, {
      kind: 'seals-default-loader', code: 'SEALS_DEFAULT_LOADER',
      detail: '未注入 readSeals/seals：已用 lib/sealjournal.js 只读兜底；生产应由 Lead 传 latestSealEvents(root).weekly',
    });
  }
  st.sealedGroups = Object.keys(sealMap).length;

  // BC-10：state 有封板、journal 无该 gid 快照 → 只报不补。
  if (typeof root === 'string' && root.length > 0) {
    let stateSeals = null;
    try {
      const s = readState(root);
      const v = s && s[SEAL_STATE_KEY];
      if (v && typeof v === 'object') stateSeals = v;
    } catch { stateSeals = null; }
    if (stateSeals) {
      st.skippedStateOnly = 0;
      for (const gid of Object.keys(stateSeals).sort(cmp)) {
        if (sealMap[gid]) continue;
        st.skippedStateOnly++;
        pushProblem(problems, {
          kind: 'seal-snapshot-missing', code: 'E_SEAL_SNAPSHOT_MISSING', gid,
          detail: 'state 有封板但封板 journal 无该 gid 快照；BC-10：不写补记、只告警',
        });
      }
    }
  }

  const groups = groupRecords(recs, offset);
  const supplemented = readSupplementedCodes(root, problems);
  const out = [];
  const gidList = Object.keys(sealMap).filter((g) => g && typeof g === 'string').sort(cmp);
  for (const gid of gidList) {
    const ev = sealMap[gid];
    if (!ev || typeof ev !== 'object') continue;
    const sealHash = str(ev.sealHash);
    const sealedAt = str(ev.sealedAt);
    if (!sealHash && !sealedAt) continue;                 // 不是有效封板证据
    const rowCodes = sealRowCodesOf(ev);
    if (rowCodes.length === 0) {
      // BC-10：无可信 rows 快照 → 保守只报，绝不按计数猜"封板后行"
      st.skippedNoSnapshot = num(st.skippedNoSnapshot) + 1;
      pushProblem(problems, {
        kind: 'seal-snapshot-missing', code: 'E_SEAL_SNAPSHOT_MISSING', gid,
        detail: '封板证据缺少 rows[].code 快照；BC-10：本组不产补记计划（禁止用 state.rows 计数猜）',
      });
      continue;
    }
    const g = groups.get(gid);
    if (!g) continue;                                     // 未封板组/无有效行：不产计划
    const excluded = new Set(rowCodes);
    const suppCodes = ev.supplement && Array.isArray(ev.supplement.codes) ? ev.supplement.codes : [];
    for (const c of suppCodes) if (typeof c === 'string' && parseCode(c)) excluded.add(c);
    for (const c of supplemented) excluded.add(c);

    const inWindow = [];
    const outWindow = [];
    const seen = new Set();
    for (const rec of g.records) {
      if (!rec || typeof rec.code !== 'string' || !parseCode(rec.code)) continue;
      if (excluded.has(rec.code) || seen.has(rec.code)) continue;
      seen.add(rec.code);
      const ms = Date.parse(str(rec.ts));
      const base = {
        code: rec.code,
        ts: str(rec.ts),
        turn: Number.isInteger(rec.turn) ? rec.turn : 0,
        seq: Number.isInteger(rec.seq) ? rec.seq : 0,
        status: str(rec.status),
        late: rec.late === true,
        lateReason: str(rec.lateReason),
      };
      if (!Number.isFinite(ms)) {
        pushProblem(problems, { kind: 'bad-ts', gid, detail: `code=${rec.code} ts=${JSON.stringify(rec.ts)} 无法解析；已列 outOfWindow` });
        outWindow.push({ ...base, reason: 'bad-ts' });
        continue;
      }
      if (ms >= fromMs && ms <= now) inWindow.push(base);
      else outWindow.push({ ...base, reason: 'ts-out-of-window' });
    }
    if (inWindow.length === 0 && outWindow.length === 0) continue;
    inWindow.sort((a, b) => cmp(a.code, b.code));
    outWindow.sort((a, b) => cmp(a.code, b.code));
    out.push({
      gid,
      sessKey: str(g.sessKey),
      week: {
        year: num(g.w && g.w.year), month: num(g.w && g.w.month),
        weekNo: num(g.w && g.w.weekNo),
        startMs: num(g.w && g.w.startMs), endMs: num(g.w && g.w.endMs),
      },
      seal: {
        sealedAt,
        sealHash,
        file: str(ev.file),
        layoutVersion: num(ev.layoutVersion, 0),
        canonicalVersion: num(ev.canonicalVersion, 0),
        sourceRowCount: num(ev.sourceRowCount, 0),
        overflow: num(ev.overflow, 0),
        rowCount: rowCodes.length,
      },
      basis: 'journal-rows',
      rows: inWindow,
      outOfWindow: outWindow,
    });
  }
  out.sort((a, b) => cmp(a.gid, b.gid));
  return out;
}

// ============================================================================
// 八、总计划：backfillPlan（只读、可 JSON 序列化、同输入两次输出完全相等；BC-05/08/15）
// ============================================================================

/**
 * 生成补记链的**只读计划**（Lead 据此调既有入账/补记路径；本函数不写任何东西）。
 *
 * @param {object} p 见各子函数；关键：
 *   `root`、`sessionsBase`（或直接 `entries`）、`readTurns`、`knownTurns`、`records`、
 *   `seals`/`readSeals`、`pending`、`windowMs=24h`、`supplementWindowMs=72h`、
 *   `maxBytes`、`filter`、`maxDepth`、`nowMs`（**可复算必须传**）、`offsetMinutes=480`
 * @returns {object} 纯 JSON 计划：
 *   `{v, kind:'backfill-plan', generatedAt, nowMs, offsetMinutes, windows,
 *     source:{...}, missingTurns, promotePending, legacyPartials, postSealRows,
 *     outOfWindow, actions, problems, errors, stats,
 *     report:{scanned24h,late24h,scanned3d,supplements,outOfWindow,skipped,errors}}`
 *   · `report` 字段名对齐 BC-15（run-report `backfill` 段），Lead 可直接抄进运行报告。
 */
export function backfillPlan({
  root, sessionsBase, entries, readTurns, knownTurns, records, seals, readSeals, pending,
  windowMs = DEFAULT_MISSING_TURN_WINDOW_MS, supplementWindowMs = DEFAULT_SUPPLEMENT_WINDOW_MS,
  maxBytes, filter, maxDepth, nowMs, offsetMinutes = 480,
} = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 480;
  const problems = [];
  const errors = [];

  // ① 24h 扫描（BC-03）
  const scanStats = { sessionsBase: str(sessionsBase), windowMs, cutoffMs: now - windowMs, nowMs: now, total: 0, matched: 0, bySource: { v4: 0, v3: 0 } };
  let usedEntries;
  if (Array.isArray(entries)) {
    usedEntries = entries.slice();
    scanStats.total = entries.length;
    scanStats.matched = entries.length;
  } else {
    usedEntries = scanRecentlyChanged(sessionsBase, {
      windowMs, maxBytes, filter, nowMs: now, maxDepth, problems, stats: scanStats,
    });
  }

  // ② 台账行（只读一次，多处复用）
  let ledgerRecords = records;
  if (!Array.isArray(ledgerRecords)) ledgerRecords = loadLedgerRecords(root, problems).records;

  // ③ pending（D10）
  const pendingList = Array.isArray(pending) ? pending : readPendingTurns(root, { problems });

  // ④ 24h 漏检 / pending 提升（BC-04）
  const missingTurns = findMissingTurns({
    root, entries: usedEntries, readTurns, knownTurns, records: ledgerRecords,
    pending: pendingList, maxBytes, problems, errors,
  });
  const promotePending = findPendingPromotions({
    root, entries: usedEntries, readTurns, records: ledgerRecords, pending: pendingList,
    maxBytes, problems, errors,
  });
  const legacyPartials = legacyPartialsOf(ledgerRecords);

  // ⑤ 3d 补记消费者（BC-07/08/09/10）
  const sealStats = {};
  const postSealRows = findPostSealRows({
    root, seals, records: ledgerRecords, readSeals, offsetMinutes: offset,
    windowMs: supplementWindowMs, nowMs: now, problems, errors, stats: sealStats,
  });

  // ⑥ 窗口外行（BC-07：必须明列）
  const outOfWindow = [];
  for (const item of postSealRows) {
    for (const r of item.outOfWindow) {
      outOfWindow.push({
        gid: item.gid, sessKey: item.sessKey, code: r.code, ts: r.ts,
        turn: r.turn, reason: r.reason || 'ts-out-of-window',
      });
    }
  }
  outOfWindow.sort((a, b) => cmp(a.gid, b.gid) || cmp(a.code, b.code));

  // ⑦ actions：只列"该做什么"，不含任何写入
  const actions = [];
  for (const m of missingTurns) {
    actions.push({
      kind: 'backfill-missing-turns', sid: m.sid, s12: m.s12, path: m.path,
      turns: m.turns.map((t) => t.turn), reason: MISSING_TURN_REASON,
    });
  }
  for (const pr of promotePending) {
    actions.push({ kind: 'promote-pending', sid: pr.sid, turn: pr.turn, path: pr.path, reason: pr.reason });
  }
  for (const item of postSealRows) {
    if (item.rows.length === 0) continue;
    actions.push({
      kind: 'write-supplement', gid: item.gid, sessKey: item.sessKey,
      codes: item.rows.map((r) => r.code), reason: SUPPLEMENT_REASON,
    });
  }
  const kindOrder = { 'backfill-missing-turns': 0, 'promote-pending': 1, 'write-supplement': 2 };
  actions.sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) ||
    cmp(a.sid, b.sid) || cmp(a.gid, b.gid) || cmp(a.path, b.path));

  const stats = {
    scanned: scanStats.total,
    considered: scanStats.matched,
    missingSessionCount: missingTurns.length,
    missingTurnCount: missingTurns.reduce((n, m) => n + m.turns.length, 0),
    promotePendingCount: promotePending.length,
    legacyPartialCount: legacyPartials.length,
    postSealGroupCount: postSealRows.length,
    postSealRowCount: postSealRows.reduce((n, x) => n + x.rows.length, 0),
    outOfWindowCount: outOfWindow.length,
    sealedGroups: num(sealStats.sealedGroups),
    sealedGroupsNoSnapshot: num(sealStats.skippedNoSnapshot),
    sealedGroupsStateOnly: num(sealStats.skippedStateOnly),
    actionCount: actions.length,
    errorCount: errors.length,
    problemCount: problems.length,
  };

  // BC-15：run-report `backfill` 段字段（Lead 直接抄；全时间 +08:00、无 Z）
  const skippedScan = problems.filter((p) => ['too-large', 'future-mtime', 'unsupported-format'].includes(p.kind)).length;
  const report = {
    scanned24h: scanStats.matched,
    late24h: stats.missingTurnCount,
    scanned3d: stats.sealedGroups,
    supplements: stats.postSealRowCount,
    outOfWindow: stats.outOfWindowCount,
    skipped: skippedScan + stats.sealedGroupsNoSnapshot + stats.sealedGroupsStateOnly,
    errors: stats.errorCount,
  };

  return {
    v: PLAN_VERSION,
    kind: 'backfill-plan',
    generatedAt: stampLocal(now, offset),
    nowMs: now,
    offsetMinutes: offset,
    windows: {
      missingTurnWindowMs: Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_MISSING_TURN_WINDOW_MS,
      supplementWindowMs: Number(supplementWindowMs) > 0 ? Number(supplementWindowMs) : DEFAULT_SUPPLEMENT_WINDOW_MS,
    },
    source: {
      provided: Array.isArray(entries),
      sessionsBase: str(sessionsBase),
      windowMs: scanStats.windowMs,
      cutoffMs: scanStats.cutoffMs,
      total: scanStats.total,
      matched: scanStats.matched,
      bySource: { v4: num(scanStats.bySource.v4), v3: num(scanStats.bySource.v3) },
    },
    missingTurns,
    promotePending,
    legacyPartials,
    postSealRows,
    outOfWindow,
    actions,
    problems: sortProblems(problems),
    errors: sortErrors(errors),
    stats,
    report,
  };
}
