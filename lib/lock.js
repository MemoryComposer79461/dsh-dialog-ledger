/**
 * @file lock.js
 * @role 写路径的单实例锁 —— 同一个「数据总库」同时只允许一个实例写账。
 * @called-by index.js（runOnce 开头 acquire，finally release；插件卸载时 release）
 * @depends node:fs / node:path / node:os / node:crypto / ./encoder.js（isoTime，统一 +08:00 口径）
 *
 * @why 为什么必须有锁：
 *      双实例同时跑（比如开机自启 + 手动再开一次）时，两边的"读台账 → 算编号 → 追加"
 *      是交错的：两个实例可能给同一轮分配同一个序号、写出两条不同的账，或者把
 *      `nextOffset` 互相覆盖。账只追加，写脏一次永远改不回来 —— 所以必须单实例。
 *
 * @why 为什么锁文件放 `<root>/ledger/.lock`：
 *      锁保护的是"这本账"，不是这台机器：两个实例读同一个数据总库才会冲突；
 *      读不同总库的两个实例可以同时跑。锁跟账走，才谈得上"同一本账单写者"。
 *
 * @why 为什么抢不到锁要返回 `{acquired:false, holder}` 而不是抛错：
 *      "另一个实例正在跑"是**正常状态**（开机自启与手动启动撞车），不是故障。
 *      调用方据此安静跳过本轮（不写、不报错刷屏），但把 holder 带回去供日志说明
 *      "是谁在写"。真正的 IO 故障（权限、磁盘满）仍然抛错 —— 那才是故障。
 *
 * 僵死判定（契约要求）：
 *   · 持锁者每 HEARTBEAT_INTERVAL_MS（默认 30s）更新一次 `heartbeatAt`；
 *   · 某次 acquire 读到 heartbeat 年龄 > 3×心跳间隔 → 记为一次"疑似僵死"；
 *   · **连续两轮**都读到同一份僵死心跳（心跳没被刷新的证据），才夺取；
 *   · 夺取前把旧锁 rename 成 `.lock.stale-<时间戳>-<pid>-<随机>` **留证，不删**。
 *   两轮确认防的是：进程正好在写心跳的那一瞬间被读到，误抢会变成双写者。
 *
 * 跨平台注意（Windows）：
 *   ★ 2026-11-14 第 3 轮审计**推翻了**本段原先写的一条假设，这里按事实改写（旧说法不再保留）：
 *     旧注释写"持锁期间一直开着 fd，而 Windows 上被打开的文件不能 rename，所以活着的持锁者
 *     无法被夺取，等于给僵死判定加了一道文件系统级保险" —— 实测**能 rename / unlink**：
 *     带 FILE_SHARE_DELETE 打开的文件可被改名/删除（审计用同名探针复现）。
 *   · 结论：**不存在文件系统级保险**。抢锁是否安全，完全取决于心跳判定
 *     （30s 心跳 / 3× 陈旧 / 连续两轮确认 / 夺取前 rename 留证）。
 *   · 由此留下的真实残余风险（如实登记，不粉饰）：
 *     ① 持锁者若在**长同步段**（超大会话的事件批读、周账全量重算等）里超过 3×心跳没刷新
 *        `heartbeatAt`，另一实例可合法判其僵死并夺取 → 出现短窗口双写；
 *        重复/冲突行会被 gate 的 codeUnique / sidTurnUnique 判成 `unknown`（不是 ok），
 *        且重复行可去重、冲突行有原文可回溯 —— 属"可发现、可弥补"，不是静默。
 *     ② 修复方向（排 v1.0.1 / 1.1，属 KERNEL 变更）：fencing 下沉到每行 append 前 +
 *        长同步段主动 beat() 或分片让出 + `.state.json` 写加 CAS。本版**只改这段注释，不改行为**。
 *   · 运行约束（随 05 已知未覆盖项披露）：预览版请**不要同时开两个 DSH 实例写同一个账库根**。
 *
 * ---------------------------------------------------------------------------
 * ★ K-12（v1.0.0-re3 · 审计③ ARCH-02 P0）：同进程锁失效 —— 幂等键 + fencing token。
 *
 * @why 旧实现按 root 幂等：同进程第二次 acquire(root) 直接返回**同一个 handle**。
 *      两个调用方（两个"实例"）都以为自己是唯一写者，各写各的；任一方 release 都会把
 *      另一方的锁文件删掉 —— 双写者、互删锁，账只追加，写脏不可逆。
 * @why 新口径（只改本文件，index.js 无需改）：
 *      ① 幂等键 = **(root, instanceId)**：同 root 同 instanceId 才幂等返回同一 handle；
 *         不同 instanceId 的第二次 acquire 返回 `{acquired:false, code:'LOCK_HELD'}`，
 *         并把持锁者的 token 带回去（调用方据此安静跳过本轮）。
 *         不传 instanceId 的调用方共用 `DEFAULT_INSTANCE_ID`（单实例调用方行为不变）；
 *         同进程多实例**必须**各自传不同 instanceId（如挂载/测试线标识）。
 *      ② **fencing token**：handle.token = 锁文件里的 holder.token（每次持锁唯一）。
 *      ③ handle 一旦被另一 owner 接管（本进程新 handle 建立 / 磁盘上换 token / 锁被删），
 *         立即 `lost=true` + `lostReason` 并停心跳、关 fd；调用方写盘前看 `handle.lost`。
 *         `handle.verify()` / `verifyOwnership(handle)` 可随时复核归属。
 *      ④ release 前做**归属校验**：只删"磁盘上 token 仍是自己"的锁；
 *         非本进程登记的那一个 handle 对象（克隆/旧引用）一律拒绝（`not-registered`），
 *         已被接管的一律不碰盘（`lost` / `not-owner`），绝不互删锁。
 *      以上均为**只加不改**：锁路径、心跳 30s、僵死 3×、两轮确认、rename 留证全部不动。
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { isoTime } from './encoder.js';

/** 默认心跳间隔：30 秒。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 僵死阈值倍数：心跳年龄 > 3×间隔 才算"疑似僵死"。 */
export const STALE_MULTIPLIER = 3;

/** 连续观察轮数：同一份僵死心跳被连续读到 N 轮才夺取。 */
export const STALE_CONFIRM_ROUNDS = 2;

/** 锁文件版本（将来锁内容升级时用；旧版本按"缺字段"容错处理）。 */
const LOCK_VERSION = 1;

/** 默认实例标识：不传 `opts.instanceId` 的调用方共用它（单实例调用方行为不变，见 K-12）。 */
export const DEFAULT_INSTANCE_ID = 'default';

/** 本进程当前持有的锁：`<锁文件绝对路径>\0<instanceId>` → handle。 */
const heldLocks = new Map();

/** 本进程看到的"疑似僵死"连续观察：锁文件绝对路径 → { fingerprint, count, at }。 */
const staleObservations = new Map();

/** 进程退出钩子只装一次。 */
let exitHookInstalled = false;

/** 一位 pad。 */
const pad2 = (n) => String(n).padStart(2, '0');

// ============================================================================
// 一、路径与锁内容
// ============================================================================

/**
 * 锁文件路径：`<root>/ledger/.lock`。
 *
 * @param {string} root 数据总库根目录
 * @returns {string}
 *
 * @why 以 `.` 开头：它不是账（不带 `.jsonl` 后缀也不会被 readAll 当账读），
 *      是运行状态，跟 `.state.json`、`.lost.jsonl` 同类。
 */
export function lockPath(root) {
  return path.join(root, 'ledger', '.lock');
}

/**
 * 僵死锁留证文件的前缀：`<root>/ledger/.lock.stale-`。
 *
 * @param {string} root
 * @returns {string}
 *
 * @why 留证文件**永不删除**：它是"曾经有一个实例被判定僵死、它的锁被夺取"
 *      的唯一物证。事后查双写/丢轮时，这串文件就是时间线。
 */
export function staleLockPrefix(root) {
  return lockPath(root) + '.stale-';
}

/** 文件名时间戳：`YYYYMMDD-HHMMSS`（+08:00 口径，符合"任何产物不得出现 Z 结尾时间"）。 */
function stamp(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

/** 生成一次持锁的唯一令牌（区分"同一个 pid 的新旧两次持锁"）。 */
function newToken() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 校验/归一 acquire 的实例标识（K-12 的幂等键之一）。
 *
 * @param {{instanceId?:string}} opts
 * @returns {string}
 * @throws {TypeError} instanceId 给了但不是非空字符串（配置错误必须立刻暴露）
 */
function normalizeInstanceId(opts) {
  const raw = opts ? opts.instanceId : undefined;
  if (raw === undefined || raw === null) return DEFAULT_INSTANCE_ID;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('acquire(root,{instanceId}): instanceId 必须是非空字符串');
  }
  return raw;
}

/** 本进程持锁表的键：同一把锁文件 + 同一实例标识（K-12：幂等键 = (root, instanceId)）。 */
function heldKey(file, instanceId) {
  return file + '\u0000' + instanceId;
}

/** 把 handle 从本进程持锁表移走（只移除它自己那一格，绝不误删别人的）。 */
function dropHeld(handle) {
  if (!handle || !handle.key) return;
  if (heldLocks.get(handle.key) === handle) heldLocks.delete(handle.key);
}

/**
 * 标记 handle 已失去锁：立刻 lost=true、停心跳、关 fd、移出持锁表。
 *
 * @param {object} handle
 * @param {string} reason 'taken-over:<instanceId>' / 'lock-missing' / 'not-owner' / ...
 * @why 只在"确实不再是锁的主人"时调用；调用后任何写盘都必须被调用方拒绝（handle.lost）。
 */
function markLost(handle, reason) {
  if (!handle) return;
  if (handle.lost !== true) {
    handle.lost = true;
    handle.lostReason = String(reason || 'lost');
  }
  handle.released = true;
  disposeHandle(handle);
  dropHeld(handle);
}

/**
 * 复核 handle 现在是否仍持有磁盘上的那把锁（fencing token 校验）。
 *
 * @param {object} handle acquire 返回的 handle
 * @returns {{ok:boolean, lost:boolean, reason:string, holder:object|null}}
 * @why 写盘前/释放前的唯一归属判据：磁盘 holder.token 必须等于 handle.holder.token。
 *      锁文件消失或换了 token → 立即把 handle 标 lost（不再伪装存活），调用方停写。
 *      `statFailed` 类 IO 故障**不**判 lost（证据不足），但也不允许据此释放/改写。
 */
export function verifyOwnership(handle) {
  if (!handle || handle.acquired !== true) {
    return { ok: false, lost: true, reason: 'no handle', holder: null };
  }
  if (handle.lost === true) {
    return { ok: false, lost: true, reason: String(handle.lostReason || 'lost'), holder: null };
  }
  if (handle.released) return { ok: false, lost: false, reason: 'released', holder: null };
  let cur;
  try {
    cur = readLockFile(handle.path);
  } catch (e) {
    return { ok: false, lost: false, reason: 'stat-failed: ' + (e && e.code), holder: null };
  }
  if (cur.missing) {
    markLost(handle, 'lock-missing');
    return { ok: false, lost: true, reason: 'lock-missing', holder: null };
  }
  if (!sameOwner(cur.holder, handle.holder)) {
    markLost(handle, 'not-owner');
    return { ok: false, lost: true, reason: 'not-owner', holder: cur.holder };
  }
  return { ok: true, lost: false, reason: '', holder: cur.holder };
}


/**
 * 读锁文件内容。
 *
 * @param {string} file
 * @returns {{holder:object|null, corrupt:boolean, missing:boolean, mtimeMs:number, size:number, error?:string}}
 *
 * @why 读不到/解析不了**不算**"没锁"：一个空的/半截的锁文件也是一种现场，
 *      要按"疑似僵死"走两轮确认，绝不能当成"没人持锁"直接抢。
 */
function readLockFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { holder: null, corrupt: false, missing: true, mtimeMs: 0, size: 0 };
    }
    throw e;
  }
  if (!st.isFile()) {
    return { holder: null, corrupt: true, missing: false, mtimeMs: st.mtimeMs, size: st.size, error: 'not-a-file' };
  }
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // stat 之后、读之前被释放：按"锁已不存在"处理，别误判成坏锁。
    if (e && e.code === 'ENOENT') {
      return { holder: null, corrupt: false, missing: true, mtimeMs: 0, size: 0 };
    }
    return { holder: null, corrupt: true, missing: false, mtimeMs: st.mtimeMs, size: st.size, error: 'read: ' + (e && e.code) };
  }
  let obj = null;
  try {
    obj = JSON.parse(txt);
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Number.isInteger(Number(obj.pid))) {
    return { holder: null, corrupt: true, missing: false, mtimeMs: st.mtimeMs, size: st.size, error: 'bad-json' };
  }
  return { holder: obj, corrupt: false, missing: false, mtimeMs: st.mtimeMs, size: st.size };
}

/** 判断磁盘上的 holder 是否就是 `handle.holder`（令牌优先，缺令牌时退化为 pid+host+startedAt）。 */
function sameOwner(a, b) {
  if (!a || !b) return false;
  if (typeof a.token === 'string' && typeof b.token === 'string') return a.token === b.token;
  return Number(a.pid) === Number(b.pid) &&
    String(a.hostname || '') === String(b.hostname || '') &&
    String(a.startedAt || '') === String(b.startedAt || '');
}

/**
 * 心跳年龄（毫秒）。字段坏了返回 Infinity（= 不可信，按疑似僵死处理）。
 *
 * @why 同时认 `heartbeatAtMs`（数值）与 `heartbeatAt`（ISO 字符串）：
 *      数值免时区解析歧义，ISO 给人看。两个都在时以数值为准。
 */
function heartbeatAgeMs(holder, now) {
  const n = Number(holder && holder.heartbeatAtMs);
  if (Number.isFinite(n) && n > 0) return now - n;
  const t = Date.parse(String((holder && holder.heartbeatAt) || ''));
  return Number.isFinite(t) ? now - t : Infinity;
}

/**
 * 同机持锁者是否已经死亡。
 *
 * @returns {boolean} true = 确定死了（pid 不存在）；进程不存在以外的任何不确定都返回 false。
 *
 * @why 只信 ESRCH（进程不存在）：EPERM 说明进程存在但权限不够查，不能当死。
 *      跨机器（hostname 不同）一律不判死，只靠心跳年龄。
 */
function holderLooksDead(holder) {
  if (!holder || holder.hostname !== os.hostname()) return false;
  const pid = Number(holder.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false; // 自己（且不在本进程持锁表里）→ 不判死
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return !!(e && e.code === 'ESRCH');
  }
}

/** 用来判断"是不是同一份僵死心跳"的指纹：心跳/持有人一变，连续计数就清零。 */
function staleFingerprint(holder, corrupt, rec) {
  if (holder) {
    return `holder|${holder.pid}|${holder.hostname || ''}|${holder.startedAt || ''}|${holder.heartbeatAt || ''}|${holder.heartbeatAtMs || ''}`;
  }
  // 坏锁：用大小+mtime 当指纹（文件被重写/删除重建都会变）。
  return `corrupt|${rec.size}|${rec.mtimeMs}`;
}

/** 记一次"疑似僵死"观察，返回这是连续第几次。 */
function observeStale(file, fingerprint) {
  const prev = staleObservations.get(file);
  const count = prev && prev.fingerprint === fingerprint ? prev.count + 1 : 1;
  staleObservations.set(file, { fingerprint, count, at: Date.now() });
  return count;
}

// ============================================================================
// 二、acquire / release
// ============================================================================

/**
 * 把当前进程的持有信息写成锁文件内容。
 *
 * @param {object} p
 * @returns {object} 写进去的 holder
 */
function makeHolder({ pid, token, startedAtMs, now, offsetMinutes }) {
  return {
    v: LOCK_VERSION,
    pid,
    hostname: os.hostname(),
    token,
    startedAt: isoTime(startedAtMs, offsetMinutes),
    startedAtMs,
    heartbeatAt: isoTime(now, offsetMinutes),
    heartbeatAtMs: now,
    // 人读辅助：持锁的到底是什么（插件升级后排查"谁在写"要看这个）。
    note: 'dsh-dialog-ledger 单实例写锁；删除本文件前请确认没有活着的持锁进程',
  };
}

/** 用已打开的 fd（'wx' 创建的那个）整体重写锁内容。 */
function writeHolderToFd(fd, holder) {
  const data = JSON.stringify(holder, null, 2) + '\n';
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, data, 0, 'utf8');
  fs.fsyncSync(fd);
}

/** 清掉 handle 的定时器与 fd（不碰磁盘）。 */
function disposeHandle(handle) {
  if (!handle) return;
  if (handle.timer) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  if (Number.isInteger(handle.fd) && handle.fd >= 0) {
    try { fs.closeSync(handle.fd); } catch { /* 已关/已坏 */ }
    handle.fd = -1;
  }
}

/**
 * 更新一次心跳。
 *
 * @param {object} handle acquire 返回的 handle
 * @returns {{ok:boolean, reason?:string, heartbeatAt?:string}}
 *
 * @why 写心跳前先确认磁盘上的锁**还是自己的**：
 *      若锁已被判定僵死并被别的实例夺取（rename 走了），本进程要立刻停手，
 *      不能把心跳写到别人的锁上（那等于伪造"我还活着"）。
 * @why 用持锁时留下的 fd 写而不是按路径重开：
 *      按路径重开有 TOCTOU：刚读完"还是我的"，路径就被换成了新主人的锁，
 *      再按路径写就成了覆盖新主人。fd 永远指向**自己那份文件**（被 rename 后就是留证文件），
 *      写过去也伤不到新锁。
 */
function beat(handle) {
  if (!handle || !handle.acquired || handle.released) {
    return { ok: false, reason: handle && handle.lost ? 'lost' : 'released' };
  }
  // 1) 磁盘上还是不是自己的令牌？（K-12：归属判断统一走 verifyOwnership/fencing token）
  const own = verifyOwnership(handle);
  if (!own.ok) {
    return { ok: false, reason: own.reason, lost: own.lost, holder: own.holder };
  }
  // 2) 用自己的 fd 刷新心跳
  const now = Date.now();
  const next = {
    ...handle.holder,
    heartbeatAt: isoTime(now, handle.offsetMinutes),
    heartbeatAtMs: now,
  };
  try {
    writeHolderToFd(handle.fd, next);
  } catch (e) {
    return { ok: false, reason: 'write-failed: ' + (e && e.message) };
  }
  handle.holder = next;
  return { ok: true, heartbeatAt: next.heartbeatAt };
}

/**
 * 夺取一个已被连续两轮判定僵死的锁：把旧锁 rename 成留证文件（不删）。
 *
 * @returns {{stolen:boolean, stalePath?:string, missing?:boolean}}
 *
 * @why rename 而不是 unlink：
 *      unlink 会把"旧主人是谁、什么时候死的"一起抹掉；rename 留下的是可复查的物证。
 */
function stealLock(file, offsetMinutes, now) {
  const suffix = `${stamp(now, offsetMinutes)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const dest = `${file}.stale-${suffix}`;
  try {
    fs.renameSync(file, dest);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 旧锁已经不在（别人先处理了/自己退出了）：直接回去重试创建即可。
      return { stolen: false, missing: true };
    }
    // Windows 上旧主人如果还活着，它的 fd 会挡住 rename（EPERM/EBUSY）——
    // 这正是我们要的：文件系统替我们否掉了"其实还活着"的夺取。
    return { stolen: false, blocked: true, code: e && e.code };
  }
  return { stolen: true, stalePath: dest };
}

/** 安装进程退出钩子：正常退出时把自己持有的锁删掉（只删确认还是自己的）。 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const handle of heldLocks.values()) {
      try {
        handle.released = true;
        if (handle.timer) { clearInterval(handle.timer); handle.timer = null; }
        if (Number.isInteger(handle.fd) && handle.fd >= 0) {
          try { fs.closeSync(handle.fd); } catch { /* ignore */ }
          handle.fd = -1;
        }
        if (!handle.path) continue;
        const cur = readLockFile(handle.path);
        // 只删"还是自己的"那把：被别人夺取后留下的是别人的锁 + 自己的留证文件。
        if (!cur.missing && sameOwner(cur.holder, handle.holder)) {
          fs.unlinkSync(handle.path);
        }
      } catch { /* 退出路径不许再抛 */ }
    }
    heldLocks.clear();
  });
}

/** acquire 的默认/校验后参数。 */
function normalizeOpts(opts = {}) {
  const hbMs = Number.isInteger(opts.heartbeatIntervalMs) && opts.heartbeatIntervalMs > 0
    ? opts.heartbeatIntervalMs
    : HEARTBEAT_INTERVAL_MS;
  const offsetMinutes = Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480;
  const staleMs = Math.max(1, Math.floor(hbMs * STALE_MULTIPLIER));
  return { hbMs, offsetMinutes, staleMs };
}

/** 造 handle：定时心跳 + 退出/释放能力（K-12：带 instanceId / fencing token / verify）。 */
function makeHandle({ file, fd, holder, hbMs, offsetMinutes, stalePath, instanceId }) {
  const handle = {
    acquired: true,
    path: file,
    holder,
    // K-12：fencing token（= holder.token）与实例标识 —— release/复核的唯一身份依据。
    token: holder.token,
    instanceId,
    key: heldKey(file, instanceId),
    heartbeatIntervalMs: hbMs,
    offsetMinutes,
    stalePath: stalePath || '',
    released: false,
    lost: false,
    lostReason: '',
    fd,
    timer: null,
    heartbeat: () => beat(handle),
    verify: () => verifyOwnership(handle),
    release: () => release(handle),
  };
  handle.timer = setInterval(() => {
    // 心跳失败（锁被夺取/文件被删）→ 自己停手，不刷日志（调用方的写盘路径会在
    // 写前看 handle.lost；这里只保证不再伪装存活）。
    try { beat(handle); } catch { /* 定时器里不许抛 */ }
  }, hbMs);
  // 不许心跳定时器把进程吊住（插件卸载/脚本跑完要能正常退出）。
  if (typeof handle.timer.unref === 'function') handle.timer.unref();
  // ★ K-12：本进程新建 handle 即"重新成为该锁的写者" —— 同文件的旧 handle（别的 instanceId）
  //   全部标 lost（被接管）；旧 handle 的 release 因此不会再按路径删新锁。
  for (const other of [...heldLocks.values()]) {
    if (other !== handle && other.path === file && other.acquired === true) {
      markLost(other, 'taken-over:' + instanceId);
    }
  }
  heldLocks.set(handle.key, handle);
  installExitHook();
  return handle;
}

/**
 * 抢锁。
 *
 * @param {string} root 数据总库根目录
 * @param {{heartbeatIntervalMs?:number, offsetMinutes?:number, instanceId?:string}} [opts]
 *        instanceId：同进程实例标识（K-12）。同 (root,instanceId) 幂等；
 *        不传共用 DEFAULT_INSTANCE_ID；同进程多实例必须各自传不同值。
 * @returns {(
 *   {acquired:true, path:string, holder:object, heartbeat:Function, release:Function,
 *    heartbeatIntervalMs:number, stalePath:string, lost:boolean, lostReason:string,
 *    instanceId:string, token:string, verify:Function}
 *   |
 *   {acquired:false, path:string, holder:object|null, reason:string, code:'LOCK_HELD',
 *    stalePending?:boolean, heartbeatAgeMs?:number, staleAfterMs?:number,
 *    conflict?:string, conflictInstanceId?:string}
 * )}
 *
 * @throws {Error} 真正的 IO 故障（建目录失败、权限、磁盘满）—— 那是故障，不是"别人在跑"。
 *
 * @why 同一进程重复 acquire 幂等：同一 (root, instanceId) 直接返回**同一个 handle**。
 *      没有这一步，index.js 重入/重试时会自己把自己挡在门外，或建两套心跳定时器。
 * @why ★ K-12（P0 ARCH-02）：幂等键从 root 改成 **(root, instanceId)**。
 *      不同 instanceId 的第二个 acquire 必须 LOCK_HELD（返回 `code:'LOCK_HELD'` + 持锁者 token），
 *      绝不能再返回同一个 handle —— 否则两个"实例"都以为持锁、各写各的，release 还会互删锁。
 * @why handle.lost：心跳/复核时发现锁已不属于自己（被判定僵死并被夺取、被同进程新实例接管、
 *      锁文件被删）会置 true 并停掉心跳；调用方在写盘前若看到它，必须停写。
 */
export function acquire(root, opts = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('acquire(root): root 必须是非空字符串');
  }
  const { hbMs, offsetMinutes, staleMs } = normalizeOpts(opts);
  const instanceId = normalizeInstanceId(opts);
  const file = lockPath(root);

  // 同一进程、同一 (root, instanceId) 已经持有 → 幂等返回**同一个 handle**。
  const existing = heldLocks.get(heldKey(file, instanceId));
  if (existing && !existing.released) return existing;

  // ★ K-12：同进程**别的实例**还活着（磁盘上确实还是它的 token）→ 直接 LOCK_HELD。
  //   这比让 'wx' 撞 EEXIST 后再靠年龄猜更准：同 pid 的持锁者不会被 holderLooksDead 判死，
  //   但也绝不会被本进程误夺取；不读不写不删别人的锁。
  for (const other of [...heldLocks.values()]) {
    if (other === existing || other.path !== file || other.released) continue;
    const own = verifyOwnership(other);
    if (own.ok) {
      return {
        acquired: false,
        path: file,
        holder: other.holder,
        reason: 'held',
        code: 'LOCK_HELD',
        conflict: 'same-process',
        conflictInstanceId: other.instanceId,
        heartbeatAgeMs: 0,
        staleAfterMs: staleMs,
      };
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 本次 acquire 若发生过夺取，记下留证路径，创建成功时带进 handle。
  let stolenPath = '';

  // 反复只有两种情况会循环：夺取成功后回去创建；或 rename 时发现锁已消失。
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();

    // ---------- 尝试排他创建 ----------
    let fd = -1;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e; // 权限/磁盘满：故障，抛
      fd = -1;
    }

    if (fd !== -1) {
      const startedAtMs = now;
      const holder = makeHolder({ pid: process.pid, token: newToken(), startedAtMs, now, offsetMinutes });
      try {
        writeHolderToFd(fd, holder);
      } catch (e) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        throw e;
      }
      staleObservations.delete(file);
      return makeHandle({ file, fd, holder, hbMs, offsetMinutes, stalePath: stolenPath, instanceId });
    }

    // ---------- 抢不到：读持有人，判断是否僵死 ----------
    const rec = readLockFile(file);
    if (rec.missing) continue; // 刚被释放，重试创建

    const age = rec.holder ? heartbeatAgeMs(rec.holder, now) : (now - rec.mtimeMs);
    const dead = rec.holder ? holderLooksDead(rec.holder) : false;
    const staleCandidate = dead || age > staleMs;

    if (!staleCandidate) {
      staleObservations.delete(file);
      return {
        acquired: false,
        path: file,
        holder: rec.holder,
        reason: rec.corrupt ? 'corrupt-lock' : 'held',
        code: 'LOCK_HELD',
        heartbeatAgeMs: Number.isFinite(age) ? age : null,
        staleAfterMs: staleMs,
      };
    }

    // 疑似僵死：**连续两轮**读到同一份没变化的心跳，才允许夺取。
    //
    // ★ INV-14（kill -9 续跑，2026-11-09）：**同一台机器上持锁进程已经死了**，是确定性证据，
    //   不需要"连续两轮"观察 —— 对活着的进程做两轮观察是为了防止"慢但没死"被误夺；
    //   而 ESRCH 意味着那个 pid 根本不存在了，再等一轮只会让"杀掉立即重启"被锁挡在外面
    //   （实测就是这样：lockSkipped=true，重启后一行都写不进）。
    //   pid 被复用的情况不会误判：复用后 `process.kill(pid,0)` 会成功 → 判"没死" → 退回两轮观察。
    const fp = staleFingerprint(rec.holder, rec.corrupt, rec);
    const count = observeStale(file, fp);
    if (!dead && count < STALE_CONFIRM_ROUNDS) {
      return {
        acquired: false,
        path: file,
        holder: rec.holder,
        reason: dead ? 'holder-dead-pending' : 'stale-pending',
        code: 'LOCK_HELD',
        stalePending: true,
        heartbeatAgeMs: Number.isFinite(age) ? age : null,
        staleAfterMs: staleMs,
        confirmations: count,
        confirmationsNeeded: STALE_CONFIRM_ROUNDS,
      };
    }

    // 两轮确认 → 留证夺取
    const st = stealLock(file, offsetMinutes, now);
    staleObservations.delete(file);
    if (st.stolen) {
      // 回到循环顶部：重新 'wx' 创建。旧锁已在 .lock.stale-* 里。
      stolenPath = st.stalePath || '';
      continue;
    }
    if (st.missing) continue; // 旧锁已消失，重试创建
    // 被文件系统挡住（持锁者还活着，fd 未释放）→ 不夺取，按"仍被持有"返回。
    return {
      acquired: false,
      path: file,
      holder: rec.holder,
      reason: 'stale-rename-blocked',
      code: 'LOCK_HELD',
      stalePending: true,
      heartbeatAgeMs: Number.isFinite(age) ? age : null,
      staleAfterMs: staleMs,
      blockedCode: st.code,
    };
  }

  // 3 次重试都没抢到（极端竞争）：如实返回当前持有人
  let holder = null;
  try { holder = readLockFile(file).holder; } catch { /* ignore */ }
  return { acquired: false, path: file, holder, reason: 'contended', code: 'LOCK_HELD' };
}

/**
 * 释放锁。
 *
 * @param {object} handle acquire 返回的 handle
 * @returns {{released:boolean, reason?:string, holder?:object, owned:boolean}}
 *
 * @why 只删"确认还是自己的"锁：
 *      被夺取之后旧实例还会走到 release（退出/卸载），若按路径无脑 unlink，
 *      删掉的是**新主人**的锁 —— 两个写者又回来了。
 * @why ★ K-12：release 前做两道归属校验（审计③ ARCH-02 fencing token）：
 *      ① handle 必须是本进程登记在册的那一个对象（`not-registered`：克隆/旧引用不得删锁）；
 *      ② 磁盘 holder.token 必须等于 handle.token（`not-owner`：被接管后不碰盘）。
 *      已被接管（lost）的 handle 一律返回 released=false 且**绝不**删盘上的锁。
 */
export function release(handle) {
  if (!handle || typeof handle !== 'object') {
    return { released: false, reason: 'no handle', owned: false };
  }
  if (handle.lost === true) {
    return { released: false, reason: String(handle.lostReason || 'lost'), owned: false, holder: null };
  }
  if (handle.released) {
    return { released: false, reason: 'already released', owned: false };
  }
  // ① 归属：只认本进程持锁表里登记的那一个 handle（防"同一 token 的克隆/旧引用"互删锁）。
  if (handle.key && heldLocks.get(handle.key) !== handle) {
    return { released: false, reason: 'not-registered', owned: false };
  }
  // ② fencing token：磁盘上还是自己的锁吗？
  let cur;
  try {
    cur = readLockFile(handle.path);
  } catch (e) {
    // stat 失败：证据不足，不许据此删盘；本地引用释放但如实报失败。
    handle.released = true;
    disposeHandle(handle);
    dropHeld(handle);
    return { released: false, reason: 'stat-failed: ' + (e && e.code), owned: false };
  }
  if (!cur.missing && !sameOwner(cur.holder, handle.holder)) {
    markLost(handle, 'not-owner');
    return { released: false, reason: 'not-owner', owned: false, holder: cur.holder };
  }
  handle.released = true;
  disposeHandle(handle);
  dropHeld(handle);
  if (cur.missing) return { released: true, reason: 'already gone', owned: true };
  try {
    fs.unlinkSync(handle.path);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { released: true, reason: 'already gone', owned: true };
    return { released: false, reason: 'unlink-failed: ' + (e && e.code), owned: true };
  }
  return { released: true, owned: true };
}

// ============================================================================
// 三、只读观测（给日志/体检/自测用，不参与抢锁）
// ============================================================================

/**
 * 只读查看当前锁的持有人。
 *
 * @param {string} root
 * @returns {{held:boolean, holder:object|null, corrupt:boolean, heartbeatAgeMs:number|null,
 *            staleThresholdMs:number, staleCandidate:boolean}}
 */
export function inspectLock(root, opts = {}) {
  const { staleMs } = normalizeOpts(opts);
  const rec = readLockFile(lockPath(root));
  const now = Date.now();
  if (rec.missing) {
    return { held: false, holder: null, corrupt: false, heartbeatAgeMs: null, staleThresholdMs: staleMs, staleCandidate: false };
  }
  const age = rec.holder ? heartbeatAgeMs(rec.holder, now) : (now - rec.mtimeMs);
  return {
    held: true,
    holder: rec.holder,
    corrupt: rec.corrupt,
    heartbeatAgeMs: Number.isFinite(age) ? age : null,
    staleThresholdMs: staleMs,
    staleCandidate: (rec.holder ? holderLooksDead(rec.holder) : false) || age > staleMs,
  };
}

/**
 * 列出所有僵死锁留证文件（`.lock.stale-*`）。
 *
 * @param {string} root
 * @returns {Array<{name:string, path:string, size:number, mtimeMs:number}>}
 */
export function listStaleLocks(root) {
  const dir = path.dirname(lockPath(root));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = '.lock.stale-';
  return names
    .filter((n) => n.startsWith(prefix))
    .sort()
    .map((n) => {
      const p = path.join(dir, n);
      let st = null;
      try { st = fs.statSync(p); } catch { /* ignore */ }
      return { name: n, path: p, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 };
    });
}
