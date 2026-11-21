/**
 * @file checks-artifacts.mjs
 * @role 产物级黑盒断言：交接表主表/附表、完整原文、周记账 xlsx、全局扫描。
 *
 * 每个断言函数只读产物文件 / 台账 / state / 探针导出的事实，判定后写入 Recorder。
 * 判据编号与 AC 编号严格取自《实现checklist-v1.3.md》。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MAIN_NAME_RE, APPENDIX_NAME_RE, ORIGINAL_NAME_RE, WEEKLY_NAME_RE, SUPP_NAME_RE,
  MONTH_DIR_RE, E3_DIR_RE, CODE_RE, WEEK_NAMES, Z_TIME_RE,
  listArtifacts, listFirstLevel, readLedger, walkFiles,
  sha256Buf, sha256Text, sha256File, readText, exists,
  parseFrontMatter, yamlScalar, yamlIsBareTrue, isQuoted,
  bodyStartIndex, originalBodyStartIndex, tailShape,
  localParts, localStamp, localDate, isoLocal, hhmm, pad2,
} from './harness.mjs';

// 判据 → AC（取自 checklist 各行「验收用例ID」列；AC 编号 = AC-V13-<产物>-<序号>）
export const AC_OF = {
  'HO-01': 'AC-HO-01', 'HO-02': 'AC-HO-01', 'HO-20': 'AC-HO-01',
  'HO-03': 'AC-HO-02', 'HO-04': 'AC-HO-02', 'HO-05': 'AC-HO-02', 'HO-06': 'AC-HO-02',
  'HO-07': 'AC-HO-02', 'HO-08': 'AC-HO-02', 'HO-09': 'AC-HO-02',
  'HO-10': 'AC-HO-03', 'HO-11': 'AC-HO-03',
  'HO-12': 'AC-HO-04', 'HO-13': 'AC-HO-04',
  'HO-14': 'AC-HO-05',
  'HO-15': 'AC-HO-06', 'HO-16': 'AC-HO-06', 'HO-17': 'AC-HO-06',
  'HO-18': 'AC-HO-07', 'HO-19': 'AC-HO-07',
  'HO-21': 'AC-HO-08',
  'HO-22': 'AC-HO-09', 'HO-23': 'AC-HO-09', 'HO-31': 'AC-HO-09',
  'HO-24': 'AC-HO-10', 'HO-25': 'AC-HO-11',
  'HO-26': 'AC-HO-12', 'HO-27': 'AC-HO-12', 'HO-28': 'AC-HO-12',
  'HO-29': 'AC-HO-13', 'HO-30': 'AC-GL-08',

  'HA-01': 'AC-HA-01', 'HA-02': 'AC-HA-01', 'HA-03': 'AC-HA-01', 'HA-04': 'AC-HA-01',
  'HA-05': 'AC-HA-01', 'HA-16': 'AC-HA-01', 'HA-18': 'AC-HA-01', 'HA-19': 'AC-HA-01',
  'HA-06': 'AC-HA-02', 'HA-08': 'AC-HA-02', 'HA-11': 'AC-HA-02',
  'HA-07': 'AC-HA-03',
  'HA-09': 'AC-HA-04', 'HA-10': 'AC-HA-04',
  'HA-12': 'AC-HA-05',
  'HA-13': 'AC-HA-06',
  'HA-14': 'AC-HA-07',
  'HA-15': 'AC-HA-08',
  'HA-17': 'AC-HA-09', 'HA-20': 'AC-HA-09',

  'OR-01': 'AC-OR-01', 'OR-02': 'AC-OR-01', 'OR-24': 'AC-OR-01',
  'OR-03': 'AC-OR-02', 'OR-04': 'AC-OR-02', 'OR-05': 'AC-OR-02', 'OR-07': 'AC-OR-02', 'OR-10': 'AC-OR-02',
  'OR-06': 'AC-OR-03',
  'OR-08': 'AC-OR-04', 'OR-09': 'AC-OR-04',
  'OR-11': 'AC-OR-05', 'OR-19': 'AC-OR-05',
  'OR-12': 'AC-OR-06', 'OR-13': 'AC-OR-06',
  'OR-14': 'AC-OR-07', 'OR-15': 'AC-OR-07',
  'OR-16': 'AC-OR-08', 'OR-17': 'AC-OR-08', 'OR-18': 'AC-OR-08',
  'OR-20': 'AC-OR-09', 'OR-21': 'AC-OR-09', 'OR-23': 'AC-OR-09',
  'OR-22': 'AC-OR-10',
  'OR-26': 'AC-OR-11',
  'OR-27': 'AC-OR-12',
  'OR-25': 'AC-GL-10',

  // v1.3 只判 CL-29/CL-30（Lead 裁定 N1=B：清册功能排 v0.5）；其余 CL 仅登记 AC 归属，不进判据集
  'CL-01': 'AC-CL-01', 'CL-02': 'AC-CL-01', 'CL-03': 'AC-CL-02', 'CL-04': 'AC-CL-02', 'CL-05': 'AC-CL-02',
  'CL-06': 'AC-CL-03', 'CL-15': 'AC-CL-03',
  'CL-07': 'AC-CL-04', 'CL-31': 'AC-CL-04',
  'CL-08': 'AC-CL-05', 'CL-09': 'AC-CL-05', 'CL-11': 'AC-CL-05',
  'CL-10': 'AC-CL-06',
  'CL-12': 'AC-CL-07',
  'CL-13': 'AC-CL-08',
  'CL-14': 'AC-CL-09', 'CL-18': 'AC-CL-09',
  'CL-16': 'AC-CL-10', 'CL-17': 'AC-CL-10', 'CL-32': 'AC-CL-10',
  'CL-19': 'AC-CL-11',
  'CL-20': 'AC-CL-12', 'CL-21': 'AC-CL-12',
  'CL-22': 'AC-CL-13', 'CL-23': 'AC-CL-13',
  'CL-24': 'AC-CL-14', 'CL-25': 'AC-CL-14',
  'CL-26': 'AC-CL-15',
  'CL-27': 'AC-CL-16',
  'CL-28': 'AC-CL-17',
  'CL-29': 'AC-CL-18', 'CL-30': 'AC-CL-18',

  'WK-01': 'AC-WK-01', 'WK-02': 'AC-WK-01',
  'WK-03': 'AC-WK-02', 'WK-06': 'AC-WK-02', 'WK-07': 'AC-WK-02', 'WK-44': 'AC-WK-02',
  'WK-04': 'AC-WK-03', 'WK-05': 'AC-WK-03',
  'WK-08': 'AC-WK-04', 'WK-09': 'AC-WK-04',
  'WK-10': 'AC-WK-05', 'WK-11': 'AC-WK-05', 'WK-12': 'AC-WK-05',
  'WK-13': 'AC-WK-06', 'WK-14': 'AC-WK-06',
  'WK-15': 'AC-WK-07', 'WK-16': 'AC-WK-07',
  'WK-17': 'AC-WK-08', 'WK-18': 'AC-WK-08',
  'WK-19': 'AC-WK-09', 'WK-20': 'AC-WK-09', 'WK-21': 'AC-WK-09',
  'WK-22': 'AC-WK-10', 'WK-23': 'AC-WK-10', 'WK-29': 'AC-WK-10',
  'WK-24': 'AC-WK-11', 'WK-30': 'AC-WK-11',
  'WK-25': 'AC-WK-12', 'WK-26': 'AC-WK-12', 'WK-27': 'AC-WK-12', 'WK-28': 'AC-WK-12',
  'WK-31': 'AC-WK-13', 'WK-32': 'AC-WK-13',
  'WK-33': 'AC-WK-14',
  'WK-34': 'AC-WK-15', 'WK-35': 'AC-WK-15',
  'WK-36': 'AC-WK-16', 'WK-37': 'AC-WK-16', 'WK-38': 'AC-WK-16',
  'WK-39': 'AC-WK-17', 'WK-40': 'AC-WK-17', 'WK-41': 'AC-WK-17', 'WK-42': 'AC-WK-17',
  'WK-43': 'AC-WK-18',
  'WK-45': 'AC-WK-19',
  'WK-46': 'AC-GL-08',

  'GL-01': 'AC-GL-01', 'GL-02': 'AC-GL-01', 'GL-03': 'AC-GL-01', 'GL-04': 'AC-GL-01',
  'GL-05': 'AC-GL-02', 'GL-15': 'AC-GL-02',
  'GL-06': 'AC-GL-03',
  'GL-07': 'AC-GL-04',
  'GL-08': 'AC-GL-08',
  'GL-09': 'AC-GL-05', 'GL-14': 'AC-GL-09',
  'GL-10': 'AC-GL-10',
  'GL-11': 'AC-GL-06',
  'GL-12': 'AC-GL-07', 'GL-13': 'AC-GL-07',
  'GL-16': 'AC-GL-11', 'GL-17': 'AC-GL-11',
  'GL-18': 'AC-GL-12',
};

export const acOf = (crit) => AC_OF[crit] || '';

// 所有判据编号（不含 CL-01..28/31/32：v0.5 才判）
export const HO_IDS = Array.from({ length: 31 }, (_, i) => `HO-${pad2(i + 1)}`);
export const HA_IDS = Array.from({ length: 20 }, (_, i) => `HA-${pad2(i + 1)}`);
export const OR_IDS = Array.from({ length: 27 }, (_, i) => `OR-${pad2(i + 1)}`);
export const CL_IDS = ['CL-29', 'CL-30'];
export const WK_IDS = Array.from({ length: 46 }, (_, i) => `WK-${pad2(i + 1)}`);
export const GL_IDS = Array.from({ length: 18 }, (_, i) => `GL-${pad2(i + 1)}`);
export const ALL_IDS = [...HO_IDS, ...HA_IDS, ...OR_IDS, ...CL_IDS, ...WK_IDS, ...GL_IDS];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const isNonEmptyLine = (l) => l.trim().length > 0;

/** 取「从某行开始到下一个空行」的 markdown 表格。 */
export function tableAt(lines, startIdx) {
  const rows = [];
  let i = startIdx;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) { rows.push({ sep: true, cells }); continue; }
    rows.push({ sep: false, cells });
  }
  return { rows, endIdx: i };
}

/** 找 markdown 表格：首行第一个单元格等于 firstCell 的连续表。 */
export function findTable(lines, firstCell) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) continue;
    const cells = lines[i].split('|').slice(1, -1).map((s) => s.trim());
    if (cells[0] === firstCell) return { startIdx: i, ...tableAt(lines, i) };
  }
  return null;
}

export function sectionLines(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) || /^#\s/.test(lines[i])) { end = i; break; }
  }
  return { start, lines: lines.slice(start + 1, end), all: lines };
}

const YAML_MAIN_KEYS = ['名称', '会话标识', '代差', '委托人', '执行', '记录', '生成器', '生成时间', '附表', '封板', '封板hash'];
const YAML_APPENDIX_KEYS = ['名称', '会话标识', '代差', '父表', '上下文条数', '生成器', '生成时间'];
const YAML_ORIGINAL_KEYS = ['编码', '名称', '会话ID', '会话短ID', '代次', '本轮序号', '对话开始', '对话结束', '结束原因',
  '委托人', '执行', '记录', '生成器', '事件范围', '被遮蔽事件数', '正文hash', '正文hash算法', '文件数', '文件'];
const FIXED_DECLARATION_4 = '该数据库为共享库，不对任何会话进行屏蔽。★ 会话不默认知晓自己的 Session ID，须先自查（调用本插件工具 / 问 user）方可定位自己的账。';
const V12_DECLARATION_1_3 = [
  '1. 说明记录会话主体。',
  '2. 赋予 user 管理、修改、审计等权利，但后果自负。',
  '3. 给予 Agent 使用权和修改权，但不给予审计权，且修改需获得 user 授权。',
];
const ARCH_LEVELS = ['**第一级：数据总库**', '**第二级：XX月份文件夹**', '**第三级：xx月总“完整原文”文件夹**'];
const ARCH_RULES = [
  '所有 Session 的启用及交接表、“完整原文”清理报告，均放在**第一层**',
  '所有 Session 的周记账，均放在**第二层**',
  '所有 Session 的“完整原文”，均放在**第三层**',
];
const WEEKLY_SHEET_ORDER = ['说明', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周统计'];
const WEEKLY_HEADERS = ['编码', '原始凭证', '时间', '角色', '对话内容摘要', 'User的文件引用与Agent文件输出', '输出文件位置', '状态', '用户审计', '备注'];
const CODE_DV_FORMULA = 'IFERROR(AND(LEN(A2)=32,MID(A2,9,1)="-",MID(A2,22,1)="-",MID(A2,24,1)="-",ISNUMBER(--LEFT(A2,8)),ISNUMBER(--RIGHT(A2,8)),ISERROR(FIND("-",MID(A2,10,12))),FIND(MID(A2,23,1),"ABCDEFGHIJKLMNOPQRSTUVWXYZ")>0),FALSE)';
const FIVE_SECTIONS = ['## 1. user/message', '## 2. assistant/message', '## 3. tool/call + tool/result', '## 4. step/start + step/end', '## 5. 备注'];
const HASH_ALGO_TEXT = 'sha256（对『## 1.』至文件末尾的全部字节计算）';
const APPENDIX_BLOCK_RE = /^## \d+\. (user\/message|assistant\/message|tool\/call|tool\/result|system\/message)$/;

// ---------------------------------------------------------------------------
// ★ Lead 裁定口径（2026-11-09）：+08:00 / 无 Z / 无 {{}} / 无 CR 只判「生成字段」，
//    不判「逐字照录的用户/工具内容」。以下函数把「生成部分」切出来供扫描。
// ---------------------------------------------------------------------------
/** 附表：生成部分 = YAML/标题/引用块/block 标题与元信息行/结束行；block 正文不算。 */
export function generatedPortionAppendix(text) {
  const lines = String(text).split('\n');
  const out = [];
  let seenBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (APPENDIX_BLOCK_RE.test(line.trim()) && /^## \d+\. /.test(line)) {
      seenBlock = true;
      out.push(line);
      let j = i + 1;
      if (j < lines.length && lines[j].trim() === '') j += 1;
      if (j < lines.length) out.push(lines[j]);
      continue;
    }
    if (!seenBlock) { out.push(line); continue; }
    const t = line.trim();
    if (t === '' || t === '---' || t === '无' || t.startsWith('>') || t.startsWith('**结束**')) out.push(line);
  }
  return out.join('\n');
}

/** 完整原文：生成部分 = 「## 1.」行的行首之前（YAML + 标题 + 声明）；正文逐字照录不参与扫描。
 *  ⚠️ 必须行首匹配：YAML `正文hash算法` 的值里含字面 `## 1.`（2026-11-09 终验修正）。 */
export function generatedPortionOriginal(text) {
  const s = String(text);
  const i = originalBodyStartIndex(s);
  return i === -1 ? s : s.slice(0, i);
}

/** 按产物类型取「生成部分」文本（用于 Z 时间 / 占位符 / CR 扫描）。 */
export function generatedPortionOf(rel, text) {
  const base = path.basename(rel);
  if (/的记忆数据库的启用及交接表——附表\.md$/.test(base)) return generatedPortionAppendix(text);
  if (/完整原文\.md$/.test(base)) return generatedPortionOriginal(text);
  return text; // 主表 / 清册 / 补记册 / 周记账说明页：整份都是生成物
}

export const handoverMainName = (sessKey) => `${sessKey}的记忆数据库的启用及交接表.md`;
export const handoverAppendixName = (sessKey) => `${sessKey}的记忆数据库的启用及交接表——附表.md`;

// ---------------------------------------------------------------------------
// 1) 交接表主表
// ---------------------------------------------------------------------------
export function checkHandoverMain(R, ctx) {
  const { root, sessKey, id } = ctx;
  const name = handoverMainName(sessKey);
  const abs = path.join(root, name);
  const label = `[${id}] ${name}`;
  R.judge('HO-01', 'HO-01', acOf('HO-01'),
    MAIN_NAME_RE.test(name) && fs.existsSync(abs),
    `${label} 存在且文件名合法`,
    `${label} 文件名/位置不合法：${JSON.stringify(fs.existsSync(abs))}`);

  if (!fs.existsSync(abs)) {
    for (const c of ['HO-02', 'HO-03', 'HO-04', 'HO-05', 'HO-06', 'HO-07', 'HO-08', 'HO-09', 'HO-10',
      'HO-11', 'HO-12', 'HO-13', 'HO-14', 'HO-15', 'HO-16', 'HO-17', 'HO-18', 'HO-20']) {
      R.fail(c, c, acOf(c), `${label} 不存在，无法判定 ${c}`);
    }
    return null;
  }
  const text = readText(abs);
  const shape = tailShape(text);
  const fm = parseFrontMatter(text);
  const y = fm ? fm.raw : {};
  const keys = fm ? fm.keys : [];

  // HO-02 / HO-20 编码与结尾
  R.judge('HO-02', 'HO-02', acOf('HO-02'),
    !shape.hasBOM && !shape.hasCR && shape.endsWithNewline && !shape.endsWithDoubleNewline,
    `BOM=false CR=false 末尾单换行=true`,
    `编码/结尾不合格：BOM=${shape.hasBOM} CR=${shape.hasCR} 单尾换行=${shape.endsWithNewline && !shape.endsWithDoubleNewline}`);
  R.judge('HO-20', 'HO-20', acOf('HO-20'),
    !shape.hasPlaceholder && !shape.hasCR,
    `无占位符残留；无 CR`,
    `出现占位符=${shape.hasPlaceholder} CR=${shape.hasCR}`);

  // HO-03 键集/顺序
  R.judge('HO-03', 'HO-03', acOf('HO-03'),
    JSON.stringify(keys) === JSON.stringify(YAML_MAIN_KEYS),
    `11 键顺序正确：${keys.join('/')}`,
    `键集/顺序不符：实际 ${keys.length} 键 ${JSON.stringify(keys)}，期望 ${JSON.stringify(YAML_MAIN_KEYS)}`);

  const v = (k) => yamlScalar(y[k]);
  const bodyStart = bodyStartIndex(text);
  const bodyText = bodyStart >= 0 ? text.slice(bodyStart) : '';
  const h1Line = bodyText.split('\n')[0] || '';

  // HO-04 名称 == 抬头 H1
  R.judge('HO-04', 'HO-04', acOf('HO-04'),
    v('名称') === `${sessKey}的记忆数据库的启用及交接表` && h1Line === `# ${v('名称')}`,
    `名称=“${v('名称')}”；H1=“${h1Line}”`,
    `名称/H1 不一致：名称=“${v('名称')}” H1=“${h1Line}”`);

  // HO-05 会话标识/代差
  const sessOk = /^[0-9a-z]{12}$/.test(v('会话标识')) && v('会话标识') === sessKey.slice(0, 12) &&
    /^[A-Z]$/.test(v('代差')) && v('代差') === sessKey.slice(12);
  R.judge('HO-05', 'HO-05', acOf('HO-05'), sessOk,
    `会话标识=${v('会话标识')} 代差=${v('代差')} 与文件名前 13 位一致`,
    `会话标识/代差与文件名不符：${v('会话标识')}/${v('代差')} vs ${sessKey}`);

  // HO-06 固定元信息
  R.judge('HO-06', 'HO-06', acOf('HO-06'),
    v('委托人') === 'user' && v('执行') === '日常会话记录插件（Tool）' && v('记录') === '系统（Cordis）',
    `委托人=${v('委托人')} 执行=${v('执行')} 记录=${v('记录')}`,
    `固定元信息不符：${v('委托人')}/${v('执行')}/${v('记录')}`);

  // HO-07 生成器
  R.judge('HO-07', 'HO-07', acOf('HO-07'),
    v('生成器').trim().length > 0 && !v('生成器').includes('{{') && !v('生成器').includes('}}'),
    `生成器=“${v('生成器')}”`,
    `生成器空/含占位符：“${v('生成器')}”`);

  // HO-08 生成时间格式 + 与运行窗口 ≤5 分钟
  const gtMs = Date.parse(String(v('生成时间')).replace(' ', 'T') + '+08:00');
  const within5 = Number.isFinite(gtMs) && Math.abs(Date.now() - gtMs) <= 5 * 60 * 1000;
  R.judge('HO-08', 'HO-08', acOf('HO-08'),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v('生成时间')) && within5,
    `生成时间=“${v('生成时间')}” 与运行窗口相差 ${Math.round(Math.abs(Date.now() - gtMs) / 1000)}s`,
    `生成时间=“${v('生成时间')}” 格式或窗口偏差不合格（偏差 ${Math.round(Math.abs(Date.now() - gtMs) / 1000)}s）`);

  // HO-09 附表
  const appName = handoverAppendixName(sessKey);
  R.judge('HO-09', 'HO-09', acOf('HO-09'),
    v('附表') === appName && fs.existsSync(path.join(root, appName)),
    `附表字段=“${v('附表')}” 且存在`,
    `附表字段=“${v('附表')}” 期望“${appName}”；存在=${fs.existsSync(path.join(root, appName))}`);

  // HO-10 封板布尔
  R.judge('HO-10', 'HO-10', acOf('HO-10'),
    yamlIsBareTrue(y['封板']) && !isQuoted(y['封板']),
    `封板 为裸字面量 true`,
    `封板 不是裸布尔 true：raw=${JSON.stringify(y['封板'])}（若带引号即为字符串，不合格）`);

  // HO-11 封板hash 单引号 64hex
  R.judge('HO-11', 'HO-11', acOf('HO-11'),
    /^'[0-9a-f]{64}'$/.test(String(y['封板hash'] || '').trim()),
    `封板hash='${yamlScalar(y['封板hash'])}'（单引号包裹 64 位小写 hex）`,
    `封板hash 格式不符：raw=${JSON.stringify(String(y['封板hash'] || '').trim())}`);

  // HO-12 / HO-13 抬头表
  const lines = text.split('\n');
  const t = findTable(lines, '项目');
  const dataRows = t ? t.rows.filter((r) => !r.sep && r.cells[0] !== '项目') : [];
  const expectItems = ['名称', '会话标识', '代差', '委托人', '执行', '记录', '生成时间', '附表'];
  R.judge('HO-12', 'HO-12', acOf('HO-12'),
    !!t && dataRows.length === 8 && JSON.stringify(dataRows.map((r) => r.cells[0])) === JSON.stringify(expectItems),
    `抬头表 8 行：${dataRows.map((r) => r.cells[0]).join('/')}`,
    `抬头表行数/项目不符：行数=${dataRows.length} 项目=${JSON.stringify(dataRows.map((r) => r.cells[0]))}`);
  if (t && dataRows.length === 8) {
    const content = Object.fromEntries(dataRows.map((r) => [r.cells[0], r.cells[1]]));
    const pairs = [
      ['名称', v('名称')], ['会话标识', v('会话标识')], ['代差', v('代差')],
      ['委托人', v('委托人')], ['执行', v('执行')], ['记录', v('记录')],
      ['生成时间', v('生成时间')], ['附表', v('附表')],
    ];
    const bad = pairs.filter(([k, val]) => !String(content[k] || '').startsWith(String(val)));
    R.judge('HO-13', 'HO-13', acOf('HO-13'), bad.length === 0,
      `抬头表 8 个内容单元格与 YAML 逐字段匹配`,
      `抬头表与 YAML 不一致：${bad.map(([k, val]) => `${k}=“${content[k]}”（YAML=“${val}”）`).join('；')}`);
  } else {
    R.fail('HO-13', 'HO-13', acOf('HO-13'), '抬头表结构不合格，无法对照');
  }

  // HO-14 声明
  const decl = sectionLines(text, '## 声明');
  let declOk = false;
  let declDetail = '无「## 声明」小节';
  if (decl) {
    const dl = decl.lines.map((l) => l.trim()).filter(isNonEmptyLine);
    const items = dl.filter((l) => /^[1-9]\.\s/.test(l));
    const item1to3ok = V12_DECLARATION_1_3.every((s, i) => items[i] === s);
    declOk = items.length === 4 && item1to3ok && items[3] === `4. ${FIXED_DECLARATION_4}`;
    declDetail = `声明 ${items.length} 条；第4条=“${(items[3] || '').slice(0, 90)}…”`;
    if (!declOk) {
      declDetail = `声明不合格：条数=${items.length}；第4条逐字=${items[3] === `4. ${FIXED_DECLARATION_4}`}；1-3条逐字=${item1to3ok}`;
    }
  }
  R.judge('HO-14', 'HO-14', acOf('HO-14'), declOk, declDetail, declDetail);

  // HO-15 相关文件
  const relIdx = lines.findIndex((l) => l.trim() === '## 相关文件');
  let relOk = false;
  let relDetail = '无「## 相关文件」小节';
  if (relIdx >= 0) {
    const tableStart = lines.findIndex((l, i) => i > relIdx && l.trim().startsWith('| 文件'));
    if (tableStart >= 0) {
      const tb = tableAt(lines, tableStart);
      const rows = tb.rows.filter((r) => !r.sep && r.cells[0] !== '文件');
      relOk = rows.length === 2 &&
        rows[0].cells[0].replace(/^《|》$/g, '') === v('附表') &&
        rows[1].cells[0].includes('完整原文');
      relDetail = `相关文件 ${rows.length} 行；第1行=“${rows[0] ? rows[0].cells[0] : ''}”；第2行含完整原文=${rows[1] ? rows[1].cells[0].includes('完整原文') : false}`;
    }
  }
  R.judge('HO-15', 'HO-15', acOf('HO-15'), relOk, relDetail, relDetail);

  // HO-16 数据库架构
  const arch = sectionLines(text, '## 数据库架构');
  let archOk = false;
  let archDetail = '无「## 数据库架构」小节';
  if (arch) {
    const joined = arch.lines.join('\n');
    const levelsOk = ARCH_LEVELS.every((s) => joined.includes(s));
    const rulesOk = joined.includes('### 存放规则') && ARCH_RULES.every((s) => joined.includes(s));
    const noLedger = !joined.includes('ledger/') && !joined.includes('台账');
    archOk = levelsOk && rulesOk && noLedger;
    archDetail = `三级结构=${levelsOk} 存放规则3条=${rulesOk} 未写运行区=${noLedger}`;
  }
  R.judge('HO-16', 'HO-16', acOf('HO-16'), archOk, archDetail, archDetail);

  // HO-17 结束行
  const lastLine = [...lines].reverse().find(isNonEmptyLine) || '';
  R.judge('HO-17', 'HO-17', acOf('HO-17'),
    new RegExp(`^\\*\\*结束\\*\\* · [0-9a-z]{12}[A-Z] · 生成器 \\S+$`).test(lastLine),
    `末行=“${lastLine}”`,
    `末行格式不符：“${lastLine}”`);

  // HO-18 封板hash 独立复算
  const recomputed = bodyStart >= 0 ? sha256Text(text.slice(bodyStart)) : '';
  const yamlHash = v('封板hash');
  R.judge('HO-18', 'HO-18', acOf('HO-18'),
    recomputed.length === 64 && recomputed === yamlHash,
    `正文（# 行首→EOF）sha256=${recomputed} == YAML 封板hash`,
    `复算不一致：复算=${recomputed} YAML=${yamlHash}`);

  return { abs, text, fm, y, bodyStart, bodyText, recomputed };
}

// ---------------------------------------------------------------------------
// 2) 交接表附表
// ---------------------------------------------------------------------------
export function checkHandoverAppendix(R, ctx) {
  const { root, sessKey, id, expectEmpty = false, expectedRoles, forbiddenTexts = [],
    expectedTexts = [], userBlockCount = null, expectTruncated = false } = ctx;
  const name = handoverAppendixName(sessKey);
  const abs = path.join(root, name);
  const label = `[${id}] ${name}`;
  R.judge('HA-01', 'HA-01', acOf('HA-01'), APPENDIX_NAME_RE.test(name) && fs.existsSync(abs),
    `${label} 存在且文件名合法`, `${label} 文件名/位置不合法`);
  if (!fs.existsSync(abs)) {
    for (const c of ['HA-02', 'HA-03', 'HA-04', 'HA-05', 'HA-16', 'HA-18', 'HA-19']) R.fail(c, c, acOf(c), `${label} 不存在`);
    return null;
  }
  const text = readText(abs);
  const shape = tailShape(text);
  const fm = parseFrontMatter(text);
  const y = fm ? fm.raw : {};
  const v = (k) => yamlScalar(y[k]);
  const keys = fm ? fm.keys : [];

  R.judge('HA-02', 'HA-02', acOf('HA-02'),
    JSON.stringify(keys) === JSON.stringify(YAML_APPENDIX_KEYS),
    `7 键顺序正确：${keys.join('/')}`,
    `键集/顺序不符：${JSON.stringify(keys)} 期望 ${JSON.stringify(YAML_APPENDIX_KEYS)}`);
  R.judge('HA-03', 'HA-03', acOf('HA-03'),
    MAIN_NAME_RE.test(v('父表')) && fs.existsSync(path.join(root, v('父表'))),
    `父表=“${v('父表')}” 且存在`,
    `父表=“${v('父表')}” 不存在或格式不符`);
  R.judge('HA-04', 'HA-04', acOf('HA-04'),
    v('名称') === `${sessKey}的记忆数据库的启用及交接表——附表`,
    `名称=“${v('名称')}”`,
    `名称=“${v('名称')}” 期望“${sessKey}的记忆数据库的启用及交接表——附表”`);
  const genText = generatedPortionAppendix(text);
  R.judge('HA-05', 'HA-05', acOf('HA-05'),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v('生成时间')) && !Z_TIME_RE.test(genText),
    `生成时间=“${v('生成时间')}”，生成部分无 Z 时间（逐字照录的 block 正文不参与，Lead 裁定①）`,
    `生成时间=“${v('生成时间')}” 或生成部分出现 Z 时间`);
  R.judge('HA-16', 'HA-16', acOf('HA-16'),
    !text.includes('已截断：本节之后的内容见该会话的完整原文') && !/^### 2026-/m.test(text),
    '无 v0.4 旧串（「已截断：本节之后…」「### 2026-」）',
    '出现 v0.4 旧串');
  R.judge('HA-18', 'HA-18', acOf('HA-18'),
    !shape.hasBOM && shape.endsWithNewline && !shape.endsWithDoubleNewline &&
      !genText.includes('\r') && !genText.includes('{{') && !genText.includes('}}'),
    'UTF-8 无 BOM、恰好一个结尾换行；生成部分无 CR/占位符（block 正文逐字照录不参与，Lead 裁定①）',
    `编码不合格：BOM=${shape.hasBOM} 单尾换行=${shape.endsWithNewline && !shape.endsWithDoubleNewline} 生成部分 CR=${genText.includes('\r')} 占位符=${genText.includes('{{') || genText.includes('}}')}`);
  const lines = text.split('\n');
  const h1 = lines.find((l) => l.startsWith('# ')) || '';
  R.judge('HA-19', 'HA-19', acOf('HA-19'),
    h1 === `# ${v('名称')}` && v('名称') === `${sessKey}的记忆数据库的启用及交接表——附表`,
    `H1=“${h1}” == YAML 名称`,
    `H1=“${h1}” 与 YAML 名称“${v('名称')}”不一致`);

  const count = Number(v('上下文条数'));
  const blockHeads = lines.filter((l) => APPENDIX_BLOCK_RE.test(l.trim()));
  const blockRoles = blockHeads.map((l) => l.trim().replace(/^## \d+\. /, ''));
  const bodyHasEmptyWord = /\n无\n/.test('\n' + text);
  // 元信息行只在「block 标题之后」取，避免把逐字照录内容里恰好同形的行误当元信息
  const blockMetas = [];
  for (let bi = 0; bi < lines.length; bi += 1) {
    if (!APPENDIX_BLOCK_RE.test(lines[bi].trim())) continue;
    let j = bi + 1;
    if (j < lines.length && lines[j].trim() === '') j += 1;
    blockMetas.push((lines[j] || '').trim());
  }
  const metaParsed = blockMetas.map((m) => /^\[seq (\d+)\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(m));

  if (expectEmpty) {
    R.judge('HA-13', 'HA-13', acOf('HA-13'),
      count === 0 && blockHeads.length === 0 && bodyHasEmptyWord,
      '空表：上下文条数=0、无 block、正文含「无」',
      `空表不符：上下文条数=${count} block 数=${blockHeads.length} 含“无”=${bodyHasEmptyWord}`);
    return { abs, text, fm, y, count, blockHeads, blockRoles };
  }

  // 非空表
  if (expectedRoles !== undefined) {
    R.judge('HA-06', 'HA-06', acOf('HA-06'),
      expectedRoles.length > 0 && JSON.stringify(blockRoles) === JSON.stringify(expectedRoles),
      `block role 序列=${JSON.stringify(blockRoles)}`,
      `block role 序列不符：实际 ${JSON.stringify(blockRoles)} 期望 ${JSON.stringify(expectedRoles)}`);
  }
  R.judge('HA-08', 'HA-08', acOf('HA-08'),
    (() => {
      const seqs = metaParsed.map((m) => (m ? Number(m[1]) : NaN));
      return seqs.length > 0 && seqs.every((n, i) => Number.isInteger(n) && (i === 0 || n > seqs[i - 1]));
    })(),
    `各 block 元信息 [seq N] 严格升序：${JSON.stringify(metaParsed.map((m) => (m ? Number(m[1]) : '?')))}`,
    `[seq N] 非严格升序：${JSON.stringify(metaParsed.map((m) => (m ? Number(m[1]) : '?')))}`);
  R.judge('HA-09', 'HA-09', acOf('HA-09'),
    (() => {
      const nums = blockHeads.map((l) => Number(/^## (\d+)\. /.exec(l.trim())[1]));
      return nums.length === count && nums.every((n, i) => n === i + 1);
    })(),
    `编号 1..${count} 连续且 == 上下文条数`,
    `编号不连续或与上下文条数不等：block 数=${blockHeads.length} 上下文条数=${count}`);
  const metaOk = metaParsed.length === blockHeads.length && metaParsed.every((m) => !!m);
  R.judge('HA-10', 'HA-10', acOf('HA-10'), metaOk,
    `${metaParsed.length} 个 block 的元信息行格式合法`,
    `元信息行缺失/格式不符：block=${blockHeads.length} 合法元信息=${metaParsed.filter(Boolean).length}`);
  const forb = forbiddenTexts.filter((s) => s && text.includes(s));
  const filteredOk = forb.length === 0 && (userBlockCount === null || blockRoles.filter((r) => r === 'user/message').length === userBlockCount);
  R.judge('HA-07', 'HA-07', acOf('HA-07'), filteredOk,
    `被过滤 kind 未出现；user block 数=${blockRoles.filter((r) => r === 'user/message').length}`,
    `过滤不合格：出现被过滤内容=${JSON.stringify(forb)} user block 数=${blockRoles.filter((r) => r === 'user/message').length} 期望=${userBlockCount}`);
  const missTexts = expectedTexts.filter((s) => !text.includes(s));
  R.judge('HA-11', 'HA-11', acOf('HA-11'),
    missTexts.length === 0 && blockHeads.length === count,
    `逐条照录：${expectedTexts.length} 条原文全部出现，block 数=上下文条数`,
    `逐条照录不符：缺失原文=${JSON.stringify(missTexts).slice(0, 400)} block=${blockHeads.length} 条数=${count}`);
  const hasTrunc = text.includes('（已截断）');
  if (expectTruncated) {
    const fixed = '（已截断）本表之后至插件接管前的内容未纳入本表；插件接管后的每一轮见第 3 级完整原文';
    R.judge('HA-15', 'HA-15', acOf('HA-15'),
      text.includes(fixed) && blockHeads.length === count && blockHeads.length < (ctx.expectedTotal || Infinity),
      `含决定9#7固定句；上下文条数=${count} == 实际 block 数=${blockHeads.length}（应录 ${ctx.expectedTotal}）`,
      `截断口径不符：固定句=${text.includes(fixed)} 条数=${count} block=${blockHeads.length} 应录=${ctx.expectedTotal}`);
  } else {
    R.judge('HA-14', 'HA-14', acOf('HA-14'),
      !hasTrunc && blockHeads.length === count,
      `未截断（无“已截断”字样），block 数=${blockHeads.length} == 上下文条数=${count}`,
      `不应截断：出现“已截断”=${hasTrunc}`);
  }
  return { abs, text, fm, y, count, blockHeads, blockRoles };
}

// ---------------------------------------------------------------------------
// 3) 完整原文
// ---------------------------------------------------------------------------
export function shadowedSeqsOf(events) {
  const shadowed = new Set();
  for (const e of events) {
    const d = e && e.data;
    if (!d) continue;
    if (Array.isArray(d.shadowedSeqs)) for (const n of d.shadowedSeqs) shadowed.add(Number(n));
    if (d.shadowedRange && Number.isInteger(d.shadowedRange.start) && Number.isInteger(d.shadowedRange.end)) {
      for (let s = d.shadowedRange.start; s <= d.shadowedRange.end; s += 1) shadowed.add(s);
    }
  }
  return shadowed;
}

const DISPLAY_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/start', 'step/end', 'system/message']);

/** 被遮蔽事件数复算（模板 3.3）：|E ∩ shadowed|。 */
export function recomputeShadowed(events, fromSeq, toSeq) {
  const shadowed = shadowedSeqsOf(events);
  const inRange = eventsInRangeLocal(events, fromSeq, toSeq);
  let n = 0;
  for (const e of inRange) if (shadowed.has(e.seq)) n += 1;
  return { count: n, shadowed, inRange };
}

function eventsInRangeLocal(events, fromSeq, toSeq) {
  return events.filter((e) => Number.isInteger(e.seq) && e.seq >= fromSeq && e.seq <= toSeq);
}

/** 解析完整原文的备注节：返回 {lines, firstLine, kindCounts, isNone}。 */
export function parseOriginalNote(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## 5. 备注');
  if (start === -1) return null;
  const body = lines.slice(start + 1).map((l) => l.trim()).filter((l) => l.length > 0);
  const isNone = body.length === 1 && body[0] === '无';
  const injectLine = body.find((l) => l.includes('注入清单'));
  const kindCounts = new Map();
  if (injectLine) {
    const tail = injectLine.split('：').slice(1).join('：');
    for (const part of tail.split('｜')) {
      const m = /([A-Za-z0-9-]+)\s*×(\d+)/.exec(part);
      if (m) kindCounts.set(m[1], Number(m[2]));
    }
  }
  return { lines: body, firstLine: body[0] || '', kindCounts, isNone, injectLine };
}

export function checkOriginal(R, ctx) {
  const { root, record, sourceEvents, id } = ctx;
  const code = record.code;
  const label = `[${id}] ${code}`;
  // 找回文件：台账 doc 指针优先
  let abs = '';
  if (record.doc) abs = path.join(root, record.doc);
  if (!abs || !exists(abs)) {
    const ts = String(record.ts || '');
    const y = ts.slice(0, 4); const m = ts.slice(5, 7);
    abs = path.join(root, `${y}年${m}月`, `${m}月总“完整原文”`, `${code} 完整原文.md`);
  }
  const fileName = path.basename(abs);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  R.judge('OR-01', 'OR-01', acOf('OR-01'), exists(abs) && ORIGINAL_NAME_RE.test(fileName),
    `${label} 文件名合法：${fileName}`,
    `${label} 文件缺失或文件名不合法：${fileName} exists=${exists(abs)}`);
  R.judge('OR-02', 'OR-02', acOf('OR-02'),
    /^\d{4}年\d{2}月\/\d{2}月总“完整原文”\/\d{8}-[0-9a-z]{12}-[A-Z]-\d{8} 完整原文\.md$/.test(rel),
    `${label} 位置合法：${rel}`,
    `${label} 位置不合法：${rel}`);
  if (!exists(abs)) {
    for (const c of ['OR-03', 'OR-04', 'OR-05', 'OR-06', 'OR-07', 'OR-08', 'OR-09', 'OR-10', 'OR-11',
      'OR-12', 'OR-13', 'OR-14', 'OR-16', 'OR-17', 'OR-19', 'OR-24', 'OR-26', 'OR-27']) {
      R.fail(c, c, acOf(c), `${label} 原文文件不存在，无法判定`);
    }
    return null;
  }
  const text = readText(abs);
  const shape = tailShape(text);
  const fm = parseFrontMatter(text);
  const y = fm ? fm.raw : {};
  const v = (k) => yamlScalar(y[k]);
  const keys = fm ? fm.keys : [];

  R.judge('OR-03', 'OR-03', acOf('OR-03'),
    JSON.stringify(keys) === JSON.stringify(YAML_ORIGINAL_KEYS),
    `19 键顺序正确`,
    `YAML 键集/顺序不符：实际 ${keys.length} 键 ${JSON.stringify(keys)}`);
  R.judge('OR-04', 'OR-04', acOf('OR-04'),
    CODE_RE.test(v('编码')) && v('编码') === code && v('名称') === `${code} 完整原文`,
    `编码=“${v('编码')}” 名称=“${v('名称')}”`,
    `编码/名称自洽失败：编码=“${v('编码')}”（期望 ${code}） 名称=“${v('名称')}”`);
  R.judge('OR-05', 'OR-05', acOf('OR-05'),
    /^[0-9a-z]{12}$/.test(v('会话短ID')) && /^[A-Z]$/.test(v('代次')) && v('会话ID').length > 0 &&
      /^\d+$/.test(String(v('本轮序号'))),
    `会话短ID=${v('会话短ID')} 代次=${v('代次')} 会话ID 非空 本轮序号=${v('本轮序号')}`,
    `标识字段不合格：会话短ID=“${v('会话短ID')}”（长度 ${v('会话短ID').length}，要求 12） 代次=“${v('代次')}” 会话ID 长度=${v('会话ID').length}`);
  R.judge('OR-06', 'OR-06', acOf('OR-06'),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(v('对话开始')) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(v('对话结束')) &&
      !Z_TIME_RE.test(generatedPortionOriginal(text)),
    `对话开始/结束均为 ISO +08:00，生成字段无 Z 时间（正文逐字照录不参与，Lead 裁定①）`,
    `时间字段不合格：开始=“${v('对话开始')}” 结束=“${v('对话结束')}”`);
  R.judge('OR-07', 'OR-07', acOf('OR-07'),
    v('委托人') === 'user' && v('执行') === '日常会话记录插件（Tool）' && v('记录') === '系统（Cordis）' &&
      v('生成器').trim().length > 0 && !v('生成器').includes('{{') && v('正文hash算法') === HASH_ALGO_TEXT,
    `固定元信息一致；正文hash算法=“${v('正文hash算法')}”`,
    `固定元信息/正文hash算法不合格：委托人=${v('委托人')} 算法=“${v('正文hash算法')}”`);
  R.judge('OR-08', 'OR-08', acOf('OR-08'),
    /^seq \d+ – \d+$/.test(v('事件范围')),
    `事件范围=“${v('事件范围')}”`,
    `事件范围格式不符：“${v('事件范围')}”`);

  const tur = ctx.turn || null;
  const range = /^seq (\d+) – (\d+)$/.exec(v('事件范围'));
  const fromSeq = range ? Number(range[1]) : NaN;
  const toSeq = range ? Number(range[2]) : NaN;
  const bodySeqs = [...text.matchAll(/\[seq (\d+)\]/g)].map((m) => Number(m[1]));
  const coverageOk = !!tur && fromSeq <= tur.startSeq && toSeq >= (tur.endSeq === null ? tur.startSeq : tur.endSeq) &&
    bodySeqs.every((n) => n >= fromSeq && n <= toSeq);
  R.judge('OR-09', 'OR-09', acOf('OR-09'), coverageOk,
    `事件范围 ${v('事件范围')} 覆盖 turn/start.seq=${tur && tur.startSeq} ~ turn/end.seq=${tur && tur.endSeq}；正文 seq 全部在区间内`,
    `事件范围覆盖不足：范围=${v('事件范围')} turn=[${tur && tur.startSeq},${tur && tur.endSeq}] 越界 seq 数=${bodySeqs.filter((n) => n < fromSeq || n > toSeq).length}`);

  const rawLines = text.split('\n');
  const sectionIdx = FIVE_SECTIONS.map((h) => rawLines.findIndex((l) => l.trim() === h));
  const sectionsInOrder = sectionIdx.every((i) => i >= 0) && sectionIdx.every((v2, i) => i === 0 || v2 > sectionIdx[i - 1]);
  R.judge('OR-10', 'OR-10', acOf('OR-10'), sectionsInOrder,
    `五节标题逐字且顺序正确（索引 ${JSON.stringify(sectionIdx)}）`,
    `五节标题不符/乱序：${JSON.stringify(FIVE_SECTIONS.map((h, i) => [h, sectionIdx[i]]))}`);

  if (tur && Number.isFinite(fromSeq)) {
    const inRange = eventsInRangeLocal(sourceEvents, fromSeq, toSeq);
    const userAll = inRange.filter((e) => e.type === 'user/message');
    const userTrue = userAll.filter((e) => e.data && e.data.source && e.data.source.kind === 'user');
    const filtered = userAll.filter((e) => e.data && e.data.source && e.data.source.kind && e.data.source.kind !== 'user');
    const sec1Start = rawLines.findIndex((l) => l.trim() === '## 1. user/message');
    const sec2Start = rawLines.findIndex((l) => l.trim() === '## 2. assistant/message');
    const sec1Lines = sec1Start >= 0 && sec2Start > sec1Start ? rawLines.slice(sec1Start + 1, sec2Start) : [];
    // 每条 user/message 渲染为一行 `[seq N] HH:MM:SS`；按标记计数，避免用户原文里的空行被误算成段
    const userMarkers = sec1Lines.filter((l) => /^\[seq \d+\] \d{2}:\d{2}:\d{2}$/.test(l.trim())).length;
    const note = parseOriginalNote(text);
    const countSum = note ? [...note.kindCounts.values()].reduce((a, b) => a + b, 0) : 0;
    const kindMap = new Map();
    for (const e of filtered) {
      const k = e.data.source.kind;
      kindMap.set(k, (kindMap.get(k) || 0) + 1);
    }
    const kindMatch = kindMap.size === (note ? note.kindCounts.size : 0) &&
      [...kindMap.entries()].every(([k, n]) => note && note.kindCounts.get(k) === n);
    R.judge('OR-11', 'OR-11', acOf('OR-11'),
      userMarkers === userTrue.length && countSum === filtered.length && kindMatch,
      `## 1. 段落标记=${userMarkers} == kind=user 数=${userTrue.length}；备注按 kind 合计=${countSum} == 被过滤数=${filtered.length}，逐 kind 匹配=${kindMatch}`,
      `过滤口径不符：段落标记=${userMarkers}（应 ${userTrue.length}）备注合计=${countSum}（应 ${filtered.length}）逐kind匹配=${kindMatch}`);
    const expectedUi = ctx.expectShadowedCount;
    const sh = recomputeShadowed(sourceEvents, fromSeq, toSeq);
    const shadowedOk = expectedUi === undefined ? true : Number(v('被遮蔽事件数')) === expectedUi;
    R.judge('OR-12', 'OR-12', acOf('OR-12'),
      shadowedOk && (expectedUi !== undefined || !ctx.expectShadowed),
      `被遮蔽事件数=${v('被遮蔽事件数')}（独立复算=${sh.count}；期望=${expectedUi === undefined ? '(实时源)' : expectedUi}）`,
      `被遮蔽事件数不符：产物=“${v('被遮蔽事件数')}” 独立复算=${sh.count}${expectedUi === undefined ? '' : ` 期望=${expectedUi}`}`);
    const shadowSeqShown = [...sh.shadowed].filter((seq) => {
      const ev = sourceEvents.find((e) => e.seq === seq);
      return ev && DISPLAY_TYPES.has(ev.type);
    });
    const lost = shadowSeqShown.filter((seq) => !text.includes(`[seq ${seq}]`));
    R.judge('OR-13', 'OR-13', acOf('OR-13'),
      !ctx.expectShadowed || lost.length === 0,
      `被遮蔽且应在正文展示的 seq 全部可见：${JSON.stringify(shadowSeqShown)}`,
      `被遮蔽事件丢失：正文找不到 ${JSON.stringify(lost)}`);
  } else {
    R.fail('OR-11', 'OR-11', acOf('OR-11'), '缺少 turn/事件范围，无法复算过滤');
    R.fail('OR-12', 'OR-12', acOf('OR-12'), '缺少 turn/事件范围，无法复算遮蔽');
    R.fail('OR-13', 'OR-13', acOf('OR-13'), '缺少 turn/事件范围，无法复算遮蔽');
  }

  const bodyIdx = originalBodyStartIndex(text);
  const recomputed = bodyIdx >= 0 ? sha256Text(text.slice(bodyIdx)) : '';
  R.judge('OR-14', 'OR-14', acOf('OR-14'),
    recomputed.length === 64 && recomputed === v('正文hash'),
    `正文（## 1.→EOF）sha256=${recomputed} == YAML 正文hash`,
    `正文hash 复算不一致：复算=${recomputed} YAML=${v('正文hash')}`);

  // 文件清单形态（OR-16 启用形态 / OR-17 未启用形态）
  const fileCount = String(v('文件数')).trim();
  const filesRaw = String(y['文件'] === undefined ? '' : y['文件']).trim();
  const note = parseOriginalNote(text);
  const noteFirst = note ? note.firstLine : '';
  const disabledMark = noteFirst === '- 文件清单：未启用（真实采集排 v0.5）';
  if (fileCount === '0' && filesRaw === '[]') {
    R.judge('OR-17', 'OR-17', acOf('OR-17'), disabledMark,
      `未启用形态成对：文件数=0 文件=[] 备注首行=“${noteFirst}”`,
      `未启用形态不合规：文件数=0 且 文件=[]，但备注首行=“${noteFirst}”（要求逐字“- 文件清单：未启用（真实采集排 v0.5）”）`);
  } else {
    R.judge('OR-16', 'OR-16', acOf('OR-16'), Number(fileCount) === (ctx.fileEntries ? ctx.fileEntries.length : -1),
      `启用形态：文件数=${fileCount} 条目数=${ctx.fileEntries ? ctx.fileEntries.length : '(未提供)'}`,
      `启用形态不合格：文件数=${fileCount} 文件=${filesRaw.slice(0, 120)}`);
  }
  R.judge('OR-19', 'OR-19', acOf('OR-19'),
    note && !(note.isNone && note.lines.length > 1) && !(note.firstLine === '无' && note.lines.length > 1),
    `备注四类顺序可读：首行=“${noteFirst}”`,
    `备注形态不合格：首行=“${noteFirst}”`);

  const genOrig = generatedPortionOriginal(text);
  R.judge('OR-24', 'OR-24', acOf('OR-24'),
    !shape.hasBOM && shape.endsWithNewline && !shape.endsWithDoubleNewline &&
      !genOrig.includes('\r') && !genOrig.includes('{{') && !genOrig.includes('}}'),
    'UTF-8 无 BOM、恰好一个结尾换行；生成部分无 CR/占位符（正文逐字照录不参与，Lead 裁定①）',
    `编码不合格：BOM=${shape.hasBOM} 单尾换行=${shape.endsWithNewline && !shape.endsWithDoubleNewline} 生成部分 CR=${genOrig.includes('\r')} 占位符=${genOrig.includes('{{') || genOrig.includes('}}')}`);

  if (ctx.fileBlocks) {
    const hasPic = text.includes('[图片]');
    const hasFile = ctx.fileBlocks.filter((b) => b.type === 'file').every((b) => text.includes(`[文件] ${b.name}`));
    R.judge('OR-26', 'OR-26', acOf('OR-26'), hasPic && hasFile,
      `非文本块占位：[图片]=${hasPic} [文件]=${hasFile}`,
      `非文本块占位缺失：[图片]=${hasPic} [文件]name=${hasFile}；正文未见占位`);
  } else {
    R.judge('OR-26', 'OR-26', acOf('OR-26'), !ctx.expectImageFile, '本产物无 image/file 内容块（不触发）', 'OR-26 未覆盖');
  }

  if (record.status === 'partial') {
    R.judge('OR-27', 'OR-27', acOf('OR-27'),
      v('结束原因') === 'partial' && v('对话结束') === v('对话开始'),
      `partial 轮：结束原因=partial、对话结束==对话开始（${v('对话开始')}）`,
      `partial 轮字段不符：结束原因=“${v('结束原因')}” 开始=${v('对话开始')} 结束=${v('对话结束')}`);
  }
  return { abs, text, fm, y, keys };
}

// ---------------------------------------------------------------------------
// 4) 周记账 xlsx（probe 事实）
// ---------------------------------------------------------------------------
const cellV = (cells, coord) => (cells && cells[coord] ? cells[coord].v : undefined);

/** 独立复算「原始凭证」四态：只读 root 下原文文件 + 台账 doc 指针 + RPT 清册。 */
export function resolveDocState(root, record, cleaned) {
  const ts = String(record.ts || '');
  const y = ts.slice(0, 4); const m = ts.slice(5, 7);
  const expectedRel = path.posix.join(`${y}年${m}月`, `${m}月总“完整原文”`, `${record.code} 完整原文.md`);
  if (record.doc && exists(path.join(root, record.doc))) return { state: 'bound', rel: record.doc };
  if (exists(path.join(root, expectedRel))) return { state: record.doc ? 'bound' : 'backfilled', rel: expectedRel };
  if (cleaned && cleaned.has(record.code)) return { state: 'cleaned', report: cleaned.get(record.code) };
  return { state: 'missing' };
}

export function docLabel(st) {
  if (st.state === 'bound') return '绑定';
  if (st.state === 'backfilled') return '补记';
  if (st.state === 'cleaned') return `已清理(${st.report})`;
  return '缺凭证';
}

/** 独立解析 root 下 v1.3 新格式 + v0.4 旧格式清册：编码 → RPT 编号（只认「已删除」）。 */
export function parseCleanedCodes(root) {
  const map = new Map();
  for (const name of fs.readdirSync(root).sort()) {
    if (!/^RPT-\d{8}-\d{2}\.md$/.test(name)) continue;
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    const reportId = name.replace(/\.md$/, '');
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map((s) => s.trim());
      let code = '';
      for (const cell of cells) {
        const t = cell.replace(/`/g, '').trim();
        if (CODE_RE.test(t)) { code = t; break; }
      }
      if (!code) continue;
      if (cells.some((c) => c.replace(/[`*]/g, '').trim() === '已删除')) map.set(code, reportId);
    }
  }
  return map;
}

function groupRecordsOf(ledgerRecords, sessKey, spanFrom, spanTo) {
  return ledgerRecords.filter((r) => {
    if (!r || typeof r.code !== 'string' || !CODE_RE.test(r.code)) return false;
    if (`${r.code.slice(9, 21)}${r.code.slice(22, 23)}` !== sessKey) return false;
    const ts = String(r.ts || '');
    const d = ts.slice(0, 10);
    return d >= spanFrom && d <= spanTo;
  }).sort((a, b) => {
    const ta = Date.parse(a.ts); const tb = Date.parse(b.ts);
    if (ta !== tb) return ta - tb;
    return String(a.code).localeCompare(String(b.code));
  });
}

/** 周段内日期序列（含首尾；格式 YYYY-MM-DD）。 */
export function spanDatesOf(hdr) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hdr.spanFrom || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hdr.spanTo || '')) return out;
  let cur = hdr.spanFrom;
  for (let i = 0; i < 400; i += 1) {
    out.push(cur);
    if (cur === hdr.spanTo) break;
    cur = localDate(Date.parse(`${cur}T12:00:00+08:00`) + 86400000, 480);
  }
  return out;
}

/** 日期（YYYY-MM-DD）→ 周内序号（周一=0 … 周日=6）。 */
export function weekdayIndexByDate(d) {
  const p = localParts(Date.parse(`${d}T12:00:00+08:00`), 480);
  return (p.dow + 6) % 7;
}

/** 复算封板 hash（模板 7.3 黑盒口径）。 */
export function recomputeWeeklySeal({ sessKey, year, month, weekNo, records, root, cleaned }) {
  const byDow = new Map();
  for (const r of records) {
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    const p = localParts(ms, 480);
    const dow = (p.dow + 6) % 7; // 周一=0 … 周日=6
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow).push(r);
  }
  const rows = [];
  for (let dow = 0; dow < 7; dow += 1) {
    const list = (byDow.get(dow) || []).sort((a, b) => {
      const ta = Date.parse(a.ts); const tb = Date.parse(b.ts);
      if (ta !== tb) return ta - tb;
      return String(a.code).localeCompare(String(b.code));
    }).slice(0, 120);
    for (const r of list) {
      const doc = resolveDocState(root, r, cleaned);
      rows.push([r.code, docLabel(doc), hhmm(Date.parse(r.ts), 480), r.status === 'ok' ? '已完成' : '待确认']);
    }
  }
  const canonical = JSON.stringify({
    v: 6, sessKey, year, month, weekNo, offsetMinutes: 480, rowCount: rows.length, rows,
  });
  return { hash: sha256Text(canonical), rows, rowCount: rows.length, canonical };
}

export function checkWeeklyBook(R, ctx) {
  const { root, fact, ledgerRecords, id, expectDraft = null, expectSealed = null, cleaned } = ctx;
  const file = fact.file;
  const rel = path.relative(root, file).split(path.sep).join('/');
  const label = `[${id}] ${rel}`;
  const name = path.basename(file);
  R.judge('WK-01', 'WK-01', acOf('WK-01'),
    WEEKLY_NAME_RE.test(name) && new RegExp(`^\\d{4}年\\d{2}月/${WEEKLY_NAME_RE.source.slice(1, -1)}$`).test(rel),
    `${label} 文件名/位置合法`,
    `${label} 文件名/位置不合法`);
  if (!fact.ok) {
    for (const c of WK_IDS) R.fail(c, c, acOf(c), `${label} openpyxl 打开失败：${fact.error}`);
    return null;
  }
  R.judge('WK-02', 'WK-02', acOf('WK-02'),
    JSON.stringify(fact.sheetOrder) === JSON.stringify(WEEKLY_SHEET_ORDER),
    `openpyxl 打开成功；9 sheet 顺序正确：${fact.sheetOrder.join('/')}`,
    `sheet 顺序不符：${JSON.stringify(fact.sheetOrder)}`);

  const shuoming = (fact.sheets.find((s) => s.name === '说明') || {}).cells || {};
  const dayFacts = WEEKLY_SHEET_ORDER.slice(1, 8).map((n) => fact.sheets.find((s) => s.name === n)).filter(Boolean);
  const statFact = fact.sheets.find((s) => s.name === '周统计') || { cells: {} };
  const statCells = statFact.cells || {};
  const A = (coord) => cellV(shuoming, coord);
  const S = (coord) => cellV(statCells, coord);
  const smStrings = Object.values(shuoming).map((c) => c.v).filter((x) => typeof x === 'string');
  const allStrings = fact.strings || [];

  R.judge('WK-03', 'WK-03', acOf('WK-03'),
    A('A1') === '周记账模板 v1.3' && typeof A('A2') === 'string' && A('A2').includes('生成时间 ') && A('A2').includes('（UTC+08:00）'),
    `A1=“${A('A1')}”；A2 含“生成时间 ”与“（UTC+08:00）”`,
    `A1/A2 不符：A1=“${A('A1')}” A2=“${String(A('A2')).slice(0, 80)}”`);

  const a3 = String(A('A3') || '');
  const a4 = String(A('A4') || '');
  const a5 = String(A('A5') || '');
  const draftOk = a3.startsWith('状态: 草稿') && a3.includes('请勿批注') && a4 === '封板hash: —' && a5 === '封板时间: —';
  const sealedOk = a3.startsWith('状态: 已封板') && /^封板hash: [0-9a-f]{64}$/.test(a4) &&
    /^封板时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC\+08:00）$/.test(a5);
  const headerMode = draftOk ? 'draft' : sealedOk ? 'sealed' : 'unknown';
  // WK-04 只对草稿产物判、WK-05 只对已封板产物判；另一态由对应产物覆盖（不误报）
  const draftApplicable = headerMode === 'draft' || (headerMode === 'unknown' && expectDraft !== false);
  const sealedApplicable = headerMode === 'sealed' || (headerMode === 'unknown' && expectSealed !== false);
  const draftVerdict = headerMode === 'draft' ? draftOk : headerMode === 'sealed' ? (expectDraft !== true) : false;
  const sealedVerdict = headerMode === 'sealed' ? sealedOk : headerMode === 'draft' ? (expectSealed !== true) : false;
  R.judge('WK-04', 'WK-04', acOf('WK-04'), draftVerdict,
    headerMode === 'draft' ? `草稿文件头正确：A3=“${a3}” A4=“${a4}” A5=“${a5}”` : '本产物为已封板册，草稿头判据由草稿产物（Lab APP）覆盖',
    `草稿文件头不符：A3=“${a3}” A4=“${a4}” A5=“${a5}”（期望草稿态）`);
  R.judge('WK-05', 'WK-05', acOf('WK-05'), sealedVerdict,
    headerMode === 'sealed' ? `已封板文件头正确：A3=“${a3}” A4=“${a4}” A5=“${a5}”` : '本产物为草稿册，已封板头判据由已封板产物覆盖',
    `已封板文件头不符：A3=“${a3}” A4=“${a4}” A5=“${a5}”（期望已封板态）`);
  if (expectDraft === true && headerMode !== 'draft') {
    R.fail('WK-04', 'WK-04', acOf('WK-04'), `期望草稿态，实际 ${headerMode}`);
  }
  if (expectSealed === true && headerMode !== 'sealed') {
    R.fail('WK-05', 'WK-05', acOf('WK-05'), `期望已封板态，实际 ${headerMode}`);
  }

  // WK-06 说明页章节 / 负例
  const a8 = String(A('A8') || '');
  const items1 = [];
  for (let i = 9; i <= 17; i += 1) items1.push(String(A(`A${i}`) || ''));
  const a19 = String(A('A19') || '');
  const fieldRows = [];
  for (let i = 21; i <= 30; i += 1) fieldRows.push(String(A(`B${i}`) || ''));
  const a32 = String(A('A32') || '');
  const ruleRows = [];
  for (let i = 33; i <= 40; i += 1) ruleRows.push(String(A(`B${i}`) || ''));
  const a42 = String(A('A42') || '');
  const sealRows = [];
  for (let i = 43; i <= 49; i += 1) sealRows.push(String(A(`A${i}`) || ''));
  const a51 = String(A('A51') || '');
  const finalRows = [];
  for (let i = 52; i <= 54; i += 1) finalRows.push(String(A(`A${i}`) || ''));
  const negative = ['待定', '会标橙', '会被拦下', '标红', '按「日」重置（当前实现）', '建议只保留编码', '编码前 8 位应与它一致'];
  const hits = negative.filter((s) => allStrings.some((x) => x.includes(s)));
  const chaptersOk = a8 === '一、填写约定' && items1.every((x, i) => x === `${i + 1}.`) &&
    a19 === '二、字段定义' && fieldRows.every((x) => x.length > 0) &&
    a32 === '三、编码规则' && ruleRows.every((x) => x.length > 0) &&
    a42 === '四、状态与封板（v1.3 新增）' && sealRows.length >= 6 &&
    a51 === '五、已定口径（v1.3）' && finalRows.every((x) => x.length > 0);
  const hasStartDateRule = ruleRows.some((x) => x.includes('编码日期段'));
  const rule3 = ruleRows[2] || '';
  const rule7 = ruleRows[6] || '';
  const rule37Ok = [rule3, rule7].every((x) => x.includes('未实现条件格式') && (x.includes('不自动拦截') || x.includes('不会自动拦截')));
  R.judge('WK-06', 'WK-06', acOf('WK-06'),
    chaptersOk && hasStartDateRule && rule37Ok && hits.length === 0,
    `说明页章节齐备（约定9/字段10/规则8/封板7/已定3）；负例0命中；编码日期段规则=${hasStartDateRule}；第3/7条如实=${rule37Ok}`,
    `说明页不合规：章节=${chaptersOk} 负例命中=${JSON.stringify(hits)} 编码日期段规则=${hasStartDateRule} 第3/7条“不自动拦截”=${rule37Ok}`);
  R.judge('WK-07', 'WK-07', acOf('WK-07'), (() => {
    const a6 = String(A('A6') || '');
    return a6.includes('会话键: ') && a6.includes('周段: ') && a6.includes('所属月份: ') &&
      a6.includes('周序: 第') && a6.includes('记录数: ') && a6.includes('生成器: ');
  })(), `A6=“${String(A('A6') || '')}”`, `A6 字段不全：“${String(A('A6') || '')}”`);

  // 日表
  const headersOk = dayFacts.every((f) => JSON.stringify((f.headers || []).map((x) => x === null ? '' : x)) === JSON.stringify(WEEKLY_HEADERS));
  R.judge('WK-08', 'WK-08', acOf('WK-08'), headersOk,
    `7 张日表十列表头逐字正确`,
    `日表表头不符：${JSON.stringify(dayFacts.map((f) => f.headers))}`);
  const dimsOk = dayFacts.every((f) => f.dimensions === 'A1:J121' && f.maxRow === 121 && f.maxColumn === 10 && f.freeze === 'A2');
  R.judge('WK-09', 'WK-09', acOf('WK-09'), dimsOk,
    `7 张日表 A1:J121、freeze=A2`,
    `日表维度/freeze 不符：${JSON.stringify(dayFacts.map((f) => [f.dimensions, f.freeze]))}`);
  const dvOk = dayFacts.every((f) => {
    const dvs = f.dv || [];
    const decl = dvs.filter((d) => d.type === 'list').map((d) => ({ sqref: d.sqref, seq: d.formula1 }));
    const custom = dvs.filter((d) => d.type === 'custom');
    return dvs.length === 4 && custom.length === 1 && custom[0].sqref === 'A2:A121' && decl.length === 3;
  });
  const sqrefs = dayFacts[0] ? (dayFacts[0].dv || []).map((d) => `${d.type}:${d.sqref}`) : [];
  R.judge('WK-10', 'WK-10', acOf('WK-10'),
    dvOk && JSON.stringify((dayFacts[0].dv || []).map((d) => d.sqref).sort()) === JSON.stringify(['A2:A121', 'D2:D121', 'H2:H121', 'I2:I121']),
    `每张日表 4 条 dataValidations，sqref 集合正确：${sqrefs.join(' ')}`,
    `DV 数量/范围不符：${JSON.stringify(dayFacts.map((f) => (f.dv || []).map((d) => d.sqref)))}`);
  const formulaOk = dayFacts[0] && (dayFacts[0].dv || []).some((d) => d.type === 'custom' && d.sqref === 'A2:A121' && String(d.formula1 || '').trim() === CODE_DV_FORMULA);
  R.judge('WK-11', 'WK-11', acOf('WK-11'),
    dayFacts.every((f) => (f.dv || []).some((d) => d.type === 'custom' && String(d.formula1 || '').trim() === CODE_DV_FORMULA)),
    'A2:A121 编码校验公式逐字正确',
    `编码校验公式不符：${JSON.stringify(dayFacts.map((f) => ((f.dv || []).find((d) => d.sqref === 'A2:A121') || {}).formula1))}`);
  const listsOk = dayFacts.every((f) => {
    const get = (sq) => (f.dv || []).find((d) => d.sqref === sq) || {};
    const d = get('D2:D121'); const h = get('H2:H121'); const i = get('I2:I121');
    return d.formula1 === '"User,Agent,Tool"' && h.formula1 === '"已完成,进行中,中断,失败,待确认"' && i.formula1 === '"通过,不通过,待审"' &&
      d.allowBlank === true && h.allowBlank === true && i.allowBlank === true &&
      d.showErrorMessage === false && h.showErrorMessage === false && i.showErrorMessage === false;
  });
  R.judge('WK-12', 'WK-12', acOf('WK-12'), listsOk,
    '三列下拉序列逐字正确、allow_blank=true、showErrorMessage=false',
    `三列下拉不符：${JSON.stringify(dayFacts.map((f) => (f.dv || []).filter((d) => d.type === 'list').map((d) => [d.sqref, d.formula1, d.allowBlank, d.showErrorMessage])))}`);

  // 汇总所有行
  const rowsAll = [];
  for (let di = 0; di < dayFacts.length; di += 1) {
    for (const row of dayFacts[di].rows || []) rowsAll.push({ ...row, sheet: WEEKLY_SHEET_ORDER[di + 1] });
  }
  const aVals = rowsAll.map((r) => r.A);
  const codesOk = aVals.every((x) => typeof x === 'string' && CODE_RE.test(x));
  R.judge('WK-13', 'WK-13', acOf('WK-13'), codesOk,
    `A 列 ${aVals.length} 条编码全部匹配 32 位正则`,
    `A 列取值不合规：${JSON.stringify(aVals.filter((x) => typeof x !== 'string' || !CODE_RE.test(x)))}`);
  const contOk = dayFacts.every((f) => {
    const nums = f.rowNumbers || [];
    return nums.every((n, i) => n === i + 2) && nums.length <= 120;
  });
  R.judge('WK-14', 'WK-14', acOf('WK-14'), contOk,
    `非空行从第 2 行连续、每日 ≤120 行`,
    `行连续性/上限不合格：${JSON.stringify(dayFacts.map((f) => [f.rowNumbers && f.rowNumbers.length, f.rowNumbers && f.rowNumbers[0], f.rowNumbers && f.rowNumbers[f.rowNumbers.length - 1]]))}`);

  // WK-15 / WK-16 时间列
  const timeVals = rowsAll.map((r) => r.C);
  const timeFormatOk = timeVals.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x)));
  let timeOrderOk = true;
  for (const f of dayFacts) {
    const list = (f.rows || []).map((r) => ({ c: String(r.C), code: String(r.A) }));
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].c < list[i - 1].c) timeOrderOk = false;
      if (list[i].c === list[i - 1].c) {
        const seqA = Number(list[i - 1].code.slice(24)); const seqB = Number(list[i].code.slice(24));
        if (seqB < seqA) timeOrderOk = false;
      }
    }
  }
  R.judge('WK-15', 'WK-15', acOf('WK-15'), timeFormatOk && timeOrderOk,
    `C 列格式合法且同表内非降序`,
    `C 列格式/顺序不合格：format=${timeFormatOk} order=${timeOrderOk} 样例=${JSON.stringify(timeVals.slice(0, 5))}`);
  const byCode = new Map(ledgerRecords.filter((r) => r && r.code).map((r) => [r.code, r]));
  const timeMismatch = rowsAll.filter((r) => {
    const rec = byCode.get(String(r.A));
    return !rec || String(r.C) !== hhmm(Date.parse(rec.ts), 480);
  });
  R.judge('WK-16', 'WK-16', acOf('WK-16'), timeMismatch.length === 0,
    `C 列 ${rowsAll.length} 行与台账 ts 换算 +08:00 HH:MM 逐行相等`,
    `C 列与台账不符 ${timeMismatch.length} 行，如 ${JSON.stringify(timeMismatch.slice(0, 3).map((r) => [r.sheet, r.r, r.A, r.C]))}`);

  // WK-17 / WK-18 原始凭证四态
  const bVals = rowsAll.map((r) => String(r.B));
  const fourRe = /^(绑定|补记|缺凭证|已清理\(RPT-\d{8}-\d{2}\))$/;
  R.judge('WK-17', 'WK-17', acOf('WK-17'), bVals.every((x) => fourRe.test(x)),
    `B 列全部为四态之一（${[...new Set(bVals)].join('/')}）`,
    `B 列出现非法值：${JSON.stringify(bVals.filter((x) => !fourRe.test(x)))}`);
  const bMismatch = rowsAll.filter((r) => {
    const rec = byCode.get(String(r.A));
    if (!rec) return true;
    const st = resolveDocState(root, rec, cleaned);
    return docLabel(st) !== String(r.B);
  });
  R.judge('WK-18', 'WK-18', acOf('WK-18'), bMismatch.length === 0,
    `四态逐行独立复算一致（绑定/补记/已清理/缺凭证）`,
    `四态复算不一致 ${bMismatch.length} 行，如 ${JSON.stringify(bMismatch.slice(0, 5).map((r) => [r.A, r.B]))}`);

  // WK-19/20/21 机器初值
  const hMismatch = rowsAll.filter((r) => {
    const rec = byCode.get(String(r.A));
    const exp = rec && rec.status === 'ok' ? '已完成' : '待确认';
    return String(r.H) !== exp;
  });
  R.judge('WK-19', 'WK-19', acOf('WK-19'), hMismatch.length === 0,
    `H 列状态默认值正确（ok→已完成 / partial→待确认）`,
    `H 列映射不符 ${hMismatch.length} 行，如 ${JSON.stringify(hMismatch.slice(0, 5).map((r) => [r.A, r.H]))}`);
  R.judge('WK-20', 'WK-20', acOf('WK-20'), rowsAll.every((r) => String(r.I) === '待审'),
    `I 列全部为「待审」`,
    `I 列非「待审」：${JSON.stringify(rowsAll.filter((r) => String(r.I) !== '待审').slice(0, 3))}`);
  const manualOk = rowsAll.every((r) => ['D', 'E', 'F', 'G', 'J'].every((k) => String(r[k]) === '—'));
  R.judge('WK-21', 'WK-21', acOf('WK-21'), manualOk,
    `D/E/F/G/J 列机器初值全部为「—」`,
    `人工列初值不符：${JSON.stringify(rowsAll.filter((r) => ['D', 'E', 'F', 'G', 'J'].some((k) => String(r[k]) !== '—')).slice(0, 3))}`);

  // 解析 A6 头
  const a6 = String(A('A6') || '');
  const hdr = {
    sessKey: (/会话键: (\S+)/.exec(a6) || [])[1] || '',
    spanFrom: (/周段: (\S+) ~/.exec(a6) || [])[1] || '',
    spanTo: (/周段: \S+ ~ (\S+)/.exec(a6) || [])[1] || '',
    monthText: (/所属月份: (\S+)/.exec(a6) || [])[1] || '',
    weekNo: Number((/周序: 第(\d+)周/.exec(a6) || [])[1]),
    recordCount: Number((/记录数: (\d+)/.exec(a6) || [])[1]),
  };
  const groupRecs = groupRecordsOf(ledgerRecords, hdr.sessKey, hdr.spanFrom, hdr.spanTo);

  // WK-22 日期锚
  const spanDates = spanDatesOf(hdr);
  const expectedByDow = new Array(7).fill('—');
  for (const d of spanDates) expectedByDow[weekdayIndexByDate(d)] = d;
  const codeDateSegs = new Set(rowsAll.map((r) => String(r.A).slice(0, 8)));
  const recDates = new Set(groupRecs.map((r) => String(r.ts).slice(0, 10)));
  let dateAnchorOk = codeDateSegs.size === 1 && recDates.size > 0;
  if (dateAnchorOk) {
    const dateSeg = [...codeDateSegs][0];
    for (const rec of groupRecs) {
      const startDate = localDate(rec.docFrom, 480).replace(/-/g, '');
      if (startDate !== dateSeg) { dateAnchorOk = false; break; }
    }
  }
  // 行日期归属：日表内每行 ts 日期 == 该表星期
  const rowDateBad = [];
  for (let di = 0; di < dayFacts.length; di += 1) {
    const wname = WEEKLY_SHEET_ORDER[di + 1];
    for (const row of dayFacts[di].rows || []) {
      const rec = byCode.get(String(row.A));
      if (!rec) { rowDateBad.push([wname, row.A, '无台账']); continue; }
      const p = localParts(Date.parse(rec.ts), 480);
      if (WEEK_NAMES[p.dow] !== wname) rowDateBad.push([wname, row.A, WEEK_NAMES[p.dow]]);
    }
  }
  // B 列锚点：等于「本周段内该星期的日期」，不在段内则「—」；B=— 的日表 A 列必须全空
  const bAnchorBad = [];
  for (let di = 0; di < dayFacts.length; di += 1) {
    const wname = WEEKLY_SHEET_ORDER[di + 1];
    const b = String(S(`B${5 + di}`));
    const exp = expectedByDow[di];
    const hasRows = (dayFacts[di].rows || []).length > 0;
    if (b !== exp) bAnchorBad.push([wname, `B=${b}`, `应=${exp}`]);
    if (exp === '—' && hasRows) bAnchorBad.push([wname, '不在周段内却有行', String(hasRows)]);
  }
  R.judge('WK-22', 'WK-22', acOf('WK-22'), dateAnchorOk && rowDateBad.length === 0 && bAnchorBad.length === 0,
    `编码日期段=会话开始日（${[...codeDateSegs][0]}）；行日期按 ts 归属；B 列锚点=周段内日期（${JSON.stringify(spanDates)}）`,
    `日期锚不合格：编码日期段=${JSON.stringify([...codeDateSegs])} 会话开始日不符=${!dateAnchorOk} 行日期错=${JSON.stringify(rowDateBad.slice(0, 3))} B锚=${JSON.stringify(bAnchorBad.slice(0, 4))}`);

  // WK-23 会话一致
  const skBad = rowsAll.filter((r) => {
    const code = String(r.A);
    return `${code.slice(9, 21)}${code.slice(22, 23)}` !== hdr.sessKey;
  });
  R.judge('WK-23', 'WK-23', acOf('WK-23'), skBad.length === 0 && WEEKLY_NAME_RE.test(name),
    `全部编码会话段+代差 == 文件名 {S}{D}=${hdr.sessKey}`,
    `会话段不一致 ${skBad.length} 行`);

  // WK-24 行数守恒
  const overflow = Number(S('C13'));
  const rowsCount = rowsAll.length;
  const consOk = rowsCount + (Number.isFinite(overflow) ? overflow : NaN) === groupRecs.length;
  R.judge('WK-24', 'WK-24', acOf('WK-24'),
    consOk,
    `Σ日表行(${rowsCount}) + 溢出(${overflow}) == 台账记录数(${groupRecs.length})`,
    `行数不守恒：行=${rowsCount} 溢出=${overflow} 台账=${groupRecs.length}`);

  // WK-25..28 周统计
  const statsHead = ['A4', 'B4', 'C4', 'D4', 'E4', 'F4'].map((c) => String(S(c)));
  const weekLabels = ['A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11'].map((c) => String(S(c)));
  const statsHeadOk = JSON.stringify(statsHead) === JSON.stringify(['星期', '日期', '记录数', '审计通过', '审计未通过', '待审']) &&
    JSON.stringify(weekLabels) === JSON.stringify(['周一', '周二', '周三', '周四', '周五', '周六', '周日']) &&
    String(S('A12')) === '合计';
  R.judge('WK-25', 'WK-25', acOf('WK-25'), statsHeadOk,
    `周统计表头/星期/合计行逐字正确`,
    `周统计表头不符：${JSON.stringify([statsHead, weekLabels, S('A12')])}`);
  const cntFormulas = [];
  for (let i = 0; i < 7; i += 1) cntFormulas.push([`C${5 + i}`, `=COUNTA(${WEEKLY_SHEET_ORDER[i + 1]}!$A$2:$A$121)`]);
  R.judge('WK-26', 'WK-26', acOf('WK-26'),
    cntFormulas.every(([c, f]) => String(S(c)) === f),
    `C5:C11 均为 =COUNTA(<日表>!$A$2:$A$121)`,
    `记录数公式不符：${JSON.stringify(cntFormulas.map(([c, f]) => [c, S(c), f]))}`);
  const auditLabels = ['通过', '不通过', '待审'];
  let auditOk = true;
  const auditDetail = [];
  for (let i = 0; i < 7; i += 1) {
    for (let col = 0; col < 3; col += 1) {
      const coord = `${'DEF'[col]}${5 + i}`;
      const want = `=COUNTIF(${WEEKLY_SHEET_ORDER[i + 1]}!$I$2:$I$121,"${auditLabels[col]}")`;
      const got = String(S(coord));
      if (got !== want) { auditOk = false; auditDetail.push([coord, got, want]); }
    }
  }
  const noH = !Object.values(statCells).some((c) => typeof c.v === 'string' && c.v.includes('$H$'));
  R.judge('WK-27', 'WK-27', acOf('WK-27'), auditOk && noH,
    `D5:F11 均为 =COUNTIF(<日表>!$I$2:$I$121, …) 且不引用 $H$`,
    `审计公式不符：${JSON.stringify(auditDetail.slice(0, 4))} 引用$H$=${!noH}`);
  const sumOk = ['C12', 'D12', 'E12', 'F12'].every((c, i) => String(S(c)) === `=SUM(${'CDEF'[i]}5:${'CDEF'[i]}11)`);
  R.judge('WK-28', 'WK-28', acOf('WK-28'), sumOk,
    `C12:F12 均为 =SUM(X5:X11)`,
    `合计公式不符：${JSON.stringify(['C12', 'D12', 'E12', 'F12'].map((c) => S(c)))}`);

  // WK-29 日期锚列：非「—」日期集合 == 周段内日期集合
  const bVals2 = [];
  for (let i = 0; i < 7; i += 1) bVals2.push(String(S(`B${5 + i}`)));
  const bDateSet = bVals2.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  const expectedDateSet = [...spanDates].sort();
  const bWeekdayOk = bVals2.every((x, i) => {
    if (x === '—') return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
    const p = localParts(Date.parse(x + 'T00:00:00+08:00'), 480);
    return WEEK_NAMES[p.dow] === ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][i];
  });
  R.judge('WK-29', 'WK-29', acOf('WK-29'),
    JSON.stringify(bDateSet) === JSON.stringify(expectedDateSet) && bWeekdayOk,
    `B5:B11 非「—」日期集合 == 周段内日期集合 ${JSON.stringify(expectedDateSet)}`,
    `日期锚列不符：B=${JSON.stringify(bVals2)} 期望集合=${JSON.stringify(expectedDateSet)} 星期匹配=${bWeekdayOk}`);

  // WK-30 溢出
  const overflowExpected = (() => {
    const perDay = new Map();
    for (const rec of groupRecs) {
      const d = String(rec.ts).slice(0, 10);
      perDay.set(d, (perDay.get(d) || 0) + 1);
    }
    let over = 0;
    for (const n of perDay.values()) over += Math.max(0, n - 120);
    return over;
  })();
  const overflowRowOk = String(S('A13')) === '溢出（未写入本册）' &&
    Number.isFinite(Number(S('C13'))) && Number(S('C13')) === overflowExpected &&
    ['D13', 'E13', 'F13'].every((c) => String(S(c)) === '—');
  R.judge('WK-30', 'WK-30', acOf('WK-30'), overflowRowOk,
    `溢出行为数字 ${S('C13')} == 实际溢出 ${overflowExpected}；A13=溢出（未写入本册）；D13:F13=—`,
    `溢出行不符：A13=“${S('A13')}” C13=${S('C13')} 实际溢出=${overflowExpected} D13:F13=${JSON.stringify(['D13', 'E13', 'F13'].map(S))}`);

  // WK-31 / WK-32：空日与短周（口径 = 周统计 B 列锚点 + 日表是否有行）
  const recDateCount = new Map();
  for (const r of groupRecs) {
    const d = String(r.ts).slice(0, 10);
    recDateCount.set(d, (recDateCount.get(d) || 0) + 1);
  }
  const emptyDayBad = [];
  for (let di = 0; di < 7; di += 1) {
    const d = expectedByDow[di];
    const rows = (dayFacts[di].rowNumbers || []).length;
    if (d === '—') { if (rows > 0) emptyDayBad.push([dayFacts[di].name, '不在周段内却有行', rows]); }
    else if ((recDateCount.get(d) || 0) === 0 && rows > 0) emptyDayBad.push([dayFacts[di].name, `${d} 无记录却有行`, rows]);
    else if ((recDateCount.get(d) || 0) > 0 && rows === 0) emptyDayBad.push([dayFacts[di].name, `${d} 有记录却无行`, 0]);
  }
  R.judge('WK-31', 'WK-31', acOf('WK-31'), emptyDayBad.length === 0,
    `无记录日：日表 A 列全空（COUNTA=0，无占位行）`,
    `空日不符：${JSON.stringify(emptyDayBad.slice(0, 4))}`);
  const shortWeekBad = [];
  for (let di = 0; di < 7; di += 1) {
    if (expectedByDow[di] === '—') {
      if (String(S(`B${5 + di}`)) !== '—') shortWeekBad.push([dayFacts[di].name, 'B 应=—', S(`B${5 + di}`)]);
      if ((dayFacts[di].rowNumbers || []).length > 0) shortWeekBad.push([dayFacts[di].name, '日表应全空']);
    }
  }
  R.judge('WK-32', 'WK-32', acOf('WK-32'), shortWeekBad.length === 0,
    `月界切段：不在段内的日表全空、B=—（本册段 ${hdr.spanFrom} ~ ${hdr.spanTo}）`,
    `短周口径不符：${JSON.stringify(shortWeekBad.slice(0, 4))}`);

  // WK-37 封板 hash 独立复算（仅已封板态）
  let sealRecalc = null;
  if (headerMode === 'sealed') {
    const year = Number((hdr.monthText.match(/^(\d{4})年/) || [])[1]);
    const month = Number((hdr.monthText.match(/年(\d{2})月$/) || [])[1]);
    const recalc = recomputeWeeklySeal({ sessKey: hdr.sessKey, year, month, weekNo: hdr.weekNo, records: groupRecs, root, cleaned: cleaned || parseCleanedCodes(root) });
    sealRecalc = recalc;
    const a4Hash = (a4.match(/^封板hash: ([0-9a-f]{64})$/) || [])[1];
    R.judge('WK-37', 'WK-37', acOf('WK-37'),
      recalc.hash === a4Hash && recalc.rowCount === recalc.rows.length,
      `封板hash 独立复算一致：${recalc.hash}（rowCount=${recalc.rowCount}）`,
      `封板hash 复算不一致：复算=${recalc.hash} A4=${a4Hash} rowCount=${recalc.rowCount} rows=${recalc.rows.length}`);
  } else {
    R.judge('WK-37', 'WK-37', acOf('WK-37'), draftOk && a4 === '封板hash: —',
      '草稿态 A4=—（草稿无封板 hash）',
      `WK-37 草稿判定失败：A4=“${a4}”`);
  }

  // WK-44 无 Z
  R.judge('WK-44', 'WK-44', acOf('WK-44'), !allStrings.some((s) => Z_TIME_RE.test(String(s))),
    '工作簿内字符串无 Z 结尾时间',
    `工作簿内出现 Z 时间：${JSON.stringify(allStrings.filter((s) => Z_TIME_RE.test(String(s))).slice(0, 5))}`);

  return { hdr, rowsAll, groupRecs, headerMode, sealRecalc, statCells, shuoming, dayFacts, overflow, a4 };
}

// ---------------------------------------------------------------------------
// 5) state（台账运行区）
// ---------------------------------------------------------------------------
export function checkState(R, ctx) {
  const { root, id, expectSealing = true } = ctx;
  const p = path.join(root, 'ledger', '.state.json');
  const label = `[${id}] ledger/.state.json`;
  if (!exists(p)) {
    R.fail('HO-29', 'HO-29', acOf('HO-29'), `${label} 不存在`);
    R.fail('WK-36', 'WK-36', acOf('WK-36'), `${label} 不存在`);
    return null;
  }
  let state;
  try { state = JSON.parse(readText(p)); } catch (e) {
    R.fail('HO-29', 'HO-29', acOf('HO-29'), `${label} JSON 解析失败：${e.message}`);
    R.fail('WK-36', 'WK-36', acOf('WK-36'), `${label} JSON 解析失败`);
    return null;
  }
  const hs = state.handoverSealed || {};
  const ws = state.weeklySealed || {};
  const hoKeys = Object.keys(hs);
  const hoOk = hoKeys.length > 0 && hoKeys.every((k) => {
    const s = hs[k] || {};
    return /^[0-9a-z]{12}[A-Z]$/.test(k) &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(s.sealedAt || '')) &&
      /^[0-9a-f]{64}$/.test(String(s.sealHash || '')) &&
      typeof s.main === 'string' && s.main.length > 0 && typeof s.appendix === 'string' && s.appendix.length > 0;
  });
  const hoHashOk = hoKeys.every((k) => {
    const s = hs[k] || {};
    const mainPath = path.join(root, String(s.main || handoverMainName(k)));
    if (!exists(mainPath)) return false;
    const fm = parseFrontMatter(readText(mainPath));
    return fm && yamlScalar(fm.raw['封板hash']) === String(s.sealHash);
  });
  R.judge('HO-29', 'HO-29', acOf('HO-29'), hoOk && hoHashOk,
    `handoverSealed ${hoKeys.length} 条，字段齐全且 sealHash==产物封板hash`,
    `handoverSealed 结构不合格：${JSON.stringify(hoKeys.map((k) => hs[k]).slice(0, 2))}`);
  const wkOk = Object.keys(ws).length > 0 && Object.keys(ws).every((gid) => {
    const s = ws[gid] || {};
    // gid 格式（模板 7.4）：`{year}-{MM}-{weekNo}|{S}{D}`，weekNo 不补零（如 2026-11-2|…）
    return /^\d{4}-\d{2}-\d{1,2}\|[0-9a-z]{12}[A-Z]$/.test(gid) &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(s.sealedAt || '')) &&
      /^[0-9a-f]{64}$/.test(String(s.sealHash || '')) && typeof s.file === 'string' && s.file.length > 0 &&
      s.layout === 6 && Number.isInteger(s.rows);
  });
  R.judge('WK-36', 'WK-36', acOf('WK-36'), wkOk,
    `weeklySealed ${Object.keys(ws).length} 组，字段齐全（sealedAt/sealHash/file/layout=6/rows）`,
    `weeklySealed 结构不合格：${JSON.stringify(Object.entries(ws).slice(0, 2))}`);
  R.judge('WK-38', 'WK-38', acOf('WK-38'), state.weeklyLayout === 6,
    `state.weeklyLayout=${state.weeklyLayout}`,
    `state.weeklyLayout=${state.weeklyLayout}（期望 6）`);
  return state;
}

// ---------------------------------------------------------------------------
// 6) 全局扫描
// ---------------------------------------------------------------------------
export function checkLayout(R, ctx) {
  const { root, id, allow = [] } = ctx;
  const label = `[${id}] ${root}`;
  const lvl1 = listFirstLevel(root);
  const allowedRe = [
    MAIN_NAME_RE, APPENDIX_NAME_RE, /^RPT-\d{8}-\d{2}\.md$/, /^\d{4}年\d{2}月$/, SUPP_NAME_RE, /\.旧-\d{8}-\d{6}$/,
  ];
  const bad = lvl1.filter((e) => !e.dir && !allowedRe.some((re) => re.test(e.name)) && !allow.includes(e.name));
  const badDir = lvl1.filter((e) => e.dir && !MONTH_DIR_RE.test(e.name) && e.name !== 'ledger');
  R.judge('GL-01', 'GL-01', acOf('GL-01'), bad.length === 0 && badDir.length === 0,
    `一级目录仅档案产物 + ledger 运行区：${lvl1.map((e) => e.name).join(' | ')}`,
    `一级出现非档案条目：文件=${JSON.stringify(bad.map((e) => e.name))} 目录=${JSON.stringify(badDir.map((e) => e.name))}`);
  const monthDirs = lvl1.filter((e) => e.dir && MONTH_DIR_RE.test(e.name)).map((e) => e.name);
  R.judge('GL-02', 'GL-02', acOf('GL-02'), monthDirs.every((n) => MONTH_DIR_RE.test(n)),
    `月份文件夹名合法：${monthDirs.join(' | ') || '(无)'}`,
    `月份文件夹名非法：${JSON.stringify(monthDirs)}`);
  const e3dirs = [];
  const originalsBad = [];
  for (const md of monthDirs) {
    const p = path.join(root, md);
    for (const sub of fs.readdirSync(p)) {
      const sp = path.join(p, sub);
      if (!fs.statSync(sp).isDirectory()) continue;
      e3dirs.push(sub);
      if (!E3_DIR_RE.test(sub)) { originalsBad.push(`${md}/${sub} 目录名非法`); continue; }
      for (const f of fs.readdirSync(sp)) {
        if (!ORIGINAL_NAME_RE.test(f)) originalsBad.push(`${md}/${sub}/${f}`);
      }
    }
  }
  R.judge('GL-03', 'GL-03', acOf('GL-03'), originalsBad.length === 0 && e3dirs.every((n) => E3_DIR_RE.test(n)),
    `第三级目录/文件名全部合法：${e3dirs.join(' | ') || '(无)'}`,
    `第三级结构非法：${JSON.stringify(originalsBad.slice(0, 5))}`);
  const xlsxLevel1 = lvl1.filter((e) => !e.dir && e.name.endsWith('.xlsx')).map((e) => e.name);
  R.judge('GL-04', 'GL-04', acOf('GL-04'), xlsxLevel1.length === 0,
    '一级目录不出现 *.xlsx',
    `一级出现 xlsx：${JSON.stringify(xlsxLevel1)}`);
}

/** 所有文本产物 + xlsx 字符串的统一扫描：Z 时间 / 占位符 / 编码 / GL-18 自相矛盾文字。 */
export function checkGlobalTexts(R, ctx) {
  const { root, id, xlsxFacts = [] } = ctx;
  const artifacts = listArtifacts(root);
  // ★ Lead 裁定①：+08:00/无 Z/无 {{}}/无 CR 只判「生成字段」——
  //   完整原文正文、附表 block 正文是逐字照录，不在扫描范围。
  const mdTexts = artifacts.filter((a) => a.text !== null)
    .map((a) => ({ rel: a.rel, text: generatedPortionOf(a.rel, a.text) }));
  const stringsAll = [];
  for (const f of xlsxFacts) for (const s of (f.strings || [])) stringsAll.push({ rel: path.basename(f.file), text: String(s) });
  const allTexts = [...mdTexts, ...stringsAll];

  const zHits = [];
  for (const t of allTexts) {
    const m = String(t.text).match(Z_TIME_RE);
    if (m) zHits.push({ rel: t.rel, hit: m.slice(0, 2) });
  }
  R.judge('GL-05', 'GL-05', acOf('GL-05'), zHits.length === 0,
    `全部产物无 Z 结尾 UTC 时间（扫描 ${allTexts.length} 段文本）`,
    `出现 Z 结尾时间：${JSON.stringify(zHits.slice(0, 5))}`);

  const phHits = allTexts.filter((t) => String(t.text).includes('{{') || String(t.text).includes('}}'));
  R.judge('GL-15', 'GL-15', acOf('GL-15'), phHits.length === 0,
    `全部产物无 {{ / }} 占位符残留`,
    `出现占位符：${JSON.stringify(phHits.slice(0, 3).map((h) => h.rel))}`);

  const badCodes = [];
  for (const rec of readLedger(root).records) {
    if (!rec || !rec.code) continue;
    if (!CODE_RE.test(String(rec.code)) || String(rec.code).includes('-B-') || String(rec.code).length !== 32) badCodes.push(rec.code);
  }
  for (const a of artifacts) {
    if (!ORIGINAL_NAME_RE.test(path.basename(a.rel))) continue;
    const code = path.basename(a.rel).slice(0, 32);
    if (!CODE_RE.test(code)) badCodes.push(path.basename(a.rel));
  }
  R.judge('GL-06', 'GL-06', acOf('GL-06'), badCodes.length === 0,
    `台账/文件名编码全部为 32 位规范编码、无 -B 后缀`,
    `出现非规范编码：${JSON.stringify(badCodes.slice(0, 5))}`);

  // GL-18 铁律：与实现/口径相矛盾的说明文字
  const negatives = [
    { re: /待定/, why: '说明页残留「待定」（决定9#20）' },
    { re: /会标橙/, why: '承诺未实现的条件格式「会标橙」' },
    { re: /会被拦下/, why: '承诺未实现的能力「会被拦下」' },
    { re: /标红/, why: '承诺「标红」' },
    { re: /按「日」重置（当前实现）/, why: '与编码规范矛盾的「按日重置」' },
    { re: /建议只保留编码/, why: '与决定0矛盾的「建议只保留编码」' },
    { re: /编码前 8 位应与它一致/, why: '错误等值要求「编码前8位应与它一致」' },
    { re: /年月日由编码前 8 位承载/, why: '声称行日期由编码前 8 位承载（与决定6/实现反馈#2 矛盾）' },
    { re: /当日第 1 条/, why: '编码示例注称「当日第1条」，与同页「序号=会话内计数」自相矛盾' },
  ];
  const g18 = [];
  for (const t of allTexts) {
    for (const n of negatives) {
      if (n.re.test(String(t.text))) g18.push({ rel: t.rel, why: n.why });
    }
  }
  R.judge('GL-18', 'GL-18', acOf('GL-18'), g18.length === 0,
    '全部产物未见「与自身实现相矛盾」的说明文字（负例清单 0 命中）',
    `GL-18 命中 ${g18.length} 处：${JSON.stringify(g18.slice(0, 6))}`);
}

/** 台账只追加 / 唯一性（GL-14）+ 行数关系（任务级）。 */
export function checkLedgerBasics(R, ctx) {
  const { root, id, expectSessions = null } = ctx;
  const ledger = readLedger(root);
  const label = `[${id}] ledger`;
  const badJson = ledger.badLines;
  const keys = new Set();
  const codeSet = new Set();
  const dup = [];
  const lineEndOk = ledger.files.every((f) => {
    const text = readText(f.path);
    return text.length === 0 || text.endsWith('\n');
  });
  let sidTurnUnique = true;
  for (const r of ledger.records) {
    if (!r || typeof r !== 'object') { continue; }
    if (typeof r.sid === 'string' && Number.isInteger(r.turn)) {
      const k = `${r.sid}#${r.turn}`;
      if (keys.has(k)) { sidTurnUnique = false; dup.push(k); }
      keys.add(k);
    }
    if (r.code) {
      if (codeSet.has(r.code)) { sidTurnUnique = false; dup.push('code:' + r.code); }
      codeSet.add(r.code);
    }
  }
  R.judge('GL-14', 'GL-14', acOf('GL-14'),
    badJson === 0 && lineEndOk && sidTurnUnique,
    `${ledger.files.length} 个日账文件、${ledger.records.length} 行；每行 JSON 可解析、文件尾换行、同一 (sid,turn) 唯一`,
    `台账不合格：坏行=${badJson} 尾换行=${lineEndOk} 重复=${JSON.stringify(dup.slice(0, 5))}`);
  return { ledger, sidTurnUnique, codeSet };
}
