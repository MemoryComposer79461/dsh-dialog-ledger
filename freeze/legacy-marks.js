/**
 * @file legacy-marks.js
 * @role **legacy 基线标记**（V0.6 / D18 修正）：用"正面证据"区分「历史行本来就没有绑定证据」与「有人把证据字段删了想洗成 legacy」。
 *
 * @why 为什么必须有这个文件：
 *   D18 初版按"缺证据字段"来判定 legacy（`LEGACY_NO_ATTACHMENT`）——这意味着**删掉字段就能洗白**。
 *   2026-11-10 实证：把一条 v0.5 台账行的 `docFileSha256/docSha256/attachment` 删掉，
 *   reconcile 立刻把它归入 legacy、不计缺凭证（攻击成功）。
 *   审计上只有一个正确解法：**不能只凭"没有证据"就认定"本来就没有证据"**。
 *   必须先有一次**可审计的标记动作**，把当时确实缺证据的历史行写成一份 append-only、哈希链封存的基线；
 *   之后只有"基线里明确记过、且行指纹未变"的行才算 legacy，其余无证据行一律按缺凭证报。
 *
 * @file 位置：`<root>/ledger/.legacy-marks.jsonl`（隐藏名 → readAll 不会当台账读）。
 *   每行：`{v,at,code,rowFingerprint,sid,turn,status,reason,by,prevHash,hash}`；
 *   `hash = sha256(固定字段顺序的 JSON)`，`prevHash` 接上一条的 `hash` → 链断=基线被改过。
 *
 * @只读/写边界：本模块只读写 `.legacy-marks.jsonl`；**绝不改台账/原文/周账/封板**。
 *
 * @depends node:fs、node:path、node:crypto、./weekly.js（复用 hasBindingEvidence）、./ledger.js（只读 readAll）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasBindingEvidence } from '../lib/weekly.js';
import { readAll } from '../lib/ledger.js';

export const LEGACY_MARKS_VERSION = 1;
export const LEGACY_MARKS_REL = path.join('ledger', '.legacy-marks.jsonl');
export const LEGACY_REASON = 'NO_BINDING_EVIDENCE';
export const DEFAULT_BY = '工具-标记legacy基线.mjs';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 台账行指纹：稳定序列化（键排序）后 sha256 —— 行内容一改，指纹就变。 */
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
export function rowFingerprint(rec) {
  return sha256hex(stableStringify(rec));
}

function stamp(ms) {
  const d = new Date(ms + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

export function legacyMarksPath(root) {
  return path.join(root, LEGACY_MARKS_REL);
}

/** 基线记录的签名（固定字段顺序，供写入与校验两侧共用）。 */
function canonical(m) {
  return JSON.stringify({
    v: m.v, at: m.at, code: m.code, rowFingerprint: m.rowFingerprint,
    sid: m.sid, turn: m.turn, status: m.status, reason: m.reason, by: m.by, prevHash: m.prevHash,
  });
}
export function markHash(m) {
  return sha256hex(canonical(m));
}

/**
 * 读基线（只读）。
 * @returns {{ok:boolean, path:string, exists:boolean, records:object[], byCode:Map<string,object>,
 *            chainOk:boolean, badLines:number, chainBreakAt:number, count:number, duplicates:number}}
 */
export function readLegacyMarks(root) {
  const p = legacyMarksPath(root);
  const out = {
    ok: true, path: p, exists: false, records: [], byCode: new Map(),
    chainOk: true, badLines: 0, chainBreakAt: 0, count: 0, duplicates: 0,
  };
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return out; } // 不存在 = 未标记（不是错误）
  out.exists = true;
  let prev = '';
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let m;
    try { m = JSON.parse(lines[i]); } catch { out.badLines++; out.ok = false; continue; }
    out.records.push(m);
    out.count++;
    if (m.hash !== markHash(m)) { if (out.chainOk) out.chainBreakAt = i + 1; out.chainOk = false; out.ok = false; }
    if (String(m.prevHash || '') !== prev) { if (out.chainOk) out.chainBreakAt = i + 1; out.chainOk = false; out.ok = false; }
    prev = String(m.hash || '');
    if (m.code) {
      if (out.byCode.has(m.code)) out.duplicates++;
      out.byCode.set(m.code, m); // 同 code 以最后一条为准
    }
  }
  return out;
}

/**
 * 扫台账，列出"缺绑定证据"的行（只读，不写任何东西）。
 * @returns {{ok:boolean, reason?:string, scanned:number, candidates:Array<{code,rec,fingerprint}>,
 *            readErrors:number, badLines:number}}
 */
export function collectLegacyCandidates(root) {
  const all = readAll(root, { repairTornTail: false });
  if (!all || all.ok !== true) {
    return { ok: false, reason: 'ledger-unreadable', scanned: 0, candidates: [], readErrors: (all && all.readErrors || []).length, badLines: Number(all && all.badLines) || 0 };
  }
  const byCode = new Map();
  for (const rec of all.records) {
    const code = String(rec && rec.code || '');
    if (!code) continue;
    const v = Number.isInteger(rec.version) ? rec.version : 1;
    const prev = byCode.get(code);
    if (!prev || v >= (Number.isInteger(prev.version) ? prev.version : 1)) byCode.set(code, rec);
  }
  const candidates = [];
  for (const [code, rec] of byCode) {
    if (hasBindingEvidence(rec).ok) continue;
    candidates.push({ code, rec, fingerprint: rowFingerprint(rec) });
  }
  return { ok: true, scanned: all.records.length, candidates, readErrors: (all.readErrors || []).length, badLines: Number(all.badLines) || 0 };
}

/**
 * 追加 legacy 基线（append-only + 哈希链 + fsync）。
 * @param {string} root
 * @param {Array<{code:string, fingerprint:string, sid?:string, turn?:number|null, status?:string, by?:string, nowMs?:number}>} entries
 * @returns {{ok:boolean, appended:number, skipped:number, conflicts:Array, path:string, chainOk:boolean, reason?:string}}
 */
export function appendLegacyMarks(root, entries) {
  const p = legacyMarksPath(root);
  const existing = readLegacyMarks(root);
  const out = { ok: true, appended: 0, skipped: 0, conflicts: [], path: p, chainOk: existing.chainOk };
  if (!existing.chainOk) return { ...out, ok: false, reason: 'marks-chain-broken' };
  let prev = existing.records.length ? String(existing.records[existing.records.length - 1].hash || '') : '';
  const lines = [];
  for (const e of (Array.isArray(entries) ? entries : [])) {
    const code = String(e && e.code || '');
    const fp = String(e && e.fingerprint || '');
    if (!code || !/^[0-9a-f]{64}$/.test(fp)) { out.conflicts.push({ code, reason: 'bad-entry' }); continue; }
    const old = existing.byCode.get(code);
    if (old && old.rowFingerprint === fp) { out.skipped++; continue; }
    if (old && old.rowFingerprint !== fp) { out.conflicts.push({ code, reason: 'row-changed-since-marked', oldFingerprint: old.rowFingerprint, newFingerprint: fp }); continue; }
    const m = {
      v: LEGACY_MARKS_VERSION,
      at: stamp(Number.isFinite(e.nowMs) ? e.nowMs : Date.now()),
      code,
      rowFingerprint: fp,
      sid: String(e.sid || ''),
      turn: Number.isInteger(e.turn) ? e.turn : null,
      status: String(e.status || ''),
      reason: LEGACY_REASON,
      by: String(e.by || DEFAULT_BY),
      prevHash: prev,
      hash: '',
    };
    m.hash = markHash(m);
    prev = m.hash;
    lines.push(JSON.stringify(m));
  }
  if (out.conflicts.length > 0) return { ...out, ok: false, reason: 'conflicts' };
  if (lines.length === 0) return out;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'a');
    try {
      fs.writeSync(fd, lines.join('\n') + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return { ...out, ok: false, reason: 'write-failed: ' + (err && err.message ? err.message : String(err)) };
  }
  out.appended = lines.length;
  out.chainOk = true;
  return out;
}

/**
 * 一行台账在基线里的状态（给 reconcile 用）：
 * 'marked'（指纹一致，可算 legacy）｜'mismatch'（标过但行已变）｜'unmarked'（没标过）
 */
export function markStatus(marks, code, fingerprint) {
  const m = marks && marks.byCode ? marks.byCode.get(code) : null;
  if (!m) return 'unmarked';
  return m.rowFingerprint === fingerprint ? 'marked' : 'mismatch';
}
