# docs/验收-v1.3 —— v1.3 黑盒验收（可重复运行）

> 验收对象：`<build-host>\Desktop\记忆插件v0.4.0-正式版-交付\01-代码`（交付包；与工作副本 `index.js` + `lib/` 逐文件 sha256 相同）。
> 判定依据：`<test-dir>\work\契约-v1.3\实现checklist-v1.3.md`（174 条判据 / 83 个 `AC-V13-*`）+ `契约决定记录-v1.3.md`（决定 0–9）+ 5 份模板 + Lead 2026-11-09 裁定①②。
> 本目录只做**黑盒验收**：不修改实现，只读产物/台账/state/日志并独立复算。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `run-acceptance.mjs` | 验收总入口：临时 `DSH_HOME` + 真实会话（v4 + v3-only）+ 11 个合成实验室；执行全部断言并写结果 |
| `harness.mjs` | 公共工具：临时实验室、独立 zstd 多帧会话解码、YAML 前置块解析、xlsx 探针、快照对比、记录器 |
| `checks-artifacts.mjs` | 产物级断言：交接表主表/附表、完整原文、周记账 xlsx、state、全局扫描、判据→AC 映射（与 checklist 174 行逐行一致） |
| `xlsx_probe.py` | 用 `openpyxl.load_workbook()` 只读导出 xlsx 事实（sheet/维度/freeze/表头/DV/单元格），判定全部在 Node 侧 |
| `make-report.mjs` | 由 `_results/结果.json` + `_results/AC对照表.md` 生成 `验收报告.md`（不手抄数字） |
| `merge-results.mjs` | 资源受限终验用：把**上一轮全量基线**与**本轮定向复验**按判据合并成一份 `结果.json`（定向优先） |
| `验收报告.md` | 本目录的阶段性报告；**正式终验报告在 `<test-dir>\work\验收终验\验收报告.md`** |
| `_results/结果.json` | 逐判据证据、任务级断言、验收对象哈希快照、运行环境 |
| `_results/AC对照表.md` | 83 个 AC 的状态对照（自动生成） |
| `_results/结果摘要.md` | 一页摘要（自动生成） |

## 2. 运行

```powershell
# 在 <test-dir>\work\v0.5-工作副本 下执行
$node='<build-host>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 全量验收（约 12 秒；退出码 0=无失败判据，1=有失败，2=脚本异常）
& $node docs\验收-v1.3\run-acceptance.mjs --target="<build-host>\Desktop\记忆插件v0.4.0-正式版-交付\01-代码"

# 常用子集
& $node docs\验收-v1.3\run-acceptance.mjs --only=e2e --keep      # 仅端到端真实会话；保留现场并打印临时目录
& $node docs\验收-v1.3\run-acceptance.mjs --lab=originalspecial --keep   # 仅某实验室（app/shortweek/overflow/appendixsize/originalspecial/conflict/adoptarchive/statelost/cleaned/lock/v3pair）
& $node docs\验收-v1.3\run-acceptance.mjs --fixtures="<test-dir>\work\压测素材\sessions"   # 指定真实会话素材目录

# 结果重新生成报告
& $node docs\验收-v1.3\make-report.mjs

# 终验（资源受限；2026-11-09 采用）：逐个跑定向复验 → 与上一轮全量基线合并 → 出报告
& $node docs\验收-v1.3\run-acceptance.mjs --target="<冻结件>" --fixtures="<test-dir>\work\素材-小会话\sessions" --only=e2e --out="<test-dir>\work\验收终验\_results\复验-e2e"
& $node docs\验收-v1.3\run-acceptance.mjs --target="<冻结件>" --lab=originalspecial --out="<test-dir>\work\验收终验\_results\复验-originalspecial"
& $node docs\验收-v1.3\run-acceptance.mjs --target="<冻结件>" --lab=v3pair --out="<test-dir>\work\验收终验\_results\复验-v3pair"
& $node docs\验收-v1.3\run-acceptance.mjs --target="<冻结件>" --lab=conflict --out="<test-dir>\work\验收终验\_results\复验-conflict"
& $node docs\验收-v1.3\run-acceptance.mjs --target="<冻结件>" --lab=crverbatim --out="<test-dir>\work\验收终验\_results\复验-crverbatim"
& $node docs\验收-v1.3\merge-results.mjs --out="<test-dir>\work\验收终验\_results"
& $node docs\验收-v1.3\make-report.mjs --out="<test-dir>\work\验收终验\_results"
```

前置：Windows；Node 24（路径见上）；Python 3.12 + openpyxl（路径见上，脚本自动探测）。**零依赖**：只用 Node 内置模块 + 既有 python/openpyxl，不安装任何包。

## 3. 判据覆盖口径

- **判据总数 174 / AC 83**；本期适用 **144**（`HO 31 / HA 20 / OR 27 / CL 29,30 / WK 46 / GL 18`）。
  - 不适用 30 条：`CL-01…CL-28 / CL-31 / CL-32` —— Lead 书面裁定 **N1=B**：v1.3 清册只冻结模板与判据，`lib/cleanup.js` 重写与 S1–S8 排 v0.5；v0.4 验收不含清册功能项。
  - 不适用 1 条：`OR-16`（文件清单"启用形态"）—— 决定 3 允许 v1.3 先落"未启用采集"降级，真实采集排 v0.5；本期按 OR-17 判。
- **+08:00 / 无 `Z` / 无 `{{}}` / 无 CR 的适用范围 = 生成字段**（Lead 2026-11-09 裁定①）：完整原文正文、附表 block 正文里逐字照录的用户/工具内容不参与（改它=改凭证）。实现见 `checks-artifacts.mjs` 的 `generatedPortionOf()`。
- 判据→AC 映射与 checklist 逐行对齐（174 行，脚本内 `AC_OF`；如需核对可对读 checklist「验收用例ID」列）。
- 人工待验 7 条：`HO-19 / OR-15 / OR-18 / OR-20 / GL-09 / GL-12 / GL-16` —— 均为"故障注入 / 内部机制 / git 基线 / 桌面基线清单"类，黑盒不可直接观测；报告给出代理证据。

## 4. 独立复算（审计员视角）

- 会话源解码是脚本自己实现的 **zstd 多帧读取**（`harness.mjs: decodeSessionFile`），不复用 `lib/frames.js`；
- 交接表封板 hash：正文首个 `# ` 行行首 → EOF 的 sha256；
- 完整原文正文 hash：`## 1.` 行行首 → EOF 的 sha256；
- 周记账封板 hash：从**台账 + 原文文件存在性 + 清册**独立重建 `rows`，按模板 7.3 的 `JSON.stringify` 规范化后 sha256，与说明页 A4 / `state.sealHash` 三方比对；
- xlsx 一律用 `openpyxl.load_workbook()` 打开后断言（格式、公式、dataValidations、sheet 顺序、A1:J121、freeze）；
- 所有测试数据落系统临时目录（`%TEMP%\dsh-accept-v13-*`），跑完自动删除；`--keep` 可保留现场。
- 验收期间若实现文件变化，脚本会在结论文末提示"结论可能过期"（比对开跑/结束的 sha256 清单）。

## 5. 边界声明

未运行 git（GL-12 不可判）；未安装依赖；未写桌面目录；未修改 `lib/`、`index.js`、`docs/自测-*.mjs`。本目录是验收组唯一写入区。
