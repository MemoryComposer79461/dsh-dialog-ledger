/**
 * @file 验收-只读面.mjs
 * @role V0.6「工具卡片 + 只读面」端到端验收（契约 §4 的 A1–A7；V0.6.1 补 A8 同源守卫）。
 *
 * @why **进程内直接调，不起 HTTP**：
 *      · HTTP 服务要端口、要生命周期，验收脚本一旦崩还可能留孤儿进程；
 *      · `tools/panelapi.js` 自带 `runPanelRoute` / `callPanelApi` / `createPanelResource`
 *        三个进程内入口，路由处理器与真实 HTTP 共用同一段代码 —— 进程内调等价，
 *        而且更快、更稳、更好断言。
 *      · 仍然用 fake ctx 捕获 `webServer.register(route)`，证明"7 条 exact 路由真的注册了"，
 *        再把每条路由的 `resource(new Request(...))` 当 fake req/res 调一遍，
 *        验证 HTTP 适配层（状态码 / 响应头 / JSON）也对。
 *      · V0.6.1/A8 起，HTTP 载体的正常路径请求要补 `Sec-Fetch-Site: same-origin`：
 *        同源守卫是纵深防御（浏览器同源 fetch 会带该头），进程内直调 `runPanelRoute` 不加守卫。
 *
 * @why 夹具账库自己造：验收必须在**一份可丢弃的临时库**上跑，绝不许碰真账。
 *      夹具覆盖契约 A2 要求的全部产物类别：
 *      台账 jsonl / 原文 md / 原始事件 json / 周记账 xlsx / 交接表主表+附表 /
 *      封板 journal / state / run-report。
 *
 * 判据（契约 §4）：
 *   A1 7 条路由 + 9 个工具（8 只读 + 1 受控）在夹具上全部可用
 *   A2 除读日志外全库 sha256 逐字节不变
 *   A3 每次 GET/工具调用后读日志恰好 +1 行且字段齐；HEAD 不计
 *   A4 读日志不被当成台账（readAll 行数/坏行数不变）
 *   A5 错误路径：坏月份 bad-param / 不存在编码 not-found / 空库 ok:true + 计数 0 + health.ok=null
 *   A6 9 个工具的 presentResult 符合 ToolResultView 形状
 *   A7 summary 顶层键 + health 22 键一个不少
 *   A8 HTTP 载体同源守卫：无来源头/跨源 → 403 forbidden-origin；同源 → 200（V0.6.1）
 *
 * @why V0.6.4 ③（读日志滚动）：读日志自本版起落 `<root>/ledger/.reads/YYYY-MM.jsonl`（超 8 MiB 切分片），
 *      历史 `<root>/ledger/.reads.jsonl` 只读兼容。A2 的"唯一豁免"仍只针对读日志——旧单文件与
 *      `.reads/` 分片两种位置都算读日志；A3 的"+1 行"按两种位置合计计数（新写入必须落 `.reads/`）。
 *
 * 运行：`node docs/验收-v0.6/验收-只读面.mjs`
 * 退出码：0 = 全绿；非 0 = 有红项（明细写 `docs/验收-v0.6/_results/只读面.json`）。
 *
 * @depends ../tools/panelapi.js（host-api 产出）、../tools/toolface.js、../tools/toolcards.js、../lib/ledger.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const RESULTS_DIR = path.join(HERE, '_results');
const RESULTS_FILE = path.join(RESULTS_DIR, '只读面.json');

const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const codeOf = (n) => `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`;
/**
 * V0.6.1 / A8：浏览器同源页面的 fetch 会带 `Sec-Fetch-Site: same-origin`。
 * HTTP resource 的"正常路径"请求必须带它（同源守卫是纵深防御，不是密码学鉴权）。
 */
const SAME_SITE_HEADERS = { 'sec-fetch-site': 'same-origin' };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowStamp = () => {
  const d = new Date(Date.now() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +08:00`;
};

const results = {
  v: 1,
  suite: '验收-只读面',
  contract: 'docs/验收-v0.6/接口契约.md §4',
  at: nowStamp(),
  startedAtMs: Date.now(),
  module: {},
  fixture: {},
  checks: [],
  numbers: {},
  ok: false,
};

/** 跑一个验收项：异常记红，不中断后续项（要一次看到全部问题）。 */
async function check(id, name, fn) {
  const started = Date.now();
  const item = { id, name, ok: false, detail: null, error: null, ms: 0 };
  try {
    item.detail = await fn();
    item.ok = true;
  } catch (e) {
    item.error = e && e.message ? e.message : String(e);
  }
  item.ms = Date.now() - started;
  results.checks.push(item);
  console.log(`[${id}] ${item.ok ? 'PASS' : 'FAIL'} —— ${name}` + (item.ok ? '' : `\n       ✗ ${item.error}`));
  return item;
}

/** 模块存在性：缺文件要给出可读的诊断，而不是 import 一崩到底。 */
async function importOptional(rel, label) {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) return { ok: false, abs, mod: null, reason: label + ' 不存在：' + abs };
  try {
    const mod = await import(pathToFileURL(abs).href);
    return { ok: true, abs, mod };
  } catch (e) {
    return { ok: false, abs, mod: null, reason: label + ' 加载失败：' + (e && e.message ? e.message : String(e)) };
  }
}

/** 从导出里挑一个函数（防 host-api 命名微调；仍优先契约给定名）。 */
function pickFn(mod, names, label) {
  for (const n of names) {
    if (mod && typeof mod[n] === 'function') return { fn: mod[n], name: n };
  }
  throw new Error(label + ' 没有可调用的导出（找过：' + names.join(', ') + '）');
}

// ============================================================================
// 夹具账库
// ============================================================================

/**
 * 造一条台账行 + 对应原文 md + 原始事件 json（三哈希齐全 → 可判定 bound）。
 * @returns {{row:object, mdRel:string, files:object}}
 */
function mkBoundRow(root, n, sid) {
  const code = codeOf(n);
  const ts = `2026-11-08 ${String(10 + n).padStart(2, '0')}:00:00 +08:00`;
  const body = `## 1. 用户输入\n\n第 ${n} 轮的用户输入（夹具）。\n\n`
    + `## 2. 助手回复\n\n第 ${n} 轮的回复（夹具）。\n`;
  const bodyHash = sha256(Buffer.from(body, 'utf8'));
  const markdown = [
    '---',
    `编码: ${code}`,
    `名称: ${code} 完整原文`,
    `正文hash: ${bodyHash}`,
    '---',
    '',
    body,
  ].join('\n');
  const mdRel = `2026年11月${path.sep}11月总“完整原文”${path.sep}${code} 完整原文.md`;
  const mdAbs = path.join(root, mdRel);
  fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
  fs.writeFileSync(mdAbs, markdown, 'utf8');

  const attRel = `${code} 原始事件.json`;
  const attAbs = path.join(path.dirname(mdAbs), attRel);
  const attBytes = Buffer.from(JSON.stringify({ code, turn: n, events: [{ type: 'user', text: `第 ${n} 轮` }] }) + '\n', 'utf8');
  fs.writeFileSync(attAbs, attBytes);

  const docFileSha256 = sha256(fs.readFileSync(mdAbs));
  const row = {
    v: 3,
    code,
    ts,
    sid,
    turn: n,
    seq: n,
    status: 'ok',
    turnState: 'closed',
    doc: mdRel,
    docSha256: bodyHash,
    docFileSha256,
    attachment: { name: attRel, sha256: sha256(attBytes), bytes: attBytes.length },
  };
  return { row, mdRel, files: { md: mdRel, json: path.join(path.dirname(mdRel), attRel) } };
}

/**
 * 夹具：3 行台账（2 行同会话 + 1 行别的会话）+ 契约 A2 要求的全部产物类别。
 * 注意：这些产物只是"最小可读"，不是完整业务样本 —— 验收目标是只读性与形状，不是记账正确性。
 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v06-readonly-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });

  const built = [mkBoundRow(root, 1, SID), mkBoundRow(root, 2, SID), mkBoundRow(root, 3, 'session-other')];
  fs.writeFileSync(
    path.join(root, 'ledger', '2026-11-08.jsonl'),
    built.map((b) => JSON.stringify(b.row)).join('\n') + '\n',
    'utf8',
  );

  // 周记账 xlsx（夹具只要求"文件在"；对账只判存在性，不解析 xlsx 内容）
  const xlsxRel = path.join('2026年11月', '11月第2周-75238718e41aA的周记账.xlsx');
  fs.mkdirSync(path.dirname(path.join(root, xlsxRel)), { recursive: true });
  fs.writeFileSync(path.join(root, xlsxRel), '草稿周记账（夹具占位）\n', 'utf8');

  // 交接表主表 + 附表（文件名必须符合 handover 的 REGEXP）
  const sessKey = '75238718e41aA';
  const handoverRel = `${sessKey}的记忆数据库的启用及交接表.md`;
  const appendixRel = `${sessKey}的记忆数据库的启用及交接表——附表.md`;
  fs.writeFileSync(path.join(root, handoverRel), '# 启用及交接表（夹具）\n', 'utf8');
  fs.writeFileSync(path.join(root, appendixRel), '# 附表（夹具）\n', 'utf8');

  // state / 封板 journal / run-report（A2 要求"每类产物"都不许被读操作改字节）
  const stateRel = path.join('ledger', '.state.json');
  fs.writeFileSync(path.join(root, stateRel), JSON.stringify({
    initialized: true,
    firstRunAt: '2026-11-08 10:00:00 +08:00',
    lastRunAt: '2026-11-08 10:05:00 +08:00',
    weeklySealed: {},
  }, null, 2) + '\n', 'utf8');
  const journalRel = path.join('ledger', '.seal-journal.jsonl');
  fs.writeFileSync(path.join(root, journalRel), '', 'utf8');
  const reportRel = path.join('ledger', '.run-report-20261108.json');
  fs.writeFileSync(path.join(root, reportRel), JSON.stringify({
    v: 1,
    at: '2026-11-08 10:05:00',
    offsetMinutes: 480,
    ledgerRows: 3,
    ok: true,
    okStrict: true,
    counts: {
      ledgerRows: 3, originalMissing: 0, originalOrphan: 0, weeklyGroupsMissing: 0,
      lostGaps: 0, receiptBreaks: 0, badLines: 0, readErrors: 0,
      blockedSources: 0, stuckSources: 0, unavailable: 0, errors: 0,
    },
    gate: { conclusion: 'ok', okStrict: true },
    sealChain: { ok: true, lines: 0, events: 0, breaks: 0 },
  }, null, 2) + '\n', 'utf8');

  const artifacts = [
    { label: '台账 jsonl', rel: path.join('ledger', '2026-11-08.jsonl') },
    { label: '原文 md', rel: built[0].files.md },
    { label: '原始事件 json', rel: built[0].files.json },
    { label: '周记账 xlsx', rel: xlsxRel },
    { label: '交接表主表', rel: handoverRel },
    { label: '交接表附表', rel: appendixRel },
    { label: '封板 journal', rel: journalRel },
    { label: 'state', rel: stateRel },
    { label: 'run-report', rel: reportRel },
  ];

  return { base, root, artifacts, rows: built.map((b) => b.row) };
}

/**
 * 是否读日志路径（契约 A2 的唯一豁免）。
 * V0.6.4 ③ 起读日志 = 历史单文件 `ledger/.reads.jsonl` + 新目录 `ledger/.reads/` 下所有分片；
 * 两种位置都属读日志，都不计入"全库 sha256 不变"的产物集合。
 */
function isReadLogRel(rel) {
  const p = rel.split(path.sep).join('/');
  return p === 'ledger/.reads.jsonl' || p === 'ledger/.reads' || p.startsWith('ledger/.reads/');
}

/** 全库 sha256 快照；唯一豁免：读日志（旧 `.reads.jsonl` + 新 `.reads/` 分片，契约 A2）。 */
function snapshot(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs);
      if (isReadLogRel(rel)) continue; // .reads 目录整棵跳过（分片都属读日志）
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.push(rel.split(path.sep).join('/') + ':' + sha256(fs.readFileSync(abs)));
    }
  };
  walk(root);
  return out.sort();
}

// ============================================================================
// 读日志 / HTTP 小工具
// ============================================================================

/** `.reads/` 分片清单（按写入顺序：月份 → 分片序号；文件名编码顺序，比 mtime 耐搬动）。 */
function readShards(root) {
  const dir = path.join(root, 'ledger', '.reads');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => {
      const m = /^(\d{4}-\d{2})(?:\.(\d{2,}))?\.jsonl$/.exec(name);
      return m ? { name, month: m[1], serial: m[2] ? Number(m[2]) : 1 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.month === b.month ? a.serial - b.serial : (a.month < b.month ? -1 : 1)));
}

/**
 * 读日志全部行（**写入顺序**）：历史单文件 `.reads.jsonl`（若有）→ `.reads/` 分片（月份/序号升序，行序）。
 * @why V0.6.4 ③：A3 的"+1 行"必须按两种位置合计计数，否则老库（有 .reads.jsonl）会算错。
 */
function readLogLines(root) {
  const files = [];
  const legacy = path.join(root, 'ledger', '.reads.jsonl');
  if (fs.existsSync(legacy)) files.push(legacy);
  for (const s of readShards(root)) files.push(path.join(root, 'ledger', '.reads', s.name));
  const lines = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() !== '') lines.push(line);
    }
  }
  return lines;
}

function lastReadRow(root) {
  const lines = readLogLines(root);
  if (lines.length === 0) throw new Error('读日志为空');
  return JSON.parse(lines[lines.length - 1]);
}

/** fake ctx：捕获 webServer.register(route)，不启动任何监听。 */
function makeFakeCtx() {
  const registered = [];
  let disposed = 0;
  const fakeWebServer = {
    register(route) {
      registered.push(route);
      return () => { disposed += 1; };
    },
    getOrigin() { return 'http://panel.local'; },
  };
  const ctx = {
    get(name) { return name === 'webServer' ? fakeWebServer : undefined; },
    webServer: fakeWebServer,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined; },
  };
  return { ctx, registered, fakeWebServer, disposedCount: () => disposed };
}

/** 把 resource 当 fake req/res 调：new Request → Response（等价 HTTP 适配层）。 */
async function callResource(route, query = {}) {
  const url = new URL('http://panel.local' + route.path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  // V0.6.1/A8：HTTP 载体的正常路径一律带同源头（否则会被同源守卫 403）
  const res = await route.resource(new Request(url.href, { method: 'GET', headers: SAME_SITE_HEADERS }));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

// ============================================================================
// ToolResultView 校验（A6）
// ============================================================================

const VALID_CARDS = new Set(['generic', 'read', 'search', 'terminal', 'diff', 'web']);

function assertContentBlocks(content, where) {
  assert.ok(Array.isArray(content), where + ': content 必须是数组');
  for (const b of content) {
    assert.ok(b && typeof b === 'object', where + ': content 块必须是对象');
    assert.equal(b.type, 'text', where + ': 只允许 text 块');
    assert.equal(typeof b.text, 'string', where + ': text 必须是字符串');
  }
}

function assertToolResultView(view, where) {
  assert.ok(view && typeof view === 'object', where + ': presentResult 必须返回对象（实际 ' + typeof view + '）');
  assert.ok(VALID_CARDS.has(view.card), where + ': card 非法（' + view.card + '）');
  if (view.card === 'generic' || view.card === 'read') {
    if (view.title !== undefined) assert.equal(typeof view.title, 'string', where + ': title 必须是字符串');
    if (view.content !== undefined) assertContentBlocks(view.content, where);
  }
  if (view.card === 'read') {
    assert.equal(typeof view.path, 'string', where + ': read.path 必须是字符串');
    assert.ok(Number.isInteger(view.offset) && view.offset >= 0, where + ': read.offset 必须是非负整数');
    assert.ok(Array.isArray(view.lines), where + ': read.lines 必须是数组');
    for (const l of view.lines) {
      assert.ok(Number.isInteger(l.number), where + ': read.lines[].number 必须是整数');
      assert.equal(typeof l.text, 'string', where + ': read.lines[].text 必须是字符串');
    }
    assert.ok(Number.isInteger(view.totalLines), where + ': read.totalLines 必须是整数');
  }
  if (view.card === 'search') {
    assert.equal(view.shape, 'matches', where + ': search.shape 必须是 matches');
    assert.ok(Array.isArray(view.files), where + ': search.files 必须是数组');
    assert.equal(typeof view.truncated, 'boolean', where + ': search.truncated 必须是布尔');
    assert.ok(Number.isFinite(view.total), where + ': search.total 必须是数字');
  }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const t0 = Date.now();

  // ---------- 依赖模块 ----------
  const panelLoad = await importOptional(path.join('tools', 'panelapi.js'), 'tools/panelapi.js');
  const toolfaceLoad = await importOptional(path.join('tools', 'toolface.js'), 'tools/toolface.js');
  const toolcardsLoad = await importOptional(path.join('tools', 'toolcards.js'), 'tools/toolcards.js');
  const ledgerLoad = await importOptional(path.join('lib', 'ledger.js'), 'lib/ledger.js');

  results.module = {
    panelapi: { path: panelLoad.abs, exists: panelLoad.ok, reason: panelLoad.reason || null },
    toolface: { path: toolfaceLoad.abs, exists: toolfaceLoad.ok },
    toolcards: { path: toolcardsLoad.abs, exists: toolcardsLoad.ok },
    ledger: { path: ledgerLoad.abs, exists: ledgerLoad.ok },
  };

  if (!panelLoad.ok) {
    results.fatal = panelLoad.reason;
    console.error('[验收-只读面] ✗ 无法开始：' + panelLoad.reason + '（等 host-api 就绪后重跑）');
    return;
  }
  if (!toolfaceLoad.ok || !toolcardsLoad.ok || !ledgerLoad.ok) {
    results.fatal = [toolfaceLoad.reason, toolcardsLoad.reason, ledgerLoad.reason].filter(Boolean).join('；');
    console.error('[验收-只读面] ✗ 工具面/账本模块加载失败：' + results.fatal);
    return;
  }

  const panel = panelLoad.mod;
  const toolface = toolfaceLoad.mod;
  const toolcards = toolcardsLoad.mod;
  const ledger = ledgerLoad.mod;

  const regFn = pickFn(panel, ['registerLedgerPanelApi', 'registerPanelApi', 'registerLedgerApi'], 'tools/panelapi.js 注册函数');
  const runRouteFn = pickFn(panel, ['runPanelRoute'], 'tools/panelapi.js runPanelRoute');
  const callApiFn = pickFn(panel, ['callPanelApi'], 'tools/panelapi.js callPanelApi');
  results.module.exports = {
    register: regFn.name,
    runPanelRoute: runRouteFn.name,
    callPanelApi: callApiFn.name,
    API_PREFIX: panel.API_PREFIX || null,
    API_ROUTES: Array.isArray(panel.API_ROUTES) ? panel.API_ROUTES : null,
  };

  const API_PREFIX = typeof panel.API_PREFIX === 'string' && panel.API_PREFIX ? panel.API_PREFIX : '/dialog-ledger/api/';
  const ROUTES = Array.isArray(panel.API_ROUTES) && panel.API_ROUTES.length === 7
    ? panel.API_ROUTES
    : ['ping', 'summary', 'search', 'turn', 'original', 'reads', 'reconcile'];

  const fx = makeFixture();
  const { base, root, artifacts } = fx;

  const env = {
    getRoot: () => root,
    offsetMinutes: 480,
    now: () => Date.now(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  // A5 空库：mkdtemp 下**不创建**的 root（panelapi 承诺不建目录；读日志落盘时才会出现 ledger/）
  const emptyBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v06-readonly-empty-'));
  const emptyRoot = path.join(emptyBase, 'never-created');
  const envEmpty = { ...env, getRoot: () => emptyRoot };

  // 现场数字：夹具产物 sha256（A2 证据）
  const artifactHashes = {};
  for (const a of artifacts) {
    const abs = path.join(root, a.rel);
    assert.ok(fs.existsSync(abs), '夹具缺产物：' + a.label + '（' + a.rel + '）');
    artifactHashes[a.label] = { rel: a.rel.split(path.sep).join('/'), sha256: sha256(fs.readFileSync(abs)), bytes: fs.statSync(abs).size };
  }
  results.fixture = {
    root,
    artifactCount: artifacts.length,
    artifacts: artifactHashes,
    ledgerRowsPlanted: fx.rows.length,
    sessionsPlanted: 2,
  };
  console.log('[夹具] root=' + root);
  console.log('[夹具] 产物 ' + artifacts.length + ' 类；台账 ' + fx.rows.length + ' 行；空库 root=' + emptyRoot);

  // 全流程基准
  const beforeSnapshot = snapshot(root);
  const readAllBefore = ledger.readAll(root, { repairTornTail: false });
  const readAllBadBefore = Number(readAllBefore.badLines) || 0;
  results.numbers.readsLogLinesBefore = readLogLines(root).length;
  results.numbers.fixtureFiles = beforeSnapshot.length;

  // -------------------------------------------------------------------------
  // ★ V0.9：工具面 5 → 9。只读 8 个 + 受控 1 个。
  //   `ledger_cleanup_apply` 默认 dry-run 会写一份 RPT-DRYRUN-*，因此**不能**算进
  //   "除读日志外全库 sha256 不变"的只读断言；它的写行为由 V0.9 的 CT-02 精确守
  //   （只许新增一份 dry-run 报告、不占正式编号、零删除）。这是判定力上升，不是放宽。
  // -------------------------------------------------------------------------
  const READONLY_TOOLS = [
    'ledger_search', 'ledger_turn', 'ledger_context', 'ledger_whoami', 'ledger_health',
    'ledger_reconcile', 'ledger_anchor', 'ledger_cleanup_preview',
  ];
  const CONTROLLED_TOOLS = ['ledger_cleanup_apply'];
  const ALL_TOOL_NAMES = [...READONLY_TOOLS, ...CONTROLLED_TOOLS];
  const toolsEnv = {
    getRoot: () => root,
    offsetMinutes: 480,
    // 夹具不配锚目录：`ledger_anchor` 必须"降级不抛"（anchor-disabled），而不是假装成功。
    getAnchorRoot: () => '',
    getCleanupConfig: () => ({ cleanupToolEnabled: false, cleanupAllowPhysicalDelete: false }),
  };
  const argsOfTool = (name) => (name === 'ledger_turn' ? { code: codeOf(1) }
    : name === 'ledger_context' ? { sid: SID }
      : name === 'ledger_search' ? { sid: SID } : {});

  // -------------------------------------------------------------------------
  // A1：7 条路由 + 9 个工具（8 只读 + 1 受控）
  // -------------------------------------------------------------------------
  let defs = null;
  let registeredRoutes = [];
  let fakeCtxInfo = null;
  let regInfo = null;
  await check('A1', '7 条 exact 路由注册成功，且 fake req/res 下全部 ok:true；9 个工具（8 只读 + 1 受控）定义齐全', async () => {
    const fake = makeFakeCtx();
    fakeCtxInfo = fake;
    regInfo = regFn.fn(fake.ctx, env);
    assert.ok(regInfo && typeof regInfo === 'object', '注册函数必须返回对象');
    assert.equal(regInfo.registered, 7, '必须注册 7 条路由（实际 ' + regInfo.registered + '）');
    assert.equal(fake.registered.length, 7, 'webServer.register 必须被调 7 次（实际 ' + fake.registered.length + '）');
    assert.deepEqual(
      (Array.isArray(regInfo.names) ? regInfo.names : []).slice().sort(),
      ROUTES.slice().sort(),
      '注册的路由名必须是契约 §1.1 的 7 条',
    );

    // 每条路由：exact + 前缀正确 + resource 可调用（resource 是 webServer 的 WebResourceRoute 形状）
    registeredRoutes = fake.registered.slice();
    for (const route of registeredRoutes) {
      assert.equal(route.kind, 'exact', '路由必须是 exact：' + route.path);
      assert.equal(typeof route.path, 'string', '路由必须有 path');
      assert.ok(route.path.startsWith(API_PREFIX), '路由前缀必须是 ' + API_PREFIX + '（实际 ' + route.path + '）');
      const name = route.path.slice(API_PREFIX.length);
      assert.ok(ROUTES.includes(name), '路由名不在契约里：' + name);
      assert.equal(typeof route.resource, 'function', '路由必须用 resource（webServer 的 WebResourceRoute）');
    }

    // fake req/res：把每条路由的 resource 用标准 Request 调一遍
    const QUERY = {
      ping: {},
      summary: {},
      search: { sid: SID },
      turn: { code: codeOf(1) },
      original: { code: codeOf(1) },
      reads: { limit: 5 },
      reconcile: {},
    };
    const routeOk = {};
    for (const route of registeredRoutes) {
      const name = route.path.slice(API_PREFIX.length);
      const r = await callResource(route, QUERY[name] || {});
      assert.equal(r.status, 200, `GET ${name} 状态码应为 200（实际 ${r.status}）：${r.text.slice(0, 200)}`);
      assert.ok(r.json && typeof r.json === 'object', `GET ${name} 必须返回 JSON`);
      assert.equal(r.json.ok, true, `GET ${name} 必须 ok:true（实际 ${JSON.stringify(r.json).slice(0, 240)}）`);
      const ct = r.headers.get('content-type') || '';
      assert.match(ct, /application\/json/i, `GET ${name} 的 Content-Type 必须是 JSON（实际 ${ct}）`);
      assert.equal(r.headers.get('cache-control'), 'no-store', `GET ${name} 必须 Cache-Control: no-store`);
      routeOk[name] = { status: r.status, ok: r.json.ok };
    }
    // 非只读方法必须 405 + Allow（webServer resource 原生语义；带同源头以先过 A8 守卫）
    const probe = registeredRoutes.find((x) => x.path === API_PREFIX + 'ping');
    const bad = await probe.resource(new Request('http://panel.local' + probe.path, { method: 'POST', headers: SAME_SITE_HEADERS }));
    assert.equal(bad.status, 405, 'POST 必须 405');
    assert.match(bad.headers.get('allow') || '', /GET/i, '405 必须带 Allow: GET, HEAD');

    // 9 个工具：名字固定（原 5 个在前、V0.9 新增 4 个在后）+ 只读 8 个必须成功
    defs = toolface.buildToolDefs(toolsEnv);
    assert.deepEqual(defs.map((d) => d.name), ALL_TOOL_NAMES, '工具名与顺序不许变（原 5 + V0.9 新增 4）');
    for (const name of READONLY_TOOLS) {
      const d = defs.find((x) => x.name === name);
      const value = await d.execute(argsOfTool(name), { agent: { id: SID } });
      assert.ok(value && typeof value === 'object', name + ' 必须返回对象');
      if (name === 'ledger_anchor') {
        // 夹具没有锚目录：正确行为是"降级"（ok:false + 机器码），不是 ok:true
        assert.equal(value.ok, false, '未配置锚目录时 ledger_anchor 必须降级');
        assert.match(String(value.reason || ''), /anchor-(disabled|missing)/, '降级必须给机器码');
      } else {
        assert.notEqual(value.ok, false, name + ' 在夹具上必须成功（实际 ' + JSON.stringify(value).slice(0, 200) + '）');
      }
    }
    assert.equal(CONTROLLED_TOOLS.length, 1, '受控工具恰 1 个（cleanup_apply）');
    return {
      routesRegistered: regInfo.registered,
      routeNames: registeredRoutes.map((r) => r.path.slice(API_PREFIX.length)).sort(),
      routeOk,
      tools: defs.map((d) => d.name),
      headAllowed: 405,
    };
  });

  // -------------------------------------------------------------------------
  // A3：每次调用 +1 行读日志（旧 .reads.jsonl + 新 .reads/ 分片合计）；HEAD 不计
  // -------------------------------------------------------------------------
  let readCalls = 0;
  await check('A3', '每次 GET / 工具调用后读日志恰好 +1 行且字段齐全；HEAD 不计', async () => {
    const FIELD_TYPES = {
      at: 'string', tool: 'string', args: 'string', hitCodes: 'object',
      returnedRows: 'number', bytes: 'number', ms: 'number', ok: 'boolean',
    };
    const verifyRow = (row, expectedTool, label) => {
      for (const [k, t] of Object.entries(FIELD_TYPES)) {
        assert.ok(k in row, `${label}: 读日志缺字段 ${k}`);
        assert.equal(typeof row[k], t, `${label}: 读日志字段 ${k} 类型应为 ${t}（实际 ${typeof row[k]}）`);
      }
      assert.ok(Array.isArray(row.hitCodes), label + ': hitCodes 必须是数组');
      assert.ok(Number.isInteger(row.returnedRows) && row.returnedRows >= 0, label + ': returnedRows 必须是非负整数');
      assert.ok(Number.isInteger(row.bytes) && row.bytes >= 0, label + ': bytes 必须是非负整数');
      assert.ok(Number.isInteger(row.ms) && row.ms >= 0, label + ': ms 必须是非负整数');
      assert.equal(typeof row.at, 'string');
      if (expectedTool) assert.equal(row.tool, expectedTool, label + ': tool 记错了');
    };
    const counted = async (label, expectedTool, call) => {
      const linesBefore = readLogLines(root).length;
      const out = await call();
      const linesAfter = readLogLines(root).length;
      assert.equal(linesAfter, linesBefore + 1, `${label}: 读日志应恰好 +1 行（${linesBefore} → ${linesAfter}）`);
      verifyRow(lastReadRow(root), expectedTool, label);
      readCalls += 1;
      return out;
    };

    const QUERY = {
      ping: {}, summary: {}, search: { sid: SID }, turn: { code: codeOf(1) },
      original: { code: codeOf(1) }, reads: { limit: 3 }, reconcile: {},
    };
    // 7 条路由各调一次（进程内直调，与 HTTP 共用处理器）
    for (const name of ROUTES) {
      await counted('路由 ' + name, 'panel:' + name, async () => {
        const r = await runRouteFn.fn(env, name, QUERY[name] || {}, { method: 'GET' });
        assert.equal(r.status, 200, `runPanelRoute(${name}) 状态码应为 200（实际 ${r.status}）`);
        assert.equal(r.json.ok, true, `runPanelRoute(${name}) 必须 ok:true`);
        return r;
      });
    }
    // 8 个只读工具各调一次（受控的 cleanup_apply 不在此列：它会写 dry-run 报告）
    for (const name of READONLY_TOOLS) {
      const d = defs.find((x) => x.name === name);
      await counted('工具 ' + name, name, () => d.execute(argsOfTool(name), { agent: { id: SID } }));
    }
    // HEAD 不计
    const before = readLogLines(root).length;
    await runRouteFn.fn(env, 'ping', {}, { method: 'HEAD' });
    const after = readLogLines(root).length;
    assert.equal(after, before, `HEAD 不允许写读日志（${before} → ${after}）`);

    // V0.6.4 ③：新写入必须落 `<root>/ledger/.reads/YYYY-MM.jsonl`；不得再创建旧单文件。
    const shards = readShards(root);
    assert.ok(shards.length >= 1, '读日志新写入应落在 <root>/ledger/.reads/ 分片里（实际没有分片）');
    assert.match(shards[0].name, /^\d{4}-\d{2}\.jsonl$/, '第一份分片应命名 YYYY-MM.jsonl（实际 ' + shards[0].name + '）');
    assert.ok(!fs.existsSync(path.join(root, 'ledger', '.reads.jsonl')), '新逻辑不得再创建旧单文件 .reads.jsonl');

    return {
      countedCalls: readCalls,
      routes: ROUTES,
      tools: defs.map((d) => d.name),
      headWrites: 0,
      readsLogLinesNow: readLogLines(root).length,
      readsShards: shards.map((s) => s.name),
    };
  });

  // -------------------------------------------------------------------------
  // A4：读日志不被当成台账
  // -------------------------------------------------------------------------
  await check('A4', '读日志不被当成台账：readAll 行数不变、badLines 不变', async () => {
    const after = ledger.readAll(root, { repairTornTail: false });
    const rowsBefore = readAllBefore.records.length;
    const rowsAfter = after.records.length;
    assert.equal(rowsAfter, rowsBefore, `readAll 行数必须不变（${rowsBefore} → ${rowsAfter}）`);
    assert.equal(rowsAfter, fx.rows.length, 'readAll 行数必须等于台账实际行数 ' + fx.rows.length);
    assert.equal(Number(after.badLines) || 0, readAllBadBefore, 'badLines 必须不变');
    assert.equal(Number(after.badLines) || 0, 0, '夹具里不应有坏行');
    // 读日志（旧 .reads.jsonl / 新 .reads/ 分片合计）已有 N 行，但一行都不许进台账
    const logLines = readLogLines(root).length;
    assert.ok(logLines > 0, '读日志应已有记录');
    assert.ok(!after.records.some((r) => String(r && r.tool || '').startsWith('panel:')), '读日志行不许被当成台账行');
    return { rowsBefore, rowsAfter, badLinesBefore: readAllBadBefore, badLinesAfter: Number(after.badLines) || 0, readsLogLines: logLines };
  });

  // -------------------------------------------------------------------------
  // A5：错误路径 + 空库
  // -------------------------------------------------------------------------
  await check('A5', '错误路径：坏月份 bad-param、不存在编码 not-found；空库 ok:true + 计数 0 + health.ok=null', async () => {
    // ① 坏月份 → 400 bad-param
    for (const badMonth of ['xxxx', '2026-13', '2026-1']) {
      const r = await callApiFn.fn(env, `${API_PREFIX}search?month=${encodeURIComponent(badMonth)}`);
      assert.equal(r.status, 400, `month=${badMonth} 必须 400（实际 ${r.status}）`);
      assert.equal(r.json && r.json.ok, false, `month=${badMonth} 必须 ok:false`);
      assert.equal(r.json.reason, 'bad-param', `month=${badMonth} reason 必须是 bad-param（实际 ${r.json.reason}）`);
      assert.ok(r.json.detail !== undefined, `month=${badMonth} 必须带 detail`);
    }
    // ② 不存在编码 → 200 not-found
    const missingCode = codeOf(99999);
    for (const route of ['turn', 'original']) {
      const r = await callApiFn.fn(env, `${API_PREFIX}${route}?code=${encodeURIComponent(missingCode)}`);
      assert.equal(r.status, 200, `${route} 不存在编码必须 200（实际 ${r.status}）`);
      assert.equal(r.json && r.json.ok, false, `${route} 不存在编码必须 ok:false`);
      assert.equal(r.json.reason, 'not-found', `${route} reason 必须是 not-found（实际 ${r.json.reason}）`);
    }
    // ③ 空库：ok:true、计数 0、health.ok===null、evidence='no-run-report'
    const emptySummary = await runRouteFn.fn(envEmpty, 'summary', {}, {});
    assert.equal(emptySummary.status, 200, '空库 summary 必须 200');
    assert.equal(emptySummary.json.ok, true, '空库 summary 必须 ok:true');
    const c = emptySummary.json.counts || {};
    assert.equal(Number(c.ledgerRows), 0, '空库 counts.ledgerRows 必须 0');
    assert.equal(Number(c.handover && c.handover.total), 0, '空库 handover.total 必须 0');
    assert.equal(Number(c.original && c.original.views), 0, '空库 original.views 必须 0');
    assert.equal(Number(c.weekly && c.weekly.files), 0, '空库 weekly.files 必须 0');
    assert.equal(emptySummary.json.health && emptySummary.json.health.ok, null, '空库 health.ok 必须是 null（不许用 false 冒充"坏"）');
    assert.equal(emptySummary.json.health && emptySummary.json.health.evidence, 'no-run-report', '空库 evidence 必须是 no-run-report');
    assert.equal(emptySummary.json.health && emptySummary.json.health.gate, 'unknown', '空库 gate 必须是 unknown');
    assert.equal(emptySummary.json.rootExists, false, '空库 rootExists 必须 false');
    for (const name of ['search', 'reads', 'reconcile', 'ping']) {
      const r = await runRouteFn.fn(envEmpty, name, {}, {});
      assert.equal(r.status, 200, `空库 ${name} 必须 200`);
      assert.equal(r.json.ok, true, `空库 ${name} 必须 ok:true`);
    }
    const emptySearch = await runRouteFn.fn(envEmpty, 'search', { sid: SID }, {});
    assert.equal(emptySearch.json.rows.length, 0, '空库检索必须 0 行');
    assert.equal(Number(emptySearch.json.total), 0, '空库检索 total 必须 0');
    const emptyReconcile = await runRouteFn.fn(envEmpty, 'reconcile', {}, {});
    assert.equal(Number(emptyReconcile.json.ledgerRows), 0, '空库对账 ledgerRows 必须 0');
    return {
      badMonth: ['xxxx', '2026-13', '2026-1'],
      notFound: { code: missingCode, routes: ['turn', 'original'] },
      empty: {
        counts: c, healthOk: emptySummary.json.health.ok,
        evidence: emptySummary.json.health.evidence, gate: emptySummary.json.health.gate,
        rootExists: emptySummary.json.rootExists,
      },
    };
  });

  // -------------------------------------------------------------------------
  // A6：5 个工具的 presentResult 符合 ToolResultView 形状
  // -------------------------------------------------------------------------
  await check('A6', '9 个工具的 presentResult 符合 ToolResultView 联合形状（含 read 卡片行号）', async () => {
    const by = Object.fromEntries(defs.map((d) => [d.name, d]));
    // ★ V0.9：受控工具用**合成的 dry-run 结果**验卡片形状——绝不在只读面验收里真跑 apply
    //   （它会写 RPT-DRYRUN 报告，破坏 A2 的"全库字节不变"）。
    const SYNTH = {
      ledger_cleanup_apply: {
        ok: true, dryRun: true, reportId: 'RPT-DRYRUN-20261111-01', planned: 3,
        confirmPhrase: 'DELETE 3 RPT-DRYRUN-20261111-01',
      },
    };
    const cards = {};
    for (const name of ALL_TOOL_NAMES) {
      const value = SYNTH[name] || await by[name].execute(argsOfTool(name), { agent: { id: SID } });
      assert.ok(typeof by[name].presentCall === 'function', name + ' 缺 presentCall');
      assert.ok(typeof by[name].presentResult === 'function', name + ' 缺 presentResult');
      const callView = by[name].presentCall(argsOfTool(name));
      assert.ok(callView && callView.card === 'generic' && typeof callView.title === 'string', name + ' presentCall 形状不合法');
      const view = by[name].presentResult(argsOfTool(name), value);
      assertToolResultView(view, name + '.presentResult');
      cards[name] = { card: view.card, title: view.title || null };
    }
    // read 卡片：offset=0、行号从 1 连续、totalLines=行数（契约 §3）
    const turnView = by.ledger_turn.presentResult(argsOfTool('ledger_turn'), await by.ledger_turn.execute(argsOfTool('ledger_turn'), { agent: { id: SID } }));
    assert.equal(turnView.card, 'read');
    assert.equal(turnView.offset, 0);
    assert.deepEqual(turnView.lines.map((l) => l.number), turnView.lines.map((_, i) => i + 1));
    assert.equal(turnView.totalLines, turnView.lines.length);
    assert.ok(turnView.lines.length > 0, 'excerpt 非空时 read 卡片必须至少一行');
    // 异常/未知工具回退 undefined（绝不抛）
    assert.equal(toolcards.presentResultFor('ledger_unknown', {}, {}), undefined, '未知工具必须 undefined');
    assert.equal(toolcards.presentCallFor('ledger_unknown', {}), undefined, '未知工具 presentCall 必须 undefined');
    assert.doesNotThrow(() => toolcards.presentResultFor('ledger_search', {}, null), 'null 结果不许抛');
    assert.equal(toolcards.presentResultFor('ledger_search', {}, null), undefined, 'null 结果必须回退 undefined');
    // 20 行截断（契约 §3：最多 20 行 + "…还有 N 行"）
    const manyRows = Array.from({ length: 23 }, (_, i) => ({
      code: codeOf(i + 1), ts: `2026-11-08 10:00:0${i % 10} +08:00`, sid: SID, turn: i + 1, status: 'ok',
    }));
    const searchView = toolcards.presentResultFor('ledger_search', {}, { ok: true, rows: manyRows, total: 23 });
    assertToolResultView(searchView, 'ledger_search/23');
    const bodyLines = searchView.content[0].text.split('\n');
    assert.equal(bodyLines.length, 21, '正文应为 20 行 + 1 行省略提示');
    assert.equal(bodyLines[20], '…还有 3 行');
    return { cards, readLines: turnView.lines.length, truncatedTail: bodyLines[20], unknownTool: 'undefined' };
  });

  // -------------------------------------------------------------------------
  // A2：调用前后全库 sha256 集合逐字节不变（唯一豁免读日志：旧 .reads.jsonl + 新 .reads/ 分片）
  // -------------------------------------------------------------------------
  const afterSnapshot = snapshot(root);
  await check('A2', '调用前后除读日志（旧 .reads.jsonl + 新 .reads/ 分片）外全库 sha256 集合逐字节不变', async () => {
    assert.deepEqual(afterSnapshot, beforeSnapshot, '只读面不许改动台账/原文/周记账/交接表/封板链/state/run-report 的任何字节');
    // 逐类产物再显式核一次（失败时能定位到是哪一类）
    const perArtifact = {};
    for (const a of artifacts) {
      const abs = path.join(root, a.rel);
      assert.ok(fs.existsSync(abs), '产物消失：' + a.label);
      const after = sha256(fs.readFileSync(abs));
      assert.equal(after, artifactHashes[a.label].sha256, '产物字节被改动：' + a.label);
      perArtifact[a.label] = { unchanged: true, sha256: after };
    }
    // 唯一允许变化：读日志确实变了（否则 A3 的 +1 就是假的）
    const logLinesAfter = readLogLines(root).length;
    assert.ok(logLinesAfter > results.numbers.readsLogLinesBefore, '读日志应已新增行（A3 已逐次验证 +1）');
    assert.equal(beforeSnapshot.length, afterSnapshot.length, '全库文件数不许变（新增文件也算改变）');
    return { files: beforeSnapshot.length, artifacts: perArtifact, readsLogLinesBefore: results.numbers.readsLogLinesBefore, readsLogLinesAfter: logLinesAfter };
  });

  // -------------------------------------------------------------------------
  // A7：summary 契约字段齐全
  // -------------------------------------------------------------------------
  await check('A7', 'summary 顶层键与 health 22 键一个不少；counts/capabilities 子键齐全', async () => {
    const r = await runRouteFn.fn(env, 'summary', {}, {});
    assert.equal(r.status, 200, 'summary 必须 200');
    const json = r.json;
    const TOP_KEYS = ['ok', 'v', 'generatedAt', 'root', 'rootExists', 'layoutVersion', 'counts', 'health', 'reads', 'capabilities'];
    // 契约 §1.3 的 health 22 键（V0.6 D18 增补 legacy 三键；缺字段 = 红）
    const HEALTH_KEYS = [
      'ok', 'okStrict', 'gate', 'evidence', 'lastRunAt', 'lastRunReportAt',
      'ledgerOk', 'badLines', 'readErrors', 'originalMissing', 'originalOrphan',
      'weeklyGroupsMissing', 'lostGaps', 'receiptBreaks', 'sealChainOk',
      'blockedSources', 'stuckSources', 'unavailable', 'errors',
      'legacyUnverifiable', 'legacyUnmarkedNoEvidence', 'legacyMarksChainOk',
    ];
    const missingTop = TOP_KEYS.filter((k) => !(k in json));
    assert.deepEqual(missingTop, [], 'summary 顶层缺键：' + missingTop.join(', '));
    assert.deepEqual(HEALTH_KEYS.filter((k) => !(k in (json.health || {}))), [], 'summary.health 缺键');
    assert.equal(HEALTH_KEYS.length, 22, 'health 键数应为 22');
    const c = json.counts || {};
    for (const k of ['handover', 'original', 'weekly']) assert.ok(k in c, 'counts 缺 ' + k);
    for (const k of ['main', 'appendix', 'total']) assert.ok(k in c.handover, 'counts.handover 缺 ' + k);
    for (const k of ['views', 'attachments']) assert.ok(k in c.original, 'counts.original 缺 ' + k);
    for (const k of ['files', 'months', 'sealed']) assert.ok(k in c.weekly, 'counts.weekly 缺 ' + k);
    assert.ok('ledgerRows' in c, 'counts 缺 ledgerRows');
    const cap = json.capabilities || {};
    for (const k of ['readOnly', 'physicalDelete', 'receiptAnchor']) assert.ok(k in cap, 'capabilities 缺 ' + k);
    for (const k of ['total', 'lastAt', 'badLines']) assert.ok(k in (json.reads || {}), 'reads 缺 ' + k);
    assert.equal(cap.readOnly, true, '只读面 capabilities.readOnly 必须 true');
    // 现场数字自洽：夹具 3 行台账 → summary 看到的 ledgerRows 必须等于 3
    assert.equal(Number(c.ledgerRows), fx.rows.length, 'summary.counts.ledgerRows 必须等于夹具行数');
    assert.equal(json.rootExists, true, '夹具 root 存在 → rootExists 必须 true');
    return {
      topKeys: TOP_KEYS, healthKeys: HEALTH_KEYS.length, ledgerRows: c.ledgerRows,
      counts: c, capabilities: cap, reads: json.reads,
    };
  });

  // -------------------------------------------------------------------------
  // A8（V0.6.1，v0.6.2 兼容模式修正）：HTTP 载体同源守卫
  //   有明确跨源证据 → 403；三者全空（DSH WebView 实测形态）→ 200（兼容；残余风险见 05 A8）
  // -------------------------------------------------------------------------
  await check('A8', 'HTTP resource 同源守卫：明确跨源证据 → 403 forbidden-origin；无来源头（WebView 兼容）→ 200', async () => {
    assert.ok(fakeCtxInfo && regInfo && registeredRoutes.length === 7, 'A8 依赖 A1 已注册 7 条路由');
    const route = registeredRoutes.find((x) => x.path === API_PREFIX + 'ping');
    assert.ok(route, '找不到 ' + API_PREFIX + 'ping 的 resource');
    const target = 'http://panel.local' + route.path;
    /** 带/不带请求头各发一次；不给 headers = 模拟本机进程 curl 直取的原样请求。 */
    const call = (headers, method = 'GET') => route.resource(new Request(target, {
      method,
      ...(headers ? { headers } : {}),
    }));
    const lines = readLogLines(root).length;

    // ① 三者全空（DSH WebView 实测：无 SFS/Origin/Referer）→ 兼容放行 200
    const bare = await call({ host: '127.0.0.1:2687' });
    assert.equal(bare.status, 200, '无来源头（WebView 兼容形态）必须放行（实际 ' + bare.status + '）');
    assert.equal((await bare.json()).ok, true);
    // ①b 明确跨源证据 → 403 + JSON + no-store；且不写读日志、不碰账本
    const crossSfs = await call({ 'sec-fetch-site': 'cross-site', host: '127.0.0.1:2687' });
    assert.equal(crossSfs.status, 403, 'Sec-Fetch-Site: cross-site 必须 403（实际 ' + crossSfs.status + '）');
    assert.equal(crossSfs.headers.get('cache-control'), 'no-store', '403 必须带 Cache-Control: no-store');
    assert.match(crossSfs.headers.get('content-type') || '', /application\/json/i, '403 必须返回 JSON');
    const crossJson = await crossSfs.json();
    assert.equal(crossJson.reason, 'forbidden-origin');
    assert.equal(crossJson.detail, '只读 API 仅接受同源浏览器请求');
    assert.equal(readLogLines(root).length, lines + 1, '被同源守卫拒绝的请求不许写读日志（仅①的兼容放行 GET 记了 1 行）');

    // ② 跨源 Origin / Referer / SFS none·same-site → 403
    for (const headers of [
      { origin: 'http://evil.example' },
      { referer: 'http://evil.example/x' },
      { 'sec-fetch-site': 'none', host: '127.0.0.1:2687' },
      { 'sec-fetch-site': 'same-site', host: '127.0.0.1:2687' },
    ]) {
      const r = await call(headers);
      assert.equal(r.status, 403, JSON.stringify(headers) + ' 必须 403（实际 ' + r.status + '）');
      assert.equal((await r.json()).reason, 'forbidden-origin');
    }

    // ③ 同源放行：Sec-Fetch-Site（浏览器真实路径）与同源 Origin 各验一次 → 200 ok:true
    const allowed = {};
    for (const headers of [SAME_SITE_HEADERS, { origin: 'http://panel.local' }]) {
      const r = await call(headers);
      assert.equal(r.status, 200, JSON.stringify(headers) + ' 必须放行 200（实际 ' + r.status + '）');
      const j = await r.json();
      assert.equal(j.ok, true, JSON.stringify(headers) + ' 必须 ok:true');
      allowed[Object.keys(headers)[0]] = r.status;
    }

    // ④ runPanelRoute 进程内直调不受守卫影响（浏览器不经过它）
    const direct = await runRouteFn.fn(env, 'ping', {}, {});
    assert.equal(direct.status, 200, 'runPanelRoute 不许被同源守卫影响');

    results.numbers.a8 = {
      noHeaderCompat: bare.status, crossSiteBlocked: crossSfs.status,
      crossOrigin: 403, sameOrigin: allowed, runPanelRoute: direct.status,
    };
    return {
      noHeaderCompat: bare.status, crossSiteBlocked: crossSfs.status,
      crossOrigin: 403, sameOrigin: allowed, runPanelRoute: direct.status,
    };
  });

  // -------------------------------------------------------------------------
  // 收尾：注册可撤销 + 写结果
  // -------------------------------------------------------------------------
  if (fakeCtxInfo && regInfo) {
    try {
      if (typeof regInfo.dispose === 'function') regInfo.dispose();
      results.numbers.routesDisposed = fakeCtxInfo.disposedCount();
    } catch (e) {
      results.numbers.routesDisposeError = String(e && e.message ? e.message : e);
    }
  }

  results.numbers.toolCalls = readCalls;
  results.numbers.panelCalls = 7;
  results.numbers.checksTotal = results.checks.length;
  results.numbers.checksPassed = results.checks.filter((x) => x.ok).length;
  results.durationMs = Date.now() - t0;
  results.ok = results.checks.every((x) => x.ok);

  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 临时库清不掉不影响结论 */ }
  try { fs.rmSync(emptyBase, { recursive: true, force: true }); } catch { /* 同上 */ }
}

// ============================================================================
// 入口：无论成功失败都写结果文件，退出码反映真实结论
// ============================================================================

let fatalError = null;
try {
  await main();
} catch (e) {
  fatalError = e && e.stack ? e.stack : String(e);
  console.error('[验收-只读面] ✗ 脚本异常：' + fatalError);
}

if (fatalError) {
  results.fatal = fatalError;
  results.ok = false;
}
results.finishedAt = nowStamp();
try {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + '\n', 'utf8');
  console.log('\n[结果] → ' + RESULTS_FILE);
} catch (e) {
  console.error('[结果] 写结果文件失败：' + (e && e.message ? e.message : String(e)));
}

const passed = results.checks.filter((x) => x.ok).length;
const total = results.checks.length;
console.log(`[验收-只读面] ${results.ok ? '全绿' : '有红项'}：${passed}/${total} 通过｜退出码 ${results.ok ? 0 : 1}`);
for (const c of results.checks) {
  if (!c.ok) console.log(`  ✗ ${c.id} ${c.name}\n    ${c.error}`);
}
process.exitCode = results.ok ? 0 : 1;
