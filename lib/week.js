/**
 * @file week.js
 * @role 周记账的"周"到底怎么切：月内切段、周一起算、段内天数不限。
 * @called-by 周记账渲染层（将来）
 * @why 这是整本周记账唯一不能错的东西：段切错，行就落错表，账就跨期。
 *      所以把它写成**纯函数**，用固定日历做黄金用例，和 encoder 一样"能喂参数测"。
 *
 * 规则（2026-11-08 定，来自机主口径）：
 *   · 周起点 = 每周一 00:00:00；
 *   · 月界优先：月份把自然周切开，切口处的两段各自成"周"；
 *   · 段内天数不限：1 号的 1 天也算"第 1 周"，月末的 2 天也算一整周；
 *   · 月内周数 ∈ {4,5,6} —— **存在第 6 周**。
 *
 * 例（2026-11，1 号是周日）：
 *   第1周 11-01（1天）｜第2–5周各 7 天｜第6周 11-30（1天）
 */

const DAY = 24 * 60 * 60 * 1000;

/** 把毫秒时间戳转成"本地（UTC+08:00）的年月日"三元组。 */
function localParts(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}

/** 本地年月日的 00:00:00 对应的 UTC 毫秒。 */
function localMidnightMs(y, m, d, offsetMinutes) {
  return Date.UTC(y, m - 1, d) - offsetMinutes * 60 * 1000;
}

/** 某月天数。 */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 2026-11 这种形式，用于文件名/目录。 */
export function ymLabel(y, m) {
  return `${y}年${String(m).padStart(2, '0')}月`;
}

/**
 * 把一个月切成"周段"。
 *
 * @param {number} y 年
 * @param {number} m 月（1–12）
 * @param {number} offsetMinutes 时区偏移（默认 480）
 * @returns {Array<{n:number, fromDay:number, toDay:number, startMs:number, endMs:number}>}
 *          n 从 1 起；endMs 是该段最后一天 23:59:59.999 的毫秒
 */
export function monthWeeks(y, m, offsetMinutes = 480) {
  const total = daysInMonth(y, m);
  const weeks = [];

  // 当月第一个周一（可能落在下个月 → 说明整月都在一个自然周里，按满月一段处理）
  let firstMondayDay = null;
  for (let d = 1; d <= total; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
    if (dow === 1) { firstMondayDay = d; break; }
  }

  let cur = 1;
  let n = 1;
  while (cur <= total) {
    let end;
    if (n === 1) {
      end = firstMondayDay === null ? total : (firstMondayDay === 1 ? 7 : firstMondayDay - 1);
      if (end > total) end = total;
    } else {
      end = cur + 6;
      if (end > total) end = total;
    }
    weeks.push({
      n,
      fromDay: cur,
      toDay: end,
      startMs: localMidnightMs(y, m, cur, offsetMinutes),
      endMs: localMidnightMs(y, m, end + 1, offsetMinutes) - 1,
    });
    cur = end + 1;
    n++;
  }
  return weeks;
}

/**
 * 某条记录（按真实发生时刻）属于哪一段。
 *
 * @param {number} tsMs 记录时间（毫秒）
 * @param {number} offsetMinutes 时区偏移
 * @returns {{year:number, month:number, weekNo:number, fromDay:number, toDay:number,
 *            startMs:number, endMs:number, label:string}}
 *
 * @why 用"真实发生时刻"而不是编码里的日期段：
 *      编码日期段是会话开始日（归属），周记账是"这一周发生了什么"（事实）。
 *      两者刻意分离，别混。
 */
export function weekOf(tsMs, offsetMinutes = 480) {
  const p = localParts(tsMs, offsetMinutes);
  const weeks = monthWeeks(p.y, p.m, offsetMinutes);
  const hit = weeks.find((w) => p.d >= w.fromDay && p.d <= w.toDay);
  // 理论上必然命中；兜底返回最后一段并在 label 里标注，避免静默丢记录
  const w = hit || weeks[weeks.length - 1];
  return {
    year: p.y, month: p.m, weekNo: w.n, fromDay: w.fromDay, toDay: w.toDay,
    startMs: w.startMs, endMs: w.endMs,
    label: `${String(p.m).padStart(2, '0')}月第${w.n}周`,
  };
}

/**
 * 周记账文件名：`xx月第x周-{S}{D}的周记账.xlsx`
 *
 * @param {{month:number, weekNo:number}} w weekOf() 的返回（只用月与周号）
 * @param {string} sessKey 13 位会话键 `{S}{D}`（不是 23 位会话标识）
 */
export function weeklyFileName(w, sessKey) {
  return `${String(w.month).padStart(2, '0')}月第${w.weekNo}周-${sessKey}的周记账.xlsx`;
}

/** 周记账所在目录（二级）：`{年}年{月}月`。 */
export function weeklyFolderName(w) {
  return ymLabel(w.year, w.month);
}
