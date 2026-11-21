#!/usr/bin/env node
/**
 * @file 自测-审计修复.mjs
 * @role v1.0.0-re 审计修复的**只覆盖两项**的回归自测（每项 2 条）：
 *       ACPT-01：doctor ③采集健康在「会话正在被写入」时不再误判「游标卡住」红；
 *                但「源静止 > 2×intervalSeconds 且游标仍停在旧位置」仍必须判红（不假绿）。
 *       DEF-03 ：库内收据锚（== root / root 子路径 / root 祖先）→ `ANCHOR_INSIDE_ROOT`
 *                拒生成、零收据写出、不改台账；库外锚 → 收据照常生成。
 *
 * @run `node docs\自测-审计修复.mjs`
 *      退出码 0 = 4/4 全过；1 = 有失败（每条失败都打印命中的断言与实际值）。
 *
 * @why 为什么直接 import 两个模块、不 spawn CLI：
 *      · ACPT-01 要构造「游标落后 + 源 mtime/未闭合轮 pending」的确定性夹具；
 *        直接调 `tools/doctor.mjs` 的 `runDoctor`（等价 `--no-write`）可注入 nowMs，
 *        不用 sleep 等一个 tick，判据完全可复现。
 *      · DEF-03 要断言「零收据写出」「台账字节不变」，直接调收据三入口最干净。
 *      runDoctor 的其它 4 类检查照常跑（不落盘），本文件**只**断言 ③ 的 severity/details。
 *
 * @depends node:fs / node:path / node:os / node:crypto、
 *          ../tools/doctor.mjs、../lib/receipt.js、../lib/pending.js、../lib/ledger.js、../lib/encoder.js
 * @writes 仅系统临时目录（os.tmpdir()）下的夹具，跑完逐个删除；不写插件目录、不写任何真实账库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runDoctor } from '../tools/doctor.mjs';
import { isoTime } from '../lib/encoder.js';
import { statePath } from '../lib/ledger.js';
import { pendingPath } from '../lib/pending.js';
import {
  anchorIsOutside,
  buildDailyReceipt,
  ensureReceipts,
  listReceipts,
  receiptPath,
  writeDailyReceipt,
} from '../lib/receipt.js';

// ============================================================================
// 一、测试壳（零依赖：不引 docs/、不引 node:test runner；每条失败都带现场）
// ============================================================================

const results = [];
const TMP_DIRS = [];

/** ACPT-01 的宽限窗口径（必须与 tools/doctor.mjs 的 CURSOR_STUCK_GRACE_MS 一致：2×intervalSeconds）。 */
const GRACE_MS = 2 * 60 * 1000;

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    const msg = String((e && e.message) || e);
    console.log(`[FAIL] ${name}`);
    console.log('       ' + msg.split('\n').join('\n       '));
  }
}

function mkTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `auditfix-${tag}-`));
  TMP_DIRS.push(dir);
  return dir;
}

function shaFile(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function writeJsonl(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** 递归找某目录下所有 `RECEIPT-YYYYMMDD.json`（目录不存在 → []）。 */
function listReceiptFiles(base) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^RECEIPT-\d{8}\.json$/.test(e.name)) out.push(p);
    }
  };
  walk(base);
  return out;
}

// ============================================================================
// 二、ACPT-01 夹具与断言：③采集健康的「活跃写入宽限」
// ============================================================================

/**
 * 构造 ③ 的夹具：
 *   · 一个合法 v4 会话源（400 B；doctor ③ 只扫目录/stat/打开，不解码内容）；
 *   · state.sourceCursors 记 size=200、offset=180（= 上次读到 200 B，停在未闭合轮起点），
 *     当前文件已长到 400 B → 正是 P0-2「写入中的会话游标暂未到 EOF」的形态；
 *   · mtimeAgeMs 控制"源有多久没再变化"；pending 控制 `.pending.jsonl` 里有没有未闭合轮留痕。
 */
function mkIngestLab({ mtimeAgeMs = 0, pending = false } = {}) {
  const dir = mkTmp('acpt');
  const root = path.join(dir, 'data');
  const sessions = path.join(dir, 'sessions');
  const sid = 'acpt0000test';
  const sessionDir = path.join(sessions, `session-${sid}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const src = path.join(sessionDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(src, Buffer.alloc(400, 0x41));

  const nowMs = Date.now();
  const mtimeMs = nowMs - mtimeAgeMs;
  fs.utimesSync(src, new Date(mtimeMs), new Date(mtimeMs));

  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  const state = {
    initialized: true,
    firstRunAt: isoTime(nowMs - 3600_000),
    lastRunAt: isoTime(nowMs - 1000),
    sourceCursors: {
      [src]: { size: 200, offset: 180, updatedAt: isoTime(nowMs - 60_000) },
    },
  };
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n', 'utf8');

  if (pending) {
    writeJsonl(pendingPath(root), [{
      v: 1,
      kind: 'turn-pending',
      key: 'pending-test-key',
      sid,
      turn: 1,
      startMs: nowMs - 5000,
      file: src,
      source: src,
      size: 200,
      state: 'pending',
    }]);
  }
  return { dir, root, sessions, src, nowMs };
}

/** 跑一次 doctor（--no-write 等价），只取 ③ 采集健康。 */
function ingestCheck(L) {
  const out = runDoctor({
    root: L.root,
    sessionsBase: L.sessions,
    noWrite: true,
    nowMs: L.nowMs,
    sample: 0,
  });
  const c = out.checks.find((x) => x.id === 'ingest-health');
  assert.ok(c, 'doctor 输出里缺 ingest-health 检查（runDoctor 形状变了？）');
  return c;
}

test('ACPT-01① 活跃写入（源 mtime 在 2×interval 宽限窗内、游标未到 EOF）→ ③ 不判红', () => {
  const L = mkIngestLab({ mtimeAgeMs: 0 });
  const c = ingestCheck(L);
  assert.notEqual(c.severity, 'red', `③ 仍判红（ACPT-01 未修好）：${c.details.message}`);
  assert.equal(c.ok, true, '③ 判红时 ok 必须 false；宽限命中必须 ok=true');
  assert.deepEqual(c.details.cursors.stuck, [], '活动写入不应进 stuck 列表');
  assert.ok(c.details.cursors.active.length >= 1, 'details.cursors.active 必须记录被宽限的活动源');
  assert.equal(c.details.cursors.active[0].reason, 'mtime-recent', '宽限原因应为 mtime-recent');
  const grace = c.details.thresholds && c.details.thresholds.cursorStuckGraceMs;
  assert.ok(Number(grace) >= GRACE_MS, `阈值 cursorStuckGraceMs 应 >= ${GRACE_MS}，实际 ${grace}`);
  assert.ok(String(c.details.thresholds.cursorStuckRule || '').length > 0, '判据口径必须写进 details.thresholds');
  console.log(`       ③ severity=${c.severity}｜${c.details.message}`);
  console.log(`       宽限口径：${c.details.thresholds.cursorStuckRule}`);
});

test('ACPT-01② 未闭合轮 pending → 宽限不红；源静止 >2×interval 且无 pending → 仍红（不假绿）', () => {
  // 2-a：源已经静止 10 分钟（>2×interval），但该源有未闭合轮 pending 留痕 → P0-2 等 turn/end，宽限
  const P = mkIngestLab({ mtimeAgeMs: 10 * 60 * 1000, pending: true });
  const cp = ingestCheck(P);
  assert.notEqual(cp.severity, 'red', `有未闭合轮 pending 不应判红：${cp.details.message}`);
  assert.equal(cp.ok, true);
  assert.equal(cp.details.cursors.active[0].reason, 'pending-unclosed', '宽限原因应为 pending-unclosed');
  assert.deepEqual(cp.details.cursors.stuck, []);

  // 2-b：同样的"源静止 + 游标落后"，但没有未闭合轮留痕 → 真·游标卡住，必须红
  const S = mkIngestLab({ mtimeAgeMs: 10 * 60 * 1000, pending: false });
  const cs = ingestCheck(S);
  assert.equal(cs.severity, 'red', `源静止 + 游标落后必须判红（实际 ${cs.severity}：${cs.details.message}）`);
  assert.equal(cs.ok, false);
  assert.equal(cs.details.cursors.stuck.length, 1, '真卡住的源必须进 stuck 列表');
  assert.equal(cs.details.cursors.active.length, 0, '真卡住的源不得被宽限');
  assert.match(cs.details.message, /游标卡住/, '红因必须写明"游标卡住"');
  console.log(`       2-a pending 宽限：severity=${cp.severity}｜${cp.details.message}`);
  console.log(`       2-b 真卡住：severity=${cs.severity}｜${cs.details.message}`);
});

// ============================================================================
// 三、DEF-03 夹具与断言：库内收据锚必须被拒绝
// ============================================================================

function mkReceiptLab() {
  const dir = mkTmp('def');
  const root = path.join(dir, 'data');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  const dayPath = path.join(root, 'ledger', '2026-11-08.jsonl');
  fs.writeFileSync(
    dayPath,
    JSON.stringify({
      v: 3, code: '20261108-abcdef123456-A-00000001', ts: '2026-11-08T10:00:00+08:00',
      sid: 's', turn: 1, seq: 1, status: 'ok',
    }) + '\n',
    'utf8',
  );
  return { dir, root, anchor: path.join(dir, 'anchor-legal'), dayPath };
}

test('DEF-03① 库内锚（== root / root 子路径 / root 祖先）→ 拒绝生成、errors 含 ANCHOR_INSIDE_ROOT、零收据写出', () => {
  const L = mkReceiptLab();
  const before = shaFile(L.dayPath);
  const subAnchor = path.join(L.root, 'anchor-inside');
  const cases = [
    ['锚 == root', L.root],
    ['锚 = root 子路径', subAnchor],
    ['锚 = root 祖先', L.dir],
  ];
  for (const [label, anchor] of cases) {
    assert.equal(anchorIsOutside(anchor, L.root).ok, false, `${label}：anchorIsOutside 本应拒绝`);
    const b = buildDailyReceipt({ root: L.root, anchorRoot: anchor, dateISO: '2026-11-08' });
    assert.equal(b.ok, false, `${label}：buildDailyReceipt 未拒绝（DEF-03 未修好）`);
    assert.equal(b.reason, 'ANCHOR_INSIDE_ROOT', `${label}：reason=${b.reason}`);
    const w = writeDailyReceipt({ root: L.root, anchorRoot: anchor, dateISO: '2026-11-08' });
    assert.equal(w.ok, false, `${label}：writeDailyReceipt 未拒绝（竟写出收据）`);
    assert.equal(w.written, false, `${label}：拒绝时 written 必须 false`);
    assert.equal(w.reason, 'ANCHOR_INSIDE_ROOT', `${label}：write reason=${w.reason}`);
    const e = ensureReceipts({ root: L.root, anchorRoot: anchor, dates: ['2026-11-08'], todayISO: '2026-11-09' });
    assert.equal(e.ok, false, `${label}：ensureReceipts 未拒绝`);
    assert.equal(e.reason, 'ANCHOR_INSIDE_ROOT', `${label}：ensureReceipts.reason=${e.reason}（index.js 靠它写 errors）`);
    assert.ok(
      (e.errors || []).some((x) => /ANCHOR_INSIDE_ROOT/.test(String(x))),
      `${label}：errors 未含 ANCHOR_INSIDE_ROOT：${JSON.stringify(e.errors)}`,
    );
    assert.deepEqual(e.written, [], `${label}：拒绝时不得有写入`);
  }
  // 零收据写出：root 内与祖先目录（= L.dir）都不得出现任何收据文件
  assert.deepEqual(listReceiptFiles(L.root), [], 'root 内出现了收据文件（DEF-03 未修好）');
  assert.deepEqual(listReceiptFiles(L.dir), [], '锚位置（含 root 祖先）出现了收据文件');
  // 拒绝时不得创建锚目录
  assert.equal(fs.existsSync(subAnchor), false, '拒绝时不得创建库内锚目录');
  // 不改台账
  assert.equal(shaFile(L.dayPath), before, '拒绝对台账字节产生了改动');
  assert.equal(listReceipts(L.anchor).length, 0, '库外正常锚不该被写（本用例根本没传它）');
});

test('DEF-03② 库外锚（root 同级）→ 收据正常生成、幂等不重写、root 内零收据', () => {
  const L = mkReceiptLab();
  assert.equal(anchorIsOutside(L.anchor, L.root).ok, true, '夹具前提：同级锚应在库外');
  const nowMs = Date.parse('2026-11-09T01:00:00+08:00');
  const w = writeDailyReceipt({ root: L.root, anchorRoot: L.anchor, dateISO: '2026-11-08', nowMs });
  assert.equal(w.ok, true, `库外锚反被拒：${w.reason}`);
  assert.equal(w.written, true, '库外锚首写应 written=true');
  const expected = receiptPath(L.anchor, '2026-11-08');
  assert.equal(fs.existsSync(expected), true, `未生成收据文件：${expected}`);
  const rc = JSON.parse(fs.readFileSync(expected, 'utf8'));
  assert.equal(rc.date, '2026-11-08');
  assert.equal(rc.ledgerRows, 1);
  assert.equal(rc.badLines, 0);
  assert.equal(rc.ledgerBytes, fs.statSync(L.dayPath).size);
  assert.equal(listReceipts(L.anchor).length, 1);

  const e = ensureReceipts({
    root: L.root, anchorRoot: L.anchor, dates: ['2026-11-08'], todayISO: '2026-11-09', nowMs,
  });
  assert.equal(e.ok, true, JSON.stringify(e.errors));
  assert.deepEqual(e.written, [], '同内容重跑必须幂等（不重写）');
  assert.deepEqual(e.skipped, ['2026-11-08']);
  assert.equal(e.reason, undefined, '正常库外锚不得带 reason');
  assert.equal(listReceiptFiles(L.anchor).length, 1, '幂等重跑新增了收据');
  assert.deepEqual(listReceiptFiles(L.root), [], '库外锚不应在 root 内落收据');
});

// ============================================================================
// 四、汇总（跑完删夹具；退出码 0 = 全绿）
// ============================================================================

for (const d of TMP_DIRS) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`自测-审计修复：${results.length - failed}/${results.length} PASS` +
  (failed ? `（${failed} FAIL）` : '，全绿'));
if (failed) process.exitCode = 1;
