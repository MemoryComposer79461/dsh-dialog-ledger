#!/usr/bin/env node
/**
 * @file 工具-迁移布局.mjs
 * @role **V0.6.2 一级目录迁移的唯一写盘入口**（机主已签《v0.6.2-迁移规格-v1》§三）：
 *       把一级散落的 交接表 / 清册 / 体检 单据 **rename** 进对应分类子目录
 *       （`交接表/`、`清册/`、`体检/`），并刷新《账簿总目录.md》。
 *
 * 用法：
 *   node docs/工具-迁移布局.mjs --root=<账库根>                      # dry-run：只打印计划，零写盘
 *   node docs/工具-迁移布局.mjs --root=<账库根> --create-root         # dry-run；允许写时补写 .ledger-root
 *   node docs/工具-迁移布局.mjs --root=<账库根> --write              # 执行迁移（写 journal → 逐个 rename → 刷新总目录）
 *   node docs/工具-迁移布局.mjs --rollback=<journal>                 # 只给 journal 回退：根 = <journal 所在目录>/..
 *   node docs/工具-迁移布局.mjs --root=<账库根> --rollback=<journal>  # 显式给根（校验 journal 必须在 <root>/ledger/ 下）
 *   任意模式加 --json 输出机读结果（stdout 只有一个 JSON 对象）
 *
 * 退出码：0 成功；2 冲突/未知/前置不满足/回退校验失败/计数不一致（**未写或需人工确认**；
 *         对 `--write` 而言是"**部分完成**"：已知条目已搬、阻塞条目未搬、journal 保留可 `--rollback`）；
 *         1 意外 IO/内部错误。
 *
 * 安全约束（逐条对应规格 §三）：
 *   1) **只 rename**：迁前迁后逐文件 sha256 必须相同（写前后各验一次，不一致即报错并尝试还原该条）；
 *   2) journal 落 `<root>/ledger/.layout-migration-<YYYYMMDD-HHmmss>.journal`（JSONL，不进台账）；
 *   3) 目标已存在 / 源缺失 / 未知一级条目 → 该条**不搬**、进冲突清单、整体退出码 2。
 *      ★ 这是**部分完成**语义，不是"全有或全无"：其余能安全搬的**已知**条目照常搬走；
 *      journal 只登记实际搬走的条目（保留可 `--rollback` 还原）；阻塞条目原样留在原位置等人工确认。
 *   4) 同一账库只允许一个迁移在跑：复用 `lib/lock.js` 的 `.lock`（不新造锁）；
 *   5) 迁移后重算"月份计数 + 分类计数"，与迁移前有任何变化 → 报错、保留 journal、不刷新总目录；
 *   6) dry-run **零写盘**；但只要有阻塞项（冲突 / 未知 / 缺 marker 且未给 `--create-root`），
 *      **即使 dry-run 也退出码 2** —— 退出码表达的是"这个库现在不能干净迁移"，不是"有没有写盘"。
 *
 * 回退（`--rollback`）：
 *   · `--root` 可省略：根由 `<journal 所在目录>/..` 推出（journal 固定在 `<root>/ledger/` 下）。
 *     若同时给了 `--root`，则校验 journal 必须在 `<root>/ledger/` 下，否则 `E_ARGS`
 *     —— 防止拿 A 库的 journal 去回滚 B 库。
 *   · 先做**零写预检**（逐条 sha256 与路径校验），有一条不满足就整批拒绝；
 *   · 按 journal 反向 rename，恢复后复算 sha256 必须一致；
 *   · 成功后 journal 改名 `<journal>.done`（证据保留，不删除）；并清理**空**的分类子目录、刷新总目录。
 *   · 注意：`.ledger-root` 与《账簿总目录.md》是 v0.6.2 的布局标记/派生导航文件，
 *     回退**不删除**它们（回退只还原被搬单据）。
 *
 * @why 默认 dry-run、写盘必须显式 --write：迁移会动几十份不可再生单据的**位置**，
 *      而路径是台账/周账/收据里引用的东西 —— 先看清计划再动手。
 * @why 全程只 rename 不 copy：同卷 rename 是原子的且不改字节，迁完的 sha256 必须与迁前**逐字节相同**；
 *      一旦发现不同，说明有人在锁外动过文件，立刻报错而不是"迁过去再说"。
 *
 * @depends node:fs / node:path / node:crypto / node:url / ../lib/layout.js /
 *          ../lib/ledgerroot.js / ../lib/catalog.js / ../lib/lock.js
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  FILE_KIND, KIND_SUBDIR, SUBDIR, LAYOUT_VERSION, classifyFileName, detectLayout, newLayoutPath,
} from '../lib/layout.js';
import { ensureRootMarker, readRootMarker, rootMarkerPath } from '../lib/ledgerroot.js';
import {
  CATALOG_STABLE_COUNT_KEYS, catalogCounts, collectCatalogData, writeCatalog,
} from '../lib/catalog.js';
import { acquire, release } from '../lib/lock.js';

const SELF_FILE = fileURLToPath(import.meta.url);

/** 机器时间固定 +08:00（规格/契约口径；不随宿主机时区漂移）。 */
const OFFSET_MINUTES = 480;

/** Windows 路径比较不区分大小写（journal 里记的是绝对路径，回退时不能因盘符/目录大小写不同就拒认）。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32';

/** 路径比较键：统一 `path.resolve`，Windows 再转小写。 */
function pathKey(p) {
  const abs = path.resolve(p);
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
}

/**
 * 路径的**规范比较键**：优先 `fs.realpathSync.native`（解开 Windows 8.3 短名、大小写、符号链接），
 * 路径不存在时退回 `pathKey`。
 *
 * @param {string} p 路径
 * @returns {string}
 *
 * @why 为什么必须有这一层：同一目录 Windows 会给两种写法（`<build-host>\…` 与
 *      `<build-host>\…`）。journal 里的 old/new 是迁移当时按 root 参数写下的；
 *      `--rollback` 只给 journal 时根是从 journal 路径推的 —— 两边写法可能不同，
 *      只做字符串比较会把**同一个账库**误判成"journal 属于别的库"而拒绝回退
 *      （2026-11-10 集成演练实测踩到）。比较目录归属前先 realpath 规范化。
 */
function canonicalPath(p) {
  const abs = path.resolve(p);
  try {
    return pathKey(fs.realpathSync.native(abs));
  } catch {
    return pathKey(abs);
  }
}

/** 路径的**保持大小写的规范形式**：realpath 解开 8.3 短名/符号链接但不动大小写；不存在则原样返回。
 *  用于把 journal 条目规整成"真实路径"再回退/展示（否则短名与长名混用会在人读输出里变成
 *  `..\..\..\ADMINI~1\…` 这种看起来像出错的相对路径）。 */
function realPathOrSelf(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** 月份目录（中性目录，不搬）。 */
const MONTH_DIR_RE = /^\d{4}年\d{2}月$/;

/** 已知系统残留文件名：不搬、不报告冲突（Windows 资源管理器/同步盘随手生成）。 */
const SYSTEM_JUNK_NAMES = new Set(['desktop.ini', 'Thumbs.db', '.DS_Store']);

// ============================================================================
// 一、小工具：参数 / 时间 / 哈希 / fsync
// ============================================================================

/** 取 `--key=value` 参数（没有返回 `d`；`--key` 单独出现返回空串）。 */
function argOf(argv, key, d = '') {
  const hit = argv.find((a) => a === key || a.startsWith(key + '='));
  if (!hit) return d;
  const i = hit.indexOf('=');
  return i < 0 ? '' : hit.slice(i + 1);
}

/** 毫秒 → `YYYY-MM-DD HH:mm:ss +08:00`（契约文本时间，无 Z）。 */
function stampWithOffset(ms, offsetMinutes = OFFSET_MINUTES) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : OFFSET_MINUTES;
  const t = Number.isFinite(ms) ? ms : Date.now();
  const d = new Date(t + off * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ` +
    `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

/** 毫秒 → journal 文件名的紧凑时间 `YYYYMMDD-HHmmss`（+08:00）。 */
function compactStamp(ms, offsetMinutes = OFFSET_MINUTES) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : OFFSET_MINUTES;
  const t = Number.isFinite(ms) ? ms : Date.now();
  const d = new Date(t + off * 60000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
}

/** 文件 sha256（hex）；读不到抛错（调用方按"源缺失"处理）。 */
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 目录 fsync（尽力而为：Windows/部分 FS 不支持目录 fsync）。 */
function fsyncDirBestEffort(dir) {
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* ignore */ } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 普通文件存在判定（目录不算）。 */
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ============================================================================
// 二、计划（dry-run 与 --write 共用；**只读**）
// ============================================================================

/**
 * 扫描账库一级目录，生成迁移计划（只读，不写盘）。
 *
 * @param {string} root 账库根
 * @param {{createRoot?:boolean}} [opts]
 * @returns {{
 *   v:number, root:string, ok:boolean, createRoot:boolean, markerMissing:boolean,
 *   marker:{found:boolean, usable:boolean, path:string, rootId:string, reason:string},
 *   layout:{version:number, dirsPresent:string[], oldFileCount:number, unknownCount:number},
 *   moves:Array<{name:string, kind:string, old:string, new:string, bytes:number, sha256:string}>,
 *   conflicts:Array<{name:string, kind:string, old:string, new?:string, reason:string, detail?:string}>,
 *   unknown:Array<{name:string, kind:string, isDirectory:boolean, reason:string}>,
 *   ignored:Array<{name:string, reason:string}>,
 *   blockers:string[]
 * }}
 *
 * @why 分类/目标路径一律走 `lib/layout.js`：迁移工具与写端/读端/总目录必须是**同一套规则**，
 *      否则三处各写一份，迟早互相打脸。
 * @why 未知一级条目"不猜、不搬"：认不出是哪种单据的文件，搬进哪个目录都可能是错的；
 *      列给人工确认（退出码 2），比"看起来像清册就搬"安全。
 */
export function buildPlan(root, opts = {}) {
  const absRoot = path.resolve(root);
  const markerInfo = readRootMarker(absRoot);
  const layoutInfo = detectLayout(absRoot);
  const markerMissing = !(markerInfo.found && markerInfo.marker);
  const plan = {
    v: 1,
    root: absRoot,
    ok: true,
    createRoot: opts.createRoot === true,
    markerMissing,
    marker: {
      found: markerInfo.found,
      usable: !!markerInfo.marker,
      path: markerInfo.path,
      rootId: markerInfo.marker ? markerInfo.marker.rootId : '',
      reason: markerInfo.reason,
    },
    layout: {
      version: layoutInfo.layoutVersion,
      dirsPresent: layoutInfo.dirsPresent.slice(),
      oldFileCount: layoutInfo.oldFiles.length,
      unknownCount: layoutInfo.unknown.length,
    },
    moves: [],
    conflicts: [],
    unknown: [],
    ignored: [],
    blockers: [],
  };

  let entries;
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true });
  } catch (e) {
    plan.ok = false;
    plan.blockers.push('E_ROOT_READ');
    plan.conflicts.push({ name: '', kind: FILE_KIND.UNKNOWN, old: absRoot, reason: 'E_ROOT_READ', detail: (e && e.message) || String(e) });
    return plan;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const subdirNames = new Set(Object.values(SUBDIR));
  for (const e of entries) {
    const name = e.name;
    const abs = path.join(absRoot, name);

    if (e.isDirectory()) {
      // 中性目录：分类子目录 / 月份目录 / 运行区 ledger / 隐藏目录
      if (subdirNames.has(name) || MONTH_DIR_RE.test(name) || name === 'ledger') continue;
      if (name.startsWith('.')) { plan.ignored.push({ name, reason: 'HIDDEN' }); continue; }
      plan.unknown.push({ name, kind: FILE_KIND.UNKNOWN, isDirectory: true, reason: 'UNKNOWN_DIR' });
      continue;
    }
    if (!e.isFile()) {
      plan.unknown.push({ name, kind: FILE_KIND.UNKNOWN, isDirectory: false, reason: 'NOT_REGULAR_FILE' });
      continue;
    }

    const kind = classifyFileName(name);
    if (Object.prototype.hasOwnProperty.call(KIND_SUBDIR, kind)) {
      const dest = newLayoutPath(absRoot, kind, name);
      if (fs.existsSync(dest)) {
        plan.conflicts.push({ name, kind, old: abs, new: dest, reason: 'TARGET_EXISTS' });
        continue;
      }
      let bytes = 0;
      let sha256 = '';
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) throw Object.assign(new Error('源不是普通文件'), { code: 'E_SOURCE_NOT_FILE' });
        bytes = st.size;
        sha256 = sha256File(abs);
      } catch (err) {
        plan.conflicts.push({
          name, kind, old: abs, new: dest,
          reason: (err && err.code) || 'E_SOURCE_UNREADABLE',
          detail: (err && err.message) || String(err),
        });
        continue;
      }
      plan.moves.push({ name, kind, old: abs, new: dest, bytes, sha256 });
      continue;
    }

    // 中性：标记文件 / 总目录
    if (kind === FILE_KIND.MARKER || kind === FILE_KIND.CATALOG) continue;
    if (name.startsWith('.')) { plan.ignored.push({ name, reason: 'HIDDEN' }); continue; }
    if (SYSTEM_JUNK_NAMES.has(name)) { plan.ignored.push({ name, reason: 'SYSTEM_JUNK' }); continue; }
    plan.unknown.push({ name, kind, isDirectory: false, reason: 'UNKNOWN_FILE' });
  }

  if (markerMissing && !plan.createRoot) plan.blockers.push('E_LEDGER_ROOT_MARKER_MISSING');
  if (plan.conflicts.length > 0) plan.blockers.push('E_LAYOUT_CONFLICT');
  if (plan.unknown.length > 0) plan.blockers.push('E_LAYOUT_UNKNOWN');
  plan.ok = plan.blockers.length === 0;
  return plan;
}

// ============================================================================
// 三、dry-run（零写盘）
// ============================================================================

/**
 * dry-run：生成计划并判定退出码，**不写任何字节**。
 *
 * @param {string} root 账库根
 * @param {{createRoot?:boolean}} [opts]
 * @returns {object} 机读结果（含 `mode:'dry-run'`、`exitCode`、`moves/conflicts/unknown/blockers`）
 *
 * @why dry-run 里**不取锁**：取锁本身要建 `.lock` 文件，那就不是"零写盘"了；
 *      计划在真正 `--write` 时会于锁内**重算**，不依赖 dry-run 的扫描结果。
 */
export function runDryRun(root, opts = {}) {
  const absRoot = path.resolve(root);
  let plan;
  try {
    plan = buildPlan(absRoot, { createRoot: opts.createRoot === true });
  } catch (e) {
    return {
      ok: false, mode: 'dry-run', root: absRoot, exitCode: 1,
      reason: 'E_INTERNAL', detail: (e && e.message) || String(e), moves: [], conflicts: [], unknown: [], ignored: [], blockers: [],
    };
  }
  const exitCode = plan.blockers.length === 0 ? 0 : 2;
  return {
    ok: exitCode === 0,
    mode: 'dry-run',
    root: absRoot,
    exitCode,
    createRoot: plan.createRoot,
    markerMissing: plan.markerMissing,
    marker: plan.marker,
    layout: plan.layout,
    moves: plan.moves,
    conflicts: plan.conflicts,
    unknown: plan.unknown,
    ignored: plan.ignored,
    blockers: plan.blockers,
    note: exitCode === 0
      ? 'dry-run：未写盘。确认计划后加 --write 执行。'
      : 'dry-run：存在阻塞项，未写盘（见 conflicts/unknown/blockers）。',
  };
}

// ============================================================================
// 四、--write（唯一真正动单据的路径）
// ============================================================================

/** journal 文件名的唯一化（同一秒重复运行也不覆盖旧 journal）。 */
function uniqueJournalPath(root, nowMs) {
  const dir = path.join(root, 'ledger');
  const base = `.layout-migration-${compactStamp(nowMs)}`;
  let candidate = path.join(dir, `${base}.journal`);
  for (let i = 1; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${base}-${i}.journal`);
  }
  return candidate;
}

/** 追加一行 journal 并 fsync（逐条落盘：崩溃后能按 journal 还原到"一半"的真实状态）。 */
function writeJournalLine(fd, obj) {
  fs.writeSync(fd, `${JSON.stringify(obj)}\n`, null, 'utf8');
  fs.fsyncSync(fd);
}

/** 从错误里抽人读细节。 */
function errDetail(e) {
  return (e && e.message) || String(e);
}

/**
 * 执行迁移（`--write`）：取锁 → 校验前置 → 补标记/建目录 → 写 journal → 逐个 rename →
 * 复算哈希 → 前后计数比对 → 刷新总目录。
 *
 * @param {string} root 账库根
 * @param {{createRoot?:boolean, nowMs?:number}} [opts]
 * @returns {object} 机读结果（含 `mode:'write'`、`exitCode`、`moved`、`journal`、`catalog`、`countsBefore/After`）
 *
 * @why 只对 `plan.moves` 动手：冲突（目标已存在/源缺失）与未知条目**原地不动**，
 *      整体退出码 2 提醒人工确认；这符合规格"该条不搬"（而不是"一条冲突就全库停摆"）。
 *      ★ 因此 `--write` 是**部分完成**语义：已知条目照搬、阻塞条目不搬、退出码 2、
 *      journal 只登记真正搬走的条目（保留可 `--rollback`）—— 不是"全有或全无"。
 * @why 计数比对不通过时**不刷新总目录**：总目录是"发表出去的数字"，
 *      迁移前后账目数字变了说明迁移本身错了，此时刷新等于把错误发表。
 */
export function runWrite(root, opts = {}) {
  const absRoot = path.resolve(root);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const createRoot = opts.createRoot === true;
  const result = {
    ok: false,
    mode: 'write',
    root: absRoot,
    exitCode: 0,
    marker: { created: false, updated: false, path: rootMarkerPath(absRoot), reason: '', detail: '' },
    moved: [],
    failures: [],
    conflicts: [],
    unknown: [],
    ignored: [],
    journal: { path: '', lines: 0, bytes: 0 },
    countsBefore: {},
    countsAfter: {},
    countsEqual: null,
    countDiffs: [],
    catalog: null,
    blockers: [],
    note: '',
  };

  // ① 取锁：同一账库只允许一个迁移/写操作在跑（复用 lib/lock.js；不新造锁）
  let lock;
  try {
    lock = acquire(absRoot);
  } catch (e) {
    result.exitCode = 2;
    result.blockers.push('E_LEDGER_LOCK_ACQUIRE');
    result.failures.push({ reason: 'E_LEDGER_LOCK_ACQUIRE', detail: errDetail(e) });
    return result;
  }
  if (!lock.acquired) {
    result.exitCode = 2;
    result.blockers.push('E_LEDGER_LOCKED');
    result.note = '账库正被另一个进程/迁移持有锁，未写任何字节。';
    return result;
  }

  try {
    // ② 锁内重算计划（dry-run 的扫描可能已过期）
    const plan = buildPlan(absRoot, { createRoot });
    result.conflicts = plan.conflicts;
    result.unknown = plan.unknown;
    result.ignored = plan.ignored;
    result.blockers = plan.blockers.slice();

    if (plan.markerMissing && !createRoot) {
      result.exitCode = 2;
      result.note = '根缺 .ledger-root（老库）：确认后加 --create-root 补写标记；本次未写任何字节。';
      return result;
    }

    // ③ 立"身份"：缺标记 → 补写（只在此路径写；--create-root 是显式授权）
    if (plan.markerMissing) {
      const m = ensureRootMarker(absRoot, { nowMs, offsetMinutes: OFFSET_MINUTES, layoutVersion: LAYOUT_VERSION });
      result.marker = { created: m.created, updated: m.updated, path: m.path, reason: m.reason || '', detail: m.detail || '' };
      if (!m.ok) {
        result.exitCode = 2;
        result.blockers.push(m.reason);
        result.note = '根标记写入失败，未动任何单据。';
        return result;
      }
    }

    // ④ 布局目录：新布局的 交接表/清册/体检 先立起来（rows=0 零成本；写端保证子目录存在）
    for (const sub of Object.values(SUBDIR)) {
      try { fs.mkdirSync(path.join(absRoot, sub), { recursive: true }); } catch (e) {
        result.failures.push({ reason: 'E_SUBDIR_MKDIR', sub, detail: errDetail(e) });
      }
    }

    // ⑤ 迁移前计数（月份 + 分类；布局版本不在"必须相等"的键里）
    const beforeData = collectCatalogData(absRoot, { nowMs, offsetMinutes: OFFSET_MINUTES });
    result.countsBefore = catalogCounts(beforeData);

    // ⑥ 写 journal + 逐个 rename（只 rename；逐条 fsync；迁前迁后各验一次 sha256）
    if (plan.moves.length > 0) {
      fs.mkdirSync(path.join(absRoot, 'ledger'), { recursive: true });
      const journalPath = uniqueJournalPath(absRoot, nowMs);
      let fd = -1;
      try {
        fd = fs.openSync(journalPath, 'wx');
      } catch (e) {
        result.exitCode = 2;
        result.failures.push({ reason: (e && e.code) || 'E_JOURNAL_CREATE', detail: errDetail(e) });
        result.note = 'journal 创建失败，未动任何单据。';
        result.countsAfter = result.countsBefore;
        return result;
      }
      result.journal.path = journalPath;
      try {
        for (const mv of plan.moves) {
          // 源必须还在且内容未变（锁内再验；防止锁外进程改文件）
          let curSha = '';
          try {
            if (!isFile(mv.old)) throw Object.assign(new Error('源文件不存在'), { code: 'SOURCE_MISSING' });
            curSha = sha256File(mv.old);
          } catch (e) {
            result.failures.push({ name: mv.name, old: mv.old, reason: (e && e.code) || 'SOURCE_MISSING', detail: errDetail(e) });
            continue;
          }
          if (curSha !== mv.sha256) {
            result.failures.push({
              name: mv.name, old: mv.old, reason: 'SOURCE_CHANGED',
              expected: mv.sha256, actual: curSha,
            });
            continue;
          }
          // journal 先落盘（逐条 fsync），再 rename：崩溃后回退脚本能还原"已登记但可能没搬"的状态
          const at = stampWithOffset(nowMs);
          try {
            writeJournalLine(fd, { old: mv.old, new: mv.new, sha256: mv.sha256, bytes: mv.bytes, at });
            result.journal.lines += 1;
          } catch (e) {
            result.failures.push({ name: mv.name, old: mv.old, reason: 'E_JOURNAL_WRITE', detail: errDetail(e) });
            break; // journal 写不进去 = 回退无据，立即停手
          }
          try {
            fs.mkdirSync(path.dirname(mv.new), { recursive: true });
            fs.renameSync(mv.old, mv.new);
          } catch (e) {
            result.failures.push({ name: mv.name, old: mv.old, new: mv.new, reason: (e && e.code) || 'E_RENAME', detail: errDetail(e) });
            continue;
          }
          let afterSha = '';
          try { afterSha = sha256File(mv.new); } catch (e) {
            result.failures.push({ name: mv.name, old: mv.old, new: mv.new, reason: 'POST_RENAME_READ_FAILED', detail: errDetail(e) });
            continue;
          }
          if (afterSha !== mv.sha256) {
            // rename 不该改字节；不一致 = 环境异常。尝试把这一条搬回去再报错。
            let restored = false;
            try {
              fs.renameSync(mv.new, mv.old);
              restored = sha256File(mv.old) === mv.sha256;
            } catch { /* ignore */ }
            result.failures.push({
              name: mv.name, old: mv.old, new: mv.new, reason: 'POST_RENAME_SHA_MISMATCH',
              expected: mv.sha256, actual: afterSha, restored,
            });
            continue;
          }
          result.moved.push({ name: mv.name, kind: mv.kind, old: mv.old, new: mv.new, bytes: mv.bytes, sha256: mv.sha256 });
        }
      } finally {
        try { fs.fsyncSync(fd); } catch { /* 已逐条 fsync 过；关闭前的最终 fsync 尽力而为 */ }
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { result.journal.bytes = fs.statSync(journalPath).size; } catch { result.journal.bytes = 0; }
      }
      fsyncDirBestEffort(path.join(absRoot, 'ledger'));
      for (const sub of Object.values(SUBDIR)) fsyncDirBestEffort(path.join(absRoot, sub));
      fsyncDirBestEffort(absRoot);
    }

    // ⑦ 迁移后计数：月份/分类计数有任何变化 → 报错、保留 journal、不刷新总目录
    const afterData = collectCatalogData(absRoot, { nowMs, offsetMinutes: OFFSET_MINUTES });
    result.countsAfter = catalogCounts(afterData);
    for (const k of CATALOG_STABLE_COUNT_KEYS) {
      if (result.countsBefore[k] !== result.countsAfter[k]) {
        result.countDiffs.push({ key: k, before: result.countsBefore[k], after: result.countsAfter[k] });
      }
    }
    result.countsEqual = result.countDiffs.length === 0;

    // ⑧ 迁移成功（计数一致且无失败）→ 把 marker.layoutVersion 提到当前布局版本
    if (result.countsEqual && result.failures.length === 0) {
      const up = ensureRootMarker(absRoot, { nowMs, offsetMinutes: OFFSET_MINUTES, layoutVersion: LAYOUT_VERSION });
      if (up.ok) {
        result.marker.created = result.marker.created || up.created;
        result.marker.updated = result.marker.updated || up.updated;
        if (up.marker) result.marker.rootId = up.marker.rootId;
      } else {
        result.failures.push({ reason: up.reason || 'E_MARKER_WRITE', detail: up.detail || '' });
      }
    }

    // ⑨ 刷新《账簿总目录.md》（只在计数一致时写）
    if (result.countsEqual) {
      result.catalog = writeCatalog(absRoot, { nowMs, offsetMinutes: OFFSET_MINUTES, data: afterData });
    } else {
      result.catalog = {
        ok: false, path: path.join(absRoot, '账簿总目录.md'), bytes: 0,
        reason: 'E_COUNT_MISMATCH',
        detail: '迁移前后计数不一致：保留 journal，未刷新总目录（先查 countDiffs）',
      };
    }

    const blocking = result.failures.length > 0
      || result.conflicts.length > 0
      || result.unknown.length > 0
      || !result.countsEqual
      || !(result.catalog && result.catalog.ok);
    result.exitCode = blocking ? 2 : 0;
    result.ok = result.exitCode === 0;
    if (result.ok) {
      result.note = plan.moves.length
        ? `迁移完成：搬 ${result.moved.length} 份，journal 已落盘，总目录已刷新。`
        : '无事可搬（已在新布局）；总目录已刷新。';
    } else {
      result.note = '迁移未完全成功：见 failures/conflicts/unknown/countDiffs；journal 保留，可用 --rollback 还原。';
    }
    return result;
  } catch (e) {
    result.exitCode = 1;
    result.blockers.push('E_INTERNAL');
    result.failures.push({ reason: 'E_INTERNAL', detail: errDetail(e) });
    result.note = '内部错误：见 failures。已落盘的 journal 保留，可人工核对。';
    return result;
  } finally {
    try { release(lock); } catch { /* 释放失败：锁会按心跳过期，不影响本次结果 */ }
  }
}

// ============================================================================
// 五、--rollback（按 journal 反向 rename）
// ============================================================================

/**
 * 校验 journal 形状与路径边界（**只读**；不信任外部 journal）。
 *
 * @param {string} absRoot 账库根
 * @param {string} journalPath journal 绝对路径
 * @returns {{ok:boolean, entries:Array<object>, errors:Array<object>}}
 *
 * @why 路径必须双向限制在 root 内、且 new 必须落在分类子目录、old 必须直接在一级：
 *      一份被伪造/挪用的 journal 不能变成"任意文件搬运器"。
 * @why 归属比较用 `canonicalPath`（realpath）而不是字符串：`--rollback` 只给 journal 时
 *      根是推出来的，journal 里的绝对路径可能是 Windows 8.3 短名/大小写不同写法；
 *      不规范化会把同一账库误判成"串库"。
 */
function validateJournal(absRoot, journalPath) {
  const errors = [];
  const entries = [];
  let text;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch (e) {
    return { ok: false, errors: [{ reason: 'E_JOURNAL_READ', detail: errDetail(e) }], entries: [] };
  }
  const rawLines = text.split('\n').filter((l) => l.trim());
  if (rawLines.length === 0) return { ok: false, errors: [{ reason: 'E_JOURNAL_EMPTY' }], entries: [] };
  const rootCanonical = canonicalPath(absRoot);
  const seenOld = new Set();
  const seenNew = new Set();
  rawLines.forEach((line, idx) => {
    const lineNo = idx + 1;
    let obj = null;
    try { obj = JSON.parse(line); } catch (e) {
      errors.push({ reason: 'E_JOURNAL_JSON', line: lineNo, detail: errDetail(e) });
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      errors.push({ reason: 'E_JOURNAL_SHAPE', line: lineNo, detail: '不是对象' });
      return;
    }
    if (typeof obj.old !== 'string' || !obj.old || typeof obj.new !== 'string' || !obj.new) {
      errors.push({ reason: 'E_JOURNAL_SHAPE', line: lineNo, detail: 'old/new 必须是绝对路径字符串' });
      return;
    }
    if (typeof obj.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.sha256)) {
      errors.push({ reason: 'E_JOURNAL_SHAPE', line: lineNo, detail: 'sha256 不是 64 位小写 hex' });
      return;
    }
    if (!Number.isInteger(obj.bytes) || obj.bytes < 0) {
      errors.push({ reason: 'E_JOURNAL_SHAPE', line: lineNo, detail: 'bytes 必须是非负整数' });
      return;
    }
    if (typeof obj.at !== 'string' || !obj.at) {
      errors.push({ reason: 'E_JOURNAL_SHAPE', line: lineNo, detail: 'at 必须是时间字符串' });
      return;
    }
    const oldAbs = path.resolve(obj.old);
    const newAbs = path.resolve(obj.new);
    const oldParent = path.dirname(oldAbs);
    // old 必须直接位于"这个根"下：用 realpath 规范化后比较（解 8.3 短名/大小写/符号链接）
    if (canonicalPath(oldParent) !== rootCanonical) {
      errors.push({
        reason: 'E_JOURNAL_OUTSIDE_ROOT', line: lineNo, old: oldAbs,
        detail: 'old 必须直接位于账库根下（该 journal 属于别的账库？）',
      });
      return;
    }
    // new 必须是 <同一个根>/<交接表|清册|体检>/<原文件名>：用该条自己的 old 目录拼，写法天然一致
    const expectedParents = new Set(Object.values(SUBDIR).map((s) => pathKey(path.join(oldParent, s))));
    if (!expectedParents.has(pathKey(path.dirname(newAbs))) || path.basename(newAbs) !== path.basename(oldAbs)) {
      errors.push({
        reason: 'E_JOURNAL_BAD_TARGET', line: lineNo, new: newAbs,
        detail: 'new 必须是 <根>/<交接表|清册|体检>/<原文件名>',
      });
      return;
    }
    // 规范化为真实路径（解 8.3 短名）：回退动作/输出/哈希校验都按真实路径走，
    // 与 journal 当时用的是短名还是长名无关。
    const oldReal = path.join(realPathOrSelf(oldParent), path.basename(oldAbs));
    const newReal = path.join(realPathOrSelf(path.dirname(newAbs)), path.basename(newAbs));
    if (seenOld.has(pathKey(oldReal)) || seenNew.has(pathKey(newReal))) {
      errors.push({ reason: 'E_JOURNAL_DUPLICATE', line: lineNo, old: oldReal, new: newReal });
      return;
    }
    seenOld.add(pathKey(oldReal));
    seenNew.add(pathKey(newReal));
    entries.push({ old: oldReal, new: newReal, sha256: obj.sha256, bytes: obj.bytes, at: obj.at });
  });
  return { ok: errors.length === 0, entries, errors };
}

/**
 * 回退预检（**零写**）：把 journal 每一条分成"要还原 / 已还原 / 冲突"三堆。
 *
 * @param {Array<object>} entries 校验后的 journal 条目
 * @returns {{toRestore:Array<object>, alreadyRestored:Array<object>, conflicts:Array<object>}}
 *
 * @why "已还原"是合法的幂等状态：journal 登记后 rename 前崩溃 → new 不存在、old 在且哈希对；
 *      回退脚本必须把它当"这一条已经没事"，而不是报"源文件缺失"。
 */
function planRollback(entries) {
  const toRestore = [];
  const alreadyRestored = [];
  const conflicts = [];
  for (const e of entries) {
    const newExists = isFile(e.new);
    const oldExists = isFile(e.old);
    if (newExists) {
      let sha = '';
      try { sha = sha256File(e.new); } catch { sha = ''; }
      if (sha !== e.sha256) {
        conflicts.push({ reason: 'SHA_MISMATCH', old: e.old, new: e.new, expected: e.sha256, actual: sha });
        continue;
      }
      if (oldExists) {
        conflicts.push({ reason: 'TARGET_EXISTS', old: e.old, new: e.new });
        continue;
      }
      toRestore.push(e);
      continue;
    }
    if (oldExists) {
      let sha = '';
      try { sha = sha256File(e.old); } catch { sha = ''; }
      if (sha !== e.sha256) {
        conflicts.push({ reason: 'SHA_MISMATCH_AT_OLD', old: e.old, new: e.new, expected: e.sha256, actual: sha });
        continue;
      }
      alreadyRestored.push(e);
      continue;
    }
    conflicts.push({ reason: 'MISSING_BOTH', old: e.old, new: e.new });
  }
  return { toRestore, alreadyRestored, conflicts };
}

/** `.done` 文件名唯一化（同一天多次回退不覆盖旧证据）。 */
function uniqueDonePath(journalPath) {
  let candidate = `${journalPath}.done`;
  for (let i = 1; fs.existsSync(candidate); i += 1) candidate = `${journalPath}.done-${i}`;
  return candidate;
}

/**
 * 按 journal 反向 rename 回退（`--rollback=<journal>`）。
 *
 * @param {string} root 账库根
 * @param {string} journalPath journal 路径
 * @param {{nowMs?:number}} [opts]
 * @returns {object} 机读结果（含 `mode:'rollback'`、`exitCode`、`restored`、`journalDone`）
 *
 * @why 先整批预检、全部可回退才动手：回退是"收拾残局"的动作，
 *      最怕做到一半停下 —— 那会把状态从"可回退"变成"要人工拼"。
 * @why `root` 不要求调用方从命令行给：journal 固定落在 `<root>/ledger/` 下，
 *      CLI 可由 `<journal 所在目录>/..` 推出根（见 `main`）；本函数只做"给根 + journal 就回退"，
 *      并用 journal 里逐条的绝对路径反查归属（路径必须落在 root 内），不依赖外部提示。
 */
export function runRollback(root, journalPath, opts = {}) {
  const absRoot = path.resolve(root);
  const absJournal = path.resolve(journalPath);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const result = {
    ok: false,
    mode: 'rollback',
    root: absRoot,
    journal: { path: absJournal, lines: 0 },
    exitCode: 0,
    restored: [],
    alreadyRestored: [],
    conflicts: [],
    failures: [],
    removedEmptyDirs: [],
    catalog: null,
    journalDone: '',
    note: '',
  };

  // ① 校验 journal（只读，先于取锁）
  const j = validateJournal(absRoot, absJournal);
  result.journal.lines = j.entries.length;
  if (!j.ok) {
    result.exitCode = 2;
    result.conflicts = j.errors;
    result.note = 'journal 校验失败：未做任何回退（零写）。';
    return result;
  }

  // ② 取锁（回退也是写操作）
  let lock;
  try {
    lock = acquire(absRoot);
  } catch (e) {
    result.exitCode = 2;
    result.failures.push({ reason: 'E_LEDGER_LOCK_ACQUIRE', detail: errDetail(e) });
    return result;
  }
  if (!lock.acquired) {
    result.exitCode = 2;
    result.conflicts.push({ reason: 'E_LEDGER_LOCKED' });
    result.note = '账库正被另一个进程持有锁，未做任何回退。';
    return result;
  }

  try {
    // ③ 零写预检
    const pre = planRollback(j.entries);
    result.alreadyRestored = pre.alreadyRestored.map((e) => ({ old: e.old, new: e.new, sha256: e.sha256 }));
    if (pre.conflicts.length > 0) {
      result.exitCode = 2;
      result.conflicts = pre.conflicts;
      result.note = '回退预检发现冲突：未做任何回退（零写）。';
      return result;
    }

    // ④ 反向 rename + 每条复算 sha256
    for (const e of pre.toRestore.slice().reverse()) {
      try {
        fs.renameSync(e.new, e.old);
      } catch (err) {
        result.failures.push({ old: e.old, new: e.new, reason: (err && err.code) || 'E_RENAME', detail: errDetail(err) });
        break;
      }
      let sha = '';
      try { sha = sha256File(e.old); } catch { sha = ''; }
      if (sha !== e.sha256) {
        // 还原后字节不符（不该发生）：把文件搬回 new，停下等人工核对
        try { fs.renameSync(e.old, e.new); } catch { /* ignore */ }
        result.failures.push({ old: e.old, new: e.new, reason: 'POST_RESTORE_SHA_MISMATCH', expected: e.sha256, actual: sha });
        break;
      }
      result.restored.push({ name: path.basename(e.old), old: e.old, new: e.new, sha256: e.sha256 });
    }

    if (result.failures.length > 0) {
      result.exitCode = 2;
      result.note = '回退中途失败：journal 保留未改名，请按 failures 人工核对（已还原的文件仍在正确位置）。';
      return result;
    }

    fsyncDirBestEffort(absRoot);
    // ⑤ 清理**空**的分类子目录（rename 不会自动删目录；空的分类目录属迁移副产品）
    for (const sub of Object.values(SUBDIR)) {
      const dir = path.join(absRoot, sub);
      try {
        fs.rmdirSync(dir);
        result.removedEmptyDirs.push(sub);
      } catch { /* 非空/不存在：保留（不能删别人放进去的东西） */ }
    }

    // ⑥ 刷新总目录（导航文件，回退后保持与实际一致）
    result.catalog = writeCatalog(absRoot, { nowMs, offsetMinutes: OFFSET_MINUTES });

    // ⑦ journal 改名 .done（证据保留，不删除）
    const done = uniqueDonePath(absJournal);
    try {
      fs.renameSync(absJournal, done);
      result.journalDone = done;
    } catch (e) {
      result.failures.push({ reason: 'E_JOURNAL_RENAME', detail: errDetail(e) });
    }

    const blocking = result.failures.length > 0 || !(result.catalog && result.catalog.ok);
    result.exitCode = blocking ? 2 : 0;
    result.ok = result.exitCode === 0;
    result.note = result.ok
      ? `回退完成：还原 ${result.restored.length} 份（已还原 ${result.alreadyRestored.length} 份跳过），journal 已改名 .done。`
      : '回退文件已还原，但总目录/journal 收尾失败：见 failures。';
    return result;
  } catch (e) {
    result.exitCode = 1;
    result.failures.push({ reason: 'E_INTERNAL', detail: errDetail(e) });
    return result;
  } finally {
    try { release(lock); } catch { /* ignore */ }
  }
}

// ============================================================================
// 六、CLI 输出
// ============================================================================

/** 用法说明。 */
function printUsage() {
  console.log([
    '用法：node docs/工具-迁移布局.mjs --root=<账库根> [--write | --rollback=<journal>] [--create-root] [--json]',
    '      node docs/工具-迁移布局.mjs --rollback=<journal> [--json]   # 回退可不给 --root（自动推根）',
    '',
    '  （默认）dry-run：只打印迁移计划，零写盘',
    '  --write        执行迁移：写 journal → 逐个 rename → 校验 sha256/计数 → 刷新《账簿总目录.md》',
    '                 遇冲突/未知：**已知条目照搬、阻塞条目不搬、退出码 2、journal 保留可 --rollback**',
    '                 （即"部分完成"，不是全有或全无）',
    '  --rollback=<journal>  按 journal 反向 rename 回退（成功后 journal 改名 .done）',
    '                 可单独使用：未给 --root 时根 = <journal 所在目录>/..；',
    '                 给了 --root 则校验 journal 必须在 <root>/ledger/ 下（防拿 A 库 journal 回滚 B 库）',
    '  --create-root  允许对老库补写 .ledger-root（dry-run 时只标记"将会补写"，仍零写盘）',
    '  --json         机读输出（stdout 只有一个 JSON 对象）',
    '',
    '退出码：0 成功；2 冲突/未知/前置不满足/校验失败/部分完成（未写或需人工确认）；1 意外错误。',
    '说明：有阻塞项（冲突/未知）时即使 dry-run 也退出码 2（但 dry-run 仍零写盘）。',
    '安全：只 rename、逐文件 sha256 前后一致；目标已存在/未知文件不搬、退出码 2。',
  ].join('\n'));
}

/** `--json` 或人读输出。 */
function emit(payload, humanLines, json) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of humanLines) console.log(line);
}

/** dry-run 的人读输出。 */
function humanDryRun(r) {
  const lines = [];
  lines.push(`[迁移布局] root = ${r.root}`);
  lines.push(`[迁移布局] 布局检测：版本 ${r.layout.version}` +
    `（旧单据 ${r.layout.oldFileCount} 个；已建子目录 ${r.layout.dirsPresent.length ? r.layout.dirsPresent.join('、') : '无'}）`);
  lines.push('[迁移布局] 根标记：' + (r.marker.usable
    ? `有效（rootId=${r.marker.rootId}）`
    : (r.marker.found ? `损坏（${r.marker.reason}）` : `缺失${r.createRoot ? '（--create-root：写时会补写）' : '（需 --create-root）'}`)));
  if (r.moves.length) {
    lines.push(`[迁移布局] 计划迁移 ${r.moves.length} 个文件（只 rename，sha256 不变）：`);
    for (const m of r.moves) {
      lines.push(`  · ${path.relative(r.root, m.old)} → ${path.relative(r.root, m.new)}` +
        `  （${m.bytes} B，sha256 ${m.sha256.slice(0, 12)}…）`);
    }
  } else {
    lines.push('[迁移布局] 计划迁移 0 个文件（一级已无散落单据）。');
  }
  if (r.conflicts.length) {
    lines.push(`[迁移布局] 冲突 ${r.conflicts.length} 个（**不搬**，退出码 2）：`);
    for (const c of r.conflicts) lines.push(`  ✗ ${c.name || c.old}：${c.reason}${c.detail ? '（' + c.detail + '）' : ''}`);
  }
  if (r.unknown.length) {
    lines.push(`[迁移布局] 未知一级条目 ${r.unknown.length} 个（**不猜、不搬**，退出码 2，请人工确认）：`);
    for (const u of r.unknown) lines.push(`  ? ${u.name}${u.isDirectory ? '/' : ''}（${u.reason}）`);
  }
  if (r.ignored.length) {
    lines.push(`[迁移布局] 忽略 ${r.ignored.length} 个系统/隐藏条目：` + r.ignored.map((x) => x.name).join('、'));
  }
  lines.push('[迁移布局] ' + (r.exitCode === 0
    ? 'dry-run：**未写盘**。确认计划后加 --write 执行。'
    : 'dry-run：存在阻塞项，**未写盘**（见上）。'));
  return lines;
}

/** --write 的人读输出。 */
function humanWrite(r) {
  const lines = [];
  lines.push(`[迁移布局] root = ${r.root}`);
  if (r.blockers.includes('E_LEDGER_LOCKED')) {
    lines.push('[迁移布局] ✗ 账库正被其他进程持有锁，未写任何字节。');
    return lines;
  }
  if (r.blockers.includes('E_LEDGER_ROOT_MARKER_MISSING')) {
    lines.push('[迁移布局] ✗ 根缺 .ledger-root（老库）：加 --create-root 补写标记后才能迁移；本次未写任何字节。');
    return lines;
  }
  if (r.marker.created || r.marker.updated) {
    lines.push(`[迁移布局] 根标记：${r.marker.created ? '已补写' : '已升级 layoutVersion'}` +
      `${r.marker.rootId ? '（rootId=' + r.marker.rootId + '）' : ''}`);
  } else if (r.marker.reason) {
    lines.push(`[迁移布局] ✗ 根标记不可用：${r.marker.reason}（${r.marker.detail || ''}）—— 未动任何单据。`);
    return lines;
  }
  if (r.moved.length) {
    lines.push(`[迁移布局] ✔ 已 rename ${r.moved.length} 个文件（逐文件 sha256 迁移前后一致）：`);
    for (const m of r.moved) lines.push(`  ✔ ${path.relative(r.root, m.new)}（${m.bytes} B，sha256 ${m.sha256.slice(0, 12)}…）`);
  } else {
    lines.push('[迁移布局] 本次没有需要搬的文件。');
  }
  if (r.failures.length) {
    lines.push(`[迁移布局] ✗ 失败 ${r.failures.length} 条：`);
    for (const f of r.failures) lines.push(`  ✗ ${f.name || f.old || f.reason}：${f.reason}${f.detail ? '（' + f.detail + '）' : ''}`);
  }
  if (r.conflicts.length) {
    lines.push(`[迁移布局] 冲突 ${r.conflicts.length} 个（不搬）：`);
    for (const c of r.conflicts) lines.push(`  ✗ ${c.name || c.old}：${c.reason}`);
  }
  if (r.unknown.length) {
    lines.push(`[迁移布局] 未知一级条目 ${r.unknown.length} 个（不搬）：` + r.unknown.map((u) => u.name + (u.isDirectory ? '/' : '')).join('、'));
  }
  if (r.journal.path) lines.push(`[迁移布局] journal：${r.journal.path}（${r.journal.lines} 条，${r.journal.bytes} B）`);
  if (r.countsEqual !== null) {
    lines.push(`[迁移布局] 计数比对：${r.countsEqual ? '✔ 迁移前后一致' : '✗ 不一致'}` +
      (r.countDiffs.length ? '：' + r.countDiffs.map((d) => `${d.key} ${d.before}→${d.after}`).join('；') : ''));
  }
  if (r.catalog) {
    lines.push(r.catalog.ok
      ? `[迁移布局] ✔ 总目录已刷新：${r.catalog.path}（${r.catalog.bytes} B，交接表 ${r.catalog.counts.handover} / 清册 ${r.catalog.counts.cleanup} / 体检 ${r.catalog.counts.checkup}）`
      : `[迁移布局] ✗ 总目录未刷新：${r.catalog.reason}（${r.catalog.detail || ''}）`);
  }
  lines.push('[迁移布局] ' + r.note);
  return lines;
}

/** --rollback 的人读输出。 */
function humanRollback(r) {
  const lines = [];
  lines.push(`[迁移布局] root = ${r.root}`);
  if (r.conflicts.some((c) => c.reason === 'E_LEDGER_LOCKED')) {
    lines.push('[迁移布局] ✗ 账库正被其他进程持有锁，未做任何回退。');
    return lines;
  }
  if (r.conflicts.length && r.restored.length === 0 && r.failures.length === 0) {
    lines.push(`[迁移布局] ✗ journal/预检失败（${r.conflicts.length} 条），未做任何回退：`);
    for (const c of r.conflicts.slice(0, 20)) lines.push(`  ✗ ${c.reason}${c.old ? ' ' + c.old : ''}`);
    lines.push('[迁移布局] ' + r.note);
    return lines;
  }
  lines.push(`[迁移布局] ✔ 已还原 ${r.restored.length} 份；已还原过 ${r.alreadyRestored.length} 份（跳过）。`);
  for (const m of r.restored) lines.push(`  ✔ ${path.relative(r.root, m.old)}（sha256 ${m.sha256.slice(0, 12)}…）`);
  if (r.removedEmptyDirs.length) lines.push(`[迁移布局] 清理空分类子目录：${r.removedEmptyDirs.join('、')}`);
  if (r.catalog) lines.push(r.catalog.ok ? `[迁移布局] ✔ 总目录已刷新：${r.catalog.path}` : `[迁移布局] ✗ 总目录未刷新：${r.catalog.reason}`);
  if (r.failures.length) {
    lines.push(`[迁移布局] ✗ 失败 ${r.failures.length} 条：`);
    for (const f of r.failures) lines.push(`  ✗ ${f.reason}${f.detail ? '（' + f.detail + '）' : ''}`);
  }
  if (r.journalDone) lines.push(`[迁移布局] journal 已改名：${r.journalDone}`);
  lines.push('[迁移布局] ' + r.note);
  return lines;
}

// ============================================================================
// 七、main
// ============================================================================

/** 允许出现的参数（防"敲错参数却静默按 dry-run 跑"）。 */
const ALLOWED_FLAGS = new Set(['--write', '--json', '--create-root', '--help', '-h']);

/** 统一的参数错误输出（`--json` 时也输出机读对象；退出码固定 2）。 */
function argsError(json, detail) {
  const payload = { ok: false, mode: 'args', reason: 'E_ARGS', detail: String(detail || ''), exitCode: 2 };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error('[迁移布局] 参数错误：' + detail + '\n' +
      '用法：node docs/工具-迁移布局.mjs --root=<账库根> [--write | --rollback=<journal>] [--create-root] [--json]');
  }
  return 2;
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {number} 退出码
 *
 * @why `--rollback` 允许**不给 `--root`**：journal 固定落在 `<root>/ledger/` 下，
 *      根可由 `<journal 所在目录>/..` 唯一推出 —— 回退是"收拾残局"的动作，
 *      多要求一个参数只会让人在慌乱时敲错。若显式给了 `--root`，则反过来校验
 *      journal 必须在本库的 `ledger/` 下，防止拿 A 库 journal 回滚 B 库（串库）。
 */
export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return 0;
  }
  const badArgs = argv.filter((a) => a.startsWith('-') && !ALLOWED_FLAGS.has(a) && !a.startsWith('--root=') && !a.startsWith('--rollback='));
  if (badArgs.length > 0 || argv.includes('--root') || argv.includes('--rollback')) {
    return argsError(json, badArgs.length ? badArgs.join('、') : '--root / --rollback 必须写成 --root=<路径> 形式');
  }
  const write = argv.includes('--write');
  const createRoot = argv.includes('--create-root');
  const hasRootArg = argv.some((a) => a.startsWith('--root='));
  const hasRollbackArg = argv.some((a) => a.startsWith('--rollback='));
  const rootArg = argOf(argv, '--root');
  const rollback = argOf(argv, '--rollback');

  if (hasRollbackArg && write) return argsError(json, '--write 与 --rollback 不能同时使用');
  if (hasRootArg && !rootArg) return argsError(json, '--root= 不能为空');
  if (hasRollbackArg && !rollback) return argsError(json, '--rollback= 不能为空');

  // 根：dry-run/--write 必须显式给；--rollback 未给时从 journal 路径推（<journal 所在目录>/..）
  let absRoot = '';
  let rootInferred = false;
  if (hasRootArg) {
    absRoot = path.resolve(rootArg);
  } else if (hasRollbackArg) {
    absRoot = path.resolve(path.dirname(path.resolve(rollback)), '..');
    rootInferred = true;
  } else {
    return argsError(json, '缺少 --root=<账库根>');
  }

  let st = null;
  try { st = fs.statSync(absRoot); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    const detail = '账库根不存在或不是目录' +
      (rootInferred ? '（由 journal 路径推出；journal 应位于 <root>/ledger/ 下）' : '');
    if (json) {
      console.log(JSON.stringify({ ok: false, mode: 'args', root: absRoot, reason: 'E_ROOT_NOT_DIR', detail, exitCode: 2 }, null, 2));
    } else {
      console.error('[迁移布局] ' + detail + '：' + absRoot);
    }
    return 2;
  }

  // 串库防护：显式给了 --root 时，journal 必须在本库 <root>/ledger/ 下
  if (hasRollbackArg && hasRootArg) {
    const journalAbs = path.resolve(rollback);
    const ledgerDir = path.join(absRoot, 'ledger');
    // 用 realpath 规范化后比较：同一目录的 8.3 短名/长名/大小写不同写法不能误判成串库
    if (canonicalPath(path.dirname(journalAbs)) !== canonicalPath(ledgerDir)) {
      return argsError(json, 'journal 必须位于 ' + ledgerDir + ' 下（防止拿别的账库的 journal 回滚本库）：' + journalAbs);
    }
  }

  try {
    if (hasRollbackArg) {
      const r = runRollback(absRoot, rollback, { nowMs: Date.now() });
      if (rootInferred) r.rootInferred = true; // 机读结果里标明"根是推出来的"，方便外部脚本核对
      emit(r, humanRollback(r), json);
      return r.exitCode;
    }
    if (write) {
      const r = runWrite(absRoot, { createRoot, nowMs: Date.now() });
      emit(r, humanWrite(r), json);
      return r.exitCode;
    }
    const r = runDryRun(absRoot, { createRoot });
    emit(r, humanDryRun(r), json);
    return r.exitCode;
  } catch (e) {
    const payload = { ok: false, mode: 'unknown', root: absRoot, reason: 'E_INTERNAL', detail: errDetail(e), exitCode: 1 };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.error('[迁移布局] 内部错误：' + errDetail(e));
    return 1;
  }
}

// 仅当被直接执行时跑 main（被测试 import 时只拿函数，不执行任何动作）
const invokedDirectly = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(SELF_FILE);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  // 用 exitCode 而不是 process.exit：让 stdout 管道把 JSON 写完（spawnSync 读取时才不会截断）
  process.exitCode = main(process.argv.slice(2));
}
