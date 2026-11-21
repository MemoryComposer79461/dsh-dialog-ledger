/**
 * @file 自测-P103瞬态缺口不计入闸门.mjs
 * @role 回归锁（v1.0.0-preview4 · P1-03）：**瞬态、已被后续读覆盖的 retryable 缺口不计入 gate**。
 *
 * @why 真实 DSH 持续追加写时，tick 有概率撞上"正在写"的**半截帧**（zstd 帧字节还没写完）→
 *      旧实现立即写一条 retryable 的 truncated-tail；下一 tick 帧补全、该轮正常入账，
 *      **但这条记录永远留在 .lost 里** → `gate.knownGaps` 永久 degraded、设备自检永久红
 *      （本机测试报告 P1-03；红队故障注入 A-half）。这是把"并发读写的正常噪声"当"数据损坏"。
 *
 * @口径（写死）count = **未被后续读覆盖**的缺口；total = 全部留痕；covered = 已补回、不计入 gate 的瞬态缺口。
 *      "覆盖"判定：该记录 retryable=true 且该源当前游标已越过它的全部缺失区间（或已到 EOF/scanSize）。
 *
 * @run node --test --test-concurrency=1 docs\自测-P103瞬态缺口不计入闸门.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce, __test__ } from '../index.js';

const T0 = Date.parse('2026-11-15T10:00:00+08:00');
const SID = 'session-p103ab-7777-4e77-9a11-0f2b3c4d5e6f';
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));

function makeCfg(root) {
  return {
    root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
    hotWindowSeconds: 0, quietSeconds: 120, scanBudgetMs: 0, maxBytesPerSession: 0,
    checkupEnabled: false, weeklyEnabled: true, handoverEnabled: false,
  };
}
const fakeLogger = () => ({ info() {}, warn() {}, error() {} });

test('P1-03：半截帧造成的 retryable 缺口，恢复后被覆盖 → gate 不再 degraded（count=0 / covered≥1）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p103-'));
  const dshHome = path.join(base, 'dsh-home');
  const dataRoot = path.join(base, 'data');
  const sessDir = path.join(dshHome, 'sessions', '--p103--', SID);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = path.join(sessDir, 'session.v3.jsonl.zstd');
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;

  try {
    const header = JSON.stringify({ type: 'session', version: 3, id: SID, createdAt: T0, cwd: 'C:\\p103' });
    const t1 = T0 + 1000;
    const turn1 = [header,
      JSON.stringify({ type: 'turn/start', seq: 1, time: t1, data: { turn: 1 } }),
      JSON.stringify({ type: 'user/message', seq: 2, time: t1 + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] } }),
      JSON.stringify({ type: 'turn/end', seq: 3, time: t1 + 200, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n';
    const t2 = T0 + 2000;
    const turn2 = [
      JSON.stringify({ type: 'turn/start', seq: 4, time: t2, data: { turn: 2 } }),
      JSON.stringify({ type: 'user/message', seq: 5, time: t2 + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q2-long-' + 'x'.repeat(2000) }] } }),
      JSON.stringify({ type: 'turn/end', seq: 6, time: t2 + 200, data: { turn: 2, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n';

    const f1buf = frame(turn1);
    const f2buf = frame(turn2);
    const cutAt = Math.floor(f2buf.length * 0.6);
    // tick1：第 2 帧只写前 60%（zstd 帧不完整 = 真实追加写撞上的"半截帧"）
    fs.writeFileSync(file, Buffer.concat([f1buf, f2buf.subarray(0, cutAt)]));
    const s1 = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));

    const lostPath = path.join(dataRoot, 'ledger', '.lost.jsonl');
    const lost1 = fs.existsSync(lostPath)
      ? fs.readFileSync(lostPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    const lostReasons1 = lost1.map((r) => r.reasons || []).flat();
    const diag1 = {
      written: s1.written,
      gate: s1.reconcile && s1.reconcile.conclusion,
      gaps: s1.reconcile && s1.reconcile.knownGaps,
      count: s1.reconcile && s1.reconcile.lostGaps,
      total: s1.reconcile && s1.reconcile.lostGapsTotal,
      covered: s1.reconcile && s1.reconcile.lostGapsCovered,
      lostReasons: lostReasons1,
    };
    console.log('[p103/tick1] ' + JSON.stringify(diag1).slice(0, 700));
    assert.ok(lost1.length >= 1, '前置：半截帧必须留下 .lost 记录');
    assert.equal(lost1.every((r) => r.retryable === true), true, '前置：半截帧类缺口必须是 retryable=true');

    // tick2：把**同一帧**余下的字节补上（文件只增长、不重写 → 不会产生 F-3 的"帧边界落在行中间"）
    fs.writeFileSync(file, Buffer.concat([f1buf, f2buf]));
    if (__test__ && typeof __test__.resetPeriodicThrottle === 'function') __test__.resetPeriodicThrottle();
    const s2 = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));

    const diag2 = {
      written: s2.written,
      gate: s2.reconcile && s2.reconcile.conclusion,
      gaps: s2.reconcile && s2.reconcile.knownGaps,
      count: s2.reconcile && s2.reconcile.lostGaps,
      total: s2.reconcile && s2.reconcile.lostGapsTotal,
      covered: s2.reconcile && s2.reconcile.lostGapsCovered,
    };
    console.log('[p103/tick2] ' + JSON.stringify(diag2).slice(0, 700));

    assert.ok(s2.reconcile, 'tick2 必须有对账结果');
    assert.ok(Number(s2.reconcile.lostGapsTotal) >= 1, '全部留痕数 total 必须保留（覆盖≠抹掉证据）');
    assert.ok(Number(s2.reconcile.lostGapsCovered) >= 1, '★ covered 必须 ≥1（该瞬态缺口已被后续读补回）');
    assert.equal(Number(s2.reconcile.lostGaps), 0, '★ count（未覆盖数）必须为 0：不许把已补回的瞬态缺口算成永久缺口');
    assert.equal(String(s2.reconcile.conclusion), 'ok',
      '★ gate 不许再因"已被覆盖的瞬态缺口"降级（实际 ' + s2.reconcile.conclusion + '；gaps=' + JSON.stringify(s2.reconcile.knownGaps) + '）');
    assert.equal((s2.reconcile.knownGaps || []).some((g) => /缺口留痕/.test(String(g))), false, '★ knownGaps 不许出现"缺口留痕"');

    // 该轮必须真的入账了（不是靠丢数据换绿）
    const st = JSON.parse(fs.readFileSync(path.join(dataRoot, 'ledger', '.state.json'), 'utf8'));
    const cur = Object.entries(st.sourceCursors || {}).find(([k]) => k.includes(SID));
    assert.ok(cur && Number(cur[1].offset) >= f1buf.length + f2buf.length, '★ 游标必须推进到文件尾（真读进来了）');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
