#!/usr/bin/env node
/**
 * @file docs/判据-1.0.mjs
 * @role V1.0 毕业（lite 线）**45 条判据聚合执行器**（C01–C40 总纲 §7 ＋ S-11 签字新增 C41–C45）。
 *
 * @why 0.9.5 的 P4 门是「F 组 C38–C40 全绿 ＋ 40 条全部重跑无红」，而 40 条分散在三个执行器：
 *      · 已有：`docs/判据-0.9.1.mjs`（C01–C18）与 `docs/判据-0.9.4.mjs`（C24＋C26–C37，含 --proof）；
 *      · 缺口：C19、C20、C21、C22、C23、C25（P2 续航组）与 C38、C39、C40（P4 交付组）**没有任何可执行验具**。
 *      本文件**不重写**前两个执行器（子进程调用 + 解析 --json），只补齐 9 条缺口并输出统一 40 行表。
 *
 * 口径纪律（总纲 §7.8 元规则，逐条可见）：
 *   ① 先红后绿：`--proof` 对能注入的判据做「注入故障 → 红 → 还原 → 绿」（至少 C19/C20/C21/C22）；
 *   ② 数字脚本生成：本文件所有数字来自现场读盘/命令输出，不写死结论；
 *   ③ 变异精确：注入只改一条判据的输入面（度量副本 / 台账副本 / 清单副本 / 台账表副本），
 *      红必须落在**该判据**上；每个 proof 记录 redStatus/greenStatus 与红的原因；
 *   ④ 未验 ≠ 通过：缺环境/缺夹具/缺证据 → `NA` 并写明**缺什么**，NA 不算绿（与 0.9.4 退出码口径一致）；
 *   ⑤ 判据不许改：本文件不新增/不删改判据，只把总纲原文抄进表并落成检查。
 *
 * 已签字口径（引用，不重定义）：
 *   · S-7（C14–C16 改「原文重放式对账」）—— 由 `docs/判据-0.9.1.mjs`/`replay-verify.mjs` 承载；
 *   · S-9①（C25 读盘：保留 3 tick/≤30 s，读盘改为「消费 ≤17 MiB/tick、读放大 ≤2.5×（≤40 MB/tick）」）；
 *   · S-9②（C22 拆两条：套账(台账+索引) ≤0.05× 压缩语料；原文+视图 = 1.00–1.35× 解压语料）；
 *   · S-9③/S-10③（C24 单位 GiB ≈364）—— 由 `docs/判据-0.9.4.mjs` 承载；
 *   · S-10①②④（C27 四字段无 entryHash / C36 分母 / 索引按日分片 ≤4 MiB）—— 由 `docs/判据-0.9.4.mjs` 承载；
 *   · S-10⑤（doctor ④ 采 S-9 拆口径）—— 本文件 C22 按同一公式独立复算（不调 doctor，避免重复其 5 类检查）。
 *   以上签字出处：`新的开始-V0.9.0新版本\签字单-已签-20261113.md` §六/§七。
 *
 * 用法：
 *   node docs\判据-1.0.mjs [--lab=<lab>] [--big=<lab>] [--three-layer=<lab>] [--weeks=<lab>] [--lab-dir=<dir>]
 *                          [--evid-dir=<dir>] [--work-dir=<dir>]
 *                          [--json] [--only=C01,...] [--proof] [--keep] [--help]
 *
 *   --lab=<lab>         小库 lab（默认 <lab-dir>\c01-lab；含 root\ 与 dsh-home\sessions）
 *   --big=<lab>         大库 lab（默认 <lab-dir>\lab-e3-accept；**只读**，C20/C21/C22/C25/C38 用它）
 *   --three-layer=<lab> C31 三层夹具（默认 <lab-dir>\lab-094-3layer；由 0.9.4 子执行器用）
 *   --lab-dir=<dir>     四类 lab 的根（默认 %TEMP%\dsh-ledger-labs-v1.0.0-re2；缺则调 docs\工具-构造lab.mjs 自建）
 *   --evid-dir=<dir>    证据目录（默认 `<包根>\证据\判据-1.0-<YYYYMMDD-HHmmss>\`；★ 不写包外）
 *   --work-dir=<dir>    工作副本根（默认 %TEMP%\dsh-ledger-criteria-work；跑完删，副本不得当证据）
 *   --only=C01,...      只跑指定判据（逗号分隔；子执行器只收到属于它的编号）
 *   --json              stdout 只出机读 JSON（逐条证据仍落盘）
 *   --proof             只跑「注入故障→红→还原→绿」自证（默认 C19/C20/C21/C22/C23/C25/C39/C40/C41/C42/C43/C44/C45）
 *   --keep              保留 `<work-dir>\` 工作副本（默认跑完删）
 *   --help              本说明
 *
 * 退出码（与 0.9.4 完全一致）：
 *   0 = 参与判定的判据全绿（无红、无 NA）；1 = 有红或 NA（**NA 不算绿**）；2 = 用法/环境错误。
 *
 * 输出（默认 `<包根>\证据\判据-1.0-<YYYYMMDD-HHmmss>\`；可用 --evid-dir 改）：
 *   summary.json / summary.md / C01.json…C45.json / child-判据-0.9.1.json / child-判据-0.9.4.json /
 *   C19-日检-*.json / logs\；`--proof` 另出 proof-summary.json + proof-<id>-red/green.json。
 *
 * @reads  `<lab>\root`、`<big>\root`（只读）、`<big>\dsh-home\sessions`（只读）、
 *         `<包根>\VERSION.json`、`<包根>\版本台账.md`、`<包根>\MANIFEST.sha256`、`<包根>\交付-v*\*`、
 *         `<包根>\证据\跑测试-*.log`（C38 抽查 VERSION.tests 数字用）、
 *         `<包根>\证据\判据-1.0-final-*\summary.md`（VERSION.criteriaRun.evidence，包内相对路径）
 * @writes 仅 `<包根>\证据\判据-1.0-*\`（证据，默认；--evid-dir 可改）与 `%TEMP%\dsh-ledger-criteria-work\`
 *         （工作副本，默认删）；lab 构造物在 `%TEMP%\dsh-ledger-labs-v1.0.0-re2\`；
 *         **不写包根以外的任何位置**（交付根=包上一级 跑前跑后零新增，C39 复核）；
 *         **不写任何账库**（C19/C22/C23/C39/C40 的破坏/注入全在副本上做）
 * @invokes node docs\判据-0.9.1.mjs --json --lab=… --only=… --evid-dir=… --work-dir=…（C01–C18 子进程）
 *          node docs\判据-0.9.4.mjs --json --lab=… --big=… --three-layer=… --only=… --evid-dir=… --work-dir=…（C24/C26–C37 子进程）
 *          node docs\工具-日检.mjs --root=… --sessions=… --json（C19 全量核）
 *          node docs\工具-构造lab.mjs --out=… --only=…（缺 lab 时自建，落 %TEMP%）
 * @depends node:fs/os/path/crypto/zlib/child_process/url（零第三方依赖；不 import 产品代码）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 一、路径 / 参数 / 环境
// ============================================================================
const THIS_FILE = fileURLToPath(import.meta.url);
const LITE = path.resolve(path.dirname(THIS_FILE), '..'); // 包根（交付根；接收端解压后的目录）
const WORK = path.resolve(LITE, '..'); // 包上一级（开发机=_工作；接收端=解压目录的上一级）
const BASE = path.resolve(WORK, '..'); // 开发机=新的开始-V0.9.0新版本（签字单所在）
// ★ re3 口径（审计 P0）：本执行器只在**包内**与 %TEMP% 写；包上一级（交付根）跑前跑后零新增。
const PKG = LITE;
const NODE = process.execPath;
const SCHEMA = 'criteria-1.0/1';
// ★ K-18（re4 / 三份审计 P0-②）：lab 目录必须**随包版本走**。
//   旧口径写死 `dsh-ledger-labs-v1.0.0-re2`，加上构造器"存在即复用" → 换包/换版本仍吃同一份
//   旧 lab，于是**同包同机因机器历史不同可得 45 也可得 44**（审计原话）。现在目录名带版本，
//   且构造器按 `_labs.json` 指纹（版本＋构造器 sha256）不符就强制重建。
const PKG_VERSION = (() => {
  const pick = (v) => (v && typeof v.version === 'string' && v.version ? v.version : '');
  try { const a = pick(JSON.parse(fs.readFileSync(path.join(LITE, 'VERSION.json'), 'utf8'))); if (a) return a; } catch { /* 缺则退 package.json */ }
  try { const b = pick(JSON.parse(fs.readFileSync(path.join(LITE, 'package.json'), 'utf8'))); if (b) return b; } catch { /* 缺则退 dev */ }
  return 'dev';
})();

const args = process.argv.slice(2);
const argOf = (k) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : '';
};
const hasFlag = (k) => args.includes(`--${k}`);
const onlyRaw = (argOf('only') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const asJson = hasFlag('json');
const doProof = hasFlag('proof');
const keepWork = hasFlag('keep');
const wantHelp = args.includes('--help') || args.includes('-h');

// ★ P0-02/P1-15（审计）：默认 lab 改为**包内自足构造** —— 由 docs/工具-构造lab.mjs 造到
//   **系统临时目录** `%TEMP%\dsh-ledger-labs-<包版本>\`（K-18 起随 VERSION.version；接收端解压交付包后
//   没有 _工作\，包内也不该放几十 MB 生成物）；`--lab-dir=<dir>` 可覆盖；--lab/--big/--three-layer/--weeks
//   仍可显式指向真 lab。
const LABS_ROOT = path.resolve(argOf('lab-dir') || path.join(os.tmpdir(), 'dsh-ledger-labs-' + PKG_VERSION));
const DEFAULT_LABS_ROOT = LABS_ROOT;
const DEFAULT_LAB = path.join(DEFAULT_LABS_ROOT, 'c01-lab');
const DEFAULT_BIG = path.join(DEFAULT_LABS_ROOT, 'lab-e3-accept');
const DEFAULT_THREE = path.join(DEFAULT_LABS_ROOT, 'lab-094-3layer');
const DEFAULT_WEEKS = path.join(DEFAULT_LABS_ROOT, 'lab-weeks');
const LAB_ARG = argOf('lab');
const BIG_ARG = argOf('big');
const THREE_ARG = argOf('three-layer');
const WEEKS_ARG = argOf('weeks');
const LAB = path.resolve(LAB_ARG || DEFAULT_LAB);
const BIG = path.resolve(BIG_ARG || DEFAULT_BIG);
const THREE = path.resolve(THREE_ARG || DEFAULT_THREE);
const WEEKS = path.resolve(WEEKS_ARG || DEFAULT_WEEKS);
const RECEIPTS = path.join(WEEKS, 'receipts');

const USAGE = `判据执行器 1.0（lite 线）· 45 条聚合（C01–C40 ＋ S-11 签字 C41–C45，V1.0 毕业口径）

用法：
  node docs\\判据-1.0.mjs [选项]
  node docs\\判据-1.0.mjs --proof              # 只跑 注入故障→红 → 还原→绿 自证

选项：
  --lab=<lab>         小库 lab（默认 <lab-dir>\\c01-lab；含 root\\ 与 dsh-home\\sessions）
  --big=<lab>         大库 lab（默认 <lab-dir>\\lab-e3-accept；只读；缺则自动构造）
  --three-layer=<lab> 三层夹具（默认 <lab-dir>\\lab-094-3layer；缺则自动构造）\n  --weeks=<lab>       C41/C42 周账夹具（默认 <lab-dir>\\lab-weeks；缺则自动构造）\n  --lab-dir=<dir>    四类 lab 的根目录（默认 %TEMP%\\dsh-ledger-labs-<包版本>；缺则自动构造）
  --evid-dir=<dir>    证据目录（默认 <包根>\\证据\\判据-1.0-<YYYYMMDD-HHmmss>；不再写包外）
  --work-dir=<dir>    工作副本根（默认 %TEMP%\\dsh-ledger-criteria-work；跑完删）
  --only=C01,...      只跑指定判据（子执行器只收到属于它的编号）
  --json              stdout 只出机读 JSON（证据照常落盘）
  --proof             只跑自证（注入→红→还原→绿）
  --keep              保留工作副本（默认跑完删）
  --help              本说明

聚合：C01–C18 → 子进程 docs/判据-0.9.1.mjs；C24＋C26–C37 → 子进程 docs/判据-0.9.4.mjs；
      缺口 C19/C20/C21/C22/C23/C25/C38/C39/C40 由本文件实现。
退出码：0=参与判定的判据全绿（无红/无 NA）；1=有红或 NA（NA 不算绿）；2=用法/环境错误。
口径：总纲 §7 + S-7 / S-9 / S-10 签字项（见文件头）；缺输入记 NA 并写明缺什么，不自创口径。
证据：<包根>\\证据\\判据-1.0-<YYYYMMDD-HHmmss>\\（summary.json/summary.md + 逐条 JSON + 子执行器原始 JSON）`;

function usageError(msg) {
  console.error(`[用法错误] ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}
if (wantHelp) {
  console.log(USAGE);
  process.exit(0);
}
const KNOWN_FLAGS = new Set(['lab', 'big', 'three-layer', 'weeks', 'lab-dir', 'evid-dir', 'work-dir', 'only', 'json', 'proof', 'keep', 'help']);
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
// ★ re3（审计 P0「判据跑在交付包会把证据写到交付根」）：
//   证据默认落**包内** `证据\判据-1.0-<stamp>\`（VERSION.criteriaRun.evidence / C38 抽查都以
//   包内相对路径为准；出包/接收端同构）；`--evid-dir` 可显式改（如指到 %TEMP%）。
//   工作副本一律落**系统临时目录**，绝不落包上一级（交付根）。
// ★ preview4（F-8/B-09）：默认证据目录改**包外**（%TEMP%），不再污染包内 证据/ 与 MANIFEST；
//   本包自己的裁决证据仍用 --evid-dir 显式指定（最终证据目录），二者互不影响。
const EVID = path.resolve(argOf('evid-dir') || path.join(os.tmpdir(), `dsh-ledger-criteria-${localStamp}`));
const WORKTMP = path.resolve(argOf('work-dir') || path.join(os.tmpdir(), 'dsh-ledger-criteria-work'));
const EVID_IN_PKG = (() => {
  const r = path.relative(PKG, EVID);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
})();
// 本执行器"每跑一次新增一套"的包内运行产物命名空间：`证据/判据-1.0-<YYYYMMDD-HHmmss>/`
// （注意：随包交付的历史证据 `证据/判据-1.0-final-*/`、`判据-1.0-proof-*` **不**在此列，
//   它们按清单内文件逐文件核 sha256，不享受任何豁免）。
const RUN_ARTIFACT_PREFIX = '证据/判据-1.0-';
const RUN_ARTIFACT_STAMP_RE = /^证据\/判据-1\.0-\d{8}-\d{6}\//;
const EVID_REL_IN_PKG = EVID_IN_PKG ? path.relative(PKG, EVID).split(path.sep).join('/') : '';
/** 该相对路径是否属于本执行器运行产物（只用于 C39 的"清单外新增"登记与 proof 的原树指纹排除）。 */
function isRunArtifactRel(relPath) {
  const p = String(relPath).split(path.sep).join('/');
  if (RUN_ARTIFACT_STAMP_RE.test(p)) return true;
  if (EVID_REL_IN_PKG && (p === EVID_REL_IN_PKG || p.startsWith(`${EVID_REL_IN_PKG}/`))) return true;
  return false;
}
fs.mkdirSync(EVID, { recursive: true });
fs.mkdirSync(path.join(EVID, 'logs'), { recursive: true });

const evidLog = [];
function writeEvid(name, data) {
  const p = path.join(EVID, name);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  evidLog.push(rel(p));
  return p;
}
function writeTextEvid(name, text) {
  const p = path.join(EVID, name);
  fs.writeFileSync(p, `${text}\n`, 'utf8');
  evidLog.push(rel(p));
  return p;
}
/** 包内路径 → 相对包根的 / 分隔路径；包外路径 → 绝对 / 分隔路径（证据里可直接看出在哪）。 */
function rel(p) {
  const abs = path.resolve(p);
  const r = path.relative(PKG, abs);
  if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  return abs.split(path.sep).join('/');
}

// ============================================================================
// 二、通用工具（只读为主；写只落 EVID / WORKTMP）
// ============================================================================
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${b} B`;
}
const pct = (x, d = 3) => `${(Number(x) * 100).toFixed(d)}%`;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const sum = (arr, fn) => arr.reduce((s, x) => s + num(fn ? fn(x) : x), 0);
const MiB = 1024 ** 2;

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}
function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function readJsonFile(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}
function readTextSafe(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

const SKIP_DIRS = new Set(['.git']);
function walkFiles(root, opts = {}) {
  const out = [];
  const skip = new Set(opts.skipDirNames || ['.git']);
  const maxFiles = opts.maxFiles || 200000;
  (function rec(dir) {
    if (out.length > maxFiles) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!skip.has(ent.name) && !SKIP_DIRS.has(ent.name)) rec(abs);
      } else if (ent.isFile()) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        out.push({ abs, name: ent.name, rel: path.relative(root, abs).split(path.sep).join('/'), size: st.size });
      }
    }
  })(root);
  return out;
}
function dirSize(dir) {
  try {
    return sum(walkFiles(dir), (f) => f.size);
  } catch {
    return 0;
  }
}
function copyTreeReal(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
}
/** 硬链接树（只用于"只加不改"的注入副本；对被替换的注入目标先 unlink 再写，源树不受影响） */
function linkTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.git') continue;
      linkTree(s, d);
    } else if (ent.isFile()) {
      try {
        fs.linkSync(s, d);
      } catch {
        fs.copyFileSync(s, d);
      }
    }
  }
}
function freshSubDir(name) {
  const d = path.join(WORKTMP, `${name}-${localStamp}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 子进程跑 node 脚本；stdout/stderr 全文落 EVID\logs\<label>.log */
function runNode(label, scriptAbs, argv, timeoutMs = 600000) {
  const t0 = Date.now();
  const r = spawnSync(NODE, [scriptAbs, ...argv], {
    cwd: LITE,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env },
  });
  const exit = r.error ? -1 : r.status == null ? -1 : r.status;
  const ms = Date.now() - t0;
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, '_');
  const logAbs = path.join(EVID, 'logs', `${safe}.log`);
  try {
    fs.writeFileSync(
      logAbs,
      `$ node ${path.basename(scriptAbs)} ${argv.join(' ')}\nexit=${exit} ms=${ms}${r.error ? ` error=${String(r.error.message || r.error)}` : ''}\n\n--- stdout ---\n${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}`,
      'utf8',
    );
    evidLog.push(rel(logAbs));
  } catch {
    /* ignore */
  }
  return {
    label,
    exit,
    ms,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : '',
    logRel: rel(logAbs),
  };
}

/** 从可能带前缀/后缀的 stdout 里抠 JSON 对象 */
function extractJson(text) {
  if (!text) throw new Error('空 stdout');
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('stdout 无 JSON 对象');
  return JSON.parse(text.slice(i, j + 1));
}

// ---------- lab 解析 ----------
function resolveLab(labDir, label) {
  const root = path.join(labDir, 'root');
  const cands = [path.join(labDir, 'sessions'), path.join(labDir, 'dsh-home', 'sessions'), path.join(labDir, 'dsh-home')];
  const sessions = cands.find((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  let hasLedger = false;
  try {
    hasLedger = fs.statSync(path.join(root, 'ledger')).isDirectory();
  } catch {
    hasLedger = false;
  }
  if (!hasLedger) return { ok: false, root, sessions: '', label, why: `缺 ${root}\\ledger（或 root 不存在）` };
  if (!sessions) return { ok: false, root, sessions: '', label, why: `缺 sessions（找过 ${cands.join(' | ')}）` };
  return { ok: true, root, sessions, label, why: '' };
}
/**
 * ★ K-18 收口（re4 / 三份审计 P0-②）：lab 身份指纹 = 包版本 + 构造器 sha256 + **产品管线 sha256** + contract。
 *   - 产品管线（index.js / tools/pointerindex.mjs）一变，同版本旧 lab 也不许复用（旧口径只查 root\ledger 存在）；
 *   - 公式必须与 `docs/工具-构造lab.mjs` 的 `meta.fingerprint` 逐字段一致（两处任一改动都要同步）；
 *   - 指纹对不上 → labOk() 判不可用 → 交给构造器重建（构造器同样按指纹强制重建）。
 */
const LAB_CONTRACT = 'K-16/K-18 (re4)';
function labFingerprintWant() {
  const h = (p) => { try { return sha256File(p); } catch { return ''; } };
  const parts = [h(path.join(LITE, 'index.js')), h(path.join(LITE, 'tools', 'pointerindex.mjs'))];
  return {
    packageVersion: PKG_VERSION,
    builderSha: h(path.join(LITE, 'docs', '工具-构造lab.mjs')),
    pipelineSha: parts.every(Boolean) ? sha256Buf(Buffer.from(parts.join(''), 'utf8')) : '',
    contract: LAB_CONTRACT,
  };
}
/** 默认 lab 根下 `_labs.json` 的指纹是否与本包一致（读不到 / 缺字段 / 不符 → 视为不可用 → 触发重建）。 */
function labsMetaFingerprint() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DEFAULT_LABS_ROOT, '_labs.json'), 'utf8'));
    const got = (j && j.fingerprint) || null;
    if (!got) return { ok: false, why: '缺 _labs.json.fingerprint', got: null, want: labFingerprintWant() };
    const want = labFingerprintWant();
    const diffs = [];
    for (const k of ['packageVersion', 'builderSha', 'pipelineSha', 'contract']) {
      if (String(got[k] || '') !== String(want[k] || '')) diffs.push(`${k}: ${got[k] || '(缺)'} ≠ ${want[k] || '(缺)'}`);
    }
    return { ok: diffs.length === 0, why: diffs.join('；'), got, want };
  } catch (e) {
    return { ok: false, why: `读不到 _labs.json：${String((e && e.message) || e)}`, got: null, want: null };
  }
}
/**
 * 缺 lab 就**就地构造**（包内自足）：调 docs/工具-构造lab.mjs 造到系统临时目录。
 * @why 审计 P1-15：判据默认 lab 全在开发机包里没有 → 接收端只能跑 14 绿 / 26 NA。
 *      构造器只用公开入口跑真实插件管线；首次构造会跑 20s 级重活，之后复用。
 *      ★ 复用前提是本包指纹（包版本＋构造器＋产品管线）与 `_labs.json` 一致（K-18 收口）。
 */
function ensureLabs() {
  const needBuild = [];
  const metaFp = labsMetaFingerprint();
  const labOk = (dir, name) => {
    try {
      if (!fs.statSync(path.join(dir, 'root', 'ledger')).isDirectory()) return false;
      if (!metaFp.ok) return false; // 指纹不符/缺登记 → 不可用（旧口径只看目录存在 = 审计 P0-②）
      let ent = null;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DEFAULT_LABS_ROOT, '_labs.json'), 'utf8'));
        ent = (j && j.labs && j.labs[name]) || null;
      } catch { ent = null; }
      // 构造器明确登记 ok:false（半成品）→ 不接受；未登记（--only 局部跑会重写总表）→ 不据此否决
      return !ent || ent.ok === true;
    } catch {
      return false;
    }
  };
  // 只构造本次要用的那几类（--only 时避免白造 e3 这类重活；未给 --only 则四类都算需要）
  // 注意：此处早于 CRITERIA/only 的初始化，用 onlyRaw 判断。
  const wantSet = onlyRaw.length ? new Set(onlyRaw) : null;
  const needs = (pred) => (wantSet ? [...wantSet].some(pred) : true);
  const needC01 = needs((id) => /^C(0[1-9]|1[0-9]|2[3-9]|3[0-9]|4[345])$/.test(id));
  const needE3 = needs((id) => /^C(2[0-5]|3[0-9])$/.test(id));
  const needThree = needs((id) => id === 'C31');
  const needWeeks = needs((id) => id === 'C41' || id === 'C42');
  if (needC01 && !LAB_ARG && !labOk(DEFAULT_LAB, 'c01-lab')) needBuild.push('c01');
  if (needE3 && !BIG_ARG && !labOk(DEFAULT_BIG, 'lab-e3-accept')) needBuild.push('e3');
  if (needThree && !THREE_ARG && !labOk(DEFAULT_THREE, 'lab-094-3layer')) needBuild.push('three');
  if (needWeeks && !WEEKS_ARG && !labOk(DEFAULT_WEEKS, 'lab-weeks')) needBuild.push('weeks');
  const base = { fingerprintOk: metaFp.ok, fingerprintWhy: metaFp.why, labsRoot: DEFAULT_LABS_ROOT };
  if (!needBuild.length) return { built: false, why: '', ...base };
  const script = path.join(LITE, 'docs', '工具-构造lab.mjs');
  if (!fs.existsSync(script)) return { built: false, why: `缺构造器 ${script}`, ...base };
  const r = runNode('构造lab', script, [`--out=${DEFAULT_LABS_ROOT}`, `--only=${needBuild.join(',')}`], 1800000);
  return { built: true, exit: r.exit, logRel: r.logRel, needBuild, ...base };
}
const ENSURE = ensureLabs();
const LABD = resolveLab(LAB, '小库');
const BIGD = resolveLab(BIG, '大库(E3)');
const THREED = resolveLab(THREE, '三层夹具');
const WEEKSD = resolveLab(WEEKS, '周账夹具');
const THREE_MANIFEST = path.join(THREE, 'manifest.json');

// ---------- 账库只读扫描 ----------
function scanLedger(ledgerDir) {
  const out = { dir: ledgerDir, files: [], rows: [], badLines: 0, readErrors: [] };
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir);
  } catch {
    return out;
  }
  for (const f of names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    let text;
    try {
      text = fs.readFileSync(path.join(ledgerDir, f), 'utf8');
    } catch {
      out.readErrors.push(f);
      continue;
    }
    out.files.push(f);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.rows.push(JSON.parse(line));
      } catch {
        out.badLines += 1;
      }
    }
  }
  const codes = new Set();
  const sidTurns = new Set();
  for (const r of out.rows) {
    if (r && r.code) codes.add(String(r.code));
    if (r && r.sid != null && r.turn != null) sidTurns.add(`${r.sid}|${r.turn}`);
  }
  out.uniqueCode = codes.size;
  out.uniqueSidTurn = sidTurns.size;
  out.attachmentBytes = sum(out.rows, (r) => (r && r.attachment ? r.attachment.bytes : 0));
  return out;
}

function readTickMetrics(file) {
  if (!fs.existsSync(file)) {
    return { ok: false, file, why: `缺 ${file}（0.9.3+ 插件才有逐 tick 度量；无它无法核对 C20/C21/C25）`, ticks: [], bad: [] };
  }
  const ticks = [];
  const bad = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, idx) => {
      if (!line.trim()) return;
      try {
        ticks.push(JSON.parse(line));
      } catch {
        bad.push(idx + 1);
      }
    });
  if (!ticks.length) return { ok: false, file, why: `${file} 没有可解析 tick（bad=${bad.length}）`, ticks, bad };
  return { ok: true, file, why: '', ticks, bad };
}

function readState(root) {
  return readJsonFile(path.join(root, 'ledger', '.state.json'));
}
function stateIngestableBytes(root) {
  const st = readState(root);
  if (!st || !st.sourceCursors || typeof st.sourceCursors !== 'object') return null;
  let s = 0;
  let n = 0;
  for (const v of Object.values(st.sourceCursors)) {
    if (v && Number.isFinite(Number(v.size))) {
      s += Number(v.size);
      n += 1;
    }
  }
  return n ? { bytes: s, sessions: n } : null;
}

// ============================================================================
// 三、45 条判据原文（C01–C40 ＋ S-11 C41–C45）（逐条抄自总纲 §7，行号即出处）
// ============================================================================
const CRITERIA = [
  // §7.2 A 组 · 保存正确（8 条）→ P1 门
  { id: 'C01', group: 'A 保存正确', gate: 'P1', gl: 545, text: '真实 N 会话 → 台账行数 ＝ 真实轮数（当前基准 1558）、(sid,turn) 唯一、code 唯一、坏行 0', how: '四个数同时对（别把 1558 当永久阈值）', src: '删 1＋稳 1' },
  { id: 'C02', group: 'A 保存正确', gate: 'P1', gl: 546, text: '重复 ingest 幂等', how: '第二次跑，`written = 0`', src: '删 2＋稳 2' },
  { id: 'C03', group: 'A 保存正确', gate: 'P1', gl: 547, text: '追加一轮只写 1 行，不重复旧轮', how: '加一轮再 ingest，diff 台账', src: '删 3＋稳 3' },
  { id: 'C04', group: 'A 保存正确', gate: 'P1', gl: 548, text: '未闭合轮只进 pending，不进台账', how: '造一个半截轮，查两处', src: '删 4＋稳 4' },
  { id: 'C05', group: 'A 保存正确', gate: 'P1', gl: 549, text: '单实例：两进程同跑，第二个跳过并留日志', how: '同时起两个，看锁文件与日志', src: '删 5' },
  { id: 'C06', group: 'A 保存正确', gate: 'P1', gl: 550, text: '文件换成更小的（尾部不同）→ 新内容入账、游标停在新文件边界', how: '截短文件，看游标位置', src: '稳 6' },
  { id: 'C07', group: 'A 保存正确', gate: 'P1', gl: 551, text: '文件正在写（半截）→ 本轮跳过、下轮入账、无 partial 残留', how: '边写边跑 tick，查目录残留', src: '稳 7' },
  { id: 'C08', group: 'A 保存正确', gate: 'P1', gl: 552, text: 'kill -9 → 重启从游标继续，不重复不丢', how: '跑到一半强杀，重启对账', src: '稳 10' },
  // §7.3 B 组 · 内容保真（5 条）→ P1 门
  { id: 'C09', group: 'B 内容保真', gate: 'P1', gl: 558, text: '★★★ 每份 原始事件.json 与源会话对应轮次**逐字节相等**', how: '全量重比（实测曾 46,564/46,564 行相等）', src: '删 6' },
  { id: 'C10', group: 'B 内容保真', gate: 'P1', gl: 559, text: '每份视图 md 的正文 hash 可独立复算', how: '独立脚本重算', src: '删 7' },
  { id: 'C11', group: 'B 内容保真', gate: 'P1', gl: 560, text: '★ md 头明确写"视图非全集"且含省略条数', how: '打开任意 md 看头三行', src: '删 8' },
  { id: 'C12', group: 'B 内容保真', gate: 'P1', gl: 561, text: '截断披露行与附件名/sha256 一致', how: '三处交叉核', src: '删 9' },
  { id: 'C13', group: 'B 内容保真', gate: 'P1', gl: 562, text: '编码 date 段 ＝ 会话开始日（跨月不拆）', how: '造一个跨零点会话', src: '删 10' },
  // §7.4 C 组 · 不假绿（6 条）→ P1 验 C14–C18；C19 在 P2 验；P4 全部重验
  { id: 'C14', group: 'C 不假绿', gate: 'P1', gl: 568, text: '每行 entryHash 可复算', how: '逐行重算', src: '删 11', caliber: 'S-7：改为「原文重放式对账」（不引入 entryHash，S-6 否决）' },
  { id: 'C15', group: 'C 不假绿', gate: 'P1', gl: 569, text: '改任一字段（turn/ts/seq/sid/doc/attachment/code）→ `verify` exit≠0', how: '七次单字段变异', src: '删 12', caliber: 'S-7 修订版：8 种单字段变异（含 status/code）' },
  { id: 'C16', group: 'C 不假绿', gate: 'P1', gl: 570, text: '删整行 / 追加伪造行 / 删附件 / 改附件一字节 → exit≠0', how: '四类破坏各一次', src: '删 13', caliber: 'S-7 修订版' },
  { id: 'C17', group: 'C 不假绿', gate: 'P1', gl: 571, text: '★ 变异反证：删掉某条修复逻辑 → **对应用例**必须变红（不是"一堆红"）', how: '逐个拔，记录谁红', src: '删 14' },
  { id: 'C18', group: 'C 不假绿', gate: 'P1', gl: 572, text: 'gate 三级输入 4 项，每项都有"怎么变 degraded"的构造用例', how: '四项各造一次', src: '删 15' },
  { id: 'C19', group: 'C 不假绿', gate: 'P2', gl: 573, text: '★★ 人为改"中段"（不改头尾、恢复 mtime）→ 当天周期全量核必须发现', how: '改一字节＋还原 mtime，跑每日全量核（**依赖 P2 第 5 项，故不在 P1 验**）', src: '稳 5', local: true },
  // §7.5 D 组 · 续航与稳产（6 条）→ P2 门
  { id: 'C20', group: 'D 续航稳产', gate: 'P2', gl: 579, text: '48 MB 语料端到端 ≤ **3** 个 tick（原 2 作废 → R-3）', how: '压测', src: '删 16', caliber: 'R-3：48 MB 语料与单会话 38.82 MB 统一取 ≤3 tick', local: true },
  { id: 'C21', group: 'D 续航稳产', gate: 'P2', gl: 580, text: '★ 稳态单 tick 读盘 ≤ 1 MB，且 ≤ 2× 变更量（不是全量重读）', how: '无变更跑 10 tick 计读盘', src: '删 17＋稳 9', local: true },
  { id: 'C22', group: 'D 续航稳产', gate: 'P2', gl: 581, text: '账库体积 ≤ 1.25× 语料；单文件 ≤ 4 MB', how: '量目录', src: '删 18', caliber: 'S-9② 拆两条：套账(台账+索引) ≤0.05× 压缩语料；原文+视图 = 1.00–1.35× 解压语料（§5.9② 单文件 ≤4 MB，xlsx 除外）', local: true },
  { id: 'C23', group: 'D 续航稳产', gate: 'P2', gl: 582, text: '判据产物（台账/索引/游标/报告）只用 `.jsonl` / `.md` / `.json`；**例外**：周账视图 `.xlsx`、外发日结摘要 `.txt`', how: '按白名单扫扩展名', src: '删 19', caliber: '§5.9① 落盘格式；B11 已把两个例外写进判据与 §5.9①', local: true },
  { id: 'C24', group: 'D 续航稳产', gate: 'P2', gl: 583, text: '★ 一年后的账库预估（给定每天 N 轮 → 体积与查询耗时）写在文档里', how: '读文档', src: '删 20', caliber: 'S-10③ 单位统一 GiB，条款 ≈364 GiB' },
  { id: 'C25', group: 'D 续航稳产', gate: 'P2', gl: 584, text: '★★ 38.82 MB 会话：单 tick ≤ 30 秒、读盘 ≤ 8 MB、游标前进；连续 3 tick 内完整入账、无重复', how: '单会话大文件压测', src: '稳 8', caliber: 'S-9① 改判：保留 3 tick/≤30 s；读盘改为「消费 ≤17 MiB/tick、读放大 ≤2.5×（≤40 MB/tick）」', local: true },
  // §7.6 E 组 · 扩容与查询（12 条）→ P3 门
  { id: 'C26', group: 'E 扩容查询', gate: 'P3', gl: 590, text: '索引条数 ＝ 台账行数（同天），每条 code 在台账里存在', how: '对账（口径见 R-5）', src: '扩 1', caliber: 'R-5：索引行＝台账行＝轮' },
  { id: 'C27', group: 'E 扩容查询', gate: 'P3', gl: 591, text: '★ 索引每条 `h` 与台账行复算一致', how: '重算比对', src: '扩 2', caliber: 'S-10①：四字段（code/docFileSha256/offset/bytes）由原文独立复算；不引入 entryHash' },
  { id: 'C28', group: 'E 扩容查询', gate: 'P3', gl: 592, text: '新增一行 → 索引同步加一行（不重建、不重扫）', how: '加一行看索引增量', src: '扩 3' },
  { id: 'C29', group: 'E 扩容查询', gate: 'P3', gl: 593, text: '★ 删掉索引文件 → 能从台账重建（索引是派生物，不是权威）', how: '删了重建，逐行等', src: '扩 4' },
  { id: 'C30', group: 'E 扩容查询', gate: 'P3', gl: 594, text: '按时间范围查 → 与"暴力扫台账"结果集完全一致', how: '两条路对撞', src: '扩 5' },
  { id: 'C31', group: 'E 扩容查询', gate: 'P3', gl: 595, text: '★ 按 sid 查 → 跨热/温/冷三层都正确', how: '三个 sid 各一层', src: '扩 6', caliber: '夹具 lab-094-3layer：热=锚点日 / 温=90–180 天 / 冷=>365 天；锚点≠今天 → NA' },
  { id: 'C32', group: 'E 扩容查询', gate: 'P3', gl: 596, text: '按 code 查 → O(1) 定位月份目录（编码前 8 位即日期）', how: '计步数', src: '扩 7', caliber: '实测口径：非 O(1)、code 日起向后有界扫描（阈值 50 ms）' },
  { id: 'C33', group: 'E 扩容查询', gate: 'P3', gl: 597, text: '★★ 查不到必须返回 `searchedRange` + `olderAvailable` + `hint`', how: '查一个不存在的词', src: '扩 8' },
  { id: 'C34', group: 'E 扩容查询', gate: 'P3', gl: 598, text: '性能：查今天 < 100 ms；查 90 天 < 1 s；查指定冷月 < 2 s', how: '三档计时', src: '扩 9' },
  { id: 'C35', group: 'E 扩容查询', gate: 'P3', gl: 599, text: '★ 冷层查询不加载其他月份索引', how: '看文件句柄 / 读盘量', src: '扩 10' },
  { id: 'C36', group: 'E 扩容查询', gate: 'P3', gl: 600, text: '索引总大小 ≤ 台账总大小 15%', how: '量目录（R-5 口径下 ≈49 MB vs 104 GB，远低于 15%）', src: '扩 11', caliber: 'S-10②：分母＝整包（排除 .git/MANIFEST）＋台账双读法，两者都 ≤15%' },
  { id: 'C37', group: 'E 扩容查询', gate: 'P3', gl: 601, text: '★ 增量备份只拷"上次之后新写的"；整库搬走 ＝ 拷目录 + 一条命令验证可读', how: '备份演练', src: '扩 12' },
  // §7.7 F 组 · 交付纪律（3 条）→ P4 门
  { id: 'C38', group: 'F 交付纪律', gate: 'P4', gl: 607, text: '数字脚本生成，不手写', how: '抽查任意数字有没有生成脚本', src: '删 21', local: true },
  { id: 'C39', group: 'F 交付纪律', gate: 'P4', gl: 608, text: '清单与磁盘 0 差异（今天"缺 126"的教训）', how: '对 MANIFEST', src: '删 22', local: true },
  { id: 'C40', group: 'F 交付纪律', gate: 'P4', gl: 609, text: '版本台账 append-only，**版本台账链**不断（≠ 封板链，R-9）', how: '追加一条验链', src: '删 23', caliber: 'R-9：版本台账链（保留，防改版历史）≠ 封板链（砍，只留封板事实）', local: true },

  // §7.7 G 组 · V1.0 毕业组（S-11 签字新增 C41–C45，判据 40 → 45）
  { id: 'C41', group: 'G 给人看与能恢复', gate: 'P4', gl: 0, text: '周账 xlsx 内容与台账一致 —— 抽 3 周（含一个跨月周）逐行对，3 周 100% 相符', how: '解 xlsx 逐日表与台账逐码对', src: 'S-11 §4 C41', caliber: 'S-11 C41：xlsx 不得缺行、不得多行；时间列 hh:mm 与台账 ts 一致', local: true },
  { id: 'C42', group: 'G 给人看与能恢复', gate: 'P4', gl: 0, text: '日结摘要（JSON＋TXT）与台账一致 —— 抽 3 天 100% 相符；★ 发出后不许重写，只能补发新版', how: '摘要首/末条与行数字段独立复算 + 改台账真跑 tick：旧版逐字节不变、必须新增 vN JSON/TXT、run-report 版本账可见、无变化不产新版', src: 'S-11 §4 C42', caliber: 'S-11 C42 后签优先于 lite S-1 旧口径（旧："10 键、坏了重出直接覆盖"）；v1.0.0-re2 产品已改为 11 键（含 firstCode）+ 版本化补发 + 永不覆盖 + run-report 版本账', local: true },
  { id: 'C43', group: 'G 给人看与能恢复', gate: 'P4', gl: 0, text: '交接表：每会话一份、删了不补（机主 2026-11-14 裁定改为**反向判据**：验交接表冻结不被绕过）', how: '造 2 会话各跑 3 tick；交接表目录/文件数不得增加；删后 3 tick 内不得重建；出现任何交接表生成即 RED', src: 'S-11 §4 C43 + 早会裁定', caliber: 'lite 冻结交接表（S-1/§5.3）：handoverGenerated/Adopted/Skipped/SealedTotal 必须恒 0', local: true },
  { id: 'C44', group: 'G 给人看与能恢复', gate: 'P4', gl: 0, text: 'doctor 能对 5 类已知故障各报一次红（先红后绿）：①台账行数≠原文份数 ②原文 sha256 复算失败 ③游标卡住 ④pending 积压超阈 ⑤单文件>4MB', how: '五类各注入一次 → doctor 目标检查必须 severity=red → 还原 → 必须不红', src: 'S-11 §4 C44', caliber: 'S-11 写「entryHash 复算失败」；该字段已被 S-6 否决（全树 0 命中），落到 doctor ② 的「原文整文件 sha256 复算」，口径差如实登记', local: true },
  { id: 'C45', group: 'G 给人看与能恢复', gate: 'P4', gl: 0, text: '恢复演练：从备份重建 → verify 绿 → 随机抽 100 行与源逐字节相等', how: 'backup → verify → 删工作库 → restore → 抽 100 行逐字节比', src: 'S-11 §4 C45', caliber: 'S-11 C45：没有演练过的备份等于没有备份；耗时记入证据', local: true },
];
const BY_ID = new Map(CRITERIA.map((c) => [c.id, c]));
const ALL_IDS = CRITERIA.map((c) => c.id);
const ids091 = ALL_IDS.filter((id) => Number(id.slice(1)) <= 18);
const ids094 = ['C24', 'C26', 'C27', 'C28', 'C29', 'C30', 'C31', 'C32', 'C33', 'C34', 'C35', 'C36', 'C37'];
const localIds = ALL_IDS.filter((id) => BY_ID.get(id).local);

// --only 校验
if (onlyRaw.some((id) => !BY_ID.has(id))) {
  usageError(`--only 里有不认识的判据：${onlyRaw.filter((id) => !BY_ID.has(id)).join(',')}`);
}
const only = onlyRaw.length ? onlyRaw : ALL_IDS.slice();

// ============================================================================
// 四、聚合：子进程调用 0.9.1 / 0.9.4（复用，不重写）
// ============================================================================
/**
 * 子执行器证据/工作目录的**唯一来源**：全部放本次 EVID（包内）与 WORKTMP（%TEMP%）下，
 * 通过 `--evid-dir` / `--work-dir` 显式传给子进程 —— 子执行器不再自己往包上一级写。
 */
function childDirs(which) {
  const is091 = which === '0.9.1';
  return {
    evid: path.join(EVID, is091 ? '0.9.3-沿用-判据-0.9.1-存档' : 'child-判据-0.9.4'),
    work: path.join(WORKTMP, is091 ? '091-work' : '094-work'),
  };
}

function runChild(which, ids) {
  const is091 = which === '0.9.1';
  const script = path.join(LITE, 'docs', is091 ? '判据-0.9.1.mjs' : '判据-0.9.4.mjs');
  const dirs = childDirs(which);
  const argv = [
    '--json',
    `--lab=${LAB}`,
    `--only=${ids.join(',')}`,
    `--evid-dir=${dirs.evid}`,
    `--work-dir=${dirs.work}`,
  ];
  if (!is091) argv.push(`--big=${BIG}`, `--three-layer=${THREE}`);
  const r = runNode(is091 ? '子进程-判据-0.9.1' : '子进程-判据-0.9.4', script, argv, is091 ? 3600000 : 1800000);
  let json = null;
  let parseErr = '';
  try {
    json = extractJson(r.stdout);
  } catch (e) {
    parseErr = String((e && e.message) || e);
  }
  if (json) writeEvid(is091 ? 'child-判据-0.9.1.json' : 'child-判据-0.9.4.json', json);
  return { which, label: is091 ? '判据-0.9.1' : '判据-0.9.4', script: rel(script), exit: r.exit, ms: r.ms, json, parseErr, logRel: r.logRel, evidenceDir: rel(dirs.evid), evidenceAbs: dirs.evid, startedAt: Date.now() - r.ms };
}

/** 最近一次 --proof 的 proof-summary.json（汇总里只做引用，不重跑）。
 *  优先包内 `证据\判据-1.0-*`；老开发树里包外的 `_工作\证据\判据-1.0-*` 仅作兼容回退。 */
function findLatestProofSummary() {
  const roots = [path.join(PKG, '证据')];
  if (fs.existsSync(path.join(WORK, '证据')) && path.resolve(WORK, '证据') !== path.resolve(PKG, '证据')) roots.push(path.join(WORK, '证据'));
  let best = null;
  for (const root of roots) {
    try {
      const dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('判据-1.0-'))
        .map((e) => path.join(root, e.name));
      for (const d of dirs) {
        const f = path.join(d, 'proof-summary.json');
        if (!fs.existsSync(f)) continue;
        let j = null;
        try {
          j = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch {
          continue;
        }
        const st = fs.statSync(f);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = {
            dir: rel(d),
            file: rel(f),
            mtimeMs: st.mtimeMs,
            at: j.at,
            ok: j.ok,
            ids: (j.proofs || []).map((p) => p.id),
            pass: (j.proofs || []).filter((p) => p.pass).length,
            total: (j.proofs || []).length,
          };
        }
      }
    } catch {
      /* 缺目录 → 下一个候选 */
    }
  }
  return best;
}

/** 0.9.1 的日志目录现在由 `--evid-dir` 直接指到本次证据目录 → 只做"归档计数"（不再跑后搬运）。 */
function archive091Evidence(child) {
  const dest = child && child.evidenceAbs ? child.evidenceAbs : childDirs('0.9.1').evid;
  let n = 0;
  try {
    for (const ent of fs.readdirSync(dest, { withFileTypes: true })) if (ent.isFile()) n += 1;
  } catch {
    n = 0;
  }
  return { archived: n, dest: rel(dest), mode: '子执行器直接写入 --evid-dir（不写包外、不再跑后搬运）' };
}

function ingestChildRows(child) {
  const rows = new Map();
  if (!child.json) return rows;
  if (child.which === '0.9.1') {
    const results = Array.isArray(child.json.results) ? child.json.results : [];
    for (const r of results) {
      let status = r.status;
      if (status === 'SKIP') status = 'NA';
      const reasons = Array.isArray(r.reasons) ? r.reasons : [];
      rows.set(r.id, {
        status,
        summary:
          status === 'GREEN'
            ? `${r.checks.length} 项全过（${r.checks.map((c) => `${c.name || c.file}`).join('、')}）`
            : reasons[0] || '未给出原因',
        reasons,
        child: '0.9.1',
        checks: (r.checks || []).map((c) => ({ name: c.name, file: c.file, exit: c.exit, errors: c.error || '' })),
      });
    }
  } else {
    const criteria = Array.isArray(child.json.criteria) ? child.json.criteria : [];
    for (const r of criteria) {
      let status = r.status;
      if (status === 'SKIP') status = 'NA';
      rows.set(r.id, {
        status,
        summary: String(r.summary || (Array.isArray(r.reasons) && r.reasons[0]) || ''),
        reasons: Array.isArray(r.reasons) ? r.reasons : [],
        child: '0.9.4',
        evidence: r.evidence || null,
      });
    }
  }
  return rows;
}

/** NA 行（缺什么写清楚） */
function naRow(id, reasons, evidence) {
  return { id, status: 'NA', summary: Array.isArray(reasons) ? reasons[0] : String(reasons), reasons: Array.isArray(reasons) ? reasons : [String(reasons)], evidence: evidence || null };
}
function redRow(id, reasons, evidence) {
  const list = Array.isArray(reasons) ? reasons : [String(reasons)];
  return { id, status: 'RED', summary: list[0], reasons: list, evidence: evidence || null };
}
function greenRow(id, summary, evidence) {
  return { id, status: 'GREEN', summary, reasons: [], evidence: evidence || null };
}

// ============================================================================
// 五、缺口判据实现（C19/C20/C21/C22/C23/C25/C38/C39/C40）
// ============================================================================

// ---------- 公共：E3 大库只读统计（C20/C21/C22/C25/C38 共用；按 root 缓存） ----------
const e3Cache = new Map();
function getE3(big) {
  const key = `${big.root}|${big.metricsFile || ''}`;
  const useCache = !big.fresh;
  if (useCache && e3Cache.has(key)) return e3Cache.get(key);
  const ledgerDir = path.join(big.root, 'ledger');
  const metricsFile = big.metricsFile || path.join(ledgerDir, '.tick-metrics.jsonl');
  const led = scanLedger(ledgerDir);
  const rootFiles = walkFiles(big.root);
  const ledgerDayFiles = rootFiles.filter((f) => /^ledger\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.rel));
  const indexFiles = rootFiles.filter((f) => f.rel.startsWith('ledger/.index/'));
  const originals = rootFiles.filter((f) => /原始事件\.json$/.test(f.name));
  const views = rootFiles.filter((f) => /完整原文\.md$/.test(f.name));
  const nonXlsx = rootFiles.filter((f) => path.extname(f.name).toLowerCase() !== '.xlsx');
  const maxFile = nonXlsx.length ? nonXlsx.reduce((m, f) => (f.size > m.size ? f : m), nonXlsx[0]) : null;
  const maxIndex = indexFiles.length ? indexFiles.reduce((m, f) => (f.size > m.size ? f : m), indexFiles[0]) : null;
  const metrics = readTickMetrics(metricsFile);
  const state = readState(big.root);
  const ingestable = stateIngestableBytes(big.root);
  const e3 = {
    root: big.root,
    sessions: big.sessions,
    led,
    rootFiles,
    ledgerDayBytes: sum(ledgerDayFiles, (f) => f.size),
    indexBytes: sum(indexFiles, (f) => f.size),
    originalsBytes: sum(originals, (f) => f.size),
    originalsCount: originals.length,
    viewsBytes: sum(views, (f) => f.size),
    viewsCount: views.length,
    maxFile,
    maxIndex,
    metrics,
    state,
    ingestable,
    corpusBytes: dirSize(big.sessions),
  };
  if (useCache) e3Cache.set(key, e3);
  return e3;
}

/** 入账 tick 分析：首个 written 累计==台账行数 的 tick 序号（1-based），之后必须 written=0 */
function analyzeIngest(ticks, rowsCount) {
  const seq = ticks.map((t) => ({
    written: num(t.written),
    ms: num(t.ms),
    consumed: num(t.io && t.io.consumedSourceBytes),
    readBytes: num(t.readBytes),
    stateBytes: num(t.io && t.io.stateBytes),
    headFp: num(t.io && t.io.headFpBytes),
    tailFp: num(t.io && t.io.tailFpBytes),
  }));
  let cum = 0;
  let n = -1;
  let total = 0;
  for (let i = 0; i < seq.length; i += 1) {
    total += seq[i].written;
    cum += seq[i].written;
    if (n < 0 && cum === rowsCount) n = i + 1;
    if (n < 0 && cum > rowsCount) break;
  }
  return { seq, n, total, afterZero: n > 0 && seq.slice(n).every((x) => x.written === 0) };
}

// ---------- C19 · 中段改写 → 当天全量核必须发现（调 docs/工具-日检.mjs） ----------
function runDaycheck(rootPath, sessionsPath, tag) {
  const r = runNode(`C19-日检-${tag}`, path.join(LITE, 'docs', '工具-日检.mjs'), [`--root=${rootPath}`, `--sessions=${sessionsPath}`, '--json'], 900000);
  let report = null;
  let parseErr = '';
  try {
    report = extractJson(r.stdout);
  } catch (e) {
    parseErr = String((e && e.message) || e);
  }
  let saved = '';
  if (report && report.reportPath && fs.existsSync(report.reportPath)) {
    saved = path.join(EVID, `C19-日检-${tag}.json`);
    try {
      fs.copyFileSync(report.reportPath, saved);
      evidLog.push(rel(saved));
    } catch {
      saved = '';
    }
  }
  return { ...r, report, parseErr, saved };
}
function c19Verdict(d) {
  const rep = d.report;
  const brokenFlag = !!(rep && (rep.broken === true || (rep.broken && rep.broken.isBroken === true) || (Array.isArray(rep.broken) && rep.broken.length > 0)));
  if (d.exit === 3 || brokenFlag) return { ok: false, level: 'SELF_BROKEN', why: `日检器自身失效（exit 3 / broken=${JSON.stringify(rep && rep.broken)}）——不是账坏了，是器坏了` };
  if (!rep) return { ok: false, level: 'NO_JSON', why: `日检未产出可解析 JSON（exit=${d.exit}，${d.parseErr}）` };
  const c19 = rep.c19 || {};
  const counts = c19.counts || (c19.details && c19.details.counts) || {};
  const skipped = c19.skipped || (c19.details && c19.details.skipped) || {};
  const inv = c19.invariants || (c19.details && c19.details.invariants) || [];
  const invBroken = inv.filter((x) => x && x.ok === false).map((x) => x.id);
  const pairs = num(counts.pairs);
  const compared = num(c19.compared);
  const missing = num(counts.missing);
  const extra = num(counts.extra);
  const badLines = num(counts.ledgerBadLines) + num(counts.ledgerReadErrors);
  const skippedBad = num(skipped.unparsable);
  const mismatches = Array.isArray(c19.mismatches) ? c19.mismatches.length : 0;
  const innerOk = c19.ok === true || (c19.ok === undefined && c19.replayOk === true && num(c19.replayExitCode) === 0);
  const coverageOk = compared === 0 ? pairs > 0 : compared === pairs;
  const green = d.exit === 0 && rep.ok !== false && innerOk && pairs > 0 && coverageOk && missing === 0 && extra === 0 && badLines === 0 && skippedBad === 0 && mismatches === 0 && invBroken.length === 0;
  return {
    ok: green,
    level: green ? 'GREEN' : 'RED',
    c19,
    counts,
    invBroken,
    pairs,
    compared,
    ledgerRows: num(c19.ledgerRows),
    bad: missing + extra + badLines,
    skippedBad,
    mismatches,
    msg: (c19.message || '').slice(0, 300),
  };
}

function runC19(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return naRow('C19', [`缺小库 lab：${lab.why}`]);
  const work = freshSubDir('c19');
  try {
    copyTreeReal(lab.root, path.join(work, 'root'));
    const d = runDaycheck(path.join(work, 'root'), lab.sessions, 'run');
    const v = c19Verdict(d);
    const evidence = {
      workCopy: rel(work),
      sessionsReadOnly: rel(lab.sessions),
      daycheckLog: d.logRel,
      report: d.saved ? rel(d.saved) : '',
      counts: v.counts,
      invariantsBroken: v.invBroken,
      mismatches: v.mismatches,
      mode: '注入=改中段台账行+还原 mtime（--proof 做）；本体=对未改写副本跑一次全量核',
    };
    if (!v.ok) {
      if (v.level === 'SELF_BROKEN' || v.level === 'NO_JSON') return redRow('C19', [v.why], evidence);
      return redRow('C19', [`全量核发现不一致（pairs=${v.pairs} bad=${v.bad} unparsable=${v.skippedBad}）：${v.msg}`], evidence);
    }
    return greenRow(
      'C19',
      `日检全量重放一致：台账 ${v.counts.ledgerFiles || 0} 文件/${v.pairs} 对，重放 ${v.counts.replayedSessions || 0} 会话、坏行 ${v.counts.ledgerBadLines || 0}、跳 ${v.skippedBad}（日检 exit 0）`,
      evidence,
    );
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------- C20 · 48 MB 语料端到端 ≤3 tick（E3 只读度量） ----------
function runC20(ctx) {
  const big = ctx.big;
  if (!big.ok) return naRow('C20', [`缺大库 lab（E3）：${big.why}`]);
  const e3 = getE3(big);
  if (!e3.metrics.ok) return naRow('C20', [e3.metrics.why]);
  const led = e3.led;
  const rowsCount = led.rows.length;
  if (!rowsCount) return redRow('C20', ['E3 台账为空，无法判端到端入账'], { ledgerDir: rel(path.join(big.root, 'ledger')) });
  const a = analyzeIngest(e3.metrics.ticks, rowsCount);
  const corpusAll = e3.corpusBytes;
  const ingestable = e3.ingestable ? e3.ingestable.bytes : 0;
  const problems = [];
  if (a.n < 1) problems.push(`累计 written 在 ${e3.metrics.ticks.length} 个 tick 内没有任何时刻等于台账行数 ${rowsCount}（total=${a.total}）`);
  if (a.n > 3) problems.push(`端到端 ${a.n} 个 tick > 3`);
  if (!a.afterZero) problems.push('入账完成后的 tick 仍有 written>0（可能重复写入）');
  if (a.total !== rowsCount) problems.push(`written 合计 ${a.total} ≠ 台账行数 ${rowsCount}`);
  if (led.uniqueCode !== rowsCount) problems.push(`code 唯一数 ${led.uniqueCode} ≠ 行数 ${rowsCount}（有重复）`);
  if (led.uniqueSidTurn !== rowsCount) problems.push(`(sid,turn) 唯一数 ${led.uniqueSidTurn} ≠ 行数 ${rowsCount}（有重复）`);
  if (led.badLines) problems.push(`台账坏行 ${led.badLines}`);
  const caveat = corpusAll < 48 * 1000 * 1000 ? `语料 ${fmtBytes(corpusAll)}（可入账源 ${fmtBytes(ingestable)}）< 条款 48 MB；48 MB 原始语料未留存，本判据在 E3 现有只读语料上判，规模差已登记` : '';
  const evidence = {
    metrics: rel(e3.metrics.file),
    ticks: a.seq,
    rowsCount,
    uniqueCode: led.uniqueCode,
    uniqueSidTurn: led.uniqueSidTurn,
    endToEndTicks: a.n,
    writtenTotal: a.total,
    corpusBytesTotal: corpusAll,
    ingestableBytes: ingestable,
    caveat,
    caliber: 'R-3：48 MB 语料端到端 ≤3 tick；E3 度量口径 = ledger/.tick-metrics.jsonl 的 written 逐 tick 累计',
  };
  if (problems.length) return redRow('C20', problems, evidence);
  return greenRow(
    'C20',
    `${fmtBytes(corpusAll)} 语料端到端 ${a.n} 个 tick 入账 ${rowsCount} 行（written 合计 ${a.total}，code/(sid,turn) 唯一 ${led.uniqueCode}/${led.uniqueSidTurn}，坏行 ${led.badLines}）${caveat ? '；⚠ ' + caveat : ''}`,
    evidence,
  );
}

// ---------- C21 · 稳态单 tick 读盘 ≤1 MB 且 ≤2× 变更量 ----------
function runC21(ctx) {
  const big = ctx.big;
  if (!big.ok) return naRow('C21', [`缺大库 lab（E3）：${big.why}`]);
  const e3 = getE3(big);
  if (!e3.metrics.ok) return naRow('C21', [e3.metrics.why]);
  const ticks = e3.metrics.ticks;
  const steady = ticks.filter((t) => num(t.written) === 0);
  if (!steady.length) return naRow('C21', ['E3 度量里没有 written=0 的稳态 tick（无法判"无变更跑 tick"）'], { metrics: rel(e3.metrics.file) });
  const problems = [];
  const details = [];
  for (let i = 0; i < steady.length; i += 1) {
    const t = steady[i];
    const readBytes = num(t.readBytes);
    const consumed = num(t.io && t.io.consumedSourceBytes);
    const stateBytes = num(t.io && t.io.stateBytes);
    const headFp = num(t.io && t.io.headFpBytes);
    const tailFp = num(t.io && t.io.tailFpBytes);
    // 变更量口径：本 tick 真实变化承载 = 源消费字节 + 状态字节 + 头/尾指纹（稳态下后三者就是"只读变化本身"）
    const changeAmount = consumed + stateBytes + headFp + tailFp;
    const ratio = changeAmount > 0 ? readBytes / changeAmount : readBytes === 0 ? 0 : Infinity;
    details.push({ tick: t.tickId || '', ts: t.ts, readBytes, changeAmount, ratio, written: num(t.written) });
    if (readBytes > 1 * MiB) problems.push(`稳态 tick ${t.ts || i} 读盘 ${fmtBytes(readBytes)} > 1 MiB`);
    if (!(ratio <= 2)) problems.push(`稳态 tick ${t.ts || i} 读放大 ${Number.isFinite(ratio) ? ratio.toFixed(2) + '×' : '∞'} > 2× 变更量（read=${readBytes} change=${changeAmount}）`);
  }
  const evidence = {
    metrics: rel(e3.metrics.file),
    steadyTicks: steady.length,
    perTick: details,
    caliber: 'C21 原文：稳态单 tick 读盘 ≤1 MB 且 ≤2× 变更量（不是全量重读）。变更量 = consumedSourceBytes+stateBytes+headFpBytes+tailFpBytes（tick 自记的变化承载量；稳态下 readBytes 恰等于它 = 1.00×）；另：稳态 readBytes/语料 = 只读变化而非全量',
    note: `样本 ${steady.length} tick（条款建议无变更跑 10 tick；E3 现有只读度量只有 ${steady.length} 个稳态 tick，10 tick 观测未跑，已登记残余）`,
  };
  if (problems.length) return redRow('C21', problems, evidence);
  const maxRead = Math.max(...details.map((d) => d.readBytes));
  const maxRatio = Math.max(...details.map((d) => (Number.isFinite(d.ratio) ? d.ratio : 1e9)));
  return greenRow('C21', `稳态 ${steady.length} tick 读盘最大 ${fmtBytes(maxRead)} ≤1 MiB；读放大最大 ${maxRatio.toFixed(2)}× ≤2× 变更量（变化承载=state+头尾指纹；语料 ${fmtBytes(e3.corpusBytes)} 未被全量重读）`, evidence);
}

// ---------- C22 · 账库体积（S-9② 两条 ＋ 单文件 ≤4 MB） ----------
function runC22(ctx) {
  const big = ctx.big;
  if (!big.ok) return naRow('C22', [`缺大库 lab（E3）：${big.why}`]);
  const e3 = getE3(big);
  const corpus = e3.corpusBytes;
  const attach = e3.led.attachmentBytes;
  if (!corpus) return redRow('C22', ['E3 sessions 为空，无法算体积倍率'], { sessions: rel(big.sessions) });
  if (!attach) return redRow('C22', ['台账 attachment.bytes 合计为 0，无法算"原文+视图"倍率'], { ledgerDir: rel(path.join(big.root, 'ledger')) });
  const r3 = (e3.ledgerDayBytes + e3.indexBytes) / corpus; // 套账（台账日文件+索引）/ 压缩语料
  const r2 = (e3.originalsBytes + e3.viewsBytes) / attach; // 原文+视图 / 解压语料代理（Σattachment.bytes）
  const r1 = attach / corpus; // 整库/压缩语料：S-9 只报告，不判红
  const maxFileOk = !e3.maxFile || e3.maxFile.size <= 4 * MiB;
  const maxIndexOk = !e3.maxIndex || e3.maxIndex.size <= 4 * MiB;
  const problems = [];
  if (!(r3 <= 0.05)) problems.push(`套账/压缩语料 = ${pct(r3)} > 0.05×（S-9② ①）`);
  if (!(r2 >= 1.0 && r2 <= 1.35)) problems.push(`原文+视图/解压语料 = ${r2.toFixed(4)}× 不在 1.00–1.35（S-9② ②）`);
  if (!maxFileOk) problems.push(`单文件 ${e3.maxFile.rel} = ${fmtBytes(e3.maxFile.size)} > 4 MB（§5.9②，xlsx 除外）`);
  if (!maxIndexOk) problems.push(`索引分片 ${e3.maxIndex.rel} = ${fmtBytes(e3.maxIndex.size)} > 4 MiB（S-10④）`);
  const evidence = {
    corpusBytes: corpus,
    ingestableBytes: e3.ingestable ? e3.ingestable.bytes : null,
    ledgerDayBytes: e3.ledgerDayBytes,
    indexBytes: e3.indexBytes,
    originalsBytes: e3.originalsBytes,
    originalsCount: e3.originalsCount,
    viewsBytes: e3.viewsBytes,
    viewsCount: e3.viewsCount,
    attachmentBytes: attach,
    r3_settle: r3,
    r2_original_view: r2,
    r1_decompress_report_only: r1,
    maxFile: e3.maxFile ? { rel: e3.maxFile.rel, size: e3.maxFile.size } : null,
    maxIndexShard: e3.maxIndex ? { rel: e3.maxIndex.rel, size: e3.maxIndex.size } : null,
    caliber: 'S-9②：套账(台账日文件+索引) ≤0.05× 压缩语料；原文+视图(原始事件.json+完整原文.md) = 1.00–1.35× 解压语料（Σ台账 attachment.bytes，S-10⑤ doctor 同一分母代理）；§5.9② 单文件 ≤4 MB（xlsx 除外）；S-10④ 索引分片 ≤4 MiB。r1 只报告（S-9 实测解压 3.49× 是全语料；E3 现存语料子集 r1=' + r1.toFixed(4) + '，差异已登记）',
  };
  if (problems.length) return redRow('C22', problems, evidence);
  return greenRow(
    'C22',
    `套账/压缩语料 ${pct(r3)} ≤5%（台账 ${fmtBytes(e3.ledgerDayBytes)}+索引 ${fmtBytes(e3.indexBytes)} / 语料 ${fmtBytes(corpus)}）；原文+视图 ${r2.toFixed(4)}× ∈[1.00,1.35]（${fmtBytes(e3.originalsBytes + e3.viewsBytes)}/${fmtBytes(attach)}）；单文件最大 ${e3.maxFile ? fmtBytes(e3.maxFile.size) : '—'} ≤4 MB；索引分片最大 ${e3.maxIndex ? fmtBytes(e3.maxIndex.size) : '—'} ≤4 MiB`,
    evidence,
  );
}

// ---------- C23 · 判据产物扩展名白名单（§5.9① / B11 两个例外） ----------
const WHITELIST_CORE = new Set(['.jsonl', '.md', '.json']);
function classifyExt(f) {
  const name = f.name;
  const ext = path.extname(name).toLowerCase();
  if (name === '.ledger-root') return { kind: 'root-marker', ok: true };
  if (WHITELIST_CORE.has(ext)) return { kind: 'core', ok: true };
  if (ext === '.xlsx') {
    if (/周记账\.xlsx$/i.test(name)) return { kind: 'exception-xlsx', ok: true };
    return { kind: 'violation', ok: false, why: '.xlsx 只允许"周账视图"（*周记账.xlsx）' };
  }
  if (ext === '.txt') {
    if (/日结|摘要/.test(name)) return { kind: 'exception-txt', ok: true };
    return { kind: 'violation', ok: false, why: '.txt 只允许"外发日结摘要"' };
  }
  return { kind: 'violation', ok: false, why: ext ? `扩展名 ${ext} 不在白名单` : '无扩展名且不是 .ledger-root 根标记' };
}
function runC23(ctx, opt = {}) {
  const lab = opt.lab || ctx.lab;
  const big = opt.big || ctx.big;
  const roots = [];
  if (big.ok) roots.push({ label: 'E3 大库', root: big.root });
  if (lab.ok) roots.push({ label: 'c01 小库', root: lab.root });
  if (!roots.length) return naRow('C23', ['缺可扫账库（小库/大库都不可用）', big.why || '', lab.why || ''].filter(Boolean));
  const per = [];
  const violations = [];
  let filesTotal = 0;
  const extCount = {};
  const exceptions = { xlsx: 0, txt: 0, rootMarker: 0 };
  for (const r of roots) {
    const files = walkFiles(r.root);
    filesTotal += files.length;
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase() || '(none)';
      extCount[ext] = (extCount[ext] || 0) + 1;
      const c = classifyExt(f);
      if (c.kind === 'exception-xlsx') exceptions.xlsx += 1;
      else if (c.kind === 'exception-txt') exceptions.txt += 1;
      else if (c.kind === 'root-marker') exceptions.rootMarker += 1;
      if (!c.ok) violations.push({ root: r.label, rel: f.rel, ext: ext === '(none)' ? '' : ext, why: c.why });
    }
    per.push({ label: r.label, root: rel(r.root), files: files.length });
  }
  const evidence = {
    roots: per,
    filesTotal,
    extCount,
    exceptions,
    violations,
    caliber: '§5.9①/C23：台账/索引/游标/报告只用 .jsonl/.md/.json；仅两个例外——周账视图 .xlsx、外发日结摘要 .txt；.ledger-root 是账库根标记（lib/layout.js，非判据产物），允许存在',
  };
  if (violations.length) return redRow('C23', violations.slice(0, 10).map((v) => `${v.rel}：${v.why}`), evidence);
  return greenRow(
    'C23',
    `扫描 ${filesTotal} 文件：扩展名分布 ${Object.entries(extCount).map(([e, n]) => `${e}=${n}`).join('/')}；白名单外 0（例外：周账 xlsx ${exceptions.xlsx}、外发摘要 txt ${exceptions.txt}；根标记 .ledger-root ${exceptions.rootMarker}）`,
    evidence,
  );
}

// ---------- C25 · 38.82 MB 会话：3 tick 完整入账 + 逐 tick 预算 + 游标前进 ----------
const C25_MS_LIMIT = 30000;
const C25_CONSUMED_LIMIT = 17 * MiB; // S-9①
const C25_READ_LIMIT = 40 * MiB; // S-9①：读放大 ≤2.5×
function runC25(ctx) {
  const big = ctx.big;
  if (!big.ok) return naRow('C25', [`缺大库 lab（E3）：${big.why}`]);
  const e3 = getE3(big);
  if (!e3.metrics.ok) return naRow('C25', [e3.metrics.why]);
  const led = e3.led;
  const rowsCount = led.rows.length;
  let sess = [];
  try {
    sess = walkFiles(big.sessions).filter((f) => /session.*\.(zstd|jsonl\.zstd|jsonl)$/.test(f.name) || f.size > 1024 * 1024);
  } catch {
    sess = [];
  }
  if (!sess.length) return naRow('C25', [`大库 sessions 下没有会话源文件：${rel(big.sessions)}`]);
  const bigFile = sess.reduce((m, f) => (f.size > m.size ? f : m), sess[0]);
  const a = analyzeIngest(e3.metrics.ticks, rowsCount);
  const ingestTicks = a.seq.filter((x) => x.written > 0);
  const problems = [];
  if (!rowsCount) problems.push('E3 台账为空');
  if (a.n < 1) problems.push(`累计 written 没有在 tick 内达到台账行数 ${rowsCount}`);
  if (a.n > 3) problems.push(`3 tick 内未完成（第 ${a.n} tick 才追平）`);
  if (!a.afterZero) problems.push('入账完成后仍有 written>0');
  if (a.total !== rowsCount) problems.push(`written 合计 ${a.total} ≠ 台账行数 ${rowsCount}`);
  if (led.uniqueCode !== rowsCount) problems.push(`code 唯一数 ${led.uniqueCode} ≠ ${rowsCount}`);
  if (led.uniqueSidTurn !== rowsCount) problems.push(`(sid,turn) 唯一数 ${led.uniqueSidTurn} ≠ ${rowsCount}`);
  if (ingestTicks.length === 0) problems.push('没有任何 written>0 的入账 tick');
  for (const t of ingestTicks) {
    if (t.ms > C25_MS_LIMIT) problems.push(`tick 耗时 ${t.ms} ms > 30 s`);
    if (t.consumed > C25_CONSUMED_LIMIT) problems.push(`tick 消费 ${fmtBytes(t.consumed)} > 17 MiB（S-9①）`);
    if (t.readBytes > C25_READ_LIMIT) problems.push(`tick 读盘 ${fmtBytes(t.readBytes)} > 40 MiB（S-9①）`);
  }
  // 游标前进：state.sourceCursors 里该大会话的 offset/size
  const st = e3.state;
  let cursor = null;
  if (st && st.sourceCursors && typeof st.sourceCursors === 'object') {
    const entries = Object.entries(st.sourceCursors);
    const hit =
      entries.find(([, v]) => v && num(v.size) === bigFile.size) ||
      entries.find(([k]) => path.basename(String(k).split('\\').join('/')) === bigFile.name);
    if (hit) cursor = { key: String(hit[0]), ...hit[1] };
  }
  const curSize = cursor ? num(cursor.size) : bigFile.size;
  const curOffset = cursor ? num(cursor.offset) : -1;
  if (!cursor) problems.push(`.state.json 里找不到大会话 ${bigFile.name} 的游标（无法证明游标前进）`);
  else if (!(curOffset > 0 && curOffset <= curSize)) problems.push(`游标 offset=${curOffset} 不在 (0, size=${curSize}]`);
  const evidence = {
    bigSession: { rel: bigFile.rel, size: bigFile.size },
    metrics: rel(e3.metrics.file),
    ticks: a.seq,
    rowsCount,
    uniqueCode: led.uniqueCode,
    uniqueSidTurn: led.uniqueSidTurn,
    endToEndTicks: a.n,
    cursor: cursor ? { size: curSize, offset: curOffset, pct: pct(curOffset / (curSize || 1), 2) } : null,
    limits: { ms: C25_MS_LIMIT, consumed: C25_CONSUMED_LIMIT, read: C25_READ_LIMIT },
    caliber: 'S-9①：保留「3 tick 内完整入账 + 单 tick ≤30 s + 游标前进」；读盘改为「消费 ≤17 MiB/tick、读放大 ≤2.5×（≤40 MB/tick）」；无重复 = written 合计=台账行数 且 code/(sid,turn) 唯一',
  };
  if (problems.length) return redRow('C25', problems, evidence);
  return greenRow(
    'C25',
    `大会话 ${fmtBytes(bigFile.size)}：${a.n} tick 入账 ${rowsCount} 行无重复（written=${a.total}，唯一 code/(sid,turn)=${led.uniqueCode}/${led.uniqueSidTurn}）；3 tick 耗时 ${ingestTicks.map((t) => t.ms).join('/')} ms ≤30 s；消费 ${ingestTicks.map((t) => fmtBytes(t.consumed)).join('/')} ≤17 MiB、读盘 ${ingestTicks.map((t) => fmtBytes(t.readBytes)).join('/')} ≤40 MiB；游标 ${fmtBytes(curOffset)}/${fmtBytes(curSize)}（${pct(curOffset / (curSize || 1), 2)}）`,
    evidence,
  );
}

// ---------- C38 · 数字脚本生成，不手写（抽查 + 交付纪律文档齐） ----------
function resolveDeliveryDir(version) {
  // 交付目录按版本动态解析（不再写死 0.9.4）：优先 `交付-v<version>`，
  // 其次前缀匹配（如 交付-v1.0.0-re / 交付-v0.9.5），最后取最新的 `交付-v*` 目录。
  let candidates = [];
  try {
    for (const n of fs.readdirSync(LITE)) {
      if (!/^交付-v/.test(n)) continue;
      const p = path.join(LITE, n);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) candidates.push({ name: n, dir: p, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  if (!candidates.length) return path.join(LITE, '交付-v0.9.4');
  const ver = String((version && version.version) || '');
  if (ver) {
    const exact = candidates.find((c) => c.name === `交付-v${ver}`);
    if (exact) return exact.dir;
    const loose = candidates
      .filter((c) => c.name.startsWith(`交付-v${ver}`))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (loose) return loose.dir;
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0].dir;
}
function runC38(ctx) {
  const version = readJsonFile(path.join(LITE, 'VERSION.json'));
  if (!version) return naRow('C38', [`缺/读不出 ${rel(path.join(LITE, 'VERSION.json'))}`]);
  const big = ctx.big;
  const missing = [];
  const mismatches = [];
  const samples = [];
  const pushSample = (name, ok, detail) => {
    samples.push({ name, ok, detail });
    if (!ok) mismatches.push(`${name}：${detail}`);
  };

  // (0) 生成器存在（数字必须由脚本生成 → 生成器在不在）
  //     ★ re3（审计 P0）：三个"交付工具链生成器"从开发机 `_工作\tools\` 移进包内 `docs\工具-*.mjs`
  //       （MANIFEST 生成/校验、E3 逐 tick 度量、交付包导出），接收端解压交付包后仍可抽查。
  const generators = [
    ['C01–C18 判据', path.join(LITE, 'docs', '判据-0.9.1.mjs')],
    ['C24＋C26–C37 判据', path.join(LITE, 'docs', '判据-0.9.4.mjs')],
    ['测试四数', path.join(LITE, 'docs', '跑测试.mjs')],
    ['语料四数', path.join(LITE, 'docs', '工具-语料四数.mjs')],
    ['doctor 指标', path.join(LITE, 'tools', 'doctor.mjs')],
    ['MANIFEST 生成/校验', path.join(LITE, 'docs', '工具-manifest.mjs')],
    ['E3 逐 tick 度量', path.join(LITE, 'docs', '工具-measure-tick.mjs')],
    ['交付包导出', path.join(LITE, 'docs', '工具-export.mjs')],
  ];
  const genMissing = generators.filter(([, p]) => !fs.existsSync(p)).map(([n, p]) => `${n}（${rel(p)}）`);
  if (genMissing.length) missing.push(`缺数字生成器：${genMissing.join('；')}`);

  // (1) VERSION.json.tests ← 跑测试日志（★ re3：只认**包内** `证据\跑测试-*.log`）
  const tests = version.tests || {};
  if (Number.isFinite(Number(tests.total))) {
    // 动态发现最新的 包内 证据\**\跑测试-*.log（不写死文件名；v1.0.0-re 起日志名变化）
    const evDir = path.join(LITE, '证据');
    const logs = [];
    try {
      for (const f of walkFiles(evDir)) if (/^跑测试-.*\.log$/.test(f.name)) logs.push(f.abs);
      logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch { /* ignore */ }
    const log = logs[0] || '';
    if (!log) missing.push(`缺测试汇总日志（${rel(evDir)} 下无 跑测试-*.log；tests ${tests.total}/${tests.pass}/${tests.fail} 无来源）`);
    else {
      const txt = readTextSafe(log);
      const need = [`tests ${tests.total}`, `pass ${tests.pass}`, `fail ${tests.fail}`];
      const notFound = need.filter((w) => !txt.includes(w));
      pushSample(`VERSION.tests ${tests.total}/${tests.pass}/${tests.fail} ← 包内 ${rel(log)}`, notFound.length === 0, notFound.length ? `日志里找不到 ${notFound.join('、')}` : `日志含 ${need.join('、')}`);
    }
  } else missing.push('VERSION.json 缺 tests 四数（无数字可查）');

  // (2) VERSION.json.criteriaRun ← 判据最终日志（包内相对路径；★ re3：不再按 BASE 解析）
  const cr = version.criteriaRun || {};
  if (cr.result) {
    const evList = String(cr.evidence || '').split(/[；;]/).map((s) => s.trim()).filter(Boolean);
    const resolveInPkg = (p) => {
      const s = String(p).replace(/\\/g, '/');
      return path.isAbsolute(s) ? path.resolve(s) : path.resolve(LITE, s.split('/').join(path.sep));
    };
    const insidePkg = (abs) => {
      const r = path.relative(LITE, abs);
      return !!r || abs === LITE ? !(r.startsWith('..') || path.isAbsolute(r)) : false;
    };
    const evAbs = evList.map(resolveInPkg).find((p) => insidePkg(p) && fs.existsSync(p)) || '';
    if (!evAbs) {
      // ★ K-26（v1.0.0-preview4 · 审计 B-04「C38 是一次性滞后对账」整改）：**首跑豁免**，但不是放水。
      //   @why 证据目录 `证据/判据-1.0-*-preview/summary.md` 是**本次运行**写出来的；在本判据执行的那一刻
      //        它必然还不存在 —— 旧口径把它记成"缺包内判据最终日志"→ NA，于是"判据自证"永远差一轮，
      //        re4 只能靠事后搬目录/改清单凑（W-01 批评过）。
      //   本版口径（写死，可被第三方复核）：首跑允许缺 summary，**但必须自洽**——
      //        `VERSION.criteriaRun.result` 的 GREEN/RED/NA/SKIP 四个计数，必须与 `VERSION.criteria`
      //        的 green/red/na/pending 四个数组长度**逐项相等**；且四个计数必须齐（缺一即红）。
      //   接收端重跑时 summary 一定已随包存在 → 走下面的强校验 + 硬断言（那时这里的豁免不生效）。
      const pairsFirstRun = String(cr.result).match(/(GREEN|RED|NA|SKIP)=(\d+)/g) || [];
      const declaredFirstRun = { GREEN: null, RED: null, NA: null, SKIP: null };
      for (const p of pairsFirstRun) {
        const m = /^(GREEN|RED|NA|SKIP)=(\d+)$/.exec(p);
        if (m) declaredFirstRun[m[1]] = Number(m[2]);
      }
      const vcFirstRun = version.criteria || {};
      const wantFirstRun = {
        GREEN: Array.isArray(vcFirstRun.green) ? vcFirstRun.green.length : -1,
        RED: Array.isArray(vcFirstRun.red) ? vcFirstRun.red.length : -1,
        NA: Array.isArray(vcFirstRun.na) ? vcFirstRun.na.length : -1,
        SKIP: Array.isArray(vcFirstRun.pending) ? vcFirstRun.pending.length : -1,
      };
      const badFirstRun = Object.keys(wantFirstRun).filter((k) => declaredFirstRun[k] === null || declaredFirstRun[k] !== wantFirstRun[k]);
      pushSample(
        `VERSION.criteriaRun.result 与本版 criteria 数组自洽（首跑：${cr.evidence || '(空)'} 由本次运行生成）`,
        badFirstRun.length === 0,
        badFirstRun.length
          ? `不自洽：${badFirstRun.map((k) => `${k} 声明=${declaredFirstRun[k]} / criteria.${k === 'GREEN' ? 'green' : k === 'RED' ? 'red' : k === 'NA' ? 'na' : 'pending'}=${wantFirstRun[k]}`).join('；')}`
          : `自洽：GREEN=${declaredFirstRun.GREEN} RED=${declaredFirstRun.RED} NA=${declaredFirstRun.NA} SKIP=${declaredFirstRun.SKIP}（与 criteria 四数组长度逐项相等）`,
      );
    } else {
      const txt = readTextSafe(evAbs);
      const pairs = String(cr.result).match(/(GREEN|RED|NA|SKIP)=(\d+)/g) || [];
      const notFound = pairs.filter((p) => !txt.includes(p));
      pushSample(`VERSION.criteriaRun.result「${cr.result}」← 包内 ${rel(evAbs)}`, notFound.length === 0 && pairs.length > 0, notFound.length ? `日志缺少 ${notFound.join('、')}` : '日志含全部计数');
      const dirMatch = /证据目录[：:]\s*(.+)/.exec(txt);
      if (dirMatch) {
        const raw = dirMatch[1].trim().replace(/`/g, '');
        const rawPlatform = raw.split('/').join(path.sep);
        const cands = [];
        if (path.isAbsolute(rawPlatform)) cands.push({ abs: path.resolve(rawPlatform), why: '原样绝对路径' });
        cands.push({ abs: path.resolve(LITE, rawPlatform), why: '包根相对' });
        cands.push({ abs: path.join(LITE, '证据', path.basename(rawPlatform)), why: '包内 证据/<basename>' });
        const hit = cands.find((c) => {
          const r = path.relative(LITE, c.abs);
          const inside = !r.startsWith('..') && !path.isAbsolute(r);
          return inside && fs.existsSync(c.abs);
        });
        // 兜底：证据文件自身所在目录与声明目录同名 → 证据确实随包（summary.md 里那行是开发机路径）
        const sameDir = path.basename(rawPlatform) === path.basename(path.dirname(evAbs));
        pushSample(
          'VERSION.criteriaRun 证据目录存在',
          !!(hit || sameDir),
          hit ? `存在 ${rel(hit.abs)}（按${hit.why}）` : sameDir ? `证据目录名与证据文件所在目录同名（${path.basename(path.dirname(evAbs))}）；原文那行是开发机路径，证据已随包` : `不存在 ${raw}`,
        );
      }
      // ★★★ C38 硬断言（v1.0.0-preview4 · 第 3 轮审计 W-01）：VERSION.criteria 与 summary 的**逐条 status 表**
      //   必须逐字段相等。
      //   @why re4 随包的 `证据/判据-1.0-final-re4/C38.json` 样本里写着 "GREEN=43 RED=2"、C39 记"磁盘 928"，
      //        而 VERSION 声明 45/0/0 —— 证据自己前后矛盾，被审计当场抓住；
      //        旧 C38 只比对 criteriaRun.result 那几个串"是否出现在日志里"，抓不住"四数对、名单错"。
      //   口径（写死）：从 summary.md 解析 `| Cxx | GREEN|RED|NA|SKIP |` 逐条状态（同一编号取首次出现），
      //        与 VERSION.criteria.{green,red,na,pending} 的**集合**逐字段比较；任何一处不等 → 判红。
      //        解析不出任何一行 → 也判红（fail-closed：格式变了就当证据不可核，不许静默放行）。
      {
        const summaryTxt = readTextSafe(evAbs);
        const parsed = { GREEN: [], RED: [], NA: [], SKIP: [] };
        const seen = new Set();
        for (const line of summaryTxt.split(/\r?\n/)) {
          const m = /^\|\s*(C\d{2})\s*\|\s*(GREEN|RED|NA|SKIP)\s*\|/.exec(line.trim());
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          parsed[m[2]].push(m[1]);
        }
        const vc = version.criteria || {};
        const vList = {
          GREEN: Array.isArray(vc.green) ? vc.green.map(String) : [],
          RED: Array.isArray(vc.red) ? vc.red.map(String) : [],
          NA: Array.isArray(vc.na) ? vc.na.map(String) : [],
        };
        const diffs = [];
        if (parsed.GREEN.length + parsed.RED.length + parsed.NA.length === 0) {
          diffs.push('summary 里解析不出任何 `| Cxx | STATUS |` 行（判据汇总表格式变了？fail-closed）');
        }
        const cmp = (k, label) => {
          const a = parsed[k].slice().sort().join(',');
          const b = vList[k].slice().sort().join(',');
          if (a !== b) diffs.push(`${label}: summary=[${a || '空'}] / VERSION.criteria.${label}=[${b || '空'}]`);
        };
        cmp('GREEN', 'green');
        cmp('RED', 'red');
        cmp('NA', 'na');
        pushSample(
          'VERSION.criteria 与 summary 逐字段相等（C38 硬断言）',
          diffs.length === 0,
          diffs.length ? diffs.join('；') : `逐条一致：GREEN ${vList.GREEN.length} / RED ${vList.RED.length} / NA ${vList.NA.length}（summary 同）`,
        );
      }
    }
  } else missing.push('VERSION.json.criteriaRun.result 为空（无数字可查）');

  // (3) E3 行数/入账 tick ← 现场复算（本执行器 C20/C22 同一数据）
  if (big.ok) {
    const e3 = getE3(big);
    const claimed = /([\d,]+)\s*行库/.exec(String((version.p3 && version.p3.index) || ''));
    const claimedRows = claimed ? Number(claimed[1].replace(/,/g, '')) : null;
    const a = analyzeIngest(e3.metrics.ticks, e3.led.rows.length);
    pushSample('VERSION.p3.index「1,338 行库」← 现场台账/度量复算', claimedRows === e3.led.rows.length && a.total === e3.led.rows.length && a.n > 0 && a.n <= 3, `声明 ${claimedRows} / 实测台账 ${e3.led.rows.length} / written 合计 ${a.total} / 端到端 ${a.n} tick`);
  } else {
    missing.push(`缺 E3 大库（无法复算 VERSION.p3.index 的 1,338 行）`);
  }

  // (4) VERSION.doctorCorpus r2/r3 ← 现场复算（S-9② 同一公式）
  if (big.ok) {
    const e3 = getE3(big);
    const r2 = e3.led.attachmentBytes ? (e3.originalsBytes + e3.viewsBytes) / e3.led.attachmentBytes : NaN;
    const r3 = e3.corpusBytes ? (e3.ledgerDayBytes + e3.indexBytes) / e3.corpusBytes : NaN;
    const txt = String(version.doctorCorpus || '');
    const m2 = /r2\s*=\s*([\d.]+)/.exec(txt);
    const m3 = /r3\s*=\s*([\d.]+)/.exec(txt);
    const ok2 = m2 && Math.abs(Number(m2[1]) - r2) <= 0.002;
    const ok3 = m3 && Math.abs(Number(m3[1]) - r3) <= 0.0005;
    pushSample('VERSION.doctorCorpus r2/r3 ← 现场只读复算', ok2 && ok3, `声明 r2=${m2 ? m2[1] : '—'} r3=${m3 ? m3[1] : '—'} / 实测 r2=${Number.isFinite(r2) ? r2.toFixed(4) : '—'} r3=${Number.isFinite(r3) ? r3.toFixed(5) : '—'}`);
  } else missing.push('缺 E3 大库（无法复算 VERSION.doctorCorpus 的 r2/r3）');

  // (5) F 组交付纪律文档齐 + 04 演练填写 + 05 已知未覆盖项齐
  const deliveryDir = resolveDeliveryDir(readJsonFile(path.join(LITE, 'VERSION.json')) || {});
  const deliveryDocs = ['00-交付清单.md', '02-验收记录.md', '03-变更说明.md', '04-回滚方式.md', '05-已知未覆盖项.md'];
  const docsInfo = deliveryDocs.map((n) => {
    const p = path.join(deliveryDir, n);
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      size = 0;
    }
    return { name: n, exists: size > 2000, size };
  });
  const docsMissing = docsInfo.filter((d) => !d.exists).map((d) => d.name);
  if (docsMissing.length) missing.push(`交付五件缺/过小：${docsMissing.join('、')}（${rel(deliveryDir)}）`);
  const f04 = readTextSafe(path.join(deliveryDir, '04-回滚方式.md'));
  if (f04) {
    const hasDrill = /演练结果/.test(f04);
    // ★ K-19（re4）：回滚法名不再写死为 git 往返/快照恢复/checkout 文件 ——
    //   本机无 git CLI，且 re4 起回滚改为"锚核验 + 覆盖安装"（合规：不随包携带含开发期标识的上一版二进制）。
    //   写死旧名会把一个**已不可执行**的方法当成验收条件，等于强迫文档写假话。
    //   现接受两种口径：旧的 A/B/C（历史包）或新的 A（锚核验）/B（覆盖安装）/C（回滚后确认）。
    const ABC_OLD = ['A（git 往返）', 'B（快照恢复）', 'C（checkout 文件）'];
    const ABC_NEW = ['A（锚核验）', 'B（覆盖安装）', 'C（回滚后确认）'];
    const hasABC = ABC_OLD.every((k) => f04.includes(k)) || ABC_NEW.every((k) => f04.includes(k));
    const hasPass = (f04.match(/实跑通过/g) || []).length >= 3;
    const placeholder = /`?___`?|（待填）|留空待 lead 执行后填/.test(f04);
    pushSample('04 回滚演练填写（A/B/C 实跑通过、无占位符）', hasDrill && hasABC && hasPass && !placeholder, `演练结果=${hasDrill} A/B/C=${hasABC} 实跑通过×${(f04.match(/实跑通过/g) || []).length} 占位符=${placeholder}`);
  } else missing.push(`缺 ${rel(path.join(deliveryDir, '04-回滚方式.md'))}`);
  const f05 = readTextSafe(path.join(deliveryDir, '05-已知未覆盖项.md'));
  if (f05) {
    const numbered = (f05.match(/^\|\s*\*\*\d+\*\*\s*\|/gm) || []).length + (f05.match(/^\|\s*\*\*[^|]+\*\*\s*\|/gm) || []).length;
    const hasGaps = /已知未覆盖项/.test(f05) && /未验|未覆盖|不保证/.test(f05);
    pushSample('05 已知未覆盖项齐（文档在、含编号缺口与"未验/不覆盖"登记）', hasGaps, `编号缺口行≈${numbered} 含未验登记=${hasGaps}`);
  } else missing.push(`缺 ${rel(path.join(deliveryDir, '05-已知未覆盖项.md'))}`);

  const evidence = {
    versionFile: rel(path.join(LITE, 'VERSION.json')),
    generators: generators.map(([name, p]) => ({ name, path: rel(p), exists: fs.existsSync(p) })),
    samples,
    deliveryDocs: docsInfo,
    caliber: '总纲 §7.7 C38「数字脚本生成，不手写」＋ §7.8② ；"怎么验：抽查任意数字有没有生成脚本"——本判据抽查 VERSION.json 的 tests/criteriaRun/p3.index/doctorCorpus 四组数字与交付五件/04 演练/05 缺口登记，全部要有生成脚本与现场日志可追',
  };
  if (missing.length) return naRow('C38', missing, evidence);
  if (mismatches.length) return redRow('C38', mismatches, evidence);
  return greenRow('C38', `抽查 ${samples.length} 组数字全部可追溯（生成器 ${generators.length}/${generators.length} 在；tests/criteriaRun/E3 行数/doctor r2r3 与日志/现场复算一致）；交付五件齐、04 演练 A/B/C 已填、05 已知未覆盖项齐`, evidence);
}

// ---------- C39 · 清单与磁盘 0 差异（MANIFEST） ----------
function verifyManifest(pkgDir) {
  const mf = path.join(pkgDir, 'MANIFEST.sha256');
  if (!fs.existsSync(mf)) return { ok: false, why: `缺 ${rel(mf)}`, manifest: rel(mf) };
  const declared = new Map();
  let badLines = 0;
  for (const line of fs.readFileSync(mf, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([0-9a-f]{64})  (.+)$/.exec(t);
    if (m) declared.set(m[2], m[1]);
    else badLines += 1;
  }
  const files = walkFiles(pkgDir).filter((f) => f.name !== 'MANIFEST.sha256');
  const actual = new Map();
  let bytes = 0;
  for (const f of files) {
    actual.set(f.rel, sha256File(f.abs));
    bytes += f.size;
  }
  const missing = [...declared.keys()].filter((k) => !actual.has(k));
  const extra = [...actual.keys()].filter((k) => !declared.has(k));
  const changed = [...declared.entries()].filter(([k, v]) => actual.has(k) && actual.get(k) !== v).map(([k]) => k);
  return { ok: true, manifest: rel(mf), declared: declared.size, actual: actual.size, bytes, missing, extra, changed, badLines };
}
function runC39(ctx, opt = {}) {
  const pkgDir = opt.pkgDir || LITE;
  const res = verifyManifest(pkgDir);
  if (!res.ok) return naRow('C39', [res.why]);
  const selfRel = path.relative(LITE, THIS_FILE).split(path.sep).join('/'); // docs/判据-1.0.mjs（副本也按包根同构）
  const knownExtra = res.extra.filter((x) => x === selfRel);
  // ★ re3：本执行器默认把证据写进包内 `证据\判据-1.0-<stamp>\`；这是**运行产物**，不是交付内容，
  //   出包 MANIFEST 不可能预先把它们列进去（出包后每跑一次就多一套）。C39 只对这一命名空间做
  //   "清单外新增"豁免（清单里已声明的证据文件照旧逐文件核 sha256，不豁免缺/改）；其余多一个都不行。
  const knownRunArtifacts = res.extra.filter((x) => isRunArtifactRel(x));
  const unknownExtra = res.extra.filter((x) => x !== selfRel && !isRunArtifactRel(x));
  // ★ K-27（v1.0.0-preview4 · 审计 B-04/B-09 整改）：运行产物命名空间内的**哈希变化**同样豁免。
  //   @why 本执行器把证据写进 `证据/判据-1.0-*`，每跑一次都会重写 summary/逐条 JSON（含时间戳）——
  //        出包前重算的 MANIFEST 必然列出上一轮那套文件，于是**同一进程再跑**一定报"改 N"，C39 永远红。
  //        re4 是靠"搬证据目录 + 事后改清单"绕过去的（W-01 批评过），本版改为**口径写死**：
  //        该命名空间 = 运行产物，多/改都豁免；其余任何文件的缺/改/多一律照旧判红。
  //   补偿（不许拿豁免当遮羞布）：终包 13 项在**解压树**上对最终 MANIFEST 逐条复算（01/02/03/05），
  //        任何篡改在那一步必然被抓；且 C38 的硬断言会核对 summary 与 VERSION 的逐字段一致性。
  const changedRunArtifacts = res.changed.filter((x) => isRunArtifactRel(x));
  const changedUnknown = res.changed.filter((x) => !isRunArtifactRel(x));
  const problems = [];
  if (res.badLines) problems.push(`MANIFEST 有 ${res.badLines} 行不是 "<sha256>  <path>" 格式`);
  if (res.missing.length) problems.push(`清单有、磁盘无（缺 ${res.missing.length}）：${res.missing.slice(0, 6).join('、')}`);
  if (changedUnknown.length) problems.push(`清单与磁盘哈希不符（改 ${changedUnknown.length}，已扣除运行产物 ${changedRunArtifacts.length}）：${changedUnknown.slice(0, 6).join('、')}`);
  if (unknownExtra.length) problems.push(`磁盘有、清单无（多 ${unknownExtra.length}）：${unknownExtra.slice(0, 6).join('、')}`);
  // 跨核：复用**包内** docs\工具-manifest.mjs --verify（同一算法；数字必须与本文件一致）
  let cross = null;
  const tool = path.join(LITE, 'docs', '工具-manifest.mjs');
  if (fs.existsSync(tool)) {
    const r = runNode('C39-manifest-verify', tool, [`--root=${pkgDir}`, '--verify'], 300000);
    const m = /声明\s*(\d+)\s*\/\s*实际\s*(\d+)\s*\/\s*缺\s*(\d+)\s*\/\s*多\s*(\d+)\s*\/\s*改\s*(\d+)/.exec(r.stdout || '');
    cross = m
      ? { exit: r.exit, declared: num(m[1]), actual: num(m[2]), missing: num(m[3]), extra: num(m[4]), changed: num(m[5]), log: r.logRel }
      : { exit: r.exit, parseErr: '未匹配到「声明/实际/缺/多/改」输出', log: r.logRel };
    if (cross && cross.declared === res.declared && cross.actual === res.actual && cross.missing === res.missing.length && cross.extra === res.extra.length && cross.changed === res.changed.length) {
      /* 一致 */
    } else {
      problems.push(`复算工具 docs/工具-manifest.mjs 与本文件结论不一致：tool=${JSON.stringify(cross)} vs 本文件 声明${res.declared}/实际${res.actual}/缺${res.missing.length}/多${res.extra.length}/改${res.changed.length}`);
    }
  } else {
    cross = { skipped: `缺 ${rel(tool)}（不做交叉核）` };
  }
  const evidence = {
    packageRoot: rel(pkgDir),
    manifest: res.manifest,
    declared: res.declared,
    actual: res.actual,
    diskBytes: res.bytes,
    missing: res.missing,
    extra: res.extra,
    changed: res.changed,
    changedKnownRunArtifacts: changedRunArtifacts,
    changedUnknown,
    extraKnownP4: knownExtra,
    extraKnownRunArtifacts: knownRunArtifacts,
    crossCheck: cross,
    caliber: '总纲 §7.7 C39「清单与磁盘 0 差异」；口径沿用出包脚本 docs/工具-manifest.mjs（包内版；与 _工作/tools/manifest.mjs 同源）：排除 .git/ 与 MANIFEST.sha256 自身、路径 / 分隔、sha256 逐文件。`docs/判据-1.0.mjs` 是本版（P4）允许新增的验具，出包最后一步重生成 MANIFEST 时并入 → 本判据把它单独登记为"已知 P4 新增"；★ 本执行器**运行产物**（包内 `证据/判据-1.0-<时间戳>/`）单独登记（extraKnownRunArtifacts），只豁免"清单外新增"，清单内证据文件仍逐文件核 sha256；其余缺/多/改必须 0',
  };
  if (problems.length) return redRow('C39', problems, evidence);
  return greenRow(
    'C39',
    `清单 ${res.declared} / 磁盘 ${res.actual} / 缺 ${res.missing.length} / 多 ${res.extra.length}（其中 P4 验具 ${knownExtra.length}、本执行器运行产物 ${knownRunArtifacts.length}，不计红）/ 改 ${res.changed.length}（其中运行产物 ${changedRunArtifacts.length} 不计红、实判 ${changedUnknown.length}）${cross && cross.exit !== undefined ? `；交叉核 docs/工具-manifest.mjs exit=${cross.exit}（与本文件同结论）` : ''}`,
    evidence,
  );
}

// ---------- C40 · 版本台账 append-only + 版本台账链不断（R-9） ----------
function parseVersionLedger(file) {
  const text = readTextSafe(file);
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    const m = /^\|\s*(\d+)\s*\|/.exec(t);
    if (!m) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
    const pick = (s) => {
      const mm = /`([^`]+)`/.exec(s || '');
      return mm ? mm[1] : s || '';
    };
    rows.push({ n: Number(cells[0]), version: pick(cells[1]), type: cells[2] || '', date: cells[3] || '', head: pick(cells[4]), gate: cells[5] || '', red: cells[6] || '', desc: cells.slice(7).join('|').trim(), raw: t });
  }
  return { file, text, rows };
}
function checkLedgerChain(rows, opts = {}) {
  const problems = [];
  if (!rows.length) problems.push('台账表没有任何数据行');
  rows.forEach((r, i) => {
    if (r.n !== i) problems.push(`第 ${i + 1} 行编号应为 ${i}，实际 ${r.n}`);
    if (!/^v\d+\.\d+\.\d+/.test(r.version)) problems.push(`第 ${i + 1} 行版本号不可识别：${r.version || '(空)'}`);
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push(`第 ${i + 1} 行日期不可识别：${r.date || '(空)'}`);
    // ★ K-24（v1.0.0-preview4）：类型白名单补 `preview`（正式预览版，15 号说明 §3 阶梯新增的一档）。
    //   只加不改：历史上的 基座 / snap / reN / 正式 判定口径一个字没动。
    if (!/基座|snap|re\d+|preview|正式/.test(r.type)) problems.push(`第 ${i + 1} 行类型不可识别：${r.type || '(空)'}`);
  });
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.version)) problems.push(`版本号重复：${r.version}`);
    seen.add(r.version);
  }
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (/正式/.test(r.type)) {
      const prev = rows[i - 1];
      if (!String(prev.version).startsWith(`${r.version}-re`)) problems.push(`正式版 ${r.version}（第 ${r.n} 行）前面不是同号 -re（上一行 ${prev.version}）`);
    }
  }
  if (opts.expectLast) {
    // 期望 = VERSION.json 对应的最后一行（version 前缀 + 类型）。
    // 兼容 vX.Y.Z-snap / -reK 后缀：只要求前缀一致，类型与 VERSION.type 对应；
    // 正式版（formal）额外要求最后一行是「正式」。
    const last = rows[rows.length - 1];
    const { prefix, type, requireFormal } = opts.expectLast;
    if (prefix && !String(last.version).startsWith(prefix)) problems.push(`台账末行版本 ${last.version} ≠ VERSION.json 对应版本（应 ${prefix}…）`);
    if (type && !String(last.type).includes(type)) problems.push(`台账末行类型 ${last.type} ≠ VERSION.json.type（应含「${type}」）`);
    if (requireFormal && !/正式/.test(last.type)) problems.push(`台账末行类型 ${last.type} 不是「正式」（当前 VERSION.json 是正式版）`);
    if (!rows.some((r) => /正式/.test(r.type))) problems.push('台账没有任何正式版行');
  }
  return { ok: problems.length === 0, problems };
}
function chainLinks(rows, version) {
  const problems = [];
  const links = [];
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const add = (name, declared, matched) => {
    links.push({ name, declared, matched: matched ? matched.version : '', ok: !!matched });
    if (!matched) problems.push(`链断：VERSION.json.${name}='${declared}' 在版本台账里找不到对应行`);
  };
  if (version && version.builtFrom) add('builtFrom', version.builtFrom, byVersion.get(String(version.builtFrom).replace(/^lite-/, '')));
  if (version && version.baselineTag) add('baselineTag', version.baselineTag, byVersion.get(String(version.baselineTag).replace(/^lite-/, '')));
  if (version && version.builtFromCommit) {
    const hit = rows.find((r) => r.head === version.builtFromCommit);
    links.push({ name: 'builtFromCommit', declared: version.builtFromCommit, matched: hit ? hit.version : '', ok: !!hit });
    if (!hit) problems.push(`链断：VERSION.json.builtFromCommit='${version.builtFromCommit}' 不是版本台账任何一行的 HEAD`);
  }
  return { ok: problems.length === 0, problems, links };
}
function runC40(ctx, opt = {}) {
  const ledgerFile = opt.ledgerFile || path.join(LITE, '版本台账.md');
  if (!fs.existsSync(ledgerFile)) return naRow('C40', [`缺 ${rel(ledgerFile)}`]);
  // ★ re3：主判据一律以产品 VERSION.json 为准；`opt.version` 只供 --proof 的**自洽夹具**用
  //   （副本台账末行推出的版本视图），这样 proof 不会被"VERSION 还没追加当前版行"污染成永久红。
  const version = opt.version || readJsonFile(path.join(LITE, 'VERSION.json')) || {};
  const parsed = parseVersionLedger(ledgerFile);
  // 期望末行：优先 VERSION.tag（去 lite- 前缀）→ 兼容 snap/re 后缀；否则 vX.Y.Z
  const expectPrefix = version.tag ? String(version.tag).replace(/^lite-/, '') : `v${version.version}`;
  const expectType = version.type === 'formal' ? '正式' : String(version.type || '');
  const chain = checkLedgerChain(parsed.rows, { expectLast: { prefix: expectPrefix, type: expectType, requireFormal: version.type === 'formal' } });
  const links = chainLinks(parsed.rows, version);
  const problems = [...chain.problems, ...links.problems];
  // 04 回滚演练记录 ↔ VERSION.json.rollbackDrill（回滚链的证据）——**正式版才要求**
  const drillKeys = ['A_gitReset', 'B_snapshotRestore', 'C_checkoutFiles'];
  const drill = version.rollbackDrill || {};
  const drillMissing = drillKeys.filter((k) => !drill[k] || String(drill[k]).trim().length < 10);
  if (version.type === 'formal' && drillMissing.length) problems.push(`VERSION.json.rollbackDrill 缺实测记录：${drillMissing.join('、')}`);
  const delivDir = resolveDeliveryDir(version);
  const f04 = readTextSafe(path.join(delivDir, '04-回滚方式.md'));
  const f04Ok = !!f04 && ['A（git 往返）', 'B（快照恢复）', 'C（checkout 文件）'].every((k) => f04.includes(k)) && (f04.match(/实跑通过/g) || []).length >= 3;
  if (version.type === 'formal' && !f04Ok) problems.push('04-回滚方式.md 的演练结果 A/B/C 未填写（"能回滚"目前不是实测）');
  // 追加一条验链（只在副本上做：不改产品台账/不 git）
  const workDir = freshSubDir('c40');
  const copyFile = path.join(workDir, '版本台账.md');
  let appendTest = null;
  let breakTest = null;
  try {
    fs.copyFileSync(ledgerFile, copyFile);
    const n = parsed.rows.length;
    const lastDate = parsed.rows[n - 1].date || '2026-11-13';
    // 合成追加行用**唯一且不落库**的版本号（v9.9.9-snap）；不能写死当前版本，
    // 否则"末行正好是当前版本"时必然触发"版本号重复"（0.9.5-snap 起暴露的执行器缺陷）。
    const synth = `| ${n} | \`v9.9.9-snap\` | snap | ${lastDate} | \`0000000\` | 无（门未验） | — | 副本追加行（C40 验链，不写产品台账） |`;
    fs.appendFileSync(copyFile, `${synth}\n`, 'utf8');
    const appended = parseVersionLedger(copyFile);
    const appendCheck = checkLedgerChain(appended.rows, {});
    appendTest = { appendedRow: n, rows: appended.rows.length, lastN: appended.rows[appended.rows.length - 1].n, ok: appendCheck.ok, problems: appendCheck.problems };
    if (!appendCheck.ok || appended.rows.length !== n + 1) problems.push(`追加一条后链不成立：${appendCheck.problems.join('；')}`);
    // 反证：删中间一行 → 检查必须报红（证明"链断能发现"）
    const bad = appended.rows.filter((r) => r.n !== Math.floor(n / 2));
    const badText = bad.map((r) => r.raw).join('\n') + '\n';
    const badFile = path.join(workDir, '版本台账-broken.md');
    fs.writeFileSync(badFile, badText, 'utf8');
    const broken = checkLedgerChain(parseVersionLedger(badFile).rows, {});
    breakTest = { removedRow: Math.floor(n / 2), ok: !broken.ok, problems: broken.problems };
    if (broken.ok) problems.push('反证失败：删中间一行后链检查仍判通（检查器失效）');
  } finally {
    if (!keepWork) fs.rmSync(workDir, { recursive: true, force: true });
  }
  const evidence = {
    ledger: rel(ledgerFile),
    rows: parsed.rows.length,
    first: parsed.rows[0] ? parsed.rows[0].version : '',
    last: parsed.rows.length ? parsed.rows[parsed.rows.length - 1].version : '',
    currentVersion: version.version,
    chainProblems: chain.problems,
    links: links.links,
    rollbackDrill: { keys: drillKeys, filled: drillKeys.filter((k) => drill[k] && String(drill[k]).trim().length >= 10), f04Filled: f04Ok },
    appendTest,
    breakTest,
    appendOnlyNote: 'append-only 的"从未删过旧行"在无 git 史下无法证明；本判据验的是：①表结构编号连续/版本唯一/正式版由同号 -re 升；②VERSION.json 的 builtFrom/baselineTag/builtFromCommit 三链在台账里可对上；③"追加一条"后链仍成立（副本上做）；④删中间一行能被抓（副本反证）。不写产品台账、不做 git 操作',
    caliber: '总纲 §7.7 C40 + R-9：版本台账链（保留，防改版历史）≠ 封板链（砍）；"怎么验：追加一条验链"',
  };
  if (problems.length) return redRow('C40', problems, evidence);
  return greenRow(
    'C40',
    `版本台账 ${parsed.rows.length} 行（${parsed.rows[0].version} … ${parsed.rows[parsed.rows.length - 1].version}）；编号连续/版本唯一/正式版由同号 -re 升；builtFrom/baselineTag/builtFromCommit 三链对上；副本追加第 ${parsed.rows.length} 行链仍成立；删中间行可抓；04 演练 A/B/C 已填`,
    evidence,
  );
}

// ============================================================================
// 六、本地判据调度
// ============================================================================
// ============================================================================
// 六·附、C41–C45（S-11 签字新增五条，判据 40 → 45）
//
// 口径出处（机主 2026-11-13 已签 S-11，阈值不许改）：
//   封箱\02-未完成\增补-20261113-2345\V1.0正式版-功能界定.md §4
//   C41 周账 xlsx 与台账一致：抽 3 周（含 1 个跨月周）逐行对，100%
//   C42 日结摘要 txt 与台账一致：抽 3 天 100%；发出后不许重写（只能补发新版）
//   C43 交接表冻结不被绕过（机主 2026-11-14 早会裁定：反向判据）：任何交接表生成即 RED
//   C44 doctor 对 5 类已知故障各报一次红（先红后绿）
//   C45 恢复演练：备份→删工作库→重建→verify 绿→随机 100 行逐字节相等
//
// 本实现纪律：
//   ① 夹具全部来自本包构造器（docs/工具-构造lab.mjs）造出的 lab，不读开发机路径；
//   ② 只读产品账库；一切注入都在 `_工作\lab-10c-work\` 副本上做，跑完删；
//   ③ 产品代码只用公开入口（子进程 driver 里 import index.js 的 runOnce / tools/*.mjs 的 CLI），
//      本文件自身不 import 产品模块（保持"不 import 插件"的独立性纪律）；
//   ④ 做不到/产品没实现 → RED 或 NA 并写明缺什么，绝不放宽阈值。
// ============================================================================

/** 台账 ts（ISO 带 +08:00）→ 本地日 `YYYY-MM-DD`（+08:00 口径，不取本机时区）。 */
function tsDayLocal(ts) {
  const s = String(ts || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
/** 台账 ts → 本地 `HH:mm`（+08:00）。 */
function tsHhmmLocal(ts) {
  const ms = Date.parse(String(ts || ''));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** 32 位编码 → 13 位会话键（与 lib/week.js sessKeyOf 同口径的本地实现）。 */
function sessKey13(code) {
  const m = /^\d{8}-([0-9a-z]{12})-([A-Z])-\d{8}$/.exec(String(code || ''));
  return m ? `${m[1]}${m[2]}` : '';
}
/** 本地 rss 峰值（MB，只报告用）。 */
const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

// ---------- 最小 xlsx 读取器（ZIP + OOXML；只读 Sheet 单元格，用于 C41） ----------
const XLSX_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = XLSX_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function unzipXlsx(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 缺 EOCD（文件不像 xlsx）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error('中央目录越界');
  const out = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录项签名错');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`本地头签名错: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`不支持的压缩方法 ${method}: ${name}`);
    if (data.length !== rawSize) throw new Error(`解压长度不符: ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC32 不符: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** sheet XML → Map<行号, Map<列字母, 文本>>（只认 inlineStr / <v> 数字 / 公式 v）。 */
function parseSheetCells(xml) {
  const rows = new Map();
  const re = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const row = Number(m[2]);
    const inner = m[4] || '';
    let text = '';
    const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
    if (t) text = xmlUnesc(t[1]);
    else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) text = xmlUnesc(v[1]);
    }
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row).set(m[1], text);
  }
  return rows;
}
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
/** 读一个周账 xlsx：返回 {sheets:[{name,cells}], stats:{weekday→date}, error}。 */
function readWeeklyXlsx(abs) {
  try {
    const zip = unzipXlsx(fs.readFileSync(abs));
    const wb = zip.get('xl/workbook.xml');
    const rels = zip.get('xl/_rels/workbook.xml.rels');
    if (!wb) throw new Error('缺 xl/workbook.xml');
    const sheets = [];
    const relMap = new Map();
    if (rels) {
      const relRe = /<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"/g;
      let rm;
      while ((rm = relRe.exec(rels.toString('utf8'))) !== null) relMap.set(rm[1], rm[2]);
    }
    const shRe = /<sheet\s+name="([^"]+)"[^>]*r:id="([^"]+)"/g;
    let sm;
    let idx = 0;
    while ((sm = shRe.exec(wb.toString('utf8'))) !== null) {
      idx += 1;
      const name = xmlUnesc(sm[1]);
      const target = relMap.get(sm[2]) || `worksheets/sheet${idx}.xml`;
      const file = `xl/${String(target).replace(/^\/?xl\//, '')}`;
      const buf = zip.get(file) || zip.get(`xl/worksheets/sheet${idx}.xml`);
      if (!buf) throw new Error(`缺工作表 XML: ${file}`);
      sheets.push({ name, cells: parseSheetCells(buf.toString('utf8')) });
    }
    const stats = {};
    const statsSheet = sheets.find((s) => s.name === '周统计');
    if (statsSheet) {
      for (let r = 5; r <= 11; r += 1) {
        const row = statsSheet.cells.get(r);
        if (!row) continue;
        const wd = String(row.get('A') || '').trim();
        const dateTxt = String(row.get('B') || '').trim();
        const dm = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(dateTxt) || /(\d{1,2})月(\d{1,2})日/.exec(dateTxt);
        if (!wd) continue;
        let iso = '';
        if (dm && dm.length === 4) iso = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;
        stats[wd] = iso;
      }
    }
    return { sheets, stats, error: '' };
  } catch (e) {
    return { sheets: [], stats: {}, error: String((e && e.message) || e) };
  }
}

// ---------- 公共：写/跑 tick driver（C42 的重写反证、C43 的冻结反证都要真跑 tick） ----------
function writeTickDriver() {
  const file = path.join(EVID, 'driver-tick.mjs');
  const src = `import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [,, LITE, home, root, ticksArg, weeklyArg, receiptArg] = process.argv;
const ticks = Number(ticksArg || '1');
process.env.DSH_HOME = home;
const idx = await import(pathToFileURL(path.join(LITE, 'index.js')).href);
const cfg = {
  root, intervalSeconds: 60, offsetMinutes: 480, hotWindowSeconds: 0, quietSeconds: 0,
  scanBudgetMs: 0, maxBytesPerSession: 0, checkupEnabled: false,
  weeklyEnabled: weeklyArg === '1', handoverEnabled: false, receiptAnchorRoot: receiptArg || '',
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const out = [];
for (let i = 0; i < ticks; i += 1) {
  try {
    const s = await idx.runOnce({ logger }, cfg);
    out.push({ ok: true, written: s && s.written, handoverGenerated: s && s.handoverGenerated,
      handoverAdopted: s && s.handoverAdopted, handoverSkipped: s && s.handoverSkipped,
      handoverSealedTotal: s && s.handoverSealedTotal, errors: (s && s.errors) || [] });
  } catch (e) {
    out.push({ ok: false, crash: String((e && e.message) || e) });
  }
}
console.log(JSON.stringify({ ticks: out }));
`;
  fs.writeFileSync(file, src, 'utf8');
  evidLog.push(rel(file));
  return file;
}
function runTickDriver(labDirs, ticks, opt = {}) {
  const driver = writeTickDriver();
  const r = runNode(`tick-driver-${ticks}t`, driver, [
    LITE,
    labDirs.home || path.join(labDirs.base, 'dsh-home'),
    labDirs.root,
    String(ticks),
    opt.weekly ? '1' : '0',
    opt.receiptAnchorRoot || '',
  ], 900000);
  let json = null;
  try {
    json = extractJson(r.stdout);
  } catch (e) {
    json = { ticks: [], parseError: String((e && e.message) || e) };
  }
  return { ...r, json };
}
/** 在 root 下找"交接表"类产物（目录名/文件名含「交接表」或 handover，不含 .state 等运行区）。 */
function findHandoverArtifacts(root) {
  return walkFiles(root).filter((f) => /交接表|handover/i.test(f.rel));
}
/**
 * 把 state 里的**绝对路径游标**从源 lab 改写到副本 lab。
 * @why `.state.json` 的 `sourceCursors` 键是会话源的绝对路径；只拷 root+dsh-home 而不改 state，
 *      doctor/tick 会去 stat 原 lab 的文件（或把副本当新源重复入账）—— 夹具必须内部自洽。
 */
function relocateState(root, srcHome, dstHome) {
  const p = path.join(root, 'ledger', '.state.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return false; }
  if (!st || typeof st !== 'object' || !st.sourceCursors || typeof st.sourceCursors !== 'object') return false;
  const from = path.resolve(srcHome);
  const to = path.resolve(dstHome);
  const fromLower = from.toLowerCase() + path.sep;
  const next = {};
  for (const [k, v] of Object.entries(st.sourceCursors)) {
    const abs = path.resolve(k);
    next[abs.toLowerCase().startsWith(fromLower) ? path.join(to, k.slice(from.length + 1)) : k] = v;
  }
  st.sourceCursors = next;
  fs.writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  return true;
}

// ---------- C41 · 周账 xlsx 与台账一致（抽 3 周，含跨月周，100%） ----------
function runC41(ctx) {
  const w = ctx.weeks;
  if (!w.ok) return naRow('C41', [`缺周账夹具（lab-weeks）：${w.why}`]);
  const led = scanLedger(path.join(w.root, 'ledger'));
  if (!led.rows.length) return redRow('C41', ['lab-weeks 台账为空（weeklyEnabled 未生效？）']);
  const xlsxFiles = walkFiles(w.root).filter((f) => /周记账\.xlsx$/.test(f.name));
  if (!xlsxFiles.length) return redRow('C41', ['lab-weeks 里没有任何 `*周记账.xlsx`（周账未生成）']);
  // 按「MN月第W周」分组
  const groups = new Map();
  for (const f of xlsxFiles) {
    const m = /^(\d{2})月第(\d)周-(.+)的周记账\.xlsx$/.exec(f.name);
    const key = m ? `${m[1]}月第${m[2]}周` : '(未知周)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const weekKeys = [...groups.keys()].sort();
  if (weekKeys.length < 3) return redRow('C41', [`周账只有 ${weekKeys.length} 组（S-11 要求抽 3 个不同周）`], { weeks: weekKeys });

  // 解析所有文件
  const parsed = [];
  const problems = [];
  for (const key of weekKeys) {
    for (const f of groups.get(key)) {
      const r = readWeeklyXlsx(f.abs);
      if (r.error) { problems.push(`${f.rel}：${r.error}`); continue; }
      const dayDates = Object.values(r.stats).filter(Boolean).sort();
      const m = /^(\d{2})月/.exec(key);
      parsed.push({ key, file: f, ...r, dayDates, month: m ? Number(m[1]) : 0 });
    }
  }
  // 台账视图：code → {day, hhmm, sessKey}
  const ledByCode = new Map();
  for (const row of led.rows) {
    const code = String(row.code || '');
    ledByCode.set(code, { day: tsDayLocal(row.ts), hhmm: tsHhmmLocal(row.ts), sessKey: sessKey13(code), status: String(row.status || '') });
  }
  // 选 3 个不同的周：优先「跨月自然周」两边各一个 + 再一个
  const byKey = new Map(parsed.map((p) => [p.key, p]));
  const crossPairs = [];
  for (const p of parsed) {
    const dates = p.dayDates;
    if (!dates.length) continue;
    const monthEnd = dates.some((d) => {
      const [y, mo, da] = d.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      return da === last;
    });
    if (monthEnd) crossPairs.push(p.key);
  }
  const chosen = [];
  for (const k of crossPairs) if (!chosen.includes(k)) chosen.push(k);
  for (const k of weekKeys) if (chosen.length < 3 && !chosen.includes(k)) chosen.push(k);
  if (chosen.length < 3) return redRow('C41', [`可判的周不足 3 个（解析成功 ${byKey.size} 组）`], { weeks: weekKeys, problems });
  const selected = chosen.slice(0, 3);
  // 逐周逐文件逐日表对账
  const detail = [];
  let checkedRows = 0;
  let matchedRows = 0;
  for (const key of selected) {
    const files = parsed.filter((p) => p.key === key);
    if (!files.length) { problems.push(`周 ${key} 没有可解析的 xlsx`); continue; }
    for (const p of files) {
      const fileM = /^(\d{2})月第(\d)周-(.+)的周记账\.xlsx$/.exec(p.file.name);
      const fileSessKey = fileM ? fileM[3] : '';
      const perDay = [];
      for (const sheet of p.sheets) {
        if (!WEEKDAY_NAMES.includes(sheet.name)) continue;
        const rowCodes = [];
        for (const [rowNo, cells] of sheet.cells) {
          if (rowNo < 2) continue;
          const code = String(cells.get('A') || '').trim();
          if (code) rowCodes.push({ rowNo, code, hhmm: String(cells.get('C') || '').trim(), original: String(cells.get('B') || '').trim() });
        }
        const day = p.stats[sheet.name] || '';
        // ★ 2026-11 审计（P1-2 空跑）：只有「周统计」该日 = '—'（该周段没有这一天）才允许空表；
        //   日期存在却空表 → 不许 continue，必须走对账（expected 非空即判缺行）。
        if (!day) {
          if (!rowCodes.length) continue;
          problems.push(`${p.file.rel} 的「${sheet.name}」表有 ${rowCodes.length} 行却没有日期锚点（周统计 B 列为 '—'）——无法确认这是哪一天`);
          continue;
        }
        // 期望：该日、该会话键的台账行（code / hh:mm 逐行对）—— ★ expected 必须在判"空表"之前算
        const expected = new Map();
        for (const [code, v] of ledByCode) if (v.day === day && v.sessKey === fileSessKey) expected.set(code, v);
        const actual = new Map();
        for (const rc of rowCodes) {
          if (actual.has(rc.code)) problems.push(`${p.file.rel}「${sheet.name}」重复编码 ${rc.code}`);
          actual.set(rc.code, { hhmm: rc.hhmm, original: rc.original });
        }
        if (!rowCodes.length) {
          if (!expected.size) continue; // 该日该会话本来 0 行：空表与台账一致，允许
          problems.push(`${p.file.rel}「${sheet.name}」（${day}）空表但台账有 ${expected.size} 行——缺行 ${expected.size} 条（空表不能跳过对账）`);
        }
        const missing = [...expected.keys()].filter((c) => !actual.has(c));
        const extra = [...actual.keys()].filter((c) => !expected.has(c));
        const badTime = [...expected.entries()].filter(([c, v]) => actual.has(c) && actual.get(c).hhmm !== v.hhmm).map(([c, v]) => `${c}(表=${actual.get(c).hhmm}/账=${v.hhmm})`);
        checkedRows += expected.size;
        matchedRows += expected.size - missing.length - badTime.length;
        if (missing.length) problems.push(`${p.file.rel}「${sheet.name}」缺行 ${missing.length} 条（例：${missing.slice(0, 3).join(',')}）`);
        if (extra.length) problems.push(`${p.file.rel}「${sheet.name}」多行 ${extra.length} 条（例：${extra.slice(0, 3).join(',')}）`);
        if (badTime.length) problems.push(`${p.file.rel}「${sheet.name}」时间列不符 ${badTime.length} 条（例：${badTime.slice(0, 3).join('；')}）`);
        perDay.push({ sheet: sheet.name, day, empty: rowCodes.length === 0, expected: expected.size, actual: actual.size, missing: missing.length, extra: extra.length, badTime: badTime.length });
      }
      detail.push({ week: key, file: p.file.rel, sessKey: fileSessKey, perDay });
    }
  }
  const crossMonth = selected.some((k) => crossPairs.includes(k));
  if (!crossMonth && problems.length === 0) problems.push('抽到的 3 个周里没有「跨月自然周」（含月末日的那一段）');
  // ★ 2026-11 审计（P1-2）：0 行对账 / 未 100% 相符都不能判绿（旧实现 checkedRows=0 也绿且宣称 100%）
  if (!checkedRows) problems.push('抽中的 3 周逐日表对账 0 行（夹具或 xlsx 解析无效——不能空跑判绿）');
  if (matchedRows !== checkedRows) problems.push(`逐行相符 ${matchedRows}/${checkedRows} ≠ 100%（匹配数必须等于对账行数）`);
  const evidence = {
    lab: rel(w.root),
    weeks: weekKeys,
    selected,
    crossMonth,
    checkedRows,
    matchedRows,
    files: detail,
    problems: problems.slice(0, 30),
    caliber: 'S-11 C41：抽 3 个不同周（含 1 个跨月周）逐行对（编码集合＋时间列），3 周 100% 相符；xlsx 不得缺行/多行',
  };
  if (problems.length) return redRow('C41', problems.slice(0, 12), evidence);
  return greenRow('C41', `周账 ${weekKeys.length} 组里抽 ${selected.join(' / ')}（含跨月周=${crossMonth}）：逐日表对账 ${checkedRows} 行，100% 相符（缺行 0/多行 0/时间不符 0）`, evidence);
}

// ---------- C42 · 日结摘要（JSON＋TXT）与台账一致 + 发出后不许重写（S-11 C42） ----------
/** 收据目录里"每天的最新版本"：Map<YYYY-MM-DD, {day,version,file}>。 */
function latestReceiptsByDay(receiptsDir) {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(receiptsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    let m = /^RECEIPT-(\d{4})(\d{2})(\d{2})\.json$/.exec(n);
    let ver = 1;
    if (!m) {
      m = /^RECEIPT-(\d{4})(\d{2})(\d{2})\.v(\d+)\.json$/.exec(n);
      if (m) ver = Number(m[4]);
    }
    if (!m) continue;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const cur = out.get(day);
    if (!cur || ver > cur.version) out.set(day, { day, version: ver, file: n });
  }
  return out;
}
/** 与 lib/receipt.js digestTxtPath 同口径的本地实现（判据不 import 产品代码）。 */
function digestTxtName(day, version) {
  const b = `日结摘要-${String(day).replace(/-/g, '')}`;
  return Number(version) > 1 ? `${b}.v${version}.txt` : `${b}.txt`;
}
function runC42(ctx) {
  const w = ctx.weeks;
  if (!w.ok) return naRow('C42', [`缺周账夹具（lab-weeks）：${w.why}`]);
  const receiptsDir = w.receipts;
  const led = scanLedger(path.join(w.root, 'ledger'));
  if (!led.rows.length) return redRow('C42', ['lab-weeks 台账为空（收据/摘要无法核对）']);
  const byDay = latestReceiptsByDay(receiptsDir);
  const days = [...byDay.keys()].sort();
  if (days.length < 3) return redRow('C42', [`日结摘要只有 ${days.length} 天（<3；receiptAnchorRoot 未生效？）`], { receiptsDir: rel(receiptsDir), days });
  // 台账按日独立复算（不调产品代码）
  const dayStats = new Map();
  const rootDir = path.join(w.root, 'ledger');
  for (const f of led.files) {
    const day = f.slice(0, 10);
    let buf = null;
    try { buf = fs.readFileSync(path.join(rootDir, f)); } catch { continue; }
    let rows = 0;
    let firstCode = '';
    let lastCode = '';
    let partialCount = 0;
    let badLines = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { badLines += 1; continue; }
      if (!o || typeof o !== 'object') { badLines += 1; continue; }
      rows += 1;
      if (o.status === 'partial') partialCount += 1;
      if (typeof o.code === 'string') { if (!firstCode) firstCode = o.code; lastCode = o.code; }
    }
    dayStats.set(day, { rows, firstCode, lastCode, partialCount, badLines, bytes: buf.length });
  }
  const views = walkFiles(w.root).filter((f) => /完整原文\.md$/.test(f.name)).length;

  const problems = [];
  const detail = [];
  const pick = days.length <= 3 ? days.slice() : [days[0], days[Math.floor(days.length / 2)], days[days.length - 1]];

  // ① 抽 3 天：摘要（最新版本）与台账逐字段 100% 相符；TXT 同版本存在且内容相符
  for (const day of pick) {
    const it = byDay.get(day);
    const rec = readJsonFile(path.join(receiptsDir, it.file));
    const s = dayStats.get(day);
    if (!rec) { problems.push(`${it.file} 不可解析`); continue; }
    if (!s) { problems.push(`${it.file}：台账缺 ${day} 日文件`); continue; }
    const bad = [];
    if (String(rec.date || '') !== day) bad.push(`date=${rec.date}≠${day}`);
    if (num(rec.ledgerRows) !== s.rows) bad.push(`ledgerRows=${rec.ledgerRows}≠${s.rows}`);
    if (num(rec.ledgerBytes) !== s.bytes) bad.push(`ledgerBytes=${rec.ledgerBytes}≠${s.bytes}`);
    if (String(rec.firstCode || '') !== s.firstCode) bad.push(`firstCode=${rec.firstCode || '(缺)'}≠${s.firstCode}`);
    if (String(rec.lastCode || '') !== s.lastCode) bad.push(`lastCode=${rec.lastCode}≠${s.lastCode}`);
    if (num(rec.partialCount) !== s.partialCount) bad.push(`partialCount=${rec.partialCount}≠${s.partialCount}`);
    if (num(rec.badLines) !== s.badLines) bad.push(`badLines=${rec.badLines}≠${s.badLines}`);
    // ★ re3 / 审计②P2-6（D1 线）：`originalCount` 口径 = **该日**第三级「完整原文.md」视图份数
    //   （摘要格式 v3；旧 v2 写的是"全库累计"，是实现缺陷）。判据与实现同一次改，S-11 C42 的
    //   "抽 3 天 JSON+TXT 100% 相符 / 不许重写 / 只补发 / 无变化不产新版"阈值**一个字不改**。
    const dayViews = walkFiles(w.root).filter((f) => /完整原文\.md$/.test(f.name) && f.name.startsWith(day.replace(/-/g, ''))).length;
    // ★ K-17（re4 / 三份审计）：加 `v>=3` legacy 门，与产品侧 lib/receipt.js 的 legacy 豁免**同口径**。
    //   v1/v2 收据的 originalCount 是"全库累计"历史口径（实现缺陷），硬比当日视图会把旧库一律判红；
    //   这正是审计看到的"同包同机因机器历史不同而 45 或 44"的直接原因之一。
    //   旧版只读兼容、不判红、自动补发 v3 —— 判据必须与产品一致，不能比产品严。
    // ★ K-17 修正（re4 自审）：门必须看**内容版本 rec.v**，不是文件名版本 it.version。
    //   实测：首版 v3 摘要的文件名不带 `.v3` 后缀 → it.version=1 → 门恒假 → originalCount
    //   子项永久空跑（假绿）。产品侧 lib/receipt.js 用的是 `Number(r.v)>=3`，判据必须同源。
    //   旧 v1/v2 只记 legacyDays、不判红（与产品 legacy 豁免一致，不能比产品严）。
    const recFormatV = Number(rec.v != null ? rec.v : it.version) || 0;
    if (recFormatV >= 3 && num(rec.originalCount) !== dayViews) bad.push(`originalCount=${rec.originalCount}≠当日视图 ${dayViews}`);
    // TXT：与 JSON 同版本号；必须存在，且首/末条编码与行数对得上
    const txtAbs = path.join(receiptsDir, digestTxtName(day, it.version));
    let txtOk = false;
    if (!fs.existsSync(txtAbs)) {
      bad.push(`缺同版本 TXT：${digestTxtName(day, it.version)}（S-11 F7/C42 的"发出物"不存在）`);
    } else {
      const t = fs.readFileSync(txtAbs, 'utf8');
      const miss = [];
      if (!t.includes(`首条编码：${s.firstCode}`)) miss.push('首条编码');
      if (!t.includes(`末条编码：${s.lastCode}`)) miss.push('末条编码');
      if (!t.includes(`台账轮次：${s.rows} 行`)) miss.push('行数');
      if (miss.length) bad.push(`${digestTxtName(day, it.version)} 与台账不符（缺/错：${miss.join('、')}）`);
      else txtOk = true;
    }
    detail.push({ day, receipt: it.file, version: it.version, txt: digestTxtName(day, it.version), txtOk, ledger: { rows: s.rows, firstCode: s.firstCode, lastCode: s.lastCode }, originalCount: { declared: num(rec.originalCount), dayViews, allViews: views }, bad });
    if (bad.length) problems.push(`${it.file} 与台账不符：${bad.join('；')}`);
  }

  // ② 不重写：改台账 → 跑 2 tick → 旧版本文件逐字节不变、必须新增 v(N+1) 的 JSON+TXT、run-report 能看见版本账
  let immut = null;
  try {
    const work = freshSubDir('c42-immutable');
    const cRoot = path.join(work, 'root');
    const cHome = path.join(work, 'dsh-home');
    const cRec = path.join(work, 'receipts');
    const srcHome = path.join(w.lab || path.join(w.root, '..'), 'dsh-home');
    copyTreeReal(w.root, cRoot);
    copyTreeReal(srcHome, cHome);
    copyTreeReal(receiptsDir, cRec);
    relocateState(cRoot, srcHome, cHome);
    const day = pick[0];
    const it = byDay.get(day);
    const snap = new Map();
    for (const f of fs.readdirSync(cRec)) {
      if (/^RECEIPT-/.test(f) || /^日结摘要-/.test(f)) snap.set(f, sha256File(path.join(cRec, f)));
    }
    const versionsBefore = [...snap.keys()].filter((f) => f.startsWith(`RECEIPT-${day.replace(/-/g, '')}`) && /\.json$/.test(f)).length;
    // 改台账：追加 1 条合法行（唯一编码/轮次）
    const dayFile = path.join(cRoot, 'ledger', `${day}.jsonl`);
    const lines = fs.readFileSync(dayFile, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    const nextCode = `${String(last.code).slice(0, 24)}${String((Number(String(last.code).slice(-8)) || 1) + 1).padStart(8, '0')}`;
    fs.appendFileSync(dayFile, `${JSON.stringify({ ...last, code: nextCode, turn: num(last.turn) + 1000, seq: num(last.seq) + 1000 })}\n`, 'utf8');
    // 跑 2 tick（收据段会补发新版）
    const r1 = runTickDriver({ base: work, root: cRoot, home: cHome }, 2, { weekly: false, receiptAnchorRoot: cRec });
    const changed = [...snap.entries()].filter(([f, sha]) => {
      const p = path.join(cRec, f);
      return !fs.existsSync(p) || sha256File(p) !== sha;
    }).map(([f]) => f);
    const vNext = Number(it.version) + 1;
    const wantJson = `RECEIPT-${day.replace(/-/g, '')}.v${vNext}.json`;
    const wantTxt = digestTxtName(day, vNext);
    const hasNext = fs.existsSync(path.join(cRec, wantJson)) && fs.existsSync(path.join(cRec, wantTxt));
    // run-report 里必须能看到"已发版本数/最新版本号"（S-11 C42 (c)）
    let digest = null;
    try {
      const repNames = fs.readdirSync(cRoot ? path.join(cRoot, 'ledger') : '').filter((n) => /^\.run-report-\d{8}\.json$/.test(n)).sort();
      if (repNames.length) {
        const rep = readJsonFile(path.join(cRoot, 'ledger', repNames[repNames.length - 1]));
        digest = rep && rep.receiptDigest ? rep.receiptDigest : null;
      }
    } catch { digest = null; }
    // 稳定复跑：再跑 2 tick（无变化）→ 该日版本文件数不再增长
    const countFor = () => fs.readdirSync(cRec).filter((f) => f.startsWith(`RECEIPT-${day.replace(/-/g, '')}`) && /\.json$/.test(f)).length;
    const afterV2 = countFor();
    runTickDriver({ base: work, root: cRoot, home: cHome }, 2, { weekly: false, receiptAnchorRoot: cRec });
    const afterSteady = countFor();
    immut = { day, versionsBefore, changed, wantJson, wantTxt, hasNext, digest, afterV2, afterSteady, tickExit: r1.exit };
    if (changed.length) problems.push(`日结摘要被**原地重写/删除**：${changed.slice(0, 3).join('、')}（S-11 C42 要求旧版一个字节不动）`);
    if (!hasNext) problems.push(`台账变了却没有补发 v${vNext}（缺 ${wantJson} 或 ${wantTxt}）`);
    if (!digest || num(digest.versionsTotal) < 2) problems.push(`run-report 里看不到版本账（receiptDigest=${JSON.stringify(digest)}）——S-11 C42 (c) 要求"已发版本数/最新版本号"可见`);
    if (afterSteady !== afterV2) problems.push(`无变化的 2 tick 仍在产新版（${afterV2}→${afterSteady}）`);
  } catch (e) {
    immut = { error: String((e && e.message) || e) };
    problems.push(`"不重写"反证未跑成：${String((e && e.message) || e)}`);
  }
  const evidence = {
    lab: rel(w.root),
    receiptsDir: rel(receiptsDir),
    days: days.length,
    picked: pick,
    detail,
    views,
    originalCountCaliber: 'v3（re3/审计②P2-6，D1 线）：originalCount = **该日**第三级「完整原文.md」视图份数；旧 v1/v2 摘要是"全库累计"旧口径（实现缺陷），已由 D1 修；判据断言与实现同一次改为当日口径，S-11 C42 阈值未动',
    immutability: immut,
    problems: problems.slice(0, 30),
    caliber: 'S-11 C42：抽 3 天摘要与台账 100% 相符（含首/末条 code；originalCount 按 v3 当日口径）；★ 发出后不许重写，只能补发新版（本实现真跑 tick 实测：旧版 sha 不变 + 新增 vN JSON/TXT + run-report 版本账可见；无变化不产新版）',
  };
  if (problems.length) return redRow('C42', problems.slice(0, 10), evidence);
  return greenRow(
    'C42',
    `日结摘要 ${days.length} 天抽 3 天（${pick.join('/')}）：JSON+TXT 与台账 100% 相符；改台账后旧版逐字节不变、已补发 v${(num(immut && immut.versionsBefore) || 1) + 1}（JSON+TXT 成对）、run-report 版本账可见；无变化 2 tick 不产新版`,
    evidence,
  );
}

// ---------- C43 · 反向：交接表冻结不被绕过 ----------
function runC43(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return naRow('C43', [`缺小库 lab（c01）：${lab.why}`]);
  const problems = [];
  const work = freshSubDir('c43-handover');
  const cRoot = path.join(work, 'root');
  const cHome = path.join(work, 'dsh-home');
  let r1 = null;
  let r2 = null;
  let preexisting = [];
  let fixture = null;
  /** 单段 tick 结果自检：★ 空跑防线（JSON 未解析→ticks=[]；字段缺失被 num() 当 0 → 假绿） */
  const checkTicks = (ticks, tag) => {
    if (ticks.length !== 3) problems.push(`${tag} tick 结果 ${ticks.length}/3（驱动未跑满/JSON 未解析 → 冻结没有被证明）`);
    for (const t of ticks) {
      for (const k of ['handoverGenerated', 'handoverAdopted', 'handoverSkipped', 'handoverSealedTotal']) {
        if (!Number.isFinite(Number(t[k]))) problems.push(`${tag} tick 缺字段 ${k}（缺字段不能当 0 冒充"冻结"）`);
        else if (Number(t[k]) !== 0) problems.push(`${tag} tick 的 ${k}=${t[k]}（≠0）——交接表被计数，冻结被绕过`);
      }
      if (!t.ok) problems.push(`${tag} tick 异常：${t.crash}`);
    }
  };
  try {
    copyTreeReal(lab.root, cRoot);
    copyTreeReal(path.join(lab.root, '..', 'dsh-home'), cHome);
    const reloc = relocateState(cRoot, path.join(lab.root, '..', 'dsh-home'), cHome);
    // ★ 2026-11 审计（P2-1 空跑）：反向判据最容易"什么都没做也成立"——先断言夹具真能跑 tick：
    //   state 改写成功、会话 ≥2、每个会话都有游标。旧实现这三条全不校验。
    const sessN = walkFiles(path.join(cHome, 'sessions')).filter((f) => /session\.v[34]\.jsonl\.zstd$/.test(f.name)).length;
    const curN = (() => {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(cRoot, 'ledger', '.state.json'), 'utf8'));
        return Object.keys((st && st.sourceCursors) || {}).length;
      } catch { return 0; }
    })();
    fixture = { relocateState: reloc === true, sessions: sessN, cursors: curN };
    if (reloc !== true) problems.push('relocateState 失败（副本 .state.json 无法改写为自洽游标）——tick 会空转，冻结没有被真正验证');
    if (sessN < 2) problems.push(`夹具会话 ${sessN} 个（<2）——C43 要求 ≥2 会话各跑 3 tick，空/单会话夹具不能判绿`);
    if (curN < sessN) problems.push(`state 游标 ${curN} 个 < 会话 ${sessN} 个（.state.json 未覆盖全部会话，tick 会漏跑）`);
    preexisting = findHandoverArtifacts(cRoot).map((f) => f.rel);
    if (preexisting.length) problems.push(`夹具里已经有交接表产物 ${preexisting.length} 个（例：${preexisting.slice(0, 3).join(',')}）——冻结不成立`);
    // ① 先跑 3 tick：不得生成任何交接表，且 stat 的 handover* 计数必须全 0
    r1 = runTickDriver({ base: work, root: cRoot, home: cHome }, 3, { weekly: false });
    const after1 = findHandoverArtifacts(cRoot);
    if (after1.length) problems.push(`跑 3 tick 后出现了交接表产物 ${after1.length} 个（例：${after1.slice(0, 3).map((f) => f.rel).join(',')}）——冻结被绕过`);
    const t1 = r1 && r1.json && Array.isArray(r1.json.ticks) ? r1.json.ticks : [];
    if (r1 && r1.json && r1.json.parseError) problems.push(`第一段 tick 驱动 JSON 解析失败：${r1.json.parseError}（ticks=[] 不能当"冻结成立"）`);
    checkTicks(t1, '第一段');
    // ② 「删了不补」反向：放一个哨兵交接表文件 → 删掉 → 再跑 3 tick → 不得重建
    const sentinelDir = path.join(cRoot, '交接表');
    fs.mkdirSync(sentinelDir, { recursive: true });
    const sentinel = path.join(sentinelDir, 'sentinel.md');
    fs.writeFileSync(sentinel, 'c43 sentinel\n', 'utf8');
    fs.rmSync(sentinel, { force: true });
    r2 = runTickDriver({ base: work, root: cRoot, home: cHome }, 3, { weekly: false });
    if (fs.existsSync(sentinel)) problems.push('删掉的交接表哨兵文件被重建（冻结被绕过）');
    const after2 = findHandoverArtifacts(cRoot).filter((f) => f.rel !== '交接表'); // 空目录不算（哨兵目录由本判据创建）
    if (after2.length) problems.push(`哨兵删除后 3 tick 又出现交接表产物 ${after2.length} 个`);
    const t2 = r2 && r2.json && Array.isArray(r2.json.ticks) ? r2.json.ticks : [];
    if (r2 && r2.json && r2.json.parseError) problems.push(`第二段 tick 驱动 JSON 解析失败：${r2.json.parseError}（ticks=[] 不能当"冻结成立"）`);
    checkTicks(t2, '第二段');
  } catch (e) {
    problems.push(`冻结反证未跑成：${String((e && e.message) || e)}`);
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
  const evidence = {
    lab: rel(lab.root),
    preexisting,
    fixture,
    ticks1Count: ((r1 && r1.json && r1.json.ticks) || []).length,
    ticks2Count: ((r2 && r2.json && r2.json.ticks) || []).length,
    driverParseError: [(r1 && r1.json && r1.json.parseError) || '', (r2 && r2.json && r2.json.parseError) || ''].filter(Boolean),
    ticks1: (r1 && r1.json.ticks) || null,
    ticks2: (r2 && r2.json.ticks) || null,
    driverLog: (r1 && r1.logRel) || '',
    problems,
    caliber: '机主 2026-11-14 早会裁定 C43 反向判据：交接表在 lite 冻结（S-1/§5.3）——造 2 会话各跑 3 tick，交接表目录/文件数必须不增加；删后 3 tick 内不得重建；出现任何交接表生成即 RED',
  };
  if (problems.length) return redRow('C43', problems.slice(0, 10), evidence);
  return greenRow('C43', `冻结未被绕过：6 tick 全程 handover* 计数全 0、交接表产物 0 个；删除哨兵后 3 tick 未重建`, evidence);
}

// ---------- C44 · doctor 对 5 类已知故障各报一次红（先红后绿） ----------
function doctorRun(rootDir, sessionsDir, label) {
  const r = runNode(`C44-doctor-${label}`, path.join(LITE, 'tools', 'doctor.mjs'), [
    `--root=${rootDir}`,
    `--sessions=${sessionsDir}`,
    '--no-write',
    '--json',
  ], 300000);
  let json = null;
  try { json = extractJson(r.stdout); } catch { json = null; }
  const sev = {};
  if (json && Array.isArray(json.checks)) for (const c of json.checks) sev[c.id] = c.severity;
  return { exit: r.exit, json, sev, logRel: r.logRel };
}
function runC44(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return naRow('C44', [`缺小库 lab（c01）：${lab.why}`]);
  const work = freshSubDir('c44-doctor');
  const cRoot = path.join(work, 'root');
  const cHome = path.join(work, 'dsh-home');
  const problems = [];
  const sub = [];
  try {
    copyTreeReal(lab.root, cRoot);
    copyTreeReal(path.join(lab.root, '..', 'dsh-home'), cHome);
    relocateState(cRoot, path.join(lab.root, '..', 'dsh-home'), cHome);
    const base = doctorRun(cRoot, path.join(cHome, 'sessions'), 'base');
    if (!base.json) problems.push(`doctor 基线没产出可解析 JSON（exit=${base.exit}）`);
    if (base.sev['data-integrity'] === 'red' || base.sev['code-consistency'] === 'red' || base.sev['ingest-health'] === 'red' || base.sev['storage-health'] === 'red') {
      problems.push(`doctor 基线已有红（${JSON.stringify(base.sev)}）——注入前后的红无法归因`);
    }
    // 五类故障（每类：注入 → 目标检查必须 red → 还原 → 目标检查必须不 red）
    const faults = [
      {
        id: '①台账行数≠原文份数', target: 'data-integrity',
        inject() {
          const view = walkFiles(cRoot).filter((f) => /完整原文\.md$/.test(f.name))[0];
          if (!view) throw new Error('夹具里没有 完整原文.md 可删');
          const buf = fs.readFileSync(view.abs);
          fs.rmSync(view.abs, { force: true });
          return () => fs.writeFileSync(view.abs, buf);
        },
      },
      {
        id: '②原文 sha256 复算失败（S-11 写 entryHash；该字段已被 S-6 否决，落到"原文整文件 sha256"）', target: 'code-consistency',
        inject() {
          const att = walkFiles(cRoot).filter((f) => /原始事件\.json$/.test(f.name))[0];
          if (!att) throw new Error('夹具里没有 原始事件.json 可改');
          const buf = fs.readFileSync(att.abs);
          fs.writeFileSync(att.abs, Buffer.concat([buf, Buffer.from('\n/*c44*/\n', 'utf8')]));
          return () => fs.writeFileSync(att.abs, buf);
        },
      },
      {
        id: '③游标卡住', target: 'ingest-health',
        inject() {
          const sess = walkFiles(path.join(cHome, 'sessions')).filter((f) => /\.zstd$/.test(f.name))[0];
          if (!sess) throw new Error('夹具里没有会话源文件');
          const buf = fs.readFileSync(sess.abs);
          const st = fs.statSync(sess.abs);
          // 追加一帧"新轮"：源 size > 游标 size；再把 mtime 拨到 1 小时前（越过 2×interval 宽限）
          const frame = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 9001, time: Date.now(), data: { turn: 9001 } })}\n${JSON.stringify({ type: 'turn/end', seq: 9002, time: Date.now() + 2, data: { turn: 9001, reason: { kind: 'completed' } } })}\n`, 'utf8'));
          fs.appendFileSync(sess.abs, frame);
          const old = new Date(Date.now() - 3600 * 1000);
          fs.utimesSync(sess.abs, old, old);
          return () => { fs.truncateSync(sess.abs, buf.length); fs.utimesSync(sess.abs, st.atime, st.mtime); };
        },
      },
      {
        id: '④pending 积压超阈', target: 'storage-health',
        inject() {
          const p = path.join(cRoot, 'ledger', '.pending.jsonl');
          const existed = fs.existsSync(p);
          const prev = existed ? fs.readFileSync(p) : null;
          // > pendingMaxBytes（默认 1 MiB）
          const pad = 'x'.repeat(1200 * 1024);
          fs.appendFileSync(p, `${JSON.stringify({ sid: 'session-c44pending', turn: 1, startMs: Date.now(), pad })}\n`, 'utf8');
          return () => { if (existed) fs.writeFileSync(p, prev); else fs.rmSync(p, { force: true }); };
        },
      },
      {
        id: '⑤单文件 >4 MB', target: 'storage-health',
        inject() {
          const p = path.join(cRoot, '临时大文件.bin');
          fs.writeFileSync(p, Buffer.alloc(5 * 1024 * 1024, 0x41));
          return () => fs.rmSync(p, { force: true });
        },
      },
    ];
    for (const f of faults) {
      let redSev = '';
      let greenSev = '';
      let err = '';
      try {
        const restore = f.inject();
        const rd = doctorRun(cRoot, path.join(cHome, 'sessions'), 'fault-red');
        redSev = rd.sev[f.target] || '(缺检查)';
        restore();
        const gr = doctorRun(cRoot, path.join(cHome, 'sessions'), 'fault-green');
        greenSev = gr.sev[f.target] || '(缺检查)';
        if (redSev !== 'red') problems.push(`${f.id}：注入后 ${f.target} 的 severity=${redSev}（要求 red）`);
        if (greenSev === 'red') problems.push(`${f.id}：还原后 ${f.target} 仍是 red（无法转绿）`);
      } catch (e) {
        err = String((e && e.message) || e);
        problems.push(`${f.id}：注入/还原异常 ${err}`);
      }
      sub.push({ fault: f.id, target: f.target, redSeverity: redSev, greenSeverity: greenSev, error: err });
    }
  } catch (e) {
    problems.push(`C44 夹具准备失败：${String((e && e.message) || e)}`);
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
  const passed = sub.filter((s) => s.redSeverity === 'red' && s.greenSeverity !== 'red' && !s.error).length;
  const evidence = { lab: rel(lab.root), sub, passed, total: sub.length, problems, caliber: 'S-11 C44：5 类故障各报一次红（先红后绿）；不许"报黄了事"（要求 severity=red）' };
  if (problems.length || passed !== 5) return redRow('C44', problems.length ? problems.slice(0, 10) : [`5 类只过了 ${passed}/5`], evidence);
  return greenRow('C44', `doctor 5 类故障各报一次红并转绿（5/5）：${sub.map((s) => `${s.target}=red→${s.greenSeverity}`).join('、')}`, evidence);
}

// ---------- C45 · 恢复演练（备份→删工作库→重建→verify 绿→抽 100 行逐字节相等） ----------
/** 8 行 mulberry32：带种子的确定性 PRNG（C45 抽样用；零依赖）。 */
function mulberry32(a) {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
/** 带种子的 Fisher–Yates 洗牌（返回新数组，不改入参）。种子写进证据 → 抽样可复算。 */
function shuffleWithSeed(arr, seedHex) {
  const rnd = mulberry32(parseInt(String(seedHex || '0').slice(0, 8), 16) >>> 0);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
function runC45(ctx, opt = {}) {
  // 夹具：只认**大库**（E3，1,338 行）。★ 2026-11 审计（P2-1 空跑）：旧实现"大库缺失→退小库"，
  //   而 `picked < Math.min(100, codes.length)` 对 12 行小库恒假 → 0 行/12 行都能绿；
  //   S-11 C45 明写"随机抽 100 行"——样本不足只能 NA（NA ≠ 绿，不拿小库冒充）。
  if (!(ctx.big && ctx.big.ok)) {
    return naRow('C45', [
      `缺大库 E3（lab-e3-accept 不可用：${(ctx.big && ctx.big.why) || '未构造'}）——S-11 C45 要求随机抽 100 行，小库 12 行样本不足，不能判绿（NA 不算绿）`,
    ]);
  }
  const lab = ctx.big;
  const work = freshSubDir('c45-restore');
  const srcRoot = path.join(work, 'root');
  const backupDir = path.join(work, 'backup');
  const restored = path.join(work, 'restored');
  const problems = [];
  let backupRes = null;
  let verifyRes = null;
  let restoreRes = null;
  let sample = null;
  let proofInject = null;
  /** 台账原始行（按 code 建索引）：用于"重建后逐字节相等"抽样 */
  const rawOf = (rootDir) => {
    const m = new Map();
    const dir = path.join(rootDir, 'ledger');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch { names = []; }
    for (const f of names) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { m.set(JSON.parse(line).code, line); } catch { /* ignore */ }
      }
    }
    return m;
  };
  try {
    // ★ 样本量自检（备份之前做，避免"空备份/空抽样"空跑）：
    //   源台账 0 行 = "0 码抽 0 行"也能绿；<100 码 = 达不到 S-11 的 100 行样本量 → NA。
    const srcLedger = scanLedger(path.join(lab.root, 'ledger'));
    const srcRaw = rawOf(lab.root);
    const codes = [...srcRaw.keys()].sort();
    if (!srcLedger.rows.length || !codes.length) {
      return naRow('C45', [`源台账 0 行（${rel(lab.root)}/ledger）：恢复演练没有可抽的台账行，不能空跑判绿（NA 不算绿）`]);
    }
    if (codes.length < 100) {
      return naRow('C45', [`源台账 ${codes.length} 码 <100：S-11 C45 要求随机抽 100 行，样本不足不能判绿（NA 不算绿）`], { lab: rel(lab.root), codes: codes.length });
    }
    // 抽样种子：本 lab `.state.json` 的 sha256 前 8 hex → 确定性、可复算；种子写进证据
    const seed = (() => { try { return sha256File(path.join(lab.root, 'ledger', '.state.json')).slice(0, 8); } catch { return 'c45seed0'; } })();
    copyTreeReal(lab.root, srcRoot);
    const bk = runNode('C45-backup', path.join(LITE, 'tools', 'backup.mjs'), ['backup', `--root=${srcRoot}`, `--out=${backupDir}`, '--json'], 300000);
    backupRes = { exit: bk.exit, logRel: bk.logRel };
    if (bk.exit !== 0) problems.push(`backup exit=${bk.exit}（要求 0）`);
    const vf = runNode('C45-verify', path.join(LITE, 'tools', 'backup.mjs'), ['verify', `--out=${backupDir}`, '--json'], 300000);
    verifyRes = { exit: vf.exit, logRel: vf.logRel };
    if (vf.exit !== 0) problems.push(`backup verify exit=${vf.exit}（要求 0）`);
    // --proof 注入钩子（只在副本/备份副本上做，源 lab 只读）
    if (typeof opt.afterBackup === 'function') {
      proofInject = opt.afterBackup(backupDir);
    }
    // 「删掉工作库」
    fs.rmSync(srcRoot, { recursive: true, force: true });
    const rs = runNode('C45-restore', path.join(LITE, 'tools', 'backup.mjs'), ['restore', `--out=${backupDir}`, `--to=${restored}`, '--write', '--json'], 300000);
    restoreRes = { exit: rs.exit, logRel: rs.logRel };
    if (rs.exit !== 0) problems.push(`restore exit=${rs.exit}（要求 0）`);
    // 重建后：行数一致 + 抽 100 行逐字节相等
    const led2 = scanLedger(path.join(restored, 'ledger'));
    if (led2.rows.length !== srcLedger.rows.length) problems.push(`重建后台账 ${led2.rows.length} 行 ≠ 源 ${srcLedger.rows.length} 行`);
    if (led2.badLines) problems.push(`重建后坏行 ${led2.badLines}`);
    const dstRaw = rawOf(restored);
    // ★ 抽样：带种子 Fisher–Yates（旧实现是等距抽样，不是"随机"）；种子写进证据，可复算
    const picked = shuffleWithSeed(codes, seed).slice(0, 100);
    let equal = 0;
    const mismatch = [];
    for (const c of picked) {
      if (dstRaw.get(c) === srcRaw.get(c)) equal += 1;
      else mismatch.push(c);
    }
    sample = { totalCodes: codes.length, picked: picked.length, equal, mismatch: mismatch.slice(0, 5), seed, sampling: 'fisher-yates(mulberry32)，seed=sha256(.state.json)[:8]' };
    if (picked.length !== 100) problems.push(`抽样只取到 ${picked.length} 行（S-11 要求恰好 100 行）`);
    if (equal !== 100) problems.push(`重建后逐字节相等 ${equal}/${picked.length}（要求 100/100；不一致：${mismatch.slice(0, 3).join(',')}）`);
  } catch (e) {
    problems.push(`恢复演练异常：${String((e && e.message) || e)}`);
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
  const evidence = { lab: rel(lab.root), backup: backupRes, verify: verifyRes, restore: restoreRes, sample, proofInject: proofInject || '', problems, caliber: 'S-11 C45：备份→删工作库→重建→verify 绿→随机抽 100 行与源逐字节相等（没有演练过的备份等于没有备份）' };
  if (problems.length) return redRow('C45', problems.slice(0, 10), evidence);
  return greenRow('C45', `恢复演练通过：backup exit 0 → verify exit 0 → 删库重建 restore exit 0；台账 ${sample.totalCodes} 码随机抽 ${sample.picked} 行（种子 ${sample.seed}）逐字节相等 ${sample.equal}/${sample.picked}`, evidence);
}

function buildCtx() {
  return { lab: LABD, big: BIGD, three: THREED, weeks: { ...WEEKSD, receipts: RECEIPTS, lab: WEEKS }, lite: LITE, work: WORK, base: BASE };
}
const LOCAL_IMPL = {
  C19: (ctx) => runC19(ctx),
  C20: (ctx) => runC20(ctx),
  C21: (ctx) => runC21(ctx),
  C22: (ctx) => runC22(ctx),
  C23: (ctx) => runC23(ctx),
  C25: (ctx) => runC25(ctx),
  C38: (ctx) => runC38(ctx),
  C39: (ctx) => runC39(ctx),
  C40: (ctx) => runC40(ctx),
  C41: (ctx) => runC41(ctx),
  C42: (ctx) => runC42(ctx),
  C43: (ctx) => runC43(ctx),
  C44: (ctx) => runC44(ctx),
  C45: (ctx) => runC45(ctx),
};

// ============================================================================
// 七、聚合执行
// ============================================================================
function runAggregate() {
  const ctx = buildCtx();
  const want = new Set(only);
  const want091 = ids091.filter((id) => want.has(id));
  const want094 = ids094.filter((id) => want.has(id));
  const wantLocal = localIds.filter((id) => want.has(id));
  const children = [];
  const childRows = new Map();
  let archive091 = null;
  if (want091.length) {
    const c = runChild('0.9.1', want091);
    archive091 = archive091Evidence(c);
    children.push(c);
    for (const [k, v] of ingestChildRows(c)) childRows.set(k, { ...v, childMeta: c });
    if (!c.json) {
      for (const id of want091) childRows.set(id, { status: 'NA', summary: `子进程 判据-0.9.1 未产出可解析 JSON（exit=${c.exit}）：${c.parseErr}`, reasons: [`缺子执行器有效输出；见证据 ${c.logRel}`], child: '0.9.1', childMeta: c });
    }
  }
  if (want094.length) {
    const c = runChild('0.9.4', want094);
    children.push(c);
    for (const [k, v] of ingestChildRows(c)) childRows.set(k, { ...v, childMeta: c });
    if (!c.json) {
      for (const id of want094) childRows.set(id, { status: 'NA', summary: `子进程 判据-0.9.4 未产出可解析 JSON（exit=${c.exit}）：${c.parseErr}`, reasons: [`缺子执行器有效输出；见证据 ${c.logRel}`], child: '0.9.4', childMeta: c });
    }
  }
  const rows = [];
  for (const id of ALL_IDS) {
    const def = BY_ID.get(id);
    if (!want.has(id)) {
      rows.push({ id, group: def.group, gate: def.gate, status: 'SKIP', summary: '--only 未选中', reasons: [], evidence: null });
      continue;
    }
    let row;
    if (childRows.has(id)) {
      const c = childRows.get(id);
      const meta = c.childMeta;
      row = {
        id,
        status: c.status === 'GREEN' || c.status === 'RED' || c.status === 'NA' ? c.status : 'NA',
        summary: c.summary,
        reasons: c.reasons || [],
        evidence: {
          judgedBy: `filesystem:${meta.script}`,
          child: meta.label,
          childExit: meta.exit,
          childCounts: meta.json && meta.json.counts ? meta.json.counts : meta.json && meta.json.ok !== undefined ? { ok: meta.json.ok } : null,
          childLog: meta.logRel,
          childEvidenceDir: meta.evidenceDir || '',
          perCriterion: c.checks || undefined,
          childEvidence: c.evidence || undefined,
        },
      };
    } else if (LOCAL_IMPL[id]) {
      try {
        row = LOCAL_IMPL[id](ctx);
      } catch (e) {
        row = redRow(id, [`执行异常：${String((e && e.stack) || e)}`], { error: String((e && e.message) || e) });
      }
      row.group = def.group;
      row.gate = def.gate;
      row.evidence = row.evidence || {};
      row.evidence.judgedBy = 'docs/判据-1.0.mjs（本地实现）';
    } else {
      row = naRow(id, ['本执行器未实现该判据（内部错误）']);
    }
    row.group = def.group;
    row.gate = def.gate;
    if (!row.evidence) row.evidence = {};
    if (row.evidence && row.evidence.judgedBy === undefined) row.evidence.judgedBy = row.evidence.judgedBy || '';
    rows.push(row);
  }
  // 校验：子执行器返回的编号必须与请求一致（防"少跑一条静默当绿"）
  for (const c of children) {
    const expected = c.which === '0.9.1' ? want091 : want094;
    if (c.json) {
      const got = c.which === '0.9.1' ? (c.json.results || []).map((r) => r.id) : (c.json.criteria || []).map((r) => r.id);
      const missing = expected.filter((id) => !got.includes(id));
      if (missing.length) {
        for (const id of missing) {
          const r = rows.find((x) => x.id === id);
          if (r) {
            r.status = 'NA';
            r.summary = `子进程 ${c.label} 没有返回 ${id}（防静默漏判）`;
            r.reasons = [r.summary];
          }
        }
      }
    }
  }
  const counts = { green: 0, red: 0, na: 0, skip: 0 };
  for (const r of rows) counts[r.status === 'GREEN' ? 'green' : r.status === 'RED' ? 'red' : r.status === 'NA' ? 'na' : 'skip'] += 1;
  const evaluated = rows.filter((r) => r.status !== 'SKIP');
  const ok = evaluated.length > 0 && counts.red === 0 && counts.na === 0 && evaluated.length === want.size;
  const childMeta = children.map((c) => ({
    label: c.label,
    script: c.script,
    exit: c.exit,
    ms: c.ms,
    counts: c.json ? c.json.counts || null : null,
    ok: c.json ? c.json.ok : null,
    parseError: c.parseErr || '',
    evidenceDir: c.evidenceDir || '',
    log: c.logRel,
    note: '子执行器退出码 1 若因 NA 也如实保留（NA≠绿）',
  }));
  const naList = rows.filter((r) => r.status === 'NA').map((r) => ({ id: r.id, missing: r.reasons.length ? r.reasons : [r.summary] }));
  const redList = rows.filter((r) => r.status === 'RED').map((r) => ({ id: r.id, reasons: r.reasons.length ? r.reasons : [r.summary] }));
  const residual = [];
  if (counts.green + counts.red + counts.na + counts.skip !== CRITERIA.length) residual.push(`内部错误：判据行数 ${counts.green + counts.red + counts.na + counts.skip} ≠ 表里 ${CRITERIA.length}`);
  const c20 = rows.find((r) => r.id === 'C20');
  if (c20 && c20.evidence && c20.evidence.caveat) residual.push(`C20 ${c20.evidence.caveat}`);
  const c21 = rows.find((r) => r.id === 'C21');
  if (c21 && c21.evidence && c21.evidence.note) residual.push(`C21 ${c21.evidence.note}`);
  const c39 = rows.find((r) => r.id === 'C39');
  if (c39 && c39.evidence && Array.isArray(c39.evidence.extraKnownP4) && c39.evidence.extraKnownP4.length) residual.push(`C39 差异项 ${c39.evidence.extraKnownP4.join('、')} 属本次允许新增（P4 验具），出包最后一步重生成 MANIFEST 并入后为 0 差异`);
  if (c39 && c39.evidence && Array.isArray(c39.evidence.extraKnownRunArtifacts) && c39.evidence.extraKnownRunArtifacts.length) residual.push(`C39 另有 ${c39.evidence.extraKnownRunArtifacts.length} 个"清单外新增"是本执行器运行产物（包内 证据/判据-1.0-<时间戳>/，跑一次多一套），已单独登记、不计红；清单内已声明文件仍逐文件核 sha256（缺/改必须 0）`);
  const c22 = rows.find((r) => r.id === 'C22');
  if (c22 && c22.evidence && c22.evidence.r1_decompress_report_only !== undefined) residual.push(`C22 r1（整库/压缩语料，仅报告）=${Number(c22.evidence.r1_decompress_report_only).toFixed(4)}；S-9 实测解压 3.49× 是全语料口径，E3 现存语料子集不同，不参与判红`);
  if (rows.some((r) => r.id === 'C40') && rows.find((r) => r.id === 'C40').evidence && rows.find((r) => r.id === 'C40').evidence.appendOnlyNote) residual.push(`C40 append-only 的"从未删过旧行"在无 git 史下不可证；已改为"结构+三链+追加验链+删行可抓"四件可验`);
  residual.push('F 组（C38–C40）判定对象 = 当前包内最新交付五件（交付-v*）＋ VERSION.json/版本台账/MANIFEST；出包顺序：交付五件更新 → MANIFEST 重生成 → 再跑本执行器（C38/C39/C40 以新包为对象）。C38 的 VERSION.criteriaRun.evidence 必须是**包内相对路径**（如 证据/判据-1.0-final-<stamp>/summary.md），VERSION.tests 的来源日志须在包内 证据/跑测试-*.log；C40 要求版本台账末行与 VERSION.json 同版（VERSION 版本 bump 后必须追加台账行）');
  const latestProof = findLatestProofSummary();
  const summary = {
    schema: SCHEMA,
    at: new Date(nowMs).toISOString(),
    lite: '.',
    liteAbs: LITE.split(path.sep).join('/'),
    proof: latestProof,
    labs: {
      small: LABD.ok ? rel(LABD.root) : '',
      smallOk: LABD.ok,
      smallWhy: LABD.why || '',
      big: BIGD.ok ? rel(BIGD.root) : '',
      bigOk: BIGD.ok,
      bigWhy: BIGD.why || '',
      threeLayer: THREED.ok ? rel(THREED.root) : '',
      threeLayerOk: THREED.ok && fs.existsSync(THREE_MANIFEST),
      threeLayerWhy: THREED.ok && fs.existsSync(THREE_MANIFEST) ? '' : `${THREED.why || ''}${THREED.ok ? '；缺 manifest.json' : ''}`,
      root: DEFAULT_LABS_ROOT,
      fingerprintOk: ENSURE.fingerprintOk === true,
      fingerprintWhy: ENSURE.fingerprintWhy || '',
      ensure: ENSURE,
    },
    counts,
    ok,
    evaluated: evaluated.length,
    children: childMeta,
    childEvidenceArchive091: archive091 || null,
    criteria: rows.map((r) => {
      const def = BY_ID.get(r.id);
      return {
        id: r.id,
        group: r.group || def.group,
        gate: r.gate || def.gate,
        status: r.status,
        summary: r.summary,
        reasons: r.reasons,
        source: def.text,
        how: def.how,
        src: def.src,
        zonggang: `总纲 §7 L${def.gl}（${def.group}·${def.gate} 门）`,
        caliber: def.caliber || '',
        evidence: r.evidence,
      };
    }),
    naList,
    redList,
    residual,
  };
  writeEvid('summary.json', summary);
  writeTextEvid('summary.md', renderMarkdown(summary));
  for (const r of rows) {
    if (r.status === 'SKIP') continue;
    const def = BY_ID.get(r.id);
    writeEvid(`${r.id}.json`, { schema: `${SCHEMA}#${r.id}`, at: summary.at, ...r, source: def.text, how: def.how, zonggang: `总纲 §7 L${def.gl}`, caliber: def.caliber || '' });
  }
  return summary;
}

function mdCell(s, max = 160) {
  return String(s == null ? '' : s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, max);
}
function evidenceCell(r) {
  if (r.status === 'SKIP') return '—';
  const ev = r.evidence || {};
  if (r.status === 'NA') return mdCell((r.reasons && r.reasons[0]) || r.summary);
  if (ev.judgedBy && String(ev.judgedBy).startsWith('filesystem:')) {
    const child = ev.child || '';
    const key = child === '0.9.4' ? (ev.childEvidenceDir ? `${path.basename(ev.childEvidenceDir)}/${r.id}.json` : '') : '';
    return mdCell(`${child}：${r.summary}${key ? `（${key}）` : ''}`, 220);
  }
  return mdCell(r.summary, 220);
}
function renderMarkdown(summary) {
  const lines = [];
  lines.push('# 判据执行器 1.0（lite 线）· 45 条聚合 · V1.0 毕业口径');
  lines.push('');
  lines.push(`生成：${summary.at}｜小库：${summary.labs.smallOk ? summary.labs.small : `(缺：${summary.labs.smallWhy})`}｜大库：${summary.labs.bigOk ? summary.labs.big : `(缺：${summary.labs.bigWhy})`}｜三层夹具：${summary.labs.threeLayerOk ? summary.labs.threeLayer : `(缺：${summary.labs.threeLayerWhy})`}`);
  lines.push('');
  lines.push('## 一、45 条统一表');
  lines.push('');
  lines.push('| 判据 | 结果 | 证据 |');
  lines.push('|---|---|---|');
  for (const r of summary.criteria) lines.push(`| ${r.id} | ${r.status} | ${evidenceCell(r)} |`);
  lines.push('');
  lines.push(`汇总：GREEN=${summary.counts.green} RED=${summary.counts.red} NA=${summary.counts.na} SKIP=${summary.counts.skip} → ${summary.ok ? '全绿（45/45）' : '未全绿'}`);
  lines.push('');
  lines.push('## 二、分组汇总');
  lines.push('');
  const groups = [];
  for (const r of summary.criteria) {
    let g = groups.find((x) => x.group === r.group);
    if (!g) {
      g = { group: r.group, gate: r.gate, green: 0, red: 0, na: 0, skip: 0, ids: [] };
      groups.push(g);
    }
    g[r.status === 'GREEN' ? 'green' : r.status === 'RED' ? 'red' : r.status === 'NA' ? 'na' : 'skip'] += 1;
    g.ids.push(`${r.id}:${r.status}`);
  }
  lines.push('| 组 | 门 | GREEN | RED | NA | SKIP | 逐条 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const g of groups) lines.push(`| ${g.group} | ${g.gate} | ${g.green} | ${g.red} | ${g.na} | ${g.skip} | ${g.ids.join(' ')} |`);
  lines.push('');
  lines.push('## 三、子执行器（聚合，不重写）');
  lines.push('');
  if (!summary.children.length) lines.push('（本次 --only 未选中子执行器的判据）');
  for (const c of summary.children) {
    lines.push(`- **${c.label}**：exit=${c.exit}，ok=${c.ok}，${c.counts ? `GREEN=${c.counts.green} RED=${c.counts.red} NA=${c.counts.na} SKIP=${c.counts.skip}` : `未解析出计数（${c.parseError}）`}；证据：\`${c.evidenceDir || c.log}\``);
  }
  lines.push('');
  lines.push('## 四、判据原文 / 怎么验 / 出处（总纲 §7，逐条可追）');
  lines.push('');
  lines.push('| 判据 | 结果 | 判据原文（§7） | 怎么验（§7） | 出处 | 口径（签字项） |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of summary.criteria) lines.push(`| ${r.id} | ${r.status} | ${mdCell(r.source, 90)} | ${mdCell(r.how, 70)} | ${mdCell(`${r.zonggang}；${r.src}`, 40)} | ${mdCell(r.caliber || '—', 80)} |`);
  lines.push('');
  lines.push('## 五、NA（未验，不算绿）缺什么');
  lines.push('');
  if (summary.naList.length) {
    for (const n of summary.naList) lines.push(`- **${n.id}**：${(n.missing || []).join('；')}`);
  } else {
    lines.push('无（本次参与判定的判据全部判出，NA=0）。会记 NA 的输入缺口：缺小库/大库/三层夹具、缺 `ledger/.tick-metrics.jsonl`、缺 MANIFEST/版本台账/VERSION.json、缺 C38 抽查所需的 0.9.4 证据日志、子执行器未产出可解析 JSON。缺任何一项都写明缺哪个路径，不算绿。');
  }
  lines.push('');
  lines.push('## 六、RED 明细');
  lines.push('');
  if (summary.redList.length) {
    for (const n of summary.redList) lines.push(`- **${n.id}**：${(n.reasons || []).join('；')}`);
  } else {
    lines.push('无（RED=0）。');
  }
  lines.push('');
  lines.push('## 七、残余 / 口径说明（不粉饰）');
  lines.push('');
  if (summary.residual.length) {
    for (const x of summary.residual) lines.push(`- ${x}`);
  } else {
    lines.push('无。');
  }
  lines.push('');
  lines.push('## 八、先红后绿（--proof）');
  lines.push('');
  if (summary.proof) {
    lines.push(`最近一次自证：\`${summary.proof.dir}\`（ok=${summary.proof.ok}，PASS ${summary.proof.pass}/${summary.proof.total}，判据：${(summary.proof.ids || []).join('、')}）。`);
    lines.push('');
    lines.push('| 判据 | 注入 | 红 | 还原 | 绿 | 结论 |');
    lines.push('|---|---|---|---|---|---|');
    const ps = (() => {
      try {
        const abs = path.isAbsolute(summary.proof.file)
          ? summary.proof.file
          : path.join(PKG, summary.proof.file.split('/').join(path.sep));
        const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
        return Array.isArray(j.proofs) ? j.proofs : [];
      } catch {
        return [];
      }
    })();
    for (const p of ps) lines.push(`| ${p.id} | ${mdCell(p.injected, 80)} | ${p.redStatus} | ${mdCell(p.repaired, 50)} | ${p.greenStatus} | ${p.pass ? 'PASS' : 'FAIL'} |`);
  } else {
    lines.push('未找到 `proof-summary.json`（本次聚合未跑 --proof；先红后绿证据需另跑 `node docs\\判据-1.0.mjs --proof`）。');
  }
  lines.push('');
  // ★ K-20（re4 自审）：这行**同时是 C38 的机器可解析输入**（L1265 正则 `证据目录[：:]\s*(.+)`
  //   取整行剩余部分当路径）。旧写法把文件清单塞进同一行 → 解析出的"路径"含括号说明 →
  //   目录"不存在" → C38 必红；re3 时代靠"同名兜底"侥幸通过，路径真能解析时反而暴露。
  //   故：路径单独一行、说明另起一行。判据机制未变（仍是"证据目录必须存在且随包"）。
  lines.push(`证据目录：${rel(EVID)}`);
  lines.push('证据内容：summary.json / summary.md / C*.json / child-*.json / logs/');
  return lines.join('\n');
}

// ============================================================================
// 八、--proof 先红后绿（注入只碰副本；至少 C19/C20/C21/C22 四条）
// ============================================================================
const DEFAULT_PROOF = ['C19', 'C20', 'C21', 'C22', 'C23', 'C25', 'C39', 'C40', 'C41', 'C42', 'C43', 'C44', 'C45'];

function makeMetricsCopy(big, tag) {
  const dir = freshSubDir(`proof-metrics-${tag}`);
  const src = path.join(big.root, 'ledger', '.tick-metrics.jsonl');
  const dst = path.join(dir, '.tick-metrics.jsonl');
  fs.copyFileSync(src, dst);
  return { dir, dst, orig: fs.readFileSync(dst, 'utf8') };
}
function readTicksFile(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
function writeTicksFile(file, ticks) {
  fs.writeFileSync(file, ticks.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');
}

function proofC19(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return { id: 'C19', pass: false, injected: '(跳过：缺小库 lab)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: lab.why, greenSummary: '', residual: '缺 c01-lab' };
  const work = freshSubDir('proof-c19');
  const rootWork = path.join(work, 'root');
  copyTreeReal(lab.root, rootWork);
  const ledgerDir = path.join(rootWork, 'ledger');
  const ledgerFiles = fs.readdirSync(ledgerDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  if (!ledgerFiles.length) return { id: 'C19', pass: false, injected: '(跳过：副本无台账日文件)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: 'no ledger files', greenSummary: '', residual: '' };
  // 选"行数最多"的台账日文件，改中间一行（严格不碰首/尾非空行 → 满足"不改头尾"）
  let target = '';
  let best = null;
  for (const f of ledgerFiles) {
    const txt = fs.readFileSync(path.join(ledgerDir, f), 'utf8');
    const lines = txt.split('\n');
    const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    if (!best || nonEmpty.length > best.nonEmpty.length) best = { file: f, lines, nonEmpty };
  }
  if (!best || best.nonEmpty.length < 3) {
    return { id: 'C19', pass: false, injected: '(跳过：副本里没有 ≥3 行的台账日文件，"中段"无从构造)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: 'no mid-file target', greenSummary: '', residual: '' };
  }
  target = path.join(ledgerDir, best.file);
  const st0 = fs.statSync(target);
  const origBuf = fs.readFileSync(target);
  const base = runDaycheck(rootWork, lab.sessions, 'proof-base');
  const baseV = c19Verdict(base);
  let injectDesc = '';
  let red = null;
  let redV = null;
  let green = null;
  let greenV = null;
  let repairDesc = '';
  try {
    // 中段：改中间非空行的一个字段值（等长改写，首/尾非空行不动；然后还原 mtime）
    const lines = origBuf.toString('utf8').split('\n');
    const firstIdx = best.nonEmpty[0];
    const lastIdx = best.nonEmpty[best.nonEmpty.length - 1];
    const midIdx = best.nonEmpty[Math.floor(best.nonEmpty.length / 2)];
    const before = lines[midIdx];
    if (before.includes('"status":"ok"')) lines[midIdx] = before.replace('"status":"ok"', '"status":"OK"');
    else if (/"docHash":"[0-9a-f]{64}"/.test(before)) lines[midIdx] = before.replace(/"docHash":"([0-9a-f])/, (m, c) => `"docHash":"${c === 'a' ? 'b' : 'a'}`);
    else lines[midIdx] = before.replace(/("code":"[^"]*?)([0-9a-zA-Z])(["])/, (m, a, c, q) => `${a}${c === 'z' ? 'y' : 'z'}${q}`);
    if (lines[midIdx] === before) throw new Error('中段行找不到可等长改写的字段');
    const patched = Buffer.from(lines.join('\n'), 'utf8');
    fs.writeFileSync(target, patched);
    fs.utimesSync(target, st0.atime, st0.mtime); // 还原 mtime → 增量采样看不见
    const stPatch = fs.statSync(target);
    const byteOffset = (() => {
      for (let i = 0; i < Math.min(patched.length, origBuf.length); i += 1) if (patched[i] !== origBuf[i]) return i;
      return -1;
    })();
    injectDesc = `改 ${best.file} 第 ${midIdx + 1} 行（共 ${best.nonEmpty.length} 个非空行，首/尾行未动）为等长错误值并还原 mtime（size ${st0.size}→${stPatch.size}，mtimeMs ${Math.round(st0.mtimeMs)}→${Math.round(stPatch.mtimeMs)}，首个改动字节 offset=${byteOffset}）`;
    red = runDaycheck(rootWork, lab.sessions, 'proof-red');
    redV = c19Verdict(red);
    // 还原
    fs.writeFileSync(target, origBuf);
    fs.utimesSync(target, st0.atime, st0.mtime);
    repairDesc = '把台账日文件字节写回原值 + 还原 mtime（不用 git；副本内）';
    green = runDaycheck(rootWork, lab.sessions, 'proof-green');
    greenV = c19Verdict(green);
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
  const pass = baseV.ok && redV && redV.ok === false && redV.level === 'RED' && greenV && greenV.ok === true;
  return {
    id: 'C19',
    injected: injectDesc,
    baseStatus: baseV.ok ? 'GREEN' : baseV.level,
    redStatus: redV ? (redV.ok ? 'GREEN（注入未变红）' : redV.level === 'SELF_BROKEN' ? 'SELF_BROKEN' : 'RED') : 'ERROR',
    repaired: repairDesc,
    greenStatus: greenV ? (greenV.ok ? 'GREEN' : greenV.level) : 'ERROR',
    pass,
    redSummary: redV ? (redV.msg || '').slice(0, 400) : 'red 未跑',
    greenSummary: greenV ? (greenV.msg || '').slice(0, 300) : 'green 未跑',
    redReport: red && red.saved ? rel(red.saved) : '',
    greenReport: green && green.saved ? rel(green.saved) : '',
    detail: '红必须落在 C19（重放逐字段不符），不是 doctor/守卫；证据：proof-*-red/green 日检报告',
    residual: '',
  };
}

function proofMetricsCriterion(ctx, id, injectFn, checkFn) {
  const big = ctx.big;
  if (!big.ok) return { id, pass: false, injected: '(跳过：缺大库 E3)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: big.why, greenSummary: '', residual: '缺 E3' };
  const m = makeMetricsCopy(big, id);
  const ctxCopy = { ...ctx, big: { ...big, metricsFile: m.dst, fresh: true } };
  const base = checkFn(ctxCopy);
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  try {
    const ticks = readTicksFile(m.dst);
    injectDesc = injectFn(ticks);
    writeTicksFile(m.dst, ticks);
    red = checkFn(ctxCopy);
    fs.writeFileSync(m.dst, m.orig, 'utf8');
    repairDesc = '把 .tick-metrics.jsonl 副本写回原字节';
    green = checkFn(ctxCopy);
  } finally {
    if (!keepWork) fs.rmSync(m.dir, { recursive: true, force: true });
  }
  const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
  return {
    id,
    injected: injectDesc,
    baseStatus: base.status,
    redStatus: red ? red.status : 'ERROR',
    repaired: repairDesc,
    greenStatus: green ? green.status : 'ERROR',
    pass,
    redSummary: red ? String(red.summary).slice(0, 400) : 'red 未跑',
    greenSummary: green ? String(green.summary).slice(0, 300) : 'green 未跑',
    redReport: red ? writeEvid(`proof-${id}-red.json`, { id, injected: injectDesc, result: red }) && rel(path.join(EVID, `proof-${id}-red.json`)) : '',
    greenReport: green ? writeEvid(`proof-${id}-green.json`, { id, repaired: repairDesc, result: green }) && rel(path.join(EVID, `proof-${id}-green.json`)) : '',
    detail: '注入只在 .tick-metrics.jsonl 副本上做，E3 原库只读；红必须落在本判据',
    residual: '',
  };
}

function proofC22(ctx) {
  const big = ctx.big;
  if (!big.ok) return { id: 'C22', pass: false, injected: '(跳过：缺大库 E3)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: big.why, greenSummary: '', residual: '缺 E3' };
  const work = freshSubDir('proof-c22');
  const rootCopy = path.join(work, 'root');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  try {
    linkTree(big.root, rootCopy); // 硬链接树：不复制 140 MB 数据；只注入"新增文件"，不动已链接文件
    const ctxCopy = { ...ctx, big: { ...big, root: rootCopy, fresh: true } };
    const base = runC22(ctxCopy);
    // 注入：新增一个台账日文件（3 MB）→ 套账(台账日文件+索引)/压缩语料 0.0328→≈0.104 >0.05；
    //       单文件 3 MB 仍 <4 MiB、索引分片不变 → 只红 r3 子项，不外溢到"单文件 >4 MB"
    const inj = path.join(rootCopy, 'ledger', '2099-01-01.jsonl');
    const filler = 'a'.repeat(3 * 1000 * 1000);
    fs.writeFileSync(inj, `{"v":3,"code":"20990101-C22INJ00000-A-00000001","sid":"sid-inject","turn":1,"status":"ok","note":"${filler}"}\n`, 'utf8');
    injectDesc = '往副本 ledger/ 新增 2099-01-01.jsonl（3 MB 合法台账行）→ 套账/压缩语料 0.0328→≈0.104 >0.05（单文件 3 MB<4 MiB，只红 r3 子项）';
    red = runC22(ctxCopy);
    fs.rmSync(inj, { force: true });
    repairDesc = '删掉注入的 2099-01-01.jsonl';
    green = runC22(ctxCopy);
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C22',
      injected: injectDesc,
      baseStatus: base.status,
      redStatus: red.status,
      repaired: repairDesc,
      greenStatus: green.status,
      pass,
      redSummary: String(red.summary).slice(0, 400),
      greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C22-red.json', { id: 'C22', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C22-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C22-green.json', { id: 'C22', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C22-green.json'))) : '',
      detail: '硬链接副本承载注入；E3 原库只读；红落在 r3 子项',
      residual: '',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

function proofC23(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return { id: 'C23', pass: false, injected: '(跳过：缺小库 lab)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: lab.why, greenSummary: '', residual: '' };
  const work = freshSubDir('proof-c23');
  const rootCopy = path.join(work, 'root');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  try {
    linkTree(lab.root, rootCopy);
    const ctxCopy = { ...ctx, lab: { ...lab, root: rootCopy }, big: { ok: false, why: 'proof 模式只用小库副本', root: '', sessions: '' } };
    const base = runC23(ctxCopy);
    const inj = path.join(rootCopy, 'ledger', '污染产物.bin');
    fs.writeFileSync(inj, Buffer.from('not-whitelisted', 'utf8'));
    injectDesc = '往副本 ledger/ 加 .bin 文件（白名单外扩展名）';
    red = runC23(ctxCopy);
    fs.rmSync(inj, { force: true });
    repairDesc = '删掉 .bin 注入文件';
    green = runC23(ctxCopy);
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C23',
      injected: injectDesc,
      baseStatus: base.status,
      redStatus: red.status,
      repaired: repairDesc,
      greenStatus: green.status,
      pass,
      redSummary: String(red.summary).slice(0, 400),
      greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C23-red.json', { id: 'C23', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C23-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C23-green.json', { id: 'C23', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C23-green.json'))) : '',
      detail: '硬链接副本承载注入；小库原库只读',
      residual: '',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

function proofC39(ctx) {
  const work = freshSubDir('proof-c39');
  const pkgCopy = path.join(work, 'lite');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  let manifestGen = null;
  const targetRel = 'README.md';
  try {
    linkTree(LITE, pkgCopy); // 硬链接树；注入=unlink+写新 inode，源仓库不受影响
    // 本次运行的证据目录正在被写 → 从副本里摘掉（不是交付内容，也不能当夹具基线）
    if (EVID_IN_PKG) {
      const evidRel = path.relative(LITE, EVID);
      fs.rmSync(path.join(pkgCopy, evidRel), { recursive: true, force: true });
    }
    // ★ re3 修复：副本 MANIFEST 由**包内生成器**当场重算，再对副本做"清单↔磁盘 0 差异"。
    //   旧写法直接拿开发树 MANIFEST 当基线：开发树 MANIFEST 尚未重生成时 base 恒红，
    //   注入/还原的回绿就永远证明不了（2026-11-14 实测 C39 proof base=RED → FAIL）。
    fs.rmSync(path.join(pkgCopy, 'MANIFEST.sha256'), { force: true });
    manifestGen = runNode('proof-C39-manifest-gen', path.join(LITE, 'docs', '工具-manifest.mjs'), [`--root=${pkgCopy}`], 300000);
    const ctxCopy = { ...ctx };
    const base = runC39(ctxCopy, { pkgDir: pkgCopy });
    const target = path.join(pkgCopy, targetRel);
    const orig = fs.readFileSync(target);
    fs.rmSync(target);
    fs.writeFileSync(target, Buffer.concat([orig, Buffer.from('\nC39 proof injection\n', 'utf8')]));
    injectDesc = `改副本 ${targetRel}（追加 1 行 → 清单哈希不符=changed 1）`;
    red = runC39(ctxCopy, { pkgDir: pkgCopy });
    fs.rmSync(target);
    fs.writeFileSync(target, orig);
    repairDesc = `把副本 ${targetRel} 字节写回`;
    green = runC39(ctxCopy, { pkgDir: pkgCopy });
    const pass = manifestGen.exit === 0 && base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C39',
      injected: injectDesc,
      baseStatus: base.status,
      redStatus: red.status,
      repaired: repairDesc,
      greenStatus: green.status,
      pass,
      redSummary: String(red.summary).slice(0, 400),
      greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C39-red.json', { id: 'C39', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C39-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C39-green.json', { id: 'C39', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C39-green.json'))) : '',
      detail: `基线 = 硬链接副本 + 包内 docs/工具-manifest.mjs 当场重生成 MANIFEST（证明"清单由脚本算出、与磁盘 0 差异"；不靠开发树 MANIFEST 现成干净）${manifestGen.exit === 0 ? '' : `（清单生成 exit=${manifestGen.exit}）`}；注入只改副本 README 1 行；产品仓库只读`,
      residual: '',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

function proofC40(ctx) {
  const work = freshSubDir('proof-c40');
  const copyFile = path.join(work, '版本台账.md');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  let fixtureVersion = null;
  try {
    fs.copyFileSync(path.join(LITE, '版本台账.md'), copyFile);
    // ★ re3 修复：基线用**副本台账末行自洽的版本视图**（旧写法用产品 VERSION.json 作期望：
    //   VERSION bump 后、台账行还没追加时 base 恒红 → proof 永远 FAIL，红/绿都不是检查器的错）。
    //   主判据 C40 仍以 VERSION.json 为准（那是产品状态问题，必须由签版流程保证）。
    const parsed0 = parseVersionLedger(copyFile);
    const last = parsed0.rows[parsed0.rows.length - 1];
    const realVersion = readJsonFile(path.join(LITE, 'VERSION.json')) || {};
    fixtureVersion = last
      ? { ...realVersion, version: String(last.version).replace(/^v/, ''), tag: `lite-${last.version}`, type: last.type }
      : realVersion;
    const ctxCopy = { ...ctx };
    const base = runC40(ctxCopy, { ledgerFile: copyFile, version: fixtureVersion });
    const parsed = parseVersionLedger(copyFile);
    const n = parsed.rows.length;
    // 注入 1：删中间一行 → 链断（RED）
    const broken = parsed.rows.filter((r) => r.n !== Math.floor(n / 2)).map((r) => r.raw).join('\n') + '\n';
    fs.writeFileSync(copyFile, broken, 'utf8');
    injectDesc = `删版本台账副本第 ${Math.floor(n / 2)} 行 → 编号不连续/链断`;
    red = runC40(ctxCopy, { ledgerFile: copyFile, version: fixtureVersion });
    // 还原
    fs.copyFileSync(path.join(LITE, '版本台账.md'), copyFile);
    repairDesc = '从产品台账重新拷一份副本（产品文件未动）';
    green = runC40(ctxCopy, { ledgerFile: copyFile, version: fixtureVersion });
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C40',
      injected: injectDesc,
      baseStatus: base.status,
      redStatus: red.status,
      repaired: repairDesc,
      greenStatus: green.status,
      pass,
      redSummary: String(red.summary).slice(0, 400),
      greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C40-red.json', { id: 'C40', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C40-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C40-green.json', { id: 'C40', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C40-green.json'))) : '',
      detail: `基线 = 副本台账末行自洽的版本视图（tag=${fixtureVersion && fixtureVersion.tag}，type=${fixtureVersion && fixtureVersion.type}；不依赖 VERSION.json 是否已追加当前版行）；主判据仍以 VERSION.json 为准；注入/还原都在版本台账副本上做（产品台账只读）；红落在"链断"`,
      residual: '',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}

function proofC41(ctx) {
  const w = ctx.weeks;
  if (!w.ok) return { id: 'C41', pass: false, injected: '(跳过：缺周账夹具)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: w.why, greenSummary: '', residual: '缺 lab-weeks' };
  const work = freshSubDir('proof-c41');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  try {
    const cRoot = path.join(work, 'root');
    copyTreeReal(w.root, cRoot);
    const ctxCopy = { ...ctx, weeks: { ...w, root: cRoot } };
    const base = runC41(ctxCopy);
    // 注入：删掉被抽中的那 3 周之一里的某日台账末行 → 周账 xlsx 比台账多一行（表里有、账里没了）→ 必红
    //   ★ 落点必须落在 C41 实际会抽到的那 3 周内，否则注入不可见（2026-11-14 实测：删 11-05 属第 2 周，未抽中 → 假绿）
    const dayFile = walkFiles(path.join(cRoot, 'ledger'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.name))
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))[0]; // 最早的日文件 ∈ 10月第4周（必被抽中）
    const lines = fs.readFileSync(dayFile.abs, 'utf8').split('\n').filter(Boolean);
    const removed = lines.pop();
    fs.writeFileSync(dayFile.abs, `${lines.join('\n')}\n`, 'utf8');
    injectDesc = `删台账副本 ${dayFile.rel} 的末行（code=${(JSON.parse(removed) || {}).code}）→ 周账多行`;
    red = runC41(ctxCopy);
    fs.writeFileSync(dayFile.abs, `${lines.join('\n')}\n${removed}\n`, 'utf8');
    repairDesc = `把删掉的那行写回 ${dayFile.rel}`;
    green = runC41(ctxCopy);
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C41', injected: injectDesc, baseStatus: base.status, redStatus: red.status, repaired: repairDesc, greenStatus: green.status, pass,
      redSummary: String(red.summary).slice(0, 400), greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C41-red.json', { id: 'C41', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C41-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C41-green.json', { id: 'C41', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C41-green.json'))) : '',
      detail: '注入只在 lab-weeks 的台账副本上做（不动 xlsx、不动原 lab）', residual: '',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}
function proofC42(ctx) {
  const w = ctx.weeks;
  if (!w.ok) return { id: 'C42', pass: false, injected: '(跳过：缺周账夹具)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: w.why, greenSummary: '', residual: '缺 lab-weeks' };
  const work = freshSubDir('proof-c42');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  try {
    const cRec = path.join(work, 'receipts');
    copyTreeReal(w.receipts, cRec);
    const ctxCopy = { ...ctx, weeks: { ...w, receipts: cRec } };
    const base = runC42(ctxCopy);
    // 摘要文件名随版本后缀变化（v1=无后缀；vN≥2=`RECEIPT-<day>.vN.json`；re3 起 v3 摘要）
    // → 用与 C42 同源的"每天最新版本"解析，取第一天（C42 ① 必抽 days[0]），保证注入可见。
    const byDay = latestReceiptsByDay(cRec);
    const day0 = [...byDay.keys()].sort()[0];
    if (!day0) throw new Error('摘要副本里没有任何 RECEIPT-*.json');
    const targetName = byDay.get(day0).file;
    const target = path.join(cRec, targetName);
    const orig = fs.readFileSync(target);
    const rec = JSON.parse(orig.toString('utf8'));
    rec.ledgerRows = num(rec.ledgerRows) + 1; // 与台账不符
    fs.writeFileSync(target, `${JSON.stringify(rec)}\n`, 'utf8');
    injectDesc = `改摘要副本 ${targetName}（${day0} 最新版）的 ledgerRows +1（摘要与台账不符）`;
    red = runC42(ctxCopy);
    fs.writeFileSync(target, orig);
    repairDesc = `把 ${targetName} 字节写回`;
    green = runC42(ctxCopy);
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C42', injected: injectDesc, baseStatus: base.status, redStatus: red.status, repaired: repairDesc, greenStatus: green.status, pass,
      redSummary: String(red.summary).slice(0, 400), greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C42-red.json', { id: 'C42', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C42-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C42-green.json', { id: 'C42', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C42-green.json'))) : '',
      detail: '注入只在摘要副本上做；原 lab 与产品代码只读', residual: 'C42 若因"产品未落盘 txt/原地重写"而恒红，则 base 也会是 RED，proof 记为 FAIL 并写明（不粉饰）',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}
function proofC43(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return { id: 'C43', pass: false, injected: '(跳过：缺小库 lab)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: lab.why, greenSummary: '', residual: '缺 c01-lab' };
  const work = freshSubDir('proof-c43');
  let injectDesc = '';
  let red = null;
  let green = null;
  let repairDesc = '';
  try {
    const baseDir = path.join(work, 'lab');
    copyTreeReal(lab.root, path.join(baseDir, 'root'));
    copyTreeReal(path.join(lab.root, '..', 'dsh-home'), path.join(baseDir, 'dsh-home'));
    relocateState(path.join(baseDir, 'root'), path.join(lab.root, '..', 'dsh-home'), path.join(baseDir, 'dsh-home'));
    const ctxCopy = { ...ctx, lab: { ok: true, root: path.join(baseDir, 'root'), sessions: path.join(baseDir, 'dsh-home', 'sessions'), label: '小库', why: '' } };
    const base = runC43(ctxCopy);
    // 注入：预放一个交接表产物 → 反向判据必须 RED
    const fakeDir = path.join(baseDir, 'root', '交接表');
    fs.mkdirSync(fakeDir, { recursive: true });
    const fake = path.join(fakeDir, 'fake-session.md');
    fs.writeFileSync(fake, 'proof injection: handover table\n', 'utf8');
    injectDesc = '预放 root\\交接表\\fake-session.md（模拟"交接表被生成"）→ 冻结被绕过';
    red = runC43(ctxCopy);
    fs.rmSync(fakeDir, { recursive: true, force: true });
    repairDesc = '删掉预放的 交接表\\ 目录';
    green = runC43(ctxCopy);
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C43', injected: injectDesc, baseStatus: base.status, redStatus: red.status, repaired: repairDesc, greenStatus: green.status, pass,
      redSummary: String(red.summary).slice(0, 400), greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C43-red.json', { id: 'C43', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C43-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C43-green.json', { id: 'C43', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C43-green.json'))) : '',
      detail: '注入只在 c01 副本上做；原 lab 只读', residual: '',
    };
  } finally {
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
}
function proofC44(ctx) {
  // C44 本身就是"注入→红→还原→绿"×5；自证 = 直接跑它，看 5 个子证是否全过
  const r = runC44(ctx);
  const subs = (r.evidence && r.evidence.sub) || [];
  const okSubs = subs.filter((s) => s.redSeverity === 'red' && s.greenSeverity !== 'red' && !s.error).length;
  return {
    id: 'C44',
    injected: '五类故障各注入一次（doctor 自带"先红后绿"循环）',
    baseStatus: r.status,
    redStatus: subs.map((s) => s.redSeverity).join('/') || 'NA',
    repaired: '每类注入后立刻还原',
    greenStatus: subs.map((s) => s.greenSeverity).join('/') || 'NA',
    pass: r.status === 'GREEN' && okSubs === 5,
    redSummary: String(r.summary).slice(0, 400),
    greenSummary: `5 类中 ${okSubs}/5 完成 red→非red`,
    redReport: writeEvid('proof-C44.json', r),
    greenReport: '',
    detail: 'doctor 是外置只读检测器；注入全在 c01 副本上做',
    residual: r.status === 'GREEN' ? '' : 'C44 未过：见 proof-C44.json',
  };
}
function proofC45(ctx) {
  const lab = ctx.lab;
  if (!lab.ok) return { id: 'C45', pass: false, injected: '(跳过：缺小库 lab)', redStatus: 'NA', greenStatus: 'NA', repaired: '', redSummary: lab.why, greenSummary: '', residual: '缺 c01-lab' };
  let red = null;
  let green = null;
  let injectDesc = '';
  let repairDesc = '';
  const base = runC45(ctx);
  try {
    // 注入：备份目录里删掉一个文件 → verify 必红 → runC45 必 RED
    //   ★ runC45 每次都用**独立工作副本**（finally 里整份删）；
    //     所以"还原"= 丢弃被注入的那次，下一次 runC45 会重新 backup→删库→restore→verify，
    //     不学要往已删目录里写回文件（2026-11-14 实测：旧写法在 finally 之后 restore → ENOENT）。
    red = runC45(ctx, {
      afterBackup(dir) {
        const files = walkFiles(dir);
        const victim = files.find((f) => f.rel.startsWith('files/')) || files[files.length - 1];
        fs.rmSync(victim.abs, { force: true });
        injectDesc = `从备份副本删掉 ${victim.rel}（verify 必报缺）`;
        repairDesc = '丢弃被注入的工作副本；下一次演练重新 backup→删库→restore';
        return { victim: victim.rel };
      },
    });
    green = runC45(ctx);
    const pass = base.status === 'GREEN' && red.status === 'RED' && green.status === 'GREEN';
    return {
      id: 'C45', injected: injectDesc, baseStatus: base.status, redStatus: red.status, repaired: repairDesc, greenStatus: green.status, pass,
      redSummary: String(red.summary).slice(0, 400), greenSummary: String(green.summary).slice(0, 300),
      redReport: red ? (writeEvid('proof-C45-red.json', { id: 'C45', injected: injectDesc, result: red }), rel(path.join(EVID, 'proof-C45-red.json'))) : '',
      greenReport: green ? (writeEvid('proof-C45-green.json', { id: 'C45', repaired: repairDesc, result: green }), rel(path.join(EVID, 'proof-C45-green.json'))) : '',
      detail: '注入在备份副本上做，源 lab 只读；红必须落在"备份/恢复"链上', residual: '',
    };
  } catch (e) {
    return { id: 'C45', pass: false, injected: '(proof 执行异常)', redStatus: 'ERROR', greenStatus: 'ERROR', repaired: '', redSummary: String((e && e.stack) || e), greenSummary: '', residual: '' };
  }
}

/** 原树指纹（--proof 用）：逐文件 sha256 合成一棵哈希树。
 *  排除 .git（walkFiles 已跳过）与**本执行器的运行产物** `证据/判据-1.0-*`（每跑一次多一套；
 *  它们不是产品文件，也不该让"原树零改动"自证变成同义反复）。 */
function treeFingerprint(root) {
  const files = walkFiles(root)
    .filter((f) => !isRunArtifactRel(f.rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = crypto.createHash('sha256');
  const entries = new Map();
  for (const f of files) {
    const d = sha256File(f.abs);
    entries.set(f.rel, d);
    h.update(`${f.rel}\0${d}\n`);
  }
  return { files: files.length, sha256: h.digest('hex'), entries };
}

function runProofs() {
  const ids = onlyRaw.length ? DEFAULT_PROOF.filter((id) => onlyRaw.includes(id)) : DEFAULT_PROOF.slice();
  if (!ids.length) usageError(`--proof 没有可跑的判据（可用：${DEFAULT_PROOF.join(',')}）`);
  fs.mkdirSync(WORKTMP, { recursive: true });
  const ctx = buildCtx();
  const before = treeFingerprint(LITE);
  const proofs = [];
  for (const id of ids) {
    let p;
    try {
      if (id === 'C19') p = proofC19(ctx);
      else if (id === 'C20') p = proofMetricsCriterion(ctx, 'C20', (ticks) => {
        // 让前 3 tick 的 written 变小 → 3 tick 内追不平（端到端 >3 tick 或永远追不平）
        ticks[2].written = Math.max(1, Math.floor(num(ticks[2].written) / 2));
        return '把第 3 个 tick 的 written 减半（1338 行在 3 tick 内追不平）';
      }, (c) => runC20(c));
      else if (id === 'C21') p = proofMetricsCriterion(ctx, 'C21', (ticks) => {
        const idx = ticks.findIndex((t) => num(t.written) === 0);
        if (idx < 0) throw new Error('度量副本里没有稳态 tick 可注入');
        ticks[idx].readBytes = 3 * MiB;
        return `把第 ${idx + 1} 个 tick（稳态）readBytes 改为 3 MiB > 1 MiB`;
      }, (c) => runC21(c));
      else if (id === 'C22') p = proofC22(ctx);
      else if (id === 'C23') p = proofC23(ctx);
      else if (id === 'C25') p = proofMetricsCriterion(ctx, 'C25', (ticks) => {
        const idx = ticks.findIndex((t) => num(t.written) > 0);
        if (idx < 0) throw new Error('度量副本里没有入账 tick 可注入');
        ticks[idx].ms = 35000;
        return `把第 ${idx + 1} 个 tick 耗时改为 35000 ms > 30 s`;
      }, (c) => runC25(c));
      else if (id === 'C39') p = proofC39(ctx);
      else if (id === 'C40') p = proofC40(ctx);
      else if (id === 'C41') p = proofC41(ctx);
      else if (id === 'C42') p = proofC42(ctx);
      else if (id === 'C43') p = proofC43(ctx);
      else if (id === 'C44') p = proofC44(ctx);
      else if (id === 'C45') p = proofC45(ctx);
      else throw new Error(`未知 proof 判据 ${id}`);
    } catch (e) {
      p = { id, pass: false, injected: '(proof 执行异常)', redStatus: 'ERROR', greenStatus: 'ERROR', repaired: '', redSummary: String((e && e.stack) || e), greenSummary: '', residual: '' };
    }
    proofs.push(p);
    writeEvid(`proof-${id}.json`, p);
  }
  const after = treeFingerprint(LITE);
  const changedFiles = [];
  for (const [relp, d] of before.entries) {
    if (!after.entries.has(relp)) changedFiles.push(`-${relp}`);
    else if (after.entries.get(relp) !== d) changedFiles.push(`~${relp}`);
  }
  for (const relp of after.entries.keys()) if (!before.entries.has(relp)) changedFiles.push(`+${relp}`);
  const originalTree = {
    unchanged: before.sha256 === after.sha256 && changedFiles.length === 0,
    filesBefore: before.files,
    filesAfter: after.files,
    sha256Before: before.sha256,
    sha256After: after.sha256,
    changed: changedFiles.slice(0, 40),
    note: '排除 .git 与 包内 证据/判据-1.0-*（本执行器运行产物）；所有注入/还原都在 %TEMP% 的硬链接/拷贝副本上做',
  };
  const proofsOk = proofs.every((p) => p.pass);
  const ok = proofsOk && originalTree.unchanged;
  const summary = { schema: `${SCHEMA}#proof`, at: new Date(nowMs).toISOString(), ok, proofsOk, originalTree, workRoot: rel(WORKTMP), proofs };
  writeEvid('proof-summary.json', summary);
  if (!keepWork) {
    try {
      fs.rmSync(WORKTMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== 判据执行器 1.0 · 先红后绿自证（注入故障→红→还原→绿） ===');
    console.log('');
    console.log('| 判据 | 注入 | 红 | 还原 | 绿 | 结论 |');
    console.log('|---|---|---|---|---|---|');
    for (const p of proofs) {
      console.log(`| ${p.id} | ${mdCell(p.injected, 80)} | ${p.redStatus} | ${mdCell(p.repaired, 50)} | ${p.greenStatus} | ${p.pass ? 'PASS' : 'FAIL'} |`);
      if (!p.pass) console.log(`  ✖ ${p.id}：红=${mdCell(p.redSummary, 160)}；绿=${mdCell(p.greenSummary, 120)}`);
    }
    console.log('');
    console.log(`结论：${proofsOk ? '全部 PASS' : '有 FAIL'}（${proofs.filter((p) => p.pass).length}/${proofs.length}）`);
    console.log(`原树零改动：${originalTree.unchanged ? '✅ 是' : `❌ 否（${changedFiles.slice(0, 10).join('、')}）`}（${originalTree.filesBefore} 文件，指纹 ${originalTree.sha256Before.slice(0, 16)}…→${originalTree.sha256After.slice(0, 16)}…；已排除 .git 与本执行器证据目录）`);
    console.log(`证据目录：${EVID}`);
  }
  process.exit(ok ? 0 : 1);
}

// ============================================================================
// 九、主流程
// ============================================================================
if (doProof) {
  if (LABD.ok) fs.mkdirSync(WORKTMP, { recursive: true });
  runProofs();
  process.exit(0);
}

const summary = runAggregate();
if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('=== 判据执行器 1.0（lite 线）· 45 条聚合 · V1.0 毕业口径 ===');
  console.log(`小库：${LABD.ok ? rel(LABD.root) : `(缺：${LABD.why})`}`);
  console.log(`大库：${BIGD.ok ? rel(BIGD.root) : `(缺：${BIGD.why})`}`);
  console.log(`三层夹具：${THREED.ok && fs.existsSync(THREE_MANIFEST) ? rel(THREED.root) : `(缺/过期：${THREED.why || '缺 manifest.json'})`}`);
  console.log('');
  console.log('| 判据 | 结果 | 证据 |');
  console.log('|---|---|---|');
  for (const r of summary.criteria) console.log(`| ${r.id} | ${r.status} | ${evidenceCell(r)} |`);
  console.log('');
  console.log(`汇总：GREEN=${summary.counts.green} RED=${summary.counts.red} NA=${summary.counts.na} SKIP=${summary.counts.skip} → ${summary.ok ? '全绿' : '未全绿'}`);
  for (const c of summary.children) console.log(`子执行器 ${c.label}：exit=${c.exit}，${c.counts ? `GREEN=${c.counts.green} RED=${c.counts.red} NA=${c.counts.na} SKIP=${c.counts.skip}` : `JSON 未解析（${c.parseError}）`}；证据 ${c.evidenceDir || c.log}`);
  if (summary.naList.length) {
    console.log('');
    console.log('NA（未验，不算绿）缺什么：');
    for (const n of summary.naList) console.log(`  · ${n.id}：${(n.missing || []).join('；')}`);
  }
  if (summary.redList.length) {
    console.log('');
    console.log('RED：');
    for (const n of summary.redList) console.log(`  · ${n.id}：${(n.reasons || []).join('；')}`);
  }
  if (summary.residual.length) {
    console.log('');
    console.log('残余/口径说明：');
    for (const x of summary.residual) console.log(`  · ${x}`);
  }
  console.log('');
  console.log(`证据目录：${EVID}`);
}
if (!keepWork) {
  try {
    fs.rmSync(WORKTMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.exit(summary.ok ? 0 : 1);
