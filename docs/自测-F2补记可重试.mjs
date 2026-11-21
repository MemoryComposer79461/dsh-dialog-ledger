/**
 * @file 验证-F2补记可重试.mjs
 * @role 回归锁（v1.0.0-preview4 / R2「零静默」）：**封板后补记失败必须可重试、且必须喊疼**。
 *
 * @why 第 3 轮审计 P1（动态复现）：封板补记只在"本轮刚写台账行"时尝试一次；写失败一次 → 该码
 *      永久既不在正册也不在补记册，**后续任何 tick 都不再重试**，而 reconcile 仍 ok。
 *      本项目自己的口径（15 号说明 §1 R2 / 闸一例外条款）是：失败可以，静默不行。
 *
 * @口径（写死）
 *      ① 失败进待办：`state.supplementPending` 必须有该组（含 codes/attempts/lastError），且**跨 tick 保留**；
 *      ② 幂等重放：障碍消失后的**下一个 tick** 必须补上（补记册出现该 code，待办出队）；
 *      ③ 连败 3 次 → 必须报警：`gaveUp=true` + WARN/errors 有条目 + gate.knownGaps 出现「补记待补=N」；
 *      ④ 不许误报：一次成功即清零，不许每 tick 常红。
 *
 * @run  node --test --test-concurrency=1 docs\验证-F2补记可重试.mjs
 *
 * @naming 故意不叫 `自测-*.mjs`：绿之前不并入全量套件（否则"预期红"会把逐名对账闸门撞红）。
 *
 * 写盘纪律：临时文件只落 `%TEMP%\dl-f2-*`，用例结束整目录删除；不碰真实 ~/.dsh、不改产品源码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce, __test__ } from '../index.js';
import { readAll, writeState, readState } from '../lib/ledger.js';

const OFFSET_MINUTES = 480;
const SESSION_FILE = 'session.v3.jsonl.zstd';
const SID = 'session-f2c0de12-3333-4e77-9a11-0f2b3c4d5e6f';
const T0 = Date.parse('2026-11-15T06:30:00+08:00');
const CLOSED_TURNS = 2;

const frame = (lineArr) => zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));

function buildFixture() {
  const header = JSON.stringify({ type: 'session', version: 3, id: SID, createdAt: T0, cwd: 'C:\\f2-lab', agentPreset: 'f2-lab' });
  const lines = [header];
  for (let n = 1; n <= CLOSED_TURNS; n++) {
    const ts = T0 + n * 1000;
    const base = (n - 1) * 4;
    lines.push(
      JSON.stringify({ type: 'turn/start', seq: base + 1, time: ts, data: { turn: n } }),
      JSON.stringify({ type: 'user/message', seq: base + 2, time: ts + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第 ' + n + ' 轮提问' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: base + 3, time: ts + 200, data: { message: { role: 'assistant', content: [{ type: 'text', text: '第 ' + n + ' 轮回答' }] } } }),
      JSON.stringify({ type: 'turn/end', seq: base + 4, time: ts + 300, data: { turn: n, reason: { kind: 'completed' } } }),
    );
  }
  return { fileBuffer: Buffer.concat([frame(lines)]), closedTurns: CLOSED_TURNS };
}

function writeSession(dshHome, fx) {
  const dir = path.join(dshHome, 'sessions', '--f2-lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  fs.writeFileSync(file, fx.fileBuffer);
  return file;
}

function fakeLogger() {
  const warnLines = [];
  return { warnLines, info: () => {}, warn: (...a) => warnLines.push(a.join(' ')) };
}

/** 基础配置；weeklyEnabled 由用例决定（补记段在周记账段里）。 */
function makeCfg(root, over = {}) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: OFFSET_MINUTES,
    hotWindowSeconds: 0,
    quietSeconds: 120,
    scanBudgetMs: 0,
    maxBytesPerSession: 0,
    checkupEnabled: false,
    weeklyEnabled: true,
    handoverEnabled: false,
    ...over,
  };
}

async function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-f2-'));
  assert.match(path.basename(base), /^dl-f2-/);
  const dshHome = path.join(base, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ base, dshHome, dataRoot });
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** 今天的补记册文件名（`补记-YYYYMMDD.md`，+08:00 口径）。 */
function supplementBookName(offsetMinutes = OFFSET_MINUTES, nowMs = Date.now()) {
  const d = new Date(nowMs + offsetMinutes * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `补记-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.md`;
}

function pendingOf(dataRoot) {
  const st = readState(dataRoot) || {};
  return Array.isArray(st.supplementPending) ? st.supplementPending : [];
}

/** 先跑一次 tick 把台账行造出来（补记重放需要真实台账行）。 */
async function seedLedger(dataRoot, dshHome, fx) {
  writeSession(dshHome, fx);
  const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { weeklyEnabled: false }));
  const read = readAll(dataRoot);
  assert.equal(read.ok, true, '台账必须可读');
  const rows = read.records.filter((r) => r.sid === SID);
  assert.equal(rows.length, fx.closedTurns, '前置：台账应有 ' + fx.closedTurns + ' 行（实际 ' + rows.length + '；written=' + stat.written + '）');
  return rows.map((r) => r.code);
}

/** 直接种一条"补记待办"（模拟上一次写失败后的状态）。 */
function seedPending(dataRoot, codes) {
  writeState(dataRoot, {
    supplementPending: [{
      gid: '2026-10-3|f2c0de123333A',
      codes,
      reason: '封板后发现',
      attempts: 0,
      gaveUp: false,
      firstSeenAt: '',
      bookStamp: '',
      lastError: 'injected EBUSY',
    }],
  });
}

// ============================================================================
// 一、障碍消失 → 下一个 tick 必须补上（幂等重放）
// ============================================================================

test('F2/A（可重试）：待办在 state 里 → 下一个 tick 必须补进补记册并出队', async () => {
  const fx = buildFixture();
  await withLab(async ({ dshHome, dataRoot }) => {
    const codes = await seedLedger(dataRoot, dshHome, fx);
    seedPending(dataRoot, [codes[0]]);
    assert.equal(pendingOf(dataRoot).length, 1, '前置：待办应有 1 组');

    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    const book = path.join(dataRoot, supplementBookName());
    const diag = {
      supplements: stat.supplements,
      bookExists: fs.existsSync(book),
      pendingLeft: pendingOf(dataRoot).length,
      pendingInStat: stat.supplementPending,
      warnSample: log.warnLines.slice(0, 2),
    };
    console.log('[f2-台账/A] ' + JSON.stringify(diag));

    assert.equal(fs.existsSync(book), true, '★ 障碍早已消失，补记册必须被写出来（' + book + '）');
    const text = fs.readFileSync(book, 'utf8');
    assert.ok(text.includes(codes[0]), '★ 补记册里必须出现该 code：' + codes[0]);
    assert.equal(pendingOf(dataRoot).length, 0, '★ 成功后待办必须出队（state.supplementPending 空了）');
    assert.equal(Number(stat.supplementPending) || 0, 0, 'stat.supplementPending 也必须为 0');
  });
});

// ============================================================================
// 二、连败 3 次 → 必须报警（不许静默）
// ============================================================================

test('F2/B（连败必须报到）：补记册路径被占死 → 连败 3 tick → gaveUp + gate 缺口「补记待补」', async () => {
  const fx = buildFixture();
  await withLab(async ({ dshHome, dataRoot }) => {
    const codes = await seedLedger(dataRoot, dshHome, fx);
    seedPending(dataRoot, [codes[0]]);
    // 注入写失败：在补记册**文件**位置放一个同名目录（打开/写入必失败，比 EBUSY 更稳定可复现）
    const book = path.join(dataRoot, supplementBookName());
    fs.mkdirSync(book, { recursive: true });

    const log = fakeLogger();
    const ticks = [];
    for (let i = 0; i < 3; i++) {
      // ★ 对账段有 1 h 进程内节流：每个 tick 前复位，模拟"每次都要现算"
      //   （否则后两个 tick 不会重算对账，stat.reconcile 沿用第一轮的旧结论，看不出 gate 缺口）
      __test__.resetPeriodicThrottle();
      const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
      ticks.push({
        tick: i + 1,
        pending: stat.supplementPending,
        gaveUp: stat.supplementPendingGaveUp,
        knownGaps: stat.reconcile && stat.reconcile.knownGaps,
        errors: stat.errors.filter((e) => /supplement/.test(String(e))).length,
      });
    }
    const pend = pendingOf(dataRoot);
    console.log('[f2-台账/B] ' + JSON.stringify({ ticks, pendLast: pend.slice(0, 1), warnCount: log.warnLines.length }));

    assert.equal(pend.length, 1, '★ 失败后待办必须保留（不许静默消失）');
    assert.equal(pend[0].attempts, 3, '★ 三次 tick 后 attempts 必须累计到 3（实际 ' + pend[0].attempts + '）');
    assert.equal(pend[0].gaveUp, true, '★ 连败 3 次必须标 gaveUp（放弃自动重试，等人工）');
    assert.ok(pend[0].lastError && String(pend[0].lastError).length > 0, '必须留下最后一次失败原因');
    assert.ok(ticks[2].errors >= 1, '第三 tick 必须有 supplement 错误条目');

    const gaps = (ticks[2].knownGaps || []);
    assert.ok(gaps.some((g) => /补记待补/.test(String(g))),
      '★ 放弃重试必须进 gate.knownGaps（实际 ' + JSON.stringify(gaps) + '）—— 否则面板会说"一切正常"');
    assert.ok(log.warnLines.some((w) => /补记/.test(String(w))), '★ 必须有 WARN 出声（静默丢账就是 R2）');
  });
});
