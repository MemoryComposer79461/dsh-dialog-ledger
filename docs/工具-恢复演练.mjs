#!/usr/bin/env node
/**
 * @file docs/工具-恢复演练.mjs
 * @role V0.8 恢复演练自动化（只读校验 + 临时目录）：从 U 盘目录/zip 恢复到临时位置，
 *       依次做 MANIFEST 自检、内核边界、payloadHash/锚比对，并输出结论 Markdown。
 *
 * 用法：
 *   node docs/工具-恢复演练.mjs --from=<U盘目录|zip> --anchor-dir=<锚目录> [--out=<md>]
 *   node docs/工具-恢复演练.mjs --from=... --anchor-dir=... --json
 * 退出码：0 全通过；1 有失败项；2 参数/IO 错误。
 * 铁律：不覆盖任何已交付包；临时目录用完即删；不联网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const WORK = path.resolve(SRC, '..'); // <test-dir>\work
const ma = await import(pathToFileURL(path.join(SRC, 'freeze', 'manifestanchor.js')).href);
const ASSEMBLER = path.join(WORK, '工具-出包-v06.mjs');

function parseArgs(argv) {
  const out = { from: '', anchorDir: '', out: '', json: false };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'from') out.from = m[2];
    else if (m[1] === 'anchor-dir') out.anchorDir = m[2];
    else if (m[1] === 'out') out.out = m[2];
    else if (m[1] === 'json') out.json = m[2] !== 'false';
  }
  if (!out.anchorDir) out.anchorDir = path.join(os.homedir(), 'Desktop', '账本锚');
  return out;
}

const args = parseArgs(process.argv);
if (!args.from) { console.error('用法：--from=<包目录|zip> --anchor-dir=<dir> [--out=md]'); process.exit(2); }
if (!fs.existsSync(args.from)) { console.error('from 不存在：' + args.from); process.exit(2); }

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const runNode = (argv) => spawnSync(process.execPath, argv, { cwd: WORK, encoding: 'utf8', timeout: 600000 });
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail || '').slice(0, 400) });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-'));
let pkgRoot = '';

try {
  // 1) 解包/复制到临时目录
  if (args.from.toLowerCase().endsWith('.zip')) {
    const { execFileSync } = await import('node:child_process');
    // 用 PowerShell 解压（避免依赖 zip 库）
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${args.from.replace(/'/g, "''")}' -DestinationPath '${tmpRoot.replace(/'/g, "''")}' -Force`], { stdio: 'ignore' });
    const mf = fs.readdirSync(tmpRoot, { recursive: true }).map(String).find((r) => path.basename(r) === 'MANIFEST.sha256');
    pkgRoot = mf ? path.dirname(path.join(tmpRoot, mf)) : tmpRoot;
  } else {
    pkgRoot = path.join(tmpRoot, path.basename(args.from));
    fs.cpSync(args.from, pkgRoot, { recursive: true });
  }
  add('extract', fs.existsSync(path.join(pkgRoot, 'MANIFEST.sha256')), 'pkgRoot=' + pkgRoot);

  // 2) MANIFEST 自检（复用出包脚本 --check）
  const chk = runNode([ASSEMBLER, '--check=' + pkgRoot]);
  add('manifest-check', chk.status === 0, (chk.stdout || '').trim().split('\n').slice(-1)[0] || (chk.stderr || '').trim());

  // 3) 内核边界
  const kernel = runNode([path.join(pkgRoot, '01-代码', 'docs', '验收-v0.5', '工具-内核边界检查.mjs')]);
  add('kernel-boundary', kernel.status === 0, (kernel.stdout || '').trim().split('\n').slice(-1)[0] || '');

  // 4) payloadHash / MANIFEST 根 / 锚链
  const r = ma.verifyPackageAgainstAnchor(pkgRoot, args.anchorDir);
  for (const c of r.checks) add('anchor:' + c.name, c.ok, c.detail);
  add('payloadHash', r.digest.payloadHash, r.digest.payloadHash);
} catch (e) {
  add('drill-exception', false, e && e.message ? e.message : String(e));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

const ok = checks.every((c) => c.ok);
const ts = stamp();
const md = [
  '# 恢复演练记录（V0.8 自动化）',
  '',
  '- 时间：' + new Date().toISOString(),
  '- 来源：`' + args.from + '`',
  '- 锚目录：`' + args.anchorDir + '`',
  '- 结论：**' + (ok ? 'PASS ✅' : 'FAIL ❌') + '**',
  '',
  '| 检查 | 结果 | 说明 |',
  '|---|---|---|',
  ...checks.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${String(c.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
  '',
].join('\n');

if (args.out) {
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, md, 'utf8');
  console.log('结果已写：' + args.out);
}
if (args.json) console.log(JSON.stringify({ v: 1, at: new Date().toISOString(), from: args.from, anchorDir: args.anchorDir, ok, checks }, null, 2));
else if (!args.out) { console.log(md); console.log('结论：' + (ok ? 'PASS ✅' : 'FAIL ❌')); }

process.exit(ok ? 0 : 1);
