#!/usr/bin/env node
/**
 * @file 工具-内核边界检查.mjs
 * @role 机主 2026-11-09 裁定："数据库组建是外围，以后改动不接触内核，或只改编码逻辑与周记账内容"。
 *       本工具把这条裁定变成**可执行的检查**：把冻结包里的内核文件哈希做基线，
 *       任何后续版本跑一遍，就能证明"内核一个字节没动"，或者精确点出动了哪个。
 *
 * @why 口头约定会漂移。哈希不会。
 *      内核之所以要冻结，不是保守，而是：**账本能不能被信任，取决于判定"账对不对"的那几段代码没被顺手改过**。
 *
 * 分类（见 docs/交付-v0.5/08-能力冻结声明-v0.5.0.md §六）：
 *   · KERNEL       禁改（改动 = 破坏基线，必须升版 + 机主签字）
 *   · CONTROLLED   受控可改（编码逻辑 / 周记账内容 / 产物格式）：允许变，但必须五门全绿并登记
 *   · 其它        自由（外层、工具、文档、测试）
 *
 * 已知限制（如实写）：`index.js` 同时含内核编排与外层调度，**无法按文件切分**，
 * 所以它整体归入 CONTROLLED（受控），内核语义是否守住要靠 INV/CH/REC/CL 判据，不靠哈希。
 *
 * 用法（v1.1）：
 *   node docs/验收-v0.5/工具-内核边界检查.mjs                          # 检查当前树：自动选“版本号最大”的基线
 *   node docs/验收-v0.5/工具-内核边界检查.mjs --baseline=0.5.0         # 显式回到历史口径（版本 token 或文件路径均可）
 *   node docs/验收-v0.5/工具-内核边界检查.mjs --package=<目录>          # 检查指定包（缺省 = 工具自身所在包）
 *   node docs/验收-v0.5/工具-内核边界检查.mjs --paths [--init=<名>]    # 只打印解析后的 package/baseline/输出路径（外部脚本用）
 *   node docs/验收-v0.5/工具-内核边界检查.mjs --init=<basename> --package=. [--force]   # 从包生成基线
 *   node docs/验收-v0.5/工具-内核边界检查.mjs --json                    # 机器可读（字段只增不删）
 * 退出码：0 = 内核未变（受控文件变化仅提示）；1 = 内核被改动；2 = 基线/目标/参数缺失，或拒绝覆盖基线
 *
 * ── 版本与口径（v1.1 · 0.9.2 / S-2，2026-11-13 参数化）──────────────────────────────
 * · 谁改的：0.9.2 的 S-2（内核基线重定）把本工具从 1.0 参数化到 1.1。
 *   ★ KERNEL 六文件名单（下方常量）**一个字节也没有动**——它是判据本体，不是本工具的配置。
 * · 默认行为：基线 = docs/内核基线 下“版本号最大”的那份（当前 v1.0-lite）；
 *   包 = 工具自身所在包。版本号按**数字元组**比较（1.0.0 > 0.5.0），禁止字符串比较。
 *   自动选基线时人读输出会写明“自动选：版本号最大”，--json 里给 baselineAuto/baselineName。
 * · 历史包复算：显式 --baseline=0.5.0（或直接给 0.5.0 基线文件路径）+ --target=<历史包>\01-代码
 *   （历史包也可直接 --package=<包根>，包根下有 01-代码 时会自动下钻）。
 *   0.5.0 基线永远保留：本工具**从不删除**旧基线，一个版本一份、可并存、可分别复算。
 * · 生成基线：--init=<basename> 从 --package 生成；版本名恰好是 0.5.0 时沿用旧 0.5.0 名单
 *   （KERNEL + CONTROLLED 常量，逐字节复现历史基线格式），其它版本名用 lite 名单
 *   （6 KERNEL + 7 活 CONTROLLED，见 LITE_CONTROLLED）。已存在同名基线必须显式 --force，否则 exit 2。
 * · 未知参数不再静默忽略：出现白名单外的 `--xxx` → exit 2 并打印合法参数表。
 * · 依赖：仍为 node:fs / node:path / node:crypto / node:url，零新增。
 * ────────────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TOOL_VERSION = '1.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const BASE_DIR = path.join(PLUGIN, 'docs', '内核基线');

/** 禁改内核：判定"账对不对"的那几段 */
const KERNEL = [
  'lib/ledger.js',      // 台账唯一写盘 + 查重 + 撕裂尾巴自愈
  'lib/frames.js',      // zstd 帧边界与坏帧判定
  'lib/sealjournal.js', // 封板链 + canonical v8
  'lib/pending.js',     // 未闭合轮 pending
  'lib/lock.js',        // 单实例锁与接管
  'lib/week.js',        // 周锚（哪一周、哪一月）
];

/** 受控可改：编码逻辑 / 周记账内容 / 产物格式 / 编排（★ 0.5.0 名单常量：保留，供 --init 逐字节复现历史基线） */
const CONTROLLED = [
  'lib/encoder.js',    // 编码逻辑（32 位编码与其冗余）
  'lib/weekly.js',     // 周记账内容
  'lib/xlsx.js',       // 产物格式底座
  'freeze/handover.js',   // 交接表（能力 2 实现）
  'lib/original.js',   // 完整原文（能力 3 实现，含原子写）
  'freeze/cleanup.js',    // 数据管理/清册（能力 5 实现）
  'lib/receipt.js',    // 收据锚（v0.5 新增）
  'lib/reconcile.js',  // 对账（只读）
  'freeze/selfheal.js',   // 自愈/报告
  'tools/backfill.js',   // 补记
  'lib/checkup.js',    // 体检
  'lib/legacy.js',     // 历史格式
  'freeze/sealcross.js',  // 封板交叉核验
  'index.js',          // 编排（内核语义由判据守，不由哈希守）
];

/**
 * v1.0-lite 名单的 CONTROLLED（6 KERNEL + 7 活 CONTROLLED）。
 * 口径：只收"运行期活着、且属于编码/周记账/产物/对账"的文件；
 * 冻结件（freeze/*）、工具层（tools/*）、编排层（index.js）一律不进——
 * 它们的可达性/语义由 C 判据与 core-boundary 守，不由本哈希守。
 * ★ 此常量与 KERNEL 分开存放：KERNEL 是判据本体（改需机主签字），这里只是"哪些活文件要登记"。
 */
const LITE_CONTROLLED = [
  'lib/encoder.js',
  'lib/weekly.js',
  'lib/xlsx.js',
  'lib/original.js',
  'lib/receipt.js',
  'lib/reconcile.js',
  'lib/legacy.js',
];

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const arg = (k, d = '') => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.slice(a.indexOf('=') + 1) : d; };

const BOOL_FLAGS = ['--init', '--json', '--paths', '--force'];
const VALUE_FLAGS = ['--package', '--baseline', '--target', '--init'];
const isKnownArg = (a) => BOOL_FLAGS.includes(a) || VALUE_FLAGS.some((k) => a.startsWith(k + '='));
const unknown = args.filter((a) => a.startsWith('--') && !isKnownArg(a));
if (unknown.length) {
  console.error('未知参数：' + unknown.join(' '));
  console.error('合法参数：--package=<目录>  --baseline=<文件|版本|默认>  --target=<目录>  --init[=<basename>]  --paths  --json  --force');
  process.exit(2);
}

const AS_JSON = has('--json');
const FORCE = has('--force');

// ── 包 / 检查目标 ──────────────────────────────────────────────────────────────
const pkgArg = arg('--package', '');
const PACKAGE = pkgArg ? path.resolve(pkgArg) : PLUGIN; // ★ 相对路径按 cwd 解析
const pkgCodeDir = path.join(PACKAGE, '01-代码');
const PACKAGE_ROOT = fs.existsSync(pkgCodeDir) ? pkgCodeDir : PACKAGE; // 兼容“交付包根/01-代码”与“代码树根”两种结构
const TARGET_ARG = arg('--target', '');
const TARGET = TARGET_ARG ? path.resolve(TARGET_ARG) : (pkgArg ? PACKAGE_ROOT : PLUGIN); // 默认检查目标保持 = 工具自身所在包

// ── 基线：自动选“版本号最大”，或显式指定 ──────────────────────────────────────
const AUTO_TOKENS = new Set(['', '默认', 'auto', 'latest', '最新']);
const baselineArg = arg('--baseline', '');

function listBaselines() {
  try { return fs.readdirSync(BASE_DIR).filter((n) => /^内核基线-(.+)\.sha256$/.test(n)); } catch { return []; }
}

/** 版本 token → 数字元组（'v1.0-lite' → [1,0,0]；'0.5.0' → [0,5,0]；无数字 → [-1,-1,-1]） */
function versionKey(name) {
  const t = String(name).replace(/^内核基线-/, '').replace(/\.sha256$/, '').replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [-1, -1, -1];
}

function autoBaseline() {
  const names = listBaselines();
  if (!names.length) return '';
  const ranked = names.map((name) => {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(BASE_DIR, name)).mtimeMs; } catch { /* ignore */ }
    return { name, key: versionKey(name), mtimeMs };
  }).sort((a, b) => (b.key[0] - a.key[0]) || (b.key[1] - a.key[1]) || (b.key[2] - a.key[2]) || (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name, 'zh'));
  return path.join(BASE_DIR, ranked[0].name);
}

/** 返回 { file, auto, source, tried }；找不到时 file='' */
function resolveBaseline(v) {
  if (AUTO_TOKENS.has(String(v).trim())) {
    const f = autoBaseline();
    return { file: f, auto: true, source: 'auto', tried: [] };
  }
  const tried = [];
  const looksPath = /[\\/]/.test(v) || v.startsWith('.') || /^[A-Za-z]:/.test(v);
  const asPath = path.resolve(v);
  if (looksPath) tried.push(asPath);
  if (fs.existsSync(asPath)) return { file: asPath, auto: false, source: 'explicit', tried };
  const tokens = [];
  if (v.endsWith('.sha256')) tokens.push(v);
  else tokens.push(`内核基线-${v}.sha256`);
  if (!v.startsWith('内核基线-')) {
    if (v.startsWith('v')) tokens.push(`内核基线-${v.slice(1)}.sha256`);
    else tokens.push(`内核基线-v${v}.sha256`);
  }
  for (const t of tokens) {
    const p = path.join(BASE_DIR, t);
    tried.push(p);
    if (fs.existsSync(p)) return { file: p, auto: false, source: 'explicit', tried };
  }
  return { file: '', auto: false, source: 'explicit', tried };
}

const baseToken = (f) => path.basename(f).replace(/^内核基线-/, '').replace(/\.sha256$/, '');
const baseName = (f) => path.basename(f);

// ── --init 解析（name = basename 或版本 token；无值 = 0.5.0，逐字节兼容历史）────────
const initEq = args.find((a) => a.startsWith('--init='));
const INIT = initEq ? resolveInit(initEq.slice('--init='.length)) : (has('--init') ? resolveInit('') : null);

function resolveInit(v) {
  if (!v) return { name: '内核基线-0.5.0.sha256', token: '0.5.0', list: 'v05' };
  const name = v.toLowerCase().endsWith('.sha256') ? v : `内核基线-${v}.sha256`;
  const token = name.replace(/^内核基线-/, '').replace(/\.sha256$/, '');
  const list = /^v?0\.5(\.0)?$/.test(token) ? 'v05' : 'lite';
  return { name, token, list };
}

const INIT_FILE = INIT ? path.join(BASE_DIR, INIT.name) : '';

// ── --paths：只打印解析结果（不读基线、不写文件），便于外部脚本调用 ─────────────
if (has('--paths')) {
  const bl = INIT ? { file: INIT_FILE, auto: false, source: 'init' } : resolveBaseline(baselineArg);
  const info = {
    schema: 'v05-kernel-boundary/paths/1',
    toolVersion: TOOL_VERSION,
    tool: path.join(HERE, '工具-内核边界检查.mjs'),
    plugin: PLUGIN,
    package: PACKAGE,
    packageSource: pkgArg ? 'explicit' : 'default',
    packageRoot: PACKAGE_ROOT,
    packageExists: fs.existsSync(PACKAGE),
    target: TARGET,
    baseDir: BASE_DIR,
    baseline: bl.file,
    baselineName: bl.file ? baseName(bl.file) : '',
    baselineAuto: bl.auto,
    baselineSource: bl.source,
    baselineExists: Boolean(bl.file && fs.existsSync(bl.file)),
    initOutput: INIT_FILE,
    initName: INIT ? INIT.name : '',
    initToken: INIT ? INIT.token : '',
    initList: INIT ? INIT.list : '',
    initOutputExists: Boolean(INIT_FILE && fs.existsSync(INIT_FILE)),
  };
  if (AS_JSON) console.log(JSON.stringify(info, null, 2));
  else for (const [k, v] of Object.entries(info)) console.log(`${k}=${v}`);
  process.exit(0);
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── --init：从 --package 生成基线（覆盖已有基线必须 --force）─────────────────────
if (INIT) {
  if (!fs.existsSync(PACKAGE)) {
    console.error('目标包不存在：' + PACKAGE + (pkgArg ? '（--package=）' : '（默认 = 工具自身所在包）'));
    console.error('提示：用 --package=<目录> 指定包根；包根下有 01-代码 时会自动下钻。');
    process.exit(2);
  }
  if (!fs.existsSync(PACKAGE_ROOT)) {
    console.error('找不到包代码目录：' + PACKAGE_ROOT);
    process.exit(2);
  }
  if (fs.existsSync(INIT_FILE) && !FORCE) {
    console.error('拒绝覆盖已存在的基线：' + INIT_FILE);
    console.error('若确需覆盖（会改写已签字/已交付的基线），请显式加 --force。');
    console.error('新版本基线请换一个名字，例如：--init=内核基线-v1.0-lite.sha256 --package=.');
    process.exit(2);
  }
  const controlled = INIT.list === 'v05' ? CONTROLLED : LITE_CONTROLLED;
  const listLabel = INIT.list === 'v05' ? '0.5.0 名单' : 'lite 名单（6 KERNEL + 7 活 CONTROLLED）';
  const wanted = [
    ...KERNEL.map((rel) => ({ rel, kind: 'KERNEL' })),
    ...controlled.map((rel) => ({ rel, kind: 'CONTROLLED' })),
  ];
  const missing = wanted.filter((x) => !fs.existsSync(path.join(PACKAGE_ROOT, x.rel)));
  if (missing.length) {
    console.error('包内缺少名单文件，拒绝生成残缺基线：' + PACKAGE_ROOT);
    for (const x of missing) console.error(`  ! ${x.rel}  ${x.kind}`);
    console.error('提示：确认 --package 指向的包结构（包根含 01-代码 时会自动下钻）。');
    process.exit(2);
  }
  const lines = [`# 内核基线 ${INIT.token} · 由 工具-内核边界检查.mjs --init 生成`, '# 格式: <sha256>  <相对路径>  <KERNEL|CONTROLLED>'];
  for (const x of wanted) lines.push(`${sha(path.join(PACKAGE_ROOT, x.rel))}  ${x.rel}  ${x.kind}`);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.writeFileSync(INIT_FILE, lines.join('\n') + '\n', 'utf8');
  const meta = {
    schema: 'v05-kernel-boundary/init/1',
    toolVersion: TOOL_VERSION,
    init: { file: INIT_FILE, name: INIT.name, token: INIT.token, list: INIT.list, package: PACKAGE, packageRoot: PACKAGE_ROOT, kernel: KERNEL.length, controlled: controlled.length },
  };
  if (AS_JSON) console.log(JSON.stringify(meta, null, 2));
  else {
    console.log(`基线已写入 ${INIT_FILE}（${KERNEL.length} KERNEL / ${controlled.length} CONTROLLED · ${listLabel}）`);
    console.log(`生成源：${PACKAGE_ROOT}`);
  }
  process.exit(0);
}

// ── 检查：基线 / 目标存在性（缺失一律 exit 2）──────────────────────────────────
if (!fs.existsSync(PACKAGE)) {
  console.error('目标包不存在：' + PACKAGE + (pkgArg ? '（--package=）' : '（默认 = 工具自身所在包）'));
  console.error('提示：用 --package=<目录> 指定包根；包根下有 01-代码 时会自动下钻。');
  process.exit(2);
}
if (!fs.existsSync(TARGET)) {
  console.error('检查目标不存在：' + TARGET);
  process.exit(2);
}
const bl = resolveBaseline(baselineArg);
if (!bl.file) {
  if (bl.auto) console.error(`基线不存在：${BASE_DIR} 下没有任何 内核基线-*.sha256（先跑 --init=<basename> --package=<目录>）`);
  else console.error('基线不存在：' + bl.tried.join(' 或 '));
  const names = listBaselines();
  console.error('现有基线：' + (names.length ? names.join(', ') : '（无）'));
  console.error('提示：生成新基线用 --init=<basename> --package=<目录>；不传 --baseline 时自动选版本号最大的一份。');
  process.exit(2);
}
const BASELINE = bl.file;
const BASELINE_NAME = baseName(BASELINE);
const BASELINE_TOKEN = baseToken(BASELINE);

const rows = [];
for (const line of fs.readFileSync(BASELINE, 'utf8').split(/\r?\n/)) {
  const m = /^([0-9a-f]{64})\s+(\S+)\s+(KERNEL|CONTROLLED)$/.exec(line.trim());
  if (!m) continue;
  const rel = m[2];
  const abs = path.join(TARGET, rel);
  const kind = m[3];
  if (!fs.existsSync(abs)) { rows.push({ rel, kind, state: 'missing' }); continue; }
  const cur = sha(abs);
  rows.push({ rel, kind, state: cur === m[1] ? 'same' : 'changed', before: m[1], now: cur });
}
if (rows.length === 0) {
  console.error('基线文件没有可解析的行（格式应为：<sha256>  <相对路径>  <KERNEL|CONTROLLED>）：' + BASELINE);
  process.exit(2);
}

const kernelBad = rows.filter((r) => r.kind === 'KERNEL' && r.state !== 'same');
const ctrlChanged = rows.filter((r) => r.kind === 'CONTROLLED' && r.state === 'changed');
const ctrlMissing = rows.filter((r) => r.kind === 'CONTROLLED' && r.state === 'missing');

if (AS_JSON) {
  console.log(JSON.stringify({
    schema: 'v05-kernel-boundary/1',
    toolVersion: TOOL_VERSION,
    target: TARGET,
    package: PACKAGE,
    packageRoot: PACKAGE_ROOT,
    baseline: BASELINE,
    baselineName: BASELINE_NAME,
    baselineAuto: bl.auto,
    pathsSource: bl.source,
    result: kernelBad.length === 0 ? 'kernel-unchanged' : 'kernel-changed',
    kernelChanged: kernelBad,
    controlledChanged: ctrlChanged,
    controlledMissing: ctrlMissing,
    totals: { kernel: rows.filter((r) => r.kind === 'KERNEL').length, controlled: rows.filter((r) => r.kind === 'CONTROLLED').length },
  }, null, 2));
  process.exit(kernelBad.length === 0 ? 0 : 1);
}

console.log(`内核边界检查 · 目标=${TARGET}`);
console.log(`基线：${BASELINE}（${bl.auto ? '自动选：版本号最大' : '显式指定'}；${BASELINE_NAME}）`);
if (kernelBad.length === 0) {
  console.log(`[PASS] 内核 ${rows.filter((r) => r.kind === 'KERNEL').length} 个文件与 ${BASELINE_TOKEN} 基线逐字节相同`);
} else {
  console.log(`[FAIL] 内核被改动 ${kernelBad.length} 个文件（破坏冻结基线，须升版 + 机主签字）：`);
  for (const r of kernelBad) console.log(`  - ${r.rel}  ${r.state}`);
}
if (ctrlChanged.length) {
  console.log(`[提示] 受控文件变更 ${ctrlChanged.length} 个（允许，但必须五门全绿并登记本版差异）：`);
  for (const r of ctrlChanged) console.log(`  ~ ${r.rel}`);
}
if (ctrlMissing.length) {
  console.log(`[提示] 受控文件缺失 ${ctrlMissing.length} 个：`);
  for (const r of ctrlMissing) console.log(`  ! ${r.rel}`);
}
process.exit(kernelBad.length === 0 ? 0 : 1);
