# 02 · persistence 真机探针（V1/V2 结论）

> 方法：在插件 `apply` 里注入**只读探针**（触发条件：桌面存在 `_dl-probe.flag`），热装后立刻探测
> `ctx.get('sessionPersistence')`；只写 `%TEMP%\dsh-dialog-ledger-probe.log`，**不写账本/原文/周账**；
> 探针在验证后已从代码移除（`grep probePersistence` 为空）。
> 时间：2026-11-10 12:47Z（本地 20:47）；宿主实例：port 3060（第 5 次启动，A13 自动挂载正常）。

## 一、V1：`SessionHandle.read(offset,length)` 的 `offset` 是不是 `seq`？

**结论：是（同一坐标系，可从任意 seq 起点读）。**

证据（`probe.log` 摘录，两个会话都测了）：

```
read offset=0 length=2 → count=2 firstSeqs=[0,1]   firstTypes=["permission/preset","sandbox/mode"]
read offset=1 length=2 → count=2 firstSeqs=[1,2]   firstTypes=["sandbox/mode","approval/policy"]
read offset=999999 length=1 → count=0              （EOF 返回空数组，不抛）
```

→ 增量算法可安全用 `cursorSeq` 续读；EOF 用 `events.length===0` 判定；游标推进 `lastSeq+1`。

## 二、V2：`stat()` / `list()` 是否带 `eventCount`？

**结论：不带。** 返回对象键固定为：

```
list()/stat(id) → {
  header: { version:4, id, createdAt, cwd, isSeeded, ... },   // 注意：id 可能在 header.id
  formatStatus: 'ok',
  revision: '657990099:1125899907060717:1012:1794308670592775500:1794308670592775500',
  sizeBytes: 1012,
  location: { kind:'jsonl', path:'C:\\Users\\...\\session.v4.jsonl(.zstd)' }
}
```

- 无 `eventCount` → **不能免读日志做"事件数对账"**；变化检测用 `revision` 字符串相等（同实例内"相等=没变"），增量用 `seq` 游标。
- `revision` 是复合令牌字符串（非数字、不可排序）；跨重启是否仍可相等=没变 → V7 仍待验，故**不落 state**，只内存对账。
- `list()` 返回 11 个会话（本机当前）；条目里 `id` 可能在 `header.id`（真机两种都出现过，采集器已两处兜底）。

## 三、`open('read')` 的句柄与 read 返回形状（新增事实）

- 句柄键：`storage, id, header, access, state, lease, chain, closing, observedLength, buffered, batchTimer, drainPaused, draining`；有 `read` / `close`。
- `read(offset,length)` 返回 `{ eventState, events: [...] }`；`eventState` 是**字符串状态**（本机 `"shared-frozen"`），不是计数对象。
- `events[i]` 形状：`{ type, seq, time, data }`（seq 连续；`time` 毫秒）；`turn/start|turn/end` 与磁盘同构，`turn/end` 的 reason 为 `data.reason.kind`。

## 四、对采集器的落库修正（已实现）

| 修正 | 依据 |
|---|---|
| `normalizeRef` 增加 `x.header.id` 兜底（真机 id 在 header 内） | 探针 list/stat |
| `readClosedTurns` 透传 `batch.eventState` | 探针 read 返回 `{eventState,events}` |
| 无 `seq` 的事件 → `warnings.push('SEQ_MISSING')` 并停止（防死循环） | 真机 events 有 seq，但防御未来形状 |
| 不依赖 `eventCount`；增量只靠 seq 游标 + revision 相等性 | V2 结论 |

## 五、仍然待验（不阻塞影子阶段）

V3 事件订阅覆盖、V5 flush 时序、V6 跨进程可见性、V7 revision 跨重启、V8 bootstrap 成本、V9 字节级差异、V10 listener 行为、V11 错误码、V12 行内附加字段外部工具兼容性 —— 均列在 `_V07采集API调研.md` §7，按需在切 `persistence` 模式前补齐。

## 六、可复现

探针代码已移除；复现方式：在 `index.js apply` 内临时注入等价只读探测（同款 flag 触发），热装 → 读 `%TEMP%\dsh-dialog-ledger-probe.log`。
