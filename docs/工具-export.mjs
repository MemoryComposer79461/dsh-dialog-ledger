#!/usr/bin/env node
/**
 * @file docs/工具-export.mjs
 * @role 交付包出包器（随包、零依赖；四段式：manifests → zip → anchors → verify）。
 *
 * @why 审计 re3（出包流程方案 §2.1/§2.4/§4.4）：旧版只导出 `01-插件包`（730 文件），默认写 `%TEMP%`，
 *      **先写 zip 后校验**、不写锚、不分内外两层清单、没有"终包"概念；re3 真正的出包链在开发机
 *      `_工作\tools\`（export.mjs / 异机检测包.mjs / 收尾校验-异机包.mjs），不随包，于是终包 Z2
 *      从未过门、终包 sha256 `c5dab0b7…` 在包内 0 命中。本文件把出包改成**四段可独立复跑**的流程，
 *      每段只做一件事，失败即停：
 *
 *        --mode=manifests  证据回填后**只重算一次内层清单，再算外层清单**（外层显式排除 04-结果）；
 *        --mode=zip        只出一次终包 zip（确定性 store、固定时间戳、UTF-8 bit11、顶层目录前缀），
 *                          出完立刻算 sha256，**不把 sha256 写进 zip**（自指不可能）；
 *        --mode=extract    用 node 内建解压 zip 到全新空目录（出包门 PowerShell Expand-Archive 失败时的备份解压器）；
 *        --mode=anchors    对**终包**跑完 13 项之后：把 `发布锚.txt` + `收尾校验-final.json` 写到交付根（或 out），
 *                          再算一次外层清单（此时外层多这两个文件），**不再重打 zip**；
 *        --mode=verify     终包复检（--verify-final 同义）：只读，验锚、两层清单、zip↔交付根关系、H 不在 zip 内。
 *
 * @invariant
 *   1. zip 内是"无锚版本"：出 zip 时交付根里没有 发布锚.txt / 收尾校验-final.json；锚写在 zip 之外。
 *   2. 锚文件写入后只重算外层清单；内层清单整条链只重算一次（anchors 段验证其 sha 未变）。
 *   3. 终包 zip 只出一次；anchors/verify 段只读 zip + 重新 sha256，绝不重打。
 *   4. `--final-sha=<hex>` 可回填/断言：任何模式下都给定时，实际 zip sha256 必须与它一致，否则停。
 *   5. `--dry-run` 只打印计划，不写任何文件。
 *
 * zip sha256 与清单的关系（也写进 发布锚.txt）：
 *   H = sha256(zip 文件字节)。zip 内含锚前内层清单 I0 与锚前外层清单 O0，所以 H 直接绑定 I0/O0
 *   的字节与文件集合；但 H 不是任何清单的 sha，也不可能写进 zip（写回即改变 zip → 自指）。
 *   锚后交付根外层清单 O1 = O0 的声明集合 + `发布锚.txt` + `收尾校验-final.json` 两行；
 *   因此 交付根(O1) ≠ zip 内(O0) 是**设计结果**：zip 是"无锚版本"，锚在 zip 之外。
 *
 * 用法：
 *   node docs\工具-export.mjs --root=<交付根> --out=<交付目录> --mode=<manifests|zip|extract|anchors|verify>
 *        [--final-sha=<64hex>] [--final-json=<13项结果.json>] [--anchor-scope=root|out] [--zip=<zip>]
 *        [--extract=<dir>] [--zip-name=<name>] [--date=YYYYMMDD] [--prefix=<顶层目录名>] [--run-id=<id>]
 *        [--scope-exclude=04-结果] [--force] [--dry-run] [--json] [--json-out=<file>] [--help]
 *     --root=<dir>        交付根（含 00-怎么用.md / 01-插件包 / 02-语料 / 03-自检工具 / 04-结果 / 回滚 / MANIFEST.sha256）
 *     --out=<dir>         zip 与包外 JSON 的输出目录（**不能在 --root 内**；终包 zip 落这里）
 *     --mode=...          见上；默认 manifests（不写 zip，最安全）
 *     --final-sha=<hex>   期望终包 sha256；zip 段断言实际值，anchors 段回填/断言，verify 段断言
 *     --final-json=<file> 收尾校验（--final）产出的 13 项 JSON；anchors 段必填并校验其对象就是本 zip
 *     --anchor-scope=root 锚文件写交付根（默认，外层会多这两行）；out=写到 --out（交付根不动）
 *     --zip-name=<name>   覆盖 zip 名；默认 `异机检测包-lite-v<version>-<YYYYMMDD>.zip`
 *     --date=<YYYYMMDD>   覆盖 zip 名里的日期（自测/复现）
 *     --prefix=<name>     zip 内顶层目录名；默认 = zip 名去掉 .zip
 *     --run-id=<id>       写进锚与 JSON 的本次 run 标识（默认取日期时间）
 *     --scope-exclude=a,b 外层清单显式排除面（相对交付根的路径前缀），默认 04-结果
 *     --force             允许删除交付根里旧锚文件 / 覆盖已存在的 zip（终包只出一次，默认拒覆盖）
 *     --dry-run           只打印步骤与命令，不写任何文件
 *     --json / --json-out 机读输出（stdout / 文件）；供 工具-出包门.mjs 分步串接
 *   退出码：0=本段通过；1=校验失败（产物不可发）；2=用法/环境错误。
 *
 * @reads  <root>/**、<root>/01-插件包/VERSION.json、<zip>（zip/extract/anchors/verify）
 * @writes
 *   --mode=manifests: <root>/01-插件包/MANIFEST.sha256、<root>/MANIFEST.sha256
 *   --mode=zip:       <out>/<zipName>
 *   --mode=extract:   <extract>/（要求全新空目录）
 *   --mode=anchors:   <root 或 out>/发布锚.txt、<root 或 out>/收尾校验-final.json、重算 <root>/MANIFEST.sha256
 *   --mode=verify:    只写 --json-out（若给）
 * @depends node:fs/path/crypto/zlib/os/url（零第三方依赖；zip 为确定性 store 模式，读 zip 支持 store/deflate）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const TOOL = '工具-export';
const SCHEMA = 'delivery-export/2';
const TOOL_VERSION = '2.0.0';
const MANIFEST_NAME = 'MANIFEST.sha256';
const ANCHOR_NAME = '发布锚.txt';
const FINAL_JSON_NAME = '收尾校验-final.json';

function usage(msg) {
  if (msg) console.error(`[用法错误] ${msg}`);
  console.error('用法: node docs\\工具-export.mjs --root=<交付根> --out=<交付目录> --mode=<manifests|zip|extract|anchors|verify> [--final-sha=<hex>] [--final-json=<file>] [--dry-run] [--json-out=<file>]');
  console.error('      node docs\\工具-export.mjs --help   （查看文件头完整说明）');
  process.exit(2);
}
function fail(code, msg) {
  console.error(`[导出] ${msg}`);
  process.exit(code);
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
const ALLOWED = ['root', 'out', 'mode', 'zip', 'extract', 'final-sha', 'final-json', 'anchor-scope', 'zip-name', 'date', 'prefix', 'run-id', 'scope-exclude', 'force', 'dry-run', 'json', 'json-out', 'exclude', 'skip-verify', 'help'];
for (const a of argv) {
  if (!a.startsWith('--')) usage(`不认识的裸参数：${a}`);
  const k = a.slice(2).split('=')[0];
  if (!ALLOWED.includes(k) && k !== 'h') usage(`不认识的参数 --${k}`);
}

const normRel = (s) => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const splitList = (s) => (s || '').split(',').map((x) => normRel(x.trim())).filter(Boolean);
const absOf = (rootAbs, rel) => path.join(rootAbs, rel.split('/').join(path.sep));

const MODE = (argOf('mode') || (hasFlag('verify-final') ? 'verify' : 'manifests')).toLowerCase();
const VALID_MODES = ['manifests', 'zip', 'extract', 'anchors', 'verify'];
if (!VALID_MODES.includes(MODE)) usage(`--mode 只能是 ${VALID_MODES.join('|')}`);
const ROOT = path.resolve(argOf('root') || path.resolve(path.dirname(THIS_FILE), '..', '..'));
const PKG = path.join(ROOT, '01-插件包');
const OUT = path.resolve(argOf('out') || '');
const EXTRACT = path.resolve(argOf('extract') || '');
const SCOPE = splitList(argOf('scope-exclude') || '04-结果');
const DRY_RUN = hasFlag('dry-run');
const FORCE = hasFlag('force');
const AS_JSON = hasFlag('json');
const JSON_OUT = argOf('json-out') ? path.resolve(argOf('json-out')) : '';
const ZIP_OVERRIDE = argOf('zip') ? path.resolve(argOf('zip')) : '';
const FINAL_SHA = (argOf('final-sha') || '').trim().toLowerCase();
const RUN_ID = argOf('run-id') || '';
const FINAL_JSON_ARG = argOf('final-json') ? path.resolve(argOf('final-json')) : '';
const ANCHOR_SCOPE = (argOf('anchor-scope') || 'root').toLowerCase();
if (!['root', 'out'].includes(ANCHOR_SCOPE)) usage('--anchor-scope 只能是 root|out');
if (FINAL_SHA && !/^[0-9a-f]{64}$/.test(FINAL_SHA)) usage('--final-sha 必须是 64 位小写 hex');
if (argOf('date') && !/^\d{8}$/.test(argOf('date'))) usage('--date 必须是 YYYYMMDD');
if (argOf('exclude')) console.error('[导出] 注意：re3 旧参数 --exclude 已废弃（运行产物必须写在交付根之外，否则 13 项 10 会红），本次忽略。');
if (hasFlag('skip-verify')) console.error('[导出] 注意：re3 旧参数 --skip-verify 已废弃（zip 段不再自带校验，校验归 --mode=verify / 收尾校验），本次忽略。');

// ---------------------------------------------------------------------------
// 一、基础
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
function walkRel(rootAbs) {
  const out = [];
  const walk = (dir, base) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === '.git') continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(rootAbs, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}
const isUnder = (rel, prefixes) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function readVersion() {
  const vPath = path.join(PKG, 'VERSION.json');
  if (!fs.existsSync(vPath)) fail(2, `缺 ${vPath}：--root 应指向交付根（其下有 01-插件包/VERSION.json）`);
  let version = '';
  try {
    version = String(JSON.parse(fs.readFileSync(vPath, 'utf8')).version || '');
  } catch (err) {
    fail(2, `读 VERSION.json 失败：${err.message}`);
  }
  if (!version) fail(2, `${vPath} 缺 version 字段`);
  return version;
}
function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function runIdDefault() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function zipNameDefault(version) {
  const vv = /^v/i.test(version) ? version : `v${version}`;
  return argOf('zip-name') || `异机检测包-lite-${vv}-${argOf('date') || todayStamp()}.zip`;
}

// ---------------------------------------------------------------------------
// 二、manifest 生成 / 校验（口径与 docs/工具-manifest.mjs 一致：码元序、LF、排除清单自身与任意 .git）
// ---------------------------------------------------------------------------
function manifestFiles(rootAbs, excludes) {
  return walkRel(rootAbs).filter((rel) => rel !== MANIFEST_NAME && !isUnder(rel, excludes));
}
function buildManifestText(rootAbs, excludes) {
  const files = manifestFiles(rootAbs, excludes);
  const lines = files.map((rel) => `${sha256File(absOf(rootAbs, rel))}  ${rel}`);
  return { text: `${lines.join('\n')}${lines.length ? '\n' : ''}`, files };
}
function parseManifestText(text) {
  const declared = new Map();
  const badLines = [];
  const dups = [];
  const seq = [];
  const rawLines = text.split('\n');
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { badLines.push({ line: i + 1, text: line.slice(0, 160) }); continue; }
    if (declared.has(m[2])) dups.push(m[2]);
    declared.set(m[2], m[1]);
    seq.push(m[2]);
  }
  const sorted = [...seq].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { declared, badLines, dups, orderOk: seq.every((v, i) => v === sorted[i]), lines: declared.size };
}
function verifyManifest(rootAbs, manifestAbs, excludes) {
  if (!fs.existsSync(manifestAbs)) return { ok: false, error: `缺清单 ${manifestAbs}`, declared: 0, actual: 0, missing: [], extra: [], changed: [], badLines: [] };
  const parsed = parseManifestText(fs.readFileSync(manifestAbs, 'utf8'));
  const files = manifestFiles(rootAbs, excludes);
  const actual = new Map();
  for (const rel of files) actual.set(rel, sha256File(absOf(rootAbs, rel)));
  const missing = [];
  const changed = [];
  for (const [rel, want] of parsed.declared) {
    if (!actual.has(rel)) { missing.push(rel); continue; }
    if (actual.get(rel) !== want) changed.push(rel);
  }
  const extra = [...actual.keys()].filter((rel) => !parsed.declared.has(rel));
  const ok = parsed.badLines.length === 0 && parsed.dups.length === 0 && parsed.orderOk
    && missing.length === 0 && extra.length === 0 && changed.length === 0;
  return { ok, declared: parsed.lines, actual: actual.size, missing, extra, changed, badLines: parsed.badLines, orderOk: parsed.orderOk };
}

// ---------------------------------------------------------------------------
// 三、确定性 ZIP（store；固定 1980-01-01；UTF-8 bit11；顶层目录前缀；码元序）
// ---------------------------------------------------------------------------
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
const DOS_TIME = 0;
const DOS_DATE = 0x21;
function buildZip(rootAbs, relFiles, prefix) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const rel of relFiles) {
    const data = fs.readFileSync(absOf(rootAbs, rel));
    const name = Buffer.from(`${prefix}/${rel}`, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(relFiles.length, 8);
  eocd.writeUInt16LE(relFiles.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cdBuf, eocd]);
}

/** 只读解析 zip（中央目录权威；支持 store/deflate；逐条 CRC32）。 */
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
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('不支持 ZIP64');
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
    const entry = { name, flags, method, crc, compSize, rawSize, isDir: name.endsWith('/'), sha256: null, data: null };
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
      if (crc32(data) !== crc) throw new Error('CRC32 不符');
      entry.sha256 = sha256Buf(data);
      entry.data = data;
    } catch (err) {
      bad.push({ name, reason: err.message });
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, bad, bytes: fileBuf.length, fileSha256: sha256Buf(fileBuf), count };
}
function detectPrefix(entryNames, rootAbs, explicit) {
  if (explicit) {
    const ok = entryNames.every((n) => n === explicit || n.startsWith(`${explicit}/`));
    if (!ok) throw new Error(`--prefix=${explicit} 与 zip 条目名不符`);
    return explicit;
  }
  if (!entryNames.length) return '';
  const seg = entryNames[0].split('/')[0];
  if (!seg || entryNames.some((n) => !n.startsWith(`${seg}/`))) return '';
  if (fs.existsSync(path.join(rootAbs, seg))) return '';
  return seg;
}

// ---------------------------------------------------------------------------
// 四、输出
// ---------------------------------------------------------------------------
function emit(result, code) {
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[导出] mode=${result.mode}${result.dryRun ? '（dry-run，未写文件）' : ''}`);
    for (const s of result.steps || []) console.log(`  ${s.pass === false ? '[FAIL]' : s.pass === true ? '[PASS]' : '[INFO]'} ${s.step}｜${s.detail}`);
    if (result.relation) console.log(`[导出] zip sha256 关系：${result.relation}`);
    if (result.anchor) console.log(`[导出] 发布锚：${result.anchor.line}`);
    if (result.zip) console.log(`[导出] zip：${result.zip.path}｜字节 ${result.zip.bytes}｜条目 ${result.zip.entries}｜sha256 ${result.zip.sha256}`);
    if (result.jsonOut) console.log(`[导出] 机读 JSON：${JSON_OUT}`);
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 五、模式：manifests
// ---------------------------------------------------------------------------
function modeManifests() {
  const steps = [];
  const innerMfAbs = path.join(PKG, MANIFEST_NAME);
  const outerMfAbs = path.join(ROOT, MANIFEST_NAME);
  const anchors = [path.join(ROOT, ANCHOR_NAME), path.join(ROOT, FINAL_JSON_NAME)];
  const present = anchors.filter((f) => fs.existsSync(f));
  if (present.length && !FORCE) {
    fail(2, `交付根已有锚文件：${present.join('、')}；终包锚后的树不能重算为"无锚版本"。确认要重出包请加 --force（会先删除旧锚，再重算清单/重出 zip）。`);
  }
  if (!fs.existsSync(PKG) || !fs.statSync(PKG).isDirectory()) fail(2, `交付根下找不到 01-插件包：${PKG}`);
  if (!DRY_RUN && present.length) {
    for (const f of present) fs.unlinkSync(f);
    steps.push({ step: '清理旧锚', pass: true, detail: `已删除 ${present.length} 个旧锚文件（--force）` });
  } else if (present.length) {
    steps.push({ step: '清理旧锚', pass: null, detail: `将删除 ${present.length} 个旧锚文件（--force）` });
  }

  if (DRY_RUN) {
    steps.push({ step: '重算内层清单', pass: null, detail: `将写 ${innerMfAbs}（相对 01-插件包；码元序、LF、排除自身）` });
    steps.push({ step: '重算外层清单', pass: null, detail: `将写 ${outerMfAbs}（相对交付根；排除自身与 ${SCOPE.join(',') || '（无）'}）` });
    return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'manifests', dryRun: true, at: new Date().toISOString(), root: ROOT, pkg: PKG, scopeExcluded: SCOPE, steps, runtime: buildRuntime() }, 0);
  }

  // 内层：本次唯一一次
  const inner = buildManifestText(PKG, []);
  fs.writeFileSync(innerMfAbs, inner.text, 'utf8');
  const innerV = verifyManifest(PKG, innerMfAbs, []);
  steps.push({ step: '重算内层清单', pass: innerV.ok, detail: `${innerMfAbs}｜文件 ${inner.files.length} 行｜sha256 ${sha256File(innerMfAbs)}｜复算 声明 ${innerV.declared}/实际 ${innerV.actual}/缺 ${innerV.missing.length}/多 ${innerV.extra.length}/改 ${innerV.changed.length}` });
  if (!innerV.ok) return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'manifests', at: new Date().toISOString(), root: ROOT, pkg: PKG, steps, verify: { inner: innerV }, runtime: buildRuntime() }, 1);

  // 外层：先于 zip 的"锚前版本" O0
  const outer = buildManifestText(ROOT, SCOPE);
  fs.writeFileSync(outerMfAbs, outer.text, 'utf8');
  const outerV = verifyManifest(ROOT, outerMfAbs, SCOPE);
  const covered = [...parseManifestText(outer.text).declared.keys()].filter((r) => isUnder(r, SCOPE));
  steps.push({ step: '重算外层清单', pass: outerV.ok && covered.length === 0, detail: `${outerMfAbs}｜文件 ${outer.files.length} 行（排除 ${SCOPE.join(',')}）｜sha256 ${sha256File(outerMfAbs)}｜复算 声明 ${outerV.declared}/实际 ${outerV.actual}/缺 ${outerV.missing.length}/多 ${outerV.extra.length}/改 ${outerV.changed.length}｜排除面被覆盖 ${covered.length}` });
  const ok = innerV.ok && outerV.ok && covered.length === 0;
  return emit({
    schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'manifests', at: new Date().toISOString(),
    root: ROOT, pkg: PKG, scopeExcluded: SCOPE, anchorsAbsent: true, steps,
    manifests: {
      inner: { path: innerMfAbs, lines: innerV.declared, sha256: sha256File(innerMfAbs) },
      outer: { path: outerMfAbs, lines: outerV.declared, sha256: sha256File(outerMfAbs) },
    },
    runtime: buildRuntime(),
  }, ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 六、模式：zip
// ---------------------------------------------------------------------------
function modeZip() {
  const steps = [];
  if (!OUT) usage('--mode=zip 需要 --out=<交付目录>');
  if (isInside(ROOT, OUT) || path.resolve(OUT) === path.resolve(ROOT)) fail(2, `--out 不能在 --root 内：${OUT}`);
  if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) fail(2, `--root 不是目录：${ROOT}`);
  for (const f of [path.join(ROOT, ANCHOR_NAME), path.join(ROOT, FINAL_JSON_NAME)]) {
    if (fs.existsSync(f)) fail(2, `交付根存在锚文件 ${f}：zip 必须是"无锚版本"。先 --mode=manifests --force 重算。`);
  }
  const version = readVersion();
  const zipName = zipNameDefault(version);
  const prefix = normRel(argOf('prefix') || zipName.replace(/\.zip$/i, ''));
  const zipPath = path.join(OUT, zipName);
  if (fs.existsSync(zipPath) && !FORCE) fail(2, `终包 zip 已存在：${zipPath}（终包只出一次；确需覆盖加 --force，并重跑 13 项）`);

  // 前置：清单必须已定格且 0 差异
  const innerV = verifyManifest(PKG, path.join(PKG, MANIFEST_NAME), []);
  const outerV = verifyManifest(ROOT, path.join(ROOT, MANIFEST_NAME), SCOPE);
  steps.push({ step: '前置：内层清单复算', pass: innerV.ok, detail: `声明 ${innerV.declared}/实际 ${innerV.actual}/缺 ${innerV.missing.length}/多 ${innerV.extra.length}/改 ${innerV.changed.length}` });
  steps.push({ step: '前置：外层清单复算', pass: outerV.ok, detail: `声明 ${outerV.declared}/实际 ${outerV.actual}/缺 ${outerV.missing.length}/多 ${outerV.extra.length}/改 ${outerV.changed.length}（排除 ${SCOPE.join(',')}）` });
  if (!innerV.ok || !outerV.ok) {
    steps.push({ step: '出包中止', pass: false, detail: '清单未定格：先 node docs\\工具-export.mjs --mode=manifests' });
    return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'zip', at: new Date().toISOString(), root: ROOT, pkg: PKG, steps, runtime: buildRuntime() }, 1);
  }

  const files = walkRel(ROOT);
  if (!files.includes(MANIFEST_NAME) || !files.includes(`01-插件包/${MANIFEST_NAME}`)) fail(2, '交付根缺外层或内层 MANIFEST.sha256');
  steps.push({ step: '枚举交付根文件', pass: true, detail: `${files.length} 文件（含内层/外层 MANIFEST；跳过任意层级 .git）；zip 前缀 "${prefix}"` });

  if (DRY_RUN) {
    steps.push({ step: '构建 zip', pass: null, detail: `将写 ${zipPath}（store、1980-01-01、UTF-8 bit11、确定性）` });
    steps.push({ step: '计算 sha256', pass: null, detail: '出 zip 后算 H = sha256(zip 字节)；H 不写进 zip' });
    return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'zip', dryRun: true, at: new Date().toISOString(), root: ROOT, pkg: PKG, zipName, prefix, files: files.length, scopeExcluded: SCOPE, steps, runtime: buildRuntime() }, 0);
  }

  // 确定性：连打两次，字节必须相同（否则说明树在打包过程中被改）
  const buf1 = buildZip(ROOT, files, prefix);
  const buf2 = buildZip(ROOT, files, prefix);
  const deterministic = buf1.equals(buf2);
  steps.push({ step: '确定性构建', pass: deterministic, detail: deterministic ? `两次构建字节相同（${buf1.length} B）` : '两次构建字节不同：交付树在打包过程中被修改' });
  if (!deterministic) return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'zip', at: new Date().toISOString(), root: ROOT, pkg: PKG, steps, runtime: buildRuntime() }, 1);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(zipPath, buf1);
  const zipSha = sha256Buf(buf1);
  if (FINAL_SHA && zipSha !== FINAL_SHA) {
    steps.push({ step: '--final-sha 断言', pass: false, detail: `实际 ${zipSha} ≠ --final-sha ${FINAL_SHA}` });
    return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'zip', at: new Date().toISOString(), root: ROOT, pkg: PKG, zip: { path: zipPath, name: zipName, bytes: buf1.length, entries: files.length, sha256: zipSha }, steps, runtime: buildRuntime() }, 1);
  }
  const back = parseZip(zipPath);
  const filesOnly = back.entries.filter((e) => !e.isDir);
  const roundTrip = back.fileSha256 === zipSha && filesOnly.length === files.length && back.bad.length === 0;
  steps.push({ step: '回读 zip', pass: roundTrip, detail: `条目 ${filesOnly.length}/${files.length}｜CRC 坏 ${back.bad.length}｜文件 sha256 ${back.fileSha256 === zipSha ? '一致' : '不一致'}` });

  const relation = 'H=sha256(zip 字节)；zip 内含内层清单 I0 与外层清单 O0（H 绑定二者字节）；H 不是任何清单的 sha，也不写进 zip（自指不可能）；锚由 --mode=anchors 写到 zip 之外。';
  return emit({
    schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'zip', at: new Date().toISOString(),
    root: ROOT, pkg: PKG, version,
    zip: { path: zipPath, name: zipName, prefix, bytes: buf1.length, entries: filesOnly.length, sha256: zipSha },
    files: files.length, scopeExcluded: SCOPE, deterministic, anchorsAbsent: true,
    manifests: { inner: { sha256: sha256File(path.join(PKG, MANIFEST_NAME)), lines: innerV.declared }, outer: { sha256: sha256File(path.join(ROOT, MANIFEST_NAME)), lines: outerV.declared } },
    relation, steps, runtime: buildRuntime(),
  }, roundTrip ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 七、模式：extract（node 内建解压，仅作 Expand-Archive 的备份解压器）
// ---------------------------------------------------------------------------
function modeExtract() {
  if (!EXTRACT) usage('--mode=extract 需要 --extract=<全新空目录>');
  const zipPath = ZIP_OVERRIDE || path.join(OUT || ROOT, zipNameDefault(readVersion()));
  if (!fs.existsSync(zipPath)) fail(2, `缺 zip：${zipPath}（用 --zip= 指定）`);
  const parsed = parseZip(zipPath);
  if (parsed.bad.length) fail(1, `zip 有坏条目 ${parsed.bad.length}：${parsed.bad.slice(0, 3).map((b) => `${b.name}：${b.reason}`).join('；')}`);
  const files = parsed.entries.filter((e) => !e.isDir);
  if (fs.existsSync(EXTRACT) && fs.readdirSync(EXTRACT).length > 0) fail(2, `解压目录必须全新空目录：${EXTRACT}`);
  if (DRY_RUN) return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'extract', dryRun: true, at: new Date().toISOString(), zip: { path: zipPath, entries: files.length }, extractDir: EXTRACT, steps: [{ step: '解压', pass: null, detail: `将解压 ${files.length} 条目到 ${EXTRACT}` }], runtime: buildRuntime() }, 0);
  const extractAbs = path.resolve(EXTRACT);
  let written = 0;
  for (const e of files) {
    const clean = normRel(e.name);
    const segs = clean.split('/');
    if (!clean || segs.some((s) => s === '..' || s === '.' || s === '')) fail(1, `zip 条目名不安全：${e.name}`);
    if (e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name) || e.name.includes('\\')) fail(1, `zip 条目名不安全：${e.name}`);
    const target = path.resolve(extractAbs, clean.split('/').join(path.sep));
    if (target !== extractAbs && !target.startsWith(`${extractAbs}${path.sep}`)) fail(1, `zip 条目越界：${e.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    written += 1;
  }
  const tree = walkRel(extractAbs);
  const ok = written === files.length && tree.length === files.length;
  return emit({
    schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'extract', at: new Date().toISOString(),
    zip: { path: zipPath, entries: files.length }, extractDir: EXTRACT, extractor: 'node',
    written, treeFiles: tree.length,
    steps: [{ step: '解压（node 内建）', pass: ok, detail: `条目 ${files.length}｜落盘 ${written}｜树文件 ${tree.length}` }],
    runtime: buildRuntime(),
  }, ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 八、模式：anchors（写锚 + 只重算一次外层清单；不再重打 zip）
// ---------------------------------------------------------------------------
function modeAnchors() {
  const steps = [];
  if (!OUT) usage('--mode=anchors 需要 --out=<交付目录>');
  const version = readVersion();
  const zipPath = ZIP_OVERRIDE || path.join(OUT, zipNameDefault(version));
  if (!fs.existsSync(zipPath)) fail(2, `缺终包 zip：${zipPath}（用 --zip= 指定）`);
  if (!FINAL_JSON_ARG || !fs.existsSync(FINAL_JSON_ARG)) fail(2, '--mode=anchors 需要 --final-json=<收尾校验 --final 产出的 13 项 JSON>');

  const H = sha256File(zipPath);
  const zipBytes = fs.statSync(zipPath).size;
  if (FINAL_SHA && H !== FINAL_SHA) fail(1, `实际 zip sha256 ${H} ≠ --final-sha ${FINAL_SHA}（回填值不符，停）`);
  const parsed = parseZip(zipPath);
  const zipFiles = parsed.entries.filter((e) => !e.isDir);
  const prefix = detectPrefix(zipFiles.map((e) => e.name), ROOT, normRel(argOf('prefix') || ''));
  const stripPrefix = (name) => (prefix && (name === prefix || name.startsWith(`${prefix}/`)) ? name.slice(prefix.length + 1) : name);
  const relEntries = new Map(zipFiles.map((e) => [stripPrefix(e.name), e]));
  const zipSet = new Set(relEntries.keys());
  if (zipSet.has(ANCHOR_NAME) || zipSet.has(FINAL_JSON_NAME)) fail(1, `zip 内已含锚文件（${ANCHOR_NAME} / ${FINAL_JSON_NAME}）：zip 必须是"无锚版本"`);
  for (const f of [path.join(ROOT, ANCHOR_NAME), path.join(ROOT, FINAL_JSON_NAME)]) {
    if (fs.existsSync(f) && ANCHOR_SCOPE === 'root' && !FORCE) fail(2, `交付根已存在 ${f}；重锚请加 --force（会先删除旧锚）`);
  }

  // 13 项终版 JSON 必须就是对本 zip 跑的
  let finalJson = null;
  try { finalJson = JSON.parse(fs.readFileSync(FINAL_JSON_ARG, 'utf8')); } catch (err) { fail(1, `读 --final-json 失败：${err.message}`); }
  const rowOk = Array.isArray(finalJson.rows) && finalJson.rows.length === 13 && finalJson.rows.every((r) => r.pass === true);
  const jsonIssues = [];
  if (!String(finalJson.schema || '').startsWith('delivery-final-check/')) jsonIssues.push(`schema=${finalJson.schema}`);
  if (finalJson.ok !== true) jsonIssues.push('ok!=true');
  if (finalJson.finalMode !== true) jsonIssues.push('finalMode!=true');
  if (!rowOk) jsonIssues.push(`13 行未全过（${finalJson.rows ? finalJson.rows.filter((r) => r.pass !== true).map((r) => r.id).join(',') : '无 rows'}）`);
  if (!finalJson.target || finalJson.target.sha256 !== H) jsonIssues.push(`target.sha256≠实际 zip（${finalJson.target ? finalJson.target.sha256 : '无 target'}）`);
  if (finalJson.target && finalJson.target.bytes !== zipBytes) jsonIssues.push('target.bytes≠实际');
  if (finalJson.target && finalJson.target.entries !== zipFiles.length) jsonIssues.push('target.entries≠实际');
  steps.push({ step: '校验 13 项终版 JSON', pass: jsonIssues.length === 0, detail: jsonIssues.length ? jsonIssues.join('；') : `schema=${finalJson.schema}｜13/13｜finalMode=true｜target.sha256=${H}` });
  if (jsonIssues.length) return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'anchors', at: new Date().toISOString(), root: ROOT, pkg: PKG, zip: { path: zipPath, sha256: H }, steps, runtime: buildRuntime() }, 1);

  // zip 必须是本交付根的"无锚快照"：zip 内文件 ↔ 交付根文件逐字节一致；清单必须是锚前版本
  const innerMfAbs = path.join(PKG, MANIFEST_NAME);
  const outerMfAbs = path.join(ROOT, MANIFEST_NAME);
  const I0h = sha256File(innerMfAbs);
  const O0h = sha256File(outerMfAbs);
  const innerZip = relEntries.get(`01-插件包/${MANIFEST_NAME}`);
  const outerZip = relEntries.get(MANIFEST_NAME);
  const preIssues = [];
  if (!innerZip || innerZip.sha256 !== I0h) preIssues.push(`zip 内内层清单 ≠ 交付根内层清单（zip=${innerZip ? innerZip.sha256 : '缺'} / root=${I0h}）`);
  if (!outerZip || outerZip.sha256 !== O0h) preIssues.push(`zip 内外层清单 ≠ 交付根外层清单（zip=${outerZip ? outerZip.sha256 : '缺'} / root=${O0h}）：交付根在出 zip 后被改过？`);
  const rootFiles = walkRel(ROOT);
  const rootSet = new Set(rootFiles);
  const missingInZip = rootFiles.filter((f) => !zipSet.has(f));
  const extraInZip = [...zipSet].filter((f) => !rootSet.has(f));
  const diff = [];
  const rootHash = new Map();
  for (const rel of rootFiles) rootHash.set(rel, sha256File(absOf(ROOT, rel)));
  for (const [rel, e] of relEntries) {
    if (!rootHash.has(rel)) continue;
    if (rootHash.get(rel) !== e.sha256) diff.push(rel);
  }
  if (missingInZip.length) preIssues.push(`交付根有 ${missingInZip.length} 文件不在 zip 内（前 5：${missingInZip.slice(0, 5).join('、')}）`);
  if (extraInZip.length) preIssues.push(`zip 有 ${extraInZip.length} 文件不在交付根内（前 5：${extraInZip.slice(0, 5).join('、')}）`);
  if (diff.length) preIssues.push(`zip 与交付根不一致 ${diff.length}（前 5：${diff.slice(0, 5).join('、')}）`);
  steps.push({ step: '校验 zip 是交付根的无锚快照', pass: preIssues.length === 0, detail: preIssues.length ? preIssues.join('；') : `树文件 ${rootFiles.length} = zip 文件 ${zipFiles.length}；逐字节一致；内层清单 ${I0h.slice(0, 16)}… / 外层清单 ${O0h.slice(0, 16)}…` });
  if (preIssues.length) return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'anchors', at: new Date().toISOString(), root: ROOT, pkg: PKG, zip: { path: zipPath, sha256: H }, steps, runtime: buildRuntime() }, 1);

  const runId = RUN_ID || runIdDefault();
  const innerLines = parseManifestText(fs.readFileSync(innerMfAbs, 'utf8')).lines;
  const outerParsed = parseManifestText(fs.readFileSync(outerMfAbs, 'utf8'));
  const checkedAt = new Date().toISOString();
  const coords = ANCHOR_SCOPE === 'root' ? ROOT : OUT;
  const anchorAbs = path.join(coords, ANCHOR_NAME);
  const finalCopyAbs = path.join(coords, FINAL_JSON_NAME);

  // 重要：锚文本不能包含"锚后外层清单 sha256"——该文件会被锚后清单覆盖，写进去即自指。
  // ★ v1.0.0-snap（闸三②）：回滚物**随包**且与发布锚**互绑 sha**。
  //   @why 2026-11-14 审计点名"发布锚与回滚物都没随交付"：接收端拿不到上一版锚，回滚只能靠记忆。
  //   绑定方向（无环）：H=sha256(zip) → zip 内含清单 → 回滚/回滚锚.txt → 怎么回滚.md / 演练-可执行性.mjs。
  //   本块把"回滚物三件的 sha256"显式写进发布锚，接收端不必解包也能先核这三行。
  const rbFiles = {
    anchor: path.join(ROOT, '回滚', '回滚锚.txt'),
    doc: path.join(ROOT, '回滚', '怎么回滚.md'),
    drill: path.join(ROOT, '回滚', '演练-可执行性.mjs'),
  };
  const rbSha = {};
  const rbMissing = [];
  for (const [k, f] of Object.entries(rbFiles)) {
    if (fs.existsSync(f)) rbSha[k] = sha256File(f);
    else { rbSha[k] = '(缺)'; rbMissing.push(path.relative(ROOT, f).replaceAll('\\', '/')); }
  }
  if (rbMissing.length) {
    steps.push({ step: '回滚物随包（闸三②）', pass: false, detail: `缺 ${rbMissing.join('、')} —— 回滚能力不可外发，拒绝出包` });
  } else {
    steps.push({ step: '回滚物随包（闸三②）', pass: true, detail: `回滚锚 ${rbSha.anchor.slice(0, 16)}…／怎么回滚.md ${rbSha.doc.slice(0, 16)}…／演练器 ${rbSha.drill.slice(0, 16)}…` });
  }
  const anchorText = [
    `发布锚（终包）· 会话账本-lite ${/^v/i.test(version) ? version : `v${version}`}`,
    `生成时间：${checkedAt}`,
    `runId=${runId}`,
    `包名：${path.basename(zipPath)}`,
    `发布锚 = ${path.basename(zipPath)} sha256 ${H}`,
    `字节数=${zipBytes} 条目数=${zipFiles.length}`,
    `内层清单 sha256=${I0h} 行数=${innerLines}（01-插件包/${MANIFEST_NAME}，相对 01-插件包）`,
    `外层清单（锚前，zip 内 ${MANIFEST_NAME}）sha256=${O0h} 行数=${outerParsed.lines}（相对交付根，排除 ${SCOPE.join(',') || '（无）'}）`,
    `外层清单（锚后，交付根当前 ${MANIFEST_NAME}）：覆盖 O0 的声明集合 + 本文件 + ${FINAL_JSON_NAME}；其 sha256 只记录在出包器输出 JSON（写进本文件会自指）`,
    `锚文件位置：${coords}（zip 之外；zip 内是"无锚版本"）`,
    '',
    '## zip sha256 与清单的关系',
    '1) H = sha256(zip 文件字节)，不是任何清单的 sha；H 不能写进 zip（写回即改变 zip → 自指），也不能由内层清单推出。',
    '2) zip 内含锚前内层清单 I0 与锚前外层清单 O0；H 直接绑定 I0/O0 的字节与文件集合。',
    `3) I0 只声明 01-插件包/ 下文件（不含 H）；O0 声明交付根除自身与 ${SCOPE.join(',') || '（无）'} 外的文件。`,
    '4) 锚后只重算一次外层清单 O1 = O0 + 本文件 + 收尾校验-final.json 两行；不再重打 zip，故 O1 ≠ O0 是设计结果。',
    '5) 接收端核对顺序：解压 zip → 验 I0/O0（13 项 01/02）→ sha256(zip) 对 H（发布锚/尾校验 JSON）→ 交付根验 O1（若收到交付根）。',
    `13 项终版：${finalCopyAbs}（13/13，finalMode=true）`,
    `复跑：node docs\\工具-收尾校验.mjs --pkg=<解压树>\\01-插件包 --zip=<zip> --out=<包外>.json --expect-sha=${H} --final`,
    '',
    '## 回滚物（随包，互绑 sha；闸三②）',
    `回滚锚           ：回滚/${'回滚锚.txt'} sha256=${rbSha.anchor}`,
    `怎么回滚.md      ：回滚/怎么回滚.md sha256=${rbSha.doc}`,
    `回滚演练器       ：回滚/演练-可执行性.mjs sha256=${rbSha.drill}`,
    '1) 回滚锚记录"上一版包"的 zip H 与内层清单 sha——回滚目标由此可核验（本版回滚目标见回滚锚第一节）。',
    '2) 这三件都在 zip 内、被 O0 清单覆盖；所以 H 成立时，它们同时被锚住（改一个字节，清单即报"改"）。',
    '3) 接收端三样都要拿到：zip + 本文件 + 收尾校验-final.json；缺任一件都无法把包锚定到"被签的那一个"。',
    `4) 回滚演练结论（生成回滚锚时实跑）：见 回滚/回滚锚.txt 第 4 行；复跑：node 回滚\\演练-可执行性.mjs --zip=<上一版zip> --expect-sha=<回滚锚里的sha> --expect-bytes=<字节> --expect-entries=<条目>` ,
    '',
  ].join('\n');

  if (DRY_RUN) {
    steps.push({ step: '写锚 + 重算外层清单', pass: null, detail: `将写 ${anchorAbs}、${finalCopyAbs}，再重算 ${outerMfAbs}（O1 = O0 + 2 行）` });
    return emit({ schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'anchors', dryRun: true, at: checkedAt, root: ROOT, pkg: PKG, zip: { path: zipPath, sha256: H, bytes: zipBytes, entries: zipFiles.length }, anchorScope: ANCHOR_SCOPE, steps, runtime: buildRuntime() }, 0);
  }

  for (const f of [anchorAbs, finalCopyAbs]) if (fs.existsSync(f)) fs.unlinkSync(f);
  fs.writeFileSync(anchorAbs, anchorText, 'utf8');
  fs.writeFileSync(finalCopyAbs, `${JSON.stringify(finalJson, null, 2)}\n`, 'utf8');
  const anchorSha = sha256File(anchorAbs);
  const finalSha = sha256File(finalCopyAbs);
  steps.push({ step: '写锚（zip 之外）', pass: true, detail: `${anchorAbs}（sha256 ${anchorSha.slice(0, 16)}…）｜${finalCopyAbs}（sha256 ${finalSha.slice(0, 16)}…）` });

  // 只重算一次外层清单（锚后），并确认内层清单未变（本次全链内层只算一次）
  const outer2 = buildManifestText(ROOT, SCOPE);
  fs.writeFileSync(outerMfAbs, outer2.text, 'utf8');
  const outer2V = verifyManifest(ROOT, outerMfAbs, SCOPE);
  const O1h = sha256File(outerMfAbs);
  const innerAfter = sha256File(innerMfAbs);
  const covered2 = [...parseManifestText(outer2.text).declared.keys()].filter((r) => isUnder(r, SCOPE));
  const rowsBefore = new Set([...outerParsed.declared.keys()]);
  const rowsAfter = new Set([...parseManifestText(outer2.text).declared.keys()]);
  const added = [...rowsAfter].filter((r) => !rowsBefore.has(r));
  const removed = [...rowsBefore].filter((r) => !rowsAfter.has(r));
  const addedOk = ANCHOR_SCOPE === 'root'
    ? added.length === 2 && added.includes(ANCHOR_NAME) && added.includes(FINAL_JSON_NAME)
    : added.length === 0;
  const reconOk = outer2V.ok && innerAfter === I0h && covered2.length === 0 && addedOk && removed.length === 0;
  steps.push({ step: '外层清单增量核对', pass: addedOk, detail: ANCHOR_SCOPE === 'root' ? `锚后新增行应恰为 ${ANCHOR_NAME}、${FINAL_JSON_NAME}，实际：${added.join('、') || '（无）'}` : '锚在 --out，交付根外层清单不应有新增行' });
  steps.push({ step: '重算外层清单（锚后 O1，本次唯一一次）', pass: reconOk, detail: `文件 ${outer2.files.length} 行｜sha256 ${O1h}｜复算 声明 ${outer2V.declared}/实际 ${outer2V.actual}/缺 ${outer2V.missing.length}/多 ${outer2V.extra.length}/改 ${outer2V.changed.length}｜新增行 ${added.join('、') || '（无）'}｜移除行 ${removed.join('、') || '（无）'}｜排除面被覆盖 ${covered2.length}` });
  steps.push({ step: '内层清单未变（全链只算一次）', pass: innerAfter === I0h, detail: `I0 sha256 ${I0h}` });

  // 不再重打 zip：只 re-hash 一次
  const H2 = sha256File(zipPath);
  const zipBytes2 = fs.statSync(zipPath).size;
  steps.push({ step: 'zip 未变（不重打）', pass: H2 === H && zipBytes2 === zipBytes, detail: `sha256 ${H2 === H ? '一致' : '不一致'}｜字节 ${zipBytes2}` });

  const relation = `H=${H}；zip 内 I0 sha=${I0h}、O0 sha=${O0h}；锚后交付根 O1 sha=${O1h}（= O0 + ${added.join('、') || '无'}）；zip 内不含 H（自指不可能），锚在 zip 之外。`;
  return emit({
    schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'anchors', at: new Date().toISOString(), runId,
    root: ROOT, pkg: PKG, anchorScope: ANCHOR_SCOPE,
    zip: { path: zipPath, name: path.basename(zipPath), bytes: zipBytes, entries: zipFiles.length, sha256: H, sha256AfterWrite: H2 },
    manifests: {
      inner: { path: innerMfAbs, sha256: I0h, lines: innerLines, unchanged: innerAfter === I0h },
      outerPreAnchor: { sha256: O0h, lines: outerParsed.lines },
      outerFinal: { path: outerMfAbs, sha256: O1h, lines: outer2V.declared, added },
    },
    anchors: { [ANCHOR_NAME]: { path: anchorAbs, sha256: anchorSha }, [FINAL_JSON_NAME]: { path: finalCopyAbs, sha256: finalSha } },
    zipAnchorFree: true,
    anchor: { line: `发布锚 = ${path.basename(zipPath)} sha256 ${H}` },
    relation, steps, runtime: buildRuntime(),
  }, reconOk ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 九、模式：verify（只读终包复检）
// ---------------------------------------------------------------------------
function modeVerify() {
  const steps = [];
  const checks = [];
  const addCheck = (name, pass, detail) => { checks.push({ name, pass, detail }); };
  const version = readVersion();
  const zipPath = ZIP_OVERRIDE || path.join(OUT || '', zipNameDefault(version));
  if (!fs.existsSync(zipPath)) fail(2, `缺终包 zip：${zipPath}（用 --zip= 指定）`);

  // 定位锚（交付根优先，其次 out）
  const anchorCandidates = [path.join(ROOT, ANCHOR_NAME), OUT ? path.join(OUT, ANCHOR_NAME) : ''].filter(Boolean);
  const finalCandidates = [path.join(ROOT, FINAL_JSON_NAME), OUT ? path.join(OUT, FINAL_JSON_NAME) : ''].filter(Boolean);
  const anchorPath = anchorCandidates.find((f) => fs.existsSync(f));
  const finalPath = finalCandidates.find((f) => fs.existsSync(f));
  addCheck('发布锚.txt 存在', !!anchorPath, anchorPath || '找不到（交付根与 --out 都没有）');
  addCheck('收尾校验-final.json 存在', !!finalPath, finalPath || '找不到');
  if (!anchorPath || !finalPath) return emitVerify(true, checks);

  const anchorText = fs.readFileSync(anchorPath, 'utf8');
  const mLine = /^发布锚 = (.+?) sha256 ([0-9a-f]{64})$/m.exec(anchorText);
  const mSize = /^字节数=(\d+) 条目数=(\d+)$/m.exec(anchorText);
  const mInner = /^内层清单 sha256=([0-9a-f]{64}) 行数=(\d+)/m.exec(anchorText);
  const mOuter = /^外层清单（锚前，zip 内 MANIFEST\.sha256）sha256=([0-9a-f]{64}) 行数=(\d+)/m.exec(anchorText);
  addCheck('锚格式可解析', !!(mLine && mSize && mInner && mOuter), mLine ? `zipName=${mLine[1]}` : '锚格式不符（旧锚？）');
  if (!(mLine && mSize && mInner && mOuter)) return emitVerify(true, checks);

  const zipNameInAnchor = mLine[1];
  const H = sha256File(zipPath);
  const zipBytes = fs.statSync(zipPath).size;
  const parsed = parseZip(zipPath);
  const zipFiles = parsed.entries.filter((e) => !e.isDir);
  const prefix = detectPrefix(zipFiles.map((e) => e.name), ROOT, normRel(argOf('prefix') || ''));
  const stripPrefix = (name) => (prefix && (name === prefix || name.startsWith(`${prefix}/`)) ? name.slice(prefix.length + 1) : name);
  const relEntries = new Map(zipFiles.map((e) => [stripPrefix(e.name), e]));
  const zipSet = new Set(relEntries.keys());

  addCheck('锚内 zip 名 = 实际 zip 名', zipNameInAnchor === path.basename(zipPath), `${zipNameInAnchor} vs ${path.basename(zipPath)}`);
  addCheck('现场 sha256 = 锚值', H === mLine[2], `实际 ${H} / 锚 ${mLine[2]}`);
  addCheck('字节数/条目数 = 锚值', zipBytes === Number(mSize[1]) && zipFiles.length === Number(mSize[2]), `实际 ${zipBytes}B/${zipFiles.length} 条目；锚 ${mSize[1]}B/${mSize[2]} 条目`);
  if (FINAL_SHA) addCheck('--final-sha 断言', H === FINAL_SHA, `实际 ${H} / --final-sha ${FINAL_SHA}`);

  const finalJson = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
  const rows = Array.isArray(finalJson.rows) ? finalJson.rows : [];
  addCheck('终版 JSON：13/13 且 finalMode=true', finalJson.ok === true && finalJson.finalMode === true && rows.length === 13 && rows.every((r) => r.pass === true), `ok=${finalJson.ok} finalMode=${finalJson.finalMode} rows=${rows.length} 红=${rows.filter((r) => r.pass !== true).map((r) => r.id).join(',') || '无'}`);
  addCheck('终版 JSON target = 本 zip', !!finalJson.target && finalJson.target.sha256 === H && finalJson.target.bytes === zipBytes && finalJson.target.entries === zipFiles.length, finalJson.target ? `sha ${finalJson.target.sha256 === H ? '=' : '≠'}｜bytes ${finalJson.target.bytes}｜entries ${finalJson.target.entries}` : '无 target');

  // zip 自身两层清单自洽
  const innerZip = relEntries.get(`01-插件包/${MANIFEST_NAME}`);
  const outerZip = relEntries.get(MANIFEST_NAME);
  let zipInnerOk = false;
  let zipOuterOk = false;
  let outerZipParsed = null;
  if (innerZip && outerZip) {
    outerZipParsed = parseManifestText(outerZip.data.toString('utf8'));
    const actualOuter = new Map();
    for (const [rel, e] of relEntries) {
      if (rel === MANIFEST_NAME) continue;
      actualOuter.set(rel, e.sha256);
    }
    const missingO = [...outerZipParsed.declared.keys()].filter((r) => !actualOuter.has(r));
    const extraO = [...actualOuter.keys()].filter((r) => !outerZipParsed.declared.has(r) && !isUnder(r, SCOPE));
    const changedO = [...outerZipParsed.declared.keys()].filter((r) => actualOuter.has(r) && actualOuter.get(r) !== outerZipParsed.declared.get(r));
    zipOuterOk = missingO.length === 0 && extraO.length === 0 && changedO.length === 0 && outerZipParsed.lines === Number(mOuter[2]);
    addCheck('zip 内外层清单 O0 自洽 + 行数=锚值', zipOuterOk, `声明 ${outerZipParsed.lines} / 锚行数 ${mOuter[2]}｜缺 ${missingO.length}/多 ${extraO.length}/改 ${changedO.length}`);
    const innerParsed = parseManifestText(innerZip.data.toString('utf8'));
    const innerSet = new Set([...innerParsed.declared.keys()].map((r) => `01-插件包/${r}`));
    const actualInner = [...relEntries.keys()].filter((r) => r.startsWith('01-插件包/') && r !== `01-插件包/${MANIFEST_NAME}`);
    const missI = [...innerSet].filter((r) => !relEntries.has(r));
    const extraI = actualInner.filter((r) => !innerSet.has(r));
    const chgI = [...innerParsed.declared.entries()].filter(([rel, h]) => { const e = relEntries.get(`01-插件包/${rel}`); return e && e.sha256 !== h; });
    zipInnerOk = missI.length === 0 && extraI.length === 0 && chgI.length === 0 && innerZip.sha256 === mInner[1];
    addCheck('zip 内内层清单 I0 自洽 + sha=锚值', zipInnerOk, `声明 ${innerParsed.lines} / 缺 ${missI.length}/多 ${extraI.length}/改 ${chgI.length}｜sha ${innerZip.sha256 === mInner[1] ? '=' : '≠'} 锚值`);
  } else {
    addCheck('zip 内两层清单存在', false, `内层=${innerZip ? '有' : '缺'} 外层=${outerZip ? '有' : '缺'}`);
  }
  if (!outerZipParsed) return emitVerify(false, checks);

  // 交付根自身两层清单
  const innerMfAbs = path.join(PKG, MANIFEST_NAME);
  const outerMfAbs = path.join(ROOT, MANIFEST_NAME);
  const innerV = verifyManifest(PKG, innerMfAbs, []);
  addCheck('交付根内层清单复算 0 差异', innerV.ok, `声明 ${innerV.declared}/实际 ${innerV.actual}/缺 ${innerV.missing.length}/多 ${innerV.extra.length}/改 ${innerV.changed.length}`);
  addCheck('交付根内层清单 sha = 锚值（锚不改内层）', fs.existsSync(innerMfAbs) && sha256File(innerMfAbs) === mInner[1], fs.existsSync(innerMfAbs) ? sha256File(innerMfAbs) : '缺');
  const outerV = verifyManifest(ROOT, outerMfAbs, SCOPE);
  const outerRootParsed = fs.existsSync(outerMfAbs) ? parseManifestText(fs.readFileSync(outerMfAbs, 'utf8')) : null;
  const covered = outerRootParsed ? [...outerRootParsed.declared.keys()].filter((r) => isUnder(r, SCOPE)) : [];
  addCheck('交付根外层清单复算 0 差异 + 排除面 0 行', outerV.ok && covered.length === 0, `声明 ${outerV.declared}/实际 ${outerV.actual}/缺 ${outerV.missing.length}/多 ${outerV.extra.length}/改 ${outerV.changed.length}｜排除面覆盖 ${covered.length}`);

  // 锚在 zip 之外 + 交付根 = zip + 锚 的关系
  const anchorsInRoot = [path.join(ROOT, ANCHOR_NAME)].filter((f) => fs.existsSync(f));
  const anchorScopeRoot = anchorsInRoot.length > 0;
  const anchorFiles = anchorScopeRoot ? [ANCHOR_NAME, FINAL_JSON_NAME] : [];
  addCheck('zip 内不含锚文件', !zipSet.has(ANCHOR_NAME) && !zipSet.has(FINAL_JSON_NAME), zipSet.has(ANCHOR_NAME) || zipSet.has(FINAL_JSON_NAME) ? 'zip 内出现锚文件' : '无');
  const hInZip = [];
  const hBuf = Buffer.from(H, 'utf8');
  for (const e of zipFiles) if (e.data && e.data.indexOf(hBuf) >= 0) hInZip.push(e.name);
  addCheck('zip 内不含 H（无自指）', hInZip.length === 0, hInZip.length ? `命中 ${hInZip.slice(0, 5).join('、')}` : '0 命中');

  const rootFiles = walkRel(ROOT);
  const rootSet = new Set(rootFiles);
  const expectedRoot = new Set([...zipSet, ...anchorFiles]);
  if (anchorScopeRoot) {
    const rootOnly = [...expectedRoot].filter((r) => !rootSet.has(r));
    const extraRoot = rootFiles.filter((r) => !expectedRoot.has(r));
    addCheck('交付根 = zip 内容 + 2 个锚文件', rootOnly.length === 0 && extraRoot.length === 0, `缺 ${rootOnly.length}/多 ${extraRoot.length}`);
    const diff = [];
    for (const [rel, e] of relEntries) {
      if (rel === MANIFEST_NAME) continue;
      const abs = absOf(ROOT, rel);
      if (!fs.existsSync(abs)) { diff.push(`${rel}（缺）`); continue; }
      if (sha256File(abs) !== e.sha256) diff.push(rel);
    }
    addCheck('zip ↔ 交付根逐字节一致（除外层清单）', diff.length === 0, `不一致 ${diff.length}${diff.length ? `：${diff.slice(0, 5).join('、')}` : ''}`);
    const expectedDeclared = new Set([...outerZipParsed.declared.keys(), ANCHOR_NAME, FINAL_JSON_NAME]);
    const rootDeclared = new Set(outerRootParsed.declared.keys());
    const d1 = [...expectedDeclared].filter((r) => !rootDeclared.has(r));
    const d2 = [...rootDeclared].filter((r) => !expectedDeclared.has(r));
    const hashDiffs = [];
    for (const [rel, h] of expectedDeclared) {
      if (!outerRootParsed.declared.has(rel)) continue;
      if (rel === ANCHOR_NAME || rel === FINAL_JSON_NAME) continue;
      if (outerRootParsed.declared.get(rel) !== h) hashDiffs.push(rel);
    }
    addCheck('交付根外层清单 O1 = O0 + 2 个锚行（哈希不变）', d1.length === 0 && d2.length === 0 && hashDiffs.length === 0, `少 ${d1.length}/多 ${d2.length}/哈希变 ${hashDiffs.length}（前 5：${[...d1, ...d2, ...hashDiffs].slice(0, 5).join('、') || '无'}）`);
  } else {
    const only = [...zipSet].filter((r) => !rootSet.has(r));
    const extra = rootFiles.filter((r) => !zipSet.has(r));
    const diff = [];
    for (const [rel, e] of relEntries) {
      const abs = absOf(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      if (sha256File(abs) !== e.sha256) diff.push(rel);
    }
    addCheck('交付根 = zip 内容（锚在 out）', only.length === 0 && extra.length === 0 && diff.length === 0, `缺 ${only.length}/多 ${extra.length}/不一致 ${diff.length}`);
  }

  return emitVerify(false, checks);
}

function emitVerify(aborted, checks) {
  const ok = !aborted && checks.every((c) => c.pass);
  const result = {
    schema: SCHEMA, tool: TOOL, toolVersion: TOOL_VERSION, mode: 'verify', at: new Date().toISOString(),
    ok, checks, steps: checks.map((c) => ({ step: c.name, pass: c.pass, detail: c.detail })),
    root: ROOT, pkg: PKG, runtime: buildRuntime(),
  };
  return emit(result, ok ? 0 : 1);
}

function buildRuntime() {
  return { node: process.version, platform: process.platform, arch: process.arch, cwd: process.cwd(), osTmpdir: os.tmpdir(), argv: process.argv.slice(2) };
}

// ---------------------------------------------------------------------------
// 十、主流程
// ---------------------------------------------------------------------------
try {
  if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) usage(`--root 不是目录：${ROOT}`);
  if (MODE === 'manifests') modeManifests();
  else if (MODE === 'zip') modeZip();
  else if (MODE === 'extract') modeExtract();
  else if (MODE === 'anchors') modeAnchors();
  else if (MODE === 'verify') modeVerify();
} catch (err) {
  console.error(`[导出] 致命错误：${err && err.stack ? err.stack : err}`);
  process.exit(2);
}
