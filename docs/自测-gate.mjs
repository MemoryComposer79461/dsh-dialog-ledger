/**
 * @file 自测-gate.mjs
 * @role V0.6.1 / D18-C 三级闸门 + **v0.9.1 / C18：判据输入恰好 4 项**，外加入口接线与
 *       `attachment.path` 相对路径（可移植性）验收。
 *
 * 守的判据（C18：12 项 → 4 项；每项各造一次 degraded/unknown，另保留 1 条全绿）：
 *   G-01 4 项判据输入全绿 + 无已知缺口 → `ok`（无保留）；`GATE_INPUTS` 必须**恰好 4 项**。
 *   G-02 输入①`ledgerOk` 不成立（台账没读全）→ `unknown`。
 *   G-03 输入②`codeUnique` 不成立 → `unknown`。
 *   G-04 输入③`sidTurnUnique` 不成立 → `unknown`。
 *   G-05 输入④`legacyMarks.chainOk` 不成立 → `unknown`。
 *   G-06 缺键口径：4 项各缺一次 → `unknown`（缺键绝不默认通过）；无对账记录 → `unknown`。
 *   G-07 向后兼容：旧 12 项整份输入照常判定（多余键忽略），已知可枚举缺口 → `degraded`。
 *   G-08 legacy 已基线标记 → `degraded`（不是 ok）；`ok=false` 却列不出缺口 → `unknown`（防御分支）。
 *   G-09 入口 run-report 的 gate 段与 classifyGate(reconcile()) 逐项一致（原 G-06/G-07）
 *       + 台账行 `attachment.path` 是根相对路径且真实存在。
 *
 * 用法：node docs/跑测试.mjs docs/自测-gate.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as L from './验收-v0.5/_lab.mjs';
import { reconcile } from '../lib/reconcile.js';
import { classifyGate, GATE_INPUTS, GATE_CONCLUSIONS } from '../lib/gate.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = await import(pathToFileURL(path.join(SRC, 'tools', 'panelapi.js')).href);

/** C18 钉死的 4 项判据输入：顺序即判定顺序（任何人加第 5 项都会先红）。 */
const WANT_INPUTS = ['ledgerOk', 'codeUnique', 'sidTurnUnique', 'legacyMarks.chainOk'];

/** 构造一个"干净"的 reconcile 结果（旧 12 项口径 = index.js 实际传的形状）。 */
function cleanRec(over = {}) {
  return {
    ok: true, okStrict: true, ledgerOk: true, codeUnique: true, sidTurnUnique: true,
    originalMissing: [], originalOrphan: [], weeklyGroupsMissing: [],
    lostGaps: { count: 0 }, receiptBreakCount: 0, sealChain: { ok: true },
    legacyUnverifiableCount: 0,
    legacyMarks: { chainOk: true, unmarked: 0, mismatched: 0, orphan: 0 },
    ...over,
  };
}

/** 复制一份干净 rec 并删掉某个键（造"缺判据输入"用）。 */
function recWithout(key, over = {}) {
  const r = cleanRec(over);
  delete r[key];
  return r;
}

// ── 纯函数：4 项判据输入逐项穷举 ─────────────────────────────────────────
test('G-01 4 项判据输入全绿 + 无已知缺口 → ok（无保留）', () => {
  // ★ C18：判据输入必须**恰好 4 项**（12 → 4），顺序也钉死
  assert.equal(GATE_INPUTS.length, 4, 'C18 要求判据输入恰好 4 项，实际=' + GATE_INPUTS.length);
  assert.deepEqual([...GATE_INPUTS], WANT_INPUTS);
  assert.deepEqual([...GATE_CONCLUSIONS], ['ok', 'degraded', 'unknown']);

  const g = classifyGate(cleanRec());
  assert.equal(g.conclusion, 'ok');
  assert.equal(g.reason, '');
  assert.deepEqual(g.knownGaps, []);
  assert.deepEqual(g.failedInputs, []);
  assert.deepEqual(g.inputs, {
    ledgerOk: true, codeUnique: true, sidTurnUnique: true, legacyMarksChainOk: true,
  });
});

test('G-02 输入①ledgerOk 不成立（台账没读全）→ unknown', () => {
  const g = classifyGate(cleanRec({
    ledgerOk: false, readErrors: [{ code: 'E_STATE_READ' }], badLines: 2,
  }));
  assert.equal(g.conclusion, 'unknown');
  assert.match(g.reason, /台账未读全/);
  assert.deepEqual(g.failedInputs, ['ledgerOk']);
  assert.equal(g.inputs.ledgerOk, false);
});

test('G-03 输入②codeUnique 不成立（code 重复）→ unknown', () => {
  const g = classifyGate(cleanRec({ ok: false, codeUnique: false }));
  assert.equal(g.conclusion, 'unknown');
  assert.match(g.reason, /code 不唯一/);
  assert.deepEqual(g.failedInputs, ['codeUnique']);
  assert.equal(g.inputs.codeUnique, false);
});

test('G-04 输入③sidTurnUnique 不成立（(sid,turn) 重复）→ unknown', () => {
  const g = classifyGate(cleanRec({ ok: false, sidTurnUnique: false }));
  assert.equal(g.conclusion, 'unknown');
  assert.match(g.reason, /\(sid,turn\) 不唯一/);
  assert.deepEqual(g.failedInputs, ['sidTurnUnique']);
  assert.equal(g.inputs.sidTurnUnique, false);
});

test('G-05 输入④legacyMarks.chainOk 不成立（基线链断裂）→ unknown', () => {
  const g = classifyGate(cleanRec({
    legacyMarks: { chainOk: false, unmarked: 0, mismatched: 0, orphan: 0 },
  }));
  assert.equal(g.conclusion, 'unknown');
  assert.match(g.reason, /基线链断裂/);
  assert.deepEqual(g.failedInputs, ['legacyMarks.chainOk']);
  assert.equal(g.inputs.legacyMarksChainOk, false);
});

test('G-06 缺键按 unknown 处理：4 项各缺一次；无对账记录 → unknown', () => {
  // 4 项判据输入各缺一次 → 都必须 unknown（绝不默认通过）
  for (const id of WANT_INPUTS) {
    const rec = id === 'legacyMarks.chainOk' ? cleanRec({ legacyMarks: {} }) : recWithout(id);
    const g = classifyGate(rec);
    assert.equal(g.conclusion, 'unknown', `缺 ${id} 必须 unknown`);
    assert.equal(g.missingInputs.includes(id), true, `missingInputs 必须含 ${id}：${g.missingInputs}`);
    assert.match(g.reason, /缺少判据输入/, `缺 ${id} 的 reason 必须点名：${g.reason}`);
  }
  // 连 legacyMarks 整块都没有 → 同样按缺键 unknown（旧库/半截输入不许洗白）
  const noMarks = recWithout('legacyMarks');
  const gMarks = classifyGate(noMarks);
  assert.equal(gMarks.conclusion, 'unknown');
  assert.deepEqual(gMarks.missingInputs, ['legacyMarks.chainOk']);
  // 无对账记录（rec 为空）→ unknown，且不抛错
  for (const empty of [null, undefined]) {
    const g = classifyGate(empty);
    assert.equal(g.conclusion, 'unknown');
    assert.match(g.reason, /无对账结果/);
  }
});

test('G-07 向后兼容旧 12 项整份输入：多余键忽略，已知可枚举缺口 → degraded', () => {
  // ① 旧 12 项 + 无关多余键：4 项全 true 时结论不受多余键影响
  const noisy = cleanRec({ someLegacyField: 1, anotherOne: 'x', at: '2026-11-13 12:00:00' });
  assert.equal(classifyGate(noisy).conclusion, 'ok');

  // ② 可枚举已知缺口 → degraded，reason/knownGaps 逐项可查
  const g = classifyGate(cleanRec({
    ok: false, originalMissing: [{ code: 'A', part: 'view' }],
  }));
  assert.equal(g.conclusion, 'degraded');
  assert.deepEqual(g.knownGaps, ['缺凭证=1']);
  assert.match(g.reason, /缺凭证=1/);
  // 六项里的其它已知缺口同样进 degraded
  const g2 = classifyGate(cleanRec({
    ok: false, weeklyGroupsMissing: [{ gid: 'x' }], lostGaps: { count: 2 },
    receiptBreakCount: 1, sealChain: { ok: false },
  }));
  assert.equal(g2.conclusion, 'degraded');
  for (const k of ['缺周账=1', '缺口留痕=2', '收据链断=1', '封板链异常']) {
    assert.equal(g2.knownGaps.includes(k), true, 'knownGaps 缺 ' + k);
  }
});

test('G-08 legacy 已标记 → degraded；ok=false 却列不出缺口 → unknown（防御分支）', () => {
  let g = classifyGate(cleanRec({ legacyUnverifiableCount: 2 }));
  assert.equal(g.conclusion, 'degraded');
  assert.deepEqual(g.knownGaps, ['历史无证据(legacy)=2']);
  g = classifyGate(cleanRec({
    ok: false, originalMissing: [{ code: 'A', part: 'view', reason: 'NO_BINDING_EVIDENCE' }],
    legacyMarks: { chainOk: true, unmarked: 1, mismatched: 2, orphan: 3 },
  }));
  assert.equal(g.conclusion, 'degraded');
  for (const k of ['缺凭证=1', '历史基线未标记无证据=1', '历史基线指纹不符=2', '历史基线孤儿标记=3']) {
    assert.equal(g.knownGaps.includes(k), true, 'knownGaps 缺 ' + k);
  }
  // 防御分支：4 项判据输入全成立，但 ok=false 又列不出缺口 → unknown（不许当没问题）
  const gDef = classifyGate(cleanRec({ ok: false }));
  assert.equal(gDef.conclusion, 'unknown');
  assert.match(gDef.reason, /无可枚举缺口/);
});

// ── 入口接线 + attachment.path（真实 runOnce） ───────────────────────────
test('G-09 入口 gate 落盘一致 + attachment.path 相对路径（原 G-06/G-07）', async () => {
  const lab = L.mkLab('gate');
  try {
    L.writeSession(lab, {
      events: [...L.sessionHeader(lab.sid), ...L.simpleTurn(1, L.T0())],
    });
    const { stat } = await L.runOnce('.', lab, { weeklyEnabled: true, handoverEnabled: true });
    assert.equal(stat.written, 1);

    // G-09：report.gate 与 classifyGate(reconcile) 逐项一致
    const rec = reconcile({ root: lab.root, offsetMinutes: 480 });
    const expect = classifyGate(rec);
    const repFiles = fs.readdirSync(path.join(lab.root, 'ledger')).filter((n) => n.startsWith('.run-report-')).sort();
    assert.equal(repFiles.length >= 1, true, '必须落运行报告');
    const rep = JSON.parse(fs.readFileSync(path.join(lab.root, 'ledger', repFiles[repFiles.length - 1]), 'utf8'));
    assert.equal(rep.gate.conclusion, expect.conclusion, 'report.gate.conclusion 必须与纯函数一致');
    assert.deepEqual(rep.gate.knownGaps, expect.knownGaps, 'report.gate.knownGaps 必须逐项一致');
    assert.equal(rep.gate.conclusion, 'ok');
    // C18：真实 reconcile 结果必须带齐 4 项判据输入（否则入口会恒 unknown）
    assert.deepEqual(expect.failedInputs, [], '真实入口的 4 项判据输入必须全成立，未成立=' + JSON.stringify(expect.unchecked));

    // 面板 summary 的 health.gate 透传（三级值之一）
    const env = { getRoot: () => lab.root, offsetMinutes: 480, now: () => Date.now() };
    const summary = panel.runPanelRoute(env, 'summary', { refresh: '1' });
    assert.equal(summary.json.ok, true);
    assert.equal(['ok', 'degraded', 'unknown'].includes(summary.json.health.gate), true);

    // attachment.path 必须是根相对路径，且能在 root 下找到
    const rows = (await L.readLedger('.', lab.root)).records;
    const row = rows.find((r) => r.attachment && r.attachment.path);
    assert.ok(row, '台账行必须带 attachment.path');
    const rel = String(row.attachment.path);
    assert.equal(/^[A-Za-z]:[\\/]/.test(rel), false, 'attachment.path 不得是盘符绝对路径: ' + rel);
    assert.equal(rel.startsWith(path.sep), false, 'attachment.path 不得以根分隔符开头');
    assert.equal(fs.existsSync(path.join(lab.root, rel)), true, 'attachment.path 相对 root 必须存在: ' + rel);
    assert.equal(fs.existsSync(rel), false, '相对路径不得相对进程 cwd 解析到文件（防止歧义）');

    // 集成：删掉原文视图 → 4 项判据输入仍成立，缺口可枚举 → degraded
    const docRow = rows.find((r) => r.doc);
    assert.ok(docRow, '必须有 doc 指针');
    fs.rmSync(path.join(lab.root, docRow.doc), { force: true });
    const rec2 = reconcile({ root: lab.root, offsetMinutes: 480 });
    const g2 = classifyGate(rec2);
    assert.equal(g2.conclusion, 'degraded');
    assert.equal(g2.knownGaps.some((x) => x.startsWith('缺凭证=')), true);

    // 集成：台账坏行 → 判据输入①ledgerOk 不成立 → unknown
    const dayFile = fs.readdirSync(path.join(lab.root, 'ledger')).find((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    fs.appendFileSync(path.join(lab.root, 'ledger', dayFile), '{ 这不是 JSON\n', 'utf8');
    const rec3 = reconcile({ root: lab.root, offsetMinutes: 480 });
    const g3 = classifyGate(rec3);
    assert.equal(g3.conclusion, 'unknown');
    assert.match(g3.reason, /台账未读全/);
  } finally {
    L.rmLab(lab);
  }
});
