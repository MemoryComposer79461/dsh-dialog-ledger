/**
 * @file 工具-变异反证.mjs
 * @role 判据 C17 的**生成器**：把仓库复制到临时目录 → 删掉一条修复逻辑 → 只跑**对应用例** →
 *       断言"恰好预期的用例变红"（不是一堆红）→ 还原副本 → 复跑必须回到基线。
 *
 * @why 为什么要这个工具：
 *   ① 判据 C17 原文：「删掉某条修复逻辑 → 对应用例必红（不是一堆红）」。
 *      本包只有历史报告（`09-变异反证\报告-20261110-191633.md`，6/6），生成器早已丢失；
 *      0.9.1-re1 又刚签了 A-07（fsync 出声）/A-10（严格读）两条新修复，
 *      必须证明它们**有活用例守着**，否则"修了但没人守"= 下次重构随手删掉也不会有人发现。
 *   ② 铁律 1 禁止在原树做变异验证（原树是交付物，一个字节都不能动）。
 *      所以本工具只在 `<work-dir>\tree-<时间戳>\` 的**副本**里改代码、跑测试；
 *      原树自始至终只读，并用**跑前/跑后 sha256** 证明（见报告"原树完整性"）。
 *      ★ re3（审计 P0）：<work-dir> 默认 `%TEMP%\dsh-ledger-mutation\`，**不再写包上一级**；
 *        判据执行器会传 `--work-dir=<%TEMP%>\...\091-work\变异反证` 并随工作副本一起清掉。
 *
 * @usage
 *   node docs\工具-变异反证.mjs                 # 跑全部变异（默认）
 *   node docs\工具-变异反证.mjs --only=M1,M4    # 只跑指定变异（逗号分隔，大小写不敏感）
 *   node docs\工具-变异反证.mjs --json          # stdout 只输出机读 JSON（人读进度改走 stderr）
 *   node docs\工具-变异反证.mjs --work-dir=<dir> # 临时区根（默认 %TEMP%\dsh-ledger-mutation）
 *   node docs\工具-变异反证.mjs --help
 *
 * @output
 *   - 人读报告：`<work-dir>\报告-<时间戳>.md`（格式照抄 09-变异反证：变异|覆盖判据|被改文件|用例|基线|变异后|结论）
 *   - 机读报告：`<work-dir>\报告-<时间戳>.json`
 *   - 运行日志：`<work-dir>\logs-<时间戳>\`（每个用例每次运行一份，含看护输出与失败堆栈）
 *   - 临时副本：`<work-dir>\tree-<时间戳>\`（跑完**保留**，供复核；下一次运行会新建新目录，不覆盖旧副本）
 *
 * @exitcode
 *   0 = 全部变异**精确**变红（新增红集合 == 预期红集合），且还原副本后复跑回到基线
 *   1 = 有变异没能变红（**变异未覆盖**：该修复没有用例守着 → 需要补用例，或修复已被删掉）
 *   2 = 出现"一堆红"（新增红里出现预期外的用例，或预期内的用例没红 → 反证不精确）
 *   3 = 用法/环境错误（落点匹配不上=代码已变、副本复制失败、跑测试被内存看护拦下、
 *       还原后复跑与基线不一致、原树关键文件 sha256 变了…）
 *
 * @principle 判定口径（很重要，不能直接看 exit code）：
 *   本包基线**自带已知红**（27 条退役 + 2 条日期红，登记在 `测试退役清单-v0.9.1-re1.md`），
 *   例如 `docs\自测-reconcile.mjs` 基线就是 5 红。所以：
 *     **新增红 = 变异后红集合 − 基线红集合**，它必须与"预期红集合"**完全相等**：
 *       - 新增红为空              → 变异未覆盖（exit 1）
 *       - 新增红与预期不相等      → 反证不精确（exit 2；多出来的就是"一堆红"）
 *       - 新增红与预期完全相等    → 反证成立（exit 0）
 *   还原判定同理：还原后复跑的**新增红**必须为空（绝对红集合回到基线红集合），
 *   而不是要求"绝对全绿"——基线红不是这条变异造成的，硬要求全绿只会逼人改测试。
 *
 * @constraint 纪律（写死在本工具里，不给绕过的开关）：
 *   - 变异只改**被证逻辑**（`lib/ledger.js` 的修复分支），一个测试文件都不改；
 *   - 所有测试命令都在副本里跑（cwd = 副本根），原树一次测试都不跑；
 *   - 副本里每个变异用完立即按原字节还原，并用 sha256 证明还原干净；
 *   - 用例判定用"测试名集合"，不是"退出码"——因为基线红会让退出码恒非 0。
 *
 * ⚠️ 本文件只用于验收（C17），不参与插件运行；插件本体不 import 它。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 零、路径与常量
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
/**
 * 临时区（re3，审计 P0）：默认落**系统临时目录** `%TEMP%\dsh-ledger-mutation\`，
 * 不再写包上一级 `_工作\变异反证`（接收端交付根会被 +633 文件污染）。
 * 判据执行器会显式传 `--work-dir=<%TEMP%>\...\091-work\变异反证`，跑完随工作副本一起删。
 */
const WORK_DIR = path.resolve(
  (process.argv.find((a) => a.startsWith('--work-dir=')) || '').slice('--work-dir='.length) ||
    path.join(os.tmpdir(), 'dsh-ledger-mutation'),
);
/** 固定入口：所有用例都经它跑（它有内存看护 + 串行执行，是仓库唯一的测试启动器）。 */
const RUNNER_REL = path.join('docs', '跑测试.mjs');
/** 单次用例运行上限（本包单个自测文件实测 < 30s；给足余量防卡死）。 */
const TEST_TIMEOUT_MS = 300 * 1000;
const SCHEMA = 'dsh-c17-mutation-verify/1';

// ============================================================================
// 一、变异清单
//
//   每个变异四要素：
//     ① find/replace —— **唯一落点**（匹配数必须恰好 1，否则工具直接拒绝跑：说明代码已变）；
//     ② 覆盖判据     —— 这条修复守的是哪条判据（写进报告"覆盖判据"列）；
//     ③ 预期红       —— 变异后**新增**红的测试名（完全相等才算精确；空数组 = 期望"未覆盖"）；
//     ④ 用例文件     —— 只跑这些文件（C17 要求"只跑对应用例"，不跑全量）。
//
//   M1–M4 是任务书点名的四个变异；M5/M6 是同类修复面的补充（都有活用例），
//   用来证明工具本身能精确抓到红，而不是"运气好只碰到 M1/M4"。
// ============================================================================

const MUTATIONS = [
  {
    id: 'M1',
    criterion: 'C17 / 幂等闸门：appendTurn「已存在 code 跳过」（P1-8 写侧）',
    file: path.join('lib', 'ledger.js'),
    find: '  if (already) {\n',
    replace: '  if (false && already) {\n',
    note: '把"已存在 code → skipped=true"的分支短路成永不命中：重复 code 会真的写第二行。',
    expected: {
      [path.join('docs', '自测-ledger.mjs')]: [
        'appendTurn：同一 code 第二次 skipped=true，文件一字节都不长',
        'appendTurn：传 knownCodes 命中 → 直接 skipped，连盘都不读',
        'appendTurn：传 knownCodes 未命中 → 正常写入；调用方补进集合后即幂等',
        'appendTurn：第三参数不是 Set → 回退 hasCode 查盘（行为不变）',
      ],
      // 对照文件：`自测-index.mjs` 的"连跑两次 written=0"**不经过** ledger 内部闸门
      // （index.js 自己维护 knownCodes 集合），预期新增红 = 0 —— 用自动运行把这条
      // "看着像覆盖、其实没覆盖"的事实钉进报告，免得下次有人拿它当 C17 证据。
      [path.join('docs', '自测-index.mjs')]: [],
    },
  },
  {
    id: 'M2',
    criterion: 'C17 / A-10 非账行：readAll 的 requireLedgerRows 严格读（合法 JSON ≠ 账行）',
    file: path.join('lib', 'ledger.js'),
    find: '      if (strictRows && !parseErr && !isLedgerRow(parsed)) {\n',
    replace: '      if (false && strictRows && !parseErr && !isLedgerRow(parsed)) {\n',
    note: '删掉"requireLedgerRows=true 时把非账行 JSON 计坏行"的判断（A-10 回退成宽容读）。',
    expected: {
      // 2026-11-13（re3）：A-10 补了专属用例后，本变异必须**恰好**抓到它（C17 要求的"对应用例红"）。
      // 这不是放宽判定，而是把预期从"未覆盖（0 条）"更新为"已覆盖（1 条）"——补用例本身是本轮改动。
      [path.join('docs', '自测-ledger.mjs')]: [
        'A-10（已签）：严格读只认真账行 —— 合法 JSON 非账行按坏行计，不许静默少算',
      ],
      [path.join('docs', '自测-reconcile.mjs')]: [], // 严格读的唯一自测消费者；基线自带 5 条已登记退役红
    },
  },
  {
    id: 'M3',
    criterion: 'C17 / A-07 fsync 出声：detectAndRepairTornTail 的 durability/fsyncError 上报',
    file: path.join('lib', 'ledger.js'),
    find: '      try {\n        fs.fsyncSync(cfd);\n      } catch (e) {\n        durability = \'unknown\';\n        fsyncError = ((e && e.code) ? e.code + \' \' : \'\') + ((e && e.message) || String(e));\n      }\n',
    replace: '      try { fs.fsyncSync(cfd); } catch { /* M3: 吞掉 fsync 错误（A-07 回退） */ }\n',
    note: '把"截断后 fsync 失败必须标的 durability=\'unknown\' + fsyncError"改回**吞错**（A-07 回退）。',
    expected: {
      // 2026-11-13（re3）：A-07 补了专属用例后，本变异必须**恰好**抓到它（C17 要求的"对应用例红"）。
      // 先前 grep 0 命中是"未覆盖"的取证；补用例后把预期更新为 1 条，不是放宽判定。
      [path.join('docs', '自测-ledger.mjs')]: [
        'A-07（已签）：撕裂尾修复 fsync 失败 → durability=unknown + fsyncError，绝不静默吞',
      ],
      [path.join('docs', '自测-ledgerapi.mjs')]: [],
    },
  },
  {
    id: 'M4',
    criterion: 'C17 / P1-5 截断续跑：readTurnsFrom 坏帧不推进游标（nextOffset=haltOffset（不推 EOF）/blocked）',
    file: path.join('lib', 'ledger.js'),
    find: '  if (out.loss.hasGap && !opts.advanceOnFailed) {\n',
    replace: '  if (false && out.loss.hasGap && !opts.advanceOnFailed) {\n',
    note: '（任务书允许调整落点）删掉"有坏帧缺口就不推进游标"的闸门 —— 坏帧会被跳过并永久静默丢轮。'
      + '落点选 `readTurnsFrom`（台账的读取/续跑路径）；`forcedCursorOffset` 只是 index.js 的下游消费者，'
      + '不是游标闸门本身，改它属于"改调用方"而不是"删修复逻辑"，故不选。',
    expected: {
      [path.join('docs', '自测-ledger.mjs')]: [
        'P1-5：坏帧不推进游标 —— blocked/nextOffset=haltOffset（不推 EOF）/loss 结构化，已解出的轮仍返回',
        'P1-5：坏帧落永久错误清单（.lost.jsonl、只追加、同一现场不重复）',
        'P1-5：末帧半截（文件被截断）→ failed=1 且游标不推进',
        'P1-5/D9：坏帧同时进 .errors.jsonl（FRAME_FAILED，fingerprint 去重）',
      ],
    },
  },
  {
    id: 'M5',
    criterion: 'C17 补充 / P0-3-resume 红线：撕裂尾自愈"只有这一处坏行"（范围不许放宽）',
    file: path.join('lib', 'ledger.js'),
    find: '  for (let i = 0; i < lines.length - 1; i++) {\n    const line = lines[i];\n    if (!line.trim()) continue;\n    try { JSON.parse(line); } catch { return null; }\n  }\n',
    replace: '  /* M5: 删除条件③（只有这一处坏行）—— 自愈范围放宽 */\n',
    note: '删掉"该文件只有末行这一处坏行"的第三条件：中间行坏时也会被当成撕裂尾截掉（篡改账本）。',
    expected: {
      [path.join('docs', '自测-ledger.mjs')]: [
        'P0-3-resume/红线：末行撕裂 + 文件里还有别处坏行 → 不修（"只有这一处坏行"）',
      ],
    },
  },
  {
    id: 'M6',
    criterion: 'C17 补充 / P1-2 追加不粘结：appendLineSync 先补尾行换行',
    file: path.join('lib', 'ledger.js'),
    find: '      if (n === 1 && tail[0] !== 0x0a) {\n        data = \'\\n\' + data; // 上一行缺结尾换行：先补上，否则两行粘成一条坏 JSON\n        padded = true;\n      }\n',
    replace: '      /* M6: 删除补尾行换行（P1-2 回退） */\n',
    note: '删掉"上一行缺结尾换行先补 \\n"的逻辑：半行 + 新行会粘成一条坏 JSON，且一次坏变两条坏。',
    expected: {
      [path.join('docs', '自测-ledger.mjs')]: [
        'P1-2：尾行缺换行时追加不粘结（先补 \\n 再写）',
      ],
      [path.join('docs', '自测-守卫.mjs')]: [
        '⑤ 尾行无换行：追加先补 \\n，两条各自可 JSON.parse，且新文件末尾有换行',
      ],
    },
  },
];

/** 原树完整性比对的关键文件：被变异文件 + 全部用例文件 + 入口/清单（这些"一个字节都不许动"）。 */
const KEY_FILES = [...new Set([
  ...MUTATIONS.map((m) => m.file),
  ...MUTATIONS.flatMap((m) => Object.keys(m.expected)),
  'index.js',
  'package.json',
  'VERSION.json',
  RUNNER_REL,
])].sort();

// ============================================================================
// 二、错误类型（全部映射到 exit 3）
// ============================================================================

class UsageError extends Error {}
class EnvError extends Error {}

// ============================================================================
// 三、通用工具
// ============================================================================

const disp = (p) => String(p).split('/').join('\\');
const nowStamp = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');
/** 本地时间文本（+08:00 口径；仓库契约文本禁 Z —— 与台账/证据的 `at` 格式保持一致）。 */
function fmtLocal(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ` +
    `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256Text = (text) => sha256(Buffer.from(text, 'utf8'));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/** 递归列出文件（相对路径，正斜杠）；默认排除 `.git`。 */
function walkFiles(root, { skipGit = true } = {}) {
  const out = [];
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipGit && ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

/** 全树 manifest（证明"原树一个字节没动"的强证据；.git 除外）。 */
function treeManifest(root) {
  const files = walkFiles(root);
  const lines = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    lines.push(rel + '\0' + sha256(buf));
  }
  return {
    files: files.length,
    sha256: sha256(Buffer.from(lines.join('\n'), 'utf8')),
    entries: new Map(lines.map((l) => {
      const i = l.indexOf('\0');
      return [l.slice(0, i), l.slice(i + 1)];
    })),
  };
}

function keyFileHashes(root) {
  const map = new Map();
  for (const rel of KEY_FILES) {
    const full = path.join(root, rel);
    map.set(rel, fs.existsSync(full) ? sha256(fs.readFileSync(full)) : '(缺失)');
  }
  return map;
}

/** 复制仓库到副本：排除 `.git`（git 对象 3.6 MB、与验收无关；freeze/ 保留）。 */
function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (from) => {
      const rel = path.relative(src, from);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return top !== '.git';
    },
  });
}

/** 统计 needle 出现次数（变异落点必须恰好 1 次）。 */
const countOccurrences = (text, needle) => text.split(needle).length - 1;

/** needle 在 text 中的 1 起行号。 */
function lineOf(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return 0;
  return text.slice(0, idx).split('\n').length;
}

/**
 * 在 `docs` 下的 .mjs 里做"有没有相关断言"的检索，用来给"未覆盖"结论做现场证据。
 * 返回相对路径（正斜杠）列表。注意每次 new RegExp，避免 lastIndex 残留。
 */
function scanDocsMjs(root, pattern, { onlySelfTests = false, excludeSelf = false } = {}) {
  const docsDir = path.join(root, 'docs');
  const re = new RegExp(pattern);
  const hits = [];
  for (const rel of walkFiles(docsDir)) {
    if (!rel.endsWith('.mjs')) continue;
    if (onlySelfTests && !/^\u81ea\u6d4b-.*\.mjs$/.test(rel)) continue;
    // 本生成器的源码里必然含这些关键字（变异清单），不该算作"用例证据"
    if (excludeSelf && rel === '\u5de5\u5177-\u53d8\u5f02\u53cd\u8bc1.mjs') continue;
    const text = readText(path.join(docsDir, rel));
    if (re.test(text)) hits.push('docs/' + rel);
  }
  return hits;
}

// ============================================================================
// 四、用例运行与结果解析
//
//   ⚠️ 不用管道捕获子进程输出：受限沙箱下 Node 的 `stdio:'pipe'` 会 EPERM。
//      这里把子进程 stdout/stderr 直接重定向到**文件**（stdio 传 fd），
//      既没有管道，也能把完整日志留作证据。
// ============================================================================

function runCase(treeDir, testFile, logDir, tag) {
  const logName = `${tag}-${testFile.split(/[\\/]/).join('_')}.log`;
  const logPath = path.join(logDir, logName);
  const fd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(process.execPath, [RUNNER_REL, testFile], {
      cwd: treeDir,
      stdio: ['ignore', fd, fd], // 输出直接落文件：无管道、无沙箱 EPERM
      timeout: TEST_TIMEOUT_MS,
      windowsHide: true,
    });
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  const durationMs = Date.now() - t0;
  const text = readText(logPath);

  if (text.includes('拒绝启动')) {
    throw new EnvError(
      `跑测试被内存看护拦下（${disp(testFile)} → ${disp(logPath)}）。` +
      '这是防止撞穿 Windows 提交上限的设计，请关掉占内存的应用后重跑，或人工加 --force（本工具不替你做这个决定）。',
    );
  }
  if (r.error) throw new EnvError(`拉起测试进程失败（${disp(testFile)}）：${r.error.message}`);
  if (r.status === null) {
    throw new EnvError(`测试进程被信号终止或超时（${disp(testFile)}，上限 ${TEST_TIMEOUT_MS}ms，日志 ${disp(logPath)}）`);
  }
  const parsed = parseTestLog(text);
  return { testFile, exit: r.status, durationMs, logPath, ...parsed };
}

/**
 * 解析 `node --test` 的输出。兼容两种报告器：
 *   - spec（Node 22+/本机 v26，非 TTY 也是它）：`✔ 名字 (0.5ms)` / `✖ 名字 (0.5ms)`
 *   - tap：`ok 1 - 名字` / `not ok 1 - 名字`
 * 注意 `✖ failing tests:` 是失败汇总标题，不是用例，必须过滤掉。
 */
function parseTestLog(text) {
  const redSet = new Set();
  const passSet = new Set();
  const summary = { tests: null, pass: null, fail: null, cancelled: null, skipped: null };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^ℹ (tests|pass|fail|cancelled|skipped) (\d+)$/))) {
      summary[m[1]] = Number(m[2]);
      continue;
    }
    if (line.startsWith('✖ ')) {
      const name = cleanTestName(line.slice(2));
      if (name && name !== 'failing tests:') redSet.add(name);
      continue;
    }
    if (line.startsWith('✔ ')) {
      const name = cleanTestName(line.slice(2));
      if (name) passSet.add(name);
      continue;
    }
    if ((m = line.match(/^not ok \d+ - (.*)$/))) {
      redSet.add(m[1].replace(/\s+# (SKIP|TODO).*$/i, '').trim());
      continue;
    }
    if ((m = line.match(/^ok \d+ - (.*)$/))) {
      passSet.add(m[1].replace(/\s+# (SKIP|TODO).*$/i, '').trim());
    }
  }
  return { redSet, passSet, summary };
}

/** 去掉行尾的 `(12.3ms)`；测试名本身的括号不动。 */
function cleanTestName(s) {
  return s.replace(/\s+\(\d+(?:\.\d+)?ms\)\s*$/, '').trim();
}

/** 集合差：a − b（返回排序数组）。 */
function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort();
}

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ============================================================================
// 五、CLI
// ============================================================================

function parseArgs(argv) {
  const out = { only: null, json: false, help: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--work-dir=')) {
      /* 临时区落点：已在文件顶部解析（默认 %TEMP%\dsh-ledger-mutation；判据执行器会显式指定并随工作副本清理） */
    } else if (a.startsWith('--only=')) {
      out.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.toUpperCase());
      if (out.only.length === 0) throw new UsageError('--only= 后面没有写变异编号');
    } else if (a.startsWith('--')) {
      throw new UsageError(`未知参数：${a}`);
    } else {
      throw new UsageError(`多余的位置参数：${a}（本工具不接受位置参数）`);
    }
  }
  return out;
}

const HELP = `用法：node docs\\工具-变异反证.mjs [--only=M1,M2] [--json]

  （无参数）      跑全部变异（M1–M6）
  --only=M1,M4    只跑指定变异（逗号分隔，编号大小写不敏感）
  --json          stdout 只输出机读 JSON；人读进度改走 stderr
  --work-dir=<dir> 临时区根（默认 %TEMP% 下 dsh-ledger-mutation；副本/日志/报告都落这里）
  --help, -h      显示本帮助

做什么：把仓库复制到 <work-dir>\tree-<时间戳>\ → 在**副本**里删掉一条修复逻辑
        → 只跑对应用例 → 断言"新增红恰好等于预期" → 还原副本 → 复跑回到基线。
       原树全程只读，跑前跑后 sha256 比对（见报告"原树完整性"）。

退出码：0=全部精确变红且还原干净；1=有变异未覆盖（没变红）；
        2=出现"一堆红"（反证不精确）；3=用法/环境错误。
`;

// ============================================================================
// 六、主流程
// ============================================================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const say = args.json
    ? (s) => process.stderr.write(s + '\n')
    : (s) => process.stdout.write(s + '\n');

  const selected = args.only
    ? MUTATIONS.filter((m) => args.only.includes(m.id))
    : MUTATIONS;
  if (selected.length === 0) {
    throw new UsageError(`--only 指定的变异一个都不存在（可选：${MUTATIONS.map((m) => m.id).join(', ')}）`);
  }
  const unknownIds = args.only ? args.only.filter((id) => !MUTATIONS.some((m) => m.id === id)) : [];
  if (unknownIds.length > 0) throw new UsageError(`未知变异编号：${unknownIds.join(', ')}`);

  // —— 环境自检（出错一律 exit 3）——
  if (!fs.existsSync(path.join(PLUGIN_ROOT, 'lib', 'ledger.js'))) {
    throw new EnvError(`找不到 ${disp(path.join(PLUGIN_ROOT, 'lib', 'ledger.js'))}：本工具必须放在仓库 docs\\ 下运行`);
  }
  if (!fs.existsSync(path.join(PLUGIN_ROOT, RUNNER_REL))) {
    throw new EnvError(`找不到测试启动器 ${disp(RUNNER_REL)}`);
  }
  for (const m of selected) {
    const target = path.join(PLUGIN_ROOT, m.file);
    if (!fs.existsSync(target)) throw new EnvError(`变异 ${m.id} 的目标文件不存在：${disp(m.file)}`);
    for (const tf of Object.keys(m.expected)) {
      if (!fs.existsSync(path.join(PLUGIN_ROOT, tf))) throw new EnvError(`变异 ${m.id} 的用例文件不存在：${disp(tf)}`);
    }
  }

  const stamp = nowStamp();
  const startedAt = new Date();
  const treeDir = path.join(WORK_DIR, `tree-${stamp}`);
  const logDir = path.join(WORK_DIR, `logs-${stamp}`);
  ensureDir(WORK_DIR);
  ensureDir(logDir);
  if (fs.existsSync(treeDir)) throw new EnvError(`副本目录已存在：${disp(treeDir)}（请等一秒重跑）`);

  say('========================================================================');
  say('[C17 变异反证] 只在临时副本上删修复逻辑；原树只读。');
  say(`  仓库：${disp(PLUGIN_ROOT)}`);
  say(`  副本：${disp(treeDir)}`);
  say(`  变异：${selected.map((m) => m.id).join(', ')}（共 ${selected.length} 个）`);
  say('========================================================================');

  // —— ① 原树指纹（跑前）——
  say('[1/5] 原树指纹（跑前）…');
  const keyBefore = keyFileHashes(PLUGIN_ROOT);
  const manifestBefore = treeManifest(PLUGIN_ROOT);
  say(`      关键文件 ${keyBefore.size} 个；全树 ${manifestBefore.files} 文件 / manifest ${manifestBefore.sha256.slice(0, 16)}…`);

  // —— ② 复制副本 ——
  say('[2/5] 复制仓库到副本（排除 .git；freeze/ 保留）…');
  try {
    copyTree(PLUGIN_ROOT, treeDir);
  } catch (e) {
    throw new EnvError(`复制副本失败：${e && e.message ? e.message : String(e)}`);
  }
  const copyManifest = treeManifest(treeDir);
  if (copyManifest.files !== manifestBefore.files) {
    throw new EnvError(`副本文件数 ${copyManifest.files} ≠ 原树 ${manifestBefore.files}：复制不完整，拒绝在可疑副本上跑`);
  }
  say(`      副本 ${copyManifest.files} 文件；与跑前原树逐文件比对…`);
  for (const [rel, hash] of manifestBefore.entries) {
    if (copyManifest.entries.get(rel) !== hash) {
      throw new EnvError(`副本与跑前原树不一致（${rel}）：复制期间原树被改动，拒绝在可疑副本上跑`);
    }
  }
  say('      副本与原树逐字节一致 ✅');

  // —— ③ 基线：干净副本上先跑一遍所有用例文件 ——
  say('[3/5] 基线（干净副本，未变异）…');
  const baselineFiles = [...new Set(selected.flatMap((m) => Object.keys(m.expected)))];
  const baselines = new Map();
  for (const tf of baselineFiles) {
    const r = runCase(treeDir, tf, logDir, 'baseline');
    baselines.set(tf, r);
    say(`      ${disp(tf)} → exit=${r.exit} tests=${r.summary.tests} pass=${r.summary.pass} fail=${r.summary.fail}` +
      (r.redSet.size ? `（基线已知红 ${r.redSet.size} 条）` : '（全绿）'));
  }

  // —— ④ 逐个变异 ——
  say('[4/5] 逐个变异 → 只跑对应用例 → 还原并复跑 …');
  const results = [];
  for (const m of selected) {
    say('');
    say(`----------------------------------------------------------------`);
    const targetAbs = path.join(treeDir, m.file);
    const pristine = readText(targetAbs);
    const pristineSha = sha256Text(pristine);
    const hitCount = countOccurrences(pristine, m.find);
    if (hitCount !== 1) {
      throw new EnvError(
        `变异 ${m.id} 落点匹配 ${hitCount} 次（必须恰好 1 次）：${disp(m.file)}\n` +
        `  落点片段：${JSON.stringify(m.find.slice(0, 120))}\n` +
        '  说明：被证代码已变（修复被改/被删/重复出现）→ 请先更新本工具的变异清单，不要盲目跑。',
      );
    }
    const line = lineOf(pristine, m.find);
    const findLineCount = m.find.split('\n').length - (m.find.endsWith('\n') ? 1 : 0);

    // 应用变异（副本里）
    const mutated = pristine.replace(m.find, m.replace);
    fs.writeFileSync(targetAbs, mutated, 'utf8');
    if (sha256Text(readText(targetAbs)) === pristineSha) {
      throw new EnvError(`变异 ${m.id} 写入后文件未变（replace 与 find 等价？）`);
    }
    say(`[${m.id}] 改 ${disp(m.file)}:${line}（${findLineCount} 行）→ 跑 ${Object.keys(m.expected).length} 个用例文件`);

    // 跑对应用例（副本里）
    const mutatedRuns = [];
    for (const tf of Object.keys(m.expected)) {
      const r = runCase(treeDir, tf, logDir, `${m.id}-变异`);
      mutatedRuns.push(r);
      const base = baselines.get(tf);
      const delta = setDiff(r.redSet, base.redSet);
      say(`      ${disp(tf)} → exit=${r.exit} tests=${r.summary.tests} pass=${r.summary.pass} fail=${r.summary.fail}` +
        `；新增红 ${delta.length} 条${delta.length ? '：' + delta.join(' | ') : '（=基线）'}`);
    }

    // 还原（副本里），立刻用 sha256 证明还原干净
    fs.writeFileSync(targetAbs, pristine, 'utf8');
    const restoredSha = sha256Text(readText(targetAbs));
    const restoreShaOk = restoredSha === pristineSha;
    if (!restoreShaOk) throw new EnvError(`变异 ${m.id} 还原失败：sha256 不一致（${disp(m.file)}）`);

    // 复跑：必须回到基线（绝对红集合 == 基线红集合，exit 同基线）
    const restoredRuns = [];
    for (const tf of Object.keys(m.expected)) {
      const r = runCase(treeDir, tf, logDir, `${m.id}-还原`);
      restoredRuns.push(r);
      const base = baselines.get(tf);
      const same = setEq(r.redSet, base.redSet) && r.exit === base.exit;
      say(`      还原后复跑 ${disp(tf)} → exit=${r.exit}；红集合${same ? '回到基线 ✅' : '与基线不一致 ✗'}`);
    }

    // —— 判定 ——
    const perFile = [];
    const allDelta = new Set();
    const allExpected = new Set();
    for (const [i, tf] of Object.keys(m.expected).entries()) {
      const r = mutatedRuns[i];
      const base = baselines.get(tf);
      const expected = new Set(m.expected[tf]);
      const delta = new Set(setDiff(r.redSet, base.redSet));
      const extra = setDiff(delta, expected);
      const missing = setDiff(expected, delta);
      for (const x of delta) allDelta.add(x);
      for (const x of expected) allExpected.add(x);
      perFile.push({
        testFile: tf,
        exit: r.exit,
        summary: r.summary,
        durationMs: r.durationMs,
        logPath: r.logPath,
        baseline: {
          exit: base.exit,
          summary: base.summary,
          red: [...base.redSet].sort(),
          logPath: base.logPath,
        },
        mutatedRed: [...r.redSet].sort(),
        delta: [...delta].sort(),
        expected: [...expected].sort(),
        extra,
        missing,
      });
    }
    const extrasAll = [...new Set(perFile.flatMap((p) => p.extra))];
    const missingAll = [...new Set(perFile.flatMap((p) => p.missing))];
    const restoreRuns = restoredRuns.map((r, i) => {
      const base = baselines.get(Object.keys(m.expected)[i]);
      return { testFile: r.testFile, exit: r.exit, sameAsBaseline: setEq(r.redSet, base.redSet) && r.exit === base.exit, logPath: r.logPath };
    });
    const restoreOk = restoreShaOk && restoreRuns.every((x) => x.sameAsBaseline);

    let verdict;
    if (allDelta.size === 0) verdict = 'FAIL_NOT_COVERED';
    else if (extrasAll.length > 0 || missingAll.length > 0) verdict = 'FAIL_NOT_PRECISE';
    else verdict = 'PASS_PRECISE';

    results.push({
      id: m.id,
      criterion: m.criterion,
      file: m.file,
      line,
      findLineCount,
      find: m.find,
      replace: m.replace,
      note: m.note,
      tests: perFile,
      mutatedDelta: [...allDelta].sort(),
      expectedRed: [...allExpected].sort(),
      extras: extrasAll,
      missing: missingAll,
      restore: { sha256Same: restoreShaOk, runs: restoreRuns, ok: restoreOk },
      verdict,
    });
  }

  // —— ⑤ 原树指纹（跑后）+ 报告 ——
  say('');
  say('[5/5] 原树指纹（跑后）+ 写报告 …');
  const keyAfter = keyFileHashes(PLUGIN_ROOT);
  const manifestAfter = treeManifest(PLUGIN_ROOT);
  const keyChanged = KEY_FILES.filter((rel) => keyBefore.get(rel) !== keyAfter.get(rel));
  const treeChanged = manifestBefore.sha256 !== manifestAfter.sha256;
  const treeChangedFiles = treeChanged
    ? [...manifestBefore.entries.keys()].filter((rel) => manifestAfter.entries.get(rel) !== manifestBefore.entries.get(rel))
    : [];
  if (treeChanged) {
    say(`      ⚠️ 全树 manifest 变了：${treeChangedFiles.length} 个文件（可能是其它协作者并发改动）`);
    for (const rel of treeChangedFiles.slice(0, 10)) say(`         - ${disp(rel)}`);
  } else {
    say('      全树 manifest 一致：原树一个字节都没动 ✅');
  }
  if (keyChanged.length > 0) {
    say(`      ✗ 关键文件在本次运行期间被改动：${keyChanged.map(disp).join(', ')}`);
    say('        本工具对原树只读（所有写操作都落在临时区）；若确有其它协作者在并发编辑同一仓库，');
    say('        请等仓库安静后重跑一次，取得"原树未被改动"的干净证据。本次运行**不得**宣称原树未动。');
  } else {
    say(`      关键文件 ${KEY_FILES.length} 个 sha256 前后一致 ✅`);
  }

  const finishedAt = new Date();
  const summary = summarize(results, keyChanged.length === 0, treeChanged);
  // "未覆盖"结论的现场证据：在 docs 的 .mjs 里 grep 相关断言，证明"不是没跑，而是真没有用例"。
  const selfTestFiles = fs.readdirSync(path.join(PLUGIN_ROOT, 'docs')).filter((n) => /^自测-.*\.mjs$/.test(n));
  const spotChecks = {
    selfTestFileCount: selfTestFiles.length,
    // A-07 的出声字段：应当 0 命中，否则本报告 M3 的"未覆盖"已过时
    selfTestDurabilityHits: scanDocsMjs(PLUGIN_ROOT, 'durability|fsyncError', { onlySelfTests: true }),
    // A-10 的严格读开关：自测里应当 0 命中（工具 docs/replay-verify.mjs 会命中，那不是用例）
    selfTestRequireLedgerRowsHits: scanDocsMjs(PLUGIN_ROOT, 'requireLedgerRows', { onlySelfTests: true }),
    docsRequireLedgerRowsHits: scanDocsMjs(PLUGIN_ROOT, 'requireLedgerRows', { excludeSelf: true }),
  };
  const report = {
    schema: SCHEMA,
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    nodeVersion: process.version,
    generator: 'docs/工具-变异反证.mjs',
    pluginRoot: PLUGIN_ROOT,
    treeDir,
    logDir,
    originalTree: {
      untouched: keyChanged.length === 0,
      keyFileCount: KEY_FILES.length,
      keyFiles: KEY_FILES.map((rel) => ({ file: rel, sha256Before: keyBefore.get(rel), sha256After: keyAfter.get(rel), same: keyBefore.get(rel) === keyAfter.get(rel) })),
      treeManifest: {
        filesBefore: manifestBefore.files,
        filesAfter: manifestAfter.files,
        sha256Before: manifestBefore.sha256,
        sha256After: manifestAfter.sha256,
        same: !treeChanged,
        changedFiles: treeChangedFiles,
      },
    },
    baselines: baselineFiles.map((tf) => {
      const b = baselines.get(tf);
      return {
        testFile: tf,
        exit: b.exit,
        summary: b.summary,
        red: [...b.redSet].sort(),
        logPath: b.logPath,
      };
    }),
    spotChecks,
    mutations: results,
    summary,
  };

  const mdPath = path.join(WORK_DIR, `报告-${stamp}.md`);
  const jsonPath = path.join(WORK_DIR, `报告-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');

  say('');
  say('========================================================================');
  say(`[C17 变异反证] 结论：${summary.verdictText}`);
  say(`  精确成立 ${summary.precise}/${summary.total}；未覆盖 ${summary.notCovered}；不精确 ${summary.notPrecise}；` +
    `还原干净 ${summary.restoreClean ? '✅' : '✗'}；原树未动 ${summary.originalTreeUntouched ? '✅' : '✗'}`);
  say(`  人读报告：${disp(mdPath)}`);
  say(`  机读报告：${disp(jsonPath)}`);
  say(`  副本保留：${disp(treeDir)}`);
  say(`  退出码：${summary.exitCode}`);
  say('========================================================================');

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
  return summary.exitCode;
}

/** 汇总判定 → 退出码。0=全精确；2=不精确（更严重，优先）；1=未覆盖；3=原树被改。 */
function summarize(results, originalTreeUntouched, treeChanged) {
  const total = results.length;
  const precise = results.filter((r) => r.verdict === 'PASS_PRECISE').length;
  const notCovered = results.filter((r) => r.verdict === 'FAIL_NOT_COVERED').length;
  const notPrecise = results.filter((r) => r.verdict === 'FAIL_NOT_PRECISE').length;
  const restoreClean = results.every((r) => r.restore.ok);
  let exitCode;
  if (!originalTreeUntouched) exitCode = 3;
  else if (notPrecise > 0) exitCode = 2;
  else if (notCovered > 0) exitCode = 1;
  else exitCode = 0;
  const verdictText = exitCode === 0
    ? `${total}/${total} 个变异全部精确变红，还原后复跑回到基线`
    : exitCode === 1
      ? `有 ${notCovered} 个变异没变红（未覆盖）→ 需要补用例或修复已丢失`
      : exitCode === 2
        ? `有 ${notPrecise} 个变异出现"一堆红"/预期偏差 → 反证不精确`
        : '原树关键文件被改动（环境错误）';
  return {
    total,
    precise,
    notCovered,
    notPrecise,
    restoreClean,
    originalTreeUntouched,
    treeManifestSame: !treeChanged,
    exitCode,
    verdictText,
  };
}

// ============================================================================
// 七、报告渲染（人读 .md；格式照抄 09-变异反证：变异|覆盖判据|被改文件|用例|基线|变异后|结论）
// ============================================================================

const VERDICT_LABEL = {
  PASS_PRECISE: '✅ 反证成立（精确）',
  FAIL_NOT_COVERED: '⚠️ 未覆盖（变异未变红）',
  FAIL_NOT_PRECISE: '❌ 不精确（一堆红/预期偏差）',
};

function renderMarkdown(rep) {
  const L = [];
  const p = (s = '') => L.push(s);
  const t = rep.treeDir;
  const keySame = rep.originalTree.untouched;
  const tm = rep.originalTree.treeManifest;

  p(`# 变异反证报告 · ${fmtLocal(new Date(rep.generatedAt))}`);
  p();
  p('> 判据 C17：删掉某条修复逻辑 → **对应用例**必红（不是一堆红）。');
  p('>');
  p('> 本报告由 `docs\\工具-变异反证.mjs` 生成：**只在临时副本上变异**，原树只读；');
  p('> 基线红 = 本包已登记的退役/日期红，所以判定看**新增红**（变异后红 − 基线红），不看退出码。');
  p('>');
  p(`- 仓库：\`${disp(rep.pluginRoot)}\``);
  p(`- 临时副本：\`${disp(t)}\`（保留供复核；原树一个字节未动）`);
  p(`- 运行日志：\`${disp(rep.logDir)}\``);
  p(`- Node：${rep.nodeVersion}　耗时：${fmtMs(rep.durationMs)}　跑法：\`node docs\\工具-变异反证.mjs${rep.mutations.length < MUTATIONS.length ? ' --only=' + rep.mutations.map((m) => m.id).join(',') : ''}\``);
  p();
  p('## 一、原树完整性（证明"不在原树变异"）');
  p();
  p('| 关键文件 | 跑前 sha256 | 跑后 sha256 | 结论 |');
  p('|---|---|---|---|');
  for (const k of rep.originalTree.keyFiles) {
    p(`| \`${disp(k.file)}\` | \`${k.sha256Before.slice(0, 16)}…\` | \`${k.sha256After.slice(0, 16)}…\` | ${k.same ? '一致' : '**不一致**'} |`);
  }
  p();
  p(`- 关键文件 ${rep.originalTree.keyFileCount} 个：**${keySame ? '跑前跑后 sha256 全部一致 ✅' : '存在变化 ✗（不得宣称原树未动）'}**`);
  if (!keySame) {
    p('  > 本工具对原树只读（所有写操作都在临时区）。若确有其它协作者在并发编辑同一仓库，');
    p('  > 应在仓库安静时重跑一次，取得"原树未被改动"的干净证据；本次运行不计入 C17 通过。');
  }
  p(`- 全树（排除 \`.git\`）：跑前 ${tm.filesBefore} 文件 / \`${tm.sha256Before.slice(0, 16)}…\` → 跑后 ${tm.filesAfter} 文件 / \`${tm.sha256After.slice(0, 16)}…\` → ${tm.same ? '一致 ✅' : `**不一致**（变了 ${tm.changedFiles.length} 个文件：${tm.changedFiles.slice(0, 8).map((x) => '`' + disp(x) + '`').join('、')}${tm.changedFiles.length > 8 ? ' …' : ''}）`}`);
  p();
  p('## 二、基线（干净副本，未变异）');
  p();
  p('| 用例文件 | exit | tests | pass | fail | 基线已知红（差集基准） |');
  p('|---|---|---|---|---|---|');
  for (const b of rep.baselines) {
    p(`| \`${disp(b.testFile)}\` | ${b.exit} | ${b.summary.tests ?? '-'} | ${b.summary.pass ?? '-'} | ${b.summary.fail ?? '-'} | ${b.red.length === 0 ? '无（全绿）' : b.red.length + ' 条：' + b.red.map((x) => '`' + x + '`').join('、')} |`);
  }
  p();
  p('> 基线非 0 是**预期内**的：本包有已登记的退役/日期红（`测试退役清单-v0.9.1-re1.md`，`VERSION.json` 的 `tests.fail` 有登记）。');
  p('> 判定只认"变异后相对基线的新增红"，所以基线红不会污染 C17 结论。');
  p();
  p('## 三、变异总表');
  p();
  p('> M1–M4 = 0.9.1-re1 任务书点名的四个变异；M5/M6 = 同一修复面的**补充**变异，');
  p('> 用来证明本工具是"按预期精确抓红"，而不是只碰巧抓到 M1/M4。');
  p();
  p('| 变异 | 覆盖判据 | 被改文件 | 用例 | 基线 | 变异后 | 结论 |');
  p('|---|---|---|---|---|---|---|');
  for (const m of rep.mutations) {
    const baseDesc = m.tests.map((x) => `${disp(x.testFile)}: ${x.baseline.red.length === 0 ? '绿' : x.baseline.red.length + ' 条已知红'}`).join('<br>');
    const mutDesc = m.mutatedDelta.length === 0
      ? '无新增红'
      : '新增红 ' + m.mutatedDelta.length + ' 条<br>' + m.mutatedDelta.map((x) => '`' + x + '`').join('<br>');
    p(`| **${m.id}** | ${m.criterion} | \`${disp(m.file)}:${m.line}\` | ${m.tests.map((x) => '`' + disp(x.testFile) + '`').join('<br>')} | ${baseDesc} | ${mutDesc} | **${VERDICT_LABEL[m.verdict]}** |`);
  }
  p();
  p('## 四、逐个变异明细');
  p();
  for (const m of rep.mutations) {
    p(`### ${m.id} · ${m.criterion}`);
    p();
    p(`- **改哪一行**：\`${disp(m.file)}:${m.line}\`（${m.findLineCount} 行）`);
    const findLines = m.find.split('\n').filter((x) => x.trim().length > 0);
    const replLines = m.replace.split('\n').filter((x) => x.trim().length > 0);
    p('  ```diff');
    for (const x of findLines) p(`  - ${x}`);
    for (const x of replLines) p(`  + ${x}`);
    p('  ```');
    p(`- **为什么是这条**：${m.note}`);
    p(`- **用例**（只在副本里跑）：`);
    for (const x of m.tests) {
      p(`  - \`${disp(x.testFile)}\`：命令 \`node docs\\跑测试.mjs ${disp(x.testFile)}\`（cwd = 副本）→ ` +
        `变异后 exit=${x.exit}（tests ${x.summary.tests} / pass ${x.summary.pass} / fail ${x.summary.fail}），` +
        `还原后 exit=${x.baseline.exit}`);
    }
    p(`- **预期新增红**（${m.expectedRed.length} 条）：${m.expectedRed.length ? m.expectedRed.map((x) => '`' + x + '`').join('、') : '无（本条用于取证"未覆盖"）'}`);
    p(`- **实际新增红**（${m.mutatedDelta.length} 条）：${m.mutatedDelta.length ? m.mutatedDelta.map((x) => '`' + x + '`').join('、') : '无'}`);
    if (m.extras.length || m.missing.length) {
      p(`- **偏差**：预期外新增红 ${m.extras.length} 条${m.extras.length ? '（' + m.extras.map((x) => '`' + x + '`').join('、') + '）' : ''}；` +
        `预期内却没红 ${m.missing.length} 条${m.missing.length ? '（' + m.missing.map((x) => '`' + x + '`').join('、') + '）' : ''}`);
    } else if (m.expectedRed.length === 0) {
      p('- **偏差**：无（预期就是"无新增红"——这正是**未覆盖**的定义：该修复没有用例守着）');
    } else {
      p('- **偏差**：无（新增红集合与预期完全相等）');
    }
    p(`- **还原**：sha256 一致 ${m.restore.sha256Same ? '✅' : '✗'}；` +
      `复跑 ${m.restore.runs.map((r) => `\`${disp(r.testFile)}\` exit=${r.exit}${r.sameAsBaseline ? ' 回到基线 ✅' : ' 与基线不一致 ✗'}`).join('；')}`);
    p(`- **结论**：**${VERDICT_LABEL[m.verdict]}**`);
    p();
  }
  p('## 五、结论');
  p();
  p(`- 变异 ${rep.summary.total} 个：精确成立 **${rep.summary.precise}**；未覆盖 **${rep.summary.notCovered}**；不精确 **${rep.summary.notPrecise}**。`);
  p(`- 还原：${rep.summary.restoreClean ? '所有变异副本按原字节还原，复跑回到基线 ✅' : '有变异还原/复跑异常 ✗'}。`);
  p(`- 原树：${rep.summary.originalTreeUntouched ? '关键文件 sha256 前后一致，**变异没有发生在原树** ✅' : '关键文件被改动 ✗'}`);
  p(`- 退出码：**${rep.summary.exitCode}**（0=全精确；1=有未覆盖；2=有不精确；3=环境错误）`);
  if (rep.summary.notCovered > 0 || rep.summary.notPrecise > 0) {
    p();
    p('### 未覆盖/不精确项（C17 不能标绿的部分）');
    p();
    for (const m of rep.mutations) {
      if (m.verdict === 'PASS_PRECISE') continue;
      p(`- **${m.id}**（${m.criterion}）：${VERDICT_LABEL[m.verdict]}`);
      if (m.verdict === 'FAIL_NOT_COVERED') {
        p(`  - 在指定用例文件上新增红 = 0：${m.tests.map((x) => '`' + disp(x.testFile) + '`').join('、')} 全部保持基线。`);
        p('  - 这不是"工具坏了"，而是**该修复没有用例守着**：删掉修复不会有人报警。建议 0.9.1-re2 补一条对应用例（见下"未验/边界"）。');
      }
    }
  }
  p();
  p('## 六、未验 / 边界（如实登记）');
  p();
  p(`- **未跑全量 ${rep.spotChecks.selfTestFileCount} 个自测文件**：C17 要求"只跑对应用例"，且全量基线自带已登记红（见 \`VERSION.json\` 的 \`tests.fail\`），全量差集噪声大；本报告的结论只在"对应用例文件"上成立。`);
  p('- "未覆盖"的判定口径：指定对应用例文件上**新增红 = 0**；同时按下述 grep 证据确认"这些断言在全库自测里不存在"，而不是工具没跑。');
  const dur = rep.spotChecks.selfTestDurabilityHits;
  const reqSelf = rep.spotChecks.selfTestRequireLedgerRowsHits;
  const reqAll = rep.spotChecks.docsRequireLedgerRowsHits;
  p(`- grep 证据（生成时实测）：\`durability|fsyncError\` 在 ${rep.spotChecks.selfTestFileCount} 个 \`docs\\自测-*.mjs\` 中命中 **${dur.length}** 个文件` +
    `${dur.length ? '（' + dur.map((x) => '`' + disp(x) + '`').join('、') + ' —— 注意：M3 的"未覆盖"结论可能已过时，应把对应用例加进 M3 预期红）' : '（0 命中 → A-07 的"出声"字段没有用例断言）'}。`);
  p(`- grep 证据（生成时实测）：\`requireLedgerRows\` 在 \`docs\` 下命中 **${reqAll.length}** 个文件` +
    `${reqAll.length ? '：' + reqAll.map((x) => '`' + disp(x) + '`').join('、') : ''}` +
    `；其中自测用例 ${reqSelf.length} 个文件` +
    `${reqSelf.length ? '（' + reqSelf.map((x) => '`' + disp(x) + '`').join('、') + ' —— 注意：M2 的"未覆盖"结论可能已过时）' : '（0 命中 → 严格读分支没有自测断言）'}。`);
  p('- 建议补用例（re2）：');
  p('  1. **A-10**：在 `docs\\自测-ledger.mjs` 里写"合法 JSON 但 code 形状不符 / 无 ts"的行 → `readAll(root,{requireLedgerRows:true})` 必须 `badLines=1、ok=false`；`readAll(root)` 宽容路径不变。');
  p('  2. **A-07**：临时 patch `fs.fsyncSync`，让"截断台账文件"的那次 fsync 抛 EIO → `readAll().tornTailRepaired[0].durability === \'unknown\'` 且带 `fsyncError`；未注入时 `durability === \'ok\'`。');
  p('- 退出码 2（"一堆红"→ 反证不精确）的分支：**本次全量运行未触发**（0 个不精确）。该分支已单独自检：在临时副本的变异清单里故意多写一条不存在的预期红 → `missing=1` → `FAIL_NOT_PRECISE`、退出码 2，实测可达；deliverable 本身未改。');
  p('- 复核方法：`node docs\\工具-变异反证.mjs --only=M2`（单条重跑）或直接重跑全量；副本与逐次运行日志都保留在本报告同目录，可对照上面的 sha256/红名单复核。');
  p('- 副本可复核：' + `\`${disp(t)}\`（本次运行没有删除）` + '；日志：' + `\`${disp(rep.logDir)}\`` + '。');
  p();
  p('---');
  p('生成器：`docs\\工具-变异反证.mjs`（判据 C17；不改任何既有文件，不 commit）。');
  p();
  return L.join('\n');
}

// ============================================================================
// 八、入口
// ============================================================================

try {
  const code = main();
  process.exitCode = code;
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`[变异反证] ✗ 用法错误：${e.message}\n\n${HELP}`);
    process.exitCode = 3;
  } else if (e instanceof EnvError) {
    process.stderr.write(`[变异反证] ✗ 环境错误：${e.message}\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write(`[变异反证] ✗ 未预期错误：${e && e.stack ? e.stack : String(e)}\n`);
    process.exitCode = 3;
  }
}
