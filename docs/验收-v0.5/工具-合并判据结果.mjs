/**
 * @file 工具-合并判据结果.mjs
 * @role 把各验收套件的机器可读结果如实合并成 `_results/总览.json`（发布页 / `07-发布页` 的数字只从脚本出，不手写）。
 *
 * 输入（存在才读，缺文件记 `missing`、坏 JSON 记 `invalid`）：
 *   `_results/P0.json`  — P0 回归-v2
 *   `_results/P1.json`  — P1 十二条
 *   `_results/INV.json` — INV-01…INV-30
 *   `_results/CH.json`  — CH-01…CH-24
 *   `_results/REC.json` — REC-01…REC-10
 *
 * 输出：`_results/总览.json`
 *   { v, generatedAt, offsetMinutes, resultsDir,
 *     suites:[{suite,file,state:'ok'|'missing'|'invalid',module?,cases,pass,fail,error,skip,reason?}],
 *     totals:{declaredSuites,present,missing[],invalid[],cases,pass,fail,error,skip},
 *     note }
 *
 * 纪律：
 *   · **只做如实汇总**——不生成任何结论性措辞（不写"通过/全绿/健康"这类判断）；
 *   · 缺失/损坏必须显式可见（missing / invalid + reason），绝不静默当 0；
 *   · 不读也不改任何套件源文件，只读 `_results/*.json` 并写一个 `_results/总览.json`。
 *
 * 用法：
 *   node docs/验收-v0.5/工具-合并判据结果.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, '_results');
const OUT_FILE = path.join(RESULTS_DIR, '总览.json');
const SUITE_NAMES = ['P0', 'P1', 'INV', 'CH', 'REC'];
const OFFSET_MINUTES = 480;

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时间文本：`YYYY-MM-DD HH:MM:SS`（+08:00 口径、无 Z）。 */
function localStamp(ms) {
  const d = new Date(ms + OFFSET_MINUTES * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 取非负整数；非法值如实回落 0（但 cases 缺失时用 results.length 兜底）。 */
function intOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function readSuite(name) {
  const file = `${name}.json`;
  const abs = path.join(RESULTS_DIR, file);
  if (!fs.existsSync(abs)) {
    return { suite: name, file, state: 'missing' };
  }
  let raw = '';
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) {
    return { suite: name, file, state: 'invalid', reason: 'read failed: ' + String((e && e.message) || e) };
  }
  let obj = null;
  try { obj = JSON.parse(raw); } catch (e) {
    return { suite: name, file, state: 'invalid', reason: 'JSON parse failed: ' + String((e && e.message) || e) };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { suite: name, file, state: 'invalid', reason: 'not a JSON object' };
  }
  const summary = obj.summary && typeof obj.summary === 'object' ? obj.summary : {};
  const results = Array.isArray(obj.results) ? obj.results : [];
  const cases = intOf(summary.cases) || results.length;
  return {
    suite: name,
    file,
    state: 'ok',
    module: typeof obj.module === 'string' ? obj.module : '',
    cases,
    pass: intOf(summary.pass),
    fail: intOf(summary.fail),
    error: intOf(summary.error),
    skip: intOf(summary.skipped),
  };
}

const suites = SUITE_NAMES.map(readSuite);
const present = suites.filter((s) => s.state === 'ok');
const totals = { cases: 0, pass: 0, fail: 0, error: 0, skip: 0 };
for (const s of present) {
  for (const k of Object.keys(totals)) totals[k] += intOf(s[k]);
}
const overview = {
  v: 1,
  generatedAt: localStamp(Date.now()),
  offsetMinutes: OFFSET_MINUTES,
  resultsDir: RESULTS_DIR,
  declaredSuites: SUITE_NAMES,
  suites,
  totals: {
    declaredSuites: SUITE_NAMES.length,
    present: present.length,
    missing: suites.filter((s) => s.state === 'missing').map((s) => s.suite),
    invalid: suites.filter((s) => s.state === 'invalid').map((s) => s.suite),
    cases: totals.cases,
    pass: totals.pass,
    fail: totals.fail,
    error: totals.error,
    skip: totals.skip,
  },
  note: '如实汇总：只复制各套件 summary 的计数并求和；缺失记 missing、损坏记 invalid；本文件不产出任何结论性措辞。',
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(overview, null, 2) + '\n', 'utf8');

// 人读输出：每套件一行 + 合计（状态词用 ASCII，避免结论性措辞）
for (const s of suites) {
  if (s.state === 'ok') {
    console.log(`${s.suite}\t${s.state}\tcases=${s.cases}\tpass=${s.pass}\tfail=${s.fail}\terror=${s.error}\tskip=${s.skip}`);
  } else {
    console.log(`${s.suite}\t${s.state}${s.reason ? '\t' + s.reason : ''}`);
  }
}
console.log(`TOTAL\tcases=${overview.totals.cases}\tpass=${overview.totals.pass}\tfail=${overview.totals.fail}\terror=${overview.totals.error}\tskip=${overview.totals.skip}\tmissing=${JSON.stringify(overview.totals.missing)}\tinvalid=${JSON.stringify(overview.totals.invalid)}`);
console.log(`WROTE\t${OUT_FILE}`);
