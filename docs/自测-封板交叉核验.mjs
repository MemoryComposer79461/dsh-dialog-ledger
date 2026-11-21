/**
 * @file 自测-封板交叉核验.mjs
 * @role P1-13 / 审计 M-03 的验收：**封板证据 vs 产物实际内容**逐格比对。
 *
 * @why 在此之前，"已封板"只证明"当初算过"，从不回头看文件里现在写着什么。
 *      用 Excel 打开、改一格机器列、再保存 —— 台账没变、封板 hash 没变、没人会发现。
 *      本文件守三件事：
 *        ① 干净的封板册：交叉核验必须**通过**（否则下面的红没有意义）；
 *        ② 机器列被改一格：必须报 `mismatch`，并指出**哪一行哪一列**；
 *        ③ 行被删掉：必须报 `missing`（不是静默通过）。
 *
 * 纪律：临时 root、合成数据、跑完删目录；**不碰真实账库**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const weekly = await mod('lib/weekly.js');
const sealjournal = await mod('lib/sealjournal.js');
const cross = await mod('freeze/sealcross.js');
const xlsx = await mod('lib/xlsx.js');

const KEY = '75238718e41aA';
const SID = 'session-75238718-e41a-4e8c-8044-50202444455f';
const mk = (n, ts) => ({
  v: 3,
  code: `20261108-75238718e41a-A-${String(n).padStart(8, '0')}`,
  ts, sid: SID, turn: n, seq: n, status: 'ok',
});

function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealcross-'));
  return { dir, root: path.join(dir, 'root') };
}

/** 把工作簿矩阵还原成 buildXlsx 需要的 rows（按最大行列补空）。 */
function matrixToSheets(matrix) {
  const sheets = [];
  for (const [name, cells] of matrix) {
    let maxRow = 0;
    let maxCol = 0;
    for (const ref of cells.keys()) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      maxRow = Math.max(maxRow, Number(m[2]));
      let c = 0;
      for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
      maxCol = Math.max(maxCol, c);
    }
    const rows = [];
    for (let r = 1; r <= maxRow; r += 1) {
      const row = [];
      for (let c = 1; c <= maxCol; c += 1) {
        let n = c;
        let letters = '';
        while (n > 0) { const rem = (n - 1) % 26; letters = String.fromCharCode(65 + rem) + letters; n = Math.floor((n - 1) / 26); }
        row.push(cells.get(letters + r) || '');
      }
      rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

test('P1-13：干净封板册交叉核验通过；改一格机器列必须报 mismatch 并定位；删行必须报 missing', async () => {
  const { root } = lab();

  // 造两条记录 → 封板（走真实 writeWeekly，不用手搓 xlsx）
  const recs = [mk(1, '2026-11-30T10:00:00+08:00'), mk(2, '2026-11-30T11:00:00+08:00')];
  const g = [...weekly.groupRecords(recs, 480).values()][0];
  const sealed = weekly.writeWeekly({
    root, w: g.w, sessKey: g.sessKey, records: recs,
    mode: 'sealed', generatedAt: '2026-11-30 12:00:00', sealedAt: '2026-11-30 12:00:00',
  });
  assert.equal(sealed.sealed, true, '前置：必须真的封板');
  const gid = sealed.groupId;

  const deps = { readEvents: sealjournal.readSealEvents };

  // ① 干净的册子：必须通过
  const ok = cross.crosscheckSeal(root, gid, deps);
  assert.equal(ok.ok, true, `干净封板册必须通过交叉核验（status=${ok.status} reason=${ok.reason} mismatches=${JSON.stringify(ok.mismatches)}）`);
  assert.ok(ok.checked > 0, '至少要核对过机器格');

  // ② 模拟"Excel 重存改了一格"：把 B 列（原始凭证）改成"缺凭证"

  const fileAbs = path.isAbsolute(ok.file) ? ok.file : path.join(root, ok.file);
  const matrix = cross.readWorkbookMatrix(fileAbs);
  const sheets = matrixToSheets(matrix);
  const code = recs[0].code;
  let tampered = false;
  for (const sh of sheets) {
    for (const row of sh.rows) {
      if (String(row[0] || '') === code) {
        // ★ 必须改成**与现值不同**的值：这份夹具的记录没有绑定证据，B 列本来就是"缺凭证"，
        //   如果还写"缺凭证"就等于没改（第一版测试就踩了这个坑，变异没生效还以为比较器坏了）。
        row[1] = String(row[1] || '') === '绑定' ? '缺凭证' : '绑定';
        tampered = true;
      }
    }
  }
  assert.equal(tampered, true, '前置：必须在工作簿里找到该编码行');
  xlsx.writeXlsx(fileAbs, sheets); // 覆盖原文件 = Excel 重存的效果（字节变了，值的语义也变了）

  const bad = cross.crosscheckSeal(root, gid, deps);
  assert.equal(bad.ok, false, '改过机器列的册子绝不允许判通过');
  assert.equal(bad.status, 'mismatch');
  const hit = bad.mismatches.find((m) => m.code === code && m.col === 'B');
  assert.ok(hit, '必须指出是哪一行哪一列不符：' + JSON.stringify(bad.mismatches));
  assert.equal(hit.expected !== hit.actual, true);

  // ③ 删掉一行：必须报 missing（不是静默通过）
  const matrix2 = cross.readWorkbookMatrix(fileAbs);
  const sheets2 = matrixToSheets(matrix2);
  for (const sh of sheets2) {
    sh.rows = sh.rows.filter((row) => String(row[0] || '') !== recs[1].code);
  }
  xlsx.writeXlsx(fileAbs, sheets2);
  const gone = cross.crosscheckSeal(root, gid, deps);
  assert.equal(gone.ok, false, '少了一行也必须判不通过');
  assert.equal(gone.missing.includes(recs[1].code), true, '必须报出缺失的编码：' + JSON.stringify(gone.missing));

  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});
