/**
 * @file _lab.mjs
 * @role v0.5 验收公共实验室：临时 DSH_HOME/数据总库、合成会话、runOnce 包装、台账/state 读取。
 *
 * 纪律：
 *   · 所有测试数据落系统临时目录（%TEMP%\v05-*），跑完清理；
 *   · 不读写 U 盘、不碰桌面冻结包、不运行 git；
 *   · 被测代码只以「公开入口」驱动（index.runOnce、lib 的公开导出），断言只读产物/台账/state。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const shaFile = (p) => sha256(fs.readFileSync(p));
export const shaText = (s) => sha256(Buffer.from(String(s), 'utf8'));

let implCache = null;
/** 懒加载被测实现（同一进程内模块只加载一次）。 */
export async function impl(root) {
  if (implCache && implCache.root === root) return implCache;
  const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  const [idx, led, org, wk, cl, rec] = await Promise.all([
    imp('index.js'), imp('lib/ledger.js'), imp('lib/original.js'),
    imp('lib/weekly.js'), imp('freeze/cleanup.js'), imp('lib/receipt.js'),
  ]);
  implCache = { root, idx, led, org, wk, cl, rec };
  return implCache;
}

/**
 * 建一个隔离实验室。
 * @returns {{base,home,root,sessions,shop}}
 */
export function mkLab(tag = 'lab', { withSession = false, sid = autoSid(), createdAt = T0() } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `v05-${tag}-`));
  const home = path.join(base, 'dsh-home');
  const root = path.join(base, 'ledger-root');
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const lab = { base, home, root, sessions, sid, createdAt };
  if (withSession) {
    lab.file = writeSession(lab, {
      sid, createdAt,
      events: [...sessionHeader(sid, createdAt)],
    }).file;
  }
  return lab;
}

export function rmLab(lab) {
  try { fs.rmSync(lab.base, { recursive: true, force: true }); } catch { /* ignore */ }
}

let sidCounter = 0;
export function autoSid() {
  sidCounter += 1;
  return `session-v05test${String(sidCounter).padStart(6, '0')}-1111-2222-3333-444444444444`;
}

export const T0 = (iso = '2026-11-08T08:00:00+08:00') => Date.parse(iso);
export const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));

export function sessionHeader(sid, createdAt = T0()) {
  return [{ type: 'session', version: 4, id: sid, createdAt, cwd: 'C:\\v05-lab' }];
}

/** 造事件行：`ev('turn/start', {turn:1}, ms)`（seq 由调用方/会话顺序自动编号）。 */
let seqCounter = 0;
export function resetSeq(n = 0) { seqCounter = n; }
export function ev(type, data, timeMs) {
  const e = { type, seq: seqCounter, time: timeMs, data };
  seqCounter += 1;
  return e;
}

export function turnStart(turn, ms) { return ev('turn/start', { turn }, ms); }
export function turnEnd(turn, ms, kind = 'completed') { return ev('turn/end', { turn, reason: { kind } }, ms); }
export function userMsg(text, ms, kind = 'user') {
  return ev('user/message', { content: [{ type: 'text', text }], source: { kind }, role: 'user' }, ms);
}
export function assistantMsg(text, ms) {
  return ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }, ms);
}
export function toolCall(name, args, ms) {
  return ev('tool/call', { callId: 'c' + seqCounter, name, arguments: args }, ms);
}
export function toolResult(text, ms, isError = false) {
  return ev('tool/result', { message: { role: 'tool', content: [{ type: 'text', text }], isError } }, ms);
}

/** 一轮简单交互（turn/start → user → assistant → turn/end）。 */
export function simpleTurn(turn, startMs, { userText = `第 ${turn} 轮`, assistantText = `答 ${turn}`, endMs = null } = {}) {
  return [
    turnStart(turn, startMs),
    userMsg(userText, startMs + 1),
    assistantMsg(assistantText, startMs + 2),
    turnEnd(turn, endMs == null ? startMs + 3 : endMs),
  ];
}

/**
 * 写会话文件（v4 zstd 多帧；frames>1 时按块切帧，模拟 DSH 追加写）。
 * @returns {{file:string, dir:string, bytes:number}}
 */
export function writeSession(lab, { sid = lab.sid, events, frames = 1, eventsPerFrame = 0 } = {}) {
  const dir = path.join(lab.sessions, 'wsA', sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const lines = events.map((e) => JSON.stringify(e));
  if (frames <= 1 && !eventsPerFrame) {
    fs.writeFileSync(file, frame(lines));
  } else {
    const per = eventsPerFrame > 0 ? eventsPerFrame : Math.ceil(lines.length / frames);
    const bufs = [];
    for (let i = 0; i < lines.length; i += per) bufs.push(frame(lines.slice(i, i + per)));
    fs.writeFileSync(file, Buffer.concat(bufs));
  }
  lab.file = file;
  return { file, dir, bytes: fs.statSync(file).size };
}

/** 直接在文件尾追加一帧事件（模拟 DSH 又写了几条）。 */
export function appendFrame(file, events) {
  fs.appendFileSync(file, frame(events.map((e) => JSON.stringify(e))));
}

/** runOnce 的默认配置（测试可覆写）。 */
export function baseCfg(root, over = {}) {
  return {
    root,
    intervalSeconds: 60,
    enabled: true,
    offsetMinutes: 480,
    hotWindowSeconds: 0,
    quietSeconds: 0,
    scanBudgetMs: 0,
    maxBytesPerSession: 0,
    checkupEnabled: false,
    weeklyEnabled: false,
    handoverEnabled: false,
    ...over,
  };
}

/** 跑一轮 runOnce；返回 {stat, logs, logText}。 */
export async function runOnce(root, lab, cfgOver = {}) {
  const I = await impl(root);
  process.env.DSH_HOME = lab.home;
  const logs = [];
  const push = (lv) => (m) => logs.push(`${lv} ${String(m)}`);
  const logger = { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG') };
  const cfg = baseCfg(lab.root, cfgOver);
  const stat = await I.idx.runOnce({ logger }, cfg);
  return { stat, logs, logText: logs.join('\n') };
}

export async function readLedger(pluginRoot, dataRoot) {
  const I = await impl(pluginRoot);
  return I.led.readAll(dataRoot);
}

export async function readState(pluginRoot, dataRoot) {
  const I = await impl(pluginRoot);
  return I.led.readState(dataRoot) || {};
}

export function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) listFiles(p, base, out);
    else out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * V0.6.2 根元数据/导航产物（**不是账务产物**）。
 *
 * @why 机主已签《v0.6.2-迁移规格-v1》后，数据总库根一级新增两样东西：
 *      `.ledger-root`（账库根标记，见 lib/ledgerroot.js）与 `账簿总目录.md`（人读导航，见 lib/catalog.js）。
 *      它们由宿主每轮/每日合法写出，**不是**账务记录/凭证/产物。
 *      完整性断言（"不得产生产物""零产物""全库 sha256 不变"等）针对的是**账务产物**；
 *      把根元数据算进去会把宿主合法写盘误判成违规 → 验收假红。
 * @why 只按**根级名字**排除（不排除子目录里的同名文件）：这两样只允许出现在根一级，
 *      子目录出现同名文件反而应当被完整性断言看见。
 */
export const ROOT_METADATA_NAMES = Object.freeze(['.ledger-root', '账簿总目录.md']);

/** 是否根元数据/导航产物文件名（见 ROOT_METADATA_NAMES 的 @why）。 */
export function isRootMetadataName(name) {
  return ROOT_METADATA_NAMES.includes(String(name));
}

/**
 * 列「账务产物」（V0.6.2 口径）：排除运行区 `ledger/` 与根元数据/导航产物。
 * @param {string} root 数据总库根目录
 * @returns {Array<{abs:string, rel:string, size:number, mtimeMs:number}>}
 */
export function listAccountingArtifacts(root) {
  return listFiles(root).filter((f) => {
    const rel = f.rel.replace(/\\/g, '/');
    if (rel.startsWith('ledger/')) return false;              // 运行区（台账/journal/state/report）不是"产物"
    if (!rel.includes('/') && isRootMetadataName(rel)) return false; // 根元数据/导航不是账务产物
    return true;
  });
}

export function walkArtifacts(root, base = root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const n of fs.readdirSync(root).sort()) {
    if (n === 'ledger') continue;
    // V0.6.2：根元数据/导航产物不是账务产物（理由见 ROOT_METADATA_NAMES 的 @why）。
    if (root === base && isRootMetadataName(n)) continue;
    const p = path.join(root, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkArtifacts(p, base, out);
    else out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/'), size: st.size });
  }
  return out;
}

export function readText(p) { return fs.readFileSync(p, 'utf8'); }
export function exists(p) { return fs.existsSync(p); }

/** 等一个谓词成立（用于等子进程产出），超时抛错。 */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}（>${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Windows 上 process.kill(pid,'SIGKILL') 等价 TerminateProcess；这里统一暴露。 */
export function killHard(pid) {
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

export { fs, os, path, zlib };
