/**
 * @file 自测-legacy基线.mjs
 * @role 测 `freeze/legacy-marks.js`（D18 修正）：legacy 基线必须 append-only、哈希链、幂等、可检出篡改；
 *       且"基线里没有的行"绝不能算 legacy。
 *
 * 守的判据：
 *   LM-01 无基线文件 = 未标记（不是错误）；readLegacyMarks ok=true/exists=false。
 *   LM-02 追加后链完整；同 code 同指纹再追加 = 幂等跳过（不重复写）。
 *   LM-03 基线行被篡改（改 rowFingerprint）→ chainOk=false（哈希自校验失败）。
 *   LM-04 标过的行被改动 → 再标记时报 conflict（不覆盖旧标记）。
 *   LM-05 collectLegacyCandidates 只收"缺绑定证据"的行；有证据的行不进候选。
 *
 * 用法：node docs/跑测试.mjs docs/自测-legacy基线.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendTurn } from '../lib/ledger.js';
import { renderOriginal, writeOriginal } from '../lib/original.js';
import { weekOf } from '../lib/week.js';
import { reconcile } from '../lib/reconcile.js';
import {
  readLegacyMarks, appendLegacyMarks, collectLegacyCandidates,
  rowFingerprint, legacyMarksPath, LEGACY_REASON,
} from '../freeze/legacy-marks.js';

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const TS = '2026-11-08T10:00:00+08:00';
const CODE = '20261108-75238718e41a-A-00000001';

function withRoot(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-marks-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(root, { recursive: true });
  try { return fn({ base, root }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

/** 写一份真凭证 + 一条"无绑定证据"的历史行（形状同 v0.4 行）。 */
function plantLegacyRow(root) {
  const ms = Date.parse(TS);
  const w = weekOf(ms, 480);
  const code = CODE;
  const events = [
    { seq: 1, type: 'turn/start', time: ms, data: { turn: 1 } },
    { seq: 2, type: 'turn/end', time: ms + 1000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const rendered = renderOriginal({
    events, turn: { turn: 1, startMs: ms, endMs: ms + 1000, reason: 'completed' },
    code, sid: SID, sessKey: '75238718e41aA', seq: 1, offsetMinutes: 480,
  });
  const doc = writeOriginal({
    root, y: w.year, m: w.month, code,
    markdown: rendered.markdown, bodyHash: rendered.bodyHash, fullHash: rendered.fullHash,
  });
  const rec = {
    v: 3, code, ts: TS, sid: SID, turn: 1, seq: 1, status: 'ok', turnState: 'closed',
    doc: doc.rel, docHash: 'a'.repeat(64),
  };
  assert.equal(appendTurn(root, rec, new Set()).ok, true);
  const row = { ...rec };
  return { code, row, fingerprint: rowFingerprint(row) };
}

test('LM-01：无基线文件 = 未标记（不是错误）', () => withRoot(({ root }) => {
  const m = readLegacyMarks(root);
  assert.equal(m.exists, false);
  assert.equal(m.ok, true);
  assert.equal(m.chainOk, true);
  assert.equal(m.count, 0);
}));

test('LM-02：追加后链完整；同指纹重复追加 = 幂等跳过', () => withRoot(({ root }) => {
  const { code, row, fingerprint } = plantLegacyRow(root);
  const r1 = appendLegacyMarks(root, [{ code, fingerprint, sid: SID, turn: 1, status: 'ok' }]);
  assert.equal(r1.ok, true);
  assert.equal(r1.appended, 1);
  assert.equal(fs.existsSync(legacyMarksPath(root)), true);

  const m1 = readLegacyMarks(root);
  assert.equal(m1.ok, true);
  assert.equal(m1.chainOk, true);
  assert.equal(m1.count, 1);
  assert.equal(m1.byCode.get(code).reason, LEGACY_REASON);
  assert.equal(m1.byCode.get(code).rowFingerprint, fingerprint);
  assert.equal(row.sid, SID);

  const r2 = appendLegacyMarks(root, [{ code, fingerprint, sid: SID, turn: 1, status: 'ok' }]);
  assert.equal(r2.ok, true);
  assert.equal(r2.appended, 0);
  assert.equal(r2.skipped, 1);
  assert.equal(readLegacyMarks(root).count, 1, '幂等：不得重复追加');
}));

test('LM-03：基线行被篡改 → chainOk=false', () => withRoot(({ root }) => {
  const { code, fingerprint } = plantLegacyRow(root);
  appendLegacyMarks(root, [{ code, fingerprint, sid: SID, turn: 1, status: 'ok' }]);
  const p = legacyMarksPath(root);
  const obj = JSON.parse(fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)[0]);
  obj.rowFingerprint = 'b'.repeat(64); // 篡改指纹
  fs.writeFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
  const m = readLegacyMarks(root);
  assert.equal(m.chainOk, false, '哈希自校验必须发现篡改');
  assert.equal(m.ok, false);
  const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
  assert.equal(r.legacyMarks.chainOk, false);
  assert.equal(r.legacyUnverifiable.some((x) => x.code === code), false, '链断时不得把行算 legacy');
}));

test('LM-04：标过的行被改动 → 再标记报 conflict，不覆盖旧标记', () => withRoot(({ root }) => {
  const { code, fingerprint } = plantLegacyRow(root);
  appendLegacyMarks(root, [{ code, fingerprint, sid: SID, turn: 1, status: 'ok' }]);
  const r = appendLegacyMarks(root, [{ code, fingerprint: 'c'.repeat(64), sid: SID, turn: 1 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflicts');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].reason, 'row-changed-since-marked');
  assert.equal(readLegacyMarks(root).count, 1, '不得追加第二条冲突标记');
}));

test('LM-05：collectLegacyCandidates 只收缺证据行；reconcile 对未标记行按缺凭证计', () => withRoot(({ root }) => {
  plantLegacyRow(root);
  const c = collectLegacyCandidates(root);
  assert.equal(c.ok, true);
  assert.equal(c.candidates.length, 1);
  assert.equal(c.candidates[0].code, CODE);
  assert.equal(c.candidates[0].fingerprint, rowFingerprint(c.candidates[0].rec));
  const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
  assert.equal(r.legacyUnverifiable.length, 0);
  assert.equal(r.originalMissing.some((m) => m.code === CODE && m.reason === 'NO_BINDING_EVIDENCE'), true);
}));
