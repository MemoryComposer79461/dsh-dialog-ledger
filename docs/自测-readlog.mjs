/**
 * @file 自测-readlog.mjs
 * @role V0.6 读行为审计日志的验收（V0.6.4 ③ 起含**滚动分片**）。
 *
 * @why 三条硬要求：①落盘（V1.0 起**不再逐条 fsync**：审计 P1-07 判定"每次 GET 一次 fsync"是磁盘放大；
 *      崩溃丢最后几行只影响读审计完整性、不影响账务）②**不会被当成台账**读进 readAll
 *      ③日志写失败不能把查询本身搞失败（审计失败 ≠ 功能失败）。
 * @why V0.6.4 ④ 条：日志长期高频会无限增长（05 审计 A6），所以按月分文件 + 单文件 8 MiB 切分片；
 *      但**历史审计证据必须是只增不改**——旧分片不重命名/不改写，只能读；
 *      历史单文件 `.reads.jsonl` 保留可读（老库不迁移也能查）。本文件逐条钉住这些语义。
 * @why V1.0 / 审计 P1-07 追加：**总量配额**（默认 64 MiB）——超配额时从最旧整分片删起，
 *      永远保留最新分片与历史单文件；`readReads({summary:true})` 一次遍历同时出列表与摘要。
 * @why V1.0.0-re3 / 审计② P3 追加：总量配额**把历史单文件 `.reads.jsonl` 也计入**（只计字节、
 *      永不删除；旧口径只算分片 → 老库升级后配额名存实亡）。③-4 用例 ③ 钉住这条"旧 → 新"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rl = await import(pathToFileURL(path.join(SRC, 'tools', 'readlog.js')).href);
const led = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);

/** 本地（+08:00）月份 `YYYY-MM`，与实现口径一致。 */
function monthOf(ms) {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`;
}

function lab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  return { base, root };
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 分片文件名 → `{month, serial}`（`YYYY-MM.jsonl`=1，`YYYY-MM.NN.jsonl`=NN）。 */
function parseShardName(name) {
  const m = /^(\d{4}-\d{2})(?:\.(\d{2,}))?\.jsonl$/.exec(name);
  return m ? { month: m[1], serial: m[2] ? Number(m[2]) : 1 } : null;
}

/** `.reads/` 下的分片清单（按**写入顺序**：月份 → 分片序号），含 size/sha/mtime。 */
function shardFiles(root) {
  const dir = rl.readLogDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => ({ name, parsed: parseShardName(name) }))
    .filter((x) => x.parsed)
    .sort((a, b) => (a.parsed.month === b.parsed.month
      ? a.parsed.serial - b.parsed.serial
      : (a.parsed.month < b.parsed.month ? -1 : 1)))
    .map(({ name }) => {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      return { name, abs, size: st.size, mtimeMs: st.mtimeMs, sha: sha(abs) };
    });
}

/** 汇总读日志里所有行（写→读：历史单文件 → 分片按 月份+序号、行序）。 */
function allLogRows(root) {
  const rows = [];
  const legacy = rl.readLogPath(root);
  const files = [];
  if (fs.existsSync(legacy)) files.push(legacy);
  for (const s of shardFiles(root)) files.push(s.abs);
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

test('V0.6/readlog：写入→读回（新→旧）、字段齐全、参数与编码有上限', () => {
  const { base, root } = lab();
  try {
    const NOW = Date.parse('2026-11-08T10:00:00+08:00');
    const r1 = rl.appendRead(root, { tool: 'ledger_search', sessionId: 'sess-1', args: 'sid=x', hitCodes: ['c1', 'c2'], returnedRows: 2, bytes: 100, ms: 3, ledgerDay: '2026-11-08', nowMs: NOW });
    assert.equal(r1.ok, true);
    assert.equal(r1.recorded, true);
    const r2 = rl.appendRead(root, { tool: 'ledger_turn', hitCodes: ['c3'], nowMs: NOW + 1000 });
    assert.equal(r2.ok, true);

    const back = rl.readReads(root, { limit: 10 });
    assert.equal(back.ok, true);
    assert.equal(back.total, 2);
    assert.equal(back.badLines, 0);
    assert.equal(back.rows[0].tool, 'ledger_turn', '返回应按时间新→旧');
    assert.equal(back.rows[1].tool, 'ledger_search');
    const e = back.rows[1];
    for (const k of ['v', 'at', 'tool', 'sessionId', 'args', 'hitCodes', 'returnedRows', 'bytes', 'ms', 'ledgerDay', 'ok']) {
      assert.equal(k in e, true, `字段缺失: ${k}`);
    }
    assert.match(e.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/, 'at 必须是无 Z 的本地时间戳');

    // 上限
    const long = rl.appendRead(root, { tool: 'x'.repeat(200), args: 'y'.repeat(1000), hitCodes: Array.from({ length: 80 }, (_, i) => 'c' + i) });
    assert.equal(long.ok, true);
    const last = rl.readReads(root, { limit: 1 }).rows[0];
    assert.equal(last.tool.length <= 82, true, 'tool 应截断');
    assert.equal(last.args.length <= 241, true, 'args 应截断');
    assert.equal(last.hitCodes.length, 50, 'hitCodes 最多 50 条');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/readlog：读日志不能被当成台账（readAll 必须跳过隐藏 .jsonl 与 .reads/ 目录）', () => {
  const { base, root } = lab();
  try {
    // 旧单文件 + 新分片各写一条，两种位置都不能被 readAll 当成台账
    fs.writeFileSync(rl.readLogPath(root), JSON.stringify({ v: 1, at: '2026-11-08 09:00:00 +08:00', tool: 'legacy' }) + '\n', 'utf8');
    rl.appendRead(root, { tool: 'ledger_search', hitCodes: ['c1'] });
    assert.equal(shardFiles(root).length, 1, '新写入应落 .reads/ 分片');
    const all = led.readAll(root, { repairTornTail: false });
    assert.equal(all.ok, true);
    assert.equal(all.records.length, 0, '读日志必须不被 readAll 当成台账记录');
    assert.equal(all.files, 0, '读日志不该被算作账文件');
    assert.equal(all.badLines, 0, '读日志不能被算坏行');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/readlog：写失败不抛出，只返回 recorded=false（审计失败≠功能失败）', () => {
  const { base, root } = lab();
  try {
    // 把 ledger 目录换成同名文件 → 写日志必然失败
    fs.rmSync(path.join(root, 'ledger'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'ledger'), 'not-a-dir', 'utf8');
    const r = rl.appendRead(root, { tool: 'ledger_search' });
    assert.equal(r.ok, false);
    assert.equal(r.recorded, false);
    assert.match(String(r.reason), /write-failed/, '必须如实报写入失败原因');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/readlog：summarize 给出按工具/会话计数与命中编码总数', () => {
  const { base, root } = lab();
  try {
    rl.appendRead(root, { tool: 'ledger_search', sessionId: 'a', hitCodes: ['c1', 'c2'] });
    rl.appendRead(root, { tool: 'ledger_search', sessionId: 'a', hitCodes: ['c3'] });
    rl.appendRead(root, { tool: 'ledger_turn', sessionId: 'b' });
    const s = rl.summarizeReads(root);
    assert.equal(s.ok, true);
    assert.equal(s.total, 3);
    assert.equal(s.byTool.ledger_search, 2);
    assert.equal(s.byTool.ledger_turn, 1);
    assert.equal(s.bySession.a, 2);
    assert.equal(s.hitCodesTotal, 3);
    assert.match(s.lastAt, /\+08:00/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ===========================================================================
// V0.6.4 ③ 读日志滚动
// ===========================================================================

test('V0.6.4/readlog ③-1：新写入按月落盘 .reads/YYYY-MM.jsonl；不写历史单文件', () => {
  const { base, root } = lab();
  try {
    const NOV = Date.parse('2026-11-30T23:30:00+08:00');
    const DEC = Date.parse('2026-12-01T01:00:00+08:00');
    const rNov = rl.appendRead(root, { tool: 'ledger_search', nowMs: NOV });
    const rDec = rl.appendRead(root, { tool: 'ledger_turn', nowMs: DEC });
    assert.equal(rNov.ok, true);
    assert.equal(rDec.ok, true);

    const dir = rl.readLogDir(root);
    assert.equal(rNov.path, path.join(dir, '2026-11.jsonl'), '11 月写入落 2026-11.jsonl');
    assert.equal(rDec.path, path.join(dir, '2026-12.jsonl'), '12 月写入落 2026-12.jsonl（跨月自动换文件）');
    assert.equal(monthOf(NOV), '2026-11');
    assert.equal(monthOf(DEC), '2026-12');
    assert.deepEqual(shardFiles(root).map((s) => s.name), ['2026-11.jsonl', '2026-12.jsonl']);
    // 历史单文件不再被创建/追加（只读保留）
    assert.equal(fs.existsSync(rl.readLogPath(root)), false, '新逻辑不得再创建 .reads.jsonl');

    const rows = allLogRows(root);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tool, 'ledger_search');
    assert.equal(rows[1].tool, 'ledger_turn');
    const back = rl.readReads(root, { limit: 10 });
    assert.equal(back.total, 2);
    assert.equal(back.rows[0].tool, 'ledger_turn', '跨月后仍按写入顺序新→旧');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6.4/readlog ③-2：超阈值切分片（小阈值注入）；旧分片不改名/不改写；读写顺序正确', () => {
  const { base, root } = lab();
  try {
    const T = 320; // 测试注入的小阈值：不生成 8 MiB 真文件
    const N = 9;
    const now = Date.parse('2026-11-10T12:00:00+08:00');
    const history = new Map(); // name → {sha,mtimeMs,size}（已"封存"的旧分片快照）
    let lastPath = '';
    for (let i = 0; i < N; i += 1) {
      const r = rl.appendRead(root, {
        tool: 'ledger_search', args: 'x'.repeat(120), hitCodes: [`c${i}`],
        nowMs: now + i * 1000,
      }, { maxShardBytes: T });
      assert.equal(r.ok, true, 'append ' + i + ' 失败：' + r.reason);
      // 旧分片（除当前写入的那个以外）字节与 mtime 一律不许变
      for (const s of shardFiles(root)) {
        if (s.abs === r.path) continue;
        const prev = history.get(s.name);
        if (prev) {
          assert.equal(s.sha, prev.sha, `旧分片被改写：${s.name}`);
          assert.equal(s.mtimeMs, prev.mtimeMs, `旧分片 mtime 被改：${s.name}`);
        }
      }
      // 本次写入后把"已经不是最新"的分片纳入历史快照
      const files = shardFiles(root);
      for (const s of files) {
        if (s.abs === r.path && s.size + 200 <= T) continue; // 还可能继续追加
        if (!history.has(s.name)) history.set(s.name, { sha: s.sha, mtimeMs: s.mtimeMs, size: s.size });
      }
      lastPath = r.path;
    }
    const files = shardFiles(root);
    assert.ok(files.length >= 2, `阈值 ${T} 下 ${N} 条应切出多个分片（实际 ${files.length}）`);
    // 命名：第一份 YYYY-MM.jsonl，后续 .02/.03…
    assert.equal(files[0].name, '2026-11.jsonl');
    for (let i = 1; i < files.length; i += 1) {
      assert.match(files[i].name, /^2026-11\.\d{2,}\.jsonl$/, '后续分片命名不符：' + files[i].name);
    }
    // 所有行都在（总行数 == N，无丢行）
    const rows = allLogRows(root);
    assert.equal(rows.length, N, `行数=${rows.length}（应 ${N}）`);
    assert.deepEqual(rows.map((r) => r.hitCodes[0]), Array.from({ length: N }, (_, i) => `c${i}`), '分片内/间行序 == 写入顺序');
    // 除最后一个分片外，其余分片都应封存且不大于阈值
    for (const s of files.slice(0, -1)) assert.ok(s.size <= T, `已切走的旧分片超过阈值：${s.name} size=${s.size}`);
    // readReads：total 口径不变、顺序新→旧
    const back = rl.readReads(root, { limit: 100 });
    assert.equal(back.total, N);
    assert.equal(back.badLines, 0);
    assert.deepEqual(back.rows.map((r) => r.hitCodes[0]), Array.from({ length: N }, (_, i) => `c${N - 1 - i}`), 'readReads 必须新→旧');
    assert.equal(back.path, lastPath, 'path 指向最新分片');
    // 再写一条：只有最新分片变，历史分片一个字节都不动
    const beforeFinal = new Map(files.map((s) => [s.name, s]));
    const rFinal = rl.appendRead(root, { tool: 'ledger_turn', nowMs: now + 99_000 }, { maxShardBytes: T });
    const afterFinal = shardFiles(root);
    for (const s of afterFinal) {
      const b = beforeFinal.get(s.name);
      if (!b) continue; // 新切出的分片
      if (s.abs === rFinal.path) continue;
      assert.equal(s.sha, b.sha, '再写一条后历史分片被改写：' + s.name);
      assert.equal(s.mtimeMs, b.mtimeMs, '再写一条后历史分片 mtime 被改：' + s.name);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6.4/readlog ③-3：兼容历史单文件 .reads.jsonl（只读、不被改写），并计数坏行', () => {
  const { base, root } = lab();
  try {
    const now = Date.parse('2026-11-10T12:00:00+08:00');
    const legacy = rl.readLogPath(root);
    const legacyRows = [
      JSON.stringify({ v: 1, at: '2026-11-01 09:00:00 +08:00', tool: 'legacy-a' }),
      '{ 这不是合法 JSON 的行', // 坏行必须可定位（badLines）
      JSON.stringify({ v: 1, at: '2026-11-02 09:00:00 +08:00', tool: 'legacy-b' }),
    ];
    fs.writeFileSync(legacy, legacyRows.join('\n') + '\n', 'utf8');
    const legacyBefore = { sha: sha(legacy), mtimeMs: fs.statSync(legacy).mtimeMs, size: fs.statSync(legacy).size };

    // 升级后继续写：新分片里再落 2 条（其中 1 条手工注入坏行）
    rl.appendRead(root, { tool: 'new-1', nowMs: now });
    rl.appendRead(root, { tool: 'new-2', nowMs: now + 1000 });
    const shard = shardFiles(root)[0];
    fs.appendFileSync(path.join(rl.readLogDir(root), shard.name), '{坏行2\n', 'utf8');

    const back = rl.readReads(root, { limit: 10 });
    assert.equal(back.ok, true);
    assert.equal(back.total, 4, '历史 2 条 + 新分片 2 条 = total 4');
    assert.equal(back.badLines, 2, '历史坏行 1 + 新分片坏行 1 = badLines 2');
    assert.deepEqual(back.rows.map((r) => r.tool), ['new-2', 'new-1', 'legacy-b', 'legacy-a'], '汇总后新→旧');
    // 历史单文件一个字节都不许动（旧证据只读）
    assert.equal(sha(legacy), legacyBefore.sha, '历史 .reads.jsonl 不得被改写');
    assert.equal(fs.statSync(legacy).mtimeMs, legacyBefore.mtimeMs, '历史 .reads.jsonl mtime 不得变');
    assert.equal(fs.statSync(legacy).size, legacyBefore.size, '历史 .reads.jsonl 大小不得变');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ★ 契约变更（V1.0 / 准入审计 P1-07，旧 → 新）：
//   旧：appendRead 每写一条就读一次 `fs.fsyncSync`（"读记录也必须耐久"）；
//   新：**不再每条 fsync** —— 面板轮询会让"每次 GET 一次 fsync"变成持续磁盘放大；
//       读日志属运行区，崩溃丢最后几行只影响读审计完整性、不影响账务，
//       且新增了总量配额（超配额删最旧分片）。本用例改为钉住"不 fsync + 行确实落盘 + 配额生效"。
// ★ V1.0.0-re3 追加契约变更（审计② P3，旧 → 新）：
//   旧：总量配额只把 `<root>/ledger/.reads/` 分片计入，历史单文件 `.reads.jsonl` **不计** → 老库升级后
//       该文件再大也不会触发裁剪，64 MiB 上限名存实亡；
//   新：总量 = 历史单文件 + 分片合计；历史单文件**只计字节、永不删除**（用户旧审计证据不动），
//       所以它越大分片越早被裁。本用例 ②/③ 分别钉住"分片配额"与"历史单文件计入"两个半边。
test('V1.0/readlog ③-4：append 不再逐条 fsync（P1-07），但行必须落盘；总量配额从最旧分片裁起（re3 起含历史单文件）', () => {
  const { base, root } = lab();
  try {
    // ① 不再 fsync，且行确实写进去、可读回
    const orig = fs.fsyncSync;
    let calls = 0;
    fs.fsyncSync = function patched(fd) { calls += 1; return orig.call(fs, fd); };
    let r;
    try {
      r = rl.appendRead(root, { tool: 'ledger_search' });
      assert.equal(r.ok, true);
      assert.equal(r.recorded, true);
    } finally {
      fs.fsyncSync = orig;
    }
    assert.equal(calls, 0, 'appendRead 不许再逐条 fsync（审计 P1-07：每次 GET 一次 fsync 是磁盘放大）');
    const back = rl.readReads(root, { limit: 5 });
    assert.equal(back.total, 1, '不 fsync 也必须真正落盘（可读回）');
    assert.equal(back.rows[0].tool, 'ledger_search');

    // ② 总量配额：造 3 个旧分片 → 超配额时从最旧开始整文件删，永远保留最新分片 + 历史单文件
    const dir = rl.readLogDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const blob = (n) => JSON.stringify({ v: 1, at: '2026-10-01 00:00:00 +08:00', tool: 'x', args: 'y'.repeat(n), sessionId: '', hitCodes: [], returnedRows: 0, bytes: 0, ms: 0, ledgerDay: '', ok: true }) + '\n';
    fs.writeFileSync(path.join(dir, '2026-09.jsonl'), blob(1000), 'utf8');
    fs.writeFileSync(path.join(dir, '2026-10.jsonl'), blob(1000), 'utf8');
    fs.writeFileSync(path.join(dir, '2026-11.jsonl'), blob(1000), 'utf8');
    const legacy = rl.readLogPath(root);
    fs.writeFileSync(legacy, '{"legacy":1}\n', 'utf8');
    const q = rl.appendRead(root, { tool: 'quota', nowMs: Date.parse('2026-11-14T02:00:00Z') }, { maxTotalBytes: 1200 });
    assert.equal(q.ok, true);
    assert.ok(Array.isArray(q.retainedRemoved) && q.retainedRemoved.length >= 1, '超配额必须裁掉最旧分片');
    // 三个旧分片各 ~1100 B、配额 1200 B：从最旧删到"只剩最新分片"为止（最新分片永不删）
    assert.deepEqual(q.retainedRemoved, ['2026-09.jsonl', '2026-10.jsonl'], '从最旧开始裁');
    assert.equal(fs.existsSync(path.join(dir, '2026-09.jsonl')), false, '最旧分片已删');
    assert.equal(fs.existsSync(path.join(dir, '2026-11.jsonl')), true, '最新分片必须保留（正在写的那个）');
    assert.equal(fs.existsSync(legacy), true, '历史单文件 .reads.jsonl 永不删（不动用户旧证据）');

    // ③ ★ V1.0.0-re3 / 审计② P3（旧 → 新）：总量配额必须**把历史单文件也计入**。
    //    旧口径：只算分片 → 历史 2.5 KB + 分片 0.8 KB 在 1.2 KB 配额下**一行不裁**（配额名存实亡）；
    //    新口径：历史单文件计入总量（但永不删除）→ 必须从最旧分片裁起，直到只剩最新分片。
    const q2 = path.join(base, 'quota-legacy');
    const q2led = path.join(q2, 'ledger');
    const q2dir = path.join(q2led, '.reads');
    fs.mkdirSync(q2dir, { recursive: true });
    const blob2 = (n, tool) => JSON.stringify({
      v: 1, at: '2026-10-01 00:00:00 +08:00', tool, sessionId: '', args: 'y'.repeat(n),
      hitCodes: [], returnedRows: 0, bytes: 0, ms: 0, ledgerDay: '', ok: true,
    }) + '\n';
    fs.writeFileSync(path.join(q2led, '.reads.jsonl'), blob2(2300, 'legacy'), 'utf8'); // 历史单文件 ~2.5 KB
    fs.writeFileSync(path.join(q2dir, '2026-09.jsonl'), blob2(200, 'old-09'), 'utf8');
    fs.writeFileSync(path.join(q2dir, '2026-10.jsonl'), blob2(200, 'old-10'), 'utf8');
    const q2r = rl.appendRead(q2, { tool: 'quota-legacy', nowMs: Date.parse('2026-11-14T02:00:00Z') }, { maxTotalBytes: 1200 });
    assert.equal(q2r.ok, true);
    assert.deepEqual(q2r.retainedRemoved, ['2026-09.jsonl', '2026-10.jsonl'],
      '历史单文件计入总量后，分片必须被裁到只剩最新（旧口径此处不裁 = 红）');
    assert.equal(fs.existsSync(path.join(q2led, '.reads.jsonl')), true, '历史单文件只计字节、永不删除');
    assert.equal(fs.existsSync(path.join(q2dir, '2026-11.jsonl')), true, '最新分片永不删除');

    // ③ 非法 root：一个字节都不写（appendRead 自己就拒，不靠调用方守规矩）
    for (const bad of ['', 'relative/root', 'C:\\']) {
      const x = rl.appendRead(bad, { tool: 'bad' });
      assert.equal(x.ok, false);
      assert.equal(x.reason, 'unsafe-root');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V1.0/readlog：readReads({summary:true}) 一次遍历同时出列表与摘要（P1-07：不再整读两遍）', () => {
  const { base, root } = lab();
  try {
    // 造 600 条（> 旧 summarizeReads 的 500 行窗口）：摘要必须覆盖全部，而不是只数前 500
    for (let i = 0; i < 600; i += 1) {
      rl.appendRead(root, { tool: i % 2 === 0 ? 'panel:ping' : 'ledger_search', hitCodes: ['a', 'b'] });
    }
    const r = rl.readReads(root, { limit: 3, summary: true });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 3, '列表只给 limit 条（内存窗口，不整读进数组）');
    assert.equal(r.total, 600, 'total = 全部可解析行数');
    assert.equal(r.summary.total, 600);
    assert.deepEqual(r.summary.byTool, { 'panel:ping': 300, ledger_search: 300 }, '摘要覆盖全部 600 条（旧实现只到 500）');
    assert.equal(r.summary.hitCodesTotal, 1200);
    assert.equal(typeof r.summary.lastAt, 'string');
    // summarizeReads 与一次性摘要同口径
    const s = rl.summarizeReads(root);
    assert.equal(s.total, 600);
    assert.deepEqual(s.byTool, r.summary.byTool);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6.4/readlog ③-5：不认识的 .reads/ 条目不被当成日志；空目录/不存在目录安全返回空', () => {
  const { base, root } = lab();
  try {
    // 不存在 .reads/ → 空结果、ok:true
    let r = rl.readReads(root, { limit: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.total, 0);
    // 手工放一个不认识的文件 → 不计入 total/badLines（不猜）
    fs.mkdirSync(rl.readLogDir(root), { recursive: true });
    fs.writeFileSync(path.join(rl.readLogDir(root), 'notes.txt'), '不是日志\n', 'utf8');
    rl.appendRead(root, { tool: 'ledger_search' });
    r = rl.readReads(root, { limit: 5 });
    assert.equal(r.total, 1);
    assert.equal(r.badLines, 0);
    assert.equal(r.rows[0].tool, 'ledger_search');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
