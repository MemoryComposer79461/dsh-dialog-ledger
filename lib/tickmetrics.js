/**
 * @file tickmetrics.js
 * @role 逐 tick 度量写盘（0.9.3 · P2-6）：`<root>/ledger/.tick-metrics.jsonl`，**append-only**。
 * @called-by index.js（runOnce 收尾；唯一调用者）
 * @depends 仅 node:fs / node:path
 *
 * @why 为什么要单独一个文件，而不把度量塞进 run-report：
 *   ① 运行报告（`.run-report-YYYYMMDD.json`）只在"对账那一轮"写（小时级节流），
 *      而 C21/C25 要的是**每 tick 一行**的连续证据（E2 跑 12 轮取后 10 轮）；
 *   ② 既有 5 个验具读 run-report 的频率/形状（`docs/判据-0.9.1.mjs`、
 *      `docs/判据-0.9.2-doctor.mjs`、`自测-gate.mjs`、`自测-index.mjs`、`自测-reconcile.mjs`），
 *      改它的写入时机=改 5 个验具的输入，属"REPORT 时机变化"风险；
 *   ③ 以 `.` 开头 → 台账枚举（`ledger.js` 的 `!startsWith('.')` 过滤）不会把它当账行，
 *      也不进 `ledgerFingerprint`/`readAll`，对账不会把它算进台账行数。
 *
 * @why 为什么放在 lib/（核心）而不是 index.js：
 *   index.js 头部纪律："本文件里【不许】出现 fs.writeFile / 直接解析 JSON —— 那些都是 lib 的职责。"
 *   本模块是"写盘 + JSON 序列化"的唯一落点，index 只负责组字段与调用。
 *
 * @why 为什么 append-only、不轮转：
 *   度量是**证据**，不是缓存；按日/按大小轮转会让"某天某 tick 到底发生了什么"无法一条线追。
 *   文件很小（一行 ≈ 0.5 KB，一年 60s 一 tick ≈ 52 万行 ≈ 260 MB 量级；本版只做度量，
 *   保留策略与轮转留给 0.9.4 的 C23/清册裁定 —— 本文件不做静默删除）。
 *
 * @why 写失败只返回 ok:false（调用方记 warning），不抛：
 *   度量是旁证，不是账务事实；写不进度量不许拖垮记账本轮（与 run-report 同口径：
 *   "该知道但不算失败"进 warnings，不进 errors，否则"零错误"验收会被旁证故障打红）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 度量文件名（`.` 开头 = 隐藏 + 不进台账枚举）。 */
export const TICK_METRICS_NAME = '.tick-metrics.jsonl';

/**
 * `<root>/ledger/.tick-metrics.jsonl` 的绝对路径。
 * @param {string} root 数据总库根
 * @returns {string}
 */
export function tickMetricsPath(root) {
  return path.join(path.resolve(String(root || '')), 'ledger', TICK_METRICS_NAME);
}

/**
 * 追加一行 tick 度量（append-only；一行一个 JSON 对象，不 pretty-print）。
 *
 * @param {string} root 数据总库根
 * @param {object} record 度量对象（字段形状由 index.js 组；本模块不校验业务字段）
 * @param {{nowMs?:number}} [opts]
 * @returns {{ok:boolean, path:string, bytes:number, error:string}}
 *
 * @why 不用 writeFileSync：并发/重入时"读旧 + 写全量"会丢其他实例的行；
 *      追加模式（'a'）在单写锁（lib/lock.js）保护下每 tick 一行，天然序列化。
 */
export function appendTickMetrics(root, record, opts = {}) {
  const file = tickMetricsPath(root);
  const out = { ok: false, path: file, bytes: 0, error: '' };
  if (!root || typeof root !== 'string') {
    out.error = 'missing-root';
    return out;
  }
  if (!record || typeof record !== 'object') {
    out.error = 'missing-record';
    return out;
  }
  let line;
  try {
    line = JSON.stringify(record);
  } catch (e) {
    out.error = 'stringify-failed: ' + (e && e.message ? e.message : String(e));
    return out;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n', 'utf8');
    out.ok = true;
    out.bytes = Buffer.byteLength(line, 'utf8') + 1;
    return out;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
}

/**
 * 读回度量文件（只读；给证据工具/测试用，tick 不消费）。
 *
 * @param {string} root
 * @param {{limit?:number}} [opts] limit = 只取最后 N 行（默认全部）
 * @returns {{path:string, exists:boolean, lines:number, records:object[], badLines:number, readError:string}}
 *
 * @why 坏行计入 badLines 而不抛：度量文件是旁证，被截断/手改也只影响"证据可读性"，
 *      不能让它把任何记账路径炸掉。
 */
export function readTickMetrics(root, opts = {}) {
  const file = tickMetricsPath(root);
  const out = { path: file, exists: false, lines: 0, records: [], badLines: 0, readError: '' };
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
    out.exists = true;
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) out.readError = e && e.message ? e.message : String(e);
    return out;
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 0;
  for (const raw of txt.split('\n')) {
    if (!raw.trim()) continue;
    out.lines++;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      out.badLines++;
      continue;
    }
    out.records.push(obj);
  }
  if (limit > 0 && out.records.length > limit) out.records = out.records.slice(-limit);
  return out;
}
