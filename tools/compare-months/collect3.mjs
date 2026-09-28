// Половины сентября: 01–13 и 13–25 (по 12 дней), обе методики выручки.
import { DatabaseSync } from 'node:sqlite';
const sec = await import('/app/src/security.mjs');
const ps = await import('/app/src/planner-service.mjs');
const db = new DatabaseSync('/app/data/planner.db');
const u = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
const token = 'probe-h-' + Date.now();
db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
  .run(sec.tokenHash(token), u.id, new Date(Date.now() + 300000).toISOString());
const api = async path => {
  const r = await fetch('http://localhost:3000' + path, { headers: { cookie: 'planner_session=' + token } });
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
};
const NET = "CASE WHEN t.cash THEN t.revenue_vat WHEN t.customer_name LIKE '%ИП%' THEN t.revenue_vat/1.07 ELSE t.revenue_vat/1.22 END";
const P = { h1: ['2026-09-01', '2026-09-14'], h2: ['2026-09-14', '2026-09-28'] };
const out = {};
for (const [key, [from, to]] of Object.entries(P)) {
  const park = await api(`/api/park-report?from=${from}&to=${to}`);
  const ops = await api(`/api/ops-report?from=${from}&to=${to}`);
  const byEnds = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${NET}),0) s FROM trips t
    WHERE t.status<>'rejected' AND t.ends_at >= ? AND t.ends_at < ?`).get(from, to);
  out[key] = {
    park: park.total, byEnds,
    avgOnline: ops.avgOnline, late: { P: ops.late.P, D: ops.late.D },
    next: ps.nextAssignedShare(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
    gaps: (() => { const g = ps.gapStats(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`); delete g.gaps; return g; })(),
    waterfall: (await api(`/api/reports/speed?from=${from}&to=${to}`)).waterfall
  };
}
db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sec.tokenHash(token));
db.close();
console.log(JSON.stringify(out));
