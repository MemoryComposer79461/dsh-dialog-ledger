/**
 * @file 自测-receipt-v21.mjs
 * @role v0.5 REC 收据锚**契约 v2.1** 的自测：REC-01…REC-10 行为 + 旧格式 `receipts/` 兼容 + 只读性。
 * @run `node --test docs/自测-receipt-v21.mjs`（或 `node docs/跑测试.mjs docs/自测-receipt-v21.mjs`）
 *
 * 与 `docs/自测-receipt.mjs` 的分工：
 *   · 老文件保留 v0.5 早期的库内行为断言（已按 Lead 授权更新 originalCount 口径与十键断言）；
 *   · 本文件按**契约 v2.1 判据**逐条钉死，尤其补上老文件没有的：
 *     平铺路径 / 空账日 / 退出码语义 / --json / ANCHOR_UNWRITABLE / 祖先锚拒绝 /
 *     `decision:"idempotent"` / count 口径 / **旧 `receipts/` 子目录仍可校验**。
 *
 * 纪律：只写本文件；不读写 U 盘（用文件占位/假盘符模拟不可写）；断言只认产物与退出码。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  RECEIPT_KEYS,
  RECEIPT_VERSION,
  EMPTY_SHA256,
  anchorIsOutside,
  buildDailyReceipt,
  ensureReceipts,
  legacyReceiptPath,
  listReceipts,
  receiptPath,
  receiptsDir,
  verifyReceipts,
  writeDailyReceipt,
} from '../lib/receipt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const CLI = path.join(PLUGIN, 'docs', '工具-核验收据.mjs');
const OFFSET = 480;

const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const shaBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (d, i) => `${String(d).replace(/-/g, '')}-v05test00000-A-${String(i).padStart(8, '0')}`;

function mkLab(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `recv21-${tag}-`));
  const root = path.join(base, 'ledger-root');
  const anchor = path.join(base, 'anchor');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  return { base, root, anchor, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function withLab(tag, fn) {
  const L = mkLab(tag);
  try {
    return await fn(L);
  } finally {
    L.cleanup();
  }
}

function row(c, ts) {
  return {
    v: 3, code: c, ts, sid: 'session-v21rec-000001-x', turn: Number(c.slice(-4)), seq: Number(c.slice(-4)),
    status: 'ok', doc: '2026年11月/11月总“完整原文”/x.md', docHash: 'a'.repeat(64), docSha256: 'a'.repeat(64),
    attachment: { name: `${c} 原始事件.json`, sha256: 'c'.repeat(64), bytes: 1 }, dateOffset: OFFSET,
  };
}

function writeDay(L, dateISO, rows) {
  fs.mkdirSync(path.join(L.root, 'ledger'), { recursive: true });
  const p = path.join(L.root, 'ledger', `${dateISO}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env },
  });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** root+anchor 全文件 sha256 集合（用于"只读"断言）。 */
function snapshot(...roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.resolve(p)}|${shaFile(p)}`);
    }
  };
  for (const r of roots) if (r && fs.existsSync(r)) walk(r);
  return out.sort().join('\n');
}

function parseJsonOut(r) {
  const txt = String(r.stdout || '').trim();
  const at = txt.indexOf('{');
  if (at < 0) return null;
  try { return JSON.parse(txt.slice(at)); } catch { return null; }
}

/** 造一份 **v2.0 旧格式**（12 键、`receipts/` 子目录）收据，用于兼容实测。 */
function writeLegacyReceipt(anchor, root, dateISO, prev) {
  const p = path.join(root, 'ledger', `${dateISO}.jsonl`);
  const buf = fs.readFileSync(p);
  const rows = buf.toString('utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x));
  const obj = {
    v: 1,
    date: dateISO,
    offsetMinutes: OFFSET,
    lastCode: rows.length ? rows[rows.length - 1].code : '',
    ledgerRows: rows.length,
    ledgerBytes: buf.length,
    ledgerSha256: shaBuf(buf),
    originalCount: 1,
    badLines: 0,
    prevReceiptDate: prev ? prev.date : '',
    prevReceiptSha256: prev ? shaBuf(prev.buf) : '',
    generatedAt: '2026-11-09 10:00:00',
  };
  const file = legacyReceiptPath(anchor, dateISO);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return { date: dateISO, file, buf: fs.readFileSync(file), obj };
}

// ============================================================================
// REC-01 · §1.1 flat 路径；§1.2 恰 10 键、顺序固定；字段口径
// ============================================================================
test('REC-01 §1.1/§1.2：flat 路径、恰 10 键且键序固定、字段口径全对', async () => {
  await withLab('r01', async (L) => {
    const d = '2026-11-08';
    const last = code(d, 3);
    const p = writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`), row(last, `${d}T11:00:00+08:00`)]);
    const w = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d });
    assert.equal(w.ok, true, w.reason);
    assert.equal(w.written, true);

    const flat = path.join(L.anchor, 'RECEIPT-20261108.json');
    assert.equal(w.path, flat, '写入必须走契约 §1.1 flat 路径');
    assert.equal(fs.existsSync(flat), true, 'flat 收据不存在');
    assert.equal(fs.existsSync(receiptsDir(L.anchor)), false, '新写不得再建 receipts/ 子目录');

    const buf = fs.readFileSync(flat);
    assert.notEqual(buf[0], 0xef, 'UTF-8 不得带 BOM');
    const text = buf.toString('utf8');
    assert.equal(text.trimEnd().split('\n').length, 1, '§1.1 建议单行 JSON（便于字节级 sha 复核）');
    assert.ok(text.endsWith('\n'), '文件应以 LF 结尾');
    const r = JSON.parse(text);

    assert.equal(Object.keys(r).length, 10, `恰 10 键，实际 ${Object.keys(r).length}`);
    assert.deepEqual(Object.keys(r), Array.from(RECEIPT_KEYS), '键名/顺序必须 == §1.2');
    assert.equal(r.v, 1);
    assert.equal(r.date, d);
    assert.equal(path.basename(flat), `RECEIPT-${d.replace(/-/g, '')}.json`);
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.lastCode, last);
    assert.equal(r.ledgerRows, 2);
    assert.equal(r.ledgerBytes, fs.statSync(p).size);
    assert.equal(r.ledgerSha256, shaFile(p));
    assert.equal(r.originalCount, 0, 'lab 内无第三级视图文件');
    assert.equal(r.prevReceiptSha256, '', '首日无前日收据');
    assert.match(r.generatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(String(r.generatedAt).includes('Z'), false);
    assert.equal(r.badLines, undefined, 'badLines 不在 v2.1 契约内');
    assert.equal(r.prevReceiptDate, undefined, 'prevReceiptDate 不在 v2.1 契约内');
  });
});

// ============================================================================
// REC-02 · 账证据四字段与实算全等
// ============================================================================
test('REC-02：ledgerSha256/ledgerBytes/ledgerRows/lastCode 与实算全等', async () => {
  await withLab('r02', async (L) => {
    const d = '2026-11-08';
    const p = writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`), row(code(d, 2), `${d}T11:00:00+08:00`), row(code(d, 3), `${d}T12:00:00+08:00`)]);
    const before = shaFile(p);
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d }).ok, true);
    const r = JSON.parse(fs.readFileSync(receiptPath(L.anchor, d), 'utf8'));
    const bytes = fs.readFileSync(p);
    const rows = bytes.toString('utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x));
    assert.equal(r.ledgerSha256, shaBuf(bytes));
    assert.equal(Number(r.ledgerBytes), bytes.length);
    assert.equal(Number(r.ledgerRows), rows.length);
    assert.equal(String(r.lastCode), rows[rows.length - 1].code);
    assert.equal(shaFile(p), before, '生成收据不得改台账');
  });
});

// ============================================================================
// REC-03 · 空账日仍生成，写全空账证据；originalCount 实盘（排除附件）
// ============================================================================
test('REC-03：当日无台账仍生成收据（rows=0/bytes=0/sha256("")/lastCode=""），originalCount 实盘', async () => {
  await withLab('r03', async (L) => {
    const d = '2026-11-08';
    const dir = path.join(L.root, '2026年11月', '11月总“完整原文”');
    fs.mkdirSync(dir, { recursive: true });
    for (const c of [code(d, 1), code(d, 2)]) fs.writeFileSync(path.join(dir, `${c} 完整原文.md`), '# 凭证\n', 'utf8');
    fs.writeFileSync(path.join(dir, `${code(d, 3)} 原始事件.json`), '{}\n', 'utf8');

    const w = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d });
    assert.equal(w.ok, true, w.reason);
    assert.equal(w.written, true, '空账日必须仍生成收据');
    const r = JSON.parse(fs.readFileSync(receiptPath(L.anchor, d), 'utf8'));
    assert.equal(r.ledgerRows, 0);
    assert.equal(r.ledgerBytes, 0);
    assert.equal(r.ledgerSha256, EMPTY_SHA256);
    assert.equal(r.lastCode, '');
    assert.equal(r.originalCount, 2, '只数第三级「完整原文」视图，不含 原始事件.json 附件');

    // 空账日收据不能被校验器误报 LEDGER_MISSING（无账可删）
    const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
    assert.equal(v.ok, true, JSON.stringify(v.breaks));
    // 空账日之后台账文件出现（= 证据变化）→ LEDGER_CHANGED，而不是静默通过
    writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`)]);
    const v2 = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
    assert.equal(v2.ok, false);
    assert.ok(v2.breaks.some((b) => b.type === 'LEDGER_CHANGED'), JSON.stringify(v2.breaks));
  });
});

// ============================================================================
// REC-04 · 两日链：D1 prev=""；D2 prev==sha256(D1 完整字节)
// ============================================================================
test('REC-04：连续两日链——D1 prev=""、D2 prev==sha256(D1 收据文件字节)', async () => {
  await withLab('r04', async (L) => {
    const d1 = '2026-11-08'; const d2 = '2026-11-09';
    writeDay(L, d1, [row(code(d1, 1), `${d1}T10:00:00+08:00`)]);
    writeDay(L, d2, [row(code(d2, 1), `${d2}T10:00:00+08:00`)]);
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d1 }).ok, true);
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d2 }).ok, true);
    const r1 = JSON.parse(fs.readFileSync(receiptPath(L.anchor, d1), 'utf8'));
    const r2 = JSON.parse(fs.readFileSync(receiptPath(L.anchor, d2), 'utf8'));
    assert.equal(r1.prevReceiptSha256, '');
    assert.equal(r2.prevReceiptSha256, shaFile(receiptPath(L.anchor, d1)), 'D2.prev != sha256(D1 文件字节)');
    const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
    assert.equal(v.ok, true, JSON.stringify(v.breaks));
    assert.equal(v.days, 2);
  });
});

// ============================================================================
// REC-05 · 只读校验器：三类篡改 + exit 2 + 前后 sha 集合不变
// ============================================================================
test('REC-05：改台账/删台账/删中间收据 → 校验器报出且 exit 2；运行前后文件 sha256 集合不变', async () => {
  const scenarios = [
    {
      tag: 'changed',
      setup: (L) => { writeDay(L, '2026-11-08', [row(code('2026-11-08', 1), '2026-11-08T10:00:00+08:00')]); },
      mutate: (L) => fs.appendFileSync(path.join(L.root, 'ledger', '2026-11-08.jsonl'), JSON.stringify(row(code('2026-11-08', 9), '2026-11-08T12:00:00+08:00')) + '\n'),
      expectType: 'LEDGER_CHANGED',
      expectStdout: /LEDGER_CHANGED/,
    },
    {
      tag: 'missing',
      setup: (L) => { writeDay(L, '2026-11-08', [row(code('2026-11-08', 1), '2026-11-08T10:00:00+08:00')]); },
      mutate: (L) => fs.unlinkSync(path.join(L.root, 'ledger', '2026-11-08.jsonl')),
      expectType: 'LEDGER_MISSING',
      expectStdout: /LEDGER_MISSING/,
    },
  ];
  for (const sc of scenarios) {
    await withLab('r05-' + sc.tag, async (L) => {
      sc.setup(L);
      assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-08' }).ok, true);
      sc.mutate(L);
      const before = snapshot(L.root, L.anchor);
      const cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`]);
      assert.equal(snapshot(L.root, L.anchor), before, `${sc.tag}：校验器写盘（只读被破）`);
      assert.equal(cli.status, 2, `${sc.tag}：退出码=${cli.status}（契约要求 2=发现差异）`);
      assert.ok(sc.expectStdout.test(cli.stdout), `${sc.tag}：stdout 未报 ${sc.expectType}`);
      assert.match(cli.stdout, /[0-9a-f]{8,}/i, `${sc.tag}：缺少 expected/actual hash 证据`);
      const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
      assert.ok(v.breaks.some((b) => b.type === sc.expectType), JSON.stringify(v.breaks));
    });
  }
  // ③ 删中间某日收据 → CHAIN_BREAK（missing-receipt），定位到 2026-11-09
  await withLab('r05-chain', async (L) => {
    const days = ['2026-11-08', '2026-11-09', '2026-11-10'];
    for (const d of days) writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`)]);
    for (const d of days) assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d }).ok, true);
    fs.unlinkSync(receiptPath(L.anchor, '2026-11-09'));
    const before = snapshot(L.root, L.anchor);
    const cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`]);
    assert.equal(snapshot(L.root, L.anchor), before, '删中间收据：校验器写盘');
    assert.equal(cli.status, 2);
    assert.match(cli.stdout, /CHAIN_BREAK/);
    assert.match(cli.stdout, /missing/i);
    assert.match(cli.stdout, /2026-11-09/);
  });
});

// ============================================================================
// REC-06 · 锚为空 = 关闭：不生成、不报错、校验器 {"enabled":false,"breaks":[]} exit 0
// ============================================================================
test('REC-06：锚为空=功能关闭——不生成收据、不写锚、校验器退出码 0 且 enabled:false', async () => {
  await withLab('r06', async (L) => {
    writeDay(L, '2026-11-08', [row(code('2026-11-08', 1), '2026-11-08T10:00:00+08:00')]);
    const e = ensureReceipts({ root: L.root, anchorRoot: '', dates: ['2026-11-08'], todayISO: '2026-11-09' });
    assert.equal(e.ok, true);
    assert.equal(e.disabled, true);
    assert.deepEqual(e.errors, []);
    const cli = runCli([`--root=${L.root}`]);
    assert.equal(cli.status, 0, '关闭状态退出码应 0');
    const j = JSON.parse(cli.stdout.trim());
    assert.equal(j.enabled, false);
    assert.deepEqual(j.breaks, []);
    assert.equal((j.checks || []).length, 0);
    // 不得在 root 内生成任何收据（锚目录根本未参与）
    const found = [];
    (function walk(d) {
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (/RECEIPT-\d{8}\.json$/.test(n.name)) found.push(p);
      }
    })(L.base);
    assert.deepEqual(found, []);
  });
});

// ============================================================================
// REC-07 · 锚 == root / 子路径 / 祖先 → ANCHOR_INSIDE_ROOT 且零写入；合法外置正常
// ============================================================================
test('REC-07：锚==root/子路径/祖先 全部拒绝（ANCHOR_INSIDE_ROOT，零写入）；合法外置正常', async () => {
  await withLab('r07', async (L) => {
    const d = '2026-11-08';
    writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`)]);
    const receiptsIn = (base) => {
      const out = [];
      (function walk(dir) {
        for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, n.name);
          if (n.isDirectory()) walk(p);
          else if (/RECEIPT-\d{8}\.json$/.test(n.name)) out.push(p);
        }
      })(base);
      return out;
    };
    for (const [label, anchor] of [
      ['锚==root', L.root],
      ['锚==root 子路径', path.join(L.root, 'anchor-inside')],
      ['锚==root 祖先', L.base],
    ]) {
      const w = writeDailyReceipt({ root: L.root, anchorRoot: anchor, dateISO: d });
      assert.equal(w.ok, false, `${label} 未被拒`);
      assert.equal(w.reason, 'ANCHOR_INSIDE_ROOT', `${label} reason=${w.reason}`);
      assert.equal(anchorIsOutside(anchor, L.root).ok, false, `${label} anchorIsOutside 未拒`);
      assert.deepEqual(receiptsIn(L.root), [], `${label}：root 内出现收据文件`);
    }
    const legal = path.join(L.base, 'anchor-legal');
    const w = writeDailyReceipt({ root: L.root, anchorRoot: legal, dateISO: d });
    assert.equal(w.ok, true, w.reason);
    assert.equal(w.written, true);
    assert.equal(fs.existsSync(path.join(legal, 'RECEIPT-20261108.json')), true);
  });
});

// ============================================================================
// REC-08 · 同日幂等（decision:"idempotent"，不改字节）vs 冲突（不覆盖）
// ============================================================================
test('REC-08：同证据重跑幂等（decision:"idempotent"，旧收据 sha 不变）；证据变化 RECEIPT_CONFLICT 不覆盖', async () => {
  await withLab('r08', async (L) => {
    const d = '2026-11-08';
    const p = writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`)]);
    const w1 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d });
    assert.equal(w1.ok, true);
    assert.equal(w1.written, true);
    const flat = receiptPath(L.anchor, d);
    const sha1 = shaFile(flat);
    const w2 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d, nowMs: Date.now() + 3600_000 });
    assert.equal(w2.ok, true);
    assert.equal(w2.written, false);
    assert.equal(w2.decision, 'idempotent', `幂等结果缺 decision:"idempotent"（keys=${JSON.stringify(Object.keys(w2))}）`);
    assert.equal(shaFile(flat), sha1, '幂等重跑改写了旧收据');
    assert.equal(listReceipts(L.anchor).length, 1, '幂等重跑新增了收据文件');
    const cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`]);
    assert.equal(cli.status, 0, '未变证据校验器应 exit 0');
    // 证据变化 → 冲突，旧收据字节不变
    fs.appendFileSync(p, JSON.stringify(row(code(d, 9), `${d}T12:00:00+08:00`)) + '\n');
    const w3 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d, nowMs: Date.now() + 7200_000 });
    assert.equal(w3.ok, false);
    assert.equal(w3.reason, 'RECEIPT_CONFLICT');
    assert.equal(shaFile(flat), sha1, '冲突时覆盖了旧收据');
    assert.equal(listReceipts(L.anchor).length, 1);
  });
});

// ============================================================================
// REC-09 · 假 U 盘/不可写锚 → ANCHOR_UNWRITABLE（不冒 ENOENT）、账务不受影响；复制后只读校验
// ============================================================================
test('REC-09：不可写锚 → ANCHOR_UNWRITABLE（不崩溃、不写账外）；锚复制件 --anchor 只读校验 exit 0', async () => {
  await withLab('r09', async (L) => {
    const d = '2026-11-08';
    writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`)]);
    // ① 假盘符（若本机确无该盘）或"文件占位当父目录"的确定性不可写路径
    let badAnchor = null;
    for (const drive of ['U:', 'Q:', 'R:', 'Z:', 'Y:', 'X:']) {
      if (!fs.existsSync(drive + '\\')) { badAnchor = `${drive}\\v21-fake-anchor-${process.pid}`; break; }
    }
    if (!badAnchor) {
      const blocker = path.join(L.base, 'not-a-dir');
      fs.writeFileSync(blocker, 'x');
      badAnchor = path.join(blocker, 'anchor-under-file');
    }
    const w = writeDailyReceipt({ root: L.root, anchorRoot: badAnchor, dateISO: d });
    assert.equal(w.ok, false, '不可写锚竟然写成功');
    assert.equal(w.reason, 'ANCHOR_UNWRITABLE', `reason=${w.reason}（契约要求 ANCHOR_UNWRITABLE；旧实现冒 ENOENT）`);
    // 账务照常：台账字节不受影响
    assert.equal(shaFile(path.join(L.root, 'ledger', `${d}.jsonl`)).length, 64);
    const e = ensureReceipts({ root: L.root, anchorRoot: badAnchor, dates: [d], todayISO: '2026-11-09' });
    assert.equal(e.ok, false);
    assert.ok(e.errors.some((x) => /ANCHOR_UNWRITABLE/.test(x)), JSON.stringify(e.errors));

    // ② 合法锚 → 收据；把锚目录**复制**到别处（模拟机主搬 U 盘）→ --anchor 只读校验 exit 0
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d }).ok, true);
    const moved = path.join(L.base, 'moved-anchor');
    fs.cpSync(L.anchor, moved, { recursive: true });
    const ro = runCli([`--root=${L.root}`, `--anchor=${moved}`, '--json']);
    assert.equal(ro.status, 0, `复制锚只读校验未通过（${ro.stdout.slice(0, 200)}）`);
    const j = parseJsonOut(ro);
    assert.equal(j.v, 1);
    assert.equal(j.enabled, true);
    assert.deepEqual(j.breaks, []);
  });
});

// ============================================================================
// REC-10 · --json 契约：{v,enabled,anchor,checks,breaks}；退出码 0/2/3；只读
// ============================================================================
test('REC-10：--json 输出 {v,enabled,anchor,checks[{name,ok}],breaks}；exit 0/2/3 语义正确；前后 sha 集合不变', async () => {
  await withLab('r10', async (L) => {
    const d1 = '2026-11-08'; const d2 = '2026-11-09';
    writeDay(L, d1, [row(code(d1, 1), `${d1}T10:00:00+08:00`)]);
    writeDay(L, d2, [row(code(d2, 1), `${d2}T10:00:00+08:00`)]);
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d1 }).ok, true);
    assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d2 }).ok, true);
    // ① 一致 → 0
    let before = snapshot(L.root, L.anchor);
    let cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`, '--json']);
    assert.equal(snapshot(L.root, L.anchor), before, '--json 一致场景改动了文件');
    assert.equal(cli.status, 0);
    const j = parseJsonOut(cli);
    assert.ok(j, '不是可解析 JSON：' + cli.stdout.slice(0, 160));
    assert.equal(j.v, 1);
    assert.equal(j.enabled, true);
    assert.equal(typeof j.anchor, 'string');
    assert.ok(j.anchor.length > 0);
    assert.ok(Array.isArray(j.checks) && j.checks.length > 0);
    for (const c of j.checks) {
      assert.equal(typeof c.name, 'string');
      assert.equal(typeof c.ok, 'boolean');
    }
    assert.deepEqual(j.breaks, []);
    // ② 有差异 → 2，breaks 非空
    fs.appendFileSync(path.join(L.root, 'ledger', `${d1}.jsonl`), JSON.stringify(row(code(d1, 9), `${d1}T12:00:00+08:00`)) + '\n');
    before = snapshot(L.root, L.anchor);
    cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`, '--json']);
    assert.equal(snapshot(L.root, L.anchor), before, '--json 差异场景改动了文件');
    assert.equal(cli.status, 2, `差异场景 exit=${cli.status}（应 2）`);
    const j2 = parseJsonOut(cli);
    assert.ok(Array.isArray(j2.breaks) && j2.breaks.length > 0);
    for (const b of j2.breaks) {
      assert.ok('kind' in b && 'date' in b && 'expected' in b && 'actual' in b, JSON.stringify(b));
    }
    // ③ anchor 不存在 → 3（用法/配置错误）
    const cli3 = runCli([`--root=${L.root}`, `--anchor=${path.join(L.base, 'no-such-anchor')}`, '--json']);
    assert.equal(cli3.status, 3, `anchor 不存在 exit=${cli3.status}（应 3）`);
  });
});

// ============================================================================
// 兼容 · 旧 `receipts/` 子目录收据仍可读、可校验（exit 0）
// ============================================================================
test('兼容：旧 v2.0 格式（receipts/ 子目录、12 键）两日链仍可校验，CLI exit 0', async () => {
  await withLab('compat', async (L) => {
    const d1 = '2026-11-08'; const d2 = '2026-11-09';
    writeDay(L, d1, [row(code(d1, 1), `${d1}T10:00:00+08:00`)]);
    writeDay(L, d2, [row(code(d2, 1), `${d2}T10:00:00+08:00`)]);
    const old1 = writeLegacyReceipt(L.anchor, L.root, d1, null);
    const old2 = writeLegacyReceipt(L.anchor, L.root, d2, old1);
    // 旧路径确实在 receipts/ 子目录、且没有新 flat 文件
    assert.ok(old1.file.includes(`${path.sep}receipts${path.sep}`), old1.file);
    assert.equal(fs.existsSync(receiptPath(L.anchor, d1)), false, '兼容样本不应有 flat 文件');
    // 库函数：默认读路径认旧收据
    const list = listReceipts(L.anchor);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((x) => x.format), ['legacy', 'legacy']);
    const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
    assert.equal(v.ok, true, '旧格式收据校验未通过：' + JSON.stringify(v.breaks));
    assert.equal(v.days, 2);
    // 校验器 CLI：只读 + exit 0 + 结论"一致"
    const before = snapshot(L.root, L.anchor);
    const cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`]);
    assert.equal(snapshot(L.root, L.anchor), before, '校验旧格式时写盘');
    assert.equal(cli.status, 0, `旧格式样本 exit=${cli.status}（应 0）；stdout=${cli.stdout.slice(0, 300)}`);
    assert.match(cli.stdout, /一致/);
    const cliJson = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`, '--json']);
    assert.equal(cliJson.status, 0);
    assert.deepEqual(parseJsonOut(cliJson).breaks, []);
  });
});

// ============================================================================
// 兼容 · 旧链上继续写新 flat 收据（迁移不破链）；同日旧收据存在时不重复写
// ============================================================================
test('兼容：旧 receipts/ 前链 → 新 flat 收据续链可校验（迁移不破链）', async () => {
  await withLab('compat-mix', async (L) => {
    const d1 = '2026-11-08'; const d2 = '2026-11-09';
    writeDay(L, d1, [row(code(d1, 1), `${d1}T10:00:00+08:00`)]);
    writeDay(L, d2, [row(code(d2, 1), `${d2}T10:00:00+08:00`)]);
    const old1 = writeLegacyReceipt(L.anchor, L.root, d1, null);
    // 同一天已存在旧收据：写新收据应识别为"证据已在"（幂等），不得再造一份同日 flat 收据
    const same = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d1 });
    assert.equal(same.ok, true, same.reason);
    assert.equal(same.written, false, '同日旧收据已存在，不应重复写新 flat 收据');
    assert.equal(same.decision, 'idempotent');
    assert.equal(fs.existsSync(receiptPath(L.anchor, d1)), false, '同日旧证据被复制成 flat 重复收据');
    // 次日写新 flat：prev 必须链接旧收据文件字节
    const w2 = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d2 });
    assert.equal(w2.ok, true, w2.reason);
    assert.equal(w2.written, true);
    const flat2 = JSON.parse(fs.readFileSync(receiptPath(L.anchor, d2), 'utf8'));
    assert.equal(flat2.prevReceiptSha256, shaBuf(old1.buf), '新收据前链未接旧 receipts/ 收据字节');
    const v = verifyReceipts({ root: L.root, anchorRoot: L.anchor });
    assert.equal(v.ok, true, JSON.stringify(v.breaks));
    assert.equal(listReceipts(L.anchor).length, 2, '同日不得出现两份收据');
    const cli = runCli([`--root=${L.root}`, `--anchor=${L.anchor}`, '--json']);
    assert.equal(cli.status, 0, cli.stdout.slice(0, 200));
  });
});

// ============================================================================
// 只读性 · 校验器/预览不得写盘（root 与 anchor 全量 sha256 集合不变）
// ============================================================================
test('只读：verifyReceipts 与 buildDailyReceipt 前后 root+anchor sha256 集合完全不变', async () => {
  await withLab('readonly', async (L) => {
    for (const d of ['2026-11-08', '2026-11-09']) {
      writeDay(L, d, [row(code(d, 1), `${d}T10:00:00+08:00`)]);
      assert.equal(writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: d }).ok, true);
    }
    const before = snapshot(L.root, L.anchor);
    buildDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-10' });
    verifyReceipts({ root: L.root, anchorRoot: L.anchor });
    assert.equal(snapshot(L.root, L.anchor), before, '只读函数写盘了');
  });
});
