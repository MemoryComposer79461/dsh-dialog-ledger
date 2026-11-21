/**
 * @file 自测-ledger.mjs
 * @role 单元自测：lib/ledger.js（zstd 多帧解压、会话事件解析、jsonl 台账读写、扫会话目录、切轮语义）。
 * @why 台账是"账"：只许追加、必须幂等、解压失败必须可计数、未闭合轮次不许提前入库。
 *      这些约束一旦破，错误会以**永久主键**的形式留在 jsonl 里，事后无法回改。
 *      所以本文件逐条钉住：帧计数、幂等闸门、按 ts 分文件、末尾换行、坏 ts 拒绝、
 *      跨日文件、collectTurns 只返回闭合轮次 + openTurn 暴露未闭合轮次、递归扫目录。
 *
 * 写盘纪律：所有临时文件都落在 `%TEMP%\dl-test-*`（os.tmpdir()+mkdtemp），
 *      每个用例在 finally 里整目录删除；不读真实 ~/.dsh，不改插件源码。
 *
 * 运行（在源码仓库根目录）：
 *   & '<test-dir>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test docs/自测-ledger.mjs
 *
 * 约定：
 *   · 期望值手写，不用被测函数反推（例如帧计数是 1/3/2 这种写死的数字）；
 *   · 每条 test 上方一行「守：」写明这条防的是哪种回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import {
  decompressMultiFrame,
  readSessionEvents,
  readTurnsFrom,
  readTurnEventsBatch,
  ledgerDir,
  ledgerPath,
  statePath,
  lostPath,
  readAll,
  readLost,
  hasCode,
  appendTurn,
  writeState,
  scanSessions,
  collectTurns,
  openTurn,
  readState,
  readStateEx,
  errorsPath,
  readErrors,
  appendErrorEvent,
  quarantinePath,
  readQuarantine,
  quarantineBadLines,
} from '../lib/ledger.js';
// ★ P1-9：封板证据的唯一模块是 Lead 持有的 lib/sealjournal.js（不在 ledger.js 里）。
import { appendSealEvent, isSealed, verifySealChain } from '../lib/sealjournal.js';

/** DSH 会话文件名（固定，测试里也用它铺目录）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd';
/** 标准会话 id（与自测-encoder.mjs 保持一致）。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** zstd 帧魔数：0x28 B5 2F FD。测试要手工拼"坏帧"时得自己写。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 同一会话的两条记录编码：日期段都是会话开始日，序号递增。 */
const CODE_A = '20261108-75238718e41a-A-00000001';
const CODE_B = '20261108-75238718e41a-A-00000002';
/** 两条记录的时间：一条 11-08 深夜、一条 11-09 凌晨（跨日但同会话）。 */
const TS_A = '2026-11-08T23:59:59+08:00';
const TS_B = '2026-11-09T00:00:01+08:00';

/**
 * 在 `%TEMP%\dl-test-*` 下建一个唯一临时根目录，跑完（无论通过失败）整棵删掉。
 * @param {(root: string) => any} fn
 */
function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  // 守：临时写盘必须落在 %TEMP%\dl-test-*，不能污染源码目录或用户 home。
  assert.match(path.basename(root), /^dl-test-/);
  assert.equal(path.dirname(root), os.tmpdir());
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 生成一条合法台账记录（字段顺序与 index.js 写的一致）。
 * @param {string} code
 * @param {string} ts
 * @param {object} [extra]
 */
function sampleRecord(code, ts, extra = {}) {
  return {
    v: 1,
    code,
    ts,
    sid: SID,
    turn: 1,
    seq: 1,
    status: 'ok',
    src: SESSION_FILE,
    ...extra,
  };
}

/** 把若干文本行拼成 jsonl 文本（每行以 \n 结尾，和真实落账格式一致）。 */
const lines = (...strs) => strs.join('\n') + '\n';

/** 把一段文本压成**一个** zstd 帧。 */
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));

// ============================================================================
// 一、decompressMultiFrame —— DSH 每追加一次写一帧，必须逐帧解
// ============================================================================

test('decompressMultiFrame：单帧 → frames=1/ok=1/failed=0，原文还原', () => {
  // 守：node 的 zstdDecompressSync 只解第一帧，所以本函数必须自己切帧；
  // 单帧是最小回归样本——连它都错，后面多帧无从谈起。
  const payload = lines('{"type":"turn/start","time":1}');
  const r = decompressMultiFrame(frame(payload));
  assert.equal(r.frames, 1);
  assert.equal(r.ok, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.text, payload);
  assert.equal(r.bytes, Buffer.byteLength(payload)); // bytes = 解压后总字节
});

test('decompressMultiFrame：3 帧拼接 → frames=3/ok=3/failed=0，顺序拼接', () => {
  // 守：真实会话文件是多帧的（每次追加一帧）；少解一帧就丢一段对话，
  // 少算 frames 会让"570 帧零失败"这种审计结论不可信。
  const a = lines('{"n":1}');
  const b = lines('{"n":2}');
  const c = lines('{"n":3}');
  const buf = Buffer.concat([frame(a), frame(b), frame(c)]);
  const r = decompressMultiFrame(buf);
  assert.equal(r.frames, 3);
  assert.equal(r.ok, 3);
  assert.equal(r.failed, 0);
  assert.equal(r.text, a + b + c);
  assert.equal(r.bytes, Buffer.byteLength(a + b + c));
});

test('decompressMultiFrame：空 Buffer → 全零、空文本', () => {
  // 守：空文件（会话刚创建）不该崩，也不该返回 undefined 让调用方解引用。
  assert.deepEqual(decompressMultiFrame(Buffer.alloc(0)), {
    text: '',
    frames: 0,
    ok: 0,
    failed: 0,
    bytes: 0,
  });
});

test('decompressMultiFrame：非 Buffer 入参 → 按空处理（不抛错）', () => {
  // 守：调用方传错类型时安静返回空结果；解压函数在每 60s 的定时器里，
  // 抛异常会整轮停摆。
  assert.deepEqual(decompressMultiFrame('not a buffer'), {
    text: '',
    frames: 0,
    ok: 0,
    failed: 0,
    bytes: 0,
  });
  assert.deepEqual(decompressMultiFrame(null), {
    text: '',
    frames: 0,
    ok: 0,
    failed: 0,
    bytes: 0,
  });
});

test('decompressMultiFrame：非 zstd 裸文本 → frames=0/ok=0/failed=0，原文返回', () => {
  // 守：容错分支：没魔数就按 UTF-8 裸文本处理（DSH 改格式时至少能读）。
  // 关键是 failed 不能误报成 1 —— 否则每次扫描都刷"解压失败"警告。
  const raw = Buffer.from('这不是 zstd，是一段裸文本\n第二行\n', 'utf8');
  const r = decompressMultiFrame(raw);
  assert.equal(r.frames, 0);
  assert.equal(r.ok, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.text, raw.toString('utf8'));
  assert.equal(r.bytes, raw.length);
});

test('decompressMultiFrame：好帧 + 坏帧 → frames=2/ok=1/failed=1，好帧内容还在', () => {
  // 守：解不开的帧必须【计数】而不是静默跳过（静默=账里丢一段没人知道）。
  // 坏帧用"魔数 + 垃圾字节"人为拼出来，保证 zstdDecompressSync 必抛。
  const good = frame(lines('{"ok":true}'));
  const bad = Buffer.concat([ZSTD_MAGIC, Buffer.from('this-is-not-a-zstd-frame')]);
  const r = decompressMultiFrame(Buffer.concat([good, bad]));
  assert.equal(r.frames, 2);
  assert.equal(r.ok, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.text, lines('{"ok":true}'));
  assert.equal(r.bytes, Buffer.byteLength(lines('{"ok":true}')));
});

test('decompressMultiFrame：好-坏-好 三帧 → 只丢坏帧，两侧内容都保留', () => {
  // 守：坏帧不能连带把后面的帧一起吞掉（切帧边界必须继续往前走）。
  const one = frame(lines('{"n":1}'));
  const bad = Buffer.concat([ZSTD_MAGIC, Buffer.from('corrupt')]);
  const two = frame(lines('{"n":2}'));
  const r = decompressMultiFrame(Buffer.concat([one, bad, two]));
  assert.equal(r.frames, 3);
  assert.equal(r.ok, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.text, lines('{"n":1}') + lines('{"n":2}'));
});

test('decompressMultiFrame：合法空载荷帧 → 算 1 帧、ok=1、文本为空', () => {
  // 守：空帧是"这次追加没写内容"，不是坏帧；若把空输出误判成失败，失败计数会虚高。
  const r = decompressMultiFrame(zlib.zstdCompressSync(Buffer.alloc(0)));
  assert.equal(r.frames, 1);
  assert.equal(r.ok, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.text, '');
  assert.equal(r.bytes, 0);
});

// ============================================================================
// 二、readSessionEvents —— 解压 + 按行 JSON.parse 的整合（decompress 的直接消费者）
// ============================================================================

test('readSessionEvents：多帧文件把会话头摘出来、坏行计数、事件顺序不变', () => {
  // 守：head 单独返回（调用方不必 i>0 过滤）；坏行只计入 badLines，不许让整轮扫描失败。
  withTemp((root) => {
    const dir = path.join(root, 'sessions', path.basename(SID));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, SESSION_FILE);
    const head = JSON.stringify({ type: 'session', id: SID, createdAt: 1794067200000 });
    const startEv = JSON.stringify({ type: 'turn/start', time: 1000, data: { turn: 1 } });
    const endEv = JSON.stringify({ type: 'turn/end', time: 2000, data: { turn: 1 } });
    // 第 2 帧里故意混一行非 JSON —— 模拟写了一半的坏行。
    const buf = Buffer.concat([
      frame(lines(head)),
      frame(lines(startEv, endEv, '这一行不是 JSON')),
    ]);
    fs.writeFileSync(p, buf);

    const r = readSessionEvents(p);
    assert.equal(r.head.type, 'session');
    assert.equal(r.head.id, SID);
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].type, 'turn/start');
    assert.equal(r.events[1].type, 'turn/end');
    assert.equal(r.meta.frames, 2);
    assert.equal(r.meta.ok, 2);
    assert.equal(r.meta.failed, 0);
    assert.equal(r.meta.lines, 4); // head + start + end + 坏行
    assert.equal(r.meta.badLines, 1);
  });
});

test('readSessionEvents：文件不存在 → head=null/events=[]/meta 全零（不抛错）', () => {
  // 守：扫描与读取之间文件可能被删除/移动；这里必须安静返回空壳。
  withTemp((root) => {
    const r = readSessionEvents(path.join(root, 'nope', 'session.v4.jsonl.zstd'));
    assert.deepEqual(r, {
      head: null,
      events: [],
      meta: { frames: 0, ok: 0, failed: 0, lines: 0, badLines: 0 },
    });
  });
});

// ============================================================================
// 三、appendTurn / hasCode / readAll —— 台账写入（只追加、幂等、按 ts 分文件）
// ============================================================================

test('appendTurn：首写落盘到 ledger/YYYY-MM-DD.jsonl，文件末尾必须有换行', () => {
  // 守：① 按 ts 日期分文件；② 末尾换行 —— 缺了它，下一次 append 会和上一行粘成
  // 一条坏 JSON，整本账从此读不全。
  withTemp((root) => {
    const rec = sampleRecord(CODE_A, TS_A);
    const r = appendTurn(root, rec);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, false);
    assert.equal(r.code, CODE_A);
    assert.equal(r.path, ledgerPath(root, '2026-11-08'));
    assert.equal(fs.existsSync(ledgerPath(root, '2026-11-08')), true);

    const text = fs.readFileSync(ledgerPath(root, '2026-11-08'), 'utf8');
    assert.ok(text.endsWith('\n'), '文件末尾缺换行');
    const rows = text.split('\n');
    assert.equal(rows.length, 2); // 1 行内容 + 末尾空串
    assert.deepEqual(JSON.parse(rows[0]), rec);
  });
});

test('appendTurn：同一 code 第二次 skipped=true，文件一字节都不长', () => {
  // 守：幂等是靠"先查再写"，不是靠文件系统报错 —— jsonl 重复行不会报错，
  // 只会悄悄多一行。这里用文件内容全等证明没有重复写。
  withTemp((root) => {
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A)).skipped, false);
    const before = fs.readFileSync(ledgerPath(root, '2026-11-08'), 'utf8');

    const r2 = appendTurn(root, sampleRecord(CODE_A, TS_A));
    assert.equal(r2.ok, true);
    assert.equal(r2.skipped, true);
    assert.equal(r2.path, '');
    assert.equal(r2.reason, 'already exists');

    const after = fs.readFileSync(ledgerPath(root, '2026-11-08'), 'utf8');
    assert.equal(after, before);
    assert.equal(readAll(root).records.length, 1);
  });
});

test('appendTurn：只追加不改写 —— 后一条写入后，前一条的原文前缀不变', () => {
  // 守：账的原则是 append-only。若实现改成"读全量再重写"，崩溃时会丢整本账，
  // 而且历史行的字节也可能被重新序列化（哈希漂移，审计对不上）。
  withTemp((root) => {
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A)).ok, true);
    const first = fs.readFileSync(ledgerPath(root, '2026-11-08'), 'utf8');

    assert.equal(appendTurn(root, sampleRecord(CODE_B, TS_A)).ok, true);
    const second = fs.readFileSync(ledgerPath(root, '2026-11-08'), 'utf8');

    assert.ok(second.startsWith(first), '旧内容被改写了，不是追加');
    const parsed = second.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((x) => x.code), [CODE_A, CODE_B]); // 顺序不变
  });
});

test('appendTurn：坏 ts 一律拒绝，且不创建 ledger 目录、不写盘', () => {
  // 守：ts 决定落哪个文件；ts 坏就不能"猜一个日期"写进去。
  // 尤其 "2026-11-8" 这种月/日不补零的写法必须拒绝，否则文件名不是 YYYY-MM-DD。
  withTemp((root) => {
    const cases = [
      { name: '缺 ts', rec: { v: 1, code: CODE_A } },
      { name: 'ts 非字符串', rec: { v: 1, code: CODE_A, ts: 1794153599999 } },
      { name: 'ts 是乱码', rec: { v: 1, code: CODE_A, ts: 'not-a-time' } },
      { name: 'ts 月日未补零', rec: { v: 1, code: CODE_A, ts: '2026-11-8T23:59:59+08:00' } },
      { name: 'ts 只有日期之外的前缀', rec: { v: 1, code: CODE_A, ts: '20261108T235959+0800' } },
    ];
    for (const c of cases) {
      const r = appendTurn(root, c.rec);
      assert.equal(r.ok, false, `${c.name} 应被拒绝`);
      assert.equal(r.skipped, false, `${c.name} 不应被当成重复`);
      assert.equal(r.reason, 'bad ts', `${c.name} 的 reason 应为 bad ts`);
      assert.equal(r.path, '');
    }
    assert.equal(fs.existsSync(ledgerDir(root)), false, '坏 ts 不该写盘');
    assert.equal(readAll(root).records.length, 0);
  });
});

test('appendTurn：缺 code / code 非字符串 / 空串 → missing code', () => {
  // 守：没有主键的记录不许入库 —— 否则台账里会出现一行永远无法查重的账。
  withTemp((root) => {
    const expected = {
      ok: false,
      skipped: false,
      code: '',
      path: '',
      reason: 'missing code',
    };
    assert.deepEqual(appendTurn(root, null), expected);
    assert.deepEqual(appendTurn(root, undefined), expected);
    assert.deepEqual(appendTurn(root, {}), expected);
    assert.deepEqual(appendTurn(root, { code: '' }), expected);
    assert.deepEqual(appendTurn(root, { code: 42, ts: TS_A }), expected);
    assert.equal(fs.existsSync(ledgerDir(root)), false);
  });
});

test('appendTurn：传 knownCodes 命中 → 直接 skipped，连盘都不读', () => {
  // 守：v0.1 每个 code 都 hasCode→readAll 造成 O(n²)；改成调用方传集合后，
  // 命中集合就必须跳过，且不能再读盘（否则优化白做）。
  withTemp((root) => {
    const known = new Set([CODE_A]);
    const r = appendTurn(root, sampleRecord(CODE_A, TS_A), known);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'already exists');
    // ledger 目录都不存在，证明确实没读盘也没写盘。
    assert.equal(fs.existsSync(ledgerDir(root)), false);
  });
});

test('appendTurn：传 knownCodes 未命中 → 正常写入；调用方补进集合后即幂等', () => {
  // 守：集合版的正确用法 —— 写完必须由调用方把 code 加进集合（index.js 的写法），
  // 否则同一进程内会重复写。
  withTemp((root) => {
    const known = new Set();
    const r1 = appendTurn(root, sampleRecord(CODE_A, TS_A), known);
    assert.equal(r1.ok, true);
    assert.equal(r1.skipped, false);
    assert.equal(fs.existsSync(ledgerPath(root, '2026-11-08')), true);

    known.add(CODE_A); // 调用方（index.js）在 written 后同步维护集合
    const r2 = appendTurn(root, sampleRecord(CODE_A, TS_A), known);
    assert.equal(r2.skipped, true);
    assert.equal(readAll(root).records.length, 1);
  });
});

test('appendTurn：第三参数不是 Set → 回退 hasCode 查盘（行为不变）', () => {
  // 守：兼容旧调用方式（2 参）与传错类型：回退到"读全量查重"，
  // 语义仍是幂等，只是慢。
  withTemp((root) => {
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A), []).skipped, false);
    const r2 = appendTurn(root, sampleRecord(CODE_A, TS_A), []);
    assert.equal(r2.skipped, true);
    assert.equal(readAll(root).records.length, 1);
  });
});

test('appendTurn + readAll：跨日按 ts 落到两个文件，逐个文件各一行', () => {
  // 守：一天一个账本文件（崩了只影响一天）。ts 跨日就必须落两个文件，
  // 编码的日期段仍是"会话开始日"，两者不许混为一谈。
  withTemp((root) => {
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A)).ok, true); // 11-08
    assert.equal(appendTurn(root, sampleRecord(CODE_B, TS_B)).ok, true); // 11-09

    const dayA = ledgerPath(root, '2026-11-08');
    const dayB = ledgerPath(root, '2026-11-09');
    assert.equal(fs.existsSync(dayA), true);
    assert.equal(fs.existsSync(dayB), true);
    assert.equal(fs.readFileSync(dayA, 'utf8').split('\n').filter(Boolean).length, 1);
    assert.equal(fs.readFileSync(dayB, 'utf8').split('\n').filter(Boolean).length, 1);

    const all = readAll(root);
    assert.equal(all.files, 2);
    assert.equal(all.badLines, 0);
    assert.deepEqual(all.records.map((r) => r.code), [CODE_A, CODE_B]); // 文件名排序后顺序
    assert.equal(all.dir, ledgerDir(root));
  });
});

test('readAll：没有 ledger 目录 → 空结果（不抛错）', () => {
  // 守：首装时账本目录还不存在，读取必须是"空"而不是异常。
  //     ★ P1-8：空数据只能由"成功读取"证明 —— 目录不存在（首次开账）ok=true；
  //       目录在但读不出/有坏行时 ok=false（见后面对应用例）。
  withTemp((root) => {
    const r = readAll(root);
    assert.deepEqual(r.records, []);
    assert.equal(r.files, 0);
    assert.equal(r.badLines, 0);
    assert.equal(r.dir, ledgerDir(root));
    assert.equal(r.dirExists, false);   // 目录不存在 = 首次开账，不是读取失败
    assert.equal(r.ok, true);
    assert.equal(r.emptyProven, true, 'P1-8：空数据只能由成功读取证明');
    assert.deepEqual(r.readErrors, []);
    assert.deepEqual(r.badLineDetails, []);
  });
});

test('readAll：坏行计数、空行忽略、非 .jsonl 文件（含 .state.json）不当账读', () => {
  // 守：① 坏行只计数不炸；② `.state.json` 是运行状态不是账 —— readAll 必须按
  // 后缀过滤掉它，否则每轮都会把它当"坏行"报警（甚至当成一条记录）。
  withTemp((root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(ledgerPath(root, '2026-11-10'), lines('{"code":"x"}', 'not-json', ''), 'utf8');
    fs.writeFileSync(path.join(ledgerDir(root), '.state.json'), '{"initialized":true}\n', 'utf8');
    fs.writeFileSync(path.join(ledgerDir(root), 'notes.txt'), 'ignore me\n', 'utf8');

    const all = readAll(root);
    assert.equal(all.files, 1); // 只有 2026-11-10.jsonl
    assert.equal(all.records.length, 1);
    assert.equal(all.records[0].code, 'x');
    assert.equal(all.badLines, 1);
  });
});

test('hasCode：账本不存在 → false；写入后 → true；其它 code 仍 false', () => {
  // 守：查重闸门的直接契约，也是幂等的第一道门。
  withTemp((root) => {
    assert.equal(hasCode(root, CODE_A), false);
    appendTurn(root, sampleRecord(CODE_A, TS_A));
    assert.equal(hasCode(root, CODE_A), true);
    assert.equal(hasCode(root, CODE_B), false);
  });
});

test('ledgerDir / ledgerPath：路径拼装契约', () => {
  // 守：分布路径是审计里可复现的一部分；路径拼错会写到别处（或别处读不到）。
  withTemp((root) => {
    assert.equal(ledgerDir(root), path.join(root, 'ledger'));
    assert.equal(ledgerPath(root, '2026-11-08'), path.join(root, 'ledger', '2026-11-08.jsonl'));
    assert.equal(ledgerPath(root, '2026-11-08').endsWith('.jsonl'), true);
  });
});

// ============================================================================
// 四、collectTurns / openTurn —— 切轮语义（v0.1.1：只把闭合的轮次交给落账）
// ============================================================================

/** 造一个 turn/start 事件。 */
const startEv = (turn, time) => ({ type: 'turn/start', time, data: { turn } });
/** 造一个 turn/end 事件。 */
const endEv = (turn, time, kind = 'stop') => ({
  type: 'turn/end',
  time,
  data: { turn, reason: { kind } },
});

test('collectTurns：正常 start/end 配对 → 恰好一轮，endMs/reason 正确', () => {
  // 守：闭合轮次全量交给调用方落账；endMs/reason 是账里唯一能说明"怎么结束的"字段。
  const events = [startEv(1, 1000), endEv(1, 2000, 'stop')];
  assert.deepEqual(collectTurns(events), [
    { turn: 1, startMs: 1000, endMs: 2000, reason: 'stop' },
  ]);
  assert.equal(openTurn(events), null);
});

test('collectTurns：多个已闭合轮次按发生顺序全部返回', () => {
  // 守：一轮不漏、顺序不乱；endMs 必须对上各自的 end。
  const events = [
    startEv(1, 100),
    endEv(1, 200, 'stop'),
    startEv(2, 300),
    endEv(2, 400, 'error'),
  ];
  assert.deepEqual(collectTurns(events), [
    { turn: 1, startMs: 100, endMs: 200, reason: 'stop' },
    { turn: 2, startMs: 300, endMs: 400, reason: 'error' },
  ]);
  assert.equal(openTurn(events), null);
});

test('collectTurns：有 start 无 end → 空数组（进行中的轮次不许入库）', () => {
  // 守：v0.1.1 的核心修正。编码是永久主键、账只追加：进行中的轮次一旦写成
  // partial，等它真结束时会因 (sid,turn) 闸门被永久跳过，账就永远停在 partial。
  // 所以这里必须"返回空"，未闭合信息只经 openTurn 暴露。
  const events = [startEv(5, 1000)];
  assert.deepEqual(collectTurns(events), []);

  const pending = openTurn(events);
  assert.ok(pending, 'openTurn 必须把未闭合轮次交出来');
  assert.equal(pending.turn, 5);
  assert.equal(pending.startMs, 1000);
});

test('collectTurns/openTurn：turn 号不匹配不算闭合，未闭合的是 start 那条', () => {
  // 守：不能"见到 turn/end 就闭合"—— 号不匹配说明 end 属于别的轮次，
  // 误配对会把 A 轮的结束时间记到 B 轮头上。
  const events = [startEv(1, 1000), endEv(2, 2000)];
  assert.deepEqual(collectTurns(events), []);

  const pending = openTurn(events);
  assert.ok(pending);
  assert.equal(pending.turn, 1);
  assert.equal(pending.startMs, 1000);
});

test('collectTurns/openTurn：前一轮已闭合、后一轮进行中 → 只交闭合的那轮', () => {
  // 守：同一会话里"上一轮已结束、当前轮还在跑"是线上最常见状态。
  // 闭合的照常入账，进行中的留给下一轮扫描（或安静兜底），两者不混淆。
  const events = [startEv(1, 100), endEv(1, 200), startEv(2, 300)];
  assert.deepEqual(collectTurns(events), [
    { turn: 1, startMs: 100, endMs: 200, reason: 'stop' },
  ]);
  const pending = openTurn(events);
  assert.ok(pending);
  assert.equal(pending.turn, 2);
  assert.equal(pending.startMs, 300);
});

test('collectTurns：turn/end 缺 reason.kind → reason 为空串', () => {
  // 守：index.js 用 reason==='partial' 判断状态；缺 kind 时不能渲染成 "undefined"。
  const events = [
    { type: 'turn/start', time: 10, data: { turn: 1 } },
    { type: 'turn/end', time: 20, data: { turn: 1 } }, // 没有 reason
  ];
  assert.deepEqual(collectTurns(events), [
    { turn: 1, startMs: 10, endMs: 20, reason: '' },
  ]);
});

test('collectTurns/openTurn：无 start 的 turn/end、脏事件都被忽略', () => {
  // 守：坏事件（null/字符串/无 type/end 在前）不许造出幽灵轮次，
  // 也不许让切轮抛异常（它在每 60s 的扫描里跑）。
  const events = [
    null,
    'not-an-event',
    { type: 123 },
    { time: 1, data: { turn: 1 } },
    endEv(1, 500), // 没有 start 的 end
  ];
  assert.deepEqual(collectTurns(events), []);
  assert.equal(openTurn(events), null);
});

test('collectTurns：重复的 turn/end 不会产生第二轮', () => {
  // 守：同一轮写两遍 end（异常退出/重放）只算闭合一次，不许重复入账。
  const events = [startEv(1, 100), endEv(1, 200), endEv(1, 300)];
  assert.deepEqual(collectTurns(events), [
    { turn: 1, startMs: 100, endMs: 200, reason: 'stop' },
  ]);
  assert.equal(openTurn(events), null);
});

// ============================================================================
// 五、scanSessions —— 递归扫会话目录
// ============================================================================

test('scanSessions：深一层目录里的 session.v4.jsonl.zstd 能扫到，sid/s12/size 正确', () => {
  // 守：会话文件通常嵌在 sessions/<会话id>/ 下（本用例再套一层 case 目录），
  // 递归深度/父目录取名任一错都会导致整批会话扫不到（首装漏历史）。
  withTemp((root) => {
    const base = path.join(root, 'sessions');
    const sidDir = path.join(base, 'caseA', path.basename(SID));
    fs.mkdirSync(sidDir, { recursive: true });
    const p = path.join(sidDir, SESSION_FILE);
    fs.writeFileSync(p, 'test-bytes'); // 7 字节占位

    const found = scanSessions(base);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, p);
    assert.equal(found[0].sid, path.basename(SID));
    assert.equal(found[0].s12, '75238718e41a');
    assert.equal(found[0].size, Buffer.byteLength('test-bytes'));
    assert.ok(found[0].mtimeMs > 0);
  });
});

test('scanSessions：多个会话目录（含更深嵌套）全部收集', () => {
  // 守：不能只扫第一层；多会话目录/多级嵌套都要覆盖。
  withTemp((root) => {
    const base = path.join(root, 'sessions');
    const sids = [
      'session-aaaaaaaaaaaa',
      'session-bbbbbbbbbbbb',
      'session-cccccccccccc',
    ];
    fs.mkdirSync(path.join(base, sids[0]), { recursive: true });
    fs.mkdirSync(path.join(base, sids[1]), { recursive: true });
    fs.mkdirSync(path.join(base, 'deep', 'nest', sids[2]), { recursive: true });
    for (const sid of sids) {
      const dir =
        sid === sids[2] ? path.join(base, 'deep', 'nest', sid) : path.join(base, sid);
      fs.writeFileSync(path.join(dir, SESSION_FILE), Buffer.from(sid));
    }

    const found = scanSessions(base);
    assert.equal(found.length, 3);
    assert.deepEqual(found.map((f) => f.sid).sort(), sids);
    assert.deepEqual(found.map((f) => f.s12).sort(), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
  });
});

test('scanSessions：非会话文件/非会话文件名不误收', () => {
  // 守：只认文件名恰好是 session.v4.jsonl.zstd 的文件；
  // 日志/缓存/备份文件（含 .bak、缺 .zstd）都不许被当成会话。
  withTemp((root) => {
    const base = path.join(root, 'sessions');
    const sid = 'session-aaaaaaaaaaaa';
    fs.mkdirSync(path.join(base, sid), { recursive: true });
    const real = path.join(base, sid, SESSION_FILE);
    fs.writeFileSync(real, Buffer.from('real'));

    // 非会话文件：扩展名/文件名都不对
    fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(base, 'logs', 'app.log'), 'log');
    fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(base, 'cache', 'x.json'), '{}');
    fs.writeFileSync(path.join(base, 'cache', 'session.v4.jsonl'), 'wrong-name'); // 缺 .zstd
    fs.writeFileSync(path.join(base, 'cache', 'session.v4.jsonl.zstd.bak'), 'backup');
    fs.writeFileSync(path.join(base, 'cache', 'readme.md'), '# hi');

    const found = scanSessions(base);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, real);
    assert.equal(found[0].sid, sid);
  });
});

test('scanSessions：根目录不存在 → 空数组（不抛错）', () => {
  // 守：DSH_HOME 未初始化 / 路径配错时，扫描必须安静返回空。
  withTemp((root) => {
    assert.deepEqual(scanSessions(path.join(root, 'no-such-dir')), []);
  });
});

// ============================================================================
// 六、全链路小样 —— 多帧文件 → 解压/解析 → 切轮语义一致
// ============================================================================

test('全链路：多帧会话文件 → readSessionEvents → collectTurns 只交闭合轮 + openTurn 交进行中轮', () => {
  // 守：各函数单测都过、串起来却"collectTurns 说闭合、openTurn 又说没闭合"的矛盾。
  // 同时验证坏帧计数为 0 时不会误判成 partial。
  withTemp((root) => {
    const dir = path.join(root, 'sessions', path.basename(SID));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, SESSION_FILE);
    const head = { type: 'session', id: SID, createdAt: 1794067200000 };
    const closedStart = startEv(1, 1000);
    const closedEnd = endEv(1, 2000, 'stop');
    const openStart = startEv(2, 3000);
    fs.writeFileSync(
      p,
      Buffer.concat([
        frame(lines(JSON.stringify(head))),
        frame(lines(JSON.stringify(closedStart), JSON.stringify(closedEnd))),
        frame(lines(JSON.stringify(openStart))),
      ])
    );

    const r = readSessionEvents(p);
    assert.equal(r.meta.failed, 0);
    assert.equal(r.meta.badLines, 0);

    const closed = collectTurns(r.events);
    assert.deepEqual(closed, [{ turn: 1, startMs: 1000, endMs: 2000, reason: 'stop' }]);

    const pending = openTurn(r.events);
    assert.ok(pending);
    assert.equal(pending.turn, 2);
    assert.equal(pending.startMs, 3000);

    // 闭合的能生成一条完整编码；进行中的这一轮本轮不该生成编码。
    assert.equal(closed.length + (pending ? 1 : 0), 2); // 文件里其实有 2 轮
    assert.equal(closed.length, 1); // 但只有 1 轮可以入账
  });
});

// ============================================================================
// 七、v0.5 存储层可信性（P1-2 / P1-5 / P1-8 / P1-9 + P0-3 字节偏移）
// ============================================================================

/** 造一个会话头事件。 */
const mkHeadEv = (sid = SID, createdAt = 1794067200000) => ({ type: 'session', id: sid, createdAt });
/** 造 turn/start。 */
const mkStart = (turn, time) => ({ type: 'turn/start', time, data: { turn } });
/** 造 turn/end。 */
const mkEnd = (turn, time, kind = 'stop') => ({ type: 'turn/end', time, data: { turn, reason: { kind } } });

/** 把一个事件数组压成一个 zstd 帧。 */
const evFrame = (evs) => zlib.zstdCompressSync(Buffer.from(evs.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'));

/** 把一个"坏帧"造成：魔数 + 垃圾字节（解压必然失败）。 */
const badFrame = () => Buffer.concat([ZSTD_MAGIC, Buffer.from('not-a-zstd-frame', 'utf8')]);

/**
 * 把若干帧写成一个会话文件，并返回每帧的绝对起点（手写期望值用）。
 * @param {string} dir
 * @param {Buffer[]} frames
 */
function writeSessionFrames(dir, frames) {
  const offsets = [];
  let total = 0;
  for (const b of frames) { offsets.push(total); total += b.length; }
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);
  fs.writeFileSync(p, Buffer.concat(frames));
  return { path: p, offsets, size: total };
}

/** 文件内容 sha256（只读性断言用）。 */
function fileSha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('P1-5：坏帧不推进游标 —— blocked/nextOffset=haltOffset（不推 EOF）/loss 结构化，已解出的轮仍返回', () => {
  // 守：审计判据 P1-5。坏帧只计数、游标照推 = 该帧里的轮次永久丢失且账面无声。
  //     这里三件事同时钉：① 游标不推进；② 缺口结构化（区间/起点可复算）；
  //     ③ 坏帧**前后**已解出的闭合轮照常返回（不因为一帧坏就丢真数据）。
  withTemp((root) => {
    const sessDir = path.join(root, 'sessions', path.basename(SID));
    const s = writeSessionFrames(sessDir, [
      evFrame([mkHeadEv(), mkStart(1, 1000)]),
      badFrame(),                                   // ← 中间一帧坏
      evFrame([mkEnd(1, 2000), mkStart(2, 3000), mkEnd(2, 4000)]),
    ]);

    const r = readTurnsFrom(s.path);
    assert.equal(r.meta.failed, 1);
    assert.equal(r.meta.blocked, true);
    assert.equal(r.meta.blockReason, 'failed-frames');
    // K-4：坏帧时 nextOffset 停在坏帧之前（绝不推到文件尾）。
    // ★ K-14（审计② A2）：再收窄到"跨 halt 边界轮"的 startByte ——
    //   本例 turn1 的 start 在第 0 帧（坏帧之前）、end 在坏帧之后，属跨边界轮 → nextOffset=0。
    assert.equal(r.meta.haltOffset, s.offsets[1]);         // 显式暴露停止位置（坏帧起点）
    assert.equal(r.meta.nextOffset, 0);                    // = min(haltOffset, turn1.startByte=0)
    assert.equal(r.meta.cursorClamped, true);              // K-14 结构化收窄证据
    assert.equal(r.meta.cursorClampByte, 0);
    assert.deepEqual(r.meta.haltBoundaryTurns, [{ turn: 1, startByte: 0, endByte: s.offsets[2] }]);
    assert.equal(r.meta.openTurnStartByte, null);          // 扫描结束时 turn1 已闭合（但跨坏帧）
    assert.equal(r.meta.plannedNextOffset, s.size);        // 证据：本来会推到文件尾
    assert.equal(r.loss.hasGap, true);
    assert.equal(r.loss.failedRanges.length, 1);
    assert.equal(r.loss.failedRanges[0].start, s.offsets[1]);
    assert.deepEqual(r.loss.failedOffsets, [s.offsets[1]]);
    // 坏帧前后解出的两轮都还在（写入侧靠 (sid,turn) 闸门去重，不丢真数据）
    assert.deepEqual(r.closed.map((t) => t.turn), [1, 2]);

    // 人工处置开关：显式允许推进时才推
    const forced = readTurnsFrom(s.path, { advanceOnFailed: true });
    assert.equal(forced.meta.blocked, false);
    assert.equal(forced.meta.nextOffset, s.size);
  });
});

test('P1-5：坏帧落永久错误清单（.lost.jsonl、只追加、同一现场不重复）', () => {
  // 守：「这一轮为什么没进账」必须有据可查；坏帧会一直坏，同一现场不能每轮追加一条。
  withTemp((root) => {
    const sessDir = path.join(root, 'sessions', path.basename(SID));
    const s = writeSessionFrames(sessDir, [
      evFrame([mkHeadEv(), mkStart(1, 1000), mkEnd(1, 2000)]),
      badFrame(),
    ]);
    const sid = SID;
    const first = readTurnsFrom(s.path, { root, sid, offsetMinutes: 480, now: 1794067200000 });
    assert.equal(first.meta.lostRecorded, true);
    const lost = readLost(root);
    assert.equal(lost.records.length, 1);
    assert.equal(lost.records[0].sid, sid);
    assert.equal(lost.records[0].failedFrames, 1);
    assert.ok(Array.isArray(lost.records[0].missing));

    const second = readTurnsFrom(s.path, { root, sid, offsetMinutes: 480, now: 1794067200000 });
    assert.equal(second.meta.blocked, true);
    // 同一现场第二次：.lost.jsonl 不重复追加（lostTurns 判 duplicate），但调用方仍能拿到 loss 结构
    assert.equal(second.meta.lostRecorded, undefined);
    assert.equal(second.lossRecord.recorded, false);
    assert.equal(second.lossRecord.reason, 'duplicate');
    assert.equal(readLost(root).records.length, 1, '同一现场只记一次（只追加，不重复）');
  });
});

test('P1-5：末帧半截（文件被截断）→ failed=1 且游标不推进', () => {
  // 守：半截帧是最常见的真实事故（断电/写一半）；不能当"读到文件尾=正常"。
  withTemp((root) => {
    const sessDir = path.join(root, 'sessions', path.basename(SID));
    const good = evFrame([mkHeadEv(), mkStart(1, 1000), mkEnd(1, 2000)]);
    const half = Buffer.concat([ZSTD_MAGIC, Buffer.from([0x00, 0x01, 0x02, 0x03])]); // 只有魔数+垃圾尾巴
    const dir = sessDir;
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, SESSION_FILE);
    fs.writeFileSync(p, Buffer.concat([good, half]));

    const r = readTurnsFrom(p);
    assert.equal(r.meta.frames, 2);
    assert.equal(r.meta.failed, 1);
    assert.equal(r.meta.blocked, true);
    // K-4：半尾帧同样停在坏帧起点（=好数据末尾），不推 EOF
    assert.equal(r.meta.nextOffset, good.length);
    assert.equal(r.meta.haltOffset, good.length);
    assert.equal(r.loss.failedRanges[0].start, good.length);
  });
});

test('P0-3：readTurnsFrom 每轮带 startByte/endByte；abandoned 的 endByte=下一轮 start 帧起点', () => {
  // 守：Lead 的 P0-3 要按批推进游标 —— 没有字节偏移就只能整会话重跑。
  withTemp((root) => {
    const sessDir = path.join(root, 'sessions', path.basename(SID));
    const s = writeSessionFrames(sessDir, [
      evFrame([mkHeadEv()]),                                     // 帧 0
      evFrame([mkStart(1, 1000), mkEnd(1, 2000)]),               // 帧 1：turn1 全在这一帧
      evFrame([mkStart(2, 3000)]),                               // 帧 2：turn2 未闭合
      evFrame([mkStart(3, 4000)]),                               // 帧 3：turn2 被顶掉（abandoned）
    ]);
    const r = readTurnsFrom(s.path);
    // turn1：start/end 同帧 → 两个偏移都等于帧 1 起点
    assert.equal(r.closed[0].turn, 1);
    assert.equal(r.closed[0].startByte, s.offsets[1]);
    assert.equal(r.closed[0].endByte, s.offsets[1]);
    // turn2 被帧 3 顶掉：endByte = 帧 3 起点
    assert.equal(r.closed[1].turn, 2);
    assert.equal(r.closed[1].reason, 'abandoned');
    assert.equal(r.closed[1].startByte, s.offsets[2]);
    assert.equal(r.closed[1].endByte, s.offsets[3]);
    // 未闭合轮带 startByte
    assert.equal(r.open.turn, 3);
    assert.equal(r.open.startByte, s.offsets[3]);
    assert.equal(r.meta.blocked, false);
  });
});

test('P0-3：readTurnEventsBatch 流式过滤 + offsets 出参 + fromByte 续扫（内存与文件大小无关）', () => {
  // 守：① 只保留 turnSet 里的轮（不是先把全部事件收下来再过滤）；
  //     ② 每轮给帧区间；③ 第二批从第一批的 endByte 续扫，能拿到第二轮事件。
  withTemp((root) => {
    const sessDir = path.join(root, 'sessions', path.basename(SID));
    const s = writeSessionFrames(sessDir, [
      evFrame([mkHeadEv()]),
      evFrame([mkStart(1, 1000), mkEnd(1, 2000)]),
      evFrame([mkStart(2, 3000), mkEnd(2, 4000)]),
    ]);

    const off1 = new Map();
    const batch1 = readTurnEventsBatch(s.path, new Set([1]), { offsets: off1 });
    assert.deepEqual([...batch1.keys()], [1]);
    assert.equal(batch1.get(1).length, 2);
    assert.deepEqual(off1.get(1), { startByte: s.offsets[1], endByte: s.offsets[1] });

    // 第二批从第一批末尾续扫：不传 fromByte 也能拿到，但传了才不重扫全文件
    const off2 = new Map();
    const batch2 = readTurnEventsBatch(s.path, new Set([2]), { fromByte: off1.get(1).endByte, offsets: off2 });
    assert.deepEqual([...batch2.keys()], [2]);
    assert.equal(batch2.get(2).length, 2);
    assert.equal(off2.get(2).startByte, s.offsets[2]);
  });
});

test('P1-8：readAll 读取失败结构化（ok=false/readErrors）；坏行有行号+sha256+原文', () => {
  // 守：审计判据 P1-8 —— 读不出来 ≠ 没有。空数据只能由成功读取证明。
  withTemp((root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(
      ledgerPath(root, '2026-11-08'),
      '{"code":"A"}\nnot-json-line\n',
      'utf8'
    );
    const all = readAll(root);
    assert.equal(all.dirExists, true);
    assert.equal(all.ok, false, '有坏行 → 不能声称"读全了"');
    assert.equal(all.emptyProven, false, '有坏行时"空"不可被证明');
    assert.equal(all.records.length, 1);
    assert.equal(all.badLines, 1);
    assert.equal(all.files, 1);
    // ★ CH-04（契约）：坏行必须同时进 readErrors[]，字段名 {file,line,rawSha256,offset,error}
    assert.equal(all.readErrors.length, 1, '坏行必须进 readErrors（CH-04）');
    const rErr = all.readErrors[0];
    assert.equal(rErr.code, 'E_BAD_LINE');
    assert.equal(rErr.file, '2026-11-08.jsonl');
    assert.equal(rErr.line, 2);
    assert.match(rErr.rawSha256, /^[0-9a-f]{64}$/);
    assert.equal(rErr.offset, 13);
    assert.equal(typeof rErr.error, 'string');
    assert.notEqual(rErr.error, '');
    const d = all.badLineDetails[0];
    assert.equal(d.file, '2026-11-08.jsonl');
    assert.equal(d.lineNo, 2);
    assert.equal(d.offset, 13); // 第 1 行 12 字节 + '\n'
    assert.equal(d.raw, 'not-json-line');
    assert.equal(d.bytes, 13);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);

    // 目录位置是个文件（不是目录）→ E_NOT_DIR，ok=false（不是"空账"）
    const root2 = path.join(root, 'bad-root');
    fs.mkdirSync(root2, { recursive: true });
    fs.writeFileSync(ledgerDir(root2), 'i am a file');
    const all2 = readAll(root2);
    assert.equal(all2.ok, false);
    assert.equal(all2.dirExists, true);
    assert.equal(all2.readErrors[0].code, 'E_NOT_DIR');
  });
});

test('P1-2：坏行取证 quarantine（目录/排他创建/幂等/台账字节一个不改）', () => {
  // 守（契约 D9/P1-2 定稿口径）：坏行 = 复制到 `<root>/ledger/.quarantine/<账文件>.L<行号>.json`，
  //     记录原始行文本 + sha256 + 字节偏移；原账文件一个字节都不动（append-only 底线）。
  withTemp((root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const day = ledgerPath(root, '2026-11-08');
    fs.writeFileSync(day, '{"code":"A"}\nbroken-line\n', 'utf8');
    const before = fileSha(day);

    const all = readAll(root, { quarantine: true, nowMs: 1794067200000 });
    assert.equal(all.quarantined.ok, true);
    assert.equal(all.quarantined.appended, 1);
    assert.equal(fs.statSync(quarantinePath(root)).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(quarantinePath(root), '2026-11-08.jsonl.L2.json')), true);
    const q = readQuarantine(root);
    assert.equal(q.records.length, 1);
    assert.equal(q.records[0].lineNo, 2);
    assert.equal(q.records[0].offset, 13); // 第 1 行 12 字节 + '\n'
    assert.equal(q.records[0].raw, 'broken-line');
    assert.equal(q.records[0].sha256.length, 64);
    assert.equal(q.records[0].at, '2026-11-08 00:00:00'); // 契约文本时间，不带 T/Z

    // 同一坏行再取一次 → 不重复追加（幂等；排他创建 + sha 相同 = 跳过）
    const again = readAll(root, { quarantine: true, nowMs: 1794067200000 });
    assert.equal(again.quarantined.appended, 0);
    assert.equal(again.quarantined.skipped, 1);
    assert.equal(readQuarantine(root).records.length, 1);
    // 台账字节完全未变
    assert.equal(fileSha(day), before);

    // .quarantine/ 与 .lost.jsonl 都不能被当账读
    assert.deepEqual(readAll(root).fileNames, ['2026-11-08.jsonl']);
  });
});

test('P1-8：账读不全时 appendTurn 拒绝写（无法证明 code 不存在 → 不许重复入账）', () => {
  // 守："空/缺"不能被当成"不存在"——否则坏行期间重跑会给同一轮再发一个编码。
  withTemp((root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const day = ledgerPath(root, '2026-11-08');
    fs.writeFileSync(day, '{"code":"A"}\nbroken\n', 'utf8');
    const before = fileSha(day);
    const r = appendTurn(root, sampleRecord(CODE_A, TS_A)); // 不传 knownCodes → 必须读盘
    assert.equal(r.ok, false);
    assert.equal(r.skipped, false);
    assert.equal(r.reason, 'ledger-unreadable');
    assert.equal(fileSha(day), before, '拒绝写时不得产生任何字节变化');

    // 传 knownCodes（调用方已成功读全）时行为不变，正常写
    const ok = appendTurn(root, sampleRecord(CODE_B, TS_B), new Set());
    assert.equal(ok.ok, true);
    assert.equal(ok.skipped, false);
  });
});

test('P1-2：尾行缺换行时追加不粘结（先补 \\n 再写）', () => {
  // 守：一次崩溃留下无换行的半行，后续 append 若直接写会与它粘成一条坏 JSON，
  //     并且**连累下一条**（一次坏变两条坏）。appendLineSync 必须先补尾换行。
  withTemp((root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const day = ledgerPath(root, '2026-11-08');
    fs.writeFileSync(day, '{"code":"existing","ts":"2026-11-08T10:00:00+08:00"}', 'utf8'); // 无结尾换行
    const r = appendTurn(root, sampleRecord(CODE_A, TS_A), new Set());
    assert.equal(r.ok, true);
    const all = readAll(root);
    assert.equal(all.ok, true);
    assert.equal(all.badLines, 0);
    assert.equal(all.records.length, 2);
    assert.deepEqual(all.records.map((x) => x.code), ['existing', CODE_A]);
  });
});


test('P1-8：readStateEx 区分"没有 state"与"state 读坏"', () => {
  // 守：state 丢失=重建+告警；state 坏=证据在但读不出，必须停机排查，不能当"首次开账"。
  withTemp((root) => {
    const noState = readStateEx(root);
    assert.equal(noState.ok, true);
    assert.equal(noState.exists, false);
    assert.equal(noState.error, null);

    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(statePath(root), '{ this is not json', 'utf8');
    const corrupt = readStateEx(root);
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.exists, true);
    assert.equal(corrupt.error.code, 'E_STATE_CORRUPT');
    assert.deepEqual(readState(root), {}, '旧 API 语义保持：损坏时返回 {} 不抛错');

    fs.writeFileSync(statePath(root), '{"initialized":true}\n', 'utf8');
    const good = readStateEx(root);
    assert.equal(good.ok, true);
    assert.equal(good.exists, true);
    assert.equal(good.state.initialized, true);
  });
});


test('P1-5/D9：坏帧同时进 .errors.jsonl（FRAME_FAILED，fingerprint 去重）', () => {
  // 守（契约 D9）：失败必须被看见。`.lost.jsonl` 记"缺口证据"（字节区间可复算），
  //     `.errors.jsonl` 记"错误台账"（谁/何时/可否重试），两者职责不同，都要写。
  withTemp((root) => {
    const sessDir = path.join(root, 'sessions', path.basename(SID));
    const s = writeSessionFrames(sessDir, [
      evFrame([mkHeadEv(), mkStart(1, 1000), mkEnd(1, 2000)]),
      badFrame(),
    ]);
    const r = readTurnsFrom(s.path, { root, sid: SID, offsetMinutes: 480, now: 1794067200000 });
    assert.equal(r.meta.blocked, true);
    assert.equal(r.meta.errorRecorded, true);
    assert.match(r.meta.errorFingerprint, /^[0-9a-f]{64}$/);

    const errs = readErrors(root);
    assert.equal(errs.readError, '');
    assert.equal(errs.records.length, 1);
    const e = errs.records[0];
    // 契约 D9：`.errors.jsonl` 行**恰好 10 个固定字段**（含 v；无 count —— 次数在 run-report）
    assert.deepEqual(Object.keys(e).sort(), [
      'at', 'detail', 'fingerprint', 'kind', 'offset', 'retryable',
      'source', 'sourceBytes', 'sourceMtimeMs', 'v',
    ]);
    assert.equal(e.kind, 'FRAME_FAILED');
    assert.equal(e.at, '2026-11-08 00:00:00');
    // ★ CH-10：offset 记的是**坏帧起点**（不是本次读的起点 0）——
    //   否则第一轮从 0 读、第二轮从坏帧起点读，同一次故障会落成两条不同指纹的记录。
    assert.equal(e.offset, 149);
    assert.equal(e.offset, r.meta.failedOffsets[0]);
    assert.equal(e.retryable, true);
    assert.match(e.source, /session\.v4\.jsonl\.zstd$/);
    assert.equal(e.sourceBytes, s.size);
    assert.equal(errs.byFingerprint[e.fingerprint].kind, 'FRAME_FAILED');

    // 同一现场再读：不重复刷错误清单（D9.2：只累加运行报告里的 attempts）
    const r2 = readTurnsFrom(s.path, { root, sid: SID, offsetMinutes: 480, now: 1794067200000 });
    assert.equal(r2.meta.blocked, true);
    assert.equal(r2.meta.errorRecorded, false);
    assert.equal(readErrors(root).records.length, 1);

    // 另一种错误（不同 fingerprint）→ 新的一行
    const er = appendErrorEvent(root, {
      kind: 'SID_UNENCODABLE', source: 'sessions/x/session.v4.jsonl.zstd',
      sourceBytes: 10, sourceMtimeMs: 5, offset: 0, detail: 'bad sid',
    }, { nowMs: 1794067200000 });
    assert.equal(er.recorded, true);
    assert.equal(readErrors(root).records.length, 2);
    // 契约外 kind 一律拒收（错误清单是契约字段）
    assert.equal(appendErrorEvent(root, { kind: 'WHATEVER', source: 'x' }).ok, false);
    // .errors.jsonl 不能被当账读
    assert.deepEqual(readAll(root).fileNames, []);
  });
});

test('P1-9：state 丢失只影响性能，不影响封板证据语义（journal 权威、state 是缓存）', () => {
  // 守（审计 M-02 / P1-9）：封板证据在 .seal-journal.jsonl（Lead 的 lib/sealjournal.js 唯一写者），
  //     删掉 .state.json 后"已封板"必须仍然成立，且 journal 字节不变；
  //     ledger.js 只保留可重建缓存（游标/哈希），丢了最多重扫，不改变证据结论。
  withTemp((root) => {
    const GID = '2026-11-2|75238718e41aA';
    const SESSKEY = '75238718e41aA';
    // ① state 里放"缓存 + 旧封板提示"（降级前语义）
    writeState(root, {
      initialized: true,
      sourceCursors: { 'C:/x/session.v4.jsonl.zstd': { size: 10, offset: 10 } },
      weeklySealed: { [GID]: { sealedAt: '2026-11-08 10:00:00', sealHash: 'a'.repeat(64), file: 'w.xlsx', layout: 6, rows: 2 } },
    });
    assert.equal(readStateEx(root).ok, true);
    assert.equal(readStateEx(root).state.initialized, true);

    // ② 封板证据进 journal（唯一写者 = sealjournal.js）
    const seal = appendSealEvent(root, {
      kind: 'weekly-seal', key: GID, gid: GID, file: '2026年11月/11月第2周-75238718e41aA的周记账.xlsx',
      sealedAt: '2026-11-08 10:00:00', layoutVersion: 6, sessKey: SESSKEY,
      year: 2026, month: 11, weekNo: 2, offsetMinutes: 480,
      sourceRowCount: 2, overflow: 0,
      rows: [['20261108-75238718e41a-A-00000001', '绑定', '10:00', '已完成']],
      supplementCodes: [],
    });
    assert.equal(seal.ok, true);
    assert.equal(seal.written, true);
    assert.equal(isSealed(root, 'weekly-seal', GID), true);
    assert.equal(verifySealChain(root).ok, true);
    const journalSha = fileSha(path.join(root, 'ledger', '.seal-journal.jsonl'));

    // ③ 删掉 state（模拟 state 丢失）
    fs.rmSync(statePath(root));
    assert.equal(readStateEx(root).exists, false);
    assert.deepEqual(readState(root), {});

    // ④ 证据语义不变：仍然"已封板"，链仍 OK，journal 字节未被重写
    assert.equal(isSealed(root, 'weekly-seal', GID), true);
    const chain = verifySealChain(root);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 1);
    assert.equal(fileSha(path.join(root, 'ledger', '.seal-journal.jsonl')), journalSha);

    // ⑤ 缓存可重建，且再封一次是幂等（already-sealed，不写第二行）
    writeState(root, { initialized: true });
    assert.equal(readStateEx(root).state.initialized, true);
    const again = appendSealEvent(root, { kind: 'weekly-seal', key: GID, sealedAt: '2026-11-08 10:00:00', sealHash: 'b'.repeat(64) });
    assert.equal(again.ok, true);
    assert.equal(again.written, false);
    assert.equal(again.reason, 'already-sealed');
    assert.equal(fileSha(path.join(root, 'ledger', '.seal-journal.jsonl')), journalSha);
    // 运行区文件（.seal-journal.jsonl / .state.json / .lost.jsonl / .errors.jsonl）都不被当账读
    assert.deepEqual(readAll(root).fileNames, []);
  });
});
test('R-02：.errors.jsonl 契约级节流 —— 同一 (kind,source,offset) 每窗口最多 1 行，次数不丢', () => {
  // 守（契约 R-02）：坏源 24h 模拟行数 ≤ ceil(24h/throttle)+1；窗口内重复必须返回 throttled
  //   （供调用方在 run-report errors[].count / blockedSources[].attempts 累加，不得静默丢次数）。
  withTemp((root) => {
    const src = 'sessions/x/session.v4.jsonl.zstd';
    const base = 1794067200000; // 2026-11-08 00:00:00 +08
    const THROTTLE = 3600000;
    let calls = 0; let recorded = 0;
    for (let i = 0; i < 144; i++) { // 24h，每 10 分钟扫一次
      const now = base + i * 10 * 60 * 1000;
      const r = appendErrorEvent(root, {
        kind: 'FRAME_FAILED', source: src, sourceBytes: 100 + i, sourceMtimeMs: 1000 + i, offset: 0,
      }, { nowMs: now, offsetMinutes: 480, errorLogThrottleMs: THROTTLE });
      assert.equal(r.ok, true);
      calls++;
      if (r.recorded) recorded++;
    }
    assert.equal(calls, 144, '真实次数由调用方累加（run-report count）');
    const errs = readErrors(root);
    const cap = Math.ceil((24 * 3600000) / THROTTLE) + 1;
    assert.ok(errs.records.length <= cap, `行数 ${errs.records.length} 超过契约上限 ${cap}`);
    assert.equal(errs.records.length, recorded);
    assert.ok(recorded >= 24, `至少每窗口 1 行，实际 ${recorded}`);

    // 同一窗口内再报 → throttled（不写），并给出原记录供 count 累加
    const last = errs.records[errs.records.length - 1];
    const lastMs = Date.parse(`${last.at.replace(' ', 'T')}+08:00`);
    const within = appendErrorEvent(root, {
      kind: 'FRAME_FAILED', source: src, sourceBytes: 999, sourceMtimeMs: 999, offset: 0,
    }, { nowMs: lastMs + 60 * 1000, offsetMinutes: 480, errorLogThrottleMs: THROTTLE });
    assert.equal(within.ok, true);
    assert.equal(within.recorded, false);
    assert.equal(within.throttled, true);
    assert.ok(within.record && within.record.fingerprint, 'throttled 时必须返回原记录（供 count/attempts）');
    assert.equal(readErrors(root).records.length, errs.records.length);

    // 窗口过去后 → 允许新行
    const after = appendErrorEvent(root, {
      kind: 'FRAME_FAILED', source: src, sourceBytes: 1000, sourceMtimeMs: 1000, offset: 0,
    }, { nowMs: lastMs + THROTTLE + 1000, offsetMinutes: 480, errorLogThrottleMs: THROTTLE });
    assert.equal(after.recorded, true);
    assert.equal(readErrors(root).records.length, errs.records.length + 1);
  });
});

// ============================================================================
// 九、崩溃撕裂尾巴（torn tail）的**严格限定**自愈（2026-11-09 夜 / P0-3-resume 真因）
//
// 背景：kill -9 落在 appendLineSync 的 write 中途 → 台账末行半行、文件无结尾换行。
//      若 readAll 一律 ok=false，index.js 按 P1-8 "读不全就别写" 早退 → **重启后续跑永久失效**。
//      修复只允许一种现场：末行坏 + 无结尾换行 + 该文件只有这一处坏行。
//      ★ 其它任何坏行仍然是"读不全"，一个字节都不许动 —— 这是账本不可篡改的红线。
// ============================================================================

test('P0-3-resume：撕裂尾巴（末行半行 + 无结尾换行 + 唯一坏行）→ 取证 + 截断 + 可读全', () => {
  // 守：修必须"先取证、再截断、留痕可查"；只截这一行，前面字节一个都不能动。
  withTemp((root) => {
    const day = '2026-11-08';
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A), new Set()).ok, true);
    // 注意：TS_B 是 11-09 → 会落到另一个日文件；本用例要"同一文件三行"，两条都写 11-08。
    assert.equal(appendTurn(root, sampleRecord(CODE_B, TS_A, { turn: 2, seq: 2 }), new Set()).ok, true);
    const p = ledgerPath(root, day);
    const cleanText = fs.readFileSync(p, 'utf8');
    assert.equal(cleanText.endsWith('\n'), true);

    // 造"半行"：把第 3 条记录的前 40% 追加进去（无结尾换行）——等价于 kill 在 write 中途
    const fake = JSON.stringify(sampleRecord('20261108-75238718e41a-A-00000003', TS_B));
    const torn = fake.slice(0, Math.floor(fake.length * 0.4));
    fs.appendFileSync(p, torn);
    const before = fs.readFileSync(p);
    assert.equal(before[before.length - 1] === 0x0a, false, '前置：末行必须没有结尾换行');
    assert.equal(before.length, Buffer.byteLength(cleanText, 'utf8') + Buffer.byteLength(torn, 'utf8'));

    const r = readAll(root, { nowMs: Date.parse('2026-11-09T09:00:00+08:00'), offsetMinutes: 480 });
    assert.equal(r.ok, true, '撕裂尾巴必须被修成"可读全"：' + JSON.stringify(r.readErrors).slice(0, 400));
    assert.equal(r.badLines, 0, '撕裂行不该再算坏行');
    assert.equal(r.records.length, 2, '只保留两条完整记录');
    assert.equal(r.tornTailRepaired.length, 1, '必须返回自愈留痕');

    const t = r.tornTailRepaired[0];
    assert.equal(t.file, `${day}.jsonl`);
    assert.equal(t.line, 3, '行号 = 末行（1 起）');
    assert.equal(t.bytes, Buffer.byteLength(torn, 'utf8'));
    assert.equal(t.sha256, crypto.createHash('sha256').update(Buffer.from(torn, 'utf8')).digest('hex'));
    assert.equal(t.offset, Buffer.byteLength(cleanText, 'utf8'), 'offset = 该行首字节偏移');
    assert.match(t.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '留痕时间必须是 +08:00 文本、无 Z');

    // 取证：台账之外的独立文件（不可覆盖），含 raw / sha256 / 截断长度
    const evPath = path.join(quarantinePath(root), `${day}.jsonl.L3.torn.json`);
    assert.equal(fs.existsSync(evPath), true, '必须先取证再修：' + evPath);
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    assert.equal(ev.kind, 'torn-tail');
    assert.equal(ev.ledgerFile, `${day}.jsonl`);
    assert.equal(ev.lineNo, 3);
    assert.equal(ev.bytes, t.bytes);
    assert.equal(ev.sha256, t.sha256);
    assert.equal(ev.raw, torn);
    assert.equal(t.evidence, path.join('.quarantine', `${day}.jsonl.L3.torn.json`));

    // 截断精确性：文件变短 = 半行长度；结尾恢复 '\n'；前面字节逐字未变
    const after = fs.readFileSync(p);
    assert.equal(after.length, before.length - Buffer.byteLength(torn, 'utf8'));
    assert.equal(after[after.length - 1] === 0x0a, true, '截断后必须以换行结尾');
    assert.equal(after.equals(before.subarray(0, after.length)), true, '只允许截尾，前面字节一个都不能动');

    // 再读一次：稳定、不重复修复、不留痕
    const again = readAll(root);
    assert.equal(again.ok, true);
    assert.equal(again.records.length, 2);
    assert.equal(again.tornTailRepaired.length, 0, '同一现场不得重复"修"');
  });
});

test('P0-3-resume/红线：中间行坏 → 不修、ok=false、文件字节一个不变', () => {
  // 守：范围一旦放宽就是篡改账本。中间行坏可能是磁盘故障/人为改动，必须交人裁决。
  withTemp((root) => {
    const day = '2026-11-08';
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const p = ledgerPath(root, day);
    const good1 = JSON.stringify(sampleRecord(CODE_A, TS_A));
    const bad = '{"中间行坏":"没写完';
    const good2 = JSON.stringify(sampleRecord(CODE_B, TS_B, { turn: 2, seq: 2 }));
    fs.writeFileSync(p, `${good1}\n${bad}\n${good2}\n`, 'utf8');
    const before = fs.readFileSync(p);

    const r = readAll(root);
    assert.equal(r.ok, false, '中间行坏必须仍是"读不全"');
    assert.equal(r.badLines, 1);
    assert.equal(r.records.length, 2, '好行仍要返回（只报不修）');
    assert.equal(r.tornTailRepaired.length, 0, '不是撕裂尾巴：不许修');
    assert.equal(fs.readFileSync(p).equals(before), true, '红线：非撕裂尾巴一个字节都不许动');
    assert.equal(
      fs.existsSync(quarantinePath(root)) && fs.readdirSync(quarantinePath(root)).some((n) => n.endsWith('.torn.json')),
      false, '不满足三条件时不得写 torn 取证',
    );
  });
});

test('P0-3-resume/红线：末行有结尾换行但 JSON 坏 → 不修、ok=false、文件字节一个不变', () => {
  // 守：「文件不以 \\n 结尾」是撕裂尾巴的构造特征；有结尾换行的末行坏 = 完整行坏，属坏行。
  withTemp((root) => {
    const day = '2026-11-08';
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const p = ledgerPath(root, day);
    const good = JSON.stringify(sampleRecord(CODE_A, TS_A));
    fs.writeFileSync(p, `${good}\n{"末行坏但已换行":\n`, 'utf8');
    const before = fs.readFileSync(p);

    const r = readAll(root);
    assert.equal(r.ok, false);
    assert.equal(r.badLines, 1);
    assert.equal(r.tornTailRepaired.length, 0);
    assert.equal(fs.readFileSync(p).equals(before), true, '红线：末行有换行的坏行不许修');
  });
});

test('P0-3-resume/红线：末行撕裂 + 文件里还有别处坏行 → 不修（"只有这一处坏行"）', () => {
  // 守：文件里同时有其他坏行时，"末行半行"也可能只是更大损坏的一部分 —— 只许报，不许截。
  withTemp((root) => {
    const day = '2026-11-08';
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const p = ledgerPath(root, day);
    const good1 = JSON.stringify(sampleRecord(CODE_A, TS_A));
    const badMid = '{"中间坏":';
    const good2 = JSON.stringify(sampleRecord(CODE_B, TS_B, { turn: 2, seq: 2 }));
    const fake = JSON.stringify(sampleRecord('20261108-75238718e41a-A-00000003', TS_B));
    fs.writeFileSync(p, `${good1}\n${badMid}\n${good2}\n${fake.slice(0, 20)}`, 'utf8'); // 末行无 \n
    const before = fs.readFileSync(p);

    const r = readAll(root);
    assert.equal(r.ok, false);
    assert.equal(r.badLines, 2, '中间坏行 + 末行半行 = 2 处');
    assert.equal(r.tornTailRepaired.length, 0, '不满足"只有这一处坏行" → 不许修');
    assert.equal(fs.readFileSync(p).equals(before), true);
  });
});

test('P0-3-resume：repairTornTail=false 可关闭（只读取证工具零副作用）', () => {
  // 守：交付物里有只读工具（收据核验/对账）必须能要"绝对只读"语义；关闭时连取证都不写。
  withTemp((root) => {
    const day = '2026-11-08';
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A), new Set()).ok, true);
    const p = ledgerPath(root, day);
    fs.appendFileSync(p, '{"半行":');
    const before = fs.readFileSync(p);

    const r = readAll(root, { repairTornTail: false });
    assert.equal(r.ok, false);
    assert.equal(r.badLines, 1);
    assert.equal(r.tornTailRepaired.length, 0);
    assert.equal(fs.readFileSync(p).equals(before), true, '关闭时不得截断');
    assert.equal(fs.existsSync(quarantinePath(root)), false, '关闭时连取证文件都不该写');
  });
});

// ============================================================================
// 十、2026-11-13 机主签字的两处内核修复（A-07 / A-10）—— C17 变异反证要求"删掉修复必有用例变红"，
//     本节就是那两条例外的对应用例（此前全库自测 0 覆盖）。
// ============================================================================

test('A-07（已签）：撕裂尾修复 fsync 失败 → durability=unknown + fsyncError，绝不静默吞', () => {
  // 守：fsync 证明的是"落得盘"，不是"读得到"。失败必须出声 —— 否则断电/满盘会静默丢账，
  //     而且不会变红（正是本项目最贵的"假绿"）。
  withTemp((root) => {
    const day = '2026-11-08';
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A), new Set()).ok, true);
    assert.equal(appendTurn(root, sampleRecord(CODE_B, TS_A, { turn: 2, seq: 2 }), new Set()).ok, true);
    const p = ledgerPath(root, day);
    const fake = JSON.stringify(sampleRecord('20261108-75238718e41a-A-00000003', TS_B));
    const torn = fake.slice(0, Math.floor(fake.length * 0.4));
    fs.appendFileSync(p, torn);

    const origFsync = fs.fsyncSync;
    let calls = 0;
    // 修复路径里有两处 fsync：①取证文件写完后 ②截断账尾后。A-07 说的是**截断账尾**那一处。
    // 所以只让第 2 次及以后的 fsync 失败（第 1 次（取证）照常成功，否则会先因"取证失败"提前返回）。
    fs.fsyncSync = (...args) => {
      calls++;
      if (calls >= 2) {
        const e = new Error('simulated ENOSPC');
        e.code = 'ENOSPC';
        throw e;
      }
      return origFsync.apply(fs, args);
    };
    let r;
    try {
      r = readAll(root, { nowMs: Date.parse('2026-11-09T09:00:00+08:00'), offsetMinutes: 480 });
    } finally {
      fs.fsyncSync = origFsync;
    }

    assert.equal(r.tornTailRepaired.length, 1, '撕裂尾仍必须被修（截断已在页缓存生效）');
    const t = r.tornTailRepaired[0];
    assert.equal(t.durability, 'unknown', 'A-07：fsync 失败必须标 durability=unknown');
    assert.match(String(t.fsyncError || ''), /ENOSPC/, 'A-07：必须带 fsyncError（含错误码）');
  });
});

test('A-10（已签）：严格读只认真账行 —— 合法 JSON 非账行按坏行计，不许静默少算', () => {
  // 守：一条"合法 JSON 但不是账行"的行，若被当成功读，对账/报告会静默少算（假绿）。
  //     默认读保持宽容（老语义兼容）；验账路径（requireLedgerRows）必须计坏行并置 ok=false。
  withTemp((root) => {
    const day = '2026-11-08';
    assert.equal(appendTurn(root, sampleRecord(CODE_A, TS_A), new Set()).ok, true);
    const p = ledgerPath(root, day);
    fs.appendFileSync(p, JSON.stringify({ hello: 'not-a-ledger-row' }) + '\n');

    const loose = readAll(root);
    assert.equal(loose.records.length, 2, '默认宽容：非账行仍按老语义进 records');
    assert.equal(loose.badLines, 0, '默认宽容：不计坏行（向后兼容）');

    const strict = readAll(root, { requireLedgerRows: true, repairTornTail: false });
    assert.equal(strict.records.length, 1, 'A-10：严格读只保留真账行');
    assert.equal(strict.badLines, 1, 'A-10：非账行必须计入坏行');
    assert.equal(strict.ok, false, 'A-10：读不全必须 ok=false（不许假绿）');
    assert.equal(strict.readErrors.some((e) => e && e.code === 'E_BAD_LINE'), true, '必须进 readErrors');
    assert.equal(fs.existsSync(quarantinePath(root)), false, '读函数默认零副作用');
  });
});