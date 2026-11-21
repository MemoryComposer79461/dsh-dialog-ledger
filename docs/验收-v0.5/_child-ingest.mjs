/**
 * @file _child-ingest.mjs
 * @role P0-3 的子进程探针：在**独立进程**里跑 runOnce（用于内存上限 / 取消 / 杀进程恢复验收）。
 *
 * 为什么要子进程：
 *   · 内存峰值采样不能污染主验收进程；
 *   · kill -9 只能对子进程做（主进程被杀就没人写结果了）；
 *   · 被测代码若真的内存失控，崩的是这个可抛弃的子进程。
 *
 * 用法（由 P0回归-v2.mjs 调用）：
 *   node --max-old-space-size=320 docs/验收-v0.5/_child-ingest.mjs --root=... --home=... --out=...
 *     [--mode=ingest|cancel] [--abort-ms=300] [--deadline-ms=...] [--stop-after-rows=5]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
const root = args.root;
const home = args.home;
const out = args.out;
const mode = args.mode || 'ingest';
const abortMs = Number(args['abort-ms'] || 0);
const deadlineMs = Number(args['deadline-ms'] || 0);
const stopAfterRows = Number(args['stop-after-rows'] || 0);

if (!root || !home) { console.error('missing --root/--home'); process.exit(2); }
process.env.DSH_HOME = home;

const PROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const t0 = Date.now();
let peakRss = 0;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss / (1024 * 1024);
  if (rss > peakRss) peakRss = rss;
}, 50);
sampler.unref?.();

const result = { ok: false, mode, pid: process.pid, durationMs: 0, peakRssMB: 0, stat: null, error: '', aborted: false };
try {
  const idx = await import(pathToFileURL(path.join(PROOT, 'index.js')).href);
  const led = await import(pathToFileURL(path.join(PROOT, 'lib', 'ledger.js')).href);

  const controller = new AbortController();
  let abortTimer = null;
  if (mode === 'cancel' && abortMs > 0) {
    abortTimer = setTimeout(() => { result.aborted = true; controller.abort(); }, abortMs);
    abortTimer.unref?.();
  }
  const logs = [];
  const push = (lv) => (m) => logs.push(`${lv} ${String(m)}`);
  const logger = { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG') };
  const cfg = {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: 480,
    hotWindowSeconds: 0,
    quietSeconds: 0,
    scanBudgetMs: 0,
    maxBytesPerSession: 0,
    checkupEnabled: false,
    weeklyEnabled: false,
    handoverEnabled: false,
    ...(deadlineMs > 0 ? { deadlineMs } : {}),
    ...(mode === 'cancel' ? { signal: controller.signal } : {}),
  };
  const ctx = { logger, ...(mode === 'cancel' ? { signal: controller.signal } : {}) };

  // 可选：跑到已写 N 行就自杀（模拟"被外部 kill 之前已提交批次"的形态）
  if (stopAfterRows > 0) {
    const watch = setInterval(() => {
      try {
        const r = led.readAll(root);
        if (r.records.length >= stopAfterRows) {
          clearInterval(watch);
          fs.writeFileSync(out, JSON.stringify({ ...result, ok: true, stopAfterRows, rows: r.records.length, durationMs: Date.now() - t0, peakRssMB: Math.round(peakRss) }, null, 2));
          process.kill(process.pid, 'SIGKILL');
        }
      } catch { /* ignore */ }
    }, 40);
    watch.unref?.();
  }

  const stat = await idx.runOnce(ctx, cfg);
  if (abortTimer) clearTimeout(abortTimer);
  const ledger = led.readAll(root);
  Object.assign(result, {
    ok: true,
    durationMs: Date.now() - t0,
    stat,
    rows: ledger.records.length,
    rowTurns: ledger.records.map((r) => r.turn).filter((n) => Number.isInteger(n)),
    errors: stat && Array.isArray(stat.errors) ? stat.errors.slice(0, 20) : [],
    logsTail: logs.slice(-10),
  });
} catch (e) {
  Object.assign(result, { ok: false, error: (e && (e.code || '') + ' ' + (e.message || String(e))) || 'unknown', durationMs: Date.now() - t0 });
} finally {
  clearInterval(sampler);
  const rss = process.memoryUsage().rss / (1024 * 1024);
  if (rss > peakRss) peakRss = rss;
  result.peakRssMB = Math.round(peakRss);
  if (out) {
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); } catch { /* ignore */ }
  }
  console.log(JSON.stringify({ ok: result.ok, mode, durationMs: result.durationMs, peakRssMB: result.peakRssMB, rows: result.rows, error: result.error }));
  process.exit(result.ok ? 0 : 1);
}
