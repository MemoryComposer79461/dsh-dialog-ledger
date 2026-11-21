/**
 * @file 自测-shadow.mjs
 * @role V0.7 影子双轨单测：纯比对（runShadowOnce）、三态汇总、只写 `.shadow/`（R-01 守护）。
 *
 * 用法：node docs/跑测试.mjs docs/自测-shadow.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = await import(pathToFileURL(path.join(SRC, 'tools', 'shadow.js')).href);

function turnFn(turn, startMs, endMs, reason = 'completed') {
  return { turn, startMs, endMs, reason };
}

/** 假 disk collector：同步 list/read。 */
function fakeDisk(sessions) {
  return {
    kind: 'disk',
    listSessions: () => sessions.map((s) => ({ sid: s.sid, sessionId: s.sid, source: 'disk', path: '/x' })),
    readClosedTurns: (ref) => ({ turns: (sessions.find((s) => s.sid === ref.sid) || {}).turns || [], meta: {}, warnings: [] }),
  };
}

/** 假 persistence collector：同步 list/read（A 记录式），便于单测。 */
function fakeOther(sessions) {
  return {
    kind: 'persistence',
    listSessions: () => sessions.map((s) => ({ sid: s.sid, sessionId: s.sid, source: 'persistence', revision: 'r1' })),
    readClosedTurns: (ref) => ({ turns: (sessions.find((s) => s.sid === ref.sid) || {}).turns || [], nextCursor: { seq: 1 }, warnings: [] }),
  };
}

function treeHash(root) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.shadow') continue; // 影子目录是允许变化的部分
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { h.update('D:' + path.relative(root, p) + '\n'); walk(p); }
      else h.update('F:' + path.relative(root, p) + ':' + fs.readFileSync(p).toString('hex').slice(0, 32) + '\n');
    }
  };
  walk(root);
  return h.digest('hex');
}

test('V0.7 runShadowOnce：一致/缺轮/良性领先/另一源缺席 四类汇总正确', async () => {
  const now = 10_000_000;
  const disk = fakeDisk([
    { sid: 'a', turns: [turnFn(1, 1000, 2000)] },
    { sid: 'b', turns: [turnFn(1, 3000, 4000)] },
    { sid: 'c', turns: [turnFn(1, 5000, 6000)] },
  ]);
  const other = fakeOther([
    { sid: 'a', turns: [turnFn(1, 1000, 2000)] }, // 一致
    { sid: 'b', turns: [turnFn(1, 3000, 4000), turnFn(2, now - 5000, now - 4000)] }, // 良性领先
    { sid: 'c', turns: [turnFn(1, 5000, 7000)] }, // 边界不一致
  ]);
  const { records, summary, warnings, nextCursors } = await sh.runShadowOnce({ diskCollector: disk, otherCollector: other, now, pendingWindowMs: 120000 });
  assert.equal(summary.checked, 3);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.exactMatch, 2, 'a 一致 + b 良性领先（exactMatch 仍 true）');
  assert.equal(summary.diffCount, 1);
  assert.equal(summary.mismatched, 1);
  assert.equal(summary.pendingDurable, 1);
  assert.equal(nextCursors.get('a').seq, 1);
  assert.deepEqual(warnings, []);
  const recB = records.find((r) => r.sid === 'b');
  assert.deepEqual(recB.pendingDurable, [2]);
  assert.equal(recB.exactMatch, true);
});

test('V0.7 runShadowOnce：另一源缺失/抛错 → warnings 且不抛', async () => {
  const disk = fakeDisk([{ sid: 'a', turns: [turnFn(1, 1, 2)] }]);
  const badOther = {
    listSessions: () => [{ sid: 'a' }],
    readClosedTurns: () => { throw new Error('boom'); },
  };
  const r = await sh.runShadowOnce({ diskCollector: disk, otherCollector: badOther, now: 10_000 });
  assert.equal(r.records.length, 1);
  assert.ok(r.warnings.some((w) => w.startsWith('other-read:a:boom')));
  // 另一侧没有会话 → other-missing 警告，不抛
  const r2 = await sh.runShadowOnce({ diskCollector: disk, otherCollector: fakeOther([]) });
  assert.ok(r2.warnings.some((w) => w.startsWith('other-missing:a')));
  // collector 缺席
  assert.deepEqual((await sh.runShadowOnce({})).warnings, ['DISK_COLLECTOR_UNAVAILABLE']);
});

test('V0.7 writeShadowTick：只写 .shadow/（R-01：账本/原文/周账字节不变）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-shadow-'));
  const root = path.join(base, 'root');
  const ledger = path.join(root, 'ledger');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(ledger, '2026-11-10.jsonl'), '{"a":1}\n', 'utf8');
  fs.writeFileSync(path.join(ledger, '.reads.jsonl'), '{"read":1}\n', 'utf8');
  fs.mkdirSync(path.join(root, '2026年11月'), { recursive: true });
  fs.writeFileSync(path.join(root, '2026年11月', 'x.md'), '# original\n', 'utf8');
  const before = treeHash(root);

  const tick = {
    records: [
      { v: 1, sid: 'a', exactMatch: false, missingOnEvent: [], missingOnDisk: [2], mismatched: [], pendingDurable: [] },
      { v: 1, sid: 'b', exactMatch: true, missingOnEvent: [], missingOnDisk: [], mismatched: [], pendingDurable: [] },
    ],
    summary: { v: 1, at: 'x', checked: 2, sessions: 2, exactMatch: 1, diffCount: 1 },
  };
  const r1 = sh.writeShadowTick(root, tick);
  const r2 = sh.writeShadowTick(root, tick); // 二次调用：只追加、不改旧文件内容
  assert.equal(r1.ok, true);
  assert.equal(r1.appended, 1, '只追加"有差异"的会话行');
  assert.equal(r2.appended, 1);
  assert.equal(treeHash(root), before, '除 .shadow/ 外所有文件必须字节不变');
  // 文件名按 +08:00，用 fallback 匹配实际文件
  const files = fs.readdirSync(path.join(root, 'ledger', '.shadow'));
  const jsonl = files.find((n) => n.endsWith('.jsonl'));
  assert.ok(jsonl, '必须产生当日影子 JSONL');
  const lines = fs.readFileSync(path.join(root, 'ledger', '.shadow', jsonl), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, '两次调用只追加、不重复写 summary 记录');
  assert.ok(files.includes('summary.json'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('V0.7 writeShadowTick：无 root/不可写 → 降级返回 ok:false，不抛', () => {
  const r = sh.writeShadowTick('', { records: [], summary: null });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_ROOT');
});

test('V0.7 index.js：ingest.mode=shadow 时 tick 产生 .shadow/，且记账照常（端到端）', async () => {
  const zlib = await import('node:zlib');
  const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-shadow-int-'));
  const dshHome = path.join(base, 'dsh');
  const sessDir = path.join(dshHome, 'sessions', 'session-shadow1111-2222-3333-4444-555566667777');
  const root = path.join(base, 'root');
  fs.mkdirSync(sessDir, { recursive: true });
  const lines = [
    { type: 'session', id: 'session-shadow1111-2222-3333-4444-555566667777', time: 1 },
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((x) => JSON.stringify(x));
  fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));

  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined; },
    effect(fn) { const d = fn(); effects.push(d); return d; },
  };
  try {
    idx.apply(ctx, { root, intervalSeconds: 3600, enabled: true, ingest: { mode: 'shadow', shadowPendingMs: 120000, shadowMaxSessions: 5 } });
    const deadline = Date.now() + 5000;
    const summaryPath = path.join(root, 'ledger', '.shadow', 'summary.json');
    while (Date.now() < deadline && !fs.existsSync(summaryPath)) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(summaryPath), 'shadow 模式必须产出 .shadow/summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.equal(summary.v, 1);
    assert.ok(Array.isArray(summary.warnings));
    // 记账照常：ledger/2026-11-10.jsonl 被 runOnce 正常写出（不因 shadow 受影响）
    const dayFile = fs.readdirSync(path.join(root, 'ledger')).find((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    assert.ok(dayFile, '记账主路径必须照常写账');
  } finally {
    for (const d of effects.slice().reverse()) if (typeof d === 'function') { try { d(); } catch { /* ignore */ } }
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('V0.7 R-06：默认 ingest.mode=disk 时完全不跑影子（无 .shadow/，记账照旧）', async () => {
  const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-shadow-off-'));
  const root = path.join(base, 'root');
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined; },
    effect(fn) { const d = fn(); effects.push(d); return d; },
  };
  try {
    idx.apply(ctx, { root, intervalSeconds: 3600, enabled: true }); // 不传 ingest → 默认 disk
    await new Promise((r) => setTimeout(r, 400));
    const ledgerDir = path.join(root, 'ledger');
    if (fs.existsSync(ledgerDir)) {
      assert.equal(fs.existsSync(path.join(ledgerDir, '.shadow')), false, 'disk 模式绝不允许产生影子目录');
    }
  } finally {
    for (const d of effects.slice().reverse()) if (typeof d === 'function') { try { d(); } catch { /* ignore */ } }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('V0.7 R-02：一致率口径 = exactMatch/checked，pendingDurable 不算差异', async () => {
  const now = 10_000_000;
  const disk = fakeDisk([
    { sid: 's1', turns: [turnFn(1, 1, 2)] },
    { sid: 's2', turns: [turnFn(1, 3, 4)] },
    { sid: 's3', turns: [turnFn(1, 5, 6)] },
    { sid: 's4', turns: [turnFn(1, 7, 8)] },
  ]);
  const other = fakeOther([
    { sid: 's1', turns: [turnFn(1, 1, 2)] },
    { sid: 's2', turns: [turnFn(1, 3, 4), turnFn(2, now - 1000, now - 500)] },
    { sid: 's3', turns: [turnFn(1, 5, 9)] },
    { sid: 's4', turns: [] },
  ]);
  const { summary } = await sh.runShadowOnce({ diskCollector: disk, otherCollector: other, now, pendingWindowMs: 120000 });
  assert.equal(summary.checked, 4);
  assert.equal(summary.exactMatch, 2, 's1 一致 + s2 良性领先');
  assert.equal(summary.diffCount, 2, 's3 指纹不一致 + s4 缺轮');
  const rate = summary.exactMatch / summary.checked;
  assert.equal(rate, 0.5);
});

test('V0.7 R-04：连续 3 轮 collector 抛错都只产生 warnings，不抛（影子不得拖垮记账）', async () => {
  const flaky = {
    kind: 'persistence',
    listSessions: () => { throw new Error('list-boom'); },
    readClosedTurns: () => { throw new Error('read-boom'); },
  };
  const disk = fakeDisk([{ sid: 's1', turns: [turnFn(1, 1, 2)] }]);
  for (let round = 1; round <= 3; round += 1) {
    const r = await sh.runShadowOnce({ diskCollector: disk, otherCollector: flaky, now: 1000 });
    assert.ok(r.warnings.some((w) => w.startsWith('other-list:list-boom')), 'round ' + round + ' 必须记录 list 异常');
    assert.equal(r.records.length, 1);
  }
});

test('V0.7 R-07：另一源缺轮时可在影子里显式看见 missingOnEvent（disk 兜底前提）', async () => {
  const disk = fakeDisk([{ sid: 's1', turns: [turnFn(1, 1, 2), turnFn(2, 3, 4)] }]);
  const other = fakeOther([{ sid: 's1', turns: [turnFn(1, 1, 2)] }]); // 漏了 turn2
  const { records } = await sh.runShadowOnce({ diskCollector: disk, otherCollector: other, now: 10_000 });
  assert.deepEqual(records[0].missingOnEvent, [2]);
  assert.equal(records[0].exactMatch, false);
});

test('V0.7 R-08：maxSessions 生效且 elapsedMs 有值（影子成本有界）', async () => {
  const many = [];
  for (let i = 0; i < 100; i += 1) many.push({ sid: 'session-' + i, turns: [turnFn(1, 1, 2)] });
  const disk = fakeDisk(many);
  const other = fakeOther(many);
  const { summary } = await sh.runShadowOnce({ diskCollector: disk, otherCollector: other, now: 10_000, maxSessions: 5 });
  assert.equal(summary.checked, 5, '单轮最多比 maxSessions 个会话');
  assert.equal(typeof summary.elapsedMs, 'number');
  assert.ok(summary.elapsedMs >= 0);
});

test('V0.7 R-10：影子证据可离线复核（report.md + JSONL 可解析、含 fpVersion）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-shadow-r10-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  const summary = { v: 1, at: '2026-11-10T00:00:00Z', checked: 2, sessions: 2, exactMatch: 1, diffCount: 1, missingOnEvent: 1, missingOnDisk: 0, mismatched: 0, pendingDurable: 0, warnings: [], elapsedMs: 3 };
  const records = [
    { v: 1, at: 'x', sid: 'a', fpVersion: 1, diskCount: 2, eventCount: 1, exactMatch: false, missingOnEvent: [2], missingOnDisk: [], mismatched: [], pendingDurable: [] },
    { v: 1, at: 'x', sid: 'b', fpVersion: 1, diskCount: 1, eventCount: 1, exactMatch: true, missingOnEvent: [], missingOnDisk: [], mismatched: [], pendingDurable: [] },
  ];
  const wr = sh.writeShadowTick(root, { records, summary }, { dateStr: '2026-11-10' });
  assert.equal(wr.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'ledger', '.shadow', 'report.md')), '必须产出人读报表');
  const report = fs.readFileSync(path.join(root, 'ledger', '.shadow', 'report.md'), 'utf8');
  assert.ok(report.includes('影子双轨报表'));
  assert.ok(report.includes('a'));
  assert.ok(report.includes('R-03'), '报表必须声明 R-03 口径');
  const jsonl = fs.readFileSync(path.join(root, 'ledger', '.shadow', '2026-11-10.jsonl'), 'utf8').trim().split('\n');
  assert.equal(jsonl.length, 1, '只追加有差异会话');
  const row = JSON.parse(jsonl[0]);
  assert.equal(row.fpVersion, 1);
  assert.deepEqual(row.missingOnEvent, [2]);
  const sum = JSON.parse(fs.readFileSync(path.join(root, 'ledger', '.shadow', 'summary.json'), 'utf8'));
  assert.equal(sum.checked, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test('V0.7 R-08 性能：影子单会话开销远低于 200ms 阈值（P95 口径近似）', async () => {
  // 守：tick 里影子不得成为记账负担。用 200 会话 × 每轮小数据，跑 5 轮取总耗时/会话数。
  const sessions = [];
  for (let i = 0; i < 200; i += 1) {
    sessions.push({ sid: 'session-' + i, turns: [turnFn(1, i * 10, i * 10 + 5), turnFn(2, i * 10 + 6, i * 10 + 9)] });
  }
  const disk = fakeDisk(sessions);
  const other = fakeOther(sessions);
  const rounds = 5;
  const start = Date.now();
  let checked = 0;
  for (let r = 0; r < rounds; r += 1) {
    const out = await sh.runShadowOnce({ diskCollector: disk, otherCollector: other, now: 1_000_000, pendingWindowMs: 120000, maxSessions: 200 });
    checked += out.summary.checked;
  }
  const perSession = (Date.now() - start) / Math.max(1, checked);
  assert.ok(perSession < 200, '影子每会话开销必须 < 200ms（实际 ' + perSession.toFixed(2) + 'ms）');
});

test('V0.7 R-02b：持久层增量读 + 会话级累积 → 第二轮仍与磁盘全量一致（防 57 条假差异回归）', async () => {
  const allTurns = [turnFn(1, 1000, 2000), turnFn(2, 3000, 4000)];
  const disk = fakeDisk([{ sid: 'a', turns: allTurns }]);
  let seqCursor = 0;
  const incremental = {
    kind: 'persistence',
    listSessions: () => [{ sid: 'a', sessionId: 'a', source: 'persistence' }],
    // 模拟真机：read(cursor=seq) 只返回该 seq 之后的轮次；首次 cursor={} 返回全部
    readClosedTurns: (ref, cursor) => {
      const from = cursor && Number.isInteger(cursor.seq) ? cursor.seq : 0;
      const fresh = allTurns.slice(from);
      return { turns: fresh, nextCursor: { seq: from + fresh.length }, warnings: [] };
    },
  };
  const first = await sh.runShadowOnce({ diskCollector: disk, otherCollector: incremental, now: 1_000_000 });
  assert.equal(first.summary.exactMatch, 1, '首轮全量读应一致');
  const accum = first.nextAccum;
  const cursors = first.nextCursors;
  assert.equal(cursors.get('a').seq, 2);
  // 第二轮：只返回增量（空）→ 累积表必须保住历史轮，否则会报 missingOnEvent
  const second = await sh.runShadowOnce({ diskCollector: disk, otherCollector: incremental, cursors, accum, now: 1_000_000 });
  assert.equal(second.records[0].eventCount, 2, '累积表必须保留已见轮次');
  assert.equal(second.summary.exactMatch, 1, '第二轮不得把历史轮算成缺失（real bug 回归）');
  assert.deepEqual(second.records[0].missingOnEvent, []);
});
test('R-05：shadow 配置下连续两轮 runOnce 不重复落账（第二轮 written=0）', async () => {
  const L = await import(pathToFileURL(path.join(SRC, 'docs', '验收-v0.5', '_lab.mjs')).href);
  const lab = L.mkLab('shadow-r05');
  try {
    L.writeSession(lab, { events: [...L.sessionHeader(lab.sid), ...L.simpleTurn(1, L.T0())] });
    const cfg = { ingest: { mode: 'shadow' }, weeklyEnabled: false, handoverEnabled: false };
    const r1 = await L.runOnce(SRC, lab, cfg);
    assert.equal(r1.stat.written, 1);
    const r2 = await L.runOnce(SRC, lab, cfg);
    assert.equal(r2.stat.written, 0, '同会话同轮不得重复落账（第二轮 written 必须 0）');
    assert.equal(r2.stat.errors.length, 0);
  } finally { L.rmLab(lab); }
});

test('R-09：ingest 模式切换不改账（disk 跑过后切 shadow，台账行数不变、只多影子运行区）', async () => {
  const L = await import(pathToFileURL(path.join(SRC, 'docs', '验收-v0.5', '_lab.mjs')).href);
  const lab = L.mkLab('shadow-r09');
  try {
    L.writeSession(lab, { events: [...L.sessionHeader(lab.sid), ...L.simpleTurn(1, L.T0())] });
    const diskCfg = { ingest: { mode: 'disk' }, weeklyEnabled: false, handoverEnabled: false };
    const a = await L.runOnce(SRC, lab, diskCfg);
    assert.equal(a.stat.written, 1);
    const rowsBefore = (await L.readLedger(SRC, lab.root)).records.length;
    const shadowCfg = { ingest: { mode: 'shadow' }, weeklyEnabled: false, handoverEnabled: false };
    const b = await L.runOnce(SRC, lab, shadowCfg);
    const rowsAfter = (await L.readLedger(SRC, lab.root)).records.length;
    assert.equal(b.stat.written, 0);
    assert.equal(rowsAfter, rowsBefore, '切 shadow 不得改动台账行数');
    // runOnce 层不调度影子（影子在 apply 的 tick 里）；本用例只证"ingest 配置不改变记账结果"。
    const c = await L.runOnce(SRC, lab, { ingest: { mode: 'disk' }, weeklyEnabled: false, handoverEnabled: false });
    assert.equal(c.stat.written, 0);
    assert.equal((await L.readLedger(SRC, lab.root)).records.length, rowsBefore, '回退 disk 后账仍未变');
  } finally { L.rmLab(lab); }
});
