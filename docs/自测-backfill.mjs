/**
 * @file 自测-backfill.mjs
 * @role v0.5 补记链只读计划（tools/backfill.js）+ 交接表 P1-7 幂等入口（freeze/handover.js: ensureHandover）自测。
 *
 * 契约依据（最终版）：
 *   · `契约-v0.5/v0.5-契约决定记录.md` D2/D3/D4（补记链）、D9（坏 sid/缺 head → errors+fingerprint）、
 *     D10（pending-only `.pending.jsonl`；无 supersede；历史 partial 只读进 `legacyPartials`）、
 *     D12/D15（唯一封板 journal `ledger/.seal-journal.jsonl` + 唯一实现 `lib/sealjournal.js`；
 *     手交表事件 kind `handover-seal`、扁平字段、`gid:null`）、D13（溢出先补记）。
 *   · `契约-v0.5/v0.5-验收清单.md` §4：BC-03/04/05/07/08/09/10/13/15。
 *
 * 纪律：只用临时目录 + 合成小会话（≤几 KB），禁止 38MB 夹具；不写真实账库。
 * @run
 *   & "<build-host>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
 *     --test "docs/自测-backfill.mjs"
 *   （cwd = <test-dir>\work\v0.5-工作副本；跑前打印可用内存）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = await import(pathToFileURL(path.join(SRC, 'tools', 'backfill.js')).href);
const H = await import(pathToFileURL(path.join(SRC, 'freeze', 'handover.js')).href);
const E = await import(pathToFileURL(path.join(SRC, 'lib', 'encoder.js')).href);
const WK = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);
const WEEK = await import(pathToFileURL(path.join(SRC, 'lib', 'week.js')).href);
const SJ = await import(pathToFileURL(path.join(SRC, 'lib', 'sealjournal.js')).href);
const L = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);
// V0.6.2 布局：交接表写 `<root>/交接表/`；读端双路径（新目录优先、一级兜底）。
const layout = await import(pathToFileURL(path.join(SRC, 'lib', 'layout.js')).href);
const HANDOVER_SUB = layout.SUBDIR.handover;
const handoverPath = (root, name, kind = layout.FILE_KIND.HANDOVER_MAIN) =>
  layout.newLayoutPath(root, kind, name);
const handoverExisting = (root, name, kind = layout.FILE_KIND.HANDOVER_MAIN) =>
  layout.resolveExisting(root, kind, name);

const NOW = Date.parse('2026-11-15T18:00:00+08:00'); // 周日晚：密封周(11-09~11-15)内可同时构造窗口内/外行
const HOUR = 3600 * 1000;
const KEY = 'aaaaaaaaaaaaA';
const SID_A = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SID_B = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// 临时目录 / 合成素材
// ---------------------------------------------------------------------------

function makeRoot(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `bf-${label}-`)); }
function dispose(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function touch(file, ms) { fs.utimesSync(file, new Date(ms), new Date(ms)); }

/** 合成 v4/v3 会话文件（zstd 单帧；readTurnsFrom 可读）。 */
function writeSession(sessionsBase, { sid, turns, createdAt = NOW - 6 * HOUR, version = 4, mtimeMs, headPatch }) {
  const dir = path.join(sessionsBase, '--test--', sid);
  mkdirp(dir);
  const head = { type: 'session', version, id: sid, createdAt };
  if (headPatch && typeof headPatch === 'object') Object.assign(head, headPatch);
  const lines = [JSON.stringify(head)];
  let seq = 0;
  for (const t of turns) {
    lines.push(JSON.stringify({ type: 'turn/start', seq: ++seq, time: t.startMs, data: { turn: t.turn } }));
    lines.push(JSON.stringify({
      type: 'turn/end', seq: ++seq, time: t.endMs || (t.startMs + 500),
      data: { turn: t.turn, reason: { kind: t.reason || 'completed' } },
    }));
  }
  const file = path.join(dir, `session.v${version}.jsonl.zstd`);
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return { file, dir, sid };
}

function codeOf(tsMs, seq, opts = {}) {
  return E.makeCode({ date: E.dateSegment(tsMs, 480), s12: opts.s12 || 'aaaaaaaaaaaa', gen: opts.gen || 'A', seq });
}

function recordOf({ tsMs, seq, turn, sid = SID_A, status = 'ok', late, lateReason, s12 }) {
  const rec = { v: 3, code: codeOf(tsMs, seq, { s12 }), ts: E.isoTime(tsMs, 480), sid, turn, seq, status };
  if (late !== undefined) rec.late = late;
  if (lateReason !== undefined) rec.lateReason = lateReason;
  return rec;
}

function writeLedger(root, records) {
  mkdirp(path.join(root, 'ledger'));
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(path.join(root, 'ledger', '2026-11-09.jsonl'), lines + (lines ? '\n' : ''), 'utf8');
}

function gidOf(tsMs, sessKey = KEY) {
  return WK.groupId(WEEK.weekOf(tsMs, 480), sessKey);
}

/** 用唯一写者 `lib/sealjournal.js` 追加一条周封板 journal 行（D12/D15 形状）。 */
function sealWeekly(root, { gid, rows, supplementCodes = [], sealedAt = '2026-11-09 10:00:00', sealHash = 'a'.repeat(64) }) {
  const codes = rows.map((r) => (Array.isArray(r) ? r[0] : r));
  const r = SJ.appendSealEvent(root, {
    kind: 'weekly-seal',
    key: gid,
    gid,
    file: '2026年11月/11月第2周-aaaaaaaaaaaaA的周记账.xlsx',
    sealedAt,
    layoutVersion: 6,
    canonicalVersion: SJ.CANONICAL_VERSION,
    sourceRowCount: codes.length + supplementCodes.length,
    overflow: supplementCodes.length,
    rows: rows.map((c, i) => (Array.isArray(c) ? c : [c, '绑定', '09:' + String(i).padStart(2, '0'), '已完成'])),
    supplement: { file: supplementCodes.length ? '补记-20261109.md' : '', sha256: '', codes: supplementCodes },
    sealHash,
  });
  assert.equal(r.ok, true, 'journal 写入失败：' + JSON.stringify(r));
  return r;
}

/** 追加一条 pending 证据（D10 单文件）。 */
function writePending(root, { sid, turn, startMs = NOW - HOUR, state = 'pending' }) {
  mkdirp(path.join(root, 'ledger'));
  const rec = {
    v: 1, state, sid, turn, startMs,
    firstSeenAt: '2026-11-09 16:00:00', lastSeenAt: '2026-11-09 17:00:00',
    source: 'C:\\Users\\x\\.dsh\\sessions\\--test--\\' + sid + '\\session.v4.jsonl.zstd',
    sourceSize: 1234, startByte: 0,
  };
  fs.appendFileSync(path.join(root, 'ledger', '.pending.jsonl'), JSON.stringify(rec) + '\n');
}

/** 目录快照（证明计划只读）。 */
function treeSnapshot(root) {
  const out = [];
  (function walk(dir) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { out.push({ p: path.relative(root, p), dir: true }); walk(p); } else {
        const st = fs.statSync(p);
        out.push({ p: path.relative(root, p), size: st.size, sha: sha256(fs.readFileSync(p)) });
      }
    }
  })(root);
  return out;
}

const T_SEALED = NOW - 4 * 24 * HOUR;  // 已封板周内的轮次时间（较早周）
const T_NEW_IN = NOW - 2 * HOUR;       // 3 天内（窗口内）
const T_NEW_OUT = NOW - 100 * HOUR;    // 窗口外

function sealFixture() {
  const sealedRecs = [
    recordOf({ tsMs: T_SEALED, seq: 1, turn: 1 }),
    recordOf({ tsMs: T_SEALED + 10 * 60 * 1000, seq: 2, turn: 2 }),
  ];
  const newIn = recordOf({ tsMs: T_NEW_IN, seq: 3, turn: 3, late: true, lateReason: '24h-scan' });
  const newOut = recordOf({ tsMs: T_NEW_OUT, seq: 4, turn: 4 });
  return { gid: gidOf(T_NEW_IN), sealedRecs, newIn, newOut, records: [...sealedRecs, newIn, newOut] };
}

// ===========================================================================
// 一、scanRecentlyChanged（BC-03）
// ===========================================================================

test('BC-03 24h 窗口：只返回 mtime ∈ [now-24h, now] 的源；窗口外/未来 mtime 不进；同输入同输出', () => {
  const base = makeRoot('scan');
  try {
    const sessions = path.join(base, 'sessions');
    const recent = writeSession(sessions, { sid: SID_A, turns: [{ turn: 1, startMs: NOW - HOUR }], mtimeMs: NOW - HOUR });
    writeSession(sessions, { sid: SID_B, turns: [{ turn: 1, startMs: NOW - 30 * HOUR }], mtimeMs: NOW - 25 * HOUR });
    const future = writeSession(sessions, {
      sid: 'session-cccccccc-cccc-cccc-cccc-cccccccccccc',
      turns: [{ turn: 1, startMs: NOW - HOUR }], mtimeMs: NOW + 60 * 1000,
    });
    const problems = [];
    const stats = {};
    const entries = B.scanRecentlyChanged(sessions, { windowMs: 24 * HOUR, nowMs: NOW, problems, stats });
    assert.deepEqual(entries.map((e) => path.basename(e.dir)), [SID_A]);
    assert.equal(stats.total, 3);
    assert.equal(stats.matched, 1);
    assert.equal(stats.cutoffMs, NOW - 24 * HOUR);
    assert.ok(problems.some((p) => p.kind === 'future-mtime' && p.path === future.file));
    assert.equal(JSON.stringify(entries), JSON.stringify(B.scanRecentlyChanged(sessions, { windowMs: 24 * HOUR, nowMs: NOW })));
    assert.equal(recent.sid, SID_A);
  } finally { dispose(base); }
});

test('BC-03 补充：缺失 sessionsBase / 过大源 / filter / 旧格式不崩且留痕', () => {
  const base = makeRoot('scan2');
  try {
    const problems = [];
    assert.deepEqual(B.scanRecentlyChanged('', { nowMs: NOW, problems }), []);
    assert.ok(problems.some((p) => p.kind === 'no-sessions-base'));
    assert.deepEqual(B.scanRecentlyChanged(path.join(base, 'not-exist'), { nowMs: NOW }), []);

    const sessions = path.join(base, 'sessions');
    writeSession(sessions, { sid: SID_A, turns: [{ turn: 1, startMs: NOW }], mtimeMs: NOW });
    writeSession(sessions, { sid: SID_B, turns: [{ turn: 1, startMs: NOW }], mtimeMs: NOW });
    const oldDir = path.join(sessions, '--test--', 'session-v2');
    mkdirp(oldDir);
    fs.writeFileSync(path.join(oldDir, 'session.v2.jsonl.zstd'), Buffer.from('x'));
    const p2 = [];
    assert.deepEqual(B.scanRecentlyChanged(sessions, { nowMs: NOW, maxBytes: 10, problems: p2 }), []);
    assert.ok(p2.some((p) => p.kind === 'too-large'));
    const filtered = B.scanRecentlyChanged(sessions, { nowMs: NOW, filter: (e) => path.basename(e.dir) === SID_A });
    assert.deepEqual(filtered.map((e) => path.basename(e.dir)), [SID_A]);
    assert.ok(p2.some((p) => p.kind === 'unsupported-format'));
  } finally { dispose(base); }
});

// ===========================================================================
// 二、findMissingTurns（BC-04；D9/D10）
// ===========================================================================

test('BC-04 24h 补录集合：源 3 轮 / 台账 2 轮 → 只计划第 3 轮；集合精确且可复算', () => {
  const base = makeRoot('missing');
  try {
    const sessions = path.join(base, 'sessions');
    writeSession(sessions, {
      sid: SID_A,
      turns: [{ turn: 1, startMs: NOW - 3 * HOUR }, { turn: 2, startMs: NOW - 2 * HOUR }, { turn: 3, startMs: NOW - HOUR }],
      mtimeMs: NOW - 30 * 60 * 1000,
    });
    const entries = B.scanRecentlyChanged(sessions, { nowMs: NOW });
    assert.equal(entries.length, 1);
    const root = path.join(base, 'root');
    mkdirp(root);
    writeLedger(root, [recordOf({ tsMs: NOW - 3 * HOUR, seq: 1, turn: 1 }), recordOf({ tsMs: NOW - 2 * HOUR, seq: 2, turn: 2 })]);
    const missing = B.findMissingTurns({ root, entries, nowMs: NOW });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].sid, SID_A);
    assert.deepEqual(missing[0].turns.map((t) => t.turn), [3]);
    assert.equal(missing[0].reason, '24h-scan');
    assert.equal(JSON.stringify(missing), JSON.stringify(B.findMissingTurns({ root, entries, nowMs: NOW })));
  } finally { dispose(base); }
});

test('D10 pending-only：`.pending.jsonl` 中 pending 的 (sid,turn) 不得当缺失轮；源闭合但台账未记 → promotePending', () => {
  const base = makeRoot('pending');
  try {
    const sessions = path.join(base, 'sessions');
    writeSession(sessions, {
      sid: SID_A,
      turns: [{ turn: 1, startMs: NOW - 3 * HOUR }, { turn: 2, startMs: NOW - 2 * HOUR }, { turn: 3, startMs: NOW - HOUR }],
      mtimeMs: NOW - 30 * 60 * 1000,
    });
    const entries = B.scanRecentlyChanged(sessions, { nowMs: NOW });
    const root = path.join(base, 'root');
    mkdirp(root);
    writeLedger(root, [recordOf({ tsMs: NOW - 3 * HOUR, seq: 1, turn: 1 })]);
    writePending(root, { sid: SID_A, turn: 2 });
    writePending(root, { sid: SID_A, turn: 3 });
    const pending = B.readPendingTurns(root);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].state, 'pending');
    // BC-15 之外：pending 的 turn 2/3 都不进 missing（前者源未闭合、后者待提升）
    assert.deepEqual(B.findMissingTurns({ root, entries, pending }), []);
    const promotions = B.findPendingPromotions({ root, entries, pending });
    assert.equal(promotions.length, 2);
    assert.deepEqual(promotions.map((p) => p.turn).sort((a, b) => a - b), [2, 3]);
    assert.equal(promotions[0].reason, 'source-closed');
    // 台账已有该 (sid,turn)（= 已提升过）→ 不再报 promotePending
    writeLedger(root, [
      recordOf({ tsMs: NOW - 3 * HOUR, seq: 1, turn: 1 }),
      recordOf({ tsMs: NOW - 2 * HOUR, seq: 2, turn: 2, status: 'ok' }),
    ]);
    assert.equal(B.findPendingPromotions({ root, entries, pending: B.readPendingTurns(root) }).length, 1);
  } finally { dispose(base); }
});

test('D10 历史 partial：只读不追写（不进 missing），由 plan.legacyPartials 列出', () => {
  const base = makeRoot('partial');
  try {
    const sessions = path.join(base, 'sessions');
    writeSession(sessions, { sid: SID_A, turns: [{ turn: 1, startMs: NOW - HOUR }], mtimeMs: NOW - 60 * 1000 });
    const entries = B.scanRecentlyChanged(sessions, { nowMs: NOW });
    const root = path.join(base, 'root');
    mkdirp(root);
    const partial = recordOf({ tsMs: NOW - HOUR, seq: 1, turn: 1, status: 'partial' }); // v0.4 老行
    writeLedger(root, [partial]);
    // 历史 partial 算"已记过"（不追写）；缺轮计划必须为空
    assert.deepEqual(B.findMissingTurns({ root, entries }), []);
    const plan = B.backfillPlan({ root, entries, nowMs: NOW });
    assert.deepEqual(plan.legacyPartials.map((x) => x.code), [partial.code]);
    assert.equal(plan.legacyPartials[0].status, 'partial');
    // 台账 partial 行字节不变（只读计划的副作用检查在 BC-15 用例里统一做）
  } finally { dispose(base); }
});

test('D9 坏 sid / 缺 createdAt / 坏帧：进 errors（fingerprint 按契约公式）且不抛穿', () => {
  const base = makeRoot('d9');
  try {
    const sessions = path.join(base, 'sessions');
    const badFile = path.join(sessions, '--test--', 'bad-dir', 'session.v4.jsonl.zstd');
    mkdirp(path.dirname(badFile));
    fs.writeFileSync(badFile, Buffer.from('x'));
    touch(badFile, NOW - 10 * 60 * 1000);

    const b = writeSession(sessions, { sid: SID_B, turns: [{ turn: 1, startMs: NOW - HOUR }], headPatch: { createdAt: undefined } });
    touch(b.file, NOW - 10 * 60 * 1000);

    const dead = path.join(sessions, '--test--', 'session-deadbeef-dead-dead-dead-deaddeadbeef');
    mkdirp(dead);
    const deadFile = path.join(dead, 'session.v4.jsonl.zstd');
    fs.writeFileSync(deadFile, Buffer.from([0x00, 0x01, 0x02]));
    touch(deadFile, NOW - 10 * 60 * 1000);

    const entries = B.scanRecentlyChanged(sessions, { nowMs: NOW });
    assert.equal(entries.length, 3);
    const errors = [];
    const problems = [];
    const missing = B.findMissingTurns({ root: path.join(base, 'root'), entries, knownTurns: new Set(), problems, errors });
    assert.deepEqual(missing, []);
    const kinds = errors.map((e) => e.kind).sort();
    assert.ok(kinds.includes('SID_UNENCODABLE'));
    assert.ok(kinds.includes('HEAD_MISSING'));
    assert.ok(kinds.includes('FRAME_FAILED'));
    for (const e of errors) {
      assert.match(e.fingerprint, /^[0-9a-f]{64}$/);
      assert.equal(e.fingerprint, B.errorFingerprint(e));
      assert.match(e.fingerprint, /^[0-9a-f]{64}$/);
    }
    const unenc = errors.find((e) => e.kind === 'SID_UNENCODABLE');
    assert.equal(unenc.fingerprint, sha256(`SID_UNENCODABLE|${unenc.source}|${unenc.sourceBytes}|${unenc.sourceMtimeMs}|0`));
    assert.ok(problems.some((p) => p.kind === 'format-rejected'));
  } finally { dispose(base); }
});

test('findMissingTurns：knownTurns 支持 Set/Array/Map/谓词；缺省从台账推导（任何行都算已记过）', () => {
  const base = makeRoot('known');
  try {
    const sessions = path.join(base, 'sessions');
    writeSession(sessions, {
      sid: SID_A,
      turns: [{ turn: 1, startMs: NOW - 2 * HOUR }, { turn: 2, startMs: NOW - HOUR }],
      mtimeMs: NOW - 10 * 60 * 1000,
    });
    const entries = B.scanRecentlyChanged(sessions, { nowMs: NOW });
    const root = path.join(base, 'root');
    mkdirp(root);
    writeLedger(root, [recordOf({ tsMs: NOW - 2 * HOUR, seq: 1, turn: 1 })]);
    const both = `${SID_A}#1`;
    const forms = [
      new Set([both, `${SID_A}#2`]),
      [both, `${SID_A}#2`],
      new Map([[both, 1], [`${SID_A}#2`, 1]]),
      (sid, turn) => sid === SID_A && (turn === 1 || turn === 2),
    ];
    for (const knownTurns of forms) {
      assert.deepEqual(B.findMissingTurns({ root, entries, knownTurns }), []);
    }
    // 显式 knownTurns 是**权威集合**（不自动并台账）：只给 turn2 时 turn1 会被计划 —— 调用方必须传完整集合。
    const onlyTwo = B.findMissingTurns({ root, entries, knownTurns: new Set([`${SID_A}#2`]) });
    assert.deepEqual(onlyTwo.map((x) => x.turns.map((t) => t.turn)), [[1]]);
    // 缺省（从台账推导）：turn2 缺失
    assert.deepEqual(B.findMissingTurns({ root, entries }).map((x) => x.turns.map((t) => t.turn)), [[2]]);
  } finally { dispose(base); }
});

// ===========================================================================
// 三、findPostSealRows（BC-07/08/09/10/13）
// ===========================================================================

test('BC-09 触发条件：封板后新行 = 有效 code − journal rows[].code；已封板组才产计划', () => {
  const base = makeRoot('postseal');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const f = sealFixture();
    writeLedger(root, f.records);
    sealWeekly(root, { gid: f.gid, rows: f.sealedRecs.map((r) => r.code) });
    // 从唯一 journal 读取（生产由 Lead 注入 latestSealEvents，测试走默认只读兜底）
    const post = B.findPostSealRows({ root, nowMs: NOW });
    assert.equal(post.length, 1);
    assert.equal(post[0].gid, f.gid);
    assert.equal(post[0].basis, 'journal-rows');
    assert.deepEqual(post[0].rows.map((r) => r.code), [f.newIn.code], '只有封板后新写入的 code');
    assert.deepEqual(post[0].outOfWindow.map((r) => r.code), [f.newOut.code]);
    assert.equal(post[0].seal.canonicalVersion, SJ.CANONICAL_VERSION);
    // 去掉新行 → 无计划
    writeLedger(root, f.sealedRecs);
    assert.deepEqual(B.findPostSealRows({ root, nowMs: NOW }), []);
  } finally { dispose(base); }
});

test('BC-07 72h 窗口：窗口内进 rows、窗口外必须进 outOfWindow；边界为闭区间', () => {
  const base = makeRoot('window');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const f = sealFixture();
    writeLedger(root, f.records);
    sealWeekly(root, { gid: f.gid, rows: f.sealedRecs.map((r) => r.code) });
    const post = B.findPostSealRows({ root, nowMs: NOW, windowMs: 72 * HOUR });
    assert.equal(post[0].rows.length, 1);
    assert.equal(post[0].outOfWindow.length, 1);
    assert.equal(post[0].outOfWindow[0].reason, 'ts-out-of-window');
    const edge = recordOf({ tsMs: NOW - 72 * HOUR, seq: 9, turn: 9 });
    writeLedger(root, [...f.records, edge]);
    const p2 = B.findPostSealRows({ root, nowMs: NOW });
    assert.equal(p2[0].rows.some((r) => r.code === edge.code), true, '窗口为闭区间 [now-72h, now]');
  } finally { dispose(base); }
});

test('BC-10 快照缺失保守只报：journal 无 rows / state 有封板但 journal 无该 gid → E_SEAL_SNAPSHOT_MISSING，不写补记', () => {
  const base = makeRoot('nosnap');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const f = sealFixture();
    writeLedger(root, f.records);
    const problems = [];
    // ① journal 行没有 rows 快照
    SJ.appendSealEvent(root, {
      kind: 'weekly-seal', key: f.gid, gid: f.gid, file: 'x.xlsx',
      sealedAt: '2026-11-09 10:00:00', sealHash: 'b'.repeat(64),
    });
    const post = B.findPostSealRows({ root, nowMs: NOW, problems });
    assert.deepEqual(post, []);
    assert.ok(problems.some((p) => p.code === 'E_SEAL_SNAPSHOT_MISSING' && p.gid === f.gid));

    // ② state 有封板但 journal 无该 gid（BC-10 明确要求告警）
    const root2 = path.join(base, 'root2');
    mkdirp(root2);
    L.writeState(root2, { [WK.SEAL_STATE_KEY]: { [f.gid]: { sealedAt: '2026-11-09 10:00:00', sealHash: 'c'.repeat(64), rows: 2 } } });
    const problems2 = [];
    assert.deepEqual(B.findPostSealRows({ root: root2, nowMs: NOW, problems: problems2 }), []);
    assert.ok(problems2.some((p) => p.code === 'E_SEAL_SNAPSHOT_MISSING' && p.gid === f.gid), 'state 有/ journal 无 → 必须报');
  } finally { dispose(base); }
});

test('D13/BC-08 3d 幂等：补记册已有 code、overflow-seal code 不得再当"封板后遗漏"', () => {
  const base = makeRoot('idem');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const f = sealFixture();
    const overflow = recordOf({ tsMs: T_SEALED + 20 * 60 * 1000, seq: 8, turn: 8 });
    writeLedger(root, [...f.records, overflow]);
    sealWeekly(root, { gid: f.gid, rows: f.sealedRecs.map((r) => r.code), supplementCodes: [overflow.code] });
    // 已有补记册里含 newIn.code（上一次 3d 消费者写的）
    const sup = WK.writeSupplement({ root, codes: [f.newIn.code], records: [f.newIn], reason: '3d-scan', nowMs: NOW, offsetMinutes: 480 });
    assert.equal(sup.added, 1);
    const post = B.findPostSealRows({ root, nowMs: NOW });
    assert.equal(post.length, 1);
    assert.deepEqual(post[0].rows, [], 'journal rows + supplement.codes + 既有补记册 三重排除');
    assert.deepEqual(post[0].outOfWindow.map((r) => r.code), [f.newOut.code], '窗口外的仍未计划但明列');
    // BC-13：补记册编号 `\d+`、原因枚举 3d-scan
    const book = fs.readFileSync(sup.path, 'utf8');
    assert.equal(book.includes('3d-scan'), true);
    assert.match(book, /补记-\d{8}-\d+/);
  } finally { dispose(base); }
});

test('journal 默认只读读取：readSealsForBackfill 用唯一 journal；坏行/断链不崩且留痕', () => {
  const base = makeRoot('loader');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const f = sealFixture();
    sealWeekly(root, { gid: f.gid, rows: f.sealedRecs.map((r) => r.code) });
    const problems = [];
    const loaded = B.readSealsForBackfill(root, { problems });
    assert.equal(loaded.journal.exists, true);
    assert.ok(loaded.seals[f.gid], 'journal 行应被读到');
    assert.equal(Array.isArray(loaded.seals[f.gid].rows), true, 'D12 rows 快照必须在');
    // 追加坏行 → 只报不崩
    fs.appendFileSync(path.join(root, 'ledger', '.seal-journal.jsonl'), '{bad json\n');
    const p2 = [];
    assert.doesNotThrow(() => B.readSealsForBackfill(root, { problems: p2 }));
    assert.ok(p2.some((p) => p.kind === 'seal-journal-bad-lines'));
  } finally { dispose(base); }
});

// ===========================================================================
// 四、backfillPlan（BC-05/BC-15）
// ===========================================================================

test('BC-15 只读 + 可 JSON 序列化 + 同输入两次输出完全相等（24h + 3d + pending + report 字段）', () => {
  const base = makeRoot('plan');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const sessions = path.join(base, 'sessions');
    writeSession(sessions, {
      sid: SID_A,
      turns: [{ turn: 1, startMs: T_SEALED }, { turn: 2, startMs: T_NEW_IN }, { turn: 3, startMs: NOW - 30 * 60 * 1000 }],
      mtimeMs: NOW - 5 * 60 * 1000,
    });
    writeSession(sessions, {
      sid: SID_B,
      turns: [{ turn: 1, startMs: NOW - HOUR }, { turn: 2, startMs: NOW - 30 * 60 * 1000 }],
      mtimeMs: NOW - 5 * 60 * 1000,
    });
    const f = sealFixture();
    writeLedger(root, f.records);   // 含封板前 2 行 + 封板后新行（窗口内/外各一）
    sealWeekly(root, { gid: f.gid, rows: f.sealedRecs.map((r) => r.code) });
    writePending(root, { sid: SID_B, turn: 2 });

    const args = { root, sessionsBase: sessions, nowMs: NOW, knownTurns: new Set([`${SID_A}#1`]) };
    const before = treeSnapshot(root);
    const plan1 = B.backfillPlan(args);
    const plan2 = B.backfillPlan(args);
    const after = treeSnapshot(root);
    assert.deepEqual(after, before, '计划函数必须只读（目录树/字节完全不变）');
    assert.equal(JSON.stringify(plan1), JSON.stringify(plan2), '同输入两次输出 JSON 完全相等');
    assert.deepEqual(JSON.parse(JSON.stringify(plan1)), plan1, '计划可 JSON 序列化且无损');
    assert.equal(plan1.kind, 'backfill-plan');
    assert.match(plan1.generatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(plan1.generatedAt.includes('Z'), false);

    // 24h 补录：A 的 turn2/3；B 的 turn1（turn2 是 pending，排除）
    const missA = plan1.missingTurns.find((m) => m.sid === SID_A);
    assert.deepEqual(missA.turns.map((t) => t.turn), [2, 3]);
    const missB = plan1.missingTurns.find((m) => m.sid === SID_B);
    assert.deepEqual(missB.turns.map((t) => t.turn), [1], 'pending 的 turn2 不得计划');
    // 3d 补记 + 窗口外明列
    assert.equal(plan1.postSealRows.length, 1);
    assert.deepEqual(plan1.postSealRows[0].rows.map((r) => r.code), [f.newIn.code]);
    assert.equal(plan1.outOfWindow.length, 1);
    // actions / stats / report（BC-15 字段名对齐 run-report）
    //  A/B 两组 24h 补录 + B.turn2 的 promotePending + 1 组 3d 补记
    assert.deepEqual(plan1.actions.map((a) => a.kind).sort(),
      ['backfill-missing-turns', 'backfill-missing-turns', 'promote-pending', 'write-supplement']);
    assert.equal(plan1.stats.promotePendingCount, 1);
    assert.equal(plan1.stats.missingTurnCount, 3);
    assert.equal(plan1.stats.postSealRowCount, 1);
    assert.equal(plan1.stats.outOfWindowCount, 1);
    assert.deepEqual(Object.keys(plan1.report).sort(),
      ['errors', 'late24h', 'outOfWindow', 'scanned24h', 'scanned3d', 'skipped', 'supplements']);
    assert.equal(plan1.report.late24h, 3);
    assert.equal(plan1.report.supplements, 1);
    assert.equal(plan1.report.outOfWindow, 1);
    assert.equal(typeof plan1.report.scanned24h, 'number');
    assert.equal(typeof plan1.report.scanned3d, 'number');
    assert.equal(plan1.report.errors, 0);
  } finally { dispose(base); }
});

test('BC-04/BC-15 空目录/缺失目录：计划为空 + 原因，不崩、可复算、不创建 root', () => {
  const base = makeRoot('empty');
  try {
    const root = path.join(base, 'root');
    const plan1 = B.backfillPlan({ root, sessionsBase: path.join(base, 'none'), nowMs: NOW });
    const plan2 = B.backfillPlan({ root, sessionsBase: path.join(base, 'none'), nowMs: NOW });
    assert.equal(JSON.stringify(plan1), JSON.stringify(plan2));
    assert.deepEqual(plan1.missingTurns, []);
    assert.deepEqual(plan1.postSealRows, []);
    assert.deepEqual(plan1.actions, []);
    assert.ok(Array.isArray(plan1.problems) && plan1.problems.length > 0, '缺失目录必须留原因');
    assert.equal(fs.existsSync(root), false, '只读：不得创建 root');
  } finally { dispose(base); }
});

test('D9 errors 出现在计划里且指纹稳定；计划不写 .errors.jsonl', () => {
  const base = makeRoot('planerr');
  try {
    const root = path.join(base, 'root');
    mkdirp(root);
    const sessions = path.join(base, 'sessions');
    const dir = path.join(sessions, '--test--', 'bad-dir');
    mkdirp(dir);
    const badFile = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(badFile, Buffer.from('x'));
    touch(badFile, NOW - 10 * 60 * 1000);
    const before = treeSnapshot(root);
    const plan = B.backfillPlan({ root, sessionsBase: sessions, nowMs: NOW });
    assert.deepEqual(treeSnapshot(root), before);
    assert.equal(plan.errors.length, 1);
    assert.equal(plan.errors[0].kind, 'SID_UNENCODABLE');
    assert.match(plan.errors[0].fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(root, 'ledger', '.errors.jsonl')), false);
  } finally { dispose(base); }
});

// ===========================================================================
// 五、ensureHandover（P1-7 幂等入口；D12 handover-seal journal）
// ===========================================================================

const TPL_EVENTS = [{
  seq: 1, type: 'user/message', time: NOW - 2 * HOUR,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '接管前的用户原文' }] },
}];
function ctxReader(result, spy) { return (p) => { if (spy) spy.push(p); return result; }; }
function baseEnsureArgs(root, extra = {}) {
  return {
    root, sessKey: KEY, state: {}, nowMs: NOW, knownTurns: 1,
    contextEntry: { path: 'synthetic/session.v4.jsonl.zstd', version: 4 },
    readContext: ctxReader({ events: TPL_EVENTS, incomplete: false, failedFrames: 0 }),
    ...extra,
  };
}

test('P1-7 generate：ensureHandover 写主表+附表 + handover-seal journal（D12 扁平字段，file=主表相对路径）', () => {
  const root = makeRoot('ensure-gen');
  try {
    const state = {};
    const r1 = H.ensureHandover(baseEnsureArgs(root, { state }));
    assert.equal(r1.ok, true, JSON.stringify(r1.errors));
    assert.equal(r1.decision, 'generate');
    assert.equal(r1.generated, true);
    // V0.6.2：产物只写 `交接表/`（一级不得出现成品）。
    assert.equal(fs.existsSync(handoverPath(root, r1.files.main)), true);
    assert.equal(fs.existsSync(handoverPath(root, r1.files.appendix, layout.FILE_KIND.HANDOVER_APPENDIX)), true);
    assert.equal(fs.existsSync(path.join(root, r1.files.main)), false, '一级不得再写交接表');
    assert.deepEqual(r1.appendix, { count: 1, total: 1, truncated: false });
    assert.ok(r1.logs.includes('handover=generate reopened=true'));
    // 证据形状（D12）：扁平字段、gid:null、file=主表相对路径（selfheal 依赖）
    assert.equal(r1.sealEvidence.kind, 'handover-seal');
    assert.equal(r1.sealEvidence.key, KEY);
    assert.equal(r1.sealEvidence.gid, null);
    assert.equal(r1.sealEvidence.file, r1.files.main);
    assert.equal(r1.sealEvidence.decision, 'generated');
    assert.equal(r1.sealEvidence.main, r1.files.main);
    assert.equal(r1.sealEvidence.appendix, r1.files.appendix);
    assert.equal(r1.sealEvidence.adopted, false);
    assert.equal(r1.sealEvidence.reopened, true);
    assert.equal(r1.sealEvidence.canonicalVersion, 1);
    assert.match(r1.sealEvidence.sealHash, /^[0-9a-f]{64}$/);
    // journal 已由唯一写者落盘；state 缓存也已写（双记）
    const j = SJ.readSealEvents(root);
    assert.equal(j.events.length, 1);
    assert.equal(j.events[0].kind, 'handover-seal');
    assert.equal(j.events[0].key, KEY);
    assert.equal(j.events[0].file, r1.files.main);
    assert.equal(state.handoverSealed[KEY].sealHash, r1.sealEvidence.sealHash);
    // 幂等：同 state 再调 → skip，零写盘
    const mainFile = handoverPath(root, r1.files.main);
    const mainBytes = fs.readFileSync(mainFile);
    const mtime = fs.statSync(mainFile).mtimeMs;
    const r2 = H.ensureHandover(baseEnsureArgs(root, { state }));
    assert.equal(r2.ok, true);
    assert.equal(r2.decision, 'skip');
    assert.equal(sha256(fs.readFileSync(mainFile)), sha256(mainBytes));
    assert.equal(fs.statSync(mainFile).mtimeMs, mtime);
    assert.equal(SJ.readSealEvents(root).events.length, 1, 'skip 不得追加 journal 行');
  } finally { dispose(root); }
});

test('P1-9 交接表：state 丢失后仅凭 journal（ensure 自动读）→ skip，不写任何字节', () => {
  const root = makeRoot('ensure-journal');
  try {
    const r1 = H.ensureHandover(baseEnsureArgs(root, { state: {} }));
    assert.equal(r1.decision, 'generate');
    const mainFile = handoverPath(root, r1.files.main);
    const mainBytes = fs.readFileSync(mainFile);
    // state 丢失：空 state；ensure 应从 journal 读到 handover-seal → skip
    const r2 = H.ensureHandover(baseEnsureArgs(root, { state: {} }));
    assert.equal(r2.ok, true);
    assert.equal(r2.decision, 'skip');
    assert.equal(r2.sealSource, 'journal');
    assert.equal(sha256(fs.readFileSync(mainFile)), sha256(mainBytes));
  } finally { dispose(root); }
});

test('HO-24/P1-7 adopt：旧主表存在 → adopt 只补证据不改字节；journal decision=adopted', () => {
  const root = makeRoot('ensure-adopt');
  try {
    const mainName = H.handoverMainName(KEY);
    const oldMd = `---\n名称: "${KEY}的记忆数据库的启用及交接表"\n---\n\n# ${KEY}的记忆数据库的启用及交接表\n\n旧文件正文\n`;
    fs.writeFileSync(path.join(root, mainName), oldMd, 'utf8');
    const before = fs.readFileSync(path.join(root, mainName));
    const mtime = fs.statSync(path.join(root, mainName)).mtimeMs;
    const state = {};
    const r = H.ensureHandover(baseEnsureArgs(root, { state }));
    assert.equal(r.ok, true);
    assert.equal(r.decision, 'adopt');
    assert.equal(r.adopted, true);
    assert.equal(r.sealEvidence.decision, 'adopted');
    assert.equal(r.sealEvidence.adopted, true);
    assert.equal(r.sealEvidence.file, mainName);
    assert.equal(sha256(fs.readFileSync(path.join(root, mainName))), sha256(before), 'adopt 不得改文件字节');
    assert.equal(fs.statSync(path.join(root, mainName)).mtimeMs, mtime);
    const j = SJ.readSealEvents(root);
    assert.equal(j.events.length, 1);
    assert.equal(j.events[0].kind, 'handover-seal');
    assert.equal(state.handoverSealed[KEY].sealHash, r.sealEvidence.sealHash);
  } finally { dispose(root); }
});

test('P1-7 失败只返回 errors：readContext 缺失/抛错/incomplete、knownTurns 缺失、坏参数都不写盘不抛穿', () => {
  const root = makeRoot('ensure-fail');
  try {
    const a = H.ensureHandover(baseEnsureArgs(root, { readContext: undefined }));
    assert.equal(a.ok, false);
    assert.equal(a.errors[0].code, 'E_HANDOVER_NO_CONTEXT_READER');
    const b = H.ensureHandover(baseEnsureArgs(root, { readContext: () => { throw Object.assign(new Error('boom'), { code: 'E_TEST_BOOM' }); } }));
    assert.equal(b.ok, false);
    assert.equal(b.errors[0].code, 'E_TEST_BOOM');
    const c = H.ensureHandover(baseEnsureArgs(root, { readContext: ctxReader({ events: [], incomplete: true }) }));
    assert.equal(c.ok, false);
    assert.equal(c.errors[0].code, 'E_HANDOVER_APPENDIX_INCOMPLETE');
    const d = H.ensureHandover({ ...baseEnsureArgs(root), knownTurns: undefined });
    assert.equal(d.ok, false);
    assert.equal(d.errors[0].code, 'E_HANDOVER_KNOWN_TURNS_REQUIRED');
    const e = H.ensureHandover({ root, sessKey: 'bad-key', nowMs: NOW, knownTurns: 1 });
    assert.equal(e.ok, false);
    assert.equal(e.errors[0].code, 'E_HANDOVER_BAD_ARGS');
    const f = H.ensureHandover({ ...baseEnsureArgs(root), knownTurns: 0 });
    assert.equal(f.ok, true);
    assert.equal(f.decision, 'deferred');
    assert.equal(handoverExisting(root, H.handoverMainName(KEY)), '', '失败/延迟都不得写主表（双路径都没有）');
    assert.equal(SJ.readSealEvents(root).events.length, 0, '失败/延迟都不得写 journal');
  } finally { dispose(root); }
});

test('P1-7 disabled：零 IO 直接返回（ok:true / decision:disabled）', () => {
  const r = H.ensureHandover({ root: 'x', sessKey: KEY, enabled: false });
  assert.deepEqual({ ok: r.ok, decision: r.decision }, { ok: true, decision: 'disabled' });
  assert.equal(r.files, null);
});

test('HO-23 交接表侧：已封板但主表被删 → skip + warn，不重建（ensure 入口不抛）', () => {
  const root = makeRoot('ensure-skipdel');
  try {
    const state = {};
    const r1 = H.ensureHandover(baseEnsureArgs(root, { state }));
    assert.equal(r1.decision, 'generate');
    fs.unlinkSync(handoverPath(root, r1.files.main));
    const r2 = H.ensureHandover(baseEnsureArgs(root, { state }));
    assert.equal(r2.ok, true);
    assert.equal(r2.decision, 'skip');
    assert.ok(r2.warnings.some((w) => w.includes('sealed but file missing')));
    assert.equal(handoverExisting(root, r1.files.main), '', '不得重建');
  } finally { dispose(root); }
});

test('sealWriter 注入：完全接管（journal 不写、state 不写），skip 靠注入证据幂等', () => {
  const root = makeRoot('ensure-writer');
  try {
    const written = [];
    const state = {};
    const r1 = H.ensureHandover(baseEnsureArgs(root, { state, sealWriter: (ev) => written.push(ev) }));
    assert.equal(r1.ok, true);
    assert.equal(r1.decision, 'generate');
    assert.equal(written.length, 1);
    assert.equal(state.handoverSealed, undefined, '注入 sealWriter 后 handover 不写 state');
    assert.equal(SJ.readSealEvents(root).events.length, 0, '注入 sealWriter 后 handover 不写 journal');
    const r2 = H.ensureHandover(baseEnsureArgs(root, {
      state, seals: { handover: { [KEY]: written[0] } }, sealWriter: (ev) => written.push(ev),
    }));
    assert.equal(r2.decision, 'skip');
    assert.equal(written.length, 1, 'skip 不得重复写证据');
  } finally { dispose(root); }
});
