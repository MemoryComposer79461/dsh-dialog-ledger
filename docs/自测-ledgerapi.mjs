/**
 * @file 自测-ledgerapi.mjs
 * @role V0.6 只读查询层的验收：查得到、查得准、**一个字节都不改**。
 *
 * @why 只读不是口号。本文件的核心断言是"调用前后全库 sha256 集合完全不变"——
 *      以后谁在 ledgerapi 里偷偷加了个写操作（哪怕只是 repairTornTail），这里立刻变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = await import(pathToFileURL(path.join(SRC, 'tools', 'ledgerapi.js')).href);

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const mkRow = (n, mid) => {
  const code = `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`;
  return {
    v: 3, code,
    ts: `2026-11-08 ${String(10 + n).padStart(2, '0')}:00:00 +08:00`,
    sid: SID, turn: n, seq: n, status: 'ok', turnState: 'closed',
    doc: `2026年11月\\11月第2周\\${code} 完整原文.md`,
    docSha256: 'a'.repeat(64), docFileSha256: 'b'.repeat(64),
    attachment: { name: `${code} 原始事件.json`, sha256: 'c'.repeat(64), bytes: 10 },
  };
};

function makeLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerapi-'));
  const root = path.join(base, 'root');
  const led = path.join(root, 'ledger');
  fs.mkdirSync(led, { recursive: true });
  const rows = [mkRow(1), mkRow(2), { ...mkRow(3), sid: 'session-other' }];
  fs.writeFileSync(path.join(led, '2026-11-08.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  // 原文视图（第 1 条）
  const rel = rows[0].doc;
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# 第 1 轮\n\n## 1. 用户输入\n\n你好，这是一段原文。\n', 'utf8');
  return { base, root };
}

/** 全库文件 sha256 集合（只读性断言用） */
function snapshot(root) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(path.relative(root, p) + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out.sort();
}

test('V0.6/ledgerapi：searchLedger 按 sid/月份/关键词过滤，且不返回外会话行', () => {
  const { base, root } = makeLab();
  try {
    const bySid = api.searchLedger(root, { sid: SID });
    assert.equal(bySid.ok, true);
    assert.equal(bySid.rows.length, 2, '同 sid 应 2 行');
    assert.equal(bySid.rows[0].turn, 1, '必须按时间正序');
    assert.equal(bySid.rows.every((r) => r.sid === SID), true);

    const byMonth = api.searchLedger(root, { month: '2026-11' });
    assert.equal(byMonth.rows.length, 3, '月份过滤应含三个会话的行');

    const byKw = api.searchLedger(root, { keyword: '00000002' });
    assert.equal(byKw.rows.length, 1);
    assert.equal(byKw.rows[0].turn, 2);

    assert.equal(api.searchLedger(root, { sid: SID, limit: 1 }).truncated, true, '截断要如实报');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/ledgerapi：getTurn 返回台账行 + 原文位置 + 开头片段；getContext 取最近 N 轮', () => {
  const { base, root } = makeLab();
  try {
    const hit = api.getTurn(root, '20261108-75238718e41a-A-00000001');
    assert.equal(hit.ok, true);
    assert.equal(hit.row.turn, 1);
    assert.equal(hit.original.exists, true, '原文文件应存在');
    assert.match(hit.excerpt, /你好/, '应读到正文开头');
    assert.equal(hit.row.bound, true, '三哈希 + 附件齐 → bound=true');

    const miss = api.getTurn(root, '20261108-75238718e41a-A-00000099');
    assert.equal(miss.ok, false);
    assert.equal(miss.reason, 'not-found');

    const ctx = api.getContext(root, { sid: SID, turns: 1 });
    assert.equal(ctx.ok, true);
    assert.equal(ctx.rows.length, 1);
    assert.equal(ctx.lastTurn, 2, '最近一轮应是 turn=2');
    assert.equal(ctx.hasMore, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ★ V1.0 / 准入审计 P1-08（新增用例）：excerptBytes 必须有硬上限。
//   旧行为：审计实测一次 ledger_turn{excerptBytes: 超大值} 返回 307,205 字符全文（与"不整篇塞上下文"相反）；
//   新行为：上限 EXCERPT_MAX_BYTES=65536，超限截断并标 excerptCapped。
test('V1.0/P1-08：getTurn 的 excerptBytes 有硬上限 65536（超限截断 + excerptCapped 标记）', () => {
  const { base, root } = makeLab();
  try {
    const row1 = mkRow(1);
    const abs = path.join(root, row1.doc);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'A'.repeat(200 * 1024), 'utf8'); // 200 KiB 长文

    assert.equal(api.EXCERPT_MAX_BYTES, 65536, '硬上限必须是 65536（与面板 LIMITS.excerptBytes.hi 同口径）');

    const big = api.getTurn(root, row1.code, { excerptBytes: 300000 });
    assert.equal(big.ok, true);
    assert.equal(big.excerpt.length, api.EXCERPT_MAX_BYTES, '超过上限按上限截断');
    assert.equal(big.excerptBytes, api.EXCERPT_MAX_BYTES, '回显实际生效的字节数');
    assert.equal(big.excerptCapped, true, '必须标记"被硬上限截过"');
    assert.equal(big.excerptTruncated, true, '原文比片段长 → truncated');

    const edge = api.getTurn(root, row1.code, { excerptBytes: api.EXCERPT_MAX_BYTES });
    assert.equal(edge.excerpt.length, api.EXCERPT_MAX_BYTES);
    assert.equal(edge.excerptCapped, false, '正好等于上限不算被截');

    const dflt = api.getTurn(root, row1.code);
    assert.equal(dflt.excerpt.length, 800, '默认仍为 800');
    assert.equal(dflt.excerptCapped, false);

    const zero = api.getTurn(root, row1.code, { excerptBytes: 0 });
    assert.equal(zero.excerpt, '', '0 = 只给路径（行为不变）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('AG-05b 越界拒绝：台账行 doc 逃出 root 时不得读取（穿越防护）', () => {
  // 2026-11-11 外部审计预备探针查出的真问题：
  //   台账行的 doc 是**数据**。写成 `..\secret.txt` 时，旧实现会 path.join 出去、
  //   把库外文件的开头当"原文片段"返回给模型。本用例把这条边界钉死。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerapi-esc-'));
  const root = path.join(base, 'root');
  const led = path.join(root, 'ledger');
  fs.mkdirSync(led, { recursive: true });
  try {
    // ① 库外机密文件
    const secret = path.join(base, 'secret.txt');
    fs.writeFileSync(secret, 'SECRET-OUTSIDE-ROOT-7f3a9c\n', 'utf8');

    // ② 第一行：doc 越界，但**规范路径**下确实有原文 → 应回落到规范路径
    const code1 = '20261108-75238718e41a-A-00000001';
    const row1 = { ...mkRow(1), doc: '..\\secret.txt' };
    // ③ 第二行：doc 越界，且规范路径下也没有原文 → exists=false、excerpt 为空
    const code2 = '20261108-75238718e41a-A-00000002';
    const row2 = { ...mkRow(2), doc: '..\\..\\secret.txt' };
    fs.writeFileSync(path.join(led, '2026-11-08.jsonl'),
      [row1, row2].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // 规范路径口径必须与 lib/original.js 的 originalDir/originalRelPath 一致：
    //   <root>\YYYY年MM月\MM月总“完整原文”\<code> 完整原文.md
    const canonDir = path.join(root, '2026年11月', '11月总“完整原文”');
    fs.mkdirSync(canonDir, { recursive: true });
    fs.writeFileSync(path.join(canonDir, `${code1} 完整原文.md`), '# 第一轮\n\nCANON-OK 正牌原文\n', 'utf8');

    const hit1 = api.getTurn(root, code1);
    assert.equal(hit1.ok, true);
    assert.equal(hit1.original.exists, true, '应回落到规范路径下的原文');
    assert.match(hit1.excerpt, /CANON-OK/, '读到的必须是库内原文');
    assert.equal(hit1.excerpt.includes('SECRET'), false, '绝不能读出库外内容');
    assert.equal(hit1.original.rejected.some((r) => r.reason === 'outside-root'), true, '越界候选必须留痕');

    const hit2 = api.getTurn(root, code2);
    assert.equal(hit2.ok, true, '行存在，ok 仍为 true');
    assert.equal(hit2.original.exists, false, '库外文件不得被当成原文');
    assert.equal(hit2.excerpt, '', '不得返回库外片段');
    assert.equal(JSON.stringify(hit2.original).includes('SECRET'), false);
    assert.equal(hit2.original.rejected.some((r) => r.reason === 'outside-root'), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/ledgerapi：调用前后全库 sha256 集合完全不变（只读硬断言）', () => {
  const { base, root } = makeLab();
  try {
    const before = snapshot(root);
    api.searchLedger(root, { sid: SID });
    api.searchLedger(root, { month: '2026-11' });
    api.getTurn(root, '20261108-75238718e41a-A-00000001');
    api.getTurn(root, '不存在的编码');
    api.getContext(root, { sid: SID, turns: 10 });
    api.summarize(root);
    const after = snapshot(root);
    assert.deepEqual(after, before, '只读层不许改动任何文件（含 repairTornTail 之类的顺手修复）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('V0.6/ledgerapi：summarize 报坏行/读取错误，不把读不全当空', () => {
  const { base, root } = makeLab();
  try {
    fs.appendFileSync(path.join(root, 'ledger', '2026-11-08.jsonl'), '{坏行\n', 'utf8');
    const s = api.summarize(root);
    // 撕裂尾巴自愈**未开启**：坏行必须如实计数，不能被静默修掉；
    // 且"读不全"不许变成"空白"——面板要知道这库有问题。
    assert.equal(s.ledgerOk, false, '有坏行时 ledgerOk 必须为 false');
    assert.equal(s.badLines, 1, `坏行应计 1（实际 ${s.badLines}）`);
    assert.equal(s.readErrors >= 1, true, '坏行也必须进 readErrors（CH-04）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
