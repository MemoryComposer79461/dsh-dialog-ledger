#!/usr/bin/env node
/**
 * @file docs/自测-收据摘要-s11.mjs
 * @role **S-11 C42 三条自测（先红后绿）** —— 日结摘要 v1.0.0-re2 新契约：
 *       「11 键（含 firstCode）＋ 落盘 TXT ＋ 发出后不重写、只能补发新版」
 *
 * @why 旧契约（S-1）是「摘要 10 键、坏了重出即可（直接覆盖）」。机主 2026-11-13 签字 S-11 / C42
 *      后签且优先，2026-11-14 早会裁定"按实现功能让判据变绿，不许改判据阈值"。故：
 *        · 10 键 → 11 键：新增 firstCode（与 lastCode 对；S-11 C42 写「首尾 code」）；
 *        · 产物：RECEIPT-YYYYMMDD[.vN].json ＋ 日结摘要-YYYYMMDD[.vN].txt（JSON/TXT 同版本号）；
 *        · **永不覆盖、永不删除**已存在的摘要文件：内容变了写下一版本；没变不产新版；
 *          TXT 缺失只补同版本 TXT；
 *        · 版本可见：ensureReceipts().versions → index.js → run-report.receiptDigest。
 *      本文件是这三件事的可执行证据（"先红后绿"：在旧实现上这三条必红）。
 *
 * 口径纪律：本测试只断言 S-11 明确写下的行为，不放松、不新增阈值。
 *
 * 用法：node docs\跑测试.mjs docs\自测-收据摘要-s11.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const R = await import(pathToFileURL(path.join(ROOT, 'lib', 'receipt.js')).href);

const CODE = (s12, n) => `20261114-${s12}-A-${String(n).padStart(8, '0')}`;

function mkLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 's11-receipt-'));
  const root = path.join(base, 'root');
  const anchor = path.join(base, 'receipts');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  fs.mkdirSync(anchor, { recursive: true });
  return { base, root, anchor };
}
function rmLab(lab) {
  try { fs.rmSync(lab.base, { recursive: true, force: true }); } catch { /* ignore */ }
}
/** 写某日台账（codes 逐行；ts 递增，+08:00）。 */
function writeDay(root, dateISO, codes) {
  const lines = codes.map((c, i) => JSON.stringify({
    v: 3, code: c, sid: 'session-s11test0001-1111-2222-3333-444444444401', turn: i + 1,
    seq: i + 1, status: 'ok', ts: `${dateISO}T09:${String(i).padStart(2, '0')}:00+08:00`,
  }));
  fs.writeFileSync(path.join(root, 'ledger', `${dateISO}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}
function sha256File(p) {
  return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '';
}

// ---------------------------------------------------------------------------
// ① firstCode：摘要第 6 键 = 台账首条 code；TXT 落盘且含首/末条编码
// ---------------------------------------------------------------------------
test('S-11/C42 ①摘要含 firstCode（=台账首条）且落盘 日结摘要 TXT', () => {
  const lab = mkLab();
  try {
    const day = '2026-11-10';
    const codes = [CODE('s11test00001', 1), CODE('s11test00002', 2), CODE('s11test00003', 3)];
    writeDay(lab.root, day, codes);
    const w = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day, nowMs: Date.parse('2026-11-14T08:00:00+08:00') });
    assert.equal(w.ok, true, '写摘要失败：' + (w.reason || ''));
    assert.equal(w.written, true);
    assert.equal(w.version, 1, '首版必须是 v1');
    // 11 键、顺序固定、firstCode 位于第 6 位
    const rec = JSON.parse(fs.readFileSync(w.path, 'utf8'));
    assert.deepEqual(Object.keys(rec), R.RECEIPT_KEYS.slice(), '摘要键顺序必须与 RECEIPT_KEYS 一致');
    assert.equal(R.RECEIPT_KEYS.length, 11, 'S-11 C42：摘要从 10 键扩到 11 键');
    assert.equal(R.RECEIPT_KEYS[5], 'firstCode');
    assert.equal(rec.firstCode, codes[0], 'firstCode 必须是台账首条 code');
    assert.equal(rec.lastCode, codes[codes.length - 1], 'lastCode 必须是台账末条 code');
    // TXT 落盘（S-11 F7「日结摘要 txt 可外发」的产物）——版本成对
    assert.equal(w.txtPath, R.digestTxtPath(lab.anchor, day, 1));
    assert.ok(fs.existsSync(w.txtPath), '必须落盘 日结摘要-YYYYMMDD.txt');
    const txt = fs.readFileSync(w.txtPath, 'utf8');
    assert.ok(txt.includes(`首条编码：${codes[0]}`), 'TXT 必须含首条编码');
    assert.ok(txt.includes(`末条编码：${codes[codes.length - 1]}`), 'TXT 必须含末条编码');
    assert.ok(txt.includes(`台账轮次：3 行`), 'TXT 必须含行数');
  } finally { rmLab(lab); }
});

// ---------------------------------------------------------------------------
// ② 同日改台账 → 只增 v2（JSON+TXT 成对），v1 一个字节不动
// ---------------------------------------------------------------------------
test('S-11/C42 ②同日二次改台账：只补发 v2，v1 JSON/TXT 逐字节不变（永不覆盖）', () => {
  const lab = mkLab();
  try {
    const day = '2026-11-11';
    const codes = [CODE('s11test00011', 1), CODE('s11test00012', 2)];
    writeDay(lab.root, day, codes);
    const w1 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day });
    assert.equal(w1.version, 1);
    const v1Json = sha256File(w1.path);
    const v1Txt = sha256File(w1.txtPath);
    const v1Buf = fs.readFileSync(w1.path);
    // 记账补了一天（改台账）→ 再写摘要：必须补发 v2，不能覆盖 v1
    writeDay(lab.root, day, [...codes, CODE('s11test00013', 3)]);
    const w2 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day });
    assert.equal(w2.ok, true);
    assert.equal(w2.written, true);
    assert.equal(w2.appended, true, '内容变化必须标 appended（补发新版）');
    assert.equal(w2.version, 2, '内容变了必须写下一版本 v2');
    assert.equal(w2.decision, 'appended-version');
    assert.ok(w2.path.endsWith('RECEIPT-20261111.v2.json'), 'v2 JSON 路径必须带 .v2 后缀');
    assert.ok(w2.txtPath.endsWith('日结摘要-20261111.v2.txt'), 'v2 TXT 路径必须带 .v2 后缀');
    // v1 没被改：字节 sha 不变、文件还在
    assert.equal(sha256File(w1.path), v1Json, 'v1 JSON 被改写（违反"永不覆盖"）');
    assert.equal(sha256File(w1.txtPath), v1Txt, 'v1 TXT 被改写（违反"永不覆盖"）');
    assert.deepEqual(fs.readFileSync(w1.path), v1Buf);
    // v2 内容正确
    const rec2 = JSON.parse(fs.readFileSync(w2.path, 'utf8'));
    // ★ re3/P2-6：`originalCount` 改当日口径 = 格式版本 3（11 键与键序不变）
    assert.equal(rec2.v, R.RECEIPT_VERSION, '格式版本必须是当前 RECEIPT_VERSION（re3 = 3）');
    assert.equal(rec2.v, 3);
    assert.equal(rec2.firstCode, codes[0]);
    assert.equal(rec2.lastCode, CODE('s11test00013', 3));
    assert.ok(fs.readFileSync(w2.txtPath, 'utf8').includes('第 2 版'), 'v2 TXT 必须标版本');
  } finally { rmLab(lab); }
});

// ---------------------------------------------------------------------------
// ③ 连续 3 tick 无变化 → 不产新版（幂等）；TXT 被手工删 → 只补同版本，不产新版
// ---------------------------------------------------------------------------
test('S-11/C42 ③连续 3 次无变化不产新版；TXT 缺失只补同版本 TXT', () => {
  const lab = mkLab();
  try {
    const day = '2026-11-12';
    writeDay(lab.root, day, [CODE('s11test00021', 1)]);
    const w1 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day });
    assert.equal(w1.version, 1);
    // 3 次重复（= 3 个 tick 的收据段），台账没变 → 全部幂等、不产新版
    for (let i = 1; i <= 3; i += 1) {
      const w = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day });
      assert.equal(w.ok, true);
      assert.equal(w.written, false, `第 ${i} 次无变化却写了文件`);
      assert.equal(w.version, 1, `第 ${i} 次无变化却产了新版 v${w.version}`);
      assert.ok(['idempotent', 'txt-repaired'].includes(w.decision), 'decision=' + w.decision);
    }
    assert.equal(R.listReceiptVersions(lab.anchor, day).length, 1, '无变化不得出现第二个版本');
    // 手工删掉 TXT（模拟"外发后清理"）→ 下一轮只补同版本 TXT，不产新版
    fs.rmSync(w1.txtPath);
    const w4 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day });
    assert.equal(w4.written, false);
    assert.equal(w4.decision, 'txt-repaired');
    assert.equal(w4.version, 1, '补 TXT 不得升版本');
    assert.ok(fs.existsSync(w1.txtPath), '同版本 TXT 必须被补回');
    assert.equal(R.listReceiptVersions(lab.anchor, day).length, 1);
  } finally { rmLab(lab); }
});

// ---------------------------------------------------------------------------
// ⑤ re3 / 审计② P2-6：originalCount 改「当日」口径（同库多日视图不串日）
//    · 摘要里的 originalCount 必须是**这一天**的第三级视图份数，不是全库累计；
//    · verifyReceipts 必须校验该字段（篡改即 SUMMARY_MISMATCH/field=originalCount）；
//    · 兼容：旧 v2 摘要（全库口径）按旧格式读，**不判红**；重出时按 v3 补发新版，旧文件不动。
// ---------------------------------------------------------------------------
const viewDirOf = (root) => path.join(root, '2026年11月', '11月总“完整原文”');
function writeView(root, code) {
  const dir = viewDirOf(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${code} 完整原文.md`), '# 凭证\n', 'utf8');
}
const codeOn = (dateISO, s12, n) => `${dateISO.replace(/-/g, '')}-${s12}-A-${String(n).padStart(8, '0')}`;

test('S-11/C42 ⑤originalCount 当日口径：多日视图不串日；verifyReceipts 校验；旧 v2 可重出', () => {
  const lab = mkLab();
  try {
    const day1 = '2026-11-10';
    const day2 = '2026-11-11';
    writeDay(lab.root, day1, [codeOn(day1, 's11test00041', 1)]);
    writeDay(lab.root, day2, [codeOn(day2, 's11test00042', 1), codeOn(day2, 's11test00042', 2)]);
    // day1：2 份视图；day2：3 份视图 + 1 份附件（附件不计）
    writeView(lab.root, codeOn(day1, 's11test00041', 1));
    writeView(lab.root, codeOn(day1, 's11test00043', 1));
    for (let i = 1; i <= 3; i += 1) writeView(lab.root, codeOn(day2, 's11test00042', i));
    fs.writeFileSync(path.join(viewDirOf(lab.root), `${codeOn(day2, 's11test00042', 9)} 原始事件.json`), '{}\n', 'utf8');

    const w1 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day1 });
    const w2 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day2 });
    assert.equal(w1.ok && w2.ok, true, (w1.reason || '') + (w2.reason || ''));
    assert.equal(w1.receipt.v, 3, 'P2-6 口径变更 = 摘要格式版本 +1（v3）');
    assert.equal(w1.receipt.originalCount, 2, 'day1 只能数 day1 的 2 份视图（全库共 5 份 → 旧口径会写 5）');
    assert.equal(w2.receipt.originalCount, 3, 'day2 只能数 day2 的 3 份视图（不含 原始事件.json 附件）');
    assert.equal(R.RECEIPT_KEYS.length, 11, 'S-11 C42：11 键契约不因口径变更而变');
    assert.equal(R.RECEIPT_KEYS[5], 'firstCode');

    // verifyReceipts 必须校验 originalCount（v3 起）：一致 → 绿
    let v = R.verifyReceipts({ root: lab.root, anchorRoot: lab.anchor });
    assert.equal(v.ok, true, '干净摘要必须绿：' + JSON.stringify(v.breaks));

    // 篡改 day1 摘要的 originalCount → 必须报 SUMMARY_MISMATCH(field=originalCount)
    const p1 = JSON.parse(fs.readFileSync(w1.path, 'utf8'));
    p1.originalCount = 5;
    fs.writeFileSync(w1.path, JSON.stringify(p1) + '\n', 'utf8');
    v = R.verifyReceipts({ root: lab.root, anchorRoot: lab.anchor });
    assert.equal(v.ok, false, '改 originalCount 必须能被 verifyReceipts 发现（旧实现不校验该字段）');
    const br = v.breaks.find((b) => b.date === day1 && b.field === 'originalCount');
    assert.ok(br, '必须定位到 date/field：' + JSON.stringify(v.breaks));
    assert.equal(String(br.expected), '5');
    assert.equal(String(br.actual), '2');

    // 兼容：旧 v2 摘要（全库口径、无 v3 语义）→ 不判红；重出时补发新版，旧文件逐字节不动
    const day0 = '2026-11-09';
    const oldPath = path.join(lab.anchor, 'RECEIPT-20261109.json');
    const oldObj = {
      v: 2, date: day0, offsetMinutes: 480, ledgerRows: 0, ledgerBytes: 0,
      firstCode: '', lastCode: '', originalCount: 99, partialCount: 0, badLines: 0,
      generatedAt: '2026-11-14 08:00:00',
    };
    fs.writeFileSync(oldPath, JSON.stringify(oldObj) + '\n', 'utf8');
    const oldBuf = fs.readFileSync(oldPath);
    v = R.verifyReceipts({ root: lab.root, anchorRoot: lab.anchor });
    assert.equal(v.breaks.some((b) => b.date === day0), false, '旧 v2 摘要不得因口径变更被判红：' + JSON.stringify(v.breaks));
    assert.equal(Number(v.legacyReceipts) >= 1, true, '旧格式摘要张数必须可观察（legacyReceipts）');

    const w3 = R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day0 });
    assert.equal(w3.ok, true);
    assert.equal(w3.appended, true, '旧 v2 摘要内容不同 → 必须只补发新版（永不覆盖）');
    assert.equal(w3.version, 2);
    assert.ok(w3.path.endsWith('RECEIPT-20261109.v2.json'), 'v3 新口径必须落成 .v2 文件：' + w3.path);
    assert.deepEqual(fs.readFileSync(oldPath), oldBuf, '旧摘要文件一个字节都不许动');
    const rec3 = JSON.parse(fs.readFileSync(w3.path, 'utf8'));
    assert.equal(rec3.v, 3);
    assert.equal(rec3.originalCount, 0, 'day0 无视图 → 当日口径 0');
    v = R.verifyReceipts({ root: lab.root, anchorRoot: lab.anchor });
    assert.equal(v.breaks.some((b) => b.date === day0), false, '重出后 day0 必须干净：' + JSON.stringify(v.breaks));

    // 改回干净（day1 摘要已被篡改 → 重出即回绿，证明"可重出"）
    R.writeDailyReceipt({ root: lab.root, anchorRoot: lab.anchor, dateISO: day1 });
    v = R.verifyReceipts({ root: lab.root, anchorRoot: lab.anchor });
    assert.equal(v.ok, true, '重出后必须回绿：' + JSON.stringify(v.breaks));
  } finally { rmLab(lab); }
});

// ---------------------------------------------------------------------------
// ④ ensureReceipts 暴露"已发版本数/最新版本号"（S-11 C42 (c)：不许补发无痕）
// ---------------------------------------------------------------------------
test('S-11/C42 ④ensureReceipts 返回 versions（已发版本数 + 最新版本号）', () => {
  const lab = mkLab();
  try {
    const day = '2026-11-09';
    writeDay(lab.root, day, [CODE('s11test00031', 1)]);
    const r1 = R.ensureReceipts({ root: lab.root, anchorRoot: lab.anchor, dates: [day], todayISO: '2026-11-14' });
    assert.equal(r1.ok, true, JSON.stringify(r1.errors));
    assert.equal(r1.written.length, 1);
    assert.equal(r1.versions.dates, 1);
    assert.equal(r1.versions.total, 1);
    assert.equal(r1.versions.latest.version, 1);
    assert.ok(r1.versions.latest.txt.startsWith('日结摘要-'));
    // 改台账 → 再 ensure（模拟下一 tick）→ 补发 v2，版本数 2
    writeDay(lab.root, day, [CODE('s11test00031', 1), CODE('s11test00032', 2)]);
    const r2 = R.ensureReceipts({ root: lab.root, anchorRoot: lab.anchor, dates: [day], todayISO: '2026-11-14' });
    assert.equal(r2.ok, true, JSON.stringify(r2.errors));
    assert.equal(r2.appended.length, 1);
    assert.equal(r2.appended[0].version, 2);
    assert.equal(r2.versions.total, 2, '已发版本数必须可见（=2）');
    assert.equal(r2.versions.latest.version, 2);
  } finally { rmLab(lab); }
});
