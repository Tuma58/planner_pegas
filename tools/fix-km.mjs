// ЛЕЧЕНИЕ раздутых километров БЕЗ деплоя (кейс 10.09). Запускается
// ЧЕЛОВЕКОМ на сервере (данные меняются — прочтите вывод аудита прежде):
//   docker exec -i pegas-planner-planner-1 node --input-type=module - < tools/fix-km.mjs
// Делает ровно то, что ночная санация нового кода:
//   1) плечи справочника с медианой вне прямая×1,05…×1,65 — гасятся
//      (samples=0; часы транзита не трогаются);
//   2) активные/будущие рейсы с планом > прямая×1,7 получают здоровый
//      план: медиана валидного плеча, иначе прямая×коэффициент (1,43).
// Идемпотентно: повторный запуск ничего не меняет.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DATABASE_PATH);
const straight = (a, b, c, d) => { const r = v => v * Math.PI / 180;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(r(c - a) / 2) ** 2 +
    Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2)); };
const point = db.prepare('SELECT latitude, longitude FROM addresses WHERE id=?');
const factor = Math.min(1.45, Math.max(1.05,
  Number(db.prepare(`SELECT value FROM app_meta WHERE key='road_factor_fact'`).get()?.value) || 1.2));

let killed = 0;
for (const leg of db.prepare(`SELECT key, median_km FROM leg_fact_km
    WHERE samples >= 2 AND median_km > 0`).all()) {
  const [a, b] = leg.key.split('|').map(id => point.get(id));
  if (!a?.latitude || !b?.latitude) continue;
  const line = straight(a.latitude, a.longitude, b.latitude, b.longitude);
  if (line < 30) continue;
  const ratio = leg.median_km / line;
  if (ratio >= 1.05 && ratio <= 1.65) continue;
  db.prepare(`UPDATE leg_fact_km SET samples=0, median_km=0,
    updated_at=CURRENT_TIMESTAMP WHERE key=?`).run(leg.key);
  killed += 1;
}
console.log(`погашено грязных плеч: ${killed}`);

let fixed = 0;
for (const trip of db.prepare(`SELECT t.id, t.order_id, t.order_no, t.distance_km,
    o.from_address_id fa, o.to_address_id ta
  FROM trips t JOIN orders o ON o.id=t.order_id
  WHERE t.status IN ('plan','run') AND o.from_address_id IS NOT NULL
    AND o.to_address_id IS NOT NULL AND COALESCE(o.via_json,'[]')='[]'
    AND t.distance_km > 0`).all()) {
  const a = point.get(trip.fa); const b = point.get(trip.ta);
  if (!a?.latitude || !b?.latitude) continue;
  const line = straight(a.latitude, a.longitude, b.latitude, b.longitude);
  if (line < 30 || trip.distance_km <= line * 1.7) continue;
  const key = [trip.fa, trip.ta].sort().join('|');
  const leg = db.prepare(`SELECT median_km FROM leg_fact_km WHERE key=? AND samples>=2`).get(key);
  const clean = leg && leg.median_km >= line * 1.05 && leg.median_km <= line * 1.65
    ? leg.median_km : Math.round(line * factor);
  db.prepare(`UPDATE trips SET distance_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(clean, trip.id);
  db.prepare(`UPDATE orders SET planned_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(clean, trip.order_id);
  console.log(`  №${trip.order_no || trip.id.slice(0, 8)}: ${Math.round(trip.distance_km)} → ${clean} км`);
  fixed += 1;
}
console.log(`вылечено рейсов: ${fixed} (коэффициент ${factor})`);
