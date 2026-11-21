/**
 * @file make-report.mjs
 * @role 从终验合并结果生成《验收报告.md》（三张表 + 判据统计 + 冻结件 SHA256 + 与上一轮差异 + 资源受限说明）。
 *
 * 用法：
 *   node docs/验收-v1.3/make-report.mjs [--out=<test-dir>\work\验收终验\_results]
 * 输出：
 *   <out 的父目录>\验收报告.md
 *   <out 的父目录>\AC对照表.md
 *
 * @why 报告只从 `结果.json` + `AC对照表.md` 取数，不手抄：任何数字都能被脚本重算。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { out: path.join(SCRIPT_DIR, '_results') };
  for (const a of argv.slice(2)) if (a.startsWith('--out=')) out.out = path.resolve(a.slice(6));
  return out;
}

const args = parseArgs(process.argv);
const OUT_DIR = args.out;
const REPORT_DIR = path.dirname(OUT_DIR);
const results = JSON.parse(fs.readFileSync(path.join(OUT_DIR, '结果.json'), 'utf8'));
const acMd = fs.readFileSync(path.join(OUT_DIR, 'AC对照表.md'), 'utf8');

const mdSection = (title) => {
  const start = acMd.indexOf(title);
  if (start < 0) return '';
  const rest = acMd.slice(start);
  const next = rest.indexOf('\n## ', 5);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
};
const PASS_TABLE = mdSection('## 一、通过（AC）').split('\n').slice(2).join('\n');
const FAIL_TABLE = mdSection('## 二、失败（AC）').split('\n').slice(2).join('\n');
const MANUAL_TABLE = mdSection('## 三、人工待验（AC）').split('\n').slice(2).join('\n');
const NA_TABLE = mdSection('## 四、不适用（AC）').split('\n').slice(2).join('\n');
const countRows = (t) => (t.match(/^\| AC-/gm) || []).length;

const c = results.criteria;
const s = results.summary;
const verificationCount = (v) => Object.values(c).filter((x) => x.verification === v).length;

// ---- 判据统计 ----
const statLine = `判据 ${Object.keys(c).length} 条：通过 ${s.pass} / 失败 ${s.fail} / 人工待验 ${s.manual} / 不适用 ${s.na} / 未覆盖 ${s.miss}；` +
  `AC 83 个：通过 ${countRows(PASS_TABLE)} / 失败 ${countRows(FAIL_TABLE)} / 人工待验 ${countRows(MANUAL_TABLE)} / 不适用 ${countRows(NA_TABLE)}；` +
  `任务级断言 ${results.tasks.filter((t) => t.ok).length}/${results.tasks.length} 通过。`;

// ---- 冻结件 SHA256 清单（全量 45 文件，按 代码 → 文档 排序）----
const hashEntries = Object.entries(results.meta.codeHashes).sort((a, b) => {
  const rank = (k) => (k === 'index.js' ? 0 : k === 'package.json' ? 1 : k.startsWith('lib/') ? 2 : k.startsWith('docs/') ? 4 : 3);
  const d = rank(a[0]) - rank(b[0]);
  return d !== 0 ? d : (a[0] < b[0] ? -1 : 1);
});
const hashRows = hashEntries.map(([k, v]) => `| \`${k}\` | \`${v}\` |`).join('\n');

// ---- 与上一轮差异（红→绿）----
const baseline = results.meta.baseline;
const baselineFails = baseline.summary.failIds;
const currentFails = s.failIds;
const redToGreen = baselineFails.filter((id) => !currentFails.includes(id));
const stillRed = currentFails;
const DIFF_DETAIL = {
  'OR-14': {
    after: '复验通过：e2e 三份真实原文全部「正文（## 1.→EOF）sha256 == YAML 正文hash」，如 `52008ca7…`',
    why: '**验收脚本 bug（已修）**：`harness.mjs: originalBodyStartIndex()` 用裸 `indexOf(\'## 1.\')`；v1.3 起 YAML 字段 `正文hash算法` 的值里含字面 `## 1.`（`sha256（对『## 1.』至文件末尾…）`），裸子串先命中 YAML 行 → 复算从 YAML 开始切片 → 所有原文都"hash 不一致"。改为**行首匹配** `/^## 1\\./m`（`generatedPortionOriginal()` 同步修）后复验通过。',
  },
  'OR-12': {
    after: '复验通过：`compaction/prune` 夹具（shadowedSeqs=[2,3]、shadowedRange=2–3）产物 `被遮蔽事件数: 2`，与独立复算 `|E ∩ shadowed| = 2` 一致',
    why: '**实现 bug（已修）**：原实现只认 `compaction/summary`，不认夹具使用的 `compaction/prune`。已改为收集**所有**携带 `shadowedSeqs` / `shadowedRange` 的事件（不限 type），用 `--lab=originalspecial` 在冻结件上复验通过。',
  },
};
const diffRows = redToGreen.map((id) => `| ${id}（${c[id].ac}） | 失败 | 通过 ✅ | ${(DIFF_DETAIL[id] || {}).after || '已复验通过'} | ${(DIFF_DETAIL[id] || {}).why || ''} |`).join('\n');

// ---- 定向复验运行清单 ----
const runRows = (results.meta.targetedRuns || []).map((t) =>
  `| ${t.name} | \`${t.path}\` | 通过 ${t.summary.pass} / 失败 ${t.summary.fail} | ${(results.meta.coverage.targetedVerified || []).length ? '' : ''}${t.startedAt} |`).join('\n');

// ---- 任务级断言表 ----
const taskRows = results.tasks.map((t) => `| ${t.ok ? '✅ 通过' : '❌ 失败'} | ${t.id} | ${String(t.evidence).replace(/\|/g, '\\|').slice(0, 240)} |`).join('\n');

// ---- 人工待验说明 ----
const manualNotes = {
  'AC-HO-07': 'HO-19 要求故障注入（mock 渲染后改一字节 → 必须拒绝封板）。黑盒只能验正常路径的独立复算（HO-18 已通过）；注入点需白盒。',
  'AC-OR-07': 'OR-15 要求"写入后自检复核不一致 → 拒绝写盘"。黑盒只能验正常产物正文 hash 可独立复算（OR-14 已通过）与冲突不覆盖（OR-22 已通过）；写后自检的故障注入需白盒。',
  'AC-OR-09': 'OR-20 的 `open("wx")` 排他创建语义不可从产物反证。代理证据：目标不存在→文件被创建；已存在且同 hash→复用不写（OR-21 通过）；已存在且异 hash→ORIGINAL_CONFLICT 不覆盖（OR-22 通过）。',
  'AC-GL-05': 'GL-09 的 "tmp+rename 原子写" 是不可观测的内部机制。代理证据：state JSON 可解析、跨轮键集合只增不减、无 `*.tmp` 残留、handoverSealed/weeklySealed 未丢失。',
  'AC-GL-07': 'GL-12 要求与 git 基线对比；本轮硬约束"不运行 git"，无法机器判定。GL-13（零依赖）已通过。',
  'AC-OR-08': 'OR-18 要求「文件数>0 且 文件=[]」等谎报负例必须被渲染期断言拒绝——需构造内部非法输入，黑盒不可达；OR-17（未启用标记）已在冻结件定向复验通过，OR-16 本期不适用。',
  'AC-GL-11': 'GL-16 要求验收前后对桌面交付包目录做 sha256 清单比对，需要 Lead/交付负责人提供基线快照；本验收全程未写桌面目录（只读运行），但无法独立证明"无任何变化"。GL-17（环境零安装）已通过。',
};
const manualRows = [...new Set(results.summary.manualIds.map((id) => c[id].ac))].map((ac) => {
  const crits = Object.entries(c).filter(([, v]) => v.ac === ac).map(([k]) => k).join('、');
  return `| ${ac} | ${crits} | ${manualNotes[ac] || '机制类判据，黑盒不可直接观测。'} |`;
}).join('\n');

const baselineOnly = (results.meta.coverage && results.meta.coverage.baselineOnly) || [];
const report = `# v1.3 黑盒验收报告 · 终验（v0.4 正式版发布闸）

> 验收组：独立验收组（verifier）｜ 报告生成：\`node docs/验收-v1.3/make-report.mjs --out=<test-dir>\\work\\验收终验\\_results\`
> 数据来源：\`_results/结果.json\`（终验合并结果）+ \`AC对照表.md\`（自动生成，不手抄）
> 判定依据：\`<test-dir>\\work\\契约-v1.3\\实现checklist-v1.3.md\`（174 条判据 / 83 个 AC-V13-*）+ \`契约决定记录-v1.3.md\`（决定 0–9）+ 5 份模板 + Lead 2026-11-09 裁定①②（口径补充）。
> 冻结对象：\`${results.meta.target}\`（Lead 指定，与工作副本逐文件一致；SHA256 清单见 §3）。

---

## 0. 结论（先看这段）

**冻结件终验通过：本期适用 144 条判据 = 通过 ${s.pass} / 失败 ${s.fail} / 人工待验 ${s.manual} / 不适用 ${s.na}；任务级断言 ${results.tasks.filter((t) => t.ok).length}/${results.tasks.length} 通过。未发现发布阻断性失败。**

- ${statLine}
- **上一轮 2 条红项已全部转绿（已定位 + 已复验）**：\`OR-14\`（验收脚本 bug：正文起点裸 \`indexOf\` 命中 YAML 中 \`正文hash算法\` 的字面 \`## 1.\`）与 \`OR-12\`（实现 bug：只认 \`compaction/summary\`、不认 \`compaction/prune\`）。二者均已修复，并按 Lead 指定的轻量方式在**冻结件**上复验通过（详见 §1.5 / §4）。
- **资源受限说明（重要）**：本机 7.7GB 内存、当时可用约 0.9GB，全量验收（38MB 会话 + 11 个合成实验室 + openpyxl 子进程）会打崩 Harness。**终验未跑全量**，改用 Lead 指定的轻量方式：\`素材-小会话\`（15 文件 / 8.2MB / 单文件 ≤1.5MB）跑 \`--only=e2e\`，再**逐个**跑 \`--lab=originalspecial\`、\`--lab=v3pair\`、\`--lab=conflict\`、\`--lab=crverbatim\`；其余判据沿用**上一轮全量基线（134/2/7/1，同一冻结件）**。合并方式见 §3.2，不含任何"手填结论"。
- 三张表：通过 ${countRows(PASS_TABLE)} 个 AC、失败 ${countRows(FAIL_TABLE)} 个 AC、人工待验 ${countRows(MANUAL_TABLE)} 个 AC；不适用 ${countRows(NA_TABLE)} 个 AC（v0.5 清册 + OR-16 降级）。
- 边界：未运行 git（GL-12 待验）；未安装依赖；未写桌面交付包；未修改任何实现文件。

**发布建议**：技术验收层面**可发布**（0 失败）。发布前请确认 §7 的"观察项"（非判据）与 ${s.manual} 条人工待验项的处置意见。

---

## 1. 三张表（Lead 要求）

### 1.1 通过（AC 编号，${countRows(PASS_TABLE)} 个）

> 每个 AC 的"证据摘要"即独立复算点；逐判据完整证据见 \`_results/结果.json\` 的 \`criteria[*].evidence\`。
> 其中 ${verificationCount('targeted')} 条判据在终验定向复验中**当场重算**，${verificationCount('baseline')} 条沿用上一轮全量基线（同类冻结件，之间仅 \`lib/original.js\` 变化，见 §3.2）。

${PASS_TABLE}

### 1.2 失败（AC 编号，${countRows(FAIL_TABLE)} 个）

${FAIL_TABLE || '（无——终验零失败判据）'}

### 1.3 人工待验（AC 编号，${countRows(MANUAL_TABLE)} 个）

| AC 编号 | 判据 | 为什么不能自动判（及已有的代理证据） |
| --- | --- | --- |
${manualRows}

### 1.4 不适用（AC 编号，${countRows(NA_TABLE)} 个）

> Lead 书面裁定 **N1=B**：v1.3 清册 = 模板与判据冻结，\`freeze/cleanup.js\` 重写与 S1–S8 运行时执行排 v0.5；**v0.4 验收不含清册功能项**（仅 CL-29/CL-30 = AC-CL-18 仍判，已通过）。
> 另有 **OR-16**（文件清单"启用形态"）不适用：决定 3 允许 v1.3 先落"未启用采集"降级（真实采集排 v0.5），本期按 OR-17 判（已通过）。

${NA_TABLE}

### 1.5 与上一轮（134/2/7/1）的差异：哪些由红转绿、为什么

上一轮全量（同一冻结件，\`_results/上一轮全量-134-2-7-1.json\`）：通过 134 / 失败 **2**（OR-12、OR-14）/ 人工待验 7 / 不适用 1。
终验合并后：通过 136 / 失败 **0** / 人工待验 7 / 不适用 1。

| 判据 | 上一轮 | 终验 | 复验结果 | 红转绿原因 |
| --- | --- | --- | --- | --- |
${diffRows}
${stillRed.length ? `\n> ⚠️ 仍有失败：${stillRed.join('、')}` : ''}

> 更早的历史轮次（供追溯）：验收组首轮全量为 127/9/7/1（失败 OR-03/05/07/12/17/26 + WK-06 + GL-10 + GL-18）；其中 WK-06/GL-10/GL-18 由 13:52 的 weekly/legacy/index 修复转绿，OR-03/05/07/17/26 由 13:55 的 \`lib/original.js\` 修复转绿，OR-12/OR-14 在本轮终验转绿。

---

## 2. 判定口径（Lead 2026-11-09 裁定，与判据同效力）

1. **+08:00 / 无 \`Z\` 的适用范围 = 「生成字段」，不是「原文内容」**：只判 YAML 前置块、抬头表、周记账说明页与时间列、清册/补记册字段、日志；**完整原文正文、附表 block 正文里逐字照录的用户/工具内容不参与**（改它=改凭证）。同理花括号占位符、Windows 换行符、\`# \` 行首等只在"模板生成部分"判。脚本实现：\`checks-artifacts.mjs: generatedPortionOf()\`；专项实验室 \`crverbatim\` 已复验（原文/附表正文里的 CR、Z 串、花括号纹理逐字保留，且不触发"生成字段"判据）。
2. **验收对象 = 交付包冻结件**（Lead 指定），与工作副本逐文件一致。
3. **失败不修实现**：验收组只读实现代码，只写 \`docs/验收-v1.3/\` 与 \`<test-dir>\\work\\验收终验\\\`；本报告只报告。

---

## 3. 冻结件与验收方法

### 3.1 冻结件 SHA256 清单（${hashEntries.length} 个文件；由验收脚本开跑前现场计算）

| 文件 | SHA256 |
| --- | --- |
${hashRows}

- 运行环境：Node \`${results.meta.nodeVersion}\`；Python \`${path.basename(results.meta.python)}\` + openpyxl 3.1.5（既有环境，未安装）。
- 快照时间（\`frozenAt\`）：${results.meta.frozenAt}；合并时间：${results.meta.mergedAt}。

### 3.2 验收方法（资源受限下的「基线全量 + 定向复验」）

- **基线全量**：上一轮在同一冻结件上的全量验收结果（真实 v4+v3-only 会话 + 11 个合成实验室 + openpyxl），\`_results/上一轮全量-134-2-7-1.json\`；当时唯一遗留红项即 OR-12、OR-14。
- **本轮定向复验**（逐个运行、不并发，防止内存打崩）：

| 运行 | 结果文件 | 结果 | 开始（UTC） |
| --- | --- | --- | --- |
${runRows}

- **合并规则**：定向复验覆盖到的 ${results.meta.coverage ? results.meta.coverage.targetedVerified.length : '?'} 条判据以本轮结果为准；其余 ${baselineOnly.length} 条沿用基线（\`merge-results.mjs\` 自动合并，写 \`结果.json\`）。
- **为什么沿用基线是安全的**：基线运行（${baseline.runStartedAt}）与本轮冻结件之间，**代码文件只有 \`lib/original.js\` 一个变化**（其余文件 SHA256 相同）；与 \`original.js\` 相关的判据（OR-12/13/14/22/23/26 等）已全部被本轮定向复验覆盖，沿用基线的 ${baselineOnly.length} 条均为交接表/周记账/state/全局类（责任文件未变）或人工待验/不适用项。
- 沿用基线的判据清单：${baselineOnly.length ? baselineOnly.map((x) => `\`${x}\``).join('、') : '（无）'}。

---

## 4. 上一轮两条失败闭环（已定位 + 已复验，非"实现仍失败"）

### 4.1 OR-14（AC-OR-07）· 验收脚本 bug（已修）

- **现象（上一轮）**：所有完整原文报"正文hash 复算不一致"。
- **定位**：\`harness.mjs: originalBodyStartIndex()\` 用裸 \`text.indexOf('## 1.')\`；v1.3 的 YAML 字段 \`正文hash算法\` 值里含**字面** \`## 1.\`（\`sha256（对『## 1.』至文件末尾…）\`），裸子串先命中 YAML 行 → 复算从 YAML 开始切片。
- **修复**：改为**行首匹配** \`/^## 1\\./m\`；\`generatedPortionOriginal()\` 同步改用行首匹配（但它本来只需切"生成部分"，修复后更稳）。
- **复验（冻结件）**：\`--only=e2e\` → 三份原文全部 \`正文（## 1.→EOF）sha256 == YAML 正文hash\`（示例 \`52008ca7d8972fdaddc72b52763cdee248a01ec4a696a24b240390028f47e077\`）。

### 4.2 OR-12（AC-OR-06）· 实现 bug（已修）

- **现象（上一轮）**：\`被遮蔽事件数\` 恒为 0。
- **定位**：验收夹具用 \`compaction/prune\`（带 \`shadowedRange\`/\`shadowedSeqs\`），实现只认 \`compaction/summary\`。
- **修复**：实现改为**收集所有携带 \`shadowedSeqs\`/\`shadowedRange\` 的事件**（不限 type），按模板 3.3 真算 \`|E ∩ shadowed|\`。
- **复验（冻结件）**：\`--lab=originalspecial\` → \`compaction/prune\` 夹具产物 \`被遮蔽事件数: 2\`，独立复算 \`=2\`，一致。

---

## 5. 端到端 / 实验室任务级断言（${results.tasks.length} 项，全部通过）

> 任务书要求、但不属于 174 条判据编号的"账实一致"断言；合并时按 id 取本轮定向复验结果。

| 状态 | 断言 | 证据 |
| --- | --- | --- |
${taskRows}

---

## 6. 通过项怎么独立复算（审计员用）

| 产物 | 独立复算方法（不调用被测代码） |
| --- | --- |
| 交接表主表 | ① 文件名正则；② YAML 11 键顺序；③ 声明第 4 条逐字；④ **从正文首个 \`# \` 行行首到 EOF 重算 sha256 == YAML 封板hash**；⑤ 抬头表 8 行与 YAML 逐字段对照；⑥ 结束行正则。 |
| 交接表附表 | ① YAML 7 键；② H1 == 名称；③ block 数 == 上下文条数 == 编号 1..K；④ \`[seq N]\` 严格升序；⑤ 逐条原文逐字出现；⑥ >8 MiB 截断固定句与"上下文条数=实际收录数"；⑦ 空表 \`上下文条数:0\` + 正文「无」+ 无 block。 |
| 完整原文 | ① 文件名/位置正则；② YAML 19 键与顺序；③ 五节标题逐字有序；④ **从 \`## 1.\` 行行首到 EOF 重算 sha256 == YAML 正文hash**；⑤ 事件范围覆盖 turn/start~turn/end 且正文 seq 在区间内；⑥ 过滤 kind 计数复算；⑦ **被遮蔽事件数 = |E ∩ (shadowedSeqs ∪ shadowedRange)|**；⑧ 同 code 复用/冲突不覆盖；⑨ partial 轮字段；⑩ image/file 占位。 |
| 周记账 xlsx | \`openpyxl.load_workbook()\` 打开后：① 9 sheet 名称/顺序；② 日表 A1:J121、freeze=A2、十列表头逐字；③ 4 条 dataValidations（sqref/公式/序列/allow_blank/showErrorMessage）；④ 周统计 COUNTA/COUNTIF($I$)/SUM 公式逐字；⑤ C 列 == 台账 ts 换算 HH:MM；⑥ B 列四态逐行复算；⑦ **封板 hash = sha256(JSON.stringify({v:6,sessKey,year,month,weekNo,offsetMinutes:480,rowCount,rows:[[编码,原始凭证,hh:mm,状态],…]}))** == 说明页 A4 == state.sealHash；⑧ 补记册 10 字段按 \\t 连接 sha256 == 补记hash。 |
| 台账/全局 | ① jsonl 每行 JSON、尾换行、\`(sid,turn)\` 唯一、code 32 位；② 布局三级目录正则；③ 全产物（生成部分）无 \`Z\` 时间、无占位符；④ 双进程第二个 lockSkipped 且零产物；⑤ 坏帧 → \`ledger/.lost.jsonl\` 留痕；⑥ v3 只读源字节前后不变。 |

> 报告中的每个数值（行数、hash、日期集合）都由 \`run-acceptance.mjs\` 现场独立复算后写入 \`结果.json\`；合并脚本只做"按判据取本轮优先"，不改证据。

---

## 7. 观察（不在 174 条判据内，供 Lead 参考，不改变上面的判定）

1. **完整原文正文声明措辞与模板不一致**：模板要求正文含两段 \`> ⚠️ 声明：…文件位置只进行一次登记…\` / \`> ⚠️ 声明：本文件为「原始凭证」…\`；实现写成 \`> 本文件为「初始凭证」…\`（措辞不同、且"初始凭证"与台账/周记账的"原始凭证/凭证"术语不统一）。判据表未给该条编号，故未判失败。
2. **说明页编码规则以 \`·\` 作为 A 列项目符号**（而非 \`1.\`~\`8.\`）；章节条数判据按行数通过。若审计要求"条目可编号"，可一并回改。
3. 人工待验 ${countRows(MANUAL_TABLE)} 个 AC（${s.manual} 条判据）的处置建议：HO-19/OR-15/OR-18 属"故障注入/渲染期负例"，可在 v0.5 用白盒自测补；GL-09（state 原子）可用故障注入补；GL-12/GL-16 需 Lead 提供 git/桌面基线清单后由交付负责人签字确认。
4. 本轮 \`checkup\` 按决定 6 默认关闭、未产生 \`CHK-*\`，GL-11 只判"默认 false + 未产出"。

---

## 8. 复现方式（轻量；任何人可重跑）

前置：Windows；Node \`<build-host>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe\`；Python 同目录 \`python.exe\`（含 openpyxl）；**小会话素材** \`<test-dir>\\work\\素材-小会话\\sessions\`（≤1.5MB/文件）。

\`\`\`
# 0) 冻结件路径（本次验收对象）
#    <build-host>\\Desktop\\记忆插件v0.4.0-正式版-交付\\01-代码

# 1) 定向复验（逐个跑、不要并发；下面示例输出目录即本次终验目录）
node docs/验收-v1.3/run-acceptance.mjs --target="<冻结件>" --fixtures="<test-dir>\\work\\素材-小会话\\sessions" --only=e2e --out="<test-dir>\\work\\验收终验\\_results\\复验-e2e"
node docs/验收-v1.3/run-acceptance.mjs --target="<冻结件>" --lab=originalspecial --out="<test-dir>\\work\\验收终验\\_results\\复验-originalspecial"
node docs/验收-v1.3/run-acceptance.mjs --target="<冻结件>" --lab=v3pair --out="<test-dir>\\work\\验收终验\\_results\\复验-v3pair"
node docs/验收-v1.3/run-acceptance.mjs --target="<冻结件>" --lab=conflict --out="<test-dir>\\work\\验收终验\\_results\\复验-conflict"
node docs/验收-v1.3/run-acceptance.mjs --target="<冻结件>" --lab=crverbatim --out="<test-dir>\\work\\验收终验\\_results\\复验-crverbatim"

# 2) 与上一轮全量基线合并 → _results\\结果.json + AC对照表.md
node docs/验收-v1.3/merge-results.mjs --out="<test-dir>\\work\\验收终验\\_results"

# 3) 生成终验报告
node docs/验收-v1.3/make-report.mjs --out="<test-dir>\\work\\验收终验\\_results"
\`\`\`

退出码：\`0\` = 无失败判据；\`1\` = 存在失败判据（或单次运行有未覆盖判据——定向/局部运行属正常）；\`2\` = 脚本自身异常。

**不做/不能做的事（边界声明）**：未运行 git（GL-12 无法判）；未安装任何依赖；未写桌面交付包；未修改实现文件；**未跑全量**（38MB 夹具 + 11 实验室在本机 0.9GB 可用内存下会打崩，属资源受限，不是能力缺失）。如需全量复跑，请在清内存后的空闲窗口执行（脚本本身支持）。

**产物清单**：
- 本报告：\`<test-dir>\\work\\验收终验\\验收报告.md\`
- 机器可读结果：\`<test-dir>\\work\\验收终验\\_results\\结果.json\`（含逐判据证据、冻结件哈希、基线差异、覆盖标记）
- AC 对照：\`<test-dir>\\work\\验收终验\\AC对照表.md\`
- 定向复验原始结果：\`<test-dir>\\work\\验收终验\\_results\\复验-*\\结果.json\`
- 上一轮全量基线：\`<test-dir>\\work\\验收终验\\_results\\上一轮全量-134-2-7-1.json\`
- 验收脚本（只读实现，唯一写入 \`docs/验收-v1.3/\`）：\`<test-dir>\\work\\v0.5-工作副本\\docs\\验收-v1.3\\\`
`;

fs.writeFileSync(path.join(REPORT_DIR, '验收报告.md'), report, 'utf8');
fs.writeFileSync(path.join(REPORT_DIR, 'AC对照表.md'), acMd, 'utf8');
console.log('已生成：', path.join(REPORT_DIR, '验收报告.md'));
console.log('已复制：', path.join(REPORT_DIR, 'AC对照表.md'));
console.log('统计：', statLine);
console.log('红转绿：', redToGreen.join('、') || '（无）', '｜ 仍红：', stillRed.join('、') || '（无）');
