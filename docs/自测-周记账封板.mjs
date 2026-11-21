/**
 * @file 自测-周记账封板.mjs
 * @role v1.3 周记账验收（对应《模板-周记账-十列-v1.3》与《实现checklist-v1.3》WK-01~WK-45 的核心可判定项）：
 *       十列版式 + 三组下拉/编码校验 + 草稿/封板两态 + 原始凭证四态（含旧格式清册兼容） + 补记册（只追加） + xlsx 解包/封板hash 独立复算。
 * @called-by `node --test docs/自测-周记账封板.mjs`（零依赖，用 temp 目录造数据，不碰真实数据总库）
 *
 * 六条主断言（任务书 ①–⑥）+ 三条附加：
 *   ① 十列版式：表头 10 列；机器只填 编码/原始凭证/时间/状态默认值/用户审计默认「待审」，其余人工列填 `—`；
 *   ② 三组下拉（角色/状态/用户审计）与编码校验**真写进 xlsx** 的 dataValidations（D/H/I 列位）；
 *   ③ 草稿可重生成；封板后再写 → `{skipped:true, reason:'sealed'}` 且字节/mtime 不变；state 丢失 → 不重写 + 告警；
 *   ④ 原始凭证四态：绑定 / 补记 / 已清理(RPT-…) / 缺凭证；清册新旧格式都兼容；
 *   ⑤ 补记册落在**一级目录** `补记-YYYYMMDD.md`，**只追加**，补记hash 可独立复算、编号连续；
 *   ⑥ 生成的 xlsx 用 node 的 ZIP 解析 + zlib.inflateRawSync 解包冒烟：sheet XML 解得出、关键字符串都在、封板hash 可只凭文件复算。
 *
 * @why 为什么断言要看"字节"而不是只看返回值：
 *      记账凭证的价值在"没被悄悄改过"。封板后不落盘必须是**文件字节 / mtime 都没动**，
 *      只信返回值会把"说跳过、实际重写"的 bug 放过去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const weekly = await mod('lib/weekly.js');
const sealjournal = await mod('lib/sealjournal.js');
const { buildXlsx } = await mod('lib/xlsx.js');
const { originalRelPath } = await mod('lib/original.js');
const { weekOf } = await mod('lib/week.js');

const {
  TEN_COLUMNS, EMPTY, LAYOUT_VERSION, SEALED_STATUS_TEXT, DRAFT_STATUS_TEXT, SEAL_CANONICAL_VERSION,
  groupRecords, sessKeyOf, resolveDoc, originalLabel, statusDefault,
  buildWeeklyModel, buildSheets, writeWeekly, computeWeeklyFingerprint,
  readWeeklySeals, readWeeklySeal, readSealEvidence, isSealDue, sealDueInfo,
  readCleanedCodesCompat, readSealedMarker,
  writeSupplement, verifySupplementBook, parseSupplementBook,
  supplementEntryHash, supplementRowValues, SUPPLEMENT_COLUMNS,
  validateOverflowClosure,
} = weekly;
const {
  readSealEvents, latestSealEvent, verifySealChain, CANONICAL_VERSION,
  weeklyCanonical, supplementCodesSha256, sha256Hex,
} = sealjournal;

const KEY = '75238718e41aA';
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';

/** 造一条台账记录（编码日期段固定 20261108=会话开始日，周归属按 ts 真实时刻）。 */
const mk = (n, ts, extra = {}) => ({
  v: 3,
  code: `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`,
  ts,
  sid: SID,
  turn: n,
  seq: n,
  status: 'ok',
  ...extra,
});

/** 独立临时工作区（不碰真实数据总库）。 */
function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-seal-'));
  return { dir, root: path.join(dir, 'root') };
}

/** 在第 3 级目录真造一份完整原文，返回相对路径。 */
function putOriginal(root, code, ts) {
  const w = weekOf(Date.parse(ts), 480);
  const rel = originalRelPath(w.year, w.month, code);
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `# ${code} 完整原文\n\n（自测造件）\n`, 'utf8');
  return rel;
}

const sha256Of = (v) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * 造一份**可复核**的 v0.5 完整原文（P1-1/CH-02：「绑定」判定用）：
 * YAML（编码/名称/正文hash）+ 正文锚点 `## 1.` + 同目录 `<code> 原始事件.json` 附件，
 * 返回台账行应带的 docSha256 / docFileSha256 / attachment 三字段。
 */
function putVerifiedOriginal(root, code, ts) {
  const w = weekOf(Date.parse(ts), 480);
  const rel = originalRelPath(w.year, w.month, code);
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = `## 1. user/message\n\n[seq 1] 10:00\n\n自测正文 ${code}\n`;
  const bodyHash = sha256Of(Buffer.from(body, 'utf8'));
  const markdown = `---\n编码: '${code}'\n名称: '${code} 完整原文'\n正文hash: '${bodyHash}'\n---\n\n# ${code} 完整原文\n\n${body}`;
  fs.writeFileSync(abs, markdown, 'utf8');
  const attName = `${code} 原始事件.json`;
  const attBuf = Buffer.from(JSON.stringify({ code, events: [], note: 'self-test' }), 'utf8');
  fs.writeFileSync(path.join(path.dirname(abs), attName), attBuf);
  return {
    doc: rel,
    docSha256: bodyHash,
    docFileSha256: sha256Of(Buffer.from(markdown, 'utf8')),
    attachment: { name: attName, sha256: sha256Of(attBuf), bytes: attBuf.length },
  };
}

/** 日表里的机器数据行（A 列是 32 位编码的行）。 */
function dataRows(sheet) {
  return (sheet.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === 'string' && /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(r[0]));
}

/** 日表里某编码那一行。 */
function rowOfCode(sheet, code) {
  return dataRows(sheet).find((r) => r[0] === code);
}

/** 说明页：按 "一、…"~"五、…" 章节取正文行。 */
function infoSection(sheet, title) {
  const rows = (sheet.rows || []).map((r) => (r || []).map((v) => (v === null || v === undefined ? '' : String(v))));
  const i = rows.findIndex((r) => r.some((c) => c === title));
  if (i < 0) return { found: false, rows: [] };
  const body = [];
  for (let j = i + 1; j < rows.length; j++) {
    if (rows[j].some((c) => /^[一二三四五]、/.test(c))) break;
    if (rows[j].some((c) => c !== '')) body.push(rows[j]);
  }
  return { found: true, rows: body };
}

// ---------------------------------------------------------------------------
// ZIP 解析 + CRC32（自测独立实现，不借 lib/xlsx.js 的私有函数）
// ---------------------------------------------------------------------------

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

/**
 * 解 xlsx（ZIP）：返回 Map<条目名, 解压后 Buffer>。
 * stored（method=0）直接取；deflate（method=8）走 zlib.inflateRawSync。
 * 顺带校验：中央目录/本地头签名、UTF-8 标志、解压长度、CRC32 —— 结构不对立刻失败。
 */
function unzip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'ZIP 缺少 EOCD（文件不像 xlsx）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  assert.ok(cdOff + cdSize <= buf.length, '中央目录越界');

  const out = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录项签名错');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, `本地头签名错: ${name}`);
    assert.equal(flags & 0x0800, 0x0800, `ZIP 名称未标 UTF-8: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else assert.fail(`不支持的压缩方法 ${method}: ${name}`);

    assert.equal(data.length, rawSize, `解压长度不符: ${name}`);
    assert.equal(crc32(data), crc, `CRC32 不符: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, cdOff + cdSize, '中央目录长度不符');
  return out;
}

// ---------------------------------------------------------------------------
// 独立复算封板 hash：只凭解包出来的 sheet XML 还原 canonical（v8）再 sha256。
// 刻意不调用 lib/weekly.js / lib/sealjournal.js 的 hash 函数（只对结果），
// stable JSON 自己实现 —— 证明"产物可独立复算"。
// ---------------------------------------------------------------------------

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 从一段 sheet XML 里取指定 ref 的 inlineStr 文本（取不到返回 ''）。 */
function inlineText(xml, ref) {
  const m = new RegExp(`<c r="${ref}"[^>]*t="inlineStr"[^>]*><is><t[^>]*>([^<]*)</t></is></c>`).exec(xml);
  return m ? m[1] : '';
}

/** 测试侧独立实现的稳定 JSON（对象键排序；数组保序）。 */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}
const sha256str = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 溢出编码集合摘要：排序后 join('\n') 再 sha256。 */
function suppCodesSha256(codes) {
  return sha256str((Array.isArray(codes) ? codes.map(String).slice().sort() : []).join('\n'));
}

/**
 * 从 xlsx 解包结果独立复算封板 hash。
 * @param {Map<string,Buffer>} entries
 * @param {{sourceRowCount?:number, overflow?:number, supplementCodes?:string[]}} extra
 */
function recomputeSealHashFromXlsx(entries, extra = {}) {
  const info = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  const a6 = inlineText(info, 'A6');
  const sessKey = (/(?:会话键|会话鍵): ([0-9a-z]{12}[A-Z])/.exec(a6) || [])[1] || '';
  const ym = /所属月份: (\d{4})年(\d{2})月/.exec(a6);
  const wk = /周序: 第(\d+)周/.exec(a6);
  assert.ok(sessKey, '说明页 A6 应能读出会话键');
  assert.ok(ym && wk, '说明页 A6 应能读出所属月份/周序');
  const year = Number(ym[1]);
  const month = Number(ym[2]);
  const weekNo = Number(wk[1]);
  const offsetMinutes = 480; // 契约固定 +08:00（决定 6）

  const rows = [];
  WEEKDAYS.forEach((name, i) => {
    const xml = entries.get(`xl/worksheets/sheet${i + 2}.xml`).toString('utf8');
    const rowRe = /<row r="(\d+)"[^>]*>(.*?)<\/row>/g;
    let m;
    while ((m = rowRe.exec(xml))) {
      if (Number(m[1]) < 2) continue;
      const body = m[2];
      const code = inlineText(body, `A${m[1]}`);
      if (!/^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(code)) continue;
      rows.push([code, inlineText(body, `B${m[1]}`), inlineText(body, `C${m[1]}`), inlineText(body, `H${m[1]}`)]);
    }
  });
  const overflow = Number.isFinite(extra.overflow) ? extra.overflow : 0;
  const sourceRowCount = Number.isFinite(extra.sourceRowCount) ? extra.sourceRowCount : rows.length + overflow;
  const canonical = stableJson({
    v: 8,
    sessKey,
    year,
    month,
    weekNo,
    offsetMinutes,
    sourceRowCount,
    overflow,
    rowCount: rows.length,
    rowsSha256: sha256str(stableJson(rows)),
    supplementCodesSha256: suppCodesSha256(extra.supplementCodes || []),
    rows,
  });
  return sha256str(canonical);
}

// ---------------------------------------------------------------------------
// ① 十列版式
// ---------------------------------------------------------------------------

test('① 十列版式：表头 10 列；机器只填 编码/原始凭证/时间/状态默认/审计待审，人工列填 —；说明页按模板章节', () => {
  const { root } = lab();
  const ts = '2026-11-04T10:00:00+08:00'; // 2026-11 第 2 周（11-02 ~ 11-08）的周三
  const rec = mk(1, ts);
  Object.assign(rec, putVerifiedOriginal(root, rec.code, ts)); // P1-1：绑定需要三哈希 + 附件复核
  const partial = mk(2, '2026-11-05T11:30:00+08:00', { status: 'partial' }); // 周四：partial → 待确认
  const g = [...groupRecords([rec, partial], 480).values()][0];

  const model = buildWeeklyModel({
    root, w: g.w, sessKey: g.sessKey, records: g.records,
    offsetMinutes: 480, generatedAt: '2026-11-09 12:00:00',
  });

  // 9 张表：说明 + 周一…周日 + 周统计（顺序固定）
  assert.deepEqual(model.sheets.map((s) => s.name),
    ['说明', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周统计']);

  // 表头：十列、逐字（F 列无多余空格）
  const wed = model.sheets.find((s) => s.name === '周三');
  assert.deepEqual(wed.rows[0], TEN_COLUMNS);
  assert.equal(wed.rows[0][5], 'User的文件引用与Agent文件输出');
  assert.equal(wed.rows[0].length, 10);

  // 日表预置 120 行（A2:J121）：表头 1 + 机器行 + 空行 = 121
  assert.equal(wed.rows.length, 121);
  assert.equal(wed.rows.filter((r) => Array.isArray(r) && r.length === 0).length, 120 - 1);

  // 机器落行：A/B/C/H/I 是机器数据；D/E/F/G/J 一律 —
  const row = rowOfCode(wed, rec.code);
  assert.ok(row, '周三应能按编码找到该行');
  assert.deepEqual(row, [rec.code, '绑定', '10:00', '—', '—', '—', '—', '已完成', '待审', '—']);
  // partial → 待确认（决定 9 #17）
  const thu = model.sheets.find((s) => s.name === '周四');
  assert.equal(rowOfCode(thu, partial.code)[7], '待确认');
  assert.equal(statusDefault({ status: 'partial' }), '待确认');
  assert.equal(statusDefault({ status: 'ok' }), '已完成');

  // 空日：A 列全空（禁止占位行，WK-13/WK-31）
  const mon = model.sheets.find((s) => s.name === '周一');
  assert.equal(dataRows(mon).length, 0);
  assert.equal(mon.rows.length, 121);
  assert.equal(mon.rows.some((r) => Array.isArray(r) && String(r[0] || '').startsWith('（本日')), false);

  // 说明页：A1~A6 文件头 + 五个章节（模板第三节 / 决定 9 #20）
  const info = model.sheets.find((s) => s.name === '说明');
  const flat = info.rows.map((r) => (r || []).map((v) => (v === null || v === undefined ? '' : String(v))));
  assert.equal(info.rows[0][0], '周记账模板 v1.3');
  assert.match(String(info.rows[1][0]), /^生成时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+08:00）/);
  assert.match(String(info.rows[2][0]), /^状态: 草稿/);
  assert.equal(info.rows[2][0], DRAFT_STATUS_TEXT);
  assert.match(String(info.rows[2][0]), /请勿批注/);
  assert.equal(info.rows[3][0], '封板hash: —');
  assert.equal(info.rows[4][0], '封板时间: —');
  assert.match(String(info.rows[5][0]), /会话键: 75238718e41aA/);
  for (const k of ['周段: ', '所属月份: ', '周序: 第', '记录数: ', '生成器: ']) {
    assert.equal(String(info.rows[5][0]).includes(k), true, `A6 缺 ${k}`);
  }
  assert.equal(String(info.rows[5][0]).includes('生成器: dsh-dialog-ledger-v0.4/weekly'), true, '生成器必须是 v0.4');
  // 决定 9 #21 / GL-18 铁律：产物里不许承诺未实现的「标红/标橙/拦下」，不许留 markdown 记号
  const allInfoText = flat.flat().join('\n');
  for (const bad of [
    '标红', '标橙', '会标橙', '会被拦下',
    '待定', '按「日」重置', '当前实现按日重置', '建议只保留编码',
    '编码前 8 位应与它一致', '当日第 1 条', '行日期由编码前 8 位',
    'dsh-dialog-ledger-v03',
  ]) {
    assert.equal(allInfoText.includes(bad), false, `说明页不得出现矛盾/未实现文字：${bad}`);
  }
  assert.equal(allInfoText.includes('**'), false, '说明页不应残留 markdown 强调记号');
  assert.equal(allInfoText.includes('`'), false, '说明页不应残留 markdown 行内代码记号');
  // 一、填写约定 9 条
  const s1 = infoSection(info, '一、填写约定');
  assert.equal(s1.found, true);
  assert.equal(s1.rows.length, 9);
  for (let i = 1; i <= 9; i++) assert.equal(s1.rows.some((r) => r[0] === `${i}.`), true, `缺第 ${i} 条约定`);
  // WK-06：第 3/9 条必须讲清 编码日期段=会话开始日、行日期看记录 ts（不得写"行日期由编码前 8 位承载"）
  assert.equal(String(s1.rows[2][1]).includes('按记录 ts 所在日'), true);
  assert.equal(String(s1.rows[2][1]).includes('编码前 8 位是会话开始日'), true);
  assert.equal(String(s1.rows[2][1]).includes('不等于本行日期'), true);
  assert.equal(String(s1.rows[8][1]).includes('编码前 8 位是会话开始日'), true);
  assert.equal(String(s1.rows[8][1]).includes('不是本行日期'), true);
  // WK-06：三、编码规则 8 条，含"编码日期段 = 会话开始日"；第 3/7 条如实写"仅数据验证/未实现条件格式/不自动拦截/不自动标色"
  const s3 = infoSection(info, '三、编码规则');
  assert.equal(s3.rows.length, 8);
  assert.equal(String(s3.rows[1][1]).includes('会话内第 1 条'), true, '编码示例注必须是「会话内第 1 条」');
  assert.equal(String(s3.rows[1][1]).includes('编码日期段 = 会话开始日'), true);
  assert.equal(String(s3.rows[2][1]).includes('仅写数据验证'), true);
  assert.equal(String(s3.rows[2][1]).includes('未实现条件格式'), true);
  assert.equal(String(s3.rows[2][1]).includes('不自动拦截'), true);
  assert.equal(String(s3.rows[2][1]).includes('不自动标色'), true);
  assert.equal(String(s3.rows[6][1]).includes('不会自动拦截输入'), true);
  assert.equal(String(s3.rows[6][1]).includes('不会自动标色'), true);
  // 二、字段定义：表头 7 列 + 10 行字段
  const s2 = infoSection(info, '二、字段定义');
  assert.equal(s2.found, true);
  assert.deepEqual(s2.rows[0], ['列', '字段', '谁填', '必填', '类型', '枚举 / 格式', '说明']);
  assert.equal(s2.rows.length - 1, 10);
  assert.deepEqual(s2.rows.slice(1).map((r) => r[0]), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  // 三、编码规则 8 条；四、状态与封板 7 条；五、已定口径 3 条（不再有"待定"）
  assert.equal(infoSection(info, '三、编码规则').rows.length, 8);
  assert.equal(infoSection(info, '四、状态与封板（v1.3 新增）').rows.length, 7);
  const s5 = infoSection(info, '五、已定口径（v1.3）');
  assert.equal(s5.found, true);
  assert.equal(s5.rows.length, 3);
  // 模板 3.6 五、已定口径 3 条（决定 9 #20）
  assert.equal(s5.rows.some((r) => String(r[1]).includes('序号的边界')), true);
  assert.equal(s5.rows.some((r) => String(r[1]).includes('时间精度')), true);
  assert.equal(s5.rows.some((r) => String(r[1]).includes('文件名中的周次')), true);
  // 第 3 条必须讲清"周次由记录 ts 所在周段决定；编码前 8 位是会话开始日；不可互相校验"
  assert.equal(String(s5.rows[2][1]).includes('记录 ts 所在周段'), true);
  assert.equal(String(s5.rows[2][1]).includes('会话开始日'), true);
  assert.equal(String(s5.rows[2][1]).includes('不可互相校验'), true);
  assert.equal(flat.flat().some((t) => t.includes('五、待定')), false, '产物里不许再留「五、待定」');
  assert.equal(flat.flat().some((t) => t.includes('按「日」重置')), false, '不许留与编码规范矛盾的"按日重置"');

  // 周统计：A1/A2/A4:F4/A5:A11/A12/A13 + 公式（WK-25~WK-30）
  const stats = model.sheets.find((s) => s.name === '周统计');
  assert.equal(stats.rows[0][0], '周统计');
  assert.equal(stats.rows[1][0], '随日明细自动汇总；公式引用 A2:A121，扩行后需同步调整。');
  assert.deepEqual(stats.rows[3], ['星期', '日期', '记录数', '审计通过', '审计未通过', '待审']);
  assert.deepEqual(stats.rows.slice(4, 11).map((r) => r[0]), ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
  assert.equal(stats.rows[11][0], '合计');
  assert.equal(stats.rows[12][0], '溢出（未写入本册）');
  assert.equal(stats.rows[12][1], '—');
  assert.equal(stats.rows[12][2], 0, '无溢出时 C13 必须是数字 0');
  assert.deepEqual(stats.rows[12].slice(3), ['—', '—', '—']);
  const c5 = stats.rows[4][2];
  assert.equal(typeof c5.f, 'string');
  assert.match(c5.f, /^COUNTA\(周一!\$A\$2:\$A\$121\)$/);
  assert.equal(c5.v, 0);
  assert.match(stats.rows[6][2].f, /^COUNTA\(周三!\$A\$2:\$A\$121\)$/);
  assert.match(String(stats.rows[6][3].f), /^COUNTIF\(周三!\$I\$2:\$I\$121,"通过"\)$/);
  assert.equal(String(stats.rows[6][3].f).includes('$H$'), false, '审计三列不得引用 H 列');
  assert.match(stats.rows[11][2].f, /^SUM\(C5:C11\)$/);
  // B5:B11：本段日期或 —（WK-29）
  for (let i = 0; i < 7; i++) {
    assert.match(String(stats.rows[4 + i][1]), /^(\d{4}-\d{2}-\d{2}|—)$/);
  }
  // 记录数口径：日表实际写入行数之和（不含溢出）
  assert.equal(stats.rows[11][2].v, 2);

  // 版式版本（WK-38）
  assert.equal(LAYOUT_VERSION, 6);
});

// ---------------------------------------------------------------------------
// ② 三组下拉 + 编码校验
// ---------------------------------------------------------------------------

test('② 三组下拉 + 编码校验真写进 xlsx（D/H/I 列位、showErrorMessage=false）', () => {
  const { root } = lab();
  const rec = mk(1, '2026-11-04T10:00:00+08:00');
  const g = [...groupRecords([rec], 480).values()][0];
  const model = buildWeeklyModel({ root, w: g.w, sessKey: g.sessKey, records: [rec], generatedAt: '2026-11-09 12:00:00' });
  const day = model.sheets.find((s) => s.name === '周三');

  assert.equal(Array.isArray(day.dataValidations), true);
  assert.equal(day.dataValidations.length, 4);
  const bySq = new Map(day.dataValidations.map((d) => [d.sqref, d]));

  const codeDv = bySq.get('A2:A121');
  assert.ok(codeDv, 'A2:A121 必须有编码校验');
  assert.equal(codeDv.type, 'custom');
  assert.equal(
    codeDv.formula1,
    'IFERROR(AND(LEN(A2)=32,MID(A2,9,1)="-",MID(A2,22,1)="-",MID(A2,24,1)="-",ISNUMBER(--LEFT(A2,8)),ISNUMBER(--RIGHT(A2,8)),ISERROR(FIND("-",MID(A2,10,12))),FIND(MID(A2,23,1),"ABCDEFGHIJKLMNOPQRSTUVWXYZ")>0),FALSE)',
    '编码校验公式必须逐字等于模板',
  );
  assert.equal(codeDv.allowBlank, true);
  assert.equal(codeDv.showErrorMessage, false);
  const listDvs = [
    ['D2:D121', '"User,Agent,Tool"'],
    ['H2:H121', '"已完成,进行中,中断,失败,待确认"'],
    ['I2:I121', '"通过,不通过,待审"'],
  ];
  for (const [sq, formula] of listDvs) {
    const dv = bySq.get(sq);
    assert.ok(dv, `缺下拉 ${sq}`);
    assert.equal(dv.type, 'list');
    assert.equal(dv.formula1, formula);
    assert.equal(dv.allowBlank, true);
    assert.equal(dv.showErrorMessage, false);
  }

  // 不是"只在内存里有"：真写进 sheet XML
  const entries = unzip(buildXlsx(model.sheets));
  const monXml = entries.get('xl/worksheets/sheet2.xml').toString('utf8'); // 周一 = 第 2 张表
  assert.match(monXml, /<dataValidations count="4">/);
  for (const sq of ['A2:A121', 'D2:D121', 'H2:H121', 'I2:I121']) assert.match(monXml, new RegExp(`sqref="${sq}"`));
  assert.match(monXml, /User,Agent,Tool/);
  assert.match(monXml, /已完成,进行中,中断,失败,待确认/);
  assert.match(monXml, /通过,不通过,待审/);
});

// ---------------------------------------------------------------------------
// ③ 草稿 / 封板
// ---------------------------------------------------------------------------

test('③ 草稿可重生成；封板后 skipped:sealed 且字节不变；state 丢失→不重写+告警', () => {
  const { root } = lab();
  const ts = '2026-11-30T10:00:00+08:00'; // 2026-11 第 6 周（1 天周，周一）
  const rec1 = mk(1, ts);
  const g = [...groupRecords([rec1], 480).values()][0];
  const base = { root, w: g.w, sessKey: g.sessKey };
  assert.equal(g.sessKey, KEY);

  // 草稿①：首次落盘，说明页文件头按模板
  const d1 = writeWeekly({ ...base, records: [rec1], mode: 'draft', generatedAt: '2026-11-30 10:05:00' });
  assert.equal(d1.written, true);
  assert.equal(d1.mode, 'draft');
  assert.equal(d1.sealed, false);
  // V0.7 两态：草稿写 草稿- 前缀；正式名只在封板时出现
  assert.equal(d1.path, path.join(root, '2026年11月', `草稿-11月第6周-${KEY}的周记账.xlsx`));
  assert.equal(fs.existsSync(path.join(root, '2026年11月', `11月第6周-${KEY}的周记账.xlsx`)), false, '草稿阶段不得出现正式名');
  let text = fs.readFileSync(d1.path, 'utf8');
  assert.ok(text.includes(DRAFT_STATUS_TEXT));
  assert.ok(text.includes('封板hash: —'));
  assert.ok(text.includes('封板时间: —'));

  // 草稿②：内容指纹没变 → 不重写（Idempotent）
  const d2 = writeWeekly({ ...base, records: [rec1], mode: 'draft', prevHashes: { [d1.groupId]: d1.hash } });
  assert.equal(d2.written, false);
  assert.equal(d2.reason, 'unchanged');

  // 草稿③：新增一条 → 重生成，新行可见
  const rec2 = mk(2, '2026-11-30T10:10:00+08:00');
  const d3 = writeWeekly({ ...base, records: [rec1, rec2], mode: 'draft', prevHashes: { [d1.groupId]: d1.hash } });
  assert.equal(d3.written, true);
  assert.notEqual(d3.hash, d1.hash);
  assert.match(fs.readFileSync(d3.path, 'utf8'), /00000002/);

  // 草稿④：force 强制重生成（mtime / 内容里的生成时间变化）
  const d4 = writeWeekly({ ...base, records: [rec1, rec2], mode: 'draft', force: true, generatedAt: '2026-11-30 10:20:00' });
  assert.equal(d4.written, true);
  assert.match(fs.readFileSync(d4.path, 'utf8'), /生成时间 2026-11-30 10:20:00/);

  // 封板：A3/A4/A5 按 WK-05；证据 = `.seal-journal.jsonl`（journal 权威）+ state 缓存
  const sealedAt = '2026-12-04 00:00:00';
  const s1 = writeWeekly({ ...base, records: [rec1, rec2], mode: 'sealed', sealedAt, generatedAt: sealedAt });
  assert.equal(s1.written, true);
  assert.equal(s1.sealed, true);
  assert.equal(s1.mode, 'sealed');
  assert.match(s1.sealHash, /^[0-9a-f]{64}$/);
  assert.match(s1.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(s1.sealHash, s1.hash); // 内容指纹含版式版本；封板hash不含
  assert.equal(SEAL_CANONICAL_VERSION, 8);
  assert.equal(CANONICAL_VERSION, 8);
  assert.equal(s1.path, path.join(root, '2026年11月', `11月第6周-${KEY}的周记账.xlsx`), '封板必须落正式名');
  assert.equal(fs.existsSync(path.join(root, '2026年11月', `草稿-11月第6周-${KEY}的周记账.xlsx`)), false, '封板后草稿必须删除');
  const sealedBytes = fs.readFileSync(s1.path);
  const sealedText = sealedBytes.toString('utf8');
  assert.ok(sealedText.includes(SEALED_STATUS_TEXT));
  assert.ok(sealedText.includes(`封板hash: ${s1.sealHash}`));
  assert.ok(sealedText.includes(`封板时间: ${sealedAt}（UTC+08:00）`));
  assert.match(sealedText, /会话键: 75238718e41aA/);

  // P1-9：journal 是权威证据，行内含 rows/rowsSha256（= P0-4 的不可变快照）
  const ev1 = latestSealEvent(root, 'weekly-seal', s1.groupId);
  assert.ok(ev1, '封板必须写进 .seal-journal.jsonl');
  assert.equal(ev1.sealHash, s1.sealHash);
  assert.equal(ev1.sealedAt, sealedAt);
  assert.equal(ev1.layoutVersion, 6);
  assert.equal(ev1.canonicalVersion, 8);
  assert.equal(ev1.sourceRowCount, 2);
  assert.equal(ev1.overflow, 0);
  assert.equal(Array.isArray(ev1.rows), true);
  assert.equal(ev1.rows.length, 2);
  assert.equal(ev1.rowsSha256, sha256str(stableJson(ev1.rows)));
  assert.equal(ev1.rowsSha256, sha256Hex(stableJson(ev1.rows)));
  assert.equal(ev1.supplementCodesSha256, supplementCodesSha256([]));
  assert.equal(ev1.supplement, null);
  const chain1 = verifySealChain(root);
  assert.equal(chain1.ok, true, JSON.stringify(chain1));
  // 不写第二份快照目录（Lead/契约裁定：journal 即快照）
  assert.equal(fs.existsSync(path.join(root, 'ledger', 'seals')), false);

  const sealRec = readWeeklySeals(root)[s1.groupId];
  assert.ok(sealRec, '封板状态必须能从封板证据读出');
  assert.equal(sealRec.source, 'journal', 'journal 优先于 state');
  assert.equal(sealRec.sealHash, s1.sealHash);
  assert.equal(sealRec.sealedAt, sealedAt);
  assert.equal(sealRec.layout, 6);
  assert.equal(sealRec.rows, 2);
  assert.match(String(sealRec.file), /11月第6周-75238718e41aA的周记账\.xlsx$/);

  // 封板 hash 可从台账 + 清册独立复算（WK-37 / P0-4）
  assert.equal(computeWeeklyFingerprint({ root, w: g.w, sessKey: g.sessKey, records: [rec1, rec2] }), s1.sealHash);

  // 已封板再写：skipped:sealed、字节与 mtime 都不动（WK-34）
  const beforeMtime = fs.statSync(s1.path).mtimeMs;
  const after = writeWeekly({ ...base, records: [rec1, rec2, mk(3, '2026-11-30T11:00:00+08:00')], mode: 'draft', generatedAt: '2026-12-05 00:00:00' });
  assert.equal(after.written, false);
  assert.equal(after.skipped, true);
  assert.equal(after.reason, 'sealed');
  assert.equal(after.sealHash, s1.sealHash);
  assert.equal(fs.statSync(s1.path).mtimeMs, beforeMtime);
  assert.equal(Buffer.compare(fs.readFileSync(s1.path), sealedBytes), 0);

  // 封板文件被删：仍 skip 不重建，且给 `sealed but file missing` 告警（WK-35）
  fs.unlinkSync(s1.path);
  const missing = writeWeekly({ ...base, records: [rec1, rec2] });
  assert.equal(missing.skipped, true);
  assert.equal(missing.reason, 'sealed');
  assert.equal(missing.warnings.some((w) => String(w.message).includes('sealed but file missing')), true);
  assert.equal(fs.existsSync(s1.path), false, '封板文件删了不许重建');
  fs.writeFileSync(s1.path, sealedBytes); // 还原，供后续断言语义完整

  // state 缓存丢失：journal 仍在 → 封板语义不变（P1-9：state 丢了只影响性能）
  fs.rmSync(path.join(root, 'ledger', '.state.json'));
  const stateLost = writeWeekly({ ...base, records: [rec1, rec2], mode: 'draft' });
  assert.equal(stateLost.skipped, true);
  assert.equal(stateLost.reason, 'sealed', 'journal 有封板证据 → 仍按已封板处理');
  assert.equal(readWeeklySeals(root)[s1.groupId].sealHash, s1.sealHash, 'state 丢了也能从 journal 判封板');
  assert.equal(readWeeklySeal(root, s1.groupId).sealHash, s1.sealHash);
  assert.equal(Buffer.compare(fs.readFileSync(s1.path), sealedBytes), 0);
  const evidence = readSealEvidence(root);
  assert.equal(evidence.seals[s1.groupId].sealHash, s1.sealHash);
  assert.equal(evidence.journal.readError, '');
  assert.equal(evidence.conflicts.length, 0, 'journal 与 state 无冲突（state 已删，仅 journal）');

  // state 丢失 + 只有草稿 xlsx（无 SEALED 文件头）→ 保守不重写 + state lost 告警（模板 7.5 第 4 条）
  const { root: root3 } = lab();
  const recC = mk(7, '2026-11-02T09:00:00+08:00');
  const g3 = [...groupRecords([recC], 480).values()][0];
  const draft3 = writeWeekly({ root: root3, w: g3.w, sessKey: g3.sessKey, records: [recC], mode: 'draft', generatedAt: '2026-11-09 12:00:00' });
  assert.equal(draft3.written, true);
  const draftBytes = fs.readFileSync(draft3.path);
  fs.rmSync(path.join(root3, 'ledger', '.state.json'), { force: true });
  const lostDraft = writeWeekly({ root: root3, w: g3.w, sessKey: g3.sessKey, records: [recC, mk(8, '2026-11-02T10:00:00+08:00')] });
  assert.equal(lostDraft.skipped, true);
  assert.equal(lostDraft.reason, 'state-lost');
  assert.equal(lostDraft.warnings.some((w) => String(w.message).includes('state lost')), true);
  assert.equal(Buffer.compare(fs.readFileSync(draft3.path), draftBytes), 0, 'state 丢失时已有 xlsx 一律不重写');

  // 自动封板：宽限期边界 = 该周最后一天 24:00 + 3 天（模板 7.2）
  const { root: root2 } = lab();
  const recA = mk(4, '2026-11-02T09:00:00+08:00'); // 第 2 周周一
  const g2 = [...groupRecords([recA], 480).values()][0];
  assert.equal(isSealDue({ w: g2.w, nowMs: g2.w.endMs }), false);
  const dueInfo = sealDueInfo({ w: g2.w, offsetMinutes: 480, nowMs: g2.w.endMs });
  assert.equal(dueInfo.due, false);
  assert.equal(dueInfo.dueAtMs, g2.w.endMs + 1 + 3 * 24 * 60 * 60 * 1000);
  assert.match(dueInfo.dueAt, /^2026-11-12 00:00:00$/);
  const notDue = writeWeekly({
    root: root2, w: g2.w, sessKey: g2.sessKey, records: [recA],
    nowMs: g2.w.endMs, generatedAt: '2026-11-09 00:00:00',
  });
  assert.equal(notDue.mode, 'draft');
  const due = writeWeekly({
    root: root2, w: g2.w, sessKey: g2.sessKey, records: [recA],
    prevHashes: { [notDue.groupId]: notDue.hash },
    nowMs: dueInfo.dueAtMs + 1000, generatedAt: '2026-11-12 00:00:01',
  });
  assert.equal(due.mode, 'sealed');
  assert.equal(due.sealed, true);
  assert.ok(fs.readFileSync(due.path, 'utf8').includes(SEALED_STATUS_TEXT));
});

// ---------------------------------------------------------------------------
// ④ 原始凭证四态 + 清册新旧格式兼容
// ---------------------------------------------------------------------------

test('④ 原始凭证四态：绑定 / 补记 / 已清理(RPT-…) / 缺凭证；清册新旧格式都兼容', () => {
  const { root } = lab();
  const r1 = mk(1, '2026-11-02T09:00:00+08:00'); // 周一：有效原文 + 三哈希 → 绑定
  const r2 = mk(2, '2026-11-03T09:00:00+08:00'); // 周二：有文件、记录不带 doc → 补记
  const r3 = mk(3, '2026-11-04T09:00:00+08:00'); // 周三：文件不在 + 新格式清册 → 已清理
  const r4 = mk(4, '2026-11-05T09:00:00+08:00'); // 周四：文件不在 + 清册无据 → 缺凭证
  const r5 = mk(5, '2026-11-06T09:00:00+08:00'); // 周五：旧格式清册 → 已清理
  const r6 = mk(6, '2026-11-07T09:00:00+08:00'); // 周六：旧 v0.4 行（无三哈希）→ legacy，永不 bound

  Object.assign(r1, putVerifiedOriginal(root, r1.code, r1.ts)); // P1-1 绑定证据
  putOriginal(root, r2.code, r2.ts); // 只补文件、台账没有 doc
  r6.doc = putOriginal(root, r6.code, r6.ts); // 文件在、声明了 doc，但缺 docFileSha256/attachment
  // v1.3 新格式明细行：| n | 编码 | 产生时间 | 已删除 | 备注 |
  fs.writeFileSync(path.join(root, 'RPT-20261108-01.md'),
    '# RPT-20261108-01 · 完整原文清理报告（清册）\n\n| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |\n|---|---|---|---:|---|---|\n' +
    '| n | 编码 | 产生时间 | 结论 | 备注 |\n|---|---|---|---|---|\n' +
    `| 1 | ${r3.code} | 2026-11-09 12:00:00 | 已删除 |  |\n` +
    `| 2 | ${r4.code} | 2026-11-09 12:01:00 | 跳过 | 用户保留 |\n`, 'utf8');
  // v0.4 旧格式明细行
  fs.writeFileSync(path.join(root, 'RPT-20261108-02.md'),
    '| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |\n|---|---|---|---:|---|---|\n' +
    `| \`${r5.code}\` | ${KEY} | 2026-11 | 1.0 KB | 已删除 |  |\n`, 'utf8');
  // dry-run 不参与「已清理」判定
  fs.writeFileSync(path.join(root, 'RPT-DRYRUN-20261109-01.md'),
    '| 1 | 20261108-75238718e41a-A-00000009 | 2026-11-09 12:00:00 | 已删除 |  |\n', 'utf8');

  const cleaned = readCleanedCodesCompat(root);
  assert.equal(cleaned.get(r3.code), 'RPT-20261108-01', 'v1.3 新格式清册必须解析');
  assert.equal(cleaned.has(r4.code), false, '结论=跳过 不得算已清理');
  assert.equal(cleaned.get(r5.code), 'RPT-20261108-02', 'v0.4 旧格式清册必须兼容');
  assert.equal(cleaned.has('20261108-75238718e41a-A-00000009'), false, 'dry-run 清册不算已清理');

  // 四态判定（纯函数层；P1-1：绑定必须复核实际文件）
  assert.equal(resolveDoc(root, r1, 480, cleaned).state, 'bound');
  assert.equal(resolveDoc(root, r2, 480, cleaned).state, 'backfilled');
  assert.equal(resolveDoc(root, r3, 480, cleaned).state, 'cleaned');
  assert.equal(resolveDoc(root, r4, 480, cleaned).state, 'missing');
  const legacy = resolveDoc(root, r6, 480, cleaned);
  assert.equal(legacy.state, 'missing', '旧 v0.4 行永不 bound');
  assert.equal(legacy.problems.includes('LEGACY_NO_ATTACHMENT'), true);
  assert.equal(originalLabel({ state: 'cleaned', report: 'RPT-20261108-01' }), '已清理(RPT-20261108-01)');

  // 十列表「原始凭证」列口径（渲染层）+ integrityFailures 只含 r6（合法清理不算篡改）
  const recs = [r1, r2, r3, r4, r5, r6];
  const g = [...groupRecords(recs, 480).values()][0];
  const model = buildWeeklyModel({ root, w: g.w, sessKey: g.sessKey, records: recs, generatedAt: '2026-11-09 12:00:00' });
  const sheets = model.sheets;
  const find = (name) => sheets.find((s) => s.name === name);
  assert.equal(rowOfCode(find('周一'), r1.code)[1], '绑定');
  assert.equal(rowOfCode(find('周二'), r2.code)[1], '补记');
  assert.equal(rowOfCode(find('周三'), r3.code)[1], '已清理(RPT-20261108-01)'); // 行不消失
  assert.equal(rowOfCode(find('周四'), r4.code)[1], '缺凭证');
  assert.equal(rowOfCode(find('周五'), r5.code)[1], '已清理(RPT-20261108-02)');
  assert.equal(rowOfCode(find('周六'), r6.code)[1], '缺凭证');
  // CH-02：只有 legacy 进 integrityFailures；清册合法删除的 r3/r5 不进
  assert.equal(model.integrityFailures.some((x) => x.code === r6.code && x.problems.includes('LEGACY_NO_ATTACHMENT')), true);
  assert.equal(model.integrityFailures.some((x) => x.code === r3.code || x.code === r5.code), false, '合法清理不得进 integrityFailures');
  // B 列全部匹配契约正则（半角括号）
  for (const s of sheets.filter((x) => /^周/.test(x.name))) {
    for (const row of dataRows(s)) assert.match(row[1], /^(绑定|补记|缺凭证|已清理\(RPT-\d{8}-\d{2}\))$/);
  }
  // P1-11：四态固定 B 列「原始凭证」；RPT 号只出现在 B 列，备注列不得写 RPT 号
  assert.equal(sheets.find((s) => s.name === '周三').rows[0][1], '原始凭证');
  for (const s of sheets.filter((x) => /^周/.test(x.name))) {
    for (const row of dataRows(s)) {
      assert.match(row[1], /^(绑定|补记|缺凭证|已清理\(RPT-\d{8}-\d{2}\))$/);
      assert.equal(row[9], EMPTY, '机器初值备注列必须是 —');
      if (String(row[1]).includes('RPT-')) assert.equal(String(row[9]).includes('RPT-'), false, 'RPT 号不得写进备注列');
    }
  }
});

// ---------------------------------------------------------------------------
// ⑤ 补记册
// ---------------------------------------------------------------------------

test('⑤ 补记册：一级落盘、只追加、编号连续、补记hash 可独立复算、不改正册', () => {
  const { root } = lab();
  const r1 = mk(1, '2026-11-02T09:00:00+08:00');
  const r2 = mk(2, '2026-11-03T09:00:00+08:00');
  const r3 = mk(3, '2026-11-04T09:00:00+08:00');
  putOriginal(root, r1.code, r1.ts); // 绑定
  r2.doc = putOriginal(root, r2.code, r2.ts); // 绑定

  // 先封一本正册，验证"写补记前后正册字节不变"（WK-43）
  const g = [...groupRecords([r1, r2], 480).values()][0];
  const sealed = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: [r1, r2], mode: 'sealed', sealedAt: '2026-11-12 00:00:00' });
  const bookBefore = crypto.createHash('sha256').update(fs.readFileSync(sealed.path)).digest('hex');

  const s1 = writeSupplement({
    root, codes: [r1.code, r2.code], records: [r1, r2],
    reason: '封板后才发现', generatedAt: '2026-11-13 09:00:00', offsetMinutes: 480,
  });
  assert.equal(s1.path, path.join(root, '补记-20261113.md'));
  assert.equal(path.dirname(s1.path), root, '补记册必须落一级目录');
  assert.equal(s1.added, 2);
  assert.equal(s1.total, 2);
  assert.equal(s1.written, true);

  const bytes1 = fs.readFileSync(s1.path);
  // WK-39：UTF-8 无 BOM、LF
  assert.notEqual(bytes1.subarray(0, 3).toString('hex'), 'efbbbf', '不得带 UTF-8 BOM');
  assert.equal(bytes1.toString('utf8').includes('\r'), false, '必须 LF 换行');
  const text1 = bytes1.toString('utf8');
  // 文件头（YAML）
  assert.match(text1, /^---\n名称: "补记-20261113"\n补记日期: "2026-11-13"\n生成器: /);
  assert.ok(text1.includes('# 2026-11-13 补记册'));
  // 每条 block：6 个字段 + 10 列表格行（WK-40）
  for (const col of SUPPLEMENT_COLUMNS) assert.ok(text1.includes(col), `补记册缺列名：${col}`);
  assert.ok(text1.includes('## 补记-20261113-01'));
  assert.ok(text1.includes('## 补记-20261113-02'));
  for (const code of [r1.code, r2.code]) assert.ok(text1.includes(`- 原编码: ${code}`));
  assert.ok(text1.includes('- 原时间: 2026-11-02 09:00:00'));
  assert.ok(text1.includes('- 所属正册: 2026年11月/11月第2周-75238718e41aA的周记账.xlsx（已封板）'));
  assert.ok(text1.includes('- 被补记原因: 封板后才发现'));
  assert.match(text1, /- 补记hash: [0-9a-f]{64}/);

  // 补记hash = 该行 10 字段以 \t 连接后 sha256；补记册可独立复算（WK-42）
  const parsed1 = parseSupplementBook(text1);
  assert.equal(parsed1.entries.length, 2);
  for (const e of parsed1.entries) {
    assert.equal(e.values.length, 10);
    assert.equal(supplementEntryHash(e.values), e.hash);
  }
  const v1 = verifySupplementBook(text1);
  assert.equal(v1.ok, true, JSON.stringify(v1.issues));
  assert.equal(v1.entries.length, 2);
  // 幂等：同参数再写 → 不追加
  const again = writeSupplement({
    root, codes: [r1.code, r2.code], records: [r1, r2],
    reason: '封板后才发现', generatedAt: '2026-11-13 09:05:00',
  });
  assert.equal(again.written, false);
  assert.equal(again.added, 0);
  assert.equal(fs.readFileSync(s1.path, 'utf8'), text1);

  // 只追加：新条目追加后，旧字节前缀完全不变；编号 03 连续（WK-41/WK-43）
  const s2 = writeSupplement({
    root, codes: [r3.code], records: [r3],
    reason: '封板后才发现', generatedAt: '2026-11-13 10:00:00',
  });
  assert.equal(s2.added, 1);
  assert.equal(s2.total, 3);
  const text2 = fs.readFileSync(s2.path, 'utf8');
  assert.equal(text2.startsWith(text1), true, '补记册只追加，旧字节必须一字不变');
  assert.ok(text2.includes('## 补记-20261113-03'));
  assert.equal(verifySupplementBook(text2).ok, true);

  // 正册字节不变（WK-43）
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sealed.path)).digest('hex'), bookBefore);
});

// ---------------------------------------------------------------------------
// ⑥ xlsx 解包冒烟 + 封板hash 只凭文件复算
// ---------------------------------------------------------------------------

test('⑥ 解包冒烟：ZIP 结构完整、sheet XML 解得出、关键字符串都在、封板hash 可只凭文件复算（stored+deflate）', () => {
  const { root } = lab();
  const ts = '2026-11-04T10:00:00+08:00';
  const rec = mk(1, ts);
  rec.doc = putOriginal(root, rec.code, ts);
  const rec2 = mk(2, '2026-11-05T14:20:00+08:00', { status: 'partial' });
  const g = [...groupRecords([rec, rec2], 480).values()][0];
  const r = writeWeekly({
    root, w: g.w, sessKey: g.sessKey, records: [rec, rec2],
    mode: 'sealed', sealedAt: '2026-11-12 00:00:00', generatedAt: '2026-11-12 00:00:00',
  });
  assert.equal(r.written, true);
  assert.equal(r.sealed, true);

  const entries = unzip(fs.readFileSync(r.path));

  // 1) 必备部件齐全（9 张表 + 骨架文件 + styles）
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
    assert.ok(entries.has(name), `缺 ${name}`);
  }
  for (let i = 1; i <= 9; i++) assert.ok(entries.has(`xl/worksheets/sheet${i}.xml`), `缺 sheet${i}.xml`);

  // 2) workbook.xml：9 张表名 + 打开即重算
  const wbXml = entries.get('xl/workbook.xml').toString('utf8');
  for (const name of ['说明', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周统计']) {
    assert.ok(wbXml.includes(`name="${name}"`), `workbook 缺表名 ${name}`);
  }
  assert.match(wbXml, /fullCalcOnLoad="1"/);

  // 3) 日表：表头、DV、A1:J121、freeze A2（WK-08/WK-09/WK-10）
  const dayXml = entries.get('xl/worksheets/sheet2.xml').toString('utf8');
  for (const col of TEN_COLUMNS) assert.ok(dayXml.includes(col), `日表 XML 缺表头：${col}`);
  assert.match(dayXml, /<dimension ref="A1:J121"\/>/);
  assert.match(dayXml, /<dataValidations count="4">/);
  assert.match(dayXml, /sqref="A2:A121"/);
  assert.match(dayXml, /<pane ySplit="1" topLeftCell="A2"[^>]*\/>/);
  assert.match(dayXml, /<row r="121" spans="1:10">/);
  assert.match(dayXml, /<c r="J121"\/>/);

  // 4) 周统计：I 列公式与 SUM、溢出行（WK-26~WK-30）
  const statsXml = entries.get('xl/worksheets/sheet9.xml').toString('utf8');
  assert.match(statsXml, /COUNTA\(周一!\$A\$2:\$A\$121\)/);
  assert.match(statsXml, /COUNTIF\(周一!\$I\$2:\$I\$121,&quot;通过&quot;\)/);
  assert.match(statsXml, /COUNTIF\(周一!\$I\$2:\$I\$121,&quot;待审&quot;\)/);
  assert.match(statsXml, /SUM\(C5:C11\)/);
  assert.match(statsXml, /溢出（未写入本册）/);

  // 5) 说明页：已封板标记 + A4 hash 可被"只扫字节"认出
  const infoXml = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(infoXml.includes(SEALED_STATUS_TEXT));
  assert.equal(infoXml.includes(DRAFT_STATUS_TEXT), false);
  const marker = readSealedMarker(r.path);
  assert.equal(marker.sealHash, r.sealHash);
  assert.equal(marker.sealedAt, '2026-11-12 00:00:00');

  // 6) 独立复算：只凭解包出来的 sheet XML 还原机器列 JSON → sha256，必须等于 A4
  assert.equal(recomputeSealHashFromXlsx(entries), r.sealHash, '封板hash 必须能只凭 xlsx 复算');

  // 7) deflate 路径：zlib.inflateRawSync 解压后的 XML 与 stored 版逐字节一致
  const model = buildWeeklyModel({ root, w: g.w, sessKey: g.sessKey, records: [rec, rec2], generatedAt: 'x' });
  const deflated = buildXlsx(model.sheets, { method: 'deflate' });
  const entries2 = unzip(deflated);
  assert.equal(
    entries2.get('xl/workbook.xml').toString('utf8'),
    entries.get('xl/workbook.xml').toString('utf8'),
    'zlib 解压后的 workbook.xml 应与 stored 版一致',
  );
  assert.equal(
    entries2.get('xl/worksheets/sheet2.xml').toString('utf8'),
    entries.get('xl/worksheets/sheet2.xml').toString('utf8'),
    'zlib 解压后的日表 XML 应与 stored 版一致',
  );
  assert.equal(
    entries2.get('xl/worksheets/sheet9.xml').toString('utf8'),
    entries.get('xl/worksheets/sheet9.xml').toString('utf8'),
    'zlib 解压后的周统计 XML 应与 stored 版一致',
  );
});

// ---------------------------------------------------------------------------
// 附加：封板 hash 只认机器列，不随生成时间/人工批注漂移
// ---------------------------------------------------------------------------

test('附加：封板 hash 不含生成时间/人工列；内容指纹含版式版本', () => {
  const { root } = lab();
  const rec = mk(1, '2026-11-04T10:00:00+08:00');
  const g = [...groupRecords([rec], 480).values()][0];
  const h1 = computeWeeklyFingerprint({ root, w: g.w, sessKey: g.sessKey, records: [rec] });
  const h2 = computeWeeklyFingerprint({ root, w: g.w, sessKey: g.sessKey, records: [rec] });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);

  const a = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: [rec], generatedAt: '2026-11-09 00:00:00' });
  const { root: root2 } = lab();
  const b = writeWeekly({ root: root2, w: g.w, sessKey: g.sessKey, records: [rec], generatedAt: '2026-12-31 23:59:59' });
  assert.equal(a.hash, b.hash, '生成时间不同，内容指纹不应漂移');

  const sealed = writeWeekly({
    root: root2, w: g.w, sessKey: g.sessKey, records: [rec],
    mode: 'sealed', generatedAt: '2026-12-31 23:59:59', sealedAt: '2026-12-31 23:59:59',
  });
  assert.equal(sealed.sealHash, h1, '封板hash == 只覆盖机器列的正文指纹');

  // 封板后再补一条记录（补记场景）：封板 hash 仍按"封板时那批行"口径可复算
  const rec2 = mk(2, '2026-11-04T11:00:00+08:00');
  assert.notEqual(computeWeeklyFingerprint({ root: root2, w: g.w, sessKey: g.sessKey, records: [rec, rec2] }), h1);
  // 但封板文件不重写：skipped:sealed
  const skip = writeWeekly({ root: root2, w: g.w, sessKey: g.sessKey, records: [rec, rec2] });
  assert.equal(skip.skipped, true);
  assert.equal(skip.reason, 'sealed');
});

// ---------------------------------------------------------------------------
// 附加2：单日超 120 行 → 前 120 行 + 周统计第 13 行溢出计数（不静默丢行）
// ---------------------------------------------------------------------------

test('附加2：单日 121 条 → 只落 120 行、周统计 C13=1（数字字面量）并告警', () => {
  const { root } = lab();
  const ts = '2026-11-02T09:00:00+08:00'; // 第 2 周周一
  const recs = [];
  for (let i = 1; i <= 121; i++) recs.push(mk(i, ts));
  const g = [...groupRecords(recs, 480).values()][0];
  const model = buildWeeklyModel({ root, w: g.w, sessKey: g.sessKey, records: recs, generatedAt: '2026-11-09 12:00:00' });
  assert.equal(model.total, 120, '日表上限 120 行，只落前 120 条');
  assert.equal(model.overflow, 1, '溢出必须计数');
  assert.equal(model.warnings.length, 1);
  assert.deepEqual(model.warnings[0], {
    type: 'overflow', day: '周一', date: '2026-11-02', dropped: 1, message: 'weekly overflow day=2026-11-02 dropped=1',
  });
  const mon = model.sheets.find((s) => s.name === '周一');
  const rows = dataRows(mon);
  assert.equal(rows.length, 120, '周一表应恰好 120 条机器行');
  assert.equal(rows[119][0].endsWith('00000120'), true);
  assert.equal(rows.some((r) => r[0].endsWith('00000121')), false, '第 121 条不得静默入表');
  assert.equal(mon.rows.length, 121, '表头 1 + 机器行 120 = 121 行');
  const stats = model.sheets.find((s) => s.name === '周统计');
  assert.equal(stats.rows[12][0], '溢出（未写入本册）');
  assert.equal(stats.rows[12][2], 1, 'C13 为数字字面量 = 实际溢出条数');
  assert.equal(stats.rows[11][2].v, 120, '合计记录数 = 实际写入行数（不含溢出）');
  const r = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: recs, mode: 'draft', generatedAt: '2026-11-09 12:00:00' });
  assert.equal(r.overflow, 1);
  assert.equal(r.warnings[0].type, 'overflow');
});

// ---------------------------------------------------------------------------
// 附加3：同一编码被传两遍 → 只落一行（多一道闸，去重计数可审计）
// ---------------------------------------------------------------------------

test('附加3：同编码重复传入 → 只落 1 行 + duplicate-code 告警（不重复记账）', () => {
  const { root } = lab();
  const rec = mk(1, '2026-11-02T09:00:00+08:00');
  const g = [...groupRecords([rec], 480).values()][0];
  const dup = [rec, { ...rec }]; // 同 code 两条（模拟调用方把同一批记录传两遍）
  const model = buildWeeklyModel({ root, w: g.w, sessKey: g.sessKey, records: dup, generatedAt: '2026-11-09 12:00:00' });
  assert.equal(model.total, 1, '同编码只落一行');
  assert.equal(model.warnings.some((w) => w.type === 'duplicate-code' && w.dropped === 1), true);
  const mon = model.sheets.find((s) => s.name === '周一');
  assert.equal(dataRows(mon).length, 1);
  const r = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: dup, mode: 'draft', generatedAt: '2026-11-09 12:00:00' });
  assert.equal(r.written, true);
  assert.equal(r.warnings.some((w) => w.type === 'duplicate-code'), true);
  const info = r.path && fs.readFileSync(r.path, 'utf8');
  assert.match(String(info), /记录数: 1/);
});

// ---------------------------------------------------------------------------
// P0-4：溢出有去向 + 120/121/122 封板哈希互异（审计探针 f8d5be43… 回归）
// ---------------------------------------------------------------------------

test('P0-4：源 120/121/122 封板哈希互不相同；溢出先写补记再封板；journal 行即不可变快照', () => {
  const ts = '2026-11-02T09:00:00+08:00';
  const results = {};
  for (const n of [120, 121, 122]) {
    const { root } = lab();
    const recs = Array.from({ length: n }, (_, i) => mk(i + 1, ts));
    const g = [...groupRecords(recs, 480).values()][0];
    const r = writeWeekly({
      root, w: g.w, sessKey: g.sessKey, records: recs, mode: 'sealed',
      generatedAt: '2026-11-12 00:00:00',
    });
    assert.equal(r.overflow, n - 120);
    assert.equal(r.sourceRowCount, n);
    results[n] = { root, g, r, recs };
  }
  const hs = [results[120].r.sealHash, results[121].r.sealHash, results[122].r.sealHash];
  assert.equal(new Set(hs).size, 3, '120/121/122 三个封板哈希必须互不相同');
  assert.match(hs[0], /^[0-9a-f]{64}$/);

  // 121：canonical 字段 + 溢出补记去向 + journal 行内快照
  const { root, g, r } = results[121];
  const ev = latestSealEvent(root, 'weekly-seal', r.groupId);
  assert.ok(ev, '必须有 weekly-seal 事件');
  assert.equal(ev.canonicalVersion, 8);
  assert.equal(ev.sourceRowCount, 121);
  assert.equal(ev.overflow, 1);
  assert.equal(ev.rows.length, 120);
  assert.equal(ev.rowCount, 120);
  assert.equal(ev.rowsSha256, sha256Hex(stableJson(ev.rows)));
  assert.equal(Array.isArray(ev.supplement.codes), true);
  assert.equal(ev.supplement.codes.length, 1);
  assert.match(String(ev.supplement.file), /^补记-\d{8}\.md$/);
  assert.equal(ev.supplementCodesSha256, supplementCodesSha256(ev.supplement.codes));
  const bookPath = path.join(root, ev.supplement.file);
  assert.equal(fs.existsSync(bookPath), true);
  const bookText = fs.readFileSync(bookPath, 'utf8');
  const book = parseSupplementBook(bookText);
  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0].reason, 'overflow-seal');
  assert.equal(ev.supplement.codes.includes(book.entries[0].code), true);
  assert.equal(verifySupplementBook(bookText).ok, true);

  // 闭合校验（正册∪补记==源、交集空、120+overflow==sourceRowCount）
  const model121 = buildWeeklyModel({ root, w: g.w, sessKey: g.sessKey, records: results[121].recs, generatedAt: '2026-11-12 00:00:00' });
  const closure = validateOverflowClosure({ days: model121.days, overflow: model121.overflow, sourceRowCount: model121.sourceRowCount, supplementCodes: ev.supplement.codes });
  assert.equal(closure.ok, true, JSON.stringify(closure.errors));
  assert.equal(closure.checks.rowCount + closure.checks.overflow, closure.checks.sourceRowCount);
  assert.equal(closure.checks.union, closure.checks.sourceRowCount);
  const badClosure = validateOverflowClosure({ days: model121.days, overflow: model121.overflow, sourceRowCount: closure.checks.sourceRowCount, supplementCodes: [] });
  assert.equal(badClosure.ok, false, '溢出编码缺失必须被闭合校验抓到');

  // 黑盒复算：封板 hash 落在补记后仍可由台账+清册重建
  assert.equal(computeWeeklyFingerprint({ root, w: g.w, sessKey: g.sessKey, records: results[121].recs }), r.sealHash);
  assert.equal(computeWeeklyFingerprint({ root: results[122].root, w: results[122].g.w, sessKey: results[122].g.sessKey, records: results[122].recs }), results[122].r.sealHash);

  // journal 链完整；不写第二份快照目录
  assert.equal(verifySealChain(root).ok, true);
  assert.equal(fs.existsSync(path.join(root, 'ledger', 'seals')), false);

  // 120 无溢出 → supplement=null，且没有补记册
  const ev120 = latestSealEvent(results[120].root, 'weekly-seal', results[120].r.groupId);
  assert.equal(ev120.overflow, 0);
  assert.equal(ev120.supplement, null);
  assert.equal(fs.existsSync(path.join(results[120].root, '补记-20261112.md')), false);

  // 125 条 → 120 正册 + 5 补记（P0-4 验收样例）
  const { root: root125 } = lab();
  const recs125 = Array.from({ length: 125 }, (_, i) => mk(i + 1, ts));
  const g125 = [...groupRecords(recs125, 480).values()][0];
  const r125 = writeWeekly({ root: root125, w: g125.w, sessKey: g125.sessKey, records: recs125, mode: 'sealed', generatedAt: '2026-11-12 00:00:00' });
  assert.equal(r125.overflow, 5);
  assert.equal(r125.sourceRowCount, 125);
  const ev125 = latestSealEvent(root125, 'weekly-seal', r125.groupId);
  assert.equal(ev125.rows.length, 120);
  assert.equal(ev125.supplement.codes.length, 5);
  const book125 = parseSupplementBook(fs.readFileSync(path.join(root125, ev125.supplement.file), 'utf8'));
  assert.equal(book125.entries.length, 5);
  assert.equal(verifySealChain(root125).ok, true);

  // P1-9：同库两次封板成链；删 state 后仍以 journal 判封板
  const { root: rootChain } = lab();
  const groupFor = (prefix, n) => {
    const codeOf = (i) => `20261108-${prefix}-A-${String(i).padStart(8, '0')}`;
    const recs = Array.from({ length: n }, (_, i) => ({ ...mk(i + 1, ts), code: codeOf(i + 1) }));
    const gg = [...groupRecords(recs, 480).values()][0];
    const rr = writeWeekly({ root: rootChain, w: gg.w, sessKey: gg.sessKey, records: recs, mode: 'sealed', generatedAt: '2026-11-12 00:00:00' });
    return { gg, rr };
  };
  groupFor('aaaaaaaaaaaa', 120);
  groupFor('bbbbbbbbbbbb', 121);
  const chain = verifySealChain(rootChain);
  assert.equal(chain.ok, true);
  assert.equal(chain.events, 2);
  const events = readSealEvents(rootChain).events;
  assert.equal(events[1].prevSealSha256, sha256Hex(JSON.stringify(events[0])));
  fs.rmSync(path.join(rootChain, 'ledger', '.state.json'), { force: true });
  assert.equal(readSealEvidence(rootChain).conflicts.length, 0);
  assert.equal(readSealEvidence(rootChain).journal.readError, '');
  assert.equal(Object.keys(readWeeklySeals(rootChain)).length, 2);
});

// ---------------------------------------------------------------------------
// P1-6：补记编号 \d+（99/100/101 不丢不重）+ 截断尾块恢复 + 未知块不忽略
// ---------------------------------------------------------------------------

test('P1-6：补记编号 99/100/101 连续不丢不重；截断尾块可恢复；验证器不忽略未知块', () => {
  const ts = '2026-11-02T09:00:00+08:00';
  const { root } = lab();
  const recs = Array.from({ length: 101 }, (_, i) => mk(i + 1, ts));
  const wc = writeSupplement({ root, codes: recs.map((r) => r.code), records: recs, generatedAt: '2026-11-13 09:00:00' });
  assert.equal(wc.added, 101);
  const text = fs.readFileSync(wc.path, 'utf8');
  const parsed = parseSupplementBook(text);
  assert.equal(parsed.entries.length, 101, '第 100/101 条不得被忽略');
  const ids = parsed.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, 101, '编号不得重复');
  assert.equal(ids.includes('补记-20261113-100'), true);
  assert.equal(ids.includes('补记-20261113-101'), true);
  assert.equal(ids[ids.length - 1], '补记-20261113-101');
  assert.equal(verifySupplementBook(text).ok, true);
  // 继续追加 → 102/103 接续
  const more = [mk(102), mk(103)];
  const wc2 = writeSupplement({ root, codes: more.map((r) => r.code), records: more, generatedAt: '2026-11-13 09:10:00' });
  assert.equal(wc2.added, 2);
  const text2 = fs.readFileSync(wc2.path, 'utf8');
  assert.ok(text2.includes('## 补记-20261113-102'));
  assert.ok(text2.includes('## 补记-20261113-103'));
  assert.equal(verifySupplementBook(text2).ok, true);

  // 截断尾块恢复：保留前 4 块完整字节，从第 5 块尾截断
  const { root: root2 } = lab();
  const five = Array.from({ length: 5 }, (_, i) => mk(i + 1, ts));
  const a = writeSupplement({ root: root2, codes: five.map((r) => r.code), records: five, generatedAt: '2026-11-13 09:00:00' });
  const full = fs.readFileSync(a.path, 'utf8');
  const prefix4 = full.slice(0, full.lastIndexOf('## ')); // 第 5 块之前 = 完整前缀
  const cut = full.slice(0, full.length - 45);            // 砍掉第 5 块尾部
  fs.writeFileSync(a.path, cut, 'utf8');
  const next = [mk(6)];
  const b = writeSupplement({ root: root2, codes: next.map((r) => r.code), records: next, generatedAt: '2026-11-13 10:00:00' });
  assert.equal(b.warnings.some((w) => w.type === 'tail-repaired'), true, '必须报告尾块恢复');
  const text3 = fs.readFileSync(b.path, 'utf8');
  assert.equal(text3.startsWith(prefix4), true, '完整前缀字节不得变');
  assert.equal(verifySupplementBook(text3).ok, true);
  assert.equal(parseSupplementBook(text3).entries.length, 5);
  const ids3 = parseSupplementBook(text3).entries.map((e) => e.id);
  assert.equal(ids3[ids3.length - 1], '补记-20261113-05', '恢复后编号接续，不重复');

  // 未知块不得被忽略
  const tampered = text3 + '\n## 补记-乱块\n\n- 无字段\n';
  const vBad = verifySupplementBook(tampered);
  assert.equal(vBad.ok, false);
  assert.equal(vBad.issues.some((i) => i.type === 'unknown-block'), true);
});

// ---------------------------------------------------------------------------
// P1-10：清册「已清理」按结论列判定（备注出现“已删除”不得误判）
// ---------------------------------------------------------------------------

test('P1-10：清册已清理按结论列判定（新旧 schema；备注含“已删除”不算）', () => {
  const { root } = lab();
  fs.mkdirSync(root, { recursive: true });
  const code = (n) => `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`;
  fs.writeFileSync(path.join(root, 'RPT-20261108-01.md'),
    '| # | 编码 | 产生时间（UTC+08:00） | 结论 | 备注 |\n| ---: | :--- | :--- | :--- | :--- |\n' +
    `| 1 | ${code(1)} | 2026-11-09 12:00:00 | 已删除 | 备注乱写：已删除后又恢复 |\n` +
    `| 2 | ${code(2)} | 2026-11-09 12:01:00 | 跳过 | 备注里也写已删除 |\n` +
    `| 3 | ${code(3)} | 2026-11-09 12:02:00 | 未删除 | 已删除（误）|\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'RPT-20261108-02.md'),
    '| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |\n|---|---|---|---:|---|---|\n' +
    `| \`${code(4)}\` | ${KEY} | 2026-11 | 1 KB | 已删除 |  |\n` +
    `| \`${code(5)}\` | ${KEY} | 2026-11 | 1 KB | 跳过 | 备注写已删除 |\n`, 'utf8');
  const cleaned = readCleanedCodesCompat(root);
  assert.equal(cleaned.get(code(1)), 'RPT-20261108-01');
  assert.equal(cleaned.has(code(2)), false, '结论=跳过 不得算已清理（哪怕备注有已删除）');
  assert.equal(cleaned.has(code(3)), false, '结论=未删除 不得算已清理');
  assert.equal(cleaned.get(code(4)), 'RPT-20261108-02', 'v0.4 旧格式兼容');
  assert.equal(cleaned.has(code(5)), false);
  assert.equal(cleaned.size, 2);
});

// ============================================================================
// CH-18 / 审计 #3：状态不明（封板标记无法解析）→ E_SEAL_UNKNOWN 只报不改
// ============================================================================

test('CH-18：文件在但封板标记无法解析 → E_SEAL_UNKNOWN，跳过且字节一个不改', () => {
  // 契约原文：任何"状态不明"（state 缺封板记录/文件头无法解析）→ 一律不得重写已存在周记账
  //   （无论 prevHash 是否存在）；journal 也无该组记录且文件存在 → 报 E_SEAL_UNKNOWN、字节不变。
  // 再现的真实场景：Excel 重存/文件损坏后，封板标记读不出来，而 state 里的封板记录又丢了。
  const { root } = lab();
  const recs = [mk(1, '2026-11-30T10:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];

  // 先写一份正常草稿，拿到真实路径
  const d = writeWeekly({
    root, w: g.w, sessKey: g.sessKey, records: recs, mode: 'draft', generatedAt: '2026-11-30 10:05:00',
  });
  assert.equal(fs.existsSync(d.path), true, '前提：草稿文件必须已存在');

  // 把它替换成"含封板字样、但解析不出标记"的残文件
  fs.writeFileSync(d.path, SEALED_STATUS_TEXT + '\n（这一行让标记无法解析）\n', 'utf8');
  const before = fs.readFileSync(d.path);

  const r = writeWeekly({
    root, w: g.w, sessKey: g.sessKey,
    records: [recs[0], mk(2, '2026-11-30T11:00:00+08:00')],
    mode: 'sealed', generatedAt: '2026-11-30 12:00:00', sealedAt: '2026-11-30 12:00:00',
  });

  assert.equal(r.written, false, '状态不明时绝不允许写');
  assert.equal(r.skipped, true, '必须是"跳过"而不是"写入"');
  assert.equal(r.reason, 'E_SEAL_UNKNOWN', '必须给出契约错误码，实际=' + r.reason);
  assert.deepEqual(
    fs.readFileSync(d.path), before,
    '文件字节必须一个不改（否则就是覆盖了可能带人工批注的已封板册）'
  );
  assert.equal((r.warnings || []).some((w) => w.type === 'E_SEAL_UNKNOWN'), true, '必须留下 E_SEAL_UNKNOWN 告警');
});


// ============================================================================
// INV-15/17/19/20（审计 A-04）：canonical 必须把 sourceRowCount/overflow/补记码摘要算进去
// ============================================================================

test('INV-15/17：只有 sourceRowCount / overflow / 补记码不同、正册行完全相同时，封板 hash 也必须互异', () => {
  // 守的正是审计 A-04：「不同数据集得到相同封板哈希」——
  // 若 canonical 不含这三样，120 行 vs 121 行（溢出 0 vs 1）会算出同一个 hash，
  // 封板就完全失去"证明这批数据没被换过"的能力。
  const rows = [['20261109-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']];
  const base = { sessKey: 'aaaaaaaaaaaaA', year: 2026, month: 11, weekNo: 1, offsetMinutes: 480, rows };
  const h = (sourceRowCount, overflow, supplementCodes) => sealjournal.weeklyCanonical({
    ...base, sourceRowCount, overflow, supplementCodes,
  });

  const a = h(120, 0, []);
  const b = h(121, 1, ['20261109-aaaaaaaaaaaa-A-00000121']);
  assert.notEqual(a, b, '源行数/溢出不同但 hash 相同 = 封板可撞车（A-04 复发）');

  // 逐项隔离：只差一样也必须互异
  assert.notEqual(a, h(121, 0, []), '只差 sourceRowCount 也必须互异');
  assert.notEqual(a, h(120, 1, []), '只差 overflow 也必须互异');
  assert.notEqual(a, h(120, 0, ['x']), '只差补记码集合也必须互异');

  // 完全相同的输入必须稳定（可复算）
  assert.equal(a, h(120, 0, []), '同输入必须同输出');
});


// ============================================================================
// 审计 #4（2026-11-09）：封板 journal 追加必须补尾行换行 + 写后回读
// ============================================================================

test('审计#4：journal 末尾是半行（上次崩在写行中途）→ 追加前取证+截断（re3 K-6），新封板必须可读', () => {
  // 守的是"写成功 ≠ 可读"：原实现 `open(file,'a')` 直接 append，
  // 上次崩在行中途留下的半截 JSON 会和新事件粘成一条 → 整本 journal 永久 badLine。
  // ★ v1.0.0-re3（审计② P2-10 / K-6）：修复策略与主账本对齐——**先取证到 `.quarantine/` 再截断**，
  //   不再"补一个换行把半行留成永久坏行"（旧口径下损失虽然可见，但永远好不了）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tail-'));
  const jp = sealjournal.sealJournalPath(root);
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  // 一条完好事件 + 一条"写到一半"的事件（没有结尾换行）
  const good = JSON.stringify({ v: 1, kind: 'weekly-seal', key: 'old-key', sealHash: 'a'.repeat(64) });
  const half = '{"v":1,"kind":"weekly-seal","key":"half';
  fs.writeFileSync(jp, good + '\n' + half, 'utf8');

  const res = sealjournal.appendSealEvent(root, {
    kind: 'weekly-seal', key: 'new-key', gid: '2026-11-1|x',
    file: '2026年11月/11月第1周-x的周记账.xlsx',
    sealedAt: '2026-11-09 10:00:00', sourceRowCount: 0, overflow: 0,
    rows: [], sealHash: 'b'.repeat(64),
  });
  assert.equal(res.ok, true, '追加必须成功：' + (res.reason || ''));
  assert.equal(res.written, true);
  assert.ok(res.tornTailRepaired, '撕裂尾修复必须留痕（tornTailRepaired），不许静默改册');
  const evAbs = path.join(path.dirname(jp), res.tornTailRepaired.evidence);
  assert.equal(fs.existsSync(evAbs), true, '半行证据必须落在 .quarantine/：' + evAbs);

  const read = sealjournal.readSealEvents(root);
  assert.equal(read.readError, '', 'journal 必须可读');
  assert.equal(
    read.events.some((e) => e.key === 'new-key'),
    true,
    '新封板必须真的落进 journal 且可解析（写成功 ≠ 可读）'
  );
  assert.equal(
    read.badLines, 0,
    `半行已取证并截断，不应再留成永久坏行（损失在 .quarantine/ 可见），实际 badLines=${read.badLines}`
  );
  const raw = fs.readFileSync(jp, 'utf8');
  assert.equal(raw.endsWith('\n'), true, 'journal 文件必须以换行结尾（否则下一次追加还会粘行）');
  assert.equal(raw.includes(half), false, '半行必须已从正册移出（证据在 .quarantine/）');
  assert.equal(raw.startsWith(good + '\n'), true, '取证+截断不得改动任何既有完整行');

  fs.rmSync(root, { recursive: true, force: true });
});


