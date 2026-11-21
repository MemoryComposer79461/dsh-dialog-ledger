#!/usr/bin/env node
/**
 * @file docs/工具-出包门.mjs
 * @role 出包门：把 §②/§4 的 S1–S11 串成一条命令（顺序固定、失败即停），并支持 `--dry-run` 只打印命令序列。
 *
 * @why re3 的教训（出包流程方案 §0/§4.4）：门跑在开发树/候选包上，交付的却是另一个 zip；
 *      "先写 zip 再校验、校验失败包已落盘"；13 项实现不随包；终包 sha256 没人算。本文件只做**编排**，
 *      不自己实现打包/校验（分别调 `工具-export.mjs` 与 `工具-收尾校验.mjs`），并在每一步写出
 *      **产物 / 校验点 / 失败即停**：
 *
 *        S0 干净房断言：runDir 在**另一盘符**、全新 TEMP（子进程 TMP/TEMP=<runDir>/tmp）、无 `_工作` 路径；
 *        S1 重算两层清单（内层一次、外层一次）；
 *        S2 出终包 zip（只出一次）+ 算 H=sha256(zip)；
 *        S3 解压到 <runDir>/extract（优先 Windows PowerShell `Expand-Archive` = .NET 解压树；失败退回 node 解压器）；
 *        S4 在**终包解压树**上跑 13 项收尾校验（--final --expect-sha=H）；
 *        S5 写 发布锚.txt + 收尾校验-final.json（交付根，zip 之外）→ 再算一次外层清单 → **不再重打 zip**；
 *        S6 终包只读复检（--mode=verify --final-sha=H）。
 *
 * 用法：
 *   node docs\工具-出包门.mjs --root=<交付根> --out=<交付目录> --gate-dir=<另一盘符的空父目录>
 *        [--date=YYYYMMDD] [--zip-name=<name>] [--run-id=<id>] [--final-sha=<hex>]
 *        [--extractor=auto|expand-archive|node] [--require-clean-env] [--force] [--dry-run]
 *        [--json] [--json-out=<file>] [--help]
 *     --gate-dir=<dir>  干净房父目录（必须与 --root 不同盘符；本次 run 用 <gate-dir>/<runId>，要求全新）
 *     --dry-run         只打印步骤与可执行命令序列，不建目录、不出包
 *     --require-clean-env  发现开发树 `_工作` / 旧 dsh-ledger-* TEMP 残留即失败（默认只记录并警告）
 *     --force           允许复用已存在的 runDir / 覆盖已存在终包 zip（默认拒绝：终包只出一次）
 *   退出码：0=全链通过；1=某一步校验红（停，产物不可发）；2=用法/环境错误。
 *
 * @reads  <root>/**、<docs>/工具-export.mjs、<docs>/工具-收尾校验.mjs
 * @writes <gate-dir>/<runId>/{tmp,extract,logs,final,steps}、<out>/<zip>、<root>/{发布锚.txt,收尾校验-final.json,MANIFEST.sha256}
 * @depends node:fs/os/path/child_process/url；外部可选 Windows PowerShell（Expand-Archive）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const DOCS_DIR = path.dirname(THIS_FILE);
const EXPORT_TOOL = path.join(DOCS_DIR, '工具-export.mjs');
const CHECK_TOOL = path.join(DOCS_DIR, '工具-收尾校验.mjs');
const TOOL = '工具-出包门';
const SCHEMA = 'delivery-gate/1';
const TOOL_VERSION = '1.0.0';

function usage(msg) {
  if (msg) console.error(`[用法错误] ${msg}`);
  console.error('用法: node docs\\工具-出包门.mjs --root=<交付根> --out=<交付目录> --gate-dir=<另一盘符空父目录> [--dry-run] [--json-out=<file>]');
  console.error('      node docs\\工具-出包门.mjs --help');
  process.exit(2);
}
const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : '';
};
const hasFlag = (k) => argv.includes(`--${k}`);
if (hasFlag('help') || hasFlag('-h')) {
  console.log(fs.readFileSync(THIS_FILE, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^\s*$/gm, '').trim());
  process.exit(0);
}
const ALLOWED = ['root', 'out', 'gate-dir', 'date', 'zip-name', 'run-id', 'final-sha', 'extractor', 'require-clean-env', 'force', 'dry-run', 'json', 'json-out', 'help'];
for (const a of argv) {
  if (!a.startsWith('--')) usage(`不认识的裸参数：${a}`);
  const k = a.slice(2).split('=')[0];
  if (!ALLOWED.includes(k) && k !== 'h') usage(`不认识的参数 --${k}`);
}
const ROOT = path.resolve(argOf('root') || '');
const OUT = path.resolve(argOf('out') || '');
const GATE_PARENT = argOf('gate-dir') ? path.resolve(argOf('gate-dir')) : '';
const DRY_RUN = hasFlag('dry-run');
const FORCE = hasFlag('force');
const AS_JSON = hasFlag('json');
const JSON_OUT = argOf('json-out') ? path.resolve(argOf('json-out')) : '';
const REQUIRE_CLEAN_ENV = hasFlag('require-clean-env');
const EXTRACTOR = (argOf('extractor') || 'auto').toLowerCase();
const FINAL_SHA = (argOf('final-sha') || '').trim().toLowerCase();
if (!argOf('root')) usage('必须 --root=<交付根>');
if (!argOf('out')) usage('必须 --out=<交付目录>');
if (argOf('date') && !/^\d{8}$/.test(argOf('date'))) usage('--date 必须是 YYYYMMDD');
if (FINAL_SHA && !/^[0-9a-f]{64}$/.test(FINAL_SHA)) usage('--final-sha 必须是 64 位小写 hex');
if (!['auto', 'expand-archive', 'node'].includes(EXTRACTOR)) usage('--extractor 只能是 auto|expand-archive|node');
if (!DRY_RUN && !GATE_PARENT) usage('--gate-dir 必填（另一盘符的干净房父目录；--dry-run 可不给）');

function fail(code, msg) {
  console.error(`[出包门] ${msg}`);
  process.exit(code);
}
function driveOf(p) {
  const r = path.parse(path.resolve(p)).root;
  return r.replace(/[\\/]+$/, '').toUpperCase();
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function relFor(rel) {
  return path.join(ROOT, rel.split('/').join(path.sep));
}
function walkRel(rootAbs) {
  const out = [];
  const walk = (dir, base) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === '.git') continue;
        walk(abs, rel);
      } else if (ent.isFile()) out.push(rel);
    }
  };
  walk(rootAbs, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}
function ancestors(p) {
  const out = [];
  let cur = path.resolve(p);
  for (;;) {
    out.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}
function findWorkTreeProbes() {
  const probes = [];
  const add = (p) => {
    try { if (fs.existsSync(p)) probes.push(p); } catch { /* ignore */ }
  };
  add(path.join(os.homedir(), 'Desktop', '_工作'));
  add(path.join(os.homedir(), '_工作'));
  for (const p of [ROOT, OUT, GATE_PARENT].filter(Boolean)) {
    for (const a of ancestors(p)) if (path.basename(a) === '_工作') add(a);
    // 同盘根下的 _工作
    const d = driveOf(p);
    if (d) add(`${d}\\${'_工作'}`);
  }
  return [...new Set(probes)];
}
function findOldTempLabs() {
  const dir = os.tmpdir();
  const hits = [];
  try {
    for (const n of fs.readdirSync(dir)) if (/^dsh-ledger-/.test(n)) hits.push(path.join(dir, n));
  } catch { /* ignore */ }
  return { dir, hits };
}
function parseJsonFile(abs, label) {
  if (!fs.existsSync(abs)) fail(1, `${label} 未产出：${abs}`);
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (err) { fail(1, `读 ${label} 失败：${err.message}`); }
}

// ---------------------------------------------------------------------------
// 步骤表（dry-run 直接打印这张表；真实执行时按顺序跑）
// ---------------------------------------------------------------------------
function planSteps(ctx) {
  const { runDir, zipHint } = ctx;
  const stepsDir = path.join(runDir, 'steps');
  const logsDir = path.join(runDir, 'logs');
  const gateJson = path.join(runDir, 'final', '收尾校验-final.json');
  const zipName = zipHint;
  const zipAbs = path.join(OUT, zipName);
  const extractDir = path.join(runDir, 'extract');
  const common = [];
  if (argOf('date')) common.push(`--date=${argOf('date')}`);
  if (argOf('zip-name')) common.push(`--zip-name=${argOf('zip-name')}`);
  const forceArg = FORCE ? ' --force' : '';
  return [
    {
      id: 'S1',
      name: '重算两层清单（内层一次、外层一次）',
      cmd: [process.execPath, EXPORT_TOOL, `--root=${ROOT}`, '--mode=manifests', ...common, `--json-out=${path.join(stepsDir, '01-manifests.json')}${forceArg}`],
      artifact: `${relFor('01-插件包/MANIFEST.sha256')}、${relFor('MANIFEST.sha256')}`,
      checkpoint: 'exit=0；内/外层复算 缺/多/改=0；外层（声明 ∪ 排除面）不含 04-结果；锚文件不存在',
    },
    {
      id: 'S2',
      name: '出终包 zip（只出一次）+ 算 sha256',
      cmd: [process.execPath, EXPORT_TOOL, `--root=${ROOT}`, `--out=${OUT}`, '--mode=zip', ...common, `--json-out=${path.join(stepsDir, '02-zip.json')}${forceArg}`],
      artifact: zipAbs,
      checkpoint: 'exit=0；两次构建字节相同（树未变）；回读 CRC 全过；H=sha256(zip)；H 不在 zip 内',
    },
    {
      id: 'S3',
      name: '解压到全新解压树（优先 .NET Expand-Archive，失败退 node）',
      cmd: ['（内部）Expand-Archive -LiteralPath "' + zipAbs + '" -DestinationPath "' + extractDir + '" -Force 或 node 工具-export.mjs --mode=extract'],
      artifact: extractDir,
      checkpoint: '解压退出码 0；树文件数=zip 条目数；树里无 _工作/%TEMP% 路径',
    },
    {
      id: 'S4',
      name: '在终包解压树上跑 13 项收尾校验（--final）',
      cmd: [process.execPath, CHECK_TOOL, `--pkg=${path.join(extractDir, '<zip顶层目录>', '01-插件包')}`, `--zip=${zipAbs}`, `--out=${gateJson}`, `--expect-sha=<S2 的 H>`, '--final'],
      artifact: gateJson,
      checkpoint: 'exit=0；13/13 PASS；finalMode=true；target.sha256=H（现场 re-hash）',
    },
    {
      id: 'S5',
      name: '写锚到交付根（zip 之外）→ 再算一次外层清单 → 不重打 zip',
      cmd: [process.execPath, EXPORT_TOOL, `--root=${ROOT}`, `--out=${OUT}`, '--mode=anchors', `--final-json=${gateJson}`, '--final-sha=<S2 的 H>', ...common, `--json-out=${path.join(stepsDir, '05-anchors.json')}${forceArg}`],
      artifact: `${relFor('发布锚.txt')}、${relFor('收尾校验-final.json')}、重算后的 ${relFor('MANIFEST.sha256')}`,
      checkpoint: 'exit=0；13 项 JSON target=本 zip；zip=交付根无锚快照；O1 = O0 + 2 行；内层清单 sha 未变；zip re-hash=H',
    },
    {
      id: 'S6',
      name: '终包只读复检（--verify-final）',
      cmd: [process.execPath, EXPORT_TOOL, `--root=${ROOT}`, `--out=${OUT}`, '--mode=verify', `--final-sha=<S2 的 H>`, ...common, `--json-out=${path.join(stepsDir, '06-verify.json')}`],
      artifact: path.join(stepsDir, '06-verify.json'),
      checkpoint: 'exit=0；锚/终版 JSON/两层清单/zip↔交付根关系/无自指 全部 PASS',
    },
  ];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const runId = argOf('run-id') || stamp();
  const runDir = GATE_PARENT ? path.join(GATE_PARENT, runId) : path.join('<gate-dir>', runId);
  const version = (() => {
    try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, '01-插件包', 'VERSION.json'), 'utf8')).version || ''); } catch { return ''; }
  })();
  const vv = version ? (/^v/i.test(version) ? version : `v${version}`) : 'vX';
  const zipHint = argOf('zip-name') || `异机检测包-lite-${vv}-${argOf('date') || todayStamp()}.zip`;
  const ctx = { runId, runDir, zipHint };
  const stepsPlan = planSteps(ctx);

  if (DRY_RUN) {
    const report = {
      schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, dryRun: true, at: new Date().toISOString(),
      runId, root: ROOT, out: OUT, gateDir: GATE_PARENT || '<gate-dir>', runDir,
      zip: { name: zipHint, path: path.join(OUT, zipHint) },
      steps: stepsPlan.map((s) => ({ id: s.id, name: s.name, command: s.cmd.join(' '), artifact: s.artifact, checkpoint: s.checkpoint })),
      env: { gateTmp: GATE_PARENT ? path.join(runDir, 'tmp') : '<gate-dir>/<runId>/tmp', osTmpdir: os.tmpdir(), node: process.version },
    };
    if (JSON_OUT) { fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true }); fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); }
    if (AS_JSON) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`[出包门] dry-run｜runId=${runId}`);
      console.log(`[出包门] root=${ROOT}`);
      console.log(`[出包门] out=${OUT}`);
      console.log(`[出包门] gate=${GATE_PARENT || '<gate-dir>'}｜runDir=${runDir}`);
      for (const s of report.steps) {
        console.log(`\n${s.id} ${s.name}`);
        console.log(`  命令：${s.command}`);
        console.log(`  产物：${s.artifact}`);
        console.log(`  校验点/失败即停：${s.checkpoint}`);
      }
      console.log('\n[出包门] dry-run 结束：未建目录、未出包、未写锚。');
    }
    process.exit(0);
  }

  // ---------- S0 干净房断言 ----------
  const steps = [];
  const nowIso = () => new Date().toISOString();
  const step = (id, name, pass, detail, extra) => { steps.push({ id, name, pass, detail, at: nowIso(), ...(extra || {}) }); };
  if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) fail(2, `--root 不是目录：${ROOT}`);
  for (const f of [EXPORT_TOOL, CHECK_TOOL]) if (!fs.existsSync(f)) fail(2, `缺随包工具：${f}`);
  if (path.resolve(OUT) === path.resolve(ROOT) || path.resolve(OUT).startsWith(`${path.resolve(ROOT)}${path.sep}`)) fail(2, `--out 不能在 --root 内：${OUT}`);
  const rootDrive = driveOf(ROOT);
  const gateDrive = driveOf(GATE_PARENT);
  if (rootDrive === gateDrive) fail(2, `干净房必须与交付根**不同盘符**：root=${rootDrive} gate=${gateDrive}`);
  if (!fs.existsSync(GATE_PARENT) || !fs.statSync(GATE_PARENT).isDirectory()) fail(2, `--gate-dir 不是已存在的目录：${GATE_PARENT}（请先创建干净房父目录）`);
  if (fs.existsSync(runDir) && !FORCE) fail(2, `runDir 已存在：${runDir}（干净房必须全新；确需复用加 --force）`);
  for (const p of [ROOT, OUT, GATE_PARENT, runDir]) {
    if (p.split(/[\\/]/).includes('_工作')) fail(2, `路径含"${'_工作'}"（开发树路径不能进干净房）：${p}`);
  }
  const workProbes = findWorkTreeProbes();
  const oldTemp = findOldTempLabs();
  step('S0', '干净房断言', true, `root 盘 ${rootDrive} / gate 盘 ${gateDrive}（不同盘符）；runDir=${runDir}；子进程 TMP/TEMP=${path.join(runDir, 'tmp')}；os.tmpdir()=${oldTemp.dir}`, { rootDrive, gateDrive, workProbes, oldTempLabs: oldTemp.hits });
  if (REQUIRE_CLEAN_ENV && (workProbes.length || oldTemp.hits.length)) {
    step('S0', '干净房断言（--require-clean-env）', false, `发现开发树/旧 TEMP：${[...workProbes, ...oldTemp.hits].join('、')}`);
    return finish(steps, { runId, runDir, zip: null, ok: false }, 1);
  }
  if (workProbes.length || oldTemp.hits.length) {
    step('S0', '干净房警告（未加 --require-clean-env）', null, `机器上仍可见：${[...workProbes, ...oldTemp.hits].slice(0, 8).join('、')}${[...workProbes, ...oldTemp.hits].length > 8 ? '…' : ''}｜子进程已用全新 TMP/TEMP，但"无 _工作"未被证明`);
  }
  const runDirs = { tmp: path.join(runDir, 'tmp'), extract: path.join(runDir, 'extract'), logs: path.join(runDir, 'logs'), final: path.join(runDir, 'final'), steps: path.join(runDir, 'steps') };
  for (const d of Object.values(runDirs)) fs.mkdirSync(d, { recursive: true });
  const childEnv = { ...process.env, TMP: runDirs.tmp, TEMP: runDirs.tmp, TMPDIR: runDirs.tmp };

  // 逐段执行：任何一段红 → 停
  const runNodeTool = (id, name, args, logName, artifactNote) => {
    const logPath = path.join(runDirs.logs, `${logName}.log`);
    const fd = fs.openSync(logPath, 'a');
    const r = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], env: childEnv, cwd: runDir, windowsHide: true });
    fs.closeSync(fd);
    const pass = r.status === 0;
    step(id, name, pass, `exit=${r.status === null ? 'null' : r.status}${pass ? '' : `（日志：${logPath}）`}${artifactNote ? `；${artifactNote}` : ''}`, { command: [process.execPath, ...args].join(' '), log: logPath });
    return { pass, status: r.status, logPath };
  };

  // S1 manifests
  {
    const jsonOut = path.join(runDirs.steps, '01-manifests.json');
    const args = [EXPORT_TOOL, `--root=${ROOT}`, '--mode=manifests', `--json-out=${jsonOut}`];
    if (argOf('date')) args.push(`--date=${argOf('date')}`);
    if (argOf('zip-name')) args.push(`--zip-name=${argOf('zip-name')}`);
    if (FORCE) args.push('--force');
    const r = runNodeTool('S1', '重算两层清单（内层一次、外层一次）', args, '01-manifests', jsonOut);
    if (!r.pass) return finish(steps, { runId, runDir, zip: null, ok: false }, 1);
    const j = parseJsonFile(jsonOut, 'S1 JSON');
    if (!(j.manifests && j.manifests.inner && j.manifests.outer)) { step('S1', 'S1 JSON 结构', false, '缺 manifests.inner/outer'); return finish(steps, { runId, runDir, zip: null, ok: false }, 1); }
    step('S1', '清单落定', true, `内层 ${j.manifests.inner.lines} 行 sha256=${j.manifests.inner.sha256}；外层 ${j.manifests.outer.lines} 行 sha256=${j.manifests.outer.sha256}；排除面 ${(j.scopeExcluded || []).join(',')}`, { manifests: j.manifests });
  }

  // S2 zip
  let zipInfo = null;
  {
    const jsonOut = path.join(runDirs.steps, '02-zip.json');
    const args = [EXPORT_TOOL, `--root=${ROOT}`, `--out=${OUT}`, '--mode=zip', `--json-out=${jsonOut}`];
    if (argOf('date')) args.push(`--date=${argOf('date')}`);
    if (argOf('zip-name')) args.push(`--zip-name=${argOf('zip-name')}`);
    if (FINAL_SHA) args.push(`--final-sha=${FINAL_SHA}`);
    if (FORCE) args.push('--force');
    const r = runNodeTool('S2', '出终包 zip（只出一次）+ 算 sha256', args, '02-zip', jsonOut);
    if (!r.pass) return finish(steps, { runId, runDir, zip: null, ok: false }, 1);
    const j = parseJsonFile(jsonOut, 'S2 JSON');
    if (!j.zip || !/^[0-9a-f]{64}$/.test(j.zip.sha256)) { step('S2', 'S2 JSON 结构', false, '缺 zip.sha256'); return finish(steps, { runId, runDir, zip: null, ok: false }, 1); }
    zipInfo = j.zip;
    step('S2', '终包已出（此后不再重打）', true, `${j.zip.path}｜字节 ${j.zip.bytes}｜条目 ${j.zip.entries}｜sha256=${j.zip.sha256}｜前缀 ${j.zip.prefix}`, { zip: j.zip });
  }

  // S3 解压
  let extractTree = '';
  {
    const extractDir = runDirs.extract;
    let extractorUsed = '';
    let extractOk = false;
    let detail = '';
    const ps = findPowerShell();
    if ((EXTRACTOR === 'auto' || EXTRACTOR === 'expand-archive') && ps) {
      const logPath = path.join(runDirs.logs, '03-extract-expand-archive.log');
      const fd = fs.openSync(logPath, 'a');
      const cmd = `Expand-Archive -LiteralPath '${zipInfo.path.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force -ErrorAction Stop`;
      const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: ['ignore', fd, fd], env: childEnv, cwd: runDir, windowsHide: true });
      fs.closeSync(fd);
      if (r.status === 0) {
        extractorUsed = 'expand-archive(.NET)';
        extractOk = true;
        detail = `PowerShell Expand-Archive 解压完成（日志 ${logPath}）`;
      } else {
        detail = `Expand-Archive 失败 exit=${r.status}（日志 ${logPath}），回退 node 解压器`;
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });
      }
    } else if ((EXTRACTOR === 'auto' || EXTRACTOR === 'expand-archive') && !ps) {
      detail = '本机找不到 PowerShell，回退 node 解压器';
    }
    if (!extractOk) {
      if (EXTRACTOR === 'expand-archive') { step('S3', '解压（Expand-Archive）', false, '指定了 --extractor=expand-archive 但本机没有 PowerShell 或解压失败'); return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1); }
      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const jsonOut = path.join(runDirs.steps, '03-extract.json');
      const r = runNodeTool('S3', '解压（node 内建，Expand-Archive 备份）', [EXPORT_TOOL, '--mode=extract', `--zip=${zipInfo.path}`, `--extract=${extractDir}`, `--json-out=${jsonOut}`], '03-extract-node', jsonOut);
      if (!r.pass) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
      extractorUsed = 'node';
      extractOk = true;
    }
    // 定位 zip 顶层目录 = 解压树
    const top = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (top.length === 1 && fs.existsSync(path.join(extractDir, top[0].name, '01-插件包'))) extractTree = path.join(extractDir, top[0].name);
    else if (fs.existsSync(path.join(extractDir, '01-插件包'))) extractTree = extractDir;
    else { step('S3', '定位解压树', false, `解压目录里找不到 01-插件包：${fs.readdirSync(extractDir).join('、')}`); return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1); }
    const treeFiles = walkRel(extractTree);
    const treeResidue = treeFiles.filter((r) => r.split('/').some((seg) => seg === '_工作' || seg.startsWith('%TEMP%')));
    const ok = treeFiles.length === zipInfo.entries && treeResidue.length === 0;
    step('S3', '解压树校验', ok, `解压器 ${extractorUsed}｜树 ${extractTree}｜树文件 ${treeFiles.length} / zip 条目 ${zipInfo.entries}｜残留路径 ${treeResidue.length}`, { extractor: extractorUsed, extractTree, treeFiles: treeFiles.length });
    if (!ok) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
  }

  // S4 13 项终包门
  {
    const gateJson = path.join(runDirs.final, '收尾校验-final.json');
    const pkgDir = path.join(extractTree, '01-插件包');
    const r = runNodeTool('S4', '13 项收尾校验（终包解压树，--final）',
      [CHECK_TOOL, `--pkg=${pkgDir}`, `--zip=${zipInfo.path}`, `--out=${gateJson}`, `--expect-sha=${zipInfo.sha256}`, '--final'],
      '04-final-check', gateJson);
    if (!r.pass) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
    const j = parseJsonFile(gateJson, 'S4 13 项 JSON');
    const passRows = Array.isArray(j.rows) ? j.rows.filter((x) => x.pass).length : 0;
    const ok = j.ok === true && j.finalMode === true && passRows === 13 && j.target && j.target.sha256 === zipInfo.sha256;
    step('S4', '终包 13 项', ok, `${passRows}/13｜finalMode=${j.finalMode}｜target.sha256=${j.target ? j.target.sha256 : '无'}｜target.entries=${j.target ? j.target.entries : '无'}`, { gateJson });
    if (!ok) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
  }

  // S5 锚 + 重算外层（不再重打 zip）
  let anchorResult = null;
  {
    const gateJson = path.join(runDirs.final, '收尾校验-final.json');
    const jsonOut = path.join(runDirs.steps, '05-anchors.json');
    const args = [EXPORT_TOOL, `--root=${ROOT}`, `--out=${OUT}`, '--mode=anchors', `--final-json=${gateJson}`, `--final-sha=${zipInfo.sha256}`, `--json-out=${jsonOut}`];
    if (argOf('date')) args.push(`--date=${argOf('date')}`);
    if (argOf('zip-name')) args.push(`--zip-name=${argOf('zip-name')}`);
    if (FORCE) args.push('--force');
    const r = runNodeTool('S5', '写锚（zip 之外）+ 再算一次外层清单', args, '05-anchors', jsonOut);
    if (!r.pass) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
    const j = parseJsonFile(jsonOut, 'S5 JSON');
    const ok = j.zip && j.zip.sha256 === zipInfo.sha256 && j.zip.sha256AfterWrite === zipInfo.sha256
      && j.manifests && j.manifests.outerFinal && j.zipAnchorFree === true
      && j.manifests.inner && j.manifests.inner.unchanged === true;
    step('S5', '锚后一致', ok, `H 未变=${j.zip && j.zip.sha256AfterWrite === zipInfo.sha256}｜I0 未变=${j.manifests && j.manifests.inner ? j.manifests.inner.unchanged : '?'}｜O1=${j.manifests && j.manifests.outerFinal ? j.manifests.outerFinal.sha256 : '?'}｜新增行=${j.manifests && j.manifests.outerFinal ? (j.manifests.outerFinal.added || []).join('、') : '?'}`, { anchors: j.anchors, relation: j.relation });
    if (!ok) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
    anchorResult = { anchor: j.anchor, anchors: j.anchors, relation: j.relation };
  }

  // S6 verify
  {
    const jsonOut = path.join(runDirs.steps, '06-verify.json');
    const args = [EXPORT_TOOL, `--root=${ROOT}`, `--out=${OUT}`, '--mode=verify', `--final-sha=${zipInfo.sha256}`, `--json-out=${jsonOut}`];
    if (argOf('date')) args.push(`--date=${argOf('date')}`);
    if (argOf('zip-name')) args.push(`--zip-name=${argOf('zip-name')}`);
    const r = runNodeTool('S6', '终包只读复检', args, '06-verify', jsonOut);
    const j = r.pass ? parseJsonFile(jsonOut, 'S6 JSON') : null;
    if (!r.pass || !j) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
    const checks = Array.isArray(j.checks) ? j.checks : [];
    const ok = j.ok === true && checks.length > 0 && checks.every((c) => c.pass);
    step('S6', '复检', ok, `${checks.filter((c) => c.pass).length}/${checks.length}｜${checks.filter((c) => !c.pass).map((c) => c.name).join('、') || '全部 PASS'}`, { verify: j.checks });
    if (!ok) return finish(steps, { runId, runDir, zip: zipInfo, ok: false }, 1);
  }

  const afterTemp = findOldTempLabs();
  step('退出', '收尾', true, `runDir=${runDir}；zip=${zipInfo.path}；完整日志/证据在 ${runDir}`, { oldTempLabsAfter: afterTemp.hits });

  return finish(steps, {
    runId, runDir, zip: zipInfo, anchor: anchorResult,
    extractTree, extractor: steps.find((s) => s.id === 'S3' && s.extractor)?.extractor,
  }, 0);
}

function findPowerShell() {
  const candidates = [
    process.env.PowerShellExe,
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return '';
}

function finish(steps, extra, code) {
  const ok = code === 0 && steps.every((s) => s.pass !== false);
  const report = {
    schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, at: new Date().toISOString(),
    ok, dryRun: false,
    runId: extra.runId, root: ROOT, out: OUT, gateDir: GATE_PARENT, runDir: extra.runDir,
    zip: extra.zip || null, extractTree: extra.extractTree || null, extractor: extra.extractor || null,
    anchor: extra.anchor || null,
    steps,
    env: { node: process.version, platform: process.platform, cwd: process.cwd(), osTmpdir: os.tmpdir(), rootDrive: ROOT ? driveOf(ROOT) : null, gateDrive: GATE_PARENT ? driveOf(GATE_PARENT) : null },
  };
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[出包门] runId=${report.runId}｜${ok ? 'PASS' : 'FAIL'}`);
    for (const s of steps) {
      const tag = s.pass === false ? '[FAIL]' : s.pass === null ? '[WARN]' : '[PASS]';
      console.log(`  ${s.id} ${tag} ${s.name}｜${s.detail}`);
    }
    if (report.zip) console.log(`[出包门] 终包：${report.zip.path}｜sha256=${report.zip.sha256}`);
    if (report.anchor && report.anchor.anchor) console.log(`[出包门] ${report.anchor.anchor.line}`);
    if (!ok) console.log(`[出包门] 失败即停：产物不可发；日志在 ${report.runDir || '<gate-dir>/<runId>'}`);
  }
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`[出包门] 致命错误：${err && err.stack ? err.stack : err}`);
  process.exit(2);
}
