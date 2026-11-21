#!/usr/bin/env node
/**
 * @file docs/工具-manifest.mjs
 * @role **MANIFEST.sha256 生成 / 校验**（包内自足版；C38「数字脚本生成」的生成器之一）。
 *
 * @why 审计 P0-02/P1-12（re3）：re2 交付包上跑 `node docs\判据-1.0.mjs` 时 C38 记 NA ——
 *      C38 要求「MANIFEST 生成/校验」有生成器，但当时生成器只在开发机 `_工作\tools\manifest.mjs`，
 *      接收端解压交付包后没有 `_工作\`。本文件是**同一口径生成器/校验器的包内版本**：
 *      `_工作\tools\manifest.mjs` 原样移植（零第三方依赖、只用 node: 内建），放在包内 docs\ 下，
 *      出包前重算 MANIFEST 与接收端复算都用它，两次同源 —— "0 差异"才不是自证。
 *
 * 口径（与项目既有约定一致，不新造；搬自 `_工作\tools\manifest.mjs`）：
 *   · 一行一个文件：`<sha256 小写 hex><两个空格><相对路径，/ 分隔>`
 *   · 排序：相对路径的**码元序**升序（UTF-8 字节序与码元序在此集合内一致，稳定可复现）
 *   · 换行：LF（`\n`）。校验时同时容忍 CRLF 与文件头 BOM（历史包里有 CRLF）
 *   · 排除：任何层级的 `.git` 目录、MANIFEST 自身（`--manifest` 指向的文件）
 *   · 不计目录（空目录不进 MANIFEST；zip 里也不放目录条目）
 *   · ★ 运行产物不特殊对待：出包时 `证据/判据-1.0-<时间戳>/` 若已在包里，按普通文件入清单；
 *     判据执行器运行时新产生的证据目录不在清单里，由 `docs/判据-1.0.mjs` C39 按
 *     "本执行器运行产物"单独登记（不计红），本工具不做任何隐藏。
 *
 * 用法：
 *   node docs\工具-manifest.mjs --root=<dir>                     生成 <dir>\MANIFEST.sha256
 *   node docs\工具-manifest.mjs --root=<dir> --out=<file>        生成到指定文件
 *   node docs\工具-manifest.mjs --root=<dir> --verify            校验 <dir>\MANIFEST.sha256
 *   node docs\工具-manifest.mjs --root=<dir> --verify --manifest=<file>
 *   node docs\工具-manifest.mjs --root=<dir> --exclude=dir1,dir2 额外排除（相对 root 的路径前缀）
 *   加 --json 时输出机读结果（stdout 只有一份 JSON）
 *
 * 退出码：0 = 全对（或已成功生成）；1 = 有差异（缺/多/改）；2 = 用法/环境错误
 *
 * @reads  <root>\**（逐文件 sha256）、<root>\MANIFEST.sha256
 * @writes --out 指定的 MANIFEST 文件（默认 <root>\MANIFEST.sha256）；不写别的
 * @depends node:fs/path/crypto/url（零第三方依赖）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'MANIFEST.sha256';

/** 解析 `--k=v` / `--k v` / `--flag` 形式的参数。 */
export function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { opts._ = (opts._ || []).concat(a); continue; }
    const eq = a.indexOf('=');
    if (eq >= 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) { opts[key] = String(next); i++; } else { flags.add(key); opts[key] = true; }
  }
  return { opts, flags };
}

/**
 * 递归列文件（相对路径，`/` 分隔，码元序升序）。
 * @param {string} root
 * @param {{exclude?: string[], skipAbs?: Set<string>}} [opt]
 * @returns {string[]}
 */
export function listFiles(root, opt = {}) {
  const exclude = (opt.exclude || []).map((p) => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const skipAbs = opt.skipAbs || new Set();
  const out = [];
  const walk = (dir, relBase) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { throw new Error(`读目录失败 ${dir}: ${e && e.message ? e.message : e}`); }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === '.git') continue; // 仓库元数据不是交付物
        if (exclude.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (skipAbs.has(abs)) continue;
        if (exclude.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
        out.push(rel);
      }
      // 符号链接/设备文件：不跟进、不入 MANIFEST（交付物里不应出现）
    }
  };
  walk(root, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** sha256 hex（小写）。 */
export function sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * 生成 MANIFEST 文本。
 * @returns {{text: string, count: number, bytes: number}}
 */
export function buildManifest(root, opt = {}) {
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) throw new Error(`root 不是目录: ${absRoot}`);
  const manifestAbs = path.resolve(opt.manifestPath || path.join(absRoot, MANIFEST_NAME));
  // 约定：<root>/MANIFEST.sha256 是"清单自身"，永远不把自己算进清单
  // （即使 --out 指到包外，也按同一口径排除，保证"生成/校验"两次的内容一致）
  const skipAbs = new Set([manifestAbs, path.join(absRoot, MANIFEST_NAME)]);
  const files = listFiles(absRoot, { exclude: opt.exclude, skipAbs });
  const lines = [];
  let bytes = 0;
  for (const rel of files) {
    const abs = path.join(absRoot, rel.split('/').join(path.sep));
    const size = fs.statSync(abs).size;
    lines.push(`${sha256File(abs)}  ${rel}\n`);
    bytes += size;
  }
  return { text: lines.join(''), count: files.length, bytes };
}

/** 把生成结果写盘。 */
export function writeManifest(root, opt = {}) {
  const manifestPath = path.resolve(opt.out || path.join(root, MANIFEST_NAME));
  const { text, count, bytes } = buildManifest(root, { ...opt, manifestPath });
  fs.writeFileSync(manifestPath, text, 'utf8');
  return { manifestPath, count, bytes };
}

/** 解析 MANIFEST 文本 → Map<relPath, sha256>。容忍 BOM / CRLF / 行尾空白。 */
export function parseManifest(text) {
  const map = new Map();
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-fA-F]{64})\s{1,2}(.+)$/.exec(line);
    if (!m) return { ok: false, error: `无法解析的 MANIFEST 行: ${line.slice(0, 120)}` };
    map.set(m[2].replace(/\\/g, '/').trim(), m[1].toLowerCase());
  }
  return { ok: true, map };
}

/**
 * 校验。
 * @returns {{ok: boolean, declared: number, actual: number, missing: string[], extra: string[], modified: string[]}}
 */
export function verifyManifest(root, opt = {}) {
  const absRoot = path.resolve(root);
  const manifestPath = path.resolve(opt.manifestPath || path.join(absRoot, MANIFEST_NAME));
  if (!fs.existsSync(manifestPath)) throw new Error(`MANIFEST 不存在: ${manifestPath}`);
  const parsed = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.error);
  const declaredMap = parsed.map;
  const actualFiles = listFiles(absRoot, {
    exclude: opt.exclude,
    skipAbs: new Set([manifestPath, path.join(absRoot, MANIFEST_NAME)]),
  });
  const actualSet = new Set(actualFiles);
  const missing = [];
  const modified = [];
  for (const [rel, want] of declaredMap) {
    if (!actualSet.has(rel)) { missing.push(rel); continue; }
    const abs = path.join(absRoot, rel.split('/').join(path.sep));
    const got = sha256File(abs);
    if (got !== want) modified.push(rel);
  }
  const extra = actualFiles.filter((rel) => !declaredMap.has(rel));
  return {
    ok: missing.length === 0 && extra.length === 0 && modified.length === 0,
    declared: declaredMap.size,
    actual: actualFiles.length,
    manifestPath,
    missing, extra, modified,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function isMain() {
  const self = fileURLToPath(import.meta.url);
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    if (path.resolve(arg) === path.resolve(self)) return true;
    return fs.realpathSync(arg) === fs.realpathSync(self);
  } catch {
    return path.resolve(arg) === path.resolve(self);
  }
}

function main(argv) {
  const { opts } = parseArgs(argv);
  const json = Boolean(opts.json);
  const root = opts.root ? String(opts.root) : '';
  if (!root) { console.error('用法: node docs\\工具-manifest.mjs --root=<dir> [--out=<file>|--verify] [--exclude=a,b] [--json]'); return 2; }
  const exclude = opts.exclude ? String(opts.exclude).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const manifestPath = opts.manifest ? String(opts.manifest) : (opts.out ? path.join(String(opts.out).replace(/[\\/][^\\/]*$/, ''), MANIFEST_NAME) : undefined);
  try {
    if (opts.verify) {
      const r = verifyManifest(root, { manifestPath: opts.manifest ? String(opts.manifest) : undefined, exclude });
      if (json) { console.log(JSON.stringify({ mode: 'verify', root: path.resolve(root), ...r }, null, 2)); }
      else {
        console.log(`[MANIFEST 校验] root=${path.resolve(root)}`);
        console.log(`  MANIFEST: ${r.manifestPath}`);
        console.log(`  声明 ${r.declared} / 实际 ${r.actual} / 缺 ${r.missing.length} / 多 ${r.extra.length} / 改 ${r.modified.length}`);
        for (const [label, list] of [['缺', r.missing], ['多', r.extra], ['改', r.modified]]) {
          if (list.length) console.log(`  ${label}（前 20）: ${list.slice(0, 20).join(', ')}${list.length > 20 ? ` …共 ${list.length}` : ''}`);
        }
        console.log(r.ok ? '  [PASS] 0 差异' : '  [FAIL] 有差异');
      }
      return r.ok ? 0 : 1;
    }
    const out = opts.out ? String(opts.out) : undefined;
    const r = writeManifest(root, { out, exclude });
    if (json) console.log(JSON.stringify({ mode: 'generate', root: path.resolve(root), ...r }, null, 2));
    else console.log(`[MANIFEST 生成] ${r.manifestPath}  ${r.count} 个文件 / ${r.bytes} B`);
    return 0;
  } catch (e) {
    console.error(`[MANIFEST 错误] ${e && e.message ? e.message : e}`);
    return 2;
  }
}

if (isMain()) process.exit(main(process.argv.slice(2)));

export { MANIFEST_NAME };
