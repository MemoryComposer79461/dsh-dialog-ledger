/**
 * @file 自测-C25聚合预算.mjs
 * @role C25「整 tick 聚合消费硬预算」回归自测（第一台审计 §3 红项 2；S-9① 口径）。
 *
 * @背景 旧实现只有"每会话 16 MiB"+"tick 已消费 ≥17 MiB 才不开新会话"两道闸；
 *       但 lib/frames.js 的 `maxBytes` 是**帧边界预算**——`consumed === 0` 时第一帧
 *       无论多大都整帧读出。17 源同 tick 实测：tick1 聚合 17,826,010 B、tick2
 *       18,062,738 B，双双越过 17 MiB 硬顶（S-9①：单 tick 消费 ≤17,825,792 B）。
 *
 * @本自测守三件事（与任务验收对齐）：
 *   ① 单 tick 上限：把 tick 预算烧到接近硬顶后，再遇到"第一帧比剩余额度大"的源 →
 *      必须**整会话延后**（byteDeferredSessions>0 / budget.saturated=true / consumed 仍 ≤ 17 MiB）。
 *      反证：旧实现此时会再整帧读入 → consumed 越过硬顶（本用例数据设计成"再多一帧必越"）。
 *   ② 跨 tick 不漏：同一会话被字节预算截断后，游标停在已提交前缀（partialCommit），
 *      下一 tick 续读；跑够 tick 后**行数必须齐**（少一行都算失败）。
 *   ③ 0 重复：台账 code / (sid,turn) 唯一数 = 行数；跑完后再 tick 一次 written=0。
 *
 * @口径注 ① 的 tick 预算是 index.js 的模块常量（17 MiB，不可配置）：所以用"无效源"
 *       把源消费真实烧到硬顶（不落账行），这样能用最小磁盘/时间代价精确打穿旧缺陷。
 *       ②/③ 用 `maxBytesPerSession` 制造**同一条**"字节预算截断 → partialCommit → 续跑"
 *       路径（预算维不同，恢复机制完全相同），避免为自测再造 20 MB 有效语料。
 *
 * 用法：node docs\自测-C25聚合预算.mjs
 * 退出码：0=全过；1=有失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { runOnce } from '../index.js';
import { readAll, ledgerDir } from '../lib/ledger.js';

// 与 index.js 的 S-9 常量同口径（不在 index 导出常量：测试按判据原文钉死数字）。
const TICK_READ_BUDGET_BYTES = 17 * 1024 * 1024; // 17,825,792 B（S-9① 单 tick 消费硬顶）
const READ_AMP_LIMIT_BYTES = 40 * 1024 * 1024;   // S-9① 读放大 ≤2.5×（判据 C25 同值）
const OFFSET_MINUTES = 480;
const SESSION_FILE = 'session.v4.jsonl.zstd';
/** 会话开始时刻（固定，避免依赖本机时区/当前时间）。 */
const BASE_MS = Date.UTC(2026, 8, 30, 16, 0, 0); // 2026-10-01 00:00:00 +08:00

/** 建临时 lab（root + DSH_HOME），跑完删干净；绝不污染真实目录。 */
async function withLab(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-c25-'));
  assert.match(path.basename(root), /^dl-c25-/);
  const dshHome = path.join(root, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const dataRoot = path.join(root, 'data');
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ root, dshHome, dataRoot });
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 假 logger：不刷终端，但要能拿到 warn。 */
function fakeLogger() {
  const warnLines = [];
  return { warnLines, info() {}, warn: (...a) => warnLines.push(a.join(' ')) };
}

/** runOnce 需要的"已解析配置"（与其它自测同口径；不新增配置键）。 */
function makeCfg(root, over = {}) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: OFFSET_MINUTES,
    hotWindowSeconds: 0, // 0 = 不过滤，所有会话都看
    quietSeconds: 120,
    ...over,
  };
}

const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const sidFor = (i) => 'session-c25' + String(i).padStart(5, '0') + '-0000-4000-8000-00000000000' + (i % 10);

/** 写一个会话文件（frames = 每帧若干行）；返回绝对路径。 */
function writeSessionFile(dshHome, sid, frames) {
  const dir = path.join(dshHome, 'sessions', '--c25--', sid);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);
  const head = JSON.stringify({ type: 'session', id: sid, createdAt: BASE_MS, cwd: 'C:\\lab\\c25', agentPreset: 'lab-c25' });
  fs.writeFileSync(p, Buffer.concat([frame([head]), ...frames.map((ls) => frame(ls))]));
  return p;
}

/** 写一个"无效源"（单帧，内容为随机字节）：readTurnsFrom 会消费整份文件但报 bad-head。 */
function writeInvalidSessionFile(dshHome, sid, sizeBytes) {
  const dir = path.join(dshHome, 'sessions', '--c25--', sid);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);
  fs.writeFileSync(p, zlib.zstdCompressSync(crypto.randomBytes(sizeBytes)));
  return p;
}

/** 读 `<root>/ledger/.tick-metrics.jsonl` 的逐 tick 记录。 */
function readTickMetrics(root) {
  const p = path.join(ledgerDir(root), '.tick-metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  const records = lines.map((l) => JSON.parse(l)); // 坏行会直接抛（自测要求 0 坏行）
  return records;
}

/** 读全部台账行（按日文件）。 */
function readLedgerRows(root) {
  return readAll(root).records;
}

/** 生成"有效会话"的帧数组：每个 turn = start / 一条随机正文 user/message / end。 */
function validTurnFrames(turnCount, payloadBytes) {
  const frames = [];
  for (let i = 1; i <= turnCount; i++) {
    const t = BASE_MS + i * 1000;
    frames.push([JSON.stringify({ type: 'turn/start', time: t, data: { turn: i } })]);
    const text = crypto.randomBytes(payloadBytes).toString('base64');
    frames.push([JSON.stringify({
      type: 'user/message',
      time: t + 1,
      seq: i,
      data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    })]);
    frames.push([JSON.stringify({ type: 'turn/end', time: t + 2, data: { turn: i, reason: { kind: 'stop' } } })]);
  }
  return frames;
}

// ============================================================================
// ① 单 tick 上限：烧到接近 17 MiB 后，遇到"第一帧 > 剩余额度"的源必须延后，不许越界
// ============================================================================
test('C25-① 单 tick 上限：17 源聚合消费 ≤17,825,792 B；放不下的会话整会话延后（旧实现必越界）', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    // 18 个 1 MB 单帧无效源：前 17 个可把 tick 消费烧到 ~17,000,000 B，
    // 第 18 个的第一帧(1 MB) 比剩余额度大 → 旧实现会整帧读入 → 聚合 ~18,000,000 B > 硬顶。
    const FILLER = 18;
    const FRAME_BYTES = 1000 * 1000;
    for (let i = 0; i < FILLER; i++) writeInvalidSessionFile(dshHome, sidFor(i), FRAME_BYTES);

    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    assert.ok(stat.consumedSourceBytes > 16 * 1024 * 1024,
      '前置：本 tick 必须真的把预算烧到接近硬顶（实际 ' + stat.consumedSourceBytes + ' B）');
    assert.ok(stat.consumedSourceBytes <= TICK_READ_BUDGET_BYTES,
      '★ 单 tick 聚合消费必须 ≤17 MiB：' + stat.consumedSourceBytes + ' > ' + TICK_READ_BUDGET_BYTES);
    assert.ok(stat.written === 0, '前置：无效源不得落账行（written=' + stat.written + '）');
    assert.ok(stat.byteDeferredSessions >= 1,
      '★ 放不下的会话必须整会话延后（byteDeferredSessions=' + stat.byteDeferredSessions + '）');
    assert.ok(stat.probeBytes > 0, '★ 截断前必须先探测第一帧（probeBytes=' + stat.probeBytes + '）');

    const ticks = readTickMetrics(dataRoot);
    assert.equal(ticks.length, 1, '应只跑 1 tick');
    const t = ticks[0];
    assert.equal(t.io.consumedSourceBytes, stat.consumedSourceBytes,
      '.tick-metrics 的 consumedSourceBytes 必须等于 stat（不许少报/两套口径）');
    assert.ok(t.io.consumedSourceBytes <= TICK_READ_BUDGET_BYTES, '.tick-metrics 消费越界');
    assert.equal(t.budget.saturated, true, '旧口径会写 saturated:false —— 字节预算延后必须算饱和');
    assert.ok(t.budget.deferredSessions >= 1,
      'budget.deferredSessions 必须如实写（' + t.budget.deferredSessions + '）');
    assert.ok(t.budget.byteDeferredSessions >= 1, 'budget.byteDeferredSessions 必须如实写');
    assert.ok(t.readBytes <= READ_AMP_LIMIT_BYTES, '读盘估算 ≤40 MiB（S-9①），实际 ' + t.readBytes);
  });
});

// ============================================================================
// ② 跨 tick 不漏 + ③ 0 重复：字节预算截断 → partialCommit → 下一 tick 续跑 → 行数齐、唯一
// ============================================================================
test('C25-② 跨 tick 不漏 + 0 重复：截断续跑后行数齐、code/(sid,turn) 唯一、跑完再 tick written=0', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const SESSIONS = 2;
    const TURNS = 36;
    const payload = 32 * 1024; // 随机正文（base64）→ 每会话压缩后 ~1.1 MB
    for (let i = 0; i < SESSIONS; i++) {
      writeSessionFile(dshHome, sidFor(i), validTurnFrames(TURNS, payload));
    }

    // 单会话预算 400 KiB：同一条"预算截断 → partialCommit → 下一 tick 续跑"路径，
    // 只是截断维是会话级（tick 级 17 MiB 在 ① 已单独验过），避免自测再造 20 MB 有效语料。
    const cfg = makeCfg(dataRoot, { maxBytesPerSession: 400 * 1024 });
    const log = fakeLogger();
    const stats = [];
    let totalWritten = 0;
    let sawResume = false;
    let sawTruncated = false;
    for (let i = 0; i < 12; i++) {
      const s = await runOnce({ logger: log }, cfg);
      stats.push(s);
      totalWritten += s.written;
      assert.ok(s.consumedSourceBytes <= TICK_READ_BUDGET_BYTES,
        '每个 tick 的聚合消费都必须 ≤17 MiB（tick ' + (i + 1) + '：' + s.consumedSourceBytes + '）');
      // 续跑证据：incremental（从游标续读）/ resumedSessions（partialCommit 续跑）任一成立。
      if (s.resumedSessions > 0 || s.incremental > 0) sawResume = true;
      if (s.partialReads > 0) sawTruncated = true;
      if (totalWritten >= SESSIONS * TURNS) break;
    }
    const expected = SESSIONS * TURNS;
    assert.equal(totalWritten, expected, '跨 tick 续跑不得漏行：written 合计=' + totalWritten + ' ≠ ' + expected);
    assert.ok(sawTruncated, '必须观察到一个 tick 因字节预算没读完（partialReads>0）');
    assert.ok(sawResume, '必须观察到跨 tick 续读（incremental/resumedSessions>0）');
    assert.ok(stats.filter((s) => s.written > 0).length >= 2,
      '必须真的跑了 ≥2 个入账 tick（证明跨 tick），实际 ' + stats.filter((s) => s.written > 0).length);

    // 跑完再 tick：不得重复入账
    const quiet = await runOnce({ logger: log }, cfg);
    assert.equal(quiet.written, 0, '跑完后再 tick 不得再写（written=' + quiet.written + '）');

    // 台账：行数齐 / code 唯一 / (sid,turn) 唯一 / 0 坏行
    const rows = readLedgerRows(dataRoot);
    assert.equal(rows.length, expected, '台账行数必须 = 期望轮次数（' + rows.length + ' ≠ ' + expected + '）');
    assert.equal(new Set(rows.map((r) => r.code)).size, expected, 'code 必须唯一（0 重复）');
    assert.equal(new Set(rows.map((r) => String(r.sid) + '#' + r.turn)).size, expected, '(sid,turn) 必须唯一（0 重复）');
    assert.equal(rows.every((r) => r.status === 'ok'), true, '全部应为闭合 ok 行');

    // 逐 tick 度量：消费不越界、口径与 stat 一致、无坏行
    const ticks = readTickMetrics(dataRoot);
    assert.equal(ticks.length, stats.length + 1, '每个 tick 都应落一行 .tick-metrics');
    for (const t of ticks) {
      assert.ok(t.io.consumedSourceBytes <= TICK_READ_BUDGET_BYTES,
        '逐 tick 消费越界：' + t.io.consumedSourceBytes);
      assert.equal(typeof t.budget.deferredSessions, 'number', 'budget.deferredSessions 必须落盘');
      assert.ok(t.readBytes <= READ_AMP_LIMIT_BYTES, '逐 tick 读盘估算 ≤40 MiB：' + t.readBytes);
    }
  });
});

// ============================================================================
// ③ 计量真实：跨会话累加 = 台账来源文件消费之和；metrics 与 stat 同口径（不许少报）
// ============================================================================
test('C25-③ 计量真实：consumedSourceBytes 跨会话累加、与 .tick-metrics 同值、只增不减', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const files = [];
    for (let i = 0; i < 4; i++) files.push(writeSessionFile(dshHome, sidFor(10 + i), validTurnFrames(4, 8 * 1024)));
    const sizes = files.map((p) => fs.statSync(p).size);
    const cfg = makeCfg(dataRoot, { maxBytesPerSession: 256 * 1024 });
    const log = fakeLogger();
    const stats = [];
    for (let i = 0; i < 6; i++) {
      const s = await runOnce({ logger: log }, cfg);
      stats.push(s);
      if (s.written === 0 && i > 0) break;
    }
    const rows = readLedgerRows(dataRoot);
    assert.equal(rows.length, 16, '4 会话 × 4 轮必须全量入账（实际 ' + rows.length + '）');
    const ticks = readTickMetrics(dataRoot);
    assert.equal(ticks.length, stats.length, 'tick 数与 metrics 行数必须一致');
    for (let i = 0; i < stats.length; i++) {
      assert.equal(ticks[i].io.consumedSourceBytes, stats[i].consumedSourceBytes,
        '第 ' + (i + 1) + ' tick：metrics 与 stat 的 consumedSourceBytes 必须同值（不许少报）');
      assert.ok(ticks[i].io.consumedSourceBytes <= TICK_READ_BUDGET_BYTES, '第 ' + (i + 1) + ' tick 消费越界');
    }
    // 全量完成后，每个源都读到了 EOF：
    const st = JSON.parse(fs.readFileSync(path.join(ledgerDir(dataRoot), '.state.json'), 'utf8'));
    const cursors = st.sourceCursors || {};
    for (const [k, v] of Object.entries(cursors)) {
      if (!/\.jsonl\.zstd$/.test(k)) continue;
      assert.ok(Number.isInteger(v.offset) && Number.isInteger(v.size) && v.offset >= v.size,
        '源必须读到 EOF：' + path.basename(path.dirname(k)) + ' offset=' + v.offset + '/' + v.size);
    }
    // 消费总和 ≤ 源文件总字节（不可能凭空多报）
    const totalConsumed = stats.reduce((a, s) => a + (s.consumedSourceBytes || 0), 0);
    const totalSource = sizes.reduce((a, b) => a + b, 0);
    assert.ok(totalConsumed <= totalSource,
      '跨 tick 消费合计 ' + totalConsumed + ' 不得超过源文件总字节 ' + totalSource);
  });
});
