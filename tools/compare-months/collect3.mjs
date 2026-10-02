// Половины сентября (финал): 01–15 и 16–30 (по 15 дней); выручка — по
// канону выгрузок (как дашборд), см. collect2.mjs.
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
const calc = JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get().value_json);
const ipRe = /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu;
const netOf = t => Number(t.revenue_vat) / (1 + (t.cash ? 0
  : ipRe.test(t.customer_name || '') ? Number(calc.individualEntrepreneurVatRate ?? 0.07)
  : Number(calc.vatRate ?? 0.22)));
const doneDay = t => {
  const raw = String(t.unloaded_at || t.ends_at).replace(' ', 'T');
  const ms = Date.parse(raw + (raw.includes('Z') || raw.includes('+') ? '' : 'Z'));
  return new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
};
const doneTrips = db.prepare(`SELECT revenue_vat, cash, customer_name, unloaded_at, ends_at
  FROM trips WHERE status IN ('unloaded','done','paid')`).all();
const P = { h1: ['2026-09-01', '2026-09-16'], h2: ['2026-09-16', '2026-10-01'] };
const out = {};
for (const [key, [from, to]] of Object.entries(P)) {
  const park = await api(`/api/park-report?from=${from}&to=${to}`);
  const ops = await api(`/api/ops-report?from=${from}&to=${to}`);
  const list = doneTrips.filter(t => { const d = doneDay(t); return d >= from && d < to; });
  const byCanon = { n: list.length, s: list.reduce((s2, t) => s2 + netOf(t), 0) };
  out[key] = {
    park: park.total, byCanon,
    avgOnline: ops.avgOnline, late: { P: ops.late.P, D: ops.late.D },
    next: ps.nextAssignedShare(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
    gaps: (() => { const g = ps.gapStats(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`); delete g.gaps; return g; })(),
    waterfall: (await api(`/api/reports/speed?from=${from}&to=${to}`)).waterfall
  };
}
db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sec.tokenHash(token));
db.close();
console.log(JSON.stringify(out));
