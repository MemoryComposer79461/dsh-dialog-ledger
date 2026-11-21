/**
 * @file _criteria.mjs
 * @role v0.5 验收判据注册表（P0 七条 + P1 十二条 + REC 七条 = 26 条）。
 *
 * 用途：
 *   · 各测试用例声明自己覆盖哪些判据 ID；
 *   · 总控按注册表算「通过 / 失败 / 未覆盖」，未覆盖必须写原因 —— 这正是审计
 *     K3.1 Pro 批评的"未覆盖却宣称通过"要根治的点。
 *
 * 依据：`<test-dir>\work\v0.5\01-v0.5-范围重定-审计驱动.md` 第四节判据表（权威）。
 */

export const CRITERIA = {
  'P0-1': { group: 'P0', title: '源文件缩小/同大小重写 → 新事件必须被读到，游标不沿用旧边界' },
  'P0-2': { group: 'P0', title: '未闭合 Turn 补 turn/end 后恰好一个闭合版本；旧 partial 必须标"被取代"' },
  'P0-3': { group: 'P0', title: '首跑/补账事件收集有界（批数/事件数/字节数）+ 可取消 + 杀进程可续' },
  'P0-4': { group: 'P0', title: '120/121/122 封板哈希互不相同；溢出编码有去向；封板另存不可变 sealRows 快照' },
  'P0-5': { group: 'P0', title: '原文工具参数不得静默截断；展示层可截断但必须有标记+原始长度+附件指针' },
  'P0-6': { group: 'P0', title: '物理清理默认关闭，只允许只读统计 + dry-run；旧清理工具封锁' },
  'P0-7': { group: 'P0', title: '凭证不可覆盖（已具备）+ 完整文件哈希 + 失败回退游标且留痕' },
  'P1-1': { group: 'P1', title: '台账记完整文件哈希；"绑定"须复核实际文件，异常不得显示 bound' },
  'P1-2': { group: 'P1', title: 'append 前补尾换行、批次末 fsync、坏行移 quarantine 并上报' },
  'P1-3': { group: 'P1', title: 'initialized 必须看 deferred，首跑被截断不得被热窗口永久挡掉' },
  'P1-4': { group: 'P1', title: '停机超窗口 → cutoff = min(hotWindow, lastRunAt−2×interval)，不得永久漏记' },
  'P1-5': { group: 'P1', title: 'failed>0 不推进游标，落永久错误清单' },
  'P1-6': { group: 'P1', title: '补记/清册序号统一 \\d+，99/100/101 不重复不忽略，验证器不得忽略未知块' },
  'P1-7': { group: 'P1', title: '交接表接线进扫描循环（先 adopt 后 generate），失败只记 errors' },
  'P1-8': { group: 'P1', title: '读取失败必须结构化报错；空数据只能由成功读取证明' },
  'P1-9': { group: 'P1', title: '运行缓存与封板证据分离（追加式 seal journal）；state 丢失只影响性能' },
  'P1-10': { group: 'P1', title: '"已清理"判定按结论列，不看任意单元格' },
  'P1-11': { group: 'P1', title: '周记账列结构对齐契约（十列；四态固定到原文列；RPT 号不写备注）' },
  'P1-12': { group: 'P1', title: '原文目录按编码日期段取月（不是轮发生月）' },
  'REC-1': { group: 'REC', title: '每日收据字段齐全：v/date/offsetMinutes/lastCode/ledgerRows/ledgerBytes/ledgerSha256/originalCount/prevReceiptSha256/generatedAt' },
  'REC-2': { group: 'REC', title: '收据链：prevReceiptSha256 指向前一日收据 sha256；断链报 CHAIN_BREAK' },
  'REC-3': { group: 'REC', title: '锚目录必须在账本 root 之外（同路径拒绝 ANCHOR_INSIDE_ROOT）' },
  'REC-4': { group: 'REC', title: '同日重跑幂等；证据变化 → RECEIPT_CONFLICT 且不改写旧收据' },
  'REC-5': { group: 'REC', title: '只读校验器可离线核链：改台账→LEDGER_CHANGED；删台账→LEDGER_MISSING；删收据→CHAIN_BREAK' },
  'REC-6': { group: 'REC', title: 'receiptAnchorRoot 为空 = 关闭（默认），不得报错' },
  'REC-7': { group: 'REC', title: '锚目录落桌面，机主手动搬 U 盘；Agent 不读写 U 盘；校验器支持 --anchor 任意路径' },
};

export const ALL_CRITERIA = Object.keys(CRITERIA);
export const GROUP_IDS = {
  P0: ALL_CRITERIA.filter((k) => k.startsWith('P0-')),
  P1: ALL_CRITERIA.filter((k) => k.startsWith('P1-')),
  REC: ALL_CRITERIA.filter((k) => k.startsWith('REC-')),
};
export const groupOf = (id) => (id.startsWith('P0-') ? 'P0' : id.startsWith('P1-') ? 'P1' : 'REC');
