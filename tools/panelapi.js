/**
 * @file panelapi.js
 * @role **只读面板 HTTP API**（V0.6 外层）：把账本以 7 条 exact GET 路由暴露给左栏面板。
 *
 * @why 面板是"看账"的窗，不是第二个写入口。本模块从边界上保证只读：
 *      · 只 import 只读函数（readAll / searchLedger / getTurn / readReads / reconcile / listArchiveFiles），
 *        没有任何一条路径 import appendTurn / writeState / writeOriginal 这类写函数；
 *      · 唯一允许的写是读日志（V0.6.4 起：`<root>/ledger/.reads/YYYY-MM.jsonl` 按月分片、8 MiB 滚动；
   *        历史 `<root>/ledger/.reads.jsonl` 只读兼容），属运行区，见 lib/readlog.js。
 *
 * @why 进程内可测：契约 §4 的验收要求"不起 HTTP 服务"直接调 API。
 *      所以路由逻辑与 HTTP 载体分离：`runPanelRoute()` 是纯逻辑入口（参数校验 + 取数 + 读日志），
 *      `createPanelResource()` 只是把它包成 web-standard Request/Response；
 *      `registerLedgerPanelApi()` 才碰 Harness 的 webServer。
 *
 * @why 安全模型（V1.0.0-re3 定稿；三份独立审计 ① P1-1 / ② A3 / ③ SEC-01 合并裁决。**不许夸大，不许留含糊**）：
 *      · **默认保护**（token 未设置 = 默认状态）：
 *        ① **回环 Host 白名单（先决条件，任何来源头都不得短路）**：`Host` 必须是
 *           `127.0.0.1` / `localhost` / `[::1]`（可带端口）；缺 Host 或非回环 Host 一律 403，
 *           且**先于** Sec-Fetch-Site / Origin / Referer 判断。这是 DNS rebinding 的主防线：
 *           攻击者域名哪怕解析到 127.0.0.1，Host 仍是攻击者域名。
 *        ② **`Sec-Fetch-Site` 只作否决，不再单独放行**：`cross-site` / `same-site` / `none` → 403；
 *           `same-origin` **不能**替代 Host 判定 —— 旧契约"same-origin 直接 return true"正是
 *           审计点名的绕过（`Host: evil.example` + `Sec-Fetch-Site: same-origin` 实测 200）。
 *        ③ **Origin/Referer 若存在 = 必须"回环 host + 端口与本次请求一致"**（本次请求端口以
 *           `Host` 头为准：宿主 webServer 用占位 origin 构造 Request，旧"与 Request.url 同源"
 *           分支在真机是死分支）。任一不匹配、或解析失败/无法判定 → 403（fail-closed）。
 *        ④ **只读**：7 条路由不写账、不写原文、不写周账/封板；唯一写是运行区读日志。
 *           被拒请求**零副作用**（不写读日志、不碰账本）。
 *      · **可选 token**（环境变量 `DSH_DIALOG_LEDGER_PANEL_TOKEN`；**未设置/空 = 不启用**）：
 *        设置后 **7 条 GET/HEAD 路由全部**要求请求头 `x-dialog-ledger-token` 或 `?token=` 与之相等，
 *        否则 401 —— **连 `Sec-Fetch-Site: same-origin` 的同源请求也要 token**（口径最干净：token 一旦启用
 *        就是"全通道闸"，不保留任何例外通道）。校验顺序：同源守卫（403）在前，token（401）在后。
 *      · **启用 token 后内置面板不可用（预期行为，不是 bug）**：`tools/client.js` 的面板 fetch 带不上 token；
 *        而"浏览器端能拿到 token 的通道"＝任何本机进程也能拿到（等于没加）。所以 token 的正确定位是
 *        **"外部/非浏览器访问闸"**，不是面板鉴权；面板可用与 token 启用只能二选一，由机主按部署选择。
 *      · **物理边界（明确不宣称防住）**：本机**同权限**进程可以读进程环境变量、伪造任意请求头
 *        （包括回环 Host 与 `Sec-Fetch-Site`）、或**绕过 HTTP 直接读磁盘台账** —— token 与同源守卫对此
 *        **都无效**，只能靠操作系统账号隔离/沙箱。本插件能保证的是"只读 + 不写 + 拒跨源/拒非回环"，
 *        不是"防住本机同权限者"。
 *      · `runPanelRoute()` 是**进程内直调**入口（工具面/验收用，浏览器不经过它），不经过这两道闸；
 *        token 与守卫只加在真正的 HTTP resource（`createPanelResource`）上。
 *
 * @why 为什么这样做（而不是"随便加个鉴权"）：`WebResourceRoute` 本身不做任何鉴权，本机任意进程 curl 直取
 *      都是 200；在"没有用户体系、没有证书、零依赖"的约束下，token 是唯一不引入新配置键/新依赖的加固手段。
 *      它挡的是"能发 HTTP 但读不到本进程环境变量的进程"与远程页面，而不是同权限本机进程（见上条物理边界）。
 *
 * @why 为什么用 WebResourceRoute 而不是 WebRoute：
 *      运行时对 resource 的原生语义就是"GET/HEAD 允许、其余 405 + Allow: GET, HEAD、HEAD 自动去 body"
 *      —— 正好是契约 §1.1 的方法口径，不需要自己写 IncomingMessage/ServerResponse 那套。
 *
 * @contract `docs/验收-v0.6/接口契约.md` §1（唯一接口依据）。
 * @depends node:fs、node:path、./ledger.js、./ledgerapi.js、./readlog.js、./reconcile.js、
 *          ./weekly.js（全部只读使用）
 *          ./layout.js（V0.6.2：一级布局分类/双路径；0.9.2 起兼作文件名分类权威，本文件只读它）
 *
 * @why 0.9.2 边界归零：本文件原先还 import `freeze/cleanup.js`（listOriginals）与
 *      `freeze/handover.js`（MAIN_FILE_RE / APPENDIX_FILE_RE），使 `index.js` 静态可达
 *      `freeze/`（越界）。现改用手边已 import 的 core 原语
 *      `lib/reconcile.js listArchiveFiles` 与 `lib/layout.js classifyFileName`，
 *      并在本文件做**等价归约**（见 scanHandover / scanOriginals 的 @why），
 *      `computeSummary` 的字段名/含义/计数口径保持与裁剪前一致。7 条路由一条不删。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readAll, readStateEx, stampLocal } from '../lib/ledger.js';
import { searchLedger, getTurn, containedPath } from './ledgerapi.js';
import { appendRead, readReads, summarizeReads, isSafeRoot } from './readlog.js';
import { reconcile, listArchiveFiles } from '../lib/reconcile.js';
import { readWeeklySeals, LAYOUT_VERSION } from '../lib/weekly.js';
// V0.6.2：交接表写端已迁入 `<root>/交接表/`；读端双路径（新目录 + 一级老位置）
// 0.9.2：文件名分类改用 layout 的 classifyFileName（与 freeze/handover.js 同一份文件名正则）。
import { SUBDIR, classifyFileName, FILE_KIND } from '../lib/layout.js';

// ============================================================================
// 一、常量：路由 / 响应头 / 参数钳制区间
// ============================================================================

/** API 版本（响应里恒为 1；结构变更时 +1，面板据此判形状）。 */
export const API_VERSION = 1;

/** 统一前缀（契约 §1.1：全部 exact GET 路由）。 */
export const API_PREFIX = '/dialog-ledger/api/';

/** 7 条路由（顺序即注册顺序；不接受任何前缀/通配）。 */
export const API_ROUTES = ['ping', 'summary', 'search', 'turn', 'original', 'reads', 'reconcile'];

/** 响应头（契约 §1.1：JSON + 不缓存）。 */
export const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/** summary / reconcile 的 30s 内存缓存（契约 §1.3 / §1.8）。 */
const CACHE_TTL_MS = 30 * 1000;

/** 各路由的取数上限（与契约 §1.4–§1.8 逐条对应）。 */
const LIMITS = {
  searchLimit: { dflt: 50, lo: 1, hi: 200 },
  excerptBytes: { dflt: 800, lo: 0, hi: 65536 },
  maxBytes: { dflt: 65536, lo: 0, hi: 262144 },
  readsLimit: { dflt: 50, lo: 1, hi: 500 },
  maxDetail: { dflt: 50, lo: 0, hi: 200 },
};

/** 读日志里的工具名前缀（契约 §1.1：`panel:<route>`）。 */
const READ_TOOL_PREFIX = 'panel:';

/**
 * 面板只读 API 的可选 token（V1.0 / 准入审计 SEC-01）。
 *
 * @why SEC-01 原先被"留到 1.0.x"，机主已裁定 **V1.0 前必须解决、不允许再后置**。
 *      但本机无法做密码学鉴权（无用户体系、无证书、零依赖），所以采取**可选 token**：
 *      · 环境变量 `DSH_DIALOG_LEDGER_PANEL_TOKEN` **未设置/空 = 不启用**（保持旧行为，零迁移）；
 *      · 设置后：**7 条只读路由（GET/HEAD）全部**要求请求头 `x-dialog-ledger-token` 或 `?token=` 与之相等，
 *        否则 **401**；**连 `Sec-Fetch-Site: same-origin` 的同源请求也要 token**（不保留例外通道，口径最干净）；
 *      · 比较用 `crypto.timingSafeEqual`（定长，避免按字节泄露匹配前缀）；
 *      · 校验顺序：**同源守卫（403）在前，token（401）在后**；被拒请求不写读日志、零副作用。
 * @why 不新增插件配置键（会破坏 21 键配置面与身份一致性校验），
 *      所以 token 只走环境变量；配置面仍由 patch/readConfig/README 三处统一管。
 * @why **启用 token 后内置面板不可用 = 预期行为**：`tools/client.js` 的面板 fetch 带不上 token，
 *      而浏览器端能拿到 token 的通道＝任何本机进程也能拿到（等于没加）。因此 token 的定位是
 *      **"外部/非浏览器访问闸"**；面板可用与 token 启用二选一，由机主按部署决定。
 * @why 安全模型（如实写清，不许夸大）：token 只挡"能发 HTTP 但读不到本进程环境变量的进程"，
 *      以及**远程页面/跨源请求**（配合同源守卫）。**本机同权限进程仍可读进程环境变量、伪造任意请求头、
 *      或直接读磁盘台账**，token 对此无效——那种场景只能靠操作系统账号隔离/沙箱。
 *      真正的边界仍是"插件只读 + 不写"。
 */
export const PANEL_TOKEN_ENV = 'DSH_DIALOG_LEDGER_PANEL_TOKEN';
export const PANEL_TOKEN_HEADER = 'x-dialog-ledger-token';
export const PANEL_TOKEN_QUERY = 'token';

/** 月份目录名（二级）：`2026年11月`。 */
const MONTH_DIR_RE = /^(\d{4})年(\d{2})月$/;

/** 周记账文件名（契约 §3 产物格式）：`MM月第W周-{S}{D}的周记账.xlsx`。 */
const WEEKLY_FILE_RE = /^\d{2}月第\d+周-.+的周记账\.xlsx$/;

/** 运行报告文件名：`<root>/ledger/.run-report-YYYYMMDD.json`。 */
const RUN_REPORT_RE = /^\.run-report-(\d{4})(\d{2})(\d{2})\.json$/;

// ============================================================================
// 二、小工具：时间 / 参数 / 目录扫描（全部只读）
// ============================================================================

/**
 * 时区后缀（从 offsetMinutes 现场算，不写死 +08:00）。
 * @param {number} offsetMinutes
 * @returns {string} 形如 `+08:00`
 */
function offsetSuffix(offsetMinutes) {
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : 480;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * 契约文本时间：`YYYY-MM-DD HH:MM:SS +08:00`（无 Z）。
 *
 * @why ledger.stampLocal 只给到秒（无后缀），而面板/读日志的 `at` 契约要求带偏移，
 *      所以这里在它之上补后缀 —— 保证全库只有一种时间写法。
 */
function stampWithOffset(ms, offsetMinutes) {
  return `${stampLocal(ms, offsetMinutes)} ${offsetSuffix(offsetMinutes)}`;
}

/** 统一响应信封。 */
function respond(status, json, extraHeaders) {
  return {
    status,
    headers: { ...API_HEADERS, ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}) },
    json,
  };
}

/** 参数错误（契约 §1.1：400 + `{ok:false, reason:'bad-param', detail}`）。 */
function badParam(detail) {
  return respond(400, { ok: false, reason: 'bad-param', detail: String(detail || '参数不合法') });
}

/** 数据级失败（契约 §1.1：200 + `{ok:false, reason}`，面板要能显示"为什么"）。 */
function dataFail(reason, extra) {
  return respond(200, { ok: false, reason: String(reason || 'unknown'), ...(extra && typeof extra === 'object' ? extra : {}) });
}

/** 取单值字符串参数（数组取第一个；空串保留为空串，由路由决定是否视为缺省）。 */
function strParam(query, name) {
  if (!query || typeof query !== 'object') return undefined;
  const v = query[name];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return String(v);
}

/**
 * 取整数参数并钳到区间。
 *
 * @returns {{ok:true, value:number}|{ok:false, detail:string}}
 * @why 显式给了非数字 = 参数错误（400）；越界才是钳制（不是错误）——契约 §1.4 口径。
 */
function intParam(query, name, spec) {
  const raw = strParam(query, name);
  if (raw === undefined || raw === '') return { ok: true, value: spec.dflt };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, detail: `${name} 必须是数字（收到 ${JSON.stringify(raw)}）` };
  const i = Math.trunc(n);
  return { ok: true, value: Math.min(spec.hi, Math.max(spec.lo, i)) };
}

/** 布尔型开关（`1` / `true` / `yes` 为真）。 */
function truthyParam(query, name) {
  const raw = strParam(query, name);
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

/** 把 query 归一成普通对象（兼容 URLSearchParams；重复键取第一个）。 */
function normalizeQuery(query) {
  if (!query || typeof query !== 'object') return {};
  if (typeof query.entries === 'function' && typeof query.get === 'function') {
    const o = {};
    for (const [k, v] of query.entries()) if (!(k in o)) o[k] = v;
    return o;
  }
  return query;
}

/** `args` 摘要：只记请求方显式给的参数，截断交给 readlog（240 字符）。
 *  ★ V1.0 / SEC-01：token 类参数**绝不落盘**（脱敏成 `***`）——读日志是审计证据，
 *    不能反过来成为密钥泄露面。 */
const SENSITIVE_QUERY_KEYS = new Set(['token', 'paneltoken', 'access_token', 'x-dialog-ledger-token']);
function argsSummary(query) {
  if (!query || typeof query !== 'object') return '';
  const o = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (SENSITIVE_QUERY_KEYS.has(String(k).toLowerCase())) { o[k] = '***'; continue; }
    o[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  try { return JSON.stringify(o); } catch { return ''; }
}

/** 安全 readdir（读不了 = 空数组，不让一个坏目录把整条路由打挂）。 */
function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * 现场数交接表（主表 + 附表）—— **新布局 `<root>/交接表/` 与一级老位置都数**。
 *
 * @why V0.6.2（机主已签《v0.6.2-迁移规格-v1》§2.2）：写端把交接表移进 `交接表/`，老库还散在一级。
 *      面板是"看账的窗"，不能因为用户没迁移就先少显示一份（读侧双路径是规格硬要求）。
 * @why 同名文件在两处同时存在时**只算一份**（新目录优先）：这是"迁移中断/目标已存在冲突"时的
 *      可能状态 —— 物理文件 2 个、逻辑文档 1 份；`main/appendix/total` 的语义仍是"份数"，
 *      不该因为一次没搬完的迁移把面板数字翻倍。
 *
 * @param {string} root
 * @returns {{main:number, appendix:number, total:number}}
 */
function scanHandover(root) {
  const out = { main: 0, appendix: 0, total: 0 };
  /** 已数过的文件名（新布局优先；一级同名不重复计数）。 */
  const seen = new Set();
  const count = (name) => {
    if (seen.has(name)) return;
    // 0.9.2：原用 freeze/handover.js 的 MAIN_FILE_RE / APPENDIX_FILE_RE；改用 core 的
    // lib/layout.js classifyFileName —— 它内部 RE.handoverMain / RE.handoverAppendix 与
    // 那两条正则逐字相同（同一份文件名口径），返回 HANDOVER_MAIN / HANDOVER_APPENDIX。
    const kind = classifyFileName(name);
    if (kind === FILE_KIND.HANDOVER_MAIN) {
      seen.add(name);
      out.main += 1;
    } else if (kind === FILE_KIND.HANDOVER_APPENDIX) {
      seen.add(name);
      out.appendix += 1;
    }
  };
  // ① 新布局：<root>/交接表/（写端默认落点；不存在时 readdir 返回空，不影响老库）
  for (const e of safeReaddir(path.join(root, SUBDIR.handover))) {
    if (e.isFile()) count(e.name);
  }
  // ② 老布局兜底：一级（v0.6.1 及以前的位置）
  for (const e of safeReaddir(root)) {
    if (e.isFile()) count(e.name);
  }
  out.total = out.main + out.appendix;
  return out;
}

/** 第 3 级「完整原文」目录名后缀（0.9.2：与 freeze/cleanup.js:113 isOriginalDirName 同口径）。 */
const ORIGINAL_DIR_SUFFIX = '完整原文”';

/**
 * 现场扫第 3 级原文与同编码附件。
 *
 * @returns {{views:number, attachments:number}}
 * @why 0.9.2 边界归零：原实现 import `freeze/cleanup.js` 的 `listOriginals`（审查层 → 静态可达
 *      freeze，越界）。改用 core 的 `lib/reconcile.js listArchiveFiles`（扫的正是第 3 级
 *      `<编码>[.vN] 完整原文.md` / `<编码>[.vN] 原始事件.json`，内部 ARCHIVE_FILE_RE），
 *      并在本文件内做**等价归约**，让 `summary.counts.original` 的计数口径与裁剪前逐项一致：
 *        · views = 规范视图 `<code> 完整原文.md` 的份数 —— `.vN` 历史版本不重复计数
 *          （旧 listOriginals 只认 `${code} 完整原文.md`，故这里按 basename 精确比对；
 *           不能只判 version===1 —— `.v1` 的 version 也是 1）；
 *        · attachments = 上述每个规范视图**同目录且物理存在**的 `<code> 原始事件.json` 份数
 *          （孤儿附件归对账的 originalOrphan，不混进计数）；
 *        · 目录口径：只认父目录名以「完整原文”」结尾的目录（旧 isOriginalDirName 同口径；
 *          listArchiveFiles 不判目录名，故在此补齐，否则畸形放置的视图会被多算）。
 *      残余差异（如实记，正常库不会出现）：listArchiveFiles 会跳过 `ledger/`、`.git`、点目录，
 *      旧 listOriginals 会扫进去 —— 那几处本就不该出现原文视图。
 */
function scanOriginals(root) {
  const out = { views: 0, attachments: 0 };
  let entries = [];
  try { entries = listArchiveFiles(root); } catch { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  /** 全量文件相对路径集合：判"同目录附件是否存在"（一次扫描拿全，不逐条 stat）。 */
  const files = new Set();
  for (const f of entries) if (f && typeof f.file === 'string') files.add(f.file);
  for (const f of entries) {
    if (!f || f.kind !== 'view' || typeof f.code !== 'string' || typeof f.file !== 'string') continue;
    const dir = path.dirname(f.file);
    // 文件直接落在 root 下时 dir 是 '.'：此时父目录就是 root 本身（与旧 walk 的 basename(root) 对应）。
    const dirName = dir === '.' ? path.basename(root) : path.basename(dir);
    if (!dirName.endsWith(ORIGINAL_DIR_SUFFIX)) continue;
    if (path.basename(f.file) !== `${f.code} 完整原文.md`) continue;
    out.views += 1;
    if (files.has(path.join(dir, `${f.code} 原始事件.json`))) out.attachments += 1;
  }
  return out;
}

/**
 * 现场扫周记账（month 目录下的 xlsx）。
 * @returns {{files:number, months:number}}
 * @why months 只数"确实有周记账文件的月份目录"：空月目录/只有原文的月份不算周记账月份。
 */
function scanWeekly(root) {
  const out = { files: 0, months: 0 };
  const months = new Set();
  for (const e of safeReaddir(root)) {
    if (!e.isDirectory() || !MONTH_DIR_RE.test(e.name)) continue;
    let n = 0;
    try {
      for (const name of fs.readdirSync(path.join(root, e.name))) {
        if (WEEKLY_FILE_RE.test(name)) n += 1;
      }
    } catch { n = 0; }
    if (n > 0) { out.files += n; months.add(e.name); }
  }
  out.months = months.size;
  return out;
}

/**
 * 取**最新日期**的运行报告（`<root>/ledger/.run-report-YYYYMMDD.json`，文件名即日期）。
 *
 * @returns {{found:boolean, name?:string, path?:string, report?:object|null}}
 * @why 只认目录里日期最大的那个文件；读不出来也要"found=true + report=null"
 *      —— 面板要能区分"没有报告"与"报告坏了"，不许把后者伪装成前者。
 */
function readLatestRunReport(root) {
  const dir = path.join(root, 'ledger');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => RUN_REPORT_RE.test(n)).sort(); } catch { names = []; }
  if (names.length === 0) return { found: false };
  const name = names[names.length - 1];
  const abs = path.join(dir, name);
  let report = null;
  try { report = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { report = null; }
  return { found: true, name, path: abs, report };
}

/** 报告里的计数字段（报告形状见 lib/selfheal.js 的 writeRunReport）。 */
function reportCount(rep, key, fallback) {
  const c = rep && rep.counts && typeof rep.counts === 'object' ? rep.counts : null;
  if (c && Number.isFinite(Number(c[key]))) return Number(c[key]);
  return fallback;
}

// ============================================================================
// 三、summary：现场统计 + 运行报告 + 读审计（30s 缓存）
// ============================================================================

/**
 * 组 health 段（契约 §1.3 的 19 个键，逐字给全）。
 *
 * @param {string} root
 * @param {object} all `readAll(root,{repairTornTail:false})` 的结果
 * @returns {object}
 * @why 没有运行报告时 `ok/okStrict=null`、`gate='unknown'`、`evidence='no-run-report'`：
 *      "未验证"是事实，**不许**写成 false 冒充"坏"（契约 §0 第 5 条）。
 */
function buildHealth(root, all) {
  const health = {
    ok: null,
    okStrict: null,
    gate: 'unknown',
    evidence: 'no-run-report',
    lastRunAt: '',
    lastRunReportAt: '',
    ledgerOk: all.ok === true,
    badLines: Number(all.badLines) || 0,
    readErrors: Array.isArray(all.readErrors) ? all.readErrors.length : 0,
    originalMissing: 0,
    originalOrphan: 0,
    weeklyGroupsMissing: 0,
    lostGaps: 0,
    receiptBreaks: 0,
    sealChainOk: null,
    blockedSources: 0,
    stuckSources: 0,
    unavailable: 0,
    errors: 0,
    // ★ V0.6 / D18：legacy 基线三键（无报告 = null，不伪装成 0）
    legacyUnverifiable: null,
    legacyUnmarkedNoEvidence: null,
    legacyMarksChainOk: null,
  };

  // ① 台账现场读（读全与否是**现场事实**，不依赖运行报告）
  // ② 最近一轮时间：来自 state（读不到就留空，不猜）
  try {
    const st = readStateEx(root);
    if (st && st.ok && st.state && typeof st.state.lastRunAt === 'string') {
      health.lastRunAt = st.state.lastRunAt;
    }
  } catch { /* state 读不了不影响健康度其它字段 */ }

  // ③ 运行报告（最新日期）
  const rr = readLatestRunReport(root);
  if (!rr.found) return health;
  health.evidence = rr.report ? 'run-report' : 'run-report-unreadable';
  const rep = rr.report;
  if (!rep || typeof rep !== 'object') return health;

  health.lastRunReportAt = typeof rep.generatedAt === 'string' && rep.generatedAt
    ? rep.generatedAt
    : (typeof rep.at === 'string' ? rep.at : '');

  const rec = rep.reconcile && typeof rep.reconcile === 'object' ? rep.reconcile : null;
  if (rec) {
    if (typeof rec.ok === 'boolean') health.ok = rec.ok;
    if (typeof rec.okStrict === 'boolean') health.okStrict = rec.okStrict;
    if (rec.sealChain && typeof rec.sealChain === 'object') health.sealChainOk = rec.sealChain.ok === true;
  }
  // （gate 结论由 index.js 落报告；老报告没有该键时退回 reconcile.conclusion，再不行 unknown）
  const gate = rep.gate && typeof rep.gate === 'object' ? rep.gate : null;
  if (gate && typeof gate.conclusion === 'string' && gate.conclusion) health.gate = gate.conclusion;
  else if (rec && typeof rec.conclusion === 'string' && rec.conclusion) health.gate = rec.conclusion;

  const arrLen = (v) => (Array.isArray(v) ? v.length : null);
  health.originalMissing = reportCount(rep, 'originalMissing',
    rec && arrLen(rec.originalMissing) !== null ? arrLen(rec.originalMissing) : 0);
  health.originalOrphan = reportCount(rep, 'originalOrphan',
    rec && arrLen(rec.originalOrphan) !== null ? arrLen(rec.originalOrphan) : 0);
  health.weeklyGroupsMissing = reportCount(rep, 'weeklyGroupsMissing',
    rec && arrLen(rec.weeklyGroupsMissing) !== null ? arrLen(rec.weeklyGroupsMissing) : 0);
  health.lostGaps = reportCount(rep, 'lostGaps',
    rec && rec.lostGaps && Number.isFinite(Number(rec.lostGaps.count)) ? Number(rec.lostGaps.count) : 0);
  health.receiptBreaks = reportCount(rep, 'receiptBreaks',
    rec && arrLen(rec.receiptBreaks) !== null ? arrLen(rec.receiptBreaks) : 0);
  health.blockedSources = reportCount(rep, 'blockedSources', arrLen(rep.blockedSources) || 0);
  health.stuckSources = reportCount(rep, 'stuckSources', arrLen(rep.stuckSources) || 0);
  health.errors = reportCount(rep, 'errors', arrLen(rep.errors) || 0);
  // `unavailable` 是"本轮显式没采的段"清单（数组，不是计数）；报告 counts 里没有该键。
  health.unavailable = Array.isArray(rep.unavailable)
    ? rep.unavailable.length
    : (Number.isFinite(Number(rep.counts && rep.counts.unavailable)) ? Number(rep.counts.unavailable) : 0);
  // ★ V0.6 / D18：历史无证据（已被 legacy 基线标记）与"未标记无证据"必须都能看见。
  health.legacyUnverifiable = reportCount(rep, 'legacyUnverifiable',
    rec && Number.isFinite(Number(rec.legacyUnverifiableCount)) ? Number(rec.legacyUnverifiableCount) : null);
  health.legacyUnmarkedNoEvidence = reportCount(rep, 'legacyUnmarkedNoEvidence',
    rec && rec.legacyMarks && Number.isFinite(Number(rec.legacyMarks.unmarked)) ? Number(rec.legacyMarks.unmarked) : null);
  if (rec && rec.legacyMarks && typeof rec.legacyMarks.chainOk === 'boolean') health.legacyMarksChainOk = rec.legacyMarks.chainOk;
  else if (rep.counts && typeof rep.counts.legacyMarksChainOk === 'boolean') health.legacyMarksChainOk = rep.counts.legacyMarksChainOk;
  return health;
}

/**
 * 现场计算 summary（不含缓存）。
 *
 * @param {object} e 归一后的 env
 * @param {number} nowMs 本次取数时刻
 * @returns {object} 契约 §1.3 的形状
 */
function computeSummary(e, nowMs) {
  const root = e.getRoot();

  let rootExists = false;
  try { rootExists = fs.statSync(root).isDirectory(); } catch { rootExists = false; }

  // ① 台账现场读（repairTornTail:false —— 只读路径绝不触发自愈/截断）
  const all = readAll(root, { repairTornTail: false });

  // ② 目录扫描（目录不存在时各计数自然为 0，**不建目录**）
  const handover = scanHandover(root);
  const original = scanOriginals(root);
  const weekly = scanWeekly(root);

  // ③ 封板组数（journal 权威；读不出 → null，不许写成 0 冒充"没封过"）
  let sealed = 0;
  try {
    const seals = readWeeklySeals(root);
    sealed = seals && typeof seals === 'object' ? Object.keys(seals).length : 0;
  } catch { sealed = null; }

  // ④ 读审计摘要（读日志两种位置合计；读不出来 → null 而非 0）
  let reads;
  try {
    const s = summarizeReads(root);
    reads = s && s.ok
      ? { total: Number(s.total) || 0, lastAt: String(s.lastAt || ''), badLines: Number(s.badLines) || 0 }
      : { total: null, lastAt: '', badLines: null };
  } catch { reads = { total: null, lastAt: '', badLines: null }; }

  return {
    ok: true,
    v: API_VERSION,
    generatedAt: stampWithOffset(nowMs, e.offsetMinutes),
    root,
    rootExists,
    layoutVersion: LAYOUT_VERSION,
    counts: {
      handover,
      original,
      weekly: { files: weekly.files, months: weekly.months, sealed },
      ledgerRows: Array.isArray(all.records) ? all.records.length : 0,
    },
    health: buildHealth(root, all),
    reads,
    capabilities: {
      // 面板是只读窗：V0.6 不提供物理删除/库外收据锚的写能力
      readOnly: true,
      physicalDelete: false,
      receiptAnchor: !!(typeof e.receiptAnchorRoot === 'string' && e.receiptAnchorRoot.trim()),
    },
  };
}

// ============================================================================
// 四、reconcile：纯只读对账 + 裁剪（30s 缓存）
// ============================================================================

/**
 * 跑一次对账（带缓存；`refresh=true` 绕缓存重算）。
 *
 * @param {object} e env
 * @param {number} nowMs 本次时刻
 * @param {boolean} refresh 是否强制重算
 * @returns {object} lib/reconcile.js 的完整结果
 * @why 缓存里按**最大 maxDetail** 存完整裁剪（200），再按本次请求量二次 slice ——
 *      否则先来一个 `maxDetail=5` 的请求会把缓存截成 5 条，后面 `maxDetail=50` 就永远拿不全。
 */
function getReconcileResult(e, nowMs, refresh) {
  const root = e.getRoot();
  const key = `${root}|${e.offsetMinutes}`;
  const hit = reconcileCache.get(key);
  if (!refresh && hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_TTL_MS) return hit.data;
  const data = reconcile({
    root,
    offsetMinutes: e.offsetMinutes,
    receiptAnchorRoot: typeof e.receiptAnchorRoot === 'string' ? e.receiptAnchorRoot : undefined,
    nowMs,
    maxDetail: LIMITS.maxDetail.hi,
  });
  reconcileCache.set(key, { at: nowMs, data });
  return data;
}

/** 裁剪对账结果为面板够用的形状（契约 §1.8）。 */
function trimReconcile(r, maxDetail) {
  const src = r && typeof r === 'object' ? r : {};
  const sc = src.sealChain && typeof src.sealChain === 'object' ? src.sealChain : {};
  const sealBreaks = Array.isArray(sc.breaks)
    ? sc.breaks.length
    : (Number.isFinite(Number(sc.chainBroken)) ? Number(sc.chainBroken) : 0);
  const list = (v) => (Array.isArray(v) ? v.slice(0, maxDetail) : []);
  return {
    ok: true,
    at: String(src.at || ''),
    ledgerRows: Number(src.ledgerRows) || 0,
    codeUnique: src.codeUnique === true,
    sidTurnUnique: src.sidTurnUnique === true,
    ledgerOk: src.ledgerOk === true,
    okStrict: src.okStrict === true,
    badLines: Number(src.badLines) || 0,
    readErrorsCount: Array.isArray(src.readErrors) ? src.readErrors.length : 0,
    originalCount: Number(src.originalCount) || 0,
    originalMissingCount: Array.isArray(src.originalMissing) ? src.originalMissing.length : 0,
    originalOrphanCount: Array.isArray(src.originalOrphan) ? src.originalOrphan.length : 0,
    legacyUnverifiableCount: Number.isFinite(Number(src.legacyUnverifiableCount))
      ? Number(src.legacyUnverifiableCount)
      : (Array.isArray(src.legacyUnverifiable) ? src.legacyUnverifiable.length : 0),
    unmarkedNoEvidenceCount: Number.isFinite(Number(src.unmarkedNoEvidenceCount)) ? Number(src.unmarkedNoEvidenceCount) : 0,
    legacyMarks: src.legacyMarks && typeof src.legacyMarks === 'object'
      ? {
        path: String(src.legacyMarks.path || ''),
        exists: src.legacyMarks.exists === true,
        chainOk: src.legacyMarks.chainOk === true,
        count: Number(src.legacyMarks.count) || 0,
        matched: Number(src.legacyMarks.matched) || 0,
        mismatched: Number(src.legacyMarks.mismatched) || 0,
        unmarked: Number(src.legacyMarks.unmarked) || 0,
        orphan: Number(src.legacyMarks.orphan) || 0,
      }
      : null,
    weeklyGroupsExpectedCount: Array.isArray(src.weeklyGroupsExpected) ? src.weeklyGroupsExpected.length : 0,
    weeklyGroupsMissingCount: Array.isArray(src.weeklyGroupsMissing) ? src.weeklyGroupsMissing.length : 0,
    lostGapsCount: src.lostGaps && Number.isFinite(Number(src.lostGaps.count)) ? Number(src.lostGaps.count) : 0,
    receiptBreaksCount: Number.isFinite(Number(src.receiptBreakCount))
      ? Number(src.receiptBreakCount)
      : (Array.isArray(src.receiptBreaks) ? src.receiptBreaks.length : 0),
    sealChain: {
      ok: sc.ok === true,
      lines: Number(sc.lines) || 0,
      events: Number(sc.events) || 0,
      breaks: sealBreaks,
    },
    // 面板"为什么对不上"要能直接看到 reconciliation 自身的结论（API 的 ok 只表示"取到了"）。
    reconcileOk: src.ok === true,
    top: {
      originalMissing: list(src.originalMissing),
      weeklyGroupsMissing: list(src.weeklyGroupsMissing),
      receiptBreaks: list(src.receiptBreaks),
    },
  };
}

// ============================================================================
// 五、7 条路由的纯逻辑（参数校验 → 取数 → 响应信封）
// ============================================================================

/**
 * `GET /dialog-ledger/api/ping` —— 面板自检"host 半边是否在线"。
 *
 * ★ V1.0.0-re3 / P2（审计②）：**不再回显账库绝对路径**。
 *   旧 → 新：旧契约回 `root: '<绝对路径>'`；ping 是自检路由，回显本机目录结构没有业务价值，
 *   却把"账库在哪"直接交给任何能访问回环端口的本机进程。新契约只给 `rootName`（basename）。
 *   需要完整路径的展示场景走 `/summary.root`（保持旧契约；残余风险见整改报告 §7）。
 */
function routePing(e, query, nowMs) {
  const root = String(e.getRoot() || '');
  const rootName = path.basename(root.replace(/[\\/]+$/, '')) || '';
  return respond(200, {
    ok: true,
    v: API_VERSION,
    at: stampWithOffset(nowMs, e.offsetMinutes),
    rootName,
  });
}

/** `GET /summary` —— 健康度第一屏（现场统计 + 运行报告；30s 缓存）。 */
function routeSummary(e, query, nowMs) {
  const refresh = truthyParam(query, 'refresh');
  const root = e.getRoot();
  const key = `${root}|${e.offsetMinutes}`;
  const hit = summaryCache.get(key);
  if (!refresh && hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_TTL_MS) return respond(200, hit.data);
  const data = computeSummary(e, nowMs);
  summaryCache.set(key, { at: nowMs, data });
  return respond(200, data);
}

/** `GET /search?sid=&month=&keyword=&limit=` —— 透传 ledgerapi.searchLedger。 */
function routeSearch(e, query) {
  const month = strParam(query, 'month');
  if (month !== undefined && month !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return badParam('month 必须形如 YYYY-MM（月份 01–12）');
  }
  const limit = intParam(query, 'limit', LIMITS.searchLimit);
  if (!limit.ok) return badParam(limit.detail);

  const result = searchLedger(e.getRoot(), {
    sid: strParam(query, 'sid'),
    month: month || '',
    keyword: strParam(query, 'keyword'),
    limit: limit.value,
    offsetMinutes: e.offsetMinutes,
  });
  if (!result || result.ok !== true) {
    return dataFail(result && result.reason ? result.reason : 'ledger-unreadable', {
      ...(result && Number.isFinite(result.readErrors) ? { readErrors: result.readErrors } : {}),
    });
  }
  return respond(200, result);
}

/** `GET /turn?code=&excerptBytes=` —— 透传 ledgerapi.getTurn。 */
function routeTurn(e, query) {
  const code = String(strParam(query, 'code') || '').trim();
  if (!code) return badParam('缺少 code 参数');
  const excerpt = intParam(query, 'excerptBytes', LIMITS.excerptBytes);
  if (!excerpt.ok) return badParam(excerpt.detail);

  const result = getTurn(e.getRoot(), code, {
    excerptBytes: excerpt.value,
    offsetMinutes: e.offsetMinutes,
  });
  return respond(200, result && typeof result === 'object'
    ? result
    : { ok: false, reason: 'internal-error' });
}

/**
 * `GET /original?code=&maxBytes=` —— 只读打开该编码的完整原文。
 *
 * @why 定位沿用 `ledgerapi.getTurn`（同一套"行声明的 doc → 按编码日期段复算"候选路径），
 *      本路由只负责**读文件**，不自己发明路径规则。
 * @why `bytes` 给**文件总字节**（面板要知道整篇多大），`truncated` 才表示"这次只返回了前 maxBytes"。
 * @why V1.0.0-re3 / P2（审计② TOCTOU）：旧实现 `containedPath()` 里 `statSync + realpathSync` 校验后
 *      **再用路径重新 open**，两次系统调用之间可被换成符号链接/目录联接（Windows junction），
 *      把库外文件当原文读出来。本版改为 **open 后 fstat 校验**，并把"校验过的路径身份"与
 *      "已打开的 fd"绑定在同一个对象上（详见函数内注释）：
 *        · open 后立刻 fstat：确认打开的是普通文件；
 *        · 再跑一次 containedPath（open 之后的 realpath containment）：此时路径若已指向库外 → 拒；
 *        · 比较"验证过的路径 stat（dev/ino；拿不到 ino 时退化为 size+mtime）"与 fstat：不一致 = 被替换 → 拒；
 *        · 之后**只从该 fd 读**，不再碰路径 —— 读到的就是校验过的那个对象。
 *      旧 → 新契约：`original-outside-root` 之外新增内部失败原因 `original-unverified`（路径在 open 期间变化）。
 */
function routeOriginal(e, query) {
  const code = String(strParam(query, 'code') || '').trim();
  if (!code) return badParam('缺少 code 参数');
  const maxBytes = intParam(query, 'maxBytes', LIMITS.maxBytes);
  if (!maxBytes.ok) return badParam(maxBytes.detail);

  const turn = getTurn(e.getRoot(), code, { excerptBytes: 0, offsetMinutes: e.offsetMinutes });
  if (!turn || turn.ok !== true) {
    return dataFail(turn && turn.reason ? turn.reason : 'not-found', { code });
  }
  const rel = turn.original && typeof turn.original.path === 'string' ? turn.original.path : '';
  if (!rel) return dataFail('not-found', { code });

  // ★ V0.9：纵深防御。getTurn 已经只返回库内路径；这里再判一次——
  //   面板是 HTTP 面，任何"信任上游"的假设都不该出现在读文件这条线上。
  const safe = containedPath(e.getRoot(), rel);
  if (safe.reason) return dataFail('original-outside-root', { code, reason: safe.reason });
  const abs = safe.abs;

  let fd = null;
  try { fd = fs.openSync(abs, 'r'); } catch { fd = null; }
  if (fd === null) return dataFail('not-found', { code });
  try {
    // ① open 后 fstat：打开的对象必须仍是普通文件
    let fst = null;
    try { fst = fs.fstatSync(fd); } catch { fst = null; }
    if (!fst || !fst.isFile()) return dataFail('not-found', { code });

    // ② open 之后再验一次 containment（realpath 在"打开之后"重算；路径若已被换成库外 → 拒）
    const after = containedPath(e.getRoot(), rel);
    if (after.reason) {
      if (after.reason === 'outside-root' || after.reason === 'symlink-escape') {
        return dataFail('original-outside-root', { code, reason: after.reason });
      }
      return dataFail('original-unverified', { code, reason: after.reason });
    }
    // ③ "验证过的路径"与"已打开 fd"必须是同一个对象（被换过 → dev/ino 不等）
    let stNow = null;
    try { stNow = fs.statSync(after.abs); } catch { stNow = null; }
    const hasIno = !!(stNow && Number(fst.ino) !== 0 && Number(stNow.ino) !== 0);
    const sameObject = !!stNow && (hasIno
      ? (Number(fst.dev) === Number(stNow.dev) && Number(fst.ino) === Number(stNow.ino))
      : (fst.size === stNow.size && fst.mtimeMs === stNow.mtimeMs));
    if (!sameObject) return dataFail('original-unverified', { code, reason: 'changed-after-open' });

    let text = '';
    if (maxBytes.value > 0 && fst.size > 0) {
      try {
        const want = Math.min(maxBytes.value, fst.size);
        const buf = Buffer.alloc(want);
        const n = fs.readSync(fd, buf, 0, want, 0);
        text = buf.subarray(0, n).toString('utf8');
      } catch (err) {
        return dataFail('read-failed', { code, detail: err && err.message ? err.message : String(err) });
      }
    }
    return respond(200, {
      ok: true,
      code,
      // 契约示例用正斜杠；Windows 的 path.relative 给反斜杠，这里统一成展示口径。
      path: rel.split(path.sep).join('/'),
      bytes: fst.size,
      text,
      truncated: fst.size > maxBytes.value,
    });
  } finally {
    try { fs.closeSync(fd); } catch { /* fd 已关也不许影响响应 */ }
  }
}

/**
 * `GET /reads?limit=` —— 透传 readlog.readReads，**一次遍历**同时出列表与摘要。
 *
 * @why V1.0 / 审计 P1-07：旧实现 readReads 整读一遍、summarizeReads 再整读一遍（重复请求可放大 IO）。
 *      现在 `readReads({summary:true})` 一次读完同时算摘要；内存只保留最后 limit 条。
 */
function routeReads(e, query) {
  const limit = intParam(query, 'limit', LIMITS.readsLimit);
  if (!limit.ok) return badParam(limit.detail);

  const r = readReads(e.getRoot(), { limit: limit.value, summary: true });
  if (!r || r.ok !== true) return dataFail(r && r.reason ? r.reason : 'read-failed');
  const s = r.summary && typeof r.summary === 'object' ? r.summary : {};
  const summary = {
    byTool: s.byTool && typeof s.byTool === 'object' ? s.byTool : {},
    hitCodesTotal: Number(s.hitCodesTotal) || 0,
    lastAt: String(s.lastAt || ''),
  };
  return respond(200, {
    ok: true,
    rows: Array.isArray(r.rows) ? r.rows : [],
    total: Number(r.total) || 0,
    badLines: Number(r.badLines) || 0,
    summary,
  });
}

/** `GET /reconcile?maxDetail=&refresh=1` —— 纯只读对账（30s 缓存，refresh 强制重算）。 */
function routeReconcile(e, query, nowMs) {
  const maxDetail = intParam(query, 'maxDetail', LIMITS.maxDetail);
  if (!maxDetail.ok) return badParam(maxDetail.detail);
  const refresh = truthyParam(query, 'refresh');
  try {
    const result = getReconcileResult(e, nowMs, refresh);
    return respond(200, trimReconcile(result, maxDetail.value));
  } catch (err) {
    return dataFail('reconcile-failed', { detail: err && err.message ? err.message : String(err) });
  }
}

/**
 * 路由分派（内部）。任何异常都收敛成 200 + `{ok:false, reason:'internal-error'}`：
 * 面板宁可显示"为什么失败"，也不该看到一个裸 500 白屏。
 */
function dispatchRoute(e, route, query, nowMs) {
  switch (route) {
    case 'ping': return routePing(e, query, nowMs);
    case 'summary': return routeSummary(e, query, nowMs);
    case 'search': return routeSearch(e, query);
    case 'turn': return routeTurn(e, query);
    case 'original': return routeOriginal(e, query);
    case 'reads': return routeReads(e, query);
    case 'reconcile': return routeReconcile(e, query, nowMs);
    default: return respond(404, { ok: false, reason: 'unknown-route', route: String(route || '') });
  }
}

// ============================================================================
// 六、读日志：每次 GET 恰好一条（HEAD 不计；写失败不影响响应）
// ============================================================================

/** 从响应体里提取读日志的命中编码/返回行数（各路由口径见契约 §1.1）。 */
function metricsOf(route, json) {
  const out = { hitCodes: [], returnedRows: 0 };
  if (!json || typeof json !== 'object') return out;
  if (route === 'search' && Array.isArray(json.rows)) {
    out.returnedRows = json.rows.length;
    out.hitCodes = json.rows.map((r) => (r && r.code ? String(r.code) : '')).filter(Boolean);
    return out;
  }
  if (route === 'reads' && Array.isArray(json.rows)) {
    out.returnedRows = json.rows.length;
    return out;
  }
  if (route === 'turn' && json.ok === true && json.row && json.row.code) {
    out.returnedRows = 1;
    out.hitCodes = [String(json.row.code)];
    return out;
  }
  if (route === 'original' && json.ok === true && json.code) {
    out.returnedRows = 1;
    out.hitCodes = [String(json.code)];
  }
  return out;
}

/**
 * 归一 env。
 *
 * @param {object} env `{getRoot, offsetMinutes?, logger?, now?, receiptAnchorRoot?}`
 * @returns {object}
 * @why `now` 是给测试注入的（否则 summary/reconcile 的 30s 缓存没法确定性验证）；
 *      生产不传就用 Date.now。
 */
function normalizeEnv(env) {
  const e = env && typeof env === 'object' ? env : {};
  const getRoot = typeof e.getRoot === 'function'
    ? e.getRoot
    : () => String(e.root || '');
  return {
    ...e,
    getRoot,
    offsetMinutes: Number.isFinite(e.offsetMinutes) ? e.offsetMinutes : 480,
    logger: e.logger && typeof e.logger === 'object' ? e.logger : {},
    now: typeof e.now === 'function' ? e.now : () => Date.now(),
    receiptAnchorRoot: typeof e.receiptAnchorRoot === 'string' ? e.receiptAnchorRoot : '',
  };
}

/** 取当前毫秒（env.now 注入优先；非法值回落 Date.now）。 */
function envNow(e) {
  try {
    const t = e.now();
    if (Number.isFinite(t)) return t;
  } catch { /* 注入的 now 抛错就回落真实钟 */ }
  return Date.now();
}

// ============================================================================
// 七、对外入口：进程内直调 / URL 直调 / HTTP resource / 注册
// ============================================================================

/** summary / reconcile 的模块级缓存（跨请求复用；键含 root + offsetMinutes）。 */
const summaryCache = new Map();
const reconcileCache = new Map();

/**
 * 执行一条路由（进程内入口，契约 §4 的验收就用它，不起 HTTP）。
 *
 * @param {object} env `{getRoot:()=>string, offsetMinutes?:number, logger?:object, now?:()=>number}`
 * @param {string} route 路由名，见 API_ROUTES（不要带前缀）
 * @param {object} [query] 参数对象（或 URLSearchParams）
 * @param {{method?:string, nowMs?:number}} [opts]
 * @returns {{status:number, headers:object, json:object}}
 */
export function runPanelRoute(env, route, query = {}, opts = {}) {
  const t0 = Date.now();
  const e = normalizeEnv(env);
  const name = String(route || '').trim();
  const q = normalizeQuery(query);
  const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : envNow(e);
  const method = String((opts && opts.method) || 'GET').toUpperCase();

  if (!API_ROUTES.includes(name)) {
    return respond(404, { ok: false, reason: 'unknown-route', route: name });
  }
  // 方法口径（契约 §1.1）：GET/HEAD 允许，其余 405 + Allow。HTTP 载体也会先挡一层，这里是兜底。
  if (method !== 'GET' && method !== 'HEAD') {
    return respond(405, { ok: false, reason: 'method-not-allowed' }, { Allow: 'GET, HEAD' });
  }

  let out;
  try {
    out = dispatchRoute(e, name, q, nowMs);
  } catch (err) {
    out = respond(200, {
      ok: false,
      reason: 'internal-error',
      detail: err && err.message ? err.message : String(err),
    });
  }

  // 读日志：每次 GET（成功或失败）恰好一条；HEAD 不计；写失败绝不影响响应。
  // ★ V1.0 / 审计 P1-07：**root 不合法或不存在时连读日志都不写**——appendRead 会 mkdir，
  //   否则"面板查一个不存在的库"会顺手把 `<root>/ledger/.reads/` 建出来（只读 API 的写副作用）。
  if (method === 'GET') {
    let canLog = false;
    try {
      const r = e.getRoot();
      canLog = isSafeRoot(r) && fs.existsSync(r);
    } catch { canLog = false; }
    if (canLog) {
      const metrics = metricsOf(name, out.json);
      const ok = out.status < 400 && !!(out.json && out.json.ok === true);
      let error = '';
      if (!ok) {
        const reason = out.json && typeof out.json.reason === 'string' ? out.json.reason : '';
        const detail = out.json && typeof out.json.detail === 'string' ? out.json.detail : '';
        error = reason && detail ? `${reason}: ${detail}` : (reason || detail || `http-${out.status}`);
      }
      try {
        appendRead(e.getRoot(), {
          tool: READ_TOOL_PREFIX + name,
          args: argsSummary(q),
          hitCodes: metrics.hitCodes,
          returnedRows: metrics.returnedRows,
          bytes: Buffer.byteLength(JSON.stringify(out.json || {}), 'utf8'),
          ms: Math.max(0, Date.now() - t0),
          ok,
          ...(error ? { error } : {}),
          nowMs: t0,
        });
      } catch { /* 读日志写失败不影响响应（审计失败 ≠ 功能失败） */ }
    }
  }
  return out;
}

/**
 * 按 URL/path 调用（自带 URL 解码），便于验收脚本直接喂契约里的路径。
 *
 * @param {object} env 同 runPanelRoute
 * @param {string|URL} target `'/dialog-ledger/api/search?month=2026-11'`、`'/search?limit=1'` 或 URL
 * @param {object} [opts] 同 runPanelRoute
 * @returns {{status:number, headers:object, json:object}}
 */
export function callPanelApi(env, target, opts = {}) {
  let url;
  if (target instanceof URL) url = target;
  else {
    const s = String(target || '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      try { url = new URL(s); } catch { url = null; }
    }
    if (!url) url = new URL(s.startsWith('/') ? s : '/' + s, 'http://panel.local');
  }
  let route;
  if (url.pathname.startsWith(API_PREFIX)) route = url.pathname.slice(API_PREFIX.length);
  else route = url.pathname.replace(/^\/+/, '');
  route = route.split('/')[0] || '';
  const query = {};
  for (const [k, v] of url.searchParams.entries()) if (!(k in query)) query[k] = v;
  return runPanelRoute(env, route, query, opts);
}

/** 把响应信封转成 web-standard Response（HTTP 载体与测试共用）。 */
function toResponse(status, json, headers) {
  return new Response(JSON.stringify(json === undefined ? null : json), {
    status,
    headers: { ...API_HEADERS, ...(headers && typeof headers === 'object' ? headers : {}) },
  });
}

/** 读一个请求头（大小写不敏感；取不到 = 空串，绝不抛）。 */
function headerOf(headers, name) {
  try {
    const v = headers.get(name);
    return v === null || v === undefined ? '' : String(v).trim();
  } catch { return ''; }
}

/**
 * 拆 `Host` 头 / `URL.host` 成 `{name, port}`（port 为空串 = 未显式给端口）。
 * @why 回环判定与"端口一致性"都要用；IPv6 方括号形态单独处理（`[::1]:3142`）。
 */
function splitHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return { name: '', port: '' };
  let m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(h);
  if (m) return { name: m[1], port: m[2] || '' };
  m = /^([^:]+)(?::(\d{1,5}))?$/.exec(h);
  if (m) return { name: m[1], port: m[2] || '' };
  return { name: '', port: '' };
}

/** 回环 Host 判定：`127.0.0.1` / `localhost` / `[::1]` / `0:0:0:0:0:0:0:1`（可带端口）。 */
function isLoopbackHost(host) {
  const { name } = splitHost(host);
  return name === '127.0.0.1' || name === 'localhost'
    || name === '::1' || name === '0:0:0:0:0:0:0:1';
}

/**
 * Origin/Referer 是否构成"回环 + 端口与本次请求一致"的来源证据。
 *
 * @param {string} raw Origin/Referer 头的原始值
 * @param {string} requestPort 本次请求的端口（取自 `Host` 头；空串 = 未显式给端口）
 * @returns {boolean} true = 可作同源证据；false = 必须拒绝（非回环 / 端口不符 / 解析失败）
 * @why 审计① P1-1 / ② A3：旧实现用 `Origin.origin === requestUrl.origin` 判同源，
 *      而宿主 webServer 用**占位 origin**（Request.url = `http://x/...`）构造 Request，
 *      真机上这条分支是死的；同时 DNS rebinding 下 Origin 与 Host 会同时等于攻击者域名，
 *      "Origin 与 Host 相同"也不可证明同源。因此改为：**回环 host + 端口与请求端口一致**，
 *      并且**任一**存在的来源头不满足即拒绝（fail-closed）。
 */
function isLoopbackSamePortOrigin(raw, requestPort) {
  if (!raw) return false;
  let u;
  try { u = new URL(raw); } catch { return false; } // `null` / 畸形值 → 无法判定 = 拒绝
  if (!isLoopbackHost(u.host)) return false;
  return splitHost(u.host).port === requestPort;
}

/**
 * 同源守卫（V0.6.1 / A8；V1.0 按准入审计 P0-05 + P1-06 加固；**V1.0.0-re3 修审计① P1-1 / ② A3 / ③ SEC-01**）。
 *
 * @why 判定规则（固定顺序，不许调换）：
 *      ① **回环 Host 必须始终成立**（缺 Host / 非回环 → 拒绝），且先于任何来源头判断。
 *         旧契约 `if (site === 'same-origin') return true;` 放在 Host 校验之前 →
 *         `Host: evil.example:3142` + `Sec-Fetch-Site: same-origin` 实测返回 200（DNS rebinding 形态）；
 *         本版删除该短路：**任何来源头都不能替代 Host 判定**。
 *      ② `Sec-Fetch-Site` **只作否决**：`cross-site` / `same-site` / `none` → 拒绝；
 *         `same-origin` 既不否决也不单独放行（它只是"浏览器自称"，Host 才是硬证据）。
 *      ③ 有 `Origin`/`Referer`：**每一个**都必须"回环 host + 端口与本次请求（Host 头端口）一致"，
 *         否则拒绝；解析失败/无法判定 → 拒绝（fail-closed）。
 *      ④ 无来源头：回环 Host 已在 ① 成立 → 放行（DSH 桌面 WebView 实测形态）。
 *      **这是纵深防御，不是密码学鉴权**：有权限的本机进程仍可伪造回环 Host。
 *      真正的鉴权是 SEC-01 的可选 token（见 PANEL_TOKEN_ENV），两者串联使用。
 * @param {Request|object} request web-standard Request（只依赖 `headers.get`）
 * @returns {boolean} true = 同源，放行
 */
function isSameOriginRequest(request) {
  const headers = request && request.headers;
  if (!headers || typeof headers.get !== 'function') return false;
  // ① 回环 Host：先决条件（DNS rebinding 的攻击者 Host 是攻击者域名，任何来源头都不放行）
  const hostRaw = headerOf(headers, 'host');
  if (!isLoopbackHost(hostRaw)) return false;
  const requestPort = splitHost(hostRaw).port;
  // ② Sec-Fetch-Site 只作否决（`same-origin` 不再单独放行 —— 旧短路已被审计判为绕过）
  const site = headerOf(headers, 'sec-fetch-site').toLowerCase();
  if (site === 'cross-site' || site === 'same-site' || site === 'none') return false;
  // ③ Origin/Referer：若存在，必须逐个满足"回环 + 同端口"；任一不满足 / 解析失败 → 拒绝
  for (const name of ['origin', 'referer']) {
    const raw = headerOf(headers, name);
    if (!raw) continue;
    if (!isLoopbackSamePortOrigin(raw, requestPort)) return false;
  }
  // ④ 无来源头（或来源头全部满足）→ 放行（回环 Host 已成立）
  return true;
}

/** 当前是否启用面板 token（每次请求现读环境变量：支持轮换，也便于测试三态）。 */
function panelTokenFromEnv() {
  try {
    const v = process.env ? process.env[PANEL_TOKEN_ENV] : '';
    return typeof v === 'string' ? v.trim() : '';
  } catch { return ''; }
}

/** 从请求取 token：优先请求头，其次 query `?token=`。 */
function panelTokenFromRequest(request, url) {
  const h = request && request.headers && typeof request.headers.get === 'function'
    ? headerOf(request.headers, PANEL_TOKEN_HEADER)
    : '';
  if (h) return h;
  try {
    const q = url && typeof url.searchParams.get === 'function' ? url.searchParams.get(PANEL_TOKEN_QUERY) : null;
    return q === null || q === undefined ? '' : String(q).trim();
  } catch { return ''; }
}

/** 定长时间比较（长度不同直接 false；长度相同走 timingSafeEqual）。未启用恒 true。 */
function panelTokenMatches(expected, got) {
  if (!expected) return true;
  if (!got) return false;
  try {
    const a = Buffer.from(String(expected), 'utf8');
    const b = Buffer.from(String(got), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/**
 * 构造 web-standard HTTP resource（`WebResourceRoute.resource`）。
 *
 * @param {object} env 同 runPanelRoute
 * @returns {(request: Request) => Promise<Response>}
 * @why 只认 exact 路径；方法口径交给 runPanelRoute（GET/HEAD 允许，其余 405 + Allow）。
 * @why V1.0 安全闸顺序（固定，不许调换）：
 *      ① 同源守卫（见 isSameOriginRequest）在 URL 解析之后、路径/参数解析之前先跑，
 *         GET/HEAD 一律先过守卫；拒绝 = 403 + `{ok:false, reason:'forbidden-origin', detail}`；
 *         V1.0.0-re3 起守卫内部顺序固定为「回环 Host（先决）→ SFS 否决 → Origin/Referer 回环同端口」，
 *         `request.url` 只用来解析 pathname/query（宿主 webServer 的 origin 是占位值，**不参与**同源判定）；
 *      ② 守卫过了再看可选 token（SEC-01）；不匹配 = 401 + `{ok:false, reason:'unauthorized'}`；
 *      两道闸都在"碰账本/写读日志"之前返回：被拒请求零副作用。
 *      响应头沿用 API_HEADERS（含 `Cache-Control: no-store`）。
 * @why `runPanelRoute()` **不加守卫也不校验 token**：它是进程内直调入口（工具面/验收用），
 *      浏览器不经过它；只守卫真正的 HTTP resource。
 */
export function createPanelResource(env) {
  const e = normalizeEnv(env);
  return async function panelResource(request) {
    let url;
    try {
      url = new URL(request && request.url ? String(request.url) : '', 'http://panel.local');
    } catch {
      return toResponse(400, { ok: false, reason: 'bad-param', detail: '非法请求地址' });
    }
    const method = request && request.method ? String(request.method).toUpperCase() : 'GET';
    // A8 / V1.0.0-re3：同源守卫先于路径/参数解析（GET/HEAD 生效；被拒请求不产生任何副作用）
    //   新契约：回环 Host 先决 + SFS 只否决 + Origin/Referer 回环同端口（见 isSameOriginRequest）
    if ((method === 'GET' || method === 'HEAD') && !isSameOriginRequest(request)) {
      return toResponse(403, { ok: false, reason: 'forbidden-origin', detail: '只读 API 仅接受回环同源请求' });
    }
    // SEC-01（V1.0）：可选 token —— 环境变量未设置 = 不启用；设置后必须匹配
    const expectedToken = panelTokenFromEnv();
    if (expectedToken && (method === 'GET' || method === 'HEAD')
      && !panelTokenMatches(expectedToken, panelTokenFromRequest(request, url))) {
      return toResponse(401, {
        ok: false,
        reason: 'unauthorized',
        detail: '面板已启用 token（' + PANEL_TOKEN_ENV + '）：请带 ' + PANEL_TOKEN_HEADER + ' 头或 ?' + PANEL_TOKEN_QUERY + '=',
      });
    }
    const pathname = url.pathname;
    if (!pathname.startsWith(API_PREFIX)) {
      return toResponse(404, { ok: false, reason: 'unknown-route' });
    }
    const route = pathname.slice(API_PREFIX.length);
    if (!API_ROUTES.includes(route)) {
      return toResponse(404, { ok: false, reason: 'unknown-route', route });
    }
    const query = {};
    for (const [k, v] of url.searchParams.entries()) if (!(k in query)) query[k] = v;
    const r = runPanelRoute(e, route, query, { method });
    return toResponse(r.status, r.json, r.headers);
  };
}

/**
 * 把 7 条只读路由挂到 Harness 的 webServer 上（可选依赖）。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{getRoot:()=>string, offsetMinutes?:number, logger?:object,
 *          receiptAnchorRoot?:string}} env
 * @returns {{registered:number, names:string[], paths:string[], dispose:()=>void}}
 *
 * @why 用 `ctx.get('webServer')` 可选依赖方式取服务（与 lib/toolface.js 取 tools 同法）：
 *      取不到就静默跳过 —— 面板是增强，**不许**因为它让记账主职责加载失败。
 * @why 注册与撤销必须成对：热重载不撤销会重复注册，而重复的 exact 路由在 webServer 里
 *      是直接 throw 的（route 是组合级契约），所以撤销失败也不影响其它路由先撤。
 */
export function registerLedgerPanelApi(ctx, env) {
  const e = normalizeEnv(env);
  const out = { registered: 0, names: [], paths: [], dispose: () => {} };
  let webServer = null;
  try {
    if (ctx && typeof ctx.get === 'function') webServer = ctx.get('webServer');
  } catch { webServer = null; }
  // ★ V0.6.4 / A13：删除 `ctx.webServer` 直读回退（同 toolface：未 inject 直读会抛，启动窗口踩中）。
  if (!webServer || typeof webServer.register !== 'function') return out;

  const resource = createPanelResource(e);
  const disposers = [];
  for (const route of API_ROUTES) {
    const routePath = API_PREFIX + route;
    try {
      const d = webServer.register({ kind: 'exact', path: routePath, resource });
      if (typeof d === 'function') disposers.push(d);
      out.registered += 1;
      out.names.push(route);
      out.paths.push(routePath);
    } catch (err) {
      const logger = e.logger;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[dsh-dialog-ledger] 注册面板 API 失败 ' + routePath + ': '
          + (err && err.message ? err.message : String(err)));
      }
    }
  }
  out.dispose = () => {
    for (const d of disposers) { try { d(); } catch { /* 撤销失败不影响其它路由 */ } }
  };
  return out;
}

/**
 * 仅供测试：清空 30s 内存缓存。
 * @why 验收要在同一 root 上"先看旧数、改夹具、再看新数"，不清缓存就会读到 30s 内的旧值。
 */
export function clearPanelCaches() {
  summaryCache.clear();
  reconcileCache.clear();
}

/** 测试钩子（与其它 lib 一致：生产代码不 import 它）。 */
export const __test__ = {
  clearPanelCaches,
  summaryCache,
  reconcileCache,
  LIMITS,
  buildHealth,
  trimReconcile,
};
