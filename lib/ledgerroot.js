/**
 * @file ledgerroot.js
 * @role **账库根标记 `.ledger-root`** 的读写、默认落点、根发现与**越界保护**
 *       （V0.6.2 / 机主已签《v0.6.2-迁移规格-v1》§1.2）。
 *
 * @why 为什么账库需要一个"身份证"：
 *   ① **正向身份** —— 任何清理/迁移/打包工具，只对被 `.ledger-root` 认领的目录做
 *      "账库级"操作；老库（v0.6.1 及以前）没有标记，先补写（`ensureRootMarker`）再继续。
 *   ② **越界硬拒绝** —— 工具被误指向账库的**父目录**（例如桌面）时，必须在动手前抛
 *      `E_LEDGER_ROOT_PROTECTED` 并中止全部动作，不是"跳过"、不是"警告后继续"。
 *      桌面是机主每天看得见、也最常手动整理的位置，危险操作必须在越界那一刻停下。
 *
 * @why 为什么标记是**文件**而不是"目录名约定"：目录名可以改；标记里的 `rootId`（uuid）
 *   生成后不再变，布局升级（layoutVersion）只改版本号 —— 靠它才能认"同一个账库"。
 *
 * @scope 本模块只碰 `<root>/.ledger-root`（原子写）与**只读**目录探测；
 *        不碰台账、不碰单据、不删任何文件。
 * @depends node:fs / node:os / node:path / node:crypto / ./layout.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { LAYOUT_VERSION, ROOT_MARKER_NAME } from './layout.js';

/** 标记文件格式版本（结构与语义变更时 +1）。 */
export const ROOT_MARKER_VERSION = 1;

/** 标记文件 `kind` 固定值（用来确认"这是本插件的账库根"）。 */
export const ROOT_MARKER_KIND = 'dsh-dialog-ledger-root';

/** 默认账库根的最后一级目录名（桌面下的 `会话账本/`）。 */
export const DEFAULT_ROOT_NAME = '会话账本';

/** 越界保护错误码（清理/迁移/打包工具必须认这个码并中止）。 */
export const E_LEDGER_ROOT_PROTECTED = 'E_LEDGER_ROOT_PROTECTED';

/** 根发现时默认最大下钻层数（`start` 自身算第 0 层）。 */
const DEFAULT_MAX_DEPTH = 3;

/** 根发现时默认最多返回多少个根（防"指向家目录扫穿磁盘"）。 */
const DEFAULT_MAX_ROOTS = 20;

/** 根发现时默认最多访问多少个目录（同上，硬护栏）。 */
const DEFAULT_MAX_DIRS = 5000;

/** 根发现默认跳过的目录名：运行区（账本自己的运行痕迹，不是根）。 */
const DEFAULT_SKIP_DIRS = ['ledger'];

// ============================================================================
// 一、小工具：时间 / 目录 fsync / 错误
// ============================================================================

/**
 * 毫秒 → 契约 ISO 时间：`YYYY-MM-DDTHH:mm:ss+08:00`（标记文件用；**禁 Z**）。
 *
 * @param {number} ms
 * @param {number} [offsetMinutes=480] 时区偏移（机器口径固定 +08:00）
 * @returns {string}
 */
function stampIsoOffset(ms, offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const t = Number.isFinite(ms) ? ms : Date.now();
  const d = new Date(t + off * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` +
    `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

/** 目录 fsync（尽力而为：Windows/部分文件系统不支持目录 fsync，数据文件本身已 fsync）。 */
function fsyncDirBestEffort(dir) {
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* 不支持目录 fsync：忽略（数据文件已 fsync 过） */ } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 造一个带 `code` 的错误（调用方按 code 分支，不靠 message 串匹配）。 */
function rootError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

/** 目录里有没有 `ROOT_MARKER_NAME` 这个**文件**（不解析内容；损坏的 marker 也算"声称是根"）。 */
function hasMarkerFile(dir) {
  try {
    return fs.lstatSync(path.join(dir, ROOT_MARKER_NAME)).isFile();
  } catch {
    return false;
  }
}

// ============================================================================
// 二、默认落点 / 路径
// ============================================================================

/**
 * 默认账库根 = `<当前用户桌面>/会话账本`。
 *
 * @param {string} [home=os.homedir()] 家目录（允许注入，测试用；部署时不传）
 * @returns {string} 绝对路径（`path.join` 生成，不硬编码用户名）
 *
 * @why 用 `os.homedir()` 而不是写死用户名：同一份代码在开发机
 *      与机主设备上都要落到各自的桌面。
 */
export function defaultRootDir(home = os.homedir()) {
  const h = typeof home === 'string' && home.trim() ? home : os.homedir();
  return path.join(h, 'Desktop', DEFAULT_ROOT_NAME);
}

/**
 * 账库根标记的绝对路径：`<root>/.ledger-root`。
 * @param {string} root 账库根
 * @returns {string}
 */
export function rootMarkerPath(root) {
  return path.join(root, ROOT_MARKER_NAME);
}

// ============================================================================
// 三、读 / 写标记
// ============================================================================

/**
 * 校验一份标记对象是否合规（不读盘；纯函数）。
 *
 * @param {*} raw 解析出来的对象
 * @returns {string} 合规返回 `''`；不合规返回人读原因
 */
function validateRootMarker(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '标记不是 JSON 对象';
  if (raw.v !== ROOT_MARKER_VERSION) return `标记版本不支持：v=${JSON.stringify(raw.v)}（期望 ${ROOT_MARKER_VERSION}）`;
  if (raw.kind !== ROOT_MARKER_KIND) return `标记 kind 不符：${JSON.stringify(raw.kind)}（期望 ${ROOT_MARKER_KIND}）`;
  if (typeof raw.rootId !== 'string' || !raw.rootId) return '标记缺少 rootId';
  if (typeof raw.createdAt !== 'string' || !raw.createdAt) return '标记缺少 createdAt';
  if (!Number.isInteger(raw.layoutVersion) || raw.layoutVersion < 1) return '标记 layoutVersion 非法';
  return '';
}

/**
 * 读账库根标记（**只读、不抛错**；"不存在"与"坏了"必须能区分）。
 *
 * @param {string} root 账库根
 * @returns {{found:boolean, path:string, marker:object|null, reason:string, detail:string}}
 *          `reason`：`''`（正常）｜`'missing'`（没有标记，老库）｜
 *                    `'E_MARKER_READ'`（读不了）｜`'E_MARKER_JSON'`｜`'E_MARKER_INVALID'`
 *
 * @why 读不出来时返回 `marker:null` 而不是抛错：工具要能**报告**"标记坏了"，
 *      而不是让一个坏标记把"能不能读账库"这件事整个变成异常。
 */
export function readRootMarker(root) {
  const p = rootMarkerPath(root);
  const out = { found: false, path: p, marker: null, reason: 'missing', detail: '' };
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    return { ...out, reason: 'E_MARKER_READ', detail: (e && e.message) || String(e) };
  }
  out.found = true;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ...out, reason: 'E_MARKER_JSON', detail: (e && e.message) || String(e) };
  }
  const invalid = validateRootMarker(raw);
  if (invalid) return { ...out, reason: 'E_MARKER_INVALID', detail: invalid };
  return { found: true, path: p, marker: raw, reason: '', detail: '' };
}

/**
 * 原子写标记：`<target>.tmp-<pid>-<rand>` → write → **fsync** → rename → 目录 fsync。
 *
 * @param {string} target 标记最终路径
 * @param {object} marker 标记对象
 * @returns {number} 写入字节数
 * @throws {Error} IO 故障（磁盘满/权限）；调用方决定怎么报告
 *
 * @why 先写临时文件再 rename：进程在写到一半被杀，绝不会留下"半个 JSON 标记"
 *      ——读到的要么是旧标记、要么是新标记。
 */
function writeMarkerAtomic(target, marker) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = JSON.stringify(marker, null, 2) + '\n';
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fd = -1;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fsyncDirBestEffort(path.dirname(target));
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 确保账库根有 `.ledger-root`（**幂等**；老库无标记 → 补写；布局升级 → 只升 layoutVersion）。
 *
 * @param {string} root 账库根（不存在时按需创建目录）
 * @param {{nowMs?:number, offsetMinutes?:number, rootId?:string, layoutVersion?:number}} [opts]
 * @returns {{
 *   ok:boolean, created:boolean, updated:boolean, path:string,
 *   marker:object|null, reason:string, detail:string
 * }}
 *
 * @why 幂等必须是"零写"的幂等：标记已合规且版本不低 → **一个字节都不写**。
 *      否则每次启动都改 mtime，备份/同步盘会被无意义的标记刷新搅动。
 * @why 已存在标记但 `layoutVersion` 更低 → 保留 `rootId`/`createdAt` 只升版本：
 *      版本号是"布局长什么样"，rootId 才是"我是谁"，后者不能换。
 * @why 标记文件存在但**内容不可用**（坏 JSON / kind 不符）→ 不静默覆盖，原样报 `E_MARKER_*`：
 *      那是一份有人写过/坏过的证据，工具应把它交给人处理，而不是盖掉。
 */
export function ensureRootMarker(root, opts = {}) {
  const target = typeof root === 'string' ? path.resolve(root) : '';
  if (!target) {
    return { ok: false, created: false, updated: false, path: '', marker: null, reason: 'E_ROOT_REQUIRED', detail: 'root 必须是非空字符串' };
  }
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const offsetMinutes = Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480;
  const wantLayout = Number.isInteger(opts.layoutVersion) && opts.layoutVersion >= 1
    ? opts.layoutVersion : LAYOUT_VERSION;

  // 根目录本身：不存在就建（新账库开户）；存在但不是目录 → 明确失败
  let st = null;
  try { st = fs.statSync(target); } catch { st = null; }
  if (st && !st.isDirectory()) {
    return { ok: false, created: false, updated: false, path: rootMarkerPath(target), marker: null, reason: 'E_ROOT_NOT_DIR', detail: 'root 不是目录：' + target };
  }
  if (!st) {
    try { fs.mkdirSync(target, { recursive: true }); } catch (e) {
      return { ok: false, created: false, updated: false, path: rootMarkerPath(target), marker: null, reason: 'E_ROOT_MKDIR', detail: (e && e.message) || String(e) };
    }
  }

  const cur = readRootMarker(target);
  if (cur.found && cur.marker) {
    if (cur.marker.layoutVersion >= wantLayout) {
      return { ok: true, created: false, updated: false, path: cur.path, marker: cur.marker, reason: '', detail: '' };
    }
    const next = { ...cur.marker, layoutVersion: wantLayout };
    try {
      writeMarkerAtomic(cur.path, next);
    } catch (e) {
      return { ok: false, created: false, updated: false, path: cur.path, marker: cur.marker, reason: 'E_MARKER_WRITE', detail: (e && e.message) || String(e) };
    }
    return { ok: true, created: false, updated: true, path: cur.path, marker: next, reason: '', detail: '' };
  }
  if (cur.found) {
    return { ok: false, created: false, updated: false, path: cur.path, marker: null, reason: cur.reason, detail: cur.detail };
  }

  const rootId = typeof opts.rootId === 'string' && opts.rootId ? opts.rootId : crypto.randomUUID();
  const marker = {
    v: ROOT_MARKER_VERSION,
    kind: ROOT_MARKER_KIND,
    rootId,
    createdAt: stampIsoOffset(nowMs, offsetMinutes),
    layoutVersion: wantLayout,
  };
  try {
    writeMarkerAtomic(cur.path, marker);
  } catch (e) {
    return { ok: false, created: false, updated: false, path: cur.path, marker: null, reason: 'E_MARKER_WRITE', detail: (e && e.message) || String(e) };
  }
  return { ok: true, created: true, updated: false, path: cur.path, marker, reason: '', detail: '' };
}

// ============================================================================
// 四、根发现 / 越界保护
// ============================================================================

/**
 * 递归找出 `dir` 子树里的所有账库根（`.ledger-root` 所在目录）。
 *
 * @param {string} dir 起点目录
 * @param {{maxDepth?:number, maxRoots?:number, maxDirs?:number, skipDirNames?:string[]}} [opts]
 *        `maxDepth`：`dir` 自身算第 0 层，默认 3（即最多往下找 3 层）；
 *        `maxRoots`/`maxDirs`：硬护栏，超限置 `truncated=true`（**调用方必须当"找不全"处理**）。
 * @returns {{
 *   ok:boolean, dir:string, roots:Array<{root:string, markerPath:string, marker:object|null, reason:string}>,
 *   scannedDirs:number, truncated:boolean, errors:Array<{dir:string, code:string, message:string}>
 * }}
 *
 * @why 跳过**隐藏目录**与 `ledger/` 运行区：账本里的 `.quarantine/`、桌面上的
 *      `.git/` 之类既不该被当成根、也不该被无界递归扫穿。
 * @why 找到根就**不再下钻**：账库内部不会再套账库；继续扫只会把月目录/原文夹
 *      当成可疑目标，白白烧 IO。
 * @why `truncated` 必须显式返回：`assertNoLedgerRootUnder` 靠它作"找不全 = 拒绝"的
 *      fail-closed 判断。
 */
export function findLedgerRootsUnder(dir, opts = {}) {
  const out = {
    ok: true,
    dir: '',
    roots: [],
    scannedDirs: 0,
    truncated: false,
    errors: [],
  };
  const start = typeof dir === 'string' && dir ? path.resolve(dir) : '';
  if (!start) {
    return { ...out, ok: false, reason: 'E_DIR_REQUIRED' };
  }
  out.dir = start;
  let st = null;
  try { st = fs.statSync(start); } catch { st = null; }
  if (!st || !st.isDirectory()) return out; // 不存在/不是目录 = 没有根可找

  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxRoots = Number.isInteger(opts.maxRoots) && opts.maxRoots > 0 ? opts.maxRoots : DEFAULT_MAX_ROOTS;
  const maxDirs = Number.isInteger(opts.maxDirs) && opts.maxDirs > 0 ? opts.maxDirs : DEFAULT_MAX_DIRS;
  const skipDirs = new Set(DEFAULT_SKIP_DIRS);
  if (Array.isArray(opts.skipDirNames)) {
    for (const n of opts.skipDirNames) if (typeof n === 'string' && n) skipDirs.add(n);
  }

  const walk = (current, depth) => {
    if (out.truncated) return;
    if (out.roots.length >= maxRoots || out.scannedDirs >= maxDirs) {
      out.truncated = true;
      return;
    }
    out.scannedDirs++;
    if (hasMarkerFile(current)) {
      const rm = readRootMarker(current);
      out.roots.push({ root: current, markerPath: rm.path, marker: rm.marker, reason: rm.reason });
      return; // 根内部不再下钻
    }
    if (depth >= maxDepth) return;
    let ents;
    try {
      ents = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      out.errors.push({ dir: current, code: (e && e.code) || 'E_READDIR', message: (e && e.message) || String(e) });
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.')) continue;
      if (skipDirs.has(e.name)) continue;
      walk(path.join(current, e.name), depth + 1);
      if (out.truncated) return;
    }
  };

  walk(start, 0);
  return out;
}

/**
 * **越界硬拒绝**：`target` 的子树里若发现账库根，抛 `E_LEDGER_ROOT_PROTECTED`（零动作）。
 *
 * @param {string} target 即将被递归删除/移动/打包的目录
 * @param {{maxDepth?:number, maxRoots?:number, maxDirs?:number, skipDirNames?:string[]}} [opts]
 * @returns {{ok:true, protected:false, target:string, isLedgerRoot:boolean, rootId:string, roots:string[]}}
 * @throws {Error} `code='E_LEDGER_ROOT_PROTECTED'`（发现子树有根）；
 *                 `code='E_LEDGER_ROOT_SCAN_FAILED'` / `'E_LEDGER_ROOT_SCAN_TRUNCATED'`（找不全，按保护处理）；
 *                 `code='E_TARGET_REQUIRED'`（参数非法）
 *
 * @why 边界：`target` **自身**带 `.ledger-root` 时不算越界 —— 那它就是账库自己，
 *      清理/迁移工具正该对它做"账库级"操作。越界指的是"把账库的父目录当临时目录"。
 * @why 幂等/零动作：本函数只读（readRootMarker + readdir），不写、不删、不建目录。
 *      发现越界时"抛错"就是全部动作。
 * @why 找不全（truncated/readdir 失败）也**拒绝**：保护检查宁可误报，不可漏报。
 */
export function assertNoLedgerRootUnder(target, opts = {}) {
  const resolved = typeof target === 'string' && target ? path.resolve(target) : '';
  if (!resolved) {
    throw rootError('E_TARGET_REQUIRED', 'assertNoLedgerRootUnder(target): target 必须是非空字符串');
  }

  const selfMarker = readRootMarker(resolved);
  if (selfMarker.found) {
    return {
      ok: true,
      protected: false,
      target: resolved,
      isLedgerRoot: true,
      rootId: selfMarker.marker ? selfMarker.marker.rootId : '',
      roots: [],
    };
  }

  const found = findLedgerRootsUnder(resolved, opts);
  if (!found.ok) {
    throw rootError('E_LEDGER_ROOT_SCAN_FAILED', '根扫描失败，无法确认是否越界，按保护拒绝：' + resolved);
  }
  if (found.truncated) {
    throw rootError('E_LEDGER_ROOT_SCAN_TRUNCATED',
      '根扫描未完成（truncated=true），无法确认是否越界，按保护拒绝：' + resolved);
  }
  if (found.errors.length > 0) {
    throw rootError('E_LEDGER_ROOT_SCAN_FAILED',
      '根扫描遇到不可读目录（' + found.errors.length + ' 个），无法确认是否越界，按保护拒绝：' + resolved,
      { scanErrors: found.errors });
  }
  if (found.roots.length > 0) {
    const roots = found.roots.map((r) => r.root);
    throw rootError(
      E_LEDGER_ROOT_PROTECTED,
      '目标目录子树内有账库根（' + roots.join('、') + '）：为保护账库，拒绝任何递归删除/移动/打包动作。target=' + resolved,
      { target: resolved, roots, markerPaths: found.roots.map((r) => r.markerPath) },
    );
  }
  return { ok: true, protected: false, target: resolved, isLedgerRoot: false, rootId: '', roots: [] };
}
