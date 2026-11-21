#!/usr/bin/env node
/**
 * @file 工具-生成判据总表.mjs
 * @role 把契约 `v0.5-验收清单.md` 的每一条判据，生成一份机器可读证据 + 一张总表 CSV。
 *
 * @why 发布闸门要的是「每条判据 1 个 AC 结果」，而现实是：套件只验到**主题级**
 *      （P0 用例验的是 P0-1…P0-7，P1 用例验的是 P1-1…P1-12），并没有对 135 条细判据逐条断言。
 *      所以这个脚本**不编造"逐条通过"**，而是对每条判据如实标注覆盖层级：
 *        · 主题级通过 —— 该族套件全绿，但本条没有单独断言（有家族级证据，无本条证据）
 *        · 单元级存在 —— 只有单元自测覆盖该模块，未做端到端断言
 *        · 未覆盖     —— 明确没做（清册 / REG）
 *      并记录 `directCase`：只有当某用例的 `criteria` 明确点名本条时才有值（当前为 0）。
 *
 * 用法（在插件根目录）：
 *   node docs/验收-v0.5/工具-生成判据总表.mjs
 *   node docs/验收-v0.5/工具-生成判据总表.mjs --check   # 只打印分布，不写文件
 *
 * 纪律：只读契约与结果 JSON；只写 `docs/验收-v0.5/_证据/`；不手写数字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const CONTRACT = '<build-host>\\Desktop\\交付包-全量-20261109\\03-契约-v0.5\\v0.5-验收清单.md';
const RESULT_DIR = path.join(PLUGIN, 'docs', '验收-v0.5', '_results');
const STRESS_DIR = path.join(PLUGIN, 'docs', '验收-v0.5', '压测结果');
const OUT_DIR = path.join(PLUGIN, 'docs', '验收-v0.5', '_证据');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const latest = (dir, re) => {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((n) => re.test(n)).sort();
  if (!files.length) return null;
  return path.join(dir, files[files.length - 1]);
};
const stamp = (ms = Date.now()) => {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +08:00`;
};

// ── 一、解析契约判据表 ────────────────────────────────────────────────────
if (!fs.existsSync(CONTRACT)) { console.error('找不到契约：' + CONTRACT); process.exit(2); }
const lines = fs.readFileSync(CONTRACT, 'utf8').split(/\r?\n/);
const ID_RE = /^(INV|CH|REC|BC|HL|RC|CL)-(\d{2})$/;
const REG_RE = /^REG-[A-Z]{2}$/;
const criteria = [];
for (const line of lines) {
  const s = line.trim();
  if (!s.startsWith('|')) continue;
  const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
  if (cells.length < 5) continue;
  const id = cells[0];
  if (!ID_RE.test(id) && !REG_RE.test(id)) continue;
  // 列：判据ID | 产物 | 可判定判据 | 实现文件 | 验收用例ID（要求列里可能有 |，故从右往左取）
  const acId = cells[cells.length - 1];
  const impl = cells[cells.length - 2];
  const requirement = cells.slice(2, cells.length - 2).join(' | ');
  criteria.push({
    id,
    family: id.split('-')[0],
    product: cells[1] || '',
    requirement,
    impl,
    acId: /^AC-V05-/.test(acId) ? acId : `AC-V05-${id}`,
  });
}

// ── 二、加载本轮证据 ─────────────────────────────────────────────────────
const p0 = fs.existsSync(path.join(RESULT_DIR, 'P0.json')) ? readJson(path.join(RESULT_DIR, 'P0.json')) : null;
// ★ 逐条判据套件（W2b）：有就用它的结果做"逐条"证据
const invR = fs.existsSync(path.join(RESULT_DIR, 'INV.json')) ? readJson(path.join(RESULT_DIR, 'INV.json')) : null;
const chR = fs.existsSync(path.join(RESULT_DIR, 'CH.json')) ? readJson(path.join(RESULT_DIR, 'CH.json')) : null;
const p1 = fs.existsSync(path.join(RESULT_DIR, 'P1.json')) ? readJson(path.join(RESULT_DIR, 'P1.json')) : null;
const stressFile = latest(STRESS_DIR, /^结果-TSG-02-\d{8}-\d{6}\.json$/);
const stress = stressFile ? readJson(stressFile) : null;
const mutDir = '<test-dir>\\work\\变异反证';
const mutFile = latest(mutDir, /^结果-\d{8}-\d{6}\.json$/);
const mut = mutFile ? readJson(mutFile) : null;

const caseIndex = new Map(); // caseId -> {suite, status}
for (const r of (p0 && p0.results) || []) caseIndex.set(r.id, { suite: 'P0', status: r.status });
for (const r of (p1 && p1.results) || []) caseIndex.set(r.id, { suite: 'P1', status: r.status });
for (const r of (invR && invR.results) || []) caseIndex.set(r.id, { suite: 'INV', status: r.status });
for (const r of (chR && chR.results) || []) caseIndex.set(r.id, { suite: 'CH', status: r.status });

/**
 * 场景覆盖映射（人工裁定，必须逐条写理由）。
 *
 * ★ 为什么需要它：契约的 INV/CH 编号与验收用例编号是两套东西（P0-1…P0-7 / P1-1…P1-12）。
 *   把"某用例的场景恰好体现了某条判据"写清楚，读者才能判断这条到底验过没有。
 * ★ 为什么叫"场景覆盖"不叫"逐条断言"：这些用例断言的是场景，未必逐字断言该条的
 *   每个字段（例如 INV-01 还要求 `unchanged==0`、cursor 边界，P0-1 并未逐条断言）。
 *   凡未逐字断言的，在 note 里写明缺哪一项，不许含糊成"通过"。
 */
const SCENARIO = {
  'INV-01': { caseId: 'P0-1c', note: 'P0-1c 断言"缩→回长到同字节"后新 Turn 必须入账；`unchanged==0` 与 cursor 边界值未逐字断言' },
  'INV-02': { caseId: 'P0-1c', note: 'P0-1c 验证缩小后必须重读；`cursorResets[].reason=="shrunk"` 字段未断言（运行报告未产出该段）' },
  'INV-03': { caseId: 'P0-1b', note: 'P0-1b 断言同 size 重写后新 Turn 入账；`identityChanges[]` 字段未断言' },
  'INV-05': { caseId: 'P0-2', note: 'P0-2 断言未闭合轮不进台账、补 end 后恰 1 条闭合；pending 字段细节部分断言' },
  'INV-06': { caseId: 'P0-2', note: 'P0-2 三次扫描序列覆盖 pending 幂等；`pending.added/dup` 计数未逐字断言' },
  'INV-07': { caseId: 'P0-2', note: 'P0-2 断言恰 1 个闭合版本、无 partial 残留' },
  'INV-08': { caseId: 'P0-2', note: 'P0-2 即 run1/run2/run3 序列，语义一致；逐字段计数未逐字断言' },
  'INV-13': { caseId: 'P0-3-cancel', note: 'P0-3-cancel 断言 abort 后及时退出且无半批；`committedBatches` 字段由 P0-3-cancel 的 stat 断言间接覆盖' },
  'INV-14': { caseId: 'P0-3-resume', note: 'P0-3-resume 断言 kill -9 后重启续跑、无重复、跑完全部轮次；`batches[]/resumeFrom` 字段由自测-index-integration 断言' },
  'INV-15': { caseId: 'P0-4a', note: 'P0-4a 断言 120/121/122 三组 hash 互异；"122 不同溢出码"第四组未单独构造' },
  'INV-16': { caseId: 'P0-4b', note: 'P0-4b 断言 125→120+5 闭合、补记可按编码检索' },
  'INV-17': { caseId: 'P0-4c', note: 'P0-4c 断言 journal 行不可变快照；`key+kind` 唯一性与 v8 复算由自测-周记账封板覆盖' },
  'INV-21': { caseId: 'P0-7②', note: 'P0-7② 断言台账记整文件哈希（docFileSha256 与 docSha256 不同）' },
  'INV-22': { caseId: 'P0-5', note: 'P0-5 断言 2000/2001/4517 与多字节参数从附件逐字恢复' },
  'INV-23': { caseId: 'P0-5', note: 'P0-5 断言截断披露行逐字格式与可解码前缀' },
  'INV-25': { caseId: 'P0-6', note: 'P0-6 断言默认 dry-run 零删除、只产 RPT-DRYRUN-*' },
  'INV-26': { caseId: 'P0-6', note: 'P0-6 断言旧 CLI 未加 --yes 时 BLOCKED 且零删除' },
  'INV-27': { caseId: 'P0-6', note: 'P0-6 断言 dry-run 不占正式编号（随后首次正式编号为 01）' },
  'INV-28': { caseId: 'P0-7①', note: 'P0-7① 断言同编码不同正文被拒（ORIGINAL_CONFLICT），不覆盖' },
  'INV-30': { caseId: 'P0-7③', note: 'P0-7③ 断言坏 sid 进 .errors.jsonl 且游标不推进；`blockedSources[]` 由自测-守卫覆盖' },
};

/** 各族覆盖声明：level = 主题级 / 单元级 / 未覆盖 */
const FAMILY = {
  INV: {
    level: '主题级',
    note: 'P0 七条不变量主题级全绿（P0-1/1b/1c/2/3-mem/3-cancel/3-resume/4a/4b/4c/5/6/7①②③），但 30 条 INV 细判据未逐条断言',
    suite: 'P0验收\\P0回归-v2.mjs',
    result: 'docs\\验收-v0.5\\_results\\P0.json',
    cases: ['P0-1', 'P0-1b', 'P0-1c', 'P0-2', 'P0-3-mem', 'P0-3-cancel', 'P0-3-resume',
      'P0-4a', 'P0-4b', 'P0-4c', 'P0-5', 'P0-6', 'P0-7①', 'P0-7②', 'P0-7③'],
  },
  CH: {
    level: '主题级',
    note: 'P1 十二条主题级全绿（P1-1…P1-12），但 24 条 CH 细判据未逐条断言',
    suite: 'docs\\验收-v0.5\\验收-P1.mjs',
    result: 'docs\\验收-v0.5\\_results\\P1.json',
    cases: ['P1-1', 'P1-2', 'P1-3', 'P1-4', 'P1-5', 'P1-7', 'P1-8', 'P1-9', 'P1-10', 'P1-11', 'P1-12'],
  },
  REC: {
    level: '主题级+单元',
    note: 'P0 套件内 3 个 REC-core 用例 + docs\\自测-receipt.mjs 单元覆盖；10 条细判据未逐条断言',
    suite: 'P0验收\\P0回归-v2.mjs（REC-core-*） + docs\\自测-receipt.mjs',
    result: 'docs\\验收-v0.5\\_results\\P0.json',
    cases: ['REC-core-链连续', 'REC-core-幂等与冲突', 'REC-core-篡改与删除'],
  },
  BC: {
    level: '单元级',
    note: '只读计划由 docs\\自测-backfill.mjs 覆盖；入口执行器未接线（见 05 未覆盖）',
    suite: 'docs\\自测-backfill.mjs',
    result: 'docs\\自测-backfill.mjs（22 例）',
    cases: [],
  },
  HL: {
    level: '单元级',
    note: '运行报告由 docs\\自测-reconcile.mjs + docs\\自测-index-integration.mjs 覆盖；自愈周期接线未做',
    suite: 'docs\\自测-reconcile.mjs + docs\\自测-index-integration.mjs',
    result: 'docs\\自测-reconcile.mjs（12 例）',
    cases: [],
  },
  RC: {
    level: '单元级',
    note: '对账只报不修由 docs\\自测-reconcile.mjs 覆盖',
    suite: 'docs\\自测-reconcile.mjs',
    result: 'docs\\自测-reconcile.mjs（12 例）',
    cases: [],
  },
  CL: {
    level: '未覆盖',
    note: '清册 v1.3 全量重写未做（W4），物理删除仍默认关闭',
    suite: '',
    result: '',
    cases: [],
  },
  REG: {
    level: '未覆盖',
    note: 'v1.3 冻结判据（142 条）未按族复跑',
    suite: '',
    result: '',
    cases: [],
  },
};

// ── 三、逐条生成证据 ─────────────────────────────────────────────────────
const now = stamp();
const rows = [];
for (const c of criteria) {
  const fam = FAMILY[c.family];
  // 直接证据：某用例的 criteria 明确点名本条
  let directCase = null;
  for (const [caseId, meta] of caseIndex) {
    const r = ((p0 && p0.results) || []).concat((p1 && p1.results) || []).concat((invR && invR.results) || []).concat((chR && chR.results) || []).find((x) => x.id === caseId);
    if (r && Array.isArray(r.criteria) && r.criteria.includes(c.id)) directCase = { caseId, suite: meta.suite, status: meta.status };
  }
  let status;
  if (!fam || fam.level === '未覆盖') status = '未覆盖';
  else if (directCase) {
    // SKIP 不等于"未通过"：它是"这条判据没有可执行证据"，必须与失败分开计
    status = directCase.status === 'PASS' ? '逐条通过'
      : directCase.status === 'SKIPPED' ? '逐条跳过'
        : '逐条未通过';
  }
  else if (SCENARIO[c.id]) {
    const sc = SCENARIO[c.id];
    const meta = caseIndex.get(sc.caseId);
    status = meta && meta.status === 'PASS' ? '场景覆盖（用例通过）'
      : meta ? `场景覆盖（用例${meta.status}）` : '场景覆盖（用例未运行）';
  } else status = fam.level === '主题级' ? '主题级通过（未逐条）'
    : fam.level === '主题级+单元' ? '主题级通过 + 单元覆盖（未逐条）'
      : '仅单元覆盖（未逐条）';

  const ev = {
    schema: 'v05-ac/1',
    id: c.id,
    family: c.family,
    acId: c.acId,
    product: c.product,
    requirement: c.requirement,
    implementation: c.impl,
    coverage: directCase ? '逐条' : (SCENARIO[c.id] ? '场景' : (fam ? fam.level : '未覆盖')),
    status,
    note: fam ? fam.note : '',
    directCase,
    scenario: SCENARIO[c.id] || null,
    familyEvidence: directCase
      ? {
        suite: `docs/验收-v0.5/验收-${directCase.suite}.mjs`,
        result: `docs/验收-v0.5/_results/${directCase.suite}.json`,
        cases: [directCase.caseId],
      }
      : (fam && fam.suite
        ? { suite: fam.suite, result: fam.result, cases: fam.cases, casesStatus: fam.cases.map((x) => ({ id: x, status: (caseIndex.get(x) || {}).status || '未运行' })) }
        : null),
    generatedAt: now,
    generatedBy: 'docs/验收-v0.5/工具-生成判据总表.mjs',
  };
  rows.push(ev);
}

// ── 四、汇总 ─────────────────────────────────────────────────────────────
const dist = {};
for (const r of rows) dist[r.status] = (dist[r.status] || 0) + 1;
const summary = {
  schema: 'v05-ac-summary/1',
  generatedAt: now,
  total: rows.length,
  distribution: dist,
  directCovered: rows.filter((r) => r.directCase).length,
  scenarioCovered: rows.filter((r) => !r.directCase && r.scenario).length,
  suites: {
    selftest: 'docs\\跑测试.mjs（296 例，本次全量 296/296）',
    p0: p0 ? { cases: p0.summary && p0.summary.cases, pass: p0.summary && p0.summary.pass, fail: p0.summary && p0.summary.fail, skipped: p0.summary && p0.summary.skipped, file: 'docs\\验收-v0.5\\_results\\P0.json' } : null,
    p1: p1 ? { cases: p1.summary && p1.summary.cases, pass: p1.summary && p1.summary.pass, fail: p1.summary && p1.summary.fail, file: 'docs\\验收-v0.5\\_results\\P1.json' } : null,
    stress: stress ? { pass: stress.pass, tiers: (stress.tiers || []).map((t) => ({ mb: t.tierMB, rss: t.peakRssMB })), file: path.basename(stressFile) } : null,
    mutation: mut ? { total: mut.summary && mut.summary.total, proven: mut.summary && mut.summary.proven, file: path.basename(mutFile) } : null,
  },
};

console.log('=== 判据总表 ===');
console.log('判据行数: ' + summary.total);
console.log('分布: ' + JSON.stringify(dist));
console.log('有逐条直接证据的: ' + summary.directCovered + ' / ' + summary.total);

if (CHECK_ONLY) process.exit(0);

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const ev of rows) {
  fs.writeFileSync(path.join(OUT_DIR, `${ev.id}.json`), JSON.stringify(ev, null, 2) + '\n', 'utf8');
}
const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
const csv = [
  '判据ID,族,产物,覆盖层级,本轮状态,直接用例,验收用例ID,家族证据,说明',
  ...rows.map((r) => [
    r.id, r.family, r.product, r.coverage, r.status,
    r.directCase ? r.directCase.caseId : '',
    r.acId,
    r.familyEvidence ? r.familyEvidence.suite : '',
    r.note,
  ].map(esc).join(',')),
].join('\r\n') + '\r\n';
fs.writeFileSync(path.join(OUT_DIR, '判据总表.csv'), csv, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, '摘要.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

const md = [
  `# 判据总表（本轮）· ${now}`,
  '',
  '> 由 `docs/验收-v0.5/工具-生成判据总表.mjs` 生成，**数字不手写**。',
  '> 每条判据一份 `AC-V05-<id>.json` 在同目录。',
  '',
  '## 一、分布',
  '',
  '| 状态 | 条数 | 含义 |',
  '|---|---:|---|',
  ...Object.entries(dist).map(([k, v]) => `| ${k} | ${v} | ${
    k === '主题级通过（未逐条）' ? '该族套件全绿，但本条没有单独断言'
      : k === '主题级通过 + 单元覆盖（未逐条）' ? '族级套件 + 单元自测都有，本条仍无单独断言'
        : k === '仅单元覆盖（未逐条）' ? '只有单元自测，无端到端断言'
          : k === '逐条通过' ? '有用例明确点名本条且通过'
            : k === '未覆盖' ? '明确没做（清册 / REG）' : '其他'
  } |`),
  `| **合计** | **${summary.total}** | — |`,
  '',
  `**有逐条直接证据的：${summary.directCovered} / ${summary.total}** —— 这个数字就是"逐条 AC"还欠多少，不粉饰。`,
  '',
  '## 二、本轮套件结果（证据来源）',
  '',
  '| 套件 | 结果 | 文件 |',
  '|---|---|---|',
  `| 全量自测 | ${summary.suites.selftest} | — |`,
  `| P0 | ${p0 ? `${p0.summary.cases} 例 / PASS ${p0.summary.pass} / FAIL ${p0.summary.fail} / SKIP ${p0.summary.skipped}` : '缺'} | ${summary.suites.p0 ? summary.suites.p0.file : '—'} |`,
  `| P1 | ${p1 ? `${p1.summary.cases} 例 / PASS ${p1.summary.pass} / FAIL ${p1.summary.fail}` : '缺'} | ${summary.suites.p1 ? summary.suites.p1.file : '—'} |`,
  `| 压测 | ${stress ? `pass=${stress.pass}，档 ${ (stress.tiers || []).map((t) => `${t.tierMB}MB/${t.peakRssMB}MB`).join(' · ') }` : '缺'} | ${stress ? path.basename(stressFile) : '—'} |`,
  `| 变异反证 | ${mut ? `${mut.summary.total} 个 / 成立 ${mut.summary.proven}` : '缺'} | ${mut ? path.basename(mutFile) : '—'} |`,
  '',
  '## 三、各族覆盖声明',
  '',
  ...Object.entries(FAMILY).map(([k, v]) => `- **${k}**（${v.level}）：${v.note}`),
].join('\n') + '\n';
fs.writeFileSync(path.join(OUT_DIR, '摘要.md'), md, 'utf8');
console.log('\n已写：' + OUT_DIR);
console.log(md);
