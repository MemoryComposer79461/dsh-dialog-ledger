#!/usr/bin/env node
/**
 * @file 工具-交叉核验封板.mjs
 * @role 只读核验：把每本**已封板**周记账的机器列，与 `seal-journal` 里的 `rows[]` 快照逐格比对。
 *
 * @why 审计 M-03：封板 hash 覆盖的是台账派生数据，xlsx 本身却可能被 Excel 打开改一格再保存。
 *      本工具回答一句话：**"这本册子现在写着的，还是当初封板时那些机器值吗？"**
 *      它**不改任何文件**，可以给机主/外部审计当独立验证器用。
 *
 * 用法：
 *   node docs/工具-交叉核验封板.mjs --root=<数据总库>            # 人读表格
 *   node docs/工具-交叉核验封板.mjs --root=<数据总库> --json      # 机器可读
 *   node docs/工具-交叉核验封板.mjs --root=<数据总库> --gid=<组>  # 只核一本
 *
 * 退出码：0 = 全部通过；1 = 有不符/缺失/无法核验；2 = 参数错误或 journal 读不出。
 *
 * 边界（如实说）：
 *   · 只核**机器列** A/B/C/H；人工列（D–G、J）不归机器管，改人工列不算篡改。
 *   · journal 里没有 `rows[]` 快照的旧封板 → 记 `no-snapshot`，**不能**当作通过。
 *   · 本工具不验证封板 hash 链（那是 `verifySealChain` 的事），两者的结论要一起看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const args = process.argv.slice(2);
const arg = (k, d = '') => {
  const a = args.find((x) => x === k || x.startsWith(k + '='));
  if (!a) return d;
  const i = a.indexOf('=');
  return i < 0 ? true : a.slice(i + 1);
};
const ROOT = String(arg('--root', '') || '');
const ONLY_GID = String(arg('--gid', '') || '');
const AS_JSON = !!arg('--json', false);

if (!ROOT) {
  console.error('用法: node docs/工具-交叉核验封板.mjs --root=<数据总库> [--json] [--gid=<组>]');
  process.exit(2);
}

const sealjournal = await mod('lib/sealjournal.js');
const cross = await mod('freeze/sealcross.js');

let events = [];
try {
  const r = sealjournal.readSealEvents(ROOT);
  if (r.readError) { console.error('journal 读不出: ' + r.readError); process.exit(2); }
  events = (r.events || []).filter((e) => e && e.kind === 'weekly-seal');
} catch (e) {
  console.error('journal 读取异常: ' + (e && e.message ? e.message : String(e)));
  process.exit(2);
}

const gids = [...new Set(events.map((e) => String(e.gid || '')))].filter(Boolean)
  .filter((g) => !ONLY_GID || g === ONLY_GID);

const results = [];
for (const gid of gids) {
  const r = cross.crosscheckSeal(ROOT, gid, { readEvents: sealjournal.readSealEvents });
  results.push({ gid, ...r });
}

const fail = results.filter((r) => r.ok !== true);

if (AS_JSON) {
  console.log(JSON.stringify({
    schema: 'v05-seal-crosscheck/1',
    root: ROOT,
    generatedAt: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00'),
    total: results.length,
    pass: results.length - fail.length,
    fail: fail.length,
    results,
  }, null, 2));
  process.exit(fail.length ? 1 : 0);
}

if (results.length === 0) {
  console.log('没有已封板的周记账可核验（journal 里没有 weekly-seal 记录）。');
  process.exit(ONLY_GID ? 1 : 0);
}

console.log('封板交叉核验（只读）· root = ' + ROOT);
console.log('组数: ' + results.length + '｜通过: ' + (results.length - fail.length) + '｜不通过: ' + fail.length);
console.log('');
for (const r of results) {
  const flag = r.ok ? 'PASS' : (r.status === 'no-snapshot' ? '无快照' : 'FAIL');
  console.log(`[${flag}] ${r.gid}  文件=${r.file || '(无)'}  核对格数=${r.checked}`);
  if (!r.ok) {
    if (r.reason) console.log('        原因: ' + r.reason);
    for (const m of (r.mismatches || []).slice(0, 8)) {
      console.log(`        不符: ${m.sheet}!${m.col}${m.row} 编码=${m.code} 期望=${JSON.stringify(m.expected)} 实际=${JSON.stringify(m.actual)}`);
    }
    if ((r.mismatches || []).length > 8) console.log(`        …还有 ${r.mismatches.length - 8} 处`);
    for (const c of (r.missing || []).slice(0, 8)) console.log('        缺行: ' + c);
  }
}
console.log('');
console.log(fail.length ? '结论：存在不通过项（见上）。' : '结论：全部通过（机器列与封板快照一致）。');
console.log('注意：本工具只核机器列 A/B/C/H；人工列改动不算篡改。封板 hash 链请另跑 verifySealChain。');
process.exit(fail.length ? 1 : 0);
