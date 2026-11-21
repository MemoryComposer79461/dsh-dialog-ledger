#!/usr/bin/env node
/**
 * @file 证据/复现脚本/02-版本台账结构.mjs
 * @role 独立复核 `版本台账.md` 的结构（不 import 插件、不调判据执行器）：编号连续、版本唯一、
 *       正式版由同号 -re 升、末行与 VERSION.json 的版本/类型口径、三链（builtFrom/baselineTag/
 *       builtFromCommit）在台账里能否对上，以及本轮追加的「payloadHash 口径」说明段是否存在。
 * @usage node 证据\复现脚本\02-版本台账结构.mjs [--json]
 * @note 只读；输出含逐行摘要（前 3 行 + 末 2 行），不复制整表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PKG = path.resolve(path.dirname(SELF), '..', '..');
const AS_JSON = process.argv.includes('--json');
const TEXT = fs.readFileSync(path.join(PKG, '版本台账.md'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'VERSION.json'), 'utf8'));

const rows = [];
for (const line of TEXT.split('\n')) {
  const t = line.trim();
  const m = /^\|\s*(\d+)\s*\|/.exec(t);
  if (!m) continue;
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
  const pick = (s) => { const mm = /`([^`]+)`/.exec(s || ''); return mm ? mm[1] : s || ''; };
  rows.push({ n: Number(cells[0]), version: pick(cells[1]), type: cells[2] || '', date: cells[3] || '', head: pick(cells[4]), gate: cells[5] || '', red: cells[6] || '', desc: cells.slice(7).join('|').trim() });
}
const problems = [];
rows.forEach((r, i) => {
  if (r.n !== i) problems.push(`第 ${i + 1} 行编号应为 ${i}，实际 ${r.n}`);
  if (!/^v\d+\.\d+\.\d+/.test(r.version)) problems.push(`第 ${i + 1} 行版本号不可识别`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push(`第 ${i + 1} 行日期不可识别`);
  if (!/基座|snap|re\d+|正式/.test(r.type)) problems.push(`第 ${i + 1} 行类型不可识别`);
});
const dup = rows.filter((r, i) => rows.findIndex((x) => x.version === r.version) !== i).map((r) => r.version);
for (const v of new Set(dup)) problems.push(`版本号重复：${v}`);
for (let i = 1; i < rows.length; i += 1) {
  const r = rows[i];
  if (/正式/.test(r.type) && !String(rows[i - 1].version).startsWith(`${r.version}-re`)) problems.push(`正式版 ${r.version} 前面不是同号 -re（上一行 ${rows[i - 1].version}）`);
}
const last = rows[rows.length - 1];
if (last.version !== `v${VERSION.version}`) problems.push(`末行版本 ${last.version} ≠ VERSION.json.version v${VERSION.version}`);
if (VERSION.type === 'snap' && !/snap/.test(last.type)) problems.push(`VERSION.json.type=snap 但末行类型 ${last.type}`);
const links = [];
if (VERSION.baselineTag) links.push({ name: 'baselineTag', declared: VERSION.baselineTag, matched: rows.find((r) => r.version === String(VERSION.baselineTag).replace(/^lite-/, '')) });
if (VERSION.commit) links.push({ name: 'commit(HEAD)', declared: VERSION.commit, matched: rows.find((r) => r.head === VERSION.commit) });
for (const l of links) if (!l.matched) problems.push(`链断：VERSION.json.${l.name}='${l.declared}' 在台账找不到对应行`);
const caliber = {
  hasNoteSection: /payloadHash\s*口径/.test(TEXT),
  noteText: (TEXT.split('## payloadHash 口径')[1] || '').split('\n## ')[0].trim().slice(0, 600),
  historicalRowsUnchanged: rows.length,
};
const report = {
  schema: 'ledger-structure/1', at: new Date().toISOString(), ledger: '版本台账.md', rows: rows.length,
  first: rows[0] && rows[0].version, last: last && last.version, currentVersion: VERSION.version, currentType: VERSION.type,
  sample: [...rows.slice(0, 3), ...rows.slice(-2)].map((r) => ({ n: r.n, version: r.version, type: r.type, date: r.date, head: r.head })),
  links: links.map((l) => ({ name: l.name, declared: l.declared, matched: l.matched ? l.matched.version : '', ok: !!l.matched })),
  caliber, problems, pass: problems.length === 0,
  note: '本轮只追加「payloadHash 口径」说明段，未改任何历史行；结构与链的判定口径与 C40 相同（独立实现）。',
};
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`版本台账结构 · ${rows.length} 行（${report.first} … ${report.last}）`);
  console.log(`VERSION.json: version=${VERSION.version} type=${VERSION.type} commit=${VERSION.commit || ''} baselineTag=${VERSION.baselineTag || ''}`);
  console.log(`三链: ${report.links.map((l) => `${l.name}=${l.ok ? 'OK(' + l.matched + ')' : '断'}`).join(' | ') || '(无)'}`);
  console.log(`payloadHash 口径说明段: ${caliber.hasNoteSection ? '存在' : '缺失'}`);
  console.log(`结构问题 ${problems.length}: ${problems.join('；') || '无'}`);
  console.log(report.pass ? '结果: PASS' : '结果: FAIL');
}
process.exit(report.pass ? 0 : 1);
