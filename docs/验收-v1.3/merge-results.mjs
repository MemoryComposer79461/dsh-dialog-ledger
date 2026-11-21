/**
 * @file merge-results.mjs
 * @role 资源受限条件下的「终验合并」：把**上一轮全量结果**与**本轮定向复验结果**合并成一份最终结果。
 *
 * 背景（Lead 2026-11-09 指令）：
 *   本机 7.7GB 内存、可用 ~0.9GB；全量验收（38MB 会话 + 11 个合成实验室 + openpyxl 子进程）
 *   会把 Harness 打崩。因此终验采用「基线全量 + 定向复验」：
 *     · 基线：上一轮全量验收结果（package 冻结件，134 通过 / 2 失败 / 7 待验 / 1 不适用）；
 *     · 定向：只用 ≤1.5MB 小会话跑 `--only=e2e`，再逐个跑 `--lab=originalspecial`、`--lab=v3pair`；
 *     · 合并规则：**定向跑覆盖到的判据以定向跑为准**，其余判据沿用基线；任务级断言按 id 覆盖。
 *   这样既不重跑重实验，又能让本轮两条红项（OR-12 / OR-14）拿到冻结件上的复验证据。
 *
 * 用法：
 *   node docs/验收-v1.3/merge-results.mjs [--out=<test-dir>\work\验收终验\_results]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_IDS, acOf } from './checks-artifacts.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { out: path.join(SCRIPT_DIR, '_results') };
  for (const a of argv.slice(2)) if (a.startsWith('--out=')) out.out = path.resolve(a.slice(6));
  return out;
}

const MANUAL = {
  'HO-19': '写后复核故障注入（mock 渲染后改一字节）需白盒注入，黑盒不可达；已验「正常产物封板hash 可独立复算」HO-18',
  'OR-15': '写入后自检复核的故障注入需白盒；黑盒已验「产物正文hash 可独立复算」OR-14 与冲突不覆盖 OR-22',
  'OR-18': '渲染期「谎报负例」自检需构造内部非法输入，黑盒不可达；相关产物形态按 OR-17 判',
  'OR-20': 'open("wx") 排他创建机制不可黑盒观测；代理证据：目标不存在→文件创建成功；已存在时同 hash 复用（OR-21）/异 hash 冲突停摆（OR-22）',
  'GL-12': 'git 基线对比；本轮硬约束不运行 git，无法机器判定（需 Lead/交付负责人用基线清单复核）',
  'GL-16': '桌面交付包目录 sha256 基线清单；本验收未写桌面目录，但无基线清单可对比',
  'GL-09': 'state「tmp+rename 原子写」机制不可黑盒观测；已验代理指标（可解析/键只增不减/无 tmp 残留/无损坏）',
};
const NA = ['OR-16', ...Array.from({ length: 28 }, (_, i) => `CL-${String(i + 1).padStart(2, '0')}`), 'CL-31', 'CL-32'];
const NA_REASON = (id) => (id === 'OR-16'
  ? 'v1.3 允许「未启用采集」降级（决定 3：真实采集排 v0.5），启用形态本期不判'
  : 'Lead 书面裁定 N1=B：清册功能排 v0.5，v1.3 只冻结模板与判据');

function aggregate(checks) {
  const byCrit = new Map();
  for (const r of checks) {
    for (const c of r.criteria || []) {
      if (!byCrit.has(c)) byCrit.set(c, []);
      byCrit.get(c).push(r);
    }
  }
  const statusOf = new Map();
  for (const id of ALL_IDS) {
    const list = byCrit.get(id) || [];
    let status;
    if (list.some((x) => x.status === 'FAIL')) status = 'FAIL';
    else if (list.some((x) => x.status === 'PASS')) status = 'PASS';
    else if (list.some((x) => x.status === 'MANUAL')) status = 'MANUAL';
    else if (list.some((x) => x.status === 'NA')) status = 'NA';
    else status = 'MISS';
    statusOf.set(id, {
      id, ac: acOf(id), status,
      evidence: list.map((x) => `[${x.status === 'PASS' ? '通过' : x.status === 'FAIL' ? '失败' : x.status === 'MANUAL' ? '待验' : '不适用'}] ${x.evidence}`),
    });
  }
  return statusOf;
}

function acTable(statusOf) {
  const acRange = (prefix, n) => Array.from({ length: n }, (_, i) => `AC-${prefix}-${String(i + 1).padStart(2, '0')}`);
  const AC_LIST = [
    ...acRange('HO', 13), ...acRange('HA', 9), ...acRange('OR', 12), ...acRange('CL', 18),
    ...acRange('WK', 19), ...acRange('GL', 12),
  ];
  const byAc = new Map(AC_LIST.map((ac) => [ac, []]));
  for (const [, v] of statusOf.entries()) {
    const ac = v.ac || '';
    if (byAc.has(ac)) byAc.get(ac).push(v);
  }
  const lines = ['# AC-V13-* 对照表（83 个验收用例；终验合并结果）', '',
    '> 状态取值：通过 / 失败 / 人工待验 / 不适用（未纳入本期判据集）。一个 AC 名下任一判据失败 → 该 AC 失败。',
    '> 数据来源：上一轮全量验收（134/2/7/1）+ 终验定向复验（e2e / originalspecial / v3pair，冻结件）。', ''];
  const titles = [['一、通过（AC）', 'PASS'], ['二、失败（AC）', 'FAIL'], ['三、人工待验（AC）', 'MANUAL'], ['四、不适用（AC）', 'NA']];
  for (const [title, st] of titles) {
    lines.push(`## ${title}`, '');
    const list = AC_LIST.map((ac) => ({ ac, crits: byAc.get(ac) })).filter((x) => {
      const s = x.crits.some((c) => c.status === 'FAIL') ? 'FAIL'
        : x.crits.some((c) => c.status === 'MANUAL') ? 'MANUAL'
          : x.crits.some((c) => c.status === 'PASS') ? 'PASS'
            : x.crits.some((c) => c.status === 'NA') ? 'NA' : 'NA';
      return s === st;
    });
    if (!list.length) { lines.push('（无）', ''); continue; }
    lines.push('| AC 编号 | 名下判据（状态） | 证据摘要（独立复算点） |');
    lines.push('| --- | --- | --- |');
    for (const x of list) {
      const crit = x.crits.map((c) => `${c.id}(${c.status === 'PASS' ? '通过' : c.status === 'FAIL' ? '失败' : c.status === 'MANUAL' ? '待验' : 'NA'})`).join('、') || '—';
      const tag = st === 'PASS' ? '[通过]' : st === 'FAIL' ? '[失败]' : st === 'MANUAL' ? '[待验]' : '[不适用]';
      const pick = x.crits.find((c2) => c2.status === st) || x.crits[0];
      let evList = pick ? pick.evidence.filter((e) => e.startsWith(tag)) : [];
      // 让关键复验证据排前面（审计一眼看到"真算/占位"的数值，而不是不触发的旁证）
      const prefer = x.ac === 'AC-OR-06' ? '独立复算=2'
        : x.ac === 'AC-OR-11' ? '非文本块占位：[图片]=true'
          : x.ac === 'AC-OR-07' ? '== YAML 正文hash' : null;
      if (prefer) evList = [...evList.filter((e) => e.includes(prefer)), ...evList.filter((e) => !e.includes(prefer))];
      let ev = evList.length ? evList[0] : (pick && pick.evidence.length ? pick.evidence[pick.evidence.length - 1] : '');
      if (st === 'NA') ev = NA_REASON('CL-01');
      ev = String(ev).replace(/\|/g, '\\|').slice(0, 320);
      lines.push(`| ${x.ac} | ${crit} | ${ev} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  const OUT = args.out;
  const BASE = path.join(OUT, '上一轮全量-134-2-7-1.json');
  const TARGET_RUNS = [
    ['e2e', path.join(OUT, '复验-e2e', '结果.json')],
    ['originalspecial', path.join(OUT, '复验-originalspecial', '结果.json')],
    ['v3pair', path.join(OUT, '复验-v3pair', '结果.json')],
    ['conflict', path.join(OUT, '复验-conflict', '结果.json')],
    ['crverbatim', path.join(OUT, '复验-crverbatim', '结果.json')],
  ];
  const baseline = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const targeted = TARGET_RUNS.map(([name, p]) => ({ name, p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }));

  const covered = new Set();
  for (const t of targeted) {
    for (const c of t.data.checks || []) for (const cr of c.criteria || []) covered.add(cr);
  }
  const baselineKept = (baseline.checks || []).filter((c) => !(c.criteria || []).some((cr) => covered.has(cr)));
  const mergedChecks = [...baselineKept];
  const seen = new Set(mergedChecks.map((c) => JSON.stringify([c.id, c.criteria, c.evidence])));
  for (const t of targeted) {
    for (const c of t.data.checks || []) {
      const key = JSON.stringify([c.id, c.criteria, c.evidence]);
      if (seen.has(key)) continue;
      seen.add(key);
      mergedChecks.push(c);
    }
  }
  // 任务级断言：按 id 覆盖（定向跑为准）
  const taskMap = new Map();
  for (const t of baseline.tasks || []) taskMap.set(t.id, t);
  for (const t of targeted) for (const x of t.data.tasks || []) taskMap.set(x.id, x);
  const tasks = [...taskMap.values()];

  const statusOf = aggregate(mergedChecks);
  for (const [id, why] of Object.entries(MANUAL)) {
    if (statusOf.get(id) && ['MISS', 'PASS'].includes(statusOf.get(id).status)) {
      statusOf.get(id).status = 'MANUAL';
      statusOf.get(id).evidence.push(`[待验] ${why}`);
    }
  }
  for (const id of NA) {
    if (statusOf.get(id)) {
      if (statusOf.get(id).status === 'MISS') statusOf.get(id).status = 'NA';
      statusOf.get(id).evidence.push('[不适用] ' + NA_REASON(id));
    }
  }
  const fail = [...statusOf.values()].filter((x) => x.status === 'FAIL').map((x) => x.id);
  const pass = [...statusOf.values()].filter((x) => x.status === 'PASS').map((x) => x.id);
  const manual = [...statusOf.values()].filter((x) => x.status === 'MANUAL').map((x) => x.id);
  const na = [...statusOf.values()].filter((x) => x.status === 'NA').map((x) => x.id);
  const miss = [...statusOf.values()].filter((x) => x.status === 'MISS').map((x) => x.id);
  if (miss.length) throw new Error('合并后仍有未覆盖判据：' + miss.join(', '));

  // 冻结件清单：取最后一次定向跑的 target 快照（其开跑前对 package 全量哈希）
  const lastMeta = targeted[targeted.length - 1].data.meta;
  const baselineOnly = ALL_IDS.filter((id) => !covered.has(id));
  const merged = {
    meta: {
      target: lastMeta.target,
      frozenAt: lastMeta.frozenAt,
      mergedAt: new Date().toISOString(),
      nodeVersion: lastMeta.nodeVersion,
      python: lastMeta.python,
      codeHashes: lastMeta.codeHashes,
      packageJsonHash: lastMeta.packageJsonHash,
      resourceNote: '本机可用内存约 0.9GB：全量验收（38MB 会话 + 11 个合成实验室 + openpyxl 子进程）不可跑；终验改为「上一轮全量基线 + 3 个定向复验（≤1.5MB 小会话素材）」合并。',
      baseline: {
        path: BASE,
        summary: baseline.summary,
        runTarget: baseline.meta.target,
        runStartedAt: baseline.meta.startedAt,
        runFinishedAt: baseline.meta.finishedAt,
      },
      targetedRuns: targeted.map((t) => ({
        name: t.name, path: t.p, startedAt: t.data.meta.startedAt, finishedAt: t.data.meta.finishedAt,
        summary: t.data.summary,
      })),
      coverage: {
        total: ALL_IDS.length,
        targetedVerified: [...covered].sort(),
        baselineOnly,
      },
    },
    summary: { pass: pass.length, fail: fail.length, manual: manual.length, na: na.length, miss: miss.length, failIds: fail, manualIds: manual, naIds: na, missIds: miss },
    criteria: Object.fromEntries([...statusOf.entries()].map(([k, v]) => [k, { ac: v.ac, status: v.status, evidence: v.evidence, verification: covered.has(k) ? 'targeted' : 'baseline' }])),
    checks: mergedChecks,
    tasks,
  };
  const outJson = path.join(OUT, '结果.json');
  fs.writeFileSync(outJson, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  const ac = acTable(statusOf);
  fs.writeFileSync(path.join(OUT, 'AC对照表.md'), ac, 'utf8');
  fs.writeFileSync(path.join(path.dirname(OUT), 'AC对照表.md'), ac, 'utf8');
  console.log('合并完成 →', outJson);
  console.log(`统计：通过 ${pass.length} / 失败 ${fail.length} / 人工待验 ${manual.length} / 不适用 ${na.length} / 未覆盖 ${miss.length}（共 ${ALL_IDS.length}）`);
  console.log('失败：' + (fail.join('、') || '（无）'));
  console.log('定向复验覆盖判据数：' + covered.size + '；基线沿用：' + baselineOnly.length);
  console.log('任务级断言：' + tasks.filter((t) => t.ok).length + ' 通过 / ' + tasks.filter((t) => !t.ok).length + ' 失败');
}

main();
