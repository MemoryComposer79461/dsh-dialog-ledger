/**
 * @file pending.js
 * @role 「未闭合轮次」的待核留痕 —— 审计 A-01（partial 永久不闭合）整改的配套件。
 *
 * @why 为什么需要它：
 *   v0.4 把「安静够久」的未闭合轮次直接写进台账，status='partial'。
 *   而幂等闸门是 (sid,turn)：真实 turn/end 之后到达时，该轮被判"已记过"，
 *   于是**永久停在 partial**，原文也不会更新（证凭不可覆盖）。
 *   审计实测：第二次扫描写 partial=1，补 turn/end 后第三次 written=0/skipped=1，
 *   原文字节不变，closedStatusPresent=false。
 *
 *   审计推荐的整改方案①是：未闭合轮次只写**可重建的 pending 状态**，不进入最终账行。
 *   本模块就是这个 pending 状态 —— 但刻意**不写进 .state.json**：
 *   审计 P1-9 指出 state 把"可重建缓存"与"不可丢失证据"混在一起是多项故障的共同根因。
 *   所以 pending 证据单独成册：`<root>/ledger/.pending.jsonl`（一行一轮、只追加、可复算）。
 *
 * @why 为什么用「隐藏文件 + .jsonl」：
 *   lib/ledger.js: readAll() 明确只读**非隐藏** .jsonl（`!n.startsWith('.')`），
 *   所以 .pending.jsonl 不会被当成台账行读进去；但它仍是一等证据，
 *   对账器（lib/reconcile.js）与体检可以读它、报它。
 *
 * @why 为什么要去重：
 *   每轮扫描都会看到同一批未闭合轮次。若不去重，一小时就写 60 行同样的证据，
 *   文件失去可读性、还会掩盖"到底有几个轮次没闭合"。
 *   去重键 = (会话文件, sid, turn, startMs)：同一轮同一时刻只记一次。
 *   注意 **不把 size 纳入键** —— 文件每次追加都会变，但那不代表"新的一轮未闭合"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PENDING_FILE = '.pending.jsonl';

/** pending 证据文件路径（`<root>/ledger/.pending.jsonl`）。 */
export function pendingPath(root) {
  return path.join(root, 'ledger', PENDING_FILE);
}

/** 去重键：同一轮次只留一条证据。 */
function pendingKey(r) {
  return createHash('sha256')
    .update([r.sid || '', String(r.turn), String(r.startMs || 0)].join('#'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * 进程内去重缓存：root → { size, keys:Set<string> }。
 * 文件被外部改动（size 变化）时自动重建，避免读到过期集合。
 */
const cache = new Map();

function loadKeys(root) {
  const file = pendingPath(root);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    cache.set(root, { size: 0, keys: new Set() });
    return cache.get(root).keys;
  }
  const hit = cache.get(root);
  if (hit && hit.size === size) return hit.keys;

  const keys = new Set();
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.key) keys.add(o.key);
      } catch {
        // 坏行不影响去重能力：宁可多记一条证据，不可因为一行坏了就整册不写
      }
    }
  } catch {
    // 读不到就当空册（不阻断主流程：pending 是旁证，不是账）
  }
  cache.set(root, { size, keys });
  return keys;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 毫秒 → `YYYY-MM-DDTHH:MM:SS±HH:MM`（固定偏移口径，**绝不出现 Z**）。
 *
 * @param {number} ms 毫秒时间戳
 * @param {number} offsetMinutes 时区偏移（分钟，缺省按 +08:00 口径 480）
 * @returns {string}
 *
 * @why 审计② P2-19：本文件的 `recordedAt` 原先是 `new Date().toISOString()`，
 *      产出 `…Z`（UTC）——违反"全量 +08:00、产物无 Z"的硬口径。
 *      现在 `start` 与 `recordedAt` 共用这一个实现：同一行证据里时间只有一个口径。
 *      （`offsetMinutes` 缺失时按契约默认 +08:00，不再产出 `-NaN:NaN` 这种坏值。）
 */
function isoOffset(ms, offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const d = new Date((Number(ms) || 0) + off * 60 * 1000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * 记一条「该轮尚未闭合」的 pending 证据（幂等）。
 *
 * @param {string} root 数据总库根
 * @param {object} info
 * @param {string} info.file   会话源文件绝对路径
 * @param {string} info.sid    会话 ID（原始，不归一化）
 * @param {number} info.turn   轮次号
 * @param {number} info.startMs 该轮 turn/start 的毫秒时间戳
 * @param {number} info.offsetMinutes 时区偏移（写 at 用）
 * @param {number} [info.size] 会话文件当时大小（便于人工核对，不参与去重）
 * @param {number} [info.maxBytes=0] 本册大小上限；0 = 不写
 * @returns {{ok:boolean, recorded:boolean, reason?:string}}
 */
export function recordPending(root, info) {
  const maxBytes = Number.isInteger(info && info.maxBytes) ? info.maxBytes : 0;
  if (maxBytes <= 0) return { ok: true, recorded: false, reason: 'disabled' };
  if (!root || !info || !info.sid || !Number.isInteger(info.turn)) {
    return { ok: false, recorded: false, reason: 'bad-args' };
  }

  const key = pendingKey(info);
  const keys = loadKeys(root);
  if (keys.has(key)) return { ok: true, recorded: false, reason: 'duplicate' };

  const startMs = Number(info.startMs) || Date.now();
  // 固定 +08:00 口径：不出现 Z；与台账 ts 同格式（审计② P2-19：recordedAt 也走同一实现）
  const iso = isoOffset(startMs, info.offsetMinutes);
  const recordedAt = isoOffset(Date.now(), info.offsetMinutes);

  const human = iso.replace('T', ' ').slice(0, 19); // 契约 D10：`YYYY-MM-DD HH:MM:SS`（无 T、无偏移后缀）
  const row = {
    v: 1,
    kind: 'turn-pending',
    key,
    sid: String(info.sid),
    turn: info.turn,
    startMs: Number(info.startMs) || 0,
    start: iso,
    file: String(info.file || ''),
    size: Number.isInteger(info.size) ? info.size : null,
    offsetMinutes: info.offsetMinutes,
    recordedAt,
    // ── ★ 契约 D10（INV-05/INV-10）固定字段：名字照抄契约，别自造 ──
    //   历史字段（start/file/size/recordedAt）保留不动，避免破坏老读法。
    //   firstSeenAt/lastSeenAt：本文件是**追加式且按 key 去重**，所以第一次写时两者相等；
    //   同一 (sid,turn,startMs) 再出现时走 duplicate 分支、不再追写（幂等优先）。
    firstSeenAt: human,
    lastSeenAt: human,
    source: String(info.file || ''),                                   // 源文件绝对路径原字符串
    sourceSize: Number.isInteger(info.size) ? info.size : null,
    startByte: Number.isInteger(info.startByte) ? info.startByte : null, // 该轮 turn/start 帧起点
    state: 'pending',
  };

  const file = pendingPath(root);
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const prevSize = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
    if (prevSize > maxBytes) {
      return { ok: false, recorded: false, reason: 'pending-file-full' };
    }
    const line = JSON.stringify(row) + '\n';
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    keys.add(key);
    const c = cache.get(root);
    if (c) c.size = prevSize + Buffer.byteLength(line, 'utf8');
    return { ok: true, recorded: true };
  } catch (e) {
    return { ok: false, recorded: false, reason: e.message };
  }
}

/**
 * 读回 pending 证据（给对账器/体检用；只读，不改任何文件）。
 * 坏行跳过但计数 —— 「读失败」与「没有 pending」必须能区分。
 *
 * @param {string} root
 * @returns {{records:object[], badLines:number, readError:string}}
 */
export function readPending(root) {
  const file = pendingPath(root);
  const out = { records: [], badLines: 0, readError: '' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    out.readError = e.message;
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.records.push(JSON.parse(line));
    } catch {
      out.badLines++;
    }
  }
  return out;
}
