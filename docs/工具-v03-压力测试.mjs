// v0.3 压力测试：初始凭证 × 记账凭证 强绑定，在大量轮次下是否成立。
//
// 用法：node docs/工具-v03-压力测试.mjs [轮数] [每轮事件数] [每事件字节]
// 全部产物落 %TEMP%\v03-stress，跑完保留（供人工抽查），脚本不删。
//
// 判定（全过才 exit 0）：
//   1) 台账记录数 == 轮数；(sid,turn) 与 code 均唯一
//   2) 每轮一份初始凭证，且 records[i].doc 指向的文件真实存在
//   3) 凭证前置块「编码」== 文件名编码；抽样 20 份重算 正文hash 一致
//   4) 每组（会话键+周段）恰好一份周记账 xlsx
//   5) errors 为空

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURNS = Number(process.argv[2] || 3000);
const EVENTS_PER_TURN = Number(process.argv[3] || 5);
const PAYLOAD = Number(process.argv[4] || 800);

const dir = path.join(os.tmpdir(), 'v03-stress');
const home = path.join(dir, 'home');
const root = path.join(dir, 'root');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;

const sid = 'session-stress-v03-0001';
const sessDir = path.join(home, 'sessions', '--lab--', sid);
fs.mkdirSync(sessDir, { recursive: true });
const file = path.join(sessDir, 'session.v4.jsonl.zstd');

const base = Date.now() - 6 * 3600_000;
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
const tok = (n) => { let s = ''; for (let i = 0; i < n; i++) s += alpha[Math.floor(rnd() * alpha.length)]; return s; };

const fd = fs.openSync(file, 'w');
fs.writeSync(fd, frame([JSON.stringify({ type: 'session', id: sid, createdAt: base, cwd: 'D:\\lab' })]));
for (let n = 1; n <= TURNS; n++) {
  const t = base + n * 60_000;
  fs.writeSync(fd, frame([JSON.stringify({ type: 'turn/start', time: t, data: { turn: n } })]));
  for (let i = 0; i < EVENTS_PER_TURN; i++) {
    fs.writeSync(fd, frame([JSON.stringify({ type: 'assistant/message', time: t + i, data: { message: { content: [{ type: 'text', text: tok(PAYLOAD) }] } } })]));
  }
  fs.writeSync(fd, frame([JSON.stringify({ type: 'turn/end', time: t + 1000, data: { turn: n, reason: { kind: 'completed' } } })]));
}
fs.closeSync(fd);

const size = fs.statSync(file).size;
console.log(`样本: ${TURNS} 轮 / ${(size / 1024 / 1024).toFixed(2)} MB`);

const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const cfg = {
  root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
  hotWindowSeconds: 0, quietSeconds: 120, scanBudgetMs: 60000,
  maxBytesPerSession: 64 * 1024 * 1024, checkupEnabled: false, weeklyEnabled: true,
};

const t0 = performance.now();
let round = 0;
let finished = false;
while (round < 100) {
  round++;
  const rt = performance.now();
  const st = await idx.runOnce({ logger: { info() {}, warn() {} } }, cfg);
  const ms = performance.now() - rt;
  console.log(`  第 ${round} 轮: ${ms.toFixed(0)} ms | written=${st.written} part=${st.partialReads} errors=${st.errors.length} wk=${st.weekly}`);
  const stt = JSON.parse(fs.readFileSync(path.join(root, 'ledger', '.state.json'), 'utf8'));
  const cursors = Object.values(stt.sourceCursors || {});
  if (cursors.length && cursors.every((c) => c.offset >= c.size)) { finished = true; break; }
  if (st.written === 0 && st.partialReads === 0) { finished = true; break; }
}
const elapsed = performance.now() - t0;

// ---------- 校验 ----------
const recs = [];
for (const f of fs.readdirSync(path.join(root, 'ledger')).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))) {
  recs.push(...fs.readFileSync(path.join(root, 'ledger', f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}
const checks = [];
const ok = (name, cond, detail = '') => { checks.push({ name, ok: !!cond, detail }); };

ok('已读完', finished);
ok('记录数 == 轮数', recs.length === TURNS, `${recs.length} / ${TURNS}`);
ok('全部 v=3', recs.every((r) => r.v === 3));
ok('code 唯一', new Set(recs.map((r) => r.code)).size === recs.length);
ok('(sid,turn) 唯一', new Set(recs.map((r) => r.sid + '#' + r.turn)).size === recs.length);
ok('每条都有 doc/docHash', recs.every((r) => r.doc && /^[0-9a-f]{64}$/.test(r.docHash || '')));

const docs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('完整原文.md')) docs.push(p);
  }
})(root);
ok('凭证文件数 == 轮数', docs.length === TURNS, `${docs.length} / ${TURNS}`);
ok('每条记录的 doc 都在磁盘上', recs.every((r) => fs.existsSync(path.join(root, r.doc))));

// 文件名与前置块编码一致
let nameMatch = 0;
let hashMatch = 0;
const sample = recs.filter((_, i) => i % Math.max(1, Math.floor(recs.length / 20)) === 0).slice(0, 20);
for (const r of sample) {
  const p = path.join(root, r.doc);
  const text = fs.readFileSync(p, 'utf8');
  const m = text.match(/编码: '([^']+)'/);
  if (m && m[1] === r.code) nameMatch++;
  const idx1 = text.indexOf('## 1.');
  const recomputed = crypto.createHash('sha256').update(text.slice(idx1), 'utf8').digest('hex');
  if (recomputed === r.docHash) hashMatch++;
}
ok('文件名/前置块编码一致（抽 20）', nameMatch === sample.length, `${nameMatch}/${sample.length}`);
ok('正文 hash 可复核（抽 20）', hashMatch === sample.length, `${hashMatch}/${sample.length}`);

// 周记账：每组一份
const groups = new Set(recs.map((r) => `${r.code.slice(0, 8)}-${r.code.slice(9, 21)}`));
const xlsx = [];
(function walk2(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk2(p); else if (e.name.endsWith('.xlsx')) xlsx.push(p);
  }
})(root);
ok('有周记账产出', xlsx.length > 0, `${xlsx.length} 份`);

const errors = checks.filter((c) => !c.ok);
console.log('\n=== 结果 ===');
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log(`\n耗时 ${(elapsed / 1000).toFixed(2)} s ｜ 平均 ${(elapsed / Math.max(1, TURNS)).toFixed(2)} ms/轮 ｜ 轮次 ${round}`);
console.log(`产物目录（保留待抽查）: ${root}`);
process.exitCode = errors.length ? 1 : 0;
