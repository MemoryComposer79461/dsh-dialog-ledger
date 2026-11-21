/**
 * @file P0回归-v2.mjs（勘误版 · 取代桌面原稿 `施工方向-P0回归测试-20261109.mjs`）
 * @role P0 七条不变量的「能失败的测试」；另补 P0-3、P1-6、REC 三条核心。
 *
 * ★ 三处勘误（Lead 2026-11-09 裁定，原稿保留归档、不改）：
 *
 *   ① **P0-2 原稿是假绿**：原脚本只跑两轮就补 turn/end，而 partial 落盘需要
 *      「两轮确认（文件大小不变）」。它在"还没写 partial"时就补了 end，通过得毫无意义。
 *      本文件按 `P0验收/探针-a01-partial.mjs` 的**三轮语义**重写：
 *        run1 建游标 → run2 文件未变（应落 partial）→ run3 源里补 turn/end，
 *      断言「恰好一个已闭合版本；旧 partial 若保留必须标'被取代'」。
 *
 *   ② **P0-7① 原稿夹具错**：原脚本用 `markdown:'# 第一版\n'`（无正文锚点 `## 1.`），
 *      `writeOriginal` 先以 `ORIGINAL_NO_BODY` 拒绝，**根本没测到覆盖逻辑**。
 *      本文件用**合法 markdown**（19 键 YAML + `## 1.` 正文锚点）测「同码不同正文」。
 *
 *   ③ **P0-7③ 判据依赖契约 D9**：原稿「坏 sid 必须进 errors」是 v1.3 契约外的新要求。
 *      本文件先按「必须进 errors **且留痕**」写，并标注【依赖 D9 定稿】；
 *      若 D9 最终改写该语义，本用例需同步修订。
 *
 * 资源纪律（Lead）：一次只跑一个测试文件；跑前打印可用内存；<0.5GB 只写不跑；
 *   36MB 会话用自合成（`docs/验收-v0.5/生成大会话.mjs`），不用真实 38MB 素材。
 *
 * 用法：
 *   node P0验收/P0回归-v2.mjs [--out=docs/验收-v0.5/_results/P0.json] [--only=P0-1,P0-2]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ★ 勘误 ④（Lead 2026-11-09 夜）：Node ≥19 的**全局** `crypto` 是 WebCrypto，
//   只有 getRandomValues，没有 `randomBytes` → P0-1b 直接 "crypto.randomBytes is not a function"（ERROR，非实现失败）。
//   必须显式 import node:crypto。
import crypto from 'node:crypto';

import { main, expect, expectEqual, expectIncludes, freeMemMB, skip } from '../docs/验收-v0.5/_runner.mjs';
import * as L from '../docs/验收-v0.5/_lab.mjs';
import { generateBigSession, verifyBigSession } from '../docs/验收-v0.5/生成大会话.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');                       // v0.5-工作副本
const DOCS = path.join(PLUGIN, 'docs', '验收-v0.5');
const CHILD = path.join(DOCS, '_child-ingest.mjs');
const BIG_FILE = path.join(os.tmpdir(), 'v05-gen', 'session.v4.jsonl.zstd');
const ANCHOR = path.join(os.tmpdir(), 'v05-anchor-receipts'); // 收据锚（库外）
const RESOURCE_GUARD_MB = 900; // Lead 新增内存护栏：低于此只跑小样本（36MB 档留异机/重启后）

const sidOf = (lab) => lab.sid;
const sha = L.shaFile;
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成（或复用）36MB 合成会话，并流式校验。 */
function ensureBigSession() {
  if (fs.existsSync(BIG_FILE)) {
    const v = verifyBigSession({ file: BIG_FILE });
    if (v.ok) return { reused: true, verify: v };
  }
  const gen = generateBigSession({ out: BIG_FILE, turns: 1000, targetMB: 36, batchTurns: 10 });
  const verify = verifyBigSession({ file: BIG_FILE });
  return { reused: false, gen, verify };
}

/** 生成/复用任意 MB 档的合成会话（压测 1/4/16/36 同构）。 */
function ensureTierSession(mb) {
  const file = path.join(os.tmpdir(), 'v05-gen', `session-${mb}mb.v4.jsonl.zstd`);
  if (fs.existsSync(file)) {
    const v = verifyBigSession({ file, minTurns: 0, minMB: mb });
    if (v.ok) return { reused: true, file, verify: v };
  }
  const gen = generateBigSession({ out: file, targetMB: mb, batchTurns: 10 });
  const verify = verifyBigSession({ file, minTurns: 0, minMB: mb });
  return { reused: false, file, gen, verify };
}

/** 把 36MB 合成会话复制进实验室的 sessions（压缩后只有 ~115KB）。 */
function copyBigIntoLab(lab) {
  const dir = path.join(lab.sessions, 'wsBig', 'session-bigv05-0000-1111-2222-333344445555');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'session.v4.jsonl.zstd');
  fs.copyFileSync(BIG_FILE, dst);
  lab.file = dst;
  return dst;
}

/** 跑 node 子进程（可设 heap 上限/超时）。 */
function spawnNode(args, { heapMB = 0, timeoutMs = 180_000 } = {}) {
  const nodeArgs = [...(heapMB > 0 ? [`--max-old-space-size=${heapMB}`] : []), ...args];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, nodeArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, killedByTimeout: killed, durationMs: Date.now() - t0, pid: child.pid });
    });
  });
}

/** 读台账里某轮的记录（不经过被测代码的筛选逻辑，直接用 ledger.readAll）。 */
async function ledgerRows(lab) {
  const r = await L.readLedger(PLUGIN, lab.root);
  return r.records;
}

function hasSupersededMark(row) {
  if (!row) return false;
  const status = String(row.status || '');
  if (/supersed|replac/i.test(status)) return true;
  for (const k of ['superseded', 'supersededBy', 'replacedBy', 'supersededAt', 'replacedAt', 'supersedesReason']) {
    if (row[k]) return true;
  }
  return false;
}

/** REC 用：造两天的台账文件（合法 JSONL 行）。 */
function writeLedgerDays(root, days) {
  const dir = path.join(root, 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  for (const [date, rows] of Object.entries(days)) {
    fs.writeFileSync(path.join(dir, `${date}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
}
function ledgerRow(code, ts, doc = '2026年11月/11月总“完整原文”/x.md') {
  return { v: 3, code, ts, sid: 'session-v05test000001-x', turn: 1, seq: 1, status: 'ok', src: 'session.v4.jsonl.zstd', doc, docHash: 'a'.repeat(64), dateOffset: 480 };
}
const CODE1 = '20261108-v05test00000-A-00000001';
const CODE2 = '20261109-v05test00000-A-00000002';

async function build(runner) {
  // ==========================================================================
  // P0-1 · 源文件缩小 / 同大小重写 → 新 Turn 必须被读到
  // ==========================================================================
  runner.add({
    id: 'P0-1', criteria: ['P0-1'], title: '源文件缩小后，新 Turn 必须入账（不得走 unchanged 快路径）',
    async fn() {
      const lab = L.mkLab('p0-1');
      L.resetSeq(0);
      const bigEvents = [...L.sessionHeader(sidOf(lab), L.T0())];
      bigEvents.push(L.turnStart(1, L.T0()));
      bigEvents.push(L.userMsg('第一轮『'.repeat(1) + '第一轮'.repeat(1200), L.T0() + 1));
      for (let i = 0; i < 400; i += 1) bigEvents.push(L.ev('step/start', { turn: 1, step: i }, L.T0() + 2 + i));
      bigEvents.push(L.turnEnd(1, L.T0() + 5000));
      L.writeSession(lab, { events: bigEvents });
      const bigSize = fs.statSync(lab.file).size;

      const r1 = await L.runOnce(PLUGIN, lab);
      let rows = await ledgerRows(lab);
      expect(rows.some((r) => r.turn === 1), '前置失败：Turn 1 未入账');

      // 第二版：更小的文件，含新的 Turn 2
      L.resetSeq(0);
      const smallEvents = [
        ...L.sessionHeader(sidOf(lab), L.T0()),
        L.turnStart(2, L.T0() + 6000),
        L.userMsg('第二轮（缩小后重写）', L.T0() + 6001),
        L.turnEnd(2, L.T0() + 7000),
      ];
      L.writeSession(lab, { events: smallEvents });
      const smallSize = fs.statSync(lab.file).size;
      expect(smallSize < bigSize, `前置失败：替换后的文件必须更小（${bigSize} → ${smallSize}）`);

      const r2 = await L.runOnce(PLUGIN, lab);
      rows = await ledgerRows(lab);
      const ok = rows.some((r) => r.turn === 2);
      L.rmLab(lab);
      expect(ok, `★ P0-1 未修复：源文件缩小后仍在 unchanged 快路径（written=${r2.stat.written} unchanged=${r2.stat.unchanged}），Turn 2 未入账；证据：台账 turns=${JSON.stringify(rows.map((r) => r.turn))}`);
    },
  });

  // P0-1b · 同大小重写（内容变了、字节数不变）也必须被读到
  runner.add({
    id: 'P0-1b', criteria: ['P0-1'], title: '同大小重写（内容变、字节数不变）→ 新 Turn 必须入账',
    async fn() {
      const lab = L.mkLab('p0-1b');
      // ① 构造模板：V1（turn1+filler 前缀）与 V2（额外 turn2）由同一模板生成。
      //    ★ 勘误 ⑨（2026-11-10 夜）：原实现"二分 + ±500 邻域碰运气"在 zstd 尺寸非严格单调时会
      //      配不中 → 夹具假红（P0 门偶发 FAIL，两次实测均为此因）。现改为**确定性尺寸表配对**：
      //      先扫 V1 全尺寸表（只压缩不写盘），再扫 V2 找交集；找到即可保证 V1/V2 字节数完全相同。
      const filler = crypto.randomBytes(12000).toString('base64'); // 高熵填充，尺寸随长度变化
      const buildEvents = (nChars, withTurn2) => {
        L.resetSeq(0);
        const evs = [
          ...L.sessionHeader(sidOf(lab), L.T0()),
          L.turnStart(1, L.T0()), L.userMsg('seed', L.T0() + 1),
          L.ev('user/message', { content: [{ type: 'text', text: filler.slice(0, nChars) }], source: { kind: 'user' }, role: 'user' }, L.T0() + 2),
          L.turnEnd(1, L.T0() + 5000),
        ];
        if (withTurn2) {
          evs.push(
            L.turnStart(2, L.T0() + 6000), L.userMsg('唯一的新内容 turn2', L.T0() + 6001), L.turnEnd(2, L.T0() + 7000),
          );
        }
        return evs;
      };
      const sizeOf = (events) => L.frame(events.map((e) => JSON.stringify(e))).length;
      const v1SizeToN = new Map();
      for (let n = 0; n <= filler.length; n += 1) {
        const s = sizeOf(buildEvents(n, false));
        if (!v1SizeToN.has(s)) v1SizeToN.set(s, n);
      }
      let hit = null;
      for (let n = 0; n <= filler.length; n += 1) {
        const s = sizeOf(buildEvents(n, true));
        if (v1SizeToN.has(s)) { hit = { n1: v1SizeToN.get(s), n2: n, size: s }; break; }
      }
      expect(hit, '夹具构造失败：V1/V2 尺寸表无交集（filler.length=' + filler.length + '）——不允许跳过（跳过=判据没跑）');
      const targetSize = hit.size;

      // ② 第一版：写 V1 并确认 turn1 入账。
      L.writeSession(lab, { events: buildEvents(hit.n1, false) });
      expect(fs.statSync(lab.file).size === targetSize, '夹具自检：V1 实测尺寸与尺寸表不一致');
      await L.runOnce(PLUGIN, lab);
      let rows = await ledgerRows(lab);
      expect(rows.some((r) => r.turn === 1), '前置失败：Turn 1 未入账');

      // ③ 第二版：同字节数、含 turn2；必须被识别为变化并让新 Turn 入账。
      L.writeSession(lab, { events: buildEvents(hit.n2, true) });
      expect(fs.statSync(lab.file).size === targetSize, '夹具自检：V2 必须与 V1 字节数完全相同');
      const r = await L.runOnce(PLUGIN, lab);
      rows = await ledgerRows(lab);
      const ok = rows.some((x) => x.turn === 2);
      L.rmLab(lab);
      expect(ok, `★ P0-1（同大小重写）未修复：文件字节数相同（${targetSize}B）但内容已变，仍走 unchanged 快路径（written=${r.stat.written} unchanged=${r.stat.unchanged}），Turn 2 未入账`);
    },
  });

  // ==========================================================================
  // P0-1c · 缩小后又长回**原字节数**（M4 变异反证点）
  //
  //   A-02 的真实形态不是"缩了就完事"，而是：文件被压缩/重写变小 → 之后又写入新轮，
  //   而总字节数**刚好回到旧值**、头部前缀也**完全没变**。
  //   此时唯一能拦住 unchanged 快路径的就是"大小必须**相等**"这条守卫；
  //   一旦放宽成 `prev.size >= s.size`（旧实现），新 Turn 会被永久当成"没变化"漏掉。
  //
  //   构造：A = 头帧 + turn1 帧 + turn2 帧（总 S 字节）
  //        B = 头帧 + turn1 帧（更小，S2 = S - |turn2 帧|）
  //        C = B + turn3 帧，调 turn3 载荷长度让 |C| **正好等于 S**
  //   → 只有正确实现（size 严格相等才跳过）能在 C 之后记到 turn3。
  // ==========================================================================
  runner.add({
    id: 'P0-1c', criteria: ['P0-1'], title: '缩小后又长回原字节（尾部换成新 Turn）→ 不许走 unchanged 快路径',
    async fn() {
      const lab = L.mkLab('p0-1c');
      const filler = crypto.randomBytes(2000).toString('base64');
      const blob = crypto.randomBytes(4000).toString('base64');
      const header = L.sessionHeader(sidOf(lab), L.T0());
      L.resetSeq(0);
      const t1 = [
        L.turnStart(1, L.T0()),
        L.userMsg('第一轮 ' + filler, L.T0() + 1),
        L.turnEnd(1, L.T0() + 2000),
      ];
      const t2 = [
        L.turnStart(2, L.T0() + 3000),
        L.userMsg('第二轮 ' + filler.slice(0, 600), L.T0() + 3001),
        L.turnEnd(2, L.T0() + 4000),
      ];

      // A
      L.writeSession(lab, { events: header, eventsPerFrame: 1 });
      L.appendFrame(lab.file, t1);
      L.appendFrame(lab.file, t2);
      const S = fs.statSync(lab.file).size;
      // ★ 头指纹窗口必须是**小**的：默认 4096 字节会把整个小文件都算进指纹，
      //   A 与 C 的第 3 帧不同 → 指纹不同 → 变异版本也会被"身份变了"救活，测不出真问题。
      //   压到 256 字节后，指纹只覆盖"头帧"，A/B/C 完全一致 —— 这才是 A-02 的形态。
      const cfg = { headFingerprintBytes: 256 };
      await L.runOnce(PLUGIN, lab, cfg);
      let rows = await ledgerRows(lab);
      expect(
        rows.some((r) => r.turn === 1) && rows.some((r) => r.turn === 2),
        '前置失败：turn1/turn2 未入账'
      );

      // B：截掉尾帧（变小，前缀不变）
      L.writeSession(lab, { events: header, eventsPerFrame: 1 });
      L.appendFrame(lab.file, t1);
      const S2 = fs.statSync(lab.file).size;
      expect(S2 < S, `夹具前提：B 必须比 A 小（S=${S} S2=${S2}）`);
      await L.runOnce(PLUGIN, lab);

      // C：在 B 上追加**新的一轮**（turn 3），总字节仍**不超过** A。
      // ★ 口径修正（2026-11-09）：变异体的条件是 `prev.size >= s.size`，
      //   所以只要"新文件不比旧游标记的大小更大"，就会被误判成"没变化"——
      //   **不需要**精确等于旧字节（上一版为了凑等长做二分调载荷，既脆又没必要）。
      //   这里用确定性构造：追加一个小轮次，保证 S2 < |C| ≤ S。
      L.writeSession(lab, { events: header, eventsPerFrame: 1 });
      L.appendFrame(lab.file, t1);
      L.resetSeq(3);
      const t3 = [
        L.turnStart(3, L.T0() + 3000),
        L.userMsg('第三轮（缩小后追加）', L.T0() + 3001),
        L.turnEnd(3, L.T0() + 4000),
      ];
      L.appendFrame(lab.file, t3);
      const SC = fs.statSync(lab.file).size;
      expect(
        SC > S2 && SC <= S,
        `夹具前提不成立：需要 S2(${S2}) < |C|(${SC}) ≤ S(${S}) 才能覆盖"大小未增长"这条守卫`
      );
      const r3 = await L.runOnce(PLUGIN, lab, cfg);
      rows = await ledgerRows(lab);
      const dup = rows.filter((r) => r.turn === 1).length;
      expect(
        rows.some((r) => r.turn === 3),
        `★ P0-1 未修复：文件字节数回到旧值（${S}B）且头部未变，新 Turn 3 被当成"未变化"漏记`
        + `（written=${r3 && r3.stat && r3.stat.written} unchanged=${r3 && r3.stat && r3.stat.unchanged}）`
      );
      expect(dup === 1, `重复入账：turn1 出现 ${dup} 行`);
      L.rmLab(lab);
    },
  });

  // ==========================================================================
  // P0-2 · 三轮语义（勘误①）：partial/pending 之后补 turn/end，必须闭合为恰好一个版本
  //   v0.5 允许两种整改方案（01 文档 P0-2 改法二选一）：
  //     ① pending 方案：未闭合轮只写 pending 证据、不进最终账；闭合后写 1 条 ok 行；
  //     ② supersede 方案：保留 partial，但补 end 后必须新增 1 条闭合行，旧 partial 标"被取代"。
  //   本用例两条都认：**最终必须有恰好 1 条闭合行**；若 partial 仍在，必须有"被取代"标记。
  // ==========================================================================
  runner.add({
    id: 'P0-2', criteria: ['P0-2'], title: '三轮语义：run2 只留 pending/partial → 补 turn/end → 恰好一个闭合版本',
    async fn() {
      const lab = L.mkLab('p0-2');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(sidOf(lab), L.T0()), L.turnStart(3, L.T0()), L.userMsg('没跑完就被杀', L.T0() + 1)] });

      await L.runOnce(PLUGIN, lab);                       // ① 建游标
      await L.runOnce(PLUGIN, lab);                       // ② 文件未变（两轮确认）→ pending 或 partial
      let rows = await ledgerRows(lab);
      let turn3 = rows.filter((r) => r.turn === 3);
      const pendingPath = path.join(lab.root, 'ledger', '.pending.jsonl');
      const pendingText = fs.existsSync(pendingPath) ? fs.readFileSync(pendingPath, 'utf8') : '';
      const pendingEvidence = /"turn"\s*:\s*3|turn.?3|"turn":3/.test(pendingText) && pendingText.trim().length > 0;
      const partialWritten = turn3.some((r) => r.status === 'partial');
      expect(turn3.length <= 1, `前置失败：turn 3 出现多条（${turn3.length}）`);
      expect(partialWritten || pendingEvidence, `前置不满足：两轮确认后既没有 pending 证据（${pendingPath}）也没有 partial 台账行 → 未闭合轮次被静默丢弃（这是另一条更严重的缺陷）`);

      // ③ 源里补上 turn/end
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(sidOf(lab), L.T0()), L.turnStart(3, L.T0()), L.userMsg('没跑完就被杀', L.T0() + 1), L.turnEnd(3, L.T0() + 60000)] });
      const r3 = await L.runOnce(PLUGIN, lab);
      rows = await ledgerRows(lab);
      turn3 = rows.filter((r) => r.turn === 3);
      const closed = turn3.filter((r) => ['ok', 'completed', 'closed'].includes(String(r.status)));
      const retainedOpen = turn3.filter((r) => !['ok', 'completed', 'closed'].includes(String(r.status)));
      const unmarked = retainedOpen.filter((r) => !hasSupersededMark(r));
      L.rmLab(lab);
      expectEqual(closed.length, 1, `★ P0-2 未修复：补 turn/end 后应恰好 1 个闭合版本，实际 ${closed.length} 个（run3 written=${r3.stat.written} skipped=${r3.stat.skipped}；turn3=${JSON.stringify(turn3.map((r) => r.status))}）`);
      expectEqual(unmarked.length, 0, `★ P0-2 未修复：旧 partial 被保留但未标"已被取代"（${JSON.stringify(unmarked.map((r) => ({ status: r.status, keys: Object.keys(r).filter((k) => /supersed|replac/i.test(k)) })))}）`);
      return `三轮闭合：run2 ${partialWritten ? '写 partial' : '留 pending 证据'} → run3 闭合 1 条（closed=1）`;
    },
  });

  // ==========================================================================
  // P0-3 · 首跑有界 / 可取消 / kill -9 可续（36MB 自合成会话）
  // ==========================================================================
  runner.add({
    id: 'P0-3-mem', criteria: ['P0-3'], title: '36MB/1000 轮首跑：内存上限 ≤600MB（子进程 heap 限 320MB）',
    async fn() {
      const free = freeMemMB();
      if (free < RESOURCE_GUARD_MB) skip(`资源纪律（Lead 02-内存与验收执行纪律）：可用内存 ${free}MB < ${RESOURCE_GUARD_MB}MB，36MB 首跑内存实测本轮不跑（未覆盖原因=内存护栏；请重启后或异机跑 运行压测脚本）`);
      const big = ensureBigSession();
      expect(big.verify.ok, `前置失败：36MB 合成会话校验不通过（${JSON.stringify(big.verify)}）`);
      const lab = L.mkLab('p0-3mem');
      copyBigIntoLab(lab);
      const out = path.join(lab.base, 'child-mem.json');
      const r = await spawnNode([CHILD, `--root=${lab.root}`, `--home=${lab.home}`, `--out=${out}`, '--mode=ingest'], { heapMB: 320, timeoutMs: 150_000 });
      if (!fs.existsSync(out)) {
        L.rmLab(lab);
        throw new Error(`★ P0-3 未修复：36MB 首跑在 320MB heap 上限下未产生结果（exit=${r.code} signal=${r.signal} 超时=${r.killedByTimeout}）；stderr=${r.stderr.slice(0, 400)}`);
      }
      const child = readJson(out);
      const peak = Number(child.peakRssMB || 0);
      L.rmLab(lab);
      expect(r.code === 0 && child.ok, `★ P0-3 未修复：36MB 首跑子进程失败（exit=${r.code} error=${child.error} 超时=${r.killedByTimeout}）`);
      expect(peak > 0 && peak <= 600, `★ P0-3 未修复：首跑 RSS 峰值 ${peak}MB 超过上限 600MB（P0-3 要求"内存有明确上限"）`);
      return `36MB/1000 轮首跑：RSS 峰 ${peak}MB ≤600MB（子进程 heap 限 320MB；生成端峰 ${big.reused ? '(复用已生成)' : big.gen.peakRssMB + 'MB'}）；台账 ${child.rows} 行`;
    },
  });

  runner.add({
    id: 'P0-3-cancel', criteria: ['P0-3'], title: '可取消：AbortSignal 在 400ms 中止后 must 及时退出',
    async fn() {
      const free = freeMemMB();
      if (free < 600) skip(`资源纪律：可用内存 ${free}MB < 600MB，取消实测本轮不跑（原因=内存不足）`);
      const tier = ensureTierSession(16);
      expect(tier.verify.ok, '前置失败：16MB 合成会话校验不通过');
      const lab = L.mkLab('p0-3cancel');
      const dir = path.join(lab.sessions, 'wsBig', 'session-bigv05-0000-1111-2222-333344445555');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(tier.file, path.join(dir, 'session.v4.jsonl.zstd'));
      const out = path.join(lab.base, 'child-cancel.json');
      const r = await spawnNode([CHILD, `--root=${lab.root}`, `--home=${lab.home}`, `--out=${out}`, '--mode=cancel', '--abort-ms=400'], { heapMB: 320, timeoutMs: 150_000 });
      const child = fs.existsSync(out) ? readJson(out) : null;
      L.rmLab(lab);
      expect(child, `★ P0-3 未修复：取消探针未产生结果（exit=${r.code} 超时=${r.killedByTimeout} stderr=${r.stderr.slice(0, 300)}）`);
      const honored = !!(child.stat && (child.stat.cancelled === true || child.stat.aborted === true || child.stat.interrupted === true || child.stat.stopped === true));
      const early = child.durationMs <= 400 + 2500;
      expect(honored || early, `★ P0-3 未修复：AbortSignal 未生效 —— 400ms 中止后仍跑满 ${child.durationMs}ms（stat.cancelled/aborted 均无；stat=${JSON.stringify(child.stat && { cancelled: child.stat.cancelled, written: child.stat.written, scanned: child.stat.scanned })}）`);
      return `取消语义生效：abort@400ms，实际 ${child.durationMs}ms 退出（honored=${honored} early=${early}）`;
    },
  });

  runner.add({
    id: 'P0-3-resume', criteria: ['P0-3'], title: 'kill -9 后重启：从已提交批次续，无重复、无整会话遗漏',
    async fn() {
      // 用 8MB 级合成会话（200 轮）验证"重启续跑"语义；36MB 的纯内存上限由 P0-3-mem/异机压测覆盖
      const lab = L.mkLab('p0-3resume');
      const T0 = L.T0();
      const payload = 'Z'.repeat(33000);
      const evs = [...L.sessionHeader(sidOf(lab), T0)];
      L.resetSeq(0);
      for (let turn = 1; turn <= 200; turn += 1) {
        evs.push(L.turnStart(turn, T0 + turn * 1000));
        evs.push(L.ev('user/message', { content: [{ type: 'text', text: `t${turn}:` + payload }], source: { kind: 'user' }, role: 'user' }, T0 + turn * 1000 + 1));
        evs.push(L.ev('tool/call', { turn, callId: 'c' + turn, name: 'pwsh', arguments: JSON.stringify({ command: 'x'.repeat(3000) }) }, T0 + turn * 1000 + 2));
        evs.push(L.turnEnd(turn, T0 + turn * 1000 + 3000));
      }
      L.writeSession(lab, { events: evs });
      const out1 = path.join(lab.base, 'child-1.json');
      const out2 = path.join(lab.base, 'child-2.json');
      // ① 启动第一个子进程；等台账里出现 ≥5 行后 kill -9
      const nodeArgs1 = [CHILD, `--root=${lab.root}`, `--home=${lab.home}`, `--out=${out1}`, '--mode=ingest'];
      const nodeArgs2 = [CHILD, `--root=${lab.root}`, `--home=${lab.home}`, `--out=${out2}`, '--mode=ingest'];
      const child = spawn(process.execPath, ['--max-old-space-size=320', ...nodeArgs1], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let killed = false;
      try {
        await L.waitFor(() => {
          const rows = fs.existsSync(path.join(lab.root, 'ledger')) ? L.listFiles(path.join(lab.root, 'ledger')).filter((f) => f.rel.endsWith('.jsonl')) : [];
          return rows.length > 0;
        }, { timeoutMs: 30000, label: '台账首次落盘' });
        // 等行数增长到 ≥5
        await L.waitFor(() => {
          const files = L.listFiles(path.join(lab.root, 'ledger')).filter((f) => f.rel.endsWith('.jsonl'));
          let n = 0;
          for (const f of files) n += L.readText(f.abs).split('\n').filter((x) => x.trim()).length;
          return n >= 5;
        }, { timeoutMs: 30000, label: '台账 ≥5 行' });
      } finally {
        killed = L.killHard(child.pid);
      }
      await new Promise((r) => setTimeout(r, 500));
      const rowsAfterKill = (await ledgerRows(lab)).length;
      // ② 立即重启（不等待、不手工删锁）：必须从已提交批次续
      const r2 = await spawnNode(nodeArgs2, { heapMB: 320, timeoutMs: 150_000 });
      const child2 = fs.existsSync(out2) ? readJson(out2) : null;
      const rows = await ledgerRows(lab);
      const keys = rows.map((r) => `${r.sid}#${r.turn}`);
      const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
      const turns = [...new Set(rows.map((r) => r.turn))].sort((a, b) => a - b);
      L.rmLab(lab);
      expect(killed, '前置失败：未能 kill 子进程');
      expect(child2, `★ P0-3 未修复：杀进程后重启未产生结果（exit=${r2.code}）；可能被残留锁挡住（state/lock 未接管）`);
      expect(!(child2.stat && child2.stat.lockSkipped), `★ P0-3 未修复：kill -9 后立即重启被残留锁挡住（lockSkipped=true；锁文件未接管）→ 不能从已提交批次续`);
      expect(rows.length > rowsAfterKill, `★ P0-3 未修复：重启后没有继续写入（kill 前 ${rowsAfterKill} 行，重启后仍 ${rows.length} 行）`);
      expectEqual(dup.length, 0, `★ P0-3 未修复：重启后出现重复 (sid,turn)：${JSON.stringify(dup.slice(0, 5))}`);
      expect(turns.length >= 200 && turns[turns.length - 1] === 200, `★ P0-3 未修复：重启后未跑完整会话（turns=${turns.length} 最大=${turns[turns.length - 1]}，期望 200 轮全部在账）`);
      return `kill -9 后重启续跑成功：kill 前 ${rowsAfterKill} 行 → 最终 ${rows.length} 行 / 200 轮，无重复`;
    },
  });

  // ==========================================================================
  // P0-4 · 120/121/122 封板哈希不同 + 溢出去向 + 不可变 sealRows 快照
  //   ★ 勘误 #4（Lead 2026-11-09）：原稿"红"是**状态隔离问题**，不是实现问题——
  //     同一 root 连写三组时，后两组撞上"state-lost → 不重写已有草稿"（审计 M-03 的正确行为），
  //     返回 skipped/hash=''，于是被误判为"封板哈希相同"。照原稿改实现 = 拆掉 M-03。
  //   本文件按 Lead 建议 ①：**每组独立 root**；并同时断言
  //     (1) r.written===true / r.skipped===false（不许拿 skip 或空串当哈希比）
  //     (2) r.sourceRowCount / r.overflow 对得上（120→0、121→1、122→2、125→5）
  //     (3) 闭合：121 = 正册 120 行 + 补记 1；122 = 120+2；125 = 120+5
  //     (4) verifySealChain(root).ok === true（封板链完整）
  //   证据口径：封板证据在 ledger/.seal-journal.jsonl（追加式、带链、含 rows 快照）。
  // ==========================================================================
  async function sealJournalLib() {
    // ★ 勘误 ⑤（Lead 2026-11-09 夜）：这里原来是 `../../lib/...`，从 `P0验收/` 往上跳**两级**
    //   会落到 `<工作区>/lib`（模块找不到）→ P0-4a/b/c 全变 ERROR，与实现无关。
    //   `P0验收/` 在插件根下一级，正确相对路径是 `../lib/...`。
    return import(new URL('../lib/sealjournal.js', import.meta.url).href);
  }
  function readSealJournal(root) {
    const p = path.join(root, 'ledger', '.seal-journal.jsonl');
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行由链校验报 */ }
    }
    return out;
  }
  const mkRecs = (n, s12 = 'v05test00000') => Array.from({ length: n }, (_, i) => ({
    v: 3,
    code: `20261109-${s12}-A-${String(i + 1).padStart(8, '0')}`,
    ts: `2026-11-09T${String(8 + (i % 8)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+08:00`,
    sid: 'session-v05test000001-x', turn: i + 1, seq: i + 1, status: 'ok',
    doc: '/x.md', docHash: 'a'.repeat(64),
  }));
  /** 独立 root 封板一组；返回 {lab, res, ev, closure} —— 调用方断言后再 rmLab。 */
  async function sealIsolated(tag, n) {
    const I = await L.impl(PLUGIN);
    const lab = L.mkLab(tag);
    const g = [...I.wk.groupRecords(mkRecs(n), 480).values()][0];
    if (!g) { L.rmLab(lab); throw new Error('前置失败：分不出组'); }
    const res = I.wk.writeWeekly({ root: lab.root, w: g.w, sessKey: g.sessKey, records: g.records, offsetMinutes: 480, prevHashes: {}, mode: 'sealed', nowMs: Date.parse('2026-11-10T10:00:00+08:00') });
    const events = readSealJournal(lab.root);
    const ev = [...events].reverse().find((e) => e.kind === 'weekly-seal' && (e.key === res.groupId || e.gid === res.groupId));
    const rowsCodes = new Set(((ev && ev.rows) || []).map((r) => String(Array.isArray(r) ? r[0] : (r && r.code))));
    const supplementCodes = new Set(((ev && ev.supplement && Array.isArray(ev.supplement.codes)) ? ev.supplement.codes : []).map(String));
    const primaryCodes = mkRecs(n).map((r) => r.code);
    const missing = primaryCodes.filter((c) => !rowsCodes.has(c) && !supplementCodes.has(c));
    const closure = {
      rowsCodes: rowsCodes.size, supplementCodes: supplementCodes.size,
      missing, total: primaryCodes.length,
      rowCount: ev ? Number(ev.rowCount) : NaN, overflow: ev ? Number(ev.overflow) : NaN,
      sourceRowCount: ev ? Number(ev.sourceRowCount) : NaN,
      supplementFile: ev && ev.supplement ? ev.supplement.file : '',
    };
    return { lab, I, res, ev, closure };
  }

  runner.add({
    id: 'P0-4a', criteria: ['P0-4'], title: '120/121/122 三组**独立 root** 封板：都真写、哈希互不相同、行数/溢出/闭合对得上',
    async fn() {
      const sj = await sealJournalLib();
      const out = [];
      for (const n of [120, 121, 122]) {
        const { lab, res, ev, closure } = await sealIsolated(`p0-4a-${n}`, n);
        const chain = sj.verifySealChain(lab.root);
        const rec = { n, written: res.written, skipped: res.skipped, sealHash: res.sealHash, hash: res.hash, sourceRowCount: res.sourceRowCount, overflow: res.overflow, closure, chainOk: chain.ok };
        out.push(rec);
        L.rmLab(lab);
      }
      const strict = out.map((x) => ({
        n: x.n,
        realWrite: x.written === true && x.skipped === false,
        sourceOk: Number(x.sourceRowCount) === x.n,
        overflowOk: Number(x.overflow) === x.n - 120,
        journal: x.closure.rowCount === 120 && x.closure.overflow === x.n - 120 && x.closure.missing.length === 0,
        chainOk: x.chainOk === true,
        sealHash: String(x.sealHash || '').length === 64,
      }));
      const bad = strict.filter((x) => !x.realWrite || !x.sourceOk || !x.overflowOk || !x.journal || !x.chainOk || !x.sealHash);
      const hashes = out.map((x) => x.sealHash);
      expect(bad.length === 0, `★ P0-4 未修复（勘误#4：独立 root 下仍不成立）：${JSON.stringify(bad)}`);
      expect(new Set(hashes).size === 3, `★ P0-4 未修复：120/121/122 封板哈希必须互不相同（实际=${JSON.stringify(hashes)}）`);
      return `三组独立 root 均真写且链完整；sealHash 两两不同：${hashes.map((h) => String(h).slice(0, 10) + '…').join(' / ')}；121→正册120+补记1、122→120+2`;
    },
  });

  runner.add({
    id: 'P0-4b', criteria: ['P0-4'], title: '125 条：120 正册 + 5 补记可按编码检索、总数闭合无重复；封板 journal 有 rows 快照',
    async fn() {
      const sj = await sealJournalLib();
      const { lab, res, ev, closure } = await sealIsolated('p0-4b', 125);
      const chain = sj.verifySealChain(lab.root);
      const supplementFiles = L.listFiles(lab.root).filter((f) => /补记-\d{8}\.md$/.test(f.rel));
      const supplementText = supplementFiles.map((f) => L.readText(f.abs)).join('\n');
      const supplementInFile = new Set([...supplementText.matchAll(/\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}/g)].map((m) => m[0]));
      const resBrief = JSON.stringify({ written: res.written, sealed: res.sealed, skipped: res.skipped, overflow: res.overflow, sourceRowCount: res.sourceRowCount, rows: res.rows });
      const allCodes = mkRecs(125).map((r) => r.code);
      const missing = allCodes.filter((c) => !supplementInFile.has(c) && !closure.rowsCodes);
      const checks = {
        realWrite: res.written === true && res.skipped === false,
        sourceRowCount: Number(res.sourceRowCount) === 125,
        overflow: Number(res.overflow) === 5,
        journalExists: !!ev,
        rowCount: closure.rowCount === 120,
        supplementCodes: closure.supplementCodes === 5,
        closure: closure.missing.length === 0,
        chainOk: chain.ok === true,
        supplementFileHasCodes: missing.length === 0,
      };
      L.rmLab(lab);
      const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      expect(bad.length === 0, `★ P0-4 未修复：125 条封板闭合校验失败 ${JSON.stringify(bad)}；res=${resBrief}；closure=${JSON.stringify(closure)}；supplementFiles=${JSON.stringify(supplementFiles.map((f) => f.rel))}`);
      return `125 条：正册 120 行 + 补记 5 条（journal supplement.codes=5，补记册文件含这 5 个编码）；sourceRowCount=125、overflow=5、链完整`;
    },
  });

  runner.add({
    id: 'P0-4c', criteria: ['P0-4'], title: '封板证据不可变：seal journal/rows 快照在后续调用中不改写',
    async fn() {
      const sj = await sealJournalLib();
      const { lab, I, res } = await sealIsolated('p0-4c', 3);
      const journalPath = path.join(lab.root, 'ledger', '.seal-journal.jsonl');
      const before = L.shaFile(journalPath);
      const beforeEvents = readSealJournal(lab.root).length;
      const g = [...I.wk.groupRecords(mkRecs(3), 480).values()][0];
      const res2 = I.wk.writeWeekly({ root: lab.root, w: g.w, sessKey: g.sessKey, records: g.records, offsetMinutes: 480, prevHashes: {}, mode: 'sealed', nowMs: Date.parse('2026-11-10T11:00:00+08:00') });
      const after = L.shaFile(journalPath);
      const afterEvents = readSealJournal(lab.root).length;
      const chain = sj.verifySealChain(lab.root);
      L.rmLab(lab);
      expect(res2.skipped === true && res2.reason === 'sealed', `★ P0-4 未修复：已封板后再调用未 skip（skipped=${res2.skipped} reason=${res2.reason}）`);
      expectEqual(after, before, '★ P0-4 未修复：已封板后 journal/快照被改写（历史校验会失真）');
      expectEqual(afterEvents, beforeEvents, `★ P0-4 未修复：已封板后 journal 又追加了新事件（${beforeEvents}→${afterEvents}）`);
      expect(chain.ok === true, '★ P0-4 未修复：封板链 verifySealChain 不通过');
      return `seal journal 不可变（sha256=${before.slice(0, 12)}…，事件数 ${beforeEvents} 未变），链完整`;
    },
  });

  // ==========================================================================
  // P0-5 · 原文工具参数不得静默截断（完整恢复 or 显式截断 + 原始长度 + 附件指针 + 哈希）
  //   证据链：原文 md 的截断标记 → 同目录「<code> 原始事件.json」附件 → 附件 sha256 与指针一致 → 附件内逐字恢复。
  // ==========================================================================
  runner.add({
    id: 'P0-5', criteria: ['P0-5'], title: '2000/2001/4517 及多字节参数：完整可恢复，或显式截断+原始长度+附件指针+哈希',
    async fn() {
      const lab = L.mkLab('p0-5');
      L.resetSeq(0);
      const T0 = L.T0();
      const specs = [
        { tag: 'len2000', raw: 'X'.repeat(2000) + '【2000尾标】' },
        { tag: 'len2001', raw: 'X'.repeat(2001) + '【2001尾标】' },
        { tag: 'len4517', raw: 'X'.repeat(4517) + '【4517尾标】' },
        { tag: 'multibyte', raw: '中'.repeat(4517) + '【多字节尾标：逐字恢复】' },
      ];
      const events = [...L.sessionHeader(sidOf(lab), T0)];
      specs.forEach((s, idx) => {
        const turn = idx + 1;
        events.push(L.turnStart(turn, T0 + turn * 60_000));
        events.push(L.ev('tool/call', { turn, callId: 'c' + turn, name: 'pwsh', arguments: JSON.stringify({ command: s.raw }) }, T0 + turn * 60_000 + 100));
        events.push(L.ev('tool/result', { turn, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }], isError: false }, sourceEventSeqs: [] }, T0 + turn * 60_000 + 200));
        events.push(L.turnEnd(turn, T0 + turn * 60_000 + 3000));
      });
      L.writeSession(lab, { events });
      await L.runOnce(PLUGIN, lab);
      const rows = await ledgerRows(lab);
      expectEqual(rows.length, 4, `前置失败：4 轮应入账 4 行（实际 ${rows.length}；errors=${JSON.stringify((await L.runOnce(PLUGIN, lab)).stat.errors).slice(0, 200)}）`);
      const failures = [];
      const details = [];
      for (let i = 0; i < specs.length; i += 1) {
        const spec = specs[i];
        const row = rows.find((r) => r.turn === i + 1);
        const mdPath = path.join(lab.root, row.doc);
        const md = fs.readFileSync(mdPath, 'utf8');
        const hasFull = md.includes(spec.raw.slice(-20)) && md.includes(spec.raw.slice(0, 20));
        let ok = hasFull;
        let detail = { tag: spec.tag, hasFull, mode: hasFull ? 'full' : 'truncated?' };
        if (!hasFull) {
          const mark = /\[截断\]|截断/.test(md);
          const lenM = /原始长度=(\d+)字符/.exec(md);
          const attM = /附件=([^\n]+? 原始事件\.json)/.exec(md);
          const shaM = /sha256=([0-9a-f]{64})/.exec(md);
          const rawArgs = JSON.stringify({ command: spec.raw });
          const expectedLens = [spec.raw.length, Buffer.byteLength(spec.raw, 'utf8'), rawArgs.length, Buffer.byteLength(rawArgs, 'utf8')];
          const absent = [];
          if (!mark) absent.push('截断标记');
          if (!lenM) absent.push('原始长度');
          else if (!expectedLens.includes(Number(lenM[1]))) absent.push(`原始长度不符(${lenM[1]} 不在 ${JSON.stringify(expectedLens)})`);
          if (!attM) absent.push('附件指针');
          if (!shaM) absent.push('附件sha256');
          if (absent.length === 0) {
            const attPath = path.join(path.dirname(mdPath), attM[1].trim());
            if (!fs.existsSync(attPath)) absent.push('附件文件不存在:' + attM[1].trim());
            else {
              if (L.shaFile(attPath) !== shaM[1]) absent.push('附件 sha256 不符');
              const attText = fs.readFileSync(attPath, 'utf8');
              if (!attText.includes(spec.raw.slice(-16))) absent.push('附件未逐字保留尾部标记');
            }
          }
          ok = absent.length === 0;
          detail = { ...detail, mode: 'truncated+disclosed', absent };
        }
        details.push(detail);
        if (!ok) failures.push(detail);
      }
      L.rmLab(lab);
      expect(failures.length === 0, `★ P0-5 未修复：长参数既未完整保留、也未给出完整披露（截断标记+原始长度+附件指针+哈希+附件内逐字恢复）：${JSON.stringify(failures)}`);
      return `4 组参数全部通过：${JSON.stringify(details)}`;
    },
  });

  // ==========================================================================
  // P0-6 · 清理默认不动手 + 旧清理工具封锁
  // ==========================================================================
  runner.add({
    id: 'P0-6', criteria: ['P0-6'], title: '未显式开启清理时一个文件都不能少；旧 CLI 未加 --yes 不得删除',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p0-6');
      const dir = path.join(lab.root, '2026年11月', '11月总“完整原文”');
      fs.mkdirSync(dir, { recursive: true });
      const victim = path.join(dir, '20261109-v05test00000-A-00000001 完整原文.md');
      const mkVictim = () => fs.writeFileSync(victim, '# fake original\n');
      mkVictim();
      // ① 旧 CLI 不加 --yes → 只统计，不删（“封锁”）
      const cli = path.join(PLUGIN, 'docs', '工具-v03-清理.mjs');
      const r = await spawnNode([cli, lab.root], { timeoutMs: 60_000 });
      const cliSafe = fs.existsSync(victim) && !(r.code !== 0 && /unlink|EPERM/i.test(r.stderr));
      // ② dry-run → 不删
      if (fs.existsSync(victim)) {
        const dry = I.cl.runCleanup({ root: lab.root, dryRun: true });
        var drySafe = fs.existsSync(victim) && dry.deleted === 0;
      }
      // ③ 默认（不传 dryRun）→ P0 要求默认关闭，一个文件都不能少
      let defaultSafe = null;
      let defaultDetail = '';
      let victimStillExists = fs.existsSync(victim);
      if (victimStillExists) {
        const res = I.cl.runCleanup({ root: lab.root });
        victimStillExists = fs.existsSync(victim);
        defaultSafe = victimStillExists && res.deleted === 0;
        defaultDetail = `deleted=${res.deleted} victimExists=${victimStillExists}`;
      }
      L.rmLab(lab);
      expect(cliSafe, '★ P0-6 未修复：旧清理工具未加 --yes 时仍发生删除/异常');
      expect(drySafe, '★ P0-6 未修复：dry-run 模式下发生物理删除');
      expect(defaultSafe === true, `★ P0-6 未修复：未显式开启时 runCleanup 默认物理删除（${defaultDetail}）；P0 阶段必须默认关闭，只允许只读统计+dry-run`);
    },
  });

  // ==========================================================================
  // P0-7 · 凭证不可覆盖 + 完整文件哈希 + 失败回退留痕
  // ==========================================================================
  runner.add({
    id: 'P0-7①', criteria: ['P0-7'], title: '同编码不同正文必须拒绝（合法 markdown 夹具，勘误②）',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p0-7a');
      const code = '20261109-v05test00000-A-00000001';
      const body = (v) => [
        '---',
        `编码: '${code}'`,
        `名称: '${code} 完整原文'`,
        `会话ID: 'session-x'`,
        `会话短ID: 'v05test0000'`,
        `代次: 'A'`,
        `本轮序号: 1`,
        `对话开始: '2026-11-09T10:00:00+08:00'`,
        `对话结束: '2026-11-09T10:01:00+08:00'`,
        `结束原因: 'completed'`,
        `委托人: user`,
        `执行: 日常会话记录插件（Tool）`,
        `记录: 系统（Cordis）`,
        `生成器: 'test'`,
        `事件范围: 'seq 1 – 3'`,
        `被遮蔽事件数: 0`,
        `正文hash: '${'0'.repeat(64)}'`,
        `正文hash算法: 'sha256（对『## 1.』至文件末尾的全部字节计算）'`,
        `文件数: 0`,
        `文件: []`,
        '---', '',
        `# ${code} 完整原文`, '',
        '## 1. user/message', '', `[seq 1] 10:00:00`, '', `第一版正文（${v}）`, '',
        '## 2. assistant/message', '', '—', '',
        '## 3. tool/call + tool/result', '', '—', '',
        '## 4. step/start + step/end', '', '—', '',
        '## 5. 备注', '', `- 文件清单：未启用（真实采集排 v0.5）`, '',
      ].join('\n');
      const md1 = body('A');
      const w1 = I.org.writeOriginal({ root: lab.root, y: 2026, m: 11, code, markdown: md1 });
      const file = path.join(I.org.originalDir(lab.root, 2026, 11), `${code} 完整原文.md`);
      const before = L.shaFile(file);
      // 同码同正文 → 允许复用（不写盘）
      const w2 = I.org.writeOriginal({ root: lab.root, y: 2026, m: 11, code, markdown: md1 });
      expect(w2.reused === true || L.shaFile(file) === before, '同码同正文应复用（reused=true）');
      // 同码不同正文 → 必须拒绝且不动盘
      let err = null;
      try { I.org.writeOriginal({ root: lab.root, y: 2026, m: 11, code, markdown: body('B') }); } catch (e) { err = e; }
      const after = L.shaFile(file);
      L.rmLab(lab);
      expect(err && /ORIGINAL_/.test(String(err.code || err.message)), `★ P0-7① 未修复：同码不同正文没有拒绝（合法夹具，非 ORIGINAL_NO_BODY 提前拒绝）`);
      expectEqual(after, before, '★ P0-7① 未修复：同码不同正文发生了覆盖（字节变化）');
    },
  });

  runner.add({
    id: 'P0-7②', criteria: ['P0-7'], title: '台账记完整文件哈希（不只正文 hash）',
    async fn() {
      const lab = L.mkLab('p0-7b');
      L.resetSeq(0);
      L.writeSession(lab, { events: [...L.sessionHeader(sidOf(lab), L.T0()), ...L.simpleTurn(1, L.T0() + 60_000)] });
      const r = await L.runOnce(PLUGIN, lab);
      const rows = await ledgerRows(lab);
      expect(rows.length === 1, `前置失败：应入账 1 行（实际 ${rows.length}；errors=${JSON.stringify(r.stat.errors)}）`);
      const rec = rows[0];
      const origPath = path.join(lab.root, rec.doc);
      expect(fs.existsSync(origPath), '前置失败：原文文件不存在');
      const fullHash = L.shaFile(origPath);
      const candidates = ['docFileSha256', 'docFileHash', 'fileHash', 'docFullHash', 'originalFileHash', 'fullFileHash', 'docBytesHash'];
      const key = candidates.find((k) => typeof rec[k] === 'string' && /^[0-9a-f]{64}$/.test(rec[k]));
      const bodyHash = rec.docHash;
      L.rmLab(lab);
      expect(key, `★ P0-7② 未修复：台账没有"完整文件哈希"字段（现有字段=${JSON.stringify(Object.keys(rec))}；docHash 是正文 hash=${String(bodyHash).slice(0, 12)}…，不等于整文件 hash=${fullHash.slice(0, 12)}…）`);
      expectEqual(rec[key], fullHash, `★ P0-7② 未修复：完整文件哈希不等于整文件 sha256（字段 ${key}）`);
      return `台账含完整文件哈希 ${key}=${fullHash.slice(0, 12)}…（≠正文hash，长度 64）`;
    },
  });

  runner.add({
    id: 'P0-7③', criteria: ['P0-7'], title: '坏 sid 必须进 errors 且留痕（依赖 D9 定稿）',
    async fn() {
      const lab = L.mkLab('p0-7c');
      // ★ 勘误 ⑥（Lead 2026-11-09 夜）：原夹具用 `BAD_ID_NO_PREFIX` —— 它**不是**不可编码的 sid。
      //   `lib/encoder.js: normalizeSessionId` 的契约就是"剥掉连字符/下划线/空格 + 转小写 + 取前 12 位"，
      //   所以 BAD_ID_NO_PREFIX → `badidnoprefi`（合法 12 位），本该正常入账。
      //   用"过短"才是真正的不可编码：`abc` → 空串 → SID_UNENCODABLE。
      const badSid = 'abc';
      const dir = path.join(lab.sessions, 'wsA', `session-${badSid}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      L.resetSeq(0);
      const evs = [
        { type: 'session', version: 4, id: badSid, createdAt: L.T0(), cwd: 'C:\\v05' },
        L.turnStart(1, L.T0()), L.userMsg('坏 sid 也要被报出来', L.T0() + 1), L.turnEnd(1, L.T0() + 2000),
      ];
      fs.writeFileSync(file, L.frame(evs.map((e) => JSON.stringify(e))));
      const r = await L.runOnce(PLUGIN, lab);
      const rows = await ledgerRows(lab);
      const st = await L.readState(PLUGIN, lab.root);
      const errorsText = (r.stat.errors || []).join('\n');
      const lostPath = path.join(lab.root, 'ledger', '.lost.jsonl');
      const traceFiles = L.listFiles(path.join(lab.root, 'ledger')).map((f) => f.rel);
      const hasTrace = fs.existsSync(lostPath) || JSON.stringify(st).includes('bad') || traceFiles.some((n) => /error|lost|bad/i.test(n));
      const cursors = st.sourceCursors || {};
      const cursorEntry = cursors[file] || Object.entries(cursors).find(([k]) => k.endsWith(file.split(path.sep).pop()))?.[1];
      // ★ 勘误 ⑦（Lead 2026-11-09 夜）：`L.rmLab(lab)` 之后还在 expect 的模板串里调
      //   `fs.statSync(file)` —— 模板串是**立即求值**的，于是必然 ENOENT（用例本来该 PASS 也会变 ERROR）。
      //   文件大小必须在删实验目录**之前**取好。
      const fileSize = fs.statSync(file).size;
      const cursorAdvanced = cursorEntry && Number(cursorEntry.offset) >= fileSize - 1;
      L.rmLab(lab);
      expect(/bad|invalid|sid/i.test(errorsText) && errorsText.length > 0, `★ P0-7③（依赖 D9）未修复：坏 sid 未进入 errors（errors=${JSON.stringify(r.stat.errors).slice(0, 400)}；台账行数=${rows.length}）`);
      expect(hasTrace, '★ P0-7③（依赖 D9）未修复：坏 sid 失败没有留痕（.lost.jsonl/state 均无）');
      expect(!cursorAdvanced, `★ P0-7③（依赖 D9）未修复：失败仍把游标推进到文件末尾（offset=${cursorEntry && cursorEntry.offset}/${fileSize}）`);
    },
  });

  // ==========================================================================
  // P1-6 · 补记/清册编号统一 \d+（99/100/101 不重复不忽略）；验证器不得忽略未知块
  //   夹具：构造一本**合法**补记册（01…101 连续），再追加一条 → 应得 102。
  //   旧实现只解析两位序号 → 100/101 被忽略 → 会撞号/重复；本用例能失败。
  // ==========================================================================
  runner.add({
    id: 'P1-6', criteria: ['P1-6'], title: '补记册 01…101 连续后追加 → 应得 102；验证器不得忽略未知块',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('p1-6');
      const day = '20261109';
      const bookId = `补记-${day}`;
      const codeBase = (n) => `20261109-v05test00000-A-${String(n).padStart(8, '0')}`;
      const mkEntry = (n) => {
        const code = codeBase(n);
        const values = I.wk.supplementRowValues({ code, original: '绑定', time: `10:00`, status: '已完成' });
        const hash = I.wk.supplementEntryHash(values);
        return [
          `## ${bookId}-${String(n).padStart(2, '0')}`, '',
          `- 补记编号: ${bookId}-${String(n).padStart(2, '0')}`,
          `- 原编码: ${code}`,
          `- 原时间: 2026-11-09 10:00:00`,
          `- 所属正册: 2026年11月/11月第2周-v05test00000A的周记账.xlsx（已封板）`,
          `- 被补记原因: 验收夹具`,
          `- 补记hash: ${hash}`, '',
          '| 编码 | 原始凭证 | 时间 | 角色 | 对话内容摘要 | User的文件引用与Agent文件输出 | 输出文件位置 | 状态 | 用户审计 | 备注 |',
          '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
          `| ${values.join(' | ')} |`, '',
        ].join('\n');
      };
      const header = [
        '---', `名称: "${bookId}"`, `补记日期: "2026-11-09"`, `生成器: "test"`, `生成时间: "2026-11-09 10:00:00"`, '---', '',
        `# 2026-11-09 补记册`, '',
        '> 本册承载已封板周记账后发现的行；永久、另册；不修改已封板正册。', '',
      ].join('\n');
      let book = header;
      for (let n = 1; n <= 101; n += 1) book += mkEntry(n);
      const bookPath = path.join(lab.root, `${bookId}.md`);
      fs.writeFileSync(bookPath, book, 'utf8');
      const newCode = codeBase(150);
      const res = I.wk.writeSupplement({
        root: lab.root, codes: [newCode], records: [{ code: newCode, ts: '2026-11-09T12:00:00+08:00', status: 'ok' }],
        generatedAt: '2026-11-09T12:00:00+08:00', nowMs: Date.parse('2026-11-09T12:00:00+08:00'),
      });
      const newId = res.entries[0] && res.entries[0].id;
      const text = fs.readFileSync(bookPath, 'utf8');
      const parsed = I.wk.parseSupplementBook(text);
      const ids = parsed.entries.map((e) => e.id);
      const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
      const idSet = new Set(ids);
      // 验证器：加一个未知块，必须报出来（不得静默忽略）
      const withUnknown = text + '\n## 未知块-20261109-99\n\n- 某字段: X\n';
      let verify = null; let verifyThrew = null;
      try { verify = I.wk.verifySupplementBook(withUnknown); } catch (e) { verifyThrew = String(e && (e.code || e.message)); }
      L.rmLab(lab);
      expectEqual(newId, `${bookId}-102`, `★ P1-6 未修复：01…101 之后追加的编号应为 ${bookId}-102，实际 ${newId}（解析器只认两位序号会撞号/重复）`);
      expectEqual(dupIds.length, 0, `★ P1-6 未修复：补记册出现重复编号 ${JSON.stringify(dupIds)}`);
      expect(idSet.has(`${bookId}-100`) && idSet.has(`${bookId}-101`), `★ P1-6 未修复：100/101 被解析器忽略（解析出 ${ids.length} 条，末尾=${JSON.stringify(ids.slice(-3))}）`);
      expectEqual(ids.length, 102, `★ P1-6 未修复：解析应得到 102 条（01…102），实际 ${ids.length} 条`);
      expect(verifyThrew !== null || (verify && verify.ok === false), `★ P1-6 未修复：验证器静默忽略未知块（verify.ok=${verify && verify.ok} issues=${JSON.stringify(verify && verify.issues)}）`);
      return `01…101 连续后追加得到 ${newId}；解析 102 条无重复；未知块被报出（${verifyThrew || 'issues'}）`;
    },
  });

  // ==========================================================================
  // REC 核心三条（Lead 指定补进 P0 回归）—— **v1.0.0-re3：按 S-11 / C42 新契约改写**
  //
  //   背景：re2 的 C42 已把日结摘要从「S-1 摘要（10 键、坏了重写）」升级为
  //   「**11 键含 firstCode、版本化补发、永不覆盖**」（lib/receipt.js RECEIPT_VERSION=2）。
  //   上一轮（依据 S-1）写的断言是 decision='rewritten'、旧摘要被覆盖 → 在 C42 下必然红
  //   （实测 REC-core 2 条 FAIL / exit 1）。本轮按 **C42** 断言当前真实契约（不是放宽成恒真）：
  //     · 键面 11 键且含 firstCode；不含 ledgerSha256/prevReceiptSha256；
  //     · 两日各自独立核验；改摘要→SUMMARY_MISMATCH；删台账→LEDGER_MISSING（无链）；
  //     · 内容变化 → **补发新版**（appended-version / version=2 / JSON+TXT 成对），
  //       **v1 字节一个字节不动**（永不覆盖）；同证据再补发 → 幂等、不产新版本；
  //     · 永不出现 S-1 的 RECEIPT_CONFLICT / LEDGER_CHANGED / CHAIN_BREAK。
  //   仍能失败：改摘要字段必 SUMMARY_MISMATCH；实现若回退成"覆盖重写 v1"，sha 断言红；
  //   实现若不再补发，version / decision 断言红。
  // ==========================================================================
  runner.add({
    id: 'REC-core-v2摘要键面与版本化补发', criteria: ['REC-2'],
    title: '11 键含 firstCode 无链字段；两日独立核验；改摘要→SUMMARY_MISMATCH；补发 v2 且不覆盖 v1',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('rec-2');
      const anchor = path.join(lab.base, 'anchor-outside');
      writeLedgerDays(lab.root, {
        '2026-11-08': [ledgerRow(CODE1, '2026-11-08T10:00:00+08:00')],
        '2026-11-09': [ledgerRow(CODE2, '2026-11-09T10:00:00+08:00')],
      });
      const w1 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08' });
      const w2 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-09' });
      expect(w1.ok && w1.written && w2.ok && w2.written, `前置失败：两日摘要未生成（${JSON.stringify([w1.reason, w2.reason])}）`);
      // ① C42 键面：11 键、含 firstCode、无链/哈希绑定字段、v=RECEIPT_VERSION(2)
      const keys = Object.keys(w1.receipt || {});
      expectEqual(JSON.stringify(keys), JSON.stringify(I.rec.RECEIPT_KEYS), '★ REC-2 不成立：摘要键面与 RECEIPT_KEYS 不一致');
      expect(keys.length === 11 && keys.includes('firstCode'),
        `★ REC-2 不成立：C42 要求 11 键且含 firstCode（keys=${JSON.stringify(keys)}）`);
      expect(!keys.includes('ledgerSha256') && !keys.includes('prevReceiptSha256'),
        `★ REC-2 不成立：S-1 已裁掉的链/哈希字段仍被写出（keys=${JSON.stringify(keys)}）`);
      expectEqual(Number(w1.receipt.v), Number(I.rec.RECEIPT_VERSION), '★ REC-2 不成立：摘要格式版本号不是 C42 v2');
      expectEqual(String(w1.receipt.firstCode || ''), CODE1, '★ REC-2 不成立：firstCode 未按台账首条编码写出');
      // ② 两日各自独立核验通过（无链 → 不存在"链断"这种通过条件）
      const v1 = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
      expect(v1.ok && v1.days === 2, `★ REC-2 不成立：两日摘要独立核验未通过（ok=${v1.ok} days=${v1.days} breaks=${JSON.stringify(v1.breaks)}）`);
      // ③ 往旧摘要里塞 prevReceiptSha256（旧 v2.1 字段）→ 被忽略，不得报 CHAIN_BREAK
      const p1 = I.rec.receiptPath(anchor, '2026-11-08');
      const o1 = JSON.parse(fs.readFileSync(p1, 'utf8'));
      o1.prevReceiptSha256 = 'f'.repeat(64);
      fs.writeFileSync(p1, JSON.stringify(o1) + '\n');
      const v2 = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
      expect(v2.ok && !v2.breaks.some((b) => b.type === 'CHAIN_BREAK'),
        `★ REC-2 不成立：旧链字段被当成证据/报 CHAIN_BREAK（ok=${v2.ok} breaks=${JSON.stringify(v2.breaks)}）`);
      // ④ 改 day2 摘要行数 → SUMMARY_MISMATCH(ledgerRows)，不得牵连 day1
      const p2v1 = I.rec.receiptPath(anchor, '2026-11-09');
      const o2 = JSON.parse(fs.readFileSync(p2v1, 'utf8'));
      o2.ledgerRows = Number(o2.ledgerRows) + 1;
      fs.writeFileSync(p2v1, JSON.stringify(o2) + '\n');
      const tamperedV1Sha = sha(p2v1); // 被改坏的 v1 字节指纹：补发后必须**一模一样**
      const v3 = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
      expect(!v3.ok && v3.breaks.some((b) => b.type === 'SUMMARY_MISMATCH' && b.date === '2026-11-09' && b.field === 'ledgerRows'),
        `★ REC-2 不成立：改摘要行数后未报 SUMMARY_MISMATCH/ledgerRows（breaks=${JSON.stringify(v3.breaks)}）`);
      expect(!v3.breaks.some((b) => b.date === '2026-11-08'),
        `★ REC-2 不成立：改一天摘要牵连了另一天（breaks=${JSON.stringify(v3.breaks)}）`);
      // ⑤ ★C42：内容变了 → **补发 v2**（不是重写 v1）；v1 字节不动；旧版仍可读
      const w3 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-09' });
      const versions = I.rec.listReceiptVersions(anchor, '2026-11-09').map((x) => x.version);
      const v2JsonPath = I.rec.receiptVersionPath(anchor, '2026-11-09', 2);
      const v2TxtPath = I.rec.digestTxtPath(anchor, '2026-11-09', 2);
      const v4 = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
      // 证据要在删 lab 之前取（anchor 在 lab.base 内，rmLab 会整棵删掉）
      const v2JsonExists = fs.existsSync(v2JsonPath);
      const v2TxtExists = fs.existsSync(v2TxtPath);
      const v1ShaAfter = sha(p2v1);
      L.rmLab(lab);
      expect(w3.ok && w3.written === true && w3.appended === true && w3.version === 2 && w3.decision === 'appended-version',
        `★ REC-2 不成立：C42 要求"内容变→补发新版"（ok=${w3.ok} written=${w3.written} appended=${w3.appended} version=${w3.version} decision=${w3.decision}）`);
      expectEqual(JSON.stringify(versions), JSON.stringify([1, 2]), '★ REC-2 不成立：补发后应同时存在 v1/v2 两个版本');
      expect(v2JsonExists, '★ REC-2 不成立：v2 摘要 JSON 不存在（' + v2JsonPath + '）');
      expect(v2TxtExists, '★ REC-2 不成立：v2 外发 TXT 未与 JSON 成对写出（' + v2TxtPath + '）');
      expectEqual(v1ShaAfter, tamperedV1Sha, '★ REC-2 不成立：补发改写了 v1 摘要字节（C42：发出后永不覆盖）');
      expect(v4.ok, `★ REC-2 不成立：补发后核验仍未回绿（breaks=${JSON.stringify(v4.breaks)}）`);
    },
  });

  runner.add({
    id: 'REC-core-幂等与版本化补发', criteria: ['REC-4'],
    title: '同日同证据幂等（written=false/idempotent）；证据变化→补发 v2 且 v1 字节不动；无 RECEIPT_CONFLICT',
    async fn() {
      const I = await L.impl(PLUGIN);
      const lab = L.mkLab('rec-4');
      const anchor = path.join(lab.base, 'anchor-outside');
      writeLedgerDays(lab.root, { '2026-11-08': [ledgerRow(CODE1, '2026-11-08T10:00:00+08:00')] });
      const w1 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08', nowMs: Date.parse('2026-11-09T10:00:00+08:00') });
      expect(w1.ok && w1.written && w1.version === 1 && w1.decision === 'written',
        `前置失败：首版摘要未写（ok=${w1.ok} written=${w1.written} version=${w1.version} decision=${w1.decision} reason=${w1.reason}）`);
      const p = I.rec.receiptPath(anchor, '2026-11-08');
      const before = sha(p);
      // ① 同日同证据重跑 → 幂等（不产新版、字节不变）
      const w2 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08', nowMs: Date.parse('2026-11-09T11:00:00+08:00') });
      const afterIdem = sha(p);
      // ② 证据变化（追加一行台账），先不补发 → 必须能发现（SUMMARY_MISMATCH）
      fs.appendFileSync(path.join(lab.root, 'ledger', '2026-11-08.jsonl'), JSON.stringify(ledgerRow('20261108-v05test00000-A-00000009', '2026-11-08T11:00:00+08:00')) + '\n');
      const vBefore = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
      // ③ ★C42：内容变了 → 补发 v2；**v1 一个字节不动**；不再有 RECEIPT_CONFLICT
      const w3 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08', nowMs: Date.parse('2026-11-09T12:00:00+08:00') });
      const after = sha(p);
      const versions = I.rec.listReceiptVersions(anchor, '2026-11-08').map((x) => x.version);
      const vAfter = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
      // ④ 证据未再变 → 再补发应幂等（不得无中生有 v3）
      const w4 = I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08', nowMs: Date.parse('2026-11-09T13:00:00+08:00') });
      const versions2 = I.rec.listReceiptVersions(anchor, '2026-11-08').map((x) => x.version);
      L.rmLab(lab);
      expect(w2.ok === true && w2.written === false && w2.decision === 'idempotent' && w2.version === 1,
        `★ REC-4 不成立：同日同证据重跑不是幂等（ok=${w2.ok} written=${w2.written} decision=${w2.decision} version=${w2.version} reason=${w2.reason}）`);
      expectEqual(afterIdem, before, '★ REC-4 不成立：幂等重跑改写了摘要字节');
      expect(!vBefore.ok && vBefore.breaks.some((b) => b.type === 'SUMMARY_MISMATCH'),
        `★ REC-4 不成立：证据变化但未补发时未报 SUMMARY_MISMATCH（ok=${vBefore.ok} breaks=${JSON.stringify(vBefore.breaks)}）`);
      expect(w3.ok === true && w3.written === true && w3.appended === true && w3.version === 2 && w3.decision === 'appended-version',
        `★ REC-4 不成立：C42 要求"证据变化→补发新版"（ok=${w3.ok} written=${w3.written} appended=${w3.appended} version=${w3.version} decision=${w3.decision}）`);
      expect(w3.reason !== 'RECEIPT_CONFLICT', `★ REC-4 不成立：仍在用 S-1 已裁掉的 RECEIPT_CONFLICT 语义（reason=${w3.reason}）`);
      expectEqual(after, before, '★ REC-4 不成立：C42 永不覆盖——补发新版却改写了 v1 摘要字节');
      expectEqual(JSON.stringify(versions), JSON.stringify([1, 2]), '★ REC-4 不成立：补发后版本集合应为 [1,2]');
      expect(vAfter.ok, `★ REC-4 不成立：补发后仍未回绿（breaks=${JSON.stringify(vAfter.breaks)}）`);
      expect(w4.ok === true && w4.written === false && w4.decision === 'idempotent',
        `★ REC-4 不成立：证据未变时再补发不幂等（ok=${w4.ok} written=${w4.written} decision=${w4.decision}）`);
      expectEqual(JSON.stringify(versions2), JSON.stringify([1, 2]), '★ REC-4 不成立：证据未变时再补发凭空多出版本');
    },
  });

  runner.add({
    id: 'REC-core-篡改与删除', criteria: ['REC-5'],
    title: '改台账→SUMMARY_MISMATCH；删台账→LEDGER_MISSING；删摘要→无链断且可重出',
    async fn() {
      const I = await L.impl(PLUGIN);
      const mk = (tag) => {
        const lab = L.mkLab('rec-5-' + tag);
        const anchor = path.join(lab.base, 'anchor-outside');
        writeLedgerDays(lab.root, {
          '2026-11-08': [ledgerRow(CODE1, '2026-11-08T10:00:00+08:00')],
          '2026-11-09': [ledgerRow(CODE2, '2026-11-09T10:00:00+08:00')],
        });
        return { lab, anchor, I };
      };
      // ① 改台账（追加一行，摘要未重出）→ 摘要过期：SUMMARY_MISMATCH；不得再报已裁掉的 LEDGER_CHANGED
      {
        const { lab, anchor } = mk('changed');
        expect(I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08' }).ok, '前置失败：摘要未生成');
        fs.appendFileSync(path.join(lab.root, 'ledger', '2026-11-08.jsonl'), JSON.stringify(ledgerRow('20261108-v05test00000-A-00000010', '2026-11-08T12:00:00+08:00')) + '\n');
        const v = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
        L.rmLab(lab);
        expect(!v.ok && v.breaks.some((b) => b.type === 'SUMMARY_MISMATCH' && b.date === '2026-11-08'),
          `★ REC-5 不成立：改台账后未报 SUMMARY_MISMATCH（breaks=${JSON.stringify(v.breaks)}）`);
        expect(!v.breaks.some((b) => b.type === 'LEDGER_CHANGED'),
          `★ REC-5 不成立：仍在报 S-1 已裁掉的 LEDGER_CHANGED（breaks=${JSON.stringify(v.breaks)}）`);
      }
      // ② 删台账（摘要说这天有账）→ LEDGER_MISSING
      {
        const { lab, anchor } = mk('missing');
        expect(I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08' }).ok, '前置失败：摘要未生成');
        fs.unlinkSync(path.join(lab.root, 'ledger', '2026-11-08.jsonl'));
        const v = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
        L.rmLab(lab);
        expect(!v.ok && v.breaks.some((b) => b.type === 'LEDGER_MISSING' && b.date === '2026-11-08'),
          `★ REC-5 不成立：删台账后未报 LEDGER_MISSING（breaks=${JSON.stringify(v.breaks)}）`);
      }
      // ③ 删一张摘要 → S-1 无链可断（不得报 CHAIN_BREAK），且"可重出"才是真保证（ensureReceipts 补回）
      {
        const { lab, anchor } = mk('regen');
        expect(I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-08' }).ok, '前置失败：摘要 1 未生成');
        expect(I.rec.writeDailyReceipt({ root: lab.root, anchorRoot: anchor, dateISO: '2026-11-09' }).ok, '前置失败：摘要 2 未生成');
        fs.unlinkSync(I.rec.receiptPath(anchor, '2026-11-09'));
        const v1 = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
        const regen = I.rec.ensureReceipts({
          root: lab.root, anchorRoot: anchor, dates: ['2026-11-09'],
          todayISO: '2026-11-10', nowMs: Date.parse('2026-11-10T10:00:00+08:00'),
        });
        const v2 = I.rec.verifyReceipts({ root: lab.root, anchorRoot: anchor });
        L.rmLab(lab);
        expect(!v1.breaks.some((b) => b.type === 'CHAIN_BREAK'),
          `★ REC-5 不成立：删摘要后报了 S-1 已裁掉的 CHAIN_BREAK（breaks=${JSON.stringify(v1.breaks)}）`);
        expect(v1.days === 1, `★ REC-5 不成立：删一张后核验天数应为 1（实际 ${v1.days}）`);
        expect(regen.ok && Array.isArray(regen.written) && regen.written.includes('2026-11-09'),
          `★ REC-5 不成立：删掉的摘要不可重出（ok=${regen.ok} written=${JSON.stringify(regen.written)} errors=${JSON.stringify(regen.errors)}）`);
        expect(v2.ok && v2.days === 2, `★ REC-5 不成立：重出后仍未回绿（ok=${v2.ok} days=${v2.days} breaks=${JSON.stringify(v2.breaks)}）`);
      }
    },
  });
}

// ★ v1.0.0 整改（准入审计 P0-04）：main() 返回的退出码必须**透传**给进程。
//   旧写法 `await main(...)` 丢弃了返回值 —— 实测 PASS 16 / FAIL 3 / ERROR 0 时进程仍 exit 0，
//   任何"返回 0 = P0 全过"的发布门都会被直接骗过（假绿）。
//   约定与 `docs/验收-v0.5/_runner.mjs` 一致：fail+error==0 且 skipped==0 → 0，否则 1。
//   用 `process.exitCode`（而不是 process.exit()）以便已排队的 stdout 正常冲刷。
const exitCode = await main(import.meta.url, {
  name: 'P0回归-v2',
  target: PLUGIN,
  build,
});
process.exitCode = exitCode;
