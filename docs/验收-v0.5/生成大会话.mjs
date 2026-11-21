/**
 * @file 生成大会话.mjs
 * @role **流式**生成 ≥36 MB（解压后）/ ≥1000 轮的 v4 会话文件（zstd 多帧），写盘内存有界。
 *
 * @why 为什么不能用真实 38 MB 素材：
 *      本机 7.7 GB 内存、可用 <1.5 GB；2026-11-09 已因全量验收把 Harness 打崩两次。
 *      审计 P0-3 又要求"不得用测试数据较小来验收"，所以必须**自合成**大会话：
 *      · 逐批生成事件 → 逐批 zstd 压缩 → 逐批 append，不在内存里留全量事件；
 *      · 批次大小可调（默认 10 轮/批）；峰值 RSS 由采样器记录并可断言。
 *
 * 用法：
 *   node docs/验收-v0.5/生成大会话.mjs --out=<文件> [--turns=1000] [--uncompressed-mb=36] [--batch-turns=10]
 *   node docs/验收-v0.5/生成大会话.mjs --verify --out=<文件>
 *
 * 供 P0 回归调用：generateBigSession({out, turns, targetMB, batchTurns, signal}) / verifyBigSession({file})
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_SID = 'session-bigv05-0000-1111-2222-333344445555';
const T0 = Date.parse('2026-11-01T08:00:00+08:00');

function headerLine(sid, createdAt) {
  return JSON.stringify({ type: 'session', version: 4, id: sid, createdAt, cwd: 'C:\\v05-big' });
}

/** 一行事件（seq 连续、时间递增）。 */
function turnLines(turn, sid, { payloadChars = 36000 } = {}) {
  const t = T0 + turn * 60_000;
  // 用 ASCII 填充（1 字节/字符）把"解压后体积"算准；尾部保留中文标记，便于验"多字节逐字不丢"
  const payload = `P${String(turn).padStart(4, '0')}:` + 'X'.repeat(Math.max(0, payloadChars)) + `【轮尾标记${turn}】`;
  const args = JSON.stringify({ command: 'pwsh', script: payload });
  const lines = [];
  let seq = (turn - 1) * 6;
  const push = (type, time, data) => lines.push(JSON.stringify({ type, seq: seq++, time, data }));
  push('turn/start', t, { turn });
  push('user/message', t + 1, { content: [{ type: 'text', text: `第 ${turn} 轮的用户输入：${'U'.repeat(200)}` }], source: { kind: 'user' }, role: 'user' });
  push('assistant/message', t + 2, { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第 ${turn} 轮回复：${'A'.repeat(400)}` }, { type: 'tool_use', id: 'call-' + turn, name: 'pwsh' }] } });
  push('tool/call', t + 3, { turn, step: 1, callId: 'call-' + turn, name: 'pwsh', arguments: args });
  push('tool/result', t + 4, { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call-' + turn }, content: [{ type: 'text', text: 'R'.repeat(600) }], isError: false }, sourceEventSeqs: [seq - 1] });
  push('turn/end', t + 5000, { turn, reason: { kind: 'completed' } });
  return lines;
}

/**
 * 流式生成大会话。
 * @param {object} p
 * @param {string} p.out 输出文件
 * @param {number} [p.turns=1000] 轮数（≥1000）
 * @param {number} [p.targetMB=36] 解压后目标 MB（≥36）
 * @param {number} [p.batchTurns=10] 每批轮数（内存上限 ≈ batchTurns × 单轮字节）
 * @param {string} [p.sid]
 * @param {AbortSignal} [p.signal] 取消信号（批间检查）
 * @param {(p:{turns:number,bytes:number,fileBytes:number})=>void} [p.onProgress]
 * @returns {{ok:boolean,cancelled:boolean,file:string,turns:number,uncompressedBytes:number,
 *            fileBytes:number,frames:number,durationMs:number,peakRssMB:number,reason?:string}}
 */
export function generateBigSession({
  out, turns = 0, targetMB = 36, batchTurns = 10, sid = DEFAULT_SID, signal, onProgress,
  strict = false,
} = {}) {
  if (!out) throw new Error('generateBigSession: out 必填');
  // 非 strict（压测 1/4/16MB 档）：轮数按目标体积等比缩放（每轮 ~36KB，与 36MB/1000 轮同构）
  const effTurns = turns > 0 ? turns : Math.max(20, Math.round(targetMB * 28));
  if (strict && effTurns < 1000) throw new Error('generateBigSession(strict): turns 必须 ≥1000（P0-3 验收要求）');
  if (strict && targetMB < 36) throw new Error('generateBigSession(strict): targetMB 必须 ≥36（P0-3 验收要求）');
  turns = effTurns;
  const targetBytes = targetMB * 1024 * 1024;
  // 每轮其它字段约 2.5 KB（JSON 结构+固定文本）；再留 6% 余量保证解压后 ≥ targetMB
  const payloadChars = Math.max(800, Math.ceil(targetBytes / turns * 1.06 - 2600));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, '');
  const t0 = Date.now();
  let peak = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss / (1024 * 1024);
    if (rss > peak) peak = rss;
  }, 100);
  sampler.unref?.();

  let frames = 0;
  let realBytes = 0;
  let cancelled = false;
  try {
    // ① 头帧（单独一帧，和 DSH 的写盘形态一致）
    const head = headerLine(sid, T0);
    const headBuf = zlib.zstdCompressSync(Buffer.from(head + '\n', 'utf8'));
    fs.appendFileSync(out, headBuf);
    frames += 1;
    realBytes += Buffer.byteLength(head + '\n', 'utf8');

    // ② 逐批生成 → 压缩 → append；每批结束立刻释放
    for (let start = 1; start <= turns; start += batchTurns) {
      if (signal && signal.aborted) { cancelled = true; break; }
      const end = Math.min(turns, start + batchTurns - 1);
      const lines = [];
      for (let turn = start; turn <= end; turn += 1) {
        for (const line of turnLines(turn, sid, { payloadChars })) lines.push(line);
      }
      const text = lines.join('\n') + '\n';
      const buf = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
      fs.appendFileSync(out, buf);
      frames += 1;
      realBytes += Buffer.byteLength(text, 'utf8');
      if (onProgress) onProgress({ turns: end, bytes: realBytes, fileBytes: fs.statSync(out).size });
    }
  } finally {
    clearInterval(sampler);
  }
  const st = fs.statSync(out);
  const rss = process.memoryUsage().rss / (1024 * 1024);
  if (rss > peak) peak = rss;
  return {
    ok: !cancelled && realBytes >= targetBytes * 0.985 && turns >= (strict ? 1000 : 20),
    cancelled,
    file: out,
    turns,
    uncompressedBytes: realBytes,
    fileBytes: st.size,
    frames,
    durationMs: Date.now() - t0,
    peakRssMB: Math.round(peak),
    reason: cancelled ? 'cancelled' : (realBytes < targetBytes ? `解压后字节不足（${realBytes} < ${targetBytes}）` : ''),
  };
}

/**
 * 流式校验会话文件：逐帧解压计数，不在内存里保留全量解压文本。
 * @returns {{ok:boolean,fileBytes:number,frames:number,okFrames:number,failedFrames:number,
 *            uncompressedBytes:number,lines:number,turns:number,closedTurns:number,tailMarkerHits:number,
 *            sha256:string,error?:string}}
 */
export function verifyBigSession({ file, minTurns = 1000, minMB = 36 } = {}) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const chunk = 1024 * 1024;
  let carry = Buffer.alloc(0);
  let pos = 0;
  let pendingFrame = null;      // 当前帧的累积字节（从某个 magic 起点开始）
  let frames = 0;
  let okFrames = 0;
  let failedFrames = 0;
  let uncompressedBytes = 0;
  let lines = 0;
  let turns = 0;
  let closedTurns = 0;
  let tailMarkerHits = 0;
  const hash = crypto.createHash('sha256');
  try {
    for (;;) {
      const readBuf = Buffer.allocUnsafe(chunk);
      const n = fs.readSync(fd, readBuf, 0, chunk, pos);
      if (n <= 0 && carry.length === 0) break;
      pos += n;
      let buf = n > 0 ? Buffer.concat([carry, readBuf.subarray(0, n)]) : carry;
      carry = Buffer.alloc(0);
      let idx = buf.indexOf(MAGIC, 0);
      if (pendingFrame === null) {
        if (idx < 0) { // 这一段没有帧起点（异常）
          carry = buf.length > 8 ? buf.subarray(buf.length - 8) : buf;
          if (n === 0) break;
          continue;
        }
        pendingFrame = buf.subarray(idx);
        buf = Buffer.alloc(0);
      } else {
        // 继续累积当前帧
        pendingFrame = Buffer.concat([pendingFrame, buf]);
        buf = Buffer.alloc(0);
      }
      // 在 pendingFrame 里找“第二个 magic”确定帧边界
      let next = pendingFrame.indexOf(MAGIC, MAGIC.length);
      while (next !== -1 && next < pendingFrame.length) {
        const frameBuf = pendingFrame.subarray(0, next);
        pendingFrame = pendingFrame.subarray(next);
        frames += 1;
        hash.update(frameBuf);
        try {
          const text = zlib.zstdDecompressSync(frameBuf).toString('utf8');
          okFrames += 1;
          uncompressedBytes += Buffer.byteLength(text, 'utf8');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            lines += 1;
            try {
              const o = JSON.parse(line);
              if (o && o.type === 'turn/start') turns += 1;
              else if (o && o.type === 'turn/end') closedTurns += 1;
            } catch { /* 坏行计数由 lines/okFrames 反映 */ }
          }
          if (text.includes('【轮尾标记')) tailMarkerHits += 1;
        } catch {
          failedFrames += 1;
        }
        next = pendingFrame.indexOf(MAGIC, MAGIC.length);
      }
      // 防止 pendingFrame 无限增长：单帧上限 64MB
      if (pendingFrame.length > 64 * 1024 * 1024) { failedFrames += 1; pendingFrame = null; }
      if (n === 0) break;
    }
    // 收尾：剩余 pendingFrame 作为最后一帧
    if (pendingFrame && pendingFrame.length >= MAGIC.length + 4) {
      frames += 1;
      hash.update(pendingFrame);
      try {
        const text = zlib.zstdDecompressSync(pendingFrame).toString('utf8');
        okFrames += 1;
        uncompressedBytes += Buffer.byteLength(text, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          lines += 1;
          try {
            const o = JSON.parse(line);
            if (o && o.type === 'turn/start') turns += 1;
            else if (o && o.type === 'turn/end') closedTurns += 1;
          } catch { /* ignore */ }
        }
        if (text.includes('【轮尾标记')) tailMarkerHits += 1;
      } catch { failedFrames += 1; }
    }
  } catch (e) {
    return { ok: false, fileBytes: size, frames, okFrames, failedFrames, uncompressedBytes, lines, turns, closedTurns, tailMarkerHits, sha256: hash.digest('hex'), error: e.message };
  } finally {
    fs.closeSync(fd);
  }
  return {
    ok: failedFrames === 0 && turns >= minTurns && uncompressedBytes >= minMB * 1024 * 1024 * 0.985,
    fileBytes: size, frames, okFrames, failedFrames, uncompressedBytes, lines,
    turns, closedTurns, tailMarkerHits, sha256: hash.digest('hex'),
  };
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv);
  const file = args.out || path.join(os.tmpdir(), 'v05-gen', 'session.v4.jsonl.zstd');
  if (args.verify) {
    const t0 = Date.now();
    const v = verifyBigSession({ file, minTurns: Number(args['min-turns'] || 0), minMB: Number(args['min-mb'] || 0) });
    console.log(JSON.stringify({ ...v, durationMs: Date.now() - t0 }, null, 2));
    process.exit(v.ok ? 0 : 1);
  }
  const gen = generateBigSession({
    out: file,
    turns: args.turns ? Number(args.turns) : 0,
    targetMB: Number(args['uncompressed-mb'] || args['target-mb'] || 36),
    batchTurns: Number(args['batch-turns'] || 10),
    sid: args['session-id'] || DEFAULT_SID,
  });
  const v = verifyBigSession({ file, minTurns: gen.turns, minMB: Number(args['uncompressed-mb'] || args['target-mb'] || 36) });
  console.log(JSON.stringify({ generate: gen, verify: v }, null, 2));
  process.exit(gen.ok && v.ok ? 0 : 1);
}
