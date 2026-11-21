/**
 * @file 自测-toolface.mjs
 * @role V0.6 工具面验收（V0.9 扩到 9 个工具）：9 个工具能被注册/执行，且
 *       **除读日志（以及 V0.9 显式受控写的 ledger_cleanup_apply 产物）外不改任何文件**。
 *
 * @why 只读工具的"只读"必须可判定：
 *      允许新增读日志（运行区：V0.6.4 ③ 起为 `ledger/.reads/YYYY-MM.jsonl` 分片，
 *      老库 `ledger/.reads.jsonl` 只读兼容），除此之外全库 sha256 必须不变。
 *      这条断言以后就是"工具面不许顺手改账"的守门员。
 *
 * @why V0.9 新增 4 个工具后，本文件的只读硬断言**只覆盖 8 个只读工具**：
 *      `ledger_cleanup_apply` 的默认 dry-run 按规格必须产一份 `RPT-DRYRUN-*.md`，
 *      它不属于"只读"；其写行为由 docs/自测-agenttools.mjs 的 CT-02 精确守
 *      （只允许新增这一份报告、不占正式编号、零删除），不是放宽断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tf = await import(pathToFileURL(path.join(SRC, 'tools', 'toolface.js')).href);
const rl = await import(pathToFileURL(path.join(SRC, 'tools', 'readlog.js')).href);

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const codeOf = (n) => `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`;

function lab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'toolface-'));
  const root = path.join(base, 'root');
  const led = path.join(root, 'ledger');
  fs.mkdirSync(led, { recursive: true });
  const rows = [1, 2, 3].map((n) => ({
    v: 3, code: codeOf(n), ts: `2026-11-08 1${n}:00:00 +08:00`, sid: SID, turn: n, seq: n,
    status: 'ok', turnState: 'closed',
    doc: `2026年11月\\11月第2周\\${codeOf(n)} 完整原文.md`,
    docSha256: 'a'.repeat(64), docFileSha256: 'b'.repeat(64),
    attachment: { name: `${codeOf(n)} 原始事件.json`, sha256: 'c'.repeat(64), bytes: 1 },
  }));
  fs.writeFileSync(path.join(led, '2026-11-08.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const abs = path.join(root, rows[0].doc);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# 第 1 轮\n\n## 1. 用户输入\n\n你好。\n', 'utf8');
  return { base, root };
}

/** 是否读日志路径（唯一允许变化的文件）：V0.6.4 ③ 起包括旧单文件与新 `.reads/` 分片。 */
function isReadLogRel(rel) {
  const p = rel.split(path.sep).join('/');
  return p === 'ledger/.reads.jsonl' || p === 'ledger/.reads' || p.startsWith('ledger/.reads/');
}

function snapshotExceptReadLog(root) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const rel = path.relative(root, p);
      if (isReadLogRel(rel)) continue; // .reads 目录整棵跳过（分片都属读日志）
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(rel + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out.sort();
}

test('V0.6/toolface：9 个工具的定义齐全，描述里带"先查 Session ID"提示', () => {
  const defs = tf.buildToolDefs({ getRoot: () => '/nonexistent', offsetMinutes: 480 });
  assert.deepEqual(defs.map((d) => d.name), [
    'ledger_search', 'ledger_turn', 'ledger_context', 'ledger_whoami', 'ledger_health',
    // ★ V0.9 新增 4 个（原 5 个必须仍排在最前，顺序固定）
    'ledger_reconcile', 'ledger_anchor', 'ledger_cleanup_preview', 'ledger_cleanup_apply',
  ]);
  for (const d of defs) {
    assert.equal(typeof d.description, 'string');
    assert.equal(d.description.length > 10, true, d.name + ' 描述太短');
    assert.equal(typeof d.execute, 'function');
    assert.equal(typeof d.output.render, 'function');
    assert.equal(typeof d.parameters, 'object');
  }
  const search = defs.find((d) => d.name === 'ledger_search');
  assert.match(search.description, /Session ID/, '搜索工具必须提示先确定 Session ID');
  const who = defs.find((d) => d.name === 'ledger_whoami');
  assert.match(who.description, /Session ID/);
});

test('V0.6/toolface：工具执行返回正确结果，并写入读日志', async () => {
  const { base, root } = lab();
  try {
    const defs = tf.buildToolDefs({ getRoot: () => root, offsetMinutes: 480 });
    const by = Object.fromEntries(defs.map((d) => [d.name, d]));
    const exec = { agent: { id: SID } };

    const who = await by.ledger_whoami.execute({}, exec);
    assert.equal(who.ok, true);
    assert.equal(who.sessionId, SID);

    const s = await by.ledger_search.execute({ sid: SID, limit: 2 }, exec);
    assert.equal(s.ok, true);
    assert.equal(s.rows.length, 2);
    assert.equal(s.truncated, true);

    const t = await by.ledger_turn.execute({ code: codeOf(1) }, exec);
    assert.equal(t.ok, true);
    assert.equal(t.original.exists, true);
    assert.match(t.excerpt, /你好/);

    const c = await by.ledger_context.execute({ sid: SID, turns: 2 }, exec);
    assert.equal(c.ok, true);
    assert.equal(c.lastTurn, 3);

    const h = await by.ledger_health.execute({}, exec);
    assert.equal(h.ledgerOk, true);
    assert.equal(h.rows, 3);
    assert.equal(h.bound, 3);

    // 读日志：5 次调用 → 5 行，工具名与命中编码都在
    const log = rl.readReads(root, { limit: 20 });
    assert.equal(log.total, 5, '每次工具调用都必须留读日志');
    const names = log.rows.map((r) => r.tool).sort();
    assert.deepEqual(names, ['ledger_context', 'ledger_health', 'ledger_search', 'ledger_turn', 'ledger_whoami']);
    const sRow = log.rows.find((r) => r.tool === 'ledger_search');
    assert.equal(sRow.sessionId, SID, '读日志必须记会话 id');
    assert.equal(sRow.hitCodes.length, 2, '读日志必须记命中编码');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/toolface：除读日志外，全库 sha256 不变（只读工具硬断言）', () => {
  const { base, root } = lab();
  try {
    const defs = tf.buildToolDefs({ getRoot: () => root, offsetMinutes: 480 });
    const exec = { agent: { id: SID } };
    const before = snapshotExceptReadLog(root);
    // ★ V0.9：apply 的默认 dry-run 按规格要产 RPT-DRYRUN 报告，不属于"只读工具"；
    //   本断言只对 8 个只读工具成立。apply 的写行为由 自测-agenttools.mjs:CT-02 精确守。
    for (const d of defs.filter((x) => x.name !== 'ledger_cleanup_apply')) {
      const args = d.name === 'ledger_turn' ? { code: codeOf(1) }
        : d.name === 'ledger_context' ? { sid: SID }
          : d.name === 'ledger_search' ? { sid: SID } : {};
      d.execute(args, exec);
    }
    const after = snapshotExceptReadLog(root);
    assert.deepEqual(after, before, '只读工具只允许新增读日志，不许改动台账/原文/其它文件');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/toolface：能注册/撤销；没有 tools 服务时静默跳过不抛错', () => {
  const calls = { reg: 0, dispose: 0 };
  const fakeTools = {
    register(def) {
      calls.reg += 1;
      assert.ok(def.name);
      return () => { calls.dispose += 1; };
    },
  };
  const ctx = {
    get(k) { return k === 'tools' ? fakeTools : undefined; },
    logger: { info() {}, warn() {} },
  };
  const r = tf.registerLedgerTools(ctx, { getRoot: () => '/x', offsetMinutes: 480 });
  assert.equal(r.registered, 9);
  assert.equal(r.names.length, 9);
  r.dispose();
  assert.equal(calls.dispose, 9, '卸载时必须撤销全部工具注册');

  // 没有 tools 服务的环境：不抛错、registered=0
  const bare = tf.registerLedgerTools({ logger: { warn() {} } }, { getRoot: () => '/x' });
  assert.equal(bare.registered, 0);
  assert.equal(typeof bare.dispose, 'function');
});

test('V0.6/toolface：apply() 带 tools 服务时注册 9 个工具，卸载时全部撤销', async () => {
  const index = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'toolface-apply-'));
  const root = path.join(base, 'root');
  const reg = [];
  const disposed = [];
  const fakeTools = {
    register(def) { reg.push(def.name); return () => disposed.push(def.name); },
  };
  const effectDisposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(k) { return k === 'tools' ? fakeTools : undefined; },
    effect(fn) { const d = fn(); effectDisposers.push(d); return d; },
  };
  try {
    index.apply(ctx, { root, intervalSeconds: 3600, enabled: true, hotWindowSeconds: 0 });
    assert.equal(reg.length, 9, '带工具服务时必须注册 9 个工具（实际 ' + JSON.stringify(reg) + '）');
    assert.deepEqual(reg.slice().sort(), [
      'ledger_anchor', 'ledger_cleanup_apply', 'ledger_cleanup_preview', 'ledger_context',
      'ledger_health', 'ledger_reconcile', 'ledger_search', 'ledger_turn', 'ledger_whoami',
    ]);
    assert.ok(effectDisposers.length >= 1, 'apply 必须用 ctx.effect 注册清理');
    for (const d of effectDisposers.slice().reverse()) if (typeof d === 'function') d();
    assert.equal(disposed.length, 9, '卸载时必须撤销全部工具注册');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
