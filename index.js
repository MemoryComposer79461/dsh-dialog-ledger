/**
 * @file index.js
 * @role Host 侧入口 —— **只做注册与调度，不写业务逻辑**。
 * @called-by DSH 的插件加载器（通过 cordis.patch.yml 注册的 id）
 * @depends ./lib/encoder.js、./lib/ledger.js
 * @why 入口只干三件事：读配置、起定时器、把活派下去。
 *      业务全在 lib/ —— 那样才能"不装 DSH 也能测 lib"。
 *
 * ⚠️ 本文件里【不许】出现 fs.writeFile / 直接解析 JSON ——
 *    那些都是 lib 的职责。入口越薄，越好测。
 *
 * ⚠️ 本文件里【不许】调用任何模型 / 网络 ——
 *    记账必须能在断网时工作（2026-11-03 断网两次的教训）。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import {
  normalizeSessionId,
  dateSegment,
  isoTime,
  makeCode,
  parseCode,
  nextGen,
  nextSeq,
} from './lib/encoder.js';

import {
  readAll,
  appendTurn,
  readState,
  readStateEx,
  writeState,
  lostTurns,
  readTurnEventsBatch,
  readTurnsFrom,
  appendErrorEvent,
  readErrors,
  readErrorAttempts,
} from './lib/ledger.js';

// ★ C25（整 tick 聚合消费硬预算）：算"第一帧多长"必须用内核**同一套**结构分帧。
//   @why 绝不在 index 里另写一份魔数扫描：K-4 的教训就是"帧边界只能有一个权威"
//        （魔数会出现在压缩载荷里，扫出来的是假边界）。这里只**读**，不改内核。
import { frameSpan } from './lib/frames.js';

// 单实例写锁：同一数据总库同一时刻只允许一个实例写（P2-1）
import { acquire, release } from './lib/lock.js';

// ★ V0.7 采集换轨（影子双轨）：disk 仍是默认唯一写者；shadow 模式只写 .shadow/（设计见 docs/交付-v0.7/01）
import { createDiskCollector, createPersistenceCollector } from './lib/collector.js';
import { runShadowOnce, writeShadowTick } from './tools/shadow.js';

// v3 只读历史源：版本发现 / 选源 / 并存核验（见 lib/legacy.js 头部 @why）
import {
  scanSessionSources,
  readSourceTurns,
  readSourceTurnEvents,
  sourceFileName,
  resolvePairPrefixes,
} from './lib/legacy.js';
import { renderOriginal, writeOriginal } from './lib/original.js';
// P0-2（审计 A-01）：未闭合轮次只留 pending 证据，不进最终账行
import { recordPending } from './lib/pending.js';
// REC（库外收据锚）：回答审计问题 3「十年后谁能验证账没被改过」
import { ensureReceipts } from './lib/receipt.js';
import { weekOf, weeklyFileName, weeklyFolderName } from './lib/week.js';
import { draftNameOf } from './lib/weeklystate.js';
// ★ V0.8 库外 manifest 锚已冻结（S-1/§5.3）：lite 不追加、不核验锚；
//   配置键 manifestAnchorRoot / deliveryPackageDir 保留（配置面冻结，21 键不动），只是不再消费。
import { runCheckup } from './lib/checkup.js';
import {
  groupRecords,
  // ★ 0.9.4-re1（P3 接线）：周账由"逐组全量循环"改为 lib 的预算版（W3，常量 WEEKLY_BUDGET
  //   = 200 组 / 20 s，不新增配置键）；月账视图走 lib/weekly.js 第十三节。
  runWeeklyBudget,
  readWeeklySeals,
  // ★ 0.9.4-re1（W1）：封板 journal 尾读缓存（替代每 tick 整读 journal 的 KERNEL readSealEvents；
  //   返回形状同口径：readError/badLines/events/seals，事件为摘要、不带 rows）。
  readSealJournalState,
  LAYOUT_VERSION,
  findDueSealGroupIds,
  writeSupplement,
  writeMonthlyView,
  groupId as weeklyGroupId,
  sessKeyOf,
} from './lib/weekly.js';

// V0.6：Agent 工具面（只读）—— 注册失败不影响记账主职责
import { registerLedgerTools } from './tools/toolface.js';

// V0.6：左栏面板只读 HTTP API（可选依赖 webServer）—— 取不到就静默跳过，不影响记账
import { registerLedgerPanelApi } from './tools/panelapi.js';

// ★ 0.9.4-re1（P3 接线）：索引外部层（档 A，tools/pointerindex.mjs）── tick 收尾**只增量补当日分片**。
//   为什么放 tools 而不是 lib：本版不改核心边界（core 22 文件不动，core-boundary 放行 index→tools 边）。
//   索引是**派生数据、不是账务事实**：任何失败只 warn，不回滚、不进 errors。
//   C28 起入口改走 syncIndex（只读"新增尾"/只重写当日分片；判定不了尾部追加时内部回退 buildIndex）。
import { syncIndex } from './tools/pointerindex.mjs';

// 交接表（表头目录）已冻结（S-1/§5.3）：lite 不生成、不认领、不封板交接表；
//   配置键 handoverEnabled / handoverAppendixMaxBytes 保留（配置面冻结，21 键不动），只是不再消费。

// 封板证据（P1-9/D12）：journal 是唯一权威；每轮只读一次，缓存后注入
// backfillPlan（周账封板），避免每会话重读。（lite：交接表封板不再消费。）
// ★ 0.9.4-re1：读取改走 lib/weekly.js 的 readSealJournalState()（W1 尾读缓存，见 import 处说明）。
// D7 对账骨架（**纯只读**）：只报不修；okStrict 是"禁止下无/0结论"的闸门（见 ⑦c）
import { reconcile } from './lib/reconcile.js';
// 补记链（BC-15）：只出只读计划，执行由本入口按 actions 调度
// 运行报告（RC-12/HL-10/HL-11/BC-15）：**唯一写者**是 lib/report.js（自 freeze/selfheal.js 抽出）；
//   入口只负责调用与传段 —— 审核层（freeze/）在运行期不可达。
import { writeRunReport } from './lib/report.js';
// ★ 0.9.3 P2-6（S-9）：逐 tick 度量写 `<root>/ledger/.tick-metrics.jsonl`（append-only）。
//   为什么单独一个 lib 模块而不是写在 index：入口纪律"不写盘、不解析 JSON"，写盘只许在 lib/。
import { appendTickMetrics } from './lib/tickmetrics.js';
import { classifyGate } from './lib/gate.js';
// ★ V0.6.2（机主已签《v0.6.2-迁移规格-v1》）：一级布局探测（新子目录/旧一级散落单据）。
//   本模块只**读**，不搬任何文件 —— 迁移由 docs/工具-迁移布局.mjs 显式执行（默认 dry-run）。
import { detectLayout } from './lib/layout.js';

// ★ V0.6.2：账库根标记 `.ledger-root`（§1.2）+ 默认落点（§1.1）—— 由 lib/ledgerroot.js 唯一实现。
//   marker 是"账库身份证"：清理/迁移/打包工具都靠它认账库、靠它拒绝越界操作。
import { DEFAULT_ROOT_NAME, defaultRootDir, ensureRootMarker } from './lib/ledgerroot.js';
// ★ V0.6.2：《账簿总目录》生成（§2.3，人读导航，不参与对账）—— 由 lib/catalog.js 唯一实现。
import { writeCatalog } from './lib/catalog.js';

// ---------------------------------------------------------------------------
// v0.5 周期常量（★ 2026-11-09 口径：**不新增配置键** —— 配置面今夜冻结，
//   release 按现有 19 键落 cordis.patch.yml。周期先用模块内常量，
//   正式版若要可配再走"DEFAULTS + readConfig 归一化 + run-report 字段"三处齐。）
// ---------------------------------------------------------------------------

/** 对账 + 运行报告的周期（毫秒）。契约建议 1440min；快照版取 60min 便于观察。 */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// ★ 0.9.3 · P2 稳产（S-9 口径）：tick 时间/字节预算 + 事件读有界 + 身份采样
//
//   纪律（同 v0.5）：**一律模块常量，不新增配置键**（配置面冻结）。
//   时间维：runOnce 单 tick 目标 ≤30 s。scanBudgetMs 仍生效（只允许更小），
//           但**不允许超过硬顶**：留 2 s 给 state/run-report/.tick-metrics 收尾。
//   字节维：单 tick 源消费 ≤17 MiB（= S-9 的"单会话单 tick 消费"上界，release 值
//           17,825,792 B）。超了就先收已提交批、剩下的下一 tick 续（幂等闸门保证不重复）。
//
//   ★ 语义口径（K-2 已签：`maxBytes`/`windowBytes` 是**预算**，不是物理字节承诺）：
//     · maxBytes   = "本次最多解多少字节"（帧边界停；frames.js 自行解释）；
//     · windowBytes= "单次系统读的窗口粒度"（决定读放大的过冲上限）；
//     真正的读盘字节由 `_工作\tools\measure-tick.mjs` 从 fs 层实测，产品侧只记估算。
// ---------------------------------------------------------------------------

/** tick 硬顶（毫秒）：单 tick ≤30 s 的目标里留 2 s 收尾。 */
const TICK_HARD_MS = 28000;
/** 单 tick 源消费字节预算（17 MiB = S-9 口径）。 */
const TICK_READ_BUDGET_BYTES = 17 * 1024 * 1024;

// ---------------------------------------------------------------------------
// ★ C25（第一台审计 §3 红项 2）：**整 tick 聚合消费**硬预算。
//
//   旧实现的两道闸（"每会话 16 MiB" + "已消费 ≥17 MiB 才不开新会话"）漏掉了一个事实：
//   lib/frames.js 的 `maxBytes` 是**帧边界预算**——`consumed === 0` 时第一帧不受它约束，
//   无论多大都会整帧解出来。DSH 的 v3 会话常见「头帧 237 B + 整份内容一个巨帧 1.09 MB」，
//   于是"剩余预算只剩 20 B / 853,834 B"时开读，仍会整帧消费 → 实测：
//     · tick1 聚合 17,826,010 B（越 218 B）；tick2 聚合 18,062,738 B（越 236,946 B）；
//   越界量正好是"剩余预算不足一帧时那一帧的长度"。所以硬顶不能靠"少开一个会话"，
//   必须**开读前先知道第一帧多长**：放不下就整会话延后到下一 tick（游标停在已提交前缀）。
//
//   @why "headroom" 仍然保留：首帧探测/坏帧恢复/文件在探测与读取之间被改写等边界
//        都只能证明"正常情况下不越界"，留 512 KiB 安全垫（必须 < 17MiB−16MiB，
//        否则 E3 单会话 16 MiB/tick 的 3 tick 指标会被这条预算拖成 4 tick）。
//   @why 全部模块常量：配置面已冻结（21 键不动），不新增配置键。
// ---------------------------------------------------------------------------
/** 截断读（本 tick 读不完的会话）预留的安全垫：吸收探测与读取之间的边界误差。 */
const TICK_READ_HEADROOM_BYTES = 512 * 1024;
/** 会话级最小可读片：本 tick 能授给一个会话的扫描额度低于它就没意义，整会话延后。 */
const TICK_READ_MIN_SLICE_BYTES = 64 * 1024;
/** 首帧探测的读取上界：第一帧超过它 → 本 tick 判"放不下"。实测语料最大帧 1,855,173 B。 */
const TICK_READ_PROBE_MAX_BYTES = 4 * 1024 * 1024;
/** 首帧探测的首窗（且探测按 ≤4× 增长；首帧通常只有 200 B 量级，避免白读 8 KiB）。 */
const TICK_READ_PROBE_FIRST_WINDOW = 8 * 1024;
/** S-9① 读放大：≤2.5× ⇒ 单 tick 读盘估算 ≤40 MiB（判据 C25 的 C25_READ_LIMIT 同值）。 */
const TICK_READ_AMP_LIMIT_BYTES = 40 * 1024 * 1024;

/** 扫描遍的帧读窗口（字节）：预算 16 MiB 时过冲从"≥8 MiB 一整窗"降到 ≤1 MiB。 */
const SCAN_READ_WINDOW_BYTES = 1024 * 1024;
/** 事件批读的帧读窗口（字节）：越小过冲越小（frames 每次系统读按窗口走）。 */
const EVENT_READ_WINDOW_BYTES = 16 * 1024;
/** 事件批读的余量（字节）：覆盖"末轮 turn/end 所在帧"的帧长；不够时由重试放大预算兜底。 */
const EVENT_READ_MARGIN_BYTES = 32 * 1024;
/** 事件批读单次上界（字节）：单会话单批不超过 8 MiB（超出靠重试，不靠无界读）。 */
const EVENT_READ_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 事件批读的预算放大重试次数（首读 + 3 次重试；只在"本批轮次没集齐/读不全"时发生，不静默）。
 *
 * ★ v1.0.0-snap（K-16 双管·上半）：**3 → 4**。
 *   @why 原来的阶梯是 64 KiB → 1 MiB → 4 MiB（×4 增长，第三次封顶 4 MiB），而上界是 8 MiB ——
 *        也就是说 `EVENT_READ_MAX_BYTES` 这个常量在三次里**永远够不到**。
 *        单帧 > 4 MiB 的会话（审计实测 5.24 MB）因此"数学上读不全"：每次重试都停在同一个帧边界，
 *        上层看到 truncated → 整批不落账 → 游标不推进 → 下一 tick 重读 → **会话永久 0 行**。
 *        加到 4 次后阶梯是 64 KiB → 1 MiB → 4 MiB → **8 MiB**，4–8 MiB 的单帧能一次读穿。
 *   边界：> 8 MiB 的单帧仍然跨不过去（上界不许无界放大）—— 那一半按"宁丢该轮、不丢会话"处理，
 *        见本文件 `readEventsBounded` 的预算耗尽分支（结构化跳过 + 可见 + 游标前进）。
 */
const EVENT_READ_ATTEMPTS = 4;
/**
 * 事件批"轮数上限"自动缩批的下限（轮）。
 * @why P0-3 的原设计是"事件数超 500 → 下一批减半"，为的是内存有界；
 *      但巨帧会话里一次巨帧会让 batchTurns 从 32 一路缩到 4–8，导致**同一巨帧被逐批重读**
 *      （E3 实测：86 轮巨帧 1.86 MB 被读 10+ 次，读放大近翻倍）。
 *      内存上界本来由 eventBatchBytes（单批帧跨度 ≤4 MiB）与"批后立即释放"保证，
 *      所以只给缩批设一个下限（= 契约值 32，即**不放大任何配置值、批仍 ≤eventBatchTurns**），
 *      而"事件数超预算"仍按原设计如实标 oversize（INV-11/12 的证据不变）。
 */
const EVENT_BATCH_TURNS_FLOOR = 32;
/** 尾指纹取样字节数（与 headFingerprintBytes 同语义；不新增配置键）。 */
const TAIL_FP_BYTES = 4096;
/** 同一会话连续失败多少次进入退避（P2-5）。 */
const SESSION_FAIL_BACKOFF_AFTER = 3;
/** 退避持续多少个 tick（按 intervalSeconds 折算成墙钟，至少 10 轮）。 */
const SESSION_FAIL_BACKOFF_TICKS = 10;

/** 补记链只读计划的周期（毫秒）。交接组建议 360min：24h/3d 窗口，不必每轮扫。 */

/**
 * 周期节流的"上次运行时刻"（进程内）。
 *
 * @why 不放 state：state 的键是**磁盘契约**，今夜不该为一个节流再加键；
 *      进程重启后首轮重算一次，代价可接受，语义也更保守（宁可多算一次，不漏一次）。
 */
let lastReconcileAtMs = 0;

/**
 * ★ P1-02（本机测试报告）：上一轮对账快照 + 行数基线。
 *
 * @why 对账是 1 小时节流（RECONCILE_INTERVAL_MS）。旧实现只在"有对账结果"的 tick 写 run-report，
 *      于是首小时后报告一直是**首 tick 快照**（台账 472/522 行、gate=ok），面板与设备自检都读它 ——
 *      实测出现"报告说 ok，实际已有未闭合轮缺口"的**假绿**。
 *      现在：没有对账的 tick 也写报告，但必须**标注快照时间**，并把本 tick 才可见的缺口
 *      （未闭合轮 / 补记待补）**叠加**到对外 gate 上（degraded，不许 ok）。
 */
let lastReconcileStat = null;
let lastLedgerRows = 0;
/** ★ K-25 测试钩子：apply 侧"取锁重试间隔"（生产恒 30s；只给回归用例缩短等待）。 */
let lockRetryMsOverride = 0;
/** 自上次对账以来累计写入的行数（用于"真实行数"估算；对账一到就清零，因为 rec.ledgerRows 已含） */
let writtenSinceReconcile = 0;

/**
 * ★ 0.9.4-re1（P3 接线）：月账视图"每天首次 tick"的进程内节流键（YYYYMMDD，+08:00 口径）。
 *
 * @why 不放 state：state 的键是**磁盘契约**，本版不为一个"派生只读视图"的节流再加键
 *      （纪律同上面的 lastReconcileAtMs：进程重启后首 tick 重算一次；指纹不变则不重写，
 *      代价可接受，语义也更保守 —— 宁可多算一次，不漏一次）。
 * @why 不是"必须每天手动跑"：每周账真的写盘后也会按"该组所属月"刷新，见 ⑦a-2。
 */
let lastMonthlyViewYmd = '';

// ---------------------------------------------------------------------------
// ★ re3（审计③ ARCH-01 / RT-01）：tick 内**真实读盘字节**计量（fs 层），以及自适应挂载健康度。
//
// @why RT-01：旧 tick-metrics 的 readBytes 是"扫描消费 + 事件读预算 + 指纹 + state"的**估算**，
//   对账轮的真实读盘（审计实测 ~175 MiB、同步阻塞 2.3–2.4 s）完全不在度量里 —— 稳态自报低 4.9×。
//   这里在 runOnce 的同步执行窗口内给 fs.readFileSync/fs.readSync 套一层计数：
//   runOnceCore 里唯一的 await（批间 setImmediate）用 readMeterYieldTurn 暂停计量，
//   保证"计入的字节 = 本 tick 同步段真读"，不把别的异步任务算进来。
//   ⚠️ 这只是**观测**：计量失败/被别的代码改回都不影响读取本身；finally 必还原。
// ---------------------------------------------------------------------------
/** 当前激活的读盘计量器（同一时刻只允许一个）。 */
let activeReadMeter = null;
/** 并发 tick（跨 root 双实例等）导致的"计量器共享"层数：>0 时真读字节不可归因，按 0/不可用上报。 */
let readMeterSharedDepth = 0;

/** 开始计量（重复调用返回 shared token，不会二次包装）。 */
function beginReadMeter() {
  if (activeReadMeter) {
    // @why 不二次包装：再包一层会把"另一个 tick 的读"算进本轮（同步段虽互斥，但 await 点会交错）。
    //   共享期间真读字节**不可归因** → 本轮按 0 上报并置 readMeterShared=true（不伪造归属）。
    readMeterSharedDepth += 1;
    activeReadMeter.tainted = true;
    return { shared: true, meter: { bytes: 0, reads: 0, paused: 1, tainted: true, restore: () => {} } };
  }
  const origReadFileSync = fs.readFileSync;
  const origReadSync = fs.readSync;
  const meter = { bytes: 0, reads: 0, paused: 0, tainted: false, restored: false };
  const wrappedReadFileSync = function (...args) {
    const out = origReadFileSync.apply(this, args);
    if (!meter.paused) {
      try {
        if (typeof out === 'string') meter.bytes += Buffer.byteLength(out, 'utf8');
        else if (out && typeof out.length === 'number') meter.bytes += out.length;
        meter.reads += 1;
      } catch { /* 计量失败不影响读取 */ }
    }
    return out;
  };
  const wrappedReadSync = function (...args) {
    const n = origReadSync.apply(this, args);
    if (!meter.paused && Number.isFinite(n) && n > 0) {
      meter.bytes += n;
      meter.reads += 1;
    }
    return n;
  };
  fs.readFileSync = wrappedReadFileSync;
  fs.readSync = wrappedReadSync;
  meter.restore = () => {
    if (meter.restored) return;
    meter.restored = true;
    // 只在"还是我们包的那层"时还原，避免把别人后来打的补丁冲掉。
    if (fs.readFileSync === wrappedReadFileSync) fs.readFileSync = origReadFileSync;
    if (fs.readSync === wrappedReadSync) fs.readSync = origReadSync;
    if (activeReadMeter === meter) activeReadMeter = null;
  };
  activeReadMeter = meter;
  return { shared: false, meter };
}

/** 结束计量（shared token 只退回共享层数）。 */
function endReadMeter(token) {
  if (!token) return;
  if (token.shared) {
    readMeterSharedDepth = Math.max(0, readMeterSharedDepth - 1);
    return;
  }
  try { token.meter.restore(); } catch { /* 还原失败不影响记账 */ }
}

/** 计量器当前累计字节（没有计量器 / 共享期间不可归因 = 0）。 */
function readMeterBytes() {
  if (readMeterSharedDepth > 0) return 0;
  return activeReadMeter ? activeReadMeter.bytes : 0;
}

/**
 * 批间让出事件循环时**暂停计量**：runOnceCore 里唯一的 await 点。
 * @why 暂停期间别的异步任务（宿主/前一轮残留 tick）的读盘不能算进本 tick 的度量。
 */
function readMeterYieldTurn() {
  const m = activeReadMeter;
  // 计量器被共享（并发 tick）时已不可归因：不做暂停，避免把别人的计量状态改坏。
  if (!m || m.tainted || readMeterSharedDepth > 0) return new Promise((resolve) => setImmediate(resolve));
  m.paused += 1;
  return new Promise((resolve) => {
    setImmediate(() => {
      m.paused = Math.max(0, m.paused - 1);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// ★ re3（审计③ ARCH-04）：可选增强面（Agent 工具 / 左栏面板 API）的挂载健康度。
//
// @why 旧实现重试 40 次（≈2 min）后 clearInterval 永久放弃，失败只写系统临时目录的
//   `dsh-dialog-ledger-startup.log` —— 账库/运行报告/面板里都看不到"工具面没挂上"，
//   HMR/服务晚就绪后也永远不恢复。现在：
//   ① 健康度快照（moduleMountHealth）由 runOnce 带进 stat → tick-metrics 的 `mount` 段、
//      `.state.json` 的 `lastStat.mount`、运行报告 `warnings`（可查、可审计）；
//   ② 快速窗口（3 s × 40）结束后**不永久放弃**，退化为 60 s 慢重试（HMR/晚就绪可恢复）；
//   ③ mountOnce 可重入：注册 0 条 = 没挂上（不得置 mounted=true）；已挂载重复调用幂等。
// ---------------------------------------------------------------------------
/** 最近一次 apply 的挂载健康度（runOnce 只读快照；未 apply 时为 null）。 */
let moduleMountHealth = null;

/** 深拷一份挂载健康度（runOnce 用；绝不能把可变引用带进 stat 后被 tick 内部改掉）。 */
function snapshotMountHealth() {
  const h = moduleMountHealth;
  if (!h || typeof h !== 'object') return null;
  const one = (x) => {
    const s = x && typeof x === 'object' ? x : {};
    return {
      mounted: s.mounted === true,
      registered: Number.isFinite(Number(s.registered)) ? Number(s.registered) : 0,
      attempts: Number.isFinite(Number(s.attempts)) ? Number(s.attempts) : 0,
      lastError: typeof s.lastError === 'string' ? s.lastError : '',
      mountedAt: typeof s.mountedAt === 'string' ? s.mountedAt : '',
      gaveUpAt: typeof s.gaveUpAt === 'string' ? s.gaveUpAt : '',
    };
  };
  return {
    v: 1,
    ok: h.ok === true,
    degraded: h.degraded !== false,
    phase: typeof h.phase === 'string' ? h.phase : '',
    attempts: Number.isFinite(Number(h.attempts)) ? Number(h.attempts) : 0,
    startedAt: typeof h.startedAt === 'string' ? h.startedAt : '',
    updatedAt: typeof h.updatedAt === 'string' ? h.updatedAt : '',
    okAt: typeof h.okAt === 'string' ? h.okAt : '',
    gaveUpAt: typeof h.gaveUpAt === 'string' ? h.gaveUpAt : '',
    tools: one(h.tools),
    webServer: one(h.webServer),
  };
}

/** 给 tick 用的一句话（warnings → 运行报告/日志；用户/审计可读）。 */
function mountHealthWarning(h) {
  const one = (name, x) => (x && x.mounted === true
    ? name + '=ok(' + x.registered + ')'
    : name + '=未挂载' + (x && x.lastError ? '（' + x.lastError + '）' : ''));
  return '可选增强面挂载未就绪：' + one('tools', h.tools) + '、' + one('webServer', h.webServer) +
    '；已尝试 ' + h.attempts + ' 次' + (h.gaveUpAt ? '（快速窗口已于 ' + h.gaveUpAt + ' 结束，退化为 60 s 慢重试）' : '') +
    '。记账不受影响（可选增强），健康度见 .tick-metrics 的 mount 段 / .state.json 的 lastStat.mount';
}

/**
 * 锁跳过 / 取锁失败 tick 的逐 tick 度量记录（FAIL-03）。
 *
 * @why 这类轮次"什么都没做"是**正常的**（别人持锁），但"这一轮为什么什么都没做"必须可查：
 *   旧实现只有一条 INFO 日志，度量层完全看不到 → 无法事后统计锁冲突、也无法把
 *   "度量行数 ≠ tick 数"解释清楚。字段形状与正常 tick 行对齐（ms/phases/io/counters 都在），
 *   另加 `lockSkipped/lock` 段；**不写 state、不推进游标**的口径不变（只追加旁证）。
 * @param {object} cfg 已解析配置（至少含 root/offsetMinutes）
 * @param {object} stat 该轮的最小 stat（tickStartedAtMs/lock/errors/warnings）
 * @returns {object} 度量记录（由调用方 appendTickMetrics）
 */
function buildLockSkipMetric(cfg, stat) {
  const offsetMinutes = cfg && Number.isFinite(cfg.offsetMinutes) ? cfg.offsetMinutes : DEFAULTS.offsetMinutes;
  const finishedAtMs = Date.now();
  const startedAtMs = stat && Number.isFinite(stat.tickStartedAtMs) && stat.tickStartedAtMs > 0
    ? stat.tickStartedAtMs
    : finishedAtMs;
  const lock = stat && stat.lock && typeof stat.lock === 'object' ? stat.lock : {};
  const zeroCounters = {
    skipped: 0, unchanged: 0, incremental: 0, partialReads: 0, deferred: 0, deferredTurns: 0,
    byteDeferredSessions: 0, prefixDeferred: 0, eventAmpDeferredBatches: 0, firstFrameUnbounded: 0,
    resumedSessions: 0, eventBatches: 0, eventReadRetries: 0, eventShortBatch: 0, eventTruncatedBatch: 0, blockedSources: 0,
    sessionCrashed: 0, quarantined: 0, quarantineNew: 0, retried: 0, firstRun: false,
    hotWindowExempted: 0, unfinishedCursors: 0, tailRewrites: 0, identityRewrites: 0,
  };
  return {
    v: 1,
    // ★ re3（K-12 消费侧）：本次 tick 的实例标识（apply 每实例唯一；直接 runOnce 可为 ''）。
    instanceId: cfg && typeof cfg.instanceId === 'string' ? cfg.instanceId : '',
    ts: isoTime(finishedAtMs, offsetMinutes),
    tsUtcMs: finishedAtMs,
    tickId: `${process.pid}-${startedAtMs}`,
    ms: Math.max(0, finishedAtMs - startedAtMs),
    readBytes: 0,
    readBytesKind: 'estimate-product-side',
    realReadBytes: 0,
    realReads: 0,
    realReadBytesShared: false,
    written: 0,
    scanned: 0,
    cancelled: false,
    abortedCommit: false,
    lockSkipped: true,
    lock: {
      skipped: true,
      reason: typeof lock.reason === 'string' ? lock.reason : 'unknown',
      holderPid: lock.holderPid === undefined ? null : lock.holderPid,
      holderHostname: typeof lock.holderHostname === 'string' ? lock.holderHostname : '',
      error: typeof lock.error === 'string' ? lock.error : '',
    },
    budget: {
      scanBudgetMs: null, effectiveMs: null, hardMs: TICK_HARD_MS, readBytes: TICK_READ_BUDGET_BYTES,
      saturated: false, deferredSessions: 0, byteDeferredSessions: 0, overHardCap: false, deferredSegments: [],
    },
    cache: { degraded: false, rowCount: 0, maxResidentRows: ledgerCacheCaps.maxResidentRows },
    timeDeferredSessions: 0,
    sessionsErrored: 0,
    stalledDetected: 0,
    stalled: [],
    phases: {
      scanMs: 0, eventsMs: 0, persistMs: 0, weeklyMs: 0, reconcileMs: 0, reportMs: 0,
      indexMs: 0, catalogMs: 0, receiptMs: 0, monthlyMs: 0, deferredSegments: [], otherMs: 0,
    },
    io: {
      consumedSourceBytes: 0, eventReadBudgetBytes: 0, headFpBytes: 0, tailFpBytes: 0, stateBytes: 0,
      probeBytes: 0, realReadBytes: 0, scanReadBytes: 0, weeklyReadBytes: 0, stateReadBytes: 0,
      catalogReadBytes: 0, indexReadBytes: 0, receiptReadBytes: 0, reconcileReadBytes: 0, reportReadBytes: 0,
    },
    counters: zeroCounters,
    mount: snapshotMountHealth(),
    errors: Array.isArray(stat && stat.errors) ? stat.errors.slice(0, 8) : [],
    warnings: Array.isArray(stat && stat.warnings) ? stat.warnings.slice(-8) : [],
  };
}

/** 写锁跳过度量行；失败只进 stat.warnings（旁证写不进去不许拖垮"跳过"语义）。 */
function writeLockSkipMetric(cfg, stat) {
  try {
    const wr = appendTickMetrics(cfg.root, buildLockSkipMetric(cfg, stat));
    if (wr && wr.ok === true) {
      stat.tickMetricsPath = wr.path;
      return wr;
    }
    if (!Array.isArray(stat.warnings)) stat.warnings = [];
    stat.warnings.push('lock-skip tick-metrics write failed: ' + ((wr && wr.error) || '?'));
    return wr;
  } catch (e) {
    if (!Array.isArray(stat.warnings)) stat.warnings = [];
    stat.warnings.push('lock-skip tick-metrics build failed: ' + (e && e.message ? e.message : String(e)));
    return null;
  }
}

/** 插件名（导出给 DSH 用）。 */
export const name = 'dsh-dialog-ledger';

// ---------------------------------------------------------------------------
// 台账索引缓存（P1-4 / P2-4）
//
// @why 为什么要有它：
//   原实现每 60 秒无条件 readAll + 全表 parseCode + 全表 groupRecords；
//   20 万条账时空转一次 1.13s，且是同步 IO —— 直接占住事件循环。
//   账只增不减，所以这条曲线只会越来越糟。
//
// @why 为什么用"文件指纹"判断失效：
//   台账是"只追加"的 jsonl，文件大小和 mtime 变了就说明有外部写入。
//   指纹 = 每个日账文件的 `名字:大小:mtime`，成本 O(文件数)，与记录数无关。
//
// @why 为什么编号也放进来：
//   nextSeq/nextGen 原来是全表扫描（O(N)），配合"每轮一次"就是 O(N²)。
//   缓存里放 seqMax / genOwner，分配降到 O(1)。
// ---------------------------------------------------------------------------
let ledgerCache = null;

// ---------------------------------------------------------------------------
// ★ P1-04（准入审计 P1-04 · 机主裁定 V1.0 前解决）：常驻索引缓存的**硬上限 + 淘汰**。
//
// @why 旧实现的风险：ledgerCache 的 records/existing/knownCodes/seenTurns/knownBySid/minTurn
//   /seqMax/genOwner/sidGen 全部随台账行数单调增长且**永不清空**。20 万行 ≈ 120–200 MB
//   （审计推算），三年库会更大；与"宿主 OOM 历史"叠加就是运行期事故。周账侧早有
//   ROW_CACHE_MAX_ROWS，索引侧没有 —— 这是不对称。
// @why 为什么"超限就整份淘汰"而不是"淘汰一部分"：records 是**周账分组**的输入
//   （tick 内 `const all = records`），少一行就是账实不符；而 knownCodes/seenTurns 少一条
//   虽不丢账（appendTurn 有查盘兜底），却会让"跳过/已记过"的计数失真。
//   → 整份淘汰 = 语义上只有"这一轮重新读一遍"，没有任何静默改变。
// @why 为什么峰值仍是 O(台账)：读写正确性要求本轮能看到全部行。上限约束的是**常驻**
//   （跨 tick 不释放）而不是本轮峰值；淘汰后下一轮重新 readAll，内存回到基线。
//   代价（每轮一次全量读）会进 tick-metrics（cacheDegraded=true），可观测、可解释。
// ---------------------------------------------------------------------------
const LEDGER_CACHE_MAX_RESIDENT_ROWS = 200000;
/** 测试可下调（__test__.setLedgerCacheCaps）；生产恒为上面的常量。 */
let ledgerCacheCaps = { maxResidentRows: LEDGER_CACHE_MAX_RESIDENT_ROWS };

/**
 * ★ m7（审计 m7）：索引同步失败退避（进程内）。
 * @why 索引是派生数据：失败一次不该每 tick 都硬碰（大库上每次重建都是全量读）。
 *      失败 n 次 → 退避 n 个 interval（上限 10 个）；成功一次清零。
 * @why 放进程内、不进 state：state 的键是磁盘契约，不为一个"重试节奏"加键
 *      （语义同 lastReconcileAtMs：重启后多试一次，更保守）。
 */
let moduleIndexBackoff = { fails: 0, untilMs: 0 };

/** 台账目录指纹（文件名:大小:mtime）。 */
function ledgerFingerprint(root) {
  const dir = path.join(root, 'ledger');
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'));
    return names.map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return `${n}:${st.size}:${st.mtimeMs}`;
    }).join('|');
  } catch {
    return '';
  }
}

/** 建/复用台账索引。 */
function ensureLedgerIndex(root) {
  const fp = ledgerFingerprint(root);
  if (ledgerCache && ledgerCache.root === root && ledgerCache.fp === fp) return ledgerCache;

  // ★ P1-8（审计 M-04）：读取失败 ≠ 空数据。
  //   readAll 现在返回 ok / readErrors / emptyProven：只有"成功读完且确实为空"才算空。
  const all = readAll(root, { quarantine: true });
  const { records, badLines } = all;
  const cache = {
    root, fp, records, badLines,
    ledgerOk: all.ok !== false,
    readErrors: Array.isArray(all.readErrors) ? all.readErrors : [],
    emptyProven: all.emptyProven === true,
    // ★ P0-3-resume：本次读取里"崩溃撕裂尾巴"被自愈的记录（lib/ledger 三条硬条件全满足才修）。
    //   这里只做**留痕传递**：日志 WARN + stat + state，不参与任何状态机判断。
    tornTailRepaired: Array.isArray(all.tornTailRepaired) ? all.tornTailRepaired : [],
    knownCodes: new Set(),
    seenTurns: new Set(),
    minTurn: new Map(),   // sid → 已入账的最小 turn（交接表"接管前上下文"的切点）
    knownBySid: new Map(),
    existing: [],
    seqMax: new Map(),     // `${s12}|${gen}` → 最大序号
    genOwner: new Map(),   // `${s12}|${gen}` → sid
    sidGen: new Map(),     // sid → gen（同一会话固定代号）
    badCodes: 0,
  };
  for (const r of records) {
    if (!r) continue;
    if (r.code) cache.knownCodes.add(r.code);
    if (typeof r.sid === 'string' && Number.isInteger(r.turn)) {
      cache.seenTurns.add(r.sid + '#' + r.turn);
      const cur = cache.minTurn.get(r.sid);
      if (cur === undefined || r.turn < cur) cache.minTurn.set(r.sid, r.turn);
    }
    if (typeof r.sid === 'string') cache.knownBySid.set(r.sid, (cache.knownBySid.get(r.sid) || 0) + 1);
    const p = parseCode(String(r.code || ''));
    if (!p) { if (r.code) cache.badCodes++; continue; }
    cache.existing.push({ s12: p.s12, gen: p.gen, seq: p.seq, sid: r.sid || '' });
    const key = `${p.s12}|${p.gen}`;
    cache.seqMax.set(key, Math.max(cache.seqMax.get(key) || 0, p.seq));
    cache.genOwner.set(key, r.sid || '');
    if (typeof r.sid === 'string') cache.sidGen.set(r.sid, p.gen);
  }
  // ★ P1-04：常驻上限判定（**本轮照用**，本轮结束后由 runOnce 淘汰，见那里的注释）。
  cache.rowCount = records.length;
  cache.ephemeral = records.length > ledgerCacheCaps.maxResidentRows;
  ledgerCache = cache;
  return cache;
}

/** 分配代号（同一会话固定；同 s12 撞车时 A→B→…）。 */
function pickGen(cache, s12, sid) {
  const known = cache.sidGen.get(sid);
  if (known) return known;
  for (let i = 0; i < 26; i++) {
    const g = String.fromCharCode(65 + i);
    const key = `${s12}|${g}`;
    const owner = cache.genOwner.get(key);
    if (!owner || owner === sid) {
      cache.sidGen.set(sid, g);
      if (!owner) cache.genOwner.set(key, sid);
      return g;
    }
  }
  return '';
}

/** 下一个序号（只 peek，不提交 —— 写失败时不能吃掉号）。 */
function nextSeqCached(cache, s12, gen) {
  return (cache.seqMax.get(`${s12}|${gen}`) || 0) + 1;
}

/** 写入成功后把记录并进缓存。 */
function rememberRecord(cache, r) {
  cache.records.push(r);
  if (r.code) cache.knownCodes.add(r.code);
  if (typeof r.sid === 'string' && Number.isInteger(r.turn)) {
    cache.seenTurns.add(r.sid + '#' + r.turn);
    const cur = cache.minTurn.get(r.sid);
    if (cur === undefined || r.turn < cur) cache.minTurn.set(r.sid, r.turn);
  }
  if (typeof r.sid === 'string') cache.knownBySid.set(r.sid, (cache.knownBySid.get(r.sid) || 0) + 1);
  const p = parseCode(String(r.code || ''));
  if (!p) return;
  const key = `${p.s12}|${p.gen}`;
  cache.existing.push({ s12: p.s12, gen: p.gen, seq: p.seq, sid: r.sid || '' });
  cache.seqMax.set(key, Math.max(cache.seqMax.get(key) || 0, p.seq));
  cache.genOwner.set(key, r.sid || '');
  cache.sidGen.set(r.sid || '', p.gen);
  cache.fp = null; // 本轮结束后刷新
}


/** 依赖 DSH 提供的服务。可空 —— 本插件不强制要谁。 */
export const inject = [];

/** 默认配置。用户可在 cordis.patch.yml 的 config 里覆盖。 */
const DEFAULTS = {
  /** 数据总库根目录。空字符串 = 用默认位置（见 resolveRoot）。 */
  root: '',
  /** 扫描周期（秒）。60 秒是 dsh-plugin-memory 的 autocommit 用的同一个值。 */
  intervalSeconds: 60,
  /** 是否启用定时扫描。 */
  enabled: true,
  /** 时区偏移分钟数。480 = UTC+08:00。★ 绝不取本机时区。 */
  offsetMinutes: 480,
  /** 只处理 mtime 在这么多秒内变过的会话（0 = 全部）。省得每次都解 36 MB。 */
  hotWindowSeconds: 3600,
  /**
   * 安静检测（秒）：一个"只有 turn/start、还没有 turn/end"的轮次，
   * 要等到会话文件至少这么久没被写入，才允许把它记成 partial。
   *
   * 为什么需要它：账只追加、编码是永久主键，所以"进行中被写成 partial"
   * 会造成永久错误（第二轮会被 (sid,turn) 闸门跳过，再也改不回来）。
   * 因此默认值取 120 秒：比扫描周期（60s）长一倍，足以躲过正常轮次。
   */
  quietSeconds: 120,
  /**
   * 单次扫描的时间预算（毫秒）。0 = 不限（仍受模块硬顶 TICK_HARD_MS=28000 约束）。
   * 到了预算就停下，剩下的会话留到下一轮 —— 这样 227 MB 的大会话
   * 不会把整个 60s 周期吃掉（P0-2）。
   *
   * ★ 0.9.3 P2-4（S-9）：**同键改值** 3000 → 30000（不新增配置键）。
   *   3 s 会在批边界反复截断大语料（E3 实测：一 tick 只入 48/1338 行后停摆）；
   *   C25 允许 30 s，所以预算放到 30 s（硬顶 28 s 留在 TICK_HARD_MS，2 s 收尾）。
   *   ⚠️ release 的 `cordis.patch.yml` 若仍写 3000，会覆盖本默认值 —— 同版必须同步改值。
   */
  scanBudgetMs: 30000,
  /**
   * 单个会话一次最多解多少字节。0 = 不限。
   * 16 MB ≈ 1 秒量级；超了就停在帧边界，下一轮接着读。
   */
  maxBytesPerSession: 16 * 1024 * 1024,
  /**
   * ★ P0-3（审计 A-03）：每批最多取多少轮的事件。
   * 原实现把本会话**所有**未入账轮次一次性取事件 —— 首跑时"新轮次"可能就是
   * 全部 1315 轮，于是在任何一条账写入前就集中占内存（v0.4 两次压死宿主的机理）。
   * 现在：批内取事件 → 批内落账 → 批后立即释放；默认 32 轮，内存有界。
   *
   * ★ 默认值口径（2026-11-09 对齐契约）：`v0.5-P0不变量契约.md:46` 明确
   *   `eventBatchTurns=32 / eventBatchEvents=500 / eventBatchBytes=4 MiB`，
   *   而实现曾是 40 / 4000 / 8 MiB —— 那是与契约的**实质偏离**（INV-11 按契约值判），
   *   已按契约改回。别为了"少开批"再把它们调大：三个数就是有界性的书面承诺。
   */
  eventBatchTurns: 32,
  /**
   * ★ P0-3 之二（研究组 task-19 实测指出）：**只限轮数不够**。
   * 一轮可能含 MB 级 tool/result，32 轮 × 5 MB = 160 MB 照样把宿主压死。
   * 审计 §13.3 第 5 条原话：预算"必须覆盖事件收集"，不能只覆盖帧扫描。
   * 所以三重预算：轮数 / 事件数 / 字节数，**任一触顶就收批**。
   *
   * ★ 默认值口径（2026-11-09 对齐契约）：`v0.5-P0不变量契约.md:46` =
   *   `eventBatchTurns=32 / eventBatchEvents=500 / eventBatchBytes=4 MiB`。INV-11 按契约值判。
   */
  eventBatchEvents: 500,
  eventBatchBytes: 4 * 1024 * 1024,
  /**
   * ★ P0-1（审计 A-02）：判断"文件是否真的没变"用的身份指纹字节数。
   * 只看 size 不够：同大小重写会被误判成"未变化"，新内容永久漏记。
   * 取文件头这么多字节算 sha256，与游标里存的指纹比对。
   */
  headFingerprintBytes: 4096,
  /**
   * ★ P0-2（审计 A-01）：未闭合轮次**不再写入台账**。
   * 原实现把"安静够久"的未闭合轮次记成 partial，而 (sid,turn) 闸门之后会
   * 永久跳过它 —— 真实 turn/end 到达也不修正，账永久不完整。
   * 现在改为：只在 `ledger/.pending.jsonl` 留 pending 证据，等轮次闭合再正常入账。
   */
  pendingMaxBytes: 1024 * 1024,
  /**
   * 体检开关：**默认关闭**（2026-11-08 定）。
   *
   * 为什么关：体检每跑一次就在数据总库一级留下一个 `CHK-*.md`，而这个插件
   * 还没有"删除/保留期"能力 —— 报告只增不减，等于用永久文件换一个"可能没人看"的结论。
   * 主调是稳定产出「周记账」，不是产出旁证文件。
   *
   * 需要时可以手动跑 `工具-partial对账.mjs`（只读、指定任意台账根目录），
   * 或临时把这里改成 true。将来若要做自动体检，必须先有"报告保留/清理策略"。
   */
  checkupEnabled: false,
  /** 体检节流：两次体检至少间隔这么久（毫秒），避免每轮都写报告。 */
  checkupIntervalMs: 3600000,
  /**
   * 周记账开关（v0.3）：按「会话键 + 月内周段」把记录汇成 xlsx。
   * 默认开 —— 这是插件的主产物。
   */
  weeklyEnabled: true,
  /**
   * 交接表开关（v0.4）：每会话只生成一次（主表 + 附表），封板后删了不重建。
   */
  handoverEnabled: true,
  /**
   * 交接表附表「接管前上下文」的读取上限（字节，默认 2 MiB）。
   * 附表只收第一条 turn/start 之前的事件（通常极短），
   * 为它解一整份 38 MB 会话不值得 —— 见 lib/legacy.js: readPrefixEvents @why。
   */
  handoverAppendixMaxBytes: 2 * 1024 * 1024,
  /**
   * ★ REC（库外收据锚）：收据写到**账本之外**的哪个目录。空 = 功能关闭（默认）。
   *
   * 为什么要"库外"：同机同目录里的哈希只能证明"自洽"，挡不住"有写权限者整体替换后重算"。
   * 收据链（每日一张 + 前序哈希）+ 第二物理位置，才回答得了审计问题 3「十年后谁能验证」。
   *
   * ★ 机主约定（2026-11-09）：**Agent 不读写 U 盘**。收据先落桌面目录，
   *   由机主手动搬进 U 盘；搬完可用 `docs/工具-核验收据.mjs --anchor=<U盘路径>` 只读自检。
   */
  receiptAnchorRoot: '',
  /**
   * ★ V0.8 库外 manifest 锚目录（默认 '' = 关闭）。
   *   开启后：每日一次追加账本快照锚；若同时配置 deliveryPackageDir，则检测到新 payloadHash 时追加交付包锚。
   *   必须在数据总库之外（与收据锚同一安全口径）；本插件不写 U 盘。
   */
  manifestAnchorRoot: '',
  /** 交付包目录（可选；给定时自动锚定新版本；只读扫描，绝不改包）。 */
  deliveryPackageDir: '',
  /**
   * ★ V0.9 Agent 清理工具总开关（默认 false = 关闭）。
   *
   * 为什么默认关：`ledger_cleanup_apply` 暴露给模型后，"默认可用"就等于把机主的原始凭证
   * 放在模型手边。清理必须"有据、有明确人类意志"（P0-6 红线）：
   * 关闭时 `dryRun:false` 一律拒绝（零删除）；`dryRun:true` 只产 `RPT-DRYRUN-*` 试运行报告，
   * 不受影响（预览永远可用）。
   */
  cleanupToolEnabled: false,
  /**
   * ★ V0.9 物理删除第二把锁（默认 false）。
   *
   * 为什么要两把锁：第一把只说明"允许 Agent 用这个工具"，第二把才是"允许真删文件"。
   * 机主可以长期只开第一把（让 Agent 能跑试运行报告），真要清一次时临时开第二把。
   * 工具层仍要求 confirm 短语 = 当前计划重算值（第三重），三重缺一零删除。
   */
  cleanupAllowPhysicalDelete: false,
  /**
   * ★ V0.7 补记执行器开关（默认 false = v0.6.7 行为：只产只读计划）。
   *   打开后按 backfillPlan.actions 执行（journal 先行、幂等、可重试）；
   *   本版只接 write-supplement，其余动作记 deferred 留痕。
   */
  backfillExecEnabled: false,
  /**    * ★ V0.7 采集换轨（默认 disk = 与 v0.6.7 完全一致）。
   *   mode: 'disk' | 'shadow' | 'persistence' | 'event'（设计见 docs/交付-v0.7/01）。
   *   shadow 只写 <root>/ledger/.shadow/，绝不写账本/原文/周账（I6）。
   */
  ingest: {
    mode: 'disk',
    /** 影子模式：另一源"领先未 flush"的良性窗口（毫秒）。 */
    shadowPendingMs: 120000,
    /** 影子模式：单轮最多比对多少会话（控成本）。 */
    shadowMaxSessions: 50,
  },
};

// ---------------------------------------------------------------------------
// ★ m-01（准入审计 · 机主裁定 V1.0 前解决）：声明 Config schema（配置页/校验用）。
//
// @why 为什么用「带兜底的动态导入」而不是顶层 `import Schema from 'schemastery'`：
//   本包的产品约束是**零第三方依赖**（package.json 不声明、包里不装 schemastery）。
//   DSH 宿主运行期提供的是 **`@deepseek-ai/schemastery`**（其它 @deepseek-ai 插件都这么用），
//   裸说明符 `schemastery` 只在少数 profile 的 node_modules 树下能解析到。
//   ★ re3（审计③ ARCH-03 / ② Config）：旧实现只试裸名 → 真机恒 undefined（审计已解析 asar
//     证实宿主只有 @deepseek-ai/schemastery），配置页因此永远没有 schema。
//     现在按 `@deepseek-ai/schemastery` → `schemastery` 顺序解析；都解析不到就如实降级
//     （Config 保持 undefined，等价修复前行为，激活/记账完全不受影响）——**绝不因此让模块加载失败**。
//
// @why 键集/默认值必须与 readConfig 的 27 个输入逐一对应、默认值与 DEFAULTS 一致：
//   否则配置页显示的默认值与记账实际走的值会是两个说法。
//   `docs\工具-身份一致性.mjs` ③ 核对 patch/readConfig/README 三处；本 schema 是**第四处**。
//   27 输入 = 24 个扁平键 + ingest 的 3 个子键（rootSource 是派生值，不是输入）。
//
// ⚠️ 未在真机 loader 上验收：本机不装宿主（保证机主 profile 干净），
//    「Config 被 Plugin Manager 读到并渲染配置页」只在桩 Schema 上做了结构断言。
// ---------------------------------------------------------------------------

/** schemastery 解析成功时 = 配置 schema；解析不到 = undefined（等价修复前行为）。 */
export let Config;

/**
 * 用给定的 Schema 构造 Config。
 *
 * @why 抽成函数：单测可用**桩 Schema** 验证 27 键与默认值（不必真的装 schemastery）；
 *      生产路径用真 schemastery。见 `__test__.buildConfigSchema`。
 * @param {object} Schema schemastery 默认导出（object/string/number/boolean/default/description/required）
 * @returns {object|undefined} 无可用 Schema 时返回 undefined
 */
function buildConfigSchema(Schema) {
  if (!Schema || typeof Schema.object !== 'function') return undefined;
  /** 一律 required(false)：所有键都是可选的（缺省走 readConfig 的 DEFAULTS 兜底）。 */
  const opt = (x) => {
    try { if (typeof x.required === 'function') return x.required(false); } catch { /* 桩/旧版无 required */ }
    return x;
  };
  const str = (d, desc) => {
    let x = Schema.string();
    try { if (desc && typeof x.description === 'function') x = x.description(desc); } catch { /* 无 description 不致命 */ }
    try { if (typeof x.default === 'function') x = x.default(d); } catch { /* 无 default 不致命 */ }
    return opt(x);
  };
  const num = (d, desc) => {
    let x = Schema.number();
    try { if (desc && typeof x.description === 'function') x = x.description(desc); } catch { /* 同上 */ }
    try { if (typeof x.default === 'function') x = x.default(d); } catch { /* 同上 */ }
    return opt(x);
  };
  const bool = (d, desc) => {
    let x = Schema.boolean();
    try { if (desc && typeof x.description === 'function') x = x.description(desc); } catch { /* 同上 */ }
    try { if (typeof x.default === 'function') x = x.default(d); } catch { /* 同上 */ }
    return opt(x);
  };
  try {
    return Schema.object({
      root: str(DEFAULTS.root, '数据总库根目录；空 = <用户桌面>\\会话账本'),
      intervalSeconds: num(DEFAULTS.intervalSeconds, '扫描周期（秒）'),
      enabled: bool(DEFAULTS.enabled, '总开关'),
      offsetMinutes: num(DEFAULTS.offsetMinutes, '时区偏移（480 = UTC+08:00）'),
      hotWindowSeconds: num(DEFAULTS.hotWindowSeconds, '只处理 mtime 在此秒数内变过的会话（0 = 全扫）'),
      quietSeconds: num(DEFAULTS.quietSeconds, '未闭合轮次的安静阈值（秒）'),
      scanBudgetMs: num(DEFAULTS.scanBudgetMs, '单轮扫描时间预算（毫秒，0 = 不限；仍受 28s 硬顶）'),
      maxBytesPerSession: num(DEFAULTS.maxBytesPerSession, '单会话单次读取上限（字节）'),
      eventBatchTurns: num(DEFAULTS.eventBatchTurns, '事件采集：每批最多轮数'),
      eventBatchEvents: num(DEFAULTS.eventBatchEvents, '事件采集：每批最多事件数'),
      eventBatchBytes: num(DEFAULTS.eventBatchBytes, '事件采集：每批最多字节数'),
      headFingerprintBytes: num(DEFAULTS.headFingerprintBytes, '文件身份指纹取样字节数'),
      pendingMaxBytes: num(DEFAULTS.pendingMaxBytes, '.pending.jsonl 证据文件上限（0 = 不留）'),
      checkupEnabled: bool(DEFAULTS.checkupEnabled, '体检开关（默认关）'),
      checkupIntervalMs: num(DEFAULTS.checkupIntervalMs, '体检节流（毫秒）'),
      weeklyEnabled: bool(DEFAULTS.weeklyEnabled, '周记账开关（主产物）'),
      handoverEnabled: bool(DEFAULTS.handoverEnabled, '交接表开关（lite 已冻结，运行期不消费）'),
      handoverAppendixMaxBytes: num(DEFAULTS.handoverAppendixMaxBytes, '交接表附表前缀读取上限（冻结，不消费）'),
      receiptAnchorRoot: str(DEFAULTS.receiptAnchorRoot, 'REC 日结摘要输出目录；空 = 关闭'),
      manifestAnchorRoot: str(DEFAULTS.manifestAnchorRoot, '库外 manifest 锚目录（lite 冻结，不消费）'),
      deliveryPackageDir: str(DEFAULTS.deliveryPackageDir, '交付包目录（冻结，不消费）'),
      cleanupToolEnabled: bool(DEFAULTS.cleanupToolEnabled, 'legacy 占位（清理工具已退役，运行期不消费）'),
      cleanupAllowPhysicalDelete: bool(DEFAULTS.cleanupAllowPhysicalDelete, 'legacy 占位（物理删除锁已退役）'),
      backfillExecEnabled: bool(DEFAULTS.backfillExecEnabled, '补记执行器（未接线，不消费）'),
      ingest: Schema.object({
        mode: str(DEFAULTS.ingest.mode, '采集换轨：disk/shadow/persistence/event（默认 disk）'),
        shadowPendingMs: num(DEFAULTS.ingest.shadowPendingMs, '影子模式良性窗口（毫秒）'),
        shadowMaxSessions: num(DEFAULTS.ingest.shadowMaxSessions, '影子模式单轮最多比对会话数'),
      }),
    });
  } catch {
    // 构造失败（残缺/不兼容的 schemastery）：宁可没有 Config，也不能让模块加载失败。
    return undefined;
  }
}

let schemaModule = null;
/** 解析成功时用的模块名（'' = 两个候选都没解析到，属降级分支）。 */
let schemaSpecifier = '';

/**
 * ★ re3（审计③ ARCH-03 / ② Config）：Config schema 的候选模块名（按优先级）。
 * @why 真机宿主只有 `@deepseek-ai/schemastery`；裸 `schemastery` 仅在少数 profile 可解析。
 *      顺序不许反：宿主名在前，裸名只作回退（两者都解析到时用宿主那份）。
 */
export const SCHEMA_MODULE_SPECIFIERS = Object.freeze(['@deepseek-ai/schemastery', 'schemastery']);

/**
 * 依次尝试候选模块，返回第一个可用的 schemastery 默认导出（必须带 object()）。
 *
 * @param {(spec:string)=>Promise<any>} [importer] 动态 import（测试可注入替身）
 * @returns {Promise<{Schema:object|undefined, spec:string, tried:string[]}>}
 *   全部失败时返回 `{Schema:undefined, spec:'', tried:[...]}` —— 调用方按"如实降级"处理，
 *   **本函数不抛**（解析不到是零依赖约束下的预期分支，不是异常）。
 */
export async function loadSchemaModule(importer = (spec) => import(spec)) {
  const tried = [];
  for (const spec of SCHEMA_MODULE_SPECIFIERS) {
    try {
      const mod = await importer(spec);
      const Schema = mod && (mod.default || mod);
      if (Schema && typeof Schema.object === 'function') return { Schema, spec, tried };
      tried.push(spec + ':no-object');
    } catch (e) {
      tried.push(spec + ':' + ((e && (e.code || e.message)) || 'ERR'));
    }
  }
  return { Schema: undefined, spec: '', tried };
}

try {
  const resolved = await loadSchemaModule();
  schemaModule = resolved.Schema || null;
  schemaSpecifier = resolved.spec || '';
} catch {
  schemaModule = null; // 解析不到 = 正常降级（本包零依赖约束下的预期分支）
  schemaSpecifier = '';
}
Config = buildConfigSchema(schemaModule);

/**
 * 解析"数据总库"根目录。
 *
 * @param {string} configured 用户配的路径（可能为空）
 * @returns {string}
 *
 * @why V0.6.2（机主已签《v0.6.2-迁移规格-v1》§1.1）：默认根改为
 *      **`<os.homedir()>/Desktop/会话账本`**，不再放 `<DSH_HOME>/dialog-ledger`。
 *      机主批 3 的裁定：要回滚的是**开发虚拟机**，不是机主设备 —— 数据放在桌面
 *      "每天看得见"的位置，才不会被重装/清目录顺手带走；用 os.homedir() 拼桌面，
 *      **不硬编码用户名**（开发机与机主设备都不写死）。
 *      没有桌面目录的机器退回 `<home>/会话账本`（服务环境也得能跑）。
 *      显式配置（root 非空）**永远优先**，升级不会搬用户自己选的路径。
 */
function resolveRoot(configured) {
  if (typeof configured === 'string' && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return defaultRootPath();
}

/** 默认根：`<home>/Desktop/会话账本`；桌面目录不存在时退回 `<home>/会话账本`。
 *
 * @why 目录名/桌面落点只在 `lib/ledgerroot.js` 定义一次（`defaultRootDir`/`DEFAULT_ROOT_NAME`）：
 *      宿主、迁移工具、测试必须用同一份规则，否则"默认根在哪"会出现第二个答案。
 */
function defaultRootPath() {
  const home = os.homedir();
  let hasDesktop = false;
  try {
    const desktop = path.join(home, 'Desktop');
    hasDesktop = fs.existsSync(desktop) && fs.statSync(desktop).isDirectory();
  } catch {
    hasDesktop = false; // 桌面探测失败（权限等）按"没有桌面"处理，不冒险往未知路径写
  }
  if (hasDesktop) return defaultRootDir(home);
  return path.join(home, DEFAULT_ROOT_NAME);
}

/** v0.6.1 及以前的默认根：`<DSH_HOME>/dialog-ledger`（未设 DSH_HOME 时 `~/.dsh/dialog-ledger`）。 */
function legacyDefaultRootPath() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'dialog-ledger');
}

/**
 * 首次运行"收养"旧默认根：**只在根来自默认、新根不存在、旧默认根存在**时做同盘 rename。
 *
 * @param {object} cfg 已解析配置（用 root / rootSource）
 * @param {object} log logger（info/warn；可空）
 * @returns {{adopted:boolean, legacyRoot:string, error:string}}
 *
 * @why 机主设备从 v0.6.1 升 v0.6.2，第一次启动时账库要从 `~/.dsh/dialog-ledger`
 *      搬到桌面。同盘 `renameSync` 是原子的、零字节拷贝，比"复制 + 删旧根"安全一个量级。
 * @why 三条硬约束（缺一条就宁可不搬）：
 *      ① 只收养 **default 根**：用户显式配置的路径绝不许被搬（那是用户的决定，不是默认值）；
 *      ② 只在**新根不存在**时收养：新根哪怕只是个空目录，也说明这块领地已被占，
 *         绝不覆盖、不合并（合并 = 两个写者，账会乱）；
 *      ③ 失败只 `warn` 并继续空库，**绝不删旧根**：跨盘（EXDEV）/权限/被占用时让数据
 *         留在原处，人还能看见、还能手动处置 —— 数据消失才是不可修复的。
 */
function adoptLegacyDefaultRoot(cfg, log) {
  const out = { adopted: false, legacyRoot: '', error: '' };
  if (!cfg || cfg.rootSource !== 'default') return out;
  if (typeof cfg.root !== 'string' || !cfg.root) return out;
  const legacyRoot = legacyDefaultRootPath();
  out.legacyRoot = legacyRoot;

  let newExists = true;
  try { newExists = fs.existsSync(cfg.root); } catch { newExists = true; }
  if (newExists) return out;

  let legacyExists = false;
  try { legacyExists = fs.existsSync(legacyRoot); } catch { legacyExists = false; }
  if (!legacyExists) return out;

  try {
    fs.mkdirSync(path.dirname(cfg.root), { recursive: true }); // 目标父目录（桌面）必在；防御性补建
    fs.renameSync(legacyRoot, cfg.root);
    out.adopted = true;
    if (log && log.info) {
      log.info('[dsh-dialog-ledger] 已收养旧默认账库根（同盘 rename）: ' + legacyRoot + ' → ' + cfg.root);
    }
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    if (log && log.warn) {
      log.warn('[dsh-dialog-ledger] 收养旧默认根失败（保留旧根、继续空库）: ' +
        legacyRoot + ' → ' + cfg.root + ' : ' + out.error);
    }
  }
  return out;
}

/**
 * 从 config 里取配置，缺的用默认值补。
 * @param {object} config
 * @returns {object}
 */
function readConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const ing = c.ingest && typeof c.ingest === 'object' ? c.ingest : {};
  const configuredRoot = typeof c.root === 'string' ? c.root.trim() : '';
  return {
    // root 仍是**字符串**（既有读法不变）；新增 rootSource 只回答"这个根从哪来"
    root: resolveRoot(c.root),
    // ★ V0.6.2：'default' = 内置默认（桌面）；'configured' = 用户在 config 里显式配了。
    //   只有 default 会被"收养旧默认根"改动，见 adoptLegacyDefaultRoot @why。
    rootSource: configuredRoot ? 'configured' : 'default',
    intervalSeconds: clampInt(c.intervalSeconds, 10, 86400, DEFAULTS.intervalSeconds),
    // ★ re3（② checkup）：严格布尔 —— 只有显式 `true` 才算开；null/0/""/"false"/"true" 等
    //   非布尔值一律**不当作开启**（"false" 字符串当开 = 配置语义反转，审计实测）。
    //   未配置（undefined）才回落到 DEFAULTS。
    enabled: c.enabled === undefined ? DEFAULTS.enabled : c.enabled === true,
    offsetMinutes: clampInt(c.offsetMinutes, -720, 840, DEFAULTS.offsetMinutes),
    hotWindowSeconds: clampInt(c.hotWindowSeconds, 0, 604800, DEFAULTS.hotWindowSeconds),
    quietSeconds: clampInt(c.quietSeconds, 0, 3600, DEFAULTS.quietSeconds),
    scanBudgetMs: clampInt(c.scanBudgetMs, 0, 60000, DEFAULTS.scanBudgetMs),
    maxBytesPerSession: clampInt(c.maxBytesPerSession, 0, 1024 * 1024 * 1024, DEFAULTS.maxBytesPerSession),
    // ★ P0-3：事件采集三重预算（批内取、批内写、批后释放）
    eventBatchTurns: clampInt(c.eventBatchTurns, 1, 500, DEFAULTS.eventBatchTurns),
    eventBatchEvents: clampInt(c.eventBatchEvents, 1, 200000, DEFAULTS.eventBatchEvents),
    eventBatchBytes: clampInt(c.eventBatchBytes, 64 * 1024, 512 * 1024 * 1024, DEFAULTS.eventBatchBytes),
    // ★ P0-1：文件身份指纹的取样字节数（用于识别"同大小重写"）
    headFingerprintBytes: clampInt(c.headFingerprintBytes, 64, 1024 * 1024, DEFAULTS.headFingerprintBytes),
    // ★ P0-2：pending 留痕文件的大小上限（0 = 不留 pending 证据）
    pendingMaxBytes: clampInt(c.pendingMaxBytes, 0, 16 * 1024 * 1024, DEFAULTS.pendingMaxBytes),
    // P3-4（异地压测发现）：没配时要回落到 DEFAULTS，而不是"没配就是开"。
    //         原写法 `c.checkupEnabled !== false` 会让最小配置意外开启体检，
    //         而体检报告只增不减 —— 等于在数据总库一级持续堆文件。
    // ★ re3（② checkup）：严格布尔（`=== true`）—— null/0/""/"false" 全部判"关"。
    //   旧写法 `c.checkupEnabled !== false` 把这些值全当"开"（语义反转，审计红项）。
    checkupEnabled: c.checkupEnabled === undefined ? DEFAULTS.checkupEnabled : c.checkupEnabled === true,
    checkupIntervalMs: clampInt(c.checkupIntervalMs, 0, 7 * 24 * 3600 * 1000, DEFAULTS.checkupIntervalMs),
    // ★ re3：与 enabled/checkupEnabled 同口径 —— "false"/null/0/"" 不得当开启。
    weeklyEnabled: c.weeklyEnabled === undefined ? DEFAULTS.weeklyEnabled : c.weeklyEnabled === true,
    handoverEnabled: c.handoverEnabled !== false,
    handoverAppendixMaxBytes: clampInt(
      c.handoverAppendixMaxBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULTS.handoverAppendixMaxBytes
    ),
    // ★ REC：库外收据锚目录（空 = 关闭；非空时必须落在 root 之外，否则报 ANCHOR_INSIDE_ROOT）
    receiptAnchorRoot: typeof c.receiptAnchorRoot === 'string' ? c.receiptAnchorRoot.trim() : '',
    // ★ V0.8：库外 manifest 锚（默认关闭）
    manifestAnchorRoot: typeof c.manifestAnchorRoot === 'string' ? c.manifestAnchorRoot.trim() : '',
    deliveryPackageDir: typeof c.deliveryPackageDir === 'string' ? c.deliveryPackageDir.trim() : '',
    // ★ V0.9：清理工具两把锁（默认 false；只有显式 true 才算开 —— "没配"绝不能当"允许删")
    cleanupToolEnabled: c.cleanupToolEnabled === true,
    cleanupAllowPhysicalDelete: c.cleanupAllowPhysicalDelete === true,
    // ★ V0.7：补记执行器（默认关；显式 true 才动第二写入口）
    backfillExecEnabled: c.backfillExecEnabled === true,
    // ★ V0.7：采集换轨（默认 disk 零行为变化；shadow 只跑影子、不写账）
    ingestMode: ['disk', 'shadow', 'persistence', 'event'].includes(ing && ing.mode) ? ing.mode : DEFAULTS.ingest.mode,
    ingestShadowPendingMs: clampInt(ing && ing.shadowPendingMs, 0, 3600000, DEFAULTS.ingest.shadowPendingMs),
    ingestShadowMaxSessions: clampInt(ing && ing.shadowMaxSessions, 1, 5000, DEFAULTS.ingest.shadowMaxSessions),
  };
}

/** 取整数并夹到区间里；非法值回落到默认。 */
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.round(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

/**
 * 按配置偏移的"本地日" `YYYYMMDD`（用于 state 里的每日节流键，如 catalogDate）。
 *
 * @why 不用 toISOString().slice(0,10)：那是 UTC 日，UTC+08:00 的 00:00–08:00 会算成昨天，
 *      "每日一次"就会变成"每天刷新两次或漏一天"。**绝不取本机时区**是 v0.5 的老口径。
 *
 * @param {number} nowMs
 * @param {number} offsetMinutes 480 = UTC+08:00
 * @returns {string}
 */
function ymdLocal(nowMs, offsetMinutes) {
  const d = new Date(nowMs + offsetMinutes * 60000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * ★ P0-1（审计 A-02）：文件身份指纹 —— 文件头 N 字节的 sha256。
 *
 * @why 为什么需要它：
 *   "文件没变"原来只判 `prev.size >= s.size && prev.offset >= prev.size`。
 *   这有两个洞：
 *     ① 文件**变小**（被截断/替换成更短版本）时条件仍成立 → 直接走 unchanged 快路径，
 *        新文件里的轮次永久漏记（审计实测 12574 B → 259 B，Turn 2 未入账）；
 *     ② 文件**同大小重写**（内容全换、字节数恰好一样）时也一样被误判。
 *   现在用「大小相同 + 头部指纹相同」两条一起判：同大小重写会被认出来，
 *   从而回退全量重读，而不是抄近路。
 *
 * @param {string} filePath
 * @param {number} [maxBytes]
 * @returns {string} 十六进制 sha256；空串 = 读不到（调用方必须按"不能证明没变"处理）
 */
function headFingerprint(filePath, maxBytes) {
  const n = clampInt(maxBytes, 64, 1024 * 1024, DEFAULTS.headFingerprintBytes);
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    if (!(got > 0)) return '';
    return createHash('sha256').update(buf.subarray(0, got)).digest('hex');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 打不开就没得关 */ }
    }
  }
}

/**
 * ★ 0.9.3 · P2-3（S-9 口径）：文件**尾部** N 字节的 sha256 —— 补上身份采样的盲区。
 *
 * @why 为什么需要它（本期探针实测）：现有"三证"= size + 头 4 KiB 指纹 + mtime。
 *      一个只改**尾部**的改写，若同时把 mtime 还原（fs.utimes / 备份还原 / 同步工具都会），
 *      三证全绿 → 走 unchanged 快路径 → 新内容永久漏记。尾部 4 KiB 采样能识别这一类。
 *
 * @why 为什么只在 size 相同时算（调用点决定）：size 变了已经证明文件变过，
 *      再读 4 KiB 是白花 IO；且增长时尾部本来就变（新内容），算它没有判别力。
 *
 * @why 为什么不新增配置键：取样长度沿用 `headFingerprintBytes` 的语义
 *      （本函数内部用模块常量 TAIL_FP_BYTES=4096，与该键默认值一致），配置面冻结。
 *
 * @why 必须如实写清边界：采样**看不到中段改写**（size/头/尾/mtime 都可能不变）。
 *      中段改写由"每日一次全量复核"（C19，tick 外）负责，不得对外承诺实时发现。
 *
 * @param {string} filePath
 * @param {number} [maxBytes] 取样字节数（默认 4096；夹在 64 B – 1 MiB）
 * @returns {string} 十六进制 sha256；空串 = 读不到（调用方必须按"不能证明没变"处理）
 */
function tailFingerprint(filePath, maxBytes) {
  const n = clampInt(maxBytes, 64, 1024 * 1024, TAIL_FP_BYTES);
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (!(size > 0)) return '';
    const len = Math.min(n, size);
    const start = size - len;
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const k = fs.readSync(fd, buf, got, len - got, start + got);
      if (k <= 0) break;
      got += k;
    }
    if (!(got > 0)) return '';
    return createHash('sha256').update(buf.subarray(0, got)).digest('hex');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 打不开就没得关 */ }
    }
  }
}

/**
 * ★ C25（整 tick 聚合消费硬预算）：探测 `fromByte` 处**第一帧**的压缩字节长度。
 *
 * @why 为什么必须探测（而不是继续信 `maxBytes`）：
 *      lib/frames.js 的 `maxBytes` 只在 `consumed > 0` 时生效 —— 第一帧永远整帧读出。
 *      v3 会话是「头帧 ~237 B + 整份内容一个巨帧（实测 1,090,780 B）」的结构，
 *      big v4 会话也有 1,855,173 B 的单帧。剩余预算不足一帧时开读 = 必然越界
 *      （第一台审计 §3 红项 2：tick1 越 218 B / tick2 越 236,946 B）。
 *      所以开读前用内核**同一套结构分帧**（lib/frames.js:frameSpan）先量第一帧：
 *      量得出来且 ≤ 授权额度 → 本读的消费上界 = 授权额度（frames 会停在下一帧边界前）；
 *      量出来放不下 → 整会话延后，绝不"先读了再说"。
 *
 * @param {string} filePath 会话源文件
 * @param {number} fromByte 起点（调用方保证是帧边界：0 或游标提交点）
 * @param {number} capBytes 只需要知道"是否 ≤ capBytes"；超过它就不必再读
 * @returns {{first:number, bytes:number}}
 *   first ≥ 0：第一帧压缩长度；其中 **0 = 这一读不会计入消费**（坏魔数/坏结构/半尾帧 →
 *              读侧会在起点 halt，`nextOffset-fromByte = 0`），调用方可照读；
 *   first = -1：在 capBytes 内判不出来（帧比 cap 大）→ 调用方必须按"放不下"延后。
 *   bytes：探测实际读盘字节（真实 IO，必须计进本 tick 的读盘估算，不许少报）。
 */
function probeFirstFrameBytes(filePath, fromByte, capBytes) {
  const cap = clampInt(capBytes, 1, 64 * 1024 * 1024, 1);
  const out = { first: -1, bytes: 0 };
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, Math.min(Math.floor(fromByte) || 0, size));
    const avail = size - start;
    if (avail <= 0) { out.first = 0; return out; } // 已到文件尾：不消费字节
    const limit = Math.min(cap, avail);
    let buf = Buffer.alloc(0);
    let want = Math.min(limit, TICK_READ_PROBE_FIRST_WINDOW);
    for (;;) {
      if (want > buf.length) {
        const need = want - buf.length;
        const more = Buffer.allocUnsafe(need);
        let got = 0;
        while (got < need) {
          const n = fs.readSync(fd, more, got, need - got, start + buf.length + got);
          if (n <= 0) break;
          got += n;
        }
        if (got <= 0) { out.first = 0; return out; } // 读不动：读侧会失败、消费 0
        out.bytes += got;
        const chunk = got === need ? more : more.subarray(0, got);
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        if (buf.length < want) { out.first = 0; return out; } // 到文件尾仍不完整 = 半尾帧
      }
      const span = frameSpan(buf, 0);
      if (span.ok) { out.first = span.end; return out; }
      // 坏魔数/结构不可信：readTurnsFrom 会在起点 halt（meta.nextOffset=haltOffset=fromByte），
      // 消费按 0 记；这里放行，坏帧由既有 K-4 路径留痕（.lost/.errors），不因预算再挡一层。
      if (span.badMagic || span.badBlock) { out.first = 0; return out; }
      if (buf.length >= limit) {
        if (limit >= avail) { out.first = 0; return out; } // 读到文件尾仍不完整 = 半尾帧
        out.first = -1; // 帧比 cap 大：本 tick 判"放不下"
        return out;
      }
      want = Math.min(limit, Math.max(buf.length * 4, TICK_READ_PROBE_FIRST_WINDOW));
    }
  } catch {
    // 打不开/读失败：保守按"放不下"延后（下一 tick 重试；失败本身另有错误路径可见）
    out.first = -1;
    return out;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 打不开就没得关 */ }
    }
  }
}

/**
 * ★ REC：列出台账里"已经结束的日子"（`ledger/YYYY-MM-DD.jsonl`），排除今天。
 *
 * @why 收据是"那一天账本长什么样"的库外证据，当天还没过完就封收据，
 *      会把"半天账"当成整天证据 —— 所以今天一律不封，留给下一轮。
 *
 * @param {string} root 数据总库
 * @param {string} todayISO `YYYY-MM-DD`（+08:00 口径）
 * @returns {string[]} 升序日期
 */
function listLedgerDays(root, todayISO) {
  const dir = path.join(root, 'ledger');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && !n.startsWith('.'))
    .map((n) => n.slice(0, 10))
    .filter((d) => d !== todayISO)
    .sort();
}

/**
 * 把 `.errors.jsonl` 聚合成本轮运行报告要的 `errors[]`（D9 字段 + R-02 计数口径）。
 *
 * ★ 2026-11-09 审计 #1：运行报告的 `errors: []` 原来是**硬编码空数组**，
 *   于是"真实失败次数"永远进不了报告（INV-30 / R-02 的证据是空的）。
 *
 * ★ 口径限制（必须如实说）：错误清单本身按 `(kind,source,offset)` 每小时最多 1 行（R-02 节流），
 *   所以这里聚合出来的是"清单里各指纹的行数之和"，**不等于绝对真实次数**。
 *   真实的次数增量依赖入口在内存里累加；本轮尚未做到，已写进 `05-已知未覆盖项`。
 *
 * @param {string} root
 * @returns {Array<{kind:string,source:string,offset:number,fingerprint:string,count:number,lastAt:string,detail:string}>}
 */
function aggregateReportErrors(root) {
  let recs = [];
  try { recs = readErrors(root).records || []; } catch { recs = []; }
  const by = new Map();
  const keyOf = (kind, source, offset) => `${kind}|${source}|${Number(offset) || 0}`;
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue;
    const key = keyOf(r.kind, r.source, r.offset);
    const cur = by.get(key);
    if (cur) {
      cur.count += 1;
      if (String(r.at || '') > String(cur.lastAt || '')) cur.lastAt = String(r.at || '');
    } else {
      by.set(key, {
        kind: typeof r.kind === 'string' ? r.kind : '',
        source: typeof r.source === 'string' ? r.source : '',
        offset: Number.isFinite(Number(r.offset)) ? Number(r.offset) : 0,
        fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : '',
        count: 1,
        lastAt: typeof r.at === 'string' ? r.at : '',
        detail: typeof r.detail === 'string' ? r.detail : '',
      });
    }
  }
  // ★ R-02 / INV-30：清单被节流，真实次数在 `.error-attempts.json` 里。
  //   取两者较大值作为 count（清单行数只是"看得见的次数"，尝试计数才是真实次数）。
  let attempts = {};
  try { attempts = readErrorAttempts(root) || {}; } catch { attempts = {}; }
  for (const [key, a] of Object.entries(attempts)) {
    if (!a || typeof a !== 'object') continue;
    const cur = by.get(key);
    const n = Number(a.attempts) || 0;
    if (cur) {
      cur.count = Math.max(cur.count, n);
      if (String(a.lastAt || '') > String(cur.lastAt || '')) cur.lastAt = String(a.lastAt || '');
    } else {
      by.set(key, {
        kind: typeof a.kind === 'string' ? a.kind : '',
        source: typeof a.source === 'string' ? a.source : '',
        offset: Number.isFinite(Number(a.offset)) ? Number(a.offset) : 0,
        fingerprint: '',
        count: n,
        lastAt: typeof a.lastAt === 'string' ? a.lastAt : '',
        detail: `attempts=${n}（清单被节流，未逐次留行）`,
      });
    }
  }
  return [...by.values()];
}

/**
 * 一轮扫描 + 落账。**这是唯一干活的函数。**
 *
 * @param {object} ctx DSH 的插件上下文（只用 ctx.logger）
 * @param {object} cfg 已解析的配置
 * @returns {Promise<{scanned:number, newTurns:number, written:number, skipped:number, errors:string[]}>}
 *
 * @why 返回统计而不是只打日志：让调用方（测试 / UI）能拿到数字，
 *      不必去 grep 日志。
 */
/**
 * ★ P1-03（审计 P1-03 · 机主裁定 V1.0 前解决）：给"本 tick 没轮到、且从没写过游标"的会话
 * 补一个未完成游标（partialCommit），让下一 tick 一定续读到它。
 *
 * @why 这是时间预算与字节预算**共用**的同一条保护：预算让本轮提前收工时，若某个会话
 *      既没被处理、又没留下游标，下一 tick 会被 hotWindow 当成"老文件"过滤掉 ——
 *      数据永久漏记，且没有任何告警。两条预算路径必须同构，所以抽成同一个函数
 *      （审计 P1-03 指出的正是"时间路径漏了字节路径做过的事"）。
 * @param {object[]} sessions 全量会话列表（本轮扫描结果）
 * @param {number} fromIndex 从第几个开始（前面的是本轮已尝试过的，不补）
 * @param {object} cursors state.sourceCursors（会被就地写入）
 * @param {(sess:object)=>void} fill 单项写入函数（调用方传 deferSessionByByteBudget 的闭包）
 * @returns {number} 实际补了多少个
 */
function fillUnvisitedCursors(sessions, fromIndex, cursors, fill) {
  let n = 0;
  const start = Number.isInteger(fromIndex) && fromIndex > 0 ? fromIndex : 0;
  for (let sj = start; sj < sessions.length; sj++) {
    const ss = sessions[sj];
    if (!ss || !ss.path || cursors[ss.path]) continue;
    fill(ss);
    n++;
  }
  return n;
}

export async function runOnce(ctx, cfg) {
  const log = (ctx && ctx.logger) || console;

  // ★ V0.6.2：默认根首次运行先"收养"旧默认根（同盘 rename）。
  //   **必须在取锁之前**：acquire() 会 mkdir `<root>/ledger`，新根一旦被它建出来，
  //   "新根不存在"这个前提就永远为假 —— 旧账会永远留在 ~/.dsh 而新库空着。
  //   失败只 warn（adoptLegacyDefaultRoot 内部已处理），不拦本轮记账。
  try {
    adoptLegacyDefaultRoot(cfg, log);
  } catch (e) {
    if (log.warn) log.warn('[dsh-dialog-ledger] 收养旧默认根异常（忽略，继续本轮）: ' + e.message);
  }

  // ★ 单实例写锁（P2-1）：双实例同时写会「同 code 不同轮」，后写者覆盖前者凭证。
  //   抢不到锁 = 别人在写 → 整轮跳过：**不写 state、不推进游标**，
  //   这样下一次抢到锁时，游标还在老位置，不会漏掉这期间的新轮次。
  // ★ re3 P0（K-12 消费侧 · lead 裁定）：锁的 instanceId 由**挂载实例**传入（apply 生成唯一值）。
  //   @why 不传时 acquire 共用 DEFAULT_INSTANCE_ID —— 同进程若有两个挂载/调用点，幂等键相同
  //     会拿到**同一个 handle**：第二个实例会把第一个的锁 release 掉（互删锁），第一个还在写。
  //     传了不同 instanceId，同进程异实例也互斥（第二个 LOCK_HELD），P0"同进程双写"才闭环。
  //   @why 仍然允许不传：单实例调用方（测试/工具直接 runOnce）行为不变（默认值兼容）。
  // ★ re3 P1（FAIL-03）：跳过的轮次也要留逐 tick 度量 + 可见错误（warn），不能只有 INFO：
  //   否则"这一轮为什么什么都没做"在 .tick-metrics 里根本不存在，锁冲突无法事后统计。
  const lockTickStartedAtMs = Date.now();
  let lock;
  // ★★★ K-25 加固（第二轮测试报告：两台机器结论不一致 —— "启动即拒绝"在**挂载**场景没成立）
  //   @why 旧实现每 tick acquire/release 一次：两个挂载实例各自抢到不同的 tick，会**交替成为写者**；
  //        "第二个写者启动即被拒绝"只在单 tick 内成立。真正的"启动即拒绝"必须由 apply() 在**挂载期**
  //        持锁，tick 只复用同一 handle（不 acquire、不 release；心跳由 lock.js 的定时器负责）。
  const mountLock = cfg && cfg.__mountLock && cfg.__mountLock.acquired === true && cfg.__mountLock.released !== true
    ? cfg.__mountLock : null;
  if (mountLock && mountLock.lost !== true) {
    lock = mountLock;
    cfg.__mountOwned = true;
  } else if (mountLock) {
    // 挂载锁已丢（心跳发现被接管 / 锁文件被删）：本 tick 一律拒绝写，交给 apply 重新取锁。
    lock = {
      acquired: false,
      holder: mountLock.holder || null,
      reason: 'lost:' + String(mountLock.lostReason || 'lost'),
    };
  } else try {
    const lockOpts = { offsetMinutes: cfg.offsetMinutes };
    if (typeof cfg.instanceId === 'string' && cfg.instanceId) lockOpts.instanceId = cfg.instanceId;
    lock = acquire(cfg.root, lockOpts);
  } catch (e) {
    // 真正的 IO 故障（权限/磁盘满）不是"别人在跑"，必须出声
    const why = e && e.message ? e.message : String(e);
    const msg = 'lock acquire failed: ' + why;
    if (log.warn) log.warn('[dsh-dialog-ledger] 取锁失败（本轮不写）: ' + why);
    const skipStat = {
      lockSkipped: true,
      lockError: why,
      lock: { reason: 'acquire-failed', error: why },
      tickStartedAtMs: lockTickStartedAtMs,
      errors: [msg],
      warnings: [],
    };
    writeLockSkipMetric(cfg, skipStat);
    return skipStat;
  }
  if (!lock.acquired) {
    const h = lock.holder || {};
    const msg = 'LOCK_HELD another instance holds lock: pid=' + (h.pid === undefined ? '?' : h.pid) +
      ' host=' + (h.hostname === undefined ? '?' : h.hostname) + ' reason=' + lock.reason;
    // ★★★ 多写者硬断言（机主 2026-11-15 指令）：
    //   "检测到第二个写者 → 拒绝启动 / 立即停手并报警；**不许**只打个警告然后继续跑——那才是真的假绿。"
    //   实现口径：锁的创建是 OS 级原子（lib/lock.js: fs.openSync(file,'wx') = O_CREAT|O_EXCL，创建失败即退），
    //   不是"先检查后启动"。所以这里**不是**"资源忙、等下一轮"的软跳过，而是**硬拒绝 + ERROR 报警**：
    //     · 本轮不写任何账（与旧实现一致，安全面没有放宽）；
    //     · 但对外**必须**是 ERROR 级、且 stat.lockBlocked=true（apply 侧据此"拒绝启动/停正常节奏"）；
    //     · INFO 一条保留只是为了不打断既有 C05 用例对 info 的断言。
    if (log.info) log.info('[dsh-dialog-ledger] ' + msg + ' → 本轮拒绝执行（不写 state、不推进游标）');
    const errLine = 'ERROR 拒绝启动：账库已被另一个写者持有（' + msg + '）—— 多写者场景不支持；本实例停止写入并等待锁释放';
    if (log.error) log.error('[dsh-dialog-ledger] ' + errLine);
    else if (log.warn) log.warn('[dsh-dialog-ledger] ' + errLine);
    const skipStat = {
      lockSkipped: true,
      lockBlocked: true,
      lockHolder: h,
      lock: { reason: lock.reason || 'held', holderPid: h.pid === undefined ? null : h.pid, holderHostname: h.hostname || '' },
      tickStartedAtMs: lockTickStartedAtMs,
      errors: [msg],
      warnings: ['LOCK_HELD 本轮跳过（未写 state/未推进游标；度量行已写 .tick-metrics）'],
    };
    writeLockSkipMetric(cfg, skipStat);
    return skipStat;
  }
  if (lock.stalePath && log.warn) {
    log.warn('[dsh-dialog-ledger] 夺取到僵死锁，旧锁留证: ' + lock.stalePath);
  }

  // ★ re3 P1（RT-01）：整轮同步执行窗口的真实读盘计量（fs 层；批间让出时暂停）。
  //   计量是**旁证**：任何计量异常都不许影响记账，finally 必还原 fs 钩子。
  const readMeterToken = beginReadMeter();
  const readMeter = readMeterToken.meter;

  try {
    const stat = await runOnceCore(ctx, cfg, lock);
    // ★ re3 P1（RT-01）：本 tick 同步窗口内的**真实读盘字节**（fs 层实测；批间让出时已暂停计量，
    //   不会把别的异步任务的读算进来）。既有 readBytes（估算口径）保持原样，二者并列落盘。
    //   ★ 并发 tick（跨 root 双实例）时计量器会被共享 → 本轮真读不可归因，按 0 + shared 标记上报。
    stat.realReadBytes = readMeter.tainted === true ? 0 : readMeter.bytes;
    stat.realReads = readMeter.tainted === true ? 0 : readMeter.reads;
    stat.realReadBytesShared = readMeter.tainted === true;
    // ★ re3 P1（FAIL-03）：锁跳过/取锁失败的轮次不走这里（已早退），正常轮次的度量行不写 lock 段。
    // ★ P1-04：常驻索引缓存淘汰（放在写 metrics 之前，让降级事实**当场入度量**）。
    //   为什么淘汰而不是继续持有：records/existing/knownCodes/seenTurns 随台账行数单调增长、
    //   永不释放；超上限后改为"逐 tick 重建"，把常驻内存拉回基线（不丢账，只是每轮多一次读）。
    try {
      if (ledgerCache && ledgerCache.ephemeral) {
        stat.cacheDegraded = true;
        stat.cacheRowCount = Number(ledgerCache.rowCount) || 0;
        const line = '台账 ' + stat.cacheRowCount + ' 行 > 常驻缓存上限 ' + ledgerCacheCaps.maxResidentRows +
          ' → 索引缓存改为逐 tick 重建（不丢账；代价是每轮一次全量读，已计入 tick 度量）';
        if (!Array.isArray(stat.warnings)) stat.warnings = [];
        stat.warnings.push(line);
        if (log && log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
      }
    } catch { /* 淘汰判定失败不影响记账 */ } finally {
      if (ledgerCache && ledgerCache.ephemeral) ledgerCache = null;
    }
    // ★ 0.9.3 P2-6（S-9）：逐 tick 度量落盘（append-only，一行一 tick）。
    //   @why 写在这里而不是 core 内：core 有多条提前 return（state 读坏/台账读坏…），
    //     那些轮次同样要留"这一 tick 为什么什么都没做"的证据，所以统一在唯一的出口写。
    //   @why 写失败只进 warnings（不加 errors）：度量是旁证，不是账务事实，
    //     不能因为旁证写不进去把"零错误"验收打红（与 run-report 同口径）。
    try {
      const finishedAtMs = Date.now();
      const startedAtMs = Number.isFinite(stat.tickStartedAtMs) && stat.tickStartedAtMs > 0
        ? stat.tickStartedAtMs
        : finishedAtMs;
      const ms = Math.max(0, finishedAtMs - startedAtMs);
      const phases = stat.phases && typeof stat.phases === 'object' ? stat.phases : {};
      const phaseSum = ['scanMs', 'eventsMs', 'persistMs', 'weeklyMs', 'reconcileMs', 'reportMs',
        // ★ P1-02：把后四段也计入 phaseSum，否则 otherMs 会把它们吞掉（"30 s 花在哪"失真）。
        'indexMs', 'catalogMs', 'receiptMs', 'monthlyMs']
        .reduce((a, k) => a + (Number(phases[k]) || 0), 0);
      const consumed = Number(stat.consumedSourceBytes) || 0;
      const eventRead = Number(stat.eventReadBytes) || 0;
      const headFp = Number(stat.headFpBytes) || 0;
      const tailFp = Number(stat.tailFpBytes) || 0;
      const stateBytes = Number(stat.stateBytes) || 0;
      // ★ C25：首帧探测也是真实读盘（往 tick 硬顶里"预读"的那几 KB/帧），必须计入估算。
      const probeBytes = Number(stat.probeBytes) || 0;
      // readBytes 口径（必须如实）：产品侧**估算** = 扫描消费 + 事件读预算上界 + 头/尾指纹 + state
      //   + 首帧探测（C25 新增）。真实读盘字节由 `_工作/tools/measure-tick.mjs` 从 node:fs 层实测；
      //   两者比对见证据报告。io 分桶单列，避免"估算"被误当"实测"。
      const record = {
        v: 1,
        // ★ re3（K-12 消费侧）：本次 tick 的实例标识（apply 每实例唯一）。
        instanceId: typeof cfg.instanceId === 'string' ? cfg.instanceId : '',
        ts: isoTime(finishedAtMs, cfg.offsetMinutes),
        tsUtcMs: finishedAtMs,
        tickId: `${process.pid}-${startedAtMs}`,
        ms,
        readBytes: Math.round(consumed + eventRead + headFp + tailFp + stateBytes + probeBytes),
        readBytesKind: 'estimate-product-side',
        written: Number(stat.written) || 0,
        scanned: Number(stat.scanned) || 0,
        // ★ re3（ARCH-01）：中止轮的事实 —— 本轮是否被卸载/取消打断、是否只落了 .state 提交点。
        cancelled: stat.cancelled === true,
        abortedCommit: stat.abortedCommit === true,
        lockSkipped: false,
        // ★ re3（RT-01）：真实读盘字节（fs 层实测）+ 读次数；既有 readBytes（估算）口径一个字节不动。
        realReadBytes: Number(stat.realReadBytes) || 0,
        realReads: Number(stat.realReads) || 0,
        // true = 本 tick 与另一个并发 tick 共享计量器 → 真读字节不可归因（按 0 上报，不伪造）。
        realReadBytesShared: stat.realReadBytesShared === true,
        // ★ 0.9.4-re1（P3 接线）：三项新能力的逐 tick 度量（只加不改；既有字段口径不变）。
        //   weeklyDeferred = 本 tick 因预算未处理完的周账组数（余量在 state.weeklyCatchup）。
        weeklyDeferred: Number(stat.weeklyDeferred) || 0,
        monthly: stat.monthly
          ? {
            months: Array.isArray(stat.monthly.months) ? stat.monthly.months.slice(0, 24) : [],
            written: Number(stat.monthly.written) || 0,
            unchanged: Number(stat.monthly.unchanged) || 0,
            failed: Number(stat.monthly.failed) || 0,
            ms: Number(stat.monthly.ms) || 0,
          }
          : null,
        index: stat.index
          ? {
            built: stat.index.built === true,
            rows: Number(stat.index.rows) || 0,
            ms: Number(stat.index.ms) || 0,
          }
          : null,
        // ★ re3（RT-01）：对账段 —— 真实耗时/读字节/全量或增量档位/复核行数。
        //   旧 tick-metrics 只有 phases.reconcileMs，真读 ~175 MiB 完全不在度量里（审计③ RT-01）。
        reconcile: stat.reconcile
          ? {
            ran: true,
            ok: stat.reconcile.ok === true,
            okStrict: stat.reconcile.okStrict === true,
            conclusion: typeof stat.reconcile.conclusion === 'string' ? stat.reconcile.conclusion : '',
            ledgerRows: Number(stat.reconcile.ledgerRows) || 0,
            mode: typeof stat.reconcile.mode === 'string' ? stat.reconcile.mode : '',
            verifiedRows: Number(stat.reconcile.verifiedRows) || 0,
            cachedRows: Number(stat.reconcile.cachedRows) || 0,
            ms: Number(phases.reconcileMs) || 0,
            readBytes: Number(stat.reconcileReadBytes) || 0,
          }
          : null,
        budget: {
          scanBudgetMs: stat.budget ? stat.budget.scanBudgetMs : null,
          effectiveMs: stat.budget ? stat.budget.effectiveMs : null,
          hardMs: TICK_HARD_MS,
          readBytes: TICK_READ_BUDGET_BYTES,
          // ★ C25：saturated 必须把"字节预算造成的延后"也算进去 —— 旧口径只看 cancelled/
          //   deferred/deferredTurns，于是"17 源同 tick 聚合"若只是越界而没有 deferredTurns 时
          //   会被写成 saturated:false（审计红项 2 的一部分：预算事实被少报）。
          saturated: !!(stat.cancelled ||
            (Number(stat.deferred) || 0) > 0 ||
            (Number(stat.byteDeferredSessions) || 0) > 0 ||
            (Number(stat.prefixDeferred) || 0) > 0 ||
            (Number(stat.eventAmpDeferredBatches) || 0) > 0 ||
            (Number(stat.deferredTurns) || 0) > 0),
          // ★ C25：本 tick 因预算没轮到的会话数（整会话时间延后 + 字节预算延后）。
          deferredSessions: (Number(stat.deferred) || 0) + (Number(stat.byteDeferredSessions) || 0),
          byteDeferredSessions: Number(stat.byteDeferredSessions) || 0,
          // ★ P1-02：整 tick 是否超硬顶（"宣称 ≤30 s"必须能被实测打脸，而不是只写在文档里）。
          //   overHardCap 由本轮**实测耗时**与 TICK_HARD_MS 比较得出，不看配置。
          overHardCap: ms > TICK_HARD_MS,
          // ★ P1-02：本 tick 因"剩余时间预算不足"整段跳过的可选段（下一 tick 重试）。
          deferredSegments: Array.isArray(stat.phases && stat.phases.deferredSegments)
            ? stat.phases.deferredSegments.slice(0, 10) : [],
        },
        // ★ P1-04：常驻索引缓存降级事实（true = 本轮起改为逐 tick 重建，避免常驻内存单调增长）。
        cache: {
          degraded: stat.cacheDegraded === true,
          rowCount: Number(stat.cacheRowCount) || 0,
          maxResidentRows: ledgerCacheCaps.maxResidentRows,
        },
        // ★ P1-03：时间预算延后的会话数（与字节预算对称；两者都会补 partialCommit 游标）。
        timeDeferredSessions: Number(stat.timeDeferredSessions) || 0,
        sessionsErrored: Number(stat.sessionsErrored) || 0,
        stalledDetected: Number(stat.stalledDetected) || 0,
        stalled: Array.isArray(stat.stalledList) ? stat.stalledList.slice(0, 10) : [],
        phases: { ...phases, otherMs: Math.max(0, ms - phaseSum) },
        io: {
          consumedSourceBytes: consumed,
          eventReadBudgetBytes: eventRead,
          headFpBytes: headFp,
          tailFpBytes: tailFp,
          stateBytes,
          probeBytes, // ★ C25：首帧探测真实读盘（已计入 readBytes 估算）
          // ★ re3（RT-01）：**真实读盘字节**（fs 层实测），分桶与估算并列 —— 绝不混用两种口径。
          //   readBytesKind 仍明示顶层 readBytes 是 estimate-product-side；真实值看 realReadBytes。
          realReadBytes: Number(stat.realReadBytes) || 0,
          realReads: Number(stat.realReads) || 0,
          scanReadBytes: Number(stat.scanReadBytes) || 0,
          weeklyReadBytes: Number(stat.weeklyReadBytes) || 0,
          stateReadBytes: Number(stat.stateWriteReadBytes) || 0,
          catalogReadBytes: Number(stat.catalogReadBytes) || 0,
          indexReadBytes: Number(stat.indexReadBytes) || 0,
          receiptReadBytes: Number(stat.receiptReadBytes) || 0,
          reconcileReadBytes: Number(stat.reconcileReadBytes) || 0,
          reportReadBytes: Number(stat.reportReadBytes) || 0,
        },
        counters: {
          skipped: stat.skipped,
          unchanged: stat.unchanged,
          incremental: stat.incremental,
          partialReads: stat.partialReads,
          deferred: stat.deferred,
          deferredTurns: stat.deferredTurns,
          // ★ C25：整 tick 聚合字节预算的可观测字段（延后不等于丢：下一 tick 按游标续读）。
          byteDeferredSessions: Number(stat.byteDeferredSessions) || 0,
          prefixDeferred: Number(stat.prefixDeferred) || 0,
          eventAmpDeferredBatches: Number(stat.eventAmpDeferredBatches) || 0,
          firstFrameUnbounded: Number(stat.firstFrameUnbounded) || 0,
          resumedSessions: stat.resumedSessions,
          eventBatches: stat.eventBatches,
          eventReadRetries: stat.eventReadRetries,
          eventShortBatch: stat.eventShortBatch,
          // ★ K-16（re4）：本 tick 因"事件批读预算停在帧边界、重试后仍未读全"而整批不落账的次数。
          eventTruncatedBatch: Number(stat.eventTruncatedBatch) || 0,
          blockedSources: stat.blockedSources,
          sessionCrashed: stat.sessionCrashed,
          quarantined: stat.quarantined,
          quarantineNew: stat.quarantineNew,
          retried: stat.retried,
          firstRun: stat.firstRun === true,
          hotWindowExempted: stat.hotWindowExempted,
          unfinishedCursors: stat.unfinishedCursors,
          tailRewrites: stat.tailRewrites || 0,
          identityRewrites: stat.identityRewrites,
          // ★ re3（K-15 / B 线 oversized 契约）：可跳过缺口（超大帧/解压超限）的逐 tick 计数。
          //   这类缺口**不可重试**、游标已推进到帧边界；靠这两个数区分"坏帧停摆"与"跳过式缺口"。
          lossSkipped: Number(stat.lossSkipped) || 0,
          lossSkippedFrames: Number(stat.lossSkippedFrames) || 0,
        },
        // ★ re3（ARCH-04）：可选增强面（Agent 工具/面板 API）的挂载健康度快照。
        //   失败不再只写系统临时目录的启动日志 —— 每 tick 一行，tick-metrics/state/run-report 都可查。
        mount: stat.mount || null,
        errors: Array.isArray(stat.errors) ? stat.errors.slice(0, 8) : [],
        warnings: Array.isArray(stat.warnings) ? stat.warnings.slice(-8) : [],
      };
      const wr = appendTickMetrics(cfg.root, record);
      if (wr && wr.ok === true) stat.tickMetricsPath = wr.path;
      else stat.warnings.push('tick-metrics write failed: ' + ((wr && wr.error) || '?'));
    } catch (e) {
      stat.warnings.push('tick-metrics build failed: ' + (e && e.message ? e.message : String(e)));
    }
    return stat;
  } finally {
    // ★ re3（RT-01）：先还原 fs 计量钩子，再释放锁 —— 释放不属于"本轮读盘"。
    endReadMeter(readMeterToken);
    // ★ K-25：挂载期持锁时，tick **不释放**（释放由 apply() 的 dispose 负责；否则 tick 1 结束就把挂载锁放了）。
    if (!(cfg && cfg.__mountOwned === true)) {
      try { release(lock); } catch (e) {
        if (log.warn) log.warn('[dsh-dialog-ledger] 释放锁失败: ' + e.message);
      }
    }
  }
}

/**
 * 一轮扫描 + 落账的核心（**调用方必须已持有写锁**）。
 * @param {object} ctx DSH 的插件上下文（只用 ctx.logger）
 * @param {object} cfg 已解析的配置
 * @param {object} [lock] 写锁 handle（用于在写循环里检查 handle.lost）
 * @returns {Promise<object>} 统计
 */
async function runOnceCore(ctx, cfg, lock) {
  const log = (ctx && ctx.logger) || console;
  // ★ 0.9.3 P2-6：本轮开始时刻（.tick-metrics 的 ms 从这里算起，含扫描/对账/报告全段）。
  const tickStartedAtMs = Date.now();

  // ★ 兜底（2026-11-09 实测踩到）：测试与工具会**直接** `runOnce(ctx, cfg)` 而不经过
  //   readConfig —— 那 v0.5 新增的预算键就是 undefined。
  //   后果很隐蔽：`Math.max(1, undefined)` = NaN → 分批循环一次都不进 → "有界"变成"没界"，
  //   而且 written=0/skipped=0、看上去像"没活干"。所以入口必须补齐。
  cfg = {
    ...cfg,
    eventBatchTurns: Number.isFinite(cfg.eventBatchTurns) ? cfg.eventBatchTurns : DEFAULTS.eventBatchTurns,
    eventBatchEvents: Number.isFinite(cfg.eventBatchEvents) ? cfg.eventBatchEvents : DEFAULTS.eventBatchEvents,
    eventBatchBytes: Number.isFinite(cfg.eventBatchBytes) ? cfg.eventBatchBytes : DEFAULTS.eventBatchBytes,
    headFingerprintBytes: Number.isFinite(cfg.headFingerprintBytes) ? cfg.headFingerprintBytes : DEFAULTS.headFingerprintBytes,
    pendingMaxBytes: Number.isFinite(cfg.pendingMaxBytes) ? cfg.pendingMaxBytes : DEFAULTS.pendingMaxBytes,
  };
  // ★ INV-13（取消）：调用方可通过 `cfg.signal` 传入 AbortSignal。
  // ★★ P0（2026-11-10 重启实测）：**不能再直接读 `ctx.signal`**。Cordis 的 ctx 上访问
  //   未 `inject` 的服务属性会抛 `cannot get property "signal" without inject`，
  //   导致真宿主里 runOnce 每一轮刚进 core 就抛异常 → 插件在实机上**从未落过账**
  //   （v0.6.1 及更早同现象；进程内测试与子进程用普通对象 ctx，永不触发，故测试全绿）。
  //   口径改为：只认 `cfg.signal`；若确实要从 ctx 取，必须 try/catch 兜底。
  let ctxSignal = null;
  try { ctxSignal = ctx && ctx.signal; } catch { ctxSignal = null; }
  const signal = (cfg && cfg.signal) || ctxSignal || null;
  const aborted = () => !!(signal && signal.aborted);

  const stat = {
    scanned: 0,        // 本轮扫到的会话文件数
    // ── ★ INV-13 / INV-14（取消与续跑，2026-11-09）──
    //    取消的提交单位是**批**：已提交批不回滚、未提交批零写入。
    //    `cancelled` 与 `committedBatches` 就是「中止时保住了几批」的可机读证据。
    cancelled: false,
    committedBatches: 0,
    resumeFrom: null,    // 断点续跑时本轮从哪个字节位置续起（null = 没有续跑）
    resumedSessions: 0,  // 本轮按 partialCommit 续跑的会话数
    newTurns: 0,       // 扫到的"已闭合"轮次数（含已入账的，用于对账）
    written: 0,        // 本轮新写入的行数
    skipped: 0,        // 因 (sid,turn) 已存在而跳过的轮次数
    openTurns: 0,      // 只见到 turn/start、尚未闭合的轮次数（未入账）
    malformedTurns: 0, // 缺 time 或缺 turn 的边界数量（跳过，但必须报出来）
    unchanged: 0,      // 本次连"读"都省掉的会话数（增量读的收益，要可观测）
    incremental: 0,    // 本次从偏移续读的会话数
    partialReads: 0,   // 本次因字节预算没读完的会话数（P0-2）
    deferred: 0,       // 本次因时间预算整会话没轮到的数量（P0-2）
    abandoned: 0,      // 本次被"下一轮 start"顶掉、收成 partial 的孤儿轮次数（P1-1）
    rollbacks: 0,      // 本次坏游标回退次数（P1-2）
    statePruned: 0,    // 本次回收的失效游标数（P2-2）
    // ── ★ v0.5 审计整改（可观测性：每一条整改都要能在日志里看见）──
    shrinkRollbacks: 0, // P0-1：文件变小 → 游标作废、全量重读的会话数
    identityRewrites: 0,// P0-1：同大小但身份指纹变了（被重写）的会话数
    mtimeRewrites: 0,  // V0.9：头/大小没变但 mtime 变了（尾部被改过）→ 按"可能被重写"重读的会话数
    deferredTurns: 0,   // P0-3：因批间预算用完、本轮未处理的轮次数
    pendingTurns: 0,    // P0-2：新记进 .pending.jsonl 的未闭合轮次数
    // ★ F1（v1.0.0-preview4 · R1/R2）：未闭合轮**可见性**。
    //   openTurnList：本 tick 见到的未闭合轮逐项清单（→ run-report.openTurns，人能逐项追查）
    //   staleOpenTurns：其中"源已静止 >2×interval"的条数（→ gate.knownGaps → degraded）
    //   @why 只算 stale：活跃写入的进行中轮次是**正常**形态，算进来会每 tick 常红（假警报），
    //        而"源已静止还开着"才是"这一轮永远不会闭合"的真缺口。
    openTurnList: [],
    staleOpenTurns: 0,
    pendingDup: 0,      // P0-2：已记过而跳过（幂等去重）的 pending 轮次数
    pendingRejected: 0, // P0-2：pending 留痕失败/超出上限而没记下的次数
    eventBatches: 0,    // P0-3：本轮事件采集实际用了多少批
    eventOversize: 0,   // P0-3：单批超事件数/字节预算而自动缩批的次数（可观测，不静默）
    blockedSources: 0,  // P1-5：因坏帧而"有意停摆"的会话数（游标不推进，必须被看见）
    // ★ 审计 #1：报告要的是"清单"，不是计数。这里如实收集，报告里才不会是硬编码空数组。
    blockedList: [],    // [{source,kind,attempts}]
    frameErrors: [],    // ★ CH-09：[{source,offset,failed,reason}] —— 坏帧必须能按偏移定位
    contractViolations: 0, // ★ F-3（方案 B）：帧=整行契约被破坏的会话数（硬断言停手，必须被看见）
    batchRecords: [],   // [{n,turns,events,bytes,oversize}] —— INV-11/12 的机读证据
    shortReads: 0,      // P1-5：读到半截帧（短读）的会话数
    checkup: '',       // 本次体检报告编号（空 = 没跑）
    weekly: '',        // 本次周记账写入情况（groups/written）
    // ── ★ 0.9.4-re1（P3 接线）：三项新能力的可观测字段（既有字段一个不删、不改义）──
    //    weeklyDeferred：本 tick 因预算（WEEKLY_BUDGET: 200 组/20 s）未处理完的组数；
    //      余量已由 lib/weekly.js 写进 state.weeklyCatchup，下一 tick 续跑（如实上报，不静默丢）。
    weeklyDeferred: 0,
    //    monthly：本 tick 月账视图生成摘要 {months,written,unchanged,failed,ms}（未触发 = null）。
    monthly: null,
    //    index：本 tick 索引增量摘要 {built,rows,ms}（built=false = 条件不满足、本轮没建；
    //      rows = 索引当前总行数；索引是派生数据，不是账务事实）。
    index: null,
    firstRun: false,   // 本轮是否属于"首次运行"（首次会强制全量扫）
    // ★ V0.6.2：一级布局快照（拿到写锁、建根之后探测；见 ①b）
    //   形状：{version:1|2|3, marker:boolean, oldFiles:[{name,kind}], dirsPresent:[string]}
    layout: null,
    legacySources: 0,  // 本轮纳入的 v3 只读历史源会话数
    sourcePairs: 0,    // v3/v4 并存的会话对数（按 v4 优先纳入）
    legacyPrefixSessions: 0, // 需要"用 v3 补前缀历史"的并存会话数
    legacyPrefixTurns: 0,    // 本轮从 v3 前缀补回的轮次数
    hotWindowExtended: false, // 本轮是否因"停机缺口"放宽了热窗口
    retried: 0,        // 因失败保留旧游标、下一轮重试的会话数
    lostRecords: 0,    // 本轮写进 .lost.jsonl 的缺口留痕条数（B4）
    supplements: 0,    // 本轮写进补记册的条数（封板后发现的行）
    // ★ F2（v1.0.0-preview4）：封板后补记的**待办**（持久化在 state.supplementPending，每 tick 幂等重放）
    supplementPending: 0,        // 待重放组数（未放弃）
    supplementPendingGaveUp: 0,  // 连续 3 次失败已放弃自动重试（需人工）
    // ★ lite: 交接表已冻结，恒 0（S-1/§5.3）—— 以下四项只为日志/报告形状不变而保留。
    handoverGenerated: 0,
    handoverAdopted: 0,
    handoverSkipped: 0,
    handoverSealedTotal: 0,
    // ── ★ 0.9.3 P2（S-9）：tick 预算 / 事件层有界 / 异常隔离 / 逐 tick 度量 ──
    //    每一项都必须可观测（"有界"与"失败可见"不能只靠嘴说）。
    budget: null,          // { scanBudgetMs, effectiveMs, hardMs, readBytes }（本轮实际生效的预算）
    consumedSourceBytes: 0,// 本轮各会话 (nextOffset−fromByte) 之和 = 源消费字节（S-9 口径的"消费"）
    eventReadBytes: 0,     // 事件批读的**预算上界**之和（产品侧估算；真实读盘由测量器实测）
    headFpBytes: 0,        // 本轮头指纹实际读取字节
    tailFpBytes: 0,        // 本轮尾指纹实际读取字节
    // ── ★ C25（整 tick 聚合消费硬预算）可观测字段（只加不改；每一项都必须能按 tick 核对）──
    probeBytes: 0,          // 首帧探测实际读取字节（真实 IO；计入 .tick-metrics 的读盘估算，不许少报）
    byteDeferredSessions: 0,// 本 tick 因"整 tick 17 MiB 聚合预算"放不下而整会话延后的数量
    // ★ P1-03：本 tick 因**时间预算**到点而没轮到的会话数（与 byteDeferredSessions 对称；
    //   两者都会给"从没写过游标"的会话补 partialCommit 游标，防止被热窗口永久过滤）。
    timeDeferredSessions: 0,
    prefixDeferred: 0,      // 本 tick 因字节预算延后的 v3 前缀补历史次数（下一 tick 重试）
    eventAmpDeferredBatches: 0, // 本 tick 因读放大硬顶（40 MiB）没读的事件批数
    firstFrameUnbounded: 0, // 首帧超过探测上限、只能按"放得下"开读的次数（审计关注项）
    eventReadRetries: 0,   // 事件批读因"未集齐本批轮次"而放大预算重试的次数
    eventShortBatch: 0,    // 事件批读重试后仍缺轮次 → 本批不落账、游标不推进的次数（必须为 0）
    eventTruncatedBatch: 0, // ★ K-16：事件批读重试后仍有"预算截断轮" → 本批不落账的次数（必须为 0）
    sessionCrashed: 0,     // 单会话未捕获异常次数（异常隔离生效证据）
    sessionsErrored: 0,    // 本轮产生过错误（stat.errors 有增量）的会话数
    quarantined: 0,        // 本轮因失败退避而**跳过**的会话数
    quarantineNew: 0,      // 本轮新进入退避（连续失败 ≥3）的会话数
    stalledDetected: 0,    // 停滞检测：上一轮未完成游标的会话本轮"既没进也没前进"的数量（修好后应恒 0）
    stalledList: [],       // [{source, reason, offset, size}] —— 停滞必须能按源定位
    hotWindowExempted: 0,  // 本因热窗口过滤、因"未完成游标例外"而被保留扫描的会话数（P2-2）
    phases: {              // 分阶段计时（毫秒）—— C25"30 s 花在哪"的机读证据
      scanMs: 0,
      eventsMs: 0,
      persistMs: 0,
      weeklyMs: 0,
      reconcileMs: 0,
      reportMs: 0,
      // ★ P1-02（审计 P1-02）：旧口径只计量"扫描段"，周账/对账/索引/收据/目录都在预算之外，
      //   于是"单 tick ≤30 s"的宣称与实测（可 >50 s）对不上。这里把后四段也纳入计时，
      //   并由 tick-metrics 的 budget/phaseSum 如实暴露超顶（可观测优先于漂亮）。
      indexMs: 0,
      catalogMs: 0,
      receiptMs: 0,
      monthlyMs: 0,
      // ★ P1-02：本轮因"剩余时间预算不足"而**整段跳过**的段名（下一 tick 自然重试）。
      deferredSegments: [],
    },
    tickStartedAtMs: 0,    // 本轮开始时刻（墙钟；.tick-metrics 用）
    errors: [],
    // ★ 告警通道（与 errors 分开）：不是"出错了"，而是"该知道但不算失败"的事实。
    //   现状用途：补记链只产计划、不执行 action（正式版接执行器）。
    //   分开的理由：首跑新会话**必然**产出补记计划，写进 errors 会让"零错误"这条验收永远红，
    //   等于把正常状态报成故障（2026-11-09 夜压测实测：errors 断言被这条打红）。
    warnings: [],
  };
  stat.tickStartedAtMs = tickStartedAtMs;

  // ★ re3（RT-01）：分桶真读字节初始化（外层 runOnce 收尾时用 fs 计量器覆写真实总量）。
  stat.realReadBytes = 0;
  stat.realReads = 0;
  stat.scanReadBytes = 0;
  stat.weeklyReadBytes = 0;
  stat.stateWriteReadBytes = 0;
  stat.catalogReadBytes = 0;
  stat.indexReadBytes = 0;
  stat.receiptReadBytes = 0;
  stat.reconcileReadBytes = 0;
  stat.reportReadBytes = 0;

  // ★ re3（ARCH-04）：把可选增强面（Agent 工具/面板 API）的挂载健康度带进本轮 stat。
  //   @why 旧实现挂载失败只写系统临时目录的启动日志：用户/审计在账库里看不到
  //     "工具面/面板没挂上"，HMR 后不恢复也无从发现。现在：
  //     stat.mount → tick-metrics 的 mount 段 + .state.json 的 lastStat.mount；
  //     一句话告警 → stat.warnings → 运行报告 warnings 段 + 日志（可查、可审计）。
  const mountNow = snapshotMountHealth();
  if (mountNow) {
    stat.mount = mountNow;
    if (mountNow.degraded && (mountNow.attempts >= 3 || mountNow.gaveUpAt)) {
      const line = mountHealthWarning(mountNow);
      stat.warnings.push(line);
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
    }
  }

  // ① 数据总库先存在（首次运行会建）
  try {
    fs.mkdirSync(cfg.root, { recursive: true });
  } catch (e) {
    stat.errors.push('mkdir root failed: ' + e.message);
    return stat;
  }

  // ①a ★ V0.6.2（《v0.6.2-迁移规格-v1》§1.2）：确保账库根标记 `.ledger-root`。
  //
  //   为什么在锁内、探测与任何写入之前：marker 是"这个目录是账库"的唯一**正向身份**
  //   （清理/迁移/打包工具靠它认账库、靠它拒绝越界）。老库（v0.6.1 及以前）没有标记，
  //   新版本第一次碰到就在这里补写；已合规时幂等（一个字节都不写，不搅 mtime）。
  //   失败只 warn：标记写不进去（权限/磁盘满）不该拦记账主职责，但必须出声、不许静默。
  const markerNowMs = Date.now();
  let markerInfo = { ok: false, created: false, updated: false, reason: 'E_MARKER_NOT_RUN', detail: '' };
  try {
    markerInfo = ensureRootMarker(cfg.root, { nowMs: markerNowMs, offsetMinutes: cfg.offsetMinutes });
  } catch (e) {
    markerInfo = {
      ok: false, created: false, updated: false,
      reason: 'E_MARKER_THROW', detail: (e && e.message) || String(e),
    };
  }
  if (!markerInfo || markerInfo.ok !== true) {
    const line = '账库根标记 .ledger-root 未就位（只 warn，不拦记账）: ' +
      ((markerInfo && markerInfo.reason) || '?') +
      (markerInfo && markerInfo.detail ? '（' + markerInfo.detail + '）' : '');
    stat.warnings.push(line);
    if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
  } else if ((markerInfo.created || markerInfo.updated) && log.info) {
    log.info('[dsh-dialog-ledger] 账库根标记' + (markerInfo.created ? '已补写' : '已升级') + ': ' + markerInfo.path);
  }

  // ①b ★ V0.6.2（§2.2）：探测一级布局，快照进 stat.layout + 运行报告。
  //
  //   为什么在锁内、写产物之前：探测必须是"本轮写入前的现状"；而且探测本身是纯只读
  //   （readdir + stat），成本与账本大小无关。
  //   为什么**不自动迁移**：规格 §三 定死"唯一写盘入口"是 `docs/工具-迁移布局.mjs`；
  //   宿主每轮自动搬文件 = 第二个写者，且 rename 失败/冲突没有人工介入点，账库容易半搬。
  //   所以这里只告警 + 给建议命令。
  try {
    const det = detectLayout(cfg.root);
    stat.layout = {
      version: det.layoutVersion,
      marker: det.hasMarker === true,
      oldFiles: (det.oldFiles || []).map((f) => ({ name: f.name, kind: f.kind })),
      dirsPresent: Array.isArray(det.dirsPresent) ? det.dirsPresent.slice() : [],
    };
    if (stat.layout.oldFiles.length > 0) {
      const names = stat.layout.oldFiles.map((f) => f.name);
      const line = '一级还有旧布局散落单据 ' + names.length + ' 份（建议跑 ' +
        'docs/工具-迁移布局.mjs --write 迁移；本轮**不自动迁移**）: ' +
        names.slice(0, 5).join('、') + (names.length > 5 ? ' …' : '');
      stat.warnings.push(line);
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
    }
  } catch (e) {
    // 探测失败不改任何写路径：布局只是可观测性，不许因为探测把记账拖垮
    stat.layout = null;
    const line = '布局探测失败: ' + (e && e.message ? e.message : String(e));
    stat.warnings.push(line);
    if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
  }

  // ② 找会话文件
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const sessionsBase = path.join(dshHome, 'sessions');
  // ★ 不再只认 v4：v3 会话按「只读历史源」纳入（实测本机 5 个 v3-only 会话、98 轮
  //   原本被版本守卫静默挡在账外，违反"不能主动遗忘"）。返回值与旧 scanSessions 兼容。
  const scanned = scanSessionSources(sessionsBase);
  let sessions = scanned.supported;
  // P2-2：GC 游标要用全量会话列表，不能是热窗口过滤后的。
  const allSessions = sessions;
  stat.legacySources = sessions.filter((s) => s.source === 'v3').length;
  stat.sourcePairs = scanned.pairs.length;
  // v3/v4 并存且 v4 起点更晚 → v3 持有 v4 缺失的前缀历史，必须补回来（决定 7 / GL-10）。
  //   实测真实环境并存对极少；这里只读少量字节比较 createdAt，与账本大小无关。
  const prefixByDir = resolvePairPrefixes(scanned.pairs);
  stat.legacyPrefixSessions = prefixByDir.size;
  // ★ K-9/RT-03（v1.0.0-re3）：v3/v4 头部探测的**真实读盘**必须计入本轮度量。
  //   旧写法只统计 probeFirstFrameBytes，把每 tick 的头部探测漏在账外
  //   （审计③ RT-03：自报 134.8 KiB vs 真读 657.8 KiB，自报低 4.9×）。
  //   `resolvePairPrefixes()` 返回的 Map 上挂了非枚举 `stats`，`bytesRead` 是真实读字节（缓存命中=0）。
  try {
    const ps = prefixByDir && prefixByDir.stats ? prefixByDir.stats : null;
    if (ps) {
      const hb = Number(ps.bytesRead) || 0;
      if (hb > 0) stat.probeBytes += hb;
      stat.legacyPrefixProbe = {
        bytesRead: hb,
        cacheHits: Number(ps.cacheHits) || 0,
        cacheMisses: Number(ps.cacheMisses) || 0,
        decompressedBytes: Number(ps.decompressedBytes) || 0,
        rejected: Number(ps.rejected) || 0,
        skippedPairs: Number(ps.skippedPairs) || 0,
      };
    }
  } catch { /* 度量失败不许拖垮记账 */ }
  if (stat.legacySources > 0 && log.info) {
    log.info('[dsh-dialog-ledger] v3 只读历史源纳入 ' + stat.legacySources + ' 个会话');
  }

  // ③ 首次运行必须全量扫。
  //
  //    hotWindow 的意义是"平时省 IO"，但若首次也用它，一小时前的老会话
  //    就永远进不了账——历史轮次永久缺失，而且文件系统里不会留下任何
  //    "这里本来就缺"的痕迹，等于账不完整却无从发现。
  //
  //    判定依据放在 root 下的 state 文件里，而不是内存变量：
  //    这样重启之后依然记得"已经首跑过"，不会每次重启都全量。
  // ★ P1-9（审计 M-02）：区分「没有 state」与「state 读坏」。
  //   · 没有 → 首次运行（firstRun，全量扫）
  //   · 读坏 → **停写并报错**，不是"重新开账" —— 后者会把已封板的东西重建一遍
  const stateRead = readStateEx(cfg.root);
  if (stateRead && stateRead.ok === false) {
    const code = (stateRead.error && (stateRead.error.code || stateRead.error.message)) || '?';
    stat.errors.push('state corrupt: ' + code);
    if (log.warn) log.warn('[dsh-dialog-ledger] .state.json 读坏 → 本轮不写（避免把已封板产物重建）: ' + code);
    return stat;
  }
  const state = (stateRead && stateRead.state) || {};
  // ★ 0.9.3 P2-6：state 读盘字节（.tick-metrics 的 io 分桶；readStateEx 已带 bytes）。
  stat.stateBytes = Number.isFinite(stateRead && stateRead.bytes) ? stateRead.bytes : 0;
  stat.firstRun = !state.initialized;
  // ★ 0.9.3 P2-2：先取"未完成游标"集合 —— 热窗口过滤必须给它开口子（见下）。
  const cursorsAtStart = state.sourceCursors && typeof state.sourceCursors === 'object'
    ? state.sourceCursors
    : {};
  const unfinishedCursorPaths = new Set();
  for (const [p, c] of Object.entries(cursorsAtStart)) {
    if (!c || typeof c !== 'object') continue;
    // 口径：partialCommit（预算截断）或 blocked（坏帧停摆）或"读到一半（offset<size）"都算未完成。
    const unfinished = c.partialCommit === true || c.blocked === true ||
      (Number.isInteger(c.offset) && Number.isInteger(c.size) && c.offset < c.size);
    if (unfinished) unfinishedCursorPaths.add(p);
  }
  const effectiveHotWindow = stat.firstRun ? 0 : cfg.hotWindowSeconds;
  if (effectiveHotWindow > 0) {
    let cutoff = Date.now() - effectiveHotWindow * 1000;
    // ★ 停机缺口兜底（P2-3 的另一半）：只按 hotWindow 过滤，会让"停机时间超过热窗口"
    //   期间产生/更新的会话永久进不了账（mtime 老了，而账里没有；文件系统也不会留痕）。
    //   用 lastRunAt 往前推一个安全边距，保证"上次跑到这次之间动过的会话"至少被看一次。
    const lastRunMs = Date.parse(String(state.lastRunAt || ''));
    if (Number.isFinite(lastRunMs)) {
      const gapCutoff = lastRunMs - Math.max(2 * cfg.intervalSeconds, 60) * 1000;
      if (gapCutoff < cutoff) {
        cutoff = gapCutoff;
        stat.hotWindowExtended = true;
      }
    }
    // ★★★ 0.9.3 P2-2（E3 实测：offset=187/partialCommit=true 后永久停滞）：
    //   未完成游标（预算截断 / 坏帧停摆 / 读到一半）的会话**不受热窗口过滤**。
    //   不改这一条，P2-1 改得再好也只是"下一次 tick 继续读，但它根本进不来"；
    //   反面证据：index.js 明明实现了 partialCommit 续跑（resumedSessions/resumeFrom），
    //   却因为会话在这里被滤掉而形同虚设。
    //   代价可控：例外集只含"上次没读完"的会话（常态 0–1 个），不会把整个老库拖进扫描。
    stat.hotWindowExempted = 0;
    sessions = sessions.filter((s) => {
      if (s.mtimeMs >= cutoff) return true;
      if (!unfinishedCursorPaths.has(s.path)) return false;
      stat.hotWindowExempted++;
      return true;
    });
    // 度量：未完成游标的会话**仍然**被滤掉（= 停滞会复发）的数量。修好后应恒为 0；
    //   源文件已消失的不算（由 ⑧ 的游标回收处理，不是停滞）。
    const keptPaths = new Set(sessions.map((x) => x.path));
    for (const p of unfinishedCursorPaths) {
      if (keptPaths.has(p)) continue;
      if (!allSessions.some((x) => x.path === p)) continue;
      stat.stalledDetected++;
      stat.stalledList.push({ source: p, reason: 'hot-window-filtered-unfinished' });
    }
  }
  stat.scanned = sessions.length;
  // ★ P2-2 的现场证据：有未完成游标、且本轮确实要处理它们（进循环后会续跑）。
  stat.unfinishedCursors = unfinishedCursorPaths.size;

  // ③b 版本守卫：v3 已由「只读历史源」接管；更老的格式（v2 及以前）必须报出来，不许静默跳过。
  for (const u of scanned.unsupported) {
    stat.errors.push('unsupported session format v' + u.version + ': ' + path.basename(u.dir));
  }
  // v3/v4 并存：一律以 v4 为源（DSH 升级时会把旧事件种子化进 v4，实测为超集）；
  // 逐对核验是离线工具的事（见 docs/工具-核验v3并存.mjs），不放进每轮扫描——太贵。

  // ③c 续读游标：每个会话读到哪个字节、那一轮有没有闭合。
  //     放在 state 里而不是内存：重启之后仍能续读，不用把几十 MB 重解一遍。
  const cursors = state.sourceCursors && typeof state.sourceCursors === 'object'
    ? { ...state.sourceCursors }
    : {};

  // ④ 台账里已有什么（用于查重与分配序号/代差）
  //
  // ★ P1-4 / P2-4（异地压测发现）：原实现每 60 秒无条件 readAll + 全表 parseCode +
  //   groupRecords，20 万条账时空转一次要 1.13s（同步阻塞主线程），且编号分配
  //   每次全表扫（O(N²)）。这里改成**跨轮缓存**：
  //   · 台账文件指纹（文件名:大小:mtime）不变 → 直接用上一次建好的索引；
  //   · 索引里带 seqMax / sidGen 映射，编号与代差分配降到 O(1)；
  //   · 本轮有新写入 → 增量维护缓存，并刷新指纹，避免下一轮重建。
  const idxCache = ensureLedgerIndex(cfg.root);
  const records = idxCache.records;
  const badLines = idxCache.badLines;

  // ★ P0-3-resume 留痕：本次读取如果自愈了"崩溃撕裂尾巴"，必须**出声**（不许静默修）。
  //   放在 P1-8 早退之前：即使本轮因为别的账文件读坏而停写，这次修复也要进日志/运行报告。
  //   只做留痕传递（warn + stat + state），不改变任何状态机分支。
  if (Array.isArray(idxCache.tornTailRepaired) && idxCache.tornTailRepaired.length > 0) {
    stat.tornTailRepaired = idxCache.tornTailRepaired.map((t) => ({ ...t }));
    for (const t of idxCache.tornTailRepaired) {
      const line = '台账撕裂尾巴已自愈（崩溃残留，仅末行半行）：' +
        `${t.file}:L${t.line} 截断 ${t.bytes}B sha256=${String(t.sha256).slice(0, 16)}… 证据=${t.evidence}`;
      stat.warnings.push(line);
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
    }
  }

  // ★ P1-8（审计 M-04）：「读不到」不许当成「没有」。
  //   账读不全时本轮**禁止任何落账** —— 否则可能给一个"其实已存在的 code"再写一条，
  //   或让交接表生成一份假的"无上下文"。空数据只能由**成功读取**证明。
  if (idxCache.ledgerOk === false) {
    const why = (idxCache.readErrors && idxCache.readErrors[0]) || 'read failed';
    stat.errors.push('ledger-unreadable: ' + why);
    if (log.warn) log.warn('[dsh-dialog-ledger] 台账读取失败 → 本轮不写：' + why);
    // ★ 审计 #2：读坏的那一轮也必须留下**带结论的运行报告**，
    //   否则昨天那份 ok=true 的报告会一直躺在那里冒充"最近一次很健康"。
    try {
      writeRunReport({
        root: cfg.root,
        result: null,
        errors: aggregateReportErrors(cfg.root),
        warnings: Array.isArray(stat.warnings) ? stat.warnings : [],
        blockedSources: [],
        stuckSources: [],
        unavailable: ['reconcile', 'batches', 'pending', 'legacyPartials', 'integrityFailures', 'stuckSources'],
        gate: { conclusion: 'unknown', reason: 'ledger-unreadable: ' + why, okStrict: false },
        // ★ V0.6.2：布局快照进报告（读坏的那一轮也要说清"旧布局/新布局"）
        layout: stat.layout,
        // ★ P0-3-resume：即使本轮因"另有坏行"停写，本次撕裂尾巴自愈也必须进报告
        ...(Array.isArray(stat.tornTailRepaired) && stat.tornTailRepaired.length > 0
          ? { tornTailRepaired: stat.tornTailRepaired } : {}),
        nowMs: Date.now(),
        offsetMinutes: cfg.offsetMinutes,
      });
    } catch (e) {
      stat.errors.push('run-report failed: ' + (e && e.message ? e.message : String(e)));
    }
    return stat;
  }
  if (Array.isArray(idxCache.readErrors) && idxCache.readErrors.length > 0) {
    for (const e of idxCache.readErrors.slice(0, 5)) stat.errors.push('ledger read error: ' + e);
  }

  // 坏行必须出声：它意味着"账里有读不出来的东西"，也就是账已经不完整。
  // 原实现只取 records，把 badLines 丢了 —— 那等于"缺了但没人知道"。
  if (badLines > 0) {
    stat.errors.push('bad ledger lines=' + badLines);
  }

  // 已入账的编码集合：交给 appendTurn 后，它不必每条都重读整个台账。
  // 原实现是每条都 hasCode→readAll，1315 轮会做约 86 万次 JSON.parse；
  // 这里复用索引缓存，语义完全等价（同一进程内串行写，没有别人插队）。
  const knownCodes = idxCache.knownCodes;

  // 体检素材：账上已有的 partial + 本轮新写的 partial
  const partials = records.filter((r) => r && r.status === 'partial');
  // 本轮新写入的记录（周记账只需要处理"被这些记录触碰到的组"）
  const writtenRecords = [];

  // 每个会话已记多少条 —— 增量读跳过整份会话时，用它把 skipped 补对。
  // 为什么要在意这个数：skipped 是审计口径里的"已记过、这轮没重写"，
  // 如果因为"文件没变、连读都没读"就记 0，看日志的人会误以为这一轮什么都没发生。
  const knownBySid = idxCache.knownBySid;

  // ── P1-9 封板证据：**每轮只读一次** journal，缓存后注入下游 ──
  //
  // @why 为什么必须缓存：补记链（backfillPlan）每轮只需要一份 journal 快照；
  //   本进程是 journal 唯一写者，同一轮里读一次的快照对周账封板成立。
  //   （lite：交接表已冻结 → 不再为每个会话重读 journal，只留周账封板映射。）
  //
  // @why 读失败不能当"没封过板"：readSealJournalState 同样区分 readError（读失败）与空册。
  //   这里只把失败如实进 errors，也不能把 readError 当成"有/无封板"的结论。
  // ★ 0.9.4-re1（W1）：由 KERNEL `readSealEvents()`（每 tick 整读 journal）换成本模块的
  //   `readSealJournalState()` —— 同一份尾读缓存（稳态只 stat + 读新增字节），且下一段
  //   runWeeklyBudget() 会直接复用这份缓存，不会再整读一遍。`events` 变摘要（无 rows），
  //   本处只用 kind/key 与 readError/badLines 计数，口径不变。
  const sealRead = readSealJournalState(cfg.root);
  // ★ 0.9.4-re1：兼容守卫 —— 旧 `readSealEvents()` 走整读，journal 路径若被换成**目录/非普通文件**
  //   会报 readError；而尾读缓存按 `stat.size=0` 把它当"空册"（Windows 上目录 size 恒 0）。
  //   这里补一次 stat（成本 = 1 次 stat，与账本大小无关），把这种"读不到"如实报出来 ——
  //   绝不把"读不到"当作"没封板"（审计 M-02/M-03 口径）。
  let sealNotRegularFile = false;
  try {
    const jPath = sealRead.path || path.join(cfg.root, 'ledger', '.seal-journal.jsonl');
    sealNotRegularFile = fs.statSync(jPath).isFile() !== true;
  } catch { sealNotRegularFile = false; }
  if (sealNotRegularFile && !sealRead.readError) {
    stat.errors.push('seal journal read failed: not a regular file: ' +
      (sealRead.path || path.join(cfg.root, 'ledger', '.seal-journal.jsonl')));
  }
  if (sealRead.readError) stat.errors.push('seal journal read failed: ' + sealRead.readError);
  if (sealRead.badLines > 0) stat.errors.push('seal journal bad lines=' + sealRead.badLines);
  if (sealRead.chainBroken > 0) stat.errors.push('seal journal chain broken=' + sealRead.chainBroken);
  /** 周记账封板映射（gid → 事件）→ 补记链 backfillPlan 的 `seals` 入参。 */
  const weeklySeals = {};
  for (const ev of sealRead.events) {
    if (!ev || typeof ev.key !== 'string') continue;
    if (ev.kind === 'weekly-seal') weeklySeals[ev.key] = ev;
  }

  // ★ lite：交接表（表头目录）能力已冻结（S-1/§5.3）—— 原 ensureSessionHandover 薄包装
  //   与 handoverSeals 映射整段删除：不再生成/认领/封板交接表，也不再有 handover 失败分支。

  // 预先把记录整理成 encoder 需要的形状。
  //
  // ★ 这里不再自带一份正则，改用 encoder 的 parseCode：
  //   「正则唯一权威」如果落成两份实现，迟早会漂，而漂的那一刻
  //   账里就会出现"能过一份、过不了另一份"的编码 —— 不可审计。
  // existing / seenTurns / badCodes 都由索引缓存提供（见 ensureLedgerIndex）。
  // 不再每轮全表 map + parseCode。
  const existing = idxCache.existing;
  const seenTurns = idxCache.seenTurns;
  if (idxCache.badCodes > 0) {
    stat.errors.push('invalid codes in ledger=' + idxCache.badCodes);
  }

  // 预先把记录整理成 encoder 需要的形状（见上：已改用 parseCode，此处不再重复映射）

  // ★★★ 已记过的 (sid, turn) 集合 —— 幂等的真正闸门
  //
  // 为什么要单独建这个集合：
  //   v0.1 第一版只靠"算出的 code 是否已存在"来查重，结果第二轮
  //   把 1315 条全部重写了一遍（编码变成了 seq=1316..2630）。
  //   根因是：每轮都从 turn 1 开始遍历，却被 nextSeq 分配了"接着往后"的序号
  //   → 编码不同 → 查重拦不住。
  //
  //   正确的闸门是：**这一轮的 (会话, 轮次) 是否已经记过**。
  //   记过就跳过，连号都不分。这样重跑多少次都不会多写。


  // ⑤ 逐个会话处理（P0-2：带时间预算，到点就收工，剩下的下一轮再说）
  //
  // ★ 0.9.3 P2-4（S-9）：预算 = min(scanBudgetMs, TICK_HARD_MS)。scanBudgetMs=0（配置"不限"）
  //   也受硬顶约束 —— C25 的"单 tick ≤30 s"是硬判据，不能让"不限"配置把它破掉。
  //   超预算时的口径：**先落已提交批次再退出**（批边界检查 → sessionFailed →
  //   游标提交到已提交批的末尾 committedByte + partialCommit），不阻塞、不丢批。
  const budgetMs = Math.max(0, cfg.scanBudgetMs || 0);
  const effectiveBudgetMs = budgetMs > 0 ? Math.min(budgetMs, TICK_HARD_MS) : TICK_HARD_MS;
  const deadline = tickStartedAtMs + effectiveBudgetMs;
  // ★ P1-02：整 tick 时间预算的唯一读数（正数 = 余量，负数 = 已超顶）。
  //   用于"可选段到点就整段跳过"，把周账/索引/收据/目录/对账也纳入同一预算。
  const remainingBudgetMs = () => deadline - Date.now();
  // 可选段的"最小可开工余量"：低于它就不开工（开工也只会把 tick 拖过顶）。
  const SEGMENT_MIN_START_MS = 1500;
  /** 记录本 tick 因预算不足被整段跳过的段（下一 tick 自然重试）。 */
  const deferSegment = (name) => {
    stat.phases.deferredSegments.push(name);
    const line = '时间预算剩余 ' + Math.max(0, remainingBudgetMs()) + ' ms：本 tick 跳过「' + name + '」段（下一 tick 重试）';
    stat.warnings.push(line);
  };
  stat.budget = {
    scanBudgetMs: budgetMs,
    effectiveMs: effectiveBudgetMs,
    hardMs: TICK_HARD_MS,
    readBytes: TICK_READ_BUDGET_BYTES,
  };
  let deferredFrom = -1;
  /** 本轮累计源消费字节（S-9：≤17 MiB/tick）。 */
  let tickConsumedSourceBytes = 0;

  /**
   * 失败退避（P2-5）：会话游标 failCount+1；连续失败达阈值 → 记退避截止时刻。
   * @why 只对**真的出错**的会话记（read failed / 坏帧 / 坏头 / 写入失败 / 崩溃），
   *      不把"时间/字节预算截断"当失败 —— 否则大语料会因"一轮没跑完"被误封，
   *      反而制造新的永久停滞。
   */
  const bumpSessionFailCount = (filePath, fallback) => {
    const base = cursors[filePath] && typeof cursors[filePath] === 'object'
      ? cursors[filePath]
      : (fallback && typeof fallback === 'object' ? fallback : null);
    const fc = (base && Number.isInteger(base.failCount) ? base.failCount : 0) + 1;
    const backoff = fc >= SESSION_FAIL_BACKOFF_AFTER;
    const intervalSec = Number.isFinite(cfg.intervalSeconds) ? Math.max(10, cfg.intervalSeconds) : 60;
    cursors[filePath] = {
      ...(base || {}),
      size: base && Number.isFinite(base.size) ? base.size : 0,
      offset: base && Number.isInteger(base.offset) ? base.offset : 0,
      failCount: fc,
      ...(backoff
        ? { backoffUntilMs: Date.now() + SESSION_FAIL_BACKOFF_TICKS * intervalSec * 1000 }
        : {}),
      updatedAt: isoTime(Date.now(), cfg.offsetMinutes),
    };
    if (backoff) {
      stat.quarantineNew++;
      const line = '会话连续失败 ' + fc + ' 次 → 退避 ' + SESSION_FAIL_BACKOFF_TICKS +
        ' 轮（source=' + path.basename(path.dirname(filePath)) + '）';
      stat.warnings.push(line);
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
      // ★ 契约 D9：错误枚举（ledger.ERROR_KINDS）里没有 SESSION_QUARANTINED，
      //   新增枚举属 KERNEL 改动（本版不做）→ 复用最接近的 FRAME_FAILED，
      //   用 detail 写清"这是退避而不是坏帧"，原因与次数都留痕（R-02 节流由 lib 负责）。
      try {
        appendErrorEvent(cfg.root, {
          kind: 'FRAME_FAILED',
          source: filePath,
          sourceBytes: base && Number.isFinite(base.size) ? base.size : 0,
          sourceMtimeMs: base && Number.isFinite(base.mtimeMs) ? base.mtimeMs : 0,
          offset: base && Number.isInteger(base.offset) ? base.offset : 0,
          detail: 'SESSION_QUARANTINED: consecutiveFailures=' + fc +
            '; backoffTicks=' + SESSION_FAIL_BACKOFF_TICKS + '; retryable=true',
          retryable: true,
        }, { offsetMinutes: cfg.offsetMinutes });
      } catch { /* 错误清单写不进去不拖垮退避本身（warning 已留痕） */ }
    }
    return fc;
  };

  /**
   * ★ C25：整 tick 字节预算放不下某会话时，把它记成**未完成游标**（下一 tick 续读）。
   *
   * @why 不能只是 `continue`：本 tick 没写游标 + 会话 mtime 又老 → 下一 tick 就被
   *      hotWindow 过滤掉，数据永久漏记。本修复第一版实测就踩到：3 个 v3 老会话
   *      （c31ebf8d / d71b7fae / d2a52413）被延后后**再也没进来**，账面 1,558 只剩 1,485 行。
   *      写成 partialCommit 游标后，P2-2 的"未完成游标不受热窗口过滤"会把它保进来。
   * @why 带上 head/指纹：下一 tick 才能从 fromByte 增量续读；没有会话头就回退全量重读
   *      （(sid,turn) 幂等闸门保证不重复入账，只是多花一次读）。
   * @param {boolean} [count] 是否计入 `stat.byteDeferredSessions`（"轮到自己但预算不够"才计；
   *        到硬顶后整批补游标的那次不计，避免与 `stat.deferred` 重复计数）。
   */
  const deferSessionByByteBudget = (sess, prevCur, fromByteCur, fp, fpLen, tail, tailLen, count = true) => {
    if (count !== false) stat.byteDeferredSessions++;
    const base = prevCur && typeof prevCur === 'object' ? prevCur : null;
    const headKnown = base && base.head && typeof base.head === 'object' ? base.head : null;
    const off = Number.isInteger(fromByteCur) && fromByteCur > 0 ? fromByteCur : 0;
    cursors[sess.path] = {
      size: Number.isFinite(sess.size) ? sess.size : 0,
      // 没有会话头就不能从中间续读（readSourceTurns 会 no-head-for-resume）→ 回落全量重读
      offset: headKnown ? off : 0,
      ...(headKnown ? { head: headKnown } : {}),
      ...(fp ? { headSha: fp, headFpLen: Number.isInteger(fpLen) ? fpLen : 0 } : {}),
      ...(tail ? { tailSha: tail, tailFpLen: Number.isInteger(tailLen) ? tailLen : 0 } : {}),
      ...(base && Number.isInteger(base.failCount) ? { failCount: base.failCount } : {}),
      mtimeMs: sess.mtimeMs,
      updatedAt: isoTime(Date.now(), cfg.offsetMinutes),
      partialCommit: true, // 未完成游标：下一 tick 必续读、且不进热窗口过滤
    };
  };

  // ★ re3（RT-01）：扫描段真读字节起点（会话循环结束后结算）。
  const readMeterScanStart = readMeterBytes();
  for (let si = 0; si < sessions.length; si++) {
    // ★ INV-13：取消优先于时间预算 —— 中止后不再开新会话（已提交的批不回滚）。
    if (aborted()) {
      stat.cancelled = true;
      // ★ re3（ARCH-01 配套）：中止也必须给"还没轮到的、从没写过游标"的会话补未完成游标 ——
      //   否则下一实例按热窗口过滤时会静默漏掉它们（与时间/字节预算路径同构，见 P1-03）。
      stat.timeDeferredSessions = (stat.timeDeferredSessions || 0) +
        fillUnvisitedCursors(sessions, si, cursors, (ss) => deferSessionByByteBudget(ss, null, 0, '', 0, '', 0, false));
      deferredFrom = si;
      break;
    }
    if (Date.now() >= deadline) {
      // ★ P1-03（审计 P1-03 · 机主裁定 V1.0 前解决）：时间预算的提前 break 必须与
      //   字节预算路径**对称**地补"未轮到"游标。
      //   @why 旧实现只 `deferredFrom = si; break;`：本 tick 没给这些会话写游标；
      //     下一 tick 若它们的 mtime 已落到 hotWindow 之外，就被热窗口过滤掉 →
      //     **静默永久漏记**（概率 ≈ 一个 interval / 热点窗口，且没有任何告警）。
      //     字节预算路径早就修了同一件事（C25），时间路径漏了 —— 这是不对称缺陷。
      //   @why 只给"从没写过游标"的会话补：已有游标的会话下一 tick 仍按原游标续读，
      //     热窗口对它们不是问题（写了游标就是"有据可续"）。
      //   ★ 与字节预算路径共用同一个 helper（fillUnvisitedCursors）—— 两条预算路径
      //     必须同构，将来改一处不会漏另一处。
      stat.timeDeferredSessions = (stat.timeDeferredSessions || 0) +
        fillUnvisitedCursors(sessions, si, cursors, (ss) => deferSessionByByteBudget(ss, null, 0, '', 0, '', 0, false));
      deferredFrom = si;
      break;
    }
    // ★ 0.9.3 P2-4（S-9 字节维）/ ★ C25：本 tick **所有源共享**的 17 MiB 硬预算。
    //   消费到硬顶就不再开新会话（已提交批不回滚；剩余会话下一轮按游标续读）。
    //   ★ 这只是"粗闸"：真正保证不越界的是下面"按会话预检 + 首帧探测"（见 C25 常量注释）。
    if (tickConsumedSourceBytes >= TICK_READ_BUDGET_BYTES) {
      // ★ C25 数据安全：还没轮到的会话里**从没写过游标**的，必须先补一个未完成游标 ——
      //   否则下一 tick 若它 mtime 已落到热窗口外，就永远进不来了（老 mtime + 无游标 = 静默漏记）。
      fillUnvisitedCursors(sessions, si, cursors, (ss) => deferSessionByByteBudget(ss, null, 0, '', 0, '', 0, false));
      deferredFrom = si;
      break;
    }
    const s = sessions[si];
    const prev = cursors[s.path] && typeof cursors[s.path] === 'object' ? cursors[s.path] : null;
    // ★ 0.9.3 P2-5：失败退避 —— 同会话连续失败 ≥3 次 → 后续 10 轮不再硬碰（不烧预算）。
    if (prev && Number.isFinite(prev.backoffUntilMs) && prev.backoffUntilMs > Date.now()) {
      stat.quarantined++;
      continue;
    }
    // 停滞检测用（P2-2/C21）：本轮开始时该会话是否"未完成"、以及起点偏移。
    const prevUnfinished = !!prev && (prev.partialCommit === true || prev.blocked === true ||
      (Number.isInteger(prev.offset) && Number.isInteger(prev.size) && prev.offset < prev.size));
    const prevOffset = prev && Number.isInteger(prev.offset) ? prev.offset : null;
    const writtenBeforeSession = stat.written;
    // ★ INV-14：本会话上次是"只提交了部分批次"中断的 → 本轮从已提交字节处续跑。
    //   没有这条，杀进程后的重启会从 0 重扫（靠 (sid,turn) 幂等也正确，但白读一遍）。
    if (prev && prev.partialCommit && Number.isInteger(prev.offset) && prev.offset > 0) {
      stat.resumedSessions++;
      stat.resumeFrom = prev.offset;
    }

    // ★ P0-1（审计 A-02，实测证据：12574 B → 259 B 后 Turn 2 未入账）
    //   原条件 `prev.size >= s.size && prev.offset >= prev.size` 有两个洞：
    //     ① 文件**变小**（截断/换成更短版本）仍满足 → 走 unchanged 快路径，新内容永久漏记；
    //     ② 文件**同大小重写**（内容全换、字节数恰好相等）同样被误判成没变。
    //   现在必须同时满足**四条**才算"真的没变"（0.9.3 加了第 ④ 条，见 P2-3）：
    //     ① 大小相同 ② 头部指纹相同 ③ mtime 相同 ④ 尾部指纹相同 ⑤ 上次确实读到了文件尾。
    //   指纹读不到（空串）一律按"不能证明没变"处理 —— 宁可多读一次，不可漏记一轮。
    // CH-09: bad frame => cursor stays at bad-frame start; declared before use to avoid TDZ.
    let sessionFailed = false;   // 本会话是否失败（失败则游标不按成功路径提交）
    let forcedCursorOffset = null; // CH-09: 坏帧起点（非 0、非 EOF）—— 仅非 halted 的 blocked 用
    // ★ K-4（LED-01）：坏帧停止是"可重试缺口"，不是整会话失败。
    //   halted=true 时：已解出的轮次照常落账；游标只提交到坏帧之前的已提交前缀末尾
    //   （prefixCommittedByte），绝不提交到 r.meta.nextOffset（=坏帧起点，会跳过前缀里
    //   没落账的轮次）或 EOF。
    let halted = false;          // 本轮是否停在坏帧处
    let haltOffset = 0;          // 第一个坏帧的起点（游标不许越过它）
    let prefixCommittedByte = 0; // 坏帧之前的已提交前缀末尾（最后一条落账/已入账轮次的 endByte）
    let deferredHaltStart = Number.POSITIVE_INFINITY; // 跨坏帧的轮次：游标必须退到它的 startByte
    // ★ 0.9.3 P2-5（异常隔离）：以下变量**在 try 外声明** —— 任一未捕获异常后
    //   仍要能在收尾处保留旧游标、记失败次数，不让整轮被一个坏会话拖垮。
    let r = null;
    let head = null;
    let curFp = '';
    let curFpLen = 0;
    let curTail = '';
    let curTailLen = 0;
    let committedByte = 0;
    /** 本会话扫描遍实际推进的源字节（停滞判据用：没有新字节 ≠ 停滞）。 */
    let scanConsumedBytes = 0;
    /** 本会话是否"正常走完"处理流程（中途 continue 的错误路径 = false，不许提交成功游标）。 */
    let sessionDone = false;
    /** 本轮开始时 stat.errors 的长度：判"本会话是否产生过错误"（失败退避用）。 */
    const errorsBeforeSession = stat.errors.length;
    //   若每轮按"当前文件长度"取指纹，一追加内容指纹就变 → 被误判成"被重写"
    //   → 增量读退化成全量重读（实测踩到：v0.2 增量用例 inc 变成 0）。
    //   所以沿用上一轮记录的取样长度；追加不会改动前缀字节，指纹因此稳定。
    const fpLen = prev && Number.isInteger(prev.headFpLen) && prev.headFpLen > 0
      ? Math.min(prev.headFpLen, cfg.headFingerprintBytes)
      : cfg.headFingerprintBytes;
    curFp = headFingerprint(s.path, fpLen);
    curFpLen = Math.min(fpLen, s.size);
    stat.headFpBytes += curFpLen;
    const sameSize = !!(prev && Number.isInteger(prev.size) && Number.isInteger(prev.offset) &&
      prev.size === s.size && prev.offset >= prev.size);
    const sameIdentity = !!(prev && prev.headSha && curFp && prev.headSha === curFp);
    // ★ V0.9（2026-11-11 定向探针 P1）：**同大小 + 头部指纹相同 + 尾部内容被换**时，
    //   上面两条都会判"没变"，新内容永久漏记 —— 这不是假想：探针现场构造出来过。
    //   mtime 是最便宜、最不会骗人的第三证据：内容真被重写过，mtime 一定变。
    //   旧游标没有 mtimeMs → 按"不能证明没变"处理（重读一次即可，幂等不会重复入账）。
    const sameMtime = !!(prev && Number.isFinite(prev.mtimeMs) && prev.mtimeMs === s.mtimeMs);
    // 有指纹且不相等 = 文件被重写过（哪怕大小凑巧一样）
    const rewritten = !!(prev && prev.headSha && curFp && prev.headSha !== curFp);
    // ★ 0.9.3 P2-3（S-9）：尾部 4 KiB 身份采样 —— 补"尾被改 + mtime 被还原"的盲区。
    //   只在 size 相同时才算（size 变了已证明文件变过，再读 4 KiB 没有判别力、白花 IO）。
    //   老游标没有 tailSha → 按"不能证明没变"处理（重读一次，幂等不重复入账）；
    //   **绝不**把"没有尾指纹"当"尾部相同"。
    curTailLen = Math.min(TAIL_FP_BYTES, s.size);
    if (prev && Number.isInteger(prev.size) && prev.size === s.size && s.size > 0) {
      curTail = tailFingerprint(s.path, curTailLen);
      if (curTail) stat.tailFpBytes += curTailLen;
    }
    const sameTail = !!(prev && prev.tailSha && curTail && prev.tailSha === curTail);
    const tailRewritten = !!(prev && prev.tailSha && curTail && prev.tailSha !== curTail);
    // mtime 变了但头/大小没变 = 尾部被改过（或仅被 touch）→ 同样按"可能被重写"处理
    const mtimeTouched = !!(prev && Number.isFinite(prev.mtimeMs) && prev.mtimeMs !== s.mtimeMs);
    if (rewritten) stat.identityRewrites++;
    if (tailRewritten) {
      stat.identityRewrites++;
      stat.tailRewrites = (stat.tailRewrites || 0) + 1;
    }
    if (mtimeTouched && !rewritten) stat.mtimeRewrites++;
    if (prev && Number.isInteger(prev.size) && s.size < prev.size) stat.shrinkRollbacks++;

    // 没有任何新增字节：连读都不读。
    // 这是增量读真正省下来的那部分 IO —— 会话没变，就不该再解一遍。
    if (sameSize && sameIdentity && sameMtime && sameTail) {
      // 没读，但"这些轮次已经记过了"这件事仍要如实计进 newTurns / skipped，
      // 否则日志会显示 turns=0、skipped=0，像是这一轮什么都没发生。
      // 口径：newTurns = "这一轮扫到多少轮"（含已入账的），skipped = "其中多少轮已记过"。
      const knownSid = prev.head && typeof prev.head.id === 'string' ? prev.head.id : '';
      if (knownSid) {
        const n = knownBySid.get(knownSid) || 0;
        stat.newTurns += n;
        stat.skipped += n;
      }
      stat.unchanged++;
      continue;
    }

    // 续读点必须落在帧起点；被重写或变小 → 游标作废，必须回退全量重读。
    // ★ 增长时也要求"身份未变"（老游标没有指纹时只能放行一次，读完就会补上指纹）。
    let fromByte = 0;
    let headFromState = null;
    const grew = !!(prev && Number.isInteger(prev.size) && s.size > prev.size);
    const sameSizeResume = !!(prev && Number.isInteger(prev.size) && prev.size === s.size &&
      sameIdentity && sameMtime && sameTail && Number.isInteger(prev.offset) && prev.offset > 0);
    if (prev && Number.isInteger(prev.offset) && prev.offset > 0 && !rewritten && !tailRewritten &&
        (grew || sameSizeResume)) {
      fromByte = prev.offset;
      headFromState = prev.head || null;
      stat.incremental++;
    }

    // ★ 0.9.3 P2-1/P2-4（S-9）：扫描遍的读上界 = min(单会话预算, 本 tick 剩余预算)。
    //   windowBytes 经 K-2 透传到 frames（否则 frames.js 首次读恒 min(8 MiB, size−pos)，
    //   "有界读"就变成"每次至少一整窗"，批多时反而更糟：42 批 × 8 MiB = 336 MB）。
    //
    // ★ C25（整 tick 聚合消费硬预算）：实际消费上界**不再等于 maxBytes**（见 TICK_* 常量注释）。
    //   两条路：
    //     ① 安全快路：本 tick 最多只会读 unread ≤ 剩余（含 v3 前缀预留）字节 → 读到 EOF 也越不过
    //        硬顶，不需要探测（绝大多数小会话走这条，**零额外 IO**）。
    //     ② 截断路：本会话本 tick 读不完 → 先探第一帧；放不下就整会话延后（byteDeferredSessions++），
    //        放得下才开读，且扫描额度收在 remaining−headroom 内（消费 ≤ 该额度，可证）。
    //   v3 前缀补历史是同一会话的第二笔源消费，**先预留**（prefixReserve）再给 v4 扫描额度；
    //   不预留的话"先扫 v4 扫满、再补前缀"的旧顺序必然把硬顶顶穿（tick1 越 218 B 的形态之一）。
    const pendingPrefix = prefixByDir.get(s.dir);
    const perSessionCap = cfg.maxBytesPerSession > 0 ? cfg.maxBytesPerSession : TICK_READ_BUDGET_BYTES;
    let prefixNeed = 0;
    if (pendingPrefix) {
      try { prefixNeed = Math.max(0, fs.statSync(pendingPrefix).size); } catch { prefixNeed = 0; }
    }
    const prefixReserve = pendingPrefix ? Math.min(prefixNeed, perSessionCap) : 0;
    const remainingTickBytes = Math.max(0, TICK_READ_BUDGET_BYTES - tickConsumedSourceBytes);
    const remainingAfterPrefix = Math.max(0, remainingTickBytes - prefixReserve);
    const unreadBytes = Math.max(0, (Number.isFinite(s.size) ? s.size : 0) - fromByte);
    let scanMaxBytes = 0;
    if (remainingAfterPrefix <= 0) {
      // 连前缀预留都不够 → 整会话延后（不探测、不读；下一 tick 按游标续读）
      deferSessionByByteBudget(s, prev, fromByte, curFp, curFpLen, curTail, curTailLen);
      continue;
    }
    if (unreadBytes <= remainingAfterPrefix) {
      // ① 安全快路：本读消费 ≤ unreadBytes ≤ remainingAfterPrefix ≤ tick 剩余
      scanMaxBytes = Math.max(1, Math.min(perSessionCap, remainingAfterPrefix));
    } else {
      // ② 截断路：开读前必须知道第一帧多长
      const grant = remainingAfterPrefix - TICK_READ_HEADROOM_BYTES;
      if (grant < TICK_READ_MIN_SLICE_BYTES) {
        deferSessionByByteBudget(s, prev, fromByte, curFp, curFpLen, curTail, curTailLen);
        continue;
      }
      const probeCap = Math.min(grant, TICK_READ_PROBE_MAX_BYTES);
      const pr = probeFirstFrameBytes(s.path, fromByte, probeCap);
      stat.probeBytes += pr.bytes;
      if (pr.first < 0) {
        // 帧比探测上限还大：给满额度时不再反复延后（否则可能永久停滞），按"放得下"开读并如实计数；
        // 额度不足一律延后，等下一 tick 拿到更大额度再判。
        if (grant < TICK_READ_PROBE_MAX_BYTES) {
          deferSessionByByteBudget(s, prev, fromByte, curFp, curFpLen, curTail, curTailLen);
          continue;
        }
        stat.firstFrameUnbounded++;
        stat.warnings.push('first frame > probe cap（' + probeCap + ' B）：按"放得下"开读（from=' +
          fromByte + '，' + path.basename(path.dirname(s.path)) + '）');
        scanMaxBytes = Math.max(1, Math.min(perSessionCap, grant));
      } else if (pr.first > grant) {
        // 第一帧就放不下：整会话延后（已提交前缀不回滚；下一 tick 按游标续读）
        deferSessionByByteBudget(s, prev, fromByte, curFp, curFpLen, curTail, curTailLen);
        continue;
      } else {
        scanMaxBytes = Math.max(1, Math.min(perSessionCap, grant));
      }
    }
    const scanWindowBytes = Math.min(SCAN_READ_WINDOW_BYTES, Math.max(64 * 1024, scanMaxBytes));
    const scanStartedMs = Date.now();
    // ★ 0.9.3 P2-5：单会话异常隔离 —— 从读源到游标提交整段包一层（收尾提交见 finally）。
    try {
      // 内层：读源（失败 → 记失败次数并跳过本会话；外层只兜"未捕获异常"）。
      try {
      // v0.2：只取轮次边界（不保留事件正文），内存从 O(事件数) 降到 O(轮数)
      r = readSourceTurns(s, {
        fromByte,
        head: headFromState,
        // 单会话字节预算：超了就停在帧边界，下一轮接着读（P0-2 / S-9）
        maxBytes: Math.max(1, scanMaxBytes),
        // ★ K-2：窗口粒度（不传时 frames 回落 8 MiB = K-2 之前的行为）
        windowBytes: scanWindowBytes,
        // ★ CH-10（契约）：坏帧必须落 `.errors.jsonl`（kind=FRAME_FAILED）。
        //   原来不传 root，lib 只能把失败写在内存/`.lost.jsonl` 里，错误清单永远是空的。
        root: cfg.root,
        sid: s.sid || s.s12 || path.basename(path.dirname(s.path)),
        sessDir: s.dir || path.dirname(s.path),
        offsetMinutes: cfg.offsetMinutes,
      });
      stat.phases.scanMs += Date.now() - scanStartedMs;
      // 源消费字节（S-9 口径）：扫描遍实际推进的字节数（含被预算截断的部分）。
      const scanConsumed = Math.max(0,
        (r.meta && Number.isInteger(r.meta.nextOffset) ? r.meta.nextOffset : fromByte) - fromByte);
      tickConsumedSourceBytes += scanConsumed;
      stat.consumedSourceBytes += scanConsumed;
      scanConsumedBytes = scanConsumed;
      if (r.meta && r.meta.stopped) stat.partialReads++;
      // ★ P1-5（审计 M-05）：坏帧/半截帧 → 游标**不推进**（ledger 已置 nextOffset=fromByte），
      //   这一源本轮"有意停摆"。停摆必须被看见：否则只是"看不见的缺行"。
      //   attempts 留待运行报告累计；这里至少把 blocked 计数与原因打出来。
      if (r.meta && r.meta.blocked) {
        stat.blockedSources++;
        const why2 = r.meta.blockReason || '?';
        // CH-09：坏帧起点（lib 在 meta.haltOffset / failedOffsets 里给"从哪个字节开始读不动了"）
        const badStart = Number.isInteger(r.meta.haltOffset) && r.meta.haltOffset >= 0
          ? r.meta.haltOffset
          : (Array.isArray(r.meta.failedOffsets) && Number.isInteger(r.meta.failedOffsets[0])
            ? r.meta.failedOffsets[0]
            : fromByte);
        // ★★ K-4（LED-01 修复）：坏帧停止 ≠ 整会话失败。
        //   旧实现这里置 sessionFailed=true，后果是：
        //     ① 已解出的闭合轮在"本批不落账"闸门处被整批丢弃（实测 written=0）；
        //     ② 收尾按"成功路径"把游标推到 r.meta.nextOffset（读侧曾=EOF）→
        //        恢复文件后也从 EOF 续读，坏帧之后的轮次永久漏记，且账面无声。
        //   现在：halted 的源照常把已解出的轮次落账（原文/凭证是全的），
        //   只把游标收在坏帧之前的已提交前缀末尾；错误每 tick 都重新报（本段 + .lost
        //   + .errors），下一 tick 从该点重试，源修复后自动续记（(sid,turn) 幂等防重）。
        if (r.meta.halted) {
          halted = true;
          haltOffset = badStart;
        } else {
          // 非 halted 的 blocked（bad-magic / 超大帧跳过等）仍按旧语义整会话停摆。
          forcedCursorOffset = badStart;
          sessionFailed = true; // 游标停摆 = 本会话未完成，必须下轮重试
        }
        // CH-10：attempts 要**累加**，不能每轮都写 1。来源是运行区的尝试计数。
        let attempts = 1;
        try {
          const am = readErrorAttempts(cfg.root);
          const cur = am[`${String(why2)}|${s.path}|0`];
          if (cur && Number(cur.attempts) > 1) attempts = Number(cur.attempts);
        } catch { /* 计数读不到就按 1 */ }
        stat.blockedList.push({ source: s.path, kind: String(why2), attempts, offset: badStart });
        stat.frameErrors.push({
          source: s.path,
          offset: badStart,
          failed: Number.isFinite(r.meta.failed) ? r.meta.failed : 1,
          reason: String(why2),
          retryable: true,
        });
        // 错误必须**每 tick 可见**：这一行每轮都会重新出现在 errors 里（不是只报一次），
        // 直到源修复或人工处置。带上"可重试/停在哪个偏移"，值班的人不用再去翻 .lost。
        stat.errors.push(
          'source blocked: ' + path.basename(path.dirname(s.path)) +
          ' reason=' + why2 +
          ' offset=' + badStart +
          ' stopReason=' + (r.meta.stopReason || why2) +
          ' failedRanges=' + (Array.isArray(r.meta.failedRanges) ? r.meta.failedRanges.length : 0) +
          ' retryable=true'
        );
        // ★ F-3（方案 B）：帧=整行契约被破坏 ≠ 坏帧可重试。这是**写入方违约**，必须独立 ERROR 报出来，
        //   且该会话已按硬断言停住（游标不越过此帧、绝不静默丢跨帧残片）。处置：核对 DSH 写入器版本/缓冲后人工重放。
        if (String(r.meta.stopReason || '') === 'contract-violation') {
          const cvs = Array.isArray(r.meta.failedRanges)
            ? r.meta.failedRanges.filter((x) => x && x.reason === 'contract-violation') : [];
          const cvAt = cvs.length && Number.isInteger(cvs[0].start) ? cvs[0].start : badStart;
          stat.contractViolations = (Number(stat.contractViolations) || 0) + 1;
          stat.errors.push(
            'ERROR 帧=整行契约被破坏（硬断言停手）：' + path.basename(path.dirname(s.path)) +
            ' frameStart=' + cvAt + '；该会话已停住（游标不越过此帧），不静默丢跨帧残片；' +
            '处置：核对 DSH 写入器版本/缓冲行为后人工重放（不要忽略后继续）'
          );
        }
      }
    } catch (e) {
      stat.errors.push('read failed: ' + path.basename(path.dirname(s.path)) + ' :: ' + e.message);
      continue;
    }

    // ★ B4（口径：缺口必须在账里留痕，不许只在日志里报一次）：
    //   坏帧 / 半截帧 / 坏魔数 → 把「会话、缺失字节区间、帧偏移、+08:00 时间」
    //   追加进 `<root>/ledger/.lost.jsonl`（可复算 sha256、同现场去重）。
    //   对账器用 readLost(root) 读回；`.lost.jsonl` 不参与 readAll（只读非隐藏 .jsonl）。
    if (r.meta.failed > 0 || r.meta.badLines > 0 || String(r.formatError || '').startsWith('bad-magic')) {
      try {
        const lost = lostTurns(cfg.root, {
          file: s.path,
          result: r,
          sid: (r.head && r.head.id) || (headFromState && headFromState.id) || '',
          sessDir: path.basename(path.dirname(s.path)),
          offsetMinutes: cfg.offsetMinutes,
        });
        if (lost && lost.recorded) stat.lostRecords++;
        if (lost && lost.ok === false) stat.errors.push('lost record failed: ' + lost.reason);
      } catch (e) {
        stat.errors.push('lost record failed: ' + e.message);
      }
    }

    if (r.meta.failed > 0) {
      // ★ re3（K-15 / B 线 oversized 契约）：缺口**全部可跳过**（超大帧 / 解压超限）时
      //   ledger 已给出 `lossSkipped=true`、`blocked=false`、`nextOffset=帧边界` —— 这不是
      //   "坏帧停摆"，也**不可重试**：不能按错误每 tick 重复告警刷屏（文件再变时也会重复读）。
      //   口径：一次性 warning（本 tick 可见）+ 计数，`.lost.jsonl` 仍照写（B 线保证含
      //   skippable/retryable:false/skippedRanges 证据），对账的 lostGaps 仍能看见这个缺口。
      if (r.meta.lossSkipped === true) {
        const reasons = Array.isArray(r.meta.skippedRanges)
          ? [...new Set(r.meta.skippedRanges.map((x) => (x && x.reason) || 'oversized'))].join(',')
          : 'oversized-frame';
        stat.lossSkipped = (stat.lossSkipped || 0) + 1;
        stat.lossSkippedFrames = (stat.lossSkippedFrames || 0) + (Number(r.meta.skippedFrames) || 0);
        const line = '超大帧缺口已跳过（不可重试，游标推进到帧边界）: ' +
          path.basename(path.dirname(s.path)) +
          ' skippedFrames=' + (Number(r.meta.skippedFrames) || 0) +
          ' skippableBytes=' + (Number(r.meta.skippableBytes) || 0) +
          ' reasons=' + reasons +
          ' nextOffset=' + (Number.isInteger(r.meta.nextOffset) ? r.meta.nextOffset : '?') +
          '（.lost.jsonl 已留痕）';
        stat.warnings.push(line);
        if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
      } else {
        stat.errors.push(
          'zstd partial: ' + path.basename(path.dirname(s.path)) +
          ' failedFrames=' + r.meta.failed + '/' + r.meta.frames
        );
      }
    }
    if (r.meta.badLines > 0) {
      stat.errors.push(
        'bad jsonl lines: ' + path.basename(path.dirname(s.path)) + ' = ' + r.meta.badLines
      );
    }

    // 格式守卫：认不得就这一轮不进账（停摆可逆，写脏不可逆）
    if (r.formatError) {
      stat.errors.push(
        'format rejected (' + r.formatError + '): ' + path.basename(path.dirname(s.path))
      );
      // ★ P1-2（异地压测发现）：坏游标必须"回退"并落盘。
      //   原实现只 continue —— 坏位置写不回 state，下一轮从同一位置重试，
      //   该会话永久停摆。这里显式把 offset 归零，下一轮即全量重读。
      if (String(r.formatError).startsWith('bad-magic')) {
        cursors[s.path] = {
          size: r.meta.size,
          offset: 0,
          head: headFromState,
          updatedAt: isoTime(Date.now(), cfg.offsetMinutes),
          rolledBack: r.formatError,
        };
        stat.rollbacks++;
      }
      // ★ INV-30 / D9：缺 head（认不出会话头）是"这个源根本没法入账"，
      //   必须像坏 sid 一样进 `.errors.jsonl` + blockedSources，否则它只是日志里的一行字。
      if (String(r.formatError).includes('head')) {
        stat.blockedSources++;
        stat.blockedList.push({ source: s.path, kind: 'HEAD_MISSING', attempts: 1 });
        try {
          stat.errorRecords = (stat.errorRecords || 0) + (appendErrorEvent(cfg.root, {
            kind: 'HEAD_MISSING',
            source: s.path,
            sourceBytes: Number.isFinite(r.meta && r.meta.size) ? r.meta.size : (Number.isFinite(s.size) ? s.size : 0),
            sourceMtimeMs: Number.isFinite(s.mtimeMs) ? s.mtimeMs : 0,
            offset: 0,
            detail: 'formatError=' + String(r.formatError).slice(0, 48),
            retryable: true,
          }, { offsetMinutes: cfg.offsetMinutes }).recorded ? 1 : 0);
        } catch (e) {
          stat.errors.push('error-log write failed: ' + (e && e.message ? e.message : String(e)));
        }
      }
      continue;
    }

    head = r.head || headFromState;
    if (!head) {
      // 没有会话头 = 这个源本轮无法入账（下一轮重试）；按失败计，进退避。
      bumpSessionFailCount(s.path, prev);
      continue; // 没有会话头，跳过
    }

    // ★ 续读点**不在这里写**：本会话后面任何一步失败（坏 sid / 无 createdAt / 取不到事件 /
    //   凭证冲突 / append 失败），游标都不许前进 —— 否则这一轮永久不重试，
    //   账缺了还看不出来。统一在本会话处理成功结束时提交（见本循环结尾）。
    const sid = String(head.id || s.sid || '');
    const s12 = normalizeSessionId(sid);
    if (!s12) {
      // F2（同机压测发现）：非法/过短 Session ID 原来直接 continue，整份会话消失、账面无痕。
      stat.errors.push('bad session id: ' + String(sid).slice(0, 48) + ' :: ' + path.basename(path.dirname(s.path)));
      // ★ P0-7③ / 决定 D9：不可编码的 sid 不只是内存里记一笔，必须落 `.errors.jsonl`
      //   （kind 必须是 D9 枚举里的 SID_UNENCODABLE；指纹由 lib 按 kind|source|bytes|mtime|offset 生成）。
      //   游标**不推进**：下一轮还会再来，直到人把这个源修好或移走。
      try {
        stat.errorRecords = (stat.errorRecords || 0) + (appendErrorEvent(cfg.root, {
          kind: 'SID_UNENCODABLE',
          source: s.path,
          sourceBytes: Number.isFinite(s.size) ? s.size : 0,
          sourceMtimeMs: Number.isFinite(s.mtimeMs) ? s.mtimeMs : 0,
          offset: 0,
          detail: 'sid=' + String(sid).slice(0, 48),
          retryable: false,
        }, { offsetMinutes: cfg.offsetMinutes }).recorded ? 1 : 0);
      } catch (e) {
        stat.errors.push('error-log write failed: ' + (e && e.message ? e.message : String(e)));
      }
      // INV-30：坏 sid 也要进 blockedSources（报告里能按源列出"为什么这轮没记它"）
      stat.blockedSources++;
      stat.blockedList.push({ source: s.path, kind: 'SID_UNENCODABLE', attempts: 1 });
      bumpSessionFailCount(s.path, prev);
      continue;
    }

    // ★ P0-7③ / 决定 D9：会话头里的 id 必须与**它所在的目录名**一致。
    //   不一致意味着：文件被换过 / 目录被伪造 / 会话被搬错位置。
    //   这种源的轮次不许入账，而且必须**进 errors、不推进游标**（下一轮重试，
    //   避免"失败也前进"把这一轮永久吞掉）。
    //   ★ 保守起见只在目录名看起来就是会话 id（以 'session-' 开头）时才校验，
    //     避免误伤非标准布局（扁平存放、历史目录改名等）。
    const dirSid = path.basename(path.dirname(s.path));
    if (dirSid && dirSid.startsWith('session-') && dirSid !== sid) {
      const s12dir = normalizeSessionId(dirSid);
      if (s12dir && s12dir !== s12) {
        stat.errors.push(
          'session id mismatch: head=' + String(sid).slice(0, 48) +
          ' dir=' + String(dirSid).slice(0, 48)
        );
        bumpSessionFailCount(s.path, prev);
        continue;
      }
    }

    // ★ v3 前缀补历史（决定 7 / GL-10）：v3+v4 并存、而 v4 起点更晚时，
    //   v3 里那段"v4 没有"的前缀轮次必须补进来 —— 否则就是"主动遗忘"，
    //   直接违反核心诉求。只有存在前缀的会话才付这次读（resolvePairPrefixes 已判定）。
    //   ★ 同时记录"真正的会话开始时刻"：日期段必须用它（不是 v4 头的 createdAt）。
    let prefixStartMs = 0;
    const prefixTurnSet = new Set();
    let prefixPath = '';
    if (pendingPrefix) {
      try {
        // ★ 0.9.3 P2-1（S-9）/ ★ C25：v3 前缀读同样**有界**，且额度在会话开始时已预留
        //   （prefixReserve，见上面扫描遍预算）。这里按"预留后的剩余"给额度，并用首帧探测
        //   挡住第一帧过冲；放不下就延后（不读、不耗字节），绝不靠 `Math.max(1, …)` 硬读一帧
        //   ——旧实现正是这一行在"剩余预算 = 0"时读出一整帧，实测越界 218 B。
        const prefixRemaining = Math.max(0, TICK_READ_BUDGET_BYTES - tickConsumedSourceBytes);
        const prefixMaxBytes = Math.min(perSessionCap, prefixRemaining);
        let prefixReadable = prefixMaxBytes > 0;
        if (prefixReadable) {
          const prProbe = probeFirstFrameBytes(pendingPrefix, 0,
            Math.min(prefixMaxBytes, TICK_READ_PROBE_MAX_BYTES));
          stat.probeBytes += prProbe.bytes;
          // first<0 = 探测上限内判不出；first>额度 = 放不下 → 本 tick 不补前缀
          if (prProbe.first < 0 || prProbe.first > prefixMaxBytes) prefixReadable = false;
        }
        if (!prefixReadable) {
          stat.prefixDeferred++;
          stat.warnings.push('v3 前缀补历史延后（字节预算）：' + path.basename(s.dir) +
            ' need=' + prefixNeed + ' avail=' + prefixMaxBytes);
        } else {
          const pr = readTurnsFrom(pendingPrefix, {
            fromByte: 0,
            maxBytes: Math.max(1, prefixMaxBytes),
            windowBytes: Math.min(SCAN_READ_WINDOW_BYTES, Math.max(64 * 1024, prefixMaxBytes)),
          });
          // 前缀读的源消费也计入 tick 预算（它与 v4 读同属本轮源字节开销）。
          const preConsumed = Math.max(0,
            (pr && pr.meta && Number.isInteger(pr.meta.nextOffset) ? pr.meta.nextOffset : 0));
          tickConsumedSourceBytes += preConsumed;
          stat.consumedSourceBytes += preConsumed;
          if (Number.isFinite(prefixNeed) && prefixNeed > 0 && preConsumed < prefixNeed) {
            // 预算只能补一部分（前缀本身大于单会话额度）：如实留痕，不假装补全
            stat.warnings.push('v3 前缀补历史只读到 ' + preConsumed + '/' + prefixNeed + ' B：' +
              path.basename(s.dir));
          }
          const primaryFirst = r.closed.length > 0
            ? r.closed.reduce((m, t) => (t.turn < m ? t.turn : m), r.closed[0].turn)
            : Number.POSITIVE_INFINITY;
          const pre = (pr && Array.isArray(pr.closed) ? pr.closed : []).filter((t) => t.turn < primaryFirst);
          if (pre.length > 0) {
            prefixPath = pendingPrefix;
            for (const t of pre) prefixTurnSet.add(t.turn);
            r.closed = pre.concat(r.closed);
            stat.legacyPrefixTurns += pre.length;
            const prHeadMs = pr.head && Number(pr.head.createdAt) > 0 ? Number(pr.head.createdAt) : 0;
            prefixStartMs = prHeadMs > 0 ? prHeadMs : (pre[0] && pre[0].startMs) || 0;
          }
        }
      } catch (e) {
        stat.errors.push('legacy prefix failed: ' + path.basename(s.dir) + ' :: ' + e.message);
      }
    }

    // 会话开始时刻 → 日期段（★ 用会话开始日，不是每轮发生日）
    //
    // 为什么要有兜底：head.createdAt 缺失时 Number(undefined)||0 === 0，
    // 而 dateSegment(0) 会给出 "19700101" —— 那会写出一个 1970 年的永久主键，
    // 错误一旦入库就改不回来（编码是主键，不改写、不复用）。
    // 所以：优先取会话头，其次取本轮最早事件的时间；两者都没有就报错跳过，
    // 绝不"猜一个日期"。

    const turnScan = { closed: r.closed, open: r.open, malformed: r.malformed };
    const turnsAll = turnScan.closed;
    if (turnScan.malformed > 0) {
      // 不合格边界不静默：它意味着"这个会话里有轮次读不全"，
      // 是账不完整的直接证据，必须进 errors 并在汇总里计数。
      stat.malformedTurns += turnScan.malformed;
      stat.errors.push('malformed turns=' + turnScan.malformed + ': ' + path.basename(path.dirname(s.path)));
    }
    // P1-1：被"下一轮 start"顶掉的孤儿轮次，已由 readTurnsFrom 收成 partial，
    //       这里只负责计数 —— 账面上能看见"有一轮是被放弃的"。
    if (r.abandoned > 0) {
      stat.abandoned += r.abandoned;
      stat.errors.push('abandoned turns=' + r.abandoned + ': ' + path.basename(path.dirname(s.path)));
    }
    // ★★ M-01（审计 LED-02/日期段错位）：日期段必须取**会话最早可信时刻**，
    //   不能"头部 createdAt 优先"。v3-only 会话的头（升级/迁移时写的那条 session 事件）
    //   不可信：审计实测 3 个 v3 多日会话（110b9e2d…/c31ebf8d…/d71b7fae…）的
    //   head.createdAt 晚于全部轮次 → 整会话编码的日期段晚于每一行的本地发生日
    //   （修前全量语料实测 54 行 code[0:8] > ts 本地日）。
    //   口径：createdAt = min(头 createdAt(>0)、首轮 startMs(>0)、v3 前缀起点(>0))；
    //   三项都取不到才报错 —— 绝不"猜一个日期"。
    //   @why 取 min 而不是"头优先"：编码日期段是**永久主键的一部分**，
    //     只要求 code[0:8] <= 该行 ts 的本地日（审计不变量）；用最早可信时刻构造，
    //     会话内全部轮次的 ts 都 ≥ 它，不变量恒成立。
    let createdAt = 0;
    const headCreatedMs = Number(head.createdAt) || 0;
    if (headCreatedMs > 0) createdAt = headCreatedMs;
    if (turnsAll.length > 0) {
      const firstTurnMs = Number(turnsAll[0].startMs) || 0;
      if (firstTurnMs > 0 && (createdAt <= 0 || firstTurnMs < createdAt)) createdAt = firstTurnMs;
    }
    // ★ v3 前缀补历史时：真正的"会话开始时刻"在 v3（v4 头更晚）。
    //   编码日期段 = 会话开始日（方案 A），所以必须取更早的那个，否则整本账的
    //   永久主键会从"会话开始日"漂到"v4 诞生日"。
    if (prefixStartMs > 0 && (createdAt <= 0 || prefixStartMs < createdAt)) {
      createdAt = prefixStartMs;
    }
    if (!(createdAt > 0)) {
      stat.errors.push('no createdAt: ' + path.basename(path.dirname(s.path)));
      bumpSessionFailCount(s.path, prev);
      continue;
    }
    const dateSeg = dateSegment(createdAt, cfg.offsetMinutes);
    if (!dateSeg) {
      stat.errors.push('bad createdAt=' + createdAt + ': ' + path.basename(path.dirname(s.path)));
      bumpSessionFailCount(s.path, prev);
      continue;
    }

    // 该会话在本台账里的代号（撞车时递增）
    const gen = pickGen(idxCache, s12, sid);
    if (!gen) {
      stat.errors.push('gen exhausted for s12=' + s12);
      bumpSessionFailCount(s.path, prev);
      continue;
    }

    // 切轮次：`turnsAll` 只含**已闭合**（有 turn/start 且有匹配 turn/end）的轮次。
    // ★ K-4：坏帧停止时，**跨坏帧的轮次**不能落账 —— 轮内事件缺了坏帧里那段，
    //   原文/凭证会不完整（后面周账/对账都按"原文可逐字恢复"验）。只落
    //   "整轮在坏帧之前"或"整轮在坏帧之后"的轮；跨坏帧的轮记 deferred，
    //   游标退到它的 startByte —— 源修复后重读该轮即可完整落账，不丢数据。
    let turns = turnsAll;
    if (halted && haltOffset > 0) {
      const straddled = [];
      turns = turnsAll.filter((t) => {
        if (prefixTurnSet.has(t.turn)) return true; // v3 前缀轮：偏移是 v3 口径，不参与比较
        const sB = Number.isInteger(t.startByte) ? t.startByte : null;
        const eB = Number.isInteger(t.endByte) ? t.endByte : null;
        if (sB === null || eB === null) return true; // 无字节信息：保守放行（老数据兼容）
        if (sB < haltOffset && eB > haltOffset) { straddled.push(t); return false; }
        return true;
      });
      if (straddled.length > 0) {
        stat.deferredTurns += straddled.length;
        for (const t of straddled) {
          if (Number.isInteger(t.startByte) && t.startByte < deferredHaltStart) deferredHaltStart = t.startByte;
        }
        stat.errors.push(
          'turns straddle bad frame: ' + straddled.length + ' deferred :: ' + path.basename(path.dirname(s.path))
        );
      }
    }
    stat.newTurns += turns.length;
    // 本会话是否出现过"该重试"的失败（任一失败 → 本轮不提交游标）




    // ★ P0-2（审计 A-01，实测：源里补 turn/end 后第三次扫描 written=0/skipped=1，
    //   台账仍 partial，原文字节不变、closedStatusPresent=false）
    //
    //   原实现把"安静够久"的未闭合轮次直接写进台账（status='partial'），
    //   而幂等闸门是 (sid,turn) —— 真实 turn/end 之后到达时该轮被判"已记过"，
    //   于是**永久停在 partial**；原文更因"凭证不可覆盖"永远不会更新。
    //
    //   审计推荐整改方案①：未闭合轮次只写**可重建的 pending 状态**，不进入最终账行。
    //   现在照此执行：
    //     · 未闭合 → 只计 stat.openTurns + 写 `<root>/ledger/.pending.jsonl` 留痕（幂等）；
    //     · 轮次一旦闭合（本次读到或下一轮读到）→ 走正常路径入账，
    //       结果是**恰好一个** status='ok' 的版本；不存在"旧 partial 要不要标取代"的问题。
    //   代价：会话若在某轮中途**永久**终止（再也不会写），该轮不进台账 ——
    //   但 .pending.jsonl 留了证据（会话/轮次/起始时刻/文件/大小），对账器可报，
    //   这也正好符合审计说的"未闭合 Turn 先写可重建的 pending 状态"。
    const pending = turnScan.open;
    if (pending) {
      stat.openTurns++;
      try {
        const p = recordPending(cfg.root, {
          file: s.path,
          sid,
          turn: pending.turn,
          startMs: pending.startMs,
          // ★ INV-05 / D10：pending 行必须带起始字节偏移，才能从"这一轮从哪开始"追溯回去
          startByte: Number.isInteger(pending.startByte) ? pending.startByte : null,
          offsetMinutes: cfg.offsetMinutes,
          size: r.meta.size,
          maxBytes: cfg.pendingMaxBytes,
        });
        if (p.recorded) stat.pendingTurns++;
        else if (p.reason === 'duplicate') stat.pendingDup++;
        else if (!p.ok) {
          stat.pendingRejected++;
          stat.errors.push(
            'pending record failed: ' + (p.reason || '?') + ' :: ' + path.basename(path.dirname(s.path))
          );
        }
      } catch (e) {
        stat.pendingRejected++;
        stat.errors.push('pending record failed: ' + e.message);
      }
      // ★ F1（v1.0.0-preview4 · R1/R2「零静默」）：把这一条未闭合轮记进**可查清单**。
      //   ★ P1-01a / P2-05（本机测试报告）：stale 判据**不能只看源 mtime**。
      //     首灌 >16 MiB 会话时，单 tick 读窗口会把一个 turn/start 与它的 turn/end 切开 →
      //     这一轮本 tick 只是"还没读到 end"，源 mtime 又因正在灌库而显得旧 → 被误判 stale
      //     → gate degraded → 设备自检 run-report 红 → 三台准入必然"需返修"（实测 turn 376 / 375）。
      //   修法（写死）：**stale 必须同时满足两条** ——
      //     ① 源 mtime 距今 ≥ max(60s, 2×intervalSeconds)（源已静止）；
      //     ② 该源游标已到 EOF（`cursor.offset >= sourceSize`，即"这一轮不会再有字节进来"）。
      //   ② 只能在会话循环结束后判（游标那时才提交），所以这里只登记，stale 由后面的 post-pass 定。
      {
        const nowForStale = Date.now();
        const srcMtime = Number.isFinite(s.mtimeMs) ? s.mtimeMs : 0;
        const staticMs = srcMtime > 0 ? Math.max(0, nowForStale - srcMtime) : 0;
        const staleAfterMs = Math.max(60 * 1000, 2 * (Number(cfg.intervalSeconds) || 60) * 1000);
        stat.openTurnList.push({
          source: s.path,
          sid,
          turn: pending.turn,
          startByte: Number.isInteger(pending.startByte) ? pending.startByte : null,
          startMs: Number.isFinite(pending.startMs) ? pending.startMs : null,
          sourceMtimeMs: srcMtime > 0 ? srcMtime : null,
          sourceSize: Number.isInteger(r && r.meta && r.meta.size) ? r.meta.size : null,
          scanStopped: !!(r && r.meta && r.meta.stopped === true),
          scanBlocked: !!(r && r.meta && r.meta.blocked === true),
          staticMs,
          staleAfterMs,
          stale: false, // 由会话循环结束后的 post-pass 判定（见下方「F1 stale 判定」）
        });
      }
    }

    // ★ P0-3（审计 A-03）：分批取事件 + 分批落账。
    //
    //   原实现把本会话**所有**未入账轮次一次性塞进 needEvents 再调 readTurnEventsBatch：
    //   首跑时"新轮次"可能就是全部 1315 轮 → 在任何一条账写入前就集中占内存
    //   （v0.4 两次把宿主压死的机理；审计 A-03 从静态与实测双向确认）。
    //   现在：每批最多 cfg.eventBatchTurns 轮；批内取事件 → 批内落账 → 批后立即释放，
    //   内存上限 ≈ 一批的事件量，与会话总轮数无关。

    /** 单轮落账（原文 → 台账）。失败只记账、不抛；返回结局便于计数。 */
    const persistTurn = (t, evs) => {
      // ★ 锁被夺取（心跳发现锁已不属于自己）→ 立即停写：
      //   此刻本进程已不是合法写者，继续写就可能与真正的主人撞车。
      if (lock && lock.lost) {
        stat.errors.push('lock lost: stop writing at turn=' + t.turn);
        // ★ 多写者硬断言（机主 2026-11-15 指令）：检测到第二个写者 → **立即停手 + 报警**。
        //   不许"警告后继续"：这里置 lockLostFatal（批循环据此整体退出），并回调 onLockLost 让
        //   apply() 侧 abort 当前 tick（走既有安全收敛路径：已提交批落 .state 提交点、未提交批丢弃），
        //   绝不继续写后面的会话与派生段。
        if (!stat.lockLostFatal) {
          stat.lockLostFatal = true;
          const line = 'ERROR 检测到第二个写者：锁已被另一实例接管（handle.lost）→ 立即停手，本轮不再写入任何批';
          stat.errors.push(line);
          if (log.error) log.error('[dsh-dialog-ledger] ' + line);
          else if (log.warn) log.warn('[dsh-dialog-ledger] ' + line);
          try { if (typeof cfg.onLockLost === 'function') cfg.onLockLost(lock); } catch { /* 回调失败不拖垮 tick */ }
        }
        return 'lock-lost';
      }
      // ★★★ 幂等闸门：这个 (会话, 轮次) 已经记过 → 直接跳过，连号都不分
      const turnKey = sid + '#' + t.turn;
      if (seenTurns.has(turnKey)) {
        stat.skipped++;
        return 'skipped';
      }

      const seq = nextSeqCached(idxCache, s12, gen);
      const code = makeCode({ date: dateSeg, s12, gen, seq });
      if (!code) {
        stat.errors.push('makeCode failed: s12=' + s12 + ' seq=' + seq);
        sessionFailed = true;
        return 'failed';
      }

      // ★★ 强绑定：先落「初始凭证」，再写「记账凭证」。
      //    拿不到原文就不入账（下一轮会重试）——这是 v0.3 与 v0.2 的本质区别：
      //    v0.2 的周记账只能追到日记账；v0.3 的每一行都必须能附上凭证原件。
      let docRel = '';
      let docHash = '';
      // ★ P1-1（审计 A-06）：完整文件哈希 + 原始事件附件（决定 D11）
      //   正文 hash 只覆盖 `## 1.` 到 EOF，YAML 不在内；必须另有"整文件 hash"才能
      //   发现"改 YAML 但正文没动"这种修改。附件则是"完整原文"能逐字恢复的凭据。
      let docFileSha256 = '';
      let docAttachment = null;
      try {
        if (!evs || evs.length === 0) throw new Error('该轮事件未取到（源文件可能被改写/截断）');
        const rendered = renderOriginal({
          events: evs,
          turn: t,
          code,
          sid,
          sessKey: `${s12}${gen}`,
          seq,
          offsetMinutes: cfg.offsetMinutes,
        });
        // ★ P1-12（审计）：原文目录必须按**编码日期段**取月，不能按"轮发生月"。
        //   编码日期段 = 会话开始日（dateSeg 已按 +08:00 切日）。若按轮发生月取月，
        //   跨月会话的原文会被拆进两个月份的夹子 —— 那正是"跨期"要避免的事，
        //   也会让"按编码找凭证"在跨月时找不到文件。
        const codeYear = Number(dateSeg.slice(0, 4));
        const codeMonth = Number(dateSeg.slice(4, 6));
        // ★ 排他创建 + 写前自检（契约 v1.3 决定 3）：
        //   同 code 同正文 → 复用（不碰一个字节）；异正文 → 抛 ORIGINAL_CONFLICT 停摆。
        const doc = writeOriginal({
          root: cfg.root,
          y: codeYear,
          m: codeMonth,
          code,
          markdown: rendered.markdown,
          bodyHash: rendered.bodyHash,
          // ★ P1-1：整文件 hash（含 YAML 与声明行）+ 原始事件附件（决定 D11）
          fullHash: rendered.fullHash,
          attachment: rendered.attachment,
        });
        docRel = doc.rel;
        docHash = doc.bodyHash || rendered.bodyHash;
        docFileSha256 = doc.fullHash || rendered.fullHash || '';
        docAttachment = doc.attachment || rendered.attachment || null;
        // ★ V0.6.1：台账 `attachment.path` 落**根相对路径**。
        //   @why 绝对路径在账库整目录搬移/归档到新机器后必然失效；外部审计工具若优先信它，
        //         会读到"原机文件"而不是"这份账库里的文件"（V0.6 复核器曾因此发生 D 类漏检）。
        //   插件自身只用 name/sha256/bytes，本改动不改变账务语义；旧行仍保留绝对路径，读侧兼容。
        if (docAttachment && typeof docAttachment === 'object') {
          const absAtt = typeof docAttachment.path === 'string' ? docAttachment.path : '';
          let relAtt = '';
          if (absAtt) {
            try { relAtt = path.relative(cfg.root, absAtt).split(path.sep).join('\\'); } catch { relAtt = ''; }
          }
          docAttachment = { ...docAttachment, path: relAtt };
        }
      } catch (e) {
        const tag = e && e.code === 'ORIGINAL_CONFLICT' ? '【凭证冲突·停摆，需人工裁决】' : '';
        stat.errors.push(tag + 'original failed: ' + code + ' :: ' + e.message);
      }
      if (!docRel) {
        // 没有凭证，就不产生记账凭证的行（账可以后补，凭证不能凭空造）
        stat.errors.push('no original doc, skip record: ' + code);
        sessionFailed = true;
        return 'failed';
      }

      const record = {
        v: 3,
        code,
        ts: isoTime(t.startMs, cfg.offsetMinutes),
        sid,
        turn: t.turn,
        seq,
        status: (t.reason === 'partial' || t.reason === 'abandoned') ? 'partial' : 'ok',
        // ★ INV-07 / D10：闭合轮必须带 turnState="closed"（机器判"这条到底闭合没"就靠它，
        //   不能只靠 status 推断 —— partial 也可能落过账）。
        turnState: 'closed',
        // 来源可审计：v3 前缀轮次的 src 必须如实写 v3，不能混成 v4
        src: prefixTurnSet.has(t.turn) ? 'session.v3.jsonl.zstd' : sourceFileName(s),
        // v0.3：凭证路径 + 正文 hash —— 记账凭证凭这两样"附凭证"
        doc: docRel,
        docHash,
        // ★ P1-1（审计 A-06 / 决定 D11）：
        //   docSha256 = 正文 hash（旧语义，保留 docHash 兼容老读法）
        //   docFileSha256 = 完整 .md 字节 hash（含 YAML 与声明行）——"绑定"必须两者都对
        //   attachment = 该轮的原始事件附件 {name,sha256,bytes} —— "完整原文"逐字恢复的凭据
        docSha256: docHash,
        docFileSha256,
        attachment: docAttachment,
        docFrom: Number(head.createdAt) || 0,
        dateOffset: cfg.offsetMinutes,
      };

      const w = appendTurn(cfg.root, record, knownCodes);
      if (w.ok && !w.skipped) {
        stat.written++;
        writtenRecords.push(record);
        if (record.status === 'partial') partials.push(record);
        // 同步进 existing / knownCodes，让同一批里的后续轮次能接着编号、
        // 且同一次扫描内不会把同一条写两遍。
        // 缓存增量维护：不重建索引，下一轮就不用重读整本台账
        rememberRecord(idxCache, record);
        return 'written';
      }
      if (w.skipped) {
        stat.skipped++;
        seenTurns.add(turnKey);
        return 'skipped';
      }
      stat.errors.push('append failed: ' + code + ' :: ' + (w.reason || '?'));
      sessionFailed = true;
      return 'failed';
    };

    let batchTurns = Math.max(1, cfg.eventBatchTurns);
    const todo = turns.filter((t) => !seenTurns.has(sid + '#' + t.turn));
    stat.skipped += turns.length - todo.length;
    // ★ K-4：坏帧停止时，游标只允许提交到**坏帧之前的已提交前缀末尾**。
    //   已经记过的轮次（本轮 skipped）同样属于"已提交前缀" —— 把它们的 endByte
    //   计入前缀末尾，下一 tick 才不用从很远的地方重读（幂等闸门仍兜底）。
    if (halted) {
      for (const t of turns) {
        if (prefixTurnSet.has(t.turn)) continue;
        if (!seenTurns.has(sid + '#' + t.turn)) continue;
        if (Number.isInteger(t.endByte) && t.endByte <= haltOffset && t.endByte > prefixCommittedByte) {
          prefixCommittedByte = t.endByte;
        }
      }
    }
    // 已落账批次能确定的最大字节位置（readTurnsFrom 补 endByte 后可用于断点续跑）。
    // ★ committedByte 在 try 外声明（0.9.3 P2-5 异常隔离后仍要用它提交游标）。
    let prevBatchEnd = 0; // 事件批读的链式起点（批间不回头；口径见 readEventsBounded）
    let byteBudgetBlind = false; // 是否因缺少字节偏移而只能按轮数限流（要如实披露）
    const evOffsets = new Map(); // 出参：本会话每轮帧区间（ledger.readTurnEventsBatch 原地填充）

    /** 一批轮次的帧区间：firstStart / lastEnd（缺字节偏移时为 null / -1）。 */
    const spanOfBatch = (list, turnSet) => {
      let firstStart = Number.POSITIVE_INFINITY;
      let lastEnd = -1;
      for (const t of list) {
        if (turnSet && !turnSet.has(t.turn)) continue;
        if (Number.isInteger(t.startByte) && t.startByte < firstStart) firstStart = t.startByte;
        if (Number.isInteger(t.endByte) && t.endByte > lastEnd) lastEnd = t.endByte;
      }
      return { firstStart: Number.isFinite(firstStart) ? firstStart : null, lastEnd };
    };

    /**
     * ★ 0.9.3 P2-1（K-2 链式批读 + 有界）：本批事件读。
     *
     * 起点 = max(链式起点 chainFrom, 本批首轮 startByte) —— **批间不回头**：
     *   批 k+1 的首轮 startByte 必 ≥ 批 k 末轮 endByte（帧边界、轮次按文件顺序），
     *   所以"从本批首轮帧起点读"本身就是链式的；mega-frame 场景下所有轮 endByte
     *   相同（E3 实测恒 187），靠"首轮帧起点"能跨过巨帧继续，而不是永远停在 187。
     * 上界 = 本批帧跨度 + 一帧余量（≤ EVENT_READ_MAX_BYTES=8 MiB）。
     *   maxBytes/windowBytes 都是**预算**语义（K-2：由 frames 自行解释，不是物理字节承诺）。
     * 本批轮次没集齐 → 预算 ×4 重试一次；仍缺由调用方判"本批不落账"（不许静默少写）。
     */
    // turnStarts：turn → startByte（P2-01：missing 形态要判"该轮起点是否落在可跳过缺口里"）
    const readEventsBounded = (filePath, turnSet, firstStart, lastEnd, chainFrom = 0, truncatedOut = null, droppedOut = null, turnStarts = null) => {
      const startAt = Math.max(chainFrom, Number.isInteger(firstStart) ? firstStart : 0);
      const span = Number.isInteger(lastEnd) && lastEnd > startAt ? lastEnd - startAt : 0;
      let budget = Math.min(EVENT_READ_MAX_BYTES, Math.max(64 * 1024, span + EVENT_READ_MARGIN_BYTES));
      const got = new Map();
      // ★ K-16（re4）：预算截断轮集合。每轮以**最后一次尝试**的结论为准，
      //   所以每次尝试用独立的 cutAttempt，成功读全就把该轮从集合里摘掉。
      const truncated = truncatedOut instanceof Set ? truncatedOut : new Set();
      const closedOf = (arr, turnNo) => {
        const last = arr && arr.length > 0 ? arr[arr.length - 1] : null;
        const n = last && last.data && Number.isInteger(last.data.turn) ? last.data.turn : null;
        return !!(last && last.type === 'turn/end' && n === turnNo);
      };
      for (let attempt = 0; attempt < EVENT_READ_ATTEMPTS; attempt++) {
        const win = Math.min(EVENT_READ_WINDOW_BYTES, Math.max(64 * 1024, budget));
        // 产品侧估算口径：本批读盘上界 ≈ 本次 maxBytes 预算（真实字节由 measure-tick 实测）
        stat.eventReadBytes += budget;
        const startedMs = Date.now();
        let part = new Map();
        const cutAttempt = new Set();
        try {
          part = readTurnEventsBatch(filePath, turnSet, {
            fromByte: startAt,
            maxBytes: budget,
            windowBytes: win,
            offsets: evOffsets,
            truncated: cutAttempt,
          });
        } finally {
          stat.phases.eventsMs += Date.now() - startedMs;
        }
        // ★ K-16：后读优先。上一版是 `if (!got.has(k))`——首次（预算截断）的结果永不替换，
        //   于是放大预算重试读到的完整轮被丢弃，截断轮照样落账。这里改为：
        //   已闭合 > 未闭合；同样闭合时取事件更多的那一份（截断只会少事件，不会多）。
        for (const [k, v] of part) {
          const prev = got.get(k);
          if (!prev) { got.set(k, v); continue; }
          const vClosed = closedOf(v, k);
          const pClosed = closedOf(prev, k);
          if (vClosed && !pClosed) got.set(k, v);
          else if (vClosed === pClosed && v.length >= prev.length) got.set(k, v);
        }
        for (const t of turnSet) {
          if (cutAttempt.has(t)) truncated.add(t); else truncated.delete(t);
        }
        let missing = 0;
        for (const t of turnSet) if (!got.has(t)) missing++;
        let cut = 0;
        for (const t of turnSet) if (truncated.has(t)) cut++;
        if (missing === 0 && cut === 0) return got;
        if (attempt < EVENT_READ_ATTEMPTS - 1) {
          // 不静默：短读/截断都必须留痕，且放大预算（×4）重试；次数与上界都有硬顶，无界读不许在这个分支复活
          stat.eventReadRetries++;
          budget = Math.min(EVENT_READ_MAX_BYTES, Math.max(budget * 4, 1024 * 1024));
        }
      }
      // ★★★ K-16（双管·下半）：上界之内读不全 / 整轮读不到 → 有界缺口探测 + 结构化跳过。
      //
      // @why 4–8 MiB 的单帧由"上半"（EVENT_READ_ATTEMPTS=4，阶梯 64K→1M→4M→8M）读全；
      //      但 >8 MiB 的单帧在数学上永远读不穿（不许无界放大预算）——
      //      旧行为：整批不落账 + 游标不推进 → 会话永久 0 行、每 tick 重读 ≈25 MiB（第 3 轮审计 W-05，P1）。
      //      现在按 15 号说明 §2 的例外条款"宁丢该轮、不丢会话"处理，且**不许静默**：
      //        ① 用 readTurnsFrom 做一次**有界**探测：maxFrameBytes=8 MiB → frames 把超上界单帧判成
      //           "可跳过超大帧"（结构完整、帧尾确定、不 halt、不解压），正是 K-15 验过的路径；
      //        ② root 传进去，它自己把缺口写进 <root>/ledger/.lost.jsonl（K-15 定死的形状，本文件不另拼）；
      //        ③ 仍读不全的轮从本批摘掉（不入账、不进"已闭合"计数），游标推进到缺口之后的帧边界；
      //        ④ 调用方据此 WARN + 计数（stat.eventDroppedTurns），run-report 里可见。
      //      ★ P2-01（本机测试报告）：**不只 truncated**。当 turn/start 本身就落在 >8 MiB 帧里时，
      //        这一轮是 `missing` 而不是 `truncated`，旧逻辑不探测 → 整批延后、永久停摆（实测 3 tick 0 行）。
      //        现在 missing 也进探测：凡 startByte 落在"可跳过缺口"区间内的轮，一律按"宁丢该轮"处理。
      //      探测失败**不改变原语义**（整批照旧延后、下一 tick 重试），只把原因记进 errors —— 不许因探测把账写坏。
      if (droppedOut && (truncated.size > 0 || got.size < turnSet.size)) {
        try {
          const probe = readTurnsFrom(filePath, {
            fromByte: startAt,
            maxBytes: EVENT_READ_MAX_BYTES,
            windowBytes: EVENT_READ_WINDOW_BYTES,
            maxFrameBytes: EVENT_READ_MAX_BYTES,
            root: cfg.root,
            sid: s.sid || s.s12 || path.basename(path.dirname(filePath)),
            sessDir: path.dirname(filePath),
            offsetMinutes: cfg.offsetMinutes,
            now: Date.now(),
          });
          const meta = probe && probe.meta ? probe.meta : null;
          const skips = meta && Array.isArray(meta.skippedRanges) ? meta.skippedRanges : [];
          if (meta && meta.lossSkipped === true && skips.length > 0) {
            const resumes = skips
              .map((r) => (r && Number.isInteger(r.resumeAt) ? r.resumeAt : 0))
              .filter((n) => n > startAt);
            const resumeAt = resumes.length ? Math.max(...resumes) : 0;
            if (resumeAt > 0) {
              // 该轮是否落在某个"可跳过缺口"区间里（用于 missing 形态）
              const inSkip = (turn) => {
                const st = turnStarts && Number.isInteger(turnStarts.get(turn)) ? turnStarts.get(turn) : null;
                if (st === null) return false;
                return skips.some((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && st >= r.start && st < r.end);
              };
              for (const t of [...turnSet]) {
                const isTrunc = truncated.has(t);
                const isMissing = !got.has(t);
                if (!isTrunc && !isMissing) continue;
                // truncated：预算读不全 → 丢（原有行为）；missing：只有确认落在可跳过缺口里才丢
                if (!isTrunc && !inSkip(t)) continue;
                truncated.delete(t);
                got.delete(t);
                droppedOut.push({
                  turn: t,
                  resumeAt,
                  reason: isTrunc ? 'event-read-budget-exhausted' : 'oversized-frame-in-turn',
                });
              }
              // 缺口之后的轮次再读一次（预算重新给满）；只补"还没取到、也没被丢"的轮。
              const droppedSet = new Set(droppedOut.map((d) => d.turn));
              const rest = new Set([...turnSet].filter((t) => !got.has(t) && !droppedSet.has(t)));
              if (rest.size > 0) {
                const cut2 = new Set();
                let part2 = new Map();
                try {
                  part2 = readTurnEventsBatch(filePath, rest, {
                    fromByte: resumeAt,
                    maxBytes: EVENT_READ_MAX_BYTES,
                    windowBytes: EVENT_READ_WINDOW_BYTES,
                    offsets: evOffsets,
                    truncated: cut2,
                  });
                } catch { part2 = new Map(); }
                for (const [k, v] of part2) {
                  if (cut2.has(k)) { truncated.add(k); continue; }
                  got.set(k, v);
                }
              }
            }
          }
        } catch (e) {
          stat.errors.push('event gap probe failed: ' + (e && e.message ? e.message : String(e)));
        }
      }
      return got;
    };

    let bi = 0;
    while (bi < todo.length) {
      // ★ INV-13（2026-11-09 实测踩到）：**批边界必须让出一次事件循环**。
      //   整段入账是同步 CPU 活（读帧、解码、渲染、写盘都没有 await），
      //   若不让出，`controller.abort()` 的回调永远排不上队 → `signal.aborted` 恒为 false
      //   → "可取消"只是纸面功能（实测：abort@400ms 仍跑满 3.5s、written=448）。
      //   代价是每批一次 setImmediate，14 批量级可忽略。
      //   ★ re3（RT-01）：倍率同批间让出，但计量器在"让出期间"暂停 —— 别的异步任务的读盘
      //     不许算进本 tick 的真实读字节。
      await readMeterYieldTurn();
      // ★ INV-13：**批边界**先看取消，再看时间预算。
      //   为什么必须在批边界而不是更细处：批是提交单位。批内已经写了几行、
      //   再在中途退回，就会留下"半批"——那正是审计要判红的形态。
      if (aborted()) {
        stat.cancelled = true;
        stat.deferredTurns += todo.length - bi;
        sessionFailed = true;
        break;
      }
      // ★ 批间预算检查（P2-4 / S-9）：到点就收工。已落账的行不回滚
      //   （游标只提交到 committedByte = 已提交批的末尾），未落账的轮次下一轮重试。
      if (Date.now() >= deadline) {
        stat.deferredTurns += todo.length - bi;
        sessionFailed = true;
        break;
      }
      // ★★ P0-3 三重预算选批（研究组 task-19 指出：只限轮数不够）。
      //   轮数上限 eventBatchTurns + 字节上限 eventBatchBytes。
      //   字节用「轮次字节跨度」估算 —— 前提是 readTurnsFrom 提供 startByte/endByte；
      //   没有这两个字段时退化为只按轮数限流，并如实计入 eventOversize（不假装有界）。
      const batch = [];
      let spanBytes = 0;
      let spansKnown = true;
      while (bi < todo.length && batch.length < batchTurns) {
        const t = todo[bi];
        const hasSpan = Number.isInteger(t.startByte) && Number.isInteger(t.endByte) && t.endByte >= t.startByte;
        if (!hasSpan) spansKnown = false;
        const span = hasSpan ? t.endByte - t.startByte : 0;
        if (batch.length > 0 && spanBytes + span > cfg.eventBatchBytes) break;
        batch.push(t);
        spanBytes += span;
        bi++;
      }
      if (batch.length === 0) break; // 防御：预算配置异常时不死循环
      // ★ C25（S-9① 读放大维）：事件批读同样吃真实读盘 —— 本 tick 已烧掉的
      //   （源消费 + 事件读预算 + 头/尾指纹 + state + 首帧探测）加本批"本次预计"越过
      //   40 MiB 硬顶，就不读本批：已提交批不回滚，游标停在已提交前缀，下一 tick 续跑
      //   （批里没落账的轮次记 deferredTurns，不许静默丢）。
      {
        const ampUsed = tickConsumedSourceBytes + stat.eventReadBytes + stat.headFpBytes +
          stat.tailFpBytes + stat.stateBytes + stat.probeBytes;
        const ampNeed = Math.min(EVENT_READ_MAX_BYTES,
          Math.max(64 * 1024, spanBytes + EVENT_READ_MARGIN_BYTES));
        if (ampUsed + ampNeed > TICK_READ_AMP_LIMIT_BYTES) {
          stat.eventAmpDeferredBatches++;
          stat.deferredTurns += todo.length - (bi - batch.length);
          if (log.warn) {
            log.warn('[dsh-dialog-ledger] WARN 读放大硬顶：本 tick 已读≈' + ampUsed +
              ' B，本批预计 ' + ampNeed + ' B 会越过 ' + TICK_READ_AMP_LIMIT_BYTES +
              ' B → 本批及之后延后到下一 tick（turns=' + batch.length + '）');
          }
          sessionFailed = true;
          break;
        }
      }
      stat.eventBatches++;
      // ★ INV-12（2026-11-09 补）：**单轮字节就超预算**时，也必须把这一批标成 oversize。
      //   原来只按"事件数超"和"缺字节偏移"标，于是 5 MB 的单轮虽然单独成批、
      //   报告里却看不出它超了预算 —— 契约要求 `{turns:1, oversize:true, bytes:<实算>}`。
      let oversizeThisBatch = false;
      if (spansKnown && cfg.eventBatchBytes > 0 && spanBytes > cfg.eventBatchBytes) {
        oversizeThisBatch = true;
      }
      let eventsByTurn = new Map();
      const eventsTruncated = new Set(); // ★ K-16：本批"读到了但没读全"的轮（预算停在帧边界）
      // ★ K-16（双管·下半）：本批被"结构化跳过"的轮（>8 MiB 单帧读不穿；已写 .lost.jsonl 并推进游标）。
      //   它们**不入账、不进已闭合计数**，但必须让人看见 —— 见下面 eventsDropped 的 WARN 与 stat。
      const eventsDropped = [];
      const set = new Set(batch.map((t) => t.turn));
      // ★ P0-3 续扫（0.9.3 改为链式 + 有界）：批起点 = 本批首轮帧起点（≥ 上一批末轮 endByte，
      //   所以天然"批间不回头"）；每批只读**本批自己的帧跨度**，不再从批首读到 EOF。
      //   前缀轮次的事件在 v3 文件里、其余在 v4 文件里 —— 必须分源读，且两条链各自独立。
      // P2-01：本批每轮起点（missing 形态探测用；缺 startByte 的轮不参与）
      const batchStarts = new Map();
      for (const t of batch) if (Number.isInteger(t.startByte)) batchStarts.set(t.turn, t.startByte);
      const preSet = new Set([...set].filter((t) => prefixTurnSet.has(t)));
      const mainSet = new Set([...set].filter((t) => !prefixTurnSet.has(t)));
      const mainSpan = spanOfBatch(batch, mainSet);
      try {
        if (mainSet.size > 0) {
          for (const [k, v] of readEventsBounded(s.path, mainSet, mainSpan.firstStart, mainSpan.lastEnd, prevBatchEnd, eventsTruncated, eventsDropped, batchStarts)) {
            eventsByTurn.set(k, v);
          }
        }
        if (preSet.size > 0 && prefixPath) {
          const preSpan = spanOfBatch(batch, preSet);
          for (const [k, v] of readEventsBounded(prefixPath, preSet, preSpan.firstStart, preSpan.lastEnd, 0, eventsTruncated, eventsDropped, batchStarts)) {
            eventsByTurn.set(k, v);
          }
        }
      } catch (e) {
        stat.errors.push('read turn events failed: ' + e.message + ' :: ' + path.basename(path.dirname(s.path)));
        sessionFailed = true;
      }

      // ★ K-16（双管·下半）：被跳过的轮必须——① 不进 missing/truncated（否则整批延后、永久停摆回到旧病）；
      //   ② 不进台账；③ 游标越过缺口（否则每 tick 从同一位置重读）。三条缺一就变成"丢了还真没进展"。
      const droppedTurns = new Set(eventsDropped.map((d) => d.turn));
      if (droppedTurns.size > 0) {
        let dropFloor = 0;
        for (const d of eventsDropped) if (Number.isInteger(d.resumeAt) && d.resumeAt > dropFloor) dropFloor = d.resumeAt;
        if (dropFloor > committedByte) committedByte = dropFloor;
        stat.eventDroppedTurns = (Number(stat.eventDroppedTurns) || 0) + droppedTurns.size;
        stat.eventDroppedTurnsList = (stat.eventDroppedTurnsList || []).concat(
          eventsDropped.slice(0, 50).map((d) => ({ turn: d.turn, resumeAt: d.resumeAt, reason: d.reason }))
        );
        if (log.warn) {
          log.warn('[dsh-dialog-ledger] WARN 事件批读预算耗尽且单帧超上界 ' + EVENT_READ_MAX_BYTES +
            ' B：结构化跳过 ' + droppedTurns.size + ' 轮（' + [...droppedTurns].slice(0, 8).join(',') +
            (droppedTurns.size > 8 ? '…' : '') + '）；游标推进到 ' + dropFloor +
            '；缺口已写 <root>\\ledger\\.lost.jsonl（k15 形状）；该轮不入账、不进已闭合计数');
        }
      }

      // ★ 0.9.3 P2-1 读全校验：本批每个轮次都必须取到事件。
      //   缺一个 → **本批不落账、游标不推进**（下一轮重试），并 stat.eventShortBatch++。
      //   宁可重读，不可凭"半批事件"写出缺行/错行。
      const missingTurns = [];
      for (const t of batch) if (!eventsByTurn.has(t.turn) && !droppedTurns.has(t.turn)) missingTurns.push(t.turn);
      // ★ K-16（re4）：读到了但**没读全**的轮（预算停在帧边界）同样算短读。
      //   上一版只查"有没有事件"，于是 v3 跨帧轮的 1 个半截事件被当成完整轮落账 ——
      //   这就是附件 51,723 B → 71 B、c19 六条 FIELD_MISMATCH 的根因。
      const truncatedTurns = [];
      for (const t of batch) {
        if (eventsByTurn.has(t.turn) && eventsTruncated.has(t.turn) && !droppedTurns.has(t.turn)) truncatedTurns.push(t.turn);
      }
      if (missingTurns.length > 0 || truncatedTurns.length > 0) {
        stat.eventShortBatch++;
        if (truncatedTurns.length > 0) stat.eventTruncatedBatch = (Number(stat.eventTruncatedBatch) || 0) + 1;
        stat.errors.push(
          'event short batch: ' + missingTurns.length + '/' + batch.length + ' turns missing (' +
          missingTurns.slice(0, 8).join(',') + (missingTurns.length > 8 ? '…' : '') + ')' +
          (truncatedTurns.length > 0
            ? ' | ' + truncatedTurns.length + '/' + batch.length + ' turns truncated by event-read budget (' +
              truncatedTurns.slice(0, 8).join(',') + (truncatedTurns.length > 8 ? '…' : '') + ')'
            : '') +
          ' :: ' + path.basename(path.dirname(s.path))
        );
        sessionFailed = true;
      }

      // ★ P0-3：事件数预算的实测校验。除轮数×字节外，再按"本批实际取到多少事件"兜一层。
      //   **不能因为超预算就丢弃本批**（那会漏记），只能缩下一批的轮数上限 + 如实计数。
      let evCount = 0;
      for (const arr of eventsByTurn.values()) evCount += arr.length;
      if (evCount > cfg.eventBatchEvents) {
        oversizeThisBatch = true;
        // 缩批有下限（见 EVENT_BATCH_TURNS_FLOOR @why）：不许把批缩到"同一巨帧被逐批重读"。
        const floor = Math.min(Math.max(1, cfg.eventBatchTurns), EVENT_BATCH_TURNS_FLOOR);
        batchTurns = Math.max(floor, Math.floor(batchTurns / 2));
      } else if (!spansKnown && !byteBudgetBlind) {
        // 没有字节偏移可用 → 字节预算这一维实际没生效，必须让人看见，不能假装有界
        byteBudgetBlind = true;
        oversizeThisBatch = true;
      }
      // 一批只计一次（字节超 / 事件超 / 缺偏移，可能同时成立）
      if (oversizeThisBatch) stat.eventOversize++;

      // 读失败/短读：本批零写入直接退出（不许把"取不到事件"的轮次写成半截凭证）。
      if (sessionFailed) {
        eventsByTurn = null;
        break;
      }

      let batchFailed = false;
      const persistStartedMs = Date.now();
      // ★ K-16（双管·下半）：被结构化跳过的轮**不落账**（它们的事件本来就读不全）。
      //   其余轮照常落账 —— "宁丢该轮、不丢整个会话"。
      const batchWrite = droppedTurns.size > 0 ? batch.filter((t) => !droppedTurns.has(t.turn)) : batch;
      for (const t of batchWrite) {
        const outcome = persistTurn(t, eventsByTurn.get(t.turn));
        if (outcome === 'lock-lost') { batchFailed = true; sessionFailed = true; break; }
        if (outcome === 'failed') batchFailed = true;
      }
      stat.phases.persistMs += Date.now() - persistStartedMs;
      eventsByTurn = null; // ★ 批后立即释放整批事件对象 —— P0-3 的要点
      if (batchFailed) break;
      // ★ 游标只推进到"已提交批的末尾"（framed 游标下就是本批末轮的 endByte 帧起点）。
      //   prefix 轮的 endByte 是 **v3 偏移**，不能拿来推 v4 游标（会把游标推错文件位置）。
      for (const t of batchWrite) {
        if (prefixTurnSet.has(t.turn)) continue;
        if (Number.isInteger(t.endByte) && t.endByte > committedByte) committedByte = t.endByte;
        // ★ K-4：坏帧停止时另记"坏帧之前的已提交前缀末尾" —— 这才是可提交的游标点。
        if (halted && Number.isInteger(t.endByte) && t.endByte <= haltOffset && t.endByte > prefixCommittedByte) {
          prefixCommittedByte = t.endByte;
        }
      }
      // 事件批读的链式起点：只取本批**主源（v4）**已读帧的最远起点。
      if (mainSpan.lastEnd >= 0 && mainSpan.lastEnd > prevBatchEnd) prevBatchEnd = mainSpan.lastEnd;
      // ★ INV-13：整批都落账了才算"提交"。取消时这个数就是"保住了几批"。
      stat.committedBatches++;
      // ★ INV-11/12：每批的轮数/事件数/字节/是否超预算，必须落到运行报告里，
      //   否则"有界"只能靠嘴说（审计 #1 正是"报告里没有 batches[]"）。
      stat.batchRecords.push({
        n: stat.committedBatches,
        turns: batchWrite.length,
        events: evCount,
        bytes: spanBytes,
        oversize: oversizeThisBatch,
        ...(droppedTurns.size > 0 ? { dropped: [...droppedTurns] } : {}),
      });
    }
    // 走到这里 = 本会话的读源/补前缀/分批取事件/落账流程**正常走完**（可能 sessionFailed）。
    //   用 sessionDone 区分"正常走完"与"中途 continue 的错误路径" —— 后者不许提交成功游标。
    sessionDone = true;
    } catch (e) {
      // ★ 0.9.3 P2-5（异常隔离）：单会话未捕获异常 → 记错、保留旧游标（绝不前移）、
      //   终止本会话处理，然后继续下一个会话 —— 一个坏源不许拖垮整轮。
      sessionFailed = true;
      stat.sessionCrashed++;
      const first = e && e.stack ? String(e.stack).split('\n')[0] : (e && e.message ? e.message : String(e));
      stat.errors.push('session crashed: ' + path.basename(path.dirname(s.path)) + ' :: ' + first);
    } finally {
      // ── 会话收尾（成功 / 失败 / 异常三条路都走这里；任何异常都不许拖垮整轮）──
      try {
        const errorsDelta = stat.errors.length - errorsBeforeSession;
        const sessionErrored = errorsDelta > 0;
        if (sessionErrored) stat.sessionsErrored++;
        // ★ 0.9.3 P2-3：首次读到该会话（prev 没有 tailSha）时，提交游标前补算尾指纹。
        //   @why 不补：下一轮 sameSizeResume 因"没有尾指纹"判不出"没变" → 白重读一整遍，
        //     多烧一个 tick（E3 实测就是这样浪费掉一轮）。成本 4 KiB/会话，只在"没有时"算。
        if (!curTail && Number.isFinite(s.size) && s.size > 0) {
          const tl = Math.min(TAIL_FP_BYTES, s.size);
          const tc = tailFingerprint(s.path, tl);
          if (tc) {
            curTail = tc;
            curTailLen = tl;
            stat.tailFpBytes += tl;
          }
        }
        if (sessionFailed) {
          stat.retried++;
          // ★ CH-09：坏帧的会话，游标停在坏帧起点（forcedCursorOffset），
          //   既不是 0（会假装"从没读过"），也不是 EOF（会永久漏记）。
          // ★ P2-1（0.9.3）：预算截断的会话，游标停在**已提交批的末尾** committedByte
          //   （不是本批起点！）—— "批内已写行不回滚，靠 (sid,turn) 幂等重试"。
          // ★ K-4：halted 的源即使本轮还撞上别的失败（写失败等），游标也**不许越过坏帧**：
          //   收到坏帧之前的已提交前缀末尾。
          let targetOffset = Number.isInteger(forcedCursorOffset) ? forcedCursorOffset : committedByte;
          if (halted && !Number.isInteger(forcedCursorOffset)) {
            targetOffset = prefixCommittedByte > 0 ? prefixCommittedByte : fromByte;
          }
          if (Number.isFinite(deferredHaltStart) && deferredHaltStart < targetOffset) targetOffset = deferredHaltStart;
          if (r && r.open && Number.isInteger(r.open.startByte) && r.open.startByte < targetOffset) {
            targetOffset = r.open.startByte;
          }
          if (targetOffset > 0 || Number.isInteger(forcedCursorOffset)) {
            cursors[s.path] = {
              size: s.size,
              offset: targetOffset,
              head: { id: head.id, createdAt: head.createdAt },
              headSha: curFp,
              headFpLen: curFpLen,
              // ★ 0.9.3 P2-3：失败路径也落尾指纹（否则下一轮又被"尾盲"判 unchanged）
              ...(curTail ? { tailSha: curTail, tailFpLen: curTailLen } : {}),
              mtimeMs: s.mtimeMs,
              updatedAt: isoTime(Date.now(), cfg.offsetMinutes),
              ...(Number.isInteger(forcedCursorOffset)
                ? { blocked: true }
                : (halted
                  ? { blocked: true, haltOffset, lastGoodOffset: prefixCommittedByte }
                  : { partialCommit: true })),
            };
          }
          // ★ P2-5 失败退避：只有**真的出错**才记失败次数（时间/字节预算截断不是失败，
          //   否则大语料会因"一轮没跑完"被误封，反而制造新的永久停滞）。
          if (sessionErrored) bumpSessionFailCount(s.path, prev);
        } else if (halted && sessionDone && head && r && !r.formatError) {
          // ★★ K-4（LED-01 修复）：坏帧停止 → 游标只提交到
          //   **坏帧之前的已提交前缀末尾**（最后一条真正落账/已入账轮次的结束位置）。
          //   不用 r.meta.nextOffset（=坏帧起点）：那会跳过"坏帧之前但本轮没落账"的
          //   轮次（跨坏帧轮次 / 事件短读）。下一 tick 从该点重试：源不变时重读同一段
          //   并重新报错（错误每 tick 可见）；源修复后从该点续记，靠 (sid,turn) 幂等去重。
          //   **绝不**提交到 EOF（旧实现实测 offset=size → 恢复后再也不回头读）。
          let targetOffset = prefixCommittedByte > 0 ? prefixCommittedByte : fromByte;
          if (Number.isFinite(deferredHaltStart) && deferredHaltStart < targetOffset) targetOffset = deferredHaltStart;
          if (r.open && Number.isInteger(r.open.startByte) && r.open.startByte < targetOffset) {
            targetOffset = r.open.startByte;
          }
          // ★★★ re3 P1（审计③ FAIL-01）：**targetOffset=0 也必须落游标**。
          //   旧条件 `targetOffset > 0 || fromByte > 0` 会让"坏帧就在最前面、已提交前缀=0"
          //   的源完全不写游标；下一 tick 一旦 mtime 落到 hotWindow(默认 1 h) 之外，这个源
          //   就被热窗口静默过滤 —— 不会报错、不会重试，源修好也永不续记（静默永久漏记）。
          //   现在无条件提交 blocked 游标（offset=0）：P2-2 的"未完成游标免热窗口过滤"
          //   会把它保进来，错误每 tick 重新可见，源修复后从 0 续读并由 (sid,turn) 幂等去重。
          {
            cursors[s.path] = {
              size: s.size,
              offset: targetOffset,
              head: { id: head.id, createdAt: head.createdAt },
              headSha: curFp,
              headFpLen: curFpLen,
              ...(curTail ? { tailSha: curTail, tailFpLen: curTailLen } : {}),
              mtimeMs: s.mtimeMs,
              updatedAt: isoTime(Date.now(), cfg.offsetMinutes),
              blocked: true,
              blockReason: r.meta.stopReason || 'failed-frames',
              haltOffset,
              lastGoodOffset: prefixCommittedByte,
            };
          }
          // 坏帧是"可重试缺口"，不是会话崩溃：**不**累加失败退避次数 ——
          // 否则连续 3 tick 后会被退避 10 tick，错误从清单里"消失"，
          // 直接违反"错误必须每 tick 可见"（且退避不解决坏帧）。
        } else if (sessionDone && r && head && !r.formatError) {
          cursors[s.path] = {
            size: r.meta.size,
            offset: r.meta.nextOffset,
            head: { id: head.id, createdAt: head.createdAt },
            // ★ P0-1：记下文件身份指纹与取样长度，下一轮才敢判"真的没变"
            headSha: curFp,
            headFpLen: curFpLen,
            // ★ 0.9.3 P2-3：尾 4 KiB 指纹（S-9）—— 与 size/头/mtime 一起构成"四证"
            ...(curTail ? { tailSha: curTail, tailFpLen: curTailLen } : {}),
            // ★ V0.9：mtime 是第三证据 —— 头部指纹只覆盖前 4 KiB，尾部被换它看不见
            mtimeMs: s.mtimeMs,
            updatedAt: isoTime(Date.now(), cfg.offsetMinutes),
          };
        } else if (sessionErrored) {
          // 中途 continue 的错误路径（坏 sid / 头缺失 / 无 createdAt / 读失败…）：
          //   保留旧位置，只记失败次数（连续失败 → 退避，不再每轮硬碰烧预算）。
          bumpSessionFailCount(s.path, prev);
        }
        // ★ 停滞检测（P2-2 / C21 判读）：上一轮"未完成游标"的会话本轮是否真的前进了？
        //   前进的三种证据任一成立即不算停滞：offset 变大 / 写了新行 / 游标到了 EOF。
        //   ★ 还要排除"本来就没新字节"：源没变、扫描推进 0 字节、游标没动 = 在等源追加/等
        //     turn/end 闭合（E3 末尾第 1,339 轮永久未闭合就是这个形态）—— 那是**正常等待**，
        //     不是停滞。判错会让指标每 tick 常红，失去证据价值（如实比"看起来严"更重要）。
        if (prevUnfinished) {
          const after = cursors[s.path] && typeof cursors[s.path] === 'object' ? cursors[s.path] : {};
          const advanced = Number.isInteger(after.offset) && Number.isInteger(prevOffset) &&
            after.offset > prevOffset;
          const wrote = stat.written > writtenBeforeSession;
          const finished = Number.isInteger(after.offset) && Number.isInteger(after.size) &&
            after.offset >= after.size;
          const sizeUnchanged = !!(prev && Number.isInteger(prev.size) && r && r.meta &&
            r.meta.size === prev.size);
          const noNewBytes = sizeUnchanged && scanConsumedBytes === 0 &&
            Number.isInteger(after.offset) && after.offset === prevOffset && !sessionErrored;
          if (!advanced && !wrote && !finished && !noNewBytes) {
            stat.stalledDetected++;
            if (stat.stalledList.length < 50) {
              stat.stalledList.push({
                source: s.path,
                reason: 'no-progress-on-unfinished-cursor',
                offset: Number.isInteger(after.offset) ? after.offset : null,
                size: Number.isInteger(after.size) ? after.size : null,
                scanConsumedBytes,
              });
            }
          }
        }
      } catch (e2) {
        // 收尾自身失败也不许拖垮整轮：记一条错误，下一个会话继续。
        stat.errors.push('session finalize failed: ' + path.basename(path.dirname(s.path)) + ' :: ' +
          (e2 && e2.message ? e2.message : String(e2)));
      }
    }

  }

  // ★ re3（RT-01）：扫描段真读字节（含会话源解码/头尾指纹/错误清单写入等本段同步读）。
  stat.scanReadBytes = Math.max(0, readMeterBytes() - readMeterScanStart);

  // 时间预算用尽：剩下的会话整轮没轮到，如实计数（下一轮会自动补上）
  if (deferredFrom >= 0) stat.deferred = sessions.length - deferredFrom;
  // ★ C25：整 tick 聚合字节预算造成的延后要**在账面上可见**（不然"这轮怎么少了几个源"
  //   只能靠翻 .tick-metrics）。延后不等于丢：游标停在已提交前缀，下一 tick 续读。
  if (stat.byteDeferredSessions > 0) {
    stat.warnings.push('tick 字节预算：延后 ' + stat.byteDeferredSessions +
      ' 个会话到下一 tick（已消费=' + stat.consumedSourceBytes + ' / ' + TICK_READ_BUDGET_BYTES + ' B）');
  }
  if (stat.prefixDeferred > 0) {
    stat.warnings.push('tick 字节预算：延后 ' + stat.prefixDeferred + ' 次 v3 前缀补历史到下一 tick');
  }
  if (stat.eventAmpDeferredBatches > 0) {
    stat.warnings.push('读放大硬顶：延后 ' + stat.eventAmpDeferredBatches + ' 个事件批到下一 tick（S-9① ≤40 MiB/tick）');
  }

  // ★★★ re3 P0（审计③ ARCH-01）：卸载/中止 → **只落 .state 提交点，派生段一律不写**。
  //
  // @why 旧 dispose 只 abort+clearInterval 就同步返回：在跑的那一轮继续把剩余批、周账、
  //   月账、目录、索引、收据、对账、运行报告全写完（审计实测 unloaded 后仍写 7 个文件）——
  //   热重载/双实例场景就是"两个写者"，而账只追加，多写的行不可删。
  // @why 为什么仍写 .state：`.state` 是**提交点**（游标/首跑标记）。本 tick 已提交的批是账务事实，
  //   必须让下一实例从正确游标续读；未提交的批在批边界就已丢弃（见批循环里的 aborted()）。
  // @why 派生段全部跳过：周账/索引/收据/对账/运行报告都能由下一实例从台账重算，
  //   卸载时写它们既有"卸载后写盘"的风险，又可能写到一半（进程正被换掉）。下一 tick 自然补。
  if (aborted()) {
    stat.cancelled = true;
    try {
      const nowIso = isoTime(Date.now(), cfg.offsetMinutes);
      writeState(cfg.root, {
        // 首跑中止：**不许**标记 initialized（否则历史会话下一轮可能被热窗口永久过滤）。
        initialized: stat.firstRun ? false : true,
        firstRunAt: state.firstRunAt || nowIso,
        lastRunAt: nowIso,
        sourceCursors: cursors,
        abortedCommit: true,
        abortedAt: nowIso,
        lastStat: { ...stat, errors: stat.errors.slice(0, 20) },
      });
      stat.abortedCommit = true;
      const line = '本轮因卸载中止：只落 .state 提交点（游标/首跑标记；已提交批 ' +
        stat.committedBatches + ' 个）；周账/体检/目录/索引/收据/对账/运行报告等派生段本轮不写（下一实例会补）';
      stat.warnings.push(line);
      if (log.info) log.info('[dsh-dialog-ledger] ' + line);
    } catch (e) {
      stat.errors.push('abort state commit failed: ' + (e && e.message ? e.message : String(e)));
    }
    return stat;
  }

  // ⑦a 周记账（主产物）：只处理本轮被触碰到的组；首次运行（无哈希表）则全量补齐。
  //
  //    为什么"只处理被触碰的组"：账会越来越长，每轮把所有组重算一遍是浪费；
  //    而"首次全量"是必要的 —— 否则启用周记账之前的历史永远不会落表。
  const weeklyStartedMs = Date.now();
  const readMeterWeeklyStart = readMeterBytes();
  let weeklyHashes = state.weeklyHashes && typeof state.weeklyHashes === 'object' ? { ...state.weeklyHashes } : null;
  let weeklyTwoStateFlag = state.weeklyTwoState === true;
  // ★ 0.9.4-re1：周账预算版的结果 / 分组表（⑦a-2 月账视图要用"本 tick 写了哪些组、属于哪个月"）。
  let weeklyOutcome = null;
  let weeklyGroups = null;
  if (cfg.weeklyEnabled) {
    try {
      // 版式升级也要触发全量重写：否则"数据没变"会让旧版式的文件永远留着。
      // F1（同机压测发现）：改 offsetMinutes 必须触发全量重写。
      // 只把偏移放进内容指纹还不够 —— 没有新写入时 touched 为空，根本轮不到指纹判断。
      const layoutStale = state.weeklyLayout !== LAYOUT_VERSION;
      const offsetStale = state.weeklyOffset !== cfg.offsetMinutes;
      const bootstrap = !weeklyHashes || layoutStale || offsetStale;
      if (!weeklyHashes) weeklyHashes = {};

      // ★ 注意：writtenRecords 已经通过 rememberRecord() **增量并进 records**（同一个数组引用）。
      //   原写法 `records.concat(writtenRecords)` 会把本轮新写入的记录再算一遍 ——
      //   首跑 bootstrap 时周记账会出现「同编码两行」（实测：台账 1 条 / 周记账 2 行 / 记录数 2）。
      //   账与表必须一一对应，重复行等于账实不符，所以这里只用 records。
      const all = records;
      const allGroups = groupRecords(all, cfg.offsetMinutes);
      weeklyGroups = allGroups; // ⑦a-2 月账视图用（只读引用）
      const touched = bootstrap
        ? new Set(allGroups.keys())
        : new Set(groupRecords(writtenRecords, cfg.offsetMinutes).keys());

      // ★ 封板 sweep：宽限期已到、但本轮**没有被触碰**的组也必须处理，
      //   否则那些周永远停在"草稿"（没人再给它们写一行，就永远轮不到封板）。
      const seals = readWeeklySeals(cfg.root);
      // ★ V0.7 周账两态：一次性迁移历史"无封板标记的正式名草稿"→ 草稿- 前缀（只 rename，字节不改）。
      //   独立于 touched：否则没被触碰的组永远停在旧命名（2026-11-10 真机实测的坑）。
      let twoStateOk = weeklyTwoStateFlag;
      if (!twoStateOk) {
        let migrated = 0;
        twoStateOk = true;
        for (const [, g0] of allGroups) {
          const official = path.join(cfg.root, weeklyFolderName(g0.w), weeklyFileName(g0.w, g0.sessKey));
          const draft = path.join(cfg.root, weeklyFolderName(g0.w), draftNameOf(g0.w, g0.sessKey));
          let ex = false;
          try { ex = fs.existsSync(official); } catch { ex = false; }
          if (!ex) continue;
          if (seals && seals[weeklyGroupId(g0.w, g0.sessKey)]) continue; // 已封板证据：不动
          let dex = false;
          try { dex = fs.existsSync(draft); } catch { dex = false; }
          if (dex) {
            twoStateOk = false;
            stat.warnings.push('weekly two-state: official 与 草稿 并存（gid=' + weeklyGroupId(g0.w, g0.sessKey) + '），保正式名、本轮不迁移');
            continue;
          }
          try { fs.renameSync(official, draft); migrated += 1; }
          catch (e) { twoStateOk = false; stat.warnings.push('weekly two-state: rename 失败 ' + official + ' :: ' + (e && e.message)); }
        }
        if (migrated > 0) stat.warnings.push('weekly two-state: 历史草稿迁移 ' + migrated + ' 份 → 草稿- 前缀（只 rename，字节未改）');
        weeklyTwoStateFlag = twoStateOk;
      }
      // 「本轮之前已封板」集合：用于判定"封板后才发现的行"。
      //   ★ 必须包含本轮"从文件头认领封板"的组（state 丢失场景），否则那些组
      //     本轮新行既进不了正册、也进不了补记册，会凭空游走（weekly-seal 复核指出）。
      const sealedBefore = new Set(Object.keys(seals));
      for (const gid of findDueSealGroupIds(allGroups, { seals })) touched.add(gid);

      // ★ 0.9.4-re1（W3）：逐组全量循环 → `runWeeklyBudget()`（lib/weekly.js 第十·补节）。
      //
      //   @why 换（而不是留旧循环）：bootstrap（state 丢/版式升级/换 offsetMinutes）会把**所有组**
      //     当 touched，3 年 ≈2 万组一轮重写必然超 30 s 预算。预算版把未封板组按
      //     WEEKLY_BUDGET{groupsPerTick:200, msPerTick:20000}（lib 常量，不新增配置键）分批，
      //     余量写 state.weeklyCatchup，下一 tick 从断点续跑；已封板组先跳过（W2 后天然便宜）。
      //
      //   @why 结果与旧循环同一口径（一个字节都不该变）：
      //     · 内容指纹仍写回 weeklyHashes（lib 内部就地更新，封板组/skip 不记 hash —— 同旧代码）；
      //     · 封板 journal 证据每 tick 只读一次：`seals` 由本文件读出后透传，`journalState`
      //       由 runWeeklyBudget 内部读一次并透传给 writeWeekly；
      //     · 单组失败仍记 errors（本轮不算封板，下一 tick 重试；补记册按 code 幂等）；
      //     · 封板后补记册判定仍用 sealedBefore（本轮 skip=sealed 的组立即并入）。
      //
      //   @why 静默轮不调用：没有 touched、不是 bootstrap、也没有续跑状态时，调用只会多写一次
      //     state（saveWeeklyCatchup），所以直接跳过；stat.weekly 仍照旧形如 groups=0,written=0,sealed=0。
      const catchup0 = state.weeklyCatchup;
      const catchupHasWork = !!(catchup0 && typeof catchup0 === 'object'
        && ((Array.isArray(catchup0.pending) && catchup0.pending.length > 0)
          || (Array.isArray(catchup0.inflight) && catchup0.inflight.length > 0)));
      let wrote = 0;
      let sealedCount = 0;
      let lostBooks = 0;
      if (bootstrap || touched.size > 0 || catchupHasWork) {
        const wr = runWeeklyBudget({
          root: cfg.root,
          groups: allGroups,
          touched,
          bootstrap,
          prevHashes: weeklyHashes,
          offsetMinutes: cfg.offsetMinutes,
          seals,
        });
        weeklyOutcome = wr;
        stat.weeklyDeferred = Number(wr.weeklyDeferred) || 0;
        for (const res of wr.results || []) {
          if (!res) continue;
          if (res.error) {
            // ★ P0-4 / D13：封板链失败（溢出补记写不进 / 闭合校验不过 / journal 追加失败）
            //   必须记 errors，且**本轮不得把这组视为已封板** —— 下一轮重试；
            //   补记册按 code 幂等，重试不会写重。
            stat.errors.push('weekly seal failed: gid=' + res.groupId + ' :: ' + res.error);
            continue;
          }
          // 只有"本轮真的写出了封板册"才算新封板；已封板被再次触碰而 skip 的不算。
          if (res.written) wrote++;
          if (res.sealed && res.written) sealedCount++;
          // 本轮认领/确认已封板的组 → 之后的新行必须走补记册
          if (res.skipped && res.reason === 'sealed') sealedBefore.add(res.groupId);
          for (const w of res.warnings || []) {
            if (w.type === 'state-lost') lostBooks++;
            if (log.warn) log.warn('[dsh-dialog-ledger] ' + (w.message || JSON.stringify(w)));
          }
        }
        if (stat.weeklyDeferred > 0) {
          // 如实上报（不静默丢）：余量在 state.weeklyCatchup，下一 tick 续跑。
          const line = 'weekly: 预算用尽，本轮未处理 ' + stat.weeklyDeferred +
            ' 组（state.weeklyCatchup 已记录，下一 tick 续跑）';
          stat.warnings.push(line);
          if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
        }
      }
      stat.weekly = `groups=${touched.size},written=${wrote},sealed=${sealedCount}`;
      if (lostBooks > 0) {
        stat.errors.push('weekly: state lost, ' + lostBooks + ' existing books untouched');
      }

      // ★★★ F2（v1.0.0-preview4 · R2「零静默」）：封板后补记必须**可重试 + 失败可见**。
      //
      // @why 旧行为（第 3 轮审计 P1 动态复现）：补记只在本轮**刚写台账行**时尝试一次；
      //      写失败一次（注入 EBUSY）→ 该码永久既不在正册也不在补记册，**任何后续 tick 都不再重试**，
      //      而 reconcile 仍 ok —— 又是一条"静默丢"。
      //   现在（审计建议的"失败进待办 + 幂等重放"）：
      //      ① 本轮新写的"封板后发现"行 → 并入 `state.supplementPending`（持久化待办）；
      //      ② **每个 tick** 都重放待办（不再依赖"本轮有没有写行"），成功即出队；
      //      ③ 同一组连续 3 次失败 → 标 gaveUp + WARN + 进 gate 缺口（报警，不许沉默）；
      //      ④ 补记册按 code 幂等（writeSupplement 自身保证），重放不会写重。
      //   只在"有待办"时才读一次台账（按 code 取回记录正文）；稳态零成本。
      {
        const prevPending = Array.isArray(state.supplementPending) ? state.supplementPending : [];
        /** gid → {gid, codes:Set, reason, attempts, gaveUp, firstSeenAt, bookStamp, lastError} */
        const work = new Map();
        for (const p of prevPending) {
          if (!p || typeof p.gid !== 'string' || !Array.isArray(p.codes) || p.codes.length === 0) continue;
          work.set(p.gid, {
            gid: p.gid,
            codes: new Set(p.codes.map(String)),
            reason: typeof p.reason === 'string' ? p.reason : '封板后发现',
            attempts: Number.isInteger(p.attempts) ? p.attempts : 0,
            gaveUp: p.gaveUp === true,
            firstSeenAt: typeof p.firstSeenAt === 'string' ? p.firstSeenAt : '',
            bookStamp: typeof p.bookStamp === 'string' ? p.bookStamp : '',
            lastError: typeof p.lastError === 'string' ? p.lastError : '',
          });
        }
        // ① 本轮新写的行：只有「本轮之前已封板」的组才算"封板后发现"。
        //   本轮刚生成并封板的组，它的行已经全部写进正册，不能再补一遍。
        if (writtenRecords.length > 0) {
          const stampNow = isoTime(Date.now(), cfg.offsetMinutes);
          for (const r of writtenRecords) {
            let gid;
            try {
              gid = weeklyGroupId(weekOf(Date.parse(r.ts), cfg.offsetMinutes), sessKeyOf(r.code));
            } catch { continue; } // 单条解析失败不影响其它记录
            if (!sealedBefore.has(gid)) continue;
            const w = work.get(gid) || {
              gid, codes: new Set(), reason: '封板后发现', attempts: 0, gaveUp: false,
              firstSeenAt: stampNow, bookStamp: stampNow, lastError: '',
            };
            w.codes.add(String(r.code));
            work.set(gid, w);
          }
        }
        if (work.size > 0) {
          // ② 重放需要记录正文：按 code 从台账取回（只有有待办时才读）
          const needCodes = new Set();
          for (const w of work.values()) for (const c of w.codes) needCodes.add(c);
          const recByCode = new Map();
          try {
            const rd = readAll(cfg.root);
            for (const r of (rd && rd.records) || []) {
              if (r && needCodes.has(String(r.code))) recByCode.set(String(r.code), r);
            }
          } catch (e) {
            stat.errors.push('supplement pending: 读台账失败 :: ' + (e && e.message ? e.message : String(e)));
          }
          for (const w of [...work.values()]) {
            if (w.gaveUp) continue; // 已放弃的只保留可见性，不再自动重试（等人工处置）
            const codes = [...w.codes].filter((c) => recByCode.has(c));
            const missing = [...w.codes].filter((c) => !recByCode.has(c));
            if (missing.length > 0) {
              // 台账里找不到这一行 → 重试也不会成功；照样记一次失败并留原因（不静默）
              w.attempts += 1;
              w.lastError = 'ledger row missing: ' + missing.slice(0, 5).join(',') + (missing.length > 5 ? '…' : '');
            } else {
              try {
                const records = codes.map((c) => recByCode.get(c));
                const sup = writeSupplement({
                  root: cfg.root,
                  codes,
                  records,
                  reason: w.reason || '封板后发现',
                  // ★ 用首次发现时的书签：跨天后重试仍写进**同一本**补记册（不另起一本）
                  generatedAt: w.bookStamp || isoTime(Date.now(), cfg.offsetMinutes),
                  offsetMinutes: cfg.offsetMinutes,
                });
                const appended = sup && Number.isFinite(sup.added) ? sup.added : 0;
                if (appended > 0) stat.supplements += appended;
                for (const warn of (sup && sup.warnings) || []) {
                  if (log.warn) log.warn('[dsh-dialog-ledger] 补记册: ' + (warn.message || JSON.stringify(warn)));
                }
                work.delete(w.gid); // 成功（含"早就写过、added=0"的幂等情形）→ 出队
                continue;
              } catch (e) {
                w.attempts += 1;
                w.lastError = (e && e.message) ? String(e.message) : String(e);
                stat.errors.push('supplement failed: ' + path.basename(w.gid) + ' :: ' + w.lastError);
              }
            }
            if (w.attempts >= 3 && !w.gaveUp) {
              w.gaveUp = true;
              const line = 'WARN 补记册连续 ' + w.attempts + ' 次失败 → 放弃自动重试（需人工处置）：gid=' +
                w.gid + ' codes=' + [...w.codes].slice(0, 6).join(',') + ' :: ' + (w.lastError || '?');
              stat.errors.push(line);
              stat.warnings.push(line);
              if (log.warn) log.warn('[dsh-dialog-ledger] ' + line);
            }
          }
          // ③ 待办落 state（持久化），并进 stat / run-report / gate 缺口
          state.supplementPending = [...work.values()].map((w) => ({
            gid: w.gid,
            codes: [...w.codes].sort(),
            reason: w.reason,
            attempts: w.attempts,
            gaveUp: w.gaveUp,
            firstSeenAt: w.firstSeenAt,
            bookStamp: w.bookStamp,
            lastError: w.lastError,
          }));
        } else if (Array.isArray(state.supplementPending) && state.supplementPending.length > 0) {
          state.supplementPending = []; // 待办清空（全部处理完）
        }
        const pend = Array.isArray(state.supplementPending) ? state.supplementPending : [];
        stat.supplementPending = pend.filter((x) => x && x.gaveUp !== true).length;
        stat.supplementPendingGaveUp = pend.filter((x) => x && x.gaveUp === true).length;
        if (stat.supplementPending > 0) {
          stat.warnings.push('补记待办 ' + stat.supplementPending + ' 组（下一 tick 幂等重放，见 run-report.supplementPending）');
        }
      }
    } catch (e) {
      stat.errors.push('weekly failed: ' + e.message);
    }
  }
  stat.phases.weeklyMs += Date.now() - weeklyStartedMs;
  // ★ re3（RT-01）：周账段真读字节（含封板 journal 读、周账内容比对等同步读）。
  stat.weeklyReadBytes = Math.max(0, readMeterBytes() - readMeterWeeklyStart);

  // ⑦a-2 ★ 0.9.4-re1（P3 接线·月账）：周账写盘成功后 / 每天首次 tick，刷新"当周涉及月份"的月账视图。
  //
  //   产物：`<root>/YYYY年MM月/MM月账.md` —— **派生只读视图**（由当月台账行 + 封板事实 + 补记摘要生成），
  //   不进 xlsx、不参与对账、不修改台账/周账；删了可重建（lib/weekly.js 第十三节）。
  //
  //   触发（二者其一，避免每 tick 白扫台账）：
  //     ① 本周账真的写盘成功（weeklyOutcome.stats.written > 0）→ 刷新"本 tick 写了周账的组所属月"
  //        （封板 sweep 可能补写旧月组，所以月份要按组算，不能只看"当周"）；
  //     ② 进程内"每天首次 tick"（lastMonthlyViewYmd 节流）→ 至少刷新当前周所属月。
  //   口径：内容指纹不变 → writeMonthlyView 返回 written:false/reason:'unchanged'，不重写；
  //         失败只 warn —— 月账不承载账务事实，绝不拖垮 tick、不进 errors、不回滚。
  try {
    if (cfg.weeklyEnabled) {
      const monthlyStartedMs = Date.now();
      const monthlyNowMs = Date.now();
      const monthlyTodayYmd = ymdLocal(monthlyNowMs, cfg.offsetMinutes);
      const dailyFirst = lastMonthlyViewYmd !== monthlyTodayYmd;
      /** 待刷月份：`Map<'Y-M', {year, month}>`（同一月只刷一次）。 */
      const months = new Map();
      const addMonth = (w) => {
        if (!w || !Number.isInteger(w.year) || !Number.isInteger(w.month)) return;
        months.set(`${w.year}-${w.month}`, { year: w.year, month: w.month });
      };
      if (dailyFirst) addMonth(weekOf(monthlyNowMs, cfg.offsetMinutes));
      if (weeklyOutcome && Number(weeklyOutcome.stats && weeklyOutcome.stats.written) > 0) {
        for (const gid of weeklyOutcome.processed || []) {
          const g = weeklyGroups ? weeklyGroups.get(gid) : null;
          if (g) addMonth(g.w);
        }
      }
      if (months.size > 0) {
        const summary = { months: [], written: 0, unchanged: 0, failed: 0, ms: 0 };
        for (const m of [...months.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month))) {
          try {
            const mv = writeMonthlyView({
              root: cfg.root,
              year: m.year,
              month: m.month,
              offsetMinutes: cfg.offsetMinutes,
            });
            summary.months.push(`${m.year}年${String(m.month).padStart(2, '0')}月`);
            if (mv && mv.written) summary.written++;
            else summary.unchanged++;
          } catch (e) {
            summary.failed++;
            const line = '月账视图生成失败（只 warn，不影响记账）: ' + m.year + '年' + m.month + '月 :: ' +
              ((e && e.message) || String(e));
            stat.warnings.push(line);
            if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
          }
        }
        summary.ms = Date.now() - monthlyStartedMs;
        stat.monthly = summary;
        // 只有"全部成功"才记今天已刷 —— 失败的下轮重试（否则当天再也不会补）。
        if (summary.failed === 0) lastMonthlyViewYmd = monthlyTodayYmd;
      }
      // ★ P1-02：月账视图也纳入分阶段计量（派生视图；未做"预算不足就跳过"的门，
      //   但必须让"30 s 花在哪"看得见 —— 计量如实优先于漂亮）。
      stat.phases.monthlyMs += Date.now() - monthlyStartedMs;
    }
  } catch (e) {
    // 月账视图异常绝不外抛、绝不进 errors（派生视图，不是账务事实）。
    const line = '月账视图生成异常（只 warn，不影响记账）: ' + ((e && e.message) || String(e));
    stat.warnings.push(line);
    if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
  }


  // ⑦b 体检：有 partial 才跑，且按 checkupIntervalMs 节流。
  //     只读、不自动修 —— 它负责"暴露账实不符"，不负责改账。
  let checkupState = state.checkup && typeof state.checkup === 'object' ? { ...state.checkup } : null;
  if (cfg.checkupEnabled && partials.length > 0) {
    const lastAt = checkupState && Number.isFinite(checkupState.lastAt) ? checkupState.lastAt : 0;
    if (Date.now() - lastAt >= cfg.checkupIntervalMs) {
      try {
        const r = runCheckup({
          root: cfg.root,
          sessionsBase,
          partials,
          seqState: checkupState && checkupState.seq,
          offsetMinutes: cfg.offsetMinutes,
        });
        stat.checkup = r.reportId;
        checkupState = { lastAt: Date.now(), seq: r.seqState, lastReport: r.reportId, mismatched: r.mismatched };
        if (r.mismatched > 0) {
          stat.errors.push('checkup found ' + r.mismatched + ' stale partial (see ' + r.reportId + ')');
        }
      } catch (e) {
        stat.errors.push('checkup failed: ' + e.message);
      }
    }
  }

  // ★ 本轮有写入 → 刷新台账指纹，下一轮直接复用索引缓存（不重建）。
  if (stat.written > 0 && ledgerCache) ledgerCache.fp = ledgerFingerprint(cfg.root);

  // ★ P2-2：回收已不存在会话的游标。
  //   原实现只增不删 —— state 会随使用无限增长，且每 60 秒整份重写一次。
  //   这里只在文件确实不存在时才删，避免热窗口过滤误伤。
  {
    const live = new Set(allSessions.map((x) => x.path));
    for (const p of Object.keys(cursors)) {
      if (live.has(p)) continue;
      if (fs.existsSync(p)) continue;
      delete cursors[p];
      stat.statePruned++;
    }
  }

  // ⑥ 打汇总日志（一行，不啰嗦）。openTurns / firstRun 一并打出来：
  //    前者说明"有轮次在等闭合"，后者说明"这一轮是全量补历史"，
  //    两者都是事后审计时最容易说不清的状态。
  const msg = `scanned=${stat.scanned} turns=${stat.newTurns} written=${stat.written} ` +
              `skipped=${stat.skipped} open=${stat.openTurns} bad=${stat.malformedTurns} ` +
              `inc=${stat.incremental} same=${stat.unchanged} part=${stat.partialReads} ` +
              `defer=${stat.deferred} chk=${stat.checkup || '-'} wk=${stat.weekly || '-'} ` +
              `abandoned=${stat.abandoned} rollback=${stat.rollbacks} ` +
              `v3=${stat.legacySources} retry=${stat.retried} hotExt=${stat.hotWindowExtended ? 1 : 0} ` +
              `lost=${stat.lostRecords} sup=${stat.supplements} ` +
              `ho=${stat.handoverGenerated}/${stat.handoverAdopted}/${stat.handoverSkipped}` +
              `/${stat.handoverSealedTotal} ` +
              `firstRun=${stat.firstRun} errors=${stat.errors.length}`;
  if (stat.errors.length > 0 && log.warn) log.warn('[dsh-dialog-ledger] ' + msg);
  else if (log.info) log.info('[dsh-dialog-ledger] ' + msg);

  // ⑦ 错误明细单独打，方便定位
  if (stat.errors.length > 0 && log.warn) {
    for (const e of stat.errors.slice(0, 10)) log.warn('[dsh-dialog-ledger]   ' + e);
    if (stat.errors.length > 10) {
      log.warn('[dsh-dialog-ledger]   ...还有 ' + (stat.errors.length - 10) + ' 条');
    }
  }

  // ⑧a ★ V0.6.2（《v0.6.2-迁移规格-v1》§2.3）：每日一次刷新《账簿总目录》。
  //
  //   为什么每日一次：总目录要扫各月原文/周账/分类计数，成本随账库增长；它是**人读导航页**
  //   （不承载账务事实、不参与对账），一天内的变化不需要秒级同步。节流键放 state 的
  //   `catalogDate`（YYYYMMDD，+08:00 口径）—— 进程重启也不会当天重复刷。
  //   为什么只在"成功轮"刷新：失败轮可能账没写完/正在回滚，此刻的总目录会和实况对不上。
  //   为什么失败只 warn：规格说它"不参与对账"；导航页写不进去不许拖垮记账（更不许记 errors
  //   把"零错误"验收打红 —— 那是把非账务故障混进账务结论）。
  const catalogYmd = ymdLocal(Date.now(), cfg.offsetMinutes);
  let catalogDate = typeof state.catalogDate === 'string' ? state.catalogDate : '';
  const catalogStartedMs = Date.now();
  const readMeterCatalogStart = readMeterBytes();
  if (remainingBudgetMs() < SEGMENT_MIN_START_MS) {
    // ★ P1-02：预算不够就整段跳过（下一 tick 重试）。总目录是每日一次的导航页，晚一轮无损失。
    deferSegment('catalog(账簿总目录)');
  } else if (stat.errors.length === 0 && catalogDate !== catalogYmd) {
    try {
      const cat = writeCatalog(cfg.root, { nowMs: Date.now(), offsetMinutes: cfg.offsetMinutes });
      if (cat && cat.ok === true) {
        catalogDate = catalogYmd;
        stat.catalog = { path: cat.path, bytes: cat.bytes };
      } else {
        const why = cat
          ? String(cat.reason || 'unknown') + (cat.detail ? '（' + cat.detail + '）' : '')
          : 'no-result';
        const line = '账簿总目录刷新失败（只 warn，不影响记账）: ' + why;
        stat.warnings.push(line);
        if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
      }
    } catch (e) {
      const line = '账簿总目录刷新异常（只 warn，不影响记账）: ' + ((e && e.message) || String(e));
      stat.warnings.push(line);
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
    }
  }
  stat.phases.catalogMs += Date.now() - catalogStartedMs;
  stat.catalogReadBytes = Math.max(0, readMeterBytes() - readMeterCatalogStart);

  // ⑧b ★ V0.8 库外 manifest 锚已冻结（S-1/§5.3）：lite 不追加账本快照/包锚，
  //   也不再写 state.deliveryAnchorDate（配置键 manifestAnchorRoot / deliveryPackageDir 保留）。

  // ⑧ 记录本轮状态。
  //
  //    两个用途：
  //    ① 判定"是否首次运行"（下一次启动靠它决定要不要全量扫）；
  //    ② 留痕：账本本身只证明"记了什么"，这份状态证明"哪一轮扫过、扫到几个"。
  //       两者合起来才回答得清"缺的那几条，当时到底有没有被看到"。
  const reportStartedMs = Date.now();
  const readMeterStateWriteStart = readMeterBytes();
  try {
    const nowIso = isoTime(Date.now(), cfg.offsetMinutes);
    writeState(cfg.root, {
      // ★ 「首跑完成」只在**确实扫到过会话**时置位（红队 15 轮 A 条，2026-11-08）。
      //
      //   若首次 tick 时会话目录还是空的，而这里无条件写 initialized=true，
      //   那么之后才出现的老会话（mtime 早于 hotWindow）会被永久挡在门外，
      //   而且没有任何补历史的机会 —— 账缺了，却看不出缺。
      //   空目录下的全量扫是零成本，所以宁可不置位、每轮都全量，也不能丢历史。
      initialized: stat.firstRun ? (stat.scanned > 0 && stat.deferred === 0) : true,
      // 时间一律写 UTC+08:00 带偏移，和台账里的 ts 保持同一种"读法"。
      // （此前用 toISOString() 存的是 Z，审计时要在脑子里换算一次，容易看错日。）
      firstRunAt: state.firstRunAt || (stat.firstRun && stat.scanned > 0 ? nowIso : undefined) || nowIso,
      lastRunAt: nowIso,
      // ★ V0.6.2：最近一次成功刷新《账簿总目录》的日期（YYYYMMDD，+08:00 口径）。
      //   只有**真的写成功**才记 —— 失败时保留旧值，下一轮自然重试（每日一次节流键）。
      ...(catalogDate ? { catalogDate } : {}),
      // 续读游标随状态一起落盘：重启后接着读，不必重解整份会话
      sourceCursors: cursors,
      // 体检状态：上次跑的时间、当日编号、上份报告
      ...(checkupState ? { checkup: checkupState } : {}),
      // 周记账内容指纹：同样的数据不重复落盘
      ...(weeklyHashes ? { weeklyHashes } : {}),
      // ★ F2：封板后补记的待办（跨 tick 重放）。
      //   注意：**清空也要写**（空数组）—— 否则 patch 语义会把旧的待办留在 state 里，
      //   表现就是"补记册已写出、待办却永远不消失"（本文件 2026-11-15 实测踩到过）。
      ...(Array.isArray(state.supplementPending) ? { supplementPending: state.supplementPending } : {}),
      // ★ P0-3-resume：本轮自愈过的"崩溃撕裂尾巴"证据（state 是**留痕**，不是判定依据；
      //   下轮若再遇到会重新取证/幂等核 sha，不依赖这里）。数组只在真的发生过时出现。
      ...(Array.isArray(stat.tornTailRepaired) && stat.tornTailRepaired.length > 0
        ? { tornTailRepaired: stat.tornTailRepaired } : {}),
      // 版式版本：变了就触发一次全量重写
      weeklyLayout: LAYOUT_VERSION,
      // F1：记住生成时的偏移，改了就要全量重写
      weeklyOffset: cfg.offsetMinutes,
      // ★ V0.7 两态历史迁移完成标记（完成前每轮重试；完成即不再扫）
      ...(weeklyTwoStateFlag ? { weeklyTwoState: true } : {}),
      lastStat: { ...stat, errors: stat.errors.slice(0, 20) },
    });
  } catch (e) {
    if (log.warn) log.warn('[dsh-dialog-ledger] 状态文件写入失败: ' + e.message);
  }
  stat.phases.reportMs += Date.now() - reportStartedMs;
  stat.stateWriteReadBytes = Math.max(0, readMeterBytes() - readMeterStateWriteStart);

  // ⑧c ★ 0.9.4-re1（P3 接线·索引 C28）：tick 收尾走**只读"新增尾"的增量同步**。
  //
  //   产物：`<root>/ledger/.index/idx-YYYYMMDD.jsonl`（瘦行 {c,d,o,n}）+ `.idx-state.json`
  //   （唯一写者是 tools/pointerindex.mjs；台账/原文/周账一个字节都不动）。
  //
  //   为什么不再"按条件 buildIndex"：buildIndex 是**全量重建**语义 —— 每 tick 哪怕只多 1 行，
  //   也要把全部台账日文件整读一遍（C28 实测读放大 12.8× > 计划 E4-2 阈值 3×）。
  //   tick 的常态是"台账只在最后一个日文件尾部多出几行"，所以把本 tick 新写的行交给 syncIndex：
  //     · 能证明"只尾部追加" → mode:'sync'：只读新增的几行 + 只重写受影响的那一个日分片；
  //     · 本轮没写新行 → mode:'skip'：只读 state/目录，分片不动；
  //     · 索引缺失 / 当日分片缺失 / 多日增长 / 历史补写（非尾部）→ 内部回退 buildIndex
  //       → mode:'rebuild'（宁可整建也不猜；判定条件见 pointerindex.mjs 的 planTailSync()）。
  //
  //   ★ 索引是**派生数据，不是账务事实**：任何异常只 warn，不进 errors、不回滚、不报红；
  //     写进 run-report 的 warnings 段（与月账/总目录同口径）。
  const indexStartedMs = Date.now();
  const readMeterIndexStart = readMeterBytes();
  // ★ m7（审计 m7）：索引失败退避 —— 索引是派生数据，连续失败不必每 tick 硬碰（会白烧 IO/预算）。
  //   进入退避后本 tick 直接跳过；成功一次即清零。退避只影响派生数据新鲜度，不影响账务。
  const indexInBackoff = moduleIndexBackoff.untilMs > Date.now();
  if (indexInBackoff) {
    stat.index = {
      built: false, mode: 'backoff', rows: 0, added: 0, bytesRead: 0, ms: 0,
      backoffUntilMs: moduleIndexBackoff.untilMs, consecutiveFailures: moduleIndexBackoff.fails,
    };
  } else if (remainingBudgetMs() < SEGMENT_MIN_START_MS) {
    // ★ P1-02：预算不够就整段跳过（派生数据晚一轮，账务无影响）。
    deferSegment('index(指针索引)');
  } else try {
    const sr = syncIndex({ root: cfg.root, rows: writtenRecords });
    moduleIndexBackoff = { fails: 0, untilMs: 0 };
    stat.index = {
      // built 保持旧口径：只有"整建/回退重建"才算 built；纯追加由 mode 表达（built=false）。
      built: sr.mode === 'rebuild',
      mode: sr.mode,
      rows: Number(sr.rows) || 0,
      added: Number(sr.added) || 0,
      bytesRead: Number(sr.bytesRead) || 0,
      ms: Number(sr.ms) || (Date.now() - indexStartedMs),
    };
    // 回退原因如实带出（便于 doctor/排障看到"为什么这轮不是 sync"）；不影响账务。
    if (sr.mode === 'rebuild' && sr.reason) stat.index.fallback = String(sr.reason);
    if (sr.ok !== true) {
      const line = '索引同步完成但有 ' + ((Array.isArray(sr.problems) && sr.problems.length) || 0) +
        ' 条 problem（派生数据，不影响账务；详见 ledger/.index/.idx-state.json）';
      stat.warnings.push(line);
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
    }
  } catch (e) {
    // 索引失败 = 派生数据缺失，不是账务失败：只 warn（run-report 的 warnings 段会带出去）。
    const fails = moduleIndexBackoff.fails + 1;
    const n = Math.max(1, Math.min(10, fails));
    moduleIndexBackoff = { fails, untilMs: Date.now() + n * cfg.intervalSeconds * 1000 };
    const line = '索引增量同步失败（派生数据，只 warn，不影响账务）第 ' + fails + ' 次 → 退避 ' +
      n + ' 个 interval: ' + ((e && e.message) || String(e));
    stat.index = {
      built: false, mode: 'error', rows: 0, added: 0, bytesRead: 0,
      ms: Date.now() - indexStartedMs, backoffUntilMs: moduleIndexBackoff.untilMs, consecutiveFailures: fails,
    };
    stat.warnings.push(line);
    if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
  }
  stat.phases.indexMs += Date.now() - indexStartedMs;
  stat.indexReadBytes = Math.max(0, readMeterBytes() - readMeterIndexStart);

  // ⑨ ★ REC（库外收据锚）：给"已经过完的日子"各出一张收据，写到库外目录。
  //
  //   为什么放在最后：收据证明的是"这一天账本最终长什么样"，
  //   所以必须在当天所有写入（台账/原文/周账/交接表）都落盘之后才算数。
  //
  //   锚目录为空 = 功能关闭（默认）。机主约定：Agent 不写 U 盘，
  //   收据落桌面目录，由机主手动搬入 U 盘后用只读校验器自检。
  const receiptStartedMs = Date.now();
  const readMeterReceiptStart = readMeterBytes();
  if (cfg.receiptAnchorRoot && remainingBudgetMs() < SEGMENT_MIN_START_MS) {
    // ★ P1-02：收据是"过完的日子"的日结摘要，晚一轮无损失；预算不够就整段跳过。
    deferSegment('receipt(日结摘要)');
    stat.receipts = 'deferred';
  } else if (cfg.receiptAnchorRoot) {
    try {
      const todayISO = isoTime(Date.now(), cfg.offsetMinutes).slice(0, 10);
      const dates = listLedgerDays(cfg.root, todayISO);
      const rc = ensureReceipts({
        root: cfg.root,
        anchorRoot: cfg.receiptAnchorRoot,
        dates,
        todayISO,
        offsetMinutes: cfg.offsetMinutes,
      });
      stat.receipts = rc.disabled
        ? 'off'
        : ('w=' + rc.written.length + ',v=' + (rc.appended || []).length + ',s=' + rc.skipped.length + ',e=' + rc.errors.length);
      // ★ v1.0.0-re2（S-11 C42 (c)）：已发版本数/最新版本号必须可见（进 run-report），
      //   不许"补发了新版但没人知道"，也不许静默丢变化。
      stat.receiptDigest = rc.disabled
        ? null
        : {
          dates: rc.versions ? rc.versions.dates : 0,
          versionsTotal: rc.versions ? rc.versions.total : 0,
          latest: rc.versions ? rc.versions.latest : null,
          written: rc.written.length,
          appended: (rc.appended || []).length,
          repairedTxt: (rc.repairedTxt || []).length,
          skipped: rc.skipped.length,
          errors: rc.errors.length,
        };
      if (rc.reason) stat.errors.push('receipt anchor rejected: ' + rc.reason);
      for (const e of (rc.errors || []).slice(0, 5)) stat.errors.push('receipt failed: ' + e);
    } catch (e) {
      stat.errors.push('receipt failed: ' + e.message);
    }
  } else {
    // 关闭也要有明确计数：不能让读者以为"收据出问题了"或"收据本来就没有"
    stat.receipts = 'off';
  }
  stat.phases.receiptMs += Date.now() - receiptStartedMs;
  stat.receiptReadBytes = Math.max(0, readMeterBytes() - readMeterReceiptStart);

  // ⑦c ★ 对账闸门 + 补记链 + 运行报告（v0.5 D2 / D7 / BC-15 / RC-12 / HL-10/11）
  //
  //   为什么放在收据之后：对账要看到"本轮所有写入（含收据）之后"的固定状态；
  //   为什么用周期节流：对账要读全台账 + 复算周账组，补记计划要扫 24h 内变动的会话源，
  //   每 60 秒做一遍是拿 IO 换一个不会每轮变的结论（v0.4 的 P1-4 教训）。
  //
  //   ★ 闸门口径（用户裁定 / P1-8 同一原则）：
  //     `reconcile().ok` 只回答"六项一致性"；`okStrict` 另外要求**台账读全** + code/(sid,turn)
  //     两个唯一性成立。若台账本身没读全，说"没有缺口/0 条"是拿残缺数据下结论 ——
  //     比不报更坏。所以：只有 okStrict=true 才允许把结论说成"无缺口"；
  //     否则一律记 `conclusion:'unknown'` + 写明原因，禁止任何"无/0"结论性文字。
  {
    // ★★★ F1 stale 判定（P1-01a / P2-05 整改）：会话循环结束后统一判，**必须两条同时成立** ——
    //   ① 源已静止（mtime 距今 ≥ max(60s, 2×interval)）；② 该源游标已到 EOF（offset ≥ sourceSize）。
    //   @why 只看 ① 会把"本 tick 读窗口切开的中间态（turn/end 还在后面的帧里）"当成永久缺口：
    //        首灌 >16 MiB 会话时必然发生（本机测试报告 turn 376 / 合成 turn 375），
    //        gate 因此 degraded、设备自检 run-report 红、三台准入必然"需返修"。
    //   ② 拿不到（无游标/无大小）→ 不判 stale：宁可晚一轮喊，不许假警报。
    stat.staleOpenTurns = 0;
    for (const o of (Array.isArray(stat.openTurnList) ? stat.openTurnList : [])) {
      const cur = o && o.source ? cursors[o.source] : null;
      const curOff = cur && Number.isInteger(cur.offset) ? cur.offset : null;
      const size = Number.isInteger(o.sourceSize) ? o.sourceSize : null;
      o.cursorOffset = curOff;
      o.atEof = curOff !== null && size !== null ? curOff >= size : false;
      // ★ 真正的前置条件：**本次扫描没有被预算/坏帧截断**（即这一轮已经读到了源尾）。
      //   未闭合轮的游标按 P0-2 设计会回退到 open.startByte（所以 offset 恒 < size），
      //   因此不能用 offset==size 判；改用 meta.stopped / meta.blocked。
      o.readToEnd = !o.scanStopped && !o.scanBlocked;
      o.stale = !!(o.staticMs >= o.staleAfterMs && o.readToEnd);
      if (o.stale) stat.staleOpenTurns++;
    }
    const nowMs = Date.now();

    // ① 补记链：lite 已裁（0.9.2）—— `tools/backfill.js` / `backfill-exec.js` 保留在 tools/，
    //    但 tick 不再调用 backfillPlan/executeBackfill（index.js 静态不可达 → 边界传递边归零）。
    //    需要补记时按总纲 §5.4「拆出去 ≠ 扔掉」手动跑 tools/ 里的脚本；
    //    本版不写 run-report 的 backfill 段（缺段合法）。
    // ② 对账（纯只读）：okStrict 是闸门，不是"结论"本身
    let rec = null;
    if (nowMs - lastReconcileAtMs >= RECONCILE_INTERVAL_MS) {
      if (remainingBudgetMs() < SEGMENT_MIN_START_MS) {
        // ★ P1-02：对账是全量只读重算（可 >10 s），预算不够就整段跳过 —— 下一 tick 会重试
        //   （lastReconcileAtMs 不推进，所以不会被节流吞掉）。
        deferSegment('reconcile(对账)');
      } else {
      const reconcileStartedMs = Date.now();
      const readMeterReconcileStart = readMeterBytes();
      try {
        rec = reconcile({
          root: cfg.root,
          offsetMinutes: cfg.offsetMinutes,
          receiptAnchorRoot: cfg.receiptAnchorRoot,
          nowMs,
        });
        lastReconcileAtMs = nowMs;
      } catch (e) {
        stat.errors.push('reconcile failed: ' + (e && e.message));
      } finally {
        // ★ 0.9.3 P2-6：对账轮的读盘/耗时单列 —— C21 要求"小时对账轮"与普通 tick 分开判读。
        stat.phases.reconcileMs += Date.now() - reconcileStartedMs;
        // ★ re3（RT-01）：对账段真读字节（旧口径完全没计量：审计③实测该段真读 ~175 MiB）。
        stat.reconcileReadBytes = Math.max(0, readMeterBytes() - readMeterReconcileStart);
      }
      }
    }

    // ③ 闸门（V0.6.1 / D18-C）：三级结论 **ok / degraded / unknown**。
    //    ok       = 无保留（六项全过 + 无 legacy 类已知缺口）；
    //    degraded = 有保留（已知且逐项可枚举的缺口；账本读全、唯一性成立）；
    //    unknown  = 无法表示意见（读不全/唯一性不成立/legacy 基线链断）。
    //    ★ 三级都**禁止**输出"无缺口/0 条"这类无条件措辞；degraded/unknown 必须带 reason。
    if (rec) {
      // ★ F1（v1.0.0-preview4）：把"源已静止的未闭合轮"作为可枚举缺口交给 gate（见 lib/gate.js GATE_VERSION=3）。
      const gate = classifyGate(rec, { staleOpenTurns: stat.staleOpenTurns, pendingSupplements: stat.supplementPendingGaveUp });
      stat.reconcile = {
        ok: rec.ok === true,
        okStrict: rec.okStrict === true,
        ledgerOk: rec.ledgerOk === true,
        ledgerRows: Number(rec.ledgerRows) || 0,
        originalMissing: (rec.originalMissing || []).length,
        originalOrphan: (rec.originalOrphan || []).length,
        weeklyGroupsMissing: (rec.weeklyGroupsMissing || []).length,
        lostGaps: Number(rec.lostGaps && rec.lostGaps.count) || 0,
        // ★ P1-03：count 只是"未覆盖"数；total/covered 并列留证（覆盖 ≠ 抹掉证据）
        lostGapsTotal: Number(rec.lostGaps && rec.lostGaps.total) || 0,
        lostGapsCovered: Number(rec.lostGaps && rec.lostGaps.covered) || 0,
        receiptBreaks: Number(rec.receiptBreakCount) || 0,
        sealChainOk: !!(rec.sealChain && rec.sealChain.ok === true),
        legacyUnverifiable: Number(rec.legacyUnverifiableCount) || 0,
        legacyUnmarkedNoEvidence: rec.legacyMarks ? Number(rec.legacyMarks.unmarked) || 0 : 0,
        legacyMarksChainOk: rec.legacyMarks ? rec.legacyMarks.chainOk === true : null,
        conclusion: gate.conclusion,
        knownGaps: gate.knownGaps,
        reason: gate.reason,
        // ★ re3（RT-01）：对账档位与行级核验计数带进 stat（→ tick-metrics.reconcile / 运行时摘要）。
        mode: typeof rec.mode === 'string' ? rec.mode : '',
        verifiedRows: Number(rec.verifiedRows) || 0,
        cachedRows: Number(rec.cachedRows) || 0,
      };
      // ★ P1-02：留一份对账快照（无对账的 tick 也要能写"标注了快照时间"的报告）
      lastReconcileStat = { ...stat.reconcile };
      lastLedgerRows = Number(stat.reconcile.ledgerRows) || lastLedgerRows;
      writtenSinceReconcile = 0;
      if (gate.conclusion === 'unknown') {
        if (log.warn) {
          log.warn('[dsh-dialog-ledger] 对账无法表示意见（unknown）：' + (gate.reason || '未知原因') +
            ' —— 本轮不得声称「无缺口/0 条」');
        }
      } else if (gate.conclusion === 'degraded') {
        if (log.warn) {
          log.warn('[dsh-dialog-ledger] 对账有保留意见（degraded）：' + gate.reason +
            '（已知缺口，逐项可查；这不是"无缺口"）');
        }
      }
    }

    // ④ 运行报告（RC-12/HL-10/HL-11/BC-15）：**唯一写者**是 lib/report.writeRunReport，
    //    入口只负责传段；本文件**不**二次改写报告文件（两个写者会被审计挑出来）。
    const runReportStartedMs = Date.now();
    const readMeterReportStart = readMeterBytes();
    // ★★★ P1-02（本机测试报告）：**没有对账的 tick 也要写报告**，且必须"说真话"。
    //   @why 旧实现只在 `if (rec)` 时写 → 对账 1 小时节流期内报告一直是首 tick 快照：
    //        台账 472/522 行、gate=ok，而实际本轮已能看到"未闭合轮"缺口 →
    //        面板与设备自检读到的都是假绿（红队 4 次复现；也是"删报告即可过"的前置条件之一）。
    //   现在：① 用上一轮对账快照 + **本 tick 实际可见的缺口**叠加出对外 gate（degraded，不许 ok）；
    //        ② 报告里加 `freshness`：对账时间/年龄、写入时真实行数、是否叠加；
    //        ③ 首 tick 没有对账也没有快照时才不写（缺段合法）。
    const overlayGaps = [];
    if (Number(stat.staleOpenTurns) > 0) {
      overlayGaps.push('未闭合轮=' + stat.staleOpenTurns + '（源已静止 >2×interval，逐项见 run-report.openTurns）');
    }
    if (Number(stat.supplementPendingGaveUp) > 0) {
      overlayGaps.push('补记待补=' + stat.supplementPendingGaveUp + '（连续 3 次写失败已放弃自动重试，逐项见 run-report.supplementPending）');
    }
    const baseGate = stat.reconcile || lastReconcileStat;
    let gateForReport = baseGate
      ? { conclusion: baseGate.conclusion, reason: baseGate.reason, okStrict: baseGate.okStrict === true, knownGaps: Array.isArray(baseGate.knownGaps) ? [...baseGate.knownGaps] : [] }
      : { conclusion: 'unknown', reason: '本轮未计算对账', okStrict: false, knownGaps: [] };
    if (overlayGaps.length > 0) {
      gateForReport.knownGaps = [...gateForReport.knownGaps, ...overlayGaps];
      gateForReport.reason = [gateForReport.reason, ...overlayGaps].filter(Boolean).join('; ');
      if (gateForReport.conclusion !== 'unknown') gateForReport.conclusion = 'degraded';
    }
    // ★ 修正（第二轮测试报告 P2-2，2026-11-15）：`lastLedgerRows` 已含**本 tick 对账前写入**的行数
    //   （对账在本 tick 写完之后才跑），所以本 tick 的 `written` 不能再加一次 ——
    //   旧实现固定多出首 tick 的写入量（实测 syn 2,030 / real 2,080，而实际均 1,558）。
    //   口径：① 本 tick 有对账 → `lastLedgerRows` 就是"写入后真实行数"，直接用；
    //        ② 本 tick 没有对账（节流期）→ 累加自上次对账以来的写入。
    let ledgerRowsLive;
    if (stat.reconcile) {
      writtenSinceReconcile = 0;
      ledgerRowsLive = lastLedgerRows;
    } else {
      writtenSinceReconcile += Number(stat.written) || 0;
      ledgerRowsLive = lastLedgerRows + writtenSinceReconcile;
    }
    const freshness = {
      reconcileAt: lastReconcileAtMs > 0 ? isoTime(lastReconcileAtMs, cfg.offsetMinutes) : null,
      reconcileAgeMs: lastReconcileAtMs > 0 ? Math.max(0, Date.now() - lastReconcileAtMs) : null,
      ledgerRowsLive,
      ledgerRowsSnapshot: Number(baseGate && baseGate.ledgerRows) || 0,
      gateOverlay: overlayGaps.length > 0,
      note: 'counts.ledgerRows 是**对账快照**；ledgerRowsLive 是写入时刻的真实行数；gateOverlay=true 表示对外 gate 已叠加本 tick 可见缺口（结论只会更保守，不会更乐观）。',
    };
    if (rec || lastReconcileStat) {
      try {
        const rep = writeRunReport({
          root: cfg.root,
          result: rec || lastReconcileStat,
          freshness,
          // 自愈段今夜未接线（HL-01..HL-12 未覆盖）→ 不传 scan；附录 A 允许缺段
          actions: [],
          // ★ 审计 #1：errors/blockedSources 不再是硬编码空数组。
          //   errors 由 `.errors.jsonl` 聚合（结构性来源），blocked 用本轮真实收集到的清单。
          errors: aggregateReportErrors(cfg.root),
          // 告警（"该知道但不是出错"）落报告，不混进 errors —— 否则"零错误"验收永远红
          warnings: Array.isArray(stat.warnings) ? stat.warnings : [],
          blockedSources: stat.blockedList,
          // ★ CH-09：坏帧证据（含偏移），让"读不动了"能在报告里按字节定位
          frameErrors: stat.frameErrors,
          // ★ 本轮确实没采集的段：**显式标注**，不伪装成"空 = 零"
          stuckSources: [],
          unavailable: ['stuckSources', 'integrityFailures'],
          // ★ INV-11/12：每批的轮/事件/字节/超预算标记
          batches: stat.batchRecords,
          eventOversize: stat.eventOversize,
          // ★ INV-06/08：pending 的 added/dup（幂等证据）
          pending: { added: stat.pendingTurns, dup: stat.pendingDup },
          // ★ F1：未闭合轮逐项清单（只给清单，不改成"缺口"语义；缺口由 gate.knownGaps 表达）
          openTurns: stat.openTurnList,
          // ★ F2：封板后补记待办（未放弃 / 已放弃），人可逐项处置
          supplementPending: Array.isArray(state.supplementPending) ? state.supplementPending : [],
          // ★ INV-09：历史 partial 只读列出（来自补记计划）
          // lite（0.9.2）：补记链已移出 tick → 没有 plan 对象；报告字段保留形状、值恒空。
    legacyPartials: [],
          // ★ 审计 #2：闸门结论必须**落盘**，否则"okStrict=false"只活在内存与日志里，
          //   而报告里的 reconcile.ok 可能是 true —— 读报告的人会被误导。
          // ★ P1-02：这里用 `gateForReport`（= 上一轮对账快照 + 本 tick 可见缺口的叠加），
          //   对账节流期内也不会把"已看到的缺口"写成 ok。
          gate: gateForReport,
          // BC-15：只有本轮真的算了计划才给（lib 只在给了对象时才出现 backfill 键）
          // ★ V0.6.2：一级布局快照（EXTRA_KEYS 通道，见 lib/report.js 的说明）
          layout: stat.layout,
          // ★ P0-3-resume：撕裂尾巴自愈留痕必须进**交付物**（.run-report-*.json），
          //   不只活在 state/内存里。没发生时不落键（附录 A：缺段合法）。
          ...(Array.isArray(stat.tornTailRepaired) && stat.tornTailRepaired.length > 0
            ? { tornTailRepaired: stat.tornTailRepaired } : {}),
          // ★ v1.0.0-re2（S-11 C42 (c)）：日结摘要版本账（已发版本总数/最新版本号/本轮补发数）
          ...(stat.receiptDigest ? { receiptDigest: stat.receiptDigest } : {}),
          nowMs,
          offsetMinutes: cfg.offsetMinutes,
        });
        if (rep && rep.ok) stat.runReport = rep.path;
        else stat.errors.push('run-report failed: ' + ((rep && rep.reason) || '?'));
      } catch (e) {
        stat.errors.push('run-report failed: ' + (e && e.message));
      } finally {
        stat.phases.reportMs += Date.now() - runReportStartedMs;
        stat.reportReadBytes = Math.max(0, readMeterBytes() - readMeterReportStart);
      }
    }
  }

  return stat;
}

/**
 * 插件主函数。DSH 加载插件时会调用它。
 *
 * @param {object} ctx DSH 插件上下文
 * @param {object} config 来自 cordis.patch.yml 的 config
 * @returns {() => void} 卸载函数（DSH 卸载插件时会调）
 *
 * @why 返回卸载函数而不是什么都返回：定时器必须能被清掉，
 *      否则热重载时会同时跑两个定时器（那会让每轮写两次）。
 */
export function apply(ctx, config) {
  const cfg = readConfig(config);
  const log = (ctx && ctx.logger) || console;

  if (!cfg.enabled) {
    if (log.info) log.info('[dsh-dialog-ledger] 已禁用（config.enabled=false）');
    return () => {};
  }

  // ★ re3 P0（K-12 消费侧 · lead 裁定）：每个挂载实例生成**唯一** instanceId，锁的幂等键 = (root, instanceId)。
  //   @why 不传时 acquire 共用默认 instanceId：同进程两个挂载/调用点会拿到同一 handle ——
  //     第二个实例 release 掉第一个的锁（互删锁），第一个还在写 → P0"同进程双写"只修了一半。
  //   @why 用 randomUUID 而不是 pid：热重载时新旧实例可能同 pid；每实例唯一才真正互斥。
  //   @why 前缀 `mount-`：锁文件/度量里一眼能区分"挂载实例"与"裸调用（测试/工具）"。
  const instanceId = 'mount-' + randomUUID();

  // ★ V0.6.2：默认根首次运行先"收养"旧默认根（同盘 rename），再建目录。
  //   顺序不能反：先 mkdir 会把新根建出来，"新根不存在"的收养前提就永久失效。
  try {
    adoptLegacyDefaultRoot(cfg, log);
  } catch (e) {
    if (log.warn) log.warn('[dsh-dialog-ledger] 收养旧默认根异常（忽略）: ' + e.message);
  }

  // 首次启动：确保目录存在（避免第一轮跑时报 ENOENT）
  try {
    fs.mkdirSync(cfg.root, { recursive: true });
  } catch (e) {
    if (log.warn) log.warn('[dsh-dialog-ledger] 建目录失败: ' + e.message);
  }

  if (log.info) {
    log.info(`[dsh-dialog-ledger] loaded ｜ root=${cfg.root} ｜ ` +
             `interval=${cfg.intervalSeconds}s ｜ hotWindow=${cfg.hotWindowSeconds}s`);
  }

  // ★ V0.6：Agent 工具面（只读）/ 左栏面板 API —— **可选增强，绝不拖垮记账**。
  // ★★ A13 三次真机重启教训（2026-11-10）：
  //   v0.6.2 直读 ctx.tools → 启动窗口必抛、fiber failed（记账也不跑）；
  //   v0.6.4 删直读回退 + inject → 记账跑但挂载被跳过（get 抛错被外层 catch 吞掉）；
  //   v0.6.5 安全 get 优先 + inject → 重启后仍不挂载（inject 回调未见生效，原因待证）。
  //   本版（v0.6.6）改为**确定性重试**：每 3s 用安全 `ctx.get` 探测服务，
  //   就绪即挂载（最多 40 次≈2 分钟），并写启动诊断日志；inject 只作辅助。
  //   可选增强绝不影响记账：任何探测/挂载异常都被单独捕获，tick 照常。
  const diagEnabled = process.env.NODE_TEST_CONTEXT === undefined;
  // 启动诊断写系统临时目录（不落桌面/账库；每次 apply 覆盖式追加，最多保留 200 行）
  const diagPath = path.join(os.tmpdir(), 'dsh-dialog-ledger-startup.log');
  const diag = (line) => {
    if (!diagEnabled) return;
    try {
      try { if (fs.statSync(diagPath).size > 64 * 1024) fs.writeFileSync(diagPath, ''); } catch { /* 文件不存在则忽略 */ }
      fs.appendFileSync(diagPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* 诊断写失败不影响主流程 */ }
  };
  diag('apply enter root=' + cfg.root + ' instanceId=' + instanceId);
  // ★ re3（ARCH-03/Config）：把 Config schema 的解析结果写进启动诊断（可查；undefined = 如实降级）。
  diag('config schema=' + (Config ? 'declared via ' + schemaSpecifier : 'undefined (no schemastery resolved)'));
  // ★ re3（审计③ ARCH-04）：挂载健康度（runOnce 只读快照 → tick-metrics/state/run-report）。
  //   ok = 两项都挂上；degraded = 有任何一项没挂上（含"快速窗口结束、慢重试中"）。
  //   ⚠️ moduleMountHealth 是模块级（runOnce 在 apply 之外也能读到最近一次 apply 的健康度）；
  //      apply 每次重置为本次实例的状态，避免 HMR 后读到旧实例的"已挂载"假象。
  const mountHealth = {
    v: 1,
    ok: false,
    degraded: true,
    phase: 'starting',
    attempts: 0,
    startedAt: '',
    updatedAt: '',
    okAt: '',
    gaveUpAt: '',
    tools: { mounted: false, registered: 0, attempts: 0, lastError: '', mountedAt: '', gaveUpAt: '' },
    webServer: { mounted: false, registered: 0, attempts: 0, lastError: '', mountedAt: '', gaveUpAt: '' },
  };
  moduleMountHealth = mountHealth;
  const stampNow = () => isoTime(Date.now(), cfg.offsetMinutes);
  mountHealth.startedAt = stampNow();
  mountHealth.updatedAt = mountHealth.startedAt;
  const healthOf = (name) => (name === 'tools' ? mountHealth.tools : mountHealth.webServer);
  const refreshMountHealth = () => {
    mountHealth.attempts = mountState.attempts;
    mountHealth.ok = mountHealth.tools.mounted === true && mountHealth.webServer.mounted === true;
    mountHealth.degraded = !mountHealth.ok;
    mountHealth.updatedAt = stampNow();
    if (mountHealth.ok && !mountHealth.okAt) {
      mountHealth.okAt = mountHealth.updatedAt;
      mountHealth.phase = 'ok';
    } else if (!mountHealth.ok) {
      mountHealth.phase = mountHealth.gaveUpAt ? 'slow-retry' : (mountState.attempts > 0 ? 'retrying' : 'starting');
    }
  };
  const mountState = { tools: false, webServer: false, attempts: 0, lastError: null, source: {} };
  let toolFace = { registered: 0, names: [], dispose: () => {} };
  let panelApi = { registered: 0, paths: [], dispose: () => {} };
  // 卸载统一由 apply 末尾 dispose 负责（不要在这里再 ctx.effect，否则同一次卸载会 dispose 两遍）
  const mountTools = (c) => {
    const tf = registerLedgerTools(c, {
      getRoot: () => cfg.root,
      offsetMinutes: cfg.offsetMinutes,
      logger: log,
      // lite（0.9.2）：工具面已裁到 search/turn/health，清理工具不注册 → 不再传 getCleanupConfig。
    });
    if (log.info && tf.registered > 0) {
      log.info(`[dsh-dialog-ledger] 已注册 Agent 工具 ${tf.registered} 个: ${tf.names.join(', ')}`);
    }
    return tf;
  };
  const mountPanelApi = (c) => {
    const pa = registerLedgerPanelApi(c, {
      getRoot: () => cfg.root,
      offsetMinutes: cfg.offsetMinutes,
      logger: log,
      receiptAnchorRoot: cfg.receiptAnchorRoot,
    });
    if (log.info && pa.registered > 0) {
      log.info(`[dsh-dialog-ledger] 已注册只读面板 API ${pa.registered} 条: ${pa.paths.join(', ')}`);
    }
    return pa;
  };
  /**
   * 一次挂载（**可重入**）：成功置位并记录；失败只记录、不抛。
   *
   * ★ re3（审计③ ARCH-04）：旧实现无脑置 `mountState[name]=true`，且失败/短路后不再重试：
   *   ① HMR 时同名注册可能抛错（旧实例的注册还没撤）→ 0 条注册成功却被记成"已挂载"，
   *      永久短路，之后再也不重挂；
   *   ② 已挂载时重复调用直接 return，注册被宿主撤销后（HMR/服务替换）不会恢复。
   *   新口径：**注册 0 条 = 没挂上**（不置位、留 lastError，交给重试）；已挂载时重复调用
   *   是幂等的（不重复注册）；注册被撤（registered=0）时允许清掉残壳后重挂。
   * @returns {boolean} true = 本次确实处于"已挂载且注册非空"
   */
  const mountOnce = (name, fn) => (c) => {
    const health = healthOf(name);
    const current = name === 'tools' ? toolFace : panelApi;
    if (mountState[name]) {
      if (current && Number.isFinite(current.registered) && current.registered > 0) {
        diag(`${name} already mounted (re-entrant call is a no-op)`);
        refreshMountHealth();
        return true; // 可重入：已挂载且注册还在 → 幂等
      }
      // 注册被宿主/HMR 撤掉了 → 清掉残壳，允许重挂（不再永久短路）。
      try { current.dispose(); } catch { /* 撤残壳失败不影响重挂 */ }
      mountState[name] = false;
      diag(`${name} registration vanished → remount`);
    }
    try {
      const r = fn(c);
      const registered = Number(r && r.registered) || 0;
      if (registered <= 0) {
        // 服务在、但一条都没注册上（HMR 同名冲突等）：这是**失败**，不许当已挂载。
        const why = name + ': registered=0（服务已就绪但注册未成功）';
        mountState.lastError = why;
        health.mounted = false;
        health.registered = 0;
        health.lastError = why;
        diag(`${name} mount registered=0`);
        if (log.warn) log.warn(`[dsh-dialog-ledger] 挂载 ${name} 失败（可选增强，记账照跑）: ${why}`);
        refreshMountHealth();
        return false;
      }
      mountState[name] = true;
      mountState.source[name] = 'ready';
      if (name === 'tools') toolFace = r;
      else panelApi = r;
      health.mounted = true;
      health.registered = registered;
      health.lastError = '';
      health.mountedAt = stampNow();
      health.gaveUpAt = '';
      diag(`${name} mounted registered=` + registered);
      refreshMountHealth();
      return true;
    } catch (e) {
      const why = (e && e.message) || String(e);
      mountState.lastError = name + ': ' + why;
      health.mounted = false;
      health.registered = 0;
      health.lastError = name + ': ' + why;
      diag(`${name} mount failed: ` + why);
      if (log.warn) log.warn(`[dsh-dialog-ledger] 挂载 ${name} 失败（可选增强，记账照跑）: ` + why);
      refreshMountHealth();
      return false;
    }
  };
  /** 安全探测：服务 ACTIVE 时返回服务对象；未就绪（get 抛/空）返回 null —— 绝不外抛。 */
  const probeService = (serviceName) => {
    try {
      if (ctx && typeof ctx.get === 'function') return ctx.get(serviceName) || null;
    } catch (e) {
      diag(`get(${serviceName}) threw: ` + e.message);
    }
    return null;
  };
  /** 已挂载 = 置位且注册非空（注册被撤 → 视为未挂载，允许重挂）。 */
  const isMounted = (name) => {
    if (!mountState[name]) return false;
    const cur = name === 'tools' ? toolFace : panelApi;
    return !!(cur && Number.isFinite(cur.registered) && cur.registered > 0);
  };
  const tryMount = (name, serviceName, fn) => {
    // 每个服务单独计尝试次数（健康度里能看出"tools 试了 40 次、webServer 试了 40 次"）。
    healthOf(name).attempts += 1;
    if (isMounted(name)) return true;
    if (!probeService(serviceName)) {
      const h = healthOf(name);
      if (!h.lastError) h.lastError = 'service-not-ready: ' + serviceName;
      refreshMountHealth();
      return false;
    }
    return mountOnce(name, fn)(ctx);
  };
  // 首次尝试
  mountState.attempts += 1;
  const toolsReady = tryMount('tools', 'tools', mountTools);
  const apiReady = tryMount('webServer', 'webServer', mountPanelApi);
  diag(`initial tools=${toolsReady} webServer=${apiReady}`);
  // inject 只作辅助（若宿主支持且服务稍后才 ACTIVE）
  if (!toolsReady && ctx && typeof ctx.inject === 'function') {
    try { ctx.inject(['tools'], mountOnce('tools', mountTools)); diag('inject tools scheduled'); } catch (e) { diag('inject tools err: ' + e.message); }
  }
  if (!apiReady && ctx && typeof ctx.inject === 'function') {
    try { ctx.inject(['webServer'], mountOnce('webServer', mountPanelApi)); diag('inject webServer scheduled'); } catch (e) { diag('inject webServer err: ' + e.message); }
  }
  // ★ 确定性重试：每 3 s 探测一次（最多 40 次 ≈ 2 min）。
  //   ★ re3（ARCH-04）：2 min 后**不再永久放弃** —— 退化为 60 s 慢重试；
  //     服务晚就绪/HMR 后仍能挂上，失败事实进 mount 健康度（tick-metrics/state/run-report 可查）。
  let mountRetry = null;
  let mountSlowRetry = null;
  const stopMountTimers = () => {
    if (mountRetry) { try { clearInterval(mountRetry); } catch { /* ignore */ } mountRetry = null; }
    if (mountSlowRetry) { try { clearInterval(mountSlowRetry); } catch { /* ignore */ } mountSlowRetry = null; }
  };
  const mountRetryTick = () => {
    mountState.attempts += 1;
    const t = tryMount('tools', 'tools', mountTools);
    const a = tryMount('webServer', 'webServer', mountPanelApi);
    diag(`retry#${mountState.attempts} tools=${t} webServer=${a}`);
    if (isMounted('tools') && isMounted('webServer')) {
      stopMountTimers();
      return;
    }
    // 快速窗口结束：记录 gaveUpAt（不是"放弃"，是"降级为慢重试"的时间线证据）。
    if (mountState.attempts >= 40 && !mountHealth.gaveUpAt) {
      mountHealth.gaveUpAt = stampNow();
      mountHealth.tools.gaveUpAt = mountHealth.tools.mounted ? '' : mountHealth.gaveUpAt;
      mountHealth.webServer.gaveUpAt = mountHealth.webServer.mounted ? '' : mountHealth.gaveUpAt;
      const line = '可选增强面挂载失败：tools=' + (isMounted('tools') ? 'ok' : '未挂载') +
        ' webServer=' + (isMounted('webServer') ? 'ok' : '未挂载') +
        '；已重试 ' + mountState.attempts + ' 次（约 2 min）→ **不再永久放弃**，退化为 60 s 慢重试。' +
        '记账不受影响；健康度见 .tick-metrics 的 mount 段 / .state.json lastStat.mount。' +
        '最后错误: ' + (mountState.lastError || '-');
      if (log.warn) log.warn('[dsh-dialog-ledger] WARN ' + line);
      diag('mount degraded → slow retry: ' + (mountState.lastError || '-'));
      if (mountRetry) { try { clearInterval(mountRetry); } catch { /* ignore */ } mountRetry = null; }
      mountSlowRetry = setInterval(() => {
        mountState.attempts += 1;
        const t2 = tryMount('tools', 'tools', mountTools);
        const a2 = tryMount('webServer', 'webServer', mountPanelApi);
        diag(`slow-retry#${mountState.attempts} tools=${t2} webServer=${a2}`);
        if (isMounted('tools') && isMounted('webServer')) {
          stopMountTimers();
          const okLine = '可选增强面已恢复挂载（tools=' + mountHealth.tools.registered +
            '/webServer=' + mountHealth.webServer.registered + '）';
          if (log.info) log.info('[dsh-dialog-ledger] ' + okLine);
          diag(okLine);
        }
      }, 60_000);
      if (mountSlowRetry && typeof mountSlowRetry.unref === 'function') mountSlowRetry.unref();
    }
    refreshMountHealth();
  };
  mountRetry = setInterval(mountRetryTick, 3000);
  if (mountRetry && typeof mountRetry.unref === 'function') mountRetry.unref();
  refreshMountHealth();

  // ★ V0.7 影子双轨：默认关闭（ingestMode='disk' 时一次都不跑，行为=v0.6.7）。
  //   shadow 模式下 disk 仍是唯一写者；另一源（persistence，后续 event）只读，
  //   结果只写 <root>/ledger/.shadow/（I6）。任何异常都在本函数内降级，绝不影响记账 tick（I4）。
  const shadowEnabled = cfg.ingestMode !== 'disk';
  const sessionsBase = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
  let shadowCursors = new Map();
  let shadowAccum = new Map(); // ★ 会话级累积轮次（持久层增量 vs 磁盘全量的对齐关键）
  let shadowRunning = false;
  const runShadowTick = async () => {
    if (!shadowEnabled || shadowRunning) return;
    shadowRunning = true;
    try {
      let persistenceService = null;
      try { if (ctx && typeof ctx.get === 'function') persistenceService = ctx.get('sessionPersistence') || null; } catch { persistenceService = null; }
      const otherCollector = createPersistenceCollector({ host: { sessionPersistence: persistenceService } });
      const shadow = await runShadowOnce({
        diskCollector: createDiskCollector({ sessionsBase }),
        otherCollector,
        cursors: shadowCursors,
        accum: shadowAccum,
        now: Date.now(),
        pendingWindowMs: cfg.ingestShadowPendingMs,
        maxSessions: cfg.ingestShadowMaxSessions,
      });
      shadowCursors = shadow.nextCursors;
      if (shadow.nextAccum) shadowAccum = shadow.nextAccum;
      const wr = writeShadowTick(cfg.root, { records: shadow.records, summary: shadow.summary });
      if (!wr.ok && log.warn) log.warn('[dsh-dialog-ledger] 影子写盘失败（不影响记账）: ' + wr.error);
      if (shadow.warnings.length && log.warn) log.warn('[dsh-dialog-ledger] 影子告警: ' + shadow.warnings.slice(0, 3).join('; '));
    } catch (e) {
      if (log.warn) log.warn('[dsh-dialog-ledger] 影子轮失败（不影响记账）: ' + e.message);
    } finally {
      shadowRunning = false;
    }
  };


  // 立刻跑一次（不让用户等 60 秒）
  let running = false;
  /** 在跑的 tick Promise（dispose 必须等它收敛；null = 没有在跑）。 */
  let inFlight = null;
  /** 在跑的影子轮 Promise（影子写 .shadow/，同样是写者）。 */
  let shadowInFlight = null;
  // ★ m7（审计 m7）：卸载时打断 in-flight tick —— 旧 dispose 只 clearInterval，
  //   已经在跑的那一轮会继续写盘（热重载时"旧实例写一笔、新实例再写一笔"的风险窗口）。
  //   这里用 AbortController 复用既有的 INV-13 取消通道（core 的 aborted() 会读它）。
  const stopController = new AbortController();
  let disposed = false;
  const tick = async () => {
    if (disposed || running) return; // 防重入 + 卸载后不再开新轮
    running = true;
    const p = (async () => {
      try {
        // cfg.signal 优先于 ctx.signal（INV-13 口径）：卸载即中止，已提交批不回滚。
        // ★ re3（K-12 消费侧）：instanceId 每挂载实例唯一 → 锁幂等键 (root, instanceId)。
        // ★ 多写者硬断言：onLockLost 让 core 在被接管的一瞬间 abort 本 tick（安全收敛，不继续写）。
        const stat = await runOnce(ctx, {
          ...cfg, signal: stopController.signal, instanceId,
          // ★ K-25 加固：把挂载期持有的锁交给 runOnce（tick 复用，不 acquire/release）
          __mountLock: mountLock,
          onLockLost: () => { try { stopController.abort(); } catch { /* ignore */ } },
        });
        // 挂载期持锁后，tick 理论上不会 lockSkipped；一旦出现（锁被夺/丢失）：
        //   立即停 tick、丢弃 handle、回到"重试取锁"—— 不允许"警告后继续"。
        if (stat && (stat.lockLostFatal || stat.lockBlocked || stat.lockSkipped)) {
          blockedByLock = true;
          try { if (mountLock) release(mountLock); } catch { /* ignore */ }
          mountLock = null;
          clearTimers();
          if (!disposed && !mountRetryTimer) {
            mountRetryTimer = setTimeout(() => { mountRetryTimer = null; tryMountLock(); }, LOCK_RETRY_MS);
            if (typeof mountRetryTimer.unref === 'function') mountRetryTimer.unref();
          }
        }
      } catch (e) {
        if (log.warn) log.warn('[dsh-dialog-ledger] runOnce 抛异常: ' + e.message);
      } finally {
        running = false;

        if (shadowEnabled && !disposed) shadowInFlight = runShadowTick();
      }
    })();
    inFlight = p;
    try { await p; } finally { if (inFlight === p) inFlight = null; }
  };

  // ★★★ 多写者硬断言（机主 2026-11-15 指令）· apply 侧 —— **第二轮加固（mount 期持锁）**：
  //   @why 旧实现是"每个 tick 抢一次锁"：两个挂载实例会各自抢到不同的 tick，**交替成为写者**，
  //        "第二个写者启动即被拒绝"只在单 tick 内成立（第二轮异机报告实测：两实例轮换写者）。
  //   现在改为 mount 期持锁，才真正满足"检测到第二个写者 → 拒绝启动"：
  //     ① apply() 启动时 acquire 一次；抢不到 → ERROR + **不启动 tick**，只每 LOCK_RETRY_MS 重试；
  //     ② 拿到后 mountLock 由 apply 持有（心跳由 lock.js 的定时器维持），tick 复用同一 handle；
  //     ③ 锁被夺/丢失 → 停 tick、丢弃 handle、回到"重试取锁"（绝不"警告后继续"）。
  const LOCK_RETRY_MS = lockRetryMsOverride > 0 ? lockRetryMsOverride : 30 * 1000;
  const NORMAL_INTERVAL_MS = Math.max(1, Number(cfg.intervalSeconds) || 60) * 1000;
  let blockedByLock = false;
  /** 挂载期写锁 handle（apply 持有；tick 复用；dispose 释放）。 */
  let mountLock = null;
  /** 正常 tick 定时器 / 取锁重试定时器（互斥使用）。 */
  let timer = null;
  let mountRetryTimer = null;
  const clearTimers = () => {
    if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
    if (mountRetryTimer) { try { clearTimeout(mountRetryTimer); } catch { /* ignore */ } mountRetryTimer = null; }
  };
  /** 取到锁后启动正常 tick 节奏（并立刻跑一次）。 */
  const startTicking = () => {
    if (disposed) return;
    clearTimers();
    tick();
    timer = setInterval(tick, NORMAL_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  /** 安排一次"重试取锁"（不启动 tick）。 */
  const scheduleMountRetry = () => {
    if (disposed || mountRetryTimer) return;
    mountRetryTimer = setTimeout(() => { mountRetryTimer = null; tryMountLock(); }, LOCK_RETRY_MS);
    if (typeof mountRetryTimer.unref === 'function') mountRetryTimer.unref();
  };
  /** 取挂载锁；抢不到 = 拒绝启动（不跑 tick），按 LOCK_RETRY_MS 重试。 */
  const tryMountLock = () => {
    if (disposed) return;
    let h = null;
    try {
      h = acquire(cfg.root, { offsetMinutes: cfg.offsetMinutes, instanceId });
    } catch (e) {
      blockedByLock = true;
      const line = 'ERROR 拒绝启动：取锁失败（IO）：' + (e && e.message ? e.message : String(e)) +
        '（instanceId=' + instanceId + '）→ 不启动 tick，' + Math.round(LOCK_RETRY_MS / 1000) + 's 后重试';
      if (log.error) log.error('[dsh-dialog-ledger] ' + line); else if (log.warn) log.warn('[dsh-dialog-ledger] ' + line);
      scheduleMountRetry();
      return;
    }
    if (!h.acquired) {
      blockedByLock = true;
      const holder = h.holder || {};
      const line = 'ERROR 拒绝启动：账库已被另一个写者持有（pid=' + (holder.pid === undefined ? '?' : holder.pid) +
        ' host=' + (holder.hostname === undefined ? '?' : holder.hostname) + ' reason=' + h.reason +
        '）—— 多写者场景不支持；本实例**不启动 tick**，每 ' + Math.round(LOCK_RETRY_MS / 1000) + 's 重试（instanceId=' + instanceId + '）';
      if (log.error) log.error('[dsh-dialog-ledger] ' + line); else if (log.warn) log.warn('[dsh-dialog-ledger] ' + line);
      scheduleMountRetry();
      return;
    }
    mountLock = h;
    blockedByLock = false;
    if (h.stalePath && log.warn) log.warn('[dsh-dialog-ledger] 夺取到僵死锁，旧锁留证: ' + h.stalePath);
    if (log.info) log.info('[dsh-dialog-ledger] 已取得账库写锁（mount 期持有，instanceId=' + instanceId + '）→ 启动 tick');
    startTicking();
  };

  tryMountLock();

  // ★ 生命周期：清理必须用 ctx.effect 注册，不能靠 apply 的返回值。
  //
  //   已装插件 dsh-flowchart 的写法就是 ctx.effect(() => () => cleanup)；
  //   Cordis 不认 apply 的返回值，于是热重载后旧定时器会继续跑 ——
  //   表现是每 60 秒写两遍、三遍……，而账只追加，多写的行无法删除。
  //   这是"可审计"最不能接受的一类错误：账变多，且无法证明哪条是真的。
  //
  // ★★ re3 P0（审计③ ARCH-01）：dispose **返回 Promise** 并等待在跑的 tick 收敛。
  //   @why 旧实现 abort()+clearInterval 后同步返回：abort 只在"批边界"生效，而在跑的
  //     那一轮还要走完周账/月账/目录/索引/收据/对账/运行报告 —— 审计实测 unloaded 之后
  //     仍写 7 个文件（热重载 = 双写；账只追加，多写的行不可删）。
  //   @why Cordis 的 effect 清理函数支持异步：直接把"收敛 Promise"返回给宿主等待。
  //   @why 中止后 core 只落 .state 提交点（游标/首跑标记），已提交批不回滚、未提交批丢弃、
  //     派生段全部跳过（下一实例会从台账补）—— 详见 runOnceCore 的 abort 分支。
  let disposePromise = null;
  const dispose = () => {
    if (disposePromise) return disposePromise; // 幂等：重复调用返回同一个收敛 Promise
    disposed = true;              // ★ m7：先关门（tick 入口检查），再打断在跑的轮次
    try { stopController.abort(); } catch { /* 已中止不影响卸载 */ }
    // ★ K-25：正常 tick / 取锁重试两个定时器都清；挂载锁必须由 apply 释放（tick 不释放）
    clearTimers();
    try { if (mountLock) { const rr = release(mountLock); if (rr && rr.released === false && log.info) log.info('[dsh-dialog-ledger] 挂载锁释放未确认: ' + (rr.reason || '?')); } } catch { /* 释放失败不影响卸载收敛 */ }
    mountLock = null;
    stopMountTimers();
    const pending = [];
    if (inFlight) pending.push(inFlight);
    if (shadowInFlight) pending.push(shadowInFlight);
    diag('dispose abort inflight=' + pending.length + ' running=' + (running ? 'yes' : 'no'));
    // 增强面先撤（同步），再等在跑轮次收敛 —— 否则"卸载后旧实例还在写盘"。
    try { toolFace.dispose(); } catch { /* 工具撤销失败不影响记账卸载 */ }
    try { panelApi.dispose(); } catch { /* 面板 API 撤销失败不影响记账卸载 */ }
    if (log.info) {
      // 保留 "unloaded" 口径（既有守卫用例按 includes('unloaded') 断言）；
      // 真正的"已收敛"在下面 Promise 完成后再打一行。
      log.info('[dsh-dialog-ledger] unloaded requested awaiting-inflight=' + pending.length);
    }
    disposePromise = Promise.allSettled(pending).then((results) => {
      const rejected = results.filter((r) => r.status === 'rejected').length;
      diag('dispose converged inflight=' + pending.length + ' rejected=' + rejected);
      if (log.info) {
        log.info('[dsh-dialog-ledger] unloaded' +
          (rejected > 0 ? '（有 ' + rejected + ' 个在跑轮次异常结束）' : '') +
          ' ｜ inflight=' + pending.length);
      }
      return { converged: true, inflight: pending.length, rejected };
    }, (e) => {
      const why = e && e.message ? e.message : String(e);
      diag('dispose converge failed: ' + why);
      if (log.warn) log.warn('[dsh-dialog-ledger] 卸载等待在跑轮次失败: ' + why);
      return { converged: false, inflight: pending.length, rejected: 0, error: why };
    });
    return disposePromise;
  };
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose);
    return undefined;
  }
  // 兜底：脱离 DSH 的裸跑 / 测试环境，仍然返回一个可调用的清理函数。
  // ★ re3：该函数返回 Promise（等 in-flight tick 收敛），裸跑调用方应 await（不 await 也不会更差）。
  return dispose;
}

/**
 * 导出给测试用。
 *
 * `resetPeriodicThrottle`：把"对账/补记链"的进程内节流打回初始态。
 * @why 需要它：周期节流（RECONCILE_INTERVAL_MS / BACKFILL_INTERVAL_MS）是模块级状态，
 *      同一进程里连跑多个用例时，第二个 root 会因"刚算过"而拿不到 run-report ——
 *      用例就会互相依赖执行顺序。测试用它显式复位，让每个用例都从"首轮"开始。
 * @why 不导出给生产：生产进程**不应该**重置节流；它只服务测试。
 */
export const __test__ = {
  readConfig,
  resolveRoot,
  clampInt,
  DEFAULTS,
  /** ★ m-01：用桩 Schema 验证 Config 的 27 键/默认值（不必真装 schemastery）。 */
  buildConfigSchema,
  /** ★ re3（ARCH-03/Config）：可注入 importer 的 schema 解析器（验证宿主名优先/裸名回退/降级）。 */
  loadSchemaModule,
  /** ★ re3（ARCH-04）：当前挂载健康度快照（undefined/null = 尚未 apply）。 */
  peekMountHealth() { return snapshotMountHealth(); },
  /** ★ re3（ARCH-04）：测试用——清空挂载健康度（避免用例间串场）。 */
  resetMountHealth() { moduleMountHealth = null; },
  /** ★ K-25：测试用——缩短 apply 侧"取锁重试间隔"（生产恒 30s；传 0 恢复）。 */
  setLockRetryMs(ms) { lockRetryMsOverride = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0; },
  /** ★ P1-03：两条预算路径共用的"补未轮到游标"helper（单测直接验行为）。 */
  fillUnvisitedCursors,
  /** ★ P1-04：建索引缓存（单测用：可直接对临时台账验常驻上限判定）。 */
  ensureLedgerIndex,
  /** ★ m-01：当前进程解析到的 Config（undefined = 两个候选都解析不到，属预期降级分支）。 */
  getConfigSchema() { return Config; },
  /** ★ re3（ARCH-03）：实际解析成功的模块名（'' = 降级；@deepseek-ai/schemastery / schemastery）。 */
  getConfigSpecifier() { return schemaSpecifier; },
  /** ★ P1-04：测试用——下调常驻缓存上限（传 0/负数恢复默认）。 */
  setLedgerCacheCaps(maxResidentRows) {
    ledgerCacheCaps = {
      maxResidentRows: Number.isInteger(maxResidentRows) && maxResidentRows > 0
        ? maxResidentRows
        : LEDGER_CACHE_MAX_RESIDENT_ROWS,
    };
  },
  /** ★ P1-04：测试用——清空常驻缓存（让下一次 ensureLedgerIndex 重新构建）。 */
  clearLedgerCache() { ledgerCache = null; },
  /** ★ P1-04：测试用——读当前缓存状态（不改变它）。 */
  peekLedgerCache() {    if (!ledgerCache) return null;
    return {
      rowCount: Number(ledgerCache.rowCount) || 0,
      ephemeral: ledgerCache.ephemeral === true,
      records: Array.isArray(ledgerCache.records) ? ledgerCache.records.length : 0,
      knownCodes: ledgerCache.knownCodes instanceof Set ? ledgerCache.knownCodes.size : 0,
      seenTurns: ledgerCache.seenTurns instanceof Set ? ledgerCache.seenTurns.size : 0,
    };
  },
  /** ★ m7：测试用——索引退避状态（读）+ 复位。 */
  peekIndexBackoff() { return { ...moduleIndexBackoff }; },
  resetIndexBackoff() { moduleIndexBackoff = { fails: 0, untilMs: 0 }; },
  resetPeriodicThrottle() {
    lastReconcileAtMs = 0;
  },
};
