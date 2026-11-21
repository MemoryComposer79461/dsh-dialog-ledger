/**
 * @file report.js
 * @role 运行报告写者 —— <root>/ledger/.run-report-YYYYMMDD.json（运行区，不是档案）。
 * @called-by index.js（每轮落一份运行报告；入口只负责调用与传段）
 * @depends node:fs / node:path、./ledger.js（stampLocal）、./week.js（weekOf）
 *
 * ★ 自 freeze/selfheal.js 抽出（S-1/§5.3）；freeze 版仅存档，不得再被 import。
 *
 * @why 为什么必须抽出来：写运行报告是**活功能**（RC-12 / HL-10 / HL-11 / BC-15 都要它），
 *      但 freeze/selfheal.js 已被冻结（S-1）。入口若还要经 freeze/ 才能拿到写者，
 *      "审核层运行期不可达"就是空话 —— 所以把写者搬进核心 lib/，freeze 版只留档。
 * @why 为什么不从 freeze/ 里 re-export：re-export 一样会把 freeze 留在 index 的
 *      运行期依赖图上，等于没搬。
 */

import fs from 'node:fs';
import path from 'node:path';

import { stampLocal } from './ledger.js';
import { weekOf } from './week.js';

// ★ 以下两个目录名助手与 freeze/selfheal.js **原样同源**（dirsForTs 依赖它们，未改一个字符）。
/** 月份目录名：`{年}年{月}月`。 */
const monthDir = (y, m) => `${y}年${String(m).padStart(2, '0')}月`;
/** 原文夹名：`{月}月总“完整原文”`。 */
const originalsDir = (m) => `${String(m).padStart(2, '0')}月总“完整原文”`;

/**
 * 写运行报告：`<root>/ledger/.run-report-YYYYMMDD.json`（运行区，不是档案）。
 *
 * @param {{root:string, result?:object, scan?:object, actions?:Array<object>,
 *          errors?:Array<object>, blockedSources?:Array<object>, stuckSources?:Array<object>,
 *          backfill?:object, nowMs?:number, offsetMinutes?:number}} p
 * @returns {{ok:boolean, path:string, bytes:number, reason?:string}}
 *
 * @why 当日覆盖而不是追加：运行报告是"最近一次跑成什么样"的快照（可重算、可丢）；
 *      但必须**原子写**（tmp + rename），否则崩溃会留下半截 JSON 被当成"结论"。
 * @why `errors/blockedSources/stuckSources` 由调用方传入（契约 D9/R-02）：
 *      错误清单只落"窗口内第一行"，**真实次数**（count/attempts）只能在运行报告里累加；
 *      报告是这些"被节流掉的次数"唯一的落脚点，不能丢。
 * @why counts 单独给且与数组长度自洽：门 1 要求"每条不变量有能失败的测试"，
 *      报告里的数字必须能被脚本直接断言（counts.originalMissing === originalMissing.length）。
 */
export function writeRunReport(p = {}) {
  const root = typeof p.root === 'string' ? p.root : '';
  if (!root) return { ok: false, path: '', bytes: 0, reason: 'missing root' };
  const offsetMinutes = Number.isFinite(p.offsetMinutes) ? p.offsetMinutes : 480;
  const nowMs = Number.isFinite(p.nowMs) ? p.nowMs : Date.now();
  const d = new Date(nowMs + offsetMinutes * 60000);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const dir = path.join(root, 'ledger');
  const target = path.join(dir, `.run-report-${ymd}.json`);
  const tmp = `${target}.tmp`;
  const result = p.result && typeof p.result === 'object' ? p.result : null;
  const scanRes = p.scan && typeof p.scan === 'object' ? p.scan : null;
  const actions = Array.isArray(p.actions) ? p.actions : [];
  // 契约（D9/R-02/附录 A）：run-report `errors[]` 每项必须带
  // `{kind,source,offset,fingerprint,count,lastAt,detail}`；这里做**形状归一**
  // （缺 count 默认 1、缺 lastAt 给空串），保证报告可被验收脚本直接断言，
  // 也避免调用方漏字段导致"次数被静默丢"。
  const errors = (Array.isArray(p.errors) ? p.errors : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      kind: typeof e.kind === 'string' ? e.kind : '',
      source: typeof e.source === 'string' ? e.source : '',
      offset: Number.isFinite(e.offset) ? Math.trunc(e.offset) : 0,
      fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : '',
      count: Number.isFinite(e.count) ? Math.trunc(e.count) : 1,
      lastAt: typeof e.lastAt === 'string' ? e.lastAt : '',
      detail: typeof e.detail === 'string' ? e.detail : '',
    }));
  const blockedSources = Array.isArray(p.blockedSources) ? p.blockedSources : [];
  const stuckSources = Array.isArray(p.stuckSources) ? p.stuckSources : [];
  // BC-15：补记链的计划摘要由调用方（index.js）从 `backfillPlan().report` 原样传入。
  // 只在给了对象时才落这个键，避免改变既有报告形状（老读法/老断言不受影响）。
  const backfill = p.backfill && typeof p.backfill === 'object' ? p.backfill : null;
  // 告警通道：与 errors 分开（"该知道"≠"出错了"）。只在有内容时才落键。
  const warnings = (Array.isArray(p.warnings) ? p.warnings : []).filter((w) => typeof w === 'string' && w);

  // ★ 审计 #1（2026-11-09）：附录 A 里那一大堆"模块自己那段"必须能透传，否则报告就是个空壳。
  //   规则：**调用方给了才落**（缺段合法）；调用方明确说"这一轮没采"时，用它给的
  //   `unavailable[]` 标出来 —— 绝不能把"没采到"伪装成"空数组 = 零"。
  const EXTRA_KEYS = [
    'batches', 'eventOversize', 'pending', 'legacyPartials', 'integrityFailures',
    'stalePending', 'receipt', 'handover', 'cursorResets', 'identityChanges', 'gate',
    // ★ F1（v1.0.0-preview4）：未闭合轮逐项清单（R1/R2 零静默）
    'openTurns',
    // ★ P1-02（v1.0.0-preview4）：报告快照新鲜度（对账时间/年龄/真实行数/是否叠加缺口）
    'freshness',
    // ★ F2（v1.0.0-preview4）：封板后补记待办（未放弃 / 已放弃）
    'supplementPending',
    'frameErrors', 'unavailable',
    // ★ V0.7：补记执行器摘要（journal 路径/executed/dupSkipped/failed/deferred/gaveUp）
    'backfillExec',
    // ★ V0.8：库外 manifest 锚摘要（ledger/package 是否追加/幂等）
    'deliveryAnchor',
    // ★ V0.6.2：一级布局快照 `{version,marker,oldFiles,dirsPresent}` 必须落交付物，
    //   否则"这个库是新布局还是旧布局、一级还有几份没搬"只活在日志里，审计看不到。
    //   选**既有 EXTRA_KEYS 通道**（而不是新开 gate 兄弟段）：报告形状不变，老读法
    //   遇到未知键本来就会忽略；新增专用段反而要改契约与所有读报告的工具。
    'layout',
    // ★ P0-3-resume（2026-11-09 夜）：崩溃撕裂尾巴自愈留痕 —— **必须落到交付物**
    //   `.run-report-*.json` 里，否则外部审计看不到"这一轮修过账尾"。
    //   字段：`[{file,line,bytes,sha256,at,offset,evidence}]`；没发生时不落键（缺段合法）。
    'tornTailRepaired',
    // ★ v1.0.0-re2（S-11 C42 (c)）：日结摘要版本账 —— 已发版本总数/最新版本号/本轮补发数，
    //   让"只能补发新版"这件事在交付物里可见（不许静默丢变化，也不许补发无痕）。
    'receiptDigest',
  ];
  const extras = {};
  for (const k of EXTRA_KEYS) {
    if (p[k] !== undefined) extras[k] = p[k];
  }
  const counts = {
    ledgerRows: result ? result.ledgerRows || 0 : 0,
    ledgerEmptyProven: !!(result && result.ledgerEmptyProven === true),
    originalMissing: result && Array.isArray(result.originalMissing) ? result.originalMissing.length : 0,
    originalOrphan: result && Array.isArray(result.originalOrphan) ? result.originalOrphan.length : 0,
    weeklyGroupsMissing: result && Array.isArray(result.weeklyGroupsMissing) ? result.weeklyGroupsMissing.length : 0,
    lostGaps: result && result.lostGaps ? result.lostGaps.count || 0 : 0,
    receiptBreaks: result && Array.isArray(result.receiptBreaks) ? result.receiptBreaks.length : 0,
    // ★ V0.6 / D18：legacy 基线的三个数必须进运行报告（"不隐藏"）
    legacyUnverifiable: result && Number.isFinite(result.legacyUnverifiableCount) ? result.legacyUnverifiableCount : 0,
    legacyUnmarkedNoEvidence: result && result.legacyMarks ? result.legacyMarks.unmarked || 0 : 0,
    legacyMarksMismatched: result && result.legacyMarks ? result.legacyMarks.mismatched || 0 : 0,
    legacyMarksChainOk: result && result.legacyMarks ? result.legacyMarks.chainOk === true : null,
    dirMissing: scanRes && Array.isArray(scanRes.dirMissing) ? scanRes.dirMissing.length : 0,
    weeklyDraftMissing: scanRes && Array.isArray(scanRes.weeklyDraftMissing) ? scanRes.weeklyDraftMissing.length : 0,
    sealedBookMissing: scanRes && Array.isArray(scanRes.sealedBookMissing) ? scanRes.sealedBookMissing.length : 0,
    voucherMissing: scanRes && Array.isArray(scanRes.voucherMissing) ? scanRes.voucherMissing.length : 0,
    handoverSealedMissing: scanRes && Array.isArray(scanRes.handoverSealedMissing) ? scanRes.handoverSealedMissing.length : 0,
    actions: actions.length,
    repaired: actions.length,
    errors: errors.length,
    warnings: warnings.length,
    blockedSources: blockedSources.length,
    stuckSources: stuckSources.length,
  };
  const report = {
    v: 1,
    // 附录 A（`v0.5-验收清单.md:230`）：运行报告必须有 `date` 与 `generatedAt`。
    // `at` 是 v0.5 早期读法，保留作兼容（HL-10 只断言 date/generatedAt 与 no-Z）。
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    generatedAt: stampLocal(nowMs, offsetMinutes),
    offsetMinutes,
    at: stampLocal(nowMs, offsetMinutes),
    root,
    reconcile: result,
    selfheal: scanRes,
    actions,
    errors,
    blockedSources,
    stuckSources,
    counts,
  };
  if (backfill) report.backfill = backfill;
  if (warnings.length) report.warnings = warnings;
  Object.assign(report, extras);
  if (Array.isArray(extras.batches)) counts.batches = extras.batches.length;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, path: target, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (e) {
    return { ok: false, path: target, bytes: 0, reason: e && e.message ? e.message : String(e) };
  }
}

/** 供调用方拼"月份目录/原文夹"（避免层层自己拼错）。 */
export function dirsForTs(tsMs, offsetMinutes = 480) {
  const w = weekOf(tsMs, offsetMinutes);
  return { monthDir: monthDir(w.year, w.month), originalsDir: originalsDir(w.month), w };
}
