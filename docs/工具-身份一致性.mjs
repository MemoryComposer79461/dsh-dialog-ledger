#!/usr/bin/env node
/**
 * @file docs/工具-身份一致性.mjs
 * @role lite 线「交付身份一致性」自检器（v1.0.0-re 审计修复 M-02 / DEF-01 / m-01 / m-02 的守门员）。
 *
 * @why 为什么需要它：
 *   同一份包同时存在四个"版本号出处"（package.json / cordis.patch.yml 头 / README 标题 /
 *   VERSION.json）、三份"配置键集"（patch config / index.js readConfig 输入 / README 配置表）、
 *   两份"能力面描述"（package.json description / locale meta.description）与一份工具实现
 *   （tools/toolface.js）。历史审计里它们各自漂移：线上安装显示 0.9.0、README 标题写 v0.8.0、
 *   patch 头写 v0.5 正式候选、description 称 9 工具（实际 3 个）、README 写 19 键（readConfig 27 输入）、
 *   patch 注释 scanBudgetMs=3000（实值 30000）。靠人眼对不齐，所以做成可执行门。
 *
 * @why 全部**静态解析**，不 import 产品代码：identity 检查应在任何机器上、任何内存水位下都能跑
 *      （导入 lib/weekly.js 等 150KB+ 依赖链会为一个"对字段"的动作拉起几百 KB 源码与整条 import 图）。
 *      工具数取 `tools/toolface.js` 里 `const T = {...}` 的注册名集合（buildToolDefs 逐个用 T.* 注册，
 *      两者必须等量），配置取 `index.js` 的 `readConfig()` 函数体与 `DEFAULTS` 对象做静态核对。
 *
 * 检查项（任一 FAIL → exit 1）：
 *   ① 版本四处一致：package.json.version / cordis.patch.yml 首行 / README 首个标题 / VERSION.json.version
 *   ② 工具数与能力面：T 注册名数量 × buildToolDefs 注册点数量一致；package.json / locale / README
 *      声明的工具数 = 实际数；description 无 "9 工具 / 5 工具" 等失真表述；README 含全部工具名
 *   ③ 配置键集一致：README 配置表 == readConfig 输入（双向）；patch 显式键 ⊆ readConfig 且 ⊆ README；
 *      patch 注释里的默认值、README 表里的默认值、patch 实值、DEFAULTS 实值四方一致；
 *      默认兜底键数量必须与 README/patch 头声明一致
 *   ④ locale 三键：locale/*.json 的 meta.title/description/detail 齐全；detail 为包内相对 .md 且存在
 *   ⑤ 描述无失真（并入 ② 输出，单列便于看）：见上
 *   ⑥ loader 身份：package.json.name == patch id == patch name（同 profile 不 duplicate 的前提）
 *   ⑦ 死配置标注：若 patch 仍保留 cleanupToolEnabled / cleanupAllowPhysicalDelete，则 patch 头与 README
 *      必须显式标注 legacy 占位 + 无运行期消费者（审计 m-01 的另一个同源问题：配置面冻结不删键）
 *
 * 用法：
 *   node docs\工具-身份一致性.mjs [--root=<repo>] [--json]
 *   （默认 root = 本文件所在 docs/ 的上一级；--json 只输出机读结果）
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 用法错误 / 环境缺文件（无法完成审计）。
 *
 * @reads  package.json、cordis.patch.yml、README.md、VERSION.json、locale/*.json、index.js、
 *         tools/toolface.js（全部只读；不写任何文件）
 * @depends node:fs / node:path / node:url（零第三方依赖；不 import 产品代码）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

// ---------------------------------------------------------------------------
// 一、参数 / 环境
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const wantHelp = argv.includes('--help') || argv.includes('-h');
const asJson = argv.includes('--json');
const rootArg = argv.find((a) => a.startsWith('--root='));
const unknown = argv.filter((a) => a !== '--json' && a !== '--help' && a !== '-h' && !a.startsWith('--root='));

function usage() {
  return [
    '用法：node docs\\工具-身份一致性.mjs [--root=<repo>] [--json]',
    '  检查：①版本四处一致 ②工具数与能力面 ③配置键集一致 ④locale 三键 ⑤描述无失真',
    '        ⑥loader 身份一致 ⑦死配置已标注',
    '  退出码：0=全 PASS；1=有 FAIL；2=用法/环境错误',
  ].join('\n');
}

if (wantHelp) {
  console.log(usage());
  process.exit(0);
}
if (unknown.length > 0) {
  console.error('[用法错误] 不认识的参数: ' + unknown.join(' ') + '\n' + usage());
  process.exit(2);
}
const ROOT = rootArg ? path.resolve(rootArg.slice('--root='.length)) : DEFAULT_ROOT;

// ---------------------------------------------------------------------------
// 二、只读工具函数
// ---------------------------------------------------------------------------
const checks = [];
function pushCheck(id, name, status, detail) {
  checks.push({ id, name, status, detail: String(detail || '') });
}
function pass(id, name, detail) { pushCheck(id, name, 'PASS', detail); }
function fail(id, name, detail) { pushCheck(id, name, 'FAIL', detail); }

/** 读 UTF-8 文本；缺文件 = 无法审计（exit 2）。 */
function readText(rel) {
  const abs = path.join(ROOT, rel);
  try {
    return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    fatal(`无法读取必需文件 ${rel}: ${e && e.message ? e.message : String(e)}`);
  }
}
function readJson(rel) {
  const text = readText(rel);
  try {
    return JSON.parse(text);
  } catch (e) {
    fatal(`${rel} 不是合法 JSON: ${e && e.message ? e.message : String(e)}`);
  }
}
function fatal(msg) {
  console.error('[FATAL] ' + msg);
  console.error('（环境/用法错误 → exit 2）');
  process.exit(2);
}
/** 取第一个括号块 `{...}` 的内部文本（字符串/注释里的花括号不参与配对；本仓产品代码无此类字面量）。 */
function balancedInner(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}
/** 找 `marker` 之后的第一个 `{` 并返回其内部文本。 */
function blockAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  return balancedInner(src, open);
}
/** 解析 JS 字面量标量：数字 / true / false / 单双引号字符串 / 整数乘法表达式（`16 * 1024 * 1024`）。 */
function parseScalar(raw) {
  const s = String(raw || '').trim().replace(/,$/, '').trim();
  if (s === '') return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (/^-?\d+(?:\.\d+)?(?:\s*\*\s*-?\d+(?:\.\d+)?)+$/.test(s)) {
    return s.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  const m = s.match(/^'(.*)'$/) || s.match(/^"(.*)"$/);
  if (m) return m[1];
  return undefined;
}
function sortKeys(iterable) {
  return Array.from(iterable).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
function diffSets(actualSet, expectedSet) {
  const missing = sortKeys(expectedSet).filter((k) => !actualSet.has(k));
  const extra = sortKeys(actualSet).filter((k) => !expectedSet.has(k));
  return { missing, extra };
}
function fmtSetDiff(d) {
  const parts = [];
  if (d.missing.length) parts.push('缺 [' + d.missing.join(', ') + ']');
  if (d.extra.length) parts.push('多 [' + d.extra.join(', ') + ']');
  return parts.join('；');
}

// ---------------------------------------------------------------------------
// 三、读入身份文件（缺任一 = exit 2）
// ---------------------------------------------------------------------------
const pkg = readJson('package.json');
const versionJson = readJson('VERSION.json');
const readme = readText('README.md');
const patchText = readText('cordis.patch.yml');
const indexText = readText('index.js');
const toolfaceText = readText('tools/toolface.js');
const localeDir = path.join(ROOT, 'locale');
let localeNames = [];
try {
  localeNames = fs.readdirSync(localeDir).filter((n) => n.endsWith('.json')).sort();
} catch (e) {
  fatal(`无法列 locale/: ${e && e.message ? e.message : String(e)}`);
}
if (!localeNames.includes('zh.json') || !localeNames.includes('en.json')) {
  fatal('locale/ 必须同时提供 zh.json 与 en.json');
}

// ---------------------------------------------------------------------------
// 四、① 版本四处一致
// ---------------------------------------------------------------------------
const VER_TOKEN = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;
const firstLine = (s) => (s.split(/\r?\n/)[0] || '');
const vPkg = String(pkg.version || '');
const vReadme = (firstLine(readme).match(VER_TOKEN) || [])[1] || '';
const vPatch = (firstLine(patchText).match(VER_TOKEN) || [])[1] || '';
const vJson = String(versionJson.version || '');
const versionSites = {
  'package.json.version': vPkg,
  'cordis.patch.yml 首行': vPatch,
  'README 首行标题': vReadme,
  'VERSION.json.version': vJson,
};
const versionSet = new Set(Object.values(versionSites));
if (versionSet.size === 1 && vPkg) {
  pass('①', '版本四处一致', `${vPkg} × 4（${Object.keys(versionSites).join(' / ')}）`);
} else {
  fail('①', '版本四处一致', Object.entries(versionSites).map(([k, v]) => `${k}=${v || '(未找到)'}`).join('；'));
}

// ---------------------------------------------------------------------------
// 五、② 工具数与能力面（tools/toolface.js 实际注册名）
// ---------------------------------------------------------------------------
const tBlock = blockAfter(toolfaceText, 'const T = {');
const toolNames = [];
if (!tBlock) {
  fatal('tools/toolface.js 里找不到 `const T = {` 注册名表（无法审计工具数）');
}
for (const m of tBlock.inner.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'(ledger_[a-z_]+)'/g)) {
  toolNames.push(m[2]);
}
// buildToolDefs 的返回数组里每个工具都写成 `name: T.<x>,`；注册点数量必须与 T 表等量。
const registeredAt = [...toolfaceText.matchAll(/\bname:\s*T\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
const toolNamesUniq = Array.from(new Set(toolNames)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const actualToolCount = toolNamesUniq.length;
let toolsOk = toolNamesUniq.length > 0 && registeredAt.length === toolNamesUniq.length;
let toolsDetail = `实际 ${actualToolCount} 个（${toolNamesUniq.join(', ')}）；buildToolDefs 注册点 ${registeredAt.length} 处`;
if (!toolsOk) {
  toolsDetail += '；★ 注册名表与注册点数量不一致（T 表 ' + toolNamesUniq.length + ' vs 注册点 ' + registeredAt.length + '）';
}

// 声明的工具数：package.json.description + 每个 locale 的 meta.description
const locales = {};
for (const name of localeNames) {
  locales[name] = readJson(path.join('locale', name));
}
const descriptionSites = [['package.json.description', String(pkg.description || '')]];
for (const name of localeNames) {
  const meta = locales[name] && locales[name].meta;
  descriptionSites.push([`locale/${name} meta.description`, String((meta && meta.description) || '')]);
}
const claims = [];
const stalePattern = /(?:^|[^\d])(?:9|5)\s*(?:个)?\s*工具|\b(?:9|5)\s+tools?\b/i;
for (const [label, text] of descriptionSites) {
  for (const m of text.matchAll(/(\d+)\s*个[^，。；\n]{0,20}工具/g)) {
    claims.push({ label, count: Number(m[1]), text: m[0] });
  }
  for (const m of text.matchAll(/(\d+)\s+(?:read-only\s+)?(?:agent\s+)?tools?\b/gi)) {
    claims.push({ label, count: Number(m[1]), text: m[0] });
  }
  if (stalePattern.test(text)) {
    toolsOk = false;
    toolsDetail += `；★ ${label} 含失真表述（9/5 工具）`;
  }
}
const badClaims = claims.filter((c) => c.count !== actualToolCount);
if (claims.length === 0) {
  toolsOk = false;
  toolsDetail += '；★ description 未声明工具数（无法核对能力面）';
}
for (const c of badClaims) {
  toolsOk = false;
  toolsDetail += `；★ ${c.label} 写 "${c.text}" ≠ 实际 ${actualToolCount}`;
}
// README 必须以可核对的形式声明工具数与全部工具名（"N 个只读 Agent 工具" 为口径句）
const readmeCountClaim = `${actualToolCount} 个只读 Agent 工具`;
if (!readme.includes(readmeCountClaim)) {
  toolsOk = false;
  toolsDetail += `；★ README 缺口径句 "${readmeCountClaim}"`;
}
const missingToolNames = toolNamesUniq.filter((n) => !readme.includes(n));
if (missingToolNames.length > 0) {
  toolsOk = false;
  toolsDetail += `；★ README 未列出工具 [${missingToolNames.join(', ')}]`;
}
if (toolsOk) pass('②', '工具数与能力面一致', toolsDetail);
else fail('②', '工具数与能力面一致', toolsDetail);

// ---------------------------------------------------------------------------
// 六、③ 配置键集一致
// ---------------------------------------------------------------------------
// 6.1 readConfig 实际输入（静态解析函数体：c.<key> 与 ingest.<key>）
const rcBlock = blockAfter(indexText, 'function readConfig(config)');
if (!rcBlock) fatal('index.js 里找不到 `function readConfig(config)` 函数体（无法审计配置输入）');
const readInputs = new Set();
for (const m of rcBlock.inner.matchAll(/\bc\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
  if (m[1] !== 'ingest') readInputs.add(m[1]);
}
for (const m of rcBlock.inner.matchAll(/\bing\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
  readInputs.add('ingest.' + m[1]);
}

// 6.2 DEFAULTS 默认值（静态解析：顶层标量 + ingest 子对象）
const defaultsBlock = blockAfter(indexText, 'const DEFAULTS = {');
if (!defaultsBlock) fatal('index.js 里找不到 `const DEFAULTS = {`（无法核对默认值）');
const defaults = new Map();
for (const rawLine of defaultsBlock.inner.split(/\r?\n/)) {
  const m = rawLine.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
  if (!m) continue;
  if (m[1] === 'ingest') continue; // 子对象单独解析
  const v = parseScalar(m[2]);
  if (v !== undefined) defaults.set(m[1], v);
}
const ingestBlock = blockAfter(defaultsBlock.inner, 'ingest: {');
if (ingestBlock) {
  for (const rawLine of ingestBlock.inner.split(/\r?\n/)) {
    const m = rawLine.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const v = parseScalar(m[2]);
    if (v !== undefined) defaults.set('ingest.' + m[1], v);
  }
}
const defaultsKeys = new Set(defaults.keys());
const rcVsDefaults = diffSets(readInputs, defaultsKeys);
let defaultsOk = rcVsDefaults.missing.length === 0 && rcVsDefaults.extra.length === 0;

// 6.3 patch config 显式键/值
function parseYamlScalar(raw) {
  const s = String(raw || '').trim();
  if (s === '' || s === "''" || s === '""') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = s.match(/^'(.*)'$/) || s.match(/^"(.*)"$/);
  if (m) return m[1];
  return s;
}
const patchConfig = new Map();
{
  const lines = patchText.split(/\r?\n/);
  let inConfig = false;
  for (const line of lines) {
    if (!inConfig) {
      if (/^ {6}config:\s*$/.test(line)) inConfig = true;
      continue;
    }
    if (/^\s*$/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent < 8) break; // 离开 config 块
    const m = line.match(/^ {8}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    patchConfig.set(m[1], parseYamlScalar(m[2]));
  }
}
if (patchConfig.size === 0) fatal('cordis.patch.yml 里解析不到 config 键集（无法审计配置面）');

// 6.4 README 配置表（## 配置 到下一个 ## 之间）
const readmeConfig = new Map();
{
  const lines = readme.split(/\r?\n/);
  let inSec = false;
  for (const line of lines) {
    if (!inSec) {
      if (/^##\s*配置/.test(line)) inSec = true;
      continue;
    }
    if (/^##\s/.test(line)) break;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/);
    if (!m) continue;
    const key = m[1].trim();
    if (readmeConfig.has(key)) {
      readmeConfig.set(key, readmeConfig.get(key) + '\u0000dup');
    } else {
      readmeConfig.set(key, m[2].trim());
    }
  }
}
const readmeDup = [...readmeConfig.entries()].filter(([, v]) => v.includes('\u0000dup')).map(([k]) => k);
for (const k of readmeDup) readmeConfig.delete(k);

// 6.5 三方比对
let configOk = true;
const configNotes = [];
const readmeVsRead = diffSets(new Set(readmeConfig.keys()), readInputs);
if (readmeVsRead.missing.length || readmeVsRead.extra.length) {
  configOk = false;
  configNotes.push('README ≠ readConfig：' + fmtSetDiff(readmeVsRead));
}
if (readmeDup.length) {
  configOk = false;
  configNotes.push('README 配置表重复键 [' + readmeDup.join(', ') + ']');
}
const patchVsRead = diffSets(new Set(patchConfig.keys()), readInputs);
if (patchVsRead.extra.length) {
  configOk = false;
  configNotes.push('patch 含 readConfig 不认识的键 ' + fmtSetDiff(patchVsRead));
}
const patchVsReadme = diffSets(new Set(patchConfig.keys()), new Set(readmeConfig.keys()));
if (patchVsReadme.extra.length) {
  configOk = false;
  configNotes.push('patch 键未写进 README ' + fmtSetDiff(patchVsReadme));
}
const fallbackKeys = sortKeys(patchVsRead.missing);
if (!defaultsOk) {
  configOk = false;
  configNotes.push('readConfig 输入 ≠ DEFAULTS 键集：' + fmtSetDiff(rcVsDefaults));
}
// 默认兜底键数量必须与 README / patch 头声明一致
if (fallbackKeys.length > 0) {
  if (!readme.includes(fallbackKeys.length + ' 个默认兜底')) {
    configOk = false;
    configNotes.push(`README 未声明 "${fallbackKeys.length} 个默认兜底" 键`);
  }
  if (!patchText.includes(fallbackKeys.length + ' 个由')) {
    configOk = false;
    configNotes.push(`patch 头未声明 "其余 ${fallbackKeys.length} 个由 readConfig/DEFAULTS 兜底"`);
  }
}
// 三处数量口径也必须同步（README 标题 / patch 头注释）
if (!readme.includes(readInputs.size + ' 个输入')) {
  configOk = false;
  configNotes.push(`README 未声明 "${readInputs.size} 个输入"`);
}
if (!readme.includes(patchConfig.size + ' 键')) {
  configOk = false;
  configNotes.push(`README 未声明 patch 显式 "${patchConfig.size} 键"`);
}
if (!patchText.includes(readInputs.size + ' 个输入')) {
  configOk = false;
  configNotes.push(`patch 头未声明 "readConfig 实际读 ${readInputs.size} 个输入"`);
}
if (!patchText.includes(patchConfig.size + ' 个稳定键')) {
  configOk = false;
  configNotes.push(`patch 头未声明 "显式写 ${patchConfig.size} 个稳定键"`);
}
// 6.6 取值四方核对：patch 实值 vs DEFAULTS；README 表值 vs DEFAULTS（根键按空串口径）
function cellMatches(cellRaw, expect) {
  const cell = String(cellRaw).trim().replace(/^`|`$/g, '').trim();
  if (typeof expect === 'number') {
    const m = cell.match(/^-?\d+(?:\.\d+)?$/);
    return !!m && Number(m[0]) === expect;
  }
  if (typeof expect === 'boolean') return cell === String(expect);
  if (expect === '') return /^(空|''|""|无)$/.test(cell);
  return cell === expect;
}
function expectOf(key) {
  if (key === 'root') return ''; // 输出值是解析后的绝对路径；输入口径的默认是空
  return defaults.get(key);
}
const valueMismatches = [];
for (const [key, value] of patchConfig) {
  const expect = expectOf(key);
  if (expect === undefined) continue;
  if (typeof value !== typeof expect || value !== expect) {
    valueMismatches.push(`patch ${key}=${JSON.stringify(value)} ≠ DEFAULTS ${JSON.stringify(expect)}`);
  }
}
for (const [key, cell] of readmeConfig) {
  const expect = expectOf(key);
  if (expect === undefined) {
    configOk = false;
    configNotes.push(`README 键 ${key} 在 DEFAULTS 里没有默认值`);
    continue;
  }
  if (!cellMatches(cell, expect)) {
    valueMismatches.push(`README ${key}=${JSON.stringify(cell)} ≠ 默认 ${JSON.stringify(expect)}`);
  }
}
if (valueMismatches.length) {
  configOk = false;
  configNotes.push(...valueMismatches);
}
// 6.7 patch 头注释里的默认值必须等于 patch 实值（审计：注释 3000 vs 实值 30000）
const commentDefaults = new Map();
for (const line of patchText.split(/\r?\n/)) {
  const m = line.match(/^#\s{2,}([a-z][A-Za-z0-9]*)\s+(.*)$/);
  if (!m || commentDefaults.has(m[1])) continue;
  const paren = m[2].match(/（([^）]*)）/);
  if (!paren) continue;
  const num = paren[1].match(/\d+/);
  if (num) commentDefaults.set(m[1], Number(num[0]));
}
for (const [key, num] of commentDefaults) {
  if (!patchConfig.has(key)) continue;
  const value = patchConfig.get(key);
  if (typeof value === 'number' && value !== num) {
    configOk = false;
    configNotes.push(`patch 注释 ${key}=${num} ≠ 配置实值 ${value}`);
  }
}
const countText = `readConfig ${readInputs.size} 输入 / README ${readmeConfig.size} 键 / patch 显式 ${patchConfig.size} 键` +
  (fallbackKeys.length ? `（另 ${fallbackKeys.length} 个默认兜底：${fallbackKeys.join(', ')}）` : '');
if (configOk) pass('③', '配置键集一致', countText);
else fail('③', '配置键集一致', countText + '\n      ' + configNotes.join('\n      '));

// ---------------------------------------------------------------------------
// 七、④ locale 三键
// ---------------------------------------------------------------------------
const localeProblems = [];
const localeDetails = [];
for (const name of localeNames) {
  const meta = locales[name] && locales[name].meta;
  const label = 'locale/' + name;
  if (!meta || typeof meta !== 'object') {
    localeProblems.push(`${label} 缺 meta 对象`);
    continue;
  }
  for (const key of ['title', 'description', 'detail']) {
    if (typeof meta[key] !== 'string' || meta[key].trim() === '') {
      localeProblems.push(`${label} meta.${key} 缺失或为空`);
    }
  }
  const detail = typeof meta.detail === 'string' ? meta.detail.trim() : '';
  if (!detail) continue;
  const segs = detail.split('/');
  if (detail.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(detail) ||
      segs.some((s) => s === '' || s === '.' || s === '..')) {
    localeProblems.push(`${label} meta.detail 不是包内相对路径: ${detail}`);
    continue;
  }
  if (!/\.(?:md|markdown)$/i.test(detail)) {
    localeProblems.push(`${label} meta.detail 不是 .md/.markdown: ${detail}`);
    continue;
  }
  const abs = path.join(ROOT, ...detail.split('/'));
  let stat = null;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    localeProblems.push(`${label} meta.detail 指向的文件不存在: ${detail}`);
    continue;
  }
  if (stat.size > 1024 * 1024) {
    localeProblems.push(`${label} meta.detail 文档超过 1 MiB: ${detail} (${stat.size} B)`);
  }
  localeDetails.push(`${name}:${detail}`);
}
if (localeProblems.length === 0) pass('④', 'locale 三键齐全', localeDetails.join('；'));
else fail('④', 'locale 三键齐全', localeProblems.join('；'));

// ---------------------------------------------------------------------------
// 八、⑤ 描述无失真（单列复核；与 ② 同源但独立报告）
// ---------------------------------------------------------------------------
const distortion = [];
for (const [label, text] of descriptionSites) {
  if (stalePattern.test(text)) distortion.push(`${label} 含 "9/5 工具" 失真表述`);
  for (const m of text.matchAll(/(\d+)\s*个[^，。；\n]{0,20}工具/g)) {
    if (Number(m[1]) !== actualToolCount) distortion.push(`${label} 写 "${m[0]}" ≠ ${actualToolCount}`);
  }
}
for (const n of toolNamesUniq) {
  // 能力面声明必须点名全部工具（缺失 = 描述不全，不通过）
  if (!descriptionSites.map((x) => x[1]).join('\n').includes(n) && !readme.includes(n)) {
    distortion.push(`描述与 README 均未提到工具 ${n}`);
  }
}
if (distortion.length === 0) pass('⑤', '描述无失真', `无 9/5 工具表述；工具数 ${actualToolCount} 与实现一致`);
else fail('⑤', '描述无失真', distortion.join('；'));

// ---------------------------------------------------------------------------
// 九、⑥ loader 身份三方一致
// ---------------------------------------------------------------------------
const patchId = (patchText.match(/^\s*-\s*id:\s*([^\s#]+)/m) || [])[1] || '';
const patchName = (patchText.match(/^\s+name:\s*([^\s#]+)/m) || [])[1] || '';
const pkgName = String(pkg.name || '');
if (pkgName && pkgName === patchId && pkgName === patchName) {
  pass('⑥', 'loader 身份一致', `${pkgName} × 3（package.json.name / patch id / patch name）`);
} else {
  fail('⑥', 'loader 身份一致', `package.json.name=${pkgName || '(空)'}；patch id=${patchId || '(空)'}；patch name=${patchName || '(空)'}`);
}

// ---------------------------------------------------------------------------
// 十、⑦ 死配置标注（cleanup 两键：保留不删时必须在 patch 头与 README 标注 legacy）
// ---------------------------------------------------------------------------
const deadKeys = ['cleanupToolEnabled', 'cleanupAllowPhysicalDelete'].filter((k) => patchConfig.has(k));
if (deadKeys.length === 0) {
  pass('⑦', '死配置标注', 'patch 已不含清理两键（已删除）');
} else {
  const patchComments = patchText.split(/\r?\n/).filter((l) => /^#/.test(l)).join('\n');
  const legacyRe = /legacy/i;
  const consumerRe = /无(?:任何)?运行期消费者/;
  const problems = [];
  if (!legacyRe.test(patchComments) || !consumerRe.test(patchComments)) {
    problems.push('patch 头未标注 legacy / 无运行期消费者');
  }
  if (!legacyRe.test(readme) || !consumerRe.test(readme)) {
    problems.push('README 未标注 legacy / 无运行期消费者');
  }
  if (problems.length === 0) {
    pass('⑦', '死配置标注', `${deadKeys.join(' / ')} 均标注为 legacy 占位 + 无运行期消费者`);
  } else {
    fail('⑦', '死配置标注', problems.join('；'));
  }
}

// ---------------------------------------------------------------------------
// 十一、汇总输出
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => c.status === 'FAIL');
const exitCode = failed.length === 0 ? 0 : 1;
if (asJson) {
  console.log(JSON.stringify({
    schema: 'identity-consistency/1',
    root: ROOT,
    ok: failed.length === 0,
    actualTools: toolNamesUniq,
    actualToolCount,
    versions: versionSites,
    config: {
      readConfigInputs: sortKeys(readInputs),
      patchKeys: sortKeys(patchConfig.keys()),
      readmeKeys: sortKeys(readmeConfig.keys()),
      fallbackKeys,
    },
    checks,
    exitCode,
  }, null, 2));
} else {
  console.log('[身份一致性] root=' + ROOT);
  const badge = (c) => (c.status === 'PASS' ? 'PASS' : 'FAIL');
  for (const c of checks) {
    console.log(`  ${c.id} ${c.name.padEnd(14, '　')} ${badge(c)}  ${c.detail.split('\n').join('\n' + ' '.repeat(24))}`);
  }
  console.log('');
  if (failed.length === 0) {
    console.log(`[PASS] ${checks.length}/${checks.length} 项通过，exit 0`);
  } else {
    console.log(`[FAIL] ${failed.length}/${checks.length} 项失败：` + failed.map((c) => c.id).join(' '));
    console.log('      修复口径：版本统一 = package.json/cordis 头/README/VERSION.json 同一版本号；');
    console.log('      能力面 = 3 个只读 Agent 工具（ledger_search/ledger_turn/ledger_health）；');
    console.log('      配置 = README 表 == readConfig 输入、patch 显式键 ⊆ 两者、默认值四方一致；');
    console.log('      locale = meta.title/description/detail 三键 + detail 指向真实包内 .md。');
  }
}
process.exit(exitCode);
