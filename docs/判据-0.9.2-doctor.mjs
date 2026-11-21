#!/usr/bin/env node
/**
 * @file docs/判据-0.9.2-doctor.mjs
 * @role P1.5「doctor 门」的**可执行验收脚本**（lite 线 0.9.2-re1）。
 *
 * 做什么（每次从干净夹具开始，逐类"先红后绿"）：
 *   0) 记录 `_工作\c01-lab` 全树 sha256（跑前）；
 *   1) 清空 `_工作\doctor-gate\`，把 `c01-lab\root` + `c01-lab\dsh-home\sessions` 复制进去；
 *   2) 对 5 类各跑同一套流程（每步都真 spawn `node tools\doctor.mjs --root=<副本> [--sessions=…] --json`）：
 *      基线（期望 exit 0 + 5 类 ok）→ 构造"已知会坏" → 破坏后（期望 exit 1 + 目标 check ok=false，
 *      且**只红目标类**）→ 还原 → 还原后（期望 exit 0 + 5 类 ok）；
 *   3) 记录 `_工作\c01-lab` 全树 sha256（跑后），证明原夹具零改动；
 *   4) 输出人读表 + `--json` 机读 + 证据日志（`_工作\证据\doctor门-<时间戳>.log`，路径会打印）。
 *
 * 5 个用例的"构造红"（都只在副本上做，绝不碰机主真实账库）：
 *   ① data-integrity  ：删台账 1 行（2026-10-09.jsonl 中间一行）→ 行数 ≠ 原文视图份数
 *   ② code-consistency：追加 1 行重复 code（ts+2s）→ code 重复 / (sid,turn) 重复
 *   ③ ingest-health   ：`--sessions` 指向一个"好源副本 + session.v5.jsonl.zstd"的坏源目录（不支持版本）
 *   ④ storage-health  ：副本根下写 4.2 MB 文件（超 4 MB 单文件上限，非 xlsx）
 *   ⑤ run-report      ：把最近一份 `.run-report-*.json` 截半（非法 JSON）
 *
 * 断言口径（写死在代码里，不靠人眼）：
 *   · 基线绿 / 还原绿 = spawn exit 0 且 doctor JSON `checks[]` 5 项 `ok === true` 且 `summary.red === 0`
 *     ／ `summary.unknown === 0`（warning 仍算 ok，不假绿也不误判黄）；
 *   · 命中 = 破坏后 spawn exit 1 且目标 check `ok === false` 且 `severity === 'red'`；
 *   · 只红目标类 = 其余 4 类 `ok === true`；任何其它类不绿 → 判 `NOT_PRECISE`（退出码 3），
 *     并把"多红了谁"逐条写进人读表与 JSON，不含糊；
 *   · 还原后逐字节校验被改文件 sha256 与破坏前一致（④ 校验大文件已删除）。
 *   · 机制注记：除 check id 外，还核对"红因"（如 ① 有效行≠视图数、③ unsupportedVersions≥1、
 *     ⑤ latest.parseOk=false）。若某类的"构造方式"在 0.9.2 doctor 上不成立（命中同一 check 但
 *     红因不同），**以实测为准记录真实命中**，标 `机制差异`，不篡改判据、也不算 FAIL。
 *
 * 硬约束（本脚本自己的纪律）：
 *   · 只新增本文件；运行期只写 `_工作\doctor-gate\`（夹具副本）与 `_工作\证据\*.log`，
 *     **绝不写** `_工作\c01-lab`、`lite\lib|tools|index.js|docs(其它)|freeze`；
 *   · doctor 一律用 `--no-write`：只看判定，不在夹具里堆 `.run-report`/`报告`，
 *     ⑤/④ 的判定输入保持与夹具原样一致（报告落盘能力由 doctor 自己的验收覆盖）；
 *   · 不联网、不装包；每个 doctor 调用都带超时，失败不吞。
 *
 * 用法：
 *   node docs\判据-0.9.2-doctor.mjs            # 人读表；跑完清理夹具（证据日志保留）
 *   node docs\判据-0.9.2-doctor.mjs --json     # stdout 只出机读 JSON（证据路径打印到 stderr）
 *   node docs\判据-0.9.2-doctor.mjs --keep     # 保留 `_工作\doctor-gate\` 夹具副本便于复查
 *   node docs\判据-0.9.2-doctor.mjs --help
 *
 * 退出码：0 = 5/5 全过（且原夹具零改动）；1 = 有用例失败；2 = 用法/环境错误（含原夹具被改动）；
 *         3 = 判定不精确（命中目标但"多红"）。
 *         优先级：2（环境） > 1（失败） > 3（不精确） > 0。
 *
 * @writes `_工作\doctor-gate\**`（夹具副本，默认跑完删）、`_工作\证据\doctor门-<ts>.log`
 * @invokes node tools\doctor.mjs（--json --no-write），node tools\core-boundary.mjs（只读参考项）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 〇、路径与常量（全部从脚本位置推导，cwd 无关）
// ============================================================================

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const LITE_ROOT = path.dirname(path.dirname(SCRIPT_PATH)); // <lite>\docs\ → <lite>
const WORK_ROOT = path.dirname(LITE_ROOT); // <...>\_工作
const DOCTOR = path.join(LITE_ROOT, 'tools', 'doctor.mjs');
const BOUNDARY = path.join(LITE_ROOT, 'tools', 'core-boundary.mjs');
const C01 = path.join(WORK_ROOT, 'c01-lab');
const C01_ROOT = path.join(C01, 'root');
const C01_SESSIONS = path.join(C01, 'dsh-home', 'sessions');
const GATE = path.join(WORK_ROOT, 'doctor-gate');
const GATE_ROOT = path.join(GATE, 'root');
const GATE_SESSIONS = path.join(GATE, 'dsh-home', 'sessions');
const EVIDENCE_DIR = path.join(WORK_ROOT, '证据');

/** 时区口径固定 +08:00（与台账 ts / 原文路径 / 运行报告同名口径一致）。 */
const OFFSET_MINUTES = 480;
/** ④ 构造红：4.2 MB（doctor 单文件上限 4 MB 且非 xlsx）。 */
const BIG_FILE_BYTES = Math.round(4.2 * 1024 * 1024);
/** 单次 doctor 超时（正常 < 500ms；夹具大也不该超过 2 分钟）。 */
const DOCTOR_TIMEOUT_MS = 120 * 1000;

const CHECK_IDS = ['data-integrity', 'code-consistency', 'ingest-health', 'storage-health', 'run-report'];

const USAGE = `用法：node docs\\判据-0.9.2-doctor.mjs [--json] [--keep]

  （无参数）   人读表；跑完清理 _工作\\doctor-gate\\ 夹具（证据日志保留在 _工作\\证据\\）
  --json       stdout 只输出机读 JSON（证据路径打印到 stderr）
  --keep       保留 _工作\\doctor-gate\\ 夹具副本（默认跑完删除）
  --help       显示本说明

做什么：从 _工作\\c01-lab 复制干净夹具（root + dsh-home/sessions）到 _工作\\doctor-gate\\，
        对 5 类检查各做一次"基线绿 → 造已知红 → 只红目标 check → 还原回绿"，
        全程实际 spawn node tools\\doctor.mjs --root=<副本> [--sessions=…] --json --no-write。

退出码：0=5/5 全过且原夹具零改动；1=有用例失败；2=用法/环境错误（含原夹具被改动）；
        3=判定不精确（命中目标但其它类也红）。优先级 2 > 1 > 3 > 0。

证据：_工作\\证据\\doctor门-<YYYYMMDD-HHMMSS>.log（运行结束打印路径）。`;

// ============================================================================
// 一、本地时间 / 小工具（+08:00 固定口径）
// ============================================================================

const p2 = (n) => String(n).padStart(2, '0');
function localParts(ms) {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  return {
    Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(),
    h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}
const fmtStamp = (ms) => {
  const t = localParts(ms);
  return `${t.Y}-${p2(t.M)}-${p2(t.D)} ${p2(t.h)}:${p2(t.m)}:${p2(t.s)}`;
};
const fmtYmd = (ms) => {
  const t = localParts(ms);
  return `${t.Y}${p2(t.M)}${p2(t.D)}`;
};
const fmtIsoDate = (ms) => {
  const t = localParts(ms);
  return `${t.Y}-${p2(t.M)}-${p2(t.D)}`;
};
const fmtFileStamp = (ms) => {
  const t = localParts(ms);
  return `${t.Y}${p2(t.M)}${p2(t.D)}-${p2(t.h)}${p2(t.m)}${p2(t.s)}`;
};
/** 台账 ts 口径：`YYYY-MM-DDTHH:mm:ss+08:00`。 */
const fmtLedgerTs = (ms) => {
  const t = localParts(ms);
  return `${t.Y}-${p2(t.M)}-${p2(t.D)}T${p2(t.h)}:${p2(t.m)}:${p2(t.s)}+08:00`;
};

const errMsg = (e) => String((e && e.message) || e || '未知错误').slice(0, 400);
const shortHash = (h, n = 16) => (typeof h === 'string' && h ? h.slice(0, n) : String(h || ''));
const truncate = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '?';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256Buffer(fs.readFileSync(p));

/** 显示宽度（CJK 记 2 列，用于表格对齐）。 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    );
    w += wide ? 2 : 1;
  }
  return w;
}
const padCell = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispWidth(s)));

/** 人读表：第一行表头，之后每行等列数；按显示宽度对齐。 */
function renderTable(header, rows) {
  const widths = header.map((h, i) => Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i] == null ? '' : r[i]))));
  const line = (cells) => `  ${cells.map((c, i) => padCell(c == null ? '' : c, widths[i])).join('  ')}`;
  const out = [line(header.map((h) => ` ${h} `))];
  out.push(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// ============================================================================
// 二、参数解析
// ============================================================================

function parseArgs(argv) {
  const opts = { json: false, keep: false, help: false };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else return { error: `未知参数：${a}` };
  }
  return { opts };
}

// ============================================================================
// 三、哈希树（原夹具零改动证明）
// ============================================================================

/** 递归列出文件（不跟随符号链接目录）。 */
function walkFiles(dir) {
  const out = [];
  const rec = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
      else if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(p).isFile()) out.push(p);
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (fs.existsSync(dir)) rec(dir);
  return out.sort();
}

/**
 * 全树快照：每个文件 {size, sha256}，树 sha256 = sha256("相对路径\t大小\t文件sha256" 排序行)。
 * @returns {{dir:string, fileCount:number, bytes:number, treeSha:string, per:Record<string,{size:number,sha256:string}>}}
 */
function snapshotTree(dir) {
  const files = walkFiles(dir);
  const per = Object.create(null);
  const lines = [];
  let bytes = 0;
  for (const abs of files) {
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    const st = fs.statSync(abs);
    const sha = sha256File(abs);
    per[rel] = { size: st.size, sha256: sha };
    bytes += st.size;
    lines.push(`${rel}\t${st.size}\t${sha}`);
  }
  return { dir, fileCount: files.length, bytes, treeSha: sha256Buffer(Buffer.from(lines.join('\n'), 'utf8')), per };
}

/** 「关键文件」判据：台账 / 原文唯一凭据 / 运行报告 / 状态 / 会话源 / 根标记。 */
function isKeyFile(rel) {
  if (rel === 'root/.ledger-root' || rel === 'root/账簿总目录.md') return true;
  if (rel.startsWith('root/ledger/')) {
    const b = path.posix.basename(rel);
    if (b === '.state.json' || b === '.seal-journal.jsonl') return true;
    if (/^\.run-report-\d{8}\.json$/.test(b)) return true;
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(b)) return true;
    return false;
  }
  if (rel.startsWith('dsh-home/sessions/')) {
    return /^session\.v\d+\.jsonl\.zstd$/.test(path.posix.basename(rel));
  }
  return false;
}

/** 比对跑前/跑后快照：changed/added/removed + 关键文件逐条 sha256。 */
function compareSnapshots(before, after) {
  const all = new Set([...Object.keys(before.per), ...Object.keys(after.per)]);
  const changed = [];
  const added = [];
  const removed = [];
  for (const rel of [...all].sort()) {
    const b = before.per[rel];
    const a = after.per[rel];
    if (!b) added.push(rel);
    else if (!a) removed.push(rel);
    else if (b.sha256 !== a.sha256) changed.push(rel);
  }
  const keyFiles = [...all].filter(isKeyFile).sort().map((rel) => {
    const b = before.per[rel];
    const a = after.per[rel];
    return {
      rel,
      before: b ? b.sha256 : '(缺失)',
      after: a ? a.sha256 : '(缺失)',
      same: !!(b && a && b.sha256 === a.sha256),
    };
  });
  return {
    intact: changed.length === 0 && added.length === 0 && removed.length === 0,
    changed,
    added,
    removed,
    keyFiles,
  };
}

// ============================================================================
// 四、doctor 调用（真 spawn + JSON 解析 + 退出码/JSON 一致性校验）
// ============================================================================

function displayCommand(argv) {
  const rel = (p) => {
    const r = path.relative(WORK_ROOT, p);
    return r && !r.startsWith('..') ? path.join('_工作', r) : p;
  };
  const parts = [path.join('lite', 'tools', 'doctor.mjs')];
  for (const a of argv.slice(1)) {
    if (a.startsWith('--root=')) parts.push(`--root=${rel(a.slice(7))}`);
    else if (a.startsWith('--sessions=')) parts.push(`--sessions=${rel(a.slice(11))}`);
    else parts.push(a);
  }
  return `node ${parts.join(' ')}`;
}

/**
 * 跑一次 doctor（sync；stdout 必须是合法 JSON）。
 * @returns {{argv:string[], exitCode:number, json:object, stderr:string, command:string}}
 * @throws 环境错误（进程起不来 / 超时 / stdout 非 JSON / spawn 退出码≠JSON exitCode）
 */
function runDoctor({ root, sessions }) {
  const argv = [
    DOCTOR,
    `--root=${root}`,
    ...(sessions ? [`--sessions=${sessions}`] : []),
    '--json',
    '--no-write',
  ];
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    timeout: DOCTOR_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw new Error(`spawn doctor 失败：${errMsg(r.error)}`);
  if (r.status === null) throw new Error(`doctor 未正常退出（signal=${r.signal}）`);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`doctor stdout 不是合法 JSON（${errMsg(e)}）；stderr=${truncate(r.stderr || '', 300)}`);
  }
  if (json.exitCode !== r.status) {
    throw new Error(`doctor 退出码自相矛盾：spawn status=${r.status}，JSON exitCode=${json.exitCode}`);
  }
  if (!Array.isArray(json.checks) || json.checks.length !== 5) {
    throw new Error(`doctor JSON checks[] 形状异常（期望 5 项，实得 ${Array.isArray(json.checks) ? json.checks.length : '非数组'}）`);
  }
  return { argv, exitCode: r.status, json, stderr: r.stderr || '', command: displayCommand(argv) };
}

// ============================================================================
// 五、details 摘要（人读 / 机读共用）
// ============================================================================

/** 把 doctor check.details 压成"摘要对象"：标量直取、短数组保留、长数组记长度、嵌套对象摊平 2 层。 */
function digestOf(details) {
  const out = {};
  const maxKeys = 32;
  const add = (k, v) => {
    if (Object.keys(out).length < maxKeys) out[k] = v;
  };
  const walk = (obj, prefix, depth) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'message') continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) {
        add(key, null);
        continue;
      }
      const t = typeof v;
      if (t === 'string') {
        add(key, v.length > 100 ? `${v.slice(0, 100)}…` : v);
        continue;
      }
      if (t === 'number' || t === 'boolean') {
        add(key, v);
        continue;
      }
      if (Array.isArray(v)) {
        if (v.length > 0 && v.length <= 5 && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) add(key, v);
        else add(key, `数组[${v.length}]`);
        continue;
      }
      if (t === 'object') {
        if (depth < 2) walk(v, key, depth + 1);
        else add(key, '对象{…}');
      }
    }
  };
  walk(details, '', 0);
  return out;
}

function digestToText(digest) {
  return Object.entries(digest || {})
    .map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`)
    .join('；');
}

// ============================================================================
// 六、夹具准备（清空 → 复制 → ⑤ 运行报告"日期重定"）
// ============================================================================

function prepareFixture() {
  fs.rmSync(GATE, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  fs.mkdirSync(GATE, { recursive: true });
  fs.cpSync(C01_ROOT, GATE_ROOT, { recursive: true, force: true, preserveTimestamps: true });
  fs.cpSync(path.dirname(C01_SESSIONS), path.dirname(GATE_SESSIONS), {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
  if (!fs.existsSync(path.join(GATE_ROOT, '.ledger-root'))) throw new Error(`夹具 root 复制失败：${GATE_ROOT}`);
  if (!fs.existsSync(GATE_SESSIONS)) throw new Error(`夹具 sessions 复制失败：${GATE_SESSIONS}`);
  return { root: GATE_ROOT, sessions: GATE_SESSIONS };
}

/**
 * ⑤ 的 doctor 判定里有一条"最近一份运行报告必须是今天"（tick 今天没跑成/报告被删 → 红）。
 * c01-lab 的运行报告是 2026-11-13 的快照：若换个日历日跑本门，基线 ⑤ 会因"不是今天"而红，
 * 门就不可重复。→ 只对**副本**做"日期重定"：把最近一份 `.run-report-YYYYMMDD.json` 的文件名与
 *  `date/generatedAt/at` 平移到今天（夹具快照重定，不改判定口径；人读/JSON 都显式记录）。
 */
function retimeRunReport(nowMs, rootDir = GATE_ROOT) {
  const ledgerDir = path.join(rootDir, 'ledger');
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir).filter((n) => /^\.run-report-\d{8}\.json$/.test(n)).sort();
  } catch (e) {
    return { status: 'error', error: `ledger 目录读不出：${errMsg(e)}` };
  }
  if (!names.length) return { status: 'no-report' };
  const latestName = names[names.length - 1];
  const latestYmd = /^\.run-report-(\d{8})\.json$/.exec(latestName)[1];
  const today = fmtYmd(nowMs);
  if (latestYmd === today) return { status: 'as-is', file: latestName, ymd: latestYmd };
  const full = path.join(ledgerDir, latestName);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    return { status: 'error', error: `夹具运行报告无法解析（无法重定日期）：${latestName}：${errMsg(e)}` };
  }
  const stamp = fmtStamp(nowMs);
  const isoDate = fmtIsoDate(nowMs);
  const patched = ['date', 'generatedAt', 'at'];
  j.date = isoDate;
  j.generatedAt = stamp;
  j.at = stamp;
  if (j.reconcile && typeof j.reconcile === 'object') {
    j.reconcile.at = stamp;
    patched.push('reconcile.at');
  }
  const targetName = `.run-report-${today}.json`;
  const target = path.join(ledgerDir, targetName);
  fs.writeFileSync(target, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
  fs.rmSync(full);
  return { status: 'retimed', from: latestYmd, to: today, fromFile: latestName, file: targetName, patched };
}

function quickStats(dir) {
  const files = walkFiles(dir);
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /* ignore */
    }
  }
  return { fileCount: files.length, bytes };
}

// ============================================================================
// 七、5 个用例（构造 / 还原；每类都"只动副本"）
// ============================================================================

/** 全部 `.jsonl` 台账文件（排序）。 */
function ledgerDateFiles() {
  return fs.readdirSync(path.join(GATE_ROOT, 'ledger'))
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .sort();
}

/** 非空行索引（`split('\n')` 口径，保留行尾空串以便写回不改尾换行）。 */
function nonEmptyLineIdx(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) out.push(i);
  return out;
}

/**
 * 用例定义。每个 breakFn() 做破坏并返回：
 *   { meta, restore() }——restore() 必须把副本逐字节还原（① ② ⑤ 为 sha256 级还原，④ 为删文件）。
 * `sessionsForPhase` 决定该阶段用哪个 --sessions（只有 ③ 的"破坏后"用坏源目录）。
 */
function buildCases(ctx) {
  return [
    {
      id: 'data-integrity',
      title: '① 数据完整性',
      breakDesc: '删台账 1 行（行数 ≠ 原文份数）',
      sessionsForPhase: () => ctx.goodSessions,
      breakFn: () => {
        const rel = `root/ledger/${ledgerDateFiles()[0]}`; // 2026-10-09.jsonl（最多行）
        const abs = path.join(GATE_ROOT, 'ledger', path.basename(rel));
        const before = fs.readFileSync(abs);
        const lines = before.toString('utf8').split('\n');
        const idxs = nonEmptyLineIdx(lines);
        if (idxs.length < 2) throw new Error(`台账文件行数不足，无法删行：${rel}`);
        const pick = idxs[Math.floor(idxs.length / 2)];
        const removed = JSON.parse(lines[pick]);
        fs.writeFileSync(abs, lines.filter((_, i) => i !== pick).join('\n'), 'utf8');
        return {
          meta: {
            file: rel,
            removedLineNo: pick + 1,
            removedCode: removed && removed.code,
            linesBefore: idxs.length,
            linesAfter: idxs.length - 1,
          },
          restore: () => fs.writeFileSync(abs, before),
          verify: () => ({ kind: 'sha256-equal', rel, sha256: sha256Buffer(fs.readFileSync(abs)), ok: sha256Buffer(fs.readFileSync(abs)) === sha256Buffer(before) }),
        };
      },
      mechanism: (d) => {
        const ok = Number(d.effectiveRows) !== Number(d.views)
          || Number(d.originalMissing) > 0
          || Number(d.originalOrphanCodes) > 0;
        return { ok, note: `有效行=${d.effectiveRows}；视图=${d.views}；缺凭证=${d.originalMissing}；孤儿 code=${d.originalOrphanCodes}` };
      },
    },
    {
      id: 'code-consistency',
      title: '② 编码一致性',
      breakDesc: '追加 1 行重复 code（ts+2s）',
      sessionsForPhase: () => ctx.goodSessions,
      breakFn: () => {
        const rel = `root/ledger/${ledgerDateFiles()[ledgerDateFiles().length - 1]}`; // 2026-10-15.jsonl
        const abs = path.join(GATE_ROOT, 'ledger', path.basename(rel));
        const before = fs.readFileSync(abs);
        const lines = before.toString('utf8').split('\n');
        const idxs = nonEmptyLineIdx(lines);
        if (!idxs.length) throw new Error(`台账文件为空，无法复制行：${rel}`);
        const last = JSON.parse(lines[idxs[idxs.length - 1]]);
        const tsMs = Date.parse(last.ts);
        if (!Number.isFinite(tsMs)) throw new Error(`无法解析台账 ts：${last.ts}`);
        const dup = { ...last, ts: fmtLedgerTs(tsMs + 2000) };
        let text = before.toString('utf8');
        if (!text.endsWith('\n')) text += '\n';
        fs.writeFileSync(abs, `${text}${JSON.stringify(dup)}\n`, 'utf8');
        return {
          meta: { file: rel, appendedCode: dup.code, appendedTs: dup.ts, sid: dup.sid, turn: dup.turn },
          restore: () => fs.writeFileSync(abs, before),
          verify: () => ({ kind: 'sha256-equal', rel, sha256: sha256Buffer(fs.readFileSync(abs)), ok: sha256Buffer(fs.readFileSync(abs)) === sha256Buffer(before) }),
        };
      },
      mechanism: (d) => {
        const ok = Number(d.duplicateCodeGroups) >= 1 && Number(d.duplicateSidTurnGroups) >= 1;
        return { ok, note: `code 重复组=${d.duplicateCodeGroups}；(sid,turn) 重复组=${d.duplicateSidTurnGroups}` };
      },
    },
    {
      id: 'ingest-health',
      title: '③ 采集健康',
      breakDesc: '--sessions 指向含 session.v5.jsonl.zstd 的坏源目录（不支持版本）',
      sessionsForPhase: (phase) => (phase === 'broken' ? ctx.badSessions : ctx.goodSessions),
      breakFn: () => {
        const bad = path.join(GATE, 'bad-sessions');
        fs.rmSync(bad, { recursive: true, force: true });
        fs.cpSync(ctx.goodSessions, bad, { recursive: true, force: true });
        // 递归找一个已有 session.v4.jsonl.zstd 的**会话目录**，塞进 session.v5.jsonl.zstd（版本 5 不受支持）
        const findSessionDir = (dir) => {
          let ents;
          try {
            ents = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return '';
          }
          if (ents.some((e) => e.isFile() && e.name === 'session.v4.jsonl.zstd')) return dir;
          for (const e of ents) {
            if (!e.isDirectory()) continue;
            const hit = findSessionDir(path.join(dir, e.name));
            if (hit) return hit;
          }
          return '';
        };
        const sessDir = findSessionDir(bad);
        if (!sessDir) throw new Error('坏源目录构造失败：找不到含 session.v4.jsonl.zstd 的会话目录');
        // 内容不重要（scanSessionSources 只 stat 文件名/版本），用 zstd 魔数 + 少量字节，避免像空文件
        fs.writeFileSync(path.join(sessDir, 'session.v5.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]));
        ctx.badSessions = bad;
        return {
          meta: {
            sessionsBase: path.join('_工作', path.relative(WORK_ROOT, bad)),
            v5File: `${path.relative(bad, sessDir)}\\session.v5.jsonl.zstd`,
          },
          restore: () => fs.rmSync(bad, { recursive: true, force: true }),
          verify: () => ({ kind: 'bad-sessions-removed', rel: 'bad-sessions/', ok: !fs.existsSync(bad) }),
        };
      },
      mechanism: (d) => {
        const list = Array.isArray(d.unsupportedList) ? d.unsupportedList : [];
        const ok = Number(d.unsupportedVersions) >= 1 && list.some((x) => String(x).includes('session.v5.jsonl.zstd'));
        return { ok, note: `unsupportedVersions=${d.unsupportedVersions}；unsupportedList=${JSON.stringify(list)}` };
      },
    },
    {
      id: 'storage-health',
      title: '④ 存储健康',
      breakDesc: '副本根下写 4.2 MB 文件（超 4 MB 单文件上限，非 xlsx）',
      sessionsForPhase: () => ctx.goodSessions,
      breakFn: () => {
        const name = '_doctor-gate-big-4.2mb.bin';
        const abs = path.join(GATE_ROOT, name);
        fs.writeFileSync(abs, Buffer.alloc(BIG_FILE_BYTES, 0x41));
        return {
          meta: { file: `root/${name}`, bytes: BIG_FILE_BYTES },
          restore: () => fs.rmSync(abs, { force: true }),
          verify: () => ({ kind: 'file-removed', rel: `root/${name}`, ok: !fs.existsSync(abs) }),
        };
      },
      mechanism: (d) => {
        const big = Array.isArray(d.bigFiles) ? d.bigFiles.length : 0;
        const pendingOver = Number(d.pendingBytes) > Number(d.pendingMaxBytes);
        return { ok: big >= 1 || pendingOver, note: `bigFiles=${big}；pendingBytes=${d.pendingBytes}/${d.pendingMaxBytes}` };
      },
    },
    {
      id: 'run-report',
      title: '⑤ 运行报告',
      breakDesc: '把最近一份 .run-report-*.json 截半（非法 JSON）',
      sessionsForPhase: () => ctx.goodSessions,
      breakFn: () => {
        const ledgerDir = path.join(GATE_ROOT, 'ledger');
        const names = fs.readdirSync(ledgerDir).filter((n) => /^\.run-report-\d{8}\.json$/.test(n)).sort();
        if (!names.length) throw new Error('副本里没有 .run-report-*.json，无法构造 ⑤');
        const name = names[names.length - 1];
        const abs = path.join(ledgerDir, name);
        const before = fs.readFileSync(abs);
        const half = Math.floor(before.length / 2);
        fs.writeFileSync(abs, before.subarray(0, half));
        return {
          meta: { file: `root/ledger/${name}`, bytesBefore: before.length, bytesAfter: half },
          restore: () => fs.writeFileSync(abs, before),
          verify: () => ({ kind: 'sha256-equal', rel: `root/ledger/${name}`, sha256: sha256Buffer(fs.readFileSync(abs)), ok: sha256Buffer(fs.readFileSync(abs)) === sha256Buffer(before) }),
        };
      },
      mechanism: (d) => {
        const latest = d && typeof d.latest === 'object' && d.latest ? d.latest : null;
        const ok = !!latest && latest.parseOk === false;
        return { ok, note: `latest.name=${latest ? latest.name : '(无)'}；latest.parseOk=${latest ? latest.parseOk : '(无)'}` };
      },
    },
  ];
}

// ============================================================================
// 八、断言 + 跑一个用例
// ============================================================================

/** 基线/还原"绿"：spawn exit 0、JSON 5 项 ok、summary 无红无未知。 */
function isAllGreen(run) {
  const j = run.json;
  return run.exitCode === 0
    && j.exitCode === 0
    && j.ok === true
    && Array.isArray(j.checks) && j.checks.length === 5
    && j.checks.every((c) => c.ok === true)
    && Number(j.summary && j.summary.red) === 0
    && Number(j.summary && j.summary.unknown) === 0;
}

/** 把一次 doctor 结果压成记录（JSON 证据用）。 */
function toRunRecord(run, targetId, { fullTargetDetails = false } = {}) {
  const j = run.json;
  const targetCheck = j.checks.find((c) => c.id === targetId) || null;
  return {
    command: run.command,
    exitCode: run.exitCode,
    jsonExitCode: j.exitCode,
    ok: j.ok === true,
    summary: j.summary,
    checks: j.checks.map((c) => ({
      id: c.id,
      ok: c.ok === true,
      severity: c.severity,
      message: String((c.details && c.details.message) || ''),
    })),
    target: targetCheck
      ? {
        id: targetCheck.id,
        ok: targetCheck.ok === true,
        severity: targetCheck.severity,
        digest: digestOf(targetCheck.details),
        ...(fullTargetDetails ? { details: targetCheck.details } : {}),
      }
      : null,
    green: isAllGreen(run),
  };
}

/** 跑 5 类 + 基线/破坏/还原。任何 doctor 调用异常（spawn/JSON）都上升为环境错误 exit 2。 */
function runCase(def, ctx) {
  const rec = {
    id: def.id,
    title: def.title,
    target: def.id,
    breakDesc: def.breakDesc,
    verdict: 'FAIL',
    error: '',
  };

  // 1) 基线：必须 exit 0 + 5 类 ok
  const base = runDoctor({ root: ctx.root, sessions: def.sessionsForPhase('baseline') });
  rec.baseline = toRunRecord(base, def.id);
  rec.baselineOk = isAllGreen(base);

  // 2) 构造已知红（只在副本上）
  let built;
  try {
    built = def.breakFn();
  } catch (e) {
    rec.error = `构造失败：${errMsg(e)}`;
    rec.verdict = 'FAIL';
    return rec;
  }
  rec.breakMeta = built.meta;

  // 3) 破坏后：必须 exit 1 + 目标 check ok=false(red)，且只红目标类
  const broken = runDoctor({ root: ctx.root, sessions: def.sessionsForPhase('broken') });
  rec.broken = toRunRecord(broken, def.id, { fullTargetDetails: true });
  const targetCheck = broken.json.checks.find((c) => c.id === def.id) || null;
  const hit = broken.exitCode === 1 && !!targetCheck && targetCheck.ok === false && targetCheck.severity === 'red';
  const otherBad = broken.json.checks
    .filter((c) => c.id !== def.id && c.ok !== true)
    .map((c) => `${c.id}(${c.severity})`);
  rec.hit = hit;
  rec.otherBad = otherBad;
  rec.precise = hit && otherBad.length === 0;
  rec.mechanism = hit ? def.mechanism(targetCheck.details || {}) : { ok: false, note: '未命中，无红因可核' };

  // 4) 还原 + 逐字节校验
  try {
    built.restore();
    rec.restoreVerify = built.verify();
  } catch (e) {
    rec.restoreVerify = { ok: false, error: errMsg(e) };
  }

  // 5) 还原后：必须回绿
  const restored = runDoctor({ root: ctx.root, sessions: def.sessionsForPhase('restored') });
  rec.restored = toRunRecord(restored, def.id);
  rec.restoredOk = isAllGreen(restored);

  // 6) 判定
  if (!rec.baselineOk) rec.verdict = 'FAIL';
  else if (!rec.hit) rec.verdict = 'FAIL';
  else if (!rec.restoredOk || !(rec.restoreVerify && rec.restoreVerify.ok === true)) rec.verdict = 'FAIL';
  else if (!rec.precise) rec.verdict = 'NOT_PRECISE';
  else rec.verdict = 'PASS';

  if (rec.verdict === 'PASS' && rec.mechanism && rec.mechanism.ok !== true) {
    rec.mechanismDiff = true; // 命中目标 check，但红因与方案写法不同 → 以实测为准记录，不判失败
  }
  return rec;
}

// ============================================================================
// 九、参考项：core-boundary（只读，不计入门判定）
// ============================================================================

function probeCoreBoundary() {
  if (!fs.existsSync(BOUNDARY)) return { checked: false, skipped: 'tools/core-boundary.mjs 不存在' };
  const r = spawnSync(process.execPath, [BOUNDARY, '--json'], {
    encoding: 'utf8',
    timeout: 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error || r.status === null) return { checked: false, error: errMsg(r.error || `signal=${r.signal}`) };
  try {
    const j = JSON.parse(r.stdout);
    return {
      checked: true,
      exitCode: r.status,
      coreCount: j.coreCount,
      violations: Array.isArray(j.violations) ? j.violations.length : null,
      hints: Array.isArray(j.hints) ? j.hints.length : null,
      pass: r.status === 0 && Array.isArray(j.violations) && j.violations.length === 0,
    };
  } catch (e) {
    return { checked: false, error: `core-boundary stdout 非 JSON：${errMsg(e)}` };
  }
}

// ============================================================================
// 十、人读输出 + 证据日志
// ============================================================================

const VERDICT_LABEL = { PASS: 'PASS', FAIL: 'FAIL', NOT_PRECISE: 'NOT_PRECISE' };

function runCell(run) {
  if (!run) return '未跑';
  return `exit ${run.exitCode} · ${run.summary.ok}绿${run.summary.warn ? `/黄${run.summary.warn}` : ''}`;
}

function greenCell(run) {
  if (!run) return '未跑';
  const sum = run.summary || {};
  const all = (run.checks || []).filter((c) => c.ok === true).length;
  return `exit ${run.exitCode} · ${all}/5 ok（黄 ${sum.warn == null ? '?' : sum.warn}）`;
}

function buildHuman(r) {
  const L = [];
  L.push('P1.5 doctor 门 · 可执行验收（lite 0.9.2-re1）');
  L.push(`生成：${r.generatedAt}（+08:00） · node ${r.node} · 脚本：${r.script}`);
  L.push(`doctor：${r.doctor.path}（${fmtBytes(r.doctor.bytes)} / ${r.doctor.lines} 行）`);
  const ob = r.origin.before || { fileCount: 0, bytes: 0, treeSha: '(未采)' };
  L.push(`原夹具：${r.origin.path}（${ob.fileCount} 文件 / ${fmtBytes(ob.bytes)}，树 sha256 ${shortHash(ob.treeSha)}）`);
  L.push(`夹具副本：${r.fixture.path}（root + dsh-home/sessions；每次先清空；本次${r.fixture.kept ? '--keep 保留' : '跑完清理'}）`);
  if (r.fixture.retime) {
    const t = r.fixture.retime;
    if (t.status === 'retimed') {
      L.push(`  夹具运行报告：已"日期重定" ${t.from} → ${t.to}（仅副本；c01-lab 快照为 ${t.from}，重定是为了让 ⑤ 的"最近一份=今天"可重复）`);
    } else if (t.status === 'as-is') {
      L.push(`  夹具运行报告：${t.file}（就是今天 ${t.ymd}，无需重定）`);
    } else {
      L.push(`  夹具运行报告：${t.status}${t.error ? `（${t.error}）` : ''}`);
    }
  }
  L.push('');

  // 一、主表
  L.push('一、5 类"先红后绿"（每类都实际 spawn doctor --root=<副本> [--sessions=…] --json --no-write）');
  const header = ['用例', '目标 check', '破坏前', '破坏后', '命中', '还原后', '结论'];
  const rows = r.cases.map((c) => {
    const hit = c.hit
      ? `${c.target} ok=false(${c.broken && c.broken.target ? c.broken.target.severity : 'red'})${c.otherBad && c.otherBad.length ? `；多红：${c.otherBad.join('、')}` : '；仅此 1 红'}${c.mechanismDiff ? '；机制差异' : ''}`
      : '未命中';
    return [
      c.title,
      c.target,
      greenCell(c.baseline),
      c.broken ? `exit ${c.broken.exitCode} · 红 ${c.broken.summary.red}／未知 ${c.broken.summary.unknown}` : '未跑',
      hit,
      greenCell(c.restored),
      VERDICT_LABEL[c.verdict] || c.verdict,
    ];
  });
  L.push(renderTable(header, rows));
  L.push('');

  // 二、破坏后逐类 checks
  L.push('二、破坏后逐类 checks（证明"只红目标类"，不是别的）');
  for (const c of r.cases) {
    L.push('');
    L.push(`[${c.title}] 目标=${c.target}；破坏=${c.breakDesc}`);
    if (c.error) {
      L.push(`  用例异常：${c.error}`);
      continue;
    }
    if (c.breakMeta) L.push(`  构造：${truncate(JSON.stringify(c.breakMeta), 300)}`);
    if (c.broken) L.push(`  命令：${c.broken.command}`);
    for (const chk of (c.broken && c.broken.checks) || []) {
      const flag = chk.ok ? '  ' : '!!';
      L.push(`  ${flag} ${padCell(chk.id, 18)} ok=${padCell(String(chk.ok), 5)} sev=${padCell(chk.severity, 7)} ${truncate(chk.message, 170)}`);
    }
    if (c.broken && c.broken.target && c.broken.target.digest) {
      L.push(`     details 摘要（${c.target}）：${truncate(digestToText(c.broken.target.digest), 900)}`);
    }
    if (c.mechanism) L.push(`     红因核对：${c.mechanism.ok ? '与方案一致' : '与方案写法不同（以实测为准）'} —— ${truncate(c.mechanism.note, 300)}`);
    const verify = c.restoreVerify
      ? (c.restoreVerify.kind === 'sha256-equal'
        ? `还原文件 sha256 ${c.restoreVerify.ok ? '一致' : '不一致(!)'}（${c.restoreVerify.rel}）`
        : c.restoreVerify.kind === 'file-removed'
          ? `还原：大文件已删除（${c.restoreVerify.ok ? '是' : '否(!)'}）`
          : c.restoreVerify.kind === 'bad-sessions-removed'
            ? `还原：坏源目录已删除（${c.restoreVerify.ok ? '是' : '否(!)'}）`
            : `还原：${c.restoreVerify.kind}（${c.restoreVerify.ok ? 'ok' : '失败(!)'}）`)
      : '还原：未执行';
    L.push(`     基线：${greenCell(c.baseline)}  |  还原：${greenCell(c.restored)}  |  ${verify}`);
  }
  L.push('');

  // 三、原夹具零改动
  L.push('三、原夹具零改动证明（_工作\\c01-lab 跑前/跑后 sha256）');
  const oa = r.origin.after || { fileCount: 0, bytes: 0, treeSha: '(未采)' };
  L.push(`  全树：跑前 ${ob.fileCount} 文件 / ${fmtBytes(ob.bytes)} / 树 sha256 ${ob.treeSha}`);
  L.push(`        跑后 ${oa.fileCount} 文件 / ${fmtBytes(oa.bytes)} / 树 sha256 ${oa.treeSha}`);
  L.push(`  差异：changed=${r.origin.changed.length} added=${r.origin.added.length} removed=${r.origin.removed.length} → ${r.origin.intact ? '零改动' : '有改动(!)'}`);
  if (r.origin.changed.length) for (const f of r.origin.changed) L.push(`    changed: ${f}`);
  if (r.origin.added.length) for (const f of r.origin.added) L.push(`    added:   ${f}`);
  if (r.origin.removed.length) for (const f of r.origin.removed) L.push(`    removed: ${f}`);
  L.push('  关键文件 sha256（前 16 位；跑前 → 跑后）：');
  for (const k of r.origin.keyFiles) {
    L.push(`    ${k.same ? 'PASS' : 'FAIL(!)'}  ${padCell(k.rel, 62)} ${shortHash(k.before)} → ${shortHash(k.after)}`);
  }
  L.push('');

  // 四、参考项
  L.push('四、参考项（只记录，不计入门判定）');
  const cb = r.ancillary.coreBoundary;
  if (!cb || cb.checked === false) L.push(`  core-boundary：未检查（${(cb && (cb.skipped || cb.error)) || '未知'}）`);
  else L.push(`  core-boundary：core files ${cb.coreCount} / violations ${cb.violations} / hints ${cb.hints} / exit ${cb.exitCode} → ${cb.pass ? '边界未受影响' : '有 violation（!）'}`);
  L.push('');

  // 五、判定
  L.push('五、判定');
  L.push(`  ${r.summary.passed}/5 PASS · FAIL ${r.summary.failed} · NOT_PRECISE ${r.summary.imprecise} · 机制差异 ${r.summary.mechanismDiffs} · 多红用例 ${r.summary.multiRed} · 原夹具${r.origin.intact ? '零改动' : '有改动(!)'}`);
  if (r.summary.failed > 0) {
    for (const c of r.cases.filter((x) => x.verdict === 'FAIL')) {
      const why = c.error ? c.error
        : !c.baselineOk ? '基线不是 5 类全绿'
          : !c.hit ? '破坏后未命中目标 check（或 exit≠1）'
            : !c.restoredOk ? '还原后没有回绿'
              : '还原字节校验失败';
      L.push(`  FAIL：${c.title} —— ${why}`);
    }
  }
  if (r.summary.imprecise > 0) {
    for (const c of r.cases.filter((x) => x.verdict === 'NOT_PRECISE')) {
      L.push(`  NOT_PRECISE：${c.title} —— 目标命中，但其它类也红：${(c.otherBad || []).join('、')}`);
    }
  }
  if (r.error) L.push(`  环境错误：${r.error}`);
  L.push(`  退出码：${r.exitCode}（0=全过 / 1=失败 / 2=用法环境错误 / 3=判定不精确）`);
  L.push(`  证据：${r.evidenceLog || '(未写)'}`);
  return L.join('\n');
}

// ============================================================================
// 十一、证据日志
// ============================================================================

function chooseEvidencePath(nowMs) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const base = `doctor门-${fmtFileStamp(nowMs)}`;
  let p = path.join(EVIDENCE_DIR, `${base}.log`);
  for (let n = 2; fs.existsSync(p) && n < 100; n++) p = path.join(EVIDENCE_DIR, `${base}-${n}.log`);
  return p;
}

function publicResult(r) {
  const { human, ...rest } = r;
  return rest;
}

function writeEvidence(r) {
  const body = [
    r.human,
    '',
    '='.repeat(78),
    '附：机读 JSON（--json 同形状，含完整 checks / 目标类 details）',
    '='.repeat(78),
    JSON.stringify(publicResult(r), null, 2),
    '',
  ].join('\n');
  fs.writeFileSync(r.evidenceLog, body, 'utf8');
}

// ============================================================================
// 十二、主流程
// ============================================================================

function baseResult(nowMs) {
  return {
    schema: 'doctor-gate/1',
    generatedAt: fmtStamp(nowMs),
    generatedAtMs: nowMs,
    node: process.version,
    script: SCRIPT_PATH,
    liteRoot: LITE_ROOT,
    workRoot: WORK_ROOT,
    doctor: { path: DOCTOR, exists: fs.existsSync(DOCTOR), bytes: 0, lines: 0 },
    fixture: { path: GATE, root: GATE_ROOT, sessions: GATE_SESSIONS, kept: false, cleaned: false, retime: null },
    commandTemplate: 'node tools\\doctor.mjs --root=<副本\\root> [--sessions=<源目录>] --json --no-write',
    origin: {
      path: C01,
      before: null,
      after: null,
      intact: false,
      changed: [],
      added: [],
      removed: [],
      keyFiles: [],
    },
    cases: [],
    summary: { total: 5, passed: 0, failed: 0, imprecise: 0, mechanismDiffs: 0, multiRed: 0, allPass: false },
    ancillary: { coreBoundary: null },
    evidenceLog: '',
    exitCode: 2,
    ok: false,
    error: '',
  };
}

function main(argv) {
  const nowMs = Date.now();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`判据-0.9.2-doctor：${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const r = baseResult(nowMs);
  r.evidenceLog = chooseEvidencePath(nowMs);

  try {
    // 0) 环境最小校验
    if (!fs.existsSync(DOCTOR)) throw new Error(`doctor 不存在：${DOCTOR}`);
    if (!fs.existsSync(C01_ROOT) || !fs.existsSync(C01_SESSIONS)) {
      throw new Error(`原夹具不完整：需要 ${C01_ROOT} 与 ${C01_SESSIONS}`);
    }
    const doctorSrc = fs.readFileSync(DOCTOR, 'utf8');
    r.doctor.bytes = Buffer.byteLength(doctorSrc, 'utf8');
    r.doctor.lines = doctorSrc.split('\n').length - (doctorSrc.endsWith('\n') ? 1 : 0);

    // 1) 原夹具跑前快照
    r.origin.before = snapshotTree(C01);

    // 2) 清空 + 复制干净夹具（root + dsh-home/sessions）
    const fx = prepareFixture();
    r.fixture.copy = quickStats(GATE);
    r.fixture.retime = retimeRunReport(nowMs);

    // 3) 5 类先红后绿
    const ctx = { root: fx.root, goodSessions: fx.sessions, badSessions: '' };
    for (const def of buildCases(ctx)) {
      r.cases.push(runCase(def, ctx));
    }

    // 4) 原夹具跑后快照 + 比对
    r.origin.after = snapshotTree(C01);
    Object.assign(r.origin, compareSnapshots(r.origin.before, r.origin.after));

    // 5) 参考项（只读）
    r.ancillary.coreBoundary = probeCoreBoundary();
  } catch (e) {
    r.error = errMsg(e);
  }

  // 6) 汇总
  r.summary.total = r.cases.length;
  r.summary.passed = r.cases.filter((c) => c.verdict === 'PASS').length;
  r.summary.failed = r.cases.filter((c) => c.verdict === 'FAIL').length;
  r.summary.imprecise = r.cases.filter((c) => c.verdict === 'NOT_PRECISE').length;
  r.summary.mechanismDiffs = r.cases.filter((c) => c.mechanismDiff).length;
  r.summary.multiRed = r.cases.filter((c) => c.otherBad && c.otherBad.length > 0).length;
  r.summary.allPass = r.summary.total === 5 && r.summary.passed === 5 && r.summary.imprecise === 0 && r.summary.mechanismDiffs === 0 && r.origin.intact === true;

  if (r.error) r.exitCode = 2;
  else if (r.origin.intact !== true) r.exitCode = 2; // 原夹具被动过 → 夹具/环境保护失败（环境错误）
  else if (r.summary.failed > 0) r.exitCode = 1;
  else if (r.summary.imprecise > 0) r.exitCode = 3;
  else r.exitCode = 0;
  r.ok = r.exitCode === 0;

  // 7) 清理夹具（默认）——放在写日志前，人读页能如实写"已清理/保留"
  r.fixture.kept = opts.keep === true;
  if (!opts.keep) {
    try {
      fs.rmSync(GATE, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      r.fixture.cleaned = true;
    } catch (e) {
      r.fixture.cleanupError = errMsg(e);
      if (r.exitCode === 0) r.exitCode = 2; // 清理失败也算环境问题，不假绿
      r.ok = r.exitCode === 0;
    }
  }

  // 8) 人读页 + 证据日志
  try {
    r.human = buildHuman(r);
    writeEvidence(r);
  } catch (e) {
    console.error(`判据-0.9.2-doctor：写证据日志失败：${errMsg(e)}`);
    if (r.exitCode === 0) r.exitCode = 2;
    r.ok = r.exitCode === 0;
  }

  // 9) 输出
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(publicResult(r), null, 2)}\n`);
    process.stderr.write(`证据：${r.evidenceLog}\n`);
  } else {
    process.stdout.write(`${r.human}\n`);
  }
  return r.exitCode;
}

// 被 import 时只导出（便于单测/外部复用），直接跑才执行。
const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(SCRIPT_PATH);
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`判据-0.9.2-doctor：未捕获异常：${(e && e.stack) || e}`);
    process.exitCode = 2;
  }
}

export { main, runDoctor, snapshotTree, buildCases, retimeRunReport };
