/**
 * @file 自测-panelapi.mjs
 * @role V0.6 只读面板 HTTP API（tools/panelapi.js）的验收：7 条 exact GET 路由
 *       **查得到、查得准、一个字节都不改**（契约 §1、§4 的 A1/A2/A3/A4/A5/A7；A6 归工具卡片）；
 *       V0.6.1/A8：HTTP 载体同源守卫（无来源头/跨源 → 403 forbidden-origin，同源 → 200）。
 *
 * @why 面板是"看账"的窗。本文件的核心断言是"调用前后全库 sha256 集合完全不变"——
 *      以后谁在 panelapi 里顺手加了个写操作（哪怕只是 repairTornTail），这里立刻变红。
 *
 * @why 不起 HTTP 服务：契约 §4 要求进程内直接调 API。所有路由都经 `runPanelRoute()` 直调；
 *      HTTP 载体（`createPanelResource` / `registerLedgerPanelApi`）用 fake webServer 单独验证，
 *      其"正常路径"请求补 `Sec-Fetch-Site: same-origin`（A8 纵深防御；runPanelRoute 不加守卫）。
 *
 * @why V0.6.4 ③（读日志滚动）：读日志改落 `<root>/ledger/.reads/YYYY-MM.jsonl`（超 8 MiB 切分片），
 *      历史 `<root>/ledger/.reads.jsonl` 只读兼容。A2 的"唯一允许变化"仍只豁免读日志——
 *      只是把旧单文件与 `.reads/` 分片**两种位置都算作读日志**；A3 的"每次 GET +1 行"改为
 *      "两种位置合计 +1 行"，并额外钉住"新写入必须落 `.reads/`、不得再创建旧单文件"。
 *
 * ★ V1.0.0-re3 契约变更（旧 → 新；三份独立审计 ① P1-1 / ② A3 / ③ SEC-01 + ② P2）：
 *   ① 同源守卫（A8）：旧"`Sec-Fetch-Site: same-origin` 单独放行 / Origin 与请求 URL 同源放行"；
 *      新"回环 Host 先决 + SFS 只否决 + Origin/Referer 回环同端口"，`Host: evil + SFS: same-origin` 必须 403。
 *   ② `/ping`：旧回 `root: '<绝对路径>'`；新只回 `rootName`（basename），不泄露账库绝对路径。
 *   ③ `/original`：旧 `containedPath(realpath)→open` 有 TOCTOU；新 open 后 fstat + 重新 containment 校验。
 *   A1 的"ping.root"、A8 的 HTTP 载体正常路径、注册面的请求头均按新契约改写（逐处标注"旧 → 新"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panel = await import(pathToFileURL(path.join(SRC, 'tools', 'panelapi.js')).href);
const led = await import(pathToFileURL(path.join(SRC, 'lib', 'ledger.js')).href);
const marksMod = await import(pathToFileURL(path.join(SRC, 'freeze', 'legacy-marks.js')).href);
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const S12 = '75238718e41a';
const SESSKEY = S12 + 'A';
const codeOf = (n) => `20261108-${S12}-A-${String(n).padStart(8, '0')}`;
/** 固定"现在"：2026-11-10 12:00:00 +08:00（让缓存/时间戳可断言）。 */
const NOW = Date.parse('2026-11-10T12:00:00+08:00');

/**
 * V0.6.1 / A8：浏览器同源页面的 fetch 会带 `Sec-Fetch-Site: same-origin`。
 * HTTP resource 的"正常路径"请求必须带它：同源守卫是纵深防御，不是密码学鉴权。
 * ★ V1.0.0-re3（旧 → 新）：SFS **不再单独放行** —— 回环 Host 是**先决条件**，
 *   所以正常路径请求还必须带 `Host: 127.0.0.1:<port>`（HTTP/1.1 真机请求必带 Host；
 *   缺它 = 403）。宿主 webServer 用占位 origin 构造 Request，Request.url 的 origin 不参与同源判定。
 */
const LOOPBACK_HOST = '127.0.0.1:2687';
const SAME_SITE = { 'sec-fetch-site': 'same-origin', host: LOOPBACK_HOST };

const ORIG_DIR = path.join('2026年11月', '11月总“完整原文”');
const WEEKLY_REL = path.join('2026年11月', `11月第2周-${SESSKEY}的周记账.xlsx`);
const MAIN_REL = `${SESSKEY}的记忆数据库的启用及交接表.md`;
const APPENDIX_REL = `${SESSKEY}的记忆数据库的启用及交接表——附表.md`;
/** V0.6.2 一级新布局：交接表写端落 `<root>/交接表/`（读端双路径，一级老位置也认）。 */
const HANDOVER_DIR = '交接表';

/** 3 行台账（同一会话 2 轮 + 另一会话 1 轮；均声明 doc，夹具里也真的落盘）。 */
function rowsOf() {
  const mk = (n, sid) => {
    const code = codeOf(n);
    return {
      v: 3, code,
      ts: `2026-11-08 1${n}:00:00 +08:00`,
      sid, turn: n, seq: n, status: 'ok', turnState: 'closed',
      doc: path.join(ORIG_DIR, `${code} 完整原文.md`),
    };
  };
  return [mk(1, SID), mk(2, SID), mk(3, 'session-other')];
}

/** 运行报告夹具（形状照 freeze/selfheal.js 的 writeRunReport）。 */
function runReportOf(root, { date, generatedAt, ok, gate, counts }) {
  return {
    v: 1, date, generatedAt, offsetMinutes: 480, at: generatedAt, root,
    reconcile: {
      ok, okStrict: ok,
      ledgerOk: true, ledgerRows: 3,
      originalMissing: [], originalOrphan: [], weeklyGroupsMissing: [],
      lostGaps: { count: 0, recordsTail: [] }, receiptBreaks: [],
      sealChain: { ok: true, lines: 0, events: 0, breaks: [], chainBroken: 0, badLines: 0, readError: '' },
      readErrors: [], badLines: 0,
      conclusion: ok ? 'ok' : 'unknown',
    },
    actions: [], errors: [], blockedSources: [], stuckSources: [],
    counts: {
      originalMissing: 0, originalOrphan: 0, weeklyGroupsMissing: 0, lostGaps: 0,
      receiptBreaks: 0, blockedSources: 0, stuckSources: 0, errors: 0,
      ...(counts || {}),
    },
    gate: { conclusion: gate, reason: '', okStrict: ok },
  };
}

/**
 * 造一份最小账库夹具：台账 + 原文视图 + 交接表 + 周记账 + 封板 journal + state + 运行报告。
 * @returns {{base:string, root:string}}
 */
function makeLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'panelapi-'));
  const root = path.join(base, 'root');
  const ledgerDir = path.join(root, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });

  const rows = rowsOf();
  fs.writeFileSync(path.join(ledgerDir, '2026-11-08.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  for (const r of rows) {
    const abs = path.join(root, r.doc);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# 第 ${r.turn} 轮\n\n## 1. 用户输入\n\n你好，这是 ${r.code} 的原文。\n`, 'utf8');
  }

  // 交接表（主表 + 附表，V0.6.2 新布局：`<root>/交接表/`）
  fs.mkdirSync(path.join(root, HANDOVER_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, HANDOVER_DIR, MAIN_REL), '# 交接表\n\n占位正文\n', 'utf8');
  fs.writeFileSync(path.join(root, HANDOVER_DIR, APPENDIX_REL), '# 附表\n\n占位正文\n', 'utf8');

  // 周记账（二级月目录下）
  fs.mkdirSync(path.join(root, '2026年11月'), { recursive: true });
  fs.writeFileSync(path.join(root, WEEKLY_REL), 'xlsx-fixture-bytes', 'utf8');

  // 封板 journal（首行无前序 → 链从空串起算）
  const sealEvent = {
    v: 1, kind: 'weekly-seal', key: `2026-11-2|${SESSKEY}`, gid: `2026-11-2|${SESSKEY}`,
    file: WEEKLY_REL, sealedAt: '2026-11-09 23:00:00',
    layoutVersion: 6, canonicalVersion: 8, sourceRowCount: 3, overflow: 0, rowCount: 3,
    rowsSha256: 'a'.repeat(64), rows: [], supplementCodesSha256: 'b'.repeat(64), supplement: null,
    sealHash: 'c'.repeat(64), prevSealSha256: '', at: '2026-11-09 23:00:00',
  };
  fs.writeFileSync(path.join(ledgerDir, '.seal-journal.jsonl'), JSON.stringify(sealEvent) + '\n', 'utf8');

  // state（最近一轮时间；health.lastRunAt 用它）
  fs.writeFileSync(path.join(ledgerDir, '.state.json'),
    JSON.stringify({ lastRunAt: '2026-11-10 11:59:00+08:00' }, null, 2) + '\n', 'utf8');

  // 运行报告：一份旧的（坏结论）+ 一份新的（好结论）→ summary 必须取**最新日期**
  const oldRep = runReportOf(root, {
    date: '2026-11-09', generatedAt: '2026-11-09 23:00:00 +08:00', ok: false, gate: 'unknown',
    counts: { errors: 7, originalMissing: 3 },
  });
  const newRep = runReportOf(root, {
    date: '2026-11-10', generatedAt: '2026-11-10 11:59:00 +08:00', ok: true, gate: 'ok',
  });
  fs.writeFileSync(path.join(ledgerDir, '.run-report-20261109.json'), JSON.stringify(oldRep, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(ledgerDir, '.run-report-20261110.json'), JSON.stringify(newRep, null, 2) + '\n', 'utf8');

  return { base, root };
}

/** 构造 env（固定 now，便于缓存断言）。 */
function makeEnv(root, extra = {}) {
  return { getRoot: () => root, offsetMinutes: 480, logger: {}, now: () => NOW, ...extra };
}

/**
 * 是否读日志路径（**唯一允许变化的文件**，契约 A2）。
 * V0.6.4 ③ 起读日志 = 历史单文件 `ledger/.reads.jsonl` + 新目录 `ledger/.reads/` 下所有分片，
 * 两种位置都必须从"全库 sha256 集合"里豁免——无论落在哪，读日志都不是账务产物。
 */
function isReadLogRel(rel) {
  const p = rel.split(path.sep).join('/');
  return p === 'ledger/.reads.jsonl' || p === 'ledger/.reads' || p.startsWith('ledger/.reads/');
}

/** 全库文件 sha256 集合（**排除**读日志：旧 .reads.jsonl + 新 .reads/ 分片）。 */
function snapshot(root) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const rel = path.relative(root, p);
      if (isReadLogRel(rel)) continue; // .reads 目录整棵跳过（分片都属读日志）
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      out.push(rel + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out.sort();
}

/** `.reads/` 分片清单（按写入顺序：月份 → 分片序号；文件名编码了顺序，比 mtime 更耐搬动）。 */
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
 * 读日志全部行（**写入顺序**）：历史单文件 `.reads.jsonl`（若有，仅老库）→ `.reads/` 分片
 * （月份/序号升序，文件内行序）。不存在的文件 = 0 行。
 */
function readLogRows(root) {
  const files = [];
  const legacy = path.join(root, 'ledger', '.reads.jsonl');
  if (fs.existsSync(legacy)) files.push(legacy);
  for (const s of readShards(root)) files.push(path.join(root, 'ledger', '.reads', s.name));
  const rows = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

/** 一条路由的默认调用参数（让 A1 的 7 条都能成功）。 */
function argsFor(route) {
  if (route === 'search') return { sid: SID };
  if (route === 'turn' || route === 'original') return { code: codeOf(1) };
  return {};
}

// ============================================================================
// A1：7 条路由在夹具上全部 ok:true，且字段/形状对
// ============================================================================

test('V0.6/panelapi A1：7 条 exact GET 路由全部 ok:true，字段齐全', () => {
  const { base, root } = makeLab();
  try {
    const env = makeEnv(root);

    // ① ping
    const ping = panel.runPanelRoute(env, 'ping');
    assert.equal(ping.status, 200);
    assert.equal(ping.json.ok, true);
    assert.equal(ping.json.v, 1);
    // ★ V1.0.0-re3 / P2 契约变更（旧 → 新，审计② /ping 回显账库绝对路径）：
    //   旧：`root: '<账库绝对路径>'`；
    //   新：**不回显绝对路径**，只给 basename（`rootName`）；完整路径走 /summary.root。
    assert.equal('root' in ping.json, false, 'ping 不许再回显账库绝对路径');
    assert.equal(ping.json.rootName, path.basename(root), 'ping 只给 basename（rootName）');
    assert.equal(Object.values(ping.json).some((v) => typeof v === 'string' && v.includes(root)), false,
      'ping 响应里任何字符串值都不得含账库绝对路径');
    assert.match(ping.json.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/, 'ping.at 必须是无 Z 的 +08:00 时间');
    assert.equal(ping.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(ping.headers['Cache-Control'], 'no-store');

    // ② summary
    const summary = panel.runPanelRoute(env, 'summary');
    assert.equal(summary.json.ok, true);
    assert.equal(summary.json.v, 1);
    assert.equal(summary.json.rootExists, true);
    assert.equal(summary.json.layoutVersion, 6);
    assert.deepEqual(summary.json.counts.handover, { main: 1, appendix: 1, total: 2 });
    assert.deepEqual(summary.json.counts.original, { views: 3, attachments: 0 });
    assert.deepEqual(summary.json.counts.weekly, { files: 1, months: 1, sealed: 1 });
    assert.equal(summary.json.counts.ledgerRows, 3);
    // 健康度：必须取**最新日期**的运行报告（20261110 好结论，不是 20261109 的 7 个错误）
    assert.equal(summary.json.health.ok, true);
    assert.equal(summary.json.health.okStrict, true);
    assert.equal(summary.json.health.gate, 'ok');
    assert.equal(summary.json.health.evidence, 'run-report');
    assert.equal(summary.json.health.lastRunReportAt, '2026-11-10 11:59:00 +08:00');
    assert.equal(summary.json.health.lastRunAt, '2026-11-10 11:59:00+08:00');
    assert.equal(summary.json.health.errors, 0, '不许取旧报告的 7 个错误');
    assert.equal(summary.json.health.ledgerOk, true);
    assert.equal(summary.json.health.badLines, 0);
    assert.equal(summary.json.health.readErrors, 0);
    assert.deepEqual(summary.json.capabilities, { readOnly: true, physicalDelete: false, receiptAnchor: false });

    // ③ search
    const search = panel.runPanelRoute(env, 'search', { sid: SID });
    assert.equal(search.json.ok, true);
    assert.equal(search.json.rows.length, 2);
    assert.equal(search.json.total, 2);
    assert.equal(search.json.scanned, 3);
    assert.equal(search.json.truncated, false);
    for (const k of ['code', 'ts', 'sid', 'turn', 'status', 'turnState', 'doc', 'bound']) {
      assert.equal(k in search.json.rows[0], true, `search 行字段缺失: ${k}`);
    }

    // ④ turn
    const turn = panel.runPanelRoute(env, 'turn', { code: codeOf(1) });
    assert.equal(turn.json.ok, true);
    assert.equal(turn.json.row.turn, 1);
    // ★ V0.9 契约追加：original 新增 `rejected`（被拒绝的候选路径，空数组=无可疑）。
    //   这是**加法**变更，老消费方忽略新键即可；但字段集必须显式钉住，防止以后悄悄增删。
    assert.deepEqual(Object.keys(turn.json.original).sort(), ['bytes', 'exists', 'path', 'rejected']);
    assert.equal(Array.isArray(turn.json.original.rejected), true);
    assert.equal(turn.json.original.rejected.length, 0, '正常行不得有任何被拒绝的候选路径');
    assert.equal(turn.json.original.exists, true);
    assert.match(turn.json.excerpt, /你好/);
    assert.equal(typeof turn.json.excerptTruncated, 'boolean');

    // ⑤ original
    const original = panel.runPanelRoute(env, 'original', { code: codeOf(1) });
    assert.equal(original.json.ok, true);
    assert.equal(original.json.code, codeOf(1));
    assert.match(original.json.text, /你好/);
    assert.equal(original.json.bytes > 0, true);
    assert.equal(original.json.truncated, false);
    assert.match(original.json.path, /^2026年11月\/11月总“完整原文”\//, 'path 用正斜杠展示口径');

    // ⑥ reads（此前的 5 次 GET 均应落读日志；reads 自身在取数后才记）
    const reads = panel.runPanelRoute(env, 'reads', { limit: 20 });
    assert.equal(reads.json.ok, true);
    assert.equal(reads.json.total, 5);
    assert.equal(reads.json.rows[0].tool, 'panel:original', '读日志新→旧');
    assert.deepEqual(Object.keys(reads.json.summary).sort(), ['byTool', 'hitCodesTotal', 'lastAt']);

    // ⑦ reconcile（D18 修正：没有基线标记的无证据行必须压 ok —— 不许"删字段洗白"；标记后才放行）
    const rec0 = panel.runPanelRoute(env, 'reconcile', { maxDetail: 10, refresh: 1 });
    assert.equal(rec0.json.ok, true);
    assert.equal(rec0.json.reconcileOk, false, '未标记的无证据行必须压 ok（D18 反伪装）');
    assert.equal(rec0.json.legacyUnverifiableCount, 0);
    assert.equal(rec0.json.unmarkedNoEvidenceCount, 3);
    // 显式执行 legacy 基线标记（可审计动作）→ 再对账应恢复 ok
    const cand = marksMod.collectLegacyCandidates(root);
    assert.equal(cand.ok, true);
    assert.equal(cand.candidates.length, 3);
    const mk = marksMod.appendLegacyMarks(root, cand.candidates.map((c) => ({
      code: c.code, fingerprint: c.fingerprint, sid: c.rec.sid, turn: c.rec.turn,
    })));
    assert.equal(mk.ok, true);
    assert.equal(mk.appended, 3);
    const rec = panel.runPanelRoute(env, 'reconcile', { maxDetail: 10, refresh: 1 });
    assert.equal(rec.json.ok, true);
    assert.equal(rec.json.reconcileOk, true);
    assert.equal(rec.json.okStrict, true);
    assert.equal(rec.json.ledgerRows, 3);
    assert.equal(rec.json.codeUnique, true);
    assert.equal(rec.json.sidTurnUnique, true);
    assert.equal(rec.json.ledgerOk, true);
    assert.equal(rec.json.originalOrphanCount, 0);
    assert.equal(rec.json.weeklyGroupsMissingCount, 0);
    assert.equal(rec.json.lostGapsCount, 0);
    assert.equal(rec.json.receiptBreaksCount, 0);
    assert.equal(rec.json.legacyUnverifiableCount, 3, '历史无证据行必须单列（已基线标记）');
    assert.equal(rec.json.legacyMarks.matched, 3);
    for (const k of ['path', 'exists', 'chainOk', 'count', 'matched', 'mismatched', 'unmarked', 'orphan']) {
      assert.equal(k in rec.json.legacyMarks, true, `legacyMarks 缺键: ${k}`);
    }
    assert.equal(rec.json.legacyMarks.chainOk, true);
    assert.deepEqual(rec.json.sealChain, { ok: true, lines: 1, events: 1, breaks: 0 });
    for (const k of ['originalMissing', 'weeklyGroupsMissing', 'receiptBreaks']) {
      assert.equal(Array.isArray(rec.json.top[k]), true, `reconcile.top.${k} 必须是数组`);
    }
    assert.equal(typeof rec.json.at, 'string');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// A2：调用前后全库 sha256 集合逐字节不变（唯一允许 .reads.jsonl）
// ============================================================================

test('V0.6/panelapi A2：7 条路由连调后，除 .reads.jsonl 外全库 sha256 不变', () => {
  const { base, root } = makeLab();
  try {
    const env = makeEnv(root);
    const before = snapshot(root);
    for (const route of panel.API_ROUTES) {
      const r = panel.runPanelRoute(env, route, argsFor(route));
      assert.equal(r.json.ok, true, route + ' 应成功');
    }
    const after = snapshot(root);
    assert.deepEqual(after, before, 'panelapi 只许写读日志（.reads/ 分片或老库 .reads.jsonl）；台账/原文/周账/交接表/封板链/报告一个字节都不许动');
    // 读日志确实落了（否则说明 A3 的前提不成立）
    assert.equal(readLogRows(root).length, 7);
    // V0.6.4 ③：新写入必须落 `.reads/YYYY-MM.jsonl`（旧 .reads.jsonl 只读、不再创建）
    const shards = readShards(root);
    assert.equal(shards.length >= 1, true, '新写入应落在 <root>/ledger/.reads/ 分片里');
    assert.match(shards[0].name, /^\d{4}-\d{2}\.jsonl$/, '第一份分片命名应为 YYYY-MM.jsonl：' + shards[0].name);
    assert.equal(fs.existsSync(path.join(root, 'ledger', '.reads.jsonl')), false, '新逻辑不得再创建旧单文件 .reads.jsonl');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// A3：每次 GET 后读日志恰好 +1 行（旧 .reads.jsonl + 新 .reads/ 分片合计），字段齐全；HEAD 不计
// ============================================================================

test('V0.6/panelapi A3：每次 GET 恰好 +1 行读日志，字段齐；HEAD 不计', () => {
  const { base, root } = makeLab();
  try {
    const env = makeEnv(root);
    let n = readLogRows(root).length;
    assert.equal(n, 0);

    for (const route of panel.API_ROUTES) {
      panel.runPanelRoute(env, route, argsFor(route));
      n += 1;
      assert.equal(readLogRows(root).length, n, route + ' 后读日志必须恰好 +1 行');
    }
    const rows = readLogRows(root);
    assert.deepEqual(rows.map((r) => r.tool), panel.API_ROUTES.map((r) => 'panel:' + r));
    const required = ['at', 'tool', 'args', 'hitCodes', 'returnedRows', 'bytes', 'ms', 'ok'];
    for (const row of rows) {
      for (const k of required) assert.equal(k in row, true, `读日志缺字段 ${k}`);
      assert.match(row.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/);
      assert.equal(row.ok, true);
      assert.equal(typeof row.returnedRows, 'number');
      assert.equal(typeof row.bytes, 'number');
      assert.equal(typeof row.ms, 'number');
      assert.equal(Array.isArray(row.hitCodes), true);
    }
    // search / turn / original 的命中编码要进日志
    const byTool = Object.fromEntries(rows.map((r) => [r.tool, r]));
    assert.deepEqual(byTool['panel:search'].hitCodes.length, 2);
    assert.deepEqual(byTool['panel:turn'].hitCodes, [codeOf(1)]);
    assert.deepEqual(byTool['panel:original'].hitCodes, [codeOf(1)]);

    // 失败 GET 也要恰好 +1 行（ok:false + error）
    const bad = panel.runPanelRoute(env, 'search', { month: '2026-13' });
    assert.equal(bad.status, 400);
    n += 1;
    assert.equal(readLogRows(root).length, n);
    const last = readLogRows(root).at(-1);
    assert.equal(last.ok, false);
    assert.match(last.error, /bad-param/);

    // HEAD 不计
    panel.runPanelRoute(env, 'ping', {}, { method: 'HEAD' });
    assert.equal(readLogRows(root).length, n, 'HEAD 不许写读日志');

    // 其它方法 405 + Allow: GET, HEAD（且不是 GET，不写日志）
    const post = panel.runPanelRoute(env, 'ping', {}, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.Allow, 'GET, HEAD');
    assert.equal(readLogRows(root).length, n);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// A4：读日志不被当成台账（readAll 行数/badLines 不变）
// ============================================================================

test('V0.6/panelapi A4：读日志不进台账（readAll 行数与坏行数不变）', () => {
  const { base, root } = makeLab();
  try {
    const env = makeEnv(root);
    const before = led.readAll(root, { repairTornTail: false });
    assert.equal(before.ok, true);
    assert.equal(before.records.length, 3);
    assert.equal(before.badLines, 0);

    for (const route of panel.API_ROUTES) panel.runPanelRoute(env, route, argsFor(route));
    panel.runPanelRoute(env, 'search', { month: 'bad' });
    panel.runPanelRoute(env, 'ping', {}, { method: 'HEAD' });

    const after = led.readAll(root, { repairTornTail: false });
    assert.equal(after.ok, true);
    assert.equal(after.records.length, 3, '读日志不能被当成台账行');
    assert.equal(after.badLines, 0, '读日志不能被算坏行');
    assert.equal(after.files, 1, '读日志（旧 .reads.jsonl 隐藏文件 / 新 .reads/ 分片目录）不得计入账文件数');
    assert.equal(readLogRows(root).length > 0, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// A5：错误路径 + 空库（"未验证" ≠ "坏"）
// ============================================================================

test('V0.6/panelapi A5：坏参数 400 / 编码不存在 200+not-found / 空库 0 且 health.ok=null', () => {
  const { base, root } = makeLab();
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'panelapi-empty-'));
  try {
    const env = makeEnv(root);

    // 坏月份（URL 直调，验证解码路径）
    const badMonth = panel.callPanelApi(env, '/dialog-ledger/api/search?month=2026-13');
    assert.equal(badMonth.status, 400);
    assert.equal(badMonth.json.ok, false);
    assert.equal(badMonth.json.reason, 'bad-param');
    assert.equal(typeof badMonth.json.detail, 'string');
    assert.equal(badMonth.headers['Content-Type'], 'application/json; charset=utf-8');

    // 非法数字参数
    assert.equal(panel.runPanelRoute(env, 'search', { limit: 'abc' }).status, 400);
    assert.equal(panel.runPanelRoute(env, 'reconcile', { maxDetail: 'x' }).status, 400);

    // 缺必填 code
    assert.equal(panel.runPanelRoute(env, 'turn', {}).status, 400);
    assert.equal(panel.runPanelRoute(env, 'original', {}).status, 400);

    // 编码不存在（数据级失败 → 200 + ok:false + not-found）
    const missTurn = panel.runPanelRoute(env, 'turn', { code: codeOf(99) });
    assert.equal(missTurn.status, 200);
    assert.equal(missTurn.json.ok, false);
    assert.equal(missTurn.json.reason, 'not-found');
    const missOriginal = panel.runPanelRoute(env, 'original', { code: codeOf(99) });
    assert.equal(missOriginal.status, 200);
    assert.equal(missOriginal.json.ok, false);
    assert.equal(missOriginal.json.reason, 'not-found');

    // 越界参数是钳制，不是错误
    assert.equal(panel.runPanelRoute(env, 'search', { limit: 9999 }).status, 200);
    assert.equal(panel.runPanelRoute(env, 'turn', { code: codeOf(1), excerptBytes: -5 }).status, 200);
    assert.equal(panel.runPanelRoute(env, 'reads', { limit: 0 }).status, 200);

    // 空库：root 根本不存在 → 计数 0、rootExists:false、health.ok===null（未验证，不许写 false 冒充坏）
    const emptyRoot = path.join(base2, 'root');
    const env2 = makeEnv(emptyRoot);
    const summary = panel.runPanelRoute(env2, 'summary');
    assert.equal(summary.json.ok, true);
    assert.equal(summary.json.rootExists, false);
    assert.deepEqual(summary.json.counts.handover, { main: 0, appendix: 0, total: 0 });
    assert.deepEqual(summary.json.counts.original, { views: 0, attachments: 0 });
    assert.deepEqual(summary.json.counts.weekly, { files: 0, months: 0, sealed: 0 });
    assert.equal(summary.json.counts.ledgerRows, 0);
    assert.equal(summary.json.health.ok, null, '没有运行报告 = null，不是 false');
    assert.equal(summary.json.health.okStrict, null);
    assert.equal(summary.json.health.gate, 'unknown');
    assert.equal(summary.json.health.evidence, 'no-run-report');
    assert.equal(summary.json.health.ledgerOk, true, '空库读得全（不是"坏"）');
    assert.equal(summary.json.reads.total, 0);

    // 空库上其余路由也必须 ok:true 且给出可读的"零"
    const eSearch = panel.runPanelRoute(env2, 'search', {});
    assert.equal(eSearch.json.ok, true);
    assert.equal(eSearch.json.rows.length, 0);
    assert.equal(eSearch.json.total, 0);
    // ★ 契约变更（V1.0 / 审计 P1-07，旧 → 新）：
    //   旧：空库（root 根本不存在）上 summary/search 也会落读日志，`reads` 能看到 2 行；
    //   新：**root 不存在/不合法时连 `<root>/ledger/.reads` 都不建**（只读 API 零写副作用），
    //       所以这里必须 0 行，且磁盘上不许出现 ledger/ 目录。
    const eReads = panel.runPanelRoute(env2, 'reads', {});
    assert.equal(eReads.json.ok, true);
    assert.equal(eReads.json.rows.length, 0, 'root 不存在时前面的 GET 不落读日志');
    assert.equal(eReads.json.total, 0);
    assert.equal(fs.existsSync(path.join(emptyRoot, 'ledger')), false, 'root 不存在时只读 GET 不许建库（P1-07）');
    // 边界（同一新契约的正向半边）：root **存在**（哪怕空目录）→ 读日志照常落，只读语义不变
    fs.mkdirSync(emptyRoot, { recursive: true });
    assert.equal(panel.runPanelRoute(env2, 'ping').json.ok, true);
    const eReads2 = panel.runPanelRoute(env2, 'reads', {});
    assert.equal(eReads2.json.rows.length, 1, 'root 存在后 GET 恢复落读日志');
    assert.equal(eReads2.json.summary.byTool['panel:ping'], 1);
    const eRec = panel.runPanelRoute(env2, 'reconcile', {});
    assert.equal(eRec.json.ok, true);
    assert.equal(eRec.json.ledgerRows, 0);
    assert.equal(eRec.json.originalMissingCount, 0);
    assert.equal(panel.runPanelRoute(env2, 'ping').json.ok, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(base2, { recursive: true, force: true });
  }
});

// ============================================================================
// A7：summary 的顶层键与 health 键一个不少（缺字段 = 红）
// ============================================================================

test('V0.6/panelapi A7：summary 顶层键与 health 契约键齐全', () => {
  const { base, root } = makeLab();
  try {
    panel.clearPanelCaches();
    const s = panel.runPanelRoute(makeEnv(root), 'summary').json;
    const TOP = ['ok', 'v', 'generatedAt', 'root', 'rootExists', 'layoutVersion', 'counts', 'health', 'reads', 'capabilities'];
    for (const k of TOP) assert.equal(k in s, true, `summary 顶层键缺失: ${k}`);
    for (const k of ['handover', 'original', 'weekly', 'ledgerRows']) {
      assert.equal(k in s.counts, true, `counts 键缺失: ${k}`);
    }
    // 契约 §1.3 的 health 键（逐字，22 个；面板"健康度第一屏"的 12 项指标全在其中）
    const HEALTH = [
      'ok', 'okStrict', 'gate', 'evidence', 'lastRunAt', 'lastRunReportAt',
      'ledgerOk', 'badLines', 'readErrors',
      'originalMissing', 'originalOrphan', 'weeklyGroupsMissing', 'lostGaps', 'receiptBreaks',
      'sealChainOk',
      'blockedSources', 'stuckSources', 'unavailable', 'errors',
      // ★ V0.6 / D18：legacy 基线三键
      'legacyUnverifiable', 'legacyUnmarkedNoEvidence', 'legacyMarksChainOk',
    ];
    for (const k of HEALTH) assert.equal(k in s.health, true, `health 键缺失: ${k}`);
    for (const k of ['total', 'lastAt', 'badLines']) assert.equal(k in s.reads, true, `reads 键缺失: ${k}`);
    for (const k of ['readOnly', 'physicalDelete', 'receiptAnchor']) {
      assert.equal(k in s.capabilities, true, `capabilities 键缺失: ${k}`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// A7+（V0.6.2）：交接表双路径 —— `交接表/` 与一级老位置都计数；同名只算一份
// ============================================================================

test('V0.6.2 双路径：交接表/ 与一级老位置都计数；同名重复只算一份（summary 键名/语义不变）', () => {
  // 守：《v0.6.2-迁移规格-v1》§2.2 —— 老库不迁移也必须能读到交接表；
  //     迁移中断/冲突时同名文件可能两处并存，面板不能把一份文档显示成两份。
  const { base, root } = makeLab();
  try {
    // ① 同一份主表+附表复制到一级老位置（模拟迁移前老库 / 迁移中断残留）
    fs.writeFileSync(path.join(root, MAIN_REL), fs.readFileSync(path.join(root, HANDOVER_DIR, MAIN_REL)));
    fs.writeFileSync(path.join(root, APPENDIX_REL), fs.readFileSync(path.join(root, HANDOVER_DIR, APPENDIX_REL)));

    panel.clearPanelCaches();
    const dup = panel.runPanelRoute(makeEnv(root), 'summary').json;
    assert.deepEqual(dup.counts.handover, { main: 1, appendix: 1, total: 2 },
      '同名文件两处并存只算一份（新目录优先，一级兜底不重复计数）');

    // ② 另一个会话的交接表只在一级（纯老布局、未迁移）→ 必须照样被看到
    const OTHER = 'abcdef123456A';
    const oldMain = `${OTHER}的记忆数据库的启用及交接表.md`;
    const oldApp = `${OTHER}的记忆数据库的启用及交接表——附表.md`;
    fs.writeFileSync(path.join(root, oldMain), '# 老布局主表\n', 'utf8');
    fs.writeFileSync(path.join(root, oldApp), '# 老布局附表\n', 'utf8');

    panel.clearPanelCaches();
    const both = panel.runPanelRoute(makeEnv(root), 'summary').json;
    assert.deepEqual(both.counts.handover, { main: 2, appendix: 2, total: 4 },
      '新 交接表/ 与一级老位置必须双处计数（老库不迁移也能读）');
    // 键名/语义不许变：仍然只有 main / appendix / total 三个键
    assert.deepEqual(Object.keys(both.counts.handover).sort(), ['appendix', 'main', 'total']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// 注册面：7 条 exact 路由 + resource 行为（GET/HEAD/405/404）+ 撤销
// ============================================================================

test('V0.6/panelapi：registerLedgerPanelApi 注册 7 条 exact resource 路由，可撤销；无服务静默跳过', async () => {
  const { base, root } = makeLab();
  try {
    const routes = [];
    const disposed = [];
    const fakeWebServer = {
      register(route) { routes.push(route); return () => disposed.push(route.path); },
    };
    const logger = { info() {}, warn() {} };
    const ctx = { logger, get(k) { return k === 'webServer' ? fakeWebServer : undefined; } };
    const reg = panel.registerLedgerPanelApi(ctx, makeEnv(root, { logger }));

    assert.equal(reg.registered, 7);
    assert.deepEqual(routes.map((r) => r.kind), panel.API_ROUTES.map(() => 'exact'));
    assert.deepEqual(routes.map((r) => r.path), panel.API_ROUTES.map((r) => '/dialog-ledger/api/' + r));
    for (const r of routes) assert.equal(typeof r.resource, 'function');

    const byRoute = Object.fromEntries(routes.map((r) => [r.path.split('/').pop(), r]));
    const pingRes = byRoute.ping.resource;

    // GET：200 + JSON 头 + 契约字段（V0.6.1/A8：资源请求必须带同源头）
    const okRes = await pingRes(new Request('http://panel.local/dialog-ledger/api/ping', { headers: SAME_SITE }));
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(okRes.headers.get('cache-control'), 'no-store');
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.v, 1);

    // HEAD：200 且不写读日志
    let n = readLogRows(root).length;
    const headRes = await pingRes(new Request('http://panel.local/dialog-ledger/api/ping', { method: 'HEAD', headers: SAME_SITE }));
    assert.equal(headRes.status, 200);
    assert.equal(readLogRows(root).length, n, 'HEAD 不许写读日志');

    // 非 GET/HEAD：405 + Allow: GET, HEAD
    const postRes = await pingRes(new Request('http://panel.local/dialog-ledger/api/ping', { method: 'POST', headers: SAME_SITE }));
    assert.equal(postRes.status, 405);
    assert.equal(postRes.headers.get('allow'), 'GET, HEAD');
    assert.equal(readLogRows(root).length, n);

    // 未注册路径：404
    const missRes = await pingRes(new Request('http://panel.local/dialog-ledger/api/nope', { headers: SAME_SITE }));
    assert.equal(missRes.status, 404);

    reg.dispose();
    assert.equal(disposed.length, 7, '卸载时必须撤销全部 7 条路由');

    // 没有 webServer 的环境：不抛错、registered=0
    const bare = panel.registerLedgerPanelApi({ logger: { warn() {} } }, makeEnv(root));
    assert.equal(bare.registered, 0);
    assert.equal(typeof bare.dispose, 'function');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// A8（V0.6.1；V1.0 按 P0-05/P1-06；★ V1.0.0-re3 按三份独立审计 ① P1-1 / ② A3 / ③ SEC-01 再加固）
//   ★ 契约变更（旧 → 新，逐条对应审计点名）：
//     · 旧：`if (site === 'same-origin') return true;` 放在回环 Host 校验**之前** →
//           `Host: evil.example:3142` + `Sec-Fetch-Site: same-origin` 实测 200（DNS rebinding 形态绕过）；
//     · 新：① **回环 Host 必须始终成立且先判**（缺/非回环 → 403）；
//           ② SFS 只作否决（cross-site/same-site/none → 403），`same-origin` **不再单独放行**；
//           ③ Origin/Referer 若存在，必须"回环 host + 端口与请求（Host 头）一致"，否则 403（fail-closed）；
//           ④ 无来源头只靠回环 Host 放行（DSH 桌面 WebView 实测形态）。
//     · 旧：Origin/Referer 与 `Request.url` 同源 → 放行；真机宿主 webServer 用**占位 origin**
//           （Request.url = `http://x/...`）构造 Request，该分支是死的，且 `Origin: http://x`
//           能配合 evil Host 绕过；新：不再用 Request.url 判同源，端口以 `Host` 头为准。
//   本用例逐条钉住 lead 要求的 8 形态矩阵（①无头+回环 200 ②无头+evil 403 ③evil+SFS 403
//   ④evil+Origin 403 ⑤回环+SFS cross-site 403 ⑥回环+SFS same-origin 200 ⑦POST 405 ⑧未知路由 404）。
// ============================================================================

test('V1.0.0-re3/A8：同源守卫 8 形态矩阵——SFS 只否决、回环 Host 恒成立、Origin/Referer 回环同端口', async () => {
  const { base, root } = makeLab();
  try {
    const routes = [];
    const fakeWebServer = { register(route) { routes.push(route); return () => {}; } };
    const env = makeEnv(root);
    panel.registerLedgerPanelApi({ get(k) { return k === 'webServer' ? fakeWebServer : undefined; } }, env);
    const route = routes.find((r) => r.path === '/dialog-ledger/api/ping');
    assert.ok(route, '必须先注册出 /dialog-ledger/api/ping');
    // 生产形态：宿主 webServer 用**占位 origin** 构造 Request（Request.url = http://x/...），
    // 真实主机/端口只在 Host 头里；旧实现拿 requestUrl.origin 比对 → 真机是死分支。
    const target = 'http://x/dialog-ledger/api/ping';
    const call = (headers, method = 'GET', url = target) => route.resource(new Request(url, {
      method, ...(headers ? { headers } : {}),
    }));

    const lines = readLogRows(root).length;

    // ① 无来源头 + 回环 Host → 200（DSH 桌面 WebView 实测形态；唯一放行的"三空"形态）
    const bare = await call({ host: '127.0.0.1:2687' });
    assert.equal(bare.status, 200, '① 无来源头 + 回环 Host 必须 200（实际 ' + bare.status + '）');
    assert.equal((await bare.json()).ok, true);
    // ② 无来源头 + evil Host / 缺 Host → 403（回环 Host 是先决条件）
    for (const host of ['evil.example:3142', '192.168.1.5:2687', undefined]) {
      const r = await call(host ? { host } : {});
      assert.equal(r.status, 403, '② 无来源头 + 非回环/缺 Host=' + String(host) + ' 必须 403（实际 ' + r.status + '）');
      assert.equal((await r.json()).reason, 'forbidden-origin');
    }
    // ③ ★ 审计点名的绕过：evil Host + SFS: same-origin → 必须 403（旧契约此处 200）
    const rebind = await call({ host: 'evil.example:3142', 'sec-fetch-site': 'same-origin' });
    assert.equal(rebind.status, 403, '③ evil Host + SFS: same-origin 必须 403（旧契约 200 = 审计① P1-1/② A3/③ SEC-01）');
    assert.equal((await rebind.json()).reason, 'forbidden-origin');
    // ④ evil Host + Origin: http://x（= 宿主占位 origin，旧实现会判"同源" → 200）→ 必须 403
    const deadBranch = await call({ host: 'evil.example:3142', origin: 'http://x' });
    assert.equal(deadBranch.status, 403, '④ evil Host + Origin: http://x 必须 403（占位 origin 死分支已删）');
    assert.equal((await deadBranch.json()).reason, 'forbidden-origin');
    // ⑤ 回环 Host + SFS: cross-site / same-site / none → 403（SFS 只作否决）
    for (const sfs of ['cross-site', 'same-site', 'none']) {
      const r = await call({ host: '127.0.0.1:2687', 'sec-fetch-site': sfs });
      assert.equal(r.status, 403, '⑤ 回环 Host + SFS=' + sfs + ' 必须 403（实际 ' + r.status + '）');
      assert.equal((await r.json()).reason, 'forbidden-origin');
    }
    // ⑥ 回环 Host + SFS: same-origin → 200（SFS 不再单独放行，但也不否决）
    const same = await call({ host: '127.0.0.1:2687', 'sec-fetch-site': 'same-origin' });
    assert.equal(same.status, 200, '⑥ 回环 Host + SFS: same-origin 必须 200（实际 ' + same.status + '）');
    // ⑦ POST → 405 + Allow: GET, HEAD（不碰账、不写读日志）
    const post = await call({ host: '127.0.0.1:2687' }, 'POST');
    assert.equal(post.status, 405, '⑦ POST 必须 405（实际 ' + post.status + '）');
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    // ⑧ 未知路由 → 404
    const unknown = await call({ host: '127.0.0.1:2687' }, 'GET', 'http://x/dialog-ledger/api/nope');
    assert.equal(unknown.status, 404, '⑧ 未知路由必须 404（实际 ' + unknown.status + '）');
    // 被拒请求零副作用：只有 ①⑥ 两次放行 GET 各记 1 行；③④⑤ 403 不写、⑦⑧ 也不是放行 GET
    assert.equal(readLogRows(root).length, lines + 2, '被拒请求不写读日志（仅 ①⑥ 两次放行 GET 各 +1 行）');

    // ③' Origin/Referer 分支（取代旧"与 Request.url 同源"）：回环 + 端口与请求一致才放行
    for (const headers of [
      { host: '127.0.0.1:2687', origin: 'http://127.0.0.1:2687' },        // 回环同端口 → 200
      { host: '127.0.0.1:2687', referer: 'http://127.0.0.1:2687/panel' }, // Referer 回环同端口 → 200
      { host: 'localhost:2687', origin: 'http://localhost:2687' },        // localhost 同端口 → 200
    ]) {
      const r = await call(headers);
      assert.equal(r.status, 200, JSON.stringify(headers) + ' 必须 200（实际 ' + r.status + '）');
    }
    for (const headers of [
      { host: '127.0.0.1:2687', origin: 'http://127.0.0.1:9999' },        // 端口不一致 → 403
      { host: '127.0.0.1:2687', origin: 'http://evil.example' },          // 非回环 → 403
      { host: '127.0.0.1:2687', origin: 'null' },                         // 解析失败 → 403（fail-closed）
      { host: '127.0.0.1:2687', referer: 'http://127.0.0.1:9999/x' },     // Referer 端口不一致 → 403
      // 任一来源头不匹配即拒绝：Origin 匹配 + Referer 不匹配 → 403
      { host: '127.0.0.1:2687', origin: 'http://127.0.0.1:2687', referer: 'http://evil.example/x' },
      // 回环 Host 但 Origin 仍是占位 origin → 按 fail-closed 403
      { host: '127.0.0.1:2687', origin: 'http://x' },
    ]) {
      const r = await call(headers);
      assert.equal(r.status, 403, JSON.stringify(headers) + ' 必须 403（实际 ' + r.status + '）');
      assert.equal((await r.json()).reason, 'forbidden-origin');
    }
    // host 变体：localhost / [::1] / 无端口都算回环 → 200
    for (const host of ['localhost:2687', '[::1]:2687', '127.0.0.1']) {
      const r = await call({ host });
      assert.equal(r.status, 200, '回环 Host=' + host + ' 必须 200（实际 ' + r.status + '）');
    }
    // 请求 URL 是回环也不能洗白 evil Host（Host 是唯一主机证据）
    const urlLoopback = await call({ host: 'evil.example:3142' }, 'GET', 'http://127.0.0.1:2687/dialog-ledger/api/ping');
    assert.equal(urlLoopback.status, 403, 'Host=evil 时即使 Request.url 是回环也必须 403');

    // HEAD：同样受守卫；HEAD 不写读日志
    const headLines = readLogRows(root).length;
    assert.equal((await call({ host: '127.0.0.1:2687' }, 'HEAD')).status, 200, 'HEAD 回环 Host 必须 200');
    assert.equal((await call({ host: 'evil.example:3142', 'sec-fetch-site': 'same-origin' }, 'HEAD')).status, 403,
      'HEAD evil Host + SFS same-origin 必须 403');
    assert.equal((await call({}, 'HEAD')).status, 403, 'HEAD 缺 Host 必须 403');
    assert.equal(readLogRows(root).length, headLines, 'HEAD 不计读日志');

    // runPanelRoute 是进程内直调（浏览器不经过它）→ 不受同源守卫影响
    assert.equal(panel.runPanelRoute(env, 'ping', {}, {}).status, 200, 'runPanelRoute 不许被同源守卫影响');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// V1.0.0-re3 / P2：/original 的 containedPath(realpath)→open TOCTOU（审计②）
//   旧：containedPath 校验（stat + realpath）之后**用路径重新 open**，两步之间可被换成
//       符号链接/目录联接 → 库外文件被当原文返回（本用例把 open 重定向到库外文件复现）。
//   新：open 后 fstat + 重新 containment + "验证路径的 dev/ino"与 fd 比对 → 拒绝（original-unverified）。
// ============================================================================

test('V1.0.0-re3/P2：/original open 后 fstat 校验，containedPath→open 之间被替换不得读库外', async () => {
  const { base, root } = makeLab();
  const secretAbs = path.join(base, 'TOP-SECRET-OUTSIDE-ROOT.txt');
  fs.writeFileSync(secretAbs, 'TOP-SECRET-OUTSIDE-ROOT-7f3a9c\n', 'utf8');
  try {
    const resource = panel.createPanelResource(makeEnv(root));
    const target = 'http://x/dialog-ledger/api/original?code=' + encodeURIComponent(codeOf(1));
    const call = () => resource(new Request(target, { headers: { host: LOOPBACK_HOST } }));

    // 正常路径先验一次（证明路由本身是好的）
    const normalRes = await call();
    assert.equal(normalRes.status, 200);
    const normal = await normalRes.json();
    assert.equal(normal.ok, true);
    assert.match(normal.text, /你好/);

    // 模拟 TOCTOU：containedPath 校验通过后，open 打开的是库外文件（旧实现会直接读出来 = 红）
    const realOpen = fs.openSync;
    const origAbs = path.join(root, ORIG_DIR, `${codeOf(1)} 完整原文.md`);
    let swapped = false;
    fs.openSync = function patchedOpen(p, flags, mode) {
      if (String(p) === origAbs) { swapped = true; return realOpen.call(fs, secretAbs, flags, mode); }
      return realOpen.apply(fs, arguments);
    };
    let racedRes;
    try { racedRes = await call(); } finally { fs.openSync = realOpen; }
    assert.equal(swapped, true, '必须真的模拟到"open 被换"');
    const raced = await racedRes.json();
    assert.equal(JSON.stringify(raced).includes('TOP-SECRET'), false, '库外机密绝不许出现在响应里');
    assert.notEqual(raced.ok, true, '竞态请求必须失败（旧实现 = ok:true + 库外正文）');
    assert.equal(raced.reason, 'changed-after-open', '失败原因必须是"打开后被替换"（实际 ' + raced.reason + '）');
    assert.equal(fs.existsSync(secretAbs), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ============================================================================
// SEC-01（V1.0 新增，机主裁定"不允许再后置到 1.0.x"）：面板只读 API 可选 token
//   环境变量 DSH_DIALOG_LEDGER_PANEL_TOKEN：未设/空 = 不启用；设置后必须带对 token，否则 401。
//   校验顺序：同源守卫（403）在前，token（401）在后；被拒请求零副作用、不写读日志。
// ============================================================================

test('V1.0/SEC-01：面板 token 三态（未设=不启用 / 设了缺=401 / 设了对=200）+ 头与 query 两种传法 + 不落盘', async () => {
  const { base, root } = makeLab();
  const ENV = panel.PANEL_TOKEN_ENV || 'DSH_DIALOG_LEDGER_PANEL_TOKEN';
  const HEADER = panel.PANEL_TOKEN_HEADER || 'x-dialog-ledger-token';
  const TOKEN = 'selftest-token-0123456789abcdef';
  const saved = process.env[ENV];
  try {
    const routes = [];
    const fakeWebServer = { register(route) { routes.push(route); return () => {}; } };
    const env = makeEnv(root);
    panel.registerLedgerPanelApi({ get(k) { return k === 'webServer' ? fakeWebServer : undefined; } }, env);
    const route = routes.find((r) => r.path === '/dialog-ledger/api/ping');
    assert.ok(route, '必须先注册出 /dialog-ledger/api/ping');
    const target = 'http://127.0.0.1:2687/dialog-ledger/api/ping';
    const call = (headers, method = 'GET', url = target) => route.resource(new Request(url, {
      method, ...(headers ? { headers } : {}),
    }));

    // ① 未设 token → 不启用（旧行为不变，零迁移）
    delete process.env[ENV];
    const off = await call({ host: '127.0.0.1:2687' });
    assert.equal(off.status, 200, '未设 token 时必须不启用（实际 ' + off.status + '）');

    // ② 设了 token：缺 → 401；错 → 401；对 → 200
    process.env[ENV] = TOKEN;
    const missing = await call({ host: '127.0.0.1:2687' });
    assert.equal(missing.status, 401, '设了 token 但请求没带 → 必须 401（实际 ' + missing.status + '）');
    assert.equal((await missing.json()).reason, 'unauthorized');
    const wrong = await call({ host: '127.0.0.1:2687', [HEADER]: 'WRONG-TOKEN-xxxxxxxx' });
    assert.equal(wrong.status, 401, '设了 token 但带错 → 必须 401（实际 ' + wrong.status + '）');
    const right = await call({ host: '127.0.0.1:2687', [HEADER]: TOKEN });
    assert.equal(right.status, 200, '设了 token 且带对（头）→ 必须 200（实际 ' + right.status + '）');
    // ②b query `?token=` 同样可用
    const viaQuery = await call({ host: '127.0.0.1:2687' }, 'GET', target + '?token=' + encodeURIComponent(TOKEN));
    assert.equal(viaQuery.status, 200, '设了 token 且带对（query）→ 必须 200（实际 ' + viaQuery.status + '）');
    const viaQueryBad = await call({ host: '127.0.0.1:2687' }, 'GET', target + '?token=nope');
    assert.equal(viaQueryBad.status, 401, 'query 带错 token → 必须 401（实际 ' + viaQueryBad.status + '）');
    // ②c 守卫顺序：无来源头（应 403）优先于 token 校验（即便带了正确 token）
    const guardFirst = await call({}, 'GET', target + '?token=' + encodeURIComponent(TOKEN));
    assert.equal(guardFirst.status, 403, '守卫必须先于 token 生效（实际 ' + guardFirst.status + '）');
    // ②d HEAD 同样受 token 约束
    assert.equal((await call({ host: '127.0.0.1:2687' }, 'HEAD')).status, 401, 'HEAD 缺 token 必须 401');
    assert.equal((await call({ host: '127.0.0.1:2687', [HEADER]: TOKEN }, 'HEAD')).status, 200, 'HEAD 带对 token 必须 200');

    // ③ token 不落读日志：进程内入口带 token 查询 → args 里必须脱敏
    const before = readLogRows(root).length;
    panel.runPanelRoute(env, 'ping', { token: TOKEN });
    const rows = readLogRows(root);
    assert.equal(rows.length, before + 1, 'GET 仍恰好 +1 行读日志');
    assert.ok(!JSON.stringify(rows[rows.length - 1]).includes(TOKEN), 'token 明文绝不许落读日志');

    // ④ 被拒请求零副作用：401/403 都不写读日志（上面的 before+1 已证明只有放行那次记了）
    const linesNow = readLogRows(root).length;
    await call({ host: '127.0.0.1:2687' }); // 401
    await call({}); // 403
    assert.equal(readLogRows(root).length, linesNow, '被拒请求（401/403）不写读日志');
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 缓存：summary 30s / reconcile 30s，refresh=1 强制重算
// ============================================================================

test('V0.6/panelapi：summary 30s 缓存与 ?refresh=1 强制重算（数字必须现场重取）', () => {
  const { base, root } = makeLab();
  try {
    const env = makeEnv(root);
    panel.clearPanelCaches();

    const s1 = panel.runPanelRoute(env, 'summary', {}, { nowMs: NOW });
    assert.equal(s1.json.counts.ledgerRows, 3);

    // 改夹具：追加一行台账
    const extra = { ...rowsOf()[0], code: codeOf(4), turn: 4, seq: 4, ts: '2026-11-08 14:00:00 +08:00' };
    fs.appendFileSync(path.join(root, 'ledger', '2026-11-08.jsonl'), JSON.stringify(extra) + '\n', 'utf8');

    const s2 = panel.runPanelRoute(env, 'summary', {}, { nowMs: NOW + 1000 });
    assert.equal(s2.json.counts.ledgerRows, 3, '30s 内必须命中缓存（不许频繁重扫）');

    const s3 = panel.runPanelRoute(env, 'summary', { refresh: '1' }, { nowMs: NOW + 2000 });
    assert.equal(s3.json.counts.ledgerRows, 4, 'refresh=1 必须现场重算');

    const s4 = panel.runPanelRoute(env, 'summary', {}, { nowMs: NOW + 40000 });
    assert.equal(s4.json.counts.ledgerRows, 4, '超过 30s 必须重算');
    assert.equal(typeof s4.json.generatedAt, 'string');
  } finally {
    panel.clearPanelCaches();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('V0.6/panelapi：reconcile 30s 缓存与 ?refresh=1（对账只读、不被缓存改写结论）', () => {
  const { base, root } = makeLab();
  try {
    const env = makeEnv(root);
    panel.clearPanelCaches();
    const r1 = panel.runPanelRoute(env, 'reconcile', {}, { nowMs: NOW });
    assert.equal(r1.json.originalOrphanCount, 0);

    // 造一个孤儿凭证（有文件、台账无编码）
    const orphanCode = `20261108-${S12}-A-00000077`;
    fs.mkdirSync(path.join(root, ORIG_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, ORIG_DIR, `${orphanCode} 完整原文.md`), '# 孤儿\n', 'utf8');

    const r2 = panel.runPanelRoute(env, 'reconcile', {}, { nowMs: NOW + 1000 });
    assert.equal(r2.json.originalOrphanCount, 0, '30s 内命中缓存');

    const r3 = panel.callPanelApi(env, '/dialog-ledger/api/reconcile?refresh=1', { nowMs: NOW + 2000 });
    assert.equal(r3.json.originalOrphanCount, 1, 'refresh=1 必须现场重算');
    assert.equal(r3.json.top.originalOrphan === undefined, true);
  } finally {
    panel.clearPanelCaches();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// index.js 接线：apply 时注册 7 条、卸载时撤销
// ============================================================================

test('V0.6/panelapi：apply() 带 webServer 时注册 7 条只读路由，卸载时全部撤销', async () => {
  const index = await import(pathToFileURL(path.join(SRC, 'index.js')).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'panelapi-apply-'));
  const root = path.join(base, 'root');
  const registered = [];
  const disposed = [];
  const fakeWebServer = {
    register(route) { registered.push(route); return () => disposed.push(route.path); },
  };
  const effectDisposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(k) { return k === 'webServer' ? fakeWebServer : undefined; },
    effect(fn) { const d = fn(); effectDisposers.push(d); return d; },
  };
  try {
    index.apply(ctx, { root, intervalSeconds: 3600, enabled: true, hotWindowSeconds: 0 });
    assert.equal(registered.length, 7, '带 webServer 时必须注册 7 条路由（实际 ' + JSON.stringify(registered.map((r) => r.path)) + '）');
    assert.deepEqual(registered.map((r) => r.kind), Array(7).fill('exact'));
    assert.deepEqual(registered.map((r) => r.path).sort(), panel.API_ROUTES.map((r) => '/dialog-ledger/api/' + r).sort());
    assert.ok(effectDisposers.length >= 1, 'apply 必须用 ctx.effect 注册清理');
    for (const d of effectDisposers.slice().reverse()) if (typeof d === 'function') d();
    assert.equal(disposed.length, 7, '卸载时必须撤销全部 7 条路由');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
