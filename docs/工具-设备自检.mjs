#!/usr/bin/env node
/**
 * @file docs/工具-设备自检.mjs
 * @role **三台设备验收（v1.0.0-re）的设备自检脚本**：把《三台设备测试-准备清单》§二/§三
 *       要收集的东西做成**一次运行、一份 JSON + 一页 MD、可退出码判定**的自检。
 *       目标不是"三台都说没问题"，而是"同一套检查、逐项输出一致"（S-5 口径）。
 *
 * @why 为什么要一个"设备自检"而不是让机主手工跑 7 个工具：
 *   ① 设备上只有包和账库，没有本机这套夹具与证据目录；7 个工具各自有用法/参数/输出形状，
 *      手工跑容易漏项、口径不一致（尤其 E3 只读统计与 MANIFEST 校验）；
 *   ② 验收要带回来的是一份固定形状的机器可读结果，而不是七份不同格式的日志；
 *   ③ 单项失败不许拖垮整份：每项独立 try/catch，记 `status:'error'` 与原因，
 *      并且"检查没跑起来"绝不记为绿（未验 = na、异常 = error，两者都不算绿）。
 *
 * @why 为什么每项都标`只读`，写入只允许 `--out`：
 *   设备上的账库是**机主的真实数据**。本脚本只调用只读原语：
 *   · `ledger.readAll({requireLedgerRows:true, repairTornTail:false})` —— 显式关掉"撕裂尾巴自愈"，
 *     因为自愈是**写动作**（会截断账文件）；
 *   · `legacy.scanSessionSources()/readSourceTurns()` —— 不传 root，读函数零副作用（不写 .lost/.errors）；
 *   · `tools/doctor.mjs --no-write` —— 只打印、不落报告；
 *   · `docs/replay-verify.mjs` 普通模式 —— 零写盘（它只在 `--mutate/--destroy` 时才动 tmp 克隆）；
 *   · `tools/core-boundary.mjs` / 内核边界检查 —— 只读包文件与基线哈希。
 *   唯一写点：`<out>/设备自检.json`、`<out>/设备自检.md`（外加 mkdir --out）。
 *
 * @why E3 项只做"只读统计"、绝不灌库：
 *   灌库是插件 tick 的职责，也是唯一写账库的动作。本脚本只数帧/闭合轮/预期行数，
 *   再与台账行数比对；设备上的真实入账由插件自己完成（跑 tick 到稳定后再跑本脚本）。
 *
 * 用法：
 *   node docs\工具-设备自检.mjs --out=<结果目录> [--root=<账库根>] [--package=<包目录>]
 *                               [--sessions=<sessions目录>] [--json] [--only=<ids>]
 *                               [--expect-gaps=<预期缺口.json>]
 *
 *   --expect-gaps=<file> 预期缺口清单（默认按 <包目录>/../02-语料/预期缺口.json 自动找）。
 *                        包不在交付根下时（如出包前自检证据生成）用它显式指定。
 *                        找不到/读不出 = fail-closed：gate=degraded 一律判红（不许豁免）。
 *
 *   --out=<目录>      必填。结果目录（脚本唯一写点）：写 `设备自检.json` / `设备自检.md`（UTF-8）
 *   --root=<账库根>   账库根（含 `ledger\`、月份目录、`.ledger-root`）。缺省时依赖它的项记 na（未验）
 *   --package=<包目录> 要校验的包。缺省 = 本脚本所在包（`docs\..`）。用于 MANIFEST / 边界 / 内核三项
 *   --sessions=<目录> DSH 会话目录（`<DSH_HOME>\sessions`）。e3 只读统计、c19 重放对账、doctor ③ 用；
 *                      缺省时这三项记 na。目录名不是 `sessions` 时若其下有 `sessions\` 会自动下钻
 *   --json            stdout **只**输出一份 JSON（结果仍照常落盘）；不加时 stdout 打印同一页 MD
 *   --only=a,b,...    只跑指定检查项（分项复跑 / 故障注入用）；其余项**不产出**，不算未验
 *   --help            打印本说明
 *
 *   检查项 id（执行顺序 = 下表顺序）：
 *     env           环境与设备指纹（OS/内存/磁盘/node/DSH 版本/插件版本）
 *     package       `--package` 下 `MANIFEST.sha256` 逐文件校验（缺/多/改必须全 0）
 *     ledger        台账四数：行数 / 唯一 code / 唯一 (sid,turn) / 坏行（+ 读错）
 *     tick-metrics  `<root>\ledger\.tick-metrics.jsonl` 最近 10 tick：ms/写入/读盘估算/预算
 *     run-report    最近一份 `.run-report-*.json` 的 gate/counts/errors
 *     e3            `--sessions` 只读统计：帧数 / 闭合轮数（=预期行数）/ 与台账行数比对（**不灌库**）
 *     c19           调 `docs\replay-verify.mjs --fields`（日检重放对账）
 *     doctor        调 `tools\doctor.mjs --no-write`，汇总 5 类结论
 *     boundary      调 `tools\core-boundary.mjs`，要求 0 violation
 *     kernel        调 `docs\验收-v0.5\工具-内核边界检查.mjs`，PASS/FAIL + 基线名
 *
 * 退出码（与 docs/工具-日检.mjs、docs/判据-0.9.1.mjs 的 0/1/2/3 风格一致）：
 *   0 = 无红、无未验、无异常（黄项不阻塞；黄项在 MD/JSON 里单独列，不要当绿读）
 *   1 = 有红（red>0）**或有未验**（na>0）——"未验 ≠ 通过"，与判据执行器同一口径
 *   2 = 用法/环境错误（缺 --out、目录不存在、--only 里有不存在的 id、结果目录写不进去）
 *   3 = 有子检查 `status:'error'`（工具起不来/输出不是 JSON/超时）或自检器自身异常
 *   说明：error 优先于 red 判 3（"检查没跑起来"必须比"检查发现红"更响）；red/na 同时存在时判 1。
 *
 * 输出形状（`设备自检.json`）：
 *   { schema, tool, toolVersion, generatedAt, elapsedMs, host, inputs, packageRoot,
 *     summary:{total,green,red,warn,na,error,ok,verdict,exitCode}, firstAction,
 *     checks:[{id,name,status,ok,detail,evidence,brief,ms}], unverified:[...], reds:[...],
 *     artifacts:{json,md}, readOnly:{...} }
 *   status ∈ green/red/warn/na/error；ok === (status==='green')。
 *
 * 已知边界（如实写）：
 *   · 本脚本面向 Windows（win32）。非 Windows 只把 env 记 warn，其它项照跑；
 *   · `--root` 必须是"该账库的**全集来源**"对应的 sessions（e3/c19 用全量重放口径），
 *     否则 e3 会如实报"缺 N / 多 N"——那不是脚本 bug，是两边不是同一份语料；
 *   · DSH 版本"能取则取"：依次读 DSH_VERSION / DSH_INSTALL_DIR\package.json /
 *     DSH_NODE_EXECUTABLE 旁的 resources\runtime\primary-runtime\runtime.json；
 *     都取不到记 na（不猜、不联网）；
 *   · tick-metrics 的读盘是插件写的**估算口径**（readBytesKind 字段），不是 OS 计数器；
 *     C21/C25 阈值按 S-9 签字口径：消费 ≤17 MiB/tick、读放大 ≤2.5×（≤40 MiB/tick）、
 *     ms ≤30 s；稳态（written=0）读盘 ≤1 MiB。超限判红，黄项不判红；
 *   · `.git` 不计入包内"多"（不是交付物）；`--out` 落在包内时其子树也不计入"多"（避免自污染）；
 *     若正式包要求"多=0"，打完包后应重算 MANIFEST 再跑本脚本（见交付说明）。
 *
 * @depends node:fs / node:os / node:path / node:crypto / node:child_process / node:url；
 *          本包 `lib/ledger.js`、`lib/legacy.js`（动态 import，失败只记单项 error）；
 *          本包 `docs/replay-verify.mjs`、`tools/doctor.mjs`、`tools/core-boundary.mjs`、
 *          `docs/验收-v0.5/工具-内核边界检查.mjs`（spawn 子进程，超时/退出码/JSON 都可判）。
 * @writes 仅 `<out>/设备自检.json` 与 `<out>/设备自检.md`（UTF-8，非原子，结果目录专用）。
 * @called-by 设备机主手工运行（装完包、跑 tick 到稳定之后）；不进 tick、不被 index.js import。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// 一、常量 / 用法
// ============================================================================

/** 结果 JSON 的 schema（改输出形状必须 +1）。 */
const SCHEMA = 'dsh-device-selfcheck/1';
/** 本工具版本（改检查口径/输出形状时 +1）。 */
const TOOL_VERSION = '1.0.0';
/** 全仓统一时区偏移（契约禁止 Z 结尾；+08:00）。 */
const OFFSET_MINUTES = 480;
/** 本脚本所在包（docs 的上一级）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
/** 当前 node 可执行文件（子工具一律用同一个 node，避免设备 PATH 里出现第二个 node）。 */
const NODE = process.execPath;
const NODE_MAJOR = Number(String(process.versions.node).split('.')[0]) || 0;

/** 检查项顺序（= 输出顺序；--only 时按此过滤）。 */
const CHECK_ORDER = ['env', 'package', 'ledger', 'tick-metrics', 'run-report', 'e3', 'c19', 'doctor', 'boundary', 'kernel'];
/** 检查项中文名。 */
const CHECK_NAMES = {
  env: '环境与设备指纹',
  package: '包完整性（MANIFEST.sha256）',
  ledger: '台账四数（行数/唯一 code/唯一 sid,turn/坏行）',
  'tick-metrics': '逐 tick 度量（ms/写入/读盘/预算）',
  'run-report': '最近运行报告（gate/counts/errors）',
  e3: 'E3 语料只读统计（不灌库）',
  c19: 'C19 日检重放对账',
  doctor: 'doctor 五类体检',
  boundary: '核心边界（0 violation）',
  kernel: '内核边界（基线 PASS/FAIL）',
};
/** "最该先看"排序：数字越小越先看（kernel/boundary 是安全底线，随后是账与包）。 */
const CHECK_PRIORITY = { kernel: 0, boundary: 1, ledger: 2, e3: 3, c19: 4, package: 5, doctor: 6, 'run-report': 7, 'tick-metrics': 8, env: 9 };

/** tick-metrics 默认看最近多少 tick。 */
const METRICS_N = 10;
/** C25：单 tick ≤30 秒（S-9 保留）。 */
const C25_MS_LIMIT = 30000;
/** S-9①：读盘消费 ≤17 MiB/tick。 */
const C25_CONSUMED_LIMIT = 17 * 1024 * 1024;
/** S-9①：读放大 ≤2.5× → ≤40 MiB/tick。 */
const C25_READ_LIMIT = 40 * 1024 * 1024;
/** C21：稳态（无变更）单 tick 读盘 ≤1 MiB。 */
const C21_STEADY_READ_LIMIT = 1 * 1024 * 1024;
/** MANIFEST 文件名（自指哈希不可能成立 → 不列入"多"）。 */
const MANIFEST_SELF = 'MANIFEST.sha256';

/** 用法文本（--help / 用法错误时打印）。 */
const USAGE = `用法：
  node docs\\工具-设备自检.mjs --out=<结果目录> [--root=<账库根>] [--package=<包目录>]
                              [--sessions=<sessions目录>] [--json] [--only=<ids>]

必填：
  --out=<目录>       结果目录（唯一写点）：设备自检.json / 设备自检.md
可选：
  --root=<账库根>    账库根；缺省时 ledger/tick-metrics/run-report/e3 比对/c19/doctor 记 na（未验）
  --package=<包目录> 要校验的包，缺省 = 本脚本所在包；用于 package/boundary/kernel
  --sessions=<目录>  DSH_HOME\\sessions；e3 只读统计 + c19 重放 + doctor ③ 用
  --json             stdout 只输出一份 JSON（仍落盘）
  --only=a,b,...     只跑指定检查项（分项复跑/故障注入），其余项不产出
  --help             打印本说明

检查项 id：${CHECK_ORDER.join(', ')}

退出码：0=无红/无未验/无异常（黄项不阻塞）；1=有红或有未验；2=用法/环境错误；3=有子检查 error 或自检器异常
只读纪律：除 --out 外不写任何文件；账库只走 readAll(requireLedgerRows:true, repairTornTail:false)；
          e3 只读统计、绝不灌库；doctor 用 --no-write。`;

/** 用法/环境错误（exit 2）。 */
class UsageError extends Error {}
/** 输出目录写不进去等环境错误（exit 2）。 */
class EnvError extends Error {}

// ============================================================================
// 二、小工具（时间/字节/格式化/JSON/哈希）
// ============================================================================

/** 错误 → 一行文本。 */
function errMsg(e) {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e;
  return String((e && e.message) || e);
}

/** 数字千分位（只用于人读）。 */
function nfmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : String(n);
}

/** 1024 进制字节 → "12.3 MiB"。 */
function bytesHuman(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? String(v) : v.toFixed(2)} ${units[i]}`;
}

/** 毫秒 → "248 ms" / "7.58 s"。 */
function msHuman(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

/** GiB 数值（2 位）。 */
function gib(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? Number((bytes / 1024 ** 3).toFixed(2)) : null;
}

/** 截断长文本（MD/明细用）。 */
function truncate(s, max = 300) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** MD 转义（表格里不能出现裸 | 与换行）。 */
function mdCell(s, max = 200) {
  return truncate(s, max).replace(/\|/g, '/');
}

/** 本地时区标记：`YYYY-MM-DD HH:mm:ss+08:00`（契约口径，禁 Z）。 */
function stampLocal(ms = Date.now(), offsetMinutes = OFFSET_MINUTES) {
  const d = new Date(ms + offsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

/** 本地时区 ISO 标记：`YYYY-MM-DDTHH:mm:ss+08:00`。 */
function isoLocal(ms = Date.now(), offsetMinutes = OFFSET_MINUTES) {
  const d = new Date(ms + offsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

/** 本地日期 `YYYY-MM-DD`（+08:00）。 */
function todayLocalYmd(ms = Date.now()) {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** `YYYY-MM-DD` → UTC 零点毫秒（只用于算天数差）。 */
function ymdToUtcMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 两个本地日期相差多少天（b 晚于 a 为正）。 */
function daysBetweenYmd(a, b) {
  const ma = ymdToUtcMs(a);
  const mb = ymdToUtcMs(b);
  return ma === null || mb === null ? null : Math.round((mb - ma) / 86400000);
}

/** 安全读 JSON（读不到/坏 JSON → null；只读）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 文件 sha256（1 MiB 分块流式，不整读大文件）。 */
function sha256FileSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 目录是否在另一个目录内（用于 --out 落在包内时排除自产文件）。 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 读文件末 maxBytes 字节并按行切（只为了取最近的 JSONL 行，不整读大文件）。 */
function readTailLines(file, maxBytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    // 窗口从行中间开始：丢掉第一个半行
    const i = text.indexOf('\n');
    text = i >= 0 ? text.slice(i + 1) : '';
  }
  return { text, size: st.size, windowBytes: len, windowStart: start };
}

/** 跑一个 node 子工具（零 shell；超时即杀）。 */
function runNodeTool(toolPath, args, timeoutMs) {
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(NODE, [toolPath, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return { exit: -1, stdout: '', stderr: '', error: errMsg(e), signal: '', ms: Date.now() - t0 };
  }
  const error = r.error ? `${r.error.code || ''} ${r.error.message || r.error}`.trim() : '';
  return {
    exit: typeof r.status === 'number' ? r.status : -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error,
    signal: r.signal || '',
    ms: Date.now() - t0,
  };
}

/** 解析子工具的 --json stdout（去掉可能的 BOM；失败抛错 → 该检查记 error）。 */
function parseToolJson(r, label) {
  const text = String(r.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error(`${label} 无 stdout（exit=${r.exit}${r.error ? '，' + r.error : ''}）`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} stdout 不是 JSON（exit=${r.exit}）：${truncate(text, 160)}`);
  }
}

/** 子进程失败时拼一段可审计的短错误（stdout 尾 + stderr 尾）。 */
function childFailureText(r) {
  const parts = [`exit=${r.exit}`];
  if (r.error) parts.push(`error=${r.error}`);
  if (r.signal) parts.push(`signal=${r.signal}`);
  if (r.stderr && r.stderr.trim()) parts.push(`stderr=${truncate(r.stderr, 300)}`);
  return parts.join('；');
}

// ============================================================================
// 三、参数解析与入口
// ============================================================================

/**
 * 解析 `--k=v` / 布尔 flag。
 * @returns {{opts:Map<string,string>, flags:Set<string>, unknown:string[]}}
 */
function parseArgv(list) {
  const opts = new Map();
  const flags = new Set();
  const unknown = [];
  for (const a of list) {
    if (a === '--json' || a === '--help' || a === '-h') { flags.add(a === '-h' ? 'help' : a.slice(2)); continue; }
    const m = /^--([a-zA-Z][a-zA-Z0-9-]*)=(.*)$/s.exec(a);
    if (!m) { unknown.push(a); continue; }
    opts.set(m[1], m[2]);
  }
  return { opts, flags, unknown };
}

/** 解析后得到的运行配置。 */
function resolveConfig() {
  const { opts, flags, unknown } = parseArgv(process.argv.slice(2));
  if (flags.has('help')) { process.stdout.write(`${USAGE}\n`); return { help: true }; }
  if (unknown.length) throw new UsageError(`未知参数：${unknown.join(' ')}\n\n${USAGE}`);
  const allowedOpts = new Set(['out', 'root', 'package', 'sessions', 'only', 'expect-gaps']);
  for (const k of opts.keys()) {
    if (!allowedOpts.has(k)) throw new UsageError(`未知参数：--${k}\n\n${USAGE}`);
  }
  const outRaw = (opts.get('out') || '').trim();
  if (!outRaw) throw new UsageError(`缺 --out=<结果目录>\n\n${USAGE}`);

  const asJson = flags.has('json');
  const out = path.resolve(outRaw);

  const dirArg = (k, label) => {
    const raw = (opts.get(k) || '').trim();
    if (!raw) return '';
    const abs = path.resolve(raw);
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (!st) throw new UsageError(`${label}不存在：${abs}`);
    if (!st.isDirectory()) throw new UsageError(`${label}不是目录：${abs}`);
    return abs;
  };

  const root = dirArg('root', '账库根');

  const pkgRaw = (opts.get('package') || '').trim();
  let packageDir = ROOT;
  if (pkgRaw) {
    packageDir = path.resolve(pkgRaw);
    let st = null;
    try { st = fs.statSync(packageDir); } catch { st = null; }
    if (!st) throw new UsageError(`包目录不存在：${packageDir}`);
    if (!st.isDirectory()) throw new UsageError(`包目录不是目录：${packageDir}`);
  }

  let sessions = dirArg('sessions', 'sessions 目录');
  // 容错：--sessions 指向 DSH_HOME 而不是 sessions 时自动下钻一层（并如实写进 inputs）
  if (sessions) {
    const inner = path.join(sessions, 'sessions');
    if (path.basename(sessions) !== 'sessions' && fs.existsSync(inner)) {
      try { if (fs.statSync(inner).isDirectory()) sessions = inner; } catch { /* 保持原值 */ }
    }
  }

  const onlyRaw = (opts.get('only') || '').trim();
  let only = null;
  if (onlyRaw) {
    const ids = onlyRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new UsageError(`--only 为空\n\n${USAGE}`);
    const bad = ids.filter((id) => !CHECK_ORDER.includes(id));
    if (bad.length) throw new UsageError(`--only 里有不存在的检查项：${bad.join(', ')}（合法：${CHECK_ORDER.join(', ')}）`);
    only = CHECK_ORDER.filter((id) => ids.includes(id));
  }

  // 结果目录：唯一写点；建不出来 = 环境错误（exit 2）
  try {
    fs.mkdirSync(out, { recursive: true });
    const st = fs.statSync(out);
    if (!st.isDirectory()) throw new Error('不是目录');
  } catch (e) {
    throw new EnvError(`结果目录建不出来：${out}（${errMsg(e)}）`);
  }

  // ★ 预期缺口清单可显式指定（包不在交付根下时 —— 如出包前自检证据生成 —— 用它；
  //   正常接收端默认按 <01-插件包>/../02-语料/预期缺口.json 自动找）。
  const expectGapsRaw = (opts.get('expect-gaps') || '').trim();
  let expectGaps = '';
  if (expectGapsRaw) {
    expectGaps = path.resolve(expectGapsRaw);
    if (!fs.existsSync(expectGaps)) throw new UsageError('预期缺口清单不存在：' + expectGaps);
  }
  return { help: false, asJson, out, root, packageDir, sessions, only, expectGaps };
}

/**
 * 版本文本：`version` 已自带 `-type` 后缀时不再重复拼接。
 * @why V1.0.0-re2 起 VERSION.json.version 就是 `1.0.0-re2`（type=re2），
 *      旧写法 `${version}-${type}` 会输出 `1.0.0-re2-re2`（E 线出包实测到）。
 */
function versionLabel(p) {
  const v = String((p && p.version) || '');
  const t = String((p && p.type) || '');
  if (!v) return t;
  return v.endsWith('-' + t) || !t ? v : `${v} ${t}`;
}

/** 主流程。返回退出码（0/1/2/3）。 */
async function main() {
  const t0 = Date.now();
  const cfg = resolveConfig();
  if (cfg.help) return 0;

  const ctx = {
    ...cfg,
    /** 已选检查项（--only 时为子集；否则全部）。 */
    selected: cfg.only ? [...cfg.only] : [...CHECK_ORDER],
    envSnapshot: null,
    ledgerSnapshot: null,
    ledgerError: null,
    ledgerPromise: null,
    results: [],
  };

  for (const id of ctx.selected) {
    await runCheck(ctx, id);
  }

  const elapsedMs = Date.now() - t0;
  const summary = summarize(ctx.results);
  const firstAction = pickFirstAction(ctx.results);
  const generatedAt = isoLocal(Date.now());
  const envCheck = ctx.results.find((r) => r.id === 'env');
  // env 项被 --only 跳过时，页眉也要有可读的设备指纹（纯只读，失败一律降级 null）
  const basicHost = (() => {
    const out = {
      hostname: os.hostname(),
      platform: (typeof os.version === 'function' ? os.version() : `${os.type()} ${os.release()}`).trim(),
      arch: os.arch(),
      node: process.versions.node,
      dshVersion: null,
      plugin: null,
    };
    try {
      const dsh = detectDshVersion();
      out.dshVersion = dsh.version || null;
    } catch { /* 降级 */ }
    try {
      const p = readJsonSafe(path.join(ctx.packageDir, 'VERSION.json')) || readJsonSafe(path.join(ROOT, 'VERSION.json'));
      if (p) out.plugin = `${p.line || ''} ${versionLabel(p)}`.trim();
    } catch { /* 降级 */ }
    return out;
  })();
  const host = envCheck && envCheck.evidence && envCheck.evidence.os
    ? {
      hostname: envCheck.evidence.os.hostname,
      platform: `${envCheck.evidence.os.version || envCheck.evidence.os.release}（${envCheck.evidence.os.release}）`.trim(),
      arch: envCheck.evidence.os.arch,
      node: envCheck.evidence.node.version,
      dshVersion: envCheck.evidence.dsh && envCheck.evidence.dsh.version ? envCheck.evidence.dsh.version : null,
      plugin: envCheck.evidence.plugin ? `${envCheck.evidence.plugin.line || ''} ${versionLabel(envCheck.evidence.plugin)}`.trim() : null,
    }
    : basicHost;

  const exitCode = computeExitCode(summary);
  summary.exitCode = exitCode;
  summary.ok = exitCode === 0;

  const outJson = path.join(ctx.out, '设备自检.json');
  const outMd = path.join(ctx.out, '设备自检.md');
  const result = {
    schema: SCHEMA,
    tool: 'docs/工具-设备自检.mjs',
    toolVersion: TOOL_VERSION,
    generatedAt,
    elapsedMs,
    host,
    inputs: {
      out: ctx.out,
      root: ctx.root || null,
      package: ctx.packageDir,
      sessions: ctx.sessions || null,
      only: ctx.only,
      json: ctx.asJson,
      argv: process.argv.slice(2),
    },
    packageRoot: ROOT,
    summary,
    firstAction,
    checks: ctx.results,
    unverified: ctx.results.filter((r) => r.status === 'na' || r.status === 'warn').map((r) => ({ id: r.id, name: r.name, status: r.status, detail: r.detail })),
    reds: ctx.results.filter((r) => r.status === 'red' || r.status === 'error').map((r) => ({ id: r.id, name: r.name, status: r.status, detail: r.detail })),
    artifacts: { json: outJson, md: outMd },
    readOnly: {
      ledger: 'readAll(requireLedgerRows:true, repairTornTail:false)；不开 quarantine',
      sessions: 'scanSessionSources/readSourceTurns 不传 root（零副作用）；e3 只读统计不灌库',
      doctor: '--no-write',
      replay: '普通模式零写盘',
      writes: '仅 <out>/设备自检.json 与 <out>/设备自检.md',
    },
  };
  const md = renderMd(result);

  try {
    fs.writeFileSync(outJson, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.writeFileSync(outMd, md, 'utf8');
  } catch (e) {
    throw new EnvError(`结果写不进去：${ctx.out}（${errMsg(e)}）`);
  }

  if (ctx.asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(md);
  return exitCode;
}

// ============================================================================
// 四、检查框架
// ============================================================================

/** 跑一项检查（独立 try/catch；异常 → status:'error'，绝不拖垮整份）。 */
async function runCheck(ctx, id) {
  const t0 = Date.now();
  let r;
  try {
    r = await CHECK_IMPL[id](ctx);
  } catch (e) {
    r = {
      status: 'error',
      detail: `检查自身异常：${truncate(errMsg(e), 240)}`,
      evidence: { error: errMsg(e), stack: String((e && e.stack) || '').split('\n').slice(0, 8) },
      brief: [`异常：${truncate(errMsg(e), 180)}`],
    };
  }
  const status = r && ['green', 'red', 'warn', 'na', 'error'].includes(r.status) ? r.status : 'error';
  const row = {
    id,
    name: CHECK_NAMES[id],
    status,
    ok: status === 'green',
    detail: truncate((r && r.detail) || '', 500),
    evidence: (r && r.evidence) || {},
    brief: Array.isArray(r && r.brief) ? r.brief.map((s) => truncate(s, 260)).slice(0, 8) : [],
    ms: Date.now() - t0,
  };
  if (status === 'error' && !row.brief.length) row.brief.push(row.detail);
  ctx.results.push(row);
  return row;
}

/** 各检查项实现（依赖注入，便于单测/复用）。 */
const CHECK_IMPL = {
  env: checkEnv,
  package: checkPackage,
  ledger: checkLedger,
  'tick-metrics': checkTickMetrics,
  'run-report': checkRunReport,
  e3: checkE3,
  c19: checkC19,
  doctor: checkDoctor,
  boundary: checkBoundary,
  kernel: checkKernel,
};

/** 汇总计数。 */
function summarize(results) {
  const out = { total: results.length, green: 0, red: 0, warn: 0, na: 0, error: 0, ok: false, verdict: 'green', exitCode: 0 };
  for (const r of results) out[r.status] = (out[r.status] || 0) + 1;
  out.verdict = out.error > 0 ? 'error' : out.red > 0 ? 'red' : out.na > 0 ? 'unverified' : out.warn > 0 ? 'warn' : 'green';
  return out;
}

/** 退出码：error 优先（3），其次 red/na（1），否则 0。 */
function computeExitCode(summary) {
  if (summary.error > 0) return 3;
  if (summary.red > 0 || summary.na > 0) return 1;
  return 0;
}

/** "最该先看"一行（红/异常优先，其次未验，最后黄项；全绿则报全绿）。 */
function pickFirstAction(results) {
  const byPriority = (a, b) => (CHECK_PRIORITY[a.id] ?? 99) - (CHECK_PRIORITY[b.id] ?? 99);
  const bad = results.filter((r) => r.status === 'red' || r.status === 'error').sort(byPriority);
  if (bad.length) {
    const r = bad[0];
    const others = bad.length > 1 ? `（另有 ${bad.length - 1} 项红/异常）` : '';
    return `最该先看：${r.name}（${r.id}）—— ${truncate(r.detail, 220)}${others}`;
  }
  const na = results.filter((r) => r.status === 'na');
  if (na.length) return `最该先看：无红项，但有 ${na.length} 项未验（${na.map((r) => r.id).join('、')}）—— 未验 ≠ 通过，先补参数/证据再判`;
  const warn = results.filter((r) => r.status === 'warn').sort(byPriority);
  if (warn.length) return `最该先看：无红项，黄项 ${warn.length} 项（${warn.map((r) => r.id).join('、')}）—— 逐条看 MD 的黄项证据`;
  return `最该先看：${results.length} 项全绿，把本目录（设备自检.json + 设备自检.md + 账库的 run-report/度量）带回即可`;
}

// ============================================================================
// 五、检查项 1：env —— 环境与设备指纹
// ============================================================================

/** 读 DSH 版本（能取则取；不联网、不装包、不执行外部命令）。 */
function detectDshVersion() {
  const out = { version: null, source: '', desktopVersion: null, bundledNode: null, tried: [], hint: '' };
  const tried = (p) => { if (p && !out.tried.includes(p)) out.tried.push(p); };

  const envVersion = (process.env.DSH_VERSION || '').trim();
  if (envVersion) return { ...out, version: envVersion, source: 'env:DSH_VERSION', tried: out.tried };

  // ① npm/可读目录布局：DSH_INSTALL_DIR\package.json
  const installDir = (process.env.DSH_INSTALL_DIR || '').trim();
  if (installDir) {
    const p = path.join(installDir, 'package.json');
    tried(p);
    const j = readJsonSafe(p);
    if (j && typeof j.version === 'string' && j.version) {
      return { ...out, version: j.version, source: p, tried: out.tried };
    }
  }

  // ② 桌面版布局：DSH_NODE_EXECUTABLE 旁的 resources\runtime\primary-runtime\runtime.json
  const exe = (process.env.DSH_NODE_EXECUTABLE || '').trim();
  const readRuntime = (resourcesDir) => {
    const p = path.join(resourcesDir, 'runtime', 'primary-runtime', 'runtime.json');
    tried(p);
    const j = readJsonSafe(p);
    if (j && typeof j.desktopVersion === 'string' && j.desktopVersion) {
      return { version: j.desktopVersion, source: p, desktopVersion: j.desktopVersion, bundledNode: typeof j.node === 'string' ? j.node : null };
    }
    return null;
  };
  if (exe) {
    const hit = readRuntime(path.join(path.dirname(exe), 'resources'));
    if (hit) return { ...out, ...hit, tried: out.tried };
  }
  if (installDir && installDir.includes('app.asar')) {
    const resourcesDir = installDir.slice(0, installDir.indexOf('app.asar'));
    tried(resourcesDir);
    const hit = readRuntime(resourcesDir);
    if (hit) return { ...out, ...hit, tried: out.tried };
  }

  out.hint = '取不到：可在运行前设 DSH_VERSION=<版本>，或确认 DSH_NODE_EXECUTABLE / DSH_INSTALL_DIR 指向 DSH 安装位置';
  return out;
}

/** env 项。 */
async function checkEnv(ctx) {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const systemDrive = `${(process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '')}\\`;
  const primaryPath = ctx.root || systemDrive;

  const probeDisk = (label, p) => {
    try {
      const s = fs.statfsSync(p);
      return {
        label,
        path: p,
        freeBytes: s.bavail * s.bsize,
        totalBytes: s.blocks * s.bsize,
        freeGiB: gib(s.bavail * s.bsize),
        totalGiB: gib(s.blocks * s.bsize),
      };
    } catch (e) {
      return { label, path: p, error: errMsg(e), freeBytes: null, totalBytes: null };
    }
  };
  const disks = [probeDisk(ctx.root ? '账库所在盘' : '系统盘', primaryPath)];
  try {
    const outRoot = path.parse(ctx.out).root;
    const primaryRoot = path.parse(primaryPath).root;
    if (outRoot && primaryRoot && outRoot.toLowerCase() !== primaryRoot.toLowerCase()) {
      disks.push(probeDisk('结果盘', ctx.out));
    }
  } catch { /* 盘符解析失败不影响主盘 */ }

  const dsh = detectDshVersion();
  const pluginRaw = readJsonSafe(path.join(ctx.packageDir, 'VERSION.json')) || readJsonSafe(path.join(ROOT, 'VERSION.json'));
  const plugin = pluginRaw
    ? {
      version: pluginRaw.version || null,
      type: pluginRaw.type || null,
      line: pluginRaw.line || null,
      baselineTag: pluginRaw.baselineTag || null,
      gate: Array.isArray(pluginRaw.gate) ? pluginRaw.gate : [],
      tests: pluginRaw.tests || null,
    }
    : null;

  const osVersion = typeof os.version === 'function' ? os.version() : '';
  const warnings = [];
  if (!dsh.version) warnings.push('DSH 版本取不到（na）');
  if (gib(totalBytes) !== null && gib(totalBytes) < 7.5) warnings.push(`内存总量 ${gib(totalBytes)} GiB < 8 GB（准备清单要求 ≥8 GB）`);
  const primaryDisk = disks[0];
  if (primaryDisk && typeof primaryDisk.freeBytes === 'number' && primaryDisk.freeBytes < 60e9) {
    warnings.push(`${primaryDisk.path} 可用 ${bytesHuman(primaryDisk.freeBytes)} < 60 GB（准备清单要求）`);
  }
  if (!primaryDisk || typeof primaryDisk.freeBytes !== 'number') warnings.push('磁盘可用空间取不到（na）');
  if (NODE_MAJOR > 0 && NODE_MAJOR < 18) warnings.push(`node v${process.versions.node} 低于 18，部分工具可能不兼容`);
  if (os.platform() !== 'win32') warnings.push(`平台 ${os.platform()} 非 Windows（本自检面向 Windows 设备）`);

  const dshLabel = dsh.version ? `${dsh.version}` : 'na';
  const memLabel = `${gib(totalBytes)} GiB（可用 ${gib(freeBytes)} GiB）`;
  const detail = [
    `${osVersion || os.release()}`.trim(),
    `内存 ${memLabel}`,
    `node v${process.versions.node}`,
    `DSH ${dshLabel}`,
    plugin ? `插件 ${[plugin.line, versionLabel(plugin)].filter(Boolean).join(' ')}`.trim() : '',
  ].filter(Boolean).join(' / ');

  const brief = [
    `主机：${os.hostname()}（${os.type()} ${os.release()}，${os.arch()}）`,
    `内存：${memLabel}`,
    `node：v${process.versions.node}（${process.execPath}）`,
    `DSH：${dsh.version ? `${dsh.version}（${truncate(dsh.source, 120)}）` : '取不到（na）'}`,
    plugin ? `插件：${[plugin.line, versionLabel(plugin)].filter(Boolean).join(' ')}（基线 ${plugin.baselineTag || '?'}）` : '插件：VERSION.json 读不到（na）',
  ];
  for (const d of disks) {
    brief.push(`${d.label} ${d.path}：${typeof d.freeBytes === 'number' ? `可用 ${bytesHuman(d.freeBytes)} / 共 ${bytesHuman(d.totalBytes)}` : `不可读（${d.error || '?'}）`}`);
  }

  ctx.envSnapshot = {
    totalBytes,
    freeBytes,
    disks,
    dsh,
    plugin,
  };

  return {
    status: warnings.length ? 'warn' : 'green',
    detail,
    evidence: {
      generatedAt: isoLocal(),
      os: {
        type: os.type(),
        platform: os.platform(),
        release: os.release(),
        version: osVersion,
        arch: os.arch(),
        hostname: os.hostname(),
        uptimeHours: Number((os.uptime() / 3600).toFixed(2)),
      },
      node: { version: process.versions.node, v8: process.versions.v8, execPath: process.execPath },
      dsh,
      memory: { totalBytes, freeBytes, totalGiB: gib(totalBytes), freeGiB: gib(freeBytes) },
      disks,
      plugin,
      thresholds: {
        ramGb: 8,
        diskFreeGb: 60,
        nodeMajor: 18,
        note: '内存/磁盘门槛来自《三台设备测试-准备清单》§一；node 门槛是本脚本自身下限',
      },
      warnings,
    },
    brief,
  };
}

// ============================================================================
// 六、检查项 2：package —— MANIFEST.sha256 逐文件校验
// ============================================================================

/** 包内文件枚举（只返回普通文件；跳过 .git 与 --out 子树；符号链接只登记不跟随）。 */
function walkPackageFiles(pkgDir, outDir) {
  const files = [];
  const problems = [];
  const symlinks = [];
  let outRelPrefix = '';
  if (outDir && isInside(pkgDir, outDir)) {
    const rel = path.relative(pkgDir, outDir).split(path.sep).join('/');
    outRelPrefix = `${rel}/`;
  }
  const walk = (absDir, relPrefix) => {
    let ents;
    try {
      ents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      problems.push({ path: relPrefix || '.', error: errMsg(e) });
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.name === '.git') continue; // 不是交付物，且可能是海量对象
      if (rel === MANIFEST_SELF) continue; // 自指哈希不可能成立
      if (outRelPrefix && rel.startsWith(outRelPrefix)) continue; // --out 自产文件不算"多"
      if (e.isSymbolicLink && e.isSymbolicLink()) { symlinks.push(rel); continue; }
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) { walk(abs, rel); continue; }
      if (e.isFile()) { files.push(rel); continue; }
      problems.push({ path: rel, error: 'not-regular-file' });
    }
  };
  walk(pkgDir, '');
  return { files, problems, symlinks, outRelPrefix };
}

/** package 项。 */
async function checkPackage(ctx) {
  const pkgDir = ctx.packageDir;
  const manifestPath = path.join(pkgDir, MANIFEST_SELF);
  if (!fs.existsSync(manifestPath)) {
    return {
      status: 'red',
      detail: `包内缺 ${MANIFEST_SELF}：${manifestPath}`,
      evidence: { package: pkgDir, manifestPath, error: 'MANIFEST_MISSING' },
      brief: [`缺 ${MANIFEST_SELF}（无法校验包完整性）`],
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    throw new Error(`读不了 ${MANIFEST_SELF}：${errMsg(e)}`);
  }
  const lines = raw.split(/\r?\n/);
  const entries = new Map();
  const badEntries = [];
  let duplicateEntries = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim());
    if (!m) { badEntries.push({ lineNo: i + 1, raw: truncate(line, 160) }); continue; }
    let rel = m[2].trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) { badEntries.push({ lineNo: i + 1, raw: truncate(line, 160), reason: 'bad-path' }); continue; }
    if (entries.has(rel)) { duplicateEntries++; continue; }
    entries.set(rel, m[1].toLowerCase());
  }
  if (entries.size === 0) {
    return {
      status: 'red',
      detail: `${MANIFEST_SELF} 里没有可解析的条目（${badEntries.length} 行坏行）`,
      evidence: { package: pkgDir, manifestPath, badEntries: badEntries.slice(0, 20), duplicateEntries },
      brief: [`${MANIFEST_SELF} 无有效条目，包不可校验`],
    };
  }

  const { files, problems, symlinks, outRelPrefix } = walkPackageFiles(pkgDir, ctx.out);
  const diskSet = new Set(files);
  const missing = [];
  const changed = [];
  for (const [rel, expected] of entries) {
    const abs = path.join(pkgDir, ...rel.split('/'));
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (!st || !st.isFile()) { missing.push(rel); continue; }
    let actual;
    try {
      actual = sha256FileSync(abs);
    } catch (e) {
      problems.push({ path: rel, error: `hash-failed: ${errMsg(e)}` });
      missing.push(rel);
      continue;
    }
    if (actual !== expected) changed.push({ path: rel, expected, actual, bytes: st.size });
  }
  const extra = files.filter((rel) => !entries.has(rel));

  const counts = {
    manifestEntries: entries.size,
    diskFiles: files.length,
    missing: missing.length,
    changed: changed.length,
    extra: extra.length,
    badEntries: badEntries.length,
    duplicateEntries,
    walkProblems: problems.length,
    skippedSymlinks: symlinks.length,
  };
  const clean = counts.missing === 0 && counts.changed === 0 && counts.extra === 0
    && counts.badEntries === 0 && counts.walkProblems === 0;

  const detailParts = [`MANIFEST ${nfmt(counts.manifestEntries)} 项 / 盘上 ${nfmt(counts.diskFiles)} 个文件`];
  detailParts.push(`缺 ${counts.missing}`);
  detailParts.push(`改 ${counts.changed}`);
  detailParts.push(`多 ${counts.extra}`);
  if (counts.badEntries) detailParts.push(`坏行 ${counts.badEntries}`);
  if (counts.walkProblems) detailParts.push(`读不了 ${counts.walkProblems}`);
  if (counts.skippedSymlinks) detailParts.push(`跳过符号链接 ${counts.skippedSymlinks}`);
  const status = clean ? (counts.skippedSymlinks ? 'warn' : 'green') : 'red';
  const detail = `${detailParts[0]}：${detailParts.slice(1).join('、')}`;

  const brief = [];
  for (const p of extra.slice(0, 8)) brief.push(`多（未列入 MANIFEST）：${p}`);
  if (extra.length > 8) brief.push(`…另有 ${extra.length - 8} 个未列入文件`);
  for (const p of missing.slice(0, 8)) brief.push(`缺：${p}`);
  if (missing.length > 8) brief.push(`…另有 ${missing.length - 8} 个缺失文件`);
  for (const c of changed.slice(0, 8)) brief.push(`改：${c.path}（${bytesHuman(c.bytes)}）`);
  if (changed.length > 8) brief.push(`…另有 ${changed.length - 8} 个被改文件`);
  for (const b of badEntries.slice(0, 3)) brief.push(`MANIFEST 坏行 L${b.lineNo}：${b.raw}`);
  for (const p of problems.slice(0, 3)) brief.push(`读不了：${p.path}（${p.error}）`);
  for (const s of symlinks.slice(0, 3)) brief.push(`符号链接（未校验/未计入多）：${s}`);
  if (!brief.length) brief.push(`MANIFEST 逐文件校验通过：${nfmt(counts.manifestEntries)} 项全符`);

  return {
    status,
    detail,
    evidence: {
      package: pkgDir,
      manifestPath,
      counts,
      excluded: ['.git/', `${MANIFEST_SELF}（自指）`, ...(outRelPrefix ? [`${outRelPrefix}（--out 子树）`] : [])],
      missing: missing.slice(0, 200),
      changed: changed.slice(0, 200),
      extra: extra.slice(0, 200),
      badEntries: badEntries.slice(0, 50),
      walkProblems: problems.slice(0, 50),
      skippedSymlinks: symlinks.slice(0, 50),
    },
    brief,
  };
}

// ============================================================================
// 七、检查项 3：ledger —— 台账四数
// ============================================================================

/** 动态 import 本包 lib（失败只影响单项，不影响整份自检）。 */
async function loadLib(rel) {
  return import(pathToFileURL(path.join(ROOT, 'lib', rel)).href);
}

/** 台账只读快照（ledger/e3 共用；失败缓存错误，两处都能如实报）。 */
function getLedgerSnapshot(ctx) {
  if (ctx.ledgerSnapshot) return Promise.resolve(ctx.ledgerSnapshot);
  if (ctx.ledgerError) return Promise.reject(ctx.ledgerError);
  if (ctx.ledgerPromise) return ctx.ledgerPromise;
  ctx.ledgerPromise = (async () => {
    try {
      const L = await loadLib('ledger.js');
      // ★ 只读铁律：repairTornTail:false（自愈会截断账文件）；quarantine 不打开（会写坏行证据）
      const r = L.readAll(ctx.root, { requireLedgerRows: true, repairTornTail: false, maxBadLineDetails: 50 });
      ctx.ledgerSnapshot = r;
      return r;
    } catch (e) {
      ctx.ledgerError = e;
      throw e;
    }
  })();
  return ctx.ledgerPromise;
}

/** 重复主键统计（sample 只留前 max 个）。 */
function dupGroups(rows, keyFn, max = 5) {
  const m = new Map();
  for (const r of rows) {
    let k = '';
    try { k = keyFn(r); } catch { k = ''; }
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const dups = [...m.entries()].filter(([, n]) => n > 1);
  return {
    groups: dups.length,
    extraRows: dups.reduce((s, [, n]) => s + n - 1, 0),
    sample: dups.slice(0, max).map(([k, n]) => `${k} ×${n}`),
  };
}

/** ledger 项。 */
async function checkLedger(ctx) {
  if (!ctx.root) {
    return { status: 'na', detail: '未提供 --root，无法读台账', evidence: { reason: 'MISSING_ROOT' }, brief: ['缺 --root（账库根）'] };
  }
  const r = await getLedgerSnapshot(ctx);
  const rows = Array.isArray(r.records) ? r.records : [];
  const codeDup = dupGroups(rows, (x) => (typeof x.code === 'string' ? x.code : ''));
  const sidTurnDup = dupGroups(rows, (x) => (typeof x.sid === 'string' && Number.isInteger(x.turn) ? `${x.sid}\u0000${x.turn}` : ''));
  const ioErrors = (Array.isArray(r.readErrors) ? r.readErrors : []).filter((e) => !String((e && e.code) || '').startsWith('E_BAD_LINE'));
  const statusCounts = {};
  for (const x of rows) {
    const k = String((x && x.status) || 'unknown');
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const tsList = rows.map((x) => String(x.ts || '')).filter(Boolean).sort();
  const bad = (r.badLines || 0) > 0 || ioErrors.length > 0 || r.ok !== true || codeDup.groups > 0 || sidTurnDup.groups > 0;

  const detail = rows.length
    ? `台账 ${nfmt(rows.length)} 行（${nfmt(r.files || 0)} 个日文件）/ 唯一 code ${nfmt(rows.length - codeDup.extraRows)} / 唯一 (sid,turn) ${nfmt(rows.length - sidTurnDup.extraRows)} / 坏行 ${nfmt(r.badLines || 0)} / 读错 ${ioErrors.length}`
    : `台账 0 行（emptyProven=${r.emptyProven === true}，${nfmt(r.files || 0)} 个日文件）`;

  const brief = [
    `账库：${r.dir || path.join(ctx.root, 'ledger')}（dirExists=${r.dirExists === true}，files=${nfmt(r.files || 0)}）`,
    `行数 ${nfmt(rows.length)}；坏行 ${nfmt(r.badLines || 0)}；读错 ${ioErrors.length}`,
  ];
  if (codeDup.groups) brief.push(`重复 code：${codeDup.groups} 组（多出 ${codeDup.extraRows} 行）：${codeDup.sample.join('；')}`);
  if (sidTurnDup.groups) brief.push(`重复 (sid,turn)：${sidTurnDup.groups} 组（多出 ${sidTurnDup.extraRows} 行）：${sidTurnDup.sample.join('；')}`);
  for (const e of ioErrors.slice(0, 3)) brief.push(`读错：${e.file || '?'} ${e.code || ''} ${truncate(e.message || e.error || '', 120)}`);
  for (const d of (r.badLineDetails || []).slice(0, 3)) brief.push(`坏行：${d.file}:${d.lineNo}（offset ${d.offset}，sha ${String(d.sha256 || '').slice(0, 12)}…）`);
  if (!bad && !rows.length) brief.push('空账库：如果是首次开账属正常，但"未入账"不能算通过（e3 会判预期行数）');

  return {
    status: bad ? 'red' : rows.length === 0 ? 'warn' : 'green',
    detail,
    evidence: {
      root: ctx.root,
      dir: r.dir,
      dirExists: r.dirExists === true,
      files: r.files || 0,
      fileNames: r.fileNames || [],
      ledgerRows: rows.length,
      codeUnique: codeDup.groups === 0,
      duplicateCodeGroups: codeDup.groups,
      duplicateCodeExtraRows: codeDup.extraRows,
      duplicateCodeSample: codeDup.sample,
      sidTurnUnique: sidTurnDup.groups === 0,
      duplicateSidTurnGroups: sidTurnDup.groups,
      duplicateSidTurnExtraRows: sidTurnDup.extraRows,
      duplicateSidTurnSample: sidTurnDup.sample,
      badLines: r.badLines || 0,
      badLineDetails: (r.badLineDetails || []).slice(0, 10),
      readErrorCount: ioErrors.length,
      readErrors: ioErrors.slice(0, 10),
      emptyProven: r.emptyProven === true,
      tornTailRepaired: Array.isArray(r.tornTailRepaired) ? r.tornTailRepaired.length : 0,
      statusCounts,
      tsRange: tsList.length ? { first: tsList[0], last: tsList[tsList.length - 1] } : null,
      readOnly: { requireLedgerRows: true, repairTornTail: false },
      missingTurns: null,
      missingTurnsNote: '缺轮=预期行数-台账行数，由 e3（需 --sessions）判；本项只做账本侧四数',
    },
    brief,
  };
}

// ============================================================================
// 八、检查项 4：tick-metrics —— 逐 tick 度量
// ============================================================================

/** tick-metrics 项。 */
async function checkTickMetrics(ctx) {
  if (!ctx.root) {
    return { status: 'na', detail: '未提供 --root，无法读 .tick-metrics.jsonl', evidence: { reason: 'MISSING_ROOT' }, brief: ['缺 --root'] };
  }
  const ledgerDir = path.join(ctx.root, 'ledger');
  const file = path.join(ledgerDir, '.tick-metrics.jsonl');
  if (!fs.existsSync(file)) {
    let rows = null;
    try { rows = (await getLedgerSnapshot(ctx)).records.length; } catch { rows = null; }
    return {
      status: rows && rows > 0 ? 'warn' : 'na',
      detail: `缺 ${path.join('ledger', '.tick-metrics.jsonl')}（0.9.3+ 的插件才有；无逐 tick 证据无法核对 C20/C21/C25）`,
      evidence: { root: ctx.root, file, exists: false, ledgerRows: rows },
      brief: [`没有逐 tick 度量文件：${file}`, '若插件版本含度量，属异常；否则本项未验'],
    };
  }

  const tail = readTailLines(file, 1024 * 1024);
  const lines = tail.text.split('\n').filter((l) => l.trim());
  const tailLines = lines.slice(-METRICS_N);
  const records = [];
  const badLines = [];
  for (const line of tailLines) {
    try {
      const o = JSON.parse(line);
      if (!o || typeof o !== 'object' || Array.isArray(o)) { badLines.push(truncate(line, 160)); continue; }
      records.push(o);
    } catch {
      badLines.push(truncate(line, 160));
    }
  }

  const threshold = {
    msLimit: C25_MS_LIMIT,
    consumedLimitBytes: C25_CONSUMED_LIMIT,
    readLimitBytes: C25_READ_LIMIT,
    steadyReadLimitBytes: C21_STEADY_READ_LIMIT,
    scope: 'C25/S-9①（38.82 MB 语料口径：单 tick ≤30 s、消费 ≤17 MiB、读放大 ≤2.5×/≤40 MiB）+ C21（稳态 ≤1 MiB）',
  };
  const redReasons = [];
  const warnings = [];
  const ticks = [];
  let writtenSum = 0;
  let firstRunSeen = false;
  for (const o of records) {
    const budget = o.budget && typeof o.budget === 'object' ? o.budget : {};
    const io = o.io && typeof o.io === 'object' ? o.io : {};
    const counters = o.counters && typeof o.counters === 'object' ? o.counters : {};
    const errs = Array.isArray(o.errors) ? o.errors : [];
    const warns = Array.isArray(o.warnings) ? o.warnings : [];
    const ms = typeof o.ms === 'number' ? o.ms : null;
    const readBytes = typeof o.readBytes === 'number' ? o.readBytes : null;
    const consumed = typeof io.consumedSourceBytes === 'number' ? io.consumedSourceBytes : null;
    const written = typeof o.written === 'number' ? o.written : null;
    const saturated = budget.saturated === true;
    if (written !== null) writtenSum += written;
    if (counters.firstRun === true) firstRunSeen = true;

    const tickBad = [];
    if (ms !== null && ms > C25_MS_LIMIT) tickBad.push(`ms ${ms} > 30 s`);
    if (ms !== null && typeof budget.hardMs === 'number' && ms > budget.hardMs) tickBad.push(`ms ${ms} > 硬顶 ${budget.hardMs}`);
    if (consumed !== null && consumed > C25_CONSUMED_LIMIT) tickBad.push(`消费 ${bytesHuman(consumed)} > 17 MiB`);
    if (readBytes !== null && readBytes > C25_READ_LIMIT) tickBad.push(`读盘 ${bytesHuman(readBytes)} > 40 MiB`);
    if (written === 0 && readBytes !== null && readBytes > C21_STEADY_READ_LIMIT) tickBad.push(`稳态读盘 ${bytesHuman(readBytes)} > 1 MiB`);
    if (ms === null) tickBad.push('缺 ms 字段');
    if (tickBad.length) {
      const id = o.tickId || o.ts || `#${ticks.length + 1}`;
      redReasons.push(`${id}：${tickBad.join('；')}`);
    }
    if (saturated) warnings.push(`${o.tickId || o.ts || '?'}：budget.saturated=true（预算饱和，可能被截断）`);
    if (errs.length) warnings.push(`${o.tickId || o.ts || '?'}：errors ${errs.length} 条`);
    if (warns.length) warnings.push(`${o.tickId || o.ts || '?'}：warnings ${warns.length} 条`);
    if (typeof o.sessionsErrored === 'number' && o.sessionsErrored > 0) warnings.push(`${o.tickId || o.ts || '?'}：sessionsErrored=${o.sessionsErrored}`);

    ticks.push({
      tickId: o.tickId || null,
      ts: o.ts || null,
      ms,
      written,
      scanned: typeof o.scanned === 'number' ? o.scanned : null,
      readBytes,
      readBytesKind: o.readBytesKind || null,
      consumedSourceBytes: consumed,
      budget: {
        scanBudgetMs: typeof budget.scanBudgetMs === 'number' ? budget.scanBudgetMs : null,
        effectiveMs: typeof budget.effectiveMs === 'number' ? budget.effectiveMs : null,
        hardMs: typeof budget.hardMs === 'number' ? budget.hardMs : null,
        readBytes: typeof budget.readBytes === 'number' ? budget.readBytes : null,
        saturated,
      },
      sessionsErrored: typeof o.sessionsErrored === 'number' ? o.sessionsErrored : null,
      errors: errs.length,
      warnings: warns.length,
      firstRun: counters.firstRun === true,
    });
  }

  const msVals = ticks.map((t) => t.ms).filter((n) => typeof n === 'number');
  const writeVals = ticks.map((t) => t.written).filter((n) => typeof n === 'number');
  const readVals = ticks.map((t) => t.readBytes).filter((n) => typeof n === 'number');
  const consumedVals = ticks.map((t) => t.consumedSourceBytes).filter((n) => typeof n === 'number');
  const budgetHard = ticks.map((t) => t.budget.hardMs).find((n) => typeof n === 'number');
  const firstKind = ticks.map((t) => t.readBytesKind).find(Boolean);

  const detailParts = [];
  detailParts.push(`最近 ${records.length} tick（窗口 ${bytesHuman(tail.windowBytes)}）`);
  if (msVals.length) detailParts.push(`ms ${nfmt(Math.min(...msVals))}–${nfmt(Math.max(...msVals))}`);
  if (writeVals.length) detailParts.push(`写入 ${nfmt(Math.min(...writeVals))}–${nfmt(Math.max(...writeVals))}（合计 ${nfmt(writtenSum)}）`);
  if (readVals.length) detailParts.push(`读盘估算 ${bytesHuman(Math.min(...readVals))}–${bytesHuman(Math.max(...readVals))}`);
  if (consumedVals.length) detailParts.push(`消费 ${bytesHuman(Math.min(...consumedVals))}–${bytesHuman(Math.max(...consumedVals))}`);
  if (typeof budgetHard === 'number') detailParts.push(`预算硬顶 ${msHuman(budgetHard)}`);
  detailParts.push(`超限 ${redReasons.length}`);
  const status = redReasons.length ? 'red' : (badLines.length > 0 || warnings.length > 0 || records.length === 0 ? 'warn' : 'green');

  const brief = [];
  for (const r of redReasons.slice(0, 5)) brief.push(`超限：${r}`);
  for (const w of warnings.slice(0, 4)) brief.push(`告警：${w}`);
  for (const b of badLines.slice(0, 2)) brief.push(`坏行：${b}`);
  if (!brief.length) {
    brief.push(`最近 ${records.length} tick 全部在预算内（ms ≤ ${msHuman(C25_MS_LIMIT)}，读盘/消费见 evidence）`);
    if (records.length) brief.push(`最新 tick：${ticks[ticks.length - 1].ts || '?'}，${nfmt(ticks[ticks.length - 1].ms)} ms，写入 ${nfmt(ticks[ticks.length - 1].written)}`);
    if (firstRunSeen) brief.push(`窗口内出现 firstRun=true（首次灌库 tick），写入合计 ${nfmt(writtenSum)} 行`);
  }
  if (records.length && ticks.every((t) => t.written === 0)) brief.push('窗口内全是稳态 tick（written=0）');

  return {
    status,
    detail: detailParts.join('；'),
    evidence: {
      root: ctx.root,
      file,
      fileBytes: tail.size,
      windowBytes: tail.windowBytes,
      windowStart: tail.windowStart,
      limit: METRICS_N,
      lineCountInWindow: lines.length,
      parsed: records.length,
      badLines,
      thresholds: threshold,
      ticks,
      redReasons,
      warnings,
      writtenSum,
      firstRunSeen,
      readBytesKind: firstKind || null,
      note: 'readBytes 是插件侧估算口径（readBytesKind 明示）；不是 OS 计数器',
    },
    brief,
  };
}

// ============================================================================
// 九、检查项 5：run-report —— 最近一份运行报告
// ============================================================================

/**
 * ★ P0-1（引用式豁免 · 机主 2026-11-15 口径）：已知缺口只允许"**指到哪一轮 + 哪一份证据**"的豁免。
 *
 * @why 交付语料是**静止历史快照**（zip 条目时间 1980-01-01），而语料里有 1 个"按真实会话结构保留的
 *      未闭合轮" → 插件 F1 如实判 gate=degraded → 旧自检把 degraded 一律判红 → 任何接收端按文档跑
 *      都拿不到"可准入"（第三份异机测试 TSG-37 用 A/B 对照定死）。修法不是把 mtime 归一（只买到 2 分钟
 *      窗口，是假修），而是把这类缺口**声明为预期**（`02-语料/预期缺口.json`，由 docs/工具-预期缺口.mjs 独立解码生成），
 *      并要求：run-report.openTurns 里的**每一轮**都能在该清单里对上，且引用本报告文件 + 源 sha256。
 *      —— 对不上 = 红；清单缺失 = 红（fail-closed）；非"未闭合轮"类缺口 = 红。
 */
function loadExpectedGaps(ctx) {
  if (ctx.__expectedGaps !== undefined) return ctx.__expectedGaps;
  const cands = [];
  if (ctx.expectGaps) cands.push(path.resolve(ctx.expectGaps));
  const pkgDir = ctx.packageDir || ROOT;
  cands.push(path.join(pkgDir, '..', '02-语料', '预期缺口.json'));
  cands.push(path.join(pkgDir, '..', '..', '02-语料', '预期缺口.json'));
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) { ctx.__expectedGaps = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); return ctx.__expectedGaps; }
    } catch { /* 读坏 = 当没有（fail-closed 判红） */ }
  }
  ctx.__expectedGaps = null;
  return null;
}

/**
 * 把 gate 的 degraded 分成「已声明·逐轮可定位的已知缺口」与「真红」。
 * @returns {{ok:boolean, redReasons:string[], citations:string[]}}
 */
function classifyKnownGaps(ctx, gate, rep, evidenceFile, evidenceSha) {
  const conclusion = String((gate && gate.conclusion) || '');
  const rawGaps = gate && Array.isArray(gate.knownGaps) ? gate.knownGaps.map(String) : [];
  const reason = String((gate && gate.reason) || '');
  const gaps = rawGaps.length ? rawGaps : (reason ? reason.split(/[;；]/).map((s) => s.trim()).filter(Boolean) : []);
  if (conclusion === 'unknown') return { ok: false, redReasons: [`gate.conclusion=unknown（无法表示意见）：${reason || '?'}`], citations: [] };
  if (conclusion !== 'degraded') return { ok: false, redReasons: [`gate.conclusion=${conclusion || '?'}`], citations: [] };
  const openTurns = Array.isArray(rep && rep.openTurns) ? rep.openTurns : [];
  const unclosedGap = gaps.find((g) => /未闭合轮/.test(g));
  if (!unclosedGap) {
    return { ok: false, redReasons: [`gate=degraded 且无"未闭合轮"缺口：${gaps.join('；') || reason || '?'}`], citations: [] };
  }
  // 只允许"唯一缺口族 = 未闭合轮"的豁免（混入其它缺口 → 红）
  const others = gaps.filter((g) => !/未闭合轮/.test(g));
  if (others.length) {
    return { ok: false, redReasons: [`gate=degraded 同时含其它缺口（不可用预期缺口豁免）：${others.join('；')}`], citations: [] };
  }
  const declared = Number((/未闭合轮=(\d+)/.exec(unclosedGap) || [])[1]);
  const exp = loadExpectedGaps(ctx);
  if (!exp || !Array.isArray(exp.expectedGaps) || exp.expectedGaps.length === 0) {
    return {
      ok: false,
      redReasons: ['gate=degraded（未闭合轮）但找不到/读不出预期缺口声明 02-语料/预期缺口.json —— 无法引用就不许豁免（fail-closed）'],
      citations: [],
    };
  }
  if (!openTurns.length) return { ok: false, redReasons: ['gate=degraded（未闭合轮）但 run-report.openTurns 为空 —— 无法逐轮定位，不许豁免'], citations: [] };
  if (Number.isInteger(declared) && declared !== openTurns.length) {
    return { ok: false, redReasons: [`knownGaps 声明未闭合轮=${declared}，但 openTurns 实际 ${openTurns.length} 条 —— 数字对不上`], citations: [] };
  }
  const redReasons = [];
  const citations = [];
  for (const o of openTurns) {
    const sid = String((o && (o.sid || o.session)) || '');
    const turn = o && Number.isInteger(o.turn) ? o.turn : null;
    const hit = exp.expectedGaps.find((g) => g && g.turn === turn && (
      sid === g.session || sid.endsWith(String(g.session).replace(/^session-/, '')) || String(g.session).includes(sid)
    ));
    if (!hit) { redReasons.push(`openTurn session=${sid || '?'} turn=${turn === null ? '?' : turn} 不在预期缺口清单内`); continue; }
    citations.push(
      `session=${hit.session} turn=${hit.turn}` +
      (Number.isInteger(o && o.startByte) ? ` @startByte=${o.startByte}` : '') +
      `｜证据：${path.basename(evidenceFile)}（sha256=${String(evidenceSha || '').slice(0, 16)}…）` +
      `｜预期清单 02-语料/预期缺口.json（源 ${hit.source} sha256=${String(hit.sourceSha256 || '').slice(0, 16)}…）`
    );
  }
  if (redReasons.length) return { ok: false, redReasons, citations };
  return { ok: true, redReasons: [], citations };
}

/** run-report 项。 */
async function checkRunReport(ctx) {
  if (!ctx.root) {
    return { status: 'na', detail: '未提供 --root，无法读运行报告', evidence: { reason: 'MISSING_ROOT' }, brief: ['缺 --root'] };
  }
  const ledgerDir = path.join(ctx.root, 'ledger');
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir).filter((n) => /^\.run-report-\d{8}\.json$/.test(n)).sort();
  } catch (e) {
    return {
      status: 'na',
      detail: `读不了 ledger 目录（${errMsg(e)}）`,
      evidence: { root: ctx.root, ledgerDir, error: errMsg(e) },
      brief: [`读不了 ${ledgerDir}`],
    };
  }
  if (!names.length) {
    // ★ P2-06（本机测试报告）：**报告缺失不许判黄**。
    //   @why 旧实现判 warn —— 而三台判定器只看红绿，"删掉 .run-report-*.json 就能把红变黄 → 准入通过"，
    //        这是"删证据即可过"的假绿缺口（红队已实测复现）。报告是准入门必查物证，缺失本身即缺陷。
    return {
      status: 'red',
      detail: 'ledger 下没有 .run-report-*.json（插件还没跑过对账轮，或报告被删）—— 报告是准入必查物证，缺失判红（P2-06）',
      evidence: { root: ctx.root, ledgerDir, reports: [], missing: true },
      brief: ['没有运行报告：无法核对 gate/counts/errors（P2-06 判红）'],
    };
  }
  const latest = names[names.length - 1];
  const file = path.join(ledgerDir, latest);
  let rep = null;
  try {
    rep = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`运行报告读不出/不是 JSON：${file}（${errMsg(e)}）`);
  }
  const gate = rep && rep.gate && typeof rep.gate === 'object' ? rep.gate : null;
  const counts = rep && rep.counts && typeof rep.counts === 'object' ? rep.counts : {};
  const errors = Array.isArray(rep && rep.errors) ? rep.errors : [];
  const reconcile = rep && rep.reconcile && typeof rep.reconcile === 'object' ? rep.reconcile : null;
  const date = String((rep && rep.date) || /^\.run-report-(\d{4})(\d{2})(\d{2})\.json$/.exec(latest)?.slice(1).join('-') || '');
  const today = todayLocalYmd();
  const ageDays = date ? daysBetweenYmd(date, today) : null;

  const reportSha = (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } })();
  const redReasons = [];
  const gapWarnings = []; // ★ P0-1：已声明且逐轮可定位的已知缺口 → warn（引用式豁免）
  if (!gate) redReasons.push('缺 gate 段');
  else if (String(gate.conclusion || '') !== 'ok') {
    const cls = classifyKnownGaps(ctx, gate, rep, file, reportSha);
    if (cls.ok) gapWarnings.push(...cls.citations);
    else redReasons.push(...cls.redReasons);
  }
  if (Number(counts.errors || 0) > 0) redReasons.push(`counts.errors=${counts.errors}`);
  if (errors.length > 0) redReasons.push(`errors[]=${errors.length}`);
  if (reconcile && reconcile.ok === false) redReasons.push('reconcile.ok=false');

  const warnings = [];
  if (gapWarnings.length) warnings.push('已知缺口（已声明·逐轮可定位，引用式豁免）：' + gapWarnings.join('；'));
  // ★ P1-02：报告里的 ledgerRows 是对账快照；若 freshness 给出写入时的真实行数且两者不一致 → 明示陈旧
  const fresh = rep && rep.freshness && typeof rep.freshness === 'object' ? rep.freshness : null;
  // ★ P1-02：报告里的 ledgerRows 是对账快照；若 freshness 给出写入时的真实行数且两者不一致 → 明示陈旧
  //   （第二轮测试报告 P2-2：旧实现读 `fresh.ledgerRows`，而字段名是 `ledgerRowsLive` → 本告警永不触发）
  const liveRows = fresh && Number.isInteger(fresh.ledgerRowsLive) ? fresh.ledgerRowsLive : null;
  if (liveRows !== null && Number.isInteger(counts.ledgerRows) && liveRows !== counts.ledgerRows) {
    warnings.push(`报告快照陈旧：counts.ledgerRows=${counts.ledgerRows}（对账快照）但写入时真实行数=${liveRows}`);
  }
  if (ageDays !== null && ageDays > 1) warnings.push(`最近报告 ${date} 距今 ${ageDays} 天（可能停在旧快照）`);
  if (Number(counts.warnings || 0) > 0) warnings.push(`counts.warnings=${counts.warnings}`);
  // lite 结构上固定不采的两段（doctor 同口径）：不算"异常未采"，否则永远黄
  const KNOWN_UNAVAILABLE = new Set(['stuckSources', 'integrityFailures']);
  const unexpectedUnavailable = (Array.isArray(rep && rep.unavailable) ? rep.unavailable : []).filter((x) => !KNOWN_UNAVAILABLE.has(x));
  if (unexpectedUnavailable.length) warnings.push(`unavailable=${unexpectedUnavailable.join(',')}`);

  const batches = Array.isArray(rep && rep.batches) ? rep.batches : [];
  const batchesBytes = batches.reduce((s, b) => s + (typeof (b && b.bytes) === 'number' ? b.bytes : 0), 0);
  const batchesTurns = batches.reduce((s, b) => s + (typeof (b && b.turns) === 'number' ? b.turns : 0), 0);

  const detailParts = [];
  detailParts.push(latest);
  if (gate) detailParts.push(`gate=${gate.conclusion || '?'}`);
  if (typeof counts.ledgerRows === 'number') detailParts.push(`报告内台账 ${nfmt(counts.ledgerRows)} 行（对账快照，不代表当前行数）`);
  detailParts.push(`errors ${errors.length}`);
  if (reconcile) detailParts.push(`坏行 ${nfmt(reconcile.badLines || 0)}、缺原文 ${nfmt(reconcile.originalMissing ? reconcile.originalMissing.length : 0)}`);
  detailParts.push(`报告日期 ${date || '?'}`);
  // ★ preview4：逐轮引用写进 detail（第三轮报告 P2-5）——操作者/审计读 detail 即可核 session/turn/startByte。
  if (gapWarnings.length) detailParts.push(`已知缺口引用 ${gapWarnings.length} 条：${gapWarnings.map((s) => String(s).split('｜')[0]).join('；')}`);
  if (ageDays !== null && ageDays > 1) detailParts.push(`已 ${ageDays} 天`);

  const brief = [];
  if (redReasons.length) for (const r of redReasons.slice(0, 5)) brief.push(`红：${r}`);
  for (const e of errors.slice(0, 3)) brief.push(`error：${e.kind || '?'} ${truncate(e.detail || e.source || '', 140)}`);
  for (const w of warnings.slice(0, 4)) brief.push(`告警：${w}`);
  if (!brief.length) {
    brief.push(`gate=${gate.conclusion}、errors=0、reconcile.ok=${reconcile ? reconcile.ok : '?'}`);
    brief.push(`采集批次 ${batches.length} 个：turns ${nfmt(batchesTurns)} / bytes ${bytesHuman(batchesBytes)}`);
  }

  return {
    status: redReasons.length ? 'red' : warnings.length ? 'warn' : 'green',
    detail: detailParts.join('；'),
    evidence: {
      root: ctx.root,
      file,
      reports: names,
      reportDate: date,
      generatedAt: (rep && rep.generatedAt) || null,
      reportSha256: reportSha,
      expectedGapCitations: gapWarnings,
      ageDays,
      gate,
      counts,
      errors: errors.slice(0, 20),
      reconcile: reconcile
        ? {
          ok: reconcile.ok,
          okStrict: reconcile.okStrict,
          ledgerRows: reconcile.ledgerRows,
          codeUnique: reconcile.codeUnique,
          sidTurnUnique: reconcile.sidTurnUnique,
          badLines: reconcile.badLines,
          originalMissing: Array.isArray(reconcile.originalMissing) ? reconcile.originalMissing.length : null,
          originalOrphan: Array.isArray(reconcile.originalOrphan) ? reconcile.originalOrphan.length : null,
          lostGaps: reconcile.lostGaps && typeof reconcile.lostGaps === 'object' ? reconcile.lostGaps.count : null,
        }
        : null,
      batches: { count: batches.length, turns: batchesTurns, bytes: batchesBytes },
      unavailable: Array.isArray(rep && rep.unavailable) ? rep.unavailable : [],
      unexpectedUnavailable,
      redReasons,
      warnings,
    },
    brief,
  };
}

// ============================================================================
// 十、检查项 6：e3 —— 会话只读统计（不灌库）
// ============================================================================

/** e3 项（只读统计：帧数/闭合轮/预期行数；与台账行数比对）。 */
async function checkE3(ctx) {
  if (!ctx.sessions) {
    return { status: 'na', detail: '未提供 --sessions，无法统计预期行数', evidence: { reason: 'MISSING_SESSIONS' }, brief: ['缺 --sessions（DSH_HOME\\sessions）'] };
  }
  const legacy = await loadLib('legacy.js');
  const scan = legacy.scanSessionSources(ctx.sessions);
  const sources = Array.isArray(scan.supported) ? [...scan.supported].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) : [];

  const per = [];
  const totals = { sources: sources.length, closed: 0, open: 0, frames: 0, failed: 0, badLines: 0, lines: 0, malformed: 0, bytes: 0 };
  for (const s of sources) {
    const r = legacy.readSourceTurns(s); // ★ 不传 root：零副作用，不写 .lost/.errors
    const meta = (r && r.meta) || {};
    const closed = Array.isArray(r && r.closed) ? r.closed.length : 0;
    const open = r && r.open ? 1 : 0;
    per.push({
      sid: s.sid || path.basename(s.dir || '') || null,
      source: s.source || `v${s.version}`,
      version: s.version,
      file: path.relative(ctx.sessions, s.path) || s.path,
      bytes: s.size,
      frames: meta.frames || 0,
      lines: meta.lines || 0,
      badLines: meta.badLines || 0,
      failedFrames: meta.failed || 0,
      closed,
      open,
      malformed: r && typeof r.malformed === 'number' ? r.malformed : 0,
      formatError: (r && r.formatError) || '',
      lossGap: !!(r && r.loss && r.loss.hasGap),
    });
    totals.closed += closed;
    totals.open += open;
    totals.frames += meta.frames || 0;
    totals.failed += meta.failed || 0;
    totals.badLines += meta.badLines || 0;
    totals.lines += meta.lines || 0;
    totals.malformed += r && typeof r.malformed === 'number' ? r.malformed : 0;
    totals.bytes += s.size || 0;
  }
  totals.bytes = sources.reduce((sum, s) => sum + (s.size || 0), 0);
  const pairs = Array.isArray(scan.pairs) ? scan.pairs : [];
  const unsupported = Array.isArray(scan.unsupported) ? scan.unsupported : [];
  const v3Only = sources.filter((s) => s.version === 3).length;
  const v4 = sources.filter((s) => s.version === 4).length;

  // 与台账行数比对（账本侧只读；e3 自己绝不写账）
  let comparison = null;
  let ledgerRows = null;
  if (ctx.root) {
    try {
      const lr = await getLedgerSnapshot(ctx);
      ledgerRows = Array.isArray(lr.records) ? lr.records.length : 0;
      const delta = totals.closed - ledgerRows;
      comparison = {
        expectedRows: totals.closed,
        ledgerRows,
        delta,
        verdict: delta === 0 ? '一致' : delta > 0 ? `缺 ${delta} 行（账库少）` : `多 ${-delta} 行（账库多）`,
      };
    } catch (e) {
      comparison = { expectedRows: totals.closed, ledgerRows: null, delta: null, verdict: '无法比对（账库读不出）', error: errMsg(e) };
    }
  }

  const redReasons = [];
  const warnings = [];
  if (sources.length === 0) redReasons.push('sessions 下未发现受支持会话（0 个源）');
  if (comparison && typeof comparison.delta === 'number' && comparison.delta !== 0) redReasons.push(`预期 ${nfmt(comparison.expectedRows)} 轮 ≠ 台账 ${nfmt(comparison.ledgerRows)} 行（${comparison.verdict}）`);
  if (!comparison) warnings.push('未提供 --root：只统计了预期行数，未与台账比对');
  else if (comparison.error) warnings.push(`账库读不出，无法比对：${truncate(comparison.error, 160)}`);
  if (totals.failed > 0) redReasons.push(`源文件坏帧 ${totals.failed} 个（读不全，预期轮数可能偏少）`);
  if (totals.badLines > 0) warnings.push(`源行坏行 ${totals.badLines} 行`);
  if (totals.malformed > 0) warnings.push(`turn 边界异常 ${totals.malformed} 条`);
  if (unsupported.length > 0) warnings.push(`不支持的会话版本 ${unsupported.length} 个`);

  const detailParts = [`只读统计 ${sources.length} 个源（v4 ${v4} / v3-only ${v3Only}）`, `帧 ${nfmt(totals.frames)}`, `闭合轮 ${nfmt(totals.closed)}`, `open ${totals.open}`, `坏帧 ${totals.failed}`];
  if (comparison) detailParts.push(`账库 ${nfmt(comparison.ledgerRows)} 行 → ${comparison.verdict}（差 ${comparison.delta === null ? '?' : nfmt(comparison.delta)}）`);
  detailParts.push('未灌库');

  const brief = [];
  for (const r of redReasons.slice(0, 4)) brief.push(`红：${r}`);
  for (const w of warnings.slice(0, 4)) brief.push(`告警：${w}`);
  if (comparison) brief.push(`预期行数 ${nfmt(comparison.expectedRows)} = 闭合轮数；台账 ${nfmt(comparison.ledgerRows)} 行`);
  for (const p of per.slice(0, 3)) brief.push(`源 ${p.sid || p.file}：v${p.version}，${bytesHuman(p.bytes)}，帧 ${nfmt(p.frames)}，闭合轮 ${nfmt(p.closed)}${p.open ? '，open 1' : ''}`);
  if (pairs.length) brief.push(`v3+v4 并存 ${pairs.length} 对：按 ingest 口径选 v4（v3 不计行数，属正常口径而非缺数据）`);
  if (!brief.length) brief.push('会话统计完成（只读，未灌库）');

  return {
    status: redReasons.length ? 'red' : warnings.length ? 'warn' : 'green',
    detail: detailParts.join('；'),
    evidence: {
      sessions: ctx.sessions,
      readOnly: true,
      ingest: false,
      note: '只数帧/闭合轮/预期行数，不写账、不灌库；灌库是插件 tick 的职责',
      sources: per.slice(0, 50),
      totals: { ...totals, bytes: totals.bytes, sessionsBytes: totals.bytes },
      pairs: pairs.map((p) => ({ dir: p.dir, note: p.note })).slice(0, 20),
      unsupported: unsupported.slice(0, 20),
      comparison,
      redReasons,
      warnings,
    },
    brief,
  };
}

// ============================================================================
// 十一、检查项 7：c19 —— 重放对账（docs/replay-verify.mjs）
// ============================================================================

/** c19 项。 */
async function checkC19(ctx) {
  if (!ctx.root) return { status: 'na', detail: '未提供 --root，无法重放对账', evidence: { reason: 'MISSING_ROOT' }, brief: ['缺 --root'] };
  if (!ctx.sessions) return { status: 'na', detail: '未提供 --sessions，无法重放对账', evidence: { reason: 'MISSING_SESSIONS' }, brief: ['缺 --sessions'] };
  const tool = path.join(ROOT, 'docs', 'replay-verify.mjs');
  if (!fs.existsSync(tool)) {
    return { status: 'na', detail: '包内缺 docs/replay-verify.mjs，无法重放对账', evidence: { tool, reason: 'TOOL_MISSING' }, brief: ['包内缺 replay-verify.mjs'] };
  }
  const r = runNodeTool(tool, [`--root=${ctx.root}`, `--sessions=${ctx.sessions}`, '--json', '--maxDetail=20'], 900000);
  if (r.error || r.exit < 0) throw new Error(`replay-verify 起不来/超时：${childFailureText(r)}`);
  const j = parseToolJson(r, 'replay-verify');

  const mismatches = Array.isArray(j.mismatches) ? j.mismatches : [];
  const counts = j.counts && typeof j.counts === 'object' ? j.counts : {};
  let status;
  const redReasons = [];
  if (r.exit === 0 && j.ok === true) {
    status = 'green';
  } else if (r.exit === 1) {
    status = 'red';
    if (mismatches.length) redReasons.push(`重放不一致 ${mismatches.length} 条（样本 ${mismatches.slice(0, 5).map((m) => (m && (m.kind || m.reason)) || '?').join('、')}）`);
    else redReasons.push('replay-verify exit=1（台账与原文不一致）');
  } else {
    throw new Error(`replay-verify 异常退出（${childFailureText(r)}）`);
  }

  const detail = `重放/比对 ${nfmt(j.compared || 0)} 轮（台账 ${nfmt(j.ledgerRows || 0)} 行，坏行 ${nfmt(counts.ledgerBadLines || 0)}）→ ${status === 'green' ? '一致' : '不一致'}；exit=${r.exit}；${msHuman(r.ms)}`;
  const brief = [];
  for (const x of redReasons.slice(0, 5)) brief.push(`红：${x}`);
  if (!brief.length) {
    brief.push(`重放 ${nfmt(j.replayedTurns || 0)} 轮 / 比对 ${nfmt(j.compared || 0)} 轮 / 不一致 0`);
    brief.push(`台账 ${nfmt(j.ledgerRows || 0)} 行（坏行 ${nfmt(counts.ledgerBadLines || 0)}、读错 ${nfmt(counts.ledgerReadErrors || 0)}）`);
    if (Array.isArray(j.notes) && j.notes.length) brief.push(`notes：${truncate(j.notes.join('；'), 200)}`);
  }

  return {
    status,
    detail,
    evidence: {
      tool,
      root: ctx.root,
      sessions: ctx.sessions,
      exit: r.exit,
      mode: j.mode || 'fields',
      ledgerRows: j.ledgerRows || null,
      replayedTurns: j.replayedTurns || null,
      compared: j.compared || null,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 20),
      counts,
      skipped: j.skipped || null,
      notes: Array.isArray(j.notes) ? j.notes.slice(0, 20) : [],
      elapsedMs: j.elapsedMs || r.ms,
      redReasons,
    },
    brief,
  };
}

// ============================================================================
// 十二、检查项 8：doctor —— 五类体检（--no-write）
// ============================================================================

/** doctor 项。 */
async function checkDoctor(ctx) {
  if (!ctx.root) return { status: 'na', detail: '未提供 --root，无法体检', evidence: { reason: 'MISSING_ROOT' }, brief: ['缺 --root'] };
  const tool = path.join(ROOT, 'tools', 'doctor.mjs');
  if (!fs.existsSync(tool)) throw new Error(`包内缺 tools/doctor.mjs：${tool}`);
  const args = [`--root=${ctx.root}`, '--json', '--no-write'];
  if (ctx.sessions) args.push(`--sessions=${ctx.sessions}`);
  const r = runNodeTool(tool, args, 300000);
  if (r.error || r.exit < 0) throw new Error(`doctor 起不来/超时：${childFailureText(r)}`);
  const j = parseToolJson(r, 'doctor');
  const checks = Array.isArray(j.checks) ? j.checks : [];
  const summary = j.summary && typeof j.summary === 'object' ? j.summary : {};
  const redChecks = checks.filter((c) => c && c.severity === 'red');
  const nonGreen = checks.filter((c) => c && c.severity && c.severity !== 'ok');
  const redReasons = redChecks.map((c) => `${c.id || c.name}（${truncate((c.details && c.details.message) || '', 140)}）`);
  const warnings = nonGreen.filter((c) => c.severity !== 'red').map((c) => `${c.id || c.name}=${c.severity}`);
  let status;
  if (r.exit === 0 && redChecks.length === 0) status = nonGreen.length || summary.warn > 0 || summary.unknown > 0 ? 'warn' : 'green';
  else if (r.exit === 1 || redChecks.length) status = 'red';
  else throw new Error(`doctor 异常退出（${childFailureText(r)}）`);

  const okCount = checks.filter((c) => c && c.severity === 'ok').length;
  const detail = `5 类：ok ${okCount} / warn ${nfmt(summary.warn || 0)} / red ${nfmt(summary.red || 0)} / unknown ${nfmt(summary.unknown || 0)}；${checks.map((c) => `${c.id || '?'}=${c.severity || '?'}`).join('，')}`;
  const brief = [];
  for (const x of redReasons.slice(0, 5)) brief.push(`红：${x}`);
  for (const w of warnings.slice(0, 4)) brief.push(`未绿：${w}`);
  if (!brief.length) for (const c of checks) brief.push(`${c.name || c.id}：${truncate((c.details && c.details.message) || '', 150)}`);

  return {
    status,
    detail,
    evidence: {
      tool,
      root: ctx.root,
      sessions: ctx.sessions || null,
      exit: r.exit,
      ok: j.ok === true,
      summary,
      checks: checks.map((c) => ({
        id: c.id, name: c.name, ok: c.ok, severity: c.severity,
        message: c.details && c.details.message ? truncate(c.details.message, 300) : '',
        ms: c.ms,
      })),
      storage: j.storage || null,
      reportPath: j.reportPath || null,
      noWrite: true,
      redReasons,
      warnings,
    },
    brief,
  };
}

// ============================================================================
// 十三、检查项 9：boundary —— 核心边界（0 violation）
// ============================================================================

/** 找到包内/本包内存在的工具文件。 */
function pickTool(pkgDir, rel) {
  const inPkg = path.join(pkgDir, ...rel.split('/'));
  if (fs.existsSync(inPkg)) return { path: inPkg, fromPackage: true };
  const inRoot = path.join(ROOT, ...rel.split('/'));
  if (fs.existsSync(inRoot)) return { path: inRoot, fromPackage: false };
  return { path: '', fromPackage: false };
}

/** boundary 项。 */
async function checkBoundary(ctx) {
  const picked = pickTool(ctx.packageDir, 'tools/core-boundary.mjs');
  if (!picked.path) throw new Error(`包内缺 tools/core-boundary.mjs（${ctx.packageDir}）`);
  const r = runNodeTool(picked.path, ['--json', `--root=${ctx.packageDir}`], 120000);
  if (r.error || r.exit < 0) throw new Error(`core-boundary 起不来/超时：${childFailureText(r)}`);
  const j = parseToolJson(r, 'core-boundary');
  const violations = Array.isArray(j.violations) ? j.violations : [];
  const hints = Array.isArray(j.hints) ? j.hints : [];
  let status;
  if (r.exit === 0 && violations.length === 0 && j.ok !== false) status = 'green';
  else if (r.exit === 1 || violations.length > 0) status = 'red';
  else throw new Error(`core-boundary 异常退出（${childFailureText(r)}）`);

  const detail = `core ${nfmt(j.coreCount || 0)} 文件 / violation ${violations.length} / index→tools 提示 ${hints.length}（不计违规）`;
  const brief = [];
  for (const v of violations.slice(0, 6)) brief.push(`violation：${v.from || '?'} → ${v.to || '?'}（${v.rule || '?'}）`);
  if (!brief.length) {
    brief.push(`core 文件 ${nfmt(j.coreCount || 0)} 个，0 violation`);
    if (hints.length) brief.push(`index→tools 提示 ${hints.length} 条（设计允许，不计违规）：${hints.slice(0, 3).map((h) => h.to).join('、')}`);
  }

  return {
    status,
    detail,
    evidence: {
      tool: picked.path,
      toolFromPackage: picked.fromPackage,
      package: ctx.packageDir,
      exit: r.exit,
      ok: j.ok === true,
      coreCount: j.coreCount || null,
      coreFiles: Array.isArray(j.coreFiles) ? j.coreFiles : [],
      violations: violations.slice(0, 50),
      hints: hints.slice(0, 20),
      indexToolsEdges: Array.isArray(j.indexToolsEdges) ? j.indexToolsEdges.slice(0, 20) : [],
    },
    brief,
  };
}

// ============================================================================
// 十四、检查项 10：kernel —— 内核边界（基线 PASS/FAIL）
// ============================================================================

/** kernel 项。 */
async function checkKernel(ctx) {
  const picked = pickTool(ctx.packageDir, 'docs/验收-v0.5/工具-内核边界检查.mjs');
  if (!picked.path) {
    return { status: 'na', detail: '包内缺 docs/验收-v0.5/工具-内核边界检查.mjs（无法判内核基线）', evidence: { reason: 'TOOL_MISSING' }, brief: ['包内缺内核边界检查工具'] };
  }
  const r = runNodeTool(picked.path, ['--json', `--package=${ctx.packageDir}`], 120000);
  if (r.error || r.exit < 0) throw new Error(`内核边界检查起不来/超时：${childFailureText(r)}`);

  if (r.exit === 2) {
    // 基线/目标/参数缺失：无法判定 → 未验（不是绿，也不是红）
    return {
      status: 'na',
      detail: `内核检查无法判定（exit=2：基线/目标/参数缺失）：${truncate(r.stderr || r.stdout, 200)}`,
      evidence: { tool: picked.path, package: ctx.packageDir, exit: r.exit, stdout: truncate(r.stdout, 400), stderr: truncate(r.stderr, 400), reason: 'NO_BASELINE_OR_TARGET' },
      brief: [`内核检查 exit=2（基线/目标缺失，未验）`],
    };
  }
  const j = parseToolJson(r, '内核边界检查');
  const kernelChanged = Array.isArray(j.kernelChanged) ? j.kernelChanged : [];
  const controlledChanged = Array.isArray(j.controlledChanged) ? j.controlledChanged : [];
  const controlledMissing = Array.isArray(j.controlledMissing) ? j.controlledMissing : [];
  let status;
  const redReasons = [];
  if (r.exit === 0 && kernelChanged.length === 0 && String(j.result || '') !== 'kernel-changed') {
    status = controlledMissing.length ? 'warn' : 'green';
  } else if (r.exit === 1 || kernelChanged.length > 0 || String(j.result || '') === 'kernel-changed') {
    status = 'red';
    for (const c of kernelChanged.slice(0, 6)) redReasons.push(`KERNEL 被改：${c.rel || c.before || '?'}`);
  } else {
    throw new Error(`内核检查异常退出（${childFailureText(r)}）`);
  }
  const verdict = status === 'red' ? 'FAIL' : 'PASS';
  const detail = `${verdict}（result=${j.result || '?'}）/ 基线 ${j.baselineName || '?'}${j.baselineAuto ? '（自动选版本号最大）' : ''} / KERNEL ${nfmt((j.totals && j.totals.kernel) || 0)} 文件 / CONTROLLED 变更 ${controlledChanged.length}（允许）`;
  const brief = [];
  for (const x of redReasons.slice(0, 6)) brief.push(`红：${x}`);
  if (!brief.length) {
    brief.push(`PASS：result=${j.result || '?'}，基线 ${j.baselineName || '?'}`);
    brief.push(`KERNEL 六文件未动；CONTROLLED 变更 ${controlledChanged.length} 个（按边界检查允许）`);
    if (controlledMissing.length) brief.push(`CONTROLLED 缺文件 ${controlledMissing.length} 个：${controlledMissing.slice(0, 3).map((x) => x.rel || x).join('、')}`);
  }

  return {
    status,
    detail,
    evidence: {
      tool: picked.path,
      toolFromPackage: picked.fromPackage,
      package: ctx.packageDir,
      exit: r.exit,
      result: j.result || null,
      verdict,
      baseline: j.baseline || null,
      baselineName: j.baselineName || null,
      baselineAuto: j.baselineAuto === true,
      kernelChanged: kernelChanged.slice(0, 50),
      controlledChanged: controlledChanged.slice(0, 50),
      controlledMissing: controlledMissing.slice(0, 50),
      totals: j.totals || null,
      redReasons,
    },
    brief,
  };
}

// ============================================================================
// 十五、MD 渲染（一页；红项/异常排最前，含"最该先看"）
// ============================================================================

/** 状态 → 中文标签。 */
function statusLabel(status) {
  return { green: '绿', red: '红', warn: '黄', na: '未验', error: '异常' }[status] || String(status);
}

/** 状态 → MD 徽标（纯文本，避免控制台 emoji 乱码）。 */
function statusBadge(status) {
  return { green: '[绿]', red: '[红]', warn: '[黄]', na: '[未验]', error: '[异常]' }[status] || `[${status}]`;
}

/** 渲染一页 MD。 */
function renderMd(result) {
  const { summary, host, inputs } = result;
  const md = [];
  const plugin = host.plugin ? `插件 ${host.plugin}` : '插件版本未取到（na）';
  md.push(`# 设备自检 · ${plugin}（三台设备验收）`, '');
  md.push(`- 生成：${result.generatedAt} ｜ 用时 ${result.elapsedMs} ms ｜ 主机 ${host.hostname}`);
  md.push(`- 平台：${host.platform || os.type()} ｜ node v${host.node || process.versions.node} ｜ DSH ${host.dshVersion || 'na'}`);
  md.push(`- 账库：${inputs.root || '（未提供 --root）'}`);
  md.push(`- 包：${inputs.package}`);
  md.push(`- sessions：${inputs.sessions || '（未提供 --sessions）'}`);
  if (inputs.only) md.push(`- 复跑范围：--only=${inputs.only.join(',')}（未选项不产出）`);
  md.push('');
  md.push(`**结论：${summary.verdict === 'green' ? '全绿' : summary.verdict === 'red' ? '有红项，未通过' : summary.verdict === 'error' ? '有检查没跑起来' : summary.verdict === 'unverified' ? '有未验项，不能判通过' : '无红项，有黄项'}**（绿 ${summary.green} / 红 ${summary.red} / 黄 ${summary.warn} / 未验 ${summary.na} / 异常 ${summary.error}；exit=${summary.exitCode}）`);
  md.push('');
  md.push(`> ${result.firstAction}`);
  md.push('');

  const bad = result.checks.filter((c) => c.status === 'red' || c.status === 'error');
  if (bad.length) {
    md.push(`## 红项 / 异常（${bad.length}）`, '');
    for (const c of bad) {
      md.push(`### ${statusBadge(c.status)} ${c.id} · ${c.name}`, '');
      md.push(`- 摘要：${mdCell(c.detail, 400)}`);
      for (const b of c.brief.slice(0, 6)) md.push(`- ${mdCell(b, 260)}`);
      md.push('');
    }
  } else {
    md.push('## 红项 / 异常（0）', '', '无红项。', '');
  }

  const rest = result.checks.filter((c) => c.status !== 'red' && c.status !== 'error');
  md.push('## 其余检查', '');
  md.push('| 检查项 | 状态 | 摘要 |');
  md.push('|---|---|---|');
  for (const c of rest) md.push(`| ${c.id} · ${c.name} | ${statusLabel(c.status)} | ${mdCell(c.detail, 220)} |`);
  md.push('');

  md.push('## 设备指纹', '');
  const env = result.checks.find((c) => c.id === 'env');
  const ev = env && env.evidence ? env.evidence : null;
  if (ev && ev.os) {
    md.push(`- 主机：${ev.os.hostname}（${ev.os.version || ev.os.release}，${ev.os.arch}）`);
    md.push(`- 内存：${ev.memory.totalGiB} GiB 总量 / ${ev.memory.freeGiB} GiB 可用`);
    md.push(`- node：v${ev.node.version}（${ev.node.execPath}）`);
    md.push(`- DSH：${ev.dsh && ev.dsh.version ? `${ev.dsh.version}（${ev.dsh.source}）` : '取不到（na）'}`);
    md.push(`- 插件：${ev.plugin ? `${[ev.plugin.line, versionLabel(ev.plugin)].filter(Boolean).join(' ')}（基线 ${ev.plugin.baselineTag || '?'}，测试 ${ev.plugin.tests ? `${ev.plugin.tests.pass}/${ev.plugin.tests.total}` : '?'}）` : 'VERSION.json 读不到（na）'}`);
    for (const d of ev.disks || []) {
      md.push(`- ${d.label} ${d.path}：${typeof d.freeBytes === 'number' ? `可用 ${bytesHuman(d.freeBytes)} / 共 ${bytesHuman(d.totalBytes)}` : `不可读（${d.error || '?'}）`}`);
    }
  } else {
    md.push(`- 主机：${host.hostname} ｜ node v${host.node}`);
  }
  md.push('');

  const unverified = result.checks.filter((c) => c.status === 'na' || c.status === 'warn');
  const envSelected = result.checks.some((c) => c.id === 'env');
  const dshMissing = envSelected && !(ev && ev.dsh && ev.dsh.version);
  const notSelected = CHECK_ORDER.filter((id) => !result.checks.some((c) => c.id === id));
  md.push('## 未验 / 取不到（未验 ≠ 通过）', '');
  if (!unverified.length && !dshMissing && !notSelected.length) md.push('- 无');
  for (const c of unverified) md.push(`- ${c.id}：${statusLabel(c.status)} —— ${mdCell(c.detail, 240)}`);
  if (dshMissing) md.push('- env.dshVersion：取不到（na）—— 可在跑自检前设 `DSH_VERSION=<版本>` 或确认 `DSH_NODE_EXECUTABLE` 指向 DSH 桌面 exe');
  if (notSelected.length) md.push(`- 本次 --only 未跑（不产出、不算未验）：${notSelected.join('、')}`);
  md.push('');

  md.push('## 产物与复跑', '');
  md.push(`- JSON：${result.artifacts.json}`);
  md.push(`- MD：${result.artifacts.md}`);
  md.push(`- 复跑：node docs\\工具-设备自检.mjs --out=<结果目录> --root=<账库根> --sessions=<sessions目录>`);
  md.push('- 只读声明：除 --out 外未写文件；账库 readAll(requireLedgerRows:true, repairTornTail:false)，未开 quarantine；e3 只读统计不灌库；doctor --no-write；replay 普通模式零写盘');
  md.push('');
  return md.join('\n');
}

// ============================================================================
// 十六、入口（全局异常 → exit 3；用法/环境错误 → exit 2）
// ============================================================================

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  if (e instanceof UsageError) {
    process.stderr.write(`用法错误：${e.message}\n`);
    process.exitCode = 2;
  } else if (e instanceof EnvError) {
    process.stderr.write(`环境错误：${e.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`自检器自身异常：${errMsg(e)}\n${String((e && e.stack) || '').split('\n').slice(0, 10).join('\n')}\n`);
    process.exitCode = 3;
  }
});
