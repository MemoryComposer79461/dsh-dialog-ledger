/**
 * @file 自测-边界.mjs
 * @role 边界与规模自测 —— 跨零点/跨月的日期段归属、坏事件守卫（malformed）、
 *       孤儿轮次（安静兜底 partial vs 进行中不写）、单会话 1200 轮的规模与幂等。
 * @called-by 人工/审计：`node --test docs/自测-边界.mjs`（Node 24，自带 zstd）；
 *            不进 package.json 的 `test` 脚本清单之外，由 `docs/自测-*.mjs` 通配自然纳入。
 * @depends ../index.js（runOnce）、../lib/ledger.js（合成会话读取/collectTurnsDetailed/readAll/路径）、
 *          ../lib/encoder.js（parseCode）、node:zlib（zstdCompressSync）
 * @why 这批边界全是"跑得通但账会悄悄错"的类型，单元功能测试抓不到：
 *        ① 编码日期段=会话开始日。若误用"本轮发生日"，跨零点那一轮的永久主键就换了天，
 *           同一会话的 sessionKey 被拆成两天，且账只追加、改不回来。
 *        ② 台账日文件按 ts（发生时刻）分。若跟着编码日期段走，跨零点会话会被整体塞进
 *           前一天的文件 —— 当天对账时"今天的会话去哪了"。
 *        ③ 缺 time / 缺 data.turn 的坏边界。v0.1 曾写出 1970-01-01 的假时间戳，
 *           或让 (sid,turn)=sid#null 的闸门把真轮次互相判成"已记过"而漏记。
 *        ④ 孤儿轮次（有 start 无 end）。进行中提前记 partial = 永久错误；
 *           安静够久的才允许兜底 partial，否则那轮会永远停在 partial。
 *        ⑤ 1200 轮规模。条数/唯一性/二次幂等一旦错，账要么缺、要么多，都不可审计。
 *
 * 隔离纪律（与 06/07 轮一致）：
 *   · 不碰真实 `~/.dsh`：`process.env.DSH_HOME` 指向 `%TEMP%\dl-edge-*` 下的临时 home；
 *   · 会话文件全合成：`zlib.zstdCompressSync` 逐帧压、`Buffer.concat` 拼多帧；
 *   · 账本 root 也在 `%TEMP%\dl-edge-*`；每个用例 finally 删整棵临时目录；
 *   · 不启动 DSH、不读真实 sessions、不改任何被测源码。
 *
 * 失败纪律：断言失败就记失败，不删用例凑绿；判定不清的标「存疑」单列。
 *
 * 运行（在源码仓库根目录）：
 *   & '<test-dir>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test docs/自测-边界.mjs
 *
 * 约定：每条 test 上方一行「守：」写明这条防的是哪种回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce } from '../index.js';
import {
  readAll,
  readSessionEvents,
  collectTurnsDetailed,
  ledgerDir,
  ledgerPath,
} from '../lib/ledger.js';
import { parseCode } from '../lib/encoder.js';
// P0-2（审计 A-01）：未闭合轮次的 pending 证据
import { readPending } from '../lib/pending.js';

// ============================================================================
// 一、测试基础设施（临时 home / 合成多帧会话 / 配置 / 假 logger）
// ============================================================================

/** 合成会话的完整 id（12 位短 id = 75238718e41a）。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** DSH 会话文件名（固定）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd';
/** 时区偏移：480 = UTC+08:00。测试一律显式传，不依赖本机时区。 */
const OFFSET_MINUTES = 480;

/**
 * 建 `%TEMP%\dl-edge-*` 临时根目录并把它当作 `DSH_HOME`，跑完（无论通过/失败）
 * 恢复环境变量、删整棵目录。
 *
 * @param {(lab: {root: string, dshHome: string, dataRoot: string}) => Promise<any>} fn
 */
async function withLab(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-edge-'));
  // 守：临时写盘只许落在 os.tmpdir() 下的 dl-edge-*，绝不污染真实用户目录。
  assert.match(path.basename(root), /^dl-edge-/);
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

/** 把若干行文本压成一帧（DSH 每追加写一帧，所以真实文件是多帧拼接）。 */
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
 * @param {number} opts.createdAt 会话头 createdAt（毫秒时间戳）
 * @param {string[][]} [opts.frames] 每帧若干行（字符串）；一帧一帧 zstd 压后 Buffer.concat
 * @param {number|null} [opts.mtimeMs] 写入后把 mtime 改成该毫秒时间戳（测安静检测用）
 * @returns {string} 会话文件绝对路径
 */
function writeSessionFile(dshHome, opts = {}) {
  const { createdAt, frames = [], mtimeMs = null } = opts;
  const dir = path.join(dshHome, 'sessions', '--lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);

  const headLine = JSON.stringify({
    type: 'session',
    id: SID,
    createdAt,
    cwd: 'C:\\lab\\edge',
    agentPreset: 'lab-edge',
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
    offsetMinutes: OFFSET_MINUTES,
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

/** 读一个台账日文件，返回记录数组（一行一条）。 */
function readLedgerDay(dataRoot, dateISO) {
  const p = ledgerPath(dataRoot, dateISO);
  if (!fs.existsSync(p)) return null;
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** 台账目录下现有的日文件名（排序；不含 .state.json）。 */
function listLedgerDayFiles(dataRoot) {
  const dir = ledgerDir(dataRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
}

// ============================================================================
// 二、跨零点：编码日期段 = 会话开始日；台账日文件按 ts（发生时刻）分
// ============================================================================

// 守：会话头 createdAt=2026-11-07T23:50、两轮分别在 23:55 与次日 00:10 时，
// 两条编码的日期段都必须是 20261107（会话开始日），而不是各自的发生日；
// 否则跨零点的同一会话会被拆成两个永久主键前缀，sessionKey 断开、账永远对不齐。
// 同时守：台账日文件必须按 record.ts（发生时刻）落盘 → 两个不同的日文件，
// 若跟着编码日期段走，次日那轮会被错误塞进 11-07 的文件。
test('跨零点：23:50 开始、两轮跨到次日 00:10 → 编码日期段均为 20261107，台账分落 11-07 与 11-08 两个日文件', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-11-07T23:50:00+08:00');
    const t1 = Date.parse('2026-11-07T23:55:00+08:00');
    const t2 = Date.parse('2026-11-08T00:10:00+08:00');
    writeSessionFile(dshHome, {
      createdAt,
      frames: [
        [startLine(1, t1)],
        [endLine(1, t1 + 60_000)],
        [startLine(2, t2)],
        [endLine(2, t2 + 60_000)],
      ],
    });

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat.scanned, 1);
    assert.equal(stat.written, 2);
    assert.equal(stat.errors.length, 0);

    const records = readAll(dataRoot).records;
    assert.equal(records.length, 2);

    // ① 编码日期段 = 会话开始日 20261107，两轮一致
    const p1 = parseCode(records[0].code);
    const p2 = parseCode(records[1].code);
    assert.notEqual(p1, null);
    assert.notEqual(p2, null);
    assert.equal(p1.date, '20261107');
    assert.equal(p2.date, '20261107', '次日 00:10 那轮的编码日期段错用了发生日（应为会话开始日）');
    assert.match(records[0].code, /^20261107-[0-9a-z]{12}-[A-Z]-\d{8}$/);
    assert.match(records[1].code, /^20261107-[0-9a-z]{12}-[A-Z]-\d{8}$/);
    // 同一会话 → 日期段+短ID+代差相同（去掉序号后的会话键一致）
    assert.equal(records[0].code.slice(0, 22), records[1].code.slice(0, 22));

    // ② 台账日文件按 ts 分：两个日文件各一行，轮次归属正确
    assert.deepEqual(listLedgerDayFiles(dataRoot), ['2026-11-07.jsonl', '2026-11-08.jsonl']);
    const day1 = readLedgerDay(dataRoot, '2026-11-07');
    const day2 = readLedgerDay(dataRoot, '2026-11-08');
    assert.equal(day1.length, 1);
    assert.equal(day2.length, 1);
    assert.equal(day1[0].turn, 1);
    assert.equal(day2[0].turn, 2);
    assert.equal(day1[0].ts, '2026-11-07T23:55:00+08:00');
    assert.equal(day2[0].ts, '2026-11-08T00:10:00+08:00');
    // ts 的日期段和所在日文件名一致（ts 决定落哪个文件）
    assert.equal(day1[0].ts.slice(0, 10), '2026-11-07');
    assert.equal(day2[0].ts.slice(0, 10), '2026-11-08');
  });
});

// ============================================================================
// 三、跨月：编码日期段 = 会话开始日 20260131；台账日文件按 ts 分成 01-31 与 02-01
// ============================================================================

// 守：跨月与跨零点是同一类账错的两个尺码。若日期段取发生日，2/1 那轮的永久主键
// 就变成 20260201，同会话跨月被拆；而台账日文件本身又必须按发生时刻分，
// 两个要求互相独立 —— 一个测编码、一个测 appendTurn，不能互相顶替。
test('跨月：2026-01-31T23:59 开始、两轮跨到 2/1 00:01 → 编码日期段均为 20260131，台账分落 01-31 与 02-01 两个日文件', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-01-31T23:59:00+08:00');
    const t1 = Date.parse('2026-01-31T23:59:00+08:00');
    const t2 = Date.parse('2026-02-01T00:01:00+08:00');
    writeSessionFile(dshHome, {
      createdAt,
      frames: [
        [startLine(1, t1)],
        [endLine(1, t1 + 30_000)],
        [startLine(2, t2)],
        [endLine(2, t2 + 30_000)],
      ],
    });

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat.scanned, 1);
    assert.equal(stat.written, 2);
    assert.equal(stat.errors.length, 0);

    const records = readAll(dataRoot).records;
    assert.equal(records.length, 2);
    assert.equal(parseCode(records[0].code).date, '20260131');
    assert.equal(parseCode(records[1].code).date, '20260131', '2/1 那轮的编码日期段错用了发生日（应为会话开始日）');
    assert.match(records[1].code, /^20260131-[0-9a-z]{12}-[A-Z]-\d{8}$/);

    assert.deepEqual(listLedgerDayFiles(dataRoot), ['2026-01-31.jsonl', '2026-02-01.jsonl']);
    const day1 = readLedgerDay(dataRoot, '2026-01-31');
    const day2 = readLedgerDay(dataRoot, '2026-02-01');
    assert.equal(day1.length, 1);
    assert.equal(day2.length, 1);
    assert.equal(day1[0].turn, 1);
    assert.equal(day2[0].turn, 2);
    assert.equal(day2[0].ts.slice(0, 7), '2026-02');
  });
});

// ============================================================================
// 四、坏事件守卫：缺 time / 缺 data.turn 的 turn/start
// ============================================================================

/** 合成"坏边界"用的两行：一个 turn/start 缺 time，一个 turn/start 缺 data.turn。 */
function badBoundaryLines(createdAt) {
  return [
    // 缺 time：v0.1 会当 time=0 → 写出 1970-01-01T08:00:00+08:00 的假时间
    JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
    // 缺 data.turn：v0.1 会收进来 → (sid,turn) 闸门变成 sid#null，互相判重、丢真轮次
    JSON.stringify({ type: 'turn/start', time: createdAt + 1_000, data: {} }),
  ];
}

// 守：collectTurnsDetailed 必须把"缺 time"与"缺 data.turn"的边界都跳过并计入
// malformed=2，且 closed 为空、open 为空 —— 坏边界不许被装配成一条时间/身份
// 都不可信的轮次。这是 A15 修复的直接验收：不静默吞、也不制造假账。
test('坏事件守卫：缺 time 与缺 data.turn 的 turn/start → collectTurnsDetailed.malformed=2、closed 为空', async () => {
  await withLab(async ({ dshHome }) => {
    const createdAt = Date.parse('2026-11-08T09:00:00+08:00');
    const file = writeSessionFile(dshHome, { createdAt, frames: [badBoundaryLines(createdAt)] });

    // 走真实读取链路（多帧解压 → JSON 解析 → events），再喂给 collectTurnsDetailed
    const { head, events, meta } = readSessionEvents(file);
    assert.equal(head.id, SID);
    assert.equal(meta.failed, 0);
    assert.equal(meta.badLines, 0);

    const scan = collectTurnsDetailed(events);
    assert.equal(scan.malformed, 2);
    assert.deepEqual(scan.closed, []);
    assert.equal(scan.open, null);
  });
});

// 守：坏边界必须"报出来"而不是"悄悄少记"。runOnce 不写任何行（不进账），
// 但 stat.malformedTurns=2，且 stat.errors 里有对应条目 —— 事后审计才能知道
// "这个会话有 2 个边界读不全"，而不是把缺轮次当成正常。
test('坏事件守卫：同一会话驱动 runOnce → 不写任何行，stat.malformedTurns=2 且 errors 有条目', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-11-08T09:00:00+08:00');
    writeSessionFile(dshHome, { createdAt, frames: [badBoundaryLines(createdAt)] });

    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));
    assert.equal(stat.scanned, 1);
    assert.equal(stat.newTurns, 0);
    assert.equal(stat.written, 0);
    assert.equal(stat.malformedTurns, 2);
    assert.equal(
      stat.errors.some((e) => /malformed turns=2/.test(String(e))),
      true,
      'errors 里没有 malformed turns=2 的条目：' + JSON.stringify(stat.errors),
    );
    // 一条都不许写：台账目录里连 .jsonl 都不该出现（.state.json 允许）
    assert.deepEqual(listLedgerDayFiles(dataRoot), []);
    assert.equal(readAll(dataRoot).records.length, 0);
    // 汇总日志也要带上 bad=2（可审计的"出声"，不只是返回值）
    assert.equal(log.warnLines.some((l) => l.includes('bad=2')), true, 'warn 日志里缺 bad=2');
  });
});

// ============================================================================
// 五、孤儿轮次：只有 turn/start、无 turn/end
// ============================================================================

// 守：会话文件很新（mtime=现在）说明这轮可能还在进行中 → 一条都不许写，
// 只 stat.openTurns=1 计数等待。若提前写 partial，等它真闭合时会被
// (sid,turn) 闸门永久跳过，那条记录永远停在 partial（v0.1.1 的核心修正）。
test('孤儿轮次·进行中：只有 turn/start、mtime=现在（quietSeconds=120）→ written=0、openTurns=1，不写 partial', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-11-08T09:00:00+08:00');
    writeSessionFile(dshHome, {
      createdAt,
      frames: [[startLine(1, createdAt + 1_000)]], // 只 start，无 end；mtime=刚刚
    });

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { quietSeconds: 120 }));
    assert.equal(stat.scanned, 1);
    assert.equal(stat.newTurns, 0); // 没有"已闭合"轮次
    assert.equal(stat.written, 0);
    assert.equal(stat.openTurns, 1);
    assert.deepEqual(listLedgerDayFiles(dataRoot), []);
  });
});

// 守（★ v0.5 / 审计 A-01 后改写，2026-11-09）：
//   未闭合轮次**永远不进台账**，只在 `<root>/ledger/.pending.jsonl` 留 pending 证据；
//   一旦 turn/end 到达就走正常路径入账，最终结果是**恰好一条** status='ok'。
//
// 为什么把原来的"安静兜底写 partial"改掉：
//   v0.4 那个兜底看似保守，实则一旦写了就**永久锁死** —— 幂等闸门是 (sid,turn)，
//   真实闭合到达时该轮被判"已记过"而跳过；原文又因"凭证不可覆盖"永不更新，
//   于是永久停在 partial。审计实测：补 turn/end 后第三次扫描 written=0/skipped=1，
//   台账仍 partial、原文字节不变、closedStatusPresent=false。
//   审计给的整改方案①就是"只写可重建的 pending 状态，不进入最终账行"，本条照此守。
test('孤儿轮次·不写 partial（审计 A-01）：两扫均只留 pending，补 turn/end 后恰好一条 ok', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-11-08T09:00:00+08:00');
    const oldMs = Date.now() - 10 * 60 * 1000;
    writeSessionFile(dshHome, {
      createdAt,
      frames: [[startLine(1, createdAt + 1_000)]],
      mtimeMs: oldMs, // 模拟进程已死、文件不再被写（最像"该兜底"的现场）
    });

    const cfgQ = makeCfg(dataRoot, { quietSeconds: 120 });

    // 首扫：只登记 pending，台账必须还是空的
    const first = await runOnce({ logger: fakeLogger() }, cfgQ);
    assert.equal(first.scanned, 1);
    assert.equal(first.written, 0, '未闭合轮次不得入账（P0-2）');
    assert.equal(first.openTurns, 1);
    assert.equal(first.pendingTurns, 1, '必须留下 pending 证据');
    assert.deepEqual(listLedgerDayFiles(dataRoot), [], '台账必须仍为空');

    // 第二扫：仍然未闭合 → 仍然不入账；pending 证据必须幂等去重
    const second = await runOnce({ logger: fakeLogger() }, cfgQ);
    assert.equal(second.written, 0, '仍然未闭合 → 仍然不得入账');
    assert.equal(second.openTurns, 1);
    assert.equal(second.pendingDup, 1, 'pending 证据必须去重，不得每轮重复写');
    assert.deepEqual(listLedgerDayFiles(dataRoot), [], '两扫之后台账必须仍然是空的');

    const pend = readPending(dataRoot);
    assert.equal(pend.records.length, 1, 'pending 证据恰好一条（幂等）');
    assert.equal(pend.records[0].kind, 'turn-pending');
    assert.equal(pend.records[0].turn, 1);

    // 补上真实 turn/end → 走正常路径入账，恰好一条 ok
    writeSessionFile(dshHome, {
      createdAt,
      frames: [[startLine(1, createdAt + 1_000), endLine(1, createdAt + 60_000)]],
      mtimeMs: Date.now(),
    });
    const third = await runOnce({ logger: fakeLogger() }, cfgQ);
    assert.equal(third.written, 1, '闭合后必须入账');
    assert.equal(third.openTurns, 0);

    const records = readAll(dataRoot).records.filter((r) => r.turn === 1);
    assert.equal(records.length, 1, '★ 必须【恰好一个】版本（不得 partial+ok 两条）');
    assert.equal(records[0].status, 'ok', '★ 必须是已闭合的 ok，不是 partial');
    assert.equal(records[0].seq, 1);
    assert.equal(parseCode(records[0].code).date, '20261108');
  });
});

// ============================================================================
// 六、规模：单会话 1200 轮
// ============================================================================

// 守：1200 轮全量落账时条数与主键唯一性；二次运行必须靠 (sid,turn) 闸门
// 全部跳过（written=0、skipped=1200），不能因为重新算 code/seq 而重复写。
// 账只追加：多写一行就永远删不掉，少写一行就永远缺 —— 规模下最容易暴露。
// 耗时只记录数值（t.diagnostic），不设阈值比较：本机、当前实现的观测值，不作为回归门槛。
test('规模：单会话 1200 轮 → written=1200、code 唯一 1200、(sid,turn) 唯一 1200；二次 runOnce written=0、skipped=1200', async (t) => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-11-08T08:00:00+08:00'); // 会话开始日 = 20261108
    const base = Date.parse('2026-11-08T09:00:00+08:00');
    const TOTAL = 1200;
    const LINES_PER_FRAME = 400; // 200 轮一帧；总共 6 帧，顺带覆盖多帧拼接

    const frames = [];
    let buf = [];
    for (let turn = 1; turn <= TOTAL; turn++) {
      const startMs = base + turn * 1_000;
      buf.push(startLine(turn, startMs));
      buf.push(endLine(turn, startMs + 500));
      if (buf.length >= LINES_PER_FRAME) {
        frames.push(buf);
        buf = [];
      }
    }
    if (buf.length > 0) frames.push(buf);
    writeSessionFile(dshHome, { createdAt, frames });

    const cfg = makeCfg(dataRoot, { hotWindowSeconds: 0 });

    // ---- 首次运行：全写 ----
    const t0 = performance.now();
    const first = await runOnce({ logger: fakeLogger() }, cfg);
    const firstMs = performance.now() - t0;
    t.diagnostic(`1200 轮首跑耗时 ${firstMs.toFixed(1)} ms（仅记录，不比阈值）`);

    assert.equal(first.scanned, 1);
    assert.equal(first.newTurns, TOTAL);
    assert.equal(first.written, TOTAL);
    assert.equal(first.skipped, 0);
    assert.equal(first.errors.length, 0, '干净会话不该有 errors：' + JSON.stringify(first.errors));

    const records = readAll(dataRoot).records;
    assert.equal(records.length, TOTAL);
    const codes = records.map((r) => r.code);
    assert.equal(new Set(codes).size, TOTAL, 'code 不唯一');
    const sidTurns = records.map((r) => String(r.sid) + '#' + String(r.turn));
    assert.equal(new Set(sidTurns).size, TOTAL, '(sid,turn) 不唯一');
    assert.equal(records.every((r) => r.status === 'ok'), true);

    // ---- 二次运行：全靠 (sid,turn) 闸门跳过，一行都不许多写 ----
    const t1 = performance.now();
    const second = await runOnce({ logger: fakeLogger() }, cfg);
    const secondMs = performance.now() - t1;
    t.diagnostic(`1200 轮二次跑耗时 ${secondMs.toFixed(1)} ms（仅记录，不比阈值）`);

    assert.equal(second.written, 0);
    assert.equal(second.skipped, TOTAL);
    assert.equal(readAll(dataRoot).records.length, TOTAL); // 账本总数不变
  });
});

// ============================================================================
// INV-04：文件被截短/替换后，**新内容必须被读到**
//   （不能只断言"没崩、没重复"——那正是审计 A-02 当年的盲区：
//     截断测试只验了 written=0，却没验"新轮必须进账"。）
// ============================================================================
test('INV-04：截短重写后追加新 Turn → 新内容必须被读到（written>0、unchanged=0）', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const createdAt = Date.parse('2026-11-08T09:00:00+08:00');
    const cfg = makeCfg(dataRoot, { hotWindowSeconds: 0 });

    // 第一版：turn 1 + turn 2
    writeSessionFile(dshHome, {
      createdAt,
      frames: [
        [startLine(1, createdAt + 1000)], [endLine(1, createdAt + 1500)],
        [startLine(2, createdAt + 2000)], [endLine(2, createdAt + 2500)],
      ],
    });
    const r1 = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(r1.written, 2, '前置：两轮都要入账');

    // 第二版：文件被截短（去掉 turn 2）+ 追加一个**新** turn 3
    writeSessionFile(dshHome, {
      createdAt,
      frames: [
        [startLine(1, createdAt + 1000)], [endLine(1, createdAt + 1500)],
        [startLine(3, createdAt + 3000)], [endLine(3, createdAt + 3500)],
      ],
    });
    const r2 = await runOnce({ logger: fakeLogger() }, cfg);
    const rows = readAll(dataRoot).records;

    assert.equal(
      rows.some((r) => r.turn === 3),
      true,
      `新内容必须被读到：截短重写后 turn3 未入账（written=${r2.written} unchanged=${r2.unchanged} shrinkRollbacks=${r2.shrinkRollbacks}）`
    );
    assert.equal(r2.unchanged, 0, '文件变小了却走了 unchanged 快路径 —— 这就是漏记的入口');
    assert.equal(rows.filter((r) => r.turn === 1).length, 1, 'turn1 不许重复入账');
  });
});