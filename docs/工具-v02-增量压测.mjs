// v0.2 增量读压测：证明"没变就不读、变了只读新增"。
//
// 用法：node docs/工具-v02-增量压测.mjs [轮数]
// 产物落在 %TEMP%\dl-v02\，跑完即删。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是手撕 URL：中文路径会被百分号编码，手撕必错。
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURNS = Number(process.argv[2] || 1315);
const dir = path.join(os.tmpdir(), 'dl-v02');
const home = path.join(dir, 'home');
const root = path.join(dir, 'root');
fs.rmSync(dir, { recursive: true, force: true });
// ★ 必须先把 DSH_HOME 指到临时目录：runOnce 内部读 process.env.DSH_HOME，
//   忘了设就会去扫真实的 ~/.dsh —— 那样压测对象是错的，还会把真会话记进临时台账。
process.env.DSH_HOME = home;

const sid = 'session-v02sample-0001';
const sessDir = path.join(home, 'sessions', '--lab--', sid);
fs.mkdirSync(sessDir, { recursive: true });
const file = path.join(sessDir, 'session.v4.jsonl.zstd');

let seed = 20261108;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
const tok = (n) => Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');

const base = Date.now() - 3600_000;
const head = JSON.stringify({ type: 'session', id: sid, createdAt: base, cwd: 'D:\\lab' });
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));

/** 造一轮：切成若干帧（每帧 2 行），模拟 DSH 的分批追加。 */
function turnFrames(n, fromMs) {
  const lines = [];
  for (let i = 0; i < 8; i++) {
    lines.push(JSON.stringify({
      type: 'assistant/message',
      time: fromMs + i,
      data: { message: { content: [{ type: 'text', text: tok(1200) }] } },
    }));
  }
  return [
    [JSON.stringify({ type: 'turn/start', time: fromMs, data: { turn: n } })],
    ...chunk(lines, 2),
    [JSON.stringify({ type: 'turn/end', time: fromMs + 900, data: { turn: n, reason: { kind: 'completed' } } })],
  ];
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ★ 边生成边写盘：先把 30 万帧塞进数组再 Buffer.concat，
//   在 229 MB 这一档会先把**生成器**自己撑爆（半空间提交失败），
//   于是测的就不是插件了。改成逐帧 writeSync，生成器内存恒定。
const fd = fs.openSync(file, 'w');
fs.writeSync(fd, frame([head]));
for (let n = 1; n <= TURNS; n++) {
  for (const group of turnFrames(n, base + n * 60_000)) fs.writeSync(fd, frame(group));
}
fs.closeSync(fd);

const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const cfg = { root, intervalSeconds: 60, enabled: true, offsetMinutes: 480, hotWindowSeconds: 0, quietSeconds: 120 };
const log = { info: () => {}, warn: () => {} };

const size = fs.statSync(file).size;
console.log(`样本: ${TURNS} 轮, ${(size / 1024 / 1024).toFixed(2)} MB`);

async function run(label) {
  const t0 = performance.now();
  const st = await idx.runOnce({ logger: log }, cfg);
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(1)} ms  written=${st.written} skipped=${st.skipped} same=${st.unchanged} inc=${st.incremental}`);
  return st;
}

await run('① 首跑（全量）');
await run('② 再跑（文件没变 → 应 same=1、wrote=0）');

// ③ 追加一轮后：应只读新增部分
const extra = turnFrames(TURNS + 1, base + (TURNS + 1) * 60_000).map(frame);
fs.appendFileSync(file, Buffer.concat(extra));
await run('③ 追加一轮后（应 inc=1、wrote=1）');

const recs = [];
for (const n of fs.readdirSync(path.join(root, 'ledger'))) {
  if (!n.endsWith('.jsonl') || n.startsWith('.')) continue; // .lost.jsonl 是缺口留痕，不是账
  recs.push(...fs.readFileSync(path.join(root, 'ledger', n), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}
const codes = new Set(recs.map((r) => r.code));
const keys = new Set(recs.map((r) => r.sid + '#' + r.turn));
console.log(`台账: ${recs.length} 条 / code 唯一 ${codes.size} / (sid,turn) 唯一 ${keys.size}`);
console.log(`样例: ${recs[0].code}  dateFrom=${recs[0].dateFrom} offset=${recs[0].dateOffset} v=${recs[0].v}`);
fs.rmSync(dir, { recursive: true, force: true });
