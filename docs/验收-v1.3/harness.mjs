/**
 * @file harness.mjs
 * @role v1.3 黑盒验收的公共工具：临时实验室、产物扫描、独立会话解码、xlsx 探针、记录器。
 *
 * ⚠️ 独立性原则：
 *   · 断言只读「产物 + 台账 + state + 日志」，不 import 被测模块做判定；
 *   · 需要驱动被测代码时（runOnce / 生成封板态），只通过 index.js 的公开入口
 *     （runOnce、__test__.readConfig）与 weekly.js 的公开导出，不读其内部符号；
 *   · 会话源解码是本脚本自己实现的 zstd 多帧读取，不复用 lib/frames.js。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const Z_TIME_RE = /\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
export const CODE_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;
export const MONTH_DIR_RE = /^\d{4}年\d{2}月$/;
export const E3_DIR_RE = /^\d{2}月总“完整原文”$/;
export const ORIGINAL_NAME_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8} 完整原文\.md$/;
export const MAIN_NAME_RE = /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表\.md$/;
export const APPENDIX_NAME_RE = /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表——附表\.md$/;
export const WEEKLY_NAME_RE = /^\d{2}月第\d周-[0-9a-z]{12}[A-Z]的周记账\.xlsx$/;
export const SUPP_NAME_RE = /^补记-\d{8}\.md$/;

// ---------------------------------------------------------------------------
// 基础 IO / hash
// ---------------------------------------------------------------------------
export const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const sha256Text = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
export const sha256File = (p) => sha256Buf(fs.readFileSync(p));
export const readText = (p) => fs.readFileSync(p, 'utf8');
export const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

export function walkFiles(dir, base = dir, out = []) {
  if (!exists(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkFiles(p, base, out);
    else out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** 数据总库里的「档案产物」：跳过运行区 ledger/。 */
export function listArtifacts(root) {
  const all = walkFiles(root);
  const out = all.filter((f) => !f.rel.startsWith('ledger/'));
  for (const f of out) {
    f.bytes = fs.readFileSync(f.abs);
    f.sha = sha256Buf(f.bytes);
    f.text = f.rel.endsWith('.md') ? f.bytes.toString('utf8') : null;
  }
  return out;
}

export function listFirstLevel(root) {
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readLedger(root) {
  const dir = path.join(root, 'ledger');
  const files = [];
  const records = [];
  let badLines = 0;
  let lines = 0;
  if (exists(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.jsonl') || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      files.push({ name, path: p, size: fs.statSync(p).size });
      const text = fs.readFileSync(p, 'utf8');
      if (text.length && !text.endsWith('\n')) badLines += 1;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        try { records.push(JSON.parse(line)); } catch { badLines += 1; }
      }
    }
  }
  return { dir, files, records, badLines, lines };
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// 时间（独立实现 +08:00 口径，不依赖被测模块）
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
export { pad2 };
export function localParts(ms, offsetMinutes = 480) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    dow: d.getUTCDay(),
  };
}
export function localStamp(ms, offsetMinutes = 480) {
  const p = localParts(ms, offsetMinutes);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`;
}
export function localDate(ms, offsetMinutes = 480) {
  const p = localParts(ms, offsetMinutes);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}
export function isoLocal(ms, offsetMinutes = 480) {
  const p = localParts(ms, offsetMinutes);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}+08:00`;
}
export function hhmm(ms, offsetMinutes = 480) {
  const p = localParts(ms, offsetMinutes);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}
export const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---------------------------------------------------------------------------
// 独立会话解码（zstd 多帧；只读）
// ---------------------------------------------------------------------------
export function decodeSessionFile(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(ZSTD_MAGIC, i + ZSTD_MAGIC.length); }
  const events = [];
  let failedFrames = 0;
  let badLines = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { badLines += 1; }
      }
    } catch {
      failedFrames += 1;
    }
  }
  return { size: buf.length, frames: starts.length, events, failedFrames, badLines };
}

/** 从会话事件里取轮次边界：turn → {startSeq, endSeq, startMs, endMs, reason}。 */
export function turnBoundaries(events) {
  const starts = new Map();
  const ends = new Map();
  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue;
    if (e.type === 'turn/start' && e.data && Number.isInteger(e.data.turn)) {
      if (!starts.has(e.data.turn)) starts.set(e.data.turn, e);
    } else if (e.type === 'turn/end' && e.data && Number.isInteger(e.data.turn)) {
      ends.set(e.data.turn, e);
    }
  }
  const out = new Map();
  for (const [turn, s] of starts) {
    const en = ends.get(turn) || null;
    out.set(turn, {
      turn,
      startSeq: s.seq,
      startMs: s.time,
      endSeq: en ? en.seq : null,
      endMs: en ? en.time : null,
      reason: en && en.data && en.data.reason ? en.data.reason.kind : null,
    });
  }
  return out;
}

/** 该轮 seq 区间内的全部事件（独立口径）。 */
export function eventsInRange(events, fromSeq, toSeq) {
  return events.filter((e) => Number.isInteger(e.seq) && e.seq >= fromSeq && e.seq <= toSeq);
}

// ---------------------------------------------------------------------------
// Markdown 前置块（YAML）解析 —— 只解析验收要用到的标量
// ---------------------------------------------------------------------------
export function parseFrontMatter(text) {
  const lines = String(text).split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null;
  const bodyLines = lines.slice(1, end);
  const keys = [];
  const raw = {};
  for (const line of bodyLines) {
    const m = /^([^\s#][^:]*):(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].trim();
    keys.push(k);
    raw[k] = m[2];
  }
  return {
    keys,
    raw,
    lines: bodyLines,
    bodyStartLine: end + 1, // 0-based：正文第一行的索引
    body: lines.slice(end + 1).join('\n'),
  };
}

export function yamlScalar(rawValue) {
  let s = String(rawValue === undefined ? '' : rawValue).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1);
    if (rawValue.trim()[0] === "'") s = s.replace(/''/g, "'");
  }
  return s;
}

export function yamlIsBareTrue(rawValue) {
  return String(rawValue === undefined ? '' : rawValue).trim() === 'true';
}

export function isQuoted(rawValue) {
  const s = String(rawValue === undefined ? '' : rawValue).trim();
  return s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"));
}

/** 交接表正文起点：文件内第一个以「# 」开头的行的行首字节。 */
export function bodyStartIndex(text) {
  if (text.startsWith('# ')) return 0;
  const i = text.indexOf('\n# ');
  return i === -1 ? -1 : i + 1;
}

/**
 * 完整原文正文起点：「## 1.」行的**行首**。
 *
 * ⚠️ 必须行首匹配：v1.3 起 YAML 字段 `正文hash算法` 的值里**含字面 `## 1.`**
 *    （`sha256（对『## 1.』至文件末尾…）`），裸 `indexOf('## 1.')` 会命中 YAML 行，
 *    导致复算从 YAML 开始切片 → 所有原文都"hash 不一致"（2026-11-09 终验发现的脚本 bug）。
 */
export function originalBodyStartIndex(text) {
  const m = /^## 1\./m.exec(String(text));
  return m ? m.index : -1;
}

export function tailShape(text) {
  return {
    endsWithNewline: text.endsWith('\n'),
    endsWithDoubleNewline: text.endsWith('\n\n'),
    hasCR: text.includes('\r'),
    hasBOM: text.charCodeAt(0) === 0xfeff,
    hasPlaceholder: text.includes('{{') || text.includes('}}'),
  };
}

// ---------------------------------------------------------------------------
// 记录器：一条结果可覆盖多条判据；汇总时按判据取「失败优先」
// ---------------------------------------------------------------------------
export class Recorder {
  constructor() { this.items = []; this.tasks = []; }
  add(id, status, criteria, acs, evidence) {
    this.items.push({
      id,
      status,
      criteria: [].concat(criteria || []),
      acs: [].concat(acs || []),
      evidence: String(evidence === undefined || evidence === null ? '' : evidence),
    });
  }
  pass(id, criteria, acs, evidence) { this.add(id, 'PASS', criteria, acs, evidence); }
  fail(id, criteria, acs, evidence) { this.add(id, 'FAIL', criteria, acs, evidence); }
  manual(id, criteria, acs, evidence) { this.add(id, 'MANUAL', criteria, acs, evidence); }
  na(id, criteria, acs, evidence) { this.add(id, 'NA', criteria, acs, evidence); }
  /** 条件判定：cond 为真 → PASS，假 → FAIL。 */
  judge(id, criteria, acs, cond, okEvidence, failEvidence) {
    if (cond) this.pass(id, criteria, acs, okEvidence);
    else this.fail(id, criteria, acs, failEvidence === undefined ? okEvidence : failEvidence);
  }
  /** 任务级断言（不在 174 条判据里，但属于本任务验收要求）。 */
  task(id, ok, evidence) { this.tasks.push({ id, ok: !!ok, evidence: String(evidence || '') }); }
}

// ---------------------------------------------------------------------------
// 实验室：一套独立的 DSH_HOME + 数据总库
// ---------------------------------------------------------------------------
export function mkLab(baseDir, name) {
  const dir = path.join(baseDir, 'labs', name);
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  return { name, dir, home, root, sessions: path.join(home, 'sessions') };
}

/** 把 $DSH_HOME/sessions 下的一个真实会话目录整体复制进 Lab。 */
export function copyRealSession(lab, srcBase, relDir, fileName) {
  const dst = path.join(lab.sessions, relDir);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(srcBase, relDir, fileName), path.join(dst, fileName));
  return path.join(dst, fileName);
}

/** 合成会话：events 第一行必须是 {type:'session'}；按 JSONL 压成一帧写入。
 *  frameSplit > 1 时切成多帧（模拟 DSH 追加写）。 */
export function writeSyntheticSession(lab, { sid, events, workspace = 'ws-accept', frameSplit = 1 }) {
  const dir = path.join(lab.sessions, workspace, `session-${sid}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const lines = events.map((e) => JSON.stringify(e));
  if (frameSplit <= 1) {
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  } else {
    const per = Math.ceil(lines.length / frameSplit);
    const bufs = [];
    for (let i = 0; i < lines.length; i += per) {
      bufs.push(zlib.zstdCompressSync(Buffer.from(lines.slice(i, i + per).join('\n') + '\n', 'utf8')));
    }
    fs.writeFileSync(file, Buffer.concat(bufs));
  }
  return file;
}

/** 在已有会话文件尾部追加一帧事件（模拟 DSH 又写了几条）。 */
export function appendSessionFrame(sessionFile, events) {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(sessionFile, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
}

/** 造一条会话事件（带 seq，时间用毫秒）。 */
export function makeEvent(type, seq, timeMs, data) {
  return { type, seq, time: timeMs, data };
}

/** 跑一轮 runOnce（通过 index.js 公开入口）。 */
export async function runRound(T, lab, opts = {}) {
  process.env.DSH_HOME = lab.home;
  const logs = [];
  const push = (level) => (m) => logs.push(`${level} ${String(m)}`);
  const logger = { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG') };
  const cfg = T.idx.__test__.readConfig({
    root: lab.root,
    offsetMinutes: 480,
    intervalSeconds: 60,
    hotWindowSeconds: 604800,
    quietSeconds: opts.quietSeconds === undefined ? 120 : opts.quietSeconds,
    scanBudgetMs: 0,
    maxBytesPerSession: 0,
  });
  const stat = await T.idx.runOnce({ logger }, cfg);
  return { stat, logs, logText: logs.join('\n') };
}

// ---------------------------------------------------------------------------
// xlsx 探针（python + openpyxl；只读事实）
// ---------------------------------------------------------------------------
export function probeXlsx(T, xlsxFiles) {
  const outFile = path.join(T.probeDir, `probe-${crypto.randomBytes(4).toString('hex')}.json`);
  const py = T.python;
  const script = T.probeScript;
  const r = spawnSync(py, [script, outFile, ...xlsxFiles], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) {
    throw new Error(`xlsx_probe 失败 status=${r.status} stderr=${(r.stderr || '').slice(0, 2000)}`);
  }
  const arr = readJson(outFile);
  const map = new Map();
  for (const f of arr) map.set(f.file, f);
  return map;
}

/** 取相对路径可复算的 artifacts 清单（用于前后字节对比）。 */
export function artifactSnapshot(root) {
  const map = new Map();
  for (const f of listArtifacts(root)) map.set(f.rel, { sha: f.sha, size: f.size, mtimeMs: f.mtimeMs });
  return map;
}

export function compareSnapshots(a, b, ignore = []) {
  const diffs = [];
  const ignoreSet = new Set(ignore);
  for (const [rel, info] of a) {
    if (ignoreSet.has(rel)) continue;
    if (!b.has(rel)) { diffs.push(`缺失: ${rel}`); continue; }
    if (b.get(rel).sha !== info.sha) diffs.push(`字节变化: ${rel}`);
  }
  for (const [rel] of b) {
    if (ignoreSet.has(rel)) continue;
    if (!a.has(rel)) diffs.push(`新增: ${rel}`);
  }
  return diffs;
}
