/**
 * @file 自测-v02.mjs
 * @role v0.2 新增能力的验收：格式守卫 / 增量续读 / 截断回退 / dateFrom。
 * @why v0.1 的 105 条守的是"记账正确"，这 5 组守的是"底层约束不破"：
 *      认不得的格式要拒绝、没新增字节不许重复读、文件变小要回退、记录要能自证日期来源。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 中文路径会被百分号编码，必须用 fileURLToPath，不能手撕 URL
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
const led = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);

const SID = 'session-abcd1234ef56-1111-2222-333344445555';
const CREATED_AT = Date.parse('2026-11-08T08:00:00+08:00');

const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const startLine = (turn, ms) => JSON.stringify({ type: 'turn/start', time: ms, data: { turn } });
const endLine = (turn, ms) => JSON.stringify({ type: 'turn/end', time: ms, data: { turn, reason: { kind: 'completed' } } });
const headLine = (over = {}) => JSON.stringify({ type: 'session', id: SID, createdAt: CREATED_AT, cwd: 'C:\\lab', ...over });

function makeCfg(root, over = {}) {
  return { root, intervalSeconds: 60, enabled: true, offsetMinutes: 480, hotWindowSeconds: 0, quietSeconds: 120, ...over };
}
const silent = { info() {}, warn() {} };

async function withLab(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-v02-'));
  const dshHome = path.join(dir, 'home');
  const dataRoot = path.join(dir, 'root');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    await fn({ dshHome, dataRoot });
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSession(dshHome, { frames, fileName = 'session.v4.jsonl.zstd', sid = SID }) {
  const dir = path.join(dshHome, 'sessions', '--lab--', sid);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, fileName);
  fs.writeFileSync(p, Buffer.concat(frames.map(frame)));
  return p;
}

// ---------------------------------------------------------------------------
// 一、格式守卫：非 v4 文件名 → 报错、零写入
// ---------------------------------------------------------------------------
test('v0.2 格式守卫：session.v5 文件名 → 零写入 + unsupported 报错', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSession(dshHome, {
      fileName: 'session.v5.jsonl.zstd',
      frames: [[headLine()], [startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
    });
    const st = await idx.runOnce({ logger: silent }, makeCfg(dataRoot));
    assert.equal(st.written, 0);
    assert.equal(st.errors.some((e) => e.includes('unsupported session format v5')), true, JSON.stringify(st.errors));
  });
});

// ---------------------------------------------------------------------------
// 二、格式守卫：坏会话头 → 拒绝入账
// ---------------------------------------------------------------------------
test('v0.2 格式守卫：会话头 type 不对 → format rejected，零写入', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSession(dshHome, {
      frames: [[JSON.stringify({ type: 'not-session', id: SID })], [startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
    });
    const st = await idx.runOnce({ logger: silent }, makeCfg(dataRoot));
    assert.equal(st.written, 0);
    assert.equal(st.errors.some((e) => e.includes('format rejected')), true, JSON.stringify(st.errors));
  });
});

// ---------------------------------------------------------------------------
// 三、增量续读：跑一次 → 追加一轮 → 只读新增；再跑 → 不读
// ---------------------------------------------------------------------------
test('v0.2 增量：首跑写 1；追加一轮后 inc=1/written=1；再跑 same=1/written=0', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const file = writeSession(dshHome, {
      frames: [[headLine()], [startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]],
    });
    const cfg = makeCfg(dataRoot);

    const a = await idx.runOnce({ logger: silent }, cfg);
    assert.equal(a.written, 1);

    // 追加一轮（模拟 DSH 又写了一批）
    fs.appendFileSync(file, Buffer.concat([
      frame([startLine(2, CREATED_AT + 3000)]),
      frame([endLine(2, CREATED_AT + 4000)]),
    ]));

    const b = await idx.runOnce({ logger: silent }, cfg);
    assert.equal(b.incremental, 1, '应从偏移续读');
    assert.equal(b.written, 1);
    assert.equal(b.skipped, 0);

    const c = await idx.runOnce({ logger: silent }, cfg);
    assert.equal(c.unchanged, 1, '文件没变 → 连读都省');
    assert.equal(c.written, 0);
    assert.equal(c.skipped, 2, '跳过数要按账上已有条数补齐');

    const recs = led.readAll(dataRoot).records;
    assert.equal(recs.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 四、截断回退：文件变小 → 回退全量，不崩、不重写
// ---------------------------------------------------------------------------
test('v0.2 截断：文件被截短 → 回退全量重读（不崩），已记轮次不重写', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    const file = writeSession(dshHome, {
      frames: [[headLine()], [startLine(1, CREATED_AT + 1000)], [endLine(1, CREATED_AT + 2000)]],
    });
    const cfg = makeCfg(dataRoot);
    assert.equal((await idx.runOnce({ logger: silent }, cfg)).written, 1);

    // 截短成"只有头 + 第 1 轮"（模拟文件被重写/回滚）
    fs.writeFileSync(file, Buffer.concat([
      frame([headLine()]),
      frame([startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]),
    ]));

    const b = await idx.runOnce({ logger: silent }, cfg);
    // 回退全量：不应因"偏移大于文件大小"而崩；这一轮已在账上 → 不重写
    assert.equal(b.written, 0);
    assert.equal(led.readAll(dataRoot).records.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 五、dateFrom：记录要能自证日期段来源
// ---------------------------------------------------------------------------
test('v0.3 记录形状：v=3，带 doc / docHash / docFrom，且原文文件真实存在', async () => {
  await withLab(async ({ dshHome, dataRoot }) => {
    writeSession(dshHome, { frames: [[headLine()], [startLine(1, CREATED_AT + 1000), endLine(1, CREATED_AT + 2000)]] });
    await idx.runOnce({ logger: silent }, makeCfg(dataRoot));
    const rec = led.readAll(dataRoot).records[0];
    assert.equal(rec.v, 3);
    assert.equal(rec.docFrom, CREATED_AT);
    assert.equal(rec.dateOffset, 480);
    assert.match(String(rec.doc), /完整原文\.md$/);
    assert.equal(String(rec.docHash).length, 64);
    // 强绑定：台账里写的路径，磁盘上必须真有这份凭证
    assert.equal(fs.existsSync(path.join(dataRoot, rec.doc)), true, '原文文件应存在: ' + rec.doc);
    assert.equal(rec.code, '20261108-abcd1234ef56-A-00000001');
  });
});
