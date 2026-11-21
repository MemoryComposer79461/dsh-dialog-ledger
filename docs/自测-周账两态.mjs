/**
 * @file 自测-周账两态.mjs
 * @role V0.7 周账「草稿/封板」两态专项：草稿前缀、封板 rename、历史迁移、冲突、状态不明、正式名只认封板。
 *
 * 用法：node docs/跑测试.mjs docs/自测-周账两态.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const weekly = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);
const { writeWeekly, groupRecords, DRAFT_STATUS_TEXT, SEALED_STATUS_TEXT } = weekly;

const KEY = '75238718e41aA';
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const TS = '2026-11-30T10:00:00+08:00'; // 2026-11 第 6 周（周一，1 天周）

const mk = (n, ts = TS) => ({
  v: 3,
  code: `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`,
  ts,
  sid: SID,
  turn: n,
  seq: n,
  status: 'ok',
});
const lab = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-2state-'));
  return { dir, root: path.join(dir, 'root') };
};
const pathsOf = (root) => {
  const dir = path.join(root, '2026年11月');
  const official = path.join(dir, `11月第6周-${KEY}的周记账.xlsx`);
  const draft = path.join(dir, `草稿-11月第6周-${KEY}的周记账.xlsx`);
  return { dir, official, draft };
};

function base() {
  const { root } = lab();
  const g = [...groupRecords([mk(1)], 480).values()][0];
  return { root, g, base: { root, w: g.w, sessKey: g.sessKey } };
}

test('WK-S1：草稿写 草稿- 前缀；正式名只在封板时出现', () => {
  const { root, base: b } = base();
  const r = writeWeekly({ ...b, records: [mk(1)], mode: 'draft', generatedAt: '2026-11-30 10:05:00' });
  const p = pathsOf(root);
  assert.equal(r.path, p.draft, '草稿必须写 草稿- 路径');
  assert.equal(fs.existsSync(p.draft), true);
  assert.equal(fs.existsSync(p.official), false, '未封板前不得出现正式名');
  assert.ok(fs.readFileSync(p.draft, 'utf8').includes(DRAFT_STATUS_TEXT));
});

test('WK-S2：封板 = sealed 内容 rename 正式名 + 删除草稿；正式名带封板标记', () => {
  const { root, base: b } = base();
  writeWeekly({ ...b, records: [mk(1)], mode: 'draft', generatedAt: '2026-11-30 10:05:00' });
  const r = writeWeekly({ ...b, records: [mk(1)], mode: 'sealed', sealedAt: '2026-12-04 00:00:00', generatedAt: '2026-12-04 00:00:00' });
  const p = pathsOf(root);
  assert.equal(r.path, p.official, '封板必须落正式名');
  assert.equal(fs.existsSync(p.official), true);
  assert.equal(fs.existsSync(p.draft), false, '封板后草稿必须删除');
  const text = fs.readFileSync(p.official, 'utf8');
  assert.ok(text.includes(SEALED_STATUS_TEXT));
  assert.ok(text.includes(`封板hash: ${r.sealHash}`));
});

test('WK-S3：封板后再写 skips:sealed 且正式名字节不变', () => {
  const { root, base: b } = base();
  writeWeekly({ ...b, records: [mk(1)], mode: 'draft' });
  const sealed = writeWeekly({ ...b, records: [mk(1)], mode: 'sealed', sealedAt: '2026-12-04 00:00:00' });
  const before = fs.readFileSync(sealed.path);
  const again = writeWeekly({ ...b, records: [mk(1), mk(2)], mode: 'draft', generatedAt: '2026-12-05 00:00:00' });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'sealed');
  assert.deepEqual(fs.readFileSync(sealed.path), before, '封板后字节不许变');
  assert.equal(fs.existsSync(pathsOf(root).draft), false, '封板后不得出现草稿');
});

test('WK-S5：历史无标记正式名 → rename 为草稿（字节不改）且本轮不重写', () => {
  const { root, base: b } = base();
  const p = pathsOf(root);
  fs.mkdirSync(p.dir, { recursive: true });
  const legacy = Buffer.from('legacy-draft-bytes（模拟旧版草稿，无封板标记）', 'utf8');
  fs.writeFileSync(p.official, legacy);
  const r = writeWeekly({ ...b, records: [mk(1)], mode: 'draft' });
  assert.equal(fs.existsSync(p.official), false, '历史正式名必须被迁走');
  assert.equal(fs.existsSync(p.draft), true);
  assert.deepEqual(fs.readFileSync(p.draft), legacy, '迁移只 rename，字节一个不改');
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'state-lost');
  assert.equal(r.warnings.some((w) => w.type === 'legacy-draft-migrated'), true);
});

test('WK-S5b：正式名与草稿并存 → 冲突告警，保正式名、拒绝写入', () => {
  const { root, base: b } = base();
  const p = pathsOf(root);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.official, Buffer.from('official-bytes', 'utf8'));
  fs.writeFileSync(p.draft, Buffer.from('draft-bytes', 'utf8'));
  const r = writeWeekly({ ...b, records: [mk(1)], mode: 'draft' });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'E_WEEKLY_STATE_CONFLICT');
  assert.deepEqual(fs.readFileSync(p.official), Buffer.from('official-bytes'));
  assert.deepEqual(fs.readFileSync(p.draft), Buffer.from('draft-bytes'));
});

test('WK-S6：正式名状态不明（含封板字样但解析不出标记）→ E_SEAL_UNKNOWN，字节不改', () => {
  const { root, base: b } = base();
  const p = pathsOf(root);
  fs.mkdirSync(p.dir, { recursive: true });
  const garbage = Buffer.from(SEALED_STATUS_TEXT + '\n（标记不可解析）\n', 'utf8');
  fs.writeFileSync(p.official, garbage);
  const r = writeWeekly({ ...b, records: [mk(1)], mode: 'sealed', sealedAt: '2026-12-04 00:00:00' });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'E_SEAL_UNKNOWN');
  assert.deepEqual(fs.readFileSync(p.official), garbage, '状态不明时绝不允许改字节');
});
