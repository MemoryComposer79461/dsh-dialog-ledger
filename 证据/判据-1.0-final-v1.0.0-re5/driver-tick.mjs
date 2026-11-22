import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [,, LITE, home, root, ticksArg, weeklyArg, receiptArg] = process.argv;
const ticks = Number(ticksArg || '1');
process.env.DSH_HOME = home;
const idx = await import(pathToFileURL(path.join(LITE, 'index.js')).href);
const cfg = {
  root, intervalSeconds: 60, offsetMinutes: 480, hotWindowSeconds: 0, quietSeconds: 0,
  scanBudgetMs: 0, maxBytesPerSession: 0, checkupEnabled: false,
  weeklyEnabled: weeklyArg === '1', handoverEnabled: false, receiptAnchorRoot: receiptArg || '',
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const out = [];
for (let i = 0; i < ticks; i += 1) {
  try {
    const s = await idx.runOnce({ logger }, cfg);
    out.push({ ok: true, written: s && s.written, handoverGenerated: s && s.handoverGenerated,
      handoverAdopted: s && s.handoverAdopted, handoverSkipped: s && s.handoverSkipped,
      handoverSealedTotal: s && s.handoverSealedTotal, errors: (s && s.errors) || [] });
  } catch (e) {
    out.push({ ok: false, crash: String((e && e.message) || e) });
  }
}
console.log(JSON.stringify({ ticks: out }));
