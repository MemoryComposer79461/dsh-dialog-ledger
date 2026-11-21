/**
 * @file 跑测试.mjs
 * @role 带**内存看护**与**进程硬上限**的测试启动器 —— 2026-11-09 两次 Harness 崩溃后的护栏。
 *       v1.0.0-re3 起加**0 skip** 闸门；v1.0.0-re4 起把退役登记对账从"比红数"升级为**逐条用例名集合对账**
 *       （名册：`docs\退役登记.json`，42 条逐条；人读：`测试退役清单-v0.9.1-re1.md §K`）。
 *
 * @why 为什么要这层壳：
 *   1) `node --test docs/自测-*.mjs` 默认按 CPU 核数**并行**跑测试文件，
 *      多个进程峰值叠加 —— "跑全量"比"跑单文件"危险得多，这是崩溃的直接推手之一。
 *   2) 测试进程没有堆上限时，一个失控用例会一路吃内存，
 *      直到 Windows 撞"提交上限"把**宿主**杀掉（历史现象：Harness 整个消失）。
 *      本机页面文件原来只有 2 GB，提交上限 9.65 GB 而常驻已用 8.8 GB → 余量 0.84 GB。
 *   3) 所以：**先看余量再跑**，跑的时候给测试进程设硬上限 ——
 *      要炸就炸测试自己（JS 堆 OOM，退出码非 0），不再拉整机下水。
 *   4) v1.0.0-re3（E-P0-9 异机不可复现）：把"红数 = 登记退役数""0 skip"写进摘要并当门用 ——
 *      否则换台机器红数变了没人知道（三份审计在 43/42/44 三个红数上打架，正是此因）。
 *   5) v1.0.0-re4（审计残余：清单只有分组计数）：
 *      **"红数 == 42"不等于"没有未登记红"**——41 条登记 + 1 条回归 + 1 条登记项转绿也能凑出 42。
 *      所以闸门②改为**逐条名字集合差**：
 *        measured = spec 明细段（`test at <文件>:<行>:1` + 紧邻 `✖ <用例名>`）里的失败用例名集合；
 *        registered = `docs\退役登记.json` 的 cases[].name。
 *        多出名字（measured − registered）→ 未登记红点，阻断；
 *        少了名字（registered − measured）→ 已销号未同步，只提示不拦；
 *        measured 条数 ≠ 汇总 fail 数 → 解析器失效，**fail-closed** 阻断（宁可误拦，不许假绿）；
 *        对账结果（含 failNames 逐条名单）落盘成 JSON，路径打印在屏幕上。
 *
 * 用法：
 *   node docs/跑测试.mjs                       # 跑 docs/自测-*.mjs 全量（串行）+ 退役登记逐条对账
 *   node docs/跑测试.mjs docs/自测-index.mjs    # 跑指定文件（不做全量对账）
 *   node docs/跑测试.mjs --force               # 忽略余量检查（自己承担风险）
 *   node docs/跑测试.mjs --heap=512            # 改堆上限（MB，默认 384）
 *
 * 退出码：非 0 = 有失败 / 被看护拦下；具体：
 *   0 = 全绿，且（全量模式）逐条对账一致；
 *   1 = 用例失败（原样透传子进程退出码）；**42 条已登记退役正常也是 1**；
 *   3 = 余量不足拒绝启动；4 = 没找到测试文件；5 = 测试进程启动失败；
 *   6 = **看护闸门**：干净包出现 skip / 出现未登记红点 / 失败明细解析失效（fail-closed）。
 *   ★ 最终退出码 = `guardCode || 子进程退出码`（闸门优先）：
 *     否则"42 红时子进程恒 exit 1"会把"多出未登记红点"糊成 1，与"预期 42 红"不可区分
 *     —— 这正是 v1.0.0-re3 审计指出的"闸门② exit 6 不可达"bug，re4 修正。
 *
 * ⚠️ 本文件**只**用于跑测试，不参与插件运行；插件本体不 import 它。
 *    （对账函数 `parseFailCases` / `verifyRegistry` / `evaluateRetired` 导出，只为自测可 import。）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

/** 余量下限（字节）：低于这个数就不跑，避免把宿主推到提交上限。 */
const MIN_FREE_BYTES = 900 * 1024 * 1024;

/**
 * 退役登记名册（机读，42 条逐条；**唯一事实源**，勿再在代码里硬编码 42）。
 *
 * @why 数字对账挡不住"41 登记 + 1 回归 + 1 销号 = 42"的凑数；必须按用例名逐条比集合。
 * @口径 `docs\退役登记.json` schema=`dsh-retired-tests/1`：A 14 + B 2 + C 6 + D 3 + E 2 + F 6 + G 9 = 42；
 *       人读版见 `测试退役清单-v0.9.1-re1.md §K`（append-only；§A–§G 历史原文保留）。
 * @maintenance 某条销号/新增时**先改名册**（并与 §K 同步），闸门会按新名册判"多出/缺少"。
 */
const REGISTRY_FILE = path.join(HERE, '退役登记.json');

/** spec reporter 的失败明细段：`test at <文件>:<行>:<列>`，下一行 `✖ <用例名> (12.3ms)`。 */
const RE_TEST_AT = /^test at (.+):(\d+):(\d+)\s*$/;
const RE_X_NAME = /^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/;

/**
 * 从 spec reporter 机读输出里解析失败用例（文件、test-at 行、用例名）。
 * 只认"`test at` 行 + 紧邻下一行 `✖ 名字`"这一对，避免把正文内联 `✖` 或段标题 `✖ failing tests:` 算进来。
 * 用例名做**去重主键**（spec 原文，去掉 ` (12.3ms)` 尾巴）；同名两条视为同一主键（由调用方用 fail 数兜底）。
 *
 * @param {string} raw spec reporter 输出全文（stdout 或 --test-reporter-destination 文件）
 * @returns {{file:string,line:number,name:string}[]} 失败用例（按出现顺序，名字去重）
 */
export function parseFailCases(raw) {
  const lines = String(raw == null ? '' : raw).split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const at = RE_TEST_AT.exec(lines[i]);
    if (!at) continue;
    const nameLine = i + 1 < lines.length ? RE_X_NAME.exec(lines[i + 1]) : null;
    if (!nameLine) continue; // 明细段里 test at 与 ✖ 必相邻；配不上就是格式变了 → 该条不计（靠 fail 数 fail-closed）
    const file = at[1].replace(/\\/g, '/');
    const line = Number(at[2]);
    const name = nameLine[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ file, line, name });
  }
  return out;
}

/**
 * 名册结构性自检（不通过一律 fail-closed，不拿坏名册对账）。
 * @param {any} registry JSON.parse 的名册对象
 * @returns {string[]} 问题列表（空 = 合格）
 */
export function verifyRegistry(registry) {
  const problems = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return ['名册不是对象'];
  if (registry.schema !== 'dsh-retired-tests/1') problems.push('schema 不是 dsh-retired-tests/1（实际 ' + registry.schema + '）');
  if (!Array.isArray(registry.cases) || registry.cases.length === 0) return problems.concat(['cases 不是非空数组']);
  const cases = registry.cases;
  const counts = registry.counts && typeof registry.counts === 'object' ? registry.counts : {};
  if (counts.total !== cases.length) problems.push('counts.total=' + counts.total + ' ≠ cases.length=' + cases.length);
  const byGroup = {};
  const ids = new Set();
  const names = new Set();
  for (const c of cases) {
    const tag = (c && c.id) || JSON.stringify(c);
    if (!c || typeof c !== 'object') { problems.push('存在非对象登记项'); continue; }
    if (!c.id) problems.push('存在无 id 的登记项');
    else if (ids.has(c.id)) problems.push('id 重复: ' + c.id);
    else ids.add(c.id);
    if (!c.group) problems.push('存在无 group 的登记项: ' + tag);
    else byGroup[c.group] = (byGroup[c.group] || 0) + 1;
    if (typeof c.file !== 'string' || !c.file) problems.push('file 缺失: ' + tag);
    if (!Number.isInteger(c.line) || c.line <= 0) problems.push('line 不是正整数: ' + tag);
    if (typeof c.name !== 'string' || !c.name.trim()) problems.push('用例名为空: ' + tag);
    else if (names.has(c.name)) problems.push('用例名重复: ' + c.name);
    else names.add(c.name);
  }
  for (const g of Object.keys(byGroup)) if (counts[g] !== byGroup[g]) problems.push('组 ' + g + ' 的 counts=' + counts[g] + ' ≠ cases 实际 ' + byGroup[g]);
  for (const g of Object.keys(counts)) if (g !== 'total' && !(g in byGroup)) problems.push('counts 声明了空组 ' + g);
  return problems;
}

/**
 * 闸门②：逐条名集合对账（并在落盘 JSON 里留下 failNames 逐条名单）。
 *
 * 判定（全量模式）：
 *   1. 名册读不出/结构坏 → 6；2. 汇总行解析不出 fail 数 → 6（fail-closed）；
 *   3. parseFailCases 条数 ≠ fail 数 → 6（解析器失效/同名用例，fail-closed）；
 *   4. measured − registered 非空 → 6（未登记红点，打印前 5 条）；
 *   5. registered − measured 非空 → 只提示（已销号未同步名册，不拦）。
 *
 * @param {{file:string,line:number,name:string}[]} measured parseFailCases 结果
 * @param {{tests:number|null,pass:number|null,fail:number|null,skipped:number|null,cancelled?:number|null,todo?:number|null}} stats
 * @param {{registry?:any, registryError?:string|null, fullMode?:boolean, reconcileDir?:string, now?:number}} [opts]
 * @returns {{guardCode:number, parsed:number, registered:number, unexpected:object[], missing:object[], jsonFile:string|null, ok:boolean}}
 */
export function evaluateRetired(measured, stats, opts = {}) {
  const fullMode = opts.fullMode !== false;
  const reconcileDir = opts.reconcileDir || os.tmpdir();
  const now = opts.now || Date.now();
  const result = { guardCode: 0, parsed: measured.length, registered: 0, unexpected: [], missing: [], jsonFile: null, ok: false };
  const registry = opts.registry || null;
  const registryError = opts.registryError || null;
  const failCount = stats && stats.fail !== null && stats.fail !== undefined ? Number(stats.fail) : null;

  if (!fullMode) return result; // 指定文件模式：不做全量对账（与 re3 行为一致）

  // ① 名册可用性（fail-closed）
  let registryOk = true;
  if (!registry) {
    console.error('[看护] ✗ 闸门②失败：退役登记名册读不出（' + REGISTRY_FILE + '）' + (registryError ? '：' + registryError : '') + ' —— fail-closed。');
    registryOk = false;
  } else {
    const problems = verifyRegistry(registry);
    if (problems.length) {
      console.error('[看护] ✗ 闸门②失败：退役登记名册结构不合格（' + REGISTRY_FILE + '）：\n         - ' + problems.slice(0, 8).join('\n         - '));
      registryOk = false;
    } else {
      result.registered = registry.cases.length;
      console.log('[看护] 退役登记: ' + result.registered + ' 条（' + REGISTRY_FILE + '；schema=' + registry.schema + '，baseline=' + registry.baseline + '）');
      const g = {};
      for (const c of registry.cases) g[c.group] = (g[c.group] || 0) + 1;
      console.log('       分组: ' + Object.keys(g).sort().map((k) => k + ' ' + g[k]).join(' + ') + ' = ' + result.registered);
    }
  }

  // ② 解析条数 vs fail 数（解析器失效必须看得见，不许静默通过）
  let parseOk = true;
  if (failCount === null) {
    console.error('[看护] ✗ 闸门②失败：无法解析测试汇总行（fail=null，机读报告缺失或格式变了）—— 逐条对账不可判，fail-closed。');
    parseOk = false;
  } else if (result.parsed !== failCount) {
    console.error('[看护] ✗ 闸门②失败：spec 明细解析出 ' + result.parsed + ' 条失败用例名，但汇总 fail=' + failCount +
      ' —— 解析器失效或用例同名（名字是主键），fail-closed。');
    parseOk = false;
  }

  // ③ 集合差
  if (registryOk) {
    const regSet = new Set(registry.cases.map((c) => c.name));
    const measuredSet = new Set(measured.map((c) => c.name));
    result.unexpected = measured.filter((c) => !regSet.has(c.name));
    result.missing = registry.cases.filter((c) => !measuredSet.has(c.name));

    if (result.unexpected.length) {
      console.error('[看护] ✗ 闸门②失败：**' + result.unexpected.length + ' 条未登记红点**（比名册多出来的失败用例）——要么是回归，要么是清单漏登记：');
      for (const c of result.unexpected.slice(0, 5)) console.error('         ✖ ' + c.name + '  (' + c.file + ':' + c.line + ')');
      if (result.unexpected.length > 5) console.error('         … 其余 ' + (result.unexpected.length - 5) + ' 条见落盘 JSON');
    }
    if (result.missing.length && parseOk) { // 解析失真时不提示"未红"，否则会误导销号
      console.log('[看护] 对账ℹ 名册里 ' + result.missing.length + ' 条本次未红（已销号未同步名册？不拦，但请同步 §K 与 退役登记.json）：');
      for (const c of result.missing.slice(0, 5)) console.log('         ✔ ' + c.id + ' ' + c.name);
      if (result.missing.length > 5) console.log('         … 其余 ' + (result.missing.length - 5) + ' 条见落盘 JSON');
    }
    if (parseOk && registryOk && result.unexpected.length === 0 && result.missing.length === 0) {
      result.ok = true;
      console.log('[看护] 对账✓ 红数 ' + failCount + ' 与登记 ' + result.registered + ' 条**逐名相等**（未登记红点 0、销号 0）—— 这才叫"无未登记红"。');
    } else if (parseOk && registryOk && result.unexpected.length === 0) {
      console.log('[看护] 对账ℹ 红数 ' + failCount + ' 条全部已登记，但名册有 ' + result.missing.length + ' 条没红（见上）—— 不拦。');
    }
  }

  // ④ 落盘：红名单逐条（与 report 同目录 = 系统临时目录；**不随 REPORT_FILE 删除**）
  const payload = {
    schema: 'dsh-retired-tests-report/1',
    generatedAt: new Date(now).toISOString(),
    baseline: registry && registry.baseline ? registry.baseline : null,
    registered: result.registered,
    stats: stats || null,
    parsed: result.parsed,
    failNames: measured.map((c) => c.name),
    cases: measured,
    unexpected: result.unexpected,
    missing: result.missing.map((c) => ({ id: c.id, group: c.group, name: c.name, listItem: c.listItem })),
    ok: result.ok,
  };
  const jsonFile = path.join(reconcileDir, 'dsh-跑测试-对账-' + process.pid + '-' + now.toString(36) + '.json');
  try {
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    result.jsonFile = jsonFile;
    console.log('[看护] 红名单已落盘: ' + jsonFile + '（failNames ' + measured.length + ' 条 / 未登记 ' + result.unexpected.length + ' / 销号提示 ' + result.missing.length + '）');
  } catch (e) {
    console.error('[看护] ✗ 闸门②失败：对账证据落盘失败（' + jsonFile + '）：' + e.message + ' —— fail-closed。');
    registryOk = false;
  }

  if (!registryOk || !parseOk || result.unexpected.length) result.guardCode = 6;
  return result;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const resolved = path.resolve(process.argv[1]);
  try {
    if (import.meta.url === pathToFileURL(resolved).href) return true;
    // 兜底：符号链接/盘符大小写等 URL 不一致时，按 realpath 同一文件判定
    return fs.realpathSync(resolved) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const heapArg = argv.find((a) => a.startsWith('--heap='));
  const heapMB = heapArg ? Math.max(64, parseInt(heapArg.slice('--heap='.length), 10) || 384) : 384;
  const files = argv.filter((a) => !a.startsWith('--'));

  const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2);

  const free = os.freemem();
  const total = os.totalmem();
  console.log('[看护] 物理内存: ' + gb(free) + ' GB 可用 / ' + gb(total) + ' GB 总量');
  console.log('[看护] 测试进程堆上限: ' + heapMB + ' MB ；测试文件串行执行（--test-concurrency=1）');

  if (free < MIN_FREE_BYTES && !force) {
    console.error(
      '[看护] ✗ 拒绝启动：可用物理内存 ' + gb(free) + ' GB < 下限 ' + gb(MIN_FREE_BYTES) + ' GB。\n' +
      '        这是防止再次撞穿 Windows 提交上限、把宿主进程杀掉。\n' +
      '        处理：关掉浏览器/WPS 等应用；或在系统设置里把页面文件调大后重启。\n' +
      '        确需强行运行：加 --force（后果自负）。'
    );
    process.exit(3);
  }

  // 目标：默认跑 docs/自测-*.mjs
  let targets = files;
  const fullMode = targets.length === 0;
  if (fullMode) {
    targets = fs.readdirSync(path.join(PLUGIN_ROOT, 'docs'))
      .filter((n) => /^自测-.*\.mjs$/.test(n))
      .sort()
      .map((n) => path.join('docs', n));
  }
  if (targets.length === 0) {
    console.error('[看护] 没找到要跑的测试文件');
    process.exit(4);
  }

  // 机读报告：子进程**自己**把 spec 输出再写一份到临时文件（不走管道 → 受限沙箱下不会 EPERM）。
  // 这样看护既能实时显示（stdout），又能事后解析 tests/pass/fail/skipped 与**逐条失败用例名**做对账。
  const REPORT_FILE = path.join(os.tmpdir(), 'dsh-跑测试-report-' + process.pid + '-' + Date.now().toString(36) + '.txt');

  const nodeFlags = [
    '--max-old-space-size=' + heapMB,
    '--max-semi-space-size=16', // 新生代上限：防止大量短命对象把堆撑爆
    '--test-concurrency=1',     // ★ 关键：串行跑测试文件，避免多进程峰值叠加
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
    '--test-reporter-destination=' + REPORT_FILE,
    ...targets,
  ];

  // 退役登记名册：全量模式才读（指定文件模式不做全量对账）；读不出不退出，交给闸门② fail-closed。
  let registry = null;
  let registryError = null;
  if (fullMode) {
    try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) { registryError = e.message; }
  }

  console.log('[看护] 目标 ' + targets.length + ' 个测试文件' + (fullMode ? '（全量模式：做退役登记逐条对账）' : '（指定文件模式：不做全量对账）'));
  console.log('       ' + targets.slice(0, 4).join(' ') + (targets.length > 4 ? ' …' : ''));
  console.log('');

  const t0 = Date.now();
  const child = spawn(process.execPath, nodeFlags, {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit', // ★ 必须 inherit：受限沙箱下捕获子进程管道会 EPERM
    windowsHide: true,
  });

  child.on('error', (e) => {
    console.error('[看护] 启动测试进程失败: ' + e.message);
    process.exit(5);
  });

  child.on('exit', (code, signal) => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const freeAfter = os.freemem();
    let raw = '';
    try { raw = fs.readFileSync(REPORT_FILE, 'utf8'); } catch { /* 报告文件没写成（如启动即崩）：按空处理，闸门② fail-closed */ }
    const stats = parseTestSummary(raw);
    const measured = parseFailCases(raw);

    console.log('');
    console.log('[看护] 结束: exit=' + code + (signal ? ' signal=' + signal : '') + ' 用时 ' + sec + 's');
    console.log('[看护] 物理内存: ' + gb(freeAfter) + ' GB 可用（跑完）');
    if (stats.tests !== null) {
      console.log('[看护] 用例统计: tests=' + stats.tests + ' pass=' + stats.pass + ' fail=' + stats.fail +
        ' skipped=' + stats.skipped + ' cancelled=' + stats.cancelled + ' todo=' + stats.todo +
        '（机读报告: ' + REPORT_FILE + '）');
      console.log('[看护] 失败明细: 解析到 ' + measured.length + ' 条失败用例名（spec 明细段 `test at` + `✖` 配对）');
    } else {
      console.log('[看护] 用例统计: 无法解析汇总行（报告缺失或子进程未产出）—— 请按退出码判断');
    }

    let guardCode = 0;

    // 闸门①：干净包必须 0 skip。跳过 == 有测试没真跑，"全绿"就是假的。
    if (stats.skipped !== null && stats.skipped > 0) {
      console.error('[看护] ✗ 闸门①失败：干净包必须 0 skip，实测 skipped=' + stats.skipped +
        ' —— 有测试被跳过（资源夹具缺失/显式 skip），"全绿"不可采信。');
      guardCode = 6;
    }

    // 闸门②：逐条用例名集合对账（多 = 未登记红点 → 6；少 = 销号提示；解析失真 = fail-closed 6）。
    const reconciled = evaluateRetired(measured, stats, {
      registry,
      registryError,
      fullMode,
      reconcileDir: path.dirname(REPORT_FILE),
    });
    if (reconciled.guardCode !== 0) guardCode = reconciled.guardCode;

    if (code !== 0 && code !== null) {
      console.log('[看护] 注意：非 0 可能是"测试失败"，也可能是"堆上限触发 OOM" —— 请先看上面的报错类型。');
    }
    try { fs.rmSync(REPORT_FILE, { force: true }); } catch { /* 清理失败不影响结论 */ }

    // ★ 退出码优先级：闸门（6）优先于子进程退出码（1）。
    //   否则 42 红时子进程必然 exit=1，"多出未登记红点"会被糊成 1、与预期红不可区分（re3 审计 §5 的 bug）。
    const childCode = code === null ? 1 : code;
    process.exit(guardCode !== 0 ? guardCode : childCode);
  });
}

/** 解析 spec reporter 的汇总行（兼容 `ℹ tests 576` 与 TAP `# tests 576` 两种写法）。 */
function parseTestSummary(text) {
  const out = { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null };
  for (const m of String(text).matchAll(/^[ℹ#]\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)) {
    const k = m[1];
    const v = Number(m[2]);
    if (k === 'tests') out.tests = out.tests === null ? v : Math.max(out.tests, v);
    else out[k] = v;
  }
  return out;
}

if (isEntryPoint()) main();
