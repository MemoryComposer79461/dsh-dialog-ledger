/**
 * @file receipt.js
 * @role 日结摘要（lite）：每天一张「这一天记了什么」的摘要 JSON —— 当天记了多少轮、
 *       多少份完整原文、有没有异常（坏行 / 未闭合），给人看、可随时从台账重出。
 *
 * @called-by index.js（每次扫描末尾，给"已完结日期"补摘要）、
 *            docs\自测-receipt*.mjs、docs\工具-核验收据.mjs（只读核验）
 * @depends node:fs / node:path、./ledger.js（ledgerDir）
 *
 * ★ lite 裁剪（机主裁定 S-1：没有"封板后被人改"的对手）：
 *   本模块原先是 v0.5 起的「防篡改收据」（v2.1 契约：库外锚 + 十键 + 前日链 + 交叉核验）。
 *   lite 只保留"汇总当日台账"这一件事，**砍掉**：
 *     · `ledgerSha256`：把摘要绑死在台账字节上的哈希绑定 → 只留行数/字节数/末条编码；
 *     · `prevReceiptSha256` 前后勾连：写侧不再算、读侧不再校 → 本版**不写这个字段**
 *       （旧平铺收据里的该字段读出来只是普通 JSON 属性，忽略）；
 *     · 链完整性校验 / 坏链 / 缺日断链（CHAIN_BREAK）；
 *     · 同日冲突拒写（RECEIPT_CONFLICT）：摘要坏了就重写，"后来者为准"；
 *     · 写后回读自证（RECEIPT_VERIFY_FAILED）。
 *   ★ v1.0.0-re DEF-03：**"锚必须真在库外"不是砍掉项、已恢复为强约束** ——
 *     `anchorIsOutside()` 在 `buildDailyReceipt` / `writeDailyReceipt` / `ensureReceipts`
 *     三个入口真正执行：锚 == root / 位于 root 内 / 是 root 祖先 → `ANCHOR_INSIDE_ROOT` 拒生成
 *     （**零写入、不改台账**；账务照常）。
 *     为什么要恢复：`cordis.patch.yml` 与 README 对外承诺了这条拒绝语义（"否则 ANCHOR_INSIDE_ROOT
 *     拒生成"），实现却静默把收据写进库内（审计 DEF-03 实测：锚设进 root 内，写出 7 张收据且
 *     errors=0）。文档承诺与实现必须一致，否则用户拿"库内锚"当证据锚用，锚就失去意义。
 *   保留的最少内容：`<输出目录>/RECEIPT-YYYYMMDD.json` 一张 `.json`（落盘约定不变，
 *   不新增文件格式），字段见 `RECEIPT_KEYS`，全部可由台账重算 —— 丢了/坏了重出即可。
 *
 * @why 兼容为什么只到"导出面 + 旧平铺文件可读"：
 *   外部（index.js / 自测 / 核验工具）按旧名 import，删导出会让它们直接炸；
 *   所以 `EMPTY_SHA256` / `legacyReceiptPath` / `receiptsDir` / `anchorIsOutside` 继续导出。
 *   ★ 其中 `anchorIsOutside` 自 v1.0.0-re 起**不再是兼容壳**：它是收据锚的位置闸门（DEF-03），
 *     三个生成入口都调用它；其余三个（`EMPTY_SHA256` / `legacyReceiptPath` / `receiptsDir`）
 *     仍只是兼容壳，不参与任何写入/校验判定，调用方不得再当"证据"用。
 *   老库里的旧平铺收据（v2.1、多出 `ledgerSha256`/`prevReceiptSha256`）照旧能读出，
 *   多出来的字段被忽略；旧 `<anchor>/receipts/` 子目录本版不再扫描（不做老证据迁移）。
 *
 * @why 为什么仍按「日」：
 *   补记允许事后追加，"当日汇总"天然按日落；按条就没有稳定的重出边界。
 *
 * ★ v1.0.0-re2（S-11 C42，2026-11-14 机主签字；取代 S-1 旧口径）：
 *   S-11 C42 要求「日结摘要 txt 与台账一致；**发出后不许重写，只能补发新版**」。
 *   旧 S-1 口径（"摘要不是证据、坏了重出即可 → 直接覆盖"）已被 S-11 取代，本版改为：
 *     · 摘要从 10 键扩到 **11 键**：新增 `firstCode`（首条编码），与 `lastCode` 对；
 *       旧 10 键文件按**旧格式**读取（缺 firstCode 视为 legacy，内容不同则补发新版，不覆盖旧文件）；
 *     · 落盘产物两份、**版本成对**：`RECEIPT-YYYYMMDD[.vN].json` ＋ `日结摘要-YYYYMMDD[.vN].txt`
 *       （v1 不带版本后缀，向后兼容旧路径；vN 从 2 起）；
 *     · **永不覆盖、永不删除**任何已存在的摘要文件：内容变了 → 写下一版本（JSON 与 TXT 同版本号）；
 *       内容没变 → 幂等，不产新版；TXT 缺失（旧文件/手工删）→ 只补同版本 TXT，不产新版；
 *     · 版本可见：`ensureReceipts()` 返回 `versions`（每天已发版本数/最新版本号），index.js 落进
 *       run-report（S-11 C42 (c)：不许静默丢变化，也不许"补发"无痕）。
 *
 * ★ v1.0.0-re3（审计② P2-6，2026-11-14）：`originalCount` 从**全库累计**改成**当日口径** ——
 *   日结摘要是"这一天记了什么"，全库累计会被**别人家（别的日期）的视图**影响：
 *   既不能由当日台账独立复算，也会让每一天的旧摘要天天"过期"（补发版本雪崩），
 *   而 `verifyReceipts` 又从不校验它 → 字段名与语义/校验三者对不上（审计原话：可校验性失真）。
 *   本版：
 *     · 摘要格式版本 2 → **3**（字段名/键序/11 键不变，变的是 `originalCount` 的**口径**）；
 *     · `originalCount` = 该日（按编码日期段 YYYYMMDD）第三级 `* 完整原文.md` 视图份数，
 *       `verifyReceipts` 对 v3 摘要**复算并比对**（不一致 → `SUMMARY_MISMATCH(field:originalCount)`）；
 *     · 兼容：旧 v1/v2 摘要按旧格式读（`originalCount` 视为全库累计旧口径，**不判红**）；
 *       它们与新口径内容不同 → 下一轮 `ensureReceipts` 自然补发新版（旧文件仍永不覆盖）。
 *       即"旧摘要可重出"，不会因为口径升级把历史摘要判成"损坏"。
 *   ★ S-11/C42 契约不变：11 键、版本化 JSON+TXT、永不覆盖、只补发、`firstCode` 在第 6 键。
 *
 * @role 日结摘要（lite）：每天一张「这一天记了什么」的摘要 —— 当天记了多少轮、哪些轮（首尾编码）、
 *       多少份完整原文、有没有异常（坏行 / 未闭合），给人看、可外发、可随时从台账重出（新版本）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { ledgerDir } from './ledger.js';

/**
 * 摘要格式版本（字段**语义**变化也必须 +1）。
 * v1 = S-1 旧口径（10 键、坏了重写）；**v2 = S-11 C42 口径（11 键含 firstCode、版本化补发、永不覆盖）**；
 * **v3 = re3/P2-6 口径（`originalCount` 改「当日」实盘，verify 复算校验）**。
 * 读取侧兼容 v1/v2（缺 firstCode 视为 v1；`originalCount` 按旧口径读、不判红）。
 */
export const RECEIPT_VERSION = 3;

/** lite 日结摘要恰好 11 键、顺序固定（写盘必须按这个顺序；v1 旧文件少 firstCode）。 */
export const RECEIPT_KEYS = Object.freeze([
  'v',
  'date',
  'offsetMinutes',
  'ledgerRows',
  'ledgerBytes',
  'firstCode',
  'lastCode',
  'originalCount',
  'partialCount',
  'badLines',
  'generatedAt',
]);

/**
 * 兼容保留：v2.1 空账日的 `sha256("")`。
 * lite **不计算、不比对**任何 sha256；此常量只为外部 import 不报错而留在导出面上。
 */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 第三级「完整原文」视图文件名（只数视图，不含 `<code> 原始事件.json` 附件）。 */
const ORIGINAL_VIEW_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8} 完整原文\.md$/;

/** 摘要路径：v1 = `<anchorRoot>/RECEIPT-YYYYMMDD.json`（平铺，沿用 v2.1 §1.1 的位置）。 */
export function receiptPath(anchorRoot, dateISO) {
  return path.join(String(anchorRoot), `RECEIPT-${String(dateISO).replace(/-/g, '')}.json`);
}

/** 版本化摘要路径：v1 不带后缀（向后兼容），vN(N≥2) = `RECEIPT-YYYYMMDD.vN.json`。 */
export function receiptVersionPath(anchorRoot, dateISO, version = 1) {
  const base = `RECEIPT-${String(dateISO).replace(/-/g, '')}`;
  const v = Number(version) || 1;
  return path.join(String(anchorRoot), v <= 1 ? `${base}.json` : `${base}.v${v}.json`);
}

/** 外发日结摘要 TXT 路径：v1 = `日结摘要-YYYYMMDD.txt`，vN = `日结摘要-YYYYMMDD.vN.txt`（与 JSON 版本成对）。 */
export function digestTxtPath(anchorRoot, dateISO, version = 1) {
  const base = `日结摘要-${String(dateISO).replace(/-/g, '')}`;
  const v = Number(version) || 1;
  return path.join(String(anchorRoot), v <= 1 ? `${base}.txt` : `${base}.v${v}.txt`);
}

/** 解析摘要文件名 → {date, version}；不是摘要文件返回 null。 */
function parseReceiptName(name) {
  let m = /^RECEIPT-(\d{4})(\d{2})(\d{2})\.json$/.exec(name);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, version: 1 };
  m = /^RECEIPT-(\d{4})(\d{2})(\d{2})\.v(\d+)\.json$/.exec(name);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, version: Number(m[4]) };
  return null;
}

/** 列出某日全部摘要版本（升序）：[{date,version,path,buf,json}]。 */
export function listReceiptVersions(anchorRoot, dateISO) {
  const out = [];
  if (!anchorRoot) return out;
  let names;
  try {
    names = fs.readdirSync(String(anchorRoot));
  } catch {
    return out;
  }
  for (const name of names) {
    const p = parseReceiptName(name);
    if (!p || p.date !== dateISO) continue;
    const abs = path.join(String(anchorRoot), name);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    out.push({ date: dateISO, version: p.version, path: abs, buf, json: tryParseJson(buf) });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

/** 某日最新版本摘要（没有则 null）。 */
export function latestDayReceipt(anchorRoot, dateISO) {
  const list = listReceiptVersions(anchorRoot, dateISO);
  return list.length ? list[list.length - 1] : null;
}

/** 兼容保留：v0.5 早期路径 `<anchorRoot>/receipts/RECEIPT-YYYYMMDD.json`。lite **不再写、也不再读**。 */
export function legacyReceiptPath(anchorRoot, dateISO) {
  return path.join(receiptsDir(anchorRoot), `RECEIPT-${String(dateISO).replace(/-/g, '')}.json`);
}

/** 兼容保留：旧收据目录。lite 不往里写；导出只为外部调用方不炸。 */
export function receiptsDir(anchorRoot) {
  return path.join(String(anchorRoot), 'receipts');
}

/** 某日台账文件路径：`<root>/ledger/YYYY-MM-DD.jsonl`。 */
export function ledgerDayPath(root, dateISO) {
  return path.join(ledgerDir(root), `${dateISO}.jsonl`);
}

/**
 * 两个目录的包含关系（纯路径计算，**只读、无副作用**）。
 *
 * ★ DEF-03：它同时是**收据锚的位置闸门**（不只是路径工具）：
 *   `buildDailyReceipt` / `writeDailyReceipt` / `ensureReceipts` 都在生成前调用它，
 *   `ok=false` → 拒绝生成，`reason` 为 `ANCHOR_INSIDE_ROOT`（锚 == root / 位于 root 内 / 是 root 祖先）
 *   或 `ANCHOR_EMPTY`（锚为空）。判据用 `path.relative`：相等（rel=''）、子路径（不以 '..' 开头）、
 *   祖先（relative(anchor, root) 不以 '..' 开头）三种关系都覆盖；路径解析后比较，跨盘符时
 *   `path.relative` 返回绝对路径 → 判为库外，不会误伤正常外置锚。
 */
export function anchorIsOutside(anchorRoot, root) {
  if (!anchorRoot || String(anchorRoot).trim() === '') {
    return { ok: false, anchor: '', root: path.resolve(String(root || '')), reason: 'ANCHOR_EMPTY' };
  }
  const a = path.resolve(String(anchorRoot));
  const r = path.resolve(String(root || ''));
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const bad = inside(r, a) || inside(a, r);
  return { ok: !bad, anchor: a, root: r, reason: bad ? 'ANCHOR_INSIDE_ROOT' : '' };
}

/**
 * 盘点 `<root>` **第三级** `* 完整原文.md` 视图文件（`<年>年<月>月/<月>月总“完整原文”/<code> 完整原文.md`）。
 *
 * @param {string} root
 * @param {string} [dateISO] 给了 `YYYY-MM-DD` → 只数**编码日期段**是该日的（re3/P2-6 的当日口径）；
 *                           省略 → 全库累计（旧口径，仅供兼容导出与"全库总量"观察）。
 * @returns {number}
 */
function countViews(root, dateISO) {
  const raw = dateISO === undefined || dateISO === null ? '' : String(dateISO).trim();
  const want = raw ? raw.replace(/-/g, '') : '';
  if (want && !/^\d{8}$/.test(want)) return 0;
  let n = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 2) walk(path.join(dir, e.name), depth + 1);
      } else if (depth === 2 && ORIGINAL_VIEW_RE.test(e.name)) {
        // 视图文件的 code 前缀就是 YYYYMMDD（见 ORIGINAL_VIEW_RE），按它分日
        if (!want || e.name.startsWith(want)) n += 1;
      }
    }
  };
  walk(String(root || ''), 0);
  return n;
}

/** 全库第三级视图总数（**兼容保留**；日结摘要自 re3 起改用 `countOriginalViewsOn()` 的当日口径）。 */
export function countOriginalViews(root) {
  return countViews(root, '');
}

/**
 * 某日第三级视图份数（`originalCount` 的**当日口径**；re3 / 审计② P2-6）。
 * @param {string} root
 * @param {string} dateISO `YYYY-MM-DD`
 * @returns {number}
 */
export function countOriginalViewsOn(root, dateISO) {
  return countViews(root, dateISO);
}

/** 读某日台账原始字节（不存在/不可读 → null）。 */
function readLedgerDay(root, dateISO) {
  try {
    const p = ledgerDayPath(root, dateISO);
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return { path: p, buf: fs.readFileSync(p) };
  } catch {
    return null;
  }
}

/**
 * 把某日台账字节汇总成计数（纯函数、只读）。
 * @returns {{rows:number, lastCode:string, partialCount:number, badLines:number}}
 *   rows        有效账行（能解析成对象的 JSON 行）
 *   lastCode    末条有效行的 code（无则 ''）
 *   partialCount 其中 status==='partial' 的行数（"有没有异常"之一）
 *   badLines    解析不出对象的行数（"有没有异常"之二）
 */
function summarizeLedger(buf) {
  let rows = 0;
  let firstCode = '';
  let lastCode = '';
  let partialCount = 0;
  let badLines = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!o || typeof o !== 'object') {
      badLines += 1;
      continue;
    }
    rows += 1;
    if (o.status === 'partial') partialCount += 1;
    if (typeof o.code === 'string') {
      if (!firstCode) firstCode = o.code;
      lastCode = o.code;
    }
  }
  return { rows, firstCode, lastCode, partialCount, badLines };
}

function tryParseJson(buf) {
  try {
    const o = JSON.parse(buf.toString('utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * 读某日摘要（不存在/不可读 → null）。**v1.0.0-re2 起返回最新版本**（附 `version` 字段）。
 * 只认平铺路径；旧 `receipts/` 子目录不再扫描（lite 不做老证据兼容）。
 * @returns {{date:string,version:number,path:string,buf:Buffer,json:object|null}|null}
 */
export function readDayReceipt(anchorRoot, dateISO) {
  if (!anchorRoot) return null;
  return latestDayReceipt(anchorRoot, dateISO);
}

/** 列出输出目录里所有日结摘要（**每天只列最新版本**），按日期升序：[{date,version,path,buf,json,versions}]。 */
export function listReceipts(anchorRoot) {
  const out = [];
  if (!anchorRoot) return out;
  let names;
  try {
    names = fs.readdirSync(String(anchorRoot));
  } catch {
    return out;
  }
  const byDate = new Map();
  for (const name of names) {
    const p = parseReceiptName(name);
    if (!p) continue;
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p.version);
  }
  for (const [date, versions] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const latest = latestDayReceipt(anchorRoot, date);
    if (!latest) continue;
    out.push({ ...latest, versions: versions.length, latestVersion: latest.version });
  }
  return out;
}

/** `YYYY-MM-DD HH:MM:SS`（+offsetMinutes 的墙上时间，与台账 ts 同一种读法，不落 Z）。 */
function stampLocal(ms, offsetMinutes) {
  return new Date(Number(ms) + Number(offsetMinutes) * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 生成某日的摘要对象（**纯函数**：只读台账与原文视图，不写盘）。
 *
 * @param {object} p
 * @param {string} p.root 数据总库
 * @param {string} p.anchorRoot 摘要输出目录
 * @param {string} p.dateISO `YYYY-MM-DD`
 * @param {number} [p.offsetMinutes] 时区偏移（默认 480）
 * @param {number} [p.nowMs] 生成时刻（默认 Date.now()，测试可注入）
 * @returns {{ok:boolean, receipt?:object, path?:string, reason?:string, anchor?:string, root?:string}}
 *   reason ∈ BAD_DATE / ANCHOR_EMPTY / **ANCHOR_INSIDE_ROOT**（DEF-03：锚在库内/等于 root/是 root 祖先）
 */
export function buildDailyReceipt({ root, anchorRoot, dateISO, offsetMinutes = 480, nowMs = Date.now() } = {}) {
  if (!DATE_RE.test(String(dateISO))) return { ok: false, reason: 'BAD_DATE' };
  if (!anchorRoot || String(anchorRoot).trim() === '') return { ok: false, reason: 'ANCHOR_EMPTY' };

  // ★ DEF-03：锚必须在 root 之外（生成入口真正调用 anchorIsOutside）。
  //   拒绝是纯检查：不读台账、不建目录、不写任何文件。
  const anchorCheck = anchorIsOutside(anchorRoot, root);
  if (!anchorCheck.ok) {
    return { ok: false, reason: anchorCheck.reason, anchor: anchorCheck.anchor, root: anchorCheck.root };
  }

  const day = readLedgerDay(root, dateISO);
  // 无台账文件也出摘要：全零 = "这一天没有记任何东西"，不是错误
  const s = day ? summarizeLedger(day.buf) : { rows: 0, firstCode: '', lastCode: '', partialCount: 0, badLines: 0 };

  const receipt = {
    v: RECEIPT_VERSION,
    date: dateISO,
    offsetMinutes: Number(offsetMinutes),
    ledgerRows: s.rows,
    ledgerBytes: day ? day.buf.length : 0,
    firstCode: s.firstCode,
    lastCode: s.lastCode,
    // ★ re3（P2-6）：**当日**第三级视图份数（不是全库累计）。verifyReceipts 会复算这一格。
    originalCount: countOriginalViewsOn(root, dateISO),
    partialCount: s.partialCount,
    badLines: s.badLines,
    generatedAt: stampLocal(nowMs, offsetMinutes),
  };
  return { ok: true, receipt, path: receiptPath(anchorRoot, dateISO) };
}

/** 两份摘要是否除 `generatedAt` 外完全一致（重跑不该无谓改写文件）。 */
function sameSummary(oldR, newR) {
  if (!oldR || typeof oldR !== 'object') return false;
  return RECEIPT_KEYS.every((k) =>
    k === 'generatedAt' || String(oldR[k] === undefined ? '' : oldR[k]) === String(newR[k] === undefined ? '' : newR[k]));
}

function asWriteFailed(file, e) {
  return {
    ok: false,
    written: false,
    path: file,
    reason: 'ANCHOR_UNWRITABLE',
    detail: (e && (e.code || e.message)) || String(e),
  };
}

/**
 * 写某日摘要（v1.0.0-re2 / S-11 C42：**永不覆盖、只补发新版**）。
 *
 * @returns {{ok:boolean, written:boolean, appended:boolean, repairedTxt:boolean, version:number,
 *            path:string, txtPath:string, receipt?:object,
 *            decision:'written'|'appended-version'|'idempotent'|'txt-repaired', reason?:string, detail?:string}}
 *   · 与**最新版本**内容一致（除 generatedAt）→ 不产新版：
 *       - 最新版 TXT 缺失 → 只补同版本 TXT（`decision:'txt-repaired'`，write 没发生）；
 *       - TXT 也在 → `decision:'idempotent'`。
 *   · 内容变了 → 写**下一版本**（JSON＋TXT 成对，同版本号，v1 起）：
 *       `written:true` + `appended: version>1`；**旧版本文件一个字节不动（`flag:'wx'` 不覆盖）**。
 *   · 锚位置非法（库内/祖先/相等）→ `ANCHOR_INSIDE_ROOT`，零写入（★ DEF-03，先于读台账）。
 *
 * @why 为什么不再"坏了重出/直接覆盖"：S-11（2026-11-14 机主签字）明确"发出后不许重写，只能补发新版"，
 *      后签口径优先于 S-1；旧 10 键文件按旧格式读取，内容不同则补发 v2（不覆盖 v1）。
 */
export function writeDailyReceipt({ root, anchorRoot, dateISO, offsetMinutes = 480, nowMs = Date.now() } = {}) {
  // ★ DEF-03：写入入口先过锚位置闸门（先于 buildDailyReceipt —— 拒绝必须做到
  //   "没读过台账、没建过目录、没写过 .tmp"）。库内/祖先/相等锚 → 零写入返回。
  const anchorCheck = anchorIsOutside(anchorRoot, root);
  if (!anchorCheck.ok) {
    return { ok: false, written: false, appended: false, repairedTxt: false, version: 0, reason: anchorCheck.reason, anchor: anchorCheck.anchor, root: anchorCheck.root };
  }
  const built = buildDailyReceipt({ root, anchorRoot, dateISO, offsetMinutes, nowMs });
  if (!built.ok) return { ok: false, written: false, appended: false, repairedTxt: false, version: 0, reason: built.reason };

  // 目录闸门（不存在就建；是文件则拒绝写入）
  try {
    const st = fs.existsSync(anchorRoot) ? fs.statSync(anchorRoot) : null;
    if (st && !st.isDirectory()) return asWriteFailed(built.path, new Error('输出路径不是目录'));
    if (!st) fs.mkdirSync(String(anchorRoot), { recursive: true });
  } catch (e) {
    return asWriteFailed(built.path, e);
  }

  const versions = listReceiptVersions(anchorRoot, dateISO);
  const latest = versions.length ? versions[versions.length - 1] : null;

  // ① 内容与最新版本一致 → 幂等（TXT 缺失只补同版本 TXT，不产新版）
  if (latest && sameSummary(latest.json, built.receipt)) {
    const txt = digestTxtPath(anchorRoot, dateISO, latest.version);
    if (!fs.existsSync(txt)) {
      const w = writeFileNoOverwrite(txt, `${renderDailyDigest(latest.json, { version: latest.version })}\n`);
      if (!w.ok) return asWriteFailed(txt, w.error);
      return { ok: true, written: false, appended: false, repairedTxt: true, version: latest.version, path: latest.path, txtPath: txt, receipt: latest.json, decision: 'txt-repaired' };
    }
    return { ok: true, written: false, appended: false, repairedTxt: false, version: latest.version, path: latest.path, txtPath: txt, receipt: latest.json, decision: 'idempotent' };
  }

  // ② 内容变了（或首版）→ 写下一版本；version 冲突（已有同号文件）就继续加，绝不覆盖
  let version = (latest ? Math.max(1, latest.version) : 0) + 1;
  let jsonPath = '';
  let jsonW = null;
  for (let guard = 0; guard < 100; guard += 1) {
    jsonPath = receiptVersionPath(anchorRoot, dateISO, version);
    jsonW = writeFileNoOverwrite(jsonPath, `${JSON.stringify(built.receipt)}\n`);
    if (jsonW.ok) break;
    if (jsonW.exists) { version += 1; continue; }
    return asWriteFailed(jsonPath, jsonW.error);
  }
  if (!jsonW || !jsonW.ok) return asWriteFailed(jsonPath, (jsonW && jsonW.error) || new Error('版本号耗尽'));

  // JSON 落盘成功后再落 TXT（同版本号）；TXT 写失败不回滚 JSON —— 下一轮 tick 会按"TXT 缺失只补同版本"修好
  const txtPath = digestTxtPath(anchorRoot, dateISO, version);
  const txtW = writeFileNoOverwrite(txtPath, `${renderDailyDigest(built.receipt, { version })}\n`);
  return {
    ok: true,
    written: true,
    appended: version > 1,
    repairedTxt: false,
    version,
    path: jsonPath,
    txtPath,
    receipt: built.receipt,
    decision: version > 1 ? 'appended-version' : 'written',
    ...(txtW.ok ? {} : { detail: `TXT 未写成（下轮补）: ${(txtW.error && (txtW.error.code || txtW.error.message)) || ''}` }),
  };
}

/** 原子"不覆盖"写：`wx` = 文件已存在则失败（EEXIST）。 */
function writeFileNoOverwrite(file, text) {
  try {
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, exists: true, error: e };
    return { ok: false, error: e };
  }
}

/**
 * 把一张摘要渲染成人看的纯文本（外发日结摘要 TXT 的内容；不影响盘上 JSON）。
 * @param {object} receipt buildDailyReceipt().receipt
 * @param {{version?:number}} [opts] 版本号（v1.0.0-re2 起摘要版本化，TXT 与 JSON 同版本号）
 * @returns {string}
 */
export function renderDailyDigest(receipt, opts = {}) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const off = n(r.offsetMinutes);
  const abs = Math.abs(off);
  const tz = `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const ver = Number(opts && opts.version) || 0;
  const L = [];
  L.push(`日结摘要 ${String(r.date || '')}${ver > 1 ? `（第 ${ver} 版）` : ''}`);
  L.push(`· 台账轮次：${n(r.ledgerRows)} 行（坏行 ${n(r.badLines)}）`);
  L.push(`· 首条编码：${String(r.firstCode || '（无）')}`);
  L.push(`· 末条编码：${String(r.lastCode || '（无）')}`);
  L.push(`· 当日完整原文：${n(r.originalCount)} 份`);
  L.push(`· 未闭合（partial）：${n(r.partialCount)} 行`);
  L.push(`· 台账字节：${n(r.ledgerBytes)} B`);
  L.push(`· 生成时间：${String(r.generatedAt || '')}（${tz}）`);
  L.push(`· 版本：v${ver || 1}（发出后不重写；内容有变只补发新版，旧版保留）`);
  return L.join('\n');
}

/**
 * 核验日结摘要（**只读、软核对**）：摘要记的行数/字节/末条编码/首条编码/未闭合数/**当日原文份数**
 * 是否与台账/原文现状一致。
 *
 * 这**不是** v2.1 的证据链校验：不重算 sha256、不看前后日、不判定"被篡改"。
 * 它只回答"摘要还是不是当日汇总"——不一致就重出（补发新版），不需要处置流程。
 *
 * ★ re3 / 审计② P2-6：v3 起复算并校验 `originalCount`（当日第三级视图份数）。
 *   旧 v1/v2 摘要的 `originalCount` 是"全库累计"旧口径（旧实现也从不校验）→ 按 legacy 处理、
 *   **不判红**，只计入 `legacyReceipts`；它们与新口径内容不同，下一轮 ensureReceipts 会补发新版。
 *
 * @returns {{ok:boolean, days:number, breaks:Array<object>, checks:Array<{name:string,ok:boolean}>,
 *            legacyReceipts:number}}
 */
export function verifyReceipts({ root, anchorRoot, offsetMinutes = 480 } = {}) {
  const breaks = [];
  const list = listReceipts(anchorRoot);
  let legacyReceipts = 0;

  for (const it of list) {
    const r = it.json;
    if (!r || typeof r !== 'object') {
      breaks.push({
        type: 'BAD_RECEIPT', kind: 'BAD_RECEIPT', date: it.date,
        expected: '可解析 JSON', actual: '无法解析', detail: '摘要文件损坏（删掉重出即可）',
      });
      continue;
    }
    const day = readLedgerDay(root, it.date);
    const recordedRows = Number(r.ledgerRows);
    const recordedBytes = Number(r.ledgerBytes);
    const recordedLast = String(r.lastCode === undefined ? '' : r.lastCode);
    const recordedPartials = Number(r.partialCount);
    const diffs = [];
    const flushDiffs = () => {
      for (const [field, was, now] of diffs) {
        breaks.push({
          type: 'SUMMARY_MISMATCH', kind: 'SUMMARY_MISMATCH', date: it.date, field,
          expected: was, actual: now,
          detail: `摘要与实际台账不一致（${field}）—— 该日摘要过期/损坏，重出即可`,
        });
      }
    };

    // ★ v1.0.0-re3（P2-6）：v3 起 `originalCount` = 当日第三级视图份数，必须**复算校验**。
    //   它与台账无关（空账日也要核），所以先于 `!day` 分支；v1/v2 是"全库累计"旧口径
    //   （旧实现根本不校验）→ 按 legacy 处理、不判红，只计数；它们与新口径必然不同，
    //   下一轮 ensureReceipts 会补发新版（旧文件永不覆盖）= "旧摘要可重出"。
    if (Number(r.v) >= 3) {
      const wantOriginal = countOriginalViewsOn(root, it.date);
      const gotOriginal = Number(r.originalCount);
      if (!Number.isFinite(gotOriginal)) {
        diffs.push(['originalCount', String(r.originalCount === undefined ? '(缺失)' : r.originalCount), String(wantOriginal)]);
      } else if (gotOriginal !== wantOriginal) {
        diffs.push(['originalCount', String(gotOriginal), String(wantOriginal)]);
      }
    } else {
      legacyReceipts += 1;
    }

    if (!day) {
      // 空账日摘要（0 行 0 字节）没有台账文件是自洽的
      if (!(recordedRows === 0 && recordedBytes === 0)) {
        breaks.push({
          type: 'LEDGER_MISSING', kind: 'LEDGER_MISSING', date: it.date,
          expected: `ledger/${it.date}.jsonl`, actual: '台账文件不存在',
          detail: '摘要说这天有账，台账文件却不见了',
        });
      }
      flushDiffs(); // 空账日的"当日原文份数"同样要核
      continue;
    }

    const cur = summarizeLedger(day.buf);
    if (cur.rows !== recordedRows) diffs.push(['ledgerRows', String(recordedRows), String(cur.rows)]);
    if (day.buf.length !== recordedBytes) diffs.push(['ledgerBytes', String(recordedBytes), String(day.buf.length)]);
    if (String(cur.lastCode) !== recordedLast) diffs.push(['lastCode', recordedLast, String(cur.lastCode)]);
    // ★ v1.0.0-re2（S-11 C42）：v2+ 摘要才有 firstCode；旧 10 键（v1）不判此字段（视为旧格式，内容不同即补发新版）
    if (Number(r.v) >= 2) {
      const recordedFirst = String(r.firstCode === undefined ? '' : r.firstCode);
      if (String(cur.firstCode) !== recordedFirst) diffs.push(['firstCode', recordedFirst, String(cur.firstCode)]);
    }
    if (cur.partialCount !== recordedPartials) diffs.push(['partialCount', String(recordedPartials), String(cur.partialCount)]);
    flushDiffs();
  }

  const failKinds = new Set(breaks.map((b) => b.kind || b.type));
  const checks = [
    { name: 'anchor-readable', ok: true },
    { name: 'receipts', ok: list.length > 0 },
    { name: 'ledger', ok: !failKinds.has('LEDGER_MISSING') && !failKinds.has('SUMMARY_MISMATCH') },
    // ★ re3（P2-6）：当日原文份数这一格必须真的被核过（v3 摘要），不是"字段存在即通过"
    { name: 'originalCount-daily', ok: !breaks.some((b) => b.field === 'originalCount') },
  ];
  return { ok: breaks.length === 0, days: list.length, breaks, checks, legacyReceipts, offsetMinutes };
}

/**
 * 给 index.js 调用：补齐"已完结日期"的日结摘要。
 *
 * @param {object} p
 * @param {string} p.root
 * @param {string} p.anchorRoot 空 → 功能关闭（不生成、不报错、不写任何外部文件）
 * @param {string[]} p.dates 候选日期（`YYYY-MM-DD`）
 * @param {string} [p.todayISO] 今天（今天不封摘要，避免"半天账"被当成整天）
 * @returns {{ok:boolean, written:string[], skipped:string[], errors:string[], disabled?:boolean, reason?:string}}
 *   ★ DEF-03：锚在库内/是 root 祖先/等于 root → `ok:false` + `reason:'ANCHOR_INSIDE_ROOT'` +
 *   `errors[0]` 带同一原因；**整批拒绝、零收据写出、不改台账**。`index.js` 的既有接线会读
 *   `rc.reason`（→ stat.errors "receipt anchor rejected: …"）与 `rc.errors[]`（→ "receipt failed: …"）。
 */
export function ensureReceipts({ root, anchorRoot, dates = [], todayISO = '', offsetMinutes = 480, nowMs = Date.now() } = {}) {
  // v1.0.0-re2（S-11 C42）：返回值新增 appended（补发新版）/ repairedTxt / versions（已发版本数与最新版本号）。
  const res = { ok: true, written: [], appended: [], skipped: [], repairedTxt: [], errors: [], versions: { total: 0, dates: 0, latest: null } };
  if (!anchorRoot || String(anchorRoot).trim() === '') {
    res.disabled = true;
    return res;
  }
  // ★ DEF-03：锚位置闸门 —— 库内/祖先/相等锚**整批拒绝**（一次判完，不给每个日期各撞一次墙）。
  //   零收据写出、不改台账；错误进 errors 且升到顶层 reason，供 index.js / run-report 原样带出。
  const anchorCheck = anchorIsOutside(anchorRoot, root);
  if (!anchorCheck.ok) {
    res.ok = false;
    res.reason = anchorCheck.reason;
    res.errors.push(
      `${anchorCheck.reason}: 收据锚必须在 root 之外（anchor=${anchorCheck.anchor}；root=${anchorCheck.root}）；` +
      '拒生成，账务照常',
    );
    return res;
  }
  const seen = new Set();
  for (const dateISO of dates) {
    if (!DATE_RE.test(String(dateISO))) continue;
    if (dateISO === todayISO) { res.skipped.push(dateISO); continue; } // 当天不封
    if (seen.has(dateISO)) continue;
    seen.add(dateISO);
    try {
      const w = writeDailyReceipt({ root, anchorRoot, dateISO, offsetMinutes, nowMs });
      if (w.ok && w.written) res.written.push(dateISO);
      else if (w.ok) res.skipped.push(dateISO); // 幂等 / 只补了同版本 TXT
      else {
        res.errors.push(dateISO + ':' + w.reason);
        // 输出目录整体不可写：后面的日期不必再逐个撞墙（错误留一条即可，避免刷屏）
        if (w.reason === 'ANCHOR_UNWRITABLE') break;
      }
      if (w.ok) {
        if (w.appended) res.appended.push({ date: dateISO, version: w.version });
        if (w.repairedTxt) res.repairedTxt.push({ date: dateISO, version: w.version });
      }
    } catch (e) {
      res.errors.push(dateISO + ':' + (e && e.message));
    }
  }
  // 已发版本统计（S-11 C42 (c)："已发版本数/最新版本号"要可见）
  try {
    let total = 0;
    let datesCount = 0;
    let latest = null;
    for (const dateISO of [...seen].sort()) {
      const vs = listReceiptVersions(anchorRoot, dateISO);
      if (!vs.length) continue;
      datesCount += 1;
      total += vs.length;
      const top = vs[vs.length - 1];
      if (!latest || top.version > latest.version || (top.version === latest.version && dateISO > latest.date)) {
        latest = { date: dateISO, version: top.version, path: path.basename(top.path), txt: path.basename(digestTxtPath(anchorRoot, dateISO, top.version)) };
      }
    }
    res.versions = { total, dates: datesCount, latest };
  } catch { /* 统计失败不影响主流程（摘要本身已落盘） */ }
  if (res.errors.length > 0) res.ok = false;
  return res;
}

