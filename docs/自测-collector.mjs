/**
 * @file 自测-collector.mjs
 * @role V0.7 采集适配层单测：disk collector 只读、与现有扫描同源；影子比对/指纹/汇总正确。
 *
 * 用法：node docs/跑测试.mjs docs/自测-collector.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const col = await import(pathToFileURL(path.join(SRC, 'lib', 'collector.js')).href);

/** 合成一个 v4 会话文件（单帧 zstd；readTurnsFrom 可读）。 */
function writeSession(dir, sid, frames) {
  const sessDir = path.join(dir, sid);
  fs.mkdirSync(sessDir, { recursive: true });
  const lines = [
    { type: 'session', id: sid, time: 1 },
    ...frames,
  ].map((x) => JSON.stringify(x));
  const buf = zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), buf);
  return sessDir;
}

function turn(turnNo, startMs, endMs, reason = 'completed') {
  return [
    { type: 'turn/start', data: { turn: turnNo }, time: startMs },
    { type: 'turn/end', data: { turn: turnNo }, time: endMs, reason },
  ];
}

/** 目录树 sha256（证明只读/没写）。 */
function treeHash(root) {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { hash.update('D:' + path.relative(root, p) + '\n'); walk(p); }
      else { hash.update('F:' + path.relative(root, p) + ':' + st.size + ':' + fs.readFileSync(p).toString('hex').slice(0, 32) + '\n'); }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-col-'));
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return Promise.resolve(fn({ base, sessions })).finally(() => fs.rmSync(base, { recursive: true, force: true }));
}

test('disk collector：列出会话、读闭合轮次，且全程只读（目录树哈希不变）', async () => {
  await withLab(({ sessions }) => {
    writeSession(sessions, 'session-aaaa1111-2222-3333-4444-555566667777', turn(1, 1000, 2000));
    writeSession(sessions, 'session-bbbb1111-2222-3333-4444-555566667777', [...turn(1, 3000, 4000), ...turn(2, 5000, 6000)]);
    const collector = col.createDiskCollector({ sessionsBase: sessions });
    assert.equal(collector.kind, 'disk');

    const before = treeHash(sessions);
    const list = collector.listSessions();
    assert.equal(list.length, 2);
    assert.ok(list.every((e) => /^[0-9a-f-]{36}$/.test(e.sid)), 'sid 必须归一为 uuid（去 session- 前缀），便于双轨对齐: ' + JSON.stringify(list.map((x) => x.sid)));
    assert.ok(list.every((e) => e.version === 4));

    const entry = list.find((e) => e.sid.includes('bbbb'));
    const { turns, meta, warnings } = collector.readClosedTurns(entry);
    assert.deepEqual(turns.map((t) => t.turn), [1, 2]);
    assert.equal(turns[0].startMs, 3000);
    assert.equal(turns[1].endMs, 6000);
    assert.ok(meta.frames >= 1);
    assert.deepEqual(warnings, []);
    assert.equal(treeHash(sessions), before, 'collector 不得写/改任何文件');
  });
});

test('V0.7 normalizeSid：路径/session- 前缀/裸 uuid 统一口径', () => {
  assert.equal(col.normalizeSid('session-dee34b23-59f7-46a2-9036-80'), 'dee34b23-59f7-46a2-9036-80');
  assert.equal(col.normalizeSid('D:\\x\\sessions\\--D-~6D4B~8BD5--\\dee34b23-59f7-46a2-9036-80'), 'dee34b23-59f7-46a2-9036-80');
  assert.equal(col.normalizeSid('dee34b23-59f7-46a2-9036-80'), 'dee34b23-59f7-46a2-9036-80');
  assert.equal(col.normalizeSid(''), '');
});

test('指纹：同会话同轮边界稳定；字段不同则指纹不同；换 sid 也不同', () => {
  const sid = 'session-aaaa';
  const t = { turn: 1, startMs: 1000, endMs: 2000, reason: 'completed' };
  const a = col.turnFingerprint(sid, t);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(col.turnFingerprint(sid, { ...t }), a);
  assert.notEqual(col.turnFingerprint(sid, { ...t, endMs: 2001 }), a);
  assert.notEqual(col.turnFingerprint(sid, { ...t, reason: 'abandoned' }), a);
  assert.notEqual(col.turnFingerprint('session-bbbb', t), a);
  const map = col.fingerprintTurns(sid, [t, { turn: 2, startMs: 3000, endMs: 4000 }]);
  assert.equal(map.size, 2);
  assert.equal(map.get(1), a);
});

test('compareTurnSets：完全一致 / 缺轮 / 多轮 / 边界不一致 四类都能判', () => {
  const d = [
    { turn: 1, startMs: 1000, endMs: 2000, reason: 'completed' },
    { turn: 2, startMs: 3000, endMs: 4000, reason: 'completed' },
  ];
  const e = [
    { turn: 1, startMs: 1000, endMs: 2000, reason: 'completed' },
    { turn: 2, startMs: 3000, endMs: 4001, reason: 'completed' },
  ];
  const same = col.compareTurnSets('session-x', d, d);
  assert.equal(same.exactMatch, true);
  assert.deepEqual(same.missingOnEvent, []);
  assert.deepEqual(same.mismatched, []);

  const diff = col.compareTurnSets('session-x', d, e);
  assert.equal(diff.exactMatch, false);
  assert.deepEqual(diff.missingOnEvent, []);
  assert.deepEqual(diff.missingOnDisk, []);
  assert.equal(diff.mismatched.length, 1);
  assert.equal(diff.mismatched[0].turn, 2);

  const miss = col.compareTurnSets('session-x', d, [d[0]]);
  assert.deepEqual(miss.missingOnEvent, [2]);
  const extra = col.compareTurnSets('session-x', [d[0]], d);
  assert.deepEqual(extra.missingOnDisk, [2]);
});

test('diffSummary + shadowRecord：汇总与 JSONL 行形状正确', () => {
  const d = [{ turn: 1, startMs: 1, endMs: 2, reason: 'completed' }];
  const r1 = col.compareTurnSets('session-a', d, d);
  const r2 = col.compareTurnSets('session-b', d, []);
  const sum = col.diffSummary([r1, r2]);
  assert.equal(sum.sessions, 2);
  assert.equal(sum.exactMatch, 1);
  assert.equal(sum.diffCount, 1);
  assert.deepEqual(sum.diffSessions, [{ sid: 'session-b', missingOnEvent: 1, missingOnDisk: 0, mismatched: 0, pendingDurable: 0 }]);

  const rec = col.shadowRecord({ at: '2026-11-10T20:00:00+08:00', sid: 'session-a', diskTurns: d, eventTurns: d });
  assert.equal(rec.v, 1);
  assert.equal(rec.fpVersion, col.TURN_FP_VERSION);
  assert.equal(rec.exactMatch, true);
  assert.equal(JSON.parse(JSON.stringify(rec)).sid, 'session-a');
});

test('V0.7 closedTurnsFromEvents：闭合/放弃/坏事件/reason 口径与 disk 规则一致', () => {
  const ev = (type, turn, time, reason) => {
    const e = { type, time, data: { turn } };
    if (reason !== undefined) e.data.reason = { kind: reason };
    return e;
  };
  const r = col.closedTurnsFromEvents([
    ev('turn/start', 1, 1000),
    ev('turn/end', 1, 2000, 'completed'),
    ev('turn/start', 2, 3000),
    ev('turn/start', 3, 4000),          // 2 未闭合被 3 顶掉 → abandoned
    { type: 'turn/start', time: 0, data: { turn: 4 } }, // 坏事件
    ev('turn/end', 3, 5000, 'aborted'),
  ]);
  assert.deepEqual(r.turns.map((t) => [t.turn, t.reason]), [[1, 'completed'], [2, 'abandoned'], [3, 'aborted']]);
  assert.equal(r.turns[2].startMs, 4000);
  assert.equal(r.turns[2].endMs, 5000);
  assert.equal(r.malformed, 1);
  assert.equal(r.abandoned, 1);
  assert.equal(r.open, null);
});

test('V0.7 createPersistenceCollector：list + open/read(seq) 增量、EOF、关闭句柄、只读', async () => {
  const pages = [
    [
      { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
      { seq: 1, type: 'turn/end', time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 2, type: 'turn/start', time: 3000, data: { turn: 2 } },
    ],
    [
      { seq: 3, type: 'turn/end', time: 4000, data: { turn: 2, reason: { kind: 'completed' } } },
    ],
  ];
  let closed = 0;
  const host = {
    sessionPersistence: {
      async list() { return [{ header: { id: 'session-p1', version: 4 }, formatStatus: 'ok', revision: 'rev-1', sizeBytes: 42, location: { kind: 'jsonl', path: 'C:/x/session.v4.jsonl' } }]; },
      async open(sid, mode) {
        assert.equal(sid, 'session-p1');
        assert.equal(mode, 'read', '只读打开');
        return {
          async read(seq, limit) {
            assert.equal(limit, 2, '按 limit 分批');
            const flat = pages.flat();
            const startIdx = flat.findIndex((e) => e.seq >= seq);
            if (startIdx < 0) return { eventState: 'shared-frozen', events: [] };
            return { eventState: 'shared-frozen', events: flat.slice(startIdx, startIdx + limit) };
          },
          async close() { closed += 1; },
        };
      },
    },
  };
  const collector = col.createPersistenceCollector({ host, batchLimit: 2 });
  assert.equal(collector.kind, 'persistence');
  assert.equal(collector.available, true);
  const list = await collector.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'persistence');
  assert.equal(list[0].revision, 'rev-1');
  assert.equal(list[0].sizeBytes, 42, 'sizeBytes 归一');

  const batch = await collector.readClosedTurns(list[0], { seq: 0 });
  assert.deepEqual(batch.turns.map((t) => [t.turn, t.startMs, t.endMs, t.reason]), [[1, 1000, 2000, 'completed'], [2, 3000, 4000, 'completed']]);
  assert.equal(batch.nextCursor.seq, 4);
  assert.deepEqual(batch.warnings, []);
  assert.equal(batch.bootstrap, 'done');
  assert.equal(batch.eventState, 'shared-frozen', 'read 的 eventState 必须透传（真机是状态串）');
  assert.equal(closed, 1, '必须关闭句柄');

  // 从游标续读：EOF → 空 turns、游标不变
  const again = await collector.readClosedTurns(list[0], batch.nextCursor);
  assert.deepEqual(again.turns, []);
  assert.equal(again.nextCursor.seq, 4);
});

test('V0.7 persistence collector：失败降级不抛（open 抛错 / API 缺席 / 无 read）', async () => {
  const throwHost = { sessionPersistence: { async list() { return [{ sessionId: 's' }]; }, async open() { throw new Error('boom'); } } };
  const c1 = col.createPersistenceCollector({ host: throwHost });
  const b1 = await c1.readClosedTurns({ sessionId: 's' }, { seq: 0 });
  assert.deepEqual(b1.turns, []);
  assert.ok(b1.warnings.some((w) => w.startsWith('read:boom')));
  assert.equal(b1.bootstrap, 'needed');

  const none = col.createPersistenceCollector({ host: {} });
  assert.equal(none.available, false);
  assert.deepEqual(await none.listSessions(), []);
  const b2 = await none.readClosedTurns({ sessionId: 's' });
  assert.ok(b2.warnings.includes('PERSISTENCE_UNAVAILABLE'));

  const noRead = col.createPersistenceCollector({ host: { sessionPersistence: { async list() { return []; }, async open() { return {}; } } } });
  const b3 = await noRead.readClosedTurns({ sessionId: 's' });
  assert.ok(b3.warnings.includes('PERSISTENCE_NO_READ'));
});

test('V0.7 compareTurnSets 三态：事件领先未 flush → pendingDurable（良性），超窗才 missingOnDisk', () => {
  const disk = [{ turn: 1, startMs: 1000, endMs: 2000, reason: 'completed' }];
  const now = 10_000_000;
  const eventFresh = [...disk, { turn: 2, startMs: now - 5000, endMs: now - 4000, reason: 'completed' }];
  const fresh = col.compareTurnSets('sid', disk, eventFresh, { now, pendingWindowMs: 120000 });
  assert.equal(fresh.exactMatch, true, '事件领先但未 flush 不应算差异');
  assert.deepEqual(fresh.pendingDurable, [2]);
  assert.deepEqual(fresh.missingOnDisk, []);
  assert.equal(col.diffSummary([fresh]).pendingDurable, 1);

  const eventStale = [...disk, { turn: 3, startMs: now - 10 * 60_000, endMs: now - 9 * 60_000, reason: 'completed' }];
  const stale = col.compareTurnSets('sid', disk, eventStale, { now, pendingWindowMs: 120000 });
  assert.equal(stale.exactMatch, false);
  assert.deepEqual(stale.missingOnDisk, [3], '超出 pending 窗口要算真差异');

  const strict = col.compareTurnSets('sid', disk, eventFresh); // 默认 pendingWindowMs=0 → 严格
  assert.equal(strict.exactMatch, false);
  assert.deepEqual(strict.missingOnDisk, [2]);

  const rec = col.shadowRecord({ at: 'x', sid: 'sid', diskTurns: disk, eventTurns: eventFresh, now, pendingWindowMs: 120000 });
  assert.deepEqual(rec.pendingDurable, [2]);
  assert.equal(rec.exactMatch, true);
});

test('V0.7 persistence collector：read 返回无 seq 事件 → SEQ_MISSING 且不死循环（真机防御）', async () => {
  const host = {
    sessionPersistence: {
      async list() { return [{ header: { id: 'session-noseq' }, revision: 'r' }]; },
      async open() {
        return {
          async read(seq, limit) { return { eventState: 'live', events: [{ type: 'turn/start', time: 1, data: { turn: 1 } }] }; },
          async close() {},
        };
      },
    },
  };
  const c = col.createPersistenceCollector({ host, batchLimit: 1 });
  const b = await c.readClosedTurns({ sessionId: 'session-noseq' }, { seq: 0 });
  assert.ok(b.warnings.includes('SEQ_MISSING'));
  assert.equal(b.eventState, 'live');
  assert.deepEqual(b.turns, []);
});