/**
 * @file 自测-selfheal.mjs
 * @role V0.7 自愈扫描的周账两态口径：草稿在 ≠ 缺（不产生重建动作）；无草稿才报 weeklyDraftMissing。
 *
 * 用法：node docs/跑测试.mjs docs/自测-selfheal.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = await import(pathToFileURL(path.join(SRC, 'freeze', 'selfheal.js')).href);
const weekly = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);
const { writeWeekly, groupRecords } = weekly;

const KEY = '75238718e41aA';
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const TS = '2026-11-30T10:00:00+08:00';
const CODE = '20261108-75238718e41a-A-00000001';
const rec = { v: 3, code: CODE, ts: TS, sid: SID, turn: 1, seq: 1, status: 'ok' };

function makeRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-2state-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ledger', '2026-11-30.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  const g = [...groupRecords([rec], 480).values()][0];
  return { base, root, g };
}

test('selfheal 两态：草稿存在 → 不报 weeklyDraftMissing', () => {
  const { base, root, g } = makeRoot();
  try {
    const r = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: [rec], mode: 'draft' });
    assert.equal(fs.existsSync(r.path), true);
    const scan = sh.scan({ root, offsetMinutes: 480 });
    assert.deepEqual(scan.weeklyDraftMissing, [], '草稿存在是正常态，不应报缺（否则会触发多余重建/告警）');
    assert.deepEqual(scan.sealedBookMissing, []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('selfheal 两态：草稿与正式名都没有 → 仍按"草稿可重建"报 weeklyDraftMissing', () => {
  const { base, root } = makeRoot();
  try {
    const scan = sh.scan({ root, offsetMinutes: 480 });
    assert.equal(scan.weeklyDraftMissing.length, 1, JSON.stringify(scan.weeklyDraftMissing));
    assert.equal(scan.weeklyDraftMissing[0].gid, `2026-11-6|${KEY}`);
    assert.match(scan.weeklyDraftMissing[0].file, /11月第6周-.*的周记账\.xlsx$/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
