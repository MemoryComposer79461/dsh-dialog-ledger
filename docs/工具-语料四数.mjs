/**
 * @file 工具-语料四数.mjs
 * @role C01「台账行数＝真实轮数、(sid,turn)/code 唯一、坏行 0」的**现场可验化**工具：
 *       把「真实轮数」从"文档里的 1558"改成"此刻对语料现场重放的闭合轮数"，
 *       再与账库四个数（台账行数 / code 唯一 / (sid,turn) 唯一 / 坏行）同屏对账。
 *
 * @called-by 人工/审计：
 *   node docs/工具-语料四数.mjs --sessions=<stress-dir>\sessions --root=<账库根>
 *   node docs/工具-语料四数.mjs --sessions=<stress-dir>\sessions --count      # 只重放（不碰账库）
 *   node docs/工具-语料四数.mjs ... --json                                   # 机读
 *   也会被 docs/验收-v0.5/验收-CH.mjs 的 --sessions 真实语料模式 import（导出函数，不只有 CLI）。
 *
 * @depends ../lib/legacy.js（scanSessionSources / readSourceTurns —— 与生产同一套发现/读取口径）、
 *          ../lib/ledger.js（readAll / stampLocal —— 与生产同一套读账口径）
 *
 * @why 为什么不能把 1558 写死：
 *   1558 是 2026-11-10 在**机主真实账库**上全量灌入 16 会话的观测值（closed=1558 / open=1）。
 *   本机/审计方没有那份真实账库，把 1558 当阈值 = 把"旧机器的一次快照"当成永久契约；
 *   语料增删一轮就会假红/假绿。所以这里只认"现场重放"：源文件此刻有多少闭合轮，
 *   台账就必须有多少行 —— 数字可以变，口径不能变。
 *
 * @why 为什么 v3 要"显式标注不参与"而不是静默跳过：
 *   lib/legacy.js 的选源规则是「v3/v4 并存 → 一律选 v4（DSH 升级会把旧事件种子化进 v4）」。
 *   于是并存对里的 v3 文件**不参与**本次重放。若静默略过，读者会以为"所有 v3 都算过了"；
 *   所以这里把每个并存对逐条打印出来（含两边的字节数），把"不参与"变成可审计的事实。
 *   v3-only 源（没有 v4 的旧会话）则按"只读历史源"**参与**重放 —— 插件会把它纳入账，
 *   若重放漏掉它，行数就对不上（这正是要抓的回归）。
 *
 * @why 只读：
 *   · readTurnsFrom 不传 root → 不写 `.lost.jsonl` / `.errors.jsonl`；
 *   · readAll 显式 `repairTornTail:false` → 撕裂尾巴自愈是**写动作**，本工具绝不顺手修账；
 *   · 本文件不 import appendTurn / writeState，不 mkdir，不 touch 任何账库字节。
 *
 * 退出码：0 = 四数成立（台账行数==重放轮数 且 code 唯一 且 (sid,turn) 唯一 且 坏行 0
 *        且 (sid,turn) 集合双向一致 且 重放自身干净）；1 = 不成立/参数错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanSessionSources, readSourceTurns } from '../lib/legacy.js';
import { readAll, stampLocal } from '../lib/ledger.js';

/** UTC+08:00：本仓库所有时间戳口径（契约禁止 Z 结尾）。 */
export const OFFSET_MINUTES = 480;

/** 工具版本（改了输出结构就 +1）。 */
export const TOOL_VERSION = 1;

/** 人类可读输出里，逐源明细最多打印多少条（全量 16 条以内全打）。 */
const MAX_SOURCE_LINES = 60;

/** 差异明细最多打印多少条（JSON 里保留数量，不展开全量）。 */
const MAX_DIFF_LINES = 10;

/** 千分位（只用于人读输出；JSON 里是裸数字）。 */
function nfmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : String(n);
}

/** 把 Set 差集变成有序数组（只用于人读/诊断，不进判定口径）。 */
function diffSets(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out.sort();
}

/**
 * 现场重放语料，得到「应有关闭合轮数」。
 *
 * @param {string} sessionsBase 形如 `<DSH_HOME>/sessions` 的语料根
 * @param {{offsetMinutes?:number, maxDepth?:number}} [opts]
 * @returns {{
 *   sessionsBase:string, sources:number, v4Sources:number, v3OnlySources:number,
 *   pairs:number, v3Skipped:Array<object>, unsupported:number, unsupportedList:Array<object>,
 *   closedTurns:number, openTurns:number, abandoned:number, malformed:number,
 *   failedFrames:number, badLines:number, clean:boolean, readErrors:Array<object>,
 *   duplicateKeys:string[], turnKeys:string[], perSource:Array<object>
 * }}
 */
export function replayCorpus(sessionsBase, opts = {}) {
  const offsetMinutes = Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : OFFSET_MINUTES;
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 6;

  const sc = scanSessionSources(sessionsBase, { maxDepth });
  const perSource = [];
  const turnKeys = [];
  const turnKeySet = new Set();
  const duplicateKeys = [];
  const readErrors = [];
  let closedTurns = 0;
  let openTurns = 0;
  let abandoned = 0;
  let malformed = 0;
  let failedFrames = 0;
  let badLines = 0;
  let v4Sources = 0;
  let v3OnlySources = 0;

  for (const s of sc.supported) {
    const relDir = path.relative(sessionsBase, s.dir).split(path.sep).join('/');
    let r = null;
    let readError = '';
    try {
      // ★ 不传 root：读函数默认零副作用（否则坏帧会顺手写 .lost.jsonl —— 本工具只读）
      r = readSourceTurns(s, { offsetMinutes });
    } catch (e) {
      readError = e && e.message ? e.message : String(e);
      readErrors.push({ dir: relDir, file: s.path, error: readError });
    }
    const meta = (r && r.meta) || {};
    const closed = (r && Array.isArray(r.closed)) ? r.closed : [];
    const sid = (r && r.head && typeof r.head.id === 'string' && r.head.id) || s.sid || path.basename(s.dir);
    if (s.source === 'v4') v4Sources += 1; else v3OnlySources += 1;

    const turns = [];
    for (const t of closed) {
      const key = `${sid}#${t.turn}`;
      if (turnKeySet.has(key)) duplicateKeys.push(key);
      turnKeySet.add(key);
      turnKeys.push(key);
      turns.push(t.turn);
    }
    closedTurns += closed.length;
    const openTurn = r && r.open ? r.open.turn : null;
    if (openTurn !== null) openTurns += 1;
    abandoned += Number(r && r.abandoned) || 0;
    malformed += Number(r && r.malformed) || 0;
    failedFrames += Number(meta.failed) || 0;
    badLines += Number(meta.badLines) || 0;

    perSource.push({
      dir: relDir,
      file: s.path,
      sid,
      source: s.source,          // 'v4' | 'v3'（v3 = 只读历史源，参与重放）
      version: s.version,
      bytes: s.size,
      closedTurns: closed.length,
      turns,
      openTurn,
      abandoned: Number(r && r.abandoned) || 0,
      malformed: Number(r && r.malformed) || 0,
      failedFrames: Number(meta.failed) || 0,
      badLines: Number(meta.badLines) || 0,
      readError,
    });
  }

  const v3Skipped = (sc.pairs || []).map((pr) => {
    const stat = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    return {
      dir: path.relative(sessionsBase, pr.dir).split(path.sep).join('/'),
      sid: path.basename(pr.dir),
      v3Bytes: stat(pr.v3),
      v4Bytes: stat(pr.v4),
      reason: 'v3/v4 并存：按「v4 优先」纳入 v4，v3 源不参与重放（显式标注，不静默跳过）',
    };
  });
  const unsupportedList = (sc.unsupported || []).map((u) => ({
    dir: path.relative(sessionsBase, u.dir).split(path.sep).join('/'),
    file: u.path,
    version: u.version,
    reason: '不在支持范围（只读 v3/v4）：插件同样不纳入，重放也不计入；此处显式列出',
  }));

  const clean = readErrors.length === 0 && failedFrames === 0 && badLines === 0 &&
    malformed === 0 && duplicateKeys.length === 0;

  return {
    sessionsBase,
    sources: sc.supported.length,
    v4Sources,
    v3OnlySources,
    pairs: (sc.pairs || []).length,
    v3Skipped,
    unsupported: unsupportedList.length,
    unsupportedList,
    closedTurns,
    openTurns,
    abandoned,
    malformed,
    failedFrames,
    badLines,
    clean,
    readErrors,
    duplicateKeys,
    turnKeys,
    perSource,
  };
}

/**
 * 读账库四个数（与 lib/reconcile.js 完全同口径）。
 *
 * @param {string} root 账库根
 * @returns {{root:string, rows:number, codeUnique:boolean, sidTurnUnique:boolean,
 *            badLines:number, files:number, readErrors:number, readOk:boolean,
 *            dirExists:boolean, turnKeys:string[]}}
 */
export function ledgerFour(root) {
  // ★ 只读：repairTornTail:false 关掉"撕裂尾巴自愈"（那是写动作）；
  //   requireLedgerRows:true = 验账口径（合法 JSON 但缺账行形状的行按坏行计，别把"读不到"算成"读到"）。
  const all = readAll(root, { requireLedgerRows: true, repairTornTail: false });
  const codeSet = new Set();
  const keySet = new Set();
  let codeUnique = true;
  let sidTurnUnique = true;
  for (const r of all.records) {
    if (!r || typeof r !== 'object') continue;
    const code = typeof r.code === 'string' ? r.code : '';
    if (code) {
      if (codeSet.has(code)) codeUnique = false;
      codeSet.add(code);
    }
    const key = `${r.sid}#${r.turn}`;
    if (keySet.has(key)) sidTurnUnique = false;
    keySet.add(key);
  }
  return {
    root,
    rows: all.records.length,
    codeUnique,
    sidTurnUnique,
    badLines: all.badLines,
    files: all.files,
    readErrors: all.readErrors.length,
    readOk: all.ok === true,
    dirExists: all.dirExists === true,
    turnKeys: [...keySet],
  };
}

/**
 * 判定四数：台账行数==重放轮数、code 唯一、(sid,turn) 唯一、坏行 0，
 * 并核对 (sid,turn) 集合双向一致（防"行数凑巧对上、行却不对"）。
 *
 * @param {{replay:object, ledger:object, sessionsBase:string}} p
 * @returns {{ok:boolean, checks:object, reasons:string[],
 *            missingFromLedger:string[], extraInLedger:string[],
 *            missingCount:number, extraCount:number}}
 */
export function judgeFour({ replay, ledger }) {
  const replaySet = new Set(replay.turnKeys || []);
  const ledgerSet = new Set(ledger.turnKeys || []);
  const missingFromLedger = diffSets(replaySet, ledgerSet);
  const extraInLedger = diffSets(ledgerSet, replaySet);

  const checks = {
    sessionsPresent: replay.sources > 0,
    replayClean: replay.clean === true,
    ledgerReadOk: ledger.readOk === true && ledger.readErrors === 0,
    rowsEqualsReplay: ledger.rows === replay.closedTurns,
    codeUnique: ledger.codeUnique === true,
    sidTurnUnique: ledger.sidTurnUnique === true,
    badLinesZero: ledger.badLines === 0,
    sidTurnSetEqual: missingFromLedger.length === 0 && extraInLedger.length === 0,
  };

  const reasons = [];
  const add = (msg) => reasons.push(msg);
  if (!checks.sessionsPresent) add('语料里没有任何支持的会话源（v3/v4），无法证明"真实轮数"');
  if (!checks.replayClean) {
    add(`重放自身不干净（读错误=${replay.readErrors.length}、坏帧=${replay.failedFrames}、` +
      `坏行=${replay.badLines}、malformed=${replay.malformed}、重复键=${replay.duplicateKeys.length}）` +
      '—— 此时"重放轮数"本身不可信，不能拿它当基准');
  }
  if (!checks.ledgerReadOk) add(`台账读不全（readErrors=${ledger.readErrors}、ok=${ledger.readOk}）`);
  if (!checks.rowsEqualsReplay) {
    add(`台账行数=${ledger.rows} != 现场重放闭合轮数=${replay.closedTurns}` +
      (ledger.rows < replay.closedTurns
        ? `（少 ${replay.closedTurns - ledger.rows} 行）`
        : `（多 ${ledger.rows - replay.closedTurns} 行）`));
  }
  if (!checks.codeUnique) add('台账 code 不唯一（同 code 出现多行）');
  if (!checks.sidTurnUnique) add('台账 (sid,turn) 不唯一（同一轮出现多行）');
  if (!checks.badLinesZero) add(`台账坏行=${ledger.badLines}（应为 0）`);
  if (!checks.sidTurnSetEqual) {
    add(`(sid,turn) 集合不一致：台账缺 ${missingFromLedger.length} 个、多 ${extraInLedger.length} 个` +
      `（缺=${JSON.stringify(missingFromLedger.slice(0, MAX_DIFF_LINES))}` +
      `，多=${JSON.stringify(extraInLedger.slice(0, MAX_DIFF_LINES))}）`);
  }

  return {
    ok: Object.values(checks).every((x) => x === true),
    checks,
    reasons,
    missingFromLedger,
    extraInLedger,
    missingCount: missingFromLedger.length,
    extraCount: extraInLedger.length,
  };
}

/** 组一个可以 JSON.stringify 的完整结果（turnKeys/perSource.turns 换成计数，避免冗长）。 */
export function toJson(result) {
  const { replay, ledger, judge, mode, sessionsBase, root, at } = result;
  return {
    tool: '工具-语料四数',
    v: TOOL_VERSION,
    at,
    mode,
    sessions: sessionsBase,
    root: root || '',
    replay: {
      sources: replay.sources,
      v4Sources: replay.v4Sources,
      v3OnlySources: replay.v3OnlySources,
      pairs: replay.pairs,
      v3Skipped: replay.v3Skipped,
      unsupported: replay.unsupported,
      unsupportedList: replay.unsupportedList,
      closedTurns: replay.closedTurns,
      openTurns: replay.openTurns,
      abandoned: replay.abandoned,
      malformed: replay.malformed,
      failedFrames: replay.failedFrames,
      badLines: replay.badLines,
      clean: replay.clean,
      duplicateKeys: replay.duplicateKeys.length,
      perSource: replay.perSource.map((s) => ({
        sid: s.sid,
        source: s.source,
        version: s.version,
        bytes: s.bytes,
        closedTurns: s.closedTurns,
        openTurn: s.openTurn,
        failedFrames: s.failedFrames,
        badLines: s.badLines,
      })),
    },
    ledger: ledger ? {
      rows: ledger.rows,
      codeUnique: ledger.codeUnique,
      sidTurnUnique: ledger.sidTurnUnique,
      badLines: ledger.badLines,
      files: ledger.files,
      readErrors: ledger.readErrors,
      readOk: ledger.readOk,
      turnKeyCount: ledger.turnKeys.length,
    } : null,
    four: ledger ? {
      ledgerRows: ledger.rows,
      replayTurns: replay.closedTurns,
      codeUnique: ledger.codeUnique,
      sidTurnUnique: ledger.sidTurnUnique,
      badLines: ledger.badLines,
    } : null,
    judge: {
      ok: judge.ok,
      checks: judge.checks,
      reasons: judge.reasons,
      missingFromLedger: judge.missingFromLedger.slice(0, MAX_DIFF_LINES),
      extraInLedger: judge.extraInLedger.slice(0, MAX_DIFF_LINES),
      missingCount: judge.missingCount,
      extraCount: judge.extraCount,
    },
  };
}

/**
 * 人读报告（四数必须同屏）。
 * @param {object} result
 * @returns {string}
 */
export function formatHuman(result) {
  const { replay, ledger, judge, mode, sessionsBase, root, at } = result;
  const L = [];
  L.push('=== C01 语料四数：台账行数＝真实轮数 ｜ (sid,turn)/code 唯一 ｜ 坏行 0 ===');
  L.push('工具 : docs/工具-语料四数.mjs（只读：不 appendTurn / 不写 state / 不修撕裂尾巴）');
  L.push('模式 : ' + (mode === 'count' ? '重放计数（--count，不读账库）' : '重放 + 账库对账'));
  L.push('语料 : ' + sessionsBase);
  if (root) L.push('账库 : ' + root);
  L.push('时间 : ' + at);
  L.push('');
  L.push('[① 现场重放：真实轮数的唯一来源（lib/legacy.js scanSessionSources + readSourceTurns）]');
  L.push(`  支持源=${replay.sources}（v4=${replay.v4Sources} ｜ v3 只读历史源=${replay.v3OnlySources}）` +
    ` ｜ v3/v4 并存=${replay.pairs}（v3 不参与）｜ 不支持版本=${replay.unsupported}`);
  if (replay.v3Skipped.length > 0) {
    L.push('  · v3 不参与明细（显式标注：按「v4 优先」，不是静默跳过）:');
    for (const p of replay.v3Skipped) {
      L.push(`      - ${p.dir}（v3=${nfmt(p.v3Bytes)} B → v4=${nfmt(p.v4Bytes)} B）`);
    }
  }
  if (replay.unsupportedList.length > 0) {
    L.push('  · 不支持版本明细（插件同样不纳入）:');
    for (const p of replay.unsupportedList) {
      L.push(`      - ${p.dir}（v${p.version}）`);
    }
  }
  L.push('  · 逐源闭合轮:');
  const shown = replay.perSource.slice(0, MAX_SOURCE_LINES);
  for (const s of shown) {
    const open = s.openTurn === null ? '-' : String(s.openTurn);
    L.push(`      - ${s.sid} [${s.source}] ${nfmt(s.bytes)}B closed=${s.closedTurns} open=${open}` +
      (s.readError ? `（读错误: ${s.readError}）` : ''));
  }
  if (replay.perSource.length > shown.length) {
    L.push(`      … 另有 ${replay.perSource.length - shown.length} 个源（JSON 里全量）`);
  }
  L.push(`  应有关闭合轮数=${nfmt(replay.closedTurns)} ｜ open（不落账）=${replay.openTurns} ｜ ` +
    `abandoned=${replay.abandoned} ｜ malformed=${replay.malformed} ｜ 坏帧=${replay.failedFrames} ｜ ` +
    `坏行=${replay.badLines} ｜ 重放干净=${replay.clean}`);
  L.push('');
  if (ledger) {
    L.push('[② 台账读数：lib/ledger.js readAll({requireLedgerRows:true, repairTornTail:false})]');
    L.push(`  台账行数=${nfmt(ledger.rows)} ｜ code 唯一=${ledger.codeUnique} ｜ ` +
      `(sid,turn) 唯一=${ledger.sidTurnUnique} ｜ 坏行=${ledger.badLines} ｜ ` +
      `日文件=${ledger.files} ｜ 读错误=${ledger.readErrors} ｜ 读全=${ledger.readOk}`);
    L.push('');
    L.push('[③ 对账（真实轮数 vs 台账）]');
    L.push(`  台账行数 ${nfmt(ledger.rows)} ${ledger.rows === replay.closedTurns ? '==' : '!='} ` +
      `现场重放闭合轮数 ${nfmt(replay.closedTurns)}`);
    L.push(`  (sid,turn) 集合：台账 ${nfmt(ledger.turnKeys.length)} ` +
      `${judge.checks.sidTurnSetEqual ? '==' : '!='} 重放 ${nfmt(replay.turnKeys.length)}` +
      `${judge.checks.sidTurnSetEqual ? '（双向一致）' : `（缺 ${judge.missingCount} / 多 ${judge.extraCount}）`}`);
    L.push('');
    L.push(judge.ok
      ? `判定：PASS — 台账行数==重放轮数=${nfmt(replay.closedTurns)}，且 code 唯一、` +
        `(sid,turn) 唯一、坏行=0、(sid,turn) 集合双向一致`
      : '判定：FAIL — ' + judge.reasons.join('；'));
  } else {
    L.push('判定：PASS（--count 只做重放计数，不判定账库；把 --root=<账库根> 加上才是四数对账）');
  }
  return L.join('\n');
}

/** 用法。 */
export function usage() {
  return [
    '用法:',
    '  node docs/工具-语料四数.mjs --sessions=<sessions 目录> --root=<账库根> [--json]',
    '  node docs/工具-语料四数.mjs --sessions=<sessions 目录> --count [--json]   # 只重放，不读账库',
    '',
    '  --sessions=…   语料根（形如 <DSH_HOME>/sessions；只读）',
    '  --root=…       账库根（与 --sessions 必须指向同一批会话，否则行数必然对不上）',
    '  --count        只输出「应有关闭合轮数」（真实语料的现场基准），不读账库',
    '  --json         机读输出（只有 JSON，不含人读文字）',
    '  --offset=480   时间戳口径（默认 +08:00 = 480 分钟）',
    '  --help         本帮助',
    '',
    '判定：台账行数==重放轮数 且 code 唯一 且 (sid,turn) 唯一 且 坏行==0',
    '      且 (sid,turn) 集合双向一致 且 重放自身干净 → exit 0；否则 exit 1。',
    '只读：不写台账/state/游标/坏行取证。',
  ].join('\n');
}

/** 解析 `--k=v` / `--flag`。 */
function parseArgs(argv) {
  const opt = { sessions: '', root: '', count: false, json: false, help: false, offsetMinutes: OFFSET_MINUTES };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--count') opt.count = true;
    else if (a === '--json') opt.json = true;
    else if (a.startsWith('--sessions=')) opt.sessions = a.slice('--sessions='.length);
    else if (a.startsWith('--root=')) opt.root = a.slice('--root='.length);
    else if (a.startsWith('--offset=')) {
      const n = Number(a.slice('--offset='.length));
      if (Number.isInteger(n) && n >= -720 && n <= 840) opt.offsetMinutes = n;
      else throw new Error('--offset 必须是 -720..840 的整数');
    } else throw new Error('未知参数: ' + a + '（--help 看用法）');
  }
  return opt;
}

/**
 * CLI 入口。
 * @param {string[]} [argv]
 * @returns {number} 退出码（0/1）
 */
export async function main(argv = process.argv.slice(2)) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    console.error('[四数] ✗ ' + (e && e.message ? e.message : String(e)));
    return 1;
  }
  if (opt.help) { console.log(usage()); return 0; }
  if (!opt.sessions) {
    console.error('[四数] ✗ 缺少 --sessions=<语料根>\n' + usage());
    return 1;
  }
  const sessionsBase = path.resolve(opt.sessions);
  if (!fs.existsSync(sessionsBase)) {
    console.error('[四数] ✗ 语料目录不存在: ' + sessionsBase);
    return 1;
  }

  const replay = replayCorpus(sessionsBase, { offsetMinutes: opt.offsetMinutes });
  const at = stampLocal(Date.now(), opt.offsetMinutes);
  let result;

  if (opt.count) {
    const judge = {
      ok: replay.sources > 0 && replay.clean,
      checks: { sessionsPresent: replay.sources > 0, replayClean: replay.clean === true },
      reasons: replay.sources > 0 && replay.clean ? [] : ['重放不干净或语料为空，重放轮数不可信'],
      missingFromLedger: [], extraInLedger: [], missingCount: 0, extraCount: 0,
    };
    result = { mode: 'count', at, sessionsBase, root: '', replay, ledger: null, judge };
  } else {
    if (!opt.root) {
      console.error('[四数] ✗ 缺少 --root=<账库根>（只重放请用 --count）\n' + usage());
      return 1;
    }
    const root = path.resolve(opt.root);
    const ledger = ledgerFour(root);
    const judge = judgeFour({ replay, ledger });
    result = { mode: 'judge', at, sessionsBase, root, replay, ledger, judge };
  }

  console.log(opt.json ? JSON.stringify(toJson(result), null, 2) : formatHuman(result));
  return result.judge.ok ? 0 : 1;
}

/** 直接运行时才执行 CLI（被 验收-CH import 时不跑）。 */
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
