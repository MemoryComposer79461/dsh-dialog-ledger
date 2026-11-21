#!/usr/bin/env node
/**
 * @file 工具-GL18扫描.mjs
 * @role GL-18 铁律：交付产物**不得含矛盾/夸大文字**。扫描交付文档，命中即红。
 *
 * @why 项目最怕"假绿"。代码里的绿由断言守，文档里的绿只能靠这一类扫描守：
 *      "全部通过""无未覆盖""完全满足"这类话，一旦和实际未覆盖项同页出现，
 *      读者只会记住前者。所以把它们列成禁用词，命中就退出码 1。
 *
 * 检查两类：
 *   A. 夸大/绝对化措辞（与"未覆盖项必须披露"直接冲突）
 *   B. 占位符（TODO/TBD/FIXME/????），说明有人留下了没写完的结论
 *
 * 用法：node docs/验收-v0.5/工具-GL18扫描.mjs [--dir=<额外目录>]
 * 退出码：0 = 0 命中；1 = 有命中；2 = 路径/参数错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const extra = args.filter((a) => a.startsWith('--dir=')).map((a) => a.slice(6));

const TARGETS = [
  path.join(PLUGIN, 'docs', '交付-v0.5'),
  path.join(PLUGIN, 'README.md'),
  path.join(PLUGIN, 'docs', '验收-v0.5', '摘要.md'),
  ...extra.map((d) => (path.isAbsolute(d) ? d : path.join(PLUGIN, d))),
];

/** A. 绝对化/夸大措辞（命中即红） */
// EXCLUDE_HINT：契约原文/历史验收报告里的"全部通过"是**要求或历史事实**，不是本次发布结论，排除。
const EXCLUDE_HINT = [/07-契约/, /验收-v1\.3/, /README-异机运行/];
const FORBIDDEN = [
  '全部通过', '全量通过', '全部覆盖', '100% 覆盖', '100%覆盖',
  '无未覆盖', '无任何遗漏', '零缺陷', '完全满足', '已全部修复',
  '不存在问题', '已彻底解决',
];
/** B. 占位符 */
const PLACEHOLDER = [/\bTODO\b/, /\bTBD\b/, /\bFIXME\b/, /\?\?\?\?/];

const hits = [];
const scanned = [];

function walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    return;
  }
  if (!/\.(md|txt|csv)$/i.test(p)) return;
  if (EXCLUDE_HINT.some((re) => re.test(p.replace(/\\/g, '/')))) return;
  scanned.push(p);
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const w of FORBIDDEN) {
      if (line.includes(w)) hits.push({ file: p, line: i + 1, kind: '绝对化措辞', word: w, text: line.trim().slice(0, 160) });
    }
    for (const re of PLACEHOLDER) {
      if (re.test(line)) hits.push({ file: p, line: i + 1, kind: '占位符', word: String(re), text: line.trim().slice(0, 160) });
    }
  });
}

for (const t of TARGETS) walk(t);

const rel = (p) => p.replace(PLUGIN + path.sep, '').replace(/\\/g, '/');

if (scanned.length === 0) {
  console.error('GL-18: 没有可扫描的文件（路径错？）');
  process.exit(2);
}

if (hits.length === 0) {
  console.log(`GL-18 扫描：${scanned.length} 个文件，0 命中`);
  process.exit(0);
}

console.log(`GL-18 扫描：${scanned.length} 个文件，${hits.length} 命中`);
for (const h of hits) {
  console.log(`[${h.kind}] ${rel(h.file)}:${h.line}  «${h.word}»  ${h.text}`);
}
process.exit(1);
