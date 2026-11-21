/**
 * @file checkup.js
 * @role 体检：把台账里 `status=partial` 的记录拿回**源会话**核对，判断"账实是否相符"。
 * @called-by index.js（每次扫描后，按节流条件触发；P1 起计划移出 tick）、doctor / 一次性脚本
 * @depends node:fs / node:path、./ledger.js（readAll / readTurnsFrom）、./layout.js（报告落盘布局）
 *
 * ★ lite 可独立运行改造（P1「checkup 移出 tick」的第 1 步；文件本版不移动）：
 *   本模块**不吃 tick 的任何内部状态**——root / sessionsBase / 编号状态全部由参数注入；
 *   `partials` 不传时自己从台账读（`readAll` + `status==='partial'`），`nowMs` 可注入以便复现。
 *   于是它不必等 tick 调度，可以被 doctor / REPL / 一次性脚本直接 import 后调用：
 *
 *     import { runCheckup } from './lib/checkup.js';
 *     const r = runCheckup({ root: '<数据总库>', sessionsBase: '<DSH_HOME>/sessions' });
 *
 *   （注意：它**不** import 任何冻结模块 manifestanchor / handover / cleanup / selfheal /
 *     sealcross / legacy-marks —— 体检只看"源会话闭合 vs 台账状态"，本就不需要那些检查项。）
 *
 * @why 为什么必须"回源"而不是"信账"：
 *      partial 的语义是"落账时未闭合"。账只追加、永不追改，所以"后来闭合了"
 *      这件事只能靠回源发现。体检就是这个发现器。
 *
 * @why 为什么只读：
 *      改账 = 破坏"只追加 + 永久主键"，那是审计的根。体检只出报告，修复交 user。
 *
 * @why 为什么报告编号要落 state：
 *      `CHK-YYYYMMDD-NN` 必须唯一且可追溯。用调用方保存的每日计数器分配，
 *      不靠"扫目录取最大号"——那种做法在并发/回滚时会撞号。
 *      （计数器由调用方保管：tick 放 .state.json，独立脚本自己存；本模块只负责算下一个号。）
 */

import fs from 'node:fs';
import path from 'node:path';
import { readAll, readTurnsFrom } from './ledger.js';
import {
  FILE_KIND, ensureSubdir, newLayoutPath, pathCandidates,
} from './layout.js';

/**
 * 毫秒 → `YYYY-MM-DDTHH:MM:SS+08:00`（口径 3：全系统固定 +08:00，禁止落 Z）。
 * @why 本文件此前用 `toISOString()`，会落 `Z` 时间，与台账/产物口径混用；
 *      审计时"同一份报告里出现两种时区写法"是不可接受的。
 */
function isoLocal(ms, offsetMinutes) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 遍历 sessions 目录，建 sid → 文件路径 的索引。 */
export function indexSessionFiles(sessionsBase) {
  const map = new Map();
  (function walk(dir, depth) {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.v4.jsonl.zstd') {
        const sid = path.basename(path.dirname(p));
        if (sid.startsWith('session-')) map.set(sid, p);
      }
    }
  })(sessionsBase, 0);
  return map;
}

/**
 * 自己从台账里取 partial 记录（`partials` 由调用方省略时用）。
 *
 * @why 这是"独立运行"的关键：tick 里 partial 是扫描顺带留下的，体检若只能吃 tick 的
 *      中间数组，就永远离不开 tick。台账是唯一真相源，重读一次即可（低频、只读）。
 * @param {string} root 数据总库
 * @returns {object[]} `status==='partial'` 的账行
 */
function readPartialRecords(root) {
  const all = readAll(root);
  return (all.records || []).filter((r) => r && r.status === 'partial');
}

/**
 * 对账一条 partial。
 *
 * @param {object} rec 台账记录（含 sid / turn / code / ts）
 * @param {Map<string,string>} files sid → 源文件
 * @param {number} [offsetMinutes] 时区偏移（用于把时间写成 +08:00）
 * @returns {{verdict:string, detail:string, endMs:number|null}}
 *          verdict ∈ 应闭合而未更新｜确实未闭合｜孤儿轮次｜源会话缺失｜源会话无此轮
 */
export function reconcileOne(rec, files, offsetMinutes = 480) {
  const file = files.get(rec.sid);
  if (!file) return { verdict: '源会话缺失', detail: '找不到该 sid 的会话文件（可能已归档/删除）', endMs: null };

  let r;
  try {
    // 全量读（体检是低频操作，不做增量；也避免依赖游标状态）
    r = readTurnsFrom(file, { fromByte: 0 });
  } catch (e) {
    return { verdict: '源会话缺失', detail: '读取失败: ' + e.message, endMs: null };
  }
  if (r.formatError) {
    return { verdict: '源会话缺失', detail: '格式无法解析: ' + r.formatError, endMs: null };
  }

  const closed = r.closed.find((t) => t.turn === rec.turn);
  if (closed) {
    // ★ P1-1 修正：被"下一轮 start"顶掉的孤儿轮次，在账里就是 partial（设计如此）。
    //   原实现把它算进"应闭合而未更新"，会让每条孤儿轮次永久误报 → 报告永远有假红。
    if (closed.reason === 'abandoned') {
      return {
        verdict: '孤儿轮次',
        detail: '该轮被下一轮 start 顶掉、没有 turn/end —— partial 记录正确（' +
          isoLocal(closed.endMs, offsetMinutes) + ' 收尾）',
        endMs: closed.endMs,
      };
    }
    return {
      verdict: '应闭合而未更新',
      detail: '源会话已有 turn/end（' + isoLocal(closed.endMs, offsetMinutes) + '），账上仍是 partial',
      endMs: closed.endMs,
    };
  }
  if (r.open && r.open.turn === rec.turn) {
    return { verdict: '确实未闭合', detail: '源会话至今没有 turn/end —— partial 记录正确', endMs: null };
  }
  return { verdict: '源会话无此轮', detail: '源文件里找不到该 turn 的 turn/start', endMs: null };
}

/**
 * 跑一次完整体检并写报告（**只读**：只读源会话与台账，只新增 `体检/CHK-*.md`）。
 *
 * 可以脱离 tick 单独调用：`runCheckup({ root, sessionsBase })` 即可——
 * partials 省略时自己从台账读，编号状态由调用方按需保管（不传就当当天第 01 份）。
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录
 * @param {string} p.sessionsBase 会话根目录
 * @param {object[]} [p.partials] 所有 partial 记录（**可省略**：省略时自己从台账读）
 * @param {{day:string, n:number}|null} [p.seqState] 上一次的编号状态（调用方保管）
 * @param {number} [p.offsetMinutes] 时区偏移（用于落盘时间）
 * @param {number} [p.nowMs] 现在时刻（默认 Date.now()，测试/复现可注入）
 * @returns {{reportId:string, path:string, mismatched:number, missing:number, ok:number, total:number, seqState:object}}
 *   注：V0.6.2 起 `path` 是 `<root>/体检/CHK-*.md`（写端只写新子目录）；
 *   重名检测同时看 `体检/` 与一级老位置，老库不迁移也不会被覆盖。
 */
export function runCheckup({
  root, sessionsBase, partials, seqState, offsetMinutes = 480, nowMs = Date.now(),
}) {
  // 独立运行：不传 partials 就自己从台账取（tick 之外也能跑）
  const partialsList = Array.isArray(partials) ? partials : readPartialRecords(root);
  const files = indexSessionFiles(sessionsBase);
  const rows = partialsList.map((rec) => ({ rec, ...reconcileOne(rec, files, offsetMinutes) }));

  const mismatched = rows.filter((x) => x.verdict === '应闭合而未更新');
  const missing = rows.filter((x) => x.verdict === '源会话缺失' || x.verdict === '源会话无此轮');
  const abandoned = rows.filter((x) => x.verdict === '孤儿轮次');
  const ok = rows.filter((x) => x.verdict === '确实未闭合');

  const shifted = new Date(Number(nowMs) + offsetMinutes * 60 * 1000);
  const day = `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(shifted.getUTCDate()).padStart(2, '0')}`;
  const prev = seqState && seqState.day === day && Number.isInteger(seqState.n) ? seqState.n : 0;
  // ★ 编号唯一性：state 是"首选计数器"，但**绝不允许覆盖已存在的报告**。
  //   原因：state 丢失/回滚后计数器会归零，原实现会直接把当天第 01 份报告盖掉
  //   —— 那是用"永久证据"换"编号整齐"，审计上不可接受。
  //   V0.6.2：重名检测看**两处**（`体检/` 新目录 + 一级老位置）；写端只写 `体检/`。
  const taken = (id) => pathCandidates(root, FILE_KIND.CHECKUP_REPORT, `${id}.md`)
    .some((p) => fs.existsSync(p));
  let n = prev + 1;
  let reportId = `CHK-${day}-${String(n).padStart(2, '0')}`;
  ensureSubdir(root, FILE_KIND.CHECKUP_REPORT); // 写端只写 `<root>/体检/`
  let reportPath = newLayoutPath(root, FILE_KIND.CHECKUP_REPORT, `${reportId}.md`);
  for (let guard = 0; guard < 500 && taken(reportId); guard++) {
    n++;
    reportId = `CHK-${day}-${String(n).padStart(2, '0')}`;
    reportPath = newLayoutPath(root, FILE_KIND.CHECKUP_REPORT, `${reportId}.md`);
  }

  const stamp = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')} ` +
    `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}:${String(shifted.getUTCSeconds()).padStart(2, '0')}`;

  const L = [];
  L.push(`# ${reportId} · partial 对账报告`);
  L.push('');
  L.push(`- 生成时间：${stamp}（UTC+08:00）`);
  L.push(`- 数据总库：\`${root}\``);
  L.push(`- 对账范围：${partialsList.length} 条 \`status=partial\``);
  L.push('');
  L.push('## 结论');
  L.push('');
  L.push('| 类别 | 条数 | 含义 |');
  L.push('|---|---:|---|');
  L.push(`| 应闭合而未更新 | **${mismatched.length}** | 源会话已有 turn/end，账上仍是 partial → 需人判定 |`);
  L.push(`| 确实未闭合 | ${ok.length} | partial 记录正确 |`);
  L.push(`| 孤儿轮次 | ${abandoned.length} | 被下一轮 start 顶掉、本就没有 turn/end —— partial 记录正确 |`);
  L.push(`| 源会话缺失/无此轮 | ${missing.length} | 无法对账 |`);
  L.push('');
  L.push('> 本报告只读：不改写台账、不修改源会话。修复由 user 决定。');
  L.push('');
  if (rows.length) {
    L.push('## 明细');
    L.push('');
    L.push('| 编码 | 会话 | turn | 账上 ts | 判定 | 说明 |');
    L.push('|---|---|---:|---|---|---|');
    for (const x of rows) {
      L.push(`| \`${x.rec.code}\` | ${String(x.rec.sid).slice(0, 22)}… | ${x.rec.turn} | ${x.rec.ts} | ${x.verdict} | ${x.detail} |`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`**结束** · ${reportId} · 生成器 dsh-dialog-ledger-v0.4/checkup`);

  fs.writeFileSync(reportPath, L.join('\n'), 'utf8');

  return {
    reportId, path: reportPath,
    mismatched: mismatched.length, missing: missing.length, ok: ok.length, abandoned: abandoned.length,
    total: rows.length,
    seqState: { day, n },
  };
}
