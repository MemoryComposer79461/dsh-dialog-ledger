/**
 * @file toolcards.js
 * @role **工具卡片渲染层**（V0.6 外层）：把 3 个 Agent 工具（`ledger_search` / `ledger_turn` /
 *       `ledger_health`）接到 Host 的 `presentCall` / `presentResult` 上，
 *       生成模型调用过程中给人看的卡片。
 *
 * @why 工具卡片不需要客户端插件：Host 的 `ToolDefinition` 自带两个可选回调
 *      （`presentCall(args)` → ToolCallView、`presentResult(args, result)` → ToolResultView）。
 *      本模块只做"值 → 视图"的纯映射，不读文件、不写日志、不碰任何状态。
 *
 * @why 纯函数 + 绝不抛：卡片只是展示层，展示失败不能把工具调用弄挂。
 *      所以每个入口都整体包在 try/catch 里，异常/未知工具一律返回 `undefined`
 *      （Host 会退化成默认渲染，等价于"没有卡片"）。
 *
 * @why 不在这里改工具 schema / 描述：契约 §3 明确"不许为了卡片改工具面"。
 *      toolface.js 只 import 本模块并给每个 def 接两个字段，其余原样。
 *
 * @why 0.9.2 工具面 9→3：`ledger_context` / `ledger_whoami` / `ledger_reconcile` / `ledger_anchor` /
 *      `ledger_cleanup_preview` / `ledger_cleanup_apply` 的 presenter 随工具一起退役 ——
 *      没有对应工具还留着卡片定义，只会让 `TOOLCARD_NAMES` 骗人。保留下来的 3 个
 *      presenter（search/turn/health）语义与裁剪前逐字一致。
 *
 * 卡片形态依据 Host `tools` 服务的实测类型（ToolResultView / ToolCallView）：
 *   - generic：`{ card:'generic', title?, content?: [{type:'text', text}] }`
 *   - read：   `{ card:'read', title?, path, offset, lines:[{number,text}], totalLines, lang?, content? }`
 *   - search： `{ card:'search', shape:'matches', title?, files:[...], truncated, total }`
 *
 * @depends 无（纯函数，零依赖）
 */

/** 工具名常量：与 toolface.js 的 T 保持一致，避免两处各写一份字符串。 */
const TOOL = {
  search: 'ledger_search',
  turn: 'ledger_turn',
  health: 'ledger_health',
};

/** 通用卡片正文最多显示多少行（超出时追加"…还有 N 行"）。契约 §3。 */
const MAX_BODY_LINES = 20;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v)));

/** 文本内容块。 */
const textBlocks = (text) => [{ type: 'text', text: String(text) }];

/** 通用卡片：标题 + 文本正文。 */
function generic(title, lines) {
  return { card: 'generic', title, content: textBlocks(lines.join('\n')) };
}

/** 通用正文的行数上限：最多 20 行，超出补一行"…还有 N 行"。 */
function clipLines(lines) {
  if (!Array.isArray(lines)) return [];
  if (lines.length <= MAX_BODY_LINES) return lines;
  return [...lines.slice(0, MAX_BODY_LINES), `…还有 ${lines.length - MAX_BODY_LINES} 行`];
}

/**
 * 把 `presentResult` 的第二个参数归一成"工具返回值"。
 *
 * @why Host 传的是 `ToolResult`（`{content, isError, meta}`），而我们自己的测试
 *      直接传 `execute` 的返回值。两种形态都要能出卡片：
 *      ① 已经是工具返回值（有 ok/rows/row/excerpt/ledgerOk/sessionId 之一）→ 原样用；
 *      ② 包装层带 `value`（ToolExecutionSuccess）→ 用 value；
 *      ③ 只有 content 文本块 → 从 `output.render` 的 JSON 文本里解析回来。
 *      解析不出来就原样返回，由具体渲染函数判 undefined。
 */
function unwrapResult(result) {
  if (!isObj(result)) return result;
  const KNOWN = ['ok', 'rows', 'row', 'excerpt', 'ledgerOk', 'sessionId', 'totalTurns'];
  if (KNOWN.some((k) => k in result)) return result;
  if (isObj(result.value)) return result.value;
  if (Array.isArray(result.content)) {
    const block = result.content.find((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string');
    if (block) {
      try {
        const parsed = JSON.parse(block.text);
        if (isObj(parsed)) return parsed;
      } catch { /* 不是 JSON 就继续走原样返回 */ }
    }
  }
  return result;
}

/**
 * `ledger_search` 的结果卡片：通用卡片 + 每行 `ts · code · turn · status`。
 * 标题带关键数字（行数 / 会话数），正文最多 20 行 + "…还有 N 行"。
 */
function searchResult(value) {
  if (!isObj(value)) return undefined;
  if (value.ok === false) return generic('账本检索失败', [str(value.reason) || '未知原因']);
  const rows = Array.isArray(value.rows) ? value.rows.filter(isObj) : [];
  const sids = new Set();
  const lines = [];
  for (const r of rows) {
    if (r.sid) sids.add(r.sid);
    if (lines.length >= MAX_BODY_LINES) continue;
    const turn = Number.isInteger(r.turn) ? String(r.turn) : '-';
    lines.push([str(r.ts), str(r.code), turn, str(r.status)].join(' · '));
  }
  if (rows.length > MAX_BODY_LINES) lines.push(`…还有 ${rows.length - MAX_BODY_LINES} 行`);
  if (lines.length === 0) lines.push('（无匹配行）');
  return {
    card: 'generic',
    title: `账本检索 · ${rows.length} 行 / ${sids.size} 会话`,
    content: textBlocks(lines.join('\n')),
  };
}

/** excerpt 逐行切：按 LF/CRLF 切，末尾换行产生的空行不算一行。 */
function excerptLines(excerpt) {
  if (typeof excerpt !== 'string' || excerpt.length === 0) return [];
  const lines = excerpt.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `ledger_turn` 的结果卡片：excerpt 逐行切给 `card:'read'`。
 * offset 固定 0（excerpt 就是从文件头开始的开头片段），totalLines = 行数。
 * excerpt 为空（或只有空白）时回退通用卡片 —— 空 read 卡片没有阅读价值。
 */
function turnResult(value) {
  if (!isObj(value)) return undefined;
  const row = isObj(value.row) ? value.row : {};
  const original = isObj(value.original) ? value.original : {};
  const code = str(row.code);
  const turn = Number.isInteger(row.turn) ? row.turn : null;
  if (value.ok === false) return generic('账本读取失败', [str(value.reason) || '未知原因']);

  const lines = excerptLines(value.excerpt);
  const meaningful = lines.some((l) => l.trim() !== '');
  if (!meaningful) {
    const body = [
      `编码: ${code || '(未知)'}`,
      `原文: ${original.exists ? (str(original.path) || '文件存在') : '未找到原文文件'}`,
      '（原文开头片段为空）',
    ];
    return generic(turn === null ? '某一轮 · 无原文片段' : `第 ${turn} 轮 · 无原文片段`, body);
  }
  return {
    card: 'read',
    title: turn === null ? '某一轮 · 原文开头' : `第 ${turn} 轮 · 原文开头`,
    path: code ? `编码 ${code}` : (str(original.path) || '(未知原文)'),
    offset: 0,
    lines: lines.map((text, i) => ({ number: i + 1, text })),
    totalLines: lines.length,
  };
}

/** `ledger_health` 的结果卡片：通用卡片 + 行数/会话/绑定/坏行等关键数字。 */
function healthResult(value) {
  if (!isObj(value)) return undefined;
  if (value.ledgerOk === undefined && value.ok === false) {
    return generic('账本健康读取失败', [str(value.reason) || str(value.message) || '未知原因']);
  }
  const num = (k) => (Number.isFinite(value[k]) ? String(value[k]) : 'unknown');
  const lines = [
    `行数: ${num('rows')} ｜ 会话: ${num('sessions')} ｜ 日数: ${num('days')}`,
    `已绑定: ${num('bound')} ｜ 未绑定: ${num('unbound')}`,
    `坏行: ${num('badLines')} ｜ 读取错误: ${num('readErrors')}`,
  ];
  if (value.ledgerOk === false) {
    lines.push('ledgerOk: false（台账未读全；上面数字是"读到多少算多少"）');
  }
  const title = value.ledgerOk === false
    ? '账本健康 · 读取异常'
    : `账本健康 · ${num('rows')} 行 / ${num('sessions')} 会话`;
  return generic(title, clipLines(lines));
}

/**
 * `presentCall`（工具"调用中"卡片）。
 *
 * @param {string} toolName
 * @param {unknown} args 模型给的参数
 * @returns {object|undefined} ToolCallView；未知工具/异常 → undefined
 */
export function presentCallFor(toolName, args) {
  try {
    const rawInput = args === undefined ? {} : args;
    switch (toolName) {
      case TOOL.search:
        // 契约 §3 逐字要求：检索调用的卡片标题与 kind
        return { card: 'generic', title: '检索会话账本', kind: 'search', rawInput };
      case TOOL.turn:
        return { card: 'generic', title: '读取某一轮原文', kind: 'read', rawInput };
      case TOOL.health:
        return { card: 'generic', title: '查账本健康摘要', kind: 'read', rawInput };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * `presentResult`（工具"结果"卡片）。
 *
 * @param {string} toolName
 * @param {unknown} args 模型给的参数（本层不依赖，保留给未来扩展）
 * @param {unknown} result `execute` 的返回值，或 Host 的 ToolResult 包装
 * @returns {object|undefined} ToolResultView；未知工具/异常 → undefined
 */
export function presentResultFor(toolName, args, result) {
  try {
    const value = unwrapResult(result);
    switch (toolName) {
      case TOOL.search: return searchResult(value);
      case TOOL.turn: return turnResult(value);
      case TOOL.health: return healthResult(value);
      default: return undefined;
    }
  } catch {
    return undefined;
  }
}

/** 供自测/验收复用的常量（不属于卡片契约，不会进入 Host）。 */
export const TOOLCARD_NAMES = Object.freeze(Object.values(TOOL));
export const TOOLCARD_MAX_BODY_LINES = MAX_BODY_LINES;
