/**
 * @file 自测-D线-运行时.mjs
 * @role D 线（运行时与内核）整改的**行为级**自测：把 2026-11-13 准入审计里属于
 *       index.js / lib/sealjournal.js / lib/frames.js / core-manifest.json 的每一条
 *       都钉成可复跑断言（"旧契约 → 新契约"的边界写在每条注释里）。
 *
 * 覆盖（审计编号 → 断言）：
 *   m-01  Config 未声明            → buildConfigSchema(桩) 27 输入/默认值一致；无 schemastery 时 Config=undefined
 *   P1-01 封板 journal 链恒真      → 重复行/重复 key/时间回退/rows 被改/存在但被清空 → 必须红；
 *                                    健康 journal → ok；无 journal → ok 但 verifiable=false（不许冒充"验过"）
 *   P1-02 tick 硬顶只约束扫描段    → .tick-metrics 的 phases 必须有 indexMs/catalogMs/receiptMs/monthlyMs，
 *                                    budget.overHardCap 按**实测耗时**判定，deferredSegments 可读
 *   P1-03 时间预算不补游标         → fillUnvisitedCursors（两条预算路径共用）必须给未轮到会话补 partialCommit
 *   P1-04 ledgerCache 常驻无上限   → 超过上限的行数 → cache.ephemeral=true（本轮照用、随后淘汰）
 *   P1-05 解压后无上限             → 解压炸弹 → skipped/oversizedDecompressed，**不 halted**，正常帧照解
 *   P1-10 core-manifest 与实物不符 → 清单与磁盘/import 逐一相容（本用例直接跑边界检查器等价的集合比对）
 *   m7    索引失败无退避/卸载不打断 → 退避状态可读可复位；dispose 会 abort（源码级断言 + apply/dispose 冒烟）
 *
 * 纪律：本文件只断言**当前真实行为**；不为了让红变绿放宽阈值。
 *      与生产代码同仓（docs/），随包交付，接收端可离线复跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import * as plugin from '../index.js';
import { appendSealEvent, verifySealChain, sealJournalPath } from '../lib/sealjournal.js';
import { streamFrames } from '../lib/frames.js';

const T = plugin.__test__;

/** 临时根（每用例独立；结束时删除）。 */
function makeRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dline-${tag}-`));
  return { dir, root: path.join(dir, 'root') };
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

/** 一条最小合法周账封板事件（appendSealEvent 会补 v/at/rowsSha256/sealHash）。 */
function sealEvent(key, rows) {
  return {
    kind: 'weekly-seal', key, rows, rowCount: rows.length, sourceRowCount: rows.length, overflow: 0,
    sessKey: 'sess-' + key, year: 2026, month: 11, weekNo: 2, offsetMinutes: 480,
    sealedAt: '2026-11-13 22:00:00', gid: 'g-' + key, file: 'w-' + key + '.xlsx', layoutVersion: 6,
  };
}
function pickSeal(r) {
  return { ok: r.ok, verifiable: r.verifiable, events: r.events, chainBroken: r.chainBroken, badLines: r.badLines, v: (r.violations || []).map((x) => x.reason) };
}

// ============================================================================
// 桩 schemastery：只要 object/string/number/boolean + 链式 default/required/description
// ============================================================================
function stubSchema() {
  const mk = (kind) => ({
    kind, def: undefined, desc: '', requiredFlag: null, fields: null,
    default(v) { this.def = v; return this; },
    description(d) { this.desc = d; return this; },
    required(f) { this.requiredFlag = f; return this; },
  });
  return {
    string: () => mk('string'),
    number: () => mk('number'),
    boolean: () => mk('boolean'),
    object: (fields) => { const n = mk('object'); n.fields = fields; return n; },
  };
}

// ============================================================================
// m-01 · Config 声明（27 输入 = 24 扁平键 + ingest 3 子键；默认值与 DEFAULTS 一致）
// ============================================================================
test('m-01：Config 声明 27 个输入，默认值与 DEFAULTS 一致，且全部 required(false)', () => {
  const schema = T.buildConfigSchema(stubSchema());
  assert.ok(schema && typeof schema === 'object', '有可用 Schema 时必须构造出 Config');
  assert.equal(schema.kind, 'object');

  const fields = schema.fields;
  const tops = Object.keys(fields);
  assert.equal(tops.length, 25, '顶层 25 键（含 ingest 对象）');

  // 24 个扁平输入 + ingest 的 3 个子键 = 27（rootSource 是派生值，不是输入）
  const leaves = tops.filter((k) => k !== 'ingest');
  assert.equal(leaves.length, 24, '扁平输入 24 个');
  assert.deepEqual(Object.keys(fields.ingest.fields).sort(), ['mode', 'shadowMaxSessions', 'shadowPendingMs']);
  assert.equal(leaves.length + Object.keys(fields.ingest.fields).length, 27, '总计 27 个输入');

  // 默认值必须与 DEFAULTS 逐键相等（否则配置页显示的值 ≠ 记账实际走的值）
  for (const k of leaves) {
    assert.equal(fields[k].def, T.DEFAULTS[k], `Config.${k} 默认值必须等于 DEFAULTS.${k}`);
  }
  assert.equal(fields.ingest.fields.mode.def, T.DEFAULTS.ingest.mode);
  assert.equal(fields.ingest.fields.shadowPendingMs.def, T.DEFAULTS.ingest.shadowPendingMs);
  assert.equal(fields.ingest.fields.shadowMaxSessions.def, T.DEFAULTS.ingest.shadowMaxSessions);

  // 全部可选（缺省走 readConfig/DEFAULTS 兜底）
  for (const k of tops) {
    if (k === 'ingest') continue;
    assert.equal(fields[k].requiredFlag, false, `Config.${k} 必须 required(false)`);
  }
  for (const k of Object.keys(fields.ingest.fields)) {
    assert.equal(fields.ingest.fields[k].requiredFlag, false, `Config.ingest.${k} 必须 required(false)`);
  }

  // 类型必须与 DEFAULTS 值类型一致（number/boolean/string）
  for (const k of leaves) {
    const d = T.DEFAULTS[k];
    const want = typeof d === 'number' ? 'number' : typeof d === 'boolean' ? 'boolean' : 'string';
    assert.equal(fields[k].kind, want, `Config.${k} 类型应为 ${want}`);
  }
});

test('m-01：解析不到 schemastery 时 Config=undefined（不破坏激活），且 readConfig 行为不变', () => {
  assert.equal(T.buildConfigSchema(null), undefined);
  assert.equal(T.buildConfigSchema({}), undefined);
  assert.equal(T.buildConfigSchema({ object: () => { throw new Error('boom'); } }), undefined, '构造抛错也必须降级为 undefined');
  // 本机解析不到 schemastery（零依赖约束下的预期分支）→ 模块仍可加载、Config 为 undefined
  assert.equal(T.getConfigSchema(), undefined, '本机无 schemastery：Config 必须保持 undefined（等价修复前）');
  // readConfig 28 键（27 输入 + rootSource 派生），且 enabled 缺省为开
  const c = T.readConfig({});
  assert.equal(Object.keys(c).length, 28);
  assert.equal(c.enabled, true);
});

// ============================================================================
// P1-01 · 封板 journal 可校验性诚实化（旧契约：恒 ok:true → 新契约：结构性可验）
// ============================================================================
test('P1-01：健康 journal → ok；重复/时间回退/快照被改/被清空 → 必须红；无 journal → 不许冒充"验过"', () => {
  const { dir } = makeRoot('seal1');
  const root = path.join(dir, 'root');
  try {
    // ① 无 journal：ok（不是错误）但 verifiable=false —— "没有可校验对象"不等于"验过了"
    const none = verifySealChain(root);
    assert.equal(none.ok, true);
    assert.equal(none.verifiable, false);
    assert.match(none.reason, /no-journal/);

    // ② 健康 2 条 → ok/verifiable
    appendSealEvent(root, sealEvent('g1', [['c1', 'd1', '10:00', 'ok']]));
    appendSealEvent(root, sealEvent('g2', [['c2', 'd2', '10:01', 'ok']]));
    const healthy = verifySealChain(root);
    assert.equal(healthy.ok, true, '健康 journal 必须 ok');
    assert.equal(healthy.verifiable, true);
    assert.equal(healthy.events, 2);
    assert.equal(healthy.chainBroken, 0);

    const file = sealJournalPath(root);
    // ③ 整行重复（伪造追加）→ DUPLICATE_LINE + DUPLICATE_KEY
    const rawLines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.appendFileSync(file, rawLines[1] + '\n');
    const dup = pickSeal(verifySealChain(root));
    assert.equal(dup.ok, false, '重复行必须红（旧实现恒 true）');
    assert.ok(dup.v.includes('DUPLICATE_LINE'));
    assert.ok(dup.v.includes('DUPLICATE_KEY'));

    // ④ 时间回退（把首行 at 改成更晚、第二行更早）→ TIME_REGRESSION
    const objs = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    objs[0].at = '2026-11-13 23:00:00';
    objs[1].at = '2026-11-13 21:00:00';
    fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
    const reg = pickSeal(verifySealChain(root));
    assert.equal(reg.ok, false);
    assert.ok(reg.v.includes('TIME_REGRESSION'), '时间回退必须被抓住');

    // ⑤ rows 快照被改（sha 复算不符）→ ROWS_SHA_MISMATCH
    const root2 = path.join(dir, 'root2');
    appendSealEvent(root2, sealEvent('g9', [['c9', 'd9', '11:00', 'ok']]));
    const f2 = sealJournalPath(root2);
    const o2 = JSON.parse(fs.readFileSync(f2, 'utf8').trim());
    o2.rows[0][0] = 'TAMPERED';
    fs.writeFileSync(f2, JSON.stringify(o2) + '\n');
    const tam = pickSeal(verifySealChain(root2));
    assert.equal(tam.ok, false);
    assert.ok(tam.v.includes('ROWS_SHA_MISMATCH'));

    // ⑥ 文件存在但被清空 → JOURNAL_EMPTY（journal 只在首次封板时创建，空文件=被清空/写崩）
    const root3 = path.join(dir, 'root3');
    fs.mkdirSync(path.join(root3, 'ledger'), { recursive: true });
    fs.writeFileSync(sealJournalPath(root3), '');
    const empty = pickSeal(verifySealChain(root3));
    assert.equal(empty.ok, false, '存在但空的 journal 必须红（审计复现的第一种形态）');
    assert.ok(empty.v.includes('JOURNAL_EMPTY'));
  } finally { cleanup(dir); }
});

// ============================================================================
// P1-05 · 解压后上限（旧契约：无上限 → 新契约：超限=结构化 loss，不 OOM、不 halt）
// ============================================================================
test('P1-05：解压炸弹 → skipped/oversizedDecompressed，不 halted，后续正常帧照解', () => {
  const { dir } = makeRoot('frames');
  try {
    const file = path.join(dir, 's.zstd');
    const normal = zlib.zstdCompressSync(Buffer.from('{"a":1}\n'));
    const bomb = zlib.zstdCompressSync(Buffer.alloc(3 * 1024 * 1024, 0x78)); // 115 B 压缩 → 3 MiB 解压
    assert.ok(bomb.length < 1024, '炸弹本身必须很小（否则不是"压缩炸弹"场景）');
    fs.writeFileSync(file, Buffer.concat([normal, bomb, normal]));

    // 默认上限（64 MiB）下 3 MiB 不算炸弹 → 3 帧全解
    const okRun = streamFrames(file, 0, () => {});
    assert.equal(okRun.ok, 3);
    assert.equal(okRun.oversizedDecompressed, 0);

    // 把上限压到 1 MiB → 炸弹必须被结构化跳过，其它帧照解，且**不 halted**
    const seen = [];
    const r = streamFrames(file, 0, (txt) => seen.push(txt.length), { maxDecompressedBytes: 1024 * 1024 });
    assert.equal(r.ok, 2, '炸弹前后的正常帧都要解出来（旧实现会 OOM，不是"少一帧"）');
    assert.equal(r.failed, 1);
    assert.equal(r.skipped, 1);
    assert.equal(r.oversizedDecompressed, 1, '必须单独计数（与坏帧区分）');
    assert.equal(r.halted, false, '解压超限不是坏帧：不许把整份会话判死');
    assert.equal(r.decompressLimitBytes, 1024 * 1024);
    assert.equal(r.failedRanges.filter((x) => x.oversizedDecompressed).length, 1, '超限帧必须可按字节区间留痕');
    assert.deepEqual(seen, [8, 8]);
    // 其它读法不受影响：默认上限仍能解
    assert.equal(streamFrames(file, 0, () => {}).ok, 3);
  } finally { cleanup(dir); }
});

// ============================================================================
// P1-04 · 常驻索引缓存上限（旧契约：无上限 → 新契约：超限即"不常驻"，本轮照用、随后淘汰）
// ============================================================================
test('P1-04：台账行数超过常驻上限 → cache.ephemeral=true（本轮照用，随后淘汰，不丢账）', () => {
  const { dir, root } = makeRoot('cache');
  try {
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 5; i++) {
      lines.push(JSON.stringify({
        v: 3, code: `20261108-v05test00000-A-${String(i).padStart(8, '0')}`,
        ts: '2026-11-08 10:00:0' + (i % 10), sid: 'sid-cache', turn: i, status: 'ok',
      }));
    }
    fs.writeFileSync(path.join(ledgerDir, '2026-11-08.jsonl'), lines.join('\n') + '\n');

    // 上限 2 < 5 行 → 必须标 ephemeral
    T.setLedgerCacheCaps(2);
    const cache = T.ensureLedgerIndex(root);
    assert.equal(cache.rowCount, 5, '本轮仍必须看到全部行（不丢账）');
    assert.equal(cache.ephemeral, true, '超上限必须标记为"不常驻"');
    const peek = T.peekLedgerCache();
    assert.equal(peek.rowCount, 5);
    assert.equal(peek.ephemeral, true);
    assert.equal(peek.records, 5, '本轮 records 完整（周账分组要用）');

    // 上限 100 → 不触发淘汰（先清缓存，否则会命中上一次的常驻对象）
    T.clearLedgerCache();
    T.setLedgerCacheCaps(100);
    const cache2 = T.ensureLedgerIndex(root);
    assert.equal(cache2.ephemeral, false);
  } finally {
    T.setLedgerCacheCaps(0); // 恢复默认上限
    cleanup(dir);
  }
});

// ============================================================================
// P1-03 · 时间预算提前收工必须补"未轮到"游标（与字节预算同构）
// ============================================================================
test('P1-03：fillUnvisitedCursors 给未轮到且无游标的会话补 partialCommit 游标（时间/字节两条路径共用）', () => {
  const sessions = [
    { path: 'a.zstd', size: 10, mtimeMs: 1 },
    { path: 'b.zstd', size: 20, mtimeMs: 2 },
    { path: 'c.zstd', size: 30, mtimeMs: 3 },
  ];
  const cursors = { 'a.zstd': { offset: 0, size: 10 } }; // a 已有游标
  const filled = [];
  const n = T.fillUnvisitedCursors(sessions, 1, cursors, (ss) => {
    filled.push(ss.path);
    cursors[ss.path] = { offset: 0, size: ss.size, partialCommit: true };
  });
  assert.equal(n, 2, '从第 1 个起的 2 个未轮到会话都要补');
  assert.deepEqual(filled, ['b.zstd', 'c.zstd']);
  assert.equal(cursors['b.zstd'].partialCommit, true);
  assert.equal(cursors['c.zstd'].partialCommit, true);
  assert.equal(cursors['a.zstd'].partialCommit, undefined, '已有游标的不动');
  // 幂等：再跑一次不再重复补
  const n2 = T.fillUnvisitedCursors(sessions, 1, cursors, () => { throw new Error('不该再补'); });
  assert.equal(n2, 0);

  // ★ 静态同构断言：时间预算分支必须调用同一个 helper（防止将来只改一边）
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const timeBranch = src.slice(src.indexOf('if (Date.now() >= deadline) {'));
  const block = timeBranch.slice(0, timeBranch.indexOf('// ★ 0.9.3 P2-4'));
  assert.match(block, /fillUnvisitedCursors\(/, '时间预算提前 break 必须补未轮到游标（审计 P1-03）');
});

// ============================================================================
// P1-02 · tick 时间预算的计量（.tick-metrics：分阶段 + 超顶标记 + 跳段名单）
// ============================================================================
test('P1-02：一次真实 tick 必须把 index/catalog/receipt/monthly 段计入 .tick-metrics，且 overHardCap 按实测判定', async () => {
  const { dir, root } = makeRoot('tick');
  const dshHome = path.join(dir, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    const cfg = T.readConfig({ root, intervalSeconds: 60, scanBudgetMs: 30000 });
    const logs = [];
    const ctx = { logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) } };
    T.resetPeriodicThrottle();
    await plugin.runOnce(ctx, cfg);

    const metricsPath = path.join(root, 'ledger', '.tick-metrics.jsonl');
    assert.ok(fs.existsSync(metricsPath), '必须落 .tick-metrics.jsonl');
    const last = JSON.parse(fs.readFileSync(metricsPath, 'utf8').trim().split('\n').pop());
    for (const k of ['scanMs', 'eventsMs', 'persistMs', 'weeklyMs', 'reconcileMs', 'reportMs', 'indexMs', 'catalogMs', 'receiptMs', 'monthlyMs']) {
      assert.equal(typeof last.phases[k], 'number', `.tick-metrics 必须计量 ${k}（旧口径只计量扫描段）`);
    }
    assert.equal(typeof last.phases.otherMs, 'number');
    assert.equal(last.budget.hardMs, 28000);
    assert.equal(last.budget.overHardCap, false, '空库 tick 不该超硬顶');
    assert.ok(Array.isArray(last.budget.deferredSegments), 'deferredSegments 必须是数组（跳段可观测）');
    assert.equal(last.timeDeferredSessions, 0);
    assert.equal(typeof last.cache.degraded, 'boolean');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    cleanup(dir);
  }
});

// ============================================================================
// P1-10 · core-manifest 与实物一致（边界检查器消费同一份清单）
// ============================================================================
test('P1-10：core-manifest 的 coreFiles/coreCount/outsiders.tools/indexAllowlist 与磁盘/import 逐一相容', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'core-manifest.json'), 'utf8'));
  const diskCore = fs.readdirSync(path.join(root, 'lib')).filter((x) => x.endsWith('.js')).map((x) => `lib/${x}`).sort();
  assert.deepEqual([...manifest.coreFiles].sort(), diskCore, 'coreFiles 必须等于磁盘 lib/*.js');
  assert.equal(manifest.coreCount, diskCore.length, 'coreCount 必须等于实测数（旧注写"按 21 计"是过期口径）');
  const diskTools = fs.readdirSync(path.join(root, 'tools')).map((x) => `tools/${x}`).sort();
  assert.deepEqual([...manifest.outsiders.tools].sort(), diskTools, 'outsiders.tools 必须等于磁盘 tools/*');
  // index.js 实际 import 的 tools 必须全部声明（旧清单写 3 条、实物 4 条 → 审计 P1-10）
  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const actual = [...idx.matchAll(/from '\.\/tools\/([^']+)'/g)].map((m) => `tools/${m[1]}`).sort();
  assert.deepEqual([...manifest.indexAllowlist.tools].sort(), actual, 'indexAllowlist.tools 必须等于 index.js 实际 import');
  assert.ok(actual.includes('tools/pointerindex.mjs'), 'pointerindex 这条边必须被声明（旧清单漏了它）');
});

// ============================================================================
// m7 · 索引失败退避 + 卸载打断 in-flight tick
// ============================================================================
test('m7：索引退避状态可读可复位；dispose 会 abort（源码级断言）+ apply/dispose 冒烟不抛', () => {
  // ① 退避状态机（模块级）
  T.resetIndexBackoff();
  assert.deepEqual(T.peekIndexBackoff(), { fails: 0, untilMs: 0 });
  // ② 源码级：失败分支必须记退避、下一轮必须能读 mode:'backoff'；dispose 必须 abort
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /moduleIndexBackoff = \{ fails, untilMs:/, '索引失败必须记退避');
  assert.match(src, /mode: 'backoff'/, '退避期内必须可观测（tick-metrics 里 index.mode=backoff）');
  assert.match(src, /stopController\.abort\(\)/, 'dispose 必须打断 in-flight tick');
  assert.match(src, /if \(disposed \|\| running\) return/, '卸载后不许再开新 tick');

  // ③ apply/dispose 冒烟：无任何宿主服务时也要能装、能卸（不抛）
  const { dir, root } = makeRoot('apply');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(dir, 'dsh-home');
  try {
    const ctx = { logger: { info: () => {}, warn: () => {} }, effect: (fn) => { ctx._dispose = fn(); } };
    const ret = plugin.apply(ctx, { root, intervalSeconds: 3600, enabled: true });
    assert.equal(ret, undefined, '有 ctx.effect 时不返回函数（卸载交给 effect）');
    assert.equal(typeof ctx._dispose, 'function', 'dispose 必须已注册');
    ctx._dispose();
    ctx._dispose(); // 二次卸载不许抛
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    cleanup(dir);
  }
});
