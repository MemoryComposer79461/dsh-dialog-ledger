/**
 * @file 自测-weekly-滚动.mjs
 * @role 0.9.4-snap（P3 扩容）周账滚动 W1–W5 ＋ 月账视图 自测（轻量、串行、可重复）。
 *
 * 覆盖：
 *  A1 W1 journal 尾读缓存：冷读整读一次 → 稳态 0 新增字节 → 追加只读新增尾；
 *     文件缩水/替换 → 整读重建；`readSealJournalState/readSealEvidence` 读法一致。
 *  A2 W2/W4 只看新行 + hash 剪枝：行身份未变 → 0 次 resolveDoc；原文被改 → 只重算 1 行；
 *     行缓存清掉后仍命中 re1 的 DOC_VERIFY_CACHE（0 次整文件复核）；增量模型 == 从零全量模型。
 *  A3 W1 封板判断前移：已封板组被触碰 → 0 次 xlsx 文件头读取、字节不变；草稿重写也不读文件头。
 *  A4 W3 bootstrap 预算：90 组按 40/40/10 三 tick 跑完；pending 状态前进、无重复处理；
 *     预算增量产物 == 从零全量产物（逐字节）。
 *  A5 W5 流式摘要 ＋ 月账视图：流式统计台账/补记/journal；月合计 = 台账行数（独立手算比对）；
 *     封板覆盖 = journal 事实；只读不改台账/周账/journal；内容指纹不变则不重写；删了可重建。
 *  A6 W5 大 journal 内存：~10 MB / 2500 事件的 journal 冷读，峰值增量远低于文件堆内存口径。
 *  B  **滚动正确性反证（c01-lab 副本）**：首次建周账 → 追加新行 → 再跑 → 改一行原文 →
 *     每一步都与"从零全量重算"的产物逐字节比对；已封板周账 xlsx 全程 0 变化。
 *
 * 用法：
 *   node docs\自测-weekly-滚动.mjs
 *   node docs\自测-weekly-滚动.mjs --lab="C:\...\_工作\p3-lab\c01-lab\root"
 *   （B 段默认找 `<仓库>\..\p3-lab\c01-lab\root`；找不到则 skip 并提示先复制 c01-lab）
 *
 * 纪律：只写临时目录 + 指定的 p3-lab 副本；**永不修改 `_工作\c01-lab`**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const weekly = await mod('lib/weekly.js');
const { readAll, readState, writeState } = await mod('lib/ledger.js');
const { weekOf } = await mod('lib/week.js');
const { originalRelPath } = await mod('lib/original.js');

const {
  groupRecords, writeWeekly, buildWeeklyModel,
  readWeeklySeals, readSealJournalState, readSealEvidence,
  appendWeeklySealEvent, writeSupplement,
  runWeeklyBudget, loadWeeklyCatchup,
  buildMonthlyView, writeMonthlyView, monthlyViewPath,
  weeklyRuntimeStats, resetWeeklyCaches, resetWeeklyRowCache, resetWeeklyRuntimeStats,
  LAYOUT_VERSION, MONTHLY_GENERATOR, MONTHLY_VIEW_VERSION,
} = weekly;

const TMP_ROOTS = [];
function lab(tag = 'wk-roll-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  TMP_ROOTS.push(dir);
  return { dir, root: path.join(dir, 'root') };
}
process.on('exit', () => {
  for (const d of TMP_ROOTS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

const sha256buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256file = (p) => sha256buf(fs.readFileSync(p));
function stats() { return weeklyRuntimeStats(); }
function delta(a, b, key) { return (b[key] || 0) - (a[key] || 0); }

const KEY = '75238718e41aA';
/** 造一条台账记录；`prefix` 12 位小写字母数字 → sessKey = prefix + 'A'。 */
function mk(prefix, n, ts, extra = {}) {
  return {
    v: 3,
    code: `20261108-${prefix}-A-${String(n).padStart(8, '0')}`,
    ts,
    sid: `session-${prefix}`,
    turn: n,
    seq: n,
    status: 'ok',
    ...extra,
  };
}

/** 造"可复核"的完整原文 + 附件，返回台账行应带的绑定三字段（与自测-周记账封板同口径）。 */
function putVerifiedOriginal(root, code, ts) {
  const w = weekOf(Date.parse(ts), 480);
  const rel = originalRelPath(w.year, w.month, code);
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = `## 1. user/message\n\n[seq 1] 10:00\n\n自测正文 ${code}\n`;
  const bodyHash = sha256buf(Buffer.from(body, 'utf8'));
  const markdown = `---\n编码: '${code}'\n名称: '${code} 完整原文'\n正文hash: '${bodyHash}'\n---\n\n# ${code} 完整原文\n\n${body}`;
  fs.writeFileSync(abs, markdown, 'utf8');
  const attName = `${code} 原始事件.json`;
  const attBuf = Buffer.from(JSON.stringify({ code, events: [], note: 'weekly-roll-selftest' }), 'utf8');
  fs.writeFileSync(path.join(path.dirname(abs), attName), attBuf);
  return {
    doc: rel,
    docHash: bodyHash,
    docSha256: bodyHash,
    docFileSha256: sha256buf(Buffer.from(markdown, 'utf8')),
    attachment: { name: attName, sha256: sha256buf(attBuf), bytes: attBuf.length },
  };
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  for (const r of rows) text += JSON.stringify(r) + '\n';
  let prev = '';
  try { prev = fs.readFileSync(file, 'utf8'); } catch { prev = ''; }
  if (prev && !prev.endsWith('\n')) text = '\n' + text;
  fs.appendFileSync(file, text, 'utf8');
}

/** 遍历 root，按后缀收集文件 sha256（用于"台账/已封板周账/journal 一个字节不改"断言）。 */
function snapshotFiles(root, filter) {
  const out = {};
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (filter(p)) out[path.relative(root, p)] = { sha: sha256file(p), size: fs.statSync(p).size };
    }
  };
  walk(root);
  return out;
}
const snapSealed = (root) => snapshotFiles(root, (p) => p.endsWith('.xlsx') && !path.basename(p).startsWith('草稿-'));
const snapLedger = (root) => snapshotFiles(root, (p) => p.includes(`${path.sep}ledger${path.sep}`) && p.endsWith('.jsonl') && !path.basename(p).startsWith('.'));
const snapLedgerAll = (root) => snapshotFiles(root, (p) => p.includes(`${path.sep}ledger${path.sep}`) && p.endsWith('.jsonl'));
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const GEN = '2026-11-13 20:00:00'; // 固定生成时间 → xlsx 字节可复现

function assertRssBudget(label) {
  const rss = process.memoryUsage().rss;
  assert.ok(rss < 500 * 1024 * 1024, `${label}: RSS ${Math.round(rss / 1048576)} MiB 超 500 MiB 预算`);
}

// ===========================================================================
// A1. W1 journal 尾读缓存（+ 两条读法一致性 + 缩水/替换整读）
// ===========================================================================
test('A1 W1：journal 冷读整读一次，稳态只读新增尾；缩水/替换→整读重建', () => {
  const { root } = lab();
  resetWeeklyCaches();
  const addSeal = (gid, rows = 1) => {
    const m = /^(\d{4})-(\d+)-(\d+)\|(.+)$/.exec(gid);
    appendWeeklySealEvent(root, {
      gid,
      file: `${m[1]}年${String(m[2]).padStart(2, '0')}月/x.xlsx`,
      sealedAt: '2026-11-13 12:00:00',
      layout: LAYOUT_VERSION,
      sourceRowCount: rows,
      overflow: 0,
      rows: Array.from({ length: rows }, (_, i) => [`20261108-aaaaaaaaaaaa-A-${String(i + 1).padStart(8, '0')}`, '绑定', '10:00', '已完成']),
      rowCount: rows,
      sealHash: 'a'.repeat(64),
      sessKey: m[4], year: Number(m[1]), month: Number(m[2]), weekNo: Number(m[3]),
      offsetMinutes: 480,
    });
  };
  addSeal('2026-11-2|75238718e41aA', 3);
  addSeal('2026-11-2|bbbbbbbbbbbbA', 2);
  addSeal('2026-11-3|ccccccccccccA', 1);
  const journalPath = path.join(root, 'ledger', '.seal-journal.jsonl');
  const journalSize = fs.statSync(journalPath).size;

  // 冷读（缓存被 resetWeeklyCaches 清空）→ 整读一次
  let s0 = stats();
  const seals1 = readWeeklySeals(root);
  let s1 = stats();
  assert.equal(Object.keys(seals1).length, 3);
  assert.equal(seals1['2026-11-2|75238718e41aA'].rows, 3, '摘要里必须保留行数');
  assert.equal(seals1['2026-11-2|75238718e41aA'].source, 'journal');
  assert.equal(delta(s0, s1, 'journalFullReads'), 1, '冷读必须整读一次');
  assert.ok(delta(s0, s1, 'journalBytesRead') >= journalSize, `冷读字节 ${delta(s0, s1, 'journalBytesRead')} 应 ≥ journal ${journalSize}`);

  // 稳态：size/mtime 没变 → 0 字节解析
  s0 = stats();
  const seals2 = readWeeklySeals(root);
  s1 = stats();
  assert.equal(Object.keys(seals2).length, 3);
  assert.equal(delta(s0, s1, 'journalFullReads'), 0);
  assert.equal(delta(s0, s1, 'journalTailReads'), 0);
  assert.equal(delta(s0, s1, 'journalTailBytes'), 0, '稳态不得再读 journal 数据字节');

  // 追加 1 条封板 → 只解析新增字节
  addSeal('2026-11-3|ddddddddddddA', 1);
  const sizeAfter = fs.statSync(journalPath).size;
  s0 = stats();
  const seals3 = readWeeklySeals(root);
  s1 = stats();
  assert.equal(Object.keys(seals3).length, 4);
  assert.equal(delta(s0, s1, 'journalTailReads'), 1, '追加必须走增量尾读');
  assert.equal(delta(s0, s1, 'journalFullReads'), 0, '追加不得整读');
  assert.ok(delta(s0, s1, 'journalTailBytes') > 0, '尾读字节必须 > 0');
  assert.ok(delta(s0, s1, 'journalTailBytes') <= sizeAfter, '尾读字节不可能超过整本');

  // 两条读法一致：readSealJournalState / readSealEvidence / readWeeklySeals
  const js = readSealJournalState(root);
  assert.equal(js.events.length, 4);
  assert.equal(js.badLines, 0);
  assert.equal(js.readError, '');
  assert.equal(js.events.every((e) => e.rows === undefined), true, 'W5：摘要事件不得保留 rows 快照');
  assert.equal(js.events.every((e) => Number.isFinite(e.rowCount)), true);
  assert.equal(js.events.some((e) => e.key === '2026-11-3|ddddddddddddA'), true);
  const ev = readSealEvidence(root);
  assert.equal(ev.journal.events, 4);
  assert.equal(ev.chain.ok, true);
  assert.equal(ev.conflicts.length, 0);
  assert.equal(ev.seals['2026-11-3|ddddddddddddA'].sealHash, 'a'.repeat(64));

  // 文件缩水（半行）→ 判定被替换 → 整读重建（坏行计数，不抛）
  const fullBytes = fs.readFileSync(journalPath);
  fs.writeFileSync(journalPath, fullBytes.subarray(0, Math.max(1, Math.floor(fullBytes.length / 2))));
  s0 = stats();
  const sealsShrunk = readWeeklySeals(root);
  s1 = stats();
  assert.equal(delta(s0, s1, 'journalFullReads'), 1, '缩水必须整读重建');
  assert.ok(Object.keys(sealsShrunk).length < 4, '截断后封板数应变少（读到哪算哪）');
  const jsShrunk = readSealJournalState(root);
  assert.ok(jsShrunk.badLines >= 0);

  // 整本被替换（长度/内容都不同）→ 头指纹不匹配 → 整读重建
  const replacement = JSON.stringify({
    v: 1, kind: 'weekly-seal', key: '2026-11-4|zzzzzzzzzzzzA', gid: '2026-11-4|zzzzzzzzzzzzA',
    file: 'x.xlsx', sealedAt: '2026-11-13 12:00:00', layoutVersion: LAYOUT_VERSION,
    canonicalVersion: 8, sourceRowCount: 1, overflow: 0, rowCount: 1,
    rowsSha256: 'a'.repeat(64), rows: [['20261108-aaaaaaaaaaaa-A-00000001', '缺凭证', '10:00', '待确认']],
    supplementCodesSha256: 'b'.repeat(64), supplement: null,
    sealHash: 'c'.repeat(64), prevSealSha256: '', at: '2026-11-13 12:00:00',
  }) + '\n';
  fs.writeFileSync(journalPath, replacement);
  s0 = stats();
  const sealsReplaced = readWeeklySeals(root);
  s1 = stats();
  assert.equal(delta(s0, s1, 'journalFullReads'), 1, '整本被替换必须整读（头指纹不匹配）');
  assert.deepEqual(Object.keys(sealsReplaced), ['2026-11-4|zzzzzzzzzzzzA']);
  assert.equal(sealsReplaced['2026-11-4|zzzzzzzzzzzzA'].sealHash, 'c'.repeat(64));
  assertRssBudget('A1');
});

// ===========================================================================
// A2. W2 只看新行 / W4 hash 剪枝（行身份复用 + re1 DOC_VERIFY_CACHE）
// ===========================================================================
test('A2 W2/W4：行身份未变→0 次 resolveDoc；原文被改→只重算 1 行；清行缓存后仍 0 次整文件复核', () => {
  const { root } = lab();
  resetWeeklyCaches();
  const recs = [];
  for (let n = 1; n <= 5; n += 1) {
    const ts = `2026-11-02T${String(9 + n).padStart(2, '0')}:00:00+08:00`;
    const rec = mk('75238718e41a', n, ts);
    Object.assign(rec, putVerifiedOriginal(root, rec.code, ts));
    recs.push(rec);
  }
  const g = [...groupRecords(recs, 480).values()][0];
  const base = { root, w: g.w, sessKey: g.sessKey, offsetMinutes: 480, generatedAt: GEN };

  resetWeeklyCaches();
  const first = writeWeekly({ ...base, records: g.records, mode: 'draft' });
  assert.equal(first.written, true);
  let hashes = { [first.groupId]: first.hash };
  let s0 = stats();
  assert.equal(s0.rowResolved, 5);
  const coldDocFull = s0.docFull;
  assert.equal(coldDocFull, 5, '首次必须真复核 5 份原文');

  // 只重跑（无新行）→ 5 行全部复用；不碰 resolveDoc/verifyOriginal
  s0 = stats();
  const again = writeWeekly({ ...base, records: g.records, prevHashes: hashes, mode: 'draft' });
  let s1 = stats();
  assert.equal(again.written, false);
  assert.equal(again.reason, 'unchanged');
  assert.equal(delta(s0, s1, 'rowSeen'), 5);
  assert.equal(delta(s0, s1, 'rowReused'), 5, 'W2：无新行必须 5 行全部复用');
  assert.equal(delta(s0, s1, 'rowResolved'), 0, 'W2：无新行不得重算任何一行');
  assert.equal(delta(s0, s1, 'docFull'), 0, 'W4：不得重复整文件复核');

  // 新增 1 行 → 只重算 1 行（+ 1 次真复核）
  const ts6 = '2026-11-02T15:00:00+08:00';
  const rec6 = mk('75238718e41a', 6, ts6);
  const recs6 = [...g.records, rec6];
  s0 = stats();
  const addOne = writeWeekly({ ...base, records: recs6, prevHashes: hashes, mode: 'draft' });
  s1 = stats();
  assert.equal(addOne.written, true);
  assert.equal(delta(s0, s1, 'rowSeen'), 6);
  assert.equal(delta(s0, s1, 'rowReused'), 5, 'W2：新增 1 行 → 其余 5 行复用');
  assert.equal(delta(s0, s1, 'rowResolved'), 1, 'W2：只处理新增行');
  hashes = { [addOne.groupId]: addOne.hash };
  const bytesAfterAdd = fs.readFileSync(addOne.path);

  // 清空"行级复用缓存"但保留 DOC_VERIFY_CACHE → resolveDoc 会跑，但复核走缓存（W4 反证）
  resetWeeklyRowCache();
  const docFullBefore = stats().docFull;
  const docCachedBefore = stats().docCached;
  const forced = writeWeekly({ ...base, records: recs6, prevHashes: hashes, force: true, mode: 'draft' });
  assert.equal(forced.written, true);
  assert.equal(stats().docFull - docFullBefore, 0, 'W4：清行缓存后仍不得整文件复核');
  assert.equal(stats().docCached - docCachedBefore, 5, 'W4：5 个带凭证的行都应命中 re1 的 DOC_VERIFY_CACHE');
  assert.deepEqual(fs.readFileSync(forced.path), bytesAfterAdd, '同一份数据 → xlsx 字节必须一致');

  // 改一行原文（追加一个字节）→ 只有这一行重算，且四态从"绑定"变"缺凭证"
  const target = recs6[0];
  const abs = path.join(root, target.doc);
  fs.appendFileSync(abs, '\n（自测：原文被改）\n', 'utf8');
  s0 = stats();
  const afterTamper = writeWeekly({ ...base, records: recs6, prevHashes: hashes, mode: 'draft' });
  s1 = stats();
  assert.equal(afterTamper.written, true);
  assert.notEqual(afterTamper.hash, hashes[first.groupId]);
  assert.equal(delta(s0, s1, 'rowReused'), 5, 'W2：只改 1 行原文 → 其余 5 行复用');
  assert.equal(delta(s0, s1, 'rowResolved'), 1, 'W2：只重算被改的那一行');
  const tamperText = fs.readFileSync(afterTamper.path, 'utf8');
  assert.ok(tamperText.includes('缺凭证'), '被改原文的行必须落「缺凭证」');
  const tamperModel = buildWeeklyModel({ ...base, records: recs6 });
  const tamperEntry = tamperModel.days.flatMap((d) => d.entries).find((e) => e.code === target.code);
  assert.equal(tamperEntry.original, '缺凭证', '被改原文的那一行四态必须变为「缺凭证」');
  hashes = { [afterTamper.groupId]: afterTamper.hash };

  // 增量（复用缓存）模型 == 从零全量模型：byte 级 + 字段级
  const warmModel = buildWeeklyModel({ ...base, records: recs6 });
  resetWeeklyCaches();
  const coldModel = buildWeeklyModel({ ...base, records: recs6 });
  assert.equal(JSON.stringify(warmModel.sheets), JSON.stringify(coldModel.sheets), 'W2：缓存不得改变任何单元格');
  assert.equal(warmModel.hash, coldModel.hash);
  assert.equal(warmModel.sealHash, coldModel.sealHash);
  assert.equal(warmModel.total, coldModel.total);
  // 清缓存后强制重写 → 字节一致（同一份数据可复现）
  const rewrite = writeWeekly({ ...base, records: recs6, force: true, mode: 'draft' });
  assert.deepEqual(fs.readFileSync(rewrite.path), fs.readFileSync(afterTamper.path), 'W2/W4：增量产物 == 全量产物（逐字节）');
  assertRssBudget('A2');
});

// ===========================================================================
// A3. W1 封板判断前移：已封板组 0 次 xlsx 文件头读取
// ===========================================================================
test('A3 W1：已封板组被触碰→0 次 xlsx 文件头读取、字节不变；草稿重写也不读文件头', () => {
  const { root } = lab();
  resetWeeklyCaches();
  const recs = [mk('75238718e41a', 1, '2026-11-02T09:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const base = { root, w: g.w, sessKey: g.sessKey, offsetMinutes: 480, generatedAt: GEN };
  const sealed = writeWeekly({ ...base, records: g.records, mode: 'sealed', sealedAt: '2026-11-13 12:00:00' });
  assert.equal(sealed.written, true);
  const bytes = fs.readFileSync(sealed.path);
  const journalBytes = fs.readFileSync(path.join(root, 'ledger', '.seal-journal.jsonl'));
  // 预热 journal 缓存（第一次读会整读；之后每次被触碰都只 stat）
  readWeeklySeals(root);

  let s0 = stats();
  const again = writeWeekly({ ...base, records: [...g.records, mk('75238718e41a', 2, '2026-11-02T10:00:00+08:00')], mode: 'draft' });
  let s1 = stats();
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'sealed');
  assert.equal(delta(s0, s1, 'markerReads'), 0, 'W1：已封板组不得读 xlsx 文件头');
  assert.equal(delta(s0, s1, 'markerBytes'), 0);
  assert.deepEqual(fs.readFileSync(sealed.path), bytes, '封板后字节不许变');
  assert.deepEqual(fs.readFileSync(path.join(root, 'ledger', '.seal-journal.jsonl')), journalBytes, 'journal 不许变');

  // state 丢失（journal 仍在）：封板判断仍只靠 journal —— 0 次文件头读取
  fs.rmSync(path.join(root, 'ledger', '.state.json'), { force: true });
  s0 = stats();
  const lost = writeWeekly({ ...base, records: g.records, mode: 'draft' });
  s1 = stats();
  assert.equal(lost.reason, 'sealed');
  assert.equal(delta(s0, s1, 'markerReads'), 0, 'W1：state 丢失也不该退化成整读 xlsx');
  assert.deepEqual(fs.readFileSync(sealed.path), bytes);

  // 草稿重写：也不读草稿/正式文件头（文件头只在判 E_SEAL_UNKNOWN 时才按需读）
  const { root: root2 } = lab();
  resetWeeklyCaches();
  const dRecs = [mk('aaaaaaaaaaaa', 1, '2026-11-03T09:00:00+08:00')];
  const gd = [...groupRecords(dRecs, 480).values()][0];
  const b2 = { root: root2, w: gd.w, sessKey: gd.sessKey, offsetMinutes: 480, generatedAt: GEN };
  const d1 = writeWeekly({ ...b2, records: gd.records, mode: 'draft' });
  s0 = stats();
  const d2 = writeWeekly({ ...b2, records: [...gd.records, mk('aaaaaaaaaaaa', 2, '2026-11-03T10:00:00+08:00')], prevHashes: { [d1.groupId]: d1.hash }, mode: 'draft' });
  s1 = stats();
  assert.equal(d2.written, true);
  assert.equal(delta(s0, s1, 'markerReads'), 0, '草稿重写不需要读文件头');

  // 同一份数据两种写法的产物必须逐字节一致（可复现）
  const { root: root3 } = lab();
  const d3 = writeWeekly({ root: root3, w: gd.w, sessKey: gd.sessKey, records: [...gd.records, mk('aaaaaaaaaaaa', 2, '2026-11-03T10:00:00+08:00')], mode: 'draft', generatedAt: GEN });
  assert.deepEqual(fs.readFileSync(d3.path), fs.readFileSync(d2.path), '同一份数据 → xlsx 逐字节可复现');
  assertRssBudget('A3');
});

// ===========================================================================
// A4. W3 bootstrap 预算：分批跑 + 续跑状态 + 无重复 + 产物与全量一致
// ===========================================================================
test('A4 W3：bootstrap 预算 40/40/10 三 tick；续跑状态正确；预算产物 == 全量产物', () => {
  const { root } = lab();
  const allRecords = [];
  for (let i = 0; i < 90; i += 1) {
    const prefix = `p${String(i).padStart(11, '0')}`; // 12 位 → sessKey = prefix + A
    // 用"还没到封板宽限"的周（2026-12 第 2 周，宽限到 12-16）→ 自动模式只会写草稿
    const ts = `2026-12-07T09:${String(i % 60).padStart(2, '0')}:00+08:00`;
    allRecords.push(mk(prefix, 1, ts), mk(prefix, 2, `2026-12-07T10:${String(i % 60).padStart(2, '0')}:00+08:00`));
  }
  const groups = groupRecords(allRecords, 480);
  assert.equal(groups.size, 90);
  resetWeeklyCaches();
  writeState(root, { sentinelKeep: 'must-survive' });
  const hashes = {};
  const collected = [];
  const ticks = [];
  for (let t = 0; t < 3; t += 1) {
    const res = runWeeklyBudget({
      root, groups, bootstrap: true, prevHashes: hashes,
      budgetGroups: 40, budgetMs: 60000, generatedAt: GEN,
    });
    ticks.push(res.stats);
    collected.push(...res.processed);
    if (t < 2) {
      const cu = loadWeeklyCatchup(root);
      assert.ok(cu, `第 ${t + 1} tick 后必须留下续跑状态`);
      assert.equal(cu.pending.length, res.deferred.length);
      assert.equal(res.deferred.length, t === 0 ? 50 : 10);
      assert.equal(res.weeklyDeferred, res.deferred.length, 'weeklyDeferred 必须如实上报');
    }
  }
  assert.equal(collected.length, 90, '三 tick 必须覆盖全部 90 组');
  assert.equal(new Set(collected).size, 90, 'W3：任何组不得被处理两次');
  assert.equal(loadWeeklyCatchup(root), null, '跑完后续跑状态必须清空');
  assert.equal(readState(root).sentinelKeep, 'must-survive', '预算状态不得清掉 state 里的其它键');
  assert.equal(ticks[0].processedGroups, 40);
  assert.equal(ticks[1].processedGroups, 40);
  assert.equal(ticks[2].processedGroups, 10);

  // 每组恰好一本草稿；与"从零全量"逐字节一致
  const { root: fullRoot } = lab();
  let compared = 0;
  for (const gid of [...groups.keys()].sort()) {
    const g = groups.get(gid);
    const incPath = path.join(root, '2026年12月', `草稿-12月第2周-${g.sessKey}的周记账.xlsx`);
    assert.equal(fs.existsSync(incPath), true, `预算组缺草稿: ${gid}`);
    const full = writeWeekly({ root: fullRoot, w: g.w, sessKey: g.sessKey, records: g.records, generatedAt: GEN });
    assert.deepEqual(fs.readFileSync(incPath), fs.readFileSync(full.path), `预算 vs 全量字节不一致: ${gid}`);
    compared += 1;
  }
  assert.equal(compared, 90);
  assertRssBudget('A4');
});

// ===========================================================================
// A5. W5 流式摘要 + 月账视图（派生、只读、可重建、字节确定）
// ===========================================================================
test('A5 W5/月账：流式统计 + 月合计=台账行数（独立手算）+ 只读不改 + 指纹幂等 + 可重建', () => {
  const { root } = lab();
  resetWeeklyCaches();
  const month = { year: 2026, month: 10 };
  const dayFile = (d) => path.join(root, 'ledger', `2026-10-${String(d).padStart(2, '0')}.jsonl`);
  const records = [];
  const push = (prefix, n, ts, day, extra = {}) => {
    const rec = mk(prefix, n, ts, extra);
    records.push(rec);
    writeJsonl(dayFile(day), [rec]);
    return rec;
  };
  // 第 1 周（10-01..04）：2 行 / 1 会话（未封板）
  push('aaaaaaaaaaaa', 1, '2026-10-02T09:00:00+08:00', 2);
  push('aaaaaaaaaaaa', 2, '2026-10-03T09:00:00+08:00', 3);
  // 第 2 周（10-05..11）：3 行 / 2 会话（其中 1 组封板）
  const b1 = push('bbbbbbbbbbbb', 1, '2026-10-06T09:00:00+08:00', 6);
  const b2 = push('bbbbbbbbbbbb', 2, '2026-10-07T09:00:00+08:00', 7);
  push('eeeeeeeeeeee', 1, '2026-10-08T09:00:00+08:00', 8);
  // 第 3 周（10-12..18）：2 行 / 1 会话（封板）
  const c1 = push('cccccccccccc', 1, '2026-10-13T09:00:00+08:00', 13);
  const c2 = push('cccccccccccc', 2, '2026-10-14T09:00:00+08:00', 14);
  // 第 3 周：另 1 会话 2 行（未封板）
  push('dddddddddddd', 1, '2026-10-15T09:00:00+08:00', 15);
  push('dddddddddddd', 2, '2026-10-16T09:00:00+08:00', 16);
  // 跨月行（在 10 月日账里但 ts 属于 11 月）→ 不得计入 10 月
  push('ffffffffffff', 1, '2026-11-01T00:30:00+08:00', 31);
  // 封板两组
  const sealGroup = (list, wk) => {
    const g = [...groupRecords(list, 480).values()].find((x) => x.w.month === 10 && x.w.weekNo === wk);
    return writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: g.records, mode: 'sealed', generatedAt: GEN, sealedAt: '2026-11-13 12:00:00' });
  };
  const sealedB = sealGroup([b1, b2], 2);
  const sealedC = sealGroup([c1, c2], 3);
  assert.equal(sealedB.sealed, true);
  assert.equal(sealedC.sealed, true);
  // 补记册：3 条属于 10 月（第2/3周）+ 1 条属于 9 月（不计入）
  const suppRec = (prefix, n, ts) => mk(prefix, n, ts);
  writeSupplement({
    root,
    records: [suppRec('bbbbbbbbbbbb', 9, '2026-10-09T09:00:00+08:00'),
      suppRec('cccccccccccc', 9, '2026-10-12T09:00:00+08:00'),
      suppRec('dddddddddddd', 9, '2026-10-15T09:00:00+08:00'),
      suppRec('999999999999', 9, '2026-09-20T09:00:00+08:00')],
    generatedAt: '2026-11-13 09:00:00',
  });

  // ── 独立手算（不经过 monthly 代码路径）──
  const all = readAll(root, { repairTornTail: false });
  const octRows = all.records.filter((r) => {
    const w = weekOf(Date.parse(r.ts), 480);
    return w.year === 2026 && w.month === 10;
  });
  const expectedWeekRows = new Map();
  for (const r of octRows) {
    const w = weekOf(Date.parse(r.ts), 480);
    expectedWeekRows.set(w.weekNo, (expectedWeekRows.get(w.weekNo) || 0) + 1);
  }
  const expectedGroups = new Set(octRows.map((r) => {
    const w = weekOf(Date.parse(r.ts), 480);
    return `${w.weekNo}|${r.code.slice(9, 21)}A`;
  }));
  const suppText = fs.readFileSync(path.join(root, '补记-20261113.md'), 'utf8');
  const suppOct = (suppText.match(/- 所属正册: 2026年10月\//g) || []).length;

  const ledgerBefore = snapLedgerAll(root);
  const sealedBefore = snapSealed(root);
  resetWeeklyRuntimeStats();
  const mv = writeMonthlyView({
    root, year: month.year, month: month.month, generatedAt: GEN,
    nowMs: Date.parse('2026-11-13T20:00:00+08:00'),
  });
  assert.equal(mv.written, true);
  assert.equal(mv.path, path.join(root, '2026年10月', '10月账.md'));
  assert.equal(mv.path, monthlyViewPath(root, 2026, 10));
  assert.equal(mv.summary.monthLabel, '2026年10月');
  assert.equal(mv.summary.ledger.rows, octRows.length, '月合计必须等于当月台账行数');
  assert.equal(mv.summary.totals.rows, octRows.length);
  assert.equal(mv.summary.totals.groups, expectedGroups.size);
  assert.equal(mv.summary.totals.sealedGroups, 2, '当天应识别 2 个已封板组');
  assert.equal(mv.summary.totals.unsealedGroups, expectedGroups.size - 2);
  assert.equal(mv.summary.totals.supplementEntries, suppOct);
  assert.equal(suppOct, 3);
  assert.equal(mv.summary.ledger.outOfMonth, 1, '跨月行必须如实计数且不计入本月');
  for (const w of mv.summary.weeks) {
    assert.equal(w.rows, expectedWeekRows.get(w.weekNo) || 0, `第 ${w.weekNo} 周小计必须吻合手算`);
  }
  assert.equal(mv.summary.frozen, true, '2026-11-13 已过 10 月末+3 天宽限 → 应已冻结');
  assert.equal(mv.content.includes(MONTHLY_GENERATOR), true);
  assert.equal(mv.content.includes(`v${MONTHLY_VIEW_VERSION}`), true);
  assert.equal(mv.content.includes('内容指纹: ' + mv.fingerprint), true);
  assert.equal(mv.content.includes('已冻结'), true, '2026-11-13 已过 10 月末+3 天宽限 → 标记已冻结');
  assert.equal(stats().markerReads, 0, '月账只读封板事实，不打开 xlsx 文件头');
  assert.equal(sameSnap(ledgerBefore, snapLedgerAll(root)), true, '月账不得修改台账');
  assert.equal(sameSnap(sealedBefore, snapSealed(root)), true, '月账不得修改已封板周账');

  // 指纹不变 → 不重写（即使生成时间不同）
  const beforeMtime = fs.statSync(mv.path).mtimeMs;
  const mv2 = writeMonthlyView({
    root, year: 2026, month: 10, generatedAt: '2026-11-14 08:00:00',
    nowMs: Date.parse('2026-11-14T08:00:00+08:00'),
  });
  assert.equal(mv2.written, false);
  assert.equal(mv2.reason, 'unchanged');
  assert.equal(fs.statSync(mv.path).mtimeMs, beforeMtime, '内容指纹不变不得重写');

  // 可重建：删掉后同参数重生成 → 字节完全一致
  const bytes = fs.readFileSync(mv.path);
  fs.rmSync(mv.path);
  const mv3 = writeMonthlyView({
    root, year: 2026, month: 10, generatedAt: GEN,
    nowMs: Date.parse('2026-11-13T20:00:00+08:00'),
  });
  assert.equal(mv3.written, true);
  assert.deepEqual(fs.readFileSync(mv3.path), bytes, '删了可重建，且同参数逐字节一致');

  // buildMonthlyView 与 writeMonthlyView 内容一致（纯函数可测）
  const built = buildMonthlyView({
    root, year: 2026, month: 10, generatedAt: GEN,
    nowMs: Date.parse('2026-11-13T20:00:00+08:00'),
  });
  assert.equal(built.content, fs.readFileSync(mv.path, 'utf8'));
  assert.equal(built.fingerprint, mv.fingerprint);
  assertRssBudget('A5');
});

// ===========================================================================
// A6. W5 journal 大文件流式：内存有界（约 10 MB / 2500 事件）
// ===========================================================================
test('A6 W5：~10 MB journal 流式冷读，内存增量有界、块大小有界、摘要不保留 rows', () => {
  const { root } = lab();
  const ledgerDir = path.join(root, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const jp = path.join(ledgerDir, '.seal-journal.jsonl');
  const rows = Array.from({ length: 120 }, (_, i) => [
    `20260101-aaaaaaaaaaaa-A-${String(i + 1).padStart(8, '0')}`, '绑定', '10:00', '已完成',
  ]);
  const EVENT_N = 2500;
  let chunk = '';
  for (let i = 0; i < EVENT_N; i += 1) {
    chunk += JSON.stringify({
      v: 1, kind: 'weekly-seal', key: `2026-01-1|s${String(i).padStart(11, '0')}A`,
      gid: `2026-01-1|s${String(i).padStart(11, '0')}A`, file: 'x.xlsx',
      sealedAt: '2026-11-13 12:00:00', layoutVersion: LAYOUT_VERSION, canonicalVersion: 8,
      sourceRowCount: 120, overflow: 0, rowCount: rows.length,
      rowsSha256: 'a'.repeat(64), rows, supplementCodesSha256: 'b'.repeat(64),
      supplement: null, sealHash: 'c'.repeat(64), prevSealSha256: '', at: '2026-11-13 12:00:00',
    }) + '\n';
    if (chunk.length > 2 * 1024 * 1024) { fs.appendFileSync(jp, chunk, 'utf8'); chunk = ''; }
  }
  if (chunk) fs.appendFileSync(jp, chunk, 'utf8');
  const fileSize = fs.statSync(jp).size;
  assert.ok(fileSize > 8 * 1024 * 1024, `journal 应足够大（实际 ${fileSize}）`);

  resetWeeklyCaches();
  const rss0 = process.memoryUsage().rss;
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const seals = readWeeklySeals(root);
  const elapsed = Date.now() - t0;
  const rss1 = process.memoryUsage().rss;
  const heap1 = process.memoryUsage().heapUsed;
  const s = stats();
  assert.equal(Object.keys(seals).length, EVENT_N);
  assert.equal(s.journalFullReads, 1);
  assert.ok(s.journalBytesRead >= fileSize, '整读字节数应 ≥ 文件大小');
  assert.ok(s.streamMaxChunkBytes <= 256 * 1024, `流式块应 ≤256 KiB（实际 ${s.streamMaxChunkBytes}）`);
  const js = readSealJournalState(root);
  assert.equal(js.events.length, EVENT_N);
  assert.equal(js.events.every((e) => e.rows === undefined), true, 'W5：rows 快照不进内存');
  assert.equal(js.events.every((e) => e.rowCount === 120), true);
  assert.ok(rss1 - rss0 < 300 * 1024 * 1024,
    `冷读 RSS 增量 ${Math.round((rss1 - rss0) / 1048576)} MiB 超过 300 MiB 上界`);
  assert.ok(heap1 - heap0 < 200 * 1024 * 1024,
    `冷读 heap 增量 ${Math.round((heap1 - heap0) / 1048576)} MiB 超过 200 MiB 上界`);
  assert.ok(elapsed < 30000, `冷读耗时 ${elapsed} ms 超 30 s`);

  // 追加 1 条 → 尾读只读新增字节
  fs.appendFileSync(jp, JSON.stringify({
    v: 1, kind: 'weekly-seal', key: '2026-01-1|t00000000001A', gid: '2026-01-1|t00000000001A',
    file: 'x.xlsx', sealedAt: '2026-11-13 12:00:00', layoutVersion: LAYOUT_VERSION,
    canonicalVersion: 8, sourceRowCount: 1, overflow: 0, rowCount: 1,
    rowsSha256: 'd'.repeat(64), rows: [], supplementCodesSha256: 'e'.repeat(64),
    supplement: null, sealHash: 'f'.repeat(64), prevSealSha256: '', at: '2026-11-13 12:00:00',
  }) + '\n', 'utf8');
  const before = stats();
  const seals2 = readWeeklySeals(root);
  const after = stats();
  assert.equal(Object.keys(seals2).length, EVENT_N + 1);
  assert.equal(delta(before, after, 'journalFullReads'), 0, '追加不得整读');
  assert.equal(delta(before, after, 'journalTailReads'), 1);
  assert.ok(delta(before, after, 'journalTailBytes') < 4096, '尾读字节应只有新增那条');
  assertRssBudget('A6');
});

// ===========================================================================
// B 的夹具：**自建 c01 等价库**（v1.0.0 整改：替代开发机 `..\p3-lab\c01-lab\root`）
//   · 3 个会话 → 3 个组（2 个落 10 月第 2 周、1 个落第 3 周）→ 用插件自己的写侧封板；
//   · 全部在 os.tmpdir() 里生成：不读、不写任何包外开发机目录（审计 P1-14 / P1-17）；
//   · 组 id 与 B 段既有断言一致（`2026-10-2|43198444938fA` 等），不靠"恰好有那份 p3-lab"。
// ===========================================================================
const SEED_SESSIONS = [
  { sessKey: '43198444938fA', ts: '2026-10-09T09:00:00+08:00' },
  { sessKey: 'd1db18734791A', ts: '2026-10-07T09:00:00+08:00' },
  { sessKey: '3b9ad92506f3A', ts: '2026-10-13T09:00:00+08:00' },
];
function buildRollSeedLab() {
  const seed = lab('wk-roll-seed-');
  const rows = [];
  for (const s of SEED_SESSIONS) {
    const prefix = s.sessKey.slice(0, 12);
    const day = s.ts.slice(0, 10);
    const rec = {
      v: 3,
      code: `${day.replace(/-/g, '')}-${prefix}-A-00000001`,
      ts: s.ts,
      sid: `session-${prefix}`,
      turn: 1, seq: 1, status: 'ok',
    };
    rows.push(rec);
    writeJsonl(path.join(seed.root, 'ledger', `${day}.jsonl`), [rec]);
  }
  const groups = groupRecords(rows, 480);
  const sealed = [];
  for (const [gid, g] of [...groups.entries()].sort()) {
    const res = writeWeekly({
      root: seed.root, w: g.w, sessKey: g.sessKey, records: g.records,
      generatedAt: GEN, mode: 'sealed',
      nowMs: Date.parse('2026-11-13T20:00:00+08:00'),
    });
    if (!res.written || !res.sealed) {
      throw new Error(`B 段夹具：封板失败 ${gid}（written=${res.written} sealed=${res.sealed} reason=${res.reason}）`);
    }
    sealed.push({ gid, hash: res.hash });
  }
  return { root: seed.root, sealed };
}

// ===========================================================================
// B. 滚动正确性反证（自建 c01 等价库，逐字节比对"增量 vs 从零全量"）
// ===========================================================================
const argLab = process.argv.find((a) => a.startsWith('--lab='))?.slice('--lab='.length);
const SEED_LAB = argLab ? null : buildRollSeedLab();
const LAB_ROOT = argLab ? path.resolve(argLab) : SEED_LAB.root;
const LAB_SKIP = false; // 夹具自足：B 段**永不 skip**（旧版找不到 p3-lab 就 skip，制造 1 条 skipped）

test('B 滚动正确性反证（自建 c01 等价库）：增量 == 从零全量，逐字节', () => {
  // 每次都从"传入的副本"再复制一份到临时目录，保证自测可重复、且连传入副本也不被改动
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-roll-lab-'));
  TMP_ROOTS.push(workDir);
  const root = path.join(workDir, 'root');
  fs.cpSync(LAB_ROOT, root, { recursive: true });
  sanitizeLabCopy(root);
  const evidence = { labSource: LAB_ROOT };
  resetWeeklyCaches();

  // ── 0) 准备：在副本 ledger 里追加"新会话 3 行（第 1 行带可复核原文）+ 已封板组 1 行" ──
  const newPrefix = 'cccccccccccc'; // 12 位
  const newSess = `${newPrefix}A`;
  // 代码日期段 = 会话开始日：这里必须与 ts 同月（否则 resolveDoc 的期望路径按编码月算 → PATH_MISMATCH）
  const mkNew = (n, ts) => ({
    v: 3,
    code: `20261016-${newPrefix}-A-${String(n).padStart(8, '0')}`,
    ts,
    sid: `session-${newPrefix}`,
    turn: n,
    seq: n,
    status: 'ok',
  });
  const bound = mkNew(1, '2026-10-16T09:00:00+08:00');
  Object.assign(bound, putVerifiedOriginal(root, bound.code, bound.ts));
  const newRecs = [
    bound,
    mkNew(2, '2026-10-16T10:00:00+08:00'),
    mkNew(3, '2026-10-16T11:00:00+08:00'),
  ];
  assert.equal(newSess, 'ccccccccccccA');
  const newDay = path.join(root, 'ledger', '2026-10-16.jsonl');
  writeJsonl(newDay, newRecs);
  const sealedExtra = { code: '20261009-43198444938f-A-00000007', ts: '2026-10-09T20:00:00+08:00', v: 3, sid: 'session-43198444-938f-4c49-8330-7da70f5dafbf', turn: 7, seq: 7, status: 'ok' };
  writeJsonl(path.join(root, 'ledger', '2026-10-09.jsonl'), [sealedExtra]);

  const sealedBefore = snapSealed(root);
  const ledgerBefore = snapLedgerAll(root);
  const journalPath = path.join(root, 'ledger', '.seal-journal.jsonl');
  const journalBefore = sha256file(journalPath);
  const stateBefore = readState(root);
  let hashes = { ...(stateBefore.weeklyHashes && typeof stateBefore.weeklyHashes === 'object' ? stateBefore.weeklyHashes : {}) };

  const readGroups = () => groupRecords(readAll(root, { repairTornTail: false }).records, 480);
  const runTick = (label) => {
    const groups = readGroups();
    const results = [];
    for (const gid of [...groups.keys()].sort()) {
      const g = groups.get(gid);
      const res = writeWeekly({
        root, w: g.w, sessKey: g.sessKey, records: g.records,
        offsetMinutes: 480, generatedAt: GEN, prevHashes: hashes, mode: 'draft',
      });
      if (!res.skipped && res.hash) hashes[res.groupId] = res.hash;
      results.push({ gid, res });
    }
    return { label, groups, results };
  };

  // ── 1) 首次建周账：3 个已封板组 skip + 新会话落草稿 ──
  const t1 = runTick('first-build');
  assert.equal(t1.groups.size, 4, '副本应有 3 个旧组 + 1 个新组');
  const t1ByGid = Object.fromEntries(t1.results.map((x) => [x.gid, x.res]));
  assert.equal(t1ByGid['2026-10-2|43198444938fA'].reason, 'sealed');
  assert.equal(t1ByGid['2026-10-2|d1db18734791A'].reason, 'sealed');
  assert.equal(t1ByGid['2026-10-3|3b9ad92506f3A'].reason, 'sealed');
  const newGid = '2026-10-3|ccccccccccccA';
  assert.equal(t1ByGid[newGid].written, true);
  assert.equal(t1ByGid[newGid].mode, 'draft');
  assert.equal(sameSnap(sealedBefore, snapSealed(root)), true, '首次建账不得改已封板 xlsx');
  assert.equal(sha256file(journalPath), journalBefore, '首次建账不得改 journal');
  const draftPath = t1ByGid[newGid].path;
  assert.equal(fs.existsSync(draftPath), true);
  const bytesPhase1 = fs.readFileSync(draftPath);
  const g1 = t1.groups.get(newGid);
  const model1 = buildWeeklyModel({
    root, w: g1.w, sessKey: g1.sessKey, records: g1.records, generatedAt: GEN, mode: 'draft',
  });
  const entry1 = model1.days.flatMap((d) => d.entries).find((e) => e.code === bound.code);
  assert.equal(entry1.original, '绑定', '新会话第 1 行原文可复核 → 应为「绑定」');
  evidence.phase1 = { groups: t1.groups.size, newGid, written: true, sealedSkipped: 3 };

  // ── 2) 无新行重跑：不重写、不读 xlsx 文件头 ──
  resetWeeklyRuntimeStats();
  const t2 = runTick('no-new-rows');
  const s2 = stats();
  assert.equal(t2.results.every((x) => x.res.written === false), true, '无新行时不允许重写');
  assert.equal(t2ByGidReason(t2, newGid), 'unchanged');
  assert.equal(s2.markerReads, 0, 'W1：已封板组不得读 xlsx；无变化草稿也不读');
  assert.deepEqual(fs.readFileSync(draftPath), bytesPhase1, '无新行 → 字节不变');
  evidence.phase2 = { skipped: t2.results.length, markerReads: s2.markerReads };

  // ── 3) 追加新行 → 只重算新行；产物 == 从零全量 ──
  writeJsonl(newDay, [
    mkNew(4, '2026-10-17T09:00:00+08:00'),
    mkNew(5, '2026-10-17T10:00:00+08:00'),
  ]);
  resetWeeklyRuntimeStats();
  const t3 = runTick('append-rows');
  const s3 = stats();
  const t3New = t3.results.find((x) => x.gid === newGid).res;
  assert.equal(t3New.written, true);
  assert.equal(s3.rowReused, 3, 'W2：已有 3 行复用');
  assert.equal(s3.rowResolved, 2, 'W2：只处理新增的 2 行');
  assert.equal(sha256file(journalPath), journalBefore, '追加行不得触发封板/journal 变化');
  assert.equal(sameSnap(sealedBefore, snapSealed(root)), true);
  const bytesPhase3 = fs.readFileSync(t3New.path);
  // 从零全量：把本组需要的原文/附件复制到全新 root，再用同一份记录写一遍
  const { root: fresh3 } = lab('wk-roll-full-');
  const g3 = readGroups().get(newGid);
  for (const r of g3.records) {
    if (!r.doc) continue;
    for (const rel of [r.doc, r.attachment && r.attachment.name
      ? path.join(path.dirname(r.doc), r.attachment.name) : null].filter(Boolean)) {
      const dst = path.join(fresh3, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(root, rel), dst);
    }
  }
  const full3 = writeWeekly({ root: fresh3, w: g3.w, sessKey: g3.sessKey, records: g3.records, generatedAt: GEN, mode: 'draft' });
  assert.deepEqual(fs.readFileSync(t3New.path), fs.readFileSync(full3.path), 'B：追加后 增量 == 从零全量（逐字节）');
  assert.equal(full3.hash, t3New.hash);
  evidence.phase3 = {
    incrementalBytes: bytesPhase3.length,
    incrementalSha: sha256file(t3New.path),
    fullSha: sha256file(full3.path),
    equalsFull: true,
    reused: s3.rowReused,
    resolved: s3.rowResolved,
  };

  // ── 4) 改一行原文 → 触发重算并反映；增量 == 从零全量 ──
  fs.appendFileSync(path.join(root, bound.doc), '\n（B 段反证：原文被改）\n', 'utf8');
  resetWeeklyRuntimeStats();
  const t4 = runTick('tamper-original');
  const s4 = stats();
  const t4New = t4.results.find((x) => x.gid === newGid).res;
  assert.equal(t4New.written, true, '改原文必须触发重写');
  assert.notEqual(t4New.hash, t3New.hash);
  assert.equal(s4.rowReused, 4, 'W2：5 行中只有被改的 1 行重算');
  assert.equal(s4.rowResolved, 1);
  const model4 = buildWeeklyModel({
    root, w: g3.w, sessKey: g3.sessKey, records: g3.records, generatedAt: GEN, mode: 'draft',
  });
  const entry4 = model4.days.flatMap((d) => d.entries).find((e) => e.code === bound.code);
  assert.equal(entry4.original, '缺凭证', '被改原文的行必须反映为「缺凭证」');
  assert.equal(sameSnap(sealedBefore, snapSealed(root)), true, '改原文不得动已封板 xlsx');
  const { root: fresh4 } = lab('wk-roll-full2-');
  for (const r of g3.records) {
    if (!r.doc) continue;
    for (const rel of [r.doc, r.attachment && r.attachment.name
      ? path.join(path.dirname(r.doc), r.attachment.name) : null].filter(Boolean)) {
      const dst = path.join(fresh4, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(root, rel), dst);
    }
  }
  // 注意：fresh4 复制的是**改动后**的原文，因此复现的是"改动后的全量结果"
  const full4 = writeWeekly({ root: fresh4, w: g3.w, sessKey: g3.sessKey, records: g3.records, generatedAt: GEN, mode: 'draft' });
  assert.deepEqual(fs.readFileSync(t4New.path), fs.readFileSync(full4.path), 'B：改原文后 增量 == 从零全量（逐字节）');
  evidence.phase4 = {
    changedHash: t4New.hash,
    incrementalSha: sha256file(t4New.path),
    fullSha: sha256file(full4.path),
    equalsFull: true,
    reused: s4.rowReused,
    resolved: s4.rowResolved,
  };

  // ── 5) 月账视图：手算对照 + 只读不改 + 可重建 ──
  const all = readAll(root, { repairTornTail: false });
  const octRows = all.records.filter((r) => {
    const w = weekOf(Date.parse(r.ts), 480);
    return w.year === 2026 && w.month === 10;
  });
  const monthGroups = new Set(octRows.map((r) => {
    const w = weekOf(Date.parse(r.ts), 480);
    return `${w.weekNo}|${r.code.slice(9, 21)}A`;
  }));
  const journalText = fs.readFileSync(journalPath, 'utf8');
  const sealedOct = journalText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'weekly-seal' && /^2026-10-\d+\|/.test(String(e.key))).length;

  const ledgerBeforeMonthly = snapLedgerAll(root);
  const sealedBeforeMonthly = snapSealed(root);
  resetWeeklyRuntimeStats();
  const mv = writeMonthlyView({
    root, year: 2026, month: 10, generatedAt: GEN,
    nowMs: Date.parse('2026-11-13T20:00:00+08:00'),
  });
  assert.equal(mv.written, true);
  assert.equal(mv.summary.totals.rows, octRows.length, 'B：月合计 = 当月台账行数');
  assert.equal(mv.summary.totals.groups, monthGroups.size);
  assert.equal(mv.summary.totals.sealedGroups, sealedOct);
  assert.equal(mv.summary.totals.unsealedGroups, monthGroups.size - sealedOct);
  assert.equal(stats().markerReads, 0, 'B：月账不打开 xlsx 文件头');
  assert.equal(sameSnap(ledgerBeforeMonthly, snapLedgerAll(root)), true, 'B：月账不得改台账');
  assert.equal(sameSnap(sealedBeforeMonthly, snapSealed(root)), true, 'B：月账不得改已封板周账');
  assert.equal(sha256file(journalPath), journalBefore, 'B：全程 journal 一个字节不改');
  const mvPath = mv.path;
  const mvBytes = fs.readFileSync(mvPath);
  fs.rmSync(mvPath);
  const mv2 = writeMonthlyView({
    root, year: 2026, month: 10, generatedAt: GEN,
    nowMs: Date.parse('2026-11-13T20:00:00+08:00'),
  });
  assert.deepEqual(fs.readFileSync(mv2.path), mvBytes, 'B：月账删了可重建（逐字节一致）');
  evidence.monthly = {
    path: path.relative(root, mvPath),
    rows: mv.summary.totals.rows,
    groups: mv.summary.totals.groups,
    sealed: mv.summary.totals.sealedGroups,
    unsealed: mv.summary.totals.unsealedGroups,
    fingerprint: mv.fingerprint,
  };
  evidence.ledgerRowsAtEnd = all.records.length;
  assertRssBudget('B');

  // 证据行（供交付报告引用；不影响断言）
  console.log('EVIDENCE-WEEKLY-ROLL ' + JSON.stringify(evidence));
});

function t2ByGidReason(t2, gid) {
  const hit = t2.results.find((x) => x.gid === gid);
  return hit && hit.res ? hit.res.reason : '';
}

/**
 * 把"上一轮自测在本副本里留下的痕迹"清掉（只清本自测使用的 code / 视图文件），
 * 这样同一份 p3-lab 副本可以反复跑，而不会因为"上次已写过草稿 + 无哈希"落到 state-lost。
 * 只动临时工作副本，不动传入的 LAB_ROOT，更不动 _工作\c01-lab。
 */
function sanitizeLabCopy(root) {
  const OUR_CODE = /^20261016-cccccccccccc-A-\d{8}$/;
  const EXTRA_CODE = '20261009-43198444938f-A-00000007';
  const NEW_GID = '2026-10-3|ccccccccccccA';
  const ledgerDir = path.join(root, 'ledger');
  let names = [];
  try { names = fs.readdirSync(ledgerDir); } catch { names = []; }
  for (const n of names) {
    if (!n.endsWith('.jsonl') || n.startsWith('.')) continue;
    const p = path.join(ledgerDir, n);
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const kept = text.split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const rec = JSON.parse(line);
        const code = String(rec && rec.code || '');
        if (OUR_CODE.test(code) || code === EXTRA_CODE) return false;
      } catch { /* 坏行原样保留 */ }
      return true;
    });
    if (kept.length === 0) { try { fs.rmSync(p); } catch { /* ignore */ } continue; }
    const next = kept.join('\n') + '\n';
    if (next !== text) fs.writeFileSync(p, next, 'utf8');
  }
  // 上一轮若曾在"自动模式"下把新组封板：清掉 journal 事件 + state 缓存（只清本自测的 gid）
  const jp = path.join(ledgerDir, '.seal-journal.jsonl');
  let jtext = '';
  try { jtext = fs.readFileSync(jp, 'utf8'); } catch { jtext = ''; }
  if (jtext) {
    const keptLines = jtext.split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const ev = JSON.parse(line);
        if (String(ev.key || ev.gid || '') === NEW_GID) return false;
      } catch { /* 坏行原样保留 */ }
      return true;
    });
    if (keptLines.length) fs.writeFileSync(jp, keptLines.join('\n') + '\n', 'utf8');
    else fs.rmSync(jp);
  }
  const sp = path.join(ledgerDir, '.state.json');
  try {
    const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
    let changed = false;
    for (const k of ['weeklySealed', 'weeklyHashes']) {
      if (st[k] && typeof st[k] === 'object' && Object.prototype.hasOwnProperty.call(st[k], NEW_GID)) {
        delete st[k][NEW_GID];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(sp, JSON.stringify(st, null, 2) + '\n', 'utf8');
  } catch { /* state 不存在/坏：不影响 */ }
  const monthDir = path.join(root, '2026年10月');
  for (const del of [
    path.join(monthDir, '10月账.md'),
    path.join(monthDir, '10月第3周-ccccccccccccA的周记账.xlsx'),
    path.join(monthDir, '草稿-10月第3周-ccccccccccccA的周记账.xlsx'),
  ]) {
    try { fs.rmSync(del); } catch { /* 不存在就跳过 */ }
  }
}
