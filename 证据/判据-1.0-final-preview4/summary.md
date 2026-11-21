# 判据执行器 1.0（lite 线）· 45 条聚合 · V1.0 毕业口径

生成：2026-11-15T05:23:47.315Z｜小库：C:\Users\<user>/AppData/Local/Temp/dsh-ledger-labs-1.0.0-preview4/c01-lab/root｜大库：C:\Users\<user>/AppData/Local/Temp/dsh-ledger-labs-1.0.0-preview4/lab-e3-accept/root｜三层夹具：C:\Users\<user>/AppData/Local/Temp/dsh-ledger-labs-1.0.0-preview4/lab-094-3layer/root

## 一、45 条统一表

| 判据 | 结果 | 证据 |
|---|---|---|
| C01 | GREEN | 判据-0.9.1：1 项全过（语料四数） |
| C02 | GREEN | 判据-0.9.1：1 项全过（自测-index） |
| C03 | GREEN | 判据-0.9.1：1 项全过（自测-v02） |
| C04 | GREEN | 判据-0.9.1：1 项全过（自测-index+边界） |
| C05 | GREEN | 判据-0.9.1：1 项全过（自测-守卫） |
| C06 | GREEN | 判据-0.9.1：1 项全过（自测-边界） |
| C07 | GREEN | 判据-0.9.1：1 项全过（边界+ledger） |
| C08 | GREEN | 判据-0.9.1：1 项全过（P0回归） |
| C09 | GREEN | 判据-0.9.1：1 项全过（originals） |
| C10 | GREEN | 判据-0.9.1：1 项全过（views） |
| C11 | GREEN | 判据-0.9.1：1 项全过（自测-original） |
| C12 | GREEN | 判据-0.9.1：1 项全过（自测-original） |
| C13 | GREEN | 判据-0.9.1：1 项全过（自测-边界） |
| C14 | GREEN | 判据-0.9.1：1 项全过（fields） |
| C15 | GREEN | 判据-0.9.1：8 项全过（mutate-sid、mutate-turn、mutate-ts、mutate-seq、mutate-status、mutate-doc、mutate-attachment、mutate-code） |
| C16 | GREEN | 判据-0.9.1：4 项全过（destroy-delete-row、destroy-extra-row、destroy-delete-attachment、destroy-flip-attachment-byte） |
| C17 | GREEN | 判据-0.9.1：1 项全过（变异反证） |
| C18 | GREEN | 判据-0.9.1：1 项全过（自测-gate） |
| C19 | GREEN | 日检全量重放一致：台账 3 文件/12 对，重放 3 会话、坏行 0、跳 0（日检 exit 0） |
| C20 | GREEN | 34.15 MiB 语料端到端 3 个 tick 入账 1338 行（written 合计 1338，code/(sid,turn) 唯一 1338/1338，坏行 0）；⚠ 语料 34.15 MiB（可入账源 34.15 MiB）< 条款 48 MB；48 MB 原始语料未留存，本判据在 E3 现有只读语料上判，规模差已登记 |
| C21 | GREEN | 稳态 2 tick 读盘最大 12.1 KiB ≤1 MiB；读放大最大 1.00× ≤2× 变更量（变化承载=state+头尾指纹；语料 34.15 MiB 未被全量重读） |
| C22 | GREEN | 套账/压缩语料 3.861% ≤5%（台账 1.18 MiB+索引 145.3 KiB / 语料 34.15 MiB）；原文+视图 1.1904× ∈[1.00,1.35]（54.06 MiB/45.42 MiB）；单文件最大 34.8 KiB ≤4 MB；索引分片最大 3.5 KiB ≤4 MiB |
| C23 | GREEN | 扫描 2815 文件：扩展名分布 (none)=2/.json=1356/.md=1354/.jsonl=100/.xlsx=3；白名单外 0（例外：周账 xlsx 3、外发摘要 txt 0；根标记 .ledger-root 2） |
| C24 | GREEN | 判据-0.9.4：复算 364.0 GiB ≈364 GiB；Plan §4.7 GiB 命中 0 处、推算标记 0 处、签字单 GiB 命中 0 处、包内交付文档回退命中 7 份（交付-v0.9.4/02-验收记录.md、交付-v0.9.4/00-交付清单.md、交付-v0.9.4/05-已知未覆盖项.md、交付-v0.9.5/02-验收记录.md、交付-v0.9.5/05-已知未覆盖项.md、交付-v1.0.0-re/02-验收记录 |
| C25 | GREEN | 大会话 34.15 MiB：3 tick 入账 1338 行无重复（written=1338，唯一 code/(sid,turn)=1338/1338）；3 tick 耗时 6032/6717/1101 ms ≤30 s；消费 15.97 MiB/15.98 MiB/2.20 MiB ≤17 MiB、读盘 32.59 MiB/32.61 MiB/4.50 MiB ≤40 MiB；游标 34.15 MiB/34.15 MiB（100.00 |
| C26 | GREEN | 判据-0.9.4：小库 3 日/台账 12 行=索引 12 行，缺/多/重复 0；大库 45 日/台账 1338 行=索引 1338 行，缺/多/重复 0 |
| C27 | GREEN | 判据-0.9.4：小库 12 行+大库 1338 行：指针区间/台账 docFileSha256/原文 md 整文件 sha 全部独立复算一致；h/entryHash 字段 0 |
| C28 | GREEN | 判据-0.9.4：追加 1 行→索引 +1（written=1/removed=0；视图重扫 0；读放大 0.0×） |
| C29 | GREEN | 判据-0.9.4：删 .index（3 分片/12 行）→ stat 检出 index-missing → 重建 3 分片逐字节相等、rows=12、stat.ok=true；形态=按日分片≤4 MiB（S-10④） |
| C30 | GREEN | 判据-0.9.4：小库 3 个区间逐 code 一致（12/8/8 行）；大库 3 个区间逐 code 一致（1338/690/678 行） |
| C31 | GREEN | 判据-0.9.4：三层夹具 anchor=2026-11-15（今天）：hot(session-three00… 2 行/202611) · warm(session-three00… 2 行/202606+202608) · cold(session-three00… 2 行/202508+202510)；按 sid 查三路（索引 2/2/2 行 · 暴力台账 · 公共 searchLedger）逐 code 一致；指针问题 0；窗口 |
| C32 | GREEN | 判据-0.9.4：起始分片定位正确（3 个 code）；E3 最坏 6.39 ms ≤ 阈值 50 ms（口径：非 O(1)，code 日起向后有界扫描；3 年 402 MB 未测） |
| C33 | GREEN | 判据-0.9.4：2 例未命中均返回 searchedRange+olderAvailable+hint（code 例 exit 1、空档 olderAvailable=true 且 searchedRange=20261016..20261022） |
| C34 | GREEN | 判据-0.9.4：今天（=数据最新日） 3.7 ms/100 ms（1 分片）；90 天 25.03 ms/1000 ms（45 分片）；指定冷月 18.45 ms/2000 ms（30 分片）；规模=45 天，3 年档未测 |
| C35 | GREEN | 判据-0.9.4：冷月 202609 range=20260901..20260930：只读该月 30 个分片、月份集={202609}、范围外 0；命中 900=暴力 900 |
| C36 | GREEN | 判据-0.9.4：E3 索引 141.8 KB/台账 1.18 MB=11.76%（主判）；/整库包 0.250%；含 state 12.05% → 均 ≤15% |
| C37 | GREEN | 判据-0.9.4：全量拷 37 文件→追加 1 行→增量只拷 1 文件（4584 B；unchanged 36）→verify ok；备份目录整拷后 verify ok（38 文件/607.9 KB） |
| C38 | GREEN | 抽查 6 组数字全部可追溯（生成器 8/8 在；tests/criteriaRun/E3 行数/doctor r2r3 与日志/现场复算一致）；交付五件齐、04 演练 A/B/C 已填、05 已知未覆盖项齐 |
| C39 | GREEN | 清单 567 / 磁盘 616 / 缺 0 / 多 49（其中 P4 验具 0、本执行器运行产物 49，不计红）/ 改 0（其中运行产物 0 不计红、实判 0）；交叉核 docs/工具-manifest.mjs exit=1（与本文件同结论） |
| C40 | GREEN | 版本台账 24 行（v0.9.0-lite-base … v1.0.0-preview4）；编号连续/版本唯一/正式版由同号 -re 升；builtFrom/baselineTag/builtFromCommit 三链对上；副本追加第 24 行链仍成立；删中间行可抓；04 演练 A/B/C 已填 |
| C41 | GREEN | 周账 4 组里抽 10月第5周 / 10月第4周 / 11月第1周（含跨月周=true）：逐日表对账 13 行，100% 相符（缺行 0/多行 0/时间不符 0） |
| C42 | GREEN | 日结摘要 17 天抽 3 天（2026-10-20/2026-10-28/2026-11-05）：JSON+TXT 与台账 100% 相符；改台账后旧版逐字节不变、已补发 v2（JSON+TXT 成对）、run-report 版本账可见；无变化 2 tick 不产新版 |
| C43 | GREEN | 冻结未被绕过：6 tick 全程 handover* 计数全 0、交接表产物 0 个；删除哨兵后 3 tick 未重建 |
| C44 | GREEN | doctor 5 类故障各报一次红并转绿（5/5）：data-integrity=red→ok、code-consistency=red→ok、ingest-health=red→ok、storage-health=red→ok、storage-health=red→ok |
| C45 | GREEN | 恢复演练通过：backup exit 0 → verify exit 0 → 删库重建 restore exit 0；台账 1338 码随机抽 100 行（种子 dd3aa8e6）逐字节相等 100/100 |

汇总：GREEN=45 RED=0 NA=0 SKIP=0 → 全绿（45/45）

## 二、分组汇总

| 组 | 门 | GREEN | RED | NA | SKIP | 逐条 |
|---|---|---|---|---|---|---|
| A 保存正确 | P1 | 8 | 0 | 0 | 0 | C01:GREEN C02:GREEN C03:GREEN C04:GREEN C05:GREEN C06:GREEN C07:GREEN C08:GREEN |
| B 内容保真 | P1 | 5 | 0 | 0 | 0 | C09:GREEN C10:GREEN C11:GREEN C12:GREEN C13:GREEN |
| C 不假绿 | P1 | 6 | 0 | 0 | 0 | C14:GREEN C15:GREEN C16:GREEN C17:GREEN C18:GREEN C19:GREEN |
| D 续航稳产 | P2 | 6 | 0 | 0 | 0 | C20:GREEN C21:GREEN C22:GREEN C23:GREEN C24:GREEN C25:GREEN |
| E 扩容查询 | P3 | 12 | 0 | 0 | 0 | C26:GREEN C27:GREEN C28:GREEN C29:GREEN C30:GREEN C31:GREEN C32:GREEN C33:GREEN C34:GREEN C35:GREEN C36:GREEN C37:GREEN |
| F 交付纪律 | P4 | 3 | 0 | 0 | 0 | C38:GREEN C39:GREEN C40:GREEN |
| G 给人看与能恢复 | P4 | 5 | 0 | 0 | 0 | C41:GREEN C42:GREEN C43:GREEN C44:GREEN C45:GREEN |

## 三、子执行器（聚合，不重写）

- **判据-0.9.1**：exit=0，ok=true，GREEN=18 RED=0 NA=0 SKIP=undefined；证据：`证据/判据-1.0-final-preview4/0.9.3-沿用-判据-0.9.1-存档`
- **判据-0.9.4**：exit=0，ok=true，GREEN=13 RED=0 NA=0 SKIP=0；证据：`证据/判据-1.0-final-preview4/child-判据-0.9.4`

## 四、判据原文 / 怎么验 / 出处（总纲 §7，逐条可追）

| 判据 | 结果 | 判据原文（§7） | 怎么验（§7） | 出处 | 口径（签字项） |
|---|---|---|---|---|---|
| C01 | GREEN | 真实 N 会话 → 台账行数 ＝ 真实轮数（当前基准 1558）、(sid,turn) 唯一、code 唯一、坏行 0 | 四个数同时对（别把 1558 当永久阈值） | 总纲 §7 L545（A 保存正确·P1 门）；删 1＋稳 1 | — |
| C02 | GREEN | 重复 ingest 幂等 | 第二次跑，`written = 0` | 总纲 §7 L546（A 保存正确·P1 门）；删 2＋稳 2 | — |
| C03 | GREEN | 追加一轮只写 1 行，不重复旧轮 | 加一轮再 ingest，diff 台账 | 总纲 §7 L547（A 保存正确·P1 门）；删 3＋稳 3 | — |
| C04 | GREEN | 未闭合轮只进 pending，不进台账 | 造一个半截轮，查两处 | 总纲 §7 L548（A 保存正确·P1 门）；删 4＋稳 4 | — |
| C05 | GREEN | 单实例：两进程同跑，第二个跳过并留日志 | 同时起两个，看锁文件与日志 | 总纲 §7 L549（A 保存正确·P1 门）；删 5 | — |
| C06 | GREEN | 文件换成更小的（尾部不同）→ 新内容入账、游标停在新文件边界 | 截短文件，看游标位置 | 总纲 §7 L550（A 保存正确·P1 门）；稳 6 | — |
| C07 | GREEN | 文件正在写（半截）→ 本轮跳过、下轮入账、无 partial 残留 | 边写边跑 tick，查目录残留 | 总纲 §7 L551（A 保存正确·P1 门）；稳 7 | — |
| C08 | GREEN | kill -9 → 重启从游标继续，不重复不丢 | 跑到一半强杀，重启对账 | 总纲 §7 L552（A 保存正确·P1 门）；稳 10 | — |
| C09 | GREEN | ★★★ 每份 原始事件.json 与源会话对应轮次**逐字节相等** | 全量重比（实测曾 46,564/46,564 行相等） | 总纲 §7 L558（B 内容保真·P1 门）；删 6 | — |
| C10 | GREEN | 每份视图 md 的正文 hash 可独立复算 | 独立脚本重算 | 总纲 §7 L559（B 内容保真·P1 门）；删 7 | — |
| C11 | GREEN | ★ md 头明确写"视图非全集"且含省略条数 | 打开任意 md 看头三行 | 总纲 §7 L560（B 内容保真·P1 门）；删 8 | — |
| C12 | GREEN | 截断披露行与附件名/sha256 一致 | 三处交叉核 | 总纲 §7 L561（B 内容保真·P1 门）；删 9 | — |
| C13 | GREEN | 编码 date 段 ＝ 会话开始日（跨月不拆） | 造一个跨零点会话 | 总纲 §7 L562（B 内容保真·P1 门）；删 10 | — |
| C14 | GREEN | 每行 entryHash 可复算 | 逐行重算 | 总纲 §7 L568（C 不假绿·P1 门）；删 11 | S-7：改为「原文重放式对账」（不引入 entryHash，S-6 否决） |
| C15 | GREEN | 改任一字段（turn/ts/seq/sid/doc/attachment/code）→ `verify` exit≠0 | 七次单字段变异 | 总纲 §7 L569（C 不假绿·P1 门）；删 12 | S-7 修订版：8 种单字段变异（含 status/code） |
| C16 | GREEN | 删整行 / 追加伪造行 / 删附件 / 改附件一字节 → exit≠0 | 四类破坏各一次 | 总纲 §7 L570（C 不假绿·P1 门）；删 13 | S-7 修订版 |
| C17 | GREEN | ★ 变异反证：删掉某条修复逻辑 → **对应用例**必须变红（不是"一堆红"） | 逐个拔，记录谁红 | 总纲 §7 L571（C 不假绿·P1 门）；删 14 | — |
| C18 | GREEN | gate 三级输入 4 项，每项都有"怎么变 degraded"的构造用例 | 四项各造一次 | 总纲 §7 L572（C 不假绿·P1 门）；删 15 | — |
| C19 | GREEN | ★★ 人为改"中段"（不改头尾、恢复 mtime）→ 当天周期全量核必须发现 | 改一字节＋还原 mtime，跑每日全量核（**依赖 P2 第 5 项，故不在 P1 验**） | 总纲 §7 L573（C 不假绿·P2 门）；稳 5 | — |
| C20 | GREEN | 48 MB 语料端到端 ≤ **3** 个 tick（原 2 作废 → R-3） | 压测 | 总纲 §7 L579（D 续航稳产·P2 门）；删 16 | R-3：48 MB 语料与单会话 38.82 MB 统一取 ≤3 tick |
| C21 | GREEN | ★ 稳态单 tick 读盘 ≤ 1 MB，且 ≤ 2× 变更量（不是全量重读） | 无变更跑 10 tick 计读盘 | 总纲 §7 L580（D 续航稳产·P2 门）；删 17＋稳 9 | — |
| C22 | GREEN | 账库体积 ≤ 1.25× 语料；单文件 ≤ 4 MB | 量目录 | 总纲 §7 L581（D 续航稳产·P2 门）；删 18 | S-9② 拆两条：套账(台账+索引) ≤0.05× 压缩语料；原文+视图 = 1.00–1.35× 解压语料（§5.9② 单文件 ≤4 MB，xlsx 除外） |
| C23 | GREEN | 判据产物（台账/索引/游标/报告）只用 `.jsonl` / `.md` / `.json`；**例外**：周账视图 `.xlsx`、外发日结摘要 `.txt` | 按白名单扫扩展名 | 总纲 §7 L582（D 续航稳产·P2 门）；删 19 | §5.9① 落盘格式；B11 已把两个例外写进判据与 §5.9① |
| C24 | GREEN | ★ 一年后的账库预估（给定每天 N 轮 → 体积与查询耗时）写在文档里 | 读文档 | 总纲 §7 L583（D 续航稳产·P2 门）；删 20 | S-10③ 单位统一 GiB，条款 ≈364 GiB |
| C25 | GREEN | ★★ 38.82 MB 会话：单 tick ≤ 30 秒、读盘 ≤ 8 MB、游标前进；连续 3 tick 内完整入账、无重复 | 单会话大文件压测 | 总纲 §7 L584（D 续航稳产·P2 门）；稳 8 | S-9① 改判：保留 3 tick/≤30 s；读盘改为「消费 ≤17 MiB/tick、读放大 ≤2.5×（≤40 MB/tick）」 |
| C26 | GREEN | 索引条数 ＝ 台账行数（同天），每条 code 在台账里存在 | 对账（口径见 R-5） | 总纲 §7 L590（E 扩容查询·P3 门）；扩 1 | R-5：索引行＝台账行＝轮 |
| C27 | GREEN | ★ 索引每条 `h` 与台账行复算一致 | 重算比对 | 总纲 §7 L591（E 扩容查询·P3 门）；扩 2 | S-10①：四字段（code/docFileSha256/offset/bytes）由原文独立复算；不引入 entryHash |
| C28 | GREEN | 新增一行 → 索引同步加一行（不重建、不重扫） | 加一行看索引增量 | 总纲 §7 L592（E 扩容查询·P3 门）；扩 3 | — |
| C29 | GREEN | ★ 删掉索引文件 → 能从台账重建（索引是派生物，不是权威） | 删了重建，逐行等 | 总纲 §7 L593（E 扩容查询·P3 门）；扩 4 | — |
| C30 | GREEN | 按时间范围查 → 与"暴力扫台账"结果集完全一致 | 两条路对撞 | 总纲 §7 L594（E 扩容查询·P3 门）；扩 5 | — |
| C31 | GREEN | ★ 按 sid 查 → 跨热/温/冷三层都正确 | 三个 sid 各一层 | 总纲 §7 L595（E 扩容查询·P3 门）；扩 6 | 夹具 lab-094-3layer：热=锚点日 / 温=90–180 天 / 冷=>365 天；锚点≠今天 → NA |
| C32 | GREEN | 按 code 查 → O(1) 定位月份目录（编码前 8 位即日期） | 计步数 | 总纲 §7 L596（E 扩容查询·P3 门）；扩 7 | 实测口径：非 O(1)、code 日起向后有界扫描（阈值 50 ms） |
| C33 | GREEN | ★★ 查不到必须返回 `searchedRange` + `olderAvailable` + `hint` | 查一个不存在的词 | 总纲 §7 L597（E 扩容查询·P3 门）；扩 8 | — |
| C34 | GREEN | 性能：查今天 < 100 ms；查 90 天 < 1 s；查指定冷月 < 2 s | 三档计时 | 总纲 §7 L598（E 扩容查询·P3 门）；扩 9 | — |
| C35 | GREEN | ★ 冷层查询不加载其他月份索引 | 看文件句柄 / 读盘量 | 总纲 §7 L599（E 扩容查询·P3 门）；扩 10 | — |
| C36 | GREEN | 索引总大小 ≤ 台账总大小 15% | 量目录（R-5 口径下 ≈49 MB vs 104 GB，远低于 15%） | 总纲 §7 L600（E 扩容查询·P3 门）；扩 11 | S-10②：分母＝整包（排除 .git/MANIFEST）＋台账双读法，两者都 ≤15% |
| C37 | GREEN | ★ 增量备份只拷"上次之后新写的"；整库搬走 ＝ 拷目录 + 一条命令验证可读 | 备份演练 | 总纲 §7 L601（E 扩容查询·P3 门）；扩 12 | — |
| C38 | GREEN | 数字脚本生成，不手写 | 抽查任意数字有没有生成脚本 | 总纲 §7 L607（F 交付纪律·P4 门）；删 21 | — |
| C39 | GREEN | 清单与磁盘 0 差异（今天"缺 126"的教训） | 对 MANIFEST | 总纲 §7 L608（F 交付纪律·P4 门）；删 22 | — |
| C40 | GREEN | 版本台账 append-only，**版本台账链**不断（≠ 封板链，R-9） | 追加一条验链 | 总纲 §7 L609（F 交付纪律·P4 门）；删 23 | R-9：版本台账链（保留，防改版历史）≠ 封板链（砍，只留封板事实） |
| C41 | GREEN | 周账 xlsx 内容与台账一致 —— 抽 3 周（含一个跨月周）逐行对，3 周 100% 相符 | 解 xlsx 逐日表与台账逐码对 | 总纲 §7 L0（G 给人看与能恢复·P4 门）；S-11 §4 C41 | S-11 C41：xlsx 不得缺行、不得多行；时间列 hh:mm 与台账 ts 一致 |
| C42 | GREEN | 日结摘要（JSON＋TXT）与台账一致 —— 抽 3 天 100% 相符；★ 发出后不许重写，只能补发新版 | 摘要首/末条与行数字段独立复算 + 改台账真跑 tick：旧版逐字节不变、必须新增 vN JSON/TXT、run-report 版本账可见 | 总纲 §7 L0（G 给人看与能恢复·P4 门）；S-11 §4 C42 | S-11 C42 后签优先于 lite S-1 旧口径（旧："10 键、坏了重出直接覆盖"）；v1.0.0-re2 产品已改为 11 键（含 firstCode |
| C43 | GREEN | 交接表：每会话一份、删了不补（机主 2026-11-14 裁定改为**反向判据**：验交接表冻结不被绕过） | 造 2 会话各跑 3 tick；交接表目录/文件数不得增加；删后 3 tick 内不得重建；出现任何交接表生成即 RED | 总纲 §7 L0（G 给人看与能恢复·P4 门）；S-11 §4 C43 + 早 | lite 冻结交接表（S-1/§5.3）：handoverGenerated/Adopted/Skipped/SealedTotal 必须恒 0 |
| C44 | GREEN | doctor 能对 5 类已知故障各报一次红（先红后绿）：①台账行数≠原文份数 ②原文 sha256 复算失败 ③游标卡住 ④pending 积压超阈 ⑤单文件>4MB | 五类各注入一次 → doctor 目标检查必须 severity=red → 还原 → 必须不红 | 总纲 §7 L0（G 给人看与能恢复·P4 门）；S-11 §4 C44 | S-11 写「entryHash 复算失败」；该字段已被 S-6 否决（全树 0 命中），落到 doctor ② 的「原文整文件 sha256 复算」，口径差如 |
| C45 | GREEN | 恢复演练：从备份重建 → verify 绿 → 随机抽 100 行与源逐字节相等 | backup → verify → 删工作库 → restore → 抽 100 行逐字节比 | 总纲 §7 L0（G 给人看与能恢复·P4 门）；S-11 §4 C45 | S-11 C45：没有演练过的备份等于没有备份；耗时记入证据 |

## 五、NA（未验，不算绿）缺什么

无（本次参与判定的判据全部判出，NA=0）。会记 NA 的输入缺口：缺小库/大库/三层夹具、缺 `ledger/.tick-metrics.jsonl`、缺 MANIFEST/版本台账/VERSION.json、缺 C38 抽查所需的 0.9.4 证据日志、子执行器未产出可解析 JSON。缺任何一项都写明缺哪个路径，不算绿。

## 六、RED 明细

无（RED=0）。

## 七、残余 / 口径说明（不粉饰）

- C20 语料 34.15 MiB（可入账源 34.15 MiB）< 条款 48 MB；48 MB 原始语料未留存，本判据在 E3 现有只读语料上判，规模差已登记
- C21 样本 2 tick（条款建议无变更跑 10 tick；E3 现有只读度量只有 2 个稳态 tick，10 tick 观测未跑，已登记残余）
- C39 另有 49 个"清单外新增"是本执行器运行产物（包内 证据/判据-1.0-<时间戳>/，跑一次多一套），已单独登记、不计红；清单内已声明文件仍逐文件核 sha256（缺/改必须 0）
- C22 r1（整库/压缩语料，仅报告）=1.3298；S-9 实测解压 3.49× 是全语料口径，E3 现存语料子集不同，不参与判红
- C40 append-only 的"从未删过旧行"在无 git 史下不可证；已改为"结构+三链+追加验链+删行可抓"四件可验
- F 组（C38–C40）判定对象 = 当前包内最新交付五件（交付-v*）＋ VERSION.json/版本台账/MANIFEST；出包顺序：交付五件更新 → MANIFEST 重生成 → 再跑本执行器（C38/C39/C40 以新包为对象）。C38 的 VERSION.criteriaRun.evidence 必须是**包内相对路径**（如 证据/判据-1.0-final-<stamp>/summary.md），VERSION.tests 的来源日志须在包内 证据/跑测试-*.log；C40 要求版本台账末行与 VERSION.json 同版（VERSION 版本 bump 后必须追加台账行）

## 八、先红后绿（--proof）

未找到 `proof-summary.json`（本次聚合未跑 --proof；先红后绿证据需另跑 `node docs\判据-1.0.mjs --proof`）。

证据目录：证据/判据-1.0-final-preview4
证据内容：summary.json / summary.md / C*.json / child-*.json / logs/
