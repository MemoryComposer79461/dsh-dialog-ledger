/**
 * @file 自测-清册v13.mjs
 * @role **v1.3 清册（清理报告）全量验收**：CL-01…CL-32 每条判据一个用例 + dry-run/双开关安全回归。
 *       判据正文：`03-契约-v0.5/v0.5-验收清单.md` §7 CL-01…CL-32（逐字照做）
 *                 ＋`02-契约-v1.3/模板-完整原文清理报告-v1.3.md`（17 键 YAML / 7 行抬头 /
 *                   声明逐字 / 统计三处一致 / 明细升序 / 附录 CSV / 复核行 / 留档行 / S1–S8）
 *                 ＋`03-契约-v0.5/v0.5-契约决定记录.md` D15/D16（序号 `\d+`、99/100/101 不回绕）。
 *
 * 零依赖：只用 node 内置（fs/os/path/crypto/child_process）+ 被测实现（freeze/cleanup.js）。
 * 纪律：
 *   · 一次只跑一个测试文件；每个用例自己在 %TEMP% 建库、finally 整棵删，不碰真实数据总库；
 *   · 每处断言都写明"守："哪条判据；能看字节就看字节（sha256/前后快照），不看返回值自证；
 *   · 安全底线（默认零删除/双开关/旧工具封锁）在实现变红时必须能抓住；
 *   · 不为了变绿放宽断言：实现不满足 → FAIL 并点名。
 *
 * 用法（cwd = 插件根目录）：
 *   node docs/跑测试.mjs docs/自测-清册v13.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanup = await import(pathToFileURL(path.join(SRC, 'freeze', 'cleanup.js')).href);
const weekly = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);
const {
  listOriginals, runCleanup, nextReportId, nextDryRunId, readCleanedCodes, checkCleanupReport,
} = cleanup;
const { readCleanedCodesCompat } = weekly;

// ============================================================================
// 公共工具（只在验收侧；实现代码一行不改）
// ============================================================================

const QL = '“';
const QR = '”';
const OFFSET = 480;
const pad2 = (n) => String(n).padStart(2, '0');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 本地 `YYYYMMDD`（+08:00）。 */
function dayOf(ms = Date.now(), offset = OFFSET) {
  const d = new Date(ms + offset * 60 * 1000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** 本地 `YYYY-MM-DD`（+08:00）。 */
function dateOf(ms = Date.now(), offset = OFFSET) {
  const d = new Date(ms + offset * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 本地 `YYYY-MM-DD HH:MM:SS`（+08:00，无 T 无 Z）。 */
function stampOf(ms, offset = OFFSET) {
  const d = new Date(ms + offset * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 造一个独立临时数据总库根目录。 */
function mkLab(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clv13-${tag}-`));
}

/** 32 位编码：YYYYMMDD-12位Session-代差-8位序号。 */
function mkCode(dateSeg, s12, n) {
  const sess = String(s12).padEnd(12, '0').slice(0, 12);
  return `${dateSeg}-${sess}-A-${String(n).padStart(8, '0')}`;
}

/** 第 3 级原文绝对路径：`<root>/YYYY年MM月/MM月总“完整原文”/<编码> 完整原文.md`。 */
function originalPath(root, mtimeMs, code) {
  const d = new Date(mtimeMs + OFFSET * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  return path.join(root, `${y}年${m}月`, `${m}月总${QL}完整原文${QR}`, `${code} 完整原文.md`);
}

/**
 * 在第 3 级真造一份完整原文（可带同单元事件附件），并把 mtime 钉死（明细排序依赖它）。
 * @returns {string} 视图绝对路径
 */
function putOriginal(root, { code, mtimeMs, body = '# 完整原文\n', attachment = false }) {
  const p = originalPath(root, mtimeMs, code);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  if (attachment) {
    fs.writeFileSync(path.join(path.dirname(p), `${code} 原始事件.json`), '{"type":"x"}\n', 'utf8');
  }
  return p;
}

/** 递归快照：相对路径 → sha256（只读证据；"一个字节都不改"用它）。 */
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({
        rel: path.relative(root, p).replace(/\\/g, '/'),
        sha: sha256(fs.readFileSync(p)),
        size: fs.statSync(p).size,
      });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 快照差异：只增 / 只减 / 改写（用于"只许新增报告与 journal"类断言）。 */
function diffSnap(before, after) {
  const b = new Map(before.map((x) => [x.rel, x.sha]));
  const a = new Map(after.map((x) => [x.rel, x.sha]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).sort(),
    removed: [...b.keys()].filter((k) => !a.has(k)).sort(),
    changed: [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort(),
  };
}

/**
 * 文件内注入 fs.unlinkSync 故障（只对路径命中 match 的文件生效；用于 CL-02/12/13/27 等
 * "删除失败 / 终稿被抢写"场景）。返回 fn() 的结果。
 */
function withUnlinkFault(match, onMatch, fn) {
  const orig = fs.unlinkSync;
  fs.unlinkSync = function patched(p) {
    if (match(String(p))) return onMatch(String(p));
    return orig.call(fs, p);
  };
  try { return fn(); } finally { fs.unlinkSync = orig; }
}

/** 物理清理（双开关；仅测试隔离库使用）。 */
function runPhysical(root, over = {}) {
  return runCleanup({ root, dryRun: false, cleanupAllowPhysicalDelete: true, ...over });
}

// ---------- 独立解析器（不复用实现代码；判据要"从产物反着验"） ----------

/** 取 `## 标题` 到下一个 `## ` 之间的行。 */
function sectionLines(text, heading) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** 表格数据行（跳过表头行与 `---` 分隔行）。 */
function tableRows(lines) {
  const rows = [];
  let sawHeader = false;
  for (const line of (lines || [])) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!sawHeader) { sawHeader = true; continue; }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    rows.push(cells);
  }
  return rows;
}

function unquoteYaml(raw) {
  const m = /^"(.*)"$/.exec(String(raw).trim());
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : String(raw).trim();
}

/** 独立解析清册终稿（不复用 lib 的解析器）。 */
function parseReport(text) {
  const lines = String(text).split('\n');
  const yamlEntries = [];
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] === '---') break;
      const m = /^([^:]+):\s*(.*)$/.exec(lines[i]);
      if (m) yamlEntries.push({ key: m[1].trim(), raw: m[2].trim(), value: unquoteYaml(m[2]) });
    }
  }
  const yaml = new Map(yamlEntries.map((e) => [e.key, e.value]));
  const h1 = lines.findIndex((l) => /^# \d{4}-\d{2}-\d{2}/.test(l));
  const nextH2 = lines.findIndex((l, i) => i > h1 && /^## /.test(l));
  const headerRows = tableRows(lines.slice(h1 < 0 ? 0 : h1, nextH2 < 0 ? lines.length : nextH2));
  const statsLines = sectionLines(text, '## 清除统计') || [];
  const sentenceLine = statsLines.find((l) => l.startsWith('计划清除 **')) || '';
  const sentenceNums = [...sentenceLine.matchAll(/\*\*(\d+)\*\*/g)].map((m) => Number(m[1]));
  const statsRows = tableRows(statsLines);
  const statsTable = statsRows.length ? {
    清理前总数: Number(statsRows[0][0]),
    计划清除: Number(statsRows[0][1]),
    成功: Number(statsRows[0][2]),
    失败: Number(statsRows[0][3]),
    跳过: Number(statsRows[0][4]),
    目前剩余: Number(statsRows[0][5]),
  } : null;
  const detailRows = tableRows(sectionLines(text, '## 本轮清理的“完整原文”明细'));
  const failureRows = tableRows(sectionLines(text, '## 失败项'));
  const recheckLine = lines.find((l) => l.startsWith('> 复核：')) || '';
  const archiveLine = [...lines].reverse().find((l) => l.trim() !== '') || '';
  const appendixLines = sectionLines(text, '## 附录：全量明细');
  let appendix = null;
  if (appendixLines) {
    const f = appendixLines.find((l) => l.startsWith('- 文件：'));
    const r = appendixLines.find((l) => l.startsWith('- 数据行：'));
    appendix = {
      file: f ? f.slice('- 文件：'.length).trim() : null,
      rows: r ? Number(/数据行：(\d+)/.exec(r)[1]) : null,
    };
  }
  return {
    lines, yamlEntries, yaml, headerRows, sentenceLine, sentenceNums, statsTable,
    detailRows, failureRows, recheckLine, archiveLine, appendix, text: String(text),
  };
}

/** 清册/（V0.6.2 新布局）目录名；读端双路径：新目录优先，一级兜底。 */
const RPT_SUB = '清册';

/** 读报告正文：先找 `清册/`（新布局），再退一级（老库兜底）——与实现 `layout.resolveExisting` 同语义。 */
function reportTextOf(root, id) {
  const name = `${id}.md`;
  const p = [path.join(root, RPT_SUB, name), path.join(root, name)].find((x) => fs.existsSync(x));
  if (!p) throw new Error(`报告不存在（清册/ 与一级都没有）：${name}`);
  return fs.readFileSync(p, 'utf8');
}

/** 附录 CSV 绝对路径：同样双路径（新目录优先、一级兜底）。 */
function appendixPathOf(root, name) {
  const p = [path.join(root, RPT_SUB, name), path.join(root, name)].find((x) => fs.existsSync(x));
  if (!p) throw new Error(`附录 CSV 不存在（清册/ 与一级都没有）：${name}`);
  return p;
}

/** 双路径（清册/ + 一级，不递归）目录列表：清册/ 在前、一级在后。 */
function reportDirs(root) {
  return [path.join(root, RPT_SUB), root];
}

/** 双路径（清册/ + 一级，不递归）里匹配正则的文件名。 */
function reportNames(root, re) {
  return reportDirs(root)
    .flatMap((d) => { try { return fs.readdirSync(d); } catch { return []; } })
    .filter((n) => re.test(n));
}

/** 独立 CSV 解析（RFC4180 子集；只用于验收侧读回）。 */
function parseCsv(text) {
  const raw = String(text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r\n|\n|\r/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => {
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

/** CSV 数据行（不含表头）。 */
function csvDataRows(csvText) {
  const rows = parseCsv(csvText);
  return rows.slice(1);
}

const YAML_KEYS_V13 = [
  '报告编号', '报告日期', '清理对象', '清理范围', '数据来源', '委托人', '执行', '记录', '生成器',
  '清理前总数', '计划清除', '成功', '失败', '跳过', '目前剩余', '上一轮报告', '复核时间',
];
const HEADER_LABELS_V13 = ['名称', '报告编号', '委托人', '执行', '记录', '清理范围', '上一轮报告'];
const DECLARATION_V13 =
  'Agent、Cordis 及 Tool 均无权限及能力删除完整原文并主动生成该文件，' +
  '若出现此文件，则说明 user 主动要求并参与本轮清理活动，Agent、Cordis 及 Tool 均不承担责任。';

const BASE_MS = Date.parse('2026-11-09T10:00:00+08:00');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 一、CL-01…CL-10：文件名 / 编码 / YAML / 抬头 / 声明 / 统计 / 明细
// ============================================================================

// 守：CL-01 文件名 `^RPT-\d{8}-\d+\.md$`（D16 序号 \d+）；`报告编号` == 文件名去 `.md`。
test('CL-01 RPT 文件名匹配 ^RPT-\\d{8}-\\d+\\.md$，报告编号==文件名去 .md（D16 不回绕）', () => {
  const root = mkLab('cl01');
  try {
    const now = Date.now();
    const day = dayOf(now);
    // 预置 99/100：本轮必须接续 101（D16：不两位回绕）
    fs.writeFileSync(path.join(root, `RPT-${day}-99.md`), '# 占位\n', 'utf8');
    fs.writeFileSync(path.join(root, `RPT-${day}-100.md`), '# 占位\n', 'utf8');
    for (let i = 1; i <= 2; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl01a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r = runPhysical(root, { nowMs: now });
    const base = path.basename(r.path);
    assert.match(base, /^RPT-\d{8}-\d+\.md$/, '★ CL-01 不成立：文件名不符');
    assert.equal(base, `${r.reportId}.md`);
    assert.equal(r.reportId, `RPT-${day}-101`, `★ CL-01/CL-21 不成立：99/100 已存在，下一号应为 101（实测 ${r.reportId}）`);
    assert.equal(base, `RPT-${day}-101.md`);
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.equal(rep.yaml.get('报告编号'), r.reportId);
    assert.equal(rep.yaml.get('报告编号'), base.replace(/\.md$/, ''));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-02 产物 UTF-8 无 BOM、LF、恰一个结尾换行；输入 CRLF 在编码层归一为 LF（不算内容改写）。
test('CL-02 报告 UTF-8 无 BOM、LF、恰一个结尾换行（CRLF 输入归一层）', () => {
  const root = mkLab('cl02');
  try {
    const now = Date.now();
    const codes = [mkCode('20261109', 'cl02a0000001', 1), mkCode('20261109', 'cl02a0000001', 2)];
    putOriginal(root, { code: codes[0], mtimeMs: BASE_MS });
    putOriginal(root, { code: codes[1], mtimeMs: BASE_MS + 1000 });
    // 注入一个带 CRLF 的删除失败原因 → 报告仍必须全 LF
    const r = withUnlinkFault(
      (p) => p.includes(codes[0]),
      () => { const e = new Error('注入：第一行\r\n注入：第二行'); e.code = 'EIO'; throw e; },
      () => runPhysical(root, { nowMs: now }),
    );
    assert.equal(r.failed, 1, '前置失败：应构造出 1 条删除失败');
    const buf = fs.readFileSync(r.path);
    assert.notDeepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '★ CL-02 不成立：产物带 UTF-8 BOM');
    const text = buf.toString('utf8');
    assert.equal(text.includes('\r'), false, '★ CL-02 不成立：产物含 CR（必须 LF）');
    assert.equal(text.endsWith('\n'), true, '★ CL-02 不成立：产物没有结尾换行');
    const trailing = /\n+$/.exec(text);
    assert.equal(trailing[0].length, 1, `★ CL-02 不成立：结尾换行数=${trailing[0].length}（应恰 1）`);
    assert.equal(Buffer.byteLength(text, 'utf8'), buf.length, '★ CL-02 不成立：不是合法 UTF-8 字节序列');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-03 YAML 恰 17 键、顺序 = 报告编号…复核时间；数值即使整数也带引号（口径 7）。
test('CL-03 YAML 恰 17 键、顺序固定（报告编号…复核时间）、数值带引号', () => {
  const root = mkLab('cl03');
  try {
    const now = Date.now();
    for (let i = 1; i <= 2; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl03a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.equal(rep.yamlEntries.length, 17, `★ CL-03 不成立：YAML 键数=${rep.yamlEntries.length}（应 17）`);
    assert.deepEqual(rep.yamlEntries.map((e) => e.key), YAML_KEYS_V13, '★ CL-03 不成立：YAML 键顺序不符');
    for (const e of rep.yamlEntries) {
      assert.match(e.raw, /^".*"$/, `★ CL-03 不成立：键「${e.key}」的值未带双引号（${e.raw}）`);
    }
    for (const key of ['清理前总数', '计划清除', '成功', '失败', '跳过', '目前剩余']) {
      assert.match(rep.yaml.get(key), /^\d+$/, `★ CL-03/04 不成立：${key} 不是非负整数字面量（${rep.yaml.get(key)}）`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-04 清理对象==完整原文；报告日期 ^\d{4}-\d{2}-\d{2}$；委托人/执行/记录固定串；
//      6 个计数均为非负整数字面量且带引号。
test('CL-04 YAML 字段值：清理对象=完整原文、日期 YYYY-MM-DD、三类固定串、6 计数非负整数', () => {
  const root = mkLab('cl04');
  try {
    const now = Date.now();
    for (let i = 1; i <= 3; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl04a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.equal(rep.yaml.get('清理对象'), '完整原文');
    assert.match(rep.yaml.get('报告日期'), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rep.yaml.get('报告日期'), dateOf(now));
    assert.equal(rep.yaml.get('委托人'), 'user');
    assert.equal(rep.yaml.get('执行'), '日常会话记录插件（Tool）');
    assert.equal(rep.yaml.get('记录'), '系统（Cordis）');
    assert.ok(rep.yaml.get('生成器') && /\S/.test(rep.yaml.get('生成器')), '生成器必须非空');
    for (const key of ['清理前总数', '计划清除', '成功', '失败', '跳过', '目前剩余']) {
      const v = rep.yaml.get(key);
      assert.match(v, /^\d+$/, `★ CL-04 不成立：${key}=${JSON.stringify(v)} 应为非负整数字面量`);
      assert.ok(Number(v) >= 0);
    }
    // YAML 计数字段与运行返回一致
    assert.equal(Number(rep.yaml.get('清理前总数')), r.originalsBefore);
    assert.equal(Number(rep.yaml.get('计划清除')), r.planned);
    assert.equal(Number(rep.yaml.get('成功')), r.deleted);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-05 抬头表恰 7 行（名称/报告编号/委托人/执行/记录/清理范围/上一轮报告），与 YAML 逐字段一致（S7）。
test('CL-05 抬头表恰 7 行且与 YAML 逐字段一致（S7）', () => {
  const root = mkLab('cl05');
  try {
    const now = Date.now();
    for (let i = 1; i <= 2; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl05a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.equal(rep.headerRows.length, 7, `★ CL-05 不成立：抬头表数据行=${rep.headerRows.length}（应 7）`);
    assert.deepEqual(rep.headerRows.map((x) => x[0]), HEADER_LABELS_V13, '★ CL-05 不成立：抬头表行序/名称不符');
    const h = new Map(rep.headerRows.map((x) => [x[0], x[1]]));
    assert.equal(h.get('名称'), `${rep.yaml.get('报告日期')}${QL}完整原文${QR}清理报告`);
    assert.equal(h.get('报告编号'), rep.yaml.get('报告编号'));
    assert.equal(h.get('委托人'), rep.yaml.get('委托人'));
    assert.equal(h.get('执行'), rep.yaml.get('执行'));
    assert.equal(h.get('记录'), rep.yaml.get('记录'));
    assert.equal(h.get('清理范围'), rep.yaml.get('清理范围'));
    assert.equal(h.get('上一轮报告'), rep.yaml.get('上一轮报告'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-06 声明段落逐字 == 模板原文（含标点，不得改写/节选/补充；口径 11）。
test('CL-06 声明段落逐字 == 模板原文（口径 11）', () => {
  const root = mkLab('cl06');
  try {
    const now = Date.now();
    putOriginal(root, { code: mkCode('20261109', 'cl06a0000001', 1), mtimeMs: BASE_MS });
    const r = runPhysical(root, { nowMs: now });
    const text = reportTextOf(root, r.reportId);
    const sec = sectionLines(text, '## 声明');
    assert.ok(sec, '★ CL-06 不成立：缺少「## 声明」节');
    const body = sec.map((l) => l.trim()).filter(Boolean);
    assert.equal(body.length, 1, `★ CL-06 不成立：声明段落行数=${body.length}（应恰 1 段）`);
    assert.equal(body[0], DECLARATION_V13, '★ CL-06 不成立：声明被改写/节选/补充');
    assert.equal(text.split(DECLARATION_V13).length - 1, 1, '★ CL-06 不成立：声明出现次数不是 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-07 S1 planned==succeeded+failed+skipped；S2 remaining==before_total-succeeded；
//      统计句 + 统计表 6 个数字与 YAML 一致。
test('CL-07 统计自洽：S1 计划=成功+失败+跳过；S2 剩余=总数-成功；句/表/YAML 一致', () => {
  const root = mkLab('cl07');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 4 }, (_, i) => mkCode('20261109', 'cl07a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    // 构造 3 成功 + 1 失败（失败项不能进"已删除"）
    const r = withUnlinkFault(
      (p) => p.includes(codes[3]),
      () => { throw new Error('注入：占用中'); },
      () => runPhysical(root, { nowMs: now }),
    );
    const rep = parseReport(reportTextOf(root, r.reportId));
    const g = (k) => Number(rep.yaml.get(k));
    assert.equal(g('计划清除'), g('成功') + g('失败') + g('跳过'), '★ CL-07/S1 不成立');
    assert.equal(g('目前剩余'), g('清理前总数') - g('成功'), '★ CL-07/S2 不成立');
    assert.equal(g('成功'), 3);
    assert.equal(g('失败'), 1);
    // 统计句 5 个数字 == YAML
    assert.deepEqual(rep.sentenceNums, [g('计划清除'), g('成功'), g('失败'), g('跳过'), g('目前剩余')], '★ CL-07/CL-31 不成立：统计句数字与 YAML 不符');
    // 统计表 6 个数字 == YAML
    assert.deepEqual(rep.statsTable, {
      清理前总数: g('清理前总数'), 计划清除: g('计划清除'), 成功: g('成功'),
      失败: g('失败'), 跳过: g('跳过'), 目前剩余: g('目前剩余'),
    }, '★ CL-07/CL-31 不成立：统计表数字与 YAML 不符');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-08 S3 明细：planned ≤ 50 → 正文明细行数==planned；planned > 50 → 正文恰 50 行 + CSV 数据行==planned。
test('CL-08 明细行数：≤50 正文==planned；>50 正文 50 + CSV 数据行==planned（S3）', () => {
  const root1 = mkLab('cl08a');
  const root2 = mkLab('cl08b');
  try {
    const now = Date.now();
    // 上半：3 条（≤50）
    for (let i = 1; i <= 3; i += 1) putOriginal(root1, { code: mkCode('20261109', 'cl08a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r1 = runCleanup({ root: root1, nowMs: now }); // dry-run
    const rep1 = parseReport(reportTextOf(root1, r1.reportId));
    assert.equal(rep1.detailRows.length, 3, `★ CL-08 不成立：≤50 正文明细行=${rep1.detailRows.length}（应 3）`);
    assert.equal(rep1.appendix, null, '★ CL-08 不成立：≤50 不应出现附录节');
    assert.deepEqual(reportNames(root1, /-明细\.csv$/), [], '★ CL-08 不成立：≤50 不应产附录 CSV（清册/ 与一级都不许）');
    // 下半：55 条（>50）
    for (let i = 1; i <= 55; i += 1) putOriginal(root2, { code: mkCode('20261109', 'cl08b0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r2 = runCleanup({ root: root2, nowMs: now });
    const rep2 = parseReport(reportTextOf(root2, r2.reportId));
    assert.equal(rep2.detailRows.length, 50, `★ CL-08 不成立：>50 正文明细行=${rep2.detailRows.length}（应恰 50）`);
    assert.ok(rep2.appendix, '★ CL-08 不成立：>50 缺少附录节');
    const csvPath = appendixPathOf(root2, rep2.appendix.file);
    assert.equal(fs.existsSync(csvPath), true, '★ CL-08 不成立：附录 CSV 不存在');
    assert.equal(csvPath, path.join(root2, RPT_SUB, rep2.appendix.file), 'V0.6.2：附录 CSV 写 清册/');
    assert.equal(csvDataRows(fs.readFileSync(csvPath, 'utf8')).length, 55, '★ CL-08 不成立：CSV 数据行数 != planned');
    assert.equal(rep2.appendix.rows, 55);
    assert.equal(rep2.detailRows.length + csvDataRows(fs.readFileSync(csvPath, 'utf8')).length - 50, 55);
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

// 守：CL-09 明细行结构 `^| \d+ | code | 时间 | (已删除|未删除|跳过) | …|$`（逐行正则）。
test('CL-09 明细行结构：^\\| \\d+ \\| 编码 \\| YYYY-MM-DD HH:MM:SS \\| (已删除|未删除|跳过) \\| … \\|$', () => {
  const root = mkLab('cl09');
  try {
    const now = Date.now();
    putOriginal(root, { code: mkCode('20261109', 'cl09a0000001', 1), mtimeMs: BASE_MS });
    putOriginal(root, { code: mkCode('20261109', 'cl09a0000001', 2), mtimeMs: BASE_MS + 1000 });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    const RE = /^\| \d+ \| \d{8}-[0-9a-z]{12}-[A-Z]-\d{8} \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| (已删除|未删除|跳过) \| .* \|$/;
    const detailLines = rep.lines.filter((l) => l.startsWith('| ') && /\| \d{8}-/.test(l));
    assert.equal(detailLines.length, 2, `★ CL-09 不成立：明细行数=${detailLines.length}`);
    for (const line of detailLines) assert.match(line, RE, `★ CL-09 不成立：明细行不符合同一契约正则：${line}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-10 明细按「产生时间非降序」；同时间按编码升序；**不得按编码/会话排序**（口径 5）。
test('CL-10 明细按产生时间升序（同刻按编码），不按编码排序（口径 5）', () => {
  const root = mkLab('cl10');
  try {
    const now = Date.now();
    const c = (n) => mkCode('20261109', 'cl10a0000001', n);
    // 时间顺序与编码顺序故意错开：s4,s5(同刻) → s1 → s3
    putOriginal(root, { code: c(3), mtimeMs: BASE_MS + 3000 });
    putOriginal(root, { code: c(5), mtimeMs: BASE_MS });
    putOriginal(root, { code: c(1), mtimeMs: BASE_MS + 1000 });
    putOriginal(root, { code: c(4), mtimeMs: BASE_MS });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    const got = rep.detailRows.map((x) => x[1]);
    assert.deepEqual(got, [c(4), c(5), c(1), c(3)], '★ CL-10 不成立：明细未按产生时间升序（同刻未按编码升序）');
    const stamps = rep.detailRows.map((x) => x[2]);
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i - 1] <= stamps[i], `★ CL-10 不成立：产生时间非降序被破坏（${stamps[i - 1]} > ${stamps[i]}）`);
    }
    assert.notDeepEqual(got, [...got].sort(), '★ CL-10 不成立：明细看起来就是按编码排的（口径 5 禁止）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 二、安全回归（P0-6）：默认零删除 + 双开关 + 旧工具封锁 —— 硬要求 1，一条不许松
// ============================================================================

// 守：安全回归——默认 dry-run 零删除、只新增 RPT-DRYRUN 报告；只开总开关不显式 dryRun:false 仍 dry-run；
//      dryRun:false 未开总开关 → E_CLEANUP_DELETE_LOCKED 且零字节变化；旧清理工具继续 BLOCKED。
test('安全回归：默认零删除 + 双开关缺一不可 + 旧工具封锁（P0-6 / INV-25 / INV-26）', () => {
  const root = mkLab('safe');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'safea0000001', i + 1));
    const views = codes.map((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000, attachment: i === 0 }));
    // 一级/二级/台账/旧清册：清理绝不能碰
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', '2026-11-09.jsonl'), '{"keep":1}\n', 'utf8');
    fs.mkdirSync(path.join(root, '2026年11月'), { recursive: true });
    fs.writeFileSync(path.join(root, '2026年11月', '11月第2周-safea0000001A的周记账.xlsx'), 'fake-xlsx', 'utf8');
    fs.writeFileSync(path.join(root, 'safea0000001A的记忆数据库的启用及交接表.md'), '# 交接表\n', 'utf8');
    fs.writeFileSync(path.join(root, `RPT-${dayOf(now - 86400_000)}-01.md`), '# 旧清册\n', 'utf8');
    const before = snapshot(root);

    // ① 默认调用（连 dryRun 都不给）：零删除
    const r1 = runCleanup({ root, nowMs: now });
    assert.equal(r1.mode, 'dry-run');
    assert.equal(r1.dryRun, true);
    assert.equal(r1.deleted, 0, '★ 安全回归不成立：默认调用删除了文件（审计 A-07 回归）');
    assert.equal(listOriginals(root).length, 3);
    const d1 = diffSnap(before, snapshot(root));
    assert.deepEqual(d1.removed, [], '★ 安全回归不成立：默认调用删除了文件');
    assert.deepEqual(d1.changed, [], '★ 安全回归不成立：默认调用改写了已有文件');
    assert.equal(d1.added.length, 1, '★ 安全回归不成立：默认 dry-run 应只新增 1 份报告');
    // V0.6.2：dry-run 报告写在 `清册/`（快照 rel 统一用 `/` 分隔）。
    assert.deepEqual(d1.added, [`${RPT_SUB}/${r1.reportId}.md`], '★ 安全回归不成立：dry-run 报告未落在 清册/');
    assert.match(path.basename(d1.added[0]), /^RPT-DRYRUN-\d{8}-\d+\.md$/);

    // ② 只开总开关、没显式 dryRun:false → 仍必须 dry-run（双开关缺一不可）
    const before2 = snapshot(root);
    const r2 = runCleanup({ root, nowMs: now, cleanupAllowPhysicalDelete: true });
    assert.equal(r2.mode, 'dry-run', '★ 双开关不成立：只开总开关就真删了');
    assert.equal(r2.deleted, 0);
    const d2 = diffSnap(before2, snapshot(root));
    assert.deepEqual(d2.removed, []);
    assert.deepEqual(d2.changed, []);

    // ③ 显式 dryRun:false 但没开总开关 → 抛 E_CLEANUP_DELETE_LOCKED，零字节变化
    const before3 = snapshot(root);
    let err = null;
    try { runCleanup({ root, nowMs: now, dryRun: false }); } catch (e) { err = e; }
    assert.ok(err, '★ 双开关不成立：未开总开关的物理删除必须停摆');
    assert.equal(err.code, 'E_CLEANUP_DELETE_LOCKED');
    assert.deepEqual(snapshot(root), before3, '★ 安全回归不成立：拒绝路径改了文件');

    // ④ 旧工具封锁：exit≠0 + 输出 BLOCKED + 前后库 sha 集合不变
    const before4 = snapshot(root);
    const tool = spawnSync(process.execPath, [path.join(SRC, 'docs', '工具-v03-清理.mjs'), root], {
      encoding: 'utf8', timeout: 20000,
    });
    assert.notEqual(tool.status, 0, '★ 安全回归不成立：旧清理工具未 BLOCKED');
    assert.match(String(tool.stderr || '') + String(tool.stdout || ''), /BLOCKED/);
    assert.deepEqual(snapshot(root), before4, '★ 安全回归不成立：旧工具被调用时改了文件');

    // ⑤ 双开关都给了 → 才允许物理删除，且只删第 3 级
    const r5 = runCleanup({ root, nowMs: now, dryRun: false, cleanupAllowPhysicalDelete: true });
    assert.equal(r5.mode, 'physical');
    assert.equal(r5.deleted, 3);
    for (const v of views) assert.equal(fs.existsSync(v), false, '★ 安全回归不成立：第 3 级原文未被清理');
    assert.equal(fs.existsSync(path.join(root, 'ledger', '2026-11-09.jsonl')), true);
    assert.equal(fs.existsSync(path.join(root, 'safea0000001A的记忆数据库的启用及交接表.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 三、CL-11…CL-18：结论 / 失败项 / 附录 CSV / 复核行 / 模板残留 / 时间 / 编码 / 留档行
// ============================================================================

// 守：CL-11 结论只允许三值（已删除/未删除/跳过）；结论=跳过 的备注必须非空（口径 3）。
test('CL-11 结论三值枚举（已删除/未删除/跳过）；跳过备注非空（口径 3）', () => {
  const root = mkLab('cl11');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl11a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const ENUM = new Set(['已删除', '未删除', '跳过']);
    // dry-run：全部 跳过 + 备注 试运行
    const dry = runCleanup({ root, nowMs: now });
    const repDry = parseReport(reportTextOf(root, dry.reportId));
    assert.equal(repDry.detailRows.length, 3);
    for (const row of repDry.detailRows) {
      assert.ok(ENUM.has(row[3]), `★ CL-11 不成立：结论 ${JSON.stringify(row[3])} 不在三值枚举内`);
      assert.equal(row[3], '跳过');
      assert.ok((row[4] || '').trim().length > 0, '★ CL-11 不成立：结论=跳过 的备注为空');
    }
    // 物理：2 成功 + 1 失败 → 同时出现 已删除 / 未删除
    const r = withUnlinkFault(
      (p) => p.includes(codes[2]),
      () => { throw new Error('占用中'); },
      () => runPhysical(root, { nowMs: now }),
    );
    const rep = parseReport(reportTextOf(root, r.reportId));
    for (const row of rep.detailRows) {
      assert.ok(ENUM.has(row[3]), `★ CL-11 不成立：结论 ${JSON.stringify(row[3])} 不在三值枚举内`);
    }
    assert.ok(rep.detailRows.some((x) => x[3] === '已删除'));
    assert.ok(rep.detailRows.some((x) => x[3] === '未删除'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-12 S4 失败项行数==failed，且失败项编码集合 == 明细「未删除」编码集合（双向相等，一条不多一条不少）。
test('CL-12 失败项：行数==failed、编码集合==明细未删除集合（双向，S4）', () => {
  const root = mkLab('cl12');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 4 }, (_, i) => mkCode('20261109', 'cl12a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const r = withUnlinkFault(
      (p) => p.includes(codes[1]) || p.includes(codes[3]),
      () => { throw new Error('注入：占用中'); },
      () => runPhysical(root, { nowMs: now }),
    );
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.equal(Number(rep.yaml.get('失败')), 2);
    assert.equal(rep.failureRows.length, 2, `★ CL-12/S4 不成立：失败项行数=${rep.failureRows.length}（应 2）`);
    const textSet = rep.failureRows.map((x) => x[1]).sort();
    const detailSet = rep.detailRows.filter((x) => x[3] === '未删除').map((x) => x[1]).sort();
    assert.deepEqual(textSet, detailSet, '★ CL-12/S4 不成立：失败项编码集合 != 明细未删除集合');
    assert.deepEqual(textSet, [codes[1], codes[3]].sort());
    // 双向：已删除的编码不得出现在失败项
    for (const deletedCode of rep.detailRows.filter((x) => x[3] === '已删除').map((x) => x[1])) {
      assert.equal(textSet.includes(deletedCode), false, '★ CL-12 不成立：已删除项出现在失败项');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-13 附录 CSV：文件名固定 {report_id}-明细.csv；>50 时存在、UTF-8 BOM、5 列、
//      数据行==planned、appendix_rows 相符；引号转义可读回；正文 50 + 附录承载第 51+ 条。
test('CL-13 附录 CSV：{id}-明细.csv、BOM、5 列、数据行==planned、引号转义、第 51+ 条可读回', () => {
  const root = mkLab('cl13');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 55 }, (_, i) => mkCode('20261109', 'cl13a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const reason = '注入失败：文件被占用, "EBUSY"';
    const r = withUnlinkFault(
      (p) => p.includes(codes[0]),
      () => { throw new Error(reason); },
      () => runPhysical(root, { nowMs: now }),
    );
    assert.equal(r.planned, 55);
    assert.equal(r.failed, 1);
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.ok(rep.appendix, '★ CL-13 不成立：planned>50 缺少附录节');
    assert.equal(rep.appendix.file, `${r.reportId}-明细.csv`, '★ CL-13 不成立：附录文件名不是 {report_id}-明细.csv');
    assert.equal(rep.detailRows.length, 50, '★ CL-13 不成立：正文不是恰 50 条');
    const csvAbs = appendixPathOf(root, rep.appendix.file);
    assert.equal(fs.existsSync(csvAbs), true, '★ CL-13 不成立：附录 CSV 不存在');
    assert.equal(csvAbs, path.join(root, RPT_SUB, rep.appendix.file), 'V0.6.2：附录 CSV 写 清册/');
    const raw = fs.readFileSync(csvAbs);
    assert.deepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '★ CL-13 不成立：CSV 缺 UTF-8 BOM');
    const rows = parseCsv(raw.toString('utf8'));
    assert.equal(rows.length - 1, 55, `★ CL-13 不成立：CSV 数据行=${rows.length - 1}（应 55）`);
    assert.deepEqual(rows[0].map((x) => x.trim()), ['#', '编码', '产生时间', '结论', '备注'], '★ CL-13 不成立：CSV 表头/列序不符');
    for (const row of rows.slice(1)) {
      assert.equal(row.length, 5, `★ CL-13 不成立：CSV 行不是 5 列（${JSON.stringify(row)}）`);
    }
    assert.equal(rep.appendix.rows, 55, '★ CL-13 不成立：appendix_rows != 数据行');
    assert.equal(Number(rep.statsTable['计划清除']), 55);
    // 正文只列前 50：第 51+ 条编码不得出现在正文
    assert.equal(rep.detailRows.some((x) => x[1] === codes[50]), false, '★ CL-13 不成立：正文出现了第 51 条');
    // 附录承载第 51+ 条（含引号转义的备注可被独立解析器读回原值）
    assert.equal(rows[1][1], codes[0]);
    assert.equal(rows[1][4], `删除失败：${reason}`, '★ CL-13 不成立：CSV 引号转义/逗号字段读回不一致');
    assert.equal(rows[51][1], codes[50]);
    // 解析端必须能读回第 51+ 条：54 条已删除（第 1 条为未删除）应全部入 Map
    const map = readCleanedCodes(root);
    assert.deepEqual(map.readErrors, [], '★ CL-13 不成立：正常 CSV 不应有 readErrors');
    assert.equal(map.size, 54, `★ CL-13 不成立：解析回已删除条数=${map.size}（应 54）`);
    assert.equal(map.has(codes[50]), true, '★ CL-13/CH-20 不成立：第 51 条编码未被解析器读回');
    assert.equal(map.has(codes[54]), true, '★ CL-13/CH-20 不成立：第 55 条编码未被解析器读回');
    assert.equal(map.has(codes[0]), false, '★ CL-13 不成立：未删除项被误判为已删除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-14 复核行逐字格式 `^> 复核：<时间>（UTC+08:00）按台账 jsonl 重扫，剩余 N 条，与上表一致。$`；
//      其中剩余数 == YAML `目前剩余` == 统计表。
test('CL-14 复核行逐字格式 + 剩余数==remaining', () => {
  const root = mkLab('cl14');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl14a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const r = withUnlinkFault(
      (p) => p.includes(codes[0]),
      () => { throw new Error('占用中'); },
      () => runPhysical(root, { nowMs: now }),
    );
    const rep = parseReport(reportTextOf(root, r.reportId));
    const RE = /^> 复核：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+08:00）按台账 jsonl 重扫，剩余 \d+ 条，与上表一致。$/;
    assert.match(rep.recheckLine, RE, `★ CL-14 不成立：复核行格式不符：${JSON.stringify(rep.recheckLine)}`);
    const remaining = Number(/剩余 (\d+) 条/.exec(rep.recheckLine)[1]);
    assert.equal(remaining, Number(rep.yaml.get('目前剩余')), '★ CL-14 不成立：复核行剩余数 != YAML 目前剩余');
    assert.equal(remaining, rep.statsTable['目前剩余']);
    assert.equal(remaining, r.originalsBefore - r.deleted);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-15 无模板残留：无 `<!--` 注记、**模板生成部分**无 `{{`/`}}`、无口径/S1–S8 注释原文
//      （用户/原文内容合法含 `{{` 不改写——实现反馈 #3）。
test('CL-15 无模板残留（<!-- / {{ }} / 口径注释），用户内容合法 {{ }} 不误报', () => {
  const root = mkLab('cl15');
  try {
    const now = Date.now();
    const codes = [mkCode('20261109', 'cl15a0000001', 1), mkCode('20261109', 'cl15a0000001', 2)];
    putOriginal(root, { code: codes[0], mtimeMs: BASE_MS });
    putOriginal(root, { code: codes[1], mtimeMs: BASE_MS + 1000 });
    const userBraces = '用户原文合法含 {{双花括号}} 的备注';
    const r = withUnlinkFault(
      (p) => p.includes(codes[0]),
      () => { throw new Error(userBraces); },
      () => runPhysical(root, { nowMs: now }),
    );
    const text = reportTextOf(root, r.reportId);
    assert.equal(text.includes('<!--'), false, '★ CL-15/S5 不成立：产物含 `<!--` 注记');
    for (const marker of ['模板版本', '发布前自检', '口径 1', '口径 2', '口径 3', '口径 4', '口径 5',
      '口径 6', '口径 7', '口径 8', '口径 9', '口径 10', '口径 11']) {
      assert.equal(text.includes(marker), false, `★ CL-15/S5 不成立：产物含编辑说明/口径注释原文（${marker}）`);
    }
    // 合法用户内容 {{ }}：不改写、且自检 S5 必须放过
    assert.equal(text.includes(userBraces), true, '★ CL-15 不成立：用户内容里的 {{ }} 被改写');
    assert.doesNotThrow(
      () => checkCleanupReport({ text, csv: null, ctx: r.report.ctx }),
      '★ CL-15/S5 不成立：合法用户 {{ }} 被误判为模板残留',
    );
    // 把用户内容剔除后，模板生成部分必须无 {{ / }}
    const skeleton = text.split(userBraces).join('');
    assert.equal(skeleton.includes('{{'), false, '★ CL-15/S5 不成立：模板生成部分残留 {{');
    assert.equal(skeleton.includes('}}'), false, '★ CL-15/S5 不成立：模板生成部分残留 }}');
    // 反证：注入 `<!--` → S5 必须拒
    assert.throws(
      () => checkCleanupReport({ text: `${text}<!-- 注记 -->`, csv: null, ctx: r.report.ctx }),
      (e) => e.code === 'E_CLEANUP_S5',
      '★ CL-15/S5 不成立：`<!--` 注记未被自检拦下',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-16 所有时间字段 `YYYY-MM-DD HH:MM:SS`；日期字段 `YYYY-MM-DD`；全文无 Z（也无 ISO-T）。
test('CL-16 时间/日期格式：时间 YYYY-MM-DD HH:MM:SS、日期 YYYY-MM-DD、全文无 Z', () => {
  const root = mkLab('cl16');
  try {
    const now = Date.now();
    for (let i = 1; i <= 3; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl16a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    assert.match(rep.yaml.get('报告日期'), DATE);
    assert.match(rep.yaml.get('复核时间'), DT, '★ CL-16/S6 不成立：YAML 复核时间格式不符');
    for (const row of rep.detailRows) assert.match(row[2], DT, `★ CL-16/S6 不成立：明细产生时间格式不符：${row[2]}`);
    const recheckTime = /^> 复核：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(rep.recheckLine);
    assert.ok(recheckTime, '★ CL-16 不成立：复核行时间取不到');
    assert.match(recheckTime[1], DT);
    assert.match(rep.archiveLine, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '★ CL-16 不成立：留档行时间格式不符');
    const text = rep.text;
    assert.equal(/\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(text), false, '★ CL-16/CL-32 不成立：产物含 Z 结尾时间');
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text), false, '★ CL-16/S6 不成立：产物含 ISO-T 时间');
    // 全文所有"19 字符时间戳"都必须符合格式
    for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b/g)) {
      assert.match(m[0], DT, `★ CL-16/S6 不成立：出现非契约时间 ${m[0]}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-17 所有编码匹配 `^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$`；与 journal 记录的原文文件名
//      （去 ` 完整原文.md`）逐个相等（S8）。
test('CL-17 编码格式 32 位；与 journal 记录/原文文件名逐个一致（S8）', () => {
  const root = mkLab('cl17');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl17a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const beforeFiles = listOriginals(root).map((x) => path.basename(x.abs));
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    const CODE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;
    const detailCodes = rep.detailRows.map((x) => x[1]);
    for (const c of detailCodes) assert.match(c, CODE, `★ CL-17/S8 不成立：编码格式不符：${c}`);
    const journalRaw = fs.readFileSync(r.journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const plan = journalRaw[0];
    const resultCodes = journalRaw.slice(1, -1).map((x) => x.code);
    assert.equal(plan.kind, 'plan');
    assert.equal(plan.planned, r.planned);
    assert.equal(plan.beforeTotal, r.originalsBefore);
    // journal plan 记录的原文文件名（去 ` 完整原文.md`）== 清册编码，逐个相等
    assert.deepEqual(
      plan.files,
      detailCodes.map((c) => `${c} 完整原文.md`),
      '★ CL-17 不成立：清册编码与 journal plan 记录的原文文件名不一致',
    );
    // 明细编码 == journal result 编码（逐个相等，顺序一致）
    assert.deepEqual(resultCodes, detailCodes, '★ CL-17 不成立：明细编码与 journal 记录不逐个相等');
    // 每个编码对应的原文文件名（去 ` 完整原文.md`）== 编码
    for (const c of detailCodes) {
      assert.equal(beforeFiles.includes(`${c} 完整原文.md`), true, `★ CL-17 不成立：${c} 与原文文件名不一致`);
    }
    // createdAt 与 journal 一致
    const byCode = new Map(rep.detailRows.map((x) => [x[1], x[2]]));
    for (const line of journalRaw.slice(1, -1)) {
      assert.equal(line.createdAt, byCode.get(line.code), '★ CL-17 不成立：明细产生时间与 journal 不一致');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-18 留档行 `^**留档：** <时间>（UTC+08:00）· RPT-… · 生成器 \S+$`（v0.5：序号 \d+）。
test('CL-18 留档行：**留档：** 时间（UTC+08:00）· RPT-… · 生成器 \\S+', () => {
  const root = mkLab('cl18');
  try {
    const now = Date.now();
    putOriginal(root, { code: mkCode('20261109', 'cl18a0000001', 1), mtimeMs: BASE_MS });
    const r = runPhysical(root, { nowMs: now });
    const rep = parseReport(reportTextOf(root, r.reportId));
    const RE = /^\*\*留档：\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+08:00）· RPT-\d{8}-\d+ · 生成器 \S+$/;
    assert.match(rep.archiveLine, RE, `★ CL-18 不成立：留档行格式不符：${JSON.stringify(rep.archiveLine)}`);
    assert.ok(rep.archiveLine.includes(r.reportId), '★ CL-18 不成立：留档行不含报告编号');
    assert.ok(rep.archiveLine.includes(r.report.ctx.generator), '★ CL-18 不成立：留档行不含生成器');
    // **结束** 在留档行之前
    const beforeArchive = rep.lines.slice(0, rep.lines.lastIndexOf(rep.archiveLine));
    assert.ok(beforeArchive.some((l) => l.trim() === '**结束**'), '★ CL-18 不成立：缺 **结束** 行');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 四、CL-19…CL-27：S1–S8 / 编号 / dry-run / journal / 故障注入 / 排他写
// ============================================================================

// 守：CL-19 构造 S1–S8 违规输入：不写盘、报 E_CLEANUP_S<n>、journal 保留现场。
//       S1–S8 逐条用"篡改后的正文+上下文"打自检（渲染器是唯一实现，checkCleanupReport 在写盘前调用）；
//       集成层再以真实坏输入（mtime=NaN → S6）证明 runCleanup 不写终稿、journal 留证。
test('CL-19 S1–S8 逐条拒写盘并报 E_CLEANUP_S<n>；journal 保留现场（S6 真实注入）', () => {
  const unitRoot = mkLab('cl19a');
  const realRoot = mkLab('cl19b');
  try {
    const now = Date.now();
    // ---- 造一份合法报告作为篡改基线（dry-run，无删除）----
    for (let i = 1; i <= 2; i += 1) putOriginal(unitRoot, { code: mkCode('20261109', 'cl19a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const baseRun = runCleanup({ root: unitRoot, nowMs: now });
    assert.ok(baseRun.report, '前置失败：dry-run 应返回报告上下文');
    const { text: B, csv: C, ctx: X } = baseRun.report;
    assert.equal(C, null);
    assert.doesNotThrow(() => checkCleanupReport({ text: B, csv: C, ctx: X }), '前置失败：合法报告未通过自检');

    const beforeUnit = snapshot(unitRoot);
    const expectS = (n, fn) => {
      assert.throws(fn, (e) => e.code === `E_CLEANUP_S${n}`, `★ CL-19 不成立：S${n} 违规未被拦下`);
    };
    // S1：planned != succeeded+failed+skipped
    expectS(1, () => checkCleanupReport({ text: B, csv: C, ctx: { ...X, planned: X.planned + 1 } }));
    // S2：remaining != before_total - succeeded
    expectS(2, () => checkCleanupReport({ text: B, csv: C, ctx: { ...X, remaining: X.remaining + 1 } }));
    // S3：正文明细行数 != planned
    const detailIdx = B.split('\n').findIndex((l) => /^\| 1 \| \d{8}-/.test(l));
    const broken3 = B.split('\n');
    broken3.splice(detailIdx, 1);
    expectS(3, () => checkCleanupReport({ text: broken3.join('\n'), csv: C, ctx: X }));
    // S4：失败项行数 != failed（伪造 1 行失败项，ctx.failed=0）
    const fakeFail = B.replace(
      '| ---: | :--- | :--- | :--- |\n',
      `| ---: | :--- | :--- | :--- |\n| 1 | ${X.items[0].code} | 伪造失败 | 保留（未删除） |\n`,
    );
    expectS(4, () => checkCleanupReport({ text: fakeFail, csv: C, ctx: X }));
    // S5：正文含 `<!--` 注记
    expectS(5, () => checkCleanupReport({ text: `${B}<!-- 注记 -->`, csv: C, ctx: X }));
    // S6：复核时间写成 ISO-T（无空格、带 T）
    const broken6 = B.replace(`复核：${X.verified_at}`, '复核：2026-11-09T20:00:00');
    expectS(6, () => checkCleanupReport({ text: broken6, csv: C, ctx: X }));
    // S7：抬头表字段被改（与前置数据块不一致）
    const broken7 = B.replace('| 委托人 | user |', '| 委托人 | hacker |');
    expectS(7, () => checkCleanupReport({ text: broken7, csv: C, ctx: X }));
    // S8：编码被改坏
    const broken8 = B.replace(X.items[0].code, `${X.items[0].code.slice(0, -1)}Z`);
    expectS(8, () => checkCleanupReport({ text: broken8, csv: C, ctx: X }));
    assert.deepEqual(snapshot(unitRoot), beforeUnit, '★ CL-19 不成立：自检失败路径写盘了');

    // ---- 集成：真实坏输入（mtime=NaN → 明细产生时间非法 → S6）----
    for (let i = 1; i <= 2; i += 1) putOriginal(realRoot, { code: mkCode('20261109', 'cl19b0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const expectedId = nextReportId(realRoot);
    const origStat = fs.statSync;
    let thrown = null;
    try {
      fs.statSync = function patched(p, ...args) {
        const st = origStat.call(fs, p, ...args);
        if (String(p).endsWith(' 完整原文.md')) return { size: st.size, mtimeMs: Number.NaN, isFile: () => true };
        return st;
      };
      runPhysical(realRoot, { nowMs: now });
    } catch (e) {
      thrown = e;
    } finally {
      fs.statSync = origStat;
    }
    assert.ok(thrown, '★ CL-19 不成立：S6 违规输入没有报错（静默写盘）');
    assert.equal(thrown.code, 'E_CLEANUP_S6', `★ CL-19 不成立：错误码=${thrown.code}（应 E_CLEANUP_S6）`);
    assert.deepEqual(reportNames(realRoot, /^RPT-\d{8}-\d+\.md$/), [], '★ CL-19 不成立：自检不过仍写了正式清册');
    const journalPath = path.join(realRoot, 'ledger', `.cleanup-${expectedId}.journal`);
    assert.equal(fs.existsSync(journalPath), true, '★ CL-19 不成立：自检失败后 journal 没有保留现场');
    const jl = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(jl[0].kind, 'plan');
    assert.equal(jl[jl.length - 1].kind, 'result', '★ CL-19 不成立：自检失败却写了 finalize（伪完成）');
    assert.equal(realRoot.length > 0, true);
    assert.deepEqual(reportNames(realRoot, /\.tmp/), [], '★ CL-19 不成立：失败路径残留 .tmp');
  } finally {
    fs.rmSync(unitRoot, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

// 守：CL-20 删 state 后编号按目录最大号接续；未完成 journal 允许复用未占用号（本实现选择"继续 +1"
//      以保留证据，3.7 第 5 条允许）；已写出终稿的编号不得复用。
test('CL-20 编号扫目录（删 state 接续）；未完成 journal 不破坏；已出终稿号不复用', () => {
  const root = mkLab('cl20');
  try {
    const now = Date.now();
    const day = dayOf(now);
    // 全新的库：01 起；写 state 不影响（不读 state）
    assert.equal(nextReportId(root), `RPT-${day}-01`);
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', '.state.json'), JSON.stringify({ next: 77 }), 'utf8');
    fs.writeFileSync(path.join(root, `RPT-${day}-01.md`), '# 占位\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-02`, '★ CL-20 不成立：编号被 state 带偏');
    // 删 state：仍按目录最大号接续
    fs.rmSync(path.join(root, 'ledger', '.state.json'));
    assert.equal(nextReportId(root), `RPT-${day}-02`, '★ CL-20 不成立：删 state 后编号回退/撞号');
    fs.writeFileSync(path.join(root, `RPT-${day}-02.md`), '# 占位\n', 'utf8');
    // 未完成 journal（有 plan 无 finalize、无终稿）：允许复用未占用号；本实现继续 +1 以保证据
    const orphan = path.join(root, 'ledger', `.cleanup-RPT-${day}-05.journal`);
    fs.writeFileSync(orphan, `${JSON.stringify({ kind: 'plan', reportId: `RPT-${day}-05`, at: stampOf(now), scope: 'x', beforeTotal: 9, planned: 9 })}\n`, 'utf8');
    const orphanSha = sha256(fs.readFileSync(orphan));
    assert.equal(nextReportId(root), `RPT-${day}-06`, '★ CL-20 不成立：未完成 journal 占用的号未被安全处理（应继续 +1）');
    // 真实运行：不得复用 05（证据保留），不得覆盖 02；新号 06
    putOriginal(root, { code: mkCode('20261109', 'cl20a0000001', 1), mtimeMs: BASE_MS });
    const sha02 = sha256(fs.readFileSync(path.join(root, `RPT-${day}-02.md`)));
    const r = runPhysical(root, { nowMs: now });
    assert.equal(r.reportId, `RPT-${day}-06`, `★ CL-20 不成立：运行编号=${r.reportId}（应 ${`RPT-${day}-06`}）`);
    assert.equal(sha256(fs.readFileSync(orphan)), orphanSha, '★ CL-20 不成立：未完成 journal 被改写/删除');
    assert.equal(sha256(fs.readFileSync(path.join(root, `RPT-${day}-02.md`))), sha02, '★ CL-20 不成立：已出终稿号被覆盖');
    // V0.6.2：新终稿写在 清册/（一级老清册保持原样，已出终稿号不得复用）。
    assert.equal(r.path, path.join(root, RPT_SUB, `RPT-${day}-06.md`), '新终稿必须落在 清册/');
    assert.equal(fs.existsSync(path.join(root, RPT_SUB, `RPT-${day}-06.md`)), true);
    assert.equal(fs.existsSync(path.join(root, `RPT-${day}-06.md`)), false, '写端不得再写一级');
    // 第二次运行：07（已出终稿 06 不得复用）
    putOriginal(root, { code: mkCode('20261109', 'cl20a0000001', 2), mtimeMs: BASE_MS + 1000 });
    const r2 = runPhysical(root, { nowMs: now });
    assert.equal(r2.reportId, `RPT-${day}-07`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-21 同日编号严格递增、不复用；序号 `\d+`（D16：99→100→101 不回绕）；不存在同号两份。
test('CL-21 同日递增不复用；序号 \\d+（99→100→101→102→103）', () => {
  const root = mkLab('cl21');
  const runRoot = mkLab('cl21run');
  try {
    const now = Date.now();
    const day = dayOf(now);
    assert.equal(nextReportId(root), `RPT-${day}-01`);
    fs.writeFileSync(path.join(root, `RPT-${day}-01.md`), '# 占位\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-02`);
    fs.writeFileSync(path.join(root, `RPT-${day}-02.md`), '# 占位\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-03`, '★ CL-21 不成立：01/02 后下一号不是 03');
    for (const n of [99, 100, 101]) fs.writeFileSync(path.join(root, `RPT-${day}-${n}.md`), '# 占位\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-102`, '★ CL-21 不成立：99/100/101 后下一号不是 102（D16 不回绕）');
    fs.writeFileSync(path.join(root, `RPT-${day}-102.md`), '# 占位\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-103`);
    // 两次真实运行：编号递增、无同号
    putOriginal(runRoot, { code: mkCode('20261109', 'cl21a0000001', 1), mtimeMs: BASE_MS });
    const r1 = runPhysical(runRoot, { nowMs: now });
    putOriginal(runRoot, { code: mkCode('20261109', 'cl21a0000001', 2), mtimeMs: BASE_MS + 1000 });
    const r2 = runPhysical(runRoot, { nowMs: now });
    assert.notEqual(r1.reportId, r2.reportId, '★ CL-21 不成立：同日两次运行编号相同');
    const serial1 = Number(/^RPT-\d{8}-(\d+)$/.exec(r1.reportId)[1]);
    const serial2 = Number(/^RPT-\d{8}-(\d+)$/.exec(r2.reportId)[1]);
    assert.equal(serial2, serial1 + 1, '★ CL-21 不成立：同日编号未严格递增');
    // V0.6.2：两次终稿都写 清册/（双路径合计恰 2 份、无同号两份）。
    const formals = reportNames(runRoot, /^RPT-\d{8}-\d+\.md$/);
    assert.equal(formals.length, 2, `★ CL-21 不成立：终稿份数=${formals.length}（应 2）`);
    assert.equal(new Set(formals).size, formals.length, '★ CL-21 不成立：存在同号两份');
    assert.equal(fs.existsSync(path.join(runRoot, RPT_SUB, `${r1.reportId}.md`)), true);
    assert.equal(fs.existsSync(path.join(runRoot, RPT_SUB, `${r2.reportId}.md`)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

// 守：CL-22 dry-run 文件名 `^RPT-DRYRUN-\d{8}-\d+\.md$`；正式编号扫描正则不匹配 DRYRUN；不占正式号。
test('CL-22 dry-run 文件名独立前缀；正式扫描不匹配、不占正式号（D16 \\d+）', () => {
  const root = mkLab('cl22');
  try {
    const now = Date.now();
    const day = dayOf(now);
    for (let i = 1; i <= 2; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl22a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const before = nextReportId(root);
    const r1 = runCleanup({ root, nowMs: now });
    assert.match(path.basename(r1.path), /^RPT-DRYRUN-\d{8}-\d+\.md$/, '★ CL-22 不成立：dry-run 文件名不符');
    assert.match(r1.reportId, /^RPT-DRYRUN-\d{8}-\d+$/);
    assert.equal(fs.existsSync(path.join(root, RPT_SUB, `${r1.reportId}.md`)), true, 'V0.6.2：dry-run 报告写 清册/');
    assert.equal(fs.existsSync(path.join(root, `${r1.reportId}.md`)), false, 'V0.6.2：不得再写一级');
    assert.deepEqual(reportNames(root, /^RPT-\d{8}-\d+\.md$/), [], '★ CL-22 不成立：dry-run 产了正式 RPT');
    assert.equal(nextReportId(root), before, '★ CL-22 不成立：dry-run 占用了正式编号');
    const r2 = runCleanup({ root, nowMs: now });
    assert.notEqual(r2.reportId, r1.reportId, '★ CL-22 不成立：两次 dry-run 编号相同');
    assert.match(r2.reportId, /^RPT-DRYRUN-\d{8}-\d+$/);
    assert.equal(nextReportId(root), before, '★ CL-22 不成立：dry-run 推进了正式编号');
    // 正式编号扫描正则不含 DRYRUN：目录里只有 dry-run 文件时，正式下一号仍是 01
    const onlyDry = mkLab('cl22b');
    try {
      fs.writeFileSync(path.join(onlyDry, `RPT-DRYRUN-${day}-01.md`), '# dry\n', 'utf8');
      assert.equal(nextReportId(onlyDry), `RPT-${day}-01`, '★ CL-22 不成立：正式编号扫描匹配到了 DRYRUN');
    } finally {
      fs.rmSync(onlyDry, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-23 dry-run 不删任何文件；明细结论全 `跳过`+备注`试运行`；正式号不前进；
//      YAML `上一轮报告` == `（试运行）`（决定 9 #13 / R24）。
test('CL-23 dry-run 行为：零删除、全 跳过+试运行、正式号不前进、上一轮报告=（试运行）', () => {
  const root = mkLab('cl23');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl23a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000, attachment: i === 0 }));
    const before = snapshot(root);
    const nextBefore = nextReportId(root);
    const r = runCleanup({ root, nowMs: now });
    assert.equal(r.mode, 'dry-run');
    assert.equal(r.deleted, 0, '★ CL-23 不成立：dry-run 删了文件');
    assert.equal(listOriginals(root).length, 3);
    const diff = diffSnap(before, snapshot(root));
    assert.deepEqual(diff.removed, [], '★ CL-23 不成立：dry-run 删了文件');
    assert.deepEqual(diff.changed, [], '★ CL-23 不成立：dry-run 改写了已有文件');
    assert.deepEqual(diff.added, [`${RPT_SUB}/${r.reportId}.md`], '★ CL-23 不成立：dry-run 新增文件不是仅报告本身（且应在 清册/）');
    const rep = parseReport(reportTextOf(root, r.reportId));
    assert.equal(rep.detailRows.length, 3);
    for (const row of rep.detailRows) {
      assert.equal(row[3], '跳过', '★ CL-23 不成立：dry-run 明细结论不是全 跳过');
      assert.equal(row[4], '试运行', '★ CL-23 不成立：dry-run 明细备注不是 试运行');
    }
    assert.equal(rep.yaml.get('上一轮报告'), '（试运行）', '★ CL-23 不成立：YAML 上一轮报告 !=（试运行）');
    assert.equal(new Map(rep.headerRows.map((x) => [x[0], x[1]])).get('上一轮报告'), '（试运行）', '★ CL-23 不成立：抬头表上一轮报告 !=（试运行）');
    assert.equal(Number(rep.yaml.get('目前剩余')), 3);
    assert.equal(nextReportId(root), nextBefore, '★ CL-23 不成立：dry-run 推进了正式编号');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-24 journal 路径 `<root>/ledger/.cleanup-<id>.journal` 存在；不是 `.jsonl`（不被台账扫描误读）；
//      行数 == 2 + planned。
test('CL-24 journal 路径/后缀/行数：ledger/.cleanup-<id>.journal，行数==2+planned', () => {
  const root = mkLab('cl24');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl24a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const r = runPhysical(root, { nowMs: now });
    const expected = path.join(root, 'ledger', `.cleanup-${r.reportId}.journal`);
    assert.equal(r.journalPath, expected, '★ CL-24 不成立：journal 路径不符');
    assert.equal(fs.existsSync(expected), true, '★ CL-24 不成立：journal 不存在');
    assert.equal(path.basename(expected).endsWith('.jsonl'), false, '★ CL-24 不成立：journal 用了 .jsonl 后缀');
    const lines = fs.readFileSync(expected, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2 + r.planned, `★ CL-24 不成立：journal 行数=${lines.length}（应 2+${r.planned}）`);
    assert.equal(fs.readdirSync(path.join(root, 'ledger')).some((n) => n.endsWith('.jsonl')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-25 journal 内容：首行 kind=plan、中间 planned×kind=result、末行 kind=finalize；
//      每行可 JSON 解析；所有 at 匹配 `YYYY-MM-DD HH:MM:SS`；终稿成功后 journal 仍保留。
test('CL-25 journal 内容：plan + N×result + finalize，每行 JSON、at 格式、终稿后保留', () => {
  const root = mkLab('cl25');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl25a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const r = runPhysical(root, { nowMs: now });
    const raw = fs.readFileSync(r.journalPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const events = lines.map((l, i) => {
      let obj;
      assert.doesNotThrow(() => { obj = JSON.parse(l); }, `★ CL-25 不成立：journal 第 ${i + 1} 行不是 JSON：${l}`);
      return obj;
    });
    assert.equal(events.length, 2 + r.planned);
    assert.equal(events[0].kind, 'plan', '★ CL-25 不成立：首行不是 plan');
    assert.equal(events[events.length - 1].kind, 'finalize', '★ CL-25 不成立：末行不是 finalize');
    const middles = events.slice(1, -1);
    assert.equal(middles.length, r.planned);
    for (const e of middles) {
      assert.equal(e.kind, 'result', '★ CL-25 不成立：中间行不是 result');
      assert.match(e.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '★ CL-25 不成立：result.at 格式不符');
      assert.match(e.code, /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/);
    }
    for (const e of events) {
      assert.match(e.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `★ CL-25 不成立：${e.kind}.at 格式不符`);
    }
    assert.deepEqual(middles.map((x) => x.n), [1, 2, 3], '★ CL-25 不成立：result n 不连续');
    assert.equal(events[events.length - 1].reportFile, `${r.reportId}.md`);
    assert.match(events[events.length - 1].checks, /S1\.\.S8 pass/, '★ CL-25 不成立：finalize.checks 未写 S1..S8 pass');
    // 终稿后保留：报告存在 + journal 仍存在且内容未被 cleanup 自己删改
    assert.equal(fs.existsSync(r.path), true, '前置失败：终稿不存在');
    assert.equal(fs.existsSync(r.journalPath), true, '★ CL-25 不成立：终稿成功后 journal 被删除');
    assert.equal(fs.readFileSync(r.journalPath, 'utf8'), raw, '★ CL-25 不成立：终稿后 journal 被改写');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-26 故障注入（plan 后 / 删除中途 kill）：正式报告不存在（或已存在则 S1–S8 全过）；
//      不存在含"待删/待处理"结论的中间报告；journal 行都是完整 JSON（无半行）。
test('CL-26 删除中途 kill：无正式报告/无"待删"中间报告，journal 留完整现场', async () => {
  const root = mkLab('cl26');
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clv13-child-'));
  let child = null;
  try {
    const codes = Array.from({ length: 4 }, (_, i) => mkCode('20261109', 'cl26a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const pluginPath = path.join(SRC, 'freeze', 'cleanup.js');
    const childScript = path.join(childDir, 'child-kill.mjs');
    fs.writeFileSync(childScript, [
      "import fs from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      'const root = process.argv[2];',
      'const plugin = process.argv[3];',
      'const cl = await import(pathToFileURL(plugin).href);',
      'const orig = fs.unlinkSync;',
      'let n = 0;',
      'fs.unlinkSync = function patched(p) {',
      '  const out = orig.call(fs, p);',
      '  n += 1;',
      '  if (n === 1) { const t = Date.now(); while (Date.now() - t < 8000) { /* busy wait */ } }',
      '  return out;',
      '};',
      'cl.runCleanup({ root, dryRun: false, cleanupAllowPhysicalDelete: true });',
      '',
    ].join('\n'), 'utf8');
    child = spawn(process.execPath, [childScript, root, pluginPath], { stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    // 等 journal（plan 行）出现 → 子进程已进入删除循环
    const ledgerDir = path.join(root, 'ledger');
    let journalName = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      let names = [];
      try { names = fs.readdirSync(ledgerDir).filter((n) => /^\.cleanup-RPT-\d{8}-\d+\.journal$/.test(n)); } catch { names = []; }
      if (names.length) { journalName = names[0]; break; }
      await sleep(20);
    }
    assert.ok(journalName, '★ CL-26 不成立：kill 前 journal 未落盘（plan 行都没有）');
    await sleep(120); // 让子进程进入 busy-wait（已删第 1 个文件、结果行未写）
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await Promise.race([exited, sleep(5000)]);
    // ① 正式报告：不存在（或已存在则 S1–S8 全过——kill 在终稿写盘前，必然不存在）
    const formals = reportNames(root, /^RPT-\d{8}-\d+\.md$/);
    assert.deepEqual(formals, [], `★ CL-26 不成立：删除中途被 kill 仍出现正式报告 ${JSON.stringify(formals)}`);
    // ② 无"待删/待处理"中间报告（双路径：清册/ 与一级都扫）
    for (const dir of reportDirs(root)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { names = []; }
      for (const n of names) {
        if (!n.endsWith('.md')) continue;
        const t = fs.readFileSync(path.join(dir, n), 'utf8');
        assert.equal(/待删|待处理/.test(t), false, `★ CL-26 不成立：出现含待删/待处理结论的报告 ${n}`);
      }
    }
    // ③ journal 保留且每行完整 JSON（无半行）
    const journalPath = path.join(ledgerDir, journalName);
    assert.equal(fs.existsSync(journalPath), true);
    const jl = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(jl.length >= 1);
    for (const line of jl) assert.doesNotThrow(() => JSON.parse(line), '★ CL-26 不成立：journal 有半行 JSON');
    assert.equal(JSON.parse(jl[0]).kind, 'plan');
    assert.notEqual(JSON.parse(jl[jl.length - 1]).kind, 'finalize', '★ CL-26 不成立：kill 后 journal 却写了 finalize');
    const crashedId = JSON.parse(jl[0]).reportId;
    const crashedSha = sha256(fs.readFileSync(journalPath));
    // ④ 恢复：下次运行接续编号（不复用未完成号）、不覆盖旧 journal、能正常出终稿
    const r = runPhysical(root, { nowMs: Date.now() });
    assert.notEqual(r.reportId, crashedId, '★ CL-26/CL-20 不成立：未完成 journal 的编号被复用');
    assert.equal(sha256(fs.readFileSync(journalPath)), crashedSha, '★ CL-26 不成立：恢复运行覆盖了旧 journal');
    // V0.6.2：恢复运行的终稿写在 清册/，且一级不得出现新报告。
    assert.equal(fs.existsSync(path.join(root, RPT_SUB, `${r.reportId}.md`)), true, '★ CL-26 不成立：恢复运行未写出终稿');
    assert.equal(fs.existsSync(path.join(root, `${r.reportId}.md`)), false, 'V0.6.2：终稿不得写一级');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(childDir, { recursive: true, force: true });
  }
});

// 守：CL-27 终稿排他写：目标编号文件已存在 → E_CLEANUP_ID_CONFLICT，不覆盖（字节不变）；
//      journal 留证、无 .tmp 残留。
test('CL-27 排他写：目标编号已存在 → E_CLEANUP_ID_CONFLICT，不覆盖（字节不变）', () => {
  const root = mkLab('cl27');
  try {
    const now = Date.now();
    const codes = [mkCode('20261109', 'cl27a0000001', 1), mkCode('20261109', 'cl27a0000001', 2)];
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000 }));
    const expectedId = nextReportId(root);
    // V0.6.2：排他写的目标是 `清册/` 下的新布局路径；先建目录，让"并发进程"能抢写同名目标。
    const targetPath = path.join(root, RPT_SUB, `${expectedId}.md`);
    fs.mkdirSync(path.join(root, RPT_SUB), { recursive: true });
    const sentinel = Buffer.from('# 已被并发进程抢占（排他写必须拒绝覆盖）\n', 'utf8');
    const orig = fs.unlinkSync;
    let armed = false;
    let thrown = null;
    try {
      fs.unlinkSync = function patched(p) {
        const out = orig.call(fs, p);
        if (!armed) { armed = true; fs.writeFileSync(targetPath, sentinel); }
        return out;
      };
      runPhysical(root, { nowMs: now });
    } catch (e) {
      thrown = e;
    } finally {
      fs.unlinkSync = orig;
    }
    assert.ok(thrown, '★ CL-27 不成立：目标已存在却静默覆盖');
    assert.equal(thrown.code, 'E_CLEANUP_ID_CONFLICT', `★ CL-27 不成立：错误码=${thrown.code}`);
    assert.deepEqual(fs.readFileSync(targetPath), sentinel, '★ CL-27 不成立：已存在的目标字节被改');
    // journal 仍在（现场保留），且未写 finalize
    const journalPath = path.join(root, 'ledger', `.cleanup-${expectedId}.journal`);
    assert.equal(fs.existsSync(journalPath), true, '★ CL-27 不成立：冲突路径 journal 未留证');
    const jl = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(jl[0].kind, 'plan');
    assert.notEqual(jl[jl.length - 1].kind, 'finalize');
    // 无 .tmp 残留（双路径：清册/ 与一级）
    assert.deepEqual(reportNames(root, /\.tmp/), [], '★ CL-27 不成立：残留临时文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 五、CL-28…CL-32：删除范围 / 新旧格式解析 / 统计三处一致 / 无 Z
// ============================================================================

// 守：CL-28 只删第三级；台账/周账/交接表/既有清册字节 sha256 集合不变；删除数==成功数。
test('CL-28 删除范围：只删第 3 级；台账/周账/交接表/既有清册字节不变；删除数==成功数', () => {
  const root = mkLab('cl28');
  try {
    const now = Date.now();
    const codes = Array.from({ length: 3 }, (_, i) => mkCode('20261109', 'cl28a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(root, { code, mtimeMs: BASE_MS + i * 1000, attachment: i === 0 }));
    // 台账 jsonl（真实记录，复核要用）+ 二级周账 + 一级交接表 + 既有清册
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', '2026-11-09.jsonl'),
      codes.map((c) => JSON.stringify({ code: c, ts: '2026-11-09T10:00:00+08:00', status: 'ok' })).join('\n') + '\n', 'utf8');
    fs.mkdirSync(path.join(root, '2026年11月'), { recursive: true });
    fs.writeFileSync(path.join(root, '2026年11月', '11月第2周-cl28a0000001A的周记账.xlsx'), 'fake-xlsx', 'utf8');
    fs.writeFileSync(path.join(root, 'cl28a0000001A的记忆数据库的启用及交接表.md'), '# 交接表\n', 'utf8');
    fs.writeFileSync(path.join(root, 'RPT-20261108-01.md'), '# 既有清册\n', 'utf8');
    const before = snapshot(root);
    const r = runPhysical(root, { nowMs: now });
    const after = snapshot(root);
    const diff = diffSnap(before, after);
    // 删除项 == 3 视图 + 1 附件（全在第 3 级）
    const viewRels = codes.map((c) => originalPath(root, BASE_MS, c));
    void viewRels;
    assert.equal(diff.removed.length, 4, `★ CL-28 不成立：删除文件数=${diff.removed.length}（应 4=3 视图+1 附件）`);
    for (const rel of diff.removed) {
      assert.match(rel, /完整原文”/, `★ CL-28 不成立：删了第 3 级以外的文件 ${rel}`);
      assert.match(rel, /\.(md|json)$/);
    }
    // 既有文件一个字节都没改
    assert.deepEqual(diff.changed, [], '★ CL-28 不成立：已有文件被改写');
    for (const rel of ['ledger/2026-11-09.jsonl', 'RPT-20261108-01.md', 'cl28a0000001A的记忆数据库的启用及交接表.md']) {
      const b = before.find((x) => x.rel === rel);
      const a = after.find((x) => x.rel === rel);
      assert.ok(a && b, `前置失败：${rel} 不存在`);
      assert.equal(a.sha, b.sha, `★ CL-28 不成立：${rel} 字节被改`);
    }
    // 删除数 == 成功数 == journal 已删除行数
    assert.equal(r.deleted, 3);
    assert.equal(r.succeeded, 3, '★ CL-28 不成立：删除数 != 成功数');
    const jl = fs.readFileSync(r.journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(jl.filter((x) => x.kind === 'result' && x.result === '已删除').length, 3);
    assert.equal(listOriginals(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-29 新旧格式解析（新）：v1.3 明细 → readCleanedCodesCompat 解析出 编码→RPT 号；
//      只认 结论=已删除（未删除/跳过不得命中）；附录 CSV 第 51+ 条同样可解析。
test('CL-29 新格式解析：v1.3 明细→编码/RPT 号，只认结论=已删除（含附录 CSV）', () => {
  const root = mkLab('cl29');
  try {
    const c = (n) => mkCode('20261110', 'cl29a0000001', n);
    const rptId = 'RPT-20261110-01';
    fs.writeFileSync(path.join(root, `${rptId}.md`), [
      '# 清册（v1.3 新格式）', '',
      '| # | 编码 | 产生时间（UTC+08:00） | 结论 | 备注 |',
      '| ---: | :--- | :--- | :--- | :--- |',
      `| 1 | ${c(1)} | 2026-11-10 10:00:00 | 已删除 | 正常销毁 |`,
      `| 2 | ${c(2)} | 2026-11-10 10:01:00 | 未删除 | 已删除（备注里的干扰词） |`,
      `| 3 | ${c(3)} | 2026-11-10 10:02:00 | 跳过 | 已删除（历史备注） |`,
      '',
    ].join('\n'), 'utf8');
    // 附录 CSV（第 51+ 条）：BOM + 引号转义
    fs.writeFileSync(path.join(root, `${rptId}-明细.csv`),
      `\uFEFF# , 编码 , 产生时间 , 结论 , 备注\r\n51,${c(51)},"2026-11-10 10:00:00","已删除","含,逗号"\r\n52,${c(52)},"2026-11-10 10:00:00","未删除","x"\r\n53,${c(53)},"2026-11-10 10:00:00","已删除",""\r\n`,
      'utf8');
    const compat = readCleanedCodesCompat(root);
    const base = readCleanedCodes(root);
    for (const map of [compat, base]) {
      assert.equal(map.has(c(1)), true, '★ CL-29 不成立：结论=已删除 的编码未命中');
      assert.equal(map.get(c(1)), rptId, '★ CL-29 不成立：编码→RPT 号映射错误');
      assert.equal(map.has(c(2)), false, '★ CL-29 不成立：结论=未删除 被误判已清理');
      assert.equal(map.has(c(3)), false, '★ CL-29 不成立：结论=跳过 被误判已清理');
      assert.equal(map.has(c(51)), true, '★ CL-29/CH-20 不成立：附录第 51 条未命中');
      assert.equal(map.get(c(51)), rptId);
      assert.equal(map.has(c(52)), false);
      assert.equal(map.has(c(53)), true);
    }
    assert.deepEqual(base.readErrors, [], '★ CL-29 不成立：合法样本出现 readErrors');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-30 旧格式兼容（必须）：v0.4 旧明细行 `| 编码 | 会话键 | 月份 | 大小 | 结果 |` 同样解析成功；
//      否则历史"已清理"会被误判"缺凭证"（决定 9 #15）。
test('CL-30 旧格式（v0.4）兼容：结果列=已删除 同样解析成功（必须）', () => {
  const root = mkLab('cl30');
  try {
    const c = (n) => mkCode('20261108', 'cl30a0000001', n);
    const rptId = 'RPT-20261108-02';
    fs.writeFileSync(path.join(root, `${rptId}.md`), [
      '# 清册（v0.4 旧格式）', '',
      '| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |',
      '|---|---|---|---:|---|---|',
      `| \`${c(1)}\` | cl30a0000001A | 2026-11 | 1.0 KB | 已删除 |  |`,
      `| \`${c(2)}\` | cl30a0000001A | 2026-11 | 1.0 KB | 未删除 | 已删除（备注干扰） |`,
      '',
    ].join('\n'), 'utf8');
    const compat = readCleanedCodesCompat(root);
    const base = readCleanedCodes(root);
    for (const map of [compat, base]) {
      assert.equal(map.has(c(1)), true, '★ CL-30 不成立：v0.4 旧格式已删除行未解析');
      assert.equal(map.get(c(1)), rptId);
      assert.equal(map.has(c(2)), false, '★ CL-30 不成立：旧格式未删除行被误判');
    }
    assert.equal(compat.size, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：CL-31 统计表 6 数字与统计句、YAML 三处完全相等（口径 10：前置数据块是唯一事实源）。
test('CL-31 统计三处一致：统计句/统计表/YAML 逐字段相等（口径 10）', () => {
  const physRoot = mkLab('cl31a');
  const dryRoot = mkLab('cl31b');
  try {
    const now = Date.now();
    // 物理：4 条，2 失败 → before=4, planned=4, succeeded=2, failed=2, skipped=0, remaining=2
    const codes = Array.from({ length: 4 }, (_, i) => mkCode('20261109', 'cl31a0000001', i + 1));
    codes.forEach((code, i) => putOriginal(physRoot, { code, mtimeMs: BASE_MS + i * 1000 }));
    const r = withUnlinkFault(
      (p) => p.includes(codes[0]) || p.includes(codes[2]),
      () => { throw new Error('占用中'); },
      () => runPhysical(physRoot, { nowMs: now }),
    );
    const check = (rep) => {
      const keys = ['清理前总数', '计划清除', '成功', '失败', '跳过', '目前剩余'];
      const yamlNums = keys.map((k) => Number(rep.yaml.get(k)));
      const sentence = rep.sentenceNums;
      assert.equal(sentence.length, 5, `★ CL-31 不成立：统计句数字个数=${sentence.length}`);
      // 统计句 5 个数（计划/成功/失败/跳过/剩余）对应 YAML 后 5 个字段
      assert.deepEqual(sentence, yamlNums.slice(1), '★ CL-31 不成立：统计句 != YAML');
      assert.deepEqual(keys.map((k) => rep.statsTable[k]), yamlNums, '★ CL-31 不成立：统计表 != YAML');
    };
    const rep1 = parseReport(reportTextOf(physRoot, r.reportId));
    check(rep1);
    assert.deepEqual(rep1.sentenceNums, [4, 2, 2, 0, 2]);
    // dry-run：2 条全部跳过
    for (let i = 1; i <= 2; i += 1) putOriginal(dryRoot, { code: mkCode('20261109', 'cl31b0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const dry = runCleanup({ root: dryRoot, nowMs: now });
    check(parseReport(reportTextOf(dryRoot, dry.reportId)));
    assert.deepEqual(parseReport(reportTextOf(dryRoot, dry.reportId)).sentenceNums, [2, 0, 0, 2, 2]);
  } finally {
    fs.rmSync(physRoot, { recursive: true, force: true });
    fs.rmSync(dryRoot, { recursive: true, force: true });
  }
});

// 守：CL-32 全文无 `\d{2}:\d{2}:\d{2}(\.\d+)?Z`（+08:00 本地时间，不落 Z）。
test('CL-32 无 Z：全文（含 CSV）不含 Z 结尾时间', () => {
  const root = mkLab('cl32');
  try {
    const now = Date.now();
    for (let i = 1; i <= 3; i += 1) putOriginal(root, { code: mkCode('20261109', 'cl32a0000001', i), mtimeMs: BASE_MS + i * 1000 });
    const r = runPhysical(root, { nowMs: now });
    const text = reportTextOf(root, r.reportId);
    assert.equal(/\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(text), false, '★ CL-32 不成立：报告含 Z 结尾时间');
    assert.equal(/Z[")”]?\s*$/m.test(text.split('\n').find((l) => l.includes('复核')) || ''), false);
    // dry-run 同样无 Z
    const dry = runCleanup({ root, nowMs: now });
    const dryText = reportTextOf(root, dry.reportId);
    assert.equal(/\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(dryText), false, '★ CL-32 不成立：dry-run 报告含 Z 结尾时间');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 六、附加（Lead 要求·审计缺口）：坏 CSV 行 → 计数+报错，不静默通过
// ============================================================================

// 守：清册是删除凭据——`readCleanedCodes` 解析附录 CSV 时，坏行必须计数进 `readErrors` 并报错，
//      不得把"没解析出来"静默当成"没有"（Lead 2026-11-09 追加要求；对应 CH-20/CL-13 解析健壮性）。
test('坏 CSV 行 → 计数+报错，不静默通过（readErrors 必须非空且逐行可定位）', () => {
  const root = mkLab('badcsv');
  try {
    const c = (n) => mkCode('20261110', 'badcsv000001', n);
    const rptId = 'RPT-20261110-03';
    // 正文：1 条合法已删除
    fs.writeFileSync(path.join(root, `${rptId}.md`), [
      '| # | 编码 | 产生时间 | 结论 | 备注 |',
      '| ---: | :--- | :--- | :--- | :--- |',
      `| 1 | ${c(1)} | 2026-11-10 10:00:00 | 已删除 |  |`,
      '',
    ].join('\n'), 'utf8');
    // 附录 CSV：1 好行 + 3 坏行（坏编码 / 坏结论 / 列数不足）
    fs.writeFileSync(path.join(root, `${rptId}-明细.csv`), [
      '\uFEFF# , 编码 , 产生时间 , 结论 , 备注',
      `2,${c(2)},"2026-11-10 10:00:00","已删除","正常"`,
      '3,not-a-code,"2026-11-10 10:00:00","已删除","坏编码"',
      `4,${c(4)},"2026-11-10 10:00:00","已删","坏结论"`,
      `5,${c(5)},"2026-11-10 10:00:00"`,
      '',
    ].join('\r\n'), 'utf8');
    const map = readCleanedCodes(root);
    // 好行仍然解析成功（不是整文件丢弃）
    assert.equal(map.has(c(1)), true);
    assert.equal(map.has(c(2)), true, '★ 坏 CSV 行测试不成立：同文件的合法行也被丢弃（过严）');
    assert.equal(map.has(c(4)), false, '★ 不成立：坏结论行被当成已删除');
    // 坏行必须**计数 + 报错**，不静默
    assert.ok(Array.isArray(map.readErrors), '★ 不成立：readErrors 不是数组（解析错误被静默吞掉）');
    assert.equal(map.readErrors.length, 3, `★ 不成立：坏 CSV 行计数=${map.readErrors.length}（应 3）`);
    for (const e of map.readErrors) {
      assert.equal(e.file, `${rptId}-明细.csv`, '★ 不成立：readErrors 未标注文件名');
      assert.ok(Number.isInteger(e.line) && e.line >= 2, `★ 不成立：readErrors 未标注行号（${JSON.stringify(e)}）`);
      assert.ok(typeof e.reason === 'string' && e.reason.length > 0, '★ 不成立：readErrors 无原因');
    }
    assert.deepEqual(map.readErrors.map((e) => e.line), [3, 4, 5], '★ 不成立：坏行行号定位不对');
    // 表头坏（缺 编码/结论 列）同样必须报错
    fs.writeFileSync(path.join(root, 'RPT-20261110-04-明细.csv'), '\uFEFF序号,编码\r\n1,x\r\n', 'utf8');
    const map2 = readCleanedCodes(root);
    assert.ok(map2.readErrors.length >= 1, '★ 不成立：坏表头被静默忽略');
    assert.equal(map2.readErrors.some((e) => /表头/.test(e.reason)), true);
    // 解析端仍可被 weekly 的 compat 使用（不因 readErrors 抛错）
    assert.equal(readCleanedCodesCompat(root).has(c(2)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

