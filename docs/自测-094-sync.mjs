/**
 * @file 自测-094-sync.mjs
 * @role 0.9.4-re1（C28）「索引增量同步 syncIndex」自测（7 条用例，串行、自包含、不依赖 _工作 的 lab）。
 *
 * @why C28 的判据是"新增一行 → 索引同步加一行（不重建、不重扫）"，光看"索引行数 +1"会骗人：
 *      把 buildIndex 整读全部台账也能 +1。所以本自测必须同时钉住四条不变量：
 *        ① 只 +1 行，且只重写**受影响的那一个日分片**（其它分片 sha 不变）；
 *        ② **只读新增尾**：实测台账读字节 ≤ 新行字节 ×3（用 fs 层 readFileSync/readSync 双钩子量，
 *           不只看 readFileSync —— 尾读走 readSync 才不会被 hook 漏计）；
 *        ③ 新行指针可复算：`read(台账日文件, o, n)` 的字节 == 追加的台账行原文；
 *        ④ 判定不了"只尾部追加"时**回退全量重建**并如实返回 `mode:'rebuild'`（历史补写/分片缺失/
 *           索引缺失/分片被改/调用方给的行不在尾部），重建后 stat 全绿。
 *      另外守 tick 接线：首 tick `mode:'rebuild'`，之后有新行的一轮 `mode:'sync'` 且 `built=false`。
 *
 * 用法：node docs/自测-094-sync.mjs   （退出码 0 = 全过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pi = await import(pathToFileURL(path.join(SRC, 'tools', 'pointerindex.mjs')).href);
const { runOnce, __test__: idxTest } = await import(pathToFileURL(path.join(SRC, 'index.js')).href);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } };

// ============================================================================
// 一、指针索引夹具：5 行 / 2 个台账日（最后一日 = 2026-11-03 是 sync 的"尾部"）
// ============================================================================
const SESSIONS = [
  { s12: 'aaaaaaaaaaaa', sid: 'session-aaaaaaaa-aaaa-1111-2222-333333333333', codeDate: '20261101' },
  { s12: 'bbbbbbbbbbbb', sid: 'session-bbbbbbbb-bbbb-1111-2222-333333333333', codeDate: '20261101' },
];
const LAYOUT = [
  { s: 0, day: '2026-11-02', turn: 1 },
  { s: 0, day: '2026-11-02', turn: 2 },
  { s: 0, day: '2026-11-03', turn: 3 },
  { s: 1, day: '2026-11-03', turn: 1 },
  { s: 1, day: '2026-11-03', turn: 2 },
];

function makeRow({ s, day, turn }) {
  const sess = SESSIONS[s];
  const code = `${sess.codeDate}-${sess.s12}-A-${String(turn).padStart(8, '0')}`;
  return {
    v: 3,
    code,
    ts: `${day}T${String(8 + turn).padStart(2, '0')}:00:00+08:00`,
    sid: sess.sid,
    turn,
    seq: turn,
    status: 'ok',
    turnState: 'closed',
    src: 'session.v4.jsonl.zstd',
    doc: '',
    docFileSha256: '',
    dateOffset: 480,
  };
}

/** 造一个临时账库（台账日文件 + 原文视图），并用 buildIndex 建好索引。 */
function makeLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync094-'));
  const root = path.join(base, 'root');
  const led = path.join(root, 'ledger');
  fs.mkdirSync(led, { recursive: true });
  fs.writeFileSync(path.join(root, '.ledger-root'), JSON.stringify({ v: 1, root: 'selftest' }) + '\n', 'utf8');
  const byDay = new Map();
  for (const spec of LAYOUT) {
    const rec = makeRow(spec);
    const mm = SESSIONS[spec.s].codeDate.slice(4, 6);
    const rel = path.join(`${SESSIONS[spec.s].codeDate.slice(0, 4)}年${mm}月`, `${mm}月总“完整原文”`, `${rec.code} 完整原文.md`);
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `---\n编码: '${rec.code}'\n---\n\n# ${rec.code}\n\n第 ${spec.turn} 轮测试原文（sync 自测夹具）。\n`, 'utf8');
    rec.doc = rel;
    rec.docFileSha256 = sha256(fs.readFileSync(abs));
    if (!byDay.has(spec.day)) byDay.set(spec.day, []);
    byDay.get(spec.day).push(rec);
  }
  for (const [day, rows] of byDay) {
    fs.writeFileSync(path.join(led, `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  const built = pi.buildIndex({ root });
  if (built.ok !== true) throw new Error('夹具建索引失败: ' + JSON.stringify(built.problems.slice(0, 3)));
  return { base, root, built };
}

function ledgerDayFiles(root) {
  return fs.readdirSync(path.join(root, 'ledger'))
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
}
function maxDayFile(root) {
  const names = ledgerDayFiles(root);
  return names[names.length - 1];
}
let synthSeq = 0;
/**
 * 造一条"合法的新账行"（复制指定台账日文件的最后一行，只改 code/turn/seq，ts 保持该日），
 * 直接 append 到该台账日文件 —— 与 tick 的落账形态一致。
 */
function appendSynthetic(root, { dayFile } = {}) {
  const name = dayFile || maxDayFile(root);
  const abs = path.join(root, 'ledger', name);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((x) => x.trim());
  const rec = JSON.parse(lines[lines.length - 1]);
  const n = ++synthSeq;
  rec.code = `${rec.code.slice(0, 24)}${String(91000000 + n).padStart(8, '0')}`;
  rec.turn = 91000000 + n;
  rec.seq = rec.turn;
  const line = JSON.stringify(rec);
  fs.appendFileSync(abs, `${line}\n`, 'utf8');
  return {
    rec, line, file: name,
    day: name.slice(0, 10).replace(/-/g, ''),
    bytes: Buffer.byteLength(line, 'utf8') + 1,
  };
}

/** `.idx-state.json` 里声明的逐日水位（旧状态 = 没有该字段）。 */
function readState(root) {
  const p = pi.indexStatePath(root);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeState(root, state) {
  fs.writeFileSync(pi.indexStatePath(root), JSON.stringify(state), 'utf8');
}
function shardShas(root) {
  const dir = pi.indexDir(root);
  const out = new Map();
  for (const n of fs.readdirSync(dir)) {
    if (!/^idx-.*\.jsonl$/.test(n)) continue;
    out.set(n, sha256(fs.readFileSync(path.join(dir, n))));
  }
  return out;
}
function changedShardNames(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  const changed = [];
  for (const n of names) if (before.get(n) !== after.get(n)) changed.push(n);
  return changed.sort();
}
function countIndexRows(root) {
  const dir = pi.indexDir(root);
  let rows = 0;
  for (const n of fs.readdirSync(dir)) {
    if (!/^idx-.*\.jsonl$/.test(n)) continue;
    rows += fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter((x) => x.trim()).length;
  }
  return rows;
}
function countLedgerRows(root) {
  let rows = 0;
  for (const n of ledgerDayFiles(root)) {
    rows += fs.readFileSync(path.join(root, 'ledger', n), 'utf8').split('\n').filter((x) => x.trim()).length;
  }
  return rows;
}

/**
 * 台账读字节计数器：**同时**钩 `readFileSync` 与 `readSync`（判据 hook 只钩前者；
 * sync 的尾读走后者，必须自己量出来才不会被"0 读数"骗过）。
 */
function withLedgerReads(root, fn) {
  const orig = {
    readFileSync: fs.readFileSync,
    openSync: fs.openSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
  };
  const fdPath = new Map();
  const calls = [];
  const ledAbs = path.join(root, 'ledger');
  const relOf = (p) => {
    const abs = path.resolve(String(p));
    const rel = path.relative(ledAbs, abs).split(path.sep).join('/');
    return /^[^/\\]+\.jsonl$/.test(rel) ? rel : '';
  };
  let ledgerReadBytes = 0;
  const record = (file, kind, n) => {
    const bytes = Math.max(0, Number(n) || 0);
    calls.push({ file, kind, n: bytes });
    ledgerReadBytes += bytes;
  };
  fs.readFileSync = function (p, ...rest) {
    const buf = orig.readFileSync.call(fs, p, ...rest);
    const rel = relOf(p);
    if (rel) record(rel, 'readFileSync', Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf)));
    return buf;
  };
  fs.openSync = function (p, ...rest) {
    const fd = orig.openSync.call(fs, p, ...rest);
    fdPath.set(fd, String(p));
    return fd;
  };
  fs.readSync = function (fd, buf, off, len, pos) {
    const n = orig.readSync.call(fs, fd, buf, off, len, pos);
    const rel = relOf(fdPath.get(fd) || '');
    if (rel) record(rel, 'readSync', n);
    return n;
  };
  fs.closeSync = function (fd) {
    const p = fdPath.get(fd);
    if (p !== undefined) fdPath.delete(fd);
    return orig.closeSync.call(fs, fd);
  };
  try {
    return { result: fn(), calls, ledgerReadBytes };
  } finally {
    fs.readFileSync = orig.readFileSync;
    fs.openSync = orig.openSync;
    fs.readSync = orig.readSync;
    fs.closeSync = orig.closeSync;
  }
}

// ============================================================================
// 二、纯 syncIndex 用例
// ============================================================================

test('① sync：追加 1 行 → 索引 +1、只重写当日分片、只读新增尾（读放大 ≤3×，实测台账读字节）', () => {
  const lab = makeLab();
  try {
    const before = { rows: countIndexRows(lab.root), shas: shardShas(lab.root) };
    const syn = appendSynthetic(lab.root);
    const hooked = withLedgerReads(lab.root, () => pi.syncIndex({ root: lab.root, rows: [syn.rec] }));
    const r = hooked.result;

    assert.equal(r.mode, 'sync', '只追加尾部时必须走 sync，实际：' + r.mode + '（' + (r.reason || '') + '）');
    assert.equal(r.ok, true, 'sync 不应有 problems: ' + JSON.stringify(r.problems));
    assert.equal(r.added, 1, '只能 +1 行');
    assert.equal(r.rows, before.rows + 1, '索引总行数 +1');
    assert.equal(r.written, 1, '只重写受影响的那一个分片');
    assert.equal(r.removed, 0, '不清理任何分片');

    // ② 只读新增尾：读字节 ≈ 新行字节（+ 至多 2 个探路字节），远低于 3×
    const amp = hooked.ledgerReadBytes / syn.bytes;
    assert.equal(r.bytesRead, hooked.ledgerReadBytes, '返回的 bytesRead 必须等于实测台账读字节');
    assert.ok(amp <= 3, `读放大 ${amp.toFixed(2)}× > 阈值 3×（实测 ${hooked.ledgerReadBytes} B / 新行 ${syn.bytes} B）`);
    assert.ok(hooked.ledgerReadBytes <= syn.bytes + 2,
      `台账读 ${hooked.ledgerReadBytes} B 超过"新行 ${syn.bytes} B + 探路 2 B"——没做到只读新增尾`);

    // 只重写当日分片；其它分片 sha 不变
    const expectedShard = `idx-${syn.day}.jsonl`;
    assert.deepEqual(changedShardNames(before.shas, shardShas(lab.root)), [expectedShard]);

    // ③ 新行指针可复算：切片 == 追加的台账行原文
    assert.equal(r.day, syn.day);
    const hits = pi.queryIndex({ root: lab.root, code: syn.rec.code });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].pointerOk, true, '新行指针必须可解析：' + hits[0].pointerError);
    const slice = fs.readFileSync(path.join(lab.root, 'ledger', syn.file))
      .subarray(hits[0].offset, hits[0].offset + hits[0].bytes).toString('utf8');
    assert.equal(slice, syn.line, '索引 {o,n} 切片必须逐字节等于追加的台账行');

    // 状态水位 + stat 全绿
    const st = readState(lab.root);
    assert.equal(Number(st.rows), before.rows + 1);
    assert.equal(Number(st.days[syn.day].ledgerBytes), fs.statSync(path.join(lab.root, 'ledger', syn.file)).size,
      '状态必须记下该日台账文件的新水位');
    const stat = pi.statIndex({ root: lab.root, checkDocs: false });
    assert.equal(stat.ok, true, '同步后 stat 必须全绿：' + JSON.stringify(stat.problems.slice(0, 3)));

    // 幂等：同一批行再 sync → skip（不重复 +1）
    const hooked2 = withLedgerReads(lab.root, () => pi.syncIndex({ root: lab.root, rows: [syn.rec] }));
    const r2 = hooked2.result;
    assert.equal(r2.mode, 'skip', '已同步过的行再给 → skip（幂等）');
    assert.equal(r2.added, 0);
    assert.equal(r2.rows, before.rows + 1, 'skip 时行数不变');
    assert.equal(hooked2.ledgerReadBytes, 0, '无新增行时不该读台账（state 水位已足够判定）');

    console.log(`[C28-读数] 新行 ${syn.bytes} B；实测台账读 ${hooked.ledgerReadBytes} B → 读放大 ${amp.toFixed(2)}×（阈值 3×）`);
  } finally {
    rmrf(lab.base);
  }
});

test('② 旧状态兼容：0.9.4-snap 的 .idx-state.json 没有逐日水位 → 反推一次后仍只读新增尾并补齐水位', () => {
  const lab = makeLab();
  try {
    // 模拟旧状态：删掉逐日 ledgerBytes（其余字段不动）
    const st0 = readState(lab.root);
    for (const d of Object.keys(st0.days || {})) delete st0.days[d].ledgerBytes;
    writeState(lab.root, st0);
    assert.equal(readState(lab.root).days['20261103'].ledgerBytes, undefined);

    const beforeRows = countIndexRows(lab.root);
    const syn = appendSynthetic(lab.root);
    const hooked = withLedgerReads(lab.root, () => pi.syncIndex({ root: lab.root, rows: [syn.rec] }));
    const r = hooked.result;
    assert.equal(r.mode, 'sync', '旧状态也必须能反推出水位并 sync（实际 ' + r.mode + '：' + (r.reason || '') + '）');
    assert.equal(r.rows, beforeRows + 1);
    const amp = hooked.ledgerReadBytes / syn.bytes;
    assert.ok(amp <= 3, `旧状态反推也不能放大：${amp.toFixed(2)}×（${hooked.ledgerReadBytes} B / ${syn.bytes} B）`);

    const st1 = readState(lab.root);
    for (const d of Object.keys(st1.days || {})) {
      assert.equal(Number.isInteger(st1.days[d].ledgerBytes), true, `旧状态未补齐水位：${d}`);
      assert.equal(st1.days[d].ledgerBytes, fs.statSync(path.join(lab.root, 'ledger',
        `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}.jsonl`)).size, `水位错：${d}`);
    }
    assert.equal(pi.statIndex({ root: lab.root, checkDocs: false }).ok, true);
  } finally {
    rmrf(lab.base);
  }
});

test('③ C28 判据口径：buildIndex({root}) 在"只追加"形态自动走 sync（written=1/removed=0/readFileSync 不读台账）', () => {
  const lab = makeLab();
  try {
    const before = { rows: countIndexRows(lab.root), shas: shardShas(lab.root) };
    const syn = appendSynthetic(lab.root);
    const hooked = withLedgerReads(lab.root, () => pi.buildIndex({ root: lab.root }));
    const r = hooked.result;

    assert.equal(r.mode, 'sync', '判据调的是 buildIndex：只追加形态必须自动走 sync，实际 ' + r.mode + '：' + (r.syncFallback || ''));
    assert.equal(r.ok, true);
    assert.equal(r.written, 1, 'C28 子项②：written 必须 =1');
    assert.equal(r.removed, 0, 'C28 子项②：removed 必须 =0');
    assert.equal(r.rows, before.rows + 1);
    assert.deepEqual(changedShardNames(before.shas, shardShas(lab.root)), [`idx-${syn.day}.jsonl`]);

    // C28 判据的 fs hook 只钩 readFileSync → 台账 readFileSync 字节必须为 0（尾读走 readSync，实测见下面 amp）
    const rfBytes = hooked.calls.filter((c) => c.kind === 'readFileSync').reduce((a, c) => a + c.n, 0);
    assert.equal(rfBytes, 0, 'buildIndex 自动 sync 时不许 readFileSync 台账（判据 hook 口径）');
    const amp = hooked.ledgerReadBytes / syn.bytes;
    assert.ok(amp <= 3, `实测读放大 ${amp.toFixed(2)}× > 3×（${hooked.ledgerReadBytes} B / ${syn.bytes} B）`);

    const stat = pi.statIndex({ root: lab.root, checkDocs: false });
    assert.equal(stat.ok, true, 'stat 必须全绿：' + JSON.stringify(stat.problems.slice(0, 3)));
    console.log(`[C28-buildIndex] written=${r.written} removed=${r.removed} 读放大 ${amp.toFixed(2)}×（readFileSync 台账读数 0 B）`);
  } finally {
    rmrf(lab.base);
  }
});

// ============================================================================
// 三、回退（rebuild）用例
// ============================================================================

test('④ 回退·历史补写：往"非最后一日"的台账文件追加 → mode rebuild（不许猜着 sync）', () => {
  const lab = makeLab();
  try {
    const olderFile = ledgerDayFiles(lab.root)[0];
    const syn = appendSynthetic(lab.root, { dayFile: olderFile });
    const r = pi.syncIndex({ root: lab.root, rows: [syn.rec] });
    assert.equal(r.mode, 'rebuild', '历史补写必须回退 rebuild，实际 ' + r.mode);
    assert.match(String(r.reason), /non-tail-day-growth/, '回退原因要如实：' + r.reason);
    assert.equal(r.ok, true, '重建后索引必须自洽');
    assert.equal(countIndexRows(lab.root), countLedgerRows(lab.root), '重建后索引行数 = 台账行数');
    assert.equal(pi.statIndex({ root: lab.root, checkDocs: false }).ok, true, '重建后 stat 全绿');

    // 回退之后又回到"只追加"形态 → 仍能 sync（回退不是一次性的）
    const syn2 = appendSynthetic(lab.root);
    const r2 = pi.syncIndex({ root: lab.root, rows: [syn2.rec] });
    assert.equal(r2.mode, 'sync', 'rebuild 把水位补齐后，下一轮尾部追加必须能继续 sync（实际 ' + r2.mode + '）');
  } finally {
    rmrf(lab.base);
  }
});

test('⑤ 回退·分片/索引被破坏：当日分片缺失 / 整个索引缺失 / 分片被改 → mode rebuild 且重建后 stat 绿', () => {
  // ⑤a 当日分片缺失
  {
    const lab = makeLab();
    try {
      const syn = appendSynthetic(lab.root);
      fs.unlinkSync(path.join(pi.indexDir(lab.root), `idx-${syn.day}.jsonl`));
      const r = pi.syncIndex({ root: lab.root, rows: [syn.rec] });
      assert.equal(r.mode, 'rebuild', '当日分片缺失必须回退 rebuild，实际 ' + r.mode);
      assert.match(String(r.reason), /day-shard-missing/, '原因：' + r.reason);
      assert.equal(countIndexRows(lab.root), countLedgerRows(lab.root));
      assert.equal(pi.statIndex({ root: lab.root, checkDocs: false }).ok, true);
    } finally { rmrf(lab.base); }
  }
  // ⑤b 整个 .index 被删
  {
    const lab = makeLab();
    try {
      fs.rmSync(pi.indexDir(lab.root), { recursive: true, force: true });
      const syn = appendSynthetic(lab.root);
      const r = pi.syncIndex({ root: lab.root, rows: [syn.rec] });
      assert.equal(r.mode, 'rebuild', '.index 缺失必须回退 rebuild，实际 ' + r.mode);
      assert.match(String(r.reason), /index-missing|state-missing/, '原因：' + r.reason);
      assert.equal(countIndexRows(lab.root), countLedgerRows(lab.root));
      assert.equal(pi.statIndex({ root: lab.root, checkDocs: false }).ok, true);
    } finally { rmrf(lab.base); }
  }
  // ⑤c 当日分片被改（偏移不连续）+ 台账尾部追加 → 不能对坏分片做 append
  {
    const lab = makeLab();
    try {
      const syn = appendSynthetic(lab.root);
      const shardAbs = path.join(pi.indexDir(lab.root), `idx-${syn.day}.jsonl`);
      const lines = fs.readFileSync(shardAbs, 'utf8').split('\n').filter((x) => x.trim());
      const row = JSON.parse(lines[0]);
      row.o = row.o + 1; // 挪 1 字节 → 行首不再连续
      lines[0] = JSON.stringify(row);
      fs.writeFileSync(shardAbs, `${lines.join('\n')}\n`, 'utf8');
      const r = pi.syncIndex({ root: lab.root, rows: [syn.rec] });
      assert.equal(r.mode, 'rebuild', '分片被改必须回退 rebuild，实际 ' + r.mode);
      assert.match(String(r.reason), /day-shard-not-contiguous|index-rows-lost|day-shard-corrupt/, '原因：' + r.reason);
      assert.equal(pi.statIndex({ root: lab.root, checkDocs: false }).ok, true, '重建必须把被改的分片修好');
    } finally { rmrf(lab.base); }
  }
});

test('⑥ 回退·调用方行不在新增尾（乱序/伪造）：不许把不在尾部的行硬塞进索引 → mode rebuild', () => {
  const lab = makeLab();
  try {
    const syn = appendSynthetic(lab.root); // 真正的尾部新增行
    // 调用方声称写了另一行（合法 code/同日 ts，但台账尾部没有它）
    const fake = { ...syn.rec, code: `${syn.rec.code.slice(0, 24)}91000099`, turn: 91000099, seq: 91000099 };
    const r = pi.syncIndex({ root: lab.root, rows: [fake] });
    assert.equal(r.mode, 'rebuild', '调用方行不在尾部必须回退，实际 ' + r.mode);
    assert.match(String(r.reason), /provided-row-not-at-tail|provided-row-day-mismatch/, '原因：' + r.reason);
    assert.equal(pi.statIndex({ root: lab.root, checkDocs: false }).ok, true);
    assert.equal(pi.queryIndex({ root: lab.root, code: fake.code }).length, 0, '伪造行不得进索引');
    // 真正的尾部行在 rebuild 后仍然可查
    assert.equal(pi.queryIndex({ root: lab.root, code: syn.rec.code }).length, 1);
  } finally {
    rmrf(lab.base);
  }
});

// ============================================================================
// 四、tick 接线用例（index.js：stat.index.mode 必须出现，首轮 rebuild / 后续 sync）
// ============================================================================
const TICK_SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const zframe = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const startLine = (turn, time) => JSON.stringify({ type: 'turn/start', time, data: { turn } });
const endLine = (turn, time) => JSON.stringify({ type: 'turn/end', time, data: { turn, reason: { kind: 'stop' } } });

async function withTickLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync094-tick-'));
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

function tickSessionPath(dshHome) {
  return path.join(dshHome, 'sessions', '--lab--', TICK_SID, 'session.v4.jsonl.zstd');
}

/** 首帧 = 会话头；之后每 turn 一帧。返回文件路径。 */
function writeSession(dshHome, { turns = 1 } = {}) {
  const now = Date.now();
  const dir = path.dirname(tickSessionPath(dshHome));
  fs.mkdirSync(dir, { recursive: true });
  const head = JSON.stringify({ type: 'session', id: TICK_SID, createdAt: now - 3600_000, cwd: 'C:\\lab', agentPreset: 'lab' });
  const frames = [[head]];
  for (let t = 1; t <= turns; t++) {
    const at = now - (turns - t + 1) * 300_000;
    frames.push([startLine(t, at), endLine(t, at + 5_000)]);
  }
  fs.writeFileSync(tickSessionPath(dshHome), Buffer.concat(frames.map(zframe)));
  return tickSessionPath(dshHome);
}

/** 追加一轮"刚结束"的会话（增量读会从游标接上）。 */
function appendSessionTurn(dshHome, turn) {
  const now = Date.now();
  fs.appendFileSync(tickSessionPath(dshHome), zframe([startLine(turn, now - 120_000), endLine(turn, now - 115_000)]));
}

function makeCfg(root) {
  return idxTest.readConfig({
    root,
    hotWindowSeconds: 0,
    quietSeconds: 0,
    scanBudgetMs: 30000,
    checkupEnabled: false,
    receiptAnchorRoot: '',
  });
}

async function tick(cfg) {
  idxTest.resetPeriodicThrottle();
  return runOnce({ logger: { info: () => {}, warn: () => {} } }, cfg);
}

test('⑦ 接线：首 tick mode=rebuild/built=true；有新行的一轮 mode=sync/built=false 且索引与台账一致', async () => {
  await withTickLab(async ({ dshHome, root }) => {
    writeSession(dshHome, { turns: 1 });
    const cfg = makeCfg(root);
    const s1 = await tick(cfg);
    assert.equal(s1.written, 1, '首 tick 应写 1 条台账');
    assert.equal(s1.index && s1.index.mode, 'rebuild', '首 tick（.index 不存在）必须如实 mode=rebuild');
    assert.equal(s1.index.built, true, '首 tick built=true（旧口径不回归）');
    assert.equal(s1.index.rows, 1);

    // 追加第 2 轮 → 下一次 tick 只多 1 行，索引必须是"只读新增尾"的 sync
    appendSessionTurn(dshHome, 2);
    const s2 = await tick(cfg);
    assert.equal(s2.written, 1, '第二轮应只写 1 条台账：' + JSON.stringify(s2.errors));
    assert.equal(s2.index && s2.index.mode, 'sync', '有新行且只尾部追加时必须 mode=sync，实际 ' + (s2.index && s2.index.mode) +
      '（' + (s2.index && s2.index.fallback ? s2.index.fallback : '') + '）');
    assert.equal(s2.index.built, false, '纯追加同步不算 built（旧口径：只有整建才 built=true）');
    assert.equal(s2.index.added, 1, 'sync 应 +1 行');
    assert.equal(s2.index.rows, 2, '索引行数 = 台账行数');
    assert.ok(Number(s2.index.bytesRead) <= 4096, 'sync 台账读字节应只有几条新增行量级：' + s2.index.bytesRead);
    assert.equal(s2.errors.length, 0, '干净轮 errors 必须为空：' + JSON.stringify(s2.errors));

    const stat = pi.statIndex({ root, checkDocs: false });
    assert.equal(stat.ok, true, 'tick 后 stat 必须全绿：' + JSON.stringify(stat.problems.slice(0, 3)));
    assert.equal(stat.rows, countLedgerRows(root), '索引行数 = 台账行数');
  });
});
