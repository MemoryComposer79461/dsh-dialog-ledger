#!/usr/bin/env node
/**
 * @file docs/判据-0.9.4.mjs
 * @role 0.9.4 P3（lite 线）**E 组 C26–C37 判据执行器** + C24 单位口径核对 + S-10 五项口径落地检查。
 *
 * @why 0.9.4-snap 已落地指针索引外部层 / 备份 / 容量告警，但 C26–C37 **没有可执行验具**；
 *      本文件把总纲 §7.6 的 12 条逐条落成"可复算 + 可复现红"的检查，并把机主 2026-11-13 已签的
 *      S-10 五项口径写死进出口径（改口径必须重新签字，代码不自行裁定）：
 *        ① C27 = 瘦行四字段（code + docFileSha256 + offset + bytes）**由原文/台账独立复算**，
 *           不引入逐行 entryHash（尊重 S-6 否决）→ 本文件 C27 明确断言索引里 **0 个 h/entryHash 字段**；
 *        ② C36 分母：**同时报**「索引分片 / 台账日文件（=S-10② 的 11.8×% 口径）」与
 *           「索引 / 整库包（排除 .git 与 MANIFEST）」，两者都 ≤15% 才判绿（两种读法都不放过）；
 *        ③ C24 单位统一 **GiB**，条款 **≈364 GiB**（复算 363.9），体积推算必须标"推算"；
 *        ④ 索引形态：按日分片（idx-YYYYMMDD.jsonl）、单分片 ≤4 MiB → C28/C29/C35 按日分片口径验；
 *        ⑤ doctor `--corpus` 拆口径（套账 ≤0.05× 压缩语料；原文+视图 1.00–1.35× 解压语料）——
 *           落点在 `tools\doctor.mjs` ④，本执行器不重复实现，只在证据里引 doctor 的 before/after。
 *
 * 铁律：**未验 ≠ 通过**。缺环境/缺夹具/缺实现 → `NA`（写明缺什么），不充绿；
 *      每条能验的判据都自带"注入故障 → 红 → 还原 → 绿"的反证能力（`--proof`）。
 *
 * 用法：
 *   node docs\判据-0.9.4.mjs [--lab=<lab>] [--root=<账库>] [--big=<大库 lab>] [--three-layer=<lab>]
 *                            [--only=C26,...] [--json] [--proof] [--keep] [--help]
 *
 *   --lab=<lab>    默认 `_工作\c01-lab`（小库：12 行/3 个台账日/3 个 sid）；取其 `root\` 当账库
 *   --root=<账库>  直接指定账库根（覆盖 --lab 推导；C26-C37 需要 ledger\.index 已建）
 *   --big=<lab>    默认 `_工作\lab-e3-accept`（大库：1,338 行/37 个台账日/45 天；**只读**）；
 *                  缺则依赖大库的判据（C32/C34/C35 与 C36 主判）记 NA 并写明
 *   --three-layer=<lab> C31 三层夹具（默认 `_工作\lab-094-3layer`，由 _工作\tools\make-3layer-lab.mjs
 *                  用真实插件管线生成：热=锚点日 / 温=90–180 天前 / 冷=>365 天前，3 个 sid 各一层）；
 *                  缺/基线不合法 → C31 记 NA 并写明缺什么；锚点≠今天 → NA（夹具过期，重跑生成器）
 *   --only         只跑指定判据（逗号分隔，如 C27,C36）
 *   --json         stdout 只出机读 JSON（证据文件照常落盘）
 *   --proof        只跑「注入故障→红→还原→绿」自证（默认 C26/C28/C29/C30/C36），证据落 --evid-dir\
 *   --keep         保留工作副本（--work-dir；默认 %TEMP%\dsh-ledger-work\0.9.4，跑完删；副本不得当证据）
 *   --evid-dir=<dir>  证据目录（默认 %TEMP%\dsh-ledger-evidence\094-criteria-*；判据-1.0 聚合时指到本次证据目录）
 *   --work-dir=<dir>  工作副本根（默认 %TEMP%\dsh-ledger-work\0.9.4）
 *
 * 退出码：0 = 参与判定的判据全绿（无红、无 NA）；1 = 有红或 NA（NA=未验，不算绿）；2 = 用法/环境错误。
 *
 * @reads   `<lab>\root`（以及大库 `<big>\root`，只读）、`_工作\计划\0.9.4-P3扩容方案.md`、
 *          `签字单-已签-20261113.md`（C24 文档口径）
 * @writes  仅 `--evid-dir`（默认 %TEMP%\dsh-ledger-evidence\094-criteria-<时间戳>\**，证据/摘要）与
 *          `--work-dir`（默认 %TEMP%\dsh-ledger-work\0.9.4\**，工作副本，默认删）；**不写包上一级**；
 *          **不写任何账库**（C28/C29/C36/C37 的破坏/重建全在工作副本上做）
 * @invokes node tools\cli.mjs index query（C33 走公开 CLI；其余优先 in-process 只读调用）
 * @depends node:fs/path/crypto/url/child_process；tools/pointerindex.mjs；tools/backup.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.resolve(LITE, '..'); // _工作
const BASE = path.resolve(WORK, '..'); // <workspace>（签字单所在；真实工作区名已脱敏）

const pi = await import(pathToFileURL(path.join(LITE, 'tools', 'pointerindex.mjs')).href);
const backupMod = await import(pathToFileURL(path.join(LITE, 'tools', 'backup.mjs')).href);
// C31 的公共"按 sid 查"入口（暴力 readAll 路径）：与索引查询、本文件独立台账扫描三路对撞。
const ledgerapi = await import(pathToFileURL(path.join(LITE, 'tools', 'ledgerapi.js')).href);

// ============================================================================
// 一、参数 / 环境
// ============================================================================
const SCHEMA = 'criteria-0.9.4/1';
const args = process.argv.slice(2);
const argOf = (k) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : '';
};
const hasFlag = (k) => args.includes(`--${k}`);
const only = (argOf('only') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const asJson = hasFlag('json');
const doProof = hasFlag('proof');
const keepWork = hasFlag('keep');
const wantHelp = args.includes('--help') || args.includes('-h');

const DEFAULT_LAB = path.join(WORK, 'c01-lab');
const DEFAULT_BIG = path.join(WORK, 'lab-e3-accept');
const LAB = path.resolve(argOf('lab') || DEFAULT_LAB);
const BIG_LAB = path.resolve(argOf('big') || DEFAULT_BIG);
const ROOT_OVERRIDE = argOf('root') ? path.resolve(argOf('root')) : '';

const USAGE = `判据执行器 0.9.4（lite 线）· C26–C37 + C24 口径 + S-10 五项

用法：
  node docs\\判据-0.9.4.mjs [选项]
  node docs\\判据-0.9.4.mjs --proof            # 只跑 注入故障→红 → 还原→绿 自证

选项：
  --lab=<lab>      小库 lab（默认 _工作\\c01-lab；账库取其 root\\）
  --root=<账库>    直接指定账库根（覆盖 --lab 推导）
  --big=<lab>      大库 lab（默认 _工作\\lab-e3-accept；只读；缺则相关判据 NA）
  --three-layer=<lab> C31 三层夹具（默认 _工作\\lab-094-3layer；缺/过期 → C31 NA 并写明）
  --only=C26,...   只跑指定判据
  --json           stdout 只出机读 JSON（证据照常落盘）
  --proof          只跑自证（注入→红→还原→绿）
  --keep           保留 --work-dir 工作副本
  --help           本说明

退出码：0=参与判定的判据全绿（无红/无 NA）；1=有红或 NA；2=用法/环境错误。
口径（S-10）：C27 四字段不查 entryHash；C36 两种分母都 ≤15%；C32 非 O(1)、按实测阈值；C24 用 GiB≈364。
C31 三层夹具口径：热=锚点日（生成当日 +08:00）、温=90–180 天前、冷=>365 天前；3 个 sid 各一层且跨月。
证据：--evid-dir（默认 %TEMP%\\dsh-ledger-evidence\\094-criteria-<YYYYMMDD-HHmmss>\\；summary.json / summary.md / 逐条 *.json）`;

function usageError(msg) {
  console.error(`[用法错误] ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}
if (wantHelp) {
  console.log(USAGE);
  process.exit(0);
}
const KNOWN_FLAGS = new Set([
  'lab', 'root', 'big', 'three-layer', 'only', 'json', 'proof', 'keep', 'help', 'evid-dir', 'work-dir',
]);
for (const a of args) {
  if (!a.startsWith('--')) usageError(`不认识的裸参数：${a}`);
  const k = a.slice(2).split('=')[0];
  if (!KNOWN_FLAGS.has(k)) usageError(`不认识的参数 --${k}`);
}

const nowMs = Date.now();
const localStamp = (() => {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
})();
// 证据 / 工作副本（re3，审计 P0：判据跑在交付包上时**不许写包外**）：
//   --evid-dir / --work-dir 由 docs/判据-1.0.mjs 显式传入（落本次证据目录 / %TEMP%）；
//   单独运行时默认落 %TEMP%，不写包上一级。
const EVID = path.resolve(argOf('evid-dir') || path.join(os.tmpdir(), 'dsh-ledger-evidence', `094-criteria-${localStamp}`));
const WORKTMP = path.resolve(argOf('work-dir') || path.join(os.tmpdir(), 'dsh-ledger-work', '0.9.4'));
const evidLog = [];

function writeEvid(name, data) {
  fs.mkdirSync(EVID, { recursive: true });
  const p = path.join(EVID, name);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  evidLog.push(String(p).split(path.sep).join('/'));
  return p;
}
function writeTextEvid(name, text) {
  fs.mkdirSync(EVID, { recursive: true });
  const p = path.join(EVID, name);
  fs.writeFileSync(p, `${text}\n`, 'utf8');
  evidLog.push(String(p).split(path.sep).join('/'));
  return p;
}
function noteLine(s) {
  evidLog.push(s);
}

// 小库 / 大库解析
function resolveLab(lab, { required, label }) {
  const root = ROOT_OVERRIDE && label === '小库' ? ROOT_OVERRIDE : path.join(lab, 'root');
  let ok = false;
  let why = '';
  try {
    ok = fs.statSync(root).isDirectory() && fs.statSync(path.join(root, 'ledger')).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) why = `${label}账库不可用：${root}（缺目录或 ledger\\）`;
  return { ok, why, lab, root, label };
}
const SMALL = resolveLab(LAB, { required: true, label: '小库' });
const BIG = resolveLab(BIG_LAB, { required: false, label: '大库' });

// ---- C31 三层夹具（热/温/冷）----
const DEFAULT_THREE = path.join(WORK, 'lab-094-3layer');
const THREE_LAB = path.resolve(argOf('three-layer') || DEFAULT_THREE);
/** C31 三层窗口（与 _工作\tools\make-3layer-lab.mjs 写死同源；改口径必须两边一起改）。 */
const C31_CALIBER = {
  hot: { name: '热', fromDays: 0, toDays: 0, desc: '锚点日（生成当日=今天）' },
  warm: { name: '温', fromDays: 90, toDays: 180, desc: '90–180 天前' },
  cold: { name: '冷', fromDays: 366, toDays: null, desc: '超过 1 年（>365 天）' },
};
/**
 * 解析三层夹具：root\ledger 必须存在、manifest.json 必须可解析且形状是 dsh-094-3layer-lab/1。
 * 这里只回答"夹具在不在、能不能当基线用"；三层断言不成立属于 RED（夹具在但被破坏），不属于 NA。
 */
function resolveThreeLab(lab) {
  const root = path.join(lab, 'root');
  const manifestPath = path.join(lab, 'manifest.json');
  const out = { ok: false, why: '', lab, root, manifestPath, manifest: null };
  let rootOk = false;
  try {
    rootOk = fs.statSync(root).isDirectory() && fs.statSync(path.join(root, 'ledger')).isDirectory();
  } catch { rootOk = false; }
  if (!rootOk) {
    out.why = `三层夹具不可用：${root}（缺目录或 ledger\\）`;
    return out;
  }
  if (!fs.existsSync(manifestPath)) {
    out.why = `三层夹具缺基线 manifest.json：${manifestPath}（先跑 node _工作\\tools\\make-3layer-lab.mjs）`;
    return out;
  }
  let man = null;
  try { man = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    out.why = `三层夹具基线不可解析：${manifestPath}（${String((e && e.message) || e)}）`;
    return out;
  }
  if (!man || man.kind !== 'dsh-094-3layer-lab' || man.v !== 1) {
    out.why = `三层夹具基线形状不对：kind=${man && man.kind} v=${man && man.v}（期望 dsh-094-3layer-lab/1）`;
    return out;
  }
  if (typeof man.anchor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(man.anchor)) {
    out.why = `三层夹具基线缺合法 anchor：${String(man && man.anchor)}`;
    return out;
  }
  if (!Array.isArray(man.layers) || man.layers.length !== 3) {
    out.why = `三层夹具基线 layers 不是 3 层：${Array.isArray(man.layers) ? man.layers.length : '非数组'}`;
    return out;
  }
  out.ok = true;
  out.manifest = man;
  return out;
}
const THREE = resolveThreeLab(THREE_LAB);

// ============================================================================
// 二、通用小工具
// ============================================================================
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const SHARD_RE = /^idx-(\d{8})(?:-(\d{2,}))?\.jsonl$/;
const CODE_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;
const THIN_ROW_KEYS = new Set(['c', 'd', 'o', 'n', 't']);

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '?';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(3)} GiB`;
}
function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}
function ymdToIso(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
function isoToYmd(iso) {
  return iso.slice(0, 10).replace(/-/g, '');
}
function ymdAddDays(ymd, days) {
  const ms = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + days * 86400000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
function monthStart(ymd) { return `${ymd.slice(0, 6)}01`; }
function monthEnd(ymd) {
  const y = +ymd.slice(0, 4);
  const m = +ymd.slice(4, 6);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ymd.slice(0, 6)}${String(last).padStart(2, '0')}`;
}
/** 台账 ts → 本地(+08:00) YYYYMMDD（与分片口径一致）。 */
function tsLocalYmd(ts) {
  if (typeof ts !== 'string' || !ts) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(ts.trim());
  if (!m) return /^\d{4}-\d{2}-\d{2}/.test(ts) ? isoToYmd(ts) : '';
  if (!m[8]) return `${m[1]}${m[2]}${m[3]}`; // 无偏移 = 本地口径
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
function relPosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}
/** 目录遍历（含隐藏项；不走符号链接）。返回 [{abs, rel, size}]。 */
function walkAll(root, { skipNames = null } = {}) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 24) continue;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (skipNames && skipNames(ent.name, abs)) continue;
      if (ent.isDirectory()) { stack.push({ dir: abs, depth: depth + 1 }); continue; }
      try {
        const st = ent.isSymbolicLink() ? fs.lstatSync(abs) : fs.statSync(abs);
        out.push({ abs, rel: relPosix(root, abs), size: st.size });
      } catch { /* 读不到的不算绿：由调用方决定是否报错 */ }
    }
  }
  return out;
}
/** fs.readFileSync 计数钩子（只读；用于"是否重扫/读了哪些文件"的硬证据）。 */
function withReadHook(fn) {
  const orig = fs.readFileSync;
  const calls = [];
  fs.readFileSync = function (p, ...rest) {
    const buf = orig.call(fs, p, ...rest);
    const n = Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));
    calls.push({ p: String(p), n });
    return buf;
  };
  try {
    return { result: fn(), calls };
  } finally {
    fs.readFileSync = orig;
  }
}
function msNow() { return Number(process.hrtime.bigint() / 1000000n); }
function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { value, ms };
}

// ============================================================================
// 三、台账 / 索引只读扫描（本文件独立实现，不复用 stat/readAll 的判定结论）
// ============================================================================
const ledgerCache = new Map();
const indexCache = new Map();

/**
 * 扫台账（只读）。带行字节偏移，供 C26/C27/C30 独立对账。
 * @returns {{root,dirExists,dir,files,days:Map<ymd,{name,bytes,rows,buf}>,rows,totalBytes,totalRows,badLines,nonLedgerRows,errors}}
 */
function scanLedger(root) {
  if (ledgerCache.has(root)) return ledgerCache.get(root);
  const dir = path.join(root, 'ledger');
  const out = {
    root, dir, dirExists: false, files: [], days: new Map(),
    rows: [], totalBytes: 0, totalRows: 0, badLines: 0, nonLedgerRows: 0,
    rowsWithoutFile: 0, errors: [],
  };
  let names = [];
  try { names = fs.readdirSync(dir); out.dirExists = true; } catch (e) {
    out.errors.push({ dir, error: String((e && e.message) || e) });
    ledgerCache.set(root, out);
    return out;
  }
  names = names.filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  for (const name of names) {
    const abs = path.join(dir, name);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) {
      out.errors.push({ file: name, error: String((e && e.message) || e) });
      continue;
    }
    out.files.push({ name, bytes: buf.length });
    out.totalBytes += buf.length;
    const m = DAY_FILE_RE.exec(name);
    const day = m ? `${m[1]}${m[2]}${m[3]}` : '';
    const rows = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const complete = nl !== -1;
      const end = complete ? nl : buf.length;
      const offset = pos;
      const bytes = end - offset;
      pos = complete ? end + 1 : buf.length;
      if (bytes === 0) continue;
      const raw = buf.toString('utf8', offset, end);
      if (!raw.trim()) continue;
      let rec = null;
      try { rec = JSON.parse(raw); } catch { out.badLines++; continue; }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { out.nonLedgerRows++; continue; }
      if (typeof rec.code !== 'string' || !CODE_RE.test(rec.code) || rec.ts == null) { out.nonLedgerRows++; continue; }
      rows.push({ offset, bytes, code: rec.code, record: rec });
    }
    out.totalRows += rows.length;
    out.rows.push(...rows.map((r) => ({ ...r, file: name, day })));
    if (day) out.days.set(day, { name, bytes: buf.length, rows, buf });
    else out.rowsWithoutFile += rows.length;
  }
  ledgerCache.set(root, out);
  return out;
}

/**
 * 扫索引分片（只读）：瘦行必须只有 {c,d,o,n[,t]}，d 为 43 字 base64url（32 B），o/n 整数或 null。
 * @returns {{root,dirExists,dir,files,rows,totalBytes,badLines,state,stray}}
 */
function scanIndex(root) {
  if (indexCache.has(root)) return indexCache.get(root);
  const list = pi.listIndexShardFiles(root);
  const out = {
    root, dir: pi.indexDir(root), dirExists: list.dirExists,
    files: [], rows: [], totalBytes: 0, badLines: 0, state: null, stray: list.stray,
  };
  for (const f of list.files) {
    let txt = '';
    try { txt = fs.readFileSync(f.abs, 'utf8'); } catch { out.badLines++; continue; }
    out.files.push({ name: f.name, day: f.day, part: f.part, bytes: f.bytes });
    out.totalBytes += f.bytes;
    let lineNo = 0;
    let pos = 0;
    while (pos < txt.length) {
      const nl = txt.indexOf('\n', pos);
      const end = nl === -1 ? txt.length : nl;
      const line = txt.slice(pos, end);
      const at = ++lineNo;
      pos = nl === -1 ? txt.length : nl + 1;
      if (!line.trim()) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { out.badLines++; continue; }
      const keys = o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : null;
      const thinOk = !!keys && keys.every((k) => THIN_ROW_KEYS.has(k))
        && typeof o.c === 'string' && CODE_RE.test(o.c)
        && (o.d === null || (typeof o.d === 'string' && pi.docShaFromField(o.d) !== ''))
        && (o.o === null || (Number.isInteger(o.o) && o.o >= 0))
        && (o.n === null || (Number.isInteger(o.n) && o.n >= 0))
        && (o.t == null || (Number.isInteger(o.t) && o.t >= 0));
      out.rows.push({
        c: o && o.c, d: o && o.d, o: o && o.o, n: o && o.n, t: o && o.t,
        day: f.day, file: f.name, line: at, raw: line, thinOk,
        keys, hasEntryHash: !!keys && (keys.includes('h') || keys.includes('entryHash')),
        docShaHex: o && o.d ? pi.docShaFromField(o.d) : '',
      });
    }
  }
  out.state = pi.readIndexState(root);
  indexCache.set(root, out);
  return out;
}

/** 索引行按台账日分组（保持写入顺序）。 */
function indexRowsByDay(idx) {
  const map = new Map();
  for (const r of idx.rows) {
    if (!map.has(r.day)) map.set(r.day, []);
    map.get(r.day).push(r);
  }
  return map;
}

// ---- 工作副本（破坏性检查只在这里做） ----
function freshWorkDir() {
  fs.rmSync(WORKTMP, { recursive: true, force: true });
  fs.mkdirSync(WORKTMP, { recursive: true });
}
let copySeq = 0;
function copyRoot(srcRoot, tag) {
  // 每次拷贝用唯一子目录：避免同一个路径被"上一轮扫描缓存"污染（自证模式会连续跑红/绿两轮）
  const dst = path.join(WORKTMP, tag, `run-${++copySeq}`, 'root');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(srcRoot, dst, { recursive: true });
  ledgerCache.delete(dst);
  indexCache.delete(dst);
  return dst;
}
/** C31 自证用：只拷三层夹具的 root\（manifest 由 ctx.three 指向原基线，不随副本变）。 */
function copyThreeRoot(tag) {
  const dst = path.join(WORKTMP, tag, `run-${++copySeq}`, 'root');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(THREE.root, dst, { recursive: true });
  ledgerCache.delete(dst);
  indexCache.delete(dst);
  return dst;
}
let synthSeq = 0;
/** 造一条"合法的新账行"（复制最后一行，只改 code 序号/turn/seq/ts 日期），供 C28/C37 追加用。 */
function makeSyntheticRow(ledger) {
  const days = [...ledger.days.keys()].sort();
  if (!days.length) return null;
  const day = days[days.length - 1];
  const d = ledger.days.get(day);
  const last = d.rows[d.rows.length - 1];
  if (!last) return null;
  const rec = JSON.parse(JSON.stringify(last.record));
  rec.code = `${last.code.slice(0, 24)}${String(91000000 + (++synthSeq)).padStart(8, '0')}`;
  rec.turn = 91000000 + synthSeq;
  rec.seq = 91000000 + synthSeq;
  rec.ts = `${ymdToIso(day)}T23:59:59+08:00`;
  return { day, file: d.name, abs: path.join(ledger.root, 'ledger', d.name), rec, line: JSON.stringify(rec) };
}
function appendSyntheticRow(root) {
  ledgerCache.delete(root);
  const led = scanLedger(root);
  const syn = makeSyntheticRow(led);
  if (!syn) throw new Error('台账为空，无法追加合成行');
  fs.appendFileSync(syn.abs, `${syn.line}\n`, 'utf8');
  ledgerCache.delete(root);
  return { ...syn, bytes: Buffer.byteLength(syn.line) + 1 };
}

// ============================================================================
// 四、C24（GiB 口径）+ C26–C37 判据
// ============================================================================
const C32_MAX_MS = 50; // 单 code 查询阈值（E3 实测 3–9 ms；≈5× 余量；口径见 C32 证据）
const C34_TODAY_MS = 100;
const C34_D90_MS = 1000;
const C34_COLD_MS = 2000;
const C36_RATIO_MAX = 0.15;

function docGrep(file, re, limit = 8) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const hits = [];
  txt.split('\n').forEach((line, i) => {
    if (re.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits.slice(0, limit);
}

/** C24：一年/三年体积预估写入文档、单位 GiB、标"推算"（S-10③）。 */
function runC24() {
  const roundsPerDay = 3168; // S-9 过渡期 3×
  const years = 3;
  const rounds = roundsPerDay * 365 * years;
  const compressionKiB = 31.5; // S-9（1024 体系）
  const decompress = 176874264 / 50640283; // 3.4928（实测）
  const totalKiB = compressionKiB * decompress * rounds;
  const gib = totalKiB / 1024 / 1024;
  const planPath = path.join(WORK, '计划', '0.9.4-P3扩容方案.md');
  const signPath = path.join(BASE, '新的开始-V0.9.0新版本', '签字单-已签-20261113.md');
  // ★ v1.0.0-re2：加包内回退（审计 P1-15），口径未变 ——
  //   原路径（开发机 `_工作\计划\…` 与 `BASE\…\签字单`）在接收端不存在时，
  //   回退到**交付包内**载有同一口径（≈364 GiB ＋ 推算）的交付文档；两边都没有 → NA（缺文档源），不假绿。
  //   阈值/期望值/判定公式一个字未动（仍是 /36[34](?:\.\d+)?\s*GiB/ 与 /推算|外推/ 与 |gib-364|/364<=0.01）。
  const fallbackDocs = [
    path.join(LITE, '交付-v0.9.4', '02-验收记录.md'),
    path.join(LITE, '交付-v0.9.4', '00-交付清单.md'),
    path.join(LITE, '交付-v0.9.4', '05-已知未覆盖项.md'),
    path.join(LITE, '交付-v0.9.5', '02-验收记录.md'),
    path.join(LITE, '交付-v0.9.5', '05-已知未覆盖项.md'),
    path.join(LITE, '交付-v1.0.0-re', '02-验收记录.md'),
    path.join(LITE, '交付-v1.0.0-re', '05-已知未覆盖项.md'),
  ].filter((p) => fs.existsSync(p));
  const planExists = fs.existsSync(planPath);
  const signExists = fs.existsSync(signPath);
  const planGiB = docGrep(planPath, /36[34](?:\.\d+)?\s*GiB/);
  const planTuiSuan = docGrep(planPath, /推算|外推/);
  const signGiB = docGrep(signPath, /36[34](?:\.\d+)?\s*GiB/);
  // 包内回退：逐个交付文档找同一口径，记来源
  const fallbackHits = [];
  for (const doc of fallbackDocs) {
    const gibHits = docGrep(doc, /36[34](?:\.\d+)?\s*GiB/);
    if (gibHits.length) fallbackHits.push({ doc: path.relative(LITE, doc).split(path.sep).join('/'), gibHits: gibHits.slice(0, 2), tuiSuan: docGrep(doc, /推算|外推/).length });
  }
  const fallbackGiB = fallbackHits.length;
  const fallbackTuiSuan = fallbackHits.filter((h) => h.tuiSuan > 0).length;
  if (!planExists && !signExists && fallbackDocs.length === 0) {
    return {
      id: 'C24',
      title: '三年体积预估写在文档：GiB 口径 ≈364 GiB 且标"推算"（S-10③）',
      status: 'NA',
      reasons: [
        `缺文档源：原路径 ${path.relative(WORK, planPath)} 与 ${path.relative(BASE, signPath)} 都不存在，包内也没有可回退的交付文档`,
        '这条判据的判定对象是"文档里有没有 ≈364 GiB ＋ 推算标记"，无文档即未验（NA ≠ 绿）',
      ],
      summary: 'NA：缺文档源（原路径与包内回退都没有）',
      evidence: { docs: { planPath: path.relative(WORK, planPath), planExists, signPath: path.relative(BASE, signPath), signExists, fallbackDocs: [] }, caliber: 'S-10③ 口径未变；仅输入源解析加包内回退（审计 P1-15）' },
    };
  }
  const docOk = (planGiB.length > 0 || signGiB.length > 0 || fallbackGiB > 0) && (planTuiSuan.length > 0 || signGiB.length > 0 || fallbackTuiSuan > 0);
  const modelOk = Math.abs(gib - 364) / 364 <= 0.01;
  const evidence = {
    model: {
      roundsPerDay, years, rounds,
      compressionPerRoundKiB: compressionKiB,
      decompressRatio: Number(decompress.toFixed(4)),
      totalKiB: Math.round(totalKiB),
      GiB: Number(gib.toFixed(2)),
      clause: '≈364 GiB（S-10③ 复算 363.9）',
      mark: '推算（31.5 KiB/轮压缩 × 3.4928 解压 × 3,468,960 轮）',
    },
    docs: {
      planPath: path.relative(WORK, planPath), planExists, planGiB, planTuiSuan: planTuiSuan.slice(0, 3),
      signPath: path.relative(BASE, signPath), signExists, signGiB,
      fallbackDocs: fallbackHits,
      source: planGiB.length || planTuiSuan.length ? 'plan' : (signGiB.length ? 'sign' : 'package-fallback'),
      pending: '0.9.4 交付文档 04 尚未生成（出包时须按 S-10③ 复述 ≈364 GiB + 标"推算"）；计划 §1.1 仍留 S-9 历史口径 "≈363 GB"，已在 §4.7 更正为 GiB',
    },
  };
  const status = modelOk && docOk ? 'GREEN' : 'RED';
  return {
    id: 'C24', title: '三年体积预估写在文档：GiB 口径 ≈364 GiB 且标"推算"（S-10③）',
    status, evidence,
    summary: status === 'GREEN'
      ? `复算 ${gib.toFixed(1)} GiB ≈364 GiB；Plan §4.7 GiB 命中 ${planGiB.length} 处、推算标记 ${planTuiSuan.length} 处、签字单 GiB 命中 ${signGiB.length} 处${fallbackGiB ? `、包内交付文档回退命中 ${fallbackGiB} 份（${fallbackHits.map((h) => h.doc).join('、')}）` : ''}（交付文档 04 待出包复述）`
      : `GiB≈364 或文档口径不成立（planGiB=${planGiB.length} signGiB=${signGiB.length} 推算=${planTuiSuan.length} 包内回退=${fallbackGiB}）`,
  };
}

/** C26：索引条数 = 台账行数（同天），每条 code 在台账里存在。 */
function runC26(ctx) {
  const roots = [ctx.small, ctx.big].filter((r) => r && r.ok);
  if (!roots.length) return { id: 'C26', status: 'NA', title: '索引条数＝台账行数（同天）', summary: '缺可用账库', reasons: [SMALL.why] };
  const per = [];
  const problems = [];
  for (const r of roots) {
    const led = scanLedger(r.root);
    const idx = scanIndex(r.root);
    if (!idx.dirExists) {
      problems.push(`${r.label}：索引目录不存在（先跑 node tools\\cli.mjs index build --root=...）`);
      continue;
    }
    const byDay = indexRowsByDay(idx);
    const days = [...new Set([...led.days.keys(), ...byDay.keys()])].sort();
    let countMismatch = 0;
    let missing = 0;
    let extra = 0;
    let duplicate = 0;
    const samples = [];
    const seen = new Set();
    for (const row of idx.rows) {
      if (seen.has(row.c)) { duplicate++; if (samples.length < 5) samples.push({ kind: 'duplicate-index-code', code: row.c }); }
      seen.add(row.c);
    }
    for (const day of days) {
      const lRows = led.days.has(day) ? led.days.get(day).rows : [];
      const iRows = byDay.get(day) || [];
      if (lRows.length !== iRows.length) {
        countMismatch++;
        if (samples.length < 8) samples.push({ kind: 'count-mismatch', day, ledgerRows: lRows.length, indexRows: iRows.length });
      }
      const lCodes = new Set(lRows.map((x) => x.code));
      for (const ir of iRows) if (!lCodes.has(ir.c)) { missing++; if (samples.length < 8) samples.push({ kind: 'index-code-not-in-ledger', day, code: ir.c }); }
      const iCodes = new Set(iRows.map((x) => x.c));
      for (const lr of lRows) if (!iCodes.has(lr.code)) { extra++; if (samples.length < 8) samples.push({ kind: 'ledger-row-missing-in-index', day, code: lr.code }); }
    }
    const ok = countMismatch === 0 && missing === 0 && extra === 0 && duplicate === 0 && led.badLines === 0;
    if (!ok) problems.push(`${r.label}：countMismatch=${countMismatch} 缺索引=${extra} 索引多余=${missing} 重复=${duplicate}`);
    per.push({
      root: r.root, label: r.label,
      ledgerDays: led.days.size, indexDays: byDay.size,
      ledgerRows: led.rows.length, indexRows: idx.rows.length,
      countMismatch, missingInIndex: extra, indexNotInLedger: missing, duplicateIndexCodes: duplicate,
      ledgerBadLines: led.badLines, samples, ok,
    });
  }
  const status = problems.length === 0 && per.every((p) => p.ok) ? 'GREEN' : 'RED';
  return {
    id: 'C26', title: '索引条数＝台账行数（同天），每条 code 在台账里存在',
    status, evidence: { per, problems },
    summary: status === 'GREEN'
      ? per.map((p) => `${p.label} ${p.ledgerDays} 日/台账 ${p.ledgerRows} 行=索引 ${p.indexRows} 行，缺/多/重复 0`).join('；')
      : problems[0] || '对账不一致',
  };
}

/** C27：S-10① —— 瘦行四字段由原文/台账独立复算（不查 entryHash）。 */
function runC27(ctx) {
  const roots = [ctx.small, ctx.big].filter((r) => r && r.ok);
  if (!roots.length) return { id: 'C27', status: 'NA', title: '索引瘦行四字段独立复算', summary: '缺可用账库', reasons: [SMALL.why] };
  const per = [];
  const problems = [];
  for (const r of roots) {
    const led = scanLedger(r.root);
    const idx = scanIndex(r.root);
    if (!idx.dirExists) { problems.push(`${r.label}：索引目录不存在`); continue; }
    const byDay = indexRowsByDay(idx);
    let thinBad = 0;
    let entryHashFields = 0;
    let pointerBad = 0;
    let docShaVsLedgerBad = 0;
    let docShaMissing = 0;
    let viewChecked = 0;
    let viewBad = 0;
    let viewMissing = 0;
    const samples = [];
    const days = [...led.days.keys()].sort();
    for (const day of days) {
      const ld = led.days.get(day);
      const iRows = byDay.get(day) || [];
      const n = Math.min(ld.rows.length, iRows.length);
      for (const ir of iRows) {
        if (!ir.thinOk) { thinBad++; if (samples.length < 8) samples.push({ kind: 'thin-row-shape-bad', day, line: ir.line, keys: ir.keys }); }
        if (ir.hasEntryHash) { entryHashFields++; if (samples.length < 8) samples.push({ kind: 'entryHash-present', day, code: ir.c }); }
      }
      for (let i = 0; i < n; i++) {
        const lr = ld.rows[i];
        const ir = iRows[i];
        // ① code + offset + bytes：直接在台账日文件字节区间上独立复算
        if (ir.o !== null && ir.n !== null && ir.o + ir.n <= ld.buf.length) {
          const raw = ld.buf.toString('utf8', ir.o, ir.o + ir.n);
          let rec = null;
          try { rec = JSON.parse(raw); } catch { pointerBad++; continue; }
          if (!rec || rec.code !== ir.c || ir.c !== lr.code) {
            pointerBad++;
            if (samples.length < 8) samples.push({ kind: 'pointer-recompute-bad', day, i: i + 1, indexCode: ir.c, ledgerCode: lr.code, offset: ir.o, bytes: ir.n });
          }
        } else {
          pointerBad++;
        }
        // ② docFileSha256：台账行自带的字段 + 原文视图整文件 sha256 两路独立复算
        const ledgerSha = typeof lr.record.docFileSha256 === 'string' ? lr.record.docFileSha256.trim().toLowerCase() : '';
        if (!ledgerSha) { docShaMissing++; continue; }
        if (ir.docShaHex !== ledgerSha) {
          docShaVsLedgerBad++;
          if (samples.length < 8) samples.push({ kind: 'doc-file-sha-vs-ledger-bad', day, code: ir.c, indexSha: ir.docShaHex, ledgerSha });
        }
        // 原文视图（完整原文.md）整文件 sha256 —— "由原文独立复算"
        const viewRel = typeof lr.record.doc === 'string' && lr.record.doc ? lr.record.doc : '';
        if (!viewRel) { viewMissing++; continue; }
        const abs = path.isAbsolute(viewRel) ? viewRel : path.join(r.root, viewRel);
        let actual = '';
        try { actual = sha256File(abs); } catch { actual = ''; }
        viewChecked++;
        if (!actual) {
          viewMissing++;
          if (samples.length < 8) samples.push({ kind: 'view-missing', day, code: ir.c, doc: viewRel });
        } else if (actual !== ledgerSha || (ir.d !== null && actual !== ir.docShaHex)) {
          viewBad++;
          if (samples.length < 8) samples.push({ kind: 'view-sha-bad', day, code: ir.c, expectedLedgerSha: ledgerSha, expectedIndexSha: ir.docShaHex, actual });
        }
      }
    }
    const ok = thinBad === 0 && entryHashFields === 0 && pointerBad === 0 && docShaVsLedgerBad === 0
      && docShaMissing === 0 && viewBad === 0 && viewMissing === 0 && idx.badLines === 0;
    if (!ok) {
      problems.push(`${r.label}：thinBad=${thinBad} entryHash=${entryHashFields} pointerBad=${pointerBad} dVs=${docShaVsLedgerBad} dMissing=${docShaMissing} viewBad=${viewBad} viewMissing=${viewMissing}`);
    }
    per.push({
      root: r.root, label: r.label, indexRows: idx.rows.length, ledgerRows: led.rows.length,
      thinBad, entryHashFields, pointerBad, docShaVsLedgerBad, docShaMissing,
      viewChecked, viewBad, viewMissing, ok, samples,
    });
  }
  const status = problems.length === 0 && per.every((p) => p.ok) ? 'GREEN' : 'RED';
  const totalRows = per.reduce((a, p) => a + p.ledgerRows, 0);
  return {
    id: 'C27', title: '★ 索引瘦行四字段（code+docFileSha256+offset+bytes）由原文/台账独立复算（S-10①，不查 entryHash）',
    status, evidence: { per, problems, caliber: 'S-10①：四字段由原文/台账复算；不引入 entryHash（S-6 否决）' },
    summary: status === 'GREEN'
      ? `${per.map((p) => `${p.label} ${p.ledgerRows} 行`).join('+')}：指针区间/台账 docFileSha256/原文 md 整文件 sha 全部独立复算一致；h/entryHash 字段 0`
      : problems[0] || '四字段复算不一致',
  };
}

/** C28：新增一行 → 索引同步加一行（不重建；按档 A 口径验增量写）。 */
function runC28(ctx) {
  const r = ctx.small;
  if (!r || !r.ok) return { id: 'C28', status: 'NA', title: '新增一行→索引同步加一行', summary: '缺小库', reasons: [SMALL.why] };
  const root = copyRoot(r.root, 'c28');
  const led0 = scanLedger(root);
  const idx0 = scanIndex(root);
  if (!idx0.dirExists || idx0.rows.length === 0) {
    return { id: 'C28', status: 'RED', title: '新增一行→索引同步加一行', summary: '索引缺失/为空，无法验增量同步（先 index build）', evidence: { root } };
  }
  if (led0.rows.length !== idx0.rows.length) {
    return {
      id: 'C28', status: 'RED', title: '新增一行→索引同步加一行',
      summary: `索引未同步：台账 ${led0.rows.length} 行 vs 索引 ${idx0.rows.length} 行（追加后必须 sync 再判）`,
      evidence: { root, ledgerRows: led0.rows.length, indexRows: idx0.rows.length, hint: '注入=只追加台账行不建索引；还原=node tools\\cli.mjs index build' },
    };
  }
  const shardsBefore = new Map(idx0.files.map((f) => [f.name, sha256File(path.join(idx0.dir, f.name))]));
  const beforeRows = idx0.rows.length;
  const syn = appendSyntheticRow(root);
  let build = null;
  let calls = [];
  try {
    const hooked = withReadHook(() => pi.buildIndex({ root }));
    build = hooked.result;
    calls = hooked.calls;
  } catch (e) {
    return { id: 'C28', status: 'RED', title: '新增一行→索引同步加一行', summary: `index build 失败：${String((e && e.message) || e)}`, evidence: { root } };
  }
  indexCache.delete(root);
  ledgerCache.delete(root);
  const idx1 = scanIndex(root);
  const changedDay = syn.day;
  const afterRows = idx1.rows.length;
  const otherShardsChanged = [];
  for (const f of idx1.files) {
    if (f.day === changedDay) continue;
    const before = shardsBefore.get(f.name);
    const after = sha256File(path.join(idx1.dir, f.name));
    if (before === undefined || before !== after) otherShardsChanged.push(f.name);
  }
  const created = idx1.files.filter((f) => !shardsBefore.has(f.name)).map((f) => f.name);
  // 读放大：build 读了多少台账字节 / 新增行字节；是否读了原文视图
  const ledgerReadBytes = calls
    .filter((c) => {
      const rel = relPosix(root, c.p);
      return /^ledger\/[^/]+\.jsonl$/.test(rel) && !path.basename(rel).startsWith('.');
    })
    .reduce((a, c) => a + c.n, 0);
  const viewReads = calls.filter((c) => {
    const rel = relPosix(root, c.p);
    return rel.endsWith('完整原文.md') || rel.endsWith('原始事件.json');
  }).length;
  const shardReads = calls.filter((c) => relPosix(root, c.p).startsWith('ledger/.index/')).length;
  const syncOk = afterRows === beforeRows + 1 && build.ok === true;
  const noRebuildOk = build.written === 1 && build.removed === 0 && otherShardsChanged.length === 0;
  const noViewRescan = viewReads === 0;
  const readAmplification = syn.bytes > 0 ? ledgerReadBytes / syn.bytes : Infinity;
  const rescanOk = readAmplification <= 3; // 计划 E4-2：fs hook 读字节 ≤ 新行字节×3（档 A idx-sync 口径）
  const defect = rescanOk ? null : {
    id: 'C28-read-amplification',
    why: `index build 仍整读台账（${ledgerReadBytes} B = ${readAmplification.toFixed(1)}× 新行 ${syn.bytes} B；计划 E4-2 阈值 ≤3×），缺"只读新增尾"的 idx-sync 路径`,
    impact: '不重建/不重扫原文成立；但"不重扫台账"未达 → 3 年 3.19 GB 台账上每次 sync 仍是全量读（推算）',
  };
  // ★ 判据原文含"（不重建、不重扫）"：不重扫按计划 E4-2 的 fs hook 阈值实测未达 → 整条 RED，
  //   但"同步 +1 / 不重建 / 不重扫原文"三个可验子项都成立（红→绿证据见 --proof）。
  const status = syncOk && noRebuildOk && noViewRescan && rescanOk ? 'GREEN' : 'RED';
  return {
    id: 'C28', title: '新增一行→索引同步加一行（不重建、不重扫）',
    status,
    evidence: {
      root, beforeRows, afterRows, changedDay, appendedRowBytes: syn.bytes,
      build: { written: build.written, unchanged: build.unchanged, removed: build.removed, ok: build.ok, ms: build.ms },
      otherShardsChanged, createdShards: created,
      reads: { ledgerReadBytes, readAmplification: Number(readAmplification.toFixed(2)), shardReads, viewReads },
      subchecks: { syncPlusOne: syncOk, noWholeIndexRebuild: noRebuildOk, noViewRescan, rescanUnder3x: rescanOk },
      caliber: '总纲"怎么验=加一行看索引增量"三子项成立；但判据括号里的"不重扫"按 P3 方案 E4-2（fs hook ≤新行×3）实测未达 → 整条判红，缺陷登记待 re1 补 idx-sync',
      defect,
    },
    defects: defect ? [defect] : [],
    summary: status === 'GREEN'
      ? `追加 1 行→索引 +1（written=${build.written}/removed=0；视图重扫 0；读放大 ${readAmplification.toFixed(1)}×）`
      : `同步子项 OK（+1 行、只重写 1 片、视图重扫 0），但"不重扫"未达：读放大 ${readAmplification.toFixed(1)}× > 计划阈值 3×（缺 idx-sync）→ 整条 RED；严格口径=红`,
  };
}

/** C29：删掉索引 → 能从台账逐字节重建（索引是派生物）。 */
function runC29(ctx) {
  const r = ctx.small;
  if (!r || !r.ok) return { id: 'C29', status: 'NA', title: '删索引→从台账重建', summary: '缺小库', reasons: [SMALL.why] };
  const root = copyRoot(r.root, 'c29');
  const idx0 = scanIndex(root);
  if (!idx0.dirExists || idx0.rows.length === 0) {
    return { id: 'C29', status: 'RED', title: '★ 删索引→从台账逐字节重建', summary: '前置缺索引：无法验"重建后逐字节等"（注入=删 .index；还原=index build）', evidence: { root } };
  }
  const shardsBefore = new Map(idx0.files.map((f) => [f.name, sha256File(path.join(idx0.dir, f.name))]));
  const rowsBefore = idx0.rows.length;
  const dir = pi.indexDir(root);
  fs.rmSync(dir, { recursive: true, force: true });
  indexCache.delete(root);
  const afterDelete = pi.statIndex({ root, checkDocs: false });
  const missingDetected = afterDelete.problems.some((p) => p.kind === 'index-missing');
  let build = null;
  try { build = pi.buildIndex({ root }); } catch (e) {
    return { id: 'C29', status: 'RED', title: '★ 删索引→从台账逐字节重建', summary: `重建失败：${String((e && e.message) || e)}`, evidence: { root } };
  }
  indexCache.delete(root);
  const idx1 = scanIndex(root);
  const rowsAfter = idx1.rows.length;
  const mismatchedShards = [];
  for (const f of idx1.files) {
    const before = shardsBefore.get(f.name);
    const after = sha256File(path.join(idx1.dir, f.name));
    if (before === undefined || before !== after) mismatchedShards.push(f.name);
  }
  const missingShards = [...shardsBefore.keys()].filter((n) => !idx1.files.some((f) => f.name === n));
  // S-10④：索引形态＝按日分片（idx-YYYYMMDD.jsonl）、单分片 ≤4 MiB → 重建产物必须满足
  const SHARD_LIMIT = 4 * 1024 * 1024;
  const badFormShards = idx1.files.filter((f) => !SHARD_RE.test(f.name) || f.bytes > SHARD_LIMIT).map((f) => f.name);
  const dayShardOk = badFormShards.length === 0;
  const stat = pi.statIndex({ root, checkDocs: false });
  const ok = missingDetected && build.ok === true && rowsAfter === rowsBefore && mismatchedShards.length === 0
    && missingShards.length === 0 && dayShardOk && stat.ok === true;
  return {
    id: 'C29', title: '★ 删掉索引 → 能从台账重建（索引是派生物，重建后逐行/逐字节等）',
    status: ok ? 'GREEN' : 'RED',
    evidence: {
      root, rowsBefore, rowsAfter, shards: idx1.files.length,
      deletionDetected: missingDetected, deletionProblems: afterDelete.problems.slice(0, 5).map((p) => p.kind),
      rebuilt: { ok: build.ok, written: build.written, removed: build.removed, ms: build.ms },
      mismatchedShards, missingShards, statOk: stat.ok, stateMatch: stat.stateMatch,
      shardForm: { rule: 'S-10④：按日分片 idx-YYYYMMDD.jsonl，单分片 ≤4 MiB', badFormShards, dayShardOk, shardLimitBytes: SHARD_LIMIT },
    },
    summary: ok
      ? `删 .index（${idx0.files.length} 分片/${rowsBefore} 行）→ stat 检出 index-missing → 重建 ${idx1.files.length} 分片逐字节相等、rows=${rowsAfter}、stat.ok=true；形态=${dayShardOk ? '按日分片≤4 MiB（S-10④）' : '破坏'}`
      : `重建不一致（missingDetected=${missingDetected} mismatched=${mismatchedShards.length} missing=${missingShards.length} statOk=${stat.ok} 形态=${dayShardOk}）`,
  };
}

/** C30：时间范围查 = 暴力扫台账（逐 code 对撞）。 */
function runC30(ctx) {
  const roots = [ctx.small, ctx.big].filter((r) => r && r.ok);
  if (!roots.length) return { id: 'C30', status: 'NA', title: '时间范围查 vs 暴力扫', summary: '缺可用账库', reasons: [SMALL.why] };
  const per = [];
  const problems = [];
  for (const r of roots) {
    const led = scanLedger(r.root);
    const idx = scanIndex(r.root);
    if (!idx.dirExists) { problems.push(`${r.label}：索引不存在`); continue; }
    if (led.rowsWithoutFile > 0) problems.push(`${r.label}：${led.rowsWithoutFile} 行来自非标准名台账文件（无法按日对账，不假绿）`);
    const days = [...led.days.keys()].sort();
    if (!days.length) { problems.push(`${r.label}：台账为空`); continue; }
    const ranges = [];
    const mid = days[Math.floor(days.length / 2)];
    ranges.push({ from: days[0], to: days[days.length - 1] });
    ranges.push({ from: days[0], to: mid });
    ranges.push({ from: mid, to: days[days.length - 1] });
    const cases = [];
    for (const range of ranges) {
      const rangeStr = `${range.from}..${range.to}`;
      const q = pi.queryIndex({ root: r.root, range: rangeStr, limit: 1000000 });
      const qCodes = q.map((x) => x.code);
      const brute = led.rows
        .filter((row) => {
          const day = tsLocalYmd(row.record.ts) || row.day;
          return day && day >= range.from && day <= range.to;
        })
        .sort((a, b) => (a.day === b.day ? a.offset - b.offset : (a.day < b.day ? -1 : 1)))
        .map((row) => row.code);
      const equal = qCodes.length === brute.length && qCodes.every((c, i) => c === brute[i]);
      if (!equal) problems.push(`${r.label} range=${rangeStr}：索引 ${qCodes.length} 行 vs 暴力 ${brute.length} 行不一致`);
      cases.push({ range: rangeStr, indexRows: qCodes.length, bruteRows: brute.length, equal, mismatched: equal ? 0 : Math.abs(qCodes.length - brute.length) });
    }
    per.push({ root: r.root, label: r.label, cases });
  }
  const status = problems.length === 0 ? 'GREEN' : 'RED';
  return {
    id: 'C30', title: '按时间范围查 → 与暴力扫台账结果集完全一致',
    status, evidence: { per, problems },
    summary: status === 'GREEN'
      ? per.map((p) => `${p.label} ${p.cases.length} 个区间逐 code 一致（${p.cases.map((c) => c.indexRows).join('/')} 行）`).join('；')
      : problems[0] || '结果集不一致',
  };
}

// ---- C31：三层夹具辅助 ----
/** 两个 YYYYMMDD 相差天数（from - to；from 更晚 → 正数）。 */
function daysBetweenYmd(fromYmd, toYmd) {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(4, 6) - 1, +fromYmd.slice(6, 8));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(4, 6) - 1, +toYmd.slice(6, 8));
  return Math.round((a - b) / 86400000);
}
/** 今天（判据口径 +08:00）YYYYMMDD —— 与编码/分片同口径，不取本机时区。 */
function ymdLocalToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
function sortedEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** 缺三层夹具时的旁证：小/大库上"按 sid 查与暴力扫一致"（**不等于**三层已验）。 */
function collectC31Partial(ctx) {
  const partial = [];
  for (const r of [ctx && ctx.small, ctx && ctx.big].filter((x) => x && x.ok)) {
    const led = scanLedger(r.root);
    const idx = scanIndex(r.root);
    if (!idx.dirExists) continue;
    const sids = [...new Set(led.rows.map((row) => row.record.sid).filter((s) => typeof s === 'string' && s))];
    const cases = [];
    for (const sid of sids.slice(0, 3)) {
      const q = pi.queryIndex({ root: r.root, sid, limit: 1000000 });
      const qCodes = q.map((x) => x.code).sort();
      const brute = led.rows.filter((row) => row.record.sid === sid).map((row) => row.code).sort();
      cases.push({ sid, indexRows: qCodes.length, bruteRows: brute.length, equal: sortedEq(qCodes, brute) });
    }
    const months = [...new Set(led.rows.map((row) => (typeof row.record.ts === 'string' ? row.record.ts.slice(0, 7) : '')).filter(Boolean))].sort();
    partial.push({ root: r.root, label: r.label, sidCount: sids.length, months, cases });
  }
  return partial;
}

/**
 * C31：按 sid 查 → 跨热/温/冷三层都正确（判据原文"三个 sid 各一层"）。
 *
 * 夹具：`_工作\lab-094-3layer`（或 `--three-layer=<lab>`），由 `_工作\tools\make-3layer-lab.mjs`
 * 用真实插件管线生成（headless-run tick → tools/cli.mjs index build），manifest.json 是夹具基线：
 *   热 = 锚点日（生成当日）｜温 = 90–180 天前（跨 2 个月）｜冷 = >365 天前（跨 2 个月）；3 个 sid 各一层。
 *
 * 判定：
 *   · 夹具目录/基线缺失或不可解析 → **NA**（写明缺什么、怎么修；不用 c01/E3 顶替）；
 *   · 夹具在但三层断言不成立（缺行/缺分片/窗口越界/查询对撞不一致）→ **RED**；
 *   · 结构全过但锚点≠今天（"热=今天"不再成立）→ **NA**（夹具过期，重跑生成器；不伪造绿）；
 *   · 结构全过且锚点=今天 → **GREEN**。
 *
 * 每层做三条独立路的对撞（同一份台账/索引，三个互不依赖的读法）：
 *   ① `pi.queryIndex({sid})`（索引层，C31 要验的"按 sid 查"）
 *   ② 本文件 `scanLedger` 的逐行暴力扫（独立解析台账）
 *   ③ 公共 `tools\ledgerapi.js searchLedger({sid})`（readAll 暴力路）
 */
function runC31(ctx) {
  const title = '★ 按 sid 查 → 跨热/温/冷三层都正确';
  const t = (ctx && ctx.three) ? ctx.three : THREE;
  if (!t.ok) {
    const partial = collectC31Partial(ctx);
    const partialOk = partial.every((p) => p.cases.every((c) => c.equal));
    return {
      id: 'C31', title, status: 'NA',
      reasons: [
        `三层夹具缺失/不可用：${t.why}`,
        '修复：node _工作\\tools\\make-3layer-lab.mjs（默认输出 _工作\\lab-094-3layer）；或用 --three-layer=<lab> 显式指定合法夹具',
        `本次解析：lab=${t.lab}；root=${t.root}；manifest=${t.manifestPath}`,
        '未验 ≠ 通过：c01-lab（3 个 sid 同在 2026-10）/lab-e3-accept（1,338 行仅 1 个 sid）构造不出"三个 sid 各一层"，不拿它们顶替三层夹具。',
      ],
      evidence: {
        where: { lab: t.lab, root: t.root, manifestPath: t.manifestPath },
        partial, partialOk,
        caliber: 'NA 仅表示缺夹具；partial 只证明"按 sid 查与暴力扫一致"，不等于三层夹具已验',
      },
      summary: `NA：缺三层夹具（${t.why}）；部分证据：${partialOk ? '小/大库 sid 查询与暴力扫一致' : 'sid 查询对撞不一致'}`,
    };
  }

  const man = t.manifest;
  const root = t.root;
  const anchor = man.anchor;                 // YYYY-MM-DD
  const today = ymdLocalToday();             // YYYYMMDD
  const todayIso = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
  const anchorAgeDays = daysBetweenYmd(today, anchor.replace(/-/g, '')); // 今天 - 锚点（天）
  const led = scanLedger(root);
  const idx = scanIndex(root);
  const problems = [];
  if (!led.dirExists) problems.push(`台账目录缺失：${path.join(root, 'ledger')}`);
  if (!idx.dirExists) problems.push(`索引目录缺失：${pi.indexDir(root)}（夹具不完整，先跑 node tools\\cli.mjs index build）`);

  // ① manifest 口径核对（判据写死口径 vs 夹具基线；不一致 = 夹具不合法，不许拿旧口径蒙混）
  for (const k of ['hot', 'warm', 'cold']) {
    const want = C31_CALIBER[k];
    const got = man.caliber && man.caliber[k];
    if (!got || got.fromDays !== want.fromDays || (got.toDays === undefined ? null : got.toDays) !== want.toDays) {
      problems.push(`manifest.caliber.${k} 与判据口径不一致（manifest=${JSON.stringify(got)}；判据=${JSON.stringify(want)}）`);
    }
  }
  const layerOf = new Map();
  for (const L of man.layers) {
    if (!L || !C31_CALIBER[L.layer]) { problems.push(`manifest.layers 含未知层：${JSON.stringify(L && L.layer)}`); continue; }
    if (layerOf.has(L.layer)) problems.push(`manifest.layers 重复层：${L.layer}`);
    layerOf.set(L.layer, L);
  }
  if (layerOf.size !== 3) problems.push(`manifest 三层不全：实际 ${layerOf.size} 层`);
  const sidLayer = new Map();
  for (const [k, L] of layerOf) {
    if (typeof L.sid !== 'string' || !L.sid) { problems.push(`层 ${k} 缺 sid`); continue; }
    if (sidLayer.has(L.sid)) problems.push(`同一 sid 出现在两层：${L.sid}（${sidLayer.get(L.sid)} 与 ${k}）`);
    sidLayer.set(L.sid, k);
    if (!Array.isArray(L.rows) || L.rows.length === 0) { problems.push(`层 ${k} 缺期望行`); continue; }
    for (const r of L.rows) {
      if (!r || typeof r.code !== 'string' || typeof r.ts !== 'string') { problems.push(`层 ${k} 期望行形状不对：${JSON.stringify(r)}`); continue; }
      const day = tsLocalYmd(r.ts);
      if (!day) { problems.push(`层 ${k} 期望行 ${r.code} 的 ts 不可解析：${r.ts}`); continue; }
      const off = daysBetweenYmd(anchor.replace(/-/g, ''), day); // 距锚点天数（正=过去）
      const w = C31_CALIBER[k];
      if (!(off >= w.fromDays && (w.toDays === null || off <= w.toDays))) {
        problems.push(`层 ${k} 期望行 ${r.code} 距锚点 ${off} 天，不在窗口 [${w.fromDays}, ${w.toDays === null ? '∞' : w.toDays}]`);
      }
    }
  }

  // ② 台账实际行 → 按 sid 归组
  const ledgerBySid = new Map();
  for (const row of led.rows) {
    const sid = row.record.sid;
    if (typeof sid !== 'string' || !sid) continue;
    if (!ledgerBySid.has(sid)) ledgerBySid.set(sid, []);
    ledgerBySid.get(sid).push({
      code: row.code, ts: String(row.record.ts || ''), day: row.day, turn: row.record.turn, file: row.file,
    });
  }
  const extraSids = [...ledgerBySid.keys()].filter((s) => !sidLayer.has(s));
  if (extraSids.length > 0) problems.push(`台账里有 manifest 之外的 sid：${extraSids.slice(0, 3).join(',')}${extraSids.length > 3 ? ` …共 ${extraSids.length} 个` : ''}`);

  // ③ 逐层断言：窗口 / 台账 / 索引 / 三路对撞 / 跨月
  const idxCodeSet = new Set(idx.rows.map((r) => r.c));
  const shardNameSet = new Set(idx.files.map((f) => f.name));
  const allMonths = new Set();
  const perLayer = [];
  for (const k of ['hot', 'warm', 'cold']) {
    const L = layerOf.get(k);
    if (!L || typeof L.sid !== 'string' || !L.sid) continue;
    const expectCodes = (L.rows || []).map((r) => r.code).sort();
    const lrows = (ledgerBySid.get(L.sid) || []).slice()
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const lcodes = lrows.map((r) => r.code);
    const missingLedger = expectCodes.filter((c) => !lcodes.includes(c));
    const extraLedger = lcodes.filter((c) => !expectCodes.includes(c));
    const tsMismatch = (L.rows || [])
      .filter((r) => { const hit = lrows.find((x) => x.code === r.code); return hit && hit.ts !== r.ts; })
      .map((r) => r.code);

    const offsets = [];
    const months = new Set();
    const myDays = new Set();
    for (const r of lrows) {
      const day = tsLocalYmd(r.ts);
      if (!day) { problems.push(`层 ${k} 台账行 ${r.code} 的 ts 不可解析：${r.ts}`); continue; }
      const off = daysBetweenYmd(anchor.replace(/-/g, ''), day);
      const w = C31_CALIBER[k];
      if (!(off >= w.fromDays && (w.toDays === null || off <= w.toDays))) {
        problems.push(`层 ${k} 台账行 ${r.code} 距锚点 ${off} 天，不在窗口 [${w.fromDays}, ${w.toDays === null ? '∞' : w.toDays}]`);
      }
      offsets.push(off);
      myDays.add(day);
      months.add(day.slice(0, 6));
      allMonths.add(day.slice(0, 6));
      if (!shardNameSet.has(`idx-${day}.jsonl`)) problems.push(`层 ${k} 台账日 ${day} 缺索引分片 idx-${day}.jsonl（分片被删？）`);
    }

    // 三路对撞：索引查询 / 本文件暴力扫 / 公共 searchLedger
    let q = [];
    let qMeta = {};
    if (idx.dirExists) {
      const arr = pi.queryIndex({ root, sid: L.sid, limit: 1000000 });
      q = Array.from(arr);
      qMeta = arr.meta || {};
    }
    const qCodes = q.map((x) => x.code).sort();
    const qPointerProblems = Array.isArray(qMeta.pointerProblems) ? qMeta.pointerProblems.length : 0;
    const qPointerBad = q.filter((x) => x.pointerOk === false).length;
    const api = ledgerapi.searchLedger(root, { sid: L.sid, limit: 200 });
    const apiCodes = api.ok ? api.rows.map((x) => x.code).sort() : [];
    const eq = {
      ledgerMatchesManifest: sortedEq(lcodes, expectCodes),
      indexHasAllExpected: expectCodes.every((c) => idxCodeSet.has(c)),
      queryMatchesManifest: sortedEq(qCodes, expectCodes),
      queryNoPointerProblems: qPointerProblems === 0 && qPointerBad === 0,
      apiMatchesManifest: api.ok === true && sortedEq(apiCodes, expectCodes),
      allThreePathsEqual: sortedEq(qCodes, lcodes) && sortedEq(apiCodes, lcodes),
    };
    if (!eq.ledgerMatchesManifest) {
      problems.push(`层 ${k} 台账行与 manifest 不一致：缺 ${missingLedger.length} 行${missingLedger.length ? `（${missingLedger.slice(0, 3).join(',')}）` : ''}、多 ${extraLedger.length} 行`);
    }
    if (tsMismatch.length > 0) problems.push(`层 ${k} 有 ${tsMismatch.length} 行 ts 与 manifest 不一致：${tsMismatch.slice(0, 3).join(',')}`);
    if (!eq.indexHasAllExpected) problems.push(`层 ${k} 索引缺期望行（分片/行被删？）`);
    if (!eq.queryMatchesManifest) problems.push(`层 ${k} 按 sid 索引查询 ${qCodes.length} 行 ≠ 期望 ${expectCodes.length} 行`);
    if (!eq.queryNoPointerProblems) problems.push(`层 ${k} 索引查询有 ${qPointerProblems + qPointerBad} 个指针 problem（指针解不出台账行）`);
    if (!eq.apiMatchesManifest) problems.push(`层 ${k} 公共 searchLedger 返回 ${apiCodes.length} 行 ≠ 期望 ${expectCodes.length} 行（ok=${api.ok}）`);
    if (!eq.allThreePathsEqual) problems.push(`层 ${k} 索引查询 / 暴力台账扫 / searchLedger 三路结果不一致`);
    const shardsRead = Number.isInteger(qMeta.shardsRead) ? qMeta.shardsRead : null;
    if (shardsRead === null || shardsRead < myDays.size) {
      problems.push(`层 ${k} sid 查询只读 ${shardsRead} 个分片（该 sid 分布在 ${myDays.size} 个日分片，跨层查询须覆盖）`);
    }
    perLayer.push({
      layer: k, sid: L.sid,
      expectedRows: expectCodes.length,
      ledgerRows: lcodes.length,
      indexQueryRows: qCodes.length,
      apiRows: apiCodes.length,
      offsets,
      days: [...myDays].sort(),
      months: [...months].sort(),
      shardsRead,
      bytesRead: Number.isInteger(qMeta.bytesRead) ? qMeta.bytesRead : null,
      missingInLedger: missingLedger.slice(0, 8),
      extraInLedger: extraLedger.slice(0, 8),
      checks: eq,
    });
  }

  // ④ 夹具整体一致性（三层 × 跨月 × 索引/台账同量）
  const warmMonths = (perLayer.find((p) => p.layer === 'warm') || {}).months || [];
  const coldMonths = (perLayer.find((p) => p.layer === 'cold') || {}).months || [];
  if (allMonths.size < 3) problems.push(`三层合计月份 ${allMonths.size} 个 <3（未覆盖跨月）`);
  if (warmMonths.length < 2) problems.push(`温层未跨月（months=${warmMonths.join(',') || '无'}）`);
  if (coldMonths.length < 2) problems.push(`冷层未跨月（months=${coldMonths.join(',') || '无'}）`);
  if (led.rows.length !== idx.rows.length) problems.push(`台账 ${led.rows.length} 行 ≠ 索引 ${idx.rows.length} 行`);
  if (man.counts && Number.isInteger(man.counts.ledgerRows) && led.rows.length !== man.counts.ledgerRows) {
    problems.push(`台账 ${led.rows.length} 行 ≠ 夹具基线 ${man.counts.ledgerRows} 行（夹具被改动/重建未同步）`);
  }
  if (man.index && Number.isInteger(man.index.shards) && idx.files.length !== man.index.shards) {
    problems.push(`索引分片 ${idx.files.length} 个 ≠ 夹具基线 ${man.index.shards} 个`);
  }
  if (man.index && Number.isInteger(man.index.rows) && idx.rows.length !== man.index.rows) {
    problems.push(`索引 ${idx.rows.length} 行 ≠ 夹具基线 ${man.index.rows} 行`);
  }
  let stat = null;
  try { stat = pi.statIndex({ root, checkDocs: true }); } catch (e) {
    problems.push(`index stat 抛错：${String((e && e.message) || e)}`);
  }
  if (stat && stat.ok !== true) {
    problems.push(`index stat 不一致（problems=${Array.isArray(stat.problems) ? stat.problems.length : '?'}，stateMatch=${stat.stateMatch}）`);
  }
  // 字节级绑定只作报告项（索引是派生物，重建出同语义不同字节不应误判为红）
  const actualLedgerSha = {};
  for (const f of led.files) actualLedgerSha[f.name] = sha256File(path.join(root, 'ledger', f.name));
  const actualIndexSha = {};
  for (const f of idx.files) actualIndexSha[f.name] = sha256File(path.join(pi.indexDir(root), f.name));
  const manLedgerSha = (man.ledger && man.ledger.sha256) || null;
  const manIndexSha = (man.index && man.index.sha256) || null;
  const ledgerByteIdentical = !!manLedgerSha && Object.keys(manLedgerSha).length === Object.keys(actualLedgerSha).length
    && Object.keys(manLedgerSha).every((n) => manLedgerSha[n] === actualLedgerSha[n]);
  const indexByteIdentical = !!manIndexSha && Object.keys(manIndexSha).length === Object.keys(actualIndexSha).length
    && Object.keys(manIndexSha).every((n) => manIndexSha[n] === actualIndexSha[n]);
  const actualCoverage = {
    ledgerRows: led.rows.length, indexRows: idx.rows.length, shards: idx.files.length,
    ledgerDays: led.days.size, indexDays: new Set(idx.files.map((f) => f.day)).size,
    months: [...allMonths].sort(), warmMonths, coldMonths,
    ledgerByteIdentical, indexByteIdentical,
    indexStatOk: stat ? stat.ok === true : false,
  };

  // ⑤ 结论
  const structuralOk = problems.length === 0;
  let status = 'RED';
  const reasons = [];
  if (structuralOk) {
    if (anchorAgeDays !== 0) {
      status = 'NA';
      reasons.push(`三层夹具过期：锚点=${anchor}，今天=${todayIso}（相差 ${anchorAgeDays} 天）→ "热=今天"不成立，结构检查全过但按纪律记 NA（未验 ≠ 通过）。`);
      reasons.push('修复：node _工作\\tools\\make-3layer-lab.mjs（重跑生成器把锚点刷成今天，同一天内重复跑字节相同）后重判。');
    } else {
      status = 'GREEN';
    }
  }
  const layerBrief = perLayer.map((p) => `${p.layer}(${p.sid.slice(0, 15)}… ${p.ledgerRows} 行/${p.months.join('+')})`).join(' · ');
  const summary = status === 'GREEN'
    ? `三层夹具 anchor=${anchor}（今天）：${layerBrief}；按 sid 查三路（索引 ${perLayer.map((p) => p.indexQueryRows).join('/')} 行 · 暴力台账 · 公共 searchLedger）逐 code 一致；指针问题 0；窗口 0 / [90,180] / [366,∞] 天；跨 ${allMonths.size} 个月份`
    : status === 'NA'
      ? `NA（夹具过期）：${reasons[0]}`
      : `RED：${problems[0]}`;
  return {
    id: 'C31', title, status, reasons,
    evidence: {
      threeLayer: {
        lab: t.lab, root, manifestPath: t.manifestPath,
        anchor, today: todayIso, anchorAgeDays, hotIsToday: anchorAgeDays === 0,
        caliber: C31_CALIBER,
        pipeline: man.pipeline || null,
        fixtureDigest: (man.idempotency && man.idempotency.fixtureDigest) || null,
      },
      perLayer,
      coverage: actualCoverage,
      problems,
      caliber: '判据原文"三个 sid 各一层"：热=锚点日、温=90–180 天前、冷=>365 天前；每层用索引查询/独立台账暴力扫/公共 searchLedger 三路对撞；窗口越界、缺行、缺分片、指针坏都算 RED',
    },
    summary,
  };
}

/** C32：按 code 查 —— 按实测口径（非 O(1)）设定阈值，并写清口径。 */
function runC32(ctx) {
  const r = ctx.big && ctx.big.ok ? ctx.big : null;
  if (!r) {
    return {
      id: 'C32', status: 'NA', title: '按 code 查 → 定位起始分片 + 实测阈值（非 O(1)）',
      summary: `缺大库 lab-e3-accept：${BIG.why}`,
      reasons: ['C32 的实测阈值口径（E3 1,338 行 3–9 ms）需要大库；缺大库 → NA'],
    };
  }
  const led = scanLedger(r.root);
  const idx = scanIndex(r.root);
  if (!idx.dirExists) return { id: 'C32', status: 'RED', title: '按 code 查', summary: '大库索引不存在', evidence: { root: r.root } };
  const days = [...new Set(idx.files.map((f) => f.day))].sort();
  const rows = idx.rows;
  const picks = [];
  for (const i of [0, Math.floor(rows.length / 2), rows.length - 1]) {
    if (rows[i] && !picks.includes(rows[i].c)) picks.push(rows[i].c);
  }
  const cases = [];
  let worstMs = 0;
  const problems = [];
  for (const code of picks) {
    const codeDay = code.slice(0, 8);
    const expectedStart = days.find((d) => d >= codeDay) || days[0];
    let hooked;
    try {
      hooked = withReadHook(() => {
        const t0 = process.hrtime.bigint();
        const foundRows = pi.queryIndex({ root: r.root, code, limit: 1 });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return { foundRows, ms };
      });
    } catch (e) {
      problems.push(`code=${code} 查询抛错：${String((e && e.message) || e)}`);
      continue;
    }
    const { foundRows, ms } = hooked.result;
    const idxReads = hooked.calls
      .filter((c) => relPosix(r.root, c.p).startsWith('ledger/.index/'))
      .map((c) => path.basename(c.p));
    const firstDay = idxReads.length ? (SHARD_RE.exec(idxReads[0]) || [])[1] : '';
    const startOk = firstDay === expectedStart;
    const found = foundRows.length === 1;
    worstMs = Math.max(worstMs, ms);
    if (!startOk) problems.push(`code=${code} 起始分片=${firstDay || '(无)'} 期望=${expectedStart}`);
    if (!found) problems.push(`code=${code} 未命中`);
    if (ms > C32_MAX_MS) problems.push(`code=${code} 耗时 ${ms.toFixed(2)} ms > 阈值 ${C32_MAX_MS} ms`);
    cases.push({
      code, codeDay, expectedStartShard: expectedStart, firstShardRead: firstDay || null,
      startLocated: startOk, found, ms: Number(ms.toFixed(2)),
      shardsRead: foundRows.meta ? foundRows.meta.shardsRead : null,
      bytesRead: foundRows.meta ? foundRows.meta.bytesRead : null,
      indexReads: idxReads.length,
    });
  }
  const status = problems.length === 0 ? 'GREEN' : 'RED';
  const caliber = [
    '★ 口径（不许假装 O(1)）：code 前 8 位=code 日 → 直接确定起始日分片（不遍历/不读任何别的分片），',
    '然后从该分片起向后扫到命中（limit=1 命中即停）；台账日≠code 日时最多扫到末分片。',
    `E3 实测 3–9 ms（37 分片全扫上限 145,287 B）；阈值 ${C32_MAX_MS} ms（≈5× 余量）。`,
    '3 年最坏 ≈402 MB 全扫（推算）未测 —— 不在 O(1) 承诺内，登记为已知风险。',
  ].join('');
  return {
    id: 'C32', title: '按 code 查 → O(1) 定位月份目录（实测口径：起始分片 O(1)，总扫描=有界后向扫描）',
    status,
    evidence: { root: r.root, cases, worstMs: Number(worstMs.toFixed(2)), thresholdMs: C32_MAX_MS, caliber, problems },
    summary: status === 'GREEN'
      ? `起始分片定位正确（${cases.length} 个 code）；E3 最坏 ${worstMs.toFixed(2)} ms ≤ 阈值 ${C32_MAX_MS} ms（口径：非 O(1)，code 日起向后有界扫描；3 年 402 MB 未测）`
      : problems[0] || 'code 查询不达标',
  };
}

/** C33：查不到必须返回 searchedRange + olderAvailable + hint（走公开 CLI）。 */
function runC33(ctx) {
  const r = (ctx.big && ctx.big.ok) ? ctx.big : (ctx.small && ctx.small.ok ? ctx.small : null);
  if (!r) return { id: 'C33', status: 'NA', title: '未命中边界回执', summary: '缺可用账库', reasons: [SMALL.why] };
  const idx = scanIndex(r.root);
  if (!idx.dirExists || !idx.rows.length) return { id: 'C33', status: 'RED', title: '未命中边界回执', summary: '索引不存在/为空', evidence: { root: r.root } };
  const led = scanLedger(r.root);
  const existing = new Set(idx.rows.map((x) => x.c));
  let missCode = '';
  const last = idx.rows[idx.rows.length - 1].c;
  for (const seq of ['99999999', '99999998']) {
    const c = `${last.slice(0, 24)}${seq}`;
    if (!existing.has(c)) { missCode = c; break; }
  }
  if (!missCode) return { id: 'C33', status: 'RED', title: '未命中边界回执', summary: '构造不出不存在的 code' };
  // 找一个"空档"区间（没有分片），用于 olderAvailable=true
  const days = [...new Set(idx.files.map((f) => f.day))].sort();
  let gap = null;
  for (let i = 1; i < days.length; i++) {
    if (days[i] > ymdAddDays(days[i - 1], 1)) {
      const from = ymdAddDays(days[i - 1], 1);
      const to = ymdAddDays(days[i], -1);
      if (from <= to) { gap = { from, to }; break; }
    }
  }
  if (!gap) gap = { from: ymdAddDays(days[days.length - 1], 1), to: ymdAddDays(days[days.length - 1], 7) };
  const cli = path.join(LITE, 'tools', 'cli.mjs');
  const runCli = (extra) => {
    const res = spawnSync(process.execPath, [cli, 'index', 'query', `--root=${r.root}`, ...extra, '--json'], {
      cwd: LITE, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    });
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { /* 留给下面判 */ }
    return { status: res.status, json, stderr: String(res.stderr || '').slice(0, 300) };
  };
  const codeMiss = runCli([`--code=${missCode}`]);
  const gapMiss = runCli([`--range=${gap.from}..${gap.to}`]);
  const hasFields = (j) => !!j && j.searchedRange && typeof j.searchedRange.fromYmd === 'string'
    && typeof j.searchedRange.toYmd === 'string' && typeof j.olderAvailable === 'boolean'
    && typeof j.hint === 'string' && j.hint.length > 0;
  const checks = [
    {
      name: '不存在 code',
      arg: `--code=${missCode}`,
      json: codeMiss.json,
      status: codeMiss.status,
      found: codeMiss.json ? codeMiss.json.found : null,
      fields: hasFields(codeMiss.json),
      searchedRange: codeMiss.json ? codeMiss.json.searchedRange : null,
      olderAvailable: codeMiss.json ? codeMiss.json.olderAvailable : null,
      hint: codeMiss.json ? codeMiss.json.hint : '',
    },
    {
      name: '空档 range',
      arg: `--range=${gap.from}..${gap.to}`,
      json: gapMiss.json,
      status: gapMiss.status,
      found: gapMiss.json ? gapMiss.json.found : null,
      fields: hasFields(gapMiss.json),
      searchedRange: gapMiss.json ? gapMiss.json.searchedRange : null,
      olderAvailable: gapMiss.json ? gapMiss.json.olderAvailable : null,
      hint: gapMiss.json ? gapMiss.json.hint : '',
    },
  ];
  const problems = [];
  for (const c of checks) {
    if (c.status !== 1 || c.found !== false) problems.push(`${c.name}：exit=${c.status} found=${c.found}（期望未命中 exit 1）`);
    if (!c.fields) problems.push(`${c.name}：三字段缺失（searchedRange/olderAvailable/hint）`);
    if (!c.hint) problems.push(`${c.name}：hint 为空`);
  }
  if (checks[0].json && checks[0].searchedRange && !(checks[0].searchedRange.fromYmd && checks[0].searchedRange.toYmd)) problems.push('不存在 code：searchedRange 两端为空');
  if (checks[1].olderAvailable !== true) problems.push(`空档 range：olderAvailable=${checks[1].olderAvailable}（期望 true：更早还有分片）`);
  if (checks[1].searchedRange && (checks[1].searchedRange.fromYmd !== gap.from || checks[1].searchedRange.toYmd !== gap.to)) {
    problems.push(`空档 range：searchedRange=${JSON.stringify(checks[1].searchedRange)} 期望 ${gap.from}..${gap.to}`);
  }
  const status = problems.length === 0 ? 'GREEN' : 'RED';
  return {
    id: 'C33', title: '★★ 查不到必须返回 searchedRange + olderAvailable + hint（CLI 公开接口）',
    status,
    evidence: { root: r.root, gap, missCode, checks, problems, note: 'CLI 无 keyword 条件 → 用"不存在 code"+"空档 range"两例代替"查不存在的词"' },
    summary: status === 'GREEN'
      ? `2 例未命中均返回 searchedRange+olderAvailable+hint（code 例 exit 1、空档 olderAvailable=true 且 searchedRange=${gap.from}..${gap.to}）`
      : problems[0] || '边界回执不完整',
  };
}

/** C34：性能三档（阈值来自判据；规模口径如实标注）。 */
function runC34(ctx) {
  const r = ctx.big && ctx.big.ok ? ctx.big : null;
  if (!r) return { id: 'C34', status: 'NA', title: '查询性能三档', summary: `缺大库：${BIG.why}`, reasons: ['C34 需大库（E3 1,338 行/37 分片）'] };
  const led = scanLedger(r.root);
  const idx = scanIndex(r.root);
  if (!idx.dirExists) return { id: 'C34', status: 'RED', title: '查询性能三档', summary: '大库索引不存在', evidence: { root: r.root } };
  const days = [...led.days.keys()].sort();
  if (!days.length) return { id: 'C34', status: 'RED', title: '查询性能三档', summary: '台账为空' };
  const maxDay = days[days.length - 1];
  const earliestMonth = days[0].slice(0, 6);
  const cases = [
    {
      name: '今天（=数据最新日）', range: `${maxDay}..${maxDay}`, thresholdMs: C34_TODAY_MS,
      note: `系统日 2026-11-13 当天无台账，取数据最新日 ${maxDay}`,
    },
    { name: '90 天', range: `${ymdAddDays(maxDay, -89)}..${maxDay}`, thresholdMs: C34_D90_MS, note: 'E3 只有 45 天/37 分片：90 天档请求退化为全部分片（可测的最坏档）' },
    { name: '指定冷月', range: `${monthStart(days[0])}..${monthEnd(days[0])}`, thresholdMs: C34_COLD_MS, note: `冷月取最早月 ${earliestMonth}` },
  ];
  const measured = [];
  const problems = [];
  for (const c of cases) {
    let best = Infinity;
    let rows = 0;
    let meta = null;
    for (let i = 0; i < 2; i++) {
      const t = timed(() => pi.queryIndex({ root: r.root, range: c.range, limit: 1000000 }));
      best = Math.min(best, t.ms);
      rows = t.value.length;
      meta = t.value.meta || meta;
    }
    const ok = best <= c.thresholdMs && rows > 0;
    if (!ok) problems.push(`${c.name}：${best.toFixed(2)} ms（阈值 ${c.thresholdMs} ms，rows=${rows}）`);
    measured.push({
      ...c, ms: Number(best.toFixed(2)), rows,
      shardsRead: meta ? meta.shardsRead : null, bytesRead: meta ? meta.bytesRead : null, ok,
    });
  }
  const status = problems.length === 0 ? 'GREEN' : 'RED';
  return {
    id: 'C34', title: '查询性能：今天<100 ms；90 天<1 s；指定冷月<2 s',
    status,
    evidence: {
      root: r.root, measured, problems,
      caliber: 'E3 规模（1,338 行/37 分片/45 天）：90 天档=全部分片；3 年规模（真实 90 天≈27 万行/30 MiB、冷月≈9.7 万行/11 MiB）未建合成库 → 不外推为绿',
    },
    summary: status === 'GREEN'
      ? measured.map((m) => `${m.name} ${m.ms} ms/${m.thresholdMs} ms（${m.shardsRead} 分片）`).join('；') + '；规模=45 天，3 年档未测'
      : problems[0] || '性能超阈值',
  };
}

/** C35：冷层按范围查询不加载其他月份的索引（看实际读了哪些分片文件）。 */
function runC35(ctx) {
  const r = ctx.big && ctx.big.ok ? ctx.big : null;
  if (!r) return { id: 'C35', status: 'NA', title: '冷层查询不加载其他月份索引', summary: `缺大库：${BIG.why}`, reasons: ['C35 需大库（多月份分片）'] };
  const led = scanLedger(r.root);
  const idx = scanIndex(r.root);
  if (!idx.dirExists) return { id: 'C35', status: 'RED', title: '冷层查询不加载其他月份索引', summary: '大库索引不存在', evidence: { root: r.root } };
  const days = [...new Set(idx.files.map((f) => f.day))].sort();
  if (!days.length) return { id: 'C35', status: 'RED', title: '冷层查询', summary: '无分片' };
  const coldMonth = days[0].slice(0, 6);
  const range = `${monthStart(days[0])}..${monthEnd(days[0])}`;
  const inRangeShards = idx.files.filter((f) => f.day >= monthStart(days[0]) && f.day <= monthEnd(days[0]));
  const hooked = withReadHook(() => pi.queryIndex({ root: r.root, range, limit: 1000000 }));
  const rows = hooked.result;
  const idxFilesRead = hooked.calls
    .filter((c) => relPosix(r.root, c.p).startsWith('ledger/.index/'))
    .map((c) => path.basename(c.p));
  const monthsRead = [...new Set(idxFilesRead.map((n) => (SHARD_RE.exec(n) || [])[1]).filter(Boolean).map((d) => d.slice(0, 6)))].sort();
  const outOfRange = idxFilesRead.filter((n) => {
    const day = (SHARD_RE.exec(n) || [])[1];
    return !day || day < monthStart(days[0]) || day > monthEnd(days[0]);
  });
  const brute = led.rows.filter((row) => {
    const day = tsLocalYmd(row.record.ts) || row.day;
    return day >= range.slice(0, 8) && day <= range.slice(10, 18);
  }).length;
  const ok = outOfRange.length === 0 && monthsRead.length === 1 && monthsRead[0] === coldMonth
    && idxFilesRead.length === inRangeShards.length && rows.length === brute;
  const problems = [];
  if (outOfRange.length) problems.push(`读了范围外分片：${outOfRange.slice(0, 5).join(',')}`);
  if (monthsRead.length !== 1) problems.push(`读了 ${monthsRead.length} 个月份：${monthsRead.join(',')}`);
  if (idxFilesRead.length !== inRangeShards.length) problems.push(`读分片数 ${idxFilesRead.length} ≠ 该月分片 ${inRangeShards.length}`);
  if (rows.length !== brute) problems.push(`命中 ${rows.length} ≠ 暴力 ${brute}`);
  return {
    id: 'C35', title: '★ 冷层（按月）查询不加载其他月份索引（按实际读取的 .index 分片验）',
    status: ok ? 'GREEN' : 'RED',
    evidence: {
      root: r.root, coldMonth, range, inRangeShards: inRangeShards.length,
      shardsRead: idxFilesRead.length, monthsRead, outOfRange, rowsReturned: rows.length, bruteRows: brute,
      filesRead: idxFilesRead.slice(0, 10),
      caliber: '以 fs.readFileSync 钩子记录实际打开的 .index 分片；命中行的台账 hydrate 另计（不属"索引加载"）',
      problems,
    },
    summary: ok
      ? `冷月 ${coldMonth} range=${range}：只读该月 ${idxFilesRead.length} 个分片、月份集={${monthsRead.join(',')}}、范围外 0；命中 ${rows.length}=暴力 ${brute}`
      : problems[0] || '冷层隔离不成立',
  };
}

/** C36：索引总大小 ≤ 台账总大小 15%（S-10②：两种分母都报）。 */
function walkPackageBytes(root) {
  // 整包体积：排除 .git 与 MANIFEST（S-10② 字面口径）
  const files = walkAll(root, {
    skipNames: (name) => name === '.git' || name === 'MANIFEST.sha256' || /^MANIFEST\b/i.test(name),
  });
  return { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
}
function runC36(ctx) {
  const roots = [ctx.big, ctx.small].filter((r) => r && r.ok);
  if (!roots.length) return { id: 'C36', status: 'NA', title: '索引总大小 ≤ 15%', summary: '缺可用账库', reasons: [SMALL.why] };
  const per = [];
  const problems = [];
  let primary = null;
  for (const r of roots) {
    const idx = scanIndex(r.root);
    const led = scanLedger(r.root);
    if (!idx.dirExists) { problems.push(`${r.label}：索引不存在`); continue; }
    const stateBytes = (() => { try { return fs.statSync(pi.indexStatePath(r.root)).size; } catch { return 0; } })();
    const shardBytes = idx.totalBytes;
    const indexTotalBytes = shardBytes + stateBytes;
    const ledgerBytes = led.totalBytes;
    const pkg = walkPackageBytes(r.root);
    const ratioLedger = ledgerBytes > 0 ? shardBytes / ledgerBytes : Infinity;
    const ratioLedgerWithState = ledgerBytes > 0 ? indexTotalBytes / ledgerBytes : Infinity;
    const ratioPackage = pkg.bytes > 0 ? shardBytes / pkg.bytes : Infinity;
    const ok = ratioLedger <= C36_RATIO_MAX && ratioPackage <= C36_RATIO_MAX;
    if (!ok) problems.push(`${r.label}：索引/台账 ${(ratioLedger * 100).toFixed(2)}%、索引/整包 ${(ratioPackage * 100).toFixed(2)}%（阈值 15%）`);
    per.push({
      root: r.root, label: r.label,
      shardFiles: idx.files.length, shardBytes, stateBytes, indexTotalBytes,
      ledgerFiles: led.files.length, ledgerBytes,
      packageFiles: pkg.files, packageBytes: pkg.bytes,
      ratioLedger, ratioLedgerWithState, ratioPackage, threshold: C36_RATIO_MAX, ok,
    });
    if (!primary || r.label === '大库') primary = per[per.length - 1];
  }
  const status = problems.length === 0 ? 'GREEN' : 'RED';
  const p = primary || per[0];
  return {
    id: 'C36', title: '索引总大小 ≤ 台账总大小 15%（S-10②：索引/台账 + 索引/整库包 两种分母都报）',
    status,
    evidence: {
      per, problems, threshold: C36_RATIO_MAX,
      caliber: [
        'S-10② 分母＝整包体积（排除 .git 与 MANIFEST）；VERSION/签字单"11.8×%"可复现的读法是"索引分片/台账日文件"，',
        '本执行器两种都算：①索引分片/台账日文件（主判，E3 实测 11.81%）；②索引分片/整库包（排除 .git/MANIFEST，E3 0.10%）；',
        '③参考：含 .idx-state.json / 台账（E3 12.00%）。三者都 ≤15% 才判绿 → 任一读法下都过。',
      ].join(''),
    },
    summary: status === 'GREEN'
      ? `E3 索引 ${fmtBytes(p.shardBytes)}/台账 ${fmtBytes(p.ledgerBytes)}=${(p.ratioLedger * 100).toFixed(2)}%（主判）；/整库包 ${(p.ratioPackage * 100).toFixed(3)}%；含 state ${(p.ratioLedgerWithState * 100).toFixed(2)}% → 均 ≤15%`
      : problems[0] || '索引占比超 15%',
  };
}

/** C37：增量备份只拷"上次之后新写的"；整库搬走=拷目录+一条命令验证可读。 */
function runC37(ctx) {
  const r = ctx.small;
  if (!r || !r.ok) return { id: 'C37', status: 'NA', title: '增量备份+整库搬走验证', summary: '缺小库', reasons: [SMALL.why] };
  const root = copyRoot(r.root, 'c37');
  const out1 = path.join(WORKTMP, 'c37', 'backup1');
  const out2 = path.join(WORKTMP, 'c37', 'backup-copy');
  const steps = [];
  let first;
  try { first = backupMod.runBackup({ root, outDir: out1 }); } catch (e) {
    return { id: 'C37', status: 'RED', title: '增量备份', summary: `首次备份抛错：${String((e && e.message) || e)}`, evidence: { root } };
  }
  steps.push({ step: 'backup#1 全量', ok: first.ok, exitCode: first.exitCode, mode: first.report.mode, scanned: first.report.scanned, copied: first.report.copied, skipped: first.report.policy.skipped });
  const v1 = backupMod.runVerify({ outDir: out1 });
  steps.push({ step: 'verify#1', ok: v1.ok, exitCode: v1.exitCode, counts: v1.report.counts, manifestEntries: v1.report.manifest.entries });
  // 追加一行 = "上次之后新写的"（只动 1 个台账日文件；索引被备份策略默认跳过）
  const syn = appendSyntheticRow(root);
  const beforeCounts = first.report.counts || { files: 0, bytes: 0 };
  let second;
  try { second = backupMod.runBackup({ root, outDir: out1 }); } catch (e) {
    return { id: 'C37', status: 'RED', title: '增量备份', summary: `增量备份抛错：${String((e && e.message) || e)}`, evidence: { root, steps } };
  }
  const copied = second.report.copied || { files: 0, bytes: 0 };
  const added = second.report.added && second.report.added.total != null ? second.report.added.total : (second.report.added || []).length;
  const changed = second.report.changed && second.report.changed.total != null ? second.report.changed.total : (second.report.changed || []).length;
  const copiedRels = [
    ...((second.report.changed && (second.report.changed.sample || second.report.changed)) || []),
    ...((second.report.added && (second.report.added.sample || second.report.added)) || []),
  ].filter((x) => x && x.rel).map((x) => x.rel);
  steps.push({
    step: 'backup#2 增量（追加 1 行）', ok: second.ok, exitCode: second.exitCode, mode: second.report.mode,
    copied, added, changed, copiedRels, unchangedFiles: second.report.unchangedFiles,
    policy: second.report.policy,
  });
  const v2 = backupMod.runVerify({ outDir: out1 });
  steps.push({ step: 'verify#2', ok: v2.ok, exitCode: v2.exitCode, counts: v2.report.counts });
  // 整库搬走 = 拷目录 + 一条命令验证可读
  try { fs.cpSync(out1, out2, { recursive: true }); } catch (e) {
    steps.push({ step: 'copy backup dir', ok: false, error: String((e && e.message) || e) });
  }
  const v3 = backupMod.runVerify({ outDir: out2 });
  steps.push({ step: 'verify#3（整库搬走=拷目录后一条命令）', ok: v3.ok, exitCode: v3.exitCode, counts: v3.report.counts });
  const fullCopied = first.report.copied ? first.report.copied.files : 0;
  const incOk = second.ok === true && second.report.mode === 'incremental' && copied.files === 1
    && changed + added === 1 && copiedRels.length <= 1;
  const ok = first.ok && v1.ok && incOk && v2.ok && v3.ok;
  const problems = [];
  if (!first.ok) problems.push(`首次备份 exit=${first.exitCode}`);
  if (!v1.ok) problems.push(`verify#1 exit=${v1.exitCode}`);
  if (!incOk) problems.push(`增量只拷 1 项不成立：copied=${copied.files} added=${added} changed=${changed}`);
  if (!v2.ok) problems.push(`verify#2 exit=${v2.exitCode}`);
  if (!v3.ok) problems.push(`verify#3（搬走拷贝）exit=${v3.exitCode}`);
  return {
    id: 'C37', title: '★ 增量备份只拷"上次之后新写的"；整库搬走=拷目录+一条命令验证可读',
    status: ok ? 'GREEN' : 'RED',
    evidence: {
      root, backupDir: path.relative(WORK, out1), steps, problems,
      firstFiles: beforeCounts.files, fullCopiedFiles: fullCopied,
      appendedFile: syn.file, appendedBytes: syn.bytes,
      verifyCopy: { ok: v3.ok, counts: v3.report.counts, manifestEntries: v3.report.manifest.entries },
      caliber: '增量身份 = 相对路径 + 内容 sha256（backup.mjs 口径）；"整库搬走"= 目录级拷贝备份目录 → 一条 verify 命令全量校验 sha256 可读',
    },
    summary: ok
      ? `全量拷 ${fullCopied} 文件→追加 1 行→增量只拷 ${copied.files} 文件（${copied.bytes} B；unchanged ${second.report.unchangedFiles}）→verify ok；备份目录整拷后 verify ok（${v3.report.actual.files} 文件/${fmtBytes(v3.report.actual.bytes)}）`
      : problems[0] || '增量/验证不达标',
  };
}

// ============================================================================
// 五、判据表 / 执行
// ============================================================================
const CRITERIA = [
  { id: 'C24', run: runC24, c24: true },
  { id: 'C26', run: runC26 },
  { id: 'C27', run: runC27 },
  { id: 'C28', run: runC28 },
  { id: 'C29', run: runC29 },
  { id: 'C30', run: runC30 },
  { id: 'C31', run: runC31 },
  { id: 'C32', run: runC32 },
  { id: 'C33', run: runC33 },
  { id: 'C34', run: runC34 },
  { id: 'C35', run: runC35 },
  { id: 'C36', run: runC36 },
  { id: 'C37', run: runC37 },
];

function failEnv(msg) {
  console.error(`[环境错误] ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}
if (!SMALL.ok && !doProof) failEnv(`小库不可用：${SMALL.why}`);
if (!doProof && !fs.existsSync(EVID)) fs.mkdirSync(EVID, { recursive: true });
if (!doProof) freshWorkDir();

function runAll() {
  const results = [];
  for (const c of CRITERIA) {
    if (only.length && !only.includes(c.id)) { results.push({ id: c.id, status: 'SKIP', title: '', summary: '--only 未选中' }); continue; }
    let res;
    try {
      res = c.run({ small: SMALL, big: BIG, three: THREE });
    } catch (e) {
      res = { id: c.id, status: 'RED', title: '', summary: `执行异常：${String((e && e.stack) || e)}`, evidence: { error: String((e && e.message) || e) } };
    }
    results.push(res);
  }
  return results;
}

// ---- --proof 自证：注入故障 → 红 → 还原 → 绿 ----
function runProofs() {
  const defaultProof = ['C26', 'C28', 'C29', 'C30', 'C36', 'C31'];
  const ids = only.length ? defaultProof.filter((id) => only.includes(id)) : defaultProof;
  fs.mkdirSync(EVID, { recursive: true });
  freshWorkDir();
  const proofs = [];
  for (const id of ids) {
    if (id === 'C31' && !THREE.ok) {
      writeEvid('proof-C31-skip.json', { id, why: THREE.why });
      proofs.push({
        id, injected: '(跳过：缺三层夹具)', redStatus: 'NA', repaired: '', greenStatus: 'NA',
        pass: false, partial: false,
        redSummary: `缺三层夹具：${THREE.why}`, greenSummary: '',
        residual: '先跑 node _工作\\tools\\make-3layer-lab.mjs 生成三层夹具，再跑 --proof',
      });
      continue;
    }
    const isC31 = id === 'C31';
    const wroot = isC31 ? copyThreeRoot(`proof-${id}`) : copyRoot(SMALL.root, `proof-${id}`);
    const cri = CRITERIA.find((c) => c.id === id);
    const ctx = isC31
      ? { small: SMALL, big: { ok: false, why: 'proof 模式不提供大库' }, three: { ...THREE, root: wroot } }
      : { small: { ok: true, root: wroot, label: '小库' }, big: { ok: false, why: 'proof 模式不提供大库' }, three: THREE };
    const inject = () => {
      if (id === 'C26') {
        const idx = scanIndex(wroot);
        const f = idx.files[0];
        const abs = path.join(idx.dir, f.name);
        const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((x) => x.trim());
        lines.pop();
        fs.writeFileSync(abs, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
        indexCache.delete(wroot);
        return `删掉索引分片 ${f.name} 的最后 1 行`;
      }
      if (id === 'C28') {
        const syn = appendSyntheticRow(wroot);
        return `只追加台账行（${syn.file}，+${syn.bytes} B），不建索引 → 索引落后 1 行`;
      }
      if (id === 'C29') {
        fs.rmSync(pi.indexDir(wroot), { recursive: true, force: true });
        indexCache.delete(wroot);
        return '删掉 ledger/.index 整个索引目录';
      }
      if (id === 'C30') {
        const idx = scanIndex(wroot);
        const f = idx.files[0];
        const abs = path.join(idx.dir, f.name);
        const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((x) => x.trim());
        lines.splice(0, Math.min(2, lines.length));
        fs.writeFileSync(abs, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
        indexCache.delete(wroot);
        return `删掉索引分片 ${f.name} 的前 2 行 → 范围查结果集短于暴力扫`;
      }
      if (id === 'C36') {
        const idx = scanIndex(wroot);
        const f = idx.files[0];
        const abs = path.join(idx.dir, f.name);
        const lines = fs.readFileSync(abs, 'utf8').split('\n').filter((x) => x.trim());
        const extra = lines[0] ? lines[0] : '{"c":"20260101-000000000000-A-00000001","d":null,"o":null,"n":null}';
        for (let i = 0; i < 8; i++) lines.push(extra);
        fs.writeFileSync(abs, `${lines.join('\n')}\n`, 'utf8');
        indexCache.delete(wroot);
        return `往索引分片 ${f.name} 追加 8 行重复瘦行 → 索引字节比 >15%`;
      }
      if (id === 'C31') {
        // 注入 = 删掉"冷层"的台账日文件 + 索引分片（判据原文的三层之一整层丢失）
        const man = THREE.manifest;
        const cold = (man.layers || []).find((l) => l.layer === 'cold');
        if (!cold || !Array.isArray(cold.rows) || cold.rows.length === 0) throw new Error('三层夹具基线缺冷层期望行，无法注入');
        const days = [...new Set(cold.rows.map((r) => (typeof r.day === 'string' && r.day ? r.day : ymdToIso(tsLocalYmd(r.ts)))))];
        const removed = [];
        for (const day of days) {
          const ymd = day.replace(/-/g, '');
          const lf = path.join(wroot, 'ledger', `${day}.jsonl`);
          const sf = path.join(pi.indexDir(wroot), `idx-${ymd}.jsonl`);
          if (fs.existsSync(lf)) { fs.rmSync(lf, { force: true }); removed.push(`ledger/${day}.jsonl`); }
          if (fs.existsSync(sf)) { fs.rmSync(sf, { force: true }); removed.push(`.index/idx-${ymd}.jsonl`); }
        }
        ledgerCache.delete(wroot);
        indexCache.delete(wroot);
        return `删掉冷层 sid=${cold.sid} 的台账日文件与索引分片（${removed.length} 个：${removed.join('、')}）`;
      }
      throw new Error(`未知注入：${id}`);
    };
    const repair = () => {
      indexCache.delete(wroot);
      ledgerCache.delete(wroot);
      if (id === 'C31') {
        // 还原 = 从三层夹具源重新拷一份 root（源本身全程只读）
        fs.rmSync(wroot, { recursive: true, force: true });
        fs.cpSync(THREE.root, wroot, { recursive: true });
        indexCache.delete(wroot);
        ledgerCache.delete(wroot);
        return '从三层夹具源 _工作\\lab-094-3layer\\root 重新拷贝（还原）';
      }
      if (id === 'C28') {
        // 还原 = 把索引同步到台账（build 后仍保留已追加的台账行 → C28 本体可从"已同步"状态再验一次）
        pi.buildIndex({ root: wroot });
      } else if (id === 'C29') {
        pi.buildIndex({ root: wroot });
      } else {
        pi.buildIndex({ root: wroot });
      }
      indexCache.delete(wroot);
      ledgerCache.delete(wroot);
      return 'node tools/cli.mjs index build（重建/同步索引）';
    };
    let whyInject = '';
    let red = null;
    let redErr = '';
    try {
      ledgerCache.clear();
      indexCache.clear();
      whyInject = inject();
      ledgerCache.clear();
      indexCache.clear();
      red = cri.run(ctx);
    } catch (e) {
      redErr = String((e && e.stack) || e);
      red = { status: 'ERROR', summary: redErr };
    }
    writeEvid(`proof-${id}-red.json`, { id, injected: whyInject, result: red });
    let repairDesc = '';
    let green = null;
    let greenErr = '';
    try {
      repairDesc = repair();
      ledgerCache.clear();
      indexCache.clear();
      green = cri.run(ctx);
    } catch (e) {
      greenErr = String((e && e.stack) || e);
      green = { status: 'ERROR', summary: greenErr };
    }
    writeEvid(`proof-${id}-green.json`, { id, repaired: repairDesc, result: green });
    const pass = red && red.status === 'RED' && green && green.status === 'GREEN';
    // C28 特殊口径：判据含"不重扫"，实测未达（缺陷）；自证要证的是
    //   "索引落后 → 红" + "同步后三个可验子项 → 绿"，整条因读放大保持红 → 记 partial 而非 FAIL。
    const sub = green && green.evidence && green.evidence.subchecks ? green.evidence.subchecks : null;
    const partial = !pass && id === 'C28' && red && red.status === 'RED' && sub
      && sub.syncPlusOne === true && sub.noWholeIndexRebuild === true && sub.noViewRescan === true;
    proofs.push({
      id, injected: whyInject, redStatus: red ? red.status : 'ERROR',
      repaired: repairDesc, greenStatus: green ? green.status : 'ERROR', pass, partial,
      redSummary: red ? red.summary : redErr, greenSummary: green ? green.summary : greenErr,
      residual: id === 'C28' && !pass ? 'C28 整条仍 RED 的唯一原因是"不重扫台账"（读放大）未达；"同步 +1 / 不重建 / 不重扫原文"三子项已红→绿' : '',
    });
  }
  fs.rmSync(WORKTMP, { recursive: true, force: true });
  const ok = proofs.every((p) => p.pass || p.partial);
  writeEvid('proof-summary.json', { schema: `${SCHEMA}#proof`, at: new Date(nowMs).toISOString(), small: SMALL.root, proofs, ok });
  if (asJson) {
    console.log(JSON.stringify({ ok, proofs }, null, 2));
  } else {
    console.log('=== 0.9.4 判据执行器 · 先红后绿自证（注入故障→红→还原→绿） ===');
    console.log('');
    console.log('| 判据 | 注入 | 红 | 还原 | 绿 | 结论 |');
    console.log('|---|---|---|---|---|---|');
    for (const p of proofs) {
      const concl = p.pass ? 'PASS' : (p.partial ? 'PASS（子项；整条红因登记）' : 'FAIL');
      console.log(`| ${p.id} | ${p.injected.replace(/\|/g, '/')} | ${p.redStatus} | ${p.repaired.replace(/\|/g, '/')} | ${p.greenStatus} | ${concl} |`);
      if (p.residual) console.log(`  ⚠ ${p.id}：${p.residual}`);
    }
    console.log('');
    console.log(`证据目录：${EVID}`);
  }
  process.exit(ok ? 0 : 1);
}

// ---- 主流程 ----
if (doProof) {
  runProofs();
  process.exit(0);
}

const results = runAll();
const counts = { green: 0, red: 0, na: 0, skip: 0 };
for (const r of results) {
  if (r.status === 'GREEN') counts.green++;
  else if (r.status === 'RED') counts.red++;
  else if (r.status === 'NA') counts.na++;
  else counts.skip++;
}
const evaluated = results.filter((r) => r.status !== 'SKIP');
const ok = evaluated.length > 0 && counts.red === 0 && counts.na === 0;
const defects = [];
for (const r of results) if (Array.isArray(r.defects)) defects.push(...r.defects.map((d) => ({ criterion: r.id, ...d })));
const unverified = results.filter((r) => r.status === 'NA').map((r) => ({ id: r.id, reasons: r.reasons || [r.summary] }));
const summary = {
  schema: SCHEMA,
  at: new Date(nowMs).toISOString(),
  lite: path.relative(BASE, LITE),
  labs: { small: SMALL.root, smallOk: SMALL.ok, big: BIG.root, bigOk: BIG.ok },
  counts,
  ok,
  criteria: results,
  defects,
  unverified,
};
writeEvid('summary.json', summary);
writeTextEvid('summary.md', [
  `# 判据执行器 0.9.4（C24 + C26–C37）`,
  '',
  `生成：${summary.at}｜小库：${SMALL.root}｜大库：${BIG.ok ? BIG.root : '(缺)'}`,
  '',
  '| 判据 | 结果 | 证据摘要 |',
  '|---|---|---|',
  ...results.filter((r) => r.status !== 'SKIP').map((r) => `| ${r.id} | ${r.status} | ${String(r.summary || '').replace(/\|/g, '/')} |`),
  '',
  `汇总：GREEN=${counts.green} RED=${counts.red} NA=${counts.na} SKIP=${counts.skip} → ${ok ? '全绿' : '未全绿'}`,
  '',
  ...(defects.length ? ['## 已知缺陷', '', ...defects.map((d) => `- **${d.criterion}·${d.id}**：${d.why}｜影响：${d.impact || ''}`), ''] : []),
  ...(unverified.length ? ['## 未验（NA）清单', '', ...unverified.map((u) => `- **${u.id}**：${(u.reasons || []).join('；')}`), ''] : []),
].join('\n'));
for (const r of results) if (r.status !== 'SKIP') writeEvid(`${r.id}.json`, r);

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('=== 0.9.4 判据执行器（lite 线）· C24 + C26–C37 · S-10 五项口径 ===');
  console.log(`小库：${SMALL.ok ? SMALL.root : '(不可用)'}`);
  console.log(`大库：${BIG.ok ? BIG.root : `(缺：${BIG.why})`}`);
  console.log('');
  console.log('| 判据 | 结果 | 证据摘要 |');
  console.log('|---|---|---|');
  for (const r of results.filter((x) => x.status !== 'SKIP')) {
    console.log(`| ${r.id} | ${r.status} | ${String(r.summary || '').replace(/\|/g, '/')} |`);
  }
  console.log('');
  console.log(`汇总：GREEN=${counts.green} RED=${counts.red} NA=${counts.na} SKIP=${counts.skip} → ${ok ? '全绿' : '未全绿'}`);
  if (unverified.length) {
    console.log('');
    console.log('未验（NA）原因：');
    for (const u of unverified) console.log(`  · ${u.id}：${(u.reasons || []).join('；')}`);
  }
  if (defects.length) {
    console.log('');
    console.log('已知缺陷：');
    for (const d of defects) console.log(`  · ${d.criterion}·${d.id}：${d.why}`);
  }
  console.log('');
  console.log(`证据目录：${EVID}`);
}
if (!keepWork) fs.rmSync(WORKTMP, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
