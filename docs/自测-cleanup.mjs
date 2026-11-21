/**
 * @file 自测-cleanup.mjs
 * @role 清理/清册的 v0.5 验收（P0-6 审计 A-07「清理默认真删」）：
 *       默认零删除 + dry-run 独立编号；物理删除必须显式开启；旧工具封锁；journal/终稿顺序。
 * @called-by 人工/审计：node --test docs/自测-cleanup.mjs（cwd = 插件根目录）
 * @depends ../freeze/cleanup.js（listOriginals / planCleanup / runCleanup / nextReportId /
 *          nextDryRunId / readCleanedCodes）；node:child_process（旧工具封锁检查）
 * @why v0.4 的旧实现 `runCleanup({dryRun:false})` 默认会真删；审计 A-07 实测"默认跑就删了"。
 *      本文件按"磁盘事实"守三条：①默认一个字节都不少；②dry-run 不占正式编号；
 *      ③显式开启物理删除时，删除前后必须有 journal 可查、清册一次性写出、一级/二级/台账不动。
 *
 * 写盘纪律：所有临时目录落在 `%TEMP%\clean-*`，每个用例 finally 删整棵；
 *           不跑 38MB 夹具、不读真实数据总库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  listOriginals, planCleanup, runCleanup, nextReportId, nextDryRunId, readCleanedCodes,
} = await import(pathToFileURL(path.join(SRC, 'freeze', 'cleanup.js')).href);
// V0.6.2 布局：测试侧复用实现同一份 layout 规则（清册/ = 新布局子目录，一级 = 老库兜底）。
const layout = await import(pathToFileURL(path.join(SRC, 'lib', 'layout.js')).href);
const CLEANUP_SUB = layout.SUBDIR.cleanup;
const newPath = (root, name, kind = layout.FILE_KIND.CLEANUP_REPORT) =>
  layout.newLayoutPath(root, kind, name);
/** 双路径目录序：清册/ 在前、一级在后。 */
const reportDirs = (root) => [path.join(root, CLEANUP_SUB), root];
/** 双路径（清册/ + 一级，不递归）里匹配正则的文件名。 */
const reportNames = (root, re) => reportDirs(root)
  .flatMap((d) => { try { return fs.readdirSync(d); } catch { return []; } })
  .filter((n) => re.test(n));

const QL = '“', QR = '”';
/** 第 3 级目录名：`11月总“完整原文”`。 */
const DIR_NAME = '11月总' + QL + '完整原文' + QR;
const KEY_A = 'aaaaaaaaaaaaA';
const KEY_B = 'bbbbbbbbbbbbB';
const CODE_A1 = '20261109-aaaaaaaaaaaa-A-00000001';
const CODE_A2 = '20261109-aaaaaaaaaaaa-A-00000002';
const CODE_B1 = '20261109-bbbbbbbbbbbb-B-00000001';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 建一集"数据总库"：3 份第 3 级原文（A1 带事件附件）、台账、周记账、交接表、干扰文件。
 * @returns {{root:string, od:string, files:string[]}}
 */
function makeLab() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
  const m = path.join(root, '2026年11月');
  const od = path.join(m, DIR_NAME);
  fs.mkdirSync(od, { recursive: true });
  const mdOf = (code) => path.join(od, `${code} 完整原文.md`);
  for (const code of [CODE_A1, CODE_A2, CODE_B1]) {
    fs.writeFileSync(mdOf(code), `# ${code} 完整原文\n\n## 1. user/message\n\n原话\n`, 'utf8');
  }
  // A1 带 D11 事件附件（清理时视图+附件是同一个单元）
  const attA1 = path.join(od, `${CODE_A1} 原始事件.json`);
  fs.writeFileSync(attA1, '{"type":"turn/start"}\n', 'utf8');
  // 台账 / 二级周记账 / 一级交接表：清理绝不能碰
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ledger', '2026-11-09.jsonl'), '{"code":"keep"}\n', 'utf8');
  fs.writeFileSync(path.join(m, `11月第2周-${KEY_A}的周记账.xlsx`), 'fake-xlsx', 'utf8');
  fs.writeFileSync(path.join(root, `${KEY_A}的记忆数据库的启用及交接表.md`), '# 交接表\n', 'utf8');
  // 干扰：二级目录里的 md、第 3 级里名字不合法的文件 —— 都不能被当"原文"清理
  fs.writeFileSync(path.join(m, '随便一个.md'), 'x', 'utf8');
  fs.writeFileSync(path.join(od, 'notes.md'), 'x', 'utf8');
  return { root, od, files: [mdOf(CODE_A1), mdOf(CODE_A2), mdOf(CODE_B1), attA1] };
}

/** 递归快照（相对路径 → sha256/大小），用于证明"前后一个字节都没变"。 */
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ rel: path.relative(root, p), sha256: sha256(fs.readFileSync(p)), size: fs.statSync(p).size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 本机当天（+08:00）的 YYYYMMDD（用于断言编号前缀，不依赖系统时区）。 */
function dayOf(offsetMinutes = 480) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

// ============================================================================
// 一、只读扫描（安全、无副作用）
// ============================================================================

test('listOriginals：只认第 3 级「完整原文」目录下的合法编码文件；附件单独记录', () => {
  const { root } = makeLab();
  try {
    const list = listOriginals(root);
    assert.equal(list.length, 3, '只应扫到 3 份原文；干扰 md/notes.md 不算');
    assert.equal(list.every((x) => x.month === '2026-11'), true);
    assert.deepEqual(list.map((x) => x.sessKey).sort(), [KEY_A, KEY_A, KEY_B].sort());
    const a1 = list.find((x) => x.code === CODE_A1);
    assert.equal(a1.attachmentExists, true);
    assert.match(path.basename(a1.attachmentAbs), new RegExp(`${CODE_A1} 原始事件\\.json$`));
    assert.equal(list.find((x) => x.code === CODE_A2).attachmentExists, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planCleanup：按月份/会话键/数量筛选', () => {
  const { root } = makeLab();
  try {
    const all = listOriginals(root);
    assert.equal(planCleanup({ originals: all, sessionKey: KEY_A }).length, 2);
    assert.equal(planCleanup({ originals: all, sessionKey: KEY_B }).length, 1);
    assert.equal(planCleanup({ originals: all, limit: 2 }).length, 2);
    assert.equal(planCleanup({ originals: all, month: '2026-12' }).length, 0);
    assert.deepEqual(planCleanup({ originals: null }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 二、P0-6：默认必须零删除（审计 A-07 的回归）
// ============================================================================

// 守：v0.4 默认 `runCleanup({root})` 会真删 → 审计实测 deleted=true。
//     现在默认 = dry-run：删除数 0、原文文件集合逐字节不变、不产正式 RPT、不占正式编号。
test('P0-6 默认调用：删除数=0、原文文件逐字节不变、只产 RPT-DRYRUN-*（不占正式编号）', () => {
  const { root } = makeLab();
  try {
    const before = snapshot(root);
    const beforeNextId = nextReportId(root);
    const r = runCleanup({ root });
    const after = snapshot(root);

    assert.equal(r.mode, 'dry-run');
    assert.equal(r.dryRun, true);
    assert.equal(r.deleted, 0, '★ P0-6 未修复：默认调用必须零删除');
    assert.equal(r.planned, 3);
    assert.equal(r.filesUnchanged, true);
    assert.equal(r.originalsAfter, r.originalsBefore);

    // 原文件一个不少、一个字节不变
    const deletedFiles = before.filter((x) => !after.some((y) => y.rel === x.rel));
    assert.deepEqual(deletedFiles, [], '★ 默认调用删除了文件');
    const changed = after.filter((x) => {
      const b = before.find((y) => y.rel === x.rel);
      return b && b.sha256 !== x.sha256;
    });
    assert.deepEqual(changed.map((x) => x.rel), [], '★ 默认调用改写了已有文件');

    // 只新增 dry-run 报告；正式 RPT 一个都不能有
    const added = after.filter((x) => !before.some((y) => y.rel === x.rel)).map((x) => x.rel);
    assert.equal(added.length, 1, 'dry-run 应只新增一份报告：' + JSON.stringify(added));
    // V0.6.2：写端只写 `清册/`，报告必须落在新子目录（不是一级）。
    assert.deepEqual(added, [path.join(CLEANUP_SUB, `${r.reportId}.md`)]);
    assert.match(path.basename(added[0]), /^RPT-DRYRUN-\d{8}-\d+\.md$/);
    assert.equal(r.reportId, path.basename(added[0], '.md'));
    assert.match(r.reportId, new RegExp(`^RPT-DRYRUN-${dayOf()}-\\d+$`));
    assert.deepEqual(reportNames(root, /^RPT-\d{8}-\d+\.md$/), [], '★ dry-run 不得产正式 RPT（清册/ 与一级都不许）');
    assert.equal(nextReportId(root), beforeNextId, '★ dry-run 不得占用正式编号');
    // 报告必须明确"不是清册、零删除"
    const text = fs.readFileSync(path.join(root, added[0]), 'utf8');
    assert.match(text, /试运行/);
    assert.match(text, /删除数 = 0/);
    assert.match(text, /不是清册/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：显式 dryRun:true 同样零删除，且产出独立命名的目录清单。
test('P0-6 显式 dryRun:true：零删除 + 产出 RPT-DRYRUN-*（不是正式清册）', () => {
  const { root } = makeLab();
  try {
    const before = snapshot(root);
    const r = runCleanup({ root, dryRun: true });
    const after = snapshot(root);
    assert.equal(r.deleted, 0);
    assert.equal(fs.existsSync(r.path), true);
    assert.match(r.reportId, /^RPT-DRYRUN-\d{8}-\d+$/);
    assert.equal(`${r.reportId}.md`, path.basename(r.path));
    assert.match(path.basename(r.path), /^RPT-DRYRUN-\d{8}-\d+\.md$/);
    assert.deepEqual(before.filter((x) => !after.some((y) => y.rel === x.rel)), []);
    // 连续 dry-run：dry-run 编号自增，但正式编号始终不动
    const r2 = runCleanup({ root, dryRun: true });
    assert.notEqual(r2.reportId, r.reportId);
    assert.deepEqual(reportNames(root, /^RPT-\d{8}-\d+\.md$/), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：显式 `dryRun:false` 但没有物理删除总开关 → 必须停摆（error），绝不允许"默认就删"。
//     审计脚本 P0回归 就是传 dryRun:false 且未开开关 —— 必须零删除，抛错/拒绝均算通过。
test('P0-6 显式 dryRun:false 未开总开关：抛 E_CLEANUP_DELETE_LOCKED 且零删除、零报告', () => {
  const { root } = makeLab();
  try {
    const before = snapshot(root);
    let err = null;
    try {
      runCleanup({ root, dryRun: false });
    } catch (e) { err = e; }
    assert.ok(err, '★ 未开总开关的物理删除必须停摆');
    assert.equal(err.code, 'E_CLEANUP_DELETE_LOCKED');
    const after = snapshot(root);
    assert.deepEqual(after, before, '★ 拒绝/停摆路径不得改任何文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 三、显式物理清理（唯一会删文件的路径）：journal 先写、终稿一次写、只删第 3 级
// ============================================================================

// 守：物理删除必须显式开启；删的文件 = 第 3 级 md（+ 同单元事件附件）；
//     台账 / 二级周记账 / 一级交接表 一律不动；
//     删除过程先写 journal（逐条 fsync），全部完成后一次性写终稿（禁止"先写待删再覆盖"）。
test('P0-6 显式物理清理：只删第 3 级单元；journal 有 start/plan/result/end；正式清册一次写出', () => {
  const { root } = makeLab();
  try {
    const ledgerFile = path.join(root, 'ledger', '2026-11-09.jsonl');
    const weeklyFile = path.join(root, '2026年11月', `11月第2周-${KEY_A}的周记账.xlsx`);
    const handoverFile = path.join(root, `${KEY_A}的记忆数据库的启用及交接表.md`);
    const ledgerSha = sha256(fs.readFileSync(ledgerFile));
    const weeklySha = sha256(fs.readFileSync(weeklyFile));
    const handoverSha = sha256(fs.readFileSync(handoverFile));

    const r = runCleanup({ root, sessionKey: KEY_A, limit: 1, dryRun: false, cleanupAllowPhysicalDelete: true });
    assert.equal(r.mode, 'physical');
    assert.equal(r.dryRun, false);
    assert.equal(r.planned, 1);
    assert.equal(r.deleted, 1);
    assert.match(r.reportId, new RegExp(`^RPT-${dayOf()}-\\d+$`));
    // 正式清册写出（一次性：不存在 .tmp 残留；V0.6.2 写在 清册/）
    assert.equal(fs.existsSync(r.path), true);
    assert.equal(r.path, newPath(root, `${r.reportId}.md`), '正式清册必须落在 清册/');
    assert.deepEqual(reportNames(root, /\.tmp$/), [], '终稿写入后不得留 .tmp（清册/ 与一级都不许）');
    // journal：在 ledger/ 下、逐条 JSON、阶段完整
    assert.equal(r.journalPath, path.join(root, 'ledger', `.cleanup-${r.reportId}.journal`));
    const journalLines = fs.readFileSync(r.journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // v1.3（CL-24/25）：journal 改为 plan + N×result + finalize，行数 2+planned；
    // 旧 v0.4 的 4 行 phase 断言作废（不是放宽，是口径变了）。
    assert.equal(journalLines.length, 2 + r.planned);
    assert.deepEqual(journalLines.map((x) => x.kind), ['plan', 'result', 'finalize']);
    assert.equal(journalLines[0].planned, 1);
    assert.equal(journalLines[journalLines.length - 1].checks, 'S1..S8 pass');
    assert.equal(journalLines[1].code, r.items[0].item.code);

    // 只删了选中的那一份（A1 或 A2，由 mtime 排序决定），不碰其余原文
    assert.equal(listOriginals(root).length, 2);
    const deletedCode = journalLines[1].code;
    assert.equal(fs.existsSync(path.join(root, '2026年11月', DIR_NAME, `${deletedCode} 完整原文.md`)), false);
    // 同单元的附件随视图一起删（不研究孤儿附件）
    if (deletedCode === CODE_A1) {
      assert.equal(fs.existsSync(path.join(root, '2026年11月', DIR_NAME, `${CODE_A1} 原始事件.json`)), false, '附件必须随视图一起清理');
    } else {
      assert.equal(fs.existsSync(path.join(root, '2026年11月', DIR_NAME, `${CODE_A1} 原始事件.json`)), true, '未清理项的附件不得被误删');
    }
    // 一级/二级/台账逐字节不变
    assert.equal(sha256(fs.readFileSync(ledgerFile)), ledgerSha);
    assert.equal(sha256(fs.readFileSync(weeklyFile)), weeklySha);
    assert.equal(sha256(fs.readFileSync(handoverFile)), handoverSha);

    // 清册可被 readCleanedCodes 读回（"已清理"四态依赖它）
    const cleaned = readCleanedCodes(root);
    assert.equal(cleaned.get(deletedCode), r.reportId);
    const reportText = fs.readFileSync(r.path, 'utf8');
    assert.match(reportText, /\| 已删除 \|/);
    // v1.3（CL-14/口径 10）：终稿不再写"一次性写出"自述（v1.3 模板正文无此句），
    // 该处改为断言 v1.3 复核行逐字格式——期待值随契约更新，安全断言一条未动。
    assert.match(reportText, /^> 复核：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+08:00）按台账 jsonl 重扫，剩余 \d+ 条，与上表一致。$/m);
    assert.equal(r.originalsAfter, r.originalsBefore - 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：D15 编号 `\d+`：99 → 100 → 101 不回绕；dry-run 独立编号且不占正式号。
test('D15 编号：99→100→101 不回绕；dry-run 用 RPT-DRYRUN-* 且不占正式号', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-id-'));
  try {
    const day = dayOf();
    assert.match(nextReportId(root), new RegExp(`^RPT-${day}-01$`));
    fs.writeFileSync(path.join(root, `RPT-${day}-99.md`), '# 99\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-100`);
    fs.writeFileSync(path.join(root, `RPT-${day}-100.md`), '# 100\n', 'utf8');
    assert.equal(nextReportId(root), `RPT-${day}-101`, '99/100/101 不得回绕');
    // dry-run 独立序列
    assert.equal(nextDryRunId(root), `RPT-DRYRUN-${day}-01`);
    fs.writeFileSync(path.join(root, `RPT-DRYRUN-${day}-01.md`), '# dry\n', 'utf8');
    assert.equal(nextDryRunId(root), `RPT-DRYRUN-${day}-02`);
    // dry-run 文件不占正式编号、也不被当清册
    assert.equal(nextReportId(root), `RPT-${day}-101`);
    assert.equal(readCleanedCodes(root).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 四、清册解析口径（P1-10：只认结论列，不看任意单元格）
// ============================================================================

// 守：审计 A-06/P1-10——v0.4 的"任意单元格含已删除"会把备注里的"已删除"误判成已清理，
//     从而把非法丢失洗成合法清理。必须按表头定位「结论」（v1.3）或「结果」（v0.4）列。
test('P1-10 清册只认结论列：备注写「已删除」不得误判；v1.3 / v0.4 两种表头都认', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-rpt-'));
  try {
    const day = dayOf();
    fs.writeFileSync(path.join(root, `RPT-${day}-01.md`), [
      '# 清册（v1.3 新表头）', '',
      '| # | 编码 | 产生时间（UTC+08:00） | 结论 | 备注 |',
      '|---|---|---|---|---|',
      `| 1 | \`${CODE_A1}\` | 2026-11-09 10:00:00 | 未删除 | 已删除（这里只是备注） |`,
      `| 2 | \`${CODE_A2}\` | 2026-11-09 10:01:00 | 已删除 |  |`,
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, `RPT-${day}-02.md`), [
      '# 清册（v0.4 旧表头）', '',
      '| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |',
      '|---|---|---|---:|---|---|',
      `| \`${CODE_B1}\` | ${KEY_B} | 2026-11 | 1.0 KB | 已删除 |  |`,
      '',
    ].join('\n'), 'utf8');
    const m = readCleanedCodes(root);
    assert.equal(m.has(CODE_A1), false, '★ 结论=未删除 的行不得因备注含"已删除"被误判');
    assert.equal(m.get(CODE_A2), `RPT-${day}-01`);
    assert.equal(m.get(CODE_B1), `RPT-${day}-02`);
    assert.equal(m.size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 守：INV-27——dry-run 只能用独立前缀，不得占正式编号；空库首次正式清理必须是当日 01。
test('INV-27 dry-run 不占正式号：空库 dry-run 后首次正式清理编号 == 当日 01', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-inv27-'));
  try {
    const day = dayOf();
    const dry = runCleanup({ root }); // 空库 dry-run
    assert.equal(dry.deleted, 0);
    assert.equal(dry.reportId, `RPT-DRYRUN-${day}-01`);
    // dry-run 后目录里不得有正式 RPT
    assert.deepEqual(reportNames(root, /^RPT-\d{8}-\d+\.md$/), []);
    // 首次正式清理（空库也允许显式执行）→ 编号必须是当日 01
    const real = runCleanup({ root, dryRun: false, cleanupAllowPhysicalDelete: true });
    assert.equal(real.mode, 'physical');
    assert.equal(real.reportId, `RPT-${day}-01`, 'dry-run 不得占用正式编号');
    assert.equal(fs.existsSync(newPath(root, `RPT-${day}-01.md`)), true, '正式清册在 清册/');
    assert.equal(real.deleted, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 五、旧工具封锁（v0.4 工具默认会真删 → 必须 BLOCKED、exit≠0、零删除）
// ============================================================================

// 守：`docs/工具-v03-清理.mjs` 在 v0.5 必须硬封锁：任何调用都不允许删除文件、不写报告。
test('P0-6 旧工具封锁：docs/工具-v03-清理.mjs 必须 BLOCKED（exit≠0）且零删除', () => {
  const { root, files } = makeLab();
  try {
    const before = snapshot(root);
    const res = spawnSync(process.execPath, [path.join(SRC, 'docs', '工具-v03-清理.mjs'), root], {
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.notEqual(res.status, 0, '旧清理工具必须 exit≠0（BLOCKED）');
    assert.equal(res.status, 2, 'BLOCKED 退出码应为 2');
    assert.match(String(res.stderr || ''), /BLOCKED/);
    const after = snapshot(root);
    assert.deepEqual(after, before, '★ 旧工具被调用时不得删除/新增任何文件');
    for (const f of files) assert.equal(fs.existsSync(f), true, '旧工具不得删文件：' + f);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 六、V0.6.2 布局（机主已签《v0.6.2-迁移规格-v1》§2.2）：写端只写 清册/，读端双路径
// ============================================================================

test('V0.6.2 布局：清册写 清册/；读端双路径（新目录优先、一级老位置兜底）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-layout-'));
  try {
    const day = dayOf();
    const v13 = (code, verdict) => [
      '# 清册（v1.3）', '',
      '| # | 编码 | 产生时间（UTC+08:00） | 结论 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      `| 1 | ${code} | 2026-11-09 10:00:00 | ${verdict} |  |`,
      '',
    ].join('\n');

    // ① 老库：清册在一级（未迁移）→ 读得到（不要求先迁移）。
    fs.writeFileSync(path.join(root, `RPT-${day}-01.md`), v13(CODE_A1, '已删除'), 'utf8');
    assert.equal(readCleanedCodes(root).get(CODE_A1), `RPT-${day}-01`, '老库一级清册必须可读');

    // ② 同名文件在新目录 → 新目录优先（一级那份不参与，不能读回互相矛盾的两份）。
    fs.mkdirSync(path.join(root, CLEANUP_SUB), { recursive: true });
    fs.writeFileSync(newPath(root, `RPT-${day}-01.md`), v13(CODE_A1, '未删除'), 'utf8');
    assert.equal(readCleanedCodes(root).has(CODE_A1), false, '同名以 清册/ 为准（新目录优先）');

    // ③ 老库另有不同编号清册 → 仍兜底可读；编号扫描双路径合并（不撞号）。
    fs.writeFileSync(path.join(root, `RPT-${day}-02.md`), v13(CODE_A2, '已删除'), 'utf8');
    assert.equal(readCleanedCodes(root).get(CODE_A2), `RPT-${day}-02`, '一级老位置兜底可读');
    assert.equal(nextReportId(root), `RPT-${day}-03`, '编号扫描双路径合并（老库号不得复用）');

    // ④ 写端：物理清理（空库也允许）→ 新清册只写 清册/，一级旧文件一个字节都不动。
    const r = runCleanup({ root, dryRun: false, cleanupAllowPhysicalDelete: true });
    assert.equal(r.reportId, `RPT-${day}-03`);
    assert.equal(r.path, newPath(root, `RPT-${day}-03.md`), '新清册必须落在 清册/');
    assert.equal(fs.existsSync(path.join(root, `RPT-${day}-03.md`)), false, '写端不得写一级');
    assert.equal(fs.readFileSync(path.join(root, `RPT-${day}-01.md`), 'utf8'), v13(CODE_A1, '已删除'), '一级旧清册不得被改写');
    assert.equal(fs.readFileSync(path.join(root, `RPT-${day}-02.md`), 'utf8'), v13(CODE_A2, '已删除'), '一级旧清册不得被改写');
    // ⑤ 读回：新写的正式清册（清册/）与老清册（一级）都可被解析。
    assert.equal(readCleanedCodes(root).get(CODE_A2), `RPT-${day}-02`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
