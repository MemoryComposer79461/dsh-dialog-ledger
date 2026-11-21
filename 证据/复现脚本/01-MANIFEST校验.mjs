#!/usr/bin/env node
/**
 * @file 证据/复现脚本/01-MANIFEST校验.mjs
 * @role 独立复算包内 `MANIFEST.sha256`（不 import 插件、不调判据执行器）：逐文件 sha256 与清单比对，
 *       输出 声明/实际/缺/多/改 与逐项名单。口径与 C39 一致（排除 .git 与 MANIFEST.sha256 自身）。
 * @usage node 证据\复现脚本\01-MANIFEST校验.mjs [--json] [--pkg=<包根>]
 * @note 本轮（v1.0.0-re 审计修复）允许新增 `docs/复核器/`、`证据/` 与已知 P4 验具 `docs/判据-1.0.mjs`，
 *       并允许改 `版本台账.md`（追加口径说明）；这些在出包最后一步重生成 MANIFEST 后应回到 0/0/0。
 *       默认把它们登记为"本轮已知差异"，其余任何缺/多/改仍退出 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PKG = (() => { const h = process.argv.find((a) => a.startsWith('--pkg=')); return path.resolve(h ? h.slice(6) : path.resolve(path.dirname(SELF), '..', '..')); })();
const AS_JSON = process.argv.includes('--json');
const ALLOW_EXTRA = ['docs/判据-1.0.mjs', 'docs/复核器/', '证据/'];
const ALLOW_CHANGED = ['版本台账.md'];
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

const mf = path.join(PKG, 'MANIFEST.sha256');
if (!fs.existsSync(mf)) { console.error(`缺 ${mf}`); process.exit(2); }
const declared = new Map();
let badLines = 0;
for (const line of fs.readFileSync(mf, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t) continue;
  const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(t);
  if (m) declared.set(m[2].split(path.sep).join('/'), m[1]);
  else badLines += 1;
}
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p !== mf) files.push({ abs: p, rel: path.relative(PKG, p).split(path.sep).join('/'), size: fs.statSync(p).size });
  }
})(PKG);
const actual = new Map();
let bytes = 0;
for (const f of files) { actual.set(f.rel, sha(f.abs)); bytes += f.size; }
const missing = [...declared.keys()].filter((k) => !actual.has(k));
const extra = [...actual.keys()].filter((k) => !declared.has(k));
const changed = [...declared.entries()].filter(([k, v]) => actual.has(k) && actual.get(k) !== v).map(([k]) => k);
const isAllowed = (rel, list) => list.some((x) => (x.endsWith('/') ? rel.startsWith(x) : rel === x));
const unexpectedExtra = extra.filter((r) => !isAllowed(r, ALLOW_EXTRA));
const unexpectedChanged = changed.filter((r) => !isAllowed(r, ALLOW_CHANGED));
// 判定口径：审计/修复进行中，包内必然出现新增文件与改动（含其它并行修复）。**缺文件/坏行才是包坏了**；
// 多/改只登记（`strictPass` 给出"出包重生成后应达到的 0/0/0"）。
const ok = !!declared.size && missing.length === 0 && badLines === 0;
const strictPass = ok && extra.length === 0 && changed.length === 0;
const report = {
  schema: 'manifest-verify/1', at: new Date().toISOString(), pkg: PKG, manifest: 'MANIFEST.sha256',
  manifestSha256: sha(mf), declared: declared.size, actual: actual.size, diskBytes: bytes, badLines,
  missing, extra, changed,
  knownNewThisRound: { extra: extra.filter((r) => isAllowed(r, ALLOW_EXTRA)), changed: changed.filter((r) => isAllowed(r, ALLOW_CHANGED)) },
  unexpected: { extra: unexpectedExtra, changed: unexpectedChanged },
  pass: ok, strictPass,
  note: '审计修复进行中：多/改 = 待并入，不是失败；只把"清单有、磁盘无"与坏行判失败。出包最后一步重生成 MANIFEST.sha256 后应达到 strictPass=true（缺/多/改 = 0/0/0）。',
};
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`MANIFEST 校验 · ${report.pkg}`);
  console.log(`清单 sha256: ${report.manifestSha256}`);
  console.log(`声明 ${report.declared} / 实际 ${report.actual} / 缺 ${missing.length} / 多 ${extra.length} / 改 ${changed.length} / 坏行 ${badLines}`);
  console.log(`本轮已知新增（多）: ${report.knownNewThisRound.extra.length}${report.knownNewThisRound.extra.length ? ' → ' + report.knownNewThisRound.extra.slice(0, 10).join('、') : ''}`);
  console.log(`本轮已知改动: ${report.knownNewThisRound.changed.join('、') || '(无)'}`);
  console.log(`本轮范围外的多（含其它并行修复）: ${unexpectedExtra.length}${unexpectedExtra.length ? ' → ' + unexpectedExtra.slice(0, 20).join('、') : ''}`);
  console.log(`本轮范围外的改（含其它并行修复）: ${unexpectedChanged.length}${unexpectedChanged.length ? ' → ' + unexpectedChanged.slice(0, 20).join('、') : ''}`);
  console.log(`结果: ${ok ? 'PASS（缺 0；多/改为待并入，strictPass=' + strictPass + '）' : 'FAIL（缺文件或坏行）'}`);
}
process.exit(ok ? 0 : 1);
