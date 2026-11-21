#!/usr/bin/env node
/**
 * @file 自测-审计修复-P0.mjs
 * @role lite 线 v1.0.0-re 两处审计修复的**可实跑**自测（K-4 机主已签字）：
 *       ① P0 LED-01：坏帧/半尾帧导致"已解出的轮次被整批丢弃 + 游标卡 EOF"→ 永久漏记；
 *       ② M-01：v3-only 会话日期段取错（头 createdAt 晚于首轮）→ code[0:8] > ts 本地日。
 * @called-by 人工/验收（不改产品代码，只在临时 lab 里跑 runOnce）
 *
 * 用法（在仓库根执行）：
 *   node docs\自测-审计修复-P0.mjs                 # 默认：frames/ledger 单元 + P0 全链路 lab + M-01 lab
 *   node docs\自测-审计修复-P0.mjs --corpus        # 另跑全量语料 17 文件 × 5 tick（较重的活，只跑一次）
 *   node docs\自测-审计修复-P0.mjs --json          # 机读输出（{checks:[...], summary:{...}}）
 *
 * 参数（v1.0.0 整改：默认全部自足，**不再依赖开发机 `<repo>\..` 或桌面语料**）：
 *   --fixture=<path>    P0 用的完整会话字节（默认 = 本脚本在 os.tmpdir() 里**合成**的 6 轮会话）
 *   --lab=<dir>         P0 lab 目录（默认 <tmpdir>/dsh-selftest-p0-…/lab-k4-p0；会被清空 root/dsh-home）
 *   --m01-lab=<dir>     M-01 lab 目录（默认 <tmpdir>/…/lab-k4-m01）
 *   --corpus-src=<dir>  全量语料 sessions 目录（默认包内/同级 `02-语料/sessions`；都没有则只在 --corpus 时报可读错误）
 *   --corpus-lab=<dir>  全量语料 lab（默认 <tmpdir>/…/lab-k4-corpus）
 *   --corpus-ticks=N    全量语料跑几 tick（默认 5）
 *   --keep              保留本次临时 lab（默认跑完删除；路径会打印）
 *   --clean             兼容旧参数（现在默认就清理）
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeFramesFrom, frameSpan, readFrameHeader, streamFrames, ZSTD_MAGIC } from '../lib/frames.js';
import { readAll, readState, readLost, readTurnsFrom } from '../lib/ledger.js';

// ────────────────────────── 0. 小工具 ──────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (k, dflt = '') => {
  const hit = argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  if (!hit) return dflt;
  if (hit === `--${k}`) return '1';
  return hit.slice(k.length + 3);
};
const has = (k) => argv.includes(`--${k}`);
const asJson = has('json');
const wantCorpus = has('corpus');

const checks = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  checks.push({ name, ok, detail: detail == null ? '' : String(detail) });
  if (!ok) checks[checks.length - 1].failedAt = new Error('assert').stack.split('\n')[2] || '';
  return ok;
}
function note(msg) {
  if (!asJson) console.log(msg);
}
function section(title) {
  if (!asJson) console.log('\n=== ' + title + ' ===');
}
function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 本地日（YYYYMMDD）：ts 形如 2026-11-08T09:00:01+08:00（isoTime 已按 offsetMinutes 输出）。 */
function localDayOfTs(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(String(ts || ''));
  return m ? m[1] + m[2] + m[3] : '';
}

/** 安全地清空 lab 下的 root/dsh-home（绝不碰仓库本身）。 */
function resetLabDir(labDir) {
  const abs = path.resolve(labDir);
  // ★ v1.0.0-re3 异机复现修复（E-P0-9）：**跨盘**时 `path.relative` 返回的是**绝对路径**
  //   （如包在 D:\、lab 在 C:\Users\…\Temp\…），旧判据 `!rel.startsWith('..')` 因此为真 →
  //   把库外 lab 误判成"仓库内"→ 三个 lab 全被拒 → 20 项里 3 项 FAIL。
  //   判据与包内同口径实现对齐（tools\backup.mjs:213 / docs\replay-verify.mjs:1460 /
  //   docs\工具-设备自检.mjs:284）：rel 为绝对路径 ⇒ 不同盘符 ⇒ 必在仓库外。
  const rel = path.relative(REPO, abs);
  const insideRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (insideRepo) {
    throw new Error('拒绝清空仓库内目录: ' + abs);
  }
  for (const sub of ['root', 'dsh-home']) {
    fs.rmSync(path.join(abs, sub), { recursive: true, force: true });
    fs.mkdirSync(path.join(abs, sub), { recursive: true });
  }
  return abs;
}

function mkZstd(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

// ── v1.0.0 整改（P0-03 / P1-14 / P1-17）：夹具自足 ────────────────────────────
//   · 所有 lab 落在 os.tmpdir() 下 → 不再往 `<repo>\..` 写 lab-k4-*（审计 P1-17）；
//   · P0 会话字节不再依赖开发机 `..\lab-led01b\orig.bin` → 本函数**合成**
//     「6 个完整轮 + 尾部第 7 轮 start 帧」；截断 20B 正好切掉最后一帧 → 复现 LED-01。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selftest-p0-'));
function synthP0Fixture(sid = 'session-44671553-2f37-3b8f-7c73-80601d9ef2f9', createdAt = Date.parse('2026-11-08T08:00:00+08:00')) {
  const line = (o) => JSON.stringify(o) + '\n';
  let seq = 0;
  const ev = (type, data, time) => ({ type, seq: seq++, time, data });
  const turn = (n, t0) => line(ev('turn/start', { turn: n }, t0)) +
    line(ev('user/message', { content: [{ type: 'text', text: `第 ${n} 轮` }], source: { kind: 'user' }, role: 'user' }, t0 + 1)) +
    line(ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: `答 ${n}` }] } }, t0 + 2)) +
    line(ev('turn/end', { turn: n, reason: { kind: 'completed' } }, t0 + 3));
  const head = { type: 'session', version: 4, id: sid, createdAt, cwd: 'C:\\v05-lab' };
  const parts = [mkZstd(line(head) + turn(1, createdAt))];
  for (let n = 2; n <= 6; n += 1) parts.push(mkZstd(turn(n, createdAt + n * 1000)));
  // 第 7 帧：一个**不开启新轮**的尾事件（step/start；被截断 20B 时正好是"坏尾帧"）。
  //   用它而不是 turn/start：恢复后游标要能走到 EOF（不留开放轮），与原夹具口径一致。
  parts.push(mkZstd(line(ev('step/start', { turn: 6, step: 0 }, createdAt + 7000))));
  return Buffer.concat(parts);
}
function ensureFixture() {
  const p = path.join(TMP_ROOT, 'orig-led01b.bin');
  if (!fs.existsSync(p)) fs.writeFileSync(p, synthP0Fixture());
  return p;
}

let pluginPromise = null;
async function loadPlugin() {
  if (!pluginPromise) {
    pluginPromise = import(pathToFileURL(path.join(REPO, 'index.js')).href);
  }
  return pluginPromise;
}

const silentLogger = { info() {}, warn() {}, error() {} };

/** 跑 n 个 tick，返回每 tick 的 stat（异常转成 {crashed}）。 */
async function runTicks(n, cfg) {
  const idx = await loadPlugin();
  const out = [];
  for (let i = 1; i <= n; i++) {
    try {
      out.push(await idx.runOnce({ logger: silentLogger }, cfg));
    } catch (e) {
      out.push({ crashed: true, errors: ['runOnce crashed: ' + (e && e.stack ? e.stack : String(e))], written: 0 });
    }
  }
  return out;
}

function cursorOf(root, file) {
  const st = readState(root);
  const cursors = st && st.sourceCursors && typeof st.sourceCursors === 'object' ? st.sourceCursors : {};
  return cursors[file] || null;
}

function ledgerSummary(root) {
  const all = readAll(root);
  const codes = new Set();
  const sidTurns = new Set();
  let dateViolations = 0;
  const samples = [];
  for (const r of all.records) {
    if (r && typeof r.code === 'string') codes.add(r.code);
    if (r && typeof r.sid === 'string' && Number.isInteger(r.turn)) sidTurns.add(r.sid + '#' + r.turn);
    const c8 = String((r && r.code) || '').slice(0, 8);
    const day = localDayOfTs(r && r.ts);
    if (!/^\d{8}$/.test(c8) || !day || c8 > day) {
      dateViolations++;
      if (samples.length < 8) samples.push({ code: r && r.code, ts: r && r.ts, c8, day });
    }
  }
  return {
    rows: all.records.length,
    uniqueCodes: codes.size,
    uniqueSidTurns: sidTurns.size,
    badLines: all.badLines,
    readErrors: all.readErrors,
    dateViolations,
    dateViolationSamples: samples,
    records: all.records,
  };
}

// ────────────────────────── 1. frames / ledger 单元 ──────────────────────────
async function unitFramesAndLedger() {
  section('1. frames 层（K-4）：结构分帧 / magic-in-payload / 半尾帧 / 中间坏帧');

  const tmp = fs.mkdtempSync(path.join(REPO, '.k4tmp-'));
  try {
    // ① 合法帧的载荷里恰好含 zstd 魔数：结构分帧不得误判（旧实现按魔数切帧会解压失败）
    {
      const payload = Buffer.concat([ZSTD_MAGIC, Buffer.from('PAYLOAD-OK', 'utf8')]);
      const fhd = 0x20; // FCS_flag=0、Single_Segment=1、checksum=0 → 头后 1 字节 FCS
      const fcs = Buffer.from([payload.length & 0xff]);
      const headVal = 1 | (0 << 1) | (payload.length << 3); // last=1, raw block
      const bh = Buffer.from([headVal & 0xff, (headVal >> 8) & 0xff, (headVal >> 16) & 0xff]);
      const rawFrame = Buffer.concat([ZSTD_MAGIC, Buffer.from([fhd]), fcs, bh, payload]);
      const normal = mkZstd('text-after-magic');
      const f = path.join(tmp, 'magic-in-payload.bin');
      fs.writeFileSync(f, Buffer.concat([rawFrame, normal]));

      // 结构帧长：rawFrame 恰为 4+1+1+3+payload
      const span = frameSpan(Buffer.concat([rawFrame, normal]), 0);
      check('magic-in-payload：frameSpan 按结构算长度（不吃载荷里的魔数）',
        span.ok && span.end === rawFrame.length, JSON.stringify(span));
      const hdr = readFrameHeader(rawFrame, 0);
      check('magic-in-payload：帧头解析（FCS=1 字节、single_segment）',
        hdr.ok && hdr.fcsBytes === 1 && hdr.fcs === payload.length, JSON.stringify(hdr));

      const r = decodeFramesFrom(f, 0);
      check('magic-in-payload：2 帧全部解出（旧实现会把载荷魔数当新帧 → failed>0）',
        r.frames === 2 && r.ok === 2 && r.failed === 0 && r.halted === false,
        JSON.stringify({ frames: r.frames, ok: r.ok, failed: r.failed, halted: r.halted }));
      check('magic-in-payload：载荷内容逐字还原（魔数字节仍在数据里）',
        r.parts[0] && r.parts[0].text.includes('PAYLOAD-OK') && r.parts[1].text === 'text-after-magic',
        JSON.stringify(r.parts.map((p) => p.text.slice(0, 20))));
    }

    // ② 半尾帧：好帧 + 截断 20 字节的坏尾帧 → 停在坏帧起点，不推到 EOF
    {
      const f1 = mkZstd('head-frames-a');
      const f2 = mkZstd('tail-frame-b-0123456789');
      const f = path.join(tmp, 'half-tail.bin');
      fs.writeFileSync(f, Buffer.concat([f1, f2.subarray(0, f2.length - 20)]));
      const size = fs.statSync(f).size;
      const r = decodeFramesFrom(f, 0);
      check('半尾帧：halted=true 且 stopReason=truncated-tail',
        r.halted === true && r.stopReason === 'truncated-tail',
        JSON.stringify({ halted: r.halted, stopReason: r.stopReason }));
      check('半尾帧：停止位置=坏帧起点（不是文件尾）',
        r.haltOffset === f1.length && r.haltOffset !== size,
        JSON.stringify({ haltOffset: r.haltOffset, size, f1: f1.length }));
      check('半尾帧：已解出的帧照常交付（parts 只含好帧）',
        r.ok === 1 && r.parts.length === 1 && r.parts[0].text === 'head-frames-a',
        JSON.stringify({ ok: r.ok, parts: r.parts.map((p) => p.text) }));
      check('半尾帧：坏帧区间可复算 [坏帧起点, 文件尾)',
        r.failedRanges.length === 1 && r.failedRanges[0].start === f1.length && r.failedRanges[0].end === size,
        JSON.stringify(r.failedRanges));
    }

    // ③ 中间坏帧（魔数+垃圾）：坏帧两侧好帧都要解出，haltOffset 指坏帧起点，坏帧区间精确
    {
      const f1 = mkZstd('AAA');
      const bad = Buffer.concat([ZSTD_MAGIC, Buffer.from('not-a-zstd-frame', 'utf8')]);
      const f3 = mkZstd('BBB');
      const f = path.join(tmp, 'mid-bad.bin');
      fs.writeFileSync(f, Buffer.concat([f1, bad, f3]));
      const r = decodeFramesFrom(f, 0);
      check('中间坏帧：两侧好帧都解出（一帧坏不拖垮整轮）',
        r.ok === 2 && r.parts.map((p) => p.text).join(',') === 'AAA,BBB',
        JSON.stringify({ ok: r.ok, parts: r.parts.map((p) => p.text) }));
      check('中间坏帧：halted / haltOffset / 坏帧精确区间',
        r.halted === true && r.haltOffset === f1.length &&
        r.failedRanges.length === 1 && r.failedRanges[0].start === f1.length &&
        r.failedRanges[0].end === f1.length + bad.length && r.stopReason === 'bad-frame',
        JSON.stringify({ haltOffset: r.haltOffset, reason: r.stopReason, ranges: r.failedRanges }));
    }

    // ⑤ 超大单帧（P1-3 原契约）：超过 maxFrameBytes → 跳过并继续，不 halted、不判死会话
    {
      const big = zlib.zstdCompressSync(crypto.randomBytes(20000));
      const f = path.join(tmp, 'oversized.bin');
      fs.writeFileSync(f, Buffer.concat([mkZstd('AAA'), big, mkZstd('BBB')]));
      const got = [];
      const st = streamFrames(f, 0, (text) => got.push(text.trim()), { windowBytes: 512, maxFrameBytes: 2000 });
      check('超大单帧：skipped>=1 且不把整份会话判死（badMagic=false）',
        st.skipped >= 1 && st.badMagic === false,
        JSON.stringify({ skipped: st.skipped, badMagic: st.badMagic, failed: st.failed }));
      check('超大单帧：不 halted / 无 haltOffset（超大 ≠ 坏帧，K-4 只针对真坏帧）',
        st.halted === false && st.haltOffset === 0,
        JSON.stringify({ halted: st.halted, haltOffset: st.haltOffset, stopReason: st.stopReason }));
      check('超大单帧：前后帧都解出（跳过并继续）',
        got.length === 2 && got[0] === 'AAA' && got[1] === 'BBB',
        JSON.stringify(got));
      check('超大单帧：loss 区间带 oversized 标记（可复算/可统计）',
        st.failedRanges.length === 1 && st.failedRanges[0].oversized === true,
        JSON.stringify(st.failedRanges));
    }

    // ⑥ ledger 出口：坏帧时 closed 照常返回 + nextOffset=坏帧起点 + 不把已解出数据清空
    {
      const head = { type: 'session', id: 'session-aaaaaaaabbbb', createdAt: 1794067200000 };
      const ev = (o) => JSON.stringify(o);
      const frames = [
        mkZstd(ev(head) + '\n' + ev({ type: 'turn/start', time: 1794067201000, data: { turn: 1 } }) + '\n'),
        // 中间帧真的坏：魔数 + 垃圾（结构不可解析 → 读取层按坏帧处理，不是"坏 JSON 行"）
        Buffer.concat([ZSTD_MAGIC, Buffer.from('not-a-zstd-frame-in-the-middle', 'utf8')]),
        mkZstd(ev({ type: 'turn/end', time: 1794067202000, data: { turn: 1 } }) + '\n' +
          ev({ type: 'turn/start', time: 1794067203000, data: { turn: 2 } }) + '\n' +
          ev({ type: 'turn/end', time: 1794067204000, data: { turn: 2 } }) + '\n'),
      ];
      const f = path.join(tmp, 'ledger-mid-bad.v4.jsonl.zstd');
      fs.writeFileSync(f, Buffer.concat(frames));
      const r = readTurnsFrom(f, {});
      check('ledger：坏帧时已解出的闭合轮照常返回（不被清空）',
        r.closed.length === 2 && r.closed[0].turn === 1 && r.closed[1].turn === 2,
        JSON.stringify(r.closed.map((t) => t.turn)));
      // ★ v1.0.0-re3 · K-14（w-lockledger 最终契约，已合入 lib\ledger.js）：
      //   坏帧 halt 时 `nextOffset = min(haltOffset, 所有"在 halt 之前开始、且未在 halt 之前闭合"的轮
      //   的最小 startByte)`；"未在 halt 之前闭合" = 无 endByte 或 endByte ≥ haltOffset
      //   （① 扫描结束时仍 open 的轮；② **已闭合但跨坏帧**的轮）。
      //   本夹具是第②类：turn1 的 start 在帧 A（0）、end 在坏帧**之后**（endByte = 帧 C 起点 > badStart）
      //   → 期望 nextOffset=0（不是 haltOffset），否则源修好后从 106 续读只剩 turn/end，该轮补不回来。
      //   证据字段（只加不改）：cursorClamped / cursorClampByte / haltBoundaryTurns / openTurnStartByte。
      const badStart = frames[0].length;
      const badEnd = frames[0].length + frames[1].length;
      const boundaryTurns = Array.isArray(r.meta.haltBoundaryTurns) ? r.meta.haltBoundaryTurns : [];
      const minBoundaryStart = boundaryTurns.length ? Math.min(...boundaryTurns.map((t) => t.startByte)) : null;
      const expectNext = minBoundaryStart === null ? r.meta.haltOffset : Math.min(r.meta.haltOffset, minBoundaryStart);
      check('ledger：坏帧 halt 时游标收窄到"跨坏帧轮"起点（K-14：blocked=true / haltOffset=坏帧起点 / nextOffset=min(haltOffset, 边界轮 startByte)=0）',
        r.meta.blocked === true && r.meta.halted === true &&
        r.meta.haltOffset === badStart &&
        r.meta.nextOffset === expectNext && r.meta.nextOffset === 0 &&
        r.meta.nextOffset <= r.meta.haltOffset && r.meta.nextOffset !== r.meta.size &&
        r.meta.cursorClamped === true && r.meta.cursorClampByte === 0 &&
        r.meta.openTurnStartByte === null &&
        boundaryTurns.length === 1 && boundaryTurns[0].turn === 1 &&
        boundaryTurns[0].startByte === 0 && boundaryTurns[0].endByte === badEnd,
        JSON.stringify({
          blocked: r.meta.blocked, halted: r.meta.halted, haltOffset: r.meta.haltOffset,
          nextOffset: r.meta.nextOffset, size: r.meta.size, expectNext,
          cursorClamped: r.meta.cursorClamped, cursorClampByte: r.meta.cursorClampByte,
          openTurnStartByte: r.meta.openTurnStartByte, haltBoundaryTurns: boundaryTurns, badEnd,
        }));
      check('ledger：loss 结构化（failedRanges/failedOffsets/reasons 可复算）',
        r.loss.hasGap === true && r.loss.failedRanges.length === 1 &&
        r.loss.failedRanges[0].start === frames[0].length && r.loss.failedOffsets[0] === frames[0].length &&
        r.loss.reasons.includes('failed-frames'),
        JSON.stringify({ reasons: r.loss.reasons, ranges: r.loss.failedRanges }));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ────────────────────────── 2. P0 LED-01 全链路 lab ──────────────────────────
async function p0Lab(labDir, fixturePath) {
  section('2. P0 LED-01 全链路：尾帧截断 20B → 恢复后不重复、不坏行、游标不卡 EOF');

  if (!fs.existsSync(fixturePath)) {
    check('P0 lab：夹具存在', false, '找不到 ' + fixturePath);
    return;
  }
  const full = fs.readFileSync(fixturePath);
  const truncLen = 20;
  const truncSize = full.length - truncLen;
  const fullFileTmp = path.join(labDir, 'orig-full.bin');
  fs.mkdirSync(labDir, { recursive: true });
  fs.writeFileSync(fullFileTmp, full);
  const fullFrames = decodeFramesFrom(fullFileTmp, 0);
  const lastFrameStart = fullFrames.parts.length ? fullFrames.parts[fullFrames.parts.length - 1].start : -1;
  const expectHalt = lastFrameStart >= truncSize ? -1 : lastFrameStart; // 截断点=被截断的尾帧起点

  resetLabDir(labDir);
  fs.writeFileSync(fullFileTmp, full);
  const dsh = path.join(labDir, 'dsh-home');
  const root = path.join(labDir, 'root');
  const sid = 'session-44671553-2f37-3b8f-7c73-80601d9ef2f9';
  const sessDir = path.join(dsh, 'sessions', '--synthetic-workspace--', sid);
  fs.mkdirSync(sessDir, { recursive: true });
  const sessFile = path.join(sessDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(sessFile, full.subarray(0, truncSize));

  process.env.DSH_HOME = dsh;
  const idx = await loadPlugin();
  const cfg = idx.__test__.readConfig({ root, enabled: true });

  // ── tick 1：源是截断的 ──
  const [t1] = await runTicks(1, cfg);
  const l1 = ledgerSummary(root);
  const c1 = cursorOf(root, sessFile);
  const lost1 = readLost(root);
  check('P0 tick1：已解出的 6 轮全部落账（旧实现 written=0 整批丢弃）',
    (t1.written || 0) === 6 && l1.rows === 6,
    JSON.stringify({ written: t1.written, rows: l1.rows, errors: (t1.errors || []).slice(0, 3) }));
  check('P0 tick1：坏帧错误可见（errors 含 source blocked + truncated-tail + retryable）',
    (t1.errors || []).some((e) => /source blocked/.test(e) && /truncated-tail/.test(e) && /retryable=true/.test(e)),
    JSON.stringify((t1.errors || []).slice(0, 5)));
  check('P0 tick1：游标停在前缀末尾（>0 且 < 截断后大小，不是 EOF）',
    c1 && Number.isInteger(c1.offset) && c1.offset > 0 && c1.offset < truncSize && c1.blocked === true,
    JSON.stringify(c1 && { size: c1.size, offset: c1.offset, blocked: c1.blocked, haltOffset: c1.haltOffset }));
  check('P0 tick1：游标记录的 haltOffset=被截断帧起点（可重试点）',
    c1 && c1.haltOffset === expectHalt,
    JSON.stringify({ cursorHalt: c1 && c1.haltOffset, expectHalt }));
  check('P0 tick1：.lost.jsonl 一条，写清文件/偏移/原因/可重试/可复算区间',
    lost1.records.length === 1 &&
    lost1.records[0].file === sessFile &&
    lost1.records[0].retryable === true &&
    lost1.records[0].reasons.includes('failed-frames') &&
    lost1.records[0].reasons.includes('truncated-tail') &&
    lost1.records[0].missing.length === 1 &&
    lost1.records[0].missing[0].start === expectHalt &&
    lost1.records[0].missing[0].end === truncSize &&
    isHex64(lost1.records[0].missing[0].sha256),
    JSON.stringify({ n: lost1.records.length, rec: lost1.records[0] && {
      file: lost1.records[0].file === sessFile, retryable: lost1.records[0].retryable,
      reasons: lost1.records[0].reasons, missing: lost1.records[0].missing,
    } }));

  // ── tick 2：源仍未修（同大小）→ 不新写、错误仍每 tick 可见、游标不前进 ──
  const [t2] = await runTicks(1, cfg);
  const l2 = ledgerSummary(root);
  const c2 = cursorOf(root, sessFile);
  check('P0 tick2（未修复）：不重复写（written=0、仍是 6 行）',
    (t2.written || 0) === 0 && l2.rows === 6 && l2.uniqueCodes === 6,
    JSON.stringify({ written: t2.written, rows: l2.rows, unique: l2.uniqueCodes }));
  check('P0 tick2（未修复）：错误仍每 tick 可见（不许静默）',
    (t2.errors || []).some((e) => /source blocked/.test(e)),
    JSON.stringify((t2.errors || []).slice(0, 4)));
  check('P0 tick2（未修复）：游标原地（不前进、不跳 EOF）',
    c2 && Number.isInteger(c2.offset) && c2.offset < truncSize &&
    (!c1 || c2.offset === c1.offset),
    JSON.stringify({ tick1: c1 && c1.offset, tick2: c2 && c2.offset, size: truncSize }));

  // ── tick 3：恢复完整文件 → 断点续记、不重复 ──
  fs.writeFileSync(sessFile, full);
  const utime = new Date(Date.now() + 1500);
  fs.utimesSync(sessFile, utime, utime);
  const [t3] = await runTicks(1, cfg);
  const l3 = ledgerSummary(root);
  const c3 = cursorOf(root, sessFile);
  check('P0 恢复后 1 tick：6 行全部在账（0 重复、0 坏行）',
    l3.rows === 6 && l3.uniqueCodes === 6 && l3.uniqueSidTurns === 6 && l3.badLines === 0,
    JSON.stringify({ rows: l3.rows, uniqueCodes: l3.uniqueCodes, uniqueSidTurns: l3.uniqueSidTurns, badLines: l3.badLines }));
  check('P0 恢复后 1 tick：游标到 EOF（size），不再 blocked',
    c3 && c3.offset === full.length && c3.size === full.length && c3.blocked !== true,
    JSON.stringify(c3 && { size: c3.size, offset: c3.offset, blocked: c3.blocked }));
  check('P0 恢复后：错误消失（不再 source blocked）',
    !(t3.errors || []).some((e) => /source blocked/.test(e)),
    JSON.stringify((t3.errors || []).slice(0, 4)));
  check('P0 恢复后：落账码唯一（无重号）',
    new Set(l3.records.map((r) => r.code)).size === l3.records.length && l3.records.length === 6,
    JSON.stringify(l3.records.map((r) => r.code)));

  // ── tick 4：源没变 → 安静（无新增、无错误） ──
  const [t4] = await runTicks(1, cfg);
  const l4 = ledgerSummary(root);
  check('P0 tick4：源没变时安静（written=0、6 行、0 错误）',
    (t4.written || 0) === 0 && l4.rows === 6 && (t4.errors || []).length === 0,
    JSON.stringify({ written: t4.written, rows: l4.rows, errors: (t4.errors || []).slice(0, 4) }));

  if (has('clean')) fs.rmSync(path.join(labDir, 'root'), { recursive: true, force: true });
  return { rows: l3.rows, haltOffset: expectHalt, cursorAfterRestore: c3 && c3.offset };
}

// ────────────────────────── 2b. 坏帧跨越轮次（straddle）──────────────────────────
async function straddleLab(labDir) {
  section('2b. 坏帧跨越轮次：不落"半轮"，游标退回该轮起点，修复后补齐');

  resetLabDir(labDir);
  const dsh = path.join(labDir, 'dsh-home');
  const root = path.join(labDir, 'root');
  const sid = 'session-11112222-3333-4444-8555-666677778888';
  const sessDir = path.join(dsh, 'sessions', '--lab-k4-straddle--', sid);
  fs.mkdirSync(sessDir, { recursive: true });
  const f = path.join(sessDir, 'session.v4.jsonl.zstd');
  const line = (o) => JSON.stringify(o) + '\n';
  const ev = (o) => line(o);
  const head = { type: 'session', id: sid, createdAt: 1794067200000 };
  // 帧 A：头 + turn1 start（turn1 的 start 在坏帧之前）
  const frameA = mkZstd(
    ev(head) +
    ev({ type: 'turn/start', time: 1794067201000, data: { turn: 1 } })
  );
  // 帧 B：坏帧（结构不可解析）
  const frameB = Buffer.concat([ZSTD_MAGIC, Buffer.from('not-a-zstd-frame-cross', 'utf8')]);
  // 帧 C：turn1 end + turn2 全轮（turn1 的 end 在坏帧之后 → 这一轮**跨越**坏帧）
  const frameC = mkZstd(
    ev({ type: 'turn/end', time: 1794067202000, data: { turn: 1, reason: { kind: 'stop' } } }) +
    ev({ type: 'turn/start', time: 1794067203000, data: { turn: 2 } }) +
    ev({ type: 'turn/end', time: 1794067204000, data: { turn: 2, reason: { kind: 'stop' } } })
  );
  fs.writeFileSync(f, Buffer.concat([frameA, frameB, frameC]));

  process.env.DSH_HOME = dsh;
  const idx = await loadPlugin();
  const cfg = idx.__test__.readConfig({ root, enabled: true });

  const [t1] = await runTicks(1, cfg);
  const l1 = ledgerSummary(root);
  const turns1 = l1.records.map((r) => r.turn).sort((a, b) => a - b);
  check('跨坏帧轮次：坏的这一轮（turn1）不落半轮（账里只有 turn2）',
    turns1.length === 1 && turns1[0] === 2,
    JSON.stringify({ turns: turns1, written: t1.written }));
  check('跨坏帧轮次：deferred 记数 + errors 说清（不静默）',
    (t1.deferredTurns || 0) >= 1 &&
    (t1.errors || []).some((e) => /turns straddle bad frame/.test(e)) &&
    (t1.errors || []).some((e) => /source blocked/.test(e)),
    JSON.stringify({ deferredTurns: t1.deferredTurns, errors: (t1.errors || []).slice(0, 4) }));
  const c1 = cursorOf(root, f);
  check('跨坏帧轮次：游标不越过坏帧（无游标 = 从 0 重试；有游标则必须 ≤ 该轮 startByte）',
    !c1 || !Number.isInteger(c1.offset) || c1.offset === 0,
    JSON.stringify(c1 && { offset: c1.offset, haltOffset: c1.haltOffset }));

  // 修复：坏帧换成合法帧（turn1 的中间事件），文件大小改变 → 重新读到 turn1
  const repairedB = mkZstd(ev({ type: 'tool/result', time: 1794067201500, data: { turn: 1, id: 'x' } }));
  fs.writeFileSync(f, Buffer.concat([frameA, repairedB, frameC]));
  const utime = new Date(Date.now() + 1500);
  fs.utimesSync(f, utime, utime);
  const [t2] = await runTicks(1, cfg);
  const l2 = ledgerSummary(root);
  const turns2 = l2.records.map((r) => r.turn).sort((a, b) => a - b);
  const c2 = cursorOf(root, f);
  check('跨坏帧轮次·修复后：turn1 补齐（2 行、唯一）',
    l2.rows === 2 && turns2[0] === 1 && turns2[1] === 2 && l2.uniqueCodes === 2,
    JSON.stringify({ turns: turns2, rows: l2.rows, written: t2.written }));
  check('跨坏帧轮次·修复后：错误消失、游标到 EOF',
    !(t2.errors || []).some((e) => /source blocked/.test(e)) &&
    c2 && c2.offset === fs.statSync(f).size,
    JSON.stringify({ errors: (t2.errors || []).slice(0, 3), cursor: c2 && c2.offset, size: fs.statSync(f).size }));
  return { turnsBefore: turns1, turnsAfter: turns2, rowsAfter: l2.rows };
}

// ────────────────────────── 3. M-01 v3-only 日期段 ──────────────────────────
async function m01Lab(labDir) {
  section('3. M-01：v3-only 会话日期段取最早可信时刻（头 createdAt 不可信）');

  resetLabDir(labDir);
  const dsh = path.join(labDir, 'dsh-home');
  const root = path.join(labDir, 'root');
  const sid = 'session-62d9d7c3-5b6f-1996-761b-b29c05271a34';
  const sessDir = path.join(dsh, 'sessions', '--synthetic-workspace--', sid);
  fs.mkdirSync(sessDir, { recursive: true });
  const v3 = path.join(sessDir, 'session.v3.jsonl.zstd');

  // 头 createdAt = 2026-11-10（晚于两轮）；首轮 2026-11-08、次轮 2026-11-09（跨日会话）
  const ms = (iso) => Date.parse(iso);
  const head = { type: 'session', id: sid, createdAt: ms('2026-11-10T09:00:00+08:00'), version: 3 };
  const t1s = { type: 'turn/start', time: ms('2026-11-08T09:00:01+08:00'), data: { turn: 1 } };
  const t1e = { type: 'turn/end', time: ms('2026-11-08T09:00:02+08:00'), data: { turn: 1, reason: { kind: 'stop' } } };
  const t2s = { type: 'turn/start', time: ms('2026-11-09T10:00:01+08:00'), data: { turn: 2 } };
  const t2e = { type: 'turn/end', time: ms('2026-11-09T10:00:02+08:00'), data: { turn: 2, reason: { kind: 'stop' } } };
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(v3, Buffer.concat([
    mkZstd(line(head) + line(t1s)),
    mkZstd(line(t1e)),
    mkZstd(line(t2s) + line(t2e)),
  ]));

  process.env.DSH_HOME = dsh;
  const idx = await loadPlugin();
  const cfg = idx.__test__.readConfig({ root, enabled: true });
  const ticks = await runTicks(2, cfg);
  const l = ledgerSummary(root);

  check('M-01：v3-only 会话两轮都入账', l.rows === 2, JSON.stringify({ rows: l.rows, errors: (ticks[0].errors || []).slice(0, 4) }));
  const codes = l.records.map((r) => String(r.code || ''));
  check('M-01：日期段=首轮最早时刻所在日（20261108，不是头 createdAt 的 20261110）',
    codes.length === 2 && codes.every((c) => c.slice(0, 8) === '20261108'),
    JSON.stringify(codes));
  check('M-01：逐行 code[0:8] <= ts 本地日（审计不变量）',
    l.dateViolations === 0,
    JSON.stringify({ violations: l.dateViolations, samples: l.dateViolationSamples }));
  check('M-01：第二轮那条的 ts 是次日（2026-11-09）而编码日期段仍是 20261108',
    l.records.some((r) => String(r.code).slice(0, 8) === '20261108') &&
    l.records.every((r) => localDayOfTs(r.ts) >= '20261108'),
    JSON.stringify(l.records.map((r) => [r.code, r.ts])));
  return { rows: l.rows, codes };
}

// ────────────────────────── 4. 全量语料（重活，--corpus 才跑） ──────────────────────────
async function corpusLab(labDir, srcDir, ticks) {
  section('4. 全量语料：17 文件 × ' + ticks + ' tick（台账行数 / 唯一 code / 0 坏行 / 日期段不变量）');

  if (!fs.existsSync(srcDir)) {
    check('全量语料：语料目录存在', false, '找不到 ' + srcDir);
    return;
  }
  resetLabDir(labDir);
  const dsh = path.join(labDir, 'dsh-home');
  const root = path.join(labDir, 'root');
  fs.mkdirSync(path.join(dsh, 'sessions'), { recursive: true });
  fs.cpSync(srcDir, path.join(dsh, 'sessions'), { recursive: true, force: true });

  process.env.DSH_HOME = dsh;
  const idx = await loadPlugin();
  const cfg = idx.__test__.readConfig({ root, enabled: true });

  let totalWritten = 0;
  const perTick = [];
  for (let i = 1; i <= ticks; i++) {
    const started = Date.now();
    const [st] = await runTicks(1, cfg);
    const rowsNow = readAll(root).records.length;
    totalWritten += Number(st.written) || 0;
    perTick.push({
      tick: i,
      written: Number(st.written) || 0,
      scanned: st.scanned,
      rowsNow,
      errors: (st.errors || []).length,
      blocked: st.blockedSources,
      deferredTurns: st.deferredTurns,
      ms: Date.now() - started,
    });
    note('  tick ' + i + ': written=' + (Number(st.written) || 0) + ' scanned=' + st.scanned +
      ' rows=' + rowsNow + ' errors=' + (st.errors || []).length + ' deferredTurns=' + (st.deferredTurns || 0));
    if ((st.errors || []).length && !asJson) {
      for (const e of st.errors.slice(0, 3)) note('    err: ' + e);
    }
  }

  const l = ledgerSummary(root);
  note('  汇总: rows=' + l.rows + ' uniqueCodes=' + l.uniqueCodes + ' uniqueSidTurns=' + l.uniqueSidTurns +
    ' badLines=' + l.badLines + ' dateViolations=' + l.dateViolations + ' writtenSum=' + totalWritten);

  check('全量语料：台账 1,558 行', l.rows === 1558, JSON.stringify({ rows: l.rows }));
  check('全量语料：唯一 code = 1,558', l.uniqueCodes === 1558, JSON.stringify({ uniqueCodes: l.uniqueCodes }));
  check('全量语料：0 坏行', l.badLines === 0, JSON.stringify({ badLines: l.badLines }));
  check('全量语料：written 累计 = 台账行数', totalWritten === l.rows, JSON.stringify({ totalWritten, rows: l.rows }));
  check('全量语料：逐行 code[0:8] <= ts 本地日（违反 0；修前审计实测 54）',
    l.dateViolations === 0, JSON.stringify({ violations: l.dateViolations, samples: l.dateViolationSamples }));
  return { rows: l.rows, uniqueCodes: l.uniqueCodes, dateViolations: l.dateViolations, perTick };
}

// ────────────────────────── 5. main ──────────────────────────
const t0 = Date.now();
const summary = { unit: null, p0: null, straddle: null, m01: null, corpus: null };

const explicitFixture = arg('fixture', '');
const fixturePath = explicitFixture ? path.resolve(explicitFixture) : ensureFixture();
const labDir = path.resolve(arg('lab', path.join(TMP_ROOT, 'lab-k4-p0')));
const straddleDir = path.resolve(arg('straddle-lab', path.join(TMP_ROOT, 'lab-k4-straddle')));
const m01Dir = path.resolve(arg('m01-lab', path.join(TMP_ROOT, 'lab-k4-m01')));
if (!explicitFixture) note('（P0 夹具：本脚本合成 ' + fixturePath + '）');

await unitFramesAndLedger();
summary.unit = true;

try {
  summary.p0 = await p0Lab(labDir, fixturePath);
} catch (e) {
  check('P0 lab 执行', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
}

try {
  summary.straddle = await straddleLab(straddleDir);
} catch (e) {
  check('跨坏帧轮次 lab 执行', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
}

try {
  summary.m01 = await m01Lab(m01Dir);
} catch (e) {
  check('M-01 lab 执行', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
}

if (wantCorpus) {
  // ★ v1.0.0 整改：默认语料改为**包内/同级** `02-语料/sessions`（交付包里的位置），不再依赖桌面路径。
  const corpusCandidates = [
    path.join(REPO, '02-语料', 'sessions'),
    path.join(REPO, '..', '02-语料', 'sessions'),
  ];
  const dfltCorpus = corpusCandidates.find((p) => fs.existsSync(p)) || corpusCandidates[0];
  const src = path.resolve(arg('corpus-src', dfltCorpus));
  const cLab = path.resolve(arg('corpus-lab', path.join(TMP_ROOT, 'lab-k4-corpus')));
  const ticks = Math.max(1, Math.min(20, Number(arg('corpus-ticks', '5')) || 5));
  try {
    summary.corpus = await corpusLab(cLab, src, ticks);
  } catch (e) {
    check('全量语料执行', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  }
}

const failed = checks.filter((c) => !c.ok);
const elapsedMs = Date.now() - t0;
const out = {
  ok: failed.length === 0,
  checks,
  summary,
  elapsedMs,
  env: { node: process.version, repo: REPO, fixture: fixturePath },
};
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('\n=== 结果 ===');
  for (const c of checks) {
    console.log((c.ok ? '[PASS] ' : '[FAIL] ') + c.name + (c.detail && !c.ok ? '  :: ' + c.detail : ''));
  }
  console.log(`\n共 ${checks.length} 项：PASS ${checks.length - failed.length} / FAIL ${failed.length}（${elapsedMs} ms）`);
  console.log(out.ok ? 'SELF-TEST OK' : 'SELF-TEST FAILED');
}
// ★ v1.0.0 整改：默认清掉本次临时 lab（都在 os.tmpdir()，不再往包父目录留数据）。
//   需要留证据时加 --keep；保留时打印路径。
if (!has('keep')) {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
} else if (!asJson) {
  console.log('（--keep：临时 lab 保留在 ' + TMP_ROOT + '）');
}
process.exit(out.ok ? 0 : 1);
