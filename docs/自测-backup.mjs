/**
 * @file 自测-backup.mjs
 * @role **0.9.4-P3 增量备份工具（tools/backup.mjs）的单测 / 反证**（C37；方案 E4-6）。
 *
 * 判据（B-01…B-15，全部在 os.tmpdir() 的临时账库里跑，不碰真实账库/Desktop）：
 *   B-01 `backup --full` 首次：exit 0；`MANIFEST.sha256` + `backup.json` 自包含；
 *        清单**排除自身**、含 `backup.json`；源账库逐文件 sha256 前后不变（**只读**）。
 *   B-02 增量（无变化）：exit 0、拷贝 0 个、未变 >0。
 *   B-03 改 1 个原文视图 1 字节 → 增量**只拷 1 项**（按 view 分类、带 code）。
 *   B-04 `verify` 干净备份 PASS（exit 0）。
 *   B-05 反证：删备份内 1 个附件 → verify 报「缺」1、exit 1；从坏备份 restore 拒绝（exit 1、零写入）。
 *   B-06 反证：改备份内 1 个原文视图字节 → verify 报「改」1、exit 1。
 *   B-07 反证：备份内多出未入清单文件 → verify 报「多」1、exit 1。
 *   B-08 restore **默认 dry-run**：exit 0、目标目录不被创建（零写入）。
 *   B-09 反证：restore 目标非空且无 `--force` → exit 2、零写入（目标逐文件 sha256 不变）。
 *   B-10 反证：restore 目标像已有账库 + `--force` → 仍 exit 2、零写入（**绝不覆盖已有账库**）。
 *   B-11 restore `--write` 到空目标：exit 0；恢复后 `readAll` 可读；恢复副本与备份逐文件 sha256 一致；
 *        再 restore 到同一目标（已像账库）→ exit 2（绝不覆盖）。
 *   B-12 清单/分类纯函数：非法路径（绝对路径/`..`/反斜杠）被拒；view/attachment/ledger/weekly 分类正确。
 *   B-13 反证：`--out` 落在 `--root` 内 → exit 2（账库只读、备份不能扫进自己）。
 *   B-14 源删 1 个视图 → 增量**保留**旧副本（copied 0、sourceRemoved 1、verify 仍 PASS）；
 *        再 `--full` 镜像 → 删除该旧副本（pruned 1）、verify PASS。
 *   B-15 `--include-metrics` 可把默认跳过的 `.tick-metrics.jsonl` 纳入；`--since` 在增量下过滤候选且不丢旧备份。
 *
 * 用法：node docs\跑测试.mjs docs\自测-backup.mjs
 *      （单跑：node --test docs\自测-backup.mjs）
 *
 * 写盘纪律：所有账库/备份都建在 `os.tmpdir()` + `mkdtempSync` 的临时根里，用后即删；
 *          唯一"真实"写动作是 CLI 自己写临时目录里的 `--out`。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyRel, parseManifestText } from '../tools/backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.join(REPO, 'tools', 'backup.mjs');

// ── 通用小工具 ───────────────────────────────────────────────────────────────
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (p) => sha(fs.readFileSync(p));

/** 目录快照：相对路径 → sha256（隐藏文件也算）。 */
function snapshot(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const stack = [{ d: dir, rel: '' }];
  while (stack.length) {
    const { d, rel } = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { stack.push({ d: path.join(d, ent.name), rel: childRel }); continue; }
      if (!ent.isFile()) continue;
      out.set(childRel, shaFile(path.join(d, ent.name)));
    }
  }
  return out;
}

function assertSameSnapshot(a, b, msg) {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${msg}：文件集合变了`);
  for (const [rel, h] of a) assert.equal(b.get(rel), h, `${msg}：${rel} 内容变了`);
}

/** 跑 CLI；返回 {exit, out, stdout}。 */
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  return { exit: r.error ? -1 : (r.status ?? -1), out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

/** 跑 CLI 并解析 `--json`。 */
function runJson(args) {
  const r = run([...args, '--json']);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { ...r, json };
}

function writeText(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

// ── 夹具（临时账库）──────────────────────────────────────────────────────────
const ROOT_ID = 'f8c11df2-ca89-40b3-8441-bb625752a5bc';
const CODE1 = '20261009-43198444938f-A-00000001';
const CODE2 = '20261009-43198444938f-A-00000002';

let base = '';      // 临时根
let root = '';      // 账库根
let outDir = '';    // 备份目录
let monthDir = '';  // 月份目录
let origDir = '';   // 原文子目录

function ledgerRow(code, n) {
  return JSON.stringify({
    code, ts: '2026-10-09 12:00:00 +08:00', seq: n,
    sid: code.slice(9, 21), turn: n, doc: `${code} 完整原文.md`,
  }) + '\n';
}

function buildFixture() {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-backup-test-'));
  root = path.join(base, '会话账本');
  outDir = path.join(base, 'bak');
  monthDir = path.join(root, '2026年10月');
  origDir = path.join(monthDir, '10月总“完整原文”');

  writeText(path.join(root, '.ledger-root'), JSON.stringify({
    v: 1, kind: 'dsh-dialog-ledger-root', rootId: ROOT_ID,
    createdAt: '2026-10-09T12:00:00+08:00', layoutVersion: 2,
  }, null, 2) + '\n');
  writeText(path.join(root, '账簿总目录.md'), '# 账簿总目录\n\n（测试夹具）\n');

  // 原文视图 + 原始事件附件（各 2 份）
  for (const code of [CODE1, CODE2]) {
    writeText(path.join(origDir, `${code} 原始事件.json`), JSON.stringify({
      v: 1, code, events: [{ role: 'user', text: '测试事件 ' + code }],
    }, null, 2) + '\n');
    writeText(path.join(origDir, `${code} 完整原文.md`),
      `---\n编码: ${code}\n---\n\n## 1. 用户\n\n测试完整原文 ${code}\n`);
  }
  // 周账（restore 只搬字节，不解析 xlsx）
  writeText(path.join(monthDir, '10月第2周-43198444938fA的周记账.xlsx'), 'XLSX-FIXTURE-BYTES');
  // 台账 + 运行区
  writeText(path.join(root, 'ledger', '2026-10-09.jsonl'), ledgerRow(CODE1, 1) + ledgerRow(CODE2, 2));
  writeText(path.join(root, 'ledger', '.state.json'), JSON.stringify({ v: 1, rootId: ROOT_ID }, null, 2) + '\n');
  writeText(path.join(root, 'ledger', '.seal-journal.jsonl'), JSON.stringify({ type: 'seal', at: '2026-10-09 12:03:00 +08:00' }) + '\n');
  // 默认跳过项：运行度量
  writeText(path.join(root, 'ledger', '.tick-metrics.jsonl'), JSON.stringify({ at: '2026-10-09 12:00:01', ms: 1 }) + '\n');
}

// 备份范围快照
const backupFilesSnapshot = () => snapshot(path.join(outDir, 'files'));
let sourceAtStart = new Map(); // 备份前源快照（B-01 只读证明用）

before(() => {
  buildFixture();
  sourceAtStart = snapshot(root);
  const r = runJson(['backup', `--root=${root}`, `--out=${outDir}`]);
  assert.equal(r.exit, 0, '夹具首次全量备份必须 exit 0：' + r.out);
});

after(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判定 */ }
});

// ============================================================================
// 一、备份本体
// ============================================================================

test('B-01 首次 --full：自包含清单、排除自身、含 backup.json、源只读', () => {
  const man = fs.readFileSync(path.join(outDir, 'MANIFEST.sha256'), 'utf8');
  assert.ok(man.length > 0, '必须有 MANIFEST.sha256');
  assert.ok(!/^[0-9a-f]{64} {2}MANIFEST\.sha256$/m.test(man), '★ 清单不得包含自身');
  assert.match(man, /^[0-9a-f]{64} {2}backup\.json$/m, '清单必须包含 backup.json（改元数据也会被 verify 报改）');

  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'backup.json'), 'utf8'));
  assert.equal(meta.schema, 'lite-backup/1');
  assert.equal(meta.mode, 'full');
  assert.equal(path.resolve(meta.source.root), path.resolve(root), 'backup.json 必须记源根');
  assert.equal(meta.source.rootId, ROOT_ID);
  assert.equal(meta.manifest.excludesSelf, true);

  // 默认跳过 .tick-metrics.jsonl；其余（含 .ledger-root、总目录、.state.json、.seal-journal）必须备份
  assert.equal(fs.existsSync(path.join(outDir, 'files', 'ledger', '.tick-metrics.jsonl')), false, '默认不备份 .tick-metrics.jsonl');
  assert.ok(fs.existsSync(path.join(outDir, 'files', '.ledger-root')), '必须备份 .ledger-root');
  assert.ok(fs.existsSync(path.join(outDir, 'files', '账簿总目录.md')), '必须备份 账簿总目录.md');
  assert.ok(fs.existsSync(path.join(outDir, 'files', 'ledger', '.state.json')), '必须备份 .state.json');
  assert.ok(fs.existsSync(path.join(outDir, 'files', 'ledger', '.seal-journal.jsonl')), '必须备份 .seal-journal.jsonl');

  // 备份副本与源逐字节一致（默认跳过项除外）
  for (const [rel, h] of backupFilesSnapshot()) {
    if (rel === 'ledger/.tick-metrics.jsonl') continue;
    assert.equal(shaFile(path.join(root, ...rel.split('/'))), h, `备份副本内容必须与源一致：${rel}`);
  }
  // 源只读：备份跑完后源快照必须与备份前逐文件一致
  assertSameSnapshot(sourceAtStart, snapshot(root), '备份不得改源账库一个字节');
});

test('B-02 增量（无变化）：拷贝 0 个、未变 >0', () => {
  const before = backupFilesSnapshot();
  const r = runJson(['backup', `--root=${root}`, `--out=${outDir}`]);
  assert.equal(r.exit, 0, r.out);
  assert.equal(r.json.mode, 'incremental');
  assert.equal(r.json.copied.files, 0, '无变化时不得拷贝任何文件');
  assert.ok(r.json.unchangedFiles > 0, '应报未变化文件数');
  assertSameSnapshot(backupFilesSnapshot(), before, '无变化增量不得改备份内容');
});

test('B-03 改 1 个原文视图 1 字节 → 增量只拷 1 项（带 code，按 view 分类）', () => {
  const target = path.join(origDir, `${CODE1} 完整原文.md`);
  fs.appendFileSync(target, 'X', 'utf8');
  const r = runJson(['backup', `--root=${root}`, `--out=${outDir}`]);
  assert.equal(r.exit, 0, r.out);
  assert.equal(r.json.mode, 'incremental');
  assert.equal(r.json.copied.files, 1, '只应拷贝 1 个变化文件，实际：' + JSON.stringify(r.json.copied));
  assert.equal(r.json.copied.byKind.view.files, 1);
  assert.equal(r.json.copied.byKind.attachment.files, 0);
  assert.equal(r.json.copied.byKind.ledger.files, 0);
  assert.equal(r.json.copied.byKind.weekly.files, 0);
  assert.equal(r.json.changed.total, 1);
  assert.equal(r.json.changed.sample[0].code, CODE1, '变化的视图必须带 code 供对账');
  assert.equal(r.json.changed.sample[0].kind, 'view');
  // 备份副本已更新为新内容
  assert.equal(shaFile(path.join(outDir, 'files', '2026年10月', '10月总“完整原文”', `${CODE1} 完整原文.md`)), shaFile(target));
});

test('B-04 verify：干净备份 PASS（exit 0，缺/多/改全 0）', () => {
  const r = runJson(['verify', `--out=${outDir}`]);
  assert.equal(r.exit, 0, r.out);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.counts, { missing: 0, extra: 0, changed: 0 });
  assert.ok(r.json.manifest.entries > 0);
});

// ============================================================================
// 二、verify 反证（缺 / 改 / 多）
// ============================================================================

/** 复制一份备份目录（不污染后续用例）。 */
function copyBackup(name) {
  const dst = path.join(base, name);
  fs.cpSync(outDir, dst, { recursive: true });
  return dst;
}

test('B-05 反证：删备份内 1 个附件 → verify 报「缺」；坏备份拒绝 restore（零写入）', () => {
  const bad = copyBackup('bak-missing');
  const att = fs.readdirSync(path.join(bad, 'files', '2026年10月', '10月总“完整原文”'))
    .find((n) => n.endsWith('原始事件.json'));
  assert.ok(att, '夹具里必须有附件');
  fs.rmSync(path.join(bad, 'files', '2026年10月', '10月总“完整原文”', att));

  const v = runJson(['verify', `--out=${bad}`]);
  assert.equal(v.exit, 1, '缺文件必须 exit 1');
  assert.equal(v.json.counts.missing, 1);
  assert.equal(v.json.counts.changed, 0);
  assert.ok(v.json.missing[0].rel.includes(att), 'missing 必须点名缺的附件');

  const to = path.join(base, 'restore-from-bad');
  const r = runJson(['restore', `--out=${bad}`, `--to=${to}`, '--write']);
  assert.equal(r.exit, 1, '备份校验不通过时绝不允许恢复');
  assert.equal(fs.existsSync(to), false, '★ 拒绝恢复必须零写入（目标目录都不应被创建）');
});

test('B-06 反证：改备份内 1 个原文视图字节 → verify 报「改」', () => {
  const bad = copyBackup('bak-changed');
  const view = fs.readdirSync(path.join(bad, 'files', '2026年10月', '10月总“完整原文”'))
    .find((n) => n.endsWith('完整原文.md'));
  fs.appendFileSync(path.join(bad, 'files', '2026年10月', '10月总“完整原文”', view), 'Z', 'utf8');

  const v = runJson(['verify', `--out=${bad}`]);
  assert.equal(v.exit, 1);
  assert.equal(v.json.counts.changed, 1);
  assert.equal(v.json.counts.missing, 0);
  assert.ok(v.json.changed[0].rel.endsWith(view), 'changed 必须点名被改的文件');
});

test('B-07 反证：备份内多出未入清单文件 → verify 报「多」', () => {
  const bad = copyBackup('bak-extra');
  writeText(path.join(bad, 'files', 'stray-not-in-manifest.txt'), 'x');
  const v = runJson(['verify', `--out=${bad}`]);
  assert.equal(v.exit, 1);
  assert.equal(v.json.counts.extra, 1);
  assert.ok(v.json.extra[0].rel.includes('stray-not-in-manifest.txt'));
});

// ============================================================================
// 三、restore 安全行为（默认 dry-run / 非空拒绝 / 绝不覆盖账库 / 真恢复验读）
// ============================================================================

test('B-08 restore 默认 dry-run：出计划、零写入（目标目录不被创建）', () => {
  const to = path.join(base, 'restore-dry');
  const r = runJson(['restore', `--out=${outDir}`, `--to=${to}`]);
  assert.equal(r.exit, 0, r.out);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.write, false);
  assert.ok(r.json.plan.files > 0, 'dry-run 也要给出计划文件数');
  assert.equal(fs.existsSync(to), false, '★ dry-run 必须零写入（连目录都不建）');
});

test('B-09 反证：restore 目标非空且无 --force → exit 2、零写入', () => {
  const to = path.join(base, 'restore-nonempty');
  writeText(path.join(to, 'note.txt'), 'keep me');
  const before = snapshot(to);
  const r = runJson(['restore', `--out=${outDir}`, `--to=${to}`, '--write']);
  assert.equal(r.exit, 2, '非空目标必须拒绝（exit 2）');
  assert.match(r.out, /非空/);
  assertSameSnapshot(snapshot(to), before, '★ 拒绝必须零写入');
});

test('B-10 反证：restore 目标像已有账库 + --force → 仍 exit 2、零写入', () => {
  const to = path.join(base, 'restore-existing-ledger');
  writeText(path.join(to, '.ledger-root'), '{"v":1,"kind":"dsh-dialog-ledger-root"}\n');
  writeText(path.join(to, 'ledger', '2026-10-09.jsonl'), ledgerRow(CODE1, 1));
  const before = snapshot(to);
  const r = runJson(['restore', `--out=${outDir}`, `--to=${to}`, '--force', '--write']);
  assert.equal(r.exit, 2, '★ 已有账库绝不允许覆盖，--force 也不解除');
  assert.match(r.out, /绝不覆盖已有账库/);
  assertSameSnapshot(snapshot(to), before, '拒绝必须零写入');
});

test('B-11 restore --write 到空目标：可读 + 逐文件一致；再恢复同一目标被拒（绝不覆盖）', () => {
  const to = path.join(base, 'restored');
  const r = runJson(['restore', `--out=${outDir}`, `--to=${to}`, '--write']);
  assert.equal(r.exit, 0, r.out);
  assert.equal(r.json.readBack.ok, true, '恢复后 readAll 必须可读（C37 一条命令验读）');
  assert.equal(r.json.readBack.rows, 2, '夹具 2 行台账必须读回 2 行');
  assert.equal(r.json.readBack.badLines, 0);
  // 恢复副本逐文件与备份一致
  assertSameSnapshot(snapshot(to), backupFilesSnapshot(), '恢复副本必须与备份逐文件一致');

  // 再恢复到同一目标（现在它已像账库）→ 拒绝
  const again = runJson(['restore', `--out=${outDir}`, `--to=${to}`, '--force', '--write']);
  assert.equal(again.exit, 2, '★ 已恢复过的账库同样不许再覆盖');
});

// ============================================================================
// 四、清单解析/分类纯函数
// ============================================================================

test('B-12 清单解析拒绝越界路径；文件分类正确', () => {
  const bad = parseManifestText([
    `${'a'.repeat(64)}  ../../evil.txt`,
    `${'b'.repeat(64)}  C:\\Windows\\x.txt`,
    `${'c'.repeat(64)}  files\\x.txt`,
    `${'d'.repeat(64)}  /abs/x.txt`,
    `${'e'.repeat(64)}  MANIFEST.sha256`,
    'not-a-manifest-line',
  ].join('\n'));
  assert.equal(bad.entries.size, 0, '非法路径必须全部拒绝');
  assert.equal(bad.errors.length, 6, '每条非法行都要报错，实际：' + bad.errors.join(' | '));

  const good = parseManifestText(`${'f'.repeat(64)}  files/2026年10月/x 完整原文.md\n`);
  assert.equal(good.entries.size, 1);
  assert.equal(good.errors.length, 0);

  assert.equal(classifyRel('2026年10月/10月总“完整原文”/20261009-43198444938f-A-00000001 完整原文.md').kind, 'view');
  assert.equal(classifyRel('2026年10月/10月总“完整原文”/20261009-43198444938f-A-00000001 完整原文.md').code, CODE1);
  assert.equal(classifyRel('2026年10月/10月总“完整原文”/20261009-43198444938f-A-00000001 原始事件.json').kind, 'attachment');
  assert.equal(classifyRel('ledger/2026-10-09.jsonl').kind, 'ledger');
  assert.equal(classifyRel('2026年10月/10月第2周-43198444938fA的周记账.xlsx').kind, 'weekly');
  assert.equal(classifyRel('.ledger-root').kind, 'other');
});

// ============================================================================
// 五、参数/边界与增量删除语义
// ============================================================================

test('B-13 反证：--out 落在 --root 内 → exit 2（账库只读、备份不能扫进自己）', () => {
  const inside = path.join(root, 'bak-inside');
  const r = runJson(['backup', `--root=${root}`, `--out=${inside}`]);
  assert.equal(r.exit, 2);
  assert.equal(fs.existsSync(inside), false, '拒绝后不得创建备份目录');
});

test('B-14 源删 1 个视图：增量保留旧副本 + sourceRemoved；--full 镜像才删（pruned）', () => {
  const delTarget = path.join(origDir, `${CODE2} 完整原文.md`);
  fs.rmSync(delTarget);
  const inc = runJson(['backup', `--root=${root}`, `--out=${outDir}`]);
  assert.equal(inc.exit, 0, inc.out);
  assert.equal(inc.json.copied.files, 0);
  assert.equal(inc.json.sourceRemoved.total, 1, '源已删除必须如实告警');
  assert.equal(inc.json.sourceRemoved.sample[0].code, CODE2);
  // 增量保留旧副本 = 备份的意义
  assert.ok(fs.existsSync(path.join(outDir, 'files', '2026年10月', '10月总“完整原文”', `${CODE2} 完整原文.md`)),
    '★ 增量不得因为源删就删掉旧副本');
  assert.equal(runJson(['verify', `--out=${outDir}`]).exit, 0, '保留旧副本后 verify 仍应 PASS');

  // --full = 镜像：删除源已没有的旧副本
  const full = runJson(['backup', `--root=${root}`, `--out=${outDir}`, '--full']);
  assert.equal(full.exit, 0, full.out);
  assert.equal(full.json.mode, 'full');
  assert.ok(full.json.pruned.files >= 1, '--full 必须清理源已没有的旧副本');
  assert.equal(fs.existsSync(path.join(outDir, 'files', '2026年10月', '10月总“完整原文”', `${CODE2} 完整原文.md`)), false);
  assert.equal(runJson(['verify', `--out=${outDir}`]).exit, 0);
});

test('B-15 --include-metrics 可纳入默认跳过项；--since 增量只过滤候选、不丢旧备份', () => {
  // 新备份目录 + --include-metrics：.tick-metrics.jsonl 必须进备份
  const outMetrics = path.join(base, 'bak-metrics');
  const r1 = runJson(['backup', `--root=${root}`, `--out=${outMetrics}`, '--include-metrics']);
  assert.equal(r1.exit, 0, r1.out);
  assert.ok(fs.existsSync(path.join(outMetrics, 'files', 'ledger', '.tick-metrics.jsonl')), '--include-metrics 必须备份度量文件');
  assert.equal(runJson(['verify', `--out=${outMetrics}`]).exit, 0);

  // --since 在未来（全部源 mtime 都更旧）：增量候选 0，但旧备份一个不丢、verify 仍 PASS
  const before = backupFilesSnapshot();
  const r2 = runJson(['backup', `--root=${root}`, `--out=${outDir}`, '--since=20991231']);
  assert.equal(r2.exit, 0, r2.out);
  assert.equal(r2.json.mode, 'incremental');
  assert.equal(r2.json.since, '20991231');
  assert.equal(r2.json.candidates.files, 0, '--since 过滤后应 0 候选');
  assert.equal(r2.json.copied.files, 0);
  assertSameSnapshot(backupFilesSnapshot(), before, '★ --since 过滤不得删旧备份');
  assert.equal(runJson(['verify', `--out=${outDir}`]).exit, 0);
});
