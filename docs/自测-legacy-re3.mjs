/**
 * @file 自测-legacy-re3.mjs
 * @role v1.0.0-re3 C 线（frames / legacy）验收：
 *       ① CORE-02 解压炸弹（legacy 头部探测/离线核验路径不再无上限解压）；
 *       ② RT-03 读放大（有界头缓存 + 真实读盘度量暴露）；
 *       ③ CORE-01 frames 侧「可跳过帧 / 帧尾偏移」契约（供 ledger 推进游标）；
 *       ④ 回归：17 文件语料 = 29,399 帧 / 0 failed / 0 halted；E3 38.8 MB 大会话多 tick 入账、0 重复。
 * @run `node --test docs/自测-legacy-re3.mjs`（单文件）；或 `node docs/跑测试.mjs docs/自测-legacy-re3.mjs`
 * @depends lite/lib/frames.js、lite/lib/legacy.js；E3 回归用 lite/index.js 的公开入口 runOnce。
 * @writes 只写系统临时目录（os.tmpdir()/dsh-re3-C-selftest*），不碰交付包/账库。
 *
 * ★ G-P0-9（异机可复现）：本文件**不许 skip**。
 *   干净包（另一盘符解压、无 `_工作`）没有开发机语料，所以语料按三候选解析：
 *     ①〈插件包〉\02-语料\sessions  → ②〈插件包同级〉\02-语料\sessions → ③ _工作\_corpus\sessions
 *   都没有 → 现场**合成**等价语料（17 文件 / 16 源 / 1 对 v3+v4 / 多帧，与真实结构同构），
 *   回归断言按"实际语料"取期望值：
 *     · 真实语料（指纹 17 文件 / 50,640,283 B）→ 强化断言 29,399 帧、1,338 行；
 *     · 包内合成等价语料（随包 02-语料，带 `生成记录.json`）→ 按记录逐文件期望（帧数/字节/闭合轮）；
 *     · 自足合成的兜底语料 → 按构造时登记的期望（等价断言：全解、多 tick、0 重复、稳态 0）。
 *
 * 证据口径（与 _工作/证据-re3/C/probe-*.mjs 一一对应）：
 *   · CORE-02 红：probeHead(4,115 B 炸弹) RSS +385 MiB、243 ms、返回 null（静默顶内存）；
 *     绿：reason='output-too-large'、RSS 增量 <8 MiB、~3 ms，且真实头照常解析。
 *   · RT-03 红：2 对并存会话稳态每 tick 真读 1,048,576 B（2×2×256 KiB）、返回值无 stats；
 *     绿：第 2 次起真读 0 B（cacheHits=4/4），`map.stats.bytesRead` 可被 index 计入度量。
 *   · CORE-01 红：frames 的 loss 只有 {start,end,oversized}，ledger 只能 blocked+nextOffset=0；
 *     绿：区间带 skippable/frameEnd/resumeAt，顶层 gapAdvanceable + nextSafeOffset=size。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  streamFrames, decodeFramesFrom,
} from '../lib/frames.js';
import { readTurnsFrom } from '../lib/ledger.js';
import {
  probeHead, probeHeadEx, resolvePairPrefixes,
  summarizeFile, readPrefixEvents,
  scanSessionSources, resetHeadProbeCache, setHeadProbeCacheCaps, getHeadProbeCacheInfo,
  getLastHeadProbeStats,
} from '../lib/legacy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LITE = path.resolve(HERE, '..');
const WORK = path.resolve(LITE, '..');
const TMP = path.join(os.tmpdir(), 'dsh-re3-C-selftest');
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const MiB = (n) => n / 1024 / 1024;
const REAL_CORPUS_BYTES = 50640283;
const REAL_CORPUS_FRAMES = 29399;
const REAL_E3_ROWS = 1338;

// ============================================================================
// 夹具（真 zstd 多帧，与 DSH 会话同构）
// ============================================================================
function freshDir(name) {
  const d = path.join(TMP, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const zframe = (buf) => zlib.zstdCompressSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8'));
const jsonl = (objs) => Buffer.from(objs.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
const sessionHead = (id, createdAt, version) => ({ type: 'session', id, createdAt, version, cwd: 'C:\\re3-C' });
const turnEvents = (turn, t0) => [
  { type: 'turn/start', seq: turn * 2, time: t0, data: { turn } },
  { type: 'turn/end', seq: turn * 2 + 1, time: t0 + 1000, data: { turn, reason: { kind: 'completed' } } },
];

/** 写一份会话文件：首帧含会话头；padFrames 个随机载荷帧（压不动 → 文件够大）。 */
function writeSessionFile(dir, name, { id, createdAt, version, turns = 1, padFrames = 0, padBytes = 96 * 1024 }) {
  fs.mkdirSync(dir, { recursive: true });
  const parts = [zframe(jsonl([sessionHead(id, createdAt, version)]))];
  const events = [];
  for (let t = 1; t <= turns; t++) events.push(...turnEvents(t, createdAt + t * 2000));
  if (events.length) parts.push(zframe(jsonl(events)));
  for (let k = 0; k < padFrames; k++) parts.push(zframe(crypto.randomBytes(padBytes)));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

/** v3+v4 并存对：默认 v3 起点更早（→ 应判"补前缀"）。 */
function writePair(dir, id, { v3Created, v4Created, padFrames = 0 } = {}) {
  const v3 = writeSessionFile(dir, 'session.v3.jsonl.zstd', {
    id, createdAt: v3Created == null ? 1790000000000 : v3Created, version: 3, padFrames,
  });
  const v4 = writeSessionFile(dir, 'session.v4.jsonl.zstd', {
    id, createdAt: v4Created == null ? 1790000001000 : v4Created, version: 4, padFrames,
  });
  return { dir, v3, v4 };
}

/** 128 MiB 解压炸弹（4,115 B；与审计③ 的 4,198 B 同量级）——只造一次。 */
let BOMB = '';
before(() => {
  if (!HAS_ZSTD) return;
  fs.mkdirSync(TMP, { recursive: true });
  BOMB = path.join(TMP, 'bomb-128MiB.zstd');
  if (!fs.existsSync(BOMB)) {
    fs.writeFileSync(BOMB, zlib.zstdCompressSync(Buffer.alloc(128 * 1024 * 1024, 0x78)));
  }
});

const needZstd = { skip: !HAS_ZSTD ? '当前 Node 无 zlib.zstdCompressSync（需要 Node ≥24）' : false };

// ============================================================================
// 一、CORE-02 · 解压炸弹
// ============================================================================
test('CORE-02：probeHead 4 KB→128 MiB 炸弹在分配前被拒（RSS 增量 <8 MiB），真实会话头照常解析', needZstd, () => {
  assert.ok(fs.statSync(BOMB).size < 16 * 1024, '炸弹压缩后必须很小');
  // 缓存关掉，确保这一测量真的走一遍"解压尝试"
  const beforeRss = process.memoryUsage().rss;
  const r = probeHeadEx(BOMB, { cache: false });
  const afterRss = process.memoryUsage().rss;
  assert.equal(r.ok, false);
  assert.equal(r.head, null);
  assert.equal(r.reason, 'output-too-large', '必须是"输出超上限"的结构化拒绝，不是坏帧/读失败');
  assert.equal(r.decompressedBytes, 1024 * 1024, '拒绝时按尝试上限记账（1 MiB），不许按 128 MiB 记');
  const deltaMiB = MiB(afterRss - beforeRss);
  assert.ok(deltaMiB < 8, `炸弹探测 RSS 增量必须 <8 MiB，实际 ${deltaMiB.toFixed(1)} MiB（旧实现 +385 MiB）`);
  // 兼容签名 probeHead 同样拒绝
  assert.equal(probeHead(BOMB), null);

  // 真实会话头：首帧 1 行 → 照常解析，不被上限误伤
  const dir = freshDir('head-good');
  const f = writeSessionFile(dir, 'session.v4.jsonl.zstd', {
    id: 'session-re3c-head', createdAt: 1790000001234, version: 4, turns: 2,
  });
  assert.deepEqual(probeHead(f), { id: 'session-re3c-head', createdAt: 1790000001234, version: 4 });
});

test('CORE-02：resolvePairPrefixes 对炸弹对子整链不 OOM；负结果缓存后每 tick 零读盘/零解压', needZstd, () => {
  resetHeadProbeCache();
  const okPair = writePair(path.join(TMP, 'chain-ok'), 'session-re3c-chain-ok');
  const bombPair = { dir: path.join(TMP, 'chain-bomb'), v3: BOMB, v4: okPair.v4 };
  const pairs = [bombPair, okPair];

  const r1 = resolvePairPrefixes(pairs);
  assert.equal(r1.size, 1, '炸弹对子不产出前缀；正常对子照常判出前缀');
  assert.ok(r1.has(okPair.dir));
  assert.equal(r1.stats.rejected, 1, '炸弹头被拒一次');
  assert.ok(r1.stats.decompressedBytes > 0 && r1.stats.decompressedBytes < 8 * 1024 * 1024,
    '单 tick 解压量必须有界（~1 MiB），实际 ' + r1.stats.decompressedBytes);

  const r2 = resolvePairPrefixes(pairs);
  assert.equal(r2.size, 1);
  assert.equal(r2.stats.bytesRead, 0, '第二次必须零读盘（RT-03）');
  assert.equal(r2.stats.decompressedBytes, 0, '负结果也缓存：炸弹不再尝试解压');
  assert.equal(r2.stats.cacheHits, 4);
});

test('CORE-02：离线核验路径（summarizeFile / readPrefixEvents）同样有界：炸弹计 failed 且不炸进程', needZstd, () => {
  const dir = freshDir('bulk');
  const good = zframe(jsonl([
    sessionHead('session-re3c-bulk', 1790000000000, 3),
    ...turnEvents(1, 1790000001000),
  ]));
  const good2 = zframe(jsonl(turnEvents(2, 1790000002000)));
  const file = path.join(dir, 'bomb-session.v3.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([good, fs.readFileSync(BOMB), good2]));

  const beforeRss = process.memoryUsage().rss;
  const s = summarizeFile(file);
  const deltaMiB = MiB(process.memoryUsage().rss - beforeRss);
  assert.equal(s.failed, 1, '炸弹帧计 failed（不是静默吞掉）');
  assert.equal(s.oversizedDecompressed, 1);
  assert.equal(s.events, 4, '炸弹前后的正常帧必须照常解析（2 轮 = 4 条 turn 事件）');
  // 离线整帧核验用的是"与 frames 同口径"的 64 MiB/帧上限（K-6），炸弹会在**分配前**被拒，
  // 峰值 = 上限 64 MiB + 开销（实测 +64.4 MiB），远小于旧实现的 128 MiB 正文 + 128 MiB 字符串。
  // 每 tick 链路的 <8 MiB 验收在 CORE-02 第 1 条（1 MiB 头部上限）单独断言。
  assert.ok(deltaMiB < 80, '离线核验峰值必须有界（≤64 MiB 上限 + 开销），实际 +' + deltaMiB.toFixed(1) + ' MiB');

  const p = readPrefixEvents(file);
  assert.equal(p.failedFrames, 1);
  assert.equal(p.oversizedDecompressed, 1);
  assert.ok(p.events.length >= 2, '前缀事件照常返回');
  assert.ok(p.bytesRead > 0 && p.bytesRead <= fs.statSync(file).size + 256 * 1024,
    'bytesRead 如实（跳过帧后 frames 会重读一小段尾部，故允许 +1 窗口）；实际 ' + p.bytesRead);
});

test('CORE-02：单 tick 累计解压预算 —— 8 个炸弹对子在 2 MiB 预算下只解到预算就停', needZstd, () => {
  resetHeadProbeCache();
  const okPair = writePair(path.join(TMP, 'budget-ok'), 'session-re3c-budget-ok');
  const dir = freshDir('budget-bombs');
  const pairs = [];
  for (let i = 0; i < 8; i++) {
    const f = path.join(dir, `bomb-${i}.zstd`);
    fs.copyFileSync(BOMB, f);
    pairs.push({ dir: path.join(dir, 'pair-' + i), v3: f, v4: okPair.v4 });
  }
  const budget = 2 * 1024 * 1024; // 远小于 8×1 MiB 的尝试量
  const beforeRss = process.memoryUsage().rss;
  const r = resolvePairPrefixes(pairs, { maxDecompressedBytes: budget });
  const deltaMiB = MiB(process.memoryUsage().rss - beforeRss);
  assert.ok(r.stats.decompressedBytes <= budget,
    `累计解压 ${r.stats.decompressedBytes} 必须 ≤ 预算 ${budget}（旧实现无此概念：8×128 MiB）`);
  assert.equal(r.stats.budgetExhausted, true);
  assert.ok(r.stats.skippedPairs.filter((x) => x.reason === 'decompress-budget').length >= 5,
    '预算耗尽后剩下的对子必须显式跳过（下一 tick 再判），不许硬解');
  assert.ok(deltaMiB < 16, '8 个炸弹也顶不爆内存，实际 +' + deltaMiB.toFixed(1) + ' MiB');
  assert.equal(getLastHeadProbeStats().budgetExhausted, true, '度量快照可被 index 读取');
});

test('CORE-02：被"剩余预算"压小的拒绝**不写缓存**（否则会把正常头误存成永久负结论）', needZstd, () => {
  resetHeadProbeCache();
  const dir = freshDir('limited');
  const id = 'session-re3c-limited';
  // 头故意做大到 ~4.4 KB：小额预算下解压必然超限 → 只能判"预算不足"，不能判"坏头"
  const bigHead = { type: 'session', id, createdAt: 1790000000000, version: 3, cwd: 'C:\\' + 'x'.repeat(4096) };
  const v3 = path.join(dir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(v3, zframe(jsonl([bigHead])));
  const v4 = writeSessionFile(dir, 'session.v4.jsonl.zstd', { id, createdAt: 1790000001000, version: 4 });

  const r1 = resolvePairPrefixes([{ dir, v3, v4 }], { maxDecompressedBytes: 2000 });
  assert.equal(r1.stats.budgetExhausted, true);
  assert.ok(r1.stats.skippedPairs.some((x) => x.reason === 'decompress-budget'));
  assert.equal(getHeadProbeCacheInfo().size, 0, '预算压小的拒绝不得写缓存（负结论会污染下一 tick）');
  assert.equal(r1.size, 0, '本 tick 判不出就不给结论（宁可延后，不许误判）');

  const r2 = resolvePairPrefixes([{ dir, v3, v4 }]);
  assert.equal(r2.stats.rejected, 0, '预算恢复后必须照常解析（没被负缓存污染）');
  assert.ok(r2.has(dir), 'v3 起点更早 → 必须判出"补前缀"');
});

// ============================================================================
// 二、RT-03 · 读放大（有界头缓存 + 真实读盘）
// ============================================================================
test('RT-03：有界头缓存 —— 第 2 次零读盘（stats.bytesRead=0）、stats 非枚举、Map 旧契约不变', needZstd, () => {
  resetHeadProbeCache();
  setHeadProbeCacheCaps({ maxEntries: 64 });
  const p1 = writePair(path.join(TMP, 'cache-a'), 'session-re3c-cache-a', { padFrames: 3 });
  const p2 = writePair(path.join(TMP, 'cache-b'), 'session-re3c-cache-b', { padFrames: 3 });
  const pairs = [p1, p2];

  const r1 = resolvePairPrefixes(pairs);
  assert.ok(r1 instanceof Map, '返回形状仍是 Map（旧调用方零改动）');
  assert.equal(Object.keys(r1).length, 0, 'stats 必须非枚举，不污染 Object.keys/deepEqual');
  assert.ok(r1.stats, '必须暴露 stats（index 度量契约）');
  assert.equal(r1.stats.bytesRead, 2 * 2 * 16 * 1024, '首次探测：4 个文件 × 16 KiB 首窗口（旧实现 4×256 KiB）');
  assert.ok(r1.stats.bytesRead > 0);

  const r2 = resolvePairPrefixes(pairs);
  assert.equal(r2.stats.bytesRead, 0, '命中缓存零读盘（RT-03 验收点）');
  assert.equal(r2.stats.cacheHits, 4);
  assert.equal(r2.stats.cacheMisses, 0);
  assert.deepEqual([...r2.keys()].sort(), [p1.dir, p2.dir].sort());

  // 追加内容（size/mtime 变）→ 缓存必须失效、重新读
  const fd = fs.openSync(p2.v3, 'a');
  fs.writeSync(fd, zframe(jsonl(turnEvents(3, 1790000009000))));
  fs.closeSync(fd);
  const r3 = resolvePairPrefixes(pairs);
  assert.ok(r3.stats.bytesRead > 0, '文件变了必须失效重读（key 含 size+mtime+头部 sha256）');
  assert.ok(r3.stats.cacheMisses > 0);

  // 只改 mtime（size 不变）也要失效
  const r4 = resolvePairPrefixes(pairs);
  assert.equal(r4.stats.bytesRead, 0);
  fs.utimesSync(p1.v3, new Date(), new Date(Date.now() + 5000));
  const r5 = resolvePairPrefixes(pairs);
  assert.ok(r5.stats.bytesRead > 0, 'mtime 变化必须失效（mtime 是缓存 key 的一部分）');
});

test('RT-03：LRU 上限生效（64 项默认；测试压到 2 项 → 淘汰最久未用）', needZstd, () => {
  resetHeadProbeCache();
  setHeadProbeCacheCaps({ maxEntries: 2 });
  const pairs = [];
  for (let i = 0; i < 3; i++) {
    pairs.push(writePair(path.join(TMP, 'lru-' + i), 'session-re3c-lru-' + i));
  }
  resolvePairPrefixes(pairs); // 6 个文件 → 上限 2
  const info = getHeadProbeCacheInfo();
  assert.equal(info.size, 2, 'LRU 上限必须生效，实际 ' + info.size);
  assert.ok(info.evictions >= 4, '必须有淘汰计数，实际 ' + info.evictions);
  setHeadProbeCacheCaps({ maxEntries: 64 }); // 恢复默认，避免影响后续用例
  resetHeadProbeCache();
});

// ============================================================================
// 三、CORE-01 · frames 侧「可跳过帧 / 帧尾偏移」契约
// ============================================================================
test('CORE-01：解压超限帧 → failedRanges 带 skippable/frameEnd/resumeAt；gapAdvanceable=true、nextSafeOffset=size', needZstd, () => {
  const dir = freshDir('core01-a');
  const good = zframe(jsonl([sessionHead('session-re3c-core01', 1790000000000, 4), ...turnEvents(1, 1790000001000)]));
  const good2 = zframe(jsonl(turnEvents(2, 1790000002000)));
  const file = path.join(dir, 's.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([good, fs.readFileSync(BOMB), good2]));
  const size = fs.statSync(file).size;

  const r = decodeFramesFrom(file, 0);
  assert.equal(r.failed, 1);
  assert.equal(r.halted, false, '解压超限不是坏帧（K-6 口径不变）');
  const skip = r.failedRanges.find((x) => x && x.oversizedDecompressed);
  assert.ok(skip, '必须有超出上限的区间');
  assert.equal(skip.skippable, true, '★ 契约：可跳过（供 ledger 推进游标）');
  assert.equal(skip.frameEnd, skip.end, '★ 契约：帧尾偏移');
  assert.equal(skip.resumeAt, skip.end, '★ 契约：安全续读点');
  assert.equal(skip.reason, 'oversized-decompressed');
  assert.equal(r.gapAdvanceable, true, '★ 契约：唯一布尔 —— 有缺口但可推进');
  assert.equal(r.nextSafeOffset, size, '★ 契约：本次最多可推进到文件尾');
  assert.equal(r.ok, 2, '跳过之后的好帧照常解出');
  assert.ok(r.oversizedDecompressed >= 1 && r.decompressLimitBytes === 64 * 1024 * 1024);
  // bytesRead = 真实读盘：跳过帧后 frames 会从帧尾再读一小段（小文件里 = 尾部 111 B 重读），
  // 所以这里只能断言"≥ 文件大小、且不超过 size+一个窗口"（真实语料无跳过 → 恰好等于 size，见回归用例）。
  assert.ok(r.bytesRead >= size && r.bytesRead <= size + 8 * 1024 * 1024,
    'bytesRead 必须如实且不越界：' + r.bytesRead + ' vs size ' + size);

  // ★ CORE-01 端到端（与 B 线 ledger 契约对齐）：可跳过缺口不再把整份会话判 blocked。
  //   B 线消费本契约的落点：readTurnsFrom 的 hasGap 分支（gapAdvanceable → 推进游标、blocked=false）。
  const led = readTurnsFrom(file, { fromByte: 0 });
  assert.equal(led.meta.blocked, false, 'CORE-01 端到端：仅"可跳过"缺口时不得 blocked');
  assert.equal(led.meta.nextOffset, size, '游标必须推进到安全偏移（不再是 0 = 每 tick 全量重扫）');
  assert.equal(led.loss.gapAdvanceable, true, 'loss 必须透传 gapAdvanceable（B 线 buildLoss）');
  assert.equal(led.loss.nextSafeOffset, size, 'loss 必须透传 nextSafeOffset');
  assert.ok(led.loss.reasons.includes('oversized-frame'), '缺口仍要如实进 loss（不静默）');
});

test('CORE-01：超大压缩帧（maxFrameBytes 超限）同样带 skippable/frameEnd；坏帧则**不带**且 gapAdvanceable=false', needZstd, () => {
  const dir = freshDir('core01-b');
  // 超大压缩帧：随机 2 KiB 压不动（帧长 > 1000），两帧都超 → 全跳过、不 halt
  const big1 = zframe(crypto.randomBytes(2048));
  const big2 = zframe(crypto.randomBytes(2048));
  const fBig = path.join(dir, 'big.zstd');
  fs.writeFileSync(fBig, Buffer.concat([big1, big2]));
  const rBig = streamFrames(fBig, 0, () => {}, { maxFrameBytes: 1000 });
  assert.equal(rBig.failed, 2);
  assert.equal(rBig.halted, false, '超大帧不是坏帧（P1-3 契约不变）');
  for (const x of rBig.failedRanges) {
    assert.equal(x.skippable, true);
    assert.ok(Number.isInteger(x.frameEnd) && x.frameEnd === x.end);
    assert.equal(x.resumeAt, x.frameEnd);
  }
  assert.equal(rBig.gapAdvanceable, true);
  assert.equal(rBig.nextSafeOffset, fs.statSync(fBig).size);

  // 坏帧（保留块类型，结构不可信）：必须 halted、不得标 skippable
  const n1 = zframe(jsonl(turnEvents(1, 1790000001000)));
  const n2 = zframe(jsonl(turnEvents(2, 1790000002000)));
  const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x07, 0x00, 0x00]); // magic + FHD + 保留块类型
  const fBad = path.join(dir, 'bad.zstd');
  fs.writeFileSync(fBad, Buffer.concat([n1, bad, n2]));
  const rBad = decodeFramesFrom(fBad, 0);
  assert.equal(rBad.halted, true);
  assert.equal(rBad.gapAdvanceable, false, '坏帧不可跳过：游标不许越过 haltOffset');
  assert.equal(rBad.nextSafeOffset, rBad.haltOffset, '坏帧场景 nextSafeOffset = 坏帧起点');
  const badRange = rBad.failedRanges.find((x) => x.start === n1.length);
  assert.ok(badRange);
  assert.equal(badRange.skippable, undefined, '坏帧不得标可跳过');
  assert.equal(badRange.frameEnd, undefined);

  // 预算停在帧边界：nextSafeOffset = stoppedAt，且不是 gap
  const f3 = path.join(dir, 'three.zstd');
  const f1 = zframe(jsonl(turnEvents(1, 1790000001000)));
  fs.writeFileSync(f3, Buffer.concat([f1, n1, n2]));
  const st = streamFrames(f3, 0, () => {}, { maxBytes: f1.length + 1 });
  assert.equal(st.stopped, true);
  assert.equal(st.nextSafeOffset, st.stoppedAt);
  assert.equal(st.gapAdvanceable, false);
});

// ============================================================================
// 四、语料解析（G-P0-9 异机可复现：干净包没有 `_工作`，**不许 skip**）
// ============================================================================
/** 递归列出会话文件（与 scanSessionSources 同口径的"会话文件"定义）。 */
function walkSessionFiles(root, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkSessionFiles(p, out);
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 随包合成等价语料会带 `<02-语料>/生成记录.json`：有它就按记录取期望（帧数/字节/闭合轮）。 */
function readCorpusRecord(sessionsDir) {
  const p = path.join(path.dirname(sessionsDir), '生成记录.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && Array.isArray(j.files) && j.files.length > 0) return j;
  } catch { /* 没有记录就走结构指纹/构造期望 */ }
  return null;
}

/**
 * 自足兜底：合成"与真实语料同构"的小规模等价语料。
 * 结构：17 个会话文件 / 16 个源目录（c01 4 + c02 1 + c03 11）/ 1 对 v3+v4 / 全部多帧；
 * 另造一个 30 轮、多帧的"E3 等价大会话"，用于验证"多 tick 分片入账、0 重复、稳态 0"。
 */
function buildSynthCorpus() {
  const root = path.join(TMP, 'synth-corpus');
  fs.rmSync(root, { recursive: true, force: true });
  const sessions = path.join(root, 'sessions');
  const meta = { files: 0, bytes: 0, frames: 0, big: null };
  const T0 = Date.parse('2026-09-24T09:00:00+08:00');
  const headFrame = (sid, version) => zframe(jsonl([sessionHead(sid, T0, version)]));
  const turnFrames = (turns, perFrame = 3) => {
    const out = [];
    for (let i = 0; i < turns.length; i += perFrame) {
      const evs = [];
      for (const t of turns.slice(i, i + perFrame)) evs.push(...turnEvents(t, T0 + t * 2000));
      out.push(zframe(jsonl(evs)));
    }
    return out;
  };
  const write = (short, sid, version, turns, extraFrames = 0) => {
    const frames = [headFrame(sid, version), ...turnFrames(turns)];
    for (let k = 0; k < extraFrames; k++) frames.push(zframe(crypto.randomBytes(1024)));
    const dir = path.join(sessions, short, sid);
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.concat(frames);
    const file = path.join(dir, `session.v${version}.jsonl.zstd`);
    fs.writeFileSync(file, buf);
    meta.files++;
    meta.bytes += buf.length;
    meta.frames += frames.length;
    return { path: file, bytes: buf.length, frames: frames.length };
  };
  // c01：4 个 v4-only
  for (let i = 1; i <= 4; i++) {
    const sid = `session-1111111${i}-1111-4111-8111-11111111111${i}`;
    write('c01', sid, 4, [1, 2]);
  }
  // c02：1 个 v4-only（多一帧随机载荷）
  const s02 = 'session-22222222-2222-4222-8222-222222222221';
  write('c02', s02, 4, [1, 2, 3], 1);
  // c03：5 个 v3-only（裸 uuid 目录，与真实语料同构）
  for (let i = 1; i <= 5; i++) {
    const sid = `3333333${i}-3333-4333-8333-33333333333${i}`;
    write('c03', sid, 3, [1, 2]);
  }
  // c03：4 个 v4-only
  for (let i = 1; i <= 4; i++) {
    const sid = `session-4444444${i}-4444-4444-8444-44444444444${i}`;
    write('c03', sid, 4, [1, 2, 3]);
  }
  // c03：E3 等价大会话（60 闭合轮 / 多帧；用于"多 tick 分片入账"，体积 > 2×单 tick 预算）
  const bigSid = 'session-55555555-5555-4555-8555-555555555555';
  const bigTurns = Array.from({ length: 60 }, (_, i) => i + 1);
  meta.big = write('c03', bigSid, 4, bigTurns);
  meta.big.turns = bigTurns.length;
  // c03：1 对 v3+v4 并存（createdAt 相同 → 无需补前缀，与真实语料同构）
  const pairSid = 'session-66666666-6666-4666-8666-666666666666';
  write('c03', pairSid, 3, [1, 2]);
  write('c03', pairSid, 4, [1, 2, 3]);
  return { root, sessions, meta };
}

/** 语料解析：包内 → 包同级 → 开发机 `_work/_corpus`；都没有 → 合成（不 skip）。 */
function resolveCorpus() {
  const candidates = [
    path.join(LITE, '02-语料', 'sessions'),          // ① 插件包内（若语料被打进插件目录）
    path.join(WORK, '02-语料', 'sessions'),          // ② 包同级（交付包标准布局：<包>/02-语料）
    path.join(WORK, '_corpus', 'sessions'),          // ③ 开发机 `_工作/_corpus`
    path.join(WORK, '素材', '02-语料-合成', 'sessions'),
    path.join(WORK, '素材', '02-语料', 'sessions'),
  ];
  for (const dir of candidates) {
    const files = walkSessionFiles(dir);
    if (files.length > 0) return { mode: 'corpus', dir, files, record: readCorpusRecord(dir) };
  }
  const syn = buildSynthCorpus();
  return { mode: 'synthetic', dir: syn.sessions, files: walkSessionFiles(syn.sessions), record: null, synth: syn.meta };
}

const CORPUS = resolveCorpus();
const CORPUS_BYTES = CORPUS.files.reduce((a, p) => a + fs.statSync(p).size, 0);
const IS_REAL_CORPUS = CORPUS.mode === 'corpus' &&
  CORPUS.files.length === 17 && CORPUS_BYTES === REAL_CORPUS_BYTES;

/** 期望值：真实语料用指纹强化；随包合成语料用生成记录；自足合成用构造登记。 */
const CORPUS_EXPECT = (() => {
  if (IS_REAL_CORPUS) {
    return { files: 17, bytes: REAL_CORPUS_BYTES, frames: REAL_CORPUS_FRAMES, kind: 'real' };
  }
  if (CORPUS.record) {
    const sumFrames = CORPUS.record.files.reduce((a, f) => a + (Number(f.synFrames) || 0), 0);
    const sumBytes = CORPUS.record.files.reduce((a, f) => a + (Number(f.synBytes) || 0), 0);
    if (sumFrames > 0 && sumBytes > 0) {
      return { files: CORPUS.record.files.length, bytes: sumBytes, frames: sumFrames, kind: 'package-synth' };
    }
  }
  if (CORPUS.mode === 'synthetic') {
    return { files: CORPUS.synth.files, bytes: CORPUS.synth.bytes, frames: CORPUS.synth.frames, kind: 'self-synth' };
  }
  return { files: 17, bytes: null, frames: null, kind: 'other' };
})();

test('语料解析：三候选 + 合成兜底 —— 干净包（无 _工作）也不 skip，且结构等价（17 文件 / 16 源 / 1 对 v3+v4）', () => {
  assert.ok(CORPUS.files.length === 17, '语料必须是 17 个会话文件（实际 ' + CORPUS.files.length + '，来源 ' + CORPUS.mode + ':' + CORPUS.dir + '）');
  const sc = scanSessionSources(CORPUS.dir);
  assert.equal(sc.supported.length, 16, '历史源必须是 16 个（实际 ' + sc.supported.length + '）');
  assert.equal(sc.pairs.length, 1, '必须恰有 1 对 v3+v4 并存（实际 ' + sc.pairs.length + '）');
  if (CORPUS_EXPECT.bytes !== null) {
    assert.equal(CORPUS_BYTES, CORPUS_EXPECT.bytes,
      `语料总字节必须与期望一致（kind=${CORPUS_EXPECT.kind}）`);
  }
});

// ============================================================================
// 五、回归 · 语料 frames（真实 = 29,399 帧 / 0 failed / 0 halted；合成 = 逐文件期望一致）
// ============================================================================
test('回归：语料 frames 全解 —— failed=0 / halted=0 / bytesRead=Σ文件字节，总帧数与语料期望一致（生成记录或指纹）', () => {
  let frames = 0;
  let failed = 0;
  let halted = 0;
  let bytes = 0;
  let oversized = 0;
  for (const f of CORPUS.files) {
    const size = fs.statSync(f).size;
    const st = streamFrames(f, 0, () => {});
    assert.equal(st.failed, 0, 'failed>0：' + f);
    assert.equal(st.halted, false, 'halted：' + f);
    assert.equal(st.badMagic, false, 'badMagic：' + f);
    assert.equal(st.bytesRead, size, '每个文件恰好完整读一遍：' + f);
    assert.ok(st.frames > 0, '每帧文件至少 1 帧：' + f);
    frames += st.frames;
    failed += st.failed;
    halted += st.halted ? 1 : 0;
    oversized += st.oversizedDecompressed || 0;
    bytes += size;
  }
  assert.equal(failed, 0);
  assert.equal(halted, 0);
  assert.equal(oversized, 0, '正常语料不得触发解压上限（0 假阳性）');
  assert.equal(bytes, CORPUS_BYTES);
  if (CORPUS_EXPECT.frames !== null) {
    assert.equal(frames, CORPUS_EXPECT.frames,
      `总帧数必须与期望一致（kind=${CORPUS_EXPECT.kind}）：实际 ${frames} / 期望 ${CORPUS_EXPECT.frames}`);
  }
  if (IS_REAL_CORPUS) {
    // 真实语料强化断言（审计③回归基准，改前改后必须逐字段一致）
    assert.equal(frames, 29399, '真实语料总帧数必须仍是 29,399');
    assert.equal(bytes, 50640283, '真实语料总字节 50,640,283');
  }
});

test('回归：语料头探测 —— 16 个历史源头全部可解析；并存对首次读 32 KiB（旧实现 512 KiB）且不误判', () => {
  resetHeadProbeCache();
  const sc = scanSessionSources(CORPUS.dir);
  for (const e of sc.supported) {
    const h = probeHead(e.path);
    assert.ok(h && typeof h.id === 'string' && h.id.length > 0, '头必须可解析：' + e.path);
    assert.ok(h.version === 3 || h.version === 4, '版本必须是 3/4：' + e.path);
  }
  resetHeadProbeCache();
  const r1 = resolvePairPrefixes(sc.pairs);
  assert.equal(r1.stats.rejected, 0, '语料不得被上限误拒');
  // 首次探测每个头只读"一个 16 KiB 首窗口"（文件不足 16 KiB 则读整个文件）——旧实现是 256 KiB/头。
  const pv3 = fs.statSync(sc.pairs[0].v3).size;
  const pv4 = fs.statSync(sc.pairs[0].v4).size;
  const expectedProbeRead = Math.min(16 * 1024, pv3) + Math.min(16 * 1024, pv4);
  assert.equal(r1.stats.bytesRead, expectedProbeRead,
    '两个头各一个 16 KiB 首窗口（旧实现 2×256 KiB）：实际 ' + r1.stats.bytesRead + ' / 期望 ' + expectedProbeRead);
  const r2 = resolvePairPrefixes(sc.pairs);
  assert.equal(r2.stats.bytesRead, 0, '稳态零重读');
});

// ============================================================================
// 六、回归 · E3 38.8 MB：多 tick 分片入账、0 重复、稳态 0
//   真实语料：3 tick 入账 1,338 行（强化断言）；
//   随包合成等价语料：按生成记录（synClosedTurns）与体积/预算推期望 tick 数；
//   自足合成语料：小规模多帧会话、按构造登记（等价断言）。
// ============================================================================
test('回归：E3 大会话 —— 多 tick 分片入账、0 重复、随后稳态 written=0（真实语料 = 3 tick / 1,338 行）',
  { timeout: 300000 }, async () => {
    // 取语料里最大的 v4 文件（真实/随包合成 = E3，约 38.8 MB；自足合成 = 30 轮小会话）
    const v4s = CORPUS.files
      .filter((p) => p.endsWith('.v4.jsonl.zstd'))
      .map((p) => ({ p, size: fs.statSync(p).size }))
      .sort((a, b) => b.size - a.size);
    const src = v4s[0];
    assert.ok(src, '语料里必须有 v4 会话');
    const srcRel = path.relative(CORPUS.dir, src.p).split(path.sep).join('/');
    const rec = CORPUS.record
      ? CORPUS.record.files.find((f) => f && f.synRel === srcRel)
      : null;

    // 期望闭合轮数：真实/随包合成 = 生成记录或指纹；自足合成 = 构造登记；其它 = 现场解析
    let expectedTurns;
    let expectedKind;
    if (IS_REAL_CORPUS) {
      expectedTurns = REAL_E3_ROWS;
      expectedKind = 'real';
    } else if (rec && Number(rec.synClosedTurns) > 0) {
      expectedTurns = Number(rec.synClosedTurns);
      expectedKind = 'package-synth';
    } else if (CORPUS.mode === 'synthetic') {
      expectedTurns = CORPUS.synth.big.turns;
      expectedKind = 'self-synth';
    } else {
      const turns = readTurnsFrom(src.p, { fromByte: 0 });
      expectedTurns = Array.isArray(turns.closed) ? turns.closed.length : 0;
      expectedKind = 'other';
    }
    assert.ok(expectedTurns > 0, '期望闭合轮数必须可确定（kind=' + expectedKind + '）');

    // 每 tick 会话字节预算：真实/随包合成按 lead lab 口径 16 MiB；自足合成按"半个文件"造出"多 tick"
    const realSized = IS_REAL_CORPUS || (expectedKind === 'package-synth' && src.size > 32 * 1024 * 1024);
    const perSessionCap = realSized ? 16 * 1024 * 1024 : Math.max(1024, Math.floor(src.size / 2));
    const ticksToRun = realSized ? 5 : 6;

    const lab = path.join(os.tmpdir(), 'dsh-re3-C-selftest-e3');
    fs.rmSync(lab, { recursive: true, force: true });
    const root = path.join(lab, 'root');
    const home = path.join(lab, 'dsh-home');
    const sessions = path.join(home, 'sessions');
    const sid = path.basename(path.dirname(src.p));
    const dstDir = path.join(sessions, 'wsE3', sid);
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src.p, path.join(dstDir, 'session.v4.jsonl.zstd'));

    const savedHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const cfg = {
      root, enabled: true, intervalSeconds: 60, offsetMinutes: 480,
      hotWindowSeconds: 0, quietSeconds: 0, scanBudgetMs: 0,
      maxBytesPerSession: perSessionCap,
      checkupEnabled: false, weeklyEnabled: false, handoverEnabled: false, receiptAnchorRoot: '',
    };
    const perTick = [];
    let sumWritten = 0;
    try {
      const mod = await import(pathToFileURL(path.join(LITE, 'index.js')).href);
      for (let i = 0; i < ticksToRun; i++) {
        const st = await mod.runOnce({ logger: quiet }, cfg);
        assert.ok(Array.isArray(st.errors) && st.errors.length === 0,
          'tick' + (i + 1) + ' 不得有错误：' + JSON.stringify(st.errors && st.errors.slice(0, 3)));
        perTick.push(Number(st.written) || 0);
        sumWritten += Number(st.written) || 0;
      }
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    }

    // ① 入账轮数 = 期望闭合轮数（真实 = 1,338；随包合成 = 记录；自足合成 = 30）
    assert.equal(sumWritten, expectedTurns,
      `${expectedKind}：${ticksToRun} 个 tick 合计必须入账 ${expectedTurns} 行，实际 ${sumWritten}（逐 tick ${perTick.join('/')}）`);
    if (IS_REAL_CORPUS) {
      assert.equal(sumWritten, 1338, '真实语料强化断言：3 tick 入账 1,338 行');
    }
    // ② 分片：真实/随包合成（38.8 MB @16 MiB）= 恰好 3 个入账 tick；其后稳态 written=0
    const ingestTicks = perTick.filter((w) => w > 0).length;
    if (realSized) {
      const expectTicks = Math.ceil(src.size / perSessionCap);
      if (IS_REAL_CORPUS) assert.equal(expectTicks, 3, '真实 E3 语料 38.8 MB @ 16 MiB 预算应是 3 tick 读完');
      assert.equal(ingestTicks, expectTicks,
        `应有 ${expectTicks} 个入账 tick（${src.size} B @ ${perSessionCap} B/tick），实际 ` + perTick.join('/'));
      assert.ok(perTick.slice(0, expectTicks).every((w) => w > 0), '前 ' + expectTicks + ' tick 都必须有入账：' + perTick.join('/'));
      assert.ok(perTick.slice(expectTicks).every((w) => w === 0), '入账完成后必须稳态 written=0：' + perTick.join('/'));
    } else {
      assert.ok(ingestTicks >= 2, '等价断言：必须"多 tick 分片入账"（≥2 个 tick 有入账），实际 ' + perTick.join('/'));
      assert.ok(perTick.slice(ingestTicks).every((w) => w === 0), '入账完成后必须稳态 written=0：' + perTick.join('/'));
    }

    // ③ 台账：行数 = 入账数、0 坏行、0 重复（sid+turn 唯一）
    const ledgerDir = path.join(root, 'ledger');
    const rows = [];
    let badLines = 0;
    for (const n of fs.readdirSync(ledgerDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))) {
      for (const line of fs.readFileSync(path.join(ledgerDir, n), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { badLines++; }
      }
    }
    assert.equal(badLines, 0);
    assert.equal(rows.length, expectedTurns, '台账行数必须等于期望闭合轮数，实际 ' + rows.length);
    const uniq = new Set(rows.map((r) => String(r.sid) + '|' + String(r.turn)));
    assert.equal(uniq.size, rows.length, '0 重复：(sid,turn) 唯一数必须等于行数，实际 ' + uniq.size + '/' + rows.length);
  });
