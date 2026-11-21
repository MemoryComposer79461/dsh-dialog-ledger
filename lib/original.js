/**
 * @file original.js
 * @role 「初始凭证」渲染与落盘：一轮对话 → 一个 `<编码> 完整原文.md`，落在第 3 级目录。
 * @called-by index.js（每轮闭合后）
 * @depends node:fs / node:path / node:crypto、./week.js（只用于目录命名）
 *
 * @why 为什么它是"初始凭证"而不是"日志"：
 *      账里的每一笔（记账凭证的一行）都必须能附上凭证原件。
 *      所以这个文件必须：逐字原文、不改写、不摘要，且**自带 hash 供复核**。
 *
 * @why 为什么记录 hash：
 *      凭证的价值在"未被篡改"。文件头写 `正文hash`，
 *      任何人重算正文部分即可验证；这也让"清册销毁"有据可查。
 *
 * @why 为什么写入后不可变（契约 v1.3 决定 3）：
 *      旧实现 `.tmp` + `rename` 会**无条件覆盖**同名文件 —— 那是 bug。
 *      现在用「临时文件写满 + fsync + **原子发布**最终名（硬链接/确认不存在后 rename）」：
 *      · 已存在 → 读回重算正文 hash：同 hash 复用、异 hash 报 `ORIGINAL_CONFLICT` 停摆，绝不覆盖；
 *      · 进程在写到一半被 kill -9 → 只留 `.tmp-*` 半成品（隐藏名、读取端忽略），
 *        **最终名要么不存在、要么字节完整** —— 不会再有"半截凭证让下次写入永久停摆"。
 *      凭证是账的原件，原件被悄悄改一次，整本账的可审计性就归零了。
 *
 * @why v0.5 审计驱动的两条硬要求：
 *      · P0-5（审计 A-05）：工具参数/结果**不得静默截断** —— 展示层可截到 2000 码点，
 *        但必须给披露行（原始长度/附件/附件 sha256），且全量原文在同目录
 *        `<code> 原始事件.json` 附件里逐字可恢复（D11）。
 *      · P1-1（审计 A-06）：正文 hash（`## 1.`→EOF）不含 YAML，只比正文会让"改 YAML"
 *        逃过复核 —— 所以写入/复用必须同时核**完整文件 sha256**，并提供
 *        `verifyOriginal()` 供周记账"绑定"判定用。
 *
 * @why 为什么目录用第 3 级：
 *      与《架构图 A》一致：一级=交接表/清册，二级=月份（周记账+原文夹），三级=原文文件。
 *      原文最常增删，放最深处，避免把一级目录搞得很大。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCode } from './encoder.js';

const pad2 = (n) => String(n).padStart(2, '0');

// ============================================================================
// 0.0 越界闸门（审计② P2-11）
//
// @why 为什么写端也要防越界：
//      `code` 是文件名主键，直接拼进路径。只要放行一个含 `..\` 的 code，
//      凭证就会写到数据总库 root 之外（写端越界），审计/清册/周记账从此各自看不同的地方。
//      所以写端唯一口径：`parseCode(code)` 通过 + 目标必须落在 root 内（字面 + realpath 双判）。
//
// @why 为什么要 realpath：
//      字面路径判不出 junction / 符号链接：`root\2026年11月` 可以是真实指向 root 外的
//      junction，字面看仍在 root 内，实际写到了外面。Windows 建 junction 不需要管理员权限，
//      这条不是理论风险。
// ============================================================================

/** realpath（不存在/无权限返回 null，不抛）。 */
function realpathOrNull(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** p 是否严格在 dirAbs 之内（dirAbs 自身不算）。 */
function isInsideDir(dirAbs, p) {
  const rel = path.relative(dirAbs, p);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** p 是否等于 dirAbs 或在 dirAbs 之内（附件文件级判定用）。 */
function isSameOrInside(dirAbs, p) {
  return path.resolve(dirAbs) === path.resolve(p) || isInsideDir(path.resolve(dirAbs), p);
}

/**
 * 把路径解析成"真实路径的近似值"：最深**已存在**的祖先走 realpath，剩余尾巴原样接上。
 *
 * @why 目标目录在写之前通常还不存在（要 mkdir），直接 realpathSync(target) 会 ENOENT，
 *      于是 realpath 校验被静默跳过 —— 而 junction 逃逸恰好发生在"祖先已存在、叶子未创建"这一刻。
 *      所以必须先锚到已存在的祖先，再拼回尾巴，才能在建目录**之前**就判出越界。
 */
function resolveThroughExisting(p) {
  const abs = path.resolve(p);
  let cur = abs;
  for (;;) {
    const real = realpathOrNull(cur);
    if (real) {
      const tail = path.relative(cur, abs);
      return tail ? path.join(real, tail) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs; // 连盘根都解析不了：退回字面路径（字面判定已先做过）
    cur = parent;
  }
}

/**
 * 落盘前越界闸门：`target` 必须落在数据总库 `root` 之内。
 *
 * @throws {Error} err.code = 'ORIGINAL_BAD_ARGS'，err.kind = 'path-outside-root'
 */
function assertInside(root, target) {
  const rootAbs = path.resolve(String(root));
  const targetAbs = path.resolve(String(target));
  const fail = (detail) => {
    const err = new Error(
      'ORIGINAL_BAD_ARGS: 拒绝写到数据总库之外（凭证/附件必须落在 root 内）。' +
      ` root=${rootAbs} 目标=${targetAbs} 说明=${detail}`
    );
    err.code = 'ORIGINAL_BAD_ARGS';
    err.kind = 'path-outside-root';
    err.root = rootAbs;
    err.target = targetAbs;
    return err;
  };
  if (!isInsideDir(rootAbs, targetAbs)) throw fail('字面路径不在 root 内');
  const rootReal = resolveThroughExisting(rootAbs);
  const targetReal = resolveThroughExisting(targetAbs);
  if (!isInsideDir(rootReal, targetReal)) throw fail(`realpath 逃逸（real=${targetReal}）`);
}


function iso(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function hhmmss(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** YAML 单引号字符串：只转义单引号，路径用单引号避免反斜杠转义问题。 */
const yamlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 取消息里的文本块。 */
function textsOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
}

/**
 * 非文本内容块占位（决定 9 #9 / OR-26）。
 * image → `[图片]`；file → `[文件] {name}`。
 *
 * @why 凭证要保留"这里原本有一个非文本块"的事实，否则原文就不完整；
 *      但占位**不是用户原话**，只是位置标记。
 */
function nonTextPlaceholders(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'image') out.push('[图片]');
    else if (c.type === 'file') {
      const name = (c.attachment && c.attachment.name) || c.name || '';
      out.push(name ? '[文件] ' + name : '[文件]');
    }
  }
  return out;
}

// ============================================================================
// 0. 通用小工具：hash / 长度 / YAML 解析 / 截断
// ============================================================================

/** 展示块（工具参数 / 工具结果）在 Markdown 视图里的字符上限（P0-5/D11：2000 码点）。 */
const DISPLAY_BLOCK_LIMIT = 2000;

/** sha256（hex）。入参可以是 Buffer 或字符串；对字符串按 UTF-8 取字节。 */
function sha256Hex(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 按 Unicode 码点计字符数（不会把 emoji 的代理对拆成两个"字"）。 */
const charLength = (s) => [...String(s)].length;

/** 按 Unicode 码点截前 n 个字符（不会截断代理对）。 */
const sliceChars = (s, n) => [...String(s)].slice(0, n).join('');

/**
 * 「完整原文」的**完整文件** sha256（P1-1）。
 *
 * @param {string|Buffer} markdownOrBuffer
 * @returns {string} 64 位小写 hex
 *
 * @why 正文 hash（从 `## 1.` 到 EOF）管"内容"；完整文件 hash 管"整个凭证字节"。
 *      YAML 不在正文 hash 里，只比正文 hash 会让"改 YAML"逃过复核 ——
 *      所以要给台账/对账一个能覆盖 YAML 的指纹。计算对象必须是**磁盘原始字节**。
 */
export function originalFullHash(markdownOrBuffer) {
  return sha256Hex(markdownOrBuffer);
}

/** YAML 标量去引号（只处理单引号 `''` 转义与双引号；与产物渲染口径一致）。 */
function unquoteScalar(raw) {
  const s = String(raw === undefined ? '' : raw).trim();
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

// ============================================================================
// 0.1 原子写盘（2026-11-09 夜 / P0-3-resume 真因修复）
//
// @why 为什么必须改：原来的写法是 `openSync(target,'wx')` **直写 + fsync**。
//      进程在 write 中途被 kill -9 → 磁盘上留下**半截凭证文件**（缺 `## 1.` 正文锚点，
//      或者附件 JSON 半截）。下一轮同码写入走 `EEXIST` → 复核失败 → 抛
//      `ORIGINAL_CONFLICT` / `ATTACHMENT_CONFLICT` **永久停摆** ——
//      "重启后继续写"的承诺被一个半截文件击穿，而且账面上只看到"停摆"，
//      看不到"停摆的原因是一个写到一半的文件"。
//
// @why 为什么不是"读的时候修半截文件"：
//      半截是**写端**制造的，就该在写端让它不可能出现；事后修文件等于给
//      "文件被改过"开门缝（审计最忌讳）。凭证一旦发布必须字节完整、且不可覆盖。
//
// 三条不变量（写端）：
//   ① 临时名以 `.tmp-` 开头（**隐藏名 + 读取端只认最终名**：不会被孤儿扫描/周记账/对账误认成凭证）；
//   ② 先写满临时文件并 fsync，再用 `link`/`rename` **原子发布**最终名；
//      发布前崩溃 → 只留 `.tmp-*` 半成品（读取端忽略），**最终名要么不存在、要么字节完整**；
//   ③ 任何失败都 try/finally 清理临时文件；上次被 kill 留下的同目标残留，下次写入前先清掉。
// ============================================================================

/** 原子写临时文件的前缀（读取端必须忽略，见 `isOriginalTempName`）。 */
export const ORIGINAL_TMP_PREFIX = '.tmp-';

/** 判定"临时残留"的兜底年龄（毫秒）：名字里没有 pid 的旧格式才用；有 pid 一律按进程存活判。 */
const STALE_TMP_MIN_AGE_MS = 10 * 60 * 1000;

/** 进程是否还活着：`kill(pid,0)` 抛 ESRCH = 已死；其它错误（EPERM 等）按"活着"保守处理。 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === 'ESRCH');
  }
}

/**
 * 判断某个目录项是否是"原子写临时残留"。
 *
 * @param {string} name 目录项名（不含目录）
 * @returns {boolean}
 *
 * @why 读取端（对账/清册/孤儿扫描）必须能一句话判断"这不是凭证"：
 *      `.tmp-` 前缀是**隐藏名**且**不是任何最终文件名格式**，即使被 kill 留在磁盘上，
 *      也不会被当成完整原文/附件。
 */
export function isOriginalTempName(name) {
  return typeof name === 'string' && name.startsWith(ORIGINAL_TMP_PREFIX);
}

/** 目录 fsync（尽力而为：不支持目录 fsync 的文件系统静默跳过，不影响"已发布"的事实）。 */
function fsyncDirBestEffort(dir) {
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* Windows/部分 FS 不支持目录 fsync：忽略（数据文件本身已 fsync 过） */ } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 清掉同目录下**本目标**的历史原子写残留（上次进程被 kill -9 时 finally 没机会执行）。
 *
 * @returns {number} 清掉的个数
 *
 * @why 只清 `<前缀><本目标名>.` 开头的文件：不会误删别的目标的临时文件。
 * @why ★ 必须防"误删别人正在写的临时文件"（2026-11-09 夜加固）：
 *      临时名里带 `<pid>`；**写者进程已死（ESRCH）**才清；活着的一概不动
 *      （跨 root/多进程时，同一个目录里可能有另一个实例正在写）。
 *      名字不带 pid 的旧格式才退回"mtime 超过 10 分钟"作兜底；本进程自己的临时文件永不清。
 */
function cleanupStaleTmp(dir, finalName) {
  const prefix = `${ORIGINAL_TMP_PREFIX}${finalName}.`;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const rest = name.slice(prefix.length);
    const m = /^(\d+)-/.exec(rest);
    const pid = m ? Number(m[1]) : NaN;
    if (pid === process.pid) continue; // 本进程正在写的，绝不清
    const stale = Number.isInteger(pid)
      ? !isPidAlive(pid)                                     // 写者已死 → 确定是残留
      : (Date.now() - st.mtimeMs > STALE_TMP_MIN_AGE_MS);    // 旧格式无 pid → 只用年龄兜底
    if (!stale) continue;                                    // 别人还活着正在写 → 不动
    try { fs.unlinkSync(full); n++; } catch { /* 清不掉不算错 */ }
  }
  return n;
}

/**
 * **原子 + 排他**创建文件（写入端唯一落盘原语）。
 *
 * @param {string} dir 目标目录（必须已存在）
 * @param {string} finalName 最终文件名（不含目录）
 * @param {string} content 完整内容
 * @returns {void}
 * @throws {Error} `err.code === 'EEXIST'` = 最终名已存在（**不覆盖**，调用方走"复用/冲突"复核）；
 *                 其它错误 = 写失败（临时文件已清理，最终名未被创建）
 */
function writeFileAtomicExclusive(dir, finalName, content) {
  cleanupStaleTmp(dir, finalName); // 先收拾上次崩溃的残留（构造上永远是半成品）
  const tmpName = `${ORIGINAL_TMP_PREFIX}${finalName}.${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(dir, tmpName);
  const target = path.join(dir, finalName);
  let fd = -1;
  let published = false;
  try {
    fd = fs.openSync(tmp, 'wx');                       // 临时名也排他：不会覆盖任何东西
    fs.writeSync(fd, String(content), null, 'utf8');
    fs.fsyncSync(fd);                                  // ★ 数据先落地，再发布名字
    fs.closeSync(fd);
    fd = -1;
    try {
      // 硬链接 = "最终名出现"的原子操作；目标已存在 → EEXIST，绝不覆盖。
      fs.linkSync(tmp, target);
      published = true;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        const err = new Error(`EEXIST: 目标已存在，不覆盖：${target}`);
        err.code = 'EEXIST';
        throw err;
      }
      // 少数文件系统不支持硬链接（FAT/exFAT/部分网络盘）→ 单写者锁下退化为"确认不存在再 rename"。
      // rename 在目标已存在时的行为各平台不一（Windows 会覆盖），所以必须先确认不存在。
      if (fs.existsSync(target)) {
        const err = new Error(`EEXIST: 目标已存在，不覆盖：${target}`);
        err.code = 'EEXIST';
        throw err;
      }
      fs.renameSync(tmp, target);
      published = true;
    }
    fsyncDirBestEffort(dir);
  } catch (e) {
    if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    if (!published) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ } }
    throw e;
  } finally {
    // 发布成功后临时名只是同一 inode 的第二个名字：删掉它，目录保持干净（失败也不掩盖主错误）
    if (published) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

// ============================================================================
// v0.9.3-re1 写后自检：可证的最小代价（fsync + stat.size 必做；全量回读仅 strict）
// ============================================================================

/** 抽样回读的单段字节数（头/尾各一段）。 */
const READBACK_SAMPLE_BYTES = 4096;

/**
 * 写后自检（只读；不写盘、不改盘）。
 *
 * 口径（v0.9.3-re1 读放大修复）：
 *   · **必做**：`stat.size` 与待写字节数全等（截断/多写立刻暴露）。
 *     数据落盘的 fsync 已在 `writeFileAtomicExclusive` 内完成（先 fsync 临时文件、再原子发布最终名），
 *     这里不重复整文件回读。
 *   · 默认 **sampled**：只回读头/尾各 ≤4 KiB + 全文件大小。能抓住截断、错位、编码错误这类
 *     "结构性"坏写；抓不到"中间一段被改、头尾正常"的极端损坏 —— 所以返回 `mode:'sampled'`，
 *     **绝不冒充全验**。
 *   · `strict:true` → **full**：读回全部字节、重算完整 sha256 比对（旧行为），返回 `mode:'full'`。
 *
 * @param {string} file 最终名绝对路径
 * @param {string} content 内存中的待写内容
 * @param {number} expectedBytes 待写字节数（utf8）
 * @param {string} expectedFullHash 待写内容的完整 sha256（64 hex）
 * @param {boolean} strict 是否全量回读
 * @returns {{ok:boolean, mode:'full'|'sampled', bytes:number, problems:string[], sampledBytes:number, raw:Buffer|null}}
 */
function verifyWrittenFile(file, content, expectedBytes, expectedFullHash, strict) {
  const out = {
    ok: false,
    mode: strict === true ? 'full' : 'sampled',
    bytes: 0,
    problems: [],
    sampledBytes: 0,
    raw: null,
  };
  let st;
  try { st = fs.statSync(file); } catch { out.problems.push('STAT_FAILED'); return out; }
  out.bytes = st.size;
  if (st.size !== expectedBytes) out.problems.push('SIZE_MISMATCH');
  if (strict === true) {
    let raw;
    try { raw = fs.readFileSync(file); } catch { out.problems.push('READ_FAILED'); return out; }
    out.bytes = raw.length;
    if (raw.length !== expectedBytes) out.problems.push('SIZE_MISMATCH');
    if (sha256Hex(raw) !== expectedFullHash) out.problems.push('FULL_HASH_MISMATCH');
    out.raw = raw;
    out.ok = out.problems.length === 0;
    return out;
  }
  // sampled：头/尾各 ≤4 KiB，按**字符边界**切片后再截字节（utf8 边界安全）。
  const n = expectedBytes > 0 ? Math.min(READBACK_SAMPLE_BYTES, expectedBytes) : 0;
  const headBuf = Buffer.from(content.slice(0, READBACK_SAMPLE_BYTES), 'utf8');
  const headWant = headBuf.subarray(0, Math.min(n, headBuf.length));
  const tailBuf = Buffer.from(content.slice(-READBACK_SAMPLE_BYTES), 'utf8');
  const tailWant = tailBuf.subarray(Math.max(0, tailBuf.length - n));
  const check = (want, position, tag) => {
    if (!want.length) return;
    const readBuf = Buffer.alloc(want.length);
    let got = 0;
    let fd = -1;
    try {
      fd = fs.openSync(file, 'r');
      got = fs.readSync(fd, readBuf, 0, want.length, position);
    } catch {
      out.problems.push('READ_FAILED');
    } finally {
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    if (got !== want.length) { out.problems.push(tag + '_SHORT'); return; }
    if (!readBuf.equals(want)) out.problems.push(tag + '_MISMATCH');
    out.sampledBytes += got;
  };
  check(headWant, 0, 'HEAD');
  // 小文件（≤4 KiB）头段已覆盖全文，尾段不再重复读（少一次系统调用，不改变"抽样"语义）
  if (expectedBytes > n) check(tailWant, expectedBytes - tailWant.length, 'TAIL');
  out.ok = out.problems.length === 0;
  return out;
}

/**
 * 解析「完整原文」的 YAML 前置块（只取标量与键顺序，够复核身份字段用）。
 *
 * @param {string} markdown
 * @returns {{fields:Object<string,string>, keyOrder:string[], startLine:number, endLine:number}|null}
 *          不是 `---` 开头 / 没有结束分隔线 → null
 *
 * @why verifyOriginal 要核「YAML 身份字段」：编码、名称、正文hash 等。
 *      不引 YAML 库（零依赖底线），只按产物自己的渲染格式（`键: 值` 单行）解析。
 */
export function originalFrontMatter(markdown) {
  if (typeof markdown !== 'string' || !markdown.startsWith('---')) return null;
  const lines = markdown.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null;
  const fields = {};
  const keyOrder = [];
  for (let i = 1; i < end; i++) {
    const m = /^([^\s#][^:]*):(.*)$/.exec(lines[i]);
    if (!m) continue;
    const k = m[1].trim();
    keyOrder.push(k);
    fields[k] = unquoteScalar(m[2]);
  }
  return { fields, keyOrder, startLine: 1, endLine: end };
}

/**
 * 把一个可能超长的**展示块**（工具参数 / 工具结果）压到 2000 字符以内。
 *
 * @param {string} text 原始内容（完整，不截断入参）
 * @param {{seq:number|null, tool:string, field:string, truncations:object[]}} ctx
 * @returns {{shown:string, truncated:boolean, chars:number, bytes:number, sha256:string, info?:object}}
 *
 * @why P0-5 / D11（审计 A-05）：v0.4 直接 `.slice(0, 2000)` —— 尾部静默丢失、无披露，
 *      而文件头却写着"逐字原文，不改写、不摘要"，是最严重的自相矛盾。
 *      现在：≤2000 码点原样保留；>2000 码点只展示前 2000，**紧接一行**披露
 *      `> [截断] 原始长度=<N>字符 附件=<附件文件名> sha256=<附件sha256>`，
 *      全量原文在同目录 `<code> 原始事件.json` 里，可逐字恢复（含中文/emoji）。
 * @why 按 Unicode 码点而不是 UTF-16 码元：不能把 emoji 的代理对从中间拆开
 *      （半个代理对落盘就是坏字符，"逐字恢复"就无从谈起）。
 */
function clampDisplayText(text, ctx) {
  const full = String(text === undefined || text === null ? '' : text);
  const chars = charLength(full);
  const bytes = Buffer.byteLength(full, 'utf8');
  const sha256 = sha256Hex(full);
  if (chars <= DISPLAY_BLOCK_LIMIT) {
    return { shown: full, truncated: false, chars, bytes, sha256 };
  }
  const info = {
    seq: Number.isInteger(ctx.seq) ? ctx.seq : null,
    tool: ctx.tool || '',
    field: ctx.field || 'block',
    shownChars: DISPLAY_BLOCK_LIMIT,
    originalChars: chars,
    originalBytes: bytes,
    sha256,
  };
  ctx.truncations.push(info);
  return {
    shown: sliceChars(full, DISPLAY_BLOCK_LIMIT),
    truncated: true,
    chars,
    bytes,
    sha256,
    info,
  };
}

/**
 * 取出工具调用的"参数内容"（展示/披露口径用）。
 *
 * @param {string} argsText 事件的 `data.arguments`（DSH 里通常是 JSON 字符串）
 * @returns {{content:string, decoded:boolean, raw:string}}
 *
 * @why 审计 P0-5 的"工具参数 N 字符"指**用户真正传的那段内容**，而 `arguments`
 *      往往是 `{"command":"…"}` 这样的 JSON 外壳。展示/披露必须按内容计长，
 *      否则 4517 字的参数会被 JSON 外壳撑成 4532，披露数字对不上源参数。
 *      · 能解析出唯一字符串（或最长字符串）→ 用那段内容；
 *      · 不是 JSON / 没有字符串字段 → 整块就是参数。
 */
function toolArgumentContent(argsText) {
  const raw = String(argsText === undefined || argsText === null ? '' : argsText);
  try {
    const parsed = JSON.parse(raw);
    const strings = [];
    const walk = (v) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) for (const x of v) walk(x);
      else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(parsed);
    if (strings.length === 1) return { content: strings[0], decoded: true, raw };
    if (strings.length > 1) {
      // 多字段：取最长字符串作为"参数内容"（其余字段仍逐字保存在附件事件里）。
      let best = strings[0];
      for (const s of strings) if (charLength(s) > charLength(best)) best = s;
      return { content: best, decoded: true, raw };
    }
  } catch { /* 不是 JSON：整块就是参数 */ }
  return { content: raw, decoded: false, raw };
}

/** 工具参数展示文本：未截断时按"原样"（JSON 外壳也保留），截断时展示内容前缀。 */
function displayArgsText(argInfo, shown) {
  if (shown.truncated) return shown.shown;
  return argInfo.decoded && argInfo.raw !== argInfo.content ? argInfo.raw : argInfo.content;
}

/**
 * 截断披露行（D11 逐字格式，必须**紧接**在被截断的展示块之后）。
 *
 * @param {{chars:number}} shown clampDisplayText 的结果
 * @param {{attachmentName:string, attachmentSha256:string}} ctx
 * @returns {string} 形如 `> [截断] 原始长度=4517字符 附件=20261108-… 原始事件.json sha256=<64hex>`
 */
function truncationDisclosure(shown, ctx) {
  return `> [截断] 原始长度=${shown.chars}字符 附件=${ctx.attachmentName} sha256=${ctx.attachmentSha256}`;
}

/**
 * 生成"原始事件附件"（P0-5 方案 B / 契约 D11）。
 *
 * 形态（D11 决定）：`<code> 原始事件.json`，内容是**该 Turn 事件范围全部事件的原始 JSON 行**
 * （一事件一行、不包装、不过滤、键序按原对象、LF 结尾；行数 == 范围内事件数）。
 *
 * @param {{events:object[], code:string}} p
 * @returns {{name:string, content:string, sha256:string, bytes:number, eventsCount:number}|null}
 *
 * @why 为什么是"行"而不是一个 JSON 对象包一层：
 *      附件要能**逐字恢复**事件（尤其被截断的 tool/call arguments / tool/result 正文），
 *      一行一事件 = 与 DSH 会话文件本身同构，取第 N 行即可对照 seq；
 *      包一层 JSON 会引入美化/转义差异，反而破坏"原样"。
 * @why 附件本身不写自己的 sha256（自指会让 hash 永远算不对）：
 *      sha256/长度由台账 `attachment:{name,sha256,bytes}` 与正文披露行承载，
 *      任何人可对附件文件重算 sha256 复核。
 */
function buildEventsAttachment({ events, code }) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const lines = events.map((ev) => JSON.stringify(ev));
  const content = lines.join('\n') + '\n';
  return {
    name: `${code} 原始事件.json`,
    content,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    eventsCount: lines.length,
  };
}

/**
 * 渲染一轮的全文 markdown。
 *
 * @param {object} p
 * @param {object[]} p.events 该轮的事件（含 turn/start、turn/end）
 * @param {object} p.turn {turn, startMs, endMs, reason}
 * @param {string} p.code 32 位编码
 * @param {string} p.sid 完整会话 id
 * @param {string} p.sessKey 13 位会话键
 * @param {number} p.seq 会话内序号
 * @param {number} [p.offsetMinutes]
 * @param {string} [p.generator]
 * @returns {{markdown:string, bodyHash:string, fullHash:string, shadowed:number, fileCount:number,
 *            truncations:object[], attachment:{name:string, content:string, sha256:string,
 *            bytes:number, eventsCount:number}|null}}
 */
export function renderOriginal({ events, turn, code, sid, sessKey, seq, offsetMinutes = 480, generator = 'dsh-dialog-ledger-v0.4/original' }) {
  const list = Array.isArray(events) ? events : [];
  const sorted = [...list].sort((a, b) => (a.seq || 0) - (b.seq || 0));

  /** P0-5：展示层截断登记（会写进返回值的 truncations）。 */
  const truncations = [];
  // turn 归一：测试/旧调用可能只传轮次号；缺字段按 0 / 空处理，绝不让渲染抛错。
  const turnInfo = turn && typeof turn === 'object'
    ? turn
    : { turn: Number.isInteger(turn) ? turn : null, startMs: 0, endMs: 0, reason: '' };

  // P0-5/D11：先构造原始事件附件 —— 截断披露行要引用附件名与其 sha256，
  // 所以附件必须在渲染正文（工具节）之前就算好。
  const attachment = buildEventsAttachment({ events: sorted, code });
  const attachmentName = attachment ? attachment.name : `${code} 原始事件.json`;
  const attachmentSha256 = attachment ? attachment.sha256 : '';

  const skipKinds = new Map(); // 被过滤的 user/message 按 kind 计数
  const userLines = [];
  const assistantLines = [];
  const toolLines = [];
  const stepLines = [];

  // tool/call 与 tool/result 的配对：优先用 sourceEventSeqs，退化为顺序配对
  const calls = new Map(); // seq → {name, args}
  const results = [];

  for (const ev of sorted) {
    if (!ev || typeof ev.type !== 'string') continue;
    const time = typeof ev.time === 'number' ? ev.time : 0;
    const stamp = `[seq ${ev.seq}] ${hhmmss(time, offsetMinutes)}`;

    if (ev.type === 'user/message') {
      const kind = ev.data && ev.data.source && ev.data.source.kind;
      if (kind && kind !== 'user') {
        skipKinds.set(kind, (skipKinds.get(kind) || 0) + 1);
        continue;
      }
      const parts = textsOf(ev.data && ev.data.content);
      const nonText = nonTextPlaceholders(ev.data && ev.data.content);
      const blockLines = parts.concat(nonText);
      if (blockLines.length) userLines.push(`${stamp}\n\n${blockLines.join('\n\n')}`);
      continue;
    }

    if (ev.type === 'assistant/message') {
      const content = ev.data && ev.data.message && ev.data.message.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type === 'text' && c.text) {
          assistantLines.push(`${stamp}\n\n${c.text}`);
        } else if (c.type === 'thinking' && c.thinking) {
          assistantLines.push(`${stamp}\n\n<details><summary>思考</summary>\n\n${c.thinking}\n\n</details>`);
        } else if (c.type === 'tool_use') {
          assistantLines.push(`${stamp} → 调用工具 \`${c.name || '?'}\`（见第 3 节）`);
        } else if (c.type === 'image') {
          assistantLines.push(`${stamp}\n\n[图片]`);
        } else if (c.type === 'file') {
          const nm = (c.attachment && c.attachment.name) || c.name || '';
          assistantLines.push(`${stamp}\n\n` + (nm ? '[文件] ' + nm : '[文件]'));
        }
      }
      continue;
    }

    if (ev.type === 'tool/call') {
      const name = (ev.data && ev.data.name) || '?';
      const args = ev.data && ev.data.arguments;
      calls.set(ev.seq, { name, args });
      continue;
    }

    if (ev.type === 'tool/result') {
      results.push(ev);
      continue;
    }

    if (ev.type === 'step/start' || ev.type === 'step/end') {
      const d = ev.data || {};
      stepLines.push(`[seq ${ev.seq}] turn ${d.turn ?? '?'} / step ${d.step ?? '?'} ｜ ${ev.type === 'step/start' ? '起' : '止'} ${hhmmss(time, offsetMinutes)}`);
    }
  }

  // 工具调用与结果的配对：result 的 sourceEventSeqs 指向 call
  for (const res of results) {
    const refs = res.sourceEventSeqs || (res.sourceEventSeqs === undefined && res.data && res.data.sourceEventSeqs);
    const refSeq = Array.isArray(refs) && refs.length ? refs[refs.length - 1] : null;
    const call = refSeq !== null ? calls.get(refSeq) : null;
    const isError = !!(res.data && res.data.message && res.data.message.isError);
    const body = textsOf(res.data && res.data.message && res.data.message.content)
      .concat(nonTextPlaceholders(res.data && res.data.message && res.data.message.content))
      .join('\n');
    const head = `[seq ${res.seq}] ${hhmmss(typeof res.time === 'number' ? res.time : 0, offsetMinutes)}`;
    // D11：工具结果正文也是"展示块"，同样 2000 码点上限 + 紧接披露行。
    const shownBody = clampDisplayText(body, { seq: res.seq, tool: call ? call.name : '', field: 'result', truncations });
    const bodyDisclosure = shownBody.truncated
      ? '\n\n' + truncationDisclosure(shownBody, { attachmentName, attachmentSha256 })
      : '';
    if (call) {
      // P0-5/INV-23：按"参数内容"（JSON 外壳内的实参）计长与披露，数字才对得上源参数。
      const argInfo = toolArgumentContent(call.args);
      const shownArgs = clampDisplayText(argInfo.content, { seq: refSeq, tool: call.name, field: 'arguments', truncations });
      const argsText = displayArgsText(argInfo, shownArgs);
      const argsDisclosure = shownArgs.truncated
        ? '\n' + truncationDisclosure(shownArgs, { attachmentName, attachmentSha256 })
        : '';
      toolLines.push(`${head} 工具 \`${call.name}\`\n\n参数：\n\n\`\`\`json\n${argsText}\n\`\`\`${argsDisclosure}\n\n结果：${isError ? 'error' : 'ok'}\n\n${shownBody.shown}${bodyDisclosure}`);
      calls.delete(refSeq);
    } else {
      toolLines.push(`${head} 工具结果（未配对）｜${isError ? 'error' : 'ok'}\n\n${shownBody.shown}${bodyDisclosure}`);
    }
  }
  // 没有结果的调用也保留（不能因为没返回就吞掉）
  for (const [seq, call] of calls) {
    const argInfo = toolArgumentContent(call.args);
    const shownArgs = clampDisplayText(argInfo.content, { seq, tool: call.name, field: 'arguments', truncations });
    const argsText = displayArgsText(argInfo, shownArgs);
    const argsDisclosure = shownArgs.truncated
      ? '\n' + truncationDisclosure(shownArgs, { attachmentName, attachmentSha256 })
      : '';
    toolLines.push(`[seq ${seq}] 工具 \`${call.name}\` ｜ 无结果记录\n\n参数：\n\n\`\`\`json\n${argsText}\n\`\`\`${argsDisclosure}`);
  }

  // ★ 被遮蔽事件数（契约 v1.3 §3.3 / OR-12）：`|E ∩ shadowed|`，**禁止硬编码 0**。
  //   shadowed = shadowedSeqs[] ∪ shadowedRange 区间内全部 seq（跨所有携带这两字段的事件收集）；
  //   E = 本文件覆盖的事件集合。压缩不删数据，被遮蔽事件本身就应出现在正文里。
  //   ★ 不限定事件 type：实测会话里除 `compaction/summary` 外，`compaction/prune` 也带这两字段
  //     （验收夹具即用 prune）。只认一种 type 会把真实遮蔽数算成 0。
  const shadowedSeqSet = new Set();
  for (const ev of sorted) {
    if (!ev || !ev.data || typeof ev.data !== 'object') continue;
    const d = ev.data;
    if (Array.isArray(d.shadowedSeqs)) {
      for (const s of d.shadowedSeqs) if (Number.isInteger(s)) shadowedSeqSet.add(s);
    }
    const r = d.shadowedRange;
    if (r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end >= r.start &&
        r.end - r.start <= 200000) {
      for (let s = r.start; s <= r.end; s++) shadowedSeqSet.add(s);
    }
  }
  let shadowedCount = 0;
  for (const ev of sorted) {
    if (ev && Number.isInteger(ev.seq) && shadowedSeqSet.has(ev.seq)) shadowedCount++;
  }

  const noteLines = [];
  // 备注四类内容顺序（模板 §3.4）：文件清单状态 → 注入清单 → 异常 → 人工补注。
  // v1.3 文件清单采集未启用 → 必须显式标注，且与 `文件数: 0` + `文件: []` 成对出现（OR-17）。
  noteLines.push('- 文件清单：未启用（真实采集排 v0.5）');
  if (skipKinds.size) {
    const parts = [...skipKinds.entries()].map(([k, n]) => `${k} ×${n}`);
    noteLines.push('注入清单（已过滤，未计入正文）：' + parts.join(' ｜ '));
  }

  const section = (title, lines, empty = '—') => `## ${title}\n\n${lines.length ? lines.join('\n\n') : empty}\n`;
  const body = [
    section('1. user/message', userLines),
    section('2. assistant/message', assistantLines),
    section('3. tool/call + tool/result', toolLines),
    section('4. step/start + step/end', stepLines),
    section('5. 备注', noteLines),
  ].join('\n');

  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  const seqFrom = sorted.length ? sorted[0].seq : 0;
  const seqTo = sorted.length ? sorted[sorted.length - 1].seq : 0;

  // 标识字段拆分（OR-05）：`会话短ID` 必须是 **12 位** s12，代差单列。
  //   旧实现把 13 位 sessKey 整串写进 `会话短ID`，且没有 `代次` 键 —— 不合契约。
  const s12 = String(sessKey || '').slice(0, 12);
  const gen = String(sessKey || '').slice(12);

  const fm = [
    '---',
    // ★ C11（v0.9.1）：md **头三行**必须明确写「视图非全集」+ 省略/遮蔽条数（数值口径 = YAML「被遮蔽事件数」）。
    //   `#` 开头 = YAML 注释：不进键序（OR-03 仍 19 键）、不进正文 hash（正文从 `## 1.` 起算），
    //   但人打开文件、或验收脚本读 `split('\n').slice(0,3)` 都第一眼看到。
    `# 视图非全集：本文件只含本轮「事件范围」内的事件；省略 ${shadowedCount} 条（口径=YAML「被遮蔽事件数」，压缩不删数据）`,
    `编码: ${yamlStr(code)}`,
    `名称: ${yamlStr(code + ' 完整原文')}`,
    `会话ID: ${yamlStr(sid)}`,
    `会话短ID: ${yamlStr(s12)}`,
    `代次: ${yamlStr(gen)}`,
    `本轮序号: ${seq}`,
    `对话开始: ${yamlStr(iso(turnInfo.startMs, offsetMinutes))}`,
    `对话结束: ${yamlStr(iso(turnInfo.endMs || turnInfo.startMs, offsetMinutes))}`,
    `结束原因: ${yamlStr(turnInfo.reason || '')}`,
    '委托人: user',
    '执行: 日常会话记录插件（Tool）',
    '记录: 系统（Cordis）',
    `生成器: ${yamlStr(generator)}`,
    `事件范围: ${yamlStr('seq ' + seqFrom + ' – ' + seqTo)}`,
    `被遮蔽事件数: ${shadowedCount}`,
    `正文hash: ${yamlStr(bodyHash)}`,
    `正文hash算法: ${yamlStr('sha256（对『## 1.』至文件末尾的全部字节计算）')}`,
    '文件数: 0',
    '文件: []',
    '---',
    '',
    `# ${code} 完整原文`,
    '',
    '> 本文件为「初始凭证」：逐字原文，不改写、不摘要；`正文hash` 覆盖第 1 节标题至文件末尾（含本行之后的全部正文）。' +
      `★ 视图非全集：本文件只含本轮「事件范围」内的事件，省略 ${shadowedCount} 条（口径=YAML「被遮蔽事件数」，压缩不删数据；` +
      '被遮蔽事件的原文仍在正文与附件里，可逐字复核）。' +
      '超长工具参数在展示层可能被**显式截断**（正文有截断标记与原始长度），逐字原文见同目录事件附件。',
    '',
    body,
  ];

  const markdown = fm.join('\n');
  return {
    markdown,
    bodyHash,
    // P1-1：完整文件 sha256（覆盖 YAML），供台账 `docFileSha256` 与周记账"绑定"复核。
    fullHash: sha256Hex(markdown),
    shadowed: shadowedCount,
    fileCount: 0,
    // P0-5/D11：展示层截断记录 + 原始事件附件（调用方 writeOriginal 时一并落盘）。
    truncations,
    attachment,
  };
}

/**
 * 原文文件的第 3 级目录：`{年}年{月}月/{月}月总“完整原文”/`
 *
 * @why 用中文引号：Windows 不允许文件名里出现半角双引号，但中文引号合法。
 */
export function originalDir(root, y, m) {
  const mm = pad2(m);
  return path.join(root, `${y}年${mm}月`, `${mm}月总“完整原文”`);
}

/** 原文文件的相对路径（相对数据总库），用于写进台账/周记账。 */
export function originalRelPath(y, m, code) {
  const mm = pad2(m);
  return path.join(`${y}年${mm}月`, `${mm}月总“完整原文”`, `${code} 完整原文.md`);
}

// ============================================================================
// 正文 hash 与「凭证不可变」的落盘
// ============================================================================

/**
 * 正文锚点：契约 v1.3 决定 3 的口径 —— `正文 = 从 '## 1.' 到文件末尾`。
 *
 * @why 用字符串锚点而不是"跳过 YAML 前置块"：
 *      前置块里也可能出现 '## ' 字样（例如「文件」字段值），而 '## 1.' 是
 *      五节正文的固定第一节标题，只在正文开头出现一次。锚点唯一，才不会被误切。
 */
const BODY_ANCHOR = '## 1.';

/**
 * 从一份「完整原文」markdown 里切出正文（从 '## 1.' 到末尾，含该标题）。
 *
 * @param {string} markdown
 * @returns {string} 正文；入参不是字符串或找不到锚点时返回 ''（调用方必须当错误处理）
 */
export function originalBodyOf(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  if (markdown.startsWith(BODY_ANCHOR)) return markdown;
  // ★ 必须按**行首**匹配：YAML 里「正文hash算法」的值本身含有 '## 1.'
  //   （`sha256（对『## 1.』至文件末尾…）`），按裸子串搜索会命中 YAML 行内，
  //   导致正文从 YAML 开始切片 → hash 永远不一致 → 写盘自检全部失败。
  const idx = markdown.indexOf('\n' + BODY_ANCHOR);
  return idx === -1 ? '' : markdown.slice(idx + 1);
}

/**
 * 重算一份「完整原文」的正文 sha256。
 *
 * @param {string} markdown
 * @returns {string} 64 位小写 hex；无正文锚点时返回 ''（= 不可复核）
 *
 * @why 读回已存在的文件、重算它自己的正文 hash，是"同 hash 复用 / 异 hash 报冲突"
 *      的裁判依据。**绝不能**拿来跟 YAML 里写的 `正文hash` 比 ——
 *      YAML 可以被人改，正文重算才是事实。
 */
export function originalBodyHash(markdown) {
  const body = originalBodyOf(markdown);
  if (!body) return '';
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * 造一个「同名凭证已存在且内容不同」的冲突错误。
 *
 * @param {string} file
 * @param {string} existingHash 空串 = 旧文件连正文锚点都没有（不可复核）
 * @param {string} incomingHash
 * @param {string} [detail]
 * @returns {Error} err.code === 'ORIGINAL_CONFLICT'
 *
 * @why 错误信息必须同时给出【路径】和【两个 hash】：
 *      停摆之后人要能立刻回答"是哪一份、差多少"；只给一句"冲突"等于让人重跑一遍排障。
 */
function conflictError(file, existingHash, incomingHash, detail = '') {
  const oldSide = existingHash || '不可复核（旧文件里找不到 ' + yamlStr(BODY_ANCHOR) + ' 锚点）';
  const msg = 'ORIGINAL_CONFLICT: 凭证已存在且正文不同，拒绝覆盖。' +
    ` 路径=${file} 已有正文hash=${oldSide} 新正文hash=${incomingHash}` +
    (detail ? ` 说明=${detail}` : '');
  const err = new Error(msg);
  err.code = 'ORIGINAL_CONFLICT';
  err.path = file;
  err.existingHash = existingHash;
  err.incomingHash = incomingHash;
  return err;
}

/**
 * 写一份原文。**凭证写入后不可变** —— 这是本文件最硬的一条规则。
 *
 * 行为（契约 v1.3 决定 3 + 审计 P0-5/P1-1 + 契约 D11）：
 *   ① 文件不存在 → `fs.openSync(file, 'wx')` 排他创建并写入，写后**回读自检**
 *      正文 hash + **完整文件 hash** + 字节数；
 *   ② 文件已存在 → 读回、重算正文 hash 与完整文件 hash：
 *      · 两者都相同 → 直接复用（不碰一个字节），返回 `reused: true`；
 *      · 正文相同但完整文件不同（YAML/头部被改或渲染器版本变化）→ 抛
 *        `ORIGINAL_CONFLICT`（kind=full-hash-mismatch），**拒绝静默复用**；
 *      · 正文不同 → 抛 `ORIGINAL_CONFLICT`，**绝不覆盖**。
 *   ③ 传了 `attachment`（D11 原始事件附件）→ **先写附件**（同样 `wx` 排他），再写正文。
 *
 * @param {object} p
 * @param {string} p.root 数据总库根目录
 * @param {number} p.y 年
 * @param {number} p.m 月
 * @param {string} p.code 32 位规范编码（= 文件名主键）；非规范（含 `..\`/分隔符）→ ORIGINAL_BAD_ARGS
 * @param {number} p.y 年（整数 1970–9999）
 * @param {number} p.m 月（整数 1–12）
 * @param {string} p.markdown 完整 markdown（含 YAML 前置块与五节正文）
 * @param {string} [p.bodyHash] 渲染时算出的正文 hash；传了就做写前自检（不一致拒绝写盘）
 * @param {string} [p.fullHash] 渲染时算出的完整文件 hash；传了就做写前自检（P1-1）
 * @param {{name:string, content:string, sha256:string}} [p.attachment]
 *        renderOriginal().attachment —— 原始事件附件（逐字恢复超长工具参数/结果用）
 * @param {boolean} [p.strict=false] 写后自检是否**全量回读**（true → 读回全部字节重算 sha256；
 *        默认 false → fsync + stat.size + 头/尾各 4 KiB 抽样；返回 verify 字段明示）
 * @returns {{path:string, rel:string, bytes:number, bodyHash:string, fullHash:string,
 *            reused:boolean, verify:'full'|'sampled', attachment:object|null}}
 *          `verify` 只描述**本次写后自检做到哪一档**：'full'=全量回读重算；'sampled'=大小+头尾抽样。
 *          它不是"复核通过"的徽章 —— 坏写仍会抛 ORIGINAL_VERIFY_FAILED；只是不冒充全验。
 *
 * @why 为什么不再用 `.tmp` + rename：
 *      旧实现无条件 rename，等于把"同名凭证"静默覆盖 —— 那正是要焊死的 bug。
 *      现在创建走 `wx`（文件系统级排他，两个进程同时写也只有一个能成功），
 *      已存在则只读复核，任何不一致都变成一次**可见的抛错**。
 *
 * @why 为什么要写后自检（v0.9.3-re1 改为"可证的最小代价"）：
 *      磁盘满、编码错误、杀进程都可能留下"create 成功但内容不全"的文件。
 *      落盘原语已做 **fsync + 原子发布**（最终名只有"不存在/字节完整"两态），
 *      所以写后自检的必做项是 `stat.size` 与待写字节数全等；默认再抽样回读头/尾各 4 KiB
 *      抓截断/错位/编码错误。全量回读（旧行为）只在 `strict:true` 时做 ——
 *      整文件回读是纯读放大（tick 读盘 = 写放大一倍），默认不再做；
 *      但返回里用 `verify:'sampled'|'full'` 明确标注，**绝不把抽样冒充成全验**。
 *      坏凭证仍当场报 `ORIGINAL_VERIFY_FAILED`。
 *
 * @why 为什么返回 bodyHash / fullHash：
 *      复用分支必须返回**磁盘上那份文件**的 hash（相等才会走到复用），
 *      让台账里的 `docSha256`/`docFileSha256` 永远来自实际落盘内容，而不是内存里的渲染结果。
 *      正文 hash 管内容、完整文件 hash 管整个凭证（含 YAML），两者缺一不可（P1-1）。
 *
 * @throws {Error} err.code = 'ORIGINAL_CONFLICT' | 'ORIGINAL_VERIFY_FAILED' |
 *                 'ORIGINAL_NO_BODY' | 'ORIGINAL_BAD_ARGS'（含 code 非法 / 越界路径，kind 标明原因） |
 *                 'ATTACHMENT_CONFLICT' | 'ATTACHMENT_VERIFY_FAILED'
 */
export function writeOriginal({ root, y, m, code, markdown, bodyHash, fullHash, attachment, strict = false } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    const err = new Error('ORIGINAL_BAD_ARGS: root 必须是非空字符串');
    err.code = 'ORIGINAL_BAD_ARGS';
    throw err;
  }
  // ① 编码必须是 32 位规范编码（审计② P2-11）：
  //    code 直接进文件名（`${code} 完整原文.md`），旧实现只查"非空字符串"，
  //    于是 `..\..\..\evil` 这类 code 会把凭证写到 root 之外。
  //    这里用 encoder 的 parseCode（唯一编码口径）判结构，非法立即拒绝。
  const parsedCode = parseCode(code);
  if (!parsedCode) {
    const err = new Error(
      'ORIGINAL_BAD_ARGS: code 必须是 32 位规范编码（YYYYMMDD-SSSSSSSSSSSS-D-NNNNNNNN），' +
      `实际=${JSON.stringify(String(code === undefined ? '' : code)).slice(0, 100)}`
    );
    err.code = 'ORIGINAL_BAD_ARGS';
    err.kind = 'bad-code';
    err.incomingCode = String(code === undefined ? '' : code).slice(0, 100);
    throw err;
  }
  // ② 年月是第 2 级目录名的一部分：同样必须是整数，否则 `y` 里带分隔符也能改目录层级。
  if (!Number.isInteger(y) || y < 1970 || y > 9999) {
    const err = new Error(`ORIGINAL_BAD_ARGS: y 必须是 1970–9999 的整数，实际=${String(y)}`);
    err.code = 'ORIGINAL_BAD_ARGS';
    err.kind = 'bad-ym';
    throw err;
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    const err = new Error(`ORIGINAL_BAD_ARGS: m 必须是 1–12 的整数，实际=${String(m)}`);
    err.code = 'ORIGINAL_BAD_ARGS';
    err.kind = 'bad-ym';
    throw err;
  }
  if (typeof markdown !== 'string' || markdown.length === 0) {
    const err = new Error('ORIGINAL_BAD_ARGS: markdown 必须是非空字符串');
    err.code = 'ORIGINAL_BAD_ARGS';
    throw err;
  }

  const incomingHash = originalBodyHash(markdown);
  if (!incomingHash) {
    const err = new Error(`ORIGINAL_NO_BODY: 待写原文里找不到正文锚点 ${yamlStr(BODY_ANCHOR)}，无法复核，拒绝写盘`);
    err.code = 'ORIGINAL_NO_BODY';
    throw err;
  }
  // 写前自检（可选）：渲染时算的 hash 与"从 '## 1.' 到末尾"重算的 hash 必须一致。
  if (bodyHash !== undefined && bodyHash !== null && bodyHash !== '') {
    if (typeof bodyHash !== 'string' || bodyHash !== incomingHash) {
      const err = new Error(
        'ORIGINAL_HASH_MISMATCH: 渲染器给出的正文hash与重算不一致，拒绝写盘。' +
        ` incoming=${incomingHash} rendered=${String(bodyHash)}`
      );
      err.code = 'ORIGINAL_HASH_MISMATCH';
      err.incomingHash = incomingHash;
      err.renderedHash = String(bodyHash);
      throw err;
    }
  }
  // 写前自检（P1-1/D11）：完整文件 hash 覆盖 YAML/头部，渲染值必须与重算一致。
  const incomingFullHash = sha256Hex(markdown);
  if (fullHash !== undefined && fullHash !== null && fullHash !== '') {
    if (typeof fullHash !== 'string' || fullHash !== incomingFullHash) {
      const err = new Error(
        'ORIGINAL_HASH_MISMATCH: 渲染器给出的完整文件hash与重算不一致，拒绝写盘。' +
        ` incoming=${incomingFullHash} rendered=${String(fullHash)}`
      );
      err.code = 'ORIGINAL_HASH_MISMATCH';
      err.incomingFullHash = incomingFullHash;
      err.renderedFullHash = String(fullHash);
      throw err;
    }
  }

  const dir = originalDir(root, y, m);
  const file = path.join(dir, `${code} 完整原文.md`);
  const rel = originalRelPath(y, m, code);
  // ③ 落盘前越界闸门（审计② P2-11）：字面 + realpath 双判。
  //    ★ 必须在 mkdirSync 之前判：root 内一层 junction 指向 root 外时，
  //      `mkdir(dir,{recursive:true})` 会直接**穿过 junction 在 root 外造目录**（建也建出去了）。
  assertInside(root, dir);
  assertInside(root, file);
  fs.mkdirSync(dir, { recursive: true });
  assertInside(root, dir); // 建完再判一次：realpath 此时可完整解析（防"祖先不存在时判不动"）
  assertInside(root, file);
  const bytes = Buffer.byteLength(markdown, 'utf8');

  // ---------- ① 先写原始事件附件（P0-5/D11）：附件不可变，同样 wx 排他创建 ----------
  //    顺序很重要：附件先落盘，正文后落盘。若正文创建失败，重试时附件走"同 hash 复用"，
  //    不会出现"正文有、附件缺"的不可恢复状态；反过来（正文先、附件后）就可能。
  let attachmentResult = null;
  if (attachment) {
    attachmentResult = writeAttachmentFile(dir, code, attachment, strict === true, root);
  }

  // ---------- ② 原子 + 排他创建正文（2026-11-09 夜 / P0-3-resume 真因）----------
  //
  // ★ 旧实现是 `openSync(file,'wx')` **直写**：kill -9 落在 write 中途时，
  //   磁盘上会留下"半截完整原文"（缺 `## 1.` 正文锚点）→ 下一轮同码 EEXIST →
  //   `ORIGINAL_CONFLICT` **永久停摆**，重启续跑就再也写不进去。
  //   现在：写满 `.tmp-*` + fsync → **原子发布**最终名。
  //   于是最终名只有两种状态：不存在 / 字节完整 —— 半截文件从构造上不可能出现。
  //   检测策略不变：已存在且复核不过 → 仍然 ORIGINAL_CONFLICT 停摆（红线不放松）。
  let created = false;
  try {
    writeFileAtomicExclusive(dir, `${code} 完整原文.md`, markdown);
    created = true;
  } catch (e) {
    if (!(e && e.code === 'EEXIST')) {
      // 写失败：临时文件已在 writeFileAtomicExclusive 内清理；最终名未被创建。
      const err = new Error(`ORIGINAL_WRITE_FAILED: 写入失败 ${file} :: ${e && e.message}`);
      err.code = 'ORIGINAL_WRITE_FAILED';
      err.path = file;
      throw err;
    }
  }

  if (!created) {
    // ---------- 已存在：只读复核，绝不动盘 ----------
    let existingRaw;
    try {
      existingRaw = fs.readFileSync(file);
    } catch (e) {
      // 文件在那儿但读不出来：不能猜、不能当同款复用，一律按冲突停摆。
      throw conflictError(file, '', incomingHash, `旧文件读取失败: ${e && e.code ? e.code : e.message}`);
    }
    const existingText = existingRaw.toString('utf8');
    const existingHash = originalBodyHash(existingText);
    const existingFullHash = sha256Hex(existingRaw);
    if (existingHash && existingHash === incomingHash) {
      if (existingFullHash === incomingFullHash) {
        return {
          path: file,
          rel,
          bytes: existingRaw.length,
          bodyHash: existingHash,
          fullHash: existingFullHash,
          reused: true,
          // 复用分支本来就必须整文件读回、重算两个 hash 才能判定同款 → 天然是全验。
          verify: 'full',
          attachment: attachmentResult,
        };
      }
      // P1-1：正文一致但整个文件不一致 = YAML/头部被改（或渲染器版本变化）。
      // 旧实现只比正文 → 静默复用；现在必须停摆，让"改 YAML"无处藏身。
      throw fullHashDriftError(file, existingFullHash, incomingFullHash);
    }
    throw conflictError(
      file,
      existingHash,
      incomingHash,
      existingHash ? '同一编码对应了不同正文' : '旧文件不是完整的完整原文（缺正文锚点），疑似上次写入中断'
    );
  }

  // ---------- ③ 新建完成：可证的最小代价写后自检（v0.9.3-re1 读放大修复） ----------
  //   必做：fsync（writeFileAtomicExclusive 内已做：先 fsync 临时文件再原子发布）+ stat.size 全等；
  //   默认 sampled：抽样回读头/尾各 ≤4 KiB；strict:true 才全量回读重算（旧行为）。
  //   返回 verify 字段明示档位 —— 抽样绝不冒充全验；坏写仍抛 ORIGINAL_VERIFY_FAILED。
  const check = verifyWrittenFile(file, markdown, bytes, incomingFullHash, strict === true);
  if (!check.ok) {
    const err = new Error(
      'ORIGINAL_VERIFY_FAILED: 写后自检不通过（磁盘内容与待写内容不一致），拒绝当作成功。' +
      ` 路径=${file} 档位=${check.mode} 期望完整=${incomingFullHash}/${bytes}B` +
      ` 实际字节=${check.bytes}B 问题=${check.problems.join(',') || 'unknown'}`
    );
    err.code = 'ORIGINAL_VERIFY_FAILED';
    err.path = file;
    err.expectedHash = incomingHash;
    err.expectedFullHash = incomingFullHash;
    err.expectedBytes = bytes;
    err.actualBytes = check.bytes;
    err.verify = check.mode;
    err.problems = check.problems;
    throw err;
  }
  // 全量档：用**磁盘字节**重算正文 hash（与旧行为一致）；抽样档：内存算出的 hash 即所写内容的 hash。
  let outBodyHash = incomingHash;
  let outFullHash = incomingFullHash;
  let outBytes = bytes;
  if (check.raw) {
    outBytes = check.raw.length;
    outBodyHash = originalBodyHash(check.raw.toString('utf8'));
    outFullHash = sha256Hex(check.raw);
    if (outBodyHash !== incomingHash || outFullHash !== incomingFullHash || outBytes !== bytes) {
      const err = new Error(
        'ORIGINAL_VERIFY_FAILED: 全量回读重算的 hash 与待写内容不一致，拒绝当作成功。' +
        ` 路径=${file} 期望正文=${incomingHash} 实际正文=${outBodyHash}`
      );
      err.code = 'ORIGINAL_VERIFY_FAILED';
      err.path = file;
      err.expectedHash = incomingHash;
      err.actualHash = outBodyHash;
      err.expectedFullHash = incomingFullHash;
      err.actualFullHash = outFullHash;
      throw err;
    }
  }

  return {
    path: file,
    rel,
    bytes: outBytes,
    bodyHash: outBodyHash,
    fullHash: outFullHash,
    reused: false,
    verify: check.mode,
    attachment: attachmentResult,
  };
}

/**
 * 写原始事件附件（P0-5/D11）。附件与视图同级、同样"创建一次、永不覆盖"。
 *
 * @param {string} dir 原文本目录
 * @param {string} code 编码
 * @param {{name:string, content:string, sha256?:string}} attachment
 * @param {boolean} [strict=false] 写后自检是否全量回读
 * @param {string} [root] 数据总库根；给了就在落盘前再判一次"附件必须落在 root 内"（审计② P2-11）
 * @returns {{path:string, name:string, sha256:string, bytes:number, eventsCount:number, reused:boolean}}
 * @throws {Error} ATTACHMENT_CONFLICT / ATTACHMENT_VERIFY_FAILED / ORIGINAL_BAD_ARGS
 *
 * @why 附件名固定为 `<code> 原始事件.json`：渲染器给了 name，落盘函数仍要**再校验一次**，
 *      防止被篡改的 name 写到别处（目录穿越 / 覆盖台账）。
 */
function writeAttachmentFile(dir, code, attachment, strict = false, root = '') {
  if (!attachment || typeof attachment !== 'object') return null;
  const expectName = `${code} 原始事件.json`;
  const name = typeof attachment.name === 'string' && attachment.name ? attachment.name : expectName;
  if (name !== expectName || name !== path.basename(name) || /[\\/]/.test(name)) {
    const err = new Error(
      `ORIGINAL_BAD_ARGS: 事件附件名必须是 ${expectName}（且只能是同目录文件名），实际=${JSON.stringify(name).slice(0, 120)}`
    );
    err.code = 'ORIGINAL_BAD_ARGS';
    err.kind = 'bad-attachment-name';
    throw err;
  }
  const content = String(attachment.content === undefined ? '' : attachment.content);
  if (!content) {
    const err = new Error(`ORIGINAL_BAD_ARGS: 事件附件 ${name} 内容为空`);
    err.code = 'ORIGINAL_BAD_ARGS';
    throw err;
  }
  const incomingAttachmentHash = sha256Hex(content);
  if (attachment.sha256 && attachment.sha256 !== incomingAttachmentHash) {
    const err = new Error(
      'ATTACHMENT_VERIFY_FAILED: 渲染给出的事件附件 hash 与其内容重算不一致，拒绝写盘。' +
      ` name=${name} rendered=${String(attachment.sha256)} recomputed=${incomingAttachmentHash}`
    );
    err.code = 'ATTACHMENT_VERIFY_FAILED';
    err.attachmentName = name;
    err.renderedHash = String(attachment.sha256);
    err.incomingHash = incomingAttachmentHash;
    throw err;
  }

  const file = path.join(dir, name);
  // ★ 附件路径同样过越界闸门（审计② P2-11）：附件与正文同级，也必须落在 root 内。
  if (typeof root === 'string' && root.length > 0) {
    assertInside(root, file);
    assertInside(root, path.dirname(file));
  }
  // ★ 原子 + 排他创建（2026-11-09 夜）：写满 tmp + fsync → 原子发布最终名。
  //   进程被 kill -9 时最终名要么不存在、要么字节完整 —— 不会留下"半截附件 JSON"
  //   （半截附件在下一轮会以 ATTACHMENT_CONFLICT 永久停摆）。
  let created = false;
  try {
    writeFileAtomicExclusive(dir, name, content);
    created = true;
  } catch (e) {
    if (!(e && e.code === 'EEXIST')) {
      // 真写失败：临时文件已在 writeFileAtomicExclusive 内清理，原样抛（与旧行为同：写失败必须爆）
      throw e;
    }
  }
  if (created) {
    // v0.9.3-re1：附件写后自检同样改"可证的最小代价"——fsync 在原子写内已做，
    // 这里 stat.size 必做 + 默认抽样头/尾 4 KiB；strict:true 才全量回读。
    // 返回 verify 明示档位（sampled 不冒充全验）；坏写仍抛 ATTACHMENT_VERIFY_FAILED。
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    const check = verifyWrittenFile(file, content, expectedBytes, incomingAttachmentHash, strict === true);
    if (!check.ok) {
      const err = new Error(
        'ATTACHMENT_VERIFY_FAILED: 事件附件写后自检不通过。' +
        ` 路径=${file} 档位=${check.mode} 期望=${incomingAttachmentHash}/${expectedBytes}B` +
        ` 实际字节=${check.bytes}B 问题=${check.problems.join(',') || 'unknown'}`
      );
      err.code = 'ATTACHMENT_VERIFY_FAILED';
      err.path = file;
      err.verify = check.mode;
      err.problems = check.problems;
      throw err;
    }
    return {
      path: file, name, sha256: incomingAttachmentHash, bytes: expectedBytes,
      eventsCount: attachment.eventsCount || 0, reused: false, verify: check.mode,
    };
  }

  // 附件已存在：同 sha256 复用；异 sha256 停摆不覆盖（附件也是凭证的一部分，D11）。
  const existingRaw = fs.readFileSync(file);
  const existingHash = sha256Hex(existingRaw);
  if (existingHash !== incomingAttachmentHash) {
    const err = new Error(
      'ATTACHMENT_CONFLICT: 事件附件已存在且内容不同，拒绝覆盖。' +
      ` 路径=${file} 已有sha256=${existingHash} 本次sha256=${incomingAttachmentHash}`
    );
    err.code = 'ATTACHMENT_CONFLICT';
    err.path = file;
    err.existingHash = existingHash;
    err.incomingHash = incomingAttachmentHash;
    throw err;
  }
  return {
    path: file, name, sha256: existingHash, bytes: existingRaw.length,
    eventsCount: attachment.eventsCount || 0, reused: true, verify: 'full',
  };
}

/**
 * P1-1：正文相同、完整文件不同 → 拒绝静默复用。
 *
 * @why 这是"改 YAML 被静默复用"那个洞的封口：只比正文 hash 时，
 *      任何对 YAML/头部/声明行的篡改都能在复用路径下被忽略；现在整文件 hash 不一致 = 停摆。
 */
function fullHashDriftError(file, existingFullHash, incomingFullHash) {
  const err = new Error(
    'ORIGINAL_CONFLICT: 凭证正文相同但完整文件不同（YAML/头部被改动，或渲染器版本变化），拒绝静默复用。' +
    ` 路径=${file} 已有完整hash=${existingFullHash} 本次完整hash=${incomingFullHash}`
  );
  err.code = 'ORIGINAL_CONFLICT';
  err.kind = 'full-hash-mismatch';
  err.path = file;
  err.existingFullHash = existingFullHash;
  err.incomingFullHash = incomingFullHash;
  return err;
}

/**
 * 附件名净化：只接受**同目录单个文件名**（审计② P2-11）。
 *
 * @param {string} raw
 * @returns {string|null} 合法 → 文件名；非法（含分隔符 `..`、控制符、超长、盘符/ADS）→ null
 *
 * @why 附件名来自台账/调用方，不是本模块自己拼的。`..\secret.json`
 *      一拼就把凭证目录之外的文件读进来，还会把它的 sha256 回显出去 ——
 *      越界读 + 内容外泄一步到位。所以这里只认"单文件名"，再做 realpath 同目录判定。
 */
function sanitizeAttachmentName(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 255) return null;
  if (raw === '.' || raw === '..') return null;
  if (/[\\/:]/.test(raw)) return null;          // 路径分隔符 / 盘符 / Windows ADS
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  if (raw !== path.basename(raw)) return null;
  return raw;
}

/**
 * 复核一份已落盘的「完整原文」（P1-1 / 契约 D11）—— 供周记账"绑定"判定与对账调用。
 *
 * 核四件事（缺一不可）：
 *   ① 路径：`expectedPath` 给出时，实际路径必须一致（PATH_MISMATCH）；
 *   ② YAML 身份字段：`编码` 合法且与文件名一致、`名称 == {编码} 完整原文`、
 *      `正文hash` 存在且为 64 位小写 hex；
 *   ③ 完整文件：对磁盘**原始字节**重算 sha256，与 `expectedFullHash` 比对（FILE_HASH_MISMATCH）；
 *   ④ 正文：`## 1.`→EOF 重算 sha256，与 YAML `正文hash` 及 `expectedBodyHash` 比对（BODY_HASH_MISMATCH）；
 *   ⑤ 附件（给了 expectedAttachmentSha256 / expectedAttachmentName 时）：同目录 `<code> 原始事件.json`
 *      重算 sha256（ATTACHMENT_MISSING / ATTACHMENT_HASH_MISMATCH）。
 *      ★ 附件名先净化成**同目录单文件名**，解析出的路径 realpath 后必须仍在凭证同目录内：
 *        非法名 → ATTACHMENT_NAME_INVALID、指到目录外（符号链接/junction）→ ATTACHMENT_OUTSIDE_ROOT，
 *        两种情况都**不读、不回显**任何外部内容（审计② P2-11）。
 *
 * @param {string} file 原文文件绝对路径
 * @param {object} [opts]
 * @param {string} [opts.expectedFullHash] 台账 `docFileSha256`
 * @param {string} [opts.expectedBodyHash] 台账 `docSha256`（正文语义）
 * @param {string} [opts.expectedCode]
 * @param {string} [opts.expectedAttachmentSha256] 台账 `attachment.sha256`
 * @param {string} [opts.expectedAttachmentName] 台账 `attachment.name`（缺省按 `<code> 原始事件.json` 推导）
 * @param {string} [opts.expectedPath] 期望的原文绝对路径（周记账按 ts+code 复算）
 * @returns {{
 *   ok:boolean, exists:boolean, file:string, problems:string[],
 *   code:string, name:string, bytes:number, fullHash:string, bodyHash:string,
 *   yamlBodyHash:string, attachment:{name:string, path:string, exists:boolean, sha256:string, bytes:number}|null,
 *   expected:object
 * }}
 *
 * @why 只返回布尔不够：周记账要把异常原因写进运行报告
 *      `integrityFailures:[{code,reason}]`，所以 problems 用稳定机器码；
 *      绑定判定必须因这些码而**不得显示"绑定"**（落到"缺凭证"）。
 * @why 文件不存在不抛错：对账/绑定时"文件不在"是正常待判定状态（可能被清册销毁），
 *      返回 exists:false 由调用方结合清册判四态（已清理 RPT-…）。
 *
 * @example
 *   const v = verifyOriginal(docAbs, {
 *     expectedFullHash: rec.docFileSha256, expectedBodyHash: rec.docSha256,
 *     expectedCode: rec.code, expectedAttachmentSha256: rec.attachment && rec.attachment.sha256,
 *   });
 *   if (!v.ok) logger.warn(`凭证复核失败 ${rec.code}: ${v.problems.join(',')}`);
 */
export function verifyOriginal(file, opts = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('verifyOriginal(file): file 必须是非空字符串');
  }
  const expected = {
    fullHash: typeof opts.expectedFullHash === 'string' && opts.expectedFullHash ? opts.expectedFullHash : '',
    bodyHash: typeof opts.expectedBodyHash === 'string' && opts.expectedBodyHash ? opts.expectedBodyHash : '',
    code: typeof opts.expectedCode === 'string' && opts.expectedCode ? opts.expectedCode : '',
    attachmentSha256: typeof opts.expectedAttachmentSha256 === 'string' && opts.expectedAttachmentSha256
      ? opts.expectedAttachmentSha256
      : '',
    attachmentName: typeof opts.expectedAttachmentName === 'string' && opts.expectedAttachmentName
      ? opts.expectedAttachmentName
      : '',
    path: typeof opts.expectedPath === 'string' && opts.expectedPath ? opts.expectedPath : '',
  };

  // ① 路径（先判路径：文件可能被搬到别处，hash 全对也不算"绑定"）
  const problems = [];
  if (expected.path && path.resolve(file) !== path.resolve(expected.path)) problems.push('PATH_MISMATCH');

  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    return {
      ok: false,
      exists: false,
      file,
      problems: ['FILE_MISSING', ...problems],
      error: { code: e && e.code ? e.code : '', message: e && e.message ? e.message : String(e) },
      code: '',
      name: '',
      bytes: 0,
      fullHash: '',
      bodyHash: '',
      yamlBodyHash: '',
      attachment: null,
      expected,
    };
  }

  const fullHash = sha256Hex(raw);
  const bytes = raw.length;
  const text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) problems.push('BOM_PRESENT');

  const body = originalBodyOf(text);
  const bodyHash = body ? sha256Hex(body) : '';
  if (!bodyHash) problems.push('BODY_ANCHOR_MISSING');

  const fm = originalFrontMatter(text);
  if (!fm) problems.push('YAML_MISSING');
  const fields = fm ? fm.fields : {};
  const code = fields['编码'] || '';
  const name = fields['名称'] || '';
  const yamlBodyHash = fields['正文hash'] || '';
  const base = path.basename(file);

  if (!/^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/.test(code)) problems.push('YAML_CODE_MISSING_OR_BAD');
  if (code && name !== `${code} 完整原文`) problems.push('YAML_NAME_MISMATCH');
  if (code && base !== `${code} 完整原文.md`) problems.push('FILENAME_CODE_MISMATCH');
  if (!/^[0-9a-f]{64}$/.test(yamlBodyHash)) problems.push('YAML_BODY_HASH_MISSING_OR_BAD');
  else if (bodyHash && yamlBodyHash !== bodyHash) problems.push('BODY_HASH_MISMATCH');

  if (expected.code && code !== expected.code) problems.push('CODE_MISMATCH');
  if (expected.fullHash && fullHash !== expected.fullHash) problems.push('FILE_HASH_MISMATCH');
  if (expected.bodyHash && bodyHash !== expected.bodyHash) problems.push('BODY_HASH_MISMATCH');

  // ⑤ 附件（P1-1 绑定四要素之一）
  //    ★ 审计② P2-11：expected.attachmentName 来自台账/调用方，旧实现直接 path.join(dirname(file), name)：
  //      `..\secret.json` 会把**凭证目录之外**的文件读进来并回显它的 sha256（越界读 + 内容外泄）。
  //      现在：① 名字必须净化成同目录单文件名（basename 化，含分隔符直接判非法）；
  //            ② 解析出的路径必须 realpath 后仍在凭证同目录内（防符号链接/junction 逃逸）；
  //            ③ 非法/越界一律只报机器码，绝不去读、绝不回显任何外部内容。
  let attachment = null;
  if (expected.attachmentSha256 || expected.attachmentName) {
    const namedCode = code || base.slice(0, 32);
    const attName = expected.attachmentName || `${namedCode} 原始事件.json`;
    const safeName = sanitizeAttachmentName(attName);
    const dirAbs = path.resolve(path.dirname(file));
    if (safeName === null) {
      // 非法名：如实报错，但**不回显外部内容**（不 read、无 sha256/bytes）
      attachment = { name: String(attName).slice(0, 200), path: '', exists: false, sha256: '', bytes: 0, invalid: true };
      problems.push('ATTACHMENT_NAME_INVALID');
    } else {
      const attPath = path.join(dirAbs, safeName);
      let outside = false;
      try {
        const realAtt = fs.realpathSync(attPath); // 不存在 → ENOENT（下面按缺失处理）
        const realDir = fs.realpathSync(dirAbs);
        if (!isSameOrInside(realDir, realAtt)) outside = true;
      } catch (e) {
        if (!(e && e.code === 'ENOENT')) throw e;
      }
      if (outside) {
        // 附件是符号链接/junction 指到同目录之外：不读、不回显
        attachment = { name: safeName, path: '', exists: false, sha256: '', bytes: 0, outside: true };
        problems.push('ATTACHMENT_OUTSIDE_ROOT');
      } else {
        let attRaw = null;
        let attExists = true;
        try {
          attRaw = fs.readFileSync(attPath);
        } catch (e) {
          if (e && e.code === 'ENOENT') attExists = false;
          else throw e;
        }
        attachment = {
          name: safeName,
          path: attPath,
          exists: attExists,
          sha256: attRaw ? sha256Hex(attRaw) : '',
          bytes: attRaw ? attRaw.length : 0,
        };
        if (!attExists) {
          problems.push('ATTACHMENT_MISSING');
        } else if (expected.attachmentSha256 && attachment.sha256 !== expected.attachmentSha256) {
          problems.push('ATTACHMENT_HASH_MISMATCH');
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    exists: true,
    file,
    problems,
    code,
    name,
    bytes,
    fullHash,
    bodyHash,
    yamlBodyHash,
    attachment,
    expected,
  };
}
