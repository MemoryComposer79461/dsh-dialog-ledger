/**
 * @file 自测-encoder.mjs
 * @role 单元自测：lib/encoder.js（32 位编码，以及日期/时间归一化、代差与序号分配）。
 * @why 编码是台账的**永久主键**，而账只追加、不允许改写 —— 主键错一次就永远改不回来。
 *      所以这里不测"能生成一个字符串"，而是逐段喂边界：
 *        归一化（前缀/大小写/分隔符/短 id）、日期段（时区/跨日/非法输入）、
 *        ISO 格式（偏移符号/30 分钟时区/补零）、四段结构（分隔符位置/长度/各段字符集）、
 *        代差撞车（沿用/A→B→C/26 字母耗尽）、序号（跨天不重置、不同代差隔离）。
 *      本文件纯内存运行：不写盘、不读环境变量、不依赖运行机器的时区。
 *
 * 运行（在源码仓库根目录）：
 *   & '<test-dir>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --test docs/自测-encoder.mjs
 *
 * 约定：
 *   · 期望值一律从"带显式时区偏移的 ISO 字面量"或手写常量推出，绝不用被测函数反推；
 *   · 每条 test 上方一行「守：」写明这条防的是哪种回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSessionId,
  sessionShortId,
  dateSegment,
  isoTime,
  makeCode,
  parseCode,
  isValidCode,
  sessionKeyOfCode,
  nextGen,
  nextSeq,
  CONST,
} from '../lib/encoder.js';

/** 标准会话 id：`session-` 前缀 + UUID。 */
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
/** SID 归一化后应得的 12 位短 id。 */
const S12 = '75238718e41a';
/** 固定日期段，编码类用例共用。 */
const DATE = '20261108';
/** 合法编码示例：8 位日期 + 12 位短 id + 1 位代差 + 8 位序号。 */
const GOOD_CODE = '20261108-75238718e41a-A-00000001';

/**
 * ISO 字面量 → 毫秒。
 * 字面量**自带 +08:00 偏移**，所以结果与运行机器所在时区无关，
 * 也不会因为换一台机器而让断言含义漂移。
 */
const ms = (iso) => Date.parse(iso);

/** 便捷生成合法编码：默认固定 date/s12/gen，只改 seq。 */
const codeOf = (seq, over = {}) => makeCode({ date: DATE, s12: S12, gen: 'A', seq, ...over });
const SEP = '-';

// ============================================================================
// 一、normalizeSessionId —— 短 id 归一化（编码第 2 段）
// ============================================================================

test('normalizeSessionId：标准 session-UUID → 前 12 位（去掉前缀与全部连字符）', () => {
  // 守：归一化四步顺序 —— 先剥 "session" 前缀，再清非字母数字，再截 12 位。
  // 若只清连字符不剥前缀，会切出 "session75238" 这种以单词当内容的短 id。
  assert.equal(normalizeSessionId(SID), S12);
  assert.equal(normalizeSessionId('75238718-e41a-4e8c-8044-50202444455f'), S12); // 无前缀也应能归一
  assert.equal(normalizeSessionId('session75238718e41a'), S12); // 前缀后无分隔符
});

test('normalizeSessionId：大写输入统一转成小写', () => {
  // 守：12 位段只允许小写 [0-9a-z]（编码正则如此），大写必须归一，
  // 否则同一会话的 code 会因大小写变成两个主键。
  assert.equal(normalizeSessionId('SESSION-75238718-E41A-4e8c'), S12);
  assert.equal(normalizeSessionId('Session-75238718-E41A'), S12);
});

test('normalizeSessionId：下划线与空格分隔符同样被剥掉', () => {
  // 守：前缀后的分隔符允许 '-'、'_'、空格（`^session[-\s_]?`），
  // 且内部残留的 '_'/' ' 也必须在第 ② 步被清掉，不能混进第 2 段。
  assert.equal(normalizeSessionId('session_75238718_e41a'), S12);
  assert.equal(normalizeSessionId('session 75238718 e41a'), S12);
  assert.equal(normalizeSessionId('session-75238718_e41a'), S12);
});

test('normalizeSessionId：不足 12 位的短 id 返回空串（不许凑数）', () => {
  // 守：v0.1 的已知地雷 "session75238" 必须返回空串；调用方据此跳过该会话，
  // 而不是拿 5 位残段当主键。空串是"算不出"的唯一合法表达。
  assert.equal(normalizeSessionId('session75238'), '');
  assert.equal(normalizeSessionId('session-7523'), '');
  assert.equal(normalizeSessionId('session-'), '');
  assert.equal(normalizeSessionId('session'), '');
  assert.equal(normalizeSessionId('abc'), '');
});

test('normalizeSessionId：空值与非字符串返回空串', () => {
  // 守：纯函数不抛错 —— 上游字段缺失（undefined/null/数字/对象）时必须安静返回 ""，
  // 让调用方走"跳过"分支，而不是把异常扩散到定时器里。
  assert.equal(normalizeSessionId(''), '');
  assert.equal(normalizeSessionId(null), '');
  assert.equal(normalizeSessionId(undefined), '');
  assert.equal(normalizeSessionId(123456789012), '');
  assert.equal(normalizeSessionId({ id: SID }), '');
  assert.equal(normalizeSessionId([]), '');
});

test('normalizeSessionId：超过 12 位只取前 12 位', () => {
  // 守：短 id 固定 12 位，长 id 绝不把后续字符带进编码。
  assert.equal(normalizeSessionId('session-75238718e41aEXTRA'), S12);
  assert.equal(normalizeSessionId(SID), S12);
  assert.equal(normalizeSessionId(SID).length, 12);
});

test('sessionShortId：是 normalizeSessionId 的语义化别名', () => {
  // 守：两个入口必须同结果；否则 index.js 与 ledger.js 各自算出不同的短 id，
  // 同一会话会被拆成两本账。
  assert.equal(sessionShortId(SID), normalizeSessionId(SID));
  assert.equal(sessionShortId('session75238'), normalizeSessionId('session75238'));
});

// ============================================================================
// 二、dateSegment —— 日期段（编码第 1 段），必须按"传入偏移"算，不许用本机时区
// ============================================================================

test('dateSegment：UTC+08:00 的 2026-11-08 00:00:00 归 20261108', () => {
  // 守：会话开始日锚点的最基本一条。用带偏移的字面量，不受本机时区影响。
  const t = ms('2026-11-08T00:00:00+08:00');
  assert.equal(dateSegment(t), '20261108'); // 默认偏移 480
  assert.equal(dateSegment(t, 480), '20261108');
});

test('dateSegment：UTC+08:00 的 23:59:59.999 仍是同一天', () => {
  // 守：日界边界上不许"差一秒换天"。台账跨期是会计意义上最不能接受的事。
  assert.equal(dateSegment(ms('2026-11-08T23:59:59.999+08:00')), '20261108');
});

test('dateSegment：跨日边界前后 1ms 各归各天', () => {
  // 守：偏移换算的加减号方向 —— 若把 +480 写成 -480，00:00 会被错算到前一天。
  const midnight = ms('2026-11-08T00:00:00+08:00');
  assert.equal(dateSegment(midnight - 1), '20261107');
  assert.equal(dateSegment(midnight), '20261108');
  assert.equal(dateSegment(midnight + 24 * 3600 * 1000), '20261109');
  assert.equal(dateSegment(midnight + 24 * 3600 * 1000 - 1), '20261108');
});

test('dateSegment：offset=0 的对照 —— 同一时刻在 UTC 下是前一天', () => {
  // 守：函数吃的是"调用方传入的偏移"，不是运行环境时区。
  // 2026-11-08 00:00 (+08:00) === 2026-11-07 16:00 (UTC)。
  const t = ms('2026-11-08T00:00:00+08:00');
  assert.equal(dateSegment(t, 0), '20261107');
  assert.equal(dateSegment(t, 480), '20261108');
});

test('dateSegment：负偏移（西半球）也按传入值换算', () => {
  // 守：正负偏移都走同一条换算路径；-300 = UTC-05:00 下该时刻仍是 11-07。
  const t = ms('2026-11-08T00:00:00+08:00'); // = 2026-11-07T16:00:00Z
  assert.equal(dateSegment(t, -300), '20261107'); // UTC-05:00 → 11:00 当日
  assert.equal(dateSegment(t, -720), '20261107'); // UTC-12:00 → 04:00 当日
});

test('dateSegment：非法输入返回空串', () => {
  // 守：NaN / Infinity / 字符串 / null 一律 ""，不许拼出 "NaNNaNNaN" 或 "19700101"
  // 这种会当主键入库的假日期。
  assert.equal(dateSegment(NaN), '');
  assert.equal(dateSegment(Infinity), '');
  assert.equal(dateSegment(-Infinity), '');
  assert.equal(dateSegment('20261108'), '');
  assert.equal(dateSegment(null), '');
  assert.equal(dateSegment(undefined), '');
  assert.equal(dateSegment({}), '');
});

test('dateSegment：省略偏移时等价于 480（UTC+08:00）', () => {
  // 守：默认值一旦被改成别的数（比如 0），历史归属会整体漂移一天。
  const t = ms('2026-11-08T12:00:00+08:00');
  assert.equal(dateSegment(t), dateSegment(t, 480));
  assert.equal(dateSegment(t), '20261108');
});

// ============================================================================
// 三、isoTime —— 台账里的人可读时间，带显式偏移
// ============================================================================

/** 任务要求的格式：秒级、必须带 ±HH:MM。 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

test('isoTime：输出必须匹配 ^YYYY-MM-DDTHH:mm:ss±HH:MM$', () => {
  // 守：台账 ts 是下游用正则/Excel 分列解析的，任何一种偏移都不许输出不带偏移的裸 ISO。
  const t = ms('2026-11-08T14:25:39+08:00');
  for (const off of [480, 0, 330, -300, -720]) {
    assert.match(isoTime(t, off), ISO_RE, `offset=${off} 输出格式不对`);
  }
  assert.match(isoTime(t), ISO_RE); // 默认偏移也守
});

test('isoTime：UTC+08:00 的 14:25:39 原样输出 +08:00', () => {
  // 守：默认时区与补零逻辑（时/分/秒都要两位）。
  assert.equal(isoTime(ms('2026-11-08T14:25:39+08:00')), '2026-11-08T14:25:39+08:00');
  assert.equal(isoTime(ms('2026-11-08T09:05:07+08:00')), '2026-11-08T09:05:07+08:00');
});

test('isoTime：offset=0 → +00:00，时刻按 UTC 显示', () => {
  // 守：符号与偏移量对应正确；同一毫秒在 UTC 下是 06:25:39。
  assert.equal(
    isoTime(ms('2026-11-08T14:25:39+08:00'), 0),
    '2026-11-08T06:25:39+00:00'
  );
});

test('isoTime：负偏移与 30 分钟时区的符号/分钟都正确', () => {
  // 守：`-` 号分支和 abs 取模 —— 写了半小时时区的账不能显示成整点。
  const t = ms('2026-11-08T14:25:39+08:00'); // = 2026-11-08T06:25:39Z
  assert.equal(isoTime(t, 330), '2026-11-08T11:55:39+05:30'); // UTC+05:30
  assert.equal(isoTime(t, -300), '2026-11-08T01:25:39-05:00'); // UTC-05:00
});

test('isoTime：跨日 00:00 正确显示为当天 00:00:00', () => {
  // 守：跨日时日期段/时间不串位（偏移把 UTC 16:00 推到次日 00:00）。
  assert.equal(
    isoTime(ms('2026-11-08T00:00:00+08:00')),
    '2026-11-08T00:00:00+08:00'
  );
});

test('isoTime：同秒内的毫秒被截断，不出现毫秒位', () => {
  // 守：格式固定到秒；带毫秒会让 regex 校验失败、也会让"同一轮"的 ts 不稳定。
  const t = ms('2026-11-08T14:25:39+08:00');
  assert.equal(isoTime(t + 999), isoTime(t));
  assert.equal(isoTime(t + 999), '2026-11-08T14:25:39+08:00');
});

test('isoTime：非法输入返回空串', () => {
  // 守：坏时间戳不许渲染成 "NaN-NaN-NaN..." 的字符串被写进台账。
  assert.equal(isoTime(NaN), '');
  assert.equal(isoTime(Infinity), '');
  assert.equal(isoTime('2026-11-08T14:25:39+08:00'), '');
  assert.equal(isoTime(null), '');
  assert.equal(isoTime(undefined), '');
});

// ============================================================================
// 四、makeCode —— 生成 32 位编码
// ============================================================================

test('makeCode：标准参数生成 32 位四段，分隔符位固定在第 9/22/24 个字符', () => {
  // 守：编码格式定稿：YYYYMMDD-SSSSSSSSSSSS-D-NNNNNNNN = 32 位。
  // 分隔符位置错一位，所有按 '-' 切分的下游解析器都会错位。
  const c = codeOf(1);
  assert.equal(c, GOOD_CODE);
  assert.equal(c.length, CONST.CODE_LENGTH);
  assert.deepEqual(c.split(SEP).map((s) => s.length), [8, 12, 1, 8]);
  // 0-based 下标：8、21、23 是三个分隔符；1-based 即第 9/22/24 位。
  assert.equal(c[8], SEP);
  assert.equal(c[21], SEP);
  assert.equal(c[23], SEP);
  assert.equal(c.split(SEP).length, 4);
});

test('makeCode：gen 省略时默认 A', () => {
  // 守：新会话第一次落账默认 A 代；如果默认值丢了，新会话会拿不到合法编码。
  assert.equal(makeCode({ date: DATE, s12: S12, seq: 1 }), GOOD_CODE);
});

test('makeCode：seq 边界 1 与 99999999 合法，左补零到 8 位', () => {
  // 守：seq 是 8 位定宽段，1 必须写成 00000001，否则长度/切分全错。
  assert.equal(codeOf(1), '20261108-75238718e41a-A-00000001');
  assert.equal(codeOf(7), '20261108-75238718e41a-A-00000007');
  assert.equal(codeOf(123), '20261108-75238718e41a-A-00000123');
  assert.equal(codeOf(99999999), '20261108-75238718e41a-A-99999999');
  assert.equal(codeOf(1).length, 32);
  assert.equal(codeOf(99999999).length, 32);
});

test('makeCode：seq 0 / -1 / 非整数 / 超上限一律拒绝', () => {
  // 守：序号从 1 起，且必须能塞进 8 位十进制。非法值返回 ""，由调用方报错跳过，
  // 绝不静默截断成 00000000（那会变成另一个主键）。
  assert.equal(codeOf(0), '');
  assert.equal(codeOf(-1), '');
  assert.equal(codeOf(1.5), '');
  assert.equal(codeOf(99999999.5), '');
  assert.equal(codeOf(NaN), '');
  assert.equal(codeOf(100000000), '');
  assert.equal(codeOf(-99999999), '');
  assert.equal(codeOf(Infinity), '');
});

test('makeCode：gen 必须是单个大写字母', () => {
  // 守：代差只收 A–Z 且必须一位大写；小写 'a' 混进来会和 12 位小写段混淆，
  // 两位字母会撑破 32 位长度。
  for (const bad of ['a', 'AB', '1', '', '中', 'AA']) {
    assert.equal(codeOf(1, { gen: bad }), '', `gen=${JSON.stringify(bad)} 应被拒`);
  }
  assert.equal(codeOf(1, { gen: 'Z' }), '20261108-75238718e41a-Z-00000001');
});

test('makeCode：s12 必须是 12 位小写字母数字，含连字符必须被拒', () => {
  // 守：第 2 段一旦混入 '-'，整条编码就不再是 32 位四段，
  // parseCode/split 全部错位（这是 v0.1 踩过的坑）。
  const bads = [
    '75238718E41A', // 大写
    '75238718e4', // 11 位
    '75238718e41ab', // 13 位
    '7523871-e41a', // 12 位但含连字符
    '7523871_e41a', // 含下划线
    '75238718e41', // 11 位
    '75238718e41a!', // 非法字符
  ];
  for (const bad of bads) {
    assert.equal(codeOf(1, { s12: bad }), '', `s12=${JSON.stringify(bad)} 应被拒`);
  }
  assert.equal(codeOf(1, { s12: 'abcdefghijkl' }).length, 32); // 纯字母也合法
  assert.equal(codeOf(1, { s12: '0123456789ab' }).length, 32); // 纯数字也合法
});

test('makeCode：date 必须是 8 位数字', () => {
  // 守：第 1 段只收 YYYYMMDD；带连字符或非数字的日期段会让整条编码变长/变味。
  for (const bad of ['2026-11-08', '2026118', '2026110a', '', '202611080']) {
    assert.equal(codeOf(1, { date: bad }), '', `date=${JSON.stringify(bad)} 应被拒`);
  }
  assert.equal(codeOf(1, { date: '20261109' }), '20261109-75238718e41a-A-00000001');
});

test('makeCode：无参数 / 空对象返回空串（不抛错）', () => {
  // 守：缺参时安静拒绝，让调用方走 makeCode 失败分支，而不是在定时器里抛异常。
  assert.equal(makeCode(), '');
  assert.equal(makeCode({}), '');
  assert.equal(makeCode({ date: DATE }), '');
});

// ============================================================================
// 五、isValidCode / parseCode —— 结构校验与反向解析
// ============================================================================

test('isValidCode：合法编码通过', () => {
  // 守：正常编码必须被判合法；否则台账里每一条都会被下游当坏数据。
  assert.equal(isValidCode(GOOD_CODE), true);
  assert.equal(isValidCode(codeOf(99999999, { gen: 'Z' })), true);
});

test('isValidCode：长度不是 32 一律拒绝', () => {
  // 守：先卡长度再卡正则 —— 少一位 / 多一位都说明编码被截断或被拼接。
  assert.equal(isValidCode(GOOD_CODE.slice(0, 31)), false);
  assert.equal(isValidCode(GOOD_CODE + '0'), false);
  assert.equal(isValidCode(''), false);
  assert.equal(isValidCode('x'), false);
});

test('isValidCode：代差小写、短 id 含连字符/大写、分隔符错位均拒绝', () => {
  // 守：结构反例 —— 特别是"32 位长度但对、位置不对"的字符串，
  // 只算长度是抓不到的，必须靠正则。
  const invalid = [
    '20261108-75238718e41a-a-00000001', // gen 小写
    '20261108-75238718E41A-A-00000001', // s12 大写
    '20261108-7523871-e41a-A-00000001', // s12 含连字符（长度仍是 32）
    '2026110-875238718e41a-A-00000001', // 日期段少一位、短 id 段多一位（长度 32）
    '20261108_75238718e41a_A_00000001', // 分隔符被换成下划线
    '20261108-75238718e41a-AA-0000001', // gen 两位、seq 七位（总长 32 但结构错）
  ];
  for (const bad of invalid) {
    assert.equal(bad.length >= 31, true); // 备注：其中多数刻意凑成 32 位
    assert.equal(isValidCode(bad), false, `应拒绝：${bad}`);
  }
});

test('isValidCode：非字符串参数返回 false（不抛错）', () => {
  // 守：台账读回的值可能被手改成数字/对象，校验函数不许崩。
  assert.equal(isValidCode(null), false);
  assert.equal(isValidCode(undefined), false);
  assert.equal(isValidCode(12345678901234567890123456789012), false);
  assert.equal(isValidCode({ code: GOOD_CODE }), false);
  assert.equal(isValidCode([GOOD_CODE]), false);
});

test('parseCode：合法编码往返得到四段（seq 为数字）', () => {
  // 守：台账里任何一条都能自解释，不需要回查别的文件。
  assert.deepEqual(parseCode(GOOD_CODE), {
    date: DATE,
    s12: S12,
    gen: 'A',
    seq: 1,
  });
  assert.deepEqual(parseCode(codeOf(99999999, { gen: 'Z' })), {
    date: DATE,
    s12: S12,
    gen: 'Z',
    seq: 99999999,
  });
  // seq 是 number，不是 "00000001" 字符串。
  assert.equal(typeof parseCode(GOOD_CODE).seq, 'number');
});

test('parseCode：非法编码返回 null', () => {
  // 守：非法输入不许返回半截对象（那会让下游把 undefined 当日期用）。
  assert.equal(parseCode(null), null);
  assert.equal(parseCode(undefined), null);
  assert.equal(parseCode(123), null);
  assert.equal(parseCode(''), null);
  assert.equal(parseCode('x'), null);
  assert.equal(parseCode(GOOD_CODE.slice(0, 31)), null); // 少一位
  assert.equal(parseCode(GOOD_CODE + '0'), null); // 多一位
  assert.equal(parseCode('20261108-75238718e41a-a-00000001'), null); // gen 小写
  assert.equal(parseCode('20261108-7523871-e41a-A-00000001'), null); // s12 含连字符
});

// ============================================================================
// 六、sessionKeyOfCode —— 会话归组键（去掉序号的三段）
// ============================================================================

test('sessionKeyOfCode：返回不含序号的三段（日期-短id-代差）', () => {
  // 守：同一会话所有记录必须归到同一个键；键里含日期（会话开始日）与代差。
  assert.equal(sessionKeyOfCode(GOOD_CODE), '20261108-75238718e41a-A');
  assert.equal(sessionKeyOfCode(GOOD_CODE).split(SEP).length, 3);
  assert.equal(sessionKeyOfCode(GOOD_CODE).length, 8 + 1 + 12 + 1 + 1);
});

test('sessionKeyOfCode：同一会话不同 seq → 同一个键', () => {
  // 守：归组键不能掺进序号，否则"一个会话"会被拆成 N 个键。
  assert.equal(sessionKeyOfCode(codeOf(1)), sessionKeyOfCode(codeOf(2)));
  assert.equal(sessionKeyOfCode(codeOf(1)), sessionKeyOfCode(codeOf(99999999)));
});

test('sessionKeyOfCode：不同会话/不同代差 → 不同键', () => {
  // 守：撞车的两个会话靠代差区分，键里必须含 gen，不许把它们合并。
  const other = codeOf(1, { s12: 'abcdefghijkl' });
  const otherGen = codeOf(1, { gen: 'B' });
  const key = sessionKeyOfCode(GOOD_CODE);
  assert.notEqual(sessionKeyOfCode(other), key);
  assert.notEqual(sessionKeyOfCode(otherGen), key);
});

test('sessionKeyOfCode：非法编码返回空串', () => {
  // 守：非法输入返回 ""（与 parseCode 的 null 区分开），调用方好统一做 truthy 判断。
  assert.equal(sessionKeyOfCode(null), '');
  assert.equal(sessionKeyOfCode(''), '');
  assert.equal(sessionKeyOfCode('x'), '');
  assert.equal(sessionKeyOfCode(GOOD_CODE.slice(0, 31)), '');
});

// ============================================================================
// 七、nextGen —— 代差分配（同一短 id 撞车时递增字母）
// ============================================================================

test('nextGen：空台账 → A', () => {
  // 守：新 s12 首次出现必须拿 A。
  assert.equal(nextGen([], S12, SID), 'A');
  assert.equal(nextGen(undefined, S12, SID), 'A');
  assert.equal(nextGen(null, S12, SID), 'A'); // 非数组按空处理，不抛错
});

test('nextGen：同一会话重放 → 沿用原代差（幂等关键）', () => {
  // 守：同一 sid 重跑时必须拿到同一个 gen，否则生成的 code 会变，幂等闸门失效。
  const existing = [{ s12: S12, gen: 'A', sid: SID }];
  assert.equal(nextGen(existing, S12, SID), 'A');
  // 不管 A 被别的会话占了几个，本会话自己的字母不变。
  const mixed = [
    { s12: S12, gen: 'A', sid: 'session-aaaaaaaaaaaa' },
    { s12: S12, gen: 'B', sid: SID },
  ];
  assert.equal(nextGen(mixed, S12, SID), 'B');
});

test('nextGen：不同会话撞上同一 s12 → 依次拿 B、C', () => {
  // 守：12 位短 id 碰撞（概率约 0.18%/百万会话）时，两个会话绝不能写到同一套主键。
  const a = [{ s12: S12, gen: 'A', sid: 'session-aaaaaaaaaaaa' }];
  assert.equal(nextGen(a, S12, 'session-bbbbbbbbbbbb'), 'B');

  const ab = [
    ...a,
    { s12: S12, gen: 'B', sid: 'session-bbbbbbbbbbbb' },
  ];
  assert.equal(nextGen(ab, S12, 'session-cccccccccccc'), 'C');
});

test('nextGen：只把相同 s12 的记录算进占用（不同短 id 互不影响）', () => {
  // 守：代差按 s12 分区；别的会话占用的字母不该逼本会话跳号。
  const existing = [
    { s12: 'aaaaaaaaaaaa', gen: 'A', sid: 'session-aaaaaaaaaaaa' },
    { s12: 'aaaaaaaaaaaa', gen: 'B', sid: 'session-bbbbbbbbbbbb' },
  ];
  assert.equal(nextGen(existing, S12, SID), 'A');
});

test('nextGen：26 个字母用尽 → 空串（让调用方报错，不许静默瞎给）', () => {
  // 守：极端情况必须显式失败；返回 '' 后 index.js 会记 gen exhausted 并跳过该会话。
  const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((g, i) => ({
    s12: S12,
    gen: g,
    sid: 'session-other-' + i,
  }));
  assert.equal(nextGen(all, S12, 'session-brand-new'), '');
  // 只剩最后一个字母时还应给得出 Z。
  assert.equal(nextGen(all.slice(0, 25), S12, 'session-brand-new'), 'Z');
});

test('nextGen：脏记录（null/非法 gen）不崩，且不被当成占用', () => {
  // 守：台账文件可能被手工编辑过；坏行不能让定时器抛异常停摆。
  const dirty = [null, undefined, { s12: S12, gen: 'a', sid: 'session-xxxxxxxxxxxx' }];
  assert.equal(nextGen(dirty, S12, SID), 'A');
  // 非法 gen 也不该把合法字母表占掉。
  assert.equal(nextGen(dirty, S12, 'session-yyyyyyyyyyyy'), 'A');
});

// ============================================================================
// 八、nextSeq —— 会话内序号（跨天不重置，按 s12+gen 隔离）
// ============================================================================

test('nextSeq：空台账 → 1', () => {
  // 守：序号从 1 起（编码里不允许 00000000）。
  assert.equal(nextSeq([], S12, 'A'), 1);
  assert.equal(nextSeq(undefined, S12, 'A'), 1);
  assert.equal(nextSeq(null, S12, 'A'), 1);
});

test('nextSeq：接着最大序号 +1', () => {
  // 守：简单递增不跳号；重放时同一轮由 (sid,turn) 闸门挡住，序号不应被消耗两次。
  assert.equal(nextSeq([{ s12: S12, gen: 'A', seq: 7 }], S12, 'A'), 8);
  assert.equal(
    nextSeq(
      [
        { s12: S12, gen: 'A', seq: 3 },
        { s12: S12, gen: 'A', seq: 9 },
        { s12: S12, gen: 'A', seq: 5 },
      ],
      S12,
      'A'
    ),
    10
  );
});

test('nextSeq：跨天不重置 —— 不同日期的记录继续往后接', () => {
  // 守：2026-11-08 定稿：序号是【会话内】计数，跨天照加。
  // 若实现偷偷按日期过滤，午夜后序号会从 1 重来，主键直接撞车。
  const crossDay = [
    { date: '20261107', s12: S12, gen: 'A', seq: 9 },
    { date: '20261108', s12: S12, gen: 'A', seq: 2 },
  ];
  assert.equal(nextSeq(crossDay, S12, 'A'), 10);
});

test('nextSeq：不同代差互相隔离', () => {
  // 守：代差是两个互不相干的会话，各自的序号不能互相抬高。
  const existing = [
    { s12: S12, gen: 'A', seq: 5 },
    { s12: S12, gen: 'B', seq: 2 },
  ];
  assert.equal(nextSeq(existing, S12, 'A'), 6);
  assert.equal(nextSeq(existing, S12, 'B'), 3);
});

test('nextSeq：不同短 id 互不影响', () => {
  // 守：序号按 s12 分区，别的会话的 seq 再大也不能让本会话跳号。
  assert.equal(nextSeq([{ s12: 'aaaaaaaaaaaa', gen: 'A', seq: 99 }], S12, 'A'), 1);
});

test('nextSeq：忽略非整数/0/负数/字符串/脏记录', () => {
  // 守：seq 只认正整数；坏值不参与取最大，否则会算出 2.5 这种非法序号。
  const dirty = [
    null,
    undefined,
    { s12: S12, gen: 'A', seq: 1.5 },
    { s12: S12, gen: 'A', seq: 0 },
    { s12: S12, gen: 'A', seq: -3 },
    { s12: S12, gen: 'A', seq: '5' }, // 字符串不认
    { s12: S12, gen: 'A', seq: 2 },
  ];
  assert.equal(nextSeq(dirty, S12, 'A'), 3);
});

// ============================================================================
// 九、常量与全链路小样（encoder 内部自洽）
// ============================================================================

test('CONST：长度与分隔符常量必须与生成结果一致', () => {
  // 守：文档/验收清单引用的是 CONST；它若和 makeCode 的真实输出对不上，
  // 所有"按常量校验"的地方都会跟着错。
  assert.equal(CONST.CODE_LENGTH, 32);
  assert.equal(CONST.SEP, '-');
  assert.ok(CONST.CODE_RE instanceof RegExp);
  assert.equal(CONST.CODE_RE.test(GOOD_CODE), true);
  assert.equal(GOOD_CODE.length, CONST.CODE_LENGTH);
});

test('全链路：毫秒 → 日期段/ISO → 短 id → 代差/序号 → 32 位编码 → 反解一致', () => {
  // 守：index.js 落账时的真实调用顺序。任何一步返回 "" 都会让这条链断掉；
  // 这条用例把"各函数单独正确、串起来却错"的情况也罩住。
  const startMs = ms('2026-11-08T09:30:00+08:00');
  const date = dateSegment(startMs);
  const s12 = normalizeSessionId(SID);
  const gen = nextGen([], s12, SID);
  const seq = nextSeq([], s12, gen);
  const code = makeCode({ date, s12, gen, seq });

  assert.equal(date, '20261108');
  assert.equal(s12, S12);
  assert.equal(gen, 'A');
  assert.equal(seq, 1);
  assert.equal(code, GOOD_CODE);
  assert.equal(isValidCode(code), true);
  assert.deepEqual(parseCode(code), { date, s12, gen, seq });
  assert.equal(sessionKeyOfCode(code), '20261108-75238718e41a-A');
  assert.equal(isoTime(startMs), '2026-11-08T09:30:00+08:00');
});
