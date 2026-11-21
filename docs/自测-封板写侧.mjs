/**
 * @file 自测-封板写侧.mjs
 * @role SEAL-01（v1.0.0-re，K-5 已签字）验收：`appendSealEvent` 追加路径 O(1)。
 *       守六件事：
 *         ① 幂等红线不变 —— 同一 (kind,key) 重复 append 仍 `already-sealed`，且**不写一个字节**；
 *         ② 落盘格式零变化 —— 一行一个 JSON、字段名/顺序/rows 快照不变、sealHash 口径不变；
 *         ③ 读取 API 不变 —— `readSealEvents()` 仍整读且返回同结构/顺序（append 路径不再用它）；
 *         ④ 尾读正确性 —— 别的进程追加的新事件只用"增量尾区"就能识别；
 *         ⑤ 失效重建 —— journal 被缩水/替换（inode/size/指纹变化）后索引重建，不读漏；
 *         ⑥ torn-tail —— 末尾半行：**先取证到 `.quarantine/` 再截断**（re3 K-6，与主账本同策略），
 *            半行不再被"补换行"留成永久坏行；中间坏行一律只报不修。
 *       另含 re3 可校验性加固（P2-8/9/10）：
 *         ⑦ journal 缺失三态（从未封板 / state 称已封板 / 存在但被清空）；
 *         ⑧ rowsSha256 缺失/null/非法 = 红；⑨ `at` 格式强校验且不污染后续时间基准。
 *       另含 `--bench` 微基准：合成 10 MB / 50 MB journal，实测 append 单次**读字节**与耗时
 *       （与 `_工作/tools/measure-tick.mjs` 同法：monkey-patch fs 计量）。
 *
 * 用法：
 *   node docs/自测-封板写侧.mjs                       # 功能自测（node:test）
 *   node docs/自测-封板写侧.mjs --bench               # 微基准：当前 lib/sealjournal.js
 *   node docs/自测-封板写侧.mjs --bench --impl=<path> --sizes=10,50 --rounds=3 --json
 *
 * 纪律：全部用 os.tmpdir() 临时 root，跑完删；不碰真实数据总库；不写产品文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SJ = await import(pathToFileURL(path.join(SRC, 'lib', 'sealjournal.js')).href);
const WK = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);

/** --bench 时只跑微基准（不注册功能自测，避免抢内存/时间）。 */
const BENCH = process.argv.includes('--bench');
const register = BENCH ? () => {} : test;

const journalPathOf = (root) => SJ.sealJournalPath(root);

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealjournal-write-'));
  return { dir, root: path.join(dir, 'root') };
}
function dispose(l) {
  try { fs.rmSync(l.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function readLines(root) {
  try {
    return fs.readFileSync(journalPathOf(root), 'utf8').split('\n').filter((x) => x.trim() !== '');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}
function fileBytes(root) { return fs.readFileSync(journalPathOf(root)); }
function append(root, key, extra = {}) {
  return SJ.appendSealEvent(root, {
    kind: 'weekly-seal',
    key,
    gid: key,
    file: `2026年11月/11月第1周-${key}的周记账.xlsx`,
    sealedAt: '2026-11-13 10:00:00',
    layoutVersion: 6,
    sourceRowCount: 1,
    overflow: 0,
    rows: [['20261113-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']],
    ...extra,
  });
}
/** 手工写 0.9.5 格式旧册（模拟升级前的 journal）。 */
function writeLegacyJournal(root, events) {
  const jp = journalPathOf(root);
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  const text = events.map((e) => JSON.stringify(e) + '\n').join('');
  fs.writeFileSync(jp, text, 'utf8');
  return jp;
}
const legacyEvent = (key, kind = 'weekly-seal') => ({
  v: 1,
  kind,
  key,
  gid: kind === 'weekly-seal' ? key : null,
  file: `${key}.xlsx`,
  sealedAt: '2026-11-08 10:00:00',
  layoutVersion: 6,
  canonicalVersion: 8,
  sourceRowCount: 0,
  overflow: 0,
  rowCount: 0,
  rowsSha256: SJ.sha256Hex('[]'),
  rows: [],
  supplementCodesSha256: SJ.supplementCodesSha256([]),
  supplement: null,
  sealHash: 'c'.repeat(64),
  prevSealSha256: '',
  at: '2026-11-08 10:00:00',
});

// ============================================================================
// ① 幂等红线
// ============================================================================
register('SEALJ-W1 幂等：同组重复 append → already-sealed 且字节/mtime 不变；不同组正常追加', () => {
  const l = lab();
  try {
    const r1 = append(l.root, 'g1');
    assert.equal(r1.ok, true);
    assert.equal(r1.written, true);
    const bytes = fileBytes(l.root);
    const mtime = fs.statSync(journalPathOf(l.root)).mtimeMs;

    // 第二次参数不同（sealHash 不同）也**不得**写第二行：返回的必须是 journal 里已有那条
    const r2 = append(l.root, 'g1', { sealHash: 'b'.repeat(64) });
    assert.equal(r2.ok, true, '重复封板必须 ok（旧语义）');
    assert.equal(r2.written, false);
    assert.equal(r2.reason, 'already-sealed');
    assert.equal(r2.event.key, 'g1');
    assert.equal(r2.event.sealHash, r1.event.sealHash, '必须返回已有事件，而不是本次入参拼出来的事件');
    assert.deepEqual(fileBytes(l.root), bytes, '已封组重复 append 不得改一个字节');
    assert.equal(fs.statSync(journalPathOf(l.root)).mtimeMs, mtime, 'mtime 也不许变');

    const r3 = append(l.root, 'g2');
    assert.equal(r3.written, true);
    const read = SJ.readSealEvents(l.root);
    assert.equal(read.readError, '');
    assert.deepEqual(read.events.map((e) => e.key), ['g1', 'g2']);
  } finally { dispose(l); }
});

register('SEALJ-W8 幂等键含 kind：同 key 的 weekly-seal 与 handover-seal 是两个组', () => {
  const l = lab();
  try {
    const base = {
      key: 'sess-A', gid: 'sess-A', file: 'x.xlsx', sealedAt: '2026-11-13 10:00:00',
      layoutVersion: 6, rows: null, sealHash: 'd'.repeat(64),
      decision: 'generate', main: 'main.md', appendix: 'appendix.md',
    };
    const w = SJ.appendSealEvent(l.root, { ...base, kind: 'weekly-seal', sourceRowCount: 0, overflow: 0 });
    assert.equal(w.written, true);
    const h = SJ.appendSealEvent(l.root, { ...base, kind: 'handover-seal' });
    assert.equal(h.written, true, 'kind 不同 = 不同封板组，必须能追加');
    const h2 = SJ.appendSealEvent(l.root, { ...base, kind: 'handover-seal' });
    assert.equal(h2.written, false);
    assert.equal(h2.reason, 'already-sealed');
    assert.equal(SJ.readSealEvents(l.root).events.length, 2);
  } finally { dispose(l); }
});

// ============================================================================
// ②③ 兼容旧册 + 格式/哈希口径不变
// ============================================================================
register('SEALJ-W2 兼容 0.9.5 旧册：追加后旧字节逐字节不动，事件数/顺序正确，字段顺序与 sealHash 口径不变', () => {
  const l = lab();
  try {
    const oldEvents = [legacyEvent('old-1'), legacyEvent('old-2', 'handover-seal'), legacyEvent('old-3')];
    const jp = writeLegacyJournal(l.root, oldEvents);
    const beforeBuf = fs.readFileSync(jp);

    const r = append(l.root, 'new-4');
    assert.equal(r.ok, true, '旧册必须能直接追加：' + (r.reason || ''));
    assert.equal(r.written, true);

    const afterBuf = fs.readFileSync(jp);
    assert.deepEqual(afterBuf.subarray(0, beforeBuf.length), beforeBuf, '追加必须只 append，旧字节一个不许改');
    assert.ok(afterBuf.length > beforeBuf.length);

    const read = SJ.readSealEvents(l.root);
    assert.equal(read.readError, '');
    assert.equal(read.badLines, 0);
    assert.deepEqual(read.events.map((e) => e.key), ['old-1', 'old-2', 'old-3', 'new-4'], '事件数/顺序必须正确');
    assert.equal(read.events[1].kind, 'handover-seal', '旧 handover 事件原样读回');

    // 落盘格式：一行一个 JSON；新行字段名/顺序与旧实现一致（对象插入顺序）
    const lines = readLines(l.root);
    assert.equal(lines.length, 4, '一行一个 JSON 事件（没有整册重写/合并）');
    const fresh = JSON.parse(lines[3]);
    assert.deepEqual(
      Object.keys(fresh),
      ['v', 'kind', 'key', 'gid', 'file', 'sealedAt', 'layoutVersion', 'canonicalVersion',
        'sourceRowCount', 'overflow', 'rowCount', 'rowsSha256', 'rows',
        'supplementCodesSha256', 'supplement', 'sealHash', 'prevSealSha256', 'at'],
      '字段名/顺序必须与 0.9.5 落盘一致'
    );
    assert.equal(fresh.v, SJ.SECRET_JOURNAL_VERSION);
    assert.equal(fresh.prevSealSha256, '');
    assert.deepEqual(fresh.rows, [['20261113-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']], 'rows 快照原样落盘');

    // sealHash 口径不变：仍 = sha256(weeklyCanonical(v8))
    const expectHash = SJ.sha256Hex(SJ.weeklyCanonical({
      sessKey: undefined, year: undefined, month: undefined, weekNo: undefined,
      offsetMinutes: undefined, sourceRowCount: 1, overflow: 0, rows: fresh.rows,
      supplementCodes: [],
    }));
    assert.equal(fresh.sealHash, expectHash, 'sealHash 必须是 canonical v8 口径');
  } finally { dispose(l); }
});

// ============================================================================
// ④ 尾读增量
// ============================================================================
register('SEALJ-W3 增量尾读：别的进程追加的新事件只读尾区即可识别幂等；不同 key 正常追加', () => {
  const l = lab();
  try {
    assert.equal(append(l.root, 'g1').written, true); // 冷启动：索引建立
    // 模拟另一进程（如 tools/backfill）直接 append 一行
    const jp = journalPathOf(l.root);
    const external = {
      v: 1, kind: 'weekly-seal', key: 'g-ext', gid: 'g-ext', file: 'g-ext.xlsx',
      sealedAt: '2026-11-13 11:00:00', layoutVersion: 6, canonicalVersion: 8,
      sourceRowCount: 0, overflow: 0, rowCount: 0, rowsSha256: SJ.sha256Hex('[]'),
      rows: [], supplementCodesSha256: SJ.supplementCodesSha256([]), supplement: null,
      sealHash: 'e'.repeat(64), prevSealSha256: '', at: '2026-11-13 11:00:00',
    };
    fs.appendFileSync(jp, JSON.stringify(external) + '\n', 'utf8');

    const hit = append(l.root, 'g-ext');
    assert.equal(hit.written, false, 'tail 增量必须发现外部写入的已封组');
    assert.equal(hit.reason, 'already-sealed');
    assert.equal(hit.event.key, 'g-ext');
    assert.equal(hit.event.sealedAt, '2026-11-13 11:00:00', '返回的是 journal 里的既有事件');

    assert.equal(append(l.root, 'g2').written, true);
    assert.deepEqual(SJ.readSealEvents(l.root).events.map((e) => e.key), ['g1', 'g-ext', 'g2']);
  } finally { dispose(l); }
});

// ============================================================================
// ⑤ 缓存失效重建
// ============================================================================
register('SEALJ-W4 失效重建：journal 被缩水/替换后 → 不认旧索引、不读漏', () => {
  const l = lab();
  try {
    assert.equal(append(l.root, 'a').written, true);
    assert.equal(append(l.root, 'b').written, true);
    const jp = journalPathOf(l.root);

    // 情况一：整册被更短的册子替换（模拟恢复/人工替换）→ 旧 key 不再命中
    fs.writeFileSync(jp, JSON.stringify(legacyEvent('c')) + '\n', 'utf8');
    const hitC = append(l.root, 'c');
    assert.equal(hitC.written, false, '替换后的册子里已有 c，必须识别');
    assert.equal(hitC.reason, 'already-sealed');
    assert.equal(append(l.root, 'a').written, true, '旧册里的 a 已被替换掉 → 应允许重新封板');
    assert.deepEqual(SJ.readSealEvents(l.root).events.map((e) => e.key), ['c', 'a']);

    // 情况二：删掉再重建（inode 变化；且 c/d 行长度相同 = 只靠头指纹也能看出替换）→ 必须重建索引
    fs.unlinkSync(jp);
    fs.writeFileSync(jp, JSON.stringify(legacyEvent('d')) + '\n', 'utf8');
    const hitD = append(l.root, 'd');
    assert.equal(hitD.written, false, '重建的 journal（新 inode）必须被识别为已封');
    assert.equal(hitD.reason, 'already-sealed');
    assert.equal(SJ.readSealEvents(l.root).events.length, 1);
  } finally { dispose(l); }
});

// ============================================================================
// ⑥ torn-tail
// ============================================================================
register('SEALJ-W5 torn-tail：末尾半行 → 追加前取证+截断修复（K-6）、新事件可读、坏行 0、证据可复核', () => {
  const l = lab();
  try {
    const jp = journalPathOf(l.root);
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    const good = JSON.stringify(legacyEvent('old'));
    const half = '{"v":1,"kind":"weekly-seal","key":"half';
    fs.writeFileSync(jp, good + '\n' + half, 'utf8');

    const r = append(l.root, 'new');
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    // ★ re3 K-6（审计② P2-10）：不再"补换行把半行留成永久坏行"，改为 取证(.quarantine/) → 截断。
    const rep = r.tornTailRepaired;
    assert.ok(rep, '撕裂尾修复必须留痕（tornTailRepaired），不许静默改册');
    assert.equal(rep.line, 2);
    assert.equal(rep.bytes, Buffer.byteLength(half, 'utf8'));
    assert.equal(rep.sha256, SJ.sha256Hex(half));
    assert.equal(rep.evidence, path.join('.quarantine', '.seal-journal.jsonl.L2.torn.json'));
    const evAbs = path.join(l.root, 'ledger', rep.evidence);
    assert.equal(fs.existsSync(evAbs), true, '取证文件必须落盘：' + evAbs);
    const ev = JSON.parse(fs.readFileSync(evAbs, 'utf8'));
    assert.equal(ev.kind, 'seal-journal-torn-tail');
    assert.equal(ev.lineNo, 2);
    assert.equal(ev.raw, half);
    assert.equal(ev.sha256, SJ.sha256Hex(half));

    const read = SJ.readSealEvents(l.root);
    assert.equal(read.readError, '');
    assert.equal(read.badLines, 0, '撕裂半行已取证并截断，不得再留成永久坏行');
    assert.deepEqual(read.events.map((e) => e.key), ['old', 'new']);
    const raw = fs.readFileSync(jp, 'utf8');
    assert.equal(raw.startsWith(good + '\n'), true, '取证+截断不得改动任何既有完整行');
    assert.equal(raw.includes(half), false, '半行必须已从正册移出（证据在 .quarantine/）');
    assert.equal(raw.endsWith('\n'), true);

    // 半行已被移出，后续索引必须继续正确（再来一次幂等 + 再来一组）
    assert.equal(append(l.root, 'new').written, false);
    assert.equal(append(l.root, 'newer').written, true);
    const read2 = SJ.readSealEvents(l.root);
    assert.deepEqual(read2.events.map((e) => e.key), ['old', 'new', 'newer']);
    assert.equal(read2.badLines, 0);
    // 同一行号只留一份取证（幂等重试不重复造证据）
    const q = path.join(l.root, 'ledger', '.quarantine');
    assert.equal(fs.readdirSync(q).filter((n) => n.endsWith('.torn.json')).length, 1, '=' + JSON.stringify(fs.readdirSync(q)));
  } finally { dispose(l); }
});

// ============================================================================
// ⑥b torn-tail 只修末行：中间坏行 → 只报不修（K-6 的红线：不许放宽成"截掉一段"）
// ============================================================================
register('SEALJ-W9 torn-tail 只修末行：中间坏行存在 → 一律不修（旧字节逐字不动，坏行照报）', () => {
  const l = lab();
  try {
    const jp = journalPathOf(l.root);
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    const e1 = JSON.stringify(legacyEvent('old'));
    const e2 = JSON.stringify(legacyEvent('old-2'));
    const badMiddle = '{"v":1,"kind":"weekly-seal","key":"broken';
    const half = '{"v":1,"kind":"weekly-seal","key":"half';
    fs.writeFileSync(jp, e1 + '\n' + badMiddle + '\n' + e2 + '\n' + half, 'utf8');
    const beforeBuf = fs.readFileSync(jp);

    const r = append(l.root, 'new');
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    assert.equal(r.tornTailRepaired, undefined, '中间坏行存在时不得截断（只报不修）');
    const afterBuf = fs.readFileSync(jp);
    assert.deepEqual(afterBuf.subarray(0, beforeBuf.length), beforeBuf, '不改既有字节（含中间坏行与末行半行）');

    const read = SJ.readSealEvents(l.root);
    assert.equal(read.badLines, 2, '中间坏行 + 末行半行（补换行后成为独立坏行）都如实计坏行，实际=' + read.badLines);
    assert.equal(read.events.some((e) => e.key === 'new'), true);
    const v = SJ.verifySealChain(l.root);
    assert.equal(v.ok, false);
    assert.equal(v.tornTailRepairable, false, '有其它坏行 → 不是可修撕裂尾（verify 不得暗示可截）');
  } finally { dispose(l); }
});

// ============================================================================
// ⑦ journal 缺失三态（P2-8）：删文件 vs 从未封板 vs 存在但被清空
// ============================================================================
register('SEALJ-W10 journal 缺失三态：state 称已封板 → 判红；无 state → ok 但 verifiable=false', () => {
  const l = lab();
  try {
    // ① 既无 journal 也无 state = 从未封板：ok（不是错误）但**绝不冒充"验过"**
    let v = SJ.verifySealChain(l.root);
    assert.equal(v.ok, true);
    assert.equal(v.verifiable, false);
    assert.equal(v.journalExists, false);
    assert.match(v.reason, /no-journal/);
    assert.match(v.reason, /从未封板/);

    // ② state 说"已封板"但 journal 被删 → 必须判红（旧实现两种形态都 ok:true，无法区分）
    fs.mkdirSync(path.join(l.root, 'ledger'), { recursive: true });
    const statePath = path.join(l.root, 'ledger', '.state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      weeklySealed: { '2026-11-2|abcd': { sealedAt: '2026-11-08 10:00:00', sealHash: 'a'.repeat(64), rows: 2 } },
    }) + '\n', 'utf8');
    v = SJ.verifySealChain(l.root);
    assert.equal(v.ok, false, 'state 记录已封板而 journal 不存在 = 证据缺失，必须红');
    assert.equal(v.journalExists, false);
    assert.equal(v.stateSealedCount, 1);
    assert.equal(v.verifiable, false, '没有可校验对象（但已判红）');
    assert.equal(v.violations.some((x) => x.reason === 'JOURNAL_MISSING_BUT_STATE_SEALED'), true, JSON.stringify(v.violations));
    assert.match(v.reason, /journal-missing/);

    // ③ handoverSealed 同样要算（不是只看 weeklySealed）
    const root2 = path.join(l.dir, 'root2');
    fs.mkdirSync(path.join(root2, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root2, 'ledger', '.state.json'), JSON.stringify({
      handoverSealed: { 'abcdef123456A': { sealedAt: '2026-11-08 10:00:00', sealHash: 'b'.repeat(64), main: 'x.md' } },
    }) + '\n', 'utf8');
    v = SJ.verifySealChain(root2);
    assert.equal(v.ok, false, 'state.handoverSealed 也应参与"journal 被删"判定');
    assert.equal(v.stateSealedCount, 1);

    // ④ 文件存在但 0 事件 = 被清空/写崩 → 仍红（原有语义不退化）
    const root3 = path.join(l.dir, 'root3');
    fs.mkdirSync(path.join(root3, 'ledger'), { recursive: true });
    fs.writeFileSync(SJ.sealJournalPath(root3), '', 'utf8');
    v = SJ.verifySealChain(root3);
    assert.equal(v.ok, false);
    assert.equal(v.journalExists, true);
    assert.equal(v.violations.some((x) => x.reason === 'JOURNAL_EMPTY'), true);

    // ⑤ state 存在但封板段是空对象 → 不算"声称已封板"（=从未封板，ok）
    const root4 = path.join(l.dir, 'root4');
    fs.mkdirSync(path.join(root4, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root4, 'ledger', '.state.json'), JSON.stringify({ weeklySealed: {}, handoverSealed: {} }) + '\n', 'utf8');
    v = SJ.verifySealChain(root4);
    assert.equal(v.ok, true);
    assert.equal(v.verifiable, false);
    assert.equal(v.stateSealedCount, 0);
  } finally { dispose(l); }
});

// ============================================================================
// ⑧ rowsSha256 缺失/null/非法 = 红（P2-9：不得静默通过）
// ============================================================================
register('SEALJ-W11 rowsSha256 缺失/null/非法/不符 → 判红；交接表（rows 恒 null）不得误伤', () => {
  const ROWS = [['20261113-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']];
  const baseEv = (over = {}) => ({
    v: 1, kind: 'weekly-seal', key: 'g-1', gid: 'g-1', file: 'f.xlsx',
    sealedAt: '2026-11-13 10:00:00', layoutVersion: 6, canonicalVersion: 8,
    sourceRowCount: 1, overflow: 0, rowCount: 1,
    rowsSha256: SJ.sha256Hex(JSON.stringify(ROWS)), rows: ROWS,
    supplementCodesSha256: SJ.supplementCodesSha256([]), supplement: null,
    sealHash: 'c'.repeat(64), prevSealSha256: '', at: '2026-11-13 10:00:00',
    ...over,
  });
  const l = lab();
  try {
    const writeJournal = (ev) => {
      const jp = journalPathOf(l.root);
      fs.mkdirSync(path.dirname(jp), { recursive: true });
      fs.writeFileSync(jp, JSON.stringify(ev) + '\n', 'utf8');
      return SJ.verifySealChain(l.root);
    };
    // 对照：正确行必须绿（否则下面的红没有意义）
    let v = writeJournal(baseEv());
    assert.equal(v.ok, true, '正确 rowsSha256 必须通过：' + JSON.stringify(v.violations));

    // ① 字段缺失
    const missing = baseEv(); delete missing.rowsSha256;
    v = writeJournal(missing);
    assert.equal(v.ok, false, 'rowsSha256 缺失不得静默通过');
    assert.equal(v.violations.some((x) => x.reason === 'ROWS_SHA_MISSING'), true, JSON.stringify(v.violations));

    // ② 字段为 null
    v = writeJournal(baseEv({ rowsSha256: null }));
    assert.equal(v.ok, false, 'rowsSha256=null 不得静默通过');
    assert.equal(v.violations.some((x) => x.reason === 'ROWS_SHA_MISSING'), true);

    // ③ 格式非法（不是 64 位 hex）
    v = writeJournal(baseEv({ rowsSha256: 'zz' }));
    assert.equal(v.ok, false);
    assert.equal(v.violations.some((x) => x.reason === 'ROWS_SHA_INVALID'), true, JSON.stringify(v.violations));

    // ④ 有 rows 但与 sha 复算不符（快照被改）
    v = writeJournal(baseEv({ rowsSha256: 'a'.repeat(64) }));
    assert.equal(v.ok, false);
    assert.equal(v.violations.some((x) => x.reason === 'ROWS_SHA_MISMATCH'), true);

    // ⑤ 交接表事件（D12：rows/rowsSha256 恒 null）不得因本规则误伤
    v = writeJournal({
      v: 1, kind: 'handover-seal', key: 'abcdef123456A', gid: null, file: 'x.md',
      sealedAt: '2026-11-13 10:00:00', layoutVersion: 6, canonicalVersion: 8,
      sourceRowCount: null, overflow: null, rowCount: null, rowsSha256: null, rows: null,
      supplementCodesSha256: null, supplement: null, sealHash: 'd'.repeat(64),
      prevSealSha256: '', at: '2026-11-13 10:00:00',
      decision: 'generated', main: 'x.md', appendix: 'x-附表.md',
    });
    assert.equal(v.ok, true, '交接表 rows 恒 null 是 D12 契约，不得判红：' + JSON.stringify(v.violations));
  } finally { dispose(l); }
});

// ============================================================================
// ⑨ at 格式强校验（P2-10：一条 'zzz' 不许让其后所有合法封板永久 TIME_REGRESSION）
// ============================================================================
register('SEALJ-W12 at 格式强校验：非法/缺失记结构化违规，且不污染其后合法封板的时间基准', () => {
  const l = lab();
  try {
    const ev = (key, at) => {
      const o = {
        v: 1, kind: 'weekly-seal', key, gid: key, file: 'f.xlsx', sealedAt: '2026-11-08 09:00:00',
        layoutVersion: 6, canonicalVersion: 8, sourceRowCount: 0, overflow: 0, rowCount: 0,
        rowsSha256: SJ.sha256Hex('[]'), rows: [],
        supplementCodesSha256: SJ.supplementCodesSha256([]), supplement: null,
        sealHash: 'c'.repeat(64), prevSealSha256: '',
      };
      if (at !== undefined) o.at = at;
      return JSON.stringify(o) + '\n';
    };
    const jp = journalPathOf(l.root);
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    fs.writeFileSync(jp,
      ev('a1', 'zzz') +                    // L1 非法格式
      ev('a2', '2026-11-08 10:00:00') +     // L2 合法基准
      ev('a3', '2026-11-08 11:00:00') +     // L3 合法递增 → 绝不能因 L1 的 'zzz' 报回退
      ev('a4') +                            // L4 缺失
      ev('a5', '2026-02-30 10:00:00') +     // L5 日历非法（2 月没有 30 日）
      ev('a6', '2026-11-08 09:00:00'),      // L6 合法但回退 → 仍必须抓到
      'utf8');

    const v = SJ.verifySealChain(l.root);
    assert.equal(v.ok, false);
    const at = v.violations.map((x) => x.reason + '@L' + x.line);
    assert.equal(at.includes('AT_INVALID@L1'), true, JSON.stringify(at));
    assert.equal(at.includes('AT_MISSING@L4'), true, JSON.stringify(at));
    assert.equal(at.includes('AT_INVALID@L5'), true, '日历非法（2026-02-30）必须判非法：' + JSON.stringify(at));
    const regressions = v.violations.filter((x) => x.reason === 'TIME_REGRESSION');
    assert.equal(regressions.length, 1, '只有真正的时间回退（L6）算回退，实际=' + JSON.stringify(regressions));
    assert.equal(regressions[0].line, 6);

    // 反向：合法递增的三条不得报任何时间违规（L2/L3 必须干净）
    assert.equal(at.some((x) => x === 'TIME_REGRESSION@L2' || x === 'TIME_REGRESSION@L3'), false);
  } finally { dispose(l); }
});

// ============================================================================
// ⑩ repairJournalTornTail 独立入口：三条件缺一不修 + 证据不可覆盖
// ============================================================================
register('SEALJ-W13 repairJournalTornTail：三条件缺一不修；取证排他（同号不同 sha 拒修）', () => {
  const l = lab();
  try {
    const jp = journalPathOf(l.root);
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    const good = JSON.stringify(legacyEvent('old'));

    // a) 正常文件（有结尾换行）→ 不动
    fs.writeFileSync(jp, good + '\n', 'utf8');
    let r = SJ.repairJournalTornTail(l.root);
    assert.equal(r.ok, true);
    assert.equal(r.repaired, false);
    assert.equal(r.reason, 'ends-with-newline');

    // b) 合法 JSON 但缺结尾换行 → 不是撕裂（append 会补换行），这里不修
    fs.writeFileSync(jp, good, 'utf8');
    r = SJ.repairJournalTornTail(l.root);
    assert.equal(r.repaired, false, '完整 JSON 只缺换行 ≠ 撕裂尾，不得截断');
    assert.equal(r.reason, 'tail-parses');

    // c) 中间坏行 + 末行半行 → 拒修（红线：不许把更大损坏也截掉）
    fs.writeFileSync(jp, good + '\n' + '{"bad":\n' + '{"v":1,"kind":"weekly-seal","key":"ha', 'utf8');
    r = SJ.repairJournalTornTail(l.root);
    assert.equal(r.repaired, false);
    assert.match(String(r.reason), /not-only-tail-bad/);

    // d) 只有末行撕裂 → 修：取证 + 截断 + 返回留痕
    fs.writeFileSync(jp, good + '\n' + '{"v":1,"kind":"weekly-seal","key":"ha', 'utf8');
    r = SJ.repairJournalTornTail(l.root);
    assert.equal(r.ok, true);
    assert.equal(r.repaired, true, '唯一末行撕裂必须可修：' + (r.reason || ''));
    assert.equal(r.record.line, 2);
    assert.equal(fs.readFileSync(jp, 'utf8'), good + '\n', '截断后只剩既有完整行');
    assert.equal(fs.existsSync(path.join(l.root, 'ledger', r.record.evidence)), true);

    // e) 证据被换成异 sha 的同号文件 → 再次撕裂时必须拒修（证据不可覆盖）
    const evAbs = path.join(l.root, 'ledger', r.record.evidence);
    fs.writeFileSync(evAbs, JSON.stringify({ ...r.record, sha256: 'f'.repeat(64) }) + '\n', 'utf8');
    fs.writeFileSync(jp, good + '\n' + '{"v":1,"kind":"weekly-seal","key":"hb', 'utf8');
    const r2 = SJ.repairJournalTornTail(l.root);
    assert.equal(r2.repaired, false, '同号证据 sha 不符 = 册子被换过，不得覆盖证据强修');
    assert.notEqual(fs.readFileSync(evAbs, 'utf8'), '');
  } finally { dispose(l); }
});

// ============================================================================
// ⑦ 读字节计量：append 冷启动整读一次，稳态 ≈0；readSealEvents 仍整读
// ============================================================================
register('SEALJ-W6 读字节：冷启动一次整读重建，稳态 append ≤64 KiB；readSealEvents 仍整读（API 不变）', () => {
  const l = lab();
  const orig = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    readSync: fs.readSync,
    readFileSync: fs.readFileSync,
    createReadStream: fs.createReadStream,
  };
  const meter = { bytes: 0, readFileBytes: 0, readFileCalls: 0, readSyncBytes: 0 };
  try {
    // 合成 1.5 MiB 左右的 journal（直接写行，模拟历史册）
    const jp = journalPathOf(l.root);
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    const rows = Array.from({ length: 20 }, (_, i) => [`20261108-aaaaaaaaaaaa-A-${String(i).padStart(8, '0')}`, '绑定', '10:00', '已完成']);
    let text = '';
    for (let i = 0; i < 900; i++) {
      text += JSON.stringify({ ...legacyEvent('hist-' + i), rows, rowCount: rows.length }) + '\n';
    }
    fs.writeFileSync(jp, text, 'utf8');
    const size = fs.statSync(jp).size;
    assert.ok(size > 1024 * 1024, '前置：合成册要 >1 MiB，实际 ' + size);

    // monkey-patch fs（与 _工作/tools/measure-tick.mjs 同法）
    fs.openSync = function (p, ...a) { const fd = orig.openSync.call(fs, p, ...a); return fd; };
    fs.closeSync = function (fd) { return orig.closeSync.call(fs, fd); };
    fs.readSync = function (fd, buffer, offset, length, position) {
      const n = orig.readSync.call(fs, fd, buffer, offset, length, position);
      if (n > 0) { meter.bytes += n; meter.readSyncBytes += n; }
      return n;
    };
    fs.readFileSync = function (p, ...a) {
      const r = orig.readFileSync.call(fs, p, ...a);
      const n = Buffer.isBuffer(r) ? r.length : Buffer.byteLength(String(r || ''), 'utf8');
      meter.bytes += n; meter.readFileBytes += n; meter.readFileCalls += 1;
      return r;
    };
    const reset = () => { meter.bytes = 0; meter.readFileBytes = 0; meter.readFileCalls = 0; meter.readSyncBytes = 0; };

    // 冷启动：索引缺失 → 流式整读一次重建（O(N) 一次，不是每次）
    reset();
    const cold = append(l.root, 'cold-1');
    assert.equal(cold.written, true);
    assert.ok(meter.readSyncBytes >= size * 0.95, '冷启动应流式整读一次：read=' + meter.readSyncBytes + ' / file=' + size);
    assert.equal(meter.readFileCalls, 0, 'append 路径不得再 readFileSync 整册读');

    // 稳态：size/mtime 都没变 → 0 字节整读，只剩刚写行的回读
    reset();
    const warm = append(l.root, 'warm-1');
    assert.equal(warm.written, true);
    assert.ok(meter.bytes < 64 * 1024, '稳态 append 读字节必须 ≈0（仅回读刚写行），实际 ' + meter.bytes);
    assert.ok(meter.bytes < size / 10, '稳态读字节必须远小于整册');

    // 已封命中：同样只读那一行，不整册
    reset();
    const again = append(l.root, 'warm-1');
    assert.equal(again.written, false);
    assert.equal(again.reason, 'already-sealed');
    assert.ok(meter.bytes < 64 * 1024, '已封命中必须只读那一条事件，实际 ' + meter.bytes);

    // 读 API 不变：readSealEvents() 仍是整读（返回全部事件）
    reset();
    const read = SJ.readSealEvents(l.root);
    assert.equal(read.events.length, 902);
    assert.ok(meter.bytes >= size * 0.9, 'readSealEvents 必须保持整读语义，实际 read=' + meter.bytes);
  } finally {
    Object.assign(fs, orig);
    dispose(l);
  }
});

// ============================================================================
// ⑧ readSealJournalState()（0.9.4 新增）语义不变
// ============================================================================
register('SEALJ-W7 readSealJournalState 语义不变：追加后计数/坏行/readError/seals 同步，摘要仍不含 rows', () => {
  const l = lab();
  try {
    assert.equal(append(l.root, 'g1').written, true);
    assert.equal(append(l.root, 'g2').written, true);
    let st = WK.readSealJournalState(l.root);
    assert.equal(st.readError, '');
    assert.equal(st.badLines, 0);
    assert.equal(st.eventCount, 2);
    assert.equal(st.seals.get('g1').sealHash.length, 64);
    assert.equal(Array.isArray(st.events[0].rows), false, 'W5 语义：摘要事件不保留 rows 快照');

    // 追加后：weekly 的 W1 尾读缓存必须增量看到新事件（写侧索引与读侧缓存不串味）
    assert.equal(append(l.root, 'g3').written, true);
    st = WK.readSealJournalState(l.root);
    assert.equal(st.eventCount, 3, '追加后尾读缓存应增量看到新事件');
    assert.deepEqual([...st.seals.keys()].sort(), ['g1', 'g2', 'g3']);
  } finally { dispose(l); }
});

// ============================================================================
// --bench：10 MB / 50 MB 微基准（读字节 + 耗时）
// ============================================================================
function argOf(k, d = '') {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
}

function writeSyntheticJournal(file, targetBytes) {
  const fd = fs.openSync(file, 'w');
  try {
    const rows = Array.from({ length: 120 }, (_, i) => [
      `20261108-aaaaaaaaaaaa-A-${String(i).padStart(8, '0')}`, '绑定', '10:00', '已完成',
    ]);
    let wrote = 0;
    let n = 0;
    let batch = [];
    while (wrote < targetBytes) {
      const ev = {
        v: 1, kind: 'weekly-seal', key: `bench-${n}`, gid: `bench-${n}`, file: `f-${n}.xlsx`,
        sealedAt: '2026-11-08 10:00:00', layoutVersion: 6, canonicalVersion: 8,
        sourceRowCount: 120, overflow: 0, rowCount: 120,
        rowsSha256: '0'.repeat(64), rows,
        supplementCodesSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        supplement: null, sealHash: 'a'.repeat(64), prevSealSha256: '', at: '2026-11-08 10:00:00',
      };
      const line = JSON.stringify(ev) + '\n';
      batch.push(line);
      wrote += Buffer.byteLength(line, 'utf8');
      n += 1;
      if (batch.length >= 200) { fs.writeSync(fd, batch.join(''), null, 'utf8'); batch = []; }
    }
    if (batch.length) fs.writeSync(fd, batch.join(''), null, 'utf8');
    fs.fsyncSync(fd);
    return { events: n, bytes: wrote };
  } finally {
    fs.closeSync(fd);
  }
}

function instrumentFs() {
  const orig = {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    readSync: fs.readSync,
    readFileSync: fs.readFileSync,
    createReadStream: fs.createReadStream,
  };
  const meter = { bytes: 0, readFileBytes: 0, readFileCalls: 0, readSyncBytes: 0 };
  fs.openSync = function (p, ...a) { return orig.openSync.call(fs, p, ...a); };
  fs.closeSync = function (fd) { return orig.closeSync.call(fs, fd); };
  fs.readSync = function (fd, buffer, offset, length, position) {
    const n = orig.readSync.call(fs, fd, buffer, offset, length, position);
    if (n > 0) { meter.bytes += n; meter.readSyncBytes += n; }
    return n;
  };
  fs.readFileSync = function (p, ...a) {
    const r = orig.readFileSync.call(fs, p, ...a);
    const n = Buffer.isBuffer(r) ? r.length : Buffer.byteLength(String(r || ''), 'utf8');
    meter.bytes += n; meter.readFileBytes += n; meter.readFileCalls += 1;
    return r;
  };
  fs.createReadStream = function (p, ...a) {
    const st = orig.createReadStream.call(fs, p, ...a);
    st.on('data', (c) => { meter.bytes += c.length; });
    return st;
  };
  return {
    reset() { meter.bytes = 0; meter.readFileBytes = 0; meter.readFileCalls = 0; meter.readSyncBytes = 0; },
    snapshot() { return { ...meter }; },
    restore() { Object.assign(fs, orig); },
  };
}

async function runBench() {
  const sizesMB = String(argOf('sizes', '10,50')).split(',').map((x) => Number(x) || 0).filter((x) => x > 0);
  const rounds = Math.max(1, Number(argOf('rounds', '3')) || 3);
  const tickN = Math.max(0, Number(argOf('tick', '0')) || 0);
  const asJson = process.argv.includes('--json');
  const implArg = argOf('impl', '');
  const implPath = implArg ? path.resolve(implArg) : path.join(SRC, 'lib', 'sealjournal.js');
  const mod = await import(pathToFileURL(implPath).href + '?bench=' + Date.now());
  const implBytes = fs.statSync(implPath).size;

  const out = { impl: implPath, implBytes, rounds, sizes: [] };
  for (const mb of sizesMB) {
    const l = lab();
    try {
      const jp = mod.sealJournalPath(l.root);
      fs.mkdirSync(path.dirname(jp), { recursive: true });
      const gen = writeSyntheticJournal(jp, mb * 1024 * 1024);
      const fileBytes = fs.statSync(jp).size;
      const meter = instrumentFs();
      const appends = [];
      try {
        for (let i = 0; i < rounds; i++) {
          meter.reset();
          const t0 = process.hrtime.bigint();
          const res = mod.appendSealEvent(l.root, {
            kind: 'weekly-seal', key: `measure-${i}`, gid: `measure-${i}`, file: `m-${i}.xlsx`,
            sealedAt: '2026-11-13 10:00:00', layoutVersion: 6, sourceRowCount: 1, overflow: 0,
            rows: [['20261113-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']],
          });
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (!res || res.ok !== true || res.written !== true) throw new Error('bench append failed: ' + JSON.stringify(res));
          appends.push({ i, ms: Math.round(ms * 100) / 100, ...meter.snapshot() });
        }
        // 重复 append（已封命中）
        meter.reset();
        const t0 = process.hrtime.bigint();
        const dup = mod.appendSealEvent(l.root, {
          kind: 'weekly-seal', key: 'measure-0', gid: 'measure-0', file: 'm-0.xlsx',
          sealedAt: '2026-11-13 10:00:00', rows: [['20261113-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']],
        });
        const dupMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const dupSnapshot = meter.snapshot();
        if (!dup || dup.reason !== 'already-sealed') throw new Error('bench duplicate not detected');
        let tick = null;
        if (tickN > 0) {
          // "同一 tick 封 N 组"：连续 N 次 append（唯一 key），测总耗时/总读字节/单次最大
          meter.reset();
          let maxMs = 0;
          const tTick = process.hrtime.bigint();
          for (let j = 0; j < tickN; j++) {
            const t1 = process.hrtime.bigint();
            const r = mod.appendSealEvent(l.root, {
              kind: 'weekly-seal', key: `tick-${j}`, gid: `tick-${j}`, file: `t-${j}.xlsx`,
              sealedAt: '2026-11-13 10:00:00', layoutVersion: 6, sourceRowCount: 1, overflow: 0,
              rows: [['20261113-aaaaaaaaaaaa-A-00000001', '绑定', '10:00', '已完成']],
            });
            const one = Number(process.hrtime.bigint() - t1) / 1e6;
            if (!r || r.ok !== true || r.written !== true) throw new Error('bench tick append failed: ' + JSON.stringify(r));
            if (one > maxMs) maxMs = one;
          }
          const totalMs = Number(process.hrtime.bigint() - tTick) / 1e6;
          tick = { n: tickN, totalMs: Math.round(totalMs), maxMs: Math.round(maxMs * 100) / 100, ...meter.snapshot() };
        }
        out.sizes.push({
          mb, fileBytes, events: gen.events, appends,
          duplicate: { ms: Math.round(dupMs * 100) / 100, ...dupSnapshot }, tick,
        });
      } finally {
        meter.restore();
      }
    } finally { dispose(l); }
  }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`SEAL-01 微基准 · impl=${implPath} (${implBytes} B) · rounds=${rounds}`);
  for (const s of out.sizes) {
    console.log(`\n== 合成 journal ${s.mb} MB（实际 ${s.fileBytes} B / ${s.events} 事件 / 120 行快照）==`);
    console.log('次 | 耗时 ms | 读字节 | 其中 readSync | 其中 readFileSync | readFile 次数');
    for (const a of s.appends) {
      console.log(`${String(a.i).padStart(2)} | ${String(a.ms).padStart(8)} | ${String(a.bytes).padStart(9)} | ${String(a.readSyncBytes).padStart(8)} | ${String(a.readFileBytes).padStart(9)} | ${a.readFileCalls}`);
    }
    const warm = s.appends.slice(1);
    if (warm.length) {
      const maxBytes = Math.max(...warm.map((x) => x.bytes));
      const maxMs = Math.max(...warm.map((x) => x.ms));
      console.log(`稳态 ${warm.length} 次 append：最大读字节 ${maxBytes} B (${(maxBytes / 1024).toFixed(1)} KiB) | 最大耗时 ${maxMs} ms`);
    }
    console.log(`重复 append（已封命中）：${s.duplicate.ms} ms / 读字节 ${s.duplicate.bytes} B`);
    if (s.tick) {
      console.log(`同 tick 连封 ${s.tick.n} 组：总耗时 ${s.tick.totalMs} ms / 总读字节 ${s.tick.bytes} B / 单次最大 ${s.tick.maxMs} ms`);
    }
  }
}

// ============================================================================
// 入口：默认跑功能自测；--bench 只跑微基准
// ============================================================================
if (BENCH) {
  await runBench();
}
