// 判据-0.9.1.mjs — 0.9.1 正式版 C01–C18 执行器（lite 线）
//
// 用途：把总纲 §7 的 A/B/C 三组判据（C01–C18）逐条落到可执行命令，输出红/绿表 + 证据文件。
// 铁律：**未验 ≠ 通过**。缺环境/缺工具 → 记 `NA`（未验），不算绿。
//
// 用法：
//   node docs\判据-0.9.1.mjs --lab=<lab 目录>            # lab 含 root\（账库）与 sessions\（或 dsh-home\sessions）
//   node docs\判据-0.9.1.mjs --lab=... --only=C14,C15
//   node docs\判据-0.9.1.mjs --skip-slow                  # 跳过 C17（变异反证约 10 分钟）
//   node docs\判据-0.9.1.mjs --json
//   node docs\判据-0.9.1.mjs --evid-dir=<dir> --work-dir=<dir>   # 证据/临时区落点（判据-1.0 聚合时必传）
//
// 退出码：0=全绿；1=有红或 NA；2=用法错误。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k) => { const p = args.find((a) => a.startsWith(`--${k}=`)); return p ? p.slice(k.length + 3) : ''; };
const only = (argOf('only') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const asJson = args.includes('--json');
const skipSlow = args.includes('--skip-slow');
const labArg = argOf('lab');
const LAB = labArg ? path.resolve(labArg) : '';
// 证据/临时区（re3，审计 P0：判据跑在交付包上时**不许写包外**）：
//   --evid-dir / --work-dir 由 docs/判据-1.0.mjs 显式传入（落本次证据目录 / %TEMP%）；
//   单独运行时默认落 %TEMP%，不写包上一级。
const EVID = path.resolve(argOf('evid-dir') || path.join(os.tmpdir(), 'dsh-ledger-evidence', '判据-0.9.1'));
const WORK091 = path.resolve(argOf('work-dir') || path.join(os.tmpdir(), 'dsh-ledger-work', '0.9.1'));

function findLab() {
  if (!LAB) return { ok: false, why: '未提供 --lab' };
  const root = path.join(LAB, 'root');
  const candidates = [
    path.join(LAB, 'sessions'),
    path.join(LAB, 'dsh-home', 'sessions'),
  ];
  const sessions = candidates.find((p) => fs.existsSync(p));
  if (!fs.existsSync(root)) return { ok: false, why: `lab 缺 root\\: ${root}` };
  if (!sessions) return { ok: false, why: `lab 缺 sessions（找过 ${candidates.join(' | ')}）` };
  return { ok: true, root, sessions };
}

const NODE = process.execPath;
const results = [];

function runCmd(label, file, extraArgs, timeoutMs = 180000) {
  fs.mkdirSync(EVID, { recursive: true });
  const r = spawnSync(NODE, [path.join(ROOT, file), ...extraArgs], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  const exit = r.error ? -1 : (r.status ?? -1);
  const safe = label.replace(/[\\/:*?"<>|]+/g, '_');
  const log = path.join(EVID, `${safe}.log`);
  fs.writeFileSync(log, `$ node ${file} ${extraArgs.join(' ')}\nexit=${exit}\n\n${r.stdout || ''}\n${r.stderr || ''}`, 'utf8');
  return { exit, log: path.relative(ROOT, log), error: r.error ? String(r.error.message || r.error) : '' };
}

function add(id, title, checks, redProof) {
  const row = {
    id, title,
    redProof: redProof || '',
    checks: [],
    status: 'NA',
    reasons: [],
  };
  if (only.length && !only.includes(id)) { row.status = 'SKIP'; results.push(row); return; }
  for (const c of checks) {
    if (c.skip) { row.reasons.push(c.skip); continue; }
    const r = runCmd(`${id}${c.name ? '-' + c.name : ''}`, c.file, c.args || [], c.timeoutMs);
    row.checks.push({ ...c, ...r });
    if (r.exit !== c.expectExit) row.reasons.push(`${c.name || c.file} 期望 exit ${c.expectExit}，实际 ${r.exit}${r.error ? '（' + r.error + '）' : ''}`);
  }
  if (row.checks.length === 0) row.status = 'NA';
  else row.status = row.reasons.length === 0 ? 'GREEN' : 'RED';
  results.push(row);
}

// ---------------------------------------------------------------------------
// 判据定义（与总纲 §7 A/B/C 三组一致；C14–C16 用机主 S-7 修订版）
// ---------------------------------------------------------------------------
const lab = findLab();
const labWhy = lab.ok ? '' : lab.why;
const labChecks = (fn) => (lab.ok ? fn(lab) : [{ skip: `环境缺失：${labWhy}` }]);

// A 组 · 保存正确
add('C01', '台账行数=真实轮数、(sid,turn)/code 唯一、坏行 0', labChecks(({ root, sessions }) => [
  { name: '语料四数', file: 'docs/工具-语料四数.mjs', args: [`--sessions=${sessions}`, `--root=${root}`], expectExit: 0 },
]), '工具对"行数≠轮数/重复主键/坏行"三类破坏给 FAIL（见工具内负例）');

add('C02', '重复 ingest 幂等（第二次 written=0）', [
  { name: '自测-index', file: 'docs/跑测试.mjs', args: ['docs/自测-index.mjs'], expectExit: 0 },
], '自测-index case E：连跑两次 written=0、账本总数不变');

add('C03', '追加一轮只写 1 行，不重复旧轮', [
  { name: '自测-v02', file: 'docs/跑测试.mjs', args: ['docs/自测-v02.mjs'], expectExit: 0 },
], '自测-v02：追加一轮 inc=1/written=1；再跑 written=0');

add('C04', '未闭合轮只进 pending，不进台账', [
  { name: '自测-index+边界', file: 'docs/跑测试.mjs', args: ['docs/自测-index.mjs', 'docs/自测-边界.mjs'], expectExit: 0 },
], '半截轮夹具：两扫只留 pending，补 end 后恰 1 条 ok');

add('C05', '单实例：第二个跳过并留日志', [
  { name: '自测-守卫', file: 'docs/跑测试.mjs', args: ['docs/自测-守卫.mjs'], expectExit: 0 },
], '守卫 ③·日志：捕获 LOCK_HELD…本轮跳过，且账本零写入');

add('C06', '文件变小/尾部不同 → 新内容入账、游标停在新边界', [
  { name: '自测-边界', file: 'docs/跑测试.mjs', args: ['docs/自测-边界.mjs'], expectExit: 0 },
], 'INV-04：截短重写后新 turn 必入账、游标==新文件帧边界');

add('C07', '文件正在写（半截）→ 本轮跳过、下轮入账、无 partial 残留', [
  { name: '边界+ledger', file: 'docs/跑测试.mjs', args: ['docs/自测-边界.mjs', 'docs/自测-ledger.mjs'], expectExit: 0 },
], '孤儿轮次·进行中 written=0/不写 partial；P1-5 末帧半截游标不推进');

add('C08', 'kill -9 → 重启从游标继续，不重复不丢', [
  { name: 'P0回归', file: 'P0验收/P0回归-v2.mjs', args: ['--only=P0-3-resume'], expectExit: 0, timeoutMs: 300000 },
], 'P0-3-resume：kill 后从已提交批次续跑');

// B 组 · 内容保真
add('C09', '每份 原始事件.json 与源会话对应轮次逐字节相等', labChecks(({ root, sessions }) => [
  { name: 'originals', file: 'docs/replay-verify.mjs', args: [`--root=${root}`, `--sessions=${sessions}`, '--originals'], expectExit: 0 },
]), '改一字节/删一份 → exit 1（工具内 --destroy 自检）');

add('C10', '每份视图 md 的正文 hash 可独立复算', labChecks(({ root, sessions }) => [
  { name: 'views', file: 'docs/replay-verify.mjs', args: [`--root=${root}`, `--sessions=${sessions}`, '--views'], expectExit: 0 },
]), '改正文/改 YAML hash → exit 1（工具内自检）');

add('C11', 'md 头写"视图非全集"且含省略条数', [
  { name: '自测-original', file: 'docs/跑测试.mjs', args: ['docs/自测-original.mjs'], expectExit: 0 },
], 'C11 用例：头三行含"视图非全集/省略 N 条"，N==YAML 被遮蔽事件数');

add('C12', '截断披露行与附件名/sha256 一致', [
  { name: '自测-original', file: 'docs/跑测试.mjs', args: ['docs/自测-original.mjs'], expectExit: 0 },
], 'P0-5/D11：三类披露行 + 附件；INV-21/22/23 交叉核（见验收-INV）');

add('C13', '编码 date 段 = 会话开始日（跨月不拆）', [
  { name: '自测-边界', file: 'docs/跑测试.mjs', args: ['docs/自测-边界.mjs'], expectExit: 0 },
], '跨零点/跨月两例，编码日期段均为会话开始日');

// C 组 · 不假绿
add('C14', '台账与原文逐字段一致（重放比对）', labChecks(({ root, sessions }) => [
  { name: 'fields', file: 'docs/replay-verify.mjs', args: [`--root=${root}`, `--sessions=${sessions}`, '--fields'], expectExit: 0 },
]), '--mutate/--destroy 注入必红（C15/C16 同源）');

const MUTATES = ['sid', 'turn', 'ts', 'seq', 'status', 'doc', 'attachment', 'code'];
add('C15', '改台账任一字段（8 种）→ 重放必红、坏行不得当成功读', labChecks(({ root, sessions }) => [
  ...MUTATES.map((m) => ({ name: `mutate-${m}`, file: 'docs/replay-verify.mjs', args: [`--root=${root}`, `--sessions=${sessions}`, `--mutate=${m}`], expectExit: 1 })),
]), '每条注入都必须 exit 1；若校验器失效 → exit 3（工具内自检）');

const DESTROYS = ['delete-row', 'extra-row', 'delete-attachment', 'flip-attachment-byte'];
add('C16', '删行/伪造行/删附件/改附件一字节 → 必红', labChecks(({ root, sessions }) => [
  ...DESTROYS.map((d) => ({ name: `destroy-${d}`, file: 'docs/replay-verify.mjs', args: [`--root=${root}`, `--sessions=${sessions}`, `--destroy=${d}`], expectExit: 1 })),
]), '四类破坏各一次，全部 exit 1');

add('C17', '变异反证：删修复逻辑 → 对应用例必红，且不是一堆红', [
  skipSlow
    ? { skip: '--skip-slow：本次跳过（约 10 分钟）' }
    : { name: '变异反证', file: 'docs/工具-变异反证.mjs', args: ['--json', `--work-dir=${path.join(WORK091, '变异反证')}`], expectExit: 0, timeoutMs: 1800000 },
], '工具判定"新增红==预期红"；出现一堆红 → exit 2；有变异未变红 → exit 1');

add('C18', 'gate 三级输入 4 项，每项都有 degraded 构造', [
  { name: '自测-gate', file: 'docs/跑测试.mjs', args: ['docs/自测-gate.mjs'], expectExit: 0 },
], 'G-02..G-06：4 项各构造一次；G-07/G-08 degraded');

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const green = results.filter((r) => r.status === 'GREEN').length;
const red = results.filter((r) => r.status === 'RED').length;
const na = results.filter((r) => r.status === 'NA').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const ok = red === 0 && na === 0;

if (asJson) {
  console.log(JSON.stringify({ ok, counts: { green, red, na, skipped }, lab: lab.ok ? { root: lab.root, sessions: lab.sessions } : { error: labWhy }, results }, null, 2));
} else {
  console.log(`=== 0.9.1 判据执行器（lite 线）｜lab=${lab.ok ? LAB : '未提供/不可用'} ===`);
  console.log('');
  console.log('| 判据 | 结果 | 检查项 | 说明 |');
  console.log('|---|---|---|---|');
  for (const r of results) {
    const detail = r.status === 'GREEN'
      ? `${r.checks.length} 项全过`
      : (r.reasons[0] || '');
    console.log(`| ${r.id} | ${r.status} | ${r.checks.length} | ${String(detail).replace(/\|/g, '/')} |`);
  }
  console.log('');
  console.log(`汇总：GREEN=${green} RED=${red} NA=${na} SKIP=${skipped} → ${ok ? '全绿' : '未全绿'}`);
  console.log(`证据目录：${EVID}`);
}
process.exit(ok ? 0 : 1);
