/**
 * @file lib/shadow.js
 * @role V0.7 影子双轨（阶段 C）：disk 继续唯一写者；persistence 只读跑影子，产出"逐会话轮次指纹比对"。
 *
 * 设计约束（docs/交付-v0.7/01-采集换轨设计.md §九）：
 *  - I6：影子**只写运行区** `<root>/ledger/.shadow/`，绝不写 ledger/原文/周账；
 *  - I4：任何采集/比对/写盘异常都降级为 warnings，绝不向上抛（绝不影响记账 tick）；
 *  - I7：`ingest.mode='disk'` 时本模块完全不被调用（零行为变化）。
 *
 * 本文件分两层：
 *  1) 纯函数 `runShadowOnce()`：入参两个 collector，出参 records/summary/nextCursors —— 不碰磁盘，便于单测；
 *  2) 落盘 `writeShadowTick()`：只写 `.shadow/`（逐行 JSONL + summary.json），fsync 尽力而为。
 */
import fs from 'node:fs';
import path from 'node:path';

import { compareTurnSets, diffSummary, sessionKeyOf } from '../lib/collector.js';

/** 影子运行区目录名（相对 `<root>/ledger/`）。 */
export const SHADOW_DIR = '.shadow';
/** 影子记录版本（换结构必须升版本）。 */
export const SHADOW_VERSION = 1;

/**
 * 跑一轮影子比对（纯函数，不写文件、不抛异常）。
 *
 * @param {{
 *   diskCollector: object,             // createDiskCollector(...)
 *   otherCollector: object,            // createPersistenceCollector(...) / createEventCollector(...)
 *   cursors?: Map<string, object>,     // sid -> 游标（seq），跨轮复用
 *   accum?: Map<string, Map<number, object>>, // sid -> 已见闭合轮（turn -> turn），跨轮累积
 *   now?: number,
 *   pendingWindowMs?: number,          // 默认 120000（调研 V5 待标定）
 *   maxSessions?: number               // 默认 50（影子期控成本）
 * }} opts
 * @returns {{
 *   records: Array<object>,            // 每会话一条 shadowRecord（含 diff 明细）
 *   summary: object,                   // 本轮汇总（写 .shadow/summary.json）
 *   nextCursors: Map<string, object>,
 *   nextAccum: Map<string, Map<number, object>>,
 *   warnings: string[]
 * }}
 */
export async function runShadowOnce({ diskCollector, otherCollector, cursors, accum, now, pendingWindowMs = 120000, maxSessions = 50 } = {}) {
  const warnings = [];
  const nextCursors = new Map(cursors instanceof Map ? cursors : []);
  // 持久层是增量（cursor=seq），磁盘侧是全量：必须维护每会话"已见闭合轮"累积表，
  // 否则游标推进后每轮都会把历史轮算成 missingOnEvent（真机第二轮实测：57 条假差异）。
  const nextAccum = new Map(accum instanceof Map ? accum : []);
  const records = [];
  const at = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  const started = Date.now();

  if (!diskCollector || typeof diskCollector.listSessions !== 'function') {
    return { records, summary: emptySummary(at, 'DISK_COLLECTOR_UNAVAILABLE', started), nextCursors, nextAccum, warnings: ['DISK_COLLECTOR_UNAVAILABLE'] };
  }
  if (!otherCollector || typeof otherCollector.listSessions !== 'function') {
    return { records, summary: emptySummary(at, 'OTHER_COLLECTOR_UNAVAILABLE', started), nextCursors, nextAccum, warnings: ['OTHER_COLLECTOR_UNAVAILABLE'] };
  }

  let diskSessions = [];
  let otherSessions = [];
  try {
    diskSessions = (await diskCollector.listSessions()) || [];
  } catch (e) {
    warnings.push('disk-list:' + (e && e.message ? e.message : String(e)));
  }
  try {
    otherSessions = (await otherCollector.listSessions()) || [];
  } catch (e) {
    warnings.push('other-list:' + (e && e.message ? e.message : String(e)));
  }

  const otherByKey = new Map();
  for (const s of Array.isArray(otherSessions) ? otherSessions : []) {
    const key = sessionKeyOf(s);
    if (key) otherByKey.set(key, s);
  }

  const limit = Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : 50;
  let checked = 0;
  for (const diskRef of Array.isArray(diskSessions) ? diskSessions.slice(0, limit) : []) {
    const key = sessionKeyOf(diskRef);
    if (!key) continue;
    checked += 1;
    let diskBatch = null;
    try {
      diskBatch = await diskCollector.readClosedTurns(diskRef);
    } catch (e) {
      warnings.push(`disk-read:${key}:` + (e && e.message ? e.message : String(e)));
      continue;
    }
    const diskTurns = (diskBatch && diskBatch.turns) || [];
    const otherRef = otherByKey.get(key) || null;
    let otherTurns = [];
    if (otherRef) {
      const seen = nextAccum.get(key);
      const cursor = seen ? (nextCursors.get(key) || {}) : {}; // 无累积 → 从 0 全读重建（重启后首次）
      try {
        const batch = await otherCollector.readClosedTurns(otherRef, cursor);
        if (batch) {
          const merged = new Map(seen || []);
          for (const tt of Array.isArray(batch.turns) ? batch.turns : []) {
            if (tt && Number.isInteger(tt.turn)) merged.set(tt.turn, tt);
          }
          nextAccum.set(key, merged);
          otherTurns = [...merged.values()];
          if (batch.nextCursor) nextCursors.set(key, batch.nextCursor);
        }
      } catch (e) {
        warnings.push(`other-read:${key}:` + (e && e.message ? e.message : String(e)));
      }
    } else {
      warnings.push(`other-missing:${key}`);
    }
    const cmp = compareTurnSets(key, diskTurns, otherTurns, { now, pendingWindowMs });
    records.push(shadowRecordOf({ at, cmp }));
  }

  const summary = {
    v: SHADOW_VERSION,
    at,
    checked,
    maxSessions: limit,
    pendingWindowMs,
    ...diffSummary(records.map((r) => ({
      sid: r.sid,
      exactMatch: r.exactMatch,
      missingOnEvent: r.missingOnEvent,
      missingOnDisk: r.missingOnDisk,
      mismatched: r.mismatched,
      pendingDurable: r.pendingDurable,
    }))),
    warnings,
    elapsedMs: Math.max(0, Date.now() - started),
  };
  return { records, summary, nextCursors, nextAccum, warnings };
}

function emptySummary(at, reason, started) {
  return {
    v: SHADOW_VERSION,
    at,
    checked: 0,
    sessions: 0,
    exactMatch: 0,
    diffCount: 0,
    missingOnEvent: 0,
    missingOnDisk: 0,
    mismatched: 0,
    pendingDurable: 0,
    diffSessions: [],
    warnings: [reason],
    elapsedMs: Math.max(0, Date.now() - started),
  };
}

/** 把 compareTurnSets 结果整理成一行影子记录（纯）。 */
export function shadowRecordOf({ at, cmp }) {
  return {
    v: SHADOW_VERSION,
    at,
    sid: cmp.sid,
    fpVersion: 1,
    diskCount: cmp.diskCount,
    eventCount: cmp.eventCount,
    exactMatch: cmp.exactMatch,
    missingOnEvent: cmp.missingOnEvent,
    missingOnDisk: cmp.missingOnDisk,
    mismatched: cmp.mismatched,
    pendingDurable: cmp.pendingDurable,
  };
}

/** `<root>/ledger/.shadow` 目录。 */
export function shadowDirOf(root) {
  return path.join(root, 'ledger', SHADOW_DIR);
}

/**
 * 落盘一轮影子结果：**只写** `<root>/ledger/.shadow/`。
 *  - `YYYY-MM-DD.jsonl`：仅追加"有差异/有良性领先/采集告警"的会话行；两轮之间只追加不改写；
 *  - `summary.json`：最新一轮汇总（原子替换）。
 *
 * @param {string} root
 * @param {{records:Array<object>, summary:object, at?:string}} tick
 * @param {{dateStr?:string}} [opts]
 * @returns {{ok:boolean, dir:string, appended:number, summaryPath:string|null, error?:string}}
 */
export function writeShadowTick(root, tick, opts = {}) {
  const out = { ok: false, dir: shadowDirOf(root), appended: 0, summaryPath: null };
  if (!root || typeof root !== 'string') { out.error = 'NO_ROOT'; return out; }
  const records = Array.isArray(tick && tick.records) ? tick.records : [];
  const summary = tick && tick.summary && typeof tick.summary === 'object' ? tick.summary : null;
  const dateStr = typeof opts.dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateStr) ? opts.dateStr : localDateStr();
  try {
    fs.mkdirSync(out.dir, { recursive: true });
    const interesting = records.filter((r) => r && (r.exactMatch !== true || (Array.isArray(r.pendingDurable) && r.pendingDurable.length > 0)));
    if (interesting.length) {
      const file = path.join(out.dir, dateStr + '.jsonl');
      const fd = fs.openSync(file, 'a');
      try {
        for (const r of interesting) fs.writeSync(fd, JSON.stringify(r) + '\n');
        try { fs.fsyncSync(fd); } catch { /* fsync 失败不影响记录已写入 */ }
        out.appended = interesting.length;
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    if (summary) {
      const file = path.join(out.dir, 'summary.json');
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ ...summary, writtenAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      out.summaryPath = file;
      try {
        const reportPath = path.join(out.dir, 'report.md');
        const rtmp = reportPath + '.tmp-' + process.pid;
        fs.writeFileSync(rtmp, renderShadowReport({ summary, records, dateStr }), 'utf8');
        fs.renameSync(rtmp, reportPath);
        out.reportPath = reportPath;
      } catch (e) {
        out.reportError = e && e.message ? e.message : String(e);
      }
    }
    out.ok = true;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}

/** 本地日期（按 +08:00 口径；影子文件名用；失败回落到 UTC）。 */
function localDateStr(nowMs = Date.now()) {
  const d = new Date(nowMs + 480 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 渲染人读影子报表（Markdown；R-03 的"一致率/diff 明细/白名单"承载）。
 * @param {{summary:object, records?:Array<object>, dateStr?:string}} tick
 * @returns {string}
 */
export function renderShadowReport({ summary, records = [], dateStr = '' } = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const lines = [];
  lines.push('# 影子双轨报表' + (dateStr ? ' · ' + dateStr : ''));
  lines.push('');
  lines.push('> 自动生成（V0.7 shadow 模式；只写运行区，不参与记账）。R-03 口径：差异归零会话 ≥99%，其余须逐条解释。');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---:|');
  lines.push('| 运行时间 | ' + (s.at || '—') + ' |');
  lines.push('| 比对会话数 | ' + (s.checked ?? '—') + ' |');
  lines.push('| 完全一致 | ' + (s.exactMatch ?? '—') + ' |');
  lines.push('| 有差异会话 | ' + (s.diffCount ?? '—') + ' |');
  lines.push('| 缺轮（磁盘有/另一源无） | ' + (s.missingOnEvent ?? '—') + ' |');
  lines.push('| 缺轮（另一源有/磁盘无，超窗） | ' + (s.missingOnDisk ?? '—') + ' |');
  lines.push('| 同轮指纹不一致 | ' + (s.mismatched ?? '—') + ' |');
  lines.push('| 良性领先（未 flush） | ' + (s.pendingDurable ?? '—') + ' |');
  lines.push('| 耗时（ms） | ' + (s.elapsedMs ?? '—') + ' |');
  lines.push('| warnings | ' + (Array.isArray(s.warnings) && s.warnings.length ? s.warnings.length + ' 条' : '0') + ' |');
  if (Array.isArray(s.warnings) && s.warnings.length) {
    lines.push('');
    lines.push('## warnings');
    for (const w of s.warnings.slice(0, 50)) lines.push('- ' + String(w));
  }
  const diffs = (Array.isArray(records) ? records : []).filter((r) => r && r.exactMatch !== true);
  lines.push('');
  lines.push('## 差异明细（' + diffs.length + ' 会话）');
  if (!diffs.length) {
    lines.push('');
    lines.push('本轮无差异会话。');
  } else {
    lines.push('');
    lines.push('| sid | disk轮 | 另一源轮 | 缺轮(磁盘有) | 缺轮(另一源有) | 指纹不一致 | 良性领先 |');
    lines.push('|---|---:|---:|---|---|---|---|');
    for (const r of diffs.slice(0, 200)) {
      const sid = '`' + String(r.sid || '').slice(0, 48) + '`';
      lines.push('| ' + sid + ' | ' + (r.diskCount ?? '—') + ' | ' + (r.eventCount ?? '—') + ' | ' +
        JSON.stringify(r.missingOnEvent || []) + ' | ' + JSON.stringify(r.missingOnDisk || []) + ' | ' +
        JSON.stringify(r.mismatched || []) + ' | ' + JSON.stringify(r.pendingDurable || []) + ' |');
    }
  }
  lines.push('');
  return lines.join('\n');
}
