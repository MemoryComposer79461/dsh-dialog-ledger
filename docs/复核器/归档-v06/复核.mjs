/**
 * @file 复核.mjs
 * @role **独立复核官（双实现对账的第二套账）**：只用 Node 标准库，独立解析 `sessions/*.jsonl.zstd`
 *       与插件产出的台账 `ledger/*.jsonl` + 原文附件，算出"应该有多少轮、每轮什么内容"，逐轮对账。
 *
 * @independence ★ 本文件 **不得 import 插件任何模块**（lib/* 与 index.js 都不许）。
 *   它自己切 zstd 帧、自己解压、自己配对 turn、自己算指纹；连常量都自己定义。
 *   若它引用了插件的实现，双实现就退化成"同一份代码跑两次"，共同错误会被掩盖。
 *
 * @method 差异分类（对不上的地方）
 *   A 源有账无（漏记）；B 账有源无（多记/编号错）；C 闭合状态与契约映射不一致；
 *   D 内容见证不一致（条数/首尾/指纹/时间/附件缺失或哈希不符）；E 复核不到（坏帧、v2 及更早、行不可解析）。
 *   判定优先级：A/B/E 按集合；C 按状态映射；D 只对"两侧都有"的轮次。
 *   v3-only 会话与 v3 前缀轮次**照常参与对账**（同一套笨逻辑解 v3 jsonl），只在报告里标"降级来源"。
 *
 * @ruling1（2026-11-10 基线首跑裁定）**本轮事件范围 = 位置在 turn/start..turn/end 之间，
 *   且 data.turn 为空或等于本轮的事件**；data.turn 指向其他轮次的"回放事件"不计入本轮。
 *   证据：38MB 迁移会话有 19 轮出现"首尾一致但条数多算"，多算的 10/9/1… 条全部是
 *   `tool/result` 且 data.turn ∈ {9,13,20,21,29,32,74}（旧轮回放），属位置在范围内、语义不属于本轮。
 *   该裁定与插件 readTurnEventsBatch 的过滤一致；复核器 v1.1.0 起按同一规则独立实现（代码仍不共享）。
 *   被排除的条数以 `foreignTurnEventsExcluded` 落进报告，不静默吞掉。
 *
 * @ruling2（2026-11-10 种错自证暴露）**附件定位以"账库内 root 相对路径"为准，台账行里的绝对
 *   `attachment.path` 只作兜底**。理由：账库整目录搬移/归档到新机器后，绝对路径必然失效；
 *   若优先信绝对路径，复核器会读到"原机上的文件"而不是"这份账库里的文件"——等于复核对对象。
 *   种错自证第 4 例（篡改副本内附件）就是被这条坑到的：原实现优先读绝对路径，篡改检测不出来。
 *
 * @usage
 *   node 复核.mjs --sessions=<corpus>\sessions --root=<corpus>\dialog-ledger --out=复核-基线.json
 *   node 复核.mjs ... --max-detail=200
 * 退出码：0 = 无 A/B/C/D（E 允许且明列）；1 = 有未裁定差异；2 = 参数/读取失败。
 *
 * @frozen 用于发布门/审计时，本文件的 sha256 必须记入《差异裁定表》；改它 = 重新基线。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ── 自查表（每次运行先算自己的哈希，防止"复核器被悄悄改过"） ──────────────
const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(SELF_PATH)).digest('hex');
const CHECKER_VERSION = 'v06-dualcheck-1.1.1';

// ── 独立常量（不引用插件常量） ─────────────────────────────────────────────
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const OFFSET_MINUTES = 480; // 全系统固定 +08:00
const MAX_DETAIL_DEFAULT = 100;

const pad2 = (n) => String(n).padStart(2, '0');
const sha256Text = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const isoLocal = (ms) => {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+08:00`;
};
const localStamp = (ms = Date.now()) => isoLocal(ms).replace('T', ' ').replace('+08:00', ' +08:00');

/** 事件的"轻量见证记录"：只保留可跨实现复算的三元组。 */
function triple(ev, fallbackSeq) {
  const seq = Number.isFinite(ev && ev.seq) ? ev.seq : fallbackSeq;
  return `${seq}\t${String(ev && ev.type || '')}\t${Number.isFinite(ev && ev.time) ? ev.time : ''}`;
}
/** 见证指纹：按事件顺序覆盖 [seq,type,time]；两侧独立计算，不共享代码。 */
function witnessOf(events, fallbackSeqBase = 0) {
  const lines = events.map((ev, i) => triple(ev, fallbackSeqBase + i));
  return {
    count: events.length,
    first: events.length ? triple(events[0], fallbackSeqBase) : '',
    last: events.length ? triple(events[events.length - 1], fallbackSeqBase + events.length - 1) : '',
    evalHash: sha256Text(lines.join('\n') + '\n'),
  };
}

// ── 源侧：独立解析会话文件 ────────────────────────────────────────────────
/**
 * 独立解一个 .zstd 多帧文件。
 * @why 不用插件的 frames.js：自己扫魔数、自己切片、自己调 zlib。
 *      ★ 第 0 轮实测：Node 的 zstdDecompressSync 对"多帧拼接"只解第一帧且不报错，
 *      所以必须按魔数切帧（本函数自己做），否则整个会话会被悄悄读丢。
 */
function decodeSessionFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(ZSTD_MAGIC, i + ZSTD_MAGIC.length); }
  const records = [];
  const badFrames = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8');
    } catch (e) {
      badFrames.push({ frame: k, start: from, end: to, reason: e && e.message ? e.message : String(e) });
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { badFrames.push({ frame: k, start: from, end: to, reason: 'bad-json-line' }); continue; }
      records.push({ ev, frameStart: from, frameEnd: to });
    }
  }
  const first = records.length ? records[0].ev : null;
  return {
    size: buf.length,
    frames: starts.length,
    badFrames,
    records,
    sid: first && typeof first.id === 'string' ? first.id : path.basename(path.dirname(filePath)),
    version: first && Number.isFinite(first.version) ? first.version : null,
    createdAt: first && Number.isFinite(first.createdAt) ? first.createdAt : null,
  };
}

/**
 * 独立配对 turn：turn/start 开轮；turn/end 同号闭合；下一轮 start 顶掉上一轮 → abandoned；EOF 未闭合 → open。
 * @why 这是"独立算"的核心：规则写在契约里，不翻译插件实现。
 */
function turnsOf(decoded) {
  const out = [];
  let cur = null;
  const closeCur = (status, end) => {
    if (!cur) return;
    const events = cur.records.map((r) => r.ev);
    const w = witnessOf(events);
    out.push({
      turn: cur.turn,
      status,
      startSeq: cur.startSeq,
      endSeq: end && Number.isFinite(end.ev.seq) ? end.ev.seq : null,
      startMs: cur.startMs,
      endMs: end && Number.isFinite(end.ev.time) ? end.ev.time : null,
      reason: end && end.ev.data && end.ev.data.reason && end.ev.data.reason.kind
        ? end.ev.data.reason.kind
        : (status === 'abandoned' ? 'next-turn-start' : ''),
      eventCount: w.count,
      foreignEvents: cur.foreign || 0,
      first: w.first,
      last: w.last,
      evalHash: w.evalHash,
      spanStart: cur.records.length ? Math.min(...cur.records.map((r) => r.frameStart)) : null,
      spanEnd: cur.records.length ? Math.max(...cur.records.map((r) => r.frameEnd)) : null,
    });
    cur = null;
  };
  for (const rec of decoded.records) {
    const ev = rec.ev;
    const type = ev && ev.type;
    if (type === 'turn/start') {
      if (cur) closeCur('abandoned', null);
      const turnNo = ev.data && Number.isFinite(ev.data.turn) ? ev.data.turn : null;
      cur = { turn: turnNo, startSeq: Number.isFinite(ev.seq) ? ev.seq : null, startMs: Number.isFinite(ev.time) ? ev.time : null, records: [rec], foreign: 0 };
    } else if (cur) {
      // ★ 裁定 1（见文件头）：位置在轮内、但 data.turn 明确指向"别的轮次"的事件，属回放，不计入本轮。
      const evTurn = ev.data && Number.isFinite(ev.data.turn) ? ev.data.turn : null;
      if (evTurn !== null && evTurn !== cur.turn) { cur.foreign += 1; continue; }
      cur.records.push(rec);
      if (type === 'turn/end' && ev.data && Number.isFinite(ev.data.turn) && ev.data.turn === cur.turn) {
        closeCur('closed', rec);
      }
    }
  }
  if (cur) closeCur('open', null);
  return out;
}

/**
 * 扫源目录，得每个会话的轮次清单。
 * 规则：v4 为主（DSH 升级会种子化旧事件，v4 通常为超集）；**v3 里 v4 没有的轮次照样并入**（标 v3-prefix），
 *      避免把"v4 起点更晚"的真实历史误判成 B（多记）。仅 v3 的会话整体标 degraded。
 */
function scanSource(sessionsBase) {
  const groups = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'session.v4.jsonl.zstd' && e.name !== 'session.v3.jsonl.zstd') continue;
      const sid = path.basename(path.dirname(p));
      const g = groups.get(sid) || { sid, dir: path.dirname(p), v4: null, v3: null };
      if (e.name.startsWith('session.v4')) g.v4 = p; else g.v3 = p;
      groups.set(sid, g);
    }
  })(sessionsBase);

  const sessions = [];
  for (const g of groups.values()) {
    const base = g.v4 || g.v3;
    const mode = g.v4 ? 'v4' : 'v3';
    const decodedMain = decodeSessionFile(base);
    const turnsMain = turnsOf(decodedMain);
    const byTurn = new Map(turnsMain.map((t) => [t.turn, t]));
    let v3OnlyTurns = 0;
    let v3BadFrames = [];
    let v3Bytes = 0;
    if (g.v4 && g.v3) {
      const decodedV3 = decodeSessionFile(g.v3);
      v3Bytes = decodedV3.size;
      v3BadFrames = decodedV3.badFrames;
      for (const t of turnsOf(decodedV3)) {
        if (!byTurn.has(t.turn)) { byTurn.set(t.turn, { ...t, fromV3Prefix: true }); v3OnlyTurns++; }
      }
    }
    const turns = [...byTurn.values()].sort((a, b) => (a.turn === b.turn ? 0 : (a.turn < b.turn ? -1 : 1)));
    sessions.push({
      sid: g.sid,
      mode,
      degraded: mode !== 'v4',
      v3PrefixTurns: v3OnlyTurns,
      file: path.relative(sessionsBase, base).split(path.sep).join('\\'),
      v3File: g.v3 ? path.relative(sessionsBase, g.v3).split(path.sep).join('\\') : '',
      bytes: decodedMain.size + v3Bytes,
      frames: decodedMain.frames,
      badFrames: [...decodedMain.badFrames, ...v3BadFrames],
      version: decodedMain.version,
      createdAt: decodedMain.createdAt,
      turns,
    });
  }
  sessions.sort((a, b) => (a.sid < b.sid ? -1 : 1));
  return sessions;
}

// ── 账侧：独立解析台账行与附件 ────────────────────────────────────────────
function readJsonlFile(filePath) {
  const rows = [];
  const badLines = [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { rows.push(JSON.parse(lines[i])); } catch { badLines.push({ file: path.basename(filePath), line: i + 1 }); }
  }
  return { rows, badLines };
}

function scanLedger(root) {
  const ledgerDir = path.join(root, 'ledger');
  const out = { rows: [], badLines: [], files: [], readErrors: [] };
  if (!fs.existsSync(ledgerDir)) { out.readErrors.push({ kind: 'ledger-dir-missing', path: ledgerDir }); return out; }
  const names = fs.readdirSync(ledgerDir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  for (const n of names) {
    const p = path.join(ledgerDir, n);
    try {
      const r = readJsonlFile(p);
      out.files.push(n);
      out.rows.push(...r.rows);
      out.badLines.push(...r.badLines);
    } catch (e) {
      out.readErrors.push({ kind: 'ledger-read-failed', file: n, reason: e && e.message ? e.message : String(e) });
    }
  }
  return out;
}

/** 从台账行找原文附件并独立复算见证。 */
function attachmentWitness(root, row) {
  const out = { ok: false, path: '', sha256: '', witness: null, reason: '' };
  const att = row.attachment && typeof row.attachment === 'object' ? row.attachment : null;
  const candidates = [];
  // ★ 裁定 2：先按账库内相对路径定位（doc 所在目录 + 附件名），绝对 path 只作兜底。
  const doc = typeof row.doc === 'string' ? row.doc : '';
  if (doc) {
    const dir = path.dirname(path.join(root, doc));
    if (att && typeof att.name === 'string') candidates.push(path.join(dir, att.name));
    candidates.push(path.join(dir, `${row.code} 原始事件.json`));
  }
  if (att && typeof att.path === 'string' && att.path) candidates.push(att.path);
  for (const p of candidates) {
    try {
      if (!fs.statSync(p).isFile()) continue;
      const buf = fs.readFileSync(p);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const events = [];
      let bad = 0;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { bad++; }
      }
      out.ok = true; out.badLines = bad;
      out.path = path.relative(root, p).split(path.sep).join('\\');
      if (out.path.startsWith('..')) out.path = p;
      out.sha256 = sha;
      out.witness = witnessOf(events);
      return out;
    } catch { /* 继续找 */ }
  }
  out.reason = 'attachment-not-found';
  return out;
}

// ── 对账 ──────────────────────────────────────────────────────────────────
const STATUS_RULES = {
  closed: { expectLedgerStatus: ['ok'], note: '源已闭合 → 账应 ok' },
  abandoned: { expectLedgerStatus: ['partial'], note: '源被下一轮 start 顶掉（孤儿轮次）→ 账应 partial（契约 P1-1）' },
  open: { expectLedgerStatus: [], note: '源未闭合 → 不应出现在台账（只允许 .pending.jsonl）' },
};

function audit({ sessionsBase, root, maxDetail = MAX_DETAIL_DEFAULT }) {
  const t0 = Date.now();
  const sessions = scanSource(sessionsBase);
  const ledger = scanLedger(root);

  const srcByKey = new Map();
  let srcTurns = 0;
  let v3PrefixTurns = 0;
  for (const s of sessions) {
    for (const t of s.turns) {
      const key = `${s.sid}#${t.turn}`;
      if (!srcByKey.has(key)) srcByKey.set(key, { sid: s.sid, turn: t.turn, source: s, turnInfo: t });
      srcTurns++;
      if (t.fromV3Prefix) v3PrefixTurns++;
    }
  }
  const ledByKey = new Map();
  for (const r of ledger.rows) {
    const sid = typeof r.sid === 'string' ? r.sid : '';
    const turn = Number.isFinite(r.turn) ? r.turn : null;
    if (!sid || turn === null) continue;
    const key = `${sid}#${turn}`;
    const list = ledByKey.get(key) || [];
    list.push(r);
    ledByKey.set(key, list);
  }

  const diffs = [];
  const classCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const push = (cls, o) => { classCounts[cls] += 1; if (diffs.length < maxDetail) diffs.push({ class: cls, ...o }); };
  const sessionById = new Map(sessions.map((s) => [s.sid, s]));

  // ① 逐源轮次对账
  for (const [key, v] of srcByKey) {
    const { sid, turn, source, turnInfo } = v;
    const rows = ledByKey.get(key) || [];
    const row = rows[0] || null;
    const rule = STATUS_RULES[turnInfo.status];

    // E：源本身没复核干净（坏帧）—— 该会话内一律降级，不把"读不全"当"账错"
    if (source.badFrames && source.badFrames.length > 0) {
      push('E', { sid, turn, reason: 'source-frames-bad', detail: `源文件有 ${source.badFrames.length} 个坏帧，本会话结论不可信`, source: source.file });
      continue;
    }
    if (turnInfo.turn === null) {
      push('E', { sid, turn, reason: 'source-turn-missing-number', detail: '源 turn/start 缺 data.turn', source: source.file });
      continue;
    }
    // A：源有、账无（未闭合轮次不入账，不算 A）
    if (!row) {
      if (turnInfo.status === 'open') continue;
      push('A', { sid, turn, reason: 'missing-in-ledger', detail: `${rule.note}；但台账无此轮`, source: source.file, code: '' });
      continue;
    }
    // 多行同键（应唯一）
    if (rows.length > 1) {
      push('D', { sid, turn, reason: 'duplicate-ledger-keys', detail: `台账同一 (sid,turn) 有 ${rows.length} 行`, code: row.code || '' });
    }
    // C：状态映射
    const expect = rule.expectLedgerStatus;
    const st = String(row.status || '');
    if (turnInfo.status === 'open') {
      push('C', { sid, turn, reason: 'open-turn-in-ledger', detail: '源未闭合，台账却已有一行（违背 P0-2）', code: row.code || '' });
    } else if (!expect.includes(st)) {
      push('C', { sid, turn, reason: 'status-mismatch', detail: `源=${turnInfo.status}，账=${st || '(空)'}；契约映射: ${rule.note}`, code: row.code || '' });
    }
    // D：时间（账 ts 精确到秒 → 按秒比较）
    const tsMs = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (Number.isFinite(tsMs) && Number.isFinite(turnInfo.startMs) &&
        Math.floor(tsMs / 1000) !== Math.floor(turnInfo.startMs / 1000)) {
      push('D', { sid, turn, reason: 'ts-mismatch', detail: `源起始=${isoLocal(turnInfo.startMs)}，账 ts=${row.ts}`, code: row.code || '' });
    }
    // D：内容见证（附件）
    const att = attachmentWitness(root, row);
    if (!att.ok) {
      push('D', { sid, turn, reason: att.reason, detail: '台账行声称绑定原文，但附件文件不可读/找不到', code: row.code || '' });
    } else {
      const expectSha = row.attachment && typeof row.attachment.sha256 === 'string' ? row.attachment.sha256 : '';
      if (expectSha && expectSha !== att.sha256) {
        push('D', { sid, turn, reason: 'attachment-sha-mismatch', detail: `台账登记 ${expectSha.slice(0, 12)}…，现文件 ${att.sha256.slice(0, 12)}…`, code: row.code || '', path: att.path });
      }
      const w = att.witness;
      if (w.count !== turnInfo.eventCount || w.first !== turnInfo.first || w.last !== turnInfo.last || w.evalHash !== turnInfo.evalHash) {
        push('D', {
          sid, turn, reason: 'content-witness-mismatch', code: row.code || '', path: att.path,
          detail: `条数 源=${turnInfo.eventCount}/账=${w.count}；首 源=[${turnInfo.first}]/账=[${w.first}]；尾 源=[${turnInfo.last}]/账=[${w.last}]；指纹 ${turnInfo.evalHash.slice(0, 12)}… vs ${w.evalHash.slice(0, 12)}…`,
        });
      }
    }
  }

  // ② 账有源无
  for (const [key, rows] of ledByKey) {
    if (srcByKey.has(key)) continue;
    const sid = rows[0].sid || '';
    const turn = rows[0].turn;
    const srcSession = sessionById.get(sid);
    if (srcSession && srcSession.badFrames && srcSession.badFrames.length > 0) {
      push('E', { sid, turn, reason: 'ledger-row-but-source-bad', detail: '账有行，但源文件有坏帧，无法判定' });
      continue;
    }
    push('B', { sid, turn, reason: srcSession ? 'source-session-has-no-such-turn' : 'source-session-missing', detail: '台账有此 (sid,turn)，源侧算不出该轮', code: rows[0].code || '' });
  }

  const summary = {
    checkerVersion: CHECKER_VERSION,
    checkerSha256: SELF_SHA256,
    at: localStamp(),
    durationMs: Date.now() - t0,
    sessionsBase,
    ledgerRoot: root,
    sessions: sessions.length,
    sessionsV4: sessions.filter((s) => s.mode === 'v4').length,
    sessionsV3Only: sessions.filter((s) => s.mode !== 'v4').length,
    sourceTurns: srcTurns,
    sourceTurnsV3Prefix: v3PrefixTurns,
    sourceTurnsClosed: sessions.reduce((n, s) => n + s.turns.filter((t) => t.status === 'closed').length, 0),
    sourceTurnsAbandoned: sessions.reduce((n, s) => n + s.turns.filter((t) => t.status === 'abandoned').length, 0),
    sourceTurnsOpen: sessions.reduce((n, s) => n + s.turns.filter((t) => t.status === 'open').length, 0),
    foreignTurnEventsExcluded: sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + (t.foreignEvents || 0), 0), 0),
    ledgerRows: ledger.rows.length,
    ledgerFiles: ledger.files,
    ledgerBadLines: ledger.badLines.length,
    ledgerReadErrors: ledger.readErrors.length,
    classCounts,
    unexplained: classCounts.A + classCounts.B + classCounts.C + classCounts.D,
    ok: classCounts.A + classCounts.B + classCounts.C + classCounts.D === 0,
    maxDetail,
    diffsTruncated: diffs.length >= maxDetail,
  };
  return { summary, diffs, sessions, ledger };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const argOf = (k, d = '') => {
    const hit = args.find((a) => a === k || a.startsWith(k + '='));
    if (!hit) return d;
    const i = hit.indexOf('=');
    return i < 0 ? '' : hit.slice(i + 1);
  };
  const sessionsBase = argOf('--sessions');
  const root = argOf('--root');
  if (!sessionsBase || !root) {
    console.error('用法: node 复核.mjs --sessions=<sessions目录> --root=<账库根> [--out=报告.json] [--max-detail=N]');
    process.exit(2);
  }
  const maxDetail = Number(argOf('--max-detail', String(MAX_DETAIL_DEFAULT))) || MAX_DETAIL_DEFAULT;
  if (!fs.existsSync(sessionsBase)) { console.error('sessions 目录不存在: ' + sessionsBase); process.exit(2); }
  if (!fs.existsSync(root)) { console.error('账库根不存在: ' + root); process.exit(2); }

  const result = audit({ sessionsBase: path.resolve(sessionsBase), root: path.resolve(root), maxDetail });
  const out = argOf('--out', path.join(path.dirname(SELF_PATH), '复核-结果.json'));
  fs.writeFileSync(out, JSON.stringify({ ...result.summary, diffs: result.diffs }, null, 2) + '\n', 'utf8');

  console.log('=== 独立复核（双实现对账）===');
  console.log('复核器: ' + CHECKER_VERSION + ' sha256=' + SELF_SHA256.slice(0, 16) + '…');
  console.log('源会话: ' + result.summary.sessions + '（v4=' + result.summary.sessionsV4 + ' / v3-only=' + result.summary.sessionsV3Only + '）');
  console.log('源轮次: ' + result.summary.sourceTurns + '（closed=' + result.summary.sourceTurnsClosed +
    ' / abandoned=' + result.summary.sourceTurnsAbandoned + ' / open=' + result.summary.sourceTurnsOpen +
    ' / v3前缀=' + result.summary.sourceTurnsV3Prefix + '）');
  console.log('台账行: ' + result.summary.ledgerRows + '（badLines=' + result.summary.ledgerBadLines + '）');
  console.log('差异分类: A=' + result.summary.classCounts.A + ' B=' + result.summary.classCounts.B +
    ' C=' + result.summary.classCounts.C + ' D=' + result.summary.classCounts.D + ' E=' + result.summary.classCounts.E);
  console.log('未裁定差异(A/B/C/D): ' + result.summary.unexplained + (result.summary.ok ? ' → PASS' : ' → FAIL'));
  for (const d of result.diffs.slice(0, 20)) {
    console.log(`  [${d.class}] ${d.sid}#${d.turn} ${d.reason} ${d.detail ? '— ' + String(d.detail).slice(0, 160) : ''}`);
  }
  if (result.diffs.length > 20) console.log('  …还有 ' + (result.diffs.length - 20) + ' 条（见报告）');
  console.log('报告 → ' + out);
  process.exit(result.summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) main();

export { audit, scanSource, scanLedger, decodeSessionFile, turnsOf, witnessOf, CHECKER_VERSION, SELF_SHA256 };
