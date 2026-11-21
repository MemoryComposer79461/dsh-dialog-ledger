/**
 * @file 工具-核验收据.mjs
 * @role 只读核验「防篡改收据链」：链是否连续、台账是否被改过、原文数量是否对得上。
 * @run
 *   node docs/工具-核验收据.mjs --root=<数据总库> --anchor=<库外锚目录> [--json]
 *   node docs/工具-核验收据.mjs --root=<数据总库>        # 锚为空 = 功能关闭（REC-06）
 * @exit 契约 v2.1 §REC-10：
 *   0 = 全部通过 / 功能关闭；2 = 发现差异；3 = 用法/配置错误（anchor 不存在/不可读/参数错）；4 = 内部错误
 *
 * @why 这是"审计师可独立跑"的那一件：
 *      收据在库外锚目录、台账在数据总库；本工具只读两边、重算 sha256、逐日比对。
 *      任何"改一行台账""删一天台账""改一张收据"都会在这里暴露。
 *
 * @why 输出两种形态：
 *   · 默认 markdown：给人看（结论 + 差异明细 + 处置建议）；
 *   · `--json`：给机器看（契约 §REC-10 的 {v,enabled,anchor,checks,breaks}），退出码同时给语义。
 *
 * @why 收据双路径：新收据写 flat `<anchor>/RECEIPT-YYYYMMDD.json`（§1.1），
 *      但 v0.5 早期在 `<anchor>/receipts/` 下写过的旧收据必须仍可核验（旧锚上的证据不能作废）。
 *
 * @readonly 本工具**绝不写盘**（运行前后 root/anchor 文件 sha256 集合不变，验收 REC-05/REC-10 断言）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { verifyReceipts, listReceipts, RECEIPT_VERSION } from '../lib/receipt.js';

const USAGE =
  '用法: node docs/工具-核验收据.mjs --root=<数据总库> [--anchor=<库外锚目录>] [--json]\n' +
  '      （--anchor 省略/为空 = 功能关闭，输出 {"enabled":false,"breaks":[]} 且 exit 0）';

function parseArgs(argv) {
  const out = { json: false };
  for (const a of argv.slice(2)) {
    if (a === '--json') { out.json = true; continue; }
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** 输出 JSON（一行）——JSON 模式下 stdout 只允许这一个 JSON 文档。 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 契约 §REC-10 的 JSON 外壳。
 *  ★ v1.0.0-re2（S-11 C42）：外壳版本 v 是**工具契约版本，恒 1**（旧测试/外部读法看它）；
 *    摘要格式版本单独放 `receiptVersion`（10 键 v1 → 11 键 v2 时只变后者，不动外壳契约）。
 */
function payload({ enabled, anchor, checks = [], breaks = [] }) {
  return { v: 1, receiptVersion: RECEIPT_VERSION, enabled: !!enabled, anchor: String(anchor || ''), checks, breaks };
}

/** 统一出口：用 exitCode 而不是 process.exit（避免 Windows 管道下 stdout 被截断）。 */
function exitWith(code) {
  return code;
}

function renderMarkdown({ root, anchor, receipts, result }) {
  const L = [];
  const breaks = result.breaks || [];
  L.push('# 收据链核验报告');
  L.push('');
  L.push('- 数据总库：`' + path.resolve(root) + '`');
  L.push('- 库外锚目录：`' + path.resolve(anchor) + '`');
  L.push('  （新收据格式：flat `RECEIPT-YYYYMMDD.json`；兼容旧 `<anchor>/receipts/` 子目录收据）');
  L.push('- 收据张数：' + receipts.length +
    '（' + (receipts.length ? receipts[0].date + ' ~ ' + receipts[receipts.length - 1].date : '无') + '）');
  L.push('- 结论：' + (result.ok ? '**一致（未发现改动/断链）**' : '**发现 ' + breaks.length + ' 处差异**'));
  L.push('');
  if (receipts.length > 0) {
    L.push('| 日期 | 行数 | 台账 sha256（收据） | 前日链 |');
    L.push('|---|---:|---|---|');
    for (const it of receipts) {
      const r = it.json || {};
      L.push('| ' + it.date + ' | ' + (r.ledgerRows === undefined ? '?' : r.ledgerRows) + ' | `' +
        String(r.ledgerSha256 || '').slice(0, 16) + '…` | ' +
        (r.prevReceiptSha256 ? '`' + String(r.prevReceiptSha256).slice(0, 16) + '…`' : '（首张）') + ' |');
    }
    L.push('');
  }
  if (breaks.length > 0) {
    L.push('## 差异明细');
    L.push('');
    for (const b of breaks) {
      const kind = b.kind || b.type;
      const ev = ' —— expected=' + JSON.stringify(b.expected === undefined ? '' : String(b.expected)) +
        ' actual=' + JSON.stringify(b.actual === undefined ? '' : String(b.actual));
      L.push('- **' + b.date + '** `' + kind + '`：' + (b.detail || kind) + ev);
    }
    L.push('');
    L.push('> 处置建议：**不要**直接改台账/收据。先保留下现场（整目录复制），');
    L.push('> 再由人判断是"意外损坏"还是"人为改动"；凭证/台账的更正只能走补充登记。');
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('**结束** · 生成器 dsh-dialog-ledger-v0.5/工具-核验收据（契约 v2.1）');
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const jsonMode = !!args.json;
  const root = typeof args.root === 'string' ? args.root : '';
  const anchor = typeof args.anchor === 'string' ? args.anchor.trim() : '';

  // ---- 用法错误（缺 root）→ 3 ----
  if (!root) {
    if (jsonMode) emit(payload({ enabled: !!anchor, anchor: anchor ? path.resolve(anchor) : '', breaks: [{ kind: 'USAGE', date: '', expected: USAGE, actual: '' }] }));
    else process.stderr.write(USAGE + '\n');
    return exitWith(3);
  }

  // ---- REC-06：锚为空 = 功能关闭 → 不报错、不写盘、输出 {"enabled":false,"breaks":[]}、exit 0 ----
  if (!anchor) {
    emit(payload({ enabled: false, anchor: '', checks: [], breaks: [] }));
    return exitWith(0);
  }

  // ---- 配置错误（root/anchor 不存在/不可读/不是目录）→ 3 ----
  const configError = (kind, msg) => {
    if (jsonMode) emit(payload({ enabled: true, anchor: path.resolve(anchor), checks: [{ name: kind, ok: false }], breaks: [{ kind, date: '', expected: msg, actual: '' }] }));
    else process.stderr.write(msg + '\n');
    return exitWith(3);
  };
  if (!fs.existsSync(root)) return configError('ROOT_UNREADABLE', '数据总库不存在: ' + root);
  if (!fs.existsSync(anchor)) return configError('ANCHOR_UNREADABLE', '锚目录不存在: ' + anchor);
  try {
    if (!fs.statSync(anchor).isDirectory()) return configError('ANCHOR_UNREADABLE', '锚路径不是目录: ' + anchor);
    fs.readdirSync(anchor);
  } catch (e) {
    return configError('ANCHOR_UNREADABLE', '锚目录不可读: ' + anchor + '（' + ((e && (e.code || e.message)) || e) + '）');
  }

  // ---- 核验（只读）----
  let result;
  try {
    result = verifyReceipts({ root, anchorRoot: anchor });
  } catch (e) {
    if (jsonMode) {
      emit(payload({
        enabled: true, anchor: path.resolve(anchor),
        checks: [{ name: 'internal', ok: false }],
        breaks: [{ kind: 'INTERNAL_ERROR', date: '', expected: '', actual: String((e && e.message) || e) }],
      }));
    } else {
      process.stderr.write('内部错误: ' + ((e && e.message) || e) + '\n');
    }
    return exitWith(4);
  }

  const breaks = (result.breaks || []).map((b) => ({
    kind: b.kind || b.type || 'UNKNOWN',
    date: b.date || '',
    expected: b.expected === undefined ? '' : String(b.expected),
    actual: b.actual === undefined ? '' : String(b.actual),
  }));

  if (jsonMode) {
    emit(payload({ enabled: true, anchor: path.resolve(anchor), checks: result.checks || [], breaks }));
  } else {
    const receipts = listReceipts(anchor);
    process.stdout.write(renderMarkdown({ root, anchor, receipts, result }) + '\n');
  }
  return exitWith(breaks.length > 0 ? 2 : 0);
}

const code = await main();
process.exitCode = code;
