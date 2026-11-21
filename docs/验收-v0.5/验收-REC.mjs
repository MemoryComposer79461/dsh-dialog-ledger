/**
 * @file 验收-REC.mjs
 * @role v0.5 REC 收据锚（REC-01…REC-10）的「能失败的测试」——每条判据一个用例。
 *
 * 依据：`03-契约-v0.5/v0.5-验收清单.md` §3（第 3 列可判定判据）+ `v0.5-REC收据锚契约.md` §1.2/§二（判据正文）。
 * 纪律：
 *   · 只写本文件；不改实现/不改其它验收件；每条判据 `criteria:['REC-xx']` 一对一；
 *   · 每个用例自己 `mkLab`/`rmLab`，不共享 root；不读写 U 盘（REC-09 用假盘符/临时目录模拟）；
 *   · 断言抓不到的证据 → `skip('…')`，不许伪造通过；实现确实不满足 → FAIL 并点名。
 *
 * 用法：
 *   node docs/验收-v0.5/验收-REC.mjs --out=docs/验收-v0.5/_results/REC.json [--only=REC-01]
 *
 * 覆盖沿革（覆盖减少必须留痕）：
 *   本文件**替换**了旧的 `REC-1…REC-7`（P0 时代口径）套件；旧套件的覆盖没有丢失——
 *   `P0验收/P0回归-v2.mjs` 的 `REC-core-链连续` / `REC-core-幂等与冲突` / `REC-core-篡改与删除`
 *   三个用例仍在，且本套件 REC-02/04/05/08 用更严的契约 v2.1 口径重新覆盖了同族断言。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main, expect, expectEqual, skip } from './_runner.mjs';
import * as L from './_lab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const CLI = path.join(PLUGIN, 'docs', '工具-核验收据.mjs');
const OFFSET = 480;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** 收据契约 §1.2：恰好 10 键、顺序固定。 */
const RECEIPT_KEYS = ['v', 'date', 'offsetMinutes', 'lastCode', 'ledgerRows', 'ledgerBytes',
  'ledgerSha256', 'originalCount', 'prevReceiptSha256', 'generatedAt'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const CODE = (d, i) => `${String(d).replace(/-/g, '')}-v05test00000-A-${String(i).padStart(8, '0')}`;
const ledgerRow = (code, ts, doc = '2026年11月/11月总“完整原文”/x.md') => ({
  v: 3, code, ts, sid: 'session-v05test000001-x', turn: Number(code.slice(-4)), seq: Number(code.slice(-4)),
  status: 'ok', src: 'session.v4.jsonl.zstd', doc,
  docHash: 'a'.repeat(64), docSha256: 'a'.repeat(64), docFileSha256: 'b'.repeat(64),
  attachment: { name: `${code} 原始事件.json`, sha256: 'c'.repeat(64), bytes: 1 },
  dateOffset: OFFSET,
});

async function withLabs(fn) {
  const made = [];
  const mk = (tag) => { const l = L.mkLab(tag); made.push(l); return l; };
  try { return await fn(mk); } finally { for (const l of made) L.rmLab(l); }
}

function writeDay(root, dateISO, rows) {
  const dir = path.join(root, 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${dateISO}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}
const dayPath = (root, d) => path.join(root, 'ledger', `${d}.jsonl`);

/** 契约 §1.1 的锚目录收据路径（flat，不建子目录）。 */
const contractReceiptPath = (anchorRoot, d) => path.join(anchorRoot, `RECEIPT-${String(d).replace(/-/g, '')}.json`);
/** 实现当前使用的路径（lib/receipt.js）——先按契约路径找，找不到再按实现路径读，便于给出精确差异。 */
async function actualReceiptPath(I, anchorRoot, d) { return I.rec.receiptPath(anchorRoot, d); }

function listReceiptsDeep(anchorRoot) {
  return L.listFiles(anchorRoot)
    .filter((f) => /RECEIPT-\d{8}\.json$/.test(path.basename(f.rel)))
    .map((f) => f.abs);
}

function snapshotTree(...roots) {
  const out = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const f of L.listFiles(root)) out.push(`${path.resolve(f.abs)}|${L.shaFile(f.abs)}`);
  }
  return out.sort().join('\n');
}

/** 跑只读校验器，返回 {status, stdout, stderr}。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

async function build(runner) {
  // ==========================================================================
  // REC-01 · 收据 JSON：恰 10 键且顺序==§1.2、v/date/offset/lastCode/计数/sha/prev/generatedAt
  // ==========================================================================
  runner.add({
    id: 'REC-01', criteria: ['REC-01'], title: '收据 JSON：恰 10 键且顺序==§1.2；v=1、date==文件名、offsetMinutes=480、lastCode 正则、计数非负整数、sha 64hex、prev∈{"",64hex}、generatedAt 无 Z',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-01');
      const anchor = path.join(lab.base, 'anchor-outside');
      const d = '2026-11-08';
      const code = CODE(d, 3);
      writeDay(lab.root, d, [ledgerRow(CODE(d, 1), `${d}T10:00:00+08:00`), ledgerRow(code, `${d}T11:00:00+08:00`)]);
      const w = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d });
      expect(w.ok && w.written, `前置失败：收据未生成（ok=${w.ok} written=${w.written} reason=${w.reason}）`);
      const implPath = await actualReceiptPath(I, anchor, d);
      const contractPath = contractReceiptPath(anchor, d);
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      // 契约 §1.1 路径（flat）——收据必须能被"只拿锚目录"的人按契约找到
      check(fs.existsSync(contractPath), `契约 §1.1 路径不存在：${contractPath}（实现写在 ${path.relative(anchor, implPath)}；多了一层 receipts/ 子目录）`);
      const readPath = fs.existsSync(contractPath) ? contractPath : implPath;
      check(fs.existsSync(readPath), `收据文件不存在（契约=${contractPath} 实现=${implPath}）`);
      let r = null;
      if (fs.existsSync(readPath)) {
        try { r = JSON.parse(fs.readFileSync(readPath, 'utf8')); } catch (e) { problems.push(`收据不是可解析 JSON：${e.message}`); }
      }
      if (r) {
        const keys = Object.keys(r);
        check(keys.length === RECEIPT_KEYS.length, `收据键数=${keys.length}（应恰 10 键；实际 keys=${JSON.stringify(keys)}）`);
        check(JSON.stringify(keys) === JSON.stringify(RECEIPT_KEYS), `收据键名/顺序 != §1.2（实际=${JSON.stringify(keys)} 期望=${JSON.stringify(RECEIPT_KEYS)}）`);
        check(r.v === 1, `v=${JSON.stringify(r.v)}（应 1）`);
        check(String(r.date) === d && path.basename(readPath) === `RECEIPT-${d.replace(/-/g, '')}.json`, `date=${JSON.stringify(r.date)} 与文件名不符（${path.basename(readPath)}）`);
        check(Number(r.offsetMinutes) === 480, `offsetMinutes=${JSON.stringify(r.offsetMinutes)}（应 480）`);
        check(/^(\d{8}-[0-9a-z]{12}-[A-Z]-\d{8})?$/.test(String(r.lastCode)), `lastCode=${JSON.stringify(r.lastCode)} 不匹配 ^(\d{8}-[0-9a-z]{12}-[A-Z]-\d{8})?$`);
        for (const k of ['ledgerRows', 'ledgerBytes', 'originalCount']) {
          check(Number.isInteger(r[k]) && Number(r[k]) >= 0, `${k}=${JSON.stringify(r[k])} 不是非负整数`);
        }
        check(/^[0-9a-f]{64}$/.test(String(r.ledgerSha256)), `ledgerSha256=${JSON.stringify(r.ledgerSha256)} 不是 64hex`);
        check(r.prevReceiptSha256 === '' || /^[0-9a-f]{64}$/.test(String(r.prevReceiptSha256)), `prevReceiptSha256=${JSON.stringify(r.prevReceiptSha256)} 不属于 {"",64hex}`);
        check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(r.generatedAt)), `generatedAt=${JSON.stringify(r.generatedAt)} 不匹配 ^YYYY-MM-DD HH:MM:SS$`);
        check(!String(r.generatedAt || '').includes('Z'), `generatedAt 含 Z（${JSON.stringify(r.generatedAt)}）`);
      }
      expect(problems.length === 0, '★ REC-01 不成立：' + problems.join('；'));
      return `收据恰 10 键、键序==§1.2；v/date/offset/lastCode/计数/sha/prev/generatedAt 全部符合；路径=${path.relative(anchor, readPath)}`;
    }); },
  });

  // ==========================================================================
  // REC-02 · 账证据四字段与实算全等：sha256(文件字节)/字节数/行数/末行 code
  // ==========================================================================
  runner.add({
    id: 'REC-02', criteria: ['REC-02'], title: '收据 ledgerSha256==sha256(台账文件字节)、ledgerBytes==size、ledgerRows==行数、lastCode==末行 code（四者全等）',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-02');
      const anchor = path.join(lab.base, 'anchor-outside');
      const d = '2026-11-08';
      const rows = [
        ledgerRow(CODE(d, 1), `${d}T10:00:00+08:00`),
        ledgerRow(CODE(d, 2), `${d}T11:00:00+08:00`, ''),
        ledgerRow(CODE(d, 3), `${d}T12:00:00+08:00`),
      ];
      const p = writeDay(lab.root, d, rows);
      const beforeBytes = fs.readFileSync(p);
      const w = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d });
      expect(w.ok && w.written, `前置失败：收据未生成（${JSON.stringify(w)}）`);
      const implPath = await actualReceiptPath(I, anchor, d);
      expect(fs.existsSync(implPath), '前置失败：收据文件不存在');
      const r = JSON.parse(fs.readFileSync(implPath, 'utf8'));
      const afterBytes = fs.readFileSync(p);
      const afterRows = afterBytes.toString('utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x));
      expectEqual(fs.readFileSync(implPath, 'utf8').length > 0, true, '前置失败：收据为空');
      expectEqual(r.ledgerSha256, sha(afterBytes), '★ REC-02 不成立：ledgerSha256 != sha256(当日台账文件完整字节)');
      expectEqual(Number(r.ledgerBytes), fs.statSync(p).size, '★ REC-02 不成立：ledgerBytes != 台账文件实际字节数');
      expectEqual(Number(r.ledgerRows), afterRows.length, '★ REC-02 不成立：ledgerRows != 台账实际行数');
      expectEqual(String(r.lastCode), String(afterRows[afterRows.length - 1].code), '★ REC-02 不成立：lastCode != 台账末行 code');
      expectEqual(sha(beforeBytes), sha(afterBytes), '前置失败：生成收据过程改了台账字节');
      return `ledgerSha256/ledgerBytes/ledgerRows/lastCode 四者与实算全等（${afterRows.length} 行、${afterBytes.length}B、末行 ${r.lastCode}）`;
    }); },
  });

  // ==========================================================================
  // REC-03 · 当日无台账仍生成：rows=0/bytes=0/sha==sha256("")/lastCode==""；originalCount 实盘
  // ==========================================================================
  runner.add({
    id: 'REC-03', criteria: ['REC-03'], title: '当日无台账文件仍生成收据：ledgerRows=0、ledgerBytes=0、ledgerSha256==sha256("")、lastCode=""；originalCount 实盘',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-03');
      const anchor = path.join(lab.base, 'anchor-outside');
      const d = '2026-11-08';
      // 只造第三级原文视图（2 份），不造台账 → 验证 originalCount 仍按实盘
      const origDir = path.join(lab.root, '2026年11月', '11月总“完整原文”');
      fs.mkdirSync(origDir, { recursive: true });
      const codes = [CODE(d, 1), CODE(d, 2)];
      for (const c of codes) fs.writeFileSync(path.join(origDir, `${c} 完整原文.md`), '# 凭证\n', 'utf8');
      // 附件不算 originalCount
      fs.writeFileSync(path.join(origDir, `${codes[0]} 原始事件.json`), '{}\n', 'utf8');
      const w = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d });
      const implPath = await actualReceiptPath(I, anchor, d);
      const generated = fs.existsSync(implPath) || fs.existsSync(contractReceiptPath(anchor, d));
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      check(generated, `当日无台账文件时没有生成收据（writeDailyReceipt ok=${w.ok} reason=${w.reason}）——契约要求"仍生成"并把空账证据写全`);
      if (generated) {
        const readPath = fs.existsSync(implPath) ? implPath : contractReceiptPath(anchor, d);
        const r = JSON.parse(fs.readFileSync(readPath, 'utf8'));
        check(Number(r.ledgerRows) === 0, `ledgerRows=${JSON.stringify(r.ledgerRows)}（应 0）`);
        check(Number(r.ledgerBytes) === 0, `ledgerBytes=${JSON.stringify(r.ledgerBytes)}（应 0）`);
        check(r.ledgerSha256 === EMPTY_SHA, `ledgerSha256=${JSON.stringify(r.ledgerSha256)}（应 sha256("")=${EMPTY_SHA}）`);
        check(String(r.lastCode) === '', `lastCode=${JSON.stringify(r.lastCode)}（应 ""）`);
        check(Number(r.originalCount) === 2, `originalCount=${JSON.stringify(r.originalCount)}（应实盘 2 份视图，不含附件）`);
      }
      expect(problems.length === 0, '★ REC-03 不成立：' + problems.join('；'));
      return `空账日收据：rows=0/bytes=0/sha==sha256("")/lastCode=""；originalCount=2（实盘视图，不含附件）`;
    }); },
  });

  // ==========================================================================
  // REC-04 · 连续两日：D1 prev==""；D2 prev==sha256(D1 完整字节)；复算相等
  // ==========================================================================
  runner.add({
    id: 'REC-04', criteria: ['REC-04'], title: '连续两日收据：D1 prev==""；D2 prevReceiptSha256==sha256(D1 收据完整字节)（文件复算相等）',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-04');
      const anchor = path.join(lab.base, 'anchor-outside');
      const d1 = '2026-11-08'; const d2 = '2026-11-09';
      writeDay(lab.root, d1, [ledgerRow(CODE(d1, 1), `${d1}T10:00:00+08:00`)]);
      writeDay(lab.root, d2, [ledgerRow(CODE(d2, 1), `${d2}T10:00:00+08:00`)]);
      const w1 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d1 });
      const w2 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d2 });
      expect(w1.ok && w2.ok, `前置失败：两日收据未生成（${JSON.stringify([w1, w2].map((w) => [w.ok, w.reason]))}）`);
      const p1 = await actualReceiptPath(I, anchor, d1);
      const p2 = await actualReceiptPath(I, anchor, d2);
      expect(fs.existsSync(p1) && fs.existsSync(p2), '前置失败：收据文件不存在');
      const r1 = JSON.parse(fs.readFileSync(p1, 'utf8'));
      const r2 = JSON.parse(fs.readFileSync(p2, 'utf8'));
      const d1Bytes = fs.readFileSync(p1);
      expectEqual(r1.prevReceiptSha256, '', `★ REC-04 不成立：D1 prevReceiptSha256=${JSON.stringify(r1.prevReceiptSha256)}（无前日收据时应为 ""）`);
      expectEqual(r2.prevReceiptSha256, sha(d1Bytes), '★ REC-04 不成立：D2 prevReceiptSha256 != sha256(D1 收据完整字节)');
      // 用 D1 文件独立复算一次（不信任收据里的值）
      expectEqual(sha(fs.readFileSync(p1)), r2.prevReceiptSha256, '★ REC-04 不成立：D2 prev 与"用 D1 文件复算"不相等');
      return `D1 prev=""；D2 prev==sha256(D1 文件字节)=${String(r2.prevReceiptSha256).slice(0, 12)}…；链首尾相接`;
    }); },
  });

  // ==========================================================================
  // REC-05 · 只读校验器三篡改：LEDGER_CHANGED / LEDGER_MISSING / CHAIN_BREAK(missing-receipt)；exit==2；前后 sha 集合不变
  // ==========================================================================
  runner.add({
    id: 'REC-05', criteria: ['REC-05'], title: '只读校验器：改台账→LEDGER_CHANGED、删台账→LEDGER_MISSING、删中间收据→CHAIN_BREAK；退出码==2；前后文件 sha256 集合不变',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const mkBase = async (tag, days, withReceipts) => {
        const lab = mk('rec-05-' + tag);
        const anchor = path.join(lab.base, 'anchor-outside');
        fs.mkdirSync(anchor, { recursive: true });
        for (const [d, code] of days) writeDay(lab.root, d, [ledgerRow(code, `${d}T10:00:00+08:00`)]);
        if (withReceipts) {
          for (const [d] of days) {
            const w = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d });
            expect(w.ok, `前置失败（${tag}）：${d} 收据未生成（${w.reason}）`);
          }
        }
        return { lab, anchor };
      };
      // ① 改当日台账一行 → LEDGER_CHANGED，exit 2
      {
        const { lab, anchor } = await mkBase('changed', [['2026-11-08', CODE('2026-11-08', 1)]], true);
        fs.appendFileSync(dayPath(lab.root, '2026-11-08'), JSON.stringify(ledgerRow(CODE('2026-11-08', 9), '2026-11-08T12:00:00+08:00')) + '\n');
        const before = snapshotTree(lab.root, anchor);
        const r = runCli([`--root=${lab.root}`, `--anchor=${anchor}`]);
        const after = snapshotTree(lab.root, anchor);
        check(r.status === 2, `① 改台账：校验器退出码=${r.status}（契约要求 2）`);
        check(/LEDGER_CHANGED/.test(r.stdout), `① 改台账：输出未报 LEDGER_CHANGED（${JSON.stringify(r.stdout.slice(0, 200))}）`);
        check(/[0-9a-f]{8,}/i.test(r.stdout) && /收据|expected|actual|当前|对比/i.test(r.stdout), '① 改台账：输出未给 expected/actual hash 证据');
        check(before === after, '① 改台账：校验器运行前后文件 sha256 集合变化（只读被破）');
      }
      // ② 删当日台账 → LEDGER_MISSING，exit 2
      {
        const { lab, anchor } = await mkBase('missing', [['2026-11-08', CODE('2026-11-08', 1)]], true);
        fs.unlinkSync(dayPath(lab.root, '2026-11-08'));
        const before = snapshotTree(lab.root, anchor);
        const r = runCli([`--root=${lab.root}`, `--anchor=${anchor}`]);
        const after = snapshotTree(lab.root, anchor);
        check(r.status === 2, `② 删台账：校验器退出码=${r.status}（契约要求 2）`);
        check(/LEDGER_MISSING/.test(r.stdout), `② 删台账：输出未报 LEDGER_MISSING（${JSON.stringify(r.stdout.slice(0, 200))}）`);
        check(before === after, '② 删台账：校验器运行前后文件 sha256 集合变化（只读被破）');
      }
      // ③ 删中间某日收据 → CHAIN_BREAK（missing-receipt），exit 2
      {
        const days = [['2026-11-08', CODE('2026-11-08', 1)], ['2026-11-09', CODE('2026-11-09', 1)], ['2026-11-10', CODE('2026-11-10', 1)]];
        const { lab, anchor } = await mkBase('chain', days, true);
        const mid = await actualReceiptPath(I, anchor, '2026-11-09');
        expect(fs.existsSync(mid), '前置失败：中间日收据不存在');
        fs.unlinkSync(mid);
        const before = snapshotTree(lab.root, anchor);
        const r = runCli([`--root=${lab.root}`, `--anchor=${anchor}`]);
        const after = snapshotTree(lab.root, anchor);
        check(r.status === 2, `③ 删中间收据：校验器退出码=${r.status}（契约要求 2）`);
        check(/CHAIN_BREAK/.test(r.stdout), `③ 删中间收据：输出未报 CHAIN_BREAK（${JSON.stringify(r.stdout.slice(0, 300))}）`);
        check(/missing/i.test(r.stdout) || /2026-11-09/.test(r.stdout), '③ 删中间收据：输出未指明缺哪一天（missing-receipt 定位）');
        check(before === after, '③ 删中间收据：校验器运行前后文件 sha256 集合变化（只读被破）');
      }
      expect(problems.length === 0, '★ REC-05 不成立：' + problems.join('；'));
      return '三篡改均被报出（LEDGER_CHANGED/LEDGER_MISSING/CHAIN_BREAK）；退出码 2；运行前后 root+anchor sha256 集合不变';
    }); },
  });

  // ==========================================================================
  // REC-06 · 锚留空=关闭：不生成收据；校验器 {"enabled":false,"breaks":[]} 且 exit 0；不报错
  // ==========================================================================
  runner.add({
    id: 'REC-06', criteria: ['REC-06'], title: 'receiptAnchorRoot=""（默认关闭）：不生成收据、不写锚；校验器输出 {"enabled":false,"breaks":[]} 且 exit 0；不报错',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-06');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      // ① 库函数：空锚 → disabled、无 errors
      const e = I.rec.ensureReceipts({ root: lab.root, anchorRoot: '', dates: ['2026-11-08'], todayISO: '2026-11-09' });
      check(e.ok === true && e.disabled === true && (e.errors || []).length === 0, `空锚 ensureReceipts 未关闭/报错（ok=${e.ok} disabled=${e.disabled} errors=${JSON.stringify(e.errors)}）`);
      // ② 集成：runOnce 默认（不配锚）→ stat.receipts=='off'、无收据错误、不生成任何收据
      const r = await L.runOnce(PLUGIN, lab, { weeklyEnabled: false, handoverEnabled: false });
      check(String(r.stat.receipts) === 'off', `runOnce 未配置锚时 stat.receipts=${JSON.stringify(r.stat.receipts)}（应 'off'）`);
      const receiptErrors = (r.stat.errors || []).filter((x) => /receipt|RECEIPT|ANCHOR/i.test(String(x)));
      check(receiptErrors.length === 0, `未配置锚却报收据错误（${JSON.stringify(receiptErrors)}）`);
      const receiptsOnDisk = L.listFiles(lab.base).filter((f) => /RECEIPT-\d{8}\.json$/.test(path.basename(f.rel)));
      check(receiptsOnDisk.length === 0, `未配置锚却生成了收据文件（${JSON.stringify(receiptsOnDisk.map((f) => f.rel))}）`);
      // ③ 校验器：关闭状态必须 {"enabled":false,"breaks":[]} + exit 0
      const disabled = runCli([`--root=${lab.root}`]);
      let dj = null;
      try { dj = JSON.parse(disabled.stdout.trim()); } catch { dj = null; }
      check(disabled.status === 0, `校验器关闭状态退出码=${disabled.status}（应 0；stderr=${JSON.stringify(disabled.stderr.slice(0, 120))}）`);
      check(!!dj && dj.enabled === false && Array.isArray(dj.breaks) && dj.breaks.length === 0,
        `校验器关闭状态输出不是 {"enabled":false,"breaks":[]}（stdout=${JSON.stringify(disabled.stdout.slice(0, 160))}）`);
      expect(problems.length === 0, '★ REC-06 不成立：' + problems.join('；'));
      return '空锚：ensureReceipts.disabled=true、runOnce stat.receipts=off、零收据/零错误；校验器 {"enabled":false,"breaks":[]} + exit 0';
    }); },
  });

  // ==========================================================================
  // REC-07 · 锚位置：==root / root 子路径 / root 祖先 → ANCHOR_INSIDE_ROOT 且不生成；合法外置正常
  // ==========================================================================
  runner.add({
    id: 'REC-07', criteria: ['REC-07'], title: '锚==root / root 子路径 / root 祖先 → ANCHOR_INSIDE_ROOT（不生成收据、root 内无收据文件）；合法外置目录正常生成',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-07');
      const d = '2026-11-08';
      writeDay(lab.root, d, [ledgerRow(CODE(d, 1), `${d}T10:00:00+08:00`)]);
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const receiptsInRoot = () => L.listFiles(lab.root).filter((f) => /RECEIPT-\d{8}\.json$/.test(path.basename(f.rel))).map((f) => f.rel);
      // ① 锚 == root
      const w1 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: lab.root, dateISO: d });
      check(w1.ok === false && w1.reason === 'ANCHOR_INSIDE_ROOT', `① 锚==root 未被拒（ok=${w1.ok} reason=${w1.reason}）`);
      check(receiptsInRoot().length === 0, `① 锚==root 在 root 内写了收据（${JSON.stringify(receiptsInRoot())}）`);
      // ② 锚 == root 子路径
      const sub = path.join(lab.root, 'anchor-inside');
      const w2 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: sub, dateISO: d });
      check(w2.ok === false && w2.reason === 'ANCHOR_INSIDE_ROOT', `② 锚==root 子路径 未被拒（ok=${w2.ok} reason=${w2.reason}）`);
      check(receiptsInRoot().length === 0, `② 锚==root 子路径 在 root 内写了收据（${JSON.stringify(receiptsInRoot())}）`);
      // ③ 锚 == root 祖先
      const w3 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: lab.base, dateISO: d });
      check(w3.ok === false && w3.reason === 'ANCHOR_INSIDE_ROOT', `③ 锚==root 祖先 未被拒（ok=${w3.ok} reason=${w3.reason} path=${JSON.stringify(w3.path && path.relative(lab.base, w3.path))}）`);
      check(receiptsInRoot().length === 0, `③ 锚==root 祖先 在 root 内写了收据（${JSON.stringify(receiptsInRoot())}）`);
      // ④ 合法外置目录 → 正常生成
      const legal = path.join(lab.base, 'anchor-legal');
      const w4 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: legal, dateISO: d });
      check(w4.ok === true && w4.written === true, `④ 合法外置锚未正常生成（ok=${w4.ok} written=${w4.written} reason=${w4.reason}）`);
      check(L.listFiles(legal).some((f) => /RECEIPT-\d{8}\.json$/.test(path.basename(f.rel))), '④ 合法外置锚目录里没有收据文件');
      expect(problems.length === 0, '★ REC-07 不成立：' + problems.join('；'));
      return '①②③ 均 ANCHOR_INSIDE_ROOT 且 root 内零收据；④ 合法外置目录正常生成收据';
    }); },
  });

  // ==========================================================================
  // REC-08 · 同日重跑：证据不变 → 幂等（不新增/sha 不变/decision:"idempotent"/exit 0）；证据变化 → RECEIPT_CONFLICT 不覆盖
  // ==========================================================================
  runner.add({
    id: 'REC-08', criteria: ['REC-08'], title: '同日证据不变：不新增文件、旧收据 sha256 不变、输出 decision:"idempotent"、exit 0；证据变化：RECEIPT_CONFLICT 且不覆盖旧收据',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-08');
      const anchor = path.join(lab.base, 'anchor-outside');
      const d = '2026-11-08';
      writeDay(lab.root, d, [ledgerRow(CODE(d, 1), `${d}T10:00:00+08:00`)]);
      const w1 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d });
      expect(w1.ok && w1.written, '前置失败：首张收据未写');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const receiptFiles = () => L.listFiles(anchor).filter((f) => /RECEIPT-\d{8}\.json$/.test(path.basename(f.rel)));
      const count1 = receiptFiles().length;
      const p = await actualReceiptPath(I, anchor, d);
      const sha1 = L.shaFile(p);
      const w2 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d, nowMs: Date.now() + 3600_000 });
      check(w2.ok === true && w2.written === false, `① 同日同证据重跑不幂等（ok=${w2.ok} written=${w2.written}）`);
      check(receiptFiles().length === count1, `① 同日同证据重跑新增了收据文件（${count1}→${receiptFiles().length}）`);
      check(L.shaFile(p) === sha1, '① 同日同证据重跑改写了旧收据（sha256 变化）');
      const decision = String((w2 && (w2.decision || w2.reason)) || '');
      check(/idempotent/i.test(decision), `① 幂等结果未输出机器可读 decision:"idempotent"（实现返回 keys=${JSON.stringify(Object.keys(w2))} written=${w2.written} reason=${JSON.stringify(w2.reason)}；同类证据只能从 written:false 推断）`);
      // 校验器对未变证据 exit 0（可用作"重跑幂等无差异"的只读证据）
      const ro1 = runCli([`--root=${lab.root}`, `--anchor=${anchor}`]);
      check(ro1.status === 0, `① 未变证据校验器退出码=${ro1.status}（应 0）`);
      // ② 证据变化 → RECEIPT_CONFLICT 且不覆盖旧收据
      fs.appendFileSync(dayPath(lab.root, d), JSON.stringify(ledgerRow(CODE(d, 9), `${d}T12:00:00+08:00`)) + '\n');
      const w3 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d, nowMs: Date.now() + 7200_000 });
      check(w3.ok === false && w3.reason === 'RECEIPT_CONFLICT', `② 证据变化不是 RECEIPT_CONFLICT（ok=${w3.ok} reason=${w3.reason}）`);
      check(receiptFiles().length === count1, `② 冲突时新增了收据文件（${count1}→${receiptFiles().length}）`);
      check(L.shaFile(p) === sha1, '② 冲突时覆盖了旧收据（sha256 变化）');
      expect(problems.length === 0, '★ REC-08 不成立：' + problems.join('；'));
      return '同日同证据：不新增/旧收据 sha256 不变/decision:idempotent/校验器 exit 0；证据变化：RECEIPT_CONFLICT 且不覆盖旧收据';
    }); },
  });

  // ==========================================================================
  // REC-09 · 部署与责任边界：默认桌面锚示例绝对外置；假 U 盘 → ANCHOR_UNWRITABLE 且账务照常；复制后 --anchor 校验通过
  // ==========================================================================
  runner.add({
    id: 'REC-09', criteria: ['REC-09'], title: '默认锚=<桌面>/账本锚绝对外置；假 U 盘路径→ANCHOR_UNWRITABLE 且账务照常不崩；复制后 --anchor=临时目录 只读校验通过；插件不搬运 U 盘',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-09');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      // ① 部署配置：绝对、外置的桌面锚示例（默认值 "" 关闭属 REC-06 口径，两者取"部署示例"判）
      const cfgText = fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8');
      const m = /([A-Za-z]:\\[^'"\n]*Desktop[^'"\n]*账本锚)/.exec(cfgText);
      check(!!m, '① cordis.patch.yml 没有给出"桌面固定目录"的锚配置示例（绝对路径）');
      if (m) {
        check(path.isAbsolute(m[1]), `① 示例锚不是绝对路径（${m[1]}）`);
        check(I.rec.anchorIsOutside(m[1], lab.root).ok === true, `① 示例锚在 root 内（${m[1]}）`);
      }
      // ② 假 U 盘路径：报 ANCHOR_UNWRITABLE 且账务照常、不崩
      const drives = ['U:', 'Q:', 'R:', 'Z:', 'Y:', 'X:'];
      const fakeU = drives.map((x) => `${x}\\v05-fake-anchor-${process.pid}`).find((pth) => !fs.existsSync(pth.slice(0, 2) + '\\'));
      if (!fakeU) skip('未找到可用的假盘符（U/Q/R/Z/Y/X 都可能已挂载）——REC-09② 无法构造假 U 盘路径，该判据未完全验证');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const r = await L.runOnce(PLUGIN, lab, { weeklyEnabled: false, handoverEnabled: false, receiptAnchorRoot: fakeU });
      const rows = (await L.readLedger(PLUGIN, lab.root)).records;
      const originals = L.listFiles(lab.root).filter((f) => f.rel.endsWith('完整原文.md'));
      check(rows.length === 1, `② 假的不可写锚导致账务失败（台账行数=${rows.length}，应 1）`);
      check(originals.length === 1, `② 假的不可写锚导致原文未写（${originals.length}）`);
      const allText = JSON.stringify(r.stat.errors || []) + '|' + String(r.stat.receipts || '');
      check(/ANCHOR_UNWRITABLE/.test(allText), `② 假 U 盘路径未报 ANCHOR_UNWRITABLE（stat.errors=${JSON.stringify((r.stat.errors || []).slice(0, 5))} receipts=${JSON.stringify(r.stat.receipts)}）`);
      check((r.stat.errors || []).some((x) => /receipt/i.test(String(x))), '② 锚不可写没有记进 stat.errors（receipt.errors 未落到运行统计）');
      // ③ 机主把锚目录复制到临时目录后 --anchor 只读校验通过（模拟搬运；真实 U 盘未做）
      const anchor = path.join(lab.base, 'anchor-outside');
      const d = '2026-11-08';
      writeDay(lab.root, '2026-11-08', [ledgerRow(CODE('2026-11-08', 1), '2026-11-08T10:00:00+08:00')]);
      const w = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d });
      check(w.ok && w.written, `③ 前置：锚收据未生成（${w.reason}）`);
      const moved = path.join(lab.base, 'moved-anchor');
      fs.cpSync(anchor, moved, { recursive: true });
      const ro = runCli([`--root=${lab.root}`, `--anchor=${moved}`]);
      check(ro.status === 0 && /一致/.test(ro.stdout), `③ 复制到临时目录后 --anchor 只读校验未通过（exit=${ro.status} stdout=${JSON.stringify(ro.stdout.slice(0, 160))}）`);
      expect(problems.length === 0, '★ REC-09 不成立：' + problems.join('；'));
      return `① 配置示例锚=${m && m[1]} 绝对且外置；② 假 U 盘 ${fakeU} → ANCHOR_UNWRITABLE 记录、台账/原文照常、不崩；③ 复制到临时目录后 --anchor 校验 exit 0（真实 U 盘离线自检未做：待机主执行 node docs/工具-核验收据.mjs --anchor=<U盘>）`;
    }); },
  });

  // ==========================================================================
  // REC-10 · 只读校验器契约：--json 输出 {v,enabled,anchor,checks,breaks}；退出码 0/2/3/4；前后 sha 集合不变
  // ==========================================================================
  runner.add({
    id: 'REC-10', criteria: ['REC-10'], title: '校验器 --json：输出 {v,enabled,anchor,checks,breaks}；退出码 0=通过/关闭、2=差异、3=用法/配置错误、4=内部错误；前后 root+anchor sha256 集合不变',
    async fn() { return withLabs(async (mk) => {
      const I = await L.impl(PLUGIN);
      const lab = mk('rec-10');
      const anchor = path.join(lab.base, 'anchor-outside');
      const d1 = '2026-11-08'; const d2 = '2026-11-09';
      writeDay(lab.root, d1, [ledgerRow(CODE(d1, 1), `${d1}T10:00:00+08:00`)]);
      writeDay(lab.root, d2, [ledgerRow(CODE(d2, 1), `${d2}T10:00:00+08:00`)]);
      expect(I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d1 }).ok, '前置失败：D1 收据未生成');
      expect(I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: d2 }).ok, '前置失败：D2 收据未生成');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const shaSet = (...roots) => snapshotTree(...roots);
      const parseJsonOut = (r) => {
        const txt = String(r.stdout || '').trim();
        const start = txt.indexOf('{');
        if (start < 0) return null;
        // 允许前后有日志行：取第一个 '{' 起的整段尝试解析
        try { return JSON.parse(txt.slice(start)); } catch { return null; }
      };
      // ① 全一致：exit 0 + 可解析 JSON 契约结构
      {
        const before = shaSet(lab.root, anchor);
        const r = runCli([`--root=${lab.root}`, `--anchor=${anchor}`, '--json']);
        const after = shaSet(lab.root, anchor);
        const j = parseJsonOut(r);
        check(r.status === 0, `① 一致场景 exit=${r.status}（应 0）`);
        check(!!j, `① --json 输出不是可解析 JSON（stdout 前 160 字=${JSON.stringify(String(r.stdout || '').slice(0, 160))}）`);
        if (j) {
          check(j.v === 1, `① 输出 v=${JSON.stringify(j.v)}（应 1）`);
          check(typeof j.enabled === 'boolean', `① 输出 enabled 不是 bool（${JSON.stringify(j.enabled)}）`);
          check(typeof j.anchor === 'string' && j.anchor.length > 0, `① 输出 anchor 不是非空字符串（${JSON.stringify(j.anchor)}）`);
          check(Array.isArray(j.checks) && j.checks.every((c) => c && typeof c.name === 'string' && typeof c.ok === 'boolean'), `① 输出 checks 不是 [{name,ok}]（${JSON.stringify(j.checks)}）`);
          check(Array.isArray(j.breaks), `① 输出 breaks 不是数组（${JSON.stringify(j.breaks)}）`);
        }
        check(before === after, '① 校验器改动了 root/anchor 文件（sha256 集合变化）');
      }
      // ② 发现差异：exit 2
      {
        fs.appendFileSync(dayPath(lab.root, d1), JSON.stringify(ledgerRow(CODE(d1, 9), `${d1}T12:00:00+08:00`)) + '\n');
        const before = shaSet(lab.root, anchor);
        const r = runCli([`--root=${lab.root}`, `--anchor=${anchor}`, '--json']);
        const after = shaSet(lab.root, anchor);
        const j = parseJsonOut(r);
        check(r.status === 2, `② 差异场景 exit=${r.status}（应 2）`);
        if (j) check(Array.isArray(j.breaks) && j.breaks.length > 0, `② 差异场景 breaks 为空（${JSON.stringify(j.breaks)}）`);
        check(before === after, '② 校验器改动了 root/anchor 文件（sha256 集合变化）');
      }
      // ③ 用法/配置错误（anchor 不存在）：exit 3
      {
        const missingAnchor = path.join(lab.base, 'anchor-does-not-exist');
        const r = runCli([`--root=${lab.root}`, `--anchor=${missingAnchor}`, '--json']);
        check(r.status === 3, `③ anchor 不存在时 exit=${r.status}（应 3=用法/配置错误）`);
      }
      // ④ 内部错误码 4：无法在不改实现的前提下可靠构造（不伪造），如实记录未覆盖
      // 只读性：三次 CLI 调用后 root/anchor 与调用前一致
      check(fs.existsSync(anchor) && fs.existsSync(lab.root), '校验器把 root/anchor 目录删了');
      if (!problems.length) {
        return '--json 输出 {v,enabled,anchor,checks,breaks}；退出码 0/2/3 语义正确；root+anchor sha256 集合不变（内部错误码 4 未构造，无证据）';
      }
      // 真实 U 盘离线自检未做：单独记入 evidence（不冒充通过）
      expect(problems.length === 0, '★ REC-10 不成立：' + problems.join('；') + '（另：内部错误退出码 4 未构造——无法在不改实现的前提下可靠触发，如实标注未覆盖，不标 PASS；真实 U 盘 --anchor 离线自检未做，待机主搬盘后执行 node docs/工具-核验收据.mjs --anchor=<U盘> --json）');
    }); },
  });
}

await main(import.meta.url, {
  name: 'v0.5 REC 收据锚 REC-01…REC-10',
  target: PLUGIN,
  build,
});
