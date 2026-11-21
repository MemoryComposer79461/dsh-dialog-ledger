/**
 * @file 自测-weekly.mjs
 * @role 周记账落盘验收（v1.3 十列版式：说明 + 7 张日表 + 周统计）。
 * @why 记账凭证的版式要稳定：任何一周都是 9 张表（说明/周一…周日/周统计）。
 *      v1.3 与 v0.4 的差异（本文件守的就是这些）：
 *        · 十列（编码/原始凭证/时间/角色/摘要/文件引用/输出位置/状态/用户审计/备注），
 *          机器只填 A/B/C/H 默认/I「待审」，D/E/F/G/J 填 `—`；
 *        · **禁止占位行**：空日/短周不再写「（本日无凭证）」「（本日不在本段）」，
 *          改由「周统计」B 列 = `—` / 记录数 0 显式表达（占位行会污染 COUNTA）；
 *        · 周统计：C=COUNTA(日表!$A$2:$A$121)，D:F=COUNTIF(日表!$I$2:$I$121,…)，A13 溢出行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { groupRecords, writeWeekly, sessKeyOf, buildSheets, TEN_COLUMNS } = await import(pathToFileURL(path.join(SRC, 'lib', 'weekly.js')).href);

const KEY = '75238718e41aA';
const mk = (n, ts) => ({
  v: 2, code: `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`,
  ts, sid: 'session-75238718-e41a-4e8c-8044-50202444455f', turn: n, seq: n, status: 'ok',
});

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  return { dir, root: path.join(dir, 'root') };
}

/** 日表里的机器行（A 列是 32 位编码）。 */
function dataRows(sheet) {
  return (sheet.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === 'string' && /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(r[0]));
}

test('sessKeyOf：从编码取 13 位会话键', () => {
  // 守：会话键口径不变（组键 = 12 位短 ID + 代差）
  assert.equal(sessKeyOf('20261108-75238718e41a-A-00000001'), KEY);
  assert.equal(sessKeyOf('坏编码'), '');
});

test('groupRecords：跨月两条分到两个组（11月第6周 / 12月第1周）', () => {
  // 守：周段切分（week.js 唯一实现）不被十列改版影响
  const recs = [mk(1, '2026-11-30T10:00:00+08:00'), mk(2, '2026-12-01T09:00:00+08:00')];
  const g = groupRecords(recs, 480);
  assert.equal(g.size, 2);
  const names = [...g.values()].map((x) => `${x.w.month}月第${x.w.weekNo}周`).sort();
  assert.deepEqual(names, ['11月第6周', '12月第1周']);
});

test('buildSheets（v1.3）：说明 + 周一…周日 + 周统计 = 9 张表', () => {
  // 守：WK-03 sheet 名与顺序（v1.3 固定 9 张，不增不减）
  const recs = [mk(1, '2026-11-04T10:00:00+08:00')]; // 周三
  const g = [...groupRecords(recs, 480).values()][0];
  const sheets = buildSheets({ w: g.w, sessKey: KEY, records: recs, offsetMinutes: 480, generatedAt: '2026-11-09 12:00:00' });
  assert.deepEqual(sheets.map((s) => s.name), ['说明', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周统计']);
});

test('buildSheets：周三有凭证、其余日在段内但无凭证 → 十列机器行 + 空日 A 列全空（不写占位行）', () => {
  // 守：v1.3 十列机器初值（WK-08/WK-19~WK-21）+ 禁止占位行（WK-13/WK-31）
  const recs = [mk(1, '2026-11-04T10:00:00+08:00')]; // 2026-11-02~08 是第 2 周，周三
  const g = [...groupRecords(recs, 480).values()][0];
  const sheets = buildSheets({ w: g.w, sessKey: KEY, records: recs, offsetMinutes: 480, generatedAt: '2026-11-09 12:00:00' });
  const wed = sheets.find((s) => s.name === '周三');
  const mon = sheets.find((s) => s.name === '周一');

  // 表头逐字十列；数据区预置 120 行（A2:J121）
  assert.deepEqual(wed.rows[0], TEN_COLUMNS);
  assert.equal(wed.rows.length, 121);
  // 机器只填 A/B/C 与 H/I 默认值，人工列一律 —
  assert.deepEqual(dataRows(wed)[0],
    ['20261108-75238718e41a-A-00000001', '缺凭证', '10:00', '—', '—', '—', '—', '已完成', '待审', '—']);
  // 空日 = A 列全空；**不写**「（本日无凭证）」占位行（否则 COUNTA 会把它算进去）
  assert.equal(dataRows(mon).length, 0);
  assert.equal(mon.rows.length, 121);
  assert.equal(mon.rows.some((r) => Array.isArray(r) && String(r[0] || '').includes('本日')), false);
});

test('buildSheets：1 天周（2026-11-30 周一）→ 其余 6 天不在本段：周统计 B 列 = —、记录数 0', () => {
  // 守：短周口径（WK-29/WK-32）——不在段内用 `—` 表达，不再写「（本日不在本段）」占位行
  const recs = [mk(1, '2026-11-30T10:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const sheets = buildSheets({ w: g.w, sessKey: KEY, records: recs, offsetMinutes: 480, generatedAt: '2026-11-09 12:00:00' });
  const mon = sheets.find((s) => s.name === '周一');
  const tue = sheets.find((s) => s.name === '周二');
  const stats = sheets.find((s) => s.name === '周统计');

  assert.equal(dataRows(mon).length, 1);
  assert.equal(dataRows(tue).length, 0);
  assert.equal(tue.rows.length, 121);
  // 周统计第 5 行 = 周一（日期锚点），第 6 行 = 周二（不在本段 → `—`、C=0）
  assert.deepEqual(stats.rows[3], ['星期', '日期', '记录数', '审计通过', '审计未通过', '待审']);
  assert.equal(stats.rows[4][0], '周一');
  assert.equal(stats.rows[4][1], '2026-11-30');
  assert.equal(stats.rows[4][2].f, 'COUNTA(周一!$A$2:$A$121)');
  assert.equal(stats.rows[4][2].v, 1);
  assert.equal(stats.rows[5][0], '周二');
  assert.equal(stats.rows[5][1], '—');
  assert.equal(stats.rows[5][2].v, 0);
  assert.equal(JSON.stringify(sheets).includes('（本日不在本段）'), false);
});

test('buildSheets：周统计含每日行数与合计，审计公式引用 I 列（不是 H 列）', () => {
  // 守：WK-25~WK-28 周统计列位/公式（插 B 列后审计列从 H 右移到 I）
  const recs = [mk(1, '2026-11-30T10:00:00+08:00'), mk(2, '2026-11-30T11:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const sheets = buildSheets({ w: g.w, sessKey: KEY, records: recs, offsetMinutes: 480, generatedAt: '2026-11-09 12:00:00' });
  const sum = sheets.find((s) => s.name === '周统计');

  assert.deepEqual(sum.rows.slice(4, 11).map((r) => r[0]), ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
  assert.equal(sum.rows[4][2].f, 'COUNTA(周一!$A$2:$A$121)');
  assert.equal(sum.rows[4][2].v, 2);
  assert.equal(sum.rows[4][3].f, 'COUNTIF(周一!$I$2:$I$121,"通过")');
  assert.equal(sum.rows[4][4].f, 'COUNTIF(周一!$I$2:$I$121,"不通过")');
  assert.equal(sum.rows[4][5].f, 'COUNTIF(周一!$I$2:$I$121,"待审")');
  assert.equal(JSON.stringify(sum).includes('$H$'), false, '审计三列不得引用 H 列');
  // 合计行：C12 = SUM(C5:C11)，其余三列同样 SUM
  assert.equal(sum.rows[11][0], '合计');
  assert.equal(sum.rows[11][2].f, 'SUM(C5:C11)');
  assert.equal(sum.rows[11][2].v, 2);
  assert.equal(sum.rows[11][3].f, 'SUM(D5:D11)');
  assert.equal(sum.rows[11][4].f, 'SUM(E5:E11)');
  assert.equal(sum.rows[11][5].f, 'SUM(F5:F11)');
  // 溢出行（WK-30）：无溢出时 C13 是数字 0
  assert.equal(sum.rows[12][0], '溢出（未写入本册）');
  assert.equal(sum.rows[12][2], 0);
});

test('writeWeekly：落到二级目录、文件名含周号与会话键，返回 v1.3 形状', () => {
  // 守：WK-01/WK-02（文件名/目录）+ v1.3 草稿文件头（WK-04）+ writeWeekly 返回形状
  const { root } = lab();
  const recs = [mk(1, '2026-11-30T10:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const r = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: g.records, offsetMinutes: 480 });
  assert.equal(r.path, path.join(root, '2026年11月', `草稿-11月第6周-${KEY}的周记账.xlsx`), 'V0.7 两态：草稿写 草稿- 前缀');
  assert.equal(r.groupId, '2026-11-6|75238718e41aA');
  assert.equal(r.written, true);
  assert.equal(r.skipped, false);
  assert.equal(r.mode, 'draft');
  assert.equal(r.sealed, false);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(r.sealHash, '');
  assert.equal(Array.isArray(r.warnings), true);
  const text = fs.readFileSync(r.path, 'utf8');
  assert.match(text, /20261108-75238718e41a-A-00000001/);
  assert.match(text, /周记账模板 v1\.3/);
  assert.match(text, /状态: 草稿/);
  assert.match(text, /原始凭证/);
  assert.match(text, /周统计/);
  assert.equal(text.includes('（本日不在本段）'), false);
});

test('writeWeekly：内容没变 → 不重写（written=false，mtime 不变）', () => {
  // 守：WK-33 草稿幂等（内容指纹未变则跳过写盘）
  const { root } = lab();
  const recs = [mk(1, '2026-11-30T10:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const first = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: g.records });
  const mt = fs.statSync(first.path).mtimeMs;
  const second = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: g.records, prevHashes: { [first.groupId]: first.hash } });
  assert.equal(second.written, false);
  assert.equal(second.reason, 'unchanged');
  assert.equal(fs.statSync(first.path).mtimeMs, mt);
});

test('writeWeekly：新增一条 → 重写且新行可见', () => {
  // 守：WK-33 草稿可重生成（指纹变化 → mtime/内容变化）
  const { root } = lab();
  const recs = [mk(1, '2026-11-30T10:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const first = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: g.records });
  const more = [...g.records, mk(2, '2026-11-30T10:10:00+08:00')];
  const second = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: more, prevHashes: { [first.groupId]: first.hash } });
  assert.equal(second.written, true);
  assert.notEqual(second.hash, first.hash);
  assert.match(fs.readFileSync(second.path, 'utf8'), /00000002/);
});

test('writeWeekly：原子写（不留 .tmp）', () => {
  // 守：写盘原子性（tmp → rename，不产生半成品）
  const { root } = lab();
  const recs = [mk(1, '2026-11-30T10:00:00+08:00')];
  const g = [...groupRecords(recs, 480).values()][0];
  const r = writeWeekly({ root, w: g.w, sessKey: g.sessKey, records: g.records });
  assert.equal(fs.existsSync(r.path + '.tmp'), false);
});
