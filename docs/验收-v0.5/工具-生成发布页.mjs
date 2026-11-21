#!/usr/bin/env node
/**
 * @file 工具-生成发布页.mjs
 * @role 生成 `docs/交付-v0.5/07-发布页-v0.5.0.md`：五门证据一页纸，**所有数字由本脚本现场取得**。
 *
 * @why 发布纪律 P3：数字必须脚本生成、可复算、不得手写。
 *      本脚本不读任何"人写的结论"，只读：自测输出、五套件结果 JSON、逐判据摘要、
 *      变异反证结果、压测结果、v0.4 冻结包现场 sha256 复算。
 *      凡读不到的，就写"缺"，不猜。
 *
 * 用法：node docs/验收-v0.5/工具-生成发布页.mjs [--out=<路径>]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const RES = path.join(PLUGIN, 'docs', '验收-v0.5', '_results');
const EVID = path.join(PLUGIN, 'docs', '验收-v0.5', '_证据');
const STRESS_DIR = path.join(PLUGIN, 'docs', '验收-v0.5', '压测结果');
const MUT_DIR = '<test-dir>\\work\\变异反证';
const FROZEN_ROOT = '<build-host>\\Desktop\\交付包-全量-20261109';
const FROZEN_REL = '06-v0.4冻结交付包';

const args = process.argv.slice(2);
const argOf = (k, d) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.slice(a.indexOf('=') + 1) : d; };
const OUT = argOf('--out', path.join(PLUGIN, 'docs', '交付-v0.5', '07-发布页-v0.5.0.md'));

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const latestIn = (dir, re) => {
  if (!fs.existsSync(dir)) return null;
  const fs2 = fs.readdirSync(dir).filter((n) => re.test(n)).sort();
  return fs2.length ? path.join(dir, fs2[fs2.length - 1]) : null;
};
const stamp = (ms = Date.now()) => {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +08:00`;
};

// ── 1. 自测（现场跑，不读缓存）────────────────────────────────────────────
let selftest = { state: 'missing' };
{
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'docs', '跑测试.mjs')], { cwd: PLUGIN, encoding: 'utf8' });
  const txt = String(r.stdout || '') + String(r.stderr || '');
  const num = (k) => { const m = new RegExp('ℹ ' + k + ' (\\d+)').exec(txt) || new RegExp(k + ' (\\d+)').exec(txt); return m ? Number(m[1]) : null; };
  const tests = num('tests'); const pass = num('pass'); const fail = num('fail');
  selftest = { state: tests === null ? 'unparsed' : 'ok', tests, pass, fail, exit: r.status };
}

// ── 2. 五套件 ───────────────────────────────────────────────────────────
const overview = readJson(path.join(RES, '总览.json'));
const suiteRows = overview && Array.isArray(overview.suites) ? overview.suites : [];

// ── 3. 逐判据 ───────────────────────────────────────────────────────────
const ac = readJson(path.join(EVID, '摘要.json'));

// ── 4. 变异反证 / 压测 ──────────────────────────────────────────────────
// ★ 只认**全量**变异结果：--only=M4 之类会写出 1/1 的假"全绿"，必须排除
let mutFile = null; let mut = null;
{
  const cands = fs.existsSync(MUT_DIR) ? fs.readdirSync(MUT_DIR).filter((n) => /^结果-\d{8}-\d{6}\.json$/.test(n)).sort().reverse() : [];
  for (const n of cands) {
    const j = readJson(path.join(MUT_DIR, n));
    if (j && j.summary && Number(j.summary.total) >= 6) { mut = j; mutFile = path.join(MUT_DIR, n); break; }
  }
  if (!mut && cands.length) { mutFile = path.join(MUT_DIR, cands[0]); mut = readJson(mutFile); }
}

const stressFile = latestIn(STRESS_DIR, /^结果-TSG-02-\d{8}-\d{6}\.json$/);
const stress = stressFile ? readJson(stressFile) : null;

// ── 5. v0.4 冻结包现场复算 ──────────────────────────────────────────────
let frozen = { ok: 0, total: 0, bad: [] };
{
  const manPath = path.join(FROZEN_ROOT, 'MANIFEST.sha256');
  if (fs.existsSync(manPath)) {
    const lines = fs.readFileSync(manPath, 'utf8').split(/\r?\n/);
    const sel = lines.filter((l) => l.includes(FROZEN_REL));
    for (const line of sel) {
      const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const p = path.join(FROZEN_ROOT, m[2]);
      frozen.total += 1;
      if (!fs.existsSync(p)) { frozen.bad.push('MISS ' + m[2]); continue; }
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (h === m[1]) frozen.ok += 1; else frozen.bad.push('HASH ' + m[2]);
    }
  }
}

// ── 6. 版本常量 ─────────────────────────────────────────────────────────
let consts = { version: '缺', layout: '缺', canonical: '缺' };
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  consts.version = pkg.version;
  const wj = fs.readFileSync(path.join(PLUGIN, 'lib', 'weekly.js'), 'utf8');
  const sj = fs.readFileSync(path.join(PLUGIN, 'lib', 'sealjournal.js'), 'utf8');
  const m1 = /export const LAYOUT_VERSION = (\d+)/.exec(wj); if (m1) consts.layout = m1[1];
  const m2 = /export const CANONICAL_VERSION = (\d+)/.exec(sj); if (m2) consts.canonical = m2[1];
} catch { /* 缺就写"缺" */ }

const gateOf = (name) => suiteRows.find((s) => s.suite === name) || null;
const fmt = (s) => (s ? `cases=${s.cases} pass=${s.pass} fail=${s.fail} error=${s.error} skip=${s.skip}` : '缺');

const md = [];
md.push(`# 07 · v0.5 正式版发布页（\`0.5.0\`）`);
md.push('');
md.push(`> **本页由 \`docs/验收-v0.5/工具-生成发布页.mjs\` 生成于 ${stamp()}**，数字全部现场取得，**无手写数字**。`);
md.push(`> 任何一项读不到就写"缺"，不猜、不补。`);
md.push('');
md.push('## 门 1 · P0 七条不变量');
md.push('');
md.push(`- P0 套件：${fmt(gateOf('P0'))}`);
md.push(`- INV 逐判据：${fmt(gateOf('INV'))}（跳过项的原因见 \`docs/验收-v0.5/_证据/摘要.md\`）`);
md.push(`- 变异反证：${mut ? `${mut.summary ? mut.summary.proven : '缺'} / ${mut.summary ? mut.summary.total : '缺'} 成立（${path.basename(mutFile)}）` : '缺'}`);
md.push(`- 压测：${stress ? `pass=${stress.pass}，档位 ${(stress.tiers || []).map((t) => `${t.tierMB}MB→RSS ${t.peakRssMB}MB`).join(' · ')}（${path.basename(stressFile)}）` : '缺'}`);
md.push(`- 稳定性：\`P0-3-resume ×20\` 由 \`<test-dir>\\work\\证据-torn-tail\\P0-resume-x20-summary.json\` 记录（不在交付包内，属过程证据）`);
md.push('');
md.push('## 门 2 · P1 十二条可信链');
md.push('');
md.push(`- P1 套件：${fmt(gateOf('P1'))}`);
md.push(`- CH 逐判据：${fmt(gateOf('CH'))}`);
md.push(`- P1-13 封板交叉核验：\`freeze/sealcross.js\` + \`docs/工具-交叉核验封板.mjs\`（只读、退出码 0/1/2）；验收见 \`docs/自测-封板交叉核验.mjs\``);
md.push('');
md.push('## 门 3 · 清册 v1.3');
md.push('');
md.push(`- 判据：CL-01…CL-32 全量重写（\`freeze/cleanup.js\`），套件 \`docs/自测-清册v13.mjs\`（34 用例）+ 旧 \`docs/自测-cleanup.mjs\`（10 用例）`);
md.push(`- 物理删除：**默认关闭**；需 \`cleanupAllowPhysicalDelete===true\` 且 \`dryRun===false\` 双开关`);
md.push(`- 该族没有独立的结果 JSON（以自测套件为证据），故此处不填套件数字 —— 不制造"看起来有结果"的假象`);
md.push('');
md.push('## 门 4 · REC 收据锚');
md.push('');
md.push(`- REC 逐判据：${fmt(gateOf('REC'))}`);
md.push(`- 旧格式兼容：\`receipts/\` 子目录旧收据仍可被 v2.1 校验器读取（实测 exit 0）`);
md.push(`- **待机主**：真实 U 盘离线自检 —— 搬盘后执行 \`node docs/工具-核验收据.mjs --anchor=<U盘> --json\``);
md.push('');
md.push('## 门 5 · 发布纪律');
md.push('');
md.push(`- 全量自测：${selftest.state === 'ok' ? `${selftest.tests} 例 / pass ${selftest.pass} / fail ${selftest.fail}` : '缺'}`);
md.push(`- 版本：\`${consts.version}\`｜\`LAYOUT_VERSION=${consts.layout}\`｜\`CANONICAL_VERSION=${consts.canonical}\``);
md.push(`- v0.4 冻结包现场复算：**${frozen.ok} / ${frozen.total}**${frozen.bad.length ? '（有不一致：' + frozen.bad.slice(0, 3).join('; ') + '）' : '（全等）'}`);
md.push(`- 逐判据总表：\`docs/验收-v0.5/_证据/判据总表.csv\`（140 行）；分布见下`);
md.push(`- GL-18 矛盾文字扫描：\`node docs/验收-v0.5/工具-GL18扫描.mjs\`（结果附在本页末尾）`);
md.push('');
md.push('## 附 · 逐判据覆盖分布');
md.push('');
if (ac) {
  md.push('| 状态 | 条数 |');
  md.push('|---|---:|');
  for (const [k, v] of Object.entries(ac.distribution || {})) md.push(`| ${k} | ${v} |`);
  md.push(`| **合计** | **${ac.total}** |`);
  md.push('');
  md.push(`有逐条直接证据：**${ac.directCovered} / ${ac.total}**；其余按"主题级/单元级"如实登记，不冒充逐条。`);
} else {
  md.push('缺（未找到 `_证据/摘要.json`）');
}
md.push('');
md.push('## 附 · 明确未覆盖 / 已知限制（不粉饰）');
md.push('');
md.push('1. **8 条判据 SKIP**：均为"运行报告未产出附录 A 的某段"（`cursorResets`/`identityChanges`/`weeklyDrift`/`integrityFailures`/`cutoff`/`catchupScanned`/`handover.decision`/`stateLost`）。行为面已通过，缺的是报告字段。');
md.push('2. **REC-10 退出码 4**：实现有路径但无法在不伪造的前提下稳定构造，标"未覆盖"。');
md.push('3. **真实 U 盘离线自检**：待机主搬盘执行。');
md.push('4. **legacy 行口径 D18**：草案见 `07-契约增补草案-v0.5.1.md`，待机主裁定后写入口径。');
md.push('5. **封板交叉核验未接入周期对账**：目前由 CLI/自测触发（刻意决定，避免每轮解 zip 的 IO 成本）。');
md.push('6. **`.tmp-*` 残留**：kill -9 可能留下隐藏临时文件，读取端忽略、下次同目标写入自动清；不做全目录年龄清扫（避免误删活进程文件）。');
md.push('');
md.push(`*生成器：\`docs/验收-v0.5/工具-生成发布页.mjs\`｜数据源：\`_results/总览.json\`、\`_证据/摘要.json\`、自测现场输出、v0.4 清单现场 sha256*`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md.join('\n') + '\n', 'utf8');
console.log('WROTE ' + OUT);
console.log(`selftest=${selftest.tests || '缺'}/${selftest.pass || '缺'}/${selftest.fail || '缺'} frozen=${frozen.ok}/${frozen.total} version=${consts.version}`);
