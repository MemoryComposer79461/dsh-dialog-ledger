// P0-2 验收：大文件在"字节预算"下分批读完，且不漏不重。
//
// 用法：node docs/工具-v02-分批压测.mjs [轮数] [每次字节预算MB]
// 产物落 %TEMP%\dl-batch\，跑完即删。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURNS = Number(process.argv[2] || 8000);
const BUDGET_MB = Number(process.argv[3] || 8);

const dir = path.join(os.tmpdir(), 'dl-batch');
const home = path.join(dir, 'home');
const root = path.join(dir, 'root');
fs.rmSync(dir, { recursive: true, force: true });
process.env.DSH_HOME = home;

const sid = 'session-batchsample-0001';
const sessDir = path.join(home, 'sessions', '--lab--', sid);
fs.mkdirSync(sessDir, { recursive: true });
const file = path.join(sessDir, 'session.v4.jsonl.zstd');

const base = Date.now() - 3600_000;
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
let seed = 20261108;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
const tok = (n) => Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');

const fd = fs.openSync(file, 'w');
fs.writeSync(fd, frame([JSON.stringify({ type: 'session', id: sid, createdAt: base, cwd: 'D:\\lab' })]));
for (let n = 1; n <= TURNS; n++) {
  const t = base + n * 60_000;
  fs.writeSync(fd, frame([JSON.stringify({ type: 'turn/start', time: t, data: { turn: n } })]));
  for (let i = 0; i < 6; i++) {
    fs.writeSync(fd, frame([JSON.stringify({ type: 'assistant/message', time: t + i, data: { message: { content: [{ type: 'text', text: tok(1500) }] } } })]));
  }
  fs.writeSync(fd, frame([JSON.stringify({ type: 'turn/end', time: t + 900, data: { turn: n, reason: { kind: 'completed' } } })]));
}
fs.closeSync(fd);

const size = fs.statSync(file).size;
console.log(`样本: ${TURNS} 轮 / ${(size / 1024 / 1024).toFixed(2)} MB | 每次预算 ${BUDGET_MB} MB`);

const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const cfg = {
  root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
  hotWindowSeconds: 0, quietSeconds: 120,
  scanBudgetMs: 3000, maxBytesPerSession: BUDGET_MB * 1024 * 1024,
};

let round = 0;
let maxRounds = 200;
let finished = false;
while (round < maxRounds) {
  round++;
  const t0 = performance.now();
  const st = await idx.runOnce({ logger: { info() {}, warn() {} } }, cfg);
  const ms = performance.now() - t0;
  console.log(`  第 ${String(round).padStart(2)} 轮: ${ms.toFixed(0)} ms | written=${st.written} part=${st.partialReads} defer=${st.deferred} errors=${st.errors.length}`);

  const stPath = path.join(root, 'ledger', '.state.json');
  const stt = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  const cursors = Object.values(stt.sourceCursors || {});
  if (cursors.length && cursors.every((c) => c.offset >= c.size)) { finished = true; break; }
  if (st.written === 0 && st.partialReads === 0) { finished = true; break; }
}

const recs = [];
for (const f of fs.readdirSync(path.join(root, 'ledger')).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))) {
  recs.push(...fs.readFileSync(path.join(root, 'ledger', f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}
const codes = new Set(recs.map((r) => r.code));
const keys = new Set(recs.map((r) => r.sid + '#' + r.turn));
console.log(`\n结果: ${round} 轮跑完 | 记录 ${recs.length} / 期望 ${TURNS} | code 唯一 ${codes.size} | (sid,turn) 唯一 ${keys.size} | ${finished ? '已读完' : '未读完'}`);
process.exitCode = (recs.length === TURNS && codes.size === TURNS && keys.size === TURNS && finished) ? 0 : 1;
fs.rmSync(dir, { recursive: true, force: true });
