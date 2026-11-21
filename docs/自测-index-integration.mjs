/**
 * @file 自测-index-integration.mjs
 * @role 入口层集成自测：只守 **index.js 接线**（不重复测 lib 自己的实现）。
 * @why 为什么需要它：
 *   P1-7 把入口里那份本地 ensureHandover 换成了 lib 的幂等入口；BC-15/okStrict 又新增了
 *   对账/补记链/运行报告接线。这些改动**外部语义必须与改前一致**（封板后 skip 且不重建、
 *   state 丢失不重建、adopt 只补证据不改字节、失败不抛穿），而 lib 单测只覆盖 lib 自己，
 *   不经过 runOnce —— 一旦入口把参数接错（比如 knownTurns 传错、seals 没注入、错误被吞），
 *   lib 全绿、入口静默坏掉。本文件就是那道"接线对不对"的闸。
 *
 * 运行（在源码仓库根目录）：
 *   & '<test-dir>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test docs/自测-index-integration.mjs
 *
 * 隔离纪律：临时 DSH_HOME / 临时 root；合成 zstd 会话；每用例 finally 删整棵目录。
 * 约定：每条 test 上方一行「守：」写明防的是哪种回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { runOnce, __test__ as idxTest } from '../index.js';
import { readAll, readState, writeState, ledgerDir } from '../lib/ledger.js';
import { readSealEvents, verifySealChain } from '../lib/sealjournal.js';
import { handoverMainName, handoverAppendixName } from '../freeze/handover.js';
import { reconcile } from '../lib/reconcile.js';
import { normalizeSessionId } from '../lib/encoder.js';
// V0.6.2：一级布局（写端落 `交接表/`；读端双路径）—— 断言新位置用同一份常量，不自己拼字符串
import { SUBDIR } from '../lib/layout.js';

/** 合成会话的完整 id（12 位短 id = 75238718e41a）。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** 12 位短 id / 首位代差 / 13 位会话键（第 1 条记录落到代差 A）。 */
const S12 = normalizeSessionId(SID);
const SESS_KEY = S12 + 'A';
/** 会话开始时刻（固定值）：2026-11-08 09:00:00 +08:00。 */
const CREATED_AT = Date.parse('2026-11-08T09:00:00+08:00');

// ============================================================================
// 一、测试基础设施
// ============================================================================

/** 建临时根目录并把它当作 `DSH_HOME`；跑完恢复环境变量、删目录。 */
async function withLab(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-int-'));
  assert.match(path.basename(root), /^dl-int-/);
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

const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const startLine = (turn, time) => JSON.stringify({ type: 'turn/start', time, data: { turn } });
const endLine = (turn, time) => JSON.stringify({ type: 'turn/end', time, data: { turn, reason: { kind: 'stop' } } });

/** 在临时 DSH_HOME 下合成一个会话文件（一帧含会话头，其余按帧追加）。 */
function writeSessionFile(dshHome, { frames = [] } = {}) {
  const dir = path.join(dshHome, 'sessions', '--lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'session.v4.jsonl.zstd');
  const head = JSON.stringify({ type: 'session', id: SID, createdAt: CREATED_AT, cwd: 'C:\\lab', agentPreset: 'lab' });
  fs.writeFileSync(p, Buffer.concat([[head], ...frames].map(frame)));
  return p;
}

/** 造一份 runOnce 需要的"已解析配置"（runOnce 不自己调 readConfig）。 */
function makeCfg(root, over = {}) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: 480,
    hotWindowSeconds: 0,
    quietSeconds: 120,
    // 周记账关掉：本文件只守入口接线，不想让周账产物干扰文件清单
    weeklyEnabled: false,
    // 交接表显式开（默认值也是开，这里写明是为了让用例意图自解释）
    handoverEnabled: true,
    receiptAnchorRoot: '',
    ...over,
  };
}

/** 假 logger：收集 info/warn，避免刷终端。 */
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

const sha = (buf) => (buf === undefined ? '' : JSON.stringify(buf));

/** 台账目录里当天的运行报告文件（最多 1 份）。 */
function runReportFiles(dataRoot) {
  const dir = ledgerDir(dataRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^\.run-report-\d{8}\.json$/.test(n)).sort();
}

/** 报告比较口径：数组按稳定键排序、忽略时间字段（对账结果里只有 at 是时间）。 */
function scrub(v) {
  if (Array.isArray(v)) {
    return v.map(scrub).sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === 'at' || k === 'lastAt') continue;
      out[k] = scrub(v[k]);
    }
    return out;
  }
  return v;
}

/** 一条已闭合轮次（两帧：start 一帧、end 一帧）。 */
const oneClosedTurn = () => [
  [startLine(1, CREATED_AT + 1000)],
  [endLine(1, CREATED_AT + 60_000)],
];

// ============================================================================
// 二、P1-7 / CH-13：首轮入账 → lib ensureHandover 生成 + 唯一 journal 封板事件
// ============================================================================

test('P1-7/CH-13：首轮入账 → 主表+附表落盘、journal 恰 1 条 handover-seal（字段齐/链 ok）、state 有封板缓存', async () => {
  // 守：入口必须把 ensureHandover 的参数接对（sessKey/knownTurns/seals/readContext）。
  // 接错的典型症状：不生成（附表永远"无"）、重复生成（每轮一个新封板事件）、
  // 或只写 state 不写 journal（P1-9 唯一权威丢失）。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    assert.equal(stat.written, 1, '先决条件：一轮必须已入账');
    assert.equal(stat.handoverGenerated, 1, '首轮必须 generate 交接表');
    assert.equal(stat.handoverAdopted, 0);
    assert.equal(stat.handoverSkipped, 0);

    const mainRel = handoverMainName(SESS_KEY);
    const appRel = handoverAppendixName(SESS_KEY);
    const mainAbs = path.join(dataRoot, SUBDIR.handover, mainRel);
    const appAbs = path.join(dataRoot, SUBDIR.handover, appRel);
    assert.equal(fs.existsSync(mainAbs), true, '主表应存在：交接表/' + mainRel);
    assert.equal(fs.existsSync(appAbs), true, '附表应存在：交接表/' + appRel);
    // V0.6.2 写端口径：**只写新子目录**。若这里又出现一级副本，说明写端回退了。
    assert.equal(fs.existsSync(path.join(dataRoot, mainRel)), false, '一级不得再散落主表（写端只写 交接表/）');
    assert.equal(fs.existsSync(path.join(dataRoot, appRel)), false, '一级不得再散落附表（写端只写 交接表/）');

    // journal：恰 1 条 handover-seal，字段齐（D12 扁平字段），链完整
    const sr = readSealEvents(dataRoot);
    assert.equal(sr.readError, '');
    const handoverEvents = sr.events.filter((e) => e && e.kind === 'handover-seal');
    assert.equal(handoverEvents.length, 1, 'journal 必须恰 1 条 handover-seal：' + JSON.stringify(handoverEvents));
    const ev = handoverEvents[0];
    assert.equal(ev.key, SESS_KEY);
    assert.equal(ev.decision, 'generated');
    assert.equal(ev.main, mainRel);
    assert.equal(ev.appendix, appRel);
    assert.match(String(ev.sealedAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'sealedAt 必须无时区后缀');
    assert.match(String(ev.sealHash), /^[0-9a-f]{64}$/, 'sealHash 必须 64 位 hex');
    assert.equal(verifySealChain(dataRoot).ok, true, '封板链必须完整');

    // state 只是缓存：必须同时有（旧读法/selfheal 依赖）
    const state = readState(dataRoot) || {};
    const rec = state.handoverSealed && state.handoverSealed[SESS_KEY];
    assert.ok(rec, 'state.handoverSealed 必须有该会话');
    assert.match(String(rec.sealedAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(String(rec.sealHash), /^[0-9a-f]{64}$/);

    // 运行报告（RC-12）：reconcile 段与"直接调用 reconcile()"逐项相等；backfill 段字段齐
    const reports = runReportFiles(dataRoot);
    assert.equal(reports.length, 1, '当日运行报告应恰 1 份：' + JSON.stringify(reports));
    const obj = JSON.parse(fs.readFileSync(path.join(ledgerDir(dataRoot), reports[0]), 'utf8'));
    assert.equal(obj.v, 1);
    const direct = reconcile({
      root: dataRoot, offsetMinutes: 480, receiptAnchorRoot: '', nowMs: Date.now(),
    });
    assert.deepEqual(scrub(obj.reconcile), scrub(direct), 'RC-12：报告 reconcile 段必须与直接调用逐项相等');
    assert.deepEqual(
      Object.keys(obj.backfill || {}).sort(),
      ['errors', 'late24h', 'outOfWindow', 'scanned24h', 'scanned3d', 'skipped', 'supplements'].sort(),
      'BC-15：backfill 段字段名必须与 plan.report 一致',
    );
    assert.deepEqual(obj.backfill, stat.backfill, 'BC-15：报告 backfill 段必须直接抄 stat.backfill');
    assert.equal(stat.backfillActions, 0, '干净场景不该有计划动作');
    assert.equal(stat.backfillExecuted, false, '入口今晚只产计划、不执行 action（必须显式可见）');
    assert.deepEqual(stat.backfillActionsByKind, {
      'backfill-missing-turns': 0, 'promote-pending': 0, 'write-supplement': 0,
    });
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(JSON.stringify(obj)), false,
      '运行报告不得出现 Z 时间');
  });
});

// ============================================================================
// 三、HO-22/HO-23/CH-17：封板后 skip 且不改字节；删主表不重建；state 丢失不重建
// ============================================================================

test('HO-22/23/CH-17：封板后 skip 且字节不动；删主表只报 sealed but file missing 不重建；删 state 仍不重建', async () => {
  // 守：P1-7 换成 lib 入口后，"封板即事实"必须原样保留 ——
  // 这是交接表最贵的一条：重建出来的表不是当初那本，却会被当成同一份证据。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const cfg = makeCfg(dataRoot);
    const first = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(first.handoverGenerated, 1);

    const mainPath = path.join(dataRoot, SUBDIR.handover, handoverMainName(SESS_KEY));
    const appPath = path.join(dataRoot, SUBDIR.handover, handoverAppendixName(SESS_KEY));
    const bytesBefore = { main: fs.readFileSync(mainPath), app: fs.readFileSync(appPath) };
    const mtimeBefore = { main: fs.statSync(mainPath).mtimeMs, app: fs.statSync(appPath).mtimeMs };

    // 第二跑：已封板 → skip，一个字节都不许动
    const second = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(second.handoverGenerated, 0);
    assert.equal(second.handoverSkipped, 1, '已封板必须 skip');
    assert.equal(sha(fs.readFileSync(mainPath)), sha(bytesBefore.main), 'HO-14 主表字节不得变');
    assert.equal(sha(fs.readFileSync(appPath)), sha(bytesBefore.app), 'HO-14 附表字节不得变');
    assert.equal(fs.statSync(mainPath).mtimeMs, mtimeBefore.main, 'HO-22 mtime 也不得变');
    assert.equal(fs.statSync(appPath).mtimeMs, mtimeBefore.app);

    // 手工删主表 → 仍 skip、不重建，但必须出声（HO-23）
    fs.rmSync(mainPath);
    const third = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(third.handoverGenerated, 0, '删了也不许重建');
    assert.equal(third.handoverSkipped, 1);
    assert.equal(fs.existsSync(mainPath), false, '主表不得重新出现');
    assert.equal(
      third.errors.some((e) => String(e).includes('sealed but file missing')), true,
      'HO-23：必须报 sealed but file missing，实际 errors=' + JSON.stringify(third.errors),
    );
    assert.equal(sha(fs.readFileSync(appPath)), sha(bytesBefore.app), '附表仍保持原字节');

    // 删 state（封板缓存丢失）→ journal 是权威：仍 skip、不重建（CH-17）
    fs.rmSync(path.join(ledgerDir(dataRoot), '.state.json'));
    const fourth = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(fourth.handoverGenerated, 0, 'state 丢失也不得重建（journal 说已封板）');
    assert.equal(fourth.handoverSkipped, 1);
    assert.equal(fs.existsSync(mainPath), false, '主表仍不得出现');
    const sr = readSealEvents(dataRoot);
    assert.equal(sr.events.filter((e) => e && e.kind === 'handover-seal').length, 1,
      '多轮运行后 handover-seal 必须仍恰 1 条（幂等，不许重复封板）');
  });
});

// ============================================================================
// 四、HO-24：主表已存在但无封板证据 → adopt 只补证据，不改旧文件一个字节
// ============================================================================

test('HO-24：旧主表存在（无封板两键）→ adopt 只补 state+journal，文件字节/mtime 不变、不补写附表', async () => {
  // 守：adopt 是"第一次见到就认它"，不是"顺手把旧文件重写成新版"。
  // 旧文件可能是人手工放的/旧版本写的 —— 重写等于篡改证据（决定 9 #2）。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });

    const mainRel = handoverMainName(SESS_KEY);
    const appRel = handoverAppendixName(SESS_KEY);
    const oldMd =
      `---\n名称: "${SESS_KEY}的记忆数据库的启用及交接表"\n会话标识: "${S12}"\n代差: "A"\n---\n\n` +
      `# ${SESS_KEY}的记忆数据库的启用及交接表\n\n旧版/手工放入的正文（adopt 不得改一个字节）\n`;
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, mainRel), oldMd, 'utf8');
    const beforeBytes = fs.readFileSync(path.join(dataRoot, mainRel));
    const beforeMtime = fs.statSync(path.join(dataRoot, mainRel)).mtimeMs;

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat.handoverAdopted, 1, 'HO-24：必须 adopt 认领');
    assert.equal(stat.handoverGenerated, 0);

    assert.equal(sha(fs.readFileSync(path.join(dataRoot, mainRel))), sha(beforeBytes), 'adopt 文件字节必须不变');
    assert.equal(fs.statSync(path.join(dataRoot, mainRel)).mtimeMs, beforeMtime, 'adopt mtime 也不得变');
    // adopt 只补证据、不补写附表：一级与 交接表/ 两处都不得出现附表
    assert.equal(fs.existsSync(path.join(dataRoot, appRel)), false, 'adopt 不得补写附表（一级）');
    assert.equal(fs.existsSync(path.join(dataRoot, SUBDIR.handover, appRel)), false, 'adopt 不得补写附表（交接表/）');

    const sr = readSealEvents(dataRoot);
    const events = sr.events.filter((e) => e && e.kind === 'handover-seal');
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, 'adopted', 'journal 必须留 adopted 证据');
    assert.equal(verifySealChain(dataRoot).ok, true);

    const state = readState(dataRoot) || {};
    assert.equal(state.handoverSealed[SESS_KEY].adopted, true, 'state 缓存必须标 adopted');
  });
});

// ============================================================================
// 五、CH-14：交接表写盘失败 → 不中断整轮、errors 含 handover failed、台账照写
// ============================================================================

test('CH-14：交接表写盘失败 → runOnce 不抛穿、errors 含 handover failed、台账照常入账、下轮可重试', async () => {
  // 守：P1-7 要求交接表失败只记 errors，不得中断本轮其余写入。
  // 注入方式：把主表 `.tmp` 路径占成目录 → 原子写的 openSync 必失败（EISDIR 系）。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });

    // 注入方式：把主表 `.tmp` 路径占成目录 → 原子写的 openSync 必失败（EISDIR 系）。
    // V0.6.2：写端落 `交接表/`，tmp 也在 `交接表/` 下（`<root>/交接表/<主表名>.tmp`）。
    const mainTmp = path.join(dataRoot, SUBDIR.handover, handoverMainName(SESS_KEY) + '.tmp');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(path.dirname(mainTmp), { recursive: true });
    fs.mkdirSync(mainTmp); // 占位：writeFileTmpRename 无法以目录为目标写文件

    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));

    // 台账必须照写（交接表失败不拖垮入账）
    assert.equal(stat.written, 1, '交接表写失败时台账仍必须入账');
    assert.equal(stat.handoverGenerated, 0, '失败不得计成 generate');
    assert.equal(
      stat.errors.some((e) => String(e).includes('handover failed')), true,
      'CH-14：errors 必须含 handover failed，实际=' + JSON.stringify(stat.errors),
    );
    assert.equal(readAll(dataRoot).records.length, 1);

    // 下轮可重试：清掉注入的占位目录后再跑 → 生成成功
    fs.rmSync(mainTmp, { recursive: true, force: true });
    const retry = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(retry.handoverGenerated, 1, '失败后下一轮必须能补生成（可重试）');
    assert.equal(fs.existsSync(path.join(dataRoot, SUBDIR.handover, handoverMainName(SESS_KEY))), true,
      '补生成后主表必须落在 交接表/');
    const sr = readSealEvents(dataRoot);
    assert.equal(sr.events.filter((e) => e && e.kind === 'handover-seal').length, 1, '最终只许 1 条封板事件');
  });
});

// ============================================================================
// 六、okStrict 闸门：ok=false 时禁止输出"无缺口/0 条"结论，必须写原因
// ============================================================================

test('闸门（V0.6.1 三级）：周账缺组（已知可枚举缺口）→ conclusion=degraded，reason/knownGaps 可定位', async () => {
  // 守（V0.6.1 / D18-C 口径变更）：两级 ok/unknown 把"知道有问题"和"不知道"挤在一起；
  //   三级后：账本读全 + 唯一性成立 + 有**已知可枚举**缺口 → degraded（有保留），而不是 unknown。
  //   但 degraded 同样**禁止**输出"无缺口"：reason 与 knownGaps 必须逐项可查。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { weeklyEnabled: false }));

    assert.equal(stat.written, 1);
    assert.ok(stat.reconcile, '必须产出对账摘要');
    assert.equal(stat.reconcile.ok, false, '周账组缺失 → ok=false');
    assert.equal(stat.reconcile.okStrict, false);
    assert.equal(stat.reconcile.conclusion, 'degraded', '★ 已知可枚举缺口 = 有保留（不是 ok，也不是 unknown）');
    assert.equal(typeof stat.reconcile.reason, 'string');
    assert.notEqual(stat.reconcile.reason, '', 'degraded 必须写明原因');
    assert.match(stat.reconcile.reason, /缺周账/, 'reason 必须可定位：' + stat.reconcile.reason);
    assert.ok(Array.isArray(stat.reconcile.knownGaps), 'knownGaps 必须是数组（degraded 的逐项依据）');
    assert.equal(stat.reconcile.knownGaps.some((x) => /^缺周账=/.test(String(x))), true,
      'knownGaps 必须含"缺周账=N"：' + JSON.stringify(stat.reconcile.knownGaps));
  });
});

// ============================================================================
// 三、审计 #1/#2：运行报告必须是"装真数据"的，不是空壳
// ============================================================================

test('审计#1/#2：运行报告带真数据（gate/batches/errors/pending/unavailable），不许硬编码空壳', async () => {
  // 守：原实现把 `errors: []`、`blockedSources: []` 硬编码；`batches[]`/`pending` 干脆没有；
  //     而 okStrict 闸门的 conclusion 只活在内存里、落盘的是 raw `ok`（可为 true）。
  //     后果是"报告说一切正常、其实什么都没采" —— 比没有报告更糟。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat.written, 1, '先决条件：一轮必须已入账');

    const files = runReportFiles(dataRoot);
    assert.equal(files.length, 1, '必须写下当日运行报告');
    const rep = JSON.parse(fs.readFileSync(path.join(ledgerDir(dataRoot), files[0]), 'utf8'));

    // ① 闸门结论必须落盘（审计 #2）
    assert.ok(rep.gate && typeof rep.gate === 'object', 'gate 段必须存在（否则"不得声称无缺口"只活在内存）');
    assert.ok(
      ['ok', 'degraded', 'unknown'].includes(rep.gate.conclusion),
      'conclusion 只能是 ok/degraded/unknown（V0.6.1 三级），实际=' + String(rep.gate && rep.gate.conclusion)
    );
    assert.ok(Array.isArray(rep.gate.knownGaps), 'gate.knownGaps 必须落盘（degraded 的逐项依据）');
    assert.equal(typeof rep.gate.okStrict, 'boolean', 'okStrict 必须可机读');

    // ② batches：INV-11/12 的机读证据
    assert.ok(Array.isArray(rep.batches) && rep.batches.length >= 1, 'batches[] 必须存在且非空');
    for (const b of rep.batches) {
      assert.equal(Number.isInteger(b.turns), true, 'batches[].turns 必须是整数');
      assert.equal(Number.isInteger(b.events), true, 'batches[].events 必须是整数');
      assert.equal(typeof b.oversize, 'boolean', 'batches[].oversize 必须是布尔');
    }
    assert.equal(rep.counts.batches, rep.batches.length, 'counts.batches 必须与数组长度自洽');

    // ③ errors / blockedSources 不许是硬编码空壳
    assert.ok(Array.isArray(rep.errors), 'errors 必须是数组（来自 .errors.jsonl 聚合）');
    assert.ok(Array.isArray(rep.blockedSources), 'blockedSources 必须是数组（来自本轮真实收集）');

    // ④ 本轮确实没采的段，必须显式标 unavailable，而不是默默给空数组
    assert.ok(Array.isArray(rep.unavailable), 'unavailable[] 必须存在');
    assert.equal(rep.unavailable.includes('stuckSources'), true, '没采集的段必须点名');

    // ⑤ pending 幂等证据（INV-06/08）
    assert.ok(rep.pending && typeof rep.pending === 'object', 'pending 段必须存在');
    assert.equal(Number.isInteger(rep.pending.added), true);
    assert.equal(Number.isInteger(rep.pending.dup), true);

    // ⑥ ★ V0.6.2：一级布局快照必须进运行报告（EXTRA_KEYS 通道；形状与 stat.layout 一致）
    assert.ok(rep.layout && typeof rep.layout === 'object', 'layout 段必须落盘（否则"旧布局还有几份没搬"只活在内存）');
    assert.equal(Number.isInteger(rep.layout.version), true, 'layout.version 必须是整数（1/2/3）');
    assert.equal(typeof rep.layout.marker, 'boolean', 'layout.marker 必须可机读');
    assert.ok(Array.isArray(rep.layout.oldFiles), 'layout.oldFiles 必须是数组');
    assert.ok(Array.isArray(rep.layout.dirsPresent), 'layout.dirsPresent 必须是数组');
    assert.deepEqual(rep.layout, stat.layout, '报告 layout 段必须直接抄 stat.layout（不许二次加工）');
    // ⑦ ★ V0.6.2：标记必须已补写；探测时看到的 marker 必须是 true
    assert.equal(rep.layout.marker, true, '本轮已确保 .ledger-root → 报告 marker 必须 true');
    assert.equal(fs.existsSync(path.join(dataRoot, '.ledger-root')), true, '账库根标记文件必须已补写');
  });
});

// ============================================================================
// 五、INV-12：单轮字节超预算 → 单独成批 + oversize=true，且该轮不许丢
// ============================================================================

test('INV-12：单轮事件字节超 eventBatchBytes → 单独成批且 oversize=true，该轮仍入账', async () => {
  // 守：预算"只按事件数/轮数"算、不按字节算的话，一个 5 MB 的 tool/result
  //   会被塞进普通批里，报告上看不出它超预算 —— 契约要求
  //   `{turns:1, oversize:true, bytes:<实算>}` 且该轮**正常入账**（不丢弃、不死循环）。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    const bigEvent = JSON.stringify({
      type: 'tool/result', time: CREATED_AT + 2000,
      data: { message: { isError: false, content: [{ type: 'text', text: crypto.randomBytes(48 * 1024).toString('base64') }] } },
    });
    writeSessionFile(dshHome, {
      frames: [
        [startLine(1, CREATED_AT + 1000)],
        [bigEvent],
        [endLine(1, CREATED_AT + 60_000)],
      ],
    });
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, {
      weeklyEnabled: false,
      eventBatchBytes: 4096, // 故意压到远小于单轮事件体量
    }));

    assert.equal(stat.written, 1, '超预算的单轮也必须入账（不许丢）');
    assert.equal(stat.eventOversize, 1, `必须恰好计 1 个 oversize 批，实际=${stat.eventOversize}；batches=${JSON.stringify(stat.batchRecords)}`);
    const b = stat.batchRecords[0];
    assert.ok(b, '必须有批次记录');
    assert.equal(b.turns, 1, '超预算的这一轮必须单独成批');
    assert.equal(b.oversize, true, '这一批必须标 oversize=true');
    assert.ok(b.bytes > 4096, `批字节必须如实记账（实际=${b.bytes}，预算=4096）`);
  });
});

// ============================================================================
// 六、INV-11：批大小必须真的受 eventBatchTurns 约束（否则"有界"是纸面的）
// ============================================================================

test('INV-11：40 轮会话必须分多批，且每批轮数 ≤ eventBatchTurns，批内之和 == 总轮数', async () => {
  // 守：预算写成常量却不生效（例如把 batchTurns 一次取成全部 todo），
  //   报告里 batches 就会只有 1 批 —— 内存"有界"只是纸面承诺。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    const frames = [];
    for (let t = 1; t <= 40; t += 1) {
      frames.push([startLine(t, CREATED_AT + t * 1000)]);
      frames.push([endLine(t, CREATED_AT + t * 1000 + 500)]);
    }
    writeSessionFile(dshHome, { frames });
    const limit = idxTest.DEFAULTS.eventBatchTurns;
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { weeklyEnabled: false }));

    assert.equal(stat.written, 40, '40 轮必须全部入账');
    assert.ok(
      stat.batchRecords.length >= 2,
      `40 轮必须至少分 2 批（eventBatchTurns=${limit}），实际批数=${stat.batchRecords.length}`
    );
    for (const b of stat.batchRecords) {
      assert.ok(b.turns <= limit, `每批轮数必须 ≤ ${limit}，实际=${b.turns}`);
    }
    assert.equal(
      stat.batchRecords.reduce((n, b) => n + b.turns, 0), 40,
      '批内轮数之和必须等于总轮数（不许多算/漏算）'
    );
  });
});

// ============================================================================
// 七、V0.6.2 宿主接线：默认根（桌面）、首次收养旧默认根、布局探测
// ============================================================================

/**
 * 临时把 USERPROFILE / DSH_HOME 指到临时目录，跑完恢复。
 *
 * @why 默认根由 `os.homedir()` 决定（Windows 上读 USERPROFILE），不覆盖它就会
 *      在测试里碰到**这台机器真实的桌面**。宁可多一层 helper，也不许测试写到真桌面。
 */
async function withHomeOverride(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-int-home-'));
  assert.match(path.basename(base), /^dl-int-home-/);
  const home = path.join(base, 'home');
  const dshHome = path.join(base, 'dsh');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const savedProfile = process.env.USERPROFILE;
  const savedDshHome = process.env.DSH_HOME;
  process.env.USERPROFILE = home;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ base, home, dshHome });
  } finally {
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    if (savedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDshHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('V0.6.2-根：默认根 = <home>/Desktop/会话账本；首次运行同盘收养旧默认根（旧账随根搬走、不复制不删除）', async () => {
  // 守：《v0.6.2-迁移规格-v1》§1.1 —— 默认根必须落桌面；机主设备升级后第一次启动，
  //     旧默认根 `~/.dsh/dialog-ledger` 要被"收养"（同盘 rename 到新根），
  //     否则用户会看到一个空账库、旧账永远躺在 .dsh 里没人知道。
  await withHomeOverride(async ({ home, dshHome }) => {
    // ① 默认根：<home>/Desktop/会话账本；root 仍是字符串、rootSource 标来源
    const cfg = idxTest.readConfig({});
    assert.equal(typeof cfg.root, 'string', 'readConfig().root 必须仍是字符串（旧读法不许破）');
    assert.equal(cfg.rootSource, 'default', '空配置 → rootSource 必须是 default');
    assert.equal(cfg.root, path.join(home, 'Desktop', '会话账本'), '默认根必须落在 <home>/Desktop/会话账本');
    assert.equal(idxTest.resolveRoot(''), path.join(home, 'Desktop', '会话账本'), 'resolveRoot("") 同口径');

    // ② 显式配置永远优先（且不被收养逻辑改动）
    const custom = path.join(home, '自定义账库');
    const cfgCustom = idxTest.readConfig({ root: custom });
    assert.equal(cfgCustom.root, custom, '显式 root 必须原样优先');
    assert.equal(cfgCustom.rootSource, 'configured');

    // ③ 旧默认根存在 + 新根不存在 → 收养（同盘 rename）
    const legacy = path.join(dshHome, 'dialog-ledger');
    fs.mkdirSync(path.join(legacy, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'ledger', '2026-11-08.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(legacy, '旧库凭证-不许丢.md'), '旧账库里的文件\n', 'utf8');

    idxTest.resetPeriodicThrottle();
    const stat = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(fs.existsSync(path.join(cfg.root, 'ledger', '2026-11-08.jsonl')), true,
      '旧账必须随根搬到新默认根（rename 而非复制）');
    assert.equal(fs.existsSync(path.join(cfg.root, '旧库凭证-不许丢.md')), true, '旧根里的非标准文件也必须一起搬走');
    assert.equal(fs.existsSync(legacy), false, '同盘 rename 后旧路径不该存在（数据是搬走，不是删除）');
    assert.equal(stat.errors.length, 0, '干净收养不该报错，实际=' + JSON.stringify(stat.errors));
    // 收养后的根也是正常账库：根标记 + 当日总目录都要被建出来
    assert.equal(fs.existsSync(path.join(cfg.root, '.ledger-root')), true, '收养后必须补写 .ledger-root');
    assert.equal(fs.existsSync(path.join(cfg.root, '账簿总目录.md')), true, '收养后首轮成功必须生成《账簿总目录》');

    // ④ 没有桌面目录 → 退回 <home>/会话账本（服务/无桌面环境也得能跑）
    fs.rmSync(path.join(home, 'Desktop'), { recursive: true, force: true });
    assert.equal(idxTest.readConfig({}).root, path.join(home, '会话账本'),
      '桌面不存在时必须退回 <home>/会话账本');
  });
});

test('V0.6.2-收养三约束：configured 根不收养；新根已存在不收养（绝不覆盖/合并）', async () => {
  // 守：收养只能发生在"默认根 + 新根不存在 + 旧默认根存在"三者同时成立时 ——
  //     任何一条不成立就宁可空库，也不许搬用户的账（搬错 = 两个写者/账劈叉）。
  await withHomeOverride(async ({ base, dshHome }) => {
    const legacy = path.join(dshHome, 'dialog-ledger');
    fs.mkdirSync(path.join(legacy, 'ledger'), { recursive: true });
    // 用一个"只可能在旧根里"的证明文件判断新旧根内容是否被合并/覆盖：
    // （不能拿 .state.json 当证据 —— 新根自己开账也会写一份同名的。）
    const proof = '.旧根证明.json';
    fs.writeFileSync(path.join(legacy, 'ledger', proof), JSON.stringify({ from: 'legacy' }) + '\n', 'utf8');

    // ① configured 根：显式配置优先，旧默认根一个字节都不许动
    const customRoot = path.join(base, '用户选的账库');
    const statCfg = await runOnce({ logger: fakeLogger() }, idxTest.readConfig({ root: customRoot }));
    assert.equal(fs.existsSync(path.join(legacy, 'ledger', proof)), true,
      'configured 根不该触发收养（旧根必须原地不动）');
    assert.equal(fs.existsSync(path.join(customRoot, 'ledger')), true, 'configured 根仍要正常开账');
    assert.equal(fs.existsSync(path.join(customRoot, 'ledger', proof)), false,
      'configured 根绝不能被塞进旧根的任何文件');

    // ② 新根已存在（哪怕空目录）：不收养、不覆盖、不合并
    const newRoot = idxTest.resolveRoot('');
    fs.mkdirSync(newRoot, { recursive: true });
    const statDefault = await runOnce({ logger: fakeLogger() }, idxTest.readConfig({}));
    assert.equal(fs.existsSync(path.join(legacy, 'ledger', proof)), true,
      '新默认根已存在时不许收养（否则旧根被搬进一个已被占用的根 = 合并）');
    assert.equal(fs.existsSync(path.join(newRoot, 'ledger', proof)), false,
      '新根不该凭空出现旧根的文件（不覆盖、不合并）');
    assert.equal(statDefault.errors.length, 0, '该场景也不该报错，实际=' + JSON.stringify(statDefault.errors));
  });
});

test('V0.6.2-布局探测：一级有旧单据 → stat.layout.version=3 + 告警建议跑迁移工具；宿主绝不自动搬', async () => {
  // 守：规格 §三 "唯一写盘入口 = 迁移工具，默认 dry-run"。宿主只许**探测 + 告警**；
  //     若它自动 rename，用户就没有 dry-run 复核的机会，冲突/半搬没人能接。
  await withLab(async ({ dataRoot }) => {
    fs.mkdirSync(dataRoot, { recursive: true });
    // 新布局子目录已建 + 一级还残留一份旧交接表 → layoutVersion 3（混合）
    fs.mkdirSync(path.join(dataRoot, SUBDIR.handover), { recursive: true });
    const oldMain = handoverMainName(SESS_KEY);
    fs.writeFileSync(path.join(dataRoot, oldMain), '# 旧布局残留\n', 'utf8');

    idxTest.resetPeriodicThrottle();
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, {
      weeklyEnabled: false,
      handoverEnabled: false,
    }));

    assert.ok(stat.layout && typeof stat.layout === 'object', 'stat.layout 必须存在');
    assert.equal(stat.layout.version, 3, '新子目录已建 + 一级有旧单据 = 混合布局 layoutVersion=3');
    assert.equal(stat.layout.dirsPresent.includes(SUBDIR.handover), true, 'dirsPresent 必须列出 交接表/');
    assert.deepEqual(stat.layout.oldFiles.map((f) => f.name), [oldMain], 'oldFiles 必须列出该旧单据');
    assert.equal(stat.layout.oldFiles[0].kind, 'handover-main', 'oldFiles[].kind 必须是布局分类');
    assert.equal(
      stat.warnings.some((w) => String(w).includes('工具-迁移布局.mjs')), true,
      '必须告警建议跑迁移工具，实际 warnings=' + JSON.stringify(stat.warnings),
    );
    assert.equal(fs.existsSync(path.join(dataRoot, oldMain)), true, '宿主绝不自动搬（文件必须原地不动）');

    // 运行报告里也要有同一份布局快照（审计能看到"这个库还没迁"）
    const reports = runReportFiles(dataRoot);
    assert.equal(reports.length, 1, '应写下当日运行报告');
    const rep = JSON.parse(fs.readFileSync(path.join(ledgerDir(dataRoot), reports[0]), 'utf8'));
    assert.deepEqual(rep.layout, stat.layout, '报告 layout 段必须与 stat.layout 逐项一致');
    assert.equal(rep.layout.version, 3);

    // V0.6.2 另外两件宿主接线：根标记 + 成功轮刷新一次总目录
    assert.equal(stat.layout.marker, true, '.ledger-root 补写后 marker 必须 true');
    assert.equal(fs.existsSync(path.join(dataRoot, '.ledger-root')), true, '必须补写 .ledger-root');
    assert.equal(fs.existsSync(path.join(dataRoot, '账簿总目录.md')), true, '成功轮必须刷新《账簿总目录》');
    const st = readState(dataRoot) || {};
    assert.match(String(st.catalogDate || ''), /^\d{8}$/, 'state.catalogDate 必须是 YYYYMMDD');
  });
});

// ============================================================================
// 八、V0.6.2 根标记 + 每日总目录刷新（幂等 / 失败只 warn）
// ============================================================================

test('V0.6.2-根标记：runOnce 幂等补写 .ledger-root（v1/kind/rootId/layoutVersion=2）；二次零写；坏了只 warn', async () => {
  // 守：《v0.6.2-迁移规格-v1》§1.2 —— marker 是账库"身份证"，老库要补写；
  //     幂等必须是"零写"的幂等（否则每次启动都改 mtime，备份/同步盘被无意义搅动）；
  //     坏 marker 不许被静默覆盖（那是一份待人工处置的证据）。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const cfg = makeCfg(dataRoot);
    idxTest.resetPeriodicThrottle();
    const first = await runOnce({ logger: fakeLogger() }, cfg);
    const markerPath = path.join(dataRoot, '.ledger-root');
    assert.equal(fs.existsSync(markerPath), true, '首轮必须补写 .ledger-root');
    assert.equal(first.layout.marker, true, 'stat.layout.marker 必须为 true');

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.v, 1, 'marker.v 必须是 1');
    assert.equal(marker.kind, 'dsh-dialog-ledger-root', 'marker.kind 必须固定');
    assert.match(String(marker.rootId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'marker.rootId 必须是 uuid');
    assert.equal(marker.layoutVersion, 2, 'marker.layoutVersion 必须跟 lib/layout.js 的 LAYOUT_VERSION');
    assert.match(String(marker.createdAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/,
      'marker.createdAt 必须是无 Z 的 +08:00 时间');

    // 幂等：同日第二轮不得改一个字节 / 不得改 mtime
    const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(markerPath)).digest('hex');
    const mtimeBefore = fs.statSync(markerPath).mtimeMs;
    const second = await runOnce({ logger: fakeLogger() }, cfg);
    const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(markerPath)).digest('hex');
    assert.equal(shaAfter, shaBefore, '已合规的 marker 不许重写（零写幂等）');
    assert.equal(fs.statSync(markerPath).mtimeMs, mtimeBefore, 'marker mtime 不许变');
    assert.equal(second.layout.marker, true);

    // 坏了：不静默覆盖、只 warn；本轮记账照常（无新行但一轮跑完）
    fs.writeFileSync(markerPath, '{坏 JSON', 'utf8');
    const third = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(
      third.warnings.some((w) => String(w).includes('.ledger-root')), true,
      '坏 marker 必须 warn，实际 warnings=' + JSON.stringify(third.warnings),
    );
    assert.equal(fs.readFileSync(markerPath, 'utf8'), '{坏 JSON', '坏 marker 不许被静默覆盖');
    assert.equal(third.errors.some((e) => String(e).includes('marker')), false,
      'marker 坏属于"该知道"不是"账务出错"，不得进 errors');
  });
});

test('V0.6.2-总目录：每日一次刷新（state.catalogDate，+08:00 口径）；失败只 warn 不拖垮记账', async () => {
  // 守：《v0.6.2-迁移规格-v1》§2.3 —— 总目录是人读导航，每日一次即可；
  //     它写不进去不许拖垮记账（不进 errors、不改写账务结论），也不许把"没写成功"记成今天已刷。
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const cfg = makeCfg(dataRoot);
    idxTest.resetPeriodicThrottle();
    const first = await runOnce({ logger: fakeLogger() }, cfg);
    const catalogAbs = path.join(dataRoot, '账簿总目录.md');
    assert.equal(fs.existsSync(catalogAbs), true, '首轮成功 → 必须生成《账簿总目录》');
    assert.ok(first.catalog && first.catalog.path === catalogAbs, 'stat.catalog 必须给出总目录路径');
    // 内容自检（规格 §2.3 的段与声明必须真的在；不是写个空文件交差）
    const catalogText = fs.readFileSync(catalogAbs, 'utf8');
    assert.match(catalogText, /^# 账簿总目录/m, '总目录必须有 H1 标题');
    assert.match(catalogText, /本文件是\*\*人读导航\*\*/, '总目录必须声明"人读导航、不是账务记录"');
    assert.match(catalogText, /`\.ledger-root` \| 有效/, '本轮已补写标记 → 总目录必须显示标记有效');
    assert.match(catalogText, /\| 交接表 \| 2 \| 2 \| 0 \| 主表 1 \/ 附表 1 \|/,
      '本轮写进 交接表/ 的主表+附表必须被总目录按"新目录"数到（写端/读端同一套 layout）');

    /** 当前 +08:00 的 YYYYMMDD。 */
    const ymdOf = (ms) => {
      const d = new Date(ms + 480 * 60000);
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    };
    const today = ymdOf(Date.now());
    assert.equal(readState(dataRoot).catalogDate, today, 'state.catalogDate 必须是 +08:00 的当日 YYYYMMDD');

    // 同日第二轮：不再写（mtime 不动）
    const mtimeBefore = fs.statSync(catalogAbs).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));
    const second = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(second.catalog, undefined, '当日已刷新 → 本轮不得再写总目录');
    assert.equal(fs.statSync(catalogAbs).mtimeMs, mtimeBefore, '同日不得重写总目录（每日一次）');

    // 模拟跨日：把 state.catalogDate 改成昨天 → 下一轮必须刷新
    const st = readState(dataRoot) || {};
    st.catalogDate = ymdOf(Date.now() - 86400000);
    writeState(dataRoot, st);
    await new Promise((r) => setTimeout(r, 25));
    const third = await runOnce({ logger: fakeLogger() }, cfg);
    assert.ok(third.catalog && third.catalog.path === catalogAbs, '跨日后必须刷新总目录');
    assert.equal(readState(dataRoot).catalogDate, today, '刷新成功后 catalogDate 必须回到今天');

    // 写失败：把总目录路径占成目录 → rename 到它必失败。只 warn、不进 errors、不记当天已刷。
    fs.rmSync(catalogAbs);
    fs.mkdirSync(catalogAbs); // 目录占位
    const stFail = readState(dataRoot) || {};
    stFail.catalogDate = '';
    writeState(dataRoot, stFail);
    const fail = await runOnce({ logger: fakeLogger() }, cfg);
    assert.equal(fail.errors.some((e) => String(e).includes('总目录')), false,
      '总目录写失败不得进 errors（导航页不承载账务事实）');
    assert.equal(fail.warnings.some((w) => String(w).includes('账簿总目录刷新失败')), true,
      '必须 warn 出声，实际 warnings=' + JSON.stringify(fail.warnings));
    assert.notEqual(readState(dataRoot).catalogDate, today,
      '没写成功就不得把今天记为已刷新（否则今天再也不重试）');
    fs.rmSync(catalogAbs, { recursive: true, force: true });
  });
});

// ============================================================================
// 四·B、V0.6.2 补 2 修正：首轮全量扫描 + 历史未闭合轮 → 回填计划不得误报
// ============================================================================
test('V0.6.2：首轮全量扫描后，历史会话的 pending 不得被回填计划误报为 pending-entry-not-scanned', async () => {
  // 守（补 2 真实会话实测）：首轮 runOnce 已全量扫描；回填计划若仍按 mtime 的 24h 窗重扫，
  //   历史会话（mtime 旧）不在窗内 → 把本轮刚记下的 pending 误报成"源不在扫描结果里"。
  //   修法：首轮把本轮全量会话清单（sid 可编码者）传给 backfillPlan；稳态仍用 24h 窗。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    const p = writeSessionFile(dshHome, { frames: [[startLine(1, CREATED_AT + 1000)]] }); // 只有 start，无 end
    const old = new Date(Date.now() - 3 * 86400000);
    fs.utimesSync(p, old, old); // 历史会话：mtime 在 24h 窗之外
    const stat = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot, { quietSeconds: 0 }));
    assert.equal(stat.written, 0, '未闭合轮不得写台账');
    assert.equal(stat.pendingTurns >= 1, true, '必须先记 pending，stat.pendingTurns=' + stat.pendingTurns);
    assert.equal(stat.errors.some((e) => /pending-entry-not-scanned/.test(String(e))), false,
      '首轮不得误报 pending-entry-not-scanned：' + JSON.stringify(stat.errors));
    assert.equal(stat.errors.length, 0, '该场景 errors 必须为空，实际=' + JSON.stringify(stat.errors));
  });
});
// ============================================================================
// P0（v0.6.3）：宿主 ctx 的未注入服务属性会抛错 —— runOnce 不得因此崩溃
// ============================================================================
test('P0：ctx.signal 读取抛错（Cordis 未 inject）时 runOnce 仍必须正常落账', async () => {
  // 守（2026-11-10 重启实测）：Cordis 的 ctx 上访问未 inject 的服务属性会抛
  // "cannot get property \"signal\" without inject"。v0.6.2 及更早直接读 ctx.signal，
  // 导致真宿主里每一轮 runOnce 刚进 core 就抛 → 插件从未落过账（v0.6.1 同现象）。
  // 进程内测试/子进程用普通对象 ctx，永不触发，所以此前的 420 条测试全绿也没发现。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const ctx = {
      logger: fakeLogger(),
      get signal() { throw new Error('cannot get property "signal" without inject'); },
    };
    const stat = await runOnce(ctx, makeCfg(dataRoot));
    assert.equal(stat.written, 1, '不得因 ctx.signal 抛错而漏账');
    assert.equal(stat.errors.length, 0, 'errors 应为空，实际=' + JSON.stringify(stat.errors));
  });
});
test('P0-1c：文件字节没变但 mtime 变了 → 不得走 unchanged 快路径（重读一次）', async () => {
  // 2026-11-11 定向探针查出的漏洞形态：旧实现的"没变"判断只有
  //   ① 大小相同 ② 头部 4 KiB 指纹相同 ③ 上次读到尾。
  // 当源文件被"同大小 + 同头 + 换尾部"重写时，三条全满足 → 永久漏记。
  // 修法：游标记 mtime，作为第三条独立证据（头指纹只看前 4 KiB，看不见尾部）。
  // 本用例守的是**这条证据本身**：字节完全一样、只把 mtime 拨动，也必须重读。
  idxTest.resetPeriodicThrottle();
  await withLab(async ({ dshHome, dataRoot }) => {
    const p = writeSessionFile(dshHome, { frames: oneClosedTurn() });
    const stat1 = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat1.written, 1, '先决条件：第一轮已入账');

    // 对照一：什么都不动 → 必须走 unchanged（增量收益不能丢）
    const stat2 = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat2.unchanged, 1, '文件没动时应走 unchanged 快路径（否则增量读退化成全量）');

    // 对照二：只把 mtime 往前拨 5 秒（字节一个不改）
    const st = fs.statSync(p);
    fs.utimesSync(p, st.atime, new Date(st.mtimeMs + 5000));
    const stat3 = await runOnce({ logger: fakeLogger() }, makeCfg(dataRoot));
    assert.equal(stat3.unchanged, 0, 'mtime 变了就不许再判 unchanged（宁可多读一次，不可漏记一轮）');
    assert.equal(stat3.written, 0, '(sid,turn) 幂等：重读不会重复入账');
    assert.equal(stat3.errors.length, 0, 'errors 应为空，实际=' + JSON.stringify(stat3.errors));
  });
});