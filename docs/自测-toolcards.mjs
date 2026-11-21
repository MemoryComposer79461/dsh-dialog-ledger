/**
 * @file 自测-toolcards.mjs
 * @role V0.6 工具卡片自测：presentCall / presentResult 的形状、截断、回退，
 *       以及"接卡片不许改工具面"的回归断言。
 *
 * @why 卡片是给人看的展示层，但它挂在 Host 的 ToolDefinition 上：
 *      · 形状不合法 → Host 渲染可能报错，工具调用跟着挂 → 必须逐字段校验；
 *      · 为了卡片偷偷改 schema/描述 → 模型看到的工作流就变了 → 必须钉住原样；
 *      · 渲染异常不许向上喷 → 一律回退 undefined（Host 用默认渲染）。
 *
 * @depends ../tools/toolface.js、../tools/toolcards.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tf = await import(pathToFileURL(path.join(SRC, 'tools', 'toolface.js')).href);
const tc = await import(pathToFileURL(path.join(SRC, 'tools', 'toolcards.js')).href);

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const codeOf = (n) => `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`;

/** Host ToolResultView 合法 card 集合（实测类型子集）。 */
const VALID_CARDS = new Set(['generic', 'read', 'search', 'terminal', 'diff', 'web']);
const VALID_CALL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other']);

function assertContentBlocks(content, where) {
  assert.ok(Array.isArray(content), where + ': content 必须是数组');
  for (const b of content) {
    assert.ok(b && typeof b === 'object', where + ': content 块必须是对象');
    assert.equal(b.type, 'text', where + ': 目前只允许 text 块');
    assert.equal(typeof b.text, 'string', where + ': text 必须是字符串');
  }
}

/** 校验 ToolResultView 联合形状（契约 §4/A6）。 */
function assertToolResultView(view, where) {
  assert.ok(view && typeof view === 'object', where + ': 必须返回对象（实际 ' + typeof view + '）');
  assert.ok(VALID_CARDS.has(view.card), where + ': card 非法（实际 ' + view.card + '）');
  if (view.card === 'generic' || view.card === 'read') {
    if (view.title !== undefined) assert.equal(typeof view.title, 'string', where + ': title 必须是字符串');
    if (view.content !== undefined) assertContentBlocks(view.content, where);
  }
  if (view.card === 'read') {
    assert.equal(typeof view.path, 'string', where + ': read.path 必须是字符串');
    assert.ok(Number.isInteger(view.offset) && view.offset >= 0, where + ': read.offset 必须是非负整数');
    assert.ok(Array.isArray(view.lines), where + ': read.lines 必须是数组');
    for (const l of view.lines) {
      assert.ok(Number.isInteger(l.number), where + ': read.lines[].number 必须是整数');
      assert.equal(typeof l.text, 'string', where + ': read.lines[].text 必须是字符串');
    }
    assert.ok(Number.isInteger(view.totalLines), where + ': read.totalLines 必须是整数');
    if (view.lang !== undefined) assert.equal(typeof view.lang, 'string', where + ': read.lang 必须是字符串');
  }
  if (view.card === 'search') {
    assert.equal(view.shape, 'matches', where + ': search.shape 必须是 matches');
    assert.ok(Array.isArray(view.files), where + ': search.files 必须是数组');
    assert.equal(typeof view.truncated, 'boolean', where + ': search.truncated 必须是布尔');
    assert.ok(Number.isFinite(view.total), where + ': search.total 必须是数字');
  }
}

/** 校验 ToolCallView 联合形状。 */
function assertToolCallView(view, where) {
  assert.ok(view && typeof view === 'object', where + ': 必须返回对象');
  assert.equal(view.card, 'generic', where + ': 本项目只用 generic 调用卡片');
  assert.equal(typeof view.title, 'string', where + ': title 必须是字符串');
  if (view.kind !== undefined) assert.ok(VALID_CALL_KINDS.has(view.kind), where + ': kind 非法');
  if (view.content !== undefined) assertContentBlocks(view.content, where);
}

/** 夹具账库：与 docs/自测-toolface.mjs 同一套最小可读账（3 行 + 1 份原文）。 */
function lab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcards-'));
  const root = path.join(base, 'root');
  const led = path.join(root, 'ledger');
  fs.mkdirSync(led, { recursive: true });
  const rows = [1, 2, 3].map((n) => ({
    v: 3, code: codeOf(n), ts: `2026-11-08 1${n}:00:00 +08:00`, sid: n === 3 ? 'session-other' : SID,
    turn: n, seq: n, status: 'ok', turnState: 'closed',
    doc: `2026年11月\\11月第2周\\${codeOf(n)} 完整原文.md`,
    docSha256: 'a'.repeat(64), docFileSha256: 'b'.repeat(64),
    attachment: { name: `${codeOf(n)} 原始事件.json`, sha256: 'c'.repeat(64), bytes: 1 },
  }));
  fs.writeFileSync(path.join(led, '2026-11-08.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const abs = path.join(root, rows[0].doc);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# 第 1 轮\n\n## 1. 用户输入\n\n你好。\n', 'utf8');
  return { base, root };
}

/** 每个工具的典型调用参数（与 docs/自测-toolface.mjs 保持一致）。 */
const ARGS = {
  ledger_search: { sid: SID, limit: 10 },
  ledger_turn: { code: codeOf(1) },
  ledger_context: { sid: SID, turns: 10 },
  ledger_whoami: {},
  ledger_health: {},
};

/** 原 5 个工具的定义快照：name/description/parameters 一个字都不许变（回归）。 */
const SID_HINT = '【使用前提】先用 ledger_whoami 取到当前会话的 Session ID，再把 sid 传给本工具；'
  + '不带 sid = 查整个账本（结果可能很多）。';
const EXPECTED_DEFS = [
  {
    name: 'ledger_search',
    description: '在本地会话账本（银行日记账）里检索历史轮次，返回编码/时间/会话/轮次/状态/原文路径。' + SID_HINT,
    parameters: {
      type: 'object',
      properties: {
        sid: { type: 'string', description: '会话 ID（建议先用 ledger_whoami 取）。留空=全账本' },
        month: { type: 'string', description: '月份过滤，格式 YYYY-MM' },
        keyword: { type: 'string', description: '关键词（匹配编码/会话/时间/原文路径）' },
        limit: { type: 'integer', description: '最多返回多少行（默认 50，上限 200）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ledger_turn',
    description: '按编码取某一步的台账行 + 原文文件位置 + 原文开头片段（不整篇塞进上下文）。' + SID_HINT,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '32 位编码，形如 20261108-xxxxxxxxxxxx-A-00000001' },
        excerptBytes: { type: 'integer', description: '原文开头最多读多少字节（默认 800，0=只给路径）' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'ledger_context',
    description: '取某个会话最近 N 轮（紧凑列表），用于上下文被压缩/换会话后重新接上。' + SID_HINT,
    parameters: {
      type: 'object',
      properties: {
        sid: { type: 'string', description: '会话 ID（必填；先用 ledger_whoami 取）' },
        turns: { type: 'integer', description: '最近多少轮（默认 10，上限 100）' },
      },
      required: ['sid'],
      additionalProperties: false,
    },
  },
  {
    name: 'ledger_whoami',
    description: '返回当前会话的 Session ID。查账前先调它，再把 sid 传给 ledger_search / ledger_context。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ledger_health',
    description: '账本健康摘要：行数、会话数、已绑定/未绑定数、坏行与读取错误数。用于自查"账是否读全"。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

test('V0.6/toolcards：原 5 个工具 name/description/parameters 未被改动（回归）', () => {
  const defs = tf.buildToolDefs({ getRoot: () => '/nonexistent', offsetMinutes: 480 });
  // ★ V0.9：工具数 5→9。原 5 个必须**仍排在最前**且逐字未动；新增 4 个只许排在后面。
  assert.equal(defs.length, 9, 'V0.9 起工具面共 9 个（原 5 + 新增 4），实际 ' + defs.length);
  assert.deepEqual(defs.map((d) => d.name).slice(0, EXPECTED_DEFS.length),
    EXPECTED_DEFS.map((x) => x.name), '原 5 个工具的顺序/名字被改了');
  for (const expected of EXPECTED_DEFS) {
    const def = defs.find((d) => d.name === expected.name);
    assert.ok(def, '工具缺失: ' + expected.name);
    assert.equal(def.description, expected.description, expected.name + ' 的描述被改了（工作流提示不许动）');
    assert.deepEqual(def.parameters, expected.parameters, expected.name + ' 的 schema 被改了');
    // 原字段一个不少，且没有别的东西混进来
    assert.deepEqual(Object.keys(def).sort(), [
      'description', 'execute', 'name', 'output', 'parameters', 'presentCall', 'presentResult',
    ], def.name + ' 的字段集合变了');
  }
});

test('V0.6/toolcards：每个工具都接了 presentCall/presentResult，调用卡片合法', () => {
  const defs = tf.buildToolDefs({ getRoot: () => '/nonexistent', offsetMinutes: 480 });
  for (const def of defs) {
    assert.equal(typeof def.presentCall, 'function', def.name + ' 缺 presentCall');
    assert.equal(typeof def.presentResult, 'function', def.name + ' 缺 presentResult');
    assertToolCallView(def.presentCall(ARGS[def.name] || {}), def.name + '.presentCall');
  }
  // 契约 §3 逐字：ledger_search 的 presentCall 形态
  const search = defs.find((d) => d.name === 'ledger_search');
  assert.deepEqual(search.presentCall({ sid: SID }), {
    card: 'generic', title: '检索会话账本', kind: 'search', rawInput: { sid: SID },
  });
});

test('V0.6/toolcards：5 个工具真实执行后，presentResult 全部返回合法卡片', async () => {
  const { base, root } = lab();
  try {
    const defs = tf.buildToolDefs({ getRoot: () => root, offsetMinutes: 480 });
    const by = Object.fromEntries(defs.map((d) => [d.name, d]));
    const exec = { agent: { id: SID } };

    const values = {};
    for (const name of Object.keys(ARGS)) {
      values[name] = await by[name].execute(ARGS[name], exec);
    }
    for (const name of Object.keys(ARGS)) {
      const view = by[name].presentResult(ARGS[name], values[name]);
      assertToolResultView(view, name + '.presentResult');
    }

    // 关键数字必须在卡片里（不只是"形状合法"）
    const searchView = by.ledger_search.presentResult(ARGS.ledger_search, values.ledger_search);
    assert.equal(searchView.card, 'generic');
    assert.equal(searchView.title, '账本检索 · 2 行 / 1 会话');
    assert.match(searchView.content[0].text, /20261108-75238718e41a-A-00000001/, '正文必须带编码');
    assert.match(searchView.content[0].text, / · 1 · ok/, '正文行必须是 ts · code · turn · status');

    const turnView = by.ledger_turn.presentResult(ARGS.ledger_turn, values.ledger_turn);
    assert.equal(turnView.card, 'read');
    assert.equal(turnView.path, '编码 ' + codeOf(1));
    assert.equal(turnView.offset, 0);
    assert.equal(turnView.totalLines, turnView.lines.length);
    assert.equal(turnView.lines[0].number, 1);
    assert.match(turnView.lines.map((l) => l.text).join('\n'), /你好/);

    const ctxView = by.ledger_context.presentResult(ARGS.ledger_context, values.ledger_context);
    assert.equal(ctxView.card, 'generic');
    assert.match(ctxView.title, /会话上下文 · 2 \/ 2 轮/);
    assert.match(ctxView.content[0].text, new RegExp(SID));

    const whoView = by.ledger_whoami.presentResult(ARGS.ledger_whoami, values.ledger_whoami);
    assert.equal(whoView.card, 'generic');
    assert.match(whoView.title, /当前会话 · 已识别/);
    assert.match(whoView.content[0].text, new RegExp(SID));

    const healthView = by.ledger_health.presentResult(ARGS.ledger_health, values.ledger_health);
    assert.equal(healthView.card, 'generic');
    assert.match(healthView.title, /账本健康 · 3 行 \/ 2 会话/);
    assert.match(healthView.content[0].text, /行数: 3/);
    assert.match(healthView.content[0].text, /坏行: 0/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/toolcards：ledger_search 正文最多 20 行，超出补"…还有 N 行"', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    code: codeOf(i + 1),
    ts: `2026-11-08 ${String(10 + (i % 10)).padStart(2, '0')}:00:00 +08:00`,
    sid: i % 2 === 0 ? SID : 'session-other',
    turn: i + 1,
    status: 'ok',
  }));
  const view = tc.presentResultFor('ledger_search', {}, { ok: true, rows, total: 25, truncated: false });
  assertToolResultView(view, 'ledger_search');
  assert.equal(view.title, '账本检索 · 25 行 / 2 会话');
  const lines = view.content[0].text.split('\n');
  assert.equal(lines.length, 21, '正文应为 20 行数据 + 1 行省略提示');
  assert.equal(lines[20], '…还有 5 行');

  // 恰好 20 行时不补省略行
  const view20 = tc.presentResultFor('ledger_search', {}, { ok: true, rows: rows.slice(0, 20), total: 20 });
  assertToolResultView(view20, 'ledger_search/20');
  assert.equal(view20.content[0].text.split('\n').length, 20);

  // 空结果：合法卡片，给"无匹配行"
  const empty = tc.presentResultFor('ledger_search', {}, { ok: true, rows: [], total: 0 });
  assertToolResultView(empty, 'ledger_search/empty');
  assert.equal(empty.title, '账本检索 · 0 行 / 0 会话');
  assert.equal(empty.content[0].text, '（无匹配行）');
});

test('V0.6/toolcards：ledger_turn 的 excerpt 逐行切成 read 卡片（offset=0、行号从 1 起）', () => {
  const value = {
    ok: true,
    row: { code: codeOf(9), turn: 9 },
    original: { path: '2026年11月/11月总“完整原文”/x 完整原文.md', exists: true, bytes: 10 },
    excerpt: '# 第 9 轮\n\n## 1. 用户输入\n\n你好。\n',
    excerptTruncated: false,
  };
  const view = tc.presentResultFor('ledger_turn', { code: codeOf(9) }, value);
  assertToolResultView(view, 'ledger_turn');
  assert.equal(view.card, 'read');
  assert.equal(view.offset, 0);
  assert.equal(view.path, '编码 ' + codeOf(9));
  assert.deepEqual(view.lines.map((l) => l.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(view.lines.map((l) => l.text), ['# 第 9 轮', '', '## 1. 用户输入', '', '你好。']);
  assert.equal(view.totalLines, 5);

  // excerpt 为空 → 回退 generic（空 read 卡片没有阅读价值）
  const empty = tc.presentResultFor('ledger_turn', { code: codeOf(9) }, { ...value, excerpt: '' });
  assertToolResultView(empty, 'ledger_turn/empty');
  assert.equal(empty.card, 'generic');
  assert.match(empty.title, /无原文片段/);

  // 空白 excerpt 也按空处理
  const blank = tc.presentResultFor('ledger_turn', { code: codeOf(9) }, { ...value, excerpt: ' \n\t\n' });
  assertToolResultView(blank, 'ledger_turn/blank');
  assert.equal(blank.card, 'generic');
});

test('V0.6/toolcards：未知工具/异常输入一律回退 undefined（绝不抛）', () => {
  // 未知工具
  assert.equal(tc.presentCallFor('ledger_nope', {}), undefined);
  assert.equal(tc.presentResultFor('ledger_nope', {}, {}), undefined);
  assert.equal(tc.presentCallFor('', undefined), undefined);
  // 非对象 result
  assert.equal(tc.presentResultFor('ledger_search', {}, null), undefined);
  assert.equal(tc.presentResultFor('ledger_turn', {}, undefined), undefined);
  assert.equal(tc.presentResultFor('ledger_context', {}, 'not-an-object'), undefined);
  assert.equal(tc.presentResultFor('ledger_health', {}, 42), undefined);
  assert.equal(tc.presentResultFor('ledger_whoami', {}, []), undefined);
  // 渲染过程中抛异常（恶意 getter）→ 仍然返回 undefined 而不是抛
  const evil = { get rows() { throw new Error('boom'); }, ok: true };
  let view;
  assert.doesNotThrow(() => { view = tc.presentResultFor('ledger_search', {}, evil); });
  assert.equal(view, undefined);
});

test('V0.6/toolcards：兼容 Host 的 ToolResult 包装（从 content JSON 解析回工具值）', async () => {
  const { base, root } = lab();
  try {
    const defs = tf.buildToolDefs({ getRoot: () => root, offsetMinutes: 480 });
    const by = Object.fromEntries(defs.map((d) => [d.name, d]));
    const value = await by.ledger_search.execute({ sid: SID }, { agent: { id: SID } });
    // Host 的 ToolResult 形状：{content, isError, meta}，工具值在 content 的 JSON 文本里
    const wrapped = {
      content: by.ledger_search.output.render({}, value),
      isError: false,
    };
    const view = by.ledger_search.presentResult({ sid: SID }, wrapped);
    assertToolResultView(view, 'ledger_search/wrapped');
    assert.equal(view.title, '账本检索 · 2 行 / 1 会话');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
