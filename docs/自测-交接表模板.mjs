/**
 * @file 自测-交接表模板.mjs
 * @role 交接表 v1.3 契约自测：覆盖《实现checklist-v1.3》HO-01~HO-31 / HA-01~HA-20 中
 *       能由产物/state 机器判定的条目（主表 11 键、声明第 4 条、封板 hash 独立复算、
 *       附表 5 类 block、seq 升序、编号与条数一致、空表「无」、默认不截断、>8MiB 截断、
 *       generate/adopt/skip 三态、旧文件留档、同批不变量、无 tmp/无占位符残留）。
 *       另含 Lead 2026-11-09 审计裁定：附表逐字照录区**不改字节**（CR/`{{`/行首 `## ` 全保留），
 *       只有生成结构行必须 LF 且无 CR —— 见「审计裁定」两条用例。
 * @why 契约 v1.3 的核心是"产物写完能被独立复算"。所以本文件尽量**不复用被测实现**
 *      的解析函数：YAML 用自己的行解析、hash 自己重算、block 编号自己数。
 * @run
 *   & "<build-host>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
 *     --test "docs/自测-交接表模板.mjs"
 *   （cwd = <test-dir>\work\v0.5-工作副本）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = await import(pathToFileURL(path.join(SRC, 'freeze', 'handover.js')).href);
const L = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);

const KEY = 'aaaaaaaaaaaaA';
const S12 = 'aaaaaaaaaaaa';
const GEN = 'A';
/** 固定运行时刻（2026-11-09 13:00:00 +08:00），保证断言确定。 */
const NOW = Date.parse('2026-11-09T13:00:00+08:00');
const T0 = NOW - 2 * 3600 * 1000;
const LIMIT = 8 * 1024 * 1024;

const MAIN_RE = /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表\.md$/;
const APPENDIX_RE = /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表——附表\.md$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ROLE_RE = '(?:user\\/message|assistant\\/message|tool\\/call|tool\\/result|system\\/message)';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// 通用工具：临时目录隔离 + 独立解析
// ---------------------------------------------------------------------------

function makeRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ho13-${label}-`));
}

function dispose(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
}

/** 独立解析 YAML 前置块（不用被测实现的 handoverYamlFields）。 */
function splitDoc(markdown) {
  assert.equal(markdown.startsWith('---\n'), true, '产物必须以 YAML 前置块 --- 开头');
  const close = markdown.indexOf('\n---\n', 4);
  assert.notEqual(close, -1, 'YAML 前置块必须有结束行 ---');
  const keys = [];
  const fields = {};
  for (const line of markdown.slice(4, close).split('\n')) {
    const m = /^([^:]+):(.*)$/.exec(line);
    assert.ok(m, 'YAML 行无法解析：' + line);
    keys.push(m[1]);
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    fields[m[1]] = v;
  }
  return { keys, fields, yaml: markdown.slice(0, close + 5), body: markdown.slice(close + 5) };
}

/** 独立取正文：从第一个行首 `# ` 起（契约 3.2 口径）。 */
function bodyByAnchor(markdown) {
  const m = /^# /m.exec(markdown);
  assert.ok(m, '产物必须含以 "# " 开头的正文标题行');
  return markdown.slice(m.index);
}

/** 产物的编码/结尾硬约束（HO-02、H12、A18）—— 用于**主表**（全部是生成结构）。 */
function assertEncoding(markdown, label) {
  const buf = Buffer.from(markdown, 'utf8');
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${label} 不得有 UTF-8 BOM`);
  assert.equal(markdown.includes('\r'), false, `${label} 不得含 CR（换行必须 LF）`);
  assert.equal(markdown.endsWith('\n'), true, `${label} 必须以一个换行结尾`);
  assert.equal(markdown.endsWith('\n\n'), false, `${label} 结尾不得有空行（恰好一个结尾换行）`);
  assert.equal(Buffer.from(markdown, 'utf8').toString('utf8'), markdown, `${label} 必须是合法 UTF-8`);
}

/**
 * 附表「生成结构」编码约束（Lead 2026-11-09 审计裁定）：
 * 逐字照录的原文**允许**含 CR / `{{` / 行首 `## `（一律不改字节）；
 * 只有生成结构（YAML、固定说明句、block 标题行、元信息行、分隔线、结束行）必须 LF 且无 CR。
 */
function assertAppendixStructure(markdown) {
  const buf = Buffer.from(markdown, 'utf8');
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '附表 不得有 UTF-8 BOM');
  assert.equal(Buffer.from(markdown, 'utf8').toString('utf8'), markdown, '附表 必须是合法 UTF-8');
  assert.equal(markdown.endsWith('\n'), true, '附表 必须以一个换行结尾');
  assert.equal(markdown.endsWith('\n\n'), false, '附表 结尾不得有空行');
  const anchor = /^# /m.exec(markdown);
  assert.ok(anchor, '附表 必须有行首 "# " 的正文标题');
  assert.equal(markdown.slice(0, anchor.index).includes('\r'), false, '附表 YAML 前置块必须无 CR');
  const bodyFirstLine = markdown.slice(anchor.index).split('\n')[0];
  assert.equal(bodyFirstLine.includes('\r'), false, '附表 H1 标题行必须无 CR');
  // block 结构行（标题 + 元信息）必须无 CR；原文里恰好行首 `## ` 的行不在检查范围。
  const lines = markdown.split('\n');
  const roleRe = new RegExp(`^## \\d+\\. ${ROLE_RE}$`);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!roleRe.test(lines[i])) continue;
    if (!/^\[seq \d+\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(lines[i + 1])) continue;
    assert.equal(lines[i].includes('\r'), false, 'block 标题行必须无 CR');
    assert.equal(lines[i + 1].includes('\r'), false, '元信息行必须无 CR');
  }
  // 固定说明句 / 结束行（结构）无 CR。
  for (const fixed of ['> 本表是启用插件前的上下文原件', '> 主体信息、权限约定与目录规则见', '> 新会话在首轮即启用插件的',
    '> 以上为插件启动接管前的全部上下文', '**结束** · ']) {
    const idx = markdown.indexOf(fixed);
    assert.notEqual(idx, -1, '附表缺少固定结构：' + fixed);
    const nl = markdown.indexOf('\n', idx);
    assert.equal(markdown.slice(idx, nl).includes('\r'), false, '固定结构行必须无 CR：' + fixed);
  }
  assert.equal(markdown.includes('\n---\n\n**结束** · '), true, '附表缺少结构分隔线/结束行');
}

/** 数附表 block 标题（独立正则，不依赖实现）。 */
function blockHeadings(markdown) {
  return markdown.match(new RegExp(`^## \\d+\\. ${ROLE_RE}$`, 'gm')) || [];
}

function blockRoles(markdown) {
  return blockHeadings(markdown).map((l) => l.replace(/^## \d+\. /, ''));
}

function seqList(markdown) {
  const out = [];
  const re = /^\[seq (\d+)\] /gm;
  let m;
  while ((m = re.exec(markdown)) !== null) out.push(Number(m[1]));
  return out;
}

function blockNumbers(markdown) {
  return blockHeadings(markdown).map((l) => Number(/^## (\d+)\./.exec(l)[1]));
}

/** 固定夹具：5 类事件（含过滤项、多 text 块、图片/文件占位、thinking、tool_use 指针）。 */
function baseEvents() {
  return [
    { seq: 1, type: 'turn/start', time: T0, data: { turn: 1 } },
    {
      seq: 2, type: 'user/message', time: T0 + 1000,
      data: {
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '用户原文一' },
          { type: 'text', text: '用户原文二' },
          { type: 'image', attachment: { name: 'x.png' } },
          { type: 'file', name: '报表.csv' },
        ],
      },
    },
    { seq: 3, type: 'user/message', time: T0 + 1100, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入内容-不得出现' }] } },
    {
      seq: 4, type: 'assistant/message', time: T0 + 2000,
      data: {
        message: {
          content: [
            { type: 'text', text: '助手正文' },
            { type: 'thinking', thinking: '思考原文' },
            { type: 'tool_use', id: 'call_1', name: 'read' },
          ],
        },
      },
    },
    { seq: 5, type: 'tool/call', time: T0 + 2100, data: { callId: 'call_1', name: 'read', arguments: '{"path":"a.md","n":1}' } },
    { seq: 6, type: 'tool/result', time: T0 + 2200, data: { message: { isError: false, content: [{ type: 'text', text: '工具返回文本' }] } } },
    { seq: 7, type: 'system/message', time: T0 + 2300, data: { message: { content: [{ type: 'text', text: '系统消息原文' }] } } },
  ];
}

function renderMain(nowMs = NOW, extra = {}) {
  return H.renderHandoverMain({ sessKey: KEY, nowMs, ...extra });
}

function renderApp(events, nowMs = NOW, extra = {}) {
  return H.renderHandoverAppendix({ events, sessKey: KEY, nowMs, ...extra });
}

/** 走一遍 Lead 的集成路径：decide → render → write → markSealed → state 落盘。 */
function generateBatch(root, state, { nowMs = NOW, events = baseEvents() } = {}) {
  const decision = H.decideHandover({ root, sessKey: KEY, state, nowMs });
  assert.equal(decision.decision, 'generate', '空目录 + state 无记录必须 generate');
  const main = renderMain(nowMs);
  const app = renderApp(events, nowMs);
  const written = H.writeHandover({
    root, sessKey: KEY, mainMarkdown: main.markdown, appendixMarkdown: app.markdown,
    sealHash: main.sealHash, nowMs,
  });
  const record = H.markSealed(state, KEY, {
    sealedAt: written.sealedAt, sealHash: written.sealHash,
    main: written.mainRel, appendix: written.appendixRel, reopened: decision.reopened,
  });
  L.writeState(root, state);
  return { decision, main, app, written, record };
}

// ===========================================================================
// 一、主表（HO-01 ~ HO-20、H1 ~ H12）
// ===========================================================================

test('HO-01/02/03/04/05/06/07/08/09/10/11：文件名与 YAML 11 键（顺序/取值/布尔/单引号 hash）', () => {
  const main = renderMain();
  const fileName = H.handoverMainName(KEY);
  assert.equal(fileName, 'aaaaaaaaaaaaA的记忆数据库的启用及交接表.md');
  assert.match(fileName, MAIN_RE, 'HO-01 文件名必须带「记忆数据库的」且 {S}{D} 连写');

  assertEncoding(main.markdown, '主表');
  const { keys, fields } = splitDoc(main.markdown);

  // HO-03：恰好 11 键，顺序固定。
  assert.deepEqual(keys, ['名称', '会话标识', '代差', '委托人', '执行', '记录', '生成器', '生成时间', '附表', '封板', '封板hash']);

  // HO-04：名称 = {S}{D}的记忆数据库的启用及交接表。
  assert.equal(fields['名称'], `${KEY}的记忆数据库的启用及交接表`);
  // HO-05：会话标识/代差与文件名拆位一致。
  assert.match(fields['会话标识'], /^[0-9a-z]{12}$/);
  assert.equal(fields['会话标识'], S12);
  assert.equal(fields['代差'], GEN);
  // HO-06：固定元信息。
  assert.equal(fields['委托人'], 'user');
  assert.equal(fields['执行'], '日常会话记录插件（Tool）');
  assert.equal(fields['记录'], '系统（Cordis）');
  // HO-07：生成器非空、无占位符。
  assert.ok(fields['生成器'].length >= 1);
  assert.equal(fields['生成器'].includes('{{'), false);
  assert.equal(fields['生成器'].includes('}}'), false);
  // HO-08：生成时间格式与运行时刻（这里显式传 NOW，精确相等）。
  assert.match(fields['生成时间'], DATETIME_RE);
  assert.equal(fields['生成时间'], '2026-11-09 13:00:00');
  assert.equal(main.markdown.includes('Z'), false, '全文不得出现 Z 结尾时间');
  // HO-09：附表字段指向同目录附表文件名。
  assert.equal(fields['附表'], 'aaaaaaaaaaaaA的记忆数据库的启用及交接表——附表.md');
  // HO-10：封板必须是布尔 true（字面量，不是字符串）。
  assert.match(main.markdown, /^封板: true$/m);
  assert.notEqual(fields['封板'], '"true"');
  // HO-11：封板hash 单引号包裹、64 位小写 hex。
  assert.match(main.markdown, /^封板hash: '[0-9a-f]{64}'$/m);
  assert.match(fields['封板hash'], /^[0-9a-f]{64}$/);
});

test('HO-12/13：抬头表恰 8 行、项目顺序固定、单元格与 YAML 逐字段一致', () => {
  const main = renderMain();
  const { fields } = splitDoc(main.markdown);
  const body = bodyByAnchor(main.markdown);
  const start = body.indexOf('| 项目');
  const end = body.indexOf('\n## 声明');
  assert.ok(start > -1 && end > start, '抬头表必须位于正文 H1 与「## 声明」之间');
  const tableLines = body.slice(start, end).split('\n').filter((l) => l.startsWith('|'));
  assert.ok(tableLines.length >= 10, '抬头表必须含表头 + 分隔行 + 8 数据行');
  // 去掉表头与分隔行（|---|---| 形态）后应为 8 行数据。
  const dataLines = tableLines.filter((l) => !/^\|\s*:?-{2,}/.test(l) && !/\|\s*项目\s*\|/.test(l));
  assert.equal(dataLines.length, 8, 'HO-12 抬头表恰 8 行');
  const rows = dataLines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  assert.deepEqual(rows.map((r) => r[0]), ['名称', '会话标识', '代差', '委托人', '执行', '记录', '生成时间', '附表']);

  const values = Object.fromEntries(rows);
  // HO-13：8 个单元格与 YAML 对应字段一致（生成时间允许带 （UTC+08:00） 后缀）。
  assert.equal(values['名称'], fields['名称']);
  assert.equal(values['会话标识'].startsWith(fields['会话标识']), true);
  assert.equal(values['代差'].startsWith(fields['代差']), true);
  assert.equal(values['委托人'], fields['委托人']);
  assert.equal(values['执行'], fields['执行']);
  assert.equal(values['记录'], fields['记录']);
  assert.equal(values['生成时间'], `${fields['生成时间']}（UTC+08:00）`);
  assert.equal(values['附表'], fields['附表']);
});

test('HO-14/H5：声明恰 4 条，第 4 条逐字等于契约改写句，第 1–3 条不变', () => {
  const md = renderMain().markdown;
  const sec = md.slice(md.indexOf('## 声明'), md.indexOf('## 相关文件'));
  const items = sec.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
  assert.equal(items.length, 4, '声明必须恰 4 条');
  assert.equal(items[0], '说明记录会话主体。');
  assert.equal(items[1], '赋予 user 管理、修改、审计等权利，但后果自负。');
  assert.equal(items[2], '给予 Agent 使用权和修改权，但不给予审计权，且修改需获得 user 授权。');
  assert.equal(
    md.includes('该数据库为共享库，不对任何会话进行屏蔽。★ 会话不默认知晓自己的 Session ID，须先自查（调用本插件工具 / 问 user）方可定位自己的账。'),
    true,
    '第 4 条必须逐字包含契约改写句（决定 1）'
  );
  assert.equal(md.includes('默认会话知晓自己前十二位 ID'), false, '不得残留 v1.2 旧声明');
});

test('HO-15/16/17：相关文件 2 行、数据库架构三级 + 存放规则 3 条、结束行', () => {
  const md = renderMain().markdown;
  const { fields } = splitDoc(md);

  const relStart = md.indexOf('## 相关文件');
  const archStart = md.indexOf('## 数据库架构');
  assert.ok(relStart > -1 && archStart > relStart);
  const relRows = md.slice(relStart, archStart).split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*:?-{2,}/.test(l) && !/\|\s*文件\s*\|/.test(l));
  assert.equal(relRows.length, 2, 'H6 相关文件表恰 2 行');
  const firstCell = relRows[0].replace(/^\||\|$/g, '').split('|')[0].trim();
  assert.equal(firstCell, `《${fields['附表']}》`, '相关文件第 1 行文件名必须等于 YAML 附表');
  assert.equal(relRows[1].includes('完整原文'), true);

  const archSec = md.slice(archStart);
  for (const line of [
    '- **第一级：数据总库**',
    '- **第二级：XX月份文件夹**',
    '- **第三级：xx月总“完整原文”文件夹**',
    '### 存放规则',
    '- 所有 Session 的启用及交接表、“完整原文”清理报告，均放在**第一层**',
    '- 所有 Session 的周记账，均放在**第二层**',
    '- 所有 Session 的“完整原文”，均放在**第三层**',
    '  - 周记账：`xx月第x周-{S}{D}的周记账.xlsx`',
  ]) {
    assert.equal(archSec.includes(line), true, 'HO-16 数据库架构缺少（或改动了）模板行：' + line);
  }

  const lastLine = md.trimEnd().split('\n').pop();
  assert.match(lastLine, /^\*\*结束\*\* · [0-9a-z]{12}[A-Z] · 生成器 \S+$/, 'HO-17 结束行格式');
  assert.equal(lastLine, `**结束** · ${KEY} · 生成器 ${H.DEFAULT_GENERATOR}`);
});

test('HO-18/H8：封板 hash 独立复算 == YAML 封板hash（只覆盖正文，不含 YAML）', () => {
  const md = renderMain().markdown;
  const { fields, yaml } = splitDoc(md);
  const body = bodyByAnchor(md);
  assert.equal(body.startsWith('# '), true);
  const recomputed = sha256(body);
  assert.equal(recomputed, fields['封板hash'], 'HO-18 独立复算必须与 YAML 封板hash 一致');
  // 证明 hash 不含 YAML：整份文件 hash 与正文 hash 不同。
  assert.notEqual(sha256(md), recomputed, '封板hash 不得覆盖 YAML 前置块');
  assert.equal(yaml.includes(recomputed), true);
  assert.equal(body.includes('封板hash'), false, '正文里不得另写 hash 行（3.2 禁止）');
});

test('HO-20/H11/H12：主表无未替换占位符、无 CR、无 BOM、恰好一个结尾换行', () => {
  const md = renderMain().markdown;
  assertEncoding(md, '主表');
  assert.equal(md.includes('{{'), false, 'H11 不得残留 {{');
  assert.equal(md.includes('}}'), false, 'H11 不得残留 }}');
  assert.equal(md.includes('dsh-dialog-ledger-v0.4/handover'), true, '生成器默认值与 v0.4 其它产物统一');
});

// ===========================================================================
// 二、附表（HA-01 ~ HA-20）与截断
// ===========================================================================

test('HA-01/02/03/04/05/19：附表文件名、7 键 YAML、父表、H1 与 YAML 名称一致（决定 9 #6）', () => {
  const app = renderApp(baseEvents());
  const md = app.markdown;
  assert.match(H.handoverAppendixName(KEY), APPENDIX_RE, 'HA-01 附表文件名');
  assertAppendixStructure(md);
  const { keys, fields } = splitDoc(md);
  assert.deepEqual(keys, ['名称', '会话标识', '代差', '父表', '上下文条数', '生成器', '生成时间'], 'HA-02 附表 YAML 恰 7 键且顺序固定');
  assert.match(fields['父表'], MAIN_RE, 'HA-03 父表必须匹配主表文件名');
  assert.equal(fields['名称'], `${KEY}的记忆数据库的启用及交接表——附表`, 'HA-04');
  assert.match(fields['生成时间'], DATETIME_RE, 'HA-05');
  assert.equal(md.includes('Z'), false, 'HA-05 全文不得出现 Z 结尾时间');
  // HA-19 + 决定 9 #6：H1 == YAML 名称（v1.2 原缺陷不继承）。
  const body = bodyByAnchor(md);
  assert.equal(body.split('\n')[0], `# ${fields['名称']}`, 'HA-19 H1 必须与 YAML 名称逐字一致');
});

test('HA-06/08/09/10/11：5 类 block、seq 严格升序、编号 1..N 连续、元信息行、逐字照录', () => {
  // 故意打乱输入数组顺序，验证"按 seq 升序、不按 role 分组"。
  const evs = baseEvents();
  const shuffled = [evs[6], evs[1], evs[3], evs[0], evs[5], evs[2], evs[4]];
  const app = renderApp(shuffled);
  const md = app.markdown;
  const { fields } = splitDoc(md);

  // HA-06：5 类 role 集合齐全（本夹具各一条；seq 3 的注入被过滤）。
  assert.deepEqual(blockRoles(md), ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'system/message'],
    'HA-06 必须是 5 类 block，且顺序 = seq 升序');
  assert.equal(new Set(blockRoles(md)).size, 5);

  // HA-08：seq 严格升序、无重复。
  const seqs = seqList(md);
  assert.deepEqual(seqs, [2, 4, 5, 6, 7], 'HA-08 seq 必须严格升序');
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seq 不得回退或重复');

  // HA-09：编号 1..N 连续；N == YAML 上下文条数 == ## 标题数。
  const nums = blockNumbers(md);
  assert.deepEqual(nums, nums.map((_, i) => i + 1), 'HA-09 编号必须 1..N 连续');
  assert.equal(nums.length, Number(fields['上下文条数']), 'HA-09 YAML 上下文条数 == block 数');
  assert.equal(nums.length, blockHeadings(md).length);

  // HA-10：每个 `## ` 标题后紧跟元信息行，再空一行跟内容。
  const lines = md.split('\n');
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^## \d+\. /.test(lines[i])) continue;
    assert.match(lines[i + 1], /^\[seq \d+\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'HA-10 标题后必须紧跟元信息行');
    assert.equal(lines[i + 2], '', 'HA-10 元信息行后必须空一行再跟内容');
    assert.ok(lines[i + 3] && lines[i + 3].length > 0, 'HA-10 块内容不得为空');
    checked++;
  }
  assert.equal(checked, 5);

  // HA-11：逐条照录，不摘要、不省略、不调序。
  for (const text of ['用户原文一', '用户原文二', '助手正文', '思考原文', '工具返回文本', '系统消息原文']) {
    assert.equal(md.includes(text), true, 'HA-11 原文必须逐字出现：' + text);
  }
  const i1 = md.indexOf('用户原文一');
  const i2 = md.indexOf('用户原文二');
  assert.ok(i1 < i2, 'HA-11 同一事件内容块按原顺序');
  assert.equal(md.includes('用户原文一\n\n用户原文二'), true, 'HA-11 内容块之间用一个空行分隔');

  assert.equal(app.count, 5);
  assert.equal(app.total, 5);
  assert.equal(app.truncated, false);
});

test('HA-07：user/message 只收 data.source.kind == "user"，注入类一个都不出现', () => {
  const kinds = ['runtime-context', 'skill-catalog', 'compact-checkpoint', 'model-selection',
    'agent-message', 'subagent-settled', 'user-approval', 'time-context'];
  const events = [{ seq: 1, type: 'user/message', time: T0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真用户输入' }] } }];
  kinds.forEach((kind, i) => {
    events.push({
      seq: i + 2, type: 'user/message', time: T0 + i + 1,
      data: { source: { kind }, content: [{ type: 'text', text: `注入-${kind}-不得出现` }] },
    });
  });
  const app = renderApp(events);
  assert.equal(app.count, 1, 'HA-07 只收 kind=user 的一条');
  for (const kind of kinds) {
    assert.equal(app.markdown.includes(`注入-${kind}-不得出现`), false, `HA-07 ${kind} 不得进附表`);
  }
  assert.equal(app.markdown.includes('真用户输入'), true);
  assert.equal(app.filtered['runtime-context'], 1, '过滤计数供调用方记日志');
});

test('HA-12：thinking 折叠 / tool_use 指针 / 工具参数二次解析 JSON / 工具结果状态', () => {
  const md = renderApp(baseEvents()).markdown;
  // thinking 用 <details> 折叠且保留原文。
  assert.equal(md.includes('<details><summary>thinking</summary>'), true);
  assert.equal(md.includes('思考原文'), true);
  assert.equal(md.includes('</details>'), true);
  // tool_use 只留一行指针，指向对应 tool/call 的 seq。
  assert.equal(md.includes('→ tool/call [seq 5]'), true, 'HA-12 tool_use 指针必须指向 tool/call 的 seq');
  assert.equal(md.includes('tool_use'), false, 'HA-12 不得把 tool_use 原文展开进正文');
  // tool/call：第一行 工具: name，空行，然后两空格缩进的解析后 JSON。
  assert.equal(md.includes('工具: read\n\n{\n  "path": "a.md",\n  "n": 1\n}'), true, 'HA-12 参数必须二次解析为两空格缩进 JSON');
  // tool/result：第一行状态。
  assert.equal(md.includes('状态: ok\n\n工具返回文本'), true, 'HA-12 工具结果首行状态 + 正文');

  // 非 JSON 参数：原文照录并标注。
  const bad = renderApp([
    { seq: 1, type: 'tool/call', time: T0, data: { name: 'write', arguments: 'not-json' } },
  ]).markdown;
  assert.equal(bad.includes('工具: write\n\nnot-json\n\n（arguments 非 JSON，原文照录）'), true);

  // 工具错误：isError 与协议错误位都算 error；无文本给固定占位。
  const err = renderApp([
    { seq: 1, type: 'tool/result', time: T0, data: { message: { isError: true, content: [] } } },
    { seq: 2, type: 'tool/result', time: T0 + 1, data: { error: { code: 'X' } } },
  ]).markdown;
  assert.equal(err.includes('状态: error\n\n（无文本内容）'), true);
});

test('HA-13/A9：空表 —— 上下文条数 0、正文一行「无」、无任何 ## 标题', () => {
  const app = renderApp([]);
  const md = app.markdown;
  const { fields } = splitDoc(md);
  assert.equal(fields['上下文条数'], '0', 'HA-13 YAML 上下文条数必须为 0');
  assert.equal(md.includes('\n无\n'), true, 'HA-13 正文必须含单独一行「无」');
  assert.equal(blockHeadings(md).length, 0, 'HA-13 不得留任何 ## block');
  assert.equal(md.includes('已截断'), false);
  assert.equal(md.trimEnd().endsWith('共 0 条 · 生成器 ' + H.DEFAULT_GENERATOR), true);
  assert.equal(app.count, 0);
  assert.equal(app.total, 0);
});

test('HA-14：默认不截断（1 MB 级 fixture 原样写盘、无「已截断」字样）', () => {
  const big = '甲'.repeat(350000); // ≈1.05 MB UTF-8
  const app = renderApp([
    { seq: 1, type: 'user/message', time: T0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: big }] } },
    { seq: 2, type: 'assistant/message', time: T0 + 1, data: { message: { content: [{ type: 'text', text: '回复' }] } } },
  ]);
  assert.ok(app.bytes > 1024 * 1024);
  assert.equal(app.bytes <= LIMIT, true);
  assert.equal(app.truncated, false);
  assert.equal(app.markdown.includes('（已截断）'), false, 'HA-14 未触发截断时不得出现「（已截断）」');
  assert.equal(app.count, 2);
  assert.equal(app.markdown.includes(big), true, '默认不截断：原文必须完整保留');
});

test('HA-15/A11：>8 MiB 整块截断 —— 固定句逐字、上下文条数=实际收录、块为整块收录', () => {
  const events = [];
  for (let i = 1; i <= 9; i++) {
    events.push({
      seq: i, type: 'user/message', time: T0 + i,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `块${i}:` + 'x'.repeat(1100000) }] },
    });
  }
  const app = renderApp(events);
  const md = app.markdown;
  const { fields } = splitDoc(md);

  assert.equal(app.truncated, true, '>8 MiB 必须触发截断');
  assert.ok(app.bytes <= LIMIT, '截断后成品总字节必须 ≤ 8 MiB');
  assert.equal(md.includes('（已截断）本表之后至插件接管前的内容未纳入本表；插件接管后的每一轮见第 3 级完整原文'), true,
    'A11 固定句必须逐字出现（决定 9 #7 改写文案）');
  assert.equal(app.count < app.total, true, '截断后实际收录条数必须少于应录条数');
  assert.equal(app.count, Number(fields['上下文条数']), 'A11 上下文条数 == 实际收录条数');
  assert.equal(app.count, blockHeadings(md).length, 'A11 上下文条数 == 实际 block 数');
  assert.equal(md.includes(`（应录 ${app.total} 条，实际收录 ${app.count} 条）`), true, '截断行必须写明应录/实际条数');
  // 整块收录：前 count 块原文完整、第 count+1 块一个字都不出现。
  for (let i = 1; i <= app.count; i++) {
    assert.equal(md.includes(`块${i}:`), true, '整块收录：已收录块必须完整');
  }
  assert.equal(md.includes(`块${app.count + 1}:`), false, '整块截断：被省略块不得出现半块内容');
  assert.equal(blockHeadings(md).length, app.count);
});

test('HA-15 特例：单块自身 >8 MiB —— 块内截断到完整 UTF-8 字符边界 + 块尾固定句', () => {
  const app = renderApp([
    { seq: 1, type: 'user/message', time: T0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '超长:' + '甲'.repeat(3 * 1024 * 1024) }] } },
    { seq: 2, type: 'assistant/message', time: T0 + 1, data: { message: { content: [{ type: 'text', text: '后续块' }] } } },
  ]);
  const md = app.markdown;
  assert.equal(app.truncated, true);
  assert.equal(app.singleBlockTruncated, true);
  assert.equal(app.count, 1, '单块超限：该块计入收录，后续块不收录');
  assert.ok(app.bytes <= LIMIT, '成品总字节必须 ≤ 8 MiB');
  assert.equal(md.includes('（已截断）本块超出单文件上限，其余内容未纳入本表；插件接管后的每一轮见第 3 级完整原文'), true,
    '附表单块截断的块尾固定句必须逐字出现');
  assert.equal(md.includes('（已截断）本表之后至插件接管前的内容未纳入本表；插件接管后的每一轮见第 3 级完整原文'), true,
    'A11 >8 MiB 固定句仍必须出现');
  assert.equal(md.includes('后续块'), false);
  // UTF-8 边界：产物必须是合法 UTF-8，且截断处不得留下 U+FFFD 替换符。
  assert.equal(Buffer.from(md, 'utf8').toString('utf8'), md);
  assert.equal(md.includes('\uFFFD'), false);
});

test('HA-16：不得残留 v0.4 痕迹（8000 字截断串 / 旧 ### ISO 标题 / 旧短文件名）', () => {
  const md = renderApp(baseEvents()).markdown;
  assert.equal(md.includes('已截断：本节之后的内容见该会话的完整原文'), false);
  assert.equal(/^### \d{4}-/m.test(md), false);
  assert.equal(md.includes('8000'), false);
  // v0.4 短文件名：`{S}{D}的启用及交接表——附表`（缺「记忆数据库的」）。
  assert.equal(md.includes(`${KEY}的启用及交接表——附表`), false, 'HA-16 不得用 v0.4 短名');
  assert.equal(md.includes(`${KEY}的记忆数据库的启用及交接表——附表`), true);
  // 文件名（带 .md）只出现在「父表」那类字段里是主表的；附表自身名称不带扩展名。
  assert.equal(md.includes(`${KEY}的记忆数据库的启用及交接表——附表.md`), false);
});

test('审计裁定：附表逐字照录内容保留原始 CR（不静默改写）；结构行仍为 LF', () => {
  const md = renderApp([
    {
      seq: 1, type: 'user/message', time: T0,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一段\r\n第二段' }] },
    },
    {
      seq: 2, type: 'assistant/message', time: T0 + 1,
      data: { message: { content: [
        { type: 'text', text: '助手\r\n正文' },
        { type: 'thinking', thinking: '思考\r\n原文' },
      ] } },
    },
    { seq: 3, type: 'tool/result', time: T0 + 2, data: { message: { isError: false, content: [{ type: 'text', text: '结果\r\n文本' }] } } },
    { seq: 4, type: 'system/message', time: T0 + 3, data: { message: { content: [{ type: 'text', text: '系统\r\n消息' }] } } },
    // 非 JSON arguments 的原文也照录，不得归一 CR。
    { seq: 5, type: 'tool/call', time: T0 + 4, data: { name: 'write', arguments: '原样\r\n参数' } },
  ]).markdown;

  // ① 原文 CRLF 原样保留（审计裁定：不改原文字节；不得归一为 LF）。
  for (const s of ['第一段\r\n第二段', '助手\r\n正文', '思考\r\n原文', '结果\r\n文本', '系统\r\n消息', '原样\r\n参数']) {
    assert.equal(md.includes(s), true, '原文必须原样保留（含 CR）：' + JSON.stringify(s));
  }
  assert.equal(md.includes('第一段\n第二段'), false, '不得把 CRLF 归一为 LF');
  // ② 生成结构行仍必须 LF 且无 CR（YAML/标题行/元信息行/固定句/结束行）。
  assertAppendixStructure(md);

  // ③ 既有内容形态不回退：多 text 块空行分隔、图片/文件占位、块尾注。
  const md2 = renderApp([{
    seq: 1, type: 'user/message', time: T0,
    data: {
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '甲' },
        { type: 'text', text: '乙' },
        { type: 'image', attachment: { name: 'x.png' } },
        { type: 'file', name: '报表.csv' },
      ],
    },
  }]).markdown;
  assert.equal(md2.includes('甲\n\n乙'), true);
  assert.equal(md2.includes('[图片]'), true);
  assert.equal(md2.includes('（非文本块，已保留占位）'), true);
  assert.equal(md2.includes('[文件] 报表.csv'), true);
});

test('审计裁定负例：原文含 {{n}}/模板语法/行首 ## → 原文保留；模板生成部分无残留占位符；写盘不改字节', () => {
  const userText = '这些是用户原文：{{n}} / {{session12}}\r\n## 用户自己的二级标题';
  const app = renderApp([{
    seq: 1, type: 'user/message', time: T0,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: userText }] },
  }]);
  const md = app.markdown;
  // ① 原文（含 {{...}}、行首 ##、CR）逐字保留，渲染器不得替原文做占位符替换/改写。
  assert.equal(md.includes(userText), true, '原文必须逐字保留（含 {{n}} 与行首 ##）');
  assert.equal(app.count, 1);

  // ② 模板生成部分不得残留占位符：YAML 前置块。
  const anchor = /^# /m.exec(md).index;
  for (const ph of ['{{session12}}', '{{gen}}', '{{generator}}', '{{datetime}}', '{{count}}',
    '{{n}}', '{{block_role}}', '{{seq}}', '{{time}}', '{{block_content}}', '{{seal_sha256}}']) {
    assert.equal(md.slice(0, anchor).includes(ph), false, 'YAML 生成区不得残留模板占位符：' + ph);
  }
  // ② 模板生成部分不得残留占位符：结构行（标题/元信息/固定说明句/分隔线/结束行）。
  for (const line of md.split('\n')) {
    if (/^## \d+\. /.test(line) || /^\[seq /.test(line) || /^> /.test(line) || line === '---' || /^\*\*结束\*\* /.test(line)) {
      assert.equal(line.includes('{{'), false, '结构行不得残留模板占位符：' + line);
    }
  }

  // ③ 写盘：不做任何改写，回读字节 == 渲染结果；原文伪造的 ## 行不影响结构计数。
  const root = makeRoot('verbatim');
  try {
    const w = H.writeHandover({
      root, sessKey: KEY, mainMarkdown: renderMain().markdown, appendixMarkdown: md,
    });
    assert.equal(fs.readFileSync(w.appendixPath, 'utf8'), md, '附表写盘必须逐字节一致（不改原文）');
  } finally {
    dispose(root);
  }
});

test('HA-12 补充：真实 DSH session 的 reasoning / tool-call 块名同样能被识别（别名兼容）', () => {
  // 本机 session.v4.jsonl 实测 assistant 内容块是 reasoning / tool-call（不是契约用语 thinking / tool_use）。
  const md = renderApp([
    { seq: 1, type: 'assistant/message', time: T0, data: { message: { content: [
      { type: 'reasoning', text: '真实数据里的思考原文' },
      { type: 'tool-call', id: 'call_9', name: 'grep' },
    ] } } },
    { seq: 2, type: 'tool/call', time: T0 + 1, data: { callId: 'call_9', name: 'grep', arguments: '{"q":"x"}' } },
  ]).markdown;
  assert.equal(md.includes('<details><summary>thinking</summary>'), true);
  assert.equal(md.includes('真实数据里的思考原文'), true);
  assert.equal(md.includes('→ tool/call [seq 2]'), true);
});

// ===========================================================================
// 三、封板状态机（HO-21 ~ HO-31 / H13 ~ H16）
// ===========================================================================

test('HO-21/25：空目录 + 无 state → generate/reopened；state 丢失同样 reopened', () => {
  const root = makeRoot('gen');
  try {
    const state = {};
    const d = H.decideHandover({ root, sessKey: KEY, state, nowMs: NOW });
    assert.equal(d.decision, 'generate');
    assert.equal(d.reopened, true, 'HO-21 generate 必须 reopened:true');
    assert.equal(d.logLine.includes('handover=generate reopened=true'), true);
    assert.equal(d.mainExists, false);

    // state 丢失的等价场景：state 空但主表存在 → adopt，同样 reopened:true（HO-25）。
    const old = `---\n名称: "${KEY}的记忆数据库的启用及交接表"\n---\n\n# ${KEY}的记忆数据库的启用及交接表\n\n旧文件正文\n`;
    fs.writeFileSync(path.join(root, H.handoverMainName(KEY)), old, 'utf8');
    const d2 = H.decideHandover({ root, sessKey: KEY, state: {}, nowMs: NOW });
    assert.equal(d2.decision, 'adopt');
    assert.equal(d2.reopened, true, 'HO-25 state 丢失（adopt）必须 reopened:true');
    assert.equal(d2.logLine.includes('reopened=true'), true);
  } finally {
    dispose(root);
  }
});

test('HO-22/H14：已封板再跑 → skip，主表/附表字节 sha256 与 mtime 均不变', () => {
  const root = makeRoot('skip');
  try {
    const state = {};
    const { written } = generateBatch(root, state);
    const before = {
      main: fs.readFileSync(written.mainPath),
      app: fs.readFileSync(written.appendixPath),
      mainMtime: fs.statSync(written.mainPath).mtimeMs,
      appMtime: fs.statSync(written.appendixPath).mtimeMs,
    };
    for (let i = 0; i < 3; i++) {
      const d = H.decideHandover({ root, sessKey: KEY, state, nowMs: NOW + i });
      assert.equal(d.decision, 'skip', 'HO-22 已封板必须 skip');
      assert.equal(d.reopened, false);
      assert.deepEqual(d.warnings, [], '封板与文件一致时不应有告警');
    }
    assert.equal(sha256(fs.readFileSync(written.mainPath)), sha256(before.main), 'HO-14 主表字节不得变');
    assert.equal(sha256(fs.readFileSync(written.appendixPath)), sha256(before.app), 'HO-14 附表字节不得变');
    assert.equal(fs.statSync(written.mainPath).mtimeMs, before.mainMtime, 'HO-22 mtime 也不得变');
    assert.equal(fs.statSync(written.appendixPath).mtimeMs, before.appMtime);
  } finally {
    dispose(root);
  }
});

test('HO-23：封板后手工删主表 → 仍 skip、不重建、warn 含 sealed but file missing', () => {
  const root = makeRoot('skipdel');
  try {
    const state = {};
    const { written } = generateBatch(root, state);
    fs.unlinkSync(written.mainPath);
    const d = H.decideHandover({ root, sessKey: KEY, state, nowMs: NOW });
    assert.equal(d.decision, 'skip', 'HO-23 删了也不重建');
    assert.equal(d.mainExists, false);
    assert.equal(d.warnings.some((w) => w.includes('sealed but file missing')), true, 'HO-23 warn 必须含 sealed but file missing');
    assert.equal(fs.existsSync(written.mainPath), false, 'HO-23 主表不得重新出现');
    assert.equal(fs.existsSync(written.appendixPath), true, '附表保持原样');
  } finally {
    dispose(root);
  }
});

test('HO-24/决定9#2：adopt 只补 state —— 旧文件（无封板两键）字节与 mtime 不动', () => {
  const root = makeRoot('adopt');
  try {
    const mainName = H.handoverMainName(KEY);
    const oldMd = `---\n名称: "${KEY}的记忆数据库的启用及交接表"\n会话标识: "${S12}"\n代差: "${GEN}"\n---\n\n# ${KEY}的记忆数据库的启用及交接表\n\n旧版/手工放入的正文（adopt 不得改写一个字节）\n`;
    fs.writeFileSync(path.join(root, mainName), oldMd, 'utf8');
    const beforeBytes = fs.readFileSync(path.join(root, mainName));
    const beforeMtime = fs.statSync(path.join(root, mainName)).mtimeMs;

    const state = {};
    const d = H.decideHandover({ root, sessKey: KEY, state, nowMs: NOW });
    assert.equal(d.decision, 'adopt');
    assert.equal(d.adopted, true, 'HO-24 adopt 必须成功（旧文件缺 封板/封板hash 两键是允许状态）');
    assert.equal(d.reopened, true);
    assert.equal(d.sealHash, sha256(bodyByAnchor(oldMd)), 'adopt 必须按正文重算 hash');
    assert.equal(d.warnings.some((w) => w.includes('appendix missing')), true, '无附表时只 warn、不补写');

    // 只补 state：调用方 markSealed + writeState，文件一个字节都不动。
    H.markSealed(state, KEY, {
      sealedAt: d.sealedAt, sealHash: d.sealHash, main: d.main, appendix: d.appendix,
      adopted: true, decision: 'adopted',
    });
    L.writeState(root, state);
    assert.equal(sha256(fs.readFileSync(path.join(root, mainName))), sha256(beforeBytes), 'HO-24 文件字节 sha256 必须不变');
    assert.equal(fs.statSync(path.join(root, mainName)).mtimeMs, beforeMtime, 'HO-24 mtime 也不得变');
    assert.equal(fs.existsSync(path.join(root, H.handoverAppendixName(KEY))), false, 'adopt 不得补写附表');
    const persisted = L.readState(root);
    assert.equal(persisted.handoverSealed[KEY].sealHash, d.sealHash);
    assert.equal(persisted.handoverSealed[KEY].adopted, true);
  } finally {
    dispose(root);
  }
});

test('adopt 复核不一致 / 无正文 → 拒绝承认封板（E_HANDOVER_HASH_MISMATCH / E_HANDOVER_BODY_NOT_FOUND）', () => {
  const root = makeRoot('adoptbad');
  try {
    const mainPath = path.join(root, H.handoverMainName(KEY));
    // ① YAML 封板hash 与正文对不上。
    const badHash = `---\n名称: "${KEY}的记忆数据库的启用及交接表"\n封板hash: '${'0'.repeat(64)}'\n---\n\n# ${KEY}的记忆数据库的启用及交接表\n\n正文\n`;
    fs.writeFileSync(mainPath, badHash, 'utf8');
    const before = fs.readFileSync(mainPath);
    const d1 = H.decideHandover({ root, sessKey: KEY, state: {}, nowMs: NOW });
    assert.equal(d1.decision, 'adopt');
    assert.equal(d1.adopted, false, '不一致时不得 adopt');
    assert.equal(d1.error.code, 'E_HANDOVER_HASH_MISMATCH');
    assert.equal(sha256(fs.readFileSync(mainPath)), sha256(before), '拒绝时不得改文件');

    // ② 连 `# ` 正文行都没有 → E_HANDOVER_BODY_NOT_FOUND。
    fs.writeFileSync(mainPath, `---\n名称: "x"\n---\n\n没有井号标题的纯文本\n`, 'utf8');
    const d2 = H.decideHandover({ root, sessKey: KEY, state: {}, nowMs: NOW });
    assert.equal(d2.adopted, false);
    assert.equal(d2.error.code, 'E_HANDOVER_BODY_NOT_FOUND');
  } finally {
    dispose(root);
  }
});

test('HO-26/H15：重建时旧同名文件 rename 为 *.旧-YYYYMMDD-HHMMSS，内容 sha256 不变且不删除', () => {
  const root = makeRoot('archive');
  try {
    const mainName = H.handoverMainName(KEY);
    const appName = H.handoverAppendixName(KEY);
    const oldMain = '# 旧主表\n\n旧内容\n';
    const oldApp = '# 旧附表\n\n旧内容\n';
    // 老库（v0.6.1 及以前）的文件在一级：写端必须先留档、绝不覆盖。
    fs.writeFileSync(path.join(root, mainName), oldMain, 'utf8');
    fs.writeFileSync(path.join(root, appName), oldApp, 'utf8');
    const oldMainHash = sha256(oldMain);
    const oldAppHash = sha256(oldApp);

    const main = renderMain();
    const app = renderApp(baseEvents());
    const w = H.writeHandover({
      root, sessKey: KEY, mainMarkdown: main.markdown, appendixMarkdown: app.markdown,
      sealHash: main.sealHash, nowMs: NOW,
    });
    assert.equal(w.archived.length, 2, '主表与附表都应留档');
    // 留档留在**原位置**（一级），旧文件内容一个字节都没变。
    const rootNames = fs.readdirSync(root).sort();
    for (const rel of [mainName, appName]) {
      const arch = rootNames.find((n) => n.startsWith(rel + '.旧-'));
      assert.ok(arch, 'HO-26 必须出现 {原名}.旧-YYYYMMDD-HHMMSS：' + rel);
      assert.match(arch, /^.*\.旧-\d{8}-\d{6}$/, 'HO-26 留档名格式');
      const oldHash = rel === mainName ? oldMainHash : oldAppHash;
      assert.equal(sha256(fs.readFileSync(path.join(root, arch))), oldHash, 'HO-26 留档内容 sha256 == 旧文件原字节');
    }
    // 一级旧原名不再占位（已留档），新文件按 V0.6.2 只写 `交接表/`。
    assert.equal(rootNames.includes(mainName), false, 'HO-26 旧文件不是删除（已留档），也不得在一级就位');
    const subDir = path.join(root, '交接表');
    assert.deepEqual(fs.readdirSync(subDir).sort(), [appName, mainName].sort(), 'V0.6.2 写端只写 交接表/');
    assert.equal(fs.readFileSync(w.mainPath, 'utf8'), main.markdown, '新主表正常生成（交接表/）');
    assert.equal(fs.readFileSync(w.appendixPath, 'utf8'), app.markdown, '新附表正常生成（交接表/）');
    assert.equal(path.basename(w.mainPath), mainName);
    assert.equal(path.basename(w.appendixPath), appName);
    assert.deepEqual(w.logs.sort(), [
      'handover=archived old=' + mainName,
      'handover=archived old=' + appName,
    ].sort());
  } finally {
    dispose(root);
  }
});

test('HO-27/28：同批不变量（主表存在 ⇒ 附表存在）+ 无 .tmp 残留', () => {
  const root = makeRoot('batch');
  try {
    const state = {};
    const { written } = generateBatch(root, state);
    assert.equal(fs.existsSync(written.mainPath), true);
    assert.equal(fs.existsSync(written.appendixPath), true, 'HO-27 主表存在 ⇒ 附表存在');
    // V0.6.2：写端只写 `交接表/`（.tmp 也只会出现在该目录），一级不得出现产物。
    assert.equal(path.dirname(written.mainPath), path.join(root, '交接表'));
    assert.deepEqual(fs.readdirSync(root).filter((n) => MAIN_RE.test(n) || APPENDIX_RE.test(n)), []);
    const leftovers = fs.readdirSync(root).concat(fs.readdirSync(path.join(root, '交接表')))
      .filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'HO-28 运行结束不得残留 *.tmp');
    // 失败路径同样不得留 tmp / 半成品。
    const badRoot = makeRoot('batchfail');
    try {
      const main = renderMain();
      const corrupt = main.markdown.replace('## 声明', '##  声明');
      assert.throws(
        () => H.writeHandover({ root: badRoot, sessKey: KEY, mainMarkdown: corrupt, appendixMarkdown: renderApp([]).markdown }),
        (e) => e.code === 'E_HANDOVER_HASH_MISMATCH'
      );
      assert.deepEqual(fs.readdirSync(badRoot).filter((n) => n.endsWith('.tmp')), []);
      assert.deepEqual(fs.readdirSync(badRoot), [], '失败时整批放弃，不落半成品');
    } finally {
      dispose(badRoot);
    }
  } finally {
    dispose(root);
  }
});

test('HO-19：写前/写后 hash 复核 —— 故障注入改一字节 → E_HANDOVER_HASH_MISMATCH、不承认封板', () => {
  const root = makeRoot('inject');
  try {
    const main = renderMain();
    const app = renderApp(baseEvents());
    // ① 渲染后正文被改一字节（模拟渲染/拼装 bug 或内存污染）。
    const corrupt = main.markdown.replace('\n## 声明\n', '\n##  声明\n');
    assert.notEqual(corrupt, main.markdown);
    assert.throws(
      () => H.writeHandover({ root, sessKey: KEY, mainMarkdown: corrupt, appendixMarkdown: app.markdown }),
      (e) => e.code === 'E_HANDOVER_HASH_MISMATCH',
      'HO-19 写后/写前复核不一致必须报 E_HANDOVER_HASH_MISMATCH'
    );
    assert.deepEqual(fs.readdirSync(root), [], '不承认封板：不得留文件');

    // ② 渲染器给的 sealHash 与正文重算不一致。
    assert.throws(
      () => H.writeHandover({
        root, sessKey: KEY, mainMarkdown: main.markdown, appendixMarkdown: app.markdown,
        sealHash: 'f'.repeat(64),
      }),
      (e) => e.code === 'E_HANDOVER_HASH_MISMATCH'
    );
    assert.deepEqual(fs.readdirSync(root), []);

    // ③ 没有 `# ` 正文行 → E_HANDOVER_BODY_NOT_FOUND。
    assert.throws(
      () => H.writeHandover({
        root, sessKey: KEY,
        mainMarkdown: '---\n名称: "x"\n---\n\n只有 YAML 没有正文\n',
        appendixMarkdown: app.markdown,
      }),
      (e) => e.code === 'E_HANDOVER_BODY_NOT_FOUND'
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    dispose(root);
  }
});

test('HO-29/H16：state 封板记录结构（sealedAt/sealHash/main/appendix + 与产物一致）', () => {
  const root = makeRoot('state');
  try {
    const state = {};
    const { written } = generateBatch(root, state);
    const persisted = L.readState(root);
    assert.ok(persisted.handoverSealed, 'HO-29 state 必须有 handoverSealed');
    const rec = persisted.handoverSealed[KEY];
    assert.ok(rec, 'HO-29 键必须是 {S}{D}');
    assert.match(rec.sealedAt, DATETIME_RE, 'HO-29 sealedAt 格式');
    assert.match(rec.sealHash, /^[0-9a-f]{64}$/);
    assert.equal(rec.main, H.handoverMainName(KEY));
    assert.equal(rec.appendix, H.handoverAppendixName(KEY));
    // H16：state.sealHash == 产物 YAML 封板hash。
    const { fields } = splitDoc(fs.readFileSync(written.mainPath, 'utf8'));
    assert.equal(rec.sealHash, fields['封板hash'], 'H16 state 与文件头封板 hash 必须一致');
    assert.equal(rec.sealedAt, fields['生成时间'], 'state 封板时间与产物生成时间同源');
    assert.equal(rec.decision, 'generated');
    assert.equal(rec.reopened, true);
  } finally {
    dispose(root);
  }
});

test('HO-31：同一会话重复触发 N 次 → 目录里始终只有 1 个主表 + 1 个附表', () => {
  const root = makeRoot('once');
  try {
    const state = {};
    generateBatch(root, state);
    for (let i = 0; i < 5; i++) {
      const d = H.decideHandover({ root, sessKey: KEY, state, nowMs: NOW + i * 1000 });
      assert.equal(d.decision, 'skip');
    }
    // V0.6.2：产物在 `交接表/`；"只有 1 个"按双路径合计断言（老库一级 + 新目录都算）。
    const names = fs.readdirSync(root).concat(fs.readdirSync(path.join(root, '交接表')));
    const mains = names.filter((n) => MAIN_RE.test(n));
    const apps = names.filter((n) => APPENDIX_RE.test(n));
    assert.equal(mains.length, 1, 'HO-31 始终只有 1 个主表');
    assert.equal(apps.length, 1, 'HO-31 始终只有 1 个附表');
    assert.equal(fs.existsSync(path.join(root, '交接表', H.handoverMainName(KEY))), true, 'HO-31 主表在 交接表/');
    assert.equal(fs.existsSync(path.join(root, '交接表', H.handoverAppendixName(KEY))), true, 'HO-31 附表在 交接表/');
  } finally {
    dispose(root);
  }
});

test('HO-29 补充：封板双记不一致 → skip + warn handover: seal mismatch（以 state 为准）', () => {
  const root = makeRoot('mismatch');
  try {
    const state = {};
    const { written } = generateBatch(root, state);
    const beforeBytes = fs.readFileSync(written.mainPath);
    // 手工把 state 里的 sealHash 改成另一个合法 hex（模拟搬动/篡改）。
    state.handoverSealed[KEY].sealHash = 'a'.repeat(64);
    const d = H.decideHandover({ root, sessKey: KEY, state, nowMs: NOW });
    assert.equal(d.decision, 'skip');
    assert.equal(d.warnings.includes('handover: seal mismatch'), true, '3.3 补充规则 1：不一致必须 warn');
    assert.equal(sha256(fs.readFileSync(written.mainPath)), sha256(beforeBytes), '以 state 为准，不得改文件');
  } finally {
    dispose(root);
  }
});

// ===========================================================================
// 三·五、V0.6.2 布局（机主已签《v0.6.2-迁移规格-v1》§2.2）
// ===========================================================================

test('V0.6.2 布局：写端只写 交接表/；老库一级文件可读；同名以新目录优先', () => {
  const root = makeRoot('layout');
  try {
    // ① 写端：generate 后产物只在 `交接表/`，一级不得出现成品。
    const state = {};
    const { written, main } = generateBatch(root, state);
    assert.equal(path.dirname(written.mainPath), path.join(root, '交接表'), '主表写在 交接表/');
    assert.equal(path.dirname(written.appendixPath), path.join(root, '交接表'), '附表写在 交接表/');
    assert.deepEqual(fs.readdirSync(path.join(root, '交接表')).sort(),
      [H.handoverAppendixName(KEY), H.handoverMainName(KEY)].sort());
    assert.equal(fs.existsSync(path.join(root, H.handoverMainName(KEY))), false, '一级不得写交接表');
    assert.equal(fs.existsSync(path.join(root, H.handoverAppendixName(KEY))), false, '一级不得写附表');

    // ② 老库（未迁移）：把两份文件挪回一级 → state 清空后必须能 adopt（读双路径兜底）。
    const mainName = H.handoverMainName(KEY);
    const appName = H.handoverAppendixName(KEY);
    fs.renameSync(written.mainPath, path.join(root, mainName));
    fs.renameSync(written.appendixPath, path.join(root, appName));
    fs.rmdirSync(path.join(root, '交接表'));
    const d1 = H.decideHandover({ root, sessKey: KEY, state: {}, nowMs: NOW });
    assert.equal(d1.decision, 'adopt', '老库一级交接表必须可读（不先迁移也能用）');
    assert.equal(d1.adopted, true);
    assert.equal(d1.mainExists, true);
    assert.equal(d1.appendixExists, true);

    // ③ 同名两处都有 → 新目录优先：新目录放合法主表、一级放"封板hash 不符"的坏同名文件；
    //    读端若错读一级会得到 E_HANDOVER_HASH_MISMATCH，读到新目录才会 adopt 成功。
    fs.mkdirSync(path.join(root, '交接表'), { recursive: true });
    fs.writeFileSync(path.join(root, '交接表', mainName), main.markdown, 'utf8');
    const badRoot = main.markdown.replace(/^封板hash: '[0-9a-f]{64}'$/m, `封板hash: '${'0'.repeat(64)}'`);
    assert.notEqual(badRoot, main.markdown);
    fs.writeFileSync(path.join(root, mainName), badRoot, 'utf8');
    const d2 = H.decideHandover({ root, sessKey: KEY, state: {}, nowMs: NOW });
    assert.equal(d2.decision, 'adopt');
    assert.equal(d2.adopted, true, '同名以 交接表/ 优先（不得读一级坏同名文件）');
    assert.equal(d2.sealHash, H.handoverBodyHash(main.markdown));
  } finally {
    dispose(root);
  }
});

// ===========================================================================
// 四、集成辅助与边界
// ===========================================================================

test('selectHandoverContextEvents：取到"第一条入账轮次的 turn/start 之前"', () => {
  const events = [
    { seq: 1, type: 'system/message', time: T0, data: { message: { content: [{ type: 'text', text: '启动' }] } } },
    { seq: 2, type: 'user/message', time: T0 + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第1轮用户' }] } },
    { seq: 3, type: 'turn/start', time: T0 + 2, data: { turn: 1 } },
    { seq: 4, type: 'user/message', time: T0 + 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第2轮用户' }] } },
    { seq: 5, type: 'turn/start', time: T0 + 4, data: { turn: 2 } },
  ];
  const picked = H.selectHandoverContextEvents(events, 2);
  assert.deepEqual(picked.map((e) => e.seq), [1, 2, 3, 4], '不得含第 2 轮的 turn/start 及其后事件');
  assert.equal(picked.some((e) => e.type === 'turn/start' && e.data.turn === 2), false);
  // 找不到该轮时退化为全部，不静默丢弃。
  assert.equal(H.selectHandoverContextEvents(events, 99).length, 5);
});

test('参数校验：非法 sessKey/generator/时间/events 必须早失败（E_HANDOVER_BAD_ARGS）', () => {
  assert.throws(() => H.renderHandoverMain({ sessKey: 'shortA', nowMs: NOW }), (e) => e.code === 'E_HANDOVER_BAD_ARGS');
  assert.throws(() => H.renderHandoverMain({ sessKey: 'aaaaaaaaaaaaAB' }), (e) => e.code === 'E_HANDOVER_BAD_ARGS');
  assert.throws(() => H.renderHandoverMain({ sessKey: KEY, generator: 'x{{y}}' }), (e) => e.code === 'E_HANDOVER_BAD_ARGS');
  assert.throws(() => H.renderHandoverMain({ sessKey: KEY, generatedAt: '2026/11/09 13:00:00' }), (e) => e.code === 'E_HANDOVER_BAD_ARGS');
  assert.throws(() => H.markSealed({}, KEY, { sealedAt: 'bad', sealHash: 'a'.repeat(64) }), (e) => e.code === 'E_HANDOVER_BAD_ARGS');
  // 空上下文必须显式传 []：漏传 events 不得静默写成「无」（否则就是假的空表）。
  assert.throws(() => H.renderHandoverAppendix({ sessKey: KEY, nowMs: NOW }), (e) => e.code === 'E_HANDOVER_BAD_ARGS');
  assert.equal(H.renderHandoverAppendix({ sessKey: KEY, nowMs: NOW, events: [] }).count, 0);
});

test('truncateUtf8：只保留完整 UTF-8 字符边界', () => {
  const s = 'a' + '汉'.repeat(10); // 1 + 30 字节
  assert.equal(H.truncateUtf8(s, 31), s);
  assert.equal(H.truncateUtf8(s, 4), 'a汉'); // 1 + 3
  assert.equal(H.truncateUtf8(s, 3), 'a', '不得切出半个汉字');
  assert.equal(Buffer.from(H.truncateUtf8(s, 3), 'utf8').toString('utf8'), H.truncateUtf8(s, 3));
});
