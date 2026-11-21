/**
 * @file 自测-种错.mjs
 * @role **复核器自己的"能失败"证明**：故意在账里种 4 类错误（A/B/C/D），复核器必须报出来并定位到 (sid,turn)。
 *
 * @why 一个从没红过的复核器等于没有复核器。本测试就是"删掉守卫必红"的反证：
 *      种错 → 必须报；报错定位不对 → 也算不通过。
 *
 * 用法：
 *   node 自测-种错.mjs --sessions=<corpus>\sessions --root=<corpus>\dialog-ledger
 * 退出码：0 = 4 类错误全部被捕获且定位正确；1 = 有漏检/错检；2 = 参数/前置失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { audit } from './复核.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (k, d = '') => {
  const hit = process.argv.find((a) => a === k || a.startsWith(k + '='));
  if (!hit) return d;
  const i = hit.indexOf('=');
  return i < 0 ? '' : hit.slice(i + 1);
};
const SESSIONS = path.resolve(argOf('--sessions', path.join(HERE, '_corpus', 'sessions')));
const ROOT = path.resolve(argOf('--root', path.join(HERE, '_corpus', 'dialog-ledger')));
const KEEP = process.argv.includes('--keep');

if (!fs.existsSync(path.join(SESSIONS)) || !fs.existsSync(path.join(ROOT, 'ledger'))) {
  console.error('前置缺失：需要先跑 构建账本.mjs');
  process.exit(2);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v06-种错-'));

function copyLedger() {
  const dst = path.join(TMP, 'case-' + stamp());
  fs.cpSync(ROOT, dst, { recursive: true });
  return dst;
}
function ledgerJsonlNames(root) {
  return fs.readdirSync(path.join(root, 'ledger')).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
}
function readRows(root) {
  const rows = [];
  for (const n of ledgerJsonlNames(root)) {
    const p = path.join(root, 'ledger', n);
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.trim()) { try { rows.push({ file: n, row: JSON.parse(line) }); } catch { /* 坏行留给复核器 */ } }
    }
  }
  return rows;
}
function writeRows(root, file, rows) {
  fs.writeFileSync(path.join(root, 'ledger', file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const failures = [];
const cases = [];
function check(name, cond, detail) {
  const item = { name, ok: !!cond, detail };
  cases.push(item);
  if (!cond) failures.push(item);
  console.log((cond ? '✔' : '✘') + ' ' + name + (detail ? ' — ' + detail : ''));
}

// ── 0. 基线：原始账必须 0 差异（A/B/C/D） ────────────────────────────────
console.log('[0] 基线复核（未种错）…');
const base = audit({ sessionsBase: SESSIONS, root: ROOT, maxDetail: 500 });
check('基线：A/B/C/D = 0', base.summary.unexplained === 0,
  `A=${base.summary.classCounts.A} B=${base.summary.classCounts.B} C=${base.summary.classCounts.C} D=${base.summary.classCounts.D} E=${base.summary.classCounts.E}`);
check('基线：源轮次与台账行均 > 0', base.summary.sourceTurns > 0 && base.summary.ledgerRows > 0,
  `sourceTurns=${base.summary.sourceTurns} ledgerRows=${base.summary.ledgerRows}`);

// 选一个"源 closed 且账 ok"的目标轮次（优先 v4）
let target = null;
for (const s of base.sessions) {
  if (s.mode !== 'v4') continue;
  for (const t of s.turns) {
    if (t.status !== 'closed') continue;
    const row = readRows(ROOT).find((x) => x.row.sid === s.sid && x.row.turn === t.turn);
    if (row) { target = { sid: s.sid, turn: t.turn, file: row.file, row: row.row, source: s }; break; }
  }
  if (target) break;
}
if (!target) { console.error('找不到可种错的目标轮次'); process.exit(2); }

// ── 1. A 类：删掉一行（源有账无） ────────────────────────────────────────
{
  console.log('[1] 种错 A：删除台账一行…');
  const root = copyLedger();
  const all = readRows(root);
  const keep = all.filter((x) => !(x.row.sid === target.sid && x.row.turn === target.turn));
  const byFile = new Map();
  for (const x of keep) { const a = byFile.get(x.file) || []; a.push(x.row); byFile.set(x.file, a); }
  for (const n of ledgerJsonlNames(root)) writeRows(root, n, byFile.get(n) || []);
  const r = audit({ sessionsBase: SESSIONS, root, maxDetail: 500 });
  const hit = r.diffs.find((d) => d.class === 'A' && d.sid === target.sid && d.turn === target.turn);
  check('A：删除一行 → 报 A 并定位 (sid,turn)', !!hit, hit ? hit.reason : '未检出');
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
}

// ── 2. B 类：追加一行假的（账有源无） ────────────────────────────────────
{
  console.log('[2] 种错 B：追加一行不存在的轮次…');
  const root = copyLedger();
  const fakeTurn = 99999;
  const fake = { ...target.row, turn: fakeTurn, code: '20990101-000000000000-Z-99999999', ts: '2099-01-01T00:00:00+08:00' };
  fs.appendFileSync(path.join(root, 'ledger', target.file), JSON.stringify(fake) + '\n', 'utf8');
  const r = audit({ sessionsBase: SESSIONS, root, maxDetail: 500 });
  const hit = r.diffs.find((d) => d.class === 'B' && d.sid === target.sid && d.turn === fakeTurn);
  check('B：追加假行 → 报 B 并定位 (sid,turn)', !!hit, hit ? hit.reason : '未检出');
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
}

// ── 3. C 类：改状态（closed → partial） ──────────────────────────────────
{
  console.log('[3] 种错 C：把一行状态从 ok 改成 partial…');
  const root = copyLedger();
  const all = readRows(root);
  const byFile = new Map();
  for (const x of all) {
    const row = { ...x.row };
    if (row.sid === target.sid && row.turn === target.turn) row.status = 'partial';
    const a = byFile.get(x.file) || []; a.push(row); byFile.set(x.file, a);
  }
  for (const n of ledgerJsonlNames(root)) writeRows(root, n, byFile.get(n) || []);
  const r = audit({ sessionsBase: SESSIONS, root, maxDetail: 500 });
  const hit = r.diffs.find((d) => d.class === 'C' && d.sid === target.sid && d.turn === target.turn);
  check('C：状态篡改 → 报 C 并定位 (sid,turn)', !!hit, hit ? hit.reason : '未检出');
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
}

// ── 4. D 类：改附件内容（条数/首尾/指纹必变） ────────────────────────────
{
  console.log('[4] 种错 D：篡改原文附件里的一个事件…');
  const root = copyLedger();
  const doc = target.row.doc;
  const attName = target.row.attachment && target.row.attachment.name ? target.row.attachment.name : `${target.row.code} 原始事件.json`;
  const attPath = path.join(root, path.dirname(doc), attName);
  if (!fs.existsSync(attPath)) {
    check('D：附件存在（前置）', false, attPath);
  } else {
    const lines = fs.readFileSync(attPath, 'utf8').split('\n').filter((x) => x.trim());
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev && ev.type === 'tool/call') { ev.args = (ev.args || '') + '<<tampered>>'; lines[i] = JSON.stringify(ev); changed = true; break; }
      } catch { /* 跳过 */ }
    }
    if (!changed && lines.length) {
      const ev = JSON.parse(lines[0]); ev.tampered = true; lines[0] = JSON.stringify(ev); changed = true;
    }
    fs.writeFileSync(attPath, lines.join('\n') + '\n', 'utf8');
    const r = audit({ sessionsBase: SESSIONS, root, maxDetail: 500 });
    const hit = r.diffs.find((d) => d.class === 'D' && d.sid === target.sid && d.turn === target.turn);
    check('D：附件篡改 → 报 D 并定位 (sid,turn)', !!hit, hit ? hit.reason : '未检出');
    if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
const report = {
  at: new Date().toISOString(),
  sessions: SESSIONS,
  root: ROOT,
  target: { sid: target.sid, turn: target.turn, code: target.row.code },
  cases,
  ok: failures.length === 0,
};
const out = path.join(HERE, '自测-种错-结果.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('');
console.log('=== 种错自证：' + (report.ok ? '全部捕获' : '有漏检') + ' ===');
console.log('报告 → ' + out);
if (KEEP) console.log('（--keep：临时副本保留在 ' + TMP + '）');
else fs.rmSync(TMP, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
