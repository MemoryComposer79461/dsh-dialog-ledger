/**
 * @file 自测-094接线.mjs
 * @role 0.9.4-re1（P3 接线）自测：只守 **index.js 把三块 P3 功能接进 tick**，不重复测 lib/ 自己的实现。
 *
 * 守什么（对应用户交付口径的四条红线）：
 *   ① 周账：tick 内改走 `runWeeklyBudget()` 后，同一份数据产出的周账内容指纹/字节与
 *      "0.9.4-snap 直接调用库函数"一致；`stat.weeklyDeferred` 如实出现并落 .tick-metrics。
 *   ② 月账：周账写盘后生成"当月"`MM月账.md`（派生视图）；tick2 指纹不变不重写；失败只 warn。
 *   ③ 索引：tick 末尾按条件增量 `buildIndex({root, sinceYmd: 今天})`；`stat.index={built,rows,ms}`；
 *      失败只 warn、不回滚、不报红。
 *   ④ 既有语义不回归：stat 既有字段一个不删；journal 坏行仍是既有 errors 口径；台账照常入账。
 *
 * 运行（仓库根目录）：
 *   node docs/自测-094接线.mjs
 *
 * 隔离纪律（同其它自测）：临时 DSH_HOME / 临时 root；合成 zstd 会话；每用例 finally 删整棵目录；
 * 不跑 E3 / 不读真实账库。轻量串行：8 条用例，单次 < 2 s。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { runOnce, __test__ as idxTest } from '../index.js';
import { readAll } from '../lib/ledger.js';
import { readState } from '../lib/ledger.js';
import { readTickMetrics } from '../lib/tickmetrics.js';
import { weekOf } from '../lib/week.js';
import {
  groupRecords,
  writeWeekly,
  readWeeklySeals,
  readSealJournalState,
  buildMonthlyView,
  writeMonthlyView,
} from '../lib/weekly.js';
import { buildIndex, indexDir } from '../tools/pointerindex.mjs';

// ============================================================================
// 一、夹具基础设施（临时目录，跑完即删）
// ============================================================================

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';

const zframe = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const startLine = (turn, time) => JSON.stringify({ type: 'turn/start', time, data: { turn } });
const endLine = (turn, time) => JSON.stringify({ type: 'turn/end', time, data: { turn, reason: { kind: 'stop' } } });

/** 建临时 DSH_HOME + 数据根，跑完恢复 env、删目录。 */
async function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wire094-'));
  const dshHome = path.join(base, 'dsh-home');
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ base, dshHome, root });
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/**
 * 合成一个"现在刚结束"的会话（turns 个已闭合轮次）。
 * @why 用 now 附近的时间：tick 才会写"今天"的台账日文件 —— 这是索引"当日分片"与月账"当月"的前提。
 */
function writeFreshSession(dshHome, { turns = 2 } = {}) {
  const now = Date.now();
  const dir = path.join(dshHome, 'sessions', '--lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const head = JSON.stringify({ type: 'session', id: SID, createdAt: now - 3600_000, cwd: 'C:\\lab', agentPreset: 'lab' });
  const frames = [[head]];
  for (let t = 1; t <= turns; t++) {
    const at = now - (turns - t + 1) * 300_000;
    frames.push([startLine(t, at), endLine(t, at + 5_000)]);
  }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map(zframe)));
}

const fakeLogger = () => ({ info: () => {}, warn: () => {} });

/** runOnce 需要的"已解析配置"（直接走 readConfig，保证 weeklyEnabled=true 等默认口径）。 */
function makeCfg(root, over = {}) {
  return idxTest.readConfig({
    root,
    hotWindowSeconds: 0,
    quietSeconds: 0,
    scanBudgetMs: 30000,
    checkupEnabled: false,
    receiptAnchorRoot: '',
    ...over,
  });
}

/** 跑一轮 tick（每轮复位进程内对账节流，保证 run-report 每轮都写）。 */
async function tick(cfg) {
  idxTest.resetPeriodicThrottle();
  return runOnce({ logger: fakeLogger() }, cfg);
}

/** 某毫秒在 +08:00 下的年月与 YYYYMMDD。 */
function ymdParts(ms) {
  const d = new Date(ms + 480 * 60000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad2 = (n) => String(n).padStart(2, '0');
  return { y, m, ymd: `${y}${pad2(m)}${pad2(day)}`, iso: `${y}-${pad2(m)}-${pad2(day)}` };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readAllBytes = (abs) => fs.readFileSync(abs);

/** 递归列出文件绝对路径（按相对路径排序）。 */
function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, base, out);
    else out.push(abs);
  }
  return out.sort((a, b) => (a < b ? -1 : 1));
}

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// ════════════════════════════════════════════════════════════════════════════
// xlsx「内容等价」比对（v1.0.0-re3：彻底消除接线5 的偶发红）
//
// @why 为什么不再做"归一化后逐字节比较"：
//   修前实现把 **可见文字** 的"生成时间"戳用 `/生成时间 …/` 去替换，但它是先把字节
//   `toString('latin1')` 再跑中文正则 —— latin1 把 UTF-8 的每个字节映射成 U+00xx，
//   `生`(E7 94 9F) 永远不等于正则里的 `生`(U+751F) ⇒ **该替换一次都没生效**。
//   于是 tick 与"直接调用"两次生成只要跨过 1 秒（`生成时间` 是秒粒度），xlsx 字节就必然
//   不同 → 接线5 偶发红。而 ZIP 里的 DOS 时间字段其实早被 `lib/xlsx.js`（ZIP_DATE=0x21，
//   time=0）固定了，那段"抹零"是无效功（`证据-re3/G/probe-094-偶发根因.mjs` 有实测）。
//
// @design 改成**解析后内容等价**：解 ZIP（stored/deflate 都支持）→ 逐 sheet 解析单元格，
//   比较「sheet 名 / dimension / 行数 / 列头 / 每个单元格的值」+ 非 sheet 条目文本。
//   容器字节（DOS 时间、extra field、中央目录顺序、压缩方式）一概不参与比较；
//   唯一被显式归一的非内容字段是"生成时间"戳（写盘时刻，不属于内容语义）。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 解 ZIP 容器 → [{name, data}]（按中央目录顺序）。
 * 只支持本包 xlsx 写出器会产出的形态：无数据描述符、无 zip64、method 0/8。
 */
function unzipXlsx(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录签名不对 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('本地文件头签名不对 @' + lho + '（' + name + '）');
    const lnameLen = buf.readUInt16LE(lho + 26);
    const lextraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error('不支持的 zip 压缩方式 ' + method + '（' + name + '）');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** XML 文本反转义（xlsx 写出器只产出这 5 个命名实体，另兼容数字实体）。 */
function unxmlText(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g === 'amp') return '&';
    if (g === 'lt') return '<';
    if (g === 'gt') return '>';
    if (g === 'quot') return '"';
    if (g === 'apos') return "'";
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
}

/**
 * 唯一被允许变化的非内容字段：写盘时刻"生成时间 YYYY-MM-DD HH:MM:SS" → 占位。
 * 注意：这里是**解码后的 UTF-8 文本**上做替换（修前错误就在 latin1 上做）。
 */
function normStampText(s) {
  return String(s).replace(/生成时间\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g, '生成时间 <STAMP>');
}

/** 单元格引用（B12）→ 可排序的 [行, 列]。 */
function refOrd(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref));
  if (!m) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), col];
}

/** 一个 sheet XML → {rows, dimension, cells:[[ref, value]...]}（值含公式/内联串/数字，已反转义+归一戳）。 */
function sheetContent(xml) {
  const dimension = (/<dimension ref="([^"]*)"/.exec(xml) || [])[1] || '';
  const cells = [];
  let rows = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    rows += 1;
    const inner = rm[2] || '';
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(inner)) !== null) {
      const ref = (/r="([A-Z]+\d+)"/.exec(cm[1]) || [])[1] || '';
      const body = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
      const f = /<f>([\s\S]*?)<\/f>/.exec(body);
      let val = '';
      if (t) val = unxmlText(t[1]);
      else if (f && v) val = '=' + unxmlText(f[1]) + ' → ' + unxmlText(v[1]);
      else if (f) val = '=' + unxmlText(f[1]);
      else if (v) val = unxmlText(v[1]);
      cells.push([ref, normStampText(val)]);
    }
  }
  return { rows, dimension, cells };
}

/**
 * xlsx 字节 → **内容视图**（与容器字节无关）。
 * @returns {{sheets:Array<{name,rows,dimension,cells}>, others:Array<{name,text}>}}
 */
function xlsxContent(buf) {
  const entries = unzipXlsx(buf);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const wb = byName.get('xl/workbook.xml');
  if (!wb) throw new Error('xlsx 缺 xl/workbook.xml');
  const wbText = wb.toString('utf8');
  const names = [];
  for (const m of wbText.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) names.push(unxmlText(m[1]));
  const sheets = [];
  const nSheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).length;
  for (let i = 1; i <= nSheets; i += 1) {
    const entry = byName.get(`xl/worksheets/sheet${i}.xml`);
    if (!entry) throw new Error('xlsx 缺 xl/worksheets/sheet' + i + '.xml');
    sheets.push({ name: names[i - 1] || `#${i}`, ...sheetContent(entry.toString('utf8')) });
  }
  const others = entries
    .filter((e) => !/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .map((e) => ({ name: e.name, text: normStampText(e.data.toString('utf8')) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { sheets, others };
}

/** 行 1（列头）按列序的值数组。 */
function headerRowOf(sheet) {
  return sheet.cells
    .filter(([ref]) => refOrd(ref)[0] === 1)
    .sort((a, b) => refOrd(a[0])[1] - refOrd(b[0])[1])
    .map(([, v]) => v);
}

/** 两份内容视图的差异描述；'' = 等价。 */
function diffXlsxContent(ca, cb) {
  if (ca.sheets.length !== cb.sheets.length) return `sheet 数 ${ca.sheets.length} != ${cb.sheets.length}`;
  for (let i = 0; i < ca.sheets.length; i += 1) {
    const sa = ca.sheets[i];
    const sb = cb.sheets[i];
    const tag = `sheet#${i + 1}(${sa.name})`;
    if (sa.name !== sb.name) return `${tag} 名 ${JSON.stringify(sa.name)} != ${JSON.stringify(sb.name)}`;
    if (sa.dimension !== sb.dimension) return `${tag} dimension ${sa.dimension} != ${sb.dimension}`;
    if (sa.rows !== sb.rows) return `${tag} 行数 ${sa.rows} != ${sb.rows}`;
    const ha = headerRowOf(sa);
    const hb = headerRowOf(sb);
    if (JSON.stringify(ha) !== JSON.stringify(hb)) {
      return `${tag} 列头 ${JSON.stringify(ha)} != ${JSON.stringify(hb)}`;
    }
    const ma = new Map(sa.cells.filter(([, v]) => v !== ''));
    const mb = new Map(sb.cells.filter(([, v]) => v !== ''));
    const refs = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => {
      const [rx, cx] = refOrd(x);
      const [ry, cy] = refOrd(y);
      return rx - ry || cx - cy;
    });
    for (const ref of refs) {
      if (ma.get(ref) !== mb.get(ref)) {
        return `${tag} 单元格 ${ref}: ${JSON.stringify(ma.get(ref))} != ${JSON.stringify(mb.get(ref))}`;
      }
    }
  }
  const ja = JSON.stringify(ca.others);
  const jb = JSON.stringify(cb.others);
  if (ja !== jb) {
    for (let i = 0; i < Math.max(ca.others.length, cb.others.length); i += 1) {
      const a = ca.others[i];
      const b = cb.others[i];
      if (!a || !b || a.name !== b.name) return `非 sheet 条目集合不同：${a && a.name} != ${b && b.name}`;
      if (a.text !== b.text) return `非 sheet 条目 ${a.name} 文本不同`;
    }
    return '非 sheet 条目不同';
  }
  return '';
}


/** 月账 md 里"生成时间"戳（用于以同一 stamp 重算，做到逐字节可复现）。 */
function stampOfMonthly(mdText) {
  const m = /^> 生成时间: (.+?)（UTC\+08:00）$/m.exec(mdText);
  return m ? m[1] : '';
}

/** 当前周/月（+08:00 口径）。 */
function currentWeekMonth() {
  const now = Date.now();
  const w = weekOf(now, 480);
  return { y: w.year, m: w.month, ymd: ymdParts(now).ymd, iso: ymdParts(now).iso };
}

/** 某 month 的月账相对路径。 */
const monthlyRel = (y, m) => `${y}年${String(m).padStart(2, '0')}月/${String(m).padStart(2, '0')}月账.md`;

// ============================================================================
// 二、用例
// ============================================================================

test('接线1·周账：tick 用 runWeeklyBudget 写草稿；tick2 幂等不重写；stat.weeklyDeferred=0', async () => {
  // 守：把"逐组全量循环"换成预算版后，周账主产物与幂等语义不变（groups/written 形状也不改）。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 2 });
    const cfg = makeCfg(root);
    const s1 = await tick(cfg);
    assert.equal(s1.written, 2, '应写入 2 条台账');
    assert.match(String(s1.weekly), /^groups=1,written=1,sealed=0$/, '一周一组：stat.weekly 形状不变');
    assert.equal(s1.weeklyDeferred, 0, '小夹具不该有预算余量');
    assert.equal(s1.errors.length, 0, '干净轮 errors 必须为空：' + JSON.stringify(s1.errors));

    const wm = currentWeekMonth();
    const monthDir = path.join(root, `${wm.y}年${String(wm.m).padStart(2, '0')}月`);
    const xlsx = fs.readdirSync(monthDir).filter((n) => n.endsWith('.xlsx'));
    assert.equal(xlsx.length, 1, '当月应有一本周账（草稿）: ' + JSON.stringify(xlsx));
    const xlsxAbs = path.join(monthDir, xlsx[0]);
    const bytes1 = readAllBytes(xlsxAbs);
    const mtime1 = fs.statSync(xlsxAbs).mtimeMs;
    assert.match(xlsx[0], /^草稿-/, '未到封板宽限期 → 草稿名');

    const st1 = readState(root);
    assert.equal(Object.keys(st1.weeklyHashes || {}).length, 1, '内容指纹应记 1 组');

    const s2 = await tick(cfg);
    assert.equal(s2.written, 0, 'tick2 不得重复入账');
    assert.equal(s2.weeklyDeferred, 0);
    assert.equal(fs.statSync(xlsxAbs).mtimeMs, mtime1, '同样的数据 → 周账不得重写（mtime 不变）');
    assert.equal(sha(readAllBytes(xlsxAbs)), sha(bytes1), '周账字节不得变');
    assert.equal(s2.errors.length, 0, 'tick2 errors 必须为空：' + JSON.stringify(s2.errors));
  });
});

test('接线2·度量：weeklyDeferred/monthly/index 落 .tick-metrics.jsonl；run-report 有 warnings 段', async () => {
  // 守：三项新状态不是"只活在内存"——逐 tick 度量必须可机读，运行报告形状不变（warnings 段可选）。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 2 });
    const s1 = await tick(makeCfg(root));
    assert.equal(typeof s1.weeklyDeferred, 'number');
    assert.equal(s1.monthly && typeof s1.monthly === 'object', true, 'stat.monthly 必须出现');
    assert.equal(s1.index && typeof s1.index === 'object', true, 'stat.index 必须出现');
    assert.equal(s1.index.built, true, '首 tick（.index 不存在）必须建索引');

    const m = readTickMetrics(root);
    assert.equal(m.badLines, 0, '度量文件不得有坏行');
    const rec = m.records[m.records.length - 1];
    assert.equal(rec.written, 2);
    assert.equal(rec.weeklyDeferred, 0, '度量的 weeklyDeferred 必须落盘');
    assert.deepEqual(
      { built: rec.index.built, rows: rec.index.rows },
      { built: true, rows: 2 },
      '度量的 index {built,rows} 必须与 stat 一致',
    );
    assert.equal(rec.monthly.written >= 1, true, '度量的 monthly.written 必须落盘');

    const repFile = fs.readdirSync(path.join(root, 'ledger')).find((n) => /^\.run-report-\d{8}\.json$/.test(n));
    assert.ok(repFile, '本轮应写运行报告');
    const rep = JSON.parse(fs.readFileSync(path.join(root, 'ledger', repFile), 'utf8'));
    assert.equal(rep.counts.warnings, (rep.warnings || []).length, 'report.counts.warnings 必须自洽');
    assert.equal((rep.warnings || []).some((w) => /预算用尽/.test(String(w))), false,
      'weeklyDeferred=0 时不得虚报"预算用尽"');
  });
});

test('接线3·月账：tick 生成当月视图；月合计=台账当月行数（手算）；tick2 指纹不变不写', async () => {
  // 守：月账是**派生只读**——行数必须等于台账当月行数；同数据重跑不重写；直接调用返回 unchanged。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 3 });
    const s1 = await tick(makeCfg(root));
    assert.equal(s1.written, 3);
    const wm = currentWeekMonth();
    const mdAbs = path.join(root, `${wm.y}年${String(wm.m).padStart(2, '0')}月`, `${String(wm.m).padStart(2, '0')}月账.md`);
    assert.equal(fs.existsSync(mdAbs), true, '周账写盘后必须生成当月月账视图：' + mdAbs);
    const md1 = fs.readFileSync(mdAbs, 'utf8');
    assert.match(md1, /^# \d{4}年\d{2}月 月账（视图）$/m, '必须有 H1 标题');
    assert.match(md1, /^> 性质：\*\*派生视图\*\*/m, '必须声明派生视图性质');
    // 手算：台账里 ts 属于当月的真账行数
    const monthPrefix = `${wm.iso.slice(0, 8)}`;
    const rows = readAll(root).records.filter((r) => {
      if (!r || typeof r.ts !== 'string') return false;
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t)) return false;
      const p = ymdParts(t);
      return `${p.iso.slice(0, 8)}` === monthPrefix;
    }).length;
    assert.equal(rows, 3, '当月台账行数应为 3');
    assert.ok(md1.includes(`| 台账行数（当月） | ${rows} |`), '月合计必须等于台账当月行数（手算=' + rows + '）');

    const mtime1 = fs.statSync(mdAbs).mtimeMs;
    const s2 = await tick(makeCfg(root));
    assert.equal(s2.written, 0);
    assert.equal(fs.statSync(mdAbs).mtimeMs, mtime1, 'tick2 不得重写月账（同日不再触发 / 指纹不变）');
    assert.equal(fs.readFileSync(mdAbs, 'utf8'), md1, '月账字节不得变');

    // 直接调用库函数：指纹不变 → written=false, reason='unchanged'
    const mv = writeMonthlyView({ root, year: wm.y, month: wm.m, offsetMinutes: 480 });
    assert.equal(mv.written, false);
    assert.equal(mv.reason, 'unchanged');
    assert.equal(fs.statSync(mdAbs).mtimeMs, mtime1, 'unchanged 时不得碰 mtime');
  });
});

test('接线4·索引：tick 末尾增量建当日分片；tick2 当日分片已在 → built=false；台账字节不动', async () => {
  // 守：索引是派生数据 —— 只在"缺目录/缺当日分片"时增量构建；不写台账；tick2 不重复构建。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 2 });
    const cfg = makeCfg(root);
    const s1 = await tick(cfg);
    const wm = currentWeekMonth();
    assert.deepEqual(s1.index.built, true, '首 tick 应建索引');
    assert.equal(s1.index.rows, 2, '索引行数应等于台账行数');
    const idxDir = path.join(root, 'ledger', '.index');
    assert.equal(fs.existsSync(idxDir), true);
    const todayShard = path.join(idxDir, `idx-${wm.ymd}.jsonl`);
    assert.equal(fs.existsSync(todayShard), true, '必须有当日分片：' + todayShard);
    assert.equal(fs.existsSync(path.join(idxDir, '.idx-state.json')), true);

    // 只快照"台账日文件"（. 开头的运行区文件每轮本来就会变：run-report/state/metrics）。
    const ledgerSnapshot = () => walkFiles(path.join(root, 'ledger'))
      .map((f) => relOf(path.join(root, 'ledger'), f))
      .filter((r) => !r.startsWith('.') && r.endsWith('.jsonl'))
      .map((r) => `${r}:${sha(readAllBytes(path.join(root, 'ledger', r)))}`).join('|');
    const before = ledgerSnapshot();
    const s2 = await tick(cfg);
    assert.equal(s2.index.built, false, 'tick2 当日分片已存在 → 不得重复构建');
    assert.equal(s2.index.rows, 2, '跳过时也要给出索引当前行数');
    assert.equal(ledgerSnapshot(), before, '索引接线不得改台账/状态字节（.index 之外）');
  });
});

test('接线5·等价性：tick 产物 == 0.9.4-snap 直接调用库函数（周账/月账/台账/索引）', async () => {
  // 守（红线①）：接线只是"入口换调用方式"，产物必须与直接调用 lib 一致：
  //   周账内容指纹与 xlsx **解析后内容**（逐 sheet/列头/行数/单元格；容器字节与写盘时刻不参与）、
  //   月账 md 逐字节、索引分片逐字节、台账字节。
  await withLab(async ({ base, dshHome, root: rootA }) => {
    writeFreshSession(dshHome, { turns: 2 });
    const cfg = makeCfg(rootA);
    const sA = await tick(cfg);
    assert.equal(sA.written, 2);

    const wm = currentWeekMonth();
    const monthDirRel = `${wm.y}年${String(wm.m).padStart(2, '0')}月`;

    // ① 复制 tick 后的账库为 D，并在 D 里删掉"派生产物"（保留台账/状态/封板证据），
    //    再用 0.9.4-snap 的直接调用方式重算一遍。
    const rootD = path.join(base, 'rootD');
    fs.cpSync(rootA, rootD, { recursive: true });
    for (const f of walkFiles(rootD)) {
      const rel = relOf(rootD, f);
      if (/\.xlsx$/.test(rel) || /月账\.md$/.test(rel)) fs.rmSync(f);
    }
    fs.rmSync(indexDir(rootD), { recursive: true, force: true });

    const records = readAll(rootD).records;
    const groups = groupRecords(records, 480);
    const seals = readWeeklySeals(rootD);
    const journalState = readSealJournalState(rootD);
    const directHashes = {};
    for (const [gid, g] of groups) {
      const res = writeWeekly({
        root: rootD,
        w: g.w,
        sessKey: g.sessKey,
        records: g.records,
        offsetMinutes: 480,
        prevHashes: directHashes,
        seals,          // ★ 与 tick 同口径：封板证据每 tick 读一次后注入
        journalState,   // ★ 同上：journal 尾读缓存
      });
      if (!res.skipped && res.hash) directHashes[gid] = res.hash;
    }
    // 周账 xlsx：**解析后内容等价**（逐 sheet / 列头 / 行数 / 单元格；容器字节不参与比较）
    const xlsxRel = (root) => walkFiles(root).filter((f) => /\.xlsx$/.test(relOf(root, f))).map((f) => relOf(root, f));
    const aXlsx = xlsxRel(rootA);
    const dXlsx = xlsxRel(rootD);
    assert.deepEqual(dXlsx, aXlsx, '直接调用产出的周账文件集合必须与 tick 一致');
    for (const rel of aXlsx) {
      const ca = xlsxContent(readAllBytes(path.join(rootA, rel)));
      // ★ 反证（防"内容等价"退化成恒真）：解析出来的内容视图必须非空；
      //   并且对"注入一个假单元格"这类真实差异必须敏感。否则"等价"毫无意义。
      assert.ok(ca.sheets.length >= 2 && ca.sheets.every((s) => s.rows > 0) && ca.sheets.some((s) => s.cells.length >= 3),
        '内容视图解析为空/过少（比对会退化成恒真）：' + rel + ' :: ' +
        JSON.stringify(ca.sheets.map((s) => ({ name: s.name, rows: s.rows, cells: s.cells.length }))));
      const mutated = JSON.parse(JSON.stringify(ca));
      mutated.sheets[mutated.sheets.length - 1].cells.push(['ZZ999', '注入的假单元格']);
      assert.notEqual(diffXlsxContent(ca, mutated), '', '内容等价比对对真实差异不敏感（恒真）：' + rel);
      const diff = diffXlsxContent(ca, xlsxContent(readAllBytes(path.join(rootD, rel))));
      assert.equal(diff, '', '周账 xlsx 内容必须等价（逐 sheet/列头/行数/单元格）：' + rel + ' :: ' + diff);
    }

    // ② 周账内容指纹：tick 写进 state 的 weeklyHashes == 直接调用返回的 hash
    const stA = readState(rootA) || {};
    assert.deepEqual(stA.weeklyHashes, directHashes, 'state.weeklyHashes 必须等于直接调用 writeWeekly 的 hash');

    // ③ 月账：用 tick 产物里的 stamp 重算 → 逐字节一致（证明 tick 传给 lib 的参数/数据完全一致）
    const mdRel = monthlyRel(wm.y, wm.m);
    const mdA = fs.readFileSync(path.join(rootA, mdRel), 'utf8');
    const stamped = buildMonthlyView({ root: rootD, year: wm.y, month: wm.m, offsetMinutes: 480, generatedAt: stampOfMonthly(mdA) });
    assert.equal(stamped.content, mdA, '月账 md 必须逐字节一致（同 stamp 下）');

    // ④ 索引：直接 buildIndex 的分片与 tick 建的分片逐字节一致
    buildIndex({ root: rootD, sinceYmd: wm.ymd });
    const shardRel = `ledger/.index/idx-${wm.ymd}.jsonl`;
    assert.equal(
      sha(readAllBytes(path.join(rootD, shardRel))),
      sha(readAllBytes(path.join(rootA, shardRel))),
      '索引当日分片必须逐字节一致',
    );

    // ⑤ 台账字节：copy 前后（tick 写完之后）逐文件 sha 一致；且 tick 没改任何既有台账日文件
    const ledgerRel = (root) => walkFiles(path.join(root, 'ledger'))
      .filter((f) => !relOf(path.join(root, 'ledger'), f).startsWith('.index/'))
      .map((f) => relOf(root, f));
    assert.deepEqual(ledgerRel(rootD), ledgerRel(rootA), '直接调用不得新增/删除台账文件');
    for (const rel of ledgerRel(rootA).filter((r) => r.endsWith('.jsonl') && !r.includes('/.'))) {
      assert.equal(sha(readAllBytes(path.join(rootD, rel))), sha(readAllBytes(path.join(rootA, rel))),
        '台账日文件必须逐字节一致：' + rel);
    }
  });
});

test('失败1·索引构建异常 → 只 warn、不进 errors、不回滚、台账照常入账', async () => {
  // 守（红线②）：把 ledger/.index 占成普通文件 → buildIndex 必失败；tick 不得崩/报红/回滚。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 1 });
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', '.index'), 'occupied', 'utf8');
    const s = await tick(makeCfg(root));
    assert.equal(s.written, 1, '索引失败不得影响台账入账');
    assert.equal(s.index.built, false, '构建失败必须如实 built=false');
    assert.equal(s.warnings.some((w) => /索引/.test(String(w))), true,
      '索引失败必须 warn：' + JSON.stringify(s.warnings));
    assert.equal(s.errors.length, 0, '索引失败不得进 errors（派生数据不是账务事实）：' + JSON.stringify(s.errors));
    assert.equal(fs.readFileSync(path.join(root, 'ledger', '.index'), 'utf8'), 'occupied', '不得覆盖占位文件');
    // 周账/月账不受牵连
    const wm = currentWeekMonth();
    const monthDir = path.join(root, `${wm.y}年${String(wm.m).padStart(2, '0')}月`);
    assert.equal(fs.readdirSync(monthDir).some((n) => n.endsWith('.xlsx')), true, '周账仍要生成');
    assert.equal(fs.existsSync(path.join(monthDir, monthlyRel(wm.y, wm.m).split('/').pop())), true, '月账仍要生成');
  });
});

test('失败2·月账写失败（目标路径被目录占用）→ 只 warn、不进 errors、周账与台账照常', async () => {
  // 守（红线②）：月账是派生视图 —— 写失败只 warn，绝不拖垮 tick、不进 errors。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 1 });
    const wm = currentWeekMonth();
    const monthDir = path.join(root, `${wm.y}年${String(wm.m).padStart(2, '0')}月`);
    fs.mkdirSync(path.join(monthDir, monthlyRel(wm.y, wm.m).split('/').pop()), { recursive: true }); // 目录占位
    const s = await tick(makeCfg(root));
    assert.equal(s.written, 1, '月账失败不得影响台账入账');
    assert.ok(s.monthly, 'stat.monthly 必须出现（失败也要可观测）');
    assert.equal(s.monthly.failed, 1, '必须如实记 failed=1');
    assert.equal(s.warnings.some((w) => /月账/.test(String(w))), true,
      '月账失败必须 warn：' + JSON.stringify(s.warnings));
    assert.equal(s.errors.length, 0, '月账失败不得进 errors：' + JSON.stringify(s.errors));
    assert.equal(fs.readdirSync(monthDir).some((n) => n.endsWith('.xlsx')), true, '周账仍要生成');
  });
});

test('回归1·journal 坏行：tick 不崩、既有 errors 口径不变、台账照常入账、stat 既有字段齐全', async () => {
  // 守（红线③）：封板 journal 坏行在 0.9.4-snap 就是 **errors** 口径（不是 warn）——
  //   接线不得把它降级/升级；同时新能力（月账/索引）不得因此失败。
  await withLab(async ({ dshHome, root }) => {
    writeFreshSession(dshHome, { turns: 1 });
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    const journalAbs = path.join(root, 'ledger', '.seal-journal.jsonl');
    fs.writeFileSync(journalAbs, 'this-is-not-json\n', 'utf8');
    const s = await tick(makeCfg(root));
    assert.equal(s.written, 1, 'journal 坏行不得影响台账入账');
    assert.equal(s.errors.some((e) => /seal journal bad lines=1/.test(String(e))), true,
      'journal 坏行必须沿用既有 errors 口径：' + JSON.stringify(s.errors));
    assert.equal(s.errors.some((e) => /(索引|月账)/.test(String(e))), false,
      '坏 journal 不得让新能力报错：' + JSON.stringify(s.errors));
    // stat 既有字段一个不删（抽样断言关键字段仍在且类型未变）
    for (const k of ['scanned', 'written', 'skipped', 'deferred', 'weekly', 'supplements', 'errors', 'warnings']) {
      assert.ok(k in s, 'stat 既有字段缺失：' + k);
    }
    assert.equal(typeof s.phases.weeklyMs, 'number', 'phases.weeklyMs 必须仍存在');
    assert.equal(typeof s.weeklyDeferred, 'number');
    const wm = currentWeekMonth();
    const monthDir = path.join(root, `${wm.y}年${String(wm.m).padStart(2, '0')}月`);
    assert.equal(fs.readdirSync(monthDir).some((n) => n.endsWith('.xlsx')), true, '周账仍要生成');

    // 旧 readSealEvents 会报 readError 的形态（journal 路径被换成目录）：接线后必须仍如实报出，
    // 不得因为尾读缓存的 stat.size=0 把"读不到"当成"空册"（审计 M-02/M-03 口径）。
    fs.rmSync(journalAbs);
    fs.mkdirSync(journalAbs, { recursive: true });
    const s2 = await tick(makeCfg(root));
    assert.equal(s2.written, 0, '第二轮无新轮次 → 不得重复入账');
    assert.equal(s2.errors.some((e) => /seal journal read failed: not a regular file/.test(String(e))), true,
      'journal 非普通文件必须如实报 read failed：' + JSON.stringify(s2.errors));
    assert.equal(s2.errors.some((e) => /(索引|月账)/.test(String(e))), false,
      'journal 读失败不得让新能力报错：' + JSON.stringify(s2.errors));
  });
});
