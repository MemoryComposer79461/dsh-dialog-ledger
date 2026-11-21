/**
 * @file ledger.js
 * @role 台账读写 —— **唯一允许写盘的地方**。负责 zstd 解压、jsonl 追加、查重。
 * @called-by index.js（每轮扫描与落账）
 * @depends node:fs、node:path、node:zlib、./encoder.js
 * @why 把"写盘"收拢到一个文件，是为了让"谁改了账"只有一个答案。
 *      将来要做加锁、要做备份、要做校验，改这一处就够。
 *
 * ⚠️ 五个不能违反的约束：
 *   ① 只许追加（append），不许改写已有行 —— 账的原则
 *   ② 必须幂等：同一个 code 写两次，第二次直接跳过，不报错、不重复
 *   ③ 解压失败必须【可计数、可报告】，不许静默吞掉
 *   ④ 追加前必须确保文件尾是换行、追加后必须 fsync ——
 *      否则两条账会粘成一条坏 JSON，或"写成功了但断电后没了"
 *   ⑤ 坏帧/半截帧造成的**字节缺口**必须留痕到 `ledger/.lost.jsonl`
 *      （只追加、含可复算的字节区间与 hash），供对账器读 ——
 *      "这一轮为什么没进账"必须有据可查，不能只是一行 warn。
 *
 * ---------------------------------------------------------------------------
 * ★ K-13（v1.0.0-re3 · 审计② A1）：readAll 的 stat 失败 ≠ "空库已证明"。
 *   只有 ENOENT 是"首次开账"；EACCES/EMFILE/EBUSY/EIO 等 → ok=false + readErrors[{code:'E_STAT',
 *   statCode, file, message}]，emptyProven 必须 false；appendTurn 写前做目录/账文件的
 *   stat/access 探针，无法证明"code 不存在"时拒写（reason='ledger-unreadable'，不带任何字节变化）。
 * ★ K-14（v1.0.0-re3 · 审计② A2）：坏帧 halt 时游标不得越过"在 halt 之前开始、且未在 halt
 *   之前闭合"的轮的起始字节 —— `nextOffset = min(haltOffset, 这些轮的最小 startByte)`；
 *   无此类轮时 = haltOffset。证据：cursorClamped/cursorClampByte/haltBoundaryTurns/openTurnStartByte。
 * ★ K-15（v1.0.0-re3 · 审计③ CORE-01 消费侧）：frames 已把超大帧定为**可跳过缺口**
 *   （K-8 元数据 gapAdvanceable/nextSafeOffset/skippedRanges）。ledger 不再把"只有可跳过缺口"
 *   当整会话停摆：推进游标到 min(plannedNext, nextSafeOffset)、blocked=false，loss 结构化
 *   （lossSkipped/skippedFrames/skippableBytes/skippedRanges/oversizedDecompressed，reasons 含
 *   'oversized-frame'）；真坏帧/坏魔数/截断尾仍按 K-4 停住。以上均为只加不改。
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { normalizeSessionId, isoTime } from './encoder.js';
import { decodeFramesFrom, streamFrames } from './frames.js';

/** zstd 帧的魔数：0x28 0xB5 0x2F 0xFD。DSH 每次追加写一帧，所以一个文件有多个帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH 会话文件名（固定）。v0.2 只认 v4，其余版本要显式报"不支持"而不是静默跳过。 */
const SESSION_FILE = 'session.v4.jsonl.zstd';

/** 任意版本的会话文件名。用于发现"有会话、但版本不是 v4"。 */
const SESSION_FILE_ANY = /^session\.v(\d+)\.jsonl\.zstd$/;

// ============================================================================
// 一、zstd 多帧解压
// ============================================================================

/**
 * 解压 DSH 的多帧 zstd 文件。
 *
 * @param {Buffer} buf 整个 .zstd 文件的字节
 * @returns {{text: string, frames: number, ok: number, failed: number, bytes: number}}
 *          text = 拼好的 UTF-8 文本；failed > 0 说明有帧解不出来（要报警）
 *
 * @why **为什么不能用 zlib.zstdDecompressSync(buf)**：
 *      node 24 的 `zstdDecompressSync` 和 `createZstdDecompress` 都**只解第一帧**。
 *      实测（2026-11-08）：一个 142,664 B 的文件只解出 219 B。
 *      试过 `multiFrame` / `multipleFrames` / `allFrames` / `finishFlush` 选项，
 *      **全部无效**。
 *
 *      所以只能手工按魔数切帧。风险是"压缩数据内部恰好出现魔数"（假阳性），
 *      后果是那一帧解压失败 —— 而那是**可检测的**：failed 会 > 0。
 *      因此本函数把 failed 一起返回，让调用方去报警，而不是静默跳过。
 *
 * @example
 *   const r = decompressMultiFrame(fs.readFileSync(p));
 *   if (r.failed > 0) logger.warn(`zstd 有 ${r.failed} 帧解不开`);
 *   const lines = r.text.split('\n').filter(Boolean);
 */
export function decompressMultiFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { text: '', frames: 0, ok: 0, failed: 0, bytes: 0 };
  }

  // 找出所有魔数的位置
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) {
    starts.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + ZSTD_MAGIC.length);
  }

  // 没有魔数：可能是裸数据，直接当 UTF-8 返回（容错，不报错）
  if (starts.length === 0) {
    return { text: buf.toString('utf8'), frames: 0, ok: 0, failed: 0, bytes: buf.length };
  }

  const bounds = starts.concat([buf.length]);
  const parts = [];
  let ok = 0;
  let failed = 0;
  let totalBytes = 0;

  for (let k = 0; k < bounds.length - 1; k++) {
    const frame = buf.subarray(bounds[k], bounds[k + 1]);
    try {
      const out = zlib.zstdDecompressSync(frame);
      parts.push(out);
      totalBytes += out.length;
      ok++;
    } catch {
      // 解不开就是解不开 —— 计数，不编造内容
      failed++;
    }
  }

  return {
    text: Buffer.concat(parts).toString('utf8'),
    frames: bounds.length - 1,
    ok,
    failed,
    bytes: totalBytes,
  };
}

/**
 * 读一个 DSH 会话文件，返回已解析的事件数组。
 *
 * @param {string} filePath session.v4.jsonl.zstd 的完整路径
 * @returns {{head: object|null, events: object[], meta: object}}
 *          head = 第 1 行（type==="session" 的会话头）
 *          events = 其余可解析的事件
 *          meta = { frames, ok, failed, lines, badLines }
 *
 * @why head 单独摘出来，因为它是"会话身份证"（id / cwd / createdAt / agentPreset）。
 *      events 不含 head，避免调用方每次都 i>0 过滤。
 */
export function readSessionEvents(filePath) {
  const r = readSessionFrom(filePath, { fromByte: 0 });
  // 保持 v0.1 的返回形状（meta 只留五个键）：老调用方/老测试按精确形状断言，
  // v0.2 新增的 fromByte/size/nextOffset 属于内部游标信息，不外泄。
  const meta = {
    frames: r.meta.frames,
    ok: r.meta.ok,
    failed: r.meta.failed,
    lines: r.meta.lines,
    badLines: r.meta.badLines,
  };
  return { head: r.head, events: r.events, meta };
}

/**
 * 把一次读取里发现的"缺口"整理成结构化 loss 对象（P1-5 / K-4）。
 *
 * @param {{filePath:string, stats:object, fromByte:number, meta:object, badMagic:boolean}} p
 * @returns {{v:number, file:string, fromByte:number, size:number, frames:number, ok:number,
 *            failed:number, badLines:number, reasons:string[],
 *            failedRanges:Array<{start:number,end:number}>, failedOffsets:number[],
 *            halted:boolean, haltOffset:number, stopReason:string,
 *            hasGap:boolean}}
 *
 * @why 单独成函数并返回 JSON 可序列化对象：
 *      ① `.lost.jsonl`、对账、运行报告都要同一份形状，不能各拼各的；
 *      ② 坏帧区间与起点是"可复算凭据"——按区间重解 zstd 必然失败，可独立复核；
 *      ③ 上层据此决定"停不停游标"，不用再回头翻 meta 猜。
 * @why （K-4）额外带 halted/haltOffset/stopReason：
 *      坏帧的停止位置必须是**坏帧起点**（可重试），不能是文件尾（伪 EOF）。
 */
function buildLoss({ filePath, stats, fromByte, meta, badMagic }) {
  const failedRanges = Array.isArray(stats && stats.failedRanges) ? stats.failedRanges : [];
  const failedOffsets = Array.isArray(stats && stats.failedOffsets) ? stats.failedOffsets : [];
  const failed = Number(stats && stats.failed) || 0;
  const badLines = Number(meta && meta.badLines) || 0;
  const halted = !!(stats && stats.halted);
  const stopReason = String((stats && stats.stopReason) || '');
  const haltOffset = halted && Number.isInteger(stats.haltOffset) ? stats.haltOffset : 0;
  const reasons = [];
  if (badMagic) reasons.push('bad-magic');
  if (failed > 0) reasons.push('failed-frames');
  if (stopReason === 'truncated-tail' && !reasons.includes('truncated-tail')) reasons.push('truncated-tail');
  if (stopReason === 'bad-structure' && !reasons.includes('bad-structure')) reasons.push('bad-structure');
  // ★ F-3（方案 B）：帧=整行契约被破坏（硬断言停手）——固定原因串，供 .lost / 判定按名匹配。
  if (stopReason === 'contract-violation' && !reasons.includes('contract-violation')) reasons.push('contract-violation');
  // ★ P1-3：超大单帧被"跳过"也必须有单独原因（它不是坏帧、不 halt，但确实丢了一段）。
  // ★ K-15：原因字符串**固定**为 'oversized-frame'（判据/自测按此断言，不随实现漂移）。
  if (failedRanges.some((r) => r && r.oversized) && !reasons.includes('oversized-frame')) {
    reasons.push('oversized-frame');
  }
  if (badLines > 0) reasons.push('bad-lines');

  return {
    v: 1,
    file: filePath,
    fromByte,
    size: Number(stats && stats.size) || 0,
    frames: Number(stats && stats.frames) || 0,
    ok: Number(stats && stats.ok) || 0,
    failed,
    badLines,
    reasons,
    failedRanges,
    failedOffsets,
    halted,
    haltOffset,
    stopReason,
    // ★ K-15：可跳过缺口（超大帧/解压超限）的结构化元数据（来自 frames K-8；只加不改）。
    skipped: Number(stats && stats.skipped) || 0,
    skippableBytes: Number(stats && stats.skippableBytes) || 0,
    skippedRanges: Array.isArray(stats && stats.skippedRanges) ? stats.skippedRanges : [],
    gapAdvanceable: !!(stats && stats.gapAdvanceable),
    nextSafeOffset: Number.isInteger(stats && stats.nextSafeOffset) ? stats.nextSafeOffset : null,
    oversizedDecompressed: Number(stats && stats.oversizedDecompressed) || 0,
    // hasGap = "这段读取里确实有东西没读到"；false 才是"由成功读取证明的空/全"
    hasGap: failed > 0 || !!badMagic || badLines > 0,
  };
}

/**
 * ★ K-14：坏帧 halt 时的游标上限。
 *
 * 契约（v1.0.0-re3，已写死）：
 *   **坏帧 halt 时，nextOffset = min(haltOffset, 所有在 halt 之前开始、且未在 halt 之前闭合的轮
 *   的最小 startByte)；不存在这样的轮时 = haltOffset。**
 *   "未在 halt 之前闭合" = 无 endByte（仍 open）或 endByte ≥ haltOffset（轮跨过坏帧边界）。
 *
 * @param {object[]} closedTurns 已闭合轮（可含 abandoned；要求 startByte/endByte 为整数）
 * @param {object|null} openTurn 扫描结束时仍未闭合的轮
 * @param {number} haltOffset 第一个坏帧起点
 * @returns {{offset:number, clamped:boolean, turns:Array<{turn:(number|null),startByte:number,endByte:(number|null)}>}}
 *
 * @why 只靠 open 轮不够：坏帧之后如果还能解出该轮的 turn/end，扫描结束时 open=null，
 *      但这一轮是"跨坏帧的闭合轮"（start < halt < end），从 haltOffset 续读只剩 end、
 *      配对失败 → 源修复后该轮无法补回。所以两类边界轮都要收窄游标。
 */
function haltCursorLimit(closedTurns, openTurn, haltOffset) {
  const turns = [];
  const consider = (t) => {
    if (!t || !Number.isInteger(t.startByte)) return;
    if (t.startByte >= haltOffset) return; // 起点不早于坏帧 → 不约束游标
    const end = Number.isInteger(t.endByte) ? t.endByte : null;
    if (end !== null && end < haltOffset) return; // 整轮都在 halt 之前完成 → 不约束
    if (!turns.some((x) => x.turn === t.turn && x.startByte === t.startByte)) {
      turns.push({ turn: typeof t.turn === 'number' ? t.turn : null, startByte: t.startByte, endByte: end });
    }
  };
  for (const t of Array.isArray(closedTurns) ? closedTurns : []) consider(t);
  consider(openTurn);
  turns.sort((a, b) => a.startByte - b.startByte);
  const minStart = turns.length ? turns[0].startByte : null;
  const offset = minStart !== null && minStart < haltOffset ? minStart : haltOffset;
  return { offset, clamped: offset !== haltOffset, turns };
}

/**
 * 只读"轮次边界"，不保留事件内容 —— 229 MB 级会话的真正解法。
 *
 * @param {string} filePath
 * @param {{
 *   fromByte?:number, head?:object, maxBytes?:number, windowBytes?:number,
 *   maxFrameBytes?:number, maxDecompressedBytes?:number,
 *   root?:string, sid?:string, sessDir?:string, offsetMinutes?:number, now?:number,
 *   advanceOnFailed?:boolean
 * }} [opts]
 *   maxBytes / windowBytes：**预算**语义，透传给 frames.streamFrames（K-2，0.9.3）。
 *   maxBytes = 本次最多解多少字节（帧边界停）；windowBytes = 单次系统读的窗口粒度
 *   （不传 = frames 的 8 MiB 默认值，行为与 K-2 之前逐字节相同）。
 *   maxFrameBytes / maxDecompressedBytes：★ K-15 透传 frames 既有上限（不改 frames、不改默认），
 *   供契约自测构造"可跳过超大帧"；生产路径不传 = frames 默认（64 MiB）。
 *   root 提供时，发现缺口会**自动追加** `<root>/ledger/.lost.jsonl`（只追加、可复算）；
 *   不给 root 则纯读、不写任何文件。
 *   advanceOnFailed=true 是人工处置开关：有坏帧也照旧推进游标（默认 false，见下）。
 * @returns {{
 *   head: object|null,
 *   closed: Array<{turn:number,startMs:number,endMs:number,reason:string,startByte?:number,endByte?:number}>,
 *   open: {turn:number,startMs:number,endMs:number,reason:string,startByte:number}|null,
 *   malformed: number,
 *   meta: object,
 *   formatError: string,
 *   loss: object,
 *   lossRecord?: object
 * }}
 *
 * @why 为什么不能继续用 readSessionFrom：
 *      它把整份会话的**所有事件**都塞进 events 数组。20,000 轮 ≈ 20 万个事件对象、
 *      每个还带着一两 KB 的正文，133 MB 文件能扛住，229 MB 就崩了（exit 134）。
 *      而 v0.2 的台账只需要"这一轮什么时候开始/结束、叫什么"，**正文一行都不需要**。
 *      所以这里逐帧解析、只留当前轮的边界结构，正文解析完立即丢弃 —— 内存从 O(事件数) 降到 O(轮数)。
 *
 * @why 为什么仍要 resumeAt：
 *      续读点必须回到"未闭合轮开始的那一帧"，否则下次只读到 turn/end，
 *      配对失败，整轮丢失（与 readSessionFrom 同一套规则）。
 *
 * @why 为什么每轮要带 startByte/endByte（P0-3）：
 *      调用方会把大会话拆成"每批 N 轮"处理，处理完一批就要把游标推到这个批次之后。
 *      没有字节偏移就只能整会话重跑，杀进程后无法从已提交批次续。
 *      口径：`startByte` = 该轮 `turn/start` 所在帧的起始偏移；
 *            `endByte`   = 该轮 `turn/end` 所在帧的起始偏移（**帧起点，不是帧尾**，
 *                          因为续读必须落在帧边界；从它续读会重读该帧，靠幂等闸门去重）；
 *            `abandoned` 轮（被下一轮 start 顶掉）的 `endByte` = 下一轮 start 的帧起点；
 *            未闭合轮只保证 `startByte`。
 *
 * @why 坏帧为什么**不推进游标**（P1-5，审计驱动）：
 *      推过去 = 这一帧里的轮次永远不会再被读到，而账面上没有任何痕迹（静默丢失）；
 *      停住 = 该会话每轮都被重读并重复上报 `.lost`，人能看见、能处置
 *      （补文件 / 人工换游标 / 显式传 advanceOnFailed）。
 *      停住**不丢已解出的数据**：本次已闭合的轮次照常返回（写入由闸门去重）。
 *      ★ K-14：停住位置还要收窄到"跨坏帧边界轮的最小 startByte"（见 haltCursorLimit）。
 * @why ★ K-15：若缺口**全部可跳过**（frames gapAdvanceable：超大帧/解压超限，非坏帧），
 *      不再 blocked —— 推进游标到 min(plannedNext, nextSafeOffset) 并结构化记 loss，
 *      否则游标钉 0、每 tick 全量重扫、预算截断后新轮永远读不到（审计③ CORE-01）。
 */
export function readTurnsFrom(filePath, opts = {}) {
  const fromByte = Number.isInteger(opts.fromByte) && opts.fromByte > 0 ? opts.fromByte : 0;
  const knownHead = opts.head && typeof opts.head === 'object' ? opts.head : null;

  const meta = {
    frames: 0, ok: 0, failed: 0, lines: 0, badLines: 0,
    fromByte, size: 0, nextOffset: 0,
    // ★ K-14/K-15：稳定的证据字段（只加不改；无缺口时也是稳定形状）。
    stoppedAt: null, lossSkipped: false, skippedFrames: 0, skippableBytes: 0,
    skippedRanges: [], oversizedDecompressed: 0,
    cursorClamped: false, cursorClampByte: null, haltBoundaryTurns: [], openTurnStartByte: null,
  };
  const out = {
    head: fromByte === 0 ? null : knownHead,
    closed: [], open: null, malformed: 0, meta, formatError: '',
  };
  if (!fs.existsSync(filePath)) return out;

  let open = null;
  let resumeAt = null;

  const stats = streamFrames(filePath, fromByte, (text, frameStart) => {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      meta.lines++;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        meta.badLines++;
        continue;
      }
      if (ev && ev.type === 'session' && out.head === null) {
        out.head = ev;
        continue;
      }
      const t = ev && ev.type;
      if (t !== 'turn/start' && t !== 'turn/end') continue;

      const time = typeof ev.time === 'number' && Number.isFinite(ev.time) && ev.time > 0 ? ev.time : 0;
      const num = ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;
      if (time === 0 || num === null) {
        out.malformed++;
        continue;
      }

      if (t === 'turn/start') {
        // ★ P1-1（异地压测发现）：上一轮没闭合、又来了新的 start，
        //   旧实现直接覆盖 open —— 旧轮永远消失，而且 errors 是干净的。
        //   现在把它收成 partial（reason='abandoned'），让"缺"这件事可见。
        //   同一轮重发 start（重试）不算 abandoned，否则重试会记两条、
        //   (sid,turn) 闸门反而把真记录挡掉。
        if (open && open.turn !== num) {
          open.endMs = open.startMs;
          open.reason = 'abandoned';
          // 口径：被顶掉的轮的结束位置 = 新轮 turn/start 所在帧的起点（>= startByte）。
          // 同一帧里出现两个 start 时帧内切不开，按 startByte 记（续读仍落在帧边界）。
          open.endByte = frameStart >= open.startByte ? frameStart : open.startByte;
          out.closed.push(open);
          out.abandoned = (out.abandoned || 0) + 1;
        }
        open = { turn: num, startMs: time, endMs: 0, reason: '', startByte: frameStart };
        resumeAt = frameStart;
      } else if (open && open.turn === num) {
        open.endMs = time;
        open.reason = (ev.data && ev.data.reason && ev.data.reason.kind) || '';
        // 口径：endByte = turn/end 所在帧的**起点**（续读必须落在帧边界）。
        // 从它续读会重读该帧里的 turn/end，读侧无对应 start 会忽略，靠闸门去重。
        open.endByte = frameStart;
        out.closed.push(open);
        open = null;
        resumeAt = null;
      }
    }
  }, {
    maxBytes: opts.maxBytes,
    windowBytes: opts.windowBytes,
    // ★ K-15：透传 frames 既有上限（默认不变；只供契约自测构造可跳过超大帧）。
    maxFrameBytes: opts.maxFrameBytes,
    maxDecompressedBytes: opts.maxDecompressedBytes,
    // ★ F-3（方案 B）：会话 JSONL 读取启用「帧=整行」硬断言（通用解帧/夹具不启用）。
    assertLineBoundary: true,
  });

  meta.size = stats.size;
  meta.frames = stats.frames;
  meta.ok = stats.ok;
  meta.failed = stats.failed;
  meta.failedRanges = Array.isArray(stats.failedRanges) ? stats.failedRanges : [];
  meta.failedOffsets = Array.isArray(stats.failedOffsets) ? stats.failedOffsets : [];
  // ★ K-4：坏帧/半尾帧的"停住位置"= 第一个坏帧的起点（**绝不允许**是文件尾）。
  //   游标层据此只提交到坏帧之前的已提交前缀末尾；下一 tick 从那里重试。
  meta.halted = !!stats.halted;
  meta.haltOffset = meta.halted && Number.isInteger(stats.haltOffset) ? stats.haltOffset : 0;
  meta.stopReason = meta.halted ? String(stats.stopReason || '') : '';
  // ★ K-15：可跳过缺口的稳定证据字段（来自 frames K-8；无缺口时为稳定空形状）。
  meta.stoppedAt = stats.stopped && Number.isInteger(stats.stoppedAt) ? stats.stoppedAt : null;
  meta.skippedFrames = Number(stats.skipped) || 0;
  meta.skippableBytes = Number(stats.skippableBytes) || 0;
  meta.skippedRanges = Array.isArray(stats.skippedRanges) ? stats.skippedRanges : [];
  meta.oversizedDecompressed = Number(stats.oversizedDecompressed) || 0;

  // 结构化缺口：即使这次不写 .lost.jsonl（未给 root），调用方也能从 loss 判"停不停"
  out.loss = buildLoss({ filePath, stats, fromByte, meta, badMagic: !!stats.badMagic });

  // root 由调用方给时才落永久错误清单（读函数默认零副作用；见 JSDoc）
  if (opts.root) {
    try {
      out.lossRecord = lostTurns(opts.root, {
        file: filePath,
        result: out,
        sid: typeof opts.sid === 'string' ? opts.sid : '',
        sessDir: typeof opts.sessDir === 'string' ? opts.sessDir : '',
        offsetMinutes: Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480,
        now: Number.isFinite(opts.now) ? opts.now : undefined,
        // ★ P2-02（本机测试报告）：复核扫描必须用**与读取相同**的帧上限。
        //   @why 读取用 8 MiB 上限跳过了超大帧，复核却用 frames 默认 64 MiB 把同一帧读成功，
        //        于是 .lost 记录出现 "failedFrames=1 但 failedFrameOffsets=[]/missing=[]/skippedRanges=[]"
        //        —— 按记录无法复算到底跳过了哪一帧（第三方核不出来的"证据"）。
        maxFrameBytes: opts.maxFrameBytes,
        maxDecompressedBytes: opts.maxDecompressedBytes,
      });
      if (out.lossRecord && !out.lossRecord.ok) {
        meta.lossWriteError = out.lossRecord.reason || 'lost-write-failed';
      } else if (out.lossRecord && out.lossRecord.recorded) {
        meta.lostRecorded = true;
      }
    } catch (e) {
      // 留痕写不进去是故障，但不该把读取本身炸掉 —— 结构化上报给调用方
      meta.lossWriteError = e && e.message ? e.message : String(e);
    }

    // 契约 D9/P1-5：坏帧/坏魔数还要进 `.errors.jsonl`（kind=FRAME_FAILED，fingerprint 去重）。
    // `.lost.jsonl` 是"缺口证据"（字节区间+hash），`.errors.jsonl` 是"错误台账"（谁、何时、重试性）——
    // 两者职责不同，都必须写；运行报告的 lostGaps 计数仍以 .lost.jsonl 行数为准（契约 D7）。
    if (out.loss.hasGap && (Number(meta.failed) > 0 || stats.badMagic)) {
      let sourceBytes = 0;
      let sourceMtimeMs = 0;
      try {
        const st = fs.statSync(filePath);
        sourceBytes = st.size;
        sourceMtimeMs = Math.trunc(st.mtimeMs);
      } catch { /* 文件已消失：按 0 记，仍要留痕 */ }
      // ★ CH-10（契约 D9）：`source` 用**绝对路径**。
      //   相对路径在换 root / 换机器后无法还原"到底哪个文件坏了"，等于事实不可溯源。
      //   （曾写成 path.relative(root, filePath)，验收里表现为"清单查不到这个源"。）
      const source = filePath;
      const detail = [
        stats.badMagic ? `bad-magic@${fromByte}` : '',
        Number(meta.failed) > 0
          ? `failedFrames=${meta.failed}/${meta.frames};failedOffsets=${JSON.stringify(meta.failedOffsets)}`
          : '',
        Number(meta.badLines) > 0 ? `badLines=${meta.badLines}` : '',
      ].filter(Boolean).join(' | ');
      try {
        const er = appendErrorEvent(opts.root, {
          kind: 'FRAME_FAILED',
          source,
          sourceBytes,
          sourceMtimeMs,
          // ★ CH-10：offset 必须记**坏帧起点**，不是本次读的起点。
          //   否则第一轮从 0 读、第二轮从坏帧起点读，同一次故障会落成两条不同指纹的记录，
          //   而契约要求"同现场两轮只追加 1 条"。
          offset: Array.isArray(meta.failedOffsets) && Number.isInteger(meta.failedOffsets[0])
            ? meta.failedOffsets[0]
            : fromByte,
          detail,
          retryable: true,
        }, {
          nowMs: Number.isFinite(opts.now) ? opts.now : undefined,
          offsetMinutes: Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480,
        });
        if (er.ok) {
          meta.errorFingerprint = er.record ? er.record.fingerprint : '';
          meta.errorRecorded = !!er.recorded;
        } else {
          meta.lossWriteError = (meta.lossWriteError ? meta.lossWriteError + '; ' : '') +
            ('errors-write-failed:' + (er.reason || '?'));
        }
      } catch (e) {
        meta.lossWriteError = (meta.lossWriteError ? meta.lossWriteError + '; ' : '') +
          ('errors-write-failed:' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  if (stats.badMagic) {
    meta.nextOffset = 0;
    meta.blocked = true;
    meta.blockReason = 'bad-magic';
    out.formatError = 'bad-magic@' + fromByte;
    out.open = open;
    return out;
  }

  out.open = open;
  // 预算用完时停在帧边界：续读点 = stoppedAt；否则 = 文件尾
  const plannedNext = open && resumeAt !== null ? resumeAt : (stats.stopped ? stats.stoppedAt : stats.size);
  meta.stopped = !!stats.stopped;
  meta.openTurnStartByte = open && Number.isInteger(open.startByte) ? open.startByte : null;
  if (out.loss.hasGap && !opts.advanceOnFailed) {
    // ★ P1-5：有缺口就不推进游标（除非人工显式 open the gate）。
    //   注意只拦"坏帧/坏魔数"这类**重读可能自愈**的缺口；坏行（bad-lines）重读也不会自愈，
    //   所以只记 loss、不拦游标，否则该会话永久停摆且没有任何恢复路径。
    if (Number(meta.failed) > 0 || stats.badMagic) {
      if (meta.halted && !stats.badMagic) {
        // ★★ K-4（审计 LED-01 修复）：坏帧/半尾帧 → 游标指向**坏帧起点**。
        //   旧实现把 nextOffset 设成 fromByte（=整段重读）或（更糟）读侧推到文件尾，
        //   于是"已解出的轮次"要么被上层整批丢弃，要么游标直接跳到 EOF 永不回头。
        //   现在：坏帧起点前的字节已经确定性地读完（结构分帧），从那里续读不会丢数据；
        //   游标层再把提交点收到"已提交前缀末尾"（最后一条真正落账的轮次结束位置）。
        //   ★ K-14（审计② A2）：再收窄到"跨 halt 边界轮的最小 startByte"——
        //   否则从 haltOffset 续读只剩 turn/end、配对失败，该轮源修复后也补不回来。
        const limit = haltCursorLimit(out.closed, out.open, meta.haltOffset);
        meta.nextOffset = limit.offset;
        meta.cursorClamped = limit.clamped;
        meta.cursorClampByte = limit.clamped ? limit.offset : null;
        meta.haltBoundaryTurns = limit.turns;
        meta.blocked = true;
        meta.blockReason = meta.stopReason === 'truncated-tail' ? 'truncated-tail' : 'failed-frames';
        meta.plannedNextOffset = plannedNext; // 证据：本来会推到哪
        meta.retryFrom = meta.nextOffset;
        meta.retryable = true;
      } else if (stats.gapAdvanceable) {
        // ★★ K-15（审计③ CORE-01 消费侧）：缺口全部"可跳过"（超大帧/解压超限，不是坏帧）
        //   → 不 blocked，推进游标到帧边界（budget 停点/未闭合轮回退/EOF），缺口结构化留痕。
        //   否则 nextOffset 被钉在 fromByte、每 tick 全量重扫；预算截断后新轮永远读不到。
        const safe = Number.isInteger(stats.nextSafeOffset) ? stats.nextSafeOffset : plannedNext;
        meta.nextOffset = Math.min(plannedNext, safe);
        meta.blocked = false;
        meta.blockReason = '';
        meta.lossSkipped = true;
        meta.plannedNextOffset = plannedNext; // 证据：本来会推到哪
        meta.retryFrom = '';
        meta.retryable = false; // 可跳过缺口重扫同配置不会自愈（不是"重试可恢复"的缺口）
      } else {
        meta.nextOffset = fromByte;
        meta.blocked = true;
        meta.blockReason = stats.badMagic ? 'bad-magic' : 'failed-frames';
        meta.plannedNextOffset = plannedNext; // 证据：本来会推到哪
        meta.retryable = true;
      }
    } else {
      meta.nextOffset = plannedNext;
      meta.blocked = false;
      meta.blockReason = '';
    }
  } else {
    meta.nextOffset = plannedNext;
    meta.blocked = false;
    meta.blockReason = '';
  }

  if (fromByte === 0) {
    const h = out.head;
    if (!h || h.type !== 'session' || typeof h.id !== 'string') out.formatError = 'bad-head';
  } else if (!out.head || typeof out.head.id !== 'string') {
    out.formatError = 'no-head-for-resume';
  }

  return out;
}

/**
 * 一次扫描取出**多轮**的事件（给"批量生成初始凭证"用）。
 *
 * @param {string} filePath
 * @param {Set<number>} turnSet 需要采集的轮次号
 * @param {{
 *   fromByte?:number,   // 从哪个帧起点开始扫（默认 0；P0-3 分批时传上一批末尾的 endByte）
 *   maxBytes?:number,   // 本次最多解多少字节（帧边界停；防大会话单次阻塞）
 *   windowBytes?:number, // 单次系统读的窗口粒度（K-2 透传；缺省 = frames 的 8 MiB）
 *   offsets?:Map<number,{startByte:number,endByte:number}>, // 出参：每轮帧区间（原地填充）
 *   truncated?:Set<number>, // ★ K-16 出参：因"预算停在帧边界"而未读全的轮次（不是真实未闭合轮）
 *   onTurnRange?:(turn:number, range:{startByte:number,endByte:number}) => void
 * }} [opts]
 * @returns {Map<number, object[]>} turn → 事件数组（**只保留 turnSet 里的轮**）
 *
 * @why 为什么必须有它：
 *      逐轮调用 `readTurnEvents` 会把整份会话重扫 N 次（O(n²)）。
 *      一个 5000 轮的会话就是 5000 次全文件解压 —— 压测必炸。
 *      改成"一次扫描、只留需要的那几轮"，复杂度回到 O(n)。
 *
 * @why 为什么只留"需要的那几轮"：
 *      每轮事件数组可能很大（工具输出），全留会把内存撑爆；
 *      而一次扫描通常只需要新写的那 1–3 轮，保留量极小。
 *
 * @why 内存特征（给 P0-3 的交底，别猜）：
 *      **流式过滤**，不是"先全收再过滤"：每帧解压后立刻逐行 JSON.parse，
 *      只有 `turnSet` 里的轮次会被保留（`current.events`），其它轮次的行解析完即丢。
 *      峰值内存 ≈ 单帧窗口（默认 8 MB）+ 本批保留的事件；**与文件大小无关**。
 *      ⚠️ 但本函数**默认从 0 扫**：批处理必须传 `fromByte`，否则每批都重扫全文件（CPU O(n²)）。
 *
 * @why 为什么每轮要带帧区间（P0-3）：
 *      调用方按批处理（每批 N 轮）时，必须能把游标推到"本批最后一轮之后"；
 *      没有 endByte 就只能整会话重跑。口径与 readTurnsFrom 一致：
 *      `endByte` = 该轮 turn/end 所在帧的**起点**；被下一轮顶掉的轮 = 下一轮 start 的帧起点；
 *      扫到文件尾仍未闭合的轮 = 读取时刻的文件大小。
 */
export function readTurnEventsBatch(filePath, turnSet, opts = {}) {
  const wanted = turnSet instanceof Set ? turnSet : new Set(turnSet || []);
  const fromByte = Number.isInteger(opts.fromByte) && opts.fromByte > 0 ? opts.fromByte : 0;
  const offsets = opts.offsets instanceof Map ? opts.offsets : null;
  const onTurnRange = typeof opts.onTurnRange === 'function' ? opts.onTurnRange : null;
  const out = new Map();
  // ★ K-16（re4）：预算停在帧边界造成的"半轮"是出参 —— 它不是真实的未闭合轮，
  //   而是"本批没读到头"。上层必须据此放大预算重试，绝不许把它当完整轮落账。
  const truncated = opts.truncated instanceof Set ? opts.truncated : null;
  /** 该轮是否已被它自己的 turn/end 闭合（只看本批保留的事件）。 */
  const isClosed = (events, turnNo) => {
    const last = events && events.length > 0 ? events[events.length - 1] : null;
    const n = last && last.data && Number.isInteger(last.data.turn) ? last.data.turn : null;
    return !!(last && last.type === 'turn/end' && n === turnNo);
  };
  let current = null; // { num, events, startByte }
  const emit = (endByte, budgetStopped = false) => {
    if (!current) return;
    const turnNo = current.num;
    const range = { startByte: current.startByte, endByte: Number.isInteger(endByte) ? endByte : current.startByte };
    if (wanted.has(turnNo)) {
      out.set(turnNo, current.events);
      if (offsets) offsets.set(turnNo, range);
      // ★ K-16：只有"读到文件尾/坏帧之后仍未闭合"才可能是真实未闭合轮；
      //   因预算停在帧边界而未闭合 = 被截断，必须显式标记，不许静默当完整。
      if (truncated && budgetStopped && !isClosed(current.events, turnNo)) truncated.add(turnNo);
      if (onTurnRange) {
        try { onTurnRange(turnNo, range); } catch { /* 回调异常不拖垮读取 */ }
      }
    }
    current = null;
  };

  const stats = streamFrames(filePath, fromByte, (text, frameStart) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev.type !== 'string') continue;
      const num = ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;

      if (ev.type === 'turn/start' && num !== null) {
        // 上一轮没等到 turn/end 就又开了一轮（异常/截断）：先把它交出去，别丢。
        // 口径：被顶掉的轮 endByte = 本轮 start 所在帧的起点。
        emit(frameStart);
        current = wanted.has(num) ? { num, events: [ev], startByte: frameStart } : null;
        continue;
      }
      if (!current) continue;
      if (num !== null && num !== current.num) {
        // 事件带了别的轮次号：不属于本轮，丢弃（也防止把上一轮的事件串进来）
        continue;
      }
      current.events.push(ev);
      if (ev.type === 'turn/end' && num === current.num) emit(frameStart);
    }
  }, {
    maxBytes: opts.maxBytes,
    windowBytes: opts.windowBytes,
    // ★ K-15：透传 frames 既有上限（默认不变；只供契约自测构造可跳过超大帧）。
    maxFrameBytes: opts.maxFrameBytes,
    maxDecompressedBytes: opts.maxDecompressedBytes,
    // ★ F-3（方案 B）：会话 JSONL 读取启用「帧=整行」硬断言（通用解帧/夹具不启用）。
    assertLineBoundary: true,
  });

  // 未闭合的轮次（只有 turn/start、没有 turn/end）也要交出去 ——
  // partial 兜底同样需要事件来渲染初始凭证；endByte 取读取时看到的文件尾。
  // ★ K-4：坏帧停止时取**坏帧起点**（续读点，不是文件尾）—— 否则游标层会以为
  //   这一轮已经被"读到尾"了。读取本身仍会把坏帧之后的好帧解出来（不丢真数据）。
  // ★ K-16（re4）：预算停在帧边界时取**停止点** stats.stoppedAt（仍是帧边界），并标成
  //   "被截断"。上一版这里一律用 stats.size，等于宣称"已读到文件尾"—— 于是 v3 跨帧轮的
  //   半截事件被当成完整轮落账（附件 51,723 B → 71 B 那条 P0 的落点之一）。
  emit(
    stats.halted && Number.isInteger(stats.haltOffset)
      ? stats.haltOffset
      : (stats.stopped && Number.isInteger(stats.stoppedAt) ? stats.stoppedAt : stats.size),
    !!stats.stopped && !stats.halted
  );

  return out;
}

/**
 * 只取某一轮的**全部事件**（含 turn/start、turn/end）。
 *
 * @param {string} filePath
 * @param {number} turnNo
 * @returns {object[]} 该轮事件；找不到返回空数组
 *
 * @why 为什么单独做一次扫描：v0.3 要生成"初始凭证"，需要该轮的逐字事件；
 *      而渲染只在一轮新记录时发生（每次扫描通常 0–3 轮），多扫一遍的代价可以接受，
 *      换来的是"主循环不持有全量事件"，内存不被撑爆。
 */
export function readTurnEvents(filePath, turnNo) {
  const out = [];
  let collecting = false;
  streamFrames(filePath, 0, (text) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev.type !== 'string') continue;
      const num = ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;
      if (ev.type === 'turn/start' && num === turnNo) {
        collecting = true;
        out.push(ev);
        continue;
      }
      if (collecting) {
        out.push(ev);
        if (ev.type === 'turn/end' && num === turnNo) return;
      }
    }
  }, { assertLineBoundary: true });
  return out;
}

/**
 * 从指定字节偏移读会话 —— v0.2 增量读的唯一入口。
 *
 * @param {string} filePath 会话文件
 * @param {{fromByte?:number, head?:object, maxBytes?:number, windowBytes?:number}} opts
 *        fromByte：从哪个**帧起点**开始读（0 = 从头）
 *        head：续读时由调用方从 `.state.json` 传回的会话头（续读时文件里没有它）
 *        maxBytes / windowBytes：预算语义，透传 frames.streamFrames（K-2）；缺省行为不变。
 * @returns {{
 *   head: object|null,
 *   events: object[],
 *   meta: {frames:number, ok:number, failed:number, lines:number, badLines:number,
 *          fromByte:number, size:number, nextOffset:number},
 *   formatError: string   // 空串 = 正常；非空 = 这一轮不许入账
 * }}
 *
 * @why 为什么要 nextOffset 而不是"读到文件尾"：
 *      一轮可能跨帧。读完后若最后那一轮还没闭合，续读点必须退回到**该轮开始的那一帧**，
 *      否则下次只读到 turn/end，配对失败，整轮丢失。所以：有未闭合轮 → nextOffset = 那帧起点；
 *      全部闭合 → nextOffset = 文件大小（下次什么都不用读）。
 *
 * @why 为什么坏魔数要 nextOffset = 0：
 *      偏移失效（文件被截断/重写）时，从错位置续读只会读出垃圾。
 *      此时把 nextOffset 归零，让上层**回退全量**并告警 —— 宁可多读一次，不可漏读一轮。
 *
 * @why 为什么格式守卫只在 fromByte===0 时判：
 *      会话头只在文件开头。续读时头由 state 提供，若 state 里没有头，
 *      说明这条路本来就不该被续读（no-head-for-resume），同样拒绝入账。
 */
export function readSessionFrom(filePath, opts = {}) {
  const fromByte = Number.isInteger(opts.fromByte) && opts.fromByte > 0 ? opts.fromByte : 0;
  const knownHead = opts.head && typeof opts.head === 'object' ? opts.head : null;

  const meta = {
    frames: 0, ok: 0, failed: 0, lines: 0, badLines: 0,
    fromByte, size: 0, nextOffset: 0,
    // ★ K-14/K-15：稳定证据字段（只加不改）。
    stoppedAt: null, lossSkipped: false, skippedFrames: 0, skippableBytes: 0,
    skippedRanges: [], oversizedDecompressed: 0,
    cursorClamped: false, cursorClampByte: null, haltBoundaryTurns: [], openTurnStartByte: null,
  };
  const out = { head: fromByte === 0 ? null : knownHead, events: [], meta, formatError: '' };
  if (!fs.existsSync(filePath)) return out;

  // 未闭合轮次所在帧的起点：续读必须从它开始
  let resumeAt = null;
  let open = false;
  let openStart = null;
  // ★ K-14：已闭合轮的边界（只留 startByte/endByte，正文/事件照旧进 out.events）——
  //   用于识别"跨坏帧边界的闭合轮"（start<halt<end），它们同样约束 halt 游标。
  const closedBounds = [];

  // ★ 分块流式解帧：内存里只留"一个窗口 + 一帧"，不再把整份解压结果拼成大 Buffer。
  const stats = streamFrames(filePath, fromByte, (text, frameStart) => {
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    meta.lines += lines.length;
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        meta.badLines++;
        continue;
      }
      if (obj && obj.type === 'session' && out.head === null) {
        out.head = obj;
        continue;
      }
      if (!obj || typeof obj.type !== 'string') continue;
      const turnNo = obj.data && Number.isInteger(obj.data.turn) ? obj.data.turn : null;
      if (obj.type === 'turn/start') {
        if (!open) { open = true; resumeAt = frameStart; openStart = frameStart; }
      } else if (obj.type === 'turn/end') {
        if (open) {
          // ★ K-14：留存边界（闭合轮的 endByte 口径 = turn/end 所在帧起点）。
          closedBounds.push({ turn: turnNo, startByte: openStart, endByte: frameStart });
          open = false;
          resumeAt = null;
          openStart = null;
        }
      }
      out.events.push(obj);
    }
  }, {
    maxBytes: opts.maxBytes,
    windowBytes: opts.windowBytes,
    // ★ K-15：透传 frames 既有上限（默认不变；只供契约自测构造可跳过超大帧）。
    maxFrameBytes: opts.maxFrameBytes,
    maxDecompressedBytes: opts.maxDecompressedBytes,
    // ★ F-3（方案 B）：会话 JSONL 读取启用「帧=整行」硬断言（通用解帧/夹具不启用）。
    assertLineBoundary: true,
  });

  meta.size = stats.size;
  meta.frames = stats.frames;
  meta.ok = stats.ok;
  meta.failed = stats.failed;
  meta.failedRanges = Array.isArray(stats.failedRanges) ? stats.failedRanges : [];
  meta.failedOffsets = Array.isArray(stats.failedOffsets) ? stats.failedOffsets : [];
  meta.halted = !!stats.halted;
  meta.haltOffset = meta.halted && Number.isInteger(stats.haltOffset) ? stats.haltOffset : 0;
  meta.stopReason = meta.halted ? String(stats.stopReason || '') : '';
  // ★ K-15：可跳过缺口证据（来自 frames K-8）。
  meta.stoppedAt = stats.stopped && Number.isInteger(stats.stoppedAt) ? stats.stoppedAt : null;
  meta.skippedFrames = Number(stats.skipped) || 0;
  meta.skippableBytes = Number(stats.skippableBytes) || 0;
  meta.skippedRanges = Array.isArray(stats.skippedRanges) ? stats.skippedRanges : [];
  meta.oversizedDecompressed = Number(stats.oversizedDecompressed) || 0;
  out.loss = buildLoss({ filePath, stats, fromByte, meta, badMagic: !!stats.badMagic });

  if (stats.badMagic) {
    meta.nextOffset = 0;
    out.formatError = 'bad-magic@' + fromByte;
    return out;
  }

  // 预算用完时停在帧边界：续读点 = stoppedAt；否则 = 文件尾
  meta.nextOffset = open && resumeAt !== null ? resumeAt : (stats.stopped ? stats.stoppedAt : stats.size);
  meta.stopped = !!stats.stopped;
  meta.openTurnStartByte = open && Number.isInteger(openStart) ? openStart : null;
  // ★ K-4：坏帧/半尾帧 → 续读点 = 坏帧起点（不是文件尾，也不是"从头再来"）。
  //   已解出的事件照常返回（上层落账/留痕），不因一帧坏就清空。
  //   ★ K-14：再收窄到"跨 halt 边界轮的最小 startByte"（与 readTurnsFrom 同一口径）。
  if (meta.halted) {
    const limit = haltCursorLimit(
      closedBounds,
      open && Number.isInteger(openStart) ? { turn: null, startByte: openStart, endByte: null } : null,
      meta.haltOffset,
    );
    meta.nextOffset = limit.offset;
    meta.cursorClamped = limit.clamped;
    meta.cursorClampByte = limit.clamped ? limit.offset : null;
    meta.haltBoundaryTurns = limit.turns;
    meta.retryFrom = meta.nextOffset;
    meta.retryable = true;
  } else if (stats.gapAdvanceable) {
    // ★ K-15：只有可跳过缺口（超大帧/解压超限）→ 照常推进游标并结构化留痕。
    const safe = Number.isInteger(stats.nextSafeOffset) ? stats.nextSafeOffset : meta.nextOffset;
    meta.nextOffset = Math.min(meta.nextOffset, safe);
    meta.lossSkipped = true;
    meta.retryable = false;
  }

  if (fromByte === 0) {
    const h = out.head;
    // 只判"是不是一个会话头"；createdAt 缺失不算格式错误 ——
    // 上层有"回落到本轮最早事件时间"的兜底，那是有意的兼容路径。
    if (!h || h.type !== 'session' || typeof h.id !== 'string') {
      out.formatError = 'bad-head';
    }
  } else if (!out.head || typeof out.head.id !== 'string') {
    out.formatError = 'no-head-for-resume';
  }

  return out;
}

// ============================================================================
// 二、账本文件路径
// ============================================================================

/**
 * 台账根目录（在"数据总库"下的 ledger/ 子目录）。
 * @param {string} root 数据总库根目录
 * @returns {string}
 */
export function ledgerDir(root) {
  return path.join(root, 'ledger');
}

/**
 * 某一天的账本文件路径：`<root>/ledger/YYYY-MM-DD.jsonl`
 *
 * @param {string} root
 * @param {string} dateISO 形如 "2026-11-08"
 * @returns {string}
 *
 * @why 按天分文件 —— 一天一个，崩了只影响一天，补抄也只补一个文件。
 */
export function ledgerPath(root, dateISO) {
  return path.join(ledgerDir(root), `${dateISO}.jsonl`);
}

/**
 * 运行状态文件路径：`<root>/ledger/.state.json`
 *
 * @param {string} root 数据总库根目录
 * @returns {string}
 *
 * @why 放在 ledger/ 而不是根目录：它不是档案，是"上一次跑到哪儿了"的运行痕迹。
 *      文件名以 `.` 开头，readAll 的过滤会把隐藏文件跳过，所以不会被当账读进来。
 */
export function statePath(root) {
  return path.join(ledgerDir(root), '.state.json');
}

/**
 * 缺口留痕文件路径：`<root>/ledger/.lost.jsonl`。
 *
 * @param {string} root 数据总库根目录
 * @returns {string}
 *
 * @why 为什么必须是 jsonl 且只追加：
 *      缺口是**一次一次**发生的（每轮扫描都可能遇到坏帧），留痕天然是事件流；
 *      只追加才能证明"过去报过什么"，也才能被对账器逐行复算。
 * @why 文件名以 `.` 开头：它不是账，而 readAll 只把**非隐藏**的 `.jsonl` 当账读
 *      （见 readAll 的过滤），否则每条缺口记录都会变成一条"没有 code 的账"。
 */
export function lostPath(root) {
  return path.join(ledgerDir(root), '.lost.jsonl');
}

/**
 * 读运行状态。文件不存在或损坏时返回空对象（不抛错）。
 *
 * @param {string} root
 * @returns {{initialized?:boolean, firstRunAt?:string, lastRunAt?:string, lastStat?:object}}
 *
 * @why 损坏时返回 {} 而不是抛错：状态文件丢了最多是"再全量扫一次"，
 *      而抛错会让整轮扫描停摆——两者代价差很远。
 */
export function readState(root) {
  return readStateEx(root).state;
}

/**
 * 结构化读 state（P1-8 的同一原则：**读取失败 ≠ 空状态**）。
 *
 * @param {string} root
 * @returns {{ok:boolean, exists:boolean, path:string, state:object, bytes:number,
 *            error:{code:string,message:string}|null}}
 *
 * @why 为什么要和 readState 并存：
 *      `readState()` 损坏时返回 `{}`（v0.1 起就是这语义，很多调用方靠它"不抛错"），
 *      但"没有 state" 与 "state 读坏了" 在会计上**完全不同**：
 *      前者=首次开账/state 丢失（走重建、要告警），后者=证据在但读不出来（必须停机排查）。
 *      所以新增本函数：`ok/exists/error` 三个字段把两种情况分开，调用方自行决定。
 *      `readState()` 保持旧语义（= `readStateEx().state`），不破兼容。
 */
export function readStateEx(root) {
  const p = statePath(root);
  const out = { ok: true, exists: false, path: p, state: {}, bytes: 0, error: null };
  let txt;
  try {
    const st = fs.statSync(p);
    out.exists = true;
    out.bytes = st.size;
    txt = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out; // 不存在：ok=true, exists=false（首次开账）
    out.ok = false;
    out.error = { code: 'E_STATE_READ', message: e && e.message ? e.message : String(e) };
    return out;
  }
  try {
    const obj = JSON.parse(txt);
    if (!obj || typeof obj !== 'object') throw new Error('state 不是对象');
    out.state = obj;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = { code: 'E_STATE_CORRUPT', message: e && e.message ? e.message : String(e) };
    return out;
  }
}

/**
 * 原子写运行状态：先写 `.state.json.tmp`，再 rename 覆盖。
 *
 * @param {string} root
 * @param {object} patch 与旧状态合并后写入
 * @returns {void}
 *
 * @why 用 rename 而不是直接覆写：
 *      进程在写到一半时被杀，直接覆写会留下半个 JSON，
 *      下次启动解析失败 → 状态丢失。rename 在同一分区上是原子的，
 *      读到的要么是旧文件、要么是新文件，不存在"半个"。
 */
export function writeState(root, patch) {
  const dir = ledgerDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = statePath(root);
  const tmp = target + '.tmp';
  const prev = readState(root);
  const next = { ...prev, ...(patch && typeof patch === 'object' ? patch : {}) };
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

// ============================================================================
// 三、读写
// ============================================================================

/**
 * 读台账里**所有**记录（跨所有日文件）。
 *
 * @param {string} root 数据总库根目录
 * @param {{quarantine?:boolean, nowMs?:number, offsetMinutes?:number, maxBadLineDetails?:number,
 *          repairTornTail?:boolean}} [opts]
 *        quarantine=true：把坏行**取证复制**到 `<root>/ledger/.quarantine/<账文件>.L<行号>.json`
 *        并返回 `quarantined`（台账字节**一个都不改** —— 只追加是底线；"移出"= 另存证据，不是重写账）。
 *        repairTornTail（**默认 true**）：把"崩溃撕裂尾巴"（末行半行 + 文件无结尾换行 + 该文件只有
 *        这一处坏行）取证到 `.quarantine/<账文件>.L<行号>.torn.json` 后**截断**该行；
 *        其它任何坏行不修（ok 仍=false）。传 false 可关闭（只读取证工具需要零副作用时用）。
 * @returns {{
 *   records: object[], files: number, badLines: number, dir: string,
 *   dirExists: boolean, ok: boolean, emptyProven: boolean,
 *   readErrors: Array<{file:string, code:string, message:string, statCode?:string,
 *                      line?:number, rawSha256?:string, offset?:number, error?:string}>,
 *   statError: {file:string, code:'E_STAT', statCode:string, message:string}|null,
 *   badLineDetails: Array<{file:string, lineNo:number, offset:number, bytes:number,
 *                          sha256:string, raw:string, truncated:boolean}>,
 *   badLineDetailsTruncated: number,
 *   fileNames: string[], tornTailRepaired: Array<{file:string, line:number, bytes:number,
 *                          sha256:string, at:string, offset:number, evidence:string}>,
 *   quarantined?: object
 * }}
 *
 * @why v0.1 直接全读：量小（一年也就几千条），换来"查重简单可靠"。
 *      v0.2 量大了再上索引；现在提前优化是没必要的成本。
 *
 * @why ★ P1-8（审计驱动）：读取失败必须结构化报错，**空数据只能由成功读取证明**。
 *      原实现两处静默：① readdir/readFile 失败直接 `continue` → 该日账凭空消失，
 *      调用方看到"没有这些行"，会据此写出**虚假的"无"**（交接表/周记账/对账都可能）；
 *      ② 坏行只 +1 计数、没有行号/内容/hash → 取证不了、也无法复核。
 *      现在：`ok=false` + `readErrors[]` + `badLineDetails[]`（含行号/偏移与 sha256）；
 *      `emptyProven=true` 才允许把"空"当事实（目录不存在 = 首次开账，也算成功证明）。
 *      **写路径同样受约束**：`appendTurn` 在无法证明 code 不存在时拒绝写（见 appendTurn）。
 */
/**
 * A-10：一条"合法 JSON"不等于"账行"。
 *
 * 账行最小形状：`code` 符合 32 位编码格式（`YYYYMMDD-xxxxxxxxxxxx-X-NNNNNNNN`，补记第 4 段为 B），
 * 且带 `ts`。读取端用它把"非账行 JSON"计入坏行 —— 否则坏数据会被当成"读到了"，
 * 对账与报告静默少算（假绿）。
 */
export const LEDGER_CODE_PATTERN = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;

export function isLedgerRow(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o)
    && typeof o.code === 'string' && LEDGER_CODE_PATTERN.test(o.code)
    && o.ts != null;
}

export function readAll(root, opts = {}) {
  const dir = ledgerDir(root);
  const maxDetails = Number.isInteger(opts.maxBadLineDetails) && opts.maxBadLineDetails > 0
    ? opts.maxBadLineDetails : 100;
  // ★ A-10（机主 2026-11-13 已签）：验账路径要"只认真账行"。
  //   `requireLedgerRows:true` 时，合法 JSON 但缺账行形状的行按坏行计（ok=false），
  //   避免"读不到"被算成"读到了"；默认 false 保持原宽容语义（普通读取/老数据不误报）。
  const strictRows = opts.requireLedgerRows === true;
  const out = {
    records: [], files: 0, badLines: 0, dir,
    dirExists: false, ok: true, emptyProven: false,
    readErrors: [], badLineDetails: [], badLineDetailsTruncated: 0,
    fileNames: [],
    // ★ K-13：stat 失败的结构化错误（只在"目录 stat 失败"时非空；ENOENT 不算失败）。
    statError: null,
    // ★ 崩溃撕裂尾巴自愈留痕（P0-3-resume）：只有三条硬条件全满足才修，见 detectAndRepairTornTail。
    //   空数组 = 没有发生；有内容 = 本轮真的截断过账尾，调用方必须把它记进 state/运行报告 + 日志 WARN。
    tornTailRepaired: [],
  };

  // 目录是否存在：★ K-13（审计② A1）**只有 ENOENT 才是"首次开账"**。
  //   旧实现 `try{statSync}catch{st=null}` 把 EACCES/EMFILE/EBUSY/EIO 全当"空库已证明、ok=true"，
  //   调用方据此写账 → 无法证明 code 不存在却照写 → 重复主键（账只追加，永远改不回来）。
  //   现在：stat 失败 → ok=false + readErrors[{code:'E_STAT', statCode, file, message}]，
  //   emptyProven 必须 false；"空"只能由**成功读取**证明。
  let st = null;
  let statFail = null;
  try { st = fs.statSync(dir); } catch (e) { statFail = e; }
  if (!st) {
    if (statFail && statFail.code === 'ENOENT') { out.emptyProven = true; return out; }
    out.ok = false;
    out.statError = {
      file: dir,
      code: 'E_STAT',
      statCode: statFail && statFail.code ? String(statFail.code) : '',
      message: statFail && statFail.message ? statFail.message : String(statFail),
    };
    out.readErrors.push({ ...out.statError });
    return out;
  }
  out.dirExists = true;
  if (!st.isDirectory()) {
    out.ok = false;
    out.readErrors.push({ file: dir, code: 'E_NOT_DIR', message: 'ledger 路径不是目录' });
    return out;
  }

  let names;
  try {
    // 只读**非隐藏**的 .jsonl：`.` 开头的是运行痕迹
    // （`.lost.jsonl`/`.errors.jsonl`/`.seal-journal.jsonl`/`.quarantine/`），
    // 不是账。若把它们当账读，每条运行记录都会变成一条没有 code 的"账"，
    // 还会把 hasCode / readAll 的记录数污染掉。
    names = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))
      .sort();
  } catch (e) {
    out.ok = false;
    out.readErrors.push({ file: dir, code: 'E_READDIR', message: e && e.message ? e.message : String(e) });
    return out;
  }
  out.fileNames = names;

  for (const n of names) {
    const p = path.join(dir, n);
    let txt;
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch (e) {
      // ★ P1-8：不 continue —— 记结构化错误，并让 ok=false（这一天的账"读不到"≠"没有"）
      out.ok = false;
      out.readErrors.push({ file: p, code: 'E_READ', message: e && e.message ? e.message : String(e) });
      continue;
    }
    out.files++;

    // ★ P0-3-resume（崩溃撕裂尾巴）：kill -9 落在 append 的 write 中途 → 末行半行、文件无结尾换行。
    //   只在三条硬条件全满足时**取证后截断**（见 detectAndRepairTornTail 的 @why 与红线），
    //   然后重读文件按正常路径解析。其它坏行一律维持原语义（ok=false，一个字节都不动）。
    //   可用 `opts.repairTornTail === false` 关闭（例如"只读取证工具"明确要零副作用时）。
    if (opts.repairTornTail !== false) {
      const repaired = detectAndRepairTornTail({
        root, fileName: n, filePath: p, text: txt,
        nowMs: opts.nowMs, offsetMinutes: opts.offsetMinutes,
      });
      if (repaired) {
        out.tornTailRepaired.push(repaired);
        try {
          txt = fs.readFileSync(p, 'utf8');
        } catch (e) {
          out.ok = false;
          out.readErrors.push({ file: p, code: 'E_READ', message: e && e.message ? e.message : String(e) });
          continue;
        }
      }
    }

    const fileLines = txt.split('\n');
    // 坏行要能被"定位"：除行号外还给**字节偏移**（契约 D9/P1-2 要求可复算的偏移）。
    // 口径：offset = 该行首字节在文件中的绝对偏移（按 UTF-8 字节计，行尾 '\n' 算 1 字节）；
    //       文件末尾没有换行的最后一行也按实际字节算。
    let lineOffset = 0;
    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (!line.trim()) { lineOffset += Buffer.byteLength(line, 'utf8') + 1; continue; }
      let parsed = null;
      let parseErr = null;
      try { parsed = JSON.parse(line); } catch (e) { parseErr = e; }
      // ★ A-10（机主 2026-11-13 已签）：合法 JSON ≠ 账行。
      //   缺账行必备字段（code 形状不符 / 无 ts）的行必须计入 badLines 并置 ok=false，
      //   否则"读不到"会被算成"读到了"，对账与报告会静默少算（假绿）。
      if (strictRows && !parseErr && !isLedgerRow(parsed)) {
        parseErr = new Error('non-ledger-json: 合法 JSON 但缺账行必备字段（code/ts）');
      }
      try {
        if (parseErr) throw parseErr;
        out.records.push(parsed);
      } catch (e) {
        out.badLines++;
        out.ok = false;
        if (out.badLineDetails.length < maxDetails) {
          const rawBytes = Buffer.byteLength(line, 'utf8');
          const raw = line.length > 4096 ? line.slice(0, 4096) : line;
          const lineSha = crypto.createHash('sha256').update(line, 'utf8').digest('hex');
          out.badLineDetails.push({
            file: n,
            lineNo: i + 1,
            offset: lineOffset,
            bytes: rawBytes,
            sha256: lineSha,
            raw,
            truncated: line.length > raw.length,
          });
          // ★ CH-04（契约）：坏行也必须进 `readErrors[]`，字段名按契约
          //   `{file,line,rawSha256,offset,error}` —— 否则"读坏了"只有内部明细、没有对外错误面。
          //   与 IO 错误靠 `code` 区分（坏行 code='E_BAD_LINE'）。
          out.readErrors.push({
            file: n,
            line: i + 1,
            rawSha256: lineSha,
            offset: lineOffset,
            error: String((e && e.message) || e).slice(0, 300),
            code: 'E_BAD_LINE',
          });
        } else {
          out.badLineDetailsTruncated++;
          out.readErrors.push({
            file: n,
            line: i + 1,
            rawSha256: '',
            offset: lineOffset,
            error: 'bad line（明细已达上限，未留存原文）',
            code: 'E_BAD_LINE_TRUNCATED',
          });
        }
      }
      lineOffset += Buffer.byteLength(line, 'utf8') + 1;
    }
  }

  // 坏行取证：默认不写（读函数默认零副作用）；只有显式 quarantine 才落盘
  if (opts.quarantine === true && out.badLineDetails.length > 0) {
    try {
      out.quarantined = quarantineBadLines(root, {
        details: out.badLineDetails,
        nowMs: opts.nowMs,
        offsetMinutes: opts.offsetMinutes,
      });
      // 取证冲突/写失败都意味着"坏行证据不完整"→ ok 必须为 false（同一原则：失败不得被当成功）
      if (out.quarantined.ok !== true) {
        out.ok = false;
        out.readErrors.push({
          file: quarantinePath(root),
          code: out.quarantined.conflicts && out.quarantined.conflicts.length
            ? 'E_QUARANTINE_CONFLICT' : 'E_QUARANTINE_WRITE',
          message: JSON.stringify((out.quarantined.conflicts || []).slice(0, 5)),
        });
      }
    } catch (e) {
      out.ok = false;
      out.readErrors.push({
        file: quarantinePath(root),
        code: 'E_QUARANTINE_WRITE',
        message: e && e.message ? e.message : String(e),
      });
    }
  }

  // 空数据只能由"成功读取"证明：只有 ok=true 且确实没有任何记录，才是可用的"空"
  out.emptyProven = out.ok === true && out.records.length === 0;
  return out;
}

/**
 * 坏行取证**目录**：`<root>/ledger/.quarantine/`（一层平铺，每坏行一份 JSON）。
 *
 * @why 为什么是"目录 + 每行一份 JSON"（契约 D9/P1-2 定稿口径）：
 *      ① 证据要能单独打开/单独引用（`<账文件>.L<行号>.json`），不是堆在一个大 jsonl 里；
 *      ② 每份文件排他创建，天然"不可覆盖"：同一行号内容若变了，说明账本被改过，
 *         必须报冲突而不是悄悄覆盖旧证据；
 *      ③ 目录名以 '.' 开头（隐藏）、readAll 只读 `*.jsonl`，不会被当账。
 */
export function quarantinePath(root) {
  return path.join(ledgerDir(root), '.quarantine');
}

/**
 * 读坏行取证目录（只读）。
 * @returns {{path:string, records:object[], badLines:number, errors:Array<object>}}
 */
export function readQuarantine(root) {
  const dir = quarantinePath(root);
  const out = { path: dir, records: [], badLines: 0, errors: [] };
  if (!fs.existsSync(dir)) return out;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    out.errors.push({ file: dir, code: 'E_READDIR', message: e && e.message ? e.message : String(e) });
    return out;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      out.records.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      out.badLines++;
      out.errors.push({ file: p, code: 'E_READ', message: e && e.message ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * 把 `readAll()` 检出的坏行**取证**到 `.quarantine/`（排他创建 + fsync；幂等；台账字节不动）。
 *
 * @param {string} root
 * @param {{details:Array<object>, nowMs?:number, offsetMinutes?:number}} p
 * @returns {{ok:boolean, path:string, appended:number, skipped:number,
 *            conflicts:Array<object>, errors:Array<object>, reason?:string}}
 *
 * @why 为什么不改台账文件：改一行 = 重写已有字节 = 破坏"只追加"这条账的底线；
 *      取证的目的是"坏行有据、能复核、能修"，不是"把账修漂亮"。
 * @why 为什么冲突不覆盖：同一 `账文件.L行号` 两次取证内容不同，说明账本在两次读取之间
 *      被改过（或行号错位）—— 旧证据可能正是判断"谁改的"的唯一线索，覆盖等于毁证。
 */
export function quarantineBadLines(root, p = {}) {
  const details = Array.isArray(p.details) ? p.details : [];
  const offsetMinutes = Number.isFinite(p.offsetMinutes) ? p.offsetMinutes : 480;
  const now = Number.isFinite(p.nowMs) ? p.nowMs : Date.now();
  const dir = quarantinePath(root);
  const at = stampLocal(now, offsetMinutes);
  const out = { ok: true, path: dir, appended: 0, skipped: 0, conflicts: [], errors: [] };
  if (details.length === 0) return { ...out, reason: 'no-details' };

  for (const d of details) {
    const name = `${d.file}.L${d.lineNo}.json`;
    const target = path.join(dir, name);
    const entry = {
      v: 1,
      at,
      ledgerFile: d.file,
      lineNo: d.lineNo,
      offset: Number.isInteger(d.offset) ? d.offset : null,
      bytes: d.bytes,
      sha256: d.sha256,
      raw: d.raw,
      truncated: !!d.truncated,
      reason: 'bad-json-line',
    };
    let fd;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fd = fs.openSync(target, 'wx'); // 排他创建：证据不可覆盖
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          try {
            const old = JSON.parse(fs.readFileSync(target, 'utf8'));
            if (old && old.sha256 === d.sha256) { out.skipped++; continue; }
          } catch { /* 旧证据本身读不出来：按冲突报，不覆盖 */ }
          out.conflicts.push({ file: name, reason: 'content-changed' });
          continue;
        }
        throw e;
      }
      fs.writeSync(fd, JSON.stringify(entry) + '\n', null, 'utf8');
      fs.fsyncSync(fd);
      out.appended++;
    } catch (e) {
      out.errors.push({ file: target, code: 'E_WRITE', message: e && e.message ? e.message : String(e) });
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }
  out.ok = out.errors.length === 0 && out.conflicts.length === 0;
  return out;
}

// ============================================================================
// 三·四、崩溃撕裂尾巴（torn tail）的**严格限定**自愈
//
// @why 为什么需要它：kill -9 / 断电落在 `appendLineSync` 的 write 中途时，台账末行是
//      **半行 JSON 且文件没有结尾换行**。下一轮 `readAll()` 报坏行 → `ok=false` →
//      index.js 按 P1-8 早退（"读不全就别写"）→ **永久卡死**，与"重启可续跑"的承诺矛盾。
//      这是产品缺陷（不是测试问题）：一条写到一半的账尾不该让整本账再也写不进去。
//
// @why 为什么修台账尾是安全的、而修其它坏行是禁忌：
//      ① 撕裂尾巴按构造**不包含任何完整记录**：半行 JSON 不可能被解析成一条账，
//         截掉它不丢失任何"已成立"的记录（那条记录本来就没写成功，下一轮会重写）；
//      ② 它有唯一可判定的现场特征（末行、无结尾换行、只有这一处坏行），
//         中间行坏/多行坏/末行有换行 → 不是撕裂尾巴，可能是篡改/磁盘故障 —— **一律不修**；
//      ③ 修之前先**取证**（`.quarantine/<账文件>.L<行号>.torn.json`，排他创建、不可覆盖），
//         修之后在 `readAll().tornTailRepaired[]` 里如实返回，绝不静默。
//
// 三条硬条件（**缺一不修**，改动这里等于放宽"账本不可篡改"的红线）：
//   ① 坏行是**最后一行**（末行 JSON 解析失败）；
//   ② 文件**不以 `\n` 结尾**（有结尾换行 = 完整行坏，属坏行，不修）；
//   ③ 该文件里**只有这一处坏行**（前面所有非空行都必须能解析）。
// ============================================================================

/** 撕裂尾巴取证的固定后缀（与普通坏行 `.json` 区分，便于审计一眼识别）。 */
const TORN_TAIL_EVIDENCE_SUFFIX = '.torn.json';

/**
 * 判定并（在三条硬条件全满足时）修复"崩溃撕裂尾巴"。
 *
 * @param {{root:string, fileName:string, filePath:string, text:string,
 *          nowMs?:number, offsetMinutes?:number}} p
 * @returns {{file:string, line:number, bytes:number, sha256:string, at:string,
 *            offset:number, evidence:string}|null} 修好返回留痕记录；不满足条件/修不了返回 null
 *
 * @throws 不抛错：任何一步失败都返回 null（调用方按"没修"处理 → ok 仍为 false，绝不假装修好）
 */
function detectAndRepairTornTail({ root, fileName, filePath, text, nowMs, offsetMinutes }) {
  // 条件②：文件必须以"非换行"结尾；空文件或正常结尾的文件直接放过。
  if (typeof text !== 'string' || text.length === 0 || text.endsWith('\n')) return null;
  const lines = text.split('\n');
  const tail = lines[lines.length - 1];
  if (!tail.trim()) return null;
  // 条件①：坏行必须就是最后一行（末行解析必须失败；能解析说明只是缺结尾换行，不算撕裂）。
  try { JSON.parse(tail); return null; } catch { /* 末行坏了：继续核条件③ */ }
  // 条件③：该文件里只有这一处坏行 —— 前面所有非空行都必须可解析。
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch { return null; }
  }

  const tailNo = lines.length; // 行号（1 起）
  const prefix = text.slice(0, text.length - tail.length); // 含上一行的 '\n'（或空串）
  const tailOffset = Buffer.byteLength(prefix, 'utf8');
  const tailBuf = Buffer.from(tail, 'utf8');
  const tailSha256 = crypto.createHash('sha256').update(tailBuf).digest('hex');
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const at = stampLocal(Number.isFinite(nowMs) ? nowMs : Date.now(), offset);

  // ① 先取证（排他创建，证据不可覆盖；内容不同 = 账本被改过 → 不修）
  const qDir = quarantinePath(root);
  const evName = `${fileName}.L${tailNo}${TORN_TAIL_EVIDENCE_SUFFIX}`;
  const evPath = path.join(qDir, evName);
  const entry = {
    v: 1,
    kind: 'torn-tail',
    at,
    ledgerFile: fileName,
    lineNo: tailNo,
    offset: tailOffset,
    bytes: tailBuf.length,
    sha256: tailSha256,
    raw: tail.length > 4096 ? tail.slice(0, 4096) : tail,
    truncated: tail.length > 4096,
    reason: 'crash-torn-tail',
  };
  let fd = -1;
  try {
    fs.mkdirSync(qDir, { recursive: true });
    fd = fs.openSync(evPath, 'wx');
    fs.writeSync(fd, JSON.stringify(entry) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 旧证据还在：同 sha 视为幂等重试（上次取证后可能没来得及截断），异 sha 拒绝修。
      try {
        const old = JSON.parse(fs.readFileSync(evPath, 'utf8'));
        if (!old || old.sha256 !== tailSha256) return null;
      } catch { return null; }
    } else {
      return null; // 取证失败 → 不许修（修了就没证据，等于静默改账）
    }
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  // ② 截断到该行起点；截断后文件以 '\n' 结尾（或为空），后续重读按正常路径。
  // ★ A-07（机主 2026-11-13 已签）：fsync 失败**不许吞**。
  //   fsync 证明的是"落得盘"，不是"读得到"；失败时仍保留本次修复（截断已在页缓存生效），
  //   但标注 durability='unknown' 并带 fsyncError 上报，由调用方决定告警/重试 ——
  //   绝不让"可能没落盘"看起来像"修好了"。
  let durability = 'ok';
  let fsyncError = null;
  try {
    const cfd = fs.openSync(filePath, 'r+');
    try {
      fs.ftruncateSync(cfd, tailOffset);
      try {
        fs.fsyncSync(cfd);
      } catch (e) {
        durability = 'unknown';
        fsyncError = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e));
      }
    } finally {
      try { fs.closeSync(cfd); } catch { /* ignore */ }
    }
  } catch { return null; } // 截断失败 → 当作未修（台账未动；绝不上报"修好了"）

  return {
    file: fileName,
    line: tailNo,
    bytes: tailBuf.length,
    sha256: tailSha256,
    at,
    offset: tailOffset,
    evidence: path.join(path.basename(qDir), evName),
    durability,
    ...(fsyncError ? { fsyncError } : {}),
  };
}

/**
 * 毫秒 → `YYYY-MM-DD HH:MM:SS`（+08:00 口径；契约文本时间格式，**禁 Z**）。
 *
 * @why 运行区证据（`.errors.jsonl`/`.quarantine/`）的 `at` 用契约文本格式，
 *      与台账里的 ISO（带 T 与偏移）刻意不同：台账给人读的是"某一刻"，
 *      证据给人比对的是"契约字段"，两种格式混用会让正则判定漂移。
 */
export function stampLocal(ms, offsetMinutes = 480) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const t = Number.isFinite(ms) ? ms : Date.now();
  const d = new Date(t + off * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// ============================================================================
// 三·五、错误清单 `.errors.jsonl`（契约 D9：失败必须"被看见"）
// ============================================================================

/** 错误清单路径：`<root>/ledger/.errors.jsonl`（隐藏名，readAll 不当账读）。 */
export function errorsPath(root) {
  return path.join(ledgerDir(root), '.errors.jsonl');
}

// ── 错误尝试计数（R-02 / INV-30）─────────────────────────────────────────────
/**
 * 错误**尝试次数**的落盘位置：`<root>/ledger/.error-attempts.json`（运行区）。
 *
 * @why 为什么必须有它：错误清单按 `(kind,source,offset)` 每 `ERROR_LOG_THROTTLE_MS`
 *      最多留 1 行，24 小时里发生 100 次同类失败，清单上只会看到 ~25 行。
 *      而契约 R-02 要求运行报告里 `errors[].count` **累加真实次数** ——
 *      真实次数不落盘，就永远只能是"清单行数"，那就不是"事实可溯源"。
 *      所以这里单独记一份计数（不是账、不是证据，属运行区，丢了只影响计数精度）。
 */
export function errorAttemptsPath(root) {
  return path.join(ledgerDir(root), '.error-attempts.json');
}

/** 读尝试计数（只读，坏文件当空）。 */
export function readErrorAttempts(root) {
  const p = errorAttemptsPath(root);
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** 记一次尝试（无论最终是写清单、去重还是被节流）。失败不影响主流程。 */
function bumpErrorAttempt(root, { kind, source, offset, at }) {
  const p = errorAttemptsPath(root);
  const map = readErrorAttempts(root);
  const key = `${kind}|${source}|${offset}`;
  const cur = map[key] && typeof map[key] === 'object'
    ? map[key]
    : { kind, source, offset, attempts: 0, firstAt: '', lastAt: '' };
  cur.attempts = (Number(cur.attempts) || 0) + 1;
  if (!cur.firstAt) cur.firstAt = at;
  cur.lastAt = at;
  map[key] = cur;
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* 计数失败不能阻断落账 */ }
  return cur;
}

/** D9 允许的错误种类（超出即拒收：错误清单是契约字段，不许自造）。 */
export const ERROR_KINDS = Object.freeze([
  'SID_UNENCODABLE', 'HEAD_MISSING', 'CODE_FAILED', 'ORIGINAL_CONFLICT',
  'ATTACHMENT_CONFLICT', 'FRAME_FAILED', 'APPEND_FAILED',
]);

/** 错误清单的契约级节流窗口（契约 R-02：默认 1 小时，同一 (kind,source,offset) 每窗最多 1 行）。 */
export const ERROR_LOG_THROTTLE_MS = 60 * 60 * 1000;

/**
 * 解析 `YYYY-MM-DD HH:MM:SS`（+08:00 口径）→ 毫秒。
 * @param {string} at
 * @param {number} [offsetMinutes=480]
 * @returns {number} NaN = 非法
 *
 * @why 错误清单的 `at` 是契约文本时间（无 T、无偏移后缀），节流窗口必须能把它精确还原成
 *      绝对时刻；配一段时区偏移算术比 Date.parse 的本地时区行为更稳定（宿主时区不可信）。
 */
export function parseLocalStamp(at, offsetMinutes = 480) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(at || ''));
  if (!m) return NaN;
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
}

/**
 * 读错误清单（只读）。
 * @returns {{path:string, records:object[], badLines:number, readError:string,
 *            byFingerprint:Object<string,object>}}
 */
export function readErrors(root) {
  const p = errorsPath(root);
  const out = { path: p, records: [], badLines: 0, readError: '', byFingerprint: {} };
  let txt;
  try {
    txt = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    out.readError = e && e.message ? e.message : String(e);
    return out;
  }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { out.badLines++; continue; }
    out.records.push(rec);
    if (rec && typeof rec.fingerprint === 'string' && rec.fingerprint) {
      out.byFingerprint[rec.fingerprint] = rec;
    }
  }
  return out;
}

/**
 * 追加一条结构化错误（契约 D9 + R-02 节流）。
 *
 * @param {string} root
 * @param {{kind:string, source:string, sourceBytes?:number, sourceMtimeMs?:number,
 *          offset?:number, detail?:string, retryable?:boolean}} event
 * @param {{nowMs?:number, offsetMinutes?:number, errorLogThrottleMs?:number}} [opts]
 * @returns {{ok:boolean, recorded:boolean, duplicate:boolean, throttled:boolean,
 *            path:string, record?:object, lastAt?:string, reason?:string}}
 *
 * @why 字段固定为 D9 的九个：`{v,at,kind,source,sourceBytes,sourceMtimeMs,offset,detail,
 *      retryable,fingerprint}`；`fingerprint=sha256("<kind>|<source>|<bytes>|<mtime>|<offset>")`。
 * @why 两道去重（契约 R-02 原文）：
 *      ① 同一 fingerprint（=同一现场、字节数/修改时间都没变）→ 幂等，不写第二行；
 *      ② 节流：键 `(kind,source,offset)`，窗口 `errorLogThrottleMs`（默认 1h），
 *         窗口内最多 1 行 —— 否则一个持续增长/持续坏的源会 60s 一行把清单写爆。
 *         窗口内的重复**不静默丢次数**：返回 `throttled:true` 与原记录，
 *         调用方在运行报告 `errors[].count` / `blockedSources[].attempts` 里累加。
 * @why 写入失败必须返回 ok:false：错误清单写不进去 = 失败没有被看见，这本身就是故障。
 */
export function appendErrorEvent(root, event, opts = {}) {
  const p = errorsPath(root);
  const kind = event && typeof event.kind === 'string' ? event.kind : '';
  if (!ERROR_KINDS.includes(kind)) {
    return { ok: false, recorded: false, duplicate: false, throttled: false, path: p, reason: 'bad kind' };
  }
  const source = event && typeof event.source === 'string' ? event.source : '';
  if (!source) return { ok: false, recorded: false, duplicate: false, throttled: false, path: p, reason: 'missing source' };
  const offsetMinutes = Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480;
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const throttleMs = Number.isFinite(opts.errorLogThrottleMs) && opts.errorLogThrottleMs >= 0
    ? opts.errorLogThrottleMs : ERROR_LOG_THROTTLE_MS;
  const sourceBytes = Number.isFinite(event.sourceBytes) ? Math.trunc(event.sourceBytes) : 0;
  const sourceMtimeMs = Number.isFinite(event.sourceMtimeMs) ? Math.trunc(event.sourceMtimeMs) : 0;
  const offset = Number.isFinite(event.offset) ? Math.trunc(event.offset) : 0;
  const fingerprint = crypto.createHash('sha256')
    .update(`${kind}|${source}|${sourceBytes}|${sourceMtimeMs}|${offset}`, 'utf8')
    .digest('hex');

  // ★ R-02：每次调用都记一次"尝试"，包括后面被判重复或节流的那些 ——
  //   否则真实次数只能靠清单行数，节流一压就失真（INV-30 的 count 累加就靠这份计数）。
  const attemptAt = stampLocal(now, offsetMinutes);
  bumpErrorAttempt(root, { kind, source, offset, at: attemptAt });

  const prev = readErrors(root);
  if (prev.readError) {
    return { ok: false, recorded: false, duplicate: false, throttled: false, path: p, reason: 'errors-unreadable' };
  }
  if (prev.byFingerprint[fingerprint]) {
    return {
      ok: true, recorded: false, duplicate: true, throttled: false, path: p,
      record: prev.byFingerprint[fingerprint], lastAt: prev.byFingerprint[fingerprint].at || '',
    };
  }
  // R-02 节流：同一 (kind,source,offset) 在窗口内只允许 1 行（按最后一条的 at 算，不回写历史）
  let lastByThrottleKey = null;
  for (const rec of prev.records) {
    if (!rec || rec.kind !== kind || rec.source !== source) continue;
    const recOffset = Number.isFinite(rec.offset) ? Math.trunc(rec.offset) : 0;
    if (recOffset !== offset) continue;
    if (!lastByThrottleKey) lastByThrottleKey = rec;
    else {
      const a = parseLocalStamp(lastByThrottleKey.at, offsetMinutes);
      const b = parseLocalStamp(rec.at, offsetMinutes);
      if (Number.isFinite(b) && (!Number.isFinite(a) || b > a)) lastByThrottleKey = rec;
    }
  }
  if (lastByThrottleKey && throttleMs > 0) {
    const lastMs = parseLocalStamp(lastByThrottleKey.at, offsetMinutes);
    if (Number.isFinite(lastMs) && now - lastMs < throttleMs) {
      return {
        ok: true, recorded: false, duplicate: false, throttled: true, path: p,
        record: lastByThrottleKey, lastAt: lastByThrottleKey.at || '',
      };
    }
  }
  const record = {
    v: 1,
    at: stampLocal(now, offsetMinutes),
    kind,
    source,
    sourceBytes,
    sourceMtimeMs,
    offset,
    detail: typeof event.detail === 'string' ? event.detail.slice(0, 2000) : '',
    retryable: event.retryable === false ? false : true,
    fingerprint,
  };
  try {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    appendLineSync(p, JSON.stringify(record));
  } catch (e) {
    return { ok: false, recorded: false, duplicate: false, throttled: false, path: p, reason: e && e.message ? e.message : String(e) };
  }
  return { ok: true, recorded: true, duplicate: false, throttled: false, path: p, record };
}

/**
 * 判断某个编码是否已经在台账里。
 *
 * @param {string} root
 * @param {string} code 32 位编码
 * @returns {boolean}
 */
export function hasCode(root, code) {
  const { records } = readAll(root);
  return records.some((r) => r && r.code === code);
}

/**
 * 追加一行到 jsonl 文件：**先补尾行换行、再写、最后 fsync**。
 *
 * @param {string} file 目标文件（父目录必须已存在）
 * @param {string} line 一行文本（**不含**结尾换行；本函数负责换行）
 * @returns {{padded:boolean, bytes:number}}
 *
 * @why 为什么不能直接 appendFileSync：
 *      ① 上一行若因崩溃/外部写入缺了结尾换行，直接 append 会把两条帐粘成一条
 *         坏 JSON —— 一次粘住，后面整本账都读不全（实测过的真实事故）；
 *         所以先 fstat + 读最后一字节，不是 '\n' 就先补一个。
 *      ② appendFileSync 写完就返回，数据只在页缓存里；断电/强制关机后
 *         这一行可能没了，而调用方/log 已经宣布"已入账"。所以必须 fsync。
 *
 * @why 用 `a+` 打开而不是先读后写两套 fd：
 *      尾字节检查与追加在同一个 fd 上完成，中间不会有人把文件换掉；
 *      O_APPEND 保证写入一定落在文件尾（不会覆盖任何已有字节）。
 */
function appendLineSync(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let data = String(line);
    // 本函数契约：入参是一行**内容**；结尾换行由这里补（调用方漏传也不会粘行）。
    if (!data.endsWith('\n')) data += '\n';
    let padded = false;
    if (size > 0) {
      const tail = Buffer.allocUnsafe(1);
      const n = fs.readSync(fd, tail, 0, 1, size - 1);
      if (n === 1 && tail[0] !== 0x0a) {
        data = '\n' + data; // 上一行缺结尾换行：先补上，否则两行粘成一条坏 JSON
        padded = true;
      }
    }
    fs.writeSync(fd, data, null, 'utf8');
    fs.fsyncSync(fd);
    return { padded, bytes: Buffer.byteLength(data, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * ★ K-13：appendTurn 的**写前健康探针** —— "读不出来"不等于"没有"，写之前必须能证明。
 *
 * @param {string} root
 * @param {string|null} dayFile 目标日文件（null = 只查库目录）
 * @returns {{ok:boolean, code?:string, file?:string, statCode?:string, message?:string,
 *            firstOpen?:boolean, newFile?:boolean}}
 *
 * @why 只做**成本 O(1)** 的 stat/access，不重读整本台账（knownCodes 优化的意义不能丢）：
 *      ① 库目录 stat 失败（EACCES/EMFILE/EBUSY/EIO…）→ 连"这一天有哪些账"都不知道，拒写；
 *      ② 目录不是目录 → 拒写；
 *      ③ 目标日文件 access(R_OK|W_OK) 失败（非 ENOENT）→ 追加目标本身不可信，拒写。
 *      这三种情况都**无法证明 code 不存在**，继续写就可能重复入账（永久主键撞车）。
 *      探针只读不写：拒写路径保证账文件一个字节都不变。
 */
function probeLedgerWritable(root, dayFile) {
  const dir = ledgerDir(root);
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, firstOpen: true };
    return {
      ok: false, code: 'E_STAT', file: dir,
      statCode: String((e && e.code) || ''), message: String((e && e.message) || e),
    };
  }
  if (!st.isDirectory()) {
    return { ok: false, code: 'E_NOT_DIR', file: dir, statCode: 'ENOTDIR', message: 'ledger 路径不是目录' };
  }
  if (!dayFile) return { ok: true };
  try {
    fs.accessSync(dayFile, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, newFile: true };
    return {
      ok: false, code: 'E_STAT', file: dayFile,
      statCode: String((e && e.code) || ''), message: String((e && e.message) || e),
    };
  }
}

/** 把写前探针的失败翻译成 appendTurn 的稳定返回（reason 固定 'ledger-unreadable'）。 */
function unreadableAppendResult(code, probe) {
  return {
    ok: false, skipped: false, code: typeof code === 'string' ? code : '', path: '',
    reason: 'ledger-unreadable',
    error: {
      code: (probe && probe.code) || 'E_STAT',
      file: (probe && probe.file) || '',
      statCode: (probe && probe.statCode) || '',
      message: (probe && probe.message) || '',
    },
  };
}

/**
 * 追加一条记录到台账。**幂等**：code 已存在则跳过。
 *
 * @param {string} root 数据总库根目录
 * @param {object} record 至少含 { code, ts }
 * @param {Set<string>|undefined} knownCodes
 *        调用方已经读到的"已入账编码集合"。传入它时本函数不再重读整本台账。
 *        不传则退化为 hasCode(root, code)（行为一致，只是慢）。
 * @returns {{ok:boolean, skipped:boolean, code:string, path:string, reason?:string,
 *            error?:{code:string, file:string, statCode:string, message:string}}}
 *
 * @why 幂等的实现是"先查再写"，而不是"靠文件系统报错"。
 *      因为 jsonl 没有唯一约束，重复行不会报错，只会悄悄多一行 ——
 *      而"悄悄多一行"正是账最不能容忍的事。
 *
 * @why 写入方式用"追加 + fsync"而不是"读全量再重写"：
 *      前者不会动已有字节（append-only 可审计），后者在崩溃时会丢掉整个文件。
 *      追加前补尾行换行、追加后 fsync，两个动作都在 appendLineSync 里（见其 @why）。
 *
 * @why 增加 knownCodes 参数（2026-11-08 修）：
 *      原实现每写一条都 hasCode → readAll，把整个台账重读一遍。
 *      1315 轮时约 86 万次 JSON.parse，属实没必要。
 *      传入集合后语义不变（同一进程内串行写，没有并发插入），
 *      但"查重"这件事从此只在一处发生（runOnce 开头读一次）。
 *
 * @why ★ K-13（审计② A1）：knownCodes 路径**不能免掉健康探针**。
 *      审计实测：readAll 在 stat EACCES 时曾返回"空库已证明"，调用方拿到空 knownCodes 后
 *      appendTurn 直接写 → 与磁盘上已存在的 code 重复。现在写前先 probeLedgerWritable：
 *      目录/日文件不可 stat/access（非 ENOENT）→ reason='ledger-unreadable' 拒写，零字节变化。
 *      不传 knownCodes 时仍走 readAll（它已把 stat 失败结构化），同样拒写。
 */
export function appendTurn(root, record, knownCodes) {
  if (!record || typeof record.code !== 'string' || !record.code) {
    return { ok: false, skipped: false, code: '', path: '', reason: 'missing code' };
  }

  // ★ K-13 探针①：库目录连 stat 都失败 / 不是目录 → 无法证明 code 不存在，拒写。
  const dirProbe = probeLedgerWritable(root, null);
  if (!dirProbe.ok) return unreadableAppendResult(record.code, dirProbe);

  // 幂等闸门
  //
  // ★ P1-8：不传 knownCodes 时只能靠读盘证明"code 不存在"。
  //   读不全（readErrors / 坏行 / 目录不可读）时**无法证明不存在** → 拒绝写。
  //   否则"账里已有这条、但这次没读到"会被当成没有 → 重复入账（永久主键撞车）。
  //   调用方（runOnce）应当已经用 readAll().ok 把整轮写盘挡住；这里再兜一层。
  let already = false;
  if (knownCodes instanceof Set) {
    already = knownCodes.has(record.code);
  } else {
    const all = readAll(root);
    if (!all.ok) {
      const why = (all.readErrors && all.readErrors[0]) || all.statError || null;
      return unreadableAppendResult(record.code, why);
    }
    already = all.records.some((r) => r && r.code === record.code);
  }
  if (already) {
    return {
      ok: true,
      skipped: true,
      code: record.code,
      path: '',
      reason: 'already exists',
    };
  }

  // 从 ts 里取出日期部分决定落哪个文件
  const ts = typeof record.ts === 'string' ? record.ts : '';
  const dateISO = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return { ok: false, skipped: false, code: record.code, path: '', reason: 'bad ts' };
  }

  const p = ledgerPath(root, dateISO);
  // ★ K-13 探针②：目标日文件不可读/不可写（非 ENOENT）→ 拒写，零字节变化。
  const dayProbe = probeLedgerWritable(root, p);
  if (!dayProbe.ok) return unreadableAppendResult(record.code, dayProbe);

  const dir = ledgerDir(root);
  fs.mkdirSync(dir, { recursive: true });

  // 一行一条；末尾必须有换行，否则下次追加会和这行粘在一起。
  // appendLineSync 会先补尾行换行，再 write + fsync（见其 @why）。
  //
  // ★ P1-2：write/fsync 失败必须**显式返回失败**，不能抛穿整个 runOnce ——
  //   调用方据此"stat.written 不增 + 游标回退"（契约要求），而一份未 fsync 的记录
  //   在法律意义上等于"没入账"，不能算成功。
  try {
    appendLineSync(p, JSON.stringify(record));
  } catch (e) {
    return {
      ok: false, skipped: false, code: record.code, path: p,
      reason: 'append-failed: ' + (e && e.message ? e.message : String(e)),
    };
  }

  return { ok: true, skipped: false, code: record.code, path: p };
}

// ============================================================================
// 三·五、缺口留痕（B4）—— 坏帧/半截帧的字节缺口必须可复算地留痕
// ============================================================================
// ★ K-4：原来的 scanMagicOffsets（扫魔数取"所有帧起点"）已删除 ——
//   分帧改由 lib/frames.js 的帧头 + 块结构计算（frameSpan），留痕里的 frameOffsets
//   与 failedFrameOffsets 都来自结构分帧结果；"载荷里的假魔数"不再污染缺口证据。

/**
 * 对文件的一段字节区间做流式 sha256（缺口证据的"可复算"凭据）。
 *
 * @param {string} filePath
 * @param {number} start 含
 * @param {number} end 不含
 * @returns {string} 64 位小写 hex
 */
function hashByteRange(filePath, start, end) {
  const h = crypto.createHash('sha256');
  if (!(end > start)) return h.digest('hex');
  const fd = fs.openSync(filePath, 'r');
  try {
    const CHUNK = 1024 * 1024;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - start));
    let pos = start;
    while (pos < end) {
      const want = Math.min(buf.length, end - pos);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      if (got === 0) break;
      h.update(buf.subarray(0, got));
      pos += got;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 读回所有缺口留痕（给对账器/体检用）。 */
export function readLost(root) {
  const p = lostPath(root);
  const out = { path: p, records: [], badLines: 0 };
  if (!fs.existsSync(p)) return out;
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.records.push(JSON.parse(line));
    } catch {
      out.badLines++;
    }
  }
  return out;
}

/**
 * 只读 `.lost.jsonl` 的最后一条记录（省 IO：正常路径不该整份重读）。
 *
 * @param {string} p
 * @returns {object|null}
 *
 * @why 缺口可能反复出现（坏帧一直坏，每轮扫描都会看到），每轮都 `readLost`
 *      整份解析会让留痕文件本身变成新的性能负担。先读文件尾一小段；
 *      万一最后一行比块还长（超大帧列表），回退整份读。
 */
function readLastLostRecord(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const readTail = (chunk) => {
      const want = Math.min(chunk, size);
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, size - want + got);
        if (n <= 0) break;
        got += n;
      }
      return buf.subarray(0, got).toString('utf8');
    };
    for (const chunk of [256 * 1024, 4 * 1024 * 1024]) {
      const txt = readTail(chunk);
      const lines = txt.split('\n');
      // 块首可能截断半行 → 只在块覆盖文件头或首行完整时才信最后一行
      const complete = chunk >= size;
      const candidates = lines.filter((l) => l.trim());
      if (!candidates.length) continue;
      try {
        return JSON.parse(candidates[candidates.length - 1]);
      } catch {
        if (complete) return null; // 真坏了：交给上层当"没有上一条"
      }
    }
    // 超大行兜底：整份读（只在这一种极罕见情况下发生）
    const all = readLostLastLineFallback(p);
    return all;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** 兜底：整份读 .lost.jsonl 取最后一行（仅在 readLastLostRecord 的块读失败时用）。 */
function readLostLastLineFallback(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch {
    return null;
  }
}

/** 判断两条缺口记录是不是"同一现场"（用于防重复追加，见 lostTurns 的 @why）。 */
function sameLoss(a, b) {
  // ★ K-4：不再比较 fromByte。坏帧的"现场"是**文件 + 缺口字节区间 + 失败帧数**，
  //   而 fromByte 会随游标重试点变化（第一轮 fromByte=0，之后是坏帧之前的已提交前缀）。
  //   同一个坏帧不能因为"这次从更靠后的已提交前缀开始读"就记成两条 —— missing 区间
  //   相同即同一现场；区间/计数/扫描大小任一变化才算新现场。
  return !!a && !!b &&
    a.file === b.file &&
    a.scanSize === b.scanSize &&
    a.failedFrames === b.failedFrames &&
    a.badLines === b.badLines &&
    JSON.stringify((a.missing || []).map((m) => [m.start, m.end])) ===
      JSON.stringify((b.missing || []).map((m) => [m.start, m.end]));
}

/**
 * 把一个读会话时发现的**缺口**写进 `<root>/ledger/.lost.jsonl`（只追加、可复算）。
 *
 * 触发条件（任一）：
 *   · `result.meta.failed > 0`      —— 有帧解不开（坏帧 / 半截帧 / 超大帧跳过）
 *   · `result.formatError` 以 `bad-magic` 开头 —— 读起点不在帧边界（文件被截断/改写）
 *   · `result.meta.badLines > 0`    —— 解压成功但 JSON 行坏了（内容级缺口）
 *
 * 留痕内容包含：会话、`[fromByte,size)` 内所有帧起点、解不开的帧起点、
 * **缺失字节区间**（含每段 sha256，可独立重算复核）、发生时间（+08:00）。
 *
 * @param {string} root 数据总库根目录
 * @param {object} info
 * @param {string} info.file 会话文件绝对路径
 * @param {object} info.result `readTurnsFrom` 的返回值
 * @param {string} [info.sid] 完整会话 id（拿不到时留空，靠 sessDir/file 定位）
 * @param {string} [info.sessDir] 会话目录名（默认从 file 的父目录名推）
 * @param {number} [info.offsetMinutes] 时区偏移，默认 480
 * @param {number} [info.now] 发生时刻（毫秒），默认当前时间（自测可注入）
 * @returns {{ok:boolean, recorded:boolean, path?:string, record?:object, reason?:string}}
 *
 * @throws {Error} 留痕文件写不进去（磁盘满/权限）—— 这是故障，必须让调用方报出来。
 *
 * @why 为什么"没缺口"直接返回而不是每次先扫一遍：
 *      本函数会被 index.js 对每个会话调用（或至少在出错分支调用），
 *      干净的会话必须 O(1) 返回；只有真的出现 failed/badMagic/badLines 才做
 *      第二遍代价较高的帧边界扫描。
 *
 * @why 为什么重复的同一现场不重复追加：
 *      坏帧会**一直坏**，下一轮扫描（60s 后）还会看到同样的缺口；
 *      若无脑追加，`.lost.jsonl` 会以每会话每分钟一行的速度膨胀，
 *      反而把"真的新缺口"淹没。所以同一 `file+fromByte+scanSize+missing` 的
 *      现场只记第一次；文件又长了/缺口变了，才会新增一条。
 *      这仍满足"只追加"：已写出去的记录永不改写。
 */
export function lostTurns(root, info = {}) {
  const file = info && typeof info.file === 'string' ? info.file : '';
  const result = (info && info.result) || {};
  const meta = result.meta || {};
  const offsetMinutes = Number.isFinite(info.offsetMinutes) ? info.offsetMinutes : 480;
  const now = Number.isFinite(info.now) ? info.now : Date.now();

  if (!file) return { ok: false, recorded: false, reason: 'missing file' };

  const failedFrames = Number(meta.failed) || 0;
  const badLines = Number(meta.badLines) || 0;
  const formatError = String(result.formatError || '');
  const badMagic = formatError.startsWith('bad-magic');

  // 干净的读取：什么都不记（这是绝大多数情况，必须零成本）
  if (failedFrames === 0 && badLines === 0 && !badMagic) {
    return { ok: true, recorded: false, reason: 'no-loss' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, recorded: false, reason: 'file-gone' };
  }

  const fromByte = Number.isInteger(meta.fromByte) && meta.fromByte > 0 ? meta.fromByte : 0;
  const scanSize = Number.isInteger(meta.size) && meta.size >= 0 ? meta.size : 0;

  const p = lostPath(root);

  // 便宜的"同一现场"预判：坏帧会反复出现，先看最后一条留痕是不是同一件事，
  // 是就 O(1) 返回，不做第二遍帧扫描、也不算 hash。
  const last = readLastLostRecord(p);
  const sameIdentity = (rec) => !!rec &&
    rec.file === file &&
    rec.fromByte === fromByte &&
    rec.scanSize === scanSize &&
    rec.failedFrames === failedFrames &&
    rec.badLines === badLines;
  if (sameIdentity(last)) {
    return { ok: true, recorded: false, path: p, reason: 'duplicate', record: last };
  }

  // 第二遍：结构化解帧，拿到"哪些帧解出来了 / 哪些帧坏了 / 坏帧的精确字节区间"。
  // ★ K-4：不再扫魔数取"所有帧起点"——分帧由帧头 + 块结构决定（载荷里的假魔数
  //   不会被当成帧），所以这里的缺失区间就是读侧真正失败的那几段（含半尾帧），
  //   每段都能按 [start,end) 在磁盘上复算 sha256。坏帧之后被解出来的好帧仍算"未缺失"。
  let fileSize = 0;
  let frameOffsets = [];
  let failedFrameOffsets = [];
  let okFrames = 0;
  let coverageStopReason = '';
  let coverageOversized = false; // ★ P1-3：有"超大单帧被跳过"（≠坏帧、不 halt）
  let coverageContractViolation = false; // ★ F-3：帧=整行契约被破坏（硬断言停手）
  // ★ K-15：可跳过缺口的证据（来自 frames K-8；k8SkippableOnly = "全部失败帧都可跳过"）。
  let coverageHalted = !!meta.halted;
  let coverageGapAdvanceable = false;
  let coverageSkippedRanges = [];
  let coverageSkippableBytes = 0;
  let coverageNextSafeOffset = null;
  const missingRanges = [];

  if (badMagic) {
    // 读起点连魔数都不是：无法定位帧边界，整段 [fromByte, size) 按缺失处理（不猜）。
    // 这种情况不做结构扫描（文件再大也不该在"已经坏了"的路径上烧 IO）。
    try {
      fileSize = fs.statSync(file).size;
    } catch {
      return { ok: false, recorded: false, reason: 'file-gone' };
    }
    const end = Math.max(fromByte, scanSize > 0 ? Math.min(scanSize, fileSize) : fileSize);
    if (end > fromByte) missingRanges.push({ start: fromByte, end, bytes: end - fromByte });
  } else {
    const coverage = decodeFramesFrom(file, fromByte, {
      assertLineBoundary: true,
      // ★ P2-02：与读取侧同口径（否则"跳过的帧"在复核里会被读成功，证据自相矛盾）
      maxFrameBytes: Number.isInteger(info.maxFrameBytes) && info.maxFrameBytes > 0 ? info.maxFrameBytes : undefined,
      maxDecompressedBytes: Number.isInteger(info.maxDecompressedBytes) && info.maxDecompressedBytes > 0 ? info.maxDecompressedBytes : undefined,
    });
    const okStarts = new Set(coverage.parts.map((part) => part.start));
    okFrames = okStarts.size;
    fileSize = Number(coverage.size) || 0;
    coverageStopReason = String(coverage.stopReason || '');
    // ★ K-15：本次缺口的"可跳过"性质（超大帧/解压超限 vs 真坏帧）。
    coverageHalted = !!coverage.halted;
    coverageGapAdvanceable = coverage.gapAdvanceable === true;
    coverageSkippedRanges = Array.isArray(coverage.skippedRanges) ? coverage.skippedRanges : [];
    coverageSkippableBytes = Number(coverage.skippableBytes) || 0;
    coverageNextSafeOffset = Number.isInteger(coverage.nextSafeOffset) ? coverage.nextSafeOffset : null;
    const limit = scanSize > 0 ? Math.min(scanSize, fileSize) : fileSize;

    // 帧起点 = 解出来的帧 + 坏帧（都来自结构分帧；坏帧起点同样可独立复核）
    const offs = new Set();
    for (const s of okStarts) if (s >= fromByte && s < limit) offs.add(s);
    for (const s of (coverage.failedOffsets || [])) {
      if (Number.isInteger(s) && s >= fromByte && s < limit) offs.add(s);
    }
    frameOffsets = [...offs].sort((a, b) => a - b);
    if (frameOffsets.length === 0 || frameOffsets[0] !== fromByte) {
      // 起点在 [fromByte, 第一个帧起点) 之间的字节没有任何帧认领 —— 也是缺口。
      const end = frameOffsets.length ? frameOffsets[0] : limit;
      if (end > fromByte) missingRanges.push({ start: fromByte, end, bytes: end - fromByte });
    }
    for (const r of (coverage.failedRanges || [])) {
      const start = Number(r && r.start);
      if (!Number.isInteger(start) || start < fromByte || start >= limit) continue;
      const end = Math.min(Number.isInteger(r && r.end) ? r.end : limit, limit);
      if (end <= start) continue;
      if (r && r.oversized) coverageOversized = true;
      if (r && r.reason === 'contract-violation') coverageContractViolation = true;
      failedFrameOffsets.push(start);
      if (!missingRanges.some((m) => m.start === start)) {
        missingRanges.push({ start, end, bytes: end - start });
      }
    }
  }

  const reasons = [];
  if (badMagic) reasons.push('bad-magic');
  if (failedFrames > 0) reasons.push('failed-frames');
  // 缺口一直延伸到文件尾 → 这是"半截帧/截断"，单独标出来（对账器要优先查最后一段）。
  // bad-magic 不算"截断"：它的缺口是"起点不在帧边界"，可能只是游标失效/文件被改写。
  if (!badMagic && (coverageStopReason === 'truncated-tail' ||
      (missingRanges.some((r) => r.end === fileSize) && fileSize > 0))) {
    reasons.push('truncated-tail');
  }
  // ★ P1-3：超大单帧"跳过并继续"是缺口的一种，但不是坏帧（halted=false）。
  // ★ K-15：原因字符串固定为 'oversized-frame'（判据/自测按此断言，不随实现漂移）。
  if (!badMagic && coverageOversized) reasons.push('oversized-frame');
  if (badLines > 0) reasons.push('bad-lines');

  // ★ F-3（方案 B）：帧=整行契约被破坏 —— 固定原因串（判定/自测按名匹配，不随实现漂移）。
  if (!badMagic && (coverageContractViolation || coverageStopReason === 'contract-violation')) {
    reasons.push('contract-violation');
  }
  const reasonList = [...new Set(reasons)];
  // ★ K-15：缺口**全部可跳过**（无 halt/bad-magic，每个失败区间都带 skippable+frameEnd）——
  //   这类缺口重扫同配置不会自愈，所以 retryable=false 且注明 skippable=true；
  //   坏帧/截断/坏魔数类仍是 retryable=true（源修复后从游标点可补）。
  const skippableOnly = !badMagic && !coverageHalted && coverageGapAdvanceable;

  // 先构造"不带 hash 的骨架"做完整比对；确认是新现场后才补 sha256（大文件 hash 不便宜）。
  const skeleton = {
    v: 1,
    sid: typeof info.sid === 'string' ? info.sid : '',
    sessDir: typeof info.sessDir === 'string' && info.sessDir
      ? info.sessDir
      : (path.basename(path.dirname(file)) || ''),
    file,
    fromByte,
    scanSize,     // readTurnsFrom 当时看到的文件大小
    fileSize,     // 留痕时实测的文件大小
    // ★ P2-02：frames 必须与 okFrames/failedFrames **自洽**（旧记录出现过 4+1>4 的矛盾）。
    //   口径：frames = 复核口径的帧总数（成功 + 失败/跳过）；framesRead 另记读取侧看到的帧数。
    frames: (Number(okFrames) || 0) + (Array.isArray(failedFrameOffsets) ? failedFrameOffsets.length : 0),
    framesRead: Number(meta.frames) || frameOffsets.length,
    okFrames,
    failedFrames,
    badLines,
    formatError,
    reasons: reasonList,
    // ★ K-4：停在哪、为什么停、能不能重试 —— 一眼能判"这是缺口还是读端终结"。
    // ★ P2-02：跳过式缺口也要有**明确** stopReason（旧记录出现 stopReason='' 却 reasons=['failed-frames'] 的自相矛盾）
    stopReason: coverageStopReason || (badMagic ? 'bad-magic' : '') || (coverageOversized ? 'oversized-frame-skip' : ''),
    haltOffset: meta.halted && Number.isInteger(meta.haltOffset) ? meta.haltOffset : 0,
    // ★ K-15：可跳过缺口 = 游标可以推进的缺口。retryable 与 skippable 互斥：
    //   skippable=true → 缺口字节已被证据冻结（重扫同配置不会恢复），retryable=false。
    skippable: skippableOnly,
    retryable: !skippableOnly,
    skippableBytes: coverageSkippableBytes,
    nextSafeOffset: coverageNextSafeOffset,
    skippedRanges: coverageSkippedRanges,
    frameOffsets,       // [fromByte, size) 内所有帧起点（绝对偏移，结构分帧口径）
    failedFrameOffsets, // 其中解不开/被截断/被跳过的帧起点
    missing: missingRanges.map((r) => ({ ...r, sha256: '' })), // 占位，记录前填真值
  };
  if (sameLoss(last, skeleton)) {
    return { ok: true, recorded: false, path: p, reason: 'duplicate', record: last };
  }

  // 缺失区间补上可复算的 sha256（对当前磁盘上的字节算；文件后来再变，这里仍留旧证）
  skeleton.missing = missingRanges.map((r) => ({
    ...r,
    sha256: hashByteRange(file, r.start, r.end),
  }));

  const record = {
    v: skeleton.v,
    at: isoTime(now, offsetMinutes), // 时间口径：+08:00，禁止 Z 结尾
    sid: skeleton.sid,
    sessDir: skeleton.sessDir,
    file: skeleton.file,
    fromByte: skeleton.fromByte,
    scanSize: skeleton.scanSize,
    fileSize: skeleton.fileSize,
    frames: skeleton.frames,
    okFrames: skeleton.okFrames,
    failedFrames: skeleton.failedFrames,
    badLines: skeleton.badLines,
    formatError: skeleton.formatError,
    reasons: skeleton.reasons,
    stopReason: skeleton.stopReason,
    haltOffset: skeleton.haltOffset,
    skippable: skeleton.skippable,
    retryable: skeleton.retryable,
    skippableBytes: skeleton.skippableBytes,
    nextSafeOffset: skeleton.nextSafeOffset,
    skippedRanges: skeleton.skippedRanges,
    frameOffsets: skeleton.frameOffsets,
    failedFrameOffsets: skeleton.failedFrameOffsets,
    missing: skeleton.missing,
    resume: skeleton.skippable
      ? '可跳过缺口（超大帧/解压超限）：游标推进到缺口之后的帧边界（nextSafeOffset），不 blocked；' +
        '缺口字节区间与 sha256 已留痕，源字节是冻结的，重扫同配置不会恢复（retryable=false）'
      : '游标只提交到坏帧之前的已提交前缀末尾；源修复后从该点续读，靠 (sid,turn)/code 幂等去重；本记录可重试（retryable=true）',
    recompute: '按 frameOffsets 切帧、对 failedFrameOffsets 对应区间重解 zstd；missing 的 [start,end) 与 sha256 可独立复算复核',
  };

  appendLineSync(p, JSON.stringify(record));
  return { ok: true, recorded: true, path: p, record };
}

// ============================================================================
// 四、扫会话目录
// ============================================================================

/**
 * 递归找出某个根目录下所有 DSH 会话文件。
 *
 * @param {string} sessionsBase 形如 `C:\Users\<u>\.dsh\sessions`
 * @returns {Array<{path:string, sid:string, s12:string, mtimeMs:number, size:number}>}
 *
 * @why 返回 s12（12 位短 ID）：调用方要拿它算编码，而现算一次会重复劳动。
 *      注意 s12 可能为空（文件名里取不到）—— 那时用会话头里的 id 兜底。
 */
export function scanSessions(sessionsBase) {
  return scanSessionsInternal(sessionsBase).supported;
}

/**
 * 找出"有会话文件、但版本不是 v4"的那些 —— v0.2 的格式守卫配套。
 *
 * @param {string} sessionsBase
 * @returns {Array<{path:string, version:string}>}
 *
 * @why 为什么不直接忽略：忽略等于"这个会话永远不入账，而且没人知道"。
 *      必须让 index.js 把它写进 errors —— 停摆可逆，漏账不可逆。
 */
export function scanUnsupportedVersions(sessionsBase) {
  return scanSessionsInternal(sessionsBase).unsupported;
}

/**
 * 扫描实现：一次遍历，同时分出"支持的版本"和"不支持的版本"。
 *
 * @param {string} sessionsBase
 * @returns {{supported: Array<object>, unsupported: Array<{path:string, version:string}>}}
 */
function scanSessionsInternal(sessionsBase) {
  const supported = [];
  const unsupported = [];
  if (!fs.existsSync(sessionsBase)) return { supported, unsupported };

  const walk = (dir, depth) => {
    if (depth > 6) return; // 防环
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else {
        const m = SESSION_FILE_ANY.exec(e.name);
        if (!m) continue;
        if (e.name !== SESSION_FILE) {
          unsupported.push({ path: p, version: m[1] });
          continue;
        }
        const dirName = path.basename(path.dirname(p));
        const sid = dirName.startsWith('session-') ? dirName : '';
        let st = null;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        supported.push({
          path: p,
          sid,
          s12: normalizeSessionId(sid || dirName),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  };

  walk(sessionsBase, 0);
  return { supported, unsupported };
}

/**
 * 从事件数组里挑出「已闭合」的轮次边界。
 *
 * @param {object[]} events 已解析的事件（不含会话头）
 * @returns {Array<{turn:number, startMs:number, endMs:number, reason:string}>}
 *
 * @why 用 `turn/start` 与 `turn/end` 作为边界，而不是"数消息"——
 *      因为一轮可能有多个 step、多个工具调用，消息条数不稳定。
 *      而 turn/start 的 `time` 就是我们要的"会话开始时刻"锚点。
 *
 * @why 只返回**闭合**的轮次（2026-11-08 修）：
 *      v0.1 原实现会把"有 start 没 end"的轮次也塞进结果，标 partial。
 *      但编码是永久主键、账只追加 —— 一条 partial 一旦入库，
 *      等它真正闭合时会被 (sid,turn) 闸门判为"已记过"而跳过，
 *      那条记录就永远停在 partial，且 endMs 等于 startMs。
 *      所以：未闭合的轮次不入账，由 openTurn() 单独返回，是否兜底由调用方
 *      按"会话安静了多久"决定。
 */
export function collectTurns(events) {
  return collectTurnsDetailed(events).closed;
}

/**
 * 取出**仍未闭合**的那一轮（有 turn/start、还没有匹配的 turn/end）。
 *
 * @param {object[]} events 已解析的事件（不含会话头）
 * @returns {{turn:number, startMs:number, endMs:number, reason:string}|null}
 *
 * @why 单独暴露而不是混进 collectTurns：
 *      调用方要能区分"这轮已经结束"和"这轮还在跑"，才能决定是立即入账，
 *      还是等它安静下来（避免把进行中的轮次写成 partial，见 collectTurns 的说明）。
 */
export function openTurn(events) {
  return collectTurnsDetailed(events).open;
}

/**
 * 一次遍历，同时得到"已闭合""未闭合""被跳过的不合格事件"三者。
 *
 * @param {object[]} events
 * @returns {{closed: object[], open: object|null, malformed: number}}
 *          malformed = 因缺 time 或缺 turn 而被跳过的轮次边界数量
 *
 * @why 需要 malformed 计数（2026-11-08 补，来自独立审查 A15）：
 *      原实现把缺 time 的事件当 `time = 0`，于是写出
 *      `1970-01-01T08:00:00+08:00` 的时间戳；把 turn 为 null 的轮次也收进来，
 *      又会让 (sid,turn) 闸门变成 `sid#null` —— 同一会话的多个 null 轮次
 *      会互相判成"已记过"，反而漏记。
 *      两种都是**不可审计**的账：前者时间假、后者丢真。所以：
 *      · time 不是有效正数 → 跳过该边界；
 *      · turn 不是整数 → 跳过该边界；
 *      · 跳过数量必须能报出来，不许静默吞掉。
 *
 * @why 仍然只遍历一次：三份结果必须来自同一套配对规则，
 *      分开扫会出现"collectTurns 说闭合、openTurn 说没闭合"的自相矛盾。
 */
export function collectTurnsDetailed(events) {
  const closed = [];
  let open = null;
  let malformed = 0;

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    const t = ev.type;
    if (t !== 'turn/start' && t !== 'turn/end') continue;

    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) && ev.time > 0
      ? ev.time
      : 0;
    const num = ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;

    // 不合格的边界：宁可少记一轮，也不写一条时间/身份都不可信的账
    if (time === 0 || num === null) {
      malformed++;
      continue;
    }

    if (t === 'turn/start') {
      open = { turn: num, startMs: time, endMs: 0, reason: '' };
    } else if (open && open.turn === num) {
      open.endMs = time;
      open.reason = (ev.data && ev.data.reason && ev.data.reason.kind) || '';
      closed.push(open);
      open = null;
    }
  }

  return { closed, open, malformed };
}