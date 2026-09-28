// Выручка по дате ВЫПОЛНЕНИЯ (методика плитки руководителя): периоды,
// недели, клиенты. Закрытые + идущие (run) — как netRevenue снимка.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/planner.db', { readOnly: true });
const NET = "CASE WHEN t.cash THEN t.revenue_vat WHEN t.customer_name LIKE '%ИП%' THEN t.revenue_vat/1.07 ELSE t.revenue_vat/1.22 END";
const P = { aug: ['2026-08-01', '2026-09-01'], sep: ['2026-09-01', '2026-09-28'], sepFull: ['2026-09-01', '2026-10-01'] };
const out = {};
for (const [key, [from, to]] of Object.entries(P)) {
  const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${NET}),0) s FROM trips t
    WHERE t.status<>'rejected' AND t.ends_at >= ? AND t.ends_at < ?`).get(from, to);
  const weeks = db.prepare(`SELECT date(t.ends_at, '-' || ((CAST(strftime('%w', t.ends_at) AS INTEGER) + 6) % 7) || ' days') wk,
      COUNT(*) n, COALESCE(SUM(${NET}),0) s FROM trips t
    WHERE t.status<>'rejected' AND t.ends_at >= ? AND t.ends_at < ?
    GROUP BY wk ORDER BY wk`).all(from, to);
  const clients = db.prepare(`SELECT t.customer_name name, COUNT(*) n, COALESCE(SUM(${NET}),0) s FROM trips t
    WHERE t.status<>'rejected' AND t.ends_at >= ? AND t.ends_at < ?
    GROUP BY t.customer_name ORDER BY s DESC LIMIT 20`).all(from, to);
  out[key] = { total, weeks, clients };
}
db.close();
console.log(JSON.stringify(out));
