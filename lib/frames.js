/**
 * @file frames.js
 * @role zstd 多帧的**按字节偏移**读取 —— v0.2 增量读的地基。
 * @called-by lib/ledger.js
 * @depends 仅 node:zlib
 * @why v0.1 每次把整个会话文件读进来、全解、拼成一个大 Buffer：
 *      229 MB 的文件直接把 node 撑崩（`Buffer.concat` 原生断言失败）。
 *      v0.2 改成"从上次读到的帧边界继续读"，读多少算多少。
 *
 * ⚠️ 三个必须守住的性质（★ 0.9.5-re K-4 重写）：
 *   ① 帧边界由 **zstd 帧头 + 块结构**（RFC 8878）逐字节算出，不再"扫魔数切帧"。
 *      压缩载荷里恰好出现魔数 0x28 0xB5 0x2F 0xFD 不会被误判成新帧 —— 那是
 *      旧实现最脆的一处（假阳性 → 该帧解压失败 → 一整段数据读不出来）。
 *      魔数只在**坏帧恢复**时用作兜底（结构已不可信时，用它划出损坏字节段），
 *      正常帧的边界永远由结构决定。
 *   ② 坏帧/半尾帧不抛错，但**如实上报停在哪**：
 *      `halted=true`、`haltOffset=坏帧起点`、`stopReason`（bad-frame / truncated-tail /
 *      bad-structure）。**绝不把停止位置设到文件末尾** ——
 *      那等于告诉调用方"后面都正常读完了"，坏帧里的轮次会被静默跳过。
 *      已解出的帧照常通过回调交付（上层负责落账/留痕），不因为一帧坏就清空。
 *   ③ 解不开的帧只计数、不抛错 —— 一帧坏掉不能拖垮整轮扫描。
 *   ④ **超大单帧（超过 maxFrameBytes）不是坏帧**（P1-3 原契约，K-4 保留）：
 *      跳过该帧、继续解后续帧，计 `failed/skipped` + `failedRanges[{oversized:true}]`，
 *      **不**设置 halted/haltOffset（上层不得因此把整份会话判死）。
 *
 * @why 为什么"解出坏帧之后还继续解后面的帧"（K-4 的决定）：
 *      帧长度由结构算出后，坏帧之后的帧边界仍是确定的（不会把半帧当整帧），
 *      所以后面的好帧可以照常解出交给上层 —— 这是"不丢真数据"。
 *      但**游标不许越过坏帧**：上层只把游标提交到坏帧之前的已提交前缀末尾，
 *      下一 tick 从那里重试；因此这里只报 `haltOffset`，不替调用方决定停不停。
 *
 * ---------------------------------------------------------------------------
 * ★ K-8（v1.0.0-re3 · 审计③ CORE-01 契约对齐）——本文件只加**元数据**，不改语义：
 *   ① 每个"可跳过"的失败区间（超大压缩帧 / 解压超限帧）显式带：
 *        { skippable:true, frameEnd, resumeAt, reason }
 *      —— frameEnd/resumeAt 都是该帧的**帧尾偏移**（下一帧起点，可安全续读）；
 *      坏帧/半截帧**不带** skippable（它们必须 halted，游标不许越过）。
 *   ② 顶层聚合：`skippedRanges[]`（所有可跳过区间，按出现顺序）、`skippableBytes`、
 *      `nextSafeOffset`（本次读取后游标**最多**可推进到的偏移：halted→haltOffset，
 *      budget 停→stoppedAt，否则→size）、`gapAdvanceable`（本次的唯一布尔判断：
 *      "确实有缺口，但全部可跳过且没有 halt/bad-magic → 上层可以推进游标到 nextSafeOffset"）。
 *   ③ `bytesRead`：本次读取真实落盘的字节数（每个 readSync 的返回之和，含魔数兜底扫描），
 *      供上层把"真实读盘"计入 tick 度量（审计③ RT-03 的口径：估算必须能被实测对上）。
 *   以上均为**只加不改**：K-4 的 haltOffset/stopReason/游标红线一字未动；
 *   帧边界算法、maxFrameBytes/maxOutputLength 口径也未改（K-6 保持）。
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/** zstd 帧魔数：0x28 0xB5 0x2F 0xFD。DSH 每追加写一批，就多一帧。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 魔数长度（4）。 */
const MAGIC_LEN = ZSTD_MAGIC.length;

// ---------------------------------------------------------------------------
// ★ P1-05（准入审计 P1-05 · 机主裁定 V1.0 前解决）：**解压后**大小上限。
//
// ★ KERNEL 标记：本文件属 K-4（坏帧/游标语义）签字范围。本次改动**只加"解压输出上限"**：
//   不改帧边界算法、不改 haltOffset/stopReason 语义、不改"坏帧不推进游标"的红线；
//   解压超限按 P1-3 超大帧同口径处理（跳过 + 结构化留痕 + 不 halted）。
//
// @why 原实现只限"压缩帧"（maxFrameBytes / 64 MiB），解压结果完全不设界：
//      一个 82 B 的合法 zstd 帧可以解出 2 GiB 的正文（压缩炸弹），
//      `zstdDecompressSync` 会先把整块解压结果分配出来 —— 宿主直接被顶爆
//      （本机历史上已发生过 OOM 顶崩）。这是**内存安全**问题，不是数据正确性问题。
// @why 64 MiB：实测语料最大单帧压缩 1.8 MiB、解压后最大约 20 MB 量级（v4 会话整份正文
//      常在一个巨帧里），64 MiB 留约 3× 余量，正常语料不会被误判。
// @why 用 `maxOutputLength` 而不是"解完再量"：解完再量已经晚了（内存已经分配）。
//      超限时 Node 抛 ERR_BUFFER_TOO_LARGE，我们把它归类为
//      **结构化 loss（skipped + oversizedDecompressed）**，不是坏帧：
//      不 markHalt（与 P1-3 超大帧同口径），跳过该帧继续解后面的帧，绝不 OOM。
// ---------------------------------------------------------------------------
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
/** 配置上界（防止调用方把上限配成无界）：256 MiB。 */
const MAX_DECOMPRESSED_HARD_LIMIT = 256 * 1024 * 1024;

/** 判断解压失败是否属于"输出超上限"（而不是坏帧/损坏数据）。 */
function isOutputTooLarge(e) {
  if (!e) return false;
  if (e.code === 'ERR_BUFFER_TOO_LARGE') return true;
  return /maxOutputLength|larger than|too large/i.test(String(e.message || e));
}


/** 当前缓冲区是否从 `pos` 起就是帧魔数。 */
function hasMagicAt(buf, pos = 0) {
  return buf.length - pos >= MAGIC_LEN && buf.indexOf(ZSTD_MAGIC, pos) === pos;
}

/**
 * 在 Buffer 里找出所有帧起点（绝对偏移）。
 *
 * @param {Buffer} buf
 * @param {number} base 这段 Buffer 在文件中的起始偏移
 * @returns {number[]} 帧起点的绝对偏移数组（升序）
 *
 * @why 保留这个"扫魔数"工具**只作诊断/兼容**用（老测试与人工核查按它取偏移）；
 *      正常解帧路径不再用它切帧 —— 边界一律走 frameSpan 的结构计算。
 */
export function frameStarts(buf, base = 0) {
  const out = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) {
    out.push(base + i);
    i = buf.indexOf(ZSTD_MAGIC, i + MAGIC_LEN);
  }
  return out;
}

/**
 * 解析 zstd 帧头（RFC 8878 §3.1.1），返回"头到哪结束、载荷多大"。
 *
 * 字段布局：
 *   Magic_Number(4) | Frame_Header_Descriptor(1)
 *   [Window_Descriptor(1)]（Single_Segment_flag=0 时才有）
 *   [Dictionary_ID(0/1/2/4)] | [Frame_Content_Size(0/1/2/4/8)] | Blocks...
 *
 * @param {Buffer} buf
 * @param {number} [pos]
 * @returns {{ok:true, headerEnd:number, headerLen:number, fcs:number, fcsBytes:number,
 *            single:boolean, checksum:boolean}
 *          |{ok:false, need:true}            // 字节不够（可能是半帧，也可能是窗口没读完）
 *          |{ok:false, badMagic:true}}       // 起点不是帧魔数
 *
 * @why 为什么要自己解析帧头：node 的 `zstdDecompressSync` 只认"一整帧"，
 *      它**不告诉你这一帧有多长**。没有帧长就只能扫魔数，而扫魔数会把
 *      "压缩载荷里恰好出现的魔数"当真帧起点 —— 本次 K-4 要修的就是这个。
 *      帧头里给了 Frame_Content_Size 时能直接算长度；DSH 的流式帧没有 FCS，
 *      因此还要按块结构走一遍（见 frameSpan）。
 */
export function readFrameHeader(buf, pos = 0) {
  if (!Buffer.isBuffer(buf) || buf.length - pos < 5) return { ok: false, need: true };
  if (!hasMagicAt(buf, pos)) return { ok: false, badMagic: true };

  const fhd = buf[pos + 4];
  const fcsFlag = (fhd >> 6) & 3;
  const single = ((fhd >> 5) & 1) === 1;
  const checksum = ((fhd >> 2) & 1) === 1;
  const dictFlag = fhd & 3;

  let q = pos + 5;
  if (!single) q += 1; // Window_Descriptor
  // Dictionary_ID_flag：0=无, 1=1 字节, 2=2 字节, 3=4 字节
  q += dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : dictFlag === 3 ? 4 : 0;

  // FCS_Field_Size：flag=0 时 0 字节；但 Single_Segment=1 时是 1 字节
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  if (buf.length - q < fcsBytes) return { ok: false, need: true };

  let fcs = 0;
  if (fcsBytes > 0) {
    for (let k = 0; k < fcsBytes; k++) fcs += buf[q + k] * Math.pow(256, k);
    if (fcsBytes === 2) fcs += 256; // RFC 8878：2 字节 FCS 带 256 偏移
  }
  q += fcsBytes;

  return { ok: true, headerEnd: q, headerLen: q - pos, fcs, fcsBytes, single, checksum };
}

/**
 * 算出一个**完整** zstd 帧的长度（不依赖解压，也不扫魔数）。
 *
 * @param {Buffer} buf
 * @param {number} [pos]
 * @returns {{ok:true, end:number, headerEnd:number}
 *          |{ok:false, need:true}         // 数据还不够（可能是半帧/窗口没读完）
 *          |{ok:false, badMagic:true}     // 起点不是魔数
 *          |{ok:false, badBlock:true}}    // 块结构非法（保留块类型/越界等）
 *
 * @why 这是 K-4 的核心：帧长从"扫到的下一个魔数"变成"帧头 + 每个块头的长度和"。
 *      载荷里出现魔数不再影响分帧；只有帧真的不能解析时才由调用方回退到魔数兜底。
 * @why 有 Frame_Content_Size 时用 FCS 直接算（最可靠）：长度 = 头 + FCS + checksum(4)。
 *      DSH 的帧是流式压缩（无 FCS），走到块游走分支。
 */
export function frameSpan(buf, pos = 0) {
  const h = readFrameHeader(buf, pos);
  if (!h.ok) return h;

  // 注意：Frame_Content_Size 是**解压后**大小，不能拿来算压缩帧长度 ——
  // 压缩帧的字节长度只能由块结构逐块相加。所以这里一律走块游走（FCS 仅用于 sanity）。
  let q = h.headerEnd;
  for (let guard = 0; guard < 1e6; guard++) {
    if (buf.length - q < 3) return { ok: false, need: true };
    const head = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
    const last = (head & 1) === 1;
    const type = (head >> 1) & 3;
    const size = (head >> 3) & 0x1fffff;
    if (type === 3) return { ok: false, badBlock: true }; // 保留类型：结构不可信
    q += 3;
    if (type === 1) {
      // RLE 块：载荷恒 1 字节
      if (buf.length - q < 1) return { ok: false, need: true };
      q += 1;
    } else {
      // raw / compressed 块：载荷 size 字节
      if (buf.length - q < size) return { ok: false, need: true };
      q += size;
    }
    if (last) break;
  }
  if (buf.length - q < 0) return { ok: false, need: true };
  if (h.checksum) {
    if (buf.length - q < 4) return { ok: false, need: true };
    q += 4;
  }
  return { ok: true, end: q, headerEnd: h.headerEnd };
}

/**
 * 从文件的某个字节偏移开始，逐帧解压（一次性收集全部结果，纯内存返回）。
 *
 * @param {string} filePath 会话文件路径
 * @param {number} fromByte 从哪个字节开始读（必须落在帧边界；0 = 从头）
 * @returns {{
 *   size: number,          // 文件总字节数
 *   fromByte: number,      // 本次起点
 *   frames: number,        // 本次涉及的帧数
 *   ok: number,            // 解成功的帧数
 *   failed: number,        // 解失败的帧数（>0 要上报）
 *   parts: Array<{start:number, end:number, text:string}>, // 每帧的解压文本与范围
 *   badMagic: boolean,     // 起点处找不到魔数（多半是文件被改写/偏移失效）
 *   halted: boolean,       // 是否因坏帧停下（游标不许越过 haltOffset）
 *   haltOffset: number,    // 第一个坏帧的起点（=停住位置；不是文件尾）
 *   stopReason: string,    // '' | 'bad-frame' | 'truncated-tail' | 'bad-structure' | 'bad-magic'
 *                          // （超大帧不 halt：只计 failed/skipped + oversized 区间）
 *   failedRanges: Array<{start:number,end:number,oversized?:boolean,
 *                        skippable?:boolean,frameEnd?:number,resumeAt?:number,reason?:string}>,
 *   failedOffsets: number[],
 *   // ★ K-8：可跳过区间的显式清单与"游标最多能到哪"（契约见文件头）
 *   skippedRanges: Array<{start:number,end:number,skippable:true,frameEnd:number,resumeAt:number,reason:string}>,
 *   skippableBytes: number,
 *   nextSafeOffset: number,
 *   gapAdvanceable: boolean,
 *   bytesRead: number,          // 真实读盘字节（含兜底扫描）
 *   oversizedDecompressed: number, // 解压超限帧数（P1-05/K-6）
 *   decompressLimitBytes: number   // 本读生效的解压上限
 * }}
 */
export function decodeFramesFrom(filePath, fromByte = 0, opts = {}) {
  const parts = [];
  const stats = streamFrames(filePath, fromByte, (text, start, end) => {
    parts.push({ start, end, text });
  }, opts);
  return {
    size: stats.size,
    fromByte: stats.fromByte,
    frames: stats.frames,
    ok: stats.ok,
    failed: stats.failed,
    failedRanges: stats.failedRanges,
    failedOffsets: stats.failedOffsets,
    parts,
    badMagic: stats.badMagic,
    halted: stats.halted,
    haltOffset: stats.haltOffset,
    stopReason: stats.stopReason,
    // ★ K-8：可跳过/帧尾/真实读盘（只加不改；上层据此推进游标与计读盘）
    skippedRanges: stats.skippedRanges,
    skippableBytes: stats.skippableBytes,
    nextSafeOffset: stats.nextSafeOffset,
    gapAdvanceable: stats.gapAdvanceable,
    bytesRead: stats.bytesRead,
    oversizedDecompressed: stats.oversizedDecompressed,
    decompressLimitBytes: stats.decompressLimitBytes,
  };
}

/**
 * 分块流式解帧 —— v0.2 里"首读不再整段入内存"的关键。
 *
 * @param {string} filePath
 * @param {number} fromByte 起始字节（必须落在帧边界）
 * @param {(text:string, start:number, end:number) => void} onFrame 每解出一帧回调一次
 * @param {{windowBytes?:number, maxFrameBytes?:number, maxBytes?:number}} [opts]
 *        windowBytes：一次读多少字节（默认 8 MB）
 *        maxFrameBytes：单帧上限（超了记 oversized，不炸进程）
 *        maxBytes：本次最多解多少字节（0/缺省 = 不限）。到量就停在**帧边界**上，
 *                  返回的 stoppedAt 就是下次的续读点 —— 这是 P0-2 "分批扫描"的落点。
 * @returns {{size:number, fromByte:number, frames:number, ok:number, failed:number,
 *            badMagic:boolean, stoppedAt:number, stopped:boolean,
 *            halted:boolean, haltOffset:number, stopReason:string,
 *            failedRanges:Array<{start:number,end:number,oversized?:boolean}>,
 *            failedOffsets:number[],
 *            skippedRanges:Array<object>, skippableBytes:number,
 *            nextSafeOffset:number, gapAdvanceable:boolean, bytesRead:number}}
 *
 * @why 为什么要返回 failedRanges/failedOffsets（P1-5）：
 *      只返回计数的话，上层只能写一行"有 N 帧坏了"——坏了哪一段、丢了哪些字节
 *      无从复算，也不能作为对账/人工恢复的凭据。区间 + 起点一起返回，
 *      才能落进 `.lost.jsonl` 并被独立复核（按区间重解 zstd 必然失败 = 可验证）。
 *
 * @why 为什么要 maxBytes 而不是"按帧数"：
 *      帧大小差很多（一帧可能几十字节，也可能几十 KB）。
 *      按字节卡预算，才能保证单次扫描的时间可预期。
 *
 * @why 为什么必须停在帧边界：
 *      停在帧中间，下次会把半帧当整帧解 —— 解不开还算好的，解出半截 JSON 更糟。
 *
 * @why （K-4）停止位置的口径：
 *      `haltOffset` = **第一个坏帧的起点**。半尾帧（文件被截断）也停在它的起点，
 *      不把 stoppedAt 设成文件尾。上层据此把游标停在"坏帧之前的已提交前缀末尾"，
 *      下一 tick 重试；源修复后从那里续记，(sid,turn) 幂等防重。
 */
export function streamFrames(filePath, fromByte = 0, onFrame = () => {}, opts = {}) {
  const windowBytes = Number.isInteger(opts.windowBytes) && opts.windowBytes > 0 ? opts.windowBytes : 8 * 1024 * 1024;
  const maxFrameBytes = Number.isInteger(opts.maxFrameBytes) && opts.maxFrameBytes > 0 ? opts.maxFrameBytes : 64 * 1024 * 1024;
  const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 0;
  // ★ P1-05：解压后上限（默认 64 MiB；调用方可下调，但不得越过硬上界）。
  const maxDecompressedBytes = Number.isInteger(opts.maxDecompressedBytes) && opts.maxDecompressedBytes > 0
    ? Math.min(opts.maxDecompressedBytes, MAX_DECOMPRESSED_HARD_LIMIT)
    : MAX_DECOMPRESSED_BYTES;

  const fd = fs.openSync(filePath, 'r');
  const result = {
    size: 0, fromByte: 0, frames: 0, ok: 0, failed: 0, badMagic: false,
    stoppedAt: 0, stopped: false,
    // ★ K-4：坏帧/半尾帧的"停住位置"与原因（不是文件尾）。
    halted: false, haltOffset: 0, stopReason: '',
    // 坏帧必须**结构化**报出来：区间可复算、起点可独立复核（P1-5）。
    failedRanges: [], failedOffsets: [],
    // ★ F-3（方案 B）：帧=整行契约的违反记录（硬断言命中时写入；正常语料应为空）
    contractViolations: [],
    // ★ P1-05：解压后超上限的帧（内存安全计数，与坏帧分开报）。
    oversizedDecompressed: 0,
    decompressLimitBytes: maxDecompressedBytes,
    // ★ K-8：可跳过区间清单 / 帧尾偏移 / 真实读盘（只加不改；契约见文件头）。
    skippedRanges: [], skippableBytes: 0,
    nextSafeOffset: 0, gapAdvanceable: false, bytesRead: 0,
  };

  /** 记录第一个坏帧的停住点；后到的坏帧不覆盖第一个（游标只受第一个约束）。 */
  const markHalt = (at, reason) => {
    if (result.halted) return;
    result.halted = true;
    result.haltOffset = at;
    result.stopReason = reason;
    result.stoppedAt = at;
  };

  try {
    const size = fs.fstatSync(fd).size;
    result.size = size;
    let pos = Math.max(0, Math.min(fromByte, size));
    result.fromByte = pos;
    if (pos >= size) return result;

    // 从 pos 读一块（不越过文件尾）
    const readAt = (start, len) => {
      if (len <= 0) return Buffer.alloc(0);
      const b = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, b, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      result.bytesRead += got; // ★ K-8：真实读盘字节（含魔数兜底扫描）
      return b.subarray(0, got);
    };

    /** 结构不可用时的兜底：从 fromAbs 起（窗口化）向后找下一个魔数；找不到返回 -1。 */
    const findMagicForward = (fromAbs) => {
      let scan = fromAbs;
      const STEP = 1024 * 1024;
      while (scan < size) {
        const w = readAt(scan, Math.min(STEP, size - scan));
        if (w.length === 0) return -1;
        const idx = w.indexOf(ZSTD_MAGIC, 0);
        if (idx !== -1) return scan + idx;
        if (w.length <= MAGIC_LEN - 1) return -1;
        scan += w.length - (MAGIC_LEN - 1);
      }
      return -1;
    };

    let buf = readAt(pos, Math.min(windowBytes, size - pos));
    if (!hasMagicAt(buf, 0)) {
      // 读起点不在帧边界：游标失效（文件被截断/重写），上层要回退全量。
      result.badMagic = true;
      markHalt(pos, 'bad-magic');
      return result;
    }

    let startAbs = pos;
    let consumed = 0; // 本次已解多少字节（用于时间预算）

    for (;;) {
      // ── ① 把当前帧的结构补完整：结构明确前不猜边界 ──
      let span = frameSpan(buf, 0);
      while (!span.ok && span.need) {
        const tailAbs = startAbs + buf.length;
        if (tailAbs >= size) break;          // 到文件尾仍不完整 → 半尾帧候选
        if (buf.length >= maxFrameBytes) break; // 单帧超过上限 → 交给 oversized 分支
        const more = readAt(tailAbs, Math.min(windowBytes, size - tailAbs));
        if (more.length === 0) break;
        buf = Buffer.concat([buf, more]);
        span = frameSpan(buf, 0);
      }

      if (!span.ok) {
        const tailAbs = startAbs + buf.length;
        const atEof = tailAbs >= size;
        // ── ②a 超大单帧（P1-3，原契约，K-4 不得丢）：缓冲已补到 maxFrameBytes
        //   仍装不下这一帧 → 这是"超过单帧上限"，**不是坏帧**：
        //   跳过该帧、继续解后续帧，绝不 halted/判死整份会话。
        //   结构不可用（帧比上限还大），这里只能用**魔数兜底**划出被跳过的字节段 ——
        //   这是"坏帧/超大帧恢复"专用路径，正常帧永远走结构分帧。
        if (span.need && buf.length >= maxFrameBytes) {
          result.frames++;
          result.failed++;
          result.skipped = (result.skipped || 0) + 1;
          let nextRel = buf.indexOf(ZSTD_MAGIC, MAGIC_LEN);
          let nextAbs = nextRel === -1 ? -1 : startAbs + nextRel;
          if (nextAbs === -1) nextAbs = findMagicForward(tailAbs);
          const rangeEnd = nextAbs === -1 ? size : Math.min(size, nextAbs);
          // ★ K-8：超大帧 = 可跳过。帧尾 = 恢复边界（下一帧魔数）或文件尾；
          //   两者都是**合法续读点**（下一 tick 从这里读不会读半帧）。
          const skippedRec = {
            start: startAbs, end: rangeEnd, oversized: true,
            skippable: true, frameEnd: rangeEnd, resumeAt: rangeEnd,
            reason: 'oversized-frame',
          };
          result.failedRanges.push(skippedRec);
          result.skippedRanges.push(skippedRec);
          result.skippableBytes += Math.max(0, rangeEnd - startAbs);
          result.failedOffsets.push(startAbs);
          if (nextAbs === -1 || nextAbs >= size) {
            // 后面没有可恢复的帧边界：本次扫描到此为止（没有 halt —— 这不是坏帧）。
            return result;
          }
          buf = readAt(nextAbs, Math.min(windowBytes, size - nextAbs));
          startAbs = nextAbs;
          pos = startAbs;
          if (buf.length === 0 || !hasMagicAt(buf, 0)) {
            result.badMagic = true;
            markHalt(startAbs, 'bad-magic');
            return result;
          }
          continue;
        }
        // ── ②b 结构不可用：先尝试"坏帧恢复边界"（只在坏帧上用它，正常帧永远走结构）──
        //    · 当前缓冲区内若有下一个魔数 → 把 [start, 魔数) 记为坏帧，从魔数继续；
        //      这样坏帧之后的好帧不丢（审计要求"一帧坏不能拖垮整轮"）。
        let nextRel = buf.indexOf(ZSTD_MAGIC, MAGIC_LEN);
        let nextAbs = nextRel === -1 ? -1 : startAbs + nextRel;
        if (nextAbs === -1 && !atEof) nextAbs = findMagicForward(tailAbs);
        if (nextAbs !== -1 && nextAbs > startAbs + MAGIC_LEN) {
          result.frames++;
          result.failed++;
          result.failedRanges.push({ start: startAbs, end: nextAbs });
          result.failedOffsets.push(startAbs);
          // 后面还有真帧 → 这是"坏帧"（结构声明的长度越过了下一帧起点），不是截断尾；
          // "结构非法"（保留块类型等）单独标，便于留痕判读。
          markHalt(startAbs, span.need ? 'bad-frame' : 'bad-structure');
          if (nextAbs >= size) return result;
          buf = readAt(nextAbs, Math.min(windowBytes, size - nextAbs));
          startAbs = nextAbs;
          pos = startAbs;
          if (buf.length === 0 || !hasMagicAt(buf, 0)) {
            result.badMagic = true;
            markHalt(startAbs, 'bad-magic');
            return result;
          }
          continue;
        }
        // 没有后续魔数可作恢复边界：只能停在这里（坏帧起点），
        // **不能**把停止位置设成文件尾（那会把"没读到"伪装成"读完了"）。
        result.frames++;
        result.failed++;
        result.failedRanges.push({ start: startAbs, end: atEof ? size : Math.max(startAbs, Math.min(size, tailAbs)) });
        result.failedOffsets.push(startAbs);
        markHalt(startAbs, span.need ? (atEof ? 'truncated-tail' : 'bad-frame') : 'bad-structure');
        return result;
      }

      const frameLen = span.end;
      const endAbs = startAbs + frameLen;

      // ── ③ 超大帧（结构完整但长度超上限）：跳过并继续，不判死整份会话（P1-3）──
      if (frameLen > maxFrameBytes) {
        result.frames++;
        result.failed++;
        result.skipped = (result.skipped || 0) + 1;
        // ★ K-8：结构完整、只是超上限 → 帧尾确定（= endAbs），显式给出"可跳过/续读点"。
        const skippedRec = {
          start: startAbs, end: endAbs, oversized: true,
          skippable: true, frameEnd: endAbs, resumeAt: endAbs,
          reason: 'oversized-frame',
        };
        result.failedRanges.push(skippedRec);
        result.skippedRanges.push(skippedRec);
        result.skippableBytes += Math.max(0, endAbs - startAbs);
        result.failedOffsets.push(startAbs);
        // ★ P1-3：这里**不是**坏帧 —— 不 markHalt（不 halted、不拦游标之外的任何东西）。
        if (endAbs >= size) return result;
        buf = readAt(endAbs, Math.min(windowBytes, size - endAbs));
        startAbs = endAbs;
        pos = startAbs;
        if (buf.length === 0) return result;
        if (!hasMagicAt(buf, 0)) {
          result.badMagic = true;
          markHalt(startAbs, 'bad-magic');
          return result;
        }
        continue;
      }

      // ── ④ 时间预算：已解过至少一帧，再加这一帧就超预算 → 停在这里（帧边界）──
      if (maxBytes > 0 && consumed > 0 && consumed + frameLen > maxBytes) {
        if (!result.halted) {
          result.stopped = true;
          result.stoppedAt = startAbs;
          result.stopReason = 'budget';
        }
        return result;
      }

      const frame = buf.subarray(0, frameLen);

      // ── ⑤ 结构完整才开始解；解不开 = 坏帧（结构算出来的区间就是证据）──
      result.frames++;
      consumed += frameLen;
      let frameText = null;
      let decompressErr = null;
      try {
        // ★ P1-05：maxOutputLength 让解压**在分配前**就停（不是解完再量）。
        frameText = zlib.zstdDecompressSync(frame, { maxOutputLength: maxDecompressedBytes }).toString('utf8');
      } catch (e) {
        decompressErr = e;
      }
      if (decompressErr && isOutputTooLarge(decompressErr)) {
        // ★ P1-05：解压炸弹 —— 结构化 loss，**不是坏帧**（不 markHalt，与 P1-3 超大帧同口径）。
        //   本帧内容跳过（逐字节留痕进 failedRanges，可人工复算），继续解后面的帧。
        result.failed++;
        result.skipped = (result.skipped || 0) + 1;
        result.oversizedDecompressed++;
        // ★ K-8：帧结构完整 → 帧尾确定（= endAbs），显式给出"可跳过/续读点"。
        const skippedRec = {
          start: startAbs, end: endAbs, oversized: true, oversizedDecompressed: true,
          skippable: true, frameEnd: endAbs, resumeAt: endAbs,
          reason: 'oversized-decompressed',
        };
        result.failedRanges.push(skippedRec);
        result.skippedRanges.push(skippedRec);
        result.skippableBytes += Math.max(0, endAbs - startAbs);
        result.failedOffsets.push(startAbs);
        if (endAbs >= size) return result;
        buf = readAt(endAbs, Math.min(windowBytes, size - endAbs));
        startAbs = endAbs;
        pos = startAbs;
        if (buf.length === 0) return result;
        if (!hasMagicAt(buf, 0)) {
          result.badMagic = true;
          markHalt(startAbs, 'bad-magic');
          return result;
        }
        continue;
      }
      // ★★★ F-3（方案 B · 机主 2026-11-15 裁定）：**「帧 = 整行」契约的硬断言**。
      //
      // 契约：DSH 会话写入器保证每个 zstd 帧以完整 JSONL 行结束（帧边界 = 行边界）。
      // 断言：解压文本**非空**、**不以 '\n' 结尾**、且**后面还有帧**（endAbs < size）→ 契约被破坏。
      // 行为：**立即停手 + 报警**（机主明令：不许"警告后继续"，也不许静默丢跨帧残片）：
      //   · 记 failed + failedRanges（该帧区间，第三方可按区间复算）；
      //   · markHalt(startAbs,'contract-violation') → 游标**不许越过该帧起点**（K-4 口径）；
      //   · 立即返回、不读后面的帧（上层据此报 ERROR，让该会话停住等人工处置）。
      // 边界：**最后一帧**不以换行结尾 = 合法的"截断尾"（进程被杀/正在写），不在此列。
      //   opt-in：只有"读会话 JSONL"的调用方传 assertLineBoundary=true 才启用（夹具/通用解帧不启用，
      //   否则内部测试夹具会被误判 —— 契约只对 DSH 会话写入器成立）。
      if (opts.assertLineBoundary === true && !decompressErr && frameText.length > 0 && !frameText.endsWith('\n') && endAbs < size) {
        result.failed++;
        result.failedRanges.push({ start: startAbs, end: endAbs, reason: 'contract-violation', bytes: frameLen });
        result.failedOffsets.push(startAbs);
        result.contractViolations.push({
          start: startAbs, end: endAbs, bytes: frameLen,
          tail: frameText.slice(-80).replace(/\n/g, '\\n'),
          why: '帧边界落在 JSONL 行中间：DSH 写入器「帧=整行」契约被破坏；按硬断言停手（不静默丢残片）',
        });
        markHalt(startAbs, 'contract-violation');
        return result;
      }
      if (!decompressErr) {
        try {
          onFrame(frameText, startAbs, endAbs);
          result.ok++;
        } catch (e) {
          decompressErr = e;
        }
      }
      if (decompressErr) {
        result.failed++;
        result.failedRanges.push({ start: startAbs, end: endAbs });
        result.failedOffsets.push(startAbs);
        // ★ K-4：坏帧 → 停住位置 = 坏帧起点（继续解后面的帧，但游标不许越过这里）
        markHalt(startAbs, 'bad-frame');
        // 结构算出的帧尾若不是帧边界（既不是文件尾也不是魔数），说明结构解释
        // 也不可信：改用魔数兜底划出损坏段，免得把后面的好帧错并进来。
        if (endAbs < size) {
          const at = endAbs < buf.length ? buf.indexOf(ZSTD_MAGIC, endAbs - startAbs) : -1;
          if (at === -1) {
            const fwd = findMagicForward(endAbs);
            if (fwd === -1) {
              // 后面没有可恢复的帧边界：保守停在这里（游标不越过坏帧）。
              return result;
            }
            result.failedRanges[result.failedRanges.length - 1].end = fwd;
            buf = readAt(fwd, Math.min(windowBytes, size - fwd));
            startAbs = fwd;
            pos = startAbs;
            if (buf.length === 0 || !hasMagicAt(buf, 0)) {
              result.badMagic = true;
              markHalt(startAbs, 'bad-magic');
              return result;
            }
            continue;
          }
        }
      }

      // ── ⑥ 推进到下一帧 ──
      if (endAbs >= size) return result; // 正常 EOF：最后一帧完整
      buf = buf.subarray(frameLen);
      startAbs = endAbs;
      pos = startAbs;
      if (buf.length === 0) {
        buf = readAt(startAbs, Math.min(windowBytes, size - startAbs));
        if (buf.length === 0) return result;
      }
    }
  } finally {
    // ★ K-8：派生"可跳过/游标最多到哪"（从任何 return 路径退出都要有；只加元数据）。
    //   · 第一个坏帧（halted）→ 游标最多到 haltOffset，绝不越过；
    //   · 预算停在帧边界（stopped）→ 最多到 stoppedAt；
    //   · 其它（正常 EOF / 仅跳过超大帧）→ 最多到 size。
    //   gapAdvanceable = "有缺口，但每个缺口都显式可跳过，且没有 halt/bad-magic"：
    //   上层据此把 blocked 改成"推进到 nextSafeOffset 并留 loss 证据"（CORE-01 契约）。
    const allSkippable = result.failedRanges.length > 0 &&
      result.failedRanges.every((r) => r && r.skippable === true && Number.isInteger(r.frameEnd));
    result.gapAdvanceable = result.failed > 0 && !result.halted && !result.badMagic && allSkippable;
    if (result.halted) {
      result.nextSafeOffset = Number.isInteger(result.haltOffset) && result.haltOffset >= 0
        ? result.haltOffset : 0;
    } else if (result.stopped) {
      result.nextSafeOffset = Number.isInteger(result.stoppedAt) && result.stoppedAt >= 0
        ? result.stoppedAt : result.size;
    } else {
      result.nextSafeOffset = result.size;
    }
    // 若 stoppedAt 落在已跳过的区间之后，上面已覆盖；若 gapAdvanceable 但还有未到的帧（不会：
    // 只有 budget 停才会没到 EOF，而 budget 停时 stopped=true）—— 两者互斥，不组合。
    fs.closeSync(fd);
  }
}
