/**
 * @file readlog.js
 * @role **读行为审计日志**（V0.6 外层 / V0.6.4 滚动）：把"谁在什么时候查了哪几行账"落成可复核的事实。
 *
 * @why 机主的"重审计"要求：出问题时必须能分清两件事——
 *      **没查**（Agent 不知道有账本 / 没意识到要查）与 **查了读错**（查到了但用歪了）。
 *      只有把"读"这个动作本身落盘，才分得清。这也是从"账可查"迈向"引用可追"的第一步。
 *
 * @file 位置（V0.6.4 起，③ 读日志滚动）：
 *      · 新写入：`<root>/ledger/.reads/YYYY-MM.jsonl`（按 +08:00 月份分文件）；
 *        单文件追加会超过阈值（默认 8 MiB）时切下一个分片 `YYYY-MM.02.jsonl`、`.03`…，
 *        **旧分片一律只读：不重命名、不改写、不删除**（历史审计证据不可回改）；
 *      · 历史单文件：`<root>/ledger/.reads.jsonl`（V0.6.0–V0.6.3）**保留原样、只读不写**，
 *        读侧与"老库不迁移也能读"同一口径。
 *
 * @why 为什么按月 + 按大小双层切：
 *      按月分文件让"某个月的读审计"可以单独保留/归档；按大小切分片防止单文件无限增长
 *      （05 审计 A6：高频只读查询会把一个 jsonl 撑到无法审计/无法传输）。
 *      只新建、不搬动旧文件，是为了让"审计证据"的字节集合永远只增不改。
 *
 * @why 只读语义不变：本模块只写"读日志"，不碰台账、不碰原文、不碰封板链。
 *      日志属于运行区（丢了只影响审计，不影响账）。已验证 `readAll` 的文件过滤是
 *      `endsWith('.jsonl') && !startsWith('.')`，且不去 `.reads/` 子目录读——所以本模块
 *      的文件**不会被当成台账读取**（有自测钉住这一点）。
 *
 * @depends node:fs、node:path
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ARGS_CHARS = 240;
const MAX_CODES = 50;
const MAX_DETAIL = 400;
const OFFSET_MINUTES = 480; // 全系统 +08:00 口径（与台账/产物一致）

/**
 * 单分片阈值：默认 8 MiB。
 * @why 下一行会让当前分片**超过**阈值时先切新分片（单行本身超阈值时该行独占一个分片，
 *      因为 jsonl 的一行不可拆分）；因此正常情况单个分片 ≤ 阈值。
 */
export const READ_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 读日志**总量配额**（V1.0 / 准入审计 P1-07；V1.0.0-re3 按审计② P3 修正口径）：
 * **历史单文件 `.reads.jsonl` + `.reads/` 下所有分片**的字节合计上限。
 *
 * @why 审计指出"读日志无总量上限 + 每 GET 一次 fsync + /reads 整读两遍"是可被重复请求放大的
 *      DoS 面。分片只解决**单文件**无限增长，不解决**目录**无限增长；这里加一道总量闸：
 *      超配额时**从最旧的整分片开始整文件删除**，永远保留最新一个分片（当前写入分片）。
 * @why **旧 → 新（V1.0.0-re3 / 审计② P3）**：旧口径只把 `.reads/` 分片计入总量，
 *      历史单文件 `.reads.jsonl` 不计 —— 老库升级后若该文件很大，总占用会突破配额却永远不裁。
 *      新口径把历史单文件字节**计入总量**（但**永不删除**它：用户旧审计证据不动）。
 *      代价：历史文件越大，分片越早被裁；历史文件本身超过配额时只剩最新分片（仍可能瞬时超一格）。
 * @why 这是对旧承诺（"旧分片一律只读、不删除"）的**有据修订**：配额优先于"永不删"，
 *      否则读日志会无界增长；默认 64 MiB ≈ 20 万次查询，正常单人使用不会触发。
 */
export const READ_LOG_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * root 是否"安全可写"：非空、绝对路径、且**不是盘符根/UNC 根**。
 *
 * @why 本模块会 `mkdirSync`（见 appendRead）。若把 `C:\`、`\\server\share` 或相对路径当
 *      数据总库传进来，一次"查不存在的库"就会在错误的位置建出 `ledger/.reads`。
 *      这里统一提供**唯一一份**判定（toolface / panelapi 同一个真相），
 *      模块内 appendRead 也先自检一遍 —— 纵深防御，不靠调用方守规矩。
 * @param {unknown} root
 * @returns {boolean}
 */
export function isSafeRoot(root) {
  if (typeof root !== 'string') return false;
  const s = root.trim();
  if (!s) return false;
  try {
    if (!path.isAbsolute(s)) return false;
    if (path.parse(s).root === s) return false; // `C:\`、`\\server\share` 之类的根
  } catch {
    return false;
  }
  return true;
}

/** 历史单文件路径（V0.6.0–V0.6.3 的位置；**只读**，新写入不再落这里）。 */
export function readLogPath(root) {
  return path.join(root, 'ledger', '.reads.jsonl');
}

/** 读日志新目录：`<root>/ledger/.reads/`（V0.6.4 起所有新写入落这里）。 */
export function readLogDir(root) {
  return path.join(root, 'ledger', '.reads');
}

const pad2 = (n) => String(n).padStart(2, '0');

function stampLocal(ms) {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +08:00`;
}

/** 毫秒 → 本地（+08:00）月份 `YYYY-MM`。 */
function monthOfLocal(ms) {
  const d = new Date(ms + OFFSET_MINUTES * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * 分片文件名：`YYYY-MM.jsonl`（第 1 份）/ `YYYY-MM.NN.jsonl`（第 2 份起，NN 至少两位）。
 * @param {string} month `YYYY-MM`
 * @param {number} serial 1 起
 */
export function shardFileName(month, serial) {
  const n = Number.isInteger(serial) && serial > 1 ? serial : 1;
  return n === 1 ? `${month}.jsonl` : `${month}.${String(n).padStart(2, '0')}.jsonl`;
}

/** 分片文件名 → `{month, serial}`；不是本读日志分片返回 null。 */
function parseShardName(name) {
  const m = /^(\d{4})-(\d{2})(?:\.(\d{2,}))?\.jsonl$/.exec(String(name));
  if (!m) return null;
  const month = `${m[1]}-${m[2]}`;
  const serial = m[3] ? Number(m[3]) : 1;
  return { month, serial };
}

/**
 * 列出 `.reads/` 下所有分片（升序 = 写入顺序：月份 → 序号）。
 * @returns {Array<{month:string, serial:number, name:string, abs:string, size:number}>}
 */
function listShards(root) {
  const dir = readLogDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const parsed = parseShardName(name);
    if (!parsed) continue; // 不认识的条目（临时文件/手工文件）不猜、不读
    const abs = path.join(dir, name);
    let size = 0;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch { continue; }
    out.push({ month: parsed.month, serial: parsed.serial, name, abs, size });
  }
  out.sort((a, b) => (a.month === b.month ? a.serial - b.serial : (a.month < b.month ? -1 : 1)));
  return out;
}

/**
 * 选这次 append 的目标分片（**只读已有分片的大小，不重命名/不改写**）。
 * @param {string} root
 * @param {string} month `YYYY-MM`
 * @param {number} maxBytes 单分片阈值
 * @param {number} addBytes 本次要追加的字节数
 * @returns {{abs:string, serial:number, rotated:boolean}}
 */
function pickShard(root, month, maxBytes, addBytes) {
  const monthShards = listShards(root).filter((s) => s.month === month);
  const last = monthShards.length ? monthShards[monthShards.length - 1] : null;
  const serial = last ? last.serial : 1;
  // 空分片（异常残留）直接续写；否则"这次追加会超阈值"就先切新分片。
  const needRotate = !!last && last.size > 0 && (last.size >= maxBytes || last.size + addBytes > maxBytes);
  const targetSerial = needRotate ? serial + 1 : serial;
  return {
    abs: path.join(readLogDir(root), shardFileName(month, targetSerial)),
    serial: targetSerial,
    rotated: needRotate,
  };
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : (typeof s === 'string' ? s : ''));

/**
 * 历史单文件 `<root>/ledger/.reads.jsonl` 的字节数（不存在/读不到 = 0）。
 *
 * @why V1.0.0-re3 / 审计② P3：总量配额必须**把历史单文件也计入**——否则老库升级后
 *      这个文件可以任意大而配额只看分片，64 MiB 上限名存实亡。
 *      计入 ≠ 可删：历史单文件仍然**永不删除**（用户旧审计证据不动）。
 * @param {string} root
 * @returns {number}
 */
function legacyReadLogBytes(root) {
  try {
    const st = fs.statSync(readLogPath(root));
    return st.isFile() ? st.size : 0;
  } catch { return 0; }
}

/**
 * 总量配额执行（V1.0 / 审计 P1-07；V1.0.0-re3 审计② P3 修正：总量含历史单文件）。
 *
 * @why 只删 `.reads/` 下的分片整文件；**不删**历史单文件 `.reads.jsonl`、**不删**最新分片
 *      （正在写的那个，删了等于丢刚刚的审计行）。删整文件而不是截断文件，
 *      是为了让"留下的每个分片仍是完整可读的 jsonl"。
 * @why 总量 = 历史单文件字节 + 所有分片字节；超配额从**最旧分片**开始整文件删。
 *      历史单文件本身超配额时只能保留最新分片（无法更少），属已知软配额边界。
 * @param {string} root
 * @param {number} maxTotalBytes 0/非法 = 不限制
 * @returns {{removed:string[], totalBytes:number, kept:number}}
 */
function enforceRetention(root, maxTotalBytes) {
  const shards = listShards(root);
  const legacyBytes = legacyReadLogBytes(root);
  let totalBytes = legacyBytes + shards.reduce((a, s) => a + s.size, 0);
  const removed = [];
  if (!(Number.isFinite(maxTotalBytes) && maxTotalBytes > 0)) {
    return { removed, totalBytes, kept: shards.length };
  }
  for (let i = 0; i < shards.length - 1 && totalBytes > maxTotalBytes; i += 1) {
    const s = shards[i];
    try {
      fs.unlinkSync(s.abs);
      totalBytes -= s.size;
      removed.push(s.name);
    } catch { /* 删不掉就留下来，绝不因为清理失败影响读日志写入本身 */ }
  }
  return { removed, totalBytes, kept: shards.length - removed.length };
}

/**
 * 追加一条读记录。
 *
 * 写入位置：`<root>/ledger/.reads/YYYY-MM.jsonl`（+08:00 月份）；当前分片追加会超阈值时
 * 自动切 `YYYY-MM.NN.jsonl` 新分片。**旧分片不重命名、不改写**；历史单文件
 * `.reads.jsonl` 也不再追加（只读保留）。
 *
 * ★ V1.0.0-re3 / 审计② P3（旧 → 新）：总量配额口径改为"历史单文件 + `.reads/` 分片"合计；
 *   超配额仍**从最旧整分片删起**、**永远保留最新分片**；历史单文件**只计字节、永不删除**。
 *   旧口径只算分片，老库升级后 `.reads.jsonl` 再大也不计入 → 配额名存实亡。
 *
 * @param {string} root 数据总库
 * @param {{tool:string, sessionId?:string, args?:string, hitCodes?:string[],
 *          returnedRows?:number, bytes?:number, ms?:number, ledgerDay?:string,
 *          ok?:boolean, error?:string, nowMs?:number}} e
 * @param {{maxShardBytes?:number, maxTotalBytes?:number}} [opts]
 *        只供测试注入阈值（生产不传 = READ_LOG_MAX_BYTES / READ_LOG_MAX_TOTAL_BYTES）
 * @returns {{ok:boolean, recorded:boolean, path?:string, month?:string, shard?:number,
 *            rotated?:boolean, retainedRemoved?:string[], reason?:string}}
 */
export function appendRead(root, e = {}, opts = {}) {
  const tool = clip(e.tool || '', 80);
  if (!tool) return { ok: false, recorded: false, reason: 'tool-required' };
  // ★ V1.0 / 审计 P1-07：root 不安全（空/相对/盘根）时**一个字节都不写**——本函数会 mkdir，
  //   让非法 root 走到 fs 层就等于"查了一个不存在的库，顺手把它建出来"。
  if (!isSafeRoot(root)) return { ok: false, recorded: false, reason: 'unsafe-root' };
  const nowMs = Number.isFinite(e.nowMs) ? e.nowMs : Date.now();
  const hitCodes = Array.isArray(e.hitCodes)
    ? e.hitCodes.filter((c) => typeof c === 'string').slice(0, MAX_CODES).map((c) => clip(c, 48))
    : [];
  const row = {
    v: 1,
    at: stampLocal(nowMs),
    tool,
    sessionId: clip(e.sessionId || '', 120),
    args: clip(e.args || '', MAX_ARGS_CHARS),
    hitCodes,
    returnedRows: Number.isFinite(e.returnedRows) ? Math.max(0, Math.trunc(e.returnedRows)) : 0,
    bytes: Number.isFinite(e.bytes) ? Math.max(0, Math.trunc(e.bytes)) : 0,
    ms: Number.isFinite(e.ms) ? Math.max(0, Math.trunc(e.ms)) : 0,
    ledgerDay: clip(e.ledgerDay || '', 10),
    ok: e.ok !== false,
    ...(typeof e.error === 'string' && e.error ? { error: clip(e.error, MAX_DETAIL) } : {}),
  };
  const line = JSON.stringify(row) + '\n';
  const maxBytes = Number.isFinite(opts.maxShardBytes) && opts.maxShardBytes > 0
    ? Math.trunc(opts.maxShardBytes)
    : READ_LOG_MAX_BYTES;
  const maxTotalBytes = Number.isFinite(opts.maxTotalBytes) && opts.maxTotalBytes > 0
    ? Math.trunc(opts.maxTotalBytes)
    : READ_LOG_MAX_TOTAL_BYTES;

  try {
    const dir = readLogDir(root);
    fs.mkdirSync(dir, { recursive: true });
    // 分片切换是"只新建文件"：选目标 → open('a') → write；不删不重命名**正在写的分片**。
    const month = monthOfLocal(nowMs);
    const target = pickShard(root, month, maxBytes, Buffer.byteLength(line, 'utf8'));
    const fd = fs.openSync(target.abs, 'a');
    try {
      fs.writeSync(fd, line);
      // ★ V1.0 / 审计 P1-07：**不再每条 fsync**。每次 GET 一次 fsync 是磁盘放大（面板轮询即持续写盘）；
      //   读日志属于运行区，崩溃丢最后几行只影响"读审计"完整性、不影响账务，且有总量配额兜底。
      //   （原口径"读记录也必须耐久"已被审计判为过度设计，本次修订如实记录在整改报告。）
    } finally {
      fs.closeSync(fd);
    }
    // 配额执行放在写入之后：先保住这一条审计行，再按总量裁最旧分片。
    const retention = enforceRetention(root, maxTotalBytes);
    return {
      ok: true, recorded: true, path: target.abs,
      month, shard: target.serial, rotated: target.rotated,
      ...(retention.removed.length ? { retainedRemoved: retention.removed } : {}),
    };
  } catch (err) {
    // 日志写失败**不能**影响查询本身返回：审计失败不该变成功能失败
    return { ok: false, recorded: false, reason: 'write-failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

/**
 * 读日志文件清单（按**写入顺序**：历史单文件 → `.reads/` 各分片按月份+序号升序）。
 * @why 历史 `.reads.jsonl` 是升级前的唯一日志，写入时间上必然早于所有分片 → 排在第一个；
 *      分片文件名编码了"月份 + 分片序号"，与写入顺序严格一致，比 mtime 更耐搬动/复制。
 */
function listReadLogFiles(root) {
  const out = [];
  const legacy = readLogPath(root);
  try { if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) out.push(legacy); } catch { /* 探测失败按不存在 */ }
  for (const s of listShards(root)) out.push(s.abs);
  return out;
}

/**
 * 读最近 N 条读记录（新→旧）；可选**同一次遍历**顺带算出摘要。
 *
 * 读侧兼容：历史单文件 `<root>/ledger/.reads.jsonl`（若有）+ `<root>/ledger/.reads/` 下所有分片，
 * 按写入顺序（旧文件 → 月份/分片序号 + 行序）汇总后**反转**，返回"新→旧"。
 * `total` = 全部可解析行数；`badLines` = 解析失败行数（口径与 V0.6 一致）。
 *
 * @why V1.0 / 审计 P1-07：面板 `/reads` 原来是"readReads 整读一遍 + summarizeReads 再整读一遍"，
 *      重复请求即可放大 IO。加 `opts.summary` 后**一次遍历同时出列表与摘要**；
 *      同时内存只保留"最后 limit 条"（滚动窗口），不再把整个日志读进数组再 slice。
 *
 * @param {string} root
 * @param {{limit?:number, summary?:boolean}} [opts]
 * @returns {{ok:boolean, rows:object[], total:number, badLines:number, path:string,
 *            files?:string[], summary?:{byTool:object, bySession:object, hitCodesTotal:number,
 *            total:number, badLines:number, lastAt:string}, reason?:string}}
 */
export function readReads(root, opts = {}) {
  const limit = Math.min(500, Math.max(1, Number.isInteger(opts.limit) ? opts.limit : 50));
  const wantSummary = opts.summary === true;
  const files = listReadLogFiles(root);
  if (files.length === 0) {
    return {
      ok: true, rows: [], total: 0, badLines: 0, path: readLogPath(root), files: [],
      ...(wantSummary ? { summary: { byTool: {}, bySession: {}, hitCodesTotal: 0, total: 0, badLines: 0, lastAt: '' } } : {}),
    };
  }
  // 滚动窗口：只保留最后 limit 条（新→旧在尾部反转后给出），内存与日志总量解耦。
  const tail = [];
  let total = 0;
  let bad = 0;
  const byTool = {};
  const bySession = {};
  let codes = 0;
  let lastAt = '';
  for (const file of files) {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch (err) {
      return {
        ok: false, rows: [], total: 0, badLines: 0, path: file, files,
        reason: 'read-failed: ' + (err && err.message ? err.message : String(err)),
      };
    }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { bad += 1; continue; }
      total += 1;
      if (wantSummary && obj && typeof obj === 'object') {
        const t = String(obj.tool || '(unknown)');
        byTool[t] = (byTool[t] || 0) + 1;
        if (obj.sessionId) bySession[String(obj.sessionId)] = (bySession[String(obj.sessionId)] || 0) + 1;
        if (Array.isArray(obj.hitCodes)) codes += obj.hitCodes.length;
        if (typeof obj.at === 'string' && obj.at) lastAt = obj.at; // 文件顺序 = 写入顺序 → 最后一条最新
      }
      tail.push(obj);
      if (tail.length > limit) tail.shift();
    }
  }
  tail.reverse();
  return {
    ok: true, rows: tail, total, badLines: bad,
    path: files[files.length - 1], files,
    ...(wantSummary ? { summary: { byTool, bySession, hitCodesTotal: codes, total, badLines: bad, lastAt } } : {}),
  };
}

/** 读行为摘要：谁查得多、查了什么工具、命中多少条（面板顶栏用）。一次遍历，不再二次整读。 */
export function summarizeReads(root) {
  const r = readReads(root, { limit: 1, summary: true });
  if (!r.ok) return { ok: false, reason: r.reason };
  const s = r.summary || {};
  return {
    ok: true,
    total: Number(s.total) || 0,
    badLines: Number(s.badLines) || 0,
    byTool: s.byTool && typeof s.byTool === 'object' ? s.byTool : {},
    bySession: s.bySession && typeof s.bySession === 'object' ? s.bySession : {},
    hitCodesTotal: Number(s.hitCodesTotal) || 0,
    lastAt: String(s.lastAt || ''),
  };
}
