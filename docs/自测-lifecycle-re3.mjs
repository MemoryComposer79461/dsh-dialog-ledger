/**
 * @file 自测-lifecycle-re3.mjs
 * @role v1.0.0-re3 · A 线（index.js 生命周期/配置/挂载/度量）的回归自测。
 *
 * @why 审计③ 对 re2 的结论：核心记账正确，但**生命周期与证据层**有缺陷：
 *   · ARCH-01 卸载不静止：dispose 同步返回，tick() 未 await → 旧实例卸载后仍写盘（双写）；
 *   · FAIL-01  坏帧源"已提交前缀=0"不落游标 → 热窗口 1 h 后静默永不再记；
 *   · FAIL-03  锁跳过/取锁失败的 tick 零度量零错误（只有 INFO 日志）；
 *   · checkupEnabled 语义反转：null/0/""/"false" 全部当"开"；enabled/weeklyEnabled 同病；
 *   · Config 裸 `import('schemastery')` 在真机解析不到（宿主只有 @deepseek-ai/schemastery）；
 *   · ARCH-04 挂载 2 min 后永久放弃且用户不可见；HMR 后不恢复；
 *   · RT-01   全量对账轮真读字节未计量（产品侧只报估算）。
 *
 * 纪律：每条 test 上方「守：」写明防的是哪种回归；失败信息必须能直接指向审计项。
 * 运行：node docs/跑测试.mjs docs/自测-lifecycle-re3.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce, apply, __test__ } from '../index.js';
import { readAll, ledgerDir } from '../lib/ledger.js';
import { readTickMetrics } from '../lib/tickmetrics.js';

/** 合成会话的完整 id。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** 会话开始时刻（固定值）：2026-11-08 09:00:00 +08:00。 */
const CREATED_AT = Date.parse('2026-11-08T09:00:00+08:00');
/** DSH 会话文件名（固定）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd';

// ============================================================================
// 一、测试基础设施（临时 home / 合成会话 / 替身）—— 口径与 自测-index.mjs 一致
// ============================================================================

async function withLab(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-lc-'));
  assert.match(path.basename(root), /^dl-lc-/);
  const dshHome = path.join(root, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const dataRoot = path.join(root, 'data');
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ root, dshHome, dataRoot });
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const frame = (lineArr) => zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));
const startLine = (turn, time) => JSON.stringify({ type: 'turn/start', time, data: { turn } });
const endLine = (turn, time, kind = 'stop') => JSON.stringify({ type: 'turn/end', time, data: { turn, reason: { kind } } });

/**
 * 合成一个会话文件。
 * @param {string} dshHome
 * @param {{frames?:string[][], rawFrames?:Buffer[], sid?:string, createdAt?:number, mtimeMs?:number|null}} [opts]
 */
function writeSessionFile(dshHome, opts = {}) {
  const { sid = SID, createdAt = CREATED_AT, frames = [], rawFrames = null, mtimeMs = null } = opts;
  const dir = path.join(dshHome, 'sessions', '--lab--', sid);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);
  const headLine = JSON.stringify({ type: 'session', id: sid, createdAt, cwd: 'C:\\lab\\synthetic', agentPreset: 'lab' });
  const parts = [frame([headLine])];
  if (rawFrames) parts.push(...rawFrames);
  else for (const lines of frames) parts.push(frame(lines));
  fs.writeFileSync(p, Buffer.concat(parts));
  if (mtimeMs !== null) {
    const d = new Date(mtimeMs);
    fs.utimesSync(p, d, d);
  }
  return p;
}

function makeCfg(root, over = {}) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: 480,
    hotWindowSeconds: 0,
    quietSeconds: 120,
    ...over,
  };
}

function fakeLogger() {
  const infoLines = [];
  const warnLines = [];
  return {
    infoLines,
    warnLines,
    info: (...a) => infoLines.push(a.join(' ')),
    warn: (...a) => warnLines.push(a.join(' ')),
  };
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 10) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('waitFor 超时：条件在 ' + timeoutMs + 'ms 内未成立');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stateFileOf = (dataRoot) => path.join(ledgerDir(dataRoot), '.state.json');

/** 递归目录快照：相对路径 → 大小:mtime。 */
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const st = fs.statSync(p);
        out.set(path.relative(root, p), st.size + ':' + st.mtimeMs);
      } catch { /* 消失的临时文件不算 */ }
    }
  };
  walk(root);
  return out;
}

function diffSnapshot(a, b) {
  const changed = [];
  for (const [k, v] of b) {
    if (!a.has(k)) changed.push('+ ' + k);
    else if (a.get(k) !== v) changed.push('~ ' + k);
  }
  for (const [k] of a) if (!b.has(k)) changed.push('- ' + k);
  return changed;
}

/** 等目录写入静止（连续 quietMs 无变化），给"旧实现卸载后还在写"用。 */
async function waitQuiet(root, quietMs = 400, timeoutMs = 8000) {
  const start = Date.now();
  let last = '';
  let stableAt = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = JSON.stringify([...snapshotTree(root)].sort());
    if (cur === last) {
      if (Date.now() - stableAt >= quietMs) return true;
    } else {
      last = cur;
      stableAt = Date.now();
    }
    await sleep(50);
  }
  return false;
}

/** 把全局定时器换成记账替身（与 自测-index.mjs 同法；含 unref）。 */
function installTimerStubs() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervals = [];
  const cleared = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { cleared.push(handle); };
  return {
    intervals,
    cleared,
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

/**
 * ★ P0 探针：把 tick 内"批间让出事件循环"的 setImmediate 变成可控暂停点。
 * @why 这样能在 tick **在跑**时调用卸载，复现审计③ ARCH-01 的现场（旧 dispose 同步返回后
 *      tick 继续跑完并写盘）。等价于审计的"注入延迟"探针，但不需要改 lib。
 */
function captureSetImmediate() {
  const real = globalThis.setImmediate;
  const queue = [];
  globalThis.setImmediate = (fn, ...args) => {
    queue.push(() => fn(...args));
    return { __probe: true };
  };
  return {
    queue,
    release(count = 1) {
      let n = 0;
      while (n < count && queue.length > 0) {
        const fn = queue.shift();
        n += 1;
        fn();
      }
      return n;
    },
    drain() { while (queue.length > 0) this.release(1); },
    restore() { globalThis.setImmediate = real; },
  };
}

/** 取最近一条 tick-metrics 记录。 */
function lastMetric(root) {
  const m = readTickMetrics(root);
  return { metrics: m, last: m.records.length ? m.records[m.records.length - 1] : null };
}

// ============================================================================
// 二、P0 · ARCH-01 卸载不静止
// ============================================================================

test('P0 ARCH-01：dispose 返回 Promise、等在跑 tick 收敛；resolve 后 1.5 s 零写盘', async () => {
  // 守：旧 dispose 只 abort+clearInterval 就同步返回；在跑的那一轮继续把剩余批/周账/对账
  //     写进数据总库（审计③实测 unloaded 之后仍写 7 个文件）→ 热重载双写、账只追加不可删。
  //     新口径：dispose 返回 Promise，等 in-flight tick 收敛；中止后未提交的写丢弃，
  //     只落 .state 提交点，派生段一律不写。
  await withLab(async ({ dshHome, dataRoot }) => {
    // 40 轮 → eventBatchTurns=32 → 必然跨 2 批，中间有一次 setImmediate 让出（探针暂停点）。
    const frames = [];
    for (let i = 1; i <= 40; i++) {
      frames.push([startLine(i, CREATED_AT + i * 1000), endLine(i, CREATED_AT + i * 1000 + 400)]);
    }
    writeSessionFile(dshHome, { frames });

    const timers = installTimerStubs();
    const ctl = captureSetImmediate();
    const log = fakeLogger();
    const disposers = [];
    try {
      const ctx = { logger: log, get: () => null, effect(fn) { const d = fn(); disposers.push(d); return d; } };
      const ret = apply(ctx, { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 });
      assert.equal(ret, undefined, '有 ctx.effect 时 apply 不应靠返回值清理');

      // 第一批落账前让出一次 → 放行；再次暂停时第一批（32 行）已经同步写进台账。
      await waitFor(() => ctl.queue.length >= 1, 5000);
      ctl.release(1);
      await waitFor(() => ctl.queue.length >= 1, 5000);
      assert.ok(fs.existsSync(path.join(ledgerDir(dataRoot))), '第一批应已写入台账（暂停点在批边界）');

      const dispose = disposers[0];
      assert.equal(typeof dispose, 'function', 'ctx.effect 必须注册清理函数');
      const p1 = dispose();
      assert.equal(typeof p1?.then, 'function', '★ ARCH-01：dispose 必须返回 Promise（旧实现同步返回）');
      const p2 = dispose();
      assert.equal(p2, p1, 'dispose 必须幂等（重复调用返回同一个收敛 Promise）');

      ctl.release(1); // 放行被暂停的 tick：中止后它只能收尾到 .state 提交点
      const out = await p1;
      assert.equal(out && out.converged, true, 'dispose 必须报告"已收敛"');

      const snapA = snapshotTree(dataRoot);
      await sleep(1500);
      const snapB = snapshotTree(dataRoot);
      const changed = diffSnapshot(snapA, snapB);
      assert.deepEqual(changed, [], '★ ARCH-01：卸载 resolve 后 1.5 s 内出现写盘：' + changed.slice(0, 8).join(', '));
      assert.ok(timers.cleared.length >= 1, '扫描定时器/挂载重试必须在卸载时被 clearInterval');

      // 中止轮只提交 .state，派生段未写：证据在 state 与 tick-metrics 里都能查。
      const state = JSON.parse(fs.readFileSync(stateFileOf(dataRoot), 'utf8'));
      assert.equal(state.abortedCommit, true, '中止轮必须落 .state 提交点（abortedCommit=true）');
      const { last } = lastMetric(dataRoot);
      assert.ok(last, '中止轮也必须留 tick-metrics 记录');
      assert.equal(last.cancelled, true, 'tick-metrics.cancelled 必须如实为 true');
      assert.equal(last.abortedCommit, true, 'tick-metrics.abortedCommit 必须为 true');
    } finally {
      ctl.drain();
      await sleep(300);
      ctl.restore();
      timers.restore();
    }
  });
});

// ============================================================================
// 三、P1 · FAIL-01 坏帧源已提交前缀=0 也要落游标
// ============================================================================

test('P1 FAIL-01：已提交前缀=0 的坏帧源也落 blocked 游标；热窗口后仍重试且错误可见', async () => {
  // 守：源 = [会话头帧][好帧][半截尾帧] → halted=true / failed=1 / 没有已闭合轮次 →
  //     prefixCommittedByte=0、fromByte=0。旧条件 `targetOffset>0 || fromByte>0` 为假 → 不写游标；
  //     下一 tick 文件 mtime 一旦落到 hotWindow(1h) 之外，源被静默过滤，修好也不续记。
  await withLab(async ({ dshHome, dataRoot }) => {
    const longFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'note', pad: 'x'.repeat(400) }) + '\n'));
    const file = writeSessionFile(dshHome, {
      rawFrames: [
        zlib.zstdCompressSync(Buffer.from('{"type":"note"}\n')),
        longFrame.subarray(0, Math.floor(longFrame.length / 2)), // 半截尾帧 → halted/truncated-tail
      ],
    });

    const log1 = fakeLogger();
    const stat1 = await runOnce({ logger: log1 }, makeCfg(dataRoot, { hotWindowSeconds: 0 }));
    assert.equal(stat1.scanned, 1);
    assert.ok(stat1.blockedSources >= 1, '坏帧源必须计入 blockedSources');
    assert.ok(stat1.errors.some((e) => String(e).includes('source blocked')), '坏帧必须每 tick 可见（errors）');

    const state = JSON.parse(fs.readFileSync(stateFileOf(dataRoot), 'utf8'));
    const cur = state.sourceCursors && state.sourceCursors[file];
    assert.ok(cur, '★ FAIL-01：坏帧源即使已提交前缀=0 也必须落游标（否则会被热窗口永久过滤）');
    assert.equal(cur.blocked, true, '游标必须标 blocked=true（下一 tick 可重试、且免热窗口过滤）');
    assert.equal(cur.offset, 0, '已提交前缀=0 → offset 必须是 0');
    assert.equal(typeof cur.haltOffset, 'number');

    // 文件 mtime 落到热窗口之外；旧实现因无游标被静默过滤（scanned=0/零错误）。
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    fs.utimesSync(file, new Date(twoHoursAgo), new Date(twoHoursAgo));
    const log2 = fakeLogger();
    const stat2 = await runOnce({ logger: log2 }, makeCfg(dataRoot, { hotWindowSeconds: 3600 }));
    assert.equal(stat2.scanned, 1, '★ FAIL-01：blocked 游标必须免于热窗口过滤（旧实现 scanned=0）');
    assert.equal(stat2.hotWindowExempted, 1, '热窗口例外必须被计数');
    assert.ok(stat2.errors.some((e) => String(e).includes('source blocked')), '热窗口之外也必须每 tick 报错，不许静默');
    assert.equal(readAll(dataRoot).records.length, 0, '坏帧源本轮不能凭空多出行');
  });
});

// ============================================================================
// 四、P1 · FAIL-03 锁跳过 / 取锁失败 tick 的度量与可见错误
// ============================================================================

test('P1 FAIL-03：LOCK_HELD 的 tick 写 .tick-metrics + WARN 可见（保留 INFO 口径）', async () => {
  // 守：旧实现抢不到锁只 log.info 一句就 return，既没有 tick-metrics 也没有 warn/errors ——
  //     运维在"每 tick 一行"的度量里看不到"这一轮为什么什么都没做"，也无法事后统计锁冲突。
  await withLab(async ({ root }) => {
    const dataRoot = path.join(root, 'lockheld-data');
    fs.mkdirSync(path.join(dataRoot, 'ledger'), { recursive: true });
    // 造一把"活锁"：pid=当前进程（不判死）、心跳新鲜（不判僵死），token 与本进程持锁表不同。
    const lockFile = path.join(dataRoot, 'ledger', '.lock');
    const nowIso = new Date().toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({
      v: 1, pid: process.pid, token: 'other-instance-token', hostname: os.hostname(),
      startedAt: nowIso, heartbeatAt: nowIso, heartbeatAtMs: Date.now(),
    }), 'utf8');

    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
    assert.equal(stat.lockSkipped, true);
    assert.equal(String(stat.errors.join('\n')).includes('LOCK_HELD'), true, '返回值 errors 必须含 LOCK_HELD');
    assert.ok(log.infoLines.some((l) => l.includes('LOCK_HELD')), '既有 INFO 口径必须保留（C05 守卫用例）');
    assert.ok(log.warnLines.some((l) => l.includes('LOCK_HELD')), '★ FAIL-03：锁跳过必须有 WARN（不能只 INFO）');

    const { metrics, last } = lastMetric(dataRoot);
    assert.equal(metrics.readError, '', 'tick-metrics 必须可读：' + metrics.readError);
    assert.ok(metrics.records.length >= 1, '★ FAIL-03：锁跳过的 tick 必须写 .tick-metrics 记录');
    assert.equal(last.lockSkipped, true, 'tick-metrics.lockSkipped 必须为 true');
    assert.equal(last.lock && last.lock.skipped, true, 'tick-metrics.lock.skipped 必须为 true');
    assert.equal(last.lock && last.lock.reason, 'held', 'tick-metrics.lock.reason 必须写清 held');
    assert.ok(Array.isArray(last.errors) && last.errors.some((e) => String(e).includes('LOCK_HELD')), '度量行必须带错误文案');
    assert.equal(typeof last.ms, 'number', '度量行必须带 ms（设备自检会按缺字段判红）');
  });
});

test('P1 FAIL-03：取锁失败（真实 IO 故障）同样写 .tick-metrics + WARN', async () => {
  // 守：acquire 抛错（权限/磁盘/占位异常）也是"本轮不写"，旧实现只有一条 warn 后 return，
  //     度量层完全看不到这种轮次；现在必须留结构化记录（reason=acquire-failed）。
  await withLab(async ({ root }) => {
    const dataRoot = path.join(root, 'acquirefail-data');
    fs.mkdirSync(path.join(dataRoot, 'ledger'), { recursive: true });
    const realOpenSync = fs.openSync;
    // 只在 acquire 的排他创建那一次抛 EACCES，模拟"锁文件建不出来"的 IO 故障。
    fs.openSync = function patchedOpenSync(p, flags, ...rest) {
      if (typeof p === 'string' && p.endsWith('.lock') && flags === 'wx') {
        const err = new Error('EACCES: permission denied, open lock');
        err.code = 'EACCES';
        throw err;
      }
      return realOpenSync.call(fs, p, flags, ...rest);
    };
    try {
      const log = fakeLogger();
      const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
      assert.equal(stat.lockSkipped, true);
      assert.ok(String(stat.lockError || '').includes('EACCES'), '返回值必须带取锁失败原因');
      assert.ok(log.warnLines.some((l) => l.includes('取锁失败')), '取锁失败必须有 WARN');
      const { last } = lastMetric(dataRoot);
      assert.ok(last, '★ FAIL-03：取锁失败的 tick 必须写 .tick-metrics');
      assert.equal(last.lock && last.lock.reason, 'acquire-failed');
      assert.ok(String((last.lock && last.lock.error) || '').includes('EACCES'), '度量行必须带失败原因');
      assert.equal(stat.lockSkipped, true);
    } finally {
      fs.openSync = realOpenSync;
    }
  });
});

// ============================================================================
// 五、P1 · checkupEnabled 反转 + enabled/weeklyEnabled 严格布尔
// ============================================================================

test('P1 布尔开关：checkupEnabled/enabled/weeklyEnabled 只认布尔 true（null/0/""/"false" 不得当开启）', async () => {
  // 守：旧 `c.checkupEnabled !== false` 让 null/0/""/"false" 全部开启体检（报告只增不减，
  //     在数据总库一级持续堆 CHK 文件）；enabled/weeklyEnabled 同病（"false" 字符串当开）。
  const rc = __test__.readConfig;
  assert.equal(typeof rc, 'function');
  const notOn = [null, 0, '', 'false', '0', 1, 'true', {}, []];
  for (const v of notOn) {
    const c = rc({ checkupEnabled: v, enabled: v, weeklyEnabled: v });
    assert.equal(c.checkupEnabled, false, 'checkupEnabled=' + JSON.stringify(v) + ' 不得当开启（严格布尔 ===true）');
    assert.equal(c.enabled, false, 'enabled=' + JSON.stringify(v) + ' 不得当开启（严格布尔 ===true）');
    assert.equal(c.weeklyEnabled, false, 'weeklyEnabled=' + JSON.stringify(v) + ' 不得当开启（严格布尔 ===true）');
  }
  const on = rc({ checkupEnabled: true, enabled: true, weeklyEnabled: true });
  assert.equal(on.checkupEnabled, true);
  assert.equal(on.enabled, true);
  assert.equal(on.weeklyEnabled, true);
  const dflt = rc({});
  assert.equal(dflt.checkupEnabled, __test__.DEFAULTS.checkupEnabled, '未配置 → 默认（体检默认关）');
  assert.equal(dflt.enabled, __test__.DEFAULTS.enabled);
  assert.equal(dflt.weeklyEnabled, __test__.DEFAULTS.weeklyEnabled);
});

// ============================================================================
// 六、P1 · Config：@deepseek-ai/schemastery 优先、schemastery 回退、全失败降级
// ============================================================================

test('P1 Config：优先 @deepseek-ai/schemastery → 回退 schemastery → 全失败降级 undefined 且不抛', async () => {
  // 守：旧实现只 `await import('schemastery')`；真机宿主只有 @deepseek-ai/schemastery（审计③
  //     解析 asar 证实）→ Config 恒 undefined，配置页永远没有 schema。而"降级"必须是真降级：
  //     两个候选都解析不到时模块照常加载（Config=undefined），不许因此让插件加载失败。
  const load = __test__.loadSchemaModule;
  assert.equal(typeof load, 'function', '★ Config：必须暴露可注入 importer 的解析器（旧实现写死裸 import）');

  const stubSchema = {
    object: (shape) => ({ __schema: true, keys: Object.keys(shape) }),
    string: () => ({}), number: () => ({}), boolean: () => ({}),
  };

  const calls1 = [];
  const r1 = await load(async (spec) => {
    calls1.push(spec);
    if (spec === '@deepseek-ai/schemastery') return { default: stubSchema };
    throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' });
  });
  assert.equal(r1.spec, '@deepseek-ai/schemastery', '第一优先必须是 @deepseek-ai/schemastery');
  assert.equal(r1.Schema, stubSchema);
  assert.deepEqual(calls1, ['@deepseek-ai/schemastery'], '首选能解析时不应再试裸名');

  const calls2 = [];
  const r2 = await load(async (spec) => {
    calls2.push(spec);
    if (spec === 'schemastery') return { default: stubSchema };
    throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' });
  });
  assert.equal(r2.spec, 'schemastery', '首选失败必须回退裸名 schemastery');
  assert.equal(r2.Schema, stubSchema);
  assert.deepEqual(calls2, ['@deepseek-ai/schemastery', 'schemastery'], '回退顺序必须是宿主名在前、裸名在后');

  const r3 = await load(async (spec) => { throw Object.assign(new Error('not found ' + spec), { code: 'ERR_MODULE_NOT_FOUND' }); });
  assert.equal(r3.Schema, undefined, '两个候选都失败 → Schema=undefined（Config 如实降级）');
  assert.equal(r3.tried.length, 2);

  // 真机现场（本机没装 schemastery）：解析结果只能是 undefined 或真 Schema，绝不抛。
  const real = await load();
  assert.ok(real.Schema === undefined || typeof real.Schema.object === 'function', '生产解析路径只许成功或降级，不许抛');
});

// ============================================================================
// 七、P1 · ARCH-04 挂载失败可查 + 2 min 后不永久放弃 + mountOnce 可重入
// ============================================================================

test('P1 ARCH-04：挂载失败进可查位置（tick-metrics/state/run-report warnings），2 min 后退化为慢重试', async () => {
  // 守：旧实现 40 次（≈2 min）后 clearInterval 永久放弃，失败只写系统临时目录的启动日志 ——
  //     账库里没有任何"工具面/面板没挂上"的痕迹，HMR/服务晚就绪也永远不恢复。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]] });
    const timers = installTimerStubs();
    const log = fakeLogger();
    const disposers = [];
    try {
      const ctx = { logger: log, get: () => null, effect(fn) { const d = fn(); disposers.push(d); return d; } };
      apply(ctx, { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 });

      const peek = __test__.peekMountHealth;
      assert.equal(typeof peek, 'function', '★ ARCH-04：必须暴露挂载健康快照（用户/审计可查）');
      const mountRetry = timers.intervals.find((t) => t.ms === 3000);
      assert.ok(mountRetry, '必须存在 3 s 确定性挂载重试');

      // 服务一直不就绪 → 把快速重试窗口跑满（初始 1 次 + 39 次 = 40）。
      const intervalsBeforeRetry = timers.intervals.length;
      for (let i = 0; i < 39; i++) mountRetry.fn();
      let health = peek();
      assert.equal(health.ok, false, '两项都没挂上时 ok 必须 false');
      assert.equal(health.tools.mounted, false);
      assert.ok(health.gaveUpAt, '40 次后必须记录"快速窗口结束"的时间（不是静默消失）');
      assert.ok(health.tools.lastError, '必须保留最后一次失败原因');

      // 2 min 后不许永久放弃：必须还有 60 s 慢重试（HMR/服务晚就绪后仍可恢复）。
      // 注意：扫描定时器也是 60 s，所以只认"跑满 40 次之后**新增**的"那个 60 s 定时器。
      const slowRetry = timers.intervals.slice(intervalsBeforeRetry).find((t) => t.ms === 60000);
      assert.ok(slowRetry, '★ ARCH-04：快速窗口结束后必须退化为 60 s 慢重试（不得永久放弃）');

      // 用户可查位置 ①：tick-metrics 的 mount 段（每 tick 一行）。
      // ★ K-25 第二轮加固后 apply 在**挂载期**持锁，不能再直接 runOnce（会被自己的锁拒绝）；
      //   这里等 apply 首轮 tick 落盘，再**主动触发第二轮**（此时挂载已重试满 40 次 → 必须带挂载告警）。
      const metricCount = () => { const { metrics } = lastMetric(dataRoot); return metrics && metrics.records ? metrics.records.length : 0; };
      await waitFor(() => metricCount() >= 1, 5000);
      const scanTimer = timers.intervals.find((x) => x.ms === 60000 && x.fn && x.fn.name === 'tick');
      assert.ok(scanTimer, '必须有 60 s 扫描定时器（触发第二轮 tick 用）');
      await scanTimer.fn();
      await waitFor(() => metricCount() >= 2, 5000);
      const { last } = lastMetric(dataRoot);
      assert.ok(last && last.mount, 'tick-metrics 必须带 mount 健康度');
      assert.equal(last.mount.tools.mounted, false);
      assert.ok(last.mount.attempts >= 3 || last.mount.gaveUpAt, '第二轮 tick 必须已记录多次挂载重试（实际 attempts=' + (last.mount && last.mount.attempts) + '）');
      assert.ok(Array.isArray(last.warnings) && last.warnings.some((w) => String(w).includes('挂载')),
        '★ ARCH-04：挂载失败必须进 warnings（→ run-report warnings），实际=' + JSON.stringify((last.warnings || []).slice(0, 4)));
      // 用户可查位置 ②：.state.json 的 lastStat.mount
      const state = JSON.parse(fs.readFileSync(stateFileOf(dataRoot), 'utf8'));
      assert.ok(state.lastStat && state.lastStat.mount, '.state.json lastStat.mount 必须可查');
      // 服务晚就绪 → 慢重试必须能挂上（旧实现永久放弃后不再有任何定时器）。
      let toolsRegistered = 0;
      let webRegistered = 0;
      const toolsService = { register: () => { toolsRegistered += 1; return () => {}; } };
      const webService = { register: () => { webRegistered += 1; return () => {}; } };
      ctx.get = (n) => (n === 'tools' ? toolsService : n === 'webServer' ? webService : null);
      slowRetry.fn();
      health = peek();
      assert.equal(health.tools.mounted, true, '★ ARCH-04：服务晚就绪后必须能恢复挂载（慢重试）');
      assert.equal(health.webServer.mounted, true);
      assert.equal(health.ok, true);
      assert.ok(health.okAt, '恢复后必须记录 okAt（可查时间线）');
      assert.ok(toolsRegistered > 0 && webRegistered > 0, '恢复时必须真正注册到服务');

      // 卸载：等收敛 + 定时器清干净（含慢重试）。
      const out = await disposers[0]();
      assert.equal(out.converged, true);
      assert.ok(timers.cleared.includes(slowRetry), '卸载必须清掉 60 s 慢重试');
    } finally {
      timers.restore();
    }
  });
});

test('P1 ARCH-04：mountOnce 可重入 —— 注册全失败不算挂载成功，修好后能重挂且不重复注册', async () => {
  // 守：旧 mountOnce 无论 fn 结果都把 mountState[name]=true（HMR 时同名注册抛错 → 实际没挂上，
  //     却永久短路）；同时幂等短路要能在"重入调用"时安全返回，不能重复注册。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]] });
    const timers = installTimerStubs();
    const log = fakeLogger();
    const disposers = [];
    try {
      let registerCalls = 0;
      let shouldThrow = true;
      const toolsService = {
        register: () => {
          registerCalls += 1;
          if (shouldThrow) throw new Error('duplicate route (HMR overlap)');
          return () => {};
        },
      };
      const ctx = {
        logger: log,
        get: (n) => (n === 'tools' ? toolsService : null),
        effect(fn) { const d = fn(); disposers.push(d); return d; },
      };
      apply(ctx, { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 });
      const mountRetry = timers.intervals.find((t) => t.ms === 3000);
      assert.ok(mountRetry);

      let health = __test__.peekMountHealth();
      assert.equal(health.tools.mounted, false, '★ HMR：注册全失败时不得把 mounted 置 true（旧实现会）');
      assert.ok(health.tools.lastError, '必须留住"为什么没挂上"');

      // 快速窗口跑满后仍不永久放弃（慢重试存在）。只认"跑满之后新增"的 60 s 定时器。
      const intervalsBeforeRetry = timers.intervals.length;
      for (let i = 0; i < 39; i++) mountRetry.fn();
      const slowRetry = timers.intervals.slice(intervalsBeforeRetry).find((t) => t.ms === 60000);
      assert.ok(slowRetry, '注册一直失败也必须有慢重试');

      // HMR 结束（旧注册撤掉）→ 慢重试应能重挂。
      shouldThrow = false;
      const callsBefore = registerCalls;
      slowRetry.fn();
      health = __test__.peekMountHealth();
      assert.equal(health.tools.mounted, true, '★ HMR 后必须恢复挂载');
      assert.ok(registerCalls > callsBefore, '恢复时必须重新调用 register');

      // 可重入：已挂载时再调用一次重试，不得重复注册。
      const callsAfterMount = registerCalls;
      slowRetry.fn();
      assert.equal(registerCalls, callsAfterMount, '已挂载时重入调用必须幂等（不得重复注册工具）');

      await disposers[0]();
    } finally {
      timers.restore();
    }
  });
});

// ============================================================================
// 八·五、P0 · K-12 消费侧：instanceId 每实例唯一 → 同进程双实例互斥
// ============================================================================

test('P0 K-12：同进程两个 runOnce（不同 instanceId）→ 第二个 LOCK_HELD、不互删锁、无双写', async () => {
  // 守：K-12 只保证"传了不同 instanceId 的实例互斥"；若 index 不透传 instanceId，
  //     同进程两个实例共用默认值 → acquire 幂等返回**同一个 handle** → 第二个实例会把
  //     第一个的锁 release 掉（互删锁），第一个还在写 —— P0"同进程双写"只修一半。
  await withLab(async ({ dshHome, dataRoot }) => {
    const frames = [];
    for (let i = 1; i <= 40; i++) {
      frames.push([startLine(i, CREATED_AT + i * 1000), endLine(i, CREATED_AT + i * 1000 + 400)]);
    }
    writeSessionFile(dshHome, { frames });
    const ctl = captureSetImmediate();
    try {
      // A：40 轮（跨 2 批）→ 暂停在批边界，此时锁已拿到、台账尚未写。
      const aPromise = runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { instanceId: 'test-inst-A' }));
      await waitFor(() => ctl.queue.length >= 1, 5000);
      const lockFile = path.join(ledgerDir(dataRoot), '.lock');
      assert.ok(fs.existsSync(lockFile), 'A 在跑时锁文件必须存在');
      const tokenA = JSON.parse(fs.readFileSync(lockFile, 'utf8')).token;

      // B：不同 instanceId，扫一个空 DSH_HOME（无会话 → 无 await，立即尝试取锁）。
      const emptyHome = path.join(path.dirname(dshHome), 'empty-home');
      fs.mkdirSync(emptyHome, { recursive: true });
      const savedHome = process.env.DSH_HOME;
      process.env.DSH_HOME = emptyHome;
      let b;
      try {
        b = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { instanceId: 'test-inst-B' }));
      } finally {
        process.env.DSH_HOME = savedHome;
      }
      assert.equal(b.lockSkipped, true, '★ K-12：同进程异实例必须 LOCK_HELD');
      assert.ok(String(b.errors.join('\n')).includes('LOCK_HELD'), 'B 的返回值必须可见 LOCK_HELD');
      assert.equal(fs.existsSync(lockFile), true, '★ K-12：B 不得删/接 A 的锁（互删锁 = 双写风险）');
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, tokenA, '锁 owner（token）不得被 B 改动');

      // 放行 A，等它跑完。
      let done = false;
      aPromise.then(() => { done = true; }, () => { done = true; });
      while (!done) {
        ctl.drain();
        await sleep(5);
      }
      const a = await aPromise;
      assert.equal(a.written, 40, 'A 必须正常写完 40 行');
      assert.equal(readAll(dataRoot).records.length, 40, '台账不得双写');
      assert.equal(fs.existsSync(lockFile), false, 'A 正常释放后锁文件应被清');

      // tick-metrics：两个实例的 instanceId 都可查；B 是 lockSkipped 行。
      const rows = readTickMetrics(dataRoot).records;
      const skip = rows.find((r) => r.lockSkipped === true);
      assert.ok(skip, 'B 的锁跳过必须留 tick-metrics 记录');
      assert.equal(skip.instanceId, 'test-inst-B');
      assert.equal(skip.lock && skip.lock.reason, 'held');
      assert.ok(rows.some((r) => r.instanceId === 'test-inst-A' && r.written === 40), 'A 的度量行必须带自己的 instanceId');
    } finally {
      ctl.restore();
    }
  });
});

test('P0 K-12/K-25：apply() 每挂载实例生成唯一 instanceId；第二个挂载实例「启动即拒绝」（mount 期持锁）', async () => {
  // 守：① instanceId 不能只存在于测试参数里 —— apply 必须给每个挂载实例生成唯一值并透传到锁；
  //     ② K-25 第二轮加固后，第二个写者必须在**挂载层**被拒绝（不跑 tick），
  //        而不是各自抢 tick 轮换写者（旧实现的"声明强于实现"）。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]] });
    const timers = installTimerStubs();
    const ctl = captureSetImmediate();
    const disposers = [];
    const mkCtx = () => ({
      logger: fakeLogger(),
      get: () => null,
      effect(fn) { const d = fn(); disposers.push(d); return d; },
    });
    try {
      // 实例 1：apply 在**挂载期**取锁（K-25 加固），首 tick 在批边界暂停。
      const ctx1 = mkCtx();
      apply(ctx1, { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 });
      await waitFor(() => ctl.queue.length >= 1, 5000);

      // 实例 2：第二个挂载实例 → 必须「启动即拒绝」（ERROR + 不跑 tick）。
      const ctx2 = mkCtx();
      apply(ctx2, { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 });
      await sleep(150);
      const log2 = [...(ctx2.logger.infoLines || []), ...(ctx2.logger.warnLines || [])].join('\n');
      assert.match(log2, /拒绝启动/, '★ K-25：第二个挂载实例必须被拒（ERROR 拒绝启动）');
      assert.match(log2, /多写者场景不支持/, '★ 必须明确"多写者场景不支持"');
      assert.match(log2, /instanceId=mount-/, '拒绝日志必须带它自己的 instanceId（可观测）');
      // 实例 2 一次 tick 都不跑：metrics 里不该出现 tick 级 lockSkipped 行
      const rows2 = readTickMetrics(dataRoot).records;
      assert.equal(rows2.some((r) => r.lockSkipped === true), false, '★ 第二个实例在挂载层就被拒，不该有 tick 级 lockSkipped 行');

      // 放行实例 1 的首轮 tick（它会正常落账），再卸载两个实例。
      ctl.drain();
      await waitFor(() => fs.existsSync(stateFileOf(dataRoot)), 5000);
      await sleep(120);
      const d1 = disposers[0]();
      const d2 = disposers[1]();
      await d1;
      await d2;

      const rows = readTickMetrics(dataRoot).records;
      const instIds = [...new Set(rows.map((r) => r.instanceId).filter(Boolean))];
      assert.ok(instIds.length >= 1 && instIds.every((x) => String(x).startsWith('mount-')), 'instanceId 必须是 mount-*：' + JSON.stringify(instIds));
      const log1 = [...(ctx1.logger.infoLines || []), ...(ctx1.logger.warnLines || [])].join('\n');
      const id1 = (/(mount-[0-9a-f-]{8,})/.exec(log1) || [])[1];
      const id2 = (/(mount-[0-9a-f-]{8,})/.exec(log2) || [])[1];
      assert.ok(id1 && id2 && id1 !== id2, '两个挂载实例必须生成不同 instanceId：' + JSON.stringify({ id1, id2 }));
      assert.equal(readAll(dataRoot).records.length, 1, '双实例不得双写（台账恰好 1 行）');
    } finally {
      ctl.drain();
      await sleep(100);
      ctl.restore();
      timers.restore();
    }
  });
});

// ============================================================================
// 九、P1 · RT-01 对账轮真实耗时/读字节进 tick-metrics
// ============================================================================

test('P1 RT-01：全量对账轮的真读字节与各段耗时进 tick-metrics（不再只有产品侧估算）', async () => {
  // 守：对账是同步全量只读（审计实测阻塞 2.3–2.4 s、真读 ~175 MiB），旧 tick-metrics 的
  //     readBytes 只有"扫描消费+事件预算"估算，对账读盘完全不在账上（稳态自报低 4.9×）。
  //     新口径：fs 层实测本 tick 真读字节 + 各段真读字节，作为 additive 字段落盘；
  //     既有 readBytes/readBytesKind（估算口径）保持不变。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]] });
    // 等前序用例可能残留的异步 tick 收尾（模块级对账节流是进程内状态，别让它们串场）。
    await sleep(120);
    if (typeof __test__.resetPeriodicThrottle === 'function') __test__.resetPeriodicThrottle(); // 让本轮必跑对账
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.ok(stat.reconcile, '本轮必须跑了对账（resetPeriodicThrottle 后首轮）');

    const { metrics, last } = lastMetric(dataRoot);
    assert.equal(metrics.readError, '', 'tick-metrics 必须可读：' + metrics.readError);
    assert.ok(last, '必须有 tick-metrics 记录');
    assert.equal(last.readBytesKind, 'estimate-product-side', '既有估算口径字段不得改变');

    assert.equal(typeof last.realReadBytes, 'number', '★ RT-01：必须新增本 tick 真读字节（fs 实测）');
    assert.ok(last.realReadBytes > 0, '★ RT-01：真读字节必须 >0，实际=' + last.realReadBytes);
    assert.ok(last.io && typeof last.io.realReadBytes === 'number', 'io.realReadBytes 必须存在');
    assert.equal(last.io.realReadBytes, last.realReadBytes, 'io.realReadBytes 与顶层必须一致');

    assert.ok(last.io.reconcileReadBytes > 0, '★ RT-01：对账段真读字节必须 >0（旧口径该段为 0）');
    assert.ok(last.reconcile && last.reconcile.ran === true, 'reconcile 段必须标注 ran=true');
    assert.equal(typeof last.reconcile.ms, 'number', 'reconcile.ms 必须是真实耗时');
    assert.ok(last.reconcile.readBytes > 0, 'reconcile.readBytes 必须 >0');
    assert.ok(last.realReadBytes >= last.io.reconcileReadBytes, '全 tick 真读字节必须 ≥ 对账段');

    // 各段真读字节（additive）；未发生的段允许 0，但字段必须在。
    for (const k of ['scanReadBytes', 'weeklyReadBytes', 'stateReadBytes', 'catalogReadBytes', 'indexReadBytes', 'receiptReadBytes', 'reconcileReadBytes', 'reportReadBytes']) {
      assert.equal(typeof last.io[k], 'number', 'io.' + k + ' 必须是数字');
    }
    // 既有 phases 段耗时一个不能少（C25/C21 读法不变）。
    for (const k of ['scanMs', 'eventsMs', 'persistMs', 'weeklyMs', 'reconcileMs', 'reportMs', 'indexMs', 'catalogMs', 'receiptMs', 'monthlyMs']) {
      assert.equal(typeof last.phases[k], 'number', 'phases.' + k + ' 必须保留');
    }
  });
});
