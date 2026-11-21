/**
 * @file 自测-pointerindex.mjs
 * @role 0.9.4 P3 档 A「指针索引外部层」的自测（≤6 用例，串行、自包含、不依赖 _工作 里的 lab）。
 *
 * @why 索引是**派生物**，最容易骗人的是"看起来有、其实指错"。所以本自测的核心不是"能查出来"，
 *      而是三条硬不变量：
 *        ① 指针可复算：`read(台账日文件, offset, bytes)` 的字节 == readAll 那条记录的字节；
 *        ② 视图可复核：索引 d 解码 == 原文视图整文件 sha256 == 台账 docFileSha256；
 *        ③ 坏必须红：改原文 / 删分片 / 索引与台账不一致，`statIndex` 必须给出 problems[]（不许静默当绿）。
 *      另外还有一条"只写 .index"的纪律断言：build/query/stat 前后，除 `.index/` 外全库字节不变。
 *
 * 用法：node docs/自测-pointerindex.mjs   （退出码 0 = 全过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pi = await import(pathToFileURL(path.join(SRC, 'tools', 'pointerindex.mjs')).href);
const { readAll } = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── 夹具：12 行 / 3 个台账日 / 3 个会话 ─────────────────────────────────────
// 关键形状：会话 B 的 code 日期段是 20261108（会话开始日），但它的轮次落在 2026-11-09 的台账日文件里
// —— 这正是实测 E3 库（1,320/1,338 行）"code 日 ≠ 台账日"的形状，索引分片必须以台账日为准。
// sid 必须满足 encoder 的归一化口径：normalizeSessionId(sid) 的前 12 位 == s12（否则按 sid 查会查不到）。
const SESSIONS = [
  { s12: 'aaaaaaaaaaaa', sid: 'session-aaaaaaaa-aaaa-1111-2222-333333333333', codeDate: '20261108', dayIso: '2026-11-08', turns: 4 },
  { s12: 'bbbbbbbbbbbb', sid: 'session-bbbbbbbb-bbbb-1111-2222-333333333333', codeDate: '20261108', dayIso: '2026-11-09', turns: 3 },
  { s12: 'cccccccccccc', sid: 'session-cccccccc-cccc-1111-2222-333333333333', codeDate: '20261110', dayIso: '2026-11-10', turns: 5 },
];

function makeRow({ s12, sid, codeDate, dayIso, turn }) {
  const code = `${codeDate}-${s12}-A-${String(turn).padStart(8, '0')}`;
  return {
    v: 3,
    code,
    ts: `${dayIso}T${String(9 + turn).padStart(2, '0')}:00:00+08:00`,
    sid,
    turn,
    seq: turn,
    status: 'ok',
    turnState: 'closed',
    src: 'session.v4.jsonl.zstd',
    doc: '', // 由 lab() 填
    docHash: '',
    docSha256: '',
    docFileSha256: '',
    attachment: { name: `${code} 原始事件.json`, sha256: sha256(`${code}#events`), bytes: 10, eventsCount: 2, reused: false },
    docFrom: 0,
    dateOffset: 480,
  };
}

/** 造一个独立临时账库（含台账日文件 + 原始视图）；返回 {base, root, records}。 */
function lab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pointerindex-selftest-'));
  const root = path.join(base, 'root');
  const led = path.join(root, 'ledger');
  fs.mkdirSync(led, { recursive: true });
  fs.writeFileSync(path.join(root, '.ledger-root'), JSON.stringify({ v: 1, root: 'selftest' }) + '\n', 'utf8');
  const records = [];
  const cols = new Map(); // dayIso -> [row,...]
  for (const s of SESSIONS) {
    for (let t = 1; t <= s.turns; t++) {
      const row = makeRow({ ...s, turn: t });
      const mm = s.codeDate.slice(4, 6);
      const rel = path.join(`${s.codeDate.slice(0, 4)}年${mm}月`, `${mm}月总“完整原文”`, `${row.code} 完整原文.md`);
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // 内容不要求像真视图，只要求"每轮不同、整文件可复算"
      const content = `---\n编码: '${row.code}'\n会话: '${row.sid}'\n轮次: ${t}\n---\n\n# ${row.code} 完整原文\n\n## 1. user/message\n\n第 ${t} 轮测试原文（自测夹具）。\n`;
      fs.writeFileSync(abs, content, 'utf8');
      row.doc = rel;
      row.docHash = sha256(`body:${row.code}`);
      row.docSha256 = row.docHash;
      row.docFileSha256 = sha256(fs.readFileSync(abs));
      records.push(row);
      if (!cols.has(s.dayIso)) cols.set(s.dayIso, []);
      cols.get(s.dayIso).push(row);
    }
  }
  for (const [dayIso, rows] of cols) {
    fs.writeFileSync(path.join(led, `${dayIso}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return { base, root, records };
}

/** 全库（除 ledger/.index 外）文件 → sha256，用于"只写 .index"断言。 */
function snapshotOutsideIndex(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (st.isDirectory()) {
        if (rel === 'ledger/.index') continue;
        walk(abs);
      } else {
        out.push(rel + ':' + sha256(fs.readFileSync(abs)));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** 台账日文件里独立定位一行（不复用索引的 offset 计算）：返回 {offset,bytes,raw}。 */
function locate(root, dayYmd, code) {
  const iso = `${dayYmd.slice(0, 4)}-${dayYmd.slice(4, 6)}-${dayYmd.slice(6, 8)}`;
  const buf = fs.readFileSync(path.join(root, 'ledger', `${iso}.jsonl`));
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    pos = nl === -1 ? buf.length : nl + 1;
    if (end === start) continue;
    const raw = buf.subarray(start, end).toString('utf8');
    if (raw.trim()) {
      const rec = JSON.parse(raw);
      if (rec.code === code) return { offset: start, bytes: end - start, raw };
    }
  }
  return null;
}

function shardPath(root, dayYmd) {
  return path.join(pi.indexDir(root), `idx-${dayYmd}.jsonl`);
}

function readShardRows(root, dayYmd) {
  const abs = shardPath(root, dayYmd);
  return fs.readFileSync(abs, 'utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ============================================================================
// 用例 1：build 的形状 + 幂等 + 只写 .index
// ============================================================================
test('① build：12 行→3 个日分片（行数/字节/无 null 偏移），重建幂等，且只在 .index/ 落盘', () => {
  const { base, root } = lab();
  try {
    const before = snapshotOutsideIndex(root);
    const r1 = pi.buildIndex({ root });
    assert.equal(r1.ok, true, 'build 不应有 problems: ' + JSON.stringify(r1.problems));
    assert.equal(r1.rows, 12, '索引行数必须 = 台账行数');
    assert.equal(r1.shards, 3, '3 个台账日 → 3 个日分片');
    assert.deepEqual(Object.keys(r1.byDay), ['20261108', '20261109', '20261110']);
    assert.equal(r1.byDay['20261108'].rows, 4, 'code 日 20261108 的 4 行在 20261108 台账日');
    assert.equal(r1.byDay['20261109'].rows, 3, '会话 B（code 日 20261108）的轮次必须落在 20261109 分片');
    assert.equal(r1.byDay['20261110'].rows, 5);
    assert.equal(r1.offsetNull, 0, '台账文件名合规时偏移必须全部可确定');
    assert.equal(r1.docShaNull, 0);
    assert.ok(r1.bytes > 0 && r1.bytesPerRow > 90 && r1.bytesPerRow < 140, '瘦行预算：实测 ' + r1.bytesPerRow + ' B/行');
    // 每个分片里 o/n 都是整数、d 是 43 位 base64url
    for (const day of ['20261108', '20261109', '20261110']) {
      const rows = readShardRows(root, day);
      for (const row of rows) {
        assert.ok(Number.isInteger(row.o) && row.o >= 0, 'offset 必须是整数');
        assert.ok(Number.isInteger(row.n) && row.n > 0, 'bytes 必须是正整数');
        assert.equal(pi.docShaFromField(row.d).length, 64, 'd 必须能解码成 64-hex');
      }
    }
    // 幂等：内容没变 → 不重写
    const r2 = pi.buildIndex({ root });
    assert.equal(r2.rows, 12);
    assert.equal(r2.written, 0, '第二次 build 不应重写任何分片');
    assert.equal(r2.unchanged, 3);
    // stat 全绿
    const s = pi.statIndex({ root });
    assert.equal(s.ok, true, 'stat 应全绿: ' + JSON.stringify(s.problems.slice(0, 5)));
    assert.equal(s.rows, 12);
    assert.equal(s.shards, 3);
    assert.equal(s.stateMatch, true);
    assert.equal(s.docsChecked, true);
    assert.deepEqual(s.problems, []);
    // 纪律：除 .index/ 外全库一个字节不变
    assert.deepEqual(snapshotOutsideIndex(root), before, 'build 只许写 .index/，台账/原文一个字节都不许动');
    assert.deepEqual(fs.readdirSync(pi.indexDir(root)).sort(), ['.idx-state.json', 'idx-20261108.jsonl', 'idx-20261109.jsonl', 'idx-20261110.jsonl']);
  } finally {
    rmrf(base);
  }
});

// ============================================================================
// 用例 2：按 code 查 → 指针字节 + 原文视图字节都对得上 readAll
// ============================================================================
test('② query(code)：全 12 条逐字节对撞 —— 指针切片、readAll 记录、原文视图 sha256 三者一致', () => {
  const { base, root, records } = lab();
  try {
    pi.buildIndex({ root });
    const all = readAll(root, { repairTornTail: false });
    assert.equal(all.records.length, 12);
    for (const rec of all.records) {
      const rows = pi.queryIndex({ root, code: rec.code });
      assert.equal(rows.length, 1, '按 code 必须恰好命中 1 行: ' + rec.code);
      const row = rows[0];
      assert.equal(row.pointerOk, true, '指针必须有效: ' + row.pointerError);
      assert.equal(row.ts, rec.ts);
      assert.equal(row.sid, rec.sid);
      assert.equal(row.turn, rec.turn);
      assert.equal(row.doc, rec.doc);
      assert.equal(row.docFileSha256, rec.docFileSha256);
      // ① 指针字节 == 台账文件里该行的原始字节（=== JSON.stringify(readAll 记录)）
      const loc = locate(root, row.day, rec.code);
      assert.ok(loc, '独立定位应能找到台账行');
      assert.equal(row.offset, loc.offset, 'offset 必须等于台账行字节偏移');
      assert.equal(row.bytes, loc.bytes, 'bytes 必须等于台账行字节数');
      const slice = fs.readFileSync(path.join(root, 'ledger', `${row.day.slice(0, 4)}-${row.day.slice(4, 6)}-${row.day.slice(6, 8)}.jsonl`))
        .subarray(row.offset, row.offset + row.bytes).toString('utf8');
      assert.equal(slice, loc.raw, '指针切片必须逐字节等于台账行');
      assert.equal(JSON.stringify(rec), loc.raw, 'readAll 记录的规范 JSON 必须逐字节等于台账行');
      // ② 原文视图整文件 sha256 == 索引 d == 台账 docFileSha256
      const viewSha = sha256(fs.readFileSync(path.join(root, rec.doc)));
      assert.equal(viewSha, row.docFileSha256, '视图整文件 sha256 必须等于索引 d');
      assert.equal(viewSha, rec.docFileSha256, '视图整文件 sha256 必须等于台账 docFileSha256');
      // ③ 分片日 == 台账 ts 日（不是 code 日）
      assert.equal(row.day, rec.ts.slice(0, 10).replace(/-/g, ''));
    }
    // 未命中必须给边界回执，不许静默空数组
    const miss = pi.queryIndex({ root, code: '20991231-000000000000-A-00000001' });
    assert.equal(miss.length, 0);
    assert.ok(miss.meta && miss.meta.searchedRange, '未命中必须带 searchedRange');
    assert.equal(typeof miss.meta.hint, 'string');
    assert.ok(miss.meta.hint.length > 0, '未命中必须给 hint');
  } finally {
    rmrf(base);
  }
});

// ============================================================================
// 用例 3：sid / turn / range 三种查询与 readAll 过滤结果集逐 code 对撞
// ============================================================================
test('③ query(sid/turn/range)：结果集与 readAll 过滤一致，覆盖 code 日≠台账日', () => {
  const { base, root } = lab();
  try {
    pi.buildIndex({ root });
    const all = readAll(root, { repairTornTail: false });
    const sidB = SESSIONS[1].sid;
    const bySid = pi.queryIndex({ root, sid: sidB, limit: 100 });
    const expectSid = all.records.filter((r) => r.sid === sidB).map((r) => r.code).sort();
    assert.equal(expectSid.length, 3);
    assert.deepEqual(bySid.map((r) => r.code).sort(), expectSid, '按 sid 查询必须命中该会话 3 行');
    // sid 精确性：即使短 ID 相同，也不能把别的会话带出来 —— 用另一个 sid 再查一次
    assert.equal(pi.queryIndex({ root, sid: SESSIONS[0].sid }).every((r) => r.sid === SESSIONS[0].sid), true);
    // sid + turn
    const byTurn = pi.queryIndex({ root, sid: sidB, turn: 2 });
    assert.equal(byTurn.length, 1);
    assert.equal(byTurn[0].code, `${SESSIONS[1].codeDate}-${SESSIONS[1].s12}-A-00000002`);
    assert.equal(byTurn[0].sid, sidB);
    // range：按台账日（ts 日）切，命中 11-09 的 3 行 + 11-10 的 5 行
    const byRange = pi.queryIndex({ root, range: '20261109..20261110', limit: 100 });
    const expectRange = all.records
      .filter((r) => { const d = r.ts.slice(0, 10).replace(/-/g, ''); return d >= '20261109' && d <= '20261110'; })
      .map((r) => r.code).sort();
    assert.equal(expectRange.length, 8);
    assert.deepEqual(byRange.map((r) => r.code).sort(), expectRange, '按日范围查询必须精确');
    // 会话 B 的 code 日是 20261108，但轮次在 20261109 分片 —— 按 code 日查范围会漏，文档已写清这正是分片按台账日的原因
    assert.equal(byRange.some((r) => r.code === `${SESSIONS[1].codeDate}-${SESSIONS[1].s12}-A-00000001`), true);
  } finally {
    rmrf(base);
  }
});

// ============================================================================
// 用例 4：反证 · 删分片 / 删整索引 → stat 必须红；重建后绿（索引是派生物）
// ============================================================================
test('④ 反证：删 1 个分片 / 删整个 .index → stat 必须红（problems 非空）；build 重建后绿', () => {
  const { base, root } = lab();
  try {
    pi.buildIndex({ root });
    assert.equal(pi.statIndex({ root }).ok, true);
    // 删 1 个日分片
    fs.unlinkSync(shardPath(root, '20261109'));
    const s1 = pi.statIndex({ root });
    assert.equal(s1.ok, false, '删分片后 stat 不许当绿');
    const kinds1 = new Set(s1.problems.map((p) => p.kind));
    assert.ok(kinds1.has('count-mismatch') || kinds1.has('missing-index-row'), '必须报"索引少了行": ' + [...kinds1]);
    assert.equal(s1.stateMatch, false, '状态文件必须对不上');
    pi.buildIndex({ root });
    assert.equal(pi.statIndex({ root }).ok, true, '重建后必须绿（C29）');
    // 删整个 .index
    fs.rmSync(pi.indexDir(root), { recursive: true, force: true });
    const s2 = pi.statIndex({ root });
    assert.equal(s2.ok, false, '索引目录被删后 stat 不许当绿');
    assert.ok(new Set(s2.problems.map((p) => p.kind)).has('index-missing'));
    pi.buildIndex({ root });
    assert.equal(pi.statIndex({ root }).ok, true, '整目录重建后必须绿');
  } finally {
    rmrf(base);
  }
});

// ============================================================================
// 用例 5：反证 · 索引与台账不一致（指针偏移被改）→ stat 红 + query 标注 pointerOk=false
// ============================================================================
test('⑤ 反证：改索引行 offset（与台账不一致）→ stat 报 pointer-mismatch，query 标 pointerOk=false', () => {
  const { base, root } = lab();
  try {
    pi.buildIndex({ root });
    const abs = shardPath(root, '20261108');
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const i = lines.findIndex((x) => x.trim());
    const row = JSON.parse(lines[i]);
    const goodOffset = row.o;
    row.o = row.o + 1; // 挪 1 字节
    lines[i] = JSON.stringify(row);
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    const s = pi.statIndex({ root });
    assert.equal(s.ok, false, '索引与台账不一致时 stat 不许当绿');
    const pointerProblems = s.problems.filter((p) => p.kind === 'pointer-mismatch');
    assert.ok(pointerProblems.length >= 1, '必须报 pointer-mismatch: ' + JSON.stringify(s.problems.map((p) => p.kind)));
    assert.equal(pointerProblems[0].indexOffset, goodOffset + 1);
    // query 也不能"查到了就当对"：指针取不回那条台账行 → pointerOk=false
    const rows = pi.queryIndex({ root, code: row.c });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pointerOk, false, '指针不可解析时必须标 pointerOk=false');
    assert.ok(rows[0].pointerError);
    // 重建后恢复
    pi.buildIndex({ root });
    assert.equal(pi.statIndex({ root }).ok, true);
  } finally {
    rmrf(base);
  }
});

// ============================================================================
// 用例 6：反证 · 改原文 → stat 的原文复核必须红；重建索引也掩盖不了
// ============================================================================
test('⑥ 反证：改一个原文视图文件 → stat（默认自动复核视图）报 view-sha-mismatch；重建索引仍红', () => {
  const { base, root, records } = lab();
  try {
    pi.buildIndex({ root });
    const target = records[0];
    const viewAbs = path.join(root, target.doc);
    fs.appendFileSync(viewAbs, '\n【自测反证：原文被改动】\n', 'utf8');
    const s = pi.statIndex({ root });
    assert.equal(s.ok, false, '原文被改后 stat 不许当绿');
    assert.equal(s.docsChecked, true, '小库默认必须自动复核原文视图');
    const viewProblems = s.problems.filter((p) => p.kind === 'view-sha-mismatch');
    assert.ok(viewProblems.length >= 1, '必须报 view-sha-mismatch: ' + JSON.stringify(s.problems.map((p) => p.kind)));
    assert.equal(viewProblems.some((p) => p.code === target.code), true);
    // 重建索引只抄台账里的 sha（台账没变），所以掩盖不了"原文被改" —— 这是有意的
    pi.buildIndex({ root });
    const s2 = pi.statIndex({ root });
    assert.equal(s2.ok, false, '重建索引不许把"原文被改"洗绿');
    // --no-docs 是显式放弃原文复核；此时必须如实标 docsChecked:false（而不是假装查过）
    const s3 = pi.statIndex({ root, checkDocs: false });
    assert.equal(s3.docsChecked, false);
    assert.equal(s3.docsSkippedReason, 'disabled');
  } finally {
    rmrf(base);
  }
});
