/**
 * @file 自测-checkup.mjs
 * @role v0.2 体检模块的验收：对账判定、报告编号、只读性。
 * @why 体检的价值在于"敢不敢信"：报告必须能区分"账实不符"和"确实没闭合"，
 *      而且跑完台账一个字节都不能变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runCheckup } = await import(pathToFileURL(path.join(SRC, 'lib', 'checkup.js')).href);

const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const startLine = (turn, ms) => JSON.stringify({ type: 'turn/start', time: ms, data: { turn } });
const endLine = (turn, ms) => JSON.stringify({ type: 'turn/end', time: ms, data: { turn, reason: { kind: 'completed' } } });
const head = (sid, createdAt) => JSON.stringify({ type: 'session', id: sid, createdAt, cwd: 'C:\\lab' });

function makeLab(sid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
  const sessions = path.join(dir, 'sessions', '--lab--', sid);
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'session.v4.jsonl.zstd');
  const root = path.join(dir, 'root');
  fs.mkdirSync(root, { recursive: true });
  return { dir, sessions: path.join(dir, 'sessions'), file, root, sid };
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

test('checkup：源会话已闭合、账上仍 partial → 判「应闭合而未更新」并出报告', () => {
  const lab = makeLab('session-chk-a');
  const createdAt = Date.now() - 600000;
  fs.writeFileSync(lab.file, Buffer.concat([
    frame([head(lab.sid, createdAt)]),
    frame([startLine(1, createdAt + 1000)]),
    frame([endLine(1, createdAt + 2000)]),   // 源会话已闭合
  ]));

  const ledger = path.join(lab.root, 'ledger');
  fs.mkdirSync(ledger, { recursive: true });
  const ledgerFile = path.join(ledger, '2026-11-08.jsonl');
  fs.writeFileSync(ledgerFile, JSON.stringify({
    v: 2, code: '20261108-aaaaaaaaaaaa-A-00000001', ts: '2026-11-08T10:00:01+08:00',
    sid: lab.sid, turn: 1, seq: 1, status: 'partial', src: 'x', dateFrom: createdAt, dateOffset: 480,
  }) + '\n');
  const before = sha(ledgerFile);

  const r = runCheckup({
    root: lab.root, sessionsBase: lab.sessions,
    partials: [{ code: '20261108-aaaaaaaaaaaa-A-00000001', sid: lab.sid, turn: 1, ts: '2026-11-08T10:00:01+08:00' }],
    seqState: null,
  });

  assert.equal(r.mismatched, 1);
  assert.equal(r.ok, 0);
  assert.match(r.reportId, /^CHK-\d{8}-01$/);
  assert.equal(fs.existsSync(r.path), true);
  const text = fs.readFileSync(r.path, 'utf8');
  assert.match(text, /应闭合而未更新/);
  assert.equal(sha(ledgerFile), before, '体检不得改动台账');
});

test('checkup：源会话确实未闭合 → 判「确实未闭合」，不算账实不符', () => {
  const lab = makeLab('session-chk-b');
  const createdAt = Date.now() - 600000;
  fs.writeFileSync(lab.file, Buffer.concat([
    frame([head(lab.sid, createdAt)]),
    frame([startLine(1, createdAt + 1000)]),  // 只有 start
  ]));

  const r = runCheckup({
    root: lab.root, sessionsBase: lab.sessions,
    partials: [{ code: 'x', sid: lab.sid, turn: 1, ts: 't' }],
    seqState: null,
  });
  assert.equal(r.mismatched, 0);
  assert.equal(r.ok, 1);
});

test('checkup：编号按日递增（同一天第二次 → -02）', () => {
  const lab = makeLab('session-chk-c');
  const createdAt = Date.now() - 600000;
  fs.writeFileSync(lab.file, Buffer.concat([frame([head(lab.sid, createdAt)]), frame([startLine(1, createdAt + 1000)])]));
  const partials = [{ code: 'x', sid: lab.sid, turn: 1, ts: 't' }];

  const r1 = runCheckup({ root: lab.root, sessionsBase: lab.sessions, partials, seqState: null });
  const r2 = runCheckup({ root: lab.root, sessionsBase: lab.sessions, partials, seqState: r1.seqState });
  assert.match(r1.reportId, /-01$/);
  assert.match(r2.reportId, /-02$/);
  assert.deepEqual(r2.seqState, { day: r1.seqState.day, n: 2 });
});

test('checkup：源会话缺失 → 单独归类，不算账实不符', () => {
  const lab = makeLab('session-chk-d');
  fs.rmSync(path.join(lab.dir, 'sessions'), { recursive: true, force: true });
  const r = runCheckup({
    root: lab.root, sessionsBase: lab.sessions,
    partials: [{ code: 'x', sid: 'session-gone', turn: 1, ts: 't' }],
    seqState: null,
  });
  assert.equal(r.mismatched, 0);
  assert.equal(r.missing, 1);
});

// ---------------------------------------------------------------------------
// 集成：runOnce 真的会触发体检（不是只有模块能单独跑）
// ---------------------------------------------------------------------------
test('checkup 集成：账上有 partial 且源已闭合 → runOnce 出 CHK 报告并记进 state', async () => {
  const lab = makeLab('session-chk-e');
  const createdAt = Date.now() - 600000;
  fs.writeFileSync(lab.file, Buffer.concat([
    frame([head(lab.sid, createdAt)]),
    frame([startLine(1, createdAt + 1000)]),
    frame([endLine(1, createdAt + 2000)]), // 源已闭合，账上却是 partial → 账实不符
  ]));

  const ledger = path.join(lab.root, 'ledger');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(ledger, '2026-11-08.jsonl'), JSON.stringify({
    v: 2, code: '20261108-bbbbbbbbbbbb-A-00000001', ts: '2026-11-08T10:00:01+08:00',
    sid: lab.sid, turn: 1, seq: 1, status: 'partial', src: 'x', dateFrom: createdAt, dateOffset: 480,
  }) + '\n');

  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = lab.dir;
  try {
    const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
    const st = await idx.runOnce({ logger: { info() {}, warn() {} } }, {
      root: lab.root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
      hotWindowSeconds: 0, quietSeconds: 120, scanBudgetMs: 3000,
      maxBytesPerSession: 16 * 1024 * 1024, checkupEnabled: true, checkupIntervalMs: 0,
    });
    assert.match(String(st.checkup), /^CHK-\d{8}-\d{2}$/, 'runOnce 应触发体检并回报编号');
    // V0.6.2：体检报告只写 `<root>/体检/`（不再散在一级）。
    assert.equal(fs.existsSync(path.join(lab.root, '体检', st.checkup + '.md')), true);
    assert.equal(fs.existsSync(path.join(lab.root, st.checkup + '.md')), false, '一级不得再写 CHK 报告');

    const state = JSON.parse(fs.readFileSync(path.join(ledger, '.state.json'), 'utf8'));
    assert.equal(state.checkup.lastReport, st.checkup);
    assert.equal(state.checkup.seq.n >= 1, true);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
});

// ---------------------------------------------------------------------------
// V0.6.2 布局（机主已签《v0.6.2-迁移规格-v1》§2.2）：写端只写 体检/，重名检测双路径
// ---------------------------------------------------------------------------
test('V0.6.2 布局：CHK 写 体检/；重名检测同时看 体检/ 与一级（老库不覆盖）', () => {
  const lab = makeLab('session-chk-layout');
  const shifted = new Date(Date.now() + 480 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const day = `${shifted.getUTCFullYear()}${p2(shifted.getUTCMonth() + 1)}${p2(shifted.getUTCDate())}`;
  try {
    // 老库：一级已有当天 01 号；新目录已有 02 号 → 必须跳过两者，写 03。
    fs.writeFileSync(path.join(lab.root, `CHK-${day}-01.md`), '# 一级老报告\n', 'utf8');
    fs.mkdirSync(path.join(lab.root, '体检'), { recursive: true });
    fs.writeFileSync(path.join(lab.root, '体检', `CHK-${day}-02.md`), '# 新目录报告\n', 'utf8');
    const r = runCheckup({
      root: lab.root, sessionsBase: lab.sessions,
      partials: [{ code: 'x', sid: 'session-gone', turn: 1, ts: 't' }],
      seqState: null,
    });
    assert.equal(r.reportId, `CHK-${day}-03`, '重名检测必须同时看 体检/ 与一级');
    assert.equal(r.path, path.join(lab.root, '体检', `CHK-${day}-03.md`), '写端只写 体检/');
    assert.equal(fs.readFileSync(r.path, 'utf8').includes(`# ${r.reportId} · partial 对账报告`), true);
    // 既有文件一个字节都不动；一级不得出现新报告。
    assert.equal(fs.readFileSync(path.join(lab.root, `CHK-${day}-01.md`), 'utf8'), '# 一级老报告\n');
    assert.equal(fs.readFileSync(path.join(lab.root, '体检', `CHK-${day}-02.md`), 'utf8'), '# 新目录报告\n');
    assert.equal(fs.existsSync(path.join(lab.root, `CHK-${day}-03.md`)), false);
  } finally {
    fs.rmSync(lab.dir, { recursive: true, force: true });
  }
});
