/**
 * @file 探针-a01-partial.mjs
 * @role 独立复现审计报告 A-01（未闭合 Turn 永久停在 partial），对齐 K3.1pro 的 delayedTurnEnd 探针。
 * @why P0回归.mjs 的 P0-2 用例只跑了两轮，而 partial 落盘需要「两轮确认」，
 *      因此它是在"还没写 partial"时就补了 turn/end —— 通过得毫无意义（假绿）。
 *      本探针按真实语义跑三轮：① 建游标 ② 文件未变→确认→写 partial ③ 补 turn/end→观察是否修正。
 * @用法 node P0验收/探针-a01-partial.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const idx = await import(new URL('../index.js', import.meta.url));
const led = await import(new URL('../lib/ledger.js', import.meta.url));
const org = await import(new URL('../lib/original.js', import.meta.url));

const SID = 'session-partialprobe-1111-2222-333344445555';
const T0 = Date.parse('2026-11-08T08:00:00+08:00');
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
const head = JSON.stringify({ type: 'session', id: SID, createdAt: T0, cwd: 'C:\\lab' });
const sLine = (t, ms) => JSON.stringify({ type: 'turn/start', time: ms, data: { turn: t } });
const eLine = (t, ms) => JSON.stringify({ type: 'turn/end', time: ms, data: { turn: t, reason: { kind: 'completed' } } });
const quiet = { logger: { info() {}, warn() {}, error() {} } };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a01-'));
const home = path.join(base, 'dsh-home');
const root = path.join(base, 'ledger-root');
const sessDir = path.join(home, 'sessions', 'wsA', SID);
fs.mkdirSync(sessDir, { recursive: true });
fs.mkdirSync(root, { recursive: true });
process.env.DSH_HOME = home;
const file = path.join(sessDir, 'session.v4.jsonl.zstd');
const cfg = {
  root, intervalSeconds: 60, enabled: true, offsetMinutes: 480,
  hotWindowSeconds: 0, quietSeconds: 0, checkupEnabled: false, weeklyEnabled: false,
};

const rows = () => led.readAll(root).records.filter((r) => r.turn === 1);
const originalBytes = () => {
  const f = path.join(root, '2026年11月', '11月总“完整原文”', rows()[0]?.code + ' 完整原文.md');
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
};

// ① 只有 turn/start
fs.writeFileSync(file, frame([head, sLine(1, T0)]));
const r1 = await idx.runOnce(quiet, cfg);
const st1 = led.readState(root) || {};

// ② 文件未变 → 满足两轮确认 → 应当写 partial
const r2 = await idx.runOnce(quiet, cfg);
const after2 = rows().map((r) => ({ status: r.status, code: r.code, docHash: (r.docHash || '').slice(0, 12) }));
const bytes2 = originalBytes();

// ③ 源里补上 turn/end
fs.writeFileSync(file, frame([head, sLine(1, T0), eLine(1, T0 + 60000)]));
const r3 = await idx.runOnce(quiet, cfg);
const after3 = rows().map((r) => ({ status: r.status, code: r.code, docHash: (r.docHash || '').slice(0, 12) }));
const bytes3 = originalBytes();

const stat = (r) => (r && r.stats) || r || {};
console.log(JSON.stringify({
  run1: stat(r1),
  run2: stat(r2),
  run3: stat(r3),
  cursorAfterRun1: st1.cursors && st1.cursors[file] ? st1.cursors[file].offset : null,
  rowsAfterRun2: after2,
  rowsAfterRun3: after3,
  originalBytesUnchangedAfterClose: bytes2 && bytes3 ? Buffer.compare(bytes2, bytes3) === 0 : null,
  closedStatusPresent: after3.some((r) => r.status === 'ok' || r.status === 'completed' || r.status === 'closed'),
  verdict: (() => {
    const wrotePartial = after2.some((r) => r.status === 'partial');
    const closed = after3.some((r) => r.status === 'ok' || r.status === 'completed' || r.status === 'closed');
    const okCount = after3.filter((r) => r.status === 'ok' || r.status === 'completed' || r.status === 'closed').length;
    if (wrotePartial) {
      return closed
        ? '⚠ 仍写了 partial（v0.4 行为），但随后闭合了 —— 需复查是否引入了第二条行'
        : '★ 复现 A-01：补 end 后仍停在 partial，原文字节不变';
    }
    if (closed && okCount === 1) {
      return '✅ P0-2 已修复：未闭合轮次不进账本（只留 pending），补 end 后【恰好一条】ok';
    }
    if (closed) return '⚠ 闭合了但 ok 行数为 ' + okCount + '（要求恰好 1）';
    return '✗ 异常：既没写 partial 也没闭合';
  })(),
}, null, 2));
