/**
 * @file pointerindex.mjs
 * @role **档 A · 指针索引外部层**：从台账派生一张"按日分片"的瘦指针表。
 *      索引只是**派生物**——删掉 `.index/` 一个字节都不影响账；台账/原文一律只读。
 *
 * @why 为什么需要它（0.9.4-P3 扩容方案 §4.1）：
 *   现状每次查询都走 `lib/ledger.js:readAll()` 全量读账（E3 1,338 行已 9.9 ms / search 11.5 ms），
 *   到三年（≈347 万行 / 3.19 GB）就是每次查询几十秒。索引把"查哪一天"从全库缩到 1 个分片，
 *   把"取哪一行"缩到一次 `read(offset, bytes)`。
 *
 * @why 为什么分片键是**台账日**（occurrence day，= 台账行 `ts` 的日期）而不是 code 前 8 位：
 *   编码日期段是**会话开始日**（`lib/encoder.js:9-16`），台账日文件按 `ts` 落（`lib/ledger.js:1581-1590`）。
 *   两者**并不相同**：实测 E3 库 1,338 行里 1,320 行的编码日 ≠ 所在台账日；更极端的证据是
 *   E3 只有 1 个会话（code=20260924…），却横跨 45 天、落在 37 个台账日文件里。
 *   所以"按日分片"必须与 `ledger/YYYY-MM-DD.jsonl` 一一对应，否则 C26「索引条数＝台账行数（同天）」
 *   无法成立、按时间范围查也会漏（长会话的轮次会被塞进开始日那一个巨大分片）。
 *   代价：按 code 精确查需要从 `code 日期` 起向后扫分片（实测 E3 全库 37 片共 177 KB，扫完 <2 ms；
 *   3 年最坏 ≈402 MB——"O(1) 定位"留到 re1 用 ts 或 code→日 辅助映射补，见报告"未做/存疑"）。
 *
 * @why 行格式只有 4 个字段（+ 极少数稀疏 `t`）：
 *   `{"c":"<32位code>","d":"<43位base64url>","o":<台账行字节偏移>,"n":<台账行字节数>}`
 *   - `c` code（主键；sid 短 ID/轮次序号可从 code 解析，`t` 仅在 turn≠seq 时才写）
 *   - `d` 原文视图（`完整原文.md`）**整文件 sha256**，用 base64url 存 43 字符（64 hex 要 64 字符，
 *     21 B 的差就是 C36「索引≤台账 15%」的生死线）。解码即台账行的 `docFileSha256`。
 *   - `o`/`n` 该台账行在**同一天台账日文件**里的字节区间（行首偏移 / 行字节数，不含行尾 `\n`）。
 *     这是"指针"：`read(ledger/YYYY-MM-DD.jsonl, o, n)` 拿到的字节 == 台账行原文，
 *     台账行里再带 `doc`/`docFileSha256`，第二次跳就到原文视图（扩容意见 §4.1"两次跳"）。
 *   - 若无法确定偏移（台账文件名不合规、只能按 ts 猜日）→ `o=null,n=null` 显式写并计数，
 *     绝不静默补一个会指错的偏移。
 *
 * @why 写入纪律：
 *   - 只写 `<root>/ledger/.index/`：分片 `idx-YYYYMMDD.jsonl`（>4 MiB 时切 `idx-YYYYMMDD-01.jsonl`）、
 *     状态 `.idx-state.json`；tmp 写 + `fs.renameSync` 原子发布；内容未变的分片**不重写**。
 *   - 不写台账、不碰原文、不 repair 尾巴（`readAll` 的 repairTornTail 在这里一律不做）。
 *
 * @depends node:fs、node:path、node:crypto、../lib/ledger.js（isLedgerRow/ledgerDir）、
 *          ../lib/encoder.js（parseCode/normalizeSessionId/isValidCode）、../lib/original.js（originalRelPath）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isLedgerRow, ledgerDir } from '../lib/ledger.js';
import { isValidCode, parseCode, normalizeSessionId } from '../lib/encoder.js';
import { originalRelPath } from '../lib/original.js';

/** 索引格式版本（写进 `.idx-state.json`；改行格式必须改它）。 */
export const INDEX_FORMAT = 'dsh-pointerindex/1';
/** 索引目录名（在 `<root>/ledger/` 下；点开头 → `readAll` 不会把它当账读）。 */
export const INDEX_DIR_NAME = '.index';
/** 状态文件名。 */
export const INDEX_STATE_FILE = '.idx-state.json';
/** 单分片预算：4 MiB（总纲 §5.9②"单文件 ≤4 MB"，索引也不例外）。 */
export const SHARD_MAX_BYTES = 4 * 1024 * 1024;
/** 台账日文件名（只认这一种；不合规的文件按"无法确定偏移"处理）。 */
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
/** 索引分片文件名：`idx-YYYYMMDD.jsonl` 或切分后的 `idx-YYYYMMDD-01.jsonl`。 */
const SHARD_RE = /^idx-(\d{8})(?:-(\d{2,}))?\.jsonl$/;
/** 64 位小写 hex（台账 docFileSha256 的形状）。 */
const DOC_SHA_RE = /^[0-9a-f]{64}$/;
/** 默认 limit：不传 = 不限。 */
const NO_LIMIT = Number.POSITIVE_INFINITY;

// ============================================================================
// 一、小工具
// ============================================================================

function fail(message) {
  const e = new Error(`pointerindex: ${message}`);
  e.code = 'EPOINTERINDEX';
  throw e;
}

/** 校验并规范化 root；不存在/不是目录 → 抛（CLI 按 2 退出）。 */
function requireRoot(root) {
  if (typeof root !== 'string' || !root.trim()) fail('缺少 root');
  const abs = path.resolve(root);
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st || !st.isDirectory()) fail('root 不是已存在的目录: ' + abs);
  return abs;
}

/** 索引目录绝对路径。 */
export function indexDir(root) {
  return path.join(root, 'ledger', INDEX_DIR_NAME);
}

/** 状态文件绝对路径。 */
export function indexStatePath(root) {
  return path.join(indexDir(root), INDEX_STATE_FILE);
}

/** `20261113` → `2026-11-13`；非法返回 ''。 */
export function ymdToISO(ymd) {
  if (typeof ymd !== 'string' || !/^\d{8}$/.test(ymd)) return '';
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** 接受 `YYYYMMDD` / `YYYY-MM-DD` → 返回 `YYYYMMDD`；非法抛。 */
export function normalizeYmd(v) {
  if (typeof v !== 'string' || !v.trim()) fail('日期参数为空');
  const s = v.trim();
  const compact = /^\d{8}$/.test(s) ? s : (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '') : '');
  if (!compact || !ymdToISO(compact)) fail('日期不合法（要 YYYYMMDD 或 YYYY-MM-DD）: ' + s);
  return compact;
}

/**
 * 解析 range：`{from?,to?}` 或 `"YYYYMMDD..YYYYMMDD"` / `"YYYY-MM-DD..YYYY-MM-DD"`。
 * @returns {{fromYmd:string,toYmd:string}|null} 两端都可空（'' = 不限）
 */
export function parseRange(range) {
  if (range == null || range === '') return null;
  let from = '';
  let to = '';
  if (typeof range === 'string') {
    const parts = range.split('..');
    if (parts.length !== 2) fail('range 要写成 from..to（如 20261001..20261031）');
    from = parts[0] ? normalizeYmd(parts[0]) : '';
    to = parts[1] ? normalizeYmd(parts[1]) : '';
  } else if (typeof range === 'object') {
    if (range.from) from = normalizeYmd(String(range.from));
    if (range.to) to = normalizeYmd(String(range.to));
  } else {
    fail('range 类型不支持');
  }
  if (from && to && from > to) fail(`range 起止颠倒: ${from} > ${to}`);
  if (!from && !to) fail('range 两端不能都为空');
  return { fromYmd: from, toYmd: to };
}

/** 64-hex → base64url（43 字符）；非法返回 ''。 */
export function docShaToField(hex) {
  if (typeof hex !== 'string' || !DOC_SHA_RE.test(hex)) return '';
  return Buffer.from(hex, 'hex').toString('base64url');
}

/** base64url（43 字符）→ 64-hex；非法返回 ''。 */
export function docShaFromField(field) {
  if (typeof field !== 'string' || field.length !== 43) return '';
  let buf = null;
  try { buf = Buffer.from(field, 'base64url'); } catch { return ''; }
  if (!buf || buf.length !== 32) return '';
  return buf.toString('hex');
}

/** sha256(整文件 bytes) → 64-hex。 */
export function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** 编码行（字段顺序固定：c,d,o,n[,t] —— 保证同内容同字节，重建可比对/幂等）。 */
function encodeIndexRow({ code, docShaField, offset, bytes, turn }) {
  const row = { c: code, d: docShaField, o: offset, n: bytes };
  if (turn != null) row.t = turn;
  return JSON.stringify(row);
}

/** 解码/校验一行索引 → `{ok:true,row}` | `{ok:false,error}`。 */
function decodeIndexRow(line) {
  let o;
  try { o = JSON.parse(line); } catch { return { ok: false, error: 'bad-json' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'not-object' };
  if (typeof o.c !== 'string' || !isValidCode(o.c)) return { ok: false, error: 'bad-code' };
  if (!(o.d === null || docShaFromField(o.d) !== '')) return { ok: false, error: 'bad-doc-sha' };
  const okOffset = o.o === null || (Number.isInteger(o.o) && o.o >= 0);
  const okBytes = o.n === null || (Number.isInteger(o.n) && o.n >= 0);
  if (!okOffset || !okBytes) return { ok: false, error: 'bad-pointer' };
  if (o.t != null && !(Number.isInteger(o.t) && o.t >= 0)) return { ok: false, error: 'bad-turn' };
  return {
    ok: true,
    row: {
      c: o.c,
      d: o.d,
      o: o.o,
      n: o.n,
      t: o.t == null ? null : o.t,
      docShaHex: o.d ? docShaFromField(o.d) : '',
    },
  };
}

/** code 的会话内序号（= 正常情况下的 turn；turn 不同时构建会写稀疏 `t`）。 */
function seqOfCode(code) {
  const p = parseCode(code);
  return p ? p.seq : null;
}

/** 原子写：tmp + fsync + rename（Windows 上 rename 覆盖是 ReplaceExisting 语义）。 */
function writeFileAtomic(abs, buf) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, abs);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw e;
  }
}

// ============================================================================
// 二、台账扫描（只读；带字节偏移 —— readAll 不给偏移，所以自己扫）
// ============================================================================

/**
 * 扫一个台账日文件，返回**合法账行**及其字节位置。
 *
 * @returns {{file:string, fileDay:string, byteLength:number, rows:Array, badLines:Array,
 *            nonLedgerRows:Array, tornTails:number, tailNoNewline:boolean}}
 *   rows[] = {offset, bytes, code, record, raw}（offset 按 UTF-8 字节计，行尾 `\n` 不算进 bytes）
 *
 * @why 必须自己扫而不是复用 readAll：readAll 只给 parsed records，**不给 offset/bytes**；
 *      而指针索引的全部价值就在这两个数。偏移口径与 readAll 的坏行留痕完全一致
 *      （`lib/ledger.js:916-918`：行首绝对字节偏移；行尾 `\n` 算 1 字节、不算进行字节数）。
 */
function scanLedgerDayFile(root, name) {
  const abs = path.join(root, 'ledger', name);
  const buf = fs.readFileSync(abs);
  const m = DAY_FILE_RE.exec(name);
  const fileDay = m ? `${m[1]}${m[2]}${m[3]}` : '';
  const out = {
    file: name,
    fileDay,
    byteLength: buf.length,
    rows: [],
    badLines: [],
    nonLedgerRows: [],
    tornTails: 0,
    tailNoNewline: false,
  };
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const complete = nl !== -1;
    const end = complete ? nl : buf.length;
    const offset = pos;
    const bytes = end - offset;
    pos = complete ? end + 1 : buf.length;
    if (bytes === 0) continue; // 空行（readAll 也跳过）
    const raw = buf.toString('utf8', offset, end);
    if (!raw.trim()) continue; // 纯空白行（readAll 也跳过）
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) {
      if (!complete) {
        // 末行无换行且解析不了 = "崩溃撕裂尾巴"的典型形状。**索引层不修**（readAll 才修），
        // 只如实计数 + 让 stat/build 报 problem：索引里绝不能插一条猜出来的行。
        out.tornTails++;
      } else {
        out.badLines.push({ offset, bytes, error: String((e && e.message) || e).slice(0, 160) });
      }
      continue;
    }
    if (!complete) out.tailNoNewline = true; // 行是完整的 JSON 但文件没尾换行：可索引，但要点出来
    if (!isLedgerRow(rec)) {
      out.nonLedgerRows.push({ offset, bytes, code: rec && typeof rec.code === 'string' ? rec.code : '' });
      continue;
    }
    out.rows.push({ offset, bytes, code: rec.code, record: rec, raw });
  }
  return out;
}

/** 把扫描异常变成 problems[]（build/stat 共用同一种 kind）。 */
function ledgerScanProblems(scan, problems) {
  for (const b of scan.badLines) {
    problems.push({ kind: 'ledger-bad-line', file: scan.file, offset: b.offset, bytes: b.bytes, error: b.error });
  }
  for (const n of scan.nonLedgerRows) {
    problems.push({ kind: 'ledger-non-ledger-row', file: scan.file, offset: n.offset, bytes: n.bytes, code: n.code });
  }
  if (scan.tornTails > 0) problems.push({ kind: 'ledger-torn-tail', file: scan.file, count: scan.tornTails });
  if (scan.tailNoNewline) problems.push({ kind: 'ledger-tail-no-newline', file: scan.file });
}

// ============================================================================
// 三、索引分片清单 / 读取
// ============================================================================

/**
 * 列 `.index/` 下的分片（按 day、part 排序）+ 认不出的杂项文件。
 * @returns {{dirExists:boolean, dir:string, files:Array, stray:string[], stateFile:string}}
 */
export function listIndexShardFiles(root) {
  const dir = indexDir(root);
  const out = { dirExists: false, dir, files: [], stray: [], stateFile: indexStatePath(root) };
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  out.dirExists = true;
  for (const name of names) {
    const m = SHARD_RE.exec(name);
    if (m) {
      const abs = path.join(dir, name);
      let bytes = 0;
      try { bytes = fs.statSync(abs).size; } catch { bytes = 0; }
      out.files.push({ name, abs, day: m[1], part: m[2] ? Number(m[2]) : 1, bytes });
      continue;
    }
    if (name === INDEX_STATE_FILE) continue;
    out.stray.push(name);
  }
  out.files.sort((a, b) => (a.day === b.day ? a.part - b.part || (a.name < b.name ? -1 : 1) : (a.day < b.day ? -1 : 1)));
  out.stray.sort();
  return out;
}

/** day → 该日分片数组（part 升序）。 */
function groupShardDays(files) {
  const map = new Map();
  for (const f of files) {
    if (!map.has(f.day)) map.set(f.day, []);
    map.get(f.day).push(f);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.part - b.part || (a.name < b.name ? -1 : 1));
  return map;
}

/** 读状态文件（不存在/坏都返回 null；stat 会把"坏"当 problem）。 */
export function readIndexState(root) {
  const p = indexStatePath(root);
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const o = JSON.parse(txt);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

// ============================================================================
// 四、构建索引
// ============================================================================

/**
 * 从台账重建索引（或 `sinceYmd` 指定只重建 ≥ 该日的日分片）。
 *
 * ★ 0.9.4-re1（C28）：默认先试"只读新增尾"的增量同步（`mode:'sync'`）—— 台账相对上次索引
 *   只在**最后一个台账日文件尾部**追加了行时（tick 的常态），整读全部台账纯属浪费
 *   （C28 实测读放大 12.8×）。证明不了"只尾部追加"就照旧全量重建（`mode:'rebuild'`）。
 *
 * @param {{
 *   root:string, sinceYmd?:string, shardMaxBytes?:number,
 *   rows?:Array<object>,     // 可选：调用方已知的新写入行，用于把"尾部追加"判定钉死
 *   autoSync?:boolean        // 默认 true；false = 强制全量重建（syncIndex 回退时用，防递归）
 * }} opts
 * @returns {{
 *   ok:boolean, indexDir:string, mode:'sync'|'rebuild', shards:number, rows:number, bytes:number,
 *   bytesPerRow:number, byDay:Object, offsetNull:number, docShaNull:number,
 *   written:number, unchanged:number, removed:number,
 *   ledger:{files:number,rows:number,bytes:number,badLines:number,
 *           nonLedgerRows:number,tornTails:number},
 *   sinceYmd:string, problems:Array, ms:number, state:object,
 *   added?:number, syncedDay?:string, syncFallback?:string
 * }}
 *
 * @why 一次只读一个台账日文件、只产一个日分片（峰值 ≈ 一日台账 + 一个分片缓冲），
 *      这样 3 年 3.19 GB 台账重建也是流式的，不需要把索引整表塞进内存。
 * @why 内容没变的分片**不重写**（只是派生数据，重写毫无收益，还会放大 Windows 杀软扫描）。
 */
export function buildIndex(opts = {}) {
  const t0 = Date.now();
  const root = requireRoot(opts.root);
  const ledDir = ledgerDir(root);
  let ledStat = null;
  try { ledStat = fs.statSync(ledDir); } catch { ledStat = null; }
  if (!ledStat || !ledStat.isDirectory()) fail('账库缺少 ledger/ 目录（root 是不是指错了？）: ' + root);
  const idxDir = indexDir(root);
  fs.mkdirSync(idxDir, { recursive: true });

  const sinceYmd = opts.sinceYmd ? normalizeYmd(opts.sinceYmd) : '';
  const shardMaxBytes = Number.isInteger(opts.shardMaxBytes) && opts.shardMaxBytes > 0
    ? opts.shardMaxBytes : SHARD_MAX_BYTES;
  const problems = [];
  const push = (p) => { if (problems.length < 200) problems.push(p); };

  // ★ 0.9.4-re1（C28）：先试增量同步。只有"台账尾部新增"这一种可证明的形态才走 sync；
  //   其余（索引缺失/分片缺失/多日增长/历史补写/半行/坏行…）一律落到下面的全量重建。
  let syncFallback = '';
  if (!sinceYmd && opts.autoSync !== false) {
    const stateForSync = readIndexState(root);
    const listForSync = listIndexShardFiles(root);
    const planned = (stateForSync && stateForSync.format === INDEX_FORMAT && listForSync.dirExists)
      ? planTailSync({ root, state: stateForSync, list: listForSync, rows: opts.rows })
      : { ok: false, reason: stateForSync ? 'index-missing' : 'state-missing' };
    if (planned.ok && planned.mode === 'sync') {
      const synced = applyTailSync({ root, idxDir, planned, shardMaxBytes });
      return buildResultFromSync({ root, idxDir, synced, ms: Date.now() - t0 });
    }
    syncFallback = planned.reason || (planned.ok ? 'no-new-rows' : 'fallback');
  }

  const entries = fs.readdirSync(ledDir)
    .filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))
    .sort();
  const standard = [];
  const odd = [];
  for (const name of entries) (DAY_FILE_RE.test(name) ? standard : odd).push(name);

  const byDay = {};
  const ledger = { files: 0, rows: 0, bytes: 0, badLines: 0, nonLedgerRows: 0, tornTails: 0 };
  let offsetNull = 0;
  let docShaNull = 0;
  let written = 0;
  let unchanged = 0;
  let removed = 0;
  const processedDays = new Set();
  /** 非标准名台账文件的行：只能按 ts 猜日 + 偏移写 null（罕见，但必须显式，不许静默）。 */
  const supplement = new Map(); // day -> [line,...]

  // ---- 第一遍：非标准名文件（示例：手工改名/老库）→ 只做"无偏移"补充行 ----
  for (const name of odd) {
    const scan = scanLedgerDayFile(root, name);
    ledgerScanProblems(scan, problems);
    ledger.files++;
    ledger.bytes += scan.byteLength;
    ledger.rows += scan.rows.length;
    ledger.badLines += scan.badLines.length;
    ledger.nonLedgerRows += scan.nonLedgerRows.length;
    ledger.tornTails += scan.tornTails;
    push({ kind: 'odd-ledger-file', file: name, rows: scan.rows.length });
    for (const r of scan.rows) {
      const day = typeof r.record.ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.record.ts)
        ? r.record.ts.slice(0, 10).replace(/-/g, '')
        : '';
      if (!day) { push({ kind: 'unindexed-ledger-row', file: name, offset: r.offset, code: r.code, reason: 'no-ts' }); continue; }
      if (sinceYmd && day < sinceYmd) continue;
      const docSha = resolveDocSha(r.record, root, push, () => { docShaNull++; });
      const line = encodeIndexRow({
        code: r.code, docShaField: docSha, offset: null, bytes: null, turn: turnFieldOf(r.record),
      });
      if (!supplement.has(day)) supplement.set(day, []);
      supplement.get(day).push(line);
      offsetNull++;
    }
  }

  // ---- 第二遍：标准日文件 → 日分片 ----
  for (const name of standard) {
    const scan = scanLedgerDayFile(root, name);
    ledgerScanProblems(scan, problems);
    ledger.files++;
    ledger.bytes += scan.byteLength;
    ledger.rows += scan.rows.length;
    ledger.badLines += scan.badLines.length;
    ledger.nonLedgerRows += scan.nonLedgerRows.length;
    ledger.tornTails += scan.tornTails;
    const day = scan.fileDay;
    if (sinceYmd && day < sinceYmd) continue; // 旧分片原样保留（增量重建语义）

    const lines = [];
    let dayOffsetNull = 0;
    let dayDocShaNull = 0;
    for (const r of scan.rows) {
      const docSha = resolveDocSha(r.record, root, push, () => { docShaNull++; dayDocShaNull++; });
      lines.push(encodeIndexRow({
        code: r.code,
        docShaField: docSha,
        offset: r.offset,
        bytes: r.bytes,
        turn: turnFieldOf(r.record),
      }));
    }
    if (supplement.has(day)) {
      const supp = supplement.get(day);
      for (const line of supp) {
        const dec = decodeIndexRow(line);
        if (dec.ok) { dayOffsetNull++; if (dec.row.d === null) dayDocShaNull++; }
      }
      lines.push(...supp);
      supplement.delete(day);
    }
    const res = writeDayShards({ root, idxDir, day, lines, shardMaxBytes, push });
    written += res.written;
    unchanged += res.unchanged;
    removed += res.removed;
    processedDays.add(day);
    byDay[day] = {
      rows: lines.length,
      bytes: res.bytes,
      shards: res.files.length,
      split: res.files.length > 1,
      offsetNull: dayOffsetNull,
      docShaNull: dayDocShaNull,
      ledgerRows: scan.rows.length,
      // ★ 0.9.4-re1（C28）：逐日水位 —— 下次 syncIndex 只凭它 + 分片末行就能证明"只尾部追加"
      ledgerBytes: scan.byteLength,
    };
  }

  // ---- 第三遍：只有补充行、没有标准日文件的 day（罕见） ----
  for (const [day, lines] of [...supplement.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (sinceYmd && day < sinceYmd) continue;
    const res = writeDayShards({ root, idxDir, day, lines, shardMaxBytes, push });
    written += res.written;
    unchanged += res.unchanged;
    removed += res.removed;
    processedDays.add(day);
    byDay[day] = {
      rows: lines.length,
      bytes: res.bytes,
      shards: res.files.length,
      split: res.files.length > 1,
      offsetNull: lines.length,
      docShaNull: lines.reduce((a, line) => { const d = decodeIndexRow(line); return a + (d.ok && d.row.d === null ? 1 : 0); }, 0),
      ledgerRows: 0,
      ledgerBytes: 0, // 没有台账日文件：无法按日追加（sync 会因"缺日文件"回退重建）
    };
  }

  // ---- 清理陈旧分片（只删 `.index/idx-*.jsonl`；绝不删账/原文） ----
  const list = listIndexShardFiles(root);
  const staleDays = new Set(); // since 增量下"整日已无台账"的日：状态里也必须删掉，否则 stat 会误报
  for (const f of list.files) {
    if (processedDays.has(f.day)) continue; // 本次处理过的日：writeDayShards 已清理旧 part
    if (sinceYmd && f.day < sinceYmd) continue; // 增量模式：旧日分片不动
    try { fs.unlinkSync(f.abs); removed++; staleDays.add(f.day); } catch (e) { push({ kind: 'stale-shard-unlink-failed', file: f.name, error: String(e && e.message || e) }); }
  }
  for (const name of list.stray) {
    // .tmp-* 是上次崩溃残留；其它杂项文件也点出来（.index 是本工具独占目录）
    push({ kind: 'unexpected-index-file', file: name });
  }

  // ---- 状态文件（used by stat 做"删分片/增删行"的交叉核对） ----
  const prevState = readIndexState(root);
  const daysMap = {};
  if (sinceYmd && prevState && prevState.days && typeof prevState.days === 'object') {
    for (const [d, v] of Object.entries(prevState.days)) {
      if (v && !processedDays.has(d) && !staleDays.has(d)) daysMap[d] = v;
    }
  }
  for (const [d, v] of Object.entries(byDay)) {
    daysMap[d] = {
      rows: v.rows,
      offsetNull: v.offsetNull,
      docShaNull: v.docShaNull,
      // ★ 0.9.4-re1（C28）：逐日水位（= 该台账日文件在本次索引时的字节数）。
      //   0.9.4-snap 的旧状态没有这个字段 → syncIndex 会用当日分片末行反推一次并补齐。
      ...(Number.isInteger(v.ledgerBytes) ? { ledgerBytes: v.ledgerBytes } : {}),
    };
  }
  // 状态里的 bytes/shards 按**实际落盘文件**重算，避免增量合并后数字漂移
  let shardCount = 0;
  let shardBytes = 0;
  const after = listIndexShardFiles(root);
  for (const f of after.files) { shardCount++; shardBytes += f.bytes; }
  const dayNames = Object.keys(daysMap).sort();
  const sumDays = (key) => Object.values(daysMap).reduce((a, v) => a + (Number(v && v[key]) || 0), 0);
  const state = {
    format: INDEX_FORMAT,
    shardBy: 'ledger-day',
    builtAt: new Date().toISOString(),
    sinceYmd: sinceYmd || '',
    rows: sumDays('rows'),
    shards: shardCount,
    bytes: shardBytes,
    offsetNull: sumDays('offsetNull'),
    docShaNull: sumDays('docShaNull'),
    days: daysMap,
    ledger: { ...ledger },
    minDay: dayNames.length ? dayNames[0] : '',
    maxDay: dayNames.length ? dayNames[dayNames.length - 1] : '',
  };
  writeFileAtomic(indexStatePath(root), Buffer.from(JSON.stringify(state), 'utf8'));

  const rowsTotal = state.rows;
  const bytesTotal = shardBytes;
  return {
    ok: problems.length === 0,
    root,
    indexDir: idxDir,
    mode: 'rebuild',
    shards: shardCount,
    rows: rowsTotal,
    bytes: bytesTotal,
    bytesPerRow: rowsTotal ? Number((bytesTotal / rowsTotal).toFixed(2)) : 0,
    byDay,
    offsetNull,
    docShaNull,
    written,
    unchanged,
    removed,
    ledger,
    sinceYmd,
    problems,
    ms: Date.now() - t0,
    state,
    ...(syncFallback ? { syncFallback } : {}),
  };
}

/** 稀疏 turn 字段：当台账 `turn` 与 code 会话内序号不一致时才写（保持一致 4 字段的瘦行）。 */
function turnFieldOf(record = {}) {
  const p = parseCode(record.code);
  if (!p) return null;
  const t = Number.isInteger(record.turn) ? record.turn : null;
  if (t == null || t === p.seq) return null;
  return t;
}

/**
 * 取原文视图整文件 sha256（base64url 字段）。
 * 正常路径：直接抄台账行的 `docFileSha256`（写盘时由 `lib/original.js` 对完整 .md 全文件计算，P1-1），
 * **构建不重读视图**（否则三年 347 万个视图要全读一遍）；老行缺该字段时兜底读一次视图。
 */
function resolveDocSha(record, root, push, onNull) {
  const raw = typeof record.docFileSha256 === 'string' ? record.docFileSha256.trim().toLowerCase() : '';
  if (DOC_SHA_RE.test(raw)) return docShaToField(raw);
  let rel = typeof record.doc === 'string' ? record.doc : '';
  if (!rel) {
    const p = parseCode(record.code);
    if (p) rel = originalRelPath(Number(p.date.slice(0, 4)), Number(p.date.slice(4, 6)), record.code);
  }
  if (rel) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    try {
      const hex = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      return docShaToField(hex);
    } catch { /* 落到下面报 problem */ }
  }
  onNull();
  push({ kind: 'doc-sha-unresolved', code: record.code, doc: rel || '' });
  return null;
}

/**
 * 把一天的索引行写成 1 个（或超 4 MiB 时 N 个）分片，原子发布；内容相同则不重写。
 * @returns {{files:Array<{name,bytes,rows}>, bytes:number, written:number, unchanged:number, removed:number}}
 */
function writeDayShards({ root, idxDir, day, lines, shardMaxBytes, push }) {
  // ① 切块：单行本身超预算时独占一块并报 problem（预算破坏必须可见）
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const line of lines) {
    const b = Buffer.byteLength(line, 'utf8') + 1;
    if (b > shardMaxBytes) push({ kind: 'row-exceeds-shard-limit', day, bytes: b, limit: shardMaxBytes });
    if (cur.length > 0 && curBytes + b > shardMaxBytes) { chunks.push(cur); cur = []; curBytes = 0; }
    cur.push(line);
    curBytes += b;
  }
  if (cur.length > 0 || chunks.length === 0) chunks.push(cur); // 空日也落一个 0 字节分片（"这天索引过"）

  const wanted = [];
  for (let i = 0; i < chunks.length; i++) {
    const name = chunks.length === 1
      ? `idx-${day}.jsonl`
      : `idx-${day}-${String(i + 1).padStart(2, '0')}.jsonl`;
    const buf = chunks[i].length ? Buffer.from(chunks[i].join('\n') + '\n', 'utf8') : Buffer.alloc(0);
    wanted.push({ name, abs: path.join(idxDir, name), buf, bytes: buf.length, rows: chunks[i].length });
  }

  let written = 0;
  let unchanged = 0;
  for (const f of wanted) {
    let same = false;
    try {
      const old = fs.readFileSync(f.abs);
      same = old.length === f.buf.length && old.equals(f.buf);
    } catch { same = false; }
    if (same) { unchanged++; continue; }
    writeFileAtomic(f.abs, f.buf);
    written++;
  }

  // ② 清理该日多余的旧 part（只碰本工具命名空间）
  let removed = 0;
  const wantNames = new Set(wanted.map((f) => f.name));
  let names = [];
  try { names = fs.readdirSync(idxDir); } catch { names = []; }
  for (const name of names) {
    const m = SHARD_RE.exec(name);
    if (!m || m[1] !== day) continue;
    if (wantNames.has(name)) continue;
    try { fs.unlinkSync(path.join(idxDir, name)); removed++; } catch { /* 忽略 */ }
  }

  return {
    files: wanted.map((f) => ({ name: f.name, bytes: f.bytes, rows: f.rows })),
    bytes: wanted.reduce((a, f) => a + f.bytes, 0),
    written,
    unchanged,
    removed,
  };
}

// ============================================================================
// 四·五、增量同步（syncIndex：只读"新增尾"，不重扫历史台账）
// ============================================================================
//
// @why 为什么不能每 tick 都跑 buildIndex：buildIndex 是"全量重建"语义 —— 它要把**全部**
//      台账日文件整读一遍（只为拿 offset/bytes）。C28 实测追加 1 行时读放大 12.8×
//      （11,665 B 读 / 911 B 新增），超过计划 E4-2 的"≤新行字节×3"阈值。
//      真实 tick 每轮只多出 0~N 行，且必然落在**最后一个台账日文件的尾部**。
//
// @why 判定必须"能证明"才走 sync：索引是派生物，一旦把"历史补写/乱序/其他日增长"误当成
//      "尾部追加"，索引就会永久指错（比慢更糟）。证明只依赖两样东西：
//        ① `.idx-state.json` 的逐日水位 `days[day].ledgerBytes`（上次索引时的台账日文件大小；
//           0.9.4-snap 的旧状态没有该字段 → 用当日分片末行的 `o+n` 反推一次，并顺手补齐）；
//        ② 当日分片末行的位置 `o+n` —— 新增行必须从它后面**紧接着**开始（中间不许有缝/乱序）。
//      任一条证明不了 → 直接回退 `buildIndex()`（结果里记 `mode:'rebuild'`），绝不猜。
//
// @why 读多少：只读"当日分片末行之后"到 EOF 的几行新字节 + 至多 2 个探路字节；
//      历史台账日文件只 `stat` 大小，不 `readFileSync`（C28 的 fs hook 也因此看得到"不重扫"）。

/** 台账行 → 台账日（与 lib/ledger.js:appendTurn 同口径：取 ts 前 10 位，不做时区换算）。 */
function ledgerDayOfRecord(record) {
  const ts = record && typeof record.ts === 'string' ? record.ts : '';
  return /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10).replace(/-/g, '') : '';
}

/** 只读 1 字节（探水位/末行后的换行符）；读不到返回 -1。不整读文件。 */
function readByteAt(abs, pos) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.allocUnsafe(1);
    const n = fs.readSync(fd, buf, 0, 1, pos);
    return n === 1 ? buf[0] : -1;
  } catch {
    return -1;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/**
 * 从 `start` 读到 EOF（只用于"新增尾"；分块读，峰值 = 新增字节数）。
 * @returns {{buf:Buffer, bytesRead:number, size:number}}
 */
function readFileFrom(abs, start) {
  const empty = { buf: Buffer.alloc(0), bytesRead: 0, size: Number.isInteger(start) ? start : 0 };
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const size = fs.fstatSync(fd).size;
    empty.size = size;
    if (!(start < size)) return empty;
    const chunks = [];
    let bytesRead = 0;
    let pos = start;
    const CHUNK = 1024 * 1024;
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      if (got === 0) break;
      chunks.push(buf.subarray(0, got));
      bytesRead += got;
      pos += got;
    }
    return {
      buf: chunks.length === 0 ? Buffer.alloc(0) : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)),
      bytesRead,
      size,
    };
  } catch {
    return empty;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/**
 * 读某日分片的全部行（按 part 升序）；读不到/有任何坏行 → null（调用方回退重建）。
 * @returns {{lines:string[], rows:Array<{line,o,n,c}>, files:number, bytes:number}|null}
 */
function readDayShardRows(parts) {
  const out = { lines: [], rows: [], files: parts.length, bytes: 0 };
  for (const f of parts) {
    let txt = '';
    try { txt = fs.readFileSync(f.abs, 'utf8'); } catch { return null; }
    out.bytes += f.bytes;
    let pos = 0;
    while (pos < txt.length) {
      const nl = txt.indexOf('\n', pos);
      const end = nl === -1 ? txt.length : nl;
      const line = txt.slice(pos, end);
      pos = nl === -1 ? txt.length : nl + 1;
      if (!line.trim()) continue;
      const dec = decodeIndexRow(line);
      if (!dec.ok) return null;
      out.lines.push(line);
      out.rows.push({ line, c: dec.row.c, o: dec.row.o, n: dec.row.n });
    }
  }
  return out;
}

/** 由分片末行反推"该日台账文件被索引到的字节位置"（旧状态没有 `ledgerBytes` 时用）。 */
function lastShardRowEnd(parts) {
  const shard = readDayShardRows(parts);
  if (!shard || shard.rows.length === 0) return null;
  const last = shard.rows[shard.rows.length - 1];
  if (!Number.isInteger(last.o) || !Number.isInteger(last.n)) return null;
  return last.o + last.n;
}

/**
 * 判定"台账是否只是在当日文件尾部追加"。
 *
 * @returns 失败 `{ok:false, reason}`；成功 `{ok:true, mode:'sync', bytesRead, plan:{...}}`
 *          或 `{ok:true, mode:'skip', reason, bytesRead, snapshot, legacy}`（没有新完整行）。
 */
function planTailSync({ root, state, list, rows }) {
  let bytesRead = 0;
  const ledDir = ledgerDir(root);
  let names = [];
  try { names = fs.readdirSync(ledDir); } catch { return { ok: false, reason: 'ledger-unreadable' }; }
  const ledgerNames = names.filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  const standard = [];
  const odd = [];
  for (const n of ledgerNames) (DAY_FILE_RE.test(n) ? standard : odd).push(n);
  if (standard.length === 0) return { ok: false, reason: 'no-ledger-day-files' };
  // 非标准名台账文件的行无法用"日文件指针"定位（buildIndex 会写 o=null 补充行），sync 一律回退
  if (odd.length > 0) return { ok: false, reason: 'odd-ledger-files:' + odd.slice(0, 3).join('|') };
  const sdays = state && state.days && typeof state.days === 'object' && !Array.isArray(state.days)
    ? state.days : null;
  if (!sdays) return { ok: false, reason: 'state-days-invalid' };

  const dayGroups = groupShardDays(list.files);
  const sizeByDay = new Map();
  const fileByDay = new Map();
  for (const name of standard) {
    const m = DAY_FILE_RE.exec(name);
    const day = `${m[1]}${m[2]}${m[3]}`;
    const abs = path.join(ledDir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { return { ok: false, reason: 'ledger-stat-failed:' + name }; }
    sizeByDay.set(day, st.size);
    fileByDay.set(day, abs);
  }
  const stateDayNames = Object.keys(sdays).sort();
  for (const day of sizeByDay.keys()) {
    if (!sdays[day]) return { ok: false, reason: 'ledger-day-not-indexed:' + day };
  }
  for (const day of stateDayNames) {
    if (!sizeByDay.has(day)) return { ok: false, reason: 'indexed-day-file-missing:' + day };
    if (!dayGroups.has(day)) return { ok: false, reason: 'day-shard-missing:' + day };
  }
  // 反向：分片里有、状态/台账里没有的"孤儿日"→ 状态已坏，回退重建（重建会清掉陈旧分片）
  for (const day of dayGroups.keys()) {
    if (!sdays[day]) return { ok: false, reason: 'orphan-shard-day:' + day };
  }
  const maxDay = (typeof state.maxDay === 'string' && sdays[state.maxDay])
    ? state.maxDay
    : stateDayNames[stateDayNames.length - 1];

  // 逐日水位：新状态直接用；旧状态（0.9.4-snap）没有 ledgerBytes → 由分片末行反推一次
  let legacy = false;
  const watermarks = new Map();
  for (const day of stateDayNames) {
    const sd = sdays[day] || {};
    let wm = Number.isInteger(sd.ledgerBytes) && sd.ledgerBytes >= 0 ? sd.ledgerBytes : null;
    if (wm == null) {
      legacy = true;
      const parts = dayGroups.get(day);
      const end = lastShardRowEnd([parts[parts.length - 1]]);
      if (end == null) return { ok: false, reason: 'watermark-underivable:' + day };
      const b = readByteAt(fileByDay.get(day), end);
      bytesRead += 1;
      if (b === -1) return { ok: false, reason: 'watermark-unreadable:' + day };
      wm = b === 0x0a ? end + 1 : end;
    }
    const size = sizeByDay.get(day);
    if (size < wm) return { ok: false, reason: 'ledger-shrunk:' + day };
    watermarks.set(day, wm);
  }

  const snapshot = { stateDayNames, sizeByDay, fileByDay, watermarks, maxDay };
  const grew = stateDayNames.filter((d) => sizeByDay.get(d) > watermarks.get(d));
  if (grew.length === 0) {
    return { ok: true, mode: 'skip', reason: 'no-new-rows', legacy, snapshot, bytesRead };
  }
  if (grew.length > 1) return { ok: false, reason: 'multi-day-growth:' + grew.join('|') };
  const day = grew[0];
  if (day !== maxDay) return { ok: false, reason: 'non-tail-day-growth:' + day };

  // ---- 校验"当日分片 ↔ 台账日文件"在这条尾部边界上仍然一致 ----
  const parts = dayGroups.get(day);
  const shard = readDayShardRows(parts);
  if (!shard) return { ok: false, reason: 'day-shard-corrupt:' + day };
  if (shard.rows.length === 0) return { ok: false, reason: 'day-shard-empty:' + day };
  let prevEnd = -1;
  for (let i = 0; i < shard.rows.length; i++) {
    const r = shard.rows[i];
    if (!Number.isInteger(r.o) || !Number.isInteger(r.n) || r.o < 0 || r.n < 0) {
      return { ok: false, reason: 'day-shard-pointer-null:' + day };
    }
    // 索引行必须与台账行顺序一一对应（行首偏移 = 上一行末尾+1，行尾换行符占 1 字节）
    if (i > 0 && r.o !== prevEnd + 1) return { ok: false, reason: 'day-shard-not-contiguous:' + day };
    prevEnd = r.o + r.n;
  }
  const stateRows = Number((sdays[day] && sdays[day].rows) || 0);
  // 状态里的行数比索引实际还多 = 索引丢行（被改过/删过）→ 不能增量补
  if (!Number.isInteger(stateRows) || stateRows > shard.rows.length) {
    return { ok: false, reason: 'index-rows-lost:' + day };
  }
  const lastEnd = prevEnd;
  const nlByte = readByteAt(fileByDay.get(day), lastEnd);
  bytesRead += 1;
  if (nlByte !== 0x0a) return { ok: false, reason: 'shard-tail-not-newline:' + day };
  const daySize = sizeByDay.get(day);
  const tailStart = lastEnd + 1;
  if (tailStart > daySize) return { ok: false, reason: 'tail-start-beyond-eof:' + day };

  // ---- 只读"新增尾"（历史台账一字节都不读）----
  const tail = readFileFrom(fileByDay.get(day), tailStart);
  bytesRead += tail.bytesRead;
  const newRows = [];
  let incompleteTail = false;
  let pos = 0;
  while (pos < tail.buf.length) {
    const at = tail.buf.indexOf(0x0a, pos);
    if (at === -1) { incompleteTail = pos < tail.buf.length; break; } // 半行留到下一轮（防索引腐烂）
    const raw = tail.buf.toString('utf8', pos, at);
    const offset = tailStart + pos;
    const nbytes = at - pos;
    pos = at + 1;
    if (!raw.trim()) continue;
    let rec = null;
    try { rec = JSON.parse(raw); } catch { return { ok: false, reason: 'tail-bad-json:' + day, bytesRead }; }
    if (!isLedgerRow(rec)) return { ok: false, reason: 'tail-non-ledger-row:' + day, bytesRead };
    newRows.push({ record: rec, code: rec.code, offset, bytes: nbytes });
  }

  // ---- 调用方给的"本 tick 新写行"必须真的落在新增尾里（否则就是乱序/历史补写）----
  const expectRows = Array.isArray(rows) ? rows.filter((r) => r && typeof r.code === 'string') : [];
  if (expectRows.length > 0) {
    const tailCodes = new Set(newRows.map((r) => r.code));
    for (const r of expectRows) {
      const rd = ledgerDayOfRecord(r);
      if (rd !== day) return { ok: false, reason: 'provided-row-day-mismatch:' + (rd || '?'), bytesRead };
      if (!tailCodes.has(r.code)) return { ok: false, reason: 'provided-row-not-at-tail:' + r.code, bytesRead };
    }
  }
  if (newRows.length === 0) {
    return {
      ok: true, mode: 'skip', reason: incompleteTail ? 'half-line-only' : 'already-synced',
      legacy, snapshot, bytesRead,
    };
  }
  return {
    ok: true, mode: 'sync', bytesRead,
    plan: {
      state, day, dayFile: fileByDay.get(day), daySize, watermark: watermarks.get(day), tailStart,
      shard, newRows, incompleteTail, sizeByDay, stateDayNames,
    },
  };
}

/**
 * 执行尾部追加：把新行接到当日分片末尾（必要时按 4 MiB 重切当日分片），原子更新 `.idx-state.json`。
 * 只写 `.index/`；台账/原文一字节不动。
 */
function applyTailSync({ root, idxDir, planned, shardMaxBytes }) {
  const plan = planned.plan;
  const state = plan.state;
  const day = plan.day;
  const shard = plan.shard;
  const sizeByDay = plan.sizeByDay;
  const stateDayNames = plan.stateDayNames;
  const problems = [];
  const push = (p) => { if (problems.length < 200) problems.push(p); };
  let docShaNullAdded = 0;
  const newLines = [];
  for (const r of plan.newRows) {
    const docShaField = resolveDocSha(r.record, root, push, () => { docShaNullAdded++; });
    newLines.push(encodeIndexRow({
      code: r.code, docShaField, offset: r.offset, bytes: r.bytes, turn: turnFieldOf(r.record),
    }));
  }
  // 当日分片重写（只有内容变化的那一片会真的落盘；其它日分片一个字节不碰）
  const written = writeDayShards({
    root, idxDir, day, lines: shard.lines.concat(newLines), shardMaxBytes, push,
  });

  // ---- 状态文件：只更新受影响日 + 总账，天数/字节按实际落盘重算 ----
  const listAfter = listIndexShardFiles(root);
  let shardCount = 0;
  let shardBytes = 0;
  const perDayShard = new Map();
  for (const f of listAfter.files) {
    shardCount++;
    shardBytes += f.bytes;
    const cur = perDayShard.get(f.day) || { bytes: 0, shards: 0 };
    cur.bytes += f.bytes;
    cur.shards++;
    perDayShard.set(f.day, cur);
  }
  const days = {};
  for (const d of stateDayNames) days[d] = { ...(state.days[d] || {}) };
  const prevDay = days[day] || {};
  const last = shard.rows[shard.rows.length - 1];
  days[day] = {
    ...prevDay,
    rows: shard.lines.length + newLines.length,
    offsetNull: Number(prevDay.offsetNull) || 0, // 新增行都带完整指针（o/n 整数），不新增 null
    docShaNull: (Number(prevDay.docShaNull) || 0) + docShaNullAdded,
    ledgerBytes: sizeByDay.get(day),
    lastOffset: last ? last.o : null,
    lastBytes: last ? last.n : null,
    syncedAt: new Date().toISOString(),
  };
  let rowsTotal = 0;
  let offsetNullTotal = 0;
  let docShaNullTotal = 0;
  const dayNames = Object.keys(days).sort();
  for (const d of dayNames) {
    const v = days[d] || {};
    // 旧状态没有逐日水位：本次已反推验证过"恰好等于当前大小"，顺手补齐（只写状态，不动分片）
    if (d !== day) {
      const sz = sizeByDay.get(d);
      if (Number.isInteger(sz) && v.ledgerBytes !== sz) v.ledgerBytes = sz;
    }
    rowsTotal += Number(v.rows) || 0;
    offsetNullTotal += Number(v.offsetNull) || 0;
    docShaNullTotal += Number(v.docShaNull) || 0;
  }
  const ledger = { ...(state.ledger && typeof state.ledger === 'object' ? state.ledger : {}) };
  ledger.files = stateDayNames.length;
  ledger.rows = rowsTotal;
  ledger.bytes = stateDayNames.reduce((a, d) => a + (Number(sizeByDay.get(d)) || 0), 0);
  if (!Number.isInteger(ledger.badLines)) ledger.badLines = 0;
  if (!Number.isInteger(ledger.nonLedgerRows)) ledger.nonLedgerRows = 0;
  if (!Number.isInteger(ledger.tornTails)) ledger.tornTails = 0;
  const nowIso = new Date().toISOString();
  const stateOut = {
    format: INDEX_FORMAT,
    shardBy: 'ledger-day',
    builtAt: nowIso,
    sinceYmd: '',
    rows: rowsTotal,
    shards: shardCount,
    bytes: shardBytes,
    offsetNull: offsetNullTotal,
    docShaNull: docShaNullTotal,
    days,
    ledger,
    minDay: dayNames.length ? dayNames[0] : '',
    maxDay: dayNames.length ? dayNames[dayNames.length - 1] : '',
    lastMode: 'sync',
    lastSyncAt: nowIso,
  };
  writeFileAtomic(indexStatePath(root), Buffer.from(JSON.stringify(stateOut), 'utf8'));

  const byDay = {};
  for (const d of dayNames) {
    const v = days[d] || {};
    const pd = perDayShard.get(d) || { bytes: 0, shards: 0 };
    byDay[d] = {
      rows: Number(v.rows) || 0,
      bytes: pd.bytes,
      shards: pd.shards,
      split: pd.shards > 1,
      offsetNull: Number(v.offsetNull) || 0,
      docShaNull: Number(v.docShaNull) || 0,
      ledgerRows: Number(v.rows) || 0,
    };
  }
  return {
    ok: problems.length === 0,
    problems,
    state: stateOut,
    byDay,
    shards: shardCount,
    rows: rowsTotal,
    bytes: shardBytes,
    bytesPerRow: rowsTotal ? Number((shardBytes / rowsTotal).toFixed(2)) : 0,
    offsetNull: offsetNullTotal,
    docShaNull: docShaNullTotal,
    written: written.written,
    unchanged: written.unchanged,
    removed: written.removed,
    added: newLines.length,
    day,
    addedBytes: plan.newRows.reduce((a, r) => a + r.bytes + 1, 0),
  };
}

/** 无新增行时：把旧状态缺的逐日水位补齐（只写 `.idx-state.json`，分片不动）。 */
function upgradeStateWatermarks({ root, state, snapshot }) {
  if (!snapshot || !Array.isArray(snapshot.stateDayNames)) return false;
  const days = {};
  let changed = false;
  for (const d of Object.keys(state.days || {})) days[d] = { ...state.days[d] };
  for (const d of snapshot.stateDayNames) {
    const sz = snapshot.sizeByDay.get(d);
    if (!Number.isInteger(sz)) continue;
    const v = days[d] || {};
    if (v.ledgerBytes !== sz) { days[d] = { ...v, ledgerBytes: sz }; changed = true; }
  }
  if (!changed) return false;
  writeFileAtomic(
    indexStatePath(root),
    Buffer.from(JSON.stringify({ ...state, days, watermarksAt: new Date().toISOString() }), 'utf8'),
  );
  return true;
}

/** 把"同步成功"的结果整成 buildIndex 同形（CLI/判据/自测共用一套字段）。 */
function buildResultFromSync({ root, idxDir, synced, ms }) {
  return {
    ok: synced.ok,
    root,
    indexDir: idxDir,
    mode: 'sync',
    shards: synced.shards,
    rows: synced.rows,
    bytes: synced.bytes,
    bytesPerRow: synced.bytesPerRow,
    byDay: synced.byDay,
    offsetNull: synced.offsetNull,
    docShaNull: synced.docShaNull,
    written: synced.written,
    unchanged: synced.unchanged,
    removed: synced.removed,
    ledger: { ...synced.state.ledger },
    sinceYmd: '',
    problems: synced.problems,
    ms,
    state: synced.state,
    added: synced.added,
    syncedDay: synced.day,
  };
}

/**
 * 增量同步入口：只读"新增尾"，只追加/重写受影响的那一个日分片。
 *
 * @param {{
 *   root:string,
 *   rows?:Array<object>,      // 本 tick 新写入的台账行（record 形状；给得越准，判定越硬）
 *   shardMaxBytes?:number
 * }} opts
 * @returns {{
 *   mode:'sync'|'rebuild'|'skip', ok:boolean, rows:number, added:number,
 *   bytesRead:number, addedBytes:number, written:number, unchanged:number, removed:number,
 *   reason:string, problems:Array, ms:number, state:object, day?:string
 * }}
 *
 * @why 失败回退 = `buildIndex()`（全量重建，慢但一定对）；判定条件见 planTailSync 注释。
 */
export function syncIndex(opts = {}) {
  const t0 = Date.now();
  const root = requireRoot(opts.root);
  const shardMaxBytes = Number.isInteger(opts.shardMaxBytes) && opts.shardMaxBytes > 0
    ? opts.shardMaxBytes : SHARD_MAX_BYTES;
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const state = readIndexState(root);
  const list = listIndexShardFiles(root);
  let planned;
  if (!list.dirExists) planned = { ok: false, reason: 'index-missing' };
  else if (!state || state.format !== INDEX_FORMAT) planned = { ok: false, reason: 'state-missing-or-invalid' };
  else planned = planTailSync({ root, state, list, rows });

  if (planned.ok && planned.mode === 'sync') {
    const synced = applyTailSync({ root, idxDir: list.dir, planned, shardMaxBytes });
    return {
      mode: 'sync', ok: synced.ok, root,
      rows: synced.rows, added: synced.added,
      written: synced.written, unchanged: synced.unchanged, removed: synced.removed,
      bytesRead: planned.bytesRead, addedBytes: synced.addedBytes,
      shards: synced.shards, bytes: synced.bytes,
      day: planned.plan.day,
      reason: planned.plan.incompleteTail ? 'incomplete-tail-kept' : '',
      problems: synced.problems,
      ms: Date.now() - t0,
      state: synced.state,
    };
  }
  if (planned.ok) {
    // 无新增完整行（空 tick / 只有半行）：不写分片；旧状态顺手补水位字段，免得下轮再反推
    let upgraded = false;
    try { upgraded = upgradeStateWatermarks({ root, state, snapshot: planned.snapshot }); } catch { upgraded = false; }
    const st = readIndexState(root) || state;
    return {
      mode: 'skip', ok: true, root,
      rows: Number(st && st.rows) || 0, added: 0,
      written: 0, unchanged: list.files.length, removed: 0,
      bytesRead: planned.bytesRead || 0, addedBytes: 0,
      reason: planned.reason || 'no-new-rows',
      upgraded,
      problems: [],
      ms: Date.now() - t0,
      state: st,
    };
  }
  // 证明不了"只尾部追加" → 回退全量重建（索引是派生物，宁可慢也不能猜）
  const bi = buildIndex({ root, autoSync: false });
  return {
    mode: 'rebuild', ok: bi.ok, root,
    rows: bi.rows, added: 0,
    written: bi.written, unchanged: bi.unchanged, removed: bi.removed,
    bytesRead: Number(bi.ledger && bi.ledger.bytes) || 0, addedBytes: 0,
    shards: bi.shards, bytes: bi.bytes,
    reason: planned.reason || 'fallback',
    problems: bi.problems,
    ms: Date.now() - t0,
    build: bi,
    state: bi.state,
  };
}

// ============================================================================
// 五、状态查询（stat）
// ============================================================================

/**
 * 体检索引：**交叉核对**（分片 ↔ 台账 ↔ 原文视图），任何不一致都进 `problems[]`，绝不静默当绿。
 *
 * @param {{root:string, checkDocs?:boolean|'auto'}} opts
 *        checkDocs：`true` 强制逐条复核原文视图 sha256；`false` 跳过；`'auto'`（默认）
 *        = 台账 ≤64 MiB 时全查，否则跳过并在结果里如实标 `docsSkippedReason`。
 * @returns {{ok:boolean, shards:number, rows:number, bytes:number, bytesPerRow:number,
 *   byDay:Object, offsetNull:number, docShaNull:number,
 *   ledger:{files:number,rows:number,bytes:number,badLines:number,nonLedgerRows:number,tornTails:number},
 *   indexToLedgerRatio:number|null, docsChecked:boolean, docsSkippedReason:string,
 *   state:object|null, stateMatch:boolean, problems:Array, problemsTruncated:number, ms:number}}
 *
 * @why 三种"坏"必须能被这里抓出来（0.9.4 反证要求）：
 *      ① 原文被改 → `checkDocs` 复核视图整文件 sha256 ≠ 索引 `d`（也≠台账 docFileSha256）；
 *      ② 索引分片被删 → 该日 index 行数为 0 / 少于台账行数，且 `.idx-state.json` 对不上；
 *      ③ 索引与台账不一致（行被改、偏移被改、顺序被改、多行/少行）→ 按台账字节区间逐行复算 code/offset/bytes。
 */
export function statIndex(opts = {}) {
  const t0 = Date.now();
  const root = requireRoot(opts.root);
  const ledDir = ledgerDir(root);
  const problems = [];
  let problemsTruncated = 0;
  const push = (p) => {
    if (problems.length < 200) problems.push(p); else problemsTruncated++;
  };

  const list = listIndexShardFiles(root);
  if (!list.dirExists) {
    push({ kind: 'index-missing', dir: indexDir(root) });
  }
  for (const name of list.stray) push({ kind: 'unexpected-index-file', file: name });
  const dayGroups = groupShardDays(list.files);

  // ---- 读索引分片 ----
  const indexByDay = new Map(); // day -> {rows:[{row,line}], bad:number, files:number}
  let indexRows = 0;
  let indexBytes = 0;
  let offsetNull = 0;
  let docShaNull = 0;
  for (const f of list.files) {
    indexBytes += f.bytes;
    let txt = '';
    try { txt = fs.readFileSync(f.abs, 'utf8'); } catch (e) {
      push({ kind: 'shard-read-failed', file: f.name, error: String((e && e.message) || e) });
      continue;
    }
    const g = indexByDay.get(f.day) || { rows: [], bad: 0, files: 0 };
    g.files++;
    let ln = 0;
    let pos = 0;
    while (pos < txt.length) {
      const nl = txt.indexOf('\n', pos);
      const end = nl === -1 ? txt.length : nl;
      const line = txt.slice(pos, end);
      const lineNo = ++ln;
      pos = nl === -1 ? txt.length : nl + 1;
      if (!line.trim()) continue;
      const dec = decodeIndexRow(line);
      if (!dec.ok) {
        g.bad++;
        push({ kind: 'bad-index-line', file: f.name, line: lineNo, error: dec.error });
        continue;
      }
      if (dec.row.o === null) offsetNull++;
      if (dec.row.d === null) docShaNull++;
      g.rows.push({ row: dec.row, line, lineNo, file: f.name });
      indexRows++;
    }
    indexByDay.set(f.day, g);
  }

  // ---- 读台账（逐日；不整库入内存）----
  let ledgerNames = [];
  let ledDirExists = false;
  try {
    const st = fs.statSync(ledDir);
    ledDirExists = st.isDirectory();
  } catch { ledDirExists = false; }
  if (ledDirExists) {
    ledgerNames = fs.readdirSync(ledDir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  } else if (list.dirExists) {
    push({ kind: 'ledger-dir-missing', dir: ledDir });
  }
  const standardNames = ledgerNames.filter((n) => DAY_FILE_RE.test(n));
  const oddNames = ledgerNames.filter((n) => !DAY_FILE_RE.test(n));
  const ledger = { files: 0, rows: 0, bytes: 0, badLines: 0, nonLedgerRows: 0, tornTails: 0 };
  for (const n of ledgerNames) {
    try { ledger.bytes += fs.statSync(path.join(ledDir, n)).size; } catch { /* 读的时候会报 */ }
  }
  // 原文复核预算：先看台账字节（不读内容就能算），超预算默认跳过并在结果里说明
  let docsChecked = false;
  let docsSkippedReason = '';
  if (opts.checkDocs === true || opts.checkDocs === 'force') docsChecked = true;
  else if (opts.checkDocs === false) docsSkippedReason = 'disabled';
  else if (ledger.bytes <= 64 * 1024 * 1024) docsChecked = true;
  else docsSkippedReason = 'ledger-too-large(>64MiB): 用 checkDocs:true 强制全查';

  const byDay = {};
  const ledgerDays = new Set();
  const seenCodes = new Set();
  const viewShaCache = new Map();
  let docsCheckedCount = 0;

  for (const name of standardNames) {
    const day = name.replace(/-/g, '').slice(0, 8);
    ledgerDays.add(day);
    let scan;
    try { scan = scanLedgerDayFile(root, name); } catch (e) {
      push({ kind: 'ledger-read-failed', file: name, error: String((e && e.message) || e) });
      continue;
    }
    ledger.files++;
    ledger.rows += scan.rows.length;
    ledger.badLines += scan.badLines.length;
    ledger.nonLedgerRows += scan.nonLedgerRows.length;
    ledger.tornTails += scan.tornTails;
    ledgerScanProblems(scan, push);

    const g = indexByDay.get(day) || { rows: [], bad: 0, files: 0 };
    const pointerRows = g.rows.filter((x) => x.row.o !== null && x.row.n !== null);
    const nullRows = g.rows.filter((x) => x.row.o === null || x.row.n === null);
    if (g.bad > 0) push({ kind: 'bad-index-line', day, file: g.files, count: g.bad });

    if (pointerRows.length !== scan.rows.length) {
      push({
        kind: 'count-mismatch', day,
        indexRows: pointerRows.length + nullRows.length,
        ledgerRows: scan.rows.length,
      });
    }

    // 顺序 / 指针 / d 的逐行复算（两边都按写入顺序 = 台账行顺序）
    let mismatches = 0;
    const n = Math.min(pointerRows.length, scan.rows.length);
    for (let i = 0; i < n; i++) {
      const ir = pointerRows[i];
      const lr = scan.rows[i];
      let reason = '';
      if (ir.row.c !== lr.code) reason = 'code';
      else if (ir.row.o !== lr.offset) reason = 'offset';
      else if (ir.row.n !== lr.bytes) reason = 'bytes';
      if (reason) {
        mismatches++;
        if (mismatches <= 10) {
          push({
            kind: 'pointer-mismatch', day, file: name, position: i + 1, reason,
            indexCode: ir.row.c, ledgerCode: lr.code,
            indexOffset: ir.row.o, ledgerOffset: lr.offset,
            indexBytes: ir.row.n, ledgerBytes: lr.bytes,
          });
        }
        continue;
      }
      // 索引 d 必须等于台账行 docFileSha256（指针取到的行自身）
      const ledgerSha = typeof lr.record.docFileSha256 === 'string' ? lr.record.docFileSha256.trim().toLowerCase() : '';
      if (ir.row.d !== null && DOC_SHA_RE.test(ledgerSha) && ir.row.docShaHex !== ledgerSha) {
        mismatches++;
        if (mismatches <= 10) push({ kind: 'doc-sha-mismatch', day, code: ir.row.c, indexSha: ir.row.docShaHex, ledgerSha });
      }
      if (ir.row.t != null && Number.isInteger(lr.record.turn) && ir.row.t !== lr.record.turn) {
        mismatches++;
        if (mismatches <= 10) push({ kind: 'turn-field-mismatch', day, code: ir.row.c, indexTurn: ir.row.t, ledgerTurn: lr.record.turn });
      }
      // 索引行不应重复
      if (seenCodes.has(ir.row.c)) push({ kind: 'duplicate-index-code', day, code: ir.row.c });
      seenCodes.add(ir.row.c);
    }
    // 多出来的行（索引有台账没有 / 台账有索引没有）
    for (let i = n; i < pointerRows.length; i++) {
      push({ kind: 'orphan-index-row', day, code: pointerRows[i].row.c, file: name });
    }
    let missing = 0;
    for (let i = n; i < scan.rows.length; i++) {
      missing++;
      if (missing <= 10) push({ kind: 'missing-index-row', day, code: scan.rows[i].code, offset: scan.rows[i].offset });
    }

    // 原文视图复核（checkDocs）：整文件 sha256 必须同时等于索引 d 与台账 docFileSha256
    if (docsChecked) {
      let checked = 0;
      for (let i = 0; i < n; i++) {
        const lr = scan.rows[i];
        const ir = pointerRows[i];
        const cached = viewShaCache.get(lr.code);
        let actual = cached;
        if (actual === undefined) {
          actual = '';
          const rel = typeof lr.record.doc === 'string' && lr.record.doc
            ? lr.record.doc
            : (() => {
              const p = parseCode(lr.code);
              return p ? originalRelPath(Number(p.date.slice(0, 4)), Number(p.date.slice(4, 6)), lr.code) : '';
            })();
          if (rel) {
            const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
            try {
              actual = sha256File(abs);
            } catch {
              push({ kind: 'view-missing', day, code: lr.code, doc: rel });
            }
          } else {
            push({ kind: 'view-path-unresolved', day, code: lr.code });
          }
          viewShaCache.set(lr.code, actual);
          checked++;
        }
        if (!actual) continue;
        const indexSha = ir.row.d ? ir.row.docShaHex : '';
        const ledgerSha = typeof lr.record.docFileSha256 === 'string' ? lr.record.docFileSha256.trim().toLowerCase() : '';
        if (indexSha && actual !== indexSha) {
          push({ kind: 'view-sha-mismatch', day, code: lr.code, expected: indexSha, actual, source: 'index' });
        } else if (!indexSha) {
          push({ kind: 'doc-sha-missing', day, code: lr.code });
        }
        if (DOC_SHA_RE.test(ledgerSha) && actual !== ledgerSha) {
          push({ kind: 'view-sha-mismatch', day, code: lr.code, expected: ledgerSha, actual, source: 'ledger' });
        }
      }
      if (checked > 0) docsCheckedCount += checked;
    }

    byDay[day] = {
      indexRows: g.rows.length,
      ledgerRows: scan.rows.length,
      shardFiles: g.files,
      indexBytes: (dayGroups.get(day) || []).reduce((a, f) => a + f.bytes, 0),
      mismatches,
    };
  }
  // 非标准名台账文件：行无法被"日文件指针"定位 → 显式 problem
  for (const name of oddNames) {
    try {
      const scan = scanLedgerDayFile(root, name);
      ledger.files++;
      ledger.rows += scan.rows.length;
      ledger.badLines += scan.badLines.length;
      ledger.nonLedgerRows += scan.nonLedgerRows.length;
      ledger.tornTails += scan.tornTails;
      ledgerScanProblems(scan, push);
      push({ kind: 'odd-ledger-file', file: name, rows: scan.rows.length });
    } catch (e) {
      push({ kind: 'ledger-read-failed', file: name, error: String((e && e.message) || e) });
    }
  }
  for (const day of indexByDay.keys()) {
    if (!ledgerDays.has(day)) push({ kind: 'orphan-shard-day', day });
  }
  // 只有索引行、没有台账日文件的日（异常）也要进 byDay —— 否则状态核对会误报
  for (const [day, g] of indexByDay.entries()) {
    if (byDay[day]) continue;
    byDay[day] = {
      indexRows: g.rows.length,
      ledgerRows: 0,
      shardFiles: g.files,
      indexBytes: (dayGroups.get(day) || []).reduce((a, f) => a + f.bytes, 0),
      mismatches: 0,
      orphan: true,
    };
  }
  if (offsetNull > 0) push({ kind: 'offset-null', count: offsetNull });
  if (docShaNull > 0) push({ kind: 'doc-sha-null', count: docShaNull });

  // ---- 状态文件交叉核对（`.idx-state.json` 被删/改/未更新都要可见） ----
  const state = readIndexState(root);
  let stateMatch = true;
  if (!state) {
    stateMatch = false;
    push({ kind: 'state-missing', expected: INDEX_STATE_FILE });
  } else {
    if (state.format !== INDEX_FORMAT) push({ kind: 'state-format', expected: INDEX_FORMAT, actual: state.format });
    if (Number(state.rows) !== indexRows) { stateMatch = false; push({ kind: 'state-rows-mismatch', stateRows: state.rows, indexRows }); }
    if (Number(state.shards) !== list.files.length) { stateMatch = false; push({ kind: 'state-shards-mismatch', stateShards: state.shards, indexShards: list.files.length }); }
    const sdays = state.days && typeof state.days === 'object' ? state.days : {};
    for (const [day, v] of Object.entries(sdays)) {
      const actual = byDay[day] ? byDay[day].indexRows : 0;
      const want = Number(v && v.rows) || 0;
      if (want !== actual) {
        stateMatch = false;
        push({ kind: 'state-day-mismatch', day, stateRows: want, indexRows: actual });
      }
    }
    for (const day of Object.keys(byDay)) {
      if (!Object.prototype.hasOwnProperty.call(sdays, day)) {
        stateMatch = false;
        push({ kind: 'state-day-unlisted', day, indexRows: byDay[day].indexRows });
      }
    }
  }

  const rowsTotal = indexRows;
  const bytesTotal = indexBytes;
  const ratio = ledger.bytes > 0 ? Number((bytesTotal / ledger.bytes).toFixed(4)) : null;
  return {
    ok: problems.length === 0 && problemsTruncated === 0,
    root,
    indexDir: indexDir(root),
    shards: list.files.length,
    rows: rowsTotal,
    bytes: bytesTotal,
    bytesPerRow: rowsTotal ? Number((bytesTotal / rowsTotal).toFixed(2)) : 0,
    byDay,
    offsetNull,
    docShaNull,
    ledger,
    indexToLedgerRatio: ratio,
    docsChecked,
    docsSkippedReason,
    docsCheckedCount,
    state,
    stateMatch,
    problems,
    problemsTruncated,
    ms: Date.now() - t0,
  };
}

// ============================================================================
// 六、按条件查询
// ============================================================================

/** 读台账日文件的小缓存（查询/复核会反复按 day 取同一文件）。 */
function makeDayCache(maxFiles = 8, maxBytes = 64 * 1024 * 1024) {
  const map = new Map();
  let bytes = 0;
  return {
    get(abs) {
      if (map.has(abs)) return map.get(abs);
      let buf = null;
      try { buf = fs.readFileSync(abs); } catch { return null; }
      map.set(abs, buf);
      bytes += buf.length;
      while ((map.size > maxFiles || bytes > maxBytes) && map.size > 1) {
        const [k, v] = map.entries().next().value;
        map.delete(k);
        bytes -= v.length;
      }
      return buf;
    },
  };
}

/** 指针 → 台账行（`read(day 文件, offset, bytes)` + 形状/主键校验）。 */
function readPointer(root, day, row, cache) {
  if (row.o === null || row.n === null) return { ok: false, error: 'offset-null' };
  const iso = ymdToISO(day);
  if (!iso) return { ok: false, error: 'bad-day' };
  const abs = path.join(root, 'ledger', `${iso}.jsonl`);
  const buf = cache.get(abs);
  if (!buf) return { ok: false, error: 'ledger-file-missing' };
  if (row.o + row.n > buf.length) return { ok: false, error: 'offset-out-of-range' };
  const raw = buf.toString('utf8', row.o, row.o + row.n);
  let rec = null;
  try { rec = JSON.parse(raw); } catch { return { ok: false, error: 'pointer-not-json' }; }
  if (!isLedgerRow(rec)) return { ok: false, error: 'pointer-not-ledger-row' };
  if (rec.code !== row.c) return { ok: false, error: 'pointer-code-mismatch' };
  return { ok: true, record: rec, raw };
}

/** 索引行 → 查询结果（指针取台账行补 ts/sid/turn/doc 等；指针坏也返回，但标 pointerOk:false）。 */
export function hydrateRow(root, day, row, cache = makeDayCache()) {
  const seq = seqOfCode(row.c);
  const out = {
    code: row.c,
    docFileSha256: row.d ? docShaFromField(row.d) : null,
    offset: row.o,
    bytes: row.n,
    day,
    turn: row.t != null ? row.t : seq,
    ts: null,
    sid: null,
    status: null,
    doc: null,
    pointerOk: false,
    pointerError: '',
  };
  const ptr = readPointer(root, day, row, cache);
  if (!ptr.ok) { out.pointerError = ptr.error; return out; }
  const rec = ptr.record;
  out.ts = typeof rec.ts === 'string' ? rec.ts : null;
  out.sid = typeof rec.sid === 'string' ? rec.sid : null;
  out.status = typeof rec.status === 'string' ? rec.status : null;
  out.doc = typeof rec.doc === 'string' ? rec.doc : null;
  if (Number.isInteger(rec.turn)) out.turn = rec.turn;
  out.pointerOk = true;
  if (row.t != null && rec.turn !== row.t) { out.pointerOk = false; out.pointerError = 'turn-mismatch'; }
  if (row.d && typeof rec.docFileSha256 === 'string' && docShaFromField(row.d) !== rec.docFileSha256.trim().toLowerCase()) {
    out.pointerOk = false;
    out.pointerError = 'doc-sha-mismatch';
  }
  return out;
}

/**
 * 查索引。
 *
 * @param {{
 *   root:string, code?:string, sid?:string, turn?:number,
 *   range?:string|{from?:string,to?:string}, limit?:number, checkDocs?:boolean
 * }} opts 至少给 code / sid / turn / range 之一。
 * @returns {Array<object>} 命中行（返回数组上挂一个**不可枚举**的 `meta`：searchedRange/
 *          olderAvailable/hint/shardsRead/bytesRead/rowsRead/limitHit/pointerProblems/ms）。
 *          返回值保持"数组"形状（`queryIndex(...).length` 可直接用），meta 不污染 JSON。
 */
export function queryIndex(opts = {}) {
  const t0 = Date.now();
  const root = requireRoot(opts.root);
  const code = typeof opts.code === 'string' ? opts.code.trim() : '';
  const sid = typeof opts.sid === 'string' ? opts.sid.trim() : '';
  let turn = null;
  if (opts.turn != null && opts.turn !== '') {
    turn = Number(opts.turn);
    if (!Number.isInteger(turn) || turn < 0) fail('turn 必须是 ≥0 的整数');
  }
  const range = parseRange(opts.range);
  if (!code && !sid && turn === null && !range) {
    fail('queryIndex 至少要给一个条件（code / sid / turn / range）');
  }
  if (code && !isValidCode(code)) fail('code 形状不合法: ' + code);
  const sid12 = sid ? normalizeSessionId(sid) : '';
  if (sid && !sid12) fail('sid 无法归一化成 12 位短 ID: ' + sid);
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : NO_LIMIT;
  const checkDocs = opts.checkDocs === true;
  const cache = makeDayCache();
  const viewShaCache = new Map();
  const list = listIndexShardFiles(root);
  const dayGroups = groupShardDays(list.files);
  const allDays = [...dayGroups.keys()].sort();
  const rows = [];
  const pointerProblems = [];
  let shardsRead = 0;
  let bytesRead = 0;
  let rowsRead = 0;
  let limitHit = false;
  let extraScan = false;

  const dayAllowed = (d) => (!range || ((!range.fromYmd || d >= range.fromYmd) && (!range.toYmd || d <= range.toYmd)));
  const wantedDays = (orderedDays) => orderedDays.filter((d) => dayGroups.has(d) && dayAllowed(d));

  /** checkDocs：命中行再核一遍原文视图整文件 sha256（按 code 缓存，同码只读一次）。 */
  const verifyView = (hy) => {
    if (!checkDocs || !hy.pointerOk) return;
    const rel = hy.doc || (() => {
      const p = parseCode(hy.code);
      return p ? originalRelPath(Number(p.date.slice(0, 4)), Number(p.date.slice(4, 6)), hy.code) : '';
    })();
    if (!rel) { hy.pointerOk = false; hy.pointerError = 'view-path-unresolved'; return; }
    let actual = viewShaCache.get(hy.code);
    if (actual === undefined) {
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      try { actual = sha256File(abs); } catch { actual = ''; }
      viewShaCache.set(hy.code, actual);
    }
    const expect = hy.docFileSha256 || '';
    if (!actual || (expect && actual !== expect)) {
      hy.pointerOk = false;
      hy.pointerError = actual ? 'view-sha-mismatch' : 'view-missing';
      pointerProblems.push({ code: hy.code, day: hy.day, error: hy.pointerError, expected: expect || null, actual: actual || null });
    }
  };

  if (!list.dirExists || allDays.length === 0) {
    const meta = buildMeta({
      kind: code ? 'code' : 'filter',
      root, code, sid, turn, range, allDays, searchedDays: [], shardsRead, bytesRead, rowsRead,
      rows, limitHit, pointerProblems, extraScan, t0,
      hintExtra: '索引目录不存在或为空 → 先跑 `node tools/cli.mjs index build --root=<账库>`',
    });
    Object.defineProperty(rows, 'meta', { value: meta, enumerable: false });
    return rows;
  }

  const scanList = (days) => {
    for (const day of days) {
      for (const f of dayGroups.get(day)) {
        let txt = '';
        try { txt = fs.readFileSync(f.abs, 'utf8'); } catch (e) {
          pointerProblems.push({ kind: 'shard-read-failed', file: f.name, error: String((e && e.message) || e) });
          continue;
        }
        shardsRead++;
        bytesRead += f.bytes;
        if (code) {
          // code 精确查：行首固定 `{"c":"<code>"`，用字符串定位（不必 parse 全部分片行）
          const marker = `{"c":"${code}"`;
          let at = txt.indexOf(marker);
          while (at !== -1) {
            if (at === 0 || txt.charCodeAt(at - 1) === 0x0a) {
              const end = (() => { const nl = txt.indexOf('\n', at); return nl === -1 ? txt.length : nl; })();
              const line = txt.slice(at, end);
              const dec = decodeIndexRow(line);
              if (!dec.ok) pointerProblems.push({ kind: 'bad-index-line', file: f.name, error: dec.error });
              else if (dec.row.c === code) {
                const hy = hydrateRow(root, day, dec.row, cache);
                verifyView(hy);
                if (!hy.pointerOk) pointerProblems.push({ code, day, file: f.name, error: hy.pointerError });
                rows.push(hy);
                if (rows.length >= limit) { limitHit = true; break; }
              }
              at = txt.indexOf(marker, end);
              continue;
            }
            at = txt.indexOf(marker, at + 1);
          }
          if (limitHit) return true;
          continue;
        }
        // sid / turn / range：逐行
        let pos = 0;
        while (pos < txt.length) {
          const nl = txt.indexOf('\n', pos);
          const end = nl === -1 ? txt.length : nl;
          const line = txt.slice(pos, end);
          pos = nl === -1 ? txt.length : nl + 1;
          if (!line.trim()) continue;
          rowsRead++;
          if (line.length < 38 || !line.startsWith('{"c":"')) continue;
          const c = line.slice(6, 38);
          if (!isValidCode(c)) continue;
          // 12 位短 ID = code[9..20]；会话内序号 = code[24..31]（见 lib/encoder.js 编码格式）
          if (sid12 && c.slice(9, 21) !== sid12) continue;
          if (turn !== null) {
            // 稀疏 t：构建时只在 turn≠code 序号 才写；不写 = turn==seq，可直接判定
            const tAt = line.indexOf(',"t":');
            const rowTurn = tAt === -1
              ? Number(c.slice(24, 32))
              : Number(line.slice(tAt + 5, line.indexOf('}', tAt)));
            if (!Number.isInteger(rowTurn) || rowTurn !== turn) continue;
          }
          const dec = decodeIndexRow(line);
          if (!dec.ok) { pointerProblems.push({ kind: 'bad-index-line', file: f.name, error: dec.error }); continue; }
          const hy = hydrateRow(root, day, dec.row, cache);
          // sid 精确性：短 ID 相同不保证是同一会话（撞了 s12 会分代 A/B）→ 用台账行原 sid 复核
          if (sid && hy.sid !== sid) continue;
          if (turn !== null && hy.turn !== turn) continue;
          verifyView(hy);
          if (!hy.pointerOk) pointerProblems.push({ code: c, day, file: f.name, error: hy.pointerError });
          rows.push(hy);
          if (rows.length >= limit) { limitHit = true; return true; }
        }
      }
    }
    return false;
  };

  if (code) {
    // 台账日（ts 日）≥ code 日（会话开始日）——先从 code 日起向后扫；找不到再回头扫更早分片
    const codeDate = code.slice(0, 8);
    let ordered = wantedDays(allDays.filter((d) => d >= codeDate));
    let stopped = scanList(ordered);
    if (!stopped && rows.length === 0) {
      const earlier = wantedDays(allDays.filter((d) => d < codeDate));
      if (earlier.length > 0) { extraScan = true; scanList(earlier); }
    }
  } else {
    // 有 range 时按 range 收窄；没有 range 的 sid/turn 查询只能全索引扫（如实计入 meta.shardsRead）
    scanList(wantedDays(allDays));
  }

  const searchedDays = code
    ? (extraScan ? allDays : wantedDays(allDays.filter((d) => d >= code.slice(0, 8))))
    : wantedDays(allDays);
  const meta = buildMeta({
    kind: code ? 'code' : 'filter',
    root, code, sid, turn, range, allDays, searchedDays, shardsRead, bytesRead, rowsRead,
    rows, limitHit, pointerProblems, extraScan, t0, hintExtra: '',
  });
  Object.defineProperty(rows, 'meta', { value: meta, enumerable: false });
  return rows;
}

/** 组装查询边界回执（C33 的雏形：查不到必须说清"查了哪段、更早还有没有"）。 */
function buildMeta({
  kind, root, code, sid, turn, range, allDays, searchedDays, shardsRead, bytesRead, rowsRead,
  rows, limitHit, pointerProblems, extraScan, t0, hintExtra,
}) {
  const sortedSearched = searchedDays.slice().sort();
  const searchedRange = {
    fromYmd: range && range.fromYmd ? range.fromYmd : (sortedSearched[0] || ''),
    toYmd: range && range.toYmd ? range.toYmd : (sortedSearched[sortedSearched.length - 1] || ''),
  };
  const minDay = allDays.length ? allDays[0] : '';
  const olderAvailable = !!(minDay && searchedRange.fromYmd && minDay < searchedRange.fromYmd);
  const newerAvailable = !!(allDays.length && searchedRange.toYmd && allDays[allDays.length - 1] > searchedRange.toYmd);
  let hint = hintExtra || '';
  if (!hint && rows.length === 0) {
    const conds = [];
    if (code) conds.push('code=' + code);
    if (sid) conds.push('sid=' + sid);
    if (turn !== null) conds.push('turn=' + turn);
    if (range) conds.push(`range=${searchedRange.fromYmd || '*'}..${searchedRange.toYmd || '*'}`);
    hint = `未命中（${conds.join(' ')}）。已查 ${sortedSearched.length} 个日分片` +
      (searchedRange.fromYmd ? `（${searchedRange.fromYmd}..${searchedRange.toYmd}）` : '') +
      (olderAvailable ? `；更早还有分片（最早 ${minDay}），需要时加 --range/--sid` : '') +
      '。若确定数据存在，索引可能过期：跑 index build。';
  } else if (!hint && olderAvailable) {
    hint = `本次只查 ${searchedRange.fromYmd}..${searchedRange.toYmd}；更早数据（最早 ${minDay}）仍在，需显式带 range/sid。`;
  }
  return {
    kind,
    root,
    code: code || '',
    sid: sid || '',
    turn: turn === null ? null : turn,
    range: range ? { ...range } : null,
    searchedRange,
    olderAvailable,
    newerAvailable,
    hint,
    allShardDays: allDays.length,
    shardsRead,
    bytesRead,
    rowsRead,
    matches: rows.length,
    limitHit,
    extraScan,
    pointerProblems,
    documentsChecked: false,
    ms: Date.now() - t0,
  };
}

// ============================================================================
// 七、只读辅助（CLI / 自测用）
// ============================================================================

/** 索引里有哪些日（供 CLI 边界提示与体检）。 */
export function shardDays(root) {
  const list = listIndexShardFiles(root);
  const map = groupShardDays(list.files);
  return [...map.keys()].sort();
}
