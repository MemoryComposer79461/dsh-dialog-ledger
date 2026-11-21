/**
 * @file cleanup.js
 * @role 数据管理：清理第 3 级「完整原文」+ **按契约 v1.3 生成清册终稿**（`RPT-YYYYMMDD-NN.md`）。
 * @called-by docs/工具-v03-清理.mjs（v0.5 已封锁；不 import 本文件）/ 测试 / 将来的 UI
 *
 * ============================================================================
 * 一、v0.5 P0-6 安全层（审计 A-07「清理默认真删」）—— 三条硬规则，重写后**一条不许松**：
 *   ① **默认零删除**：不显式给 `cleanupAllowPhysicalDelete: true` **且** `dryRun: false`
 *      时，只做只读统计 + dry-run 报告，**一个文件都不能少**；
 *   ② **dry-run 独立编号**：报告名 `RPT-DRYRUN-YYYYMMDD-NN.md`，不产正式 RPT、不占正式编号；
 *   ③ **双开关**：物理删除 = `cleanupAllowPhysicalDelete === true` **且** `dryRun === false`；
 *      只给总开关而没显式 `dryRun:false` → 仍按 dry-run 处理（宁可少删，不可多删）。
 *
 * ============================================================================
 * 二、v1.3 清册（模板：`契约-v1.3/模板-完整原文清理报告-v1.3.md`）：
 *   · 报告：17 键 YAML（顺序固定、数值带引号）+ 7 行抬头表 + 声明逐字 + 统计三处一致
 *     + 明细（按产生时间升序，≤50 全列、>50 正文 50 条 + 附录 CSV 全量）
 *     + 失败项（结论=未删除，双向对齐 S4）+ 复核行（按台账 jsonl 重扫）+ 留档行；
 *   · 自检 S1–S8（发布前全部通过才写盘；任一不过 → 抛 `E_CLEANUP_S<n>`，journal 保留）；
 *   · journal：`<root>/ledger/.cleanup-<report_id>.journal`，JSONL 内容但**不叫** `.jsonl`
 *     （避免被台账扫描误读）。首行 `kind=plan`、中间 N×`kind=result`、末行 `kind=finalize`；
 *     每行写完 fsync；**终稿一次性写盘（先 .tmp 再排他 rename）**，禁止"先写待删再覆盖"；
 *   · 编号：扫**双路径**（`清册/` + 一级）取当日最大号 +1（不读 state；D15/D16 序号 `\d+`，99→100→101 不回绕）；
 *   · 删除范围：只删第 3 级 `<编码> 完整原文.md`（+ 同单元事件附件）；台账/周记账/交接表/清册
 *     一个字节都不动。
 *
 * @why 为什么清理必须"有据"：
 *      完整原文是原始凭证，允许销毁，但销毁必须有据。清册/journal 就是销毁证据；
 *      即使进程在删除中途被杀，journal 也已经存在 —— 事后能解释每一条缺失。
 * @why 为什么只许删第 3 级：
 *      一级（交接表/清册/体检 等分类目录）是表头目录与清册，二级（周记账/原文夹）是记账凭证，
 *      台账是银行日记账 —— 这三样删了账就没法追。只允许删"最常增删"的第 3 级。
 * @why 为什么"失败"与"跳过"必须分开：
 *      "删不掉"（未删除）和"没删"（跳过）是两件事；清册必须能区分，否则审计时无法
 *      判断是有意保留还是失败。S4 再强制"失败项 ↔ 明细未删除"双向相等。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  FILE_KIND, SUBDIR, newLayoutPath, resolveExisting,
} from '../lib/layout.js';

// ============================================================================
// 零、常量与纯工具
// ============================================================================

/** 第 3 级目录名后缀（`{MM}月总“完整原文”`）。 */
const ORIGINAL_DIR_SUFFIX = '完整原文”';
/** 正式清册文件名（D15/D16：序号是 `\d+`，99/100/101 不回绕）。 */
const RPT_NAME_RE = /^RPT-(\d{8})-(\d+)\.md$/;
/** dry-run 报告文件名（独立前缀，不占正式编号）。 */
const DRY_RUN_RE = /^RPT-DRYRUN-(\d{8})-(\d+)\.md$/;
/** 附录 CSV 后缀（决定 9 #12：文件名固定 `{report_id}-明细.csv`）。 */
const APPENDIX_CSV_SUFFIX = '-明细.csv';
/** 附录 CSV 文件名（用于反向解析，CH-20：第 51+ 条只在这里）。 */
const APPENDIX_CSV_RE = /^RPT-(\d{8})-(\d+)-明细\.csv$/;
/** 未完成 journal 文件名（用于编号"继续 +1"，避免追加进已有证据）。 */
const JOURNAL_NAME_RE = /^\.cleanup-RPT-(\d{8})-(\d+)\.journal$/;
/** 32 位完整原文编码（YYYYMMDD-12位Session-代差-8位序号）。 */
const CODE_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** 全文禁 `Z` 结尾时间（CL-32）。 */
const Z_TIME_RE = /\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
/** 生成器标识（3.9：`dsh-dialog-ledger-<版本>/<模块>`；留档行要求 `\S+`）。 */
const GENERATOR = 'dsh-dialog-ledger-v0.5/cleanup';
/** 委托人 / 执行 / 记录 —— 模板固定串（CL-04）。 */
const CLIENT = 'user';
const EXECUTOR = '日常会话记录插件（Tool）';
const RECORDER = '系统（Cordis）';
/** 声明段落（模板原文逐字，CL-06；生成器不得改写/节选/补充）。 */
const DECLARATION =
  'Agent、Cordis 及 Tool 均无权限及能力删除完整原文并主动生成该文件，' +
  '若出现此文件，则说明 user 主动要求并参与本轮清理活动，Agent、Cordis 及 Tool 均不承担责任。';
/** YAML 17 键的**固定顺序**（CL-03；一个不增一个不减）。 */
const YAML_KEYS = [
  '报告编号', '报告日期', '清理对象', '清理范围', '数据来源', '委托人', '执行', '记录', '生成器',
  '清理前总数', '计划清除', '成功', '失败', '跳过', '目前剩余', '上一轮报告', '复核时间',
];
/** 抬头表 7 个字段（CL-05 / S7）；名称由报告日期派生。 */
const HEADER_LABELS = ['名称', '报告编号', '委托人', '执行', '记录', '清理范围', '上一轮报告'];
/** 明细三值（口径 3 / CL-11）。 */
const R_DELETED = '已删除';
const R_NOT_DELETED = '未删除';
const R_SKIPPED = '跳过';
/** dry-run 备注（CL-23：明细结论全部 `跳过`、备注 `试运行`）。 */
const DRY_RUN_NOTE = '试运行';
/** dry-run 的"上一轮报告"（决定 9 #13）。 */
const DRY_RUN_PREV = '（试运行）';
const pad2 = (n) => String(n).padStart(2, '0');

/** 本地年月日 `YYYYMMDD`（+08:00 口径，不依赖本机时区）。 */
function localDate(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** 本地日期 `YYYY-MM-DD`（CL-16 日期字段）。 */
function localDay(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`（S6/CL-16：清册内一律空格分隔，禁 T 禁 Z）。 */
function localStamp(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 是否「第 3 级完整原文目录」。 */
function isOriginalDirName(name) {
  return String(name).endsWith(ORIGINAL_DIR_SUFFIX);
}

/** 造一个带错误码的 Error（调用方用 err.code 精确分流）。 */
function cleanupError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** 读目录；不可读时返回空数组（只读路径绝不让扫描失败变成崩溃）。 */
function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * 清册相关文件的**双路径目录序**：`清册/`（新布局）优先，一级（老库，未迁移）兜底。
 * @why V0.6.2：写端只写 `清册/`，但"已写出清册/编号接续"这类**读扫描**必须两处都看 ——
 *      老库不迁移也必须能读（机主已签《v0.6.2-迁移规格-v1》§2.2）。
 */
function reportScanDirs(root) {
  return [path.join(root, SUBDIR.cleanup), root];
}

/**
 * 扫描清册双路径目录，返回 `{name, abs}` 列表（**同名文件以 `清册/` 为准**，老位置不重复读）。
 * 只用于读端；写端一律 `newLayoutPath()`。
 */
function scanReportFiles(root) {
  const seen = new Set();
  const out = [];
  for (const dir of reportScanDirs(root)) {
    for (const n of safeReaddir(dir)) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ name: n, abs: path.join(dir, n) });
    }
  }
  return out;
}

/** 输入文本换行归一：CRLF / CR → LF（CL-02：报告产物一律 LF）。 */
function normalizeNewlines(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
}

/** 表格单元格消毒：换行/竖线不能破表（markdown 列结构优先）。 */
function mdCell(value) {
  return normalizeNewlines(value).replace(/\n/g, ' ').replace(/\|/g, '｜');
}

/** YAML 双引号值（口径 7：数值也带引号；转义 `"` 与 `\`）。 */
function yamlValue(value) {
  return `"${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** CSV 字段转义（逗号/引号/换行 → 双引号包裹，内部引号翻倍）。 */
function csvField(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 解析一行 CSV（RFC4180 子集：双引号包裹、内部 `""` 转义）。
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true; // 允许引号出现在字段任意位置（宽容读取）
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** 解析整段 CSV 文本（去 UTF-8 BOM；容忍 CRLF/LF）。 */
function parseCsvText(text) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r\n|\n|\r/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map(parseCsvLine);
}

/** 单元格清洗：去 markdown 记号、去空白（清册解析用）。 */
function cleanCell(value) {
  return String(value == null ? '' : value).replace(/[`*]/g, '').trim();
}

/**
 * 从 CSV 行集合里取「编码 → 结论」。
 * 表头优先（`编码` + `结论`/`结果`）；无表头走固定列序回退（附录 CSV 列序 #/编码/产生时间/结论/备注）。
 * @returns {Array<{code:string, verdict:string}>}
 */
function csvRowsToCodeVerdict(rows) {
  const out = [];
  if (!Array.isArray(rows) || rows.length === 0) return out;
  const header = rows[0].map(cleanCell);
  const codeIdx = header.indexOf('编码');
  const verdictIdx = header.indexOf('结论') >= 0 ? header.indexOf('结论') : header.indexOf('结果');
  if (codeIdx >= 0 && verdictIdx >= 0) {
    for (let i = 1; i < rows.length; i += 1) {
      const cells = rows[i];
      if (!cells || cells.every((c) => cleanCell(c) === '')) continue;
      out.push({ code: cleanCell(cells[codeIdx]), verdict: cleanCell(cells[verdictIdx]) });
    }
    return out;
  }
  // 回退：附录 CSV 固定 5 列（# / 编码 / 产生时间 / 结论 / 备注）
  for (const cells of rows) {
    if (!cells || cells.length < 4) continue;
    const code = cleanCell(cells[1] || '');
    if (!CODE_RE.test(code)) continue;
    out.push({ code, verdict: cleanCell(cells[3] || '') });
  }
  return out;
}

/**
 * 严格解析一份附录 CSV：坏行**必须计数并入 readErrors**，绝不把"读不出来"静默当成"没有"
 * （清册是删除凭据，读不出来就是审计缺口）。
 *
 * @param {string} text CSV 原文（可带 BOM）
 * @param {string} file CSV 文件名（报错用）
 * @param {Array<{file:string,line:number,reason:string,raw?:string}>} readErrors 错误收集器
 * @returns {Array<{code:string, verdict:string, line:number}>}
 */
function parseAppendixCsvStrict(text, file, readErrors) {
  const rows = parseCsvText(text);
  if (rows.length === 0) {
    readErrors.push({ file, line: 0, reason: 'CSV 为空（缺表头）' });
    return [];
  }
  const header = rows[0].map(cleanCell);
  const codeIdx = header.indexOf('编码');
  const verdictIdx = header.indexOf('结论') >= 0 ? header.indexOf('结论') : header.indexOf('结果');
  if (codeIdx < 0 || verdictIdx < 0) {
    readErrors.push({ file, line: 1, reason: `CSV 表头缺「编码」或「结论/结果」列：${JSON.stringify(header)}` });
    return [];
  }
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const line = i + 1; // 1-based；表头是第 1 行
    if (!Array.isArray(cells) || cells.every((c) => cleanCell(c) === '')) continue; // 空行不算坏行
    if (cells.length !== 5) {
      readErrors.push({ file, line, reason: `列数=${cells.length}（应为 5 列）`, raw: cells.join(',') });
      continue;
    }
    const code = cleanCell(cells[codeIdx] || '');
    const verdict = cleanCell(cells[verdictIdx] || '');
    if (!CODE_RE.test(code)) {
      readErrors.push({ file, line, reason: `编码不合规：${JSON.stringify(code)}`, raw: cells.join(',') });
      continue;
    }
    if (verdict !== R_DELETED && verdict !== R_NOT_DELETED && verdict !== R_SKIPPED) {
      readErrors.push({ file, line, reason: `结论非三值：${JSON.stringify(verdict)}`, raw: cells.join(',') });
      continue;
    }
    out.push({ code, verdict, line });
  }
  return out;
}

// ============================================================================
// 一、只读扫描（安全、无副作用）
// ============================================================================

/**
 * 扫描所有初始凭证（只读）。
 *
 * @param {string} root 数据总库根目录
 * @returns {Array<{code:string, sessKey:string, month:string, rel:string, abs:string,
 *                  size:number, mtimeMs:number, attachmentAbs:string, attachmentExists:boolean}>}
 *
 * @why 只认「第 3 级目录 + 32 位编码 + `完整原文.md`」：
 *      递归深度限制在 4 （root/年/月/原文夹/文件），绝不误伤一级/二级文件。
 * @why 额外带上同编码的事件附件路径：D11 之后一份原文 = 视图 md + 原始事件 json，
 *      清理必须按"一个单元"处理（否则删了视图留下孤儿附件）。
 */
export function listOriginals(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.name.endsWith('.md') || !isOriginalDirName(path.basename(dir))) continue;
      const code = e.name.split(' ')[0];
      if (!CODE_RE.test(code)) continue;
      if (e.name !== `${code} 完整原文.md`) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      // 月份取自上一级「YYYY年MM月」目录，统一成 YYYY-MM
      const parent = path.basename(path.dirname(dir));
      const mm = /^(\d{4})年(\d{2})月$/.exec(parent);
      const attachmentAbs = path.join(dir, `${code} 原始事件.json`);
      let attachmentExists = false;
      try { attachmentExists = fs.statSync(attachmentAbs).isFile(); } catch { attachmentExists = false; }
      out.push({
        code,
        sessKey: code.slice(9, 21) + code.slice(22, 23),
        month: mm ? `${mm[1]}-${mm[2]}` : parent,
        rel: path.relative(root, p),
        abs: p,
        size: st.size,
        mtimeMs: st.mtimeMs,
        attachmentAbs,
        attachmentExists,
      });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 图一份原文件是第 3 级视图/附件的实际风格：`<编码> 完整原文.md` / `<编码> 原始事件.json`。
 * （CL-17 "与 journal plan 记录的原文文件名一致"、CL-28 "只删第三级"用）
 */
function originalFileNameOf(code) {
  return `${code} 完整原文.md`;
}

/**
 * 当天正式清册已占用的最大序号（扫描 md + 未完成 journal 两类证据）。
 * @why md 必须扫**双路径**（`清册/` + 一级）：老库的清册在一级，迁移前也必须能接续编号。
 */
function scanFormalSerial(root, day) {
  let max = 0;
  for (const { name: n } of scanReportFiles(root)) {
    const m = RPT_NAME_RE.exec(n);
    if (m && m[1] === day) max = Math.max(max, Number(m[2]));
  }
  for (const n of safeReaddir(path.join(root, 'ledger'))) {
    const m = JOURNAL_NAME_RE.exec(n);
    if (m && m[1] === day) max = Math.max(max, Number(m[2]));
  }
  return max;
}

/** 分配当天正式清册编号（不覆盖已有 md 终稿；跳过未完成 journal 占用的号）。 */
function allocateFormalReportId(root, day) {
  let serial = scanFormalSerial(root, day) + 1;
  for (let i = 0; i < 100; i += 1, serial += 1) {
    const id = `RPT-${day}-${String(serial).padStart(2, '0')}`;
    // 新编号的 md 可能在 `清册/`（新布局）或一级（老库）；两处都占用即跳过（resolveExisting 双路径）。
    const mdExists = resolveExisting(root, FILE_KIND.CLEANUP_REPORT, `${id}.md`) !== '';
    const journal = path.join(root, 'ledger', `.cleanup-${id}.journal`);
    if (!mdExists && !fs.existsSync(journal)) return id;
  }
  throw cleanupError(
    'E_CLEANUP_ID_CONFLICT',
    `无法分配正式清册编号：当天 ${day} 的号段连续被占用（已重试 100 个）`
  );
}

/**
 * 当天正式清册下一个编号（扫目录取最大 +1；D15/D16：`\d+`，99/100/101 不回绕）。
 * @why 不读 `ledger/.state.json`：state 丢失后编号必须仍按目录接续（CL-20 / R3）。
 * @why 也把"有 plan 无 finalize"的未完成 journal 计入最大值：直接复用该号会往旧证据
 *      文件里追加、破坏"journal 保留现场"；3.7 第 5 条允许"列出未完成号后继续 +1"。
 * @why V0.6.2：扫**双路径**（`清册/` + 一级），老库迁移前编号照样接续、不撞号。
 */
export function nextReportId(root, offsetMinutes = 480) {
  const day = localDate(Date.now(), offsetMinutes);
  return allocateFormalReportId(root, day);
}

/** 当天 dry-run 报告下一个编号（独立前缀；不占正式编号；同样扫 `清册/` + 一级）。 */
export function nextDryRunId(root, offsetMinutes = 480) {
  const day = localDate(Date.now(), offsetMinutes);
  let max = 0;
  for (const { name: n } of scanReportFiles(root)) {
    const m = DRY_RUN_RE.exec(n);
    if (m && m[1] === day) max = Math.max(max, Number(m[2]));
  }
  return `RPT-DRYRUN-${day}-${String(max + 1).padStart(2, '0')}`;
}

/**
 * 正式报告序列中的"上一轮报告"编号（取已出终稿中日期/序号最大的那一份；无则 `无`）。
 * @why 只认**已写出**的 `RPT-*.md`（`清册/` + 一级双路径）：未完成 journal / dry-run 报告都不是清册。
 */
function previousReportId(root) {
  let best = null; // { id, day, serial }
  for (const { name: n } of scanReportFiles(root)) {
    const m = RPT_NAME_RE.exec(n);
    if (!m) continue;
    const day = m[1];
    const serial = Number(m[2]);
    if (!best || day > best.day || (day === best.day && serial > best.serial)) {
      best = { id: n.replace(/\.md$/, ''), day, serial };
    }
  }
  return best ? best.id : '无';
}

/**
 * 圈定要清理的文件（纯函数，无 IO）。
 *
 * @param {object} p
 * @param {object[]} p.originals listOriginals() 结果
 * @param {string} [p.month] `YYYY-MM` 或省略=全部
 * @param {string} [p.sessionKey] 13 位会话键，或省略=全部
 * @param {number} [p.limit] 最多选几份，0/省略=全部
 */
export function planCleanup({ originals, month, sessionKey, limit }) {
  let sel = Array.isArray(originals) ? originals : [];
  if (month) sel = sel.filter((x) => x.month === month);
  if (sessionKey) sel = sel.filter((x) => x.sessKey === sessionKey);
  if (limit && limit > 0) sel = sel.slice(0, limit);
  return sel;
}

// ============================================================================
// 二、读清册（只读兼容层；CL-29/CL-30/CH-20）
// ============================================================================

/**
 * 读清册：从 `RPT-*.md` **及其附录 `{report_id}-明细.csv`** 里解析出
 * 「已删除」的编码（只读）。
 *
 * @param {string} root
 * @returns {Map<string,string>} code → 清册编号（如 RPT-20261108-01）。
 *          额外的 `map.readErrors`：解析错误清单（坏 CSV 行/空 CSV/表头缺失/读失败），**必须非空即上报**。
 *
 * @why 只认**结论列**（P1-10，审计 A-06 同批）：清册有 v1.3 新表（`结论`）与 v0.4 旧表（`结果`）
 *      两种 schema；必须按表头定位列，再取该列的值。
 *      "任意单元格包含已删除"会把备注里写"已删除"（例如"未删除，因…"）的行误判成已清理，
 *      从而把非法丢失洗成合法清洗 —— 四态判定就失真了。
 * @why V0.6.2 读双路径（新目录优先、一级兜底）：清册在 `清册/`（新布局）或一级（老库）都要读；
 *      同名文件以 `清册/` 为准（回滚/重放时不会读回两份互相矛盾的内容）。
 * @why 两种编号都要认（D15/D16）：`RPT-YYYYMMDD-N` 的 N 是 `\d+`（99/100/101 不回绕）；
 *      dry-run 报告 `RPT-DRYRUN-*` 不是清册，不参与。
 * @why **必须解析附录 CSV**（CH-20 / CL-13）：计划清除 > 50 时正文只列前 50 条，第 51+ 条
 *      只存在于 `{report_id}-明细.csv`；不解析它 = 历史"已清理"被误判成"缺凭证"。
 *      `lib/weekly.js: readCleanedCodesCompat()` 会 merge 本函数结果，所以本函数补上即可，
 *      不改 weekly.js。
 * @why 无表头的残留/手工清册走"严格结构"回退（新 schema 第 4 格 / 旧 schema 第 5 格恰为已删除），
 *      绝不退回"任意单元格"判定。
 */
export function readCleanedCodes(root) {
  const map = new Map();
  /** 解析错误清单（**不静默吞**）：坏 CSV 行 / 空 CSV / 表头缺失 / 文件读失败。 */
  const readErrors = [];
  // V0.6.2：清册/附录 CSV 读**双路径**（`清册/` 优先、一级老位置兜底；同名以新目录为准）。
  const entries = scanReportFiles(root);
  for (const { name: n, abs } of entries) {
    if (!RPT_NAME_RE.test(n)) continue; // dry-run 报告不算清册；D16 `\d+`
    const reportId = n.replace(/\.md$/, '');
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
      readErrors.push({ file: n, line: 0, reason: `清册读取失败：${String(e && e.message ? e.message : e)}` });
      continue;
    }

    let header = null; // { codeIdx, verdictIdx }
    let sawHeader = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map(cleanCell);
      // 表头（含「编码」且含「结论」或「结果」）→ 记住列下标
      const ci = cells.indexOf('编码');
      const vi = cells.indexOf('结论') >= 0 ? cells.indexOf('结论') : cells.indexOf('结果');
      if (ci >= 0 && vi >= 0) {
        header = { codeIdx: ci, verdictIdx: vi };
        sawHeader = true;
        continue;
      }
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 分隔行
      if (header) {
        const code = cells[header.codeIdx] || '';
        const verdict = cells[header.verdictIdx] || '';
        if (CODE_RE.test(code) && verdict === R_DELETED) map.set(code, reportId);
        continue;
      }
      // 无表头回退：严格结构（v1.3 第 4 格 / v0.4 第 5 格恰为「已删除」）
      if (cells.length >= 5 && CODE_RE.test(cells[1] || '') && cells[3] === R_DELETED) {
        map.set(cells[1], reportId);
      } else if (cells.length >= 5 && CODE_RE.test(cells[0] || '') && cells[4] === R_DELETED) {
        map.set(cells[0], reportId);
      }
    }
    void sawHeader;
  }
  // ---- 附录 CSV（>50 条时第 51+ 条只在这里；CH-20 的唯一红点）----
  for (const { name: n, abs } of entries) {
    const m = APPENDIX_CSV_RE.exec(n);
    if (!m) continue;
    const reportId = n.replace(APPENDIX_CSV_SUFFIX, '');
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
      readErrors.push({ file: n, line: 0, reason: `附录 CSV 读取失败：${String(e && e.message ? e.message : e)}` });
      continue;
    }
    for (const { code, verdict } of parseAppendixCsvStrict(text, n, readErrors)) {
      if (CODE_RE.test(code) && verdict === R_DELETED) map.set(code, reportId);
    }
  }
  // readErrors 挂在 Map 上（不改变返回类型；weekly.js 的 compat 合并照常 for..of）。
  // 清册是删除凭据：读不出来的行必须能被调用方看到，不能静默当成"没有"。
  Object.defineProperty(map, 'readErrors', {
    value: readErrors, enumerable: false, writable: false, configurable: false,
  });
  return map;
}

// ============================================================================
// 三、清册终稿渲染（模板 v1.3：唯一事实源 → 前置数据块 → 整篇一次渲染）
// ============================================================================

/** 清理范围文案（抬头表 / YAML / journal plan 共用，口径 10）。 */
function scopeLabel({ month, sessionKey, limit }) {
  const parts = [month ? String(month) : '全部月份'];
  if (sessionKey) parts.push(`会话 ${sessionKey}`);
  if (limit && limit > 0) parts.push(`限 ${limit} 条`);
  return parts.join('；');
}

/** 数据来源文案（固定串，不含路径以免把环境信息写进凭证）。 */
const DATA_SOURCE = '系统（Cordis）第 3 级完整原文目录';

/**
 * 构造清册上下文 —— **前置数据块是唯一事实源**（口径 10 / CL-31）：
 * YAML、抬头表、统计句、统计表、明细、失败项、附录、复核行、留档行全部由它渲染。
 *
 * @param {object} p
 * @param {'physical'|'dry-run'} p.mode
 * @param {Array<{item:object,result:string,reason?:string,note?:string}>} p.results
 * @returns {object} ctx
 */
function buildReportContext({
  mode, reportId, month, sessionKey, limit, offsetMinutes, nowMs,
  beforeTotal, results, prevReportId,
}) {
  // 明细按「产生时间升序；同时间按编码升序」（口径 5 / CL-10），绝不按编码/会话排。
  const ordered = [...results].sort((a, b) => {
    const ta = Number(a.item.mtimeMs);
    const tb = Number(b.item.mtimeMs);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return String(a.item.code) < String(b.item.code) ? -1 : String(a.item.code) > String(b.item.code) ? 1 : 0;
  });
  const items = ordered.map((r, i) => ({
    n: i + 1,
    code: r.item.code,
    created_at: localStamp(r.item.mtimeMs, offsetMinutes),
    result: r.result,
    note: r.note || '',
    fileName: originalFileNameOf(r.item.code),
  }));
  const succeeded = items.filter((it) => it.result === R_DELETED).length;
  const failed = items.filter((it) => it.result === R_NOT_DELETED).length;
  const skipped = items.filter((it) => it.result === R_SKIPPED).length;
  const failures = items
    .filter((it) => it.result === R_NOT_DELETED)
    .map((it, i) => ({ n: i + 1, code: it.code, reason: it.note || '删除失败', action: '保留（未删除）' }));
  const date = localDay(nowMs, offsetMinutes);
  const title = `${date}“完整原文”清理报告`;
  const appendix = items.length > 50
    ? { file: `${reportId}${APPENDIX_CSV_SUFFIX}`, rows: items.length }
    : null;
  return {
    mode,
    report_id: reportId,
    date,
    scope: scopeLabel({ month, sessionKey, limit }),
    source: DATA_SOURCE,
    generator: GENERATOR,
    before_total: beforeTotal,
    planned: items.length,
    succeeded,
    failed,
    skipped,
    remaining: beforeTotal - succeeded,
    prev_report_id: mode === 'dry-run' ? DRY_RUN_PREV : prevReportId,
    verified_at: localStamp(nowMs, offsetMinutes),
    archived_at: localStamp(nowMs, offsetMinutes),
    header: [
      ['名称', title],
      ['报告编号', reportId],
      ['委托人', CLIENT],
      ['执行', EXECUTOR],
      ['记录', RECORDER],
      ['清理范围', scopeLabel({ month, sessionKey, limit })],
      ['上一轮报告', mode === 'dry-run' ? DRY_RUN_PREV : prevReportId],
    ],
    items,
    failures,
    appendix,
  };
}

/** 渲染前置数据块（YAML 17 键，顺序固定、数值带引号 —— 口径 7 / CL-03）。 */
function renderYamlBlock(ctx) {
  const values = {
    报告编号: ctx.report_id,
    报告日期: ctx.date,
    清理对象: '完整原文',
    清理范围: ctx.scope,
    数据来源: ctx.source,
    委托人: CLIENT,
    执行: EXECUTOR,
    记录: RECORDER,
    生成器: ctx.generator,
    清理前总数: ctx.before_total,
    计划清除: ctx.planned,
    成功: ctx.succeeded,
    失败: ctx.failed,
    跳过: ctx.skipped,
    目前剩余: ctx.remaining,
    上一轮报告: ctx.prev_report_id,
    复核时间: ctx.verified_at,
  };
  const lines = ['---'];
  for (const key of YAML_KEYS) lines.push(`${key}: ${yamlValue(values[key])}`);
  lines.push('---');
  return lines;
}

/** 渲染明细行（正文 ≤50 全列；>50 只列前 50 —— S3/CL-08）。 */
function renderDetailRows(items) {
  return items.map((it) =>
    `| ${it.n} | ${it.code} | ${it.created_at} | ${it.result} | ${mdCell(it.note)} |`);
}

/** 渲染失败项行（仅结论=未删除 —— 口径 4 / CL-12）。 */
function renderFailureRows(failures) {
  return failures.map((f) =>
    `| ${f.n} | ${f.code} | ${mdCell(f.reason)} | ${f.action} |`);
}

/**
 * 渲染清册终稿正文（**唯一**写盘内容；不含任何模板注记/占位符）。
 * @param {object} ctx buildReportContext() 结果
 * @returns {string} 报告全文（UTF-8 无 BOM、LF、恰一个结尾换行）
 */
function renderCleanupReportText(ctx) {
  const L = [];
  L.push(...renderYamlBlock(ctx));
  L.push('');
  L.push(`# ${ctx.date}“完整原文”清理报告`);
  L.push('');
  if (ctx.mode === 'dry-run') {
    // dry-run 不是清册：明确"零删除 / 不占正式号"（P0-6 与 CL-22/23 的安全语义）
    L.push('> **试运行（dry-run）**：删除数 = 0；本文件不是清册，不占正式 `RPT-YYYYMMDD-NN` 编号，');
    L.push('> 也不构成“销毁有据”的结论。');
    L.push('');
  }
  // 抬头表：恰 7 行（S7 / CL-05），逐字段来自前置数据块
  L.push('| 项目 | 内容 |');
  L.push('| :--- | :--- |');
  for (const [label, value] of ctx.header) L.push(`| ${label} | ${mdCell(value)} |`);
  L.push('');
  L.push('## 声明');
  L.push('');
  L.push(DECLARATION); // 口径 11：逐字，生成器不得改写/节选/补充
  L.push('');
  L.push('## 清除统计');
  L.push('');
  L.push(
    `计划清除 **${ctx.planned}** 个“完整原文”，成功 **${ctx.succeeded}** 个，` +
    `失败 **${ctx.failed}** 个，跳过 **${ctx.skipped}** 个，目前剩余 **${ctx.remaining}** 个。`
  );
  L.push('');
  L.push('| 清理前总数 | 计划清除 | 成功 | 失败 | 跳过 | 目前剩余 |');
  L.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
  L.push(`| ${ctx.before_total} | ${ctx.planned} | ${ctx.succeeded} | ${ctx.failed} | ${ctx.skipped} | ${ctx.remaining} |`);
  L.push('');
  // 复核行：逐字照契约（CL-14）；"按台账 jsonl 重扫"由 runCleanup 的复核步骤兑现
  L.push(`> 复核：${ctx.verified_at}（UTC+08:00）按台账 jsonl 重扫，剩余 ${ctx.remaining} 条，与上表一致。`);
  L.push('');
  L.push('## 本轮清理的“完整原文”明细');
  L.push('');
  L.push('| # | 编码 | 产生时间（UTC+08:00） | 结论 | 备注 |');
  L.push('| ---: | :--- | :--- | :--- | :--- |');
  const bodyItems = ctx.planned > 50 ? ctx.items.slice(0, 50) : ctx.items;
  L.push(...renderDetailRows(bodyItems));
  L.push('');
  L.push('## 失败项');
  L.push('');
  L.push('| # | 编码 | 失败原因 | 处置 |');
  L.push('| ---: | :--- | :--- | :--- |');
  L.push(...renderFailureRows(ctx.failures));
  L.push('');
  if (ctx.appendix) {
    L.push('## 附录：全量明细');
    L.push('');
    L.push(`正文仅列前 50 条。全量 ${ctx.planned} 条见：`);
    L.push('');
    L.push(`- 文件：${ctx.appendix.file}`);
    L.push(`- 数据行：${ctx.appendix.rows}（不含表头）`);
    L.push('- 格式：UTF-8 with BOM，逗号分隔；列同正文明细表（# / 编码 / 产生时间 / 结论 / 备注）');
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('**结束**');
  L.push('');
  L.push(`**留档：** ${ctx.archived_at}（UTC+08:00）· ${ctx.report_id} · 生成器 ${ctx.generator}`);
  // 编码层硬约束：LF + 恰一个结尾换行（CL-02）
  return `${L.join('\n')}\n`;
}

/**
 * 渲染附录 CSV（仅 planned > 50）：UTF-8 with BOM、5 列、数据行 == planned。
 * 列序固定 `# / 编码 / 产生时间 / 结论 / 备注`（决定 9 #12 / CL-13）。
 */
function renderAppendixCsv(ctx) {
  const lines = ['# , 编码 , 产生时间 , 结论 , 备注'];
  for (const it of ctx.items) {
    lines.push([
      String(it.n), it.code, it.created_at, it.result, it.note || '',
    ].map(csvField).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ============================================================================
// 四、发布前自检 S1–S8（决定 4 / 3.3：任一不过 → 不写盘，报 E_CLEANUP_S<n>）
// ============================================================================

/** 取某二级标题下的行（到下一个 `## ` 为止）。 */
function sectionLines(text, heading) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

/** 行集合 → 表格数据行（跳过表头与分隔行）。 */
function tableDataRows(lines) {
  const rows = [];
  if (!lines) return rows;
  let sawHeader = false;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!sawHeader) { sawHeader = true; continue; }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    rows.push(cells);
  }
  return rows;
}

/** 解析 YAML 前置数据块：返回 [{key, raw}]（不含起止 `---`）。 */
function parseYamlBlock(text) {
  const lines = String(text).split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const out = [];
  for (const line of lines.slice(1, end)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) out.push({ key: m[1].trim(), raw: m[2].trim() });
  }
  return out;
}

/** 从 YAML 行集合取字符串值（去引号）。 */
function yamlString(entries, key) {
  const hit = (entries || []).find((e) => e.key === key);
  if (!hit) return null;
  const m = /^"(.*)"$/.exec(hit.raw);
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : hit.raw;
}

const S_CODE = (n) => `E_CLEANUP_S${n}`;
const S1_NUM_KEYS = ['清理前总数', '计划清除', '成功', '失败', '跳过', '目前剩余'];

/**
 * 发布前自检 S1–S8（机器可验）。全部通过返回 true；
 * 任一不过抛 `E_CLEANUP_S<n>`（错误信息含实测值）。
 *
 * 这是"发布前自检"的唯一实现：`renderCleanupReport` 在写盘前调用它。
 * 判据（v1.3 模板 3.3 / R10–R17）：
 *   S1 planned == succeeded + failed + skipped
 *   S2 remaining == before_total - succeeded
 *   S3 planned ≤ 50 时明细行数 == planned；>50 时正文 50 + CSV 数据行 == planned
 *   S4 失败项行数 == failed，且失败项编码集合 == 明细中 未删除 的编码集合（双向）
 *   S5 无 `<!--` 注记、模板生成部分无 `{{`/`}}`、无口径/自检注释原文
 *   S6 所有时间字段 `YYYY-MM-DD HH:MM:SS`；日期 `YYYY-MM-DD`；无 Z
 *   S7 抬头表 7 字段与前置数据块逐字段一致
 *   S8 所有编码匹配 `^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$`，且与原文文件名一致
 *
 * @param {{text:string, csv?:string|null, ctx:object}} p
 * @returns {true}
 * @throws {Error} code = E_CLEANUP_S1 … E_CLEANUP_S8
 */
export function checkCleanupReport({ text, csv = null, ctx }) {
  const body = String(text == null ? '' : text);
  const yaml = parseYamlBlock(body);
  if (!yaml) {
    throw cleanupError(S_CODE(5), 'E_CLEANUP_S5：报告缺少 YAML 前置数据块（模板生成部分不完整）');
  }
  const yamlMap = new Map(yaml.map((e) => [e.key, e.raw]));

  // ---- S1：计划清除 = 成功 + 失败 + 跳过 ----
  const sum = ctx.succeeded + ctx.failed + ctx.skipped;
  if (ctx.planned !== sum) {
    throw cleanupError(
      S_CODE(1),
      `E_CLEANUP_S1：planned(${ctx.planned}) != succeeded(${ctx.succeeded}) + failed(${ctx.failed}) + skipped(${ctx.skipped})`
    );
  }
  // ---- S2：目前剩余 = 清理前总数 - 成功 ----
  if (ctx.remaining !== ctx.before_total - ctx.succeeded) {
    throw cleanupError(
      S_CODE(2),
      `E_CLEANUP_S2：remaining(${ctx.remaining}) != before_total(${ctx.before_total}) - succeeded(${ctx.succeeded})`
    );
  }
  // ---- S3：明细行数 ----
  const detailRows = tableDataRows(sectionLines(body, '## 本轮清理的“完整原文”明细'));
  const bodyCount = detailRows.length;
  if (ctx.planned <= 50) {
    if (bodyCount !== ctx.planned) {
      throw cleanupError(
        S_CODE(3),
        `E_CLEANUP_S3：planned(${ctx.planned}) <= 50，正文明细行数(${bodyCount}) != planned(${ctx.planned})`
      );
    }
  } else {
    const csvRows = csv ? csvRowsToCodeVerdict(parseCsvText(csv)).length : -1;
    if (bodyCount !== 50 || csvRows !== ctx.planned) {
      throw cleanupError(
        S_CODE(3),
        `E_CLEANUP_S3：planned(${ctx.planned}) > 50，正文 50 + CSV 数据行 应 == planned；` +
        `实测正文(${bodyCount}) + CSV(${csvRows})`
      );
    }
  }
  // ---- S4：失败项行数与编码集合双向对齐 ----
  const failureRows = tableDataRows(sectionLines(body, '## 失败项'));
  const textFailureCodes = failureRows
    .map((cells) => cleanCell(cells[1] || ''))
    .filter(Boolean)
    .sort();
  const ctxFailureCodes = ctx.items
    .filter((it) => it.result === R_NOT_DELETED)
    .map((it) => it.code)
    .sort();
  const sameSet = textFailureCodes.length === ctxFailureCodes.length &&
    textFailureCodes.every((c, i) => c === ctxFailureCodes[i]);
  if (failureRows.length !== ctx.failed || !sameSet) {
    throw cleanupError(
      S_CODE(4),
      `E_CLEANUP_S4：failed(${ctx.failed})、失败项行数(${failureRows.length})、` +
      `失败项编码集合(${JSON.stringify(textFailureCodes)}) 与明细未删除集合(${JSON.stringify(ctxFailureCodes)}) 未双向相等`
    );
  }
  // ---- S5：无模板注记/残留占位符/口径注释原文 ----
  if (body.includes('<!--')) {
    throw cleanupError(S_CODE(5), 'E_CLEANUP_S5：正文残留 `<!--` 注记');
  }
  // 用户/原文内容合法含 `{{`/`}}`（实现反馈 #3）→ 先摘除动态备注/原因/清理范围再查模板部分
  let skeleton = body;
  const dynamic = [];
  for (const it of ctx.items) {
    if (it.note) dynamic.push(it.note);
    dynamic.push(mdCell(it.note || ''));
  }
  for (const f of ctx.failures) dynamic.push(f.reason, mdCell(f.reason));
  if (ctx.scope) dynamic.push(ctx.scope);
  dynamic.filter(Boolean).sort((a, b) => b.length - a.length);
  for (const d of dynamic) skeleton = skeleton.split(d).join('');
  if (skeleton.includes('{{') || skeleton.includes('}}')) {
    throw cleanupError(S_CODE(5), 'E_CLEANUP_S5：模板生成部分残留未替换占位符 `{{`/`}}`');
  }
  for (const marker of ['模板版本', '发布前自检', '口径 1', '口径 2', '口径 3', '口径 4', '口径 5',
    '口径 6', '口径 7', '口径 8', '口径 9', '口径 10', '口径 11']) {
    if (skeleton.includes(marker)) {
      throw cleanupError(S_CODE(5), `E_CLEANUP_S5：正文残留编辑说明/口径注释原文（${marker}）`);
    }
  }
  // ---- S6：时间/日期格式（无 T、无 Z） ----
  const datetimes = [ctx.verified_at, ctx.archived_at, ...ctx.items.map((it) => it.created_at)];
  for (const dt of datetimes) {
    if (!DATETIME_RE.test(String(dt))) {
      throw cleanupError(S_CODE(6), `E_CLEANUP_S6：时间字段 ${JSON.stringify(dt)} 不是 YYYY-MM-DD HH:MM:SS`);
    }
  }
  if (!DATE_RE.test(String(ctx.date))) {
    throw cleanupError(S_CODE(6), `E_CLEANUP_S6：报告日期 ${JSON.stringify(ctx.date)} 不是 YYYY-MM-DD`);
  }
  if (Z_TIME_RE.test(body) || /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body)) {
    throw cleanupError(S_CODE(6), 'E_CLEANUP_S6：正文出现 `Z` 结尾 / ISO-T 分隔的时间');
  }
  // 明细段内每一行的"产生时间"都必须符合 S6（只查明细段，别把统计表当明细）
  for (const cells of detailRows) {
    if (cells.length >= 5 && !DATETIME_RE.test(cells[2] || '')) {
      throw cleanupError(S_CODE(6), `E_CLEANUP_S6：明细行产生时间 ${JSON.stringify(cells[2])} 格式不符`);
    }
  }
  // ---- S7：抬头表 7 字段与前置数据块逐字段一致 ----
  const headerLines = (() => {
    const lines = body.split('\n');
    const titleIdx = lines.findIndex((l) => /^# \d{4}-\d{2}-\d{2}/.test(l));
    const stop = lines.findIndex((l, i) => i > titleIdx && /^## /.test(l));
    return lines.slice(titleIdx < 0 ? 0 : titleIdx, stop < 0 ? lines.length : stop);
  })();
  const headerRows = tableDataRows(headerLines);
  if (headerRows.length !== 7) {
    throw cleanupError(S_CODE(7), `E_CLEANUP_S7：抬头表数据行数(${headerRows.length}) != 7`);
  }
  for (let i = 0; i < HEADER_LABELS.length; i += 1) {
    const label = HEADER_LABELS[i];
    const expected = ctx.header[i] ? String(ctx.header[i][1]) : '';
    const row = headerRows[i];
    if (!row || cleanCell(row[0]) !== label || cleanCell(row[1]) !== expected) {
      throw cleanupError(
        S_CODE(7),
        `E_CLEANUP_S7：抬头表第 ${i + 1} 行（${label}）` +
        `实测=${JSON.stringify(row)} 期望=${JSON.stringify([label, expected])}`
      );
    }
  }
  // ---- S8：编码格式 + 与原文文件名一致 ----
  for (const it of ctx.items) {
    if (!CODE_RE.test(it.code)) {
      throw cleanupError(S_CODE(8), `E_CLEANUP_S8：编码 ${JSON.stringify(it.code)} 不符合 32 位格式`);
    }
    if (it.fileName !== originalFileNameOf(it.code)) {
      throw cleanupError(S_CODE(8), `E_CLEANUP_S8：编码 ${it.code} 与原文文件名 ${JSON.stringify(it.fileName)} 不一致`);
    }
    if (!detailRows.some((cells) => cleanCell(cells[1] || '') === it.code) && ctx.planned <= 50) {
      throw cleanupError(S_CODE(8), `E_CLEANUP_S8：编码 ${it.code} 未出现在正文明细行`);
    }
  }
  for (const row of tableDataRows(sectionLines(body, '## 失败项'))) {
    const code = cleanCell(row[1] || '');
    if (!CODE_RE.test(code)) {
      throw cleanupError(S_CODE(8), `E_CLEANUP_S8：失败项编码 ${JSON.stringify(code)} 不符合 32 位格式`);
    }
  }
  if (csv) {
    for (const { code } of csvRowsToCodeVerdict(parseCsvText(csv))) {
      if (!CODE_RE.test(code)) {
        throw cleanupError(S_CODE(8), `E_CLEANUP_S8：附录 CSV 编码 ${JSON.stringify(code)} 不符合 32 位格式`);
      }
    }
  }
  return true;
}

/**
 * 渲染清册终稿（正文 + 附录 CSV），并在返回前**执行 S1–S8**。
 * @param {object} ctx
 * @returns {{text:string, csv:string|null}}
 * @throws {Error} E_CLEANUP_S1 … E_CLEANUP_S8
 */
function renderCleanupReport(ctx) {
  const text = renderCleanupReportText(ctx);
  const csv = ctx.appendix ? renderAppendixCsv(ctx) : null;
  checkCleanupReport({ text, csv, ctx });
  return { text, csv };
}

// ============================================================================
// 五、原子写 / journal
// ============================================================================

/**
 * 排他写文本（CL-27 / 3.10）：目标已存在 → `E_CLEANUP_ID_CONFLICT`，绝不覆盖。
 * 实现：先写 `.tmp`（fsync）→ 硬链接到目标（原子且排他）→ 删 tmp；
 * 平台不支持硬链接时退化为 `copyFile(COPYFILE_EXCL)`（仍是排他创建）。
 * @throws {Error} E_CLEANUP_ID_CONFLICT
 */
function writeFileExclusive(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  try {
    try {
      fs.linkSync(tmp, target);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        throw cleanupError('E_CLEANUP_ID_CONFLICT', `目标清册已存在，拒绝覆盖：${target}`);
      }
      try {
        fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL);
      } catch (e2) {
        if (e2 && e2.code === 'EEXIST') {
          throw cleanupError('E_CLEANUP_ID_CONFLICT', `目标清册已存在，拒绝覆盖：${target}`);
        }
        throw e2;
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 打开 journal 并返回 fd（排他创建；同一编号已有 journal 时由编号分配侧跳过）。 */
function openJournal(root, reportId) {
  const journalPath = path.join(root, 'ledger', `.cleanup-${reportId}.journal`);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const fd = fs.openSync(journalPath, 'wx');
  return { journalPath, fd };
}

/** 追加一行 journal 并 fsync（逐条落盘：崩溃可恢复）。 */
function appendJournal(fd, obj) {
  fs.writeSync(fd, `${JSON.stringify(obj)}\n`, null, 'utf8');
  fs.fsyncSync(fd);
}

// ============================================================================
// 六、复核（按台账 jsonl 重扫，3.6；不一致 → E_CLEANUP_RECHECK）
// ============================================================================

/** 读 `<root>/ledger/*.jsonl` 里的编码集合（只读；隐藏文件如 `.lost.jsonl` 不算台账）。 */
function readLedgerCodes(root) {
  const codes = new Set();
  const dir = path.join(root, 'ledger');
  for (const n of safeReaddir(dir)) {
    if (!n.endsWith('.jsonl') || n.startsWith('.')) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const code = rec && rec.code;
      if (typeof code === 'string' && CODE_RE.test(code)) codes.add(code);
    }
  }
  return codes;
}

/**
 * 复核：清理后重扫（台账 jsonl + 第 3 级目录），复核值必须 == `目前剩余`。
 * @param {string} root
 * @param {number} expectedRemaining
 * @returns {{diskCount:number, ledgerBasisCount:number|null, ledgerRows:number}}
 * @throws {Error} E_CLEANUP_RECHECK
 */
function recheckRemaining(root, expectedRemaining) {
  const originals = listOriginals(root);
  const diskCount = originals.length;
  const ledgerCodes = readLedgerCodes(root);
  let ledgerBasisCount = null;
  if (ledgerCodes.size > 0) {
    const present = new Set(originals.map((x) => x.code));
    let c = 0;
    for (const code of ledgerCodes) if (present.has(code)) c += 1;
    ledgerBasisCount = c;
  }
  const rounded = (v) => (Number.isFinite(v) ? v : -1);
  if (rounded(diskCount) !== expectedRemaining ||
      (ledgerBasisCount !== null && ledgerBasisCount !== expectedRemaining)) {
    throw cleanupError(
      'E_CLEANUP_RECHECK',
      `复核不一致：目前剩余(YAML)=${expectedRemaining}，` +
      `第 3 级重扫=${diskCount}，台账 jsonl 重扫=${ledgerBasisCount === null ? '无台账' : ledgerBasisCount}；` +
      '拒绝写盘（S2/复核必须一致）'
    );
  }
  return { diskCount, ledgerBasisCount, ledgerRows: ledgerCodes.size };
}

// ============================================================================
// 七、执行入口
// ============================================================================

/**
 * 执行一次清理。**默认 dry-run（零删除）**；物理删除必须双开关。
 *
 * 模式判定（P0-6 / INV-25）：
 *   · `cleanupAllowPhysicalDelete !== true` 或 `dryRun !== false` → dry-run（默认）；
 *     只读统计 + `RPT-DRYRUN-*` 报告，删除数 = 0，不占正式编号；
 *   · `cleanupAllowPhysicalDelete === true` **且** `dryRun === false` → 物理清理；
 *   · 显式 `dryRun: false` 但没有 `cleanupAllowPhysicalDelete: true` → 抛
 *     `E_CLEANUP_DELETE_LOCKED`（拒绝静默降级成 dry-run，也拒绝真删）。
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录
 * @param {string} [p.month] `YYYY-MM`
 * @param {string} [p.sessionKey] 13 位会话键
 * @param {number} [p.limit] 最多清理几份（0/省略=全部）
 * @param {boolean} [p.dryRun] 显式 false = 请求物理删除（还须总开关）
 * @param {boolean} [p.cleanupAllowPhysicalDelete=false] ★ 物理删除总开关
 * @param {boolean} [p.writeReport=true] dry-run 是否写报告（false = 纯只读统计）
 * @param {number} [p.offsetMinutes=480]
 * @param {number} [p.nowMs=Date.now()] 注入当前时间（自测用；决定报告日期/编号/复核时间）
 * @returns {{
 *   mode:'dry-run'|'physical', dryRun:boolean, reportId:string, path:string,
 *   journalPath:string, appendixPath:string, planned:number, deleted:number,
 *   succeeded:number, failed:number, skipped:object[], items:object[],
 *   originalsBefore:number, originalsAfter:number, filesUnchanged:boolean,
 *   report:({text:string, csv:string|null, ctx:object}|null), note?:string
 * }}
 *   注：V0.6.2 起 `path`/`appendixPath` 指向 `<root>/清册/` 下的新布局绝对路径；
 *   `journalPath` 仍在 `<root>/ledger/`（运行区，不进一级分类目录）。
 * @throws {Error} E_CLEANUP_DELETE_LOCKED / E_CLEANUP_BAD_ARGS / E_CLEANUP_S1…S8 /
 *                 E_CLEANUP_RECHECK / E_CLEANUP_ID_CONFLICT
 */
export function runCleanup({
  root,
  month,
  sessionKey,
  limit,
  offsetMinutes = 480,
  dryRun,
  cleanupAllowPhysicalDelete = false,
  writeReport = true,
  nowMs = Date.now(),
} = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw cleanupError('E_CLEANUP_BAD_ARGS', 'runCleanup(root): root 必须是非空字符串');
  }

  // ---- 双开关（P0-6 硬规则 ③）：少一个都只能 dry-run ----
  const wantsPhysical = dryRun === false;
  const physicalAllowed = cleanupAllowPhysicalDelete === true;
  if (wantsPhysical && !physicalAllowed) {
    throw cleanupError(
      'E_CLEANUP_DELETE_LOCKED',
      '物理删除未开启：v0.5 起清理默认只读。' +
      '真删必须显式配置 cleanupAllowPhysicalDelete: true（且 dryRun: false）；' +
      '当前请求 dryRun=false 已被拒绝（零删除）。',
      { root, requestedDryRun: false, cleanupAllowPhysicalDelete: false }
    );
  }
  const physical = wantsPhysical && physicalAllowed;
  const day = localDate(nowMs, offsetMinutes);

  const originalsBefore = listOriginals(root);
  const selected = planCleanup({ originals: originalsBefore, month, sessionKey, limit });
  const beforeTotal = originalsBefore.length;

  // ==========================================================================
  // 七-一、dry-run（默认路径；零删除、独立编号、不占正式号）
  // ==========================================================================
  if (!physical) {
    const results = selected.map((item) => ({ item, result: R_SKIPPED, reason: '', note: DRY_RUN_NOTE }));
    const reportId = nextDryRunId(root, offsetMinutes);
    const ctx = buildReportContext({
      mode: 'dry-run', reportId, month, sessionKey, limit, offsetMinutes, nowMs,
      beforeTotal, results, prevReportId: DRY_RUN_PREV,
    });
    // 复核：dry-run 前后必须完全一致（零删除）
    const recheck = recheckRemaining(root, ctx.remaining);
    let reportPath = '';
    let journalPath = '';
    let appendixPath = '';
    let built = null;
    if (writeReport !== false) {
      built = renderCleanupReport(ctx); // 内含 S1–S8；不过则不写盘
      // V0.6.2：写端只写 `<root>/清册/`（新布局）；文件名/字节/排他写语义一律不变。
      appendixPath = ctx.appendix ? newLayoutPath(root, FILE_KIND.CLEANUP_APPENDIX, ctx.appendix.file) : '';
      if (built.csv) writeFileExclusive(appendixPath, built.csv);
      reportPath = newLayoutPath(root, FILE_KIND.CLEANUP_DRYRUN, `${reportId}.md`);
      writeFileExclusive(reportPath, built.text);
    }
    return {
      mode: 'dry-run',
      dryRun: true,
      reportId: writeReport === false ? '' : reportId,
      path: reportPath,
      journalPath,
      appendixPath,
      planned: selected.length,
      deleted: 0,
      succeeded: 0,
      failed: 0,
      skipped: results.map((r) => ({ item: r.item, reason: DRY_RUN_NOTE })),
      items: results,
      originalsBefore: originalsBefore.length,
      originalsAfter: listOriginals(root).length,
      filesUnchanged: true,
      report: built ? { text: built.text, csv: built.csv, ctx } : null,
      note: `dry-run：未删除任何文件；未占用正式 RPT 编号（复核：第 3 级=${recheck.diskCount}）`,
    };
  }

  // ==========================================================================
  // 七-二、显式物理清理（唯一会删文件的路径）
  // ==========================================================================
  const reportId = allocateFormalReportId(root, day);
  const prevReportId = previousReportId(root);
  // V0.6.2：正式清册与附录 CSV 只写 `<root>/清册/`；journal 仍在 `ledger/`（运行区）。
  const reportPath = newLayoutPath(root, FILE_KIND.CLEANUP_REPORT, `${reportId}.md`);
  const appendixPath = newLayoutPath(root, FILE_KIND.CLEANUP_APPENDIX, `${reportId}${APPENDIX_CSV_SUFFIX}`);
  let journalFd = null;
  let journalPath = '';
  try {
    const journal = openJournal(root, reportId);
    journalFd = journal.fd;
    journalPath = journal.journalPath;

    // 明细顺序 = 处理顺序 = 产生时间升序（同时间按编码），与终稿一致（CL-10/CL-25）
    const ordered = [...selected].sort((a, b) => {
      const ta = Number(a.mtimeMs);
      const tb = Number(b.mtimeMs);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return String(a.code) < String(b.code) ? -1 : String(a.code) > String(b.code) ? 1 : 0;
    });

    // 第 1 行：plan（清理前唯一一次"计划事实"落盘；之后每条结果各一行）。
    // files = 计划清理的原文文件名（CL-17：清册编码必须与 journal plan 记录的原文文件名一致）。
    appendJournal(journalFd, {
      kind: 'plan',
      reportId,
      at: localStamp(nowMs, offsetMinutes),
      scope: scopeLabel({ month, sessionKey, limit }),
      beforeTotal,
      planned: ordered.length,
      files: ordered.map((item) => originalFileNameOf(item.code)),
    });

    const results = [];
    let deleted = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      const item = ordered[i];
      const n = i + 1;
      const createdAt = localStamp(item.mtimeMs, offsetMinutes);
      let result = R_NOT_DELETED;
      let reason = '';
      let note = '';
      try {
        // 双保险：只允许删"第 3 级完整原文目录"下的 `<编码> 完整原文.md`。
        if (!isOriginalDirName(path.basename(path.dirname(item.abs))) || !item.abs.endsWith('.md')) {
          reason = '不是第 3 级完整原文路径（拒绝删除）';
        } else if (!fs.existsSync(item.abs)) {
          // 清册口径：文件已不存在 = 已清理（不是意外丢失），原因单列。
          result = R_DELETED;
          note = '文件已不存在（按已清理归集）';
        } else {
          fs.unlinkSync(item.abs);
          result = R_DELETED;
          // D11：视图与事件附件是一个清理单元 —— 删视图后附件不能留孤儿。
          if (item.attachmentExists && fs.existsSync(item.attachmentAbs)) {
            fs.unlinkSync(item.attachmentAbs);
          }
        }
      } catch (e) {
        result = R_NOT_DELETED;
        note = `删除失败：${String(e && e.message ? e.message : e).slice(0, 200)}`;
        reason = note;
      }
      if (result === R_DELETED) deleted += 1;
      // 第 2..M+1 行：result（每处理完 1 条立刻追加 1 行并 fsync）
      appendJournal(journalFd, {
        kind: 'result',
        n,
        code: item.code,
        createdAt,
        result,
        reason,
        note,
        at: localStamp(nowMs, offsetMinutes),
      });
      results.push({ item, result, reason, note });
    }

    // ---- 复核（拒绝写盘条件之一：复核值 != 目前剩余）----
    const ctx = buildReportContext({
      mode: 'physical', reportId, month, sessionKey, limit, offsetMinutes, nowMs,
      beforeTotal, results, prevReportId,
    });
    recheckRemaining(root, ctx.remaining);

    // ---- 渲染 + S1–S8（任一不过 → 不写盘，journal 保留现场）----
    const built = renderCleanupReport(ctx);
    if (built.csv) writeFileExclusive(appendixPath, built.csv);
    writeFileExclusive(reportPath, built.text);

    // 第 2+M+1 行：finalize（终稿成功后才写；崩溃则只有 plan+result，可恢复可解释）
    appendJournal(journalFd, {
      kind: 'finalize',
      reportFile: `${reportId}.md`,
      at: localStamp(nowMs, offsetMinutes),
      checks: 'S1..S8 pass',
    });

    return {
      mode: 'physical',
      dryRun: false,
      reportId,
      path: reportPath,
      journalPath,
      appendixPath: built.csv ? appendixPath : '',
      planned: selected.length,
      deleted,
      succeeded: ctx.succeeded,
      failed: ctx.failed,
      skipped: results.filter((r) => r.result === R_SKIPPED).map((r) => ({ item: r.item, reason: r.note })),
      items: results,
      originalsBefore: originalsBefore.length,
      originalsAfter: listOriginals(root).length,
      filesUnchanged: deleted === 0,
      report: { text: built.text, csv: built.csv, ctx },
    };
  } finally {
    if (journalFd !== null) { try { fs.closeSync(journalFd); } catch { /* ignore */ } }
  }
}
