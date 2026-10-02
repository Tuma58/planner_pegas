// Выручка по КАНОНУ ВЫГРУЗОК (как дашборд; решение руководителя 01.10.2026):
// только выгруженные рейсы (unloaded/done/paid), дата — фактическая выгрузка
// с фолбэком на расчётную (doneTs, МСК), без НДС по ставкам НАСТРОЕК
// калькуляции (обычные 0,22, клиент-«ИП» отдельным словом 0,07, наличные 0).
// Прежняя «методика плитки» (по дате выполнения, с идущими) не используется.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/planner.db', { readOnly: true });
const calc = JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get().value_json);
const ipRe = /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu;
const net = t => Number(t.revenue_vat) / (1 + (t.cash ? 0
  : ipRe.test(t.customer_name || '') ? Number(calc.individualEntrepreneurVatRate ?? 0.07)
  : Number(calc.vatRate ?? 0.22)));
const MSK = 3 * 3600e3;
const doneDay = t => {
  const raw = String(t.unloaded_at || t.ends_at).replace(' ', 'T');
  const ms = Date.parse(raw + (raw.includes('Z') || raw.includes('+') ? '' : 'Z'));
  return new Date(ms + MSK).toISOString().slice(0, 10);
};
const mondayOf = day => {
  const dt = new Date(day + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - (dt.getUTCDay() + 6) % 7);
  return dt.toISOString().slice(0, 10);
};
const trips = db.prepare(`SELECT revenue_vat, cash, customer_name, unloaded_at, ends_at
  FROM trips WHERE status IN ('unloaded','done','paid')`).all();
const P = { aug: ['2026-08-01', '2026-09-01'], sep: ['2026-09-01', '2026-10-01'] };
const out = {};
for (const [key, [from, to]] of Object.entries(P)) {
  const list = trips.filter(t => { const d = doneDay(t); return d >= from && d < to; });
  const total = { n: list.length,
    s: list.reduce((s, t) => s + net(t), 0),
    g: list.reduce((s, t) => s + Number(t.revenue_vat), 0) };
  const weeks = new Map();
  const clients = new Map();
  for (const t of list) {
    const wk = mondayOf(doneDay(t));
    const w = weeks.get(wk) || { wk, n: 0, s: 0 };
    w.n++; w.s += net(t); weeks.set(wk, w);
    const c = clients.get(t.customer_name) || { name: t.customer_name, n: 0, s: 0 };
    c.n++; c.s += net(t); clients.set(t.customer_name, c);
  }
  out[key] = { total,
    weeks: [...weeks.values()].sort((a, b) => a.wk.localeCompare(b.wk)),
    clients: [...clients.values()].sort((a, b) => b.s - a.s).slice(0, 20) };
}
db.close();
console.log(JSON.stringify(out));
