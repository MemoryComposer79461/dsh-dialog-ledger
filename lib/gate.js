/**
 * @file gate.js
 * @role **闸门三级判定**（V0.6.1 / D18-C；v0.9.1 / C18 收窄输入）：把 `reconcile()` 的结果判成
 *       `ok / degraded / unknown` 三种结论。
 *
 * @why 为什么需要三级（机主 2026-11-10 签的"四张字"之 #2）：
 *   两级 `ok / unknown` 让"知道有问题"和"不知道"挤在同一个格子里：
 *   · 老账库有历史无证据行（已被 legacy 基线标记）→ 永远 unknown = 等于没有区分力；
 *   · 真的缺凭证、缺周账 → 也是 unknown —— 但那是**已知且可枚举**的缺口，不是"无法表示意见"。
 *   三级让结论对得上会计的三种意见：
 *   · `ok`       = 无保留（六项全过，且没有 legacy 类已知缺口）
 *   · `degraded` = **有保留**（已知且逐项可枚举的缺口；账本本身读全、唯一性成立）
 *   · `unknown`  = **无法表示意见**（4 项判据输入没全成立 / 防御分支：ok 非 true 却列不出缺口）
 *
 * @why C18：判据输入**恰好 4 项**（总纲 §5.5 "输入 12 项 → 4 项"；0.9.1 钉死为下面 4 个信任条件）：
 *   | # | 输入                    | 怎么变 unknown（degraded 见 ②）              |
 *   | 1 | `ledgerOk`              | 台账没读全（readErrors/badLines）            |
 *   | 2 | `codeUnique`            | code 重复                                    |
 *   | 3 | `sidTurnUnique`         | (sid,turn) 重复                              |
 *   | 4 | `legacyMarks.chainOk`   | legacy 基线链断裂 / 缺 legacy 基线信息       |
 *   判定顺序写死：
 *   ① 4 项**逐项**必须显式为 `true`（缺键按 `unknown` 处理，绝不默认通过）——不成立就是 unknown；
 *   ② 4 项全成立 → 枚举已知缺口：有 → degraded；没有 → ok；
 *   ③ 防御分支：`rec.ok !== true` 却枚举不出任何缺口 → unknown（实现/公式不一致，不许当"没问题"）。
 *   ★ 其余 reconcile 字段（缺凭证/缺周账/收据链/封板链/legacy 计数…）**不是判据输入**，
 *     只用于给 `degraded` 提供可枚举的 `knownGaps` 明细（旧 12 项调用方照样能拿到明细）。
 *   ★ 兼容：`index.js` 仍传旧的整份 reconcile 结果（12 项）—— 多余键**忽略**，
 *     4 项里缺任何一项按 `unknown` 处理（绝不默认通过）；`rec` 为空 = 无对账记录 → unknown。
 *
 * @why 纯函数：不读盘、不看时间、不做 I/O —— 这样单测能穷举所有分支，
 *   入口（index.js）只负责把 `reconcile()` 结果传进来、把结论落运行报告。
 *
 * @depends 无（零依赖）
 */

// ★ v1.0.0-preview4（F1/R1·R2）：版本 2 → 3。新增"未闭合轮（源已静止）"这一条**可枚举缺口**来源：
//   它由调用方以 `classifyGate(rec, {staleOpenTurns})` 传入（对账结果本身读不到源 mtime）。
//   不传 = 行为与 v2 完全一致（老调用方/老用例不受影响）。
export const GATE_VERSION = 3;
export const GATE_CONCLUSIONS = Object.freeze(['ok', 'degraded', 'unknown']);

/**
 * C18：判据输入**恰好这 4 项**（顺序即判定顺序）。
 * 测试用 `GATE_INPUTS.length === 4` 钉死口径 —— 任何人再加第 5 项都会先红。
 */
export const GATE_INPUTS = Object.freeze([
  'ledgerOk',
  'codeUnique',
  'sidTurnUnique',
  'legacyMarks.chainOk',
]);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arrLen = (v) => (Array.isArray(v) ? v.length : 0);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * 读 4 项判据输入（旧 12 项整份 rec / 只带 4 项的瘦输入都按同一口径读 `{present, value}`）。
 *
 * @why 必须区分"缺键"与"给了 false"：缺键 = 调用方没提供判据 → unknown（不许默认通过）；
 *      false = 明确判据不成立 → unknown（原因文案不同，便于排查）。
 */
function readInputs(rec) {
  const marks = rec.legacyMarks && typeof rec.legacyMarks === 'object' ? rec.legacyMarks : null;
  return {
    ledgerOk: { present: has(rec, 'ledgerOk'), value: rec.ledgerOk },
    codeUnique: { present: has(rec, 'codeUnique'), value: rec.codeUnique },
    sidTurnUnique: { present: has(rec, 'sidTurnUnique'), value: rec.sidTurnUnique },
    'legacyMarks.chainOk': {
      present: !!marks && has(marks, 'chainOk'),
      value: marks ? marks.chainOk : undefined,
    },
  };
}

/**
 * 把 reconcile 结果判成三级闸门结论。
 *
 * @param {object|null} rec `reconcile()` 的返回值（或它的落盘副本；旧 12 项 / 瘦输入均可）
 * @returns {{conclusion:'ok'|'degraded'|'unknown', reason:string, knownGaps:string[],
 *            canEnumerate:boolean, unchecked:string[], inputs:Object<string,boolean>,
 *            failedInputs:string[], missingInputs:string[]}}
 *          `inputs`：4 项判据输入的布尔投影（C18 口径，逐项可查）；
 *          `failedInputs`/`missingInputs`：未成立的 4 项 / 缺键的 4 项（未知原因可逐项定位）；
 *          `knownGaps`：可枚举的已知缺口（degraded 的依据，必须逐项列出）；
 *          `unchecked`：导致 unknown 的"无法信任清单"的原因（4 项不成立/防御分支）。
 */
export function classifyGate(rec, extra = {}) {
  const out = {
    conclusion: 'unknown', reason: '', knownGaps: [], canEnumerate: false, unchecked: [],
    inputs: {}, failedInputs: [], missingInputs: [],
  };
  if (!rec || typeof rec !== 'object') {
    out.unchecked.push('无对账结果');
    out.reason = out.unchecked.join('; ');
    return out;
  }

  // ── ① 4 项判据输入：逐项必须显式 true（缺键 → unknown） ──────────────────
  const inputs = readInputs(rec);
  out.inputs = {
    ledgerOk: inputs.ledgerOk.value === true,
    codeUnique: inputs.codeUnique.value === true,
    sidTurnUnique: inputs.sidTurnUnique.value === true,
    legacyMarksChainOk: inputs['legacyMarks.chainOk'].value === true,
  };
  for (const id of GATE_INPUTS) {
    const it = inputs[id];
    if (it.present && it.value === true) continue;
    out.failedInputs.push(id);
    if (!it.present) {
      out.missingInputs.push(id);
      out.unchecked.push('缺少判据输入「' + id + '」（缺键按 unknown 处理）');
      continue;
    }
    if (id === 'ledgerOk') {
      out.unchecked.push('台账未读全（readErrors=' + arrLen(rec.readErrors) + ', badLines=' + num(rec.badLines) + '）');
    } else if (id === 'codeUnique') {
      out.unchecked.push('code 不唯一');
    } else if (id === 'sidTurnUnique') {
      out.unchecked.push('(sid,turn) 不唯一');
    } else {
      out.unchecked.push('legacy 基线链断裂（历史归类不可信）');
    }
  }
  out.canEnumerate = out.unchecked.length === 0;
  if (!out.canEnumerate) {
    out.conclusion = 'unknown';
    out.reason = out.unchecked.join('; ');
    return out;
  }

  // ── ② 枚举已知缺口（4 项全成立时才有意义；明细字段不是判据输入） ─────────
  const gaps = out.knownGaps;
  const push = (label, n) => { if (num(n) > 0) gaps.push(label + '=' + num(n)); };
  const marks = rec.legacyMarks && typeof rec.legacyMarks === 'object' ? rec.legacyMarks : null;
  push('缺凭证', arrLen(rec.originalMissing));
  push('孤儿凭证', arrLen(rec.originalOrphan));
  push('缺周账', arrLen(rec.weeklyGroupsMissing));
  push('缺口留痕', rec.lostGaps && num(rec.lostGaps.count));
  push('收据链断', num(rec.receiptBreakCount));
  if (!(rec.sealChain && rec.sealChain.ok === true)) gaps.push('封板链异常');
  // ★ D18：历史无证据（已基线标记）是**已知缺口**，不是"没问题"
  push('历史无证据(legacy)', num(rec.legacyUnverifiableCount));
  push('历史基线未标记无证据', marks ? num(marks.unmarked) : 0);
  push('历史基线指纹不符', marks ? num(marks.mismatched) : 0);
  push('历史基线孤儿标记', marks ? num(marks.orphan) : 0);
  // ★ F1（v1.0.0-preview4 · R1/R2「零静默」）：未闭合轮 + 源已静止 = **已知且可枚举**的缺口。
  //   @why 旧实现只写 `.pending.jsonl`，gate 不读它 → 会话在某一轮中途永久终止时，
  //        这一轮永远不入账，而面板报 ok/degraded（由别的缺口凑的）——"静默丢账"。
  //   谁传：调用方（index.js）在扫到未闭合轮时按"源 mtime 距now > 2×intervalSeconds"判 stale，
  //        把**只含 stale 的计数**传进来；活跃写入的进行中轮次不许传（否则每 tick 常红 = 假警报）。
  //   形状：`未闭合轮=<n>（源已静止 >2×interval，逐项见 run-report.openTurns）`
  //        —— 点名"未闭合轮"，让人一眼看出这是"该闭合却没闭合"，不是配额/体积之类。
  const staleOpen = extra && Number.isInteger(extra.staleOpenTurns) ? extra.staleOpenTurns : 0;
  if (staleOpen > 0) {
    const factor = extra && Number.isFinite(extra.staleAfterFactor) ? extra.staleAfterFactor : 2;
    gaps.push('未闭合轮=' + staleOpen + '（源已静止 >' + factor + '×interval，逐项见 run-report.openTurns）');
  }
  // ★ F2（v1.0.0-preview4 · R2）：封板后补记连续 3 次失败 → 已放弃自动重试 = 已知且可枚举的缺口。
  //   调用方每 tick 幂等重放；这里只报"放弃的"（重试中的属正常自愈过程，不制造每 tick 常红）。
  const supGaveUp = extra && Number.isInteger(extra.pendingSupplements) ? extra.pendingSupplements : 0;
  if (supGaveUp > 0) {
    gaps.push('补记待补=' + supGaveUp + '（连续 3 次写失败已放弃自动重试，逐项见 run-report.supplementPending）');
  }

  // ── ③ 结论 ─────────────────────────────────────────────────────────────
  if (rec.ok === true && gaps.length === 0) {
    out.conclusion = 'ok';
    out.reason = '';
    return out;
  }
  if (gaps.length > 0) {
    out.conclusion = 'degraded';
    out.reason = gaps.join('; ');
    return out;
  }
  // ok 非 true 却枚举不出缺口：公式/实现不一致 —— 不许当"没问题"，也不许当"有保留"
  out.conclusion = 'unknown';
  out.reason = 'ok 非 true 且无可枚举缺口（实现与公式不一致，必须排查）';
  return out;
}
