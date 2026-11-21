#!/usr/bin/env node
/**
 * @file docs/工具-构造lab.mjs
 * @role **判据夹具（lab）确定性构造器**：把 判据-1.0.mjs / 判据-0.9.1.mjs / 判据-0.9.4.mjs
 *       需要的四类 lab 在**包内自足**地造出来，不再依赖开发机 `_工作\c01-lab` 等路径。
 *
 * @why 审计 P0-02/P1-15：旧 lab 全在开发机 `_工作\` 下，接收端只能跑 14 绿 / 26 NA，
 *      "40 条全绿"无法从交付包复算。本构造器用**真实插件管线**（index.runOnce + tools/pointerindex.buildIndex）
 *      造 lab，产物是"跑插件跑出来的"，不是手工拼的假数据：
 *
 *   lab                    用途                                  关键口径
 *   ─────────────────────  ────────────────────────────────────  ─────────────────────────────
 *   c01-lab                判据小库（C01/C09/C10/C14–C16/C19 等）  12 行 / 3 个台账日 / 3 个 sid（与 0.9.x 旧 lab 同口径）
 *   lab-e3-accept          判据大库（C20/C21/C22/C25/C34/C35/C36） 38.82 MB 大会话 → 1,338 行；**只有显式 --corpus 才用真语料**，
 *                                                                 缺省确定性合成同构轮次（zstd ≈35 MB、1,338 轮、3 tick 内入账）会话
 *   lab-094-3layer         C31 三层夹具（热/温/冷）                anchor=今天；热=当天、温=90–180 天前、冷=>365 天前；
 *                                                                  每层 1 个 sid、跨月；manifest.json = dsh-094-3layer-lab/1
 *   lab-weeks              C41 周账 / C42 日结摘要                 跨月自然周（10/26–11/1）；weekly xlsx ≥3 组；收据 ≥3 天
 *
 * @discipline
 *   ① **不依赖开发机路径**：只有显式 `--corpus=<dir>` 才读真语料（含 sessions/ 的 02-语料或直接给 sessions）；
 *      **缺省一律确定性合成**（不搜桌面 `02-语料`；真实语料是否随包由机主/lead 决定）；
 *   ② **确定性**：同一版本 → 同一份 lab（sid / 时间戳 / 文本全部写死，不含随机数）；e3 的合成语料用
 *      sha256 链生成确定性文本（旧实现 x.repeat 压缩比 1000:1 → 语料只剩 66 KB、C22 失真）；轮次结构与
 *      真语料同构：小帧（4 事件/帧，真本 22,987 帧）、载重放 tool/call+result（短正文，视图按 2000 码点截断）
 *      → zstd≈35 MB / 3 tick 内入账 / r2≈1.19 / r3≈3.9%；真实 38.82 MB 语料请用 --corpus 提供，
 *      差值（34.15 MiB vs 38.82 MB、r2/r3 数值）在 _labs.json 与 C20/C22 证据里如实登记）；
 *      判据执行器自动构造时同落该系统临时目录，**不写包内、不写包上一级**；
 *   ⑤ **如实登记来源**：`_labs.json` 记每个 lab 的来源（inline-synthetic / corpus:路径+sha256）、行数、索引、耗时。
 *
 * 用法：
 *   node docs\工具-构造lab.mjs [--lab-dir=<dir>] [--only=c01,e3,three,weeks] [--corpus=<dir>]
 *                              [--force] [--clean] [--json] [--help]
 *     --lab-dir=<dir> 输出目录（默认 %TEMP%\dsh-ledger-labs-<包版本>；--out 同义）
 *     --only=a,b      只造指定 lab（c01 / e3 / three / weeks；也接受 corpus = 全量 17 会话库，仅作旁证）
 *     --corpus=<dir>  语料目录（含 `sessions\` 的 02-语料；也接受直接给 sessions 目录）；**缺省不读任何真语料，直接确定性合成**
 *     --force         已存在也重建（默认存在即跳过并复用，避免重复跑重活；**指纹不符/上次 ok:false 时会自动重建**）
 *     --clean         只删 `--out` 目录后退出（清理生成物；不碰产品文件）
 *     --json          stdout 只出机读 JSON
 *
 * 退出码：0=全部按需就绪；1=有 lab 构造失败（详见 stdout/`_labs.json`）；2=用法/环境错误。
 *
 * @reads   <corpus>\sessions\**（可选；只读）、本包 index.js / tools/pointerindex.mjs（public ESM import）
 * @writes  仅 `--out` 内：`<lab>\root`（账库）、`<lab>\dsh-home\sessions`（会话源）、`<lab>\manifest.json`、
 *          `<lab>\receipts`（weeks 用）、`_labs.json`（总表）。**不写产品账库、不改产品文件**。
 * @depends node:fs/path/crypto/zlib/url（零第三方依赖）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// 一、路径 / 参数
// ============================================================================
const THIS_FILE = fileURLToPath(import.meta.url);
const LITE = path.resolve(path.dirname(THIS_FILE), '..');
const WORK = path.resolve(LITE, '..');
const NODE = process.execPath;

const args = process.argv.slice(2);
const argOf = (k) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : '';
};
const hasFlag = (k) => args.includes(`--${k}`);
const asJson = hasFlag('json');
const wantHelp = args.includes('--help') || args.includes('-h');

// ★ 默认落**系统临时目录**（接收端解压交付包后没有 _工作\，包内也不该放几十 MB 生成物）：
//   %TEMP%\dsh-ledger-labs-<包版本>\ —— 一条命令自建、--clean 一键清、--lab-dir/--out 可覆盖。
// ★ K-18（re4 / 三份审计 P0-②）：目录名必须随**包版本**走。旧口径写死 v1.0.0-re2，
//   于是 re3/re4 与任何后续构建共用同一份 lab；再叠加"存在即复用"，接收端就会吃到别的
//   构建留下的夹具 —— 审计看到的"45/44 随机器历史变"正是这一条。
const PKG_VERSION = (() => {
  const pick = (v) => (v && typeof v.version === 'string' && v.version ? v.version : '');
  try { const a = pick(JSON.parse(fs.readFileSync(path.join(LITE, 'VERSION.json'), 'utf8'))); if (a) return a; } catch { /* 缺则退 package.json */ }
  try { const b = pick(JSON.parse(fs.readFileSync(path.join(LITE, 'package.json'), 'utf8'))); if (b) return b; } catch { /* 缺则退 dev */ }
  return 'dev';
})();
const DEFAULT_OUT = path.join(os.tmpdir(), 'dsh-ledger-labs-' + PKG_VERSION);
const OUT = path.resolve(argOf('out') || argOf('lab-dir') || DEFAULT_OUT);
const ONLY_RAW = (argOf('only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ONLY = ONLY_RAW.length ? ONLY_RAW : ['c01', 'e3', 'three', 'weeks'];
const FORCE = hasFlag('force');
const CLEAN = hasFlag('clean');

const KNOWN_LABS = new Set(['c01', 'e3', 'three', 'weeks', 'corpus']);
const KNOWN_FLAGS = new Set(['out', 'lab-dir', 'only', 'corpus', 'force', 'clean', 'json', 'help']);

const USAGE = `判据夹具构造器（lite 线）· 包内自足造 lab

用法：
  node docs\\工具-构造lab.mjs [--out=<dir>] [--only=c01,e3,three,weeks] [--corpus=<dir>]
                              [--force] [--clean] [--json]

  --lab-dir=<dir> 输出目录（默认 %TEMP%\\dsh-ledger-labs-<包版本>；--out 同义）
  --only=a,b      c01 / e3 / three / weeks / corpus（corpus=全量会话库，仅旁证）
  --corpus=<dir>  02-语料目录（含 sessions\\）或直接给 sessions 目录；缺省=确定性合成（不搜桌面语料）
  --force         已存在也重建
  --clean         只删 --out 后退出
  --json          stdout 只出 JSON

lab 口径：
  c01-lab          12 行 / 3 台账日 / 3 sid（小库；C01/C09/C10/C14–C16/C19 用）
  lab-e3-accept    38.82 MB 大会话 → 1,338 行（大库；C20/C21/C22/C25 用；优先真语料）
  lab-094-3layer   三层夹具：热=今天 / 温=90–180 天前 / 冷=>365 天前，每层 1 sid、跨月（C31 用）
  lab-weeks        跨月自然周（10/26–11/1）：weekly xlsx ≥3 组 + 日结摘要 ≥3 天（C41/C42 用）

清理：lab 是生成物，在系统临时目录里，随时可删（node docs\\工具-构造lab.mjs --clean）。
`;

function usageError(msg) {
  console.error(`[用法错误] ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}
if (wantHelp) {
  console.log(USAGE);
  process.exit(0);
}
for (const a of args) {
  if (!a.startsWith('--')) usageError(`不认识的裸参数：${a}`);
  const k = a.slice(2).split('=')[0];
  if (!KNOWN_FLAGS.has(k)) usageError(`不认识的参数 --${k}`);
}
for (const k of ONLY) {
  if (!KNOWN_LABS.has(k)) usageError(`--only 里有不认识的 lab：${k}（可用：${[...KNOWN_LABS].join(',')}）`);
}

const log = (...a) => {
  if (!asJson) console.log(...a);
};
const logErr = (...a) => console.error(...a);

// ============================================================================
// 二、通用工具
// ============================================================================
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sum = (arr, fn) => arr.reduce((s, x) => s + (fn ? fn(x) : x), 0);

// ★ K-18 收口（re4）：lab 身份除"包版本 + 构造器 sha256"外，还必须含**产品管线指纹**——
//   产品补丁（index.js / tools/pointerindex.mjs）一变，同一包版本下的旧 lab 也必须重建，
//   否则判据会吃到旧管线造出的夹具（审计 P0-② 的"同包同机 45/44"残留缺口）。
//   公式（与 docs/判据-1.0.mjs 的 labFingerprintWant 必须一致）：
//     pipelineSha = sha256( sha256(index.js) + sha256(tools/pointerindex.mjs) )
const PIPELINE_SHA = (() => {
  const h = (p) => { try { return sha256File(p); } catch { return ''; } };
  const parts = [h(path.join(LITE, 'index.js')), h(path.join(LITE, 'tools', 'pointerindex.mjs'))];
  return parts.every(Boolean) ? sha256Buf(Buffer.from(parts.join(''), 'utf8')) : '';
})();
const CONTRACT_ID = 'K-16/K-18 (re4)';

function walkFiles(root, base = root, out = []) {
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) walkFiles(abs, base, out);
    else {
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/'), name: ent.name, size: st.size });
    }
  }
  return out;
}
function dirBytes(dir) {
  let n = 0;
  for (const f of walkFiles(dir)) n += f.size;
  return n;
}

/** 本地 +08:00 的 YYYY-MM-DD / YYYYMMDD / HH:mm:ss。 */
const OFF = 8 * 3600 * 1000;
function ymdLocal(ms = Date.now()) {
  const d = new Date(ms + OFF);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
/** 锚点日 00:00:00.000 (+08:00) 的毫秒。 */
function dayStartMs(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return Date.UTC(y, m - 1, d) - OFF;
}
const DAY_MS = 86400000;

// ============================================================================
// 三、会话合成（v4 zstd 多帧；与真实 DSH 会话同构）
// ============================================================================
let seqNo = 0;
const ev = (type, timeMs, data) => ({ type, seq: seqNo++, time: timeMs, data });
const turnStart = (turn, ms) => ev('turn/start', ms, { turn });
const turnEnd = (turn, ms, kind = 'completed') => ev('turn/end', ms, { turn, reason: { kind } });
const userMsg = (text, ms) => ev('user/message', ms, { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' });
const assistantMsg = (text, ms) => ev('assistant/message', ms, { message: { role: 'assistant', content: [{ type: 'text', text }] } });
function simpleTurnEvents(turn, startMs, { userText, assistantText, endMs = null } = {}) {
  return [
    turnStart(turn, startMs),
    userMsg(userText || `第 ${turn} 轮问题`, startMs + 1),
    assistantMsg(assistantText || `第 ${turn} 轮回答`, startMs + 2),
    turnEnd(turn, endMs == null ? startMs + 3 : endMs),
  ];
}
const zstdFrame = (events) => zlib.zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8'));

/** 会话头事件（v4；不带 seq/time —— 与真实 DSH 会话头同构，插件按它认版本/会话开始日）。 */
const sessionHeader = (sid, createdAtMs) => ({ type: 'session', version: 4, id: sid, createdAt: createdAtMs, cwd: 'C:\\ledger-lab' });

/** 写会话文件（首帧带会话头；frames 默认按 500 事件切帧，模拟 DSH 追加写；帧边界=插件续读边界）。 */
function writeSession(sessionsDir, wsName, sid, events, eventsPerFrame = 500, createdAtMs = null) {
  const dir = path.join(sessionsDir, wsName, sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const created = createdAtMs == null
    ? (events.find((e) => e && e.time) || {}).time || Date.now()
    : createdAtMs;
  const all = [sessionHeader(sid, created), ...events];
  const bufs = [];
  for (let i = 0; i < all.length; i += eventsPerFrame) {
    bufs.push(zstdFrame(all.slice(i, i + eventsPerFrame)));
  }
  fs.writeFileSync(file, Buffer.concat(bufs));
  return { file, bytes: fs.statSync(file).size };
}

// ============================================================================
// 四、插件管线（公开入口，不 import 私有函数）
// ============================================================================
let pluginCache = null;
async function loadPlugin() {
  if (pluginCache) return pluginCache;
  pluginCache = await import(pathToFileURL(path.join(LITE, 'index.js')).href);
  return pluginCache;
}
let indexerCache = null;
async function loadIndexer() {
  if (indexerCache) return indexerCache;
  indexerCache = await import(pathToFileURL(path.join(LITE, 'tools', 'pointerindex.mjs')).href);
  return indexerCache;
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 本进程内每 lab 用独立 DSH_HOME（runOnce 从 process.env.DSH_HOME 找 sessions）。 */
function makeLabDirs(outDir, name) {
  const lab = path.join(outDir, name);
  const dirs = {
    lab,
    root: path.join(lab, 'root'),
    home: path.join(lab, 'dsh-home'),
    sessions: path.join(lab, 'dsh-home', 'sessions'),
  };
  fs.mkdirSync(dirs.root, { recursive: true });
  fs.mkdirSync(dirs.sessions, { recursive: true });
  return dirs;
}

function baseCfg(dirs, over = {}) {
  return {
    root: dirs.root,
    enabled: true,
    intervalSeconds: 60,
    offsetMinutes: 480,
    hotWindowSeconds: 0, // 0 = 每次全扫（首跑口径，lab 构造要确定性）
    quietSeconds: 0,
    scanBudgetMs: 0,
    maxBytesPerSession: 0, // 单轮不限字节：由插件自身默认每 tick 预算约束分帧
    checkupEnabled: false,
    weeklyEnabled: false,
    handoverEnabled: false,
    receiptAnchorRoot: '',
    ...over,
  };
}

/** 跑 n 个 tick；返回每次 stat 与耗时（stat 是 runOnce 的返回）。 */
async function runTicks(dirs, cfg, ticks) {
  const impl = await loadPlugin();
  process.env.DSH_HOME = dirs.home;
  const out = [];
  for (let i = 0; i < ticks; i += 1) {
    const t0 = Date.now();
    let stat = null;
    let err = '';
    try {
      stat = await impl.runOnce({ logger: quietLogger }, cfg);
    } catch (e) {
      err = String((e && e.message) || e);
    }
    out.push({ tick: i + 1, ms: Date.now() - t0, stat, err });
    if (err) break;
  }
  return out;
}

/** 台账行数与日文件数（只读）。 */
function scanLedger(root) {
  const dir = path.join(root, 'ledger');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { rows: 0, days: 0, badLines: 0, files: [] };
  }
  const files = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  let rows = 0;
  let badLines = 0;
  const out = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
        rows += 1;
      } catch {
        badLines += 1;
      }
    }
  }
  return { rows, days: files.length, badLines, records: out, files };
}

async function buildIndexFor(root) {
  const pi = await loadIndexer();
  const res = pi.buildIndex({ root });
  if (!res || res.ok !== true) throw new Error(`buildIndex 失败：${JSON.stringify(res && res.problems)}`);
  return res;
}

// ============================================================================
// 五、语料定位（re3：只有显式 --corpus 才读真语料；缺省 → 确定性合成）
// ============================================================================
function resolveCorpus(arg) {
  if (!arg) return { dir: '', sessions: '', files: [] };
  const c = path.resolve(arg);
  const sessions = fs.existsSync(path.join(c, 'sessions')) ? path.join(c, 'sessions') : c;
  if (fs.existsSync(sessions) && fs.statSync(sessions).isDirectory()) {
    const files = walkFiles(sessions).filter((f) => /\.(zstd|jsonl)$/.test(f.name));
    if (files.length) return { dir: c, sessions, files };
  }
  return { dir: '', sessions: '', files: [] };
}

// ============================================================================
// 六、四类 lab 的构造
// ============================================================================

/** c01-lab：12 行 / 3 台账日 / 3 sid（与 0.9.x 旧小库同口径，供 C01/C09/C10/C14–C16/C19 用）。 */
async function buildC01(outDir, meta) {
  const dirs = makeLabDirs(outDir, 'c01-lab');
  seqNo = 0;
  // 三个 sid、三个台账日、各 4 轮 → 12 行
  const plan = [
    { sid: 'session-c01lab0001-1111-2222-3333-444444444401', ws: 'wsA', day: '2026-10-05', turns: 4, t0: '09:00:00' },
    { sid: 'session-c01lab0002-1111-2222-3333-444444444402', ws: 'wsB', day: '2026-10-06', turns: 4, t0: '10:00:00' },
    { sid: 'session-c01lab0003-1111-2222-3333-444444444403', ws: 'wsC', day: '2026-10-07', turns: 4, t0: '11:00:00' },
  ];
  const written = [];
  for (const p of plan) {
    const start = dayStartMs(p.day) + 9 * 3600 * 1000; // 09:00 +08:00
    const base = start + Number(p.t0.slice(0, 2)) * 3600 * 1000 - 9 * 3600 * 1000;
    const events = [];
    for (let i = 1; i <= p.turns; i += 1) {
      events.push(...simpleTurnEvents(i, base + (i - 1) * 3600 * 1000, {
        userText: `c01-lab ${p.sid} 第 ${i} 轮：记账测试`,
        assistantText: `c01-lab 第 ${i} 轮回答（确定性文本）`,
      }));
    }
    const w = writeSession(dirs.sessions, p.ws, p.sid, events);
    written.push({ sid: p.sid, bytes: w.bytes, events: events.length });
  }
  // ★ weeklyEnabled=true：小库也要有周账 xlsx，否则 reconcile 会报「缺周记账组」→ doctor ⑤ run-report 判红
  //   （C19 的日检里含 doctor 子项，2026-11-14 实测因此被误判红；旧 c01-lab 本是带周账的）。
  const ticks = await runTicks(dirs, baseCfg(dirs, { weeklyEnabled: true }), 1);
  const led = scanLedger(dirs.root);
  const idx = await buildIndexFor(dirs.root);
  const ok = led.rows === 12 && led.badLines === 0;
  meta.labs['c01-lab'] = {
    ok,
    root: dirs.root,
    sessions: dirs.sessions,
    rows: led.rows,
    ledgerDays: led.days,
    badLines: led.badLines,
    sids: plan.map((p) => p.sid),
    indexRows: idx.rows,
    source: 'inline-synthetic',
    ticks: ticks.map((t) => ({ tick: t.tick, ms: t.ms, written: t.stat && t.stat.written, err: t.err })),
    why: ok ? '' : `期望 12 行，实得 ${led.rows} 行（badLines=${led.badLines}）`,
  };
  return meta.labs['c01-lab'];
}

/**
 * 确定性伪随机文本（sha256 链；同 seed → 同字节，跨机器/跨 Node 版本稳定）。
 * 只用 base64 字母表（JSON 安全、UTF-8 单字节），熵 6 bit/byte —— zstd 压缩比 ≈0.74。
 * @why 旧实现用 `'x'.repeat(27000)`：zstd 后只有 66 KB（压缩比 ~1000:1），E3 语料体积缩水 600 倍，
 *      C22 的「套账/压缩语料 ≤0.05×」会直接失真成红。re3 起改为低压缩率的确定性文本。
 */
function pseudoText(len, seed) {
  const parts = [];
  let remain = Math.max(0, Math.floor(len));
  let buf = Buffer.from(String(seed), 'utf8');
  while (remain > 0) {
    buf = crypto.createHash('sha256').update(buf).digest();
    const s = buf.toString('base64').replace(/=+$/, '');
    const take = Math.min(remain, s.length);
    parts.push(take === s.length ? s : s.slice(0, take));
    remain -= take;
  }
  return parts.join('');
}

/**
 * 一轮"像真实 DSH 会话"的事件：小段 user/assistant 正文 ＋ 带载重参数的 tool/call ＋ tool/result。
 * @why 只放 user/assistant（旧实现）会让「原文+视图/解压语料」≈2.0× —— 视图把 18KB 正文**全量**渲染，
 *      而真实语料的载重几乎都在 tool 参数/结果里（视图按 DISPLAY_BLOCK_LIMIT=2000 码点截断），
 *      所以真样本 r2≈1.12。re3 起让合成轮次同构：正文短、工具载重大 → 视图占比小 → r2 落在 1.00–1.35。
 */
function synthToolTurnEvents(turn, startMs, { msgPad = 300, toolPad = 17000 } = {}) {
  const callId = `call_${String(turn).padStart(4, '0')}_e3synth`;
  const args = `{"command": "${pseudoText(toolPad, `e3-args-${turn}`)}"}`;
  const resultText = pseudoText(toolPad, `e3-result-${turn}`);
  return [
    turnStart(turn, startMs),
    userMsg(`E3 合成会话 第 ${turn} 轮：${pseudoText(msgPad, `e3-user-${turn}`)}`, startMs + 1),
    assistantMsg(`E3 合成回答 第 ${turn} 轮：${pseudoText(msgPad, `e3-assist-${turn}`)}`, startMs + 2),
    ev('tool/call', startMs + 3, { turn, step: 1, callId, name: 'pwsh', arguments: args }),
    ev('tool/result', startMs + 4, {
      turn,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: resultText }],
        isError: false,
        id: `res-e3synth-${turn}`,
      },
      sourceEventSeqs: [],
      surfaceOp: 'append',
    }),
    turnEnd(turn, startMs + 5),
  ];
}

/** 供 e3 用的合成大会话：1,338 闭合轮（确定性；只在没有 --corpus 时用）。
 *  参数口径（实测）：msgPad=300 / toolPad=17000 → 原始事件 ≈47 MB，zstd 后 ≈35 MB，
 *  视图≈5 KB/轮（工具块被 2000 码点截断）→ r2≈1.1x、r3≈0.037；小帧（4 事件/帧）→ 3 tick 内入账。 */
function synthBigSessionEvents({ turns = 1338, days = 45, msgPad = 300, toolPad = 17000 } = {}) {
  seqNo = 0;
  const events = [];
  const start = dayStartMs('2026-09-01') + 9 * 3600 * 1000;
  const perDay = Math.ceil(turns / days);
  for (let t = 1; t <= turns; t += 1) {
    const dayIdx = Math.min(days - 1, Math.floor((t - 1) / perDay));
    const startMs = start + dayIdx * DAY_MS + ((t - 1) % perDay) * 60 * 1000;
    events.push(...synthToolTurnEvents(t, startMs, { msgPad, toolPad }));
  }
  return events;
}

/** lab-e3-accept：38.82 MB 大会话 → 1,338 行（C20/C21/C22/C25 用）。 */
async function buildE3(outDir, meta, corpus) {
  const dirs = makeLabDirs(outDir, 'lab-e3-accept');
  let source = '';
  let sourceSha = '';
  let sessionBytes = 0;
  let sid = 'session-e3accept0001-1111-2222-3333-444444444401';
  const ws = 'wsE3';
  // ① 真语料：取最大的 v4 会话文件（E3 = 38,837,466 B）
  //    ★ 插件会校验「会话头 id == 目录名」，所以目录名必须用真会话 id，不能自造。
  const corpusFiles = (corpus.files || []).filter((f) => /\.v4\.jsonl\.zstd$/.test(f.name));
  const biggest = corpusFiles.length ? corpusFiles.reduce((m, f) => (f.size > m.size ? f : m), corpusFiles[0]) : null;
  if (biggest) {
    sid = path.basename(path.dirname(biggest.abs));
    const dstDir = path.join(dirs.sessions, ws, sid);
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, 'session.v4.jsonl.zstd');
    fs.copyFileSync(biggest.abs, dst);
    sessionBytes = fs.statSync(dst).size;
    source = `corpus:${biggest.rel}`;
    sourceSha = sha256File(biggest.abs);
  } else {
    // ② 合成：确定性文本 + 与真同构轮次（zstd≈35 MB / 编 1338 轮；真实 38.82 MB 语料的差值如实登记在证据里）
    const events = synthBigSessionEvents({});
    // ★ 与真语料同构：E3 真本 = 22,987 个**小帧**（每帧 ~4 个事件，追加写边界），不是 1 个大帧。
    //   大帧会让事件批读（≤8 MiB/批）读不动 → tick 停滞/读放大超顶；小帧才能 3 tick 内入账。
    const w = writeSession(dirs.sessions, ws, sid, events, 4);
    sessionBytes = w.bytes;
    source = 'inline-synthetic(1338 turns / 45 days / 小帧4事件 + tool载重; msgPad=300 toolPad=17000)';
    sourceSha = sha256File(w.file);
  }
  // 跑 5 个 tick：3 个入账 tick + 2 个稳态 tick（C20 要求入账完成后的 tick written=0）
  const ticks = await runTicks(dirs, baseCfg(dirs, { maxBytesPerSession: 16 * 1024 * 1024 }), 5);
  const led = scanLedger(dirs.root);
  const idx = await buildIndexFor(dirs.root);
  const metricsFile = path.join(dirs.root, 'ledger', '.tick-metrics.jsonl');
  const metrics = fs.existsSync(metricsFile)
    ? fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const ok = led.rows > 0 && led.badLines === 0 && metrics.length > 0;
  meta.labs['lab-e3-accept'] = {
    ok,
    root: dirs.root,
    sessions: dirs.sessions,
    rows: led.rows,
    ledgerDays: led.days,
    badLines: led.badLines,
    sessionBytes,
    source,
    sourceSha256: sourceSha,
    indexRows: idx.rows,
    metricsTicks: metrics.map((m) => ({ written: m.written, ms: m.ms, readBytes: m.readBytes })),
    ticks: ticks.map((t) => ({ tick: t.tick, ms: t.ms, written: t.stat && t.stat.written, err: t.err })),
    why: ok ? '' : `台账 ${led.rows} 行 / 度量 ${metrics.length} tick（badLines=${led.badLines}）`,
  };
  return meta.labs['lab-e3-accept'];
}

/** lab-094-3layer：三层夹具（热=今天 / 温=90–180 天前 / 冷=>365 天前），每层 1 sid、跨月。 */
async function buildThree(outDir, meta) {
  const lab = path.join(outDir, 'lab-094-3layer');
  const dirs = makeLabDirs(outDir, 'lab-094-3layer');
  const anchor = ymdLocal(); // 今天（+08:00）
  const anchorStart = dayStartMs(anchor);
  const plan = [
    {
      layer: 'hot',
      sid: 'session-three00001-1111-2222-3333-444444444401',
      days: [{ off: 0, hh: 10 }, { off: 0, hh: 11 }],
    },
    {
      layer: 'warm',
      sid: 'session-three00002-1111-2222-3333-444444444402',
      days: [{ off: 100, hh: 10 }, { off: 160, hh: 11 }],
    },
    {
      layer: 'cold',
      sid: 'session-three00003-1111-2222-3333-444444444403',
      days: [{ off: 400, hh: 10 }, { off: 460, hh: 11 }],
    },
  ];
  seqNo = 0;
  for (const p of plan) {
    const events = [];
    p.days.forEach((d, i) => {
      const startMs = anchorStart - d.off * DAY_MS + d.hh * 3600 * 1000;
      events.push(...simpleTurnEvents(i + 1, startMs, {
        userText: `three-layer ${p.layer} 第 ${i + 1} 轮（距锚点 ${d.off} 天）`,
        assistantText: `three-layer ${p.layer} 回答 ${i + 1}`,
      }));
    });
    writeSession(dirs.sessions, `ws-${p.layer}`, p.sid, events);
  }
  const ticks = await runTicks(dirs, baseCfg(dirs), 1);
  const led = scanLedger(dirs.root);
  if (!led.records) {
    meta.labs['lab-094-3layer'] = { ok: false, root: dirs.root, why: '台账为空（runOnce 未写入）', ticks };
    return meta.labs['lab-094-3layer'];
  }
  const idx = await buildIndexFor(dirs.root);
  const layers = plan.map((p) => {
    const rows = led.records
      .filter((r) => String(r.sid) === p.sid)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((r) => ({ code: String(r.code), ts: String(r.ts) }));
    return { layer: p.layer, sid: p.sid, rows };
  });
  const man = {
    kind: 'dsh-094-3layer-lab',
    v: 1,
    anchor,
    generatedAt: new Date(Date.now() + OFF).toISOString().replace('Z', '+08:00'),
    caliber: {
      hot: { fromDays: 0, toDays: 0, desc: '锚点日（生成当日=今天）' },
      warm: { fromDays: 90, toDays: 180, desc: '90–180 天前' },
      cold: { fromDays: 366, toDays: null, desc: '超过 1 年（>365 天）' },
    },
    layers,
    counts: { ledgerRows: led.rows, ledgerDays: led.days },
    index: { shards: idx.shards, rows: idx.rows },
    source: 'inline-synthetic(3 sid × 2 天，真实插件管线)',
  };
  fs.writeFileSync(path.join(lab, 'manifest.json'), `${JSON.stringify(man, null, 2)}\n`, 'utf8');
  const ok = layers.every((l) => l.rows.length === 2) && led.badLines === 0 && idx.rows === led.rows;
  meta.labs['lab-094-3layer'] = {
    ok,
    root: dirs.root,
    sessions: dirs.sessions,
    manifest: path.join(lab, 'manifest.json'),
    anchor,
    rows: led.rows,
    badLines: led.badLines,
    indexRows: idx.rows,
    indexShards: idx.shards,
    layers: layers.map((l) => ({ layer: l.layer, sid: l.sid, rows: l.rows.length, days: l.rows.map((r) => r.ts.slice(0, 10)) })),
    source: man.source,
    ticks: ticks.map((t) => ({ tick: t.tick, ms: t.ms, written: t.stat && t.stat.written, err: t.err })),
    why: ok ? '' : `层行数/索引与台账不一致（rows=${led.rows}，index=${idx.rows}）`,
  };
  return meta.labs['lab-094-3layer'];
}

/** lab-weeks：跨月自然周（10/26–11/1）+ 周账 xlsx + 日结摘要（C41/C42 用）。 */
async function buildWeeks(outDir, meta) {
  const lab = path.join(outDir, 'lab-weeks');
  const dirs = makeLabDirs(outDir, 'lab-weeks');
  const receipts = path.join(lab, 'receipts');
  fs.mkdirSync(receipts, { recursive: true });
  const sid = 'session-weeks000001-1111-2222-3333-444444444401';
  const days = [
    '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', // 10月第4周
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', // 10月第5周
    '2026-11-01', // 11月第1周（自然周 10/26–11/1 的另一半 → 跨月）
    '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', // 11月第2周
  ];
  seqNo = 0;
  const events = [];
  days.forEach((d, i) => {
    const startMs = dayStartMs(d) + 9 * 3600 * 1000 + i * 1000;
    events.push(...simpleTurnEvents(i + 1, startMs, {
      userText: `weeks-lab ${d} 记账一行`,
      assistantText: `weeks-lab ${d} 回答`,
    }));
  });
  writeSession(dirs.sessions, 'wsWeeks', sid, events);
  const ticks = await runTicks(dirs, baseCfg(dirs, { weeklyEnabled: true, receiptAnchorRoot: receipts }), 2);
  const led = scanLedger(dirs.root);
  // 周账 xlsx 与日结摘要清点
  const xlsx = walkFiles(dirs.root).filter((f) => /周记账\.xlsx$/.test(f.name));
  const receiptsList = fs.existsSync(receipts)
    ? fs.readdirSync(receipts).filter((n) => /^RECEIPT-\d{8}\.json$/.test(n)).sort()
    : [];
  const weeksSet = new Set(xlsx.map((f) => (f.name.match(/^(\d{2}月第\d周)/) || [])[1] || ''));
  const ok = led.rows === days.length && xlsx.length >= 3 && receiptsList.length >= 3;
  meta.labs['lab-weeks'] = {
    ok,
    root: dirs.root,
    sessions: dirs.sessions,
    receipts,
    rows: led.rows,
    badLines: led.badLines,
    ledgerDays: led.days,
    weeklyFiles: xlsx.map((f) => f.rel),
    weeklyGroups: [...weeksSet].filter(Boolean),
    receiptFiles: receiptsList,
    ticks: ticks.map((t) => ({ tick: t.tick, ms: t.ms, written: t.stat && t.stat.written, err: t.err })),
    source: 'inline-synthetic(1 sid / 17 天 / 跨月自然周 10-26..11-01)',
    why: ok ? '' : `台账 ${led.rows} 行 / 周账 ${xlsx.length} 组 / 摘要 ${receiptsList.length} 天`,
  };
  return meta.labs['lab-weeks'];
}

/** corpus-lab：全量 17 会话库（1,558 行；旁证用，不进 45 条判据的默认 lab）。 */
async function buildCorpusLab(outDir, meta, corpus) {
  if (!corpus.files.length) {
    meta.labs['lab-corpus'] = { ok: false, why: '未给 --corpus（跳过；旁证库需要真语料）' };
    return meta.labs['lab-corpus'];
  }
  const dirs = makeLabDirs(outDir, 'lab-corpus');
  let copied = 0;
  for (const f of corpus.files) {
    const rel = path.relative(corpus.sessions, f.abs);
    const dst = path.join(dirs.sessions, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.abs, dst);
    copied += 1;
  }
  const ticks = await runTicks(dirs, baseCfg(dirs, { maxBytesPerSession: 16 * 1024 * 1024 }), 4);
  const led = scanLedger(dirs.root);
  const ok = led.rows > 0;
  meta.labs['lab-corpus'] = {
    ok,
    root: dirs.root,
    sessions: dirs.sessions,
    rows: led.rows,
    ledgerDays: led.days,
    badLines: led.badLines,
    copiedFiles: copied,
    source: `corpus:${corpus.dir}`,
    ticks: ticks.map((t) => ({ tick: t.tick, ms: t.ms, written: t.stat && t.stat.written, err: t.err })),
    why: ok ? '' : '台账为空',
  };
  return meta.labs['lab-corpus'];
}

// ============================================================================
// 七、主流程
// ============================================================================
async function main() {
  if (CLEAN) {
    const existed = fs.existsSync(OUT);
    if (existed) fs.rmSync(OUT, { recursive: true, force: true });
    const res = { cleaned: existed, out: OUT };
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else log(existed ? `已删除 ${OUT}` : `无需清理（不存在 ${OUT}）`);
    return 0;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const metaPath = path.join(OUT, '_labs.json');
  const meta = {
    schema: 'labs-1.0/2',
    tool: 'docs/工具-构造lab.mjs',
    out: OUT,
    at: new Date(Date.now() + OFF).toISOString().replace('Z', '+08:00'),
    node: process.version,
    // ★ K-18：指纹 —— 复用前必须与当前"包版本 + 构造器内容 + 产品管线"一致，否则视为陈旧强制重建。
    fingerprint: {
      packageVersion: PKG_VERSION,
      builderSha: (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(THIS_FILE)).digest('hex'); } catch { return ''; } })(),
      pipelineSha: PIPELINE_SHA, // ★ 2026-11 审计：index.js + tools/pointerindex.mjs 的 sha256 拼接后再 sha256
      contract: CONTRACT_ID,
    },
    source: {},
    labs: {},
  };

  const corpus = resolveCorpus(argOf('corpus'));
  meta.source = {
    corpusDir: corpus.dir,
    corpusSessions: corpus.sessions,
    corpusFiles: corpus.files.length,
    corpusBytes: sum(corpus.files, (f) => f.size),
    fallback: corpus.files.length ? '' : '未给 --corpus → e3 用确定性合成会话（zstd≈35MB/1338轮/3tick；不读桌面语料）',
  };
  log(`[构造lab] 输出 ${OUT}`);
  log(`[构造lab] 语料 ${corpus.files.length ? `${corpus.dir}（${corpus.files.length} 文件 / ${(sum(corpus.files, (f) => f.size) / 1024 / 1024).toFixed(1)} MiB）` : '（未给 --corpus → e3 确定性合成）'}`);

  const need = (name) => ONLY.includes(name);
  const builders = [];
  if (need('c01')) builders.push(['c01-lab', () => buildC01(OUT, meta)]);
  if (need('e3')) builders.push(['lab-e3-accept', () => buildE3(OUT, meta, corpus)]);
  if (need('three')) builders.push(['lab-094-3layer', () => buildThree(OUT, meta)]);
  if (need('weeks')) builders.push(['lab-weeks', () => buildWeeks(OUT, meta)]);
  if (need('corpus')) builders.push(['lab-corpus', () => buildCorpusLab(OUT, meta, corpus)]);

  let failed = 0;
  // ★ 复用判定只认**本次运行开始前**的 _labs.json：下面每造完一个 lab 就落盘，磁盘上的 fingerprint
  //   会被本次运行覆盖；若每轮重读，就会出现"先重建 c01 → 指纹文件被刷新 → 同一次运行里后面的陈旧 lab
  //   反而判指纹一致而复用"的漏判（2026-11 实测：builderSha 已变，c01 重建后 weeks 仍被判复用）。
  const prevMetaAtStart = (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; } })();
  for (const [name, fn] of builders) {
    const labDir = name === 'lab-corpus' ? path.join(OUT, 'lab-corpus') : path.join(OUT, name);
    if (fs.existsSync(labDir) && !FORCE) {
      // ★ K-18：只有"包版本 + 构造器 + 产品管线 + contract"四个指纹字段全对得上才复用；
      //   任一对不上 = 陈旧 lab，强制重建（含"产品打补丁但包版本/构造器没变"的情况）。
      const prevMeta = prevMetaAtStart;
      const prevFp = prevMeta && prevMeta.fingerprint ? prevMeta.fingerprint : null;
      const sameFp = !!(prevFp &&
        prevFp.packageVersion === meta.fingerprint.packageVersion &&
        prevFp.builderSha === meta.fingerprint.builderSha &&
        prevFp.pipelineSha === meta.fingerprint.pipelineSha &&
        prevFp.contract === meta.fingerprint.contract);
      const prev = (prevMeta && prevMeta.labs && prevMeta.labs[name]) || null;
      // ★ 上次明确登记 ok:false（失败/半成品）→ 不能"指纹一致就复用"，必须重建；
      //   未登记（--only 局部跑会重写总表）不据此否决，交指纹判断。
      const prevNotFailed = !prev || prev.ok !== false;
      if (sameFp && prevNotFailed) {
        // 复用旧的（如实登记：只记存在，不声称本次构造）。
        // ★ 2026-11 审计：必须保留上次的 source/sourceSha256 等来源字段——否则 _labs.json 丢掉
        //   "这库是合成还是真语料造的"，C38 来源门控/收件复核无从判断。
        meta.labs[name] = { ...(prev || {}), ok: true, reused: true, root: path.join(labDir, 'root'), why: '' };
        log(`[构造lab] ${name}: 已存在且指纹一致（复用；--force 可重建）${prev && prev.source ? `｜source=${prev.source}` : ''}`);
        continue;
      }
      log(
        !sameFp
          ? `[构造lab] ${name}: 已存在但指纹不符（包版本/构造器/产品管线已变）→ 强制重建`
          : `[构造lab] ${name}: 已存在但上次登记 ok:false（半成品）→ 强制重建`,
      );
    }
    if (fs.existsSync(labDir)) fs.rmSync(labDir, { recursive: true, force: true });
    const t0 = Date.now();
    try {
      const r = await fn();
      log(`[构造lab] ${name}: ${r.ok ? 'OK' : 'FAIL'}（${Date.now() - t0} ms）${r.rows != null ? ` rows=${r.rows}` : ''}${r.why ? ` :: ${r.why}` : ''}`);
      if (!r.ok) failed += 1;
    } catch (e) {
      failed += 1;
      meta.labs[name] = { ok: false, why: `构造异常：${String((e && e.stack) || e)}` };
      logErr(`[构造lab] ${name}: 异常 ${String((e && e.message) || e)}`);
    }
    // 每造完一个就落盘（机器可能回滚，产物要尽早落）
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  meta.cleanup = 'node docs\\工具-构造lab.mjs --clean（lab 是生成物；出包前必须删，或用 --out 指向包外）';
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  const summary = {
    ok: failed === 0,
    out: OUT,
    meta: metaPath,
    built: builders.map(([n]) => n).filter((n) => meta.labs[n]),
    failed,
    labs: Object.fromEntries(Object.entries(meta.labs).map(([k, v]) => [k, { ok: v.ok, rows: v.rows, reused: v.reused || false, why: v.why || '' }])),
  };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    log('');
    log(`[构造lab] 完成：${failed === 0 ? '全部就绪' : `${failed} 个失败`}｜总表 ${metaPath}`);
    for (const [k, v] of Object.entries(meta.labs)) {
      log(`  · ${k}: ${v.ok ? 'OK' : 'FAIL'}${v.rows != null ? ` rows=${v.rows}` : ''}${v.reused ? '（复用）' : ''}${v.why ? ` :: ${v.why}` : ''}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[构造lab] 致命异常：${String((e && e.stack) || e)}`);
    process.exit(2);
  });
