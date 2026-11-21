/**
 * @file 自测-lock-re3.mjs
 * @role v1.0.0-re3 B 线（锁与台账内核）的回归自测：
 *   ① P0 同进程锁失效（审计③ ARCH-02 / K-12）：幂等键 (root,instanceId)、fencing token、
 *      被接管即 lost、release 归属校验（不得双写、不得互删锁）；
 *   ② readAll stat 容错（审计② A1 / K-13）：只有 ENOENT 是首次开账，其余 → ok=false+E_STAT，
 *      appendTurn 拒写（含 knownCodes 路径），不得写出重复 code 行；
 *   ③ halt 游标（审计② A2 / K-14）：nextOffset = min(haltOffset, 跨 halt 边界轮最小 startByte)；
 *   ④ 超大帧契约（审计③ CORE-01 / K-15）：可跳过缺口 → 推进游标、不 blocked、结构化 loss。
 *
 * @depends ../lib/lock.js（acquire/release/lockPath/inspectLock/verifyOwnership）、
 *          ../lib/ledger.js（readAll/appendTurn/readTurnsFrom/readSessionFrom/ledgerDir/ledgerPath）
 * @called-by 人工/判据：`node docs\跑测试.mjs docs\自测-lock-re3.mjs`
 *
 * 隔离：临时目录全在 `%TEMP%\dl-lockre3-*`，finally 整棵删除；不读真实 %USERPROFILE%\.dsh。
 * 失败纪律：断言失败就红，不删用例凑绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import {
  acquire, release, lockPath, inspectLock, verifyOwnership, DEFAULT_INSTANCE_ID,
} from '../lib/lock.js';
import {
  readAll, appendTurn, readTurnsFrom, readSessionFrom, ledgerDir, ledgerPath,
} from '../lib/ledger.js';

// ============================================================================
// 一、测试基础设施（与 自测-守卫.mjs 同一写盘纪律）
// ============================================================================

/** 在 `%TEMP%\dl-lockre3-*` 下跑用例，结束整棵删除。 */
function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lockre3-'));
  assert.match(path.basename(root), /^dl-lockre3-/);
  assert.equal(path.dirname(root), os.tmpdir());
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const mkZ = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
const head = () => JSON.stringify({
  type: 'session', id: 'session-75238718-e41a-4e8c-8044-50202444455f', createdAt: 1794067200000,
});
const start = (n, t, pad) => JSON.stringify({ type: 'turn/start', time: t, data: pad ? { turn: n, pad } : { turn: n } });
const end = (n, t) => JSON.stringify({ type: 'turn/end', time: t, data: { turn: n, reason: { kind: 'stop' } } });
const badFrame = () => Buffer.concat([MAGIC, Buffer.from('not-a-zstd-frame-in-the-middle', 'utf8')]);
const rec = (code, turn = 1) => ({
  v: 3, code, ts: '2026-11-14T10:00:00+08:00',
  sid: 'session-75238718-e41a-4e8c-8044-50202444455f', turn, seq: turn, status: 'ok',
});
const CODE_A = '20261114-75238718e41a-A-00000001';
const CODE_B = '20261114-75238718e41a-A-00000002';

// ============================================================================
// 二、K-12（P0 ARCH-02）：同进程锁
// ============================================================================

// 守：审计③ ARCH-02 —— 同进程同 root 的 acquire 按 root 幂等返回同一 handle，
// 导致两个"实例"都以为持锁：各写各的（双写）、任一 release 删掉另一方的锁。修好后：
// 幂等键=(root,instanceId)；不同实例第二个必须 LOCK_HELD；锁文件字节不得被动；不得双写。
test('K-12：同进程两实例（不同 instanceId）→ 第二个 LOCK_HELD，不双写、不改/删 A 的锁', () => {
  withTemp((root) => {
    const a = acquire(root, { instanceId: 'A', heartbeatIntervalMs: 60_000 });
    assert.equal(a.acquired, true);
    assert.equal(a.instanceId, 'A');
    assert.equal(typeof a.token, 'string');
    assert.equal(a.token, a.holder.token);
    const rawA = fs.readFileSync(lockPath(root));

    const b = acquire(root, { instanceId: 'B', heartbeatIntervalMs: 60_000 });
    assert.equal(b.acquired, false, '同进程第二个实例不得 acquired=true（旧缺陷=返回同一 handle）');
    assert.equal(b.code, 'LOCK_HELD');
    assert.equal(b.reason, 'held');
    assert.equal(b.conflict, 'same-process');
    assert.equal(b.conflictInstanceId, 'A');
    assert.equal(b.holder.token, a.token, '必须带回持锁者 fencing token');
    assert.notEqual(b, a);
    assert.equal(fs.readFileSync(lockPath(root)).equals(rawA), true, '第二个实例的 acquire 不得改动锁文件');
    assert.equal(inspectLock(root).holder.token, a.token, '不得夺取/替换 A 的锁');
    assert.equal(a.lost, false);

    // 同 (root,instanceId) 幂等；不同实例因未取得 handle 不得写 → 账本只能有 A 的一行
    assert.equal(acquire(root, { instanceId: 'A', heartbeatIntervalMs: 60_000 }), a);
    assert.equal(appendTurn(root, rec(CODE_A), new Set()).ok, true);
    assert.equal(readAll(root).records.length, 1, 'B 未持锁却写了账 = 双写');

    // A 释放后 B 才能接手
    assert.equal(release(a).released, true);
    assert.equal(fs.existsSync(lockPath(root)), false);
    const b2 = acquire(root, { instanceId: 'B', heartbeatIntervalMs: 60_000 });
    assert.equal(b2.acquired, true);
    release(b2);
  });
});

// 守：不传 instanceId 的旧调用方共用 DEFAULT_INSTANCE_ID：重复 acquire 仍幂等（单实例行为不破）。
test('K-12：默认 instanceId 兼容 —— 同 root 重复 acquire 幂等，release 一次即释放', () => {
  withTemp((root) => {
    const h1 = acquire(root, { heartbeatIntervalMs: 60_000 });
    assert.equal(h1.acquired, true);
    assert.equal(h1.instanceId, DEFAULT_INSTANCE_ID);
    const h2 = acquire(root, { heartbeatIntervalMs: 60_000 });
    assert.equal(h2, h1, '同 (root,默认 instanceId) 必须幂等返回同一 handle');
    assert.equal(release(h1).released, true);
    assert.equal(release(h1).released, false);
    assert.equal(release(h1).reason, 'already released');
  });
});

// 守：K-12 ③ —— 锁被外部删除/接管后，B 接管成功，A 必须立刻 lost（不得再写），
// A 的 release 不得删/改 B 的锁（audit 的"互删锁"场景）。
test('K-12：A 的锁被外部删除后 B 接管 → A 立即 lost=true，A.release 不得删 B 的锁', () => {
  withTemp((root) => {
    const a = acquire(root, { instanceId: 'A', heartbeatIntervalMs: 60_000 });
    assert.equal(a.acquired, true);
    fs.unlinkSync(lockPath(root)); // 模拟锁被外部删除（或被别的 owner 接管）
    const b = acquire(root, { instanceId: 'B', heartbeatIntervalMs: 60_000 });
    assert.equal(b.acquired, true, '锁已不存在时 B 必须能接管');
    assert.equal(a.lost, true, 'B 接管后 A 必须立刻 lost=true');
    assert.match(String(a.lostReason), /lock-missing|taken-over/, 'lostReason 必须结构化（lock-missing/taken-over）');
    assert.equal(a.heartbeat().ok, false, 'lost 后心跳必须失败（不得伪装存活）');
    assert.equal(verifyOwnership(a).ok, false);

    const rawB = fs.readFileSync(lockPath(root));
    const relA = release(a);
    assert.equal(relA.released, false);
    assert.equal(fs.existsSync(lockPath(root)), true);
    assert.equal(fs.readFileSync(lockPath(root)).equals(rawB), true, 'A 的 release 不得删/改 B 的锁（互删锁）');
    assert.equal(inspectLock(root).holder.token, b.token);
    release(b);
  });
});

// 守：K-12 ④ fencing —— 磁盘上锁已换成第三方 token，A.release 不得按路径无脑删。
test('K-12：fencing token —— 磁盘持有人换了 token，release 返回 not-owner 且不动第三方锁', () => {
  withTemp((root) => {
    const a = acquire(root, { instanceId: 'A', heartbeatIntervalMs: 60_000 });
    const foreign = {
      v: 1, pid: process.pid, hostname: os.hostname(), token: 'foreign-token-ffff',
      startedAt: '2026-11-14T10:00:00+08:00', startedAtMs: Date.now() - 1000,
      heartbeatAt: '2026-11-14T10:00:00+08:00', heartbeatAtMs: Date.now() - 1000,
    };
    const foreignRaw = JSON.stringify(foreign, null, 2) + '\n';
    fs.writeFileSync(lockPath(root), foreignRaw, 'utf8');
    const rel = release(a);
    assert.equal(rel.released, false);
    assert.equal(rel.reason, 'not-owner');
    assert.equal(a.lost, true);
    assert.equal(fs.readFileSync(lockPath(root), 'utf8'), foreignRaw, '不得删掉第三方锁');
    fs.rmSync(lockPath(root), { force: true });
  });
});

// ============================================================================
// 三、K-13（A1）：readAll stat 容错 + appendTurn 拒写
// ============================================================================

// 守：审计② A1 —— stat 失败（EACCES/EMFILE/EBUSY/EIO）曾被当"空库已证明、ok=true"；
// 调用方拿到空 knownCodes 后 appendTurn 照写 → 重复 code 行。修好后：ok=false+E_STAT，
// appendTurn（含 knownCodes 路径）拒写且账文件零字节变化。注入手段：patch fs.statSync。
test('K-13：stat 错误注入（EACCES/EMFILE/EBUSY/EIO）→ readAll ok=false+E_STAT，appendTurn 拒写、无重复 code', () => {
  withTemp((root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const day = ledgerPath(root, '2026-11-14');
    const row = JSON.stringify(rec(CODE_A)) + '\n';
    fs.writeFileSync(day, row, 'utf8');

    const realStat = fs.statSync;
    const dir = ledgerDir(root);
    try {
      for (const code of ['EACCES', 'EMFILE', 'EBUSY', 'EIO']) {
        fs.statSync = function patched(p, ...rest) {
          if (path.resolve(String(p)) === path.resolve(dir)) {
            const e = new Error(code + ': injected stat failure');
            e.code = code;
            throw e;
          }
          return realStat.call(fs, p, ...rest);
        };
        try {
          const all = readAll(root);
          assert.equal(all.ok, false, code + '：readAll 必须 ok=false');
          assert.equal(all.emptyProven, false, code + '：stat 失败不得 emptyProven=true');
          assert.equal(all.dirExists, false);
          const err = all.readErrors.find((x) => x && x.code === 'E_STAT');
          assert.ok(err, code + '：readErrors 必须含 E_STAT');
          assert.equal(err.statCode, code);
          assert.equal(err.file, dir);
          assert.equal(all.statError && all.statError.code, 'E_STAT');

          const w1 = appendTurn(root, rec(CODE_B, 2));
          assert.equal(w1.ok, false, code + '：appendTurn(无 knownCodes) 必须拒写');
          assert.equal(w1.reason, 'ledger-unreadable');
          const w2 = appendTurn(root, rec(CODE_A), new Set());
          assert.equal(w2.ok, false, code + '：appendTurn(knownCodes) 必须拒写');
          assert.equal(w2.reason, 'ledger-unreadable');
          assert.equal(fs.readFileSync(day, 'utf8'), row, code + '：拒写时账文件不得任何字节变化');
        } finally {
          fs.statSync = realStat;
        }
        // 恢复后：读取正常（探测没有残留副作用）
        assert.equal(readAll(root).ok, true);
      }
    } finally {
      fs.statSync = realStat;
    }
  });
});

// 守：K-13 不得误伤"首次开账"：目录不存在仍是 ENOENT → emptyProven=true/ok=true。
test('K-13：ledger 目录不存在（ENOENT）仍是首次开账 —— ok=true/emptyProven=true', () => {
  withTemp((root) => {
    fs.rmSync(ledgerDir(root), { recursive: true, force: true });
    const all = readAll(root);
    assert.equal(all.ok, true);
    assert.equal(all.emptyProven, true);
    assert.equal(all.dirExists, false);
    assert.equal(all.statError, null);
    assert.equal(appendTurn(root, rec(CODE_A), new Set()).ok, true);
  });
});

// ============================================================================
// 四、K-14（A2）：halt 游标不得越过跨 halt 边界轮的起点
// ============================================================================

// 守：未闭合轮（open）在坏帧之前开始 → nextOffset=min(haltOffset, open.startByte)；
// 源修复后从该游标续读必须能闭合该轮（否则永久漏记）。
test('K-14：未闭合轮跨坏帧 → nextOffset=open.startByte（不是 haltOffset），修复后能续记', () => {
  withTemp((root) => {
    const file = path.join(root, 'open-cross.v4.jsonl.zstd');
    const f0 = mkZ([head(), start(1, 1000), end(1, 2000)].join('\n') + '\n');
    const f1 = mkZ(start(2, 3000) + '\n');          // turn2 未闭合，起点在坏帧之前
    const bad = badFrame();                          // 文件尾坏帧
    fs.writeFileSync(file, Buffer.concat([f0, f1, bad]));
    const off = { f0: 0, f1: f0.length, bad: f0.length + f1.length };

    const r = readTurnsFrom(file);
    assert.equal(r.meta.halted, true);
    assert.equal(r.meta.blocked, true);
    assert.equal(r.meta.haltOffset, off.bad);
    assert.equal(r.open && r.open.turn, 2);
    assert.equal(r.meta.nextOffset, off.f1, 'K-14：nextOffset 必须回退到未闭合轮起点');
    assert.equal(r.meta.cursorClamped, true);
    assert.equal(r.meta.cursorClampByte, off.f1);
    assert.deepEqual(r.meta.haltBoundaryTurns, [{ turn: 2, startByte: off.f1, endByte: null }]);

    // readSessionFrom 同一口径
    const rs = readSessionFrom(file, { fromByte: 0 });
    assert.equal(rs.meta.nextOffset, off.f1);

    // 源修复（补上 turn2 结尾）后从 nextOffset 续读 → 必须闭合 turn2
    fs.writeFileSync(file, Buffer.concat([f0, f1, mkZ(end(2, 4000) + '\n')]));
    const r2 = readTurnsFrom(file, { fromByte: r.meta.nextOffset, head: r.head });
    assert.deepEqual(r2.closed.map((t) => t.turn), [2]);
  });
});

// 守：G 线夹具形态 —— turn1 的 start 在坏帧前、end 在坏帧后（扫描结束 open=null），
// 但这属于"跨 halt 边界的闭合轮"，游标同样不得越过它的 startByte；haltOffset 证据不变。
test('K-14：跨坏帧的已闭合轮也约束游标（open=null 时 nextOffset=该轮 startByte）', () => {
  withTemp((root) => {
    const file = path.join(root, 'straddle.v4.jsonl.zstd');
    const f0 = mkZ([head(), start(1, 1000)].join('\n') + '\n'); // turn1 只 start
    const bad = badFrame();
    const f2 = mkZ([end(1, 2000), start(2, 3000), end(2, 4000)].join('\n') + '\n');
    fs.writeFileSync(file, Buffer.concat([f0, bad, f2]));
    const halt = f0.length;

    const r = readTurnsFrom(file);
    assert.equal(r.open, null, '夹具前提：turn1 在坏帧之后闭合');
    assert.ok(r.closed.some((t) => t.turn === 1 && t.startByte === 0));
    assert.equal(r.meta.halted, true);
    assert.equal(r.meta.haltOffset, halt, 'haltOffset 证据仍是坏帧起点');
    assert.equal(r.meta.blocked, true);
    assert.equal(r.meta.nextOffset, 0, 'K-14：nextOffset 必须回退到跨边界轮的 startByte');
    assert.equal(r.meta.cursorClamped, true);
    assert.ok(r.meta.haltBoundaryTurns.some((t) => t.turn === 1 && t.startByte === 0 && t.endByte > halt));
  });
});

// 守：没有"跨 halt 边界轮"时退回原口径 nextOffset=haltOffset（不得把已完成轮也算进去）。
test('K-14：轮都在坏帧前闭合 → nextOffset=haltOffset（不收窄）', () => {
  withTemp((root) => {
    const file = path.join(root, 'no-cross.v4.jsonl.zstd');
    const f0 = mkZ([head(), start(1, 1000), end(1, 2000)].join('\n') + '\n');
    const bad = badFrame();
    fs.writeFileSync(file, Buffer.concat([f0, bad]));
    const r = readTurnsFrom(file);
    assert.equal(r.meta.halted, true);
    assert.equal(r.meta.nextOffset, f0.length);
    assert.equal(r.meta.haltOffset, f0.length);
    assert.equal(r.meta.cursorClamped, false);
    assert.equal(r.meta.cursorClampByte, null);
    assert.deepEqual(r.meta.haltBoundaryTurns, []);
  });
});

// ============================================================================
// 五、K-15（CORE-01）：超大帧 = 可跳过缺口
// ============================================================================

// 守：frames 判"超大帧可跳过"（不 halted），ledger 曾置 nextOffset=0/blocked=true →
// 游标永久钉 0、每 tick 全量重扫。修好后：推进游标、不 blocked、结构化 loss；
// 缺口之后的轮次下一 tick 能读到。（用 maxFrameBytes 透传构造 3 KB 超大帧，不烧内存。）
test('K-15：超大帧跳过 → blocked=false/nextOffset 前进/loss 结构化，后续轮次照读', () => {
  withTemp((root) => {
    const file = path.join(root, 'oversized.v4.jsonl.zstd');
    const f0 = mkZ([head(), start(1, 1000), end(1, 2000)].join('\n') + '\n');
    const big = zlib.zstdCompressSync(crypto.randomBytes(3000)); // 不可压缩 → 帧长 > maxFrameBytes
    const f2 = mkZ([start(2, 3000), end(2, 4000)].join('\n') + '\n');
    fs.writeFileSync(file, Buffer.concat([f0, big, f2]));
    const off = { f0: 0, big: f0.length, f2: f0.length + big.length };

    const r = readTurnsFrom(file, { maxFrameBytes: 2048 });
    assert.equal(r.meta.halted, false, '超大帧不是坏帧');
    assert.equal(r.meta.failed, 1);
    assert.equal(r.meta.blocked, false, 'K-15：可跳过缺口不得 blocked');
    assert.equal(r.meta.blockReason, '');
    assert.equal(r.meta.lossSkipped, true);
    assert.equal(r.meta.skippedFrames, 1);
    assert.equal(r.meta.nextOffset, fs.statSync(file).size, 'K-15：游标必须推进到文件尾（不是 0）');
    assert.equal(r.meta.retryable, false, '可跳过缺口不可重试');
    assert.equal(r.loss.reasons.includes('oversized-frame'), true, 'reasons 固定串 oversized-frame');
    assert.equal(r.loss.reasons.includes('failed-frames'), true);
    assert.ok(Array.isArray(r.meta.skippedRanges) && r.meta.skippedRanges.length === 1);
    assert.equal(r.meta.skippedRanges[0].start, off.big);
    assert.equal(r.meta.skippedRanges[0].skippable, true);
    assert.equal(r.meta.skippableBytes, big.length);
    // 缺口之后的轮次照常解出（跳过 ≠ 判死）
    assert.deepEqual(r.closed.map((t) => t.turn), [1, 2]);
  });
});

// 守：超大帧 + 字节预算截断时，游标必须停在**帧边界**而不是钉 0；下一 tick 从该点能读到
// 缺口之后的新轮次（审计③ CORE-01 的"预算截断后新轮永远读不到"形态）。
// 构造：被跳过的是"解压超限帧"（压缩很小、展开 >maxDecompressedBytes），
//       缺口之后的 f2 帧长 > 被跳过帧长，预算才能停在 f2 之前（且 f2 本身可正常解压）。
test('K-15：超大帧 + 预算截断 → nextOffset=预算停点（帧边界），下一 tick 读到缺口后轮次', () => {
  withTemp((root) => {
    const file = path.join(root, 'oversized-budget.v4.jsonl.zstd');
    const f0 = mkZ([head(), start(1, 1000), end(1, 2000)].join('\n') + '\n');
    const big = mkZ('z'.repeat(4096));                            // 压缩后极小，展开 4096 > maxDecompressedBytes=1024
    const pad = crypto.randomBytes(500).toString('base64');       // 让 f2 帧长 > big 帧长
    const f2 = mkZ([start(2, 3000, pad), end(2, 4000)].join('\n') + '\n');
    assert.ok(big.length < 1024, '夹具前提：解压超限帧的压缩帧很小');
    assert.ok(f2.length > big.length, '夹具前提：f2 帧必须长于被跳过的帧');
    fs.writeFileSync(file, Buffer.concat([f0, big, f2]));
    const stopAt = f0.length + big.length;
    const r = readTurnsFrom(file, { maxDecompressedBytes: 1024, maxBytes: stopAt + 1 });

    assert.equal(r.meta.halted, false);
    assert.equal(r.meta.failed, 1, '前提：解压超限帧计 failed=1');
    assert.equal(r.meta.stopped, true);
    assert.equal(r.meta.blocked, false);
    assert.equal(r.meta.lossSkipped, true);
    assert.equal(r.meta.nextOffset, stopAt, 'K-15：预算停在帧边界（缺口之后的下一帧起点）');
    assert.deepEqual(r.closed.map((t) => t.turn), [1]);

    const r2 = readTurnsFrom(file, { maxDecompressedBytes: 1024, fromByte: r.meta.nextOffset, head: r.head });
    assert.deepEqual(r2.closed.map((t) => t.turn), [2], '下一 tick 必须读到缺口之后的轮次');
    assert.equal(r2.meta.nextOffset, fs.statSync(file).size);
  });
});

// 守：坏帧仍按 K-4 停住（K-15 只放行"可跳过"缺口，不得把真坏帧也放行）。
test('K-15：真坏帧不因"缺口契约"被放行 —— 仍 blocked/halted 且游标不越过坏帧', () => {
  withTemp((root) => {
    const file = path.join(root, 'badframe.v4.jsonl.zstd');
    const f0 = mkZ([head(), start(1, 1000), end(1, 2000)].join('\n') + '\n');
    const bad = badFrame();
    const f2 = mkZ([start(2, 3000), end(2, 4000)].join('\n') + '\n');
    fs.writeFileSync(file, Buffer.concat([f0, bad, f2]));
    const r = readTurnsFrom(file);
    assert.equal(r.meta.halted, true);
    assert.equal(r.meta.blocked, true);
    assert.equal(r.meta.lossSkipped, false);
    assert.ok(r.meta.nextOffset <= f0.length, '游标不得越过坏帧');
  });
});
