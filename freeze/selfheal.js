/**
 * @file selfheal.js
 * @role 自愈扫描器 —— **只补可补的，绝不改账**（v0.5 D5 / 判据 HL-01…HL-12）。
 * @called-by index.js（周期自检；由调用方执行白名单动作与写运行报告）
 * @depends node:fs / node:path、./ledger.js、./weekly.js、./week.js、./original.js、./sealjournal.js
 *          ./layout.js（V0.6.2：一级布局/双路径解析）
 *
 * ⚠️ 白名单（D5 原话，代码里必须只有这些写动作）：
 *   ① 补目录：一级 / 月份 / 原文夹 → `mkdir -p`（不动任何文件字节）；
 *   ② "组存在、xlsx 缺、**未封板**" → 只**返回动作** `{type:'writeWeekly'}`，
 *      由调用方用既有 `writeWeekly()` 重建（selfheal 自己不写 xlsx，避免与 weekly 双写）；
 *   ③ **封板**缺文件 / 凭证缺 / 交接表封板缺 → 只进 `reported`，**绝不重建**。
 *
 * @why 为什么"封板缺文件"不能重建：封板即事实（D12/P1-9）。重建出来的册子不是当初封板那本，
 *      却会被当成同一份证据 —— 比"缺"更坏。缺就报，交人处置。
 * @why 为什么"凭证缺"不能重建：完整原文是原始凭证，不可变（P0-7）；缺了只能报缺凭证。
 * @why 为什么修复动作由调用方执行：writeWeekly 是周记账模块的写路径（含封板判定/补记/快照），
 *      自愈器若自己调，会绕开它的状态机，制造第二个写者（v0.4 的 P2-1 教训）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readAll, readState, stampLocal } from '../lib/ledger.js';
import { groupRecords, resolveDoc, readCleanedCodesCompat } from '../lib/weekly.js';
import { weekOf, weeklyFileName, weeklyFolderName } from '../lib/week.js';
import { draftNameOf } from '../lib/weeklystate.js';
import { originalRelPath } from '../lib/original.js';
import { monthOfCode } from '../lib/weekly.js';
import { isSealed, readSealEvents } from '../lib/sealjournal.js';
// V0.6.2：一级目录新布局（交接表/ 子目录）—— 读侧必须"新目录优先、一级兜底"
import { FILE_KIND, classifyFileName, resolveExisting } from '../lib/layout.js';

/** 自愈扫描结果版本。 */
export const SELFHEAL_VERSION = 1;

/** 月份目录名：`{年}年{月}月`。 */
const monthDir = (y, m) => `${y}年${String(m).padStart(2, '0')}月`;
/** 原文夹名：`{月}月总“完整原文”`。 */
const originalsDir = (m) => `${String(m).padStart(2, '0')}月总“完整原文”`;

/**
 * 交接表封板记录里的文件属于主表还是附表（决定双路径候选用哪个 kind）。
 *
 * @why journal/state 里的 `file`/`main` 可能是裸文件名（老库），也可能是 `交接表/xxx.md`
 *      这样的相对路径（新布局写端）。`resolveExisting` 的两个候选是"`<root>/交接表/<name>`"
 *      与"`<root>/<name>`"，路径里已带 `交接表/` 前缀时第二个候选正好命中 —— 所以这里
 *      只按**文件名**判 kind，不假设记录里存的是哪一种形状。
 *
 * @param {string} file
 * @returns {string} FILE_KIND.HANDOVER_MAIN | FILE_KIND.HANDOVER_APPENDIX
 */
function handoverKindOf(file) {
  const base = path.basename(typeof file === 'string' ? file : '');
  const kind = classifyFileName(base);
  return kind === FILE_KIND.HANDOVER_APPENDIX ? FILE_KIND.HANDOVER_APPENDIX : FILE_KIND.HANDOVER_MAIN;
}

/** 台账有效版本投影：同 code 取 max(version)（D10；旧行未标 version 视为 1）。 */
function effectiveRecords(records) {
  const byCode = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.code !== 'string' || !r.code) continue;
    const v = Number.isInteger(r.version) ? r.version : 1;
    const prev = byCode.get(r.code);
    if (!prev || v >= (Number.isInteger(prev.version) ? prev.version : 1)) byCode.set(r.code, r);
  }
  return [...byCode.values()];
}

/**
 * 自愈扫描（只读判定，不写任何字节）。
 *
 * @param {{root:string, offsetMinutes?:number}} p
 * @returns {{
 *   v:number, at:string, root:string, offsetMinutes:number,
 *   ledgerOk:boolean, readErrors:Array,
 *   dirMissing:Array<{dir:string, kind:'root'|'month'|'original'}>,
 *   weeklyDraftMissing:Array<{gid:string, file:string, sessKey:string, w:object}>,
 *   sealedBookMissing:Array<{gid:string, file:string, source:string}>,
 *   voucherMissing:Array<{code:string, doc:string, part:'view'|'attachment'}>,
 *   handoverSealedMissing:Array<{key:string, file:string, source:string}>
 * }}
 */
export function scan(p = {}) {
  const root = typeof p.root === 'string' ? p.root : '';
  const offsetMinutes = Number.isFinite(p.offsetMinutes) ? p.offsetMinutes : 480;
  const out = {
    v: SELFHEAL_VERSION,
    at: stampLocal(Number.isFinite(p.nowMs) ? p.nowMs : Date.now(), offsetMinutes),
    root,
    offsetMinutes,
    ledgerOk: false,
    ledgerEmptyProven: false,
    readErrors: [],
    dirMissing: [],
    weeklyDraftMissing: [],
    sealedBookMissing: [],
    voucherMissing: [],
    handoverSealedMissing: [],
  };
  if (!root) return out;

  // 一级目录：不存在就是"还没开账"，仍按白名单报出来（repair 可 mkdir）
  if (!fs.existsSync(root)) out.dirMissing.push({ dir: '', kind: 'root' });

  const all = readAll(root);
  out.ledgerOk = all.ok;
  out.ledgerEmptyProven = all.emptyProven === true;
  out.readErrors = all.readErrors;
  const recs = effectiveRecords(all.records);

  // ① 目录缺：月份目录 + 原文夹（按台账有效行的**周归属**推导，与写盘路径一致）
  const wantDirs = new Map(); // rel → kind
  for (const r of recs) {
    const ms = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(ms)) continue;
    const w = weekOf(ms, offsetMinutes);
    const m = monthDir(w.year, w.month);
    wantDirs.set(m, 'month');
    wantDirs.set(path.join(m, originalsDir(w.month)), 'original');
  }
  for (const [rel, kind] of wantDirs) {
    if (!fs.existsSync(path.join(root, rel))) out.dirMissing.push({ dir: rel, kind });
  }

  // ② 周记账：组存在但 xlsx 缺 → 细分"草稿可重建"与"封板不可重建"
  const seals = new Map(); // gid → 是否封板（journal 权威）
  const sealEvents = readSealEvents(root);
  for (const e of sealEvents.events) {
    if (e && e.kind === 'weekly-seal' && typeof e.key === 'string') seals.set(e.key, e);
  }
  let groups = new Map();
  try { groups = groupRecords(recs, offsetMinutes); } catch { groups = new Map(); }
  for (const [gid, g] of groups) {
    const file = path.join(weeklyFolderName(g.w), weeklyFileName(g.w, g.sessKey));
    if (fs.existsSync(path.join(root, file))) continue;
    // ★ V0.7 两态：正式名缺但草稿在 = 正常待封板草稿（写端每轮会重生成），不是"缺"、不需要重建动作。
    const draft = path.join(weeklyFolderName(g.w), draftNameOf(g.w, g.sessKey));
    if (fs.existsSync(path.join(root, draft))) continue;
    if (seals.has(gid)) {
      out.sealedBookMissing.push({ gid, file, source: 'journal' });
    } else {
      // 兼容期：journal 尚无该 gid 但 state 声称已封板 → **按封板对待**（保守：不重建）
      const st = readState(root);
      const stateSeal = st && st.weeklySealed && typeof st.weeklySealed === 'object' ? st.weeklySealed[gid] : null;
      if (stateSeal) out.sealedBookMissing.push({ gid, file, source: 'state' });
      else out.weeklyDraftMissing.push({ gid, file, sessKey: g.sessKey, w: { year: g.w.year, month: g.w.month, weekNo: g.w.weekNo } });
    }
  }

  // ③ 凭证缺（四态：已清理不算缺；附件声明了就必须在）
  let cleaned = null;
  try { cleaned = readCleanedCodesCompat(root); } catch { cleaned = null; }
  for (const r of recs) {
    const st = resolveDoc(root, r, offsetMinutes, cleaned);
    if (st.state === 'missing') {
      out.voucherMissing.push({ code: String(r.code), doc: st.rel || (typeof r.doc === 'string' ? r.doc : ''), part: 'view' });
      continue;
    }
    const att = r.attachment && typeof r.attachment === 'object' ? r.attachment : null;
    if (att && typeof att.name === 'string' && att.name) {
      const attRel = st.rel ? path.join(path.dirname(st.rel), att.name) : att.name;
      if (!fs.existsSync(path.join(root, attRel))) {
        out.voucherMissing.push({ code: String(r.code), doc: attRel, part: 'attachment' });
      }
    }
  }

  // ④ 交接表封板后主表缺失（journal 权威；state 兼容）
  //
  // ★ V0.6.2（机主已签《v0.6.2-迁移规格-v1》§2.2）：交接表写端移到 `<root>/交接表/`，
  //   但老库的表还在一级。这里必须按 `layout.resolveExisting` 的**双路径**判定
  //   （新目录优先、一级兜底）—— 否则老库一升级就满屏"封板后主表缺失"，
  //   拿假告警逼人去重建一份**不能重建**的证据（比缺更坏，见本文件头 @why）。
  const seenHandover = new Set();
  for (const e of sealEvents.events) {
    if (!e || e.kind !== 'handover-seal' || typeof e.key !== 'string' || seenHandover.has(e.key)) continue;
    seenHandover.add(e.key);
    const file = typeof e.file === 'string' ? e.file : '';
    const full = file ? resolveExisting(root, handoverKindOf(file), file) : '';
    if (!full) out.handoverSealedMissing.push({ key: e.key, file, source: 'journal' });
  }
  const st = readState(root);
  const ho = st && st.handoverSealed && typeof st.handoverSealed === 'object' ? st.handoverSealed : null;
  if (ho) {
    for (const [key, v] of Object.entries(ho)) {
      if (seenHandover.has(key)) continue;
      const main = v && typeof v.main === 'string' ? v.main : '';
      const full = main ? resolveExisting(root, handoverKindOf(main), main) : '';
      if (!full) out.handoverSealedMissing.push({ key, file: main, source: 'state' });
    }
  }

  return out;
}

/**
 * 执行白名单修复（只 mkdir + 返回动作；绝不改账、绝不重建不可重建项）。
 *
 * @param {object} scanResult scan() 的返回值
 * @param {{root:string}} p
 * @returns {{ok:boolean, repaired:Array<object>, reported:Array<object>,
 *            actions:Array<object>, errors:Array<object>, reason?:string}}
 *
 * @why 台账读不全（ledgerOk=false）时**拒绝 mkdir**：目录期望是从台账推导的，
 *      读不全就推不全，凭残缺数据建目录会制造"看起来正常"的假象（P1-8 同一原则）。
 */
export function repair(scanResult, p = {}) {
  const root = typeof p.root === 'string' ? p.root : '';
  const out = { ok: true, repaired: [], reported: [], actions: [], errors: [] };
  if (!scanResult || typeof scanResult !== 'object') {
    return { ...out, ok: false, reason: 'bad-scan' };
  }
  if (!root) return { ...out, ok: false, reason: 'missing root' };

  // 硬约束：读不全不修（只报）
  if (scanResult.ledgerOk === false) {
    out.reported.push({ type: 'ledger-unreadable', readErrors: scanResult.readErrors || [] });
    out.ok = false;
  } else {
    // ① 补目录（白名单唯一真实写动作）
    for (const d of scanResult.dirMissing || []) {
      const rel = typeof d.dir === 'string' ? d.dir : '';
      const full = rel ? path.join(root, rel) : root;
      try {
        fs.mkdirSync(full, { recursive: true });
        out.repaired.push({ type: 'mkdir', dir: rel, kind: d.kind || 'dir' });
      } catch (e) {
        out.errors.push({ type: 'mkdir', dir: rel, message: e && e.message ? e.message : String(e) });
        out.ok = false;
      }
    }
    // ② 草稿周记账缺 → 返回动作，由调用方用既有 writeWeekly 重建
    for (const g of scanResult.weeklyDraftMissing || []) {
      out.actions.push({ type: 'writeWeekly', gid: g.gid, file: g.file, sessKey: g.sessKey, w: g.w, reason: 'draft-missing' });
    }
  }

  // ③ 只报不改：封板缺文件 / 凭证缺 / 交接表封板缺
  for (const s of scanResult.sealedBookMissing || []) {
    out.reported.push({ type: 'sealed-book-missing', ...s, note: '封板即事实，不重建（D5/D12）' });
  }
  for (const v of scanResult.voucherMissing || []) {
    out.reported.push({ type: 'voucher-missing', ...v, note: '凭证不可变，不重建（P0-7）' });
  }
  for (const h of scanResult.handoverSealedMissing || []) {
    out.reported.push({ type: 'handover-sealed-missing', ...h, note: '封板后删了不重建（D5/HO）' });
  }
  return out;
}

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

/** 某条记录应有的完整原文相对路径（缺凭证时对外展示用）。
 *  ★ 2026-11-09 审计 #6：按**编码日期段**取月，与写端一致；否则跨月会话会展示成另一个月的路径。 */
export function expectedOriginalRel(rec, offsetMinutes = 480) {
  const ms = rec && typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
  const mm = monthOfCode(rec && rec.code, ms, offsetMinutes);
  if (!mm) return '';
  return originalRelPath(mm.year, mm.month, rec.code);
}
