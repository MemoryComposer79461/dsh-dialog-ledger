/**
 * @file _汇总-P0-3.mjs
 * @role 把「跑压测.mjs」的原始结果与 `_原始-<档>MB.json` 汇总成一份机器可读的 P0-3 验收汇总：
 *       含代码快照（codeSha256）、RSS 曲线与逐段比值、套件断言、未覆盖清单、36MB 外推口径。
 *
 * 为什么单独一层：套件产出的 `结果-*.json` 是「一次运行」的原始记录，而交付验收需要一份
 * 「本机结论 + 未覆盖披露 + 快照口径」的汇总；两者分开，原始记录不被加工，汇总可复现。
 *
 * 纪律：只读 `压测结果/` 下的结果文件，只写 `压测结果/汇总-TSG-02-v0.5.0-snapshot.json`；
 *       不 import 被测代码、不跑测试、不联网。
 *
 * 用法：node docs/验收-v0.5/_汇总-P0-3.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '压测结果');
const RESULT_FILE = path.join(OUT_DIR, '结果-TSG-02-20261109-185357.json');

const r = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
const raw = {};
for (const mb of [1, 4, 16]) raw[mb] = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `_原始-${mb}MB.json`), 'utf8'));

const peak = r.rssPeakByTier; // { '1MB': 65, '4MB': 95, '16MB': 225 }
const ratio = (a, b) => Number((peak[`${b}MB`] / peak[`${a}MB`]).toFixed(2));
const step = (a, b) => {
  const sizeRatio = b / a;
  const peakRatio = ratio(a, b);
  return { fromMB: a, toMB: b, sizeRatio, peakRatio, growthLessThanSizeMultiple: peakRatio < sizeRatio, ok: peakRatio < sizeRatio };
};
const everyTierLE600 = r.tiers.every((t) => Number(t.peakRssMB) <= 600);

const summary = {
  schema: 'v0.5-p0-3-summary/1',
  title: 'P0-3 内存有界验收汇总（TSG-02 · v0.5.0-snapshot）',
  generatedAt: new Date().toISOString(),
  generatedBy: 'docs/验收-v0.5/_汇总-P0-3.mjs',
  generatedFrom: ['结果-TSG-02-20261109-185357.json', '_原始-1MB.json', '_原始-4MB.json', '_原始-16MB.json'],
  command: 'node docs\\验收-v0.5\\跑压测.mjs --tiers=1,4,16',
  scope: '仅 P0-3 本机内存曲线（1/4/16MB）；36MB 明确未跑（正式版闸门，见 uncovered[0]）',

  // ★ 快照口径：所有数字只对应这份 codeSha256
  codeSnapshot: {
    runStartedAt: r.startedAt,
    runFinishedAt: r.finishedAt,
    version: r.version,
    files: r.codeSha256,
    note: '本汇总只对应上述代码快照；integration 轨道此后可能改动 index.js，不能当作最终版代码的结论。',
  },
  host: {
    hostname: r.hostname, platform: r.platform, arch: r.arch, node: r.node,
    cpuCores: r.cpuCores, totalMemMB: r.totalMemMB, freeMemMBAtStart: r.freeMemMBAtStart, heapLimitMB: r.heapLimitMB,
  },

  tiers: r.tiers.map((t) => ({
    tierMB: t.tierMB,
    pass: t.pass,
    peakRssMB: t.peakRssMB,
    durationMs: t.durationMs,
    session: {
      turns: t.session.turns, uncompressedBytes: t.session.uncompressedBytes, frames: t.session.frames,
      genPeakRssMB: t.session.genPeakRssMB, genOk: t.session.genOk, verifyOk: t.session.verifyOk,
    },
    ingest: t.ingest,
    assertions: t.assertions,
  })),

  rssCurve: {
    unit: 'MB',
    points: { '1MB': peak['1MB'], '4MB': peak['4MB'], '16MB': peak['16MB'] },
    perStep: [step(1, 4), step(4, 16)],
    span: { fromMB: 1, toMB: 16, sizeRatio: 16, peakRatio: ratio(1, 16), growthLessThanSizeMultiple: ratio(1, 16) < 16, ok: ratio(1, 16) < 16 },
    everyTierLE600,
    notLinear: r.assertions.memNotLinear,
    detail: r.assertions.memDetail,
  },

  suiteAssertions: r.assertions,
  pass: r.pass,
  exitCode: r.pass ? 0 : 1,

  // ★ 未覆盖（快照版交付必须披露；36MB 必须是第一行）
  uncovered: [
    {
      id: '36MB-tier',
      title: '36MB 档（P0-3 · 正式版闸门 G1）',
      status: '未覆盖（本机明确放弃，非失败）',
      reason: '本机提交上限约 9.48 GB 是硬顶（实测 TotalVirtualMemorySize≈9.71GB）；页面文件固定 1875/2048 MB（AllocatedBaseSize=1875MB，峰值仅 226MB）；机主机器重启即回滚，靠重启扩页面文件不成立，不许建议重启。快照版（0.5.0-snapshot）裁定今晚不做 36MB。',
      action: '异机实测（见 docs/验收-v0.5/异机压测交接单.md）；外推值不得代替实测。',
    },
    {
      id: 'INV-13-cancel',
      title: '可取消（运行中取消，返回 cancelled:true / committedBatches:k）',
      status: '未覆盖（P0.json 实测 FAIL）',
      reason: '当前快照无取消实现：index.js 与 lib/*.js 中 cancel / AbortSignal / signal / aborted 关键字命中数为 0；P0.json 的 P0-3-cancel 实测 400ms 中止后仍跑满 8626ms。',
      evidence: 'docs/验收-v0.5/_results/P0.json → P0-3-cancel status=FAIL, durationMs=9046, evidence=★ P0-3 未修复：AbortSignal 未生效 —— 400ms 中止后仍跑满 8626ms（stat.cancelled/aborted 均无；stat={"written":1000,"scanned":1}）',
      gate: '正式版闸门 G1 要求；v0.5.0-snapshot 不满足。',
    },
    {
      id: 'INV-14-resume',
      title: 'kill -9 后重启续跑（无重复、无整会话遗漏、resumeFrom 正确）',
      status: '未覆盖（P0.json 实测 FAIL）',
      reason: '当前快照重启被残留锁挡住：P0.json 的 P0-3-resume 实测 lockSkipped=true（锁文件未接管），不能从已提交批次续。',
      evidence: 'docs/验收-v0.5/_results/P0.json → P0-3-resume status=FAIL, durationMs=859, evidence=★ P0-3 未修复：kill -9 后立即重启被残留锁挡住（lockSkipped=true；锁文件未接管）→ 不能从已提交批次续',
      gate: '正式版闸门 G1 要求；v0.5.0-snapshot 不满足。',
    },
    {
      id: 'INV-11-batch-evidence',
      title: '逐批预算证据（batches[] / resumeFrom / heapUsed 采样）',
      status: '未覆盖',
      reason: '当前快照无 batches[] 数组、无 resumeFrom、无 heapUsed 采样；仅有 stat.eventBatches 计数（字段名不同，不能替代契约要求的 batches[] 明细）。',
      gate: '正式版闸门 G1 要求；v0.5.0-snapshot 不满足。',
    },
  ],

  // ★ 36MB 外推：只作说明，不得当结论
  extrapolation36MB: {
    value: '约 350–450 MB',
    statement: '按本机曲线外推，36MB 档 RSS 峰值约 350–450MB，与套件 384MB 堆上限接近甚至可能越界，因此必须异机实测，不得用外推值代替实测。',
    method: '取 4→16MB 段斜率：ΔRSS/ΔMB=(225−95)/(16−4)=10.83MB/MB → 36MB≈225+20×10.83≈441MB；区间 350–450MB 覆盖斜率不确定性。',
    mustNotUseAsConclusion: true,
  },

  artifacts: {
    resultJson: '压测结果/结果-TSG-02-20261109-185357.json',
    suiteReport: '压测结果/报告-TSG-02-20261109-185357.md',
    rawWorkers: ['压测结果/_原始-1MB.json', '压测结果/_原始-4MB.json', '压测结果/_原始-16MB.json'],
    smokeRun: ['压测结果/冒烟-单档/结果-TSG-02-20261109-185344.json', '压测结果/冒烟-单档/报告-TSG-02-20261109-185344.md'],
    humanReport: '压测结果/验收报告-TSG-02-v0.5.0-snapshot.md',
  },
  companionDocs: {
    handoff: 'docs/验收-v0.5/异机压测交接单.md',
    machineSplit: 'docs/验收-v0.5/本机与异机分工.md',
  },
};

const outFile = path.join(OUT_DIR, '汇总-TSG-02-v0.5.0-snapshot.json');
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log('已写出 ' + outFile);
console.log(JSON.stringify({
  rss: summary.rssCurve.points,
  perStep: summary.rssCurve.perStep.map((s) => `${s.fromMB}→${s.toMB}MB 体积×${s.sizeRatio} / RSS×${s.peakRatio}`),
  span: `1→16MB 体积×16 / RSS×${summary.rssCurve.span.peakRatio}`,
  everyTierLE600,
  pass: summary.pass,
  uncoveredCount: summary.uncovered.length,
}, null, 2));
