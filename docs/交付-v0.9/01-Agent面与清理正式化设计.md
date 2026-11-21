# 01 · V0.9 Agent 面与清理正式化（设计定稿 v0.9）

> **目标**：把 v0.8 已有的"库外锚 / 对账 / 清理"三块能力正式暴露给 Agent —— 新增 4 个工具
> （`ledger_reconcile` / `ledger_anchor` / `ledger_cleanup_preview` / `ledger_cleanup_apply`），
> 并把"物理删除完整原文"从 CLI 能力收敛成 **Agent 可调用、但默认零删除、三重条件缺一不可** 的受控动作。
> **原则**：只读三件套一个字节都不许写；清理默认只产试运行报告；任何一项能力不可用时**降级不抛**；
> 原 5 个只读工具的定义**一个字不动**。
> **前置**：工作副本由 v0.8.0 火种逐字节重建（全量自测 480/480 已复跑通过），本设计在其上做增量。
> **日期**：2026-11-11（V0.9 第 1 轮）；KERNEL 六文件冻结口径不变。

---

## 一、现状与缺口

| 已有（v0.8） | 作用 | 缺口 |
|---|---|---|
| `lib/reconcile.js:reconcile()` | 账本 vs 原文 vs 周账 vs 收据/封板链的只读对账 | 只有 `index.runOnce` 与 CLI 在用，**Agent 看不见**；也没有"紧凑摘要"口径 |
| `lib/reconcile.js:checkReceiptChain()` | 收据链浅检 | 同上 |
| `lib/cleanup.js:planCleanup()` | 纯函数圈选要清理的原文 | Agent 无法先"看一眼要删什么" |
| `lib/cleanup.js:runCleanup()` | 默认 dry-run + 双开关物理删除 + 清册/journal | 语义在库里、不在工具描述里；Agent 层没有 confirm 第三重闸 |
| `lib/manifestanchor.js` | 库外锚 append/read/verify | Agent 无法核验 `DELIVERY-ANCHOR.jsonl` 的链与逐条哈希 |
| 4+1 个只读工具（`toolface.js`） | 查账/上下文/自查 | 工具面停在"读账"，没有"对账/核锚/清理"动作面 |

V0.9 的增量就是补上最后一行：**把已经存在的只读/受控能力接成 4 个 Agent 工具**，并为"真删"补一条
Agent 可执行、机主可控制的确认链。

## 二、总体设计

```
Agent (模型)
   │  call
   ▼
lib/toolface.js      注册 9 个工具；统一 wrap：计时 + 写读日志 + 异常兜底（不抛）
   │  execute(args, exec)
   ▼
lib/cleanup-tools.js 纯逻辑层：不依赖 ctx、不读全局状态、可单测
   ├── compactReconcile()  → lib/reconcile.js
   ├── verifyAnchor()      → lib/manifestanchor.js（只读）
   ├── previewCleanup()    → lib/cleanup.js: listOriginals / planCleanup（只读）
   └── applyCleanup()      → lib/cleanup.js: runCleanup（dry-run 或三重条件后的物理删除）
   ▼
lib/toolcards.js     presentCall / presentResult 纯映射（展示层，绝不抛）
```

四条硬约束：

1. **只读三件套**：`ledger_reconcile` / `ledger_anchor` / `ledger_cleanup_preview` 的整条调用链
   不许 `mkdir/write/append/unlink`；判据 AG-01、CT-01 用"调用前后整树 sha256 不变"守。
2. **清理默认零删除**：`ledger_cleanup_apply` 缺省 `dryRun:true`，只产 `RPT-DRYRUN-*`。
3. **三重条件**：`dryRun:false` 只有在"工具总开关 + 物理删除开关 + confirm 短语"同时成立时才可能删一个文件，
   任一不满足 → `ok:false` + 机器码 + **零删除**。
4. **降级不抛**：库缺失/账损坏/锚未配置/参数非法一律 `{ok:false, reason}`；wrap 另有异常兜底。

`cleanup-tools.js` 不持有任何模块级可变状态（无"内存令牌"），confirm 校验全部由**现场重算**得出 ——
这是为了"进程重启/配置热更新后行为仍可解释"，见 §3.4。

## 三、四个工具

> 工具名统一 `ledger_` 前缀；参数 schema 全部 `additionalProperties: false`；
> 返回一律**紧凑 JSON**（计数 + 最多 10 条问题定位 + 样例≤5），完整报告落盘由 `cleanup.js` 自己写。

### 3.1 `ledger_reconcile`（只读对账）

| 项 | 口径 |
|---|---|
| 参数 | 无（`{}`）——对账范围由插件配置的 data root 决定，不接受 Agent 指定路径 |
| 只读 | 调 `reconcile({ root, receiptAnchorRoot, offsetMinutes })`；不写账、不修账 |
| 返回 | `{ok, at, okStrict, counts:{ledgerRows, codeUnique, sidTurnUnique, ledgerOk, originalCount, originalMissing, originalOrphan, weeklyGroupsExpected, weeklyGroupsMissing, lostGaps, receiptBreaks, sealChainBreaks}, problems:[≤10]}` |
| problems | 每条形如 `{kind, at, detail}`：`kind∈{ledger-read-error, bad-line, original-missing, original-orphan, weekly-missing, lost-gap, receipt-break, seal-break}`，`at` 尽量给到文件:行/编码/gid |
| 降级 | root 非绝对路径/盘符根 → `E_BAD_ROOT`；root 不存在 → `E_ROOT_MISSING`；台账读不全 → `ok:true`? **不**：`ok:false` + `E_LEDGER_UNREADABLE`（"没读到"≠"没有"，与 reconcile 的 P1-8 口径一致） |

`problems` 的生成顺序固定（台账 → 凭证 → 周账 → 缺口/收据/封板），截断到 10 条并带 `truncated:true`；
模型先读计数，必要时再由人跑完整报告。

### 3.2 `ledger_anchor`（只读核验库外锚）

| 项 | 口径 |
|---|---|
| 参数 | 无（`{}`）；锚目录取插件配置 `manifestAnchorRoot` |
| 只读 | 读 `<anchorRoot>/DELIVERY-ANCHOR.jsonl` + 只读复算 `pkgPath` 指向的交付包摘要 |
| 返回 | `{ok, anchorRoot, file, exists, entries, counts:{packages, snapshots, badLines, chainBreaks, payloadMismatches, structural, verifiedPackages, unverifiedPackages}, head, problems:[≤10], warnings:[≤5]}` |
| 未配置 | `{ok:false, reason:'anchor-disabled', configured:false}` —— **降级不抛**（v0.8 默认就是关闭） |
| 锚文件不存在 | `{ok:false, reason:'anchor-missing', file}` |

校验算法（顺序固定）：

1. **逐行解析**：空行跳过；`JSON.parse` 失败 / `v !== ANCHOR_VERSION` / `kind` 不认识 → `bad-line` 问题，定位到行号；
2. **append-only 形态**：
   - 文件非空但末尾不是 `\n` → `torn-tail`（半行追加 = 上次写被截断的最强证据）；
   - 首个 `package` 行的 `prevHash` 既不是创世标记（`''` 或 `（创世）`）又不是哈希 → `chain-start-missing`
     （说明更早的锚行被删掉了，这是"只增不改"被破坏的直接证据）；
3. **prevHash 链**：后续 `package` 行的 `prevHash` 必须等于上一条 `package` 行的 `payloadHash`，否则 `chain-break`（定位行号 + 期望/实际）；
4. **逐条 payloadHash 复算**（`package` 行）：`pkgPath` 存在时用 `computePackageDigest()` 复算
   （与出包脚本/版本台账同算法），不一致 → `payload-mismatch`；`manifestSha256` 可比时一并比；
   MANIFEST 存在时还比 `fileCount`（= payload 文件数 + 3）与 `manifestCount`；
5. **`ledger-snapshot` 行**：只做结构校验（`files[]` 每项 `name/sha256/bytes/rows` 合法）→ `snapshot-structure`。
   **为什么不逐文件复算**：v0.8 的 `appendAnchor()` 对快照行写 `payloadHash:''`（既有格式，见工作副本
   `DELIVERY-ANCHOR.jsonl` 第 5 行），没有可复算的目标；且台账按日只追加，"后来的文件变长"是正常态，
   快照 vs 现场的逐字节比对属于 `verifyLedgerSnapshot()`/恢复演练的职责，不在这里重复判红。
6. **降级**（不判红）：`pkgPath` 不存在/不可读 → `unverifiedPackages++` + `warnings` 提示"库外锚只能证明
   当时链完整，包本体不在时不复算"。机主把包搬去 U 盘后这里永远是"未复算"，不应因此常红。

`ok = problems.length === 0`。AG-03 的"定位到哪一条"由 `problems[].line`（真实文件行号）承担。

### 3.3 `ledger_cleanup_preview`（只读预览）

| 项 | 口径 |
|---|---|
| 参数 | `month?`（`YYYY-MM`）、`sessionKey?`（13 位 `[0-9a-z]{12}[A-Z]`）、`limit?`（非负整数，0=全部） |
| 只读 | `listOriginals()` + `planCleanup()`；**不调用 `runCleanup`**，因此不产 `RPT-DRYRUN-*`（AG/CT-01 守） |
| 返回 | `{ok, planned, bytes, byMonth:{'YYYY-MM':{files,bytes}}, sample:[≤5 {code,month,bytes,rel}]}` |
| bytes | 视图文件大小 + 同单元事件附件（存在时）大小；一个清理单元 = 视图 + 附件 |

`ledger_cleanup_preview` 与 `ledger_cleanup_apply(dryRun:true)` 的区别要写进工具描述：
前者**零写入**、给"要不要清"的决策依据；后者会落一份 `RPT-DRYRUN-*.md` 并给出 confirm 短语。

### 3.4 `ledger_cleanup_apply`（受控执行）

状态机：

```
args.dryRun 缺省 = true
        │
        ├─ true  → runCleanup({dryRun:true}) → 产 RPT-DRYRUN-YYYYMMDD-NN.md（不占正式编号、不写 journal）
        │           返回 {ok, dryRun:true, reportId, planned, confirmPhrase:'DELETE <planned> <reportId>'}
        │
        └─ false → ① cleanupToolEnabled === true ?            否 → E_CLEANUP_TOOL_DISABLED（零删除）
                   ② cleanupAllowPhysicalDelete === true ?    否 → E_CLEANUP_DELETE_LOCKED（零删除）
                   ③ confirm === 现场重算的 confirmPhrase ?   否 → E_CLEANUP_CONFIRM_MISMATCH（零删除）
                   ↓ 全部满足
                   runCleanup({dryRun:false, cleanupAllowPhysicalDelete:true}) → 正式 RPT + journal + 删第 3 级单元
```

**confirm 短语如何"现场重算"**（本项目最关键的一处口径）：

```
planned   = planCleanup(listOriginals(root), {month, sessionKey, limit}).length   ← 当前计划，不用缓存
reportId  = 当日已存在的最大 RPT-DRYRUN-YYYYMMDD-NN（扫 清册/ + 一级，双路径与 cleanup.js 一致）
expected  = `DELETE ${planned} ${reportId}`
```

不变量：

- 没有当日 dry-run 报告 → `reportId=''` → 必判 `E_CLEANUP_CONFIRM_MISMATCH`（"先 preview"由工具描述与错误提示引导）；
- **计划条数变了就不认**：旧短语里的 `planned` 与现场重算不一致 → 拒绝（CT-04）；
- **同日再跑一次 dry-run 会使编号 +1**：旧短语自然失效，必须用最新短语 —— 这是"确认必须是最新一次预览"的防呆，
  宁可让机主多跑一次 preview，也不让一份过期确认落到真删上；
- 进程重启不影响校验：全部由磁盘上已有的 dry-run 报告 + 现场扫描重算，**没有内存令牌可丢**。

残余风险（如实写）：短语只编码"条数 + dry-run 编号"，若两次预览之间**条数相同但文件不同**，旧短语仍会通过。
V0.9 不接受该风险之外的扩张（短语格式是机主可读的 `DELETE n RPT-DRYRUN-…`，加指纹会牺牲可读性）；
后续若要收紧，方向是把"计划指纹"落进 journal/试运行报告的既有字段，而不是改短语格式。

失败语义表（全部**零删除**，`ok:false` + `reason`）：

| reason | 触发 | 额外说明 |
|---|---|---|
| `E_CLEANUP_TOOL_DISABLED` | `cleanupToolEnabled !== true` | 默认配置即落这里（CT-08） |
| `E_CLEANUP_DELETE_LOCKED` | `cleanupAllowPhysicalDelete !== true` | 与 `runCleanup` 内部双开关同义，双保险 |
| `E_CLEANUP_CONFIRM_MISMATCH` | `confirm` 非法/为空/与现场重算不一致/无当日 dry-run | 返回 `planned`+`reportId` 供人核对，不回显完整期望短语 |
| `E_CLEANUP_<S1…S8>` / `E_CLEANUP_*` | `runCleanup` 抛错（清册自检不过、编号冲突等） | 原样透传机器码；`deleted:null`（不谎报零删除） |

成功返回（物理）：`{ok:true, dryRun:false, reportId, planned, deleted, succeeded, failed, originalsBefore, originalsAfter, reportPath, journalPath}`；
**不返回** `runCleanup().report.text`（17 键清册全文会撑爆 Agent 上下文，报告已落盘）。

### 3.5 工具面契约

- `buildToolDefs(env)` 返回 **9 个**：原 5 个（`search/turn/context/whoami/health`，定义逐字不动）+ 4 个新增；
- 每个 def 都有 `parameters`（object/schema）、`output.render`、`presentCall`、`presentResult`、`execute`；
- 全部走 `toolface.wrap`：计时 + `<root>/ledger/.reads/YYYY-MM.jsonl` 读日志 + 异常兜底 `{ok:false, reason:'internal-error'}`；
- **读日志只在 root 合法（绝对路径、非盘符根）且存在时写**：否则"查一个不存在的库"会顺手把库目录建出来，
  违反只读工具的直觉（新增守卫；原 5 个工具在该退化路径上也不再凭空建目录）。
- 环境注入（`env`）：`getRoot`、`offsetMinutes`、`now`、`getAnchorRoot`、`cleanupToolEnabled`、`cleanupAllowPhysicalDelete`。
  配置在**调用时**读取（getter），因此热更新配置对下一次工具调用立即生效，无需重注册工具面。

## 四、配置接线

三处必须逐键同名、同默认值：`index.js:DEFAULTS` → `index.js:readConfig()` → `cordis.patch.yml`。

| 键 | 默认 | 语义 |
|---|---|---|
| `cleanupToolEnabled` | `false` | V0.9 清理工具总开关。关闭时 `dryRun:false` 一律拒绝；`dryRun:true` 只产试运行报告，不受影响 |
| `cleanupAllowPhysicalDelete` | `false` | 第二把锁：即使工具总开关打开，也必须显式 `true` 才允许真删 |

语义矩阵：

| `cleanupToolEnabled` | `cleanupAllowPhysicalDelete` | `dryRun` | 结果 |
|---|---|---|---|
| 任意 | 任意 | `true`/缺省 | 只产 `RPT-DRYRUN-*`（零删除） |
| `false` | 任意 | `false` | `E_CLEANUP_TOOL_DISABLED`（零删除） |
| `true` | `false` | `false` | `E_CLEANUP_DELETE_LOCKED`（零删除） |
| `true` | `true` | `false` + 正确 confirm | 正式 RPT + journal + 删第 3 级单元 |

默认双 false 的理由：清理工具一旦暴露给 Agent，"默认可用"就等于把机主凭证放在模型手边；
默认关 + 机主在 `cordis.patch.yml` 显式打开，才符合"删除必须有据、有明确人类意志"的既有红线（P0-6）。

## 五、判据与守护用例（V0.9 新增）

判据编号以**测试标题逐字出现**为准（映射表按标题匹配）。守护文件：`docs/自测-agenttools.mjs`。

| 判据 | 要求 | 守护用例 |
|---|---|---|
| **AG-01** | 只读：reconcile/anchor/preview 调用前后整树 sha256 不变 | `V0.9/AG-01：只读三件套（reconcile/anchor/preview）调用前后整树 sha256 不变` |
| **AG-02** | 降级：账库缺失/损坏/参数非法 → `ok:false` + `reason`，不抛 | `V0.9/AG-02：降级——账库缺失/账本损坏/参数非法/锚未配置 → ok:false + reason，不抛` |
| **AG-03** | 判红：锚链断/条目被篡改 → `ok:false` 并定位到哪一条 | `V0.9/AG-03：判红——锚链断/条目被篡改 → ok:false 并定位到哪一条` |
| **AG-04** | 工具面：`buildToolDefs` 返回 9 个、参数 schema 齐全、每个都有卡片、每次调用写读日志 | `V0.9/AG-04：工具面 9 个、schema/卡片齐全、每次调用写读日志` |
| **AG-05** | 越界拒绝：非法 root/未知参数 → 拒绝且不写盘 | `V0.9/AG-05：越界拒绝——非法 root/未知参数 → 拒绝且不写盘` |
| **CT-01** | 预览只读（零字节写入，不产 `RPT-DRYRUN`） | `V0.9/CT-01：清理预览零字节写入（不产 RPT-DRYRUN）` |
| **CT-02** | dry-run 只写 `RPT-DRYRUN`，不占正式编号 | `V0.9/CT-02：dry-run 只写 RPT-DRYRUN，不占正式编号` |
| **CT-03** | 三重条件缺一不可（三条各一个用例） | `V0.9/CT-03a` / `CT-03b` / `CT-03c` 三条用例 |
| **CT-04** | confirm 短语必须与当前计划一致（计划变了就不认） | `V0.9/CT-04：confirm 短语必须与当前计划一致（计划变了就不认）` |
| **CT-05** | 执行后台账/周账/交接表字节不变 | `V0.9/CT-05：执行后台账/周账/交接表字节不变` |
| **CT-06** | 清理后 reconcile 不误报缺凭证 | `V0.9/CT-06：清理后 reconcile 不误报缺凭证` |
| **CT-07** | 清理后锚仍 PASS | `V0.9/CT-07：清理后库外锚仍 PASS` |
| **CT-08** | 默认关闭（缺省配置时 apply 拒绝） | `V0.9/CT-08：默认关闭（缺省配置时物理执行被拒绝）` |

口径拆分（为什么只读要分两层守）：

- **纯逻辑层**（`cleanup-tools.js` 直调）：AG-01 / CT-01 用"整树 sha256（含目录）前后不变"守，证明工具逻辑本身不写；
- **工具层**（`buildToolDefs().execute`）：只读工具额外允许写**读日志**（运行区，`ledger/.reads/`），
  这是既有 v0.6 口径（"除读日志外全库 sha256 不变"），AG-04 另守"每次调用写读日志"。

## 六、本次改动让哪条既有判据失效、如何同步（硬规矩）

加 4 个工具必然撞上既有测试里"工具面恰好 5 个"的写死断言。**共 5 个既有用例受影响，归为 3 类**
（数量断言 5→9 / 名单断言 5→9 / 只读快照语义拆分）。逐条列出、逐条同步，**并说明为什么不是放宽判据**：

| # | 既有断言（文件 :: 用例） | 失效原因 | 同步方式 |
|---|---|---|---|
| 1 | `docs/自测-toolface.mjs` :: `V0.6/toolface：5 个工具的定义齐全…` 里 `deepEqual(defs.map(name), [5 个])` | 工具数 5→9，名单数组不再相等 | 期望名单改为 **9 个**（原 5 个在前、新增 4 个在后，顺序固定）；其余"描述非空/execute/output.render 齐"断言保留 |
| 2 | 同上文件 :: `V0.6/toolface：能注册/撤销…`（`registered=5`、`names.length=5`、`dispose=5`） | 注册数 5→9 | 三处数字统一改 **9**；"没有 tools 服务时 registered=0"不变 |
| 3 | 同上文件 :: `V0.6/toolface：apply() 带 tools 服务时注册 5 个工具…`（`reg.length=5`、名单 5 项、`disposed=5`） | `index.apply` 会注册 9 个 | `reg.length=9`、排序名单补 4 个、`disposed=9`；用例标题同步为 9 |
| 4 | `docs/自测-toolcards.mjs` :: `V0.6/toolcards：原 5 个工具 name/description/parameters 未被改动（回归）` 里 `deepEqual(defs.map(name), [5 个])` | 同 1 | 快照仍逐字保留原 5 个；断言改为"前 5 个 = 原快照 + 总数 = 9"（新增 4 个必须排在后面，保证原 5 个的字段/描述逐字未动） |
| 5 | `docs/自测-toolface.mjs` :: `V0.6/toolface：除读日志外，全库 sha256 不变（工具面只读硬断言）` | 该用例 `for (const d of defs) d.execute()` 现在会执行 `ledger_cleanup_apply`，其**默认 dry-run 必须产 `RPT-DRYRUN-*.md`** —— "全部工具只读"的前提不再成立 | 断言语义拆成两层：①该用例只对**只读工具**（原 5 个 + reconcile/anchor/preview 共 8 个）跑"除读日志外整树不变"；②`apply` 的写行为不放松、而是换成更精确的新判据 CT-02（"只允许新增一个 `RPT-DRYRUN-*`、不占正式编号、零删除"）+ CT-01/AG-01 守纯逻辑层只读。**判定力上升**（从"不许写"细化为"只许写这一份报告"），不是放宽 |

另：`docs/验收-v0.6/验收-只读面.mjs`（A1/A6）也写死"5 个工具全部 ok:true / 5 个 presentResult"，
它**不在 `docs/跑测试.mjs` 的全量范围**、也不在本任务写作用域；V0.9 若跑五门/只读面验收需同步
（建议同样拆成"只读 8 个 + 受控写 1 个"两类），本任务先如实登记、不改该文件。

## 七、实现记录（文件与接口）

| 文件 | 改动 |
|---|---|
| `lib/cleanup-tools.js`（新） | 纯逻辑层。导出：`isSafeRoot` / `requireRoot` / `checkToolArgs` / `confirmPhraseOf` / `latestDryRunId` / `compactReconcile` / `verifyAnchor` / `previewCleanup` / `applyCleanup`；零依赖（除 node:fs/path 与既有 lib 模块） |
| `lib/toolface.js` | 保留原 5 个 def 逐字不动；新增 4 个 def（参数/schema/描述/`presentCall/presentResult` 接线）；`env` 增加 `getAnchorRoot` / 两个清理开关；wrap 增加"root 合法且存在才写读日志"守卫 |
| `lib/toolcards.js` | 新增 4 组 `presentCall` / `presentResult` 纯映射；未知工具/异常仍回退 `undefined`；原有 5 组不动 |
| `index.js` | `DEFAULTS` 增两键（默认 false，带 why 注释）→ `readConfig` 归一化为 `=== true` → `registerLedgerTools(env)` 把 `getAnchorRoot` / 两个开关传下去 |
| `cordis.patch.yml` | 同步新增 `cleanupToolEnabled: false`、`cleanupAllowPhysicalDelete: false` 两键 + 中文注释；键总数 19→21 |
| `docs/自测-agenttools.mjs`（新） | 15 条用例，覆盖 AG-01…05 / CT-01…08（CT-03 三条） |

## 八、残余风险与未覆盖

1. **同数量不同文件**的过期 confirm（§3.4 已写），V0.9 接受并在 doc 明示。
2. `ledger-snapshot` 行的 `payloadHash` 在 v0.8 格式里恒为空 → 只做结构校验，逐文件复算仍归
   `verifyLedgerSnapshot()`/恢复演练；不在本工具重复实现。
3. 锚目录/包目录都可能在机主设备上不存在（U 盘拔走）→ 一律降级为"未复算"，不判红、不抛。
4. 真机：U 盘锚搬运、36 MB 压测、五门/只读面 A1–A8 的同步不在本轮完成范围（登记见 §六）。
5. 物理清理的"清册 S1–S8 有一项不过"会让 `runCleanup` 在**删完文件之后**抛错（既有实现语义：
   journal 保留现场、终稿不写）；本工具原样透传 `reason` 且 `deleted:null`，不掩盖"可能已部分删除"。

## 九、执行验收（2026-11-11，工作副本实测）

| 项 | 结果 |
|---|---|
| `docs/自测-agenttools.mjs` 单文件 | **15/15 pass，0 fail**（AG-01…05 共 5 条 + CT 族 10 条，其中 CT-03 三条） |
| 全量 `docs/跑测试.mjs` | **496 pass / 0 fail / 0 skip**（v0.8.0 基线 480 + 本版新增 15 + 同日 `自测-ledgerapi.mjs` 新补 AG-05b 1 条 = 496；pass ≥ 493 达标） |
| 内核边界检查 `工具-内核边界检查.mjs` | **exit 0**：KERNEL 六文件与 0.5.0 基线逐字节相同；受控变更提示 7 个（含 index.js，属允许） |
| `buildToolDefs()` | 返回 **9 个**：原 5 个（定义逐字未动）+ `ledger_reconcile` / `ledger_anchor` / `ledger_cleanup_preview` / `ledger_cleanup_apply` |
| 编码纪律 | 全部改动文件 UTF-8 无 BOM、纯 LF（已逐文件字节检查） |
| 未做 | 真机 U 盘锚搬运、36 MB 压测、五门/只读面 A1–A8（登记见 §六/§八） |
