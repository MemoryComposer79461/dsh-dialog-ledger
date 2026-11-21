/**
 * @file lib/manifestanchor.js
 * @role V0.8 库外 manifest 锚：把**交付包**的 payloadHash/MANIFEST 根哈希/版本链与**账本快照**锚到库外，
 *       并支持只读复算校验（不联网、不写库）。
 *
 * 设计：docs/交付-v0.8/01-库外manifest锚与恢复演练设计.md
 * @why 包内 MANIFEST 与版本台账都在同一处，"整包替换 + 重算 MANIFEST"可以自洽；只有库外另存一份
 *      （桌面锚目录 → 机主搬 U 盘）才构成两处独立记录。锚只增不改，链式 prevHash 防替换。
 *
 * 本模块分纯函数：
 *  - computePackageDigest(pkgDir)：复算 payloadHash（算法与出包脚本/版本台账一致）；
 *  - readManifest(pkgDir)：解析 MANIFEST.sha256；
 *  - appendAnchor(anchorRoot, entry)：append-only + fsync + 幂等（同 payloadHash 跳过）；
 *  - readAnchor(anchorRoot)：解析 + 链校验；
 *  - verifyPackageAgainstAnchor(pkgDir, anchorRoot)：只读校验；
 *  - buildLedgerSnapshot(root, opts) / verifyLedgerSnapshot(root, snapshot)：账本快照锚与校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 锚文件格式版本。 */
export const ANCHOR_VERSION = 1;
/** 锚文件名。 */
export const ANCHOR_FILE = 'DELIVERY-ANCHOR.jsonl';
/** 锚行键（顺序固定）。 */
export const PACKAGE_KEYS = Object.freeze([
  'v', 'at', 'kind', 'version', 'stage', 'payloadHash', 'prevHash',
  'manifestSha256', 'fileCount', 'manifestCount', 'pkgPath', 'note',
]);

const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (file) => sha256Buf(fs.readFileSync(file));

/** 锚文件路径。 */
export function anchorPath(anchorRoot) {
  return path.join(anchorRoot, ANCHOR_FILE);
}

/** 递归列出文件（相对路径，排序）。 */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/**
 * 复算交付包内容哈希（与出包脚本一致）：
 * 除 `MANIFEST.sha256` 与 `版本台账.md` 外，全部文件哈希按路径排序后的摘要。
 * @param {string} pkgDir
 * @returns {{payloadHash:string, files:number, bytes:number, manifestSha256:string}}
 */
export function computePackageDigest(pkgDir) {
  if (!pkgDir || !fs.existsSync(pkgDir)) throw new Error('PKG_NOT_FOUND: ' + String(pkgDir));
  // 与出包脚本一致：payloadHash 在 00-交付清单/MANIFEST/版本台账 生成**之前**计算，
  // 复算时必须排除这三个自指文件（否则与版本台账 payloadHash 对不上）。
  const SELF_FILES = new Set(['MANIFEST.sha256', '版本台账.md', '00-交付清单.md']);
  const kept = listFiles(pkgDir).filter((rel) => !SELF_FILES.has(path.basename(rel)));
  const lines = [];
  let bytes = 0;
  for (const rel of kept) {
    const p = path.join(pkgDir, rel);
    lines.push(`${sha256File(p)}  ${rel}`);
    bytes += fs.statSync(p).size;
  }
  lines.sort();
  const payloadHash = sha256Buf(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  const mf = path.join(pkgDir, 'MANIFEST.sha256');
  const manifestSha256 = fs.existsSync(mf) ? sha256File(mf) : '';
  return { payloadHash, files: kept.length, bytes, manifestSha256 };
}

/**
 * 解析 MANIFEST.sha256（每行 `<sha256>  <relPath>`）。
 * @returns {{entries:Array<{hash:string,rel:string}>, count:number, badLines:number, rootHash:string}}
 */
export function readManifest(pkgDir) {
  const file = path.join(pkgDir, 'MANIFEST.sha256');
  if (!fs.existsSync(file)) return { entries: [], count: 0, badLines: 0, rootHash: '' };
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { badLines += 1; continue; }
    entries.push({ hash: m[1], rel: m[2] });
  }
  return { entries, count: entries.length, badLines, rootHash: sha256Buf(Buffer.from(text, 'utf8')) };
}

/** 读锚文件；返回行、坏行数、链状态。 */
export function readAnchor(anchorRoot) {
  const file = anchorPath(anchorRoot);
  const out = { file, exists: false, entries: [], badLines: 0, chainOk: true, breaks: [] };
  if (!fs.existsSync(file)) return out;
  out.exists = true;
  const text = fs.readFileSync(file, 'utf8');
  let prev = null;
  let idx = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    idx += 1;
    let rec = null;
    try { rec = JSON.parse(line); } catch { out.badLines += 1; continue; }
    if (!rec || typeof rec !== 'object' || rec.v !== ANCHOR_VERSION || typeof rec.kind !== 'string') { out.badLines += 1; continue; }
    out.entries.push(rec);
    if (rec.kind === 'package') {
      if (prev !== null && rec.prevHash !== prev) {
        out.chainOk = false;
        out.breaks.push({ at: idx, version: rec.version, expected: prev, actual: rec.prevHash });
      }
      prev = rec.payloadHash;
    }
  }
  return out;
}

/**
 * 追加一条锚（append-only + fsync；幂等：最后一条同 payloadHash/version 时跳过）。
 * @returns {{ok:boolean, appended:boolean, idempotent?:boolean, path:string, error?:string}}
 */
export function appendAnchor(anchorRoot, entry) {
  const out = { ok: false, appended: false, path: anchorPath(anchorRoot) };
  if (!anchorRoot || typeof anchorRoot !== 'string') { out.error = 'NO_ANCHOR_ROOT'; return out; }
  try {
    fs.mkdirSync(anchorRoot, { recursive: true });
    const rec = {
      v: ANCHOR_VERSION,
      at: String((entry && entry.at) || new Date().toISOString()),
      kind: String((entry && entry.kind) || 'package'),
      version: String((entry && entry.version) || ''),
      stage: String((entry && entry.stage) || ''),
      payloadHash: String((entry && entry.payloadHash) || ''),
      prevHash: String((entry && entry.prevHash) || ''),
      manifestSha256: String((entry && entry.manifestSha256) || ''),
      fileCount: Number(entry && entry.fileCount) || 0,
      manifestCount: Number(entry && entry.manifestCount) || 0,
      pkgPath: String((entry && entry.pkgPath) || ''),
      note: String((entry && entry.note) || ''),
    };
    // ★ 账本快照行必须保留自己的载荷（files/计数等）；通用 package 行不含这些键。
    if (rec.kind === 'ledger-snapshot') {
      rec.rootId = String((entry && entry.rootId) || '');
      rec.lastDate = String((entry && entry.lastDate) || '');
      rec.totalRows = Number(entry && entry.totalRows) || 0;
      rec.weeklySealedCount = Number(entry && entry.weeklySealedCount) || 0;
      rec.weeklyDraftCount = Number(entry && entry.weeklyDraftCount) || 0;
      rec.files = Array.isArray(entry && entry.files) ? entry.files : [];
    }
    if (rec.kind === 'package') {
      for (const k of ['version', 'payloadHash', 'manifestSha256']) {
        if (!rec[k]) { out.error = 'MISSING_' + k.toUpperCase(); return out; }
      }
    }
    const exists = fs.existsSync(out.path);
    if (exists) {
      const cur = readAnchor(anchorRoot);
      if (rec.kind === 'package') {
        const lastPkg = [...cur.entries].reverse().find((x) => x.kind === 'package');
        if (lastPkg && lastPkg.payloadHash === rec.payloadHash) {
          out.ok = true;
          out.appended = false;
          out.idempotent = true;
          return out;
        }
      }
    }
    const line = JSON.stringify(rec) + '\n';
    const fd = fs.openSync(out.path, 'a');
    try {
      fs.writeSync(fd, line);
      try { fs.fsyncSync(fd); } catch { /* fsync 失败不改变“已写”事实 */ }
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    out.ok = true;
    out.appended = true;
    return out;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
}

/**
 * 只读校验：包 vs 锚（payloadHash / MANIFEST 根 / 链）。
 * @returns {{ok:boolean, checks:Array<{name:string,ok:boolean,detail:string}>}}
 */
export function verifyPackageAgainstAnchor(pkgDir, anchorRoot) {
  const checks = [];
  const digest = computePackageDigest(pkgDir);
  const mf = readManifest(pkgDir);
  const anchor = readAnchor(anchorRoot);
  checks.push({ name: 'anchor-exists', ok: anchor.exists, detail: anchor.exists ? anchor.file : '锚文件不存在' });
  checks.push({ name: 'anchor-no-bad-lines', ok: anchor.badLines === 0, detail: 'badLines=' + anchor.badLines });
  checks.push({ name: 'anchor-chain', ok: anchor.chainOk, detail: anchor.chainOk ? 'prevHash 连续' : JSON.stringify(anchor.breaks) });
  checks.push({ name: 'manifest-no-bad-lines', ok: mf.badLines === 0, detail: 'badLines=' + mf.badLines });
  const pkgs = anchor.entries.filter((x) => x.kind === 'package');
  const match = [...pkgs].reverse().find((x) => x && (x.payloadHash === digest.payloadHash || (x.version && pkgDir.includes(String(x.version)))));
  checks.push({ name: 'package-anchored', ok: !!match, detail: match ? 'version=' + match.version : '锚中无对应包（新版本需先锚定）' });
  if (match) {
    checks.push({ name: 'payloadHash', ok: match.payloadHash === digest.payloadHash, detail: `anchor=${match.payloadHash.slice(0, 16)}… disk=${digest.payloadHash.slice(0, 16)}…` });
    checks.push({ name: 'manifestSha256', ok: match.manifestSha256 === digest.manifestSha256, detail: mf.rootHash.slice(0, 16) + '…' });
    checks.push({ name: 'manifestCount', ok: match.manifestCount === mf.count, detail: `anchor=${match.manifestCount} disk=${mf.count}` });
    // 总文件数 = payload 计入文件 + 3（MANIFEST.sha256 / 版本台账.md / 00-交付清单.md）
    checks.push({ name: 'fileCount', ok: match.fileCount === (digest.files + 3), detail: `anchor=${match.fileCount} disk(payloadFiles+3)=${digest.files + 3}` });
  }
  return { ok: checks.every((c) => c.ok), checks, digest, manifest: { count: mf.count, badLines: mf.badLines, rootHash: mf.rootHash } };
}

/** 账本快照（只读）：逐日台账文件 sha/bytes/rows + 周账计数。 */
export function buildLedgerSnapshot(root, { offsetMinutes = 480 } = {}) {
  const ledger = path.join(root, 'ledger');
  const files = [];
  let totalRows = 0;
  if (fs.existsSync(ledger)) {
    for (const name of fs.readdirSync(ledger).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const p = path.join(ledger, name);
      const buf = fs.readFileSync(p);
      const rows = buf.toString('utf8').split('\n').filter((l) => l.trim()).length;
      files.push({ name, bytes: buf.length, sha256: sha256Buf(buf), rows });
      totalRows += rows;
    }
  }
  let weeklySealed = 0;
  let weeklyDraft = 0;
  try {
    for (const monthDir of fs.readdirSync(root).filter((n) => /^\d{4}年\d{2}月$/.test(n))) {
      const d = path.join(root, monthDir);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const n of fs.readdirSync(d)) {
        if (!n.endsWith('.xlsx')) continue;
        if (n.startsWith('草稿-')) weeklyDraft += 1;
        else if (/^\d{2}月第\d+周-.+的周记账\.xlsx$/.test(n)) weeklySealed += 1;
      }
    }
  } catch { /* 目录读不全不阻塞 */ }
  return {
    v: 1,
    at: new Date().toISOString(),
    kind: 'ledger-snapshot',
    offsetMinutes,
    lastDate: files.length ? files[files.length - 1].name.replace(/\.jsonl$/, '') : '',
    totalRows,
    weeklySealedCount: weeklySealed,
    weeklyDraftCount: weeklyDraft,
    files,
  };
}

/** 只读校验：现场 vs 快照（逐文件 sha/rows + 计数）。 */
export function verifyLedgerSnapshot(root, snapshot) {
  const now = buildLedgerSnapshot(root, { offsetMinutes: snapshot && snapshot.offsetMinutes });
  const checks = [];
  const snapFiles = new Map(((snapshot && snapshot.files) || []).map((f) => [f.name, f]));
  const nowFiles = new Map(now.files.map((f) => [f.name, f]));
  const names = new Set([...snapFiles.keys(), ...nowFiles.keys()]);
  const diffs = [];
  for (const name of [...names].sort()) {
    const a = snapFiles.get(name);
    const b = nowFiles.get(name);
    if (!a) { diffs.push({ name, kind: 'added' }); continue; }
    if (!b) { diffs.push({ name, kind: 'missing' }); continue; }
    if (a.sha256 !== b.sha256) diffs.push({ name, kind: 'sha-mismatch', anchor: a.sha256.slice(0, 16), disk: b.sha256.slice(0, 16) });
    else if (a.rows !== b.rows) diffs.push({ name, kind: 'rows-mismatch', anchor: a.rows, disk: b.rows });
  }
  checks.push({ name: 'ledger-files', ok: diffs.length === 0, detail: diffs.length ? JSON.stringify(diffs.slice(0, 5)) : 'files=' + now.files.length });
  checks.push({ name: 'weekly-counts', ok: Number(snapshot && snapshot.weeklySealedCount) === now.weeklySealedCount && Number(snapshot && snapshot.weeklyDraftCount) === now.weeklyDraftCount, detail: `sealed anchor=${snapshot && snapshot.weeklySealedCount} disk=${now.weeklySealedCount}; draft anchor=${snapshot && snapshot.weeklyDraftCount} disk=${now.weeklyDraftCount}` });
  return { ok: checks.every((c) => c.ok), checks, diffs, now };
}
