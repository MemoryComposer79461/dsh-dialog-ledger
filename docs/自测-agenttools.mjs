/**
 * @file 自测-agenttools.mjs
 * @role V0.9 Agent 工具面与清理正式化验收：4 个新工具（reconcile / anchor / preview / apply）+
 *       清理三重条件 + 既有只读面不回退。
 *
 * @why 判据编号契约：每个用例标题里**逐字**出现 AG-xx / CT-xx，判据映射表靠标题匹配。
 *      用例编号与要求的对应关系见 `docs/交付-v0.9/01-Agent面与清理正式化设计.md` §五。
 *
 * @why 每条判据都从"磁盘事实"判：
 *      · 只读（AG-01/CT-01）：调用前后整树 sha256（含目录节点）必须完全一致；
 *      · 清理（CT-02…CT-07）：只看真实文件增删与字节，不信实现自报的计数；
 *      · 降级/拒绝（AG-02/AG-05/CT-03/CT-04/CT-08）：必须 `ok:false` + `reason` + **零删除**。
 *
 * 写盘纪律：全部临时目录落 `%TEMP%\agtools-*`，每个用例 finally 删整棵；
 *           不读真实数据总库、不写 U 盘、不碰内核六文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ct = await import(pathToFileURL(path.join(SRC, 'freeze', 'cleanup-tools.js')).href);
const tf = await import(pathToFileURL(path.join(SRC, 'tools', 'toolface.js')).href);
const ma = await import(pathToFileURL(path.join(SRC, 'freeze', 'manifestanchor.js')).href);
const cl = await import(pathToFileURL(path.join(SRC, 'freeze', 'cleanup.js')).href);
const rl = await import(pathToFileURL(path.join(SRC, 'tools', 'readlog.js')).href);
const ori = await import(pathToFileURL(path.join(SRC, 'lib', 'original.js')).href);
const wk = await import(pathToFileURL(path.join(SRC, 'lib', 'week.js')).href);
const weekly = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);
const led = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const SESS_KEY = '75238718e41aA';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const codeAt = (n) => `20261109-75238718e41a-A-${String(n).padStart(8, '0')}`;
const tsAt = (n) => `2026-11-09T1${n}:00:00+08:00`;

/** 全部新工具名（顺序固定：原 5 个在前）。 */
const TOOL_NAMES = [
  'ledger_search', 'ledger_turn', 'ledger_context', 'ledger_whoami', 'ledger_health',
  'ledger_reconcile', 'ledger_anchor', 'ledger_cleanup_preview', 'ledger_cleanup_apply',
];
/** 只读工具（允许"除读日志外整树不变"）：9 个里只有 apply 是受控写。 */
const READ_ONLY_TOOL_NAMES = TOOL_NAMES.filter((n) => n !== 'ledger_cleanup_apply');

// ============================================================================
// 一、夹具与小工具
// ============================================================================

/** 递归整树快照（文件带 sha256、目录带 D: 节点；AG-01/CT-01 的"一个字节都不许写"用）。 */
function treeEntries(root) {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        out.push('D:' + r);
        walk(p, r);
      } else {
        out.push('F:' + r + ':' + sha256(fs.readFileSync(p)));
      }
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

/** 读日志路径（唯一允许变化的运行区文件；与 docs/自测-toolface.mjs 同一口径）。 */
function isReadLogRel(rel) {
  const p = rel.split(path.sep).join('/');
  return p === 'ledger/.reads.jsonl' || p === 'ledger/.reads' || p.startsWith('ledger/.reads/');
}

/** 快照整棵树，但跳过读日志（工具层只允许写读日志）。 */
function treeExceptReadLog(root) {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (isReadLogRel(r)) continue;
      if (e.isDirectory()) {
        out.push('D:' + r);
        walk(p, r);
      } else {
        out.push('F:' + r + ':' + sha256(fs.readFileSync(p)));
      }
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

/** 造一份**真绑定**的完整原文（YAML 身份字段齐全 + 事件附件），并返回台账应记的证据字段。 */
function writeRealVoucher(root, code, ts, turn) {
  const ms = Date.parse(ts);
  const w = wk.weekOf(ms, 480);
  const events = [
    { seq: 1, type: 'turn/start', time: ms, data: { turn } },
    { seq: 2, type: 'user/message', time: ms + 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试原文' }] } },
    { seq: 3, type: 'turn/end', time: ms + 2000, data: { turn, reason: { kind: 'completed' } } },
  ];
  const rendered = ori.renderOriginal({
    events,
    turn: { turn, startMs: ms, endMs: ms + 2000, reason: 'completed' },
    code, sid: SID, sessKey: SESS_KEY, seq: turn,
    offsetMinutes: 480,
  });
  const doc = ori.writeOriginal({
    root, y: w.year, m: w.month, code,
    markdown: rendered.markdown,
    bodyHash: rendered.bodyHash,
    fullHash: rendered.fullHash,
    attachment: rendered.attachment,
  });
  const out = { doc: doc.rel, docSha256: doc.bodyHash, docFileSha256: doc.fullHash };
  if (doc.attachment) {
    out.attachment = { name: doc.attachment.name, sha256: doc.attachment.sha256, bytes: doc.attachment.bytes };
  }
  return out;
}

/**
 * 建"可清理的干净账库"：2 份真绑定原文（含附件）+ 台账 + 对应周账占位 + 交接表。
 * @why CT-05/06/07 需要"清理前是干净的"才有意义：清理后 reconcile 若报缺凭证，
 *      必须是因为清册没接上，而不是因为夹具本来就不完整。
 */
function makeVoucherLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agtools-'));
  const root = path.join(base, 'root');
  const anchor = path.join(base, 'anchor');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(anchor, { recursive: true });

  const known = new Set();
  const rows = [];
  const codes = [codeAt(1), codeAt(2)];
  for (const [i, code] of codes.entries()) {
    const turn = i + 1;
    const ts = tsAt(turn);
    const ev = writeRealVoucher(root, code, ts, turn);
    const rec = {
      v: 3, code, ts, sid: SID, turn, seq: turn, status: 'ok', turnState: 'closed',
      src: 'session.v4.jsonl.zstd',
      doc: ev.doc, docSha256: ev.docSha256, docFileSha256: ev.docFileSha256,
      ...(ev.attachment ? { attachment: ev.attachment } : {}),
    };
    const w = led.appendTurn(root, rec, known);
    assert.equal(w.ok, true, '夹具台账写入失败: ' + JSON.stringify(w));
    known.add(code);
    rows.push(rec);
  }

  // 周账占位（对账只判存在、不读 xlsx）：每组一个正式名文件。
  const groups = weekly.groupRecords(rows, 480);
  const weeklyAbs = [];
  for (const [, g] of groups) {
    const rel = path.join(wk.weeklyFolderName(g.w), wk.weeklyFileName(g.w, g.sessKey));
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'fake-xlsx', 'utf8');
    weeklyAbs.push(abs);
  }

  // 交接表（一级分类目录，清理绝不能碰）
  const handoverRel = path.join('交接表', `${SESS_KEY}的记忆数据库的启用及交接表.md`);
  const handoverAbs = path.join(root, handoverRel);
  fs.mkdirSync(path.dirname(handoverAbs), { recursive: true });
  fs.writeFileSync(handoverAbs, '# 交接表\n', 'utf8');

  return {
    base, root, anchor, codes, rows, weeklyAbs, handoverAbs,
    ledgerAbs: path.join(root, 'ledger', '2026-11-09.jsonl'),
    viewAbs: rows.map((r) => path.join(root, r.doc)),
    attAbs: rows.map((r) => path.join(root, path.dirname(r.doc), `${r.code} 原始事件.json`)),
  };
}

/** 造一个最小交付包（含 MANIFEST.sha256 与 版本台账.md；算法与出包脚本一致）。 */
function makePkg(base, version) {
  const dir = path.join(base, 'pkg-' + version);
  const files = {
    '00-交付清单.md': '# list\n',
    'index.js': 'export const x = 1;\n',
    'sub/a.txt': 'a\n',
    'VERSION.txt': version + '\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, 'utf8');
  }
  const lines = ma.listFiles(dir)
    .filter((rel) => !['MANIFEST.sha256', '版本台账.md'].includes(path.basename(rel)))
    .map((rel) => `${sha256(fs.readFileSync(path.join(dir, rel)))}  ${rel}`).sort();
  fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, '版本台账.md'), '# ledger\n| ' + version + ' |\n', 'utf8');
  return dir;
}

/** 建"合法库外锚"：2 条包锚（链连续）+ 1 条账本快照锚；返回现场。 */
function makeAnchorLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agtools-anchor-'));
  const anchorDir = path.join(base, 'anchor');
  const pkg1 = makePkg(base, '0.9.0');
  const pkg2 = makePkg(base, '0.9.1');
  const d1 = ma.computePackageDigest(pkg1);
  const d2 = ma.computePackageDigest(pkg2);
  const m1 = ma.readManifest(pkg1);
  const m2 = ma.readManifest(pkg2);
  const a1 = ma.appendAnchor(anchorDir, {
    kind: 'package', version: '0.9.0', stage: '正式版',
    payloadHash: d1.payloadHash, prevHash: '（创世）',
    manifestSha256: d1.manifestSha256, fileCount: d1.files + 3, manifestCount: m1.count, pkgPath: pkg1,
  });
  assert.equal(a1.ok, true, '夹具锚 1 写入失败: ' + JSON.stringify(a1));
  const a2 = ma.appendAnchor(anchorDir, {
    kind: 'package', version: '0.9.1', stage: '正式版',
    payloadHash: d2.payloadHash, prevHash: d1.payloadHash,
    manifestSha256: d2.manifestSha256, fileCount: d2.files + 3, manifestCount: m2.count, pkgPath: pkg2,
  });
  assert.equal(a2.ok, true, '夹具锚 2 写入失败: ' + JSON.stringify(a2));
  const a3 = ma.appendAnchor(anchorDir, {
    kind: 'ledger-snapshot', note: 'test',
    files: [{ name: '2026-11-10.jsonl', bytes: 5, sha256: 'a'.repeat(64), rows: 1 }],
  });
  assert.equal(a3.ok, true, '夹具锚 3 写入失败: ' + JSON.stringify(a3));
  return { base, anchorDir, pkg1, pkg2, digest1: d1, digest2: d2, file: path.join(anchorDir, ma.ANCHOR_FILE) };
}

/** 读锚文件并按行拆（测试里做篡改用）。 */
const anchorLines = (file) => fs.readFileSync(file, 'utf8').split('\n');

/** 写回锚文件（保持末尾 LF）。 */
const writeAnchorLines = (file, lines) => {
  const kept = lines.filter((l) => l !== '');
  fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8');
};

/** 清空整个夹具。 */
const drop = (base) => fs.rmSync(base, { recursive: true, force: true });

/** 断言"调用不抛且返回 ok:false + reason"。 */
function expectDegrade(fn, expectedReason, label) {
  let out;
  assert.doesNotThrow(() => { out = fn(); }, label + ' 不许抛');
  assert.ok(out && typeof out === 'object', label + ' 必须返回对象');
  assert.equal(out.ok, false, label + ' 必须 ok:false（实际 ' + JSON.stringify(out && out.reason) + '）');
  assert.equal(typeof out.reason, 'string', label + ' 必须带 reason');
  if (expectedReason) assert.equal(out.reason, expectedReason, label + ' reason 不符');
  return out;
}

/** 校验 ToolCallView / ToolResultView 形状（与 docs/自测-toolcards.mjs 同口径的最小子集）。 */
function assertCallView(view, where) {
  assert.ok(view && typeof view === 'object', where + ': 必须返回对象');
  assert.equal(view.card, 'generic', where + ': 本工具族只用 generic 调用卡片');
  assert.equal(typeof view.title, 'string', where + ': title 必须是字符串');
}
function assertResultView(view, where) {
  assert.ok(view && typeof view === 'object', where + ': 必须返回对象');
  assert.ok(view.card === 'generic' || view.card === 'read', where + ': card 非法（实际 ' + view.card + '）');
  assert.equal(typeof view.title, 'string', where + ': title 必须是字符串');
  if (view.card === 'read') {
    // 原 5 个里的 ledger_turn 用 read 卡片（excerpt 逐行）：行号/总数必须是整数。
    assert.equal(typeof view.path, 'string', where + ': read.path 必须是字符串');
    assert.ok(Number.isInteger(view.offset) && view.offset >= 0, where + ': read.offset 必须是非负整数');
    assert.ok(Array.isArray(view.lines), where + ': read.lines 必须是数组');
    assert.ok(Number.isInteger(view.totalLines), where + ': read.totalLines 必须是整数');
    return;
  }
  assert.ok(Array.isArray(view.content), where + ': content 必须是数组');
  for (const b of view.content) {
    assert.equal(b.type, 'text', where + ': content 只允许 text 块');
    assert.equal(typeof b.text, 'string', where + ': text 必须是字符串');
  }
}

/** 走一遍"预览 → 物理执行"（CT-05/06/07 的公共流程）；返回 dry / phys。 */
function runPhysical(lab) {
  const dry = ct.applyCleanup({ root: lab.root, dryRun: true });
  assert.equal(dry.ok, true, 'dry-run 必须成功: ' + JSON.stringify(dry));
  const phys = ct.applyCleanup({
    root: lab.root, dryRun: false, confirm: dry.confirmPhrase,
    cleanupToolEnabled: true, cleanupAllowPhysicalDelete: true,
  });
  return { dry, phys };
}

// ============================================================================
// 二、AG 族：Agent 面（只读 / 降级 / 判红 / 工具面 / 越界）
// ============================================================================

test('V0.9/AG-01：只读三件套（reconcile/anchor/preview）调用前后整树 sha256 不变', () => {
  const lab = makeVoucherLab();
  try {
    // 同一次调用里覆盖锚核验：给换证夹具配一个合法库外锚（含包锚 → 会触发 payloadHash 复算）。
    const pkg = makePkg(lab.base, '0.9.0');
    const d = ma.computePackageDigest(pkg);
    const mf = ma.readManifest(pkg);
    const a = ma.appendAnchor(lab.anchor, {
      kind: 'package', version: '0.9.0', stage: '正式版',
      payloadHash: d.payloadHash, prevHash: '（创世）',
      manifestSha256: d.manifestSha256, fileCount: d.files + 3, manifestCount: mf.count, pkgPath: pkg,
    });
    assert.equal(a.ok, true);

    const before = treeEntries(lab.base);
    const r1 = ct.compactReconcile({ root: lab.root });
    const r2 = ct.verifyAnchor({ anchorRoot: lab.anchor });
    const r3 = ct.previewCleanup({ root: lab.root });
    const after = treeEntries(lab.base);

    assert.equal(r1.ok, true, '干净账库对账必须 ok:true: ' + JSON.stringify(r1.problems));
    assert.equal(r1.counts.originalMissing, 0);
    assert.equal(r2.ok, true, '合法锚必须 PASS: ' + JSON.stringify(r2.problems));
    assert.equal(r2.counts.verifiedPackages, 1);
    assert.equal(r3.ok, true);
    assert.equal(r3.planned, 2);
    assert.deepEqual(after, before, '只读三件套不许改动任何文件（含目录节点）');
  } finally { drop(lab.base); }
});

test('V0.9/AG-02：降级——账库缺失/账本损坏/参数非法/锚未配置 → ok:false + reason，不抛', () => {
  const lab = makeVoucherLab();
  try {
    // ① 数据总库不存在：不能把"没读到"当"没有"（P1-8 口径），必须降级。
    expectDegrade(() => ct.compactReconcile({ root: path.join(lab.base, 'no-such-root') }),
      ct.E_ROOT_MISSING, 'reconcile@缺失账库');
    expectDegrade(() => ct.previewCleanup({ root: path.join(lab.base, 'no-such-root') }),
      ct.E_ROOT_MISSING, 'preview@缺失账库');

    // ② 台账损坏（坏行）→ 读不全，不能给出"账是干净的"结论。
    const badRoot = path.join(lab.base, 'bad-root');
    fs.mkdirSync(path.join(badRoot, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(badRoot, 'ledger', '2026-11-09.jsonl'), '{not-json\n', 'utf8');
    expectDegrade(() => ct.compactReconcile({ root: badRoot }), ct.E_LEDGER_UNREADABLE, 'reconcile@账本损坏');
    assert.doesNotThrow(() => ct.compactReconcile({ root: badRoot }), '读坏也必须返回结果而不是抛');

    // ③ 锚：未配置 = 降级关闭；配置了但文件不在 = anchor-missing。都不许抛。
    expectDegrade(() => ct.verifyAnchor({ anchorRoot: '' }), 'anchor-disabled', 'anchor@未配置');
    expectDegrade(() => ct.verifyAnchor({ anchorRoot: lab.anchor }), 'anchor-missing', 'anchor@文件缺失');

    // ④ 参数非法：类型/格式错一律拒绝。
    expectDegrade(() => ct.previewCleanup({ root: lab.root, month: '2026/11' }), ct.E_BAD_ARGS, 'preview@坏 month');
    expectDegrade(() => ct.previewCleanup({ root: lab.root, limit: 1.5 }), ct.E_BAD_ARGS, 'preview@坏 limit');
    expectDegrade(() => ct.applyCleanup({ root: lab.root, dryRun: 'yes' }), ct.E_BAD_ARGS, 'apply@坏 dryRun');
    expectDegrade(() => ct.applyCleanup({ root: lab.root, month: '2026-13' }), ct.E_BAD_ARGS, 'apply@坏 month');

    // ⑤ 非法 root（相对路径 / 盘符根）：清理族一律拒绝。
    expectDegrade(() => ct.compactReconcile({ root: 'relative/x' }), ct.E_BAD_ROOT, 'reconcile@相对 root');
    expectDegrade(() => ct.previewCleanup({ root: path.parse(lab.root).root }), ct.E_BAD_ROOT, 'preview@盘符根');
  } finally { drop(lab.base); }
});

test('V0.9/AG-03：判红——锚链断/条目被篡改 → ok:false 并定位到哪一条', () => {
  // ① 合法锚：先证明正向 PASS（否则"判红"没有对照）。
  {
    const lab = makeAnchorLab();
    try {
      const ok = ct.verifyAnchor({ anchorRoot: lab.anchorDir });
      assert.equal(ok.ok, true, '合法锚必须 PASS: ' + JSON.stringify(ok.problems));
      assert.equal(ok.counts.packages, 2);
      assert.equal(ok.counts.snapshots, 1);
      assert.equal(ok.chainOk, true);
      assert.equal(ok.head.kind, 'ledger-snapshot', 'head 指向最后一条锚行（快照行）');
    } finally { drop(lab.base); }
  }

  // ② 条目被篡改：改盘上包内容 → 复算 payloadHash 不符，必须定位到第 2 行。
  {
    const lab = makeAnchorLab();
    try {
      fs.writeFileSync(path.join(lab.pkg2, 'sub', 'a.txt'), 'TAMPERED-BY-TEST\n', 'utf8');
      const bad = ct.verifyAnchor({ anchorRoot: lab.anchorDir });
      assert.equal(bad.ok, false, '包被改必须判红');
      const hit = bad.problems.find((p) => p.kind === 'payload-mismatch');
      assert.ok(hit, '必须报 payload-mismatch（实际 ' + JSON.stringify(bad.problems) + '）');
      assert.equal(hit.line, 2, '必须定位到第 2 行（被篡改的那条包锚）');
      assert.match(hit.detail, /0\.9\.1|payloadHash/);
      assert.equal(bad.counts.payloadMismatches >= 1, true);
    } finally { drop(lab.base); }
  }

  // ③ 链断：把第 2 条包锚的 prevHash 改掉 → 定位到第 2 行。
  {
    const lab = makeAnchorLab();
    try {
      const lines = anchorLines(lab.file);
      const row = JSON.parse(lines[1]);
      row.prevHash = 'b'.repeat(64);
      lines[1] = JSON.stringify(row);
      writeAnchorLines(lab.file, lines);
      const bad = ct.verifyAnchor({ anchorRoot: lab.anchorDir });
      assert.equal(bad.ok, false);
      const hit = bad.problems.find((p) => p.kind === 'chain-break');
      assert.ok(hit, '必须报 chain-break（实际 ' + JSON.stringify(bad.problems) + '）');
      assert.equal(hit.line, 2);
      assert.equal(bad.chainOk, false);
    } finally { drop(lab.base); }
  }

  // ④ 坏行/半行：JSON 解析不了 → bad-line；末尾缺 LF → torn-tail（append-only 被截断的证据）。
  {
    const lab = makeAnchorLab();
    try {
      const lines = anchorLines(lab.file).filter((l) => l !== '');
      lines.push('{"v":1,"kind":"package"');
      fs.writeFileSync(lab.file, lines.join('\n'), 'utf8'); // 末尾故意不带换行
      const bad = ct.verifyAnchor({ anchorRoot: lab.anchorDir });
      assert.equal(bad.ok, false);
      assert.ok(bad.problems.some((p) => p.kind === 'bad-line'), '坏行必须报 bad-line');
      assert.ok(bad.problems.some((p) => p.kind === 'torn-tail'), '末尾半行必须报 torn-tail');
    } finally { drop(lab.base); }
  }
});

test('V0.9/AG-04：工具面 9 个、schema/卡片齐全、每次调用写读日志', async () => {
  const lab = makeVoucherLab();
  try {
    const pkg = makePkg(lab.base, '0.9.0');
    const d = ma.computePackageDigest(pkg);
    const mf = ma.readManifest(pkg);
    ma.appendAnchor(lab.anchor, {
      kind: 'package', version: '0.9.0', stage: '正式版',
      payloadHash: d.payloadHash, prevHash: '（创世）',
      manifestSha256: d.manifestSha256, fileCount: d.files + 3, manifestCount: mf.count, pkgPath: pkg,
    });

    const defs = tf.buildToolDefs({
      getRoot: () => lab.root,
      getAnchorRoot: () => lab.anchor,
      offsetMinutes: 480,
      cleanupToolEnabled: true,
      cleanupAllowPhysicalDelete: true,
    });
    assert.deepEqual(defs.map((x) => x.name), TOOL_NAMES, '工具总数 9、顺序固定（原 5 个在前）');
    assert.equal(defs.length, 9);

    const args = {
      ledger_search: { sid: SID, limit: 5 },
      ledger_turn: { code: lab.codes[0] },
      ledger_context: { sid: SID, turns: 5 },
      ledger_whoami: {},
      ledger_health: {},
      ledger_reconcile: {},
      ledger_anchor: {},
      ledger_cleanup_preview: {},
      ledger_cleanup_apply: {},
    };

    // schema / output / 卡片回调：9 个都必须齐全。
    for (const def of defs) {
      assert.equal(typeof def.description, 'string');
      assert.equal(def.description.length > 10, true, def.name + ' 描述太短');
      assert.equal(def.parameters && def.parameters.type, 'object', def.name + ' parameters 必须是 object');
      assert.equal(def.parameters.additionalProperties, false, def.name + ' 必须 additionalProperties:false');
      assert.equal(typeof def.output.render, 'function', def.name + ' 缺 output.render');
      assert.equal(typeof def.presentCall, 'function', def.name + ' 缺 presentCall');
      assert.equal(typeof def.presentResult, 'function', def.name + ' 缺 presentResult');
      assert.equal(typeof def.execute, 'function', def.name + ' 缺 execute');
    }
    // 关键参数 schema（"参数齐全"不能只看 type:object）。
    const by = Object.fromEntries(defs.map((x) => [x.name, x]));
    assert.ok(by.ledger_turn.parameters.required.includes('code'));
    assert.ok(by.ledger_context.parameters.required.includes('sid'));
    for (const k of ['month', 'sessionKey', 'limit']) {
      assert.ok(by.ledger_cleanup_preview.parameters.properties[k], 'preview 缺参数 ' + k);
      assert.ok(by.ledger_cleanup_apply.parameters.properties[k], 'apply 缺参数 ' + k);
    }
    assert.ok(by.ledger_cleanup_apply.parameters.properties.dryRun);
    assert.ok(by.ledger_cleanup_apply.parameters.properties.confirm);

    // 每个工具真实执行一次：结果必须是对象；新 4 个必须紧凑（<8 KiB，不塞清册全文）。
    const values = {};
    for (const def of defs) {
      values[def.name] = await def.execute(args[def.name] || {}, { agent: { id: SID } });
      assert.ok(values[def.name] && typeof values[def.name] === 'object', def.name + ' 执行结果必须是对象');
    }
    for (const name of TOOL_NAMES.slice(5)) {
      assert.equal(Boolean(values[name].ok), true, name + ' 在合法夹具上应 ok:true: ' + JSON.stringify(values[name]));
      const bytes = Buffer.byteLength(JSON.stringify(values[name]), 'utf8');
      assert.ok(bytes < 8192, name + ' 结果必须紧凑（实际 ' + bytes + ' 字节）');
    }

    // 每个工具都有可用的调用卡片 + 结果卡片。
    for (const def of defs) {
      assertCallView(def.presentCall(args[def.name] || {}), def.name + '.presentCall');
      assertResultView(def.presentResult(args[def.name] || {}, values[def.name]), def.name + '.presentResult');
    }

    // 读日志：9 次调用 → 9 行，工具名一个不少。
    const log = rl.readReads(lab.root, { limit: 20 });
    assert.equal(log.total, 9, '每次工具调用都必须留读日志（实际 ' + log.total + '）');
    assert.deepEqual(log.rows.map((r) => r.tool).sort(), TOOL_NAMES.slice().sort());
  } finally { drop(lab.base); }
});

test('V0.9/AG-05：越界拒绝——非法 root/未知参数 → 拒绝且不写盘', async () => {
  const lab = makeVoucherLab();
  try {
    // ① 非法 root（空串 / 盘符根）：四个工具都只返回 ok:false + reason，且**一个文件都不写**。
    const before = treeEntries(lab.base);
    for (const badRoot of ['', path.parse(lab.root).root]) {
      const defs = tf.buildToolDefs({ getRoot: () => badRoot, offsetMinutes: 480 });
      for (const name of ['ledger_reconcile', 'ledger_anchor', 'ledger_cleanup_preview', 'ledger_cleanup_apply']) {
        const v = await defs.find((x) => x.name === name).execute({}, { agent: { id: SID } });
        assert.equal(v.ok, false, name + '@非法 root 必须拒绝（root=' + JSON.stringify(badRoot) + '）');
        assert.equal(typeof v.reason, 'string', name + ' 拒绝必须带 reason');
      }
    }
    assert.deepEqual(treeEntries(lab.base), before, '非法 root 不许写盘（连读日志都不写）');

    // ② 未知参数：必须在碰 runCleanup 之前拒绝（否则"参数名打错"会被静默忽略）。
    const good = tf.buildToolDefs({ getRoot: () => lab.root, getAnchorRoot: () => lab.anchor, offsetMinutes: 480 });
    const noProductBefore = treeExceptReadLog(lab.root);
    const cases = [
      ['ledger_reconcile', { bogus: 1 }],
      ['ledger_cleanup_preview', { montn: '2026-11' }],
      ['ledger_cleanup_apply', { dryRun: true, extra: 2 }],
    ];
    for (const [name, badArgs] of cases) {
      const v = await good.find((x) => x.name === name).execute(badArgs, { agent: { id: SID } });
      assert.equal(v.ok, false, name + ' 未知参数必须拒绝');
      assert.equal(v.reason, ct.E_BAD_ARGS, name + ' 未知参数 reason 必须是 E_BAD_ARGS');
    }
    assert.equal(fs.existsSync(path.join(lab.root, '清册')), false, '参数被拒时不许产任何清册/报告');
    assert.deepEqual(treeExceptReadLog(lab.root), noProductBefore, '参数被拒时不许写产物（读日志除外）');
  } finally { drop(lab.base); }
});

// ============================================================================
// 三、CT 族：清理正式化
// ============================================================================

test('V0.9/CT-01：清理预览零字节写入（不产 RPT-DRYRUN）', () => {
  const lab = makeVoucherLab();
  try {
    const before = treeEntries(lab.base);
    const r = ct.previewCleanup({ root: lab.root });
    const after = treeEntries(lab.base);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.planned, 2, '两份可清理原文');
    assert.ok(r.bytes > 0, 'bytes 必须 > 0');
    assert.equal(r.byMonth['2026-11'].files, 2, '按月分布必须命中 2026-11');
    assert.equal(r.sample.length <= 5, true);
    assert.equal(r.sample.length, 2);
    assert.deepEqual(after, before, '预览必须零字节写入');
    // 特别钉住：预览不产 RPT-DRYRUN（那是 apply 的 dry-run 才有的产物）。
    const picked = after.filter((x) => /RPT-DRYRUN/.test(x));
    assert.deepEqual(picked, [], '预览不许产 RPT-DRYRUN');
  } finally { drop(lab.base); }
});

test('V0.9/CT-02：dry-run 只写 RPT-DRYRUN，不占正式编号', () => {
  const lab = makeVoucherLab();
  try {
    const before = treeEntries(lab.base);
    const r = ct.applyCleanup({ root: lab.root, dryRun: true });
    const after = treeEntries(lab.base);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.dryRun, true);
    assert.match(r.reportId, /^RPT-DRYRUN-\d{8}-01$/, 'dry-run 必须用独立前缀且从 01 起');
    assert.equal(r.planned, 2);
    assert.equal(r.confirmPhrase, `DELETE 2 ${r.reportId}`, 'confirm 短语格式必须是 DELETE <planned> <reportId>');

    // 新增文件恰好一个：root/清册/<reportId>.md（只允许新建"清册"目录本身）；
    // 原文一个不少、字节不变。
    const added = after.filter((x) => !before.includes(x));
    const addedFiles = added.filter((x) => x.startsWith('F:'));
    const addedDirs = added.filter((x) => x.startsWith('D:'));
    assert.equal(addedFiles.length, 1, 'dry-run 只允许新增一份报告（实际 ' + JSON.stringify(added) + '）');
    assert.deepEqual(addedDirs, ['D:root/清册'], 'dry-run 只允许新建 清册/ 这一层目录');
    assert.match(addedFiles[0], /^F:root\/清册\/RPT-DRYRUN-\d{8}-01\.md:/);
    assert.deepEqual(before.filter((x) => !after.includes(x)), [], 'dry-run 不许删除/改动任何既有文件');
    for (const abs of [...lab.viewAbs, ...lab.attAbs]) {
      assert.equal(fs.existsSync(abs), true, 'dry-run 不许删原文: ' + abs);
    }
    // 正式编号未被占用：没有 RPT-YYYYMMDD-NN.md、没有 journal；下一个正式号仍是 01。
    const formal = after.filter((x) => /\/RPT-\d{8}-\d+\.md:/.test(x));
    assert.deepEqual(formal, [], 'dry-run 不许产正式清册');
    const journals = after.filter((x) => /\.cleanup-RPT-/.test(x));
    assert.deepEqual(journals, [], 'dry-run 不许写 journal（没有删除就没有销毁证据）');
    assert.match(cl.nextReportId(lab.root), /^RPT-\d{8}-01$/, 'dry-run 不许占正式编号');
  } finally { drop(lab.base); }
});

/** CT-03 公共：建夹具 + 先跑一次 dry-run 拿到 confirm 短语。 */
function ct03Setup() {
  const lab = makeVoucherLab();
  const dry = ct.applyCleanup({ root: lab.root, dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  return { lab, dry };
}

/** CT-03 公共：断言"被拒绝 + 零删除"。 */
function ct03AssertZeroDelete(lab, out, reason) {
  assert.equal(out.ok, false);
  assert.equal(out.reason, reason);
  assert.equal(out.deleted, 0, '被拒绝时必须报告零删除');
  for (const abs of [...lab.viewAbs, ...lab.attAbs]) {
    assert.equal(fs.existsSync(abs), true, '被拒绝时原文必须还在: ' + abs);
  }
  const all = treeEntries(lab.base);
  assert.deepEqual(all.filter((x) => /\/RPT-\d{8}-\d+\.md:/.test(x)), [], '被拒绝时不许产正式清册');
  assert.deepEqual(all.filter((x) => /\.cleanup-RPT-/.test(x)), [], '被拒绝时不许写 journal');
}

test('V0.9/CT-03a：三重条件之一——工具总开关关闭 → E_CLEANUP_TOOL_DISABLED 且零删除', () => {
  const { lab, dry } = ct03Setup();
  try {
    const out = ct.applyCleanup({
      root: lab.root, dryRun: false, confirm: dry.confirmPhrase,
      cleanupToolEnabled: false, cleanupAllowPhysicalDelete: true,
    });
    ct03AssertZeroDelete(lab, out, ct.E_CLEANUP_TOOL_DISABLED);
  } finally { drop(lab.base); }
});

test('V0.9/CT-03b：三重条件之二——物理删除开关关闭 → E_CLEANUP_DELETE_LOCKED 且零删除', () => {
  const { lab, dry } = ct03Setup();
  try {
    const out = ct.applyCleanup({
      root: lab.root, dryRun: false, confirm: dry.confirmPhrase,
      cleanupToolEnabled: true, cleanupAllowPhysicalDelete: false,
    });
    ct03AssertZeroDelete(lab, out, ct.E_CLEANUP_DELETE_LOCKED);
  } finally { drop(lab.base); }
});

test('V0.9/CT-03c：三重条件之三——confirm 短语不符 → E_CLEANUP_CONFIRM_MISMATCH 且零删除', () => {
  const { lab } = ct03Setup();
  try {
    const out = ct.applyCleanup({
      root: lab.root, dryRun: false, confirm: 'DELETE 999 RPT-DRYRUN-20990101-01',
      cleanupToolEnabled: true, cleanupAllowPhysicalDelete: true,
    });
    ct03AssertZeroDelete(lab, out, ct.E_CLEANUP_CONFIRM_MISMATCH);
  } finally { drop(lab.base); }
});

test('V0.9/CT-04：confirm 短语必须与当前计划一致（计划变了就不认）', () => {
  const lab = makeVoucherLab();
  try {
    const dry = ct.applyCleanup({ root: lab.root, dryRun: true });
    assert.equal(dry.ok, true, JSON.stringify(dry));
    const oldPhrase = dry.confirmPhrase;
    assert.equal(oldPhrase, `DELETE 2 ${dry.reportId}`);

    // 计划变了：绕过清理工具删掉一份原文（模拟"预览之后有人动过库"）。
    fs.rmSync(lab.viewAbs[1], { force: true });
    fs.rmSync(lab.attAbs[1], { force: true });

    const out = ct.applyCleanup({
      root: lab.root, dryRun: false, confirm: oldPhrase,
      cleanupToolEnabled: true, cleanupAllowPhysicalDelete: true,
    });
    assert.equal(out.ok, false, '计划变了以后旧 confirm 短语必须失效');
    assert.equal(out.reason, ct.E_CLEANUP_CONFIRM_MISMATCH);
    assert.equal(out.deleted, 0);
    assert.equal(out.planned, 1, '现场重算的计划必须是 1 份');
    // 剩下的原文还在；也没有"部分执行"。
    assert.equal(fs.existsSync(lab.viewAbs[0]), true);
    assert.equal(fs.existsSync(lab.attAbs[0]), true);
    const all = treeEntries(lab.base);
    assert.deepEqual(all.filter((x) => /\/RPT-\d{8}-\d+\.md:/.test(x)), []);
    assert.deepEqual(all.filter((x) => /\.cleanup-RPT-/.test(x)), []);
  } finally { drop(lab.base); }
});

test('V0.9/CT-05：执行后台账/周账/交接表字节不变', () => {
  const lab = makeVoucherLab();
  try {
    const ledgerBefore = sha256(fs.readFileSync(lab.ledgerAbs));
    const weeklyBefore = lab.weeklyAbs.map((p) => sha256(fs.readFileSync(p)));
    const handoverBefore = sha256(fs.readFileSync(lab.handoverAbs));

    const { dry, phys } = runPhysical(lab);
    assert.equal(phys.ok, true, '合法三重条件下物理执行必须成功: ' + JSON.stringify(phys));
    assert.equal(phys.dryRun, false);
    assert.match(phys.reportId, /^RPT-\d{8}-\d+$/, '物理执行必须出正式清册编号');
    assert.equal(phys.planned, 2);
    assert.equal(phys.deleted, 2, '两个清理单元都该删掉');
    assert.equal(phys.originalsAfter, 0);
    assert.match(dry.reportId, /^RPT-DRYRUN-/);

    // 原文与附件：一个不剩（视图 + 同单元附件）。
    for (const abs of [...lab.viewAbs, ...lab.attAbs]) {
      assert.equal(fs.existsSync(abs), false, '物理执行后原文/附件必须删除: ' + abs);
    }
    // 台账 / 周账 / 交接表：字节不变（清理只许动第 3 级完整原文单元）。
    assert.equal(sha256(fs.readFileSync(lab.ledgerAbs)), ledgerBefore, '台账字节不许变');
    assert.deepEqual(lab.weeklyAbs.map((p) => sha256(fs.readFileSync(p))), weeklyBefore, '周账字节不许变');
    assert.equal(sha256(fs.readFileSync(lab.handoverAbs)), handoverBefore, '交接表字节不许变');

    // 正式清册 + journal 都在；dry-run 报告也保留（审计证据只增）。
    assert.equal(fs.existsSync(phys.reportPath), true, '正式清册必须落盘: ' + phys.reportPath);
    assert.match(phys.journalPath, /\.cleanup-RPT-\d{8}-\d+\.journal$/);
    assert.equal(fs.existsSync(phys.journalPath), true, '删除必须有 journal 证据');
    const all = treeEntries(lab.base);
    assert.ok(all.some((x) => x.includes(`RPT-DRYRUN-`) && x.includes(dry.reportId)), 'dry-run 报告必须保留');
  } finally { drop(lab.base); }
});

test('V0.9/CT-06：清理后 reconcile 不误报缺凭证', () => {
  const lab = makeVoucherLab();
  try {
    const before = ct.compactReconcile({ root: lab.root });
    assert.equal(before.ok, true, '清理前账库必须是干净的: ' + JSON.stringify(before.problems));
    assert.equal(before.counts.originalMissing, 0);

    const { phys } = runPhysical(lab);
    assert.equal(phys.ok, true, JSON.stringify(phys));
    assert.equal(phys.deleted, 2);

    const after = ct.compactReconcile({ root: lab.root });
    assert.equal(after.counts.originalMissing, 0, '清册有据的删除不许被误报成缺凭证');
    assert.equal(after.counts.originalOrphan, 0, '删干净的单元不许留孤儿凭证');
    assert.equal(after.counts.weeklyGroupsMissing, 0, '周账不该因为清理而缺');
    assert.equal(after.ok, true, '清理后对账仍须 ok:true: ' + JSON.stringify(after.problems));
    assert.deepEqual(after.problems, []);
  } finally { drop(lab.base); }
});

test('V0.9/CT-07：清理后库外锚仍 PASS', () => {
  const lab = makeVoucherLab();
  try {
    // 清理前锚一次"账本快照"（台账/周账计数）——清理只动第 3 级原文，快照应当仍匹配。
    const snap = ma.buildLedgerSnapshot(lab.root, { offsetMinutes: 480 });
    const a = ma.appendAnchor(lab.anchor, snap);
    assert.equal(a.ok, true, JSON.stringify(a));
    const anchorBefore = sha256(fs.readFileSync(path.join(lab.anchor, ma.ANCHOR_FILE)));

    const { phys } = runPhysical(lab);
    assert.equal(phys.ok, true, JSON.stringify(phys));
    assert.equal(phys.deleted, 2);

    const v = ct.verifyAnchor({ anchorRoot: lab.anchor });
    assert.equal(v.ok, true, '清理后库外锚必须仍 PASS: ' + JSON.stringify(v.problems));
    assert.equal(v.counts.snapshots, 1);
    assert.equal(v.counts.structural, 0);
    // 锚文件只读：核验不许改动一个字节。
    assert.equal(sha256(fs.readFileSync(path.join(lab.anchor, ma.ANCHOR_FILE))), anchorBefore, '锚文件不许被核验改写');
    // 快照逐文件复算（账本 jsonl 未被清理触碰）也必须仍然一致。
    const vs = ma.verifyLedgerSnapshot(lab.root, snap);
    assert.equal(vs.ok, true, '账本快照复算必须仍 PASS: ' + JSON.stringify(vs.checks));
  } finally { drop(lab.base); }
});

test('V0.9/CT-08：默认关闭（缺省配置时物理执行被拒绝）', async () => {
  const lab = makeVoucherLab();
  try {
    const dry = ct.applyCleanup({ root: lab.root, dryRun: true });
    assert.equal(dry.ok, true, JSON.stringify(dry));

    // ① 纯逻辑层：不传两个开关（= DEFAULTS 的双 false）→ 必须拒绝且零删除。
    const out = ct.applyCleanup({ root: lab.root, dryRun: false, confirm: dry.confirmPhrase });
    ct03AssertZeroDelete(lab, out, ct.E_CLEANUP_TOOL_DISABLED);

    // ② 工具层：buildToolDefs 不给清理开关（= 插件默认配置）→ 同样拒绝、零删除。
    const defs = tf.buildToolDefs({ getRoot: () => lab.root, offsetMinutes: 480 });
    const apply = defs.find((x) => x.name === 'ledger_cleanup_apply');
    assert.ok(apply, '工具面必须始终注册 apply（开关只影响执行，不影响可见性）');
    const tv = await apply.execute({ dryRun: false, confirm: dry.confirmPhrase }, { agent: { id: SID } });
    assert.equal(tv.ok, false, '缺省配置时工具层物理执行必须被拒绝');
    assert.equal(tv.reason, ct.E_CLEANUP_TOOL_DISABLED);
    assert.equal(tv.deleted, 0);
    for (const abs of [...lab.viewAbs, ...lab.attAbs]) {
      assert.equal(fs.existsSync(abs), true, '默认配置下原文必须一个不少: ' + abs);
    }
  } finally { drop(lab.base); }
});
