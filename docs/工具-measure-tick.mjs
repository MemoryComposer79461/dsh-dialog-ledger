#!/usr/bin/env node
/**
 * @file docs/工具-measure-tick.mjs
 * @role E3 逐 tick 度量生成器（包内自足版；C38「数字脚本生成，不手写」的生成器之一）。
 *
 * @why 审计 P0-02/P1-12（re3）：re2 交付包里 C38 抽查「E3 逐 tick 度量」时生成器只在开发机
 *      `_工作\tools\measure-tick.mjs`，接收端没有 `_工作\` → C38 记 NA。本文件是同一生成器的
 *      包内版（原样移植，零第三方依赖）：从 lab 的 `<root>/ledger/.tick-metrics.jsonl` 读出
 *      逐 tick 度量并输出机读 JSON —— VERSION.json 的 `p3.index`「1,338 行库」与验收记录里的
 *      逐 tick 数字必须能由本脚本（或读取同一文件的判据）复算，不许手写。
 *      本脚本**只读**，不跑 tick、不写账；跑 tick 是判据/lab 构造器的职责。
 *
 * @in    `--lab=<dir>`（lab 根，默认 %TEMP%\dsh-ledger-labs-v1.0.0-re2\lab-e3-accept）
 *        `--root=<dir>`（可选；直接指定账库根，覆盖 <lab>\root）
 *        `--json`（默认就是 JSON；保留参数兼容）
 * @out   stdout JSON；退出码 0=读到度量、1=度量文件缺失、2=用法错误
 * @reads <root>\ledger\.tick-metrics.jsonl、<root>\ledger\*.jsonl
 * @writes 无（纯只读）
 * @depends node:fs/path/url（零第三方依赖）
 * @usage node docs\工具-measure-tick.mjs --lab=<lab> [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const LITE = path.resolve(path.dirname(THIS_FILE), '..');
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const lab = argOf('lab') || path.join(os.tmpdir(), 'dsh-ledger-labs-v1.0.0-re2', 'lab-e3-accept');
const root = path.resolve(argOf('root') || path.join(lab, 'root'));
const metricsFile = path.join(root, 'ledger', '.tick-metrics.jsonl');

if (hasFlag('help') || process.argv.includes('-h')) {
  console.log(`用法：node docs\\工具-measure-tick.mjs --lab=<lab> [--root=<dir>] [--json]
只读生成逐 tick 度量 JSON（written/consumedSourceBytes/ms/端到端 tick 数/稳态 tick 数）。`);
  process.exit(0);
}
for (const a of process.argv.slice(2)) {
  if (!a.startsWith('--')) {
    console.error(`[用法错误] 不认识的裸参数：${a}`);
    process.exit(2);
  }
  const k = a.slice(2).split('=')[0];
  if (!['lab', 'root', 'json', 'help'].includes(k)) {
    console.error(`[用法错误] 不认识的参数 --${k}（可用：--lab --root --json）`);
    process.exit(2);
  }
}

if (!fs.existsSync(metricsFile)) {
  console.error(`[measure-tick] 缺度量文件：${metricsFile}`);
  console.error(`  → 先构造 lab：node docs\\工具-构造lab.mjs --only=e3（lab 落 %TEMP%），或在真实账库上跑过 tick`);
  process.exit(1);
}

const ticks = fs.readFileSync(metricsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

// 逐日台账行数（只读）
let ledgerRows = 0;
let ledgerFiles = 0;
try {
  const dir = path.join(root, 'ledger');
  for (const n of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)) continue;
    ledgerFiles++;
    ledgerRows += fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
  }
} catch { /* 缺账库时保持 0，由 rowsOk 标出 */ }

const perTick = ticks.map((t, i) => ({
  tick: i + 1,
  at: t.at || t.ts || '',
  written: Number(t.written || 0),
  consumedSourceBytes: Number(t.consumed || t.consumedSourceBytes || 0),
  ms: Number(t.ms || t.durationMs || 0),
  reason: t.reason || '',
}));
const writtenSum = perTick.reduce((a, b) => a + b.written, 0);
const endToEnd = perTick.filter((t) => t.written > 0).length;
const steady = perTick.filter((t) => t.written === 0).length;

console.log(JSON.stringify({
  tool: 'measure-tick',
  schema: 'tick-metrics/1',
  generatedAt: new Date().toISOString(),
  packageRoot: LITE,
  root,
  metricsFile,
  ticks: ticks.length,
  perTick,
  aggregate: { writtenSum, endToEndTicks: endToEnd, steadyTicks: steady },
  ledger: { rows: ledgerRows, files: ledgerFiles },
}, null, 2));
