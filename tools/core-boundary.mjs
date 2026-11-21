// core-boundary.mjs — lite 核心边界检查（S-8 的执行器）
// 规则（0.9.1-re2 修订，机主授权改本工具；v1.0.0-re2 增补 P1-10）：
//   1) lib/*.js 即核心（tick 运行时唯一合法产区）；核心不许 import ../freeze/ 或 ../tools/ 的文件；
//   2) index.js 不许 import ./freeze/*（审核层必须在运行期不可达）；
//      index → ./tools/* **允许**（tools 是"外部命令/按钮"，属设计允许的依赖），
//      但**必须列进 `core-manifest.json` 的 `indexAllowlist.tools`**；未声明的边 = violation
//      （★ P1-10：旧版只作"提示"，于是清单里写 3 条、实物 4 条时没人发现）；
//   3) 任何 core → tools/freeze 的边、或 index → freeze 的边，都是 violation。
//
// ★ P1-10（准入审计 P1-10 · 机主裁定 V1.0 前解决）：
//   本工具从「只按硬编码规则扫 import」改为**读取同一份 `core-manifest.json` 并逐项对账**：
//     · coreFiles / coreCount 与磁盘 lib/*.js 对账（缺/多/数不符 → violation）；
//     · outsiders.tools / outsiders.freeze 与磁盘对账（缺/多 → violation）；
//     · indexAllowlist.tools 与 index.js 实际 index→tools 边对账（未声明 → violation）。
//   这样"清单"与"检查器"不再各说各话（审计指出：清单与实物不一致，且边界工具不消费该清单）。
//
// 退出码只看 violation；0 = 无 violation；1 = 有；2 = 用法错误。
// 用法：node tools/core-boundary.mjs [--json] [--root=<repo>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.find((a) => a.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice(7)) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const libDir = path.join(root, 'lib');
const idxFile = path.join(root, 'index.js');
const manifestFile = path.join(root, 'core-manifest.json');

/** 旧白名单仅作兜底：清单缺失时至少还能扫出 index→tools 提示（不作为通过依据）。 */
const INDEX_TOOLS_ALLOW_FALLBACK = new Set(['tools/toolface.js']);

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"\n]+?)\1/g;
  let m;
  while ((m = re.exec(src))) out.push({ spec: m[2], at: src.slice(0, m.index).split('\n').length });
  return out;
}

function classify(abs) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('freeze/')) return { kind: 'freeze', rel };
  if (rel.startsWith('tools/')) return { kind: 'tools', rel };
  if (rel.startsWith('lib/')) return { kind: 'core', rel };
  return { kind: 'other', rel };
}

/** 列目录里的相对路径（`dir/name`），排序。目录不存在 → 空数组。 */
function listFilesRel(dirName, filter = null) {
  const abs = path.join(root, dirName);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((x) => (filter ? filter(x) : true))
    .map((x) => `${dirName}/${x}`)
    .sort();
}

/** 集合差异（声明 vs 实际）。 */
function setDiff(declared, actual) {
  const d = new Set(declared);
  const a = new Set(actual);
  return {
    missing: [...d].filter((x) => !a.has(x)), // 声明了但磁盘没有
    extra: [...a].filter((x) => !d.has(x)),   // 磁盘有但没声明
  };
}

const violations = [];
const edges = [];
/** index → tools 的边（设计允许；全部单独列出，未声明的进 violation）。 */
const indexToolsEdges = [];
const hints = [];
const manifestChecks = [];

// ---------------------------------------------------------------------------
// ① 清单本身（P1-10）：读不到 = violation（它现在是唯一声明源）
// ---------------------------------------------------------------------------
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
} catch (e) {
  violations.push({
    rule: 'manifest-unreadable',
    from: 'core-manifest.json',
    to: '-',
    line: 0,
    detail: e && e.code === 'ENOENT' ? '清单文件不存在' : `清单解析失败: ${e && e.message}`,
  });
}

// ---------------------------------------------------------------------------
// ② 核心集（lib/*.js）与清单对账
// ---------------------------------------------------------------------------
const coreFiles = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((x) => x.endsWith('.js')).sort() : [];
if (manifest) {
  const declaredCore = Array.isArray(manifest.coreFiles) ? manifest.coreFiles.map(String) : [];
  const diff = setDiff(declaredCore, coreFiles.map((x) => `lib/${x}`));
  manifestChecks.push({
    what: 'coreFiles',
    declared: declaredCore.length,
    actual: coreFiles.length,
    missing: diff.missing,
    extra: diff.extra,
  });
  for (const m of diff.missing) {
    violations.push({ rule: 'manifest-core-missing-on-disk', from: 'core-manifest.json', to: m, line: 0 });
  }
  for (const x of diff.extra) {
    violations.push({ rule: 'manifest-core-undeclared', from: 'core-manifest.json', to: x, line: 0 });
  }
  const declaredCount = Number(manifest.coreCount);
  if (Number.isFinite(declaredCount) && declaredCount !== declaredCore.length) {
    violations.push({
      rule: 'manifest-corecount-mismatch',
      from: 'core-manifest.json#coreCount',
      to: String(declaredCount),
      line: 0,
      detail: `declared coreCount=${declaredCount}，但 coreFiles 列了 ${declaredCore.length} 条`,
    });
  }
  if (Number.isFinite(declaredCount) && declaredCount !== coreFiles.length) {
    violations.push({
      rule: 'manifest-corecount-vs-disk',
      from: 'core-manifest.json#coreCount',
      to: String(coreFiles.length),
      line: 0,
      detail: `declared coreCount=${declaredCount}，磁盘 lib/*.js=${coreFiles.length}`,
    });
  }
}

// ---------------------------------------------------------------------------
// ③ 外部层（freeze/ 与 tools/）与清单对账
// ---------------------------------------------------------------------------
if (manifest && manifest.outsiders && typeof manifest.outsiders === 'object') {
  const diskFreeze = listFilesRel('freeze');
  const diskTools = listFilesRel('tools');
  for (const [layer, disk] of [['freeze', diskFreeze], ['tools', diskTools]]) {
    const declared = Array.isArray(manifest.outsiders[layer]) ? manifest.outsiders[layer].map(String).sort() : null;
    if (declared === null) {
      violations.push({ rule: 'manifest-outsiders-nodecl', from: 'core-manifest.json', to: `outsiders.${layer}`, line: 0 });
      continue;
    }
    const diff = setDiff(declared, disk);
    manifestChecks.push({ what: `outsiders.${layer}`, declared: declared.length, actual: disk.length, missing: diff.missing, extra: diff.extra });
    for (const m of diff.missing) {
      violations.push({ rule: 'manifest-outsider-missing-on-disk', from: 'core-manifest.json', to: m, line: 0 });
    }
    for (const x of diff.extra) {
      violations.push({ rule: 'manifest-outsider-undeclared', from: 'core-manifest.json', to: x, line: 0 });
    }
  }
}

// ---------------------------------------------------------------------------
// ④ 核心不许 import 外部层（lib → freeze/tools）
// ---------------------------------------------------------------------------
if (fs.existsSync(libDir)) {
  for (const f of coreFiles) {
    const abs = path.join(libDir, f);
    for (const { spec, at } of importsOf(abs)) {
      const target = path.resolve(libDir, spec);
      if (!fs.existsSync(target)) continue;
      const c = classify(target);
      if (c.kind === 'other') continue;
      edges.push({ from: `lib/${f}`, to: c.rel, line: at, kind: c.kind });
      if (c.kind === 'freeze' || c.kind === 'tools') {
        violations.push({ rule: 'core-must-not-import-outsider', from: `lib/${f}`, to: c.rel, line: at });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ⑤ index → freeze 禁止；index → tools 必须在清单的白名单里
// ---------------------------------------------------------------------------
const allowSet = new Set(
  manifest && manifest.indexAllowlist && Array.isArray(manifest.indexAllowlist.tools)
    ? manifest.indexAllowlist.tools.map(String)
    : [...INDEX_TOOLS_ALLOW_FALLBACK]
);
if (fs.existsSync(idxFile)) {
  for (const { spec, at } of importsOf(idxFile)) {
    const target = path.resolve(root, spec);
    if (!fs.existsSync(target)) continue;
    const c = classify(target);
    if (c.kind === 'freeze') {
      violations.push({ rule: 'index-must-not-import-freeze', from: 'index.js', to: c.rel, line: at });
    } else if (c.kind === 'tools') {
      indexToolsEdges.push({ from: 'index.js', to: c.rel, line: at });
      if (!allowSet.has(c.rel)) {
        // ★ P1-10：旧版只作提示 → 清单写 3 条、实物 4 条也能"通过"。现在这是 violation。
        violations.push({
          rule: 'index-tools-undeclared',
          from: 'index.js',
          to: c.rel,
          line: at,
          detail: 'index→tools 边未被 core-manifest.json#indexAllowlist.tools 声明',
        });
      } else if (!(manifest && manifest.indexAllowlist && Array.isArray(manifest.indexAllowlist.tools))) {
        hints.push({ rule: 'index-tools-fallback-allow', from: 'index.js', to: c.rel, line: at });
      }
    }
  }
}
if (manifest && manifest.indexAllowlist && Array.isArray(manifest.indexAllowlist.tools)) {
  const declared = manifest.indexAllowlist.tools.map(String);
  const actual = indexToolsEdges.map((e) => e.to);
  const diff = setDiff(declared, actual);
  manifestChecks.push({ what: 'indexAllowlist.tools', declared: declared.length, actual: actual.length, missing: diff.missing, extra: diff.extra });
  for (const m of diff.missing) {
    // 声明了但 index.js 没这条边：不是安全问题，但清单在说假话 → violation（保持"清单=事实"）。
    violations.push({ rule: 'manifest-indexallow-unused', from: 'core-manifest.json', to: m, line: 0 });
  }
}

if (asJson) {
  console.log(JSON.stringify({
    coreFiles,
    coreCount: coreFiles.length,
    manifest: manifestChecks,
    edges,
    indexToolsEdges,
    hints,
    violations,
    ok: violations.length === 0,
  }, null, 2));
} else {
  console.log(`core-boundary · root=${root}`);
  console.log(`core files (lib/*.js): ${coreFiles.length}`);
  console.log(`edges checked: ${edges.length}`);
  if (manifest) {
    for (const c of manifestChecks) {
      const okk = c.missing.length === 0 && c.extra.length === 0;
      console.log(`[清单] ${c.what}: 声明 ${c.declared} / 实际 ${c.actual} ${okk ? 'OK' : 'MISMATCH'}` +
        (okk ? '' : `（缺 [${c.missing.join(', ')}] 多 [${c.extra.join(', ')}]）`));
    }
  }
  if (violations.length === 0) {
    console.log('[PASS] 0 violation — 核心不依赖 freeze/tools，index 不 import freeze，清单与实物一致');
  } else {
    console.log(`[FAIL] ${violations.length} violation(s):`);
    for (const v of violations) {
      console.log(`  ! ${v.from} → ${v.to}${v.line ? ` (line ${v.line})` : ''} [${v.rule}]${v.detail ? ' :: ' + v.detail : ''}`);
    }
  }
  console.log(`[提示] index → tools 边共 ${indexToolsEdges.length} 条（全部已声明）：`);
  for (const h of hints) console.log(`  · ${h.from} → ${h.to} (line ${h.line}) [${h.rule}]`);
  if (hints.length === 0) console.log('  （无）');
}
process.exit(violations.length === 0 ? 0 : 1);
