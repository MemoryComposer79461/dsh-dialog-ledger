/**
 * @file 自测-legacy.mjs
 * @role v3 只读历史源（lib/legacy.js）的验收：发现、选源、并存核验、未知版守卫。
 * @run `node --test docs/自测-legacy.mjs`
 *
 * @why 为什么必须造真的 zstd 帧：
 *      ledger.readTurnsFrom 在 fromByte=0 时要求首字节是 zstd 魔数，
 *      没有魔数会直接 `formatError='bad-magic@0'`（fail-closed，这是对的）。
 *      所以测试用 node 内置 `zlib.zstdCompressSync` 造单帧文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  scanSessionSources,
  readSourceTurns,
  readSourceTurnEvents,
  sourceFileName,
  auditPairs,
} from '../lib/legacy.js';

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';

/** 造一份会话目录：head + n 个完整的 turn（真 zstd 单帧）。 */
function makeSession(base, dirName, version, { id, createdAt, turns, extraEvents = [] }) {
  const dir = path.join(base, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let seq = 0;
  const t0 = createdAt;
  lines.push(JSON.stringify({ type: 'session', id, createdAt, version }));
  for (const ev of extraEvents) lines.push(JSON.stringify({ ...ev, seq: seq++ }));
  for (let t = 1; t <= turns; t++) {
    lines.push(JSON.stringify({ type: 'turn/start', seq: seq++, time: t0 + t * 1000, data: { turn: t } }));
    lines.push(JSON.stringify({
      type: 'user/message', seq: seq++, time: t0 + t * 1000 + 100,
      data: { content: [{ type: 'text', text: 'u' + t }], source: { kind: 'user' } },
    }));
    lines.push(JSON.stringify({ type: 'turn/end', seq: seq++, time: t0 + t * 1000 + 900, data: { turn: t, reason: { kind: 'completed' } } }));
  }
  const body = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const file = path.join(dir, `session.v${version}.jsonl.zstd`);
  fs.writeFileSync(file, HAS_ZSTD ? zlib.zstdCompressSync(body) : body);
  return { dir, file, lines: lines.length };
}

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-test-'));
}

test('legacy：v4 单独存在 → 选 v4', () => {
  const base = tmpBase();
  makeSession(base, 'session-aaaa-1111', 4, { id: 'session-aaaa-1111', createdAt: 1790000000000, turns: 2 });
  const r = scanSessionSources(base);
  assert.equal(r.supported.length, 1);
  assert.equal(r.supported[0].source, 'v4');
  assert.equal(r.supported[0].version, 4);
  assert.equal(r.supported[0].sid, 'session-aaaa-1111');
  assert.equal(r.pairs.length, 0);
  assert.equal(r.unsupported.length, 0);
});

test('legacy：v3 单独存在 → 纳入只读历史源，且轮次可读', () => {
  const base = tmpBase();
  const s = makeSession(base, 'bbbb-2222', 3, { id: 'bbbb-2222', createdAt: 1790000000000, turns: 3 });
  const r = scanSessionSources(base);
  assert.equal(r.supported.length, 1);
  assert.equal(r.supported[0].source, 'v3');
  assert.equal(r.supported[0].version, 3);
  // 目录名不以 session- 开头 → sid 为空，由调用方用 head.id 兜底
  assert.equal(r.supported[0].sid, '');
  assert.equal(sourceFileName(r.supported[0]), 'session.v3.jsonl.zstd');

  const turns = readSourceTurns(r.supported[0], { fromByte: 0 });
  assert.equal(turns.formatError, '');
  assert.equal(turns.head.id, 'bbbb-2222');
  assert.equal(turns.closed.length, 3);
  assert.deepEqual(turns.closed.map((t) => t.turn), [1, 2, 3]);

  const evs = readSourceTurnEvents(r.supported[0], new Set([2]));
  assert.ok(evs.get(2).length >= 3, 'turn 2 应取到 start/user/end 至少 3 条事件');
});

test('legacy：v3 与 v4 并存 → 只纳入 v4，并登记为并存资料', () => {
  const base = tmpBase();
  makeSession(base, 'session-cccc-3333', 3, { id: 'session-cccc-3333', createdAt: 1790000000000, turns: 2 });
  makeSession(base, 'session-cccc-3333', 4, { id: 'session-cccc-3333', createdAt: 1790000000000, turns: 5 });
  const r = scanSessionSources(base);
  assert.equal(r.supported.length, 1, '同一会话只能有一个历史源');
  assert.equal(r.supported[0].source, 'v4');
  assert.equal(r.pairs.length, 1);
  assert.match(r.pairs[0].note, /v3 与 v4 并存/);
  assert.equal(r.unsupported.length, 0);
});

test('legacy：并存核验 —— v4 是超集时 ok', () => {
  const base = tmpBase();
  const d = 'session-dddd-4444';
  makeSession(base, d, 3, { id: d, createdAt: 1790000000000, turns: 2 });
  makeSession(base, d, 4, { id: d, createdAt: 1790000000000, turns: 5 });
  const r = scanSessionSources(base);
  const audit = auditPairs(r.pairs);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].ok, true, audit[0].reason);
  assert.ok(audit[0].v4.events > audit[0].v3.events);
});

test('legacy：并存核验 —— v3 起点更早时必须报不通过（不许静默丢历史）', () => {
  const base = tmpBase();
  const d = 'session-eeee-5555';
  // v3 起点更早（createdAt 更小）
  makeSession(base, d, 3, { id: d, createdAt: 1789999990000, turns: 2 });
  makeSession(base, d, 4, { id: d, createdAt: 1790000000000, turns: 5 });
  const r = scanSessionSources(base);
  const audit = auditPairs(r.pairs);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].ok, false);
  assert.match(audit[0].reason, /起点更早/);
});

test('legacy：未知版本（v2）→ 进 unsupported，不静默吞掉', () => {
  const base = tmpBase();
  makeSession(base, 'ffff-6666', 2, { id: 'ffff-6666', createdAt: 1790000000000, turns: 1 });
  const r = scanSessionSources(base);
  assert.equal(r.supported.length, 0);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].version, 2);
});

test('legacy：空目录 / 不存在的根 → 三项都空', () => {
  const base = tmpBase();
  const r1 = scanSessionSources(base);
  assert.deepEqual([r1.supported.length, r1.pairs.length, r1.unsupported.length], [0, 0, 0]);
  const r2 = scanSessionSources(path.join(base, 'not-exist'));
  assert.deepEqual([r2.supported.length, r2.pairs.length, r2.unsupported.length], [0, 0, 0]);
});

test('legacy：返回值与旧 scanSessions 形状兼容（path/sid/s12/mtimeMs/size）', () => {
  const base = tmpBase();
  makeSession(base, 'session-gggg-7777', 4, { id: 'session-gggg-7777', createdAt: 1790000000000, turns: 1 });
  const e = scanSessionSources(base).supported[0];
  for (const k of ['path', 'sid', 's12', 'mtimeMs', 'size']) {
    assert.ok(Object.prototype.hasOwnProperty.call(e, k), '缺少兼容字段 ' + k);
  }
  assert.equal(typeof e.mtimeMs, 'number');
  assert.equal(typeof e.size, 'number');
});
