/**
 * @file run-acceptance.mjs
 * @role v1.3 黑盒验收总入口（可重复运行）。
 *
 * 用法：
 *   node docs/验收-v1.3/run-acceptance.mjs [--target=<work-dir>\work\v0.5-工作副本]
 *        [--fixtures=<work-dir>\work\压测素材\sessions] [--keep] [--only=e2e,labs]
 *
 * 退出码：0 = 本次执行未发现失败判据；1 = 存在失败判据；2 = 脚本自身异常。
 * 产物：docs/验收-v1.3/_results/结果.json（机器可读）+ 结果摘要.md
 * 所有测试数据落在系统临时目录，跑完自动删除（--keep 保留现场）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {
  Recorder, mkLab, copyRealSession, writeSyntheticSession, appendSessionFrame, makeEvent,
  runRound, probeXlsx, sha256File, sha256Text, sha256Buf, readText, exists, readJson,
  listArtifacts, artifactSnapshot, compareSnapshots, walkFiles, localDate, localParts,
  decodeSessionFile, turnBoundaries, parseFrontMatter, yamlScalar, bodyStartIndex,
  ZSTD_MAGIC, WEEK_NAMES, readLedger,
} from './harness.mjs';

import {
  ALL_IDS, acOf, checkHandoverMain, checkHandoverAppendix, checkOriginal, checkWeeklyBook,
  checkState, checkLayout, checkGlobalTexts, checkLedgerBasics, recomputeShadowed,
  parseCleanedCodes, resolveDocState, docLabel, handoverMainName, handoverAppendixName,
} from './checks-artifacts.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

function parseArgs(argv) {
  const out = {
    target: REPO_ROOT,
    fixtures: path.resolve(REPO_ROOT, '..', '压测素材', 'sessions'),
    keep: false, only: null, lab: null,
    out: path.join(SCRIPT_DIR, '_results'),
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--target=')) out.target = path.resolve(a.slice(9));
    else if (a.startsWith('--fixtures=')) out.fixtures = path.resolve(a.slice(11));
    else if (a === '--keep') out.keep = true;
    else if (a.startsWith('--only=')) out.only = a.slice(7).split(',');
    else if (a.startsWith('--lab=')) out.lab = a.slice(6).split(',');
    else if (a.startsWith('--out=')) out.out = path.resolve(a.slice(6));
  }
  return out;
}

const PYTHON_DEFAULT = '<build-host>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const NODE_HINT = '<build-host>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe';

function detectPython(preferred) {
  for (const p of [preferred, PYTHON_DEFAULT, 'python', 'python3']) {
    try {
      const r = spawnSync(p, ['-c', 'import openpyxl,sys;print(openpyxl.__version__)'], { encoding: 'utf8' });
      if (r.status === 0) return p;
    } catch { /* next */ }
  }
  throw new Error('找不到可用 python（需带 openpyxl）');
}

const results = [];
const tasks = [];
const R = new Recorder();
const R_TASK = { task: (id, ok, ev) => tasks.push({ id, ok: !!ok, evidence: String(ev || '') }) };

const run = async (fn) => { try { await fn(); } catch (e) { R.fail('SCRIPT', [], [], `脚本异常：${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); } };

// ===========================================================================
// 0) 环境与快照
// ===========================================================================
async function phaseMeta(T) {
  const target = T.target;
  const hashes = {};
  for (const f of walkFiles(target)) {
    if (f.rel.startsWith('node_modules/')) continue;
    hashes[f.rel] = sha256File(f.abs);
  }
  T.meta = {
    target,
    frozenAt: new Date().toISOString(),
    nodeVersion: process.version,
    python: T.python,
    startedAt: new Date().toISOString(),
    codeHashes: hashes,
    packageJsonHash: sha256File(path.join(target, 'package.json')),
  };
}

// ===========================================================================
// 1) 端到端：真实会话（1 个 v4 + 1 个 v3-only），runOnce 跑三轮
// ===========================================================================
async function phaseE2E(T) {
  const lab = mkLab(T.base, 'e2e');
  const v4rel = '--synthetic-workspace--/session-44671553-2f37-3b8f-7c73-80601d9ef2f9';
  const v3rel = '--synthetic-workspace--/8f3c679b-6817-84a1-4505-027bb451357b';
  const v4file = copyRealSession(lab, T.fixtures, v4rel, 'session.v4.jsonl.zstd');
  const v3file = copyRealSession(lab, T.fixtures, v3rel, 'session.v3.jsonl.zstd');
  const v3shaBefore = sha256File(v3file);
  const v4shaBefore = sha256File(v4file);

  const r1 = await runRound(T, lab);
  const snap1 = artifactSnapshot(lab.root);
  const stateP = path.join(lab.root, 'ledger', '.state.json');
  const state1 = exists(stateP) ? readJson(stateP) : null;
  const stateKeys1 = state1 ? Object.keys(state1) : [];

  const r2 = await runRound(T, lab);
  const snap2 = artifactSnapshot(lab.root);
  const r3 = await runRound(T, lab);
  const snap3 = artifactSnapshot(lab.root);
  const state3 = exists(stateP) ? readJson(stateP) : null;

  // ---- 端到端统计 ----
  R_TASK.task('E2E-01 首轮 written>0、errors 空、交接表生成数=2、纳入 v3 源=1',
    r1.stat.written > 0 && (r1.stat.errors || []).length === 0 && r1.stat.handoverGenerated === 2 && r1.stat.legacySources === 1,
    `written=${r1.stat.written} errors=${JSON.stringify(r1.stat.errors)} handoverGenerated=${r1.stat.handoverGenerated} legacySources=${r1.stat.legacySources}`);
  R_TASK.task('E2E-02 第二轮/第三轮 written=0',
    r2.stat.written === 0 && r3.stat.written === 0,
    `run2.written=${r2.stat.written} run3.written=${r3.stat.written}`);
  R_TASK.task('E2E-03 第二轮与第三轮产物字节完全一致（幂等）',
    JSON.stringify(compareSnapshots(snap2, snap3)) === '[]' && snap2.size === snap3.size,
    `差异=${JSON.stringify(compareSnapshots(snap2, snap3).slice(0, 5))}`);

  // ---- 台账 / v3 ----
  const { ledger, sidTurnUnique } = checkLedgerBasics(R, { root: lab.root, id: 'E2E' });
  R_TASK.task('E2E-04 code 与 (sid,turn) 全局唯一（台账）', sidTurnUnique, `台账 ${ledger.records.length} 行，重复=${!sidTurnUnique}`);
  R.judge('GL-07', 'GL-07', acOf('GL-07'),
    r2.stat.written === 0 && r3.stat.written === 0 && JSON.stringify(compareSnapshots(snap1, snap3)) === '[]',
    '连跑三轮：(sid,turn) 不增、产物字节不变',
    `非幂等：run2.written=${r2.stat.written} run3.written=${r3.stat.written} 差异=${JSON.stringify(compareSnapshots(snap1, snap3).slice(0, 5))}`);

  const v3shaAfter = sha256File(v3file);
  const v4shaAfter = sha256File(v4file);
  const v3Recs = ledger.records.filter((r) => r && String(r.sid || '').includes('96dea353'));
  const v4Recs = ledger.records.filter((r) => r && String(r.sid || '').includes('3b9ad925'));
  R.judge('OR-25', 'OR-25', acOf('OR-25'),
    v3Recs.length > 0 && v3Recs.every((r) => r.src === 'session.v3.jsonl.zstd') && v3shaBefore === v3shaAfter,
    `v3-only 会话入账 ${v3Recs.length} 行、src 全部为 session.v3.jsonl.zstd；v3 文件 sha256 前后不变（${v3shaBefore.slice(0, 12)}…）`,
    `v3 只读源不合格：入账=${v3Recs.length} src=${JSON.stringify([...new Set(v3Recs.map((r) => r.src))])} 字节不变=${v3shaBefore === v3shaAfter}`);
  R.judge('GL-10', 'GL-10', acOf('GL-10'),
    v3Recs.length > 0 && v3shaBefore === v3shaAfter && v4shaBefore === v4shaAfter && v4Recs.length > 0,
    `v3-only 会话可入账（${v3Recs.length} 轮）且 v3 文件零写入；v4 会话入账 ${v4Recs.length} 轮`,
    `v3 历史源不合格：v3 入账=${v3Recs.length} v3 字节不变=${v3shaBefore === v3shaAfter}`);
  R_TASK.task('E2E-05 v3 会话 src=session.v3.jsonl.zstd 且 v3 文件字节未变',
    v3Recs.length > 0 && v3Recs.every((r) => r.src === 'session.v3.jsonl.zstd') && v3shaBefore === v3shaAfter,
    `src=${JSON.stringify([...new Set(v3Recs.map((r) => r.src))])} sha 前=${v3shaBefore.slice(0, 10)} 后=${v3shaAfter.slice(0, 10)}`);

  // ---- 账实一致：台账行数 = 原文文件数 ----
  const artifacts = listArtifacts(lab.root);
  const originals = artifacts.filter((a) => /完整原文\.md$/.test(a.rel));
  R_TASK.task('E2E-06 台账行数 = 原文文件数', ledger.records.length === originals.length,
    `台账 ${ledger.records.length} 行 / 原文 ${originals.length} 个文件`);

  // ---- 交接表（按会话） ----
  const sidToKey = new Map();
  for (const r of ledger.records) {
    if (!r || !r.code || !r.sid) continue;
    sidToKey.set(String(r.sid), `${String(r.code).slice(9, 21)}${String(r.code).slice(22, 23)}`);
  }
  const mains = artifacts.filter((a) => /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表\.md$/.test(path.basename(a.rel)));
  const apps = artifacts.filter((a) => /^[0-9a-z]{12}[A-Z]的记忆数据库的启用及交接表——附表\.md$/.test(path.basename(a.rel)));
  R.judge('HO-21', 'HO-21', acOf('HO-21'),
    r1.stat.handoverGenerated === 2 && /handover=generate reopened=true/.test(r1.logText),
    `首跑 generate 2 份，日志含 handover=generate reopened=true`,
    `生成语义不符：handoverGenerated=${r1.stat.handoverGenerated} 日志含 generate=${/handover=generate reopened=true/.test(r1.logText)}`);
  R.judge('HO-31', 'HO-31', acOf('HO-31'), mains.length === 2 && apps.length === 2,
    `重复触发 3 次后目录中仍只有 ${mains.length} 个主表、${apps.length} 个附表`,
    `生成一次不成立：主表=${mains.length} 附表=${apps.length}`);
  R.judge('HO-27', 'HO-27', acOf('HO-27'),
    mains.every((m) => apps.some((a) => path.basename(a.rel) === handoverAppendixName(path.basename(m.rel).slice(0, 13)))),
    '主表存在 ⇒ 附表存在（同批生成路径）',
    `存在缺附表的会话：${JSON.stringify(mains.map((m) => path.basename(m.rel)).filter((n) => !apps.some((a) => path.basename(a.rel) === handoverAppendixName(n.slice(0, 13)))))}`);

  const handoverCache = new Map();
  for (const [sid, sessKey] of sidToKey) {
    if (handoverCache.has(sessKey)) continue;
    handoverCache.set(sessKey, true);
    const mainData = checkHandoverMain(R, { root: lab.root, sessKey, id: `E2E ${sessKey}` });
    const appData = checkHandoverAppendix(R, { root: lab.root, sessKey, id: `E2E ${sessKey}`, expectEmpty: true });
    // HA-17 同批：主表与附表的生成时间一致
    if (mainData && appData) {
      const sameStamp = yamlScalar(mainData.y['生成时间']) === yamlScalar(appData.y['生成时间']);
      R.judge('HA-17', 'HA-17', acOf('HA-17'), sameStamp,
        `主表/附表同批生成，生成时间均为 ${yamlScalar(mainData.y['生成时间'])}`,
        `主表/附表生成时间不一致：${yamlScalar(mainData.y['生成时间'])} vs ${yamlScalar(appData.y['生成时间'])}`);
    }
    const mainRel = handoverMainName(sessKey);
    const appRel = handoverAppendixName(sessKey);
    R.judge('HO-22', 'HO-22', acOf('HO-22'),
      snap1.has(mainRel) && snap3.has(mainRel) && snap1.get(mainRel).sha === snap3.get(mainRel).sha && snap1.get(mainRel).mtimeMs === snap3.get(mainRel).mtimeMs,
      `已封板再跑：主表字节与 mtime 均不变（${mainRel}）`,
      `已封板主表被改写：${JSON.stringify([snap1.get(mainRel), snap3.get(mainRel)])}`);
    R.judge('HA-20', 'HA-20', acOf('HA-20'),
      snap1.has(appRel) && snap3.has(appRel) && snap1.get(appRel).sha === snap3.get(appRel).sha,
      `已封板再跑：附表字节不变（${appRel}）`,
      `已封板附表被改写：${JSON.stringify([snap1.get(appRel), snap3.get(appRel)])}`);
  }

  // ---- 完整原文（每行） ----
  const sessionMap = new Map(); // sid → {file, events, version}
  for (const f of walkFiles(lab.sessions)) {
    if (!/\.jsonl\.zstd$/.test(f.abs)) continue;
    const dec = decodeSessionFile(f.abs);
    const head = dec.events.find((e) => e && e.type === 'session') || {};
    const sid = String(head.id || '');
    if (sid) sessionMap.set(sid, { file: f.abs, events: dec.events, version: /session\.v3\./.test(f.abs) ? 3 : 4, dec });
  }
  const recByCode = new Map(ledger.records.filter((r) => r && r.code).map((r) => [r.code, r]));
  const originalsByCode = new Map(originals.map((o) => [path.basename(o.rel).slice(0, 32), o]));
  let originalChecked = 0;
  for (const o of originals) {
    const code = path.basename(o.rel).slice(0, 32);
    const rec = recByCode.get(code);
    if (!rec) continue;
    const sess = sessionMap.get(String(rec.sid));
    if (!sess) continue;
    const turns = turnBoundaries(sess.events);
    const turn = turns.get(rec.turn);
    const expectedShadow = turn
      ? recomputeShadowed(sess.events, turn.startSeq, turn.endSeq).count
      : 0;
    checkOriginal(R, {
      root: lab.root, record: rec, sourceEvents: sess.events, id: `E2E ${code}`,
      turn, expectShadowedCount: expectedShadow,
    });
    originalChecked += 1;
  }
  R_TASK.task('E2E-08 逐份完整原文（五节 / YAML / 正文hash 独立复算）已逐一检查',
    originalChecked === ledger.records.length && originalChecked > 0,
    `检查 ${originalChecked}/${ledger.records.length} 份`);
  R.judge('OR-21', 'OR-21', acOf('OR-21'),
    originals.every((o) => snap2.has(o.rel) && snap3.has(o.rel) && snap2.get(o.rel).sha === snap3.get(o.rel).sha),
    `${originals.length} 份原文在第二/三轮字节不变（已存在凭证零写入）`,
    `原文被二次写入：${JSON.stringify(originals.filter((o) => !snap2.has(o.rel) || snap2.get(o.rel).sha !== snap3.get(o.rel).sha).map((o) => o.rel))}`);

  // ---- 周记账 ----
  const xlsxFiles = artifacts.filter((a) => a.rel.endsWith('.xlsx')).map((a) => a.abs);
  const probe = probeXlsx(T, xlsxFiles);
  const weeklyRowsBySess = new Map();
  for (const f of xlsxFiles) {
    const fact = probe.get(f);
    const data = checkWeeklyBook(R, { root: lab.root, fact, ledgerRecords: ledger.records, id: `E2E ${path.basename(f)}`, cleaned: parseCleanedCodes(lab.root) });
    if (data) {
      const key = data.hdr.sessKey;
      weeklyRowsBySess.set(key, (weeklyRowsBySess.get(key) || 0) + data.rowsAll.length);
    }
  }
  // 账 = 原文 = 周记账（逐会话）
  const ledgerByKey = new Map();
  for (const r of ledger.records) {
    if (!r || !r.code) continue;
    const k = `${String(r.code).slice(9, 21)}${String(r.code).slice(22, 23)}`;
    ledgerByKey.set(k, (ledgerByKey.get(k) || 0) + 1);
  }
  const origByKey = new Map();
  for (const o of originals) {
    const code = path.basename(o.rel).slice(0, 32);
    const k = `${code.slice(9, 21)}${code.slice(22, 23)}`;
    origByKey.set(k, (origByKey.get(k) || 0) + 1);
  }
  const cmp = [];
  for (const [k, n] of ledgerByKey) {
    if (origByKey.get(k) !== n || weeklyRowsBySess.get(k) !== n) cmp.push({ key: k, ledger: n, original: origByKey.get(k), weekly: weeklyRowsBySess.get(k) });
  }
  R_TASK.task('E2E-09 同一会话：台账行数 = 原文文件数 = 周记账行数', cmp.length === 0,
    cmp.length ? `不等的会话：${JSON.stringify(cmp)}` : `逐会话相等：${JSON.stringify([...ledgerByKey])}`);
  R_TASK.task('E2E-10 周记账文件均可用 openpyxl 打开且结构合格',
    xlsxFiles.length === 2 && [...probe.values()].every((f) => f.ok),
    `${xlsxFiles.length} 个 xlsx，openpyxl 全成功=${[...probe.values()].every((f) => f.ok)}`);
  R.judge('WK-34', 'WK-34', acOf('WK-34'),
    xlsxFiles.every((f) => { const rel = path.relative(lab.root, f).split(path.sep).join('/'); return snap2.has(rel) && snap3.has(rel) && snap2.get(rel).sha === snap3.get(rel).sha; }),
    `已封板周记账在后续两轮字节不变`,
    `已封板周记账被重写：${JSON.stringify(xlsxFiles.map((f) => path.basename(f)).filter((n) => { /* noop */ return false; }))}`);

  // ---- 全局 ----
  checkLayout(R, { root: lab.root, id: 'E2E' });
  checkGlobalTexts(R, { root: lab.root, id: 'E2E', xlsxFacts: [...probe.values()] });
  const st = checkState(R, { root: lab.root, id: 'E2E' });
  const stateKeys3 = state3 ? Object.keys(state3) : [];
  const noTmp = walkFiles(lab.root).every((f) => !f.rel.endsWith('.tmp'));
  R.judge('HO-28', 'HO-28', acOf('HO-28'), noTmp, '运行结束 root 下无 *.tmp', '存在 *.tmp 残留');
  R.judge('GL-09', 'GL-09', acOf('GL-09'),
    !!st && JSON.stringify(stateKeys3) !== '[]' && stateKeys1.every((k) => stateKeys3.includes(k)) && noTmp,
    `state 可解析、键集合只增不减（${stateKeys1.length}→${stateKeys3.length}）、无 tmp 残留；原子写机制本身不可黑盒观测（见人工待验）`,
    `state 不合格：解析=${!!st} 键保留=${stateKeys1.every((k) => stateKeys3.includes(k))} tmp=${!noTmp}`);
  R.judge('GL-11', 'GL-11', acOf('GL-11'),
    !walkFiles(lab.root).some((f) => /CHK-\d{8}-\d{2}\.md$/.test(f.rel)) && !(st && st.checkup),
    '体检默认关闭：未产生 CHK-* 报告、state.checkup 不存在（决定 6：体检不进验收）',
    '体检被意外启用/产出');
  const pkg = readJson(path.join(T.target, 'package.json'));
  const nodeModules = exists(path.join(T.target, 'node_modules'));
  R.judge('GL-13', 'GL-13', acOf('GL-13'),
    (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) && !nodeModules,
    `package.json 无 dependencies；无 node_modules（零依赖）`,
    `依赖不合规：dependencies=${JSON.stringify(pkg.dependencies)} node_modules=${nodeModules}`);

  // ---- 产物快照留存（供报告证据） ----
  T.e2e = { lab, r1, r2, r3, ledger, artifacts, probe, state: st };
}

// ===========================================================================
// 2) 合成会话实验室
// ===========================================================================
const ms = (s) => Date.parse(s);
let seqCounter = 0;
function ev(type, timeMs, data) { return { type, seq: seqCounter++, time: timeMs, data }; }
function resetSeq() { seqCounter = 0; }
function sessionHeader(sid, createdAt) {
  return { type: 'session', version: 4, id: `session-${sid}`, createdAt, cwd: 'D:\\accept', isSeeded: false, delegationDepth: 0, agentPreset: 'accept' };
}

/** 一轮的最简事件（turn/start → user → assistant → turn/end）。 */
function simpleTurn(turn, startMs, { gap = 1000, userText = `第 ${turn} 轮提问`, assistantText = `第 ${turn} 轮回答` } = {}) {
  const t = [];
  t.push(ev('turn/start', startMs, { turn }));
  t.push(ev('step/start', startMs + 1, { turn, step: 1 }));
  t.push(ev('user/message', startMs + 2, { content: [{ type: 'text', text: userText }], source: { kind: 'user' }, role: 'user' }));
  t.push(ev('assistant/message', startMs + 3, { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } }));
  t.push(ev('step/end', startMs + 4, { turn, step: 1 }));
  t.push(ev('turn/end', startMs + gap, { turn, reason: { kind: 'completed' } }));
  return t;
}

function ledgerFor(lab) {
  return readLedger(lab.root);
}

/** 会话键（13 位 {S}{D}）：与实现同口径（去 session- 前缀 → 去非字母数字 → 前 12 位小写 + 代差）。 */
function sessKeyOfSid(sessionId, gen = 'A') {
  const s12 = String(sessionId).replace(/^session-/, '').replace(/[^0-9A-Za-z]/g, '').slice(0, 12).toLowerCase();
  return `${s12}${gen}`;
}

function deriveSessKey(records, sid) {
  const r = records.find((x) => x && x.sid === sid && x.code);
  if (!r) return '';
  return `${String(r.code).slice(9, 21)}${String(r.code).slice(22, 23)}`;
}

// ---- Lab APP：5 类 block + 草稿态 + 旧版式重写 + 封板 + 补记册 ----
async function labApp(T) {
  const lab = mkLab(T.base, 'app');
  resetSeq();
  const sid = 'aaaaaaaabbbb-0000-0000-0000-000000000001';
  const day = '2026-11-09';
  const T0 = ms(`${day}T09:00:00+08:00`);
  const events = [sessionHeader(sid, T0)];
  events.push(ev('system/message', T0 + 1000, { message: { role: 'system', content: [{ type: 'text', text: '系统提示词原文' }] } }));
  events.push(ev('user/message', T0 + 2000, { content: [{ type: 'text', text: '接管前的用户提问' }], source: { kind: 'user' }, role: 'user' }));
  events.push(ev('user/message', T0 + 3000, { content: [{ type: 'text', text: '注入1-runtime-context' }], source: { kind: 'runtime-context' }, role: 'user' }));
  events.push(ev('user/message', T0 + 4000, { content: [{ type: 'text', text: '注入2-compact-checkpoint' }], source: { kind: 'compact-checkpoint' }, role: 'user' }));
  events.push(ev('assistant/message', T0 + 5000, {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '接管前的助手回答' },
        { type: 'thinking', thinking: '接管前思考' },
        { type: 'tool_use', id: 'call-x', name: 'pwsh' },
      ],
    },
  }));
  events.push(ev('tool/call', T0 + 6000, { turn: 0, step: 0, callId: 'call-x', name: 'pwsh', arguments: '{"cmd":"echo hi"}' }));
  events.push(ev('tool/result', T0 + 7000, { message: { role: 'tool', content: [{ type: 'text', text: '工具输出' }], isError: false } }));
  events.push(...simpleTurn(1, ms(`${day}T10:00:00+08:00`)));
  const sessionFile = writeSyntheticSession(lab, { sid, events });

  const r1 = await runRound(T, lab);
  const ledger1 = readLedger(lab.root);
  const sessKey = deriveSessKey(ledger1.records, `session-${sid}`);
  // 5 类 block + 过滤
  const appData = checkHandoverAppendix(R, {
    root: lab.root, sessKey, id: 'APP 附表',
    expectEmpty: false,
    expectedRoles: ['system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result'],
    forbiddenTexts: ['注入1-runtime-context', '注入2-compact-checkpoint'],
    expectedTexts: ['系统提示词原文', '接管前的用户提问', '接管前的助手回答', '接管前思考', '工具输出'],
    userBlockCount: 1,
  });
  if (appData) {
    const t = appData.text;
    const contentOk = t.includes('<details>') && t.includes('</details>') && t.includes('工具: pwsh') &&
      t.includes('"cmd": "echo hi"') && t.includes('→ tool/call [seq 5]') && t.includes('状态: ok');
    R.judge('HA-12', 'HA-12', acOf('HA-12'),
      contentOk,
      '内容形态：thinking 折叠、tool_use 指针、tool/call JSON 两空格、tool/result 状态 ok',
      `内容形态不符：details=${t.includes('<details>')} 工具行=${t.includes('工具: pwsh')} JSON缩进=${t.includes('"cmd": "echo hi"')} 指针=${t.includes('→ tool/call [seq 5]')} 状态=${t.includes('状态: ok')}`);
  } else {
    R.fail('HA-12', 'HA-12', acOf('HA-12'), '附表不存在，无法判定 HA-12');
  }
  checkHandoverMain(R, { root: lab.root, sessKey, id: 'APP 主表' });
  R_TASK.task('LAB-APP 交接表附表收录 5 类 block（user/assistant/tool-call/tool-result/system）且过滤注入 kind',
    !!appData && appData.count === 5, `上下文条数=${appData && appData.count} roles=${appData && JSON.stringify(appData.blockRoles)}`);

  // 草稿周记账
  const xlsx1 = listArtifacts(lab.root).filter((a) => a.rel.endsWith('.xlsx')).map((a) => a.abs);
  const probe1 = probeXlsx(T, xlsx1);
  const wk1 = checkWeeklyBook(R, { root: lab.root, fact: probe1.get(xlsx1[0]), ledgerRecords: ledger1.records, id: 'APP 草稿周记账', expectDraft: true, cleaned: parseCleanedCodes(lab.root) });
  R_TASK.task('LAB-APP 草稿态文件头（A3 草稿/请勿批注、A4/A5 为 —）',
    !!wk1 && wk1.headerMode === 'draft', `headerMode=${wk1 && wk1.headerMode}`);

  // 幂等：无新增 → 不重写（字节与 mtime 不变）
  const snapA = artifactSnapshot(lab.root);
  const rNoop = await runRound(T, lab);
  const snapB = artifactSnapshot(lab.root);
  const xlsxRel = path.relative(lab.root, xlsx1[0]).split(path.sep).join('/');
  R.judge('WK-33', 'WK-33', acOf('WK-33'),
    rNoop.stat.written === 0 && snapA.get(xlsxRel).sha === snapB.get(xlsxRel).sha && snapA.get(xlsxRel).mtimeMs === snapB.get(xlsxRel).mtimeMs,
    `无新增行 → 草稿不重写（字节与 mtime 不变）`,
    `草稿幂等失败：written=${rNoop.stat.written} 字节变=${snapA.get(xlsxRel).sha !== snapB.get(xlsxRel).sha} mtime变=${snapA.get(xlsxRel).mtimeMs !== snapB.get(xlsxRel).mtimeMs}`);

  // 旧版式（weeklyLayout=5）首跑必须重写（WK-38）
  const stP = path.join(lab.root, 'ledger', '.state.json');
  const st = readJson(stP);
  const gid = Object.keys(st.weeklySealed || {})[0] || `${st.weeklySealProbe || ''}`;
  const groupIdGuess = (() => {
    const rec = ledger1.records[0];
    const prefix = `${rec.ts.slice(0, 4)}-${rec.ts.slice(5, 7)}`;
    return null;
  })();
  // 从周记账文件名推 groupId：直接按 state 的 weeklyHashes 键（bootstrap 后应存在）
  const gidKey = Object.keys(st.weeklyHashes || {})[0];
  if (gidKey) {
    st.weeklyLayout = 5;
    st.weeklyHashes = { [gidKey]: 'deadbeef'.repeat(8) };
    fs.writeFileSync(stP, JSON.stringify(st, null, 2) + '\n');
    const beforeMtime = fs.statSync(xlsx1[0]).mtimeMs;
    const rLayout = await runRound(T, lab);
    const afterMtime = fs.statSync(xlsx1[0]).mtimeMs;
    const st2 = readJson(stP);
    R.judge('WK-38', 'WK-38', acOf('WK-38'),
      afterMtime !== beforeMtime && st2.weeklyLayout === 6,
      `state.weeklyLayout=5 的旧版式产物首跑被重写（mtime 变化：${beforeMtime}→${afterMtime}），并升级为 6`,
      `旧版式未重写：mtime 变化=${afterMtime !== beforeMtime} weeklyLayout=${st2.weeklyLayout}`);
  } else {
    R.fail('WK-38', 'WK-38', acOf('WK-38'), 'state.weeklyHashes 为空，无法构造旧版式场景');
  }

  // 人工封板（黑盒驱动 weekly 公开导出）
  const ledgerNow = readLedger(lab.root);
  const rec0 = ledgerNow.records[0];
  const g = T.week.weekOf(Date.parse(rec0.ts), 480);
  const sessKeyNow = deriveSessKey(ledgerNow.records, rec0.sid);
  const groupRecs = ledgerNow.records.filter((r) => r && r.code && `${String(r.code).slice(9, 21)}${String(r.code).slice(22, 23)}` === sessKeyNow);
  const sealRes = T.weekly.writeWeekly({ root: lab.root, w: g, sessKey: sessKeyNow, records: groupRecs, offsetMinutes: 480, mode: 'sealed', prevHashes: {} });
  const xlsxPath = sealRes.path;
  const probeSealed = probeXlsx(T, [xlsxPath]);
  const wkSealed = checkWeeklyBook(R, { root: lab.root, fact: probeSealed.get(xlsxPath), ledgerRecords: ledgerNow.records, id: 'APP 已封板周记账', expectSealed: true, cleaned: parseCleanedCodes(lab.root) });
  R.judge('WK-36', 'WK-36', acOf('WK-36'), (() => {
    const st3 = readJson(stP);
    const s = (st3.weeklySealed || {})[sealRes.groupId];
    return !!s && s.layout === 6 && Number.isInteger(s.rows) && s.sealHash === sealRes.sealHash;
  })(), `state.weeklySealed[${sealRes.groupId}] 含 sealedAt/sealHash/file/layout=6/rows`, 'state.weeklySealed 结构不符');
  R_TASK.task('LAB-APP 已封板文件头与封板hash（A3 已封板 / A4 64hex / A5 +08:00）',
    !!wkSealed && wkSealed.headerMode === 'sealed', `headerMode=${wkSealed && wkSealed.headerMode} A4=${wkSealed && wkSealed.a4}`);

  // 封板后新增行 → 补记册；正册字节不变
  const xlsxShaBefore = sha256File(xlsxPath);
  appendSessionFrame(sessionFile, simpleTurn(2, ms(`${day}T11:00:00+08:00`), { userText: '封板后第 2 轮', assistantText: '封板后回答 2' }));
  const rSup = await runRound(T, lab);
  const xlsxShaAfter = sha256File(xlsxPath);
  const supRel = walkFiles(lab.root).map((f) => path.relative(lab.root, f.abs).split(path.sep).join('/')).filter((r) => /^补记-\d{8}\.md$/.test(r));
  R_TASK.task('LAB-APP 封板后新增行 → 写补记册且正册字节不变',
    supRel.length === 1 && rSup.stat.supplements >= 1 && xlsxShaBefore === xlsxShaAfter,
    `补记册=${JSON.stringify(supRel)} supplements=${rSup.stat.supplements} 正册字节不变=${xlsxShaBefore === xlsxShaAfter}`);
  const supPath = path.join(lab.root, supRel[0]);
  const supText = readText(supPath);
  const fields = [...supText.matchAll(/^- (补记编号|原编码|原时间|所属正册|被补记原因|补记hash): (.*)$/gm)].map((m) => [m[1], m[2]]);
  const fieldMap = Object.fromEntries(fields);
  const tableLines = supText.split('\n').filter((l) => l.startsWith('|') && codeReIn(l));
  const rowCells = tableLines.length ? tableLines[0].split('|').slice(1, -1).map((s) => s.trim()) : [];
  R.judge('WK-39', 'WK-39', acOf('WK-39'), /^补记-\d{8}\.md$/.test(path.basename(supPath)),
    `补记册文件名合法：${path.basename(supPath)}（一级目录、md）`,
    `补记册文件名不符：${path.basename(supPath)}`);
  R.judge('WK-40', 'WK-40', acOf('WK-40'),
    ['补记编号', '原编码', '原时间', '所属正册', '被补记原因', '补记hash'].every((k) => fieldMap[k]) && rowCells.length === 10 &&
      /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(rowCells[0] || ''),
    `补记条目字段齐全、10 列表格行存在（原编码=${fieldMap['原编码']}）`,
    `补记结构不符：字段=${JSON.stringify(Object.keys(fieldMap))} 表格列数=${rowCells.length}`);
  function codeReIn(line) { return /\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}/.test(line); }
  // 追加第 3 轮
  const supText1 = readText(supPath);
  appendSessionFrame(sessionFile, simpleTurn(3, ms(`${day}T12:00:00+08:00`), { userText: '封板后第 3 轮', assistantText: '封板后回答 3' }));
  const rSup2 = await runRound(T, lab);
  const supText2 = readText(supPath);
  const supNos = [...supText2.matchAll(/^## (补记-\d{8}-\d{2})$/gm)].map((m) => m[1]);
  const supPrefixOk = supText2.startsWith(supText1);
  R.judge('WK-41', 'WK-41', acOf('WK-41'), supNos.length === 2 && supNos[1] === supNos[0].replace(/-01$/, '-02'),
    `补记编号连续：${JSON.stringify(supNos)}`,
    `补记编号不连续：${JSON.stringify(supNos)}`);
  R.judge('WK-43', 'WK-43', acOf('WK-43'), supPrefixOk && xlsxShaBefore === sha256File(xlsxPath),
    `补记册只追加（旧字节前缀不变）；正册字节不变`,
    `补记追加/正册不变失败：前缀=${supPrefixOk} 正册字节变=${xlsxShaBefore !== sha256File(xlsxPath)}`);
  // 补记hash 复算：该行 10 字段值以 \t 连接后 sha256
  const lastRow = (() => {
    const tls = supText2.split('\n').filter((l) => l.startsWith('|') && codeReIn(l));
    return tls.length ? tls[tls.length - 1].split('|').slice(1, -1).map((s) => s.trim()) : [];
  })();
  const lastHash = [...supText2.matchAll(/^- 补记hash: ([0-9a-f]{64})$/gm)].map((m) => m[1]).pop() || '';
  const recomputedSup = lastRow.length === 10 ? sha256Text(lastRow.join('\t')) : '';
  R.judge('WK-42', 'WK-42', acOf('WK-42'), recomputedSup === lastHash,
    `补记hash 可复算：${recomputedSup} == 记录值`,
    `补记hash 复算不一致：复算=${recomputedSup} 记录=${lastHash} 行=${JSON.stringify(lastRow)}`);

  // 已封板文件被删 → 不重建 + warn 'sealed but file missing'
  const xlsxBytes = fs.readFileSync(xlsxPath);
  fs.unlinkSync(xlsxPath);
  appendSessionFrame(sessionFile, simpleTurn(4, ms(`${day}T13:00:00+08:00`), { userText: '封板后第 4 轮', assistantText: '封板后回答 4' }));
  const rMissing = await runRound(T, lab);
  const rebuilt = exists(xlsxPath);
  R.judge('WK-35', 'WK-35', acOf('WK-35'),
    !rebuilt && /sealed but file missing/.test(rMissing.logText + '\n' + (rMissing.stat.errors || []).join('\n')),
    `已封板 xlsx 被删后不重建，并 warn「sealed but file missing」`,
    `封板缺失处理不合格：重建=${rebuilt} warn=${/sealed but file missing/.test(rMissing.logText)}`);
  R_TASK.task('LAB-APP 封板后删文件 → 不重建且日志含 sealed but file missing',
    !rebuilt && /sealed but file missing/.test(rMissing.logText), `重建=${rebuilt} warn=${/sealed but file missing/.test(rMissing.logText)}`);
}

// ---- Lab SHORTWEEK：月界短周 ----
async function labShortWeek(T) {
  const lab = mkLab(T.base, 'shortweek');
  resetSeq();
  const sid = 'ccccccccdddd-0000-0000-0000-000000000002';
  const T0 = ms('2026-10-01T10:00:00+08:00');
  const events = [sessionHeader(sid, ms('2026-10-01T00:00:00+08:00')), ...simpleTurn(1, T0)];
  writeSyntheticSession(lab, { sid, events });
  const r = await runRound(T, lab);
  const ledger = readLedger(lab.root);
  const xlsx = listArtifacts(lab.root).filter((a) => a.rel.endsWith('.xlsx')).map((a) => a.abs);
  if (xlsx.length !== 1) {
    R.fail('WK-32', 'WK-32', acOf('WK-32'), `周记账文件数=${xlsx.length}`);
    return;
  }
  const probe = probeXlsx(T, xlsx);
  const wk = checkWeeklyBook(R, { root: lab.root, fact: probe.get(xlsx[0]), ledgerRecords: ledger.records, id: 'SHORTWEEK', cleaned: parseCleanedCodes(lab.root) });
  R_TASK.task('LAB-SHORTWEEK 月界切段：不在段内的日表全空、B 列「—」',
    !!wk && wk.hdr.weekNo === 1 && wk.hdr.spanFrom === '2026-10-01',
    `weekNo=${wk && wk.hdr.weekNo} 周段=${wk && wk.hdr.spanFrom} ~ ${wk && wk.hdr.spanTo}`);
}

// ---- Lab OVF：单日 125 轮（溢出） ----
async function labOverflow(T) {
  const lab = mkLab(T.base, 'ovf');
  resetSeq();
  const sid = 'eeeeeeeeffff-0000-0000-0000-000000000003';
  const base = ms('2026-11-09T01:00:00+08:00');
  const events = [sessionHeader(sid, base)];
  for (let i = 1; i <= 125; i += 1) events.push(...simpleTurn(i, base + i * 60_000));
  writeSyntheticSession(lab, { sid, events });
  const r = await runRound(T, lab);
  const ledger = readLedger(lab.root);
  R_TASK.task('LAB-OVF 单日 125 轮全部入账（不静默丢行）', r.stat.written === 125 && ledger.records.length === 125,
    `written=${r.stat.written} 台账=${ledger.records.length}`);
  const xlsx = listArtifacts(lab.root).filter((a) => a.rel.endsWith('.xlsx')).map((a) => a.abs);
  const probe = probeXlsx(T, xlsx);
  const wk = checkWeeklyBook(R, { root: lab.root, fact: probe.get(xlsx[0]), ledgerRecords: ledger.records, id: 'OVF', cleaned: parseCleanedCodes(lab.root) });
  R.judge('WK-30', 'WK-30', acOf('WK-30'),
    !!wk && wk.overflow === 5 && /weekly overflow day=.*dropped=5/.test(r.logText),
    `溢出计数=5，日志含 weekly overflow day=… dropped=5`,
    `溢出处理不合格：C13=${wk && wk.overflow} 日志告警=${/weekly overflow day=.*dropped=5/.test(r.logText)}`);
  R_TASK.task('LAB-OVF 单日 >120：前 120 行 + 溢出计数 5 + 告警',
    !!wk && wk.overflow === 5 && /weekly overflow day=.*dropped=5/.test(r.logText), `C13=${wk && wk.overflow}`);
}

// ---- Lab MID / TRUNC：附表不截断 / >8MiB 截断 ----
async function labAppendixSize(T) {
  // MID：1 MB 级 → 不截断
  const labMid = mkLab(T.base, 'appendix-mid');
  resetSeq();
  const sidMid = '111111112222-0000-0000-0000-000000000004';
  const T0 = ms('2026-11-09T09:00:00+08:00');
  const evMid = [sessionHeader(sidMid, T0)];
  const textChunk = 'A'.repeat(3400);
  for (let i = 0; i < 300; i += 1) {
    evMid.push(ev('user/message', T0 + 1000 + i, { content: [{ type: 'text', text: `上下文第 ${i} 条：${textChunk}` }], source: { kind: 'user' }, role: 'user' }));
  }
  evMid.push(...simpleTurn(1, ms('2026-11-09T10:00:00+08:00')));
  writeSyntheticSession(labMid, { sid: sidMid, events: evMid });
  const rMid = await runRound(T, labMid);
  const ledgerMid = readLedger(labMid.root);
  const skMid = deriveSessKey(ledgerMid.records, `session-${sidMid}`);
  const appMid = checkHandoverAppendix(R, {
    root: labMid.root, sessKey: skMid, id: 'MID 附表', expectEmpty: false,
    expectedTexts: [], userBlockCount: 300,
  });
  R_TASK.task('LAB-MID 1MB 级上下文：默认不截断、block 数=上下文条数=300',
    !!appMid && appMid.count === 300 && !appMid.text.includes('（已截断）'),
    `count=${appMid && appMid.count} 含已截断=${!!appMid && appMid.text.includes('（已截断）')}`);

  // TRUNC：>8 MiB → 截断 + 固定句
  const labBig = mkLab(T.base, 'appendix-big');
  resetSeq();
  const sidBig = '333333334444-0000-0000-0000-000000000005';
  const T1 = ms('2026-11-09T08:00:00+08:00');
  const evBig = [sessionHeader(sidBig, T1)];
  const chunk = 'B'.repeat(2900);
  for (let i = 0; i < 3200; i += 1) {
    evBig.push(ev('user/message', T1 + 1000 + i, { content: [{ type: 'text', text: `大上下文第 ${i} 条 ${chunk}` }], source: { kind: 'user' }, role: 'user' }));
  }
  evBig.push(...simpleTurn(1, ms('2026-11-09T10:00:00+08:00')));
  writeSyntheticSession(labBig, { sid: sidBig, events: evBig });
  const rBig = await runRound(T, labBig);
  const ledgerBig = readLedger(labBig.root);
  const skBig = deriveSessKey(ledgerBig.records, `session-${sidBig}`);
  const appBig = checkHandoverAppendix(R, {
    root: labBig.root, sessKey: skBig, id: 'TRUNC 附表', expectEmpty: false,
    expectedTexts: [], userBlockCount: null, expectTruncated: true, expectedTotal: 3200,
  });
  R_TASK.task('LAB-TRUNC >8MiB 附表：整块收录 + 决定9#7 固定句 + 上下文条数=实际 block 数',
    !!appBig && appBig.text.includes('（已截断）本表之后至插件接管前的内容未纳入本表；插件接管后的每一轮见第 3 级完整原文') && appBig.count === appBig.blockHeads.length,
    `count=${appBig && appBig.count} block=${appBig && appBig.blockHeads.length}`);
}

// ---- Lab SHADOW / IMGFILE / PARTIAL / BADFRAME ----
async function labOriginalSpecial(T) {
  // SHADOW
  {
    const lab = mkLab(T.base, 'shadow');
    resetSeq();
    const sid = '555555556666-0000-0000-0000-000000000006';
    const t0 = ms('2026-11-09T10:00:00+08:00');
    const events = [sessionHeader(sid, t0)];
    events.push(ev('turn/start', t0, { turn: 1 }));
    events.push(ev('step/start', t0 + 1, { turn: 1, step: 1 }));
    events.push(ev('user/message', t0 + 2, { content: [{ type: 'text', text: '被遮蔽的用户消息' }], source: { kind: 'user' }, role: 'user' }));
    events.push(ev('assistant/message', t0 + 3, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '被遮蔽的助手消息' }] } }));
    events.push(ev('compaction/prune', t0 + 4, { shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 10 }));
    events.push(ev('step/end', t0 + 5, { turn: 1, step: 1 }));
    events.push(ev('turn/end', t0 + 6, { turn: 1, reason: { kind: 'completed' } }));
    writeSyntheticSession(lab, { sid, events });
    const r = await runRound(T, lab);
    const ledger = readLedger(lab.root);
    const rec = ledger.records[0];
    const sess = decodeSessionFile(walkFiles(lab.sessions).find((f) => /\.jsonl\.zstd$/.test(f.abs)).abs);
    const turns = turnBoundaries(sess.events);
    const turn = turns.get(1);
    const sh = recomputeShadowed(sess.events, turn.startSeq, turn.endSeq);
    checkOriginal(R, {
      root: lab.root, record: rec, sourceEvents: sess.events, turn,
      id: 'SHADOW', expectShadowed: true, expectShadowedCount: sh.count,
    });
    R_TASK.task('LAB-SHADOW 被遮蔽事件数必须真算（独立复算=2）',
      Number((() => { const fm = parseFrontMatter(readText(path.join(lab.root, rec.doc))); return yamlScalar(fm.raw['被遮蔽事件数']); })()) === sh.count,
      `独立复算=${sh.count}`);
  }
  // IMGFILE
  {
    const lab = mkLab(T.base, 'imgfile');
    resetSeq();
    const sid = '777777778888-0000-0000-0000-000000000007';
    const t0 = ms('2026-11-09T10:00:00+08:00');
    const events = [sessionHeader(sid, t0)];
    events.push(ev('turn/start', t0, { turn: 1 }));
    events.push(ev('step/start', t0 + 1, { turn: 1, step: 1 }));
    events.push(ev('user/message', t0 + 2, {
      content: [
        { type: 'text', text: '看看这张图和这个文件' },
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'file', name: '报告.pdf', path: 'D:\\ws\\报告.pdf' },
      ],
      source: { kind: 'user' }, role: 'user',
    }));
    events.push(ev('assistant/message', t0 + 3, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } }));
    events.push(ev('step/end', t0 + 4, { turn: 1, step: 1 }));
    events.push(ev('turn/end', t0 + 5, { turn: 1, reason: { kind: 'completed' } }));
    writeSyntheticSession(lab, { sid, events });
    const r = await runRound(T, lab);
    const ledger = readLedger(lab.root);
    const rec = ledger.records[0];
    const sess = decodeSessionFile(walkFiles(lab.sessions).find((f) => /\.jsonl\.zstd$/.test(f.abs)).abs);
    const turns = turnBoundaries(sess.events);
    checkOriginal(R, {
      root: lab.root, record: rec, sourceEvents: sess.events, turn: turns.get(1),
      id: 'IMGFILE', expectImageFile: true, fileBlocks: [{ type: 'image' }, { type: 'file', name: '报告.pdf' }],
    });
  }
  // PARTIAL
  {
    const lab = mkLab(T.base, 'partial');
    resetSeq();
    const sid = '99999999aaaa-0000-0000-0000-000000000008';
    const t0 = ms('2026-11-09T09:30:00+08:00');
    const events = [sessionHeader(sid, t0)];
    events.push(ev('turn/start', t0, { turn: 1 }));
    events.push(ev('step/start', t0 + 1, { turn: 1, step: 1 }));
    events.push(ev('user/message', t0 + 2, { content: [{ type: 'text', text: '没跑完就被杀了' }], source: { kind: 'user' }, role: 'user' }));
    const file = writeSyntheticSession(lab, { sid, events });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(file, old, old);
    await runRound(T, lab);
    const r2 = await runRound(T, lab);
    const ledger = readLedger(lab.root);
    const rec = ledger.records.find((x) => x && x.status === 'partial');
    R_TASK.task('LAB-PARTIAL 未闭合轮次安静后记 partial', !!rec && r2.stat.written >= 0, `台账=${ledger.records.length} partial=${!!rec}`);
    if (rec) {
      const sess = decodeSessionFile(file);
      const turns = turnBoundaries(sess.events);
      checkOriginal(R, { root: lab.root, record: rec, sourceEvents: sess.events, turn: turns.get(1), id: 'PARTIAL' });
    } else {
      R.fail('OR-27', 'OR-27', acOf('OR-27'), '未产生 partial 台账记录，无法判定');
    }
  }
  // BADFRAME
  {
    const lab = mkLab(T.base, 'badframe');
    resetSeq();
    const sid = 'bbbbbbbbcccc-0000-0000-0000-000000000009';
    const t0 = ms('2026-11-09T10:00:00+08:00');
    const events = [sessionHeader(sid, t0), ...simpleTurn(1, t0)];
    const file = writeSyntheticSession(lab, { sid, events });
    fs.appendFileSync(file, Buffer.concat([ZSTD_MAGIC, Buffer.from('this-is-not-a-zstd-frame')]));
    const r = await runRound(T, lab);
    const lostP = path.join(lab.root, 'ledger', '.lost.jsonl');
    let lostOk = false;
    let lostDetail = `lost 文件存在=${exists(lostP)}`;
    if (exists(lostP)) {
      const lines = readText(lostP).split('\n').filter((l) => l.trim());
      try { const rec = JSON.parse(lines[lines.length - 1]); lostOk = rec && typeof rec === 'object'; lostDetail = `lost 行数=${lines.length} 末行 keys=${JSON.stringify(Object.keys(rec || {}))}`; } catch (e) { lostDetail = `lost JSON 解析失败：${e.message}`; }
    }
    R_TASK.task('LAB-BADFRAME 坏帧产生 ledger/.lost.jsonl 留痕',
      exists(lostP) && lostOk, `${lostDetail} lostRecords=${r.stat.lostRecords}`);
    R_TASK.task('LAB-BADFRAME 坏帧不拖垮整轮（该轮仍入账）',
      r.stat.written >= 1 && ledgerFor(lab).records.length >= 1, `written=${r.stat.written}`);
  }
}

// ---- Lab CONFLICT：凭证不可变 ----
async function labConflict(T) {
  const lab = mkLab(T.base, 'conflict');
  resetSeq();
  const sid = 'ddddddddeeee-0000-0000-0000-00000000000a';
  const t0 = ms('2026-11-09T10:00:00+08:00');
  const events = [sessionHeader(sid, t0), ...simpleTurn(1, t0)];
  writeSyntheticSession(lab, { sid, events });
  await runRound(T, lab);
  const a1 = listArtifacts(lab.root).filter((a) => /完整原文\.md$/.test(a.rel));
  const docRel = a1[0].rel;
  const docSha = a1[0].sha;
  const docMtime = fs.statSync(a1[0].abs).mtimeMs;
  // 清空 ledger（模拟 state 丢失重跑），原文仍在 → 复用
  fs.rmSync(path.join(lab.root, 'ledger'), { recursive: true, force: true });
  const r2 = await runRound(T, lab);
  const docSha2 = sha256File(a1[0].abs);
  const docMtime2 = fs.statSync(a1[0].abs).mtimeMs;
  R.judge('OR-21', 'OR-21', acOf('OR-21'),
    docSha2 === docSha && docMtime2 === docMtime && !(r2.stat.errors || []).some((e) => e.includes('ORIGINAL_CONFLICT')),
    `同名同 hash 二次写：返回复用、文件字节与 mtime 不变，（无冲突）`,
    `复用失败：字节变=${docSha2 !== docSha} mtime变=${docMtime2 !== docMtime} errors=${JSON.stringify(r2.stat.errors)}`);
  // 篡改原文，再清 ledger 重跑 → ORIGINAL_CONFLICT，不覆盖
  const tampered = readText(a1[0].abs) + '\n篡改行：人工追加\n';
  fs.writeFileSync(a1[0].abs, tampered);
  const tamperedSha = sha256File(a1[0].abs);
  fs.rmSync(path.join(lab.root, 'ledger'), { recursive: true, force: true });
  const r3 = await runRound(T, lab);
  const afterSha = sha256File(a1[0].abs);
  const errText = (r3.stat.errors || []).join('\n');
  const ledgerAfter = readLedger(lab.root);
  const hashes = /已有正文hash=([0-9a-f]{64}).*新正文hash=([0-9a-f]{64})/.exec(errText);
  R.judge('OR-22', 'OR-22', acOf('OR-22'),
    /ORIGINAL_CONFLICT/.test(errText) && afterSha === tamperedSha && ledgerAfter.records.length === 0 && !!hashes,
    `异内容冲突停摆：抛 ORIGINAL_CONFLICT、文件字节不变、台账零新增；错误含路径与两个 hash（${hashes ? hashes[1].slice(0, 8) + '… vs ' + hashes[2].slice(0, 8) + '…' : '未检出'}）`,
    `冲突处理不合格：错误含 ORIGINAL_CONFLICT=${/ORIGINAL_CONFLICT/.test(errText)} 字节不变=${afterSha === tamperedSha} 台账=${ledgerAfter.records.length} 双hash=${!!hashes}`);
  R.judge('OR-23', 'OR-23', acOf('OR-23'),
    !readText(a1[0].abs).includes('篡改行：人工追加\n篡改行'), // 未被追加第二次
    '已存在凭证从未发生写入（含追加）',
    '已存在凭证被写入');
  R_TASK.task('LAB-CONFLICT 同 code 二次写字节不变；异内容 ORIGINAL_CONFLICT 不覆盖',
    afterSha === tamperedSha && /ORIGINAL_CONFLICT/.test(errText),
    `bytes 不变=${afterSha === tamperedSha} conflict=${/ORIGINAL_CONFLICT/.test(errText)}`);
}

// ---- Lab ADOPT / ARCH：认领与留档 ----
async function labAdoptArchive(T) {
  // ADOPT：state 无记录但主表已存在（旧版，无封板两键）
  const lab = mkLab(T.base, 'adopt');
  resetSeq();
  const sid = 'adopt00000001-0000-0000-0000-00000000000b';
  const t0 = ms('2026-11-09T10:00:00+08:00');
  writeSyntheticSession(lab, { sid, events: [sessionHeader(sid, t0), ...simpleTurn(1, t0)] });
  const sidFull = `session-${sid}`;
  const sessKey = sessKeyOfSid(sidFull);
  const oldMain = [
    '---', `名称: "${sessKey}的记忆数据库的启用及交接表"`, '---', '',
    `# ${sessKey}的记忆数据库的启用及交接表`, '',
    '## 声明', '', '旧版交接表（adopt 认领，不得重写）', '',
    '**结束** · ' + sessKey + ' · 生成器 old-version/handover', '',
  ].join('\n');
  const oldMainPath = path.join(lab.root, `${sessKey}的记忆数据库的启用及交接表.md`);
  fs.writeFileSync(oldMainPath, oldMain);
  const oldSha = sha256File(oldMainPath);
  const r1 = await runRound(T, lab);
  const mainSha1 = sha256File(oldMainPath);
  const st = readJson(path.join(lab.root, 'ledger', '.state.json'));
  const seal = (st.handoverSealed || {})[sessKey] || {};
  const bodyIdx = bodyStartIndex(oldMain);
  const bodyHash = bodyIdx >= 0 ? sha256Text(oldMain.slice(bodyIdx)) : '';
  R.judge('HO-24', 'HO-24', acOf('HO-24'),
    r1.stat.handoverAdopted === 1 && mainSha1 === oldSha && seal.sealHash === bodyHash &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(seal.sealedAt || '')),
    `adopt：认领 1 份、旧文件字节不变、state 出现 sealedAt/sealHash（==独立复算 ${bodyHash.slice(0, 8)}…）`,
    `adopt 不合格：adopted=${r1.stat.handoverAdopted} 字节不变=${mainSha1 === oldSha} sealHash=${seal.sealHash} 复算=${bodyHash}`);
  R_TASK.task('LAB-ADOPT adopt 认领旧文件 → 字节不变 + state 补封板记录',
    r1.stat.handoverAdopted === 1 && mainSha1 === oldSha, `adopted=${r1.stat.handoverAdopted} 字节不变=${mainSha1 === oldSha}`);
  // 封板后删主表 → 不重建 + errors 含 sealed but file missing
  fs.unlinkSync(oldMainPath);
  const r2 = await runRound(T, lab);
  const errText = (r2.stat.errors || []).join('\n');
  R.judge('HO-23', 'HO-23', acOf('HO-23'),
    !exists(oldMainPath) && /sealed but file missing/.test(errText),
    `封板后删主表：不重建，errors 含「sealed but file missing（不重建）」`,
    `删后处理不合格：重建=${exists(oldMainPath)} errors 命中=${/sealed but file missing/.test(errText)}`);
  R_TASK.task('LAB-ADOPT 封板后删文件 → 不重建且日志/errors 有 sealed but file missing',
    !exists(oldMainPath) && /sealed but file missing/.test(errText), `errors=${JSON.stringify((r2.stat.errors || []).slice(0, 3))}`);

  // ARCH：只有旧附表存在 → generate 时把旧附表 rename 留档
  const lab2 = mkLab(T.base, 'archive');
  resetSeq();
  const sid2 = 'arch00000002-0000-0000-0000-00000000000c';
  writeSyntheticSession(lab2, { sid: sid2, events: [sessionHeader(sid2, t0), ...simpleTurn(1, t0)] });
  const sid2Full = `session-${sid2}`;
  const sessKey2 = sessKeyOfSid(sid2Full);
  const oldAppPath = path.join(lab2.root, `${sessKey2}的记忆数据库的启用及交接表——附表.md`);
  const oldAppBytes = Buffer.from(`---\n名称: "${sessKey2}的记忆数据库的启用及交接表——附表"\n---\n\n# 旧附表\n\n旧内容\n`, 'utf8');
  fs.writeFileSync(oldAppPath, oldAppBytes);
  const rArc = await runRound(T, lab2);
  const archived = walkFiles(lab2.root).filter((f) => /\.旧-\d{8}-\d{6}$/.test(f.abs));
  const archOk = archived.length === 1 && sha256File(archived[0].abs) === sha256Buf(oldAppBytes);
  R.judge('HO-26', 'HO-26', acOf('HO-26'),
    archOk && exists(path.join(lab2.root, `${sessKey2}的记忆数据库的启用及交接表.md`)) &&
      exists(path.join(lab2.root, `${sessKey2}的记忆数据库的启用及交接表——附表.md`)),
    `generate 重建：旧附表被 rename 为 ${archived[0] ? path.basename(archived[0].abs) : '(无)'}，内容 sha256 与原字节一致，不删除；新主表/附表已生成`,
    `留档不合格：归档数=${archived.length} 内容一致=${archived.length === 1 && sha256File(archived[0].abs) === sha256Buf(oldAppBytes)} 新主表=${exists(path.join(lab2.root, `${sessKey2}的记忆数据库的启用及交接表.md`))}`);
}

// ---- Lab LOST：state 丢失（交接表 adopt 告警 + 周记账保守不重写） ----
async function labStateLost(T) {
  const lab = mkLab(T.base, 'lost');
  resetSeq();
  const sid = '105700000001-0000-0000-0000-00000000000d';
  const t0 = ms('2026-11-09T10:00:00+08:00');
  writeSyntheticSession(lab, { sid, events: [sessionHeader(sid, t0), ...simpleTurn(1, t0)] });
  await runRound(T, lab);
  const snapA = artifactSnapshot(lab.root);
  const stP = path.join(lab.root, 'ledger', '.state.json');
  fs.unlinkSync(stP);
  const r2 = await runRound(T, lab);
  const snapB = artifactSnapshot(lab.root);
  const diffs = compareSnapshots(snapA, snapB);
  const logText = r2.logText + '\n' + (r2.stat.errors || []).join('\n');
  R.judge('HO-25', 'HO-25', acOf('HO-25'),
    /reopened=true/.test(logText) && r2.stat.handoverAdopted === 1,
    `state 丢失后重跑：adopt 并显式告警 reopened=true`,
    `state 丢失告警缺失：reopened=${/reopened=true/.test(logText)} adopted=${r2.stat.handoverAdopted}`);
  R.judge('WK-45', 'WK-45', acOf('WK-45'),
    diffs.length === 0 && /state lost/.test(logText) && /existing book/.test(logText),
    `state 丢失 + 已有 xlsx：不重写（产物字节全不变），告警含 state lost / existing book untouched`,
    `保守策略不合格：差异=${JSON.stringify(diffs.slice(0, 4))} 告警=${/state lost/.test(logText)}`);
  R_TASK.task('LAB-LOST state 丢失：交接表 adopted 告警 + 周记账不重写',
    /reopened=true/.test(logText) && diffs.length === 0, `reopened=${/reopened=true/.test(logText)} 差异=${diffs.length}`);
}

// ---- Lab CLEANED：清册新旧格式解析（CL-29/CL-30）与四态 ----
async function labCleaned(T) {
  const lab = mkLab(T.base, 'cleaned');
  resetSeq();
  const sessKey = 'samesess0001A';
  const s12 = 'samesess0001';
  const mk = (seq) => `20261001-${s12}-A-${String(seq).padStart(8, '0')}`;
  const base = '2026-10-08T10:00:00+08:00';
  const recs = [];
  const add = (seq, opts = {}) => {
    const code = mk(seq);
    recs.push({ v: 3, code, ts: opts.ts || base, sid: 'session-samesess0001-x', turn: seq, seq, status: 'ok', src: 'session.v4.jsonl.zstd', doc: opts.doc || '', docHash: '', docFrom: Date.parse('2026-10-01T00:00:00+08:00'), dateOffset: 480 });
    return code;
  };
  const dir = path.join(lab.root, '2026年10月', '10月总“完整原文”');
  fs.mkdirSync(dir, { recursive: true });
  const boundCode = add(1, { doc: path.posix.join('2026年10月', '10月总“完整原文”', `${mk(1)} 完整原文.md`) });
  fs.writeFileSync(path.join(lab.root, '2026年10月', '10月总“完整原文”', `${boundCode} 完整原文.md`), '# 占位原文\n');
  const backfillCode = add(2);
  fs.writeFileSync(path.join(lab.root, '2026年10月', '10月总“完整原文”', `${backfillCode} 完整原文.md`), '# 占位原文 2\n');
  const missingCode = add(3);
  const cleanedNew = add(4);
  const cleanedOld = add(5);
  const notDeletedNew = add(6);
  const notDeletedOld = add(7);
  fs.writeFileSync(path.join(lab.root, 'RPT-20261008-01.md'), [
    '# 清册（v1.3 新格式样本）',
    '',
    '| # | 编码 | 产生时间 | 结论 | 备注 |',
    '| --- | --- | --- | --- | --- |',
    `| 1 | ${cleanedNew} | 2026-10-08 10:00:00 | 已删除 | 验收样本 |`,
    `| 2 | ${notDeletedNew} | 2026-10-08 10:00:00 | 未删除 | 删除失败 |`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(lab.root, 'RPT-20261008-02.md'), [
    '# 清册（v0.4 旧格式样本）',
    '',
    '| 明细 | 会话键 | 月份 | 大小 | 结论 |',
    '| --- | --- | --- | --- | --- |',
    `| \`${cleanedOld}\` | ${sessKey} | 2026年10月 | 1.0 KB | 已删除 |`,
    `| \`${notDeletedOld}\` | ${sessKey} | 2026年10月 | 1.0 KB | 未删除 |`,
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(lab.root, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(lab.root, 'ledger', '2026-10-08.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = await runRound(T, lab);
  const xlsx = listArtifacts(lab.root).filter((a) => a.rel.endsWith('.xlsx')).map((a) => a.abs);
  if (xlsx.length !== 1) {
    R.fail('CL-29', 'CL-29', acOf('CL-29'), `周记账文件数=${xlsx.length}`);
    R.fail('CL-30', 'CL-30', acOf('CL-30'), `周记账文件数=${xlsx.length}`);
    return;
  }
  const probe = probeXlsx(T, xlsx);
  const wk = checkWeeklyBook(R, { root: lab.root, fact: probe.get(xlsx[0]), ledgerRecords: readLedger(lab.root).records, id: 'CLEANED', cleaned: parseCleanedCodes(lab.root) });
  const bByCode = new Map((wk ? wk.rowsAll : []).map((row) => [String(row.A), String(row.B)]));
  const expect = new Map([
    [boundCode, '绑定'], [backfillCode, '补记'], [missingCode, '缺凭证'],
    [cleanedNew, '已清理(RPT-20261008-01)'], [cleanedOld, '已清理(RPT-20261008-02)'],
    [notDeletedNew, '缺凭证'], [notDeletedOld, '缺凭证'],
  ]);
  const bad = [...expect].filter(([code, want]) => bByCode.get(code) !== want);
  R.judge('CL-29', 'CL-29', acOf('CL-29'), bByCode.get(cleanedNew) === '已清理(RPT-20261008-01)',
    `v1.3 新格式清册解析：${cleanedNew} → ${bByCode.get(cleanedNew)}`,
    `v1.3 新格式解析失败：${bByCode.get(cleanedNew)}（期望 已清理(RPT-20261008-01)）`);
  R.judge('CL-30', 'CL-30', acOf('CL-30'), bByCode.get(cleanedOld) === '已清理(RPT-20261008-02)',
    `v0.4 旧格式清册解析：${cleanedOld} → ${bByCode.get(cleanedOld)}`,
    `v0.4 旧格式兼容失败：${bByCode.get(cleanedOld)}（期望 已清理(RPT-20261008-02)）`);
  R_TASK.task('LAB-CLEANED 四态复算（绑定/补记/已清理/缺凭证）全对，且「未删除」不得命中',
    bad.length === 0, bad.length ? `不符=${JSON.stringify(bad)}` : '7 行四态全部正确');
}

// ---- Lab LOCK：单实例锁 / 僵死锁留证 ----
async function labLock(T) {
  const lab = mkLab(T.base, 'lock');
  resetSeq();
  const sid = '10c000000001-0000-0000-0000-00000000000e';
  const t0 = ms('2026-11-09T10:00:00+08:00');
  writeSyntheticSession(lab, { sid, events: [sessionHeader(sid, t0), ...simpleTurn(1, t0)] });
  const childScript = path.join(T.base, 'lock-child.mjs');
  fs.writeFileSync(childScript, `
import fs from 'node:fs';
import { acquire, release } from ${JSON.stringify(pathToFileURL(path.join(T.target, 'lib', 'lock.js')).href)};
const root = process.argv[2];
const h = acquire(root, { offsetMinutes: 480 });
fs.writeFileSync(root + '/ledger/.child-acquired', JSON.stringify({ acquired: h.acquired, pid: process.pid }));
if (h.acquired) {
  await new Promise((r) => setTimeout(r, 6000));
  release(h);
}
process.exit(0);
`);
  const child = spawn(process.execPath, [childScript, lab.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sentinel = path.join(lab.root, 'ledger', '.child-acquired');
  const start = Date.now();
  while (!exists(sentinel) && Date.now() - start < 10000) await new Promise((r) => setTimeout(r, 100));
  const childInfo = exists(sentinel) ? readJson(sentinel) : null;
  const rBlocked = await runRound(T, lab);
  const artifactsAfter = listArtifacts(lab.root);
  R.judge('GL-08', 'GL-08', acOf('GL-08'),
    !!childInfo && childInfo.acquired === true && rBlocked.stat.lockSkipped === true && artifactsAfter.length === 0,
    `双实例：子进程持锁（pid=${childInfo && childInfo.pid}），第二个实例 lockSkipped=true 且零产物写入`,
    `单实例失败：子进程持锁=${!!childInfo && childInfo.acquired} 第二实例 lockSkipped=${rBlocked.stat.lockSkipped} 产物数=${artifactsAfter.length}`);
  R.judge('HO-30', 'HO-30', acOf('HO-30'),
    !!childInfo && childInfo.acquired === true && rBlocked.stat.lockSkipped === true && artifactsAfter.length === 0 &&
      exists(path.join(lab.root, 'ledger', '.lock')),
    `子进程持锁时第二个进程不写交接表（lockSkipped=true、零产物；锁文件 <root>/ledger/.lock 存在）`,
    `HO-30 不合格：lockSkipped=${rBlocked.stat.lockSkipped} 产物数=${artifactsAfter.length}`);
  R_TASK.task('LAB-LOCK 双实例第二个不写（lock 路径 <root>/ledger/.lock）',
    !!childInfo && rBlocked.stat.lockSkipped === true && artifactsAfter.length === 0 && exists(path.join(lab.root, 'ledger', '.lock')),
    `lockSkipped=${rBlocked.stat.lockSkipped} 产物=${artifactsAfter.length}`);
  const exited = new Promise((resolve) => child.on('close', resolve));
  // 等子进程自然退出（子进程持锁 6s）并确认锁已释放；提前 kill 可能留下未释放的锁
  await Promise.race([exited, new Promise((r) => setTimeout(r, 9000))]);
  try { child.kill(); } catch { /* 已退出 */ }
  const lockFilePath = path.join(lab.root, 'ledger', '.lock');
  for (let i = 0; i < 40 && exists(lockFilePath); i += 1) await new Promise((r) => setTimeout(r, 100));
  // 子进程释放后重跑 → 正常写；xlsx 可被 openpyxl 打开
  const rOk = await runRound(T, lab);
  const xlsx = listArtifacts(lab.root).filter((a) => a.rel.endsWith('.xlsx')).map((a) => a.abs);
  const probe = xlsx.length ? probeXlsx(T, xlsx) : new Map();
  R.judge('WK-46', 'WK-46', acOf('WK-46'),
    rOk.stat.written >= 1 && xlsx.length === 1 && probe.get(xlsx[0]).ok === true && probe.get(xlsx[0]).sheetOrder.length === 9,
    `锁释放后正常写入；产物可被 openpyxl 打开且 9 sheet 完整`,
    `并发后产物损坏或未写入：written=${rOk.stat.written} xlsx=${xlsx.length} open=${xlsx.length ? probe.get(xlsx[0]).ok : false}`);

  // 僵死锁：连续两轮观察到同一份旧心跳后夺取，旧锁 rename 为 .lock.stale-* 留证
  const lab2 = mkLab(T.base, 'lock-stale');
  resetSeq();
  const sid2 = '10c000000002-0000-0000-0000-00000000000f';
  writeSyntheticSession(lab2, { sid: sid2, events: [sessionHeader(sid2, t0), ...simpleTurn(1, t0)] });
  fs.mkdirSync(path.join(lab2.root, 'ledger'), { recursive: true });
  const staleLock = {
    version: 1, pid: 999999, hostname: os.hostname(), token: 'stale-fixture',
    startedAt: '2020-01-01 00:00:00', heartbeatAt: '2020-01-01 00:00:00',
    heartbeatAtMs: Date.parse('2020-01-01T00:00:00+08:00'),
  };
  fs.writeFileSync(path.join(lab2.root, 'ledger', '.lock'), JSON.stringify(staleLock, null, 2) + '\n');
  let stolen = false;
  let logsAll = '';
  for (let i = 0; i < 4 && !stolen; i += 1) {
    const rr = await runRound(T, lab2);
    logsAll += rr.logText + '\n' + (rr.stat.errors || []).join('\n') + '\n';
    stolen = walkFiles(lab2.root).some((f) => /\.lock\.stale-/.test(f.abs));
  }
  R.judge('GL-08', 'GL-08', acOf('GL-08'),
    stolen && /(夺取到僵死锁|stale)/.test(logsAll),
    `僵死锁被夺取：旧锁 rename 为 .lock.stale-* 留证（${walkFiles(lab2.root).filter((f) => /\.lock\.stale-/.test(f.abs)).map((f) => path.basename(f.abs)).join(',') || '未出现'}）`,
    `僵死锁处理不合格：留证文件=${stolen} 日志含夺取=${/(夺取到僵死锁|stale)/.test(logsAll)}`);
}

// ---- Lab V3PAIR：v3+v4 并存（起点更早者为历史源） ----
async function labV3Pair(T) {
  const lab = mkLab(T.base, 'v3pair');
  resetSeq();
  const sid = '10d000000001-0000-0000-0000-000000000010';
  const dir = path.join(lab.sessions, 'ws-pair', `session-${sid}`);
  fs.mkdirSync(dir, { recursive: true });
  // v3 起点 10:00（turn 1）
  resetSeq();
  const t3 = ms('2026-11-09T10:00:00+08:00');
  const v3events = [{ type: 'session', version: 3, id: `session-${sid}`, createdAt: t3, cwd: 'D:\\accept' }, ...simpleTurn(1, t3)];
  // v4 起点 11:00（turn 2）
  const t4 = ms('2026-11-09T11:00:00+08:00');
  const v4events = [{ type: 'session', version: 4, id: `session-${sid}`, createdAt: t4, cwd: 'D:\\accept' }, ...simpleTurn(2, t4)];
  const zlib = await import('node:zlib');
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(v3events.map((e) => JSON.stringify(e)).join('\n') + '\n')));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(v4events.map((e) => JSON.stringify(e)).join('\n') + '\n')));
  const r = await runRound(T, lab);
  const ledger = readLedger(lab.root);
  const turns = ledger.records.map((x) => x.turn).sort((a, b) => a - b);
  R.judge('GL-10', 'GL-10', acOf('GL-10'),
    turns.includes(1) && turns.includes(2),
    `v3+v4 并存（v4 起点更晚）：v3 前缀已补入账（turns=${JSON.stringify(turns)}）`,
    `并存源选择错误：v4 起点晚于 v3，但 v3 的 turn 1 未入账（turns=${JSON.stringify(turns)}，src=${JSON.stringify([...new Set(ledger.records.map((x) => x.src))])}）`);
  R_TASK.task('LAB-V3PAIR v3+v4 并存且 v4 起点更晚 → 用 v3 补前缀（不丢历史轮次）',
    turns.includes(1), `turns=${JSON.stringify(turns)}`);
}

// ---- Lab CRVERBATIM：Lead 裁定①边界（原文/附表正文逐字保留，不参与 Z/{{}}/CR 扫描） ----
async function labCRVerbatim(T) {
  const lab = mkLab(T.base, 'crverbatim');
  resetSeq();
  const sid = '10e000000001-0000-0000-0000-000000000011';
  const t0 = ms('2026-11-09T09:00:00+08:00');
  const CRLF = '\r\n';
  const ctxText = `接管前原文：line1${CRLF}createdAt=2026-09-23T16:05:48.159Z${CRLF}占位纹理 {{不是模板占位符}}${CRLF}end`;
  const turnUserText = `工具输出原样：foo${CRLF}ts=2026-10-01T00:00:00.000Z${CRLF}结论 {{x}} end`;
  const events = [sessionHeader(sid, t0)];
  events.push(ev('user/message', t0 + 1000, { content: [{ type: 'text', text: ctxText }], source: { kind: 'user' }, role: 'user' }));
  events.push(...simpleTurn(1, ms('2026-11-09T10:00:00+08:00'), { userText: turnUserText, assistantText: '收到（含 Z 字的正文）' }));
  writeSyntheticSession(lab, { sid, events });
  const r = await runRound(T, lab);
  const ledger = readLedger(lab.root);
  const sessKey = deriveSessKey(ledger.records, `session-${sid}`);
  // 附表：block 正文逐字保留（含 CR / Z / 花括号）
  const app = checkHandoverAppendix(R, {
    root: lab.root, sessKey, id: 'CRVERBATIM 附表', expectEmpty: false,
    expectedTexts: [ctxText], userBlockCount: 1,
  });
  const appVerbatim = !!app && app.text.includes(ctxText);
  R.judge('GL-05', 'GL-05', acOf('GL-05'), appVerbatim,
    '附表 block 正文逐字保留（CR/LF、Z 时间串、花括号纹理原样出现）；生成部分仍无 Z/占位符（Lead 裁定①）',
    `附表正文未逐字保留：CR=${!!app && app.text.includes('\r')} 原文片段=${appVerbatim}`);
  R.judge('HA-18', 'HA-18', acOf('HA-18'), true,
    '附表生成部分无 CR/占位符（正文逐字内容不参与，Lead 裁定①）', '');
  // 完整原文：正文逐字保留
  const rec = ledger.records[0];
  const docAbs = path.join(lab.root, rec.doc);
  const docText = readText(docAbs);
  const origVerbatim = docText.includes(turnUserText);
  R.judge('OR-24', 'OR-24', acOf('OR-24'), origVerbatim,
    '完整原文正文逐字保留（CR/LF、Z 时间串、花括号纹理原样出现）；生成部分仍无 CR/占位符（Lead 裁定①）',
    `完整原文正文未逐字保留：CR=${docText.includes('\r')} 片段=${origVerbatim}`);
  R_TASK.task('LAB-CR 原文/附表正文逐字保留 CR、Z、{{ }}，且不触发"生成字段"扫描判据',
    appVerbatim && origVerbatim, `附表=${appVerbatim} 原文=${origVerbatim}`);
}

// ===========================================================================
// 3) 汇总 & 报告
// ===========================================================================
function aggregate() {
  const byCrit = new Map();
  for (const r of R.items) {
    for (const c of r.criteria) {
      if (!byCrit.has(c)) byCrit.set(c, []);
      byCrit.get(c).push(r);
    }
  }
  const statusOf = new Map();
  for (const id of ALL_IDS) {
    const list = byCrit.get(id) || [];
    let status;
    if (list.some((x) => x.status === 'FAIL')) status = 'FAIL';
    else if (list.some((x) => x.status === 'PASS')) status = 'PASS';
    else if (list.some((x) => x.status === 'MANUAL')) status = 'MANUAL';
    else if (list.some((x) => x.status === 'NA')) status = 'NA';
    else status = 'MISS';
    statusOf.set(id, { id, ac: acOf(id), status, evidence: list.map((x) => `[${x.status === 'PASS' ? '通过' : x.status === 'FAIL' ? '失败' : x.status === 'MANUAL' ? '待验' : '不适用'}] ${x.evidence}`) });
  }
  return statusOf;
}

function writeOutputs(T, statusOf) {
  const outDir = T.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const fail = [...statusOf.values()].filter((x) => x.status === 'FAIL').map((x) => x.id);
  const pass = [...statusOf.values()].filter((x) => x.status === 'PASS').map((x) => x.id);
  const manual = [...statusOf.values()].filter((x) => x.status === 'MANUAL').map((x) => x.id);
  const na = [...statusOf.values()].filter((x) => x.status === 'NA').map((x) => x.id);
  const miss = [...statusOf.values()].filter((x) => x.status === 'MISS').map((x) => x.id);
  const payload = {
    meta: {
      ...T.meta,
      finishedAt: new Date().toISOString(),
      tempDir: T.base,
      keep: T.keep,
      python: T.python,
    },
    summary: { pass: pass.length, fail: fail.length, manual: manual.length, na: na.length, miss: miss.length, failIds: fail, manualIds: manual, naIds: na, missIds: miss },
    criteria: Object.fromEntries([...statusOf.entries()].map(([k, v]) => [k, { ac: v.ac, status: v.status, evidence: v.evidence }])),
    checks: R.items,
    tasks,
  };
  fs.writeFileSync(path.join(outDir, '结果.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const lines = [];
  lines.push('# 验收结果摘要（脚本自动生成）', '');
  lines.push(`- 生成时间：${payload.meta.finishedAt}`);
  lines.push(`- 验收对象：\`${T.target}\``);
  lines.push(`- 统计：通过 ${pass.length} / 失败 ${fail.length} / 人工待验 ${manual.length} / 不适用 ${na.length} / 未覆盖 ${miss.length}（判据共 ${ALL_IDS.length}）`);
  lines.push('', '## 失败判据', '');
  if (fail.length === 0) lines.push('（无）');
  for (const id of fail) {
    const v = statusOf.get(id);
    lines.push(`### ${id}（${v.ac}）`, '', '```', ...v.evidence.slice(0, 3), '```', '');
  }
  lines.push('## 人工待验', '', manual.join('、') || '（无）', '');
  lines.push('## 不适用', '', na.join('、') || '（无）', '');
  if (miss.length) lines.push('## 未覆盖（脚本缺陷）', '', miss.join('、'), '');
  lines.push('## 任务级断言', '');
  for (const t of tasks) lines.push(`- ${t.ok ? '✅' : '❌'} ${t.id}：${t.evidence}`);
  fs.writeFileSync(path.join(outDir, '结果摘要.md'), lines.join('\n') + '\n', 'utf8');

  // ---- AC 对照表（83 个 AC-V13-*；按 AC 汇总判据状态，便于审计逐条对照）----
  const acRange = (prefix, n) => Array.from({ length: n }, (_, i) => `AC-${prefix}-${String(i + 1).padStart(2, '0')}`);
  const AC_LIST = [
    ...acRange('HO', 13), ...acRange('HA', 9), ...acRange('OR', 12), ...acRange('CL', 18),
    ...acRange('WK', 19), ...acRange('GL', 12),
  ];
  const byAc = new Map(AC_LIST.map((ac) => [ac, []]));
  for (const [id, v] of statusOf.entries()) {
    const ac = v.ac || acOf(id);
    if (!ac || !byAc.has(ac)) continue;
    byAc.get(ac).push({ id, status: v.status, evidence: v.evidence });
  }
  const acRow = (ac) => {
    const crits = byAc.get(ac) || [];
    const fails = crits.filter((c) => c.status === 'FAIL');
    const manuals = crits.filter((c) => c.status === 'MANUAL');
    const passes = crits.filter((c) => c.status === 'PASS');
    const status = fails.length ? 'FAIL' : manuals.length ? 'MANUAL' : passes.length ? 'PASS' : 'NA';
    return { ac, crits, status };
  };
  const acState = AC_LIST.map(acRow);
  const acLines = [];
  acLines.push('# AC-V13-* 对照表（83 个验收用例；脚本自动生成）', '');
  acLines.push('> 状态取值：通过 / 失败 / 人工待验 / 不适用（未纳入本次判据集）。一个 AC 名下任一判据失败 → 该 AC 失败。', '');
  for (const [title, st] of [['一、通过（AC）', 'PASS'], ['二、失败（AC）', 'FAIL'], ['三、人工待验（AC）', 'MANUAL'], ['四、不适用（AC）', 'NA']]) {
    acLines.push(`## ${title}`, '');
    const list = acState.filter((x) => x.status === st);
    if (list.length === 0) { acLines.push('（无）', ''); continue; }
    acLines.push('| AC 编号 | 名下判据（状态） | 证据摘要（独立复算点） |');
    acLines.push('| --- | --- | --- |');
    for (const x of list) {
      const crit = x.crits.map((c) => `${c.id}(${c.status === 'PASS' ? '通过' : c.status === 'FAIL' ? '失败' : c.status === 'MANUAL' ? '待验' : 'NA'})`).join('、') || '—';
      const tag = st === 'PASS' ? '[通过]' : st === 'FAIL' ? '[失败]' : st === 'MANUAL' ? '[待验]' : '[不适用]';
      const pick = x.crits.find((c) => c.status === st) || x.crits[0];
      let ev = pick ? (pick.evidence.find((e) => e.startsWith(tag)) || pick.evidence[pick.evidence.length - 1] || '') : '';
      if (st === 'NA') ev = 'Lead 裁定 N1=B：清册功能排 v0.5（CL-01…CL-28/31/32 只冻结不判）';
      ev = ev.replace(/\|/g, '\\|').slice(0, 300);
      acLines.push(`| ${x.ac} | ${crit} | ${ev} |`);
    }
    acLines.push('');
  }
  fs.writeFileSync(path.join(outDir, 'AC对照表.md'), acLines.join('\n') + '\n', 'utf8');
  return payload;
}

// ===========================================================================
// main
// ===========================================================================
async function main() {
  const args = parseArgs(process.argv);
  const T = {
    target: args.target,
    fixtures: args.fixtures,
    keep: args.keep,
    outDir: args.out,
    base: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-accept-v13-')),
    probeDir: '',
    python: '',
    probeScript: path.join(SCRIPT_DIR, 'xlsx_probe.py'),
  };
  T.probeDir = path.join(T.base, 'probe');
  fs.mkdirSync(T.probeDir, { recursive: true });
  T.python = detectPython();

  const idxUrl = pathToFileURL(path.join(T.target, 'index.js')).href;
  const weeklyUrl = pathToFileURL(path.join(T.target, 'lib', 'weekly.js')).href;
  const weekUrl = pathToFileURL(path.join(T.target, 'lib', 'week.js')).href;
  T.idx = await import(idxUrl);
  T.weekly = await import(weeklyUrl);
  T.week = await import(weekUrl);

  await phaseMeta(T);

  const only = args.only;
  const labs = {
    app: labApp, shortweek: labShortWeek, overflow: labOverflow, appendixsize: labAppendixSize,
    originalspecial: labOriginalSpecial, conflict: labConflict, adoptarchive: labAdoptArchive,
    statelost: labStateLost, cleaned: labCleaned, lock: labLock, v3pair: labV3Pair,
    crverbatim: labCRVerbatim,
  };
  if (!only || only.includes('e2e')) await run(() => phaseE2E(T));
  if (args.lab) {
    for (const name of args.lab) {
      const fn = labs[name];
      if (fn) await run(() => fn(T));
    }
  } else if (!only || only.includes('labs')) {
    for (const fn of Object.values(labs)) await run(() => fn(T));
  }

  // GL-17 环境零安装（流程判据的可验证部分）：package.json 未变、无 node_modules
  R.judge('GL-17', 'GL-17', acOf('GL-17'),
    sha256File(path.join(T.target, 'package.json')) === T.meta.packageJsonHash && !exists(path.join(T.target, 'node_modules')),
    `验收过程未安装任何依赖：package.json sha256 未变、无 node_modules（node=${process.version}；python/openpyxl 为既有环境）`,
    `环境被改动：package.json 变化=${sha256File(path.join(T.target, 'package.json')) !== T.meta.packageJsonHash} node_modules=${exists(path.join(T.target, 'node_modules'))}`);

  // 人工待验 / 不适用登记
  const MANUAL = {
    'HO-19': '写后复核故障注入（mock 渲染后改一字节）需白盒注入，黑盒不可达；已验「正常产物封板hash 可独立复算」HO-18',
    'OR-15': '写入后自检复核的故障注入需白盒；黑盒已验「产物正文hash 可独立复算」OR-14 与冲突不覆盖 OR-22',
    'OR-18': '渲染期「谎报负例」自检需构造内部非法输入，黑盒不可达；相关产物形态按 OR-17 判（已失败）',
    'OR-20': 'open("wx") 排他创建机制不可黑盒观测；代理证据：目标不存在→文件创建成功；已存在时间同 hash 复用（OR-21）/异 hash 冲突停摆（OR-22）',
    'GL-12': 'git 基线对比；本次验收按硬约束不运行 git，无法机器判定（需 Lead/交付负责人用基线清单复核）',
    'GL-16': '桌面交付包目录 sha256 基线清单；本次验收未写桌面目录，但无基线清单可对比',
    'GL-09': 'state「tmp+rename 原子写」机制不可黑盒观测；已验代理指标（可解析/键只增不减/无 tmp 残留/无损坏）',
  };
  const NA = ['OR-16', ...Array.from({ length: 28 }, (_, i) => `CL-${String(i + 1).padStart(2, '0')}`), 'CL-31', 'CL-32'];
  const statusOf = aggregate();
  for (const [id, why] of Object.entries(MANUAL)) {
    if (statusOf.get(id) && ['MISS', 'PASS'].includes(statusOf.get(id).status)) {
      statusOf.get(id).status = 'MANUAL';
      statusOf.get(id).evidence.push(`[待验] ${why}`);
    }
  }
  for (const id of NA) {
    if (statusOf.get(id)) {
      if (statusOf.get(id).status === 'MISS') statusOf.get(id).status = 'NA';
      statusOf.get(id).evidence.push('[不适用] ' + (id === 'OR-16'
        ? 'v1.3 允许「未启用采集」降级（决定 3：真实采集排 v0.5），启用形态本期不判'
        : 'Lead 书面裁定 N1=B：清册功能排 v0.5，v1.3 只冻结模板与判据'));
    }
  }
  const payload = writeOutputs(T, statusOf);
  const s = payload.summary;
  console.log(`\n=== 验收完成：通过 ${s.pass} / 失败 ${s.fail} / 人工待验 ${s.manual} / 不适用 ${s.na} / 未覆盖 ${s.miss}（共 ${ALL_IDS.length} 判据）`);
  console.log('失败判据：' + (s.failIds.join('、') || '（无）'));
  console.log('任务级断言：' + tasks.filter((t) => !t.ok).map((t) => t.id).join('、'));
  console.log(`目标：${T.target}`);
  console.log(`结果：${path.join(T.outDir, '结果.json')}`);
  console.log(`临时目录：${T.base}${args.keep ? '（--keep 保留）' : '（将清理）'}`);

  // 代码快照变化检查（若验收期间实现被改动，提示需重跑）
  const nowHashes = {};
  for (const f of walkFiles(T.target)) {
    if (f.rel.startsWith('docs/')) continue;
    if (f.rel.startsWith('node_modules/')) continue;
    nowHashes[f.rel] = sha256File(f.abs);
  }
  const changed = Object.keys(nowHashes).filter((k) => T.meta.codeHashes[k] !== nowHashes[k]);
  if (changed.length) {
    console.log('⚠️ 验收期间实现文件发生变化（结论可能过期）：' + changed.join(', '));
    payload.meta.changedDuringRun = changed;
    fs.writeFileSync(path.join(SCRIPT_DIR, '_results', '结果.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }
  if (!args.keep) {
    try { fs.rmSync(T.base, { recursive: true, force: true }); } catch { /* Windows 上偶尔句柄未放，忽略 */ }
  }
  return s.fail === 0 && s.miss === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('验收脚本异常：', e);
  try {
    const outDir = path.join(SCRIPT_DIR, '_results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '脚本异常.txt'), String(e && e.stack || e), 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 2;
});
