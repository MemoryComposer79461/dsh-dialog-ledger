/**
 * @file 自测-receipt.mjs
 * @role 防篡改收据（lib/receipt.js）的验收：收据字段、链、篡改检测、锚位置守卫、幂等与只读性。
 * @run `node --test docs/自测-receipt.mjs`
 *
 * 守：
 *  · 收据必须能证明"这一天台账没被改过"（改一个字节 → 核验失败）；
 *  · 两日收据必须串成链（次日 prevReceiptSha256 == 前日收据文件 sha256）；
 *  · 锚目录必须真在库外（锚在库内 = 自证，必须拒绝）；
 *  · 收据一旦写下不可被后续运行改写（同内容幂等、异内容冲突）；
 *  · 核验是只读的（前后整棵 root/锚 的文件 sha256 不变）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  buildDailyReceipt,
  writeDailyReceipt,
  verifyReceipts,
  ensureReceipts,
  listReceipts,
  receiptsDir,
  receiptPath,
  anchorIsOutside,
} from '../lib/receipt.js';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
  const root = path.join(dir, 'data');
  const anchor = path.join(dir, 'anchor'); // 默认与 root 平级 = 库外
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  fs.mkdirSync(anchor, { recursive: true });
  return { dir, root, anchor };
}

function writeDay(root, dateISO, rows) {
  const p = path.join(root, 'ledger', dateISO + '.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

function row(code, turn, doc) {
  return { v: 3, code, ts: '2026-11-09T10:00:0' + (turn % 10) + '+08:00', sid: 's', turn, seq: turn, status: 'ok', doc: doc || '' };
}

test('收据：字段齐全、ledgerSha256 可独立复算、originalCount 只数有 doc 的行', () => {
  const L = lab();
  const p = writeDay(L.root, '2026-11-09', [row('c1', 1, 'a.md'), row('c2', 2, ''), row('c3', 3, 'c.md')]);
  // v2.1 §1.2#8：originalCount = <root> 第三级视图文件实盘数，不是台账行 doc 非空数
  // （夹具：第三级 2 份 `* 完整原文.md` 视图 + 1 份 `原始事件.json` 附件；附件不计）
  const viewDir = path.join(L.root, '2026年11月', '11月总“完整原文”');
  fs.mkdirSync(viewDir, { recursive: true });
  for (const c of ['20261109-v05test00000-A-00000001', '20261109-v05test00000-A-00000002']) {
    fs.writeFileSync(path.join(viewDir, `${c} 完整原文.md`), '# 凭证\n', 'utf8');
  }
  fs.writeFileSync(path.join(viewDir, '20261109-v05test00000-A-00000003 原始事件.json'), '{}\n', 'utf8');
  const r = buildDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09' });
  assert.equal(r.ok, true, r.reason);
  const rc = r.receipt;
  assert.equal(rc.v, 1);
  assert.equal(rc.date, '2026-11-09');
  assert.equal(rc.ledgerRows, 3);
  assert.equal(rc.ledgerBytes, fs.statSync(p).size);
  assert.equal(rc.ledgerSha256, sha(p), '收据里的 ledgerSha256 必须等于直接重算');
  assert.equal(rc.originalCount, 2, '只数第三级「完整原文」视图文件（不含 原始事件.json 附件）');
  assert.equal(rc.lastCode, 'c3');
  assert.equal(rc.prevReceiptSha256, '', '首张无前链');
  // 反向：只有台账行 doc 非空、但没有第三级视图文件 → originalCount 必须为 0（防回退旧口径）
  fs.rmSync(path.join(L.root, '2026年11月'), { recursive: true, force: true });
  const r0 = buildDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09' });
  assert.equal(r0.ok, true, r0.reason);
  assert.equal(r0.receipt.originalCount, 0, '台账行 doc 非空 ≠ 原文视图存在；无视图文件必须是 0');
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：两日串链（次日 prev == 前日收据文件 sha256）', () => {
  const L = lab();
  writeDay(L.root, '2026-11-08', [row('c1', 1, 'a.md')]);
  writeDay(L.root, '2026-11-09', [row('c2', 1, 'b.md')]);
  const w1 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-08' });
  assert.equal(w1.ok, true);
  assert.equal(w1.written, true);
  const w2 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09' });
  assert.equal(w2.ok, true);
  // v2.1 §1.2：收据恰 10 键，prevReceiptDate 不在契约内（旧口径作废）
  const keys = Object.keys(w2.receipt);
  assert.deepEqual(keys, ['v', 'date', 'offsetMinutes', 'lastCode', 'ledgerRows', 'ledgerBytes',
    'ledgerSha256', 'originalCount', 'prevReceiptSha256', 'generatedAt'],
  '收据对象必须恰 10 键且顺序 == §1.2（prevReceiptDate 出现即失败）');
  assert.equal(keys.includes('prevReceiptDate'), false, 'prevReceiptDate 不属于 v2.1 契约');
  assert.equal(w2.receipt.prevReceiptSha256, sha(w1.path), '次日收据必须链接前日收据文件字节');
  const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
  assert.equal(v.ok, true, JSON.stringify(v.breaks));
  assert.equal(v.days, 2);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：台账被改一个字节 → LEDGER_CHANGED（且不改台账）', () => {
  const L = lab();
  const p = writeDay(L.root, '2026-11-09', [row('c1', 1, 'a.md')]);
  const w = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09' });
  assert.equal(w.ok, true);
  const before = sha(p);
  fs.appendFileSync(p, JSON.stringify(row('c2', 2, 'b.md')) + '\n', 'utf8');
  const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some((b) => b.type === 'LEDGER_CHANGED'), JSON.stringify(v.breaks));
  // 核验是只读的：台账与收据字节都不变
  assert.notEqual(sha(p), before, '（前提：台账确实被改过）');
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：删掉当日台账 → LEDGER_MISSING；删一张收据 → 后续链断', () => {
  const L = lab();
  writeDay(L.root, '2026-11-07', [row('c1', 1, 'a.md')]);
  writeDay(L.root, '2026-11-08', [row('c2', 1, 'b.md')]);
  writeDay(L.root, '2026-11-09', [row('c3', 1, 'c.md')]);
  for (const d of ['2026-11-07', '2026-11-08', '2026-11-09']) {
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d }).ok, true);
  }
  // 删中间那张收据 → 第三张的前链必然对不上
  fs.unlinkSync(receiptPath(L.anchor, '2026-11-08'));
  fs.unlinkSync(path.join(L.root, 'ledger', '2026-11-09.jsonl'));
  const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some((b) => b.type === 'CHAIN_BREAK'), JSON.stringify(v.breaks));
  assert.ok(v.breaks.some((b) => b.type === 'LEDGER_MISSING'), JSON.stringify(v.breaks));
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：锚目录在库内 → 拒绝（ANCHOR_INSIDE_ROOT），不写任何文件', () => {
  const L = lab();
  writeDay(L.root, '2026-11-09', [row('c1', 1, 'a.md')]);
  const inside = path.join(L.root, 'anchor');
  fs.mkdirSync(inside, { recursive: true });
  const chk = anchorIsOutside(inside, L.root);
  assert.equal(chk.ok, false);
  const b = buildDailyReceipt({ root: L.root, anchorRoot: inside, dateISO: '2026-11-09' });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'ANCHOR_INSIDE_ROOT');
  const e = ensureReceipts({ root: L.root, anchorRoot: inside, dates: ['2026-11-09'], todayISO: '2026-11-10' });
  assert.equal(e.ok, false);
  assert.equal(e.reason, 'ANCHOR_INSIDE_ROOT');
  assert.equal(fs.existsSync(receiptsDir(inside)), false, '拒绝时不得创建收据目录');
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：同内容幂等（written=false）；台账变化后重写 → RECEIPT_CONFLICT 且原收据不变', () => {
  const L = lab();
  const p = writeDay(L.root, '2026-11-09', [row('c1', 1, 'a.md')]);
  const w1 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09', nowMs: Date.parse('2026-11-10T01:00:00+08:00') });
  assert.equal(w1.written, true);
  const bytes1 = fs.readFileSync(w1.path);
  const w2 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09', nowMs: Date.parse('2026-11-10T02:00:00+08:00') });
  assert.equal(w2.ok, true);
  assert.equal(w2.written, false, '同内容不得重写');
  fs.appendFileSync(p, JSON.stringify(row('c2', 2, 'b.md')) + '\n', 'utf8');
  const w3 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-09' });
  assert.equal(w3.ok, false);
  assert.equal(w3.reason, 'RECEIPT_CONFLICT');
  assert.deepEqual(fs.readFileSync(w1.path), bytes1, '冲突时原收据必须原样保留');
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：ensureReceipts 只封"已完结日期"、跳过今天、幂等', () => {
  const L = lab();
  writeDay(L.root, '2026-11-08', [row('c1', 1, 'a.md')]);
  writeDay(L.root, '2026-11-09', [row('c2', 1, 'b.md')]);
  const e1 = ensureReceipts({
    root: L.root, anchorRoot: L.anchor,
    dates: ['2026-11-08', '2026-11-09'], todayISO: '2026-11-09',
    nowMs: Date.parse('2026-11-09T12:00:00+08:00'),
  });
  assert.equal(e1.ok, true);
  assert.deepEqual(e1.written, ['2026-11-08']);
  assert.deepEqual(e1.skipped, ['2026-11-09']);
  assert.equal(listReceipts(L.anchor).length, 1);
  const e2 = ensureReceipts({
    root: L.root, anchorRoot: L.anchor,
    dates: ['2026-11-08'], todayISO: '2026-11-09',
    nowMs: Date.parse('2026-11-09T13:00:00+08:00'),
  });
  assert.deepEqual(e2.written, [], '已存在 → 不重复写');
  assert.equal(e2.skipped.length, 1);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：disabled（锚留空）→ 不写任何库外文件', () => {
  const L = lab();
  writeDay(L.root, '2026-11-08', [row('c1', 1, 'a.md')]);
  const e = ensureReceipts({ root: L.root, anchorRoot: '', dates: ['2026-11-08'], todayISO: '2026-11-09' });
  assert.equal(e.disabled, true);
  assert.deepEqual(e.written, []);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('收据：verifyReceipts 只读（前后 root 与 anchor 所有文件 sha256 不变）', () => {
  const L = lab();
  writeDay(L.root, '2026-11-08', [row('c1', 1, 'a.md')]);
  writeDay(L.root, '2026-11-09', [row('c2', 1, 'b.md')]);
  for (const d of ['2026-11-08', '2026-11-09']) {
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d }).ok, true);
  }
  const snap = (base) => {
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(p.slice(base.length) + ':' + sha(p));
      }
    })(base);
    return out.sort().join('|');
  };
  const bRoot = snap(L.root);
  const bAnchor = snap(L.anchor);
  const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
  assert.equal(v.ok, true);
  assert.equal(snap(L.root), bRoot);
  assert.equal(snap(L.anchor), bAnchor);
  fs.rmSync(L.dir, { recursive: true, force: true });
});
