/**
 * @file 验证-K16大帧停摆.mjs
 * @role 回归锁（v1.0.0-snap / K-16 第二阶段）：**单帧远大于事件批读预算上界**时，
 *       该会话绝不许"永久 0 行入账 + 游标钉死 + 每 tick 重读"。
 *
 * @why 这是 2026-11-14 两篇审计共同点名的 P1（生产准入审计与独立复审计都说"比 re3 更差"）：
 *      re4 的 K-16 把"读不全"处理成"整批不落账、游标不推进"，修好了"截断当完整"，却挖出了
 *      "读不全 = 会话永久停摆"：
 *        · 某轮跨在**单帧 > 4 MiB** 的帧上（span 小）→ 重试阶梯 64 KiB → 1 MiB → 4 MiB
 *          （×4 增长，三次封顶 4 MiB，而上界是 8 MiB）→ 数学上永远读不全；
 *        · lib/frames.js 的预算语义是"停在**帧边界**"（`frames.js:510` 只在 consumed>0 时停），
 *          所以只要大帧不是本批第一帧，预算再涨也跨不过去；
 *        · 上层（index.js `readEventsBounded`）三次都拿到 truncated → 整批不落账、游标不推进
 *          → 下一 tick 从同一位置重读 → **永久 0 行**。审计实测：5.24 MB 单帧 fixture，3 tick 全 written=0。
 *      比 re3 更差：re3 至少落一行（截断入账），re4 一行不落。
 *
 * @口径 本文件锁定的是"**零静默**"，不是"零缺陷"（见 `15号行动前的说明` §0/§2）：
 *        · 用例 C（单帧 5.2 MB，> 4 MiB 且 < 8 MiB）：**必须完整入账** —— 这是"能读全就该读全"那一半；
 *        · 用例 D（单帧 8.4 MB，> 8 MiB）：允许按例外条款"宁丢该轮不丢会话"，但**必须**：
 *            ① 该轮不进台账、不进已闭合计数；② 缺口在 `.lost.jsonl`/pending 里可见；③ 有 WARN；
 *            ④ 游标**必须前进**（不许钉 0 重读）；⑤ 会话其余轮次照常入账。
 *        ★ 用例 D 的红绿与"丢不丢"无关，只与"丢得响不响"有关。
 *
 * @run（**绝不要**在全量 `docs\跑测试.mjs` 跑着的同时跑）：
 *        node --test --test-concurrency=1 docs\验证-K16大帧停摆.mjs
 *
 * @naming 故意**不叫** `自测-*.mjs`：绿之前不并入全量套件，否则"预期红"会变成
 *        `跑测试.mjs` 闸门里的"未登记红点"（exit 6），把逐名对账闸门撞红。
 *        修好转绿后按交付流程改名为 `自测-K16大帧停摆-snap.mjs` 并入册。
 *
 * 写盘纪律：临时文件只落 `%TEMP%\dl-k16-*`，用例结束整目录删除；不碰真实 ~/.dsh，不改产品源码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { runOnce } from '../index.js';
import { readAll } from '../lib/ledger.js';

// ============================================================================
// 一、常量（手写，不与被测实现互相反推；预算公式抄自 index.js:189-195）
// ============================================================================

const SID = 'session-5a17c0de-b16f-4e77-9a11-0f2b3c4d5e6f';
const SESSION_FILE = 'session.v3.jsonl.zstd';
const OFFSET_MINUTES = 480;
const T0 = Date.parse('2026-11-15T09:00:00+08:00');
const TARGET_TURN = 22;
const EARLY_TURNS = 21;

/** index.js:193 `EVENT_READ_MAX_BYTES`（重试阶梯的硬上界）。 */
const EVENT_READ_MAX_BYTES = 8 * 1024 * 1024;
/** index.js:191 `EVENT_READ_MARGIN_BYTES`（预算 = span + 余量）。 */
const EVENT_READ_MARGIN_BYTES = 32 * 1024;
/** index.js:185 `Math.max(64 * 1024, …)` 的预算下限。 */
const EVENT_READ_MIN_BYTES = 64 * 1024;
/** index.js:195 `EVENT_READ_ATTEMPTS`（三次尝试：64 KiB → 1 MiB → 4 MiB）。 */
const EVENT_READ_ATTEMPTS = 3;

/** 用例 C 的大帧目标：压缩后落在 (4 MiB, 8 MiB) 开区间 —— 今天必红的那个尺寸。 */
const BIG_FRAME_C_BYTES = 5_240_000; // ≈ 审计 fixture 的 5.24 MB
/** 用例 D 的大帧目标：压缩后 > 8 MiB —— 只能按例外条款"结构化跳过"的尺寸。 */
const BIG_FRAME_D_BYTES = 8_400_000;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ============================================================================
// 二、夹具构造
// ============================================================================

/** 把若干行压成一帧（真实会话每 flush 一次就是一帧，所以文件是多帧拼接）。 */
const frame = (lineArr) => zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));

/** 确定性伪随机字节（xorshift32）：帧尺寸每次跑都一样，别人可独立复算。 */
function detBytes(n, seed = 0x4b31364c) {
  const buf = Buffer.allocUnsafe(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

/**
 * 造三帧 v3 会话：第 22 轮**跨在"一个超大单帧"的边界上**。
 *
 *   帧 1：会话头 + 第 1..21 轮（小，~2 KB）
 *   帧 2：第 22 轮 turn/start + user/message + tool/call（小，< 32 KiB）
 *   帧 3：第 22 轮 tool/result（**一个** 5.2 MB / 8.4 MB 的单帧）+ turn/end
 *
 * 关键：大帧**不是本批第一帧**（前面还有帧 1、帧 2），所以 frames 的预算判定
 * （`consumed > 0 && consumed + frameLen > maxBytes` → 停在帧边界）一定会拦住它，
 * 而重试阶梯三次封顶 4 MiB —— 4 MiB 以上的单帧永远跨不过去。
 *
 * @param {number} bigFrameTargetBytes 帧 3 压缩后的大致字节数
 */
function buildFixture(bigFrameTargetBytes) {
  const headerLine = JSON.stringify({
    type: 'session', version: 3, id: SID, createdAt: T0, cwd: 'C:\\k16-lab', agentPreset: 'k16-lab',
  });
  const earlyLines = [];
  for (let n = 1; n <= EARLY_TURNS; n++) {
    const ts = T0 + n * 1000;
    const base = (n - 1) * 4;
    earlyLines.push(
      JSON.stringify({ type: 'turn/start', seq: base + 1, time: ts, data: { turn: n } }),
      JSON.stringify({
        type: 'user/message', seq: base + 2, time: ts + 100,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第 ' + n + ' 轮提问' }] },
      }),
      JSON.stringify({
        type: 'assistant/message', seq: base + 3, time: ts + 200,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '第 ' + n + ' 轮回答' }] } },
      }),
      JSON.stringify({ type: 'turn/end', seq: base + 4, time: ts + 300, data: { turn: n, reason: { kind: 'completed' } } }),
    );
  }

  // 大正文：确定性伪随机二进制 → base64（文本不可读但仍是 6 bit/字符），
  //   实测 zstd 会把 base64 压回≈原始二进制尺寸，所以"帧压缩后尺寸 ≈ payloadBytes"，
  //   直接按目标尺寸取 payload，再扣掉 JSON 外壳余量（实测本机 2026-11-15：
  //   payload 3,929,904 B → 帧 3 压缩后 3,927,454 B，比值 0.9994）。
  const payloadBytes = bigFrameTargetBytes - 8192;
  const bigText = detBytes(payloadBytes).toString('base64');

  const t22 = T0 + TARGET_TURN * 1000;
  const targetEvents = [
    { type: 'turn/start', seq: 85, time: t22, data: { turn: TARGET_TURN } },
    {
      type: 'user/message', seq: 86, time: t22 + 100,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把 a.bin 的内容完整读出来并核对长度' }] },
    },
    { type: 'tool/call', seq: 87, time: t22 + 200, data: { callId: 'call-22', name: 'read', arguments: '{"path":"a.bin"}' } },
    {
      type: 'tool/result', seq: 88, time: t22 + 300, sourceEventSeqs: [87],
      data: { callId: 'call-22', message: { isError: false, content: [{ type: 'text', text: bigText }] } },
    },
    { type: 'turn/end', seq: 89, time: t22 + 400, data: { turn: TARGET_TURN, reason: { kind: 'completed' } } },
  ];

  const json = (e) => JSON.stringify(e);
  const frame1 = frame([headerLine, ...earlyLines]);
  const frame2 = frame(targetEvents.slice(0, 3).map(json));
  const frame3 = frame(targetEvents.slice(3).map(json)); // ★ 一个帧里装 tool/result(大) + turn/end

  const targetAttachmentContent = targetEvents.map(json).join('\n') + '\n';
  const targetAttachmentBytes = Buffer.byteLength(targetAttachmentContent, 'utf8');
  const targetAttachmentSha = sha256Hex(targetAttachmentContent);

  const frame2Start = frame1.length;
  const frame3Start = frame1.length + frame2.length;
  const fileSize = frame3Start + frame3.length;

  // 产品预算（index.js:3162 原文）：min(8 MiB, max(64 KiB, span + 32 KiB))
  const span = frame3Start; // 本批首轮 startByte=0，末轮（第22轮）endByte=帧3起点
  const attemptBudgets = [];
  let b = Math.min(EVENT_READ_MAX_BYTES, Math.max(EVENT_READ_MIN_BYTES, span + EVENT_READ_MARGIN_BYTES));
  for (let i = 0; i < EVENT_READ_ATTEMPTS; i++) {
    attemptBudgets.push(b);
    b = Math.min(EVENT_READ_MAX_BYTES, Math.max(b * 4, 1024 * 1024));
  }

  return {
    frame1, frame2, frame3,
    frame2Start, frame3Start, fileSize,
    attemptBudgets,
    ladderMax: Math.max(...attemptBudgets),
    targetEvents, targetAttachmentBytes, targetAttachmentSha,
    fileBuffer: Buffer.concat([frame1, frame2, frame3]),
  };
}

/** 夹具前置不变式：尺寸没落进"现场"就红在夹具，别去改产品。 */
function assertFixtureShape(fx, kind) {
  assert.ok(fx.frame3.length * 1024 >= 0); // 占位，保持结构对称
  assert.ok(fx.frame2.length < EVENT_READ_MARGIN_BYTES,
    'fixture 前置：帧 2 必须 < 32 KiB（实际 ' + fx.frame2.length + ' B）');
  assert.ok(fx.frame3.length > 4 * 1024 * 1024,
    'fixture 前置：帧 3 压缩后必须 > 4 MiB（实际 ' + fx.frame3.length + ' B）');
  if (kind === 'C') {
    assert.ok(fx.frame3.length < 8 * 1024 * 1024,
      'fixture 前置（C）：帧 3 必须 < 8 MiB 上界（实际 ' + fx.frame3.length + ' B）');
    assert.ok(fx.ladderMax < fx.frame3.length,
      'fixture 前置（C）：三次重试的最大预算 ' + fx.ladderMax + ' B 必须 < 帧 3 长度 ' +
      fx.frame3.length + ' B —— 这才叫"数学上读不全"');
  } else {
    assert.ok(fx.frame3.length > EVENT_READ_MAX_BYTES,
      'fixture 前置（D）：帧 3 必须 > 8 MiB 硬上界（实际 ' + fx.frame3.length + ' B）');
  }
}

/** 把 fixture 写成 `<DSH_HOME>/sessions/--k16-lab--/<sid>/session.v3.jsonl.zstd`。 */
function writeSessionV3(dshHome, fx) {
  const dir = path.join(dshHome, 'sessions', '--k16-lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  fs.writeFileSync(file, fx.fileBuffer);
  return file;
}

function fakeLogger() {
  const warnLines = [];
  const infoLines = [];
  return { warnLines, infoLines, info: (...a) => infoLines.push(a.join(' ')), warn: (...a) => warnLines.push(a.join(' ')) };
}

/** runOnce 的最小配置：不周记账、不交接、不体检、热窗口不过滤。 */
function makeCfg(root) {
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
    weeklyEnabled: false,
    handoverEnabled: false,
  };
}

async function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-k16-'));
  assert.match(path.basename(base), /^dl-k16-/);
  assert.equal(path.dirname(base), os.tmpdir());
  const dshHome = path.join(base, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ base, dshHome, dataRoot });
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ============================================================================
// 三、可观测工具（判红/判绿都靠它，不靠"感觉"）
// ============================================================================

/** 读 `<root>/ledger/.state.json` 里该会话的游标；没有返回 null。 */
function cursorOf(dataRoot, sessionFile) {
  const statePath = path.join(dataRoot, 'ledger', '.state.json');
  if (!fs.existsSync(statePath)) return null;
  let st;
  try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; }
  // ★ 产品字段名是 `sourceCursors`（index.js:3605 writeState({ sourceCursors: cursors })）；
  //   兼容早期/别名的 `cursors`，但绝不"猜错字段就当成没有游标"。
  const map = (st && st.sourceCursors) || (st && st.cursors) || {};
  for (const [k, v] of Object.entries(map)) {
    if (k.endsWith(SESSION_FILE) || k === sessionFile) return { key: k, ...v };
  }
  return null;
}

/** 状态文件的顶层键（诊断用：游标字段名写错时能一眼看出来）。 */
function stateTopKeys(dataRoot) {
  const statePath = path.join(dataRoot, 'ledger', '.state.json');
  if (!fs.existsSync(statePath)) return null;
  try { return Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch { return 'unparsable'; }
}

/** 读 `.lost.jsonl` 全部行（缺口证据）。 */
function lostRows(dataRoot) {
  const p = path.join(dataRoot, 'ledger', '.lost.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return { _unparsed: l }; }
  });
}

/** 读 `.pending.jsonl` 全部行（未闭合/待处理轮证据）。 */
function pendingRows(dataRoot) {
  const p = path.join(dataRoot, 'ledger', '.pending.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return { _unparsed: l }; }
  });
}

/** 连跑 n 个 tick，返回每个 tick 的 stat 与日志快照。 */
async function tickN(dataRoot, log, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
    out.push({
      tick: i,
      written: stat.written,
      scanned: stat.scanned,
      deferredTurns: stat.deferredTurns,
      eventTruncatedBatch: stat.eventTruncatedBatch,
      eventShortBatch: stat.eventShortBatch,
      eventReadRetries: stat.eventReadRetries,
      warnCount: log.warnLines.length,
    });
  }
  return out;
}

// ============================================================================
// 四、用例 C：单帧 5.2 MB（> 4 MiB、< 8 MiB）—— 必须完整入账
// ============================================================================

test('K-16/C（>4 MiB 单帧）：三 tick 内第 22 轮必须完整入账（不许永久 0 行、不许游标钉死）', async () => {
  const fx = buildFixture(BIG_FRAME_C_BYTES);
  assertFixtureShape(fx, 'C');
  console.log('[k16-fixture/C] ' + JSON.stringify({
    frame1: fx.frame1.length, frame2: fx.frame2.length, frame3: fx.frame3.length,
    frame2Start: fx.frame2Start, frame3Start: fx.frame3Start, fileSize: fx.fileSize,
    attemptBudgets: fx.attemptBudgets, ladderMax: fx.ladderMax,
    expectedAttachmentBytes: fx.targetAttachmentBytes,
  }));

  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionV3(dshHome, fx);
    const log = fakeLogger();
    const ticks = await tickN(dataRoot, log, 3);

    const read = readAll(dataRoot);
    assert.equal(read.ok, true, '台账必须可完整读取：' + JSON.stringify(read.readErrors));
    const rows = read.records.filter((r) => r.sid === SID);
    const hit = rows.filter((r) => r.turn === TARGET_TURN);

    const diag = {
      ticks,
      rowsOfSession: rows.length,
      targetRows: hit.length,
      cursor: cursorOf(dataRoot, SESSION_FILE),
      lostRows: lostRows(dataRoot).length,
      pendingRows: pendingRows(dataRoot).length,
      warnSample: log.warnLines.slice(0, 3),
    };
    console.log('[k16-台账/C] ' + JSON.stringify(diag));

    // ★ 断言 ①：会话绝不许"永久 0 行" —— 本用例的大帧在上界以内，必须能读全。
    assert.ok(rows.length > 0,
      '★ K-16 大帧停摆：3 个 tick 后该会话仍然 0 行入账（写着 ' +
      JSON.stringify(ticks.map((t) => t.written)) + '）—— 这正是审计说的"比 re3 更差"（整会话静默）');

    // ★ 断言 ②：第 22 轮必须恰好一行，且**完整**
    assert.equal(hit.length, 1, '第 22 轮必须恰好一行（实际 ' + hit.length + '）');
    const row = hit[0];
    assert.equal(row.attachment && row.attachment.bytes, fx.targetAttachmentBytes,
      '★ 第 22 轮附件字节数必须等于完整附件字节数（期望 ' + fx.targetAttachmentBytes +
      ' B，实际 ' + (row.attachment && row.attachment.bytes) + ' B）');
    assert.equal(row.attachment && row.attachment.sha256, fx.targetAttachmentSha,
      '★ 第 22 轮附件 sha256 必须按完整事件重算一致');

    // ★ 断言 ③：游标必须前进到文件尾（不许钉在 0 每 tick 重读）
    const cur = cursorOf(dataRoot, SESSION_FILE);
    assert.ok(cur && Number.isInteger(cur.offset) && cur.offset >= fx.fileSize,
      '★ 游标必须推进到文件尾 ' + fx.fileSize + '（实际 ' + JSON.stringify(cur) + '）');

    // ★ 断言 ④：大帧在上界以内时**不许**丢轮 —— 不许出现该会话的缺口记录
    const lost = lostRows(dataRoot).filter((r) => r && (r.sid === SID || String(r.source || '').includes(SID)));
    assert.equal(lost.length, 0, '≤8 MiB 单帧必须读全，不该留缺口记录（实际 ' + lost.length + ' 条）');
  });
});

// ============================================================================
// 五、用例 D：单帧 8.4 MB（> 8 MiB）—— 允许丢该轮，但必须"喊疼"
// ============================================================================

test('K-16/D（>8 MiB 单帧）：允许丢该轮，但缺口必须可见 + 有 WARN + 游标必须前进', async () => {
  const fx = buildFixture(BIG_FRAME_D_BYTES);
  assertFixtureShape(fx, 'D');
  console.log('[k16-fixture/D] ' + JSON.stringify({
    frame3: fx.frame3.length, frame3Start: fx.frame3Start, fileSize: fx.fileSize,
    attemptBudgets: fx.attemptBudgets, maxBudget: EVENT_READ_MAX_BYTES,
  }));

  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionV3(dshHome, fx);
    const log = fakeLogger();
    const ticks = await tickN(dataRoot, log, 3);

    const read = readAll(dataRoot);
    const rows = read.ok ? read.records.filter((r) => r.sid === SID) : [];
    const diag = {
      ticks,
      rowsOfSession: rows.length,
      targetRows: rows.filter((r) => r.turn === TARGET_TURN).length,
      cursor: cursorOf(dataRoot, SESSION_FILE),
      lostRows: lostRows(dataRoot).length,
      pendingRows: pendingRows(dataRoot).length,
      warnCount: log.warnLines.length,
      warnSample: log.warnLines.slice(0, 3),
    };
    console.log('[k16-台账/D] ' + JSON.stringify(diag));

    // ★ 断言 ①：会话不许**永久 0 行**。上界之外的这一轮可以丢，但会话本身必须继续往前走。
    assert.ok(rows.length > 0,
      '★ 3 个 tick 后该会话仍然 0 行入账（written=' + JSON.stringify(ticks.map((t) => t.written)) +
      '）—— 超上界也只许"丢该轮"，不许"丢整个会话"');

    // ★ 断言 ②：游标必须前进（不许每 tick 从 0 重读同一段）
    const cur = cursorOf(dataRoot, SESSION_FILE);
    assert.ok(cur && Number.isInteger(cur.offset) && cur.offset > fx.frame3Start,
      '★ 游标必须越过卡住的大帧起点 ' + fx.frame3Start + '（实际 ' + JSON.stringify(cur) + '）');

    // ★ 断言 ③：缺口必须结构化可见（.lost.jsonl 或 pending 之一），且带"可跳过/超限"语义
    const lost = lostRows(dataRoot);
    const pending = pendingRows(dataRoot);
    const visible = lost.length > 0 || pending.length > 0;
    assert.ok(visible, '★ 丢轮必须留证据（.lost.jsonl 或 .pending.jsonl），实际两者都为 0 行');
    const lostJson = JSON.stringify(lost);
    assert.ok(/skippable|oversized|budget|event-read|exceed/i.test(lostJson),
      '★ 缺口记录必须带结构化原因（skippable/oversized/budget 之一），实际：' + lostJson.slice(0, 300));

    // ★ 断言 ④：必须有 WARN 出声（"丢可以是设计，静默不许是设计"）
    assert.ok(log.warnLines.length > 0,
      '★ 丢轮必须 WARN 出声（实际 warnCount=0）—— 静默丢账就是 R1/R2 那条静默类缺陷');
  });
});

// ============================================================================
// 六、用例 E（P2-01，本机测试报告）：turn/start **本身就在** >8 MiB 帧内
//   与 C/D 的区别：C/D 是"轮跨在超大帧边界上"（turn/start 在前一帧）；E 是"整轮都在这一个超大帧里"。
//   旧行为：该轮是 missing（不是 truncated）→ K-16 探测不触发 → 整批延后、会话永久 0 行、退避重试。
//   新行为：missing 也进探测 → 该轮按"宁丢该轮"结构化跳过（.lost + WARN + 游标推进），同批其余轮照常入账。
// ============================================================================

test('K-16/E（>8 MiB 帧内含 turn/start）：该轮结构化跳过，同批其它轮必须入账（不许整会话 0 行）', async () => {
  const SID_E = 'session-e1b16d01-5555-4e77-9a11-0f2b3c4d5e6f';
  const T0E = Date.parse('2026-11-15T08:00:00+08:00');
  const hdr = JSON.stringify({ type: 'session', version: 3, id: SID_E, createdAt: T0E, cwd: 'C:\\k16e', agentPreset: 'k16e' });
  const t1 = T0E + 1000;
  const f1 = frame([
    hdr,
    JSON.stringify({ type: 'turn/start', seq: 1, time: t1, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 2, time: t1 + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] } }),
    JSON.stringify({ type: 'turn/end', seq: 3, time: t1 + 200, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]);
  // ★ 一个 >8 MiB 的**单帧**，里面装 turn 2 的 start + 正文 + end
  const bigText = detBytes(8_600_000).toString('base64');
  const t2 = T0E + 2000;
  const f2 = frame([
    JSON.stringify({ type: 'turn/start', seq: 4, time: t2, data: { turn: 2 } }),
    JSON.stringify({ type: 'user/message', seq: 5, time: t2 + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } }),
    JSON.stringify({ type: 'tool/result', seq: 6, time: t2 + 200, sourceEventSeqs: [5], data: { callId: 'c2', message: { isError: false, content: [{ type: 'text', text: bigText }] } } }),
    JSON.stringify({ type: 'turn/end', seq: 7, time: t2 + 300, data: { turn: 2, reason: { kind: 'completed' } } }),
  ]);
  const t3 = T0E + 3000;
  const f3 = frame([
    JSON.stringify({ type: 'turn/start', seq: 8, time: t3, data: { turn: 3 } }),
    JSON.stringify({ type: 'user/message', seq: 9, time: t3 + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q3' }] } }),
    JSON.stringify({ type: 'turn/end', seq: 10, time: t3 + 200, data: { turn: 3, reason: { kind: 'completed' } } }),
  ]);
  const fileBuf = Buffer.concat([f1, f2, f3]);
  assert.ok(f2.length > 8 * 1024 * 1024, 'fixture 前置：帧 2 压缩后必须 >8 MiB（实际 ' + f2.length + ' B）');
  console.log('[k16-fixture/E] ' + JSON.stringify({ f1: f1.length, f2: f2.length, f3: f3.length, file: fileBuf.length }));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-k16e-'));
  const dshHome = path.join(base, 'dsh-home');
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(path.join(dshHome, 'sessions', '--k16e--', SID_E), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'sessions', '--k16e--', SID_E, 'session.v3.jsonl.zstd'), fileBuf);
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    const log = fakeLogger();
    const ticks = [];
    for (let i = 1; i <= 3; i++) {
      const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
      const read = readAll(dataRoot);
      ticks.push({ tick: i, written: stat.written, dropped: stat.eventDroppedTurns || 0, rows: read.ok ? read.records.filter((r) => r.sid === SID_E).length : -1 });
    }
    const read = readAll(dataRoot);
    const rows = read.ok ? read.records.filter((r) => r.sid === SID_E) : [];
    const turnNums = rows.map((r) => r.turn).sort((a, b) => a - b);
    const lost = lostRows(dataRoot);
    const diag = { ticks, rows: rows.length, turnNums, dropped: ticks[0].dropped, lostRows: lost.length, warnCount: log.warnLines.length, lostSample: lost.slice(0, 1) };
    console.log('[k16-台账/E] ' + JSON.stringify(diag).slice(0, 900));

    // ★ 断言 1：同批其它轮必须入账（旧行为是整会话 0 行）
    assert.ok(rows.length >= 2, '★ P2-01：同批其它轮必须入账（实际 ' + rows.length + ' 行）—— 旧行为是整会话 0 行');
    assert.ok(turnNums.includes(1) && turnNums.includes(3), 'turn 1 / turn 3 必须入账（实际 ' + JSON.stringify(turnNums) + '）');
    // ★ 断言 2：turn 2 必须按"宁丢该轮"处理：不入账 + 有结构化缺口留痕
    assert.equal(turnNums.includes(2), false, 'turn 2 落在 >8 MiB 帧内，必须按"宁丢该轮"处理（不入账）');
    assert.ok(lost.length >= 1, '★ 丢轮必须留 .lost 证据（实际 ' + lost.length + ' 条）');
    // ★ 断言 3：游标必须前进到文件尾（不许钉 0 每 tick 重读）
    const cur = cursorOf(dataRoot, 'session.v3.jsonl.zstd');
    assert.ok(cur && Number.isInteger(cur.offset) && cur.offset >= fileBuf.length, '★ 游标必须推进到文件尾 ' + fileBuf.length + '（实际 ' + JSON.stringify(cur && cur.offset) + '）');
    // ★ 断言 4：必须 WARN 出声
    assert.ok(log.warnLines.length > 0, '★ 丢轮必须 WARN（静默丢账 = R2）');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 七、用例 F（P2-02，本机测试报告）：跳帧的 .lost 记录必须**自洽且可复算**
//   旧记录曾出现：failedFrames=1 但 failedFrameOffsets=[]/missing=[]/skippedRanges=[]；
//   frames=4 而 okFrames(4)+failedFrames(1)>4；stopReason='' 却 reasons=['failed-frames']；终态却 retryable=true。
//   根因：**复核扫描用 frames 默认 64 MiB**，把读取侧按 8 MiB 跳过的同一帧又读成功了 → 证据与事实对不上。
//   修法：复核扫描与读取同口径（maxFrameBytes/maxDecompressedBytes 透传）；frames 用复核口径自洽；
//         跳过式缺口的 stopReason 固定 'oversized-frame-skip'；retryable 与 skippable 互斥。
// ============================================================================

const frameText = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'));

test('K-16/F（.lost 自洽）：超大帧跳过的记录必须 frames 自洽 / 偏移可复算 / retryable 与 skippable 互斥', async () => {
  const SID_F = 'session-f2c0de02-8888-4e77-9a11-0f2b3c4d5e6f';
  const header = JSON.stringify({ type: 'session', version: 3, id: SID_F, createdAt: T0, cwd: 'C:\\k16f', agentPreset: 'k16f' });
  const t1 = T0 + 1000;
  const f1 = frameText([header,
    JSON.stringify({ type: 'turn/start', seq: 1, time: t1, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 2, time: t1 + 100, data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n') + '\n');
  const bigText = detBytes(8_600_000).toString('base64');
  const t2 = T0 + 2000;
  const f2 = frameText([
    JSON.stringify({ type: 'turn/start', seq: 3, time: t2, data: { turn: 2 } }),
    JSON.stringify({ type: 'tool/result', seq: 4, time: t2 + 100, sourceEventSeqs: [3], data: { callId: 'c', message: { isError: false, content: [{ type: 'text', text: bigText }] } } }),
    JSON.stringify({ type: 'turn/end', seq: 5, time: t2 + 200, data: { turn: 2, reason: { kind: 'completed' } } }),
  ].join('\n') + '\n');
  const t3 = T0 + 3000;
  const f3 = frameText([
    JSON.stringify({ type: 'turn/start', seq: 6, time: t3, data: { turn: 3 } }),
    JSON.stringify({ type: 'turn/end', seq: 7, time: t3 + 100, data: { turn: 3, reason: { kind: 'completed' } } }),
  ].join('\n') + '\n');
  const fileBuf = Buffer.concat([f1, f2, f3]);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-k16f-'));
  const dshHome = path.join(base, 'dsh-home');
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(path.join(dshHome, 'sessions', '--k16f--', SID_F), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = path.join(dshHome, 'sessions', '--k16f--', SID_F, 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, fileBuf);
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    for (let i = 1; i <= 2; i++) await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    const recs = lostRows(dataRoot);
    assert.ok(recs.length >= 1, '必须留下 .lost 记录');
    let checked = 0;
    for (const r of recs) {
      const frames = Number(r.frames) || 0;
      const okFrames = Number(r.okFrames) || 0;
      const failedFrames = Number(r.failedFrames) || 0;
      const offsets = Array.isArray(r.failedFrameOffsets) ? r.failedFrameOffsets : [];
      const missing = Array.isArray(r.missing) ? r.missing : [];
      const skipped = Array.isArray(r.skippedRanges) ? r.skippedRanges : [];
      // ① frames 自洽
      assert.equal(frames, okFrames + failedFrames, '★ frames 必须 == okFrames + failedFrames（实际 ' + frames + ' vs ' + okFrames + '+' + failedFrames + '）');
      // ② 跳过的帧必须能被定位
      if (failedFrames > 0) {
        assert.ok(offsets.length >= 1, '★ failedFrames>0 时 failedFrameOffsets 不许为空（否则无法复算跳过了哪一帧）');
        assert.ok(missing.length >= 1, '★ failedFrameOffsets 非空时 missing 必须给出可复算区间');
        assert.ok(skipped.length >= 1, '★ 跳过式缺口必须带 skippedRanges（含 resumeAt）');
      }
      // ③ 区间 sha256 可按磁盘复算
      for (const m of missing) {
        if (!m || !m.sha256) continue;
        const got = crypto.createHash('sha256').update(fileBuf.subarray(m.start, m.end)).digest('hex');
        assert.equal(got, m.sha256, '★ missing[' + m.start + ',' + m.end + ') 的 sha256 必须可按磁盘复算');
      }
      // ④ retryable 与 skippable 互斥；跳过式缺口 stopReason 明确
      assert.equal(!!r.retryable && !!r.skippable, false, '★ retryable 与 skippable 不许同时为真');
      if (skipped.length >= 1) {
        assert.equal(r.stopReason, 'oversized-frame-skip', '★ 跳过式缺口的 stopReason 必须是 oversized-frame-skip（实际 ' + JSON.stringify(r.stopReason) + '）');
        assert.equal(r.retryable, false, '★ 跳过式缺口是终态（游标已推进），retryable 必须为 false');
      }
      checked++;
    }
    assert.ok(checked >= 1, '至少要检查到 1 条记录');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
