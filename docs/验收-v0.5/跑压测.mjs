#!/usr/bin/env node
/**
 * @file 跑压测.mjs
 * @role **可搬运的异机压测套件 · 单入口**：一条命令跑完四档（1/4/16/36 MB，解压后），
 *       记录每档 RSS 峰值，断言"内存不随规模线性增长"，并把"36MB 单次完整验收"作为一档内断言。
 *
 * 机主 2026-11-09 决定：压力测试可以**在另一台设备执行，然后带回测试报告**。
 * 所以本脚本（连同同目录的 `生成大会话.mjs`/`_压测单档.mjs`/`_runner.mjs`/`_lab.mjs` 等）**整目录拷走即可运行**：
 *   · 零依赖：只用 Node 内置模块（Node ≥ 24，内置 zstd）；不 npm install、不联网；
 *   · Windows / Linux 均可；
 *   · 单入口：`node 跑压测.mjs`；
 *   · 产物：`结果-<主机名>-<yyyyMMdd-HHmmss>.json` + `报告-<主机名>-<时间>.md`（三张表）；
 *   · 带回后由 `合并异机结果.mjs` 并入本地验收报告（本机/异机两栏）。
 *
 * 内存护栏（Lead 2026-11-09）：每档子进程用 `--max-old-space-size=384`，`stdio:'inherit'`（不用 pipe，
 * 受限沙箱下管道会 EPERM）；本机可用内存 < 900 MB 时默认跳过 36MB 档（重启前只跑小样本），
 * 用 `--force-36` 可强制。
 *
 * 用法：
 *   node docs/验收-v0.5/跑压测.mjs [--out-dir=docs/验收-v0.5/压测结果] [--tiers=1,4,16,36] [--heap=384] [--force-36]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const WORKER = path.join(HERE, '_压测单档.mjs');
const MIN_FREE_FOR_36_MB = 900; // 与 docs/跑测试.mjs 的看护阈值一致

function parseArgs(argv) {
  const out = { outDir: path.join(HERE, '压测结果'), tiers: [1, 4, 16, 36], heap: 384, force36: false };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) {
      if (a === '--force-36') out.force36 = true;
      continue;
    }
    if (m[1] === 'out-dir') out.outDir = path.resolve(m[2]);
    else if (m[1] === 'tiers') out.tiers = m[2].split(',').map(Number).filter((n) => n > 0);
    else if (m[1] === 'heap') out.heap = Number(m[2]);
  }
  return out;
}
const args = parseArgs(process.argv);
fs.mkdirSync(args.outDir, { recursive: true });

const freeMemMB = () => Math.round(os.freemem() / (1024 * 1024));
const totalMemMB = Math.round(os.totalmem() / (1024 * 1024));
const cpuCores = os.cpus().length;
const hostname = os.hostname();
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function codeManifest() {
  const out = {};
  const add = (rel) => { const p = path.join(PLUGIN, rel); if (fs.existsSync(p)) out[rel] = { sha256: sha(p), bytes: fs.statSync(p).size }; };
  add('index.js'); add('package.json');
  for (const n of fs.readdirSync(path.join(PLUGIN, 'lib')).sort()) add(path.join('lib', n));
  return out;
}
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

const runStamp = stamp();
const results = [];
const skipped = [];
console.log(`\n===== v0.5 可搬运压测套件 =====`);
console.log(`主机 ${hostname}｜${process.platform}/${process.arch}｜Node ${process.version}｜CPU ${cpuCores} 核｜总内存 ${totalMemMB}MB｜可用 ${freeMemMB()}MB`);
console.log(`被测：${PLUGIN}（version=${version() || '?'}）`);
console.log(`档位：${args.tiers.join(' / ')} MB（解压后）；heap 上限 ${args.heap}MB；stdout=inherit（不用 pipe）\n`);

for (const tier of args.tiers) {
  const need36 = tier >= 36;
  if (need36 && !args.force36 && freeMemMB() < MIN_FREE_FOR_36_MB) {
    const why = `内存护栏：可用 ${freeMemMB()}MB < ${MIN_FREE_FOR_36_MB}MB，跳过 ${tier}MB 档（重启前只跑小样本；可 --force-36 强制，或到异机跑）`;
    console.log(`[SKIP] ${tier}MB 档：${why}`);
    skipped.push({ tierMB: tier, reason: why });
    continue;
  }
  const tierOut = path.join(args.outDir, `_原始-${tier}MB.json`);
  try { fs.unlinkSync(tierOut); } catch { /* ignore */ }
  const t0 = Date.now();
  console.log(`\n----- ${tier}MB 档（子进程 heap=${args.heap}MB）-----`);
  const r = spawnSync(process.execPath, [`--max-old-space-size=${args.heap}`, WORKER, `--tier-mb=${tier}`, `--out=${tierOut}`], {
    stdio: 'inherit', // ★ 不用 pipe：受限沙箱下 pipe 会 EPERM；也让进度直接出现在终端
    timeout: 600_000,
    env: { ...process.env },
  });
  let data = null;
  try { data = JSON.parse(fs.readFileSync(tierOut, 'utf8')); } catch { data = null; }
  const rec = data || { tierMB: tier, pass: false, failures: ['no-result'], error: `child exit=${r.status}`, peakRssMB: 0, durationMs: Date.now() - t0 };
  results.push(rec);
  console.log(`[${rec.pass ? 'PASS' : 'FAIL'}] ${tier}MB 档：RSS峰=${rec.peakRssMB}MB 耗时=${rec.durationMs}ms${rec.pass ? '' : ' 失败=' + JSON.stringify(rec.failures)}`);
}

// ---- 断言 1：执行到的档全部通过 ----
const execd = results.filter((r) => r && r.tierMB);
const tierFails = execd.filter((r) => !r.pass).map((r) => r.tierMB);
// ---- 断言 2：RSS 峰值不随规模线性增长 ----
let memLinearity = { ok: false, detail: '档位不足（<2 档），无法判断' };
if (execd.length >= 2) {
  const sorted = [...execd].sort((a, b) => a.tierMB - b.tierMB);
  const small = sorted[0];
  const big = sorted[sorted.length - 1];
  const sizeRatio = big.tierMB / small.tierMB;
  const peakRatio = (big.peakRssMB || 1) / (small.peakRssMB || 1);
  const peakCapOk = execd.every((r) => Number(r.peakRssMB) <= 600);
  memLinearity = {
    ok: peakRatio < sizeRatio && peakCapOk,
    detail: `档 ${small.tierMB}MB→${big.tierMB}MB（体积 ×${sizeRatio}）：RSS 峰 ${small.peakRssMB}→${big.peakRssMB}MB（×${peakRatio.toFixed(2)}，须 < ${sizeRatio}）；每档 ≤600MB=${peakCapOk}`,
    sizeRatio, peakRatio, peakCapOk,
  };
}
// ---- 断言 3：36MB 单次完整验收（若跑了 36 档）----
const tier36 = execd.find((r) => r.tierMB >= 36);
const fullAccept36 = tier36
  ? { ok: tier36.pass === true && tier36.assertions && tier36.assertions.firstRunWroteAll && tier36.assertions.secondRunIdempotent,
    detail: `36MB 单次完整验收：written=${tier36.ingest && tier36.ingest.written1}/${tier36.ingest && tier36.ingest.written2}、台账=${tier36.ingest && tier36.ingest.ledgerRows}、原文=${tier36.ingest && tier36.ingest.originals}、周账=${tier36.ingest && tier36.ingest.weeklyBooks}、交接表=${tier36.ingest && tier36.ingest.handoverBooks}` }
  : { ok: false, detail: '36MB 档未执行（内存护栏跳过）→ 未覆盖' };

const assertions = {
  tiersExecuted: execd.map((r) => r.tierMB),
  allExecutedTiersPass: tierFails.length === 0,
  tiersFail: tierFails,
  memNotLinear: memLinearity.ok,
  memDetail: memLinearity.detail,
  fullAccept36: fullAccept36.ok,
  fullAccept36Detail: fullAccept36.detail,
  skippedTiers: skipped.map((s) => s.tierMB),
};
const tier36Requested = args.tiers.some((t) => t >= 36);
const tier36Uncovered = !tier36Requested || skipped.some((s) => s.tierMB >= 36) || !fullAccept36.ok;
// ★ 勘误（Lead 2026-11-09 夜）：原式是 `!(tier36Requested && !tier36Uncovered)`，
//   多了一个 `!` —— 语义变成"要求 36MB 档**未覆盖**才算通过"，
//   于是 36MB 真跑成功时反而判 FAIL（实测：四档全 PASS、三条断言全 true，总体却 exit=1）。
//   正确语义：**请求了 36MB 就必须覆盖到**，没覆盖到才算不通过。
const pass = assertions.allExecutedTiersPass && assertions.memNotLinear && !(tier36Requested && tier36Uncovered);

const payload = {
  schema: 'v0.5-stress/1',
  hostname,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cpuCores,
  totalMemMB,
  freeMemMBAtStart: freeMemMB(),
  startedAt: new Date(Date.now()).toISOString(),
  runStamp,
  version: version(),
  target: PLUGIN,
  codeSha256: codeManifest(),
  heapLimitMB: args.heap,
  tiers: results.map((r) => ({
    tierMB: r.tierMB, pass: r.pass, peakRssMB: r.peakRssMB, durationMs: r.durationMs,
    session: r.session || null, ingest: r.ingest || null, assertions: r.assertions || null,
    failures: r.failures || [], error: r.error || '',
  })),
  skippedTiers: skipped,
  assertions,
  rssPeakByTier: Object.fromEntries(results.map((r) => [`${r.tierMB}MB`, r.peakRssMB])),
  durationMs: 0,
  pass,
  unfinished: [...(tier36Requested ? [] : ['36MB（未请求，未覆盖）']), ...skipped.map((s) => `${s.tierMB}MB`)],
};
payload.finishedAt = new Date().toISOString();
payload.durationMs = (Date.parse(payload.finishedAt) - Date.parse(payload.startedAt)) || 0;

const outJson = path.join(args.outDir, `结果-${hostname}-${runStamp}.json`);
fs.writeFileSync(outJson, JSON.stringify(payload, null, 2) + '\n', 'utf8');

// ---- 人读报告（三张表：通过 / 失败 / 未覆盖）----
const L = [];
L.push(`# v0.5 异机压测报告（${hostname}）`, '');
L.push(`> 生成：\`node docs/验收-v0.5/跑压测.mjs\` ｜ 时间：${payload.startedAt} ~ ${payload.finishedAt} ｜ 耗时 ${(payload.durationMs / 1000).toFixed(1)}s`);
L.push(`> 主机：${hostname}｜${payload.platform}/${payload.arch}｜Node ${payload.node}｜CPU ${cpuCores} 核｜总内存 ${totalMemMB}MB｜可用 ${payload.freeMemMBAtStart}MB`);
L.push(`> 被测代码：\`${PLUGIN}\` ｜ package.json version=\`${payload.version || '?'}\` ｜ heap 上限 ${payload.heapLimitMB}MB`);
L.push('');
L.push('## 0. 结论', '');
L.push(`- 执行档位：${assertions.tiersExecuted.join(' / ') || '（无）'} MB；跳过档位：${assertions.skippedTiers.join(' / ') || '（无）'} MB；**总体 ${pass ? '通过 ✅' : '未通过 ❌'}**`);
L.push(`- 内存曲线断言：${assertions.memNotLinear ? '通过 ✅' : '失败 ❌'} —— ${assertions.memDetail}`);
L.push(`- 36MB 单次完整验收：${assertions.fullAccept36 ? '通过 ✅' : '未通过/未执行 ❌'} —— ${assertions.fullAccept36Detail}`);
L.push('');
L.push('## 1. 通过（档位/断言）', '');
L.push('| 档位 | RSS 峰值 | 耗时 | 首跑 written | 二跑 written | 台账/原文/周账/交接表 |');
L.push('| ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of execd) {
  const ok = r.pass && r.assertions && Object.values(r.assertions).every(Boolean);
  L.push(`| ${r.tierMB}MB${ok ? ' ✅' : ' ❌'} | ${r.peakRssMB}MB | ${r.durationMs}ms | ${r.ingest ? r.ingest.written1 : '?'} | ${r.ingest ? r.ingest.written2 : '?'} | ${r.ingest ? `${r.ingest.ledgerRows}/${r.ingest.originals}/${r.ingest.weeklyBooks}/${r.ingest.handoverBooks}` : '—'} |`);
}
L.push('');
L.push('## 2. 失败（可复现命令 + 最小证据）', '');
const failedTiers = execd.filter((r) => !r.pass);
if (!failedTiers.length && assertions.memNotLinear) L.push('（无）');
for (const r of failedTiers) L.push(`- **${r.tierMB}MB 档**：\`node docs/验收-v0.5/跑压测.mjs --tiers=${r.tierMB}\` → 失败断言 ${JSON.stringify(r.failures)}${r.error ? '；error=' + r.error : ''}`);
if (!assertions.memNotLinear) L.push(`- **内存曲线**：${assertions.memDetail} → \`node docs/验收-v0.5/跑压测.mjs\``);
L.push('');
L.push('## 3. 未覆盖（必须写原因）', '');
if (!skipped.length) L.push('（无）');
for (const s of skipped) L.push(`- **${s.tierMB}MB 档**：${s.reason}`);
if (!skipped.some((s) => s.tierMB >= 36)) L.push(tier36Requested ? '- 无（36MB 档已执行）' : '- **36MB 档未请求**（本轮 `--tiers` 未包含 36MB；未覆盖原因=调用方只要求小样本）');
L.push('');
L.push('## 4. 结果合并', '');
L.push('把本文件与同目录 `结果-*.json` 带回后，在本机执行：');
L.push('```');
L.push('node docs/验收-v0.5/合并异机结果.mjs --remote-dir="<带回的结果目录>"');
L.push('```');
L.push('即可把异机结果并入本地验收报告的「本机 / 异机」两栏（覆盖说明见合并脚本输出）。');
L.push('');
L.push('## 5. 代码清单（SHA256）', '');
L.push('| 文件 | SHA256 | 字节 |');
L.push('| --- | --- | ---: |');
for (const [rel, info] of Object.entries(payload.codeSha256)) L.push(`| \`${rel}\` | \`${info.sha256}\` | ${info.bytes} |`);
L.push('');
const outMd = path.join(args.outDir, `报告-${hostname}-${runStamp}.md`);
fs.writeFileSync(outMd, L.join('\n'), 'utf8');

console.log(`\n===== 压测完成：${pass ? 'PASS ✅' : 'FAIL ❌'} =====`);
console.log(`结果：${outJson}`);
console.log(`报告：${outMd}`);
process.exitCode = pass ? 0 : 1;
