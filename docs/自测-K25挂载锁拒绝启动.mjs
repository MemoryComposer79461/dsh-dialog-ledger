/**
 * @file 自测-K25挂载锁拒绝启动.mjs
 * @role 回归锁（v1.0.0-preview4 · K-25 第二轮加固）：**挂载期持锁 → 第二个写者"启动即拒绝"**。
 *
 * @why 第二轮异机报告实测：旧实现"每 tick 抢一次锁"，两个挂载实例会**交替成为写者**，
 *      文档写的"启动即拒绝"只在单 tick 内成立（声明强度 > 实现强度）。
 *      现在 apply() 在挂载期持锁、tick 复用同一 handle：第二个 apply 必须
 *       ① 打 ERROR「拒绝启动」；② **一次 tick 都不跑**（不写账）；③ 锁一直被第一个实例持有。
 *
 * @run node --test --test-concurrency=1 docs\自测-K25挂载锁拒绝启动.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, __test__ } from '../index.js';
import { acquire, release } from '../lib/lock.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLogger() {
  const infos = []; const warns = []; const errors = [];
  return {
    infos, warns, errors,
    info: (m) => infos.push(String(m)),
    warn: (m) => warns.push(String(m)),
    error: (m) => errors.push(String(m)),
    debug: () => {},
  };
}

function makeCfg(root) {
  return {
    root, enabled: true, intervalSeconds: 3600, // 只靠"立刻跑一次"，不靠定时器
    offsetMinutes: 480, hotWindowSeconds: 0, quietSeconds: 120,
    scanBudgetMs: 0, maxBytesPerSession: 0,
    checkupEnabled: false, weeklyEnabled: false, handoverEnabled: false,
  };
}

function withLab(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-k25mount-'));
  const dshHome = path.join(base, 'dsh-home');
  const root = path.join(base, 'ledger-root');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  return Promise.resolve(fn({ base, dshHome, root })).finally(() => {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

const metricsCount = (root) => {
  const p = path.join(root, 'ledger', '.tick-metrics.jsonl');
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length;
};

test('K-25/mount：第一个实例持锁期间，第二个 apply 必须「拒绝启动」且一次 tick 都不跑', async () => {
  await withLab(async ({ root }) => {
    __test__.setLockRetryMs(50); // 测试缩短重试间隔（生产 30s）
    const log1 = makeLogger();
    const dispose1 = apply({ logger: log1, effect: null }, makeCfg(root));
    await sleep(300); // 等第一个实例完成"取锁 + 首次 tick"

    // ① 挂载锁确实被第一个实例持有（tick 结束后**不释放** —— 这是本轮修复的核心）
    const probe = acquire(root, { instanceId: 'probe-' + Math.random().toString(16).slice(2) });
    assert.equal(probe.acquired, false, '★ 第一个实例 tick 结束后，锁必须仍被挂载期持有（tick 不许释放）');
    if (probe.stalePath) { try { fs.rmSync(probe.stalePath, { force: true }); } catch { /* ignore */ } }

    // ② 第二个实例：必须 ERROR 拒绝启动、不跑 tick
    const log2 = makeLogger();
    const dispose2 = apply({ logger: log2, effect: null }, makeCfg(root));
    const before = metricsCount(root);
    await sleep(300);
    const errText = [...log2.errors, ...log2.warns].join('\n');
    assert.match(errText, /拒绝启动/, '★ 第二个写者必须 ERROR「拒绝启动」（实际日志：' + errText.slice(0, 200) + '）');
    assert.match(errText, /多写者场景不支持/, '★ 必须明确"多写者场景不支持"');
    assert.equal(metricsCount(root), before, '★ 第二个实例一次 tick 都不许跑（tick-metrics 不应增长）');
    assert.equal(/已取得账库写锁/.test(log2.infos.join('\n')), false, '第二个实例不许报"已取得写锁"');

    // ③ 第一个实例释放后：新的 apply 能重新取到锁并启动（重试路径）
    await dispose2();
    await dispose1();
    const log3 = makeLogger();
    const dispose3 = apply({ logger: log3, effect: null }, makeCfg(root));
    await sleep(200);
    assert.match(log3.infos.join('\n'), /已取得账库写锁/, '★ 前一个实例释放后，新实例必须能取到锁并启动');
    await dispose3();
    __test__.setLockRetryMs(0);
  });
});
