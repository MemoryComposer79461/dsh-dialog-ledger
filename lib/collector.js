/**
 * @file lib/collector.js
 * @role V0.7 采集层换轨的**适配层**：把"采集"抽象成可替换的 collector，并提供影子双轨的指纹/比对工具。
 *
 * @why 现状（v0.6.4）：采集写死在 index.js runOnceCore 里——扫磁盘会话文件（lib/legacy.js）
 *      → 逐帧解码（lib/frames.js）→ 提取闭合轮次 → KERNEL 落账。v0.7 要换到"宿主 session/event
 *      主通道 + revision 对账 + 磁盘兜底"，必须先把"采集"抽成接口，才能并行双轨、先影子后切换、
 *      一键回退（`ingest.mode=disk` 行为等价 v0.6.4）。
 *
 * 本模块**不碰 KERNEL、不写账**：disk collector 只读文件；比对工具是纯函数。
 * 影子输出（`.shadow/`）与 switch 接线由 index.js 在后续小步接入，接入前本模块对主流程零影响。
 *
 * @see docs/交付-v0.7/01-采集换轨设计.md
 */
import { createHash } from 'node:crypto';
// ★ F-11 修复（第一轮异机报告 F-11 / 第二轮复核仍未修）：normalizeSid 用了 path.dirname 却没 import。
//   该模块被 index.js 通过 createDiskCollector / createPersistenceCollector 引用，
//   一旦走到"sid 缺失、用路径退化"的分支就会抛 ReferenceError（运行期才炸，静态测试看不出）。
import path from 'node:path';

import { scanSessionSources, readSourceTurns } from './legacy.js';

/** 指纹口径版本：换算法必须升版本（影子比对与幂等证据可追溯）。 */
export const TURN_FP_VERSION = 1;

/**
 * 会话主键：优先用 sid（目录名 `session-*`）；退化时用路径（与现有台账 sid 口径一致）。
 * @param {{sid?:string, s12?:string, path?:string}} entry scanSessionSources 元素
 */
export function normalizeSid(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  const base = s.split(/[\\/]/).pop() || s;          // 路径 → 最后一段（会话目录名；调用方给目录而不是文件）
  return base.replace(/^session-/, '').toLowerCase(); // 去掉可选的 session- 前缀，统一小写
}

export function sessionKeyOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.sid || entry.sessionId || entry.s12 ||
    (typeof entry.dir === 'string' && entry.dir ? entry.dir :
      (typeof entry.path === 'string' ? path.dirname(entry.path) : ''));
  return normalizeSid(raw);
}

/**
 * 单轮指纹：只含"可复核的轮次边界"字段，不含文件路径/正文（正文另由原文系统锚定）。
 *
 * @param {string} sid 会话主键
 * @param {{turn:number,startMs:number,endMs:number,reason?:string}} t
 * @returns {string} 64 位 hex
 */
export function turnFingerprint(sid, t) {
  const reason = t && typeof t.reason === 'string' ? t.reason : '';
  const payload = [TURN_FP_VERSION, sid, t && t.turn, t && t.startMs, t && t.endMs, reason].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 磁盘采集器：包装 v0.6.4 的扫描/解码路径，行为等价（只读）。
 *
 * @param {{sessionsBase:string}} opts
 * @returns {{
 *   kind:'disk',
 *   listSessions: () => Array<object>,
 *   readClosedTurns: (entry:object, opts?:object) => {turns:Array<object>, meta:object, warnings:string[]}
 * }}
 */
export function createDiskCollector({ sessionsBase }) {
  return {
    kind: 'disk',
    /**
     * 列出会话源（与 runOnceCore 用的 scanSessionSources 同源）。
     * @returns {Array<{sid:string,s12:string,path:string,size:number,mtimeMs:number,version:number,source:string,dir?:string}>}
     */
    listSessions() {
      const scanned = scanSessionSources(sessionsBase);
      return scanned.supported.map((e) => ({
        sid: sessionKeyOf(e),
        s12: e.s12 || '',
        path: e.path,
        size: e.size,
        mtimeMs: e.mtimeMs,
        version: e.version,
        source: e.source,
        dir: e.dir,
      }));
    },
    /**
     * 读某会话的闭合轮次（只读、不写）。
     * @param {object} entry listSessions() 的元素
     * @param {object} [opts] 透传 readSourceTurns（fromByte/head 等）
     */
    readClosedTurns(entry, opts = {}) {
      const r = readSourceTurns(entry, opts);
      const warnings = [];
      if (r && typeof r.formatError === 'string' && r.formatError) warnings.push(r.formatError);
      const turns = (r && Array.isArray(r.closed) ? r.closed : []).map((t) => ({
        turn: t.turn,
        startMs: t.startMs,
        endMs: t.endMs,
        reason: typeof t.reason === 'string' ? t.reason : '',
      }));
      return { turns, meta: (r && r.meta) || {}, warnings };
    },
  };
}

/**
 * 把闭合轮次压成 `Map<turn, fingerprint>`（影子比对的最小单元）。
 *
 * @param {string} sid
 * @param {Array<{turn:number,startMs:number,endMs:number,reason?:string}>} turns
 * @returns {Map<number,string>}
 */
export function fingerprintTurns(sid, turns) {
  const map = new Map();
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !Number.isInteger(t.turn)) continue;
    map.set(t.turn, turnFingerprint(sid, t));
  }
  return map;
}

/**
 * 比对同一会话的 disk / event（或 persistence）两批闭合轮次（纯函数，不写文件）。
 *
 * ★ V0.7 三态（调研 §5.3 / §8）：事件侧常比磁盘**早**（append 后尚未 flush），
 *   这段"事件领先"是良性 pendingDurable，不应算差异（否则影子期持续假阳性）。
 *   - `missingOnEvent`：磁盘有、另一源没有 → 真差异（可能是另一源漏读/游标问题）。
 *   - `mismatched`：同轮指纹不同 → 真差异。
 *   - `pendingDurable`：另一源有、磁盘还没有，且该轮 endMs 落在 `now - pendingWindowMs` 内 → 良性领先。
 *   - `missingOnDisk`：另一源有、磁盘没有，且超出 pending 窗口 → 真差异（需解释/补齐）。
 *
 * @param {string} sid
 * @param {Array<object>} diskTurns 磁盘闭合轮次
 * @param {Array<object>} eventTurns 另一数据源闭合轮次
 * @param {{now?:number, pendingWindowMs?:number}} [opts] pendingWindowMs 默认 0（严格模式：事件多出的轮一律算差异）
 * @returns {{
 *   sid:string, diskCount:number, eventCount:number, exactMatch:boolean,
 *   missingOnEvent:number[], missingOnDisk:number[],
 *   mismatched:Array<{turn:number,disk:string,event:string}>,
 *   pendingDurable:number[]
 * }}
 */
export function compareTurnSets(sid, diskTurns, eventTurns, opts = {}) {
  const disk = fingerprintTurns(sid, diskTurns);
  const event = fingerprintTurns(sid, eventTurns);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const pendingWindowMs = Number.isFinite(opts.pendingWindowMs) && opts.pendingWindowMs > 0 ? opts.pendingWindowMs : 0;
  const endMsByTurn = new Map();
  for (const t of Array.isArray(eventTurns) ? eventTurns : []) {
    if (t && Number.isInteger(t.turn)) endMsByTurn.set(t.turn, Number.isFinite(t.endMs) ? t.endMs : 0);
  }

  const missingOnEvent = [];
  const missingOnDisk = [];
  const pendingDurable = [];
  const mismatched = [];
  for (const [turn, fp] of disk) {
    if (!event.has(turn)) missingOnEvent.push(turn);
    else if (event.get(turn) !== fp) mismatched.push({ turn, disk: fp, event: event.get(turn) });
  }
  for (const turn of event.keys()) {
    if (disk.has(turn)) continue;
    const endMs = endMsByTurn.get(turn) || 0;
    if (pendingWindowMs > 0 && endMs > 0 && endMs > now - pendingWindowMs) pendingDurable.push(turn);
    else missingOnDisk.push(turn);
  }
  missingOnEvent.sort((a, b) => a - b);
  missingOnDisk.sort((a, b) => a - b);
  pendingDurable.sort((a, b) => a - b);
  mismatched.sort((a, b) => a.turn - b.turn);
  return {
    sid,
    diskCount: disk.size,
    eventCount: event.size,
    exactMatch: missingOnEvent.length === 0 && missingOnDisk.length === 0 && mismatched.length === 0,
    missingOnEvent,
    missingOnDisk,
    mismatched,
    pendingDurable,
  };
}

/**
 * 一组会话比对结果的汇总（写进 `.state.json` 的 shadow 段 / 影子行）。
 *
 * @param {Array<ReturnType<typeof compareTurnSets>>} records
 */
export function diffSummary(records) {
  const list = Array.isArray(records) ? records : [];
  const diff = list.filter((r) => !r.exactMatch);
  return {
    sessions: list.length,
    exactMatch: list.length - diff.length,
    diffCount: diff.length,
    missingOnEvent: diff.reduce((n, r) => n + r.missingOnEvent.length, 0),
    missingOnDisk: diff.reduce((n, r) => n + r.missingOnDisk.length, 0),
    mismatched: diff.reduce((n, r) => n + r.mismatched.length, 0),
    pendingDurable: list.reduce((n, r) => n + (Array.isArray(r.pendingDurable) ? r.pendingDurable.length : 0), 0),
    diffSessions: diff.map((r) => ({ sid: r.sid, missingOnEvent: r.missingOnEvent.length, missingOnDisk: r.missingOnDisk.length, mismatched: r.mismatched.length, pendingDurable: Array.isArray(r.pendingDurable) ? r.pendingDurable.length : 0 })),
  };
}

/**
 * 生成一条影子记录（JSONL 行；写由调用方决定，本函数纯）。
 *
 * @param {{at:string, sid:string, diskTurns:Array<object>, eventTurns:Array<object>, now?:number, pendingWindowMs?:number}} opts
 */
export function shadowRecord({ at, sid, diskTurns, eventTurns, now, pendingWindowMs }) {
  const cmp = compareTurnSets(sid, diskTurns, eventTurns, { now, pendingWindowMs });
  return {
    v: 1,
    at,
    sid,
    fpVersion: TURN_FP_VERSION,
    diskCount: cmp.diskCount,
    eventCount: cmp.eventCount,
    exactMatch: cmp.exactMatch,
    missingOnEvent: cmp.missingOnEvent,
    missingOnDisk: cmp.missingOnDisk,
    mismatched: cmp.mismatched,
    pendingDurable: cmp.pendingDurable,
  };
}

/** 从事件数组（live/persistence 通道的解码后事件）提取闭合轮次：规则与 lib/ledger.js readTurnsFrom 一致。 */
export function closedTurnsFromEvents(events) {
  const turns = [];
  const warnings = [];
  let open = null;
  let malformed = 0;
  let abandoned = 0;
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    const type = ev && ev.type;
    if (type !== 'turn/start' && type !== 'turn/end') continue;
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) && ev.time > 0 ? ev.time : 0;
    const num = ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;
    if (time === 0 || num === null) { malformed += 1; continue; }
    if (type === 'turn/start') {
      if (open && open.turn !== num) {
        open.endMs = open.startMs;
        open.reason = 'abandoned';
        turns.push(open);
        abandoned += 1;
      }
      open = { turn: num, startMs: time, endMs: 0, reason: '' };
    } else if (open && open.turn === num) {
      open.endMs = time;
      open.reason = reasonKindOf(ev);
      turns.push(open);
      open = null;
    }
  }
  return { turns, open, malformed, abandoned, warnings };
}

/** turn/end 的 reason：磁盘行是 data.reason.kind（ledger.js:284），事件对象可能是 data.reason.kind / data.reason / reason。 */
function reasonKindOf(ev) {
  const d = ev && ev.data;
  const r = d && d.reason;
  if (r && typeof r === 'object' && typeof r.kind === 'string') return r.kind;
  if (typeof r === 'string') return r;
  const r2 = ev && ev.reason;
  if (r2 && typeof r2 === 'object' && typeof r2.kind === 'string') return r2.kind;
  if (typeof r2 === 'string') return r2;
  return '';
}

function normalizeChunk(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.events)) return raw.events;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

function normalizeRef(x) {
  if (!x || typeof x !== 'object') return null;
  const sessionId = x.sessionId || x.session || x.id || x.sid || (x.header && x.header.id) || '';
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const revision = typeof x.revision === 'string' ? x.revision : x.revision === undefined || x.revision === null ? null : String(x.revision);
  return {
    sid: normalizeSid(sessionId),
    s12: typeof x.s12 === 'string' ? x.s12 : '',
    sessionId,
    source: 'persistence',
    revision,
    eventCount: Number.isInteger(x.eventCount) ? x.eventCount : null,
    sizeBytes: Number.isInteger(x.sizeBytes) ? x.sizeBytes : null,
    path: null,
  };
}

/**
 * 持久层轮询采集器（方案 B，首个可切换源）：`ctx.sessionPersistence` 的 list/stat + open('read').read(seq,n)。
 *
 * 设计约束（调研 §6/§8）：①所有失败降级为 warnings、绝不抛（I4）；②游标用 seq（revision 只放内存/对账）；
 * ③只读，不开写句柄；④宿主 API 形状按调研报告做了防御性归一（events/data/items/数组四种返回都接受），
 * 形状待真机 V1/V2 验证后收紧。
 *
 * @param {{host?:object, batchLimit?:number}} [opts] host 可为 ctx 或直接 `{sessionPersistence}`
 */
export function createPersistenceCollector({ host, batchLimit = 200 } = {}) {
  const warnings = [];
  const persistence = host && (host.sessionPersistence || (typeof host.list === 'function' && typeof host.open === 'function' ? host : null));
  const available = !!(persistence && typeof persistence.list === 'function');
  return {
    kind: 'persistence',
    available,
    warnings,
    /** 列出会话（只读）。失败返回 [] 并记 warnings。 */
    async listSessions() {
      if (!available) { warnings.push('PERSISTENCE_UNAVAILABLE'); return []; }
      try {
        const raw = await persistence.list();
        const arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.sessions) ? raw.sessions : [];
        return arr.map(normalizeRef).filter(Boolean);
      } catch (e) {
        warnings.push('list:' + (e && e.message ? e.message : String(e)));
        return [];
      }
    },
    /**
     * 读某会话的闭合轮次（从 cursor.seq 起增量）。
     * @param {{sessionId?:string, sid?:string, revision?:string|null}} ref listSessions() 元素
     * @param {{seq?:number}} [cursor]
     * @param {{limit?:number}} [opts]
     * @returns {Promise<{turns:Array<object>, nextCursor:{seq:number|null}, revision:string|null, warnings:string[], bootstrap:'done'|'needed'}>}
     */
    async readClosedTurns(ref, cursor = {}, opts = {}) {
      const out = {
        turns: [],
        nextCursor: { seq: Number.isInteger(cursor && cursor.seq) ? cursor.seq : 0 },
        revision: (ref && ref.revision) || null,
        warnings: [],
        bootstrap: 'done',
      };
      if (!persistence || typeof persistence.open !== 'function') {
        out.warnings.push('PERSISTENCE_UNAVAILABLE');
        return out;
      }
      const sessionId = ref && (ref.sessionId || ref.sid);
      if (!sessionId) { out.warnings.push('NO_SESSION_ID'); return out; }
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : batchLimit;
      let handle = null;
      const chunkState = { observed: false, value: null };
      try {
        handle = await persistence.open(sessionId, 'read');
        const readFn = handle && typeof handle.read === 'function' ? handle.read.bind(handle) : null;
        if (!readFn) { out.warnings.push('PERSISTENCE_NO_READ'); return out; }
        let seq = Number.isInteger(cursor && cursor.seq) ? cursor.seq : 0;
        const events = [];
        for (let guard = 0; guard < 10000; guard += 1) {
          const chunk = await readFn(seq, limit);
          if (chunk && typeof chunk === 'object' && chunk.eventState !== undefined) { chunkState.observed = true; chunkState.value = chunk.eventState; }
          const list = normalizeChunk(chunk);
          if (!list.length) break;
          events.push(...list);
          const withSeq = list.filter((e) => e && Number.isInteger(e.seq));
          if (withSeq.length !== list.length) {
            out.warnings.push('SEQ_MISSING');
            break; // 无 seq 的返回不可增量推进，停止而不是死循环
          }
          const lastSeq = withSeq.reduce((m, e) => Math.max(m, e.seq), seq);
          seq = lastSeq + 1;
          if (list.length < limit) break;
        }
        // 真机：read 返回 {eventState, events}；eventState 是状态串（如 shared-frozen），不是计数对象
        if (chunkState.observed) out.eventState = chunkState.value;
        out.nextCursor.seq = seq;
        const parsed = closedTurnsFromEvents(events);
        out.turns = parsed.turns;
        out.malformed = parsed.malformed;
        out.abandoned = parsed.abandoned;
        out.open = parsed.open;
        out.warnings.push(...parsed.warnings);
      } catch (e) {
        out.warnings.push('read:' + (e && e.message ? e.message : String(e)));
        out.bootstrap = 'needed';
      } finally {
        try { if (handle && typeof handle.close === 'function') await handle.close(); } catch { /* 关闭失败不影响读取结果 */ }
      }
      return out;
    },
  };
}
