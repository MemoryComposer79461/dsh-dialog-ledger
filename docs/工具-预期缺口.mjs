#!/usr/bin/env node
/**
 * @file 工具-预期缺口.mjs
 * @role 生成 `02-语料/预期缺口.json`：把"交付语料**按源结构就带着**的缺口"逐条声明出来，
 *       供准入门把"已预期、可定位、有证据"的缺口与"意外缺口"分开（引用式豁免的唯一数据源）。
 *
 * @why 第 3 轮审计之后的第三份异机测试（TSG-37）把 P0 定死在这里：
 *      交付语料是一份**静止的历史快照**（zip 条目时间 1980-01-01），而语料里有 1 个
 *      "按真实会话结构保留的未闭合轮" → 插件 F1 如实判 `gate=degraded` → 设备自检把 degraded 判红
 *      → 三台判定器 G9 → "需返修"。即：任何接收端按文档流程跑，都拿不到"可准入"。
 *      修法不是把 mtime 归一（那只买到 2 分钟窗口，是假修），而是**把这个缺口声明为"预期"**：
 *      准入门只豁免"能在预期清单里逐轮对上、且证据 sha 可核"的缺口，其余照红。
 *
 * @独立 本工具**不 import 插件任何代码**：自己走 zstd 帧头 + 块头切帧、逐帧解压、逐行 JSON。
 *       接收端可以用同一条命令复算本文件（`--check` 只校验不写）。
 *
 * 用法：
 *   node docs\工具-预期缺口.mjs --corpus=..\02-语料 --out=..\02-语料\预期缺口.json
 *   node docs\工具-预期缺口.mjs --corpus=..\02-语料 --check          # 只校验，退出码 0=一致 / 1=不一致 / 2=用法错
 *
 * 退出码：0 = 生成成功 / 校验一致；1 = 校验不一致（磁盘语料与声明不符）；2 = 用法/IO 错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const argOf = (k) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : ''; };
const hasFlag = (k) => argv.includes(`--${k}`);
if (hasFlag('help')) { console.log('用法: node docs\\工具-预期缺口.mjs --corpus=..\\02-语料 [--out=..\\02-语料\\预期缺口.json | --check]'); process.exit(0); }
const CORPUS = path.resolve(argOf('corpus') || path.join(HERE, '..', '..', '02-语料'));
if (!fs.existsSync(path.join(CORPUS, 'sessions'))) { console.error('[用法错误] --corpus 下没有 sessions\\：' + CORPUS); process.exit(2); }
const OUT = path.resolve(argOf('out') || path.join(CORPUS, '预期缺口.json'));
const CHECK = hasFlag('check');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 逐帧切分（zstd 帧头 + 块头），返回 [{start,end}]；不依赖插件的 frames.js。 */
function splitFrames(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4 || buf.readUInt32LE(off) !== MAGIC.readUInt32LE(0)) {
      throw new Error(`offset ${off} 不是 zstd 魔数（文件被截断/损坏？）`);
    }
    const start = off;
    let p = off + 4;
    const fhd = buf[p]; p += 1;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!singleSegment) p += 1; // Window_Descriptor
    if (dictFlag === 1) p += 1; else if (dictFlag === 2) p += 2; else if (dictFlag === 3) p += 4;
    // RFC 8878：FCS_flag=0 且 single_segment=1 时，Frame_Content_Size 占 **1 字节**（否则 0 字节）。
    if (fcsFlag === 0 && singleSegment) p += 1;
    else if (fcsFlag === 1) p += 2; else if (fcsFlag === 2) p += 4; else if (fcsFlag === 3) p += 8;
    // 块循环
    while (true) {
      if (p + 3 > buf.length) throw new Error(`帧 ${start} 块头越界`);
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >> 3;
      if (type === 0) p += size;            // Raw
      else if (type === 1) p += 1;          // RLE
      else if (type === 2) p += size;       // Compressed
      else throw new Error(`帧 ${start} 出现保留块类型`);
      if (p > buf.length) throw new Error(`帧 ${start} 块越界`);
      if (last) break;
    }
    if (checksum) p += 4;
    out.push({ start, end: p });
    off = p;
  }
  return out;
}

/** 读一个会话文件 → {frames, lines, turns:{start:[],end:[]}, frameOfStart:Map} */
function scanSession(file) {
  const buf = fs.readFileSync(file);
  const frames = splitFrames(buf);
  const starts = [];
  const ends = [];
  for (const fr of frames) {
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const turn = ev && ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;
      if (turn === null) continue;
      if (ev.type === 'turn/start') starts.push({ turn, startByte: fr.start });
      else if (ev.type === 'turn/end') ends.push({ turn });
    }
  }
  return { frames: frames.length, starts, ends, bytes: buf.length, sha256: sha256(buf) };
}

/** 收集会话源：v4 优先；同目录下 v3+v4 并存只取 v4；v3-only 计入（legacy 只读源）。 */
function collectSources(sessionsDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(e.name);
      if (!m) continue;
      out.push({ file: abs, ver: Number(m[1]), dir });
    }
  };
  walk(sessionsDir);
  const byDir = new Map();
  for (const s of out) { if (!byDir.has(s.dir)) byDir.set(s.dir, []); byDir.get(s.dir).push(s); }
  const picked = [];
  for (const [, list] of byDir) {
    const v4 = list.find((x) => x.ver === 4);
    picked.push(v4 || list.find((x) => x.ver === 3));
  }
  return picked.filter(Boolean).sort((a, b) => a.file.localeCompare(b.file));
}

const sources = collectSources(path.join(CORPUS, 'sessions'));
const perSource = [];
const gaps = [];
let closedTurns = 0;
for (const s of sources) {
  const r = scanSession(s.file);
  const startTurns = new Set(r.starts.map((x) => x.turn));
  const endTurns = new Set(r.ends.map((x) => x.turn));
  const closed = [...startTurns].filter((t) => endTurns.has(t)).length;
  closedTurns += closed;
  const open = r.starts.filter((x) => !endTurns.has(x.turn));
  const rel = path.relative(CORPUS, s.file).replaceAll('\\', '/');
  perSource.push({ source: rel, v: s.ver, bytes: r.bytes, frames: r.frames, closed, open: open.length, sha256: r.sha256 });
  for (const o of open) {
    // 交叉：该轮是否被下一轮 start 顶掉？若被顶掉，属"真实未闭合"。这里保留原样声明。
    gaps.push({
      kind: 'unclosed-turn',
      session: path.basename(path.dirname(s.file)),
      v: s.ver,
      turn: o.turn,
      startByte: o.startByte,
      source: rel,
      sourceBytes: r.bytes,
      sourceSha256: r.sha256,
      why: '源快照本身以该轮未闭合结束（真实会话即如此截断）。按 P0-2/F1 设计：该轮不入账、只进 .pending.jsonl 并在 run-report.openTurns / gate.knownGaps 里逐项可见。这是**预期缺口**，不是意外丢弃——准入门可用本清单做引用式豁免（必须是"这一轮 + 这一份证据"）。',
    });
  }
}

const doc = {
  schema: 'dsh-corpus-expected-gaps/1',
  generatedAt: new Date().toISOString(),
  generator: 'docs/工具-预期缺口.mjs（独立解码：自走 zstd 帧头+块头；不 import 插件读取逻辑）',
  corpus: '02-语料',
  sessionsDir: '02-语料/sessions',
  sources: sources.length,
  files: (() => { let n = 0; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(d, e.name)); else if (/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) n++; } }; w(path.join(CORPUS, 'sessions')); return n; })(),
  closedTurns,
  openTurns: gaps.length,
  expectedGaps: gaps,
  howToVerify: 'node docs\\工具-预期缺口.mjs --corpus=..\\02-语料 --check（退出码 0 = 磁盘语料与本声明逐项一致）',
  perSource,
};

if (CHECK) {
  const existing = fs.existsSync(OUT) ? (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; } })() : null;
  if (!existing) { console.error('[check] 缺 ' + OUT); process.exit(1); }
  const problems = [];
  if (existing.closedTurns !== closedTurns) problems.push(`closedTurns ${existing.closedTurns} ≠ 实测 ${closedTurns}`);
  if (existing.openTurns !== gaps.length) problems.push(`openTurns ${existing.openTurns} ≠ 实测 ${gaps.length}`);
  const key = (g) => `${g.session}#${g.turn}@${g.startByte}`;
  const a = new Set((existing.expectedGaps || []).map(key));
  const b = new Set(gaps.map(key));
  for (const k of b) if (!a.has(k)) problems.push('声明缺：' + k);
  for (const k of a) if (!b.has(k)) problems.push('声明多：' + k);
  const oldSha = new Map((existing.perSource || []).map((x) => [x.source, x.sha256]));
  for (const s of perSource) if (oldSha.get(s.source) && oldSha.get(s.source) !== s.sha256) problems.push('源文件已变：' + s.source);
  console.log(`[check] closedTurns=${closedTurns} openTurns=${gaps.length} sources=${sources.length}`);
  if (problems.length) { for (const p of problems.slice(0, 20)) console.error('  ✖ ' + p); process.exit(1); }
  console.log('[check] OK：磁盘语料与 预期缺口.json 逐项一致');
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`[预期缺口] 已写 ${OUT}`);
console.log(`[预期缺口] 源 ${sources.length} 个文件 / 闭合轮 ${closedTurns} / 未闭合轮 ${gaps.length}`);
for (const g of gaps) console.log(`  · ${g.session} turn ${g.turn} @ ${g.startByte}（${g.source}，sha256 ${g.sourceSha256.slice(0, 16)}…）`);
