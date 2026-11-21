/**
 * @file 验收-P1.mjs
 * @role P1 十二条（形成可信数据链）的「能失败的测试」。
 *
 * 依据：`<test-dir>\work\v0.5\01-v0.5-范围重定-审计驱动.md` §四 P1 判据表 + `施工方向-给编程Agent` §04。
 * 纪律：所有测试数据落 %TEMP%；一次只跑一个测试文件；跑前打印可用内存（<0.5GB 只写不跑）。
 *
 * 用法：
 *   node docs/验收-v0.5/验收-P1.mjs --out=docs/验收-v0.5/_results/P1.json [--only=P1-1,P1-3]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main, expect, expectEqual, freeMemMB, skip } from './_runner.mjs';
import * as L from './_lab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const XLSX_PROBE = path.join(PLUGIN, 'docs', '验收-v1.3', 'xlsx_probe.py');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rowsOf(lab) { return (await L.readLedger(PLUGIN, lab.root)).records; }
async function stateOf(lab) { return L.readState(PLUGIN, lab.root); }

/** 一轮干净会话（1 个 turn，含工具调用），写入 lab 并返回文件路径。 */
function writeOneTurn(lab, { createdAt = L.T0(), turnMs = L.T0() + 60_000, text = 'P1 用例的一轮' } = {}) {
  L.resetSeq(0);
  const evs = [
    ...L.sessionHeader(lab.sid, createdAt),
    L.turnStart(1, turnMs),
    L.userMsg(text, turnMs + 1),
    L.ev('tool/call', { turn: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'echo hi' }) }, turnMs + 2),
    L.ev('tool/result', { turn: 1, message: { role: 'tool', content: [{ type: 'text', text: 'hi' }], isError: false }, sourceEventSeqs: [] }, turnMs + 3),
    L.turnEnd(1, turnMs + 4000),
  ];
  return L.writeSession(lab, { events: evs }).file;
}

async function build(runner) {
  // ==========================================================================
  // P1-1 · 台账记完整文件哈希；“绑定”须复核实际文件（异常不得显示 bound）
  // ==========================================================================
  runner.add({
    id: 'P1-1', criteria: ['P1-1'], title: '台账记完整文件哈希；原文被改动后“绑定”必须复核为异常',
    async fn() {
      const lab = L.mkLab('p1-1');
      writeOneTurn(lab);
      await L.runOnce(PLUGIN, lab, { weeklyEnabled: false });
      const rows = await rowsOf(lab);
      expect(rows.length === 1, `前置失败：应入账 1 行（实际 ${rows.length}）`);
      const rec = rows[0];
      const origPath = path.join(lab.root, rec.doc);
      expect(fs.existsSync(origPath), '前置失败：原文不存在');
      const fullHash = L.shaFile(origPath);
      const key = ['docFileSha256', 'docFileHash', 'fileHash', 'fullFileHash'].find((k) => typeof rec[k] === 'string' && /^[0-9a-f]{64}$/.test(rec[k]));
      expect(key, `★ P1-1 不成立：台账没有完整文件哈希字段（字段=${JSON.stringify(Object.keys(rec))}）`);
      expectEqual(rec[key], fullHash, '★ P1-1 不成立：台账完整文件哈希不等于实际整文件 sha256');
      // 篡改原文（模拟"当前文件与台账不一致"）
      fs.appendFileSync(origPath, '\n（人为追加的篡改行）\n');
      const I = await L.impl(PLUGIN);
      const resolved = I.wk.resolveDoc(lab.root, rec, 480);
      L.rmLab(lab);
      expect(resolved && resolved.state !== 'bound', `★ P1-1 不成立：原文被改后仍显示“绑定”（resolveDoc.state=${JSON.stringify(resolved && resolved.state)}）—— 绑定必须复核实际文件`);
      return `台账含完整文件哈希 ${key}=${fullHash.slice(0, 12)}…；原文篡改后 resolveDoc.state=${resolved && resolved.state}（不再是 bound）`;
    },
  });

  // ==========================================================================
  // P1-2 · append 前补尾换行 + 批次末 fsync + 坏行 quarantine 上报
  // ==========================================================================
  runner.add({
    id: 'P1-2', criteria: ['P1-2'], title: 'append 前补尾换行；坏行移 quarantine 并上报（不得静默）',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p1-2');
      const dir = path.join(lab.root, 'ledger');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '2026-11-08.jsonl');
      const first = JSON.stringify({ v: 3, code: '20261108-v05test00000-A-00000001', ts: '2026-11-08T10:00:00+08:00', sid: 's', turn: 1, seq: 1, status: 'ok' });
      fs.writeFileSync(file, first); // 故意不带结尾换行
      const rec2 = { v: 3, code: '20261108-v05test00000-A-00000002', ts: '2026-11-08T10:01:00+08:00', sid: 's', turn: 2, seq: 2, status: 'ok' };
      let appendInfo = null;
      try { appendInfo = I.led.appendTurn(lab.root, rec2, new Set()); } catch (e) { throw new Error('appendTurn 抛异常：' + e.message); }
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n').filter((x) => x.trim());
      const parsed = lines.map((x) => JSON.parse(x)); // 若粘连会抛
      expectEqual(parsed.length, 2, `★ P1-2 不成立：缺尾换行时 append 后应能解析出 2 行（实际 ${parsed.length} 行；粘连则 JSON.parse 失败）`);
      expect(text.endsWith('\n'), '★ P1-2 不成立：append 后文件不以换行结尾');
      const padInfo = appendInfo && (appendInfo.padded !== undefined ? appendInfo.padded : appendInfo.padNewline);
      // 坏行 quarantine：显式调用带 quarantine 选项的读取
      fs.appendFileSync(file, '{"坏行": 没有闭合\n');
      let readRes = null;
      let readErr = null;
      try { readRes = I.led.readAll(lab.root, { quarantine: true }); } catch (e) { readErr = e; }
      const qDir = path.join(dir, '.quarantine');
      const qFiles = fs.existsSync(qDir) ? fs.readdirSync(qDir) : [];
      const reported = !!(readRes && (readRes.badLines > 0 && Array.isArray(readRes.badLineDetails) && readRes.badLineDetails.length > 0));
      const detailOk = !!(readRes && readRes.badLineDetails && readRes.badLineDetails[0] && Number.isInteger(readRes.badLineDetails[0].lineNo) && /^[0-9a-f]{64}$/.test(String(readRes.badLineDetails[0].sha256)));
      L.rmLab(lab);
      expect(padInfo !== undefined || parsed.length === 2, '★ P1-2 不成立：append 没有尾换行补偿语义（appendInfo.padded 缺失）');
      expect(reported, '★ P1-2 不成立：坏行没有被上报（readAll 未返回 badLines/readErrors/badLineDetails）');
      expect(readErr === null, '★ P1-2 不成立：quarantine 读取直接抛异常（应结构化返回）：' + (readErr && readErr.message));
      expect(qFiles.length > 0, `★ P1-2 不成立：坏行没有落取证副本 <root>/ledger/.quarantine/（目录=${qDir} 文件=${JSON.stringify(qFiles)}）`);
      expect(detailOk, '★ P1-2 不成立：badLineDetails 缺少行号/sha256（无法定位与复算）');
      return `尾换行补偿=${padInfo}；坏行上报=${reported}；quarantine 文件=${qFiles.length}（行号+sha256 可定位）`;
    },
  });

  // ==========================================================================
  // P1-3 · initialized 必须看 deferred
  // ==========================================================================
  runner.add({
    id: 'P1-3', criteria: ['P1-3'], title: '首跑被预算截断（deferred>0）时 initialized 必须为 false',
    async fn() {
      const lab = L.mkLab('p1-3');
      // 两个会话：第一个较大，使 scanBudgetMs=1 时第二个来不及处理
      const mk = (sid, n) => {
        L.resetSeq(0);
        const evs = [...L.sessionHeader(sid, L.T0())];
        for (let t = 1; t <= n; t += 1) evs.push(...L.simpleTurn(t, L.T0() + t * 10_000));
        L.writeSession(lab, { sid, events: evs });
      };
      mk(lab.sid, 60);
      mk('session-v05test009999-1111-2222-3333-444444444444', 2);
      const r1 = await L.runOnce(PLUGIN, lab, { scanBudgetMs: 1, weeklyEnabled: false });
      const st = await stateOf(lab);
      if (!(r1.stat.deferred > 0)) skip(`未触发预算截断（deferred=0，前置不成立）：scanBudgetMs=1 时两个会话都在预算内完成；无法验证 P1-3（本轮按未覆盖处理）`);
      L.rmLab(lab);
      expect(st.initialized === false, `★ P1-3 不成立：首跑 deferred=${r1.stat.deferred} 被预算截断，但 state.initialized=${JSON.stringify(st.initialized)}（应为 false，否则剩余老会话会被热窗口永久挡掉）`);
      return `首跑 deferred=${r1.stat.deferred} → state.initialized=false（下轮仍会全量扫描）`;
    },
  });

  // ==========================================================================
  // P1-4 · 停机超窗口 → cutoff = min(hotWindow, lastRunAt − 2×interval)
  // ==========================================================================
  runner.add({
    id: 'P1-4', criteria: ['P1-4'], title: '停机超热窗口后，期间变动过的会话不得被永久漏记',
    async fn() {
      const lab = L.mkLab('p1-4');
      writeOneTurn(lab, { text: '第一轮：建立 state' });
      await L.runOnce(PLUGIN, lab, { weeklyEnabled: false });
      // 把 state.lastRunAt 伪造成 2 天前（模拟停机 2 天）
      const stPath = path.join(lab.root, 'ledger', '.state.json');
      const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
      st.lastRunAt = new Date(Date.now() - 2 * 86400_000).toISOString();
      fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
      // 新会话：文件 mtime 设为 1 天前（老于 hotWindow=3600s，但落在停机缺口内）
      const sid2 = 'session-v05test008888-1111-2222-3333-444444444444';
      L.resetSeq(0);
      L.writeSession(lab, { sid: sid2, events: [...L.sessionHeader(sid2, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const old = Date.now() - 86400_000;
      fs.utimesSync(lab.file, new Date(old), new Date(old));
      const r2 = await L.runOnce(PLUGIN, lab, { weeklyEnabled: false, hotWindowSeconds: 3600 });
      const rows = await rowsOf(lab);
      const got = rows.some((r) => r.sid === sid2);
      L.rmLab(lab);
      expect(got, `★ P1-4 不成立：停机 2 天期间产生的会话（mtime=1 天前）没有入账（scanned=${r2.stat.scanned} hotWindowExtended=${r2.stat.hotWindowExtended}；台账 sid=${JSON.stringify([...new Set(rows.map((r) => r.sid))])}）`);
      return `停机缺口兜底生效：第 2 轮 scanned=${r2.stat.scanned}、hotWindowExtended=${r2.stat.hotWindowExtended}，新会话已入账`;
    },
  });

  // ==========================================================================
  // P1-5 · failed>0 不推进游标 + 永久错误清单
  // ==========================================================================
  runner.add({
    id: 'P1-5', criteria: ['P1-5'], title: '坏帧（failed>0）不得推进游标，必须落永久错误清单',
    async fn() {
      const lab = L.mkLab('p1-5');
      L.resetSeq(0);
      const file = L.writeSession(lab, { events: [...L.sessionHeader(lab.sid, L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] }).file;
      // 文件尾追加一个"坏帧"（zstd 魔数 + 垃圾）
      fs.appendFileSync(file, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('this-is-not-a-zstd-frame')]));
      const size = fs.statSync(file).size;
      const r = await L.runOnce(PLUGIN, lab, { weeklyEnabled: false });
      const st = await stateOf(lab);
      const cursors = st.sourceCursors || {};
      const cur = Object.entries(cursors).find(([k]) => k.endsWith(file.split(path.sep).pop()))?.[1];
      const ledgerFiles = L.listFiles(path.join(lab.root, 'ledger')).map((f) => f.rel);
      const errorListing = ledgerFiles.some((n) => /error|lost|bad/i.test(n));
      L.rmLab(lab);
      const failedFrames = r.stat.failedFrames || r.stat.badFrames || 0;
      expect(failedFrames > 0 || errorListing, `前置不成立：坏帧没有被识别（failedFrames=${failedFrames}，errors=${JSON.stringify(r.stat.errors).slice(0, 200)}）`);
      expect(errorListing, '★ P1-5 不成立：failed>0 没有落永久错误清单（ledger/ 下无 .lost/.errors 类文件）');
      expect(cur && Number(cur.offset) < size, `★ P1-5 不成立：坏帧后仍把游标推进到文件末尾（offset=${cur && cur.offset}/${size}）—— 该帧轮次会永久丢失`);
      return `坏帧留痕=${errorListing}；游标=${cur && cur.offset}/${size}（未推进到末尾）；failedFrames=${failedFrames}`;
    },
  });

  // ==========================================================================
  // P1-7 · 交接表接线进扫描循环（先 adopt 后 generate），失败只记 errors
  // ==========================================================================
  runner.add({
    id: 'P1-7', criteria: ['P1-7'], title: '交接表在扫描循环内生成（先 adopt 后 generate），失败只记 errors',
    async fn() {
      const lab = L.mkLab('p1-7');
      writeOneTurn(lab);
      const r = await L.runOnce(PLUGIN, lab, { weeklyEnabled: false, handoverEnabled: true });
      const arts = L.walkArtifacts(lab.root);
      const mains = arts.filter((a) => /的记忆数据库的启用及交接表\.md$/.test(a.rel));
      const apps = arts.filter((a) => /——附表\.md$/.test(a.rel));
      L.rmLab(lab);
      expect(mains.length === 1 && apps.length === 1, `★ P1-7 不成立：扫描循环没有生成交接表主表/附表（main=${mains.length} appendix=${apps.length}；errors=${JSON.stringify(r.stat.errors).slice(0, 200)}）`);
      expect((r.stat.handoverGenerated || 0) >= 1, '★ P1-7 不成立：stat 未报告 handoverGenerated');
      return `扫描循环内生成交接表：main=${mains.length} appendix=${apps.length}，handoverGenerated=${r.stat.handoverGenerated}`;
    },
  });

  // ==========================================================================
  // P1-8 · 读取失败必须结构化报错；空数据只能由成功读取证明
  // ==========================================================================
  runner.add({
    id: 'P1-8', criteria: ['P1-8'], title: '台账不可读时不得静默返回空；必须 ok=false + readErrors',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p1-8');
      const dir = path.join(lab.root, 'ledger');
      fs.mkdirSync(dir, { recursive: true });
      // 造一个"读取必失败"的账文件：同名位置放目录（EISDIR）
      fs.mkdirSync(path.join(dir, '2026-11-09.jsonl'));
      fs.writeFileSync(path.join(dir, '2026-11-08.jsonl'), JSON.stringify({ v: 3, code: '20261108-v05test00000-A-00000001', ts: '2026-11-08T10:00:00+08:00', sid: 's', turn: 1, seq: 1, status: 'ok' }) + '\n');
      const res = I.led.readAll(lab.root);
      L.rmLab(lab);
      expect(res && res.ok === false, '★ P1-8 不成立：读取失败仍返回成功（ok!==false）—— 空数据/坏数据只能由成功读取证明');
      expect(Array.isArray(res.readErrors) && res.readErrors.length > 0, `★ P1-8 不成立：读取失败没有结构化 readErrors（keys=${JSON.stringify(Object.keys(res || {}))}）`);
      const e0 = res.readErrors[0] || {};
      expect(e0.file && e0.code, `★ P1-8 不成立：readErrors 缺少 file/code 字段（${JSON.stringify(e0)}）`);
      return `不可读账文件 → ok=false，readErrors=${JSON.stringify(res.readErrors).slice(0, 200)}`;
    },
  });

  // ==========================================================================
  // P1-9 · 运行缓存与封板证据分离（追加式 seal journal；state 丢失只影响性能）
  // ==========================================================================
  runner.add({
    id: 'P1-9', criteria: ['P1-9'], title: '封板证据在追加式 journal（不靠 state）；删 state 后证据仍在、封板仍生效',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p1-9');
      const recs = Array.from({ length: 3 }, (_, i) => ({
        v: 3, code: `20261109-v05test00000-A-${String(i + 1).padStart(8, '0')}`,
        ts: `2026-11-09T10:0${i}:00+08:00`, sid: 's', turn: i + 1, seq: i + 1, status: 'ok', doc: '/x.md', docHash: 'a'.repeat(64),
      }));
      const groups = I.wk.groupRecords(recs, 480);
      const g = [...groups.values()][0];
      I.wk.writeWeekly({ root: lab.root, w: g.w, sessKey: g.sessKey, records: g.records, offsetMinutes: 480, prevHashes: {}, mode: 'sealed', nowMs: Date.parse('2026-11-10T10:00:00+08:00') });
      const journalPath = path.join(lab.root, 'ledger', '.seal-journal.jsonl');
      expect(fs.existsSync(journalPath), '★ P1-9 不成立：封板证据只存在 state 里（没有追加式 seal journal）');
      const j1 = L.shaFile(journalPath);
      // 删 state（模拟 state 丢失）
      const stPath = path.join(lab.root, 'ledger', '.state.json');
      if (fs.existsSync(stPath)) fs.unlinkSync(stPath);
      const res2 = I.wk.writeWeekly({ root: lab.root, w: g.w, sessKey: g.sessKey, records: g.records, offsetMinutes: 480, prevHashes: {}, mode: 'sealed', nowMs: Date.parse('2026-11-10T11:00:00+08:00') });
      const j2 = L.shaFile(journalPath);
      const sealedByFile = !!(res2 && res2.skipped === true && res2.reason === 'sealed');
      L.rmLab(lab);
      expectEqual(j2, j1, '★ P1-9 不成立：state 丢失后封板证据被改写/追加');
      expect(sealedByFile, `★ P1-9 不成立：state 丢失后封板不再生效（res2.skipped=${res2 && res2.skipped} reason=${res2 && res2.reason}）—— 证据应只依赖 journal/文件`);
      return `seal journal 存在且 state 丢失后不变（sha256=${j1.slice(0, 12)}…）；封板仍 skip`;
    },
  });

  // ==========================================================================
  // P1-10 · “已清理”判定按结论列（不看任意单元格）
  // ==========================================================================
  runner.add({
    id: 'P1-10', criteria: ['P1-10'], title: '清册解析只认“结论列=已删除”；备注里写已删除不得误判',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p1-10');
      const dir = path.join(lab.root, '2026年10月', '10月总“完整原文”');
      fs.mkdirSync(dir, { recursive: true });
      const codeA = '20261001-v05test00000-A-00000001'; // 结论=未删除，备注=已删除
      const codeB = '20261001-v05test00000-A-00000002'; // 结论=已删除，备注=正常
      fs.writeFileSync(path.join(lab.root, 'RPT-20261002-01.md'), [
        '# 清册（P1-10 夹具）', '',
        '| # | 编码 | 产生时间 | 结论 | 备注 |',
        '| --- | --- | --- | --- | --- |',
        `| 1 | ${codeA} | 2026-10-01 10:00:00 | 未删除 | 已删除 |`,
        `| 2 | ${codeB} | 2026-10-01 10:00:00 | 已删除 | 正常 |`,
        '',
      ].join('\n'));
      const map = I.wk.readCleanedCodesCompat(lab.root);
      L.rmLab(lab);
      expect(!map.has(codeA), `★ P1-10 不成立：结论=未删除/备注=已删除 的编码被误判为已清理（任意单元格匹配）`);
      expect(map.has(codeB), '★ P1-10 不成立：结论=已删除 的编码没有被识别');
      return `只认结论列：未删除行未入 Map、已删除行入 Map（${[...map.keys()].join(',')}）`;
    },
  });

  // ==========================================================================
  // P1-11 · 周记账列结构对齐契约（十列；四态在原文列；RPT 号不写备注）
  // ==========================================================================
  runner.add({
    id: 'P1-11', criteria: ['P1-11'], title: '周记账：9 sheet / 十列 / 四态在 B 列 / RPT 号不写备注',
    async fn() {
      if (!fs.existsSync(XLSX_PROBE) || !fs.existsSync(PY)) skip('前置缺失：openpyxl 探针脚本或 python 不存在（未覆盖原因：环境缺 openpyxl）');
      const lab = L.mkLab('p1-11');
      writeOneTurn(lab);
      await L.runOnce(PLUGIN, lab, { weeklyEnabled: true });
      const xlsx = L.listFiles(lab.root).filter((f) => f.rel.endsWith('.xlsx')).map((f) => f.abs);
      expect(xlsx.length === 1, `前置失败：应有 1 个周记账 xlsx（实际 ${xlsx.length}）`);
      const outJson = path.join(lab.base, 'probe.json');
      const r = spawnSync(PY, [XLSX_PROBE, outJson, xlsx[0]], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 60_000 });
      expect(r.status === 0 && fs.existsSync(outJson), `前置失败：openpyxl 探针失败（status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}）`);
      const fact = JSON.parse(fs.readFileSync(outJson, 'utf8'))[0];
      const dayFacts = fact.sheets.filter((s) => /^周[一二三四五六日]$/.test(s.name));
      const header = dayFacts[0] && dayFacts[0].headers;
      const expectedHeader = ['编码', '原始凭证', '时间', '角色', '对话内容摘要', 'User的文件引用与Agent文件输出', '输出文件位置', '状态', '用户审计', '备注'];
      const rows = dayFacts.flatMap((f) => f.rows || []);
      const badB = rows.filter((row) => !/^(绑定|补记|缺凭证|已清理\(RPT-\d{8}-\d{2}\))$/.test(String(row.B)));
      const rptInNote = rows.filter((row) => String(row.J || '').includes('RPT-'));
      const rptInAnyHuman = rows.filter((row) => ['D', 'E', 'F', 'G', 'I', 'J'].some((k) => String(row[k] || '').includes('RPT-')));
      L.rmLab(lab);
      expectEqual(fact.sheetOrder.length, 9, `★ P1-11 不成立：sheet 数=${fact.sheetOrder.length}（应 9）`);
      expect(JSON.stringify(header) === JSON.stringify(expectedHeader), `★ P1-11 不成立：十列表头不符（实际=${JSON.stringify(header)}）`);
      expect(badB.length === 0, `★ P1-11 不成立：原始凭证列出现非四态值（${JSON.stringify(badB.slice(0, 3).map((r) => r.B))}）`);
      expect(rptInNote.length === 0 && rptInAnyHuman.length === 0, `★ P1-11 不成立：RPT 号写进了人工列/备注（${JSON.stringify(rptInAnyHuman.slice(0, 3))}）`);
      return `9 sheet、十列表头逐字、B 列四态、人工列无 RPT 号（行数=${rows.length}）`;
    },
  });

  // ==========================================================================
  // P1-12 · 原文目录按编码日期段取月（不是轮发生月）
  // ==========================================================================
  runner.add({
    id: 'P1-12', criteria: ['P1-12'], title: '跨月会话的原文目录按“编码日期段（会话开始日）”取月，不按轮发生月',
    async fn() {
      const lab = L.mkLab('p1-12');
      // 会话开始：2026-10-31 23:00；轮发生在 2026-11-01 00:10（跨月）
      const createdAt = Date.parse('2026-10-31T23:00:00+08:00');
      const turnAt = Date.parse('2026-11-01T00:10:00+08:00');
      L.resetSeq(0);
      L.writeSession(lab, {
        events: [
          ...L.sessionHeader(lab.sid, createdAt),
          L.turnStart(1, turnAt), L.userMsg('跨月的一轮', turnAt + 1), L.turnEnd(1, turnAt + 2000),
        ],
      });
      await L.runOnce(PLUGIN, lab, { weeklyEnabled: false });
      const rows = await rowsOf(lab);
      expect(rows.length === 1, `前置失败：应入账 1 行（实际 ${rows.length}）`);
      const docRel = String(rows[0].doc || '');
      const code = String(rows[0].code || '');
      const codeMonth = `2026年${code.slice(4, 6)}月`;
      L.rmLab(lab);
      expect(code.startsWith('20261031'), `前置：编码日期段应为会话开始日 20261031（实际 code=${code}）`);
      expect(docRel.startsWith(codeMonth), `★ P1-12 不成立：原文目录按轮发生月（doc=${docRel}），应按编码日期段取月 ${codeMonth}/`);
      return `跨月会话：编码日期段=${code.slice(0, 8)} → 原文目录=${docRel.split(path.sep).slice(0, 1).join('')}`;
    },
  });
}

await main(import.meta.url, {
  name: 'P1 十二条',
  target: PLUGIN,
  build,
});
