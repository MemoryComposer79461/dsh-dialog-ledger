/**
 * @file 工具-v03-清理.mjs
 * @role 【v0.5 已封锁】v0.4 旧清理工具 —— 默认跑就会真删文件（审计 A-07 / P0-6）。
 *
 * ⛔ 本文件现在只做一件事：**拒绝执行并退出**。
 *    原因：v0.4 的旧实现没有"默认 dry-run"保护，任何一次误调用都可能物理删除
 *    「完整原文」原件；v0.5 把物理删除改成必须显式开启（配置 `cleanupAllowPhysicalDelete: true`），
 *    且清册流程要按 v1.3 契约重写（journal → 终稿 → S1–S8 自检）。
 *
 * 新流程（v0.5）：
 *   · 只读统计 / dry-run：调用 `freeze/cleanup.js: runCleanup({ root })`（默认 dry-run，零删除）
 *     或直接 `listOriginals(root)` / `planCleanup(...)`；
 *   · 物理清理：必须显式 `runCleanup({ root, dryRun: false, cleanupAllowPhysicalDelete: true })`，
 *     由调用方（index.js 配置）显式开启；命令行入口等 v1.3 清册重写后另出。
 *
 * 退出码：2 = BLOCKED（工具被封锁，未做任何操作）。
 */

const MESSAGE = [
  '[BLOCKED] docs/工具-v03-清理.mjs 已在 v0.5 封锁（审计 A-07 / P0-6「清理默认真删」）。',
  '',
  '原因：v0.4 旧实现未显式确认即可能物理删除「完整原文」原件，',
  '      而「完整原文」是原始凭证 —— 误删不可逆。',
  '',
  'v0.5 的正确做法：',
  '  · 只读统计 / dry-run：node 脚本调用 freeze/cleanup.js 的 runCleanup({ root })（默认零删除）；',
  '  · 物理清理：必须显式配置 cleanupAllowPhysicalDelete: true，并按 v1.3 清册契约（journal → 终稿 → S1–S8 自检）执行。',
  '',
  '本封锁为硬封锁：未执行任何扫描、未删除任何文件、未写任何报告。',
].join('\n');

// 注意：不 import freeze/cleanup.js —— 封锁路径连只读逻辑都不跑，确保"零副作用"。
process.stderr.write(MESSAGE + '\n');
process.exit(2);
