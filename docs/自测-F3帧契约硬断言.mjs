/**
 * @file 自测-F3帧契约硬断言.mjs
 * @role 回归锁（v1.0.0-preview4 · F-3 方案 B）：**「帧 = 整行」契约 + 硬断言（停手报警）**。
 *
 * @why 插件假设每个 zstd 帧以完整 JSONL 行结束。若写入器在某一行中间 flush，旧实现按帧 split
 *      会把跨帧那一行劈成两个坏行、`catch { continue }` 静默丢掉 —— 而 turn/start 与 turn/end
 *      仍完整，于是这一轮被判"已闭合"落账，附件/原文永久少一条事件且不报错（条件 P0）。
 *
 * @口径（机主 2026-11-15 裁定：方案 B，不做跨帧 pending 缓冲）
 *      契约写死：DSH 会话写入器保证帧边界 = 行边界。
 *      硬断言：解压文本非空、不以 \n 结尾、**且后面还有帧** → 契约被破坏 →
 *         ① 立即停手（不读后面的帧、不推进游标越过该帧）；
 *         ② 报警（ERROR 级、`contractViolations` 计数、`.lost` 里 reason='contract-violation'）；
 *         ③ **不许**"警告后继续"，**不许**静默丢跨帧残片。
 *      边界：**最后一帧**不以换行结尾 = 合法的"截断尾"（进程被杀/正在写），不在此列。
 *
 * @run node --test --test-concurrency=1 docs\自测-F3帧契约硬断言.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce } from '../index.js';
import { readAll } from '../lib/ledger.js';

const OFFSET_MINUTES = 480;
const T0 = Date.parse('2026-11-15T09:00:00+08:00');
const SID_A = 'session-f3c0de01-6666-4e77-9a11-0f2b3c4d5e6f';
const SID_B = 'session-f3c0de02-6666-4e77-9a11-0f2b3c4d5e6f';
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));

function makeCfg(root) {
  return {
    root, intervalSeconds: 60, enabled: true, offsetMinutes: OFFSET_MINUTES,
    hotWindowSeconds: 0, quietSeconds: 120, scanBudgetMs: 0, maxBytesPerSession: 0,
    checkupEnabled: false, weeklyEnabled: false, handoverEnabled: false,
  };
}

function fakeLogger() {
  const errors = []; const warns = [];
  return { errors, warns, info() {}, warn: (m) => warns.push(String(m)), error: (m) => errors.push(String(m)) };
}

async function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-f3-'));
  const dshHome = path.join(base, 'dsh-home');
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try { return await fn({ base, dshHome, dataRoot }); } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function writeSession(dshHome, sid, buf) {
  const dir = path.join(dshHome, 'sessions', '--f3--', sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), buf);
}

// ============================================================================
// A. 跨帧半行（后面还有帧）→ 契约破坏 → 硬断言停手 + 报警
// ============================================================================
test('F-3/A：帧边界落在行中间（后面还有帧）→ 必须硬断言停手并报警，不许静默丢残片', async () => {
  const header = JSON.stringify({ type: 'session', version: 3, id: SID_A, createdAt: T0, cwd: 'C:\\f3', agentPreset: 'f3' });
  const t1 = T0 + 1000;
  // 帧1：完整的一轮（turn 1 闭合）
  const f1 = [
    header,
    JSON.stringify({ type: 'turn/start', seq: 1, time: t1, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 2, time: t1 + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] } }),
    JSON.stringify({ type: 'turn/end', seq: 3, time: t1 + 200, data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n') + '\n';
  // 帧2：**半行**（turn 2 的 turn/start 只写了一半，且不以 \n 结尾）—— 后面还有帧3
  const t2 = T0 + 2000;
  const half = JSON.stringify({ type: 'turn/start', seq: 4, time: t2, data: { turn: 2 } });
  const f2 = half.slice(0, Math.floor(half.length / 2)); // 故意截成半行
  // 帧3：半行收尾 + turn 2 结束
  const f3 = half.slice(Math.floor(half.length / 2)) + '\n' + JSON.stringify({ type: 'turn/end', seq: 5, time: t2 + 100, data: { turn: 2, reason: { kind: 'completed' } } }) + '\n';
  const buf = Buffer.concat([frame(f1), frame(f2), frame(f3)]);
  const expectHalt = Buffer.byteLength(f1, 'utf8');

  await withLab(async ({ dshHome, dataRoot }) => {
    writeSession(dshHome, SID_A, buf);
    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    // .lost 证据
    const lostPath = path.join(dataRoot, 'ledger', '.lost.jsonl');
    const lost = fs.existsSync(lostPath)
      ? fs.readFileSync(lostPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    const diag = {
      written: stat.written,
      contractViolations: stat.contractViolations,
      errorSample: (stat.errors || []).filter((e) => /契约|contract/.test(String(e))).slice(0, 1),
      lostReasons: lost.map((r) => (r && r.reasons) || []).flat(),
    };
    console.log('[f3-台账/A] ' + JSON.stringify(diag).slice(0, 900));

    // ★ ① 契约计数 + ERROR 报警（不许只 WARN）
    assert.equal(Number(stat.contractViolations), 1, '★ 必须计到 1 次契约破坏（实际 ' + stat.contractViolations + '）');
    const errText = [...(stat.errors || []), ...log.errors].join('\n');
    assert.match(errText, /帧=整行契约被破坏/, '★ 必须有 ERROR「帧=整行契约被破坏」报警');
    assert.match(errText, /硬断言停手/, '★ 必须是"硬断言停手"，不是警告后继续');
    // ★ ② .lost 里 reason 固定串
    assert.equal(diag.lostReasons.includes('contract-violation'), true, '★ .lost 必须留 reason=contract-violation（可复算）');
    // ★ ③ 游标不许越过违约帧（停在帧2起点）
    let cur = null;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dataRoot, 'ledger', '.state.json'), 'utf8'));
      for (const [k, v] of Object.entries(st.sourceCursors || {})) if (k.endsWith(SID_A)) cur = v;
    } catch { /* ignore */ }
    if (cur) {
      assert.ok(Number(cur.offset) <= expectHalt, '★ 游标不许越过违约帧起点 ' + expectHalt + '（实际 ' + cur.offset + '）');
    }
    // ★ ④ 停手语义：不得"读了残片后继续"——turn 2 不许入账（它不是完整一轮）
    const read = readAll(dataRoot);
    const rows = read.ok ? read.records.filter((r) => r.sid === SID_A) : [];
    assert.equal(rows.filter((r) => r.turn === 2).length, 0, 'turn 2 不许因跨帧残片被当成完整轮落账');
  });
});

// ============================================================================
// B. 最后一帧半行 = 合法"截断尾" → 不判契约破坏
// ============================================================================
test('F-3/B（边界）：最后一帧不以换行结尾 = 截断尾，不判契约破坏（不许误报）', async () => {
  const header = JSON.stringify({ type: 'session', version: 3, id: SID_B, createdAt: T0, cwd: 'C:\\f3', agentPreset: 'f3' });
  const t1 = T0 + 1000;
  const f1 = [
    header,
    JSON.stringify({ type: 'turn/start', seq: 1, time: t1, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 2, time: t1 + 100, data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n') + '\n';
  const t2 = T0 + 2000;
  const half = JSON.stringify({ type: 'turn/start', seq: 3, time: t2, data: { turn: 2 } }).slice(0, 30);
  const buf = Buffer.concat([frame(f1), frame(half)]); // 最后一帧半行
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSession(dshHome, SID_B, buf);
    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
    const errText = [...(stat.errors || []), ...log.errors].join('\n');
    console.log('[f3-台账/B] ' + JSON.stringify({ contractViolations: stat.contractViolations, written: stat.written, hasContractErr: /帧=整行契约被破坏/.test(errText) }));
    assert.equal(Number(stat.contractViolations) || 0, 0, '★ 最后一帧半行是合法截断尾，不许判契约破坏');
    assert.equal(/帧=整行契约被破坏/.test(errText), false, '★ 不许误报契约破坏');
    assert.equal(stat.written >= 1, true, '截断尾之前的完整轮照常入账');
  });
});
