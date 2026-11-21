/**
 * @file 自测-v062.mjs
 * @role **V0.6.2 B 项验收**：按《v0.6.2-迁移规格-v1》§四 M-01…M-07 守
 *       「账库根标记 / 一级目录迁移 / 账簿总目录 / 越界保护」四件交付。
 *
 * 判据（M-01…M-07）：
 *   M-01 dry-run **零写盘**：整库文件集合与逐文件 sha256 全不变；
 *   M-02 `--write` **只 rename**：迁前迁后每个文件 sha256 不变，内容哈希集合不增不减；
 *   M-03 老布局**读兼容**：不迁移也能用 `layout.resolveExisting` 读到交接表/清册/体检；
 *   M-04 `--rollback` 后目录树与迁移前逐文件 sha256 一致（journal 改 .done）；
 *   M-05 冲突（目标已存在）/未知一级文件：不搬、报错、退出码 2（dry-run 仍零写）；
 *   M-06 `.ledger-root` 越界保护：指向账库父目录 → `E_LEDGER_ROOT_PROTECTED`、零动作；
 *   M-07 迁移后《账簿总目录.md》的数字（月份/分类/台账/闸门）与目录实况一致。
 *
 * 另加几条底座自测（T-01…T-04）：根标记幂等与内容合规、总目录采集只读且无报告不伪装 ok、
 * `--write` 幂等（再跑 0 搬运、不重复 journal）、`--rollback` 可只给 journal 自动推根 +
 * 显式 `--root` 时的串库防护。
 *
 * 用法：node docs/跑测试.mjs docs/自测-v062.mjs
 *
 * 写盘纪律：**所有**账库都建在 `os.tmpdir()` + `mkdtempSync` 的临时根里，用后即删；
 * 不碰真实账库、不碰 Desktop、不碰 U 盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as LAYOUT from '../lib/layout.js';
import {
  E_LEDGER_ROOT_PROTECTED,
  assertNoLedgerRootUnder,
  defaultRootDir,
  ensureRootMarker,
  findLedgerRootsUnder,
  readRootMarker,
} from '../lib/ledgerroot.js';
import {
  catalogCounts,
  catalogPath,
  collectCatalogData,
  renderCatalog,
  writeCatalog,
} from '../lib/catalog.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(SRC, 'docs', '工具-迁移布局.mjs');

/** 机器时间固定 +08:00（契约口径）。 */
const OFFSET = 480;

/** 固定基准时刻：2026-11-10 12:00:00 +08:00（让标记时间可精确断言）。 */
const T0 = Date.UTC(2026, 10, 10, 4, 0, 0);

/** 固定 rootId（让"补写不换身份"可精确断言）。 */
const ROOT_ID = '11111111-2222-3333-4444-555555555555';

const SID = 'aaaaaaaaaaaa';

/** 6 份一级散落单据（迁移对象）。 */
const FIX = {
  handoverMain: `${SID}A的记忆数据库的启用及交接表.md`,
  handoverAppendix: `${SID}B的记忆数据库的启用及交接表——附表.md`,
  cleanupReport: 'RPT-20261001-01.md',
  cleanupAppendix: 'RPT-20261001-01-明细.csv',
  cleanupDryrun: 'RPT-DRYRUN-20261001-01.md',
  checkup: 'CHK-20261002-01.md',
};
const SIX_NAMES = Object.values(FIX);

/** 每份单据的唯一内容（用于"只 rename 不改字节"与"冲突不覆盖"断言）。 */
const CONTENT = {
  [FIX.handoverMain]: '# 交接表主表\n内容：handover-main-唯一\n',
  [FIX.handoverAppendix]: '# 交接表附表\n内容：handover-appendix-唯一\n',
  [FIX.cleanupReport]: '# 清册报告\n内容：cleanup-report-唯一\n',
  [FIX.cleanupAppendix]: '编号,说明\nRPT-1,cleanup-appendix-唯一\n',
  [FIX.cleanupDryrun]: '# 清册 dry-run\n内容：cleanup-dryrun-唯一\n',
  [FIX.checkup]: '# 体检报告\n内容：checkup-唯一\n',
};

/** 原文编码（规范格式：8 位日期-12 位小写-A-8 位日期）。 */
const ORIG_A = '20261001-abcdefghijkl-A-20261001';
const ORIG_B = '20260901-mnopqrstuvwx-B-20260901';

/** 冲突测试里"目标已存在"的那份体检报告内容。 */
const CONFLICT_CONTENT = '# 已存在的体检报告（不得被覆盖）\n';

// ============================================================================
// 一、公共小工具
// ============================================================================

/** 文件 sha256（hex）。 */
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 写文本（自动建父目录）。 */
function writeText(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

/** 递归收集 `<dir>/**` 的相对路径（`/` 归一）→ sha256。 */
function fileMap(dir) {
  const map = new Map();
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) walk(abs, childRel);
      else if (e.isFile()) map.set(childRel, sha256File(abs));
    }
  };
  walk(dir, '');
  return map;
}

/** Map → 稳定排序的 [rel, sha] 数组（便于 deepEqual）。 */
function sortedEntries(map) {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 值出现次数（内容哈希多重集比对用）。 */
function countByValue(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

/** 相对路径（`/` 归一）。 */
function toRel(root, abs) {
  return path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join('/');
}

/** journal / journal.done 是运行区证据（不参与"目录树回退一致"断言）。 */
function isMigrationEvidence(rel) {
  return /^ledger\/\.layout-migration-.*\.journal(\.done(-\d+)?)?$/.test(rel);
}

/** 去掉派生/证据文件（总目录是 v0.6.2 新增的导航文件，回退不删除）。 */
function stripDerived(map) {
  return new Map([...map].filter(([rel]) => rel !== LAYOUT.CATALOG_NAME && !isMigrationEvidence(rel)));
}

/** 在临时目录里造一个空账库根（`.../会话账本`）。 */
function mkBase(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `v062-${label}-`));
  return { base, root: path.join(base, '会话账本') };
}

/** 跑迁移工具（子进程；验证真实退出码与 stdout JSON）。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: SRC,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env },
  });
  if (r.error) throw r.error;
  return { status: r.status, signal: r.signal, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** 解析 `--json` 输出（宽容：允许 stdout 前有杂行）。 */
function parseJsonOut(r) {
  const txt = String(r.stdout || '').trim();
  try { return JSON.parse(txt); } catch { /* 继续找首个 { */ }
  const at = txt.indexOf('{');
  if (at < 0) return null;
  try { return JSON.parse(txt.slice(at)); } catch { return null; }
}

/** 造台账运行区：2 行台账 + 一份 gate=ok 的运行报告。 */
function seedLedgerArea(root) {
  writeText(
    path.join(root, 'ledger', '2026-10-01.jsonl'),
    JSON.stringify({ v: 3, code: ORIG_A, sid: SID, turn: 1, seq: 1, status: 'ok' }) + '\n',
  );
  writeText(
    path.join(root, 'ledger', '2026-10-02.jsonl'),
    JSON.stringify({ v: 3, code: ORIG_B, sid: SID, turn: 2, seq: 2, status: 'ok' }) + '\n',
  );
  writeText(
    path.join(root, 'ledger', '.run-report-20261110.json'),
    JSON.stringify({
      v: 1,
      date: '2026-11-10',
      generatedAt: '2026-11-10 12:00:00 +08:00',
      gate: { conclusion: 'ok', reason: '', knownGaps: [], canEnumerate: true, unchecked: [] },
      counts: { ledgerRows: 2 },
    }, null, 2) + '\n',
  );
}

/** 造一个"v0.6.1 老布局"账库：月份目录 + 一级散落 6 份单据 + 台账 + 标记。 */
function seedOldLibrary(root, opts = {}) {
  const marker = opts.marker !== false;
  fs.mkdirSync(root, { recursive: true });

  // 月份目录 1：2026年10月 —— 1 份原文（另带 .v2 历史版本，不应重复计份）+ 1 份周账
  writeText(
    path.join(root, '2026年10月', '10月总“完整原文”', `${ORIG_A} 完整原文.md`),
    '# 完整原文 A v1\n内容：原文甲\n',
  );
  writeText(
    path.join(root, '2026年10月', '10月总“完整原文”', `${ORIG_A}.v2 完整原文.md`),
    '# 完整原文 A v2\n内容：原文甲（换版本）\n',
  );
  writeText(path.join(root, '2026年10月', '10月第1周-aaaaaaaaaaaa的周记账.xlsx'), 'fake-xlsx-bytes-周账');

  // 月份目录 2：2026年09月 —— 1 份原文
  writeText(
    path.join(root, '2026年09月', '09月总“完整原文”', `${ORIG_B} 完整原文.md`),
    '# 完整原文 B v1\n内容：原文乙\n',
  );

  // 一级散落单据（6 份；迁移对象）
  for (const name of SIX_NAMES) writeText(path.join(root, name), CONTENT[name]);

  seedLedgerArea(root);

  if (marker) {
    const m = ensureRootMarker(root, { nowMs: T0, rootId: ROOT_ID });
    if (!m.ok) throw new Error('造夹具失败：' + m.reason + ' ' + (m.detail || ''));
  }
}

// ============================================================================
// 二、M-01 dry-run 零写盘
// ============================================================================

test('M-01 dry-run 零写盘：整库文件集合与逐文件 sha256 全不变', () => {
  const { base, root } = mkBase('m01');
  try {
    seedOldLibrary(root);
    const before = fileMap(root);
    const r = runCli([`--root=${root}`, '--json']);
    assert.equal(r.status, 0, 'dry-run 应退出 0（stderr=' + r.stderr + '）');
    const out = parseJsonOut(r);
    assert.ok(out, 'dry-run --json 必须输出可解析 JSON：' + r.stdout.slice(0, 300));
    assert.equal(out.mode, 'dry-run');
    assert.equal(out.exitCode, 0);
    assert.equal(out.moves.length, 6, '6 份一级散落单据都应进入计划');
    assert.equal(out.conflicts.length, 0);
    assert.equal(out.unknown.length, 0);
    for (const m of out.moves) {
      assert.match(m.sha256, /^[0-9a-f]{64}$/, '计划里必须有可复算的 sha256');
      assert.equal(m.bytes, Buffer.byteLength(CONTENT[m.name], 'utf8'), '计划里字节数必须与实况一致');
    }
    // ★ 零写盘：文件集合 + 每个文件字节都不变
    assert.deepEqual(sortedEntries(fileMap(root)), sortedEntries(before), '★ dry-run 不得新增/删除/改动任何文件');
    // ★ 零写盘：不建分类子目录、不取锁、不写 journal、不写总目录
    for (const sub of Object.values(LAYOUT.SUBDIR)) {
      assert.equal(fs.existsSync(path.join(root, sub)), false, 'dry-run 不得创建分类子目录：' + sub);
    }
    assert.equal(fs.existsSync(path.join(root, 'ledger', '.lock')), false, 'dry-run 不得取锁（.lock 是写）');
    assert.equal(fs.existsSync(catalogPath(root)), false, 'dry-run 不得写总目录');
    assert.equal(
      fs.readdirSync(path.join(root, 'ledger')).some((n) => n.startsWith('.layout-migration-')),
      false,
      'dry-run 不得写 journal',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 三、M-02 --write 只 rename
// ============================================================================

test('M-02 --write 只 rename：迁移前后逐文件 sha256 不变、内容哈希集合不增不减', () => {
  const { base, root } = mkBase('m02');
  try {
    seedOldLibrary(root);
    const before = fileMap(root);
    const r = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(r.status, 0, '--write 应退出 0（stderr=' + r.stderr + '）');
    const out = parseJsonOut(r);
    assert.ok(out, '--write --json 必须输出可解析 JSON：' + r.stdout.slice(0, 300));
    assert.equal(out.mode, 'write');
    assert.equal(out.exitCode, 0);
    assert.equal(out.moved.length, 6);
    assert.equal(out.failures.length, 0);
    assert.equal(out.countsEqual, true, '迁移前后月份/分类计数必须一致');
    assert.ok(out.catalog && out.catalog.ok === true, '--write 后必须刷新总目录');
    assert.equal(out.catalog.path, catalogPath(root));
    assert.match(out.journal.path, /\.layout-migration-\d{8}-\d{6}(-\d+)?\.journal$/, 'journal 文件名口径');
    assert.equal(fs.existsSync(out.journal.path), true, 'journal 必须落盘');

    const after = fileMap(root);
    for (const m of out.moved) {
      const oldRel = toRel(root, m.old);
      const newRel = toRel(root, m.new);
      // 目标必须是 layout 规则给的新位置
      assert.equal(path.dirname(m.new), path.join(root, LAYOUT.KIND_SUBDIR[m.kind]), '目标子目录必须由 layout 规则决定：' + m.name);
      // ★ 计划 sha256 == 迁前 sha256 == 迁后 sha256（逐字节不变）
      assert.equal(before.get(oldRel), m.sha256, '计划 sha256 必须等于迁前');
      assert.equal(after.get(newRel), m.sha256, '★ 迁移后字节必须与迁移前逐字节相同：' + newRel);
      assert.equal(after.has(oldRel), false, '老位置必须已清空：' + oldRel);
      assert.equal(fs.readFileSync(m.new, 'utf8'), CONTENT[m.name], '内容必须逐字不变');
    }

    // ★ 内容哈希多重集：迁前的每个哈希出现次数不变（= 没有任何文件被改写）
    const beforeCount = countByValue([...before.values()]);
    const afterCount = countByValue([...after.values()]);
    for (const [hash, n] of beforeCount) {
      assert.equal(afterCount.get(hash) || 0, n, '内容哈希出现次数变了（有文件被改写？）：' + hash);
    }
    // 新增文件只允许 总目录 + journal（`.ledger-root` 原本就有）
    assert.equal(after.size, before.size + 2, '只应新增《账簿总目录.md》与 journal 两个文件');

    // 迁移后布局检测应为"新布局"（一级无旧单据、分类目录已建）
    assert.equal(LAYOUT.detectLayout(root).layoutVersion, 2);
    // marker 布局版本应升到 2（本来就是 2 → 不产生 update 也无妨）
    const marker = readRootMarker(root);
    assert.equal(marker.found, true);
    assert.equal(marker.marker.layoutVersion, 2);
    assert.equal(marker.marker.rootId, ROOT_ID, '迁移不得换 rootId');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 四、M-03 老布局读兼容
// ============================================================================

test('M-03 老布局读兼容：不迁移也能用 layout.resolveExisting 读到三类单据', () => {
  const { base, root } = mkBase('m03');
  try {
    seedOldLibrary(root);
    const checks = [
      [FIX.handoverMain, LAYOUT.FILE_KIND.HANDOVER_MAIN],
      [FIX.handoverAppendix, LAYOUT.FILE_KIND.HANDOVER_APPENDIX],
      [FIX.cleanupReport, LAYOUT.FILE_KIND.CLEANUP_REPORT],
      [FIX.cleanupAppendix, LAYOUT.FILE_KIND.CLEANUP_APPENDIX],
      [FIX.cleanupDryrun, LAYOUT.FILE_KIND.CLEANUP_DRYRUN],
      [FIX.checkup, LAYOUT.FILE_KIND.CHECKUP_REPORT],
    ];
    // 迁移前：新子目录还不存在，但读端必须能在一级老位置读到
    for (const sub of Object.values(LAYOUT.SUBDIR)) {
      assert.equal(fs.existsSync(path.join(root, sub)), false, '夹具应处于老布局（无分类子目录）');
    }
    for (const [name, kind] of checks) {
      assert.equal(LAYOUT.classifyFileName(name), kind);
      assert.deepEqual(LAYOUT.pathCandidates(root, kind, name), [
        path.join(root, LAYOUT.KIND_SUBDIR[kind], name),
        path.join(root, name),
      ]);
      const p = LAYOUT.resolveExisting(root, kind, name);
      assert.equal(p, path.join(root, name), '老布局：resolveExisting 应回退到一级老位置：' + name);
      assert.equal(fs.readFileSync(p, 'utf8'), CONTENT[name], '读到的内容必须完整');
    }
    // 认不出的文件 → ''（读端必须能表达"没有"）
    assert.equal(LAYOUT.resolveExisting(root, LAYOUT.FILE_KIND.HANDOVER_MAIN, '000000000000Z的记忆数据库的启用及交接表.md'), '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 五、M-04 --rollback 还原
// ============================================================================

test('M-04 --rollback 后目录树与迁移前逐文件 sha256 一致（journal 改 .done）', () => {
  const { base, root } = mkBase('m04');
  try {
    seedOldLibrary(root);
    const before = fileMap(root);
    const w = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(w.status, 0, '--write 应退出 0（stderr=' + w.stderr + '）');
    const wOut = parseJsonOut(w);
    assert.equal(wOut.moved.length, 6);
    // 迁移后确实到了新位置
    assert.equal(fs.existsSync(path.join(root, LAYOUT.SUBDIR.handover, FIX.handoverMain)), true);

    const r = runCli([`--root=${root}`, `--rollback=${wOut.journal.path}`, '--json']);
    assert.equal(r.status, 0, '--rollback 应退出 0（stderr=' + r.stderr + '）');
    const out = parseJsonOut(r);
    assert.ok(out, '--rollback --json 必须输出可解析 JSON：' + r.stdout.slice(0, 300));
    assert.equal(out.mode, 'rollback');
    assert.equal(out.exitCode, 0);
    assert.equal(out.restored.length, 6, '6 份都应还原');
    assert.equal(out.failures.length, 0);
    assert.equal(out.journalDone, `${wOut.journal.path}.done`);
    assert.equal(fs.existsSync(wOut.journal.path), false, 'journal 应改名 .done');
    assert.equal(fs.existsSync(out.journalDone), true, 'journal.done 证据必须保留');

    // ★ 回退后目录树（文件 + 逐文件 sha256）必须与迁移前一致
    //   排除：账簿总目录.md（回退后刷新的派生导航）、journal(.done)（运行区证据）
    const after = fileMap(root);
    assert.deepEqual(
      sortedEntries(stripDerived(after)),
      sortedEntries(stripDerived(before)),
      '★ 回退后目录树与迁移前不一致',
    );
    // 一级散落单据全部回到原位、内容逐字不变
    for (const name of SIX_NAMES) {
      assert.equal(fs.existsSync(path.join(root, name)), true, '应回到一级：' + name);
      assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), CONTENT[name]);
    }
    // 因迁移而建的空分类子目录应被清理（非空目录不得动）
    for (const sub of Object.values(LAYOUT.SUBDIR)) {
      assert.equal(fs.existsSync(path.join(root, sub)), false, '空分类子目录应清掉：' + sub);
    }
    // 总目录仍存在（回退后刷新，导航与实际一致）
    assert.equal(fs.existsSync(catalogPath(root)), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 六、M-05 冲突 / 未知不搬 + 退出码 2
// ============================================================================

test('M-05 冲突/未知：不搬、退出码 2，dry-run 仍零写盘', () => {
  const { base, root } = mkBase('m05');
  try {
    seedOldLibrary(root);
    // ① 目标已存在：体检/ 里先放一份"别人的"同名报告，迁移绝不覆盖
    const conflictAbs = path.join(root, LAYOUT.SUBDIR.checkup, FIX.checkup);
    writeText(conflictAbs, CONFLICT_CONTENT);
    // ② 未知一级文件：认不出是哪种单据 → 不猜、不搬
    writeText(path.join(root, '随手记-未分类.txt'), '这不是任何单据\n');

    const before = fileMap(root);
    // ── dry-run：退出码 2，但依然零写盘 ──
    const dry = runCli([`--root=${root}`, '--json']);
    assert.equal(dry.status, 2, '冲突/未知时 dry-run 必须退出码 2（stderr=' + dry.stderr + '）');
    const dOut = parseJsonOut(dry);
    assert.equal(dOut.mode, 'dry-run');
    assert.equal(dOut.exitCode, 2);
    assert.equal(dOut.moves.length, 5, '6 份里 1 份目标已存在 → 只计划搬 5 份');
    assert.equal(dOut.conflicts.length, 1);
    assert.equal(dOut.conflicts[0].reason, 'TARGET_EXISTS');
    assert.equal(dOut.conflicts[0].name, FIX.checkup);
    assert.equal(dOut.unknown.length, 1);
    assert.equal(dOut.unknown[0].name, '随手记-未分类.txt');
    assert.deepEqual(sortedEntries(fileMap(root)), sortedEntries(before), '★ dry-run 有冲突也必须零写盘');

    // ── --write：退出码 2；冲突/未知原地不动，其余 5 份照常搬（"该条不搬"） ──
    const w = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(w.status, 2, '存在冲突/未知时 --write 必须退出码 2（stderr=' + w.stderr + '）');
    const out = parseJsonOut(w);
    assert.equal(out.mode, 'write');
    assert.equal(out.exitCode, 2);
    assert.equal(out.moved.length, 5, '可搬的 5 份必须搬走');
    assert.equal(out.conflicts.length, 1);
    assert.equal(out.unknown.length, 1);

    // 冲突：目标未被覆盖；源单据留在原地
    assert.equal(fs.readFileSync(conflictAbs, 'utf8'), CONFLICT_CONTENT, '★ 目标已存在时绝不覆盖');
    assert.equal(fs.existsSync(path.join(root, FIX.checkup)), true, '冲突单据必须留在原地');
    assert.equal(fs.readFileSync(path.join(root, FIX.checkup), 'utf8'), CONTENT[FIX.checkup]);
    // 未知：原样不动（连内容都不碰）
    assert.equal(fs.readFileSync(path.join(root, '随手记-未分类.txt'), 'utf8'), '这不是任何单据\n', '未知文件不得被搬/改');
    // 其余 5 份到位且逐字不变
    for (const name of [FIX.handoverMain, FIX.handoverAppendix, FIX.cleanupReport, FIX.cleanupAppendix, FIX.cleanupDryrun]) {
      const kind = LAYOUT.classifyFileName(name);
      const dest = path.join(root, LAYOUT.KIND_SUBDIR[kind], name);
      assert.equal(fs.existsSync(dest), true, '应已迁移：' + name);
      assert.equal(fs.readFileSync(dest, 'utf8'), CONTENT[name]);
      assert.equal(fs.existsSync(path.join(root, name)), false, '老位置应清空：' + name);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 七、M-06 .ledger-root 越界保护
// ============================================================================

test('M-06 .ledger-root 越界保护：E_LEDGER_ROOT_PROTECTED + 零动作', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v062-m06-'));
  try {
    const desktop = path.join(base, '桌面');
    fs.mkdirSync(desktop, { recursive: true });
    const root = path.join(desktop, '会话账本');
    fs.mkdirSync(root, { recursive: true });
    ensureRootMarker(root, { nowMs: T0, rootId: ROOT_ID });
    writeText(path.join(root, 'ledger', '2026-11-10.jsonl'), '{"v":3,"sid":"aaaaaaaaaaaa","turn":1}\n');

    // ① 指向账库父目录 → 抛 E_LEDGER_ROOT_PROTECTED，且**零动作**
    const before = fileMap(base);
    let err = null;
    try {
      assertNoLedgerRootUnder(desktop);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '★ 指向账库父目录必须抛错（不是跳过/警告）');
    assert.equal(err.code, E_LEDGER_ROOT_PROTECTED);
    assert.equal(E_LEDGER_ROOT_PROTECTED, 'E_LEDGER_ROOT_PROTECTED');
    assert.equal(Array.isArray(err.roots), true);
    assert.equal(err.roots.includes(path.resolve(root)), true, '错误里必须点名越界的账库根');
    assert.deepEqual(sortedEntries(fileMap(base)), sortedEntries(before), '★ 越界检查必须零动作');

    // ② 边界：target 自身就是账库根 → 不算越界（那是账库自己）
    const self = assertNoLedgerRootUnder(root);
    assert.equal(self.protected, false);
    assert.equal(self.isLedgerRoot, true);
    assert.equal(self.rootId, ROOT_ID);
    assert.deepEqual(self.roots, []);

    // ③ 深层：桌面/a/b/会话账本（默认 maxDepth=3 必须能找到）
    const deep = path.join(desktop, 'a', 'b', '会话账本');
    fs.mkdirSync(deep, { recursive: true });
    ensureRootMarker(deep, { nowMs: T0 });
    err = null;
    try {
      assertNoLedgerRootUnder(desktop);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '深层账库根也必须被发现');
    assert.equal(err.code, E_LEDGER_ROOT_PROTECTED);
    assert.equal(err.roots.includes(path.resolve(deep)), true);

    // ④ 根发现：跳过 `ledger/` 运行区与隐藏目录
    const decoyLedger = path.join(desktop, 'ledger', '假账本');
    ensureRootMarker(decoyLedger, { nowMs: T0 });
    const decoyHidden = path.join(desktop, '.隐藏', '假账本');
    ensureRootMarker(decoyHidden, { nowMs: T0 });
    const found = findLedgerRootsUnder(desktop);
    assert.equal(found.ok, true);
    assert.equal(found.truncated, false);
    const roots = found.roots.map((x) => x.root);
    assert.equal(roots.includes(path.resolve(root)), true);
    assert.equal(roots.includes(path.resolve(deep)), true);
    assert.equal(roots.includes(path.resolve(decoyLedger)), false, '`ledger/` 运行区必须跳过');
    assert.equal(roots.includes(path.resolve(decoyHidden)), false, '隐藏目录必须跳过');
    assert.equal(found.scannedDirs > 0, true);

    // ⑤ 不存在的目标 = 没有越界（不抛、零动作）
    const none = assertNoLedgerRootUnder(path.join(base, '不存在的目录'));
    assert.equal(none.protected, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 八、M-07 总目录数字与实况一致
// ============================================================================

test('M-07 迁移后《账簿总目录.md》数字与目录实况一致', () => {
  const { base, root } = mkBase('m07');
  try {
    seedOldLibrary(root);

    // ── 迁移前：采集（只读）就应数对 ──
    const beforeData = collectCatalogData(root, { nowMs: T0, offsetMinutes: OFFSET });
    assert.equal(beforeData.categories.handover.total, 2);
    assert.equal(beforeData.categories.cleanup.total, 3);
    assert.equal(beforeData.categories.checkup.total, 1);
    assert.equal(beforeData.categories.handover.oldRoot, 2, '迁移前应全部在一级老位置');
    assert.equal(beforeData.categories.handover.newDir, 0);
    assert.equal(beforeData.months.length, 2);
    const oct = beforeData.months.find((m) => m.name === '2026年10月');
    assert.ok(oct, '必须有 2026年10月');
    assert.equal(oct.originalCount, 1, '原文按编码去重：.v2 历史版本不得重复计份');
    assert.equal(oct.weeklyCount, 1);
    assert.equal(beforeData.status.ledgerRows, 2);
    assert.equal(beforeData.status.gate.conclusion, 'ok');
    assert.equal(beforeData.rootId, ROOT_ID);
    // 已写根标记 + 一级仍有旧单据 = **混合布局 3（待迁移）**：
    // 不能报 1（那是"旧库未认领"），也不能报 2（还有 6 份单据散在一级）。
    assert.equal(beforeData.layout.version, 3);
    // collectCatalogData 必须只读
    const seeded = fileMap(root);
    collectCatalogData(root, { nowMs: T0, offsetMinutes: OFFSET });
    assert.deepEqual(sortedEntries(fileMap(root)), sortedEntries(seeded), '采集总目录数据必须零写');

    // ── 迁移 ──
    const w = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(w.status, 0, '--write 应退出 0（stderr=' + w.stderr + '）');
    const wOut = parseJsonOut(w);
    assert.equal(wOut.moved.length, 6);

    // ── 迁移后：数据 == 目录实况（独立枚举，不用 catalog 的实现） ──
    const data = collectCatalogData(root, { nowMs: T0, offsetMinutes: OFFSET });
    const countDirFiles = (sub) => fs.readdirSync(path.join(root, sub)).filter((n) => !n.startsWith('.')).length;
    assert.equal(countDirFiles(LAYOUT.SUBDIR.handover), 2, '交接表/ 实况份数');
    assert.equal(countDirFiles(LAYOUT.SUBDIR.cleanup), 3, '清册/ 实况份数');
    assert.equal(countDirFiles(LAYOUT.SUBDIR.checkup), 1, '体检/ 实况份数');
    for (const name of SIX_NAMES) {
      assert.equal(fs.existsSync(path.join(root, name)), false, '迁移后一级不应再有散落单据：' + name);
    }
    assert.equal(data.categories.handover.total, 2);
    assert.equal(data.categories.handover.newDir, 2);
    assert.equal(data.categories.handover.oldRoot, 0);
    assert.equal(data.categories.cleanup.total, 3);
    assert.equal(data.categories.checkup.total, 1);
    assert.equal(data.months.length, 2);
    assert.equal(data.status.ledgerRows, 2);
    assert.equal(data.status.gate.conclusion, 'ok');
    // CLI 返回的 countsAfter 必须与独立采集逐键一致
    const expected = catalogCounts(data);
    for (const k of ['months', 'originals', 'weeklies', 'handover', 'cleanup', 'checkup', 'ledgerRows']) {
      assert.equal(wOut.countsAfter[k], expected[k], 'countsAfter.' + k + ' 与实况不一致');
    }
    // 迁移前后"账目数字"必须相等（只 rename）
    for (const k of ['months', 'originals', 'weeklies', 'handover', 'cleanup', 'checkup', 'ledgerRows']) {
      assert.equal(wOut.countsAfter[k], wOut.countsBefore[k], '迁移改变了数字：' + k);
    }

    // ── 渲染文本与数据一致（直接解析表格行） ──
    const text = fs.readFileSync(catalogPath(root), 'utf8');
    assert.match(text, /^# 账簿总目录$/m);
    assert.match(text, /不是账务记录本身/, '总目录必须声明"不是账务记录本身"');
    assert.match(text, /不参与对账/);
    const row = (label) => {
      const line = text.split('\n').find((l) => l.startsWith(`| ${label} |`));
      assert.ok(line, '总目录缺表格行：' + label + '\n' + text);
      return line.split('|').slice(1, -1).map((s) => s.trim());
    };
    assert.deepEqual(row('交接表').slice(0, 4), ['交接表', '2', '2', '0'], '交接表行数字与实况不一致');
    assert.deepEqual(row('清册').slice(0, 4), ['清册', '3', '3', '0'], '清册行数字与实况不一致');
    assert.deepEqual(row('体检').slice(0, 4), ['体检', '1', '1', '0'], '体检行数字与实况不一致');
    const octRow = row('2026年10月');
    assert.equal(octRow[1], '1', '月份行原文份数');
    assert.equal(octRow[2], '1', '月份行周账份数');
    assert.match(octRow[3], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '最近修改应是 +08:00 机器时间格式');
    assert.match(row('最近对账结论')[1], /`ok`/, '闸门结论必须是 ok');
    assert.match(row('台账行数')[1], /^2（/, '台账行数必须是 2');
    assert.ok(text.includes('`' + path.resolve(root) + '`'), '总目录必须写账库根路径');
    assert.ok(text.includes(ROOT_ID), '总目录必须写 .ledger-root rootId');
    assert.match(text, /生成时间 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00/, '生成时间必须是 +08:00 格式');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 九、底座自测（T-01…T-03）
// ============================================================================

test('T-01 根标记：默认落点 / 幂等补写 / 内容合规 / 坏标记不覆盖', () => {
  const fakeHome = path.join(os.tmpdir(), '假家目录-v062');
  assert.equal(defaultRootDir(fakeHome), path.join(fakeHome, 'Desktop', '会话账本'), '默认根必须是 <home>/Desktop/会话账本');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v062-t01-'));
  try {
    const root = path.join(base, '会话账本');
    // ① 老库补写：没有标记 → created
    const m1 = ensureRootMarker(root, { nowMs: T0, rootId: ROOT_ID });
    assert.equal(m1.ok, true);
    assert.equal(m1.created, true);
    assert.equal(m1.path, path.join(root, '.ledger-root'));
    // ★ 新装库首轮：根里只有 marker（分类子目录尚未产出）也必须判为**新布局 2**，
    //   不能报 1 —— 否则运行报告会让人误以为这是旧布局。
    assert.equal(LAYOUT.detectLayout(root).layoutVersion, 2, '仅有 marker 的根必须判为新布局');
    const text1 = fs.readFileSync(m1.path, 'utf8');
    assert.equal(text1.endsWith('\n'), true, '标记文件以 LF 结尾');
    assert.equal(/\r/.test(text1), false, '标记文件必须是纯 LF');
    const marker = JSON.parse(text1);
    assert.equal(marker.v, 1);
    assert.equal(marker.kind, 'dsh-dialog-ledger-root');
    assert.match(marker.rootId, /^[0-9a-f-]{36}$/);
    assert.equal(marker.createdAt, '2026-11-10T12:00:00+08:00', 'createdAt 必须是 +08:00 的 ISO 时间');
    assert.equal(marker.layoutVersion, LAYOUT.LAYOUT_VERSION);

    // ② 幂等：已合规 → 零写（字节都不变）
    const bytes1 = fs.readFileSync(m1.path);
    const m2 = ensureRootMarker(root, { nowMs: T0 + 60_000 });
    assert.equal(m2.created, false);
    assert.equal(m2.updated, false);
    assert.equal(m2.marker.rootId, ROOT_ID);
    assert.deepEqual(fs.readFileSync(m1.path), bytes1, '已合规标记不得因启动被重写');

    // ③ 布局升级：只升 layoutVersion，rootId/createdAt 原样保留
    const m3 = ensureRootMarker(root, { nowMs: T0 + 120_000, layoutVersion: 3 });
    assert.equal(m3.ok, true);
    assert.equal(m3.updated, true);
    assert.equal(m3.marker.rootId, ROOT_ID, '升版本不得换 rootId');
    assert.equal(m3.marker.createdAt, marker.createdAt, '升版本不得换 createdAt');
    assert.equal(m3.marker.layoutVersion, 3);
    const readBack = readRootMarker(root);
    assert.equal(readBack.found, true);
    assert.equal(readBack.reason, '');
    assert.equal(readBack.marker.rootId, ROOT_ID);

    // ④ 坏标记：不静默覆盖（交给人处理）
    fs.writeFileSync(m1.path, '{ 这不是 JSON\n', 'utf8');
    const bad = ensureRootMarker(root, { nowMs: T0 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'E_MARKER_JSON');
    assert.equal(fs.readFileSync(m1.path, 'utf8'), '{ 这不是 JSON\n', '★ 坏标记不得被静默覆盖');

    // ⑤ 老库（无标记但有账）→ 补写后身份正确
    const root2 = path.join(base, '老账库');
    writeText(path.join(root2, 'legacy.txt'), '老库内容\n');
    const m5 = ensureRootMarker(root2, { nowMs: T0, rootId: ROOT_ID });
    assert.equal(m5.created, true);
    assert.equal(readRootMarker(root2).marker.rootId, ROOT_ID);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('T-02 总目录采集只读；无运行报告时 gate=unknown（不伪装成 ok）', () => {
  const { base, root } = mkBase('t02');
  try {
    seedOldLibrary(root);
    // 模拟"账库还没跑过对账"：删掉运行报告
    fs.rmSync(path.join(root, 'ledger', '.run-report-20261110.json'));

    const before = fileMap(root);
    const data = collectCatalogData(root, { nowMs: T0, offsetMinutes: OFFSET });
    assert.deepEqual(sortedEntries(fileMap(root)), sortedEntries(before), '采集总目录数据必须零写');

    assert.equal(data.status.gate.conclusion, 'unknown', '无报告时必须是 unknown，不许当 ok');
    assert.equal(data.status.gate.evidence, 'no-run-report');
    assert.equal(data.status.gate.knownGaps.length, 0);
    const text = renderCatalog(data);
    assert.match(text, /最近对账结论 \| `unknown`/);
    assert.match(text, /无运行报告/);

    // 写总目录是唯一允许的写：同一时刻重复生成内容稳定
    const w1 = writeCatalog(root, { nowMs: T0, data });
    assert.equal(w1.ok, true);
    assert.equal(w1.path, catalogPath(root));
    assert.equal(w1.bytes, fs.statSync(w1.path).size, 'bytes 必须等于实写字节');
    assert.equal(w1.counts.handover, 2);
    const t1 = fs.readFileSync(w1.path, 'utf8');
    const w2 = writeCatalog(root, { nowMs: T0 });
    assert.equal(w2.ok, true);
    assert.equal(fs.readFileSync(w2.path, 'utf8'), t1, '同一时刻重复生成内容应稳定（原子写不留临时文件）');
    assert.equal(
      fs.readdirSync(root).some((n) => n.startsWith(`${LAYOUT.CATALOG_NAME}.tmp-`)),
      false,
      '原子写不得留下临时文件',
    );
    // 生成时间变了，内容自然变
    const w3 = writeCatalog(root, { nowMs: T0 + 1000 });
    assert.notEqual(fs.readFileSync(w3.path, 'utf8'), t1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('T-03 --write 幂等：再跑一次 0 搬运、退出 0、不重复写 journal', () => {
  const { base, root } = mkBase('t03');
  try {
    seedOldLibrary(root);
    const w1 = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(w1.status, 0, '首次 --write 应退出 0（stderr=' + w1.stderr + '）');
    const journalsAfter1 = fs.readdirSync(path.join(root, 'ledger')).filter((n) => n.startsWith('.layout-migration-'));
    assert.equal(journalsAfter1.length, 1, '首次迁移应写 1 份 journal');
    const before = fileMap(root);

    // 再写一次：已在新布局 → 0 搬运、不新建 journal、退出 0（总目录允许按新时间刷新）
    const w2 = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(w2.status, 0, '二次 --write 应退出 0（stderr=' + w2.stderr + '）');
    const out2 = parseJsonOut(w2);
    assert.equal(out2.moved.length, 0, '已在新布局不应再搬');
    assert.equal(out2.journal.path, '', '无搬运不应新建 journal');
    assert.equal(out2.countsEqual, true);
    const journalsAfter2 = fs.readdirSync(path.join(root, 'ledger')).filter((n) => n.startsWith('.layout-migration-'));
    assert.equal(journalsAfter2.length, 1, '无搬运不得重复写 journal');

    // 除总目录（允许刷新生成时间）外，文件集合与字节不变
    const after = fileMap(root);
    const stripCatalog = (m) => new Map([...m].filter(([rel]) => rel !== LAYOUT.CATALOG_NAME));
    assert.deepEqual(sortedEntries(stripCatalog(after)), sortedEntries(stripCatalog(before)), '二次 --write 不得改动任何单据/台账');

    // dry-run 此时也应是"0 搬运、退出 0"
    const d = runCli([`--root=${root}`, '--json']);
    assert.equal(d.status, 0, '迁移后 dry-run 应退出 0');
    const dOut = parseJsonOut(d);
    assert.equal(dOut.moves.length, 0);
    assert.equal(dOut.conflicts.length, 0);
    assert.equal(dOut.unknown.length, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 十、T-04 --rollback 可只给 journal（自动推根）+ 防串库
// ============================================================================

test('T-04 --rollback 只给 journal 自动推根；显式 --root 时校验 journal 归属（防串库）', () => {
  const { base, root } = mkBase('t04');
  try {
    seedOldLibrary(root);
    const w = runCli([`--root=${root}`, '--write', '--json']);
    assert.equal(w.status, 0, '--write 应退出 0（stderr=' + w.stderr + '）');
    const wOut = parseJsonOut(w);
    assert.equal(wOut.moved.length, 6);
    assert.ok(wOut.journal.path && fs.existsSync(wOut.journal.path));
    assert.equal(fs.existsSync(path.join(root, LAYOUT.SUBDIR.handover, FIX.handoverMain)), true);

    // ① 只给 --rollback=<journal>（不给 --root）：根由 <journal 所在目录>/.. 推出，应成功回退。
    //    入参故意用 realpath 规范化后的路径：Windows 同一目录的 8.3 短名（如 <build-host>\…）
    //    与长名写法不同 —— 推出来的根与 journal 里记的绝对路径可能"看起来不是同一个"，
    //    必须靠 realpath 规范化认对（2026-11-10 集成演练实测踩过的坑）。
    const canonicalJournal = path.join(
      fs.realpathSync.native(path.dirname(wOut.journal.path)),
      path.basename(wOut.journal.path),
    );
    const r = runCli([`--rollback=${canonicalJournal}`, '--json']);
    assert.equal(r.status, 0, '只给 journal 必须能回退（stderr=' + r.stderr + '）');
    const out = parseJsonOut(r);
    assert.ok(out, '--json 必须输出可解析 JSON：' + r.stdout.slice(0, 300));
    assert.equal(out.mode, 'rollback');
    assert.equal(out.exitCode, 0);
    assert.equal(fs.realpathSync.native(out.root), fs.realpathSync.native(root), '推出的根必须指向账库根');
    assert.equal(out.rootInferred, true, '机读结果应标明根是推出来的');
    assert.equal(out.restored.length, 6);
    assert.equal(out.failures.length, 0);
    assert.equal(out.journalDone, `${canonicalJournal}.done`);
    assert.equal(fs.existsSync(out.journalDone), true, 'journal 应改名 .done（规范化路径）');
    for (const name of SIX_NAMES) {
      assert.equal(fs.existsSync(path.join(root, name)), true, '应回到一级：' + name);
      assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), CONTENT[name]);
    }

    // ② 串库防护：拿 A 库 journal + --root=B 库 → E_ARGS、零动作、journal 不被改名
    const otherRoot = path.join(base, '另一个账库');
    fs.mkdirSync(otherRoot, { recursive: true });
    ensureRootMarker(otherRoot, { nowMs: T0, rootId: '99999999-8888-7777-6666-555555555555' });
    writeText(path.join(otherRoot, 'ledger', '2026-10-01.jsonl'), '{"v":3}\n');
    const otherBefore = fileMap(otherRoot);
    const bad = runCli([`--root=${otherRoot}`, `--rollback=${out.journalDone}`, '--json']);
    assert.equal(bad.status, 2, '拿 A 库 journal 回滚 B 库必须退出码 2（stderr=' + bad.stderr + '）');
    const badOut = parseJsonOut(bad);
    assert.ok(badOut, '参数错误也必须是可解析 JSON');
    assert.equal(badOut.reason, 'E_ARGS');
    assert.match(String(badOut.detail || ''), /ledger/, '错误信息应点名 journal 必须在本库 ledger/ 下');
    assert.deepEqual(sortedEntries(fileMap(otherRoot)), sortedEntries(otherBefore), '★ 串库拒绝必须零动作（B 库一个字节都不动）');
    assert.equal(fs.existsSync(out.journalDone), true, '拒绝时不得改名/删除 journal');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});