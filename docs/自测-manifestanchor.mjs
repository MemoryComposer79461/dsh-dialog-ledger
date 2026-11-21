/**
 * @file 自测-manifestanchor.mjs
 * @role V0.8 库外 manifest 锚：包摘要复算 / MANIFEST 解析 / 锚 append+幂等+链 / 只读校验 / 账本快照校验。
 *
 * 用法：node docs/跑测试.mjs docs/自测-manifestanchor.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ma = await import(pathToFileURL(path.join(SRC, 'freeze', 'manifestanchor.js')).href);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 造一个最小交付包（含 MANIFEST.sha256 与 版本台账.md）。 */
function makePkg(base, version = '0.9.0', extra = {}) {
  const dir = path.join(base, 'pkg-' + version);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const files = { '00-交付清单.md': '# list\n', 'index.js': 'export const x = 1;\n', 'sub/a.txt': 'a\n', 'VERSION.txt': version + '\n', ...extra };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, 'utf8');
  }
  // MANIFEST：列出除 MANIFEST 自身与 版本台账.md 外的全部文件
  const lines = ma.listFiles(dir).filter((rel) => !['MANIFEST.sha256', '版本台账.md'].includes(path.basename(rel)))
    .map((rel) => `${sha256(fs.readFileSync(path.join(dir, rel)))}  ${rel}`).sort();
  fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, '版本台账.md'), '# ledger\n| ' + version + ' |\n', 'utf8');
  return dir;
}

function treeHash(root) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { h.update('D:' + path.relative(root, p) + '\n'); walk(p); }
      else h.update('F:' + path.relative(root, p) + ':' + fs.readFileSync(p).toString('hex').slice(0, 16) + '\n');
    }
  };
  walk(root);
  return h.digest('hex');
}

test('MA-02：computePackageDigest 算法与出包脚本/台账一致（0.7.0 真包复算 → 台账 payloadHash）', () => {
  const pkg = '<build-host>/Desktop/v0.7.0-正式-20261110';
  if (!fs.existsSync(pkg)) { console.log('[SKIP] 0.7.0 真包不存在（异机/清理后可跳过）'); return; }
  const d = ma.computePackageDigest(pkg);
  assert.equal(d.payloadHash, '5d6686fe371d5cb015c4a2ce432dae2e0e1eb0d812f6183f3d5482f7d1f33c7a', 'payloadHash 必须与版本台账一致');
  const mf = ma.readManifest(pkg);
  assert.equal(mf.count, 414);
  assert.equal(mf.badLines, 0);
});

test('MA-01/03/04：锚 append 幂等、包校验 PASS、tamper 后判红并定位', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-'));
  const anchorDir = path.join(base, 'anchor');
  const pkg = makePkg(base);
  const digest = ma.computePackageDigest(pkg);
  const mf = ma.readManifest(pkg);
  const a1 = ma.appendAnchor(anchorDir, {
    kind: 'package', version: '0.9.0', stage: '正式版',
    payloadHash: digest.payloadHash, prevHash: '（创世）',
    manifestSha256: mf.rootHash, fileCount: 6, manifestCount: mf.count, pkgPath: pkg,
  });
  assert.equal(a1.ok, true);
  assert.equal(a1.appended, true);
  const a2 = ma.appendAnchor(anchorDir, {
    kind: 'package', version: '0.9.0', stage: '正式版',
    payloadHash: digest.payloadHash, prevHash: '（创世）', manifestSha256: mf.rootHash,
    fileCount: 6, manifestCount: mf.count, pkgPath: pkg,
  });
  assert.equal(a2.appended, false);
  assert.equal(a2.idempotent, true, '同 payloadHash 必须幂等跳过');
  const linesBefore = fs.readFileSync(path.join(anchorDir, ma.ANCHOR_FILE), 'utf8');
  assert.equal(linesBefore.trim().split('\n').length, 1);

  const ok = ma.verifyPackageAgainstAnchor(pkg, anchorDir);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));

  fs.writeFileSync(path.join(pkg, 'sub', 'a.txt'), 'TAMPERED\n', 'utf8');
  const bad = ma.verifyPackageAgainstAnchor(pkg, anchorDir);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find((c) => c.name === 'payloadHash').ok, false, '改文件 → payloadHash 必须变红');
  fs.rmSync(base, { recursive: true, force: true });
});

test('MA-05：锚链 prevHash 断 → 链校验判红并定位', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-chain-'));
  const anchorDir = path.join(base, 'anchor');
  const p1 = makePkg(path.join(base, 'p1'), '0.9.1');
  const p2 = makePkg(path.join(base, 'p2'), '0.9.2');
  const d1 = ma.computePackageDigest(p1);
  const d2 = ma.computePackageDigest(p2);
  const m1 = ma.readManifest(p1);
  const m2 = ma.readManifest(p2);
  ma.appendAnchor(anchorDir, { kind: 'package', version: '0.9.1', stage: '正式版', payloadHash: d1.payloadHash, prevHash: '（创世）', manifestSha256: m1.rootHash, fileCount: 6, manifestCount: m1.count });
  // 故意写错的 prevHash
  ma.appendAnchor(anchorDir, { kind: 'package', version: '0.9.2', stage: '正式版', payloadHash: d2.payloadHash, prevHash: 'WRONG-PREV', manifestSha256: m2.rootHash, fileCount: 6, manifestCount: m2.count });
  const a = ma.readAnchor(anchorDir);
  assert.equal(a.chainOk, false);
  assert.equal(a.breaks.length, 1);
  const v = ma.verifyPackageAgainstAnchor(p2, anchorDir);
  assert.equal(v.checks.find((c) => c.name === 'anchor-chain').ok, false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('MA-06/07：账本快照校验（篡改一日判红）且校验器只读', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ledger-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(root, '2026年11月'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ledger', '2026-11-10.jsonl'), '{"v":3,"code":"x"}\n', 'utf8');
  fs.writeFileSync(path.join(root, '2026年11月', '11月第3周-aaaaaaaaaaaaA的周记账.xlsx'), 'sealed', 'utf8');
  fs.writeFileSync(path.join(root, '2026年11月', '草稿-11月第3周-bbbbbbbbbbbbA的周记账.xlsx'), 'draft', 'utf8');
  const snap = ma.buildLedgerSnapshot(root);
  assert.equal(snap.totalRows, 1);
  assert.equal(snap.weeklySealedCount, 1);
  assert.equal(snap.weeklyDraftCount, 1);
  const before = treeHash(root);
  const ok = ma.verifyLedgerSnapshot(root, snap);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));
  assert.equal(treeHash(root), before, '校验器必须只读（整树哈希不变）');
  fs.writeFileSync(path.join(root, 'ledger', '2026-11-10.jsonl'), '{"v":3,"code":"x"}\n{"v":3,"code":"y"}\n', 'utf8');
  const bad = ma.verifyLedgerSnapshot(root, snap);
  assert.equal(bad.ok, false);
  assert.equal(bad.diffs[0].kind, 'sha-mismatch');
  fs.rmSync(base, { recursive: true, force: true });
});

test('MA-08：index 接锚（集成）——每日快照一次 + 包锚幂等 + 锚目录越界拒绝', async () => {
  const L = await import(pathToFileURL(path.join(SRC, 'docs', '验收-v0.5', '_lab.mjs')).href);
  const lab = L.mkLab('anchor-int');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-int-'));
  const anchorDir = path.join(base, 'anchor');
  const pkg = makePkg(path.join(base, 'pkgbase'), '0.8.0-test');
  try {
    L.writeSession(lab, { events: [...L.sessionHeader(lab.sid), ...L.simpleTurn(1, L.T0())] });
    const cfg = { manifestAnchorRoot: anchorDir, deliveryPackageDir: pkg, weeklyEnabled: false, handoverEnabled: false };
    const r1 = await L.runOnce(SRC, lab, cfg);
    assert.equal(r1.stat.errors.length, 0);
    const file = path.join(anchorDir, ma.ANCHOR_FILE);
    assert.equal(fs.existsSync(file), true, '必须生成库外锚文件');
    const entries1 = ma.readAnchor(anchorDir).entries;
    assert.equal(entries1.filter((x) => x.kind === 'package').length, 1, '包锚 1 条');
    assert.equal(entries1.filter((x) => x.kind === 'ledger-snapshot').length, 1, '账本快照 1 条');
    assert.equal(r1.stat.deliveryAnchor.ledger, 'appended');
    assert.equal(r1.stat.deliveryAnchor.package, 'appended');

    // 同一天第二次 run：账本快照节流（不再追加），包锚幂等跳过
    const r2 = await L.runOnce(SRC, lab, cfg);
    const entries2 = ma.readAnchor(anchorDir).entries;
    assert.equal(entries2.filter((x) => x.kind === 'ledger-snapshot').length, 1, '每日快照只能一条');
    assert.equal(entries2.filter((x) => x.kind === 'package').length, 1, '同包幂等');
    assert.equal(ma.readAnchor(anchorDir).chainOk, true);
    void r2;

    // 越界：锚目录放在数据总库里面 → 拒绝并告警，不写锚
    const insideAnchor = path.join(lab.root, 'anchor-inside');
    const r3 = await L.runOnce(SRC, lab, { manifestAnchorRoot: insideAnchor, weeklyEnabled: false, handoverEnabled: false });
    assert.equal(fs.existsSync(path.join(insideAnchor, ma.ANCHOR_FILE)), false, '越界锚必须拒绝');
    assert.ok(r3.stat.warnings.some((w) => String(w).includes('ANCHOR_INSIDE_ROOT')), '必须告警');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    L.rmLab(lab);
  }
});
