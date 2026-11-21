/**
 * @file layout.js
 * @role **数据总库一级布局**（V0.6.2 / 机主已签《v0.6.2-迁移规格-v1》）的唯一定义处。
 *
 * @why 为什么把"一级目录长什么样"抽成一个模块：
 *   旧版把"交接表/清册/体检"直接散在一级目录里（写端各自 `path.join(root, name)`），
 *   于是"一级目录"这件事在 5 个文件里各写了一遍。V0.6.2 要改成：
 *
 *     <root>/
 *     ├─ 账簿总目录.md      （人读导航，不参与对账）
 *     ├─ YYYY年MM月/        （原文 + 周账，**路径不变**）
 *     ├─ 交接表/            （*启用及交接表*.md 主表 + 附表）
 *     ├─ 清册/              （RPT-*.md / RPT-*-明细.csv / RPT-DRYRUN-*.md）
 *     ├─ 体检/              （CHK-*.md）
 *     ├─ ledger/            （运行区）
 *     └─ .ledger-root       （账库根标记，见 lib/ledgerroot.js）
 *
 *   把"路径规则"集中到一处，才能保证：写端只写新目录、读端双路径兼容、迁移工具与
 *   目录总账用同一套分类 —— 否则三处各写一份规则，迟早互相打脸。
 *
 * @why 读侧必须"双路径"：老库（v0.6.1 及以前）的文件在一级；不能要求用户先迁移才能读。
 *   统一规则：**新目录优先，老位置兜底**（`resolveExisting`）。写端一律写新目录。
 *
 * @scope 本模块只做路径/分类/探测，**不做任何 I/O 写操作**；不读盘内容。
 * @depends node:fs（只用于 exists/readdir 探测）、node:path
 */
import fs from 'node:fs';
import path from 'node:path';

export const LAYOUT_VERSION = 2; // ★ 注意：这是「账库一级目录布局」版本；
// 与 `lib/weekly.js` 的 `LAYOUT_VERSION = 6`（周账封板正文格式）**同名不同义**，
// 同一文件若要同时 import，请用别名（如 weeklyLayout / ROOT_LAYOUT_VERSION）。

/** 账库根标记文件名（隐藏；由 lib/ledgerroot.js 负责读写）。 */
export const ROOT_MARKER_NAME = '.ledger-root';

/** 人读总目录文件名（一级）。 */
export const CATALOG_NAME = '账簿总目录.md';

/** 一级分类子目录名（V0.6.2 起）。 */
export const SUBDIR = Object.freeze({
  handover: '交接表',
  cleanup: '清册',
  checkup: '体检',
});

/** 迁移/总账/清理共用的文件分类（只按文件名，不读内容）。 */
export const FILE_KIND = Object.freeze({
  HANDOVER_MAIN: 'handover-main',
  HANDOVER_APPENDIX: 'handover-appendix',
  CLEANUP_REPORT: 'cleanup-report',
  CLEANUP_APPENDIX: 'cleanup-appendix',
  CLEANUP_DRYRUN: 'cleanup-dryrun',
  CHECKUP_REPORT: 'checkup-report',
  CATALOG: 'catalog',
  MONTH_DIR: 'month-dir',
  RUN_AREA: 'run-area',
  MARKER: 'root-marker',
  UNKNOWN: 'unknown',
});

/** 各 kind 应落的一级子目录（判定"该不该搬"）。 */
export const KIND_SUBDIR = Object.freeze({
  [FILE_KIND.HANDOVER_MAIN]: SUBDIR.handover,
  [FILE_KIND.HANDOVER_APPENDIX]: SUBDIR.handover,
  [FILE_KIND.CLEANUP_REPORT]: SUBDIR.cleanup,
  [FILE_KIND.CLEANUP_APPENDIX]: SUBDIR.cleanup,
  [FILE_KIND.CLEANUP_DRYRUN]: SUBDIR.cleanup,
  [FILE_KIND.CHECKUP_REPORT]: SUBDIR.checkup,
});

// ── 文件名规则（与各写端保持同一份） ─────────────────────────────────────
const RE = {
  handoverMain: /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表\.md$/,
  handoverAppendix: /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表——附表\.md$/,
  cleanupReport: /^RPT-(\d{8})-(\d+)\.md$/,
  cleanupAppendix: /^RPT-(\d{8})-(\d+)-明细\.csv$/,
  cleanupDryrun: /^RPT-DRYRUN-(\d{8})-(\d+)\.md$/,
  checkup: /^CHK-(\d{8})-(\d+)\.md$/,
  monthDir: /^\d{4}年\d{2}月$/,
};

const RUN_AREA = 'ledger';

/** 文件名 → 分类（不认识 → UNKNOWN，迁移工具对它"不猜、不搬"）。 */
export function classifyFileName(name) {
  const n = typeof name === 'string' ? name : '';
  if (n === ROOT_MARKER_NAME) return FILE_KIND.MARKER;
  if (n === CATALOG_NAME) return FILE_KIND.CATALOG;
  if (RE.monthDir.test(n)) return FILE_KIND.MONTH_DIR;
  if (RE.handoverAppendix.test(n)) return FILE_KIND.HANDOVER_APPENDIX;
  if (RE.handoverMain.test(n)) return FILE_KIND.HANDOVER_MAIN;
  if (RE.cleanupAppendix.test(n)) return FILE_KIND.CLEANUP_APPENDIX;
  if (RE.cleanupDryrun.test(n)) return FILE_KIND.CLEANUP_DRYRUN;
  if (RE.cleanupReport.test(n)) return FILE_KIND.CLEANUP_REPORT;
  if (RE.checkup.test(n)) return FILE_KIND.CHECKUP_REPORT;
  return FILE_KIND.UNKNOWN;
}

/** 某个 kind 的"应落子目录名"；无归属返回 ''。 */
export function subdirOfKind(kind) {
  return KIND_SUBDIR[kind] || '';
}

/**
 * 生成某个 kind 文件在**新布局**下的绝对路径。
 * @param {string} root
 * @param {string} kind FILE_KIND.*（只接受有归属的 kind）
 * @param {string} name 文件名
 */
export function newLayoutPath(root, kind, name) {
  const sub = subdirOfKind(kind);
  if (!sub) throw new Error('layout: kind 无归属子目录: ' + kind);
  return path.join(root, sub, name);
}

/** 某个 kind 文件在**老布局**下的绝对路径（一级）。 */
export function oldLayoutPath(root, name) {
  return path.join(root, name);
}

/**
 * 读侧双路径候选：新目录优先，老位置兜底。
 * @returns {string[]} 绝对路径数组（可能都不存在）
 */
export function pathCandidates(root, kind, name) {
  const out = [];
  const sub = subdirOfKind(kind);
  if (sub) out.push(path.join(root, sub, name));
  out.push(path.join(root, name));
  return out;
}

/** 候选里第一个存在的绝对路径；都不存在返回 ''。 */
export function resolveExisting(root, kind, name) {
  for (const p of pathCandidates(root, kind, name)) {
    try { if (fs.existsSync(p)) return p; } catch { /* 探测失败按不存在继续 */ }
  }
  return '';
}

/** 写端用：确保 kind 对应的子目录存在，返回该目录绝对路径（调用方负责写盘）。 */
export function ensureSubdir(root, kind) {
  const sub = subdirOfKind(kind);
  if (!sub) throw new Error('layout: kind 无归属子目录: ' + kind);
  const dir = path.join(root, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 列出 root 第一级条目并按分类标注。
 * @returns {Array<{name:string, abs:string, kind:string, isDirectory:boolean}>}
 */
export function listRootEntries(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    let isDirectory = false;
    try { isDirectory = fs.statSync(path.join(root, name)).isDirectory(); } catch { continue; }
    let kind;
    if (isDirectory) {
      if (name === RUN_AREA) kind = FILE_KIND.RUN_AREA;
      else if (RE.monthDir.test(name)) kind = FILE_KIND.MONTH_DIR;
      else if (Object.values(SUBDIR).includes(name)) kind = FILE_KIND.UNKNOWN; // 子目录内容由各自扫描
      else kind = FILE_KIND.UNKNOWN;
    } else {
      kind = classifyFileName(name);
    }
    out.push({ name, abs: path.join(root, name), kind, isDirectory });
  }
  return out;
}

/**
 * 探测一个根当前处于哪种布局（用于"检测"与迁移前判断）。
 * @returns {{
 *   layoutVersion: 1|2|3,        // 3 = 混合（新目录已建但一级还有旧单据）
 *   dirsPresent: string[],       // 已存在的一级子目录名
 *   oldFiles: Array<{name,kind}> // 一级还残留的"应搬"文件
 *   unknown: string[],           // 一级认不出的文件/目录（不猜不搬）
 *   hasMarker: boolean
 * }}
 */
export function detectLayout(root) {
  const out = { layoutVersion: 1, dirsPresent: [], oldFiles: [], unknown: [], hasMarker: false };
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  const presentSubdirs = new Set();
  for (const name of names) {
    let isDirectory = false;
    try { isDirectory = fs.statSync(path.join(root, name)).isDirectory(); } catch { continue; }
    if (isDirectory) {
      if (Object.values(SUBDIR).includes(name)) presentSubdirs.add(name);
      else if (RE.monthDir.test(name) || name === RUN_AREA) { /* 中性目录，不影响布局判定 */ }
      else out.unknown.push(name);
      continue;
    }
    const kind = classifyFileName(name);
    if (kind === FILE_KIND.MARKER) { out.hasMarker = true; continue; }
    if (KIND_SUBDIR[kind]) { out.oldFiles.push({ name, kind }); continue; }
    if (kind === FILE_KIND.CATALOG) continue; // 总目录可出现在两种布局里
    out.unknown.push(name);
  }
  out.dirsPresent = [...presentSubdirs].sort();
  // ★ 判定口径：有 marker（或总目录）且一级没有散落单据 = **新布局已认领**，
  //   哪怕三个分类子目录还没产出文件（新装库首轮就是这样）。不能报 1 让人误以为旧库。
  const claimed = out.hasMarker || names.includes(CATALOG_NAME);
  if (out.dirsPresent.length === 0 && !claimed) out.layoutVersion = 1;
  else if (out.oldFiles.length === 0) out.layoutVersion = 2;
  else out.layoutVersion = 3;
  return out;
}
