// 历史补记：给「没有凭证」的旧记录补上初始凭证。
//
// 用法：node docs/工具-v03-历史补记.mjs [数据总库] [sessions目录] [报告输出目录]
//
// 铁律：
//   · 台账一个字不改（只追加是根）——补记只写第 3 级凭证文件；
//   · 周记账通过「编码 → 凭证文件是否存在」两级解析自动重新绑定；
//   · 源会话已删/缺轮次的记录：如实报「无法补记」，不伪造。
//
// 退出码：0 = 全部可补的都补了；1 = 有失败（详情见报告）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

const root = process.argv[2] || path.join(os.homedir(), '.dsh', 'dialog-ledger');
const sessionsBase = process.argv[3] || path.join(os.homedir(), '.dsh', 'sessions');
const outDir = process.argv[4] || '';

const led = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);
const enc = await import(pathToFileURL(path.join(SRC, 'lib', 'encoder.js')).href);
const orig = await import(pathToFileURL(path.join(SRC, 'lib', 'original.js')).href);

// 1) 读台账，挑出没有 doc 的记录
const ledgerDir = path.join(root, 'ledger');
const recs = [];
for (const f of fs.readdirSync(ledgerDir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))) {
  recs.push(...fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}
const targets = recs.filter((r) => !r.doc);
console.log(`台账 ${recs.length} 条；需要补记 ${targets.length} 条`);

// 2) 建 sid → 会话文件索引
const files = new Map();
(function walk(dir, depth) {
  if (depth > 6) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === 'session.v4.jsonl.zstd') {
      const sid = path.basename(path.dirname(p));
      if (sid.startsWith('session-') || /^[0-9a-f-]{36}$/.test(sid)) files.set(sid, p);
    }
  }
})(sessionsBase, 0);

// 3) 按会话分组补记
const bySid = new Map();
for (const r of targets) {
  if (!bySid.has(r.sid)) bySid.set(r.sid, []);
  bySid.get(r.sid).push(r);
}

const done = [];
const missingSession = [];
const missingTurn = [];
const failed = [];

for (const [sid, list] of bySid) {
  const file = files.get(sid);
  if (!file) { missingSession.push(...list.map((r) => r.code)); continue; }

  const need = new Set(list.map((r) => r.turn));
  let eventsByTurn;
  try {
    eventsByTurn = led.readTurnEventsBatch(file, need);
  } catch (e) {
    failed.push({ codes: list.map((r) => r.code), error: String(e.message) });
    continue;
  }

  for (const r of list) {
    const events = eventsByTurn.get(r.turn);
    if (!events || events.length === 0) { missingTurn.push(r.code); continue; }

    const p = enc.parseCode(r.code);
    if (!p) { failed.push({ codes: [r.code], error: 'bad code' }); continue; }

    // 结束时间/原因取自事件（台账里没有这两个字段）
    const startEv = events.find((e) => e.type === 'turn/start');
    const endEv = events.filter((e) => e.type === 'turn/end').pop() || null;
    const startMs = (startEv && startEv.time) || Date.parse(r.ts);
    const endMs = endEv ? endEv.time : startMs;
    const reason = endEv && endEv.data && endEv.data.reason ? (endEv.data.reason.kind || 'completed') : 'partial';
    const turn = { turn: r.turn, startMs, endMs, reason };

    try {
      const rendered = orig.renderOriginal({
        events, turn, code: r.code, sid, sessKey: `${p.s12}${p.gen}`, seq: r.seq,
        offsetMinutes: 480, generator: 'dsh-dialog-ledger-v03/original(backfill)',
      });
      const ts = new Date(startMs + 480 * 60 * 1000);
      const y = ts.getUTCFullYear();
      const m = ts.getUTCMonth() + 1;
      orig.writeOriginal({ root, y, m, code: r.code, markdown: rendered.markdown });
      done.push({ code: r.code, turn: r.turn, sid });
    } catch (e) {
      failed.push({ codes: [r.code], error: String(e.message) });
    }
  }
}

// 4) 报告
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
const lines = [
  `# 历史补记报告 ${stamp}`,
  '',
  `- 数据总库：\`${root}\``,
  `- 会话目录：\`${sessionsBase}\``,
  `- 台账：${recs.length} 条；无凭证：${targets.length} 条`,
  '',
  '| 结果 | 条数 |',
  '|---|---:|',
  `| 补记成功 | ${done.length} |`,
  `| 源会话缺失 | ${missingSession.length} |`,
  `| 源会话无此轮 | ${missingTurn.length} |`,
  `| 失败 | ${failed.length} |`,
  '',
  '> 台账未被改动（只追加）。周记账会按「编码→凭证文件是否存在」自动重新绑定，并标注「补记」。',
];
if (missingSession.length) lines.push('', '## 源会话缺失', '', ...missingSession.map((c) => `- \`${c}\``));
if (missingTurn.length) lines.push('', '## 源会话无此轮', '', ...missingTurn.map((c) => `- \`${c}\``));
if (failed.length) lines.push('', '## 失败', '', ...failed.map((f) => `- \`${f.codes.join('`, `')}\` — ${f.error}`));

const report = lines.join('\n');
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, `历史补记-${stamp.replace(/[: ]/g, '').slice(0, 15)}.md`);
  fs.writeFileSync(p, report, 'utf8');
  console.log('报告：', p);
}
console.log(`补记成功 ${done.length} ｜ 源缺失 ${missingSession.length} ｜ 无此轮 ${missingTurn.length} ｜ 失败 ${failed.length}`);
process.exitCode = failed.length > 0 ? 1 : 0;
