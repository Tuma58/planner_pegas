// АУДИТ МАСШТАБА раздутых километров (read-only, кейс 10.09 «Пенза→Москва
// 1 055 км»). Запуск на сервере:
//   docker exec -i pegas-planner-planner-1 node --input-type=module - < tools/audit-km.mjs
// Показывает: (1) все плечи справочника с медианой вне физики дороги
// (прямая×1,05…×1,65); (2) все активные/будущие рейсы с планом > прямая×1,7.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
const straight = (a, b, c, d) => { const r = v => v * Math.PI / 180;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(r(c - a) / 2) ** 2 +
    Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2)); };
const point = db.prepare('SELECT name, latitude, longitude FROM addresses WHERE id=?');

console.log('=== 1. ПЛЕЧИ СПРАВОЧНИКА ВНЕ ФИЗИКИ ДОРОГИ ===');
let badLegs = 0;
for (const leg of db.prepare(`SELECT key, samples, median_km FROM leg_fact_km
    WHERE samples >= 2 AND median_km > 0`).all()) {
  const [a, b] = leg.key.split('|').map(id => point.get(id));
  if (!a?.latitude || !b?.latitude) continue;
  const line = straight(a.latitude, a.longitude, b.latitude, b.longitude);
  if (line < 30) continue;
  const ratio = leg.median_km / line;
  if (ratio >= 1.05 && ratio <= 1.65) continue;
  badLegs += 1;
  console.log(`  ${a.name.split(',')[0]} ↔ ${b.name.split(',')[0]}: медиана ${leg.median_km} км` +
    ` при прямой ${Math.round(line)} (×${Math.round(ratio * 100) / 100}, samples ${leg.samples})`);
}
console.log(`плеч вне физики: ${badLegs}`);

console.log('\n=== 2. АКТИВНЫЕ/БУДУЩИЕ РЕЙСЫ С РАЗДУТЫМ ПЛАНОМ (> прямая×1,7) ===');
let badTrips = 0; let kmExcess = 0;
for (const trip of db.prepare(`SELECT t.order_no, t.distance_km, t.starts_at, t.status,
    v.plate, o.from_address_id fa, o.to_address_id ta, o.customer_name
  FROM trips t JOIN vehicles v ON v.id=t.vehicle_id JOIN orders o ON o.id=t.order_id
  WHERE t.status IN ('plan','run') AND o.from_address_id IS NOT NULL
    AND o.to_address_id IS NOT NULL AND COALESCE(o.via_json,'[]')='[]'
    AND t.distance_km > 0 ORDER BY t.starts_at`).all()) {
  const a = point.get(trip.fa); const b = point.get(trip.ta);
  if (!a?.latitude || !b?.latitude) continue;
  const line = straight(a.latitude, a.longitude, b.latitude, b.longitude);
  if (line < 30 || trip.distance_km <= line * 1.7) continue;
  badTrips += 1;
  const healthy = Math.round(line * 1.25);
  kmExcess += trip.distance_km - healthy;
  console.log(`  №${trip.order_no || '?'} ${trip.plate} ${trip.status}` +
    ` ${(trip.customer_name || '').slice(0, 20)} ${trip.starts_at.slice(5, 16)}:` +
    ` план ${Math.round(trip.distance_km)} км при прямой ${Math.round(line)}` +
    ` (здоровая оценка ~${healthy})`);
}
console.log(`рейсов с раздутым планом: ${badTrips} | суммарный лишний км ≈ ${Math.round(kmExcess)}`);
