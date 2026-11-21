#!/usr/bin/env node
/**
 * @file docs/复核器/独立复核.mjs
 * @role v1.0.0-re 审计（EVID-01）**独立复核器**：不 import 插件任何模块，用 Node 标准库自己解析
 *       `sessions/<任意子目录>/session.vN.jsonl.zstd`（独立走 zstd frame header + block header + 逐帧解压）、
 *       `ledger/YYYY-MM-DD.jsonl`、`ledger/.tick-metrics.jsonl`、`ledger/.index/`，四路数字互相对账。
 * @independence 只 import `node:` 内建模块。**不得** import `index.js` / `lib/*` / `tools/*` / `freeze/*`；
 *       `--self-check` 会扫描本目录全部 .mjs 的 import 表并断言这一条（含归档目录的复核器本体）。
 * @method ① 独立数源会话：闭合轮 = `turn/end` 事件条数（不读插件代码，不按插件配对逻辑）；
 *         ② 独立数台账行；③ 独立数 tick 度量 written 累计与端到端 tick 数；④ 独立数索引行；
 *         ⑤ 判定：源闭合轮 == 台账行 == 索引行 == written 累计（允许 0 处不一致）。
 * @usage node docs\复核器\独立复核.mjs --lab=<lab> [--json] [--expect-rows=1338] [--self-check]
 *        --lab  含 root\ledger 与 dsh-home\sessions（或 sessions\）的 lab 目录（默认 `..\..\lab-e3-accept`）
 * @exit 0 = 四路一致且满足期望；1 = 有不一致/解析失败；2 = 用法错误
 * @note 只读：不写任何文件。大文件按帧流式解压（逐帧 1 帧驻留），不整库载入、不灌库。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const MAGIC = 0xfd2fb528;
const VERSION = 'indep-audit/1.0.0';
const args = process.argv.slice(2);
const argOf = (k, d = '') => { const h = args.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const has = (k) => args.includes(`--${k}`);
const emit = (o, human) => { console.log(has('json') ? JSON.stringify(o, null, 2) : human); };

// ---------- 独立 zstd 多帧解析：自己走 frame header + block header，不用 lib/frames.js ----------
function walkFrames(buf, label) {
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`${label}: offset ${off} 不是 zstd 魔数`);
    const d = buf[off + 4];
    const fcsFlag = d >> 6, single = (d >> 5) & 1, checksum = (d >> 2) & 1, dictFlag = d & 3;
    let pos = off + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      const bh = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
      pos += 3;
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3;
      if (type === 3) throw new Error(`${label}: offset ${pos} 出现保留 block type`);
      pos += type === 0 ? size : type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) pos += 4;
    frames.push([off, pos]);
    off = pos;
  }
  return frames;
}

// ---------- 源会话：逐帧解压，数闭合轮（turn/end） ----------
function scanSessions(base) {
  const found = [];
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(e.name); if (m) found.push({ file: p, ver: Number(m[1]), dir: d }); }
    }
  })(base);
  const byDir = new Map();
  for (const f of found) if (!byDir.has(f.dir) || Number(f.ver) > Number(byDir.get(f.dir).ver)) byDir.set(f.dir, f);
  const selected = [...byDir.values()].sort((a, b) => a.file.localeCompare(b.file));
  const skipped = found.filter((f) => !selected.includes(f)).map((f) => ({ file: path.relative(base, f.file).split(path.sep).join('/'), why: `旧版本 v${f.ver}；插件按最新版本入账，不计入复核` }));
  const out = { files: [], skipped, frames: 0, decompressedBytes: 0, lines: 0, badJson: 0, closedTurns: 0, turnStarts: 0, zstdSha256: crypto.createHash('sha256') };
  for (const f of selected) {
    const buf = fs.readFileSync(f.file);
    const fr = walkFrames(buf, path.basename(f.file));
    const rec = { file: path.relative(base, f.file).split(path.sep).join('/'), compressedBytes: buf.length, frames: fr.length, frameEndsAtEof: fr.length ? fr[fr.length - 1][1] === buf.length : false, decompressedBytes: 0, lines: 0, badJson: 0, closedTurns: 0, turnStarts: 0 };
    for (const [a, b] of fr) {
      out.zstdSha256.update(buf.subarray(a, b));
      const raw = zlib.zstdDecompressSync(buf.subarray(a, b));
      rec.decompressedBytes += raw.length;
      for (const line of raw.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        rec.lines += 1;
        try {
          const t = String((JSON.parse(line) || {}).type || '');
          if (t === 'turn/end') rec.closedTurns += 1;
          if (t === 'turn/start') rec.turnStarts += 1;
        } catch { rec.badJson += 1; }
      }
    }
    for (const k of ['frames', 'decompressedBytes', 'lines', 'badJson', 'closedTurns', 'turnStarts']) out[k] += rec[k];
    out.files.push(rec);
  }
  out.zstdSha256 = out.zstdSha256.digest('hex');
  return out;
}

// ---------- 插件台账：独立逐行 JSON 解析 ----------
function scanLedger(root) {
  const dir = path.join(root, 'ledger');
  const out = { dir, files: 0, rows: 0, badLines: [], uniqueSidTurn: 0, uniqueCode: 0, dates: [] };
  const keys = new Set(), codes = new Set();
  for (const name of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    out.files += 1;
    out.dates.push(name.slice(0, 10));
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const r = JSON.parse(line);
        out.rows += 1;
        if (r && r.sid != null && r.turn != null) keys.add(`${r.sid}|${r.turn}`);
        if (r && r.code) codes.add(String(r.code));
      } catch { out.badLines.push(`${name}:${i + 1}`); }
    });
  }
  out.uniqueSidTurn = keys.size;
  out.uniqueCode = codes.size;
  return out;
}

// ---------- tick 度量：written 累计 + 端到端 tick ----------
function scanTicks(root) {
  const file = path.join(root, 'ledger', '.tick-metrics.jsonl');
  const out = { file, ticks: 0, writtenSum: 0, endToEndTicks: -1, badLines: [] };
  if (!fs.existsSync(file)) return out;
  const seq = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { const t = JSON.parse(line); seq.push(Number(t.written) || 0); } catch { out.badLines.push(i + 1); }
  });
  out.ticks = seq.length;
  out.writtenSum = seq.reduce((s, x) => s + x, 0);
  let cum = 0;
  for (let i = 0; i < seq.length; i += 1) { cum += seq[i]; if (out.endToEndTicks < 0 && cum === out.writtenSum && out.writtenSum > 0) out.endToEndTicks = i + 1; }
  out.steadyTicks = seq.filter((x) => x === 0).length;
  return out;
}

// ---------- 索引：state 与分片行数 ----------
function scanIndex(root) {
  const dir = path.join(root, 'ledger', '.index');
  const out = { stateRows: -1, shards: 0, shardRows: 0, badLines: [] };
  const st = path.join(dir, '.idx-state.json');
  if (fs.existsSync(st)) { try { const j = JSON.parse(fs.readFileSync(st, 'utf8')); out.stateRows = Number(j.rows) || 0; out.shardsDeclared = Number(j.shards) || 0; } catch { out.stateParseError = true; } }
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).filter((n) => /^idx-\d{8}\.jsonl$/.test(n)).sort()) {
    out.shards += 1;
    fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { JSON.parse(line); out.shardRows += 1; } catch { out.badLines.push(`${name}:${i + 1}`); }
    });
  }
  return out;
}

// ---------- import 自查：整目录（含归档）不得 import 插件模块 ----------
function selfCheck() {
  const files = [SELF];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs') && p !== SELF) files.push(p);
    }
  })(HERE);
  const rows = [];
  const problems = [];
  for (const f of files.sort()) {
    const rel = path.relative(HERE, f).split(path.sep).join('/');
    const src = fs.readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/^import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of specs) {
      const builtin = s.startsWith('node:');
      const local = s.startsWith('.');
      const inside = local && !path.relative(HERE, path.resolve(path.dirname(f), s)).startsWith('..');
      const forbidden = /(^|[\\/])(index\.js|lib|tools|freeze)([\\/]|$)/.test(s);
      if (!builtin && !inside) problems.push(`${rel}: import '${s}' 不是 node: 内建，且不在 docs/复核器 内`);
      if (forbidden) problems.push(`${rel}: import '${s}' 命中插件路径`);
    }
    rows.push({ file: rel, sha256: crypto.createHash('sha256').update(src).digest('hex'), imports: specs });
  }
  return { ok: problems.length === 0, checked: rows.length, rows, problems, rule: 'import 只允许 node: 内建；相对 import 必须落在 docs/复核器 内；不得出现 index.js/lib/tools/freeze 路径' };
}

// ---------- 主流程 ----------
if (has('help')) {
  console.log('独立复核器 ' + VERSION + '\n用法: node docs\\复核器\\独立复核.mjs --lab=<lab> [--json] [--expect-rows=1338] [--self-check]\n只读；--self-check 打印 docs/复核器 全部 .mjs 的 import 表并断言不 import 插件。');
  process.exit(0);
}
if (has('self-check')) {
  const sc = selfCheck();
  emit({ schema: VERSION, mode: 'self-check', at: new Date().toISOString(), self: { file: path.relative(HERE, SELF).split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(SELF)).digest('hex') }, ...sc }, JSON.stringify(sc, null, 2));
  process.exit(sc.ok ? 0 : 1);
}
const lab = path.resolve(argOf('lab', path.resolve(HERE, '..', '..', 'lab-e3-accept')));
const root = path.join(lab, 'root');
if (!fs.existsSync(path.join(root, 'ledger'))) { console.error(`[用法错误] ${lab} 下缺 root\\ledger`); process.exit(2); }
const sessionsDir = [path.join(lab, 'dsh-home', 'sessions'), path.join(lab, 'sessions')].find((p) => fs.existsSync(p));
if (!sessionsDir) { console.error(`[用法错误] ${lab} 下缺 dsh-home\\sessions（或 sessions）`); process.exit(2); }

const t0 = Date.now();
const sessions = scanSessions(sessionsDir);
const ledger = scanLedger(root);
const ticks = scanTicks(root);
const index = scanIndex(root);
const expectRows = argOf('expect-rows', '');
const checks = [
  { id: 'R1', desc: '源会话闭合轮(turn/end) == 台账行', ok: sessions.closedTurns === ledger.rows, got: `${sessions.closedTurns} vs ${ledger.rows}` },
  { id: 'R2', desc: '台账 (sid,turn) 唯一 == 台账行', ok: ledger.uniqueSidTurn === ledger.rows, got: `${ledger.uniqueSidTurn} vs ${ledger.rows}` },
  { id: 'R3', desc: '台账 code 唯一 == 台账行', ok: ledger.uniqueCode === ledger.rows, got: `${ledger.uniqueCode} vs ${ledger.rows}` },
  { id: 'R4', desc: 'tick written 累计 == 台账行', ok: ticks.writtenSum === ledger.rows, got: `${ticks.writtenSum} vs ${ledger.rows}` },
  { id: 'R5', desc: '端到端 tick 在 1..3 内', ok: ticks.endToEndTicks >= 1 && ticks.endToEndTicks <= 3, got: ticks.endToEndTicks },
  { id: 'R6', desc: '索引 state.rows == 台账行', ok: index.stateRows === ledger.rows, got: `${index.stateRows} vs ${ledger.rows}` },
  { id: 'R7', desc: '索引分片行累计 == 台账行', ok: index.shardRows === ledger.rows, got: `${index.shardRows} vs ${ledger.rows}` },
  { id: 'R8', desc: '无坏行/坏 JSON/帧尾不齐', ok: ledger.badLines.length + sessions.badJson + ticks.badLines.length + index.badLines.length === 0 && sessions.files.every((f) => f.frameEndsAtEof), got: `ledgerBad=${ledger.badLines.length} jsonBad=${sessions.badJson} tickBad=${ticks.badLines.length} idxBad=${index.badLines.length}` },
  { id: 'R9', desc: `期望行数 ${expectRows || '(未指定)'}`, ok: !expectRows || Number(expectRows) === ledger.rows, got: expectRows ? `${expectRows} vs ${ledger.rows}` : 'skip' },
];
const pass = checks.every((c) => c.ok);
const report = { schema: VERSION, at: new Date().toISOString(), lab, readOnly: true, ms: Date.now() - t0, sessions, ledger: { rows: ledger.rows, files: ledger.files, badLines: ledger.badLines, uniqueSidTurn: ledger.uniqueSidTurn, uniqueCode: ledger.uniqueCode, firstDate: ledger.dates[0], lastDate: ledger.dates[ledger.dates.length - 1] }, ticks, index, expectRows: expectRows || null, checks, pass, note: '数字全部现场计算，不写死结论；只读，不写任何文件。闭合轮口径=源会话 turn/end 事件数（独立于插件配对实现）。' };
const lines = [`独立复核 ${pass ? 'PASS' : 'FAIL'} · ${VERSION} · ${report.ms} ms`, `源会话：${sessions.files.map((f) => `${f.file} frames=${f.frames} closed=${f.closedTurns}`).join(' | ')}`, `台账：${ledger.rows} 行 / ${ledger.files} 文件 / 坏行 ${ledger.badLines.length}`, `tick：${ticks.ticks} 条 / written 累计 ${ticks.writtenSum} / 端到端 ${ticks.endToEndTicks} tick`, `索引：state=${index.stateRows} / 分片累计=${index.shardRows}`, ...checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.id} ${c.desc}（${c.got}）`)];
emit(report, lines.join('\n'));
process.exit(pass ? 0 : 1);
