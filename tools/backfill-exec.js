/**
 * @file lib/backfill-exec.js
 * @role V0.7 补记执行器（周账的**第二写入口**）：把 `backfillPlan()` 的 actions 变成可审计、幂等、可重试的执行。
 *
 * 设计：docs/交付-v0.7/03-周账两态与补记执行器设计.md §五
 *  - **证据先行**：每个动作先追加 journal 行（fsync）再执行；journal 写不进去就拒绝执行；
 *  - **幂等**：actionKey = sha256(规范化的 kind+目标)；journal 里已有 applied/deferred/gave-up/compensated → skip；
 *  - **可重试**：failed 在未达 maxAttempts 前下一轮重试；达上限记 gave-up（不再重试）；
 *  - **回退**：只撤 `planned`（未执行）；已 applied 的账行不可删——`rollbackPlanned` 明确拒绝；
 *  - 不抛异常：任何失败转成 summary.failed + journal，调用方（index/tick）不受影响。
 *
 * 本版 handler 只接 `write-supplement`（已有 writeSupplement 的只追加+幂等基础）；
 * `backfill-missing-turns` / `promote-pending` 需要重跑 ingest，本版明确记 `deferred`（handler 未接线），
 * 留痕不假执行 —— 与 05 的"执行器未接线"口径一致，等 ingest 侧改造完成后再接。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readAll } from '../lib/ledger.js';
import { writeSupplement } from '../lib/weekly.js';

/** journal 文件名（运行区，相对 `<root>/ledger/`）。 */
export const JOURNAL_NAME = '.backfill-journal.jsonl';
/** journal 记录版本。 */
export const EXEC_VERSION = 1;

export function journalPathOf(root) {
  return path.join(root, 'ledger', JOURNAL_NAME);
}

/** 稳定 JSON（键排序），用于 actionKey 与 journal 复算。 */
export function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

/** 动作目标摘要（不含大字段；用于 key 与 journal 可读性）。 */
function targetOf(action) {
  const a = action && typeof action === 'object' ? action : {};
  switch (a.kind) {
    case 'backfill-missing-turns':
      return { kind: a.kind, sid: a.sid || '', s12: a.s12 || '', turns: Array.isArray(a.turns) ? a.turns.map(Number).sort((x, y) => x - y) : [] };
    case 'promote-pending':
      return { kind: a.kind, sid: a.sid || '', turn: Number(a.turn) || 0 };
    case 'write-supplement':
      return { kind: a.kind, gid: a.gid || '', codes: Array.isArray(a.codes) ? a.codes.map(String).sort() : [] };
    default:
      return { kind: String(a.kind || 'unknown'), raw: stableJson(a) };
  }
}

/** 动作幂等键（同输入同 key；不含时间戳/顺序）。 */
export function actionKeyOf(action) {
  return crypto.createHash('sha256').update(stableJson(targetOf(action)), 'utf8').digest('hex');
}

/**
 * 读 journal（只读；坏行计数，不抛）。
 * @returns {{records:Array<object>, badLines:number, byKey:Map<string,{status:string,attempts:number}>, path:string}}
 */
export function readExecutionJournal(root) {
  const file = journalPathOf(root);
  const out = { records: [], badLines: 0, byKey: new Map(), path: file };
  if (!fs.existsSync(file)) return out;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec = null;
    try { rec = JSON.parse(line); } catch { out.badLines += 1; continue; }
    if (!rec || typeof rec !== 'object' || typeof rec.key !== 'string') { out.badLines += 1; continue; }
    out.records.push(rec);
    const prev = out.byKey.get(rec.key) || { status: '', attempts: 0 };
    prev.status = String(rec.status || prev.status);
    if (rec.status === 'failed') prev.attempts += 1;
    out.byKey.set(rec.key, prev);
  }
  return out;
}

function appendJournal(root, rec) {
  const file = journalPathOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(rec) + '\n';
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    try { fs.fsyncSync(fd); } catch { /* fsync 失败不改变“已写”事实，但 journal 可能未落盘 */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** 默认 handler：write-supplement（复用 writeSupplement 的只追加/幂等）。 */
function defaultHandlers() {
  return {
    'write-supplement': ({ action, root, offsetMinutes, now, readRecords }) => {
      const codes = Array.isArray(action.codes) ? action.codes.map(String) : [];
      if (!codes.length) return { ok: true, detail: 'no-codes' };
      const all = typeof readRecords === 'function' ? readRecords() : readAll(root).records;
      const byCode = new Map((Array.isArray(all) ? all : []).map((r) => [String(r && r.code), r]));
      const records = codes.map((c) => byCode.get(c)).filter(Boolean);
      if (!records.length) return { ok: true, detail: 'codes-not-found-in-ledger' };
      const sup = writeSupplement({
        root,
        codes: records.map((r) => r.code),
        records,
        reason: typeof action.reason === 'string' && action.reason ? action.reason : 'post-seal-scan',
        offsetMinutes,
        nowMs: now,
      });
      return { ok: true, detail: 'supplement=' + path.relative(root, sup.path) + ' entries=' + records.length };
    },
  };
}

/**
 * 执行 backfill actions（证据先行、幂等、可重试；不抛）。
 *
 * @param {{
 *   root:string, plan?:object, actions?:Array<object>, nowMs?:number, dryRun?:boolean,
 *   maxAttempts?:number, offsetMinutes?:number,
 *   handlers?:Record<string,Function>, readRecords?:Function
 * }} opts
 * @returns {{
 *   v:number, at:string, dryRun:boolean, total:number,
 *   executed:number, dupSkipped:number, failed:number, deferred:number, gaveUp:number, compensated:number,
 *   journal:string, errors:string[], details:Array<object>
 * }}
 */
export function executeBackfill(opts = {}) {
  const {
    root, plan, actions, nowMs, dryRun = false, maxAttempts = 3, offsetMinutes = 480,
    handlers: userHandlers, readRecords,
  } = opts;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const at = new Date(now).toISOString();
  const out = {
    v: EXEC_VERSION, at, dryRun: Boolean(dryRun), total: 0,
    executed: 0, dupSkipped: 0, failed: 0, deferred: 0, gaveUp: 0, compensated: 0,
    journal: root ? journalPathOf(root) : '', errors: [], details: [],
  };
  if (!root || typeof root !== 'string') { out.errors.push('NO_ROOT'); return out; }
  const list = Array.isArray(actions)
    ? actions
    : plan && Array.isArray(plan.actions) ? plan.actions : [];
  out.total = list.length;
  if (!list.length) return out;

  const handlers = { ...defaultHandlers(), ...(userHandlers && typeof userHandlers === 'object' ? userHandlers : {}) };
  let jr = null;
  if (!dryRun) {
    jr = readExecutionJournal(root);
    if (jr.badLines > 0) {
      // 证据链不完整时拒绝执行（否则可能重复记账）；交人工处置
      out.errors.push('JOURNAL_BAD_LINES=' + jr.badLines);
      return out;
    }
  }

  const attemptOf = (key) => {
    if (!jr) return { status: '', attempts: 0 };
    return jr.byKey.get(key) || { status: '', attempts: 0 };
  };
  const caps = (() => {
    const m = Number(maxAttempts);
    return Number.isFinite(m) && m > 0 ? Math.floor(m) : 3;
  })();

  for (const action of list) {
    const key = actionKeyOf(action);
    const target = targetOf(action);
    const prev = attemptOf(key);
    const detail = { key, kind: target.kind, status: '', detail: '' };

    // 幂等/终态跳过
    if (['applied', 'deferred', 'gave-up', 'compensated'].includes(prev.status)) {
      out.dupSkipped += 1;
      detail.status = 'skipped';
      detail.detail = 'journal-terminal:' + prev.status;
      out.details.push(detail);
      continue;
    }
    if (prev.status === 'failed' && prev.attempts >= caps) {
      if (!dryRun) appendJournal(root, { v: EXEC_VERSION, at, key, kind: target.kind, status: 'gave-up', attempt: prev.attempts, target, detail: 'attempts>=' + caps });
      out.gaveUp += 1;
      detail.status = 'gave-up';
      out.details.push(detail);
      continue;
    }

    const handler = handlers[target.kind];
    if (typeof handler !== 'function') {
      if (!dryRun) appendJournal(root, { v: EXEC_VERSION, at, key, kind: target.kind, status: 'deferred', attempt: 0, target, detail: 'handler-not-wired:' + target.kind + ':needs-ingest-entry' });
      out.deferred += 1;
      detail.status = 'deferred';
      detail.detail = 'handler-not-wired';
      out.details.push(detail);
      continue;
    }

    if (dryRun) {
      out.executed += 0;
      detail.status = 'would-run';
      out.details.push(detail);
      continue;
    }

    // 证据先行：先写 planned，再执行
    try {
      appendJournal(root, { v: EXEC_VERSION, at, key, kind: target.kind, status: 'planned', attempt: prev.attempts + 1, target });
    } catch (e) {
      out.errors.push('JOURNAL_WRITE_FAILED:' + String((e && e.message) || e));
      out.failed += 1;
      detail.status = 'failed';
      detail.detail = 'journal-write-failed';
      out.details.push(detail);
      return out; // 证据写不进去，后续一律不执行
    }
    try {
      const res = handler({ action, root, offsetMinutes, now, readRecords });
      const ok = !res || res.ok !== false;
      appendJournal(root, {
        v: EXEC_VERSION, at, key, kind: target.kind,
        status: ok ? 'applied' : 'failed', attempt: prev.attempts + 1, target,
        detail: ok ? String((res && res.detail) || 'ok') : String((res && res.detail) || 'handler-returned-false'),
      });
      if (ok) {
        out.executed += 1;
        detail.status = 'applied';
        detail.detail = String((res && res.detail) || 'ok');
      } else {
        out.failed += 1;
        detail.status = 'failed';
        detail.detail = String((res && res.detail) || 'handler-returned-false');
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      try { appendJournal(root, { v: EXEC_VERSION, at, key, kind: target.kind, status: 'failed', attempt: prev.attempts + 1, target, detail: msg }); } catch { /* journal 再失败也不抛 */ }
      out.failed += 1;
      detail.status = 'failed';
      detail.detail = msg;
    }
    out.details.push(detail);
  }
  return out;
}

/**
 * 回退：只允许撤 `planned`（未执行）。applied 的账行不可删——明确拒绝并计数。
 * @param {{root:string, keys?:string[], nowMs?:number}} opts  keys 省略 = journal 里所有 planned
 */
export function rollbackPlanned({ root, keys, nowMs } = {}) {
  const out = { v: EXEC_VERSION, compensated: 0, refused: 0, errors: [] };
  if (!root) { out.errors.push('NO_ROOT'); return out; }
  const jr = readExecutionJournal(root);
  if (jr.badLines > 0) { out.errors.push('JOURNAL_BAD_LINES=' + jr.badLines); return out; }
  const wanted = Array.isArray(keys) && keys.length
    ? keys.map(String)
    : [...jr.byKey.entries()].filter(([, st]) => st.status === 'planned').map(([k]) => k);
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  for (const key of wanted) {
    const st = jr.byKey.get(key);
    if (!st || st.status !== 'planned') { out.refused += 1; continue; }
    try {
      appendJournal(root, { v: EXEC_VERSION, at, key, kind: '', status: 'compensated', attempt: 0, target: null, detail: 'rollback-planned' });
      out.compensated += 1;
    } catch (e) {
      out.errors.push('JOURNAL_WRITE_FAILED:' + String((e && e.message) || e));
    }
  }
  return out;
}
