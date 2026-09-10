// РЕВИЗИЯ 10.09: пробеги и транзиты действующих маршрутов + чистка +
// экономика. Часть 1 — активные (plan/run): км против физики, транзит
// против факта плеча; plan-рейсам чинится и км, и ends_at. Часть 2 —
// закрытые за 60 дн: км-санация (база экономических показателей).
// Часть 3 — пересчёт маржи клиентов до/после: сдвиги сегментов.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DATABASE_PATH);
const straightKm = (a, b, c, d) => { const r = v => v * Math.PI / 180;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(Math.sin(r(c - a) / 2) ** 2 +
    Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2))); };
const point = db.prepare('SELECT latitude, longitude FROM addresses WHERE id=?');
const legKey = (a, b) => [a, b].sort().join('|');
const factor = Math.min(1.45, Math.max(1.05,
  Number(db.prepare(`SELECT value FROM app_meta WHERE key='road_factor_fact'`).get()?.value) || 1.2));
const calc = JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get()?.value_json || '{}');
const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? d : Number(v);
const formulaH = km => (km / num(calc.techSpeedKmh, 50) + 2 * num(calc.handlingHoursPerOperation, 2)) * num(calc.transitFactor, 1.5);
const perOp = num(calc.handlingHoursPerOperation, 2) * num(calc.transitFactor, 1.5);
const gate = (kind, addrId, cust) => {
  if (addrId) { const g = db.prepare(`SELECT median_hours h, samples s FROM gate_facts WHERE key=?`).get(`addr-${kind}:${addrId}`); if (g && g.s >= 2) return g.h; }
  const g = db.prepare(`SELECT median_hours h, samples s FROM gate_facts WHERE key=?`).get(`cust-${kind}:${String(cust || '').trim().toLowerCase()}`);
  return (g && g.s >= 3) ? g.h : null;
};
const smartH = (fa, ta, cust, km) => {
  const leg = fa && ta ? db.prepare(`SELECT median_hours h, hour_samples s FROM leg_fact_km WHERE key=?`).get(legKey(fa, ta)) : null;
  if (!leg || leg.s < 2 || !leg.h) return formulaH(km);
  return (gate('load', fa, cust) ?? perOp) + leg.h + (gate('unload', ta, cust) ?? perOp);
};
const healthyKm = (fa, ta) => {
  const a = point.get(fa); const b = point.get(ta);
  if (!a?.latitude || !b?.latitude) return null;
  const line = straightKm(a.latitude, a.longitude, b.latitude, b.longitude);
  if (line < 30) return null;
  const leg = db.prepare(`SELECT median_km FROM leg_fact_km WHERE key=? AND samples>=2`).get(legKey(fa, ta));
  if (leg && leg.median_km >= line * 1.05 && leg.median_km <= line * 1.65) return { km: leg.median_km, line };
  return { km: Math.round(line * factor), line };
};

console.log('=== ЧАСТЬ 1: АКТИВНЫЕ МАРШРУТЫ ===');
let fixedKm = 0; let fixedEnds = 0; let runWarn = 0;
for (const t of db.prepare(`SELECT t.*, o.from_address_id fa, o.to_address_id ta, o.via_json,
    o.window_to, o.customer_name cust, v.plate
  FROM trips t JOIN orders o ON o.id=t.order_id JOIN vehicles v ON v.id=t.vehicle_id
  WHERE t.status IN ('plan','run') ORDER BY t.starts_at`).all()) {
  if (!t.fa || !t.ta || (t.via_json && t.via_json !== '[]')) continue;
  const h = healthyKm(t.fa, t.ta);
  if (!h) continue;
  const kmBad = t.distance_km > h.km * 1.25 || t.distance_km < h.line * 1.02;
  const smart = smartH(t.fa, t.ta, t.cust, h.km);
  const planH = (Date.parse(t.ends_at) - Date.parse(t.starts_at)) / 3.6e6;
  const minEnd = Math.max(Date.parse(t.starts_at) + smart * 3.6e6, Date.parse(t.window_to || 0));
  const transitBad = planH < smart * 0.7 || planH > smart * 1.6;
  if (!kmBad && !transitBad) continue;
  console.log(`№${t.order_no || '?'} ${t.plate} ${t.status} ${(t.cust || '').slice(0, 18)}:` +
    (kmBad ? ` км ${Math.round(t.distance_km)}→${h.km}` : ` км ${Math.round(t.distance_km)} ок`) +
    (transitBad ? ` | транзит план ${Math.round(planH)}ч при факте плеча ~${Math.round(smart)}ч` : ''));
  if (kmBad) {
    db.prepare(`UPDATE trips SET distance_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(h.km, t.id);
    db.prepare(`UPDATE orders SET planned_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(h.km, t.order_id);
    fixedKm += 1;
  }
  if (transitBad && t.status === 'plan') {
    db.prepare(`UPDATE trips SET ends_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(new Date(minEnd).toISOString(), t.id);
    fixedEnds += 1;
  } else if (transitBad) runWarn += 1;
}
console.log(`исправлено: км ${fixedKm}, сроков (plan) ${fixedEnds}; run с кривым сроком (не трогал) ${runWarn}`);

console.log('\n=== ЧАСТЬ 2: ЗАКРЫТЫЕ 60 ДН (база экономики) ===');
let fixedClosed = 0;
for (const t of db.prepare(`SELECT t.id, t.order_id, t.distance_km, o.from_address_id fa, o.to_address_id ta
  FROM trips t JOIN orders o ON o.id=t.order_id
  WHERE t.status IN ('unloaded','done','paid')
    AND COALESCE(t.unloaded_at, t.ends_at) > datetime('now','-60 days')
    AND o.from_address_id IS NOT NULL AND o.to_address_id IS NOT NULL
    AND COALESCE(o.via_json,'[]')='[]' AND t.distance_km > 0`).all()) {
  const h = healthyKm(t.fa, t.ta);
  if (!h || t.distance_km <= h.line * 1.65) continue;
  db.prepare(`UPDATE trips SET distance_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(h.km, t.id);
  db.prepare(`UPDATE orders SET planned_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(h.km, t.order_id);
  fixedClosed += 1;
}
console.log(`закрытых рейсов с раздутым км вылечено: ${fixedClosed}`);

console.log('\n=== ЧАСТЬ 3: СДВИГ ЭКОНОМИКИ (маржа/сутки клиентов) ===');
const varCost = num(calc.costPerKm, 55) + num(calc.insuranceAndRoadsPerKm, 6) +
  num(calc.driverPerTripDay, 4500) / Math.max(200, num(calc.dailyMileageKm, 600) || 600);
const byCust = new Map();
for (const t of db.prepare(`SELECT customer_name, revenue_vat,
    COALESCE(actual_distance_km, distance_km) km, starts_at, unloaded_at
  FROM trips WHERE status IN ('unloaded','done','paid') AND unloaded_at IS NOT NULL
    AND starts_at >= datetime('now','-60 day')`).all()) {
  if (!t.km || t.km < 20) continue;
  const durD = Math.max((Date.parse(t.unloaded_at) - Date.parse(t.starts_at)) / 86.4e6, t.km / 800 + 0.25);
  const key = String(t.customer_name || '').trim().toLowerCase();
  if (!byCust.has(key)) byCust.set(key, []);
  byCust.get(key).push((t.revenue_vat / 1.22 - t.km * varCost) / durD);
}
const margins = [];
const rows = [];
for (const [key, list] of byCust) {
  if (list.length < 3) continue;
  list.sort((a, b) => a - b);
  const m = list[Math.floor(list.length / 2)];
  margins.push(m); rows.push({ key, m, n: list.length });
}
margins.sort((a, b) => a - b);
const parkMedian = margins[Math.floor(margins.length / 2)] || 18000;
const thA = Math.min(40000, Math.max(12000, parkMedian * 1.1));
const thB = Math.min(20000, Math.max(6000, parkMedian * 0.55));
const prev = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key='customer_segments_prev'`).get()?.value || '{}');
console.log(`медиана парка теперь: ${Math.round(parkMedian / 100) / 10} т₽/сут | пороги A ≥${Math.round(thA / 1000)} B ≥${Math.round(thB / 1000)}`);
for (const r of rows.sort((a, b) => a.m - b.m)) {
  const seg = r.m >= thA ? 'A' : r.m >= thB ? 'B' : r.m >= 0 ? 'C' : 'D';
  if (prev[r.key] && prev[r.key] !== seg) {
    console.log(`  сегмент: ${r.key.slice(0, 28)} ${prev[r.key]} → ${seg} (маржа ${Math.round(r.m / 1000)} т₽/сут, ${r.n} рейс.)`);
  }
}
