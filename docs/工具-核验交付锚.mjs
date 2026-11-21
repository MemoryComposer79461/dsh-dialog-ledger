#!/usr/bin/env node
/**
 * @file docs/工具-核验交付锚.mjs
 * @role V0.8 只读核验：交付包 vs 库外 manifest 锚；账本快照 vs 锚。**不写库、不联网**。
 *
 * 用法：
 *   node docs/工具-核验交付锚.mjs --package=<包目录> [--anchor-dir=<锚目录>] [--json]
 *   node docs/工具-核验交付锚.mjs --root=<账本根> [--anchor-dir=<锚目录>] [--json]
 *   node docs/工具-核验交付锚.mjs --anchor-dir=<锚目录> [--json]     # 只验锚文件自身与链
 * 退出码：0 全通过；1 有失败检查；2 参数/IO 错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const ma = await import(pathToFileURL(path.join(SRC, 'freeze', 'manifestanchor.js')).href);

function parseArgs(argv) {
  const out = { pkg: '', root: '', anchorDir: '', json: false };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'package') out.pkg = m[2];
    else if (m[1] === 'root') out.root = m[2];
    else if (m[1] === 'anchor-dir') out.anchorDir = m[2];
    else if (m[1] === 'json') out.json = m[2] !== 'false';
  }
  if (!out.anchorDir) out.anchorDir = path.join(os.homedir(), 'Desktop', '账本锚');
  return out;
}

const args = parseArgs(process.argv);
if (!args.pkg && !args.root && !args.anchorDir) {
  console.error('用法：--package=<dir> | --root=<dir> | --anchor-dir=<dir> [--json]');
  process.exit(2);
}

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail || '') });

// 锚文件自身与链
const anchor = ma.readAnchor(args.anchorDir);
add('anchor-file', anchor.exists, anchor.exists ? anchor.file : '不存在：' + anchor.file);
add('anchor-bad-lines', anchor.badLines === 0, 'badLines=' + anchor.badLines);
add('anchor-chain', anchor.chainOk, anchor.chainOk ? 'prevHash 连续（' + anchor.entries.length + ' 行）' : JSON.stringify(anchor.breaks));

const report = { v: 1, at: new Date().toISOString(), anchorDir: args.anchorDir, checks: [], package: null, ledger: null };

if (args.pkg) {
  if (!fs.existsSync(args.pkg)) { add('package-exists', false, '包目录不存在：' + args.pkg); }
  else {
    const r = ma.verifyPackageAgainstAnchor(args.pkg, args.anchorDir);
    report.package = { dir: args.pkg, ok: r.ok, digest: r.digest, manifest: r.manifest };
    checks.push(...r.checks.map((c) => ({ ...c, name: 'pkg:' + c.name })));
  }
}

if (args.root) {
  if (!fs.existsSync(args.root)) { add('root-exists', false, '账本根不存在：' + args.root); }
  else {
    const snap = [...anchor.entries].reverse().find((x) => x.kind === 'ledger-snapshot');
    if (!snap) add('ledger-snapshot-anchored', false, '锚中无 ledger-snapshot 行（需先锚定）');
    else {
      const v = ma.verifyLedgerSnapshot(args.root, snap);
      report.ledger = { root: args.root, ok: v.ok, diffs: v.diffs, counts: { rows: v.now.totalRows, sealed: v.now.weeklySealedCount, draft: v.now.weeklyDraftCount } };
      checks.push(...v.checks.map((c) => ({ ...c, name: 'ledger:' + c.name })));
    }
  }
}

report.ok = checks.every((c) => c.ok);
report.checks = checks;

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== 核验交付锚 ===');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
  console.log(`\n结论：${report.ok ? 'PASS ✅' : 'FAIL ❌'}（${checks.filter((c) => c.ok).length}/${checks.length}）`);
  if (!report.ok) console.log('提示：锚只增不改；不要自动"修"锚，先人工核对差异。');
}
process.exit(report.ok ? 0 : 1);
