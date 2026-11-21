/**
 * @file 自测-weeklystate.mjs
 * @role V0.7 周账两态：命名/路径/分类/迁移决策/写入模式（纯函数，不碰 FS）。
 *
 * 用法：node docs/跑测试.mjs docs/自测-weeklystate.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ws = await import(pathToFileURL(path.join(SRC, 'lib', 'weeklystate.js')).href);

const W = { year: 2026, month: 11, weekNo: 2 };
const SESS = 'dee34b23';

test('V0.7 weeklystate：正式名/草稿名/路径（月目录 + 草稿前缀）', () => {
  assert.equal(ws.officialNameOf(W, SESS), '11月第2周-dee34b23的周记账.xlsx');
  assert.equal(ws.draftNameOf(W, SESS), '草稿-11月第2周-dee34b23的周记账.xlsx');
  assert.equal(ws.officialPathOf('/r', W, SESS), '2026年11月/11月第2周-dee34b23的周记账.xlsx');
  assert.equal(ws.draftPathOf('/r', W, SESS), '2026年11月/草稿-11月第2周-dee34b23的周记账.xlsx');
  assert.equal(ws.DRAFT_PREFIX, '草稿-');
});

test('V0.7 weeklystate：文件名分类 official / draft / other', () => {
  assert.equal(ws.classifyWeeklyName('11月第2周-dee34b23的周记账.xlsx'), 'official');
  assert.equal(ws.classifyWeeklyName('草稿-11月第2周-dee34b23的周记账.xlsx'), 'draft');
  // 草稿前缀 + 非周账名 → other
  assert.equal(ws.classifyWeeklyName('草稿-随便.xlsx'), 'other');
  // 非 xlsx / 非周账命名 → other
  assert.equal(ws.classifyWeeklyName('11月第2周-dee34b23的周记账.txt'), 'other');
  assert.equal(ws.classifyWeeklyName('说明.xlsx'), 'other');
  assert.equal(ws.classifyWeeklyName(null), 'other');
  // 正式名正则必须排除草稿前缀（防止计数把草稿算成周账）
  assert.equal(ws.isDraftName('草稿-11月第2周-dee34b23的周记账.xlsx'), true);
  assert.equal(ws.isDraftName('11月第2周-dee34b23的周记账.xlsx'), false);
});

test('V0.7 weeklystate：历史迁移决策矩阵（五种情形）', () => {
  // 无文件 → none
  assert.equal(ws.decideMigration({}).action, 'none');
  // 只有草稿 → none（正常草稿）
  assert.equal(ws.decideMigration({ draftExists: true }).action, 'none');
  // 正式名 + 有封板标记 → none（不动）
  assert.equal(ws.decideMigration({ officialExists: true, officialSealed: true }).action, 'none');
  // 正式名 + journal 有 gid 但标记丢失 → 告警，不重写
  assert.equal(ws.decideMigration({ officialExists: true, journalSealed: true }).action, 'warn-marker-lost');
  // 正式名无标记无 journal → 历史遗留草稿，rename 迁移
  assert.equal(ws.decideMigration({ officialExists: true }).action, 'migrate-legacy-draft');
  // 正式名 + 草稿并存 → 保正式名，告警
  assert.equal(ws.decideMigration({ officialExists: true, draftExists: true }).action, 'conflict-official-wins');
});

test('V0.7 weeklystate：写入模式（sealed / conflict / draft）', () => {
  assert.equal(ws.decideWriteMode({ officialExists: true, officialSealed: true }), 'sealed');
  assert.equal(ws.decideWriteMode({ officialExists: true, journalSealed: true, officialSealed: false }), 'sealed');
  assert.equal(ws.decideWriteMode({ officialExists: true, draftExists: true }), 'conflict');
  assert.equal(ws.decideWriteMode({ draftExists: true }), 'draft');
  assert.equal(ws.decideWriteMode({}), 'draft');
});

test('V0.7 weeklystate：分类与迁移判定对同一文件族自洽（抽样）', () => {
  const names = [ws.officialNameOf(W, SESS), ws.draftNameOf(W, SESS)];
  assert.deepEqual(names.map((n) => ws.classifyWeeklyName(n)), ['official', 'draft']);
  // 迁移判定：只有正式名（无标记）→ 迁移；只有草稿 → 不动
  assert.equal(ws.decideMigration({ officialExists: ws.classifyWeeklyName(names[0]) === 'official' }).action, 'migrate-legacy-draft');
  assert.equal(ws.decideMigration({ draftExists: ws.classifyWeeklyName(names[1]) === 'draft' }).action, 'none');
});
