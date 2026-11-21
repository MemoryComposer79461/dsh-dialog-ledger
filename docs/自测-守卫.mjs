/**
 * @file 自测-守卫.mjs
 * @role 写路径守卫的验收：凭证不可变（wx + 正文 hash 裁决）、单实例锁（心跳/僵死夺取/留证）、
 *       台账追加加固（尾行补换行 + fsync）、坏帧缺口留痕（.lost.jsonl）。
 * @called-by 人工/审计：`node --test docs/自测-守卫.mjs`（Node 24，自带 zstd）；
 *            也会被 package.json 的 `node --test docs/自测-*.mjs` 通配纳入。
 * @depends ../lib/original.js（renderOriginal / writeOriginal / originalBodyHash / originalRelPath）、
 *          ../lib/ledger.js（appendTurn / readAll / readTurnsFrom / lostTurns / readLost / ledgerDir / ledgerPath / lostPath）、
 *          ../lib/lock.js（acquire / release / lockPath / staleLockPrefix / listStaleLocks / inspectLock）、
 *          ../index.js（仅 ③ 日志用例：runOnce + __test__.readConfig —— 动态 import，不写盘）、
 *          node:zlib（造 zstd 帧）、node:child_process（模拟第二个实例）
 * @why 三条"永久"必须被代码焊死，而它们坏掉的方式全都是"跑得通但悄悄错"：
 *        ① 凭证被同名覆盖 → 原件换了，账还指着它，永远查不出来；
 *        ② 双实例同时写 → 两条账交错/编号撞车/游标互踩，写脏一次不可逆；
 *        ③ 坏帧/半截帧静默跳过 → 少了一轮却没有记录，账看上去是完整的。
 *      所以这里每条都从**磁盘事实**反证，而不是只看函数返回值：
 *      文件字节有没有变、锁文件留证在不在、.lost.jsonl 的区间/hash 能不能复算。
 *
 * 隔离纪律（沿用 自测-边界.mjs 的写法）：
 *   · 不读真实 `~/.dsh`、不碰真实会话文件：root 全在 `%TEMP%\dl-guard-*`；
 *   · 会话文件全合成：`zlib.zstdCompressSync` 逐帧压、`Buffer.concat` 拼多帧；
 *   · 每个用例 finally 删整棵临时目录；跨进程用例额外确保子进程已被回收；
 *   · 不启动 DSH、不装依赖、不改被测源码。
 *
 * 失败纪律：断言失败就记失败，不删用例凑绿。
 *
 * 运行（在源码仓库根目录 `<test-dir>\work\v0.5-工作副本`）：
 *   & '<build-host>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test docs/自测-守卫.mjs
 *
 * 约定：每条 test 上方一行「守：」写明这条防的是哪种回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  renderOriginal,
  writeOriginal,
  originalBodyHash,
  originalRelPath,
} from '../lib/original.js';
import {
  appendTurn,
  readAll,
  readTurnsFrom,
  lostTurns,
  readLost,
  ledgerDir,
  ledgerPath,
  lostPath,
} from '../lib/ledger.js';
import {
  acquire,
  release,
  lockPath,
  staleLockPrefix,
  listStaleLocks,
  inspectLock,
  HEARTBEAT_INTERVAL_MS,
  STALE_MULTIPLIER,
} from '../lib/lock.js';

// ============================================================================
// 一、测试基础设施
// ============================================================================

/** 本仓库根目录（docs 的上一级）。 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 当前 Node 可执行文件（跨进程用例要用同一个）。 */
const NODE = process.execPath;

/** 标准会话 id（与其它自测一致）。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';

/** 测试用编码（合法 32 位形状；写原文只需要它当文件名）。 */
const CODE = '20261108-75238718e41a-A-00000001';

/** 时区偏移：480 = UTC+08:00。测试一律显式传，不依赖本机时区。 */
const OFFSET_MINUTES = 480;

/** zstd 帧魔数（造坏帧用）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH 会话文件名（固定）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd';

/**
 * 在 `%TEMP%\dl-guard-*` 下建一个唯一临时根目录，跑完（无论通过/失败）整棵删掉。
 *
 * @param {(root: string) => any} fn
 */
async function withLab(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-guard-'));
  // 守：临时写盘只许落在 os.tmpdir() 下的 dl-guard-*，绝不污染真实用户目录/仓库。
  assert.match(path.basename(root), /^dl-guard-/);
  assert.equal(path.dirname(root), os.tmpdir());
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 把若干行文本压成一个 zstd 帧（DSH 每追加写一次就多一帧）。 */
const frame = (lineArr) => zlib.zstdCompressSync(Buffer.from(lineArr.join('\n') + '\n', 'utf8'));

/** sha256（hex），测试独立复算用，不借被测代码。 */
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 用真实渲染器造一份完整原文。
 *
 * @param {string} code
 * @param {string} text 正文内容（不同 text → 不同正文 hash）
 * @returns {{markdown:string, bodyHash:string}}
 *
 * @why 不手搓 markdown：真实渲染器的产出才是 writeOriginal 真正要面对的输入，
 *      顺带验证 renderOriginal 的 bodyHash 与「从 '## 1.' 到末尾」口径一致。
 */
function renderDoc(code, text) {
  const T0 = Date.parse('2026-11-08T10:00:00+08:00');
  return renderOriginal({
    events: [
      { seq: 1, type: 'user/message', time: T0, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    ],
    turn: { turn: 1, startMs: T0, endMs: T0 + 1000, reason: 'stop' },
    code,
    sid: SID,
    sessKey: '75238718e41aA',
    seq: 1,
    offsetMinutes: OFFSET_MINUTES,
  });
}

/** 造一条台账记录（字段形状与 index.js 一致）。 */
function sampleRecord(code, ts, extra = {}) {
  return { v: 3, code, ts, sid: SID, turn: 1, seq: 1, status: 'ok', ...extra };
}

/**
 * 造一个合成的 DSH 会话文件：`<root>/sessions/<sid>/session.v4.jsonl.zstd`。
 *
 * @param {string} root
 * @param {Buffer[]} frames 每个元素是一整帧字节（调用方用 frame() 压）
 * @returns {string} 会话文件绝对路径
 */
function writeSessionFile(root, frames) {
  const dir = path.join(root, 'sessions', SID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SESSION_FILE);
  fs.writeFileSync(p, Buffer.concat(frames));
  return p;
}

/** 会话头行。 */
const sessionHeadLine = () => JSON.stringify({
  type: 'session',
  id: SID,
  createdAt: Date.parse('2026-11-08T09:00:00+08:00'),
  cwd: 'C:\\lab\\guard',
  agentPreset: 'lab-guard',
});

/** turn/start 行。 */
const startLine = (turn, time) => JSON.stringify({ type: 'turn/start', time, data: { turn } });

/** turn/end 行。 */
const endLine = (turn, time, kind = 'stop') => JSON.stringify({ type: 'turn/end', time, data: { turn, reason: { kind } } });

/** 从可读流等第一行输出（用于跨进程握手），超时失败而不是挂死。 */
function waitForLine(stream, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i !== -1) {
        const line = buf.slice(0, i);
        cleanup();
        resolve(line);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('子进程超时未输出握手行'));
    }, timeoutMs);
    stream.on('data', onData);
  });
}

/** 等子进程退出；超时就 SIGKILL 并返回 null（清理路径不许挂死）。 */
function waitExit(child, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// ============================================================================
// 二、① 同 code 同内容二次写 → 复用，文件一个字节都不动
// ============================================================================

// 守：幂等复用必须是"只读复核"，不能重写。旧实现（.tmp + rename）即使内容相同
// 也会换 inode、改 mtime，等于每次都"重新签发"一遍凭证；更糟的是它给
// "同 code 异内容"的覆盖留了门。这里用字节相等 + mtime 相等双重证明没动盘。
test('① 同 code 同内容二次写：返回 reused=true，文件字节与 mtime 均未变', async () => {
  await withLab(async (root) => {
    const { markdown, bodyHash } = renderDoc(CODE, '同一份原文，写两遍');
    const r1 = writeOriginal({ root, y: 2026, m: 11, code: CODE, markdown, bodyHash });
    assert.equal(r1.reused, false);
    assert.equal(r1.bodyHash, bodyHash);
    assert.equal(fs.existsSync(r1.path), true);
    assert.equal(r1.rel, originalRelPath(2026, 11, CODE));

    const beforeBytes = fs.readFileSync(r1.path);
    const beforeStat = fs.statSync(r1.path);

    const r2 = writeOriginal({ root, y: 2026, m: 11, code: CODE, markdown, bodyHash });
    assert.equal(r2.reused, true, '同内容二次写必须走复用分支');
    assert.equal(r2.path, r1.path);
    assert.equal(r2.rel, r1.rel);
    assert.equal(r2.bodyHash, bodyHash);
    assert.equal(r2.bytes, r1.bytes);

    const afterBytes = fs.readFileSync(r1.path);
    assert.equal(afterBytes.equals(beforeBytes), true, '复用分支不许改写文件（字节变了）');
    assert.equal(fs.statSync(r1.path).mtimeMs, beforeStat.mtimeMs, '复用分支不许改写文件（mtime 变了）');

    // 目录里只许有这一个文件：不许留 .tmp / 第二份。
    const dir = path.dirname(r1.path);
    assert.deepEqual(fs.readdirSync(dir), [`${CODE} 完整原文.md`]);
    assert.equal(fs.existsSync(r1.path + '.tmp'), false);
  });
});

// ============================================================================
// 三、② 同 code 异内容 → ORIGINAL_CONFLICT，停摆不覆盖
// ============================================================================

// 守：凭证"写入后不可变"的核心一条。同 code 异 hash 若被覆盖，原始凭证就换了人，
// 台账里指过的 docHash 全部对不上，而且是**静默**发生的。这里要求：
// 抛错（带 ORIGINAL_CONFLICT 码）、信息含路径与两个 hash、磁盘字节一个不改。
test('② 同 code 异内容：抛 ORIGINAL_CONFLICT（含路径与两个 hash），文件字节未变', async () => {
  await withLab(async (root) => {
    const docA = renderDoc(CODE, '甲版本：第一次落盘的原文');
    const docB = renderDoc(CODE, '乙版本：同编码但内容不同');
    assert.notEqual(docA.bodyHash, docB.bodyHash, '测试前提：两份正文 hash 必须不同');

    const r1 = writeOriginal({ root, y: 2026, m: 11, code: CODE, markdown: docA.markdown, bodyHash: docA.bodyHash });
    const beforeBytes = fs.readFileSync(r1.path);

    let err = null;
    try {
      writeOriginal({ root, y: 2026, m: 11, code: CODE, markdown: docB.markdown, bodyHash: docB.bodyHash });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '同 code 异内容必须抛错，不许静默覆盖');
    assert.equal(err.code, 'ORIGINAL_CONFLICT');
    assert.match(String(err.message), /ORIGINAL_CONFLICT/);
    assert.equal(String(err.message).includes(r1.path), true, '错误信息必须含凭证路径');
    assert.equal(String(err.message).includes(docA.bodyHash), true, '错误信息必须含旧正文 hash');
    assert.equal(String(err.message).includes(docB.bodyHash), true, '错误信息必须含新正文 hash');
    assert.equal(err.existingHash, docA.bodyHash);
    assert.equal(err.incomingHash, docB.bodyHash);

    // 盘上字节一个都不许变
    assert.equal(fs.readFileSync(r1.path).equals(beforeBytes), true, '冲突分支居然改写了文件');
    // 旧内容仍然可复核：重算正文 hash 等于 docA
    assert.equal(originalBodyHash(fs.readFileSync(r1.path, 'utf8')), docA.bodyHash);
    // 换回旧内容再写一次：仍然复用（说明冲突没有被"写坏"）
    const again = writeOriginal({ root, y: 2026, m: 11, code: CODE, markdown: docA.markdown, bodyHash: docA.bodyHash });
    assert.equal(again.reused, true);
  });
});

// 守：写前自检。渲染器给的 bodyHash 与"从 '## 1.' 重算"不一致，说明渲染口径漂了；
// 这种内容不该写进凭证库（写进去以后复核永远不过）。必须在建文件之前就拒绝。
test('②·补 写前自检：bodyHash 与正文重算不一致 → ORIGINAL_HASH_MISMATCH，且不建文件', async () => {
  await withLab(async (root) => {
    const { markdown } = renderDoc(CODE, '写前自检');
    let err = null;
    try {
      writeOriginal({ root, y: 2026, m: 11, code: CODE, markdown, bodyHash: 'f'.repeat(64) });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.code, 'ORIGINAL_HASH_MISMATCH');
    // 不许留下半成品：文件根本不该被创建
    const file = path.join(root, '2026年11月', '11月总“完整原文”', `${CODE} 完整原文.md`);
    assert.equal(fs.existsSync(file), false, '自检失败却把文件建出来了');
  });
});

// ============================================================================
// 四、③ 双实例：第二个抢不到锁，且不写
// ============================================================================

// 守：双实例同时写是"账被写脏"的最大来源。这里用**真子进程**持锁（不是同进程
// 第二次调用——那样会走幂等分支，测不到竞争），验证：
// ① 第二个 acquire 返回 acquired=false 且能拿到 holder；
// ② 第二个实例按锁守则不写（账目录里一条都不多）；
// ③ 第一个实例正常卸载（release）后，第二个立刻能抢到并写 —— 锁不是"只能重启"。
test('③ 双实例：子进程持锁时第二个 acquire 抢不到且不写；子进程释放后第二个才能写', async () => {
  await withLab(async (root) => {
    const childScript = path.join(root, 'holder-child.mjs');
    const lockUrl = pathToFileURL(path.join(REPO, 'lib', 'lock.js')).href;
    fs.writeFileSync(childScript, [
      "import { pathToFileURL } from 'node:url';",
      `const { acquire, release } = await import(${JSON.stringify(lockUrl)});`,
      'const root = process.argv[2];',
      'const h = acquire(root);',
      'console.log(JSON.stringify({ acquired: h.acquired, pid: h.holder ? h.holder.pid : null, path: h.path }));',
      'if (!h.acquired) process.exit(3);',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (s) => { if (String(s).includes('release')) { const r = release(h); console.log(JSON.stringify(r)); process.exit(0); } });",
      'process.stdin.resume();',
      '',
    ].join('\n'), 'utf8');

    const child = spawn(NODE, [childScript, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    try {
      // ---- 子进程成为唯一写者 ----
      const hello = JSON.parse(await waitForLine(child.stdout));
      assert.equal(hello.acquired, true, '子进程应抢到锁；stderr=' + stderr);
      assert.equal(fs.existsSync(lockPath(root)), true);

      // ---- 本进程是第二个实例：抢不到，且拿得到 holder ----
      const mine = acquire(root);
      assert.equal(mine.acquired, false, '第二个实例不该抢到锁');
      assert.equal(mine.holder.pid, hello.pid, '抢不到时必须带回持锁者 pid');
      assert.equal(typeof mine.holder.startedAt, 'string');

      // ---- 按锁守则：第二个实例不许写 ----
      const guardedAppend = (rec) => {
        const h = acquire(root);
        if (!h.acquired) return { acquired: false, wrote: false };
        try {
          const w = appendTurn(root, rec, new Set());
          return { acquired: true, wrote: !!(w.ok && !w.skipped) };
        } finally {
          release(h);
        }
      };
      const g = guardedAppend(sampleRecord('20261108-75238718e41a-A-00000001', '2026-11-08T23:59:59+08:00'));
      assert.equal(g.acquired, false);
      assert.equal(g.wrote, false);
      assert.deepEqual(
        fs.existsSync(ledgerDir(root)) ? fs.readdirSync(ledgerDir(root)).filter((n) => n.endsWith('.jsonl')) : [],
        [],
        '第二个实例抢不到锁却写了账',
      );
      assert.equal(readAll(root).records.length, 0);

      // ---- 子进程正常卸载（release）后，本进程可以接手 ----
      child.stdin.write('release\n');
      const code = await waitExit(child);
      assert.equal(code, 0, '子进程应正常退出；stderr=' + stderr);
      assert.equal(fs.existsSync(lockPath(root)), false, '正常卸载应删掉自己的锁');

      const h2 = acquire(root);
      assert.equal(h2.acquired, true, '前一个实例释放后，第二个必须能抢到');
      assert.equal(h2.holder.pid, process.pid);
      try {
        const w = appendTurn(root, sampleRecord('20261108-75238718e41a-A-00000001', '2026-11-08T23:59:59+08:00'), new Set());
        assert.equal(w.ok, true);
        assert.equal(w.skipped, false);
      } finally {
        release(h2);
      }
      assert.equal(readAll(root).records.length, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* ignore */ }
        await waitExit(child, 5_000);
      }
    }
  });
});

// 守（C05，v0.9.1；v1.0.0-re3 FAIL-03 扩写）：单实例锁的"跳过"必须**留日志**。锁保护的是"不写脏账"，
// 但静默跳过会让机主以为插件没在跑、或以为这期间的新轮次已经记上了 —— 排查时没有任何线索。
// index.js 的抢锁失败分支固定打 `LOCK_HELD another instance holds lock: pid=… host=… reason=… → 本轮跳过
// （不写 state、不推进游标）`（INFO 保留），re3 起另加一条 WARN + 一行 `.tick-metrics` 留证
// （"这一轮为什么什么都没做"必须可查；度量只追加旁证，不写 state/不推进游标的口径不变）。
// 这里用**真子进程**持锁 + 给 index.runOnce 注入日志收集器（ctx.logger），断言：
//   ① 第二个实例返回 lockSkipped=true 且带回持锁者 pid；
//   ② ctx.logger.info 捕获到含 `LOCK_HELD` / `another instance holds lock` / `本轮跳过` 的日志；
//      re3：ctx.logger.warn 也必须有一条（可见错误，不许只 INFO）；
//   ③ 账本零写入：无台账行、无 .state.json、**除 .tick-metrics 留证行外**文件集合与调用前一致。
test('③·日志 第二个实例抢不到锁：ctx.logger 输出含 LOCK_HELD + ERROR「拒绝执行」，且账本零写入', async () => {
  await withLab(async (root) => {
    // ---- 第一个实例：真子进程持锁（与 ③ 同一造法） ----
    const childScript = path.join(root, 'holder-log-child.mjs');
    const lockUrl = pathToFileURL(path.join(REPO, 'lib', 'lock.js')).href;
    fs.writeFileSync(childScript, [
      `const { acquire } = await import(${JSON.stringify(lockUrl)});`,
      'const h = acquire(process.argv[2]);',
      'console.log(JSON.stringify({ acquired: h.acquired, pid: h.holder ? h.holder.pid : null }));',
      'if (!h.acquired) process.exit(3);',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (s) => { if (String(s).includes('release')) process.exit(0); });",
      'process.stdin.resume();',
      '',
    ].join('\n'), 'utf8');

    const child = spawn(NODE, [childScript, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    try {
      const hello = JSON.parse(await waitForLine(child.stdout));
      assert.equal(hello.acquired, true, '子进程应抢到锁；stderr=' + stderr);

      // 调用第二个实例前的磁盘快照（只比文件名：锁心跳只改内容不改名）。
      // ★ re3 FAIL-03：锁跳过的那一轮会写一行 `.tick-metrics.jsonl`（"为什么什么都没做"的证据），
      //   快照排除它 —— 其余文件集合必须一字不差（账本/state/原文/周账零写入）。
      const snap = () => (fs.existsSync(root)
        ? fs.readdirSync(root, { recursive: true })
          .map(String)
          .filter((p) => !p.endsWith(path.join('ledger', '.tick-metrics.jsonl')))
          .sort()
        : []);
      const before = snap();

      // ---- 第二个实例：真跑 index.runOnce，注入日志收集器（测试桩，不改实现） ----
      const logs = [];
      const logger = {
        info: (m) => logs.push({ level: 'info', msg: String(m) }),
        warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
        error: (m) => logs.push({ level: 'error', msg: String(m) }),
        debug: () => {},
      };
      const idx = await import(pathToFileURL(path.join(REPO, 'index.js')).href);
      const cfg = idx.__test__.readConfig({ root, enabled: true });
      let res = null;
      try {
        res = await idx.runOnce({ logger }, cfg);
      } catch (e) {
        assert.fail('第二个实例 runOnce 抛异常（抢不到锁应跳过并留日志）：' + (e && e.stack ? e.stack : e));
      }

      // ---- ① 跳过语义 ----
      assert.equal(res.lockSkipped, true, '第二个实例必须 lockSkipped=true');
      assert.equal(res.lockHolder.pid, hello.pid, '跳过时必须带回持锁者 pid');

      // ---- ② C05 核心：日志（通道 = 注入的 ctx.logger，不是 stdout/返回值） ----
      const info = logs.filter((l) => l.level === 'info').map((l) => l.msg);
      const text = info.join('\n');
      assert.match(text, /LOCK_HELD/, '第二个实例没有留下 LOCK_HELD 日志（ctx.logger.info）');
      assert.match(text, /another instance holds lock/, 'LOCK_HELD 日志文案不完整');
      assert.match(text, /拒绝执行/, 'LOCK_HELD 日志缺少「拒绝执行」口径说明（多写者硬断言：拒绝启动，不是安静跳过）');
      assert.equal(text.includes('pid=' + hello.pid), true, 'LOCK_HELD 日志没有带持锁者 pid=' + hello.pid);
      assert.equal(String(res.errors.join('\n')).includes('LOCK_HELD'), true, '返回值的 errors 也应含 LOCK_HELD（便于宿主上报）');
      // ★ 多写者硬断言（机主 2026-11-15 指令）：必须是 lockBlocked（拒绝启动），且 ERROR 级报警。
      assert.equal(res.lockBlocked, true, '★ 第二个写者必须 lockBlocked=true（拒绝启动，不是软跳过）');
      const errs = logs.filter((l) => l.level === 'error').map((l) => l.msg);
      assert.equal(errs.some((m) => m.includes('ERROR') && m.includes('拒绝启动')), true,
        '★ 必须有 ERROR 级「拒绝启动」报警（多写者硬断言：检测到第二个写者 → 拒绝启动/立即停手，不许警告后继续）');
      // ★ re3 FAIL-03：可见错误不能只有 INFO —— 必须另有一条 WARN（运维/宿主告警通道可见）。
      const warns = logs.filter((l) => l.level === 'warn').map((l) => l.msg);
      // ★ 多写者硬断言：可见错误升到 ERROR 级；若宿主没有 log.error 才回落 WARN（两者其一必须成立）。
      assert.equal([...warns, ...errs].some((m) => m.includes('LOCK_HELD') || m.includes('拒绝启动')), true, '★ 锁被占用必须有可见告警（ERROR 或 WARN，不能只 INFO）');

      // ★ re3 FAIL-03：锁跳过的 tick 必须写一行 .tick-metrics 留证（"这一轮为什么什么都没做"可查）。
      const metricsFile = path.join(root, 'ledger', '.tick-metrics.jsonl');
      assert.equal(fs.existsSync(metricsFile), true, '★ re3 FAIL-03：锁跳过 tick 必须写 .tick-metrics 记录');
      const metricLines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter((l) => l.trim());
      assert.ok(metricLines.length >= 1, 'tick-metrics 至少一行');
      const lastMetric = JSON.parse(metricLines[metricLines.length - 1]);
      assert.equal(lastMetric.lockSkipped, true, 'tick-metrics.lockSkipped 必须为 true');
      assert.equal(lastMetric.lock && lastMetric.lock.reason, 'held', 'tick-metrics.lock.reason 必须是 held');
      assert.equal(typeof lastMetric.ms, 'number', 'tick-metrics 必须带 ms 字段（设备自检按缺字段判红）');

      // ---- ③ 账本零写入（看磁盘事实，不信返回值） ----
      assert.deepEqual(snap(), before, '第二个实例抢不到锁却动了盘（文件集合变了）');
      assert.deepEqual(
        fs.existsSync(ledgerDir(root)) ? fs.readdirSync(ledgerDir(root)).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')) : [],
        [], '第二个实例抢不到锁却写了台账',
      );
      assert.equal(fs.existsSync(path.join(root, 'ledger', '.state.json')), false, '第二个实例抢不到锁却写了 .state.json');
      assert.equal(readAll(root).records.length, 0, '第二个实例抢不到锁却落账了');
      // 锁仍在原持锁者手里（第二个实例没有动别人的锁）
      assert.equal(inspectLock(root).holder.pid, hello.pid, '第二个实例把别人的锁动了');
    } finally {
      try { child.stdin.write('release\n'); } catch { /* ignore */ }
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* ignore */ }
        await waitExit(child, 5_000);
      }
    }
  });
});

// 守：进程退出（含进程被正常 stop、脚本跑完）必须释放锁；否则崩一次就永久留一个
// "活锁"，下一个实例要么停摆要么等僵死超时。这里让子进程 acquire 后直接 process.exit(0)，
// 验证退出钩子把锁删掉 —— 它跑的是同步 unlink，必须能在 exit 阶段完成。
test('③·补 进程退出释放：子进程 acquire 后直接 exit(0) → 锁文件被退出钩子删掉', async () => {
  await withLab(async (root) => {
    const childScript = path.join(root, 'exit-child.mjs');
    const lockUrl = pathToFileURL(path.join(REPO, 'lib', 'lock.js')).href;
    fs.writeFileSync(childScript, [
      `const { acquire } = await import(${JSON.stringify(lockUrl)});`,
      'const h = acquire(process.argv[2]);',
      'console.log(JSON.stringify({ acquired: h.acquired, pid: h.holder ? h.holder.pid : null }));',
      'process.exit(0); // 故意不调用 release：只靠进程退出钩子',
      '',
    ].join('\n'), 'utf8');

    const child = spawn(NODE, [childScript, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    try {
      const hello = JSON.parse(await waitForLine(child.stdout));
      assert.equal(hello.acquired, true);
      const code = await waitExit(child);
      assert.equal(code, 0, '子进程应正常退出；stderr=' + stderr);
      assert.equal(fs.existsSync(lockPath(root)), false, '进程正常退出后锁文件还在（退出钩子没生效）');

      const h = acquire(root);
      assert.equal(h.acquired, true, '退出钩子没清锁，后续实例抢不到');
      release(h);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* ignore */ }
        await waitExit(child, 5_000);
      }
    }
  });
});



// ============================================================================
// 五、④ 僵死锁：连续两轮确认后夺取，旧锁留证不删
// ============================================================================

// 守：崩溃的实例会把锁文件留在盘上（Windows 上进程一死句柄就释放，但文件还在）。
// 若永久不夺取，插件从此停摆；若见到"心跳旧"就立刻抢，又可能把"正好在写心跳的
// 活进程"当成死的 → 双写者。所以必须"连续两轮超 3×心跳间隔"才夺，且旧锁 rename
// 留证（不许删）——事后能查清"谁在什么时候被判定僵死"。
test('④ 僵死锁（跨机/判不了死活）：第一轮只记疑、第二轮才夺取；旧锁 rename 成 .lock.stale-* 原样留证', async () => {
  await withLab(async (root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const oldMs = Date.now() - 10 * 60 * 1000; // 10 分钟前的心跳，远超 3×30s
    const oldHolder = {
      v: 1,
      pid: 999999, // 不存在的 pid
      // ★ 2026-11-09：这里必须是**别的机器**。
      //   同机 pid 已死是确定性证据 → 走"立即夺取"（见下一条用例 `④·同机`）；
      //   只有"判不了死活"（跨机 / pid 被复用 / 坏锁）才需要连续两轮观察，防的是误抢活着的实例。
      hostname: 'another-host-0f0f',
      token: 'dead-holder-token',
      startedAt: '2026-11-09T10:00:00+08:00',
      startedAtMs: oldMs,
      heartbeatAt: '2026-11-09T10:00:00+08:00',
      heartbeatAtMs: oldMs,
    };
    const oldRaw = JSON.stringify(oldHolder, null, 2) + '\n';
    fs.writeFileSync(lockPath(root), oldRaw, 'utf8');
    assert.equal(inspectLock(root).staleCandidate, true, '测试前提：这份锁应被判定为准僵死');

    // ---- 第一轮：只记疑，不许动手 ----
    const a1 = acquire(root);
    assert.equal(a1.acquired, false, '第一轮不许直接夺取');
    assert.equal(a1.stalePending, true);
    assert.equal(a1.holder.pid, 999999);
    assert.equal(listStaleLocks(root).length, 0, '第一轮就产生了留证文件 = 直接夺取了');
    assert.equal(fs.readFileSync(lockPath(root), 'utf8'), oldRaw, '第一轮不许动旧锁');

    // ---- 第二轮：同一份僵死心跳 → 确认 → 夺取 ----
    const a2 = acquire(root);
    assert.equal(a2.acquired, true, '连续两轮僵死后必须能夺取（否则永久停摆）');
    assert.equal(a2.holder.pid, process.pid);
    assert.equal(typeof a2.stalePath, 'string');
    assert.equal(a2.stalePath.length > 0, true);
    assert.equal(a2.stalePath.startsWith(staleLockPrefix(root)), true);

    const staleFiles = listStaleLocks(root);
    assert.equal(staleFiles.length, 1, '旧锁必须留证（rename，不删）');
    assert.equal(fs.readFileSync(staleFiles[0].path, 'utf8'), oldRaw, '留证的旧锁内容必须原样保留');
    assert.match(staleFiles[0].name, /^\.lock\.stale-\d{8}-\d{6}-\d+-[0-9a-f]+$/);
    // 新锁必须真的换成了本进程
    const insp = inspectLock(root);
    assert.equal(insp.holder.pid, process.pid);
    assert.equal(insp.holder.hostname, os.hostname());
    assert.equal(insp.staleCandidate, false);

    // ---- 正常释放：锁删掉，留证文件仍在（永不删） ----
    const rel = release(a2);
    assert.equal(rel.released, true);
    assert.equal(fs.existsSync(lockPath(root)), false);
    assert.equal(listStaleLocks(root).length, 1, '留证文件不该被释放动作删掉');
  });
});

// 守（INV-14，2026-11-09 新增）：**同机持锁进程已死**（kill -9 之后的真实形态）必须立即夺取。
// 为什么不能再等两轮：`kill -9` 后残留的锁文件里 pid 已经不存在，而"重启续跑"要求**立刻**能写；
// 等两轮就等于"杀进程后重启必须空转一轮"，P0-3-resume 实测就是这个红（lockSkipped=true）。
// 为什么安全：pid 被复用时 `process.kill(pid,0)` 会成功 → 判"没死" → 自动退回两轮观察；
//            且夺取前仍把旧锁 rename 成 `.lock.stale-*` 原样留证，事后可查。
test('④·同机 僵死锁：pid 已死 → 立即夺取（不等第二轮）；旧锁同样 rename 留证', async () => {
  await withLab(async (root) => {
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const oldMs = Date.now() - 2 * 1000; // 心跳只过了 2 秒：远未到 90 秒阈值，只能靠"pid 已死"判
    const holder = {
      v: 1,
      pid: 999999, // 本机不存在的 pid → process.kill(pid,0) 抛 ESRCH
      hostname: os.hostname(),
      token: 'killed-holder-token',
      startedAt: '2026-11-09T10:00:00+08:00',
      startedAtMs: oldMs,
      heartbeatAt: '2026-11-09T10:00:00+08:00',
      heartbeatAtMs: oldMs,
    };
    const raw = JSON.stringify(holder, null, 2) + '\n';
    fs.writeFileSync(lockPath(root), raw, 'utf8');
    assert.equal(inspectLock(root).staleCandidate, true, '测试前提：同机死 pid 应被判为准僵死');

    const a1 = acquire(root); // 第一次 acquire 就要拿到
    assert.equal(a1.acquired, true, '同机死 pid 必须立即夺取（否则 kill -9 后重启永久停摆）');
    assert.equal(a1.holder.pid, process.pid);
    assert.equal(typeof a1.stalePath, 'string');
    assert.equal(a1.stalePath.length > 0, true);
    assert.equal(a1.stalePath.startsWith(staleLockPrefix(root)), true);

    const staleFiles = listStaleLocks(root);
    assert.equal(staleFiles.length, 1, '旧锁必须留证（rename，不删）');
    assert.equal(fs.readFileSync(staleFiles[0].path, 'utf8'), raw, '留证的旧锁内容必须原样保留');
    assert.match(staleFiles[0].name, /^\.lock\.stale-\d{8}-\d{6}-\d+-[0-9a-f]+$/);

    const insp = inspectLock(root);
    assert.equal(insp.holder.pid, process.pid);
    assert.equal(insp.holder.hostname, os.hostname());
    assert.equal(insp.staleCandidate, false);

    const rel = release(a1);
    assert.equal(rel.released, true);
    assert.equal(fs.existsSync(lockPath(root)), false);
    assert.equal(listStaleLocks(root).length, 1, '留证文件不该被释放动作删掉');
  });
});

// 守：锁路径/心跳参数是契约的一部分（契约要求 30s 心跳、3× 间隔、`ledger/.lock`）。
// 路径拼错会保护到别的目录；心跳参数漂了会让僵死判定要么太敏感（误抢）要么太迟钝。
test('④·补 契约常量：锁文件 = <root>/ledger/.lock，心跳 30s，僵死阈值 3×', async () => {
  await withLab(async (root) => {
    assert.equal(lockPath(root), path.join(root, 'ledger', '.lock'));
    assert.equal(staleLockPrefix(root), linkJoin(root));
    assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
    assert.equal(STALE_MULTIPLIER, 3);
    assert.deepEqual(listStaleLocks(root), []);
  });
});

/** 与 lockPath 独立拼的期望值（不借被测实现，防止"自己证明自己"）。 */
function linkJoin(root) {
  return path.join(root, 'ledger', '.lock.stale-');
}

// ============================================================================
// 六、⑤ 尾行无换行时追加：先补 \n，不粘结
// ============================================================================

// 守：append 前不检查尾行，上一行缺换行时两条账会粘成一条坏 JSON ——
// 一次粘住，整个日文件从此解析不出来（readAll 的 badLines 飙升），而且**不可逆**。
// 这里手工造一个"没有结尾换行"的旧账文件，验证追加会先补换行、两行都能单独 parse。
test('⑤ 尾行无换行：追加先补 \\n，两条各自可 JSON.parse，且新文件末尾有换行', async () => {
  await withLab(async (root) => {
    const day = ledgerPath(root, '2026-11-08');
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    const legacyObj = { v: 3, code: '20261108-75238718e41a-A-00000000', ts: '2026-11-08T09:00:00+08:00' };
    const legacyRaw = JSON.stringify(legacyObj);
    fs.writeFileSync(day, legacyRaw, 'utf8'); // 故意没有结尾换行

    const rec = sampleRecord('20261108-75238718e41a-A-00000001', '2026-11-08T23:59:59+08:00');
    const w = appendTurn(root, rec, new Set());
    assert.equal(w.ok, true);
    assert.equal(w.skipped, false);

    const buf = fs.readFileSync(day);
    assert.equal(buf[buf.length - 1], 0x0a, '追加后文件末尾必须是换行');
    const txt = buf.toString('utf8');
    assert.equal(txt.startsWith(legacyRaw + '\n'), true, '旧行后面必须先补一个换行');
    const lines = txt.split('\n');
    assert.equal(lines[lines.length - 1], ''); // 末尾换行产生的空串
    assert.equal(lines.length, 3, '应为 2 行内容 + 末尾空串');
    assert.deepEqual(JSON.parse(lines[0]), legacyObj);
    assert.deepEqual(JSON.parse(lines[1]), rec);

    // 再追加一条：不能出现空行（尾行已有换行时不许再补）
    const rec2 = sampleRecord('20261108-75238718e41a-A-00000002', '2026-11-08T23:59:59+08:00');
    appendTurn(root, rec2, new Set([rec.code]));
    const lines2 = fs.readFileSync(day, 'utf8').split('\n');
    assert.equal(lines2.length, 4, '第二条追加后应为 3 行内容 + 末尾空串');
    assert.deepEqual(JSON.parse(lines2[2]), rec2);
    assert.equal(lines2.slice(0, -1).filter((l) => l.trim() === '').length, 0, '中间出现空行');

    const all = readAll(root);
    assert.equal(all.badLines, 0);
    assert.deepEqual(all.records.map((r) => r.code), [legacyObj.code, rec.code, rec2.code]);

    // 首写（文件不存在）也必须有结尾换行
    const day2 = ledgerPath(root, '2026-11-09');
    const rec3 = sampleRecord('20261108-75238718e41a-A-00000003', '2026-11-09T00:00:01+08:00');
    appendTurn(root, rec3, new Set([rec.code, rec2.code]));
    const buf3 = fs.readFileSync(day2);
    assert.equal(buf3[buf3.length - 1], 0x0a, '首写文件末尾缺换行');
  });
});

// ============================================================================
// 七、⑥ 坏帧/半截帧：缺口必须留痕到 .lost.jsonl（可复算）
// ============================================================================

// 守：坏帧/半截帧会让一段会话**读不出来**。旧实现只把 failed 计数丢进日志，
// 账面上看不出"这里少了一段" —— 对账时无法区分"没有轮次"和"轮次读不出来"。
// 这里要求：readTurnsFrom 报 failed>0 后，.lost.jsonl 必须出现一条记录，
// 含会话、缺失字节区间（带 sha256 可独立复算）、帧偏移、+08:00 时间；
// 且同一现场不重复追加、旧记录字节不变（只追加）。
test('⑥ 坏帧：readTurnsFrom 报 failed>0 → .lost.jsonl 留痕（会话/缺失区间/sha256/帧偏移/时间）', async () => {
  await withLab(async (root) => {
    // 好帧（头 + turn/start） + 坏帧（魔数 + 垃圾） + 好帧（turn/end）
    const goodA = frame([sessionHeadLine(), startLine(1, Date.parse('2026-11-08T09:00:01+08:00'))]);
    const badFrame = Buffer.concat([ZSTD_MAGIC, Buffer.from('this-is-not-a-zstd-frame')]);
    const goodC = frame([endLine(1, Date.parse('2026-11-08T09:00:02+08:00'))]);
    const sessFile = writeSessionFile(root, [goodA, badFrame, goodC]);

    const r = readTurnsFrom(sessFile, { fromByte: 0 });
    assert.equal(r.meta.failed, 1, '坏帧必须被计数（不许静默跳过）');
    assert.equal(r.meta.frames, 3);
    assert.equal(r.formatError, '');
    assert.equal(r.closed.length, 1, '坏帧两侧的好帧仍必须读出轮次');

    const out = lostTurns(root, { file: sessFile, result: r, sid: SID, offsetMinutes: OFFSET_MINUTES });
    assert.equal(out.ok, true);
    assert.equal(out.recorded, true);
    assert.equal(out.path, lostPath(root));
    assert.equal(fs.existsSync(out.path), true);

    const lost = readLost(root);
    assert.equal(lost.records.length, 1);
    assert.equal(lost.badLines, 0);
    const rec = lost.records[0];

    // ---- 会话与时间 ----
    assert.equal(rec.sid, SID);
    assert.equal(rec.file, sessFile);
    assert.equal(rec.fromByte, 0);
    assert.equal(rec.scanSize, goodA.length + badFrame.length + goodC.length);
    assert.equal(rec.failedFrames, 1);
    assert.ok(Array.isArray(rec.reasons) && rec.reasons.includes('failed-frames'));
    assert.equal(rec.at.endsWith('+08:00'), true, '时间必须是 +08:00 结尾（契约：禁止 Z）');
    assert.equal(rec.at.includes('Z'), false);

    // ---- 帧偏移与缺失字节区间（用磁盘长度独立算期望值，不借被测函数） ----
    const expectedOffsets = [0, goodA.length, goodA.length + badFrame.length];
    assert.deepEqual(rec.frameOffsets, expectedOffsets);
    assert.deepEqual(rec.failedFrameOffsets, [goodA.length]);
    assert.equal(rec.missing.length, 1);
    assert.equal(rec.missing[0].start, goodA.length);
    assert.equal(rec.missing[0].end, goodA.length + badFrame.length);
    assert.equal(rec.missing[0].bytes, badFrame.length);
    // 可复算：sha256(坏帧原始字节) 必须等于留痕里的值
    assert.equal(rec.missing[0].sha256, sha256(badFrame));

    // ---- 只追加：同一现场第二轮不重复写、旧字节一个不改 ----
    const rawAfterFirst = fs.readFileSync(out.path);
    const again = lostTurns(root, { file: sessFile, result: r, sid: SID, offsetMinutes: OFFSET_MINUTES });
    assert.equal(again.recorded, false);
    assert.equal(again.reason, 'duplicate');
    assert.equal(fs.readFileSync(out.path).equals(rawAfterFirst), true, '重复现场居然又追加了一行');

    // ---- 另一种缺口（截断半帧）→ 追加第二行，第一行前缀不变 ----
    const truncFile = path.join(root, 'sessions', SID, 'truncated.v4.jsonl.zstd');
    const half = goodC.subarray(0, Math.max(8, Math.floor(goodC.length / 2)));
    fs.writeFileSync(truncFile, Buffer.concat([goodA, half]));
    const rt = readTurnsFrom(truncFile, { fromByte: 0 });
    assert.ok(rt.meta.failed > 0);
    const outT = lostTurns(root, { file: truncFile, result: rt, sid: SID, offsetMinutes: OFFSET_MINUTES });
    assert.equal(outT.recorded, true);
    assert.ok(outT.record.reasons.includes('truncated-tail'), '缺口延伸到文件尾必须标 truncated-tail');
    assert.equal(outT.record.missing[0].end, fs.statSync(truncFile).size);
    assert.equal(outT.record.missing[0].start, goodA.length);

    const rawAfterSecond = fs.readFileSync(out.path);
    assert.equal(rawAfterSecond.subarray(0, rawAfterFirst.length).equals(rawAfterFirst), true, '旧留痕被改写了（不是只追加）');
    assert.equal(readLost(root).records.length, 2);

    // ---- 第三种缺口（游标不在帧边界 / bad-magic）→ 整段按缺失留痕 ----
    const badCursorFile = path.join(root, 'sessions', SID, 'bad-cursor.v4.jsonl.zstd');
    fs.writeFileSync(badCursorFile, Buffer.concat([goodA, goodC]));
    const rBad = readTurnsFrom(badCursorFile, { fromByte: 7 }); // 7 不是任何帧的起点
    assert.match(String(rBad.formatError), /^bad-magic@7$/);
    const outBad = lostTurns(root, { file: badCursorFile, result: rBad, sid: SID, offsetMinutes: OFFSET_MINUTES });
    assert.equal(outBad.recorded, true);
    assert.deepEqual(outBad.record.reasons, ['bad-magic'], 'bad-magic 不该被误标成截断');
    assert.equal(outBad.record.fromByte, 7);
    assert.equal(outBad.record.missing.length, 1);
    assert.equal(outBad.record.missing[0].start, 7);
    assert.equal(outBad.record.missing[0].end, fs.statSync(badCursorFile).size);
    assert.equal(outBad.record.missing[0].sha256, sha256(fs.readFileSync(badCursorFile).subarray(7)));
    assert.equal(readLost(root).records.length, 3);

    // ---- .lost.jsonl 不是账：readAll 不许把它读成记录 ----
    const all = readAll(root);
    assert.equal(all.files, 0, 'readAll 把 .lost.jsonl 当账读了');
    assert.equal(all.records.length, 0);

    // ---- 干净会话：不产生任何留痕 ----
    const cleanFile = path.join(root, 'sessions', SID, 'clean.v4.jsonl.zstd');
    fs.writeFileSync(cleanFile, Buffer.concat([goodA, goodC]));
    const rc = readTurnsFrom(cleanFile, { fromByte: 0 });
    assert.equal(rc.meta.failed, 0);
    const outC = lostTurns(root, { file: cleanFile, result: rc, sid: SID, offsetMinutes: OFFSET_MINUTES });
    assert.equal(outC.recorded, false);
    assert.equal(outC.reason, 'no-loss');
    assert.equal(readLost(root).records.length, 3, '干净会话不该新增留痕');
  });
});
