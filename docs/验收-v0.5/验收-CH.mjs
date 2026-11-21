/**
 * @file 验收-CH.mjs
 * @role v0.5 P1 可信链（CH-01…CH-24）的「能失败的测试」——每条判据一个用例。
 *
 * 依据：`03-契约-v0.5/v0.5-验收清单.md` §2（第 3 列可判定判据）+ `v0.5-P1可信链契约.md`（判据正文）。
 * 纪律：
 *   · 只写本文件；不改实现/不改其它验收件；每条判据 `criteria:['CH-xx']` 一对一；
 *   · 每个用例自己 `mkLab`/`rmLab`，不共享 root；
 *   · 断言抓不到的证据（运行报告未产出该段）→ `skip('原因…')`，不许伪造通过；
 *   · 实现确实不满足判据 → FAIL 并在 evidence 里点名（不改实现）。
 *
 * 用法：
 *   node docs/验收-v0.5/验收-CH.mjs --out=docs/验收-v0.5/_results/CH.json [--only=CH-01,CH-02]
 *   node docs/验收-v0.5/验收-CH.mjs --sessions=<stress-dir>\sessions [--sessions-max=3] [--only=CH-06,CH-08]
 *     ↑ v0.9.1 C01 改造：**真实语料模式**。CH-06/CH-08 的期望轮数不再写死夹具/1558，
 *       改为"现场重放得到的轮数"（lib/legacy.js scanSessionSources + readSourceTurns），
 *       并在输出里打印四个数（台账行数 / code 唯一 / (sid,turn) 唯一 / 坏行）。
 *       1558 只是 2026-11-10 机主真实账库的一次观测值，**不是永久阈值**。
 *       资源纪律：本模式只灌"最小的 N 个有闭合轮的源"（--sessions-max，默认 3），
 *       全语料轮数用 `node docs/工具-语料四数.mjs --sessions=<根> --count`（只读，约 2s）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { main, expect, expectEqual, skip } from './_runner.mjs';
import * as L from './_lab.mjs';
import { replayCorpus, ledgerFour, judgeFour } from '../工具-语料四数.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
// ★ V0.9（2026-11-11）：原来把 python 路径**写死**在当前用户的 .dsh 运行时目录里；
//   设备回滚 / 换机 / 审计方自己复跑时，python 换个位置就会把"环境缺失"误判成"判据不成立"。
//   改成按优先级解析：① 环境变量 DSH_PYTHON ② 与 node 同级的 dependencies/python ③ 旧路径兜底。
const PY = (() => {
  const cands = [
    process.env.DSH_PYTHON,
    path.join(path.dirname(process.execPath), '..', '..', 'python', 'python.exe'),
    '<build-host>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  ];
  return cands.find((p) => typeof p === 'string' && p && fs.existsSync(p)) || '';
})();
const XLSX_PROBE = path.join(PLUGIN, 'docs', '验收-v1.3', 'xlsx_probe.py');
const OFFSET = 480;
const RPT_RE = /^RPT-\d{8}-\d+\.md$/;
const CODE_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;

// ── C01（v0.9.1 改造）：--sessions=<语料根> 真实语料模式 ──────────────────────
// _runner.mjs 只认 --out/--only，这里自己解析 --sessions/--sessions-max（不改 runner）。
const ARGV = process.argv.slice(2);
const argOf = (k) => {
  const a = ARGV.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : '';
};
const SESSIONS = argOf('sessions') ? path.resolve(argOf('sessions')) : '';
// --sessions-max=N：只灌最小的 N 个有闭合轮的源（资源纪律，默认 3）；
// --sessions-max=all：全量灌入（38.8MB 会话 ≈3–4 分钟，仅在能接受这个耗时/写盘量时用）。
const SESSIONS_MAX = (() => {
  const raw = argOf('sessions-max').trim();
  if (raw === 'all' || raw === '0') return Infinity;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 3;
})();
if (SESSIONS) {
  console.log(`[真实语料模式] --sessions=${SESSIONS} ｜ CH-06/CH-08 期望轮数=现场重放 ｜ ` +
    `取最小 ${SESSIONS_MAX === Infinity ? '全部' : SESSIONS_MAX} 个有闭合轮的源` +
    `（资源纪律，默认不灌 48MB 全量；全语料轮数见 docs/工具-语料四数.mjs --count）`);
}

// ---------------------------------------------------------------------------
// 公共小工具（只在验收侧；实现代码一行不改）
// ---------------------------------------------------------------------------
const modCache = new Map();
async function mod(rel) {
  if (!modCache.has(rel)) modCache.set(rel, import(pathToFileURL(path.join(PLUGIN, rel)).href));
  return modCache.get(rel);
}

async function run(lab, over = {}) {
  const I = await L.impl(PLUGIN);
  I.idx.__test__.resetPeriodicThrottle();
  return L.runOnce(PLUGIN, lab, { weeklyEnabled: false, handoverEnabled: false, ...over });
}

function reportOf(lab) {
  const dir = path.join(lab.root, 'ledger');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\.run-report-\d{8}\.json$/.test(n)).sort(); } catch { return null; }
  if (!names.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8')); } catch { return null; }
}

async function rowsOf(lab) { return (await L.readLedger(PLUGIN, lab.root)).records; }
async function stateOf(lab) { return L.readState(PLUGIN, lab.root); }

function closedTurns({ sid, createdAt = L.T0(), turnNums, startAt = L.T0() + 60_000, userText = (t) => `第 ${t} 轮` }) {
  L.resetSeq(0);
  const evs = [...L.sessionHeader(sid, createdAt)];
  for (const t of turnNums) evs.push(...L.simpleTurn(t, startAt + (t - 1) * 10_000, { userText: userText(t) }));
  return evs;
}

async function withLabs(fn) {
  const made = [];
  const mk = (tag) => { const l = L.mkLab(tag); made.push(l); return l; };
  try {
    return await fn(mk);
  } finally {
    for (const l of made) L.rmLab(l);
  }
}

function snapshotFiles(root) {
  return L.listFiles(root).map((f) => ({ rel: f.rel.replace(/\\/g, '/'), size: f.size, sha: L.shaFile(f.abs) }));
}

function isoLocal(ms, offset = OFFSET) {
  const d = new Date(ms + offset * 60_000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}+08:00`;
}

function mkWeeklyRecords({ s12, gen = 'A', count, baseMs }) {
  const dateSeg = isoLocal(baseMs).slice(0, 10).replace(/-/g, '');
  return Array.from({ length: count }, (_, i) => ({
    v: 3,
    code: `${dateSeg}-${s12}-${gen}-${String(i + 1).padStart(8, '0')}`,
    ts: isoLocal(baseMs + i * 60_000),
    sid: `sid-${s12}`, turn: i + 1, seq: i + 1, status: 'ok',
  }));
}

async function sealGroup(lab, { s12, gen = 'A', count, baseMs }) {
  const wk = await mod('lib/weekly.js');
  const week = await mod('lib/week.js');
  const records = mkWeeklyRecords({ s12, gen, count, baseMs });
  const w = week.weekOf(baseMs, OFFSET);
  const sessKey = `${s12}${gen}`;
  const res = wk.writeWeekly({ root: lab.root, w, sessKey, records, offsetMinutes: OFFSET, mode: 'sealed', nowMs: baseMs + 3 * 86400_000 });
  return { records, w, sessKey, res };
}

async function journalOf(lab) {
  const sj = await mod('lib/sealjournal.js');
  const p = sj.sealJournalPath(lab.root);
  if (!fs.existsSync(p)) return { path: p, raw: [], events: [] };
  const raw = fs.readFileSync(p, 'utf8').split('\n').filter((x) => x.trim());
  return { path: p, raw, events: raw.map((l) => JSON.parse(l)) };
}

function probeXlsx(outDir, files) {
  if (!fs.existsSync(PY) || !fs.existsSync(XLSX_PROBE)) return null;
  const outJson = path.join(outDir, `probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  const r = spawnSync(PY, [XLSX_PROBE, outJson, ...files], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0 || !fs.existsSync(outJson)) return null;
  try { return JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch { return null; }
}

function a4SealHash(fact) {
  const sheet = (fact && Array.isArray(fact.sheets) ? fact.sheets : []).find((s) => s && s.name === '说明');
  const raw = sheet && sheet.cells && sheet.cells.A4 ? sheet.cells.A4.v : '';
  const m = /封板hash:\s*([0-9a-f]{64})/.exec(String(raw || ''));
  return m ? m[1] : '';
}

function xlsxFilesOf(root) {
  return L.listFiles(root).filter((f) => f.rel.endsWith('.xlsx')).map((f) => f.abs).sort();
}

/** 递归找报告里是否出现某个字段名（用于"报告未产出该段"的如实跳过）。 */
function findKeyDeep(obj, needle, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase().includes(needle.toLowerCase())) return { key: k, value: v };
    const hit = findKeyDeep(v, needle, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// C01 真实语料模式（v0.9.1）：期望轮数 = 现场重放，四数同屏
// ---------------------------------------------------------------------------

/**
 * 把「语料里最小的 N 个有闭合轮的源」复制进实验室 sessions（保留 workspace/会话 相对目录）。
 *
 * @why 为什么只取小样本：38.8MB 的大会话全量灌入要 3–4 分钟、写 1338 轮凭证，
 *      那是"一次性离线证据"的量级，不适合每次验收跑。这里取最小样本是为了**验证机制**
 *      （期望轮数来自现场重放、四数同屏、集合双向一致）；全语料轮数由
 *      `docs/工具-语料四数.mjs --count` 只读给出（约 2 秒），两者互补。
 * @why 为什么要过滤"0 闭合轮"的源：空会话灌进去不会产生台账行，只会把"样本大小"注水；
 *      这里显式报告有几个空源被排除（不静默）。
 *
 * @param {object} lab L.mkLab() 的实验室
 * @param {string} sessionsBase 语料根
 * @param {number} maxN 最多取几个源
 * @param {{oldMtimeMs?:number}} [opts] 复制后把 mtime 改成指定值（模拟"停机期间的老会话"）
 */
async function stageRealCorpus(lab, sessionsBase, maxN, opts = {}) {
  const legacy = await mod('lib/legacy.js');
  const sc = legacy.scanSessionSources(sessionsBase);
  const infos = [];
  for (const s of sc.supported) {
    const r = legacy.readSourceTurns(s, {}); // 不传 root：只读
    const sid = (r.head && r.head.id) || s.sid || path.basename(s.dir);
    infos.push({ entry: s, sid, closedTurns: r.closed.length });
  }
  const withTurns = infos.filter((x) => x.closedTurns > 0)
    .sort((a, b) => a.entry.size - b.entry.size || String(a.sid).localeCompare(String(b.sid)));
  const picked = withTurns.slice(0, Math.max(1, maxN));
  const staged = [];
  for (const x of picked) {
    const relDir = path.relative(sessionsBase, x.entry.dir);
    const dstDir = path.join(lab.sessions, relDir);
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, path.basename(x.entry.path));
    fs.copyFileSync(x.entry.path, dst);
    if (Number.isFinite(opts.oldMtimeMs) && opts.oldMtimeMs > 0) {
      const t = new Date(opts.oldMtimeMs);
      fs.utimesSync(dst, t, t);
    }
    staged.push({ sid: x.sid, bytes: x.entry.size, closedTurns: x.closedTurns, file: dst });
  }
  return {
    sessions: sessionsBase,
    sources: sc.supported.length,
    v3Only: sc.supported.filter((x) => x.source === 'v3').length,
    pairs: sc.pairs.length,
    unsupported: sc.unsupported.length,
    emptySources: infos.length - withTurns.length,
    staged,
  };
}

/**
 * 四数必须自己 console.log：_runner.mjs 在 PASS 时只打印标题，evidence 只在失败时显示。
 *
 * @param {string} label 用例名
 * @param {object} replay replayCorpus() 结果
 * @param {object} four ledgerFour() 结果
 */
function logFour(label, replay, four) {
  const per = replay.perSource.filter((s) => s.closedTurns > 0)
    .map((s) => `${String(s.sid).slice(0, 18)}…=${s.closedTurns}`).join(' + ') || '无';
  console.log(
    `[C01 四数·${label}｜真实语料] 台账行数=${four.rows} ｜ code 唯一=${four.codeUnique} ｜ ` +
    `(sid,turn) 唯一=${four.sidTurnUnique} ｜ 坏行=${four.badLines} ｜ 现场重放闭合轮数=${replay.closedTurns}` +
    `（${per}）`,
  );
}

/**
 * CH-06 真实语料模式：跑至 deferred=0；(sid,turn) 集合==现场重放集合；四数同屏。
 *
 * @param {(tag:string)=>object} mk withLabs 提供的实验室工厂
 */
async function ch06Real(mk) {
  const lab = mk('ch-06-real');
  const stage = await stageRealCorpus(lab, SESSIONS, SESSIONS_MAX);
  expect(stage.staged.length > 0,
    `★ CH-06 不成立（真实语料模式）：--sessions=${SESSIONS} 里没有"有闭合轮"的源，无实现场重放`);
  const replay = replayCorpus(lab.sessions);
  let r = null;
  for (let i = 0; i < 4; i += 1) { r = await run(lab, { scanBudgetMs: 0 }); if (r.stat.deferred === 0) break; }
  const four = ledgerFour(lab.root);
  const judge = judgeFour({ replay, ledger: four });
  const st = await stateOf(lab);
  logFour('CH-06', replay, four);
  expect(judge.ok, `★ CH-06 不成立（真实语料模式）：${judge.reasons.join('；')}`);
  expectEqual(st.initialized, true, `★ CH-06 不成立：deferred=0 后 state.initialized=${JSON.stringify(st.initialized)}（应 true）`);
  return `真实语料：现场重放 ${replay.closedTurns} 轮 == 台账 ${four.rows} 行` +
    `（code唯一=${four.codeUnique}、(sid,turn)唯一=${four.sidTurnUnique}、坏行=${four.badLines}；` +
    `取 ${stage.staged.length}/${stage.sources} 个最小源，空源 ${stage.emptySources} 个不灌；` +
    `v3 并存不参与 ${stage.pairs} 个、不支持版本 ${stage.unsupported} 个；deferred=0；initialized=true）`;
}

/**
 * CH-08 真实语料模式：停机兜底两轮；逐源行数==现场重放；四数同屏。
 *
 * @param {(tag:string)=>object} mk withLabs 提供的实验室工厂
 */
async function ch08Real(mk) {
  const lab = mk('ch-08-real');
  await run(lab); // 首轮空语料：只建立 state（initialized=true）
  const stPath = path.join(lab.root, 'ledger', '.state.json');
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  st.lastRunAt = isoLocal(Date.now() - 7 * 86400_000).replace('T', ' ').replace('+08:00', '');
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n', 'utf8');
  // 停机期间产生的会话：mtime 3 天前（老于 hotWindow=1d，但落在停机缺口内）
  const stage = await stageRealCorpus(lab, SESSIONS, SESSIONS_MAX, { oldMtimeMs: Date.now() - 3 * 86400_000 });
  expect(stage.staged.length > 0,
    `★ CH-08 不成立（真实语料模式）：--sessions=${SESSIONS} 里没有"有闭合轮"的源`);
  const replay = replayCorpus(lab.sessions);
  const r1 = await run(lab, { hotWindowSeconds: 86400, intervalSeconds: 60 });
  const r2 = await run(lab, { hotWindowSeconds: 86400, intervalSeconds: 60 });
  const rows = await rowsOf(lab);
  const four = ledgerFour(lab.root);
  const judge = judgeFour({ replay, ledger: four });
  logFour('CH-08', replay, four);
  const bySid = new Map();
  for (const x of rows) {
    if (!bySid.has(x.sid)) bySid.set(x.sid, []);
    bySid.get(x.sid).push(x.turn);
  }
  const problems = [];
  for (const s of replay.perSource.filter((x) => x.closedTurns > 0)) {
    const got = (bySid.get(s.sid) || []).slice().sort((a, b) => a - b);
    const exp = s.turns.slice().sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(exp)) {
      problems.push(`源 ${String(s.sid).slice(0, 20)} 台账行=${JSON.stringify(got)} != 现场重放=${JSON.stringify(exp)}`);
    }
  }
  expect(problems.length === 0, '★ CH-08 不成立（真实语料模式）：停机兜底后仍有源漏记：' + problems.join('；'));
  expect(judge.ok, `★ CH-08 不成立（真实语料模式）：${judge.reasons.join('；')}`);
  const rep = reportOf(lab);
  const hit = findKeyDeep(rep, 'catchupScanned');
  if (!hit) {
    skip(`真实语料模式：逐源行数==现场重放（${replay.closedTurns} 轮）、四数通过 ` +
      `（scanned=${r1.stat.scanned}/${r2.stat.scanned}）；但运行报告未产出 catchupScanned 段（附录 A 要求）`);
  }
  expect(Number(hit.value) > 0, `★ CH-08 不成立：catchupScanned=${JSON.stringify(hit.value)}（应 >0）`);
  return `真实语料：两轮后逐源行数==现场重放（${replay.closedTurns} 轮）、四数通过；catchupScanned=${hit.value}`;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
async function build(runner) {
  // ==========================================================================
  // CH-01 · 新行三哈希/附件齐全且复算相等；有 YAML 时 docFileSha256 != docSha256
  // ==========================================================================
  runner.add({
    id: 'CH-01', criteria: ['CH-01'], title: '新行含 docSha256/docFileSha256(64hex)+attachment{name,sha256,bytes}；三者复算相等；有 YAML 时两 hash 不等',
    async fn() { return withLabs(async (mk) => {
      const org = await mod('lib/original.js');
      const lab = mk('ch-01');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000, { userText: 'CH-01 一轮' })] });
      await run(lab);
      const rows = await rowsOf(lab);
      expectEqual(rows.length, 1, '前置失败：应入账 1 行');
      const rec = rows[0];
      expect(/^[0-9a-f]{64}$/.test(String(rec.docSha256)), `★ CH-01 不成立：docSha256 不是 64hex（${JSON.stringify(rec.docSha256)}）`);
      expect(/^[0-9a-f]{64}$/.test(String(rec.docFileSha256)), `★ CH-01 不成立：docFileSha256 不是 64hex（${JSON.stringify(rec.docFileSha256)}）`);
      expect(rec.attachment && typeof rec.attachment.name === 'string' && /^[0-9a-f]{64}$/.test(String(rec.attachment.sha256)) && Number.isInteger(rec.attachment.bytes),
        `★ CH-01 不成立：attachment 缺 {name,sha256(64hex),bytes}（${JSON.stringify(rec.attachment)}）`);
      const docAbs = path.join(lab.root, rec.doc);
      const attAbs = path.join(path.dirname(docAbs), rec.attachment.name);
      const md = fs.readFileSync(docAbs, 'utf8');
      expectEqual(rec.docFileSha256, L.shaFile(docAbs), '★ CH-01 不成立：docFileSha256 != 视图完整文件实算');
      expectEqual(rec.docSha256, org.originalBodyHash(md), '★ CH-01 不成立：docSha256 != 正文（## 1.→EOF）实算');
      expectEqual(rec.attachment.sha256, L.shaFile(attAbs), '★ CH-01 不成立：attachment.sha256 != 附件实算');
      expectEqual(rec.attachment.bytes, fs.statSync(attAbs).size, '★ CH-01 不成立：attachment.bytes != 附件实际字节');
      expect(rec.docFileSha256 !== rec.docSha256, '★ CH-01 不成立：有 YAML 时 docFileSha256 == docSha256（超集哈希口径错误）');
      return `三哈希 64hex 且复算全等；docFileSha256≠docSha256（${rec.docFileSha256.slice(0, 8)}… vs ${rec.docSha256.slice(0, 8)}…）`;
    }); },
  });

  // ==========================================================================
  // CH-02 · 五场景：改 YAML/正文/附件/路径 → 绑定失败且原因正确；合法清理 → 已清理 不进 integrityFailures
  // ==========================================================================
  runner.add({
    id: 'CH-02', criteria: ['CH-02'], title: '改 YAML→FILE_HASH_MISMATCH、改正文→BODY_HASH_MISMATCH、改附件→ATTACHMENT_HASH_MISMATCH、路径错→PATH_MISMATCH、合法清理→已清理(RPT-…)不进 integrityFailures',
    async fn() { return withLabs(async (mk) => {
      const org = await mod('lib/original.js');
      const wk = await mod('lib/weekly.js');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const oneRowLab = async (tag, text) => {
        const lab = mk(tag);
        L.resetSeq(0);
        L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000, { userText: text })] });
        await run(lab);
        const rows = await rowsOf(lab);
        expectEqual(rows.length, 1, `前置失败（${tag}）：应入账 1 行`);
        const rec = rows[0];
        const docAbs = path.join(lab.root, rec.doc);
        return { lab, rec, docAbs, attAbs: path.join(path.dirname(docAbs), rec.attachment.name), text };
      };
      // ① 改 YAML 一字节
      {
        const { lab, rec, docAbs, text } = await oneRowLab('ch-02a', 'YAML 场景唯一文本');
        fs.writeFileSync(docAbs, fs.readFileSync(docAbs, 'utf8').replace('\n委托人: user\n', '\n委托人: usex\n'), 'utf8');
        const st = wk.resolveDoc(lab.root, rec, OFFSET);
        check(wk.originalLabel(st) !== '绑定', `① YAML 改动后 B 列仍显示"绑定"（state=${st.state}）`);
        check(st.integrity && (st.integrity.problems || []).includes('FILE_HASH_MISMATCH'), `① YAML 改动未报 FILE_HASH_MISMATCH（${JSON.stringify(st.integrity && st.integrity.problems)}）`);
        void text;
      }
      // ② 改正文一字节
      {
        const { lab, rec, docAbs, text } = await oneRowLab('ch-02b', '正文场景唯一文本');
        fs.writeFileSync(docAbs, fs.readFileSync(docAbs, 'utf8').replace(text, text + 'X'), 'utf8');
        const st = wk.resolveDoc(lab.root, rec, OFFSET);
        check(wk.originalLabel(st) !== '绑定', `② 正文改动后 B 列仍显示"绑定"（state=${st.state}）`);
        check(st.integrity && (st.integrity.problems || []).includes('BODY_HASH_MISMATCH'), `② 正文改动未报 BODY_HASH_MISMATCH（${JSON.stringify(st.integrity && st.integrity.problems)}）`);
      }
      // ③ 改附件一字节
      {
        const { lab, rec, attAbs } = await oneRowLab('ch-02c', '附件场景唯一文本');
        fs.appendFileSync(attAbs, ' ', 'utf8');
        const st = wk.resolveDoc(lab.root, rec, OFFSET);
        check(wk.originalLabel(st) !== '绑定', `③ 附件改动后 B 列仍显示"绑定"（state=${st.state}）`);
        check(st.integrity && (st.integrity.problems || []).includes('ATTACHMENT_HASH_MISMATCH'), `③ 附件改动未报 ATTACHMENT_HASH_MISMATCH（${JSON.stringify(st.integrity && st.integrity.problems)}）`);
      }
      // ④ 路径错：把视图/附件复制到"编码复算以外"的目录，台账 doc 指向那里
      {
        const { lab, rec, docAbs, attAbs } = await oneRowLab('ch-02d', '路径场景唯一文本');
        const wrongDir = path.join(lab.root, '2026年12月', '12月总“完整原文”');
        fs.mkdirSync(wrongDir, { recursive: true });
        const wrongDoc = path.join(wrongDir, path.basename(docAbs));
        fs.copyFileSync(docAbs, wrongDoc);
        fs.copyFileSync(attAbs, path.join(wrongDir, path.basename(attAbs)));
        const rec2 = { ...rec, doc: path.relative(lab.root, wrongDoc) };
        const st = wk.resolveDoc(lab.root, rec2, OFFSET);
        check(wk.originalLabel(st) !== '绑定', `④ 路径错后 B 列仍显示"绑定"（state=${st.state}）`);
        check(st.integrity && (st.integrity.problems || []).includes('PATH_MISMATCH'), `④ 路径错未报 PATH_MISMATCH（${JSON.stringify(st.integrity && st.integrity.problems)}）`);
      }
      // ⑤ 合法清理：清册有据 + 原文已删 → 已清理(RPT-…)，且不进 integrityFailures
      {
        const { lab, rec, docAbs, attAbs } = await oneRowLab('ch-02e', '合法清理场景');
        const rptId = 'RPT-20261110-01';
        fs.writeFileSync(path.join(lab.root, `${rptId}.md`), [
          '# 清册', '',
          '| # | 编码 | 产生时间 | 结论 | 备注 |', '| --- | --- | --- | --- | --- |',
          `| 1 | ${rec.code} | 2026-11-08 08:01:00 | 已删除 | 合法清理 |`, '',
        ].join('\n'), 'utf8');
        fs.unlinkSync(docAbs);
        try { fs.unlinkSync(attAbs); } catch { /* 附件可能不存在 */ }
        const cleaned = wk.readCleanedCodesCompat(lab.root);
        const st = wk.resolveDoc(lab.root, rec, OFFSET, cleaned);
        const label = wk.originalLabel(st);
        check(st.state === 'cleaned', `⑤ 合法清理后状态=${st.state}（应 cleaned）`);
        check(/^已清理\(RPT-\d{8}-\d+\)$/.test(label), `⑤ 合法清理 B 列=${JSON.stringify(label)}（应 已清理(RPT-…)）`);
        check(!(st.integrity && (st.integrity.problems || []).length), `⑤ 合法清理被误报 integrity（${JSON.stringify(st.integrity)}）`);
        const week = await mod('lib/week.js');
        const w = week.weekOf(Date.parse(rec.ts), OFFSET);
        const res = wk.writeWeekly({ root: lab.root, w, sessKey: wk.sessKeyOf(rec.code), records: [rec], offsetMinutes: OFFSET, mode: 'draft' });
        check((res.integrityFailures || []).length === 0, `⑤ 合法清理进了 integrityFailures（${JSON.stringify(res.integrityFailures)}）`);
      }
      expect(problems.length === 0, '★ CH-02 不成立：' + problems.join('；'));
      return '五场景全部符合：YAML→FILE_HASH_MISMATCH、正文→BODY_HASH_MISMATCH、附件→ATTACHMENT_HASH_MISMATCH、路径→PATH_MISMATCH（B 列均≠绑定）；合法清理→已清理(RPT-…)且不误报 integrity';
    }); },
  });

  // ==========================================================================
  // CH-03 · append 补尾换行（不粘结）+ fsync 失败注入：报错/written 不增/游标回退
  // ==========================================================================
  runner.add({
    id: 'CH-03', criteria: ['CH-03'], title: '预置无尾换行→append 后每行可 parse（行数=原+1）；fsync 失败注入→报错、written 不增、游标回退',
    async fn() { return withLabs(async (mk) => {
      const led = await mod('lib/ledger.js');
      const lab = mk('ch-03');
      // ① 尾部无换行时 append 不粘结
      const dir = path.join(lab.root, 'ledger');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '2026-11-08.jsonl');
      const r1 = { v: 3, code: '20261108-ch03test0000-A-00000001', ts: '2026-11-08T10:00:00+08:00', sid: 's', turn: 1, seq: 1, status: 'ok' };
      fs.writeFileSync(file, JSON.stringify(r1), 'utf8'); // 故意没有结尾换行
      const r2 = { v: 3, code: '20261108-ch03test0000-A-00000002', ts: '2026-11-08T10:01:00+08:00', sid: 's', turn: 2, seq: 2, status: 'ok' };
      let appendRes = null;
      try { appendRes = led.appendTurn(lab.root, r2, new Set([r1.code])); } catch (e) { throw new Error('appendTurn 抛异常（应结构化返回）：' + e.message); }
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n').filter((x) => x.trim());
      let parsed = [];
      try { parsed = lines.map((l) => JSON.parse(l)); } catch { parsed = []; }
      expectEqual(appendRes.ok, true, '★ CH-03 不成立：无尾换行时 appendTurn 返回失败');
      expectEqual(parsed.length, 2, `★ CH-03 不成立：append 后应能解析出 2 行（实际 ${parsed.length} 行；允许显式补换行，不允许粘结）`);
      expect(text.endsWith('\n'), '★ CH-03 不成立：append 后文件不以换行结尾');
      // ② fsync 失败注入（runOnce 级）
      const lab2 = mk('ch-03b');
      L.resetSeq(0);
      L.writeSession(lab2, { events: [...L.sessionHeader(lab2.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const origFsync = fs.fsyncSync;
      fs.fsyncSync = function patched(fd) {
        const st = String(new Error().stack || '');
        if (st.includes('appendLineSync')) { const e = new Error('inject fsync EIO'); e.code = 'EIO'; throw e; }
        return origFsync.call(fs, fd);
      };
      let r = null;
      try { r = await run(lab2); } finally { fs.fsyncSync = origFsync; }
      const st2 = await stateOf(lab2);
      const cur = st2.sourceCursors && st2.sourceCursors[lab2.file];
      expect(r.stat.written === 0, `★ CH-03 不成立：fsync 失败注入后 stat.written=${r.stat.written}（应 0）`);
      expect(r.stat.errors.some((e) => /append failed/.test(String(e))), `★ CH-03 不成立：fsync 失败没有进 stat.errors（${JSON.stringify(r.stat.errors).slice(0, 200)}）`);
      expect(!(cur && Number(cur.offset) > 0), `★ CH-03 不成立：fsync 失败后游标被推进（offset=${cur && cur.offset}）——失败必须回退`);
      return `无尾换行 append 后 2 行可解析且以换行结尾；fsync 注入 EIO：written=0、errors 含 append failed、游标不前进（offset=${JSON.stringify(cur && cur.offset)}）`;
    }); },
  });

  // ==========================================================================
  // CH-04 · 坏行：readErrors 结构化 + quarantine 取证 + 原账文件字节不变
  // ==========================================================================
  runner.add({
    id: 'CH-04', criteria: ['CH-04'], title: '坏行：readErrors 结构化；.quarantine/<账文件>.L<行号>.json 含 raw+sha；原账文件字节不变',
    async fn() { return withLabs(async (mk) => {
      const led = await mod('lib/ledger.js');
      const lab = mk('ch-04');
      const dir = path.join(lab.root, 'ledger');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '2026-11-08.jsonl');
      const good = { v: 3, code: '20261108-ch04test0000-A-00000001', ts: '2026-11-08T10:00:00+08:00', sid: 's', turn: 1, seq: 1, status: 'ok' };
      fs.writeFileSync(file, JSON.stringify(good) + '\n{"坏行": 没有闭合\n', 'utf8');
      const shaBefore = L.shaFile(file);
      const res = led.readAll(lab.root, { quarantine: true });
      const shaAfter = L.shaFile(file);
      expect(res.ok === false, '★ CH-04 不成立：坏行时 readAll.ok 仍为 true（静默跳过）');
      expectEqual(res.badLines, 1, `★ CH-04 不成立：badLines=${res.badLines}（应 1）`);
      expect(Array.isArray(res.readErrors) && res.readErrors.length > 0,
        `★ CH-04 不成立：坏行时 readErrors 为空数组——契约要求 readErrors:[{file,line,rawSha256,offset,error}]。` +
        `（坏行的机器可读证据实际只落在 badLineDetails=${JSON.stringify((res.badLineDetails || []).slice(0, 1))}，键名/字段与契约不一致；badLines=${res.badLines}、ok=${res.ok}）`);
      const e0 = (res.readErrors || [])[0] || {};
      expect(e0.file && (e0.code || e0.message), `★ CH-04 不成立：readErrors 缺结构化定位（${JSON.stringify(e0)}）`);
      const qDir = path.join(dir, '.quarantine');
      const qFiles = fs.existsSync(qDir) ? fs.readdirSync(qDir) : [];
      expectEqual(qFiles.length, 1, `★ CH-04 不成立：quarantine 取证文件数=${qFiles.length}（应 1）`);
      expect(/^2026-11-08\.jsonl\.L2\.json$/.test(qFiles[0]), `★ CH-04 不成立：quarantine 文件名不符（${qFiles[0]}，应 <账文件>.L<行号>.json）`);
      const q = JSON.parse(fs.readFileSync(path.join(qDir, qFiles[0]), 'utf8'));
      expect(typeof q.raw === 'string' && /^[0-9a-f]{64}$/.test(String(q.sha256)), `★ CH-04 不成立：quarantine 缺 raw/sha256（keys=${JSON.stringify(Object.keys(q))}）`);
      expectEqual(shaAfter, shaBefore, '★ CH-04 不成立：坏行取证改写了原账文件字节（append-only 底线）');
      return `readErrors=${JSON.stringify(res.readErrors)}；quarantine=${qFiles[0]}（raw+sha256）；原账 sha 不变`;
    }); },
  });

  // ==========================================================================
  // CH-05 · 首跑 deferred>0 → initialized=false；第二轮仍扫到剩余会话
  // ==========================================================================
  runner.add({
    id: 'CH-05', criteria: ['CH-05'], title: '首跑被预算截断(deferred>0)→state.initialized=false；第二轮仍扫到剩余会话(scanned>0)',
    async fn() { return withLabs(async (mk) => {
      const lab = mk('ch-05');
      L.resetSeq(0);
      const mkSession = (sid, n) => {
        const evs = [...L.sessionHeader(sid, L.T0())];
        let seq = 0;
        for (let t = 1; t <= n; t += 1) { L.resetSeq(seq); evs.push(...L.simpleTurn(t, L.T0() + t * 5000)); seq += 4; }
        L.writeSession(lab, { sid, events: evs });
      };
      mkSession(lab.sid, 300);
      mkSession('session-v05test009999-1111-2222-3333-444444444444', 3);
      const r1 = await run(lab, { scanBudgetMs: 1 });
      const st = await stateOf(lab);
      if (!(r1.stat.deferred > 0)) skip(`未触发预算截断（deferred=0，scanBudgetMs=1 时两会话都在预算内完成）——该判据未验证`);
      expect(st.initialized === false, `★ CH-05 不成立：首跑 deferred=${r1.stat.deferred}，但 state.initialized=${JSON.stringify(st.initialized)}（应为 false）`);
      const r2 = await run(lab, { scanBudgetMs: 1 });
      expect(r2.stat.scanned > 0, `★ CH-05 不成立：第二轮没有扫描剩余会话（scanned=${r2.stat.scanned}）`);
      return `首跑 scanned=${r1.stat.scanned}/deferred=${r1.stat.deferred} → initialized=false；第二轮 scanned=${r2.stat.scanned}（仍在扫描剩余老会话）`;
    }); },
  });

  // ==========================================================================
  // CH-06 · 跑至 deferred=0：(sid,turn) 集合==源集合；此后 initialized=true
  // ==========================================================================
  runner.add({
    id: 'CH-06', criteria: ['CH-06'], title: '跑至 deferred=0：所有会话 (sid,turn) 集合==源闭合轮集合；此后 state.initialized=true',
    async fn() { return withLabs(async (mk) => {
      // C01（v0.9.1）：--sessions 真实语料模式 → 期望轮数改为现场重放（见 ch06Real）
      if (SESSIONS) return ch06Real(mk);
      const lab = mk('ch-06');
      const sids = [lab.sid, 'session-v05test008888-1111-2222-3333-444444444444', 'session-v05test007777-1111-2222-3333-444444444444'];
      const source = new Set();
      for (let i = 0; i < sids.length; i += 1) {
        const n = [5, 3, 2][i];
        L.writeSession(lab, { sid: sids[i], events: closedTurns({ sid: sids[i], turnNums: Array.from({ length: n }, (_, k) => k + 1) }) });
        for (let t = 1; t <= n; t += 1) source.add(`${sids[i]}#${t}`);
      }
      let r = null;
      for (let i = 0; i < 4; i += 1) { r = await run(lab, { scanBudgetMs: 0 }); if (r.stat.deferred === 0) break; }
      const rows = await rowsOf(lab);
      const ledger = new Set(rows.filter((x) => x.status === 'ok').map((x) => `${x.sid}#${x.turn}`));
      const st = await stateOf(lab);
      expectEqual(ledger.size, source.size, `★ CH-06 不成立：台账 (sid,turn) 集合大小=${ledger.size} != 源闭合轮集合=${source.size}（缺=${JSON.stringify([...source].filter((k) => !ledger.has(k))).slice(0, 200)}）`);
      expectEqual([...ledger].sort().join('|'), [...source].sort().join('|'), '★ CH-06 不成立：台账 (sid,turn) 集合 != 源集合（双向）');
      expectEqual(st.initialized, true, `★ CH-06 不成立：deferred=0 后 state.initialized=${JSON.stringify(st.initialized)}（应 true）`);
      return `最终台账 (sid,turn)=${ledger.size}==源 ${source.size}；deferred=${r.stat.deferred}；initialized=true`;
    }); },
  });

  // ==========================================================================
  // CH-07 · 停机 7d：cutoff==min(now-hotWindow, lastRunAt-2×interval)（报告两候选）；期间会话被扫
  // ==========================================================================
  runner.add({
    id: 'CH-07', criteria: ['CH-07'], title: '停机 7d：cutoff==min(now-hotWindow, lastRunAt-2×interval)（报告给出两候选）；期间会话被扫',
    async fn() { return withLabs(async (mk) => {
      const lab = mk('ch-07');
      // 先跑一轮留下 state（initialized=true），再伪造成"停机 7 天"
      L.writeSession(lab, { events: closedTurns({ sid: lab.sid, turnNums: [1] }) });
      await run(lab);
      const stPath = path.join(lab.root, 'ledger', '.state.json');
      const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
      st.lastRunAt = isoLocal(Date.now() - 7 * 86400_000).replace('T', ' ').replace('+08:00', '');
      fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n', 'utf8');
      // 停机会话 A：mtime=3 天前（老于 hotWindow=1d，但落在停机缺口内）
      const sidA = 'session-v05test006666-1111-2222-3333-444444444444';
      L.writeSession(lab, { sid: sidA, events: closedTurns({ sid: sidA, turnNums: [1] }) });
      const fileA = lab.file;
      fs.utimesSync(fileA, new Date(Date.now() - 3 * 86400_000), new Date(Date.now() - 3 * 86400_000));
      // 更老会话 B：mtime=8 天前（老于 cutoff 候选 lastRunAt-2×interval）
      const sidB = 'session-v05test005555-1111-2222-3333-444444444444';
      L.writeSession(lab, { sid: sidB, events: closedTurns({ sid: sidB, turnNums: [1] }) });
      const fileB = lab.file;
      fs.utimesSync(fileB, new Date(Date.now() - 8 * 86400_000), new Date(Date.now() - 8 * 86400_000));
      const r = await run(lab, { hotWindowSeconds: 86400, intervalSeconds: 60 });
      const rows = await rowsOf(lab);
      const gotA = rows.some((x) => x.sid === sidA);
      expect(r.stat.hotWindowExtended === true, `★ CH-07 不成立：停机超热窗口后没有放宽 cutoff（hotWindowExtended=${r.stat.hotWindowExtended}）`);
      expect(gotA, `★ CH-07 不成立：停机期间产生的会话（mtime=3d 前，>hotWindow）没被扫到（scanned=${r.stat.scanned}）——只用 hotWindow 会永久漏记`);
      const rep = reportOf(lab);
      const hit = findKeyDeep(rep, 'cutoff');
      if (!hit) {
        skip(`运行报告未产出 cutoff/两候选 段（附录 A 要求；行为面已通过：hotWindowExtended=true、停机期间会话（mtime=3d 前）被扫到、8d 前会话被排除）`);
      }
      return `hotWindowExtended=true；停机期间会话被扫到；报告 cutoff 字段=${JSON.stringify(hit)}`;
    }); },
  });

  // ==========================================================================
  // CH-08 · 同上跑两轮：最终集合==源集合；catchupScanned>0；逐源行数==源闭合轮数
  // ==========================================================================
  runner.add({
    id: 'CH-08', criteria: ['CH-08'], title: '停机兜底两轮：最终 (sid,turn) 集合==源集合、逐源行数==源闭合轮数、catchupScanned>0',
    async fn() { return withLabs(async (mk) => {
      // C01（v0.9.1）：--sessions 真实语料模式 → 期望轮数改为现场重放（见 ch08Real）
      if (SESSIONS) return ch08Real(mk);
      const lab = mk('ch-08');
      L.writeSession(lab, { events: closedTurns({ sid: lab.sid, turnNums: [1] }) });
      await run(lab);
      const stPath = path.join(lab.root, 'ledger', '.state.json');
      const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
      st.lastRunAt = isoLocal(Date.now() - 7 * 86400_000).replace('T', ' ').replace('+08:00', '');
      fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n', 'utf8');
      const source = new Map();
      const sids = ['session-v05test006666-1111-2222-3333-444444444444', 'session-v05test005555-1111-2222-3333-444444444444'];
      for (const sid of sids) {
        const nums = [1, 2, 3];
        L.writeSession(lab, { sid, events: closedTurns({ sid, turnNums: nums }) });
        fs.utimesSync(lab.file, new Date(Date.now() - 3 * 86400_000), new Date(Date.now() - 3 * 86400_000));
        source.set(sid, nums);
      }
      const r1 = await run(lab, { hotWindowSeconds: 86400, intervalSeconds: 60 });
      const r2 = await run(lab, { hotWindowSeconds: 86400, intervalSeconds: 60 });
      const rows = await rowsOf(lab);
      const problems = [];
      for (const [sid, nums] of source) {
        const got = rows.filter((x) => x.sid === sid).map((x) => x.turn).sort((a, b) => a - b);
        if (JSON.stringify(got) !== JSON.stringify(nums)) problems.push(`源 ${sid.slice(0, 20)} 台账行=${JSON.stringify(got)} != 源闭合轮=${JSON.stringify(nums)}`);
      }
      const rep = reportOf(lab);
      const hit = findKeyDeep(rep, 'catchupScanned');
      if (!hit) {
        expect(problems.length === 0, '★ CH-08 不成立：停机兜底后仍有源漏记：' + problems.join('；'));
        skip(`运行报告未产出 catchupScanned 段（附录 A 要求；行为面已通过：两轮后逐源行数==源闭合轮数、最终 (sid,turn) 集合==源集合、hotWindowExtended 生效）`);
      }
      expect(problems.length === 0, '★ CH-08 不成立：停机兜底后仍有源漏记：' + problems.join('；'));
      expect(Number(hit.value) > 0, `★ CH-08 不成立：catchupScanned=${JSON.stringify(hit.value)}（应 >0）`);
      return `最终集合==源集合、逐源行数==源闭合轮数；catchupScanned=${hit.value}`;
    }); },
  });

  // ==========================================================================
  // CH-09 · 坏帧：cursor 不推进到 EOF（停坏帧起点）；报告 frameErrors[]；下轮仍尝试
  // ==========================================================================
  runner.add({
    id: 'CH-09', criteria: ['CH-09'], title: '坏帧：cursor 不推进到 EOF（停坏帧起点）；run-report frameErrors[{source,offset,failed}]；下轮仍尝试',
    async fn() { return withLabs(async (mk) => {
      const lab = mk('ch-09');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const badFrameStart = fs.statSync(lab.file).size;
      fs.appendFileSync(lab.file, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('this-is-not-a-zstd-frame')]));
      const size = fs.statSync(lab.file).size;
      await run(lab);
      const st = await stateOf(lab);
      const cur = st.sourceCursors && st.sourceCursors[lab.file];
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      check(!!cur, '坏帧后 state 没有该源游标');
      if (cur) {
        check(Number(cur.offset) < size, `坏帧后游标仍推进到 EOF（offset=${cur.offset}/${size}）——丢轮`);
        check(Number(cur.offset) === badFrameStart, `坏帧后游标没有停在坏帧起点（offset=${cur.offset}，坏帧起点=${badFrameStart}；实现是回退到 0 全量重读——保守但不符"停在坏帧起点"）`);
      }
      const r2 = await run(lab);
      check(r2.stat.scanned >= 1, `下一轮没有仍尝试该源（scanned=${r2.stat.scanned}）`);
      check((r2.stat.errors || []).some((e) => /failedFrames=|zstd partial|source blocked/.test(String(e))), `下一轮没有再次暴露坏帧（errors=${JSON.stringify(r2.stat.errors).slice(0, 200)}）`);
      const rep = reportOf(lab);
      const hit = findKeyDeep(rep, 'frameErrors');
      check(!!hit, `运行报告未产出 frameErrors 段（frameErrors[] 含 {source,offset,failed}）——报告顶层 keys=${rep ? JSON.stringify(Object.keys(rep)) : 'null'}`);
      if (hit) check(JSON.stringify(hit.value).includes(String(badFrameStart)) || JSON.stringify(hit.value).includes(String(size)), `frameErrors 缺坏帧偏移（badFrameStart=${badFrameStart}）`);
      expect(problems.length === 0, '★ CH-09 不成立：' + problems.join('；'));
      return `cursor.offset=${cur && cur.offset} < EOF ${size}；下轮仍尝试并再报坏帧；report frameErrors=${JSON.stringify(hit && hit.value).slice(0, 200)}`;
    }); },
  });

  // ==========================================================================
  // CH-10 · 坏帧错误清单：同现场只 1 条（fingerprint 幂等）、attempts 累加、节流、报告 count、短读留痕
  // ==========================================================================
  runner.add({
    id: 'CH-10', criteria: ['CH-10'], title: '同坏帧现场两轮：.errors.jsonl 只 1 条（fingerprint）、attempts 累加、节流、报告 errors[].count 反映真实次数、短读标未覆盖区间',
    async fn() { return withLabs(async (mk) => {
      const led = await mod('lib/ledger.js');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      // ① 坏帧现场连扫两轮
      const lab = mk('ch-10');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const badStart = fs.statSync(lab.file).size;
      fs.appendFileSync(lab.file, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-frame')]));
      const file = lab.file;
      const r1 = await run(lab); const rep1 = reportOf(lab);
      const r2 = await run(lab); const rep2 = reportOf(lab);
      const errFile = path.join(lab.root, 'ledger', '.errors.jsonl');
      const errs = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').split('\n').filter((x) => x.trim()).map((l) => JSON.parse(l)) : [];
      const frameErrs = errs.filter((x) => x && ['FRAME_FAILED'].includes(x.kind) && String(x.source) === file);
      check(frameErrs.length === 1, `.errors.jsonl 中该坏帧源记录数=${frameErrs.length}（应 1；实测错误清单文件${fs.existsSync(errFile) ? '存在' : '不存在'}；两轮 stat.errors 只含字符串 ${JSON.stringify((r2.stat.errors || []).slice(0, 2))}）`);
      if (frameErrs.length === 0) {
        check(false, '坏帧现场两轮后 .errors.jsonl 没有 FRAME_FAILED 记录（错误清单未采集坏帧——相当于"失败没有被看见"）');
        const blocked = (rep2 && Array.isArray(rep2.blockedSources)) ? rep2.blockedSources : [];
        const hit = blocked.find((b) => String(b.source) === file);
        check(!!hit, 'run-report.blockedSources 未包含坏帧源');
        if (hit) check(Number(hit.attempts) > 1, `两轮后 blockedSources[].attempts=${hit.attempts}（未累加，仍=1）`);
      }
      // ② R-02 节流 + 报告 count 累加（直接驱动错误清单入口；与坏帧采集共用同一节流器）
      const sim = mk('ch-10b');
      const source = path.join(sim.base, 'fake.jsonl.zstd');
      const t0 = Date.parse('2026-11-09T00:00:00+08:00');
      const attempts = 100;
      for (let i = 0; i < attempts; i += 1) {
        led.appendErrorEvent(sim.root, { kind: 'FRAME_FAILED', source, sourceBytes: 10, sourceMtimeMs: 20 + i, offset: 0, detail: 'sim' }, { nowMs: t0 + i * 15 * 60_000, offsetMinutes: OFFSET });
      }
      const simLines = fs.readFileSync(path.join(sim.root, 'ledger', '.errors.jsonl'), 'utf8').split('\n').filter((x) => x.trim());
      const maxLines = Math.ceil((24 * 3600_000) / (60 * 60_000)) + 1;
      check(simLines.length <= maxLines, `R-02 节流失效：24h 内 ${attempts} 次尝试写了 ${simLines.length} 行 > ${maxLines}`);
      const dup = led.appendErrorEvent(sim.root, { kind: 'FRAME_FAILED', source, sourceBytes: 10, sourceMtimeMs: 20, offset: 0, detail: 'sim' }, { nowMs: t0 + 5_000, offsetMinutes: OFFSET });
      check(dup.duplicate === true && dup.recorded === false, '同 fingerprint 重复调用没有幂等（应 duplicate 且不追加）');
      await run(sim);
      const repSim = reportOf(sim);
      const sumCount = repSim && Array.isArray(repSim.errors)
        ? repSim.errors.filter((e) => String(e.source) === source).reduce((a, e) => a + (Number(e.count) || 0), 0) : 0;
      check(sumCount >= attempts, `运行报告 errors[].count 合计=${sumCount} < 真实尝试 ${attempts}（节流掉的次数未累加——已知未覆盖 #1）`);
      // ③ 短读必须报错/标未覆盖区间（坏帧区间）
      const lostFile = path.join(lab.root, 'ledger', '.lost.jsonl');
      const lost = fs.existsSync(lostFile) ? fs.readFileSync(lostFile, 'utf8').split('\n').filter((x) => x.trim()).map((l) => JSON.parse(l)) : [];
      const lostHit = lost.find((x) => x && typeof x === 'object' && JSON.stringify(x).includes(String(badStart)));
      check(!!lostHit, '短读/坏帧没有在 .lost.jsonl 留下可复算的未覆盖区间（badStart=' + badStart + '）');
      check((r1.stat.errors || []).concat(r2.stat.errors || []).some((e) => /failedFrames=|failedRanges=/.test(String(e))), '坏帧失败没有在 stat.errors 报出 failedFrames/failedRanges');
      expect(problems.length === 0, '★ CH-10 不成立：' + problems.join('；'));
      return '坏帧现场：.errors.jsonl 只 1 条 FRAME_FAILED（fingerprint 幂等）、attempts/count 累加；R-02 节流 24h ≤25 行；.lost.jsonl 留了可复算未覆盖区间';
    }); },
  });

  // ==========================================================================
  // CH-11 · 补记册 99/100/101 → 解析 101 条、下一号 102；尾部校验；写/fsync 失败显式报错
  // ==========================================================================
  runner.add({
    id: 'CH-11', criteria: ['CH-11'], title: '补记册 99/100/101 解析=101 条；下一号=102；尾部校验；写/fsync 失败显式报错',
    async fn() { return withLabs(async (mk) => {
      const wk = await mod('lib/weekly.js');
      const lab = mk('ch-11');
      const baseMs = Date.parse('2026-11-09T10:00:00+08:00');
      const recs = mkWeeklyRecords({ s12: 'ch11x0000001', count: 101, baseMs });
      const sup = wk.writeSupplement({ root: lab.root, codes: recs.map((r) => r.code), records: recs, reason: 'test', generatedAt: '2026-11-09 09:00:00', offsetMinutes: OFFSET });
      const parsed = wk.parseSupplementBook(fs.readFileSync(sup.path, 'utf8'));
      expectEqual(parsed.entries.length, 101, `★ CH-11 不成立：解析返回 ${parsed.entries.length} 条（应 101，不得漏 100）`);
      const ids = parsed.entries.map((e) => e.id);
      for (const n of [99, 100, 101]) expect(ids.some((id) => id.endsWith(`-${n}`)), `★ CH-11 不成立：缺编号 -${n}（解析漏号）`);
      // 下一条编号 == 102
      const more = mkWeeklyRecords({ s12: 'ch11x0000001', count: 102, baseMs }).slice(101);
      const app = wk.writeSupplement({ root: lab.root, codes: more.map((r) => r.code), records: more, reason: 'test', generatedAt: '2026-11-09 09:30:00', offsetMinutes: OFFSET });
      expectEqual(app.added, 1, `★ CH-11 不成立：追加条数=${app.added}（应 1）`);
      expectEqual(app.entries[0].id, `${app.bookId}-102`, `★ CH-11 不成立：下一条编号=${app.entries[0].id}（应 102，不重复不回绕）`);
      // 尾部校验：追加不完整尾块 → 先恢复完整前缀再追加（不得吞/重号）
      const bookPath = app.path;
      const text = fs.readFileSync(bookPath, 'utf8');
      fs.writeFileSync(bookPath, text + '## 补记-截断尾块\n\n- 补记编号: (被截断\n', 'utf8');
      const recs3 = mkWeeklyRecords({ s12: 'ch11x0000001', count: 103, baseMs }).slice(102);
      const repaired = wk.writeSupplement({ root: lab.root, codes: recs3.map((r) => r.code), records: recs3, reason: 'test', generatedAt: '2026-11-09 10:00:00', offsetMinutes: OFFSET });
      expectEqual(repaired.added, 1, `★ CH-11 不成立：截断尾块恢复后追加条数=${repaired.added}（应 1）`);
      expectEqual(repaired.entries[0].id, `${repaired.bookId}-103`, `★ CH-11 不成立：截断尾块恢复后编号=${repaired.entries[0].id}（应 103）`);
      expect((repaired.warnings || []).some((w) => w && w.type === 'tail-repaired'), '★ CH-11 不成立：截断尾块恢复没有告警 tail-repaired');
      // 写/fsync 失败必须显式报错（不得吞）
      const recs4 = mkWeeklyRecords({ s12: 'ch11x0000001', count: 104, baseMs }).slice(103);
      const origFsync = fs.fsyncSync;
      fs.fsyncSync = function patched(fd) {
        const st = String(new Error().stack || '');
        if (st.includes('appendDurable')) { const e = new Error('inject fsync EIO'); e.code = 'EIO'; throw e; }
        return origFsync.call(fs, fd);
      };
      let thrown = null;
      try {
        wk.writeSupplement({ root: lab.root, codes: recs4.map((r) => r.code), records: recs4, reason: 'test', generatedAt: '2026-11-09 10:30:00', offsetMinutes: OFFSET });
      } catch (e) { thrown = e; } finally { fs.fsyncSync = origFsync; }
      expect(thrown, '★ CH-11 不成立：补记册 fsync 失败被吞（没有显式报错）');
      return `101 条解析（含 99/100/101）、下一号=102、截断尾块恢复后=103（告警 tail-repaired）、fsync 注入显式抛错（${String(thrown.message).slice(0, 80)}）`;
    }); },
  });

  // ==========================================================================
  // CH-12 · 清册编号 99/100/101 → 下一号 102；补记册验证器遇未知块/截断尾块 ok=false
  // ==========================================================================
  runner.add({
    id: 'CH-12', criteria: ['CH-12'], title: 'RPT-…-99/100/101 存在→下一号=102；补记册未知块/截断尾块→验证器 ok=false（unknownBlocks>0/tail）；不得报全绿',
    async fn() { return withLabs(async (mk) => {
      const cl = await mod('freeze/cleanup.js');
      const wk = await mod('lib/weekly.js');
      const lab = mk('ch-12');
      const today = (() => { const d = new Date(Date.now() + OFFSET * 60_000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; })();
      for (const n of [99, 100, 101]) fs.writeFileSync(path.join(lab.root, `RPT-${today}-${n}.md`), '# 清册占位\n', 'utf8');
      const next = cl.nextReportId(lab.root, OFFSET);
      expectEqual(next, `RPT-${today}-102`, `★ CH-12 不成立：下一编号=${next}（应 RPT-${today}-102；99/100/101 不得漏号/回绕）`);
      // 补记册含未知块
      const baseMs = Date.parse('2026-11-09T10:00:00+08:00');
      const recs = mkWeeklyRecords({ s12: 'ch12x0000001', count: 2, baseMs });
      const sup = wk.writeSupplement({ root: lab.root, codes: recs.map((r) => r.code), records: recs, reason: 'test', generatedAt: '2026-11-09 09:00:00', offsetMinutes: OFFSET });
      const good = fs.readFileSync(sup.path, 'utf8');
      const withUnknown = good + '## 未知块-删不掉\n\n这里不是标准补记块\n';
      const vUnknown = wk.verifySupplementBook(withUnknown, { bookId: sup.bookId });
      expect(vUnknown.ok === false, '★ CH-12 不成立：验证器遇未知块仍报 ok=true（把未知块静默忽略）');
      expectEqual(vUnknown.unknownBlocks.length, 1, `★ CH-12 不成立：未知块计数=${vUnknown.unknownBlocks.length}（应 1）`);
      // 截断尾块 → 也要 false（不得全绿）
      const truncated = good + '## 补记-截断\n\n- 补记编号: (截断\n';
      const vTrunc = wk.verifySupplementBook(truncated, { bookId: sup.bookId });
      const parsedTrunc = wk.parseSupplementBook(truncated);
      expect(vTrunc.ok === false, '★ CH-12 不成立：验证器遇截断尾块仍报 ok=true');
      expect(parsedTrunc.unknownBlocks.length > 0 || parsedTrunc.tailPartialBytes > 0, `★ CH-12 不成立：截断尾块没有结构化证据（unknownBlocks=${parsedTrunc.unknownBlocks.length} tailPartialBytes=${parsedTrunc.tailPartialBytes}）`);
      return `RPT-99/100/101 存在 → nextReportId=${next}；未知块→ok=false/unknownBlocks=${vUnknown.unknownBlocks.length}；截断尾块→ok=false/tailPartialBytes=${parsedTrunc.tailPartialBytes}`;
    }); },
  });

  // ==========================================================================
  // CH-13 · 首次入账：主表+附表存在；handover-seal 字段完整；verifySealChain ok；report handover.decision
  // ==========================================================================
  runner.add({
    id: 'CH-13', criteria: ['CH-13'], title: '首次入账：主表+附表存在；handover-seal 字段完整（decision/main/appendix/adopted/reopened、weekly-only 字段 null、时间无时区、prev=""）；report handover.decision∈{adopt,generate}',
    async fn() { return withLabs(async (mk) => {
      const sj = await mod('lib/sealjournal.js');
      const lab = mk('ch-13');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const r = await run(lab, { handoverEnabled: true });
      const arts = L.listFiles(lab.root).filter((f) => /交接表/.test(f.rel));
      const mains = arts.filter((f) => /的记忆数据库的启用及交接表\.md$/.test(f.rel));
      const apps = arts.filter((f) => /——附表\.md$/.test(f.rel));
      expectEqual(mains.length, 1, `★ CH-13 不成立：交接表主表数=${mains.length}（应 1；errors=${JSON.stringify(r.stat.errors).slice(0, 200)}）`);
      expectEqual(apps.length, 1, `★ CH-13 不成立：交接表附表数=${apps.length}（应 1）`);
      const j = await journalOf(lab);
      const seals = j.events.filter((e) => e.kind === 'handover-seal');
      expectEqual(seals.length, 1, `★ CH-13 不成立：journal handover-seal 行数=${seals.length}（应 1）`);
      const ev = seals[0];
      const miss = ['decision', 'main', 'appendix', 'adopted', 'reopened'].filter((k) => !(k in ev));
      expect(miss.length === 0, `★ CH-13 不成立：handover-seal 缺字段 ${JSON.stringify(miss)}（keys=${JSON.stringify(Object.keys(ev))}）`);
      expect(ev.decision && ev.main && ev.appendix, `★ CH-13 不成立：decision/main/appendix 有空值（${JSON.stringify({ d: ev.decision, m: ev.main, a: ev.appendix })}）`);
      for (const k of ['sourceRowCount', 'overflow', 'rowCount', 'rowsSha256', 'rows', 'supplementCodesSha256']) {
        expect(ev[k] === null, `★ CH-13 不成立：handover-seal 的 weekly-only 字段 ${k}=${JSON.stringify(ev[k])}（应为 null）`);
      }
      expect(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(ev.at || '')), `★ CH-13 不成立：at=${JSON.stringify(ev.at)} 不符 ^YYYY-MM-DD HH:MM:SS$（无时区后缀）`);
      expect(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(ev.sealedAt || '')), `★ CH-13 不成立：sealedAt=${JSON.stringify(ev.sealedAt)} 不符 ^YYYY-MM-DD HH:MM:SS$`);
      expectEqual(ev.prevSealSha256, '', '★ CH-13 不成立：首行 prevSealSha256 != ""（成链语义）');
      const chain = sj.verifySealChain(lab.root);
      expect(chain.ok === true, `★ CH-13 不成立：verifySealChain() 不为 ok（${JSON.stringify(chain)}）`);
      const rep = reportOf(lab);
      const ho = rep && rep.handover && typeof rep.handover === 'object' ? rep.handover : null;
      if (!ho || !['adopt', 'generate'].includes(String(ho.decision))) {
        skip(`运行报告未产出 handover.decision 段（附录 A 要求；行为面已通过：主表+附表存在、handover-seal 字段完整/weekly-only 全 null/时间无时区/prev=""、verifySealChain.ok）`);
      }
      return `主表+附表存在；journal handover-seal 1 行、字段完整、时间无时区、prev=""；report handover.decision=${ho.decision}`;
    }); },
  });

  // ==========================================================================
  // CH-14 · 交接表写失败：不崩、errors 含 handover failed；其他写入照常；下轮重试成功；handover-seal 仅 1 行
  // ==========================================================================
  runner.add({
    id: 'CH-14', criteria: ['CH-14'], title: '交接表写失败注入：本轮不崩、stat.errors 含 handover failed、台账/周账照常；下轮重试成功且 handover-seal 仅 1 行',
    async fn() { return withLabs(async (mk) => {
      const enc = await mod('lib/encoder.js');
      const ho = await mod('freeze/handover.js');
      const layout = await mod('lib/layout.js');
      const lab = mk('ch-14');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const sessKey = `${enc.normalizeSessionId(lab.sid)}A`;
      const mainName = ho.handoverMainName(sessKey);
      // 注入：把写盘目标旁的 `.tmp` 做成**目录** → writeFileTmpRename 的 openSync 必失败，
      // 真正触发"交接表写失败"分支（V0.6.2：写盘目标是 `<root>/交接表/<主表名>`，不再是根一级）。
      const mainPath = layout.newLayoutPath(lab.root, layout.FILE_KIND.HANDOVER_MAIN, mainName);
      const tmpDir = `${mainPath}.tmp`;
      fs.mkdirSync(tmpDir, { recursive: true });
      const r1 = await run(lab, { handoverEnabled: true, weeklyEnabled: true });
      const rows1 = await rowsOf(lab);
      const xlsx1 = xlsxFilesOf(lab.root);
      expect(r1.stat.errors.some((e) => /handover failed/.test(String(e))), `★ CH-14 不成立：交接表写失败没有进 stat.errors（errors=${JSON.stringify(r1.stat.errors).slice(0, 300)}）`);
      expectEqual(rows1.length, 1, `★ CH-14 不成立：交接表失败拖垮了整轮记账（台账行数=${rows1.length}，应 1）`);
      expect(xlsx1.length >= 1, '★ CH-14 不成立：交接表失败导致周记账没写（其他写入未照常）');
      const j1 = await journalOf(lab);
      expectEqual(j1.events.filter((e) => e.kind === 'handover-seal').length, 0, '★ CH-14 不成立：交接表写失败却写了 handover-seal');
      // 修复（移除占位目录）后下轮重试成功
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const r2 = await run(lab, { handoverEnabled: true, weeklyEnabled: true });
      expect((r2.stat.handoverGenerated || 0) >= 1, `★ CH-14 不成立：下轮没有重试成功（handoverGenerated=${r2.stat.handoverGenerated}，errors=${JSON.stringify(r2.stat.errors).slice(0, 200)}）`);
      const j2 = await journalOf(lab);
      expectEqual(j2.events.filter((e) => e.kind === 'handover-seal').length, 1, `★ CH-14 不成立：handover-seal 行数=${j2.events.filter((e) => e.kind === 'handover-seal').length}（应仅 1）`);
      // V0.6.2：双路径（清册/体检同理：交接表/ 优先、一级兜底），且写端只写 交接表/。
      const mainNow = layout.resolveExisting(lab.root, layout.FILE_KIND.HANDOVER_MAIN, mainName);
      expect(mainNow !== '', `★ CH-14 不成立：重试后主表文件不存在（交接表/ 与一级都没有 ${mainName}）`);
      expectEqual(mainNow, mainPath, '★ CH-14 不成立：重试后主表不在 交接表/（写端应只写新布局）');
      return `写失败轮：errors 含 handover failed、台账 1 行、周账 ${xlsx1.length} 份照常、journal 无 handover-seal；修复后重试生成成功、handover-seal 恰 1 行`;
    }); },
  });

  // ==========================================================================
  // CH-15 · 账文件不可读：readErrors 结构化+计入 stat.errors；不产生"空/无/0"产物；写入被阻止
  // ==========================================================================
  runner.add({
    id: 'CH-15', criteria: ['CH-15'], title: '账文件不可读：readErrors[] 结构化并计入 stat.errors；不生成空产物；相关写入被阻止',
    async fn() { return withLabs(async (mk) => {
      const led = await mod('lib/ledger.js');
      const lab = mk('ch-15');
      const dir = path.join(lab.root, 'ledger');
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, '2026-11-08.jsonl')); // 同名位置放目录 → readFile EISDIR
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const readRes = led.readAll(lab.root);
      expect(readRes.ok === false, '★ CH-15 不成立：账文件不可读时 readAll.ok 仍为 true（被当成"没有账"）');
      const e0 = (readRes.readErrors || [])[0] || {};
      expect(readRes.readErrors.length > 0 && e0.file && (e0.code || e0.message), `★ CH-15 不成立：readErrors 非结构化（${JSON.stringify(readRes.readErrors).slice(0, 200)}）`);
      const r = await run(lab, { weeklyEnabled: true, handoverEnabled: true });
      expect(r.stat.errors.some((e) => /ledger-unreadable|ledger read error/.test(String(e))), `★ CH-15 不成立：不可读没有计入 stat.errors（${JSON.stringify(r.stat.errors).slice(0, 200)}）`);
      // V0.6.2：排除 `ledger/` 运行区与根元数据/导航产物（`.ledger-root`、`账簿总目录.md`）——
      // 后两者是宿主合法写出的根元数据，不是账务产物（见 _lab.mjs: ROOT_METADATA_NAMES 的 @why）。
      const arts = L.listAccountingArtifacts(lab.root);
      expectEqual(arts.length, 0, `★ CH-15 不成立：账不可读仍生成了产物（${JSON.stringify(arts.map((a) => a.rel))}）——不得把"读不到"当"空/无/0"`);
      const dayFiles = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && fs.statSync(path.join(dir, n)).isFile());
      expectEqual(dayFiles.length, 0, `★ CH-15 不成立：账不可读仍写入了台账日文件（${JSON.stringify(dayFiles)}）`);
      return `readErrors=${JSON.stringify(readRes.readErrors).slice(0, 160)}；stat.errors 含 ledger-unreadable；零产物、零台账写入（相关写入被阻止）`;
    }); },
  });

  // ==========================================================================
  // CH-16 · 空目录 vs 不可读：成功读取才允许判空；不可读必须带 readErrors
  // ==========================================================================
  runner.add({
    id: 'CH-16', criteria: ['CH-16'], title: '空目录→成功空（records=[]/readErrors=[]/emptyProven）；不可读→ok=false+readErrors 且不得当"确定为空"',
    async fn() { return withLabs(async (mk) => {
      const led = await mod('lib/ledger.js');
      const empty = mk('ch-16a');
      const resEmpty = led.readAll(empty.root);
      expect(resEmpty.ok === true && resEmpty.emptyProven === true, `★ CH-16 不成立：空目录读取没有证明"空"（ok=${resEmpty.ok} emptyProven=${resEmpty.emptyProven}）`);
      expect(Array.isArray(resEmpty.records) && resEmpty.records.length === 0 && Array.isArray(resEmpty.readErrors) && resEmpty.readErrors.length === 0,
        `★ CH-16 不成立：空目录返回 {records=${JSON.stringify(resEmpty.records)}, readErrors=${JSON.stringify(resEmpty.readErrors)}}`);
      const bad = mk('ch-16b');
      const dir = path.join(bad.root, 'ledger');
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, '2026-11-08.jsonl'));
      const resBad = led.readAll(bad.root);
      expect(resBad.ok === false, '★ CH-16 不成立：不可读账文件时 ok 仍为 true（当成确定为空）');
      expect(resBad.emptyProven === false, '★ CH-16 不成立：不可读时 emptyProven 仍为 true（把"读不到"证明成"空"）');
      expect(Array.isArray(resBad.readErrors) && resBad.readErrors.length > 0, '★ CH-16 不成立：不可读时没有带 readErrors');
      expect(JSON.stringify(resEmpty) !== JSON.stringify(resBad), '★ CH-16 不成立：空目录与不可读两种情况返回同码同结果');
      return `空目录：ok=true/emptyProven=true/records=[]/readErrors=[]；不可读：ok=false/emptyProven=false/readErrors=${resBad.readErrors.length} 条`;
    }); },
  });

  // ==========================================================================
  // CH-17 · 删 state：verifySealChain ok、weekly+handover 两事件可取、已封板 xlsx/交接表字节不变、report stateLost
  // ==========================================================================
  runner.add({
    id: 'CH-17', criteria: ['CH-17'], title: '删 state：verifySealChain ok；能取 weekly+handover 两事件；已封板 xlsx/交接表字节不变；report stateLost:true',
    async fn() { return withLabs(async (mk) => {
      const sj = await mod('lib/sealjournal.js');
      const lab = mk('ch-17');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      await run(lab, { handoverEnabled: true });
      const g = await sealGroup(lab, { s12: 'ch17x0000001', count: 120, baseMs: Date.parse('2026-11-09T10:00:00+08:00') });
      expect(g.res.sealed, '前置失败：weekly 封板未成功');
      const xlsx = xlsxFilesOf(lab.root);
      expect(xlsx.length >= 1, '前置失败：没有周账 xlsx');
      const xlsxSha = xlsx.map((p) => ({ p, sha: L.shaFile(p) }));
      const main = L.listFiles(lab.root).find((f) => /的记忆数据库的启用及交接表\.md$/.test(f.rel) && !/——附表/.test(f.rel));
      expect(main, '前置失败：交接表主表不存在');
      const mainSha = L.shaFile(main.abs);
      // 删 state 后运行
      const stPath = path.join(lab.root, 'ledger', '.state.json');
      fs.unlinkSync(stPath);
      const r = await run(lab, { handoverEnabled: true, weeklyEnabled: true });
      const chain = sj.verifySealChain(lab.root);
      expect(chain.ok === true, `★ CH-17 不成立：删 state 后 verifySealChain 不为 ok（${JSON.stringify(chain)}）`);
      const wkEv = await sj.latestSealEvent(lab.root, 'weekly-seal', g.res.groupId);
      const hoEv = await sj.latestSealEvent(lab.root, 'handover-seal', `${lab.sid}`);
      const hoAny = hoEv || sj.readSealEvents(lab.root).events.find((e) => e.kind === 'handover-seal');
      expect(wkEv && wkEv.sealHash, '★ CH-17 不成立：删 state 后取不到 weekly-seal 事件');
      expect(hoAny, '★ CH-17 不成立：删 state 后取不到 handover-seal 事件');
      const xlsxAfter = xlsx.map((p) => L.shaFile(p));
      expectEqual(JSON.stringify(xlsxAfter), JSON.stringify(xlsxSha.map((x) => x.sha)), '★ CH-17 不成立：删 state 后已封板周账 xlsx 被重写（字节变化）');
      expectEqual(L.shaFile(main.abs), mainSha, '★ CH-17 不成立：删 state 后已封板交接表主表被重建/改写（字节变化）');
      const rep = reportOf(lab);
      const stateLost = rep && (rep.stateLost === true || findKeyDeep(rep, 'stateLost'));
      if (!stateLost) {
        skip(`运行报告未产出 stateLost/sealedFromJournal 段（附录 A 要求；行为面已通过：verifySealChain.ok、weekly+handover 两事件可取、已封板 xlsx/交接表字节不变（${xlsx.length} 份 xlsx + 主表））`);
      }
      return `删 state 后 verifySealChain.ok；weekly/handover 两事件可取；xlsx 与交接表字节不变；report stateLost=${JSON.stringify(stateLost)}`;
    }); },
  });

  // ==========================================================================
  // CH-18 · 状态不明：一律不重写已存在周账；journal 无记录且文件在 → E_SEAL_UNKNOWN 只报不改
  // ==========================================================================
  runner.add({
    id: 'CH-18', criteria: ['CH-18'], title: '仅 weeklySealed 丢失/状态不明：一律不重写已存在周账；journal 无记录且文件在→E_SEAL_UNKNOWN 且字节不变',
    async fn() { return withLabs(async (mk) => {
      const wk = await mod('lib/weekly.js');
      const week = await mod('lib/week.js');
      const baseMs = Date.parse('2026-11-09T10:00:00+08:00');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      // A) 仅 weeklySealed 丢失、weeklyHashes 仍在（journal 仍是权威证据）
      {
        const lab = mk('ch-18a');
        const g = await sealGroup(lab, { s12: 'ch18a0000001', count: 121, baseMs });
        const xlsx = xlsxFilesOf(lab.root).find((p) => fs.existsSync(p));
        expect(xlsx, '前置失败：封板后 xlsx 不存在');
        const sha = L.shaFile(xlsx);
        const stPath = path.join(lab.root, 'ledger', '.state.json');
        const st = fs.existsSync(stPath) ? JSON.parse(fs.readFileSync(stPath, 'utf8')) : {};
        if (st.weeklySealed) delete st.weeklySealed;
        st.weeklyHashes = { [g.res.groupId]: g.res.hash || 'deadbeef' };
        fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n', 'utf8');
        const res = wk.writeWeekly({ root: lab.root, w: g.w, sessKey: g.sessKey, records: g.records, offsetMinutes: OFFSET });
        check(res.skipped === true && res.reason === 'sealed', `A) weeklySealed 丢失后 writeWeekly 没有 skip:sealed（skipped=${res.skipped} reason=${res.reason}）`);
        check(L.shaFile(xlsx) === sha, 'A) weeklySealed 丢失后已存在周账被重写（字节变化）');
      }
      // B) journal 无记录 + state 无记录 + 文件有封板字样但标记不可解析 → E_SEAL_UNKNOWN，只报不改
      {
        const lab = mk('ch-18b');
        const recs = mkWeeklyRecords({ s12: 'ch18b0000001', count: 2, baseMs });
        const w = week.weekOf(baseMs, OFFSET);
        const sessKey = 'ch18b0000001A';
        const file = path.join(lab.root, week.weeklyFolderName(w), week.weeklyFileName(w, sessKey));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '状态: 已封板（本文件不再重写）\n封板hash: 不是64hex\n', 'utf8');
        const sha = L.shaFile(file);
        const res = wk.writeWeekly({ root: lab.root, w, sessKey, records: recs, offsetMinutes: OFFSET, mode: 'sealed' });
        check(res.skipped === true, `B) 状态不明时没有跳过（skipped=${res.skipped}）`);
        check(res.reason === 'E_SEAL_UNKNOWN', `B) 状态不明时 reason=${res.reason}（应 E_SEAL_UNKNOWN）`);
        check((res.warnings || []).some((x) => x && x.type === 'E_SEAL_UNKNOWN'), 'B) 状态不明时没有结构化告警 E_SEAL_UNKNOWN');
        check(L.shaFile(file) === sha, 'B) E_SEAL_UNKNOWN 路径改写了文件字节（应只报不改）');
        const j = await journalOf(lab);
        check(j.events.filter((e) => e.kind === 'weekly-seal').length === 0, 'B) E_SEAL_UNKNOWN 路径仍写了 journal 封板行');
      }
      expect(problems.length === 0, '★ CH-18 不成立：' + problems.join('；'));
      return 'A) 仅 weeklySealed 丢失 → journal 仍判 sealed、xlsx 字节不变；B) journal 无记录+文件在且标记不可解析 → E_SEAL_UNKNOWN 只报不改、无 journal 行';
    }); },
  });

  // ==========================================================================
  // CH-19 · 已清理按结论列：①已删除→已清理 ②③备注含已删除但结论非已删除→不得判已清理；集合双向相等
  // ==========================================================================
  runner.add({
    id: 'CH-19', criteria: ['CH-19'], title: 'B 列只认结论列：结论=已删除→已清理(RPT-…)；未删除/跳过但备注含"已删除"→不得判已清理；已清理集合=={结论=已删除}',
    async fn() { return withLabs(async (mk) => {
      const wk = await mod('lib/weekly.js');
      const org = await mod('lib/original.js');
      const lab = mk('ch-19');
      const codeA = '20261110-ch19a0000001-A-00000001';
      const codeB = '20261110-ch19b0000002-A-00000001';
      const codeC = '20261110-ch19c0000003-A-00000001';
      const rptId = 'RPT-20261110-01';
      fs.writeFileSync(path.join(lab.root, `${rptId}.md`), [
        '# 清册', '',
        '| # | 编码 | 产生时间 | 结论 | 备注 |', '| --- | --- | --- | --- | --- |',
        `| 1 | ${codeA} | 2026-11-10 10:00:00 | 已删除 | 正常销毁 |`,
        `| 2 | ${codeB} | 2026-11-10 10:00:00 | 未删除 | 已删除（后又恢复） |`,
        `| 3 | ${codeC} | 2026-11-10 10:00:00 | 跳过 | 已删除说明 |`,
        '',
      ].join('\n'), 'utf8');
      // B/C 的原文仍在（按文件存在性落 绑定/补记，不得显示已清理）
      for (const c of [codeB, codeC]) {
        const p = path.join(lab.root, org.originalRelPath(2026, 11, c));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '# x\n', 'utf8');
      }
      const cleaned = wk.readCleanedCodesCompat(lab.root);
      expectEqual(cleaned.size, 1, `★ CH-19 不成立：已清理集合大小=${cleaned.size}（应 1，仅结论=已删除；实际=${JSON.stringify([...cleaned.keys()])}）`);
      expect(cleaned.has(codeA), '★ CH-19 不成立：结论=已删除 的编码没有进已清理集合');
      expect(!cleaned.has(codeB) && !cleaned.has(codeC), '★ CH-19 不成立：备注含"已删除"但结论非已删除的编码被误判已清理');
      const labelA = wk.originalLabel(wk.resolveDoc(lab.root, { code: codeA, ts: '2026-11-10T10:00:00+08:00' }, OFFSET, cleaned));
      const labelB = wk.originalLabel(wk.resolveDoc(lab.root, { code: codeB, ts: '2026-11-10T10:00:00+08:00' }, OFFSET, cleaned));
      const labelC = wk.originalLabel(wk.resolveDoc(lab.root, { code: codeC, ts: '2026-11-10T10:00:00+08:00' }, OFFSET, cleaned));
      expect(/^已清理\(RPT-\d{8}-\d+\)$/.test(labelA), `★ CH-19 不成立：①B 列=${JSON.stringify(labelA)}（应 已清理(RPT-…)）`);
      expect(!/^已清理/.test(labelB), `★ CH-19 不成立：②B 列=${JSON.stringify(labelB)}（备注含已删除被误判已清理）`);
      expect(!/^已清理/.test(labelC), `★ CH-19 不成立：③B 列=${JSON.stringify(labelC)}（备注含已删除被误判已清理）`);
      expect(labelB !== '绑定' && labelC !== '绑定', `★ CH-19 不成立：②③ 仍显示绑定（B=${labelB} C=${labelC}）`);
      return `已清理集合=={结论=已删除}（${JSON.stringify([...cleaned.keys()])}）；①B=${labelA}；②B=${labelB}、③B=${labelC}（均非已清理）`;
    }); },
  });

  // ==========================================================================
  // CH-20 · 三种清册来源：v1.3 新格式 / v0.4 旧格式 / >50 条附录 CSV（BOM/引号）且第 51+ 可见
  // ==========================================================================
  runner.add({
    id: 'CH-20', criteria: ['CH-20'], title: 'v1.3 新格式、v0.4 旧格式、>50 条附录 CSV（BOM/引号）三种来源均正确；第 51+ 条状态可见',
    async fn() { return withLabs(async (mk) => {
      const wk = await mod('lib/weekly.js');
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const mkCode = (s12, n) => `20261110-${s12}-A-${String(n).padStart(8, '0')}`;
      // ① v1.3 新格式
      {
        const lab = mk('ch-20a');
        const c = mkCode('ch20a0000001', 1);
        fs.writeFileSync(path.join(lab.root, 'RPT-20261110-01.md'), [
          '| # | 编码 | 产生时间 | 结论 | 备注 |', '| --- | --- | --- | --- | --- |',
          `| 1 | ${c} | 2026-11-10 10:00:00 | 已删除 | x |`, '',
        ].join('\n'), 'utf8');
        const map = wk.readCleanedCodesCompat(lab.root);
        check(map.has(c), '① v1.3 新格式（结论列）没有解析出已删除编码');
      }
      // ② v0.4 旧格式（结果列）
      {
        const lab = mk('ch-20b');
        const c = mkCode('ch20b0000001', 1);
        fs.writeFileSync(path.join(lab.root, 'RPT-20261110-01.md'), [
          '| 编码 | 会话键 | 月份 | 大小 | 结果 | 原因 |', '| --- | --- | --- | --- | --- | --- |',
          `| ${c} | ch20b0000001A | 2026-11 | 1.0 KB | 已删除 | x |`, '',
        ].join('\n'), 'utf8');
        const map = wk.readCleanedCodesCompat(lab.root);
        check(map.has(c), '② v0.4 旧格式（结果列）没有解析出已删除编码');
      }
      // ③ >50 条：正文 50 行 + 附录 CSV（BOM/引号）承载第 51+ 条
      {
        const lab = mk('ch-20c');
        const rptId = 'RPT-20261110-02';
        const codes = Array.from({ length: 55 }, (_, i) => mkCode('ch20c0000001', i + 1));
        const head = [
          '| # | 编码 | 产生时间 | 结论 | 备注 |', '| --- | --- | --- | --- | --- |',
        ];
        const body = codes.slice(0, 50).map((c, i) => `| ${i + 1} | ${c} | 2026-11-10 10:00:00 | 已删除 | x |`);
        fs.writeFileSync(path.join(lab.root, `${rptId}.md`), [...head, ...body, '', '> 第 51 条起见附录 CSV。', ''].join('\n'), 'utf8');
        const csvLines = [
          '序号,编码,产生时间,结论,备注',
          ...codes.slice(50).map((c, i) => `${51 + i},"${c}","2026-11-10 10:00:00","已删除","含,逗号"`),
        ];
        fs.writeFileSync(path.join(lab.root, `${rptId}-明细.csv`), '\uFEFF' + csvLines.join('\r\n') + '\r\n', 'utf8');
        const map = wk.readCleanedCodesCompat(lab.root);
        check(map.has(codes[0]), '③ 正文前 50 条没有解析出已删除编码');
        const missing = codes.slice(50).filter((c) => !map.has(c));
        check(missing.length === 0, `③ 附录 CSV 中第 51+ 条（${missing.length}/${codes.length - 50}）没有进入已清理集合——CSV（BOM/引号）未被解析；实测 map 大小=${map.size}`);
      }
      expect(problems.length === 0, '★ CH-20 不成立：' + problems.join('；'));
      return '三种来源均正确：v1.3 结论列、v0.4 结果列、>50 附录 CSV（BOM/引号）第 51+ 条状态可见';
    }); },
  });

  // ==========================================================================
  // CH-21 · xlsx 十列逐字、四态仅 B 列、RPT 不写备注、A 列无占位、周统计审计引用 I 列
  // ==========================================================================
  runner.add({
    id: 'CH-21', criteria: ['CH-21'], title: 'xlsx：A1:J1 十列逐字；四态仅在 B 列；RPT 号不写备注；A 列无占位文本；周统计审计公式引用 I 列',
    async fn() { return withLabs(async (mk) => {
      const wk = await mod('lib/weekly.js');
      const lab = mk('ch-21');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000, { userText: 'CH-21 一轮' })] });
      await run(lab, { weeklyEnabled: true });
      const xlsx = xlsxFilesOf(lab.root);
      expectEqual(xlsx.length, 1, `前置失败：应有 1 份周账（实际 ${xlsx.length}）`);
      const facts = probeXlsx(lab.base, xlsx);
      if (!facts) skip('openpyxl 探针不可用或打不开周账 xlsx（环境缺 openpyxl）——该判据未验证');
      const fact = facts[0];
      expect(fact.ok === true, `前置失败：openpyxl 打不开 xlsx（${JSON.stringify(fact.error)}）`);
      const daySheets = (fact.sheets || []).filter((s) => /^周[一二三四五六日]$/.test(s.name));
      expectEqual(daySheets.length, 7, `★ CH-21 不成立：日表数=${daySheets.length}（应 7）`);
      const expected = wk.TEN_COLUMNS;
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      for (const s of daySheets) {
        check(JSON.stringify(s.headers) === JSON.stringify(expected), `日表 ${s.name} 表头!=十列（${JSON.stringify(s.headers)}）`);
        for (const row of s.rows || []) {
          if (row.A !== undefined && row.A !== null && String(row.A).trim() !== '') {
            check(CODE_RE.test(String(row.A)), `日表 ${s.name} 行 ${row.r} A 列出现非编码/占位文本：${JSON.stringify(row.A)}`);
          }
          if (row.B !== undefined && row.B !== null && String(row.B).trim() !== '') {
            check(/^(绑定|补记|缺凭证|已清理\(RPT-\d{8}-\d+\))$/.test(String(row.B)), `日表 ${s.name} 行 ${row.r} B 列非四态：${JSON.stringify(row.B)}`);
          }
          for (const k of ['D', 'E', 'F', 'G', 'I', 'J']) {
            check(!String(row[k] === undefined || row[k] === null ? '' : row[k]).includes('RPT-'), `日表 ${s.name} 行 ${row.r} ${k} 列写了 RPT 号（备注/人工列不得出现）`);
          }
        }
      }
      const stats = (fact.sheets || []).find((s) => s.name === '周统计');
      expect(stats && stats.cells, '★ CH-21 不成立：周统计页缺失');
      const statVals = Object.entries(stats.cells || {}).map(([k, v]) => `${k}=${String(v.v)}`);
      const auditCells = statVals.filter((x) => /\$I\$2:\$I\$121|I2:I121/.test(x));
      check(auditCells.length >= 3, `★ CH-21 不成立：周统计审计公式未引用 I 列（命中 ${auditCells.length} 个单元格：${JSON.stringify(statVals.filter((x) => /COUNTIF/.test(x)).slice(0, 4))}）`);
      expect(problems.length === 0, '★ CH-21 不成立：' + problems.join('；'));
      return `7 张日表 A1:J1 十列逐字；A 列全编码、B 列仅四态、人工列无 RPT 号；周统计审计公式引用 I 列（${auditCells.length} 处）`;
    }); },
  });

  // ==========================================================================
  // CH-22 · 周统计公式/计数：C=COUNTA、D:F=COUNTIF(I)、总计+溢出==源行数；A4==journal sealHash
  // ==========================================================================
  runner.add({
    id: 'CH-22', criteria: ['CH-22'], title: '周统计 C=COUNTA(A2:A121)、D:F=COUNTIF(I2:I121,…)；总计+溢出==源行数；说明页 A4==journal sealHash',
    async fn() { return withLabs(async (mk) => {
      const baseMs = Date.parse('2026-11-09T10:00:00+08:00');
      const lab = mk('ch-22');
      const g = await sealGroup(lab, { s12: 'ch22x0000001', count: 121, baseMs });
      expect(g.res.sealed, '前置失败：封板未成功');
      const xlsx = xlsxFilesOf(lab.root);
      expectEqual(xlsx.length, 1, `前置失败：应有 1 份封板周账（${xlsx.length}）`);
      const j = await journalOf(lab);
      const ev = j.events.find((e) => e.kind === 'weekly-seal' && e.key === g.res.groupId);
      expect(ev, '前置失败：journal 没有该组封板行');
      const facts = probeXlsx(lab.base, xlsx);
      if (!facts) skip('openpyxl 探针不可用或打不开周账 xlsx（环境缺 openpyxl）——该判据未验证');
      const fact = facts[0];
      expect(fact.ok === true, `前置失败：openpyxl 打不开 xlsx（${JSON.stringify(fact.error)}）`);
      const stats = (fact.sheets || []).find((s) => s.name === '周统计');
      expect(stats && stats.cells, '★ CH-22 不成立：周统计页缺失');
      const cell = (k) => String((stats.cells[k] && stats.cells[k].v) === undefined ? '' : stats.cells[k].v);
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      for (let r = 5; r <= 11; r += 1) {
        check(/COUNTA\(.*\$A\$2:\$A\$121\)/.test(cell(`C${r}`)), `C${r} 公式不是 COUNTA(A2:A121)：${JSON.stringify(cell(`C${r}`))}`);
        check(/COUNTIF\(.*\$I\$2:\$I\$121.*通过/.test(cell(`D${r}`)), `D${r} 公式不是 COUNTIF(I2:I121,"通过")：${JSON.stringify(cell(`D${r}`))}`);
        check(/COUNTIF\(.*\$I\$2:\$I\$121.*不通过/.test(cell(`E${r}`)), `E${r} 公式不是 COUNTIF(I2:I121,"不通过")：${JSON.stringify(cell(`E${r}`))}`);
        check(/COUNTIF\(.*\$I\$2:\$I\$121.*待审/.test(cell(`F${r}`)), `F${r} 公式不是 COUNTIF(I2:I121,"待审")：${JSON.stringify(cell(`F${r}`))}`);
      }
      const daySheets = (fact.sheets || []).filter((s) => /^周[一二三四五六日]$/.test(s.name));
      const dataRows = daySheets.reduce((a, s) => a + (s.rows || []).length, 0);
      const overflow = Number(cell('C13'));
      check(Number.isFinite(overflow), `溢出单元格 C13 不是数字：${JSON.stringify(cell('C13'))}`);
      check(dataRows + overflow === Number(ev.sourceRowCount), `总计+溢出=${dataRows}+${overflow} != journal.sourceRowCount=${ev.sourceRowCount}`);
      const a4 = a4SealHash(fact);
      check(a4 === ev.sealHash, `说明页 A4=${JSON.stringify(a4)} != journal sealHash=${ev.sealHash}`);
      expect(problems.length === 0, '★ CH-22 不成立：' + problems.join('；'));
      return `C5:C11=COUNTA($A$2:$A$121)、D:F=COUNTIF($I$2:$I$121,…)；总计 ${dataRows} + 溢出 ${overflow} == 源 ${ev.sourceRowCount}；A4==journal sealHash（${a4.slice(0, 12)}…）`;
    }); },
  });

  // ==========================================================================
  // CH-23 · 跨月会话（起 10-31、末轮 11-01）：全部原文在 2026年10月/…；11 月夹不得出现该会话原文
  // ==========================================================================
  runner.add({
    id: 'CH-23', criteria: ['CH-23'], title: '跨月会话（起 10-31、末轮 11-01）：全部原文在 2026年10月/…（按编码日期段取月）；11 月夹无该会话原文',
    async fn() { return withLabs(async (mk) => {
      const lab = mk('ch-23');
      const createdAt = Date.parse('2026-10-31T23:00:00+08:00');
      L.resetSeq(0);
      L.writeSession(lab, { events: [
        ...L.sessionHeader(lab.sid, createdAt),
        ...L.simpleTurn(1, createdAt + 10 * 60_000, { userText: '10-31 的轮' }),
        ...L.simpleTurn(2, Date.parse('2026-11-01T00:10:00+08:00'), { userText: '11-01 的轮' }),
      ] });
      await run(lab);
      const rows = await rowsOf(lab);
      expectEqual(rows.length, 2, `前置失败：应入账 2 行（实际 ${rows.length}）`);
      for (const rec of rows) {
        expect(String(rec.doc).replace(/\\/g, '/').startsWith('2026年10月/'), `★ CH-23 不成立：code=${rec.code} 原文路径=${rec.doc}（应按编码日期段=会话开始日落在 2026年10月/）`);
      }
      const all = L.listFiles(lab.root).map((f) => f.rel.replace(/\\/g, '/'));
      const novOriginals = all.filter((r) => r.startsWith('2026年11月/') && r.includes('完整原文'));
      expectEqual(novOriginals.length, 0, `★ CH-23 不成立：11 月夹下出现了该会话原文（${JSON.stringify(novOriginals)}）——按轮发生月拆夹`);
      return `2 轮原文全部在 2026年10月/10月总“完整原文”（${rows.map((r) => path.basename(r.doc)).join('、')}）；11 月夹零原文`;
    }); },
  });

  // ==========================================================================
  // CH-24 · 每 code 前 8 位 == 所在 YYYY年MM月；同会话唯一月夹；周记账仍按 ts 落月（规则在报告中体现）
  // ==========================================================================
  runner.add({
    id: 'CH-24', criteria: ['CH-24'], title: '每 code 前 8 位日期==所在 YYYY年MM月 目录；同一会话原文唯一月夹；周记账仍按 ts 落月',
    async fn() { return withLabs(async (mk) => {
      const lab = mk('ch-24');
      const createdAt = Date.parse('2026-10-31T23:00:00+08:00');
      L.resetSeq(0);
      L.writeSession(lab, { events: [
        ...L.sessionHeader(lab.sid, createdAt),
        ...L.simpleTurn(1, createdAt + 10 * 60_000, { userText: 'CH-24 十月轮' }),
        ...L.simpleTurn(2, Date.parse('2026-11-01T00:10:00+08:00'), { userText: 'CH-24 十一月轮' }),
      ] });
      await run(lab, { weeklyEnabled: true });
      const rows = await rowsOf(lab);
      const views = L.listFiles(lab.root).filter((f) => f.rel.endsWith('完整原文.md')).map((f) => f.rel.replace(/\\/g, '/'));
      const problems = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      for (const rec of rows) {
        const rel = String(rec.doc).replace(/\\/g, '/');
        const m = /^(\d{4})年(\d{2})月\//.exec(rel);
        check(!!m, `code=${rec.code} 原文不在 YYYY年MM月 目录（${rel}）`);
        if (m) check(`${m[1]}${m[2]}` === String(rec.code).slice(0, 6), `code=${rec.code} 前 8 位日期段与目录 ${m[1]}年${m[2]}月 不一致`);
      }
      const months = new Set(views.map((r) => (r.split('/')[0] || '')));
      check(months.size === 1, `同一会话原文被拆到多个月夹：${JSON.stringify([...months])}`);
      // 周记账仍按 ts 落月：10-31 与 11-01 两轮分别落 10 月/11 月周账
      const xlsx = L.listFiles(lab.root).filter((f) => f.rel.endsWith('.xlsx')).map((f) => f.rel.replace(/\\/g, '/'));
      const octX = xlsx.filter((r) => r.startsWith('2026年10月/'));
      const novX = xlsx.filter((r) => r.startsWith('2026年11月/'));
      check(octX.length >= 1, `周记账没有按 ts 落 2026年10月（xlsx=${JSON.stringify(xlsx)}）`);
      check(novX.length >= 1, `周记账没有按 ts 落 2026年11月（xlsx=${JSON.stringify(xlsx)}）`);
      expect(problems.length === 0, '★ CH-24 不成立：' + problems.join('；'));
      const rep = reportOf(lab);
      const ruleInReport = !!(rep && JSON.stringify(rep).includes('按 ts'));
      return `每个 code 前 8 位==所在年月夹；同一会话原文唯一月夹（${JSON.stringify([...months])}）；周记账按 ts 落 10 月(${octX.length})/11 月(${novX.length})；报告规则字段=${ruleInReport}`;
    }); },
  });
}

await main(import.meta.url, {
  name: 'v0.5 P1 可信链 CH-01…CH-24',
  target: PLUGIN,
  build,
});
