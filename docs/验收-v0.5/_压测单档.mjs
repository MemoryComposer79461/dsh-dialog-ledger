/**
 * @file _压测单档.mjs
 * @role 压测套件的**单档工作进程**（由 `跑压测.mjs` 用 `--max-old-space-size=384` 拉起）。
 *
 * 为什么单独进程：
 *   · RSS 峰值只测这一档，不受其它档影响；
 *   · 要炸只炸测试自己（父进程只等退出码 + 读结果文件，**不用 pipe**，避免受限沙箱 EPERM）；
 *   · 结果写 JSON 文件，父进程读文件合并（跨机拷贝也方便）。
 *
 * 一档做什么：
 *   ① 流式生成该档合成会话（1/4/16/36 MB 解压后，同构：长工具参数 + turn/start+end）；
 *   ② 首跑完整验收：runOnce（weekly + handover 全开）→ 台账行数/原文数/周记账/交接表；
 *   ③ 二跑幂等：written=0；
 *   ④ 全程采样 RSS 峰值。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { generateBigSession, verifyBigSession } from './生成大会话.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) out[m[1]] = m[2]; }
  return out;
}
const args = parseArgs(process.argv);
const tierMB = Number(args['tier-mb'] || 1);
const outFile = args.out;
const ts = () => new Date().toISOString();
const t0 = Date.now();
let peakRssMB = 0;
function sampleRss() {
  const rss = process.memoryUsage().rss / (1024 * 1024);
  if (rss > peakRssMB) peakRssMB = rss;
}
sampleRss();
const sampler = setInterval(sampleRss, 25);
sampler.unref?.();

const result = {
  schema: 'v0.5-stress-tier/1',
  hostname: os.hostname(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  tierMB,
  startedAt: ts(),
  finishedAt: '',
  durationMs: 0,
  peakRssMB: 0,
  session: null,
  ingest: null,
  assertions: {},
  pass: false,
  failures: [],
  error: '',
};

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function writeOut() {
  result.finishedAt = ts();
  result.durationMs = Date.now() - t0;
  result.peakRssMB = Math.round(peakRssMB);
  if (!outFile) return;
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8'); } catch (e) { console.error('写结果失败：' + e.message); }
}

process.on('exit', () => { try { clearInterval(sampler); writeOut(); } catch { /* ignore */ } });

try {
  const sessionFile = path.join(os.tmpdir(), 'v05-stress', `tier-${tierMB}mb.jsonl.zstd`);
  const strict = tierMB >= 36;
  console.log(`[tier ${tierMB}MB] 生成合成会话（strict=${strict}，heap=${Math.round(process.memoryUsage().heapTotal / 1048576)}MB）…`);
  const gen = generateBigSession({ out: sessionFile, targetMB: tierMB, strict, batchTurns: 10 });
  sampleRss();
  const verify = verifyBigSession({ file: sessionFile, minMB: tierMB, minTurns: strict ? 1000 : 0 });
  result.session = {
    file: sessionFile, fileBytes: fs.statSync(sessionFile).size,
    uncompressedBytes: verify.uncompressedBytes, turns: gen.turns, frames: gen.frames,
    genDurationMs: gen.durationMs, genPeakRssMB: gen.peakRssMB, genOk: gen.ok, verifyOk: verify.ok,
    sha256: verify.sha256,
  };
  result.assertions.sessionOk = gen.ok && verify.ok;

  // 装入独立实验室（临时 DSH_HOME / root）
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `v05-stress-${tierMB}mb-`));
  const home = path.join(base, 'dsh-home');
  const root = path.join(base, 'ledger-root');
  const sid = 'session-bigv05-0000-1111-2222-333344445555';
  const sessDir = path.join(home, 'sessions', 'wsBig', sid);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.copyFileSync(sessionFile, path.join(sessDir, 'session.v4.jsonl.zstd'));
  fs.mkdirSync(root, { recursive: true });
  process.env.DSH_HOME = home;

  const idx = await import(new URL('../../index.js', import.meta.url).href);
  const led = await import(new URL('../../lib/ledger.js', import.meta.url).href);
  const logs = [];
  const logger = { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERROR ' + m) };
  const cfg = {
    root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
    hotWindowSeconds: 0, quietSeconds: 0, scanBudgetMs: 0, maxBytesPerSession: 0,
    checkupEnabled: false, weeklyEnabled: true, handoverEnabled: true,
  };
  const ingestT0 = Date.now();
  const r1 = await idx.runOnce({ logger }, cfg);
  sampleRss();
  const r2 = await idx.runOnce({ logger }, cfg);
  sampleRss();
  const ledger = led.readAll(root);
  const arts = [];
  (function walk(d, b) {
    for (const n of fs.readdirSync(d)) {
      if (n === 'ledger') continue;
      const p = path.join(d, n); const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, b); else arts.push(path.relative(b, p).split(path.sep).join('/'));
    }
  })(root, root);
  const originals = arts.filter((r) => /完整原文\.md$/.test(r));
  const xlsx = arts.filter((r) => r.endsWith('.xlsx'));
  const handover = arts.filter((r) => /的记忆数据库的启用及交接表\.md$/.test(r));
  const expectedTurns = verify.turns;
  const a = {
    firstRunWroteAll: Number(r1.written) === expectedTurns,
    ledgerRows: ledger.records.length === expectedTurns,
    originals: originals.length === expectedTurns,
    weeklyBook: xlsx.length >= 1,
    handoverBook: handover.length >= 1,
    secondRunIdempotent: Number(r2.written) === 0,
    errors: (r1.errors || []).length === 0 && (r2.errors || []).length === 0,
    uniqueTurn: new Set(ledger.records.map((r) => `${r.sid}#${r.turn}`)).size === ledger.records.length,
  };
  result.ingest = {
    rounds: 2, expectedTurns, written1: r1.written, written2: r2.written,
    ledgerRows: ledger.records.length, originals: originals.length, weeklyBooks: xlsx.length,
    handoverBooks: handover.length, durationMs: Date.now() - ingestT0,
    errors: (r1.errors || []).concat(r2.errors || []).slice(0, 10),
  };
  result.assertions = { ...result.assertions, ...a };
  result.failures = Object.entries(result.assertions).filter(([, v]) => !v).map(([k]) => k);
  result.pass = result.failures.length === 0;
  result.codeSha256 = { 'index.js': sha(path.join(PLUGIN, 'index.js')), 'lib/ledger.js': sha(path.join(PLUGIN, 'lib/ledger.js')), 'package.json': sha(path.join(PLUGIN, 'package.json')) };
  try { result.version = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version; } catch { result.version = ''; }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  result.durationMs = Date.now() - t0;
  result.peakRssMB = Math.round(peakRssMB);
  console.log(`[tier ${tierMB}MB] ${result.pass ? 'PASS' : 'FAIL'}：written=${r1.written}/${r2.written} 台账=${ledger.records.length} 原文=${originals.length} 周账=${xlsx.length} 交接表=${handover.length} RSS峰=${result.peakRssMB}MB 耗时=${result.durationMs}ms`);
} catch (e) {
  result.error = (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e));
  result.failures.push('script-error');
  console.error('[tier ' + tierMB + 'MB] ERROR：' + result.error);
}

writeOut();
process.exit(result.pass ? 0 : 1);
