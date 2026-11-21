/**
 * @file 自测-week.mjs
 * @role 周界引擎的黄金用例：月内切段、周一起算、1 天周、6 周月、跨零点/跨月。
 * @why 周记账的所有"行落在哪张表"都依赖这个函数。它错一次，账就跨期一次。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { monthWeeks, weekOf, weeklyFileName, weeklyFolderName } = await import(pathToFileURL(path.join(SRC, 'lib', 'week.js')).href);

const seg = (y, m) => monthWeeks(y, m, 480).map((w) => `${w.fromDay}-${w.toDay}`);

test('monthWeeks：2026-11（1 号周日）→ 6 段，首尾各 1 天', () => {
  assert.deepEqual(seg(2026, 11), ['1-1', '2-8', '9-15', '16-22', '23-29', '30-30']);
});

test('monthWeeks：2026-12（1 号周二）→ 5 段，首 6 天、末 4 天', () => {
  assert.deepEqual(seg(2026, 12), ['1-6', '7-13', '14-20', '21-27', '28-31']);
});

test('monthWeeks：2026-03（1 号周日）→ 6 段', () => {
  assert.deepEqual(seg(2026, 3), ['1-1', '2-8', '9-15', '16-22', '23-29', '30-31']);
});

test('monthWeeks：1 号正好是周一 → 第 1 段满 7 天', () => {
  // 2026-06-01 是周一
  assert.deepEqual(seg(2026, 6).slice(0, 2), ['1-7', '8-14']);
});

test('weekOf：跨零点按真实发生时刻切（23:59 → 本周，00:00 → 下周）', () => {
  const a = weekOf(Date.parse('2026-11-01T23:59:59+08:00'), 480);
  const b = weekOf(Date.parse('2026-11-02T00:00:00+08:00'), 480);
  assert.equal(a.weekNo, 1);
  assert.equal(b.weekNo, 2);
  assert.equal(a.label, '11月第1周');
  assert.equal(b.label, '11月第2周');
});

test('weekOf：月末最后一天仍在本月最后一段', () => {
  const w = weekOf(Date.parse('2026-11-30T23:59:59+08:00'), 480);
  assert.equal(w.weekNo, 6);
  assert.equal(w.month, 11);
});

test('weekOf：跨月零点立刻换月（1/31 23:59 vs 2/1 00:00）', () => {
  const a = weekOf(Date.parse('2026-01-31T23:59:59+08:00'), 480);
  const b = weekOf(Date.parse('2026-02-01T00:00:00+08:00'), 480);
  assert.equal(a.month, 1);
  assert.equal(a.weekNo, 5); // 2026-01：1 号周四 → 5 段，末段 26-31
  assert.equal(b.month, 2);
  assert.equal(b.weekNo, 1); // 2/1 是周日 → 第 1 段只有 1 天
});

test('文件名与目录：用 13 位会话键，不用 23 位会话标识', () => {
  const w = weekOf(Date.parse('2026-11-30T10:00:00+08:00'), 480);
  assert.equal(weeklyFileName(w, '75238718e41aA'), '11月第6周-75238718e41aA的周记账.xlsx');
  assert.equal(weeklyFolderName(w), '2026年11月');
});

test('每段首尾毫秒是本地 00:00:00 与 23:59:59.999', () => {
  const [w1] = monthWeeks(2026, 11, 480);
  assert.equal(w1.startMs, Date.parse('2026-11-01T00:00:00+08:00'));
  assert.equal(w1.endMs, Date.parse('2026-11-01T23:59:59.999+08:00'));
});
