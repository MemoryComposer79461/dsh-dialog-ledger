/**
 * @file 自测-回归-v03.mjs
 * @role 按异地压测台账（13 条）写的回归：P1-1 / P1-2 / P1-3 / P3-1 / P3-2 / P3-4。
 * @why 这些缺陷的共同点是"账安静地出错"——必须在本地能复现、能防回归。
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
const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const { streamFrames } = await import(pathToFileURL(path.join(SRC, 'lib', 'frames.js')).href);
const { writeWeekly, groupRecords } = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);

const silent = { logger: { info() {}, warn() {} } };
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const S = (turn, ms) => JSON.stringify({ type: 'turn/start', time: ms, data: { turn } });
const E = (turn, ms) => JSON.stringify({ type: 'turn/end', time: ms, data: { turn, reason: { kind: 'completed' } } });
const H = (sid, createdAt) => JSON.stringify({ type: 'session', id: sid, createdAt, cwd: 'C:\\lab' });

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-v03-'));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'root');
  fs.mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  return { dir, home, root };
}
function sess(lab, sid, frames) {
  const d = path.join(lab.home, 'sessions', '--lab--', sid);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, Buffer.concat(frames.map((x) => frame(x))));
  return f;
}
const cfg = (root, extra = {}) => ({
  root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
  hotWindowSeconds: 0, quietSeconds: 120, scanBudgetMs: 5000,
  maxBytesPerSession: 64 * 1024 * 1024, weeklyEnabled: true, ...extra,
});
const recs = (root) => {
  const out = [];
  const dir = path.join(root, 'ledger');
  if (!fs.existsSync(dir)) return out;
  // ★ 必须排除隐藏文件：`ledger/.lost.jsonl` 是"缺口留痕"，不是账。
  //   readAll() 已按同口径只读非隐藏 .jsonl；测试若把它们当账读，
  //   坏帧用例会凭空多出几行（P1-2 曾因此误判"补回后 5 条 != 4 条"）。
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))) {
    out.push(...fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  }
  return out;
};

test('P1-1：孤儿轮次（只有 start、被下一轮 start 顶掉）→ 记 partial，不静默丢', async () => {
  const L = lab();
  const t0 = Date.parse('2026-11-08T10:00:00+08:00');
  const sid = 'session-p11-0000-0000-0000-000000000001';
  sess(L, sid, [
    [H(sid, t0)],
    [S(1, t0 + 1000), E(1, t0 + 2000)],
    [S(2, t0 + 3000), E(2, t0 + 4000)],
    [S(3, t0 + 5000)],                    // 孤儿
    [S(4, t0 + 6000), E(4, t0 + 7000)],
  ]);
  const st = await idx.runOnce(silent, cfg(L.root));
  const r = recs(L.root);
  assert.equal(r.length, 4, '4 轮都应入账（含孤儿）');
  const orphan = r.find((x) => x.turn === 3);
  assert.ok(orphan, '孤儿轮次不能消失');
  assert.equal(orphan.status, 'partial');
  assert.ok(st.abandoned >= 1, 'abandoned 计数应 >0');
});

test('P1-2：坏游标（落在帧中间）→ 自动归零并补回后续轮次', async () => {
  const L = lab();
  const t0 = Date.parse('2026-11-08T10:00:00+08:00');
  const sid = 'session-p12-0000-0000-0000-000000000002';
  const file = sess(L, sid, [
    [H(sid, t0)],
    [S(1, t0 + 1000), E(1, t0 + 2000)],
    [S(2, t0 + 3000), E(2, t0 + 4000)],
  ]);
  await idx.runOnce(silent, cfg(L.root));
  assert.equal(recs(L.root).length, 2);

  // 人为把游标推到帧中间
  const stPath = path.join(L.root, 'ledger', '.state.json');
  const s = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  const key = Object.keys(s.sourceCursors)[0];
  s.sourceCursors[key].offset = 5;
  fs.writeFileSync(stPath, JSON.stringify(s));

  // 追加两轮
  fs.appendFileSync(file, Buffer.concat([frame([S(3, t0 + 5000), E(3, t0 + 6000)]), frame([S(4, t0 + 7000), E(4, t0 + 8000)])]));

  const st1 = await idx.runOnce(silent, cfg(L.root));
  assert.ok(st1.rollbacks >= 1, '应发生一次坏游标回退');
  const afterBad = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  assert.equal(afterBad.sourceCursors[key].offset, 0, '坏游标必须归零落盘');

  await idx.runOnce(silent, cfg(L.root));
  const r = recs(L.root);
  assert.equal(r.length, 4, '补回 turn3/4');
  assert.equal(new Set(r.map((x) => x.code)).size, 4);
});

test('P1-3：超大单帧 → 跳过该帧，前后帧仍能解出（不再整份会话判死）', () => {
  const L = lab();
  const file = path.join(L.dir, 'big.zst');
  // 用不可压缩的随机数据，确保压缩后仍远大于 maxFrameBytes
  const big = zlib.zstdCompressSync(crypto.randomBytes(20000));
  fs.writeFileSync(file, Buffer.concat([
    frame([JSON.stringify({ type: 'a', n: 1 })]),
    big,
    frame([JSON.stringify({ type: 'a', n: 3 })]),
  ]));

  const got = [];
  const st = streamFrames(file, 0, (text) => got.push(text.trim()), { windowBytes: 512, maxFrameBytes: 2000 });
  assert.equal(st.badMagic, false, '不得把整份文件判为 bad magic');
  assert.ok(st.skipped >= 1, '应记录跳过的超大帧');
  assert.match(got.join('|'), /"n":1/);
  assert.match(got.join('|'), /"n":3/, '超大帧之后的帧仍要解出');
});

test('P3-4：未配置 checkupEnabled 时，体检不应意外开启', async () => {
  const L = lab();
  const t0 = Date.parse('2026-11-08T10:00:00+08:00');
  const sid = 'session-p34-0000-0000-0000-000000000004';
  sess(L, sid, [
    [H(sid, t0)],
    [S(1, t0 + 1000)],   // 未闭合 → 会产生 partial
  ]);
  // 先跑一轮让 partial 入账（quietSeconds=0，mtime 已过去）
  const c = cfg(L.root, { quietSeconds: 0 });
  await idx.runOnce(silent, c);
  // 配置里不写 checkupEnabled：默认必须是 false
  const st = await idx.runOnce(silent, c);
  assert.equal(st.checkup, '', '未配置时体检必须关闭（P3-4）');
  const chk = fs.readdirSync(L.root).filter((n) => n.startsWith('CHK-'));
  assert.equal(chk.length, 0, '不应在数据总库一级堆 CHK 文件');
});

test('P3-1 / P3-2：时区变更触发重写；生成时间是 +08:00', () => {
  const L = lab();
  const recs1 = [{
    v: 3, code: '20261108-cccccccccccc-A-00000001', ts: '2026-11-08T18:00:00+08:00',
    sid: 'session-cccccccc-cccc-cccc-cccc-cccccccccccc', turn: 1, seq: 1, status: 'ok',
  }];
  const g = [...groupRecords(recs1, 480).values()][0];
  const a = writeWeekly({ root: L.root, w: g.w, sessKey: g.sessKey, records: recs1, offsetMinutes: 480 });
  const textA = fs.readFileSync(a.path, 'utf8');   // 先读：后面 b 会重写同一路径
  const b = writeWeekly({ root: L.root, w: g.w, sessKey: g.sessKey, records: recs1, offsetMinutes: 0, prevHashes: { [a.groupId]: a.hash } });
  assert.equal(b.written, true, '改 offsetMinutes 必须重写（P3-1）');
  const text = textA;
  assert.match(text, /\+08:00/, '生成时间应带 +08:00（P3-2）');
  assert.equal(text.includes('Z<'), false);
});

test('F1：改 offsetMinutes 触发周记账全量重写（端到端）', async () => {
  const L = lab();
  const sid = 'session-f1f1f1f1-0000-0000-0000-000000000001';
  sess(L, sid, [
    [H(sid, Date.parse('2026-11-08T10:00:00+08:00'))],
    [S(1, Date.parse('2026-11-08T10:01:00+08:00')), E(1, Date.parse('2026-11-08T10:02:00+08:00'))],
    [S(2, Date.parse('2026-11-08T10:03:00+08:00')), E(2, Date.parse('2026-11-08T10:04:00+08:00'))],
  ]);
  const a = await idx.runOnce(silent, cfg(L.root, { offsetMinutes: 480 }));
  assert.match(String(a.weekly), /written=[1-9]/, '首次应写出周记账');
  const files = fs.readdirSync(path.join(L.root, '2026年11月')).filter((n) => n.endsWith('.xlsx'));
  assert.equal(files.length >= 1, true);
  const before = fs.readFileSync(path.join(L.root, '2026年11月', files[0]));

  const b = await idx.runOnce(silent, cfg(L.root, { offsetMinutes: 0 }));
  assert.match(String(b.weekly), /written=[1-9]/, '改偏移后必须重写（F1 端到端）');
  const after = fs.readFileSync(path.join(L.root, '2026年11月', files[0]));
  assert.equal(Buffer.compare(before, after) === 0, false, '产物内容应变化');
});

test('F2：非法/过短 Session ID → 报错，不静默跳过', async () => {
  const L = lab();
  sess(L, 'session-a1-0001', [
    [H('session-a1-0001', Date.parse('2026-11-08T10:00:00+08:00'))],
    [S(1, Date.parse('2026-11-08T10:01:00+08:00')), E(1, Date.parse('2026-11-08T10:02:00+08:00'))],
  ]);
  const st = await idx.runOnce(silent, cfg(L.root));
  assert.equal(st.written, 0);
  assert.equal(st.errors.some((e) => String(e).includes('bad session id')), true, '必须留下错误痕迹');
});