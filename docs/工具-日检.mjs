#!/usr/bin/env node
/**
 * @file 工具-日检.mjs
 * @role C19「中段改写（只改中段、头尾不动）→ 当天全量核发现」的**日检器**，外加每日体检与报告落盘。
 *
 *   ① C19 中段改写检测：复用 `docs/replay-verify.mjs` 的**逐轮全量重放**（--fields 模式），
 *      把「台账行」与「源会话重放出来的应有行」逐字段比（sid/turn/ts/seq/status/doc/attachment/code，
 *      外加附件字节的磁盘 sha256）。只改中段、头尾不动、size/mtime 都不变的改写，重放后会
 *      "少/多/错一个字段或一份附件"→ 判红，并靠 code/sid/turn 定位到**哪一轮**。
 *   ② 每日体检：调用 `tools/doctor.mjs --json`（5 类：①数据完整性 ②编码一致性 ③采集健康
 *      ④存储健康 ⑤运行报告），把结果并进同一份日检报告。
 *   ③ 报告：`<root>/报告/日检-YYYYMMDD-NN.json`（tmp + fsync + rename 原子写；同日序号只增不覆盖），
 *      报告内嵌一页人读文本（红项排最前），`--json` 时 stdout 直接吐这份报告。
 *   ④ 退出码：0 全绿 / 1 有红 / 2 用法或环境错误 / 3 **日检器自身失效**。3 必须与 1 区分：
 *      "重放器压根没跑起来却报绿"是 3，不是 0；"重放器跑起来但账对不上"才是 1。
 *
 * @why 为什么必须放在 tick 外（与 `_工作/计划/0.9.3-P2稳产方案.md` §3.6 一致）：
 *   · 全量重放 = 1× 语料/天（现在 50 MB 级 ≈ 百 ms；三年库 104 GB 压缩 → 十分钟级）；
 *     放进 tick 会把某一轮变成"十分钟 tick"，直接撞 C25 的 30 s 预算；
 *   · 总纲 S-7 已把"重放类全量核"整体移出 tick（与 C14–C16 / replay-verify 同性质）；
 *   · tick 里的 `size + 头指纹 + 尾指纹 + mtime` 采样**结构上看不出中段改写**（§3.3/§3.6），
 *     必须有这条与 tick 解耦、有独立证据的复核线。
 *
 * 用法（离线、只读、不进 tick）：
 *   node docs/工具-日检.mjs --root=<账库根> --sessions=<sessions 目录> [--json] [--maxDetail=N]
 *   node docs/工具-日检.mjs --root=... --sessions=... --readonly-sha   # 只读守卫升级为全树 sha256（贵）
 *   node docs/工具-日检.mjs --root=... --sessions=... --source-sha     # 源会话记整文件 sha256（C19 证据/跨日比对）
 *   node docs/工具-日检.mjs --root=... --sessions=... --replay=<桩> --doctor=<桩>   # 仅排障/自测用
 *   node docs/工具-日检.mjs --help
 *
 *   参数：
 *     --root=<目录>       必填；已 ingest 的账库根（必须有 ledger/）
 *     --sessions=<目录>   必填；源会话根（DSH_HOME/sessions；必须是该账库的**全集来源**，重放口径由 replay-verify 决定）
 *     --json              stdout 只输出机读 JSON（= 报告形状，与人读摘要不混排）
 *     --maxDetail=N       人读页里最多列 N 条不一致明细（默认 20；完整明细始终在报告 JSON 里）
 *     --readonly-sha      只读守卫 = 全树 sha256（默认只 stat：size+mtime；全树哈希代价 = 一遍读账库）
 *     --source-sha        源会话清单里记整文件 sha256（默认只 stat）→ 报告可与上一份日检比"整文件是否变"
 *     --replay=<文件>     重放器路径（默认 docs/replay-verify.mjs；**仅排障/自测**，正常跑不要传）
 *     --doctor=<文件>     体检器路径（默认 tools/doctor.mjs；同上）
 *     --help / -h         显示本说明
 *
 * 退出码（与 replay-verify 的 0/1/2/3 风格一致）：
 *   0 = 全绿：C19 全量重放一致 + doctor 5 类无红、无"未知"（warning 不算红，与 doctor 的 0/1 口径对齐）
 *   1 = 有红：重放发现不一致（中段改写/台账被改/附件不符…），或 doctor 有红
 *   2 = 用法/环境错误：缺参、root/ledger/sessions 不存在、报告写不出、doctor/重放器报"环境错误"
 *   3 = **日检器自身失效**：子进程没跑起来/超时/非 0-1 退出/输出不是合法 JSON/
 *       回显的 root|sessions 与本次不符/"一行都没比却报绿"（compared≠pairs）/doctor 检查数≠5 等。
 *       ★ 这一档的存在意义：**不许把"器坏了"伪装成"绿"或"红"**。
 *
 * 只读契约（写死在实现里）：
 *   · 唯一写动作 = `<root>/报告/日检-YYYYMMDD-NN.json`（目录可建、文件只增不覆盖、tmp+rename 原子写）；
 *     除 `报告/` 外**零写入**：不写 `.lost.jsonl`/`.errors.jsonl`/`.source-dirty.jsonl`，不触发撕裂尾巴自愈；
 *   · 读台账用 `ledger.readAll(root, {requireLedgerRows:true, repairTornTail:false})`（与 doctor 同一只读口径）；
 *   · doctor 用 `--no-write` 调用（连它自己的报告都不落，报告由日检这一份统一承载）；
 *   · 日检自己前后各拍一次账库树快照（排除 `报告/`），前后不一致 → `readonly-guard` 判红：
 *     要么有别的进程在写，要么日检自己越界了 —— 两种都必须当场看见。
 *
 * 已知边界（如实写，别把"没判"当"判过"）：
 *   · C19 只保证**下次日检发现**，不承诺"当场发现"（中段改写本来就不在 size/mtime 采样能力内）；
 *   · 源会话整帧坏掉时，重放只能靠"这一轮重放不出来 / 附件对不上"定位到**轮**（甚至只能定位到源文件），
 *     不能保证指出被改的那个字节；
 *   · `--source-sha` 的"跨报告 sha 变化"只是**线索（warn，不参与退出码）**：C19 的判据是重放比对，
 *     跨报告 sha 变化也可能是同日重跑/还原演练导致的；
 *   · 本文件不被 `index.js`/`lib/` 引用（不进 tick）；放 docs/ 是"离线验具"的既有位置。
 *
 * @depends node:fs / node:path / node:os / node:crypto / node:child_process / node:url；
 *          ../lib/ledger.js（readAll）、../lib/legacy.js（scanSessionSources）；
 *          `docs/replay-verify.mjs`（子进程，--json）、`tools/doctor.mjs`（子进程，--json --no-write）
 * @called-by 人工 / Windows 计划任务 / DSH 定时任务（每天一次；证据落 `<root>/报告/`）
 * @writes 仅 `<root>/报告/日检-YYYYMMDD-NN.json`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readAll } from '../lib/ledger.js';
import { scanSessionSources } from '../lib/legacy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

/** 默认子工具（都在同一个仓库里；`--replay/--doctor` 只给排障/自测用）。 */
const DEFAULT_REPLAY = path.join(SRC, 'docs', 'replay-verify.mjs');
const DEFAULT_DOCTOR = path.join(SRC, 'tools', 'doctor.mjs');

/** 退出码常量的唯一出处（3 = 日检器自身失效，绝不许与 1 混用）。 */
const EXIT = Object.freeze({ GREEN: 0, RED: 1, USAGE: 2, BROKEN: 3 });
const EXIT_LABEL = Object.freeze({ 0: '绿', 1: '红', 2: '用法/环境错误', 3: '日检器自身失效' });

const SCHEMA = 'lite-daily/1';
const TOOL_VERSION = '1.0';

/** UTC+08:00：本仓库所有时间戳口径（契约禁止 Z 结尾）。 */
const OFFSET_MINUTES = 480;

/** 报告目录（账库根下唯一允许写的一级目录）与文件命名。 */
const REPORT_DIR_NAME = '报告';
const REPORT_RE = /^日检-(\d{4})(\d{2})(\d{2})-(\d{2})\.json$/;

/** 人读明细默认上限（报告 JSON 里始终是完整的）。 */
const DEFAULT_MAX_DETAIL = 20;

/** 子进程超时：重放 = 全量读语料，给足；doctor = 只读体检。超时按"日检器失效"算（3）。 */
const REPLAY_TIMEOUT_MS = 30 * 60 * 1000;
const DOCTOR_TIMEOUT_MS = 10 * 60 * 1000;

/** doctor 的 5 类检查（顺序即规范顺序；与 tools/doctor.mjs 的 CHECK_DEFS 对齐）。 */
const DOCTOR_CHECK_IDS = ['data-integrity', 'code-consistency', 'ingest-health', 'storage-health', 'run-report'];

const USAGE = `用法：node docs/工具-日检.mjs --root=<账库根> --sessions=<sessions 目录> [选项]
  --root=<目录>      必填；已 ingest 的账库根（必须有 ledger/）
  --sessions=<目录>  必填；源会话根（重放口径 = replay-verify：必须是该账库的全集来源）
  --json             stdout 只输出机读 JSON（= 报告文件形状）
  --maxDetail=N      人读页最多列 N 条不一致明细（默认 ${DEFAULT_MAX_DETAIL}）
  --readonly-sha     只读守卫升级为全树 sha256（默认只 stat：size+mtime）
  --source-sha       源会话清单记整文件 sha256（默认只 stat）
  --replay=<文件>    重放器（默认 docs/replay-verify.mjs；仅排障/自测）
  --doctor=<文件>    体检器（默认 tools/doctor.mjs；仅排障/自测）
  --help / -h        显示本说明

退出码：0=全绿 1=有红 2=用法/环境错误 3=日检器自身失效（器坏了，不是账坏了）
只读：除 <root>/报告/日检-YYYYMMDD-NN.json 外不写账库任何文件；不写 .lost、不自愈；不进 tick。`;

// ============================================================================
// 一、命令行
// ============================================================================

const argv = process.argv.slice(2);
const argOf = (k, d = '') => {
  const a = argv.find((x) => x === k || x.startsWith(k + '='));
  if (!a) return d;
  const i = a.indexOf('=');
  return i < 0 ? true : a.slice(i + 1);
};
const hasFlag = (k) => argv.includes(k);

const RAW = {
  root: String(argOf('--root', '') || ''),
  sessions: String(argOf('--sessions', '') || ''),
  json: !!argOf('--json', false),
  maxDetailRaw: argOf('--maxDetail', argOf('--max-detail', DEFAULT_MAX_DETAIL)),
  readonlySha: !!argOf('--readonly-sha', false),
  sourceSha: !!argOf('--source-sha', false),
  replay: String(argOf('--replay', '') || ''),
  doctor: String(argOf('--doctor', '') || ''),
  help: hasFlag('--help') || hasFlag('-h'),
};

function usageExit(msg) {
  if (RAW.json) console.log(JSON.stringify({ schema: SCHEMA, ok: false, exitCode: EXIT.USAGE, error: msg }, null, 2));
  else {
    console.error('[用法/环境错误] ' + msg);
    console.error('');
    console.error(USAGE);
  }
  process.exitCode = EXIT.USAGE;
  return EXIT.USAGE;
}

// ============================================================================
// 二、小工具
// ============================================================================

const pad2 = (n) => String(n).padStart(2, '0');
const sha256Hex = (v) => crypto.createHash('sha256').update(Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')).digest('hex');
const sha256File = (p) => sha256Hex(fs.readFileSync(p));
const errMsg = (e) => (e && e.message ? e.message : String(e));
const iso = (ms = Date.now()) => new Date(ms + OFFSET_MINUTES * 60000).toISOString().replace('Z', '+08:00');
const localYmd = (ms = Date.now()) => iso(ms).slice(0, 10).replace(/-/g, '');
const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

/** 给 stdout 的人读摘要用：字符串/数字/对象都压成一行短文本。 */
const short = (v, n = 160) => {
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** 人读页里 severity 的排序权重（红项最前）。 */
const SEV_RANK = Object.freeze({ red: 0, unknown: 1, warn: 2, ok: 3 });
const SEV_LABEL = Object.freeze({ red: '红', unknown: '未知', warn: '黄', ok: '绿' });

// ============================================================================
// 三、账库树快照（只读守卫：前后各拍一次，排除 报告/）
// ============================================================================

/**
 * 拍一次账库树快照。
 * @param {string} root 账库根
 * @param {{withSha?:boolean, excludeTop?:string}} opts
 *        withSha：每文件算 sha256（贵；默认只 stat size+mtimeMs）
 *        excludeTop：根下要排除的一级目录名（日检固定排除 `报告/` —— 那是唯一允许写的目录）
 * @returns {{mode:string, entries:Array<object>, errors:Array<object>, files:number, dirs:number,
 *            totalBytes:number, digest:string, elapsedMs:number}}
 */
function snapshotTree(root, opts = {}) {
  const t0 = Date.now();
  const withSha = opts.withSha === true;
  const excludeTop = String(opts.excludeTop || '');
  const entries = [];
  const errors = [];

  const walk = (dir, relBase) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ rel: relBase || '.', error: errMsg(e) });
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (!relBase && excludeTop && ent.name === excludeTop) continue; // 报告/ 是唯一允许写的目录
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        let st = null;
        try { st = fs.statSync(abs); } catch (e) { errors.push({ rel, error: errMsg(e) }); continue; }
        // 目录只记 mtimeMs：新增/删除文件已由文件清单覆盖；目录 mtime 变化本身也是"有人动过"的痕迹
        entries.push({ kind: 'dir', rel, bytes: 0, mtimeMs: st.mtimeMs });
        walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue; // 符号链接/特殊文件不纳入（Windows 账库里不该有）
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { errors.push({ rel, error: errMsg(e) }); continue; }
      const rec = { kind: 'file', rel, bytes: st.size, mtimeMs: st.mtimeMs };
      if (withSha) {
        try { rec.sha256 = sha256File(abs); } catch (e) { errors.push({ rel, error: errMsg(e) }); rec.sha256 = ''; }
      }
      entries.push(rec);
    }
  };
  walk(root, '');

  const lines = entries
    .map((e) => `${e.kind}\t${e.rel}\t${e.bytes}\t${e.mtimeMs}\t${e.sha256 || '-'}`)
    .sort();
  return {
    mode: withSha ? 'stat+sha256' : 'stat',
    entries,
    errors,
    files: entries.filter((e) => e.kind === 'file').length,
    dirs: entries.filter((e) => e.kind === 'dir').length,
    totalBytes: entries.reduce((a, e) => a + (e.kind === 'file' ? e.bytes : 0), 0),
    digest: sha256Hex(lines.join('\n')),
    elapsedMs: Date.now() - t0,
  };
}

/** 两次快照的差异（空 added/removed/changed = 只读成立）。 */
function diffSnapshots(before, after) {
  const bMap = new Map(before.entries.map((e) => [e.rel, e]));
  const aMap = new Map(after.entries.map((e) => [e.rel, e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, e] of aMap) {
    const prev = bMap.get(rel);
    if (!prev) { added.push({ rel, kind: e.kind, bytes: e.bytes }); continue; }
    const why = [];
    if (prev.kind !== e.kind) why.push('kind');
    if (prev.bytes !== e.bytes) why.push('bytes');
    if (prev.mtimeMs !== e.mtimeMs) why.push('mtime');
    if (after.mode === 'stat+sha256' && before.mode === 'stat+sha256' && prev.sha256 !== e.sha256) why.push('sha256');
    if (why.length) changed.push({ rel, kind: e.kind, why, beforeBytes: prev.bytes, afterBytes: e.bytes });
  }
  for (const rel of bMap.keys()) if (!aMap.has(rel)) removed.push({ rel, kind: bMap.get(rel).kind });
  return { added, removed, changed, clean: added.length === 0 && removed.length === 0 && changed.length === 0 };
}

// ============================================================================
// 四、子进程：跑 node 子工具，拿 stdout 的纯 JSON
// ============================================================================

/**
 * 跑一个 node 子工具并取回 stdout/stderr/退出码。
 *
 * @why 为什么要留"临时文件重定向"这条退路：受限沙箱下 `spawn(..., {stdio:'pipe'})`
 *      可能因命名管道 EPERM 而失败（`docs/跑测试.mjs` 的注释已记过这个坑）。
 *      遇到管道类错误就退到"stdout/stderr 各写一个临时文件"再读回来 —— 结果等价，且不碰账库。
 *
 * @returns {{status:number|null, signal:string|null, error:string, stdout:string, stderr:string,
 *            durationMs:number, via:string, timedOut:boolean}}
 */
function runNodeJson(scriptPath, args, timeoutMs) {
  const t0 = Date.now();
  const base = { status: null, signal: null, error: '', stdout: '', stderr: '', durationMs: 0, via: 'pipe', timedOut: false };
  const spawn = (extra) => spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs,
    ...extra,
  });
  let r = spawn({});
  if (r.error && r.error.code) {
    // ENOENT（脚本不存在）不是管道问题，重试也没用 → 直接如实回传
    const pipeLike = ['EPERM', 'EACCES', 'EAGAIN', 'UNKNOWN'].includes(r.error.code);
    if (pipeLike) {
      let dir = '';
      try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daily-'));
        const outP = path.join(dir, 'stdout.txt');
        const errP = path.join(dir, 'stderr.txt');
        const fdO = fs.openSync(outP, 'w');
        const fdE = fs.openSync(errP, 'w');
        try {
          r = spawn({ stdio: ['ignore', fdO, fdE], encoding: undefined });
          r.stdout = fs.readFileSync(outP, 'utf8');
          r.stderr = fs.readFileSync(errP, 'utf8');
          r.via = 'temp-file';
        } finally {
          try { fs.closeSync(fdO); } catch { /* ignore */ }
          try { fs.closeSync(fdE); } catch { /* ignore */ }
        }
      } catch (e) {
        return { ...base, error: '子进程无法启动且临时重定向也失败：' + errMsg(e), durationMs: Date.now() - t0 };
      } finally {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
      }
    }
  }
  const errCode = r.error && r.error.code ? String(r.error.code) : '';
  const timedOut = errCode === 'ETIMEDOUT';
  return {
    status: typeof r.status === 'number' ? r.status : null,
    signal: r.signal || null,
    error: r.error ? (errCode ? errCode + ': ' : '') + errMsg(r.error) : '',
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    durationMs: Date.now() - t0,
    via: r.via || base.via,
    timedOut,
  };
}

// ============================================================================
// 五、C19：跑 replay-verify --json，并检验"它真的跑了、真的比了"
// ============================================================================

/**
 * 跑重放器并做**自失效判定**：只要有一项对不上，返回 broken=true（调用方 → exit 3），
 * 绝不许把"器没跑起来/没比一行"当成绿。
 *
 * @returns {{
 *   broken:boolean, envError:boolean, ok:boolean|null, exitCode:number|null,
 *   brokenReason:string, envReason:string, replayPath:string,
 *   json:object|null, invariants:Array<{id:string,ok:boolean,detail:string}>,
 *   mismatches:Array<object>, locatedTurns:Array<object>, byKind:object,
 *   ledgerMap:Map<string,object>|null, ledgerReadError:string,
 *   sources:Array<object>, sourceDrift:object|null,
 *   elapsedMs:number, stderrTail:string
 * }}
 */
function runC19(ctx) {
  const inv = [];
  const push = (id, ok, detail = '') => inv.push({ id, ok: !!ok, detail: String(detail || '') });
  const out = {
    broken: false, envError: false, ok: null, exitCode: null,
    brokenReason: '', envReason: '', replayPath: ctx.replayPath,
    json: null, invariants: inv, mismatches: [], locatedTurns: [], byKind: {},
    ledgerMap: null, ledgerReadError: '',
    sources: [], sourceDrift: null,
    elapsedMs: 0, stderrTail: '',
  };
  const broken = (reason) => { out.broken = true; out.brokenReason = reason; return out; };

  // ---- ⓪ 重放器文件必须存在（不存在 = 安装坏了，属"器失效"而不是用法错误）----
  if (!fs.existsSync(ctx.replayPath)) {
    push('replay-exists', false, '找不到重放器：' + ctx.replayPath);
    return broken('找不到重放器（docs/replay-verify.mjs）：' + ctx.replayPath);
  }
  push('replay-exists', true);

  // ---- ① 跑起来 ----
  const run = runNodeJson(ctx.replayPath, ['--root=' + ctx.root, '--sessions=' + ctx.sessions, '--json'], REPLAY_TIMEOUT_MS);
  out.elapsedMs = run.durationMs;
  out.stderrTail = short(run.stderr.trim(), 400);
  push('replay-spawn', run.error === '' && run.signal === null, run.error || (run.signal ? 'signal=' + run.signal : ''));
  if (run.error || run.signal) return broken('重放器没跑起来：' + (run.error || 'signal=' + run.signal));
  if (run.timedOut) return broken('重放器超时（>' + Math.round(REPLAY_TIMEOUT_MS / 60000) + ' 分钟）');
  push('replay-exit-code', run.status === 0 || run.status === 1, 'exit=' + run.status);
  if (run.status === EXIT.USAGE) {
    out.envError = true;
    out.envReason = '重放器报用法/环境错误（exit 2）：' + short(run.stderr.trim() || run.stdout.trim(), 300);
    return out;
  }
  if (run.status !== 0 && run.status !== 1) {
    return broken('重放器退出码异常（exit=' + run.status + '；只允许 0/1，3=其自检失效/其它=执行异常）：' + short(run.stderr.trim(), 300));
  }

  // ---- ② 输出必须是纯 JSON，且形状对 ----
  let j = null;
  try { j = JSON.parse(run.stdout); } catch (e) {
    push('replay-json', false, 'stdout 不是合法 JSON：' + short(run.stdout.trim(), 200));
    return broken('重放器 stdout 不是合法 JSON（exit=' + run.status + '）：' + errMsg(e));
  }
  out.json = j;
  push('replay-json', true);
  push('replay-schema', j.schema === 'v091-replay-verify/1', 'schema=' + String(j.schema));
  push('replay-mode', j.mode === 'fields', 'mode=' + String(j.mode));
  if (j.schema !== 'v091-replay-verify/1' || j.mode !== 'fields') {
    return broken('重放器输出形状不对（schema=' + String(j.schema) + ' mode=' + String(j.mode) + '）');
  }

  // ---- ③ 回显的 root/sessions 必须就是本次这两个（防"指错目录还报绿"）----
  push('replay-echo-root', samePath(j.root, ctx.root), 'root=' + String(j.root));
  push('replay-echo-sessions', samePath(j.sessions, ctx.sessions), 'sessions=' + String(j.sessions));
  if (!samePath(j.root, ctx.root) || !samePath(j.sessions, ctx.sessions)) {
    return broken('重放器回显的 root/sessions 与本次不符（root=' + String(j.root) + ' sessions=' + String(j.sessions) + '）');
  }

  // ---- ④ ok / exitCode / mismatches 三者必须自洽 ----
  const mismatches = Array.isArray(j.mismatches) ? j.mismatches : null;
  const selfConsistent = typeof j.ok === 'boolean' && Number.isInteger(j.exitCode) && mismatches !== null
    && j.ok === (j.exitCode === 0) && j.ok === (mismatches.length === 0);
  push('replay-self-consistent', selfConsistent,
    'ok=' + String(j.ok) + ' exitCode=' + String(j.exitCode) + ' mismatches=' + (mismatches === null ? '非数组' : mismatches.length));
  if (!selfConsistent) return broken('重放器输出自相矛盾（ok/exitCode/mismatches 对不上）');

  out.ok = j.ok;
  out.exitCode = j.exitCode;
  out.mismatches = mismatches;

  // ---- ⑤ 覆盖性：绿的时候必须真的"比过"（没比一行却报绿 = 3）----
  const counts = j.counts && typeof j.counts === 'object' ? j.counts : {};
  const compared = Number(j.compared);
  const pairs = Number(counts.pairs);
  const replayedTurns = Number(j.replayedTurns);
  const ledgerRows = Number(j.ledgerRows);
  const coverageOk = Number.isFinite(compared) && Number.isFinite(pairs) && Number.isFinite(replayedTurns) && Number.isFinite(ledgerRows)
    && (!j.ok || (compared === pairs && !(counts.replayedSessions > 0 && ledgerRows > 0 && compared === 0)))
    && Number.isFinite(Number(j.elapsedMs)) && Number.isFinite(Date.parse(String(j.generatedAt || '')));
  push('replay-coverage', coverageOk,
    'compared=' + String(j.compared) + ' pairs=' + String(counts.pairs) + ' replayedTurns=' + String(j.replayedTurns) +
    ' ledgerRows=' + String(j.ledgerRows) + ' replayedSessions=' + String(counts.replayedSessions) + ' elapsedMs=' + String(j.elapsedMs));
  if (!coverageOk) return broken('重放器报绿但覆盖性对不上（compared/pairs/计数/时间戳有一项不成立）');

  // ---- ⑥ 台账行索引（code → sid/turn），只用来把不一致"定位到轮" ----
  try {
    const all = readAll(ctx.root, { requireLedgerRows: true, repairTornTail: false });
    const map = new Map();
    for (const r of all.records || []) {
      if (r && typeof r.code === 'string' && !map.has(r.code)) map.set(r.code, r);
    }
    out.ledgerMap = map;
    out.ledgerReadError = all.ok ? '' : 'readAll.ok=false（badLines=' + all.badLines + '）';
  } catch (e) {
    out.ledgerReadError = errMsg(e);
  }

  // ---- ⑦ 不一致 → 定位轮 ----
  const byKind = {};
  const locate = (m) => {
    let code = typeof m.code === 'string' ? m.code : '';
    let row = null;
    if (code && out.ledgerMap) row = out.ledgerMap.get(code) || null;
    let sid = row ? row.sid : '';
    let turn = row ? row.turn : null;
    if (!row) {
      // 变异类不一致（EXTRA_ROW/MISSING_ROW）只在 expected/actual 文本里带 sid/turn
      const txt = String(m.expected || '') + ' ' + String(m.actual || '');
      const mst = /sid=([^\s,)]+)\s+turn=([0-9]+)/.exec(txt);
      if (mst) { sid = mst[1]; turn = Number(mst[2]); }
      else {
        const mt = /\bturn=([0-9]+)\b/.exec(txt);
        const ms = /\bsid=([^\s,)]+)/.exec(txt);
        if (mt) turn = Number(mt[1]);
        if (ms) sid = ms[1];
      }
    }
    return {
      code,
      sid: sid || '',
      turn: Number.isInteger(turn) ? turn : null,
      kind: typeof m.kind === 'string' ? m.kind : '',
      field: typeof m.field === 'string' ? m.field : '',
    };
  };
  const turnKeyOf = new Map();
  for (const m of mismatches) {
    const loc = locate(m);
    const k = (loc.code || '') + '|' + (loc.sid || '') + '|' + String(loc.turn === null ? '' : loc.turn);
    let rec = turnKeyOf.get(k);
    if (!rec) {
      rec = { code: loc.code, sid: loc.sid, turn: loc.turn, kinds: [], fields: [], count: 0 };
      turnKeyOf.set(k, rec);
      out.locatedTurns.push(rec);
    }
    rec.count++;
    if (loc.kind && !rec.kinds.includes(loc.kind)) rec.kinds.push(loc.kind);
    if (loc.field && !rec.fields.includes(loc.field)) rec.fields.push(loc.field);
    byKind[loc.kind || 'UNKNOWN'] = (byKind[loc.kind || 'UNKNOWN'] || 0) + 1;
  }
  out.byKind = byKind;

  // ---- ⑧ 源会话清单（stat；--source-sha 时加整文件 sha256）+ 与上一份日检比 sha ----
  try {
    const scanned = scanSessionSources(ctx.sessions);
    out.sources = (scanned.supported || []).map((s) => {
      const rec = {
        sid: s.sid || '',
        source: s.source,
        version: s.version,
        dir: s.dir,
        path: s.path,
        file: path.basename(s.path),
        bytes: s.size,
        mtimeMs: s.mtimeMs,
      };
      if (ctx.sourceSha) {
        try { rec.sha256 = sha256File(s.path); } catch (e) { rec.sha256 = ''; rec.shaError = errMsg(e); }
      }
      return rec;
    }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    out.sourcesUnsupported = (scanned.unsupported || []).map((s) => ({ path: s.path, version: s.version }));
  } catch (e) {
    out.sources = [];
    out.sourcesError = errMsg(e);
  }
  if (ctx.sourceSha && out.sources.some((s) => s.sha256)) {
    try { out.sourceDrift = compareSourcesWithPrevious(ctx.root, out.sources); } catch (e) { out.sourceDrift = { error: errMsg(e) }; }
  }

  const stillBroken = inv.filter((x) => !x.ok);
  if (stillBroken.length > 0) {
    out.broken = true;
    out.brokenReason = '重放器自检项不成立：' + stillBroken.map((x) => x.id + '(' + x.detail + ')').join('; ');
  }
  return out;
}

// ============================================================================
// 六、daily 体检：跑 doctor --json --no-write，并做同一套"自失效"校验
// ============================================================================

function runDoctorCheck(ctx) {
  const inv = [];
  const push = (id, ok, detail = '') => inv.push({ id, ok: !!ok, detail: String(detail || '') });
  const out = {
    broken: false, envError: false, brokenReason: '', envReason: '',
    doctorPath: ctx.doctorPath, exitCode: null, json: null, invariants: inv,
    summary: null, checks: [], elapsedMs: 0, stderrTail: '',
  };
  const broken = (reason) => { out.broken = true; out.brokenReason = reason; return out; };

  if (!fs.existsSync(ctx.doctorPath)) {
    push('doctor-exists', false, '找不到体检器：' + ctx.doctorPath);
    return broken('找不到体检器（tools/doctor.mjs）：' + ctx.doctorPath);
  }
  push('doctor-exists', true);

  const run = runNodeJson(ctx.doctorPath, ['--root=' + ctx.root, '--sessions=' + ctx.sessions, '--json', '--no-write'], DOCTOR_TIMEOUT_MS);
  out.elapsedMs = run.durationMs;
  out.stderrTail = short(run.stderr.trim(), 400);
  push('doctor-spawn', run.error === '' && run.signal === null, run.error || (run.signal ? 'signal=' + run.signal : ''));
  if (run.error || run.signal) return broken('体检器没跑起来：' + (run.error || 'signal=' + run.signal));
  if (run.timedOut) return broken('体检器超时');

  let j = null;
  try { j = JSON.parse(run.stdout); } catch (e) {
    push('doctor-json', false, 'stdout 不是合法 JSON：' + short(run.stdout.trim(), 200));
    return broken('体检器 stdout 不是合法 JSON（exit=' + run.status + '）：' + errMsg(e));
  }
  out.json = j;
  push('doctor-json', true);
  push('doctor-schema', j.schema === 'doctor/1', 'schema=' + String(j.schema));
  if (j.schema !== 'doctor/1') return broken('体检器输出 schema 不对：' + String(j.schema));

  // doctor 的 --json 与退出码：0=无红无未知；1=有红/未知；2=用法或环境错误
  if (run.status === EXIT.USAGE || j.exitCode === EXIT.USAGE) {
    out.envError = true;
    out.envReason = '体检器报用法/环境错误（exit 2）：' + short(run.stderr.trim() || '', 300);
    return out;
  }
  push('doctor-exit-code', run.status === 0 || run.status === 1, 'exit=' + run.status);
  if (run.status !== 0 && run.status !== 1) {
    return broken('体检器退出码异常（exit=' + run.status + '）：' + short(run.stderr.trim(), 300));
  }
  push('doctor-exit-echo', Number(j.exitCode) === run.status, 'json.exitCode=' + String(j.exitCode) + ' 进程=' + String(run.status));

  const checks = Array.isArray(j.checks) ? j.checks : [];
  const ids = checks.map((c) => String(c && c.id));
  const shapeOk = checks.length === 5 && DOCTOR_CHECK_IDS.every((id) => ids.includes(id))
    && checks.every((c) => c && typeof c.id === 'string' && typeof c.severity === 'string' && typeof c.name === 'string');
  push('doctor-5checks', shapeOk, 'checks=' + ids.join(','));
  if (!shapeOk) return broken('体检器不是 5 类检查（checks=' + ids.join(',') + '）');

  const sum = { ok: 0, warn: 0, red: 0, unknown: 0 };
  for (const c of checks) {
    if (c.severity === 'red') sum.red++;
    else if (c.severity === 'unknown') sum.unknown++;
    else if (c.severity === 'warn') sum.warn++;
    else if (c.severity === 'ok') sum.ok++;
    else sum.unknown++;
  }
  const s = j.summary && typeof j.summary === 'object' ? j.summary : null;
  const sumOk = !!s && s.red === sum.red && s.warn === sum.warn && s.unknown === sum.unknown && s.ok === sum.ok;
  push('doctor-summary', sumOk, 'summary=' + JSON.stringify(s || null) + ' 实测=' + JSON.stringify(sum));
  if (!sumOk) return broken('体检器 summary 与 5 类检查计数对不上');

  const exitConsistent = (Number(j.exitCode) === 0) === (sum.red === 0 && sum.unknown === 0)
    && (Number(j.exitCode) === 1) === (sum.red > 0 || sum.unknown > 0);
  push('doctor-exit-consistent', exitConsistent, 'exitCode=' + String(j.exitCode) + ' red=' + sum.red + ' unknown=' + sum.unknown);
  if (!exitConsistent) return broken('体检器退出码与红/未知计数不自洽');

  out.exitCode = Number(j.exitCode);
  out.summary = sum;
  out.checks = checks;
  const stillBroken = inv.filter((x) => !x.ok);
  if (stillBroken.length > 0) {
    out.broken = true;
    out.brokenReason = '体检器自检项不成立：' + stillBroken.map((x) => x.id + '(' + x.detail + ')').join('; ');
  }
  return out;
}

// ============================================================================
// 七、跨报告：源会话 sha 变化（线索，warn，不参与退出码）
// ============================================================================

/** 列出 `报告/` 下所有日检报告（按 (yyyymmdd, nn) 升序）。 */
function listDailyReports(outDir) {
  let names = [];
  try { names = fs.readdirSync(outDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = REPORT_RE.exec(n);
    if (!m) continue;
    out.push({ name: n, path: path.join(outDir, n), ymd: m[1] + m[2] + m[3], nn: Number(m[4]) });
  }
  out.sort((a, b) => (a.ymd === b.ymd ? a.nn - b.nn : a.ymd < b.ymd ? -1 : 1));
  return out;
}

/** 当天序号：`日检-YYYYMMDD-NN.json` 的 NN 取"同日最大号 +1"（只增不覆盖）。 */
function nextDailySeq(outDir, ymd) {
  let max = 0;
  for (const r of listDailyReports(outDir)) if (r.ymd === ymd && r.nn > max) max = r.nn;
  return max + 1;
}

/**
 * 找**最近一份判定为绿的日检报告**（C19 的"昨天"只认绿状态：拿红的/坏的报告当基准没有意义）。
 * 从最新往回找；历史上都不绿 → 返回 null（本次不做跨报告比对）。
 */
function findLastGreenReport(outDir) {
  const reports = listDailyReports(outDir);
  for (let i = reports.length - 1; i >= 0; i--) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(reports[i].path, 'utf8')); } catch { continue; }
    if (j && j.verdict === 'green' && j.c19 && Array.isArray(j.c19.sources) && j.c19.sources.length > 0) {
      return { report: j, path: reports[i].path, id: reports[i].name };
    }
  }
  return null;
}

/**
 * 与**最近一份绿日检报告**比源会话清单（只比两侧都有 sha256 的条目）。
 * 判定口径：C19 的红/绿由重放比对决定；这里只把"日检之间的源变化"当线索记下来（warn，不参与退出码）。
 * 其中 size 与 mtime 都没变、只有整文件 sha 变了的 = **中段改写的典型指纹**（stealthChanged）。
 * 只认绿报告当基准：红/坏报告本身可能就记录了被改坏的状态（拿它当基准会自证清白）。
 */
function compareSourcesWithPrevious(root, sources) {
  const outDir = path.join(root, REPORT_DIR_NAME);
  const base = findLastGreenReport(outDir);
  if (!base) return { compareTo: '', compareKind: 'last-green', reason: '没有可比的上一份绿日检报告（本次是首份，或历史报告都不绿）', changed: [], stealthChanged: [] };
  const prevPath = base.path;
  const prev = base.report;
  const prevSources = prev && prev.c19 && Array.isArray(prev.c19.sources) ? prev.c19.sources : [];
  const prevMap = new Map(prevSources.filter((s) => s && s.path).map((s) => [path.resolve(s.path).toLowerCase(), s]));
  const changed = [];
  const stealthChanged = [];
  for (const s of sources) {
    const p = prevMap.get(path.resolve(s.path).toLowerCase());
    if (!p || !p.sha256 || !s.sha256) continue;
    if (p.sha256 === s.sha256) continue;
    const rec = {
      path: s.path, sid: s.sid, file: s.file,
      prevSha: p.sha256, curSha: s.sha256,
      prevBytes: p.bytes, curBytes: s.bytes,
      prevMtimeMs: p.mtimeMs, curMtimeMs: s.mtimeMs,
      sizeSame: p.bytes === s.bytes,
      mtimeSame: p.mtimeMs === s.mtimeMs,
    };
    changed.push(rec);
    if (rec.sizeSame && rec.mtimeSame) stealthChanged.push(rec); // ★ 头尾/size/mtime 都看不出来的变化
  }
  return { compareTo: prevPath, compareId: base.id, compareKind: 'last-green', changed, stealthChanged };
}

// ============================================================================
// 八、组装检查项 / 结论
// ============================================================================

function mkCheck(id, name, severity, message, details = {}) {
  return { id, name, ok: severity === 'ok' || severity === 'warn', severity, message, details };
}

/** doctor 的一类"未知"= 读不到/没测（不许当绿）→ 在日检里按红算（退出码仍是 1，不是 3）。 */
const doctorSevToDaily = (sev) => (sev === 'red' || sev === 'unknown' ? 'red' : sev === 'warn' ? 'warn' : 'ok');
const maxSev = (list) => {
  let best = 'ok';
  for (const s of list) if (SEV_RANK[s] < SEV_RANK[best]) best = s;
  return best;
};

/** 用 C19 + doctor + 只读守卫 + 源 sha 线索，拼出统一检查表与结论。 */
function buildVerdict(parts) {
  const checks = [];
  const { c19, doc, readonly, ctx } = parts;

  // ── ① C19：中段改写（账 vs 源逐轮全量重放）──
  if (c19.broken) {
    checks.push(mkCheck('C19-replay-fields', 'C19 中段改写检测（账 vs 源逐轮全量重放）', 'unknown',
      '日检器自身失效：' + short(c19.brokenReason, 300), { invariants: c19.invariants }));
  } else if (c19.envError) {
    checks.push(mkCheck('C19-replay-fields', 'C19 中段改写检测（账 vs 源逐轮全量重放）', 'unknown',
      '重放器无法成立：' + short(c19.envReason, 300), { invariants: c19.invariants }));
  } else {
    const j = c19.json || {};
    const base = '台账 ' + String(j.ledgerRows) + ' 行 / 重放 ' + String(j.replayedTurns) + ' 轮 / 逐字段比 ' +
      String(j.compared) + ' 轮；坏行 ' + String((j.counts && j.counts.ledgerBadLines) || 0) +
      '、坏帧源 ' + String((j.skipped && j.skipped.frameFailedSources) || 0) +
      '、跳过 ' + String((j.skipped && (j.skipped.v3 + j.skipped.unparsable)) || 0);
    if (c19.ok) {
      checks.push(mkCheck('C19-replay-fields', 'C19 中段改写检测（账 vs 源逐轮全量重放）', 'ok', base + '；全量一致', {
        replayExitCode: c19.exitCode,
        counts: j.counts || {},
        skipped: j.skipped || {},
        elapsedMs: j.elapsedMs,
        invariants: c19.invariants,
      }));
    } else {
      const kinds = Object.entries(c19.byKind || {}).map(([k, v]) => k + '×' + v).join(' ');
      checks.push(mkCheck('C19-replay-fields', 'C19 中段改写检测（账 vs 源逐轮全量重放）', 'red',
        base + ' → **' + c19.mismatches.length + ' 处不一致**（' + kinds + '），定位 ' + c19.locatedTurns.length + ' 轮',
        {
          replayExitCode: c19.exitCode,
          counts: j.counts || {},
          skipped: j.skipped || {},
          elapsedMs: j.elapsedMs,
          byKind: c19.byKind,
          invariants: c19.invariants,
        }));
    }
  }

  // ── ② 每日体检（doctor 5 类）──
  if (doc.broken) {
    checks.push(mkCheck('doctor-5checks', '每日体检（tools/doctor.mjs 5 类）', 'unknown',
      '日检器自身失效：' + short(doc.brokenReason, 300), { invariants: doc.invariants }));
  } else if (doc.envError) {
    checks.push(mkCheck('doctor-5checks', '每日体检（tools/doctor.mjs 5 类）', 'unknown',
      '体检器无法成立：' + short(doc.envReason, 300), { invariants: doc.invariants }));
  } else {
    const s = doc.summary;
    const sev = maxSev(doc.checks.map((c) => doctorSevToDaily(c.severity)));
    const items = doc.checks.map((c) => ({
      id: c.id, name: c.name, severity: c.severity, dailySeverity: doctorSevToDaily(c.severity),
      message: String((c.details && c.details.message) || ''), ms: c.ms,
    }));
    checks.push(mkCheck('doctor-5checks', '每日体检（tools/doctor.mjs 5 类）', sev,
      '绿 ' + s.ok + ' / 黄 ' + s.warn + ' / 红 ' + s.red + ' / 未知 ' + s.unknown +
      (s.red > 0 ? '；红项：' + doc.checks.filter((c) => c.severity === 'red').map((c) => c.name).join('、') : ''),
      { doctorExitCode: doc.exitCode, summary: s, items, invariants: doc.invariants }));
  }

  // ── ③ 只读守卫（前后快照必须一致；报告/ 除外）──
  const ro = readonly;
  if (ro.error) {
    checks.push(mkCheck('readonly-guard', '只读守卫（除 报告/ 外账库零写入）', 'unknown', '快照失败：' + short(ro.error, 300), {}));
  } else if (!ro.diff.clean || ro.snapshotErrors.length > 0) {
    checks.push(mkCheck('readonly-guard', '只读守卫（除 报告/ 外账库零写入）', 'red',
      '日检期间账库（报告/ 以外）发生了变化：新增 ' + ro.diff.added.length + ' / 删除 ' + ro.diff.removed.length +
      ' / 改动 ' + ro.diff.changed.length + (ro.snapshotErrors.length ? '；另有 ' + ro.snapshotErrors.length + ' 个路径读不到' : ''),
      { diff: ro.diff, snapshotErrors: ro.snapshotErrors }));
  } else {
    checks.push(mkCheck('readonly-guard', '只读守卫（除 报告/ 外账库零写入）', 'ok',
      '账库 ' + ro.before.files + ' 文件 / ' + ro.before.dirs + ' 目录；前后快照一致（排除 报告/；' +
      ro.before.mode + (ro.readonlySha ? '：全树 sha256' : '：size+mtime') + '）',
      { before: { ...ro.before, entries: undefined }, after: { ...ro.after, entries: undefined }, diff: ro.diff }));
  }

  // ── ④ 跨报告源 sha 线索（warn，不参与退出码；只改中段/头尾不动的指纹）──
  const drift = c19.sourceDrift;
  const baseId = drift && drift.compareId ? '上一份绿日检（' + drift.compareId + '）' : '上一份绿日检';
  if (drift && !drift.error && !drift.compareTo) {
    checks.push(mkCheck('c19-source-drift', 'C19 线索：源会话跨报告 sha 变化（warn，不参与退出码）', 'ok',
      String(drift.reason || '没有可比的上一份绿日检报告（本次是首份）'), {}));
  } else if (drift && !drift.error) {
    if (drift.stealthChanged && drift.stealthChanged.length > 0) {
      checks.push(mkCheck('c19-source-drift', 'C19 线索：源会话跨报告 sha 变化（warn，不参与退出码）', 'warn',
        '与' + baseId + '相比，有 ' + drift.stealthChanged.length +
        ' 个源「size 与 mtime 都没变、整文件 sha 却变了」（中段改写指纹；是否正常追加/还原演练需人工确认）',
        { compareTo: drift.compareTo, compareId: drift.compareId, stealthChanged: drift.stealthChanged, changed: drift.changed }));
    } else if ((drift.changed || []).length > 0) {
      checks.push(mkCheck('c19-source-drift', 'C19 线索：源会话跨报告 sha 变化（warn，不参与退出码）', 'warn',
        '有 ' + drift.changed.length + ' 个源相对' + baseId + '变了（size/mtime 有变化，通常是正常追加）',
        { compareTo: drift.compareTo, compareId: drift.compareId, changed: drift.changed }));
    } else {
      checks.push(mkCheck('c19-source-drift', 'C19 线索：源会话跨报告 sha 变化（warn，不参与退出码）', 'ok',
        '与' + baseId + '相比源会话 sha 无变化', { compareTo: drift.compareTo, compareId: drift.compareId }));
    }
  } else if (drift && drift.error) {
    checks.push(mkCheck('c19-source-drift', 'C19 线索：源会话跨报告 sha 变化（warn，不参与退出码）', 'ok',
      '跨报告比对跳过：' + short(drift.error, 200), {}));
  }

  // ── 汇总结论 ──
  const broken = c19.broken || doc.broken;
  const brokenReasons = [];
  if (c19.broken) brokenReasons.push('C19 重放器：' + c19.brokenReason);
  if (doc.broken) brokenReasons.push('doctor：' + doc.brokenReason);
  const reds = checks.filter((c) => c.severity === 'red');
  const unknowns = checks.filter((c) => c.severity === 'unknown');
  const warns = checks.filter((c) => c.severity === 'warn');
  let exitCode = EXIT.GREEN;
  let verdict = 'green';
  if (broken) { exitCode = EXIT.BROKEN; verdict = 'broken'; }
  else if (reds.length > 0) { exitCode = EXIT.RED; verdict = 'red'; }
  return {
    checks, exitCode, verdict, broken, brokenReasons,
    summary: {
      checks: checks.length,
      ok: checks.filter((c) => c.severity === 'ok').length,
      warn: warns.length,
      red: reds.length,
      unknown: unknowns.length,
      c19: {
        ok: c19.ok,
        mismatches: c19.mismatches.length,
        locatedTurns: c19.locatedTurns.length,
        byKind: c19.byKind,
        ledgerRows: c19.json ? c19.json.ledgerRows : null,
        replayedTurns: c19.json ? c19.json.replayedTurns : null,
        compared: c19.json ? c19.json.compared : null,
      },
      doctor: doc.summary || null,
    },
  };
}

// ============================================================================
// 九、人读一页（红项排最前）
// ============================================================================

function renderText(report) {
  const L = [];
  const s = report.summary;
  L.push('日检 · ' + report.generatedAt + ' · 第 ' + report.reportId.replace(/^日检-\d{8}-/, '') + ' 份 · 结论 ' +
    (report.verdict === 'green' ? '绿' : report.verdict === 'red' ? '红' : '日检器自身失效') + '（exit ' + report.exitCode + '）');
  L.push('账库：' + report.root);
  L.push('源  ：' + report.sessions);
  L.push('─'.repeat(78));

  const sorted = [...report.checks].sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]));
  if (report.verdict !== 'green') {
    for (const r of report.brokenReasons || []) L.push('[自检失效] ' + r);
  }
  for (const c of sorted) {
    L.push('[' + SEV_LABEL[c.severity] + '] ' + c.name + '：' + c.message);
    // 体检项：把红/未知（以及最多 3 条黄）的子检查 message 也摊开，别让读者只看到计数
    if (c.id === 'doctor-5checks' && c.details && Array.isArray(c.details.items)) {
      const bad = c.details.items.filter((x) => x.dailySeverity === 'red' || x.dailySeverity === 'unknown');
      const warnItems = c.details.items.filter((x) => x.dailySeverity === 'warn').slice(0, 3);
      for (const it of bad) L.push('     ! [' + SEV_LABEL[it.dailySeverity] + '] ' + it.name + '（doctor ' + it.severity + '）：' + short(it.message, 150));
      for (const it of warnItems) L.push('     · [黄] ' + it.name + '：' + short(it.message, 150));
      continue;
    }
    // 只读守卫红：把"谁被动了"摊开
    if (c.id === 'readonly-guard' && c.severity === 'red' && c.details && c.details.diff) {
      const d = c.details.diff;
      for (const x of [...d.added, ...d.removed, ...d.changed].slice(0, 5)) {
        L.push('     ! 报告/ 以外被改动：' + (x.rel || '') + (x.why ? '（' + x.why.join(',') + '）' : ''));
      }
      continue;
    }
    if (c.severity !== 'red') continue;
    // 红项：把 C19 的不一致明细摊开（最多 --maxDetail 条），并给出 定位轮 + 源文件
    const c19 = report.c19;
    if (c.id !== 'C19-replay-fields' || !c19 || !c19.mismatches || c19.mismatches.length === 0) continue;
    const max = report.maxDetail;
    const shown = max <= 0 ? [] : c19.mismatches.slice(0, max);
    const srcBySid = new Map((c19.sources || []).map((x) => [String(x.sid || '').toLowerCase(), x]));
    for (const m of shown) {
      const loc = locateInReport(report, m);
      const src = loc.sid ? srcBySid.get(String(loc.sid).toLowerCase()) : null;
      L.push('     ! code=' + (m.code || '(无)') + ' sid=' + (loc.sid || '?') + ' turn=' + (loc.turn === null ? '?' : loc.turn) +
        ' kind=' + (m.kind || '') + (m.field ? ' field=' + m.field : ''));
      if (m.expected !== undefined || m.actual !== undefined) {
        L.push('       expected=' + short(m.expected, 90) + '  actual=' + short(m.actual, 90));
      }
      if (src) {
        L.push('       源：' + src.sid + '/' + src.file + '（size=' + src.bytes + '，mtimeMs=' + src.mtimeMs +
          (src.sha256 ? '，sha256=' + src.sha256.slice(0, 16) + '…' : '') + '）');
      }
    }
    if (max <= 0 || c19.mismatches.length > shown.length) {
      L.push('     …还有 ' + (c19.mismatches.length - shown.length) + ' 条未列（报告 JSON 里有完整明细；--maxDetail=N 可调）');
    }
    const st = c19.sourceDrift;
    if (st && st.stealthChanged && st.stealthChanged.length > 0) {
      for (const d of st.stealthChanged.slice(0, 3)) {
        L.push('       ★ 中段改写指纹：' + d.file + ' size 与 mtime 都没变，整文件 sha 却变了（' +
          String(d.prevSha || '').slice(0, 12) + '… → ' + String(d.curSha || '').slice(0, 12) + '…）');
      }
    }
  }
  L.push('─'.repeat(78));
  const ds = s.doctor;
  L.push('结论：' + (report.verdict === 'green' ? '绿' : report.verdict === 'red' ? '红' : '日检器自身失效') +
    '（exit ' + report.exitCode + '）；检查 ' + s.checks + ' 项 —— 绿 ' + s.ok + ' / 黄 ' + s.warn + ' / 红 ' + s.red + ' / 未知 ' + s.unknown +
    (ds ? '；doctor 绿 ' + ds.ok + '/' + (ds.ok + ds.warn + ds.red + ds.unknown) : ''));
  L.push('报告：' + (report.reportPath || '（未落盘）'));
  return L.join('\n');
}

/** 只用于人读页：把一条 mismatch 对回 {sid,turn}（与 buildVerdict 前的定位同口径，但不依赖内部 Map）。 */
function locateInReport(report, m) {
  const code = typeof m.code === 'string' ? m.code : '';
  const hit = (report.c19.locatedTurns || []).find((t) => t.code === code);
  if (hit) return { sid: hit.sid, turn: hit.turn };
  const txt = String(m.expected || '') + ' ' + String(m.actual || '');
  const mst = /sid=([^\s,)]+)\s+turn=([0-9]+)/.exec(txt);
  if (mst) return { sid: mst[1], turn: Number(mst[2]) };
  return { sid: '', turn: null };
}

// ============================================================================
// 十、报告原子写（tmp + fsync + rename；同日序号只增不覆盖）
// ============================================================================

function writeDailyReport(root, date, draft) {
  const outDir = path.join(root, REPORT_DIR_NAME);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {
    return { ok: false, error: '报告目录建不出：' + errMsg(e), path: '', id: '', bytes: 0 };
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const nn = nextDailySeq(outDir, date);
    const stem = '日检-' + date + '-' + pad2(nn);
    const target = path.join(outDir, stem + '.json');
    if (fs.existsSync(target)) continue; // 并发：换下一个号
    const withMeta = { ...draft, reportId: stem, reportPath: target };
    const text = renderText(withMeta);
    const fileObj = { ...withMeta, text };
    const body = JSON.stringify(fileObj, null, 2) + '\n';
    const tmp = path.join(outDir, '.' + stem + '.json.tmp-' + process.pid + '-' + Date.now());
    try {
      fs.writeFileSync(tmp, body, 'utf8');
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
      return { ok: true, id: stem, path: target, bytes: Buffer.byteLength(body, 'utf8') };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, error: '报告写不出：' + errMsg(e), path: target, id: stem, bytes: 0 };
    }
  }
  return { ok: false, error: '同日报告序号竞争 8 次仍失败（报告目录有并发写？）', path: '', id: '', bytes: 0 };
}

// ============================================================================
// 十一、main
// ============================================================================

async function main() {
  if (RAW.help) { console.log(USAGE); process.exitCode = EXIT.GREEN; return EXIT.GREEN; }

  // ---- 参数白名单：未知参数一律报错（静默忽略会把"参数写错"变成"跑了个别的模式"→假绿源）----
  const KNOWN = new Set(['--root', '--sessions', '--json', '--maxDetail', '--max-detail',
    '--readonly-sha', '--source-sha', '--replay', '--doctor', '--help', '-h']);
  const unknown = argv.filter((a) => a !== '-h' && !KNOWN.has(a.split('=')[0]));
  if (unknown.length) return usageExit('未知参数：' + unknown.join(' '));

  const maxDetailNum = Number(RAW.maxDetailRaw);
  if (!Number.isInteger(maxDetailNum) || maxDetailNum < 0) return usageExit('--maxDetail=N 必须是 >=0 的整数（收到 ' + JSON.stringify(RAW.maxDetailRaw) + '）');
  if (!RAW.root) return usageExit('必须给 --root=<账库根>');
  if (!RAW.sessions) return usageExit('必须给 --sessions=<sessions 目录>（C19 要拿源会话重放对账）');

  const root = path.resolve(RAW.root);
  const sessions = path.resolve(RAW.sessions);
  const replayPath = path.resolve(RAW.replay || DEFAULT_REPLAY);
  const doctorPath = path.resolve(RAW.doctor || DEFAULT_DOCTOR);

  const mustDir = (p, label) => {
    let st = null;
    try { st = fs.statSync(p); } catch { st = null; }
    return { ok: !!st && st.isDirectory(), label, path: p };
  };
  for (const chk of [mustDir(root, '--root'), mustDir(sessions, '--sessions')]) {
    if (!chk.ok) return usageExit(chk.label + ' 不存在或不是目录：' + chk.path);
  }
  if (!fs.existsSync(path.join(root, 'ledger'))) {
    return usageExit('--root 下没有 ledger/ 目录（这不是已 ingest 的账库根）：' + path.join(root, 'ledger'));
  }

  const t0 = Date.now();
  const nowMs = Date.now();
  const date = localYmd(nowMs);
  const ctx = { root, sessions, replayPath, doctorPath, maxDetail: maxDetailNum, readonlySha: RAW.readonlySha, sourceSha: RAW.sourceSha };

  // ---- ⓪ 只读守卫：写报告之前先把账库树拍下来（报告/ 除外）----
  let before = null;
  let after = null;
  let snapshotError = '';
  try {
    before = snapshotTree(root, { withSha: RAW.readonlySha, excludeTop: REPORT_DIR_NAME });
  } catch (e) {
    snapshotError = '拍快照失败：' + errMsg(e);
  }
  const readonly = { before, after, diff: { added: [], removed: [], changed: [], clean: true }, snapshotErrors: [], readonlySha: RAW.readonlySha, error: snapshotError || '' };

  // ---- ① C19：重放 ----
  const c19 = runC19(ctx);

  // ---- ② 每日体检（重放器连"环境错误"都没法成立时，体检也没有可挂靠的账库语义 → 直接 2）----
  let doc = { broken: false, envError: false, brokenReason: '', envReason: '', checks: [], invariants: [], summary: null, exitCode: null, json: null };
  if (!c19.envError) doc = runDoctorCheck(ctx);

  // ---- ③ 收尾：再拍一次快照，算只读守卫 ----
  if (before) {
    try {
      after = snapshotTree(root, { withSha: RAW.readonlySha, excludeTop: REPORT_DIR_NAME });
      readonly.after = after;
      readonly.diff = diffSnapshots(before, after);
    } catch (e) {
      readonly.error = '收尾快照失败：' + errMsg(e);
    }
  }
  readonly.snapshotErrors = [...(before ? before.errors : []), ...(after ? after.errors : [])];

  // ---- ④ 重放器报"环境错误" → exit 2（不写报告：连"核什么"都没成立）----
  if (c19.envError) {
    const msg = c19.envReason;
    if (RAW.json) console.log(JSON.stringify({ schema: SCHEMA, ok: false, exitCode: EXIT.USAGE, error: msg, invariants: c19.invariants }, null, 2));
    else console.error('[用法/环境错误] ' + msg);
    process.exitCode = EXIT.USAGE;
    return EXIT.USAGE;
  }
  if (doc.envError) {
    const msg = doc.envReason;
    if (RAW.json) console.log(JSON.stringify({ schema: SCHEMA, ok: false, exitCode: EXIT.USAGE, error: msg, invariants: doc.invariants }, null, 2));
    else console.error('[用法/环境错误] ' + msg);
    process.exitCode = EXIT.USAGE;
    return EXIT.USAGE;
  }

  // ---- ⑤ 组装结论 ----
  const verdict = buildVerdict({ c19, doc, readonly, ctx });
  const elapsedMs = Date.now() - t0;

  // ---- ⑥ 报告草稿（写盘前就要把 reportPath 算进去 → 先写"占位草案"，写盘函数内部补 reportId/reportPath/text）----
  const draft = {
    schema: SCHEMA,
    toolVersion: TOOL_VERSION,
    generatedAt: iso(nowMs),
    date,
    exitCode: verdict.exitCode,
    verdict: verdict.verdict,
    ok: verdict.exitCode === EXIT.GREEN,
    root,
    sessions,
    argv,
    elapsedMs,
    toolPaths: { self: fileURLToPath(import.meta.url), replay: replayPath, doctor: doctorPath, node: process.version },
    criteria: {
      id: 'C19',
      name: '中段改写（只改中段、头尾不动）→ 当天全量核发现',
      how: '复用 docs/replay-verify.mjs --fields：台账行 vs 源会话重放的应有行逐字段比（含附件 sha256/bytes）',
      scopeNote: '只保证"下次日检发现"，不承诺当场发现；中段改写不在 size/mtime 采样能力内',
    },
    broken: { isBroken: verdict.broken, reasons: verdict.brokenReasons },
    summary: verdict.summary,
    checks: verdict.checks,
    c19: {
      replayPath,
      replayExitCode: c19.exitCode,
      replayOk: c19.ok,
      mode: 'fields',
      ledgerRows: c19.json ? c19.json.ledgerRows : null,
      replayedTurns: c19.json ? c19.json.replayedTurns : null,
      compared: c19.json ? c19.json.compared : null,
      skipped: c19.json ? c19.json.skipped : null,
      counts: c19.json ? c19.json.counts : null,
      elapsedMs: c19.json ? c19.json.elapsedMs : c19.elapsedMs,
      byKind: c19.byKind,
      mismatches: c19.mismatches,
      locatedTurns: c19.locatedTurns,
      notes: c19.json ? c19.json.notes : [],
      sources: c19.sources,
      sourcesUnsupported: c19.sourcesUnsupported || [],
      sourceDrift: c19.sourceDrift,
      ledgerReadError: c19.ledgerReadError,
      invariants: c19.invariants,
    },
    doctor: {
      doctorPath,
      exitCode: doc.exitCode,
      summary: doc.summary,
      checks: doc.checks,
      invariants: doc.invariants,
      reportWrittenByDoctor: false,
      note: 'doctor 以 --json --no-write 调用：报告由本文件统一落盘（报告/ 只出现一份日检）',
    },
    readonly: {
      mode: RAW.readonlySha ? 'stat+sha256' : 'stat',
      excluded: [REPORT_DIR_NAME + '/'],
      before: before ? { files: before.files, dirs: before.dirs, totalBytes: before.totalBytes, digest: before.digest, elapsedMs: before.elapsedMs } : null,
      after: after ? { files: after.files, dirs: after.dirs, totalBytes: after.totalBytes, digest: after.digest, elapsedMs: after.elapsedMs } : null,
      diff: readonly.diff,
      snapshotErrors: readonly.snapshotErrors,
      note: RAW.readonlySha ? '前后全树 sha256 一致 = 除 报告/ 外零写入' : '前后 stat(size+mtime) 一致 = 除 报告/ 外零写入（要抓"改字节又还原 mtime"请加 --readonly-sha）',
    },
    maxDetail: maxDetailNum,
    sourceSha: RAW.sourceSha === true,
  };

  // ---- ⑦ 落盘（唯一写动作）----
  const w = writeDailyReport(root, date, draft);
  if (!w.ok) {
    console.error('[环境错误] ' + w.error);
    if (RAW.json) console.log(JSON.stringify({ schema: SCHEMA, ok: false, exitCode: EXIT.USAGE, error: w.error, verdict: verdict.verdict }, null, 2));
    process.exitCode = EXIT.USAGE;
    return EXIT.USAGE;
  }

  // ---- ⑧ 输出 ----
  let finalReport = null;
  try { finalReport = JSON.parse(fs.readFileSync(w.path, 'utf8')); } catch { finalReport = null; }
  if (RAW.json) {
    console.log(JSON.stringify(finalReport || { ...draft, reportId: w.id, reportPath: w.path }, null, 2));
  } else {
    console.log(finalReport && finalReport.text ? finalReport.text : renderText({ ...draft, reportId: w.id, reportPath: w.path }));
    console.log('明细：' + w.path + '（' + w.bytes + ' B，原子写）');
  }
  process.exitCode = verdict.exitCode;
  return verdict.exitCode;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('工具-日检: 未捕获异常（日检器自身失效）：' + ((e && e.stack) || e));
  process.exitCode = EXIT.BROKEN;
});
