/**
 * @file 验证-F1未闭合轮可见.mjs
 * @role 回归锁（v1.0.0-preview4 / R1·R2「零静默」）：**未闭合轮不许静默**。
 *
 * @why 这是第 3 轮审计与《15 号行动前的说明》§1 同时点名的静默类缺陷：
 *      插件对"只见到 turn/start、没见到 turn/end"的轮次做对了事（不写 partial、不假绿），
 *      但**只写 `<root>/ledger/.pending.jsonl`**，而 `reconcile()` 与 `gate` 都不读 pending
 *      → 实测 `gate: ok / knownGaps: []`、run-report 里也没有 openTurns 清单。
 *      结果：某个会话在某轮中途**永久终止**（DSH 不再写这个文件）时，这一轮永远不入账，
 *      而健康面板说"一切正常" —— 这正是"静默丢账"（R1）与"静默报绿"（R2）。
 *
 * @口径（写死；判据不随实现漂移）
 *      ① 源**已静止**（mtime 距今 > 2×intervalSeconds）且仍有未闭合轮 → gate 必须 degraded，
 *         且 knownGaps 里必须有一条**点名"未闭合轮"**的缺口（不许只靠"缺周账"这类别的缺口凑 degraded）；
 *      ② run-report 必须列 `openTurns` 清单（sid/turn/startByte/静止时长/是否 stale），人能逐项查；
 *      ③ **不许误报**：源还在活跃写（mtime 新鲜）的未闭合轮 = 正常进行中，**不许**进 knownGaps；
 *      ④ 台账语义不动：未闭合轮不进台账、不写 partial（这条是既有契约，本测试只守不改）。
 *
 * @run  node --test --test-concurrency=1 docs\验证-F1未闭合轮可见.mjs
 *
 * @naming 故意不叫 `自测-*.mjs`：绿之前不并入全量套件（否则"预期红"会把逐名对账闸门撞红）。
 *
 * 写盘纪律：临时文件只落 `%TEMP%\dl-f1-*`，用例结束整目录删除；不碰真实 ~/.dsh、不改产品源码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { runOnce } from '../index.js';
import { readAll } from '../lib/ledger.js';

const OFFSET_MINUTES = 480;
const SESSION_FILE = 'session.v3.jsonl.zstd';
const SID = 'session-7f1c0de1-2222-4e77-8a11-0f2b3c4d5e6f';
const T0 = Date.parse('2026-11-15T06:00:00+08:00');
const CLOSED_TURNS = 3;
const OPEN_TURN = CLOSED_TURNS + 1;
/** 未闭合轮用例：源静止 10×interval（远大于 2× 阈值）。 */
const STATIC_AGE_MS = 10 * 60 * 1000;

const frame = (lineArr) => zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));

/**
 * 造 v3 会话：3 个闭合轮 + 第 4 轮只有 turn/start（未闭合）。
 * @returns {{fileBuffer:Buffer, closedTurns:number, openTurn:number}}
 */
function buildFixture() {
  const header = JSON.stringify({ type: 'session', version: 3, id: SID, createdAt: T0, cwd: 'C:\\f1-lab', agentPreset: 'f1-lab' });
  const lines1 = [header];
  for (let n = 1; n <= CLOSED_TURNS; n++) {
    const ts = T0 + n * 1000;
    const base = (n - 1) * 4;
    lines1.push(
      JSON.stringify({ type: 'turn/start', seq: base + 1, time: ts, data: { turn: n } }),
      JSON.stringify({ type: 'user/message', seq: base + 2, time: ts + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第 ' + n + ' 轮提问' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: base + 3, time: ts + 200, data: { message: { role: 'assistant', content: [{ type: 'text', text: '第 ' + n + ' 轮回答' }] } } }),
      JSON.stringify({ type: 'turn/end', seq: base + 4, time: ts + 300, data: { turn: n, reason: { kind: 'completed' } } }),
    );
  }
  // 第 4 轮：只开不合（真实世界里 = 进程被杀 / 会话被弃）
  const tOpen = T0 + OPEN_TURN * 1000;
  const lines2 = [
    JSON.stringify({ type: 'turn/start', seq: CLOSED_TURNS * 4 + 1, time: tOpen, data: { turn: OPEN_TURN } }),
    JSON.stringify({ type: 'user/message', seq: CLOSED_TURNS * 4 + 2, time: tOpen + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这一轮永远不会结束' }] } }),
  ];
  return {
    fileBuffer: Buffer.concat([frame(lines1), frame(lines2)]),
    closedTurns: CLOSED_TURNS,
    openTurn: OPEN_TURN,
  };
}

function writeSession(dshHome, fx) {
  const dir = path.join(dshHome, 'sessions', '--f1-lab--', SID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  fs.writeFileSync(file, fx.fileBuffer);
  return file;
}

function fakeLogger() {
  const warnLines = [];
  return { warnLines, info: () => {}, warn: (...a) => warnLines.push(a.join(' ')) };
}

function makeCfg(root) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: OFFSET_MINUTES,
    hotWindowSeconds: 0,
    quietSeconds: 120,
    scanBudgetMs: 0,
    maxBytesPerSession: 0,
    checkupEnabled: false,
    weeklyEnabled: false,
    handoverEnabled: false,
  };
}

async function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-f1-'));
  assert.match(path.basename(base), /^dl-f1-/);
  const dshHome = path.join(base, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn({ base, dshHome, dataRoot });
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** 读最新一份运行报告（`<root>/ledger/.run-report-YYYYMMDD.json`）。 */
function latestRunReport(dataRoot) {
  const dir = path.join(dataRoot, 'ledger');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((n) => /^\.run-report-.*\.json$/.test(n));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  try { return { name: files[0], json: JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')) }; } catch { return null; }
}

function pendingRows(dataRoot) {
  const p = path.join(dataRoot, 'ledger', '.pending.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { _unparsed: l }; } });
}

// ============================================================================
// 一、源已静止 + 未闭合轮 → 必须喊（R1/R2）
// ============================================================================

test('F1/A（零静默）：源已静止 >2×interval 仍有未闭合轮 → gate 必须 degraded 且 knownGaps 点名"未闭合轮"，run-report 必须列 openTurns', async () => {
  const fx = buildFixture();
  await withLab(async ({ dshHome, dataRoot }) => {
    const file = writeSession(dshHome, fx);
    // 把源做旧：让"静止 >2×interval"成立
    const old = new Date(Date.now() - STATIC_AGE_MS);
    fs.utimesSync(file, old, old);

    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    // ── 基线①：pending 证据册有这一轮（这是既有行为，必须保持） ──
    const pend = pendingRows(dataRoot);
    const openRec = pend.filter((r) => r && r.turn === fx.openTurn);
    assert.equal(openRec.length, 1, '未闭合轮必须恰好一条 .pending.jsonl 记录（实际 ' + pend.length + ' 条）');

    // ── 基线②：台账语义不动：未闭合轮不进台账、不写 partial ──
    const read = readAll(dataRoot);
    assert.equal(read.ok, true, '台账必须可读：' + JSON.stringify(read.readErrors));
    const rows = read.records.filter((r) => r.sid === SID);
    assert.equal(rows.length, fx.closedTurns, '台账只该有 ' + fx.closedTurns + ' 条闭合轮（实际 ' + rows.length + '）');
    assert.equal(rows.filter((r) => r.turn === fx.openTurn).length, 0, '未闭合轮绝不许进台账');

    const diag = {
      openTurns: stat.openTurns,
      staleOpenTurns: stat.staleOpenTurns,
      gate: stat.reconcile && { conclusion: stat.reconcile.conclusion, knownGaps: stat.reconcile.knownGaps },
      report: (() => { const r = latestRunReport(dataRoot); return r ? { name: r.name, hasOpenTurns: Array.isArray(r.json.openTurns), openTurns: r.json.openTurns && r.json.openTurns.length } : null; })(),
      warnCount: log.warnLines.length,
    };
    console.log('[f1-台账/A] ' + JSON.stringify(diag));

    // ── ★ 断言③：gate 必须点名"未闭合轮"（不许只靠别的缺口凑 degraded） ──
    const gaps = (stat.reconcile && Array.isArray(stat.reconcile.knownGaps)) ? stat.reconcile.knownGaps : null;
    assert.ok(gaps, 'stat.reconcile.knownGaps 必须是数组（本轮没算对账？）');
    assert.ok(gaps.some((g) => /未闭合轮/.test(String(g))),
      '★ R1/R2 静默：gate.knownGaps 里没有一条点名"未闭合轮"（实际 ' + JSON.stringify(gaps) + '）—— 未闭合轮只写进了 .pending.jsonl，没人看得见');

    // ── ★ 断言④：gate 结论不得是 ok ──
    assert.notEqual(stat.reconcile.conclusion, 'ok', '★ 有已知未闭合缺口时 gate 不许说 ok');

    // ── ★ 断言⑤：run-report 必须列 openTurns 清单 ──
    const rep = latestRunReport(dataRoot);
    assert.ok(rep, '必须存在 run-report（.run-report-*.json）');
    assert.ok(Array.isArray(rep.json.openTurns),
      '★ run-report 没有 openTurns 清单（当前只有计数）—— 人无法逐项追查哪一轮没闭合');
    const hit = rep.json.openTurns.filter((o) => o && o.sid === SID && o.turn === fx.openTurn);
    assert.equal(hit.length, 1, 'openTurns 必须恰好列出本会话这一轮（实际 ' + JSON.stringify(rep.json.openTurns).slice(0, 300) + '）');
    assert.equal(hit[0].stale, true, 'openTurns 里该轮必须标 stale=true（源静止超过 2×interval）');
    assert.ok(Number.isInteger(hit[0].startByte), 'openTurns 必须带 startByte（可回溯到源文件哪一段）');
  });
});

// ============================================================================
// 二、源仍在活跃写 → 不许误报（否则面板每 tick 常红，失去证据价值）
// ============================================================================

test('F1/B（不许误报）：源 mtime 新鲜（进行中轮次）→ 不计 stale、不进 knownGaps', async () => {
  const fx = buildFixture();
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSession(dshHome, fx); // mtime = 刚写，属"活跃源"
    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, makeCfg(dataRoot));

    const gaps = (stat.reconcile && Array.isArray(stat.reconcile.knownGaps)) ? stat.reconcile.knownGaps : [];
    console.log('[f1-台账/B] ' + JSON.stringify({
      openTurns: stat.openTurns,
      staleOpenTurns: stat.staleOpenTurns,
      gate: { conclusion: stat.reconcile && stat.reconcile.conclusion, knownGaps: gaps },
    }));

    assert.equal(stat.openTurns, 1, '进行中轮次仍要计 openTurns（这是"看得见"，不是"报红"）');
    assert.equal(stat.staleOpenTurns, 0, '源新鲜时不许判 stale');
    assert.ok(!gaps.some((g) => /未闭合轮/.test(String(g))),
      '★ 进行中的轮次不许进 knownGaps（会制造每 tick 常红的假警报）：' + JSON.stringify(gaps));
  });
});

// ============================================================================
// 三、中间态不误判（P1-01a / P2-05，本机测试报告实测 turn 376 / 合成 375）
//   场景：真实会话里这一轮是**闭合**的，但 turn/end 在后面的帧里，本 tick 的读预算停在帧边界。
//   旧行为：只看源 mtime → 判 stale → gate degraded → 设备自检 run-report 红 → 三台准入必然"需返修"。
//   新行为：stale 必须同时满足「源已静止」+「本次扫描读到了源尾（没有被预算/坏帧截断）」。
// ============================================================================

test('F1/C（中间态不误判）：本 tick 读预算截断扫描 + 源 mtime 静止 → 不许判 stale、不许进 knownGaps', async () => {
  // 造一个 3 帧会话：turn1 的 turn/end 在第 3 帧；第 2 帧是 turn1 的大载荷。
  // 把 maxBytesPerSession 压到 64 KiB → 扫描停在帧 2 边界 → turn1 看起来"未闭合"（但实际是闭合的）。
  const header = JSON.stringify({ type: 'session', version: 3, id: SID, createdAt: T0, cwd: 'C:\\f1-lab', agentPreset: 'f1-lab' });
  const f1lines = [
    header,
    JSON.stringify({ type: 'turn/start', seq: 1, time: T0 + 1000, data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: 2, time: T0 + 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '大载荷' }] } }),
  ];
  const big = Buffer.alloc(120 * 1024);
  let x = 0x9e3779b9;
  for (let i = 0; i < big.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; big[i] = x & 0xff; }
  const f2lines = [JSON.stringify({ type: 'tool/result', seq: 3, time: T0 + 1200, sourceEventSeqs: [2], data: { callId: 'c1', message: { isError: false, content: [{ type: 'text', text: big.toString('base64') }] } } })];
  const f3lines = [
    JSON.stringify({ type: 'turn/end', seq: 4, time: T0 + 1300, data: { turn: 1, reason: { kind: 'completed' } } }),
    JSON.stringify({ type: 'turn/start', seq: 5, time: T0 + 2000, data: { turn: 2 } }),
    JSON.stringify({ type: 'turn/end', seq: 6, time: T0 + 2100, data: { turn: 2, reason: { kind: 'completed' } } }),
  ];
  const buf = Buffer.concat([frame(f1lines), frame(f2lines), frame(f3lines)]);
  await withLab(async ({ dshHome, dataRoot }) => {
    const dir = path.join(dshHome, 'sessions', '--f1-lab--', SID);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SESSION_FILE);
    fs.writeFileSync(file, buf);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(file, old, old); // 源"静止"（模拟灌库过程中的大文件）

    const cfg = makeCfg(dataRoot);
    cfg.maxBytesPerSession = 64 * 1024; // ★ 关键：扫描预算被截断
    const log = fakeLogger();
    const stat = await runOnce({ logger: log }, cfg);

    const gaps = (stat.reconcile && Array.isArray(stat.reconcile.knownGaps)) ? stat.reconcile.knownGaps : [];
    console.log('[f1-台账/C] ' + JSON.stringify({
      openTurns: stat.openTurns,
      staleOpenTurns: stat.staleOpenTurns,
      openTurnList: stat.openTurnList,
      knownGaps: gaps,
    }));

    assert.ok(stat.openTurns >= 1, '前置：预算截断时应看到"看起来未闭合"的轮（实际 ' + stat.openTurns + '）');
    const cut = (stat.openTurnList || []).find((o) => o && o.turn === 1);
    assert.ok(cut, '前置：openTurnList 里应有 turn 1');
    assert.equal(cut.scanStopped, true, '前置：本次扫描必须是被预算截断的（scanStopped=true），否则夹具没造对');
    assert.equal(cut.readToEnd, false, '扫描未读到源尾时 readToEnd 必须为 false');
    assert.equal(stat.staleOpenTurns, 0,
      '★ P1-01a：读预算截断的中间态**不许**判 stale（实际 ' + stat.staleOpenTurns + '）—— 否则首灌必红');
    assert.ok(!gaps.some((g) => /未闭合轮/.test(String(g))),
      '★ 中间态不许进 gate.knownGaps（实际 ' + JSON.stringify(gaps) + '）');
  });
});
