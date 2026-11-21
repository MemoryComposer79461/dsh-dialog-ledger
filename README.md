# dsh-dialog-ledger · 会话账本插件 v1.0.0

> **GitHub**：https://github.com/MemoryComposer79461/dsh-dialog-ledger
> **License**：Apache-2.0 ｜ **版本**：v1.0.0（首个正式版）
> **作者**：防范于未然（[MemoryComposer79461](https://github.com/MemoryComposer79461)）
>
> **一句话**：把 AI 与人的每一轮对话，记成一本**银行日记账**。
> 定位（会计视角）：台账 = 银行日记账 ｜ 完整原文 = 初始凭证 ｜ 周记账 = 记账凭证 ｜ 交接表 = 表头目录 ｜ 清册/清理报告 = 销毁清册（lite 冻结：交接表、清册、清理、库外锚**不启用**）。
>
> **纪律**：零依赖、离线可用、不调模型；**记录类东西只落硬盘，不进上下文**（唯一值得注入的是指针，不是实体）。
> 面板 / API / Agent 工具**只读**；唯一的写是**运行区读日志**（`<root>/ledger/.reads/`），一个字节都不写账。
>
> **详情页来源**：Plugin Manager 详情页读取本 README（`locale/zh.json`、`locale/en.json` 的 `meta.detail` 声明为 `README.md`；不再回退旧版 README）。
> **身份自检**：`node docs\工具-身份一致性.mjs`（版本四处一致、工具数、配置键集、locale 三键、描述失真；exit 0/1/2）。

---

## 安装（插件管理器 / `dsh.bundle`）

本包在 `package.json` 里声明 `dsh.bundle.patch = ./cordis.patch.yml` 与 `dsh.client`（web 面板）。
装本包 = 把包名 `dsh-dialog-ledger-v05` 加进 profile 的 `bundles`，由 patch 挂载 loader 条目。

```powershell
# 方式 A：GUI 插件管理器（PATH 里没有 dsh 命令时用这个）
#   Plugins（插件）→ Add plugin（安装本地插件）→ 选本目录 → 启用 → 重启 DSH
#
# 方式 B：CLI（PATH 里有 dsh 时）——路径换成"解压后的包根\01-插件包"（不要写开发机路径）
dsh plugin add "<解压后的包根>\01-插件包"
```

- ⚠️ **只用一种接入方式**：包名列进 profile 的 `bundles`（本包自带 patch），**或**手写 `insert`——二者都做会 `duplicate loader entry id`。
- ⚠️ 包名 / loader `id` / loader `name` 三者必须完全一致：本版统一为 **`dsh-dialog-ledger-v05`**（`package.json` 与 `cordis.patch.yml` 已核对；不要改名）。
- ⚠️ 同一 profile **不要同时挂** v0.4（`dsh-dialog-ledger-v04`）与本版：会两个实例各写各的。升级前先移除 v0.4。
- 装好后应看到：左栏「会话账本」面板 ｜ 3 个只读 Agent 工具 ｜ `/dialog-ledger/api/` 下 7 条只读路由（无手动 toggle；A13 重启自动挂载已真机验证）。

---

## 默认账库根（桌面「会话账本」）

- 默认根 = **`<用户桌面>\会话账本`**（`<home>\Desktop\会话账本`）；没有桌面目录的机器退回 **`<home>\会话账本`**。规则只在 `lib/ledgerroot.js` 定义一次。
- `config.root` 显式配置**永远优先**，升级不会搬用户自己选的路径。
- 旧默认根 `<DSH_HOME>\dialog-ledger`：仅在"根来自默认 + 新根不存在 + 旧根存在"时做**同盘 rename 收养**（失败只告警、不删旧根）。
- 根上有 **`.ledger-root`** 标记（账库身份证）；清理/迁移/打包等危险工具被指向父目录时**硬拒绝**（`E_LEDGER_ROOT_PROTECTED`，不是警告）。

lite 实际账库布局（v0.6.2 一级分类）：

```
<root>/
├─ 账簿总目录.md                    人读导航（每日一次；不是账务记录本身）
├─ .ledger-root                     根标记（JSON）
├─ ledger/                          运行区
│  ├─ YYYY-MM-DD.jsonl             台账（只追加；银行日记账）
│  ├─ .state.json / .lock / .lost.jsonl / .pending.jsonl
│  ├─ .seal-journal.jsonl          封板证据（唯一权威）
│  ├─ .run-report-*.json           运行报告
│  ├─ .tick-metrics.jsonl          逐 tick 度量（append-only）
│  ├─ .reads/YYYY-MM.jsonl         读日志（按月分片；旧 .reads.jsonl 只读兼容）
│  └─ .index/                      指针索引（派生数据；删掉不影响账）
├─ 体检/                            CHK-*.md（仅 checkupEnabled=true 时生成）
└─ YYYY年MM月/
   ├─ MM月第W周-{S}{D}的周记账.xlsx 记账凭证（十列、草稿→封板；十列口径不变）
   └─ MM月总“完整原文”/            <32位编码> 完整原文.md（初始凭证）
```

编码：`YYYYMMDD-SSSSSSSSSSSS-D-NNNNNNNN`（32 位；日期段 = 会话开始日，+08:00；序号会话内递增）。
时间：全系统固定 **+08:00**，产物不出现 `Z` 结尾时间。

---

## Agent 工具（3 个只读）

工具定义在 `tools/toolface.js`（卡片渲染在 `tools/toolcards.js`），**默认注册**；描述里写死"先确认当前会话 Session ID"。
本版 Agent 面共 **3 个只读 Agent 工具**（`ledger_search` / `ledger_turn` / `ledger_health`，见下表）。

| 工具 | 参数 | 返回 |
|---|---|---|
| `ledger_search` | `sid?` / `month?`（YYYY-MM）/ `keyword?` / `limit?`（默认 50，上限 200） | 台账行：编码、时间、会话、轮次、状态、原文路径 |
| `ledger_turn` | `code`（32 位编码，必填）/ `excerptBytes?`（默认 800；0 = 只给路径） | 单步台账行 + 原文位置 + 原文开头片段（不整篇塞上下文） |
| `ledger_health` | 无 | 账本健康摘要：行数、会话数、已绑定/未绑定、坏行与读取错误数 |

- **全部只读**：查询只调纯读函数与 `appendRead`（写读日志，属运行区）；root 不合法/不存在时**连读日志都不写**（`isSafeRoot` 防线，防止"查不存在的库"顺手建库）。
- 每次调用落一条读日志：`tool` / `sessionId` / `args`（截断 240B）/ `hitCodes` / `returnedRows` / `bytes` / `ms` / `ok`——"没查"与"查了读错"可区分。
- 工具面历史：0.9.2 起由 9 个裁到 **3 个**（`ledger_context` / `ledger_whoami` / `ledger_reconcile` / `ledger_anchor` / `ledger_cleanup_preview` / `ledger_cleanup_apply` 已退役、不注册）；对账/清理能力仍在 core 与面板路由里，人还能用。退役明细见 `测试退役清单-v0.9.1-re1.md` G 组。

---

## 只读面板 API（7 条）

前缀 `/dialog-ledger/api/`，全部 **exact GET** 路由（HEAD 允许，其它 405）；响应 `no-store`。

**面板只读 API 默认保护**（v1.0.0-re2 定稿，按准入审计 P0-05/P1-06 加固）：

1. **回环 Host 白名单**：无来源头请求只认 `127.0.0.1` / `localhost` / `[::1]`（可带端口），其余 Host 一律 403；
2. **同源证据**：`Sec-Fetch-Site: same-origin`，或与**请求 URL** 同源的 `Origin`/`Referer`；
3. **其余一律 403**——包括 DNS rebinding 形态（`Origin` 与 `Host` 同为攻击者域名也被拒；旧版"Host 头自证放行"已删除）；
4. **被拒请求零副作用**：不写读日志、不碰账本、不建目录。

**可选 token（SEC-01 收口）**：设置环境变量 `DSH_DIALOG_LEDGER_PANEL_TOKEN` 后，7 条 GET/HEAD 路由必须带 `x-dialog-ledger-token` 头（或 `?token=`，建议用头），否则 **401**；**连 `Sec-Fetch-Site: same-origin` 的同源请求也要 token**（无例外通道）；未设置 = 不启用。
⚠️ **启用 token 后内置左栏面板会 401（预期行为）**：面板的 fetch 带不上 token，而"能把 token 下发给浏览器"的通道任何本机进程也能拿到，等于没加。token 的定位是**外部/非浏览器访问闸**，不是面板鉴权。
⚠️ **物理边界（如实披露，不宣称防住）**：本机同权限进程可读环境变量、伪造请求头、或直接读磁盘上的台账与原文——token 与上述守卫对此无效，只能靠 OS 账号隔离。本插件只读、不写账，是这条边界的最后一道保险。

| 路由 | 说明 |
|---|---|
| `ping` | 面板自检：Host 半边是否在线（`v`/`at`/`root`） |
| `summary` | 健康度第一屏 + 计数汇总（30s 内存缓存；`refresh=1` 强制重算） |
| `search` | 检索台账行：`sid` / `month` / `keyword` / `limit`（≤200） |
| `turn` | 按 `code` 取台账行 + 原文位置 + 开头片段（`excerptBytes` ≤65536） |
| `original` | 读完整原文（`code` + `maxBytes` ≤262144；返回 `bytes` 总长与 `truncated`） |
| `reads` | 最近读日志（`limit` ≤500） + 摘要（按工具计、命中编码数、最后读时间） |
| `reconcile` | 纯只读对账（只报不修；`maxDetail` ≤200；30s 缓存；`refresh=1` 强制重算） |

- 每次 GET 恰好落一条读日志（`tool = panel:<route>`）；HEAD 不计；写日志失败不影响响应。
- **只读硬约束**：7 条路由不写台账、原文、周账、封板链；不注入上下文、不注册 systemPrompt、不调模型。

---

## 配置（27 个输入 = patch 显式 21 键 + 6 个默认兜底）

`cordis.patch.yml` 的 `config` 显式写 **21 个稳定键**；`index.js` 的 `readConfig()` 实际读 **27 个输入**——另外 6 个**故意不写进 patch**（写了会覆盖默认值），由 `readConfig`/`DEFAULTS` 兜底。
本表与 `readConfig` 输入逐键对齐；三处（patch / readConfig / 本表）由 `node docs\工具-身份一致性.mjs` 自检。

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | 空 | 数据总库根目录；空 = `<用户桌面>\会话账本`（规则见上节）。显式配置永远优先 |
| `enabled` | true | 总开关（**严格布尔**：只有显式 `true` 才开；缺省=true；`false`/`"false"`/`null`/`0`/`""` 一律视为关） |
| `intervalSeconds` | 60 | 扫描周期（秒） |
| `offsetMinutes` | 480 | 时区偏移（480 = UTC+08:00）；**绝不取本机时区** |
| `hotWindowSeconds` | 3600 | 只处理 mtime 在这么多秒内变过的会话；0 = 每次全扫；首跑强制全扫，并用 `lastRunAt` 兜底停机缺口 |
| `quietSeconds` | 120 | 未闭合轮次的安静阈值（还需"两轮确认文件未增长"） |
| `pendingMaxBytes` | 1048576 | `.pending.jsonl` 证据文件上限；0 = 不留 pending 证据 |
| `scanBudgetMs` | 30000 | 单轮时间预算（毫秒）；0.9.3 P2-4 同键改值 3000→30000；入口硬顶 28 s 留 2 s 收尾 |
| `maxBytesPerSession` | 16777216 | 单会话单次读取上限（16 MiB，停在帧边界下一轮续读） |
| `headFingerprintBytes` | 4096 | 文件身份指纹取样字节数（识别"同大小重写"，防止永久漏记） |
| `eventBatchTurns` | 32 | 事件采集预算 1/3：每批最多轮数（v0.5 P0-3 契约值） |
| `eventBatchEvents` | 500 | 事件采集预算 2/3：每批最多事件数（契约值） |
| `eventBatchBytes` | 4194304 | 事件采集预算 3/3：每批最多字节数（4 MiB，契约值） |
| `weeklyEnabled` | true | 周记账（主产物）开关（**严格布尔**，同上；缺省=true） |
| `handoverEnabled` | true | 交接表开关——**冻结占位，lite 运行期不消费**（不生成、不认领、不封板） |
| `handoverAppendixMaxBytes` | 2097152 | 交接表附表「接管前上下文」前缀读取上限——**冻结占位，不消费** |
| `checkupEnabled` | false | 体检开关（**严格布尔**：只有显式 `true` 才开；缺省=false。v1.0.0-re3 修复：旧实现 `!== false` 会把 `null`/`0`/`""`/`"false"` 全当开启，属审计 P1） |
| `checkupIntervalMs` | 3600000 | 体检节流（毫秒） |
| `receiptAnchorRoot` | 空 | REC 日结摘要输出目录；空 = 关闭。lite（S-1）收据 = 日结摘要：无 `ledgerSha256`、无前日链、不强制库外；坏了重写 |
| `cleanupToolEnabled` | false | **legacy 保留占位，无运行期消费者**：Agent 清理工具随 9→3 退役，实现体只在审查层 `freeze/`（运行期不可达）；保留仅为维持 21 键配置面 |
| `cleanupAllowPhysicalDelete` | false | **legacy 保留占位，无运行期消费者**：物理删除锁随清理工具退役；lite 不提供销毁能力 |
| `manifestAnchorRoot` | 空 | 库外 manifest 锚目录（V0.8 能力在 lite **冻结**，readConfig 仍接受、不消费；patch 不显式写） |
| `deliveryPackageDir` | 空 | 交付包目录（冻结，不消费；patch 不显式写） |
| `backfillExecEnabled` | false | 补记执行器开关——lite 0.9.2 起补记链移出 tick，**未接线**、不消费（patch 不显式写） |
| `ingest.mode` | disk | 采集换轨：`disk`（默认，与 v0.6.7 行为一致）/ `shadow` / `persistence` / `event`；shadow 只写 `ledger/.shadow/`（patch 不显式写） |
| `ingest.shadowPendingMs` | 120000 | 影子模式"另一源领先未 flush"的良性窗口（毫秒）（patch 不显式写） |
| `ingest.shadowMaxSessions` | 50 | 影子模式单轮最多比对会话数（patch 不显式写） |

> **运行期无消费者的键**（保留不删，仅冻结/legacy 占位；删键会改"21 键"配置面口径）：
> `handoverEnabled`、`handoverAppendixMaxBytes`（交接表冻结）｜`cleanupToolEnabled`、`cleanupAllowPhysicalDelete`（清理工具退役）｜`manifestAnchorRoot`、`deliveryPackageDir`（库外锚冻结）｜`backfillExecEnabled`（补记执行器未接线）。
> **加键/删键必须三处同步**：`cordis.patch.yml` config、`index.js` readConfig 输入、本表。

---

## 判据与测试现状（v1.0.0-preview4）

### 判据（45 条执行器）

- 执行器：**`docs/判据-1.0.mjs`**——C01–C45 全 45 条聚合；C01–C18 复用 `docs/判据-0.9.1.mjs`、C24+C26–C37 复用 `docs/判据-0.9.4.mjs`（子进程 `--json`；**NA ≠ 绿**），本文件补齐 C19–C23/C25/C38–C45。
- **C41–C45 是机主 S-11 签字新增的五条**（周账与台账一致 / 日结摘要一致且发出后不重写只补发 / 交接表冻结不被绕过（反向） / doctor 五类故障先红后绿 / 恢复演练）。
- 本版口径（单一来源 `VERSION.json` → `criteriaRun`）：**GREEN=45 RED=0 NA=0 SKIP=0（exit 0）**；`--proof` 先红后绿 **13/13 PASS**。随包证据：`证据/判据-1.0-final-preview4/`、`证据/判据-1.0-proof-preview4/`；全量测试 635/593/42/0（`证据/交付-v1.0.0-preview4/跑测试-最终.log`）。
- **包内自足**：夹具由 `docs/工具-构造lab.mjs` 自动构造（缺语料时合成等价语料）；三个数字生成器随包（`docs/工具-manifest.mjs`、`docs/工具-measure-tick.mjs`、`docs/工具-export.mjs`）；**不依赖开发机 `_工作/`**。
- 用法：`node docs\判据-1.0.mjs [--lab=…] [--big=…] [--three-layer=…] [--lab-dir=…] [--evid-dir=…] [--only=C01,…] [--json] [--proof]`；退出码 **0 全绿 / 1 有红或 NA / 2 用法或环境错误**。

### 测试（635 / 593 / 42）

- 全量：**634 用例 / 592 通过 / 42 失败 / 0 跳过**（比 preview 的 635/593 多 6 条 = 本轮新增回归锁：F3 帧契约、P103 瞬态缺口、K-16 用例 E/F、F1 用例 C）；**42 条全部登记退役、0 条原因不明**（明细 `测试退役清单-v0.9.1-re1.md` A–G + §J 更正）。
- 42 条归属：A 收据链 14 条（S-1 降级为日结摘要；原登记 16 条，2 条已转绿，见退役清单 §J-1）｜B 封板链 2 条｜C legacy-marks 6 条（冻结）｜D 清理/清册 3 条（冻结）｜E 运行日期 2 条（非代码回归）｜F 交接表+库外锚 6 条（冻结）｜G 工具面 9→3 共 9 条。
- **异机可复现**：包在 C: 与"包在 D:、TEMP 在 C:"两种盘位实测同数、红点名单逐条一致（跨盘夹具守卫 + `接线5` 内容等价比对已修）；`docs/跑测试.mjs` 看护对 `fail≠登记数`、`skip≠0` 都会非 0 退出。
- 复核命令：`node docs\跑测试.mjs`（全量，约 35 s）；`node tools\core-boundary.mjs`（应 0 violation，core 22 / tools 14 / freeze 运行期不可达）。

### 身份一致性 / 完整性

```powershell
node docs\工具-身份一致性.mjs                  # exit 0 = 版本/工具数/配置键集/locale/描述/loader/死配置 七项一致
node docs\工具-manifest.mjs --root=. --verify  # 期望 缺0/多0/改0
```

> **口径**：包内文件数 / MANIFEST 条数**不在文档里写死**，一律以 `MANIFEST.sha256` 实测为准（上一条命令就是复核口径）。

---

## 关键保证（lite 实况，可复算）

1. **凭证不可变**：同 code 同正文 → 复用；异正文 → `ORIGINAL_CONFLICT` 停摆，**不覆盖**。
2. **单写者（硬断言，v1.0.0-preview4 / K-25）**：`<root>/ledger/.lock` 用 **`O_CREAT|O_EXCL` 原子创建**（不是"先检查后启动"）。抢不到锁的实例 **拒绝启动 / 停正常 tick**：ERROR 级日志 + 每 30 秒重试（不写 state、不推游标，这同时是僵死锁接管所需的"两轮确认"）；运行中发现锁被接管（`handle.lost`）→ **立即停手**（本 tick 不再写任何批）。**多写者场景不支持**：不要同时开两个 DSH 实例写同一账库根。
3. **缺口留痕**：坏帧/半截帧/坏魔数 → `ledger/.lost.jsonl`（会话、缺失字节区间、帧偏移、可复算 sha256）。
4. **未闭合轮次不进账**：只写 `ledger/.pending.jsonl`（幂等键 `sid+turn+startMs`），补 `turn/end` 后恰好一个 `ok` 行（P0-2）。
5. **首跑内存有界**：事件采集三重预算（轮数/事件数/字节）任一触顶即收批，批内落账、批后释放；单轮超字节预算单独成批并如实计 `eventOversize`。
6. **同大小重写不会永久漏记**：文件身份指纹 = 大小 + 头部 4096B sha256；只比 size 会把"同大小重写"误判成没变（P0-1）。
7. **封板证据是"事实记录"，不是防篡改链**（S-1/K-5）：
   - `.seal-journal.jsonl` 是封板事实的唯一权威（canonical v8），state 丢失只影响性能、不改变封板事实；
   - v1.0.0-re2 起 `verifySealChain()` 做**结构性校验**：坏行 / 重复整行 / 同一 `(kind,key)` 重复封板 / 时间回退 / 行数快照与实际不符 / 未知 kind，违规逐条带行号返回；空册返回 `ok:true, verifiable:false`（"没有可校验对象"不等于"验过"），读不到 journal 返回 `ok:false, verifiable:false`；
   - ⚠️ **它发现不了"有写权限者整体重写 journal"**——这是 S-1 的设计取舍（没有那个对手），不是缺陷；需要更强保证时用包外锚/签名（V1.0 不做）。
8. **周记账封板后永不重写**：封板后新行 → `补记-YYYYMMDD.md`；封板组溢出 → 补记册（先补记后封板）。
9. **接收据是日结摘要**（S-1）：`RECEIPT-YYYYMMDD.json` 只汇总当天行数/字节/末条编码/原文数/异常数；无哈希绑定、无前日链、不强制库外——**不是防篡改证据**。
10. **对账只报不修**：`reconcile()` 返回差异清单与 `ok/okStrict`，不修改任何文件；`okStrict` 是"读全 + 唯一性"闸门，避免把"没读全"当"账对了"。
11. **全量 +08:00**：产物无 `Z` 时间。
12. **闸门三级**：`ok` / `degraded`（已知缺口逐项在 `gate.knownGaps`）/ `unknown`（无法表示意见）。
13. **只读 API 面板守卫**：`/dialog-ledger/api/*` 默认只认回环 Host + 同源证据，其余 403（含 DNS rebinding 形态）；可选环境变量 token 作为外部访问闸（启用后内置面板 401，属预期）。**这是纵深防御，不是密码学鉴权**；本机同权限进程不可防（见「只读面板 API」节的物理边界披露）。
14. **账库根在桌面 + 可识别**：默认 `<桌面>\会话账本` + `.ledger-root` 标记；危险工具指向父目录时硬拒绝（`E_LEDGER_ROOT_PROTECTED`）。
15. **宿主 ctx 兼容（A13）**：不直读未 `inject` 的 `ctx.tools`/`ctx.webServer`；服务未就绪用 `ctx.get` 确定性重试 + `ctx.inject` 辅助，记账绝不被可选增强拖垮。
16. **不注入上下文**：不注册 systemPrompt、不写会话、不调模型；记录只落硬盘。
17. **解压有上限**（v1.0.0-re2，审计 P1-05）：单帧解压输出上限 **64 MiB**（分配前停）；超限按结构化 loss 记 `skipped/oversizedDecompressed`，**不 halt**、不 OOM。真实 17 文件语料 29,399 帧实测 0 超限、0 halted。
18. **常驻台账缓存有上限**（v1.0.0-re2，审计 P1-04）：`ledgerCache` 行数上限 **20 万行**；超限切 `ephemeral` 模式（本轮照用、tick 末整份淘汰 + warn），**清了重读、不丢账**；缓存状态进 `.tick-metrics.jsonl` 的 `counters.cache`。
19. **tick 时间预算分段可核**（v1.0.0-re2，审计 P1-02/P1-03）：扫描/周账/对账/索引/收据/月账/目录各段耗时进 tick 度量；触顶时 `budget.overHardCap` 如实标记，剩余 <1500 ms 的段整段跳过并记 `deferredSegments`；时间与字节两条预算路径**共用**"未轮到会话补游标"，避免被 hotWindow 永久过滤。
20. **「帧 = 整行」契约硬断言**（v1.0.0-preview4 / K-26，机主 2026-11-15 裁定方案 B）：读会话时假定 DSH 写入器保证帧边界=行边界。若某帧解压文本非空、不以 `\n` 结尾、**且后面还有帧** → 判契约被破坏 → **立即停手 + ERROR**：该帧记 `failedRanges(reason=contract-violation)`、`.lost` 留痕、游标不越过该帧，**绝不静默丢跨帧残片**。末帧半行 = 合法截断尾，不触发。**不做**跨帧 pending 缓冲（真实出现写入方违约再评估改 KERNEL）。
21. **运行报告每 tick 刷新 + 缺口叠加**（v1.0.0-preview4 / P1-02）：`run-report` 不再一小时停在首 tick 快照；对账节流期内也会写，且对外 `gate` 会**叠加本 tick 可见缺口**（结论只会更保守），并带 `freshness`（对账时间/年龄/真实行数/是否叠加）。
22. **缺口只计"未被覆盖"的**（v1.0.0-preview4 / P1-03）：并发追加写撞上半截帧留下的 `retryable` 记录，一旦后续读把该轮补回（游标越过缺失区间）即**不计入 `gate.knownGaps`**；`lostGaps` 同时给 `total/covered/count` 三数，证据不删。

---

## 已知未覆盖 / 冻结能力（诚实披露）

- **不是生产准入版**：三台一致 + 7 天观察 + S-12 签字尚未完成；本包按 lite 线 P4 判据交付，三台异机检测由本包承载（v1.0.0-preview4 = 正式预览版候选，含引用式豁免与多写者/帧契约硬边界）。
- **真实账库未验**：全部验收在开发测试根/夹具上完成；机主真实账库尚未实跑。
- **配置 schema（m-01）**：`index.js` 读取 27 个配置输入，v1.0.0-re2 起已 `export const Config`（schemastery schema，字段与 `readConfig` 的 27 输入一一对应、全部可选、默认值与 `DEFAULTS` 一致）。`schemastery` 用**带兜底的动态导入**解析（宿主内可用；解析不到时 `Config` 保持未声明、行为与旧版等价，不会因增强面拖垮记账）。⚠️ 本机未装宿主 loader，**真机 `Config.listConfigs` 显示 `schema` 这一条尚未验收**（见 05）。
- **交接表 / 清册 / 清理 / 库外 manifest 锚在 lite 冻结**：不生成、不认领、不销毁；对应配置键保留为冻结/legacy 占位（见配置节）。
- **补记执行器未接线**：lite 0.9.2 起补记链移出 tick；`tools/backfill.js`、`tools/backfill-exec.js` 保留（外部脚本可手动跑），`backfillExecEnabled` 无运行期消费者。
- **收据降级（S-1）**：日结摘要不是防篡改证据；`docs/工具-核验收据.mjs` 只读核验仍可用。
- **判据残余**：C20 的 48 MB 原始语料未留存（在 E3 现存 **34.15 MiB** 可入账源上判 3 tick（判据执行器实测口径；旧稿 37.04 MiB 作废）；全量 zstd 含登记跳过的 v3 旧版为 40.09 MiB）；C21 稳态样本 **2 tick**（条款建议 10 tick）；C40 无 git 史（以结构+三链+追加验链+删行可抓四件验）；F 组 C38–C40 判定对象为当前包，出包后需复跑。
- **42 条测试红**：全部为已登记退役（A–G；A14+B2+C6+D3+E2+F6+G9=42，见退役清单 §J-1），不是未修复缺陷；与 `VERSION.json.tests.fail=42` 一致。
- **下一关卡**：三台一致 + 7 天观察 + S-12 签字（生产准入）。本版是 V1.0 发布候选（三份审计 P0 关闭版），不是生产准入版。

---

## 环境与运行自测

- Node：本机在 PATH（实测 `C:\Program Files\nodejs\node.exe`，v26.13.1）；插件运行期零第三方依赖。
- 本机内存纪律（历史教训：`node --test` 并行 + 无堆上限曾三次把宿主顶崩）：
  - **必须走看护**：`node docs\跑测试.mjs [测试文件…]`——可用物理内存 < 900 MB 拒绝启动（退出码 3）；测试子进程堆上限 384 MB；`--test-concurrency=1` 串行。
  - **不要**直接 `node --test docs/自测-*.mjs`，也**不要** `--force` 跳过看护。
- 核心边界检查：`node tools\core-boundary.mjs`（`lib/*.js` 不 import `freeze/`/`tools/`；`index.js` 不 import `freeze/`；退出码 0 = 0 violation）。

---

## 回滚 / 文档地图 / 许可

- **代码可回滚、档案不可回滚**：回滚步骤见 `交付-<本版版本>/04-回滚方式.md`（交付目录名随版本：本版 `交付-v1.0.0-preview4/`，上一版 `交付-v1.0.0-preview/` 同构）；`freeze/` 是审查层冻结基线（运行期不可达），**不许改**。
- 版本台账：`版本台账.md`（append-only）；本版红绿表：`VERSION.json`。
- 交付五件：`交付-<本版版本>/`（目录名随版本）下的 `00-交付清单.md`、`02-验收记录.md`、`03-变更说明.md`、`04-回滚方式.md`、`05-已知未覆盖项.md`；上一版为 `交付-v1.0.0-preview/`。
- 许可：**Apache-2.0**。Copyright 2026 防范于未然（[MemoryComposer79461](https://github.com/MemoryComposer79461)）。全文见仓库根 `LICENSE`。

