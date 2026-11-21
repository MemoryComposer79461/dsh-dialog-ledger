# 01 · V0.8 库外 manifest 锚 + 恢复演练自动化（设计定稿 v0.8）

> 目标：把"**交付包本身**"也变成可离线复算、库外留证的对象；让"从归档包恢复/校验"从手工步骤变成一条只读命令。
> 原则：库外锚**只增不改**；校验器**只读**（不写库、不联网）；不动已交付包；不写机主真实账库（开发测试根除外）。

## 一、现状与缺口

| 已有 | 作用 | 缺口 |
|---|---|---|
| `MANIFEST.sha256`（包内） | 包内逐文件哈希 | 与包同处一地：整包替换可连 MANIFEST 一起重算（"自己证明自己"） |
| 版本台账 `payloadHash` + `prevHash` 链 | 版本间防替换 | 仍在桌面/包内，无库外副本 |
| `RECEIPT-YYYYMMDD.json` 库外锚（REC） | **每日台账**指纹 + 前日链 | 只锚账本，不锚交付包；需 `receiptAnchorRoot` 显式开启 |
| 手工恢复演练（v0.6.x） | 拷回→`--check`→内核 | 手工步骤、无统一结论文件、未与锚联动 |

## 二、锚的覆盖范围（V0.8）

**交付包锚**（每版一条，append-only JSONL）：
- `version`、`payloadHash`（与版本台账同算法）、`prevHash`（上一版 payloadHash，形成库外链）；
- `manifestSha256`（MANIFEST.sha256 文件本身的 sha256）、`fileCount`、`manifestCount`；
- `pkgPath`（仅作提示，不作判据）、`at`、`note`（快照/正式）。

**账本快照锚**（可选，每锚定一次一条）：
- `<root>/ledger/YYYY-MM-DD.jsonl` 的逐文件 `{name,bytes,sha256,rows}`（只读计算）；
- `lastDate`、`totalRows`、`weeklySealedCount`/`weeklyDraftCount`（来自正式名/草稿名计数）；
- 与 REC 收据链头（若开启）**不互相替代**：REC 是日粒度链，快照锚是"某时刻整体形态"。

## 三、锚文件格式

位置：`<anchorRoot>/DELIVERY-ANCHOR.jsonl`（`anchorRoot` 必须落在数据总库之外；复用"库外"校验语义）。
每行一个 JSON（键顺序固定，便于肉眼比对）：

```json
{"v":1,"at":"2026-11-10T21:40:00+08:00","kind":"package","version":"0.8.0","stage":"正式版",
 "payloadHash":"<64hex>","prevHash":"<64hex>","manifestSha256":"<64hex>",
 "fileCount":415,"manifestCount":414,"pkgPath":"C:\\...\\v0.8.0-正式-20261110","note":""}
{"v":1,"at":"...","kind":"ledger-snapshot","rootId":"...","lastDate":"2026-11-10",
 "totalRows":64,"weeklySealedCount":0,"weeklyDraftCount":9,
 "files":[{"name":"2026-11-10.jsonl","bytes":0,"sha256":"<64hex>","rows":64}]}
```

## 四、只读校验器与恢复演练

`docs/工具-核验交付锚.mjs`（只读，零依赖）：
1. `--package=<pkgDir>`：重算 payloadHash / MANIFEST 根哈希 / 文件数 → 与锚对应行比对；校验锚链 `prevHash` 连续；输出 PASS/FAIL + 差异明细（JSON 可选）。
2. `--root=<ledgerRoot>`：重算账本快照（逐日文件 sha/rows、周账计数）→ 与最近一条 `ledger-snapshot` 比对；差异逐条列出（文件新增/缺失/哈希变/行数变）。
3. `--anchor-dir=<dir>`：缺省读 `<桌面>/账本锚`（由机主指定；U 盘由机主手动搬入）。
4. 退出码：0 全通过；1 有差异；2 参数/IO 错误；**不写任何文件**。

恢复演练包装 `docs/工具-恢复演练.mjs`：
- `--from=<U盘目录或zip>` `--anchor-dir=...`：解压到临时目录（zip）或只读复制（目录）→ `--check` MANIFEST → 内核边界 → 复核器基线 → 与锚比对 → 输出 `_结果/恢复演练-<时间>.md`；
- 全程不覆盖已交付包；临时目录用后可删；结果文件落运行区/验收目录（由参数决定）。

## 五、写入时机（插件侧）

- 默认**关闭**（`manifestAnchorRoot: ''`）；开启后每轮 runOnce 末尾：
  - 若检测到**本机交付包目录**（配置 `deliveryPackageDir`）且有新版本 payloadHash 与锚最后一行不同 → 追加 `package` 锚；
  - 每日一次（节流）追加 `ledger-snapshot` 锚（与收据口径一致：只对"已完结日期"或当日末轮）。
- 插件**不搬运 U 盘**、不写 U 盘；锚目录由机主指定（桌面/同步盘），U 盘归档仍由机主手动。

## 六、失败语义

| 情形 | 行为 |
|---|---|
| 锚目录不可写 | `ANCHOR_UNWRITABLE`：本轮跳过、运行报告留痕，**不影响记账** |
| 锚链断（prevHash 不匹配） | 校验器判红并列出断点；插件不自动修复（人工处置） |
| 包与锚无对应行 | 校验器判红「包未锚定」（新版本尚未锚定属正常，需登记） |
| 账本快照与现场不一致 | 校验器逐条列差异；**不自动修复**；REC 链仍独立可验 |
| MANIFEST 自身坏行 | 判红；文件按行解析，坏行数计入结论 |

## 七、判据（V0.8 新增，草案）

| # | 判据 | 守护计划 |
|---|---|---|
| MA-01 | 锚只追加、不改写（重复锚定同 payloadHash 幂等 skip） | 自测：append 两次，文件前缀字节不变 |
| MA-02 | payloadHash 复算与版本台账一致（0.7.0 实测锚定） | 自测：用 0.7.0 包复算 = 台账行 |
| MA-03 | 包内任一文件被改 → 校验判红并定位文件 | 自测：tamper 单文件 |
| MA-04 | MANIFEST 根哈希与锚一致；坏行判红 | 自测 |
| MA-05 | 锚链 prevHash 连续；断链可定位 | 自测 |
| MA-06 | 账本快照逐日文件 sha/rows 复算一致；篡改一日判红 | 自测 |
| MA-07 | 校验器只读（前后整树哈希不变） | 自测 |
| MA-08 | 恢复演练从 U 盘拷回 → 清单/内核/锚 三项 PASS | 真机脚本 |

## 八、实施顺序

1. 设计定稿（本文件）；
2. `lib/manifestanchor.js`（纯函数：包摘要/MANIFEST 解析/锚 append/read/verify/ledger snapshot）+ 单测；
3. `docs/工具-核验交付锚.mjs` 只读 CLI；
4. `docs/工具-恢复演练.mjs` 自动化演练；
5. 插件侧接线（默认关闭）+ 运行报告字段；
6. 0.8.0 出包：先用 0.7.0 包做"首次库外锚定"实测（MA-02），再出 0.8.0 双包并锚定。

---

## 九、实施进度（2026-11-10 第 1 轮）

- ✅ `lib/manifestanchor.js`：payloadHash 复算（与出包脚本/台账同算法，排除 MANIFEST/版本台账/00-交付清单 三个自指件）、MANIFEST 解析、锚 append-only+fsync+幂等+prevHash 链、账本快照（逐日 sha/rows + 周账 sealed/draft 计数）、只读校验。
- ✅ `docs/自测-manifestanchor.mjs` **5/5**：MA-02 用 0.7.0 真包复算 payloadHash = 台账 `5d6686fe…`（415 文件/清单 414）；MA-01/03/04 幂等+篡改定位；MA-05 链断点；MA-06/07 快照校验只读；**MA-08 集成**（index 接锚：每日快照一次、包锚幂等、锚目录越界拒绝）。
- ✅ 只读工具：`docs/工具-核验交付锚.mjs`（包 + 账本 + 锚链，14/14 PASS）；`docs/工具-恢复演练.mjs`（U 盘目录/zip → 解压/复制 → MANIFEST 自检 → 内核边界 → 锚比对 → 结果 md），U 盘 0.7.0 目录与 zip **均 PASS**，结果在 `docs/验收-v0.8/`。
- ✅ 首次真实库外锚定：`<build-host>\Desktop\账本锚\DELIVERY-ANCHOR.jsonl`（0.7.0-snapshot → 0.7.0 → 账本快照，3 行、链连续）。
- ✅ 插件接线（默认关闭）：`manifestAnchorRoot` / `deliveryPackageDir` 配置；runOnce 末尾每日一次账本快照 + 新 payloadHash 包锚；越界拒绝；run-report `deliveryAnchor` 段；所有失败只 warn（不影响记账）。
- ✅ V0.7 尾巴：R-05（shadow 两轮不重复落账）、R-09（ingest 配置切换不改账）测试补齐；A14 deferred 理由细化为 `handler-not-wired:<kind>:needs-ingest-entry`。
- 门：全量自测 **480/480**；五门 86/8/0；只读面 8/8。
- ⬜ 未完成：0.8.0 双包/映射表 v0.8 族/U 盘归档与演练归档；36MB 压测待内存宽裕；A14 handler 仍 deferred（需 ingest 入口，已明确降级口径）。
