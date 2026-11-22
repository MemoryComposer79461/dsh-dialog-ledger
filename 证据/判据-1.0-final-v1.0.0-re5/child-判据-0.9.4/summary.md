# 判据执行器 0.9.4（C24 + C26–C37）

生成：2026-11-22T04:30:53.623Z｜小库：C:\Users\ADMINI~1\AppData\Local\Temp\dsh-ledger-labs-1.0.0\c01-lab\root｜大库：C:\Users\ADMINI~1\AppData\Local\Temp\dsh-ledger-labs-1.0.0\lab-e3-accept\root

| 判据 | 结果 | 证据摘要 |
|---|---|---|
| C24 | GREEN | 复算 364.0 GiB ≈364 GiB；Plan §4.7 GiB 命中 0 处、推算标记 0 处、签字单 GiB 命中 0 处、包内交付文档回退命中 7 份（交付-v0.9.4/02-验收记录.md、交付-v0.9.4/00-交付清单.md、交付-v0.9.4/05-已知未覆盖项.md、交付-v0.9.5/02-验收记录.md、交付-v0.9.5/05-已知未覆盖项.md、交付-v1.0.0-re/02-验收记录.md、交付-v1.0.0-re/05-已知未覆盖项.md）（交付文档 04 待出包复述） |
| C26 | GREEN | 小库 3 日/台账 12 行=索引 12 行，缺/多/重复 0；大库 45 日/台账 1338 行=索引 1338 行，缺/多/重复 0 |
| C27 | GREEN | 小库 12 行+大库 1338 行：指针区间/台账 docFileSha256/原文 md 整文件 sha 全部独立复算一致；h/entryHash 字段 0 |
| C28 | GREEN | 追加 1 行→索引 +1（written=1/removed=0；视图重扫 0；读放大 0.0×） |
| C29 | GREEN | 删 .index（3 分片/12 行）→ stat 检出 index-missing → 重建 3 分片逐字节相等、rows=12、stat.ok=true；形态=按日分片≤4 MiB（S-10④） |
| C30 | GREEN | 小库 3 个区间逐 code 一致（12/8/8 行）；大库 3 个区间逐 code 一致（1338/690/678 行） |
| C31 | GREEN | 三层夹具 anchor=2026-11-22（今天）：hot(session-three00… 2 行/202611) · warm(session-three00… 2 行/202606+202608) · cold(session-three00… 2 行/202508+202510)；按 sid 查三路（索引 2/2/2 行 · 暴力台账 · 公共 searchLedger）逐 code 一致；指针问题 0；窗口 0 / [90,180] / [366,∞] 天；跨 5 个月份 |
| C32 | GREEN | 起始分片定位正确（3 个 code）；E3 最坏 6.60 ms ≤ 阈值 50 ms（口径：非 O(1)，code 日起向后有界扫描；3 年 402 MB 未测） |
| C33 | GREEN | 2 例未命中均返回 searchedRange+olderAvailable+hint（code 例 exit 1、空档 olderAvailable=true 且 searchedRange=20261016..20261022） |
| C34 | GREEN | 今天（=数据最新日） 4.03 ms/100 ms（1 分片）；90 天 31.09 ms/1000 ms（45 分片）；指定冷月 21.63 ms/2000 ms（30 分片）；规模=45 天，3 年档未测 |
| C35 | GREEN | 冷月 202609 range=20260901..20260930：只读该月 30 个分片、月份集={202609}、范围外 0；命中 900=暴力 900 |
| C36 | GREEN | E3 索引 141.8 KB/台账 1.18 MB=11.76%（主判）；/整库包 0.250%；含 state 12.05% → 均 ≤15% |
| C37 | GREEN | 全量拷 37 文件→追加 1 行→增量只拷 1 文件（4584 B；unchanged 36）→verify ok；备份目录整拷后 verify ok（38 文件/607.9 KB） |

汇总：GREEN=13 RED=0 NA=0 SKIP=0 → 全绿

