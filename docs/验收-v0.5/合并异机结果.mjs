#!/usr/bin/env node
/**
 * @file 合并异机结果.mjs
 * @role 把「另一台设备带回的压测结果」（`跑压测.mjs` 产出的 `结果-<主机名>-<时间>.json`）并入本地验收报告：
 *       输出「本机 / 异机」两栏对照表，并注明**哪一栏覆盖哪条判据**。
 *
 * 用法：
 *   node docs/验收-v0.5/合并异机结果.mjs [--remote-dir=docs/验收-v0.5/压测结果]
 *        [--remote=<file1.json>[,<file2.json>...]] [--out=docs/验收-v0.5]
 *
 * 产物：
 *   <out>/异机结果合并-<时间>.md   （人读两栏表）
 *   <out>/异机结果合并-<时间>.json （机器可读）
 *
 * 覆盖口径（写死在 `REMOTE_COVERAGE`，避免"异机结果被说成覆盖一切"）：
 *   · 异机压测覆盖 **P0-3**（1/4/16/36MB 内存曲线 + 36MB 单次完整验收 + 可取消/kill -9 由本机 P0 回归覆盖）；
 *   · 其余判据仍以本机 `结果-v0.5.json` 为准，异机栏显示「—（不覆盖）」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_CRITERIA, CRITERIA } from './_criteria.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = HERE;
const PLUGIN = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const out = { out: DOCS, remoteDir: path.join(DOCS, '压测结果'), remote: [], local: path.join(DOCS, '_results', '结果-v0.5.json') };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'out') out.out = path.resolve(m[2]);
    else if (m[1] === 'remote-dir') out.remoteDir = path.resolve(m[2]);
    else if (m[1] === 'remote') out.remote = m[2].split(',').map((s) => path.resolve(s));
    else if (m[1] === 'local') out.local = path.resolve(m[2]);
  }
  return out;
}
const args = parseArgs(process.argv);

const stamp = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; })();

const REMOTE_COVERAGE = {
  'P0-3': '异机压测：1/4/16/36MB 内存曲线（RSS 峰不随规模线性增长）+ 36MB 单次完整验收；可取消/kill -9 续跑由本机 P0 回归覆盖',
};

function loadRemotes() {
  const files = [];
  if (args.remote.length) files.push(...args.remote);
  if (fs.existsSync(args.remoteDir)) {
    for (const n of fs.readdirSync(args.remoteDir)) if (/^结果-.+\.json$/.test(n)) files.push(path.join(args.remoteDir, n));
  }
  const out = [];
  for (const f of [...new Set(files)]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || j.schema !== 'v0.5-stress/1') continue;
      out.push({ file: f, data: j });
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

function loadLocal() {
  if (!fs.existsSync(args.local)) return null;
  try { return JSON.parse(fs.readFileSync(args.local, 'utf8')); } catch { return null; }
}

const remotes = loadRemotes();
const local = loadLocal();
if (!remotes.length) {
  console.log('没有找到异机结果（schema=v0.5-stress/1）。把 `跑压测.mjs` 产出的 结果-*.json 放到 ' + args.remoteDir + ' 或 --remote= 指定。');
  process.exit(2);
}

const localStatus = new Map();
if (local && local.criteria) for (const [id, v] of Object.entries(local.criteria)) localStatus.set(id, v.status);

function remoteVerdictFor(id) {
  if (!REMOTE_COVERAGE[id]) return { covered: false, cells: remotes.map(() => '—（不覆盖）') };
  return {
    covered: true,
    cells: remotes.map((r) => {
      const d = r.data;
      const a = d.assertions || {};
      const s36 = (d.skippedTiers || []).some((x) => Number(x.tierMB || x) >= 36);
      if (id === 'P0-3') {
        if (d.pass === true) return `通过 ✅（${d.hostname}：${(d.assertions.tiersExecuted || []).join('/')}MB，RSS峰 ${JSON.stringify(d.rssPeakByTier || {})}）`;
        return `未通过 ❌（${d.hostname}：memNotLinear=${a.memNotLinear}、全档通过=${a.allExecutedTiersPass}、36MB=${s36 ? '跳过' : a.fullAccept36}）`;
      }
      return '—';
    }),
  };
}

const L = [];
L.push(`# 本机 / 异机验收结果合并（${stamp}）`, '');
L.push(`> 本机结果：\`${path.relative(PLUGIN, args.local)}\`${local ? '' : '（缺失）'} ｜ 异机结果 ${remotes.length} 份`);
L.push('');
L.push('## 0. 异机运行清单', '');
L.push('| 主机 | 平台 | Node | CPU 核 | 总内存 | 被测 version | 档位结果 | RSS 峰(MB) | 总体 |');
L.push('| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |');
for (const r of remotes) {
  const d = r.data;
  L.push(`| ${d.hostname} | ${d.platform}/${d.arch} | ${d.node} | ${d.cpuCores} | ${d.totalMemMB} | ${d.version || '?'} | ${(d.tiers || []).map((t) => `${t.tierMB}MB:${t.pass ? '通过' : '失败'}`).join('；')}${(d.skippedTiers || []).length ? '；跳过 ' + d.skippedTiers.map((x) => (x.tierMB || x) + 'MB').join('/') : ''} | ${JSON.stringify(d.rssPeakByTier || {})} | ${d.pass ? '通过 ✅' : '未通过 ❌'} |`);
}
L.push('');
L.push('## 1. 两栏对照（本机 / 异机；注明覆盖口径）', '');
L.push('| 判据 | 判据含义 | 本机结果 | 异机结果 | 覆盖说明 |');
L.push('| --- | --- | --- | --- | --- |');
for (const id of ALL_CRITERIA) {
  const lv = localStatus.get(id) || '未覆盖';
  const rv = remoteVerdictFor(id);
  const note = REMOTE_COVERAGE[id] || '异机压测不覆盖该判据；以本机验收结果为准';
  L.push(`| ${id} | ${CRITERIA[id].title.replace(/\|/g, '\\|')} | ${lv === 'PASS' ? '通过 ✅' : lv === 'FAIL' ? '失败 ❌' : lv === 'UNCOVERED' ? '未覆盖' : lv} | ${rv.cells.join('；')} | ${note.replace(/\|/g, '\\|')} |`);
}
L.push('');
L.push('## 2. 结论', '');
L.push(`- 异机覆盖判据：${Object.keys(REMOTE_COVERAGE).join('、')}；其余判据**只由本机结果覆盖**（避免"异机没跑却算通过"）。`);
L.push('- 若异机 36MB 档被内存护栏跳过，则该档仍在「未覆盖」中（原因已写在异机报告 §3），需补跑或换机。');
L.push('');
L.push('## 3. 机器可读', '');
L.push('本合并同时写出同名 `.json`（含各主机原始 assertions 与逐判据两栏状态）。');
L.push('');

const md = L.join('\n');
const outMd = path.join(args.out, `异机结果合并-${stamp}.md`);
const outJson = path.join(args.out, `异机结果合并-${stamp}.json`);
fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(outMd, md, 'utf8');
fs.writeFileSync(outJson, JSON.stringify({
  schema: 'v0.5-merge/1', generatedAt: new Date().toISOString(),
  local: { file: args.local, found: !!local, summary: local ? local.summary : null },
  remotes: remotes.map((r) => ({ file: r.file, hostname: r.data.hostname, pass: r.data.pass, tiers: r.data.tiers, skippedTiers: r.data.skippedTiers, assertions: r.data.assertions, codeSha256: r.data.codeSha256, version: r.data.version })),
  coverage: REMOTE_COVERAGE,
  columns: Object.fromEntries(ALL_CRITERIA.map((id) => [id, { local: localStatus.get(id) || 'UNCOVERED', remote: remoteVerdictFor(id).covered ? 'covered' : 'not-covered' }])),
}, null, 2) + '\n', 'utf8');
console.log(`已合并 ${remotes.length} 份异机结果 → ${outMd}`);
console.log(`机器可读 → ${outJson}`);
