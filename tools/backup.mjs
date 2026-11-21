#!/usr/bin/env node
/**
 * @file tools/backup.mjs
 * @role **账库增量备份 / 备份校验 / 恢复**（0.9.4-P3 扩容方案 §4.6、C37；E4-6 的执行器）。
 *       把"整库搬走 = 拷目录 + 一条命令验读"落成一个可重复、可退出码判定的外置 CLI。
 *
 * @why 为什么需要它（C37）：三年 363 GiB 的账库**没有备份就等于没有账**。但"全量拷"在
 *      日记增量面前是浪费（每日新增原文+台账≈350 MB，全量 363 GiB），所以必须先有
 *      **增量**；而任何备份都必须能被独立验证（否则"备份了"只是希望，不是事实）。
 *
 * ★ 三条硬约束（写死在实现里，改任何一条都要先改设计）：
 *   1) **只读源账库**：`backup` 对 `--root` 只做 readdir/stat/读文件；**唯一写动作**
 *      全部落在 `--out`（备份目录）内。`verify`/`restore` 对 `--out` 只读。
 *   2) **绝不覆盖已有账库**：`restore` 拒绝把文件写进"看起来已经是账库"的目标
 *      （有 `.ledger-root` / `ledger/` / `账簿总目录.md` / 月份目录），**`--force` 也不解除**；
 *      任何目标文件已存在且内容不同 = 冲突 → 拒绝（exit 2，零写入）。
 *   3) **默认 dry-run**：`restore` 不给 `--write` 就只出计划（零写入）；
 *      `--force` 只解除"目标目录非空"这一条，**不触发写**（写必须显式 `--write`）。
 *
 * 备份目录自包含（离开 `--root` 也能验、能恢复）：
 *
 *   <out>/
 *   ├─ backup.json        # 时间 / 源 / 模式 / 统计 / 跳过策略 / 跳过原因（人读 + 机器读）
 *   ├─ MANIFEST.sha256    # 逐文件 sha256（sha256sum 格式；**排除自身**，包含 backup.json）
 *   └─ files/…            # 账库原相对路径的逐字节副本（restore 只从这里搬）
 *
 * 增量判定口径（按"文件身份"而不是 mtime 猜）：
 *   · 身份 = 相对路径 + 内容 sha256（完整性事实；与 `lib/original.js` 的整文件 sha256 同口径）；
 *   · 上次备份的 MANIFEST 里同路径、同 sha256 → 未变，不拷、不改；
 *   · 路径不在上次 MANIFEST（新增）/ sha256 不同（变化）/ 备份副本丢失（自愈重拷）→ 拷贝；
 *   · 原文视图/附件额外记 `code`（文件名即编码），报告按 `view/attachment/ledger/weekly/other`
 *     分类给出"本次只拷了哪些项"，便于对账（E4-6：追加 1 行 + 1 个原文 → 只拷 2 项）；
 *   · 源文件被删/被改名：增量**保留**旧副本（备份的意义就是留住历史），只在报告里
 *     `sourceRemoved` 告警；`--full` 才是镜像（会删除上次 MANIFEST 里、本次源已没有的旧副本）。
 *   · `--since=YYYYMMDD`：只把本地(+08:00) mtime ≥ 该日的文件纳入"本次候选"；比该日旧
 *     但**不在**上次备份里的文件会进 `sinceUncovered` 告警（不静默丢）。注意：`--since`
 *     按 mtime 过滤，不适用于"内容变了但 mtime 没变"的篡改场景；不给 `--since` 时按内容
 *     sha256 全量比对，不会漏。
 *
 * 默认跳过（报告里如实列 `policy.skipped` 与每个跳过的文件数/字节）：
 *   · `ledger/.tick-metrics.jsonl`（运行度量，非账务事实；容量按阈值告警另管）→ `--include-metrics` 打开；
 *   · `.index/`、`索引/`（外置索引，可由台账重建）→ `--include-index` 打开；
 *   · 符号链接（不跟随：防环、防备份出账库边界）。
 *   ★ 其余**一律备份**（含 `.ledger-root`、`账簿总目录.md`、`ledger/.state.json`、
 *     `.seal-journal.jsonl`、交接表/清册/体检、运行报告等），否则恢复出来的库不可读/不可审计。
 *
 * 用法：
 *   node tools\backup.mjs backup  --root=<账库根> --out=<备份目录> [--since=YYYYMMDD] [--full]
 *                                [--include-index] [--include-metrics] [--json]
 *   node tools\backup.mjs verify  --out=<备份目录> [--json]
 *   node tools\backup.mjs restore --out=<备份目录> --to=<目标目录> [--dry-run] [--force] [--write] [--json]
 *
 * 退出码：0 = 成功/无缺多改；1 = verify 发现缺/多/改、写后自检失败、恢复后账库读不出；
 *         2 = 用法/环境错误、安全拒绝（目标非账库、冲突、恢复目标像已有账库、源不可读等）。
 *
 * 内存纪律（方案 §5 通用纪律）：commit 余量由调用方守卫；本工具自身**流式**读文件算 sha256
 *   （1 MiB 块，不整读大文件），但文件清单是内存 Map —— 超过 `MAX_SCAN_FILES`（50 万）直接
 *   exit 2 拒绝（517 KB/千文件级内存，500k ≈ 100–150 MB，仍守 500 MB 预算）；
 *   更大库的分页/流式清单留 re1（见交付说明"未做/存疑"）。
 *
 * 已知边界（如实写）：
 *   · 不是增量块级备份：被改动的大文件（如当日台账 jsonl 追加 1 行）整文件重拷——按日分文件
 *     的设计让这仍远小于全量，但不是 rsync 级；大 xlsx 变更会重拷整本。
 *   · `verify` 对备份内**全部文件**重算 sha256（2.6 MB 夹具毫秒级；363 GiB 全量验 ≈ 读盘一遍）。
 *   · 备份目录不含 `MANIFEST.sha256` 自身（自指 hash 不可能成立）；它把 `backup.json` 纳入清单，
 *     所以改元数据也会被 verify 报"改"。
 *
 * @depends node:fs / node:path / node:crypto / node:url；../lib/ledger.js（stampLocal、readAll，
 *          只读）、../lib/ledgerroot.js（readRootMarker，只读）
 * @called-by 手动 / 外部日跑（本版不自动接线）；**不进 tick**，`index.js` 不 import 它。
 * @writes 仅 `--out` 内：`backup.json`、`MANIFEST.sha256`、`files/**`（tmp+rename 原子写）；
 *         `restore --write` 仅写 `--to` 内（拒绝覆盖任何已存在且内容不同的文件）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readAll, stampLocal } from '../lib/ledger.js';
import { readRootMarker } from '../lib/ledgerroot.js';

// ============================================================================
// 一、常量（阈值/上限全部有出处；报告里披露，不新增任何配置键）
// ============================================================================

export const SCHEMA = 'lite-backup/1';
export const TOOL_VERSION = '1.0';

/** 时区口径固定 +08:00（与台账 ts / 原文路径 / 总目录同名口径一致）。 */
const OFFSET_MINUTES = 480;

/** 备份目录内的固定名字（**只在这里各出现一次**）。 */
export const FILES_DIR = 'files';
export const MANIFEST_NAME = 'MANIFEST.sha256';
export const META_NAME = 'backup.json';

/** 清单条目上限（内存纪律；超限 exit 2，见文件头"已知边界"）。 */
export const MAX_SCAN_FILES = 500_000;

/** 流式 sha256 的块大小（1 MiB；不整读大文件）。 */
const CHUNK_BYTES = 1024 * 1024;

/** 单条报告里列出的样例上限（JSON 仍给全量的 only counts；大列表只留前 N 条 + 总数）。 */
const SAMPLE_MAX = 20;

/** 原文视图文件名：`<code>[.vN] 完整原文.md`（与 lib/catalog.js 同规则；版本不重复计份）。 */
const VIEW_RE = /^([0-9]{8}-[0-9a-z]{12}-[A-Z]-[0-9]{8})(?:\.v(\d+))? 完整原文\.md$/;
/** 原始事件附件文件名：`<code> 原始事件.json`（D11）。 */
const ATTACH_RE = /^([0-9]{8}-[0-9a-z]{12}-[A-Z]-[0-9]{8}) 原始事件\.json$/;
/** 周记账文件名（与面板/周账写端同一规则）。 */
const WEEKLY_RE = /^\d{2}月第\d+周-.+的周记账\.xlsx$/;
/** 台账日文件：`ledger/YYYY-MM-DD.jsonl`（非隐藏）。 */
const LEDGER_DAY_RE = /^ledger\/\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 文件类别（报告分类统计用）。 */
export const FILE_KIND = Object.freeze({
  VIEW: 'view',
  ATTACHMENT: 'attachment',
  LEDGER: 'ledger',
  WEEKLY: 'weekly',
  OTHER: 'other',
});
const KIND_ORDER = [FILE_KIND.VIEW, FILE_KIND.ATTACHMENT, FILE_KIND.LEDGER, FILE_KIND.WEEKLY, FILE_KIND.OTHER];

/**
 * 默认跳过规则（可被 `--include-index` / `--include-metrics` 解除）。
 * @why 跳过的两项都**不是账务事实**：`.tick-metrics.jsonl` 是运行度量（到量由容量告警管），
 *      `.index/`/`索引/` 是台账的可重建派生层。其余运行区文件（`.state.json`、`.seal-journal.jsonl`、
 *      运行报告）**必须备份**——否则恢复出来的库不能继续跑、审计链也断。
 */
const SKIP_RULES = Object.freeze([
  {
    key: 'index',
    kind: 'dir',
    why: '外置索引可重建（方案 §4.1；默认不备份，--include-index 可打开）',
    match: (name) => name === '.index' || name === '索引',
    opt: 'includeIndex',
  },
  {
    key: 'metrics',
    kind: 'file',
    why: '运行度量非账务事实（容量按容量阈值告警另管；默认不备份，--include-metrics 可打开）',
    match: (name) => name === '.tick-metrics.jsonl',
    opt: 'includeMetrics',
  },
]);

const USAGE = `用法：
  node tools\\backup.mjs backup  --root=<账库根> --out=<备份目录> [--since=YYYYMMDD] [--full]
                                [--include-index] [--include-metrics] [--json]
  node tools\\backup.mjs verify  --out=<备份目录> [--json]
  node tools\\backup.mjs restore --out=<备份目录> --to=<目标目录> [--dry-run] [--force] [--write] [--json]

命令：
  backup   增量备份（首次/--full 为全量）。默认跳 ledger/.tick-metrics.jsonl 与 .index/、索引/；
           其余文件（含 .ledger-root、账簿总目录、.state.json、.seal-journal、交接表/清册/体检）全备份。
  verify   校验备份内 MANIFEST.sha256：报「缺（清单有盘上没有）/ 多（盘上有清单没有）/ 改（sha256 不同）」。
  restore  默认 dry-run（零写入）；真恢复必须显式 --write。目标非空需 --force；
           目标像已有账库（.ledger-root / ledger/ / 账簿总目录.md / 月份目录）一律拒绝，--force 也不解除；
           任何目标文件已存在且内容不同 = 冲突 → 拒绝（绝不覆盖）。

退出码：0=成功/无缺多改；1=verify 有缺多改/写后自检失败；2=用法或环境错误、安全拒绝。
只读源账库；本工具不进 tick。`;

// ============================================================================
// 二、小工具
// ============================================================================

const pad2 = (n) => String(n).padStart(2, '0');
const errMsg = (e) => String((e && e.message) || e || '未知错误').slice(0, 400);

/** 本地(+08:00) `YYYYMMDD` 时间戳（报告时间；与合约戳同口径）。 */
function stampNow(nowMs) {
  return stampLocal(Number.isFinite(nowMs) ? nowMs : Date.now(), OFFSET_MINUTES);
}

/** `YYYYMMDD` → 该日本地 00:00 的毫秒（+08:00 用 Date.UTC 反推）；非法返回 NaN。 */
export function ymdToMs(ymd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd || ''));
  if (!m) return NaN;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const ms = Date.UTC(y, mo - 1, d) - OFFSET_MINUTES * 60000;
  const back = new Date(ms + OFFSET_MINUTES * 60000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return NaN;
  return ms;
}

/** `ms` → 本地 `YYYY-MM-DD`。 */
function localDateOf(ms) {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 人读体积。 */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '?';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** `child` 是否等于 `parent` 或位于其下（Windows 大小写不敏感）。 */
export function isInsideOrEqual(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  const rel = path.relative(p, c);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/** 安全 readdir（读不了 = 空，一个坏目录不能把整次备份打挂；错误由调用方收集）。 */
function safeReaddir(dir, opts) {
  try { return fs.readdirSync(dir, opts); } catch { return []; }
}

/** 相对路径统一用 `/`（MANIFEST 用 sha256sum 口径；Windows 上也稳定可读）。 */
const toPosix = (rel) => String(rel).split(path.sep).join('/');

/** 流式算文件 sha256（1 MiB 块；不整读大文件，守内存预算）。 */
export function sha256File(abs) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 目录 fsync（尽力而为；不支持的文件系统静默跳过）。 */
function fsyncDirBestEffort(dir) {
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* ignore */ } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 临时文件名（同目录内，rename 原子发布；`.` 开头不会被当成账库文件）。 */
function tmpNameFor(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}`);
}

/** 覆盖写文本（tmp+fsync+rename；Windows rename 不能覆盖已存在文件 → 先 unlink）。 */
export function writeFileAtomic(target, text) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpNameFor(target);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  try {
    fs.renameSync(tmp, target);
  } catch {
    try { fs.unlinkSync(target); } catch { /* ignore */ }
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
  fsyncDirBestEffort(path.dirname(target));
}

/**
 * 单遍"拷贝 + 算 sha256 + fsync"（不二次读源；用于新增/变化文件）。
 * @param {{overwrite?:boolean}} [opts] overwrite=false 时目标已存在即抛 EEXIST（restore 用）
 * @returns {{sha256:string, bytes:number}}
 */
export function copyFileHashed(srcAbs, dstAbs, opts = {}) {
  const overwrite = opts.overwrite !== false;
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  if (!overwrite && fs.existsSync(dstAbs)) {
    const err = new Error(`目标已存在（拒绝覆盖）：${dstAbs}`);
    err.code = 'EEXIST';
    throw err;
  }
  const tmp = tmpNameFor(dstAbs);
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let inFd = -1;
  let outFd = -1;
  let bytes = 0;
  try {
    inFd = fs.openSync(srcAbs, 'r');
    outFd = fs.openSync(tmp, 'wx');
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      fs.writeSync(outFd, buf, 0, n);
      bytes += n;
    }
    fs.fsyncSync(outFd);
  } catch (e) {
    try { fs.closeSync(inFd); } catch { /* ignore */ }
    inFd = -1;
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    outFd = -1;
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  } finally {
    if (inFd !== -1) { try { fs.closeSync(inFd); } catch { /* ignore */ } }
    if (outFd !== -1) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
  }
  try {
    if (!overwrite && fs.existsSync(dstAbs)) throw Object.assign(new Error(`目标在拷贝过程中出现（拒绝覆盖）：${dstAbs}`), { code: 'EEXIST' });
    fs.renameSync(tmp, dstAbs);
  } catch (e) {
    if (!overwrite) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    try { fs.unlinkSync(dstAbs); } catch { /* ignore */ }
    try {
      fs.renameSync(tmp, dstAbs);
    } catch (e2) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e2;
    }
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** 读 JSON 文件（不抛；返回 {ok,json,error}）。 */
function readJsonFile(file) {
  try {
    return { ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')), error: '' };
  } catch (e) {
    return { ok: false, json: null, error: errMsg(e) };
  }
}

/** 文件是否存在且是普通文件（stat 失败按不存在）。 */
function isFile(abs) {
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

// ============================================================================
// 三、分类与目录树（源账库 → 文件清单）
// ============================================================================

/**
 * 相对路径 → 类别 + `code`（原文/附件才有 code）。
 * @param {string} rel 源账库内相对路径（`/` 分隔）
 * @returns {{kind:string, code:string}} `kind`∈FILE_KIND；`code` 无则 ''
 */
export function classifyRel(rel) {
  const name = rel.split('/').pop() || '';
  let m = VIEW_RE.exec(name);
  if (m) return { kind: FILE_KIND.VIEW, code: m[1] };
  m = ATTACH_RE.exec(name);
  if (m) return { kind: FILE_KIND.ATTACHMENT, code: m[1] };
  if (LEDGER_DAY_RE.test(rel)) return { kind: FILE_KIND.LEDGER, code: '' };
  if (WEEKLY_RE.test(name)) return { kind: FILE_KIND.WEEKLY, code: '' };
  return { kind: FILE_KIND.OTHER, code: '' };
}

/**
 * 遍历源账库。
 * @param {string} root
 * @param {{includeIndex?:boolean, includeMetrics?:boolean}} opts
 * @returns {{files:Array<{rel:string,abs:string,size:number,mtimeMs:number}>,
 *            skipped:Array<{rel:string,rule:string,why:string,bytes:number}>,
 *            errors:Array<{path:string,message:string}>}}
 *
 * @why 自己写 walk 而不是 `readdir recursive`：①要按规则跳过 `.index/`/`.tick-metrics.jsonl`；
 *      ②要**不跟随符号链接**（防环、防备份出账库边界）；③要逐文件 stat 拿 size/mtime
 *      （增量判定与报告都要）。坏目录记 errors、不崩、不假绿。
 */
export function walkSource(root, opts = {}) {
  const files = [];
  const skipped = [];
  const errors = [];
  const stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: rel || root, message: errMsg(e) });
      continue;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      // 符号链接：不跟随、不备份（环 / 越界 / 双份内容都会让"备份=源"变成谎话）
      let isSymlink = false;
      try { isSymlink = ent.isSymbolicLink(); } catch { isSymlink = false; }
      if (isSymlink) {
        skipped.push({ rel: childRel, rule: 'symlink', why: '符号链接不跟随（防环/防越界）', bytes: 0 });
        continue;
      }
      if (ent.isDirectory()) {
        const rule = SKIP_RULES.find((r) => r.kind === 'dir' && r.match(ent.name));
        if (rule && !opts[rule.opt]) {
          skipped.push({ rel: childRel + '/', rule: rule.key, why: rule.why, bytes: 0 });
          continue;
        }
        stack.push({ dir: path.join(dir, ent.name), rel: childRel });
        continue;
      }
      if (!ent.isFile()) {
        skipped.push({ rel: childRel, rule: 'non-file', why: '不是普通文件（设备/FIFO 等）', bytes: 0 });
        continue;
      }
      const rule = SKIP_RULES.find((r) => r.kind === 'file' && r.match(ent.name));
      if (rule && !opts[rule.opt]) {
        let size = 0;
        try { size = fs.statSync(path.join(dir, ent.name)).size; } catch { /* ignore */ }
        skipped.push({ rel: childRel, rule: rule.key, why: rule.why, bytes: size });
        continue;
      }
      const abs = path.join(dir, ent.name);
      let st;
      try { st = fs.statSync(abs); } catch (e) {
        errors.push({ path: childRel, message: errMsg(e) });
        continue;
      }
      files.push({ rel: childRel, abs, size: st.size, mtimeMs: st.mtimeMs });
      if (files.length > MAX_SCAN_FILES) {
        const err = new Error(`源账库文件数超过上限 ${MAX_SCAN_FILES}（内存纪律；分页/流式清单留 re1）`);
        err.code = 'E_TOO_MANY_FILES';
        throw err;
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped, errors };
}

/** 按规则把 skipped 聚合（报告用）。 */
function aggregateSkipped(skipped) {
  const map = new Map();
  for (const s of skipped) {
    const prev = map.get(s.rule) || { rule: s.rule, why: s.why, files: 0, bytes: 0 };
    prev.files += 1;
    prev.bytes += Number(s.bytes) || 0;
    map.set(s.rule, prev);
  }
  const out = [...map.values()].sort((a, b) => (a.rule < b.rule ? -1 : 1));
  return { rules: out, files: out.reduce((n, r) => n + r.files, 0), bytes: out.reduce((n, r) => n + r.bytes, 0) };
}

// ============================================================================
// 四、MANIFEST / backup.json 读写
// ============================================================================

/**
 * 解析 `MANIFEST.sha256`（sha256sum 格式：`<64hex>␠␠<rel>`）。
 * @param {string} text
 * @returns {{entries:Map<string,string>, errors:string[]}}
 *
 * @why 严格路径校验：拒绝绝对路径 / 盘符 / `..` / 空段 / 反斜杠转义 —— 清单是**外部输入**，
 *      伪造的清单不能让 restore 把文件写到 `<out>` 或 `<to>` 之外。
 */
export function parseManifestText(text) {
  const entries = new Map();
  const errors = [];
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { errors.push(`第 ${i + 1} 行格式非法（不是 "<sha256>  <rel>"）：${line.slice(0, 100)}`); continue; }
    const rel = m[2];
    const bad = (why) => errors.push(`第 ${i + 1} 行路径非法（${why}）：${rel.slice(0, 120)}`);
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\\\')) { bad('绝对路径'); continue; }
    if (rel.includes('\\')) { bad('含反斜杠（口径为 / 分隔）'); continue; }
    if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) { bad('空段/./..'); continue; }
    if (rel === MANIFEST_NAME) { bad('清单不得包含自身（自指 hash 不可能成立）'); continue; }
    if (entries.has(rel)) { errors.push(`第 ${i + 1} 行重复条目：${rel}`); continue; }
    m[1] = m[1].toLowerCase();
    entries.set(rel, m[1]);
  }
  return { entries, errors };
}

/**
 * 读备份目录的 MANIFEST + backup.json。
 * @returns {{exists:boolean, empty:boolean, foreign:boolean, broken:string,
 *            meta:object|null, entries:Map<string,string>, errors:string[]}}
 *          `foreign`=目录非空但不是本工具的备份；`broken`=形状像备份但读不出
 */
export function inspectBackupDir(outDir) {
  const res = { exists: false, empty: false, foreign: false, broken: '', meta: null, entries: new Map(), errors: [] };
  let st;
  try { st = fs.statSync(outDir); } catch { return { ...res, exists: false }; }
  if (!st.isDirectory()) return { ...res, exists: true, broken: `--out 不是目录：${outDir}` };
  res.exists = true;
  let names = [];
  try { names = fs.readdirSync(outDir); } catch (e) {
    return { ...res, exists: true, broken: `--out 读不出：${errMsg(e)}` };
  }
  if (names.length === 0) return { ...res, empty: true };
  const hasMeta = names.includes(META_NAME);
  const hasMan = names.includes(MANIFEST_NAME);
  if (!hasMeta || !hasMan) {
    res.foreign = true;
    res.broken = `--out 非空但不是本工具的备份（缺 ${[hasMeta ? '' : META_NAME, hasMan ? '' : MANIFEST_NAME].filter(Boolean).join(' / ')}）：${outDir}`;
    return res;
  }
  const metaRead = readJsonFile(path.join(outDir, META_NAME));
  if (!metaRead.ok) return { ...res, broken: `backup.json 读不出：${metaRead.error}` };
  const meta = metaRead.json;
  if (!meta || typeof meta !== 'object' || meta.schema !== SCHEMA) {
    return { ...res, broken: `backup.json schema 不是 ${SCHEMA}（收到 ${JSON.stringify(meta && meta.schema)}）` };
  }
  let manText;
  try { manText = fs.readFileSync(path.join(outDir, MANIFEST_NAME), 'utf8'); } catch (e) {
    return { ...res, broken: `MANIFEST.sha256 读不出：${errMsg(e)}` };
  }
  const parsed = parseManifestText(manText);
  res.meta = meta;
  res.entries = parsed.entries;
  res.errors = parsed.errors;
  return res;
}

/** 渲染 MANIFEST 文本（按 rel 排序，LF 结尾；sha256sum 兼容）。 */
export function renderManifest(entries) {
  const keys = [...entries.keys()].sort();
  const lines = keys.map((rel) => `${entries.get(rel)}  ${rel}`);
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** 备份内副本路径：`<out>/files/<rel>`。 */
const backupCopyPath = (outDir, sourceRel) => path.join(outDir, FILES_DIR, ...sourceRel.split('/'));
/** 清单 key：`files/<rel>`。 */
const manifestKeyOf = (sourceRel) => `${FILES_DIR}/${sourceRel}`;

// ============================================================================
// 五、backup 增量备份
// ============================================================================

/**
 * 执行一次备份（全量或增量）。**只写 outDir**，源账库只读。
 * @param {{root:string, outDir:string, since?:string, full?:boolean,
 *          includeIndex?:boolean, includeMetrics?:boolean, nowMs?:number}} opts
 * @returns {{ok:boolean, exitCode:number, report:object}}
 */
export function runBackup(opts = {}) {
  const startedMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const root = path.resolve(String(opts.root || ''));
  const outDir = path.resolve(String(opts.outDir || ''));
  const report = {
    schema: SCHEMA,
    toolVersion: TOOL_VERSION,
    command: 'backup',
    ok: false,
    exitCode: 2,
    root,
    out: outDir,
    mode: 'incremental',
    since: opts.since || null,
    startedAt: stampNow(startedMs),
    finishedAt: '',
    elapsedMs: 0,
    source: { rootId: '', markerFound: false },
    policy: {
      includeIndex: opts.includeIndex === true,
      includeMetrics: opts.includeMetrics === true,
      skipped: [],
    },
    scanned: { files: 0, bytes: 0 },
    candidates: { files: 0, bytes: 0 },
    copied: { files: 0, bytes: 0, byKind: emptyKindStats() },
    unchangedFiles: 0,
    added: [],
    changed: [],
    repaired: [],
    pruned: { files: 0, bytes: 0 },
    sourceRemoved: [],
    sinceUncovered: [],
    manifest: { file: MANIFEST_NAME, entries: 0, excludesSelf: true },
    counts: { files: 0, bytes: 0, byKind: emptyKindStats() },
    warnings: [],
    errors: [],
  };
  const fail = (exitCode, message) => {
    report.errors.push(message);
    report.exitCode = exitCode;
    report.finishedAt = stampNow(Date.now());
    report.elapsedMs = Date.now() - startedMs;
    return { ok: false, exitCode, report };
  };

  // ── 参数/环境 ─────────────────────────────────────────────────────────────
  let srcStat;
  try { srcStat = fs.statSync(root); } catch { return fail(2, `--root 不存在：${root}`); }
  if (!srcStat.isDirectory()) return fail(2, `--root 不是目录：${root}`);
  try { fs.accessSync(root, fs.constants.R_OK); } catch { return fail(2, `--root 不可读：${root}`); }
  if (!opts.outDir) return fail(2, '必须给 --out=<备份目录>');
  if (root === outDir || isInsideOrEqual(root, outDir)) {
    return fail(2, `--out 不能等于/位于 --root 之内（账库只读、且会把备份自己扫进去）：root=${root} out=${outDir}`);
  }
  if (isInsideOrEqual(outDir, root)) {
    return fail(2, `--root 不能位于 --out 之内（会备份到备份里）：root=${root} out=${outDir}`);
  }
  let sinceMs = null;
  if (opts.since) {
    sinceMs = ymdToMs(opts.since);
    if (!Number.isFinite(sinceMs)) return fail(2, `--since 必须是真实日期 YYYYMMDD（收到 ${opts.since}）`);
  }

  // ── 读上次备份（增量基线）────────────────────────────────────────────────
  const insp = inspectBackupDir(outDir);
  if (insp.broken && !insp.foreign) return fail(2, `上次备份不可用（${insp.broken}）—— 请先 verify，或换一个全新的 --out 重做 --full`);
  if (insp.foreign) return fail(2, insp.broken);
  if (insp.errors.length) return fail(2, `上次备份的 MANIFEST.sha256 有非法行：${insp.errors.slice(0, 3).join('；')}`);
  const prevMeta = insp.meta;
  const prevEntries = insp.entries;
  const isFirst = !insp.exists || insp.empty || !prevMeta;
  const wantFull = opts.full === true || isFirst;
  report.mode = wantFull ? 'full' : 'incremental';
  // --since 只对"有上次备份的增量"有意义：全量本来就是全部文件，给出 --since 视为误用并如实告警（忽略）。
  const requestedSince = opts.since || '';
  if (requestedSince && wantFull) {
    report.warnings.push('--full（或首次备份）与 --since 同时给出：全量模式忽略 --since（全量 = 全部文件）');
  }
  report.since = requestedSince && !wantFull ? requestedSince : null;

  // 源必须是同一个账库（跨库增量比较会得出错误的"未变"，--full 做镜像还会删别人的副本）
  if (!isFirst && prevMeta && prevMeta.source && typeof prevMeta.source.root === 'string') {
    const prevRoot = path.resolve(prevMeta.source.root);
    const same = process.platform === 'win32'
      ? prevRoot.toLowerCase() === root.toLowerCase()
      : prevRoot === root;
    if (!same) {
      return fail(2, `--out 属于另一个账库的备份（记录源=${prevRoot}，本次 --root=${root}）；拒绝跨库增量/镜像，请换 --out 或全新目录`);
    }
  }
  if (!isFirst && prevMeta && prevMeta.mode && prevMeta.mode !== 'full' && prevMeta.mode !== 'incremental') {
    return fail(2, `上次备份 mode 非法：${JSON.stringify(prevMeta.mode)}`);
  }

  // ── 源信息 ───────────────────────────────────────────────────────────────
  try {
    const marker = readRootMarker(root);
    report.source.markerFound = marker.found === true;
    report.source.rootId = marker.marker && marker.marker.rootId ? String(marker.marker.rootId) : '';
  } catch { /* 标记读不出不影响备份；报告如实 markerFound:false */ }

  // ── 扫源 ─────────────────────────────────────────────────────────────────
  let walk;
  try {
    walk = walkSource(root, { includeIndex: report.policy.includeIndex, includeMetrics: report.policy.includeMetrics });
  } catch (e) {
    return fail(2, `扫描源账库失败：${errMsg(e)}`);
  }
  if (walk.errors.length) {
    report.warnings.push(`源账库有 ${walk.errors.length} 个路径读不出（备份会少这些文件，不假绿）`);
  }
  report.policy.skipped = aggregateSkipped(walk.skipped).rules;
  report.scanned = { files: walk.files.length, bytes: walk.files.reduce((n, f) => n + f.size, 0) };

  // ── 逐文件判定 ───────────────────────────────────────────────────────────
  const entries = wantFull ? new Map() : new Map(prevEntries);
  // 上次清单里每项的副本是否存在（一次性 stat 缓存；只在需要时用）
  const copyExists = (rel) => isFile(backupCopyPath(outDir, rel));

  for (const f of walk.files) {
    const { kind, code } = classifyRel(f.rel);
    const key = manifestKeyOf(f.rel);
    const item = () => ({ rel: f.rel, code, kind, bytes: f.size });
    // --since：只把 mtime ≥ since 的纳入候选；旧文件必须"上次已备份"，否则告警（不静默丢）
    if (!wantFull && sinceMs !== null && f.mtimeMs < sinceMs) {
      if (!entries.has(key)) {
        report.sinceUncovered.push({ ...item(), mtime: localDateOf(f.mtimeMs) });
      }
      continue;
    }
    report.candidates.files += 1;
    report.candidates.bytes += f.size;

    const prevSha = prevEntries.get(key);
    const dstAbs = backupCopyPath(outDir, f.rel);
    let action = '';
    if (wantFull) {
      action = prevSha ? 'copied' : 'added';
    } else if (!prevSha) {
      action = 'added';
    } else if (!copyExists(f.rel)) {
      action = 'repaired';
    } else {
      // 先比 size（便宜），同 size 才读源算 sha256（内容身份）
      let prevCopySize = -1;
      try { prevCopySize = fs.statSync(dstAbs).size; } catch { prevCopySize = -1; }
      if (prevCopySize === f.size) {
        let sha;
        try { sha = sha256File(f.abs); } catch (e) {
          report.errors.push(`读源失败：${f.rel}：${errMsg(e)}`);
          continue;
        }
        if (sha === prevSha) {
          report.unchangedFiles += 1;
          entries.set(key, prevSha); // 保持
          continue;
        }
        action = 'changed';
      } else {
        action = 'changed';
      }
    }

    if (wantFull) {
      // 全量：内容变了也算 copied；报告用 changed 标记（对账时能看出"不是全新文件"）
      let sha = '';
      try {
        if (prevSha) {
          // 全量也判一下是否变化，只影响报告分类，不影响拷贝
          const st = fs.statSync(backupCopyPath(outDir, f.rel));
          sha = st.size === f.size ? sha256File(f.abs) : '';
          if (sha && sha !== prevSha) action = 'changed';
        }
      } catch { /* 副本不在/读失败：按 added 处理 */ }
    }

    let out;
    try {
      out = copyFileHashed(f.abs, dstAbs);
    } catch (e) {
      report.errors.push(`拷贝失败：${f.rel}：${errMsg(e)}`);
      continue;
    }
    entries.set(key, out.sha256);
    report.copied.files += 1;
    report.copied.bytes += out.bytes;
    addKindStat(report.copied.byKind, kind, out.bytes);
    if (action === 'changed') report.changed.push({ ...item(), reason: 'sha256 不同' });
    else if (action === 'added') report.added.push(item());
    else if (action === 'repaired') report.repaired.push({ ...item(), reason: '上次备份副本丢失，自愈重拷' });
  }

  // ── 清理/保留（full 镜像 vs 增量追加）────────────────────────────────────
  if (wantFull) {
    for (const [key] of prevEntries) {
      if (entries.has(key)) continue;
      if (!key.startsWith(`${FILES_DIR}/`)) continue; // 只处理 files/ 下（backup.json 每次重写）
      const sourceRel = key.slice(FILES_DIR.length + 1);
      const abs = backupCopyPath(outDir, sourceRel);
      let bytes = 0;
      try { bytes = fs.statSync(abs).size; } catch { bytes = 0; }
      try { fs.unlinkSync(abs); report.pruned.files += 1; report.pruned.bytes += bytes; } catch { /* 已不在 */ }
    }
  } else {
    // 增量：保留上次清单（含源已删的旧副本 = 备份的意义），但副本真丢了的条目要告警并剔除
    for (const [key] of [...entries]) {
      if (!key.startsWith(`${FILES_DIR}/`)) { entries.delete(key); continue; }
      const sourceRel = key.slice(FILES_DIR.length + 1);
      if (!copyExists(sourceRel)) {
        entries.delete(key);
        report.warnings.push(`上次备份副本丢失，已从清单剔除（无法自愈：源也可能已删）：${sourceRel}`);
      }
    }
    // 源已不存在的旧副本：保留 + 告警（删文件是人的决定，不是备份器的）
    for (const [key] of entries) {
      if (!key.startsWith(`${FILES_DIR}/`)) continue;
      const sourceRel = key.slice(FILES_DIR.length + 1);
      if (!fs.existsSync(path.join(root, ...sourceRel.split('/')))) {
        const { kind, code } = classifyRel(sourceRel);
        report.sourceRemoved.push({ rel: sourceRel, code, kind });
      }
    }
  }

  // 超出样例上限的列表只留计数（JSON 里也说明截断，不假全量）
  const truncate = (arr) => ({ total: arr.length, sample: arr.slice(0, SAMPLE_MAX), truncated: arr.length > SAMPLE_MAX });

  // ── 统计 + 落盘 ──────────────────────────────────────────────────────────
  try {
    const counts = measureBackupFiles(outDir);
    report.counts = counts;
    // 空目录清理（full 删除旧副本后可能留下空月份目录）
    pruneEmptyDirs(path.join(outDir, FILES_DIR));

    const finishedMs = Date.now();
    const meta = {
      schema: SCHEMA,
      tool: 'tools/backup.mjs',
      toolVersion: TOOL_VERSION,
      createdAt: prevMeta && typeof prevMeta.createdAt === 'string' ? prevMeta.createdAt : stampNow(finishedMs),
      updatedAt: stampNow(finishedMs),
      mode: report.mode,
      since: report.since,
      source: {
        root,
        rootId: report.source.rootId,
        markerFound: report.source.markerFound,
      },
      policy: {
        indexIncluded: report.policy.includeIndex,
        metricsIncluded: report.policy.includeMetrics,
        skipped: report.policy.skipped,
        note: '默认不备份 ledger/.tick-metrics.jsonl（运行度量）与 .index//索引/（可重建）；其余文件全备份。',
      },
      previous: prevMeta ? { createdAt: prevMeta.createdAt || '', updatedAt: prevMeta.updatedAt || '', mode: prevMeta.mode || '' } : null,
      lastRun: {
        mode: report.mode,
        since: report.since,
        startedAt: report.startedAt,
        finishedAt: stampNow(finishedMs),
        elapsedMs: finishedMs - startedMs,
        scanned: report.scanned,
        candidates: report.candidates,
        copied: report.copied,
        unchangedFiles: report.unchangedFiles,
        added: truncate(report.added),
        changed: truncate(report.changed),
        repaired: truncate(report.repaired),
        pruned: report.pruned,
        sourceRemoved: truncate(report.sourceRemoved),
        sinceUncovered: truncate(report.sinceUncovered),
        skipped: aggregateSkipped(walk.skipped),
        warnings: report.warnings,
        errors: report.errors,
      },
      counts,
      manifest: { file: MANIFEST_NAME, entries: entries.size + (entries.has(META_NAME) ? 0 : 1), excludesSelf: true, note: '条目数含 backup.json（+1）；MANIFEST 不包含自身' },
    };
    writeFileAtomic(path.join(outDir, META_NAME), JSON.stringify(meta, null, 2) + '\n');
    entries.set(META_NAME, sha256File(path.join(outDir, META_NAME)));
    writeFileAtomic(path.join(outDir, MANIFEST_NAME), renderManifest(entries));
    report.manifest.entries = entries.size;
    report.finishedAt = stampNow(Date.now());
    report.elapsedMs = Date.now() - startedMs;
    report.ok = report.errors.length === 0;
    report.exitCode = report.errors.length === 0 ? 0 : 1;
    report.added = truncate(report.added);
    report.changed = truncate(report.changed);
    report.repaired = truncate(report.repaired);
    report.sourceRemoved = truncate(report.sourceRemoved);
    report.sinceUncovered = truncate(report.sinceUncovered);
    return { ok: report.ok, exitCode: report.exitCode, report };
  } catch (e) {
    return fail(1, `写备份目录失败（可能是权限/磁盘空间）：${errMsg(e)}`);
  }
}

/** 空分类统计。 */
function emptyKindStats() {
  const out = {};
  for (const k of KIND_ORDER) out[k] = { files: 0, bytes: 0 };
  return out;
}
function addKindStat(byKind, kind, bytes) {
  if (!byKind[kind]) byKind[kind] = { files: 0, bytes: 0 };
  byKind[kind].files += 1;
  byKind[kind].bytes += Number(bytes) || 0;
}

/**
 * 计量备份目录内 `files/**`（文件数/字节/分类）。
 * @param {string} outDir
 * @returns {{files:number, bytes:number, byKind:object}}
 */
export function measureBackupFiles(outDir) {
  const byKind = emptyKindStats();
  const base = path.join(outDir, FILES_DIR);
  let files = 0;
  let bytes = 0;
  const stack = [{ dir: base, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    for (const ent of safeReaddir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        stack.push({ dir: path.join(dir, ent.name), rel: childRel });
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try { st = fs.statSync(path.join(dir, ent.name)); } catch { continue; }
      files += 1;
      bytes += st.size;
      addKindStat(byKind, classifyRel(childRel).kind, st.size);
    }
  }
  return { files, bytes, byKind };
}

/** 删除空目录（`files/` 内；full 删除旧副本后清理空月份目录）。 */
function pruneEmptyDirs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of names) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    pruneEmptyDirs(path.join(dir, ent.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0 && path.resolve(dir) !== path.resolve(path.dirname(dir))) fs.rmdirSync(dir);
  } catch { /* ignore */ }
}

// ============================================================================
// 六、verify 备份校验
// ============================================================================

/**
 * 校验备份目录：MANIFEST 与磁盘逐文件比对（缺/多/改）。
 * @param {{outDir:string}} opts
 * @returns {{ok:boolean, exitCode:number, report:object}}
 */
export function runVerify(opts = {}) {
  const startedMs = Date.now();
  const outDir = path.resolve(String(opts.outDir || ''));
  const report = {
    schema: SCHEMA,
    toolVersion: TOOL_VERSION,
    command: 'verify',
    ok: false,
    exitCode: 2,
    out: outDir,
    generatedAt: stampNow(startedMs),
    elapsedMs: 0,
    manifest: { file: MANIFEST_NAME, entries: 0 },
    actual: { files: 0, bytes: 0 },
    counts: { missing: 0, extra: 0, changed: 0 },
    missing: [],
    extra: [],
    changed: [],
    metadata: null,
    notes: [],
    errors: [],
  };
  const finish = (exitCode) => {
    report.exitCode = exitCode;
    report.ok = exitCode === 0;
    report.elapsedMs = Date.now() - startedMs;
    return { ok: report.ok, exitCode, report };
  };
  if (!opts.outDir) { report.errors.push('必须给 --out=<备份目录>'); return finish(2); }
  const insp = inspectBackupDir(outDir);
  if (!insp.exists) { report.errors.push(`--out 不存在：${outDir}`); return finish(2); }
  if (insp.empty) { report.errors.push(`--out 是空目录（没有备份可验）：${outDir}`); return finish(2); }
  if (insp.foreign || insp.broken) { report.errors.push(insp.broken || '--out 不是本工具的备份'); return finish(2); }
  if (insp.errors.length) {
    report.errors.push(...insp.errors.slice(0, 10));
    return finish(1);
  }
  report.manifest.entries = insp.entries.size;
  report.metadata = {
    schema: insp.meta.schema,
    mode: insp.meta.mode || '',
    createdAt: insp.meta.createdAt || '',
    updatedAt: insp.meta.updatedAt || '',
    sourceRoot: (insp.meta.source && insp.meta.source.root) || '',
    rootId: (insp.meta.source && insp.meta.source.rootId) || '',
    counts: insp.meta.counts || null,
    manifest: insp.meta.manifest || null,
  };

  // 实际扫描：备份目录内除 MANIFEST.sha256 自身以外的所有普通文件
  const actual = new Map(); // rel → abs
  const stack = [{ dir: outDir, rel: '' }];
  let walkErrors = 0;
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { walkErrors += 1; continue; }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of ents) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (childRel === MANIFEST_NAME) continue; // 排除自身
      let isSymlink = false;
      try { isSymlink = ent.isSymbolicLink(); } catch { isSymlink = false; }
      if (isSymlink) { walkErrors += 1; continue; }
      if (ent.isDirectory()) { stack.push({ dir: path.join(dir, ent.name), rel: childRel }); continue; }
      if (!ent.isFile()) continue;
      actual.set(childRel, path.join(dir, ent.name));
      if (actual.size > MAX_SCAN_FILES) {
        report.errors.push(`备份内文件数超过上限 ${MAX_SCAN_FILES}（内存纪律）`);
        return finish(2);
      }
    }
  }
  if (walkErrors) report.notes.push(`备份内有 ${walkErrors} 个条目读不出/符号链接被忽略（不假绿：verify 只认读得到的普通文件）`);

  // 逐项比：缺 / 改（都以 MANIFEST 为事实源）
  for (const [rel, wantSha] of insp.entries) {
    const abs = actual.get(rel);
    if (!abs) { report.missing.push({ rel }); continue; }
    let gotSha;
    try { gotSha = sha256File(abs); } catch (e) {
      report.errors.push(`读备份文件失败：${rel}：${errMsg(e)}`);
      continue;
    }
    if (gotSha !== wantSha) report.changed.push({ rel, wantSha, gotSha });
  }
  // 多：盘上有、清单没有（含上次中断留下的临时文件）
  for (const [rel, abs] of actual) {
    if (insp.entries.has(rel)) continue;
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch { /* ignore */ }
    report.extra.push({ rel, bytes, hint: /\.tmp-[^/]+$/.test(rel) ? '疑似中断留下的临时文件' : '' });
  }
  // 实际文件数/字节（报告用；"多"的文件也算进 actual）
  let actualBytes = 0;
  for (const [, abs] of actual) {
    try { actualBytes += fs.statSync(abs).size; } catch { /* ignore */ }
  }
  report.actual = { files: actual.size, bytes: actualBytes };

  // 元数据自洽（backup.json 已被清单覆盖；这里只核对 counts 声明，不一致只作 note，不改判据）
  if (insp.meta && insp.meta.counts && Number.isFinite(Number(insp.meta.counts.files))) {
    const declared = Number(insp.meta.counts.files);
    const fileEntries = [...insp.entries.keys()].filter((k) => k.startsWith(`${FILES_DIR}/`)).length;
    if (declared !== fileEntries) {
      report.notes.push(`backup.json 声明 files=${declared}，MANIFEST 实有 ${fileEntries} 条 files/ 条目（元数据不自洽）`);
    }
  }
  if (insp.meta && insp.meta.manifest && Number.isFinite(Number(insp.meta.manifest.entries)) && Number(insp.meta.manifest.entries) !== insp.entries.size) {
    report.notes.push(`backup.json 声明 manifest.entries=${insp.meta.manifest.entries}，实际 ${insp.entries.size}`);
  }
  report.counts = { missing: report.missing.length, extra: report.extra.length, changed: report.changed.length };

  const bad = report.missing.length + report.extra.length + report.changed.length + report.errors.length;
  return finish(bad === 0 ? 0 : 1);
}

// ============================================================================
// 七、restore 恢复（默认 dry-run；绝不覆盖账库）
// ============================================================================

/** 目标是否"看起来已经是账库"（绝不覆盖的判定；--force 也不解除）。 */
export function looksLikeLedger(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { return false; }
  if (!st.isDirectory()) return false;
  const names = safeReaddir(dir);
  if (names.includes('.ledger-root')) return true;
  if (names.includes('账簿总目录.md')) return true;
  if (names.includes('ledger')) {
    try { if (fs.statSync(path.join(dir, 'ledger')).isDirectory()) return true; } catch { /* ignore */ }
  }
  for (const n of names) {
    if (/^\d{4}年\d{2}月$/.test(n)) {
      try { if (fs.statSync(path.join(dir, n)).isDirectory()) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

/** 目标目录内已有的普通文件（用于"非空"判定；隐藏文件也算）。 */
function targetEntries(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names;
}

/**
 * 检查目标路径的**上级**是否被同名文件占住（如 `<to>\2026年10月` 已存在且不是目录）。
 * @returns {string} 冲突的上级路径；无冲突返回 ''
 * @why 真写时 `mkdir -p` 会在这种目标上抛 ENOTDIR —— 必须在**出计划阶段**就拒绝，
 *      否则"零写入拒绝"会变成"写一半才失败"。
 */
function ancestorConflict(toDir, segs) {
  let cur = toDir;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    if (!fs.existsSync(cur)) return '';
    try {
      if (!fs.statSync(cur).isDirectory()) return cur;
    } catch {
      return cur;
    }
  }
  return '';
}

/**
 * 恢复备份到目标目录（默认 dry-run，零写入）。
 * @param {{outDir:string, toDir:string, dryRun?:boolean, force?:boolean, write?:boolean, nowMs?:number}} opts
 * @returns {{ok:boolean, exitCode:number, report:object}}
 */
export function runRestore(opts = {}) {
  const startedMs = Date.now();
  const outDir = path.resolve(String(opts.outDir || ''));
  const toDir = path.resolve(String(opts.toDir || ''));
  const write = opts.write === true; // ★ 唯一触发真实写入的开关；默认 dry-run
  const report = {
    schema: SCHEMA,
    toolVersion: TOOL_VERSION,
    command: 'restore',
    ok: false,
    exitCode: 2,
    out: outDir,
    to: toDir,
    dryRun: !write,
    write,
    force: opts.force === true,
    generatedAt: stampNow(startedMs),
    elapsedMs: 0,
    source: { root: '', rootId: '', backup: null },
    verify: null,
    plan: { files: 0, bytes: 0, skipIdentical: 0, conflicts: 0 },
    conflicts: [],
    wrote: { files: 0, bytes: 0 },
    readBack: null,
    warnings: [],
    errors: [],
    notes: [],
  };
  const finish = (exitCode) => {
    report.exitCode = exitCode;
    report.ok = exitCode === 0;
    report.elapsedMs = Date.now() - startedMs;
    return { ok: report.ok, exitCode, report };
  };
  if (!opts.outDir) { report.errors.push('必须给 --out=<备份目录>'); return finish(2); }
  if (!opts.toDir) { report.errors.push('必须给 --to=<目标目录>'); return finish(2); }

  // ── 0) 路径自反（out/to 互不包含，且 to 不是备份源）──────────────────────
  if (isInsideOrEqual(outDir, toDir)) {
    // to 在 out 内（含相等）：写入会把备份自己搞脏
    report.errors.push(`--to 不能等于/位于 --out 之内：out=${outDir} to=${toDir}`);
    return finish(2);
  }
  if (isInsideOrEqual(toDir, outDir)) {
    report.errors.push(`--out 不能等于/位于 --to 之内：out=${outDir} to=${toDir}`);
    return finish(2);
  }

  // 元信息先读（即使后面校验失败，报告也能写出"备份源是什么"，便于人判断怎么处置）
  const pre = inspectBackupDir(outDir);
  if (pre.meta && pre.meta.source) {
    report.source = {
      root: pre.meta.source.root || '',
      rootId: pre.meta.source.rootId || '',
      backup: {
        mode: pre.meta.mode || '',
        createdAt: pre.meta.createdAt || '',
        updatedAt: pre.meta.updatedAt || '',
      },
    };
  }

  // ── 1) 先完整 verify（备份不可信时绝不恢复）──────────────────────────────
  const v = runVerify({ outDir });
  report.verify = {
    ok: v.ok,
    exitCode: v.exitCode,
    manifestEntries: v.report.manifest.entries,
    counts: v.report.counts,
    errors: v.report.errors,
  };
  if (v.exitCode !== 0) {
    report.errors.push(`备份校验不通过（缺/多/改 ${v.report.counts.missing + v.report.counts.extra + v.report.counts.changed} 项），拒绝恢复；先跑 verify 处理`);
    return finish(v.exitCode === 2 ? 2 : 1);
  }
  const insp = pre;
  if (!insp.meta) { report.errors.push('backup.json 读不出'); return finish(2); }
  report.source = {
    root: (insp.meta.source && insp.meta.source.root) || '',
    rootId: (insp.meta.source && insp.meta.source.rootId) || '',
    backup: {
      mode: insp.meta.mode || '',
      createdAt: insp.meta.createdAt || '',
      updatedAt: insp.meta.updatedAt || '',
    },
  };
  const sourceRoot = report.source.root ? path.resolve(report.source.root) : '';
  if (sourceRoot && (process.platform === 'win32' ? sourceRoot.toLowerCase() === toDir.toLowerCase() : sourceRoot === toDir)) {
    report.errors.push(`--to 就是备份的源账库（${toDir}）：绝不覆盖已有账库`);
    return finish(2);
  }

  // ── 2) 目标安全门（dry-run 也做；拒绝 = exit 2 且零写入）──────────────────
  let toStat = null;
  try { toStat = fs.statSync(toDir); } catch { toStat = null; }
  if (toStat && !toStat.isDirectory()) {
    report.errors.push(`--to 存在但不是目录：${toDir}`);
    return finish(2);
  }
  const toExists = !!toStat;
  if (toExists && looksLikeLedger(toDir)) {
    report.errors.push(`--to 看起来已是账库（.ledger-root / ledger/ / 账簿总目录.md / 月份目录）：绝不覆盖已有账库，--force 也不解除`);
    return finish(2);
  }
  const existing = toExists ? targetEntries(toDir) : [];
  if (toExists && existing.length > 0 && opts.force !== true) {
    report.errors.push(`--to 非空（${existing.length} 个条目）：真恢复会混入旧文件；确认无冲突请加 --force（仍绝不覆盖已有账库）`);
    return finish(2);
  }
  if (toExists && existing.length > 0) {
    report.warnings.push(`--to 非空（${existing.length} 个条目）且已给 --force：只写不存在项，任何同名不同内容一律拒绝`);
  }

  // ── 3) 出恢复计划（只读；dry-run 的全部输出）──────────────────────────────
  const plan = [];
  for (const [rel, sha] of [...insp.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!rel.startsWith(`${FILES_DIR}/`)) continue; // 备份元数据不恢复
    const sourceRel = rel.slice(FILES_DIR.length + 1);
    const segs = sourceRel.split('/');
    const dstAbs = path.join(toDir, ...segs);
    if (!isInsideOrEqual(toDir, dstAbs)) {
      report.errors.push(`MANIFEST 条目越界（拒绝恢复）：${rel}`);
      return finish(2);
    }
    // 上级路径被同名文件占住（如目标已有 `2026年10月` 是文件）→ 冲突，零写入拒绝
    const anc = ancestorConflict(toDir, segs);
    if (anc) { report.conflicts.push({ rel, why: `目标上级 ${anc} 已存在但不是目录` }); continue; }
    const srcAbs = path.join(outDir, ...rel.split('/'));
    let dstSha = null;
    if (isFile(dstAbs)) {
      try { dstSha = sha256File(dstAbs); } catch { dstSha = 'unreadable'; }
    } else if (fs.existsSync(dstAbs)) {
      report.conflicts.push({ rel, why: '目标同名条目存在但不是普通文件' });
      continue;
    }
    if (dstSha === sha) { report.plan.skipIdentical += 1; continue; }
    if (dstSha !== null) {
      report.conflicts.push({ rel, why: '目标已存在且内容不同（绝不覆盖）', wantSha: sha, gotSha: dstSha });
      continue;
    }
    plan.push({ rel, sourceRel, srcAbs, dstAbs, sha });
    report.plan.files += 1;
    try { report.plan.bytes += fs.statSync(srcAbs).size; } catch { /* ignore */ }
  }
  report.plan.sample = plan.slice(0, 10).map(({ rel, sourceRel, sha }) => ({ rel, sourceRel, sha }));
  report.plan.conflicts = report.conflicts.length;
  if (report.conflicts.length) {
    report.errors.push(`发现 ${report.conflicts.length} 个目标冲突（已存在且内容不同 / 上级同名非目录）：绝不覆盖，拒绝恢复（零写入）`);
    return finish(2);
  }

  // ── 4) dry-run：出计划即退出 0（零写入）───────────────────────────────────
  if (!write) {
    report.notes.push('dry-run：只出计划，零写入。确认后加 --write 才真恢复（--force 只解除"目标非空"，不触发写）。');
    return finish(0);
  }

  // ── 5) 真恢复：逐个写（先确认目标不存在；tmp+fsync+rename，绝不覆盖）─────
  fs.mkdirSync(toDir, { recursive: true });
  const failed = [];
  for (const item of plan) {
    try {
      fs.mkdirSync(path.dirname(item.dstAbs), { recursive: true });
      const out = copyFileHashed(item.srcAbs, item.dstAbs, { overwrite: false });
      if (out.sha256 !== item.sha) throw new Error(`写后 sha256 不符（want=${item.sha} got=${out.sha256}）`);
      report.wrote.files += 1;
      report.wrote.bytes += out.bytes;
    } catch (e) {
      failed.push({ rel: item.rel, message: errMsg(e) });
      try { fs.unlinkSync(item.dstAbs); } catch { /* 半截文件清掉 */ }
    }
  }
  if (failed.length) {
    report.errors.push(`恢复失败 ${failed.length} 项（其余已写；目标不完整，不要当账库用）：${failed.slice(0, 3).map((x) => x.rel).join('；')}`);
    return finish(1);
  }

  // ── 6) 恢复后"一条命令验读"：readAll 只读复核（C37：整库搬走 + 验读）──────
  try {
    const all = readAll(toDir, { repairTornTail: false });
    report.readBack = {
      ok: all.ok === true,
      rows: Array.isArray(all.records) ? all.records.length : 0,
      files: Number(all.files) || 0,
      badLines: Number(all.badLines) || 0,
      readErrors: Array.isArray(all.readErrors) ? all.readErrors.length : 0,
      emptyProven: all.emptyProven === true,
    };
    if (!report.readBack.ok) {
      report.errors.push(`恢复后的账库 readAll 不通过（ok=false，坏行 ${report.readBack.badLines}）`);
      return finish(1);
    }
  } catch (e) {
    report.errors.push(`恢复后 readAll 抛错：${errMsg(e)}`);
    return finish(1);
  }
  return finish(0);
}

// ============================================================================
// 八、人读文本
// ============================================================================

function kindLine(label, stats, indent = '  ') {
  const parts = KIND_ORDER
    .map((k) => [k, stats[k] || { files: 0, bytes: 0 }])
    .filter(([, s]) => s.files > 0)
    .map(([k, s]) => `${k} ${s.files} 个/${fmtBytes(s.bytes)}`);
  return `${indent}${label}：${parts.length ? parts.join(' · ') : '（无）'}`;
}

function listLine(arr, keyName = 'rel') {
  if (!arr || !arr.length) return '（无）';
  const sample = arr.slice(0, SAMPLE_MAX).map((x) => `${x[keyName]}${x.code ? `［${x.code}］` : ''}`);
  return sample.join('；') + (arr.length > SAMPLE_MAX ? ` …共 ${arr.length} 条（JSON 有完整计数）` : '');
}

function renderBackupText(r) {
  const L = [];
  L.push(`backup · root=${r.root}`);
  L.push(`  备份目录：${r.out}`);
  L.push(`  模式：${r.mode}${r.since ? `（--since=${r.since}）` : ''}${r.mode === 'full' ? '（全量 = 镜像）' : '（增量 = 只拷新增/变化/丢失副本）'}`);
  L.push(`  源：文件 ${r.scanned.files} 个 / ${fmtBytes(r.scanned.bytes)}${r.source.markerFound ? `（rootId=${r.source.rootId || '—'}）` : '（无 .ledger-root）'}`);
  if (r.policy.skipped.length) {
    for (const s of r.policy.skipped) L.push(`  跳过[${s.rule}]：${s.files} 个 / ${fmtBytes(s.bytes)} — ${s.why}`);
  }
  L.push(`  候选：${r.candidates.files} 个 / ${fmtBytes(r.candidates.bytes)}${r.mode === 'incremental' ? `（其中未变 ${r.unchangedFiles} 个，不拷）` : '（全量 = 全部文件都拷）'}`);
  L.push(`  本次拷贝：${r.copied.files} 个 / ${fmtBytes(r.copied.bytes)}（新增 ${(r.added && r.added.total) || 0} / 变化 ${(r.changed && r.changed.total) || 0} / 自愈 ${(r.repaired && r.repaired.total) || 0}）`);
  L.push(kindLine('拷贝分类', r.copied.byKind));
  if (r.mode === 'full') L.push(`  镜像清理：删除上次清单里源已没有的旧副本 ${r.pruned.files} 个 / ${fmtBytes(r.pruned.bytes)}`);
  if (r.sourceRemoved && r.sourceRemoved.total) L.push(`  源已删除（增量保留旧副本）：${listLine(r.sourceRemoved.sample)}${r.sourceRemoved.truncated ? ` …共 ${r.sourceRemoved.total} 条` : ''}`);
  if (r.sinceUncovered && r.sinceUncovered.total) L.push(`  ⚠ --since 未覆盖（比 since 旧且上次没备份）：${listLine(r.sinceUncovered.sample)}${r.sinceUncovered.truncated ? ` …共 ${r.sinceUncovered.total} 条` : ''}`);
  L.push(`  备份内容：${r.counts.files} 个 / ${fmtBytes(r.counts.bytes)}`);
  L.push(kindLine('内容分类', r.counts.byKind));
  L.push(`  MANIFEST：${r.manifest.entries} 条（排除自身，含 backup.json）→ ${path.join(r.out, MANIFEST_NAME)}`);
  if (r.warnings.length) for (const w of r.warnings) L.push(`  ⚠ ${w}`);
  if (r.errors.length) for (const e of r.errors) L.push(`  ✗ ${e}`);
  L.push(`  结论：${r.ok ? 'OK（exit 0）' : `失败（exit ${r.exitCode}）`}`);
  return L.join('\n');
}

function renderVerifyText(r) {
  const L = [];
  L.push(`verify · out=${r.out}`);
  if (r.metadata) {
    L.push(`  备份：mode=${r.metadata.mode || '?'} 创建=${r.metadata.createdAt || '?'} 更新=${r.metadata.updatedAt || '?'}`);
    L.push(`  源：${r.metadata.sourceRoot || '?'}${r.metadata.rootId ? `（rootId=${r.metadata.rootId}）` : ''}`);
  }
  L.push(`  清单：${r.manifest.entries} 条；盘上：${r.actual.files} 个 / ${fmtBytes(r.actual.bytes)}`);
  L.push(`  缺 ${r.counts.missing} / 多 ${r.counts.extra} / 改 ${r.counts.changed}`);
  if (r.missing.length) L.push(`  缺：${listLine(r.missing)}`);
  if (r.extra.length) L.push(`  多：${r.extra.slice(0, SAMPLE_MAX).map((x) => `${x.rel}${x.hint ? `（${x.hint}）` : ''}`).join('；')}${r.extra.length > SAMPLE_MAX ? ` …共 ${r.extra.length} 条` : ''}`);
  if (r.changed.length) L.push(`  改：${r.changed.slice(0, SAMPLE_MAX).map((x) => x.rel).join('；')}${r.changed.length > SAMPLE_MAX ? ` …共 ${r.changed.length} 条` : ''}`);
  for (const n of r.notes) L.push(`  注：${n}`);
  for (const e of r.errors) L.push(`  ✗ ${e}`);
  L.push(`  结论：${r.ok ? 'PASS（exit 0）' : `FAIL（exit ${r.exitCode}）`}`);
  return L.join('\n');
}

function renderRestoreText(r) {
  const L = [];
  L.push(`restore · out=${r.out}`);
  L.push(`  备份源：${r.source.root || '（未知）'}${r.source.rootId ? `（rootId=${r.source.rootId}）` : ''}`);
  L.push(`  目标：${r.to}`);
  L.push(`  校验：${r.verify && r.verify.ok ? 'PASS' : `FAIL（exit ${r.verify && r.verify.exitCode}）`}；计划写 ${r.plan.files} 个 / ${fmtBytes(r.plan.bytes)}；已存在且相同跳过 ${r.plan.skipIdentical}；冲突 ${r.plan.conflicts}`);
  if (r.plan.files) {
    const sample = (r.plan.sample || []).map((x) => x.sourceRel || x.rel);
    L.push(`  计划样例：${sample.length ? sample.join('；') : '（见 JSON）'}`);
  }
  if (r.conflicts.length) for (const c of r.conflicts.slice(0, SAMPLE_MAX)) L.push(`  ✗ 冲突：${c.rel} — ${c.why}`);
  L.push(`  模式：${r.dryRun ? 'dry-run（零写入；加 --write 才真恢复）' : '真恢复'}`);
  if (!r.dryRun) L.push(`  已写：${r.wrote.files} 个 / ${fmtBytes(r.wrote.bytes)}`);
  if (r.readBack) L.push(`  恢复后验读（readAll）：ok=${r.readBack.ok} 行=${r.readBack.rows} 文件=${r.readBack.files} 坏行=${r.readBack.badLines}`);
  for (const n of r.notes) L.push(`  注：${n}`);
  for (const w of r.warnings) L.push(`  ⚠ ${w}`);
  for (const e of r.errors) L.push(`  ✗ ${e}`);
  L.push(`  结论：${r.ok ? 'OK（exit 0）' : `失败（exit ${r.exitCode}）`}`);
  return L.join('\n');
}

/** 按命令渲染人读文本。 */
export function renderText(report) {
  if (report.command === 'verify') return renderVerifyText(report);
  if (report.command === 'restore') return renderRestoreText(report);
  return renderBackupText(report);
}

// ============================================================================
// 九、CLI
// ============================================================================

/** 参数解析（未知参数/缺必填 → error，调用方 exit 2）。 */
export function parseArgs(argv) {
  const opts = {
    command: '', root: '', outDir: '', toDir: '', since: '', full: false, json: false,
    includeIndex: false, includeMetrics: false, dryRun: false, force: false, write: false, help: false,
  };
  const rest = [];
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--include-index') opts.includeIndex = true;
    else if (a === '--include-metrics') opts.includeMetrics = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--write') opts.write = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else if (a.startsWith('--out=')) opts.outDir = a.slice('--out='.length);
    else if (a.startsWith('--to=')) opts.toDir = a.slice('--to='.length);
    else if (a.startsWith('--since=')) opts.since = a.slice('--since='.length);
    else if (a.startsWith('-')) return { error: `未知参数：${a}` };
    else rest.push(a);
  }
  if (opts.help) return { opts };
  if (rest.length !== 1) {
    return { error: `必须且只能给一个子命令（backup / verify / restore），收到：${rest.length ? rest.join(' ') : '（无）'}` };
  }
  opts.command = rest[0];
  if (!['backup', 'verify', 'restore'].includes(opts.command)) {
    return { error: `未知子命令：${opts.command}（只支持 backup / verify / restore）` };
  }
  if (opts.command === 'backup') {
    if (!opts.root) return { error: 'backup 必须给 --root=<账库根>' };
    if (!opts.outDir) return { error: 'backup 必须给 --out=<备份目录>' };
    if (opts.toDir) return { error: 'backup 不接受 --to' };
    if (opts.dryRun || opts.force || opts.write) return { error: 'backup 不接受 --dry-run/--force/--write' };
  } else if (opts.command === 'verify') {
    if (!opts.outDir) return { error: 'verify 必须给 --out=<备份目录>' };
    if (opts.root || opts.toDir) return { error: 'verify 不接受 --root/--to' };
    if (opts.full || opts.includeIndex || opts.includeMetrics || opts.since || opts.dryRun || opts.force || opts.write) {
      return { error: 'verify 只接受 --out / --json' };
    }
  } else {
    if (!opts.outDir) return { error: 'restore 必须给 --out=<备份目录>' };
    if (!opts.toDir) return { error: 'restore 必须给 --to=<目标目录>' };
    if (opts.root) return { error: 'restore 不接受 --root（源在 backup.json 里）' };
    if (opts.full || opts.includeIndex || opts.includeMetrics || opts.since) {
      return { error: 'restore 只接受 --out / --to / --dry-run / --force / --write / --json' };
    }
    if (opts.write && opts.dryRun) return { error: '--write 与 --dry-run 互斥（--write = 真恢复）' };
  }
  return { opts };
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`backup: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let result;
  try {
    if (opts.command === 'backup') {
      result = runBackup({
        root: opts.root, outDir: opts.outDir, since: opts.since || '', full: opts.full,
        includeIndex: opts.includeIndex, includeMetrics: opts.includeMetrics, nowMs: Date.now(),
      });
    } else if (opts.command === 'verify') {
      result = runVerify({ outDir: opts.outDir });
    } else {
      result = runRestore({
        outDir: opts.outDir, toDir: opts.toDir, dryRun: opts.dryRun,
        force: opts.force, write: opts.write, nowMs: Date.now(),
      });
    }
  } catch (e) {
    console.error(`backup: 未捕获异常（不吞）：${(e && e.stack) || e}`);
    return 2;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(result.report) + '\n');
  }
  return result.exitCode;
}

// 直接 `node tools/backup.mjs` 跑才执行；被 import（单测/外部复用）时只导出函数。
const isMain = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    return path.resolve(arg1) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    console.error('backup: 未捕获异常：' + ((e && e.stack) || e));
    process.exitCode = 2;
  });
}
