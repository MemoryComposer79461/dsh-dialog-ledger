/**
 * @file 自测-v3跨帧轮-re4.mjs
 * @role 回归锁（re4 / K-16）：v3 多帧会话里「轮次跨帧 + 事件批读预算停在帧边界」时，
 *       绝不许把**半截事件**当成完整轮落账。
 *
 * @why 这是 2026-11-14 三份独立审计共同判定的 P0：
 *      v3 会话（`session.v3.jsonl.zstd`，**多 zstd 帧**）中某一轮跨帧，事件批读预算正好停在
 *      帧边界 → 该轮只读到 turn/start 与部分事件。旧实现三处都没兜住：
 *        ① lib/ledger.js `readTurnEventsBatch`：预算截断时尾部 emit 的 endByte 用 `stats.size`
 *           （= 宣称"已读到文件尾"），且没有 `opts.truncated` 出参 —— 上层无从知道"没读全"；
 *        ② index.js `readEventsBounded`：重试条件只看"缺不缺轮"，合并用 `if (!got.has(k))`
 *           —— 读到但没读全的轮直接过关，后读的完整结果还会被丢弃；
 *        ③ index.js 批级短读判定只查"有没有事件"，不查"读全没读全"。
 *      结果：台账行数、code、幂等全对，只有**内容丢** —— attachment.bytes 落成 71 B
 *      （源里实际 51,723 B），而且没有 WARN。设备自检 c19（`docs/replay-verify.mjs --fields`）
 *      因此报 6 条 FIELD_MISMATCH（attachment.bytes / events 范围对不上）。
 *
 * @fixture 自足：不读 `02-语料`、不联网、不依赖开发机路径。三帧全部在 os.tmpdir() 里现场造：
 *      · 帧 1：会话头 + 第 1..21 轮（每轮 4 个小事件，用于把批次起点放在帧 1 起点）；
 *      · 帧 2：第 22 轮 `turn/start` + 2 个部分事件（小）；
 *      · 帧 3：第 22 轮 `tool/result`（确定性伪随机正文，压缩后 > 64 KiB）+ `turn/end`。
 *      产品预算公式（index.js 常量，判据原文）：
 *          budget = min(8 MiB, max(64 KiB, span + 32 KiB))，span = endByte - startByte，
 *          endByte = 该轮 `turn/end` 所在帧的**起点**。
 *      本 fixture 里 span(整批) = 帧 3 起点、帧 3 压缩后 > 64 KiB ⇒
 *          consumed(帧1+帧2) + 帧3长度 > budget  ⇒ frames 停在**帧 3 起点**（stats.stopped），
 *      帧 3 里的 `turn/end` 读不到 —— 正是 P0 现场。
 *
 * @run 只跑本文件（**绝不要**在别处跑 `docs/跑测试.mjs` 全量的同时跑）：
 *        node --test --test-concurrency=1 docs\自测-v3跨帧轮-re4.mjs
 *
 * @red-green 旧代码（`base-re3` 未修复副本）必须**红**：
 *        · 断言 A：台账 attachment.bytes != 完整附件字节数（半截轮落账）；
 *        · 断言 B：小预算读时 `truncated` 出参不存在/为空（cut.has(22) === false）。
 *      新代码（修复版 `pkg`）必须**全绿**。
 *
 * 写盘纪律：临时文件只落 `%TEMP%\dl-re4-*`，每个用例 finally 整目录删除；不碰真实 ~/.dsh，
 *          不改产品源码，不读写包外其它位置。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { runOnce } from '../index.js';
import { readAll, readTurnEventsBatch } from '../lib/ledger.js';

// ============================================================================
// 一、常量（手写，不与被测实现互相反推）
// ============================================================================

/** 会话 id（12 位短 id = 75238718e41a；目录名与头里的 id 必须一致）。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** v3 会话文件名（**只读历史源**：目录里没有 v4 时 scanSessionSources 按 v3 纳入）。 */
const SESSION_FILE = 'session.v3.jsonl.zstd';
/** 时区偏移：480 = UTC+08:00（测试一律显式传，不依赖本机时区）。 */
const OFFSET_MINUTES = 480;
/** 会话开始时刻（固定，避免依赖当前时间）。2026-11-14 09:00 +08:00。 */
const T0 = Date.parse('2026-11-14T09:00:00+08:00');
/** 目标轮次（P0 现场就是"第 22 轮跨帧"）。 */
const TARGET_TURN = 22;
/** 帧 1 里的早期轮数（1..21）。 */
const EARLY_TURNS = 21;
/** 帧 2 里第 22 轮的部分事件数：turn/start + user/message + tool/call。 */
const TARGET_EVENTS_IN_FRAME2 = 3;
/** 第 22 轮完整事件数：turn/start + user/message + tool/call + tool/result + turn/end。 */
const TARGET_EVENTS = 5;
/** 事件批读的余量（字节）—— 与 index.js `EVENT_READ_MARGIN_BYTES` 同值（判据原文 32 KiB）。 */
const FRAME2_MARGIN_BYTES = 32 * 1024;
/** 事件批读单次上界（字节）—— 与 index.js `EVENT_READ_MAX_BYTES` 同值。 */
const READ_MAX_BYTES = 8 * 1024 * 1024;
/** 预算下限（字节）—— 与 index.js 的 `Math.max(64 * 1024, …)` 同值。 */
const READ_MIN_BUDGET_BYTES = 64 * 1024;
/** 帧 3 的最小压缩长度（要求 > 64 KiB：保证任何口径的预算都够不到帧 3 里的 turn/end）。 */
const FRAME3_MIN_BYTES = 64 * 1024;
/**
 * 帧 3 大正文的伪随机字节数（确定性 xorshift32 → base64）。
 * @why 用**确定性**伪随机而不是 crypto.randomBytes：帧压缩长度每次跑都完全一样，
 *      预算与期望字节数可以被别人独立复算（回归锁不许"这次恰好红/绿"）。
 */
const BIG_PAYLOAD_BYTES = 96 * 1024;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ============================================================================
// 二、测试基础设施（临时目录 / 假 logger / 已解析配置 / 帧编码）
// ============================================================================

/** 把若干文本行压成一帧（DSH 每追加写一次就是一帧，所以真实文件是多帧拼接）。 */
const frame = (lineArr) => zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));

/**
 * 确定性伪随机字节（xorshift32，seed 固定）。
 * @param {number} n
 * @param {number} [seed]
 * @returns {Buffer}
 */
function detBytes(n, seed = 0x4e345232) {
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
 * 造三帧 v3 会话 fixture（**纯内存**，不写盘；写盘由调用方决定落哪个临时目录）。
 *
 * 帧边界（帧起点 = 压缩后字节偏移）：
 *   frame1Start = 0                     —— 会话头 + 第 1..21 轮
 *   frame2Start = len(frame1)           —— 第 22 轮 turn/start + 2 个部分事件
 *   frame3Start = len(frame1)+len(frame2) —— 第 22 轮 tool/result(大) + turn/end
 *
 * @returns {{
 *   frame1:Buffer, frame2:Buffer, frame3:Buffer,
 *   frame2Start:number, frame3Start:number, fileSize:number,
 *   productBudget:number, budgetSmall:number,
 *   targetEvents:object[], targetAttachmentBytes:number, targetAttachmentSha:string,
 *   fileBuffer:Buffer
 * }}
 */
function buildFixture() {
  // ── 帧 1：会话头 + 第 1..21 轮（序号手写：(n-1)*4+1 … (n-1)*4+4） ──
  const headerLine = JSON.stringify({
    type: 'session', version: 3, id: SID, createdAt: T0, cwd: 'C:\\re4-lab', agentPreset: 're4-lab',
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

  // ── 帧 2 / 帧 3：第 22 轮（跨帧）。seq 从 85 起（21 轮 × 4 = 84）。 ──
  const t22 = T0 + TARGET_TURN * 1000;
  const bigText = detBytes(BIG_PAYLOAD_BYTES).toString('base64');
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
  const frame2 = frame(targetEvents.slice(0, TARGET_EVENTS_IN_FRAME2).map(json));
  const frame3 = frame(targetEvents.slice(TARGET_EVENTS_IN_FRAME2).map(json));

  // ── 期望值：第 22 轮**完整**事件附件的逐字节内容（与被测实现无关，由 fixture 自己算） ──
  //    形态同 lib/original.js buildEventsAttachment：一事件一行、LF 结尾、行数 == 事件数。
  const targetAttachmentContent = targetEvents.map(json).join('\n') + '\n';
  const targetAttachmentBytes = Buffer.byteLength(targetAttachmentContent, 'utf8');
  const targetAttachmentSha = sha256Hex(targetAttachmentContent);

  // ── 产品预算（index.js readEventsBounded 的公式；端到端路径用的就是它） ──
  //    本批首轮（第 1 轮）的 startByte = 0（帧 1 起点），末轮（第 22 轮）endByte = 帧 3 起点。
  const frame2Start = frame1.length;
  const frame3Start = frame1.length + frame2.length;
  const fileSize = frame3Start + frame3.length;
  const productSpan = frame3Start - 0;
  const productBudget = Math.min(READ_MAX_BYTES, Math.max(READ_MIN_BUDGET_BYTES, productSpan + FRAME2_MARGIN_BYTES));
  // 只读第 22 轮时的"小预算"：任务口径 span(帧2) + 32 KiB（从帧 2 起点起读，span = 帧 2 长度）。
  const budgetSmall = frame2.length + FRAME2_MARGIN_BYTES;

  return {
    frame1, frame2, frame3,
    frame2Start, frame3Start, fileSize,
    productBudget, budgetSmall,
    targetEvents,
    targetAttachmentBytes, targetAttachmentSha,
    fileBuffer: Buffer.concat([frame1, frame2, frame3]),
  };
}

/**
 * fixture 前置不变式：尺寸必须真的落在"P0 现场"（预算停在帧 3 边界）。
 * 任何一条不成立 → 红的一定是夹具，赶紧改夹具，别去改产品。
 * @param {ReturnType<typeof buildFixture>} fx
 */
function assertFixtureShape(fx) {
  // 守：帧 3 必须 > 64 KiB —— 否则预算下限/min(…, span+32KiB) 可能直接够到 turn/end，P0 就复现不出来了。
  assert.ok(fx.frame3.length > FRAME3_MIN_BYTES,
    'fixture 前置：帧 3 压缩后必须 > 64 KiB（实际 ' + fx.frame3.length + ' B）');
  // 守：整批预算必须**装不下帧 3** —— 即 frames 会停在帧 3 起点（stats.stopped=true）。
  assert.ok(fx.frame3Start + fx.frame3.length > fx.productBudget,
    'fixture 前置：产品预算 ' + fx.productBudget + ' B 必须够不到帧 3 尾（帧3 起点=' +
    fx.frame3Start + '，帧3 长=' + fx.frame3.length + '）');
  // 守：只读第 22 轮时，小预算（帧2长度 + 32 KiB）也必须够不到帧 3 的 turn/end。
  assert.ok(fx.frame2.length + fx.frame3.length > fx.budgetSmall,
    'fixture 前置：小预算 ' + fx.budgetSmall + ' B 必须够不到帧 3（帧2 长=' +
    fx.frame2.length + '，帧3 长=' + fx.frame3.length + '）');
  // 守：帧 2 必须真的小 —— 跨帧轮的问题只在"帧 3 比余量大"时出现，帧 2 大就变成另一类样本了。
  assert.ok(fx.frame2.length < FRAME2_MARGIN_BYTES,
    'fixture 前置：帧 2 必须 < 32 KiB（实际 ' + fx.frame2.length + ' B）');
}

/** 把 fixture 写成 `<dshHome>/sessions/<sid>/session.v3.jsonl.zstd`（v3-only：目录里没有 v4）。 */
function writeSessionV3(dshHome, fx) {
  const dir = path.join(dshHome, 'sessions', '--re4-lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  fs.writeFileSync(file, fx.fileBuffer);
  return file;
}

/** 假 logger：不刷终端；warn/info 收集起来（P0 的伴生症状是"没有 WARN"，本测试要能看见。 */
function fakeLogger() {
  const warnLines = [];
  const infoLines = [];
  return {
    warnLines,
    infoLines,
    info: (...a) => infoLines.push(a.join(' ')),
    warn: (...a) => warnLines.push(a.join(' ')),
  };
}

/** runOnce 需要的"已解析配置"（与其它自测同口径；最小配置：不周记账、不交接、不体检）。 */
function makeCfg(root) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: OFFSET_MINUTES,
    hotWindowSeconds: 0, // 0 = 不过滤，所有会话都看
    quietSeconds: 120,
    scanBudgetMs: 0,
    maxBytesPerSession: 0,
    checkupEnabled: false,
    weeklyEnabled: false,
    handoverEnabled: false,
  };
}

/**
 * 建 `%TEMP%\dl-re4-*` 隔离实验室（DSH_HOME + 数据总库根），跑完（无论通过/失败）
 * 恢复环境变量并整目录删除。
 * @param {(lab:{base:string, dshHome:string, dataRoot:string}) => Promise<any>} fn
 */
async function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-re4-'));
  // 守：临时写盘只许落在 os.tmpdir() 下的 dl-re4-*，绝不污染真实用户目录/源码目录。
  assert.match(path.basename(base), /^dl-re4-/);
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

/** 只建一个临时目录（契约级用例不碰 DSH_HOME）。 */
function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-re4-'));
  assert.match(path.basename(dir), /^dl-re4-/);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** fixture 关键尺寸（断言失败/通过时都打出来，方便别人复算）。 */
function dimsOf(fx) {
  return {
    frame1: fx.frame1.length,
    frame2: fx.frame2.length,
    frame3: fx.frame3.length,
    frame2Start: fx.frame2Start,
    frame3Start: fx.frame3Start,
    fileSize: fx.fileSize,
    productBudget: fx.productBudget,
    budgetSmall: fx.budgetSmall,
    expectedAttachmentBytes: fx.targetAttachmentBytes,
    expectedEvents: fx.targetEvents.length,
    bigPayloadBytes: BIG_PAYLOAD_BYTES,
  };
}

// ============================================================================
// 三、断言 A（端到端，最重要）—— 走 index.js 的 runOnce 落账，再按 c19 口径对账
// ============================================================================

test('K-16/A（端到端）：v3 三帧会话里第 22 轮跨帧且批读预算停在帧边界 → 台账 attachment.bytes 必须等于完整附件字节数', async () => {
  // 守：这就是审计判定的 P0 本体。旧的 index.js 在这里会落一条"行数/code/幂等全对、
  //     只有附件内容丢"的台账行（attachment.bytes 只有半截事件那么大），且无 WARN。
  const fx = buildFixture();
  assertFixtureShape(fx);
  console.log('[re4-fixture-尺寸/A] ' + JSON.stringify(dimsOf(fx)));

  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionV3(dshHome, fx);
    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    // ── 台账：22 条闭合轮（21 早期轮 + 第 22 轮），第 22 轮恰好一行 ──
    const read = readAll(dataRoot);
    assert.equal(read.ok, true, '台账必须可完整读取：' + JSON.stringify(read.readErrors));
    assert.equal(read.badLines, 0, '台账不得有坏行');
    const rows = read.records;
    assert.equal(rows.length, EARLY_TURNS + 1,
      '台账行数必须 = 22（实际 ' + rows.length + '；written=' + stat.written +
      ' errors=' + JSON.stringify(stat.errors.slice(0, 4)) + '）');
    const hits = rows.filter((r) => r.sid === SID && r.turn === TARGET_TURN);
    assert.equal(hits.length, 1, '第 22 轮在台账里必须恰好一行（实际 ' + hits.length + '）');
    const row = hits[0];
    // 守：P0 的伴生症状是"别的字段都对，只有内容丢" —— 先把"别的都对"钉住，
    //     免得以后断言 A 因为别的原因红（红了也分不清是内容丢还是整行没写）。
    assert.equal(row.status, 'ok', '第 22 轮是闭合轮，status 必须是 ok');
    assert.equal(row.turnState, 'closed', '闭合轮必须带 turnState="closed"');
    assert.equal(row.src, SESSION_FILE, 'v3 只读历史源的 src 必须如实写 v3 文件名');
    assert.equal(typeof row.code, 'string');
    assert.match(row.code, /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/, 'code 必须是 32 位编码');

    // ── 断言 A（核心）：附件元数据必须等于**完整**事件附件 ──
    assert.ok(row.attachment && typeof row.attachment === 'object',
      '第 22 轮必须有原始事件附件（attachment 缺失）');
    assert.equal(row.attachment.name, row.code + ' 原始事件.json', '附件名契约');
    assert.equal(row.attachment.bytes, fx.targetAttachmentBytes,
      '★ P0：attachment.bytes 必须等于完整附件字节数（期望 ' + fx.targetAttachmentBytes +
      ' B，实际 ' + row.attachment.bytes + ' B）—— 差一个字节就是半截轮落账');
    assert.equal(row.attachment.eventsCount, TARGET_EVENTS,
      '★ P0：附件事件数必须 == 完整事件数 ' + TARGET_EVENTS +
      '（实际 ' + row.attachment.eventsCount + '）');
    assert.equal(row.attachment.sha256, fx.targetAttachmentSha,
      '★ P0：附件 sha256 必须按完整事件重算一致（逐字恢复的凭据）');

    // ── c19 等价：磁盘附件逐字节对账（replay-verify --fields 的 ATTACHMENT_BYTES_MISMATCH /
    //    ATTACHMENT_HASH_MISMATCH 口径）——台账写了完整，磁盘也必须真是完整。 ──
    const docAbs = path.join(dataRoot, row.doc);
    const attAbs = path.join(path.dirname(docAbs), row.attachment.name);
    assert.equal(fs.existsSync(attAbs), true, '附件文件必须存在：' + attAbs);
    const diskRaw = fs.readFileSync(attAbs);
    assert.equal(diskRaw.length, fx.targetAttachmentBytes,
      '磁盘附件字节数必须 == 完整字节数（实际 ' + diskRaw.length + ' B）');
    assert.equal(sha256Hex(diskRaw), fx.targetAttachmentSha,
      '磁盘附件 sha256 必须按完整事件重算一致（c19 重放对账通过）');

    // ── 记录一条可复算的 diag（断言全绿时也打出来，便于把"绿"截图留证） ──
    console.log('[re4-台账/A] ' + JSON.stringify({
      code: row.code,
      attachmentBytes: row.attachment.bytes,
      eventsCount: row.attachment.eventsCount,
      statWritten: stat.written,
      statEventBatches: stat.eventBatches,
      statEventShortBatch: stat.eventShortBatch,
      statEventReadRetries: stat.eventReadRetries,
      warnCount: log.warnLines.length,
      warnSample: log.warnLines.slice(0, 2),
    }));
  });
});

// ============================================================================
// 四、断言 B（契约级）—— readTurnEventsBatch 的 truncated 出参与 endByte 口径
// ============================================================================

test('K-16/B（契约级）：小预算读到帧边界 → truncated 标出第 22 轮、endByte 停在帧边界；放大预算重读 → cut.size===0 且末事件是本轮 turn/end', () => {
  // 守：上层"放大预算重试"全靠这个出参（index.js 的重试条件从"只查缺轮"改成"缺轮 或 有截断轮"）。
  //     旧实现没有 opts.truncated，尾巴 emit 的 endByte 还用 stats.size（假称已读到文件尾）——
  //     于是上层永远不知道这一轮没读全。这里把契约直接钉住。
  const fx = buildFixture();
  assertFixtureShape(fx);
  console.log('[re4-fixture-尺寸/B] ' + JSON.stringify(dimsOf(fx)));

  withTemp((dir) => {
    const file = path.join(dir, SESSION_FILE);
    fs.writeFileSync(file, fx.fileBuffer);

    // ── ① 小预算：span(帧2) + 32 KiB —— 停在帧 3 起点，读不到帧 3 里的 turn/end ──
    const cut = new Set();
    const offsets = new Map();
    const partial = readTurnEventsBatch(file, new Set([TARGET_TURN]), {
      fromByte: fx.frame2Start,
      maxBytes: fx.budgetSmall,
      offsets,
      truncated: cut,
    });

    assert.equal(cut.has(TARGET_TURN), true,
      '★ 预算停在帧边界时，truncated 出参必须标出该轮（旧实现 cut 恒空 → 半截轮被当完整轮）');
    const pe = partial.get(TARGET_TURN);
    assert.ok(Array.isArray(pe), '预算截断也必须把"已读到的事件"交出来（不丢真数据）');
    assert.equal(pe.length, TARGET_EVENTS_IN_FRAME2,
      '截断读只能拿到帧 2 里的 ' + TARGET_EVENTS_IN_FRAME2 + ' 个事件（实际 ' + pe.length + '）');
    assert.equal(pe[pe.length - 1].type !== 'turn/end', true,
      '截断读的最后一个事件不可能是 turn/end（否则就没截断，夹具尺寸错了）');
    const range = offsets.get(TARGET_TURN);
    assert.ok(range && typeof range === 'object', 'offsets 出参必须给出该轮帧区间');
    assert.equal(range.endByte, fx.frame3Start,
      '★ 预算截断时 endByte 必须取 stats.stoppedAt（帧 3 起点 ' + fx.frame3Start +
      '），不许报 stats.size（文件尾 ' + fx.fileSize + '，那等于假称"已读到文件尾"）');

    // ── ② 大预算重读：读到文件尾 → 该轮闭合，truncated 必须被清空 ──
    const cutFull = new Set();
    const full = readTurnEventsBatch(file, new Set([TARGET_TURN]), {
      fromByte: fx.frame2Start,
      maxBytes: fx.fileSize, // 足够读到文件尾（帧 1 之前那段不会再读）
      truncated: cutFull,
    });
    assert.equal(cutFull.has(TARGET_TURN), false,
      '★ 读到 turn/end 后该轮必须从 truncated 里摘掉（不许残留，否则上层会无限重试）');
    assert.equal(cutFull.size, 0, '读全后 truncated 必须为空（实际 size=' + cutFull.size + '）');
    const fe = full.get(TARGET_TURN);
    assert.ok(Array.isArray(fe), '完整读必须返回该轮事件');
    assert.equal(fe.length, TARGET_EVENTS,
      '完整读必须拿到全部 ' + TARGET_EVENTS + ' 个事件（实际 ' + fe.length + '）');
    assert.equal(fe[0].type, 'turn/start', '第一个事件必须是本轮的 turn/start');
    const last = fe[fe.length - 1];
    assert.equal(last.type, 'turn/end', '最后一个事件必须是本轮的 turn/end');
    assert.equal(last.data && last.data.turn, TARGET_TURN, 'turn/end 必须属于本轮（第 22 轮）');

    console.log('[re4-契约/B] ' + JSON.stringify({
      smallBudget: fx.budgetSmall,
      partialEvents: pe.length,
      cutPartial: Array.from(cut),
      stoppedEndByte: range.endByte,
      fullEvents: fe.length,
      cutFullSize: cutFull.size,
      lastEventType: last.type,
    }));
  });
});
