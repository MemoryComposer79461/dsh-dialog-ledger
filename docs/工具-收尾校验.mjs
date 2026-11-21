#!/usr/bin/env node
/**
 * @file docs/工具-收尾校验.mjs
 * @role 终包 13 项收尾校验（随包、零依赖、只读、可复跑）。
 *
 * @why 审计 re3（出包流程方案 §2.4/§3）：13 项的实现是开发机 `_工作\tools\收尾校验-异机包.mjs`，
 *      **不随包**；包内 `13-收尾校验.json` 的 `finalMode` 因此是"只有产物、没有生产者"的孤儿字段，
 *      而且它测的是候选包 Z1（759 条目），交付终包 Z2（761 条目）从未过门。本文件把 13 项做成
 *      包内可执行版本：把 zip 解压到一个干净目录（另一盘符/全新 TEMP，见 `工具-出包门.mjs`），
 *      然后用 `--pkg=<解压树>/01-插件包 --zip=<终包 zip> --expect-sha=<发布锚里的 sha256>` 直接
 *      对**终包 zip + 其解压树**跑；`finalMode` 由"是否成功对终包执行"现场决定，不接受手填，
 *      `target.sha256` 现场 re-hash 实际 zip 得到，不接受外部传入。
 *
 * @invariant 不修改 zip、不修改交付树、不写交付根；唯一写入是 `--out` 指定的 JSON（应在包外）。
 *
 * 13 项（与 re3 的旧 13 项不同：本版**不跑** 45 条/设备自检，只做交付物本身的字节与清单一致性）：
 *   01 内层 MANIFEST 逐条复算（缺/多/改 = 0）
 *   02 外层 MANIFEST 逐条复算（缺/多/改 = 0）
 *   03 两层清单格式/编码/排序（64hex + 双空格 + LF + 无 BOM + 码元序 + 无重复 + 无非法路径）
 *   04 zip 条目数 = 外层文件数 + 1（外层 MANIFEST）+ 显式排除面（默认 04-结果）
 *   05 内层/外层文件名集合 1:1（清单声明 ↔ zip 条目名；内层清单必须被外层清单绑定）
 *   06 全条目 UTF-8 通用标志 bit 11
 *   07 最长条目路径 ≤ --max-path（默认 260 字符，Windows MAX_PATH 口径）
 *   08 无目录/空目录条目 + 条目名唯一 + 无路径穿越/绝对路径/反斜杠/.git 禁入
 *   09 zip 逐条 CRC32 重算 + 解压长度相符
 *   10 zip ↔ 解压树逐字节一致
 *   11 04-结果 不被外层清单覆盖（否则接收端填备注/写结果立刻 changed）
 *   12 zip 内无绝对主机路径残留（构建机用户目录/工作根/干净房；条目名 + 内容扫描，
 *      每个词按变形集匹配：原始 / JSON 双反斜杠转义 / 正斜杠 / URL 编码 / 8.3 短名）
 *   13 终包 sha256 与 --expect-sha 一致（现场对 zip 文件 re-hash）
 *
 * 用法：
 *   node docs\工具-收尾校验.mjs --pkg=<解压树>\01-插件包 --zip=<终包 zip> --out=<json>
 *        [--expect-sha=<64hex>] [--final] [--prefix=<zip 内顶层目录名>] [--max-path=260]
 *        [--exclude-scope=04-结果] [--residue=...] [--content-residue=...] [--json] [--help]
 *     --pkg=<dir>            解压树里的 `01-插件包` 目录（交付根 = 其上一级）。必填。
 *     --zip=<file>           终包 zip（只读）。必填。
 *     --out=<file>           13 项结果 JSON（建议写包外；不写交付根）。必填。
 *     --expect-sha=<hex>     发布锚里的终包 sha256；--final 时必填，否则第 13 项只记录不比对。
 *     --final                终包模式：第 13 项必须拿到 --expect-sha；成功后输出 finalMode:true。
 *     --prefix=<name>        zip 内顶层目录名；默认自动探测（条目共有的第一段且交付根无同名目录）。
 *     --max-path=<n>         第 07 项条目路径上限，默认 260。
 *     --exclude-scope=<a,b>  外层清单显式排除面（相对交付根的路径前缀），默认 04-结果。
 *     --residue=<a,b>        第 12 项条目名残留关键词，默认 `_工作` + 构建机绝对主机路径（见文件内 K-21/W-06 注释）。
 *     --content-residue=<a,b> 第 12 项内容残留关键词，默认 = 构建机用户目录/工作根/干净房绝对路径；
 *                            `_工作` 只在条目名里算残留（文档/证据里记录来历属正常，可用本参数加严）。
 *                            每个词都按**变形集**匹配：原始 / JSON·JS 双反斜杠转义 / 正斜杠 / URL 编码 /
 *                            8.3 短名（W-06：旧实现只认原文，转义形态全漏）。
 *     --json                 stdout 打印完整 JSON（默认打印逐项摘要）。
 *   退出码：0 = 13/13 全过；1 = 有红项；2 = 用法/环境错误（不是"校验失败"）。
 *
 * @reads  <zip>（只读）、<pkg>/**（只读）、<交付根>/MANIFEST.sha256（只读）
 * @writes <out>（JSON；默认不写别的）
 * @depends node:fs/path/crypto/zlib/os/url（零第三方依赖；zip 读取支持 store/deflate，不支持 zip64/分卷）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const TOOL = '工具-收尾校验';
const SCHEMA = 'delivery-final-check/3';
const TOOL_VERSION = '1.0.0';
const MANIFEST_NAME = 'MANIFEST.sha256';

function usage(msg) {
  if (msg) console.error(`[用法错误] ${msg}`);
  console.error('用法: node docs\\工具-收尾校验.mjs --pkg=<解压树>\\01-插件包 --zip=<zip> --out=<json> [--expect-sha=<hex>] [--final] [--prefix=] [--json]');
  console.error('      node docs\\工具-收尾校验.mjs --help   （查看文件头完整说明）');
  process.exit(2);
}

const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : '';
};
const hasFlag = (k) => argv.includes(`--${k}`);
if (hasFlag('help') || hasFlag('-h')) {
  console.log(fs.readFileSync(THIS_FILE, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^\s*$/gm, '').trim());
  process.exit(0);
}
const ALLOWED = ['pkg', 'zip', 'out', 'expect-sha', 'final', 'prefix', 'max-path', 'exclude-scope', 'residue', 'content-residue', 'json', 'help'];
for (const a of argv) {
  if (!a.startsWith('--')) usage(`不认识的裸参数：${a}`);
  const k = a.slice(2).split('=')[0];
  if (!ALLOWED.includes(k) && k !== 'h') usage(`不认识的参数 --${k}`);
}

const normRel = (s) => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const splitList = (s) => (s || '').split(',').map((x) => normRel(x.trim())).filter(Boolean);

const PKG = path.resolve(argOf('pkg'));
const ZIP = path.resolve(argOf('zip'));
const OUT = path.resolve(argOf('out'));
const EXPECT_RAW = (argOf('expect-sha') || '').trim().toLowerCase();
const FINAL = hasFlag('final');
const AS_JSON = hasFlag('json');
const EXPLICIT_PREFIX = normRel(argOf('prefix'));
const MAX_PATH = Number(argOf('max-path') || 260);
const SCOPE = splitList(argOf('exclude-scope') || '04-结果');
// ★ K-21（re4）：残留默认词表收紧为"**绝对主机路径**"。
//   旧默认含通用 `%TEMP%` / `%TMP%` / `AppData\Local\Temp` —— 它们在设计文档与证据里是**正常用语**
//   （判据 lab 本来就落在 os.tmpdir()），按旧口径终包必然"命中数百处"，只能靠人解释，等于把门开成摆设。
//   真正该拦的是**本机绝对路径**（构建机用户目录/工作根/干净房）：这几类命中 1 次就该红。
const RESIDUE_NAME = (argOf('residue') || '_工作,C:\Users\<user>,C:\Users\<user>,C:\Users\<user>,C:\Users\<user>,D:\\re4-work,D:/re4-work,E:\\re4-gate,E:/re4-gate,<work-dir>,<work-dir>,E:\\p5-gate,E:/p5-gate').split(',').map((s) => s.trim()).filter(Boolean);
const RESIDUE_CONTENT = (argOf('content-residue') || 'C:\Users\<user>,C:\Users\<user>,C:\Users\<user>,C:\Users\<user>,D:\\re4-work,D:/re4-work,D:\\clean-test,D:/clean-test,E:\\re4-clean,E:/re4-clean,E:\\re4-gate,E:/re4-gate,<work-dir>,<work-dir>,E:\\p5-gate,E:/p5-gate').split(',').map((s) => s.trim()).filter(Boolean);
// ★ W-06（re4 收尾审计）：上面词表是**单反斜杠原文**，只认 `C:\Users\<user>` 这种形态；而 JSON / JS
//   文本里的主机路径被转义成 `C:\Users\<user>`（双反斜杠）→ 用原文 `indexOf` 永远不中 = **假阴性**
//   （比假阳性危险）。修法只改**匹配口径**、不缩词表（K-21 的「绝对主机路径」口径保留）：
//   把每个字面词扩成**变形集**再匹配 —— 原始 / JSON·JS 双反斜杠转义 / 正斜杠 / URL 编码（%5C %3A %2F）/
//   8.3 短名（ADMINI~1 ↔ Administrator）。词表自指排除仍保留（第 12 项 SELF_ENTRY，见 item 12）。
const RESIDUE_SHORT83 = [['Administrator', 'ADMINI~1']];
const RESIDUE_NAME_PATTERNS = residuePatternSet(RESIDUE_NAME);
const RESIDUE_CONTENT_PATTERNS = residuePatternSet(RESIDUE_CONTENT);

if (!argOf('pkg')) usage('必须 --pkg=<解压树里的 01-插件包 目录>');
if (!argOf('zip')) usage('必须 --zip=<终包 zip>');
if (!argOf('out')) usage('必须 --out=<13 项结果 JSON（建议包外）>');
if (!Number.isFinite(MAX_PATH) || MAX_PATH <= 0) usage('--max-path 必须是正整数');
if (FINAL && !/^[0-9a-f]{64}$/.test(EXPECT_RAW)) usage('--final 必须同时给 --expect-sha=<64 位小写 hex>（来自发布锚，不接受手填猜测）');
if (EXPECT_RAW && !/^[0-9a-f]{64}$/.test(EXPECT_RAW)) usage('--expect-sha 必须是 64 位小写 hex');

const ROOT = path.dirname(PKG);
const INNER_DIR_NAME = path.basename(PKG);
const INNER_REL = `${INNER_DIR_NAME}/${MANIFEST_NAME}`;

// ---------------------------------------------------------------------------
// 一、基础工具
// ---------------------------------------------------------------------------
function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}
function absOf(root, rel) {
  return path.join(root, rel.split('/').join(path.sep));
}
/** 递归列文件（相对路径 / 分隔；跳过任意层级 .git；不跟符号链接；码元序排序）。与 工具-manifest.mjs 同口径。 */
function walkRel(rootAbs) {
  const out = [];
  const skippedLinks = [];
  const walk = (dir, base) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === '.git') continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        out.push(rel);
      } else if (ent.isSymbolicLink()) {
        skippedLinks.push(rel);
      }
    }
  };
  walk(rootAbs, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files: out, skippedLinks };
}
const isUnder = (rel, prefixes) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 一.5 第 12 项词表变形集（W-06：JSON/JS 转义形态盲区）
// ---------------------------------------------------------------------------
/** 按实际文本判定形态：原始 / JSON 双反斜杠转义 / 正斜杠 / URL 编码 / 混合。 */
function residueFormOf(text) {
  const hasUrl = /%[0-9A-Fa-f]{2}/.test(text);
  const hasEscaped = /\\\\/.test(text); // 文本里出现两个连续反斜杠
  const hasForward = text.includes('/');
  if (hasUrl) return hasEscaped || hasForward ? 'mixed' : 'url-encoded';
  if (hasEscaped) return hasForward ? 'mixed' : 'json-escaped';
  if (hasForward) return 'forward-slash';
  return 'raw';
}
/** URL 编码（整词）：反斜杠 / 冒号 / 正斜杠换成 %XX；upper 控制十六进制大小写。 */
function residueUrlEncode(word, upper) {
  const pct = upper ? ['%5C', '%3A', '%2F'] : ['%5c', '%3a', '%2f'];
  return word.replace(/\\/g, pct[0]).replace(/:/g, pct[1]).replace(/\//g, pct[2]);
}
/** 把一个字面词扩成变形集（去重）：原始 / JSON 双反斜杠转义 / 正斜杠 / URL 编码 / 8.3 短名。 */
function residueVariants(word) {
  const bases = new Set([word]);
  for (const [longName, shortName] of RESIDUE_SHORT83) {
    for (const b of [...bases]) {
      if (b.includes(longName)) bases.add(b.split(longName).join(shortName));
      if (b.includes(shortName)) bases.add(b.split(shortName).join(longName));
    }
  }
  const out = new Set();
  for (const base of bases) {
    const candidates = [
      base, // 原始（单反斜杠）
      base.replace(/\\/g, '\\\\'), // JSON / JS 双反斜杠转义
      base.replace(/\\/g, '/'), // 正斜杠
      residueUrlEncode(base, true), // URL 编码（大写）
      residueUrlEncode(base, false), // URL 编码（小写）
    ];
    for (const text of candidates) if (text) out.add(text);
  }
  return [...out];
}
/** 词表 → 去重变形集（同一文本只留一次，避免同一处被计两次）。 */
function residuePatternSet(words) {
  const out = new Set();
  for (const w of words) for (const p of residueVariants(w)) out.add(p);
  return [...out];
}
/** 统计 buffer 里 needle 的非重叠出现次数（按「处」计；不改 data）。 */
function countOccurrences(buf, needle) {
  let n = 0;
  let i = buf.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = buf.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---------------------------------------------------------------------------
// 二、ZIP 只读解析（中央目录权威；支持 store/deflate；逐条重算 CRC32）
// ---------------------------------------------------------------------------
function parseZip(zipPath) {
  const fileBuf = fs.readFileSync(zipPath);
  let eocd = -1;
  const floor = Math.max(0, fileBuf.length - 22 - 0xffff);
  for (let i = fileBuf.length - 22; i >= floor; i -= 1) {
    if (fileBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效 ZIP：找不到 EOCD');
  const disk = fileBuf.readUInt16LE(eocd + 4);
  const cdDisk = fileBuf.readUInt16LE(eocd + 6);
  const count = fileBuf.readUInt16LE(eocd + 10);
  const cdSize = fileBuf.readUInt32LE(eocd + 12);
  const cdOff = fileBuf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Error('不支持分卷 ZIP');
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('不支持 ZIP64；请用包内 docs\\工具-export.mjs 出包');
  if (cdOff + cdSize > fileBuf.length) throw new Error('中央目录越界');
  const entries = [];
  const bad = [];
  let p = cdOff;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > fileBuf.length || fileBuf.readUInt32LE(p) !== 0x02014b50) {
      bad.push({ name: `(中央目录第 ${i + 1} 项)`, reason: '中央目录项签名错' });
      break;
    }
    const flags = fileBuf.readUInt16LE(p + 8);
    const method = fileBuf.readUInt16LE(p + 10);
    const crc = fileBuf.readUInt32LE(p + 16);
    const compSize = fileBuf.readUInt32LE(p + 20);
    const rawSize = fileBuf.readUInt32LE(p + 24);
    const nameLen = fileBuf.readUInt16LE(p + 28);
    const extraLen = fileBuf.readUInt16LE(p + 30);
    const commentLen = fileBuf.readUInt16LE(p + 32);
    const localOff = fileBuf.readUInt32LE(p + 42);
    const name = fileBuf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const entry = { name, flags, method, crc, compSize, rawSize, localOff, isDir: name.endsWith('/'), sha256: null };
    try {
      if (localOff + 30 > fileBuf.length || fileBuf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地头签名错');
      if (flags & 1) throw new Error('加密条目不支持');
      const lNameLen = fileBuf.readUInt16LE(localOff + 26);
      const lExtraLen = fileBuf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      if (start + compSize > fileBuf.length) throw new Error('条目数据越界');
      const comp = fileBuf.subarray(start, start + compSize);
      let data;
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else throw new Error(`不支持的压缩方法 ${method}`);
      if (data.length !== rawSize) throw new Error(`解压长度不符 ${data.length} ≠ ${rawSize}`);
      const c = crc32(data);
      if (c !== crc) throw new Error(`CRC32 不符 ${c.toString(16)} ≠ ${crc.toString(16)}`);
      entry.sha256 = sha256Buf(data);
      entry.data = data;
    } catch (err) {
      bad.push({ name, reason: err.message });
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    entries,
    bad,
    bytes: fileBuf.length,
    fileSha256: sha256Buf(fileBuf),
    declaredCount: count,
  };
}

/** 探测 zip 内顶层目录前缀（`异机检测包-lite-vX-YYYYMMDD/` 这类）。 */
function detectPrefix(entryNames, rootAbs, zipBase) {
  if (EXPLICIT_PREFIX) {
    const ok = entryNames.every((n) => n === EXPLICIT_PREFIX || n.startsWith(`${EXPLICIT_PREFIX}/`));
    if (!ok) throw new Error(`--prefix=${EXPLICIT_PREFIX} 与 zip 条目名不符`);
    return EXPLICIT_PREFIX;
  }
  if (!entryNames.length) return '';
  const seg = entryNames[0].split('/')[0];
  if (!seg || entryNames.some((n) => !n.startsWith(`${seg}/`))) return '';
  const rootHasSame = fs.existsSync(path.join(rootAbs, seg));
  if (rootHasSame && seg !== zipBase) return '';
  return seg;
}

// ---------------------------------------------------------------------------
// 三、MANIFEST 解析（口径：一行 `<64hex>  <rel>`；LF；码元序）
// ---------------------------------------------------------------------------
function readManifest(abs, label) {
  const buf = fs.readFileSync(abs);
  const obj = {
    label,
    path: abs,
    bytes: buf.length,
    sha256: sha256Buf(buf),
    declared: new Map(),
    duplicates: [],
    badLines: [],
    blankLines: 0,
    bom: buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    crlf: buf.includes(0x0d),
    orderOk: true,
    utf8Replacement: false,
    lines: 0,
  };
  let text = buf.toString('utf8');
  if (obj.bom) text = text.replace(/^\uFEFF/, '');
  obj.utf8Replacement = text.includes('\uFFFD');
  const rawLines = text.split('\n');
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const seq = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (line.trim() === '') { obj.blankLines += 1; continue; }
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { obj.badLines.push({ line: i + 1, text: line.slice(0, 160) }); continue; }
    const rel = m[2];
    const issues = [];
    if (rel.includes('\\')) issues.push('反斜杠');
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) issues.push('绝对路径');
    if (rel.split('/').some((s) => s === '..' || s === '.' || s === '')) issues.push('非法路径段');
    if (issues.length) obj.badLines.push({ line: i + 1, text: line.slice(0, 160), issues });
    if (obj.declared.has(rel)) obj.duplicates.push(rel);
    obj.declared.set(rel, m[1]);
    seq.push(rel);
  }
  const sorted = [...seq].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  obj.orderOk = seq.every((v, i) => v === sorted[i]);
  obj.lines = obj.declared.size;
  return obj;
}

function compareDeclared(declared, actualMap) {
  const missing = [];
  const changed = [];
  for (const [rel, want] of declared) {
    if (!actualMap.has(rel)) { missing.push(rel); continue; }
    if (actualMap.get(rel) !== want) changed.push(rel);
  }
  const extra = [...actualMap.keys()].filter((rel) => !declared.has(rel));
  return { missing, extra, changed };
}

// ---------------------------------------------------------------------------
// 四、主流程
// ---------------------------------------------------------------------------
function main() {
  const t0 = Date.now();
  if (!fs.existsSync(PKG) || !fs.statSync(PKG).isDirectory()) usage(`--pkg 不是目录：${PKG}`);
  if (!fs.existsSync(ZIP) || !fs.statSync(ZIP).isFile()) usage(`--zip 不是文件：${ZIP}`);
  if (!fs.existsSync(path.join(PKG, MANIFEST_NAME))) usage(`--pkg 下缺 ${MANIFEST_NAME}：${path.join(PKG, MANIFEST_NAME)}（--pkg 应指向交付根里的 ${INNER_DIR_NAME}）`);
  if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) usage(`交付根不是目录：${ROOT}`);
  if (!fs.existsSync(path.join(ROOT, MANIFEST_NAME))) usage(`交付根缺外层 ${MANIFEST_NAME}：${path.join(ROOT, MANIFEST_NAME)}`);

  const zipBase = path.basename(ZIP).replace(/\.zip$/i, '');
  const zip = parseZip(ZIP);
  const zipFiles = zip.entries.filter((e) => !e.isDir);
  const zipDirs = zip.entries.filter((e) => e.isDir);
  const prefix = detectPrefix(zipFiles.map((e) => e.name), ROOT, zipBase);
  const stripPrefix = (name) => (prefix && (name === prefix || name.startsWith(`${prefix}/`)) ? name.slice(prefix.length + 1) : name);
  const relEntries = zipFiles.map((e) => ({ ...e, rel: stripPrefix(e.name) }));
  const entryByRel = new Map(relEntries.map((e) => [e.rel, e]));
  const zipRelNames = relEntries.map((e) => e.rel);
  const zipSet = new Set(zipRelNames);
  const zipDirRel = zipDirs.map((e) => stripPrefix(e.name));

  // 树（只读）与 sha256 缓存
  const rootWalk = walkRel(ROOT);
  const rootAll = rootWalk.files;
  const rootHash = new Map();
  for (const rel of rootAll) rootHash.set(rel, sha256File(absOf(ROOT, rel)));
  const excludedFiles = rootAll.filter((rel) => isUnder(rel, SCOPE) && rel !== MANIFEST_NAME);
  const innerActual = new Map();
  for (const rel of rootAll) {
    if (rel === INNER_REL) continue;
    if (rel === `${INNER_DIR_NAME}/${MANIFEST_NAME}`) continue;
    if (!rel.startsWith(`${INNER_DIR_NAME}/`)) continue;
    innerActual.set(rel.slice(INNER_DIR_NAME.length + 1), rootHash.get(rel));
  }
  const outerActual = new Map();
  for (const rel of rootAll) {
    if (rel === MANIFEST_NAME) continue;
    if (isUnder(rel, SCOPE)) continue;
    outerActual.set(rel, rootHash.get(rel));
  }

  const innerMfPath = path.join(PKG, MANIFEST_NAME);
  const outerMfPath = path.join(ROOT, MANIFEST_NAME);
  const innerMf = readManifest(innerMfPath, '内层');
  const outerMf = readManifest(outerMfPath, '外层');

  const rows = [];
  const add = (id, title, pass, detail, extra) => rows.push({ id, title, pass, detail, ...(extra || {}) });

  // 01 内层 MANIFEST
  {
    const cmp = compareDeclared(innerMf.declared, innerActual);
    const pass = innerMf.badLines.length === 0 && innerMf.duplicates.length === 0
      && cmp.missing.length === 0 && cmp.extra.length === 0 && cmp.changed.length === 0;
    add('01', '内层 MANIFEST 逐条复算（缺/多/改=0）', pass,
      `声明 ${innerMf.declared.size} / 实际 ${innerActual.size} / 缺 ${cmp.missing.length} / 多 ${cmp.extra.length} / 改 ${cmp.changed.length} / 坏行 ${innerMf.badLines.length}｜${INNER_REL}`,
      { counts: { declared: innerMf.declared.size, actual: innerActual.size, missing: cmp.missing.length, extra: cmp.extra.length, changed: cmp.changed.length }, sample: { missing: cmp.missing.slice(0, 10), extra: cmp.extra.slice(0, 10), changed: cmp.changed.slice(0, 10) } });
  }

  // 02 外层 MANIFEST
  {
    const cmp = compareDeclared(outerMf.declared, outerActual);
    const pass = outerMf.badLines.length === 0 && outerMf.duplicates.length === 0
      && cmp.missing.length === 0 && cmp.extra.length === 0 && cmp.changed.length === 0;
    add('02', '外层 MANIFEST 逐条复算（缺/多/改=0）', pass,
      `声明 ${outerMf.declared.size} / 实际 ${outerActual.size} / 缺 ${cmp.missing.length} / 多 ${cmp.extra.length} / 改 ${cmp.changed.length} / 坏行 ${outerMf.badLines.length}｜口径：排除 ${SCOPE.join(',') || '（无）'}（${excludedFiles.length} 文件）`,
      { counts: { declared: outerMf.declared.size, actual: outerActual.size, missing: cmp.missing.length, extra: cmp.extra.length, changed: cmp.changed.length }, sample: { missing: cmp.missing.slice(0, 10), extra: cmp.extra.slice(0, 10), changed: cmp.changed.slice(0, 10) } });
  }

  // 03 清单格式/编码/排序
  {
    const issues = [];
    for (const mf of [innerMf, outerMf]) {
      if (mf.bom) issues.push(`${mf.label}：带 UTF-8 BOM`);
      if (mf.crlf) issues.push(`${mf.label}：含 CR（应为 LF）`);
      if (mf.utf8Replacement) issues.push(`${mf.label}：不是合法 UTF-8`);
      if (mf.badLines.length) issues.push(`${mf.label}：坏行 ${mf.badLines.length}（前 3：${mf.badLines.slice(0, 3).map((b) => `第${b.line}行`).join('、')}）`);
      if (mf.duplicates.length) issues.push(`${mf.label}：重复声明 ${mf.duplicates.length}`);
      if (mf.blankLines) issues.push(`${mf.label}：空行 ${mf.blankLines}`);
      if (!mf.orderOk) issues.push(`${mf.label}：未按码元序升序`);
    }
    add('03', '两层清单格式/编码/排序', issues.length === 0,
      issues.length ? issues.join('；') : `内层 ${innerMf.lines} 行 / 外层 ${outerMf.lines} 行；UTF-8 无 BOM、LF、码元序、无重复、无非法路径`,
      { issues });
  }

  // 04 条目数
  {
    const expected = outerMf.declared.size + 1 + excludedFiles.length;
    const pass = zipFiles.length === expected && zipFiles.length === rootAll.length;
    add('04', 'zip 条目数 = 外层文件数 + 1（外层 MANIFEST）+ 排除面', pass,
      `zip 文件条目 ${zipFiles.length}｜外层声明 ${outerMf.declared.size} + 1（${MANIFEST_NAME}）+ 排除 ${excludedFiles.length} = ${expected}｜交付根文件 ${rootAll.length}｜zip 顶层前缀 ${prefix ? `"${prefix}"` : '（无）'}`,
      { counts: { zipEntries: zipFiles.length, outerDeclared: outerMf.declared.size, excluded: excludedFiles.length, expected, treeFiles: rootAll.length }, prefix });
  }

  // 05 内外层文件名集合 1:1
  {
    const innerSide = new Set([INNER_REL, ...[...innerMf.declared.keys()].map((r) => `${INNER_DIR_NAME}/${r}`)]);
    const expectedZip = new Set([...innerSide, ...outerMf.declared.keys(), MANIFEST_NAME, ...excludedFiles]);
    const missing = [...expectedZip].filter((r) => !zipSet.has(r));
    const extra = [...zipSet].filter((r) => !expectedZip.has(r));
    const binding = outerMf.declared.has(INNER_REL);
    const innerPaths = [...innerMf.declared.keys()].map((r) => `${INNER_DIR_NAME}/${r}`);
    const nested = innerPaths.every((r) => outerMf.declared.has(r));
    const layered = innerPaths.every((r) => !outerMf.declared.has(r));
    const mode = nested ? '嵌套（外层 ⊇ 内层）' : layered ? '分层（外层只声明外层 + 内层清单）' : '异常（内层文件被外层声明了一半）';
    const pass = missing.length === 0 && extra.length === 0 && binding && (nested || layered);
    add('05', '内层/外层文件名集合 1:1（清单声明 ↔ zip 条目名）', pass,
      `内层 ${innerMf.declared.size}+1（清单自身）↔ zip 内 ${innerPaths.length + 1}；外层 ${outerMf.declared.size}+排除 ${excludedFiles.length} ↔ zip 全部 ${zipFiles.length}；口径=${mode}；内层清单被外层清单绑定=${binding ? '有' : '无'}；缺 ${missing.length} / 多 ${extra.length}`,
      { mode, binding, counts: { innerDeclared: innerMf.declared.size, outerDeclared: outerMf.declared.size, zipEntries: zipFiles.length }, sample: { missing: missing.slice(0, 10), extra: extra.slice(0, 10) } });
  }

  // 06 UTF-8 bit 11
  {
    const missing = zip.entries.filter((e) => (e.flags & 0x0800) === 0).map((e) => e.name);
    add('06', '全条目 UTF-8 通用标志 bit 11', missing.length === 0,
      `缺失 ${missing.length}/${zip.entries.length}${missing.length ? `｜前 5：${missing.slice(0, 5).join('、')}` : ''}`,
      { sample: missing.slice(0, 10) });
  }

  // 07 最长条目路径
  {
    let longest = { name: '', len: 0 };
    for (const e of zip.entries) {
      const len = e.name.length;
      if (len > longest.len) longest = { name: e.name, len };
    }
    const pass = longest.len <= MAX_PATH;
    add('07', `最长条目路径 ≤ ${MAX_PATH}`, pass,
      `最长 ${longest.len} 字符（上限 ${MAX_PATH}）：${longest.name}`,
      { maxLen: longest.len, maxPath: longest.name });
  }

  // 08 目录/空目录 + 唯一 + 穿越/禁入
  {
    const dirEntries = zip.entries.filter((e) => e.isDir);
    const seen = new Set();
    const dups = [];
    for (const e of zip.entries) {
      if (seen.has(e.name)) dups.push(e.name);
      seen.add(e.name);
    }
    const traversal = [];
    for (const e of zip.entries) {
      const segs = e.name.split('/');
      const bad = [];
      if (e.name.includes('\\')) bad.push('反斜杠');
      if (e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name)) bad.push('绝对路径');
      if (segs.some((s) => s === '..' || s === '')) bad.push('非法路径段');
      if (bad.length) traversal.push(`${e.name}（${bad.join('/')}）`);
    }
    const forbidden = zip.entries.filter((e) => e.name.split('/').includes('.git'));
    const issues = dirEntries.length + dups.length + traversal.length + forbidden.length;
    add('08', '无目录/空目录条目 + 条目名唯一 + 无穿越/禁入', issues === 0,
      `目录条目 ${dirEntries.length}（含空目录）｜重名 ${dups.length}｜穿越/绝对/反斜杠 ${traversal.length}｜.git 禁入 ${forbidden.length}`,
      { sample: { dirs: dirEntries.slice(0, 5).map((e) => e.name), dups: dups.slice(0, 5), traversal: traversal.slice(0, 5), forbidden: forbidden.slice(0, 5) } });
  }

  // 09 CRC32
  {
    add('09', 'zip 逐条 CRC32 重算 + 解压长度相符', zip.bad.length === 0,
      `坏 ${zip.bad.length}/${zip.entries.length}${zip.bad.length ? `｜前 5：${zip.bad.slice(0, 5).map((b) => `${b.name}：${b.reason}`).join('；')}` : ''}`,
      { sample: zip.bad.slice(0, 10) });
  }

  // 10 zip ↔ 解压树逐字节一致
  {
    const missingInZip = rootAll.filter((r) => !zipSet.has(r));
    const extraInZip = zipRelNames.filter((r) => !rootHash.has(r));
    const diff = [];
    for (const rel of rootAll) {
      const e = entryByRel.get(rel);
      if (!e) continue;
      if (e.sha256 !== rootHash.get(rel)) diff.push(rel);
    }
    const pass = missingInZip.length === 0 && extraInZip.length === 0 && diff.length === 0;
    add('10', 'zip ↔ 解压树逐字节一致', pass,
      `树文件 ${rootAll.length} / zip 条目 ${zipFiles.length} / 缺 ${missingInZip.length} / 多 ${extraInZip.length} / 不一致 ${diff.length}｜前缀 "${prefix || ''}"`,
      { counts: { treeFiles: rootAll.length, zipEntries: zipFiles.length, missing: missingInZip.length, extra: extraInZip.length, diff: diff.length }, sample: { missing: missingInZip.slice(0, 10), extra: extraInZip.slice(0, 10), diff: diff.slice(0, 10) } });
  }

  // 11 04-结果 不被外层清单覆盖
  {
    const covered = [...outerMf.declared.keys()].filter((r) => isUnder(r, SCOPE));
    const pass = covered.length === 0;
    add('11', `${SCOPE.join(',') || '排除面'} 不被外层清单覆盖`, pass,
      pass
        ? `外层清单 ${SCOPE.join(',')} 行 0（排除生效：接收端填备注/写结果不会 changed；排除面 ${excludedFiles.length} 文件仍在 zip 内但不入清单）`
        : `外层清单仍覆盖 ${covered.length} 行（前 5：${covered.slice(0, 5).join('、')}）→ 填完备注即 changed`,
      { excluded: SCOPE, excludedFiles: excludedFiles.length, covered: covered.slice(0, 20) });
  }

  // 12 运行残留
  {
    // ★ K-25（v1.0.0-preview4）：**残留登记册**——把"生成物固有、且已随包披露的"残留与"未登记残留"分开。
    //   @why 第 3 轮审计 W-06 / WD-01：`证据/` 下是工具现场输出（判据/测试/自检日志），必然含生成机绝对路径；
    //        要么洗掉（毁掉可复现性）、要么如实登记。本版选后者：`docs/残留登记.json` 按**目录前缀**整体登记，
    //        第 12 项只在【未登记】残留 > 0 时判红，并把"已登记/未登记"两个计数都写进结果 JSON。
    //   fail-closed：登记册缺文件/不可解析 → 直接判红（绝不许"读不到登记册 = 没有残留"）。
    const RESIDUE_REG_FILE = path.join(PKG, 'docs', '残留登记.json');
    let residueReg = null;
    let residueRegErr = '';
    try {
      residueReg = JSON.parse(fs.readFileSync(RESIDUE_REG_FILE, 'utf8'));
    } catch (e) {
      residueRegErr = (e && e.message) ? e.message : String(e);
    }
    const regPrefixes = (residueReg && Array.isArray(residueReg.registeredPrefixes) ? residueReg.registeredPrefixes : [])
      .map((x) => String(x && typeof x === 'object' ? (x.prefix || '') : x)).filter(Boolean);
    // ★ 登记前缀写的是**包内相对路径**（如 `01-插件包/证据/`），而这里遍历的是 zip 条目名
    //   （`<zip顶层目录>/01-插件包/证据/…`）—— 先剥掉 zip 顶层目录再比，否则永远匹配不上
    //   （本版出包门 S4 第一次就跑出"已登记 0 处"的这个坑）。
    const zipTopDir = path.basename(ROOT);
    const stripTop = (entry) => (entry.startsWith(`${zipTopDir}/`) ? entry.slice(zipTopDir.length + 1) : entry);
    const isRegisteredEntry = (entry) => {
      const relEntry = stripTop(entry);
      return regPrefixes.some((p) => relEntry.startsWith(p) || relEntry.startsWith(p.replaceAll('/', '\\')));
    };
    const nameHits = []; // 文件×词 对（只作 sample 采样；命中总「处数」单计）
    const contentHits = [];
    const nameHitFiles = new Set();
    const contentHitFiles = new Set();
    const formCount = {}; // 名称/内容 命中按形态计（raw / json-escaped / forward-slash / url-encoded / mixed）
    let regOccurrences = 0;       // 已登记残留（处）
    const regFiles = new Set();
    let unregOccurrences = 0;     // 未登记残留（处）
    const unregFiles = new Set();
    const namePatterns = RESIDUE_NAME_PATTERNS.map((s) => ({ s, b: Buffer.from(s, 'utf8') }));
    const contentPatterns = RESIDUE_CONTENT_PATTERNS.map((s) => ({ s, b: Buffer.from(s, 'utf8') }));
    // ★ K-21（re4）：检查器自己的关键词表必然包含这些模式 → 对**自身条目**跳过内容扫描，
    //   否则第 12 项永远红（自指假阳性）。这不算放水：它只是一个字符串表，不是运行残留。
    const SELF_ENTRY = '工具-收尾校验.mjs';
    let selfSkipped = 0;
    let nameOccurrences = 0;
    let contentOccurrences = 0;
    for (const e of zipFiles) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      for (const p of namePatterns) {
        const n = countOccurrences(nameBuf, p.b);
        if (n === 0) continue;
        nameHits.push({ entry: e.name, pattern: p.s, where: 'name' });
        nameHitFiles.add(e.name);
        nameOccurrences += n;
        if (isRegisteredEntry(e.name)) { regOccurrences += n; regFiles.add(e.name); }
        else { unregOccurrences += n; unregFiles.add(e.name); }
        const form = residueFormOf(p.s);
        formCount[`name:${form}`] = (formCount[`name:${form}`] || 0) + n;
      }
      if (e.data) {
        if (e.name.endsWith(SELF_ENTRY)) { selfSkipped++; continue; }
        for (const p of contentPatterns) {
          const n = countOccurrences(e.data, p.b);
          if (n === 0) continue;
          contentHits.push({ entry: e.name, pattern: p.s, where: 'content' });
          contentHitFiles.add(e.name);
          contentOccurrences += n;
          if (isRegisteredEntry(e.name)) { regOccurrences += n; regFiles.add(e.name); }
          else { unregOccurrences += n; unregFiles.add(e.name); }
          const form = residueFormOf(p.s);
          formCount[`content:${form}`] = (formCount[`content:${form}`] || 0) + n;
        }
      }
    }
    const pass = !residueRegErr && unregOccurrences === 0;
    const formText = Object.entries(formCount).map(([k, v]) => `${k}=${v}`).join('、') || '（无）';
    const regNote = residueRegErr
      ? `★ 残留登记册缺失/不可解析（${RESIDUE_REG_FILE}）：${residueRegErr} —— fail-closed，直接判红`
      : `已登记 ${regOccurrences} 处 / ${regFiles.size} 文件（前缀：${regPrefixes.join('、') || '（无）'}；见 ${residueReg.seeAlso || '05-已知未覆盖项'}）`;
    add('12', 'zip 内无**未登记**绝对主机路径残留（构建机用户目录/工作根/干净房；变形集匹配）', pass,
      `★ 未登记 ${unregOccurrences} 处 / ${unregFiles.size} 文件｜${regNote}｜条目名命中 ${nameOccurrences} 处 / ${nameHitFiles.size} 文件｜内容命中 ${contentOccurrences} 处 / ${contentHitFiles.size} 文件｜形态 ${formText}｜词表 名称 ${RESIDUE_NAME.length} 词→${namePatterns.length} 变形 / 内容 ${RESIDUE_CONTENT.length} 词→${contentPatterns.length} 变形（原始/JSON 转义/正斜杠/URL/8.3 短名）｜自查件跳过 ${selfSkipped}`,
      {
        registeredOccurrences: regOccurrences,
        registeredFiles: regFiles.size,
        unregisteredOccurrences: unregOccurrences,
        unregisteredFiles: unregFiles.size,
        unregisteredSample: [...unregFiles].slice(0, 10),
        sample: [...nameHits.slice(0, 6), ...contentHits.slice(0, 6)],
        selfSkipped,
        registration: residueRegErr ? { error: residueRegErr } : { prefixes: regPrefixes, seeAlso: residueReg.seeAlso || '' },
      });
  }

  // 13 终包 sha256
  {
    const actualSha = sha256File(ZIP);
    const bytes = fs.statSync(ZIP).size;
    const shaMatch = EXPECT_RAW ? actualSha === EXPECT_RAW : null;
    const pass = EXPECT_RAW ? shaMatch && bytes === zip.bytes : !FINAL;
    const detail = EXPECT_RAW
      ? `现场 sha256=${actualSha}｜--expect-sha=${EXPECT_RAW}｜${shaMatch ? '一致' : `不一致（实际 ${actualSha}）`}｜字节 ${bytes} / 条目 ${zipFiles.length}`
      : `未提供 --expect-sha（候选模式：仅记录现场值 sha256=${actualSha}；终包模式请加 --final --expect-sha=<发布锚里的值>）`;
    add('13', '终包 sha256 与 --expect-sha 一致（现场 re-hash）', pass, detail,
      { sha256: actualSha, expectSha256: EXPECT_RAW || null, shaMatch, bytes, entries: zipFiles.length });
  }

  const passCount = rows.filter((r) => r.pass).length;
  const ok = passCount === rows.length;
  const result = {
    schema: SCHEMA,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    at: new Date().toISOString(),
    finalMode: FINAL && ok,
    requestedFinal: FINAL,
    target: {
      zip: ZIP,
      zipName: path.basename(ZIP),
      bytes: zip.bytes,
      entries: zipFiles.length,
      sha256: rows[12].sha256,
      expectSha256: EXPECT_RAW || null,
      shaMatch: rows[12].shaMatch,
    },
    root: { deliveryRoot: ROOT, pkg: PKG, innerDir: INNER_DIR_NAME, zipPrefix: prefix },
    scope: { excluded: SCOPE, excludedFiles: excludedFiles.length, note: '外层 MANIFEST 显式排除面；这些文件在 zip 内但不入清单（接收端写 04-结果 不会造成 changed）' },
    manifests: {
      inner: { path: innerMfPath, lines: innerMf.declared.size, sha256: innerMf.sha256 },
      outer: { path: outerMfPath, lines: outerMf.declared.size, sha256: outerMf.sha256 },
    },
    rows,
    total: rows.length,
    pass: passCount,
    all: rows.length,
    ok,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      osTmpdir: os.tmpdir(),
      argv: process.argv.slice(2),
      elapsedMs: Date.now() - t0,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[收尾校验] 目标 zip：${result.target.zipName}`);
    console.log(`[收尾校验] 交付根：${ROOT}｜插件包：${PKG}｜zip 前缀：${prefix || '（无）'}｜排除面：${SCOPE.join(',') || '（无）'}`);
    console.log(`[收尾校验] 现场 sha256=${result.target.sha256}｜字节 ${result.target.bytes}｜条目 ${result.target.entries}｜finalMode=${result.finalMode}`);
    for (const r of rows) {
      console.log(`  ${r.id} ${r.pass ? '[PASS]' : '[FAIL]'} ${r.title}｜${r.detail}`);
    }
    console.log(`[收尾校验] ${passCount}/${rows.length} ${ok ? 'PASS' : 'FAIL'} → ${OUT}`);
  }
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`[收尾校验] 致命错误：${err && err.stack ? err.stack : err}`);
  process.exit(2);
}
