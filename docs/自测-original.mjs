/**
 * @file 自测-original.mjs
 * @role 初始凭证的验收：渲染结构、hash 可复核、落盘位置、与记账凭证的强绑定；
 *       v0.5 追加：P0-5 不静默截断（D11 附件/披露行/逐字恢复）、P1-1 完整文件哈希 + verifyOriginal。
 * @why 凭证是"能证明账"的东西。它错一次，后面所有"可审计"都是空话。
 *      2026-11-09 v1.3：与周记账的强绑定落在十列表 **B 列「原始凭证」**（四态枚举），
 *      不再是 v0.4 的「原文」路径列；本文件末尾用例已按 v1.3 迁移。
 *      v0.5 P0-5/P1-1：审计 A-05 "4517 字静默截断" 与 P1-1 "只比正文 hash" 各有用例守着。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { renderOriginal, writeOriginal, originalRelPath, originalFullHash, verifyOriginal, originalFrontMatter } = await import(pathToFileURL(path.join(SRC, 'lib', 'original.js')).href);
const { groupRecords, buildSheets, resolveDoc, readCleanedCodesCompat } = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);

const CODE = '20261108-75238718e41a-A-00000001';
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const KEY = '75238718e41aA';
const T0 = Date.parse('2026-11-08T10:00:00+08:00');

const events = [
  { seq: 1, type: 'turn/start', time: T0, data: { turn: 1 } },
  { seq: 2, type: 'user/message', time: T0 + 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请帮我画一张流程图' }] } },
  { seq: 3, type: 'user/message', time: T0 + 1100, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入内容' }] } },
  { seq: 4, type: 'assistant/message', time: T0 + 2000, data: { message: { content: [{ type: 'text', text: '好的，我先看结构。' }, { type: 'thinking', thinking: '需要先读文件' }, { type: 'tool_use', name: 'read' }] } } },
  { seq: 5, type: 'tool/call', time: T0 + 2100, data: { name: 'read', arguments: '{"path":"a.md"}' } },
  { seq: 6, type: 'tool/result', time: T0 + 2200, sourceEventSeqs: [5], data: { message: { isError: false, content: [{ type: 'text', text: '文件内容……' }] } } },
  { seq: 7, type: 'step/start', time: T0 + 2300, data: { turn: 1, step: 1 } },
  { seq: 8, type: 'turn/end', time: T0 + 3000, data: { turn: 1, reason: { kind: 'completed' } } },
];

const turn = { turn: 1, startMs: T0, endMs: T0 + 3000, reason: 'completed' };

function render() {
  return renderOriginal({ events, turn, code: CODE, sid: SID, sessKey: KEY, seq: 1, offsetMinutes: 480 });
}

/** 换一个编码渲染同一轮（夹具要造"补记"凭证时用，保证 YAML 身份与文件名一致）。 */
function renderWith(code) {
  return renderOriginal({ events, turn, code, sid: SID, sessKey: KEY, seq: Number(String(code).slice(-1)), offsetMinutes: 480 });
}

test('renderOriginal：五节齐全，注入内容被过滤并记入备注', () => {
  const { markdown } = render();
  for (const h of ['## 1. user/message', '## 2. assistant/message', '## 3. tool/call + tool/result', '## 4. step/start + step/end', '## 5. 备注']) {
    assert.equal(markdown.includes(h), true, '缺节: ' + h);
  }
  assert.match(markdown, /请帮我画一张流程图/);
  assert.equal(markdown.includes('注入内容'), false, '注入内容不得进正文');
  assert.match(markdown, /runtime-context ×1/);
  assert.match(markdown, /<details><summary>思考<\/summary>/);
});

test('renderOriginal：前置块含编码/会话/时间/hash，且 hash 覆盖正文', () => {
  const { markdown, bodyHash } = render();
  assert.match(markdown, new RegExp(`编码: '${CODE}'`));
  assert.match(markdown, /对话开始: '2026-11-08T10:00:00\+08:00'/);
  assert.match(markdown, /对话结束: '2026-11-08T10:00:03\+08:00'/);
  assert.equal(bodyHash.length, 64);
  // 重算：从**行首** "## 1." 到文件末尾。
  // ★ 不能用裸子串：YAML 的「正文hash算法」值里也含 '## 1.'（`sha256（对『## 1.』…）`），
  //   按裸 indexOf 会从 YAML 行内开始切片 → 复算必然不一致。
  const idx = markdown.indexOf('\n## 1.');
  const start = idx === -1 ? 0 : idx + 1;
  const recomputed = crypto.createHash('sha256').update(markdown.slice(start), 'utf8').digest('hex');
  assert.equal(recomputed, bodyHash, '正文 hash 必须可复核');
});

test('renderOriginal：YAML 19 键（顺序）/ 会话短ID 12 位 + 代次 / 正文hash算法 / 未启用标记 / 被遮蔽真算 / 非文本占位（OR-03/05/07/12/17/26）', () => {
  const T = Date.parse('2026-11-08T10:00:00+08:00');
  const events = [
    { type: 'turn/start', seq: 1, time: T, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T + 10, data: { source: { kind: 'user' }, content: [
      { type: 'text', text: '原话' }, { type: 'image', attachment: {} }, { type: 'file', attachment: { name: 'a.pdf' } },
    ] } },
    { type: 'assistant/message', seq: 3, time: T + 20, data: { message: { role: 'assistant', content: [{ type: 'text', text: '答' }, { type: 'image' }] } } },
    { type: 'compaction/summary', seq: 4, time: T + 30, data: { shadowedSeqs: [2, 3], shadowedRange: { start: 2, end: 3 } } },
    { type: 'turn/end', seq: 5, time: T + 40, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const r = renderOriginal({
    events, turn: { turn: 1, startMs: T, endMs: T + 40, reason: 'completed' },
    code: CODE, sid: SID, sessKey: 'aaaaaaaaaaaaA', seq: 1, offsetMinutes: 480,
  });
  const lines = r.markdown.split('\n');
  const yamlEnd = lines.indexOf('---', 1);
  // ★ C11：前置块第 2 行是「视图非全集 + 省略条数」声明（`#` 开头的 YAML 注释，不是键）→
  //   取键序前先剔除注释行；19 键契约（OR-03）本身不变。
  const keys = lines.slice(1, yamlEnd).filter((l) => !l.trimStart().startsWith('#')).map((l) => l.split(':')[0]);
  assert.deepEqual(keys, ['编码', '名称', '会话ID', '会话短ID', '代次', '本轮序号', '对话开始', '对话结束',
    '结束原因', '委托人', '执行', '记录', '生成器', '事件范围', '被遮蔽事件数', '正文hash', '正文hash算法', '文件数', '文件']);
  assert.match(r.markdown, /会话短ID: 'aaaaaaaaaaaa'/);
  assert.match(r.markdown, /代次: 'A'/);
  assert.match(r.markdown, /正文hash算法: 'sha256（对『## 1.』至文件末尾的全部字节计算）'/);
  assert.equal(r.shadowed, 2, '被遮蔽事件数必须真算（|E ∩ shadowed|）');
  assert.match(r.markdown, /被遮蔽事件数: 2/);
  const noteStart = r.markdown.indexOf('## 5. 备注');
  assert.ok(noteStart > 0);
  assert.ok(r.markdown.slice(noteStart + '## 5. 备注'.length).trimStart().startsWith('- 文件清单：未启用（真实采集排 v0.5）'));
  assert.ok(r.markdown.includes('[图片]'), 'image 块必须有占位');
  assert.ok(r.markdown.includes('[文件] a.pdf'), 'file 块必须有占位');
});

// ============================================================================
// 十·一、C11（v0.9.1）：视图 md 头必须写"视图非全集"＋省略条数
//
// 判据原文：`打开任意 md 看头三行` → 头三行必须明确出现「视图非全集」与「省略 N 条」，
// 且 N 与 YAML 的 `被遮蔽事件数` 同口径（无遮蔽写「省略 0 条」，不许模糊措辞）。
// 守：审计怕的是"把视图当全集"——视图确实可能被显式截断/被压缩遮蔽，头里必须自己说清。
// ============================================================================
test('C11：md 头三行写「视图非全集」+ 省略 N 条，且 N == YAML 被遮蔽事件数', () => {
  const T = Date.parse('2026-11-08T10:00:00+08:00');
  // 造一份"有遮蔽"的渲染（|E ∩ shadowed| = 1）：证明条数是真算的，不是写死 0。
  const shadowEvents = [
    { type: 'turn/start', seq: 1, time: T, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T + 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '原话' }] } },
    { type: 'compaction/summary', seq: 3, time: T + 20, data: { shadowedSeqs: [2], shadowedRange: { start: 2, end: 2 } } },
    { type: 'turn/end', seq: 4, time: T + 30, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const cases = [
    { label: '无遮蔽（省略 0 条）', r: render() },
    {
      label: '有遮蔽（省略 1 条）',
      r: renderOriginal({
        events: shadowEvents, turn: { turn: 1, startMs: T, endMs: T + 30, reason: 'completed' },
        code: CODE, sid: SID, sessKey: KEY, seq: 1, offsetMinutes: 480,
      }),
    },
  ];
  for (const { label, r } of cases) {
    // 头三行 = 文件最上面三行（YAML 第 1 行 `---` + 第 2 行视图声明 + 第 3 行 `编码`）
    const head3 = r.markdown.split('\n').slice(0, 3).join('\n');
    assert.match(head3, /视图非全集/, `${label}：md 头三行没写「视图非全集」：${JSON.stringify(head3)}`);
    const m = /省略\s*(\d+)\s*条/.exec(head3);
    assert.ok(m, `${label}：md 头三行没写「省略 N 条」：${JSON.stringify(head3)}`);
    // 口径必须与 YAML「被遮蔽事件数」一致（不许是另一个数）
    const fm = originalFrontMatter(r.markdown);
    assert.ok(fm, `${label}：前置块必须可解析`);
    assert.equal(Number(m[1]), Number(fm.fields['被遮蔽事件数']),
      `${label}：省略条数必须 == YAML 被遮蔽事件数（实际 ${m[1]} vs ${fm.fields['被遮蔽事件数']}）`);
    assert.equal(Number(m[1]), r.shadowed, `${label}：省略条数必须 == 渲染器算出的 shadowed`);
    // 既有声明不得删（C11："补"不是"换"）
    assert.match(r.markdown, /可能被\*\*显式截断\*\*/, `${label}：既有「可能被显式截断」声明不得删`);
    assert.match(r.markdown, /逐字原文见同目录事件附件/, `${label}：既有附件声明不得删`);
  }
  // 无遮蔽必须是明确的「省略 0 条」
  assert.match(cases[0].r.markdown.split('\n').slice(0, 3).join('\n'), /省略\s*0\s*条/);
  // 有遮蔽时条数必须是真算出来的 1（不是 0）
  assert.match(cases[1].r.markdown.split('\n').slice(0, 3).join('\n'), /省略\s*1\s*条/);
});


test('writeOriginal：落在第 3 级目录，文件名 = 编码 + 完整原文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
  const { markdown } = render();
  const r = writeOriginal({ root: dir, y: 2026, m: 11, code: CODE, markdown });
  assert.equal(r.rel, originalRelPath(2026, 11, CODE));
  assert.equal(r.rel, path.join('2026年11月', '11月总“完整原文”', `${CODE} 完整原文.md`));
  assert.equal(fs.existsSync(r.path), true);
  assert.match(fs.readFileSync(r.path, 'utf8'), /完整原文/);
  assert.equal(fs.existsSync(r.path + '.tmp'), false);
});

test('readTurnEventsBatch：一次扫描只取需要的轮次（O(n)，不逐轮重读）', async () => {
  const fs2 = fs;
  const zlib = await import('node:zlib');
  const { readTurnEventsBatch } = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  const lines = [JSON.stringify({ type: 'session', id: SID, createdAt: T0 })];
  for (let n = 1; n <= 3; n++) {
    lines.push(JSON.stringify({ type: 'turn/start', time: T0 + n * 10000, data: { turn: n } }));
    lines.push(JSON.stringify({ type: 'assistant/message', time: T0 + n * 10000 + 100, data: { message: { content: [{ type: 'text', text: `第${n}轮内容` }] } } }));
    lines.push(JSON.stringify({ type: 'turn/end', time: T0 + n * 10000 + 200, data: { turn: n, reason: { kind: 'completed' } } }));
  }
  fs2.writeFileSync(file, frame(lines));

  const map = readTurnEventsBatch(file, new Set([1, 3]));
  assert.equal(map.size, 2);
  assert.equal(map.has(2), false);
  const t1 = map.get(1);
  assert.equal(t1[0].type, 'turn/start');
  assert.equal(t1[t1.length - 1].type, 'turn/end');
  assert.match(JSON.stringify(t1), /第1轮内容/);
  assert.equal(JSON.stringify(t1).includes('第2轮内容'), false, '不得串入其它轮次');
});

test('强绑定：原始凭证四态落在 B 列（绑定 / 补记 / 已清理(RPT-…) / 缺凭证）', () => {
  // 守：口径 1 四态（WK-17/WK-18）——v1.3 四态在十列表第 2 列「原始凭证」；
  //     原文被清理时行不消失（只把 B 列标「已清理(RPT-…)」）；有凭证时仍能解析出原文相对路径。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-'));
  // ★ v0.5 CH-01：`绑定` 要求 docSha256 + docFileSha256 + attachment 三样齐全且可复算。
  //   旧夹具只给 `doc` 指针，`resolveDoc` 只能判 LEGACY_NO_ATTACHMENT（缺凭证）——
  //   断言 'bound' 与契约冲突，红的是夹具，不是实现。
  const r0 = render();
  const boundDoc = writeOriginal({
    root: dir, y: 2026, m: 11, code: CODE,
    markdown: r0.markdown, bodyHash: r0.bodyHash, fullHash: r0.fullHash, attachment: r0.attachment,
  });
  const bindEvidence = {
    docSha256: boundDoc.bodyHash,
    docFileSha256: boundDoc.fullHash,
    ...(boundDoc.attachment
      ? { attachment: { name: boundDoc.attachment.name, sha256: boundDoc.attachment.sha256, bytes: boundDoc.attachment.bytes } }
      : {}),
  };
  const backfilledCode = '20261108-75238718e41a-A-00000004';
  const rBack = renderWith(backfilledCode);
  writeOriginal({
    root: dir, y: 2026, m: 11, code: backfilledCode,
    markdown: rBack.markdown, bodyHash: rBack.bodyHash, fullHash: rBack.fullHash, attachment: rBack.attachment,
  });
  // 2) 清册：新格式（v1.3）与旧格式（v0.4）各一条 → 00000002 / 00000005 已清理
  fs.writeFileSync(path.join(dir, 'RPT-20261108-01.md'),
    '| n | 编码 | 产生时间 | 结论 | 备注 |\n|---|---|---|---|---|\n' +
    '| 1 | 20261108-75238718e41a-A-00000002 | 2026-11-09 12:00:00 | 已删除 |  |\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'RPT-20261108-02.md'),
    '| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |\n|---|---|---|---:|---|---|\n' +
    `| \`20261108-75238718e41a-A-00000005\` | ${KEY} | 2026-11 | 1.0 KB | 已删除 |  |\n`, 'utf8');

  const recs = [
    { v: 3, code: CODE, ts: '2026-11-08T10:00:00+08:00', sid: SID, turn: 1, seq: 1, status: 'ok', doc: boundDoc.rel, ...bindEvidence },
    { v: 3, code: '20261108-75238718e41a-A-00000002', ts: '2026-11-08T10:05:00+08:00', sid: SID, turn: 2, seq: 2, status: 'ok' },
    { v: 3, code: '20261108-75238718e41a-A-00000003', ts: '2026-11-08T10:06:00+08:00', sid: SID, turn: 3, seq: 3, status: 'ok' },
    { v: 3, code: backfilledCode, ts: '2026-11-08T10:07:00+08:00', sid: SID, turn: 4, seq: 4, status: 'ok' },
    { v: 3, code: '20261108-75238718e41a-A-00000005', ts: '2026-11-08T10:08:00+08:00', sid: SID, turn: 5, seq: 5, status: 'ok' },
  ];
  const cleaned = readCleanedCodesCompat(dir);
  assert.equal(cleaned.get('20261108-75238718e41a-A-00000002'), 'RPT-20261108-01');
  assert.equal(cleaned.get('20261108-75238718e41a-A-00000005'), 'RPT-20261108-02', 'v0.4 旧格式清册必须兼容');

  // "有凭证"仍能解析出第 3 级原文相对路径（强绑定的本意）
  const docInfo = resolveDoc(dir, recs[0], 480, cleaned);
  assert.equal(docInfo.state, 'bound');
  assert.equal(docInfo.rel, boundDoc.rel);
  assert.match(docInfo.rel, /完整原文\.md$/);

  const g = [...groupRecords(recs, 480).values()][0];
  const sheets = buildSheets({ root: dir, w: g.w, sessKey: KEY, records: recs, offsetMinutes: 480, generatedAt: '2026-11-09 12:00:00' });
  const day = sheets.find((s) => s.name === '周日') || sheets.find((s) => s.name === '周三');
  assert.equal(day.rows[0][1], '原始凭证', '十列第 2 列应是「原始凭证」');

  const row = (code) => day.rows.find((r) => r[0] === code);
  assert.equal(row(CODE)[1], '绑定');
  assert.equal(row(backfilledCode)[1], '补记');
  assert.equal(row('20261108-75238718e41a-A-00000002')[1], '已清理(RPT-20261108-01)');
  assert.equal(row('20261108-75238718e41a-A-00000003')[1], '缺凭证');
  assert.equal(row('20261108-75238718e41a-A-00000005')[1], '已清理(RPT-20261108-02)');
  // 原文被清理/缺失时行不消失：5 条记录必须都还在
  assert.equal(day.rows.filter((r) => Array.isArray(r) && /^\d{8}-/.test(String(r[0] || ''))).length, 5);
  // B 列全部匹配契约枚举（ASCII 半角括号）
  for (const r of day.rows.filter((x) => Array.isArray(x) && /^\d{8}-/.test(String(x[0] || '')))) {
    assert.match(r[1], /^(绑定|补记|缺凭证|已清理\(RPT-\d{8}-\d{2}\))$/);
  }
});

// ============================================================================
// 六·五、P1-12 / INV-24：跨月会话的凭证路径必须按**编码日期段**取月（审计 #6）
// ============================================================================

test('INV-24：跨月会话（1/31 开始、2/1 那轮）必须绑定到 01 月的凭证，不得按 ts 取月', () => {
  // 2026-11-09 审计 #6 复现：写端按编码日期段落 `2026年01月`，
  // 读端若按轮次发生时刻 ts（2026-02-01）复算就是 `2026年02月` → 永久 PATH_MISMATCH / 缺凭证。
  // 凭证不可变、没有修复路径，所以这条必须钉死。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossmonth-'));
  const code = '20260131-aaaaaaaaaaaa-A-00000002';
  const r = renderWith(code);
  const doc = writeOriginal({
    root: dir, y: 2026, m: 1, code,
    markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment,
  });
  assert.match(doc.rel, /2026年01月/, '前提：写端必须落在 01 月');

  const rec = {
    v: 3, code, ts: '2026-02-01T00:01:00+08:00', sid: SID, turn: 2, seq: 2, status: 'ok',
    doc: doc.rel, docSha256: doc.bodyHash, docFileSha256: doc.fullHash,
    ...(doc.attachment
      ? { attachment: { name: doc.attachment.name, sha256: doc.attachment.sha256, bytes: doc.attachment.bytes } }
      : {}),
  };
  const st = resolveDoc(dir, rec, 480, null);
  assert.equal(
    st.state, 'bound',
    `跨月轮次必须能绑定（实际 state=${st.state} problems=${JSON.stringify(st.problems)}）——读端按 ts 取月了`
  );
  assert.equal(st.rel, doc.rel);
});

// ============================================================================
// 八、v0.5 P0-5：工具参数/结果不得静默截断（D11：披露行 + 原始事件附件可逐字恢复）
// ============================================================================

/** 造"一个超长工具参数"的事件组（turn/start + tool/call + tool/result + turn/end）。 */
function longArgEvents(argText) {
  return [
    { seq: 1, type: 'turn/start', time: T0, data: { turn: 1 } },
    { seq: 2, type: 'tool/call', time: T0 + 100, data: { callId: 'c1', name: 'pwsh', arguments: argText } },
    { seq: 3, type: 'tool/result', time: T0 + 150, sourceEventSeqs: [2], data: { message: { isError: false, content: [{ type: 'text', text: 'OK' }] } } },
    { seq: 4, type: 'turn/end', time: T0 + 200, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}
const turnOf = () => ({ turn: 1, startMs: T0, endMs: T0 + 200, reason: 'completed' });
function renderWithArg(code, argText) {
  return renderOriginal({ events: longArgEvents(argText), turn: turnOf(), code, sid: SID, sessKey: KEY, seq: 1, offsetMinutes: 480 });
}
const sha256Of = (v) => crypto.createHash('sha256').update(v).digest('hex');

// 守：审计 A-05 实测"4517 字工具参数尾部静默丢失、无披露"。现在：
//   ≤2000 码点原样展示；>2000 展示前 2000 + **紧接** D11 披露行；全量在同目录附件里逐字可恢复。
test('P0-5/D11：≤2000 码点不截断；2001/4517 截断必须有披露行，且附件可逐字恢复', () => {
  for (const N of [2000, 2001, 4517]) {
    const code = '20261109-75238718e41a-A-' + String(N).padStart(8, '0');
    // 块的**码点**长度恰好 N，最后一个字符是 Z（证明尾部也进了附件）
    const arg = 'X'.repeat(N - 1) + 'Z';
    const r = renderWithArg(code, arg);
    const md = r.markdown;
    if (N <= 2000) {
      assert.equal(md.includes(arg), true, `${N} 码点未超限，必须原样展示`);
      assert.equal(/^> \[截断\]/m.test(md), false);
      continue;
    }
    assert.equal(md.includes(arg), false, `${N} 码点必须截断展示（不再静默写全导致膨胀）`);
    const m = /^> \[截断\] 原始长度=(\d+)字符 附件=(.+?) sha256=([0-9a-f]{64})$/m.exec(md);
    assert.ok(m, `${N} 码点缺少 D11 披露行：${md.slice(0, 200)}`);
    assert.equal(Number(m[1]), N, '披露的原始长度必须是码点数');
    assert.equal(m[2], `${code} 原始事件.json`);
    assert.equal(m[3], r.attachment.sha256, '披露的 sha256 必须是附件 sha256');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-'));
    const doc = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: md, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
    const attPath = path.join(path.dirname(doc.path), `${code} 原始事件.json`);
    assert.equal(fs.existsSync(attPath), true, '附件必须与视图同目录（第 3 级、不建子目录）');
    const attRaw = fs.readFileSync(attPath);
    assert.equal(sha256Of(attRaw), r.attachment.sha256, '附件 sha256 必须可独立复算');
    assert.equal(attRaw.length, r.attachment.bytes);
    const attText = attRaw.toString('utf8');
    assert.equal(attText.endsWith('\n'), true, '附件必须是 LF 结尾');
    const lines = attText.split('\n').filter(Boolean);
    assert.equal(lines.length, longArgEvents(arg).length, '附件行数 == 事件范围内事件数');
    const callEv = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'tool/call');
    assert.equal(callEv.data.arguments, arg, '附件必须逐字恢复完整工具参数');
    // 视图侧：头 2000 码点可对上（说明展示是"前缀+披露"，不是乱码/转义）
    assert.equal(md.includes([...arg].slice(0, 2000).join('')), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 守：多字节边界——按 Unicode 码点截断，不能把 emoji 的代理对拆成半个字符（坏字符就谈不上逐字恢复）。
test('P0-5/D11：多字节（中文+emoji）超 2000 码点 → 不拆代理对、附件逐字恢复', () => {
  const arg = '中'.repeat(1500) + '😀'.repeat(600) + '尾巴';
  const code = '20261109-75238718e41a-A-00000009';
  const r = renderWithArg(code, arg);
  assert.equal([...arg].length, 2102);
  assert.equal(r.markdown.includes(arg), false);
  assert.match(r.markdown, /^> \[截断\] 原始长度=2102字符 附件=20261109-75238718e41a-A-00000009 原始事件\.json sha256=[0-9a-f]{64}$/m);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.markdown), false, '视图出现孤立高位代理项');
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.markdown), false, '视图出现孤立低位代理项');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05mb-'));
  const doc = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
  const attLines = fs.readFileSync(path.join(path.dirname(doc.path), `${code} 原始事件.json`), 'utf8').split('\n').filter(Boolean);
  const recovered = attLines.map((l) => JSON.parse(l)).find((e) => e.type === 'tool/call').data.arguments;
  assert.equal(recovered, arg, '中文+emoji 必须逐字恢复');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 守：D11 的"单块"包括工具**结果**正文（不只参数）；结果块同样 2000 上限 + 披露 + 附件可恢复。
test('P0-5/D11：工具结果正文是独立展示块，同样 2000 上限 + 披露 + 附件可恢复', () => {
  const bigResult = 'R'.repeat(4500) + 'END';
  const events = [
    { seq: 1, type: 'turn/start', time: T0, data: { turn: 1 } },
    { seq: 2, type: 'tool/call', time: T0 + 100, data: { callId: 'c1', name: 'read', arguments: '{"p":"a"}' } },
    { seq: 3, type: 'tool/result', time: T0 + 150, sourceEventSeqs: [2], data: { message: { isError: false, content: [{ type: 'text', text: bigResult }] } } },
    { seq: 4, type: 'turn/end', time: T0 + 200, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const code = '20261109-75238718e41a-A-00000010';
  const r = renderOriginal({ events, turn: turnOf(), code, sid: SID, sessKey: KEY, seq: 1, offsetMinutes: 480 });
  assert.equal(r.markdown.includes(bigResult), false, '超长工具结果必须截断展示');
  assert.equal((r.markdown.match(/^> \[截断\] 原始长度=/gm) || []).length, 1, '结果块的披露行必须恰好一行');
  assert.match(r.markdown, /^> \[截断\] 原始长度=4503字符 附件=/m);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05r-'));
  const doc = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r.markdown, attachment: r.attachment });
  const attLines = fs.readFileSync(path.join(path.dirname(doc.path), `${code} 原始事件.json`), 'utf8').split('\n').filter(Boolean);
  const recovered = attLines.map((l) => JSON.parse(l)).find((e) => e.type === 'tool/result').data.message.content[0].text;
  assert.equal(recovered, bigResult, '工具结果必须从附件逐字恢复');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 九、v0.5 P1-1：完整文件 hash + verifyOriginal（YAML/完整字节/正文/附件都核）
// ============================================================================

function makeDoc(code, text) {
  const ev = [
    { seq: 1, type: 'turn/start', time: T0, data: { turn: 1 } },
    { seq: 2, type: 'user/message', time: T0 + 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    { seq: 3, type: 'turn/end', time: T0 + 20, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const r = renderOriginal({ events: ev, turn: turnOf(), code, sid: SID, sessKey: KEY, seq: 1, offsetMinutes: 480 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-'));
  const doc = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
  return { dir, r, doc, code };
}

// 守：正文 hash 不含 YAML → 只比正文会漏掉"改 YAML"；fullHash 必须覆盖整份文件字节（P1-1）。
test('P1-1：writeOriginal 返回 bodyHash/fullHash，且与磁盘字节独立复算一致', () => {
  const { dir, r, doc, code } = makeDoc('20261109-75238718e41a-A-00000011', '正文内容');
  const raw = fs.readFileSync(doc.path);
  assert.equal(doc.fullHash, sha256Of(raw), 'fullHash 必须覆盖整个文件字节（含 YAML）');
  assert.equal(doc.fullHash, r.fullHash);
  assert.equal(doc.fullHash, originalFullHash(raw));
  const text = raw.toString('utf8');
  const bodyStart = text.indexOf('\n## 1.') + 1;
  assert.equal(doc.bodyHash, sha256Of(Buffer.from(text.slice(bodyStart), 'utf8')));
  assert.equal(doc.attachment.name, `${code} 原始事件.json`);
  assert.equal(doc.attachment.sha256, sha256Of(fs.readFileSync(doc.attachment.path)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// 守：P1-1"绑定"复核四要素——路径/完整文件/正文/附件，任一不符都不得判 ok。
test('P1-1：verifyOriginal 正常通过；改 YAML / 改正文 / 改名 / 附件不符 各自检出', () => {
  const { dir, doc, code } = makeDoc('20261109-75238718e41a-A-00000012', '正文内容');
  const attSha = doc.attachment.sha256;
  const expected = { expectedFullHash: doc.fullHash, expectedBodyHash: doc.bodyHash, expectedCode: code, expectedAttachmentSha256: attSha };
  const good = verifyOriginal(doc.path, expected);
  assert.equal(good.ok, true, '干净凭证必须复核通过：' + JSON.stringify(good.problems));
  assert.deepEqual(good.problems, []);

  // 1) 改 YAML（正文不动）→ FILE_HASH_MISMATCH，且不误报正文
  fs.writeFileSync(doc.path, fs.readFileSync(doc.path, 'utf8').replace('委托人: user', '委托人: attacker'), 'utf8');
  const vYaml = verifyOriginal(doc.path, expected);
  assert.equal(vYaml.ok, false);
  assert.ok(vYaml.problems.includes('FILE_HASH_MISMATCH'), JSON.stringify(vYaml.problems));
  assert.equal(vYaml.problems.includes('BODY_HASH_MISMATCH'), false, '只改 YAML 不应误报正文');
  assert.equal(vYaml.problems.includes('ATTACHMENT_HASH_MISMATCH'), false);

  // 2) 改正文 → BODY_HASH_MISMATCH（YAML 正文hash 与复算不符）+ FILE_HASH_MISMATCH
  fs.writeFileSync(doc.path, fs.readFileSync(doc.path, 'utf8').replace('正文内容', '被改过的正文'), 'utf8');
  const vBody = verifyOriginal(doc.path, expected);
  assert.equal(vBody.ok, false);
  assert.ok(vBody.problems.includes('BODY_HASH_MISMATCH'), JSON.stringify(vBody.problems));
  assert.ok(vBody.problems.includes('FILE_HASH_MISMATCH'));

  // 3) 文件名与 YAML 编码不一致 → FILENAME_CODE_MISMATCH
  const otherName = path.join(path.dirname(doc.path), `${code} 改名 完整原文.md`);
  fs.copyFileSync(doc.path, otherName);
  const vName = verifyOriginal(otherName, { expectedCode: code });
  assert.ok(vName.problems.includes('FILENAME_CODE_MISMATCH'), JSON.stringify(vName.problems));
  fs.rmSync(otherName, { force: true });

  // 4) 附件 sha256 不符 / 附件缺失
  const wrongAtt = verifyOriginal(doc.path, { expectedAttachmentSha256: 'f'.repeat(64) });
  assert.ok(wrongAtt.problems.includes('ATTACHMENT_HASH_MISMATCH'), JSON.stringify(wrongAtt.problems));
  fs.rmSync(doc.attachment.path, { force: true });
  const missingAtt = verifyOriginal(doc.path, { expectedAttachmentSha256: attSha });
  assert.ok(missingAtt.problems.includes('ATTACHMENT_MISSING'), JSON.stringify(missingAtt.problems));

  // 5) 期望路径不符 → PATH_MISMATCH（文件被搬走也不能显示"绑定"）
  const wrongPath = verifyOriginal(doc.path, { expectedPath: path.join(dir, 'nope', 'x.md') });
  assert.ok(wrongPath.problems.includes('PATH_MISMATCH'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// 守：P1-1 的洞——"复用只比正文哈希 → 改 YAML 被静默复用"；现在整文件 hash 不同必须停摆。
test('P1-1：正文相同但 YAML 被改 → writeOriginal 拒绝静默复用（ORIGINAL_CONFLICT/full-hash-mismatch）', () => {
  const { dir, r, doc, code } = makeDoc('20261109-75238718e41a-A-00000013', '正文内容');
  const again = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
  assert.equal(again.reused, true, '完全相同的重写必须复用');
  // 人为改 YAML（正文不变），再按"本应写入的内容"重写 → 必须停摆
  fs.writeFileSync(doc.path, fs.readFileSync(doc.path, 'utf8').replace('委托人: user', '委托人: attacker'), 'utf8');
  const tamperedRaw = fs.readFileSync(doc.path);
  let err = null;
  try {
    writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
  } catch (e) { err = e; }
  assert.ok(err, '正文相同但完整文件不同必须停摆');
  assert.equal(err.code, 'ORIGINAL_CONFLICT');
  assert.equal(err.kind, 'full-hash-mismatch');
  assert.equal(fs.readFileSync(doc.path).equals(tamperedRaw), true, '冲突分支不得改写文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 守：P0回归-v2 的验收夹具是 `arguments = JSON.stringify({command: raw})` ——
//     披露的"原始长度"必须是**参数内容**（raw）的码点数，而不是 JSON 外壳长度；
//     附件必须在同目录、行数==事件数、sha256 与披露一致、arguments 可逐字恢复。
test('P0-5/D11：JSON 外壳参数按内容计长披露（对齐 P0回归-v2 夹具），附件逐字恢复', () => {
  const raw = 'X'.repeat(4517) + '【4517尾标】';
  const code = '20261109-75238718e41a-A-00000015';
  const T = Date.parse('2026-11-08T10:00:00+08:00');
  const events = [
    { seq: 1, type: 'turn/start', time: T, data: { turn: 1 } },
    { seq: 2, type: 'tool/call', time: T + 100, data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: raw }) } },
    { seq: 3, type: 'tool/result', time: T + 200, sourceEventSeqs: [2], data: { message: { isError: false, content: [{ type: 'text', text: 'ok' }] } } },
    { seq: 4, type: 'turn/end', time: T + 300, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const r = renderOriginal({ events, turn: turnOf(), code, sid: SID, sessKey: KEY, seq: 1, offsetMinutes: 480 });
  const m = /^> \[截断\] 原始长度=(\d+)字符 附件=(.+? 原始事件\.json) sha256=([0-9a-f]{64})$/m.exec(r.markdown);
  assert.ok(m, '缺少 D11 披露行：' + r.markdown.slice(0, 160));
  assert.equal(Number(m[1]), raw.length, '原始长度必须是参数内容(raw)的码点数，不是 JSON 外壳长度');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05json-'));
  const doc = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
  const attPath = path.join(path.dirname(doc.path), m[2]);
  assert.equal(fs.existsSync(attPath), true, '披露指向的附件文件必须存在且同目录');
  assert.equal(sha256Of(fs.readFileSync(attPath)), m[3], '披露的 sha256 必须是附件实算');
  const lines = fs.readFileSync(attPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, events.length, '附件行数 == 事件范围内事件数');
  assert.deepEqual(
    [...new Set(lines.map((l) => JSON.parse(l).seq).filter(Number.isInteger))].sort((a, b) => a - b),
    [1, 2, 3, 4],
    '附件 seq 集合必须与事件范围一致',
  );
  const recoveredArgs = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'tool/call').data.arguments;
  assert.equal(recoveredArgs, JSON.stringify({ command: raw }), '附件必须逐字恢复 arguments');
  assert.equal(JSON.parse(recoveredArgs).command, raw, '恢复出的参数内容必须含尾部标记');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 守：D11 附件同样不可覆盖；同 code 已存在异内容附件 → ATTACHMENT_CONFLICT 停摆（不得静默换附件）。
test('P0-5/D11：附件已存在且内容不同 → ATTACHMENT_CONFLICT（停摆不覆盖）', () => {
  const code = '20261109-75238718e41a-A-00000014';
  const r1 = renderWithArg(code, 'A'.repeat(3000));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05c-'));
  const doc1 = writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r1.markdown, attachment: r1.attachment });
  const attBefore = fs.readFileSync(doc1.attachment.path);
  const r2 = renderWithArg(code, 'B'.repeat(3000)); // 同 code、不同事件 → 附件内容不同
  let err = null;
  try {
    // 附件先写、且已存在异内容 → 在正文分支之前就停摆
    writeOriginal({ root: dir, y: 2026, m: 11, code, markdown: r1.markdown, attachment: r2.attachment });
  } catch (e) { err = e; }
  assert.ok(err, '附件冲突必须抛错');
  assert.equal(err.code, 'ATTACHMENT_CONFLICT');
  assert.equal(fs.readFileSync(doc1.attachment.path).equals(attBefore), true, '冲突分支不得改写附件');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 十、原子写盘（2026-11-09 夜 / P0-3-resume）：半截凭证从构造上不可能出现
//
// 背景：原实现 `openSync(target,'wx')` 直写 + fsync。kill -9 落在 write 中途 →
//      磁盘上留下"半截 .md / 半截附件 JSON" → 下一轮同码 EEXIST → ORIGINAL_CONFLICT /
//      ATTACHMENT_CONFLICT **永久停摆**，"重启续跑"失效。
// 修复：写满 `.tmp-*` + fsync → **原子发布**最终名（硬链接；不支持则确认不存在后 rename）。
//      于是最终名只有两种状态：不存在 / 字节完整。
// ★ 红线不变：已存在且复核不过 → 仍然冲突停摆（本文件既有 ORIGINAL_CONFLICT/ATTACHMENT_CONFLICT 用例不动）。
// ============================================================================

test('原子写：成功后不留 .tmp-*；扫描/盘点/对账三处读取端都看不见 .tmp-*', async () => {
  const { isOriginalTempName, ORIGINAL_TMP_PREFIX } = await import(pathToFileURL(path.join(SRC, 'lib', 'original.js')).href);
  const cleanup = await import(pathToFileURL(path.join(SRC, 'freeze', 'cleanup.js')).href);
  const reconcile = await import(pathToFileURL(path.join(SRC, 'lib', 'reconcile.js')).href);
  const receipt = await import(pathToFileURL(path.join(SRC, 'lib', 'receipt.js')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  try {
    const r = render();
    const doc = writeOriginal({ root: dir, y: 2026, m: 11, code: CODE, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
    const d = path.dirname(doc.path);
    const mainName = path.basename(doc.path);
    const attName = path.basename(doc.attachment.path);

    // 成功写后目录里只有"最终名"两个文件，绝无临时残留
    const namesAfter = fs.readdirSync(d);
    assert.deepEqual(namesAfter.filter((n) => n.includes('.tmp-')), [], '成功写盘后不得残留临时文件：' + JSON.stringify(namesAfter));
    assert.deepEqual(namesAfter.sort(), [attName, mainName].sort());

    // 预置一个"崩溃残留"（模拟 kill -9 时 finally 没机会跑留下的半成品）
    const tmpName = `${ORIGINAL_TMP_PREFIX}${mainName}.999999-deadbeef`;
    const tmpPath = path.join(d, tmpName);
    fs.writeFileSync(tmpPath, '{"半截附件":', 'utf8');
    assert.equal(isOriginalTempName(tmpName), true, 'isOriginalTempName 必须认 .tmp- 前缀');

    // 读取端三处都必须"看不见"它（否则会被当成凭证/被孤儿扫描收录）
    assert.deepEqual(
      cleanup.listOriginals(dir).map((x) => path.basename(x.abs)).sort(),
      [mainName], '清册扫描（listOriginals）不得把 .tmp-* 当凭证',
    );
    assert.deepEqual(
      reconcile.listArchiveFiles(dir).map((x) => path.basename(x.file)).sort(),
      [attName, mainName].sort(), '对账/孤儿扫描（listArchiveFiles）不得把 .tmp-* 当凭证',
    );
    assert.equal(receipt.countOriginalViews(dir), 1, '收据盘点（countOriginalViews）不得把 .tmp-* 计入原文数');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('原子写：清理只清"写者已死"的残留，绝不清活进程正在写的临时文件', async () => {
  const { ORIGINAL_TMP_PREFIX } = await import(pathToFileURL(path.join(SRC, 'lib', 'original.js')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-stale-'));
  try {
    const r = render();
    // 先落一份合法凭证，拿到目录
    const doc = writeOriginal({ root: dir, y: 2026, m: 11, code: CODE, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
    const d = path.dirname(doc.path);
    const mainName = path.basename(doc.path);

    // ① 死进程的残留（pid=999999 几乎必然 ESRCH）→ 下次同目标写入前应被清掉
    const deadTmp = path.join(d, `${ORIGINAL_TMP_PREFIX}${mainName}.999999-dead`);
    fs.writeFileSync(deadTmp, '{"半截":', 'utf8');
    // ② "活进程"的临时文件：用当前进程 pid 假装另一个活着的写者 → **绝不能被清**
    const aliveTmp = path.join(d, `${ORIGINAL_TMP_PREFIX}${mainName}.${process.pid}-alive`);
    fs.writeFileSync(aliveTmp, '{"正在写":', 'utf8');

    // 触发一次同目标写入（已存在 → 走复用复核，但仍必须先清理死残留）
    const again = writeOriginal({ root: dir, y: 2026, m: 11, code: CODE, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash, attachment: r.attachment });
    assert.equal(again.reused, true, '同内容必须复用（红线不变）');
    assert.equal(fs.existsSync(deadTmp), false, '写者已死（ESRCH）的 .tmp-* 残留应被清理');
    assert.equal(fs.existsSync(aliveTmp), true, '★ 活进程正在写的 .tmp-* 绝不能被清（跨进程互删事故）');
    fs.rmSync(aliveTmp, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('原子写：写失败不留临时文件且红线不变（目标被占用 → 仍 ORIGINAL_CONFLICT）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-fail-'));
  try {
    const r = render();
    // 目标最终名被一个**目录**占住：原子发布必然失败（EEXIST 系）→ 走"已存在"复核 → 冲突停摆
    const monthDir = path.join(dir, '2026年11月', '11月总“完整原文”');
    fs.mkdirSync(path.join(monthDir, `${CODE} 完整原文.md`), { recursive: true });

    let err = null;
    try {
      writeOriginal({ root: dir, y: 2026, m: 11, code: CODE, markdown: r.markdown, bodyHash: r.bodyHash, fullHash: r.fullHash });
    } catch (e) { err = e; }
    assert.ok(err, '目标被占用必须抛错（不许静默成功）');
    assert.equal(err.code, 'ORIGINAL_CONFLICT', '红线不变：已存在但无法复核 → ORIGINAL_CONFLICT，实际=' + (err && err.code));
    // try/finally 清理：失败后目录里不得留任何临时文件
    assert.deepEqual(
      fs.readdirSync(monthDir).filter((n) => n.includes('.tmp-')), [],
      '写失败后不得残留临时文件',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
