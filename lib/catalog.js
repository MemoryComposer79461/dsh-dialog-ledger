/**
 * @file catalog.js
 * @role 生成**《账簿总目录.md》**（V0.6.2 / 机主已签《v0.6.2-迁移规格-v1》§2.3）：
 *       一级目录的人读导航 + 汇总数字。**不参与对账，不承载账务事实。**
 *
 * @why 为什么需要它：一级目录改了新布局（交接表/清册/体检 子目录）之后，机主打开账库
 *      应该先看到"这个账库有什么、放在哪、最近的单据是哪一份"，而不是一堆子目录名。
 *      它是**导航与索引**：审计永远以台账 / 完整原文 / 周账 / 收据 / 清册为准。
 *
 * @why 为什么数字要在生成时**现场重算**，而不是抄运行报告：抄会把"报告过期"伪装成"现状"。
 *      本模块所有计数都是现场只读扫描（文件系统即事实），这样机主用资源管理器一对照就能复核。
 *
 * @why 写盘原子 + fsync：总目录会被人打开看；半截文件比没有更糟。用
 *      `tmp（fsync）→ rename` 发布，崩溃时读到的要么是旧目录、要么是新目录。
 *
 * @scope 只写 `<root>/账簿总目录.md`；其余全部只读（台账只调 `readAll(...,{repairTornTail:false})`）。
 * @depends node:fs / node:path / ./ledger.js / ./layout.js / ./ledgerroot.js / ./gate.js
 */

import fs from 'node:fs';
import path from 'node:path';

import { readAll, stampLocal } from './ledger.js';
import {
  CATALOG_NAME, FILE_KIND, SUBDIR, classifyFileName, detectLayout,
} from './layout.js';
import { readRootMarker } from './ledgerroot.js';
import { GATE_CONCLUSIONS } from './gate.js';

/** 总目录结构版本（内容结构变更时 +1）。 */
export const CATALOG_VERSION = 1;

/**
 * 迁移前后必须**完全相等**的计数键（《v0.6.2-迁移规格-v1》§三.5：
 * "迁移结束自动重算一遍月份计数 + 分类计数并与迁移前比，任何变化 → 报错并保留 journal"）。
 * 布局版本/对账结论不在此列（布局版本本来就会变，对账结论是另一维度的事实）。
 */
export const CATALOG_STABLE_COUNT_KEYS = Object.freeze([
  'months', 'originals', 'weeklies', 'handover', 'cleanup', 'checkup', 'ledgerRows',
]);

// ============================================================================
// 〇、总目录/容量预算阈值（**只告警，不删、不跳过、不改 md 格式**）
// ============================================================================

/**
 * @role 总目录的**预算阈值**（0.9.4-P3 扩容方案 §4.4 总目录预算 + §4.5 容量上限与告警 +
 *       S-9 C24 三年体积模型）。全部是**模块内常量，不新增配置键**（纪律同 0.9.3）。
 *
 * @why 总目录每天全量重扫 + `readAll` 全账，到量必死（§4.4：3 年 6.94M 文件 ≈8 min/次，
 *      远超 tick 30 s 预算；`readAll` 3 年 heap ≈4.0 GB 撞 500 MB 预算）。0.9.4-snap 只做
 *      "让墙可见"：超阈值**只写进返回值 `budget.warn[]`**，由调用方/人决定处置。
 *      **硬规则：本模块不删任何文件、不移、不跳过、不改 md 路径与格式**；告警只回答
 *      "什么时候会撞墙"（§4.5 硬规则）。真正的"超预算跳过"接线在 index.js（不在本文件改）。
 *
 * @why 阈值出处全部可追溯，不许自己定数：
 *      · `scanFilesWarn`  ← §4.4 `CATALOG_MAX_FILES=200_000`（68.8 µs/文件 → ≈13.8 s/次）
 *      · `ledgerRowsWarn/Red` ← §4.5 台账行数 warn 150,000 / red 330,000（readAll 成本线）
 *      · `totalBytesWarn/Red` ← S-9 C24 三年 ≈363 GiB；warn = 80%（291 GiB）
 *      · 单位：GiB（S-9 C24 的 1024 体系；方案 §4.7(a) 明写"363 GB 按 GiB 计"）
 */
export const CATALOG_BUDGET = Object.freeze({
  /** 总目录单次扫描文件数 warn（§4.4 总目录预算）。 */
  scanFilesWarn: 200_000,
  /** 台账行数 warn / red（§4.5 容量上限与告警）。 */
  ledgerRowsWarn: 150_000,
  ledgerRowsRed: 330_000,
  /** 账库总字节 warn / red（S-9 C24：363 GiB；warn = 80% = 291 GiB）。 */
  totalBytesWarn: 291 * 1024 * 1024 * 1024,
  totalBytesRed: 363 * 1024 * 1024 * 1024,
});

/** GiB（1024 体系）→ 人读字符串（告警文案用；与 doctor `fmtBytes` 同口径但不跨包依赖）。 */
function fmtGiB(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '?';
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * 由现场计量值构造 `budget`（**纯函数**，不读盘；单测可直接喂合成值验阈值）。
 *
 * @param {{rows:number, files:number, bytes:number}} metrics 现场计量
 *        `rows`=台账行数；`files`=本次总目录扫描到的文件数；`bytes`=同集合的字节和
 * @returns {{rows:number, files:number, bytes:number, warn:string[]}}
 *
 * @why 告警只进数组、不进 md：总目录是"人读导航"，加容量表会改格式（§4.4 禁改）；
 *      容量处置（删/移/压缩）一律不由本模块做（§4.6：默认不动用户数据）。
 */
export function buildCatalogBudget(metrics = {}) {
  const rows = Number.isFinite(Number(metrics.rows)) ? Math.max(0, Number(metrics.rows)) : 0;
  const files = Number.isFinite(Number(metrics.files)) ? Math.max(0, Number(metrics.files)) : 0;
  const bytes = Number.isFinite(Number(metrics.bytes)) ? Math.max(0, Number(metrics.bytes)) : 0;
  const warn = [];
  if (rows >= CATALOG_BUDGET.ledgerRowsRed) {
    warn.push(`[red] 台账行数 ${rows} ≥ ${CATALOG_BUDGET.ledgerRowsRed}（方案 §4.5 red；readAll 一次的成本线，3 年 heap 撞 500 MB 预算）`);
  } else if (rows >= CATALOG_BUDGET.ledgerRowsWarn) {
    warn.push(`[warn] 台账行数 ${rows} ≥ ${CATALOG_BUDGET.ledgerRowsWarn}（方案 §4.5 warn；readAll 内存/耗时随行数线性增长）`);
  }
  if (files >= CATALOG_BUDGET.scanFilesWarn) {
    warn.push(`[warn] 总目录扫描文件数 ${files} ≥ ${CATALOG_BUDGET.scanFilesWarn}（方案 §4.4 总目录预算；68.8 µs/文件 → 预估 ${((files * 68.8) / 1e6).toFixed(1)} s/次，超 tick 30 s 与单次 2 s 预算）`);
  }
  if (bytes >= CATALOG_BUDGET.totalBytesRed) {
    warn.push(`[red] 账库体积 ${fmtGiB(bytes)} ≥ ${fmtGiB(CATALOG_BUDGET.totalBytesRed)}（S-9 C24 三年模型上限）`);
  } else if (bytes >= CATALOG_BUDGET.totalBytesWarn) {
    warn.push(`[warn] 账库体积 ${fmtGiB(bytes)} ≥ 80% 的三年模型 ${fmtGiB(CATALOG_BUDGET.totalBytesWarn)}（S-9 C24 ≈363 GiB）`);
  }
  // 告警按严重度排序（red 在前），方便人先看最要命的
  warn.sort((a, b) => (a.startsWith('[red]') === b.startsWith('[red]') ? 0 : a.startsWith('[red]') ? -1 : 1));
  return { rows, files, bytes, warn };
}

/** 月份目录名：`YYYY年MM月`（二级目录，路径不变）。 */
const MONTH_DIR_RE = /^(\d{4})年(\d{2})月$/;

/** 周记账文件名（与面板/周账写端同一规则）：`MM月第W周-{S}{D}的周记账.xlsx`。 */
const WEEKLY_FILE_RE = /^\d{2}月第\d+周-.+的周记账\.xlsx$/;

/** 第 3 级"完整原文"文件名：`<code>[.vN] 完整原文.md`（版本不重复计份）。 */
const ORIGINAL_VIEW_RE = /^([0-9]{8}-[0-9a-z]{12}-[A-Z]-[0-9]{8})(?:\.v(\d+))? 完整原文\.md$/;

/** 运行报告文件名：`<root>/ledger/.run-report-YYYYMMDD.json`。 */
const RUN_REPORT_RE = /^\.run-report-(\d{4})(\d{2})(\d{2})\.json$/;

/** 交接表编号：12 位 Session ID + 1 位代差。 */
const HANDOVER_CODE_RE = /^([0-9a-z]{12}[A-Z])/;

/** 清册正式编号：`RPT-YYYYMMDD-NN[.md|-明细.csv]`。 */
const RPT_ID_RE = /^RPT-(\d{8})-(\d+)(?:-明细)?\.(?:md|csv)$/;

/** 清册 dry-run 编号：`RPT-DRYRUN-YYYYMMDD-NN.md`。 */
const RPT_DRYRUN_ID_RE = /^RPT-DRYRUN-(\d{8})-(\d+)\.md$/;

/** 体检编号：`CHK-YYYYMMDD-NN.md`。 */
const CHK_ID_RE = /^CHK-(\d{8})-(\d+)\.md$/;

/** 分类 → 组成它的文件 kind。 */
const CATEGORY_KINDS = Object.freeze({
  handover: [FILE_KIND.HANDOVER_MAIN, FILE_KIND.HANDOVER_APPENDIX],
  cleanup: [FILE_KIND.CLEANUP_REPORT, FILE_KIND.CLEANUP_APPENDIX, FILE_KIND.CLEANUP_DRYRUN],
  checkup: [FILE_KIND.CHECKUP_REPORT],
});

/** 文件 kind → 所属分类（不认识的 kind 不参与分类计数）。 */
const KIND_TO_CATEGORY = (() => {
  const m = {};
  for (const [cat, kinds] of Object.entries(CATEGORY_KINDS)) for (const k of kinds) m[k] = cat;
  return m;
})();

/** 布局版本的人读标签。 */
const LAYOUT_LABEL = Object.freeze({
  1: '老布局（单据仍在一级目录）',
  2: '新布局（单据已在分类子目录）',
  3: '混合（新子目录已建，一级仍有旧单据）',
});

// ============================================================================
// 一、小工具（只读）
// ============================================================================

/** 毫秒 → 契约时间 `YYYY-MM-DD HH:mm:ss +08:00`（无 Z）。 */
function stampWithOffset(ms, offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const suffix = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${stampLocal(ms, off)} ${suffix}`;
}

/** 安全 readdir（读不了 = 空，一个坏目录不能把整份总目录打挂）。 */
function safeReaddir(dir, opts) {
  try { return fs.readdirSync(dir, opts); } catch { return []; }
}

/** 目录下第一级**普通文件**名（排序；不跟随符号链接）。 */
function listFileNames(dir) {
  const out = [];
  for (const e of safeReaddir(dir, { withFileTypes: true })) {
    if (e.isFile() && !e.isSymbolicLink()) out.push(e.name);
  }
  out.sort();
  return out;
}

/** 文件 mtime（毫秒）；读不到返回 -1（当作"未知/最旧"）。 */
function mtimeMsOf(abs) {
  try { return fs.statSync(abs).mtimeMs; } catch { return -1; }
}

/**
 * 一次 stat 同时取 mtime 与 size（**预算计量用**：不为 budget 多付一次 syscall）。
 * 读不到 → `{mtimeMs:-1, size:0}`（当作"未知"，不假报体积）。
 */
function statOf(abs) {
  try {
    const st = fs.statSync(abs);
    return { mtimeMs: st.mtimeMs, size: Math.max(0, Number(st.size) || 0) };
  } catch {
    return { mtimeMs: -1, size: 0 };
  }
}

/** 数字按 4 位补零（清册/体检"日期+序号"排序用；一天 9999 份足够）。 */
const pad4 = (n) => String(n).padStart(4, '0');

/** Markdown 表格单元格转义（路径里的 `|` 不能打断表格）。 */
function cell(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 预览编号：`label` 为空时给 `—`。 */
function labelOrDash(label) {
  return label ? '`' + label + '`' : '—';
}

// ============================================================================
// 二、采集：月份 / 分类 / 状态（全部只读）
// ============================================================================

/**
 * 扫一个月份目录：原文份数（按编码去重）、周账份数、最近修改。
 *
 * @param {string} root 账库根
 * @param {string} name 月份目录名（`YYYY年MM月`）
 * @param {number} offsetMinutes 时区偏移
 * @returns {{name:string, originalCount:number, weeklyCount:number, lastModified:string,
 *            files:number, bytes:number}}
 *          `files/bytes` = 本次实际访问到的**全部**普通文件（含隐藏运行痕迹）——总目录预算计量，
 *          只用于 `budget`，不进 md 渲染。
 *
 * @why 原文按**编码去重**：`<code> 完整原文.md` 与 `<code>.v2 完整原文.md` 是同一份
 *      文件的历史版本，替换版本不该让"原文份数"越看越多。
 * @why 预算计量与渲染数字**分开**：`originalCount` 是业务计数（去重），`files` 是扫描成本
 *      （不去重、含隐藏文件）。混用会让"原文份数"被预算口径污染。
 */
function scanMonthDir(root, name, offsetMinutes) {
  const absDir = path.join(root, name);
  const codes = new Set();
  let weeklyCount = 0;
  let lastMs = -1;
  let files = 0;
  let bytes = 0;

  const walk = (dir, depth) => {
    if (depth > 4) return; // 与 reconcile.listArchiveFiles 同口径：防误配到根目录扫穿
    for (const e of safeReaddir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue;
        if (e.name.startsWith('.') || e.name === 'ledger') continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const st = statOf(abs);
      files += 1;
      bytes += st.size;
      if (st.mtimeMs > lastMs) lastMs = st.mtimeMs;
      if (e.name.startsWith('.')) continue; // 隐藏文件是运行痕迹，不算原文（但计入预算计量）
      const m = ORIGINAL_VIEW_RE.exec(e.name);
      if (m) codes.add(m[1]);
      else if (depth === 0 && WEEKLY_FILE_RE.test(e.name)) weeklyCount += 1;
    }
  };
  walk(absDir, 0);

  return {
    name,
    originalCount: codes.size,
    weeklyCount,
    lastModified: lastMs >= 0 ? stampLocal(lastMs, offsetMinutes) : '',
    files,
    bytes,
  };
}

/** 列出根下一级月份目录（排序）。 */
function listMonthDirs(root) {
  const out = [];
  for (const e of safeReaddir(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.isSymbolicLink() && MONTH_DIR_RE.test(e.name)) out.push(e.name);
  }
  out.sort();
  return out;
}

/**
 * 扫三类单据：**新子目录 + 一级老位置**同时数（老库不迁移也要能在总目录里看到）。
 *
 * @param {string} root 账库根
 * @returns {{
 *   categories:{handover:{total,newDir,oldRoot,main,appendix,latest,latestWhere},
 *               cleanup:{total,newDir,oldRoot,report,appendix,dryrun,latest,latestWhere},
 *               checkup:{total,newDir,oldRoot,report,latest,latestWhere}},
 *   scan:{files:number, bytes:number}
 * }}
 *        `scan` = 本次访问到的全部普通文件计数/字节（总目录预算计量，不进 md 渲染）
 */
function scanCategories(root) {
  const count = {
    handover: { main: 0, appendix: 0 },
    cleanup: { report: 0, appendix: 0, dryrun: 0 },
    checkup: { report: 0 },
  };
  const scan = { files: 0, bytes: 0 };
  const where = {
    handover: { newDir: 0, oldRoot: 0 },
    cleanup: { newDir: 0, oldRoot: 0 },
    checkup: { newDir: 0, oldRoot: 0 },
  };
  // 最近一份：交接表按 mtime（编号无日期），清册/体检按"日期+序号"最大值
  const latestHandover = { label: '', mtimeMs: -1, where: '' };
  const latestCleanup = { key: '', label: '', where: '' };
  const latestDryrun = { key: '', label: '', where: '' };
  const latestCheckup = { key: '', label: '', where: '' };

  const considerHandover = (name, abs, loc) => {
    const m = HANDOVER_CODE_RE.exec(name);
    const label = m ? m[1] : name;
    const t = mtimeMsOf(abs);
    if (t > latestHandover.mtimeMs || (t === latestHandover.mtimeMs && label > latestHandover.label)) {
      latestHandover.label = label;
      latestHandover.mtimeMs = t;
      latestHandover.where = loc;
    }
  };
  const considerKeyed = (bucket, key, label, loc) => {
    if (!key) return;
    if (key > bucket.key) { bucket.key = key; bucket.label = label; bucket.where = loc; }
  };

  const add = (kind, name, abs, loc) => {
    const cat = KIND_TO_CATEGORY[kind];
    if (!cat) return;
    where[cat][loc] += 1;
    if (kind === FILE_KIND.HANDOVER_MAIN) { count.handover.main += 1; considerHandover(name, abs, loc); return; }
    if (kind === FILE_KIND.HANDOVER_APPENDIX) { count.handover.appendix += 1; considerHandover(name, abs, loc); return; }
    if (kind === FILE_KIND.CLEANUP_REPORT || kind === FILE_KIND.CLEANUP_APPENDIX) {
      if (kind === FILE_KIND.CLEANUP_REPORT) count.cleanup.report += 1;
      else count.cleanup.appendix += 1;
      const m = RPT_ID_RE.exec(name);
      if (m) considerKeyed(latestCleanup, `${m[1]}-${pad4(m[2])}`, `RPT-${m[1]}-${m[2]}`, loc);
      return;
    }
    if (kind === FILE_KIND.CLEANUP_DRYRUN) {
      count.cleanup.dryrun += 1;
      const m = RPT_DRYRUN_ID_RE.exec(name);
      if (m) considerKeyed(latestDryrun, `${m[1]}-${pad4(m[2])}`, `RPT-DRYRUN-${m[1]}-${m[2]}`, loc);
      return;
    }
    if (kind === FILE_KIND.CHECKUP_REPORT) {
      count.checkup.report += 1;
      const m = CHK_ID_RE.exec(name);
      if (m) considerKeyed(latestCheckup, `${m[1]}-${pad4(m[2])}`, `CHK-${m[1]}-${m[2]}`, loc);
    }
  };

  // ① 一级老位置（所有文件都看；只把认得出的三类计入）
  for (const name of listFileNames(root)) {
    const abs = path.join(root, name);
    const st = statOf(abs);
    scan.files += 1;
    scan.bytes += st.size;
    add(classifyFileName(name), name, abs, 'oldRoot');
  }
  // ② 新子目录（每个子目录只看认得出的三类）
  for (const sub of Object.values(SUBDIR)) {
    for (const name of listFileNames(path.join(root, sub))) {
      const abs = path.join(root, sub, name);
      const st = statOf(abs);
      scan.files += 1;
      scan.bytes += st.size;
      add(classifyFileName(name), name, abs, 'newDir');
    }
  }

  const cleanupLatestLabel = latestCleanup.label || latestDryrun.label;
  const cleanupLatestWhere = latestCleanup.label ? latestCleanup.where : latestDryrun.where;
  return {
    categories: {
      handover: {
        total: count.handover.main + count.handover.appendix,
        newDir: where.handover.newDir,
        oldRoot: where.handover.oldRoot,
        main: count.handover.main,
        appendix: count.handover.appendix,
        latest: latestHandover.label,
        latestWhere: latestHandover.where,
      },
      cleanup: {
        total: count.cleanup.report + count.cleanup.appendix + count.cleanup.dryrun,
        newDir: where.cleanup.newDir,
        oldRoot: where.cleanup.oldRoot,
        report: count.cleanup.report,
        appendix: count.cleanup.appendix,
        dryrun: count.cleanup.dryrun,
        latest: cleanupLatestLabel,
        latestWhere: cleanupLatestWhere,
      },
      checkup: {
        total: count.checkup.report,
        newDir: where.checkup.newDir,
        oldRoot: where.checkup.oldRoot,
        report: count.checkup.report,
        latest: latestCheckup.label,
        latestWhere: latestCheckup.where,
      },
    },
    scan,
  };
}

/**
 * 读台账状态（**只读**：`readAll` 关闭撕裂尾巴自愈，保证生成总目录不改台账一个字节）。
 *
 * @param {string} root
 * @param {number} offsetMinutes
 * @returns {{ledgerRows:number, ledgerFiles:number, ledgerBytes:number, ledgerOk:boolean, badLines:number,
 *            readErrors:number, emptyProven:boolean}}
 *          `ledgerBytes` = 台账 jsonl 字节和（预算计量用；stat 读不到按 0，不假报体积）
 */
function readLedgerStatus(root, offsetMinutes) {
  let all;
  try {
    all = readAll(root, { repairTornTail: false, offsetMinutes });
  } catch (e) {
    return {
      ledgerRows: 0, ledgerFiles: 0, ledgerBytes: 0, ledgerOk: false,
      badLines: 0, readErrors: 1, emptyProven: false, error: (e && e.message) || String(e),
    };
  }
  // 台账字节：只对 readAll 认定的台账文件 stat（不额外 walk、不读内容）
  let ledgerBytes = 0;
  const ledgerDir = path.join(root, 'ledger');
  for (const n of (Array.isArray(all.fileNames) ? all.fileNames : [])) {
    try { ledgerBytes += Number(fs.statSync(path.join(ledgerDir, n)).size) || 0; } catch { /* 读不到按 0 */ }
  }
  return {
    ledgerRows: Array.isArray(all.records) ? all.records.length : 0,
    ledgerFiles: Number(all.files) || 0,
    ledgerBytes,
    ledgerOk: all.ok === true,
    badLines: Number(all.badLines) || 0,
    readErrors: Array.isArray(all.readErrors) ? all.readErrors.length : 0,
    emptyProven: all.emptyProven === true,
  };
}

/**
 * 读最近一次运行报告的闸门结论（`ok/degraded/unknown` + `knownGaps`）。
 *
 * @param {string} root
 * @returns {{conclusion:'ok'|'degraded'|'unknown', knownGaps:string[], reason:string,
 *            evidence:string, runReport:string, generatedAt:string}}
 *
 * @why 没有报告时必须是 `unknown`（"未验证"是事实），**不许**写成 `ok` 冒充"没问题"。
 *      与面板 health.gate 同口径（契约 §0 第 5 条）。
 */
function readGateStatus(root) {
  const dir = path.join(root, 'ledger');
  const names = safeReaddir(dir).filter((n) => RUN_REPORT_RE.test(n)).sort();
  if (names.length === 0) {
    return { conclusion: 'unknown', knownGaps: [], reason: '无运行报告（账库尚未跑过对账）', evidence: 'no-run-report', runReport: '', generatedAt: '' };
  }
  const runReport = names[names.length - 1];
  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(path.join(dir, runReport), 'utf8')); } catch { rep = null; }
  if (!rep || typeof rep !== 'object') {
    return { conclusion: 'unknown', knownGaps: [], reason: '运行报告无法解析', evidence: 'run-report-unreadable', runReport, generatedAt: '' };
  }
  const generatedAt = typeof rep.generatedAt === 'string' ? rep.generatedAt
    : (typeof rep.at === 'string' ? rep.at : '');
  const gate = rep.gate && typeof rep.gate === 'object' && !Array.isArray(rep.gate) ? rep.gate : null;
  let conclusion = gate && typeof gate.conclusion === 'string' && GATE_CONCLUSIONS.includes(gate.conclusion)
    ? gate.conclusion : '';
  const knownGaps = gate && Array.isArray(gate.knownGaps) ? gate.knownGaps.map((x) => String(x)) : [];
  let reason = gate && typeof gate.reason === 'string' ? gate.reason : '';
  if (!conclusion) {
    // 老报告没有 gate 段：退回 reconcile.conclusion（与面板同口径），再不行 unknown
    const rec = rep.reconcile && typeof rep.reconcile === 'object' ? rep.reconcile : null;
    if (rec && typeof rec.conclusion === 'string' && GATE_CONCLUSIONS.includes(rec.conclusion)) conclusion = rec.conclusion;
  }
  if (!conclusion) {
    return { conclusion: 'unknown', knownGaps, reason: reason || '运行报告无 gate 结论（老报告）', evidence: 'run-report-no-gate', runReport, generatedAt };
  }
  return { conclusion, knownGaps, reason, evidence: 'run-report', runReport, generatedAt };
}

// ============================================================================
// 三、采集主函数 / 纯渲染
// ============================================================================

/**
 * 现场采集《账簿总目录》所需的全部数据（**只读**）。
 *
 * @param {string} root 账库根
 * @param {{nowMs?:number, offsetMinutes?:number}} [opts]
 * @returns {{
 *   v:number, root:string, generatedAt:string, rootId:string,
 *   marker:{found:boolean, usable:boolean, reason:string, layoutVersion:number|null},
 *   layout:{version:number, label:string, dirsPresent:string[], oldFileCount:number, unknownCount:number, hasMarker:boolean},
 *   months:Array<{name:string, originalCount:number, weeklyCount:number, lastModified:string, files:number, bytes:number}>,
 *   categories:object,
 *   status:{ledgerRows:number, ledgerFiles:number, ledgerBytes:number, ledgerOk:boolean, badLines:number,
 *           readErrors:number, emptyProven:boolean, gate:object},
 *   budget:{rows:number, files:number, bytes:number, warn:string[]}
 * }}
 *        `budget`（0.9.4-P3 新增）：容量/总目录预算**只告警**——`warn[]` 为空 = 全部低于阈值；
 *        非空也只是"什么时候会撞墙"的提示，本函数不删/不移/不改格式（方案 §4.5 硬规则）。
 *        计量口径：`rows`=台账行数（readAll 实读）；`files`=月份目录+三分类+一级+台账文件数；
 *        `bytes`=同集合字节和（不含 `报告/`、`.index/` 等总目录不扫的目录）。
 */
export function collectCatalogData(root, opts = {}) {
  const absRoot = path.resolve(root);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const offsetMinutes = Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : 480;

  const markerInfo = readRootMarker(absRoot);
  const layoutInfo = detectLayout(absRoot);
  const months = listMonthDirs(absRoot).map((name) => scanMonthDir(absRoot, name, offsetMinutes));
  const { categories, scan } = scanCategories(absRoot);
  const status = {
    ...readLedgerStatus(absRoot, offsetMinutes),
    gate: readGateStatus(absRoot),
  };
  const markerLayoutVersion = markerInfo.marker && Number.isInteger(markerInfo.marker.layoutVersion)
    ? markerInfo.marker.layoutVersion : null;

  // 总目录预算（只告警）：扫描文件数 = 月份目录 + 三分类/一级 + 台账文件
  const scanFiles = months.reduce((n, m) => n + (Number(m.files) || 0), 0)
    + (Number(scan.files) || 0) + (Number(status.ledgerFiles) || 0);
  const scanBytes = months.reduce((n, m) => n + (Number(m.bytes) || 0), 0)
    + (Number(scan.bytes) || 0) + (Number(status.ledgerBytes) || 0);
  const budget = buildCatalogBudget({ rows: status.ledgerRows, files: scanFiles, bytes: scanBytes });

  return {
    v: CATALOG_VERSION,
    root: absRoot,
    generatedAt: stampWithOffset(nowMs, offsetMinutes),
    rootId: markerInfo.marker ? markerInfo.marker.rootId : '',
    marker: {
      found: markerInfo.found,
      usable: !!markerInfo.marker,
      reason: markerInfo.reason,
      layoutVersion: markerLayoutVersion,
    },
    layout: {
      version: layoutInfo.layoutVersion,
      label: LAYOUT_LABEL[layoutInfo.layoutVersion] || LAYOUT_LABEL[1],
      dirsPresent: layoutInfo.dirsPresent,
      oldFileCount: layoutInfo.oldFiles.length,
      unknownCount: layoutInfo.unknown.length,
      hasMarker: layoutInfo.hasMarker,
    },
    months,
    categories,
    status,
    budget,
  };
}

/**
 * 从采集结果里取"可比对计数"（迁移前后必须相等的那组数字）。
 *
 * @param {object} data `collectCatalogData()` 的返回值
 * @returns {{layoutVersion:number, months:number, originals:number, weeklies:number,
 *            handover:number, cleanup:number, checkup:number, ledgerRows:number, gate:string}}
 */
export function catalogCounts(data) {
  const months = Array.isArray(data && data.months) ? data.months : [];
  const cats = data && data.categories && typeof data.categories === 'object' ? data.categories : {};
  const total = (cat, key) => (cat && Number.isFinite(Number(cat[key])) ? Number(cat[key]) : 0);
  const status = data && data.status && typeof data.status === 'object' ? data.status : {};
  const gate = status.gate && typeof status.gate === 'object' ? status.gate.conclusion : 'unknown';
  return {
    layoutVersion: data && data.layout ? Number(data.layout.version) || 0 : 0,
    months: months.length,
    originals: months.reduce((n, m) => n + (Number(m.originalCount) || 0), 0),
    weeklies: months.reduce((n, m) => n + (Number(m.weeklyCount) || 0), 0),
    handover: total(cats.handover, 'total'),
    cleanup: total(cats.cleanup, 'total'),
    checkup: total(cats.checkup, 'total'),
    ledgerRows: Number(status.ledgerRows) || 0,
    gate: typeof gate === 'string' ? gate : 'unknown',
  };
}

/**
 * 渲染《账簿总目录.md》全文（**纯函数**：不读盘、不写盘）。
 *
 * @param {object} data `collectCatalogData()` 的返回值
 * @returns {string} Markdown（LF 换行，末尾带换行）
 */
export function renderCatalog(data) {
  const d = data && typeof data === 'object' ? data : collectEmptyDataFallback();
  const counts = catalogCounts(d);
  const months = Array.isArray(d.months) ? d.months : [];
  const cats = d.categories && typeof d.categories === 'object' ? d.categories : {};
  const handover = cats.handover || {};
  const cleanup = cats.cleanup || {};
  const checkup = cats.checkup || {};
  const status = d.status && typeof d.status === 'object' ? d.status : {};
  const gate = status.gate && typeof status.gate === 'object' ? status.gate : { conclusion: 'unknown', knownGaps: [], reason: '', evidence: 'no-run-report', runReport: '', generatedAt: '' };
  const markerText = d.marker && d.marker.usable
    ? '有效'
    : (d.marker && d.marker.found ? '损坏（`' + (d.marker.reason || 'E_MARKER_INVALID') + '`）' : '缺失（老库，需补写）');
  const layoutVersionText = `${counts.layoutVersion} · ${(d.layout && d.layout.label) || LAYOUT_LABEL[counts.layoutVersion] || '未知'}` +
    (d.marker && d.marker.layoutVersion ? `（marker layoutVersion=${d.marker.layoutVersion}）` : '');

  const lines = [];
  lines.push('# 账簿总目录');
  lines.push('');
  lines.push('> 本文件是**人读导航**，**不是账务记录本身**，不参与对账。');
  lines.push('> 审计以台账、完整原文、周记账、收据与清册为准；本文件可随时删除重建（生成器：`lib/catalog.js`）。');
  lines.push('');

  // ── 一、账库 ─────────────────────────────────────────────────────────────
  lines.push('## 一、账库');
  lines.push('');
  lines.push('| 项目 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 账库根路径 | \`${cell(d.root || '')}\` |`);
  lines.push(`| rootId | ${d.rootId ? '`' + cell(d.rootId) + '`' : '—（无标记）'} |`);
  lines.push(`| 布局版本 | ${cell(layoutVersionText)} |`);
  lines.push(`| \`.ledger-root\` | ${cell(markerText)} |`);
  lines.push(`| 生成时间 | ${cell(d.generatedAt || '')} |`);
  lines.push('');

  // ── 二、月份目录 ─────────────────────────────────────────────────────────
  lines.push('## 二、月份目录（原文 / 周账）');
  lines.push('');
  lines.push('| 月份 | 原文份数 | 周账份数 | 最近修改 |');
  lines.push('|---|---:|---:|---|');
  if (months.length === 0) {
    lines.push('| （无月份目录） | — | — | — |');
  } else {
    for (const m of months) {
      lines.push(`| ${cell(m.name)} | ${Number(m.originalCount) || 0} | ${Number(m.weeklyCount) || 0} | ${cell(m.lastModified || '—')} |`);
    }
    lines.push(`| **合计** | **${counts.originals}** | **${counts.weeklies}** | — |`);
  }
  lines.push('');
  lines.push('> 原文按「完整原文」编码去重（`.vN` 历史版本只算一份）；周账按 `NN月第W周-…的周记账.xlsx` 计。');
  lines.push('');

  // ── 三、分类单据 ─────────────────────────────────────────────────────────
  lines.push('## 三、分类单据');
  lines.push('');
  lines.push('| 分类 | 份数 | 新目录 | 一级老位置 | 明细 | 最近一份编号 |');
  lines.push('|---|---:|---:|---:|---|---|');
  const handoverDetail = `主表 ${Number(handover.main) || 0} / 附表 ${Number(handover.appendix) || 0}`;
  const cleanupDetail = `清册 ${Number(cleanup.report) || 0} / 明细 ${Number(cleanup.appendix) || 0} / dry-run ${Number(cleanup.dryrun) || 0}`;
  const checkupDetail = '—';
  lines.push(`| 交接表 | ${counts.handover} | ${Number(handover.newDir) || 0} | ${Number(handover.oldRoot) || 0} | ${handoverDetail} | ${labelOrDash(handover.latest)} |`);
  lines.push(`| 清册 | ${counts.cleanup} | ${Number(cleanup.newDir) || 0} | ${Number(cleanup.oldRoot) || 0} | ${cleanupDetail} | ${labelOrDash(cleanup.latest)} |`);
  lines.push(`| 体检 | ${counts.checkup} | ${Number(checkup.newDir) || 0} | ${Number(checkup.oldRoot) || 0} | ${checkupDetail} | ${labelOrDash(checkup.latest)} |`);
  lines.push('');
  lines.push('> 「新目录」= `交接表/`、`清册/`、`体检/`；「一级老位置」= 尚未迁移的旧布局文件（读侧双路径兼容：不迁移也能读）。');
  lines.push('> 「最近一份编号」：交接表取最近修改时间的 13 位编号（12 位 Session ID + 代差）；清册/体检取日期+序号最大者（清册无正式报告时用 dry-run 编号兜底）。');
  lines.push('');

  // ── 四、账务状态 ─────────────────────────────────────────────────────────
  const ledgerRows = Number(status.ledgerRows) || 0;
  const ledgerFiles = Number(status.ledgerFiles) || 0;
  const readable = status.ledgerOk === true ? '是' : '否';
  const badLines = Number(status.badLines) || 0;
  const gapText = Array.isArray(gate.knownGaps) && gate.knownGaps.length ? gate.knownGaps.join('；') : '（无）';
  const runReportText = gate.runReport
    ? '`ledger/' + cell(gate.runReport) + '`' + (gate.generatedAt ? '（' + cell(gate.generatedAt) + '）' : '')
    : '无运行报告（尚未跑过对账）';
  lines.push('## 四、账务状态（只读快照）');
  lines.push('');
  lines.push('| 项目 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 台账行数 | ${ledgerRows}（文件 ${ledgerFiles} 个；可读=${readable}；坏行 ${badLines}） |`);
  lines.push(`| 最近对账结论 | \`${cell(gate.conclusion || 'unknown')}\` |`);
  lines.push(`| knownGaps | ${cell(gapText)} |`);
  if (gate.conclusion === 'unknown' && gate.reason) {
    lines.push(`| 无法表示意见的原因 | ${cell(gate.reason)} |`);
  }
  lines.push(`| 判定依据 | ${runReportText} |`);
  lines.push('');
  lines.push('> `ok` = 无保留；`degraded` = 有保留（knownGaps 可枚举）；`unknown` = 无法表示意见（台账没读全 / 没有运行报告 / 链断等）。');
  lines.push('');

  // ── 五、声明 ─────────────────────────────────────────────────────────────
  lines.push('## 五、声明');
  lines.push('');
  lines.push('**本文件不是账务记录本身。** 它只是人读导航与汇总数字，不承载任何账务事实；');
  lines.push('任何审计/对账以台账（`ledger/*.jsonl`）、完整原文（`YYYY年MM月/*完整原文.md`）、');
  lines.push('周记账（`YYYY年MM月/*.xlsx`）、收据与清册（`清册/RPT-*`）为准。');
  lines.push('本文件可安全删除，再次生成会重建（`lib/catalog.js` 或 `docs/工具-迁移布局.mjs --write`）。');
  lines.push('');
  return lines.join('\n');
}

/** `renderCatalog` 的兜底空数据（防御：调用方传了坏对象也不让生成崩）。 */
function collectEmptyDataFallback() {
  return {
    v: CATALOG_VERSION,
    root: '',
    generatedAt: '',
    rootId: '',
    marker: { found: false, usable: false, reason: 'missing', layoutVersion: null },
    layout: { version: 1, label: LAYOUT_LABEL[1], dirsPresent: [], oldFileCount: 0, unknownCount: 0, hasMarker: false },
    months: [],
    categories: {
      handover: { total: 0, newDir: 0, oldRoot: 0, main: 0, appendix: 0, latest: '', latestWhere: '' },
      cleanup: { total: 0, newDir: 0, oldRoot: 0, report: 0, appendix: 0, dryrun: 0, latest: '', latestWhere: '' },
      checkup: { total: 0, newDir: 0, oldRoot: 0, report: 0, latest: '', latestWhere: '' },
    },
    status: {
      ledgerRows: 0, ledgerFiles: 0, ledgerBytes: 0, ledgerOk: false, badLines: 0, readErrors: 0, emptyProven: false,
      gate: { conclusion: 'unknown', knownGaps: [], reason: '无数据', evidence: 'no-run-report', runReport: '', generatedAt: '' },
    },
    budget: { rows: 0, files: 0, bytes: 0, warn: [] },
  };
}

// ============================================================================
// 四、写盘（原子 + fsync）
// ============================================================================

/**
 * 总目录文件路径：`<root>/账簿总目录.md`。
 * @param {string} root 账库根
 * @returns {string}
 */
export function catalogPath(root) {
  return path.join(root, CATALOG_NAME);
}

/** 目录 fsync（尽力而为；不支持目录 fsync 的文件系统静默跳过）。 */
function fsyncDirBestEffort(dir) {
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* ignore */ } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 生成并原子写入 `<root>/账簿总目录.md`。
 *
 * @param {string} root 账库根
 * @param {{nowMs?:number, offsetMinutes?:number, data?:object}} [opts]
 *        `data`：已采集好的数据（省一次扫描；迁移工具用它保证"渲染的就是校验过的快照"）
 * @returns {{ok:boolean, path:string, bytes:number, counts:object, generatedAt?:string,
 *            budget:{rows:number,files:number,bytes:number,warn:string[]},
 *            reason?:string, detail?:string}}
 *        `budget` 原样来自采集数据（0.9.4-P3：**只告警**，不影响写盘成败、不进 md）；
 *        写失败时给全 0 的空预算，保证返回形状稳定（调用方不必判空）。
 *
 * @why 失败返回 `ok:false` 而不是抛错：总目录是**导航文件**，它写不进去不该让
 *      迁移/启动流程崩掉 —— 但必须如实告诉调用方"没写"。
 */
export function writeCatalog(root, opts = {}) {
  const absRoot = typeof root === 'string' && root ? path.resolve(root) : '';
  const target = catalogPath(absRoot);
  const emptyCounts = {};
  const emptyBudget = { rows: 0, files: 0, bytes: 0, warn: [] };
  if (!absRoot) {
    return { ok: false, path: '', bytes: 0, counts: emptyCounts, budget: emptyBudget, reason: 'E_ROOT_REQUIRED', detail: 'root 必须是非空字符串' };
  }
  try {
    const data = opts.data && typeof opts.data === 'object' ? opts.data : collectCatalogData(absRoot, opts);
    const text = renderCatalog(data);
    const bytes = Buffer.byteLength(text, 'utf8');
    fs.mkdirSync(absRoot, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
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
    fsyncDirBestEffort(absRoot);
    return {
      ok: true, path: target, bytes, counts: catalogCounts(data), generatedAt: data.generatedAt,
      budget: data.budget && typeof data.budget === 'object' ? data.budget : emptyBudget,
    };
  } catch (e) {
    return {
      ok: false, path: target, bytes: 0, counts: emptyCounts, budget: emptyBudget,
      reason: (e && e.code) || 'E_CATALOG_WRITE',
      detail: (e && e.message) || String(e),
    };
  }
}
