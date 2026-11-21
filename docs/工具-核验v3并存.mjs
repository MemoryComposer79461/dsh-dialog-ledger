/**
 * @file 工具-核验v3并存.mjs
 * @role 离线核验 v3/v4 会话文件：哪些会话只有 v3、哪些 v3/v4 并存、并存对是否真超集。
 * @run `node docs/工具-核验v3并存.mjs [sessionsBase]`
 *      默认 sessionsBase = $DSH_HOME/sessions（或 ~/.dsh/sessions）
 * @exit 0 = 全部并存对核验通过；1 = 存在"v4 不是 v3 超集"的对（需人工决定补历史）
 *
 * @why 为什么不在每轮扫描里做：
 *      核验要全量解压两口文件（38 MB 级），每 60 秒跑一次会把宿主卡死。
 *      它属于"月度/开账前核验"的离线工具，不是记账主路径的一部分。
 *
 * @why 为什么这工具必须存在：
 *      "v3/v4 并存时一律选 v4"这个决定的前提是"v4 ⊇ v3"。
 *      没有核验，这个前提就是**假设**；有了核验，它才是**证据**。
 *      审计上：任何"假设"都必须有对应的检验手段，否则等于没记录。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanSessionSources, auditPairs, readSourceTurns } from '../lib/legacy.js';

function sessionsBaseFromArgs() {
  const arg = process.argv[2];
  if (arg && arg.trim()) return path.resolve(arg.trim());
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

function iso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  // 只用于打印，统一 +08:00（口径 3）
  const d = new Date(ms + 480 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const base = sessionsBaseFromArgs();
if (!fs.existsSync(base)) {
  console.error('sessionsBase 不存在: ' + base);
  process.exit(2);
}

const r = scanSessionSources(base);
const v3Only = r.supported.filter((s) => s.source === 'v3');

console.log('# v3/v4 会话文件核验报告');
console.log('');
console.log('- sessionsBase：`' + base + '`');
console.log('- 会话总数：' + r.supported.length +
  '（v4 源 ' + r.supported.filter((s) => s.source === 'v4').length +
  ' ｜ v3 源 ' + v3Only.length + '）');
console.log('- v3/v4 并存对：' + r.pairs.length);
console.log('- 未知/不支持版本：' + r.unsupported.length);
console.log('');

if (r.unsupported.length) {
  console.log('## 不支持的版本（必须人工处理）');
  console.log('');
  for (const u of r.unsupported) console.log('- v' + u.version + '：`' + u.path + '`');
  console.log('');
}

if (v3Only.length) {
  console.log('## 只有 v3 的会话（历史源 = v3，只读补账）');
  console.log('');
  console.log('| 会话 | 轮次 | 起 | 止 |');
  console.log('|---|---:|---|---|');
  let total = 0;
  for (const s of v3Only) {
    let turns = 0;
    let first = null;
    let last = null;
    try {
      const t = readSourceTurns(s, { fromByte: 0 });
      turns = t.closed.length;
      for (const x of t.closed) {
        if (first === null || x.startMs < first) first = x.startMs;
        if (last === null || x.endMs > last) last = x.endMs;
      }
    } catch (e) {
      console.log('| `' + path.basename(s.dir) + '` | 读失败 | — | — |');
      continue;
    }
    total += turns;
    console.log('| `' + path.basename(s.dir) + '` | ' + turns + ' | ' + iso(first) + ' | ' + iso(last) + ' |');
  }
  console.log('');
  console.log('> v3 可补轮次合计：**' + total + '**');
  console.log('');
}

if (r.pairs.length) {
  console.log('## v3/v4 并存对（按「v4 优先」纳入，须核验超集关系）');
  console.log('');
  const audit = auditPairs(r.pairs);
  console.log('| 会话 | 结论 | v3 事件/首条 | v4 事件/首条 | 说明 |');
  console.log('|---|---|---|---|---|');
  for (const a of audit) {
    console.log('| `' + a.sid + '` | ' + (a.ok ? '✅ 超集' : '❌ **不通过**') + ' | ' +
      a.v3.events + ' / ' + iso(a.v3.firstMs) + ' | ' +
      a.v4.events + ' / ' + iso(a.v4.firstMs) + ' | ' + a.reason + ' |');
  }
  console.log('');
  const bad = audit.filter((a) => !a.ok);
  if (bad.length) {
    console.log('## ❌ 不通过的对（必须人工决定是否补前缀历史）');
    console.log('');
    for (const a of bad) console.log('- `' + a.sid + '`：' + a.reason);
    console.log('');
  }
}

console.log('---');
console.log('');
console.log('**结束** · 生成器 dsh-dialog-ledger/v0.5 · 工具-核验v3并存');

const bad = r.pairs.length ? auditPairs(r.pairs).filter((a) => !a.ok) : [];
process.exit(bad.length > 0 ? 1 : 0);
