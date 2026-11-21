#!/usr/bin/env node
/**
 * @file tools/doctor.mjs
 * @role **外置检测器（冷路径）**：把「机器还健康吗」做成可重复、可归档、可退出码判定的体检。
 *       `gate` 回答"这次记得对不对"（热路径，写账时三态）；`doctor` 回答"账本/采集/存储/报告还健康吗"（事后体检）。
 *       ★ 不进 tick：本文件是**独立 CLI**，`index.js` 不 import 它、不注册任何定时器；手动 / 日跑 / 交付验收时跑。
 *
 * 硬约束（写死在实现里，改任何一条都要先改设计）：
 *   1) **零依赖**：只 `node:fs` / `node:path` / `node:url` + `../lib/*.js`（core）。不装包、不引 docs/。
 *   2) **只读账库**：所有检查只调用 lib 的只读原语；`readAll` 固定
 *      `{requireLedgerRows:true, repairTornTail:false}`（绝不触发自愈/截断），`reconcile()` 本身只读。
 *      唯一写动作 = 报告落 `<报告目录>/doctor-YYYYMMDD-NN.json`（默认 `<root>/报告/`，可用 `--out=` 改；
 *      目录可建、文件只增不覆盖、tmp+rename 原子写）。除它之外**零写入**。
 *   3) **不假绿**：读不到 → `severity:'unknown'` + `ok:false`（不是"没问题"）；某类检查自身抛异常
 *      也只记 unknown 并继续跑其它类，不吞、不崩。
 *   4) **两类输出**：`--json` → 一份机器可读 JSON（stdout，与落盘同形状 + 人读 text 只落盘）；
 *      默认 → 一页纯文本（5 类各一段 + 结论 + "最该先看"）。
 *   5) **退出码**：0=全绿；1=有红（warning 不算红，`--strict` 时 warning 也算红）；2=用法/环境错误
 *      （缺 --root、root 不存在、报告写失败、doctor 自身异常）。
 *
 * 5 类检查（★ ②⑤ 的口径是"按 0.9.2 方案调整后"的，不是总纲原话；理由见下）：
 *   ① data-integrity  数据完整性：`ledger.readAll`（坏行/读错）+ `reconcile.reconcile`（缺凭证/孤儿凭证/
 *      缺口留痕 `lostGaps`）+ `reconcile.listArchiveFiles`（原文视图/附件份数）。台账"有效行"（按 code 去重）
 *      与原文视图份数比对 —— 重复 code 由 ② 负责，① 不重复计红。
 *   ② code-consistency 编码一致性：`encoder.isValidCode/parseCode`（格式 + 日期段真实日期 + 同一 (s12,gen)
 *      日期段一致 + 编码日期段不得晚于该行 ts 的本地日期）+ code / (sid,turn) 唯一 + `original.verifyOriginal`
 *      抽样复算**整份文件 sha256**（`expectedFullHash` = 台账 `docFileSha256`）。
 *      ★ 总纲原话"entryHash 复算失败"不可实现：全树 `entryHash` 0 命中，S-6 已否决（签字单 §三 S-6）。
 *   ③ ingest-health   采集健康：`ledger.readStateEx`（state 读不出/丢失/lastRunAt 年龄/游标卡住）+
 *      `legacy.scanSessionSources`（源会话数 / 不支持版本 / v3 只读源 / 并存对）+ `collector.createDiskCollector`
 *      （可见源 = 能打开的源）+ `pending.readPending`（pending 坏行/读失败）。不写 `.lost`、不做自愈。
 *      ★ ACPT-01（v1.0.0-re 审计修复）：判「游标卡住」红之前先过**活跃写入宽限** ——
 *      源 mtime 在 `CURSOR_STUCK_GRACE_MS`（2×intervalSeconds）内、或该源有未闭合轮 pending 留痕
 *      → 判 ok/warn（活动源，进 `details.cursors.active`）；只有「源静止超过宽限窗且游标仍停在旧位置」
 *      才算真·游标卡住判红。宽限口径见常量注释，并写进 `details.thresholds`。
 *   ④ storage-health  存储健康：只 stat 不读内容地 walk `<root>`（体积/文件数/最大单文件 ≤ 4 MB，xlsx 除外）
 *      + `pending` 体积 vs `pendingMaxBytes`（默认 1 MiB）+ `--corpus=` 时按 **S-9②/S-10⑤ 拆口径**查三条倍率
 *        （r1 整库/压缩语料只报告；r2 原文+视图 1.00–1.35× 解压语料代理；r3 套账(台账+索引) ≤0.05× 压缩语料；
 *         旧 1.25× 单口径作废，见 0.9.4-P3 方案 §4.7c）
 *      + 与上一份 doctor 报告的日增长率（>50% 只告警）。
 *   ⑤ run-report      运行报告：读 `<root>/ledger/.run-report-YYYYMMDD.json` **最近 N 天、每天最后一份**
 *      （`lib/report.js:36` 明写"当日覆盖而不是追加"），汇总每日 `counts/errors/lostGaps/tornTailRepaired`。
 *      ★ 总纲原话"最近 N 次 tick 的耗时与读盘"数据源不存在：报告无耗时字段（`elapsedMs|durationMs` 0 命中），
 *      唯一能拿到的"读盘"口径是 `Σ batches[].bytes`；输出里显式 `perTick:false`，不编数字。
 *
 * 用法：
 *   node tools\doctor.mjs --root=<账库根> [--json] [--strict] [--days=7]
 *                         [--out=<报告目录>] [--sessions=<DSH_HOME\sessions>] [--corpus=<语料目录>]
 *                         [--sample=20] [--no-write]
 *   例：node tools\doctor.mjs --root=D:\会话账本 --sessions=%DSH_HOME%\sessions --json
 *
 * 已知边界（0.9.2，如实写）：
 *   · `<root>/报告/` 是**新的一级目录**，会被 `lib/layout.js` 记进 `detectLayout().unknown[]`；
 *     `docs/自测-v062.mjs` 硬断言测试夹具根 `unknown.length===0` → **任何测试夹具根上不许跑 doctor**。
 *   · ③ 的"tick 停了"用 24h 告警窗（方案原写 2×intervalSeconds）：doctor 是手动/日跑，120s 窗必然误报；
 *     这里降为 warn 且阈值写进 details，不假报红。
 *   · ★ ACPT-01（v1.0.0-re 审计）：③「游标卡住」沿用 2×intervalSeconds 宽限窗（cordis 默认 60s → 120s），
 *     但窗内只要求"源 mtime 静止"这一条件：会话正在被写（mtime 新）或该源有未闭合轮 pending 留痕 →
 *     判 **ok/warn（活动源）**，不判红。真·卡住 = 源静止 > 2×interval 且游标仍停在旧位置（红）。
 *     理由：P0-2 的设计行为就是"未闭合轮把游标停在轮起点"，任何在写的会话都会出现
 *     `文件 size > 游标 size`；按旧判据"机主一干活 doctor 必红"，会被"任何红先修"系统性误阻断。
 *   · ⑤ 的"缺最近一份报告"判红（方案原写缺日→黄）：最近一份不存在/不是今天 = 今天没跑成或报告被删，
 *     对"机器健康吗"是红；历史缺日仍只告警。
 *   · `unavailable[]` 里 lite 结构上固定不采的两段（stuckSources/integrityFailures）不判黄（否则永远黄），
 *     其它"声明没采"的段才告警 —— 报告仍然原样进 details。
 *
 * @depends node:fs / node:path / node:url；../lib/ledger.js、../lib/reconcile.js、../lib/original.js、
 *          ../lib/encoder.js、../lib/pending.js、../lib/legacy.js、../lib/collector.js
 * @called-by 手动 / 外部日跑（本版不自动接线）；不进 tick。
 * @writes 仅 `<报告目录>/doctor-YYYYMMDD-NN.json`（tmp+rename，只增不覆盖）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAll, readStateEx, readLost, stampLocal } from '../lib/ledger.js';
import { reconcile, listArchiveFiles } from '../lib/reconcile.js';
import { verifyOriginal, originalRelPath } from '../lib/original.js';
import { isValidCode, parseCode } from '../lib/encoder.js';
import { readPending, pendingPath } from '../lib/pending.js';
import { scanSessionSources } from '../lib/legacy.js';
import { createDiskCollector } from '../lib/collector.js';

// ============================================================================
// 一、常量（阈值全部有出处；没有出处的在名字里写"WARN"并进 details.thresholds）
// ============================================================================

export const SCHEMA = 'doctor/1';
export const TOOL_VERSION = '1.0';

/** 时区口径固定 +08:00（与台账 ts / 原文路径 / 运行报告同名口径一致）。 */
const OFFSET_MINUTES = 480;

/** 单文件上限：总纲 §5.9 硬约束（xlsx 除外）。 */
const MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024;
/** pending 体积上限：`cordis.patch.yml` 的 pendingMaxBytes 默认值。 */
const PENDING_MAX_BYTES = 1024 * 1024;
/**
 * ★ S-10⑤（机主 2026-11-13 已签）/ S-9②：`--corpus` 倍率拆三条口径，旧 1.25× 单口径作废
 *   （出处：`_工作\计划\0.9.4-P3扩容方案.md` §4.7c；实测 E3 旧口径 3.49× 必红 = 口径过时，不是库坏）。
 *   r1 = 整库 / 压缩语料：**只报告不判红**（期望 3.0–3.6，偏离只 warn）；
 *   r2 = (原始事件.json + 完整原文.md) / Σ台账 attachment.bytes（解压语料代理）：红 iff <1.00 或 >1.35（C22②）；
 *   r3 = (ledger 日账 + 索引) / 压缩语料：红 iff >0.05（C22①）。
 *   ★ 行为不变：只告警不删。
 */
const CORPUS_R1_EXPECT_MIN = 3.0;
const CORPUS_R1_EXPECT_MAX = 3.6;
const CORPUS_R2_MIN = 1.0;
const CORPUS_R2_MAX = 1.35;
const CORPUS_R3_MAX = 0.05;
/** 与上一份 doctor 报告比，日增超过该比例只告警（方案 §2.4；无出处）。 */
const GROWTH_WARN_RATIO = 0.5;
/** "tick 停了"告警窗：doctor 是手动/日跑，方案原写 2×intervalSeconds(120s) 必然误报 → 24h。 */
const STATE_STALE_WARN_MS = 24 * 3600 * 1000;

/**
 * ★ ACPT-01（v1.0.0-re 审计修复）：③「游标卡住」的**活跃写入宽限窗** = 2×intervalSeconds。
 *
 * 为什么必须有：P0-2 的设计行为是"会话正在被写入时，游标停在**未闭合轮的起点**"（offset < size）；
 * 源每追加一段事件文件就长一截，于是 `源 size > 游标 size` 在"机主正在干活"期间**恒成立**。
 * 旧判据只看"文件长了、游标没动"就判红 → 任何活跃会话都会让 ③ 变红，真实账务却完全正常
 * （reconcile okStrict=true），按"任何红先修"的准入规则会被系统性误阻断（审计 ACPT-01）。
 *
 * 判据（两档宽限 + 一档真红，与 `details.thresholds` 输出同口径）：
 *   · 源 mtime 距今 ≤ 宽限窗            → 活动源（正在被写）：ok/warn，reason='mtime-recent'；
 *   · 源静止但该源有未闭合轮 pending 留痕 → P0-2 等 turn/end：ok/warn，reason='pending-unclosed'；
 *   · 源静止 > 宽限窗且游标仍停在旧位置 → **真·游标卡住**：red（这才是要修的）。
 *
 * 为什么用 2×（默认 120s）：cordis.patch.yml 默认 intervalSeconds=60，一个 tick 周期加一次宽限；
 * doctor 是独立 CLI、读不到插件配置，用默认值做**保守**宽限——把 interval 调大的用户只会更早判红，
 * 不会因为宽限窗过宽而假绿（假绿比假红更坏，这是本模块 "不假绿" 原则）。
 */
const CURSOR_STUCK_GRACE_MS = 2 * 60 * 1000;

const DEFAULT_DAYS = 7;
const DEFAULT_SAMPLE = 20;

/** 报告目录名：这个字符串**只在这里出现一次**（不引 layout.SUBDIR）。 */
const REPORT_DIR_NAME = '报告';

/** ⑤ 里 lite 结构上固定不采的两段（见文件头"已知边界"）。 */
const KNOWN_UNAVAILABLE = new Set(['stuckSources', 'integrityFailures']);

/** 检查定义（顺序 = 人读页/JSON checks[] 的规范顺序）。 */
const CHECK_DEFS = Object.freeze([
  { id: 'data-integrity', name: '①数据完整性' },
  { id: 'code-consistency', name: '②编码一致性' },
  { id: 'ingest-health', name: '③采集健康' },
  { id: 'storage-health', name: '④存储健康' },
  { id: 'run-report', name: '⑤运行报告' },
]);
const CHECK_ORDER = Object.fromEntries(CHECK_DEFS.map((d, i) => [d.id, i]));

const USAGE = `用法：node tools\\doctor.mjs --root=<账库根> [选项]
  --root=<账库根>        必填；账库根目录（只读；不存在 → exit 2）
  --json                 stdout 打印机器可读 JSON（同时照常落报告文件）
  --strict               warning 也算红（退出码 1）
  --days=N               ⑤ 读最近 N 天运行报告（默认 ${DEFAULT_DAYS}）
  --out=<报告目录>        报告落点（默认 <root>\\${REPORT_DIR_NAME}\\）
  --sessions=<目录>      ③ 源会话目录（DSH_HOME\\sessions；不给则采集扫描记"未测"）
  --corpus=<目录>        ④ 语料目录（给了才查 C22 三条倍率：r1 整库/语料仅报告；r2 原文+视图 1.00–1.35×；r3 套账 ≤0.05×）
  --sample=N             ② 抽样复算全文 sha256 的份数（默认 ${DEFAULT_SAMPLE}）
  --no-write             只打印、不落报告
  --help                 显示本说明

只读：除报告文件外不写账库任何文件；不进 tick。退出码 0=全绿 / 1=有红 / 2=用法或环境错误。`;

// ============================================================================
// 二、小工具
// ============================================================================

const pad2 = (n) => String(n).padStart(2, '0');
const errMsg = (e) => String((e && e.message) || e || '未知错误').slice(0, 400);

/** 本地(+08:00) `YYYY-MM-DD`。 */
function localDate(ms) {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
/** 本地(+08:00) `YYYYMMDD`。 */
function localYmd(ms) {
  return localDate(ms).replace(/-/g, '');
}
/** `YYYY-MM-DD` → 该日本地 00:00 的毫秒（用 Date.UTC 反推 +08:00）。 */
function dateToMs(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - OFFSET_MINUTES * 60000;
}
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '?';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const fmtPct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '?');
const shortList = (arr, n = 3) => {
  const a = Array.isArray(arr) ? arr : [];
  const shown = a.slice(0, n).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return shown.join('、') + (a.length > n ? ` 等 ${a.length} 个` : '');
};
/** `YYYYMMDD` 是不是真实存在的日历日（20260230 必须判假）。 */
function isValidYmd(s) {
  if (!/^\d{8}$/.test(String(s || ''))) return false;
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** 台账行 ts（ISO，可带偏移）→ 本地日期 `YYYY-MM-DD`；解析不出返回 ''。 */
function tsLocalDate(ts, offsetMinutes = OFFSET_MINUTES) {
  if (typeof ts !== 'string' || !ts) return '';
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '';
  return localDate(ms + (offsetMinutes - OFFSET_MINUTES) * 60000);
}

/**
 * 只 stat、不读内容地遍历目录（④ 专用）。符号链接目录不跟随（防环），符号链接文件按 lstat 计。
 * @returns {{files:Array<{path:string,rel:string,size:number}>, totalBytes:number, errors:Array}}
 */
function walkFiles(root, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 10;
  const files = [];
  const errors = [];
  let totalBytes = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ dir, message: errMsg(e) });
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      try {
        const st = ent.isSymbolicLink() ? fs.lstatSync(p) : fs.statSync(p);
        files.push({ path: p, rel: path.relative(root, p), size: st.size });
        totalBytes += st.size;
      } catch (e) {
        errors.push({ file: p, message: errMsg(e) });
      }
    }
  };
  walk(root, 0);
  return { files, totalBytes, errors };
}

/** 读一个 JSON 文件（失败不抛）。 */
function readJsonSafe(p) {
  let bytes = 0;
  try {
    bytes = fs.statSync(p).size;
  } catch {
    return { ok: false, exists: false, json: null, bytes: 0, error: '不存在/不可读' };
  }
  try {
    return { ok: true, exists: true, json: JSON.parse(fs.readFileSync(p, 'utf8')), bytes, error: '' };
  } catch (e) {
    return { ok: false, exists: true, json: null, bytes, error: errMsg(e) };
  }
}

/** 列出报告目录里已有的 doctor 报告（按文件名升序 = 时间升序）。 */
function listDoctorReports(outDir) {
  let names = [];
  try {
    names = fs.readdirSync(outDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = /^doctor-(\d{8})-(\d{2})\.json$/.exec(n);
    if (!m) continue;
    const p = path.join(outDir, n);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      /* ignore */
    }
    out.push({ name: n, path: p, ymd: m[1], nn: Number(m[2]), mtimeMs });
  }
  out.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return out;
}

/** 当天序号：`doctor-YYYYMMDD-NN.json` 里 NN 取"同日最大号 +1"。 */
function nextReportStem(outDir, nowMs) {
  const ymd = localYmd(nowMs);
  let max = 0;
  for (const r of listDoctorReports(outDir)) {
    if (r.ymd !== ymd) continue;
    if (r.nn > max) max = r.nn;
  }
  return `doctor-${ymd}-${pad2(max + 1)}`;
}

/** 检查结果构造器：ok 只由 severity 决定（warn 仍 ok，strict 由总退出码处理）。 */
function mkCheck(id, name, severity, message, details = {}) {
  const def = CHECK_DEFS.find((d) => d.id === id);
  return {
    id,
    name: name || (def ? def.name : id),
    ok: severity === 'ok' || severity === 'warn',
    severity,
    details: { message, ...details },
  };
}
const sevOf = (reds, warns) => (reds.length ? 'red' : warns.length ? 'warn' : 'ok');

// ============================================================================
// 三、① 数据完整性
// ============================================================================

export function checkDataIntegrity(ctx) {
  const root = ctx.root;
  const reds = [];
  const warns = [];
  const details = {};

  const all = ctx.ledger;
  if (!all) {
    return mkCheck('data-integrity', '①数据完整性', 'unknown', `台账读取失败：${ctx.ledgerError || '未知原因'}`, {
      readError: ctx.ledgerError || '',
    });
  }

  const records = Array.isArray(all.records) ? all.records : [];
  const codeSet = new Set();
  const sidTurnSet = new Set();
  for (const r of records) {
    if (r && typeof r.code === 'string') codeSet.add(r.code);
    if (r && r.sid !== undefined && r.turn !== undefined) sidTurnSet.add(`${r.sid}#${r.turn}`);
  }

  if (!all.dirExists) reds.push(`ledger 目录不存在：${all.dir}`);
  if (!all.ok) reds.push(`台账没读全（badLines=${all.badLines}，readErrors=${(all.readErrors || []).length}）`);
  if ((all.readErrors || []).length) {
    details.readErrors = all.readErrors.slice(0, 10).map((e) => ({
      file: path.basename(String(e.file || '')),
      code: e.code || '',
      line: e.line || null,
      message: String(e.message || e.error || '').slice(0, 200),
    }));
  }

  // 原文视图 / 附件：archive 模式（第 3 级档案）只认文件名里的 code。
  let archives = [];
  try {
    archives = listArchiveFiles(root);
  } catch (e) {
    reds.push(`档案列表读取失败：${errMsg(e)}`);
  }
  const views = archives.filter((a) => a.kind === 'view').length;
  const attachments = archives.filter((a) => a.kind === 'attachment').length;

  // 对账（纯只读）：缺凭证 / 孤儿凭证 / 缺口留痕
  let rec = null;
  try {
    rec = reconcile({ root, offsetMinutes: OFFSET_MINUTES, maxDetail: 200 });
  } catch (e) {
    reds.push(`对账失败：${errMsg(e)}`);
  }
  if (rec) {
    const miss = rec.originalMissing || [];
    const orphan = rec.originalOrphan || [];
    if (miss.length) {
      reds.push(`缺凭证 ${miss.length} 条：${shortList(miss.map((m) => `${m.code}[${m.part}]`))}`);
    }
    const orphanCodes = [...new Set(orphan.map((o) => String(o.code)))];
    if (orphan.length) {
      // 同一 code 的视图 + 附件会各报一条；人读按"code"去重，机器数保留文件条数
      reds.push(`孤儿凭证 ${orphanCodes.length} 个 code（原文在、台账无此 code）：${shortList(orphanCodes)}`);
    }
    // "台账行数 vs 原文份数"：**按 code 去重后**的行数 vs 视图份数。
    // 重复 code 是 ② 的主键问题，这里不重复计红（避免"一红全红"的假判红）。
    if (views !== codeSet.size) {
      reds.push(`台账有效行 ${codeSet.size} ≠ 原文视图份数 ${views}（按 code 去重后比对）`);
    }
    // 附件按"文件名"去重再比（同一 code 重复行不该把附件数算两遍）
    const withAtt = new Set(records
      .filter((r) => r && r.attachment && typeof r.attachment.name === 'string' && r.attachment.name)
      .map((r) => r.attachment.name)).size;
    if (withAtt !== attachments) {
      warns.push(`台账登记附件 ${withAtt} 份 ≠ 实存附件 ${attachments} 份`);
    }
    details.reconcileOk = rec.ok === true;
    details.originalCount = Number(rec.originalCount) || 0;
    details.weeklyGroupsMissing = (rec.weeklyGroupsMissing || []).length;
    details.sealChainOk = !!(rec.sealChain && rec.sealChain.ok === true);
    if (!details.sealChainOk) warns.push('封板链异常（reconcile.sealChain.ok !== true）');
    if (details.weeklyGroupsMissing > 0) warns.push(`缺周记账组 ${details.weeklyGroupsMissing} 个`);
  }

  // 缺口留痕：只读（不追加、不修）
  let lost = { records: [], badLines: 0 };
  try {
    lost = readLost(root);
  } catch (e) {
    reds.push(`缺口留痕读取失败：${errMsg(e)}`);
  }
  if (lost.badLines > 0) reds.push(`缺口留痕文件有坏行 ${lost.badLines} 行（.lost.jsonl）`);
  if (lost.records.length > 0) warns.push(`缺口留痕 ${lost.records.length} 条（.lost.jsonl，历史缺口的已知记录）`);

  if (records.length === 0 && all.emptyProven !== true) {
    reds.push('台账 0 行且无法证明"读取成功"（不假绿）');
  }

  const severity = sevOf(reds, warns);
  let message;
  if (severity === 'red') {
    message = reds.slice(0, 3).join('；');
  } else {
    const parts = [
      `台账 ${records.length} 行（有效 ${codeSet.size}）/ 原文视图 ${views} / 附件 ${attachments}`,
      `坏行 ${all.badLines}、读错 ${(all.readErrors || []).length}`,
      `缺凭证 ${rec ? (rec.originalMissing || []).length : '?'}、孤儿 ${rec ? (rec.originalOrphan || []).length : '?'}`,
      `缺口留痕 ${lost.records.length}`,
    ];
    if (warns.length) parts.push(`告警：${warns.slice(0, 2).join('；')}`);
    message = parts.join('；');
  }

  return mkCheck('data-integrity', '①数据完整性', severity, message, {
    ledgerRows: records.length,
    effectiveRows: codeSet.size,
    distinctSidTurn: sidTurnSet.size,
    ledgerFiles: all.files,
    ledgerDirExists: all.dirExists === true,
    emptyProven: all.emptyProven === true,
    badLines: all.badLines,
    readErrorCount: (all.readErrors || []).length,
    views,
    attachments,
    originalMissing: rec ? (rec.originalMissing || []).length : null,
    originalOrphan: rec ? (rec.originalOrphan || []).length : null,
    originalOrphanCodes: rec ? [...new Set((rec.originalOrphan || []).map((o) => String(o.code)))].length : null,
    lostGaps: lost.records.length,
    lostBadLines: lost.badLines,
    ledgerDir: all.dir,
    warnings: warns,
  });
}

// ============================================================================
// 四、② 编码一致性（entryHash 已被 S-6 否决 → 用"整份文件 sha256"复算）
// ============================================================================

export function checkCodeConsistency(ctx) {
  const root = ctx.root;
  const reds = [];
  const warns = [];
  const details = {};

  const all = ctx.ledger;
  if (!all) {
    return mkCheck('code-consistency', '②编码一致性', 'unknown', `台账读取失败：${ctx.ledgerError || '未知原因'}`, {
      readError: ctx.ledgerError || '',
    });
  }
  const records = Array.isArray(all.records) ? all.records : [];

  // ── 主键唯一性与编码结构 ──────────────────────────────────────────────
  const codeCount = new Map();
  const sidTurnCount = new Map();
  const invalid = [];
  const badDates = [];
  const s12GenDates = new Map(); // `${s12}#${gen}` → {date, code}
  const dateClashes = [];

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const code = typeof r.code === 'string' ? r.code : '';
    if (!isValidCode(code)) {
      invalid.push(code || '(空 code)');
      continue;
    }
    codeCount.set(code, (codeCount.get(code) || 0) + 1);
    const stKey = `${r.sid}#${r.turn}`;
    sidTurnCount.set(stKey, (sidTurnCount.get(stKey) || 0) + 1);

    const p = parseCode(code);
    if (!p) {
      invalid.push(code);
      continue;
    }
    // 日期段：必须是真实日历日（20260230 之类判假）
    if (!isValidYmd(p.date)) {
      badDates.push(`${code}（日期段 ${p.date} 不是真实日期）`);
    } else {
      // 同一会话（s12+gen）的编码日期段必须一致（编码日期 = 会话开始日）
      const sk = `${p.s12}#${p.gen}`;
      const prev = s12GenDates.get(sk);
      if (prev && prev.date !== p.date) {
        dateClashes.push(`${code} 与 ${prev.code}（同会话日期段 ${p.date} ≠ ${prev.date}）`);
      } else if (!prev) {
        s12GenDates.set(sk, { date: p.date, code });
      }
      // 编码日期段不得晚于该行 ts 的本地日期（会话开始日 ≤ 该轮结束日）
      const tsDate = tsLocalDate(r.ts, Number.isFinite(r.dateOffset) ? r.dateOffset : OFFSET_MINUTES);
      if (tsDate && p.date > tsDate.replace(/-/g, '')) {
        badDates.push(`${code}（编码日期 ${p.date} > ts 日期 ${tsDate}）`);
      }
    }
  }

  const dupCodes = [...codeCount.entries()].filter(([, n]) => n > 1).map(([c, n]) => `${c}×${n}`);
  const dupTurns = [...sidTurnCount.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  if (invalid.length) reds.push(`编码格式不合法 ${invalid.length} 个：${shortList(invalid)}`);
  if (dupCodes.length) reds.push(`code 重复 ${dupCodes.length} 组：${shortList(dupCodes)}`);
  if (dupTurns.length) reds.push(`(sid,turn) 重复 ${dupTurns.length} 组：${shortList(dupTurns)}`);
  if (badDates.length) reds.push(`日期段异常 ${badDates.length} 处：${shortList(badDates)}`);
  if (dateClashes.length) reds.push(`同会话日期段不一致 ${dateClashes.length} 处：${shortList(dateClashes)}`);

  // ── 原文全文 sha256 抽样复算（S-6 之后的唯一"内容有没有被改"凭据）─────────
  const byCode = new Map();
  for (const r of records) {
    if (!r || typeof r.code !== 'string') continue;
    const p = parseCode(r.code);
    if (!p) continue;
    byCode.set(r.code, r);
  }
  const allCodes = [...byCode.keys()].sort();
  const sampleN = Math.max(0, Math.min(Number.isInteger(ctx.sample) ? ctx.sample : DEFAULT_SAMPLE, allCodes.length));
  const step = sampleN > 0 ? Math.max(1, Math.floor(allCodes.length / sampleN)) : 1;
  const sampled = [];
  for (let i = 0; i < allCodes.length && sampled.length < sampleN; i += step) sampled.push(allCodes[i]);

  const hashProblems = [];
  let hashOk = 0;
  for (const code of sampled) {
    const row = byCode.get(code);
    const p = parseCode(code);
    let rel = typeof row.doc === 'string' && row.doc ? row.doc : '';
    let abs = rel ? path.resolve(root, rel) : '';
    if (!abs || !fs.existsSync(abs)) {
      const alt = path.resolve(root, originalRelPath(+p.date.slice(0, 4), +p.date.slice(4, 6), code));
      if (fs.existsSync(alt)) abs = alt;
      else {
        hashProblems.push({ code, problems: ['FILE_MISSING'], file: rel || '' });
        continue;
      }
    }
    let expectedFullHash = typeof row.docFileSha256 === 'string' ? row.docFileSha256 : '';
    if (!expectedFullHash) {
      warns.push(`${code} 台账缺 docFileSha256（无法复算全文哈希）`);
      continue;
    }
    let v;
    try {
      v = verifyOriginal(abs, {
        expectedFullHash,
        expectedBodyHash: typeof row.docSha256 === 'string' ? row.docSha256 : '',
        expectedCode: code,
        expectedAttachmentSha256: row.attachment && typeof row.attachment.sha256 === 'string' ? row.attachment.sha256 : '',
        expectedAttachmentName: row.attachment && typeof row.attachment.name === 'string' ? row.attachment.name : '',
      });
    } catch (e) {
      hashProblems.push({ code, problems: ['VERIFY_THROW:' + errMsg(e)], file: abs });
      continue;
    }
    if (v.ok) hashOk++;
    else hashProblems.push({ code, problems: v.problems, file: path.relative(root, abs) });
  }
  if (hashProblems.length) {
    const sampleTxt = hashProblems.slice(0, 3).map((h) => `${h.code}[${(h.problems || []).join(',')}]`);
    reds.push(`原文复核失败 ${hashProblems.length}/${sampled.length} 份（全文 sha256 / 编码 / 附件）：${shortList(sampleTxt)}`);
  }
  if (!sampled.length) {
    if (allCodes.length === 0) warns.push('台账为空，没有原文可抽样');
    else warns.push(`--sample=${ctx.sample} 跳过了全文哈希抽样（不假绿：抽样未做）`);
  }

  const severity = sevOf(reds, warns);
  let message;
  if (severity === 'red') {
    message = reds.slice(0, 3).join('；');
  } else {
    message = [
      `code 唯一 / (sid,turn) 唯一`,
      `抽样 ${sampled.length} 份全文 sha256 全符`,
      `entryHash 已被 S-6 否决，不检`,
    ].join('；');
    if (warns.length) message += `；告警：${warns.slice(0, 2).join('；')}`;
  }

  return mkCheck('code-consistency', '②编码一致性', severity, message, {
    rows: records.length,
    uniqueCodes: codeCount.size,
    uniqueSidTurn: sidTurnCount.size,
    invalidCode: invalid.length,
    duplicateCodeGroups: dupCodes.length,
    duplicateSidTurnGroups: dupTurns.length,
    dateSegmentInvalid: badDates.length,
    dateSegmentClashes: dateClashes.length,
    hashSampled: sampled.length,
    hashVerified: hashOk,
    hashMismatch: hashProblems.length,
    hashProblems: hashProblems.slice(0, 10),
    checkHash: 'sha256(full file) of 完整原文.md（expectedFullHash = 台账 docFileSha256）',
    entryHash: 'not present (S-6 rejected)',
    warnings: warns,
  });
}

// ============================================================================
// 五、③ 采集健康
// ============================================================================

export function checkIngestHealth(ctx) {
  const root = ctx.root;
  const reds = [];
  const warns = [];
  const details = {};

  const state = ctx.state || { ok: false, exists: false, state: {}, error: { message: '未读取' } };
  const st = state.state && typeof state.state === 'object' ? state.state : {};
  details.state = {
    exists: state.exists === true,
    ok: state.ok === true,
    lastRunAt: typeof st.lastRunAt === 'string' ? st.lastRunAt : '',
    firstRunAt: typeof st.firstRunAt === 'string' ? st.firstRunAt : '',
    cursorCount: Object.keys(st.sourceCursors || {}).length,
    error: state.ok ? null : (state.error || { message: '未知' }),
  };
  if (!state.ok) reds.push(`state 读不出（${(state.error && state.error.code) || 'E_STATE'}）：${(state.error && state.error.message) || '未知'}`);
  if (state.ok && !state.exists) {
    if ((ctx.ledger && ctx.ledger.records && ctx.ledger.records.length) > 0) reds.push('state 缺失，但台账已有行（游标/首跑标记丢了）');
    else warns.push('state 尚未创建（首次开账前）');
  }

  // lastRunAt 年龄（tick 停了 → 只告警；见文件头"已知边界"）
  let lastRunAgeMs = null;
  if (typeof st.lastRunAt === 'string' && st.lastRunAt) {
    const ms = Date.parse(st.lastRunAt);
    if (Number.isFinite(ms)) {
      lastRunAgeMs = ctx.nowMs - ms;
      details.lastRunAgeSeconds = Math.round(lastRunAgeMs / 1000);
      if (lastRunAgeMs > STATE_STALE_WARN_MS) {
        warns.push(`上次 tick 是 ${(lastRunAgeMs / 3600000).toFixed(1)}h 前（>24h 告警窗），tick 可能停了`);
      } else if (lastRunAgeMs < -5 * 60000) {
        warns.push(`lastRunAt 在未来（${st.lastRunAt}），时钟可能不对`);
      }
    } else {
      warns.push(`lastRunAt 解析不出：${st.lastRunAt}`);
    }
  } else if (state.ok && state.exists) {
    warns.push('state 里没有 lastRunAt');
  }

  // pending 证据（只读）
  let pending = { records: [], badLines: 0, readError: '' };
  try {
    pending = readPending(root);
  } catch (e) {
    pending = { records: [], badLines: 0, readError: errMsg(e) };
  }
  if (pending.readError) reds.push(`pending 证据读失败：${pending.readError}`);
  if (pending.badLines > 0) reds.push(`pending 证据有坏行 ${pending.badLines} 行（.pending.jsonl）`);
  let pendingBytes = 0;
  try {
    pendingBytes = fs.statSync(pendingPath(root)).size;
  } catch {
    pendingBytes = 0;
  }
  details.pending = { records: pending.records.length, badLines: pending.badLines, readError: pending.readError, bytes: pendingBytes };

  // ★ ACPT-01：pending 里的「未闭合轮」= 该源在等 turn/end 的活证据。按源路径建索引（大小写不敏感，
  //   Windows 路径），供下面的游标宽限判据使用；坏行/读失败不参与匹配（已由上面的红/告警覆盖）。
  const pendingSources = new Set();
  for (const rec of Array.isArray(pending.records) ? pending.records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const srcPath = typeof rec.source === 'string' ? rec.source : (typeof rec.file === 'string' ? rec.file : '');
    if (srcPath) pendingSources.add(path.resolve(srcPath).toLowerCase());
  }

  // 源会话扫描（legacy + collector 的只读能力）
  if (!ctx.sessionsBase) {
    warns.push('未提供 --sessions：采集扫描没测（state/pending 已查，但不许当绿）');
    details.sessionsBase = 'not given';
    details.sourceSessions = null;
    details.visibleSources = null;
    details.unsupportedVersions = null;
    details.v3ReadOnlySources = null;
  } else {
    details.sessionsBase = ctx.sessionsBase;
    if (!fs.existsSync(ctx.sessionsBase)) {
      reds.push(`sessions 目录不存在：${ctx.sessionsBase}`);
    } else {
      let sc = { supported: [], pairs: [], unsupported: [] };
      try {
        sc = scanSessionSources(ctx.sessionsBase);
      } catch (e) {
        reds.push(`扫描源会话失败：${errMsg(e)}`);
      }
      let sessions = [];
      try {
        sessions = createDiskCollector({ sessionsBase: ctx.sessionsBase }).listSessions();
      } catch (e) {
        reds.push(`collector.listSessions 失败：${errMsg(e)}`);
      }
      const unsupported = Array.isArray(sc.unsupported) ? sc.unsupported : [];
      const v3 = sessions.filter((s) => Number(s.version) === 3);
      const pairs = Array.isArray(sc.pairs) ? sc.pairs : [];
      // 可见源：能只读打开（不读内容）
      const unreadable = [];
      for (const s of sessions) {
        try {
          const fd = fs.openSync(s.path, 'r');
          fs.closeSync(fd);
        } catch (e) {
          unreadable.push({ path: s.path, message: errMsg(e) });
        }
      }
      details.sourceSessions = sessions.length;
      details.visibleSources = sessions.length - unreadable.length;
      details.unsupportedVersions = unsupported.length;
      details.unsupportedList = unsupported.slice(0, 10).map((u) => path.basename(u.path));
      details.v3ReadOnlySources = v3.length;
      details.sourcePairs = pairs.length;
      details.unreadableSources = unreadable.slice(0, 10).map((u) => path.basename(u.path));
      if (unsupported.length) {
        reds.push(`不支持版本的会话 ${unsupported.length} 个（永不入账）：${shortList(unsupported.map((u) => `${path.basename(u.path)} v${u.version}`))}`);
      }
      if (unreadable.length) reds.push(`源文件打不开 ${unreadable.length} 个：${shortList(unreadable.map((u) => path.basename(u.path)))}`);
      if (sessions.length === 0) warns.push('sessions 目录里没有任何受支持的会话源');

      // 游标 vs 源文件当前状态：文件变了、游标没动 = 卡住（红）
      // ★ ACPT-01：判红前先过**活跃写入宽限**（口径见 CURSOR_STUCK_GRACE_MS 常量注释）：
      //   · 源 mtime 在宽限窗内 = 正在被写（P0-2 设计行为：游标停在未闭合轮起点，offset<size）；
      //   · 该源有未闭合轮 pending 留痕 = 在等 turn/end；
      //   两者判 ok/warn（活动源），只有「源静止超过宽限窗 + 游标仍停在旧位置」才是真·卡住。
      const cursors = st.sourceCursors && typeof st.sourceCursors === 'object' ? st.sourceCursors : {};
      const cursorKeys = Object.keys(cursors);
      const stuck = [];
      const active = []; // 宽限命中的活动源（不进 reds；由 details.cursors.active + warn 呈现）
      const shrunk = [];
      const gone = [];
      const mtimeChanged = [];
      for (const src of cursorKeys) {
        const cur = cursors[src] && typeof cursors[src] === 'object' ? cursors[src] : {};
        let s = null;
        try {
          s = fs.statSync(src);
        } catch {
          gone.push(path.basename(path.dirname(src)));
          continue;
        }
        const curSize = Number(cur.size) || 0;
        const curOffset = Number(cur.offset) || 0;
        if (s.size < curSize) {
          shrunk.push(`${path.basename(path.dirname(src))} ${curSize}→${s.size} B`);
        } else if (s.size > curSize && curOffset <= curSize) {
          // 文件长了，但游标仍停在旧文件大小（或更早）。先分"在途"与"真卡住"：
          const mtimeAgeMs = Math.max(0, ctx.nowMs - s.mtimeMs); // 源最后一次变化距今
          const hasPending = pendingSources.has(path.resolve(src).toLowerCase());
          const graceReason = mtimeAgeMs <= CURSOR_STUCK_GRACE_MS
            ? 'mtime-recent' // 正在被写
            : (hasPending ? 'pending-unclosed' : ''); // 在等未闭合轮闭合
          const label = `${path.basename(path.dirname(src))} 文件 ${curSize}→${s.size} B，游标仍 ${curOffset}`;
          if (graceReason) {
            active.push({
              source: label,
              reason: graceReason,
              growBytes: s.size - curSize,
              mtimeAgeMs: Math.round(mtimeAgeMs),
            });
          } else {
            // 源静止 > 宽限窗、没有未闭合轮留痕，游标仍停在旧位置 → 下一轮 tick 没把它读进来
            stuck.push(label);
          }
        } else if (cur.mtimeMs && Math.abs(s.mtimeMs - Number(cur.mtimeMs)) > 2) {
          mtimeChanged.push(path.basename(path.dirname(src)));
        }
      }
      // state 里没游标的源 = 还没入账（正常在"新会话还没跑 tick"时出现 → 告警）
      const cursorLower = new Set(cursorKeys.map((p) => p.toLowerCase()));
      const notIngested = sessions.filter((s) => !cursorLower.has(String(s.path).toLowerCase())).map((s) => s.sid || path.basename(path.dirname(s.path)));
      details.cursors = {
        total: cursorKeys.length,
        stuck: stuck.slice(0, 10),
        active: active.slice(0, 10),
        activeCount: active.length,
        shrunk: shrunk.slice(0, 10),
        gone: gone.slice(0, 10),
        mtimeChanged: mtimeChanged.slice(0, 10),
        notIngested: notIngested.slice(0, 10),
        graceBasis: 'mtime-recent=源 mtime 在宽限窗内（正在被写）；pending-unclosed=该源有未闭合轮 pending（等 turn/end）',
      };
      if (stuck.length) reds.push(`游标卡住 ${stuck.length} 个：${shortList(stuck)}`);
      if (active.length) {
        warns.push(`活动写入宽限 ${active.length} 个源（正在写/有未闭合轮，游标暂未到 EOF，按 P0-2 设计不判红）：${shortList(active.map((a) => a.source))}`);
      }
      if (shrunk.length) reds.push(`源文件变小/被替换 ${shrunk.length} 个：${shortList(shrunk)}`);
      if (gone.length) warns.push(`游标指向的源已不在 ${gone.length} 个：${shortList(gone)}`);
      if (mtimeChanged.length) warns.push(`源 mtime 变了但字节数没变 ${mtimeChanged.length} 个（疑似替换）：${shortList(mtimeChanged)}`);
      if (notIngested.length) warns.push(`有 ${notIngested.length} 个源尚未入账（state 无游标）：${shortList(notIngested)}`);
    }
  }

  const severity = sevOf(reds, warns);
  let message;
  if (severity === 'red') {
    message = reds.slice(0, 3).join('；');
  } else {
    const src = details.sourceSessions === null
      ? '源会话未测（--sessions 未给）'
      : `源会话 ${details.sourceSessions} / 可见 ${details.visibleSources} / 不支持版本 ${details.unsupportedVersions} / v3 只读源 ${details.v3ReadOnlySources}`;
    const stateTxt = !state.ok
      ? 'state 读不出'
      : !state.exists
        ? 'state 未创建'
        : `state 正常（lastRunAt ${details.state.lastRunAt || '?'}${lastRunAgeMs !== null ? `，${(lastRunAgeMs / 3600000).toFixed(1)}h 前` : ''}）`;
    message = [src, stateTxt, `pending ${pending.records.length} 条`].join('；');
    if (warns.length) message += `；告警：${warns.slice(0, 2).join('；')}`;
  }

  return mkCheck('ingest-health', '③采集健康', severity, message, {
    sessionsBase: ctx.sessionsBase || 'not given',
    sourceSessions: details.sourceSessions,
    visibleSources: details.visibleSources,
    unsupportedVersions: details.unsupportedVersions,
    unsupportedList: details.unsupportedList || [],
    unreadableSources: details.unreadableSources || [],
    v3ReadOnlySources: details.v3ReadOnlySources,
    sourcePairs: details.sourcePairs,
    state: details.state,
    lastRunAgeSeconds: details.lastRunAgeSeconds ?? null,
    cursors: details.cursors || null,
    pending: details.pending,
    thresholds: {
      stateStaleWarnMs: STATE_STALE_WARN_MS,
      pendingMaxBytes: PENDING_MAX_BYTES,
      // ★ ACPT-01：游标卡住的判据口径（写在输出里，别只写在注释里）
      cursorStuckGraceMs: CURSOR_STUCK_GRACE_MS,
      cursorStuckRule: '游标卡住=red iff 源 size>游标 size 且源 mtime 静止 > 2×intervalSeconds 且该源无未闭合轮 pending；' +
        '源 mtime 在宽限窗内（正在被写）或该源有未闭合轮 pending → 活动源宽限（ok/warn，不判红）',
    },
    warnings: warns,
  });
}

// ============================================================================
// 六、④ 存储健康
// ============================================================================

export function checkStorageHealth(ctx) {
  const root = ctx.root;
  const reds = [];
  const warns = [];
  const details = {
    thresholds: {
      maxSingleFileBytes: MAX_SINGLE_FILE_BYTES,
      pendingMaxBytes: PENDING_MAX_BYTES,
      growthWarnRatio: GROWTH_WARN_RATIO,
      // ★ S-10⑤：三条倍率口径（旧 1.25× 单口径作废，仅留名可追溯）
      corpusR1Expect: [CORPUS_R1_EXPECT_MIN, CORPUS_R1_EXPECT_MAX],
      corpusR2Range: [CORPUS_R2_MIN, CORPUS_R2_MAX],
      corpusR3Max: CORPUS_R3_MAX,
      corpusRatioMaxDeprecated: '1.25×（0.9.2 旧口径；S-10⑤ 作废，不再判红 —— 旧口径拿压缩语料当分母，必然 3.49×）',
    },
  };

  const walk = walkFiles(root);
  details.rootBytes = walk.totalBytes;
  details.fileCount = walk.files.length;
  if (walk.errors.length) {
    reds.push(`有 ${walk.errors.length} 个路径 stat/readdir 失败（体积会少算，不假绿）：${shortList(walk.errors.map((e) => path.basename(e.dir || e.file || '') || e.message))}`);
  }
  const sorted = [...walk.files].sort((a, b) => b.size - a.size);
  const maxFile = sorted[0] || null;
  details.maxFile = maxFile ? { path: maxFile.rel, bytes: maxFile.size } : null;

  const bigNonXlsx = sorted.filter((f) => f.size > MAX_SINGLE_FILE_BYTES && !/\.xlsx$/i.test(f.path));
  const bigXlsx = sorted.filter((f) => f.size > MAX_SINGLE_FILE_BYTES && /\.xlsx$/i.test(f.path));
  details.bigFiles = bigNonXlsx.slice(0, 10).map((f) => ({ path: f.rel, bytes: f.size }));
  details.bigXlsxAllowed = bigXlsx.slice(0, 10).map((f) => ({ path: f.rel, bytes: f.size }));
  if (bigNonXlsx.length) {
    reds.push(`单文件超 ${fmtBytes(MAX_SINGLE_FILE_BYTES)} 上限 ${bigNonXlsx.length} 个：${shortList(bigNonXlsx.map((f) => `${f.rel}（${fmtBytes(f.size)}）`))}`);
  }

  // pending 体积
  let pendingBytes = 0;
  try {
    pendingBytes = fs.statSync(pendingPath(root)).size;
  } catch {
    pendingBytes = 0;
  }
  details.pendingBytes = pendingBytes;
  if (pendingBytes > PENDING_MAX_BYTES) {
    reds.push(`pending 体积 ${fmtBytes(pendingBytes)} > 上限 ${fmtBytes(PENDING_MAX_BYTES)}（.pending.jsonl 积压）`);
  }

  // 体积 vs 语料的 C22 三条倍率（给了 --corpus 才查；没给 = skipped，不假绿也不假红）
  // ★ S-10⑤ 拆口径：r1 只报告；r2 / r3 是红线。旧 1.25× 单口径已作废。
  details.corpusBytes = null;
  details.ratio = null;
  details.corpusRatios = null;
  if (!ctx.corpusDir) {
    details.corpus = 'not given（语料倍率检查 skipped）';
  } else if (!fs.existsSync(ctx.corpusDir) || !fs.statSync(ctx.corpusDir).isDirectory()) {
    reds.push(`语料目录不存在/不是目录：${ctx.corpusDir}`);
    details.corpus = ctx.corpusDir;
  } else {
    const cw = walkFiles(ctx.corpusDir);
    details.corpusBytes = cw.totalBytes;
    details.corpusFileCount = cw.files.length;
    details.corpus = ctx.corpusDir;
    if (cw.errors.length) reds.push(`语料目录有 ${cw.errors.length} 个路径读失败（倍率会少算）`);
    if (cw.totalBytes <= 0) {
      reds.push('语料体积为 0，倍率无法计算（不假绿）');
    } else {
      // ── 分子/分母的材料（全部只读）：台账日账 / 索引 / 原文+视图 / Σ附件字节 ──
      const relOf = (f) => String(f.rel).split(path.sep).join('/');
      const basenameOf = (f) => path.basename(f.path);
      const sumSize = (arr) => arr.reduce((a, f) => a + (Number(f.size) || 0), 0);
      const ledgerFiles = walk.files.filter((f) => /^ledger\/[^/]+\.jsonl$/.test(relOf(f)) && !basenameOf(f).startsWith('.'));
      const indexFiles = walk.files.filter((f) => /^ledger\/\.index\//.test(relOf(f)));
      const viewSetFiles = walk.files.filter((f) => / 原始事件\.json$/.test(basenameOf(f)) || / 完整原文\.md$/.test(basenameOf(f)));
      const ledgerBytes = sumSize(ledgerFiles);
      const indexBytes = sumSize(indexFiles);
      const viewSetBytes = sumSize(viewSetFiles);
      // Σ台账 attachment.bytes = 解压语料代理（台账行由 ①/② 共享的 readAll 已读入，不额外读盘）
      let attachmentBytes = 0;
      let attachmentRows = 0;
      let ledgerRowsSeen = 0;
      let ledgerReadOk = false;
      if (ctx.ledger && Array.isArray(ctx.ledger.records)) {
        ledgerReadOk = ctx.ledger.ok !== false;
        for (const rec of ctx.ledger.records) {
          ledgerRowsSeen++;
          const b = rec && rec.attachment ? Number(rec.attachment.bytes) : NaN;
          if (Number.isFinite(b) && b > 0) {
            attachmentBytes += b;
            attachmentRows++;
          }
        }
      }
      const r1 = walk.totalBytes / cw.totalBytes;
      const r2 = ledgerReadOk && attachmentBytes > 0 ? viewSetBytes / attachmentBytes : null;
      const r3 = (ledgerBytes + indexBytes) / cw.totalBytes;
      details.ratio = r1; // 兼容旧字段 = r1（只报告项）
      details.corpusRatios = {
        naming: 'S-9②/S-10⑤；分母=--corpus 压缩语料字节；r2 分子=原始事件.json+完整原文.md，分母=Σ台账 attachment.bytes（解压语料代理）',
        r1: { name: 'r1 整库/压缩语料（报告项·不判红）', value: r1, expect: [CORPUS_R1_EXPECT_MIN, CORPUS_R1_EXPECT_MAX] },
        r2: {
          name: 'r2 原文+视图/Σ台账附件字节（C22②）', value: r2, range: [CORPUS_R2_MIN, CORPUS_R2_MAX],
          viewSetBytes, viewSetFiles: viewSetFiles.length, attachmentBytes, attachmentRows,
          ...(ledgerReadOk ? {} : { skippedReason: '台账读不完整（① 已报）→ 不计算（不假绿）' }),
        },
        r3: { name: 'r3 套账(台账+索引)/压缩语料（C22①）', value: r3, max: CORPUS_R3_MAX, ledgerBytes, indexBytes, ledgerFiles: ledgerFiles.length, indexFiles: indexFiles.length },
        ledgerRowsSeen,
      };
      // r1 只报告不判红；明显偏离期望区间才 warn（压缩比变化/大库冷热都可能造成，不假报红）
      if (!(r1 >= CORPUS_R1_EXPECT_MIN && r1 <= CORPUS_R1_EXPECT_MAX)) {
        warns.push(`r1 整库/压缩语料 ${r1.toFixed(2)}× 偏离期望 ${CORPUS_R1_EXPECT_MIN}–${CORPUS_R1_EXPECT_MAX}×（仅报告项，不判红）`);
      }
      // r2 红线（S-9②：原文+视图 1.00–1.35× 解压语料）
      if (r2 === null) {
        reds.push('r2 原文+视图倍率算不出：Σ台账 attachment.bytes=0 或台账不可读（不假绿）');
      } else if (r2 < CORPUS_R2_MIN || r2 > CORPUS_R2_MAX) {
        reds.push(`r2 原文+视图/Σ台账附件字节 = ${r2.toFixed(3)} 不在 ${CORPUS_R2_MIN}–${CORPUS_R2_MAX}（C22②）`);
      }
      // r3 红线（S-9②：套账 ≤0.05× 压缩语料）
      if (r3 > CORPUS_R3_MAX) {
        reds.push(`r3 套账(台账 ${fmtBytes(ledgerBytes)} + 索引 ${fmtBytes(indexBytes)}) / 压缩语料 ${fmtBytes(cw.totalBytes)} = ${r3.toFixed(4)}× > ${CORPUS_R3_MAX}×（C22①）`);
      }
    }
  }

  // 日增率：与上一份 doctor 报告比（没有就 skipped）
  const prevs = listDoctorReports(ctx.outDir);
  const prev = prevs.length ? prevs[prevs.length - 1] : null;
  details.growth = { prevReport: prev ? prev.name : null };
  if (!prev) {
    details.growth.skipped = '没有上一份 doctor 报告';
  } else {
    const pj = readJsonSafe(prev.path);
    if (!pj.ok || !pj.json) {
      details.growth.skipped = `上一份 doctor 报告读不出：${pj.error}`;
    } else {
      const prevBytes = Number(pj.json && pj.json.storage && pj.json.storage.totalBytes);
      const prevFiles = Number(pj.json && pj.json.storage && pj.json.storage.fileCount);
      if (Number.isFinite(prevBytes) && prevBytes > 0) {
        details.growth.bytesRatio = (walk.totalBytes - prevBytes) / prevBytes;
        if (details.growth.bytesRatio > GROWTH_WARN_RATIO) {
          warns.push(`账库体积日增 ${fmtPct(details.growth.bytesRatio)}（>${fmtPct(GROWTH_WARN_RATIO)}）：${fmtBytes(prevBytes)} → ${fmtBytes(walk.totalBytes)}（对比 ${prev.name}）`);
        }
      }
      if (Number.isFinite(prevFiles) && prevFiles > 0) {
        details.growth.filesRatio = (walk.files.length - prevFiles) / prevFiles;
        if (details.growth.filesRatio > GROWTH_WARN_RATIO) {
          warns.push(`文件数日增 ${fmtPct(details.growth.filesRatio)}（>${fmtPct(GROWTH_WARN_RATIO)}）：${prevFiles} → ${walk.files.length} 个（对比 ${prev.name}）`);
        }
      }
      if (details.growth.bytesRatio === undefined) details.growth.skipped = '上一份报告没有 storage 段';
    }
  }

  const severity = sevOf(reds, warns);
  let message;
  if (severity === 'red') {
    message = reds.slice(0, 3).join('；');
  } else {
    const parts = [
      `体积 ${fmtBytes(walk.totalBytes)} / 文件 ${walk.files.length}`,
      `最大单文件 ${maxFile ? fmtBytes(maxFile.size) : '无'}（上限 ${fmtBytes(MAX_SINGLE_FILE_BYTES)}）`,
      `pending ${fmtBytes(pendingBytes)} / ${fmtBytes(PENDING_MAX_BYTES)}`,
    ];
    if (details.corpusRatios) {
      const cr = details.corpusRatios;
      parts.push(`r1 整库/语料 ${cr.r1.value.toFixed(2)}×（报告项）`);
      parts.push(cr.r2.value === null ? 'r2 原文+视图 skipped' : `r2 原文+视图 ${cr.r2.value.toFixed(3)}×`);
      parts.push(`r3 套账 ${cr.r3.value.toFixed(4)}×`);
    } else {
      parts.push('语料倍率 skipped');
    }
    if (warns.length) parts.push(`告警：${warns.slice(0, 2).join('；')}`);
    message = parts.join('；');
  }

  return mkCheck('storage-health', '④存储健康', severity, message, {
    rootBytes: walk.totalBytes,
    fileCount: walk.files.length,
    maxFile: details.maxFile,
    bigFiles: details.bigFiles,
    bigXlsxAllowed: details.bigXlsxAllowed,
    pendingBytes,
    pendingMaxBytes: PENDING_MAX_BYTES,
    corpus: details.corpus || 'not given',
    corpusBytes: details.corpusBytes,
    ratio: details.ratio,
    corpusRatios: details.corpusRatios,
    growth: details.growth,
    thresholds: details.thresholds,
    walkErrors: walk.errors.slice(0, 10),
    warnings: warns,
  });
}

// ============================================================================
// 七、⑤ 运行报告
// ============================================================================

export function checkRunReport(ctx) {
  const root = ctx.root;
  const ledgerDir = path.dirname(pendingPath(root)); // <root>/ledger（只借路径，不写）
  const days = Number.isInteger(ctx.days) && ctx.days > 0 ? ctx.days : DEFAULT_DAYS;
  const reds = [];
  const warns = [];
  const details = {};

  // 逐日索引：date → [{name,path,ymd,json,error,bytes,mtimeMs}]
  const byDate = new Map();
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir);
  } catch (e) {
    return mkCheck('run-report', '⑤运行报告', 'unknown', `ledger 目录读不出：${errMsg(e)}`, { reportDir: ledgerDir });
  }
  for (const n of names) {
    const m = /^\.run-report-(\d{8})\.json$/.exec(n);
    if (!m) continue;
    const p = path.join(ledgerDir, n);
    const r = readJsonSafe(p);
    const rec = { name: n, path: p, ymd: m[1], ok: r.ok, json: r.json, error: r.error, bytes: r.bytes };
    if (!byDate.has(m[1])) byDate.set(m[1], []);
    byDate.get(m[1]).push(rec);
  }
  // 每天最后一份（报告是当日覆盖写；同日若有多份取文件名最大者，纯防御）
  for (const list of byDate.values()) list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const dates = [...byDate.keys()].sort();
  const latestDate = dates.length ? dates[dates.length - 1] : '';
  const latest = latestDate ? byDate.get(latestDate)[byDate.get(latestDate).length - 1] : null;

  // 期望窗口：最近 N 天，但从"首次开账（state.firstRunAt）"那天起算（新账库不背历史缺日的锅）
  const today = localYmd(ctx.nowMs);
  const firstRunAt = ctx.state && ctx.state.state && typeof ctx.state.state.firstRunAt === 'string'
    ? Date.parse(ctx.state.state.firstRunAt) : NaN;
  const firstDay = Number.isFinite(firstRunAt) ? localYmd(firstRunAt) : today;
  const expected = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(ctx.nowMs + OFFSET_MINUTES * 60000);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
    if (ymd >= firstDay && ymd <= today) expected.push(ymd);
  }

  details.reportDir = ledgerDir;
  details.days = days;
  details.firstExpectedDay = expected.length ? expected[expected.length - 1] : null;
  details.lastExpectedDay = expected.length ? expected[0] : null;
  details.reportFiles = dates.length;

  if (!latest) {
    reds.push(`运行报告全缺：${ledgerDir} 下一个 .run-report-*.json 也没有（tick 没跑成 / 报告被删）`);
  } else if (!latest.ok) {
    reds.push(`最近一份运行报告 JSON 解析失败：${latest.name}（${latest.error}）`);
  } else {
    const j = latest.json || {};
    const counts = j.counts && typeof j.counts === 'object' ? j.counts : null;
    if (!counts || !j.reconcile || typeof j.reconcile !== 'object') {
      reds.push(`最近一份运行报告形状不可用（缺 counts/reconcile）：${latest.name}`);
    } else {
      if (j.reconcile.ok !== true) {
        reds.push(`最近一份运行报告 reconcile.ok=${String(j.reconcile.ok)}（${latest.name}）`);
      }
      const gate = j.gate && typeof j.gate === 'object' ? j.gate.conclusion : '';
      details.latestGate = gate || '(缺)';
      if (gate === 'unknown') reds.push(`最近一份 gate=unknown：${String(j.gate.reason || '').slice(0, 120)}`);
      else if (gate === 'degraded') warns.push(`最近一份 gate=degraded：${String(j.gate.reason || '').slice(0, 120)}`);
      else if (!gate) warns.push('最近一份运行报告没有 gate 段（无法复核闸门结论）');
      const countsErrors = Number(counts.errors) || 0;
      const errs = Array.isArray(j.errors) ? j.errors.length : 0;
      const warnsArr = Array.isArray(j.warnings) ? j.warnings : [];
      if (countsErrors > 0 || errs > 0) warns.push(`最近一份 counts.errors=${countsErrors}、errors[]=${errs}`);
      if (warnsArr.length) warns.push(`最近一份 warnings[]=${warnsArr.length}：${shortList(warnsArr.map((w) => String(w).slice(0, 60)))}`);
      const unavailable = Array.isArray(j.unavailable) ? j.unavailable : [];
      const extraUnavail = unavailable.filter((x) => !KNOWN_UNAVAILABLE.has(String(x)));
      details.unavailable = unavailable;
      if (extraUnavail.length) warns.push(`最近一份报告声明"没采"的段：${shortList(extraUnavail)}`);
      const batches = Array.isArray(j.batches) ? j.batches : [];
      details.latestBatches = batches.length;
      details.ingestBytes = batches.reduce((a, b) => a + (Number(b && b.bytes) || 0), 0);
      details.eventOversize = Number(counts.eventOversize) || 0;
      if (details.eventOversize > 0) warns.push(`最近一份 eventOversize=${details.eventOversize}`);
    }
    if (latestDate !== today) {
      reds.push(`最近一份运行报告不是今天（今天 ${today}，最近 ${latestDate}）—— 今天没跑成或报告被删`);
    }
  }

  // 缺日：只对"历史天"告警（最近一份/今天缺失已在上面判红）
  const missing = expected.filter((d) => !byDate.has(d));
  details.missingDays = missing;
  const olderMissing = missing.filter((d) => d !== today && d !== latestDate);
  if (olderMissing.length) {
    warns.push(`最近 ${days} 天里缺 ${olderMissing.length} 天报告：${shortList(olderMissing)}`);
  }
  // 历史坏报告（非最近一份）→ 告警
  const invalidOld = [];
  for (const d of dates) {
    for (const rec of byDate.get(d)) {
      if (rec.name !== (latest && latest.name) && !rec.ok) invalidOld.push(`${rec.name}（${rec.error}）`);
    }
  }
  if (invalidOld.length) warns.push(`历史运行报告解析失败 ${invalidOld.length} 份：${shortList(invalidOld)}`);

  // 每日汇总（最近 N 天、每天最后一份）：counts / errors / lostGaps / tornTailRepaired
  const daily = expected.map((d) => {
    const list = byDate.get(d) || [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return { date: d, present: false };
    if (!last.ok) return { date: d, present: true, name: last.name, parseError: last.error };
    const j = last.json || {};
    const counts = j.counts && typeof j.counts === 'object' ? j.counts : {};
    return {
      date: d,
      present: true,
      name: last.name,
      generatedAt: typeof j.generatedAt === 'string' ? j.generatedAt : '',
      gate: j.gate && typeof j.gate === 'object' ? j.gate.conclusion : '',
      counts: {
        ledgerRows: Number(counts.ledgerRows) || 0,
        originalMissing: Number(counts.originalMissing) || 0,
        originalOrphan: Number(counts.originalOrphan) || 0,
        lostGaps: Number(counts.lostGaps) || 0,
        errors: Number(counts.errors) || 0,
        warnings: Number(counts.warnings) || 0,
        batches: Number(counts.batches) || 0,
      },
      errors: Array.isArray(j.errors) ? j.errors.length : 0,
      warnings: Array.isArray(j.warnings) ? j.warnings.length : 0,
      tornTailRepaired: Array.isArray(j.tornTailRepaired) ? j.tornTailRepaired.length : 0,
      ingestBytes: (Array.isArray(j.batches) ? j.batches : []).reduce((a, b) => a + (Number(b && b.bytes) || 0), 0),
    };
  });
  details.daily = daily;

  const severity = sevOf(reds, warns);
  let message;
  if (severity === 'red') {
    message = reds.slice(0, 3).join('；');
  } else {
    const present = daily.filter((x) => x.present).length;
    message = [
      `最近 ${days} 天：${present} 天有报告 / 缺 ${missing.length} 天`,
      `最近 gate=${details.latestGate || '?'}`,
      `采集字节 ${fmtBytes(details.ingestBytes || 0)}（耗时口径无数据源）`,
    ].join('；');
    if (warns.length) message += `；告警：${warns.slice(0, 2).join('；')}`;
  }

  return mkCheck('run-report', '⑤运行报告', severity, message, {
    reportDir: ledgerDir,
    days,
    expectedDays: expected.length,
    reportFiles: dates.length,
    missingDays: missing,
    latest: latest
      ? { name: latest.name, date: latestDate, parseOk: latest.ok, generatedAt: latest.ok && latest.json ? latest.json.generatedAt || '' : '', gate: details.latestGate || '', ingestBytes: details.ingestBytes || 0 }
      : null,
    latestBatches: details.latestBatches ?? null,
    ingestBytes: details.ingestBytes ?? null,
    eventOversize: details.eventOversize ?? null,
    unavailable: details.unavailable || [],
    knownStructuralUnavailable: [...KNOWN_UNAVAILABLE],
    perTick: false,
    perTickReason: 'lib/report.js:36 当日覆盖写；报告无 elapsedMs/durationMs 字段 → "最近 N 次 tick 耗时"无数据源',
    daily,
    warnings: warns,
  });
}

// ============================================================================
// 八、人读页 / 报告落盘 / 主流程
// ============================================================================

const SEV_LABEL = { ok: 'ok', warn: 'warn', red: 'RED', unknown: 'UNKNOWN' };
const SEV_RANK = { red: 0, unknown: 1, warn: 2, ok: 3 };

/** 一页纯文本（红项排最前；最后一行给"最该先看"）。 */
export function renderText(out) {
  const lines = [];
  lines.push(`doctor · ${out.generatedAt} · root=${out.root}`);
  lines.push(`报告：${out.reportPath || (out.reportError ? `落盘失败（${out.reportError}）` : '未落盘（--no-write）')}`);
  lines.push('─'.repeat(60));
  const sorted = [...out.checks].sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (CHECK_ORDER[a.id] - CHECK_ORDER[b.id]));
  for (const c of sorted) {
    let msg = String(c.details && c.details.message ? c.details.message : '');
    if (msg.length > 180) msg = msg.slice(0, 180) + '…';
    lines.push(`${c.name}  ${SEV_LABEL[c.severity] || c.severity}  ${msg}`);
  }
  lines.push('─'.repeat(60));
  const s = out.summary;
  lines.push(`结论：绿 ${s.ok} / 黄 ${s.warn} / 红 ${s.red} / 未知 ${s.unknown} —— 退出码 ${out.exitCode}${out.strict ? '（--strict：warning 计红）' : ''}`);
  const first = sorted.find((c) => c.severity === 'red' || c.severity === 'unknown' || c.severity === 'warn');
  if (first) {
    const msg = String((first.details && first.details.message) || '').slice(0, 150);
    lines.push(`最该先看：${first.name} —— ${msg}`);
  } else {
    lines.push('最该先看：无（5 类全绿）');
  }
  return lines.join('\n');
}

/**
 * 原子写报告：tmp + rename；同日序号取"最大号 +1"；**只增不覆盖**。
 * 这是 doctor 唯一允许的写动作。
 * @returns {{ok:boolean, id:string, path:string, bytes:number, error:string}}
 */
export function writeReportAtomic(outDir, out) {
  let stem = '';
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      stem = nextReportStem(outDir, Date.now());
      const target = path.join(outDir, `${stem}.json`);
      if (fs.existsSync(target)) continue; // 并发/序号竞争：换下一个号
      const text = renderText({ ...out, reportPath: target, reportId: stem });
      const fileObj = {
        ...out,
        schema: SCHEMA,
        toolVersion: TOOL_VERSION,
        reportId: stem,
        reportPath: target,
        text,
      };
      const body = JSON.stringify(fileObj, null, 2) + '\n';
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, body, 'utf8');
      try {
        fs.renameSync(tmp, target);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      return { ok: true, id: stem, path: target, bytes: Buffer.byteLength(body, 'utf8'), error: '' };
    }
    return { ok: false, id: stem, path: path.join(outDir, `${stem}.json`), bytes: 0, error: '同日序号竞争 5 次仍失败' };
  } catch (e) {
    return { ok: false, id: stem, path: path.join(outDir, stem ? `${stem}.json` : ''), bytes: 0, error: errMsg(e) };
  }
}

/** 参数解析（未知参数/缺 root/数字非法 → error，调用方 exit 2）。 */
export function parseArgs(argv) {
  const opts = {
    root: '', json: false, strict: false, days: DEFAULT_DAYS, outDir: '',
    sessionsBase: '', corpus: '', sample: DEFAULT_SAMPLE, noWrite: false, help: false,
  };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-write') opts.noWrite = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else if (a.startsWith('--out=')) opts.outDir = a.slice('--out='.length);
    else if (a.startsWith('--sessions=')) opts.sessionsBase = a.slice('--sessions='.length);
    else if (a.startsWith('--corpus=')) opts.corpus = a.slice('--corpus='.length);
    else if (a.startsWith('--days=')) {
      const n = Number(a.slice('--days='.length));
      if (!Number.isInteger(n) || n < 1 || n > 365) return { error: `--days 必须是 1..365 的整数（收到 ${a}）` };
      opts.days = n;
    } else if (a.startsWith('--sample=')) {
      const n = Number(a.slice('--sample='.length));
      if (!Number.isInteger(n) || n < 0 || n > 100000) return { error: `--sample 必须是 0..100000 的整数（收到 ${a}）` };
      opts.sample = n;
    } else {
      return { error: `未知参数：${a}` };
    }
  }
  if (opts.help) return { opts };
  if (!opts.root) return { error: '必须给 --root=<账库根>（doctor 只读检查账库，根必须显式指定）' };
  return { opts };
}

/** 单类检查的兜底：自身异常 → unknown（不吞成绿、也不让整页崩掉）。 */
function safeCheck(id, fn) {
  const def = CHECK_DEFS.find((d) => d.id === id);
  const t0 = Date.now();
  try {
    const c = fn();
    return { ...c, ms: Date.now() - t0 };
  } catch (e) {
    return {
      id,
      name: def ? def.name : id,
      ok: false,
      severity: 'unknown',
      details: { message: `检查自身异常：${errMsg(e)}` },
      ms: Date.now() - t0,
    };
  }
}

/**
 * 跑一次完整体检（不含 CLI 参数解析/退出码打印，便于单测与外部复用）。
 * @param {{root:string, outDir?:string, sessionsBase?:string, corpus?:string, days?:number,
 *          sample?:number, strict?:boolean, noWrite?:boolean, nowMs?:number}} opts
 * @returns 报告对象（= JSON 输出形状；落盘时额外带 schema/toolVersion/reportId/reportPath/text）
 */
export function runDoctor(opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const root = path.resolve(String(opts.root || ''));
  const outDir = path.resolve(opts.outDir || path.join(root, REPORT_DIR_NAME));
  const ctx = {
    root,
    outDir,
    sessionsBase: opts.sessionsBase ? path.resolve(opts.sessionsBase) : '',
    corpusDir: opts.corpus ? path.resolve(opts.corpus) : '',
    days: Number.isInteger(opts.days) && opts.days > 0 ? opts.days : DEFAULT_DAYS,
    sample: Number.isInteger(opts.sample) ? opts.sample : DEFAULT_SAMPLE,
    strict: opts.strict === true,
    nowMs,
    offsetMinutes: OFFSET_MINUTES,
    ledger: null,
    ledgerError: '',
    state: null,
  };
  // 共享只读读入：① ② 共用一份台账；③ ⑤ 共用一份 state
  try {
    ctx.ledger = readAll(root, { requireLedgerRows: true, repairTornTail: false });
  } catch (e) {
    ctx.ledger = null;
    ctx.ledgerError = errMsg(e);
  }
  try {
    ctx.state = readStateEx(root);
  } catch (e) {
    ctx.state = { ok: false, exists: false, path: '', state: {}, bytes: 0, error: { code: 'E_STATE_READ', message: errMsg(e) } };
  }

  const checks = [
    safeCheck('data-integrity', () => checkDataIntegrity(ctx)),
    safeCheck('code-consistency', () => checkCodeConsistency(ctx)),
    safeCheck('ingest-health', () => checkIngestHealth(ctx)),
    safeCheck('storage-health', () => checkStorageHealth(ctx)),
    safeCheck('run-report', () => checkRunReport(ctx)),
  ];
  const summary = { ok: 0, warn: 0, red: 0, unknown: 0 };
  for (const c of checks) {
    if (c.severity === 'red') summary.red++;
    else if (c.severity === 'unknown') summary.unknown++;
    else if (c.severity === 'warn') summary.warn++;
    else summary.ok++;
  }
  const anyFail = summary.red > 0 || summary.unknown > 0;
  const anyWarn = summary.warn > 0;
  let exitCode = anyFail || (ctx.strict && anyWarn) ? 1 : 0;

  const out = {
    schema: SCHEMA,
    toolVersion: TOOL_VERSION,
    ok: exitCode === 0,
    exitCode,
    root,
    generatedAt: stampLocal(nowMs, OFFSET_MINUTES),
    offsetMinutes: OFFSET_MINUTES,
    strict: ctx.strict,
    days: ctx.days,
    sample: ctx.sample,
    reportId: null,
    reportPath: null,
    checks,
    summary,
    storage: (() => {
      const st = checks.find((c) => c.id === 'storage-health');
      const d = (st && st.details) || {};
      return { totalBytes: Number(d.rootBytes) || 0, fileCount: Number(d.fileCount) || 0, maxFileBytes: d.maxFile ? Number(d.maxFile.bytes) || 0 : 0 };
    })(),
  };

  // 唯一写动作：报告落盘（--no-write 时不写）
  if (!opts.noWrite) {
    const w = writeReportAtomic(outDir, out);
    out.reportId = w.id || null;
    out.reportPath = w.path || null;
    if (!w.ok) {
      out.reportError = w.error || '报告落盘失败';
      out.exitCode = 2;
      out.ok = false;
      exitCode = 2;
    }
  }
  return out;
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`doctor: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const root = path.resolve(opts.root);
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    console.error(`doctor: --root 不存在或不是目录：${root}`);
    return 2;
  }
  try {
    fs.accessSync(root, fs.constants.R_OK);
  } catch {
    console.error(`doctor: --root 不可读：${root}`);
    return 2;
  }

  let out;
  try {
    out = runDoctor({
      root,
      outDir: opts.outDir || '',
      sessionsBase: opts.sessionsBase || '',
      corpus: opts.corpus || '',
      days: opts.days,
      sample: opts.sample,
      strict: opts.strict,
      noWrite: opts.noWrite,
      nowMs: Date.now(),
    });
  } catch (e) {
    console.error(`doctor: 运行异常（不吞）：${(e && e.stack) || e}`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(out) + '\n');
  }
  if (out.reportError) {
    console.error(`doctor: 报告落盘失败：${out.reportError}`);
    return 2;
  }
  return out.exitCode;
}

// 直接 `node tools/doctor.mjs` 跑才执行；被 import（单测/外部复用）时只导出函数。
const isMain = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    return path.resolve(arg1) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    console.error('doctor: 未捕获异常：' + ((e && e.stack) || e));
    process.exitCode = 2;
  });
}
