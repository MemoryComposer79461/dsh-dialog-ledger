/**
 * @file sealjournal.js
 * @role 封板**事实**的唯一追加式日志（append-only journal，**lite：无链**）。
 *
 * @why 为什么把它从 .state.json 里拆出来（审计 M-02 / P1-9）：
 *   原来 `.state.json` 同时装「可重建缓存」（游标、哈希缓存、最近运行时间）
 *   和「不可丢失证据」（周记账/交接表封板状态）。state 丢一次，
 *   证据语义就变了：交接表可能被 adopt 或重新生成，周账可能保守跳过，
 *   新记录既不进正册也不进补记。审计原话：职责混合是多处故障的共同根因。
 *
 * @why lite 版为什么只剩「封板事实」（机主裁定 S-1）：
 *   机主明确：**没有"封板后被人改"的对手**。故本模块只回答三件事 ——
 *     ① 哪天封的（sealedAt / at）；② 封了哪些 key（kind + key）；③ 封了多少行（rowCount / rows）。
 *   随之**砍掉**（v0.9.1-re1）：
 *     · `prevSealSha256` 前后勾连 —— 写入不再算、读取不再校、也不存在"坏链拒写"分支；
 *     · 逐行 canonical 复算 —— 读侧不对任何行重算摘要（写侧现算 sealHash 仍保留）；
 *     · 链完整性校验 —— `verifySealChain()` 降级为「可读 + 每行可解析 + 行数统计」。
 *   ⚠️ 兼容保留：事件里的 `prevSealSha256` 恒为 `''`。
 *   ★ v1.0.0-re2（P1-01 审计整改）：`verifySealChain()` 不再恒真 —— 改为**结构性可校验**
 *      （坏行 / 重复行 / 重复 (kind,key) / 时间回退 / rows 快照被改 / 未知 kind / 存在但被清空），
 *      并在返回里明确 `verifiable` 与能力边界：**不防整行删除与全本重写**。
 *      见该函数头注释的"能发现/发现不了"两栏，别再把"可解析"当"防篡改"。
 *   ★ v1.0.0-re3（审计② P2-8/P2-9/P2-10，K-6）：**可校验性**从"名不副实"改到"缺一判红"：
 *      · `journal 缺失` 三态可分：从未封板（ok + `verifiable:false` + reason 明说）/
 *        state 记着已封板（**红**，`JOURNAL_MISSING_BUT_STATE_SEALED`）/ 存在但 0 条（红，`JOURNAL_EMPTY`）；
 *      · state 记着某键已封板、journal 里没这一行（整行删除的可判形态）→ **红**
 *        （`STATE_SEALED_BUT_JOURNAL_MISSING_KEY`）；
 *      · weekly-seal 的 `rowsSha256` **缺失/null/非 64 hex 一律红**（不再"没填就跳过"）；
 *      · `at` 加**契约字面量强校验**（含日历合法性）；非法/缺失记结构化违规，
 *        但**非法值不参与**时间单调比较 —— 一条 `'zzz'` 不许把其后所有合法封板永久判成 TIME_REGRESSION；
 *      · journal 末行撕裂从"补换行留成永久坏行"改为**取证(.quarantine/)→截断修复**（`repairJournalTornTail`，
 *        与 lib/ledger.js 同策略；中间坏行仍只报不修）。verify 本身**仍只读**，只报告 `tornTailRepairable`。
 *
 * @why 为什么它同时就是「sealRows 快照」：
 *   P0-4 要求「封板时另存不可变 sealRows 快照，历史校验对快照」。
 *   journal 里已经存了 rows + rowsSha256，且 append-only + fsync ——
 *   它本身就是不可变快照。再单独写一份 `seals/<gid>.json` 只会产生两份可能分叉的真相。
 *   ★ 因此：**不存在第二份快照**，校验一律以本 journal 为准。
 *
 * @why 为什么补记引用要算进 canonical（决定 D12 → D15 修订）：
 *   D12 的 canonical 只含 sourceRowCount/overflow/rows。若两组数据前 120 行相同、
 *   溢出条数也相同、只是「哪几个编码被溢出」不同，canonical 会撞车 ——
 *   封板证明就分不清哪本正册对应哪批溢出。故加入 supplementCodesSha256
 *   （只放"溢出编码集合"的摘要，不放文件路径 —— 路径可合法变动，集合不可）。
 *
 * 格式（v1，一行一个 JSON）：
 *   {
 *     v: 1,
 *     kind: 'weekly-seal' | 'handover-seal',
 *     key: <该封板对象的稳定标识：周记账=groupId，交接表=s12+代次>,
 *     gid, file, sealedAt,
 *     layoutVersion, canonicalVersion,
 *     sourceRowCount, overflow, rowCount, rowsSha256, rows: [[编码,原始凭证,hh:mm,状态], ...],
 *     supplementCodesSha256,
 *     supplement: {file, sha256, codes:[...]} | null,
 *     sealHash,
 *     prevSealSha256,   // lite：恒 ''，仅为字段兼容保留（不再是链）
 *     at: <写入时刻，YYYY-MM-DD HH:MM:SS>
 *   }
 *
 * ⚠️ 本模块**不做**业务判断（什么该封板由 weekly-seal / handover-builder 决定），
 *    只负责「写进去、读出来、算摘要」。这样两边共用同一套证据语义。
 *
 * ============================================================================
 * v1.0.0-re（SEAL-01，K-5 已签字）：追加路径从「每次整册读」改为 O(1)
 * ============================================================================
 * 旧实现 `appendSealEvent()` 用 `readSealEvents()` 做幂等检查 —— 每次追加都整读
 * journal + `JSON.parse` **全部历史事件**（含 rows 快照）。同一 tick 最多封 200 组时，
 * 单 tick 读盘/解析量 ≈ 200 × 整册，3 年 ≈174 MB journal 会击穿 30 s tick 预算并顶爆内存。
 *
 * 现改为：模块级**写侧索引**（journal 路径 → size/mtime/dev/ino + 头尾 sha 指纹 +
 * `pairKey → {off,len}` 字节定位）。稳态追加 = 1 次 stat + 1 次 Map 查 + 写 + 只读刚写行；
 * journal 被替换/缩水/指纹不符才**流式整读重建一次**；文件变长只读**增量尾区**（≤1 MiB）。
 *
 * 红线（改动必须保持）：
 *   · 落盘格式不变（一行一个 JSON、字段名/顺序/rows 快照不变）；sealHash 口径不变；
 *   · `readSealEvents()` 返回结构/顺序不变（仍是整读），只是 append 路径不再调用它；
 *   · 幂等语义不变：同一 (kind,key) 重复 append 仍返回 already-sealed（含原事件对象）；
 *   · 唯一写者假设不变：仍只有本文件写 journal，写后 fsync + 回读自检照旧。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ★ re3 K-6（审计② P2-8）：读 `.state.json` 的封板记录做**交叉判定**（"journal 被删" vs "从未封板"）。
//   只读；state 是库内缓存（弱证据），仅用于把"没得验"与"证据缺失"分开，仍不构成防篡改链。
import { readStateEx, quarantinePath } from './ledger.js';

export const SECRET_JOURNAL_VERSION = 1;
export const JOURNAL_FILE = '.seal-journal.jsonl';
/** ★ 决定 D15：canonical 版本从 7 升到 8（加入 supplementCodesSha256）；lite 不改口径 */
export const CANONICAL_VERSION = 8;

/** journal 路径：`<root>/ledger/.seal-journal.jsonl`（隐藏文件，不会被 readAll 当账行读） */
export function sealJournalPath(root) {
  return path.join(root, 'ledger', JOURNAL_FILE);
}

/** 稳定 JSON 序列化：键序固定，保证"同内容同哈希"。 */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** sha256(hex) */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 溢出编码集合的摘要。
 * @param {string[]} codes 溢出编码（顺序无关：内部排序后取摘要）
 * @returns {string} 空集合也有确定值，便于"溢出=0"与"溢出=N"可区分
 */
export function supplementCodesSha256(codes) {
  const list = Array.isArray(codes) ? codes.map(String).slice().sort() : [];
  return sha256Hex(list.join('\n'));
}

/**
 * 计算周记账封板的 canonical 串（v8）。
 *
 * ⚠️ 这是**契约公式**，改动必须同步契约文档与黑盒复算脚本；
 *    本函数是唯一实现点，别在 weekly.js 里再写一份。
 *    lite 版**保留**本函数（外部 API + 封板 hash 口径不砍），
 *    砍掉的只是"读取时逐行拿它复算"的校验路径。
 *
 * @param {object} p
 * @param {string} p.sessKey
 * @param {number} p.year
 * @param {number} p.month
 * @param {number} p.weekNo
 * @param {number} p.offsetMinutes
 * @param {number} p.sourceRowCount  源记录总数（封板前的真实行数，含溢出）
 * @param {number} p.overflow        溢出到补记册的条数
 * @param {string[][]} p.rows        正册实际写入的行（≤120）
 * @param {string[]} [p.supplementCodes] 溢出编码集合
 * @returns {string} canonical 字符串（再 sha256 即 sealHash）
 */
export function weeklyCanonical(p) {
  const rows = Array.isArray(p.rows) ? p.rows : [];
  return stableStringify({
    v: CANONICAL_VERSION,
    sessKey: String(p.sessKey || ''),
    year: p.year,
    month: p.month,
    weekNo: p.weekNo,
    offsetMinutes: p.offsetMinutes,
    sourceRowCount: p.sourceRowCount,
    overflow: p.overflow,
    rowCount: rows.length,
    rowsSha256: sha256Hex(stableStringify(rows)),
    supplementCodesSha256: supplementCodesSha256(p.supplementCodes),
    rows,
  });
}

// ============================================================================
// SEAL-01：追加路径写侧索引（模块级缓存 + 尾读；**不改变任何落盘格式/语义**）
// ============================================================================
//
// @why 为什么不能再用 readSealEvents() 做幂等检查：
//   旧实现每次追加都 `readFileSync` 整册 + `JSON.parse` 全部历史事件（含 rows 快照）。
//   同 tick 最多封 200 组时是 O(封板数 × 历史大小)；3 年 ≈174 MB journal 时读盘/解析
//   可达秒级到十秒级，且把全部 rows 快照堆进内存（审计 SEAL-01）。
//
// @how 写侧索引：
//   · 每个 journal 路径一份 `{size, mtimeMs, dev, ino, 头 256 B sha, 尾 64 B sha,
//     sealed: Map<pairKey, {off, len}>}`；`size` 是**已提交到行边界**的字节数；
//   · 幂等检查 = Map 查 O(1)；命中后按 `{off,len}` **只读那一行**返回已有事件；
//   · 缓存缺失/被替换/缩水 → **流式**整读一次重建（逐行 parse，只留 kind/key/偏移，
//     不保留 rows 快照）；之后又回到 O(1)；
//   · 文件变长 → 先核对旧内容头/尾指纹，再只读**增量尾区**（≤1 MiB）；
//     增量 > 1 MiB 或指纹不符 → 整读重建（一次性 O(N)，之后 O(1)）；
//   · 自己 append 成功后直接并入缓存（size/mtime/尾指纹按 fstat 更新），下一次 0 字节；
//   · 任何写失败/回读不一致 → **丢弃缓存**（宁可下次重建，也不基于脏索引判"已封"）。
//
// ⚠️ 并发/崩溃：仍沿用原来的 torn-tail 处理（追加前补换行 + 写后回读自检 + fsync）。
//    索引只在"整行写入 + 换行结尾 + 回读通过 + 总长对得上"后更新；journal 尾部半行
//    不会进索引（`size` 停在最后一个换行），下一次追加/刷新会重新看见并修复。
//    与 lib/weekly.js 的 W1 尾读缓存同一正确性锚：**写者唯一（本文件）+ append-only**。
//
// ============================================================================

/** 写侧索引条目上限（多数据总库/测试临时 root；每条约等于"已封组数"的内存） */
const WRITE_INDEX_MAX = 8;
/** 增量尾读上限：超过它 = 有别的写者/大批追加，直接整读重建一次（不是每次） */
const WRITE_TAIL_MAX_BYTES = 1024 * 1024;
/** 头/尾指纹字节数：与 lib/weekly.js 的 W1 尾读缓存同口径（256 B / 64 B） */
const WRITE_HEAD_BYTES = 256;
const WRITE_GUARD_BYTES = 64;
/** 整读重建的流式块大小 */
const WRITE_SCAN_CHUNK_BYTES = 256 * 1024;

/** journal 路径 → 写侧索引（模块级；进程内唯一写者，见上方说明）。 */
const WRITE_INDEX_CACHE = new Map();

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 幂等键：**保留类型**的 (kind,key) 组合。
 * @why 旧实现是 `e.kind === ev.kind && e.key === ev.key`（严格相等）。用 `typeof` 入键
 *      在正常字符串调用下完全等价；又不会让"数字 kind"这种非法输入被 String() 归一后
 *      误判成同一组（保持旧行为：它本来就不会被识别）。
 */
function sealPairKeyOf(kind, key) {
  return `${typeof kind}:${String(kind)}\u0000${typeof key}:${String(key)}`;
}

function newWriteIndex(file) {
  return {
    file,
    dev: null,
    ino: null,
    size: 0, // 已提交（解析到行边界）的字节数；≤ 文件真实大小（末尾半行不计）
    mtimeMs: -1,
    headBuf: Buffer.alloc(0),
    headSha: '',
    guardBuf: Buffer.alloc(0),
    guardSha: '',
    sealed: new Map(), // pairKey → {off,len}；**首条为准**（与 readSealEvents().find 同口径）
  };
}

/** LRU 放入/触达索引缓存（超出上限丢最旧） */
function writeIndexTouch(file, index) {
  WRITE_INDEX_CACHE.delete(file);
  WRITE_INDEX_CACHE.set(file, index);
  while (WRITE_INDEX_CACHE.size > WRITE_INDEX_MAX) {
    const oldest = WRITE_INDEX_CACHE.keys().next().value;
    if (oldest === undefined) break;
    WRITE_INDEX_CACHE.delete(oldest);
  }
}

/** 只读一小段（指纹/定位用；失败返回空 Buffer，不抛）。 */
function readRangeSync(file, start, len) {
  if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len <= 0) return Buffer.alloc(0);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return Buffer.alloc(0); }
  const buf = Buffer.alloc(len);
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖读取结果 */ }
  }
}

/** 把内存里的一段连续字节按 `\n` 切行回调（尾区增量解析用）。 */
function scanBufferLines(buf, base, onLine) {
  let lineStart = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, lineStart);
    if (nl < 0) break;
    onLine(buf.subarray(lineStart, nl), base + lineStart, true);
    lineStart = nl + 1;
  }
  if (lineStart < buf.length) onLine(buf.subarray(lineStart), base + lineStart, false);
}

/**
 * 流式扫描 journal 的 [0, limit) 字节（同步分块；峰值 ≈ 一个块 + 一条行）。
 * @param {string} file
 * @param {number} limit
 * @param {(piece:Buffer, start:number, endedWithNewline:boolean)=>void} onLine
 * @returns {{ok:boolean, bytesRead:number, error:Error|null}}
 */
function scanJournalLines(file, limit, onLine) {
  const out = { ok: false, bytesRead: 0, error: null };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { out.error = e; return out; }
  try {
    const chunk = Buffer.allocUnsafe(WRITE_SCAN_CHUNK_BYTES);
    let carry = Buffer.alloc(0); // 上一块末尾没有换行的残行
    let carryStart = 0;         // carry[0] 的绝对偏移
    let pos = 0;
    while (pos < limit) {
      const want = Math.min(WRITE_SCAN_CHUNK_BYTES, limit - pos);
      const n = fs.readSync(fd, chunk, 0, want, pos);
      if (n <= 0) break;
      const chunkStart = pos;
      pos += n;
      out.bytesRead += n;
      let lineStart = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, lineStart);
        if (nl < 0 || nl >= n) break; // 注意：nl ≥ n 是 chunk 尾巴的脏数据，不算
        if (carry.length > 0) {
          onLine(Buffer.concat([carry, chunk.subarray(lineStart, nl)]), carryStart, true);
          carry = Buffer.alloc(0);
        } else {
          onLine(chunk.subarray(lineStart, nl), chunkStart + lineStart, true);
        }
        lineStart = nl + 1;
      }
      if (lineStart < n) {
        if (carry.length > 0) {
          carry = Buffer.concat([carry, chunk.subarray(lineStart, n)]);
        } else {
          carry = Buffer.from(chunk.subarray(lineStart, n));
          carryStart = chunkStart + lineStart;
        }
      }
    }
    if (carry.length > 0) onLine(carry, carryStart, false); // 文件末尾缺换行
    out.ok = true;
    return out;
  } catch (e) {
    out.error = e;
    return out;
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖扫描结果 */ }
  }
}

/** 解析一条 journal 行文本；坏行返回 {ok:false}（与 readSealEvents 的"跳过坏行"同口径）。 */
function parseJournalLine(piece) {
  try {
    return { ok: true, value: JSON.parse(piece.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * 把一行并入写侧索引：只留 kind/key + 字节定位，**rows 快照不留在内存**。
 * @returns {boolean} JSON 是否可解析（决定"末尾无换行"的行能否被提交）
 */
function indexLineEvent(index, piece, off, len) {
  const r = parseJournalLine(piece);
  if (!r.ok) return false;
  const ev = r.value;
  if (ev && typeof ev === 'object' && !Array.isArray(ev) && ev.kind !== undefined && ev.key !== undefined) {
    const pk = sealPairKeyOf(ev.kind, ev.key);
    if (!index.sealed.has(pk)) index.sealed.set(pk, { off, len }); // 首条为准
  }
  return true;
}

/**
 * 流式整读重建写侧索引（只在首用/失效时发生一次）。
 * @returns {object|null} null = 读失败（交给旧的整读/写路径如实报错，不假装"没封板"）
 */
function rebuildWriteIndex(file, st) {
  const index = newWriteIndex(file);
  index.dev = st.dev === undefined ? null : st.dev;
  index.ino = st.ino === undefined ? null : st.ino;
  let lastCommitted = 0;
  const res = scanJournalLines(file, st.size, (piece, start, endedWithNewline) => {
    if (endedWithNewline) {
      lastCommitted = start + piece.length + 1;
      if (piece.length > 0) indexLineEvent(index, piece, start, piece.length);
    } else if (piece.length > 0 && indexLineEvent(index, piece, start, piece.length)) {
      // 末尾缺换行但 JSON 完整：readSealEvents 会把它当一条事件，这里同样收下并提交
      lastCommitted = start + piece.length;
    }
  });
  if (!res.ok) {
    if (res.error && res.error.code === 'ENOENT') return newWriteIndex(file);
    return null;
  }
  index.size = lastCommitted;
  index.mtimeMs = st.mtimeMs;
  const headLen = Math.min(index.size, WRITE_HEAD_BYTES);
  index.headBuf = headLen > 0 ? readRangeSync(file, 0, headLen) : Buffer.alloc(0);
  index.headSha = sha256Buf(index.headBuf);
  const guardLen = Math.min(index.size, WRITE_GUARD_BYTES);
  index.guardBuf = guardLen > 0 ? readRangeSync(file, index.size - guardLen, guardLen) : Buffer.alloc(0);
  index.guardSha = sha256Buf(index.guardBuf);
  return index;
}

/** 旧内容头/尾指纹是否仍一致（append-only 校验；不一致 = 改写/替换 → 重建）。 */
function writeIndexFingerprintMatches(file, index) {
  if (index.headBuf.length > 0) {
    const head = readRangeSync(file, 0, index.headBuf.length);
    if (head.length !== index.headBuf.length || sha256Buf(head) !== index.headSha) return false;
  }
  if (index.guardBuf.length > 0) {
    const guard = readRangeSync(file, index.size - index.guardBuf.length, index.guardBuf.length);
    if (guard.length !== index.guardBuf.length || sha256Buf(guard) !== index.guardSha) return false;
  }
  return true;
}

/**
 * 取/刷新写侧索引（append 路径唯一入口）。
 * @returns {object|null} null = journal 读不了（保持旧行为：继续走写路径由它如实报错）
 */
function refreshWriteIndex(root) {
  const file = sealJournalPath(root);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 新册：不缓存空索引（否则别家先写进内容会被漏掉）；下一次 append 会重建（此时文件很小）
      WRITE_INDEX_CACHE.delete(file);
      return newWriteIndex(file);
    }
    return null;
  }
  if (typeof st.isFile === 'function' && !st.isFile()) return null; // 目录/特殊文件 → 走旧整读路径如实报错

  let index = WRITE_INDEX_CACHE.get(file) || null;
  if (index) {
    const replaced = (index.dev !== null && st.dev !== undefined && index.dev !== st.dev)
      || (index.ino !== null && st.ino !== undefined && index.ino !== st.ino);
    if (!replaced && st.size === index.size) {
      if (st.mtimeMs === index.mtimeMs) {
        writeIndexTouch(file, index); // 稳态：1 次 stat + Map 查
        return index;
      }
      // 尺寸没变但 mtime 变了：头/尾指纹一致 → 视为未变；否则重建
      if (writeIndexFingerprintMatches(file, index)) {
        index.mtimeMs = st.mtimeMs;
        writeIndexTouch(file, index);
        return index;
      }
      index = null;
    } else if (!replaced && st.size > index.size) {
      // 变长：先核对旧内容未被改写，再只读增量尾区
      const deltaLen = st.size - index.size;
      if (deltaLen <= WRITE_TAIL_MAX_BYTES && writeIndexFingerprintMatches(file, index)) {
        const delta = readRangeSync(file, index.size, deltaLen);
        if (delta.length === deltaLen) {
          const oldSize = index.size;
          const fullTail = Buffer.concat([index.guardBuf, delta]);
          let lastCommitted = oldSize;
          scanBufferLines(delta, oldSize, (piece, start, endedWithNewline) => {
            if (endedWithNewline) {
              lastCommitted = start + piece.length + 1;
              if (piece.length > 0) indexLineEvent(index, piece, start, piece.length);
            } else if (piece.length > 0 && indexLineEvent(index, piece, start, piece.length)) {
              lastCommitted = start + piece.length; // 末尾完整 JSON 无换行：与 readSealEvents 同口径
            }
          });
          const pending = st.size - lastCommitted; // 末尾半行（未提交）
          const committedTail = pending > 0 ? fullTail.subarray(0, fullTail.length - pending) : fullTail;
          index.guardBuf = committedTail.length > WRITE_GUARD_BYTES
            ? Buffer.from(committedTail.subarray(committedTail.length - WRITE_GUARD_BYTES))
            : Buffer.from(committedTail);
          index.guardSha = sha256Buf(index.guardBuf);
          index.size = lastCommitted;
          index.mtimeMs = st.mtimeMs;
          index.dev = st.dev === undefined ? index.dev : st.dev;
          index.ino = st.ino === undefined ? index.ino : st.ino;
          if (index.headBuf.length < WRITE_HEAD_BYTES && st.size > 0) {
            index.headBuf = readRangeSync(file, 0, Math.min(st.size, WRITE_HEAD_BYTES));
            index.headSha = sha256Buf(index.headBuf);
          }
          writeIndexTouch(file, index);
          return index;
        }
      }
      index = null; // 增量过大 / 旧内容被改写 / 读不长 → 重建
    } else {
      index = null; // 缩水/被替换 → 重建
    }
  }

  try {
    const rebuilt = rebuildWriteIndex(file, st);
    if (!rebuilt) return null;
    writeIndexTouch(file, rebuilt);
    return rebuilt;
  } catch {
    return null;
  }
}

/** 按索引定位读回一条事件（只读那一行，不整册读）。 */
function readEventAt(file, loc) {
  if (!loc || !Number.isFinite(loc.off) || !Number.isFinite(loc.len) || loc.len <= 0) return null;
  const buf = readRangeSync(file, loc.off, loc.len);
  if (buf.length !== loc.len) return null;
  const r = parseJournalLine(buf);
  if (!r.ok) return null;
  const ev = r.value;
  return ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : null;
}

/** 极罕见兜底：索引定位失效时整读一次找已有事件（幂等红线不因性能优化而牺牲）。 */
function findSealEventWholeRead(root, kind, key) {
  const file = sealJournalPath(root);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (typeof st.isFile === 'function' && !st.isFile()) return null;
  let rebuilt = null;
  try { rebuilt = rebuildWriteIndex(file, st); } catch { rebuilt = null; }
  if (!rebuilt) return null;
  writeIndexTouch(file, rebuilt);
  const ev = readEventAt(file, rebuilt.sealed.get(sealPairKeyOf(kind, key)));
  return ev && ev.kind === kind && ev.key === key ? ev : null;
}

/** append 成功后把新事件直接并入索引（避免"自己写→自己整读"） */
function updateWriteIndexAfterAppend(file, stAfter, pairKey, lineStart, lineLen) {
  const index = WRITE_INDEX_CACHE.get(file);
  if (!index) return; // 没有可信前缀索引：不猜，下一次 append 重建
  const size = stAfter.size; // 调用方已保证"整行 + 换行结尾 + 回读通过"
  index.size = size;
  index.mtimeMs = stAfter.mtimeMs;
  if (stAfter.dev !== undefined) index.dev = stAfter.dev;
  if (stAfter.ino !== undefined) index.ino = stAfter.ino;
  if (pairKey && !index.sealed.has(pairKey)) index.sealed.set(pairKey, { off: lineStart, len: lineLen });
  const guardLen = Math.min(size, WRITE_GUARD_BYTES);
  index.guardBuf = guardLen > 0 ? readRangeSync(file, size - guardLen, guardLen) : Buffer.alloc(0);
  index.guardSha = sha256Buf(index.guardBuf);
  if (index.headBuf.length < WRITE_HEAD_BYTES && size > 0) {
    index.headBuf = readRangeSync(file, 0, Math.min(size, WRITE_HEAD_BYTES));
    index.headSha = sha256Buf(index.headBuf);
  }
  writeIndexTouch(file, index);
}

/**
 * 追加一条封板事实（幂等：同 key 已存在则返回已有记录，不重复写）。
 *
 * lite 版与旧版的差异（S-1）：
 *   · **不再**算 `prevSealSha256`（恒写 `''`，字段保留只为兼容）；
 *   · **没有**任何"链断 → 拒绝写入"的分支（抗篡改语义已砍）；
 *   · 其余一律不变：字段补齐、handover 必填校验、幂等、fsync、写后回读自检。
 *
 * ★ SEAL-01（v1.0.0-re，K-5 已签字）：幂等检查不再 `readSealEvents()` 整册读 ——
 *   走模块级写侧索引（O(1)），只在索引失效时流式整读一次重建；说明见本函数上方的 SEAL-01 块。
 *   返回结构与旧版逐字段一致；命中仍是 `{ok:true, written:false, reason:'already-sealed', event}`。
 *
 * @param {string} root 数据总库根
 * @param {object} ev 封板记录（缺省字段由本函数补齐/校验）
 * @returns {{ok:boolean, written:boolean, reason?:string, event?:object, headSha?:string}}
 */
export function appendSealEvent(root, ev) {
  if (!root || !ev || !ev.kind || !ev.key) return { ok: false, written: false, reason: 'bad-args' };

  const file = sealJournalPath(root);
  const pairKey = sealPairKeyOf(ev.kind, ev.key);
  let index = null;
  try { index = refreshWriteIndex(root); } catch { index = null; }
  if (index) {
    // ★ SEAL-01：稳态只查 Map；命中后只读那一条事件的字节（不整册读）
    const loc = index.sealed.get(pairKey);
    if (loc) {
      const hit = readEventAt(file, loc);
      if (hit && hit.kind === ev.kind && hit.key === ev.key) {
        return { ok: true, written: false, reason: 'already-sealed', event: hit };
      }
      // 索引定位读失败/失配（文件在检查窗口内被替换等）：作废缓存，整读兜底
      WRITE_INDEX_CACHE.delete(file);
      const fallback = findSealEventWholeRead(root, ev.kind, ev.key);
      if (fallback) return { ok: true, written: false, reason: 'already-sealed', event: fallback };
    }
  } else {
    // 读侧不可用（journal 路径是目录/读失败）：保持旧行为 —— 整读一次，读不出再走写路径
    const existing = readSealEvents(root);
    const hit = existing.events.find((e) => e && e.kind === ev.kind && e.key === ev.key);
    if (hit) return { ok: true, written: false, reason: 'already-sealed', event: hit };
  }

  const rows = Array.isArray(ev.rows) ? ev.rows : null;
  const isHandover = String(ev.kind) === 'handover-seal';
  const codes = ev.supplementCodes || (ev.supplement && ev.supplement.codes);
  const event = {
    v: SECRET_JOURNAL_VERSION,
    kind: String(ev.kind),
    key: String(ev.key),
    gid: ev.gid === undefined ? null : ev.gid,
    file: ev.file === undefined ? null : ev.file,
    sealedAt: normalizeStamp(ev.sealedAt),
    layoutVersion: ev.layoutVersion === undefined ? null : ev.layoutVersion,
    canonicalVersion: ev.canonicalVersion === undefined ? CANONICAL_VERSION : ev.canonicalVersion,
    // ★ 交接表事件：rows 相关字段一律 null（D12 要求），不能写 sha256('') 冒充"有快照"
    sourceRowCount: isHandover ? null : (ev.sourceRowCount === undefined ? null : ev.sourceRowCount),
    overflow: isHandover ? null : (ev.overflow === undefined ? null : ev.overflow),
    rowCount: rows ? rows.length : (isHandover ? null : (ev.rowCount === undefined ? null : ev.rowCount)),
    rowsSha256: rows ? sha256Hex(stableStringify(rows)) : (isHandover ? null : (ev.rowsSha256 || null)),
    rows,
    supplementCodesSha256: isHandover ? null : supplementCodesSha256(codes),
    supplement: ev.supplement || null,
    sealHash: ev.sealHash || null,
    // lite（S-1）：链已砍 —— 不再读 headSha、不再算前序摘要；字段恒 '' 仅为外部兼容保留。
    prevSealSha256: '',
    at: ev.at ? normalizeStamp(ev.at) : nowIso(ev.offsetMinutes),
  };
  // ★ 交接表（handover-seal）专有字段必须透传：D12 要求这 5 个扁平字段落盘，
  //   否则 selfheal/reconcile 只能看到"封过板"，看不到"封的是哪个文件、是不是认领的"。
  //   ★ R-07：其中 decision/main/appendix **必填非空** —— 缺了宁可不写，
  //   也不许落一条"看起来封过板、其实不知道封了哪个文件"的半事件。
  if (isHandover) {
    for (const k of ['decision', 'main', 'appendix', 'adopted', 'reopened']) {
      if (ev[k] !== undefined) event[k] = ev[k];
    }
    for (const k of ['decision', 'main', 'appendix']) {
      if (event[k] === undefined || event[k] === null || String(event[k]).trim() === '') {
        return { ok: false, written: false, reason: 'handover-fields-missing:' + k };
      }
    }
  }
  // 自检：有 rows 却没给 sealHash 时，用 canonical 公式补算（周账专属；交接表由调用方给）。
  // ★ 这是"封板那一刻算一次 hash"，不是读侧复算；lite 保留，避免调用方少传字段就丢封板指纹。
  if (!event.sealHash && event.kind === 'weekly-seal' && rows) {
    event.sealHash = sha256Hex(weeklyCanonical({
      sessKey: ev.sessKey, year: ev.year, month: ev.month, weekNo: ev.weekNo,
      offsetMinutes: ev.offsetMinutes, sourceRowCount: event.sourceRowCount,
      overflow: event.overflow, rows, supplementCodes: ev.supplementCodes || (ev.supplement && ev.supplement.codes),
    }));
  }

  // ★ re3 K-6（审计② P2-10）：真正要写之前，先把"末行撕裂"修好 ——
  //   先取证到 `.quarantine/` 再截断（与 lib/ledger.js 同策略）；三条硬条件缺一不修，
  //   中间坏行保持"报红不修"。修复失败**不阻塞写入**：退回旧的"追加前补换行"策略，
  //   绝不让半行与新行粘成一条坏 JSON。只在**真的要写**时修（幂等命中路径一个字节都不许动）。
  let tornTailRepaired = null;
  try {
    const rep = repairJournalTornTail(root);
    if (rep && rep.repaired) {
      tornTailRepaired = rep.record;
      WRITE_INDEX_CACHE.delete(file); // 册子被截过：索引必须作废，下一次重建
    }
  } catch { /* 修复失败：继续走写路径（打开后会补换行，保证不粘连） */ }

  const line = JSON.stringify(event) + '\n';
  const lineBuf = Buffer.from(line, 'utf8');
  const storedKey = sealPairKeyOf(event.kind, event.key); // 落盘后的 (kind,key)（字符串，与旧严格相等同口径）
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ★ 审计 #4（2026-11-09，已实证）：必须用 `a+`（能读回）而不是 `a`，且追加前要补尾行换行。
    //   上次若崩在"写一行写到一半"，文件末尾就没有换行；直接 append 会和半行粘成一条
    //   不可解析的 JSON —— 之后整本 journal 永久 badLine，那条封板**永久不可读**，没有自愈路径。
    //   同理，写成功 ≠ 可读：写完必须回读最后一行，确认它就是这条事件。
    const fd = fs.openSync(file, 'a+');
    try {
      const st0 = fs.fstatSync(fd);
      let pad = 0;
      if (st0.size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, st0.size - 1);
        if (last[0] !== 0x0a) pad = fs.writeSync(fd, '\n', null, 'utf8') || 0;
      }
      const lineStart = st0.size + (pad > 0 ? pad : 0); // 本行在文件中的起始偏移（索引定位用）
      const wrote = fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd); // 证据必须落地，不能只到页缓存

      // 写后回读自检：最后一行必须**逐字**等于刚写的那一行。
      // （不比对 sealHash：交接表事件允许 sealHash 为空，比字符串更严格且不依赖字段。）
      const stAfter = fs.fstatSync(fd);
      const sizeAfter = stAfter.size;
      const take = Math.min(lineBuf.length + 1, sizeAfter);
      const backBuf = Buffer.alloc(take);
      fs.readSync(fd, backBuf, 0, take, sizeAfter - take);
      const backText = backBuf.toString('utf8');
      if (!backText.endsWith(line)) {
        WRITE_INDEX_CACHE.delete(file); // 索引不可信：宁可下次整读重建，也不基于脏索引判"已封"
        return {
          ok: false, written: false,
          reason: 'journal-readback-mismatch: 写入后回读最后一行与待写内容不一致（疑似半行/磁盘故障）',
        };
      }
      // ★ SEAL-01：只有"整行写入 + 总长对得上"才把新事件并入索引；
      //   长度对不上 = 期间有别的写者插队 → 丢缓存，下次整读重建（不改写任何字节）。
      if (wrote === lineBuf.length && sizeAfter === lineStart + wrote) {
        updateWriteIndexAfterAppend(file, stAfter, storedKey, lineStart, wrote);
      } else {
        WRITE_INDEX_CACHE.delete(file);
      }
    } finally {
      fs.closeSync(fd);
    }
    const headSha = sha256Hex(line.trim());
    return { ok: true, written: true, event, headSha, ...(tornTailRepaired ? { tornTailRepaired } : {}) };
  } catch (e) {
    WRITE_INDEX_CACHE.delete(file); // 写失败（可能留下半行）：索引作废，下次按 torn-tail 重建
    return { ok: false, written: false, reason: e.message };
  }
}

/**
 * 读全部封板记录（lite：只解析，不做任何链校验）。
 *
 * 坏行策略（写进契约）：
 *   · **跳过坏行、计入 `badLines`、不抛**。坏行可能来自上次写崩留下的半行，
 *     也可能来自人工改坏；lite 不再判定"是谁改的"，只保证"损失看得见"。
 *   · `readError` 非空 = 文件读失败（与"空册"区分）；`chainBroken` 恒 0，仅为兼容保留。
 *
 * @param {string} root
 * @returns {{events:object[], badLines:number, readError:string, headSha:string, chainBroken:number}}
 */
export function readSealEvents(root) {
  const file = sealJournalPath(root);
  // lite（S-1）：链已砍。chainBroken 恒 0 —— 字段仅为外部返回结构兼容保留。
  const out = { events: [], badLines: 0, readError: '', headSha: '', chainBroken: 0 };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out; // 真的没有：空册，不是错误
    out.readError = e.message;
    return out;
  }

  let lastLine = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.events.push(JSON.parse(line));
    } catch {
      out.badLines++; // 跳过并计数，绝不因为一行坏就整册不可读
      continue;
    }
    lastLine = line;
  }
  // lite：headSha 只是"末行内容的 sha256"，供追溯定位；**不再**被任何前序勾连使用。
  out.headSha = lastLine ? sha256Hex(lastLine) : '';
  return out;
}

/** 取某个 key 的最新封板记录（找不到返回 null）。 */
export function latestSealEvent(root, kind, key) {
  const r = readSealEvents(root);
  for (let i = r.events.length - 1; i >= 0; i--) {
    const e = r.events[i];
    if (e && e.kind === kind && e.key === key) return e;
  }
  return null;
}

// ============================================================================
// 五、v1.0.0-re3（审计② P2-8 / P2-9 / P2-10，K-6）：可校验性加固
//   ① 契约时间字面量强校验（at）—— 非法值不得污染时间单调比较的基准；
//   ② `.state.json` 封板记录只读交叉判定 —— "journal 被删"与"从未封板"必须可分；
//   ③ 末行撕裂（torn tail）：取证到库内 `.quarantine/` 后截断修复（与 lib/ledger.js 同策略）。
// ============================================================================

/** 契约时间字面量（D9）：`YYYY-MM-DD HH:MM:SS`。 */
const CONTRACT_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * 是否为契约时间字面量（含日历合法性：`2026-02-30` 之类判非法）。
 *
 * @why P2-10：旧实现只做字符串比较 —— 一条 `at:'zzz'` 比任何合法时间都"大"，
 *      于是它**之后的所有合法封板**都会被判 TIME_REGRESSION，且永远恢复不了。
 *      先做格式校验、且只让合法值参与比较，才能把"一条坏值"与"后续都坏"分开。
 */
export function isContractStamp(v) {
  if (typeof v !== 'string') return false;
  const m = CONTRACT_STAMP_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** `.state.json` 里两类封板记录字段（与 ledger.js / weekly.js / handover.js 同口径）。 */
const STATE_SEAL_FIELDS = ['weeklySealed', 'handoverSealed'];

/**
 * **只读**取 `<root>/ledger/.state.json` 里的封板记录键（`kind\0key` 形式）。
 *
 * @why P2-8：journal 是唯一权威；但它被整本删掉时，"文件不存在"既可能是"从未封板"
 *      也可能是"封过板但 journal 被删"。state 是库内缓存（弱证据），可用它把这两种形态分开 ——
 *      有 state 记录却没了 journal，必须判红，不许两种形态给同一种绿。
 * @returns {{readable:boolean, exists:boolean, keys:string[], error:string}}
 */
function readStateSealKeys(root) {
  const out = { readable: true, exists: false, keys: [], error: '' };
  try {
    const r = readStateEx(root);
    out.exists = r.exists === true;
    if (r.ok !== true) {
      out.readable = false;
      out.error = (r.error && r.error.message) || 'state 读不出';
      return out;
    }
    const st = r.state && typeof r.state === 'object' ? r.state : {};
    for (const field of STATE_SEAL_FIELDS) {
      const m = st[field];
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      const kind = field === 'weeklySealed' ? 'weekly-seal' : 'handover-seal';
      for (const k of Object.keys(m)) out.keys.push(kind + '\u0000' + k);
    }
    return out;
  } catch (e) {
    out.readable = false;
    out.error = (e && e.message) || String(e);
    return out;
  }
}

/** 封板 journal 撕裂尾巴的取证后缀（与普通坏行区分，审计一眼可认）。 */
const JOURNAL_TORN_EVIDENCE_SUFFIX = '.torn.json';

/**
 * 判定并（在三条硬条件全满足时）修复封板 journal 的「崩溃撕裂尾巴」。
 *
 * @why P2-10：kill -9/断电落在 append 的 write 中途时，journal 末行是**半行 JSON 且无结尾换行**。
 *      旧实现只在下次 append 前**补一个换行** —— 半行变成一条永久坏行（`badLines` 永远 ≥1），
 *      等于"损失可见但永远好不了"。本函数与 `lib/ledger.js` 的撕裂尾自愈**同策略**：
 *      先取证、再截断；修完在返回值里如实留痕，绝不静默改册。
 *
 * 三条硬条件（**缺一不修**，放宽等于允许"截掉一段账"）：
 *   ① 末行是**坏 JSON**（能解析 = 只是缺换行，append 补换行即可，不截）；
 *   ② 文件**不以 `\n` 结尾**（有结尾换行 = 完整行坏，属坏行，不修）；
 *   ③ 全册**只有这一处坏行**（中间坏行/多处坏行 = 可能是更大的损坏/篡改 → 一律不修，只报）。
 *
 * @param {string} root
 * @param {{nowMs?:number, offsetMinutes?:number}} [opts]
 * @returns {{ok:boolean, repaired:boolean, reason:string,
 *            record?:{file:string,line:number,bytes:number,sha256:string,at:string,offset:number,evidence:string}}}
 *   取证失败/证据冲突/截断失败 → `repaired:false` 且 `ok:false`（如实报"没修好"，不假装）。
 */
export function repairJournalTornTail(root, opts = {}) {
  const file = sealJournalPath(root);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, repaired: false, reason: 'no-journal' };
    return { ok: false, repaired: false, reason: 'stat-failed:' + ((e && e.code) || '') };
  }
  if (typeof st.isFile === 'function' && !st.isFile()) return { ok: false, repaired: false, reason: 'not-a-file' };
  if (st.size === 0) return { ok: true, repaired: false, reason: 'empty' };

  // 条件②：文件必须以"非换行"结尾（有结尾换行 = 完整行坏 → 不修）。
  const lastByte = readRangeSync(file, st.size - 1, 1);
  if (lastByte.length !== 1 || lastByte[0] === 0x0a) return { ok: true, repaired: false, reason: 'ends-with-newline' };

  // 一次流式扫描：坏行计数 + 末行定位（**不为修尾巴而整册进内存**）。
  let badLines = 0;
  let lineNo = 0;
  let last = null; // {piece, start}
  const scan = scanJournalLines(file, st.size, (piece, start, endedWithNewline) => {
    lineNo += 1;
    if (!endedWithNewline) last = { piece, start };
    if (piece.length === 0) return; // 空行不计坏行（与 readSealEvents 同口径）
    if (!parseJournalLine(piece).ok) badLines += 1;
  });
  if (!scan.ok) return { ok: false, repaired: false, reason: 'scan-failed:' + ((scan.error && scan.error.code) || '') };
  if (!last) return { ok: true, repaired: false, reason: 'no-tail' };

  // 条件①：末行必须是坏 JSON（能解析 = 只缺换行，不截断）。
  if (parseJournalLine(last.piece).ok) return { ok: true, repaired: false, reason: 'tail-parses' };
  // 条件③：全册只有这一处坏行。
  if (badLines !== 1) return { ok: true, repaired: false, reason: 'not-only-tail-bad:' + badLines };

  const tailBuf = last.piece;
  const tailOffset = last.start; // 末行在文件中的字节起点
  const tailSha256 = sha256Buf(tailBuf);
  const entry = {
    v: 1,
    kind: 'seal-journal-torn-tail',
    at: nowIso(opts.offsetMinutes, opts.nowMs),
    journalFile: JOURNAL_FILE,
    lineNo,
    offset: tailOffset,
    bytes: tailBuf.length,
    sha256: tailSha256,
    raw: tailBuf.length > 4096 ? tailBuf.subarray(0, 4096).toString('utf8') : tailBuf.toString('utf8'),
    truncated: tailBuf.length > 4096,
    reason: 'crash-torn-tail',
  };

  // ① 先取证（排他创建、证据不可覆盖；同号不同 sha = 册子被换过 → 拒修）。
  const qDir = quarantinePath(root);
  const evName = `${JOURNAL_FILE}.L${lineNo}${JOURNAL_TORN_EVIDENCE_SUFFIX}`;
  const evPath = path.join(qDir, evName);
  let fd = -1;
  try {
    fs.mkdirSync(qDir, { recursive: true });
    fd = fs.openSync(evPath, 'wx');
    fs.writeSync(fd, JSON.stringify(entry) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // 旧证据还在：sha 相同 = 幂等重试（上次取证后可能没来得及截断），异 sha 拒绝修。
      try {
        const old = JSON.parse(fs.readFileSync(evPath, 'utf8'));
        if (!old || old.sha256 !== tailSha256) return { ok: false, repaired: false, reason: 'evidence-conflict' };
      } catch {
        return { ok: false, repaired: false, reason: 'evidence-unreadable' };
      }
    } else {
      return { ok: false, repaired: false, reason: 'evidence-failed:' + ((e && e.code) || '') };
    }
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖取证结果 */ } }
  }

  // ② 截断到该行起点（截断后文件以 '\n' 结尾；只有半行、没有任何完整事件时删空册，
  //    否则 verify 会把"从未完成过一次封板"误报成 JOURNAL_EMPTY（被清空））。
  try {
    if (tailOffset <= 0) {
      fs.rmSync(file, { force: true });
    } else {
      const cfd = fs.openSync(file, 'r+');
      try {
        fs.ftruncateSync(cfd, tailOffset);
        try { fs.fsyncSync(cfd); } catch { /* 截断已在页缓存生效；"是否真落盘"不做过度承诺 */ }
      } finally {
        try { fs.closeSync(cfd); } catch { /* ignore */ }
      }
    }
  } catch (e) {
    return { ok: false, repaired: false, reason: 'truncate-failed:' + ((e && e.code) || '') };
  }

  WRITE_INDEX_CACHE.delete(file); // 册子被截过：写侧索引必须作废（下次重建）
  return {
    ok: true,
    repaired: true,
    reason: 'repaired',
    record: {
      file: JOURNAL_FILE,
      line: lineNo,
      bytes: tailBuf.length,
      sha256: tailSha256,
      at: entry.at,
      offset: tailOffset,
      evidence: path.join(path.basename(qDir), evName),
    },
  };
}

/**
 * 封板 journal 的**结构性**校验（lite：没有链，只做"能自证"的那几项）。
 *
 * ★ KERNEL 标记：本文件属 K-5（封板写侧 O(1)）签字范围。v1.0.0-re3 的改动记为 **K-6**：
 *   verify 只动读侧（只读、不改落盘格式、不改 append 的 O(1) 稳态；唯一写动作在
 *   `repairJournalTornTail`，且只由写路径 appendSealEvent 触发）。新增 state 只读交叉判定。
 *
 * ★ P1-01（准入审计 P1-01 · 机主裁定 V1.0 前解决）：旧实现在这里**恒返回 ok:true**
 *   （删空/伪造追加都通过），等于把一个"没有任何校验"的函数说成"校验器"。
 *   本版改为如实的三态语义，并把能力边界写死在这里。
 *
 * ★ v1.0.0-re3（审计② P2-8/P2-9/P2-10 · K-6）：把"可校验性"补到名实相符 ——
 *
 * **能发现（可自证的结构性破坏）**
 *   · 坏行：某行不是合法 JSON（`UNPARSABLE`）；
 *   · 重复行：(kind,key) 出现两次（`DUPLICATE_KEY`）或整行逐字节重复（`DUPLICATE_LINE`）
 *     —— 唯一写者 `appendSealEvent()` 天然幂等，绝不可能写出第二条；
 *   · 时间回退：`at` 不是单调不减（`TIME_REGRESSION`）；
 *     `at` **缺失**（`AT_MISSING`）或**不是契约字面量**（`AT_INVALID`，含 `2026-02-30` 这种日历非法）
 *     —— 且非法值**不参与**比较，一条 `'zzz'` 不会把其后所有合法封板判成回退；
 *   · 快照被改：weekly-seal 的 `rowsSha256` 与 rows 复算不一致（`ROWS_SHA_MISMATCH`）；
 *     `rowsSha256` **缺失/null**（`ROWS_SHA_MISSING`）或**非 64 位小写 hex**（`ROWS_SHA_INVALID`）
 *     —— 旧实现"没填就跳过"，等于缺失即静默通过（P2-9）；
 *     weekly-seal 声明了 rowCount 却没有 rows 快照（`MISSING_ROWS_SNAPSHOT`）；
 *   · 未知 kind（`UNKNOWN_KIND`）；
 *   · **journal 整本被删但 state 记着已封板**（`JOURNAL_MISSING_BUT_STATE_SEALED`，"封过板"≠"从未封板"）；
 *   · **state 记着某键已封板、journal 里却没这一行**（`STATE_SEALED_BUT_JOURNAL_MISSING_KEY`）
 *     —— 整行删除里"state 仍留着记录"的那一种，可判；
 *   · 末行撕裂可修性（只读提示 `tornTailRepairable:true`；**本函数不修**，修复在写路径
 *     `repairJournalTornTail()`：先取证到 `.quarantine/` 再截断）。
 *
 * **发现不了（必须由调用方/文档如实说明，不许冒充"防篡改"）**
 *   · 中段/尾段**整行删除**：没有库外锚时信息上不可判（state 也一起删/一起清时无从知道）；
 *   · **全本重写**：有写权限者可把 hash 一并重算 —— 同权限下拦不住自己（S-6 否决零信任层）；
 *   · 文件被整体删除且 state 也没有记录：只能看到"没有 journal"（`no-journal`），不能断言"从未封过板"。
 *
 * @why 空文件 ≠ 没 journal：journal **只在第一次封板时创建**。文件存在但 0 条可解析事件
 *      = 被清空或写崩 —— 这是红灯（`JOURNAL_EMPTY`）。文件不存在且 state 也没有封板记录
 *      = 还没封过板（ok，但 `verifiable:false` 并写明"没有可校验对象"），**绝不把"没得验"说成"验过了"**。
 *      文件不存在但 state 记着已封板 = 证据缺失 → 红灯（`JOURNAL_MISSING_BUT_STATE_SEALED`）。
 *
 * 返回结构与旧版字段兼容（`ok/events/chainBroken/badLines/readError`），并新增只读字段：
 *   `verifiable`（是否有可校验对象）、`violations[]`（可定位到行）、`reason`（一句话口径）、
 *   `journalExists/journalBytes`（"文件没了"与"从没建过"可区分）、
 *   `tornTailRepairable`（末行撕裂、可在写路径修）、
 *   `stateReadable/stateSealedCount/stateOnlyKeys`（与 state 交叉核对的结论，只读）。
 *
 * @returns {{ok:boolean, verifiable:boolean, events:number, chainBroken:number,
 *            badLines:number, readError:string, violations:Array, reason:string,
 *            journalExists:boolean, journalBytes:number, tornTailRepairable:boolean,
 *            stateReadable:boolean, stateSealedCount:number, stateOnlyKeys:Array}}
 */
export function verifySealChain(root) {
  const out = {
    ok: true,
    verifiable: false,
    events: 0,
    // ★ 语义变更（v1.0.0-re2）：chainBroken 从"恒 0 的兼容字段"改为**结构性违规条数**。
    //   旧调用方读到的仍是 number；reconcile 只消费 ok/events/badLines/readError，不受影响。
    chainBroken: 0,
    badLines: 0,
    readError: '',
    violations: [],
    reason: '',
    // ★ v1.0.0-re3 新增只读字段（旧调用方不读也不受影响）
    journalExists: false,
    journalBytes: 0,
    tornTailRepairable: false,
    stateReadable: true,
    stateSealedCount: 0,
    stateOnlyKeys: [],
  };
  const file = sealJournalPath(root);
  // state 交叉判定（只读；弱证据，仅用于区分"没得验"与"证据缺失"）
  const stateInfo = readStateSealKeys(root);
  out.stateReadable = stateInfo.readable;
  out.stateSealedCount = stateInfo.keys.length;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // ★ P2-8：文件不存在有三种含义，不许再给同一种绿。
      out.journalExists = false;
      out.verifiable = false;
      if (stateInfo.keys.length > 0) {
        out.ok = false;
        out.violations.push({
          line: 0,
          reason: 'JOURNAL_MISSING_BUT_STATE_SEALED',
          expected: 'journal 至少 ' + stateInfo.keys.length + ' 条封板事件（state 记着）',
          actual: 'journal 文件不存在',
        });
        out.chainBroken = out.violations.length;
        out.reason = 'journal-missing: state 记录了 ' + stateInfo.keys.length +
          ' 个已封板键，但 journal 文件不存在（疑似被删/移走；不等于"从未封板"）';
      } else if (!stateInfo.readable) {
        out.reason = 'no-journal: 没有 journal，且 state 读不出（无法排除"封过板但 journal 被删"；未验）';
      } else {
        out.reason = 'no-journal: 既没有 journal、state 也没有封板记录（=从未封板，没有可校验对象；不等于"验过"）';
      }
      return out;
    }
    out.ok = false;
    out.verifiable = false;
    out.readError = e && e.message ? e.message : String(e);
    out.reason = 'read-error: 读不到 journal，无法校验';
    return out;
  }
  out.journalExists = true;
  out.journalBytes = Buffer.byteLength(text, 'utf8');

  const push = (line, reason, expected = '', actual = '') => {
    out.violations.push({ line, reason, expected: String(expected), actual: String(actual) });
  };
  const KNOWN_KINDS = new Set(['weekly-seal', 'handover-seal']);
  const pairSeen = new Map();   // kind\0key → 首次出现的行号
  const pairSet = new Set();    // journal 里实际出现过的 kind\0key（state 交叉核对用）
  const rawSeen = new Map();    // 原始行 → 首次出现的行号
  const rawLines = text.split('\n');
  let prevAt = '';              // 只由**合法** at 更新（P2-10：非法值不得污染基准）
  let lineNo = 0;
  let sawAnyRaw = false;
  const endsWithNewline = text.endsWith('\n');
  let lastRawText = '';
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (rawLines[i].trim()) { lastRawText = rawLines[i]; break; }
  }
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    sawAnyRaw = true;
    lineNo++;
    if (rawSeen.has(raw)) {
      push(lineNo, 'DUPLICATE_LINE', '首见于第 ' + rawSeen.get(raw) + ' 行', '重复整行');
    } else {
      rawSeen.set(raw, lineNo);
    }
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      out.badLines++;
      push(lineNo, 'UNPARSABLE', '合法 JSON', '解析失败');
      // 注意：坏行**不重置** prevAt —— 一条坏值不该成为时间基准（旧实现清空基准，反而更宽松）
      continue;
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      out.badLines++;
      push(lineNo, 'UNPARSABLE', 'JSON 对象', '非对象');
      continue;
    }
    out.events++;
    const kind = String(ev.kind || '');
    const key = String(ev.key === undefined || ev.key === null ? '' : ev.key);
    if (!KNOWN_KINDS.has(kind)) push(lineNo, 'UNKNOWN_KIND', 'weekly-seal|handover-seal', kind || '(空)');
    if (!key) push(lineNo, 'MISSING_KEY', '非空 key', '(空)');
    const pair = kind + '\u0000' + key;
    pairSet.add(pair);
    if (pairSeen.has(pair)) {
      push(lineNo, 'DUPLICATE_KEY', '首次封板见第 ' + pairSeen.get(pair) + ' 行',
        '同一 (kind,key) 被封了第二次');
    } else {
      pairSeen.set(pair, lineNo);
    }
    // ★ P2-10：`at` 契约字面量强校验（YYYY-MM-DD HH:MM:SS + 日历合法）。
    //   非法/缺失 = 结构化违规；**只有合法值**参与时间单调比较。
    const at = typeof ev.at === 'string' ? ev.at : '';
    if (!at) {
      push(lineNo, 'AT_MISSING', 'YYYY-MM-DD HH:MM:SS',
        ev.at === undefined || ev.at === null ? '(缺失)' : String(ev.at));
    } else if (!isContractStamp(at)) {
      push(lineNo, 'AT_INVALID', 'YYYY-MM-DD HH:MM:SS', at);
    } else {
      if (prevAt && at < prevAt) push(lineNo, 'TIME_REGRESSION', '>= ' + prevAt, at);
      if (at > prevAt) prevAt = at;
    }
    // ★ P2-9：周账封板快照自洽（交接表事件 rows/rowsSha256 恒 null，按 D12 不参与）
    if (kind === 'weekly-seal') {
      const rsha = ev.rowsSha256 === undefined || ev.rowsSha256 === null ? '' : String(ev.rowsSha256);
      if (!rsha) {
        push(lineNo, 'ROWS_SHA_MISSING', '64 位小写 hex',
          ev.rowsSha256 === null ? 'null' : '(缺失)');
      } else if (!/^[0-9a-f]{64}$/.test(rsha)) {
        push(lineNo, 'ROWS_SHA_INVALID', '64 位小写 hex', rsha.slice(0, 80));
      } else if (Array.isArray(ev.rows)) {
        const expect = sha256Hex(stableStringify(ev.rows));
        if (expect !== rsha) push(lineNo, 'ROWS_SHA_MISMATCH', rsha, expect);
      }
      if (!Array.isArray(ev.rows) && Number(ev.rowCount) > 0) {
        push(lineNo, 'MISSING_ROWS_SNAPSHOT', 'rows 快照', 'null（rowCount=' + ev.rowCount + '）');
      }
    }
  }

  // ★ P2-10：末行撕裂的**只读**可修性提示（本函数不修；修复在写路径 repairJournalTornTail）。
  if (!endsWithNewline && out.badLines === 1 && lastRawText) {
    try { JSON.parse(lastRawText); } catch { out.tornTailRepairable = true; }
  }

  // ★ P2-8：state 与 journal 的**只读**交叉核对。
  //   state 记录已封板、journal 里却没有这一行 = "整行删除"里可判的那一种（state 是库内弱证据，
  //   但它比"什么都没有"多一层可观察性；不构成防篡改承诺，见函数头"发现不了"栏）。
  if (stateInfo.keys.length > 0) {
    for (const pk of stateInfo.keys) {
      if (pairSet.has(pk)) continue;
      const sep = pk.indexOf('\u0000');
      const k = sep < 0 ? pk : pk.slice(0, sep);
      const key = sep < 0 ? '' : pk.slice(sep + 1);
      out.stateOnlyKeys.push({ kind: k, key });
      push(0, 'STATE_SEALED_BUT_JOURNAL_MISSING_KEY',
        'journal 含 (' + k + ',' + key + ') 这一行', 'journal 里没有该键');
    }
  }

  out.chainBroken = out.violations.length;
  if (!sawAnyRaw) {
    // journal 文件存在却一条事件都没有 = 被清空/写崩（journal 只在首次封板时创建）。
    out.ok = false;
    out.verifiable = true;
    push(0, 'JOURNAL_EMPTY', '至少 1 条封板事件', '文件存在但 0 条');
    out.chainBroken = out.violations.length;
    out.reason = 'journal-empty: 文件存在但没有任何封板事件（疑似被清空）';
    return out;
  }
  out.verifiable = true;
  out.ok = !out.readError && out.badLines === 0 && out.violations.length === 0;
  out.reason = out.ok
    ? 'structural-ok: 结构自洽（不防整行删除/全本重写，见函数注释）'
    : 'structural-violations: ' + out.violations.slice(0, 5).map((v) => v.reason + '@L' + v.line).join(',');
  return out;
}

/** 取"某个 key 是否已封板"的快速判定（给 state 丢失后的认领用）。 */
export function isSealed(root, kind, key) {
  return !!latestSealEvent(root, kind, key);
}

/** ★ 契约时间字面量归一（D9/D12/R-08）：统一 `YYYY-MM-DD HH:MM:SS`。
 *  兼容三种历史写法：`…T…+08:00`、`…T…Z`、`… …+08:00` → 一律去掉时区后缀、T 改空格。
 *  非法/空值原样返回（由调用方决定是否接受；这里不静默编时间）。
 */
function normalizeStamp(v) {
  if (typeof v !== 'string') return v === undefined ? null : v;
  const s = v.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(s);
  if (!m) return s;
  return m[1] + ' ' + m[2];
}

/** +08:00 的文本时间串。
 * ★ D9 口径：`YYYY-MM-DD HH:MM:SS`（空格分隔、**不带**时区后缀、**不带** Z）。
 *   之前的实现写成 `...+08:00`，与契约字面不一致，黑盒按字面断言会红（交接组实测指出）。
 * ★ re3：允许注入 `nowMs`（取证留痕/测试确定性）；省略 = Date.now()。
 */
function nowIso(offsetMinutes, nowMs) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  const d = new Date(base + off * 60000);
  const iso = d.toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19);
}
