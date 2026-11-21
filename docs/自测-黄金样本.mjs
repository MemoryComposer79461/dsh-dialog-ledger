/**
 * @file 自测-黄金样本.mjs
 * @role 把冻结的编码样本接进 `node --test` —— 让"旧账永远可验证"成为每次必过的闸门。
 * @why 校验.mjs 是同一套逻辑的 CLI 入口；这里只是换个入口调用同一个 verify()，
 *      避免"脚本绿、测试红"的两套标准。
 *
 * 守什么：
 *   · 日期段必须是**会话开始日**（跨零点/跨月两例）；
 *   · 会话标识 23 位 + 序号 = 32 位；
 *   · 短 ID 撞车时第二个会话拿代差 B（不是覆盖）。
 * 任何一条红，说明编码规则被改了 —— 旧账的 code 将无法重算，必须先停下来修。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { verify } = await import(pathToFileURL(path.join(HERE, '黄金样本', '校验.mjs')).href);

test('黄金样本：10 条冻结用例全部可重算（拒改编码规则）', () => {
  const r = verify();
  assert.equal(r.fails.length, 0, '不一致: ' + JSON.stringify(r.fails));
  assert.equal(r.pass, r.total);
  assert.equal(r.total, 10, '样本数变了 —— 增删样本必须同时更新期望值');
});
