/**
 * @file 校验.mjs
 * @role 黄金样本校验器 —— **不依赖 DSH、不依赖插件运行时**，只依赖 encoder 的纯函数。
 * @called-by 人工 / CI / 任何一次重写后的回归
 * @why 旧账不迁移，但必须"永远可验证"。这个文件就是那个"裁判"：
 *      任何一次改编码逻辑（哪怕换语言重写），先跑它，红了就别往下走。
 *
 * 用法：node 校验.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const enc = await import(pathToFileURL(path.join(SRC, 'lib', 'encoder.js')).href);

const OFFSET = 480; // UTC+08:00
const spec = JSON.parse(fs.readFileSync(path.join(HERE, '用例.json'), 'utf8'));

/**
 * 跑一遍全部用例。
 *
 * @returns {{total:number, pass:number, fails:Array<object>}}
 *
 * @why 既给 CLI 用，也给 `node --test` 用：
 *      同一个裁判两处调用，才不会出现"脚本绿、测试红"这种两套标准。
 */
export function verify() {
  let pass = 0;
  const fails = [];
  // 与 runOnce 相同的演进顺序：跨用例累积 existing，代差/序号才会按生产逻辑走
  const existing = [];

  for (const c of spec.用例) {
    const createdAt = Date.parse(c.createdAt);
    const dateSeg = enc.dateSegment(createdAt, OFFSET);
    const s12 = enc.normalizeSessionId(c.sid);
    const gen = enc.nextGen(existing, s12, c.sid);

    c.轮次.forEach((t, i) => {
      const seq = enc.nextSeq(existing, s12, gen);
      const code = enc.makeCode({ date: dateSeg, s12, gen, seq });
      const exp = c.期望[i];

      const okCode = code === exp.code;
      const okDate = dateSeg === exp.dateSeg;
      const okValid = enc.isValidCode(code);
      const parsed = enc.parseCode(code);
      const okParse = !!parsed && parsed.s12 === s12 && parsed.gen === gen && parsed.seq === seq;

      if (okCode && okDate && okValid && okParse) {
        pass++;
      } else {
        fails.push({
          用例: c.名称, turn: t.turn,
          期望: exp.code, 实际: code,
          细节: { okCode, okDate, okValid, okParse, dateSeg, gen, seq },
        });
      }
      existing.push({ s12, gen, seq, sid: c.sid });
    });
  }
  return { total: pass + fails.length, pass, fails };
}

// CLI：node 校验.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = verify();
  console.log(`黄金样本：${r.pass}/${r.total} 通过`);
  if (r.fails.length) {
    for (const f of r.fails) console.log('  ✗', JSON.stringify(f));
    process.exitCode = 1;
  } else {
    console.log('结论：编码规则与冻结样本一致（日期段=会话开始日、23 位会话标识 + 序号 = 32 位）');
  }
}
