/**
 * @file 自测-backfill-exec.mjs
 * @role V0.7 补记执行器：journal 先证据后动作、幂等、失败重试/放弃、回退边界、降级不抛。
 *
 * 用法：node docs/跑测试.mjs docs/自测-backfill-exec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bex = await import(pathToFileURL(path.join(SRC, 'tools', 'backfill-exec.js')).href);

const KEY = '75238718e41aA';
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const TS = '2026-11-30T10:00:00+08:00';
const CODE = '20261108-75238718e41a-A-00000001';
const mkRecord = () => ({ v: 3, code: CODE, ts: TS, sid: SID, turn: 1, seq: 1, status: 'ok' });
const action = (over = {}) => ({ kind: 'write-supplement', gid: `2026-11-6|${KEY}`, sessKey: KEY, codes: [CODE], reason: 'post-seal-scan', ...over });

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-x-'));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  return { dir, root };
}

test('BE-00：actionKey 稳定且随目标变化', () => {
  const a = action();
  assert.match(bex.actionKeyOf(a), /^[0-9a-f]{64}$/);
  assert.equal(bex.actionKeyOf(a), bex.actionKeyOf({ ...a }), '同输入同 key');
  assert.notEqual(bex.actionKeyOf(a), bex.actionKeyOf({ ...a, codes: ['x'] }), '目标不同 key 不同');
  assert.notEqual(bex.actionKeyOf(a), bex.actionKeyOf({ kind: 'promote-pending', sid: SID, turn: 1 }), 'kind 不同 key 不同');
});

test('BE-01/04：dryRun 不写 journal、不执行；write-supplement 执行一次后幂等跳过且补记册字节不变', () => {
  const { root } = lab();
  const rec = mkRecord();
  const readRecords = () => [rec];

  const dry = bex.executeBackfill({ root, actions: [action()], dryRun: true, readRecords });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.executed, 0);
  assert.equal(dry.details[0].status, 'would-run');
  assert.equal(fs.existsSync(bex.journalPathOf(root)), false, 'dryRun 不得写 journal');

  const r1 = bex.executeBackfill({ root, actions: [action()], readRecords });
  assert.equal(r1.executed, 1, JSON.stringify(r1));
  assert.equal(r1.errors.length, 0);
  const journal1 = fs.readFileSync(bex.journalPathOf(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(journal1.map((x) => x.status), ['planned', 'applied'], '必须先证据后动作');
  const supFiles = fs.readdirSync(root).filter((n) => /^补记-\d{8}\.md$/.test(n));
  assert.equal(supFiles.length, 1, '必须落补记册');
  const supPath = path.join(root, supFiles[0]);
  const supBytes = fs.readFileSync(supPath);

  const r2 = bex.executeBackfill({ root, actions: [action()], readRecords });
  assert.equal(r2.executed, 0);
  assert.equal(r2.dupSkipped, 1, 'applied 后必须幂等跳过');
  assert.deepEqual(fs.readFileSync(supPath), supBytes, '补记册字节不得再变');
});

test('BE-01：handler 未接线的动作 → deferred（留痕不假执行）且同 key 后续跳过', () => {
  const { root } = lab();
  const a = { kind: 'backfill-missing-turns', sid: SID, s12: KEY, turns: [1, 2], reason: '24h-scan' };
  const r1 = bex.executeBackfill({ root, actions: [a] });
  assert.equal(r1.deferred, 1);
  const j = fs.readFileSync(bex.journalPathOf(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(j[0].status, 'deferred');
  assert.match(j[0].detail, /handler-not-wired/);
  const r2 = bex.executeBackfill({ root, actions: [a] });
  assert.equal(r2.dupSkipped, 1, 'deferred 视为已留痕，不重复执行/记录');
});

test('BE-03：失败重试到上限 → gave-up，之后不再重试（不抛）', () => {
  const { root } = lab();
  const boom = () => { throw new Error('boom'); };
  const handlers = { 'write-supplement': boom };
  const a = action();
  const r1 = bex.executeBackfill({ root, actions: [a], handlers, maxAttempts: 2 });
  assert.equal(r1.failed, 1);
  const r2 = bex.executeBackfill({ root, actions: [a], handlers, maxAttempts: 2 });
  assert.equal(r2.failed, 1);
  const r3 = bex.executeBackfill({ root, actions: [a], handlers, maxAttempts: 2 });
  assert.equal(r3.gaveUp, 1, '达到上限必须 gave-up 而不是无限重试');
  const j = fs.readFileSync(bex.journalPathOf(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(j.filter((x) => x.status === 'failed').length, 2);
  assert.equal(j.filter((x) => x.status === 'gave-up').length, 1);
  const r4 = bex.executeBackfill({ root, actions: [a], handlers, maxAttempts: 2 });
  assert.equal(r4.dupSkipped, 1);
});

test('BE-05：rollback 只撤 planned；applied 明确拒绝', () => {
  const { root } = lab();
  const plannedKey = bex.actionKeyOf(action({ codes: ['c-planned'] }));
  const appliedKey = bex.actionKeyOf(action({ codes: ['c-applied'] }));
  const file = bex.journalPathOf(root);
  fs.writeFileSync(file, [
    JSON.stringify({ v: 1, at: 'x', key: plannedKey, kind: 'write-supplement', status: 'planned', attempt: 1, target: null }),
    JSON.stringify({ v: 1, at: 'x', key: appliedKey, kind: 'write-supplement', status: 'applied', attempt: 1, target: null }),
  ].join('\n') + '\n', 'utf8');
  const rb = bex.rollbackPlanned({ root, keys: [plannedKey, appliedKey] });
  assert.equal(rb.compensated, 1);
  assert.equal(rb.refused, 1, 'applied 不可回退（账行不可删）');
  const j = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(j.map((x) => x.status), ['planned', 'applied', 'compensated']);
});

test('BE-03b：journal 有坏行 → 拒绝执行（证据不完整不得动账）', () => {
  const { root } = lab();
  const file = bex.journalPathOf(root);
  fs.writeFileSync(file, '{"key":"a","status":"applied"}\n这不是 JSON\n', 'utf8');
  const r = bex.executeBackfill({ root, actions: [action()], readRecords: () => [mkRecord()] });
  assert.equal(r.executed, 0);
  assert.ok(r.errors.some((e) => e.startsWith('JOURNAL_BAD_LINES')));
  assert.equal(fs.readdirSync(root).filter((n) => /^补记-/.test(n)).length, 0, '不得写补记');
});

test('BE-02：幂等键与 journal 终态保证"同 action 不重复执行"（重复跑 = dupSkipped）', () => {
  const { root } = lab();
  const rec = mkRecord();
  const a = action();
  const r1 = bex.executeBackfill({ root, actions: [a], readRecords: () => [rec] });
  assert.equal(r1.executed, 1);
  const r2 = bex.executeBackfill({ root, actions: [a], readRecords: () => [rec] });
  assert.equal(r2.executed, 0);
  assert.equal(r2.dupSkipped, 1);
  // 同输入同 key：重复执行不产生第二条 applied
  const j = fs.readFileSync(bex.journalPathOf(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(j.filter((x) => x.status === 'applied').length, 1);
});

test('BE-04：执行 write-supplement 不得改周账 xlsx / 台账 / 原文（第二写入口边界）', () => {
  const { root } = lab();
  const rec = mkRecord();
  const monthDir = path.join(root, '2026年11月');
  fs.mkdirSync(monthDir, { recursive: true });
  const book = path.join(monthDir, '11月第6周-75238718e41aA的周记账.xlsx');
  fs.writeFileSync(book, 'fake-weekly-bytes');
  const ledger = path.join(root, 'ledger', '2026-11-30.jsonl');
  fs.writeFileSync(ledger, JSON.stringify(rec) + '\n');
  const orig = path.join(monthDir, '完整原文', rec.code + ' 完整原文.md');
  fs.mkdirSync(path.dirname(orig), { recursive: true });
  fs.writeFileSync(orig, '# original\n');
  const before = [book, ledger, orig].map((f) => fs.readFileSync(f));
  const r = bex.executeBackfill({ root, actions: [action()], readRecords: () => [rec] });
  assert.equal(r.executed, 1);
  [book, ledger, orig].forEach((f, i) => assert.deepEqual(fs.readFileSync(f), before[i], '执行器不得改 ' + f));
});

test('BE-06：executeBackfill 摘要字段齐全（run-report backfillExec 段可直接落）', () => {
  const { root } = lab();
  const r = bex.executeBackfill({ root, actions: [action()], readRecords: () => [mkRecord()] });
  for (const k of ['v', 'at', 'dryRun', 'total', 'executed', 'dupSkipped', 'failed', 'deferred', 'gaveUp', 'journal', 'errors']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), '缺字段 ' + k);
  }
  assert.equal(typeof r.journal, 'string');
  assert.ok(r.journal.endsWith('.backfill-journal.jsonl'));
});
