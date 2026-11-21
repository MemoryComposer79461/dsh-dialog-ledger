/**
 * @file 自测-P0回归.mjs
 * @role P0 七条「不变量」的回归测试 —— 每条对应《施工方向-给编程Agent》的一节。
 * @why 这些测试【现在应该是红的】。红 = 该不变量目前不成立。
 *      改完对应 P0 后应变绿，且【不得】靠改断言迁就实现。
 *
 * 用法（复制进插件目录的 docs/ 之后）：
 *     node --test docs/自测-P0回归.mjs
 *
 * 判据：7 条全绿 = P0 完成。
 * ⚠️ 任何一条变成了"绿但断言被削弱"，视为未完成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const led = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);
const org = await import(pathToFileURL(path.join(SRC, 'lib', 'original.js')).href);
const wk  = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);

const SID = 'session-p0test000001-1111-2222-333344445555';
const T0 = Date.parse('2026-11-09T08:00:00+08:00');

const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const head  = (over = {}) => JSON.stringify({ type: 'session', id: SID, createdAt: T0, cwd: 'C:\\lab', ...over });
const sLine = (t, ms) => JSON.stringify({ type: 'turn/start', time: ms, data: { turn: t } });
const eLine = (t, ms) => JSON.stringify({ type: 'turn/end', time: ms, data: { turn: t, reason: { kind: 'completed' } } });

const quiet = { logger: { info() {}, warn() {}, error() {} } };

function mk(drive = 0) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-' + drive + '-'));
  const root = path.join(base, 'ledger-root');
  const home = path.join(base, 'dsh-home');
  const sessBase = path.join(home, 'sessions');
  const sessDir = path.join(sessBase, 'wsA', SID);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(sessDir, 'session.v4.jsonl.zstd');
  process.env.DSH_HOME = home;
  const cfg = {
    root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
    hotWindowSeconds: 0, quietSeconds: 0, checkupEnabled: false, weeklyEnabled: true,
  };
  return { base, root, home, sessDir, file, cfg };
}

const recs = (root) => led.readAll(root).records;

// ============================================================================
// P0-1 · 源文件变小时，新 Turn 必须入账
// ============================================================================
test('P0-1 源文件变小（12574B→259B）后，新 Turn 仍必须入账', async () => {
  const e = mk(1);

  // 第一版：大文件（用长文本撑到 KB 级），只有 turn 1
  const big = [];
  big.push(head());
  big.push(sLine(1, T0));
  // 塞大量填充事件，把文件撑大（不是拿它当断言对象，只是撑体积）
  for (let i = 0; i < 200; i++) {
    big.push(JSON.stringify({ type: 'step/start', time: T0 + i, data: { turn: 1, step: i } }));
  }
  big.push(eLine(1, T0 + 5000));
  fs.writeFileSync(e.file, frame(big));
  const sizeBig = fs.statSync(e.file).size;

  const r1 = await idx.runOnce(quiet, e.cfg);
  assert.ok(recs(e.root).some((r) => r.turn === 1), 'turn 1 应入账（前置条件）');

  // 第二版：小文件，含新的 turn 2
  fs.writeFileSync(e.file, frame([head(), sLine(2, T0 + 6000), eLine(2, T0 + 7000)]));
  const sizeSmall = fs.statSync(e.file).size;
  assert.ok(sizeSmall < sizeBig, '前置条件：替换后的文件必须更小（' + sizeBig + ' → ' + sizeSmall + '）');

  const r2 = await idx.runOnce(quiet, e.cfg);
  assert.ok(
    recs(e.root).some((r) => r.turn === 2),
    '★ P0-1 未修复：文件缩小后，其中的新 Turn 必须被读到并入账（当前走了 unchanged 快路径）'
  );
});

// ============================================================================
// P0-2 · 未闭合 Turn 之后补 turn/end，最终必须闭合
// ============================================================================
test('P0-2 partial 之后补 turn/end，最终必须是一个完整版本', async () => {
  const e = mk(2);

  // 只有 turn/start，没有 end
  fs.writeFileSync(e.file, frame([head(), sLine(3, T0)]));
  await idx.runOnce(quiet, e.cfg);
  const after1 = recs(e.root).filter((r) => r.turn === 3);
  // 前置：第一轮可能写 partial（也可能不写，取决于实现）
  assert.ok(after1.length <= 1, '前置条件：turn 3 最多一条');

  // 补上 turn/end
  fs.writeFileSync(e.file, frame([head(), sLine(3, T0), eLine(3, T0 + 4000)]));
  await idx.runOnce(quiet, e.cfg);
  const after2 = recs(e.root).filter((r) => r.turn === 3);

  const okRows = after2.filter((r) => r.status === 'ok' || r.status === 'completed' || r.status === 'closed');
  assert.ok(
    okRows.length === 1,
    '★ P0-2 未修复：补 turn/end 后，turn 3 必须有【恰好一个】已闭合版本（当前 partial 入库后永不修正）'
  );
});

// ============================================================================
// P0-4 · 120 / 121 / 122 行的封板哈希必须不同
// ============================================================================
test('P0-4 源记录 120/121/122 条时，封板哈希必须互不相同', async () => {
  const e = mk(4);
  const mkRecs = (n) => Array.from({ length: n }, (_, i) => ({
    v: 3,
    code: '20261109-p0test000001-A-' + String(i + 1).padStart(8, '0'),
    ts: '2026-11-09T' + String(8 + (i % 8)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + ':00+08:00',
    sid: SID, turn: i + 1, seq: i + 1, status: 'ok', doc: '/x.md', docHash: 'a'.repeat(64),
  }));

  const hashes = [];
  for (const n of [120, 121, 122]) {
    const list = mkRecs(n);
    const groups = wk.groupRecords(list, 480);   // Map<string, {w,sessKey,records}>
    const g = [...groups.values()][0];
    assert.ok(g, '前置条件：应能分出至少一组（n=' + n + '）');
    const r = wk.writeWeekly({
      root: e.root,
      w: g.w,
      sessKey: g.sessKey,
      records: g.records,
      offsetMinutes: 480,
      prevHashes: {},
      generatedAt: '2026-11-09T23:59:00+08:00',
    });
    hashes.push(r.hash);
  }

  assert.notEqual(hashes[0], hashes[1], '★ P0-4 未修复：120 条与 121 条封板哈希不得相同');
  assert.notEqual(hashes[1], hashes[2], '★ P0-4 未修复：121 条与 122 条封板哈希不得相同');
});

// ============================================================================
// P0-5 · 工具参数不得无标记截断
// ============================================================================
test('P0-5 4517 字符的工具参数必须能逐字恢复（或至少有显式截断标记）', async () => {
  const e = mk(5);
  const longArg = 'X'.repeat(4517) + '【参数尾部标记】';
  const events = [
    { type: 'turn/start', time: T0, data: { turn: 1 } },
    { type: 'tool/call', time: T0 + 100, seq: 1, data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: longArg }) } },
    { type: 'turn/end', time: T0 + 200, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const rendered = org.renderOriginal({ events, turn: 1, code: '20261109-p0test000001-A-00000001', sid: SID, sessKey: 'k', seq: 1, offsetMinutes: 480 });
  const md = rendered.markdown || '';

  const hasFull = md.includes('【参数尾部标记】');
  const hasMark  = /截断|省略|truncated|omitted|…（.*?字）/i.test(md);

  assert.ok(
    hasFull || hasMark,
    '★ P0-5 未修复：长参数既没有完整保留，也没有显式截断标记（当前静默 slice(0,2000)）'
  );
});

// ============================================================================
// P0-6 · 物理清理默认关闭（只允许 dry-run）
// ============================================================================
test('P0-6 清理在未显式开启时不得物理删除任何文件', async () => {
  const e = mk(6);
  // 造一个"完整原文"文件
  const dir = path.join(e.root, '2026年11月', '11月总“完整原文”');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(dir, '20261109-p0test000001-A-00000001 完整原文.md');
  fs.writeFileSync(victim, '# fake original\n');

  const cl = await import(pathToFileURL(path.join(SRC, 'freeze', 'cleanup.js')).href);
  let deleted = false;
  try {
    if (typeof cl.runCleanup === 'function') {
      await cl.runCleanup({ root: e.root, months: ['2026年11月'], count: 'all', sessions: 'all', dryRun: false, actor: 'test' });
    } else if (typeof cl.planCleanup === 'function') {
      await cl.planCleanup({ root: e.root });
    }
  } catch (_) { /* 拒绝执行也算通过 */ }
  deleted = !fs.existsSync(victim);

  assert.equal(
    deleted, false,
    '★ P0-6 未修复：清理默认不得物理删除（必须显式开启，且 P0 阶段只允许 dry-run）'
  );
});

// ============================================================================
// P0-7① · 凭证排他创建：同编码不同正文不得覆盖
// ============================================================================
test('P0-7① 同编码但不同正文，第二次写必须失败/停摆，不得覆盖', async () => {
  const e = mk(7);
  const a = { root: e.root, y: 2026, m: 11, code: '20261109-p0test000001-A-00000001', markdown: '# 第一版\n' };
  org.writeOriginal(a);

  const file = org.originalDir(e.root, 2026, 11) + path.sep + '20261109-p0test000001-A-00000001 完整原文.md';
  const before = fs.readFileSync(file, 'utf8');

  let threw = false;
  try {
    org.writeOriginal({ ...a, markdown: '# 第二版（不同内容）\n' });
  } catch (_) {
    threw = true;
  }
  const after = fs.readFileSync(file, 'utf8');

  assert.ok(
    threw || after === before,
    '★ P0-7① 未修复：同编码不同正文时必须拒绝覆盖（当前 renameSync 无条件覆盖）'
  );
});

// ============================================================================
// P0-7③ · 失败必须回退游标（不得"失败也推进"）
// ============================================================================
test('P0-7③ 某轮处理失败时，游标不得前进到该轮的末尾', async () => {
  const e = mk(8);

  // 造一个"坏 sid"的会话：id 不合法 → P0-7③ 的典型失败场景
  fs.writeFileSync(e.file, frame([
    JSON.stringify({ type: 'session', id: 'BAD_ID_NO_PREFIX', createdAt: T0, cwd: 'C:\\lab' }),
    sLine(1, T0), eLine(1, T0 + 1000),
  ]));
  const r = await idx.runOnce(quiet, e.cfg);

  const st = led.readState(e.root) || {};
  const cur = st.cursors && st.cursors[e.file] ? st.cursors[e.file].offset : 0;

  // 失败了就不能把游标推到文件末尾
  const failed = (r.errors || []).length > 0;
  if (failed) {
    assert.ok(
      cur < fs.statSync(e.file).size,
      '★ P0-7③ 未修复：本轮有错误，游标不得推进到文件末尾（当前失败也写游标）'
    );
  } else {
    // 没报错也行，但要说明：坏 sid 应该被当成错误而非静默跳过
    assert.fail('★ P0-7③：坏 sid 必须进入 errors（不得静默跳过）');
  }
});
