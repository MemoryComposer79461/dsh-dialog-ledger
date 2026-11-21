#!/usr/bin/env node
/**
 * @file 工具-标记legacy基线.mjs
 * @role **一次性可审计动作**：把"确实没有绑定证据"的历史台账行，写进 `<root>/ledger/.legacy-marks.jsonl`
 *       作为 legacy 正面基线。之后 reconcile 只有"基线里标过、且行指纹未变"的行才算 legacy。
 *
 * @why 为什么必须显式跑一次：
 *   D18 初版按"缺证据字段"判定 legacy → **删掉字段就能洗白**（2026-11-10 已实证攻击成功）。
 *   唯一正确的修法：不能凭"没有证据"推断"本来没有证据"；必须有一次被记录、可复算的标记动作。
 *   本工具就是那次动作：只写 `.legacy-marks.jsonl`（append-only + 哈希链），绝不改台账/原文。
 *
 * 用法：
 *   node docs/工具-标记legacy基线.mjs --root=<账库根>            # dry-run：只列出候选，不写盘
 *   node docs/工具-标记legacy基线.mjs --root=<账库根> --write    # 写入基线（幂等；已标过同指纹的跳过）
 *   node docs/工具-标记legacy基线.mjs --root=<账库根> --check    # 只校验基线链与现状
 *   --json 输出机读结果
 *
 * 退出码：0 正常；1 基线链断/校验不符；2 参数错误或存在冲突（未写入）。
 *
 * 纪律：本工具没有"自动"模式；必须人显式敲 --write。写盘前先 dry-run 看清候选数。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  collectLegacyCandidates, appendLegacyMarks, readLegacyMarks,
  legacyMarksPath, rowFingerprint,
} from '../freeze/legacy-marks.js';

const argv = process.argv.slice(2);
const argOf = (k, d = '') => {
  const hit = argv.find((a) => a === k || a.startsWith(k + '='));
  if (!hit) return d;
  const i = hit.indexOf('=');
  return i < 0 ? '' : hit.slice(i + 1);
};
const ROOT = argOf('--root');
const WRITE = argv.includes('--write');
const CHECK = argv.includes('--check');
const JSON_OUT = argv.includes('--json');

if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('用法: node docs/工具-标记legacy基线.mjs --root=<账库根> [--write|--check] [--json]');
  process.exit(2);
}
const root = path.resolve(ROOT);
const marksPath = legacyMarksPath(root);

function emit(obj, humanLines) {
  if (JSON_OUT) { console.log(JSON.stringify(obj, null, 2)); return; }
  for (const l of humanLines) console.log(l);
}

// ── --check：只校验 ────────────────────────────────────────────────────────
if (CHECK) {
  const marks = readLegacyMarks(root);
  const cand = collectLegacyCandidates(root);
  const current = new Map((cand.candidates || []).map((c) => [c.code, c.fingerprint]));
  let matched = 0, mismatched = 0, orphan = 0, gone = 0;
  for (const [code, m] of marks.byCode) {
    const fp = current.get(code);
    if (fp === undefined) { gone++; }
    else if (fp === m.rowFingerprint) { matched++; }
    else { mismatched++; }
  }
  const unmarked = (cand.candidates || []).filter((c) => !marks.byCode.has(c.code)).length;
  const ok = marks.chainOk === true && marks.badLines === 0 && mismatched === 0;
  emit({
    ok, root, marksPath, exists: marks.exists, count: marks.count,
    chainOk: marks.chainOk, badLines: marks.badLines, chainBreakAt: marks.chainBreakAt,
    matched, mismatched, unmarked, orphan, notInLedger: gone,
    ledgerReadable: cand.ok === true, scanned: cand.scanned || 0,
  }, [
    `[check] 基线: ${marksPath}（${marks.exists ? '存在' : '不存在'}）`,
    `[check] 链: ${marks.chainOk ? 'OK' : '断裂@line ' + marks.chainBreakAt}｜坏行 ${marks.badLines}｜记录 ${marks.count}`,
    `[check] 现状: 匹配 ${matched}｜指纹不符 ${mismatched}｜未标记候选 ${unmarked}｜基线里已不在台账 ${gone}｜孤儿标记 ${orphan}`,
    `[check] 结论: ${ok ? 'PASS' : 'FAIL'}`,
  ]);
  process.exit(ok ? 0 : 1);
}

// ── 默认 dry-run / --write ────────────────────────────────────────────────
const cand = collectLegacyCandidates(root);
if (!cand.ok) {
  console.error('[legacy] 台账读不全，拒绝标记：reason=' + cand.reason + ' readErrors=' + cand.readErrors + ' badLines=' + cand.badLines);
  process.exit(2);
}
const marks = readLegacyMarks(root);
const fresh = cand.candidates.filter((c) => {
  const m = marks.byCode.get(c.code);
  return !m || m.rowFingerprint !== c.fingerprint;
});
const already = cand.candidates.length - fresh.length;

if (!WRITE) {
  emit({
    mode: 'dry-run', root, marksPath,
    scanned: cand.scanned, candidates: cand.candidates.length,
    alreadyMarked: already, newToMark: fresh.length,
    sample: fresh.slice(0, 5).map((c) => ({ code: c.code, sid: c.rec.sid, turn: c.rec.turn, doc: c.rec.doc })),
    note: 'dry-run 未写盘；确认候选数后加 --write',
  }, [
    `[dry-run] 账库: ${root}`,
    `[dry-run] 台账行 ${cand.scanned}｜缺绑定证据候选 ${cand.candidates.length}（已标记 ${already}，待标记 ${fresh.length}）`,
    ...fresh.slice(0, 5).map((c) => `  - ${c.code}  sid=${c.rec.sid} turn=${c.rec.turn} doc=${c.rec.doc || '(无)'}`),
    fresh.length > 5 ? `  …还有 ${fresh.length - 5} 条` : '',
    '[dry-run] 未写盘。确认后执行: --write',
  ].filter(Boolean));
  process.exit(0);
}

const res = appendLegacyMarks(root, fresh.map((c) => ({
  code: c.code, fingerprint: c.fingerprint,
  sid: c.rec.sid, turn: Number.isInteger(c.rec.turn) ? c.rec.turn : null, status: String(c.rec.status || ''),
})));
emit({ mode: 'write', root, marksPath, ...res }, [
  `[write] 基线: ${marksPath}`,
  `[write] 追加 ${res.appended} 条｜跳过（已标同指纹）${res.skipped} 条｜冲突 ${res.conflicts.length} 条`,
  ...res.conflicts.slice(0, 5).map((c) => `  ! 冲突 ${c.code}: ${c.reason}`),
  `[write] 结果: ${res.ok ? 'OK' : 'FAIL: ' + (res.reason || '')}`,
]);
process.exit(res.ok ? 0 : 2);
