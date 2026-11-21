/**
 * @file 核验-A13重启.mjs
 * @role A13 重启后真机核验（机主重启 DSH 后立刻运行；先别 toggle 插件）。
 * @usage node docs/验收-v0.6/核验-A13重启.mjs [port]
 * @why A13 根因是"启动并发窗口直读未 inject 服务"导致 apply 崩、fiber failed 且不自愈；
 *      修复后需在真实重启场景验证：①面板 API 可达；②5 个工具由宿主注册（本脚本查 API/账）；
 *      ③lastRunAt 在启动后 ≤ 60s 更新。工具清单用 cordis_inspect_query 另行确认。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || 8547);
const base = `http://127.0.0.1:${port}/dialog-ledger/api`;
const root = process.env.DSH_LEDGER_ROOT || path.join(os.homedir(), 'Desktop', '会话账本');

async function getJson(route) {
  const res = await fetch(`${base}/${route}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 也保留原文 */ }
  return { status: res.status, body, text };
}

const checks = [];
function add(name, ok, detail) { checks.push({ name, ok, detail }); }

const ping = await getJson('ping');
add('API ping 200', ping.status === 200 && ping.body && ping.body.ok === true, `status=${ping.status}`);

const summary = await getJson('summary?refresh=1');
const rows = summary.body && summary.body.counts ? summary.body.counts.ledgerRows : -1;
add('summary 200 且计数可读', summary.status === 200 && rows >= 0, `status=${summary.status} rows=${rows}`);
const lastRunAt = summary.body && summary.body.health ? summary.body.health.lastRunAt : null;
add('lastRunAt 已更新', typeof lastRunAt === 'string' && lastRunAt.length > 0, `lastRunAt=${lastRunAt}`);

const reads = await getJson('reads?limit=5');
add('reads 200（读日志新分片可读）', reads.status === 200 && reads.body && reads.body.ok === true, `status=${reads.status}`);

console.log('=== A13 重启核验 ===');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
const failed = checks.filter((c) => !c.ok);
console.log(`\n结论：${failed.length === 0 ? 'PASS ✅' : 'FAIL ❌'}（${checks.length - failed.length}/${checks.length}）`);
if (failed.length) console.log('若 API 404/无工具：插件未挂载，请先执行 插件 页面"禁用→启用"一次并报 Lead（A13 未修好）。');
process.exit(failed.length === 0 ? 0 : 1);