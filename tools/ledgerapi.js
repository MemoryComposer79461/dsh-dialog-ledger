/**
 * @file ledgerapi.js
 * @role **只读查询层**（V0.6 外层）：把台账读成"可查询的账"，不写任何一个字节。
 *
 * @why V0.6 的定位是"账本从事后可查变成过程中可用"。这个模块是三个 Agent 工具
 *      （search / turn / context）与左栏面板的**共同底座**。
 *      它只依赖已有的 `ledger.readAll` 与路径助手，**不碰内核**（ledger/frames/... 均未修改）。
 *
 * @why 只读是硬约束：UI 与工具都不许写账。本模块不 import 任何写函数（appendTurn/writeState 等），
 *      也不提供任何写接口 —— 从模块边界上杜绝"面板顺手改账"。
 *
 * @depends node:fs、node:path、./ledger.js、./encoder.js、./weekly.js、./original.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { readAll } from '../lib/ledger.js';
import { parseCode } from '../lib/encoder.js';
import { monthOfCode } from '../lib/weekly.js';
import { originalRelPath } from '../lib/original.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 原文片段**硬上限**（V1.0 / 准入审计 P1-08）：65536 字节。
 *
 * @why 审计实测一次 `ledger_turn{excerptBytes: 超大值}` 返回了 307,205 字符全文（307,659 B），
 *      与"不整篇塞上下文"的设计主张相反，也是提示注入/上下文放大/敏感全文外流的入口。
 *      这里给硬上限：超限**截断**并在结果里标 `excerptCapped:true`，调用方无法绕过。
 * @why 默认仍是 800（与工具 schema 描述一致）；上限与面板 `/turn` 的 `LIMITS.excerptBytes.hi`
 *      取同一个数（65536），避免"Agent 面与面板面两套口径"。
 */
export const EXCERPT_MAX_BYTES = 65536;
const DEFAULT_EXCERPT_BYTES = 800;

/** 一行台账 → 查询结果（窄视图：只给"人/模型都够用"的字段，不整行倒出）。 */
function toRow(r) {
  return {
    code: String(r.code || ''),
    ts: String(r.ts || ''),
    sid: String(r.sid || ''),
    turn: Number.isInteger(r.turn) ? r.turn : null,
    status: String(r.status || ''),
    turnState: r.turnState === 'closed' ? 'closed' : (r.status === 'partial' ? 'partial' : ''),
    doc: String(r.doc || ''),
    // 历史行没有绑定证据 → 原样标出来，别让调用方误以为"有 doc 就绑定了"
    bound: !!(r.docFileSha256 && r.attachment),
  };
}

/**
 * 在账本里查行。
 * @param {string} root 数据总库
 * @param {{sid?:string, month?:string, keyword?:string, limit?:number,
 *          offsetMinutes?:number, includeLegacy?:boolean}} [q]
 * @returns {{ok:true, rows:Array, total:number, scanned:number, truncated:boolean,
 *            readErrors:number, badLines:number}
 *          |{ok:false, reason:string, readErrors?:number}}
 */
export function searchLedger(root, q = {}) {
  const offsetMinutes = Number.isFinite(q.offsetMinutes) ? q.offsetMinutes : 480;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(q.limit) ? q.limit : DEFAULT_LIMIT));
  const all = readAll(root, { repairTornTail: false }); // ★ 只读路径：绝不触发自愈（RC-10）
  if (!all || all.ok !== true) {
    return { ok: false, reason: 'ledger-unreadable', readErrors: (all && all.readErrors || []).length };
  }
  const sid = typeof q.sid === 'string' && q.sid ? q.sid : '';
  const month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : '';
  const kw = typeof q.keyword === 'string' ? q.keyword.trim() : '';

  const out = [];
  for (const r of all.records) {
    const row = toRow(r);
    if (!row.code) continue;
    if (sid && row.sid !== sid) continue;
    if (month) {
      const mm = monthOfCode(row.code, Date.parse(row.ts) || 0, offsetMinutes);
      if (!mm || `${mm.year}-${String(mm.month).padStart(2, '0')}` !== month) continue;
    }
    if (kw) {
      const hay = `${row.code} ${row.sid} ${row.ts} ${row.doc}`;
      if (!hay.includes(kw)) continue;
    }
    out.push(row);
  }
  // 时间序（同一时刻用 code 兜底，保证稳定）
  out.sort((a, b) => (a.ts === b.ts ? (a.code < b.code ? -1 : 1) : (a.ts < b.ts ? -1 : 1)));
  return {
    ok: true,
    rows: out.slice(0, limit),
    total: out.length,
    scanned: all.records.length,
    truncated: out.length > limit,
    readErrors: (all.readErrors || []).length,
    badLines: Number(all.badLines) || 0,
  };
}

/**
 * 把「台账行里声明的相对路径」安全地落到 `root` 之内 —— **穿越防护**。
 *
 * @why 为什么需要它（2026-11-11 外部审计预备探针查出来的真问题）：
 *   台账行的 `doc` 字段是**数据**，不是可信代码。若某行写成 `..\secret.txt`，
 *   `path.join(root, doc)` 会直接跳出数据总库，`ledger_turn` 就会把库外文件的开头
 *   当成"原文片段"返回给模型。工具面只能读账，不能读库外——这不是洁癖，是边界。
 *
 * @why 二次校验 realpath：光比字符串挡不住符号链接/目录联接（root 里放个 link 指向外面）。
 *
 * @param {string} root 数据总库根
 * @param {string} rel 行里声明的相对路径
 * @returns {{abs:string, reason:string}} `reason=''` 表示可读；否则
 *   `'empty'|'outside-root'|'missing'|'not-a-file'|'symlink-escape'|'unreadable'`
 */
export function containedPath(root, rel) {
  const r = typeof rel === 'string' ? rel.trim() : '';
  if (!r) return { abs: '', reason: 'empty' };
  const p = path.join(root, r);
  const relToRoot = path.relative(root, p);
  if (relToRoot === '' || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { abs: '', reason: 'outside-root' };
  }
  let st = null;
  try { st = fs.statSync(p); } catch { return { abs: '', reason: 'missing' }; }
  if (!st.isFile()) return { abs: '', reason: 'not-a-file' };
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(p);
    const r2 = path.relative(realRoot, real);
    if (r2 === '' || r2.startsWith('..') || path.isAbsolute(r2)) {
      return { abs: '', reason: 'symlink-escape' };
    }
  } catch { return { abs: '', reason: 'unreadable' }; }
  return { abs: p, reason: '' };
}

/**
 * 按编码取一轮：台账行 + 原文文件位置 + 正文开头（不整篇塞给调用方）。
 * @param {string} root
 * @param {string} code
 * @param {{excerptBytes?:number, offsetMinutes?:number}} [opts]
 * @why V1.0 / 审计 P1-08：`excerptBytes` 有**硬上限** `EXCERPT_MAX_BYTES`（65536），
 *      超出即截断并标 `excerptCapped`；`excerptTruncated` 仍表示"原文比这次给的片段更长"。
 */
export function getTurn(root, code, opts = {}) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, reason: 'code-required' };
  const parsed = parseCode(c);
  if (!parsed) return { ok: false, reason: 'code-unparsable' };
  const offsetMinutes = Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480;
  const requested = Number.isInteger(opts.excerptBytes) ? Math.max(0, opts.excerptBytes) : DEFAULT_EXCERPT_BYTES;
  const excerptCapped = requested > EXCERPT_MAX_BYTES;
  const excerptBytes = Math.min(requested, EXCERPT_MAX_BYTES);

  const all = readAll(root, { repairTornTail: false });
  if (!all || all.ok !== true) return { ok: false, reason: 'ledger-unreadable' };
  const hit = all.records.find((r) => String(r.code) === c);
  if (!hit) return { ok: false, reason: 'not-found', code: c };

  const row = toRow(hit);
  const mm = monthOfCode(c, Date.parse(row.ts) || 0, offsetMinutes);
  const relCandidates = [];
  if (row.doc) relCandidates.push(row.doc);
  if (mm) relCandidates.push(originalRelPath(mm.year, mm.month, c));

  let abs = '';
  let bytes = 0;
  const rejected = [];
  for (const rel of relCandidates) {
    // ★ V0.9：行里的 doc 是数据，必须先过穿越防护再碰文件系统（见 containedPath）。
    const hitPath = containedPath(root, rel);
    if (hitPath.reason) {
      // 'missing' 是常态（历史行可能没有原文），单独记也无害；越界必须显式留痕。
      if (hitPath.reason !== 'missing') rejected.push({ path: rel, reason: hitPath.reason });
      continue;
    }
    abs = hitPath.abs;
    try { bytes = fs.statSync(abs).size; } catch { abs = ''; bytes = 0; continue; }
    break;
  }
  let excerpt = '';
  if (abs && excerptBytes > 0) {
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(excerptBytes, bytes));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        excerpt = buf.slice(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { excerpt = ''; }
  }
  return {
    ok: true,
    row,
    original: {
      path: abs ? path.relative(root, abs) : '',
      exists: !!abs,
      bytes,
      // ★ V0.9：被拒绝的候选路径（越界/软链/非文件）。空数组 = 没有可疑路径。
      rejected,
    },
    excerpt,
    excerptBytes,
    // ★ V1.0 / P1-08：调用方要的片段被硬上限截过（true = 它要的比 65536 多，实际给 65536）
    excerptCapped,
    excerptTruncated: !!abs && bytes > Buffer.byteLength(excerpt, 'utf8'),
  };
}

/**
 * 取某个会话最近 N 轮（紧凑视图，用于上下文被压缩后重新接上）。
 * @param {string} root
 * @param {{sid:string, turns?:number, offsetMinutes?:number}} q
 */
export function getContext(root, q = {}) {
  const sid = typeof q.sid === 'string' ? q.sid : '';
  if (!sid) return { ok: false, reason: 'sid-required' };
  const turns = Math.min(100, Math.max(1, Number.isInteger(q.turns) ? q.turns : 10));
  const all = readAll(root, { repairTornTail: false });
  if (!all || all.ok !== true) return { ok: false, reason: 'ledger-unreadable' };
  const rows = all.records.map(toRow).filter((r) => r.sid === sid);
  rows.sort((a, b) => ((a.turn || 0) - (b.turn || 0)));
  const picked = rows.slice(-turns);
  return {
    ok: true,
    sid,
    rows: picked,
    totalTurns: rows.length,
    hasMore: rows.length > picked.length,
    firstTurn: picked.length ? picked[0].turn : null,
    lastTurn: picked.length ? picked[picked.length - 1].turn : null,
  };
}

/** 极轻的健康摘要（面板顶栏用；只读）。
 *  ★ 注意：**读不全也要给数**（badLines/readErrors 照报），只在缺账时才失败——
 *    因为面板最需要显示的就是"这库有问题"，不能因为读不全就直接空白。 */
export function summarize(root) {
  const all = readAll(root, { repairTornTail: false });
  if (!all) return { ledgerOk: false, reason: 'ledger-unreadable' };
  const rows = all.records.map(toRow);
  const sids = new Set(rows.map((r) => r.sid).filter(Boolean));
  const days = new Set(rows.map((r) => r.code.slice(0, 8)));
  return {
    ledgerOk: all.ok === true,
    rows: rows.length,
    sessions: sids.size,
    days: days.size,
    bound: rows.filter((r) => r.bound).length,
    unbound: rows.filter((r) => !r.bound).length,
    badLines: Number(all.badLines) || 0,
    readErrors: (all.readErrors || []).length,
  };
}
