/**
 * @file sealcross.js
 * @role 封板交叉核验（P1-13 / 审计 M-03）：把 xlsx 里的**机器列**与 `seal-journal` 的 `rows[]` 逐格比对。
 *
 * @why 为什么需要它（审计 M-03 原话的意思）：
 *      封板 hash 覆盖的是 canonical（台账派生），而 xlsx 是**可以被人用 Excel 打开、改一格、再保存**的。
 *      在此之前，插件只会说"这本册子已封板"，却从不回头读一眼**文件里到底写着什么** ——
 *      于是"已封板"这三个字只证明了"当初算过"，没证明"现在还在"。
 *      交叉核验就是补这一眼：**封板证据 vs 产物实际内容**，逐格比。
 *
 * @why 零依赖手写解析：项目底线是不引第三方包。xlsx 就是一个 zip + 几段 XML，
 *      用 node 内置 `zlib.inflateRawSync` 足够。**只读**，绝不改动被核验的文件。
 *
 * @注意 已知盲区（必须如实披露，不许含糊）：
 *      - 只核**机器列**（A 编码 / B 原始凭证 / C 时间 / H 状态默认值）；人工列（D–G、J）不归机器管。
 *      - Excel 重存会改写 XML 结构（共享字符串、样式索引、列宽），本模块按**值**比对，不看格式；
 *        若重存后连"封板标记"都被抹掉，那是另一条判据（`E_SEAL_UNKNOWN`）管的。
 *
 * @depends node:fs、node:path、node:zlib
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ============================================================================
// 一、最小 ZIP 读取（只读，支持 stored / deflate）
// ============================================================================

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * 读出 zip 里所有条目（名字 → 解压后 Buffer）。
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function unzipAll(buf) {
  const out = new Map();
  // 从尾部找 EOCD（注释最长 65535，所以最多回看 65557 字节）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: 找不到 zip 目录（EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('xlsx: 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error('xlsx: 本地头损坏: ' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
  }
  return out;
}

// ============================================================================
// 二、解析 sheet 单元格（值，不关心样式）
// ============================================================================

const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** 从 `<c ...>…</c>` 片段里取值（inlineStr / 公式字符串 / 数字或数字字符串）。 */
function cellValue(attrs, inner) {
  if (/\bt="inlineStr"/.test(attrs)) {
    const m = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
    return m ? unesc(m[1]) : '';
  }
  const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  return v ? unesc(v[1]) : '';
}

/** 解析一张 sheet 的 XML → Map<'A1', 值字符串>。 */
export function parseSheetCells(xml) {
  const cells = new Map();
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
    if (!ref) continue;
    cells.set(ref[1], cellValue(attrs, m[2] || ''));
  }
  return cells;
}

/** 解析 workbook.xml + rels，得到「sheet 名 → 值表」。 */
export function readWorkbookMatrix(bufOrPath) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath);
  const entries = unzipAll(buf);
  const wb = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('xlsx: 缺 workbook.xml 或 rels');
  const relMap = new Map();
  for (const m of rels.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]);
    const target = /\bTarget="([^"]+)"/.exec(m[1]);
    if (id && target) relMap.set(id[1], target[1].replace(/^\/?xl\//, ''));
  }
  const out = new Map();
  for (const m of wb.toString('utf8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    // 注意：`.exec()` 返回的是匹配数组，必须取 [1]；第一版直接拿数组当 Map 键，
    // 于是"哪张表"在报告里显示成 `name="周一",周一` 这种乱码（自测里发现）。
    const nameM = /\bname="([^"]+)"/.exec(m[1]);
    const ridM = /\br:id="([^"]+)"/.exec(m[1]);
    if (!nameM || !ridM) continue;
    const sheetName = nameM[1];
    const target = relMap.get(ridM[1]);
    if (!target) continue;
    const xml = entries.get(path.posix.join('xl', target));
    if (!xml) continue;
    out.set(sheetName, parseSheetCells(xml.toString('utf8')));
  }
  return out;
}

// ============================================================================
// 三、逐格比对
// ============================================================================

/** 机器列（与周记账十列口径一致）：A 编码、B 原始凭证、C 时间、H 状态默认值。 */
export const MACHINE_COLS = ['A', 'B', 'C', 'H'];

/**
 * 把 `rows[]`（journal 里的机器行快照）与工作簿逐格比对。
 *
 * @param {Map<string, Map<string,string>>} matrix readWorkbookMatrix 的结果
 * @param {Array<Array<any>>} rows journal `event.rows`（每行按 A/B/C/H 顺序）
 * @param {{headerRow?:number, machineCols?:string[]}} [opts]
 * @returns {{ok:boolean, checked:number, missing:string[], mismatches:Array,
 *            sheets:string[], reason?:string}}
 */
export function crosscheckRows(matrix, rows, opts = {}) {
  const headerRow = Number.isInteger(opts.headerRow) ? opts.headerRow : 1;
  const cols = Array.isArray(opts.machineCols) ? opts.machineCols : MACHINE_COLS;
  const res = { ok: true, checked: 0, missing: [], mismatches: [], sheets: [...matrix.keys()] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ...res, ok: false, reason: 'journal 无 rows 快照（无法交叉核验）' };
  }
  // 建立 编码 → { sheet, rowNo, cells }
  const byCode = new Map();
  for (const [sheet, cells] of matrix) {
    for (const [ref, val] of cells) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      if (m[1] !== 'A') continue;
      if (Number(m[2]) <= headerRow) continue; // 表头不算
      const code = String(val || '');
      if (!/^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(code)) continue;
      byCode.set(code, { sheet, rowNo: Number(m[2]) });
    }
  }
  for (const r of rows) {
    const code = String((r && r[0]) || '');
    const hit = byCode.get(code);
    if (!hit) { res.missing.push(code); res.ok = false; continue; }
    const cells = matrix.get(hit.sheet);
    for (let i = 0; i < cols.length; i += 1) {
      const expected = String(r[i] === undefined || r[i] === null ? '' : r[i]);
      const actual = String(cells.get(cols[i] + hit.rowNo) || '');
      res.checked += 1;
      if (expected !== actual) {
        res.mismatches.push({
          code, sheet: hit.sheet, row: hit.rowNo, col: cols[i], expected, actual,
        });
        res.ok = false;
      }
    }
  }
  return res;
}

/**
 * 对某个已封板组做交叉核验（读 journal 快照 + 读产物，逐格比）。
 *
 * @param {string} root 数据总库根
 * @param {string} gid 组 id（`2026-11-1|sessKey`）
 * @param {{readEvents:Function}} deps 注入 journal 读取（避免循环依赖：本模块不 import sealjournal）
 * @returns {{ok:boolean, status:'pass'|'mismatch'|'no-snapshot'|'no-file', checked:number,
 *            missing:string[], mismatches:Array, file:string, reason?:string}}
 */
export function crosscheckSeal(root, gid, deps = {}) {
  const readEvents = typeof deps.readEvents === 'function' ? deps.readEvents : null;
  if (!readEvents) return { ok: false, status: 'no-snapshot', checked: 0, missing: [], mismatches: [], file: '', reason: '未注入 journal 读取器' };
  const evs = (readEvents(root).events || []).filter((e) => e && e.kind === 'weekly-seal' && e.gid === gid);
  if (evs.length === 0) {
    return { ok: false, status: 'no-snapshot', checked: 0, missing: [], mismatches: [], file: '', reason: 'journal 无该组记录' };
  }
  const ev = evs[evs.length - 1];
  const rel = String(ev.file || '');
  if (!rel) return { ok: false, status: 'no-file', checked: 0, missing: [], mismatches: [], file: '', reason: 'journal 无文件路径' };
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    return { ok: false, status: 'no-file', checked: 0, missing: [], mismatches: [], file: rel, reason: '文件不存在' };
  }
  let matrix;
  try {
    matrix = readWorkbookMatrix(abs);
  } catch (e) {
    return { ok: false, status: 'no-file', checked: 0, missing: [], mismatches: [], file: rel, reason: '解析失败: ' + (e && e.message ? e.message : String(e)) };
  }
  const r = crosscheckRows(matrix, ev.rows || []);
  return {
    ok: r.ok === true,
    status: r.ok === true ? 'pass' : (r.reason ? 'no-snapshot' : 'mismatch'),
    checked: r.checked,
    missing: r.missing,
    mismatches: r.mismatches,
    file: rel,
    reason: r.reason || '',
    sheets: r.sheets,
  };
}
