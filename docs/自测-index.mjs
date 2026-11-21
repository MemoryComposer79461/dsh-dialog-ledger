/**
 * @file 自测-index.mjs
 * @role 单元自测：index.js 的两个要害 —— `runOnce`（扫描+落账的语义）与 `apply`（生命周期/定时器）。
 * @why 账只追加、编码是永久主键，入口层的两个错误最贵：
 *        ① runOnce 把"进行中的轮次"提前写成 partial → 永久错误；
 *        ② apply 用返回值做清理（Cordis 不认）→ 热重载后旧定时器继续跑，账每轮写两遍。
 *      这两类都不是"跑不起来"，而是"跑得很好但账错了"，只能靠自测钉住。
 *
 * 隔离纪律：
 *   · 不碰真实 `~/.dsh`：`process.env.DSH_HOME` 指向 `%TEMP%\dl-test-*` 下的临时 home；
 *   · 会话文件是合成的：一行一个 JSON 事件，`zlib.zstdCompressSync` 逐帧压、`Buffer.concat` 拼；
 *   · 账本 root 也在临时目录；每个用例 finally 删整棵临时目录；
 *   · 定时器用替身（替换 `globalThis.setInterval/clearInterval`），用例结束恢复原函数。
 *
 * 运行（在源码仓库根目录）：
 *   & '<test-dir>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test docs/自测-index.mjs
 *
 * 约定：每条 test 上方一行「守：」写明这条防的是哪种回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce, apply } from '../index.js';
import { readAll, ledgerDir } from '../lib/ledger.js';

/** 合成会话的完整 id（12 位短 id = 75238718e41a）。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** 会话开始时刻（固定值）：2026-11-08 09:00:00 +08:00。 */
const CREATED_AT = Date.parse('2026-11-08T09:00:00+08:00');
/** DSH 会话文件名（固定）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd';

// ============================================================================
// 一、测试基础设施（临时 home / 合成会话 / 替身）
// ============================================================================

/**
 * 建临时根目录并把它当作 `DSH_HOME`，跑完（无论通过失败）恢复环境变量、删目录。
 * @param {(lab: {root: string, dshHome: string, dataRoot: string}) => Promise<any>} fn
 */
async function withLab(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  // 守：一切写盘都在 %TEMP%\dl-test-* 下，不污染真实用户目录。
  assert.match(path.basename(root), /^dl-test-/);
  assert.equal(path.dirname(root), os.tmpdir());

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

/** 一行文本压成一帧（DSH 每次追加写一帧）。 */
const frame = (lineArr) =>
  zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));

/** turn/start 事件行（序列化成 JSON 字符串）。 */
const startLine = (turn, time) =>
  JSON.stringify({ type: 'turn/start', time, data: { turn } });

/** turn/end 事件行。 */
const endLine = (turn, time, kind = 'stop') =>
  JSON.stringify({ type: 'turn/end', time, data: { turn, reason: { kind } } });

/**
 * 在临时 DSH_HOME 下合成一个会话文件：
 *   `<dshHome>/sessions/--lab--/<sid>/session.v4.jsonl.zstd`
 *
 * @param {string} dshHome
 * @param {object} opts
 * @param {string[]} [opts.frames] 每帧若干行（字符串）。
 * @param {number|null} [opts.mtimeMs] 写入后把 mtime 改成该毫秒时间戳（测热窗口/安静检测用）。
 */
function writeSessionFile(dshHome, opts = {}) {
  const { sid = SID, createdAt = CREATED_AT, frames = [], mtimeMs = null } = opts;
  const dir = path.join(dshHome, 'sessions', '--lab--', sid);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);

  const headLine = JSON.stringify({
    type: 'session',
    id: sid,
    createdAt,
    cwd: 'C:\\lab\\synthetic',
    agentPreset: 'lab',
  });
  const allFrames = [[headLine], ...frames];
  fs.writeFileSync(p, Buffer.concat(allFrames.map((lines) => frame(lines))));

  if (mtimeMs !== null) {
    const d = new Date(mtimeMs);
    fs.utimesSync(p, d, d);
  }
  return p;
}

/** 造一份 runOnce 需要的"已解析配置"（runOnce 不自己调 readConfig）。 */
function makeCfg(root, over = {}) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: 480, // UTC+08:00
    hotWindowSeconds: 0, // 0 = 不过滤，所有会话都看
    quietSeconds: 120,
    ...over,
  };
}

/** 假 logger：把 info/warn 记下来，避免测试期间往终端刷日志。 */
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

/** 轮询等待条件成立（用于等 apply 立刻触发的那次异步 tick 落完盘）。 */
async function waitFor(predicate, timeoutMs = 5000, stepMs = 10) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('waitFor 超时：条件在 ' + timeoutMs + 'ms 内未成立');
}

/**
 * 把全局定时器换成记账替身，返回记录数组与 restore()。
 * apply 里用的是裸 `setInterval`/`clearInterval`，替换 globalThis 即可观测。
 */
function installTimerStubs() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervals = [];
  const cleared = [];

  globalThis.setInterval = (fn, ms) => {
    const handle = {
      fn,
      ms,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      },
    };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    cleared.push(handle);
  };

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
 * 只取"插件扫描定时器"（周期来自 config，本测试里 = 60s）。
 *
 * @why 不能直接数 `timers.intervals.length`：
 *      写锁（lib/lock.js）在每轮 runOnce 里会起一个 30s 心跳定时器（unref）。
 *      它是另一个**合法**定时器，不是"多起了一个扫描表"。
 *      本测试要守的不变量是：扫描定时器只有一个、周期来自 config、且 unref、卸载时被清。
 */
function pluginTimers(timers, ms = 60000) {
  return timers.intervals.filter((t) => t.ms === ms);
}

/** 某会话的账本目录（.state.json 所在）。 */
const stateFileOf = (dataRoot) => path.join(ledgerDir(dataRoot), '.state.json');

// ============================================================================
// 二、runOnce —— A：只有 turn/start 且会话文件很新 → 进行中，不入账
// ============================================================================

test('runOnce A：只有 turn/start 且文件很新 → written=0、openTurns=1（进行中轮次不入账）', async () => {
  // 守：v0.1.1 的核心修正。进行中的轮次若被写成 partial，等它真结束时会因
  // (sid,turn) 闸门被永久跳过，账就永远停在 partial。这里必须 written=0 且 openTurns=1。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000)]] }); // mtime = 刚刚

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));

    assert.equal(stat.scanned, 1);
    assert.equal(stat.newTurns, 0); // 没有闭合轮次
    assert.equal(stat.written, 0); // 一条都不许写
    assert.equal(stat.openTurns, 1); // 只计数："有 1 轮在等闭合"
    assert.equal(stat.errors.length, 0);
    assert.equal(readAll(dataRoot).records.length, 0);
  });
});

// ============================================================================
// 三、runOnce —— B：安静兜底：会话安静够久才把未闭合轮次记成 partial
// ============================================================================

test('runOnce B：未闭合轮次不写 partial（审计 A-01）；闭合后恰好一条 ok，重跑幂等', async () => {
  // 守（★ v0.5 改写）：未闭合轮次**不得进台账** —— 一旦写进去，幂等闸门是 (sid,turn)，
  // 真实闭合到达时会被判"已记过"而跳过，原文又因不可覆盖永不更新 → 永久 partial。
  // 只允许在 `<root>/ledger/.pending.jsonl` 留待核证据（幂等）。
  // 闭合之后：恰好一条 status='ok'；再重跑 → written=0 / skipped=1。
  //
  // 为什么改这条：原断言第 3 跑 `stat3.skipped === 1` 把审计 A-01 的**缺陷本身**
  // 当成了正确行为来守（"partial 已是永久记录，不许再写"）。
  await withLab(async ({ dshHome, dataRoot }) => {
    const file = writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000)]] });
    const cfg = makeCfg(dataRoot, { quietSeconds: 120, hotWindowSeconds: 0 });

    // 第 1 跑：文件很新 → 只计数不落账，但要留 pending 证据
    const stat1 = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(stat1.openTurns, 1);
    assert.equal(stat1.written, 0);
    assert.equal(stat1.pendingTurns, 1, '必须留 pending 证据');

    // 把会话文件 mtime 改成 10 分钟前（模拟进程已死、不再写入）——最像"该兜底"的现场
    const oldMs = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(file, new Date(oldMs), new Date(oldMs));

    // 第 2 跑：安静够了也**不许**写 partial；pending 证据必须幂等
    const stat2 = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(stat2.scanned, 1);
    assert.equal(stat2.written, 0, '★ 安静也不许写 partial（审计 A-01）');
    assert.equal(stat2.openTurns, 1);
    assert.equal(stat2.pendingDup, 1, 'pending 证据必须幂等去重');
    assert.equal(readAll(dataRoot).records.length, 0, '★ 台账必须仍为空');

    // 第 3 跑：补上 turn/end → 正常闭合入账，恰好一条 ok
    writeSessionFile(dshHome, {
      frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 60_000)]],
    });
    const stat3 = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(stat3.written, 1, '闭合后必须入账');
    assert.equal(stat3.openTurns, 0);

    const records = readAll(dataRoot).records;
    assert.equal(records.length, 1, '★ 必须恰好一条（不得 partial + ok 两行）');
    assert.equal(records[0].status, 'ok', '★ 必须是已闭合的 ok');
    assert.equal(records[0].turn, 1);
    assert.equal(records[0].seq, 1);
    assert.equal(records[0].sid, SID);
    assert.match(records[0].code, /^20261108-75238718e41a-A-\d{8}$/);

    // 第 4 跑：已入账 → 幂等，不许再写
    const stat4 = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(stat4.written, 0);
    assert.equal(stat4.skipped, 1);
    assert.equal(readAll(dataRoot).records.length, 1);
  });
});

// ============================================================================
// 四、runOnce —— C：首跑全量扫（老会话不许被 hotWindow 漏掉）
// ============================================================================

test('runOnce C：全新 root + 2 小时前的老会话（hotWindow=3600）→ 首跑仍全量扫并写入', async () => {
  // 守：首次运行必须全量。若首跑也套 hotWindow，一小时前的老会话历史轮次
  // 就永久进不了账，而且文件系统里不会留下"这里本来就缺"的痕迹。
  await withLab(async ({ dshHome, dataRoot }) => {
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    writeSessionFile(dshHome, {
      frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
      mtimeMs: twoHoursAgo,
    });

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { hotWindowSeconds: 3600 }));

    assert.equal(stat.firstRun, true); // 状态文件不存在 → 首跑
    assert.equal(stat.scanned, 1); // 老 mtime 也必须被扫到
    assert.equal(stat.newTurns, 1);
    assert.equal(stat.written, 1);
    assert.equal(stat.errors.length, 0);

    const records = readAll(dataRoot).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'ok');
    assert.equal(records[0].turn, 1);
    // ts 用会话开始时刻（本轮 turn/start 的 time）按 +08:00 渲染
    assert.equal(records[0].ts, '2026-11-08T09:00:01+08:00');
  });
});

// ============================================================================
// 五、runOnce —— D：次跑（非首跑）按热窗口过滤老会话
// ============================================================================

test('runOnce D：同一 root 次跑 → 老会话被热窗口跳过（scanned 减一）', async () => {
  // 守：首跑全量、次跑才允许省 IO；且"省 IO"不能把状态文件里的 initialized 丢掉，
  // 否则每次重启都全量扫，36 MB 文件会把 60s 的周期撑爆。
  await withLab(async ({ dshHome, dataRoot }) => {
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    writeSessionFile(dshHome, {
      frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
      mtimeMs: twoHoursAgo,
    });
    const cfg = makeCfg(dataRoot, { hotWindowSeconds: 3600 });

    const first = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(first.firstRun, true);
    assert.equal(first.scanned, 1);
    assert.equal(first.written, 1);

    const second = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(second.firstRun, false); // 已 initialized，不再全量
    assert.equal(second.scanned, first.scanned - 1); // 老会话被热窗口过滤 → 0
    assert.equal(second.written, 0);
    assert.equal(readAll(dataRoot).records.length, 1); // 账本不因二次扫描变化
  });
});

// ============================================================================
// 六、runOnce —— E：幂等（同一 root 连跑两次不重复写）
// ============================================================================

test('runOnce E：同一 root 连跑两次 → 第二次 written=0、账本总数不变', async () => {
  // 守：幂等闸门是 (sid,turn)，不是"重新算一遍 code"。
  // v0.1 曾因为每轮都从 turn 1 遍历、却分配新 seq，导致第二轮把全部记录重写一遍。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, {
      frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
    });
    const cfg = makeCfg(dataRoot, { hotWindowSeconds: 0 }); // 两跑都扫同一个会话

    const first = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(first.scanned, 1);
    assert.equal(first.newTurns, 1);
    assert.equal(first.written, 1);
    assert.equal(first.skipped, 0);
    const afterFirst = readAll(dataRoot).records;
    assert.equal(afterFirst.length, 1);
    const codeBefore = afterFirst[0].code;

    const second = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(second.scanned, 1);
    assert.equal(second.newTurns, 1); // 这一轮还是被"看到"了
    assert.equal(second.written, 0); // 但不再写
    assert.equal(second.skipped, 1); // (sid,turn) 命中闸门

    const afterSecond = readAll(dataRoot).records;
    assert.equal(afterSecond.length, 1); // 总数不变
    assert.equal(afterSecond[0].code, codeBefore); // 主键也不变
  });
});

// ============================================================================
// 七、runOnce —— F：状态文件（首跑标记 / 运行留痕）
// ============================================================================

test('runOnce F：跑完存在 ledger/.state.json，initialized=true 且留痕；次跑 firstRun=false', async () => {
  // 守：首跑判定放在磁盘而不是内存 —— 重启后仍然记得"已首跑过"；
  // 同时 lastStat 是事后审计"这轮扫了几个/写了几个"的唯一凭据。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, {
      frames: [[startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
    });
    const cfg = makeCfg(dataRoot, { hotWindowSeconds: 0 });

    const stat = await runOnce({ logger: fakeLogger() }, cfg);

    const sp = stateFileOf(dataRoot);
    assert.equal(fs.existsSync(sp), true, '.state.json 不存在');
    assert.equal(fs.existsSync(sp + '.tmp'), false, '原子写的临时文件没被 rename 掉');

    const state = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert.equal(state.initialized, true);
    assert.equal(typeof state.firstRunAt, 'string');
    assert.equal(typeof state.lastRunAt, 'string');
    assert.equal(state.lastStat.written, stat.written); // 留痕数字与实际一致
    assert.equal(state.lastStat.scanned, stat.scanned);

    // 次跑：首跑标记生效
    const stat2 = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(stat2.firstRun, false);
  });
});

// ============================================================================
// 八、apply 生命周期 —— 有 ctx.effect：清理必须走 effect，不靠返回值
// ============================================================================

test('apply：有 ctx.effect 时返回 undefined，且通过 effect 注册了清理函数；调用后 clearInterval 生效', async () => {
  // 守：Cordis 不认 apply 的返回值。若靠返回值清理，热重载后旧定时器继续跑，
  // 每 60s 写两遍、三遍 —— 账只追加，多写的行无法删除，这是最不能接受的账错。
  await withLab(async ({ root }) => {
    const dataRoot = path.join(root, 'apply-data');
    const cfg = { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 };
    const timers = installTimerStubs();
    try {
      const log = fakeLogger();
      const disposers = [];
      const ctx = {
        logger: log,
        // Cordis 语义：effect 立即执行回调，回调返回 disposer
        effect(fn) {
          const d = fn();
          disposers.push(d);
          return d;
        },
      };

      const ret = apply(ctx, cfg);
      // 守：有 effect 时绝不能把 dispose 当返回值（否则调用方以为已清理，其实没有）
      assert.equal(ret, undefined);
      assert.equal(disposers.length, 1, 'ctx.effect 应被调用一次');
      assert.equal(typeof disposers[0], 'function', 'effect 注册的应是清理函数');

      // 定时器语义：扫描周期来自 config（60s），且 unref（不阻止进程退出）
      // 注意：写锁心跳（30s）是另一个合法定时器，二者要分开数。
      const scanTimers = pluginTimers(timers);
      assert.equal(scanTimers.length, 1, '插件扫描定时器应只有一个');
      assert.equal(scanTimers[0].ms, 60000);
      assert.equal(scanTimers[0].unrefCalled, true);

      // 等 apply 立刻触发的那次异步 tick 落完（state 是 runOnce 最后一步），再清理
      await waitFor(() => fs.existsSync(stateFileOf(dataRoot)));
      disposers[0](); // 模拟 Cordis 卸载/热重载时调用清理
      assert.ok(timers.cleared.includes(scanTimers[0]), '扫描定时器应在卸载时被 clearInterval');
      assert.ok(log.infoLines.some((l) => l.includes('unloaded')), '卸载日志缺失');
    } finally {
      timers.restore();
    }
  });
});

// ============================================================================
// 九、apply 生命周期 —— 无 ctx.effect：退化为返回清理函数（裸跑/测试兜底）
// ============================================================================

test('apply：无 ctx.effect 时退化为返回清理函数；调用它同样 clearInterval', async () => {
  // 守：脱离 DSH 的裸跑/测试环境也要能清理定时器；兜底路径不能是"返回 undefined 但已起表"。
  await withLab(async ({ root }) => {
    const dataRoot = path.join(root, 'apply-data');
    const cfg = { root: dataRoot, intervalSeconds: 60, enabled: true, hotWindowSeconds: 0 };
    const timers = installTimerStubs();
    try {
      const ctx = { logger: fakeLogger() }; // 故意没有 effect

      const ret = apply(ctx, cfg);
      assert.equal(typeof ret, 'function', '无 effect 时应返回清理函数');
      const scanTimers = pluginTimers(timers);
      assert.equal(scanTimers.length, 1, '插件扫描定时器应只有一个');

      await waitFor(() => fs.existsSync(stateFileOf(dataRoot)));
      ret();
      assert.ok(timers.cleared.includes(scanTimers[0]), '扫描定时器应在清理时被 clearInterval');
    } finally {
      timers.restore();
    }
  });
});

// ============================================================================
// 十、apply 生命周期 —— enabled=false：不起定时器（配置开关）
// ============================================================================

test('apply：enabled=false → 不起定时器、不注册 effect，返回空清理函数', async () => {
  // 守：插件禁用开关必须真的什么都不做；否则"关掉插件"仍会起表写账。
  await withLab(async ({ root }) => {
    const timers = installTimerStubs();
    try {
      let effectCalled = 0;
      const ctx = {
        logger: fakeLogger(),
        effect(fn) {
          effectCalled++;
          return fn();
        },
      };

      const ret = apply(ctx, { root: path.join(root, 'disabled'), enabled: false });

      assert.equal(typeof ret, 'function');
      assert.equal(timers.intervals.length, 0, 'enabled=false 仍在起定时器');
      assert.equal(effectCalled, 0, 'enabled=false 不该注册生命周期清理');
      ret(); // 空清理函数不应抛错
    } finally {
      timers.restore();
    }
  });
});
