/**
 * @file encoder.js
 * @role 编码器 —— 全系统的主键生成与校验。纯函数，无 IO，无副作用，无外部依赖。
 * @called-by index.js（落账前算编码）、ledger.js（查重前算 key）
 * @depends 无（只允许 node: 内置模块；实际上连内置模块都不需要）
 * @why 编码是唯一主键，一旦错，整本账都对不上。所以它必须能被"喂参数测"：
 *      不读文件、不连环境、不依赖时间（时间由调用方传进来）。
 *
 * 编码格式（32 位，定稿于 2026-11-08）：
 *
 *     YYYYMMDD-SSSSSSSSSSSS-D-NNNNNNNN
 *     └─8──┘ └───12────┘ │ └───8───┘
 *      日期    会话短ID   代差   会话内序号
 *
 *     8 + 1 + 12 + 1 + 1 + 1 + 8 = 32
 *
 * 为什么是这个形状（三条都是踩过坑才定的）：
 *   1. 日期段 = 【会话开始日】，不是"Turn 发生日"。
 *      用发生日会把一个会话的原文拆到两个日期段、两个月文件夹，
 *      一个会话的周记账被拆到两本册子里（会计上叫跨期）。
 *   2. 短 ID 必须归一化。直接截前 12 位会得到 "session-7523"，
 *      分隔符混进内容段，任何按 "-" 切分的解析器全部错位。
 *   3. 代差 D 必须有。12 位十六进制的碰撞概率约 0.18%（百万会话），
 *      一旦撞车，文件名会互相覆盖 —— 那就是"一份交接表被另一份吃掉"。
 */

/** 编码总长度。改它等于改格式，全系统连带修改。 */
const CODE_LENGTH = 32;

/** 段分隔符。半角连字符，三个位置固定：9、22、24（1-based）。 */
const SEP = '-';

/** 匹配合法编码。注意：代差只收【大写】A–Z。 */
const CODE_RE = /^\d{8}-[0-9a-z]{12}-[A-Z]-\d{8}$/;

/** 一秒的毫秒数，只用于把毫秒时间戳转成日期段。 */
const MS_PER_SEC = 1000;

/**
 * 把平台 Session ID 归一化成 12 位短 ID。
 *
 * @param {string} rawId 形如 "session-75238718-e41a-4e8c-8044-50202444455f"
 * @returns {string} 形如 "75238718e41a"；输入非法时返回 ""
 *
 * @why 归一化分四步，**顺序不能换**，而且第一步最容易写错：
 *        ① 去掉开头的 "session" 这个词（含其后的分隔符）
 *        ② 去掉所有非 [0-9a-zA-Z] 字符（清掉 UUID 里剩下的 3 个连字符）
 *        ③ 取前 12 位
 *        ④ 转小写
 *
 *      ⚠️ 为什么必须有第 ① 步：只做第 ② 步会得到
 *         "session75238718e41a4e8c..."，其中 "session" 那 7 个字母被当成内容，
 *         第 ③ 步就切出 "session75238" —— 短 ID 全错，而且每一条都错。
 *         （这个 bug 2026-11-08 真发生过一次，被单元测试抓到时才发现。）
 *
 *      ⚠️ 为什么第 ② 步不能省：session id 内部还有 3 个连字符，
 *         不去掉的话，第 ③ 步会切到 "75238718-e41"，分隔符混进内容段，
 *         任何按 "-" 切分的解析器（Excel 分列 / 正则 / SQL）全部错位。
 *
 * @example
 *   normalizeSessionId('session-75238718-e41a-4e8c-8044-50202444455f')
 *   // => '75238718e41a'
 *   normalizeSessionId('75238718-e41a-4e8c-8044-50202444455f')   // 无前缀
 *   // => '75238718e41a'
 *   normalizeSessionId('SESSION-75238718-E41A-4e8c')
 *   // => '75238718e41a'   （大写也归一）
 */
export function normalizeSessionId(rawId) {
  if (typeof rawId !== 'string' || rawId.length === 0) return '';

  // ① 去掉开头的 "session"（可能带 '-'、'_' 或空格），不区分大小写
  let s = rawId.replace(/^session[-\s_]?/i, '');

  // ② 去掉其余所有非字母数字（清掉 UUID 内部的连字符）
  s = s.replace(/[^0-9a-zA-Z]/g, '');

  // ③④ 取前 12 位并转小写
  if (s.length < 12) return '';
  return s.slice(0, 12).toLowerCase();
}

/**
 * 从 Session ID 里取出 12 位短 ID，**不做前缀假设**。
 *
 * 与 normalizeSessionId 的区别：本函数是它的别名，保留为语义化入口。
 * 之所以留两个名字，是因为调用方读起来更清楚：
 * "我在归一化一个 id" vs "我要这个会话的短 id"。
 *
 * @param {string} rawId
 * @returns {string}
 */
export function sessionShortId(rawId) {
  return normalizeSessionId(rawId);
}

/**
 * 把毫秒时间戳转成日期段（YYYYMMDD）。
 *
 * @param {number} timeMs 毫秒时间戳（DSH 事件里的 `time` 字段就是这个）
 * @param {number} [offsetMinutes=480] 时区偏移分钟数，默认 480 = UTC+08:00
 * @returns {string} 形如 "20261108"
 *
 * @why **绝对不能用本机时区**。换一台机器、或改系统时区，
 *      历史归属会整体漂移 —— 那是账最不能接受的事。
 *      所以调用方要么传 UTC+08:00 的偏移，要么传已经算好的偏移。
 *
 * @example
 *   dateSegment(1794136000000)  // => '20261108'（UTC+08:00 下的那天）
 */
export function dateSegment(timeMs, offsetMinutes = 480) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return '';
  const shifted = timeMs + offsetMinutes * 60 * MS_PER_SEC;
  const d = new Date(shifted);
  // 用 UTC 读，因为上面已经做过偏移；这样不受运行环境时区影响。
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * 把毫秒时间戳转成 ISO 8601 字符串（带 +08:00）。
 *
 * @param {number} timeMs
 * @param {number} [offsetMinutes=480]
 * @returns {string} 形如 "2026-11-08T14:25:39+08:00"
 *
 * @why 台账里存 ISO 而不是裸毫秒，是为了"人能直接读"。
 *      而带偏移量是因为：不带的 ISO 在跨时区阅读时会被误解。
 */
export function isoTime(timeMs, offsetMinutes = 480) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return '';
  const shifted = timeMs + offsetMinutes * 60 * MS_PER_SEC;
  const d = new Date(shifted);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${y}-${mo}-${da}T${h}:${mi}:${s}${sign}${oh}:${om}`;
}

/**
 * 生成 32 位编码。
 *
 * @param {object} p
 * @param {string} p.date       日期段，8 位数字，形如 "20261108"
 * @param {string} p.s12        12 位短 ID（小写），形如 "75238718e41a"
 * @param {string} [p.gen='A']  代差，单个大写字母 A–Z
 * @param {number} p.seq        会话内序号，从 1 起
 * @returns {string} 32 位编码；任一参数非法时返回 ""
 *
 * @example
 *   makeCode({ date: '20261108', s12: '75238718e41a', gen: 'A', seq: 1 })
 *   // => '20261108-75238718e41a-A-00000001'
 */
export function makeCode({ date, s12, gen = 'A', seq } = {}) {
  if (!/^\d{8}$/.test(String(date || ''))) return '';
  if (!/^[0-9a-z]{12}$/.test(String(s12 || ''))) return '';
  if (!/^[A-Z]$/.test(String(gen || ''))) return '';
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1 || n > 99999999) return '';
  return [
    date,
    s12,
    gen,
    String(n).padStart(8, '0'),
  ].join(SEP);
}

/**
 * 反向解析编码。
 *
 * @param {string} code 32 位编码
 * @returns {{date:string, s12:string, gen:string, seq:number}|null}
 *          合法时返回四段；非法返回 null
 *
 * @why 有它在，"校验"才不依赖"再生成一遍比对"。
 *      台账里任何一条都能自解释，不必回查别的文件。
 */
export function parseCode(code) {
  if (!isValidCode(code)) return null;
  const parts = code.split(SEP);
  // 注意：split 会得到 4 段，因为短 ID 里没有分隔符（归一化保证了这点）
  if (parts.length !== 4) return null;
  return {
    date: parts[0],
    s12: parts[1],
    gen: parts[2],
    seq: Number(parts[3]),
  };
}

/**
 * 判断一个字符串是否是合法编码。
 *
 * @param {string} code
 * @returns {boolean}
 *
 * @why 只校【结构】，不校"这个编码对应的会话是否存在"——
 *      后者要查台账，不属于纯函数的职责。
 */
export function isValidCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
  return CODE_RE.test(code);
}

/**
 * 从编码里取"会话键"，即去掉序号后的部分。
 *
 * @param {string} code 32 位编码
 * @returns {string} 形如 "20261108-75238718e41a-A"；非法返回 ""
 *
 * @why 同一会话的所有记录要能归组。归组的键就是这个（不含序号）。
 *      注意它**含日期**，而日期是会话开始日，所以同会话跨零点时键仍然一致。
 */
export function sessionKeyOfCode(code) {
  const p = parseCode(code);
  if (!p) return '';
  return `${p.date}${SEP}${p.s12}${SEP}${p.gen}`;
}

/**
 * 分配代差。
 *
 * @param {Array<{s12:string, gen:string, sid?:string}>} existing
 *        台账里已有的记录（或至少是"已用过的 s12+gen"列表）
 * @param {string} s12 本次要分配的 12 位短 ID
 * @param {string} sid 本次会话的完整 id（用来判断"是不是同一个会话"）
 * @returns {string} 单个大写字母；s12 首次出现时返回 "A"
 *
 * @why 代差是为了解决"两个不同会话，前 12 位恰好相同"。
 *      规则：
 *        · 该 s12 从未用过                     → 'A'
 *        · 用过，且 those 记录的 sid 全是本会话 → 沿用原代差
 *        · 用过，但 sid 与本会话不同            → 递增到下一个字母
 *
 *      ⚠️ 这是"能重跑"的关键：同一会话重放时，必须拿到【同一个】代差，
 *         否则编码会变，幂等就破了。
 *
 * @example
 *   nextGen([], '75238718e41a', 'session-...')                    // 'A'
 *   nextGen([{s12:'75238718e41a', gen:'A', sid:'session-x'}],
 *           '75238718e41a', 'session-x')                          // 'A'（沿用）
 *   nextGen([{s12:'75238718e41a', gen:'A', sid:'session-x'}],
 *           '75238718e41a', 'session-y')                          // 'B'（撞车）
 */
export function nextGen(existing, s12, sid) {
  const list = Array.isArray(existing) ? existing : [];
  const same = list.filter((r) => r && r.s12 === s12);
  if (same.length === 0) return 'A';

  // 本会话已经在这个 s12 下登记过 → 沿用它的代差
  const mine = same.find((r) => r.sid && sid && r.sid === sid);
  if (mine && typeof mine.gen === 'string' && /^[A-Z]$/.test(mine.gen)) {
    return mine.gen;
  }

  // 否则：找一个未被占用的字母
  const used = new Set(same.map((r) => r.gen).filter((g) => /^[A-Z]$/.test(g)));
  for (let i = 0; i < 26; i++) {
    const g = String.fromCharCode(65 + i);
    if (!used.has(g)) return g;
  }
  // 26 个都用完了：极端情况，返回空串让调用方报错，不静默瞎给
  return '';
}

/**
 * 算出一个会话「下一轮的序号」。
 *
 * @param {Array<{s12:string, gen:string, seq:number}>} existing
 *        台账里已有的记录
 * @param {string} s12
 * @param {string} gen
 * @returns {number} 从 1 起；没有任何历史时返回 1
 *
 * @why 序号是【会话内】计数，跨天不重置（2026-11-08 定）。
 *      所以这里只按 s12+gen 过滤，不看日期。
 */
export function nextSeq(existing, s12, gen) {
  const list = Array.isArray(existing) ? existing : [];
  let max = 0;
  for (const r of list) {
    if (!r) continue;
    if (r.s12 !== s12 || r.gen !== gen) continue;
    if (Number.isInteger(r.seq) && r.seq > max) max = r.seq;
  }
  return max + 1;
}

/** 导出常量，供测试与文档引用。 */
export const CONST = { CODE_LENGTH, SEP, CODE_RE };
