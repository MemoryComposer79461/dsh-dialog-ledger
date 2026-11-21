/**
 * @file 验收-v0.5.mjs
 * @role v0.5 独立黑盒验收总控：串行跑 P0回归-v2 / 验收-P1 / 验收-REC 三个测试文件，
 *       合并判据统计，生成《验收报告-v0.5.md》（通过 / 失败 / 人工待验 / 未覆盖 四张表）。
 *
 * @why 为什么单独一个总控而不是 node --test：
 *   ① 资源纪律要求"一次只跑一个测试文件、跑前打印可用内存、<0.5GB 只写不跑"；
 *   ② 审计要求"未覆盖必须明写原因"——总控按判据注册表反查覆盖，缺一条就进未覆盖表；
 *   ③ 报告要能脚本重生成（数字不手写）。
 *
 * 用法：
 *   node docs/验收-v0.5/验收-v0.5.mjs [--out=docs/验收-v0.5/_results]
 * 产物：
 *   <out>/结果-v0.5.json
 *   docs/验收-v0.5/验收报告-v0.5.md
 *
 * ★ 诚实声明（写进报告）：P0/P1 修复尚在进行中时，本脚本本来就是红的；
 *   红/绿只代表"当下代码快照"的证据，不代表审计结论。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ALL_CRITERIA, CRITERIA, GROUP_IDS, groupOf } from './_criteria.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const DOCS = path.join(PLUGIN, 'docs', '验收-v0.5');
const GEN = path.join(DOCS, '生成大会话.mjs');
const MIN_FREE_MB = 500;

function parseArgs(argv) {
  const out = { out: path.join(DOCS, '_results') };
  for (const a of argv.slice(2)) if (a.startsWith('--out=')) out.out = path.resolve(a.slice(6));
  return out;
}
const args = parseArgs(process.argv);
fs.mkdirSync(args.out, { recursive: true });

const freeMemMB = () => Math.round(os.freemem() / (1024 * 1024));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function snapshotCode() {
  const files = [];
  const add = (rel) => { const p = path.join(PLUGIN, rel); if (fs.existsSync(p)) files.push([rel, sha(p), fs.statSync(p).size]); };
  add('index.js');
  add('package.json');
  for (const n of fs.readdirSync(path.join(PLUGIN, 'lib')).sort()) add(path.join('lib', n));
  return Object.fromEntries(files);
}

const SUITES = [
  { key: 'P0', name: 'P0回归-v2（P0 七条 + P0-3 + P1-6 + REC 核心）', file: path.join(PLUGIN, 'P0验收', 'P0回归-v2.mjs'), out: path.join(args.out, 'P0.json'), criteria: GROUP_IDS.P0 },
  { key: 'P1', name: '验收-P1（P1 十二条）', file: path.join(DOCS, '验收-P1.mjs'), out: path.join(args.out, 'P1.json'), criteria: GROUP_IDS.P1 },
  { key: 'REC', name: '验收-REC（REC-1…7）', file: path.join(DOCS, '验收-REC.mjs'), out: path.join(args.out, 'REC.json'), criteria: GROUP_IDS.REC },
];

// 人工待验说明：黑盒不可直接观测、必须有代理证据/人工确认的子项
const MANUAL_NOTES = {
  'P0-3': '内存上限/取消/kill -9 可续已机器验收；"批数/事件数/字节数的显式上限阈值"属实现内部策略，黑盒只能验外部表现（RSS/退出/续跑），阈值合理性需实现自证或人工审阅',
  'REC-7': '"锚目录落桌面、机主手动搬 U 盘"已验桌面锚+CLI 任意路径；"Agent 不读写 U 盘"是流程纪律，无法由本机自动证伪，需人工确认',
};

function runSuite(s) {
  const free = freeMemMB();
  console.log(`\n========== ${s.name} ==========`);
  console.log(`可用内存 ${free} MB（阈值 ${MIN_FREE_MB} MB）`);
  if (free < MIN_FREE_MB) {
    return { skipped: true, reason: `资源纪律：可用内存 ${free}MB < ${MIN_FREE_MB}MB，只写不跑`, results: [] };
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [s.file, `--out=${s.out}`], { stdio: 'inherit', timeout: 900_000, env: { ...process.env } });
  const durationMs = Date.now() - t0;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(s.out, 'utf8')); } catch { /* ignore */ }
  return { skipped: false, exit: r.status, durationMs, data };
}

function main() {
  const startedAt = new Date().toISOString();
  const freeBefore = freeMemMB();
  console.log(`v0.5 验收总控：可用内存 ${freeBefore} MB；被测目录 ${PLUGIN}`);
  const codeSnapshot = snapshotCode();

  const suiteRuns = {};
  // 逐个子跑；资源纪律：<0.5GB 时只写不跑
  for (const s of SUITES) suiteRuns[s.key] = runSuite(s);

  // 任务级断言：36MB 生成器自检（流式、内存有界）
  const genOut = path.join(os.tmpdir(), 'v05-gen', 'session.v4.jsonl.zstd');
  let genCheck = { ok: false, evidence: '未运行（内存不足或前置失败）' };
  if (freeMemMB() >= MIN_FREE_MB) {
    const r = spawnSync(process.execPath, [GEN, `--out=${genOut}`], { encoding: 'utf8', timeout: 180_000, env: { ...process.env } });
    try {
      const obj = JSON.parse((r.stdout || '').trim().split('\n').slice(-1)[0] || (r.stdout || '{}'));
      const g = obj.generate || {};
      const v = obj.verify || {};
      genCheck = {
        ok: r.status === 0 && g.ok === true && v.ok === true && g.uncompressedBytes >= 36 * 1024 * 1024 && g.turns >= 1000 && g.peakRssMB <= 600,
        evidence: `生成 ${g.turns} 轮 / 解压后 ${(g.uncompressedBytes / 1048576).toFixed(1)}MB / ${g.frames} 帧 / 写盘峰 RSS ${g.peakRssMB}MB；流式校验 ok=${v.ok}（${v.turns} 轮）`,
        raw: { generate: g, verify: v },
      };
    } catch (e) {
      genCheck = { ok: false, evidence: `生成器自检解析失败：${e.message}；stdout=${(r.stdout || '').slice(0, 300)}` };
    }
  }

  // ---- 合并判据状态 ----
  const criterionState = new Map(ALL_CRITERIA.map((id) => [id, { id, group: groupOf(id), title: CRITERIA[id].title, status: 'UNCOVERED', cases: [], reason: '' }]));
  const allCases = [];
  for (const s of SUITES) {
    const run = suiteRuns[s.key];
    const data = run.data;
    if (!data) {
      for (const id of s.criteria) {
        const st = criterionState.get(id);
        st.status = 'UNCOVERED';
        st.reason = run.skipped ? run.reason : `测试文件未产出结果（exit=${run.exit}）`;
      }
      continue;
    }
    for (const c of data.results || []) {
      allCases.push({ suite: s.key, ...c });
      for (const id of c.criteria || []) {
        if (!criterionState.has(id)) continue;
        const st = criterionState.get(id);
        st.cases.push({ suite: s.key, id: c.id, status: c.status, evidence: c.evidence, durationMs: c.durationMs });
        if (c.status === 'FAIL' || c.status === 'ERROR') st.status = 'FAIL';
        else if (c.status === 'PASS' && st.status !== 'FAIL') st.status = 'PASS';
        else if (c.status === 'SKIPPED' && st.status !== 'FAIL' && st.status !== 'PASS') { st.status = 'UNCOVERED'; st.reason = c.evidence; }
      }
    }
  }
  for (const st of criterionState.values()) {
    if (st.status === 'UNCOVERED' && !st.reason) {
      st.reason = st.cases.length === 0 ? '本轮没有测试用例覆盖该判据' : (st.cases.find((c) => c.status === 'SKIPPED') || {}).evidence || '用例被跳过';
    }
  }
  const summary = {
    total: ALL_CRITERIA.length,
    pass: [...criterionState.values()].filter((x) => x.status === 'PASS').length,
    fail: [...criterionState.values()].filter((x) => x.status === 'FAIL').length,
    uncovered: [...criterionState.values()].filter((x) => x.status === 'UNCOVERED').length,
    byGroup: Object.fromEntries(Object.keys(GROUP_IDS).map((g) => [g, {
      total: GROUP_IDS[g].length,
      pass: GROUP_IDS[g].filter((id) => criterionState.get(id).status === 'PASS').length,
      fail: GROUP_IDS[g].filter((id) => criterionState.get(id).status === 'FAIL').length,
      uncovered: GROUP_IDS[g].filter((id) => criterionState.get(id).status === 'UNCOVERED').length,
    }])),
    cases: { total: allCases.length, pass: allCases.filter((c) => c.status === 'PASS').length, fail: allCases.filter((c) => c.status === 'FAIL').length, error: allCases.filter((c) => c.status === 'ERROR').length, skipped: allCases.filter((c) => c.status === 'SKIPPED').length },
    generator: genCheck.ok,
  };

  const changedDuringRun = (() => {
    const now = snapshotCode();
    return Object.keys(now).filter((k) => !codeSnapshot[k] || now[k].sha256 !== (codeSnapshot[k] && codeSnapshot[k].sha256));
  })();
  const payload = {
    schema: 'v0.5-acceptance/1',
    changedDuringRun,
    startedAt, finishedAt: new Date().toISOString(),
    target: PLUGIN,
    node: process.version,
    freeMemBeforeMB: freeBefore,
    resourceNote: '本机 7.7GB / 可用 <1.5GB：按 Lead 纪律串行跑三个测试文件，36MB 会话为自合成（流式写盘），未使用真实 38MB 素材。',
    codeSnapshot,
    suites: Object.fromEntries(Object.entries(suiteRuns).map(([k, v]) => [k, { skipped: v.skipped, reason: v.reason || '', exit: v.exit, durationMs: v.durationMs, summary: v.data ? v.data.summary : null }])),
    generator: genCheck,
    summary,
    criteria: Object.fromEntries([...criterionState.entries()].map(([k, v]) => [k, v])),
    cases: allCases,
  };
  // 本机压测结果（最新一份）与异机结果状态
  let localStress = null;
  const stressDir = path.join(DOCS, '压测结果');
  if (fs.existsSync(stressDir)) {
    const files = fs.readdirSync(stressDir).filter((n) => /^结果-.+\.json$/.test(n)).sort();
    if (files.length) { try { localStress = JSON.parse(fs.readFileSync(path.join(stressDir, files[files.length - 1]), 'utf8')); localStress.file = files[files.length - 1]; } catch { /* ignore */ } }
  }
  const remoteFiles = fs.existsSync(stressDir) ? fs.readdirSync(stressDir).filter((n) => /^异机结果合并-.+\.json$/.test(n)) : [];
  payload.localStress = localStress ? { file: localStress.file, hostname: localStress.hostname, pass: localStress.pass, tiers: localStress.tiers && localStress.tiers.map((x) => ({ tierMB: x.tierMB, pass: x.pass, peakRssMB: x.peakRssMB })), assertions: localStress.assertions, skippedTiers: localStress.skippedTiers } : null;
  payload.remoteMerged = remoteFiles.length ? remoteFiles[remoteFiles.length - 1] : '';
  const jsonPath = path.join(args.out, '结果-v0.5.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  // ---- 生成报告 ----
  const md = renderReport(payload);
  const reportPath = path.join(DOCS, '验收报告-v0.5.md');
  fs.writeFileSync(reportPath, md, 'utf8');

  console.log(`\n===== 汇总：判据 ${summary.total} 条 → 通过 ${summary.pass} / 失败 ${summary.fail} / 未覆盖 ${summary.uncovered}`);
  for (const [g, s] of Object.entries(summary.byGroup)) console.log(`  ${g}: 通过 ${s.pass}/${s.total}，失败 ${s.fail}，未覆盖 ${s.uncovered}`);
  console.log(`  用例：${JSON.stringify(summary.cases)}；36MB 生成器自检=${genCheck.ok}`);
  console.log(`结果：${jsonPath}`);
  console.log(`报告：${reportPath}`);
  return summary.fail === 0 && summary.uncovered === 0 ? 0 : 1;
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 320);
}

function reproCommand(st) {
  const c = st.cases.find((x) => x.status === 'FAIL' || x.status === 'ERROR') || st.cases[0];
  if (!c) return '（无用例）';
  return `node P0验收/P0回归-v2.mjs${c.suite === 'P0' ? '' : ` / node docs/验收-v0.5/${c.suite === 'P1' ? '验收-P1.mjs' : '验收-REC.mjs'}`} --only=${(c.id || '').split('-').slice(0, 2).join('-')}`;
}

function renderReport(p) {
  const st = Object.values(p.criteria);
  const pass = st.filter((x) => x.status === 'PASS');
  const fail = st.filter((x) => x.status === 'FAIL');
  const uncovered = st.filter((x) => x.status === 'UNCOVERED');
  const manual = st.filter((x) => MANUAL_NOTES[x.id]);
  const L = [];
  L.push('# v0.5 独立黑盒验收报告（P0 七条 + P1 十二条 + 库外收据锚）', '');
  L.push(`> 验收组：verifier ｜ 生成：\`node docs/验收-v0.5/验收-v0.5.mjs\`（数字不手写）`);
  L.push(`> 被测目录：\`${p.target}\` ｜ 代码快照时间：${p.finishedAt}`);
  L.push(`> 判据依据：\`<test-dir>\\work\\v0.5\\01-v0.5-范围重定-审计驱动.md\` §四（P0 七条 / P1 十二条 / REC 七条 = 26 条）`);
  L.push('');
  L.push('## 0. 结论（先看这段）', '');
  L.push(`- **红/绿分布：判据 ${p.summary.total} 条 → 通过 ${p.summary.pass} / 失败 ${p.summary.fail} / 未覆盖 ${p.summary.uncovered}；用例 ${p.summary.cases.total} 个（PASS ${p.summary.cases.pass} / FAIL ${p.summary.cases.fail} / ERROR ${p.summary.cases.error} / SKIPPED ${p.summary.cases.skipped}）。**`);
  const g = p.summary.byGroup;
  L.push(`- 分组：P0 通过 ${g.P0.pass}/${g.P0.total}（失败 ${g.P0.fail}、未覆盖 ${g.P0.uncovered}）；P1 通过 ${g.P1.pass}/${g.P1.total}（失败 ${g.P1.fail}、未覆盖 ${g.P1.uncovered}）；REC 通过 ${g.REC.pass}/${g.REC.total}。`);
  L.push(`- 36MB 合成会话生成器自检：${p.generator.ok ? '通过 ✅' : '未通过 ❌'} —— ${esc(p.generator.evidence)}`);
  L.push('');
  L.push('> **诚实声明**：v0.5 的 P0/P1 修复尚在进行中，**本报告不把"脚本红了"当作实现失败结论**，只把它当作"当下代码快照上该判据尚未被证明成立"的证据；红/绿只对本次快照负责（快照 SHA256 见 §5）。');
  if (p.changedDuringRun && p.changedDuringRun.length) L.push(`> ⚠️ **验收期间被测代码发生变化**（结论可能过期，建议重跑）：${p.changedDuringRun.join('、')}`);
  L.push(`> 内存与执行纪律依据：\`<test-dir>\\work\\v0.5\\02-内存与验收执行纪律.md\`（含改前/改后、回滚方式、执行纪律）。`);
  L.push('');
  L.push('## 1. 通过（判据 + 证据要点）', '');
  L.push('| 判据 | 分组 | 覆盖用例 | 证据要点 |');
  L.push('| --- | --- | --- | --- |');
  for (const x of pass) {
    L.push(`| ${x.id} | ${x.group} | ${x.cases.filter((c) => c.status === 'PASS').map((c) => c.id).join('；')} | ${esc((x.cases.find((c) => c.status === 'PASS') || {}).evidence)} |`);
  }
  if (!pass.length) L.push('| （无） | — | — | — |');
  L.push('');
  L.push('## 2. 失败（判据 + 可复现命令 + 最小证据）', '');
  L.push('| 判据 | 覆盖用例 | 可复现命令 | 最小证据 |');
  L.push('| --- | --- | --- | --- |');
  for (const x of fail) {
    const bad = x.cases.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
    L.push(`| ${x.id} | ${bad.map((c) => `${c.id}(${c.status})`).join('；')} | \`${reproCommand(x)}\` | ${esc(bad.map((c) => c.evidence).join(' ／ '))} |`);
  }
  if (!fail.length) L.push('| （无） | — | — | — |');
  L.push('');
  L.push('## 3. 人工待验（黑盒不可直接判定，需人工/白盒确认）', '');
  L.push('| 判据 | 为什么不能自动判 | 已有代理证据 |');
  L.push('| --- | --- | --- |');
  for (const x of manual) {
    const ev = x.cases.filter((c) => c.status === 'PASS').map((c) => c.evidence).join('；') || '（本轮该判据失败/未覆盖，见对应表）';
    L.push(`| ${x.id} | ${esc(MANUAL_NOTES[x.id])} | ${esc(ev)} |`);
  }
  if (!manual.length) L.push('| （无） | — | — |');
  L.push('');
  L.push('## 4. 未覆盖（**必须写原因**，这是审计批评的重点）', '');
  L.push('| 判据 | 未覆盖原因 | 备注 |');
  L.push('| --- | --- | --- |');
  for (const x of uncovered) L.push(`| ${x.id} | ${esc(x.reason)} | ${x.cases.length ? '用例被跳过' : '本轮无测试用例'} |`);
  if (!uncovered.length) L.push('| （无） | — | — |');
  L.push('');
  L.push('## 5. 本次验收的代码快照（SHA256）', '');
  L.push('| 文件 | SHA256 | 字节 |');
  L.push('| --- | --- | ---: |');
  for (const [rel, h] of Object.entries(p.codeSnapshot)) L.push(`| \`${rel}\` | \`${h}\` | — |`);
  L.push('');
  L.push('## 6. 资源纪律与复现', '');
  L.push(`- 可用内存（开跑前）：${p.freeMemBeforeMB} MB；纪律：一次只跑一个测试文件、<${MIN_FREE_MB}MB 只写不跑、36MB 用自合成会话（不碰真实 38MB 素材）、不读写 U 盘、不碰桌面冻结包、不运行 git。`);
  L.push(`- 生成器：\`node docs/验收-v0.5/生成大会话.mjs --out=<临时路径>\`（流式多帧写盘；本次 ${p.generator.ok ? '通过' : '未通过'}）。`);
  L.push('- 复现：');
  L.push('```');
  L.push('node P0验收/P0回归-v2.mjs --out=docs/验收-v0.5/_results/P0.json');
  L.push('node docs/验收-v0.5/验收-P1.mjs --out=docs/验收-v0.5/_results/P1.json');
  L.push('node docs/验收-v0.5/验收-REC.mjs --out=docs/验收-v0.5/_results/REC.json');
  L.push('node docs/验收-v0.5/验收-v0.5.mjs        # 串行跑三套 + 合并 + 生成本报告');
  L.push('```');
  L.push('');
  L.push('## 7. 压测套件与异机结果（机主决定：可搬运）', '');
  L.push('- 可搬运套件：`docs/验收-v0.5/跑压测.mjs`（单入口；四档 1/4/16/36MB；每档 RSS 峰；断言不随规模线性增长；36MB 单次完整验收）+ `README-异机运行.md`（环境/命令/产物/合并说明）；零依赖、不联网、Windows/Linux 均可。');
  if (p.localStress) {
    L.push(`- 本机压测（${p.localStress.hostname}，${p.localStress.file}）：总体 ${p.localStress.pass ? '通过 ✅' : '未通过 ❌'}；档位 ${JSON.stringify((p.localStress.tiers || []).map((x) => `${x.tierMB}MB:${x.pass ? '通过' : '失败'}(${x.peakRssMB}MB)`))}；未覆盖档位 ${JSON.stringify((p.localStress.skippedTiers || []).map((x) => (x.tierMB || x) + 'MB'))}。`);
  } else {
    L.push('- 本机压测：**未运行/无结果**（未覆盖原因：本轮未执行 `跑压测.mjs`）。');
  }
  L.push(p.remoteMerged ? `- 异机结果：已合并 → \`${path.basename(p.remoteMerged)}\`（两栏对照见该文件；异机只覆盖 P0-3，其余判据以本机为准）。` : '- 异机结果：**未覆盖** —— 异机压测尚未运行/带回（套件与合并脚本已备：`跑压测.mjs` / `合并异机结果.mjs`；机主可在另一台设备执行后带回）。');
  L.push('');
  L.push('## 8. 声明', '');
  L.push('- 未修改任何实现文件；未运行 git；未安装依赖；未读写 U 盘；桌面只写了收据锚临时子目录（REC-7）并在用后清理。');
  L.push('- 所有测试数据在 `%TEMP%\\v05-*`，跑完即清理；36MB 合成会话在 `%TEMP%\\v05-gen\\`（可重建）。');
  L.push('');
  return L.join('\n');
}

process.exitCode = main();
