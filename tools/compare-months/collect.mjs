// Сбор данных для Excel-сравнения август/сентябрь (выполняется на проде).
import { DatabaseSync } from 'node:sqlite';
const sec = await import('/app/src/security.mjs');
const ps = await import('/app/src/planner-service.mjs');
const db = new DatabaseSync('/app/data/planner.db');
const u = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
const token = 'probe-xlsx-' + Date.now();
db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
  .run(sec.tokenHash(token), u.id, new Date(Date.now() + 300000).toISOString());
const api = async path => {
  const r = await fetch('http://localhost:3000' + path, { headers: { cookie: 'planner_session=' + token } });
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
};
const P = { aug: ['2026-08-01', '2026-09-01'], sep: ['2026-09-01', '2026-09-28'] };
const out = { periods: P };
for (const [key, [from, to]] of Object.entries(P)) {
  const park = await api(`/api/park-report?from=${from}&to=${to}`);
  const ops = await api(`/api/ops-report?from=${from}&to=${to}`);
  const speed = await api(`/api/reports/speed?from=${from}&to=${to}`);
  const drivers = await api(`/api/reports/drivers?from=${from}&to=${to}`);
  const next = ps.nextAssignedShare(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
  const gaps = ps.gapStats(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
  delete gaps.gaps;
  // автоназначение: решения по черновикам за период
  const auto = db.prepare(`SELECT outcome, COUNT(*) c FROM assign_drafts
    WHERE outcome IS NOT NULL AND COALESCE(override_reason,'')<>'auto'
      AND resolved_at >= ? AND resolved_at < ? GROUP BY outcome`).all(from, to);
  // стыки по зонам выгрузки
  const zone = (() => {
    const byV = new Map();
    for (const t of db.prepare(`SELECT t.vehicle_id, t.starts_at, t.unloaded_at, z.name zone
        FROM trips t LEFT JOIN zones z ON z.id=t.to_zone_id
        WHERE t.status<>'rejected' AND t.starts_at >= datetime(?, '-40 day') AND t.starts_at < datetime(?, '+10 day')
        ORDER BY t.vehicle_id, t.starts_at`).all(from, to)) {
      if (!byV.has(t.vehicle_id)) byV.set(t.vehicle_id, []);
      byV.get(t.vehicle_id).push(t);
    }
    const zones = new Map();
    for (const list of byV.values()) for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if (!a.unloaded_at || a.unloaded_at < from || a.unloaded_at >= to) continue;
      const g = (Date.parse(b.starts_at) - Date.parse(String(a.unloaded_at).replace(' ', 'T'))) / 3.6e6;
      if (!(g >= 0 && g <= 168)) continue;
      const k = a.zone || '—';
      if (!zones.has(k)) zones.set(k, []);
      zones.get(k).push(g);
    }
    return [...zones.entries()].filter(([, l]) => l.length >= 8).map(([name, l]) => {
      l.sort((x, y) => x - y);
      return { name, pairs: l.length, medianH: Math.round(l[Math.floor(l.length / 2)] * 10) / 10 };
    }).sort((a, b) => b.pairs - a.pairs);
  })();
  out[key] = {
    park: park.total, weeks: park.weeks, clients: park.clients.slice(0, 15),
    avgOnline: ops.avgOnline, downtime: ops.downtime, late: { P: ops.late.P, D: ops.late.D },
    trend: ops.trend ? { day: { rev: undefined }, week: undefined } : null,
    speedByVehicle: speed.byVehicle, waterfall: speed.waterfall, norms: speed.norms ? { vt: speed.norms.vt, ve: speed.norms.ve, vroad: speed.norms.vroad, disciplinePct: speed.norms.disciplinePct } : null,
    drivers: drivers.drivers, driversPark: drivers.park,
    next, gaps, auto, zoneGaps: zone
  };
}
db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sec.tokenHash(token));
db.close();
console.log(JSON.stringify(out));
