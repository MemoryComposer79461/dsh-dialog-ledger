/**
 * @file _runner.mjs
 * @role v0.5 验收的极简测试运行器：串行跑用例、测内存峰值、输出机器可读 JSON + 人读表格。
 *
 * 为什么不用 node:test：
 *   ① 审计要求「每条判据一个能失败的测试」并且要能按判据统计红/绿/未覆盖；
 *   ② 资源纪律要求跑前打印可用内存、<0.5GB 时只写不跑 —— 运行器可以统一拦截；
 *   ③ 报告要机器可读（_results/*.json），node:test 的 TAP 还得二次解析。
 *
 * 用法：每个测试文件末尾 `await main(import.meta.url)`。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_FREE_MB = 500; // Lead 纪律：<0.5GB 只写不跑

export function freeMemMB() {
  return Math.round(os.freemem() / (1024 * 1024));
}

export function memLine() {
  return `可用内存 ${freeMemMB()} MB（阈值 ${MIN_FREE_MB} MB；本机 7.7GB，全量会打崩，故串行+小素材）`;
}

export class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = 'AssertionError'; this.assertion = true; }
}

/** 资源纪律等原因不跑：标记 SKIPPED（报告里必须写"未覆盖原因"）。 */
export class SkipError extends Error {
  constructor(msg) { super(msg); this.name = 'SkipError'; this.skip = true; }
}

export function skip(msg) { throw new SkipError(msg); }

export function expect(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}

export function expectEqual(actual, expected, msg) {
  if (actual !== expected) throw new AssertionError(`${msg}（实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}）`);
}

export function expectIncludes(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) throw new AssertionError(`${msg}（未包含 ${JSON.stringify(needle)}）`);
}

/** 单个用例的执行记录。 */
export class Runner {
  constructor({ name, target }) {
    this.name = name;
    this.target = target;
    this.cases = [];
    this.startedAt = new Date().toISOString();
  }

  /** 注册用例：{ id, title, criteria:[], fn: async () => {...}, timeoutMs?, optional? } */
  add(def) {
    this.cases.push(def);
    return this;
  }

  async run({ only = null } = {}) {
    const freeBefore = freeMemMB();
    if (freeBefore < MIN_FREE_MB) {
      const skipped = this.cases.map((c) => ({
        id: c.id, title: c.title, criteria: c.criteria || [], status: 'SKIPPED',
        evidence: `资源纪律：可用内存 ${freeBefore}MB < ${MIN_FREE_MB}MB，只写不跑（Lead 纪律）`,
        durationMs: 0, peakRssMB: freeBefore,
      }));
      this.results = skipped;
      return this.summary(skipped, freeBefore);
    }
    const out = [];
    for (const c of this.cases) {
      if (only && !only.includes(c.id) && !(c.criteria || []).some((x) => only.includes(x))) continue;
      process.stdout.write(`\n[RUN ] ${c.id} ${c.title}\n`);
      const t0 = Date.now();
      let peak = 0;
      const timer = setInterval(() => {
        const rss = process.memoryUsage().rss / (1024 * 1024);
        if (rss > peak) peak = rss;
      }, 120);
      timer.unref?.();
      let status = 'PASS';
      let evidence = '';
      try {
        await withTimeout(c.fn(), c.timeoutMs || 180_000);
        evidence = '断言通过';
      } catch (e) {
        if (e && e.skip) {
          status = 'SKIPPED';
          evidence = e.message;
        } else {
          status = e && e.assertion ? 'FAIL' : 'ERROR';
          evidence = (e && (e.message || String(e))) || '未知异常';
          if (status === 'ERROR') evidence = '脚本/前置异常: ' + evidence;
        }
      } finally {
        clearInterval(timer);
        const rss = process.memoryUsage().rss / (1024 * 1024);
        if (rss > peak) peak = rss;
      }
      const rec = {
        id: c.id, title: c.title, criteria: c.criteria || [], status,
        evidence: String(evidence).slice(0, 2000),
        durationMs: Date.now() - t0, peakRssMB: Math.round(peak),
      };
      out.push(rec);
      process.stdout.write(`[${status}] ${c.id}（${rec.durationMs}ms, RSS峰 ${rec.peakRssMB}MB）${status === 'PASS' ? '' : ' :: ' + rec.evidence}\n`);
    }
    this.results = out;
    return this.summary(out, freeBefore);
  }

  summary(results, freeBefore) {
    const count = (s) => results.filter((r) => r.status === s).length;
    const summary = {
      cases: results.length,
      pass: count('PASS'), fail: count('FAIL'), error: count('ERROR'), skipped: count('SKIPPED'),
      criteriaCovered: [...new Set(results.filter((r) => r.status !== 'SKIPPED').flatMap((r) => r.criteria))].sort(),
    };
    this.summaryObj = summary;
    this.freeBefore = freeBefore;
    return summary;
  }

  payload() {
    return {
      module: this.name,
      target: this.target,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      freeMemBeforeMB: this.freeBefore,
      freeMemAfterMB: freeMemMB(),
      summary: this.summaryObj,
      results: this.results,
    };
  }

  writeOut(outFile) {
    if (!outFile) return;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(this.payload(), null, 2) + '\n', 'utf8');
    console.log(`\n结果已写入 ${outFile}`);
  }

  printSummary() {
    const s = this.summaryObj;
    console.log(`\n=== ${this.name}：PASS ${s.pass} / FAIL ${s.fail} / ERROR ${s.error} / SKIPPED ${s.skipped}（共 ${s.cases} 用例）`);
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AssertionError(`用例超时（>${ms}ms）`)  ), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 各测试文件统一的入口：解析 --out/--only，跑完写 JSON、打印摘要、返回退出码。 */
export async function main(moduleUrl, { name, target, build }) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const a = args.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : null;
  };
  const out = get('out');
  const only = get('only') ? get('only').split(',') : null;
  const runner = new Runner({ name, target });
  await build(runner);
  console.log(memLine());
  await runner.run({ only });
  runner.printSummary();
  if (out) runner.writeOut(out);
  // ★ v1.0.0-re2（准入审计 P0-04 同型缺陷）：main() 的返回码**必须**落到进程退出码上。
  //   此前 4 个调用方（验收-CH/INV/P1/REC）都是 `await main(...)` 丢掉返回值 → 有红也 exit 0，
  //   发布门/CI 会被直接骗过。修在这里一处，所有调用方一起生效；调用方再显式透传也不冲突。
  const code = runner.summaryObj.fail + runner.summaryObj.error === 0 && runner.summaryObj.skipped === 0 ? 0 : 1;
  process.exitCode = code;
  return code;
}

/** 插件根目录（测试文件都在 <root>/docs|P0验收 下，向上找 index.js）。 */
export function findPluginRoot(fromUrl) {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'index.js')) && fs.existsSync(path.join(dir, 'lib'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到插件根目录（index.js + lib/）');
}

export { fs, path, os, pathToFileURL };
