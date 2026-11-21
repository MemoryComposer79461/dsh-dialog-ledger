/**
 * @file cli.mjs
 * @role 指针索引（档 A）的**命令行入口**：`index build` / `index query` / `index stat`。
 *
 * @why 为什么要有独立 CLI（0.9.4-P3 档 A）：
 *   索引是**外置派生层**，tick 不写它（档 B 才进 core）。所以必须有一个"人/脚本一键维护"的入口：
 *     · build  从台账重建日分片（可 `--since` 只补新日；内容未变分片不重写）
 *     · query  按 code / sid / turn / range 查（查不到必须给出边界回执：查了哪段、更早还有没有）
 *     · stat   体检（分片 ↔ 台账 ↔ 原文视图交叉核对；任何不一致进 problems[]，退出码 1 = 不许当绿）
 *
 * @why 只写 `<root>/ledger/.index/`：本 CLI 没有任何"写台账/写原文"的代码路径，
 *      失败也只会污染 `.index`（删掉重跑即可，索引永远是派生物）。
 *
 * 用法：
 *   node tools/cli.mjs index build --root=<账库> [--since=YYYYMMDD] [--json]
 *   node tools/cli.mjs index query --root=<账库> (--code=<32位编码> | --sid=<会话id> [--turn=N]
 *                                          | --turn=N [--range=<from>..<to>]) [--range=..] [--limit=N]
 *                                          [--check-docs] [--json]
 *   node tools/cli.mjs index stat  --root=<账库> [--check-docs|--no-docs] [--json]
 *
 * 退出码：0 = 成功且无 problems；1 = 查出问题 / 查询未命中 / 索引与台账对不上；2 = 用法错误或 IO 失败。
 *
 * ⚠️ 本文件只被命令行调用，不 import 进 index.js（不参与 tick）。
 */
import { buildIndex, queryIndex, statIndex, INDEX_FORMAT } from './pointerindex.mjs';

const USAGE = `指针索引（档 A · 外部派生层） CLI

用法：
  node tools/cli.mjs index build --root=<账库> [--since=YYYYMMDD] [--json]
  node tools/cli.mjs index query --root=<账库> (--code=<32位编码> | --sid=<会话id> [--turn=N] | --turn=N)
                                 [--range=<from>..<to>] [--limit=N] [--check-docs] [--json]
  node tools/cli.mjs index stat  --root=<账库> [--check-docs|--no-docs] [--json]

说明：
  · 所有写入只落在 <账库>/ledger/.index/（索引是派生物；删掉即回到无索引状态）
  · query 的 --limit 默认 50；--check-docs 会对命中行加做原文视图整文件 sha256 复核
  · query 未命中 / stat 有 problems → 退出码 1（不静默当绿）；用法/IO 错误 → 2
  · --root 指向账库根（含 ledger/ 与 .ledger-root 的那个目录）
`;

class UsageError extends Error {}

/** 解析 `--k=v` 与 `--k v`（本工具所有带值参数都支持这两种写法）。 */
function parseArgv(argv) {
  const flags = Object.create(null);
  const positional = [];
  const valueFlags = new Set(['root', 'since', 'code', 'sid', 'turn', 'range', 'limit']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (valueFlags.has(key)) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) throw new UsageError(`参数 --${key} 缺少值`);
      flags[key] = v;
      i++;
      continue;
    }
    flags[key] = true;
  }
  return { flags, positional };
}

function requireRoot(flags) {
  if (typeof flags.root !== 'string' || !flags.root) throw new UsageError('缺少 --root=<账库>');
  return flags.root;
}

function intFlag(flags, key) {
  if (flags[key] == null) return undefined;
  const n = Number(flags[key]);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${key} 必须是正整数`);
  return n;
}

/** 人读一行 problem（JSON 里保留完整对象）。 */
function problemLine(p) {
  const bits = [p.kind];
  for (const k of ['day', 'file', 'code', 'count', 'reason', 'error', 'expected', 'actual', 'stateRows', 'indexRows', 'ledgerRows']) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') bits.push(`${k}=${p[k]}`);
  }
  return bits.join(' ');
}

function printProblems(problems, truncated, limit = 20) {
  if (!problems || problems.length === 0) {
    console.log('  problems: 0');
    return;
  }
  console.log(`  problems: ${problems.length}${truncated ? ` (+${truncated} 未列出)` : ''}`);
  for (const p of problems.slice(0, limit)) console.log('   - ' + problemLine(p));
  if (problems.length > limit) console.log(`   … 其余 ${problems.length - limit} 条见 --json`);
}

function out(obj, asJson, human) {
  if (asJson) {
    console.log(JSON.stringify(obj, null, 2));
  } else {
    human(obj);
  }
}

// ============================================================================
// 子命令
// ============================================================================

function cmdBuild(flags) {
  const root = requireRoot(flags);
  const asJson = flags.json === true;
  const t0 = Date.now();
  const r = buildIndex({ root, sinceYmd: typeof flags.since === 'string' ? flags.since : undefined });
  const exitCode = r.ok ? 0 : 1;
  out(
    {
      command: 'index build',
      ok: r.ok,
      exitCode,
      root: r.root,
      indexDir: r.indexDir,
      format: INDEX_FORMAT,
      shardBy: 'ledger-day',
      sinceYmd: r.sinceYmd,
      shards: r.shards,
      rows: r.rows,
      bytes: r.bytes,
      bytesPerRow: r.bytesPerRow,
      offsetNull: r.offsetNull,
      docShaNull: r.docShaNull,
      written: r.written,
      unchanged: r.unchanged,
      removed: r.removed,
      ledger: r.ledger,
      byDay: r.byDay,
      problems: r.problems,
      ms: r.ms,
    },
    asJson,
    (o) => {
      console.log(`[index build] ${o.ok ? 'OK' : 'PROBLEMS'}  root=${o.root}`);
      console.log(`  日分片: ${o.shards} 个（按台账日 idx-YYYYMMDD.jsonl）  索引行: ${o.rows}  字节: ${o.bytes}  B/行: ${o.bytesPerRow}`);
      console.log(`  本次写入分片 ${o.written} / 未变跳过 ${o.unchanged} / 清理陈旧 ${o.removed}（${(o.ms / 1000).toFixed(2)}s）`);
      console.log(`  台账: ${o.ledger.files} 文件 / ${o.ledger.rows} 行 / ${o.ledger.bytes} B  偏移缺失(offset=null): ${o.offsetNull}  docFileSha256 缺失: ${o.docShaNull}`);
      console.log(`  索引/台账字节比: ${o.ledger.bytes ? (o.bytes / o.ledger.bytes * 100).toFixed(2) + '%' : 'n/a'}`);
      printProblems(o.problems, 0);
    }
  );
  return exitCode;
}

function cmdQuery(flags) {
  const root = requireRoot(flags);
  const asJson = flags.json === true;
  const code = typeof flags.code === 'string' ? flags.code : '';
  const sid = typeof flags.sid === 'string' ? flags.sid : '';
  const turn = flags.turn != null ? Number(flags.turn) : null;
  if (turn != null && (!Number.isInteger(turn) || turn < 0)) throw new UsageError('--turn 必须是 ≥0 的整数');
  const range = typeof flags.range === 'string' ? flags.range : '';
  if (!code && !sid && turn == null && !range) {
    throw new UsageError('query 至少要给一个条件：--code / --sid / --turn / --range');
  }
  const limit = intFlag(flags, 'limit') || 50;
  const rows = queryIndex({ root, code, sid, turn, range, limit, checkDocs: flags['check-docs'] === true });
  const meta = rows.meta || {};
  const pointerProblems = Array.isArray(meta.pointerProblems) ? meta.pointerProblems : [];
  const ok = rows.length > 0 && pointerProblems.length === 0;
  const exitCode = ok ? 0 : 1;
  out(
    {
      command: 'index query',
      ok,
      exitCode,
      found: rows.length > 0,
      count: rows.length,
      rows,
      searchedRange: meta.searchedRange || null,
      olderAvailable: !!meta.olderAvailable,
      newerAvailable: !!meta.newerAvailable,
      hint: meta.hint || '',
      allShardDays: meta.allShardDays || 0,
      shardsRead: meta.shardsRead || 0,
      bytesRead: meta.bytesRead || 0,
      rowsRead: meta.rowsRead || 0,
      limitHit: !!meta.limitHit,
      extraScan: !!meta.extraScan,
      pointerProblems,
      ms: meta.ms || 0,
    },
    asJson,
    (o) => {
      console.log(`[index query] ${o.ok ? 'OK' : (o.found ? 'POINTER-PROBLEMS' : 'NOT-FOUND')}  命中 ${o.count} 行（读 ${o.shardsRead} 分片 / ${o.bytesRead} B，${o.ms} ms）`);
      console.log(`  查询边界: ${o.searchedRange && o.searchedRange.fromYmd ? o.searchedRange.fromYmd + '..' + o.searchedRange.toYmd : '(无)'}` +
        `  olderAvailable=${o.olderAvailable}  newerAvailable=${o.newerAvailable}  索引总日数=${o.allShardDays}`);
      for (const r of o.rows) {
        const parts = [r.code, `day=${r.day}`, `o=${r.offset}`, `n=${r.bytes}`, `turn=${r.turn}`];
        if (r.ts) parts.push(`ts=${r.ts}`);
        if (r.sid) parts.push(`sid=${r.sid}`);
        if (r.doc) parts.push(`doc=${r.doc}`);
        parts.push(r.pointerOk ? 'pointer=ok' : `pointer=${r.pointerError || 'bad'}`);
        console.log('   · ' + parts.join(' '));
      }
      if (o.pointerProblems.length > 0) printProblems(o.pointerProblems, 0, 10);
      if (o.hint) console.log('  hint: ' + o.hint);
    }
  );
  return exitCode;
}

function cmdStat(flags) {
  const root = requireRoot(flags);
  const asJson = flags.json === true;
  const checkDocs = flags['check-docs'] === true ? true : (flags['no-docs'] === true ? false : 'auto');
  const r = statIndex({ root, checkDocs });
  const exitCode = r.ok ? 0 : 1;
  const stateSummary = r.state ? {
    format: r.state.format,
    shardBy: r.state.shardBy,
    builtAt: r.state.builtAt,
    sinceYmd: r.state.sinceYmd,
    rows: r.state.rows,
    shards: r.state.shards,
    bytes: r.state.bytes,
    offsetNull: r.state.offsetNull,
    docShaNull: r.state.docShaNull,
    minDay: r.state.minDay,
    maxDay: r.state.maxDay,
    days: r.state.days ? Object.keys(r.state.days).length : 0,
  } : null;
  out(
    {
      command: 'index stat',
      ok: r.ok,
      exitCode,
      root: r.root,
      indexDir: r.indexDir,
      format: INDEX_FORMAT,
      shards: r.shards,
      rows: r.rows,
      bytes: r.bytes,
      bytesPerRow: r.bytesPerRow,
      offsetNull: r.offsetNull,
      docShaNull: r.docShaNull,
      ledger: r.ledger,
      indexToLedgerRatio: r.indexToLedgerRatio,
      docsChecked: r.docsChecked,
      docsCheckedCount: r.docsCheckedCount,
      docsSkippedReason: r.docsSkippedReason,
      stateMatch: r.stateMatch,
      state: stateSummary,
      byDay: r.byDay,
      problems: r.problems,
      problemsTruncated: r.problemsTruncated,
      ms: r.ms,
    },
    asJson,
    (o) => {
      console.log(`[index stat] ${o.ok ? 'OK（索引 ↔ 台账 ↔ 原文视图 一致）' : 'PROBLEMS'}`);
      console.log(`  分片 ${o.shards} 个 / 索引 ${o.rows} 行 / ${o.bytes} B / ${o.bytesPerRow} B/行`);
      console.log(`  台账 ${o.ledger.files} 文件 / ${o.ledger.rows} 行 / ${o.ledger.bytes} B；索引/台账 = ${o.indexToLedgerRatio == null ? 'n/a' : (o.indexToLedgerRatio * 100).toFixed(2) + '%'}`);
      console.log(`  原文视图复核: ${o.docsChecked ? '已逐条复核 ' + o.docsCheckedCount + ' 个' : '跳过（' + (o.docsSkippedReason || 'n/a') + '）'}`);
      console.log(`  状态文件: ${o.state ? '存在' : '缺失'}  stateMatch=${o.stateMatch}` + (o.state ? `  builtAt=${o.state.builtAt}  maxDay=${o.state.maxDay}` : ''));
      printProblems(o.problems, o.problemsTruncated);
    }
  );
  return exitCode;
}

// ============================================================================
// 入口
// ============================================================================

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  let flags;
  let positional;
  try {
    ({ flags, positional } = parseArgv(argv));
  } catch (e) {
    console.error('[用法错误] ' + e.message + '\n');
    console.error(USAGE);
    return 2;
  }
  if (positional[0] !== 'index' || !positional[1]) {
    console.error('[用法错误] 只支持 `index build|query|stat`\n');
    console.error(USAGE);
    return 2;
  }
  const sub = positional[1];
  const known = {
    build: new Set(['root', 'since', 'json', 'help']),
    query: new Set(['root', 'code', 'sid', 'turn', 'range', 'limit', 'json', 'check-docs', 'help']),
    stat: new Set(['root', 'json', 'check-docs', 'no-docs', 'help']),
  };
  if (!known[sub]) {
    console.error(`[用法错误] 未知子命令 index ${sub}（只支持 build/query/stat）\n`);
    console.error(USAGE);
    return 2;
  }
  for (const k of Object.keys(flags)) {
    if (!known[sub].has(k)) {
      console.error(`[用法错误] index ${sub} 不认识参数 --${k}\n`);
      console.error(USAGE);
      return 2;
    }
  }
  try {
    if (sub === 'build') return cmdBuild(flags);
    if (sub === 'query') return cmdQuery(flags);
    return cmdStat(flags);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error('[用法错误] ' + e.message + '\n');
      console.error(USAGE);
      return 2;
    }
    console.error('[失败] ' + (e && e.message ? e.message : String(e)));
    return 2;
  }
}

process.exitCode = main();
