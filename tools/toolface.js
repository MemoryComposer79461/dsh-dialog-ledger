/**
 * @file toolface.js
 * @role **Agent 工具面**（V0.6 外层）：把账本查询能力以 3 个工具暴露给模型 ——
 *       `ledger_search` / `ledger_turn` / `ledger_health`。
 *
 * @why 机主的要求：
 *   · "工具让 Agent 知晓有这样一个工具存在，其实是件好事"→ 工具默认注册；
 *   · "还能提醒 Agent 查询前先查自己 Session ID"→ 描述里写死这条工作流；
 *   · "内容不占用 Agent 上下文"→ 工具只返回**紧凑结果**（编码/时间/状态），
 *     完整原文要显式再调 `ledger_turn`，且默认只给开头片段。
 *
 * @why 0.9.2 工具面 9→3（S-8/P1 边界归零）：V0.9 扩面的 `ledger_context` / `ledger_whoami` /
 *      `ledger_reconcile` / `ledger_anchor` / `ledger_cleanup_preview` / `ledger_cleanup_apply`
 *      已退役 —— 其中 4 个的实现体在审查层 `freeze/cleanup-tools.js`，注册它们会让
 *      `index.js` 静态可达 `freeze/`（越界）。对账/清理能力仍在 core（`lib/reconcile.js`）
 *      与面板路由里，人还能用，只是 Agent 面收窄（见 0.9.2 方案 §3/§9.2）。
 *
 * @why 只读（3 个全部只读）：查询只调纯读函数与 `readlog`（写读日志，属运行区），
 *      一个字节都不写账。
 *
 * @why 每次调用都落读日志（V0.6.4 起 `ledger/.reads/YYYY-MM.jsonl` 按月分片；旧 `ledger/.reads.jsonl` 只读兼容）：这是"重审计"的落点 ——
 *      出事时能分清"没查"与"查了读错"。只在 root 合法且存在时写：否则"查一个不存在的库"
 *      会顺手把库目录建出来，违背只读工具的直觉。
 *
 * @depends ./ledgerapi.js、./readlog.js、./toolcards.js
 */
import fs from 'node:fs';

import { searchLedger, getTurn, summarize, EXCERPT_MAX_BYTES } from './ledgerapi.js';
// ★ V1.0：isSafeRoot 的唯一真相在 readlog.js（与被写模块同源），本文件不再复制判定逻辑。
import { appendRead, isSafeRoot } from './readlog.js';
import { presentCallFor, presentResultFor } from './toolcards.js';

/** 工具名前缀：统一即可，避免与内置工具撞名（ledger_* 目前无人占用）。 */
const T = {
  search: 'ledger_search',
  turn: 'ledger_turn',
  health: 'ledger_health',
};

const textBlock = (text) => [{ type: 'text', text }];
const jsonBlock = (value) => textBlock(JSON.stringify(value, null, 2));

/** 统一的结果渲染：模型读 JSON 摘要，人看工具卡片。 */
const outputDef = (schema) => ({
  schema,
  render: (_args, value) => jsonBlock(value),
});

/**
 * V0.6 工具卡片接线：只给 def 补 Host 的 `presentCall` / `presentResult` 两个字段。
 *
 * 渲染逻辑全部在 `lib/toolcards.js`（纯函数、可单测）；这里只把工具名绑进去。
 * @why 不在本文件写卡片逻辑：toolface 的职责是"注册工具 + 写读日志"，
 *      卡片是展示层，混在一起会让本文件越来越难测。
 */
const presenterOf = (toolName) => ({
  presentCall: (args) => presentCallFor(toolName, args),
  presentResult: (args, result) => presentResultFor(toolName, args, result),
});

/**
 * 描述里必须带上"先确定 Session ID"——这是机主明确要求的工作流提示。
 * 0.9.2：`ledger_whoami` 随工具面 9→3 退役，提示改为"先自行确认 sid"（search 允许不带 sid）。
 */
const SID_HINT = '【使用前提】先确认当前会话的 Session ID，再把 sid 传给本工具；'
  + '不带 sid = 查整个账本（结果可能很多）。';

/**
 * 构造工具定义（纯函数，方便单测：不依赖 ctx）。
 * @param {{getRoot:()=>string, offsetMinutes?:number, now?:()=>number}} env
 * @returns {Array<object>} ToolDefinition 数组（0.9.2 起固定 3 个：search / turn / health）
 */
export function buildToolDefs(env) {
  const getRoot = typeof env.getRoot === 'function' ? env.getRoot : () => String(env.root || '');
  const offsetMinutes = Number.isFinite(env.offsetMinutes) ? env.offsetMinutes : 480;
  const now = typeof env.now === 'function' ? env.now : () => Date.now();

  /** 统一包装：计时 + 读日志 + 结果兜底。 */
  const wrap = (toolName, runner) => async (args, exec) => {
    const t0 = now();
    const root = getRoot();
    const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '';
    let value;
    let errText = '';
    try {
      value = runner(args || {}, { root, sessionId });
    } catch (e) {
      errText = e && e.message ? e.message : String(e);
      value = { ok: false, reason: 'internal-error', message: errText };
    }
    // ★ 读日志只在 root 合法且存在时写：appendRead 会 mkdir，若 root 非法/不存在，
    //   一次"查不存在的库"就会建出 ledger/.reads —— 那不是读，是写。
    let canLog = false;
    try { canLog = isSafeRoot(root) && fs.existsSync(root); } catch { canLog = false; }
    const hitCodes = Array.isArray(value && value.rows)
      ? value.rows.map((r) => r.code).filter(Boolean)
      : (value && value.row && value.row.code ? [value.row.code] : []);
    try {
      if (canLog) {
        appendRead(root, {
          tool: toolName,
          sessionId,
          args: JSON.stringify(args || {}).slice(0, 240),
          hitCodes,
          returnedRows: Array.isArray(value && value.rows) ? value.rows.length : (value && value.row ? 1 : 0),
          bytes: Buffer.byteLength(JSON.stringify(value || {}), 'utf8'),
          ms: Math.max(0, now() - t0),
          ok: !errText,
          ...(errText ? { error: errText } : {}),
          nowMs: t0,
        });
      }
    } catch { /* 读日志写失败不影响查询结果 */ }
    return value;
  };

  return [
    {
      name: T.search,
      description: '在本地会话账本（银行日记账）里检索历史轮次，返回编码/时间/会话/轮次/状态/原文路径。'
        + SID_HINT,
      parameters: {
        type: 'object',
        properties: {
          sid: { type: 'string', description: '会话 ID（建议先自行确认当前会话 ID）。留空=全账本' },
          month: { type: 'string', description: '月份过滤，格式 YYYY-MM' },
          keyword: { type: 'string', description: '关键词（匹配编码/会话/时间/原文路径）' },
          limit: { type: 'integer', description: '最多返回多少行（默认 50，上限 200）' },
        },
        additionalProperties: false,
      },
      output: outputDef({ type: 'object' }),
      ...presenterOf(T.search),
      execute: wrap(T.search, (args) => searchLedger(getRoot(), {
        sid: args.sid, month: args.month, keyword: args.keyword, limit: args.limit, offsetMinutes,
      })),
    },
    {
      name: T.turn,
      description: '按编码取某一步的台账行 + 原文文件位置 + 原文开头片段（不整篇塞进上下文）。' + SID_HINT,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '32 位编码，形如 20261108-xxxxxxxxxxxx-A-00000001' },
          excerptBytes: {
            type: 'integer',
            description: '原文开头最多读多少字节（默认 800，0=只给路径；'
              + `硬上限 ${EXCERPT_MAX_BYTES}，超过按上限截断并在结果里标 excerptCapped）`,
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      output: outputDef({ type: 'object' }),
      ...presenterOf(T.turn),
      execute: wrap(T.turn, (args) => getTurn(getRoot(), args.code, {
        excerptBytes: args.excerptBytes, offsetMinutes,
      })),
    },
    {
      name: T.health,
      description: '账本健康摘要：行数、会话数、已绑定/未绑定数、坏行与读取错误数。用于自查"账是否读全"。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: outputDef({ type: 'object' }),
      ...presenterOf(T.health),
      execute: wrap(T.health, () => summarize(getRoot())),
    },
  ];
}

/**
 * 注册工具到 Harness。
 *
 * 用**可选依赖**方式取 `tools`：先 `ctx.get('tools')`，取不到再看 `ctx.tools`。
 * @why 不写进 `inject`：本插件的主职责是记账，工具面是可选增强；
 *      写进 inject 会让"没装工具服务的环境"整个插件加载失败——得不偿失。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{getRoot:()=>string, offsetMinutes?:number, logger?:object}} env
 * @returns {{registered:number, names:string[], dispose:()=>void}}
 */
export function registerLedgerTools(ctx, env) {
  const out = { registered: 0, names: [], dispose: () => {} };
  let tools = null;
  try {
    if (ctx && typeof ctx.get === 'function') tools = ctx.get('tools');
  } catch { tools = null; }
  // ★ V0.6.4 / A13：删除 `ctx.tools` 直读回退 —— Cordis 4 读未 inject 的服务属性必抛
  //   `cannot get property "tools" without inject`（启动并发窗口会踩中，导致整个 apply 失败）。
  if (!tools || typeof tools.register !== 'function') return out;

  const disposers = [];
  for (const def of buildToolDefs(env)) {
    try {
      const d = tools.register(def);
      if (typeof d === 'function') disposers.push(d);
      out.registered += 1;
      out.names.push(def.name);
    } catch (e) {
      if (env && env.logger && env.logger.warn) {
        env.logger.warn('[dsh-dialog-ledger] 注册工具失败 ' + def.name + ': ' + (e && e.message ? e.message : String(e)));
      }
    }
  }
  out.dispose = () => {
    for (const d of disposers) { try { d(); } catch { /* 卸载失败不影响其它 */ } }
  };
  return out;
}
