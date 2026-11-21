/**
 * @file lib/weeklystate.js
 * @role V0.7 周账「草稿/封板」两态的**纯状态与命名函数**（不读写文件，不与 KERNEL 耦合）。
 *
 * 设计：docs/交付-v0.7/03-周账两态与补记执行器设计.md
 *  - 草稿文件名 = `草稿-` + 正式名；封板 = sealed 内容写入临时文件后 rename 正式名；
 *  - 正式名存在（且带封板标记/有 journal）⇒ 封板；正式名无标记且无 journal ⇒ 历史遗留草稿，可 rename 迁移；
 *  - 对账/收据/计数只认正式名（草稿不算"已出周账"）。
 *
 * 本模块只提供命名、分类、迁移决策，供 weekly.js / selfheal / catalog / panelapi 调用。
 */
import { weeklyFileName, weeklyFolderName } from './week.js';

/** 草稿文件名前缀。 */
export const DRAFT_PREFIX = '草稿-';

/** `草稿-` 前缀标记（正式名正则必须排除它）。 */
export function isDraftName(name) {
  return typeof name === 'string' && name.startsWith(DRAFT_PREFIX);
}

/** 正式名（不含路径），与现有规则一致。 */
export function officialNameOf(w, sessKey) {
  return weeklyFileName(w, sessKey);
}

/** 草稿名（不含路径）。 */
export function draftNameOf(w, sessKey) {
  return DRAFT_PREFIX + weeklyFileName(w, sessKey);
}

/** 正式文件相对 root 的路径。 */
export function officialPathOf(root, w, sessKey) {
  return `${weeklyFolderName(w)}/${officialNameOf(w, sessKey)}`;
}

/** 草稿文件相对 root 的路径。 */
export function draftPathOf(root, w, sessKey) {
  return `${weeklyFolderName(w)}/${draftNameOf(w, sessKey)}`;
}

/**
 * 把文件名分类为 official / draft / other。
 * @param {string} name 仅文件名（不含目录）
 */
export function classifyWeeklyName(name) {
  if (typeof name !== 'string' || !name.endsWith('.xlsx')) return 'other';
  if (isDraftName(name)) {
    const rest = name.slice(DRAFT_PREFIX.length);
    return /^\d{2}月第\d+周-.+的周记账\.xlsx$/.test(rest) ? 'draft' : 'other';
  }
  return /^\d{2}月第\d+周-.+的周记账\.xlsx$/.test(name) ? 'official' : 'other';
}

/**
 * 历史迁移决策（纯函数，不碰 FS）。
 *
 * @param {{
 *   officialExists:boolean,
 *   draftExists:boolean,
 *   officialSealed:boolean,   // 正式名内容是否带封板标记（或交叉核验判封板）
 *   journalSealed:boolean     // weekly-seal journal 是否有该 gid
 * }} st
 * @returns {{action:'none'|'migrate-legacy-draft'|'conflict-official-wins'|'warn-marker-lost', reason:string}}
 */
export function decideMigration(st) {
  const s = st && typeof st === 'object' ? st : {};
  const official = s.officialExists === true;
  const draft = s.draftExists === true;
  const sealed = s.officialSealed === true;
  const journal = s.journalSealed === true;

  if (!official && !draft) return { action: 'none', reason: 'no-file' };
  if (draft && !official) return { action: 'none', reason: 'normal-draft' };
  if (official && draft) return { action: 'conflict-official-wins', reason: 'official-and-draft-both-exist' };
  // 只有正式名
  if (sealed || journal) {
    if (sealed) return { action: 'none', reason: 'sealed' };
    return { action: 'warn-marker-lost', reason: 'journal-sealed-but-marker-missing' };
  }
  return { action: 'migrate-legacy-draft', reason: 'legacy-unsealed-official-file' };
}

/**
 * 生成"本组周账应走哪条写入路径"的判定（纯函数）。
 * - sealed：已有封板（正式名 + 标记或 journal）→ 不重写；
 * - draft：无封板 → 写草稿路径；
 * - conflict：正式名与草稿并存 → 不写、告警。
 *
 * @param {{officialExists:boolean, draftExists:boolean, officialSealed:boolean, journalSealed:boolean}} st
 */
export function decideWriteMode(st) {
  const s = st || {};
  if (s.officialExists && (s.officialSealed || s.journalSealed)) return 'sealed';
  if (s.officialExists && s.draftExists) return 'conflict';
  return 'draft';
}
