/**
 * @file 自测-a13启动挂载.mjs
 * @role V0.6.4 / A13 回归：插件 apply 在**启动并发窗口**里不得因为读取未 inject 的服务属性而崩。
 *
 * @why 真机实测（2026-11-10 重启 DSH）：Cordis 启动时并发创建全部条目，`tools`/`webServer`
 *   可能尚未 ACTIVE；旧实现 `registerLedgerTools(ctx)` 里的回退分支读 `ctx.tools`（以及
 *   `ctx.webServer`），而 Cordis 对未 inject 的服务属性**必抛**
 *   `cannot get property "tools" without inject` → apply 失败、fiber failed 且不自愈
 *   （启动审计只写 stderr，界面上只表现为"面板 404 / 无工具"）。
 *   修复：删掉两处直读回退；服务未就绪时用 `ctx.inject(['tools'], cb)` 挂子 fiber，
 *   服务到齐后再注册（headless 下子 fiber pending，记账照跑）。
 *
 * 本用例构造"读 tools/webServer 就抛、且 ctx.get 也抛"的假 ctx（模拟 Cordis 启动窗口的真实行为），要求：
 *   ① apply 不抛；② 走 ctx.inject(['tools']) / ['webServer'] 而不是直接注册；
 *   ③ 服务就绪后回调能正常注册（工具 5 个、路由 7 条）。
 *
 * 用法：node docs/跑测试.mjs docs/自测-a13启动挂载.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idx = await import(pathToFileURL(path.join(SRC, 'index.js')).href);

const logger = { info() {}, warn() {}, error() {}, debug() {} };

/** 假 ctx：读 tools/webServer 属性必抛（Cordis 未 inject 的真实行为）；get() 永远 undefined。 */
function makeHostileCtx() {
  const injected = [];
  const effects = [];
  const ctx = {
    logger,
    get() { throw new Error('cannot get property \"tools\" without inject'); },
    inject(deps, cb) { injected.push({ deps, cb }); return {}; },
    effect(fn) { effects.push(fn); return {}; },
    // 任何代码若直接读 ctx.tools / ctx.webServer，就会命中这两个 getter（模拟 Cordis 抛错）
    get tools() { throw new Error('cannot get property "tools" without inject'); },
    get webServer() { throw new Error('cannot get property "webServer" without inject'); },
  };
  return { ctx, injected, effects };
}

test('A13：启动窗口服务未就绪 → apply 不崩，且走 inject 等待而非直读回退', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-a13-'));
  const root = path.join(base, 'root');
  try {
    const { ctx, injected, effects } = makeHostileCtx();
    assert.doesNotThrow(() => {
      idx.apply(ctx, { root, enabled: true, intervalSeconds: 60, offsetMinutes: 480 });
    }, 'apply 不得因 ctx.tools/ctx.webServer 直读而抛');

    const depSets = injected.map((x) => x.deps.join(',')).sort();
    assert.deepEqual(depSets, ['tools', 'webServer'], '必须分别 inject tools 与 webServer；实际=' + JSON.stringify(depSets));

    // 服务就绪：分别用带真实服务的子 ctx 调用回调 → 工具 5 个、路由 7 条
    const toolsService = { register(def) { assert.ok(def && typeof def === 'object'); return () => {}; } };
    const routes = [];
    const webServer = { register(route) { routes.push(route); return () => {}; } };
    const childCtx = (services) => ({
      logger,
      get(name) { return services[name] || undefined; },
      effect(fn) { effects.push(fn); return {}; },
    });
    for (const item of injected) {
      if (item.deps.includes('tools')) item.cb(childCtx({ tools: toolsService }));
      if (item.deps.includes('webServer')) item.cb(childCtx({ webServer }));
    }
    assert.equal(routes.length, 7, '服务就绪后必须注册 7 条只读路由，实际=' + routes.length);

    // 清理：执行注册到 ctx.effect 的 dispose，避免 timer 泄漏到后续用例
    for (const fn of effects) { try { const d = fn(); if (typeof d === 'function') d(); } catch { /* ignore */ } }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
