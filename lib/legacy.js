/**
 * @file legacy.js
 * @role v3 旧格式的「只读历史源」：发现会话文件、选择历史源、把 v3 纳入账。
 * @called-by index.js（替代 ledger.scanSessions）、checkup.js（可选）
 * @depends node:fs / node:path / node:zlib / node:crypto、./ledger.js（readTurnsFrom / readTurnEventsBatch）、
 *          ./frames.js（streamFrames / frameSpan —— 与生产读路径同一套结构分帧）
 *
 * @why 为什么要有这个模块：
 *   v0.4 的版本守卫只认 `session.v4.jsonl.zstd`，遇到 v3 只在日志里 warn 一次。
 *   实测（2026-11-09，压测素材 16 会话）：
 *     · v4-only 10 个、v3+v4 1 个、**v3-only 5 个**
 *     · v3-only 5 个会话共 **98 轮**，历史目前被静默挡在账外
 *     · v3 文件可被现有 readTurnsFrom 完整解析（0 失败帧 / 0 坏行）
 *   → 这不是"没有来源"，是"来源在、插件不认"。直接违反核心诉求：
 *     「我的数据会被动积累，不能主动遗忘。」
 *
 * @why 为什么 v3 只读、绝不写：
 *   v3 是旧格式，写它等于同时维护两种格式，且会破坏"历史不可变"。
 *   我们只做"读出来、落进新账"，v3 文件本身永不修改。
 *
 * @why 为什么 v3/v4 并存时一律选 v4：
 *   DSH 升级到 v4 时会把旧事件种子化进 v4（实测 session-<id>：
 *   v3 与 v4 的首个事件时间完全相同，v4 事件数 40325 > v3 2897，v4 是超集）。
 *   因此并存时选 v4 不会丢历史；v3 作为"并存资料"登记进审计清单，
 *   由 auditPairs() 逐对核验（v4 是否真超集），核验不通过时会显式报出来。
 *
 * ---------------------------------------------------------------------------
 * ★ v1.0.0-re3 修复（本文件是 C 线：解压炸弹 / 读放大）
 *
 * ① P0 CORE-02 —— 解压炸弹（原实现：`ledger.decompressMultiFrame` 里
 *    `zlib.zstdDecompressSync` 无 maxOutputLength）：
 *      probeHead() → resolvePairPrefixes() → index.js:1531 **每 tick**；
 *      一个 4,115 B 的 v3 文件能解出 134,217,728 B（128 MiB），RSS +~260 MiB，
 *      而同样文件走 frames.streamFrames 会被 64 MiB 上限拒绝 —— 同一条数据两条口径。
 *    修法（三层，全部在本文件；不碰 ledger.js）：
 *      · 不再调用无上限的 decompressMultiFrame；
 *      · 头部探测改"只读会话头/只解首帧"：先读 16 KiB（必要时逐级补读到 4 MiB 硬顶），
 *        只解第一个**结构完整**的帧（最多 4 帧），单帧解压输出上限 1 MiB（见下 @why）；
 *      · 单 tick（= 一次 resolvePairPrefixes）累计解压预算 64 MiB：
 *        每探测一帧计一次账，超预算就停（剩下的对子下一 tick 再判，不乱解）。
 *    为什么头部输出上限是 1 MiB 而不是 64 MiB（同族硬上限仍是 64 MiB）：
 *      实测真实语料 17 个文件的首帧解压后只有 201–285 B（1 行 = 会话头），
 *      1 MiB 已是 3,500× 余量；而 64 MiB 的 maxOutputLength 对 128 MiB 炸弹
 *      会先分配 64 MiB 再报错（实测 RSS +70.9 MiB），达不到"RSS 增量 <8 MiB"的验收。
 *      1 MiB 上限下同一个炸弹在**分配前**被拒（实测 RSS +1.7 MiB）。
 *      `LEGACY_MAX_DECOMPRESSED_BYTES` 仍等于 frames 的 64 MiB，用于逐帧整解路径
 *      （summarizeFile / readPrefixEvents），与 K-6 同口径。
 *
 * ② P1 RT-03 —— 读放大（稳态每 tick 重读 v3/v4 并存对的 2×256 KiB 头探测）：
 *      · 有界头缓存（LRU，默认 64 项）：key = `size:mtimeMs:头部sha256`（内容寻址），
 *        path→key 二级索引让**命中只花一次 stat、零读盘**；
 *      · 负结果（炸弹/坏帧/无头）一起缓存 —— 否则一个炸弹文件每 tick 都被重解一次；
 *      · 首次探测的读窗口从 16 KiB 起（真实首帧 ~200 B），按需逐级补读，
 *        不再一上来就 256 KiB；`bytesRead` 如实计数。
 *      · 返回值仍是 `Map<dir, v3path>`（旧契约不变），额外挂**非枚举** `stats`：
 *        `{ bytesRead, cacheHits, cacheMisses, decompressedBytes, rejected, skippedPairs, ... }`
 *        —— index 可直接读 `prefixByDir.stats.bytesRead` 计入 tick 度量（契约见报告）。
 *
 * ③ P1 CORE-01 契约 —— 可跳过帧的游标推进：由 ./frames.js（K-8）给出
 *     `skippable/frameEnd/resumeAt/nextSafeOffset/gapAdvanceable`；本文件不消费游标，
 *     但 summarizeFile/readPrefixEvents 的 loss 计数与 frames 同口径（failed 含 skipped）。
 *
 * 兼容性：本文件不 import tools/freeze，零第三方依赖；`probeHead`/`resolvePairPrefixes`
 *   的「成功路径」返回形状与语义不变（v3 起点更早 → 补前缀）。
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readTurnsFrom, readTurnEventsBatch } from './ledger.js';
import { streamFrames, frameSpan, MAX_DECOMPRESSED_BYTES } from './frames.js';

/** 会话文件名：`session.v<N>.jsonl.zstd`。 */
const SESSION_FILE_ANY = /^session\.v(\d+)\.jsonl\.zstd$/;

/** 当前主格式版本。 */
export const PRIMARY_VERSION = 4;

/** 只读兼容的旧版本（允许补历史）。 */
export const LEGACY_VERSIONS = [3];

// ============================================================================
// 〇、legacy 路径的解压/读盘边界（CORE-02 / RT-03）
// ============================================================================

/** legacy 整帧解压的硬上限：与 lib/frames.js（K-6）**同口径** 64 MiB。 */
export const LEGACY_MAX_DECOMPRESSED_BYTES = MAX_DECOMPRESSED_BYTES;

/**
 * 头部探测单帧解压输出上限（1 MiB）。
 * @why 只为了解析第一行会话头；真实语料首帧解压后 201–285 B。
 *      用 1 MiB 而不是 64 MiB：64 MiB 上限遇到 128 MiB 炸弹会先分配 64 MiB
 *      （实测 RSS +70.9 MiB），达不到"4 KB 炸弹 RSS 增量 <8 MiB"的验收；
 *      1 MiB 上限在分配前拒绝（实测 RSS +1.7 MiB）。硬上界仍是 64 MiB（上面常量）。
 */
const HEAD_MAX_OUTPUT_BYTES = 1024 * 1024;

/** 头部探测的首次读窗口（真实首帧 187–275 B，16 KiB 一次就够；按需逐级补读）。 */
const HEAD_FIRST_READ_BYTES = 16 * 1024;

/** 头部探测的读字节硬顶（帧比它还大 = 不是 DSH 会话头，拒绝）。 */
const HEAD_READ_HARD_CAP = 4 * 1024 * 1024;

/**
 * `probeHead` 的 `maxBytes` 默认值 = 读硬顶 4 MiB。
 * @why 不是旧默认 256 KiB：合成等价语料里确有 3 个 v3 文件的**首帧压缩 358 KiB**
 *      （解压 543 KB，仍 <1 MiB 输出上限）；256 KiB 读不满首帧就只能返回 null。
 *      逐级补读仍是按需的（真实语料 16 KiB 就够），只是把"上限"放到 4 MiB 硬顶。
 *      显式传 `maxBytes` 的调用方仍按显式值封顶（旧签名语义保留）。
 */
const HEAD_PROBE_MAX_BYTES = HEAD_READ_HARD_CAP;

/** 一次探测最多解几帧（防"很多小帧轮流解"；真实语料首帧即会话头）。 */
const HEAD_MAX_FRAMES = 4;

/** 头探测缓存 LRU 上限（项）。 */
const HEAD_CACHE_MAX_ENTRIES = 64;

/** 单 tick（一次 resolvePairPrefixes）累计解压预算：64 MiB；配置硬上界 256 MiB。 */
const TICK_DECOMPRESS_BUDGET_BYTES = MAX_DECOMPRESSED_BYTES;
const TICK_DECOMPRESS_HARD_LIMIT = 256 * 1024 * 1024;

/**
 * 可以安全缓存（正/负）的探测结论。
 * @why 只缓存"由文件内容决定"的结论：transient 的 read-failed / probe-failed / 预算不足
 *      （limited）一律不缓存 —— 否则一次偶发失败会被缓存成永久错误结论（直到文件变动）。
 */
const CACHEABLE_REASONS = new Set([
  'parsed', 'bad-magic', 'bad-structure', 'truncated-head-frame',
  'head-frame-too-large', 'output-too-large', 'bad-frame', 'no-session-head',
]);

/** 判断解压失败是否属于"输出超上限"（与 frames.js 同判据）。 */
function isOutputTooLarge(e) {
  if (!e) return false;
  if (e.code === 'ERR_BUFFER_TOO_LARGE') return true;
  return /maxOutputLength|larger than|too large/i.test(String(e.message || e));
}

/** 整数夹取（非整数 → 默认值）。 */
function clampInt(v, min, max, dflt) {
  if (!Number.isInteger(v)) return dflt;
  return Math.max(min, Math.min(max, v));
}

// ============================================================================
// 一、有界头缓存（LRU；key = size:mtimeMs:头部 sha256）
// ============================================================================

/**
 * @typedef {{path:string, size:number, mtimeMs:number, sha256:string,
 *            ok:boolean, reason:string, head:object|null}} HeadCacheEntry
 */

/** key（`size:mtimeMs:sha256`）→ entry。 */
const headCache = new Map();
/** path → key（命中路径：一次 stat 就能定位，不需要读文件）。 */
const headCacheByPath = new Map();
let headCacheMaxEntries = HEAD_CACHE_MAX_ENTRIES;
let headCacheEvictions = 0;
/** 最近一次 resolvePairPrefixes 的度量快照（只读副本由 getLastHeadProbeStats 给）。 */
let lastProbeStats = null;

/** 清空头探测缓存（测试/换 DSH_HOME 用；生产不需要调用）。 */
export function resetHeadProbeCache() {
  headCache.clear();
  headCacheByPath.clear();
  headCacheEvictions = 0;
  lastProbeStats = null;
}

/** 调整 LRU 上限（测试/极端环境用；0 = 关闭缓存）。 */
export function setHeadProbeCacheCaps(opts = {}) {
  if (Number.isInteger(opts.maxEntries) && opts.maxEntries >= 0) headCacheMaxEntries = opts.maxEntries;
}

/** 缓存现状（只读诊断；不含文件内容，只有 key 摘要）。 */
export function getHeadProbeCacheInfo() {
  return {
    size: headCache.size,
    maxEntries: headCacheMaxEntries,
    evictions: headCacheEvictions,
    keys: Array.from(headCache.keys()),
  };
}

/** 最近一次 resolvePairPrefixes 的度量快照（浅拷贝；无则 null）。 */
export function getLastHeadProbeStats() {
  return lastProbeStats ? { ...lastProbeStats } : null;
}

/** 按 (path, size, mtime) 查缓存：命中 = **零读盘**返回上次结论（含负结果）。 */
function headCacheLookup(filePath, st) {
  const key = headCacheByPath.get(filePath);
  if (!key) return null;
  const ent = headCache.get(key);
  if (!ent) {
    headCacheByPath.delete(filePath);
    return null;
  }
  // size+mtime 任一变化 ⇒ 旧结论作废（mtimeMs 是亚毫秒精度，文件追加/重写必变）
  if (ent.size !== st.size || ent.mtimeMs !== st.mtimeMs) return null;
  // LRU touch：Map 的插入序当访问序，删了再插 = 移到队尾
  headCache.delete(key);
  headCache.set(key, ent);
  return ent;
}

/** 写入缓存（含负结果）；key 由 size+mtime+头部 sha256 组成（内容寻址）。 */
function headCacheStore(ent) {
  const key = `${ent.size}:${ent.mtimeMs}:${ent.sha256}`;
  const prevKey = headCacheByPath.get(ent.path);
  if (prevKey && prevKey !== key) headCache.delete(prevKey);
  headCache.delete(key);
  headCache.set(key, ent);
  headCacheByPath.set(ent.path, key);
  while (headCache.size > headCacheMaxEntries) {
    const oldestKey = headCache.keys().next().value;
    const oldest = headCache.get(oldestKey);
    headCache.delete(oldestKey);
    if (oldest && headCacheByPath.get(oldest.path) === oldestKey) headCacheByPath.delete(oldest.path);
    headCacheEvictions++;
  }
}

// ============================================================================
// 二、会话头探测（只读会话头 / 只解首帧 / 有界读 + 有界解压）
// ============================================================================

/** 从一段解压文本里找会话头（形状与旧 probeHead 返回值一致）。 */
function findSessionHead(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'session' && typeof o.id === 'string') {
      return { id: o.id, createdAt: Number(o.createdAt) || 0, version: Number(o.version) || 0 };
    }
  }
  return null;
}

/**
 * 轻量探测会话头（带度量版）：id / createdAt / version。
 *
 * @param {string} filePath
 * @param {{
 *   maxBytes?:number,        // 最多读多少压缩字节（默认 4 MiB 硬顶；实读从 16 KiB 起按需补读）
 *   maxOutputBytes?:number,  // 单帧解压输出上限（默认 1 MiB，硬顶 = LEGACY_MAX_DECOMPRESSED_BYTES）
 *   maxFrames?:number,       // 最多解几帧（默认 4）
 *   cache?:boolean           // 默认 true；false = 绕过缓存（测试/强制复drill）
 * }} [opts]
 * @returns {{
 *   head:{id:string,createdAt:number,version:number}|null,
 *   ok:boolean, reason:string, cached:boolean,
 *   limited:boolean,          // true = 拒绝/止步是"本 tick 预算被压小"造成的，不是对文件的定论（不缓存）
 *   bytesRead:number, decompressedBytes:number, sha256:string,
 *   size:number, mtimeMs:number, framesExamined:number, elapsedMs:number
 * }}
 *   `reason`：parsed / cache-hit / empty-file / bad-magic / bad-structure /
 *             truncated-head-frame / head-frame-too-large / output-too-large /
 *             bad-frame / no-session-head / stat-failed / read-failed /
 *             probe-failed:* / cache-hit:<拒绝原因>
 *
 * @why 为什么不整段解压（原实现的 P0 缺陷）：
 *      v3/v4 会话头就是文件第一帧；为了几十字节的头把 256 KiB 解成 128 MiB 的炸弹正文
 *      是纯浪费 + 内存安全事故。这里只解"结构完整的第一帧"（最多 4 帧），
 *      且解压在 maxOutputLength 处**分配前**拒绝。
 * @why 为什么缓存负结果：
 *      炸弹/坏帧文件每 tick 都会被 resolvePairPrefixes 探到；不缓存负结果 = 每 tick
 *      重读 + 重试解压（虽被拒但白烧 CPU/IO）。负结果同样按 size+mtime+sha 缓存。
 */
export function probeHeadEx(filePath, opts = {}) {
  const started = Date.now();
  const out = {
    head: null, ok: false, reason: '', cached: false, limited: false,
    bytesRead: 0, decompressedBytes: 0, sha256: '',
    size: 0, mtimeMs: 0, framesExamined: 0, elapsedMs: 0,
  };
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    out.reason = 'stat-failed';
    out.elapsedMs = Date.now() - started;
    return out;
  }
  out.size = st.size;
  out.mtimeMs = st.mtimeMs;
  if (st.size <= 0) {
    out.reason = 'empty-file';
    out.elapsedMs = Date.now() - started;
    return out;
  }

  const useCache = opts.cache !== false;
  if (useCache) {
    const hit = headCacheLookup(filePath, st);
    if (hit) {
      out.cached = true;
      out.sha256 = hit.sha256;
      out.ok = hit.ok === true;
      out.reason = out.ok ? 'cache-hit' : ('cache-hit:' + (hit.reason || 'rejected'));
      out.head = hit.head ? { ...hit.head } : null;
      // ★ RT-03 验收点：命中 = 一次 stat、零读盘（bytesRead 必须为 0）
      out.elapsedMs = Date.now() - started;
      return out;
    }
  }

  const maxRead = clampInt(opts.maxBytes, 1, HEAD_READ_HARD_CAP, HEAD_PROBE_MAX_BYTES);
  const maxOut = clampInt(opts.maxOutputBytes, 1, LEGACY_MAX_DECOMPRESSED_BYTES, HEAD_MAX_OUTPUT_BYTES);
  const maxFrames = clampInt(opts.maxFrames, 1, 16, HEAD_MAX_FRAMES);

  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    let buf = Buffer.alloc(0);
    let want = Math.min(maxRead, HEAD_FIRST_READ_BYTES, st.size);
    let span = null;
    // ── ① 有界读：先 16 KiB，首帧结构不完整再逐级补读（×4），到硬顶就拒绝 ──
    for (;;) {
      if (want > buf.length) {
        const need = want - buf.length;
        const more = Buffer.allocUnsafe(need);
        let got = 0;
        while (got < need) {
          const n = fs.readSync(fd, more, got, need - got, buf.length + got);
          if (n <= 0) break;
          got += n;
        }
        out.bytesRead += got;
        if (got <= 0) { out.reason = 'read-failed'; break; }
        const chunk = got === need ? more : more.subarray(0, got);
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      }
      span = frameSpan(buf, 0);
      if (span.ok) break;
      if (span.badMagic) { out.reason = 'bad-magic'; break; }
      if (span.badBlock) { out.reason = 'bad-structure'; break; }
      if (buf.length >= st.size) { out.reason = 'truncated-head-frame'; break; }
      if (buf.length >= maxRead) { out.reason = 'head-frame-too-large'; break; }
      const next = Math.min(maxRead, st.size, Math.max(buf.length * 4, HEAD_FIRST_READ_BYTES));
      if (next <= buf.length) { out.reason = 'head-frame-too-large'; break; }
      want = next;
    }

    if (buf.length > 0) {
      // ★ 缓存 key 的"头部 sha256"：对**实际读到的头部字节**做内容指纹
      out.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    }

    // ── ② 有界解压：只解结构完整的前几帧，找会话头就停 ──
    if (span && span.ok) {
      let pos = 0;
      let frames = 0;
      while (pos < buf.length && frames < maxFrames) {
        const sp = frames === 0 ? span : frameSpan(buf, pos);
        if (!sp.ok) break;
        const allow = maxOut - out.decompressedBytes;
        if (allow <= 0) { out.reason = 'output-budget'; out.limited = true; break; }
        let raw = null;
        try {
          raw = zlib.zstdDecompressSync(buf.subarray(pos, sp.end), { maxOutputLength: allow });
        } catch (e) {
          if (isOutputTooLarge(e)) {
            // ★ 炸弹：maxOutputLength 在**分配前**拒绝（实测 1 MiB 上限 → RSS +1.7 MiB）。
            //   记"尝试上限"进预算（保守：防止"很多炸弹各试一次"把单 tick 解压量做大）。
            out.decompressedBytes += allow;
            out.reason = 'output-too-large';
            // 若上限是被"本 tick 剩余预算"压小的（< 单帧默认 1 MiB），这次拒绝**不算定论**：
            // 不写缓存（否则会把正常头误存成负结果，下一 tick 永久命中错误结论）。
            if (allow < HEAD_MAX_OUTPUT_BYTES) out.limited = true;
          } else {
            out.reason = 'bad-frame';
          }
          break;
        }
        frames++;
        out.decompressedBytes += raw.length;
        const head = findSessionHead(raw.toString('utf8'));
        if (head) {
          out.head = head;
          out.ok = true;
          out.reason = 'parsed';
          break;
        }
        pos = sp.end;
      }
      out.framesExamined = frames;
      if (!out.ok && !out.reason) out.reason = 'no-session-head';
    }
  } catch (e) {
    out.reason = 'probe-failed:' + ((e && e.code) || (e && e.message) || 'unknown');
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* 关不掉不影响结果 */ } }
  }

  // ── ③ 写缓存（成功/失败都缓存；sha256 为空说明连头部字节都没读到 → 不缓存）──
  //   例外：`limited`（被本 tick 剩余预算压小上限导致的拒绝）不缓存 —— 否则会误存负结论。
  if (useCache && out.sha256 && !out.limited && CACHEABLE_REASONS.has(out.reason)) {
    try {
      headCacheStore({
        path: filePath,
        size: out.size,
        mtimeMs: out.mtimeMs,
        sha256: out.sha256,
        ok: out.ok,
        reason: out.reason,
        head: out.head,
      });
    } catch { /* 缓存写失败不影响探测结果 */ }
  }
  out.elapsedMs = Date.now() - started;
  return out;
}

/**
 * 轻量探测会话头（兼容签名）：id / createdAt / version。
 *
 * @param {string} filePath
 * @param {number} [maxBytes] 最多读多少压缩字节（默认 4 MiB 硬顶；**实读从 16 KiB 起按需求补读**，
 *                            真实语料首帧 ~200 B → 实际只读 16 KiB；显式传值则按显式值封顶）
 * @param {object} [opts] 透传 probeHeadEx（cache/maxOutputBytes/maxFrames）
 * @returns {{id:string, createdAt:number, version:number}|null}
 *
 * @why 只读开头一小段：会话头是文件第一行；为比较 v3/v4 的起点，
 *      不需要解整份文件（38 MB 级的会话解一次会拖住扫描）。
 * @why re3 起：不再用 `decompressMultiFrame`（无上限，4 KB 可解出 128 MiB）。
 *      现在只解**首帧**、单帧输出 ≤1 MiB、累计预算由调用方（resolvePairPrefixes）统一计。
 */
export function probeHead(filePath, maxBytes = HEAD_PROBE_MAX_BYTES, opts = {}) {
  const max = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : HEAD_PROBE_MAX_BYTES;
  const r = probeHeadEx(filePath, { ...(opts || {}), maxBytes: max });
  return r.head;
}

/**
 * 对「v3 + v4 并存」的会话逐对判定：是否需要用 v3 **补前缀历史**。
 *
 * 规则（决定 7 / GL-10）：
 *   · v4 起点晚于 v3 起点 → v3 里那一段历史在 v4 里没有 ⇒ 用 v3 补前缀；
 *   · 起点相同（DSH 升级时把旧事件塞进 v4）→ v4 是超集，不需要补。
 *
 * 返回形状与旧契约一致：`Map<dir, 需要补前缀的 v3 文件路径>`（`.size/.get/.has` 照旧），
 * 另挂**非枚举** `stats`（RT-03：把真实读盘/命中/预算暴露给 index 度量）：
 *   { pairs, probes, cacheHits, cacheMisses, bytesRead, decompressedBytes, rejected,
 *     prefixHits, budgetExhausted, budgetBytes, skippedPairs:[{dir,reason}],
 *     probeErrors, cacheSizeAfter, elapsedMs }
 * 契约：index.js 可做 `const prefix = resolvePairPrefixes(pairs);
 *                     stat.probeBytes += prefix.stats.bytesRead;`
 *   —— 这行是本 tick 这些对子的**真实读盘**（命中时为 0），计入既有 readBytes/probeBytes
 *   口径后，"自报 vs 实测"才不会再差 523 KiB/tick。
 *
 * @param {Array<{dir:string,v3:string,v4:string}>} pairs scanSessionSources().pairs
 * @param {{
 *   cache?:boolean,             // 默认 true（有界头缓存）
 *   maxBytes?:number,           // 透传 probeHeadEx
 *   maxOutputBytes?:number,     // 透传 probeHeadEx（单帧头部解压输出上限）
 *   maxFrames?:number,          // 透传 probeHeadEx
 *   maxDecompressedBytes?:number // 单 tick 累计解压预算（默认 64 MiB，硬顶 256 MiB）
 * }} [opts]
 * @returns {Map<string,string> & {stats:object}}
 */
export function resolvePairPrefixes(pairs, opts = {}) {
  const out = new Map();
  const started = Date.now();
  const budget = clampInt(opts.maxDecompressedBytes, 1, TICK_DECOMPRESS_HARD_LIMIT, TICK_DECOMPRESS_BUDGET_BYTES);
  const probeBase = {
    cache: opts.cache !== false,
    maxBytes: Number.isInteger(opts.maxBytes) ? opts.maxBytes : undefined,
    maxFrames: Number.isInteger(opts.maxFrames) ? opts.maxFrames : undefined,
    maxOutputBytes: Number.isInteger(opts.maxOutputBytes) ? opts.maxOutputBytes : undefined,
  };
  const stats = {
    pairs: 0, probes: 0, cacheHits: 0, cacheMisses: 0,
    bytesRead: 0, decompressedBytes: 0,
    rejected: 0, prefixHits: 0,
    budgetExhausted: false, budgetBytes: budget,
    skippedPairs: [], probeErrors: 0, cacheSizeAfter: 0, elapsedMs: 0,
  };

  /** 探一个头：受剩余预算约束（把探测实际消耗如实记账）。 */
  const probe = (file) => {
    const remaining = budget - stats.decompressedBytes;
    if (remaining <= 0) return null;
    const allowOut = Math.min(
      Number.isInteger(probeBase.maxOutputBytes) ? probeBase.maxOutputBytes : HEAD_MAX_OUTPUT_BYTES,
      remaining,
    );
    let r;
    try {
      r = probeHeadEx(file, { ...probeBase, maxOutputBytes: allowOut });
    } catch (e) {
      stats.probeErrors++;
      stats.skippedPairs.push({ dir: '', file, reason: 'probe-error:' + ((e && e.message) || String(e)) });
      return null;
    }
    stats.probes++;
    stats.bytesRead += r.bytesRead;
    stats.decompressedBytes += r.decompressedBytes;
    if (r.cached) stats.cacheHits++;
    else stats.cacheMisses++;
    if (!r.ok) stats.rejected++;
    return r;
  };

  for (const pr of Array.isArray(pairs) ? pairs : []) {
    stats.pairs++;
    if (!pr || typeof pr.v3 !== 'string' || typeof pr.v4 !== 'string') {
      stats.skippedPairs.push({ dir: (pr && pr.dir) || '', reason: 'bad-pair' });
      continue;
    }
    if (stats.budgetExhausted || (budget - stats.decompressedBytes) <= 0) {
      stats.budgetExhausted = true;
      stats.skippedPairs.push({ dir: pr.dir, reason: 'decompress-budget' });
      continue;
    }
    try {
      const h3 = probe(pr.v3);
      if (!h3) { stats.budgetExhausted = true; stats.skippedPairs.push({ dir: pr.dir, reason: 'decompress-budget' }); continue; }
      // h3.limited = 被"本 tick 剩余预算"压小上限导致的拒绝 → 不是对文件的定论，本对子本 tick 不判
      if (h3.limited) { stats.budgetExhausted = true; stats.skippedPairs.push({ dir: pr.dir, reason: 'decompress-budget' }); continue; }
      const h4 = probe(pr.v4);
      if (!h4) { stats.budgetExhausted = true; stats.skippedPairs.push({ dir: pr.dir, reason: 'decompress-budget' }); continue; }
      if (h4.limited) { stats.budgetExhausted = true; stats.skippedPairs.push({ dir: pr.dir, reason: 'decompress-budget' }); continue; }
      if (stats.decompressedBytes >= budget) stats.budgetExhausted = true;
      if (!h3.ok || !h4.ok) continue;
      const c3 = Number(h3.head && h3.head.createdAt) || 0;
      const c4 = Number(h4.head && h4.head.createdAt) || 0;
      if (c3 > 0 && c4 > 0 && c3 < c4) {
        out.set(pr.dir, pr.v3);
        stats.prefixHits++;
      }
    } catch {
      // 单对探测失败不影响其它会话（旧契约：逐对隔离）
      stats.probeErrors++;
      stats.skippedPairs.push({ dir: pr.dir, reason: 'pair-failed' });
    }
  }

  stats.cacheSizeAfter = headCache.size;
  stats.elapsedMs = Date.now() - started;
  lastProbeStats = stats;
  // 非枚举挂载：不改变旧调用方对 Map 的判等/枚举行为（assert.deepEqual(Map) 仍按 entries 比较）。
  try {
    Object.defineProperty(out, 'stats', {
      value: stats, enumerable: false, configurable: true, writable: false,
    });
  } catch { /* 极端环境不可扩展：旧契约照常返回 */ }
  return out;
}

// ============================================================================
// 三、扫描与历史源选择（形状与旧 scanSessions 兼容）
// ============================================================================

/**
 * 递归找会话文件，按会话目录归组，并选出"历史源"。
 *
 * @param {string} sessionsBase 形如 `<DSH_HOME>/sessions`
 * @param {{maxDepth?:number}} [opts]
 * @returns {{
 *   supported: Array<{path:string, sid:string, s12:string, mtimeMs:number, size:number,
 *                     version:number, source:'v4'|'v3', dir:string}>,
 *   pairs: Array<{dir:string, v3:string, v4:string, note:string}>,
 *   unsupported: Array<{path:string, version:number, dir:string}>
 * }}
 *   `supported` 与旧 `scanSessions` 的返回值形状兼容（多两个字段），可直接替换。
 */
export function scanSessionSources(sessionsBase, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 6;
  const supported = [];
  const pairs = [];
  const unsupported = [];

  if (!fs.existsSync(sessionsBase)) return { supported, pairs, unsupported };

  const seenDirs = new Set();

  (function walk(dir, depth) {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      const m = SESSION_FILE_ANY.exec(e.name);
      if (!m) continue;

      const sessDir = path.dirname(p);
      if (seenDirs.has(sessDir)) {
        // 同一目录第二个版本文件：不重复处理，统一在下面按目录一次性归组
        continue;
      }
      seenDirs.add(sessDir);

      const versions = new Map();
      for (const f of fs.readdirSync(sessDir)) {
        const mm = SESSION_FILE_ANY.exec(f);
        if (mm) versions.set(Number(mm[1]), path.join(sessDir, f));
      }

      const dirName = path.basename(sessDir);
      const v4 = versions.get(PRIMARY_VERSION);
      const v3 = versions.get(3);

      const mk = (file, version, source) => {
        let st = null;
        try { st = fs.statSync(file); } catch { st = { mtimeMs: 0, size: 0 }; }
        return {
          path: file,
          sid: dirName.startsWith('session-') ? dirName : '',
          s12: '',
          mtimeMs: st.mtimeMs,
          size: st.size,
          version,
          source,
          dir: sessDir,
        };
      };

      if (v4) {
        supported.push(mk(v4, PRIMARY_VERSION, 'v4'));
        if (v3) {
          pairs.push({
            dir: sessDir,
            v3,
            v4,
            note: 'v3 与 v4 并存：按「v4 优先」纳入 v4；v3 只作并存资料，由 auditPairs() 核验是否超集',
          });
        }
      } else if (v3) {
        supported.push(mk(v3, 3, 'v3'));
      }

      for (const [ver, file] of versions) {
        if (ver === PRIMARY_VERSION) continue;
        if (ver === 3) continue; // v3：要么已作为 legacy 源纳入，要么已登记进 pairs
        unsupported.push({ path: file, version: ver, dir: sessDir });
      }
    }
  })(sessionsBase, 0);

  return { supported, pairs, unsupported };
}

/**
 * 读一个历史源的轮次边界（v3 / v4 同构，统一走 ledger.readTurnsFrom）。
 * @param {{path:string}} entry scanSessionSources() 的元素
 * @param {object} [opts] 透传给 readTurnsFrom
 */
export function readSourceTurns(entry, opts = {}) {
  return readTurnsFrom(entry.path, opts);
}

/**
 * 读某个历史源里指定轮次的事件（原文渲染用）。
 * @param {{path:string}} entry
 * @param {Set<number>|number[]} turnSet
 */
export function readSourceTurnEvents(entry, turnSet) {
  return readTurnEventsBatch(entry.path, turnSet);
}

/** 写进台账记录的 `src` 字段名（可审计：这一行是从哪种格式来的）。 */
export function sourceFileName(entry) {
  return `session.v${entry.version || 4}.jsonl.zstd`;
}

/**
 * 逐对核验「v3 与 v4 并存」的会话：v4 是否真是 v3 的超集。
 *
 * @why 这是"并存时一律选 v4"这个决定的**唯一证据来源**。
 *      核验不通过（v3 更早或 v3 有 v4 没有的轮次）→ 必须显式报出来，
 *      由人工决定是否补历史；绝不静默丢弃。
 *
 * @param {Array<{dir:string,v3:string,v4:string}>} pairs
 * @returns {Array<{dir:string, sid:string, ok:boolean, reason:string,
 *                  v3:{lines:number,events:number,failed:number,firstMs:number|null,lastMs:number|null},
 *                  v4:{lines:number,events:number,failed:number,firstMs:number|null,lastMs:number|null}}>}
 */
export function auditPairs(pairs) {
  const out = [];
  for (const pr of pairs || []) {
    const v3 = summarizeFile(pr.v3);
    const v4 = summarizeFile(pr.v4);
    let ok = true;
    let reason = 'v4 覆盖 v3（事件数 ≥ 且起点 ≤）';
    if (v3.firstMs !== null && (v4.firstMs === null || v4.firstMs > v3.firstMs)) {
      ok = false;
      reason = 'v3 起点更早：v4 可能缺前缀历史';
    } else if (v3.events > v4.events) {
      ok = false;
      reason = 'v3 事件数多于 v4：v4 可能不是超集';
    }
    if (v3.failed > 0 || v4.failed > 0) {
      ok = false;
      reason = (reason === 'v4 覆盖 v3（事件数 ≥ 且起点 ≤）' ? '' : reason + '；') +
        `无法完全解析（v3 failed=${v3.failed} / v4 failed=${v4.failed}）`;
    }
    out.push({ dir: pr.dir, sid: path.basename(pr.dir), ok, reason, v3, v4 });
  }
  return out;
}

/**
 * 解一份会话文件，返回行数/事件数/起止时间/坏帧数（只用于离线核验，不进扫描循环）。
 *
 * @why re3 起改走 `frames.streamFrames`（结构分帧 + 64 MiB/帧解压上限）：
 *      旧实现的 `decompressMultiFrame` 用"扫魔数"分帧且**解压无上限**，
 *      一份 4 KB 的炸弹就能把离线核验进程顶爆（CORE-02 同源缺陷）。
 *      现在逐帧流式解析，不拼整份文本，内存 = 单帧窗口 + 计数器。
 *
 * @returns {{lines:number, events:number, failed:number,
 *            firstMs:number|null, lastMs:number|null, oversizedDecompressed:number}}
 */
export function summarizeFile(file) {
  const res = { lines: 0, events: 0, failed: 0, firstMs: null, lastMs: null, oversizedDecompressed: 0 };
  try {
    const stats = streamFrames(file, 0, (text) => {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        res.lines++;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o && o.type === 'session') continue;
        res.events++;
        if (typeof o.time === 'number') {
          if (res.firstMs === null || o.time < res.firstMs) res.firstMs = o.time;
          if (res.lastMs === null || o.time > res.lastMs) res.lastMs = o.time;
        }
      }
    }, { maxDecompressedBytes: LEGACY_MAX_DECOMPRESSED_BYTES });
    res.failed = stats.failed;
    res.oversizedDecompressed = stats.oversizedDecompressed || 0;
  } catch {
    // 读不到 → 返回空计数（旧行为：不抛，由调用方按"无法解析"处理）
  }
  return res;
}

/**
 * 读会话文件**开头一段**事件（用于交接表「接管前上下文」）。
 *
 * @why 为什么不直接 readSessionFrom 整份：
 *      「接管前上下文」= 第一条 turn/start 之前的事件，通常只有几十条；
 *      而会话文件可达 38 MB。为了几十条事件把整份文件解压进内存不值得 ——
 *      首装时对所有历史会话各做一次，会把宿主拖死。
 *
 * @why re3 起改用 frames.streamFrames（结构分帧 + 64 MiB/帧解压上限）：
 *      旧实现在内存里 `decompressMultiFrame`（无上限）；现在逐帧流式解析，
 *      读字节与解压量都有界，且 `bytesRead` 如实上报。
 *
 * @param {string} filePath
 * @param {number} [maxBytes] 最多读多少字节（默认 2 MiB）
 * @returns {{events:object[], lines:number, badLines:number, failedFrames:number,
 *            bytesRead:number, truncated:boolean, oversizedDecompressed:number}}
 */
export function readPrefixEvents(filePath, maxBytes = 2 * 1024 * 1024) {
  const out = {
    events: [], lines: 0, badLines: 0, failedFrames: 0,
    bytesRead: 0, truncated: false, oversizedDecompressed: 0,
  };
  try {
    const st = fs.statSync(filePath);
    const size = st.size;
    const want = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : size;
    const limit = Math.max(0, Math.min(size, want));
    if (limit <= 0) return out;
    const stats = streamFrames(filePath, 0, (text) => {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        out.lines++;
        let o;
        try { o = JSON.parse(line); } catch { out.badLines++; continue; }
        if (o && o.type === 'session') continue;
        if (o && o.type) out.events.push(o);
      }
    }, {
      maxBytes: limit,
      windowBytes: Math.min(HEAD_PROBE_MAX_BYTES, Math.max(64 * 1024, limit)),
      maxDecompressedBytes: LEGACY_MAX_DECOMPRESSED_BYTES,
    });
    out.bytesRead = stats.bytesRead;
    out.failedFrames = stats.failed;
    out.oversizedDecompressed = stats.oversizedDecompressed || 0;
    // 旧口径 truncated = "没读到文件尾"；预算停在帧边界同样算截断（下一段没读）。
    out.truncated = stats.stopped === true || stats.size > limit;
  } catch {
    // 读不到前缀 → 返回空；调用方按"无接管前上下文"处理，并自行告警。
  }
  return out;
}
