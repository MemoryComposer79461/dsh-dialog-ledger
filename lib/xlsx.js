/**
 * @file xlsx.js
 * @role 零依赖的 xlsx 写入器：ZIP（默认 stored，不压缩）+ 最小 OOXML。
 * @called-by weekly.js（周记账）
 * @depends node:fs / node:path / node:zlib（仅在显式选择 deflate 时用到）
 *
 * @why 为什么自己写：
 *      插件是零依赖、离线可用的。引一个 xlsx npm 包会破坏这条底线；
 *      调 Python 又会隐含"运行环境必须有 python"。
 *      xlsx 本质是 ZIP + XML，而 ZIP 的 stored 模式（不压缩）实现量很小，
 *      几百行就能换回"不依赖任何东西"。
 *
 * @why 为什么默认 stored 而不是 deflate：
 *      deflate 要自己接 zlib 的流式接口，收益只是文件小一点；
 *      周记账一年也就几十个文件，体积不是问题。先把正确性立住。
 *      （可选 `{ method: 'deflate' }` 只是给自测/体积敏感场景留的口子，默认永远 stored。）
 *
 * ⚠️ 支持范围（够用即止，v1.3 周记账需要什么就支持什么）：
 *  · 多工作表；每表二维数组，单元格可以是 string / number / 公式对象 `{f, v?, t?}`；
 *  · 每表可选：列宽 `cols`、冻结首行 `freeze`、自动筛选 `autoFilter`、
 *    合并单元格 `merges`、数据验证 `dataValidations`、页设置 `pageSetup`、
 *    打印选项 `printOptions`、是否显示网格线 `gridLines`、`dimension` 覆盖、
 *    预置空行单元格 `padCols`（空行显式写 A…{padCols}，供"日表预置 120 行"）；
 *  · 公式写 `<f>`，可带缓存值 `<v>`（workbook 里 `fullCalcOnLoad="1"`，Excel 打开会重算）；
 *  · 字符串用 inlineStr，不建 sharedStrings；
 *    **XML 1.0 非法字符一律清洗**（控制符 + U+FFFE/U+FFFF + 孤立代理对）——
 *    不清的话 Excel/openpyxl 会整本解析失败（审计② P2-15）；
 *  · 单元格文本超 **32,767** 字符 → 截断到上限 + 可见标记 `…[截断]` + 告警（不静默丢）；
 *  · 样式：只带一份最小 styles.xml（Excel / openpyxl 都认），不做任何单元格样式；
 *  · 没有任何外部依赖；XML 一律 UTF-8、ZIP 名称走 UTF-8 标志位。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** CRC32 表（ZIP 必需）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 列号 → A、B…AA。1-based。 */
export function colName(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * XML 1.0 非法字符：出现在 XML 里会让**整本 xlsx 直接打不开**（Excel / openpyxl 都报解析失败），
 * 不是"显示难看"而是"文件非法"。
 *
 * 非法集合（XML 1.0 §2.2 允许 #x9 | #xA | #xD | #x20–#xD7FF | #xE000–#xFFFD | #x10000–#x10FFFF）：
 *   · 除 \t \n \r 之外的 C0 控制符（#x0–#x8、#xB、#xC、#xE–#x1F）；
 *   · **U+FFFE / U+FFFF**（非字符，审计② P2-15 漏掉的两个）；
 *   · 孤立代理对（UTF-8 序列化会变成非法字节，上游 JSON 破损时可能出现）。
 */
const XML_ILLEGAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Excel 单元格文本上限：32,767 字符（UTF-16 码元）。
 * 超限不是"多一列"，而是**整本工作簿被判非法**（openpyxl 报 `Cell contents too long`）。
 * 所以超出必须截断；截断必须留可见标记 + 告警，绝不静默丢数据（与 P0-5 同精神）。
 */
export const MAX_CELL_CHARS = 32767;

/** 超长截断后追加的可见标记（人打开表就能看见"这里被截过"）。 */
export const CELL_TRUNC_MARK = '…[截断]';

/** XML 文本/属性转义。XML 1.0 非法字符一律剔除（含 U+FFFE/U+FFFF、控制符、孤立代理对）。 */
function esc(s) {
  return String(s)
    .replace(XML_ILLEGAL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 单元格文本按 Excel 上限（32,767）截断 —— 截断也要**可见**，并给告警。
 *
 * @param {any} value 原始单元格值
 * @returns {{text:string, truncated:boolean, chars:number, kept:number}}
 *
 * @why 必须按 UTF-16 码元截：`s.length` 就是 Excel 判定的长度口径；
 *      截断点若落在代理对中间会劈出孤立代理 → 又违反 XML，所以往回退 1。
 */
function clipCellText(value) {
  const s = String(value);
  if (s.length <= MAX_CELL_CHARS) return { text: s, truncated: false, chars: s.length, kept: s.length };
  let keep = MAX_CELL_CHARS - CELL_TRUNC_MARK.length;
  const code = s.charCodeAt(keep - 1);
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1; // 不劈代理对
  const text = s.slice(0, keep) + CELL_TRUNC_MARK;
  return { text, truncated: true, chars: s.length, kept: text.length };
}

/** 截断告警入册（`ctx.warnings` 由调用方传入；没传就只截断不告警 —— 但 writeXlsx 的调用方都会传）。 */
function noteTruncated(ctx, ref, info) {
  if (!ctx || !Array.isArray(ctx.warnings)) return;
  ctx.warnings.push({
    type: 'cell-truncated',
    sheet: String((ctx.sheet === undefined || ctx.sheet === null) ? '' : ctx.sheet),
    ref: String(ref),
    chars: info.chars,
    kept: info.kept,
    limit: MAX_CELL_CHARS,
    message: `xlsx: 单元格 ${ref} 文本 ${info.chars} 字符超过 Excel 上限 ${MAX_CELL_CHARS}，已截断并留可见标记`,
  });
}

/**
 * 「看起来像数字的字符串」是否应保留成数字。
 *
 * @why 只有**规范写法**才转数字：`0001` 一转就是 1，编码/编号的前导零会丢，
 *      所以这里拒绝前导零（除单个 0 本身），也拒绝带空白的字符串。
 */
const NUMBER_RE = /^(?:0|-?[1-9]\d*)(?:\.\d+)?$/;

/** 单元格 → `<c>` XML。空字符串不写单元格（保持文件小）。 */
function cellXml(ref, v, ctx) {
  if (v === null || v === undefined || v === '') return '';

  // 公式：{ f: 'COUNTA(...)', v: 0 }；可选 t: 'str'（字符串结果）
  if (typeof v === 'object' && typeof v.f === 'string' && v.f !== '') {
    const f = `<f>${esc(v.f)}</f>`;
    if (typeof v.v === 'number' && Number.isFinite(v.v)) return `<c r="${ref}">${f}<v>${v.v}</v></c>`;
    if (typeof v.v === 'string' && v.v !== '') {
      const clip = clipCellText(v.v);
      if (clip.truncated) noteTruncated(ctx, ref, clip);
      return `<c r="${ref}" t="str">${f}<v>${esc(clip.text)}</v></c>`;
    }
    return `<c r="${ref}">${f}</c>`;
  }

  if (typeof v === 'number' && Number.isFinite(v)) {
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  if (typeof v === 'string' && NUMBER_RE.test(v) && v.length < 15) {
    // 纯数字字符串：长度 < 15 才转数字，避免 32 位编码/长数字丢精度
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  // 32,767 上限只管"文本格"；超长截断 + 可见标记 + 告警（Excel 会直接判整本非法）
  const clip = clipCellText(v);
  if (clip.truncated) noteTruncated(ctx, ref, clip);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(clip.text)}</t></is></c>`;
}

/**
 * 一行二维数组 → `<row>` XML。
 *
 * @param {number} r 行号（1-based）
 * @param {any[]} cells 单元格数组
 * @param {number} [padCols] 预置列数：空行也显式写出 A…{padCols} 的空单元格，
 *        这样读表工具（openpyxl）的 used range 才是 A1:{padCols}{行数}，
 *        与"日表预置 120 行"的版式口径一致（否则空行会被当成不存在）。
 * @param {{warnings?:Array, sheet?:string}} [ctx] 截断告警接收器（可选）
 */
function rowXml(r, cells, padCols, ctx) {
  const list = Array.isArray(cells) ? cells : [];
  const padded = Number.isFinite(padCols) && padCols > 0;
  const cols = Math.max(list.length, padded ? padCols : 0);
  const parts = [];
  for (let c = 0; c < cols; c++) {
    const ref = colName(c + 1) + r;
    const xml = cellXml(ref, c < list.length ? list[c] : undefined, ctx);
    if (xml) parts.push(xml);
    // 预置模式：空单元格也显式写出来（`<c r="A2"/>`），否则读表工具认为该行不存在
    else if (padded) parts.push(`<c r="${ref}"/>`);
  }
  if (parts.length === 0) return `<row r="${r}"/>`;
  return `<row r="${r}" spans="1:${cols}">${parts.join('')}</row>`;
}

/** 合并区 `A1:D1` → {minCol,maxCol,minRow,maxRow}，用于把 dimension 撑到覆盖所有合并。 */
function mergeBounds(ref) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(ref || '').replace(/\$/g, ''));
  if (!m) return null;
  const col = (s) => {
    let n = 0;
    for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  };
  return { minCol: col(m[1]), maxCol: col(m[3]), minRow: Number(m[2]), maxRow: Number(m[4]) };
}

/** 计算工作表 dimension（A1:J121 这种）：取行数 / 单元格最大列 / 合并区的最大值。 */
function dimensionOf(sheet) {
  if (sheet && typeof sheet.dimension === 'string' && sheet.dimension) return sheet.dimension;
  const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
  let maxCol = 1;
  let maxRow = Math.max(rows.length, 1);
  for (const cells of rows) {
    if (Array.isArray(cells) && cells.length > maxCol) maxCol = cells.length;
  }
  for (const ref of Array.isArray(sheet && sheet.merges) ? sheet.merges : []) {
    const b = mergeBounds(ref);
    if (!b) continue;
    if (b.maxCol > maxCol) maxCol = b.maxCol;
    if (b.maxRow > maxRow) maxRow = b.maxRow;
  }
  if (maxRow === 1 && maxCol === 1) return 'A1';
  return `A1:${colName(maxCol)}${maxRow}`;
}

/** 列宽：`cols` 是宽度数组，索引 i 对应第 i+1 列；0/无效值跳过。 */
function colsXml(widths) {
  const parts = [];
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]);
    if (!Number.isFinite(w) || w <= 0) continue;
    // Excel 列宽上限 255；下限给 1，避免 0 宽不可见
    const v = Math.min(255, Math.max(1, w));
    parts.push(`<col min="${i + 1}" max="${i + 1}" width="${v}" customWidth="1"/>`);
  }
  return parts.length ? `<cols>${parts.join('')}</cols>` : '';
}

/** 冻结首行（ySplit=1）或自定义冻结窗格。 */
function sheetViewsXml(sheet) {
  const showGrid = sheet && sheet.gridLines === false ? ' showGridLines="0"' : '';
  const f = sheet && sheet.freeze;
  let pane = '';
  if (f) {
    const ySplit = typeof f === 'object' && Number.isFinite(f.ySplit) ? f.ySplit : 1;
    const topLeft = typeof f === 'object' && typeof f.topLeftCell === 'string' ? f.topLeftCell : `A${ySplit + 1}`;
    pane = `<pane ySplit="${ySplit}" topLeftCell="${esc(topLeft)}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${esc(topLeft)}" sqref="${esc(topLeft)}"/>`;
  }
  return `<sheetViews><sheetView${showGrid} workbookViewId="0">${pane}</sheetView></sheetViews>`;
}

/** 数据验证：编码自定义公式 / 三列下拉都靠它写进 xlsx（不许省）。 */
function dataValidationsXml(dvs) {
  const list = Array.isArray(dvs) ? dvs.filter((d) => d && d.sqref && d.formula1) : [];
  if (list.length === 0) return '';
  const parts = list.map((d) => {
    const attrs = [];
    attrs.push(`type="${esc(d.type || 'custom')}"`);
    attrs.push(`allowBlank="${d.allowBlank === false ? '0' : '1'}"`);
    attrs.push(`showInputMessage="${d.showInputMessage === false ? '0' : '1'}"`);
    attrs.push(`showErrorMessage="${d.showErrorMessage === false ? '0' : '1'}"`);
    if (d.promptTitle) attrs.push(`promptTitle="${esc(d.promptTitle)}"`);
    if (d.prompt) attrs.push(`prompt="${esc(d.prompt)}"`);
    if (d.errorTitle) attrs.push(`errorTitle="${esc(d.errorTitle)}"`);
    if (d.error) attrs.push(`error="${esc(d.error)}"`);
    attrs.push(`sqref="${esc(d.sqref)}"`);
    return `<dataValidation ${attrs.join(' ')}><formula1>${esc(d.formula1)}</formula1></dataValidation>`;
  });
  return `<dataValidations count="${parts.length}">${parts.join('')}</dataValidations>`;
}

function sheetXml(sheet, ctx) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const merges = Array.isArray(sheet.merges) ? sheet.merges.filter(Boolean) : [];
  // 每个 sheet 一个 ctx：告警里能定位到"哪张表哪个格"
  const cellCtx = ctx ? { warnings: ctx.warnings, sheet: sheet && sheet.name } : undefined;

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  parts.push(`<dimension ref="${esc(dimensionOf(sheet))}"/>`);
  parts.push(sheetViewsXml(sheet));
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (Array.isArray(sheet.cols) && sheet.cols.length) parts.push(colsXml(sheet.cols));
  parts.push(`<sheetData>${rows.map((cells, i) => rowXml(i + 1, cells, sheet.padCols, cellCtx)).join('')}</sheetData>`);
  // 元素顺序按 OOXML CT_Worksheet 的 sequence：autoFilter → mergeCells → dataValidations
  if (sheet.autoFilter) parts.push(`<autoFilter ref="${esc(sheet.autoFilter)}"/>`);
  if (merges.length) {
    parts.push(`<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${esc(ref)}"/>`).join('')}</mergeCells>`);
  }
  if (Array.isArray(sheet.dataValidations) && sheet.dataValidations.length) {
    parts.push(dataValidationsXml(sheet.dataValidations));
  }
  if (sheet.printOptions && sheet.printOptions.horizontalCentered) parts.push('<printOptions horizontalCentered="1"/>');
  parts.push('<pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/>');
  if (sheet.pageSetup) {
    const a = [];
    a.push(`orientation="${esc(sheet.pageSetup.orientation || 'landscape')}"`);
    if (Number.isFinite(sheet.pageSetup.paperSize)) a.push(`paperSize="${sheet.pageSetup.paperSize}"`);
    if (Number.isFinite(sheet.pageSetup.fitToHeight)) a.push(`fitToHeight="${sheet.pageSetup.fitToHeight}"`);
    if (Number.isFinite(sheet.pageSetup.fitToWidth)) a.push(`fitToWidth="${sheet.pageSetup.fitToWidth}"`);
    parts.push(`<pageSetup ${a.join(' ')}/>`);
  }
  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * 最小 styles.xml。
 *
 * @why 为什么没有样式还要带它：
 *      这是 Excel 侧兼容性最稳的最小集（Normal 样式 + 默认字体/填充/边框）。
 *      单元格不写 `s=` 属性，所以文件里没有任何"样式"，只是让工作簿结构完整。
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="宋体"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** ZIP 时间戳固定（1996-01-01）→ 同样内容永远同样字节，便于"内容没变就不写"的幂等口径。 */
const ZIP_DATE = 0x21;

/**
 * 组装 ZIP。
 *
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {'stored'|'deflate'} method
 */
function zipStore(entries, method = 'stored') {
  const useDeflate = method === 'deflate';
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const data = useDeflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const code = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 名称
    local.writeUInt16LE(code, 8);      // method
    local.writeUInt16LE(0, 10);        // time
    local.writeUInt16LE(ZIP_DATE, 12);// date（1996-01-01，固定值，保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);   // compressed size
    local.writeUInt32LE(raw.length, 22);    // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(code, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk
    central.writeUInt16LE(0, 36);      // internal attrs
    central.writeUInt32LE(0, 38);      // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 生成 xlsx 字节。
 *
 * @param {Array<object>} sheets 工作表描述：
 *   `{ name, rows, cols?, freeze?, gridLines?, autoFilter?, merges?,
 *      dataValidations?, printOptions?, pageSetup?, dimension? }`
 * @param {{method?:'stored'|'deflate', warnings?:Array<object>}} [options] 默认 stored（v1.3 主口径）
 *        `warnings`：传数组则把"单元格超 32,767 被截断"等事件 push 进去（不静默丢数据）。
 * @returns {Buffer}
 */
export function buildXlsx(sheets, options = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  const method = options && options.method === 'deflate' ? 'deflate' : 'stored';
  const ctx = { warnings: options && Array.isArray(options.warnings) ? options.warnings : null };
  const files = [];

  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list
      .map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  });

  files.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  });

  files.push({
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${list
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
      .map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  });

  files.push({ name: 'xl/styles.xml', data: STYLES_XML });

  list.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, ctx) });
  });

  return zipStore(files, method);
}

/**
 * 原子写 xlsx：先写临时文件，再 rename。
 *
 * @param {string} filePath
 * @param {Array<object>} sheets 同 buildXlsx
 * @param {{method?:'stored'|'deflate', warnings?:Array<object>}} [options] 同 buildXlsx
 * @returns {string} filePath（为兼容既有调用方，返回值不变；告警走 options.warnings）
 */
export function writeXlsx(filePath, sheets, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  // ★ 审计 #5（2026-11-09）：**必须先 fsync 再 rename**。
  //   原实现 writeFileSync + renameSync 只保证"进了页缓存"，而封板 journal 紧随其后就 fsync；
  //   断电就会出现"journal 说已封板、xlsx 实际没落盘"——而封板后永不重写，等于永久坏册且无人能测出。
  const data = buildXlsx(sheets, options);
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof data === 'string') fs.writeSync(fd, data, null, 'utf8');
    else fs.writeSync(fd, data, 0, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  return filePath;
}
