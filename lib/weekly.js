/**
 * @file weekly.js
 * @role 周记账（记账凭证）：把台账记录按「会话键 + 月内周段」汇成**十列** xlsx，落到二级目录；
 *       支持**草稿 / 封板**两态与**补记册**（封板后新增的行另册永久保存）。
 * @called-by index.js（每轮扫描后，只处理本轮有新记录的组；宽限期到了的组也要补一次封板）
 * @depends ./encoder.js（parseCode）、./week.js（周界/文件名）、./xlsx.js（写 xlsx）、
 *          ./original.js（第 3 级原文相对路径）、./cleanup.js（清册基础解析）、
 *          ./ledger.js（state 缓存 + `.seals.jsonl` 封板日志；两者都是证据链一环）
 *
 * ============================================================================
 * 依据：《契约决定记录-v1.3》决定 5 / 决定 9（#16–#23）+《模板-周记账-十列-v1.3》冻结稿
 * ============================================================================
 * ① 定位：周记账是**记账凭证**（检索面 + 审计面），详细内容在原始凭证（完整原文）。
 *    行**永远来自台账**；原文只作附件指针：绑定 / 补记 / 已清理(RPT-…) / 缺凭证。
 *    原文被清理 → 行不消失、标「已清理」。
 * ② 十列（A–J）：编码 / 原始凭证 / 时间 / 角色 / 对话内容摘要 /
 *    User的文件引用与Agent文件输出 / 输出文件位置 / 状态 / 用户审计 / 备注。
 *    机器只填 A/B/C/H 默认值/I 默认「待审」，D/E/F/G/J 一律 `—`；空值统一 `—`。
 * ③ 草稿/封板：草稿期每轮可重生成（内容指纹未变则跳过写盘）；该周最后一天
 *    24:00（+08:00）再满 3 天宽限后首次渲染即封板，封板后**插件永不重写**，
 *    人工列因此结构上不可能被覆盖。封板状态落 `.state.json` 的 `weeklySealed`
 *    （sealedAt/sealHash/file/layout/rows），同时写说明页文件头（可搬、可人读）。
 * ④ 封板后才发现的行 → 一级目录 `补记-YYYYMMDD.md`（另册、永久、**只追加**、不改正册）。
 * ⑤ 单日 >120 行：只写前 120 行 + 周统计第 13 行溢出计数 + 告警，绝不静默丢行。
 *
 * ============================================================================
 * v0.5 审计驱动加固（《01-v0.5-范围重定-审计驱动》）
 * ============================================================================
 * ⑥ **P0-4**：溢出编码必须有去向 —— 封板前先把溢出行写进补记册；canonical 增加
 *    `sourceRowCount / overflow / 补记引用`，120/121/122 三个封板 hash 必须互不相同；
 *    封板另存不可变 sealRows 快照 = `.seal-journal.jsonl` 里的那一行（rows + rowsSha256 + 链）。
 * ⑦ **P1-9**：证据链 = `.seal-journal.jsonl`（journal，权威）> state 缓存 >
 *    文件头标记；state 丢失只影响性能，不改变证据语义。
 * ⑧ **P1-6**：补记册编号统一 `\d+`（99/100/101 不丢不重），追加前校验册与尾部，
 *    截断尾块可恢复，验证器不得忽略未知块，写/fsync 失败必须显式上报。
 * ⑨ **P1-10**：清册"已清理"按**结论列**判定（按新旧 schema 定位列位），不看任意单元格。
 * ⑩ **P1-11**：列结构以《模板-周记账-十列-v1.3》最终版为准（四态固定 B 列「原始凭证」，
 *    RPT 号只出现在 B 列，不写备注）。
 *
 * @why 为什么草稿期仍"整份重算"而不是增量插入：
 *      v1.3 仍没有 xlsx 读取器（零依赖前提）。所以草稿按台账重算整组、内容指纹不变则跳过写盘；
 *      这正好被"封板后不写"兜住 —— 人工批注只可能发生在封板后，结构上不可能被下一轮覆盖。
 *
 * @why 为什么文件名/目录严格按 week.js：
 *      周段一错，行就落错表；所以切周逻辑只允许有一个实现。
 *
 * ============================================================================
 * 0.9.4-snap（P3 扩容 · 周账滚动 W1–W5 + 月账视图）
 * ============================================================================
 * ⑪ **W1 封板判断前移 / journal 尾读缓存**：已封板组（journal/state 有证据）**不再打开
 *    xlsx 读文件头**；`.seal-journal.jsonl` 是 append-only，只解析新增字节（文件缩水/被替换
 *    → 整读重建）。3 年 174 MB journal 的稳态读盘从"每 tick 每被触碰组整读"降到 ≈0。
 * ⑫ **W2 只看新行**：周账重算按行身份 `code + docFileSha256 + 正文 sha256(docSha256) +
 *    磁盘 stat 指纹 + 清册结论` 复用上次结论；新行/变化行才重新走 resolveDoc。
 * ⑬ **W3 bootstrap 预算**：首次建周账可按"组数/耗时"预算分批，余量记 state
 *    `weeklyCatchup`，下一轮续跑；批间幂等（草稿内容指纹不变不重写、已封板永不重写）。
 * ⑭ **W4 hash 剪枝**：行身份未变时连 resolveDoc 都不进；进了也复用 0.9.3-re1 的
 *    DOC_VERIFY_CACHE（已核过的原文不重复整文件读）；清册 RPT-*.md 扫描同样按 stat 指纹剪枝。
 * ⑮ **W5 流式摘要**：journal / 日账 / 补记册一律 `streamRangeLines()` 逐块读；journal 的
 *    `rows` 快照**不保留在内存**（只留 rowCount / rowsSha256 等计数）。
 * ⑯ **月账视图**：`<root>/YYYY年MM月/MM月账.md`（派生视图、不进 xlsx、只读生成；
 *    已封板周只读封板事实，不打开不重算 xlsx；内容指纹不变则不重写）。
 * 以上全部只影响"读多少/读多快"，**不改任何账实语义**；证据链（journal/state/xlsx/台账）
 * 一个字节不改，缓存丢了只会变慢。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseCode } from './encoder.js';
import { weekOf, monthWeeks, ymLabel, weeklyFileName, weeklyFolderName } from './week.js';
import { decideMigration, officialNameOf, draftNameOf } from './weeklystate.js';
import { writeXlsx, colName } from './xlsx.js';
import { originalRelPath, verifyOriginal } from './original.js';
// lite（S-8/P1）：不再是 "../freeze/cleanup.js" 的使用者。lite 版不做销毁/清理，
// 因此台账里不存在"已清理"标记；周账视图的"已清理"列恒为空是正确语义。
import { readState, writeState, statePath, isLedgerRow } from './ledger.js';
import {
  CANONICAL_VERSION as SEAL_CANONICAL_VERSION_SRC,
  appendSealEvent,
  readSealEvents,
  latestSealEvent,
  isSealed,
  verifySealChain,
  weeklyCanonical,
  supplementCodesSha256,
  sha256Hex as journalSha256Hex,
  sealJournalPath,
} from './sealjournal.js';

// ============================================================================
// 一、常量：十列 / 三组下拉 / 四态 / 草稿封板
// ============================================================================

/**
 * 版式版本号：**版式一变就要 +1**。契约 v1.3 定为 6。
 * 它参与内容指纹（草稿跳过用），否则"结构升级了但数据没变"会让旧版式文件不被重写。
 */
export const LAYOUT_VERSION = 6;

/**
 * 封板 canonical 版本。由 `lib/sealjournal.js` 唯一提供（决定 D15：7 → **8**，
 * 加入 `supplementCodesSha256`）。weekly 侧不再自写公式，只 re-export 便于调用方对齐。
 */
export const SEAL_CANONICAL_VERSION = SEAL_CANONICAL_VERSION_SRC;

/** 空值统一填它（模板 说明 第 7 条：不留空白、不留空格）。 */
export const EMPTY = '—';

/** 日表预置行数（A2:A121 共 120 行，与模板一致）。 */
export const DAILY_CAPACITY = 120;

/** 封板宽限期（天）：该周最后一天 24:00（+08:00）再满 3 天。 */
export const GRACE_DAYS = 3;

/** `.state.json` 里封板状态的键名。 */
export const SEAL_STATE_KEY = 'weeklySealed';

/** 已封板文件头的识别标记（说明页 A3 整句；草案正文里的"已封板："不会命中）。 */
export const SEALED_STATUS_TEXT = '状态: 已封板（本文件不再重写）';
/** 草稿文件头的识别标记。 */
export const DRAFT_STATUS_TEXT = '状态: 草稿（每轮重生成，请勿批注；封板后方可批注）';

/** 生成器标识。 */
export const GENERATOR = 'dsh-dialog-ledger-v0.4/weekly';
/** 补记册生成器标识。 */
export const SUPPLEMENT_GENERATOR = 'dsh-dialog-ledger-v0.4/weekly-supplement';

/** 状态列下拉（机器先填默认值，人可改）。 */
export const STATUS_OPTIONS = ['已完成', '进行中', '中断', '失败', '待确认'];
/** 角色列下拉。 */
export const ROLE_OPTIONS = ['User', 'Agent', 'Tool'];
/** 用户审计列下拉（机器填「待审」）。 */
export const AUDIT_OPTIONS = ['通过', '不通过', '待审'];

/** 机器为「用户审计」列填的默认值。 */
export const AUDIT_PENDING = '待审';

/**
 * 十列定义（顺序 = 列顺序 A…J；列名逐字按《模板-周记账-十列-v1.3》4.1/3.3）。
 * `by` 是"谁填"：机器 / 人。
 */
export const COLUMNS = [
  { key: 'code', name: '编码', by: '机器', required: '是', type: '文本', format: '32 位，见三', desc: '唯一；幂等键，重跑按此去重' },
  { key: 'original', name: '原始凭证', by: '机器', required: '是', type: '枚举', format: '绑定 / 补记 / 已清理(RPT-YYYYMMDD-NN) / 缺凭证', desc: '承载口径 1 四态；原文被清理时行不消失' },
  { key: 'time', name: '时间', by: '机器', required: '是', type: '时间', format: 'hh:mm', desc: '只填时:分；正序时序；日期见编码' },
  { key: 'role', name: '角色', by: '人', required: '是', type: '枚举', format: 'User / Agent / Tool（下拉）', desc: '谁说的这句话' },
  { key: 'summary', name: '对话内容摘要', by: '人', required: '是', type: '文本', format: '≤80 字', desc: '结论、意图、决策' },
  { key: 'files', name: 'User的文件引用与Agent文件输出', by: '人', required: '否', type: '文本', format: '名称或相对路径；多个用 ； 分隔', desc: '空值填 —' },
  { key: 'outPath', name: '输出文件位置', by: '人', required: '否', type: '文本', format: '绝对路径', desc: '无产出填 —' },
  { key: 'status', name: '状态', by: '人（机器先填默认值）', required: '是', type: '枚举', format: '已完成 / 进行中 / 中断 / 失败 / 待确认（下拉）', desc: '该次交互的终态' },
  { key: 'audit', name: '用户审计', by: '人（机器填 待审）', required: '否', type: '枚举', format: '通过 / 不通过 / 待审（下拉）', desc: 'user 事后复核结论' },
  { key: 'note', name: '备注', by: '人', required: '否', type: '文本', format: '自由文本', desc: '无则填 —' },
];

/** 十列表头（顺序即 A…J）。 */
export const TEN_COLUMNS = COLUMNS.map((c) => c.name);

/** 编码校验公式（与冻结模板逐字一致）。 */
const CODE_VALIDATION_FORMULA =
  'IFERROR(AND(LEN(A2)=32,' +
  'MID(A2,9,1)="-",MID(A2,22,1)="-",MID(A2,24,1)="-",' +
  'ISNUMBER(--LEFT(A2,8)),ISNUMBER(--RIGHT(A2,8)),' +
  'ISERROR(FIND("-",MID(A2,10,12))),' +
  'FIND(MID(A2,23,1),"ABCDEFGHIJKLMNOPQRSTUVWXYZ")>0),FALSE)';

/**
 * 三组下拉 + 编码校验：**必须写进 xlsx**（契约 WK-10~WK-12）。
 * 均 allow_blank=true、showErrorMessage=false（与 v1.2 模板逐字口径，见模板 4.2）。
 */
export function weeklyDataValidations() {
  const listDv = (sqref, options) => ({
    type: 'list',
    allowBlank: true,
    showInputMessage: false,
    showErrorMessage: false,
    errorTitle: '取值不在枚举内',
    error: '请从下拉值中选择，不要手填。',
    sqref,
    formula1: `"${options.join(',')}"`,
  });
  return [
    {
      type: 'custom',
      allowBlank: true,
      showInputMessage: false,
      showErrorMessage: false,
      promptTitle: '32 位编码',
      prompt: '示例：20261107-75238718e41a-B-00000001',
      errorTitle: '编码格式不符',
      error: '编码须为 YYYYMMDD-12位Session-代差(A–Z)-8位序号，共 32 位，见「说明」第三节。',
      sqref: 'A2:A121',
      formula1: CODE_VALIDATION_FORMULA,
    },
    listDv('D2:D121', ROLE_OPTIONS),   // 第 4 列：角色（v1.2 在 C 列，插 B 后右移）
    listDv('H2:H121', STATUS_OPTIONS), // 第 8 列：状态（v1.2 在 G 列）
    listDv('I2:I121', AUDIT_OPTIONS),  // 第 9 列：用户审计（v1.2 在 H 列）
  ];
}

/**
 * 封板 hash 的复算口径（v0.5 D12 v1.1 / D15；唯一公式实现见 `lib/sealjournal.js: weeklyCanonical`）。
 * @why 这里只放说明字符串，不放公式实现：实现/黑盒验收共用 sealjournal 的那一份，避免各算各的。
 */
export const SEAL_HASH_SCOPE =
  '封板hash = sha256(weeklyCanonical)（canonicalVersion=8）＝ ' +
  '{v, sessKey, year, month, weekNo, offsetMinutes, sourceRowCount, overflow, rowCount, ' +
  'rowsSha256, supplementCodesSha256, rows} 的稳定序列化再 sha256；' +
  'rows 按「周一→周日、当日 ts 升序、同刻编码升序」排列，每行 = [编码, 原始凭证, 时间(hh:mm), 状态]；' +
  'supplementCodesSha256 覆盖溢出编码集合（无溢出也有确定值）；只覆盖机器列，' +
  '不含人工列（角色/摘要/文件引用/输出位置/用户审计/备注）、生成时间、封板时间。';

// ============================================================================
// 一·补、0.9.4-snap（P3）读放大修复基础设施：流式读 / 缓存 / 计量
// ============================================================================
/**
 * @why 这一节只服务"读放大"，不改任何账实语义（W1–W5 最小档）：
 *   · W1 封板判断前移 + journal 尾读缓存：已封板组不再读整本 xlsx 文件头；
 *        append-only 的 `.seal-journal.jsonl` 只解析**新增字节**（缩水/被替换 → 整读）。
 *   · W2 只看新行：周账重算按行身份（code + docFileSha256 + 正文 sha256 + 磁盘 stat 指纹）
 *        复用上次结论；身份变了的行才重新走 resolveDoc。
 *   · W4 hash 剪枝：行身份未变时连 resolveDoc 都不进；进了也复用 re1 的 DOC_VERIFY_CACHE，
 *        已核过的原文**不重复整文件读**；清册（RPT-*.md）扫描同样按 stat 指纹剪枝。
 *   · W5 流式摘要：journal / 日账 / 补记册一律 `streamRangeLines()` 逐块读，
 *        内存里不出现"整本文件字符串"或 journal 的 rows 快照（只留计数与元数据）。
 *   ⇒ 全部是**纯性能缓存**：丢了只会变慢；证据链（journal/state/xlsx/台账）一个字节不改。
 *      缓存键都可证：任何写入/替换/删除都会改变 size/mtime/ino 或内容指纹 → 缓存失效。
 */

/** 流式读块大小（256 KiB；3 年 174 MB 的 journal 也只会占一个块）。 */
const STREAM_CHUNK_BYTES = 256 * 1024;
/** journal 替换探测：文件头指纹长度 / 末段守卫长度。 */
const JOURNAL_PREFIX_BYTES = 256;
const JOURNAL_GUARD_BYTES = 64;
const JOURNAL_CACHE_MAX = 32;
const CLEANED_CACHE_MAX = 32;
const SEALS_CACHE_MAX = 32;
const ROW_CACHE_MAX_GROUPS = 256;
const ROW_CACHE_MAX_ROWS = 2048;

/**
 * 运行计量（只增不减；`resetWeeklyRuntimeStats()` 可清零）。
 * 只用于自测/诊断证明"读了多少"，**不参与任何业务判断**。
 */
const RUNTIME = {
  streamCalls: 0, streamBytes: 0, streamMaxChunkBytes: 0,
  journalCalls: 0, journalFullReads: 0, journalTailReads: 0,
  journalProbeBytes: 0, journalTailBytes: 0, journalBytesRead: 0,
  journalLinesParsed: 0,
  markerReads: 0, markerBytes: 0,
  cleanedScans: 0,
  rowSeen: 0, rowResolved: 0, rowReused: 0, docFull: 0, docCached: 0,
  monthlyFiles: 0, monthlyBytes: 0, monthlyLines: 0,
};

/** 读运行计量快照（周账滚动/月账自测用来证明"没重复读"）。 */
export function weeklyRuntimeStats() { return { ...RUNTIME }; }

/** 清零运行计量（不影响缓存）。 */
export function resetWeeklyRuntimeStats() {
  for (const k of Object.keys(RUNTIME)) RUNTIME[k] = 0;
}

/** 清空全部周账只读缓存 + 清零计量（自测/诊断；不改变任何落盘文件）。 */
export function resetWeeklyCaches() {
  JOURNAL_CACHE.clear();
  SEALS_CACHE.clear();
  CLEANED_CACHE.clear();
  ROW_CACHE.clear();
  DOC_VERIFY_CACHE.clear(); // re1 的凭证复核缓存也清（自测要能观察"真复核/缓存命中"两种路径）
  resetWeeklyRuntimeStats();
}

/** 只清行级复用缓存（用来单独观察 re1 的 DOC_VERIFY_CACHE 命中）。 */
export function resetWeeklyRowCache() { ROW_CACHE.clear(); }

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 有界 LRU 覆盖写（Map 的插入序当 LRU；超限淘汰最旧）。 */
function cacheSetBounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** 打开一次读一段字节（读不到返回空 Buffer；错误由调用方按"内容不匹配"处理）。 */
function readFileRangeSync(filePath, start, len) {
  const want = Number.isFinite(len) && len > 0 ? len : 0;
  const buf = Buffer.alloc(want);
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return { buf: Buffer.alloc(0) }; }
  try {
    const n = fs.readSync(fd, buf, 0, want, Math.max(0, Number(start) || 0));
    return { buf: buf.subarray(0, n) };
  } catch {
    return { buf: Buffer.alloc(0) };
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖读取结果 */ }
  }
}

/**
 * 流式逐行读一个文件的一部分（**W5 的唯一实现**）。
 *
 * @param {string} filePath
 * @param {number} start 起始字节（0 = 文件头）
 * @param {number} end   结束字节（不含；不传/非有限 = 读到 EOF）
 * @param {(line:string)=>void} onLine 每行回调（末行没有换行也会回调）
 * @returns {{ok:boolean, error?:Error, lines:number, bytesRead:number, maxChunkBytes:number,
 *            firstBytes:Buffer, lastBytes:Buffer}}
 *
 * @why 为什么不能 `fs.readFileSync(file,'utf8')` 再 split：
 *      3 年 journal ≈174 MB、日账 ≈2.9 MB/天，整读会在内存里同时留下
 *      "整本字符串 + split 后所有行"两份峰值；这里峰值 ≈ 一个 256 KiB 块 + 一个残行。
 * @why 为什么要 StringDecoder：多字节 UTF-8 字符可能跨块边界，直接 buf.toString 会出乱码。
 */
function streamRangeLines(filePath, start, end, onLine, opts = {}) {
  const chunkBytes = Number.isInteger(opts.chunkBytes) && opts.chunkBytes > 0
    ? opts.chunkBytes : STREAM_CHUNK_BYTES;
  const out = {
    ok: false, lines: 0, bytesRead: 0, maxChunkBytes: 0,
    firstBytes: Buffer.alloc(0), lastBytes: Buffer.alloc(0),
  };
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch (e) { out.error = e; return out; }
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(chunkBytes);
  let carry = '';
  let pos = Number.isFinite(start) && start > 0 ? Math.floor(start) : 0;
  const limit = Number.isFinite(end) && end >= pos ? Math.floor(end) : Number.POSITIVE_INFINITY;
  const firstChunks = [];
  let firstLen = 0;
  let lastKeep = Buffer.alloc(0);
  try {
    while (pos < limit) {
      const want = Number.isFinite(limit) ? Math.min(chunkBytes, limit - pos) : chunkBytes;
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      out.bytesRead += n;
      if (n > out.maxChunkBytes) out.maxChunkBytes = n;
      RUNTIME.streamCalls += 1;
      RUNTIME.streamBytes += n;
      if (n > RUNTIME.streamMaxChunkBytes) RUNTIME.streamMaxChunkBytes = n;
      // 文件头 / 末段取样（上限都只有几百字节，与块大小无关）
      if (pos - n === 0 && firstLen < JOURNAL_PREFIX_BYTES) {
        const take = Math.min(n, JOURNAL_PREFIX_BYTES - firstLen);
        firstChunks.push(Buffer.from(buf.subarray(0, take)));
        firstLen += take;
      }
      if (n >= JOURNAL_GUARD_BYTES) {
        lastKeep = Buffer.from(buf.subarray(n - JOURNAL_GUARD_BYTES, n));
      } else {
        lastKeep = Buffer.concat([lastKeep, Buffer.from(buf.subarray(0, n))]);
        if (lastKeep.length > JOURNAL_GUARD_BYTES) {
          lastKeep = Buffer.from(lastKeep.subarray(lastKeep.length - JOURNAL_GUARD_BYTES));
        }
      }
      const text = carry + decoder.write(buf.subarray(0, n));
      const parts = text.split('\n');
      carry = parts.pop();
      for (const line of parts) {
        out.lines += 1;
        onLine(line);
      }
    }
    const tail = carry + decoder.end();
    if (tail !== '' || out.lines === 0) {
      out.lines += 1;
      onLine(tail);
    }
    out.firstBytes = Buffer.concat(firstChunks);
    out.lastBytes = lastKeep;
    out.ok = true;
    return out;
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖读取结果 */ }
  }
}

// ── W1：journal 尾读缓存 ────────────────────────────────────────────────────
/** journal 索引缓存：journalPath → {size,mtimeMs,prefixLen,prefixSha,guardBytes,guardSha,
 *  seals:Map, summaries:Array, eventCount, badLines, headSha}。 */
const JOURNAL_CACHE = new Map();
/** 封板状态合并视图缓存：root → {sig, value}（journal + state 合并结果）。 */
const SEALS_CACHE = new Map();

function journalEmptyView(root) {
  return {
    path: sealJournalPath(root), exists: false, size: 0, sig: 'ENOENT',
    events: [], eventCount: 0, badLines: 0, readError: '', headSha: '', chainBroken: 0,
    seals: new Map(), summaries: [], probeBytes: 0, tailBytes: 0, fullRead: false,
  };
}

function newJournalEntry(file) {
  return {
    file, size: 0, mtimeMs: 0,
    prefixLen: 0, prefixSha: '',
    guardBytes: Buffer.alloc(0), guardSha: '',
    seals: new Map(), summaries: [], eventCount: 0, badLines: 0, headSha: '',
  };
}

/** journal 事件 → **摘要对象**（W5：丢掉 rows 数组，只留计数/摘要）。 */
function journalSummaryOf(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const rows = Array.isArray(ev.rows) ? ev.rows : null;
  const supp = ev.supplement && typeof ev.supplement === 'object'
    ? {
      file: ev.supplement.file === undefined ? null : ev.supplement.file,
      sha256: ev.supplement.sha256 === undefined ? null : ev.supplement.sha256,
      codes: Array.isArray(ev.supplement.codes) ? ev.supplement.codes.slice() : null,
    }
    : null;
  return {
    v: ev.v === undefined ? null : ev.v,
    kind: String(ev.kind || ''),
    key: String(ev.key || ''),
    gid: ev.gid === undefined ? null : ev.gid,
    file: ev.file === undefined ? null : ev.file,
    sealedAt: String(ev.sealedAt || ''),
    layoutVersion: ev.layoutVersion === undefined ? null : ev.layoutVersion,
    canonicalVersion: ev.canonicalVersion === undefined ? null : ev.canonicalVersion,
    sourceRowCount: Number.isFinite(ev.sourceRowCount) ? ev.sourceRowCount : null,
    overflow: Number.isFinite(ev.overflow) ? ev.overflow : null,
    rowCount: rows ? rows.length : (Number.isFinite(ev.rowCount) ? ev.rowCount : null),
    rowsSha256: String(ev.rowsSha256 || ''),
    supplementCodesSha256: String(ev.supplementCodesSha256 || ''),
    supplement: supp,
    sealHash: String(ev.sealHash || ''),
    prevSealSha256: String(ev.prevSealSha256 || ''),
    at: String(ev.at || ''),
  };
}

/** journal 摘要 → readWeeklySeals 形状的封板信息（与旧 journalWeeklySeals 逐字段对齐）。 */
function sealInfoFromSummary(sm) {
  if (!sm || sm.kind !== 'weekly-seal') return null;
  const gid = String(sm.key || sm.gid || '');
  if (!gid) return null;
  return {
    gid,
    sealedAt: sm.sealedAt,
    sealHash: sm.sealHash,
    file: sm.file === null || sm.file === undefined ? '' : String(sm.file),
    layout: Number.isFinite(sm.layoutVersion) ? sm.layoutVersion : LAYOUT_VERSION,
    canonicalVersion: Number.isFinite(sm.canonicalVersion) ? sm.canonicalVersion : SEAL_CANONICAL_VERSION,
    sourceRowCount: Number.isFinite(sm.sourceRowCount) ? sm.sourceRowCount : undefined,
    overflow: Number.isFinite(sm.overflow) ? sm.overflow : undefined,
    rows: Number.isFinite(sm.rowCount) ? sm.rowCount : 0,
    rowsSha256: sm.rowsSha256,
    supplementCodesSha256: sm.supplementCodesSha256,
    supplement: sm.supplement,
    prevSealSha256: sm.prevSealSha256,
    source: 'journal',
  };
}

/** 消费一行 journal 文本：坏行只计数（与 sealjournal.readSealEvents 同口径）。 */
function journalConsumeLine(entry, line) {
  if (!line || !line.trim()) return;
  RUNTIME.journalLinesParsed += 1;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    entry.badLines += 1;
    return;
  }
  entry.eventCount += 1;
  // 与 readSealEvents 一致：headSha = sha256(最后一**条可解析行的原文**)，不做 trim。
  entry.headSha = journalSha256Hex(line);
  const sm = journalSummaryOf(ev);
  if (!sm) return;
  entry.summaries.push(sm);
  const info = sealInfoFromSummary(sm);
  if (info) entry.seals.set(info.gid, info);
}

function journalView(entry, extra = {}) {
  return {
    path: entry.file,
    exists: true,
    size: entry.size,
    sig: `${entry.size}:${entry.guardSha}`,
    events: entry.summaries,
    eventCount: entry.eventCount,
    badLines: entry.badLines,
    readError: '',
    headSha: entry.headSha,
    chainBroken: 0,
    seals: entry.seals,
    summaries: entry.summaries,
    probeBytes: extra.probeBytes || 0,
    tailBytes: extra.tailBytes || 0,
    fullRead: extra.fullRead === true,
  };
}

/**
 * 读 journal 的**缓存索引**（W1）—— 只解析新增字节，返回封板事实 Map + 摘要事件。
 *
 * 正确性锚（为什么"增量"不会读漏/读错）：
 *   · 写者唯一（lib/sealjournal.js），append-only + fsync，每次追加都改变 size/mtime；
 *   · size 变大时先核对"旧内容的头 256 B + 旧末尾 64 B"指纹，任何改写/替换 → 整读重建；
 *   · size 缩水 → 整读重建；
 *   · 坏行跳过并计数（与 readSealEvents 同口径），不因为一行坏就整册不可读。
 */
function journalIndexFor(root) {
  const file = sealJournalPath(root);
  RUNTIME.journalCalls += 1;
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      JOURNAL_CACHE.delete(file);
      return journalEmptyView(root);
    }
    const v = journalEmptyView(root);
    v.readError = e && e.message ? e.message : String(e);
    return v;
  }
  const size = st.size;
  let entry = JOURNAL_CACHE.get(file);
  if (entry) JOURNAL_CACHE.delete(file); // LRU touch（命中后重新入队）
  let probeBytes = 0;
  let intact = false;
  if (entry) {
    if (size < entry.size) {
      intact = false; // 缩水/被替换 → 整读
    } else if (size === entry.size) {
      if (st.mtimeMs === entry.mtimeMs) {
        intact = true; // append-only：尺寸/mtime 都没变 = 没变
      } else {
        const p = readFileRangeSync(file, 0, entry.prefixLen);
        const g = entry.guardBytes.length > 0
          ? readFileRangeSync(file, entry.size - entry.guardBytes.length, entry.guardBytes.length)
          : { buf: Buffer.alloc(0) };
        probeBytes += p.buf.length + g.buf.length;
        intact = sha256Buf(p.buf) === entry.prefixSha && sha256Buf(g.buf) === entry.guardSha;
        if (intact) entry.mtimeMs = st.mtimeMs;
      }
    } else {
      // 变长：核对旧内容未被改写
      const p = readFileRangeSync(file, 0, entry.prefixLen);
      const glen = entry.guardBytes.length;
      const g = glen > 0 ? readFileRangeSync(file, entry.size - glen, glen) : { buf: Buffer.alloc(0) };
      probeBytes += p.buf.length + g.buf.length;
      intact = sha256Buf(p.buf) === entry.prefixSha && sha256Buf(g.buf) === entry.guardSha;
    }
  }
  if (entry && intact && entry.size === size) {
    RUNTIME.journalProbeBytes += probeBytes;
    if (entry.prefixLen === 0 && size > 0) {
      // 冷启动写了空文件后又长出来：补一次头指纹（只发生一次）
      const p = readFileRangeSync(file, 0, Math.min(size, JOURNAL_PREFIX_BYTES));
      entry.prefixLen = p.buf.length;
      entry.prefixSha = sha256Buf(p.buf);
    }
    cacheSetBounded(JOURNAL_CACHE, file, entry, JOURNAL_CACHE_MAX); // LRU：命中路径必须放回
    return journalView(entry, { probeBytes });
  }
  if (entry && intact) {
    // 增量：只解析 [entry.size, size)
    const start = entry.size;
    const res = streamRangeLines(file, start, size, (line) => journalConsumeLine(entry, line));
    if (!res.ok) {
      // 读失败 ≠ 没封板（审计 M-02/M-03 同口径）：丢掉半成品缓存、如实报 readError
      JOURNAL_CACHE.delete(file);
      const v = journalEmptyView(root);
      v.readError = 'journal-tail-read-failed: ' + String((res.error && res.error.message) || res.error || 'unknown');
      return v;
    }
    RUNTIME.journalProbeBytes += probeBytes;
    RUNTIME.journalTailReads += 1;
    RUNTIME.journalTailBytes += res.bytesRead;
    RUNTIME.journalBytesRead += res.bytesRead;
    entry.size = size;
    entry.mtimeMs = st.mtimeMs;
    if (entry.prefixLen < JOURNAL_PREFIX_BYTES && size > 0) {
      const p = readFileRangeSync(file, 0, Math.min(size, JOURNAL_PREFIX_BYTES));
      entry.prefixLen = p.buf.length;
      entry.prefixSha = sha256Buf(p.buf);
    }
    const merged = Buffer.concat([entry.guardBytes, res.lastBytes]);
    entry.guardBytes = merged.length > JOURNAL_GUARD_BYTES
      ? Buffer.from(merged.subarray(merged.length - JOURNAL_GUARD_BYTES))
      : merged;
    entry.guardSha = sha256Buf(entry.guardBytes);
    cacheSetBounded(JOURNAL_CACHE, file, entry, JOURNAL_CACHE_MAX);
    return journalView(entry, { probeBytes, tailBytes: res.bytesRead });
  }
  // 整读重建（W5：流式，绝不同时持有整本字符串 + rows）
  const fresh = newJournalEntry(file);
  const res = streamRangeLines(file, 0, size, (line) => journalConsumeLine(fresh, line));
  if (!res.ok) {
    JOURNAL_CACHE.delete(file);
    const v = journalEmptyView(root);
    v.readError = 'journal-read-failed: ' + String((res.error && res.error.message) || res.error || 'unknown');
    return v;
  }
  RUNTIME.journalFullReads += 1;
  RUNTIME.journalBytesRead += res.bytesRead;
  fresh.size = size;
  fresh.mtimeMs = st.mtimeMs;
  fresh.prefixLen = res.firstBytes.length;
  fresh.prefixSha = sha256Buf(res.firstBytes);
  fresh.guardBytes = res.lastBytes;
  fresh.guardSha = sha256Buf(res.lastBytes);
  fresh.lastReadBytes = res.bytesRead;
  cacheSetBounded(JOURNAL_CACHE, file, fresh, JOURNAL_CACHE_MAX);
  return journalView(fresh, { probeBytes, fullRead: true });
}

/** 读 state 文件的 stat 指纹（不读内容；state 变了 → 合并视图必须重算）。 */
function stateFileSignature(root) {
  try {
    const st = fs.statSync(statePath(root));
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return 'ENOENT';
  }
}

/**
 * 封板状态合并视图：**journal 权威 > state 缓存**（P1-9）。
 * 缓存键 = journal 的 (size, guardSha) + state 文件 stat 指纹；任何一方变化即重算。
 * 返回对象内部共享，调用方只读；导出 API `readWeeklySeals()` 会做浅拷贝。
 */
function weeklySealsView(root) {
  const j = journalIndexFor(root);
  const sig = `${j.sig}|${stateFileSignature(root)}|${j.readError || ''}`;
  const cached = SEALS_CACHE.get(root);
  if (cached && cached.sig === sig) return cached.value;
  const out = {};
  // ① state 缓存（最低优先级；state 丢了只影响性能）
  try {
    const st = readState(root);
    const v = st && st[SEAL_STATE_KEY];
    if (v && typeof v === 'object') {
      for (const [gid, info] of Object.entries(v)) {
        const norm = sealInfoOf({ [gid]: info }, gid);
        if (norm) out[gid] = { ...norm, source: norm.source || 'state' };
      }
    }
  } catch { /* 缓存坏了不影响证据链 */ }
  // ② journal（权威）覆盖
  for (const [gid, info] of j.seals) out[gid] = info;
  cacheSetBounded(SEALS_CACHE, root, { sig, value: out }, SEALS_CACHE_MAX);
  return out;
}

// ── W2/W4：清册扫描剪枝（RPT-*.md 只在确有变化时重读） ──────────────────────
/** 清册缓存：root → {sig, dirSig, map}。 */
const CLEANED_CACHE = new Map();

/**
 * 账库根目录指纹（1 次 stat）。
 * @why 为什么可以先看目录 mtime：RPT-*.md 是"一次写、永不覆盖"的归档文件（lite 不做销毁，
 *      也从不产新清册），新增/删除清册必然改变根目录 mtime；内容原地改写极罕见 →
 *      用目录指纹做"快速路径"，避免每次 collectDays 都对每个 RPT 逐一 stat。
 */
function rootDirSignature(root) {
  try {
    const st = fs.statSync(root);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return 'ERR';
  }
}

/** 慢路径指纹：RPT 文件名 + 逐文件 size/mtime/ino（只在目录指纹变化时才计算）。 */
function cleanedJsonSignature(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return 'ERR'; }
  const rpt = names.filter((n) => /^RPT-\d{8}-\d{2}\.md$/.test(n)).sort();
  const parts = [];
  for (const n of rpt) {
    try {
      const st = fs.statSync(path.join(root, n));
      parts.push(`${n}:${st.size}:${st.mtimeMs}:${st.ino}`);
    } catch { parts.push(`${n}:ERR`); }
  }
  return parts.join('|');
}

function readCleanedMapCached(root) {
  const dirSig = rootDirSignature(root);
  const hit = CLEANED_CACHE.get(root);
  if (hit && hit.dirSig === dirSig) return hit.map; // 快速路径：目录没变 = 清册没变
  const sig = cleanedJsonSignature(root);
  if (hit && hit.sig === sig) {
    hit.dirSig = dirSig; // 目录变了但清册集合/元数据没变（例如别的文件新增）→ 复用
    return hit.map;
  }
  RUNTIME.cleanedScans += 1;
  const map = readCleanedCodesCompat(root);
  cacheSetBounded(CLEANED_CACHE, root, { sig, dirSig, map }, CLEANED_CACHE_MAX);
  return map;
}

// ── W1/W2：xlsx 文件头读取（按需 + 计量） ───────────────────────────────────
/** 读封板标记（带读字节计量）；只在**没有 journal/state 证据**时才被调用。 */
function readSealedMarkerTracked(filePath) {
  try {
    const st = fs.statSync(filePath);
    RUNTIME.markerReads += 1;
    RUNTIME.markerBytes += st.size;
  } catch { /* 文件不在：readSealedMarkerEx 会给出 unreadable */ }
  return readSealedMarkerEx(filePath);
}

// ── W2：行级复用缓存 ────────────────────────────────────────────────────────
/** 行缓存：`root\0gid` → {rows: Map<code, {sig, entry, integrity}>}。 */
const ROW_CACHE = new Map();

function rowCacheBucket(root, gid) {
  const key = `${root}\u0000${gid}`;
  let bucket = ROW_CACHE.get(key);
  if (bucket) {
    ROW_CACHE.delete(key); // LRU touch
  } else {
    bucket = { rows: new Map() };
  }
  ROW_CACHE.set(key, bucket);
  while (ROW_CACHE.size > ROW_CACHE_MAX_GROUPS) {
    const oldest = ROW_CACHE.keys().next().value;
    if (oldest === undefined) break;
    ROW_CACHE.delete(oldest);
  }
  return bucket;
}

/**
 * 一行的**可证身份**（W2；与 re1 的 DOC_VERIFY_CACHE 同口径并补上四态判定所需输入）：
 *   code + ts + 状态 + 台账三哈希（docFileSha256/docSha256/attachment.sha256）
 *   + 附件名/声明字节数 + 清册结论 + 期望路径 + **相关文件的磁盘 stat 指纹**。
 *
 * @why 为什么 stat 指纹必须进身份：原文/附件是一次写、永不覆盖的凭证，但"文件被替换/删除"
 *      只会改变 stat（size/mtime/ctime/ino）；带 stat 才能在"文件被动过"时立刻失效缓存。
 *      stat 是元数据读，不读文件内容 —— 这正是 W4 要的"hash 剪枝"。
 */
function rowSignature(root, rec, offsetMinutes, cleanedMap) {
  const code = String(rec.code || '');
  const ms = Date.parse(rec.ts);
  const mm = monthOfCode(code, ms, offsetMinutes);
  const computed = mm ? originalRelPath(mm.year, mm.month, code) : '';
  const cleanedReport = cleanedMap && cleanedMap.has(code) ? String(cleanedMap.get(code)) : '';
  const docRel = typeof rec.doc === 'string' ? rec.doc : '';
  const att = rec.attachment && typeof rec.attachment === 'object' ? rec.attachment : null;
  const attName = att && typeof att.name === 'string' ? att.name : '';
  let statDoc = '-';
  let statAtt = '-';
  let statComputed = '-';
  if (root) {
    if (docRel) {
      const docPath = path.join(root, docRel);
      statDoc = fileStatKey(docPath);
      statAtt = fileStatKey(path.join(path.dirname(docPath), attName || `${code} 原始事件.json`));
    } else if (computed) {
      statComputed = fileStatKey(path.join(root, computed));
    }
  }
  return [
    code, String(rec.ts || ''), String(rec.status || ''),
    docRel, String(rec.docSha256 || rec.docHash || ''), String(rec.docFileSha256 || ''),
    attName, att ? String(att.sha256 || '') : '',
    att && att.bytes !== undefined ? String(att.bytes) : '',
    cleanedReport, String(offsetMinutes), statDoc, statAtt, statComputed,
  ].join('\u0000');
}

// ============================================================================
// 二、凭证四态与分组
// ============================================================================

/**
 * P1-1 / CH-02：把 verifyOriginal 的 problems 归一成契约机器码。
 * 保留原始码（黑盒按 CH-02 断言具体码），身份类问题额外映射 `IDENTITY_MISMATCH`。
 */
function normalizeIntegrityProblems(problems) {
  const raw = Array.isArray(problems) ? problems.map(String).filter(Boolean) : [];
  const mapped = [];
  for (const p of raw) {
    if (/^(CODE_MISMATCH|YAML_CODE_MISSING_OR_BAD|YAML_NAME_MISMATCH|FILENAME_CODE_MISMATCH)$/.test(p)) {
      mapped.push('IDENTITY_MISMATCH');
    }
  }
  return [...new Set([...raw, ...mapped])];
}

/** 决定"绑定"所必需的台账三哈希字段是否齐全（CH-01：缺任一 → legacy，永不 bound）。 */
export function hasBindingEvidence(rec) {
  const isHash = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  const att = rec && rec.attachment && typeof rec.attachment === 'object' ? rec.attachment : null;
  return {
    ok: !!(isHash(rec && rec.docFileSha256) && isHash((rec && (rec.docSha256 || rec.docHash)) || '') && att && isHash(att.sha256)),
    docFileSha256: rec && rec.docFileSha256,
    docSha256: rec && (rec.docSha256 || rec.docHash),
    attachment: att,
  };
}

/**
 * 解析一条记录的凭证状态（v0.5 P1-1 / CH-02：**绑定必须复核实际文件**）。
 *
 * 四态判定：
 *   · 文件在 + 记录带 doc + 三哈希齐全 + `verifyOriginal().ok` → **绑定**
 *   · 文件在 + 记录没 doc → 补记（历史补记，不 claim 绑定）
 *   · 文件不在 + 清册有据（结论=已删除）→ **已清理(RPT-…)**
 *   · 其余 → **缺凭证**
 *
 * ⚠️ CH-02 硬判据：
 *   - 记录声明了 `doc` 但文件被改（YAML/正文/附件/路径）→ **不得 bound**，落缺凭证，
 *     并把机器码（FILE_HASH_MISMATCH、BODY_HASH_MISMATCH、ATTACHMENT_MISSING、
 *     ATTACHMENT_HASH_MISMATCH、PATH_MISMATCH、YAML_* 等）
 *     放进 `integrity` 交给调用方写 `运行报告.integrityFailures:[{code,reason}]`。
 *   - 旧 v0.4 行缺 `docFileSha256/attachment` → `LEGACY_NO_ATTACHMENT`，**永不 bound**（CH-01）。
 *   - 合法清理（清册有据）→ `已清理(RPT-…)`，**不得**进 integrityFailures（CH-02 ⑤）。
 *
 * @returns {{rel:string, state:'bound'|'backfilled'|'cleaned'|'missing',
 *            report:string, problems:string[],
 *            integrity:{code:string, problems:string[]}|null,
 *            verify:'full'|'cached'|'none'}}
 *          `verify`（v0.9.3-re1）：'full'=本次真跑了 verifyOriginal；'cached'=复用了可证缓存
 *          （内容身份 + 磁盘 stat 指纹 + 清册结论都未变）；'none'=本来就不做加密复核。
 *          缓存命中**不算**"本次核过"，也不改变四态语义。
 */
/**
 * 一条记录的「完整原文」应该落在**哪个月**（决定 P1-12 / INV-24 的路径复核）。
 *
 * ★ 2026-11-09 审计 #6（已复现）：必须按**编码日期段**（= 会话开始日）取月，
 *   不能按"这一轮发生的时刻 ts"取月。跨月会话（1/31 23:59 开始、2/1 那轮结束）
 *   写端按编码落 `2026年01月`，读端若按 ts 复算就是 `2026年02月` →
 *   永久 `PATH_MISMATCH` / 周记账 B 列"缺凭证"，而凭证不可变、没有修复路径。
 *
 * 编码不可解析时才退回 ts（坏记录也不能让复核崩掉）。
 * @param {string} code 32 位编码
 * @param {number} tsMs 轮次发生时刻（兜底用）
 * @param {number} offsetMinutes
 * @returns {{year:number, month:number}|null}
 */
export function monthOfCode(code, tsMs, offsetMinutes = 480) {
  const p = parseCode(String(code || ''));
  const d = p && typeof p.date === 'string' ? p.date : '';
  if (/^\d{8}$/.test(d)) {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(4, 6));
    if (y > 0 && m >= 1 && m <= 12) return { year: y, month: m };
  }
  const w = Number.isFinite(tsMs) ? weekOf(tsMs, offsetMinutes) : null;
  return w ? { year: w.year, month: w.month } : null;
}

// ============================================================================
// v0.9.3-re1 读放大修复：凭证复核缓存（只复用"上一次真核过"的结论）
// ============================================================================
/**
 * @why 为什么缓存不丢语义（缓存键的**可证性**）：
 *   ① 原文/附件是**一次写、永不覆盖**的凭证（lib/original.js 原子排他创建；同名不同内容 = 停摆）；
 *   ② 记录里的 `docFileSha256 + docSha256 + attachment.sha256` 就是这份凭证的**内容身份**；
 *   ③ 缓存键 = 内容身份 + **磁盘物理指纹**（stat 的 size/mtime/ctime/inode，只 stat 不读内容）
 *      + 附件名/声明字节数 + 清册结论（已清理 RPT 号）+ 期望路径；
 *   ④ 命中时复用的一定是"上一次真跑过 verifyOriginal"的结论，返回里 `verify:'cached'` 明示；
 *   ⑤ 任何写入/篡改/替换/删除都会改变 stat 指纹（或清册结论）→ 键变 → 重新全量复核。
 *   ⇒ 不是"跳过算核过"：`verify='full'` = 本次真核过；`verify='cached'` = 复用可证的旧全核结论；
 *      `verify='none'` = 本来就不做加密复核（无证据行/补记/已清理/缺凭证）。
 */
const DOC_VERIFY_CACHE_MAX = 4096;
const DOC_VERIFY_CACHE = new Map();

/** 文件物理指纹（只 stat，不读内容）：不存在 → 'ENOENT'；其它异常 → 'ERR'。 */
function fileStatKey(p) {
  if (!p) return '-';
  try {
    const st = fs.statSync(p);
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'ENOENT' : 'ERR';
  }
}

/** 写缓存并按容量淘汰最旧键（防长跑内存膨胀；只影响命中率，不影响正确性）。 */
function docCacheSet(key, value) {
  DOC_VERIFY_CACHE.set(key, value);
  while (DOC_VERIFY_CACHE.size > DOC_VERIFY_CACHE_MAX) {
    const oldest = DOC_VERIFY_CACHE.keys().next().value;
    if (oldest === undefined) break;
    DOC_VERIFY_CACHE.delete(oldest);
  }
}

export function resolveDoc(root, rec, offsetMinutes, cleaned = null) {
  const ms = Date.parse(rec.ts);
  const mm = monthOfCode(rec.code, ms, offsetMinutes);
  const computed = mm ? originalRelPath(mm.year, mm.month, rec.code) : '';
  const cleanedReport = cleaned && cleaned.has(rec.code) ? String(cleaned.get(rec.code)) : '';
  const out = (state, rel, report, problems, integrity, verify = 'none') => ({
    rel, state, report: report || '', problems: problems || [], integrity: integrity || null,
    // verify：本结果是否来自一次真实的加密复核（'full'）/ 可证缓存复用（'cached'）/ 不核（'none'）
    verify,
  });

  // ① 记录声明了 doc：严格绑定复核（P1-1 / CH-02）
  if (rec.doc && root) {
    const docPath = path.join(root, rec.doc);
    const expectedPath = path.join(root, computed || rec.doc);
    const evidence = hasBindingEvidence(rec);
    if (!evidence.ok) {
      // 旧 v0.4 行 / 字段不全：没有证据 → 永不 bound（不是"文件坏了"）
      let exists = false;
      try { exists = fs.existsSync(docPath); } catch { exists = false; }
      if (!exists && cleanedReport) return out('cleaned', '', cleanedReport, [], null);
      const problems = ['LEGACY_NO_ATTACHMENT'];
      return out('missing', exists ? rec.doc : '', '', problems, { code: rec.code, problems });
    }
    let v;
    // ★ 缓存键必须可证（见文件上方「凭证复核缓存」注释）：
    //   身份三哈希 + 附件名/声明字节数 + 清册结论 + doc/附件的磁盘物理指纹 + 期望路径。
    //   命中 = 输入与"上次全量复核时"完全一致 → 结论仍成立；文件被动过 → stat 变 → 重新核。
    const attName = evidence.attachment.name || `${rec.code} 原始事件.json`;
    const attPath = path.join(path.dirname(docPath), attName);
    const verifyKey = [
      root, rec.code, rec.doc, expectedPath,
      evidence.docFileSha256, evidence.docSha256,
      evidence.attachment.sha256, attName,
      String(rec.attachment && rec.attachment.bytes !== undefined ? rec.attachment.bytes : ''),
      cleanedReport, fileStatKey(docPath), fileStatKey(attPath),
    ].join('\u0000');
    const hit = DOC_VERIFY_CACHE.get(verifyKey);
    if (hit) {
      // 不是"跳过算核过"：verify='cached' 明示这是**上次真核过**的结论复用。
      RUNTIME.docCached += 1; // W4：证明"已核过的原文没有重复整文件读"
      return {
        ...hit,
        problems: hit.problems.slice(),
        integrity: hit.integrity ? { ...hit.integrity, problems: hit.integrity.problems.slice() } : null,
        verify: 'cached',
      };
    }
    try {
      v = verifyOriginal(docPath, {
        expectedFullHash: rec.docFileSha256,
        expectedBodyHash: evidence.docSha256,
        expectedCode: rec.code,
        expectedAttachmentSha256: evidence.attachment.sha256,
        expectedAttachmentName: evidence.attachment.name,
        expectedPath,
      });
      RUNTIME.docFull += 1; // W4：本次确实整读了原文/附件复核
    } catch (e) {
      RUNTIME.docFull += 1; // 复核尝试过（异常也是真读过）
      // 复核本身异常也绝不能当绑定；落缺凭证 + 机器码
      const problems = normalizeIntegrityProblems(['FILE_HASH_MISMATCH']);
      const r = out('missing', '', '', problems,
        { code: rec.code, problems, error: String(e && e.message || e) }, 'full');
      docCacheSet(verifyKey, r);
      return r;
    }
    const problems = v.ok ? [] : normalizeIntegrityProblems(v.problems);
    let r;
    if (v.ok) {
      r = out('bound', rec.doc, '', [], null, 'full');
    } else if (!v.exists && cleanedReport) {
      // 复核失败：文件不在 + 清册有据 → 合法清理（不进 integrityFailures）
      r = out('cleaned', '', cleanedReport, [], null, 'full');
    } else {
      r = out('missing', v.exists ? rec.doc : '', '', problems, { code: rec.code, problems }, 'full');
    }
    docCacheSet(verifyKey, r);
    return r;
  }

  // ② 无 doc 指针：按编码推算文件在 → 补记（不 claim 绑定）
  if (computed && root) {
    try {
      if (fs.existsSync(path.join(root, computed))) return out('backfilled', computed, '', [], null);
    } catch { /* 当作不存在 */ }
  }
  // ③ 文件不在：清册有据 → 已清理
  if (cleanedReport) return out('cleaned', '', cleanedReport, [], null);
  // ④ 缺凭证（未声明绑定，不算完整性失败）
  return out('missing', '', '', [], null);
}

/**
 * 凭证四态 → 十列「原始凭证」列的唯一中文口径（半角括号，契约 WK-17/WK-27）。
 * 已清理必须带清册编号（`已清理(RPT-20261108-01)`），否则事后无法证明是合法销毁。
 */
export function originalLabel(st) {
  switch (st && st.state) {
    case 'bound': return '绑定';
    case 'backfilled': return '补记';
    case 'cleaned': return `已清理(${st.report || 'RPT-？'})`;
    default: return '缺凭证';
  }
}

/** 台账 status → 状态列默认值（决定 9 #17）：ok→已完成；partial→待确认；其余由人改，机器先给「待确认」。 */
export function statusDefault(rec) {
  if (rec && rec.status === 'ok') return '已完成';
  return '待确认';
}

/** 从 32 位编码取 13 位会话键 `{S}{D}`；非法编码返回空串。 */
export function sessKeyOf(code) {
  const p = parseCode(String(code || ''));
  return p ? `${p.s12}${p.gen}` : '';
}

/** 一组（会话键 + 周段）的稳定标识，用于缓存比对 / 封板状态键。 */
export function groupId(w, sessKey) {
  return `${w.year}-${String(w.month).padStart(2, '0')}-${w.weekNo}|${sessKey}`;
}

/** 会话键合法形状：13 位 = 12 位短 ID（[0-9a-z]）+ 1 位代次（[A-Z]）。 */
const SESS_KEY_RE = /^[0-9a-z]{12}[A-Z]$/;

/**
 * `writeWeekly` 入参形状校验（审计② P2-14）。
 *
 * @returns {string[]} 错误清单（空数组 = 通过）
 *
 * @why w 正常只来自 `weekOf()`/`groupRecords()`，但 `writeWeekly` 是导出 API：
 *      旧实现不校验，`w={}` 会落出 `undefined年undefined月/草稿-undefined月第undefined周-…xlsx`，
 *      `gid` 变成 `undefined-undefined-undefined|undefined` 并被写进封板 journal ——
 *      半成品进了证据链比"没写"更糟（journal 一旦认了，该组永久 skip）。
 *      所以形状非法必须在**算任何路径之前**拒绝，且一个文件都不许写。
 */
function validateWeeklyWriteArgs({ root, w, sessKey, offsetMinutes, graceDays } = {}) {
  const errors = [];
  if (typeof root !== 'string' || root.length === 0) errors.push('root 必须是非空字符串');
  if (!w || typeof w !== 'object' || Array.isArray(w)) {
    errors.push('w 必须是对象（weekOf() 的返回）');
  } else {
    if (!Number.isInteger(w.year) || w.year < 1970 || w.year > 9999) errors.push('w.year 必须是 1970–9999 的整数');
    if (!Number.isInteger(w.month) || w.month < 1 || w.month > 12) errors.push('w.month 必须是 1–12 的整数');
    // 月内周数 ∈ {4,5,6}（week.js 口径），1–6 是合法上界
    if (!Number.isInteger(w.weekNo) || w.weekNo < 1 || w.weekNo > 6) errors.push('w.weekNo 必须是 1–6 的整数');
  }
  if (typeof sessKey !== 'string' || !SESS_KEY_RE.test(sessKey)) {
    errors.push('sessKey 必须是 13 位 {12位短ID}{A–Z 代次}（如 75238718e41aA）');
  }
  if (!Number.isFinite(offsetMinutes)) errors.push('offsetMinutes 必须是有限数字');
  if (!Number.isFinite(graceDays) || graceDays < 0) errors.push('graceDays 必须是 >=0 的有限数字');
  return errors;
}

// ============================================================================
// 三、时间/标签小工具（全系统固定 +08:00；产物里不许出现 Z 结尾时间）
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

/** 毫秒 → `YYYY-MM-DD HH:MM:SS`（+08:00 本地口径；契约 WK-05/WK-36 的格式）。 */
function localStamp(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * 把 generatedAt / sealedAt 归一成 `YYYY-MM-DD HH:MM:SS`。
 * 接受毫秒数、本地时间串、ISO 串（含 T/偏移）；非法时用 fallbackMs（默认现在）。
 */
function stampOf(value, offsetMinutes, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) return localStamp(value, offsetMinutes);
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return localStamp(ms, offsetMinutes);
  }
  return localStamp(Number.isFinite(fallbackMs) ? fallbackMs : Date.now(), offsetMinutes);
}

/** 毫秒 → `YYYY-MM-DD`（按 offsetMinutes）。 */
function dateLabel(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 毫秒 → `YYYYMMDD`（按 offsetMinutes），补记册文件名用。 */
function dateStamp(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** 毫秒 → `HH:MM`（按 offsetMinutes）。 */
function timeLabel(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 周一 … 周日

/** 某毫秒在 UTC+08:00 下的星期索引（0=周日）。 */
function weekdayOf(ms, offsetMinutes) {
  return new Date(ms + offsetMinutes * 60 * 1000).getUTCDay();
}

// ============================================================================
// 四、清册解析（兼容 v1.3 新格式 + v0.4 旧格式）
// ============================================================================

/**
 * 读清册：`RPT-YYYYMMDD-NN.md` → `Map<编码, 清册编号>`，**只认结论列=已删除**（P1-10）。
 *
 * @why 为什么按"结论列"判定而不是"任意单元格含已删除"：
 *      审计发现 v0.4 实现会把**备注里出现"已删除"**的行也当成已清理（备注可能写
 *      "未删除，因…"或"已删除后又恢复"），导致四态误判。正确口径是：先按表头定位
 *      「结论」列（v1.3 新 schema）或「结果」列（v0.4 旧 schema），只取该列的值；
 *      结论 ∈ {未删除, 跳过} 一律**不进** Map。
 *
 * @why 为什么还要兼容旧格式：
 *      历史清册仍在目录里；不解析它们会把"已清理"误判成"缺凭证"（决定 9 #15 / R25）。
 *      v1.3 新表头：`| # | 编码 | 产生时间（UTC+08:00） | 结论 | 备注 |`
 *      v0.4 旧表头：`| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |`
 *
 * 解析策略（逐文件）：
 *   ① 扫描 `|` 表格行，找含「编码」且含「结论」或「结果」的表头 → 记录 编码列 / 结论列下标；
 *   ② 表头之后的数据行：取 编码列 与 结论列；结论（去 markdown 记号/空白）= `已删除` 才入册；
 *   ③ 找不到表头（手工/截断文件）：回退到"严格结构"判定——v1.3 行第 4 格=已删除、
 *      v0.4 行第 5 格=`已删除`，绝不退回"任意单元格"判定。
 *
 * @param {string} root 数据总库根目录
 * @returns {Map<string,string>} 编码 → 清册编号（如 RPT-20261108-01）
 */
export function readCleanedCodesCompat(root) {
  const map = new Map();
  if (!root) return map;
  // 1) lite：不再读 cleanup.js 的基础实现（该模块已冻结，lite 不做销毁 → 无"已删除"标记）。
  //    下面仍保留对 RPT-*.md 清册的直接只读扫描：万一历史库里留有清册，仍能识别（零依赖）。

  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch { return map; }
  const CODE_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;
  const cleanCell = (s) => String(s == null ? '' : s).replace(/[`*]/g, '').trim();

  for (const n of names) {
    if (!/^RPT-\d{8}-\d{2}\.md$/.test(n)) continue; // dry-run 清册不参与
    let text = '';
    try { text = fs.readFileSync(path.join(root, n), 'utf8'); } catch { continue; }
    const reportId = n.replace(/\.md$/, '');

    // 表头定位（同一文件可能有多张表；逐表头切换映射，只认同时含 编码 + 结论/结果 的表）
    let header = null; // {codeIdx, verdictIdx}
    let sawAnyHeader = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map(cleanCell);
      const codeIdx = cells.indexOf('编码');
      const vIdx = cells.indexOf('结论') >= 0 ? cells.indexOf('结论') : cells.indexOf('结果');
      if (codeIdx >= 0 && vIdx >= 0) {
        header = { codeIdx, verdictIdx: vIdx };
        sawAnyHeader = true;
        continue;
      }
      if (!header) continue;
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
      const code = cells[header.codeIdx] || '';
      const verdict = cells[header.verdictIdx] || '';
      if (!CODE_RE.test(code)) continue;
      if (verdict === '已删除') map.set(code, reportId);
    }
    if (sawAnyHeader) continue;

    // 回退：无表头文件按"严格结构"判（新 schema 第 4 格 / 旧 schema 第 5 格必须恰为 已删除）
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map(cleanCell);
      if (cells.length < 4) continue;
      const code = cells.find((c) => CODE_RE.test(c)) || '';
      if (!code) continue;
      const strictNew = cells.length >= 5 && cells[3] === '已删除' && CODE_RE.test(cells[1] || '');
      const strictOld = cells.length >= 6 && cells[0] === code && cells[4] === '已删除';
      if (strictNew || strictOld) map.set(code, reportId);
    }
  }
  return map;
}

// ============================================================================
// 五、采集：台账记录 → 7 个日桶（含四态判定与溢出计数）
// ============================================================================

/** 台账记录按时间升序（同刻按编码升序，保证可重跑顺序一致）。 */
function sortRecords(records) {
  return [...(Array.isArray(records) ? records : [])]
    .filter((r) => r && typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts)))
    .sort((a, b) => {
      const ta = Date.parse(a.ts), tb = Date.parse(b.ts);
      if (ta !== tb) return ta - tb;
      return String(a.code).localeCompare(String(b.code));
    });
}

/**
 * 按 code 去重（**不做 version/supersede** —— v0.5 D10 改为 pending-only：
 * 未闭合轮不写台账、闭合后正常入账，因此台账里同一 code 只应有一条）。
 *
 * @why 为什么仍要按 code 去重：防调用方把同一批记录传两遍（幂等闸），
 *      也让"一行 = 一条台账记录"在异常入参下仍成立。
 * @returns {{records:Array, duplicateSameCode:number}}
 */
export function dedupeRecordsByCode(records) {
  const byCode = new Map();
  let duplicateSameCode = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.code !== 'string' || !r.code) continue;
    if (byCode.has(r.code)) { duplicateSameCode += 1; continue; }
    byCode.set(r.code, r);
  }
  return { records: [...byCode.values()], duplicateSameCode };
}

/**
 * 把本组记录落到 7 个日桶（周一…周日）。
 *
 * @returns {{days:Array, warnings:Array, overflow:number, total:number}}
 *
 * @why 日桶固定 7 个、顺序固定：记账凭证版式要稳定，审计翻到"周三"就知道看哪页。
 *      空日/短周：日表 A 列全空（**禁止占位行**，否则污染 COUNTA），周统计 B 列写 `—`。
 * @why gid（0.9.4-snap W2）：带组标识就把"行身份未变"的结论缓存到行级复用表；
 *      身份变了（新行/原文或附件被动过/清册结论变了）才重新走 resolveDoc。
 *      缓存只复用"结论"，日桶每次都按**全量记录**重建 —— 所以增量算出来的 xlsx
 *      与从零全量重算逐字节一致（自测 `docs/自测-weekly-滚动.mjs` 反证）。
 */
function collectDays({ root = '', w, records, offsetMinutes = 480, cleaned, gid }) {
  const cleanedMap = cleaned !== undefined
    ? cleaned
    : (root ? readCleanedMapCached(root) : null);
  const bucket = root && gid ? rowCacheBucket(root, gid) : null;

  const days = WEEKDAY_ORDER.map((dow) => ({ dow, weekday: WEEKDAY_NAMES[dow], date: '', entries: [] }));
  const byDow = new Map(days.map((d) => [d.dow, d]));

  // 本段内每个星期几对应的日期（段短时可能缺某些星期）
  for (let ms = w.startMs; ms <= w.endMs; ms += DAY_MS) {
    const d = byDow.get(weekdayOf(ms, offsetMinutes));
    if (d && !d.date) d.date = dateLabel(ms, offsetMinutes);
  }

  const warnings = [];
  const integrityFailures = [];
  let overflow = 0;
  // 按 code 去重（防同一批记录被传两遍；D10 pending-only 下台账同一 code 只应有一条）
  const deduped = dedupeRecordsByCode(records);
  const seenCodes = new Set();
  let duplicates = deduped.duplicateSameCode;
  for (const rec of sortRecords(deduped.records)) {
    const code = String(rec.code || '');
    if (seenCodes.has(code)) { duplicates += 1; continue; }
    seenCodes.add(code);
    const ms = Date.parse(rec.ts);
    // 防御：不属于本段的记录不落表（正常由 groupRecords 保证）
    if (ms < w.startMs || ms > w.endMs) continue;
    const d = byDow.get(weekdayOf(ms, offsetMinutes));
    if (!d) continue;
    RUNTIME.rowSeen += 1;
    let cell = null;
    if (bucket) {
      const sig = rowSignature(root, rec, offsetMinutes, cleanedMap);
      const hit = bucket.rows.get(code);
      if (hit && hit.sig === sig) {
        // W2/W4：身份未变 → 复用上次的「原始凭证」判定（不 stat 之外不再碰磁盘，也不读原文）
        cell = hit;
        RUNTIME.rowReused += 1;
      } else {
        const doc = resolveDoc(root, rec, offsetMinutes, cleanedMap);
        cell = {
          sig,
          entry: {
            code,
            original: originalLabel(doc),
            time: timeLabel(ms, offsetMinutes),
            statusDefault: statusDefault(rec),
            doc,
          },
          integrity: doc.integrity && Array.isArray(doc.integrity.problems) && doc.integrity.problems.length
            ? doc.integrity : null,
        };
        bucket.rows.delete(code);
        bucket.rows.set(code, cell);
        while (bucket.rows.size > ROW_CACHE_MAX_ROWS) {
          const oldest = bucket.rows.keys().next().value;
          if (oldest === undefined) break;
          bucket.rows.delete(oldest);
        }
        RUNTIME.rowResolved += 1;
      }
    } else {
      const doc = resolveDoc(root, rec, offsetMinutes, cleanedMap);
      cell = {
        sig: '',
        entry: {
          code,
          original: originalLabel(doc),
          time: timeLabel(ms, offsetMinutes),
          statusDefault: statusDefault(rec),
          doc,
        },
        integrity: doc.integrity && Array.isArray(doc.integrity.problems) && doc.integrity.problems.length
          ? doc.integrity : null,
      };
    }
    if (cell.integrity) integrityFailures.push(cell.integrity);
    d.entries.push(cell.entry);
  }
  if (duplicates > 0) {
    warnings.push({
      type: 'duplicate-code',
      dropped: duplicates,
      message: `weekly: duplicate codes dropped=${duplicates}（按编码去重，一条只落一行）`,
    });
  }

  // 溢出：单日上限 120 行 → 只落前 120 行；**溢出行保留完整内容**（P0-4：封板前要有去向），
  // 计数写周统计 C13 + 告警，但绝不静默丢行。
  for (const d of days) {
    if (d.entries.length > DAILY_CAPACITY) {
      d.overflowEntries = d.entries.slice(DAILY_CAPACITY);
      const dropped = d.overflowEntries.length;
      d.dropped = dropped;
      d.entries = d.entries.slice(0, DAILY_CAPACITY);
      overflow += dropped;
      warnings.push({
        type: 'overflow',
        day: d.weekday,
        date: d.date,
        dropped,
        message: `weekly overflow day=${d.date} dropped=${dropped}`,
      });
    } else {
      d.overflowEntries = [];
    }
  }

  const total = days.reduce((a, d) => a + d.entries.length, 0);
  // sourceRowCount = 本组台账源行数（正册行 + 溢出）；P0-4 的 canonical 必须含它
  return { days, warnings, overflow, total, sourceRowCount: total + overflow, duplicates, integrityFailures };
}

// ============================================================================
// 六、封板 hash（只覆盖机器列；可独立复算）
// ============================================================================

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 补记引用（P0-4）：把「被单日 120 行上限挤出正册的溢出行」按落盘顺序取出编码。
 *
 * @why 为什么要进 canonical：
 *      审计发现 v0.4 的封板 hash 只覆盖正册行；源 120/121/122 条时正册都是同样的 120 行，
 *      三个封板 hash 完全相同 → "封板证明失效"、溢出编码既不在正册也不在补记册。
 *      v0.5 要求：溢出编码**封板前先写补记册**，且 canonical 必须引用它们
 *      （`supplementCodesSha256`），才能保证"同为 N 条但溢出集合不同"也能区分。
 */
export function buildSupplementRef(days) {
  const codes = [];
  for (const d of days || []) {
    for (const e of d.overflowEntries || []) codes.push(e.code);
  }
  return { codes };
}

/** 从日桶推导「源行数 / 溢出数」（没有 overflowEntries 时回退到 dropped 计数）。 */
function sourceCountsOf(days) {
  let overflow = 0;
  for (const d of days || []) {
    overflow += Array.isArray(d.overflowEntries) ? d.overflowEntries.length : (Number(d.dropped) || 0);
  }
  let rowCount = 0;
  for (const d of days || []) rowCount += (d.entries || []).length;
  return { rowCount, overflow, sourceRowCount: rowCount + overflow };
}

/** 把日桶展平成落盘行序的 4 元组：[编码, 原始凭证, hh:mm, 状态]。 */
function flattenSealRows(days) {
  const rows = [];
  for (const d of days || []) {
    for (const e of d.entries || []) rows.push([e.code, e.original, e.time, e.statusDefault]);
  }
  return rows;
}

/**
 * 封板 hash 的 canonical —— **唯一公式实现点在 `lib/sealjournal.js: weeklyCanonical()`**
 * （决定 D12 v1.1 / D15；canonicalVersion = 8，含 `supplementCodesSha256`）。
 *
 * weekly 侧只负责：把日桶展平成落盘行序 + 汇总 sourceRowCount/overflow + 溢出编码集合，
 * 然后委托给 sealjournal 计算，避免"实现/验收各算各的"。
 *
 * @returns {{canonical:string, sealHash:string, rows:string[][],
 *            supplementCodes:string[], sourceRowCount:number, overflow:number, rowCount:number}}
 */
export function weeklySealBody({ w, sessKey, offsetMinutes = 480, days, sourceRowCount, overflow, supplement }) {
  const rows = flattenSealRows(days);
  const counts = sourceCountsOf(days);
  const ov = Number.isFinite(overflow) ? Number(overflow) : counts.overflow;
  const src = Number.isFinite(sourceRowCount) ? Number(sourceRowCount) : rows.length + ov;
  const supp = supplement || buildSupplementRef(days);
  const supplementCodes = Array.isArray(supp.codes) ? supp.codes.slice() : [];
  const canonical = weeklyCanonical({
    sessKey: sessKey || '',
    year: w.year,
    month: w.month,
    weekNo: w.weekNo,
    offsetMinutes,
    sourceRowCount: src,
    overflow: ov,
    rows,
    supplementCodes,
  });
  return {
    canonical,
    sealHash: journalSha256Hex(canonical),
    rows,
    supplementCodes,
    sourceRowCount: src,
    overflow: ov,
    rowCount: rows.length,
  };
}

/** 正文数据指纹 = **封板 hash**（64 位小写 hex；公式见 sealjournal.weeklyCanonical）。 */
export function bodyFingerprint({ w, sessKey, offsetMinutes = 480, days, sourceRowCount, overflow, supplement }) {
  return weeklySealBody({ w, sessKey, offsetMinutes, days, sourceRowCount, overflow, supplement }).sealHash;
}

/**
 * 内容指纹（草稿"内容没变就不重写"用）：封板 canonical + 版式版本。
 * @why 版式版本只进内容指纹、不进封板 hash：封板文件永不重写，hash 不能被未来版式升级改口径。
 */
export function contentFingerprint({ w, sessKey, offsetMinutes = 480, days, sourceRowCount, overflow, supplement }) {
  const body = weeklySealBody({ w, sessKey, offsetMinutes, days, sourceRowCount, overflow, supplement });
  return journalSha256Hex(`layout=${LAYOUT_VERSION}\n${body.canonical}`);
}

/**
 * 独立复算某组周记账的**封板 hash**（审计/自测用；只读、不落盘、不依赖生成时间）。
 *
 * @why P0-4 后必须能"从台账 + 清册复算"：溢出编码先写补记册，集合摘要进 canonical；
 *      溢出集合可由台账记录确定性重建，所以不读补记册也能得到同一 hash。
 * @returns {string} sha256
 */
export function computeWeeklyFingerprint({ root = '', w, sessKey, records, offsetMinutes = 480, cleaned }) {
  const collected = collectDays({
    root, w, records, offsetMinutes, cleaned, gid: groupId(w, sessKey),
  });
  return bodyFingerprint({
    w, sessKey, offsetMinutes, days: collected.days,
    sourceRowCount: collected.sourceRowCount, overflow: collected.overflow,
  });
}

// ============================================================================
// 七、渲染：说明页 + 7 张日表 + 周统计页
// ============================================================================

/** 说明页（A1:G54，逐单元格按《模板-周记账-十列-v1.3》第三节）。 */
function renderInfoSheet({ w, sessKey, days, offsetMinutes, generatedAt, mode, sealedAt, sealHash, total }) {
  const sealed = mode === 'sealed';
  const rows = [];
  const merges = [];
  /** 整行合并 A{r}:G{r}（标题/文件头/章节标题等长文本行）。 */
  const full = (text) => {
    rows.push([text]);
    merges.push(`A${rows.length}:G${rows.length}`);
  };
  /** 约定/规则行：A=序号或圆点，B:G 合并放正文。 */
  const bullet = (mark, text) => {
    rows.push([mark, text]);
    merges.push(`B${rows.length}:G${rows.length}`);
  };
  /** 7 列表格行（字段定义表）。 */
  const seven = (a, b, c, d, e, f, g) => rows.push([a, b, c, d, e, f, g]);
  const blank = () => rows.push([]);

  // ---- 文件头（A1~A6）----
  full('周记账模板 v1.3');
  full(`生成时间 ${generatedAt}（UTC+08:00） · 结构：1 页说明 + 7 日明细（每日 120 行）+ 1 页周统计 · 编码规则见《模板-编码规范.md》`);
  full(sealed ? SEALED_STATUS_TEXT : DRAFT_STATUS_TEXT);
  full(sealed ? `封板hash: ${sealHash}` : '封板hash: —');
  full(sealed ? `封板时间: ${sealedAt}（UTC+08:00）` : '封板时间: —');
  full(`会话键: ${sessKey} ｜ 周段: ${dateLabel(w.startMs, offsetMinutes)} ~ ${dateLabel(w.endMs, offsetMinutes)} ｜ 所属月份: ${w.year}年${pad2(w.month)}月 ｜ 周序: 第${w.weekNo}周 ｜ 记录数: ${total} ｜ 生成器: ${GENERATOR}`);
  blank(); // A7

  // 说明页正文一律用"渲染后的纯文本"：契约文档里的 markdown 强调/行内代码标记（**、`）
  // 是排版记号，不是单元格内容；进 xlsx 前统一剥掉。
  const inline = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '');

  // ---- 一、填写约定（A8 标题 / A9:A17 九条；逐字按最终模板 3.2）----
  full('一、填写约定');
  const RULES = [
    '一行一次交互；同日多轮按时间升序，不合并单元格。',
    '编码为 32 位固定格式，全局唯一，一经生成不得改写、重发、复用；详见《模板-编码规范.md》。',
    '时间只填 hh:mm（24 小时制）；**行的日期归属看「周统计」B 列与所在日表（按记录 ts 所在日）**，不重复填日期；★ 编码前 8 位是**会话开始日**，不等于本行日期（跨天会话必然不同）；跨零点归入开始日。',
    '同一会话内的先后看序号段；跨会话只能看时间，同一分钟内无法分辨先后。',
    '摘要 ≤80 字，写结论与意图；需要原文另存，不在账本里贴。',
    '角色、状态、用户审计三列一律用下拉，不手打，保证后续可统计。',
    '空值统一填 —，不留空白、不留空格；不确定的写「待确认」并在备注说明。',
    '本表只记账，不存储原文；原文按 Turn 存文件，文件名 = 编码 + 「 完整原文.md」。',
    '「周统计」B 列的日期必须填，它是当日 sheet 的日期锚点，锚点 = 该行记录时间（ts）在 +08:00 下的日期；编码前 8 位是**会话开始日**，不是本行日期。',
  ];
  RULES.forEach((t, i) => bullet(`${i + 1}.`, inline(t)));
  blank(); // A18

  // ---- 二、字段定义（A19 标题 / A20 表头 / A21:A30 十列）----
  full('二、字段定义');
  seven('列', '字段', '谁填', '必填', '类型', '枚举 / 格式', '说明');
  COLUMNS.forEach((c, i) => seven(String.fromCharCode(65 + i), c.name, c.by, c.required, c.type, c.format, c.desc));
  blank(); // A31

  // ---- 三、编码规则（A32 标题 / A33:A40 八条；逐字按最终模板 3.4）----
  full('三、编码规则');
  const CODE_RULES = [
    '格式 `YYYYMMDD-SSSSSSSSSSSS-D-NNNNNNNN`，共 32 位，三个半角连字符分隔。',
    '示例 `20261107-75238718e41a-B-00000001`（2026-11-07 / 会话 75238718e41a / 代差 B / 会话内第 1 条）；★ 编码日期段 = **会话开始日**（+08:00 切日），不是该行发生日；跨天会话的所有行共享同一日期段。',
    '代差为大写字母 A–Z，单字符；小写视为编码不规范（**仅写数据验证；未实现条件格式，不自动拦截、不自动标色**）。',
    '序号是会话内计数：每个会话从 `00000001` 起，8 位左补零；新会话重新从 `00000001` 开始。',
    '一个 Turn 一个文件，文件名 = `<编码> 完整原文.md`；同一会话的多个 Turn 共享编码前 24 位。',
    'Session 段必须归一化：去掉非字母数字 → 取前 12 位 → 小写。原始 ID 带 `session-` 前缀与连字符，直取会切碎分段。',
    'A 列已内置数据验证（编码格式校验表达式）；**本表未实现条件格式，不会自动拦截输入、也不会自动标色**；数据是否合规以上述格式为准，请勿手改编码。',
    '整条编码排序 = 按会话归集，不是时间线；会话内用序号段，跨会话用「时间」列。',
  ];
  CODE_RULES.forEach((t) => bullet('·', inline(t)));
  blank(); // A41

  // ---- 四、状态与封板（A42 标题 / A43:A49 七条；逐字按《模板-周记账-十列-v1.3》3.5）----
  full('四、状态与封板（v1.3 新增）');
  const STATE_RULES = [
    '本表只有两态：**草稿** 与 **已封板**；状态写在说明页 A3，封板 hash 写在 A4。',
    '草稿：周进行中，插件每轮**可**重生成（内容指纹未变时跳过写盘）；★ **请勿批注，封板后方可批注**。',
    '已封板：该周最后一天结束 + **3 天宽限**（或 user 人工触发）后首次生成时封板；**插件永不重写本文件**。',
    '封板状态同时记录在封板日志（`ledger/.seal-journal.jsonl`，权威证据）与插件运行状态（缓存）中，文件头（说明页）可搬、可人读；三者不一致时以封板日志为准。',
    '封板后才发现的行 → 写入一级目录《补记-YYYYMMDD.md》另册，永久保存，**不改本册**。',
    '单日超过 120 轮：本册只写前 120 行（按时间升序），溢出条数记入「周统计」页「溢出」行并告警。',
    '空值统一填 `—`；机器未填的人工列也先以 `—` 占位，人来改写。',
  ];
  STATE_RULES.forEach((t, i) => bullet(`${i + 1}.`, inline(t)));
  blank(); // A50

  // ---- 五、已定口径（A51 标题 / A52:A54 三条；决定 9 #20，逐字按最终模板 3.6）----
  full('五、已定口径（v1.3）');
  const SETTLED = [
    '**序号的边界**：编码序号是**会话内计数**（每个会话从 `00000001` 起，新会话重新开始）；同日不同会话各自从 `00000001` 起，靠 Session 段区分。',
    '**时间精度**：本表时间只到 `hh:mm`（24 小时制）；同一分钟内多条按编码序号段定先后；本表不承载秒级证据（秒级在完整原文/台账 jsonl）。',
    '**文件名中的周次**：保留 `MM月第W周-{S}{D}的周记账.xlsx`，不裁掉「周次」；周次由**记录 ts 所在周段**（月内周）决定；编码前 8 位是**会话开始日**，二者不是同一日期口径，**不可互相校验**、也不合并。',
  ];
  SETTLED.forEach((t, i) => bullet(`${i + 1}.`, inline(t)));

  return {
    name: '说明',
    rows,
    merges,
    cols: [10, 24, 8, 8, 10, 30, 60],
    gridLines: false,
  };
}

/** 日表：表头 + 机器行 + 预置 120 行；挂编码校验与三组下拉。 */
function renderDaySheet(day) {
  const header = TEN_COLUMNS.slice();
  const dataRows = day.entries.map((e) => [
    e.code,          // A 编码
    e.original,      // B 原始凭证（四态）
    e.time,          // C 时间
    EMPTY,           // D 角色（人）
    EMPTY,           // E 对话内容摘要（人）
    EMPTY,           // F User的文件引用与Agent文件输出（人）
    EMPTY,           // G 输出文件位置（人）
    e.statusDefault, // H 状态（机器先填默认值）
    AUDIT_PENDING,   // I 用户审计（机器填待审）
    EMPTY,           // J 备注（人）
  ]);
  const rows = [header, ...dataRows];
  for (let i = dataRows.length; i < DAILY_CAPACITY; i++) rows.push([]); // 预置空行（A2:J121）

  return {
    name: day.weekday,
    rows,
    cols: [34, 16, 10, 9, 26, 32, 26, 10, 10, 22],
    freeze: true,
    padCols: TEN_COLUMNS.length, // 空行也写满 10 个空单元格，used range 才是 A1:J121
    autoFilter: `A1:${colName(TEN_COLUMNS.length)}${DAILY_CAPACITY + 1}`,
    dataValidations: weeklyDataValidations(),
    printOptions: { horizontalCentered: true },
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToHeight: 0 },
    dimension: `A1:J${DAILY_CAPACITY + 1}`,
  };
}

/** 周统计页（A1:F13，逐单元格按《模板-周记账-十列-v1.3》第五节）。 */
function renderStatsSheet({ days, overflow }) {
  const rows = [];
  const merges = [];
  const full = (text) => { rows.push([text]); merges.push(`A${rows.length}:F${rows.length}`); };

  full('周统计');
  full('随日明细自动汇总；公式引用 A2:A121，扩行后需同步调整。');
  rows.push([]); // 第 3 行空
  rows.push(['星期', '日期', '记录数', '审计通过', '审计未通过', '待审']); // 第 4 行表头

  // 第 5–11 行：周一…周日。B 列日期是当日 sheet 的日期锚点；不在本段写 —。
  const first = rows.length + 1; // 5
  for (const d of days) {
    const n = d.entries.length;
    rows.push([
      d.weekday,
      d.date || '—',
      { f: `COUNTA(${d.weekday}!$A$2:$A$121)`, v: n },
      { f: `COUNTIF(${d.weekday}!$I$2:$I$121,"通过")`, v: 0 },
      { f: `COUNTIF(${d.weekday}!$I$2:$I$121,"不通过")`, v: 0 },
      { f: `COUNTIF(${d.weekday}!$I$2:$I$121,"待审")`, v: n },
    ]);
  }
  const last = rows.length; // 11
  const total = days.reduce((a, d) => a + d.entries.length, 0);
  rows.push([
    '合计',
    '—',
    { f: `SUM(C${first}:C${last})`, v: total },
    { f: `SUM(D${first}:D${last})`, v: 0 },
    { f: `SUM(E${first}:E${last})`, v: 0 },
    { f: `SUM(F${first}:F${last})`, v: total },
  ]);
  // 第 13 行：溢出（数字字面量，非公式；无溢出为 0）
  rows.push(['溢出（未写入本册）', '—', overflow, '—', '—', '—']);

  return {
    name: '周统计',
    rows,
    merges,
    cols: [10, 18, 10, 10, 12, 10],
    gridLines: false,
  };
}

/** 渲染 9 张表（说明 / 周一…周日 / 周统计）。 */
function renderSheets({ w, sessKey, days, offsetMinutes, generatedAt, mode, sealedAt, sealHash, overflow, warnings }) {
  const total = days.reduce((a, d) => a + d.entries.length, 0);
  const sheets = [
    renderInfoSheet({ w, sessKey, days, offsetMinutes, generatedAt, mode, sealedAt, sealHash, total }),
    ...days.map(renderDaySheet),
    renderStatsSheet({ days, overflow }),
  ];
  if (Array.isArray(warnings) && warnings.length) sheets.warnings = warnings;
  return sheets;
}

// ============================================================================
// 八、对外构建 API（不落盘，自测/审计用）
// ============================================================================

/**
 * 构建一组周记账的完整模型（不落盘）。
 *
 * @returns {{sheets:Array, hash:string, sealHash:string, days:Array, warnings:Array,
 *            overflow:number, total:number, mode:'draft'|'sealed', sealedAt:string, generatedAt:string}}
 */
export function buildWeeklyModel(p = {}) {
  const {
    root = '', w, sessKey, records = [], offsetMinutes = 480,
    generatedAt, mode = 'draft', sealedAt, cleaned,
  } = p;
  const now = Date.now();
  const stamp = stampOf(generatedAt, offsetMinutes, now);
  const collected = collectDays({
    root, w, records, offsetMinutes, cleaned, gid: groupId(w, sessKey),
  });
  if (collected.integrityFailures.length > 0) {
    const integWarn = {
      type: 'integrity-failures',
      entries: collected.integrityFailures,
      message: `weekly: integrity failures=${collected.integrityFailures.length}（绑定复核未通过，已落缺凭证）`,
    };
    collected.warnings = [...collected.warnings, integWarn];
  }
  const body = weeklySealBody({ w, sessKey, offsetMinutes, days: collected.days });
  const sealHash = body.sealHash;
  const hash = journalSha256Hex(`layout=${LAYOUT_VERSION}\n${body.canonical}`);
  const effMode = mode === 'sealed' ? 'sealed' : 'draft';
  const effSealedAt = effMode === 'sealed' ? stampOf(sealedAt, offsetMinutes, now) : '';
  const sheets = renderSheets({
    w, sessKey, days: collected.days, offsetMinutes, generatedAt: stamp,
    mode: effMode, sealedAt: effSealedAt, sealHash,
    overflow: collected.overflow, warnings: collected.warnings,
  });
  return {
    sheets, hash, sealHash, days: collected.days, warnings: collected.warnings,
    overflow: collected.overflow, total: collected.total,
    sourceRowCount: collected.sourceRowCount,
    supplementCodes: body.supplementCodes,
    integrityFailures: collected.integrityFailures,
    mode: effMode, sealedAt: effSealedAt, generatedAt: stamp,
  };
}

/**
 * 兼容旧调用：只返回 sheets（说明 / 周一…周日 / 周统计），参数同 buildWeeklyModel。
 * @returns {Array<{name:string, rows:any[][]}>}
 */
export function buildSheets(p = {}) {
  return buildWeeklyModel(p).sheets;
}

// ============================================================================
// 九、封板证据：唯一追加式 seal journal（P1-9 / P0-4）
//
// 证据链（高 → 低）：
//   ① `<root>/ledger/.seal-journal.jsonl` —— **唯一写者 lib/sealjournal.js**；
//      append-only + fsync + prevSealSha256 成链；行内自带 rows + rowsSha256
//      = P0-4 的不可变 sealRows 快照（**不另写 `ledger/seals/` 第二份**）。
//   ② `<root>/ledger/.state.json` 的 weeklySealed —— 缓存，丢了只影响性能。
//   ③ 已封板 xlsx 说明页文件头 —— 可搬、可人读。
// journal 为权威：state 与 journal 冲突 → 报 SEAL_MISMATCH、不自动改 state。
// ============================================================================

/**
 * 读 journal 原始状态（空册与读失败可区分；坏行/断链也报出来）。
 *
 * ★ 0.9.4-snap（W1/W5）：返回的是**缓存索引** ——
 *   · `events` 是**摘要事件数组**（每个事件的 rows 数组被剥掉，只留 rowCount/rowsSha256 等），
 *     所以 174 MB journal 不会把 20k 组 ×120 行的快照堆进内存；
 *   · 稳态调用只 stat + 读新增字节；文件缩水/被替换才整读重建。
 *   需要的调用方若要看逐行 rows，请直接用 `lib/sealjournal.js: readSealEvents()`（KERNEL 只读接口）。
 */
export function readSealJournalState(root) {
  const j = journalIndexFor(root);
  return { ...j, path: j.path };
}

/**
 * 读封板状态：**journal 优先，缺则回退 state 缓存**（P1-9）。
 * 返回形状保持 `{gid: {sealedAt, sealHash, file, layout, rows, ...}}`（向后兼容）。
 *
 * ★ W1：内部用合并视图缓存（journal 尾读缓存 + state stat 指纹），返回浅拷贝，
 *   调用方可以安全改自己拿到的那一层对象。
 */
export function readWeeklySeals(root) {
  if (!root) return {};
  return { ...weeklySealsView(root) };
}

/** 从封板信息映射取一组的封板信息；没有返回 null（兼容早期字段名 hash）。 */
export function sealInfoOf(seals, gid) {
  const v = seals && seals[gid];
  if (!v || typeof v !== 'object') return null;
  const sealHash = v.sealHash || v.hash || '';
  if (!sealHash && !v.sealedAt) return null;
  return { ...v, sealHash: String(sealHash), sealedAt: String(v.sealedAt || '') };
}

/** 读一组的封板信息（journal/state；没有返回 null）。 */
export function readWeeklySeal(root, gid) {
  return sealInfoOf(readWeeklySeals(root), gid);
}

/**
 * 查封板证据全貌（journal 权威 + state 缓存 + 链校验；冲突只报不修）。
 * @returns {{seals:object, conflicts:Array, journal:object, chain:object, stateCount:number}}
 *
 * @why 给 index/reconcile 用：conflicts 应落 errors（SEAL_MISMATCH），
 *      chain.ok=false 必须报出（坏行/断链），但都**不修改**任何文件。
 * @why 0.9.4-snap（W1）这里不再调 KERNEL `verifySealChain()` 做整读：
 *      lite 的"链校验"语义 = **可解析 + 坏行计数**（sealjournal.js: verifySealChain），
 *      与 journal 尾读缓存给出的 `badLines/readError` 完全等价；缓存结论一致、读盘更少。
 */
export function readSealEvidence(root) {
  const seals = readWeeklySeals(root);
  const j = journalIndexFor(root);
  const stateSeals = {};
  try {
    const st = readState(root);
    const v = st && st[SEAL_STATE_KEY];
    if (v && typeof v === 'object') {
      for (const gid of Object.keys(v)) {
        const n = sealInfoOf(v, gid);
        if (n) stateSeals[gid] = n;
      }
    }
  } catch { /* ignore */ }
  const conflicts = [];
  for (const [gid, info] of Object.entries(stateSeals)) {
    const jInfo = j.seals.get(gid);
    if (jInfo && jInfo.sealHash && info.sealHash && jInfo.sealHash !== info.sealHash) {
      conflicts.push({ gid, sources: ['journal', 'state'], hashes: [jInfo.sealHash, info.sealHash] });
    }
  }
  const chain = {
    ok: !j.readError && j.badLines === 0,
    events: j.eventCount,
    chainBroken: 0, // lite：链已砍，字段仅为兼容保留（恒 0）
    badLines: j.badLines,
    readError: j.readError,
  };
  return {
    seals,
    conflicts,
    journal: {
      path: j.path,
      events: j.eventCount,
      badLines: j.badLines || 0,
      readError: j.readError || '',
      headSha: j.headSha || '',
      chainBroken: 0,
    },
    chain,
    stateCount: Object.keys(stateSeals).length,
  };
}

/**
 * 追加一条 weekly-seal 事件 —— **只调 lib/sealjournal.js 的唯一写者**，不自写文件。
 * appendSealEvent 自带：同 (kind,key) 幂等、prevSealSha256 自动链接、fsync 落盘。
 *
 * @throws {Error} 证据写不进去（fsync/IO/参数）必须抛出：封板证据写不进去等于没封板
 */
export function appendWeeklySealEvent(root, p) {
  const rows = Array.isArray(p.rows) ? p.rows : null;
  const res = appendSealEvent(root, {
    kind: 'weekly-seal',
    key: p.gid,
    gid: p.gid,
    file: p.file === undefined ? null : p.file,
    sealedAt: p.sealedAt === undefined ? null : p.sealedAt,
    layoutVersion: Number.isFinite(p.layout) ? p.layout : LAYOUT_VERSION,
    canonicalVersion: Number.isFinite(p.canonicalVersion) ? p.canonicalVersion : SEAL_CANONICAL_VERSION,
    sourceRowCount: Number.isFinite(p.sourceRowCount) ? p.sourceRowCount : null,
    overflow: Number.isFinite(p.overflow) ? p.overflow : null,
    rowCount: Number.isFinite(p.rowCount) ? p.rowCount : (rows ? rows.length : null),
    rows,
    rowsSha256: rows ? undefined : (p.rowsSha256 || undefined),
    supplementCodes: Array.isArray(p.supplementCodes) ? p.supplementCodes : undefined,
    supplement: p.supplement && typeof p.supplement === 'object' ? p.supplement : null,
    sealHash: p.sealHash || undefined,
    sessKey: p.sessKey, year: p.year, month: p.month, weekNo: p.weekNo, offsetMinutes: p.offsetMinutes,
  });
  if (!res || res.ok !== true) {
    throw new Error('E_SEAL_JOURNAL_APPEND_FAILED: ' + String((res && res.reason) || 'unknown'));
  }
  return res;
}

/**
 * 写一组封板状态：**journal 权威（失败抛）→ state 缓存（失败只 warning）**。
 * @returns {{journal:object, stateWarn:string|null}}
 */
export function writeWeeklySeal(root, gid, info) {
  const next = { ...(info || {}), gid };
  const journal = appendWeeklySealEvent(root, next); // 失败抛：证据优先
  let stateWarn = null;
  try {
    const seals = {};
    const st = readState(root);
    const v = st && st[SEAL_STATE_KEY];
    if (v && typeof v === 'object') Object.assign(seals, v);
    seals[gid] = {
      sealedAt: next.sealedAt,
      sealHash: next.sealHash,
      file: next.file,
      layout: Number.isFinite(next.layout) ? next.layout : LAYOUT_VERSION,
      rows: Array.isArray(next.rows) ? next.rows.length : (Number(next.rowCount) || Number(next.rows) || 0),
    };
    writeState(root, { [SEAL_STATE_KEY]: seals });
  } catch (e) {
    stateWarn = 'state cache write failed: ' + String((e && e.message) || e);
  }
  return { journal, stateWarn };
}

/**
 * 从 xlsx 字节里认封板标记（stored ZIP 里 XML 是明文，不需要 xlsx 读取器）。
 * @returns {{sealHash:string, sealedAt:string, rows:number}|null}
 */
export function parseSealedMarkerText(text) {
  const s = String(text || '');
  if (!s.includes(SEALED_STATUS_TEXT)) return null;
  const h = /封板hash: ([0-9a-f]{64})/.exec(s);
  const t = /封板时间: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(s);
  const n = /记录数: (\d+)/.exec(s);
  return {
    sealHash: h ? h[1] : '',
    sealedAt: t ? t[1] : '',
    rows: n ? Number(n[1]) : 0,
  };
}

/** 读文件的封板标记（文件不存在/不是封板 → null）。 */
export function readSealedMarker(filePath) {
  return readSealedMarkerEx(filePath).marker;
}

/**
 * 读封板标记，并**区分三种状态**（CH-18 需要）：
 *   · `sealed`      —— 文件里确实有可解析的封板标记；
 *   · `draft`       —— 文件可读、且里面没有封板标记（正常的草稿）；
 *   · `unreadable`  —— 文件读不出来，或**有封板字样但解析不出来**。
 *
 * @why 为什么必须分三态（审计 #3）：只有 `unreadable` 才是契约说的"文件头无法解析"，
 *      才构成"状态不明 → E_SEAL_UNKNOWN 只报不改"。如果拿"没有标记"当状态不明，
 *      正常的"草稿 → 封板"就永远走不通了（实测：加了粗口径守卫后两条封板用例立刻变红）。
 *
 * @param {string} filePath
 * @returns {{state:'sealed'|'draft'|'unreadable', marker:object|null, error?:string}}
 */
export function readSealedMarkerEx(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { state: 'unreadable', marker: null, error: String((e && e.message) || e) };
  }
  let hasText = false;
  try {
    hasText = buf.includes(Buffer.from(SEALED_STATUS_TEXT, 'utf8'));
  } catch {
    return { state: 'unreadable', marker: null, error: 'buffer-scan-failed' };
  }
  if (!hasText) return { state: 'draft', marker: null };
  let marker = null;
  try {
    marker = parseSealedMarkerText(buf.toString('utf8'));
  } catch (e) {
    return { state: 'unreadable', marker: null, error: String((e && e.message) || e) };
  }
  if (!marker) return { state: 'unreadable', marker: null, error: 'marker-parse-failed' };
  // ★ 有封板字样却既无封板hash、也无封板时间 → 这不是"可用证据"，只能是"读不懂的标记"。
  //   （Excel 重存会把单元格写成别的形态，正是这种"看得见字样、拿不到证据"的形态。）
  const hasEvidence = /^[0-9a-f]{64}$/.test(String(marker.sealHash || '')) ||
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(marker.sealedAt || ''));
  if (!hasEvidence) return { state: 'unreadable', marker: null, error: 'marker-without-evidence' };
  return { state: 'sealed', marker };
}

/**
 * 封板时刻：该周最后一天 24:00（= endMs+1ms）+ graceDays 天（模板 7.2）。
 * @returns {{due:boolean, dueAtMs:number, dueAt:string}}
 */
export function sealDueInfo({ w, offsetMinutes = 480, nowMs = Date.now(), graceDays = GRACE_DAYS }) {
  const dueAtMs = w.endMs + 1 + graceDays * DAY_MS;
  return {
    due: Number(nowMs) >= dueAtMs,
    dueAtMs,
    dueAt: localStamp(dueAtMs, offsetMinutes),
    remainingMs: Math.max(0, dueAtMs - Number(nowMs)),
  };
}

/** 是否已过封板宽限期（该周最后一天 24:00 + graceDays 天）。 */
export function isSealDue({ w, nowMs = Date.now(), graceDays = GRACE_DAYS }) {
  return Number(nowMs) >= w.endMs + 1 + graceDays * DAY_MS;
}

/**
 * 给 index.js 用的集成帮手：从分组表里挑出「宽限期已到、但还没封板」的组。
 *
 * @param {Map<string,{w:object}>} groups groupRecords() 结果
 * @param {{seals?:object, nowMs?:number, graceDays?:number}} [p]
 * @returns {string[]} 需要补封板的 gid 列表
 *
 * @why 为什么单独要这个：正常只有"本轮有新记录"的组才会被 writeWeekly 处理；
 *      一个组安静下来后，宽限期到点那一刻不会被自然触碰 —— 不主动 sweep 就永远停在草稿。
 */
export function findDueSealGroupIds(groups, { seals = {}, nowMs = Date.now(), graceDays = GRACE_DAYS } = {}) {
  const out = [];
  for (const [gid, g] of groups instanceof Map ? groups : Object.entries(groups || {})) {
    if (!g || !g.w) continue;
    if (sealInfoOf(seals, gid)) continue;
    if (isSealDue({ w: g.w, nowMs, graceDays })) out.push(gid);
  }
  return out;
}

// ============================================================================
// 十、写周记账（草稿/封板）
// ============================================================================

/**
 * 溢出闭合校验（D13）：封板前必须证明「每个源编码都有去向」。
 *
 * 条件（全部必须成立）：
 *   ① 正册行数 + 溢出条数 == sourceRowCount；
 *   ② 溢出条数 == supplementCodes.length；
 *   ③ 正册编码集合 ∩ 补记编码集合 == ∅；
 *   ④ 正册/补记各自内部无重复编码；
 *   ⑤ 正册∪补记 == 源编码集合（数量与集合都对齐）。
 *
 * @returns {{ok:boolean, checks:object, errors:string[], bookCodes:string[], supplementCodes:string[]}}
 */
export function validateOverflowClosure({ days, overflow, sourceRowCount, supplementCodes }) {
  const bookCodes = [];
  for (const d of days || []) for (const e of d.entries || []) bookCodes.push(e.code);
  const suppCodes = (Array.isArray(supplementCodes) ? supplementCodes : []).map(String);
  const bookSet = new Set(bookCodes);
  const suppSet = new Set(suppCodes);
  const errors = [];
  const checks = {
    sourceRowCount: Number(sourceRowCount),
    rowCount: bookCodes.length,
    overflow: Number(overflow),
    supplementCount: suppCodes.length,
    union: bookSet.size + suppSet.size,
  };
  if (bookCodes.length + Number(overflow) !== Number(sourceRowCount)) errors.push('rowCount+overflow!=sourceRowCount');
  if (suppCodes.length !== Number(overflow)) errors.push('supplementCodes.length!=overflow');
  if (bookSet.size !== bookCodes.length) errors.push('duplicate-code-in-book');
  if (suppSet.size !== suppCodes.length) errors.push('duplicate-code-in-supplement');
  for (const c of suppCodes) if (bookSet.has(c)) errors.push('code-in-both:' + c);
  if (bookSet.size + suppSet.size !== Number(sourceRowCount)) errors.push('union!=sourceRowCount');
  return { ok: errors.length === 0, checks, errors, bookCodes, supplementCodes: suppCodes };
}

/** 4 字节 sha256（补记册文件字节留证用）。 */
function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把一组记录写成周记账 xlsx。
 *
 * 行为（按优先级）：
 *  1. 已封板（journal 权威 → state 缓存 → 文件头标记）→ `{skipped:true, reason:'sealed'}`，
 *     **不写文件**；文件被删也 skip（warnings 含 `sealed but file missing`）。
 *     若证据来自 state/文件头而 journal 缺行 → 认领并补写 journal（不重写 xlsx）。
 *  2. state/journal 丢失但目录已有 xlsx → 保守 skip（`reason:'state-lost'`）：人工批注不可丢；
 *     显式 `mode:'sealed'` 或 `force:true` 例外。
 *  3. mode='sealed' → **P0-4/D13 封板链**：
 *       ① 溢出（如有）先写补记册（reason=`overflow-seal`），失败抛 E_SEAL_OVERFLOW_SUPPLEMENT_FAILED；
 *       ② 闭合校验（正册∪补记==源编码、交集空、120+overflow==sourceRowCount）；
 *       ③ 渲染封板 xlsx（说明页 A3/A4/A5）；
 *       ④ 写 seal journal（唯一写者 `lib/sealjournal.js`；失败抛，= 没封板）；
 *       ⑤ state 缓存（失败只 warning）。
 *  4. mode='draft' → 草稿版；内容指纹没变且文件在 → 不重写（force:true 可强制重生成）。
 *  5. mode 省略 → 自动：宽限期已到就封板，否则草稿。
 *  6. **入参形状非法**（w 的 year/month/weekNo、sessKey 不合法等，审计② P2-14）→
 *     立即结构化拒绝：`{written:false, skipped:true, reason:'E_WEEKLY_BAD_ARGS', error:{code,errors}}`，
 *     **不写任何文件**（旧实现会落 `undefined年undefined月` 的账与 `undefined-…` 的 gid）。
 *
 * @returns {{path:string, groupId:string, hash:string, written:boolean,
 *            skipped:boolean, reason?:string, mode:'draft'|'sealed', sealed:boolean,
 *            sealHash:string, sealedAt:string, warnings:Array, overflow:number,
 *            sourceRowCount:number, supplement:object|null, journal:object|null,
 *            error?:{code:string, errors:string[]}, integrityFailures?:Array}}
 */
export function writeWeekly({
  root, w, sessKey, records = [], offsetMinutes = 480, prevHashes = {},
  generatedAt, mode, sealedAt, nowMs, graceDays = GRACE_DAYS,
  persistSeal = true, readSealFromState = true, force = false, cleaned,
  // 0.9.4-snap（W1 ②）：允许调用方把"每 tick 读一次"的封板证据传进来；
  //   不传则用本模块的尾读缓存（等价结论，只是少读盘）。传错不会改语义 —— 它们只影响
  //   "已知封板集合"，最终仍以 journal 为准。
  seals: sealsOverride, journalState: journalStateOverride,
} = {}) {
  // ★ 审计② P2-14：形状校验必须在算路径/读证据**之前**完成。
  //   非法 = 结构化拒绝（不抛错、不写任何文件），绝不让 `undefined年undefined月` / `undefined-…` 进账。
  const argErrors = validateWeeklyWriteArgs({ root, w, sessKey, offsetMinutes, graceDays });
  if (argErrors.length > 0) {
    return {
      ok: false,
      path: '', groupId: '', written: false, skipped: true, reason: 'E_WEEKLY_BAD_ARGS',
      mode: 'draft', sealed: false, hash: '', sealHash: '', sealedAt: '',
      error: { code: 'E_WEEKLY_BAD_ARGS', errors: argErrors },
      warnings: [{
        type: 'E_WEEKLY_BAD_ARGS',
        errors: argErrors,
        message: 'weekly: 入参形状非法，拒绝写周账（不写半成品）：' + argErrors.join('；'),
      }],
      overflow: 0, sourceRowCount: 0, supplement: null, journal: null, integrityFailures: [],
    };
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const stamp = stampOf(generatedAt, offsetMinutes, now);
  const gid = groupId(w, sessKey);
  const folder = path.join(root, weeklyFolderName(w));
  const officialFile = path.join(folder, officialNameOf(w, sessKey));
  const draftFile = path.join(folder, draftNameOf(w, sessKey));
  const file = officialFile; // 兼容：以下封板检测/标记读取只针对正式名
  const fileExists = fs.existsSync(officialFile);
  const hasPrev = !!(prevHashes && prevHashes[gid]);
  const relFile = path.relative(root, officialFile);

  // ① 封板检测：journal 权威 → state 缓存 → 文件头标记（P1-9）
  const warnings = [];
  const seals = sealsOverride !== undefined
    ? sealsOverride
    : (readSealFromState ? weeklySealsView(root) : {});
  const sealFromMap = sealInfoOf(seals, gid);
  // ★ W1/W2（0.9.4-snap P3）：文件头标记**按需读**。
  //   旧实现无论有没有 journal/state 证据都先 `readSealedMarkerEx(official)` 整本读 186 KB xlsx，
  //   于是"已封板组被触碰"每次 tick 都要为每个组读一遍 xlsx（800 组 ≈149 MB/tick）。
  //   现在：有 journal/state 证据 → 一次都不读；只有"没有证据 + 文件存在"才读文件头。
  let officialMarkerEx = null;
  const officialMarker = () => {
    if (officialMarkerEx) return officialMarkerEx;
    officialMarkerEx = fileExists
      ? readSealedMarkerTracked(file)
      : { state: 'absent', marker: null };
    return officialMarkerEx;
  };
  const fileSealEx = sealFromMap ? { state: 'absent', marker: null } : officialMarker();
  const fileSeal = fileSealEx.marker;
  const knownSeal = sealFromMap || fileSeal;
  let journalState = journalStateOverride !== undefined ? journalStateOverride : null;
  if (journalState === null) {
    try { journalState = readSealJournalState(root); } catch { journalState = null; }
  }
  if (journalState && journalState.readError) {
    warnings.push({ type: 'seal-journal-read-error', gid, message: 'weekly: seal journal read error: ' + journalState.readError });
  }
  // journal 读不出来 → **不得当作"未封板"**（审计 M-02/M-03）：保守停手，等下一轮/人工处置。
  if (journalState && journalState.readError && !knownSeal) {
    return {
      path: file, groupId: gid, written: false, skipped: true, reason: 'seal-evidence-unreadable',
      mode: 'draft', sealed: false, hash: '', sealHash: '', sealedAt: '',
      warnings: [...warnings, {
        type: 'seal-evidence-unreadable', gid,
        message: 'weekly: seal journal unreadable (' + journalState.readError + '), refuse to write（不能把"读不到"当作"没封板"）',
      }],
      overflow: 0, sourceRowCount: 0, supplement: null, journal: null, integrityFailures: [],
    };
  }
  if (knownSeal) {
    if (!fileExists) {
      warnings.push({ type: 'sealed-file-missing', gid, path: file, message: 'weekly: sealed but file missing' });
    }
    const fromJournal = !!(sealFromMap && sealFromMap.source === 'journal');
    const hasHash = /^[0-9a-f]{64}$/.test(String(knownSeal.sealHash || ''));
    if (!fromJournal && persistSeal && hasHash) {
      // state/文件头有封板、journal 缺行 → 认领补写（不重写 xlsx；证据优先）
      warnings.push({ type: 'seal-journal-import', gid, message: 'weekly: seal evidence imported into journal (book untouched)' });
      try {
        // 若当前记录重算出的 sealHash 与证据一致，可把 rows 一起补进 journal（更完整）
        let rows; let sourceRowCount; let overflow; let supplementCodes; let supplement = null;
        try {
          const c = collectDays({
            root, w, records, offsetMinutes, cleaned, gid,
          });
          const b = weeklySealBody({ w, sessKey, offsetMinutes, days: c.days });
          if (b.sealHash === String(knownSeal.sealHash || '')) {
            rows = b.rows; sourceRowCount = b.sourceRowCount; overflow = b.overflow; supplementCodes = b.supplementCodes;
            if (overflow > 0) supplement = { file: null, sha256: '', codes: supplementCodes.slice() };
          }
        } catch { /* 重算失败就只补元数据 */ }
        writeWeeklySeal(root, gid, {
          sealedAt: String(knownSeal.sealedAt || ''),
          sealHash: String(knownSeal.sealHash || ''),
          file: String(knownSeal.file || relFile),
          layout: Number.isFinite(knownSeal.layout) ? knownSeal.layout : LAYOUT_VERSION,
          rows,
          rowCount: Number.isFinite(knownSeal.rows) ? knownSeal.rows : undefined,
          sourceRowCount, overflow, supplementCodes, supplement,
          sessKey, year: w.year, month: w.month, weekNo: w.weekNo, offsetMinutes,
        });
        warnings.push({ type: 'seal-journal-healed', gid, message: 'weekly: seal journal healed from evidence' });
      } catch (e) {
        warnings.push({ type: 'seal-journal-missing', gid, message: 'weekly: seal journal heal failed: ' + String(e && e.message || e) });
      }
    }
    return {
      path: file, groupId: gid, written: false, skipped: true, reason: 'sealed',
      mode: 'sealed', sealed: true,
      hash: '', sealHash: String(knownSeal.sealHash || ''), sealedAt: String(knownSeal.sealedAt || ''),
      warnings, overflow: Number.isFinite(knownSeal.overflow) ? knownSeal.overflow : 0,
      sourceRowCount: Number.isFinite(knownSeal.sourceRowCount) ? knownSeal.sourceRowCount : undefined,
      supplement: knownSeal.supplement || null, journal: null,
    };
  }

  // ①b V0.7 两态：正式名存在但无封板证据 → 历史遗留草稿/冲突处理
  //   - 正式名 + 草稿并存 → 保正式名（封板证据优先），告警不删不覆盖；
  //   - 正式名（无标记无 journal）→ rename 为 草稿-<正式名>（只改名、不改字节），
  //     保住人工批注；本轮不重写（等 state 恢复/下一轮再按草稿处理）。
  const draftExists0 = fs.existsSync(draftFile);
  if (fileExists && !knownSeal) {
    const decision = decideMigration({ officialExists: true, draftExists: draftExists0, officialSealed: false, journalSealed: false });
    if (decision.action === 'conflict-official-wins') {
      warnings.push({ type: 'E_WEEKLY_STATE_CONFLICT', gid, path: officialFile, message: 'weekly: official 与草稿同时存在；保正式名，拒绝写入（人工处置）' });
      return {
        path: officialFile, groupId: gid, written: false, skipped: true, reason: 'E_WEEKLY_STATE_CONFLICT',
        mode: 'draft', sealed: false, hash: '', sealHash: '', sealedAt: '',
        warnings, overflow: 0, sourceRowCount: 0, supplement: null, journal: null, integrityFailures: [],
      };
    }
    if (decision.action === 'migrate-legacy-draft' && fileSealEx.state !== 'unreadable') {
      try {
        fs.renameSync(officialFile, draftFile);
        warnings.push({ type: 'legacy-draft-migrated', gid, from: path.relative(root, officialFile), to: path.relative(root, draftFile), message: 'weekly: 历史无标记正式名 → 已 rename 为草稿（字节未改）' });
      } catch (e) {
        warnings.push({ type: 'legacy-draft-migrate-failed', gid, message: 'weekly: 历史草稿 rename 失败，跳过本轮: ' + String(e && e.message || e) });
        return {
          path: officialFile, groupId: gid, written: false, skipped: true, reason: 'legacy-draft-migrate-failed',
          mode: 'draft', sealed: false, hash: '', sealHash: '', sealedAt: '',
          warnings, overflow: 0, sourceRowCount: 0, supplement: null, journal: null, integrityFailures: [],
        };
      }
    }
  }
  const draftExists = fs.existsSync(draftFile);
  // ★ W1/W2：草稿文件头同样**按需读**（只有"要判 E_SEAL_UNKNOWN"时才读）：
  //   草稿每轮都要重生成，绝大多数情况下根本不需要知道它有没有封板字样。
  let draftMarkerEx = null;
  const draftMarker = () => {
    if (draftMarkerEx) return draftMarkerEx;
    draftMarkerEx = draftExists
      ? readSealedMarkerTracked(draftFile)
      : { state: 'absent', marker: null };
    return draftMarkerEx;
  };

  // ② state 丢失 + 已有 xlsx → 保守不重写（模板 7.5 第 4 条；人工批注不可丢）
  if (draftExists && !hasPrev && readSealFromState && !force && mode !== 'sealed') {
    return {
      path: draftFile, groupId: gid, written: false, skipped: true, reason: 'state-lost',
      mode: 'draft', sealed: false, hash: '', sealHash: '', sealedAt: '',
      warnings: [...warnings, {
        type: 'state-lost', gid, path: draftFile,
        message: 'weekly: state lost, 1 existing draft untouched (人工批注不可丢；由 user/Lead 处置)',
      }],
      overflow: 0, sourceRowCount: 0, supplement: null, journal: null, integrityFailures: [],
    };
  }

  // ③ 采集 + canonical/指纹（server 唯一公式在 lib/sealjournal.js）
  //   ★ W2：传 gid → 行身份未变的行直接复用上次结论，只有新行/变化行重新走 resolveDoc。
  const collected = collectDays({
    root, w, records, offsetMinutes, cleaned, gid,
  });
  warnings.push(...collected.warnings);
  if (collected.integrityFailures.length > 0) {
    warnings.push({
      type: 'integrity-failures',
      entries: collected.integrityFailures,
      message: `weekly: integrity failures=${collected.integrityFailures.length}（绑定复核未通过，已落缺凭证；写运行报告 integrityFailures）`,
    });
  }
  const body = weeklySealBody({ w, sessKey, offsetMinutes, days: collected.days });
  const sealHash = body.sealHash;
  const hash = journalSha256Hex(`layout=${LAYOUT_VERSION}\n${body.canonical}`);

  // ④ 决定本次写草稿还是封板
  const effMode = mode === 'sealed'
    ? 'sealed'
    : mode === 'draft'
      ? 'draft'
      : (isSealDue({ w, nowMs: now, graceDays }) ? 'sealed' : 'draft');
  const effSealedAt = effMode === 'sealed' ? stampOf(sealedAt || stamp, offsetMinutes, now) : '';

  // ②b E_SEAL_UNKNOWN（CH-18 / 审计 #3，2026-11-09）：
  //   契约原文：「任何"状态不明"（state 缺封板记录/文件头无法解析）→ 一律不得重写已存在周记账
  //   （无论 prevHash 是否存在）……journal 也无该组记录且文件存在 → 报 E_SEAL_UNKNOWN、字节不变」。
  //   "状态不明"的**可判定形式**就是 `fileSealEx.state === 'unreadable'`：
  //   文件读不出、或有封板字样却解析不出标记。此时它可能是已封板册（甚至带人工批注），
  //   宁可停手报错，也不能算一遍再封（封板后永不重写 = 不可逆）。
  //   ★ 正常草稿是 `draft` 态（能读、没标记），不受此守卫影响 —— 否则"草稿→封板"会被堵死。
  //   ★ W1（0.9.4-snap）：只有**真的可能撞上状态不明**（sealed 模式 + 无证据 + 非 force）
  //     才去读草稿文件头；草稿路径/普通跳过路径不再整本读 xlsx。
  let unknownFile = null;
  if (effMode === 'sealed' && !knownSeal && !force) {
    if (fileSealEx.state === 'unreadable') unknownFile = officialFile;
    else if (draftExists && draftMarker().state === 'unreadable') unknownFile = draftFile;
  }
  if (unknownFile) {
    return {
      path: unknownFile, groupId: gid, written: false, skipped: true, reason: 'E_SEAL_UNKNOWN',
      mode: 'sealed', sealed: false, hash, sealHash: '', sealedAt: '',
      warnings: [...warnings, {
        type: 'E_SEAL_UNKNOWN', gid, path: unknownFile,
        message: 'weekly: E_SEAL_UNKNOWN —— 文件在但封板标记无法解析（'
          + String(fileSealEx.error || 'unknown') + '），journal/state 亦无证据；拒绝重写，交人工处置',
      }],
      overflow: collected.overflow, sourceRowCount: collected.sourceRowCount,
      supplement: null, journal: null, integrityFailures: collected.integrityFailures,
    };
  }

  // ⑤ 草稿：内容指纹没变且文件在 → 不重写（force 强制重生成；封板版必须写一次）
  if (!force && effMode === 'draft' && prevHashes && prevHashes[gid] === hash && draftExists) {
    return {
      path: draftFile, groupId: gid, hash, written: false, skipped: false, reason: 'unchanged',
      mode: 'draft', sealed: false, sealHash: '', sealedAt: '',
      warnings, overflow: collected.overflow, sourceRowCount: collected.sourceRowCount,
      supplement: null, journal: null, integrityFailures: collected.integrityFailures,
    };
  }

  // ⑥ 封板前：溢出必须先写补记册 + 闭合校验（D13）
  let supplement = null;
  if (effMode === 'sealed' && collected.overflow > 0) {
    const suppCodes = body.supplementCodes.slice();
    const recByCode = new Map();
    for (const r of Array.isArray(records) ? records : []) if (r && r.code) recByCode.set(String(r.code), r);
    const suppRecords = suppCodes.map((c) => recByCode.get(c)).filter(Boolean);
    let sup = null;
    try {
      sup = writeSupplement({
        root,
        codes: suppCodes,
        records: suppRecords,
        reason: 'overflow-seal',
        generatedAt: effSealedAt,
        offsetMinutes,
        cleaned,
      });
    } catch (e) {
      // 补记写不进去 → 禁止封板（否则溢出编码没有去向）
      throw new Error('E_SEAL_OVERFLOW_SUPPLEMENT_FAILED: ' + String((e && e.message) || e));
    }
    const codesInBookOrder = Array.isArray(sup && sup.entries) && sup.entries.length
      ? sup.entries.map((x) => x.code)
      : suppCodes;
    let fileSha = '';
    try { fileSha = sha256Bytes(fs.readFileSync(sup.path)); } catch { fileSha = ''; }
    supplement = { file: path.relative(root, sup.path), sha256: fileSha, codes: codesInBookOrder };
    const closure = validateOverflowClosure({
      days: collected.days,
      overflow: collected.overflow,
      sourceRowCount: collected.sourceRowCount,
      supplementCodes: codesInBookOrder,
    });
    if (!closure.ok) {
      throw new Error('E_SEAL_OVERFLOW_CLOSURE_FAILED: ' + closure.errors.join(','));
    }
    warnings.push({
      type: 'overflow-supplemented',
      gid,
      dropped: collected.overflow,
      path: sup.path,
      codes: codesInBookOrder,
      message: `weekly: overflow ${collected.overflow} rows written to ${path.basename(sup.path)} before seal`,
    });
  }

  // ⑦ 渲染 + 原子写
  const sheets = renderSheets({
    w, sessKey, days: collected.days, offsetMinutes, generatedAt: stamp,
    mode: effMode, sealedAt: effSealedAt, sealHash,
    overflow: collected.overflow, warnings: [],
  });
  // ⑦ V0.7 两态落盘：
  //   草稿 → 草稿-<正式名>（每轮可重写）；封板 → 临时文件写 sealed 内容 → fsync 所在目录 → rename 正式名 → 删草稿。
  //   ★ 审计② P2-15：xlsx 侧"单元格超 32,767 被截断"必须回到 warnings（不静默丢数据）。
  const xlsxWarnings = [];
  let writtenPath = draftFile;
  if (effMode === 'sealed') {
    const tmpSeal = officialFile + '.sealing-' + process.pid + '-' + Date.now();
    try {
      writeXlsx(tmpSeal, sheets, { warnings: xlsxWarnings });
      fs.renameSync(tmpSeal, officialFile);
      writtenPath = officialFile;
      try { if (fs.existsSync(draftFile)) fs.unlinkSync(draftFile); } catch { /* 删草稿失败不影响封板 */ }
    } catch (e) {
      try { if (fs.existsSync(tmpSeal)) fs.unlinkSync(tmpSeal); } catch { /* ignore */ }
      throw new Error('E_WEEKLY_SEAL_RENAME_FAILED: ' + String((e && e.message) || e));
    }
  } else {
    writeXlsx(draftFile, sheets, { warnings: xlsxWarnings });
    writtenPath = draftFile;
  }
  if (xlsxWarnings.length) warnings.push(...xlsxWarnings);

  // ⑧ 封板：seal journal（权威；失败抛 = 没封板）→ state 缓存
  let journal = null;
  if (effMode === 'sealed' && persistSeal) {
    const res = writeWeeklySeal(root, gid, {
      sealedAt: effSealedAt,
      sealHash,
      file: relFile,
      layout: LAYOUT_VERSION,
      canonicalVersion: SEAL_CANONICAL_VERSION,
      sourceRowCount: body.sourceRowCount,
      overflow: body.overflow,
      rows: body.rows,
      rowCount: body.rowCount,
      supplementCodes: body.supplementCodes,
      supplement,
      sessKey, year: w.year, month: w.month, weekNo: w.weekNo, offsetMinutes,
    });
    journal = res && res.journal ? res.journal : null;
    if (res && res.stateWarn) warnings.push({ type: 'seal-state-cache-failed', gid, message: 'weekly: ' + res.stateWarn });
  }

  return {
    path: writtenPath, groupId: gid, hash, written: true, skipped: false,
    mode: effMode, sealed: effMode === 'sealed',
    sealHash: effMode === 'sealed' ? sealHash : '',
    sealedAt: effSealedAt,
    warnings, overflow: collected.overflow, sourceRowCount: collected.sourceRowCount,
    supplement, journal, integrityFailures: collected.integrityFailures,
  };
}

// ============================================================================
// 十·补、W3（0.9.4-snap P3）：bootstrap 单 tick 预算 + 续跑状态
// ============================================================================
/**
 * @why 为什么需要"预算 + 续跑"（方案 §4.3 W3）：
 *      首次建周账（state 丢/版式升级/换 offsetMinutes）会把**所有组**当 touched，
 *      一轮内重写全部周账 —— 3 年 ≈2 万组，单 tick 必然超 30 s 预算。
 *      做法：封板组先跳过（W2 后天然便宜）、未封板组按"组数 + 耗时"分批；
 *      余量写 state `weeklyCatchup`，下一 tick 从断点继续。
 *
 * @why 为什么"不丢批、不重复写"：
 *   · 每 tick **只在处理完之后**才把 `pending` 前进（崩溃时旧 pending 仍包含本批 → 重放）；
 *   · 重放是幂等的：草稿内容指纹没变就不重写、已封板组永不重写（journal 权威）；
 *   · 每组的 xlsx 都是"临时文件 + rename"原子落盘，不存在半本账。
 *
 * 常量不新增配置键（纪律同 0.9.3）：预算值只作为函数默认值/`WEEKLY_BUDGET` 常量存在。
 */
export const WEEKLY_CATCHUP_KEY = 'weeklyCatchup';
export const WEEKLY_BUDGET = Object.freeze({ groupsPerTick: 200, msPerTick: 20000 });

/** 读续跑状态（没有/损坏 → null；不抛）。 */
export function loadWeeklyCatchup(root) {
  if (!root) return null;
  let v;
  try {
    const st = readState(root);
    v = st && st[WEEKLY_CATCHUP_KEY];
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const list = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  return {
    pending: list(v.pending),
    inflight: list(v.inflight),
    total: Number.isFinite(v.total) ? v.total : 0,
    done: Number.isFinite(v.done) ? v.done : 0,
    startedAt: typeof v.startedAt === 'string' ? v.startedAt : '',
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    reason: typeof v.reason === 'string' ? v.reason : '',
  };
}

/** 写续跑状态（传 null = 清除；写进 `.state.json` 的 `weeklyCatchup` 键）。 */
export function saveWeeklyCatchup(root, value) {
  writeState(root, { [WEEKLY_CATCHUP_KEY]: value && typeof value === 'object' ? value : null });
}

/**
 * 按预算跑一轮周账（index.js 的 bootstrap/touched 循环的预算版；本轮暂不接线，见交付说明）。
 *
 * @param {object} p
 * @param {string} p.root 账库根
 * @param {Map<string,{w:object,sessKey:string,records:object[]}>} p.groups `groupRecords()` 结果
 * @param {Set<string>|string[]} [p.touched] non-bootstrap 时的候选组（本轮有新记录的组）
 * @param {boolean} [p.bootstrap=false] 首次全量建周账（候选 = 全部组，按 gid 排序保证可重放）
 * @param {object|null} [p.pending] 显式传入续跑状态；省略 = 从 `.state.json` 读
 * @param {number} [p.budgetGroups] 每个 tick 最多处理多少个**未封板**组
 * @param {number} [p.budgetMs] 每个 tick 最多花多少毫秒（封板组也会被快速遍历，受它兜底）
 * @param {object} [p.prevHashes] 内容指纹表（会被就地更新：`hashes[gid]=hash`，与 index.js 用法一致）
 * @param {object} [p.seals] 本 tick 的封板视图（省略 = 用尾读缓存）；会透传给 writeWeekly
 * @returns {{processed:string[], deferred:string[], catchup:object|null, results:Array,
 *            weeklyDeferred:number, stats:object}}
 *
 * @note 续跑状态只在**处理完成之后**前进；中途崩溃重放是幂等的（见函数上方注释）。
 * @note `force` 默认 false：预算续跑**不**强写已有草稿 —— "无哈希 + 已有草稿 → 保守不重写"
 *       这条人工批注保护（模板 7.5 第 4 条）必须保留。
 */
export function runWeeklyBudget({
  root, groups, touched, bootstrap = false,
  pending, budgetGroups = WEEKLY_BUDGET.groupsPerTick,
  budgetMs = WEEKLY_BUDGET.msPerTick, nowMs, graceDays = GRACE_DAYS,
  prevHashes = {}, offsetMinutes = 480, generatedAt, force = false,
  readSealFromState = true, persistSeal = true, cleaned, seals: sealsOverride,
} = {}) {
  if (!root) throw new TypeError('runWeeklyBudget: root 必填');
  if (!(groups instanceof Map)) throw new TypeError('runWeeklyBudget: groups 必须是 groupRecords() 的 Map');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const budget = {
    groupsPerTick: Math.max(1, Math.floor(Number(budgetGroups) || WEEKLY_BUDGET.groupsPerTick)),
    msPerTick: Math.max(50, Math.floor(Number(budgetMs) || WEEKLY_BUDGET.msPerTick)),
  };
  const catchup = pending === undefined ? loadWeeklyCatchup(root) : pending;
  const inflight = catchup && Array.isArray(catchup.inflight)
    ? catchup.inflight.filter((g) => groups.has(g)) : [];
  const pendingList = catchup && Array.isArray(catchup.pending)
    ? catchup.pending.filter((g) => groups.has(g)) : [];
  const resuming = inflight.length > 0 || pendingList.length > 0;
  let order = [];
  if (resuming) {
    order = [...new Set([...inflight, ...pendingList])];
  } else if (bootstrap) {
    order = [...groups.keys()].sort();
  } else if (touched) {
    order = [...new Set(touched instanceof Set ? [...touched] : touched)]
      .filter((g) => groups.has(g) && typeof g === 'string')
      .sort();
  }
  const seals = sealsOverride !== undefined
    ? sealsOverride
    : (readSealFromState ? weeklySealsView(root) : {});
  // journal 状态读一次传下去（writeWeekly 不再每组重复读）
  let journalState = null;
  try { journalState = readSealJournalState(root); } catch { journalState = null; }
  const started = Date.now();
  const startedStamp = localStamp(started, offsetMinutes);
  const results = [];
  const processed = [];
  let unsealedProcessed = 0;
  let sealedSkipped = 0;
  let written = 0;
  let conservativeSkipped = 0;
  let stoppedAt = order.length;
  for (let i = 0; i < order.length; i += 1) {
    const gid = order[i];
    const g = groups.get(gid);
    if (!g) continue; // 理论到不了（上面已过滤），防御
    const isSealed = !!sealInfoOf(seals, gid);
    if (!isSealed && unsealedProcessed >= budget.groupsPerTick) { stoppedAt = i; break; }
    if (Date.now() - started >= budget.msPerTick) { stoppedAt = i; break; }
    let res;
    try {
      res = writeWeekly({
        root,
        w: g.w,
        sessKey: g.sessKey,
        records: g.records,
        offsetMinutes,
        prevHashes,
        generatedAt,
        nowMs: now,
        graceDays,
        force,
        readSealFromState,
        persistSeal,
        cleaned,
        seals,
        journalState,
      });
    } catch (e) {
      // 与 index.js 一致：单组失败记结果、继续；不把它当"已处理"以外的任何语义
      results.push({ groupId: gid, error: String((e && e.message) || e), skipped: true, written: false });
      processed.push(gid);
      if (!isSealed) unsealedProcessed += 1;
      continue;
    }
    results.push(res);
    processed.push(gid);
    if (!isSealed) unsealedProcessed += 1;
    if (isSealed || (res && res.skipped && res.reason === 'sealed')) sealedSkipped += 1;
    if (res && res.written) written += 1;
    if (res && res.skipped && res.reason !== 'sealed') conservativeSkipped += 1;
    // 与 index.js 同口径：封板/state-lost 不记 hash
    if (res && !res.skipped && res.hash && prevHashes) prevHashes[res.groupId] = res.hash;
  }
  const rest = order.slice(stoppedAt);
  const doneBefore = catchup && Number.isFinite(catchup.done) ? catchup.done : 0;
  const total = catchup && Number.isFinite(catchup.total) && catchup.total > 0
    ? catchup.total : order.length;
  const nextCatchup = rest.length > 0
    ? {
      v: 1,
      pending: rest,
      inflight: [],
      total,
      done: doneBefore + processed.length,
      startedAt: (catchup && catchup.startedAt) || startedStamp,
      updatedAt: localStamp(Date.now(), offsetMinutes),
      reason: (catchup && catchup.reason) || (bootstrap ? 'bootstrap' : 'budget'),
      budget,
      sealedSkipped,
    }
    : null;
  saveWeeklyCatchup(root, nextCatchup);
  return {
    processed,
    deferred: rest,
    catchup: nextCatchup,
    results,
    weeklyDeferred: rest.length,
    stats: {
      selected: order.length,
      processedGroups: processed.length,
      unsealedProcessed,
      sealedSkipped,
      written,
      conservativeSkipped,
      deferredGroups: rest.length,
      elapsedMs: Date.now() - started,
      budget,
      resuming,
    },
  };
}

// ============================================================================
// 十一、补记册（封板后才发现的行 → 一级目录 补记-YYYYMMDD.md；只追加）
// ============================================================================

/** 补记行 10 列（与日表同构；表头逐字按模板 7.6）。 */
export const SUPPLEMENT_COLUMNS = [
  '编码', '原始凭证', '时间', '角色', '对话内容摘要',
  'User的文件引用与Agent文件输出', '输出文件位置', '状态', '用户审计', '备注',
];

/** 补记册每条的 6 个字段（模板 7.6 的必含字段）。 */
export const SUPPLEMENT_FIELDS = ['补记编号', '原编码', '原时间', '所属正册', '被补记原因', '补记hash'];

/**
 * 补记行 hash：该行 10 个字段值以 `\t` 连接后的 sha256（模板 7.6 / WK-42，可独立复算）。
 */
export function supplementEntryHash(values) {
  const list = Array.isArray(values) ? values : [];
  return sha256(list.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'));
}

/** 补记行机器初值：A/B/C/H 机器填，D/E/F/G/J 占位 —，I 待审。 */
export function supplementRowValues({ code, original, time, status }) {
  return [code, original, time, EMPTY, EMPTY, EMPTY, EMPTY, status, AUDIT_PENDING, EMPTY];
}

/** 字段值净化（换行会破 markdown 行；竖线会破表格）。 */
function oneLine(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\r?\n/g, ' ').trim();
}

/** markdown 表格单元格净化。 */
function tableCell(v) {
  return oneLine(v).replace(/\|/g, '｜');
}

/** 渲染一条补记 block（模板 7.6 的 block 结构）。 */
function renderSupplementBlock({ id, code, origTime, bookRel, reason, hash, values }) {
  const L = [];
  L.push(`## ${id}`);
  L.push('');
  L.push(`- 补记编号: ${id}`);
  L.push(`- 原编码: ${oneLine(code)}`);
  L.push(`- 原时间: ${oneLine(origTime)}`);
  L.push(`- 所属正册: ${oneLine(bookRel)}`);
  L.push(`- 被补记原因: ${oneLine(reason)}`);
  L.push(`- 补记hash: ${hash}`);
  L.push('');
  L.push(`| ${SUPPLEMENT_COLUMNS.join(' | ')} |`);
  L.push(`| ${SUPPLEMENT_COLUMNS.map(() => '---').join(' | ')} |`);
  L.push(`| ${values.map(tableCell).join(' | ')} |`);
  L.push('');
  return L.join('\n');
}

/** 渲染补记册文件头（文件不存在时创建一次；之后只追加）。 */
function renderSupplementHead({ bookId, dateLabelStr, stamp }) {
  const L = [];
  L.push('---');
  L.push(`名称: "${bookId}"`);
  L.push(`补记日期: "${dateLabelStr}"`);
  L.push(`生成器: "${SUPPLEMENT_GENERATOR}"`);
  L.push(`生成时间: "${stamp}"`);
  L.push('---');
  L.push(`# ${dateLabelStr} 补记册`);
  L.push('');
  L.push('> 本册承载已封板周记账后发现的行；永久、另册；不修改已封板正册。');
  L.push('');
  L.push('');
  return L.join('\n');
}

/** 补记册条目编号（D15：统一 `\d+`，99→100→101 不回绕/不忽略）。 */
export const SUPPLEMENT_ID_RE = /^补记-\d{8}-\d+$/;
const SUPPLEMENT_ID_PARTS = /^(补记-\d{8}-)(\d+)$/;

/** 解析一个 block 文本（结构是否完整由 `complete` 标出，哈希是否对由 verify 判）。 */
function parseSupplementBlockText(id, blockText) {
  const text = String(blockText || '');
  const field = (name) => {
    const re = new RegExp(`^- ${name}: (.*)$`, 'm');
    const m = re.exec(text);
    return m ? m[1].trim() : '';
  };
  let values = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|') || /^\|\s*-{2,}/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length === 10 && /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(cells[0])) { values = cells; break; }
  }
  const hash = field('补记hash');
  const complete = SUPPLEMENT_ID_RE.test(id)
    && /^[0-9a-f]{64}$/.test(hash)
    && values !== null;
  return {
    entry: {
      id,
      code: field('原编码'),
      origTime: field('原时间'),
      bookRel: field('所属正册'),
      reason: field('被补记原因'),
      hash,
      values,
    },
    complete,
  };
}

/**
 * 结构分析（追加前校验 / 截断尾块恢复用）：
 * 按 `## ` 标题切块，找出**第一个不完整的块**；它之前的所有字节都是完整前缀。
 *
 * @returns {{head:string, blocks:Array, completePrefixEnd:number, tailPartial:string, firstBad:number}}
 */
function analyzeSupplementBook(markdown) {
  const text = String(markdown || '');
  const hs = [];
  const re = /^## (.+)$/gm;
  let m;
  while ((m = re.exec(text))) hs.push({ id: m[1].trim(), start: m.index, contentStart: re.lastIndex });
  const head = hs.length > 0 ? text.slice(0, hs[0].start) : text;
  const blocks = hs.map((h, i) => {
    const end = i + 1 < hs.length ? hs[i + 1].start : text.length;
    const parsed = parseSupplementBlockText(h.id, text.slice(h.start, end));
    return { id: h.id, start: h.start, end, text: text.slice(h.start, end), ...parsed };
  });
  const firstBad = blocks.findIndex((b) => b.complete !== true);
  const completePrefixEnd = firstBad < 0 ? text.length : blocks[firstBad].start;
  return {
    head,
    blocks,
    completePrefixEnd,
    tailPartial: firstBad < 0 ? '' : text.slice(completePrefixEnd),
    firstBad,
  };
}

/** 解析补记册：完整块 → entries；不完整/未知块 → unknownBlocks（不得静默忽略）。 */
export function parseSupplementBook(markdown) {
  const analysis = analyzeSupplementBook(markdown);
  const bookIdM = /^名称: "([^"]+)"/m.exec(String(markdown || ''));
  const entries = [];
  const unknownBlocks = [];
  for (const b of analysis.blocks) {
    if (b.complete) entries.push(b.entry);
    else unknownBlocks.push({ id: b.id, reason: 'incomplete-or-unknown-block', bytes: b.text.length });
  }
  return {
    bookId: bookIdM ? bookIdM[1] : '',
    entries,
    unknownBlocks,
    tailPartialBytes: analysis.tailPartial.length,
  };
}

/**
 * 独立复算补记册（D15 强化）：
 *   · 逐条 补记hash 复算；
 *   · 编号从 1 起**连续**（99→100→101 不回绕、不重号）；
 *   · **未知块/截断尾块不得忽略**（报 unknown-block / tail-partial）；
 *   · bookId 必须与文件名一致（外部传入 expectedBookId 时校验）。
 *
 * @param {string} markdown
 * @param {{bookId?:string}} [opts]
 * @returns {{ok:boolean, bookId:string, entries:Array, unknownBlocks:Array, issues:Array}}
 */
export function verifySupplementBook(markdown, opts = {}) {
  const parsed = parseSupplementBook(markdown);
  const analysis = analyzeSupplementBook(markdown);
  const issues = [];
  let expected = 1;
  for (const e of parsed.entries) {
    const computed = supplementEntryHash(e.values || []);
    if (computed !== e.hash) issues.push({ type: 'entry-hash', id: e.id, expected: computed, actual: e.hash });
    const parts = SUPPLEMENT_ID_PARTS.exec(e.id);
    if (!parts) issues.push({ type: 'id-format', id: e.id });
    else {
      const num = Number(parts[2]);
      if (num !== expected) issues.push({ type: 'numbering', id: e.id, expected });
      expected = num + 1;
    }
  }
  for (const u of parsed.unknownBlocks) issues.push({ type: 'unknown-block', id: u.id, reason: u.reason });
  if (analysis.tailPartial) issues.push({ type: 'tail-partial', bytes: analysis.tailPartial.length });
  if (parsed.bookId && opts.bookId && parsed.bookId !== opts.bookId) {
    issues.push({ type: 'book-id-mismatch', expected: opts.bookId, actual: parsed.bookId });
  }
  return { ok: issues.length === 0, bookId: parsed.bookId, entries: parsed.entries, unknownBlocks: parsed.unknownBlocks, issues };
}

/**
 * 追加写（打开-写-fsync-关；不触碰已有字节）。
 * ★ P1-6：fsync 失败必须显式上报，不得吞掉（证据没落地就不能宣布成功）。
 */
function appendDurable(file, text) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖写入错误 */ }
  }
}

/**
 * 写补记册：一级目录 `补记-YYYYMMDD.md`（YYYYMMDD = 补记写入日，+08:00）。
 *
 * P1-6 追加纪律：
 *   ① 追加前**校验全册 + 尾部**：不完整的尾块先截断恢复（保留完整前缀字节），
 *      已完整部分若编号不连续/哈希不符/含未知块 → 抛 E_SUPPLEMENT_BOOK_CORRUPT，不盲写；
 *   ② 编号 `\d+` 连续（99→100→101），扫全册最大号 +1，不回绕；
 *   ③ 追加后立刻回读校验，失败抛 E_SUPPLEMENT_VERIFY_FAILED；
 *   ④ 写/fsync 失败向上抛（不吞）。
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录（补记册直接落一级）
 * @param {string[]} [p.codes] 要补记的 32 位编码（省略则取 records 的 code）
 * @param {object[]} [p.records] 台账记录（取 原时间/四态/状态默认；记录上有 `supplementReason` 则优先）
 * @param {string} [p.reason='封板后发现'] 默认「被补记原因」
 * @param {string|number} [p.generatedAt] 生成时刻（+08:00；缺省＝现在）
 * @param {number} [p.offsetMinutes=480]
 * @param {number} [p.nowMs] 当前毫秒（测试注入用）
 * @param {Map<string,string>} [p.cleaned] 预读清册（测试注入）
 * @returns {{path:string, bookId:string, written:boolean, added:number, total:number,
 *            entries:Array, warnings:Array}}
 */
export function writeSupplement({
  root, codes = [], records = [], reason = '封板后发现',
  generatedAt, offsetMinutes = 480, nowMs, cleaned,
} = {}) {
  if (!root) throw new TypeError('writeSupplement: root 必填');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const stamp = stampOf(generatedAt, offsetMinutes, now);
  const stampMs = Date.parse(stamp.replace(' ', 'T') + '+08:00');
  const ms = Number.isFinite(stampMs) ? stampMs : now;
  const day = dateStamp(ms, offsetMinutes);
  const bookId = `补记-${day}`;
  const file = path.join(root, `${bookId}.md`);
  const dateLabelStr = day.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const cleanedMap = cleaned !== undefined ? cleaned : readCleanedCodesCompat(root);

  const recByCode = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && r.code) recByCode.set(String(r.code), r);
  }
  const wanted = (Array.isArray(codes) && codes.length
    ? codes
    : (Array.isArray(records) ? records.map((r) => r && r.code) : [])
  ).filter(Boolean);

  // ① 只追加 + 追加前校验全册/尾部（P1-6）
  const warnings = [];
  let exists = fs.existsSync(file);
  let existingText = '';
  if (exists) {
    try { existingText = fs.readFileSync(file, 'utf8'); } catch (e) {
      throw new Error('E_SUPPLEMENT_READ_FAILED: ' + String((e && e.message) || e));
    }
    const analysis = analyzeSupplementBook(existingText);
    if (analysis.tailPartial.length > 0) {
      // 只允许恢复"末尾被截断的尾块"；中间块不完整属真损坏，拒绝自动修
      if (analysis.firstBad >= 0 && analysis.firstBad < analysis.blocks.length - 1) {
        throw new Error('E_SUPPLEMENT_BOOK_CORRUPT: 中间块不完整（firstBad=' + analysis.firstBad + '），拒绝自动恢复');
      }
      // 截断尾块恢复：只砍掉不完整的尾部（完整前缀逐字节保留）
      const prefix = existingText.slice(0, analysis.completePrefixEnd);
      if (!prefix.trim()) throw new Error('E_SUPPLEMENT_BOOK_CORRUPT: 文件头/首块不完整，拒绝恢复');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, prefix, 'utf8');
      fs.renameSync(tmp, file);
      warnings.push({ type: 'tail-repaired', removedBytes: existingText.length - prefix.length });
      existingText = prefix;
    }
    const v = verifySupplementBook(existingText, { bookId });
    if (!v.ok) {
      throw new Error('E_SUPPLEMENT_BOOK_CORRUPT: ' + JSON.stringify(v.issues.slice(0, 5)));
    }
  }

  // ② 编号：全册最大号 + 1（\d+，不回绕）
  const parsedExisting = exists ? parseSupplementBook(existingText) : { bookId: '', entries: [], unknownBlocks: [] };
  const seenCodes = new Set(parsedExisting.entries.map((e) => e.code));
  let seq = parsedExisting.entries.reduce((max, e) => {
    const m = SUPPLEMENT_ID_PARTS.exec(e.id);
    return m ? Math.max(max, Number(m[2])) : max;
  }, 0);

  const appended = [];
  for (const rawCode of wanted) {
    const code = String(rawCode);
    if (!parseCode(code)) { warnings.push({ type: 'bad-code', code }); continue; }
    if (seenCodes.has(code)) continue; // 幂等：同一编码只补一次
    const rec = recByCode.get(code);
    const recMs = rec && typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
    // 所属正册：优先按记录 ts 切周；没有记录时按编码日期段（会话开始日）兜底
    let week = null;
    if (Number.isFinite(recMs)) week = weekOf(recMs, offsetMinutes);
    else {
      const y = Number(code.slice(0, 4));
      const mo = Number(code.slice(4, 6));
      const d = Number(code.slice(6, 8));
      week = weekOf(Date.UTC(y, mo - 1, d) - offsetMinutes * 60 * 1000, offsetMinutes);
    }
    const sessKey = sessKeyOf(code);
    const bookRel = `${weeklyFolderName(week)}/${weeklyFileName(week, sessKey)}（已封板）`;
    const docRec = rec || { code, ts: `${code.slice(0, 4)}-${code.slice(4, 6)}-${code.slice(6, 8)}T00:00:00+08:00` };
    const original = originalLabel(resolveDoc(root, docRec, offsetMinutes, cleanedMap));
    const origTime = Number.isFinite(recMs) ? localStamp(recMs, offsetMinutes) : EMPTY;
    const hhmm = Number.isFinite(recMs) ? timeLabel(recMs, offsetMinutes) : EMPTY;
    const values = supplementRowValues({ code, original, time: hhmm, status: statusDefault(rec) });
    const why = oneLine((rec && rec.supplementReason) || reason);
    seq += 1;
    const id = `${bookId}-${String(seq).padStart(2, '0')}`;
    const hash = supplementEntryHash(values);
    appended.push({ id, code, origTime, bookRel, reason: why, hash, values, block: renderSupplementBlock({ id, code, origTime, bookRel, reason: why, hash, values }) });
    seenCodes.add(code);
  }

  let written = false;
  if (!exists) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, renderSupplementHead({ bookId, dateLabelStr, stamp }), 'utf8');
    written = true;
  }
  if (appended.length > 0) {
    appendDurable(file, appended.map((e) => e.block).join(''));
    written = true;
    // ③ 追加后回读校验（不完整/重复/哈希不对必须报出来）
    let afterText = '';
    try { afterText = fs.readFileSync(file, 'utf8'); } catch (e) {
      throw new Error('E_SUPPLEMENT_VERIFY_FAILED: readback failed: ' + String((e && e.message) || e));
    }
    const after = verifySupplementBook(afterText, { bookId });
    if (!after.ok) throw new Error('E_SUPPLEMENT_VERIFY_FAILED: ' + JSON.stringify(after.issues.slice(0, 5)));
  }
  const total = (parseSupplementBook(fs.readFileSync(file, 'utf8')).entries || []).length;
  return {
    path: file,
    bookId,
    written,
    added: appended.length,
    total,
    entries: appended.map(({ block, ...rest }) => rest),
    warnings,
  };
}

// ============================================================================
// 十二、分组
// ============================================================================

/**
 * 按"会话键 + 周段"给记录分组。
 *
 * @param {object[]} records
 * @param {number} offsetMinutes
 * @returns {Map<string, {w:object, sessKey:string, records:object[]}>}
 */
export function groupRecords(records, offsetMinutes = 480) {
  const groups = new Map();
  // D10（pending-only）：台账同一 code 只应有一条；这里再去重一次以防调用方重复传
  const deduped = dedupeRecordsByCode(records);
  for (const r of deduped.records) {
    if (!r || typeof r.ts !== 'string') continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    const sessKey = sessKeyOf(r.code);
    if (!sessKey) continue;
    const w = weekOf(ms, offsetMinutes);
    const gid = groupId(w, sessKey);
    if (!groups.has(gid)) groups.set(gid, { w, sessKey, records: [] });
    groups.get(gid).records.push(r);
  }
  return groups;
}

// ============================================================================
// 十三、月账视图（0.9.4-snap P3 · S-11 口径）
// ============================================================================
/**
 * @why 为什么月账是**视图**而不是新账：
 *      台账（ledger/*.jsonl）与封板 journal 才是事实源；月账只是"人读汇总"，
 *      由当月台账行 + 已封板周账事实 + 补记册摘要**派生**。删掉可随时重建，
 *      所以：① 不新增 xlsx；② 不进 tick；③ **只读不改台账/周账/journal**；
 *      ④ 已封板周只读封板事实（sealHash/rows 计数），不打开、不重算 xlsx。
 *
 * 落点（方案 §4.3）：`<root>/YYYY年MM月/MM月账.md`。
 * 滚动口径：只重算被点名的那个月；内容指纹不变则不重写；月末 + 3 天宽限后标记"已冻结"。
 */
export const MONTHLY_VIEW_VERSION = 1;
export const MONTHLY_GENERATOR = 'dsh-dialog-ledger-v0.4/monthly-view';

/** 月账文件名：`MM月账.md`（MM 两位）。 */
export function monthlyViewFileName(month) {
  return `${pad2(Number(month))}月账.md`;
}

/** 月账视图落点：`<root>/YYYY年MM月/MM月账.md`。 */
export function monthlyViewPath(root, year, month) {
  return path.join(root, ymLabel(year, month), monthlyViewFileName(month));
}

/** 流式统计当月台账（W5）：只读 `ledger/YYYY-MM-*.jsonl`，逐行解析、不整读。 */
function collectMonthlyLedger(root, year, month, offsetMinutes) {
  const ym = `${year}-${pad2(month)}`;
  const ledgerDir = path.join(root, 'ledger');
  const out = {
    files: [], rows: 0, bytes: 0, badLines: 0, nonLedgerRows: 0, badTs: 0, outOfMonth: 0,
    sessions: new Set(), groupRows: new Map(), rowsByWeek: new Map(),
  };
  let names = [];
  try { names = fs.readdirSync(ledgerDir); } catch { names = []; }
  const dayFiles = names
    .filter((n) => !n.startsWith('.') && n.endsWith('.jsonl') && n.startsWith(`${ym}-`))
    .sort();
  for (const n of dayFiles) {
    const file = path.join(ledgerDir, n);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    out.files.push(n);
    out.bytes += size;
    RUNTIME.monthlyFiles += 1;
    RUNTIME.monthlyBytes += size;
    const res = streamRangeLines(file, 0, Number.POSITIVE_INFINITY, (line) => {
      if (!line || !line.trim()) return;
      RUNTIME.monthlyLines += 1;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        out.badLines += 1;
        return;
      }
      if (!isLedgerRow(rec)) { out.nonLedgerRows += 1; return; }
      const ms = Date.parse(rec.ts);
      if (!Number.isFinite(ms)) { out.badTs += 1; return; }
      const wk = weekOf(ms, offsetMinutes);
      if (wk.year !== year || wk.month !== month) { out.outOfMonth += 1; return; }
      const sessKey = sessKeyOf(rec.code) || `?${String(rec.code)}`;
      out.rows += 1;
      out.sessions.add(sessKey);
      const gkey = `${wk.weekNo}|${sessKey}`;
      const g = out.groupRows.get(gkey) || { weekNo: wk.weekNo, sessKey, rows: 0 };
      g.rows += 1;
      out.groupRows.set(gkey, g);
      const b = out.rowsByWeek.get(wk.weekNo) || { rows: 0, sessions: new Set() };
      b.rows += 1;
      b.sessions.add(sessKey);
      out.rowsByWeek.set(wk.weekNo, b);
    });
    if (!res.ok) out.badLines += 1; // 打不开的日账按"坏行来源"记（不静默）
  }
  return out;
}

/**
 * 流式统计"所属正册在本月"的补记条目（W5）。
 * 补记册按写入日命名（`补记-YYYYMMDD.md`），一个月的周账条目可能散在任一册里，
 * 所以扫全部补记册、只按 block 里的 `- 所属正册:` 月份归属计数；不整读。
 */
function collectMonthlySupplements(root, year, month) {
  const monthPrefix = `${ymLabel(year, month)}/`;
  const out = { books: [], entries: 0, bytes: 0, byWeek: new Map() };
  let names = [];
  try { names = fs.readdirSync(root); } catch { names = []; }
  const books = names.filter((n) => /^补记-\d{8}\.md$/.test(n)).sort();
  for (const n of books) {
    const file = path.join(root, n);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    out.books.push(n);
    out.bytes += size;
    RUNTIME.monthlyFiles += 1;
    RUNTIME.monthlyBytes += size;
    let cur = null;
    const finalize = () => {
      if (!cur) return;
      if (cur.bookRel.startsWith(monthPrefix)) {
        out.entries += 1;
        const m = /第(\d+)周/.exec(cur.bookRel);
        if (m) out.byWeek.set(Number(m[1]), (out.byWeek.get(Number(m[1])) || 0) + 1);
      }
      cur = null;
    };
    streamRangeLines(file, 0, Number.POSITIVE_INFINITY, (line) => {
      const t = String(line).replace(/\r$/, '');
      if (t.startsWith('## 补记-')) { finalize(); cur = { bookRel: '' }; return; }
      if (cur && t.startsWith('- 所属正册: ')) cur.bookRel = t.slice('- 所属正册: '.length).trim();
      RUNTIME.monthlyLines += 1;
    });
    finalize();
  }
  return out;
}

/** 稳定字符串比较（码点序；不用 localeCompare —— 月账内容必须跨环境可复现）。 */
function cmpText(a, b) {
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 读本月封板事实（只读 journal 尾读缓存，不打开 xlsx）。 */
function collectMonthlySeals(root, year, month) {
  const j = journalIndexFor(root);
  const out = { events: 0, list: [], byWeek: new Map() };
  for (const [gid, info] of j.seals) {
    const m = /^(\d{4})-(\d{1,2})-(\d+)\|(.+)$/.exec(gid);
    if (!m) continue;
    if (Number(m[1]) !== year || Number(m[2]) !== month) continue;
    const item = { gid, weekNo: Number(m[3]), sessKey: m[4], info };
    out.events += 1;
    out.byWeek.set(item.weekNo, (out.byWeek.get(item.weekNo) || 0) + 1);
    out.list.push(item);
  }
  out.list.sort((a, b) => (a.weekNo - b.weekNo) || cmpText(a.sessKey, b.sessKey));
  return out;
}

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

/**
 * 构建月账视图（不落盘）：返回 `{path, content, fingerprint, summary}`。
 *
 * @param {object} p
 * @param {string} p.root 账库根
 * @param {number} p.year 年（如 2026）
 * @param {number} p.month 月（1–12）
 * @param {number} [p.offsetMinutes=480]
 * @param {string|number} [p.generatedAt] 生成时间（固定它 → 同一份数据字节可复现）
 * @param {number} [p.nowMs] 当前时刻（测试注入；决定"滚动中/已冻结"）
 * @param {number} [p.graceDays=GRACE_DAYS]
 */
export function buildMonthlyView({
  root, year, month, offsetMinutes = 480, generatedAt, nowMs, graceDays = GRACE_DAYS,
} = {}) {
  if (!root) throw new TypeError('buildMonthlyView: root 必填');
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 1970 || y > 9999) throw new TypeError('buildMonthlyView: year 非法');
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new TypeError('buildMonthlyView: month 非法');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const stamp = stampOf(generatedAt, offsetMinutes, now);
  const weeksDef = monthWeeks(y, m, offsetMinutes);
  const ledger = collectMonthlyLedger(root, y, m, offsetMinutes);
  const supp = collectMonthlySupplements(root, y, m);
  const sealed = collectMonthlySeals(root, y, m);
  // 月内组 = 台账行带来的（周号|会话键）∪ 该月封板事实里的
  const groups = new Map();
  for (const [k, g] of ledger.groupRows) groups.set(k, { ...g, sealed: null });
  let sealedWithoutRows = 0;
  for (const s of sealed.list) {
    const k = `${s.weekNo}|${s.sessKey}`;
    const g = groups.get(k);
    if (g) g.sealed = s.info;
    else {
      groups.set(k, { weekNo: s.weekNo, sessKey: s.sessKey, rows: 0, sealed: s.info });
      sealedWithoutRows += 1;
    }
  }
  const groupsArr = [...groups.values()]
    .sort((a, b) => (a.weekNo - b.weekNo) || cmpText(a.sessKey, b.sessKey));
  const totals = {
    rows: ledger.rows,
    sessions: ledger.sessions.size,
    groups: groupsArr.length,
    sealedGroups: groupsArr.filter((g) => !!g.sealed).length,
    unsealedGroups: groupsArr.filter((g) => !g.sealed).length,
    sealedEvents: sealed.events,
    sealedWithoutRows,
    supplementEntries: supp.entries,
  };
  const frozen = now >= weeksDef[weeksDef.length - 1].endMs + 1 + Number(graceDays) * DAY_MS;
  const weeksArr = weeksDef.map((w) => {
    const wkGroups = groupsArr.filter((g) => g.weekNo === w.n);
    return {
      weekNo: w.n,
      fromDay: w.fromDay,
      toDay: w.toDay,
      startDate: dateLabel(w.startMs, offsetMinutes),
      endDate: dateLabel(w.endMs, offsetMinutes),
      rows: (ledger.rowsByWeek.get(w.n) || { rows: 0 }).rows,
      sessions: (ledger.rowsByWeek.get(w.n) || { sessions: new Set() }).sessions.size,
      groups: wkGroups.length,
      sealedGroups: wkGroups.filter((g) => !!g.sealed).length,
      unsealedGroups: wkGroups.filter((g) => !g.sealed).length,
      supplements: supp.byWeek.get(w.n) || 0,
    };
  });
  const summary = {
    generator: MONTHLY_GENERATOR,
    version: MONTHLY_VIEW_VERSION,
    layoutVersion: LAYOUT_VERSION,
    offsetMinutes,
    year: y,
    month: m,
    monthLabel: ymLabel(y, m),
    range: {
      from: dateLabel(weeksDef[0].startMs, offsetMinutes),
      to: dateLabel(weeksDef[weeksDef.length - 1].endMs, offsetMinutes),
    },
    frozen,
    ledger: {
      files: ledger.files.length,
      rows: ledger.rows,
      bytes: ledger.bytes,
      badLines: ledger.badLines,
      nonLedgerRows: ledger.nonLedgerRows,
      badTs: ledger.badTs,
      outOfMonth: ledger.outOfMonth,
    },
    weeks: weeksArr,
    groups: groupsArr.map((g) => ({
      weekNo: g.weekNo,
      sessKey: g.sessKey,
      rows: g.rows,
      sealed: !!g.sealed,
      sealedAt: g.sealed ? String(g.sealed.sealedAt || '') : '',
      sealHash: g.sealed ? String(g.sealed.sealHash || '') : '',
      sealedRows: g.sealed && Number.isFinite(g.sealed.rows) ? g.sealed.rows : null,
      evidence: g.sealed ? 'journal' : '',
    })),
    sealedEvents: sealed.events,
    supplements: { books: supp.books.length, entries: supp.entries, bytes: supp.bytes },
    totals,
  };
  const fingerprint = journalSha256Hex(stableJson(summary));
  const content = renderMonthlyView({ summary, fingerprint, stamp });
  return {
    path: monthlyViewPath(root, y, m),
    content,
    fingerprint,
    summary,
  };
}

function renderMonthlyView({ summary, fingerprint, stamp }) {
  const t = summary.totals;
  const L = [];
  L.push(`# ${summary.monthLabel} 月账（视图）`);
  L.push('');
  L.push('> 性质：**派生视图**（由当月台账行 + 周账封板事实 + 补记册摘要生成），只读生成；');
  L.push('> 不修改台账 / 周账 xlsx / 封板日志；删除本文件后可随时重建（可重建 = 是）。');
  L.push(`> 生成器: ${summary.generator} v${summary.version}（lite 0.9.4-snap，周账版式 v${summary.layoutVersion}）`);
  L.push(`> 生成时间: ${stamp}（UTC+08:00）`);
  L.push(`> 内容指纹: ${fingerprint}`);
  L.push(`> 数据范围: ${summary.range.from} ~ ${summary.range.to}（UTC+08:00）｜状态: ${summary.frozen
    ? '已冻结（月末+宽限期后数据不再增长）'
    : '滚动中（当月，数据可能继续增长）'}`);
  L.push(`> 台账行: ${t.rows} ｜ 会话: ${t.sessions} ｜ 月内周账组: ${t.groups}（已封板 ${t.sealedGroups} / 未封板 ${t.unsealedGroups}）｜ 补记条目: ${t.supplementEntries}`);
  L.push('');
  L.push('## 一、月度合计');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('| --- | ---: |');
  L.push(`| 台账行数（当月） | ${t.rows} |`);
  L.push(`| 会话数（sessKey） | ${t.sessions} |`);
  L.push(`| 月内周账组 | ${t.groups} |`);
  L.push(`| 已封板周账组 | ${t.sealedGroups} |`);
  L.push(`| 未封板周账组 | ${t.unsealedGroups} |`);
  L.push(`| 封板事件（本月） | ${t.sealedEvents} |`);
  L.push(`| 补记条目（所属正册在本月） | ${t.supplementEntries} |`);
  L.push(`| 仅封板、台账无行的组 | ${t.sealedWithoutRows} |`);
  L.push('');
  L.push('## 二、每周小计');
  L.push('');
  L.push('| 周序 | 周段 | 台账行数 | 会话数 | 周账组（已封板/未封板） | 补记条目 |');
  L.push('| ---: | --- | ---: | ---: | ---: | ---: |');
  for (const w of summary.weeks) {
    L.push(`| 第${w.weekNo}周 | ${w.startDate} ~ ${w.endDate} | ${w.rows} | ${w.sessions} | ${w.groups}（${w.sealedGroups}/${w.unsealedGroups}） | ${w.supplements} |`);
  }
  L.push(`| **合计** | ${summary.range.from} ~ ${summary.range.to} | ${t.rows} | ${t.sessions} | ${t.groups}（${t.sealedGroups}/${t.unsealedGroups}） | ${t.supplementEntries} |`);
  L.push('');
  L.push('## 三、封板覆盖情况（月内周账组）');
  L.push('');
  L.push('| 周序 | 会话键 | 台账行数 | 状态 | 封板时间 | 封板hash | 封板行数 | 证据 |');
  L.push('| ---: | --- | ---: | --- | --- | --- | ---: | --- |');
  for (const g of summary.groups) {
    L.push(`| 第${g.weekNo}周 | ${g.sessKey} | ${g.rows} | ${g.sealed ? '已封板' : '未封板'} | ${g.sealedAt || '—'} | ${g.sealHash || '—'} | ${g.sealedRows === null ? '—' : g.sealedRows} | ${g.evidence || '—'} |`);
  }
  L.push('');
  L.push('## 四、口径与可重建声明');
  L.push('');
  L.push('- **月合计行数 = 当月台账行数**：流式逐行统计 `ledger/YYYY-MM-*.jsonl` 中 `ts` 归属本月且形状合法的账行（不读全文、不建索引）。');
  L.push('- **周小计**按 `lib/week.js: weekOf(ts)` 的月内周段（周一为起点、月界优先）；周段口径与周账一致。');
  L.push('- **封板覆盖以 `.seal-journal.jsonl` 为权威**（state 缓存只作兜底）；已封板周**只读封板事实**（sealHash/行数），不打开、不重算 xlsx。');
  L.push('- **补记条目**按补记册里「所属正册」的月份归属统计；只读补记册，不修改、不改号。');
  L.push('- **可重建**：删除本文件后重跑生成器即可；内容指纹不变则不重写（`written:false, reason:\'unchanged\'`）。');
  L.push('- 本视图**不是判据产物**：不进 xlsx、不参与对账、不影响封板/补记语义。');
  L.push('');
  return L.join('\n');
}

/**
 * 生成月账视图并原子落盘（只写 `<root>/YYYY年MM月/MM月账.md`，不碰任何其它文件）。
 *
 * @returns {{path:string, written:boolean, reason:string, fingerprint:string, summary:object, content:string}}
 *          `reason='unchanged'` = 内容指纹没变（已冻结/无新数据），不重写。
 */
export function writeMonthlyView(p = {}) {
  const built = buildMonthlyView(p);
  const file = built.path;
  let prev = null;
  try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 首次生成 */ }
  if (prev !== null) {
    const m = /^> 内容指纹: ([0-9a-f]{64})$/m.exec(prev);
    if (m && m[1] === built.fingerprint) {
      return { ...built, written: false, reason: 'unchanged' };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, built.content, null, 'utf8');
    fs.fsyncSync(fd); // 视图也 fsync：避免"看起来生成了、断电后半截"
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败不掩盖写入错误 */ }
  }
  fs.renameSync(tmp, file);
  return { ...built, written: true, reason: '' };
}
