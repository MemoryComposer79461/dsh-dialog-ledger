/**
 * @file handover.js
 * @role 交接表（表头目录）：每会话一份「主表 + 附表」，**只生成一次、封板后删了不重建**。
 * @called-by index.js（首轮入账后，Lead 接线）/ docs/自测-交接表模板.mjs
 * @depends 仅 node:fs / node:path / node:crypto（零第三方依赖）
 *
 * @why 为什么交接表是"表头目录"：
 *      它回答"这本账从哪一轮开始记、之前的上下文原件在哪"。
 *      删掉它，账仍能读，但"起账点"没了 —— 所以它只能生成一次，且生成后不可变。
 *
 * @why 为什么封板状态必须同时落在 `.state.json` 与文件头 YAML：
 *      state 是权威（防"删了重建"），文件头 YAML 是可搬、可人读的副本；
 *      两者不一致时以 state 为准并告警（契约 3.3 补充规则 1）。
 *
 * @why 为什么封板 hash 只认"正文"（从第一个 `# ` 行首到 EOF，不含 YAML）：
 *      v0.4 存在双语义（渲染返回 sha(正文)、写盘返回 sha(整份)），同一条规则两种答案。
 *      v1.3 收敛为一种口径：YAML 是可人读的表头，正文才是被封板锁定的内容。
 *      写盘前先算、写盘后按同一字节口径回读复算，不一致就拒绝承认封板。
 *
 * @why 为什么附表默认不截断、只有成品 > 8 MiB 才整块截断：
 *      机主明确"文件膨胀不是问题"（决定 2）；附表是启用插件前的上下文原件，
 *      截断等于丢证据。8 MiB 只是保护阈值，不是设计目标。
 *
 * @why 为什么附表里逐字照录的原文**不**做 CRLF→LF 归一（审计裁定，2026-11-09 Lead）：
 *      归一化是静默改写原始内容，后代无法判断"这行原来是 CRLF 还是 LF"；
 *      所以原文一律不改字节（CR、`{{`/`}}`、行首 `## ` 全保留），
 *      只有生成结构（YAML / 固定说明句 / block 标题行 / 元信息行 / 结束行）必须是 LF。
 *      明细见本文件「二、通用小工具」前的口径注释。
 *
 * 契约依据：`契约-v1.3/模板-启用及交接表-v1.3.md`、
 *           `契约-v1.3/模板-启用及交接表——附表-v1.3.md`、
 *           `契约-v1.3/实现checklist-v1.3.md`（HO-01~HO-31 / HA-01~HA-20）、
 *           `契约-v1.3/契约决定记录-v1.3.md` 决定 1、2、9。+ Lead 2026-11-09 审计裁定（原文不改字节）。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { appendSealEvent, latestSealEvent } from '../lib/sealjournal.js';
import {
  FILE_KIND, ensureSubdir, newLayoutPath, pathCandidates, resolveExisting,
} from '../lib/layout.js';

// ============================================================================
// 一、常量与命名
// ============================================================================

/** 数据总库第一级里交接表文件名的主体（S+D 连写后接这一段）。 */
const STEM = '的记忆数据库的启用及交接表';

/** 主表文件名（V0.6.2 起落在 `<root>/交接表/`；老库仍可能在一级，读侧双路径）。 */
export const MAIN_FILE_RE = /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表\.md$/;
/** 附表文件名（与主表同目录、同批生成：新布局 `交接表/`，老库一级兜底）。 */
export const APPENDIX_FILE_RE = /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表——附表\.md$/;
/** 13 位会话键：12 位短 ID + 1 位代差。 */
export const SESSKEY_RE = /^[0-9a-z]{12}[A-Z]$/;
/** 产物内时间统一 `YYYY-MM-DD HH:MM:SS`（+08:00 本地时间，不落 Z）。 */
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** 封板 hash：64 位小写 hex。 */
export const SEAL_HASH_RE = /^[0-9a-f]{64}$/;

/** 附表截断阈值：成品文件总字节上限 8 MiB（决定 2）。 */
export const HANDOVER_LIMIT_BYTES = 8 * 1024 * 1024;

/** 默认生成器标识：只要非空、无占位符（决定 9 #3，不约束格式）。 */
export const DEFAULT_GENERATOR = 'dsh-dialog-ledger-v0.4/handover';

/** 整块省略时的固定句（决定 9 #7 改写文案，逐字，不得改写）。 */
export const TRUNCATED_OMIT_SENTENCE =
  '（已截断）本表之后至插件接管前的内容未纳入本表；插件接管后的每一轮见第 3 级完整原文';

/** 单块自身超限时的块尾固定句（附表模板 3.4 第 4 条，逐字）。 */
export const TRUNCATED_BLOCK_SENTENCE =
  '（已截断）本块超出单文件上限，其余内容未纳入本表；插件接管后的每一轮见第 3 级完整原文';

/** state 里的封板键（与 `lib/ledger.js` 的 `.state.json` 同一文件）。 */
const SEAL_FIELD = 'handoverSealed';

// ============================================================================
// 二、通用小工具
// ============================================================================

const pad2 = (n) => String(n).padStart(2, '0');

/** sha256(utf8 字符串) → 64 位小写 hex。 */
function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 毫秒时间戳 → `YYYY-MM-DD HH:MM:SS`（固定 +08:00 语义，不依赖宿主时区）。
 *
 * @why 用 UTC getter + 手工偏移，而不是 `toLocaleString`：
 *      宿主时区不确定，`toLocaleString` 的结果会随机器而变；
 *      契约要求全系统 +08:00，只有手工偏移是确定的。
 */
export function stampLocal(ms, offsetMinutes = 480) {
  const offset = Number(offsetMinutes);
  const t = Number(ms);
  const base = Number.isFinite(t) ? t : Date.now();
  const shifted = new Date(base + (Number.isFinite(offset) ? offset : 480) * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ` +
    `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
}

/** 旧文件留档时间戳：`YYYYMMDD-HHMMSS`（+08:00）。 */
function archiveStamp(ms, offsetMinutes) {
  return stampLocal(ms, offsetMinutes).replace(/[-:]/g, '').replace(' ', '-');
}

const badArgs = (msg) => {
  const err = new Error(`E_HANDOVER_BAD_ARGS: ${msg}`);
  err.code = 'E_HANDOVER_BAD_ARGS';
  return err;
};

const hashMismatch = (msg, extra = {}) => {
  const err = new Error(`E_HANDOVER_HASH_MISMATCH: ${msg}`);
  err.code = 'E_HANDOVER_HASH_MISMATCH';
  Object.assign(err, extra);
  return err;
};

const bodyNotFound = (msg) => {
  const err = new Error(`E_HANDOVER_BODY_NOT_FOUND: ${msg}`);
  err.code = 'E_HANDOVER_BODY_NOT_FOUND';
  return err;
};

/**
 * 【原文逐字口径 · 审计裁定（2026-11-09 Lead）】
 * 附表正文里"逐字照录"的内容（user/assistant 的 text、thinking、tool/result 文本、
 * system 文本、非 JSON 的 arguments 原文等）**一律不改字节**：
 *   · CRLF / 孤立 CR 原样保留（不归一为 LF）；
 *   · 原文里的 `{{` / `}}` 原样保留（不转义、不删除）；
 *   · 原文里的行首 `## ` 原样保留（不缩进、不改写）。
 * 只有**生成结构**（YAML 前置块、固定说明句、`## N. role` 标题行、`[seq]` 元信息行、
 * 分隔线、结束行）必须是 LF 且无 CR —— 这部分由渲染函数用 '\n' 拼出，不来自原文。
 *
 * @why 不能"顺手把 CRLF 归一成 LF"：
 *      归一化是**静默改写原始内容**，后代无法判断"这行原来是 CRLF 还是 LF"；
 *      审计上比"保留 CR"严重得多。契约 H12/A18 的"无 CR"只约束生成结构，
 *      不覆盖逐字照录的原文（该条与 HA-11 逐字照录冲突时，以审计裁定为准）。
 */

/** YAML 双引号字符串：只接受不含引号/反斜杠/换行的安全值。 */
function dq(value, label) {
  const s = String(value);
  if (/[\r\n"\\]/.test(s)) throw badArgs(`${label} 含 YAML 双引号字符串不允许的字符：${JSON.stringify(s)}`);
  return `"${s}"`;
}

/** 校验 generator：非空、无占位符残留、单行、不含 YAML 双引号字符串的非法字符。 */
function assertGenerator(generator) {
  if (typeof generator !== 'string' || generator.length === 0) {
    throw badArgs('generator 必须是非空字符串');
  }
  if (generator.includes('{{') || generator.includes('}}')) {
    throw badArgs(`generator 不得包含占位符：${generator}`);
  }
  if (/[\r\n"\\]/.test(generator)) {
    throw badArgs(`generator 不得含换行/双引号/反斜杠：${generator}`);
  }
  return generator;
}

/** 解析 13 位会话键（12 位小写短 ID + 1 位大写代差）。 */
function splitKey(sessKey) {
  if (typeof sessKey !== 'string' || !SESSKEY_RE.test(sessKey)) {
    throw badArgs(`sessKey 必须是 12 位小写短 ID + 1 位大写代差，收到：${JSON.stringify(sessKey)}`);
  }
  return { s12: sessKey.slice(0, 12), gen: sessKey.slice(12) };
}

/** 生成时刻：允许显式传入（测试/复算），否则取 nowMs/当前时刻。 */
function resolveDatetime(generatedAt, nowMs, offsetMinutes) {
  if (generatedAt !== undefined && generatedAt !== null && generatedAt !== '') {
    if (typeof generatedAt !== 'string' || !DATETIME_RE.test(generatedAt)) {
      throw badArgs(`generatedAt 必须匹配 ${DATETIME_RE}，收到：${JSON.stringify(generatedAt)}`);
    }
    return generatedAt;
  }
  const ms = Number(nowMs);
  return stampLocal(Number.isFinite(ms) ? ms : Date.now(), offsetMinutes);
}

function resolveOffset(offsetMinutes) {
  const n = Number(offsetMinutes);
  if (!Number.isFinite(n) || n < -12 * 60 || n > 14 * 60) throw badArgs(`offsetMinutes 非法：${offsetMinutes}`);
  return n;
}

// ============================================================================
// 三、README 级入口：文件名与正文口径
// ============================================================================

/** 主表文件名：`{S}{D}的记忆数据库的启用及交接表.md`（一级根目录）。 */
export function handoverMainName(sessKey) {
  return `${sessKey}${STEM}.md`;
}

/** 附表文件名：`{S}{D}的记忆数据库的启用及交接表——附表.md`（与主表同目录）。 */
export function handoverAppendixName(sessKey) {
  return `${sessKey}${STEM}——附表.md`;
}

/**
 * 取"正文"：文件内第一个以 `# ` 开头的行（行首）到文件末尾，含结尾换行。
 *
 * @param {string} markdown 整份 markdown（YAML + 正文）
 * @returns {string} 正文；找不到 `# ` 行时返回空串（调用方必须当错误处理）
 *
 * @why 用行首锚点 `/^# /m` 而不是"跳过 YAML 前置块"：
 *      前置块里的值理论上也可能出现 `# `，但不可能出现在**行首**（YAML 是 `键: 值`）。
 *      正文 H1 是唯一一个行首 `# `，锚点唯一，才能精确切出被封板的字节。
 */
export function handoverBodyOf(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  const m = /^# /m.exec(markdown);
  return m ? markdown.slice(m.index) : '';
}

/** 重算一份主表的封板 hash；无正文时返回空串（= 不可复核）。 */
export function handoverBodyHash(markdown) {
  const body = handoverBodyOf(markdown);
  return body ? sha256hex(body) : '';
}

/** 从 YAML 里读 `封板hash`；缺失或格式不对返回空串。 */
export function handoverSealFromYaml(markdown) {
  if (typeof markdown !== 'string') return '';
  const m = /^封板hash: '([0-9a-f]{64})'$/m.exec(markdown);
  return m ? m[1] : '';
}

/**
 * 轻量读取 YAML 前置块（只做渲染产物自检用，不追求通用 YAML 能力）。
 *
 * @param {string} markdown
 * @returns {{keys:string[], fields:Record<string,string>}}
 *          键序 = 出现顺序；值去掉单/双引号，布尔与数字保持字面量字符串。
 */
export function handoverYamlFields(markdown) {
  const out = { keys: [], fields: {} };
  if (typeof markdown !== 'string' || !markdown.startsWith('---\n')) return out;
  const close = markdown.indexOf('\n---\n', 4);
  if (close === -1) return out;
  for (const line of markdown.slice(4, close).split('\n')) {
    if (!line) continue;
    const m = /^([^:\s][^:]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    out.keys.push(m[1]);
    let v = m[2];
    if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
      v = v.slice(1, -1);
    }
    out.fields[m[1]] = v;
  }
  return out;
}

// ============================================================================
// 四、主表渲染（模板正文逐字对齐 v1.3 第二节）
// ============================================================================

/**
 * 渲染主表。
 *
 * 模板正文五部分：抬头表 / 声明 / 相关文件 / 数据库架构 / 结束行。
 * HTML 注释（文件名规则）属模板编辑说明，不进产物 —— 决定 1 的"正文"定义为
 * 抬头表 + 声明 + 相关文件 + 数据库架构（模板-启用及交接表-v1.3 §五 差异清单第 6 条），
 * 且模板注释里的 `{S}{D}` 只是说明文字，不是产物内容。
 *
 * @param {object} p
 * @param {string} p.sessKey 13 位会话键（12 位小写短 ID + 1 位大写代差）
 * @param {string} [p.generator] 生成器标识（非空、无占位符）
 * @param {string} [p.generatedAt] 显式生成时间（`YYYY-MM-DD HH:MM:SS`，测试/复算用）
 * @param {number} [p.nowMs] 生成时刻毫秒（默认 Date.now()）
 * @param {number} [p.offsetMinutes] 时区偏移分钟（默认 480 = +08:00）
 * @returns {{markdown:string, sealHash:string, body:string, name:string, datetime:string}}
 *          `sealHash` = sha256(正文)，与 YAML `封板hash` 同值；
 *          `markdown` 已含 YAML 前置块与恰好一个结尾换行。
 */
export function renderHandoverMain({
  sessKey, generator = DEFAULT_GENERATOR, generatedAt, nowMs, offsetMinutes = 480,
} = {}) {
  const { s12, gen } = splitKey(sessKey);
  assertGenerator(generator);
  const offset = resolveOffset(offsetMinutes);
  const datetime = resolveDatetime(generatedAt, nowMs, offset);

  const name = `${sessKey}${STEM}`;
  const appendixName = handoverAppendixName(sessKey);
  const body = renderMainBody({ name, s12, gen, datetime, generator, appendixName });
  const sealHash = sha256hex(body);

  const yaml = [
    '---',
    `名称: ${dq(name, '名称')}`,
    `会话标识: ${dq(s12, '会话标识')}`,
    `代差: ${dq(gen, '代差')}`,
    `委托人: ${dq('user', '委托人')}`,
    `执行: ${dq('日常会话记录插件（Tool）', '执行')}`,
    `记录: ${dq('系统（Cordis）', '记录')}`,
    `生成器: ${dq(generator, '生成器')}`,
    `生成时间: ${dq(datetime, '生成时间')}`,
    `附表: ${dq(appendixName, '附表')}`,
    '封板: true',
    `封板hash: '${sealHash}'`,
    '---',
    '',
  ].join('\n');

  return { markdown: yaml + '\n' + body, sealHash, body, name, datetime };
}

/** 主表正文（逐字对齐 `模板-启用及交接表-v1.3.md` 第二节，段落与空白不增不删）。 */
function renderMainBody({ name, s12, gen, datetime, generator, appendixName }) {
  const lines = [
    `# ${name}`,
    '',
    '| 项目   | 内容                                      |',
    '|:---- |:--------------------------------------- |',
    `| 名称   | ${name}       |`,
    `| 会话标识 | ${s12}（前十二位 Session ID）          |`,
    `| 代差   | ${gen}（会话级属性，一经分配终身不变）                  |`,
    '| 委托人  | user                                    |',
    '| 执行   | 日常会话记录插件（Tool）                          |',
    '| 记录   | 系统（Cordis）                              |',
    `| 生成时间 | ${datetime}（UTC+08:00）                 |`,
    `| 附表   | ${appendixName} |`,
    '',
    '## 声明',
    '',
    `这是一份关于记忆数据库系统对 ${s12} 会话的启用及交接表，该表仅生成一份，若错误删除，则不再生成，请务必保留。该表的作用及要求有：`,
    '',
    '1. 说明记录会话主体。',
    '2. 赋予 user 管理、修改、审计等权利，但后果自负。',
    '3. 给予 Agent 使用权和修改权，但不给予审计权，且修改需获得 user 授权。',
    '4. 该数据库为共享库，不对任何会话进行屏蔽。★ 会话不默认知晓自己的 Session ID，须先自查（调用本插件工具 / 问 user）方可定位自己的账。',
    '',
    '## 相关文件',
    '',
    '| 文件 | 说明 |',
    '|:-- |:-- |',
    `| 《${appendixName}》 | 插件启用前的上下文原件，逐条照录 |`,
    '| 《xx月总“完整原文”文件夹/…》 | 启用之后每一轮的完整原文 |',
    '',
    '## 数据库架构',
    '',
    '- **第一级：数据总库**',
    '  - 启用及交接表（每个 Session 一份，★ 以「十二位 Session ID + 代差」命名）',
    '  - “完整原文”清理报告',
    '  - 各月份文件夹：`xx年xx月`',
    '- **第二级：XX月份文件夹**',
    '  - 周记账：`xx月第x周-{S}{D}的周记账.xlsx`',
    '  - “完整原文”文件夹（第三级，见下）',
    '- **第三级：xx月总“完整原文”文件夹**',
    '  - 以编码命名的文件：`YYYYMMDD-SSSSSSSSSSSS-D-NNNNNNNN 完整原文.md`（32 位）',
    '',
    '### 存放规则',
    '',
    '- 所有 Session 的启用及交接表、“完整原文”清理报告，均放在**第一层**',
    '- 所有 Session 的周记账，均放在**第二层**',
    '- 所有 Session 的“完整原文”，均放在**第三层**',
    '',
    '---',
    '',
    `**结束** · ${s12}${gen} · 生成器 ${generator}`,
  ];
  return lines.join('\n') + '\n';
}

// ============================================================================
// 五、附表渲染：5 类 block（user / assistant / tool-call / tool-result / system）
// ============================================================================

/** 附表 YAML（7 键，顺序固定：名称、会话标识、代差、父表、上下文条数、生成器、生成时间）。 */
function renderAppendixYaml({ sessKey, s12, gen, count, generator, datetime }) {
  return [
    '---',
    `名称: ${dq(`${sessKey}${STEM}——附表`, '名称')}`,
    `会话标识: ${dq(s12, '会话标识')}`,
    `代差: ${dq(gen, '代差')}`,
    `父表: ${dq(handoverMainName(sessKey), '父表')}`,
    `上下文条数: ${count}`,
    `生成器: ${dq(generator, '生成器')}`,
    `生成时间: ${dq(datetime, '生成时间')}`,
    '---',
    '',
  ].join('\n');
}

/** 附表抬头（H1 + 三行引用块）与结尾（引用块 + --- + 结束行）的固定文案。 */
const APPENDIX_H1 = (sessKey) => `# ${sessKey}${STEM}——附表`;
const APPENDIX_QUOTE_1 = '> 本表是启用插件前的上下文原件，逐条照录：不改写、不摘要、不省略、不调序。';
const APPENDIX_QUOTE_2 = (sessKey) => `> 主体信息、权限约定与目录规则见《${handoverMainName(sessKey)}》。`;
const APPENDIX_QUOTE_3 = '> 新会话在首轮即启用插件的，本表正文写「无」，不保留空块。';
const APPENDIX_CLOSING = '> 以上为插件启动接管前的全部上下文，此后每一轮另见「完整原文」文件。';

const EMPTY_CONTENT = '（无文本内容）';

/**
 * 事件 → block 列表（已过滤、已按 seq 升序）。
 *
 * 过滤规则（附表模板 3.5）：`user/message` 只收 `data.source.kind === "user"`，
 * 其余注入 kind（runtime-context / skill-catalog / compact-checkpoint / model-selection /
 * agent-message / subagent-settled / user-approval / time-context 等）一律不收；
 * 其他事件类型不做 kind 过滤。
 *
 * @param {object[]} events 覆盖范围内的上下文事件（顺序无所谓，内部按 seq 排）
 * @param {number} offsetMinutes
 * @param {string} fallbackDatetime 事件缺 time 时的兜底时间（保证元信息行格式合法）
 * @returns {{blocks:Array<{role:string,seq:number,timeText:string,content:string}>,
 *            total:number, filtered:Record<string,number>}}
 */
function buildAppendixBlocks(events, offsetMinutes, fallbackDatetime) {
  const list = Array.isArray(events) ? events : [];
  const filtered = {};
  const normalized = [];

  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
    const seq = Number.isInteger(ev.seq) ? ev.seq : i + 1;
    normalized.push({ ev, seq, order: i });
  }
  // 严格按 seq 升序；seq 相同（异常数据）保持输入顺序，不编造 seq。
  normalized.sort((a, b) => (a.seq - b.seq) || (a.order - b.order));

  // tool/call 映射：callId → seq、name → seq 列表，供 assistant 的 tool_use 指针定位。
  const callIdToSeq = new Map();
  const nameToSeqs = new Map();
  for (const { ev, seq } of normalized) {
    if (ev.type !== 'tool/call') continue;
    const data = ev.data || {};
    const callId = typeof data.callId === 'string' ? data.callId : '';
    if (callId && !callIdToSeq.has(callId)) callIdToSeq.set(callId, seq);
    const name = typeof data.name === 'string' ? data.name : '';
    if (name) {
      if (!nameToSeqs.has(name)) nameToSeqs.set(name, []);
      nameToSeqs.get(name).push(seq);
    }
  }

  const blocks = [];
  const usedCallSeqs = new Set();

  for (const { ev, seq } of normalized) {
    const timeText = Number.isFinite(ev.time) && ev.time > 0
      ? stampLocal(ev.time, offsetMinutes)
      : fallbackDatetime;

    if (ev.type === 'user/message') {
      const kind = ev.data && ev.data.source && ev.data.source.kind;
      if (kind !== 'user') {
        const key = typeof kind === 'string' && kind ? kind : '（未标注 kind）';
        filtered[key] = (filtered[key] || 0) + 1;
        continue;
      }
      blocks.push({ role: 'user/message', seq, timeText, content: renderUserContent(ev.data) });
      continue;
    }

    if (ev.type === 'assistant/message') {
      blocks.push({
        role: 'assistant/message', seq, timeText,
        content: renderAssistantContent(ev, callIdToSeq, nameToSeqs, usedCallSeqs),
      });
      continue;
    }

    if (ev.type === 'tool/call') {
      blocks.push({ role: 'tool/call', seq, timeText, content: renderToolCallContent(ev.data) });
      continue;
    }

    if (ev.type === 'tool/result') {
      blocks.push({ role: 'tool/result', seq, timeText, content: renderToolResultContent(ev.data) });
      continue;
    }

    if (ev.type === 'system/message') {
      blocks.push({ role: 'system/message', seq, timeText, content: renderSystemContent(ev.data) });
    }
    // 其余事件类型不进附表（本表只承载 5 类上下文）。
  }

  return { blocks, total: blocks.length, filtered };
}

/** `user/message`：全部 text 块按原顺序拼接；image/file 用占位并在块尾注明。 */
function renderUserContent(data) {
  const content = data && Array.isArray(data.content) ? data.content : [];
  const parts = [];
  let hasNonText = false;
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text); // 原文逐字，不归一 CR、不裁剪空白
    } else if (c.type === 'image') {
      parts.push('[图片]');
      hasNonText = true;
    } else if (c.type === 'file') {
      const n = c.name || c.filename || (c.attachment && c.attachment.name) || '';
      parts.push(n ? `[文件] ${n}` : '[文件]');
      hasNonText = true;
    }
  }
  let out = parts.join('\n\n'); // 内容块之间的空行属于结构，原文块本身不动
  if (hasNonText) out += (out ? '\n\n' : '') + '（非文本块，已保留占位）';
  return out || EMPTY_CONTENT;
}

/**
 * `assistant/message`：text 展开；thinking/reasoning 用 <details> 折叠；tool_use 只留指针。
 *
 * @why 兼容两种块名：契约写的 `thinking`/`tool_use` 是规范名，
 *      而本机 session.v4.jsonl 实测是 `reasoning`/`tool-call`（DSH 实际序列化名）。
 *      两种都认，才能既满足契约、又能直接吃真实会话；不丢块、不改写原文。
 */
function renderAssistantContent(ev, callIdToSeq, nameToSeqs, usedCallSeqs) {
  const message = ev.data && ev.data.message;
  const content = message && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text); // 原文逐字
      continue;
    }
    if (c.type === 'thinking' || c.type === 'reasoning') {
      const thought = typeof c.thinking === 'string' ? c.thinking
        : (typeof c.text === 'string' ? c.text : '');
      // <details> 包装是结构（生成），其中的思考原文逐字保留，不做 CR 归一/裁剪。
      parts.push(`<details><summary>thinking</summary>\n\n${thought}\n\n</details>`);
      continue;
    }
    if (c.type === 'tool_use' || c.type === 'tool-call') {
      const callSeq = resolveToolCallSeq(c, ev.seq, callIdToSeq, nameToSeqs, usedCallSeqs);
      parts.push(`→ tool/call [seq ${callSeq === null ? '?' : callSeq}]`);
    }
  }
  return parts.join('\n\n') || EMPTY_CONTENT;
}

/**
 * tool_use 指针的目标 seq。
 *
 * 优先用块里的 callId 精确匹配 `tool/call.data.callId`（真实数据 100% 可配）；
 * 退化为"同名、尚未被指过的第一个 tool/call"；再不行只能写 `?`（不编造 seq）。
 */
function resolveToolCallSeq(block, assistantSeq, callIdToSeq, nameToSeqs, usedCallSeqs) {
  const id = block.id || block.tool_use_id || block.toolCallId || block.callId || '';
  if (typeof id === 'string' && id && callIdToSeq.has(id)) {
    const s = callIdToSeq.get(id);
    usedCallSeqs.add(s);
    return s;
  }
  const name = typeof block.name === 'string' ? block.name : '';
  if (name && nameToSeqs.has(name)) {
    for (const s of nameToSeqs.get(name)) {
      if (!usedCallSeqs.has(s) && s >= assistantSeq) {
        usedCallSeqs.add(s);
        return s;
      }
    }
    for (const s of nameToSeqs.get(name)) {
      if (!usedCallSeqs.has(s)) { usedCallSeqs.add(s); return s; }
    }
  }
  return null;
}

/**
 * `tool/call`：第一行 `工具: {name}`，空行，然后参数。
 *
 * 参数口径（契约 3.1 明确要求"二次解析 + JSON.stringify(parsed, null, 2)"）：
 *   · arguments 是 JSON 字符串 → 解析后按两空格缩进重新序列化（**这是契约规定的格式化，
 *     不是逐字照录**；原始 arguments 的字节会被重排，已在交付报告里列明）；
 *   · 解析失败 → 原文照录（不改字节）+ 标注 `（arguments 非 JSON，原文照录）`；
 *   · 缺失 → `（无参数）` 占位。
 */
function renderToolCallContent(data) {
  const name = data && typeof data.name === 'string' && data.name ? data.name : '?';
  const raw = data ? data.arguments : undefined;
  let argsText;
  if (typeof raw === 'string') {
    try {
      argsText = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      argsText = `${raw}\n\n（arguments 非 JSON，原文照录）`;
    }
  } else if (raw !== undefined && raw !== null) {
    try {
      argsText = JSON.stringify(raw, null, 2);
    } catch {
      argsText = String(raw);
    }
  } else {
    argsText = '（无参数）';
  }
  return `工具: ${name}\n\n${argsText || EMPTY_CONTENT}`;
}

/** `tool/result`：第一行状态 ok/error，空行，然后 text 块拼接；无文本给固定占位。 */
function renderToolResultContent(data) {
  const d = data || {};
  const message = d.message || {};
  const protocolError = d.error !== undefined && d.error !== null && d.error !== false;
  const isError = message.isError === true || protocolError;
  const content = Array.isArray(message.content) ? message.content : [];
  const texts = [];
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') texts.push(c.text); // 原文逐字
  }
  const body = texts.join('\n\n');
  return `状态: ${isError ? 'error' : 'ok'}\n\n${body || EMPTY_CONTENT}`;
}

/** `system/message`：原文照录（兼容 content 数组 / 字符串两种形态）。 */
function renderSystemContent(data) {
  const d = data || {};
  const message = d.message;
  let text = '';
  if (typeof message === 'string') {
    text = message;
  } else if (message && typeof message.content === 'string') {
    text = message.content;
  } else if (message && Array.isArray(message.content)) {
    text = message.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n\n');
  } else if (typeof d.text === 'string') {
    text = d.text;
  } else if (typeof d.content === 'string') {
    text = d.content;
  }
  return text || EMPTY_CONTENT; // 原文逐字：不归一 CR、不裁剪空白
}

/** 单个 block 的 markdown 块：`## N. role` 紧跟元信息行，空一行再写内容。 */
function blockChunk(n, block) {
  return `## ${n}. ${block.role}\n[seq ${block.seq}] ${block.timeText}\n\n${block.content}`;
}

/** 附表成品 markdown 的最大字节数（用于组装与自测）。 */
function appendixDocBytes(chunks, { count, total, truncated, singleBlockTruncated, yamlText, headText, closingText }) {
  let midBytes = 0;
  if (count === 0) {
    midBytes = Buffer.byteLength('无\n\n', 'utf8');
  } else {
    for (let i = 0; i < count; i++) midBytes += Buffer.byteLength(chunks[i], 'utf8');
    if (count > 1) midBytes += 2 * (count - 1); // join('\n\n')
    midBytes += 2; // chunkJoin 之后的空行
    if (truncated) {
      midBytes += Buffer.byteLength(
        singleBlockTruncated
          ? `> ${TRUNCATED_OMIT_SENTENCE}\n\n`
          : `> ${TRUNCATED_OMIT_SENTENCE}（应录 ${total} 条，实际收录 ${count} 条）\n\n`,
        'utf8'
      );
    }
  }
  return Buffer.byteLength(yamlText, 'utf8') + 1 + Buffer.byteLength(headText, 'utf8') +
    midBytes + Buffer.byteLength(closingText, 'utf8');
}

/** 组装附表成品（唯一入口，保证字节口径一致）。 */
function assembleAppendix({ sessKey, yamlText, chunks, count, total, truncated, singleBlockTruncated }) {
  const headText = [
    APPENDIX_H1(sessKey),
    '',
    APPENDIX_QUOTE_1,
    APPENDIX_QUOTE_2(sessKey),
    APPENDIX_QUOTE_3,
    '',
  ].join('\n') + '\n';
  const closingText = `${APPENDIX_CLOSING}\n\n---\n\n**结束** · ${sessKey} · 共 ${count} 条 · 生成器 ${yamlText.generator}\n`;

  let mid = '';
  if (count === 0) {
    mid = '无\n\n';
  } else {
    mid = chunks.slice(0, count).join('\n\n') + '\n\n';
    if (truncated) {
      mid += singleBlockTruncated
        ? `> ${TRUNCATED_OMIT_SENTENCE}\n\n`
        : `> ${TRUNCATED_OMIT_SENTENCE}（应录 ${total} 条，实际收录 ${count} 条）\n\n`;
    }
  }
  return yamlText.text + '\n' + headText + mid + closingText;
}

/**
 * 渲染附表：启用插件前的上下文原件（5 类 block，默认不截断）。
 *
 * **逐字照录区不改字节**（审计裁定）：5 类 block 里的原文（text/thinking/tool result/system、
 * 非 JSON arguments）按事件里的原字符串输出，CRLF/CR、`{{`/`}}`、行首 `## ` 都保留；
 * 只在其外围拼接生成结构（标题行、元信息行、空行、`<details>` 包装、占位/标注、固定说明句）。
 * 唯一例外是 tool/call 的 JSON arguments：契约 3.1 明确要求"二次解析 + 两空格缩进重新序列化"，
 * 这属于契约规定的格式化，不是逐字照录（已在实现报告里列明）。
 *
 * @param {object} p
 * @param {object[]} p.events 覆盖范围内的事件（调用方用 selectHandoverContextEvents 切好；
 *                            内部仍按 seq 升序排，不按 role 分组；空上下文必须显式传 []）
 * @param {string} p.sessKey 13 位会话键
 * @param {string} [p.generator] 生成器标识
 * @param {string} [p.generatedAt] 显式生成时间
 * @param {number} [p.nowMs] 生成时刻毫秒
 * @param {number} [p.offsetMinutes] 时区偏移分钟（默认 480）
 * @param {number} [p.limitBytes] 截断阈值（默认 8 MiB；测试可调小）
 * @returns {{markdown:string, count:number, total:number, truncated:boolean,
 *            singleBlockTruncated:boolean, filtered:object, bytes:number,
 *            name:string, datetime:string}}
 *          `count` = 实际收录条数（= YAML 上下文条数 = `## ` 标题数 = `{{n}}` 最大值）；
 *          `total` = 应录条数（= 覆盖范围内 block 总数）。
 */
export function renderHandoverAppendix({
  events, sessKey, generator = DEFAULT_GENERATOR, generatedAt, nowMs,
  offsetMinutes = 480, limitBytes = HANDOVER_LIMIT_BYTES,
} = {}) {
  const { s12, gen } = splitKey(sessKey);
  assertGenerator(generator);
  // 空上下文必须显式传 []：漏传参数造成的"空表"是谎报（附表会声称"接管前无上下文"），
  // 宁可报参数错误并让调用方看见，也不写一份假空表。
  if (!Array.isArray(events)) throw badArgs('events 必须是数组（覆盖范围内无上下文时请显式传 []）');
  const offset = resolveOffset(offsetMinutes);
  const limit = Number(limitBytes);
  if (!Number.isInteger(limit) || limit <= 0) throw badArgs(`limitBytes 必须是正整数，收到：${limitBytes}`);
  const datetime = resolveDatetime(generatedAt, nowMs, offset);
  const name = handoverAppendixName(sessKey);

  const { blocks, total, filtered } = buildAppendixBlocks(events, offset, datetime);
  const chunks = blocks.map((b, i) => blockChunk(i + 1, b));
  const yamlOf = (count) => {
    const text = renderAppendixYaml({ sessKey, s12, gen, count, generator, datetime });
    return { text, generator };
  };
  const headText = [
    APPENDIX_H1(sessKey), '', APPENDIX_QUOTE_1, APPENDIX_QUOTE_2(sessKey), APPENDIX_QUOTE_3, '',
  ].join('\n') + '\n';
  const closingOf = (count) => `${APPENDIX_CLOSING}\n\n---\n\n**结束** · ${sessKey} · 共 ${count} 条 · 生成器 ${generator}\n`;

  const assemble = (count, truncated, singleBlockTruncated) => assembleAppendix({
    sessKey,
    yamlText: yamlOf(count),
    chunks,
    count,
    total,
    truncated,
    singleBlockTruncated,
  });

  const result = (markdown, count, truncated, singleBlockTruncated) => ({
    markdown,
    count,
    total,
    truncated,
    singleBlockTruncated,
    filtered,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    name,
    datetime,
  });

  // ① 空表：YAML 上下文条数: 0，正文只写一行「无」，不留任何 block。
  if (total === 0) {
    return result(assemble(0, false, false), 0, false, false);
  }

  // ② 默认不截断：不超限原样返回（成品总字节 = YAML + 正文）。
  const fullYaml = yamlOf(total);
  const fullBytes = appendixDocBytes(chunks, {
    count: total, total, truncated: false, singleBlockTruncated: false,
    yamlText: fullYaml.text, headText, closingText: closingOf(total),
  });
  if (fullBytes <= limit) {
    return result(assemble(total, false, false), total, false, false);
  }

  // ③ 整块截断：按 block 顺序收录，找到最大的 k（1..total-1）使成品 ≤ 阈值。
  const chunkBytes = chunks.map((c) => Buffer.byteLength(c, 'utf8'));
  const prefixBytes = new Array(total + 1).fill(0);
  for (let i = 0; i < total; i++) prefixBytes[i + 1] = prefixBytes[i] + chunkBytes[i];

  const estimate = (k) => {
    const yamlText = yamlOf(k);
    const yamlBytes = Buffer.byteLength(yamlText.text, 'utf8');
    const headBytes = Buffer.byteLength(headText, 'utf8');
    const closingBytes = Buffer.byteLength(closingOf(k), 'utf8');
    const blocksPart = prefixBytes[k] + (k > 1 ? 2 * (k - 1) : 0) + 2;
    const markerBytes = k < total
      ? Buffer.byteLength(`> ${TRUNCATED_OMIT_SENTENCE}（应录 ${total} 条，实际收录 ${k} 条）\n\n`, 'utf8')
      : 0;
    return yamlBytes + 1 + headBytes + blocksPart + markerBytes + closingBytes;
  };

  // 从"最多能放下的条数"向下收敛（截断行本身也占字节，可能要多退一条）。
  let k = total - 1;
  while (k >= 1) {
    if (estimate(k) <= limit) break;
    k--;
  }
  if (k >= 1) {
    const md = assemble(k, true, false);
    return result(md, k, true, false);
  }

  // ④ 单块自身 > 阈值：在该块内截断文本（只保留完整 UTF-8 字符），块尾写固定句。
  const first = blocks[0];
  const probeChunk = blockChunk(1, { ...first, content: TRUNCATED_BLOCK_SENTENCE });
  const probeYaml = yamlOf(1);
  const probeBytes = appendixDocBytes([probeChunk], {
    count: 1, total, truncated: true, singleBlockTruncated: true,
    yamlText: probeYaml.text, headText, closingText: closingOf(1),
  });
  let allowed = limit - (probeBytes - Buffer.byteLength(TRUNCATED_BLOCK_SENTENCE, 'utf8'));
  if (allowed < 0) allowed = 0;
  let content = truncateUtf8(first.content, allowed);
  let singleChunk = blockChunk(1, {
    ...first,
    content: content ? `${content}\n\n> ${TRUNCATED_BLOCK_SENTENCE}` : `> ${TRUNCATED_BLOCK_SENTENCE}`,
  });
  let md = assembleAppendix({
    sessKey,
    yamlText: probeYaml,
    chunks: [singleChunk],
    count: 1,
    total,
    truncated: true,
    singleBlockTruncated: true,
  });
  // 兜底：若因探针与成品差几个字节仍超限，逐次收紧（不会进入无限循环）。
  for (let guard = 0; guard < 8 && Buffer.byteLength(md, 'utf8') > limit; guard++) {
    allowed = Math.max(0, allowed - (Buffer.byteLength(md, 'utf8') - limit + 8));
    content = truncateUtf8(first.content, allowed);
    singleChunk = blockChunk(1, {
      ...first,
      content: content ? `${content}\n\n> ${TRUNCATED_BLOCK_SENTENCE}` : `> ${TRUNCATED_BLOCK_SENTENCE}`,
    });
    md = assembleAppendix({
      sessKey,
      yamlText: probeYaml,
      chunks: [singleChunk],
      count: 1,
      total,
      truncated: true,
      singleBlockTruncated: true,
    });
  }
  return result(md, 1, true, true);
}

/**
 * 按字节上限截断字符串，且只保留到最后一个**完整 UTF-8 字符**边界。
 *
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(s, maxBytes) {
  const str = String(s);
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= limit) return str;
  let end = Math.min(limit, buf.length);
  // 若切点落在后续字节（10xxxxxx）上，向前退到该字符的首字节之前（整字符丢弃）。
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 取"插件接管前"的上下文事件：从第一条事件起，到第一个入账轮次的 `turn/start` 之前（不含）。
 *
 * @param {object[]} events 会话全部事件（按文件顺序）
 * @param {number} firstTurn 第一条入账轮次的 turn 号（台账里该会话最早一条记录的 `turn`）
 * @returns {object[]} 覆盖范围内事件；找不到该轮 `turn/start` 时返回全部（不静默丢弃）
 */
export function selectHandoverContextEvents(events, firstTurn) {
  const list = Array.isArray(events) ? events : [];
  const turn = Number(firstTurn);
  if (!Number.isInteger(turn) || turn <= 0) return [...list];
  const out = [];
  for (const ev of list) {
    if (ev && ev.type === 'turn/start' && ev.data && Number(ev.data.turn) === turn) break;
    out.push(ev);
  }
  return out;
}

// ============================================================================
// 六、封板状态机：generate / adopt / skip
// ============================================================================

/**
 * 读某会话的封板记录。
 * @param {object} state `.state.json` 内容
 * @param {string} sessKey 13 位会话键
 * @returns {object|null}
 */
export function getSeal(state, sessKey) {
  const m = state && state[SEAL_FIELD];
  if (!m || typeof m !== 'object') return null;
  const rec = m[sessKey];
  return rec && typeof rec === 'object' ? rec : null;
}

/**
 * 把封板记录写进 state（**只改内存对象**，落盘由调用方 `ledger.writeState(root, state)` 负责）。
 *
 * 必需字段（模板 3.4）：sealedAt、sealHash、main、appendix；允许附加 adopted/reopened，
 * 不允许删减。state 是封板的权威来源。
 *
 * @param {object} state
 * @param {string} sessKey
 * @param {{sealedAt:string, sealHash:string, main?:string, appendix?:string,
 *          decision?:string, adopted?:boolean, reopened?:boolean}} info
 * @returns {object} 写入的记录
 */
export function markSealed(state, sessKey, info = {}) {
  if (!state || typeof state !== 'object') throw badArgs('state 必须是对象');
  splitKey(sessKey);
  const { sealedAt, sealHash } = info;
  if (typeof sealedAt !== 'string' || !DATETIME_RE.test(sealedAt)) {
    throw badArgs(`sealedAt 必须匹配 ${DATETIME_RE}，收到：${JSON.stringify(sealedAt)}`);
  }
  if (typeof sealHash !== 'string' || !SEAL_HASH_RE.test(sealHash)) {
    throw badArgs(`sealHash 必须是 64 位小写 hex，收到：${JSON.stringify(sealHash)}`);
  }
  const record = {
    decision: info.decision || (info.adopted === true ? 'adopted' : 'generated'),
    sealedAt,
    sealHash,
    main: info.main || handoverMainName(sessKey),
    appendix: info.appendix || handoverAppendixName(sessKey),
  };
  if (info.adopted === true) record.adopted = true;
  if (info.reopened === true) record.reopened = true;

  if (!state[SEAL_FIELD] || typeof state[SEAL_FIELD] !== 'object') state[SEAL_FIELD] = {};
  state[SEAL_FIELD][sessKey] = record;
  return record;
}

/**
 * 归一化一条"交接表封板证据"（P1-9 追加式 seal journal 事件 / 旧 state 记录）。
 *
 * @param {object|null} event
 * @param {string} sessKey
 * @returns {{sealedAt:string, sealHash:string, main:string, appendix:string,
 *            valid:boolean, source:string, raw:object}|null}
 *
 * @why 为什么要单独归一化：封板证据有两个来源（journal 事件 / state 记录），
 *      字段名不同（`at` vs `sealedAt`、`file` vs `main`、`extra.appendix` vs `appendix`）。
 *      判定"已封板"的代码只认归一化后的形状，避免两套字段名各写一遍、迟早漂移。
 */
export function resolveHandoverSeal(event, sessKey) {
  if (!event || typeof event !== 'object') return null;
  const extra = event.extra && typeof event.extra === 'object' ? event.extra
    : (event.payload && typeof event.payload === 'object' ? event.payload : {});
  const firstStr = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v) return v;
    return '';
  };
  const sealedAt = firstStr(event.sealedAt, event.at, extra.sealedAt);
  const sealHash = firstStr(event.sealHash, event.hash, event.sha256, extra.sealHash);
  const main = firstStr(event.main, event.file, extra.main) || handoverMainName(sessKey);
  const appendix = firstStr(event.appendix, extra.appendix, event.appendixFile) ||
    handoverAppendixName(sessKey);
  return {
    sealedAt,
    sealHash,
    main,
    appendix,
    decision: firstStr(extra.decision, event.decision),
    adopted: extra.adopted === true || event.adopted === true,
    valid: SEAL_HASH_RE.test(sealHash) && DATETIME_RE.test(sealedAt),
    source: firstStr(event.source),
    raw: event,
  };
}

/**
 * 从"散装封板证据集合"里取某会话的证据。
 *
 * 支持三种输入形状（与 P1-9 存储侧对齐，不另造一套）：
 *   ① `latestSealEvents(root)` 返回值 `{weekly:{...}, handover:{[sessKey]:event}}`；
 *   ② 直接 `{[sessKey]: event}` 映射；
 *   ③ 单条 journal 事件（`{kind:'handover', key:sessKey, ...}`）。
 *
 * @param {object|null} seals
 * @param {string} sessKey
 * @returns {object|null} `resolveHandoverSeal()` 的结果；找不到返回 null
 */
export function resolveHandoverSealFrom(seals, sessKey) {
  if (!seals || typeof seals !== 'object') return null;
  if (seals.kind === 'handover' && seals.key === sessKey) return resolveHandoverSeal(seals, sessKey);
  const map = seals.handover && typeof seals.handover === 'object' ? seals.handover : seals;
  const event = map && typeof map === 'object' ? map[sessKey] : null;
  return event && typeof event === 'object' ? resolveHandoverSeal(event, sessKey) : null;
}

/**
 * 决策：本会话这次该 generate / adopt / skip。
 *
 * 只读、不写盘、不改文件；返回信息供调用方记日志并补 state。
 *
 * @why V0.6.2 读侧双路径：主表/附表在 `交接表/`（新布局）或一级（老库，未迁移）都算存在；
 *      统一走 `layout.resolveExisting`（新目录优先、一级兜底），绝不要求用户先迁移才能读。
 *
 * | 条件 | decision | 行为 |
 * |---|---|---|
 * | 有该会话封板证据（journal 优先 / state 兜底） | skip | 不生成、不写盘；主表缺失 → warn `sealed but file missing（不重建）` |
 * | 无证据、主表存在 | adopt | 只补封板记录（hash 从现有文件重算），不写文件 |
 * | 无证据、主表不存在 | generate | 渲染 + 写盘（调用方执行），返回 reopened:true |
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录
 * @param {string} p.sessKey 13 位会话键
 * @param {object} p.state `.state.json` 内容（P1-9 后是**可重建缓存**，不是权威）
 * @param {object} [p.seals] P1-9 封板证据（journal 读取结果；形状见 resolveHandoverSealFrom）。
 *        传了且有效 → 以它为准（journal 权威）；不传 → 退回旧 state 路径（v0.4 兼容）
 * @param {number} [p.nowMs] 当前时刻毫秒（测试用；默认 Date.now()）
 * @param {number} [p.offsetMinutes] 时区偏移分钟（默认 480）
 * @returns {{decision:'generate'|'adopt'|'skip', reopened:boolean, adopted?:boolean,
 *            sealHash?:string, sealedAt?:string, main:string, appendix:string,
 *            mainExists:boolean, appendixExists:boolean, sealSource:'journal'|'state'|'',
 *            warnings:string[], error?:{code:string,message:string}, logLine:string}}
 *
 * @why 为什么 generate 也带 reopened:true：
 *      "从没生成"与"state 丢失"在信息上不可区分，契约规定按重新开账口径**一律显式告警**
 *      （模板 3.3 的"state 丢失"行、HO-25）；调用方据此在日志里写 reopened=true。
 * @why 为什么 adopt 也带 reopened:true：
 *      同理，adopt 只发生在无封板证据时；旧文件是谁放的、state 是不是丢了，无法区分。
 * @why 为什么 adopt 不写任何文件字节：
 *      "只生成一次"包含"第一次见到就认它"；为补封板字段去重写旧文件，
 *      会破坏人手工放入/旧版的原件（决定 9 #2、HO-24）。
 * @why 为什么 journal 与 state 不一致要以 journal 为准：
 *      P1-9：运行缓存（state）与封板证据（journal）分离，state 丢了只影响性能；
 *      journal 是追加式、不可回改的封板事实，state 是可重建缓存。不一致报 `seal mismatch`，
 *      不自动改任何一边（交对账/人工裁决）。
 */
export function decideHandover({
  root, sessKey, state, seals, nowMs, offsetMinutes = 480,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) throw badArgs('root 必须是非空字符串');
  splitKey(sessKey);
  const offset = resolveOffset(offsetMinutes);
  const main = handoverMainName(sessKey);
  const appendix = handoverAppendixName(sessKey);
  // V0.6.2 布局：读侧双路径（`交接表/` 优先、一级老位置兜底）；不存在时返回 ''。
  const mainPath = resolveExisting(root, FILE_KIND.HANDOVER_MAIN, main);
  const appendixPath = resolveExisting(root, FILE_KIND.HANDOVER_APPENDIX, appendix);
  const mainExists = mainPath !== '';
  const appendixExists = appendixPath !== '';
  const warnings = [];

  // ★ P1-9：封板证据读取顺序 —— journal（权威）→ state（缓存）。
  const journalSeal = resolveHandoverSealFrom(seals, sessKey);
  const stateSeal = resolveHandoverSeal(getSeal(state, sessKey), sessKey);
  const useJournal = !!(journalSeal && journalSeal.valid);
  const seal = useJournal ? journalSeal : (stateSeal && stateSeal.valid ? stateSeal : null);
  if (useJournal && stateSeal) {
    const diff = stateSeal.sealHash !== journalSeal.sealHash ||
      (stateSeal.main && stateSeal.main !== journalSeal.main) ||
      (stateSeal.sealedAt && stateSeal.sealedAt !== journalSeal.sealedAt);
    if (diff) warnings.push('handover: seal mismatch（journal 与 state 不一致，以 journal 为准）');
  }
  const sealSource = useJournal ? 'journal' : (seal ? 'state' : '');
  const sealMain = seal && typeof seal.main === 'string' && seal.main ? seal.main : main;
  const sealAppendix = seal && typeof seal.appendix === 'string' && seal.appendix ? seal.appendix : appendix;

  // ① 已封板 → skip（删了也不重建；文件缺失只 warn）。
  if (seal) {
    // 封板证据里的文件名同样按双路径解析（`交接表/` 优先、一级兜底）。
    const sealMainPath = resolveExisting(root, FILE_KIND.HANDOVER_MAIN, sealMain);
    const sealAppendixPath = resolveExisting(root, FILE_KIND.HANDOVER_APPENDIX, sealAppendix);
    if (sealMainPath === '') {
      warnings.push('handover: sealed but file missing（不重建）');
    } else {
      // 封板双记：journal/state 是权威；文件 YAML 只是副本，不一致只告警、不覆盖。
      try {
        const text = fs.readFileSync(sealMainPath, 'utf8');
        const bodyHash = handoverBodyHash(text);
        if (!bodyHash) warnings.push('handover: seal mismatch');
        else if (seal.sealHash && seal.sealHash !== bodyHash) warnings.push('handover: seal mismatch');
      } catch {
        warnings.push('handover: seal mismatch');
      }
    }
    if (sealAppendixPath === '') warnings.push('handover: appendix missing');
    return {
      decision: 'skip',
      reopened: false,
      sealHash: seal.sealHash || '',
      sealedAt: seal.sealedAt || '',
      main: sealMain,
      appendix: sealAppendix,
      mainExists: sealMainPath !== '',
      appendixExists: sealAppendixPath !== '',
      sealSource,
      warnings,
      logLine: 'handover=skip',
    };
  }
  // journal 里有该 key 但事件本身不合法（缺 sealedAt/sealHash）：不能当"已封板"，
  // 但也绝不能静默忽略 —— 报 mismatch 让对账看得见。
  if (journalSeal && !journalSeal.valid) warnings.push('handover: seal mismatch（journal 事件缺少合法 sealedAt/sealHash）');

  // ② 主表已存在、无封板证据 → adopt：按同一口径从现有文件重算 hash，只补 state。
  if (mainExists) {
    const base = {
      decision: 'adopt',
      reopened: true,
      main,
      appendix,
      mainExists: true,
      appendixExists,
      sealSource: '',
      warnings,
      logLine: 'handover=adopt reopened=true',
    };
    let text;
    try {
      text = fs.readFileSync(mainPath, 'utf8');
    } catch (e) {
      return {
        ...base,
        adopted: false,
        error: { code: 'E_HANDOVER_READ_FAILED', message: `adopt 读取主表失败：${e && e.message}` },
      };
    }
    const bodyHash = handoverBodyHash(text);
    if (!bodyHash) {
      return {
        ...base,
        adopted: false,
        error: { code: 'E_HANDOVER_BODY_NOT_FOUND', message: `adopt 找不到正文（无行首 '# ' 行）：${main}` },
      };
    }
    const yamlHash = handoverSealFromYaml(text);
    if (yamlHash && yamlHash !== bodyHash) {
      return {
        ...base,
        adopted: false,
        error: {
          code: 'E_HANDOVER_HASH_MISMATCH',
          message: `adopt 复核不一致：YAML 封板hash=${yamlHash} 正文重算=${bodyHash}`,
        },
      };
    }
    if (!appendixExists) warnings.push('handover: appendix missing');
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    return {
      ...base,
      adopted: true,
      sealHash: bodyHash,
      sealedAt: stampLocal(now, offset),
    };
  }

  // ③ 从没生成过 → generate（旧同名文件若有，由 writeHandover 先 rename 留档）。
  return {
    decision: 'generate',
    reopened: true,
    main,
    appendix,
    mainExists: false,
    appendixExists,
    sealSource: '',
    warnings,
    logLine: 'handover=generate reopened=true',
  };
}

// ============================================================================
// 六·五、P1-7 幂等入口：ensureHandover（失败只返回 error，不抛穿）
// ============================================================================

/** 把 ensureHandover 内部异常归一成返回值里的 error 对象（**绝不抛穿**）。 */
function ensureError(code, message) {
  return { code: String(code || 'E_HANDOVER_ENSURE_FAILED'), message: String(message || '') };
}

/**
 * 写封板证据（D12/D15：journal 唯一权威 + state 缓存）。
 *   · 默认：`lib/sealjournal.js: appendSealEvent()` 落 journal（**唯一写者**），成功后写 state 缓存；
 *   · `sealWriter` 由 Lead 注入时**完全接管**（用于单测/特殊集成）。
 * @throws 写入失败（调用方转成 ensureHandover 的 errors，不抛穿用户）
 */
function applyHandoverSeal({ root, sealWriter, stateWriter, state, sessKey, decision, evidence }) {
  if (typeof sealWriter === 'function') {
    sealWriter(evidence, { state, sessKey, decision });
    if (typeof stateWriter === 'function') stateWriter(state);
    return { journal: null, warnings: [] };
  }
  // D12/D15：journal 是唯一封板证据；state 只是可重建缓存（P1-9）。
  const r = appendSealEvent(root, evidence);
  if (!r || r.ok !== true) {
    const err = new Error(`封板 journal 写入失败：${(r && r.reason) || 'unknown'}`);
    err.code = 'E_HANDOVER_SEAL_JOURNAL_FAILED';
    throw err;
  }
  const warnings = [];
  const ev = r.event || {};
  for (const k of ['decision', 'main', 'appendix', 'adopted', 'reopened']) {
    if (!(k in ev)) {
      warnings.push(`handover: SEAL_JOURNAL_FIELDS_MISSING（lib/sealjournal.js 未保留 handover 专有字段 ${k}，D12 要求扁平字段；需 Lead 修唯一写者）`);
      break;
    }
  }
  markSealed(state, sessKey, {
    sealedAt: decision.sealedAt,
    sealHash: decision.sealHash,
    main: decision.main,
    appendix: decision.appendix,
    decision: decision.decision === 'adopt' ? 'adopted' : 'generated',
    adopted: decision.decision === 'adopt',
    reopened: decision.reopened === true,
  });
  if (typeof stateWriter === 'function') stateWriter(state);
  return { journal: r, warnings };
}

/**
 * `ensureHandover` —— P1-7 的**幂等入口**（runOnce 每轮在会话首轮入账后调用）。
 *
 * 行为：`先 adopt 后 generate`（由 decideHandover 保证：主表存在 → adopt；不存在 → generate），
 * 已封板 → skip。**失败只返回 error，不抛穿**；调用方把 `errors` 记进 `stat.errors` 即可
 *（不得中断本轮其余写入，下一轮自动重试）。
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录
 * @param {string} p.sessKey 13 位会话键 `{S}{D}`
 * @param {object} [p.state] `.state.json` 内容（P1-9 后是**可重建缓存**；调用方负责落盘）
 * @param {object} [p.seals] P1-9 封板证据（journal 的 handover 映射 `{handover:{[sessKey]:event}}`
 *        或直接 `{[sessKey]:event}`；journal 权威）。不传 → 先读 `sealjournal.latestSealEvent()`
 *        （`kind:'handover-seal'`），再退回 state 路径（v0.4 兼容）
 * @param {number} [p.nowMs] 显式"现在"（可复算/测试必须传；缺省 Date.now()）
 * @param {number} [p.offsetMinutes=480]
 * @param {string} [p.generator] 生成器标识
 * @param {boolean} [p.enabled=true] false → `{ok:true, decision:'disabled'}`，零 IO
 * @param {number} [p.knownTurns] 该会话在台账里的记录数；`<=0` → `deferred`（未入账不生成）。
 *        未传 → 返回 `E_HANDOVER_KNOWN_TURNS_REQUIRED`（宁可报错，不猜"已入账"）
 * @param {number} [p.firstTurn=1] 第一条入账轮次（附表覆盖范围终点）
 * @param {Function} [p.readContext] **generate 必需**：`({entry,firstTurn,maxBytes}) =>
 *        {events:object[], incomplete:boolean, failedFrames?:number}`。返回 `incomplete:true`
 *        （接管前上下文没读全）→ 拒绝生成（不写假「无」）
 * @param {object} [p.contextEntry] 传给 readContext 的源项（如 `{path,version}`）
 * @param {number} [p.appendixMaxBytes=2MiB] 前缀读取预算（透传 readContext）
 * @param {Function} [p.sealWriter] 封板证据写入器 `(evidence,{state,sessKey,decision})=>void`；
 *        缺省 → `lib/sealjournal.js: appendSealEvent()`（**唯一写者**，D12/D15）写 journal，
 *        成功后 `markSealed(state,...)` 写 state 缓存。Lead 特殊集成可注入覆盖
 * @param {Function} [p.stateWriter] 可选：state 落盘器 `(state)=>void`；不传则由调用方稍后统一 `writeState`
 *
 * @returns {{ok:boolean, decision:'skip'|'adopt'|'generate'|'deferred'|'disabled'|'error',
 *   sessKey:string, reason:string, warnings:string[], errors:Array<{code:string,message:string}>,
 *   logs:string[], reopened:boolean, adopted:boolean, generated:boolean,
 *   sealEvidence:object|null, appendix:object|null, files:object|null,
 *   sealSource?:string, sealHash?:string, sealedAt?:string}}
 *
 *   · `ok:true` 且 decision ∈ skip/adopt/generate/deferred/disabled = 正常；
 *   · `ok:false` 且 errors 非空 = 本次失败（已写盘/未写盘都在 files/sealEvidence 里如实给出）；
 *   · **幂等**：成功后再次调用 → decision:'skip'（journal 或 state 任一有证据），不再写任何字节；
 *   · `sealEvidence`（仅 adopt/generate）是 D12 的 `handover-seal` 事件（扁平字段）：
 *     `{v:1, kind:'handover-seal', key, gid:null, file:<主表相对路径>, sealedAt, sealHash,
 *       layoutVersion:1, canonicalVersion:1, decision:'generated'|'adopted',
 *       main, appendix, adopted, reopened}`；
 *     `v/at/prevSealSha256` 由唯一写者 `sealjournal.appendSealEvent` 补齐
 *     （写入时机：主表写盘/adopt 认领**成功之后**；失败不写 journal、只记 errors）。
 *
 * @why 为什么 readContext 必须由调用方注入：本模块不解析会话文件（那是 ledger/legacy 的职责），
 *      也**禁止**在拿不到接管前上下文时写一份空附表——那会让附表谎报「无」（GL-18）。
 * @why 为什么失败不抛：P1-7 要求交接表失败只记 errors、不得中断本轮其余写入；
 *      抛穿会让一个交接表问题拖垮整轮记账。
 */
export function ensureHandover({
  root, sessKey, state, seals, nowMs, offsetMinutes = 480, generator = DEFAULT_GENERATOR,
  enabled = true,
  knownTurns,
  firstTurn = 1,
  readContext,
  contextEntry,
  appendixMaxBytes = 2 * 1024 * 1024,
  sealWriter,
  stateWriter,
} = {}) {
  const base = {
    ok: false, decision: 'error', sessKey: typeof sessKey === 'string' ? sessKey : '',
    reason: '', warnings: [], errors: [], logs: [],
    reopened: false, adopted: false, generated: false,
    sealEvidence: null, appendix: null, files: null,
  };
  const fail = (code, message, extra = {}) => ({
    ...base, ...extra, ok: false, errors: base.errors.concat([ensureError(code, message)]),
  });

  if (enabled === false) {
    return { ...base, ok: true, decision: 'disabled', reason: 'handoverEnabled=false' };
  }
  let offset;
  try {
    splitKey(sessKey);
    offset = resolveOffset(offsetMinutes);
  } catch (e) {
    return fail(e && e.code ? e.code : 'E_HANDOVER_BAD_ARGS', e && e.message);
  }
  const st = state && typeof state === 'object' ? state : {};
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  try {
    // P1-9/D15：封板证据默认从唯一 journal 读取；state 只作兜底缓存。
    let effectiveSeals = seals;
    if (effectiveSeals === undefined && typeof root === 'string' && root.length > 0) {
      try {
        const ev = latestSealEvent(root, 'handover-seal', sessKey);
        if (ev) effectiveSeals = { handover: { [sessKey]: ev } };
      } catch { /* 读 journal 失败：交给 decideHandover 的 state 兜底，错误在调用方日志可见 */ }
    }
    const d = decideHandover({ root, sessKey, state: st, seals: effectiveSeals, nowMs: now, offsetMinutes: offset });
    for (const w of d.warnings || []) base.warnings.push(String(w));
    if (d.logLine) base.logs.push(d.logLine);
    const src = { sealSource: d.sealSource || '', sealHash: d.sealHash || '', sealedAt: d.sealedAt || '' };

    // ① 已封板 → skip（零写盘；文件缺失由 decideHandover 给 warn，不重建）。
    if (d.decision === 'skip') {
      return { ...base, ...src, ok: true, decision: 'skip' };
    }

    // ①b "尚未入账" → deferred（adopt / generate 都不该在台账零记录时发生；P1-7 调用点在首轮入账后）。
    if (typeof knownTurns !== 'undefined' && knownTurns !== null && !(Number(knownTurns) > 0)) {
      return { ...base, ...src, ok: true, decision: 'deferred', reason: 'not-yet-recorded' };
    }

    // ② adopt：只补封板记录，**不改文件任何字节**（HO-24）。
    if (d.decision === 'adopt') {
      if (d.error) return fail(d.error.code, d.error.message, { decision: 'adopt' });
      if (!d.adopted) return fail('E_HANDOVER_ADOPT_FAILED', 'adopt 未完成', { decision: 'adopt' });
      // D12：handover-seal 事件（扁平字段；journal 唯一写者补 prevSealSha256/at/v）。
      const evidence = {
        v: 1,
        kind: 'handover-seal',
        key: sessKey,
        gid: null,
        file: d.main,                       // ★ selfheal 依赖：主表相对路径
        sealedAt: d.sealedAt,
        sealHash: d.sealHash,
        layoutVersion: 1,
        canonicalVersion: 1,
        decision: 'adopted',
        main: d.main,
        appendix: d.appendix,
        adopted: true,
        reopened: true,
      };
      const out = {
        ...base, ...src, decision: 'adopt', reopened: true, adopted: true,
        files: { main: d.main, appendix: d.appendix }, sealEvidence: evidence,
      };
      try {
        const sealed = applyHandoverSeal({ root, sealWriter, stateWriter, state: st, sessKey, decision: d, evidence });
        for (const w of sealed.warnings || []) out.warnings.push(String(w));
      } catch (e) {
        return { ...out, ok: false, errors: [ensureError(e && e.code ? e.code : 'E_HANDOVER_SEAL_RECORD_FAILED', e && e.message)] };
      }
      out.logs.push('handover=adopt reopened=true');
      out.ok = true;
      return out;
    }

    // ③ generate：必须先确认"已入账"，再拿接管前上下文，再写盘 + 封板证据。
    if (knownTurns === undefined || knownTurns === null) {
      return fail('E_HANDOVER_KNOWN_TURNS_REQUIRED',
        'generate 必须传 knownTurns（该会话已闭合记录数），否则无法区分"尚未入账"与"应生成"', { decision: 'generate' });
    }
    const known = Number(knownTurns);
    if (!Number.isFinite(known)) {
      return fail('E_HANDOVER_BAD_ARGS', `knownTurns 必须是数字，收到：${JSON.stringify(knownTurns)}`, { decision: 'generate' });
    }
    if (known <= 0) {
      return { ...base, decision: 'deferred', ok: true, reason: 'not-yet-recorded' };
    }
    if (typeof readContext !== 'function') {
      return fail('E_HANDOVER_NO_CONTEXT_READER',
        'generate 需要调用方注入 readContext（本模块不解析会话文件；禁止写假空表）', { decision: 'generate' });
    }
    let ctx;
    try {
      ctx = readContext({ entry: contextEntry || null, firstTurn, maxBytes: appendixMaxBytes });
    } catch (e) {
      const code = e && e.code ? e.code : 'E_HANDOVER_READ_CONTEXT_FAILED';
      return fail(code, `读接管前上下文失败：${e && e.message}`, { decision: 'generate' });
    }
    if (!ctx || typeof ctx !== 'object') {
      return fail('E_HANDOVER_NO_CONTEXT_EVENTS', 'readContext 返回空（无事件容器）', { decision: 'generate' });
    }
    if (ctx.incomplete === true) {
      return fail('E_HANDOVER_APPENDIX_INCOMPLETE',
        '接管前上下文未读全（前缀截断且未见 turn/start）：拒绝生成，避免附表谎报「无」', { decision: 'generate' });
    }
    if (!Array.isArray(ctx.events)) {
      return fail('E_HANDOVER_NO_CONTEXT_EVENTS', 'readContext 未返回 events 数组', { decision: 'generate' });
    }
    if (Number(ctx.failedFrames) > 0) {
      base.warnings.push(`handover: appendix prefix failedFrames=${Number(ctx.failedFrames)}（缺口见台账 .lost.jsonl）`);
    }

    let mainMd;
    let appMd;
    let written;
    try {
      const ctxEvents = selectHandoverContextEvents(ctx.events, firstTurn);
      mainMd = renderHandoverMain({ sessKey, nowMs: now, offsetMinutes: offset, generator });
      appMd = renderHandoverAppendix({
        events: ctxEvents, sessKey, nowMs: now, offsetMinutes: offset, generator,
      });
      written = writeHandover({
        root, sessKey,
        mainMarkdown: mainMd.markdown,
        appendixMarkdown: appMd.markdown,
        sealHash: mainMd.sealHash,
        nowMs: now, offsetMinutes: offset,
      });
    } catch (e) {
      return fail(e && e.code ? e.code : 'E_HANDOVER_WRITE_FAILED',
        e && e.message, { decision: 'generate' });
    }

    // D12：handover-seal 事件（扁平字段；journal 唯一写者补 prevSealSha256/at/v）。
    const evidence = {
      v: 1,
      kind: 'handover-seal',
      key: sessKey,
      gid: null,
      file: written.mainRel,               // ★ selfheal 依赖：主表相对路径
      sealedAt: written.sealedAt,
      sealHash: written.sealHash,
      layoutVersion: 1,
      canonicalVersion: 1,
      decision: 'generated',
      main: written.mainRel,
      appendix: written.appendixRel,
      adopted: false,
      reopened: true,
    };
    const out = {
      ...base,
      decision: 'generate', reopened: true, generated: true,
      files: { main: written.mainRel, appendix: written.appendixRel },
      appendix: { count: appMd.count, total: appMd.total, truncated: !!appMd.truncated },
      sealEvidence: evidence,
    };
    out.logs.push(...(written.logs || []), 'handover=generate reopened=true');
    try {
      const sealed = applyHandoverSeal({
        root, sealWriter, stateWriter, state: st, sessKey,
        decision: { ...d, sealedAt: written.sealedAt, sealHash: written.sealHash }, evidence,
      });
      for (const w of sealed.warnings || []) out.warnings.push(String(w));
    } catch (e) {
      // 文件已写成功但封板证据没落：**不得**谎报 ok。下次运行走 adopt 自愈（main 存在、无证据）。
      return {
        ...out, ok: false,
        errors: [ensureError(e && e.code ? e.code : 'E_HANDOVER_SEAL_RECORD_FAILED',
          `主表已写盘但封板证据写入失败（下次 adopt 自愈）：${e && e.message}`)],
      };
    }
    out.ok = true;
    return out;
  } catch (e) {
    return fail(e && e.code ? e.code : 'E_HANDOVER_ENSURE_FAILED', e && e.message);
  }
}

// ============================================================================
// 七、写盘：同批原子写（先附表、后主表）+ 写后回读复核 + 旧文件留档
// ============================================================================

/** 主表形态自检：主表正文全部是生成结构，因此必须 LF、无 CR、无占位符残留。 */
function assertMainMarkdownShape(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) throw badArgs('主表 markdown 不能为空');
  if (markdown.startsWith('\uFEFF')) throw badArgs('主表 不得以 BOM 开头');
  if (markdown.includes('\r')) throw badArgs('主表 含 CR，换行必须是 LF');
  if (!markdown.endsWith('\n')) throw badArgs('主表 必须以恰好一个换行结尾');
  if (markdown.endsWith('\n\n')) throw badArgs('主表 结尾不得有空行（恰好一个结尾换行）');
  if (markdown.includes('{{') || markdown.includes('}}')) throw badArgs('主表 残留未替换占位符（{{ 或 }}）');
}

/**
 * 附表"生成结构"自检 + 结构块清点。
 *
 * 审计口径（Lead 2026-11-09 裁定）：逐字照录的原文**允许**含 CR / `{{` / 行首 `## `，
 * 不得为了满足编码判据去改原文；但**生成结构**（YAML、固定说明句、block 标题行、
 * `[seq]` 元信息行、分隔线、结束行）必须 LF 且无 CR。
 *
 * @param {string} markdown
 * @param {string} sessKey
 * @returns {{blockCount:number, numbers:number[], seqs:number[]}}
 *          结构块：`## N. role` 且下一行是合法元信息行（原文里恰好行首 `## ` 的行不算结构）。
 * @throws {Error} err.code === 'E_HANDOVER_BAD_ARGS'
 */
function inspectAppendixStructure(markdown, sessKey) {
  if (typeof markdown !== 'string' || markdown.length === 0) throw badArgs('附表 markdown 不能为空');
  if (markdown.startsWith('\uFEFF')) throw badArgs('附表 不得以 BOM 开头');
  if (!markdown.endsWith('\n')) throw badArgs('附表 必须以恰好一个换行结尾（结构行）');
  if (markdown.endsWith('\n\n')) throw badArgs('附表 结尾不得有空行（恰好一个结尾换行）');

  const bodyMatch = /^# /m.exec(markdown);
  if (!bodyMatch) throw badArgs('附表 找不到正文标题行（行首 "# "）');
  if (markdown.slice(0, bodyMatch.index).includes('\r')) throw badArgs('附表 YAML 前置块必须 LF 且无 CR');

  const firstLine = markdown.slice(bodyMatch.index).split('\n')[0];
  if (firstLine.includes('\r')) throw badArgs('附表 H1 标题行必须无 CR');
  if (firstLine !== APPENDIX_H1(sessKey)) throw badArgs('附表 H1 与 sessKey 不匹配');

  // 固定说明句 / 分隔线 / 结束行都是生成结构，必须无 CR。
  for (const fixed of [APPENDIX_QUOTE_1, APPENDIX_QUOTE_2(sessKey), APPENDIX_QUOTE_3, APPENDIX_CLOSING]) {
    const idx = markdown.indexOf(fixed);
    if (idx === -1) throw badArgs('附表缺少固定说明句：' + fixed);
    const nl = markdown.indexOf('\n', idx);
    const line = markdown.slice(idx, nl === -1 ? markdown.length : nl);
    if (line.includes('\r')) throw badArgs('附表固定说明句必须无 CR');
  }
  if (!markdown.includes('\n---\n\n**结束** · ')) throw badArgs('附表缺少结构分隔线/结束行');
  const lastLine = markdown.slice(0, -1).split('\n').pop() || '';
  if (lastLine.includes('\r')) throw badArgs('附表结束行必须无 CR');
  if (!/^\*\*结束\*\* · /.test(lastLine)) throw badArgs('附表末行必须是结束行');

  // 结构块清点：标题行 + 紧跟的合法元信息行才算 block（原文里恰好行首 `## ` 不算）。
  const lines = markdown.split('\n');
  const numbers = [];
  const seqs = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const m = /^## (\d+)\. (?:user\/message|assistant\/message|tool\/call|tool\/result|system\/message)$/.exec(lines[i]);
    if (!m) continue;
    const meta = /^\[seq (\d+)\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.exec(lines[i + 1]);
    if (!meta) continue;
    if (lines[i].includes('\r') || lines[i + 1].includes('\r')) {
      throw badArgs('附表 block 标题行/元信息行必须无 CR');
    }
    numbers.push(Number(m[1]));
    seqs.push(Number(meta[1]));
    i += 1;
  }
  for (let idx = 0; idx < numbers.length; idx++) {
    if (numbers[idx] !== idx + 1) {
      throw badArgs(`附表 block 编号必须 1..K 连续，第 ${idx + 1} 个是 ${numbers[idx]}`);
    }
    if (idx > 0 && seqs[idx] <= seqs[idx - 1]) throw badArgs('附表 [seq] 必须严格升序（无重复、无回退）');
  }
  return { blockCount: numbers.length, numbers, seqs };
}

/** 写 `{目标}.tmp` → fsync → close → rename；失败时清理 tmp。 */
function writeFileTmpRename(target, content) {
  const tmp = `${target}.tmp`;
  let fd = -1;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, content, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, target);
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* 关不掉也不影响主错误 */ } }
    if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch { /* tmp 清理失败不掩盖主错误 */ } }
  }
}

/** 旧文件留档：`{原名}.旧-YYYYMMDD-HHMMSS`（+08:00），不删除、不覆盖已有留档。 */
function archiveOldFile(target, nowMs, offsetMinutes) {
  let bump = 0;
  let candidate = `${target}.旧-${archiveStamp(nowMs, offsetMinutes)}`;
  while (fs.existsSync(candidate)) {
    bump++;
    if (bump > 120) throw new Error(`留档名冲突过多：${candidate}`);
    candidate = `${target}.旧-${archiveStamp(nowMs + bump * 1000, offsetMinutes)}`;
  }
  fs.renameSync(target, candidate);
  return candidate;
}

/**
 * 写交接表（主表 + 附表同批）。
 *
 * 顺序（契约 3.5 / 3.6）：写前 hash 自检 → 旧同名文件 rename 留档 → 附表 `.tmp`+rename
 * → 主表 `.tmp`+rename → 写后回读复核（正文 hash 重算）→ 返回封板信息。
 * 任一失败：删掉本批新建的文件、恢复留档、清理 `.tmp`，整批放弃 —— 不落半成品。
 *
 * @why V0.6.2 写端只写 `<root>/交接表/`：返回的 `mainPath`/`appendixPath` 是**新子目录**下的绝对路径；
 *      老库（未迁移）里一级的老同名文件不是删掉，而是先 rename 留档（`.旧-YYYYMMDD-HHMMSS`），
 *      所以"不覆盖旧文件"的语义与迁移前完全一致。`mainRel`/`appendixRel` 仍是文件名（相对路径语义不变，
 *      封板 journal 的 `file` 字段仍按文件名记录，迁移后老事件照样能解析）。
 *
 * 封板状态不在这里写：本函数只返回 `{sealHash, sealedAt, ...}`，
 * 由调用方 `markSealed(state, ...)` + `ledger.writeState(root, ...)` 最后落盘。
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录（第一级）
 * @param {string} p.sessKey 13 位会话键
 * @param {string} p.mainMarkdown `renderHandoverMain().markdown`
 * @param {string} p.appendixMarkdown `renderHandoverAppendix().markdown`
 * @param {string} [p.sealHash] 渲染时给出的封板 hash（传了就与正文重算值比对）
 * @param {number} [p.nowMs] 当前时刻毫秒（留档时间戳/测试用）
 * @param {number} [p.offsetMinutes] 时区偏移分钟（默认 480）
 * @returns {{mainPath:string, appendixPath:string, mainRel:string, appendixRel:string,
 *            sealHash:string, sealedAt:string, bytesMain:number, bytesAppendix:number,
 *            archived:Array<{target:string, from:string, to:string}>, logs:string[]}}
 * @throws {Error} err.code = E_HANDOVER_BODY_NOT_FOUND | E_HANDOVER_HASH_MISMATCH |
 *                 E_HANDOVER_BAD_ARGS | E_HANDOVER_WRITE_FAILED
 */
export function writeHandover({
  root, sessKey, mainMarkdown, appendixMarkdown, sealHash, nowMs, offsetMinutes = 480,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) throw badArgs('root 必须是非空字符串');
  splitKey(sessKey);
  const offset = resolveOffset(offsetMinutes);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const mainName = handoverMainName(sessKey);
  const appendixName = handoverAppendixName(sessKey);

  // ---------- 1. 形态与 hash 自检（写盘之前就拒绝坏产物） ----------
  assertMainMarkdownShape(mainMarkdown);
  // 附表：逐字照录区允许 CR/{{}}/行首 ##（审计裁定，不改原文）；只校验生成结构。
  const appStruct = inspectAppendixStructure(appendixMarkdown, sessKey);

  const bodyHash = handoverBodyHash(mainMarkdown);
  if (!bodyHash) throw bodyNotFound(`主表找不到正文（无行首 '# ' 行）：${mainName}`);
  const yamlHash = handoverSealFromYaml(mainMarkdown);
  if (yamlHash !== bodyHash) {
    throw hashMismatch(
      `主表 YAML 封板hash 与正文重算不一致：yaml=${yamlHash || '(缺失或格式不符)'} body=${bodyHash}`,
      { yamlHash, bodyHash, path: newLayoutPath(root, FILE_KIND.HANDOVER_MAIN, mainName) }
    );
  }
  if (sealHash !== undefined && sealHash !== null && sealHash !== '' && sealHash !== bodyHash) {
    throw hashMismatch(
      `渲染器给出的 sealHash 与正文重算不一致：rendered=${String(sealHash)} body=${bodyHash}`,
      { renderedHash: String(sealHash), bodyHash }
    );
  }

  // ---------- 2. 同批一致性自检（主表 ↔ 附表互相指向） ----------
  const mainFields = handoverYamlFields(mainMarkdown);
  const appFields = handoverYamlFields(appendixMarkdown);
  if (mainFields.keys.length !== 11) {
    throw badArgs(`主表 YAML 应恰好 11 个键，实际 ${mainFields.keys.length}：${mainFields.keys.join(',')}`);
  }
  if (mainFields.fields['名称'] !== `${sessKey}${STEM}`) throw badArgs('主表 YAML 名称与 sessKey 不匹配');
  if (mainFields.fields['会话标识'] !== sessKey.slice(0, 12)) throw badArgs('主表 YAML 会话标识与 sessKey 不匹配');
  if (mainFields.fields['代差'] !== sessKey.slice(12)) throw badArgs('主表 YAML 代差与 sessKey 不匹配');
  if (mainFields.fields['附表'] !== appendixName) throw badArgs('主表 YAML 附表与文件名不匹配');
  if (mainFields.fields['封板'] !== 'true') throw badArgs('主表 YAML 封板必须是布尔 true');
  if (appFields.keys.length !== 7) {
    throw badArgs(`附表 YAML 应恰好 7 个键，实际 ${appFields.keys.length}：${appFields.keys.join(',')}`);
  }
  if (appFields.fields['名称'] !== `${sessKey}${STEM}——附表`) throw badArgs('附表 YAML 名称与 sessKey 不匹配');
  if (appFields.fields['父表'] !== mainName) throw badArgs('附表 YAML 父表与主表文件名不匹配');
  if (!/^\d+$/.test(appFields.fields['上下文条数'] || '')) throw badArgs('附表 YAML 上下文条数必须是非负整数');
  // 结构块清点（见 inspectAppendixStructure）：编号 1..K 连续、seq 严格升序，
  // 且 K == YAML 上下文条数。用户原文里行首 `## ` 的行不会被误算为结构块。
  if (appStruct.blockCount !== Number(appFields.fields['上下文条数'])) {
    throw badArgs(`附表 YAML 上下文条数(${appFields.fields['上下文条数']}) ≠ 结构 block 数(${appStruct.blockCount})`);
  }
  const sealedAt = mainFields.fields['生成时间'] || '';
  if (!DATETIME_RE.test(sealedAt)) throw badArgs('主表 YAML 生成时间格式不合法');

  // ---------- 3. 落盘（写新布局 `交接表/`；旧同名文件先留档；先附表、后主表；写后回读复核） ----------
  // V0.6.2：**写端只写新子目录**。老库里同样的文件在一级（未迁移）—— 两处候选都先 rename 留档，
  // 保证"旧文件不删、不覆盖"的语义在迁移前后一致；留档留在原位置（不跨目录搬动）。
  ensureSubdir(root, FILE_KIND.HANDOVER_MAIN);
  ensureSubdir(root, FILE_KIND.HANDOVER_APPENDIX);
  const mainPath = newLayoutPath(root, FILE_KIND.HANDOVER_MAIN, mainName);
  const appendixPath = newLayoutPath(root, FILE_KIND.HANDOVER_APPENDIX, appendixName);
  const archived = [];
  const logs = [];
  let wroteAppendix = false;
  let wroteMain = false;

  try {
    const archivePlan = [
      { role: 'appendix', rel: appendixName, candidates: pathCandidates(root, FILE_KIND.HANDOVER_APPENDIX, appendixName) },
      { role: 'main', rel: mainName, candidates: pathCandidates(root, FILE_KIND.HANDOVER_MAIN, mainName) },
    ];
    for (const { role, rel, candidates } of archivePlan) {
      for (const target of candidates) {
        if (!fs.existsSync(target)) continue;
        const to = archiveOldFile(target, now, offset);
        archived.push({ target: role, from: target, to });
        logs.push(`handover=archived old=${rel}`);
      }
    }

    writeFileTmpRename(appendixPath, appendixMarkdown);
    wroteAppendix = true;
    writeFileTmpRename(mainPath, mainMarkdown);
    wroteMain = true;

    // 写后回读复核：附表逐字节一致、主表正文 hash 重算一致（契约 3.2）。
    const appendixBack = fs.readFileSync(appendixPath, 'utf8');
    if (appendixBack !== appendixMarkdown) {
      throw new Error('附表写后回读与待写内容不一致');
    }
    const mainBack = fs.readFileSync(mainPath, 'utf8');
    if (mainBack !== mainMarkdown || handoverBodyHash(mainBack) !== bodyHash) {
      throw hashMismatch(
        `主表写后回读复核不通过：期望正文hash=${bodyHash} 实际=${handoverBodyHash(mainBack) || '(无正文)'}`,
        { expectedHash: bodyHash, actualHash: handoverBodyHash(mainBack) }
      );
    }
  } catch (e) {
    // 整批放弃：删掉本批新建的文件，把留档恢复回原名，清 tmp。
    try { if (wroteMain) fs.unlinkSync(mainPath); } catch { /* 回滚尽力而为 */ }
    try { if (wroteAppendix) fs.unlinkSync(appendixPath); } catch { /* 回滚尽力而为 */ }
    for (const a of archived.slice().reverse()) {
      try { if (fs.existsSync(a.to)) fs.renameSync(a.to, a.from); } catch { /* 回滚尽力而为 */ }
    }
    for (const p of [`${mainPath}.tmp`, `${appendixPath}.tmp`]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* tmp 清理尽力而为 */ }
    }
    if (e && e.code) throw e;
    const err = new Error(`E_HANDOVER_WRITE_FAILED: 交接表写入失败，已整批放弃：${e && e.message}`);
    err.code = 'E_HANDOVER_WRITE_FAILED';
    err.cause = e;
    throw err;
  }

  return {
    mainPath,
    appendixPath,
    mainRel: mainName,
    appendixRel: appendixName,
    sealHash: bodyHash,
    sealedAt,
    bytesMain: Buffer.byteLength(mainMarkdown, 'utf8'),
    bytesAppendix: Buffer.byteLength(appendixMarkdown, 'utf8'),
    archived,
    logs,
  };
}
