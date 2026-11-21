/**
 * @file 自测-reconcile.mjs
 * @role 单元/集成自测：lib/reconcile.js（只报不修）+ freeze/selfheal.js（只补不改账）。
 * @why 对账/自愈是"账实不符能不能被看见"的最后一道闸。三条最容易退化的性质：
 *      ① reconcile **纯只读**（前后整棵 root 的文件名/大小/mtime/sha256 完全不变）；
 *      ② selfheal 只做白名单（补目录；草稿周账只返回动作；封板缺文件/凭证缺只报不改）；
 *      ③ 运行报告 counts 与数组长度自洽（可被脚本断言）。
 *
 * 写盘纪律：全部临时目录（%TEMP%\dl-recon-*），≤1.5 MB 素材，跑完整棵删除。
 * 运行：node --test docs/自测-reconcile.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { appendTurn, readAll, lostPath } from '../lib/ledger.js';
import { appendSealEvent, verifySealChain } from '../lib/sealjournal.js';
import { weekOf, weeklyFileName, weeklyFolderName } from '../lib/week.js';
import { originalRelPath, renderOriginal, writeOriginal } from '../lib/original.js';
import { groupRecords } from '../lib/weekly.js';
import { reconcile, formatReconcileReport, checkReceiptChain, listArchiveFiles } from '../lib/reconcile.js';
import { scan, repair, writeRunReport } from '../freeze/selfheal.js';
import { appendLegacyMarks, readLegacyMarks, rowFingerprint, legacyMarksPath } from '../freeze/legacy-marks.js';

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const TS1 = '2026-11-08T10:00:00+08:00';
const TS2 = '2026-11-08T11:00:00+08:00';
const CODE_A = '20261108-75238718e41a-A-00000001';
const CODE_B = '20261108-75238718e41a-A-00000002';
const CODE_ORPHAN = '20261108-75238718e41a-A-00000009';

/** 建一个"父临时目录"，内含 root/ 与 anchor/。 */
function withWork(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-recon-'));
  const root = path.join(base, 'root');
  const anchor = path.join(base, 'anchor');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(anchor, { recursive: true });
  try {
    return fn({ base, root, anchor });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 快照整棵目录：相对路径 → {type,size,mtimeMs,sha256}（只读性断言用）。 */
function snapshot(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const relP = rel ? path.join(rel, e.name) : e.name;
      const st = fs.statSync(p);
      if (e.isDirectory()) {
        out[relP] = { type: 'dir', mtimeMs: Math.trunc(st.mtimeMs) };
        walk(p, relP);
      } else {
        out[relP] = { type: 'file', size: st.size, mtimeMs: Math.trunc(st.mtimeMs), sha256: sha(p) };
      }
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

/**
 * 一条台账记录（形状与 index.js 写的一致）。
 * `extra` 用来补 v0.5 CH-01 的绑定证据（docSha256 / docFileSha256 / attachment）；
 * 不传 → 就是"旧 v0.4 行"（只有 doc 指针，按契约永远不得 bound）。
 */
function record(code, ts, doc, extra = {}) {
  return {
    v: 3, code, ts, sid: SID, turn: Number(code.slice(-1)), seq: Number(code.slice(-1)),
    status: 'ok', src: 'session.v4.jsonl.zstd',
    doc, docHash: extra.docSha256 || 'a'.repeat(64),
    ...extra,
  };
}

/**
 * 造一份**真正合法**的完整原文（含 YAML 身份字段 + 原始事件附件），并返回台账应记的证据字段。
 * @why v0.5 CH-01：`绑定` 要求 docSha256 + docFileSha256 + attachment 三样齐全且可复算。
 *      旧夹具有 `writeView()` 手搓一个只有 `编码:` 的 md，`verifyOriginal` 必失败，
 *      于是任何"干净账库"都只能报缺凭证 —— 测试与契约脱节，红的是夹具不是实现。
 * @returns {{doc:string, docSha256:string, docFileSha256:string, attachment?:{name:string,sha256:string,bytes:number}}}
 */
function writeRealVoucher(root, code, ts, { withAttachment = true } = {}) {
  const ms = Date.parse(ts);
  const w = weekOf(ms, 480);
  const events = [
    { seq: 1, type: 'turn/start', time: ms, data: { turn: 1 } },
    { seq: 2, type: 'user/message', time: ms + 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '原文' }] } },
    { seq: 3, type: 'turn/end', time: ms + 2000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const rendered = renderOriginal({
    events,
    turn: { turn: 1, startMs: ms, endMs: ms + 2000, reason: 'completed' },
    code, sid: SID, sessKey: '75238718e41aA', seq: Number(code.slice(-1)),
    offsetMinutes: 480,
  });
  const doc = writeOriginal({
    root, y: w.year, m: w.month, code,
    markdown: rendered.markdown,
    bodyHash: rendered.bodyHash,
    fullHash: rendered.fullHash,
    attachment: withAttachment ? rendered.attachment : undefined,
  });
  const out = { doc: doc.rel, docSha256: doc.bodyHash, docFileSha256: doc.fullHash };
  if (doc.attachment) {
    out.attachment = { name: doc.attachment.name, sha256: doc.attachment.sha256, bytes: doc.attachment.bytes };
  }
  return out;
}

/** 写一份最小的"完整原文"视图文件；返回相对 root 的路径。 */
function writeView(root, rec) {
  const ms = Date.parse(rec.ts);
  const w = weekOf(ms, 480);
  const rel = originalRelPath(w.year, w.month, rec.code);
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\n编码: '${rec.code}'\n---\n\n# ${rec.code} 完整原文\n\n## 1. user/message\n\n原文\n`, 'utf8');
  return rel;
}

/** 写一份"假 xlsx"（对账只判存在，不读内容）。 */
function writeWeeklyStub(root, gid, file) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'fake-xlsx-bytes');
}

/** 建"台账 + 两份凭证 + 周账"的基础场景（A 有凭证、B 缺凭证、另有孤儿）。 */
function buildBase({ root, withOrphan = true, withLost = false, bindB = false } = {}) {
  const known = new Set();
  // ★ A 必须是**真绑定**（有完整证据），否则"干净账库"按 CH-01 只能是缺凭证。
  const evA = writeRealVoucher(root, CODE_A, TS1);
  const recA = record(CODE_A, TS1, evA.doc, evA);
  const relB = originalRelPath(...Object.values(weekOf(Date.parse(TS2), 480)).slice(0, 2), CODE_B);
  // B 默认只记台账、不落盘 → 用于"缺凭证"场景；bindB=true 时也造成真绑定。
  let recB;
  if (bindB) {
    const evB = writeRealVoucher(root, CODE_B, TS2);
    recB = record(CODE_B, TS2, evB.doc, evB);
  } else {
    recB = record(CODE_B, TS2, relB);
  }
  assert.equal(appendTurn(root, recA, known).ok, true);
  known.add(CODE_A);
  assert.equal(appendTurn(root, recB, known).ok, true);
  known.add(CODE_B);
  const groups = groupRecords([recA, recB], 480);
  for (const gid of groups.keys()) {
    const g = groups.get(gid);
    writeWeeklyStub(root, gid, path.join(weeklyFolderName(g.w), weeklyFileName(g.w, g.sessKey)));
  }
  if (withOrphan) {
    const w = weekOf(Date.parse(TS1), 480);
    const rel = originalRelPath(w.year, w.month, CODE_ORPHAN);
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'orphan view\n', 'utf8');
  }
  if (withLost) {
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    const l1 = JSON.stringify({ v: 1, at: '2026-11-08 10:00:00', sid: SID, sessDir: 'x', file: 'x', failedFrames: 1, badLines: 0, reasons: ['failed-frames'], missing: [{ start: 0, end: 10, bytes: 10, sha256: 'a'.repeat(64) }] });
    const l2 = JSON.stringify({ v: 1, at: '2026-11-08 11:00:00', sid: SID, sessDir: 'x', file: 'x', failedFrames: 0, badLines: 2, reasons: ['bad-lines'], missing: [] });
    fs.writeFileSync(lostPath(root), l1 + '\n' + l2 + '\n', 'utf8');
  }
  return { recA, recB, relA: recA.doc, relB };
}

test('reconcile：缺一份原文 → originalMissing 命中且 ok=false；只读性：整棵 root 前后完全不变', () => {
  // 守（RC 判据 + task-11 硬判据）：对账"只报不修"，且**任何**字节/mtime 变化都算破约。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: false, withLost: false });
    // 让基础场景"干净"：补齐 B 的凭证 → ok 应为 true（先证明正向）
    const before = snapshot(root);
    const r1 = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r1.ledgerRows, 2);
    assert.equal(r1.codeUnique, true);
    assert.equal(r1.sidTurnUnique, true);
    assert.equal(r1.originalMissing.length, 1);
    assert.equal(r1.originalMissing[0].code, CODE_B);
    assert.equal(r1.originalMissing[0].part, 'view');
    assert.equal(r1.ok, false, '缺凭证 → 账实不符 → ok 必须 false');
    assert.equal(r1.okStrict, false, 'okStrict = ok 且 ledgerOk 且两个唯一性');
    // 契约 RC-01 的 ok 公式（逐字 6 项，不含 ledgerOk/唯一性）
    assert.equal(r1.ok,
      r1.originalMissing.length === 0 && r1.originalOrphan.length === 0 &&
      r1.weeklyGroupsMissing.length === 0 && r1.lostGaps.count === 0 &&
      r1.receiptBreakCount === 0 && r1.sealChain.ok === true);
    assert.equal(r1.receiptBreakCount, r1.receiptBreaks.length);
    // 文本报告可读
    const text = formatReconcileReport(r1);
    assert.match(text, /FAIL/);
    assert.match(text, /缺凭证/);
    // 只读性：文件名/大小/mtime/sha256 完全一致，且没有多出/少掉任何节点
    const after = snapshot(root);
    assert.deepEqual(after, before, 'reconcile 不得改动整棵 root 的任何字节/mtime');
  });
});

test('reconcile：无台账的原文 → originalOrphan 命中；清册已删除的凭证不算缺', () => {
  // 守：孤儿凭证（有凭证没账）与"合法清理"必须分开，否则清册一用就全线飘红。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: true, withLost: false });
    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.originalOrphan.length, 1);
    assert.equal(r.originalOrphan[0].code, CODE_ORPHAN);
    assert.match(r.originalOrphan[0].file, /完整原文\.md$/);
    assert.equal(r.ok, false);

    // 写一份清册：声明 CODE_B 已删除 → B 不再算"缺凭证"（四态：已清理）
    fs.writeFileSync(
      path.join(root, 'RPT-20261108-01.md'),
      '| # | 编码 | 产生时间 | 结论 | 备注 |\n|---|---|---|---|---|\n' +
      `| 1 | ${CODE_B} | 2026-11-08 11:00:00 | 已删除 | 测 |\n`,
      'utf8'
    );
    const r2 = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.deepEqual(r2.originalMissing.filter((m) => m.code === CODE_B), []);
  });
});

test('reconcile 两态：正式名缺失但草稿在 → weeklyGroupsMissing=0 且 weeklyGroupsDraftOnly 命中（WK-S4 守护）', () => {
  // 守（V0.7 两态）：草稿存在 ≠ 已出周账（不满足"周账已出"），但也**不是缺失**；
  //   对账必须把"待封板草稿"单列 draftOnly，不能逼人去重建/报警。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: false, withLost: false, bindB: true });
    const groups = groupRecords([record(CODE_A, TS1, '')].slice(0, 0), 480); // 占位：真实 groups 用 recA/recB 重建
    const { recA, recB } = buildBase({ root: root, withOrphan: false, withLost: false, bindB: true });
    const gs = groupRecords([recA, recB], 480);
    // 把"正式名 stub"改成"草稿名 stub"：模拟未封板的两态现场
    for (const [, g] of gs) {
      const dir = path.join(root, weeklyFolderName(g.w));
      const official = path.join(dir, weeklyFileName(g.w, g.sessKey));
      const draft = path.join(dir, '草稿-' + weeklyFileName(g.w, g.sessKey));
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(official)) fs.rmSync(official);
      fs.writeFileSync(draft, 'fake-xlsx-bytes');
    }
    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.weeklyGroupsMissing.length, 0, '草稿在 → 不得记缺失: ' + JSON.stringify(r.weeklyGroupsMissing));
    assert.equal(Array.isArray(r.weeklyGroupsDraftOnly), true, '必须暴露 weeklyGroupsDraftOnly');
    assert.equal(r.weeklyGroupsDraftOnly.length, gs.size, '每个待封板草稿组都要单列');
    assert.ok(r.weeklyGroupsDraftOnly.every((x) => String(x.draft).includes('草稿-')), 'draftOnly 必须指向草稿文件');
  });
});

test('reconcile：删草稿周账 → weeklyGroupsMissing；.lost 2 条 → lostGaps.count=2', () => {
  // 守：三数（账/凭证/周账）+ 缺口都要能被看见；lostGaps 计数必须与 .lost.jsonl 行数一致。
  withWork(({ root }) => {
    const { recA, recB } = buildBase({ root, withOrphan: false, withLost: true });
    const groups = groupRecords([recA, recB], 480);
    for (const [gid, g] of groups) {
      fs.rmSync(path.join(root, weeklyFolderName(g.w), weeklyFileName(g.w, g.sessKey)));
    }
    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.weeklyGroupsExpected.length, groups.size);
    assert.equal(r.weeklyGroupsMissing.length, groups.size);
    assert.equal(r.lostGaps.count, 2);
    assert.equal(r.lostGaps.recordsTail.length, 2);
    assert.equal(r.ok, false);
  });
});

test('selfheal：删月份目录 → scan 检出、repair 只 mkdir（不产生任何文件）', () => {
  // 守（D5 白名单）：目录缺是唯一允许"自动补"的；补目录不得顺带写任何文件。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: false, withLost: false });
    const before = snapshot(root);
    const relA = Object.keys(before).find((k) => k.includes('月总“完整原文”') && k.endsWith('完整原文.md'));
    assert.ok(relA);
    const originalDirRel = path.dirname(relA);
    const monthDirRel = path.dirname(originalDirRel);
    fs.rmSync(path.join(root, originalDirRel), { recursive: true, force: true });

    const sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    const kinds = sc.dirMissing.map((d) => d.kind);
    assert.ok(kinds.includes('original'));
    assert.ok(sc.dirMissing.some((d) => d.dir === originalDirRel));

    const rep = repair(sc, { root });
    assert.equal(rep.ok, true);
    assert.ok(rep.repaired.some((x) => x.type === 'mkdir' && x.dir === originalDirRel));
    // 目录回来了；但**没有**多出任何文件（原文件不该被自愈"重建"）
    assert.equal(fs.statSync(path.join(root, originalDirRel)).isDirectory(), true);
    const after = snapshot(root);
    const newFiles = Object.keys(after).filter((k) => after[k].type === 'file' && !(k in before));
    assert.deepEqual(newFiles, [], 'repair 不得产生任何新文件');
  });
});

test('selfheal：草稿周账缺 → 只返回 writeWeekly 动作（自己不写 xlsx）；封板缺 → 只报不改', () => {
  // 守：自愈器不能成为"第二个写者"；封板即事实，缺文件只能报。
  withWork(({ root }) => {
    const { recA, recB } = buildBase({ root, withOrphan: false, withLost: false });
    const groups = groupRecords([recA, recB], 480);
    const [gid, g] = [...groups.entries()][0];
    const xlsx = path.join(root, weeklyFolderName(g.w), weeklyFileName(g.w, g.sessKey));
    fs.rmSync(xlsx);
    let sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.ok(sc.weeklyDraftMissing.some((x) => x.gid === gid));
    let rep = repair(sc, { root });
    assert.ok(rep.actions.some((a) => a.type === 'writeWeekly' && a.gid === gid));
    assert.equal(fs.existsSync(xlsx), false, 'repair 不得自己写 xlsx');

    // 封板证据存在 → sealedBookMissing，且 repair 归 reported、不产生动作
    const w = g.w;
    const seal = appendSealEvent(root, {
      kind: 'weekly-seal', key: gid, gid, file: path.join(weeklyFolderName(w), weeklyFileName(w, g.sessKey)),
      sealedAt: '2026-11-08 12:00:00', layoutVersion: 6, sessKey: g.sessKey,
      year: w.year, month: w.month, weekNo: w.weekNo, offsetMinutes: 480,
      sourceRowCount: 2, overflow: 0,
      rows: [[CODE_A, '绑定', '10:00', '已完成'], [CODE_B, '缺凭证', '11:00', '已完成']],
      supplementCodes: [],
    });
    assert.equal(seal.ok, true);
    sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.ok(sc.sealedBookMissing.some((x) => x.gid === gid && x.source === 'journal'));
    rep = repair(sc, { root });
    assert.ok(rep.reported.some((x) => x.type === 'sealed-book-missing' && x.gid === gid));
    assert.equal(rep.actions.some((a) => a.type === 'writeWeekly' && a.gid === gid), false);
    assert.equal(fs.existsSync(xlsx), false, '封板缺文件绝不重建');
  });
});

test('selfheal：凭证缺只进 reported（不重建、不改文件）', () => {
  // 守：完整原文是原始凭证，不可变（P0-7）；自愈只能报缺。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: false, withLost: false });
    const before = snapshot(root);
    const sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.ok(sc.voucherMissing.some((x) => x.code === CODE_B && x.part === 'view'));
    const rep = repair(sc, { root });
    assert.ok(rep.reported.some((x) => x.type === 'voucher-missing' && x.code === CODE_B));
    assert.deepEqual(snapshot(root), before, '凭证缺的修复不得改动任何文件');
  });
});

test('selfheal（V0.6.2）：交接表封板缺失走双路径 —— 主表在 交接表/ 或一级都不误报；两处都没才报', () => {
  // 守：《v0.6.2-迁移规格-v1》§2.2 "读侧双路径兼容"。若只认一级，新布局写出的交接表
  //   会在下一轮自愈里被误报成"封板后主表缺失"—— 那是拿假告警逼人去重建一份**不能重建**的证据。
  withWork(({ root }) => {
    const KEY = 'abcdef123456A';
    const mainName = `${KEY}的记忆数据库的启用及交接表.md`;
    const appName = `${KEY}的记忆数据库的启用及交接表——附表.md`;
    // 新布局：主表在 `交接表/` 子目录（v0.6.2 写端默认落点）
    fs.mkdirSync(path.join(root, '交接表'), { recursive: true });
    fs.writeFileSync(path.join(root, '交接表', mainName), '# 主表\n', 'utf8');
    const ev = appendSealEvent(root, {
      kind: 'handover-seal', key: KEY, decision: 'generated',
      main: mainName, appendix: appName, file: mainName,
      sealedAt: '2026-11-08 12:00:00', sealHash: 'a'.repeat(64),
    });
    assert.equal(ev.ok, true, '先决条件：封板事件必须写下：' + JSON.stringify(ev));

    let sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.deepEqual(sc.handoverSealedMissing, [], '主表在 交接表/（新布局）时不得误报缺');

    // 老布局：同一个主表挪回一级（未迁移的老库）→ 同样不许误报
    fs.renameSync(path.join(root, '交接表', mainName), path.join(root, mainName));
    sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.deepEqual(sc.handoverSealedMissing, [], '主表在一级（老库，未迁移）时不得误报缺');

    // 两处都没有 → 必须报出来（只报不改），且 file 字段仍给出定位
    fs.rmSync(path.join(root, mainName));
    sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(sc.handoverSealedMissing.length, 1, '两处都没有时必须报缺');
    assert.equal(sc.handoverSealedMissing[0].key, KEY);
    assert.equal(sc.handoverSealedMissing[0].file, mainName);
    assert.equal(sc.handoverSealedMissing[0].source, 'journal', 'journal 是封板唯一权威');
  });
});

test('reconcile：收据链浅检 —— 正确链无断；改前日收据 → CHAIN_BREAK', () => {
  // 守（REC-2）：链断必须报出来；锚目录在 root 之外；浅检不重算 ledger hash。
  withWork(({ root, anchor }) => {
    buildBase({ root, withOrphan: false, withLost: false });
    const mk = (date, prevSha) => ({
      v: 1, date, offsetMinutes: 480, lastCode: CODE_B, ledgerRows: 2,
      ledgerBytes: 10, ledgerSha256: 'c'.repeat(64), originalCount: 1,
      prevReceiptSha256: prevSha, generatedAt: `${date} 23:59:59`,
    });
    const p1 = path.join(anchor, 'RECEIPT-20261108.json');
    fs.writeFileSync(p1, JSON.stringify(mk('2026-11-08', '')) + '\n', 'utf8');
    const p2 = path.join(anchor, 'RECEIPT-20261109.json');
    fs.writeFileSync(p2, JSON.stringify(mk('2026-11-09', sha(p1))) + '\n', 'utf8');

    const seenRoot = snapshot(root);
    const r = reconcile({ root, offsetMinutes: 480, receiptAnchorRoot: anchor, nowMs: 1794067200000 });
    assert.deepEqual(r.receiptBreaks, []);
    assert.equal(r.receiptBreakCount, r.receiptBreaks.length, 'R-03：receiptBreakCount == receiptBreaks.length');
    assert.deepEqual(snapshot(root), seenRoot, '读锚目录不得改动 root');

    // 篡改前一日收据 → 后一日 prevReceiptSha256 对不上
    fs.writeFileSync(p1, JSON.stringify(mk('2026-11-08', '')) + '\nX', 'utf8');
    const r2 = reconcile({ root, offsetMinutes: 480, receiptAnchorRoot: anchor, nowMs: 1794067200000 });
    assert.ok(r2.receiptBreaks.some((b) => b.reason === 'CHAIN_BREAK'), JSON.stringify(r2.receiptBreaks));
    assert.equal(r2.receiptBreakCount, r2.receiptBreaks.length);
    assert.equal(checkReceiptChain('').length, 0, '锚目录为空 = 功能关闭，不报错');
  });
});

test('reconcile：封板 journal 篡改 → sealChain.ok=false（只报不修）', () => {
  // 守（P1-9/CH-18）：journal 断链必须进对账结果；对账器不得修链。
  withWork(({ root }) => {
    const { recA, recB } = buildBase({ root, withOrphan: false, withLost: false });
    const groups = groupRecords([recA, recB], 480);
    const [gid, g] = [...groups.entries()][0];
    const w = g.w;
    appendSealEvent(root, {
      kind: 'weekly-seal', key: gid, gid, file: path.join(weeklyFolderName(w), weeklyFileName(w, g.sessKey)),
      sealedAt: '2026-11-08 12:00:00', layoutVersion: 6, sessKey: g.sessKey,
      year: w.year, month: w.month, weekNo: w.weekNo, offsetMinutes: 480,
      sourceRowCount: 2, overflow: 0, rows: [[CODE_A, '绑定', '10:00', '已完成']], supplementCodes: [],
    });
    assert.equal(verifySealChain(root).ok, true);
    const p = path.join(root, 'ledger', '.seal-journal.jsonl');
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const obj = JSON.parse(lines[0]);
    obj.prevSealSha256 = 'd'.repeat(64); // 伪造断链
    fs.writeFileSync(p, JSON.stringify(obj) + '\n', 'utf8');

    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.sealChain.ok, false);
    assert.equal(r.sealChain.lines, 1, 'R-03：sealChain.lines = journal 行数');
    assert.equal(r.sealChain.breaks.length, 1);
    assert.equal(r.sealChain.breaks[0].line, 1);
    assert.equal(r.sealChain.breaks[0].reason, 'PREV_SEAL_HASH_MISMATCH');
    assert.match(r.sealChain.breaks[0].actual, /^[0-9a-f]{64}$/);
    assert.equal(r.ok, false);
    assert.equal(verifySealChain(root).chainBroken, r.sealChain.chainBroken, '对账不得修链');
  });
});

test('selfheal.writeRunReport：日报原子写、counts 与数组长度自洽、时间 +08:00 无 Z', () => {
  // 守：运行报告是"最近一次跑成什么样"（可重算），不算档案；数字必须能被脚本断言。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: true, withLost: true });
    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    const sc = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    const rep = repair(sc, { root });
    const errors = [{ kind: 'FRAME_FAILED', source: 'sessions/x/session.v4.jsonl.zstd', offset: 0, fingerprint: 'e'.repeat(64), count: 7, lastAt: '2026-11-08 09:00:00', detail: 'failedFrames=1' }];
    const blockedSources = [{ source: 'sessions/x/session.v4.jsonl.zstd', kind: 'FRAME_FAILED', attempts: 7 }];
    const stuckSources = [];
    const w = writeRunReport({ root, result: r, scan: sc, actions: rep.actions, errors, blockedSources, stuckSources, nowMs: 1794067200000, offsetMinutes: 480 });
    assert.equal(w.ok, true);
    assert.match(path.basename(w.path), /^\.run-report-20261108\.json$/);
    const obj = JSON.parse(fs.readFileSync(w.path, 'utf8'));
    assert.equal(obj.v, 1);
    assert.equal(obj.at, '2026-11-08 00:00:00');
    assert.equal(obj.counts.originalMissing, obj.reconcile.originalMissing.length);
    assert.equal(obj.counts.originalOrphan, obj.reconcile.originalOrphan.length);
    assert.equal(obj.counts.weeklyGroupsMissing, obj.reconcile.weeklyGroupsMissing.length);
    assert.equal(obj.counts.lostGaps, obj.reconcile.lostGaps.count);
    assert.equal(obj.counts.dirMissing, obj.selfheal.dirMissing.length);
    assert.equal(obj.counts.voucherMissing, obj.selfheal.voucherMissing.length);
    assert.equal(obj.counts.actions, obj.actions.length);
    assert.equal(obj.counts.errors, obj.errors.length);
    assert.equal(obj.counts.blockedSources, obj.blockedSources.length);
    assert.equal(obj.counts.stuckSources, obj.stuckSources.length);
    assert.equal(obj.counts.ledgerEmptyProven, r.ledgerEmptyProven === true);
    // R-02：被节流掉的次数必须在 run-report 的 errors[].count 落账（不得静默丢）
    assert.equal(obj.errors[0].count, 7);
    assert.equal(obj.errors[0].fingerprint.length, 64);
    // 附录 A：errors[] 项形状固定（含 count/lastAt）
    assert.deepEqual(Object.keys(obj.errors[0]).sort(), [
      'count', 'detail', 'fingerprint', 'kind', 'lastAt', 'offset', 'source',
    ]);
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(JSON.stringify(obj)), false, '产物不得出现 Z 时间');
    // 同日再跑一次 → 仍是同一个文件（原子覆盖，不追加）
    const w2 = writeRunReport({ root, result: r, scan: sc, actions: [], nowMs: 1794067200000, offsetMinutes: 480 });
    assert.equal(w2.path, w.path);
    assert.equal(fs.readdirSync(path.join(root, 'ledger')).filter((n) => n.startsWith('.run-report-')).length, 1);
  });
});

test('reconcile：干净账库 → ok=true（正向证据；否则上面的 FAIL 没有意义）', () => {
  // 守：判据必须能"变绿"，否则全是假红等于没判据。
  withWork(({ root }) => {
    // A、B 两份凭证都造齐（真绑定）→ 一个"干净账库"必须能绿
    buildBase({ root, withOrphan: false, withLost: false, bindB: true });
    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.deepEqual(r.originalMissing, []);
    assert.deepEqual(r.originalOrphan, []);
    assert.deepEqual(r.weeklyGroupsMissing, []);
    assert.equal(r.lostGaps.count, 0);
    assert.deepEqual(r.receiptBreaks, []);
    assert.equal(r.sealChain.ok, true);
    assert.equal(r.sealChain.lines, 0, '空册 = 0 行且 ok（不是断链）');
    assert.equal(r.ok, true, formatReconcileReport(r));
    assert.equal(r.okStrict, true, '干净库：ok 与 okStrict 都应为 true');
    // 目录列表 API 只读且不抛错
    assert.ok(listArchiveFiles(root).length >= 2);
  });
});

test('R-01：originalMissing[].part 三态 —— 同 code 只 1 条；both/attachment 正确，v0.4 旧行只会 view', () => {
  // 守（契约 R-01）：视图+附件都缺 → "both"；只缺一 → 对应值；同一 code 绝不重复出条目；
  //   v0.4 旧行没有 attachment 字段 → 只可能 "view"（其附件不追究）。
  withWork(({ root }) => {
    const code = '20261108-75238718e41a-A-00000003';
    // ★ 必须是**真绑定**（视图合法 + 三哈希齐 + 附件在），否则 resolveDoc 先判视图缺，
    //   三态永远退化成 view/both，测不出"只缺附件"这一档。
    const ev = writeRealVoucher(root, code, TS1);
    const rec = record(code, TS1, ev.doc, ev);
    assert.equal(appendTurn(root, rec, new Set()).ok, true);
    const full = path.join(root, ev.doc);
    const attName = ev.attachment.name;
    const w = weekOf(Date.parse(TS1), 480);

    // 只缺附件 → part='attachment'，且只有 1 条
    fs.rmSync(path.join(path.dirname(full), attName));
    let r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    let hit = r.originalMissing.filter((m) => m.code === code);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].part, 'attachment');
    assert.match(hit[0].doc, /原始事件\.json$/);

    // 视图也缺 → part='both'，仍然只有 1 条
    fs.rmSync(full);
    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    hit = r.originalMissing.filter((m) => m.code === code);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].part, 'both');

    // v0.4 旧行（无 attachment 字段）缺视图 → 只能报 'view'
    assert.equal(appendTurn(root, record(CODE_B, TS2, originalRelPath(w.year, w.month, CODE_B)), new Set()).ok, true);
    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    const hb = r.originalMissing.find((m) => m.code === CODE_B);
    assert.equal(hb.part, 'view');
  });
});
test('AC-V05-RC-12：run-report 的 reconcile 段与直接调用 reconcile() 逐项相等；同日二次=1 份且为第二次', () => {
  // 守（契约 RC-12）：运行报告是"对账结果的落盘副本"，不能因为归一化/截断/追加而变样；
  //   同日重跑只保留 1 份、内容 = 第二次（原子覆盖，不追加、不残留 .tmp）。
  // 比较口径：数组按稳定键排序、忽略时间字段（at/lastAt）；其余逐项相等。
  withWork(({ root }) => {
    buildBase({ root, withOrphan: true, withLost: true });
    const scrub = (v) => {
      if (Array.isArray(v)) return v.map(scrub).sort((a, b) => {
        const sa = JSON.stringify(a); const sb = JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) {
          if (k === 'at' || k === 'lastAt') continue; // 忽略时间字段
          out[k] = scrub(v[k]);
        }
        return out;
      }
      return v;
    };
    const reportDir = path.join(root, 'ledger');
    const r1 = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    const sc1 = scan({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    const w1 = writeRunReport({ root, result: r1, scan: sc1, actions: [], nowMs: 1794067200000, offsetMinutes: 480 });
    assert.equal(w1.ok, true);
    const obj1 = JSON.parse(fs.readFileSync(w1.path, 'utf8'));
    assert.deepEqual(scrub(obj1.reconcile), scrub(r1), '报告 reconcile 段必须与直接调用结果逐项相等');

    // 改一个事实（多一份孤儿凭证）+ 换时间 → 同日二次写
    const w = weekOf(Date.parse(TS1), 480);
    const orphanRel = originalRelPath(w.year, w.month, '20261108-75238718e41a-A-00000010');
    fs.mkdirSync(path.join(root, path.dirname(orphanRel)), { recursive: true });
    fs.writeFileSync(path.join(root, orphanRel), 'second orphan\n', 'utf8');
    const r2 = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 + 60000 });
    assert.equal(r2.originalOrphan.length, 2, '第二次对账必须看到新事实');
    assert.notDeepEqual(scrub(r2), scrub(r1));
    const w2 = writeRunReport({ root, result: r2, scan: sc1, actions: [], nowMs: 1794067200000 + 60000, offsetMinutes: 480 });
    assert.equal(w2.path, w1.path, '同一天只允许一份运行报告');
    const names = fs.readdirSync(reportDir).filter((n) => n.startsWith('.run-report-'));
    assert.deepEqual(names, ['.run-report-20261108.json'], '不得残留第二份或 .tmp');
    const obj2 = JSON.parse(fs.readFileSync(w2.path, 'utf8'));
    assert.deepEqual(scrub(obj2.reconcile), scrub(r2), '报告内容必须是第二次的结果');
    assert.equal(obj2.counts.originalOrphan, r2.originalOrphan.length);
  });
});
// ============================================================================
// W5 / D18（V0.6 修正）：legacy 必须由**基线正面标记**，不能靠"缺字段"判定
// ============================================================================
test('W5：无证据行未标记 → 按缺凭证计；经 legacy 基线标记后才单列、不压 ok', () => {
  // 守（D18 修正）：D18 初版按"缺证据字段"判定 legacy → 删字段即可洗白（已实证）。
  //   正确口径：只有被 `<root>/ledger/.legacy-marks.jsonl` 标记过、且行指纹未变的行才算 legacy；
  //   未标记的无证据行 = "证据可能被删过" → 仍按缺凭证计（压 ok）。
  withWork(({ root }) => {
    const ev = writeRealVoucher(root, CODE_A, TS1);
    // 历史行形状：只有 doc 指针，没有三哈希/附件
    const rec = {
      v: 3, code: CODE_A, ts: TS1, sid: SID, turn: 1, seq: 1, status: 'ok',
      turnState: 'closed', doc: ev.doc, docHash: 'a'.repeat(64),
    };
    assert.equal(appendTurn(root, rec, new Set()).ok, true);

    // ① 未标记：必须按缺凭证计（不许洗白）
    let r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.legacyUnverifiable.some((m) => m.code === CODE_A), false,
      '未标记的无证据行不得进 legacyUnverifiable');
    const miss = r.originalMissing.find((m) => m.code === CODE_A);
    assert.ok(miss, '未标记的无证据行必须进 originalMissing');
    assert.equal(miss.reason, 'NO_BINDING_EVIDENCE');
    assert.equal(r.legacyMarks.unmarked >= 1, true);
    assert.equal(r.ok, false, '未标记的无证据行必须压 ok');

    // ② 显式标记（可审计动作）后：才算 legacy、不压 ok
    const row = readAll(root, { repairTornTail: false }).records.find((x) => x.code === CODE_A);
    const wr = appendLegacyMarks(root, [{
      code: CODE_A, fingerprint: rowFingerprint(row), sid: SID, turn: 1, status: 'ok', nowMs: 1794067200000,
    }]);
    assert.equal(wr.ok, true);
    assert.equal(wr.appended, 1);
    assert.equal(fs.existsSync(legacyMarksPath(root)), true);
    const marks = readLegacyMarks(root);
    assert.equal(marks.ok, true);
    assert.equal(marks.chainOk, true);

    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.legacyUnverifiable.some((m) => m.code === CODE_A), true, '标记后才单列 legacy');
    assert.equal(r.originalMissing.filter((m) => m.code === CODE_A).length, 0);
    assert.equal(r.legacyMarks.matched, 1);
    assert.equal(r.legacyMarks.unmarked, 0);
    assert.equal(r.legacyUnverifiableCount, r.legacyUnverifiable.length);
    // ③ B 类要求：运行报告 counts 必须带 legacy 三键（"不隐藏"）
    const rr = writeRunReport({
      root, result: r, scan: scan({ root, offsetMinutes: 480, nowMs: 1794067200000 }),
      actions: [], nowMs: 1794067200000, offsetMinutes: 480,
    });
    assert.equal(rr.ok, true);
    const rep = JSON.parse(fs.readFileSync(rr.path, 'utf8'));
    assert.equal(rep.counts.legacyUnverifiable, 1, '运行报告必须带 legacyUnverifiable');
    assert.equal(rep.counts.legacyUnmarkedNoEvidence, 0);
    assert.equal(rep.counts.legacyMarksChainOk, true);
  });
});

test('W5b（反伪装）：把一条带证据的 v0.5 行删字段伪装 legacy → 必须仍按缺凭证计', () => {
  // 守：这是 2026-11-10 实证过的攻击面（删掉 docFileSha256/docSha256/attachment 即可洗白）。
  //   修法后：没有基线标记的"无证据行"一律按缺凭证计，删字段不能洗白。
  withWork(({ root }) => {
    const ev = writeRealVoucher(root, CODE_B, TS1);
    const full = {
      v: 3, code: CODE_B, ts: TS1, sid: SID, turn: 1, seq: 2, status: 'ok', turnState: 'closed',
      doc: ev.doc, docSha256: ev.docSha256, docFileSha256: ev.docFileSha256,
      ...(ev.attachment ? { attachment: ev.attachment } : {}),
    };
    assert.equal(appendTurn(root, full, new Set()).ok, true);
    let r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.originalMissing.filter((m) => m.code === CODE_B).length, 0, '带证据的行应是 bound');

    // 攻击：把台账行改写成"v0.4 形状"（删掉所有绑定证据字段）
    const ledgerDir = path.join(root, 'ledger');
    const dayFile = fs.readdirSync(ledgerDir).find((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    const p = path.join(ledgerDir, dayFile);
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const stripped = {
      v: 3, code: CODE_B, ts: TS1, sid: SID, turn: 1, seq: 2, status: 'ok',
      doc: ev.doc, docHash: 'a'.repeat(64),
    };
    fs.writeFileSync(p, lines.map((l) => {
      const o = JSON.parse(l);
      return o.code === CODE_B ? JSON.stringify(stripped) : l;
    }).join('\n') + '\n', 'utf8');

    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.legacyUnverifiable.some((m) => m.code === CODE_B), false, '删字段不得洗成 legacy');
    const miss = r.originalMissing.find((m) => m.code === CODE_B);
    assert.ok(miss, '伪装行必须按缺凭证计');
    assert.equal(miss.reason, 'NO_BINDING_EVIDENCE');
    assert.equal(r.legacyMarks.unmarked >= 1, true);
    assert.equal(r.ok, false, '攻击后 ok 必须为 false');
  });
});

test('W5c：基线标记后行被改动（指纹不符）→ 按缺凭证计并计数 mismatched', () => {  withWork(({ root }) => {
    const ev = writeRealVoucher(root, CODE_A, TS1);
    const rec = {
      v: 3, code: CODE_A, ts: TS1, sid: SID, turn: 1, seq: 1, status: 'ok',
      turnState: 'closed', doc: ev.doc, docHash: 'a'.repeat(64),
    };
    appendTurn(root, rec, new Set());
    const row = readAll(root, { repairTornTail: false }).records.find((x) => x.code === CODE_A);
    appendLegacyMarks(root, [{ code: CODE_A, fingerprint: rowFingerprint(row), sid: SID, turn: 1 }]);

    // 标记后改行（改 turnState）→ 指纹变
    const ledgerDir = path.join(root, 'ledger');
    const dayFile = fs.readdirSync(ledgerDir).find((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    const p = path.join(ledgerDir, dayFile);
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(p, lines.map((l) => {
      const o = JSON.parse(l);
      if (o.code !== CODE_A) return l;
      o.turnState = 'tampered';
      return JSON.stringify(o);
    }).join('\n') + '\n', 'utf8');

    const r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.legacyUnverifiable.some((m) => m.code === CODE_A), false, '指纹不符不得算 legacy');
    assert.equal(r.legacyMarks.mismatched, 1);
    const miss = r.originalMissing.find((m) => m.code === CODE_A);
    assert.ok(miss);
    assert.equal(r.ok, false);
  });
});

// ============================================================================
// re3（审计② P2-6 / P2-8）：可校验性诚实化 —— 报告形状不许暗示"已验"；
//   封板"删文件/删行"与"从未封板"必须可分；新语义进对账且不得假红。
// ============================================================================
test('reconcile（re3）：收据"未验"必须明说；journal 被删/行丢而 state 称已封板 → sealChain 红', () => {
  withWork(({ root }) => {
    const { recA, recB } = buildBase({ root, withOrphan: false, withLost: false, bindB: true });
    const groups = groupRecords([recA, recB], 480);
    const [gid, g] = [...groups.entries()][0];
    const w = g.w;
    const sealOf = (key, extra = {}) => appendSealEvent(root, {
      kind: 'weekly-seal', key, gid: key, file: path.join(weeklyFolderName(w), weeklyFileName(w, g.sessKey)),
      sealedAt: '2026-11-08 12:00:00', layoutVersion: 6, sessKey: g.sessKey,
      year: w.year, month: w.month, weekNo: w.weekNo, offsetMinutes: 480,
      sourceRowCount: 1, overflow: 0,
      rows: [[CODE_A, '绑定', '10:00', '已完成']], supplementCodes: [],
      ...extra,
    });

    // ① 空册（从未封板）：ok，但"没有可校验对象"必须如实标出；收据必须标"未校验"
    let r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.sealChain.ok, true);
    assert.equal(r.sealChain.verifiable, false);
    assert.equal(r.sealChain.journalExists, false);
    assert.equal(r.receiptsChecked, false, 'lite 不做收据链校验，必须如实标未验');
    assert.equal(r.receiptBreaks.length, 0);
    assert.equal(r.receiptBreakCount, 0);
    const t = formatReconcileReport(r);
    assert.equal(/收据链:\s*断\s*0/.test(t), false, '旧文案"收据链: 断 0"把"没验"说成"验过"（P2-6 同源失真）');
    assert.match(t, /收据摘要/);
    assert.match(t, /未校验/);

    // ② 正常封板事件（唯一写者 appendSealEvent）→ 可验；新增只读字段不得造成假红
    assert.equal(sealOf(gid).ok, true);
    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.sealChain.ok, true, '正常 journal 不得假红：' + JSON.stringify(r.sealChain.breaks));
    assert.equal(r.sealChain.verifiable, true);
    assert.equal(r.sealChain.journalExists, true);
    assert.equal(r.sealChain.events, 1);

    // ③ journal 被整个删掉，但 state 仍写着"已封板" → 必须红（旧实现两种形态都 ok，删不删一个样）
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', '.state.json'), JSON.stringify({
      weeklySealed: { [gid]: { sealedAt: '2026-11-08 12:00:00', sealHash: 'a'.repeat(64), file: 'x.xlsx', layout: 6, rows: 1 } },
    }) + '\n', 'utf8');
    fs.rmSync(path.join(root, 'ledger', '.seal-journal.jsonl'));
    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.sealChain.ok, false, 'journal 被删而 state 称已封板 = 证据缺失，必须红');
    assert.equal(r.sealChain.journalExists, false);
    assert.equal(r.sealChain.stateSealedCount, 1);
    assert.equal(r.sealChain.breaks.some((b) => b.reason === 'JOURNAL_MISSING_BUT_STATE_SEALED'), true,
      JSON.stringify(r.sealChain.breaks));
    assert.equal(r.ok, false, '封板链红必须压 ok');

    // ④ journal 还在但"某个已封板键的行"被删掉 → state 仍是库内唯一锚，必须红
    assert.equal(sealOf('another-gid').ok, true);
    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.sealChain.ok, false, '整行删除（state 仍记着）不得静默通过');
    assert.equal(r.sealChain.breaks.some((b) => b.reason === 'STATE_SEALED_BUT_JOURNAL_MISSING_KEY'), true,
      JSON.stringify(r.sealChain.breaks));

    // ⑤ 新语义（rowsSha256 缺失）必须进对账 breaks，且对账不得崩/修册
    const jp = path.join(root, 'ledger', '.seal-journal.jsonl');
    const obj = JSON.parse(fs.readFileSync(jp, 'utf8').trim());
    delete obj.rowsSha256;
    fs.writeFileSync(jp, JSON.stringify(obj) + '\n', 'utf8');
    const jb = fs.readFileSync(jp);
    r = reconcile({ root, offsetMinutes: 480, nowMs: 1794067200000 });
    assert.equal(r.sealChain.ok, false);
    assert.equal(r.sealChain.breaks.some((b) => b.reason === 'ROWS_SHA_MISSING'), true,
      JSON.stringify(r.sealChain.breaks));
    assert.deepEqual(fs.readFileSync(jp), jb, '对账不得修册（只报不修）');
  });
});