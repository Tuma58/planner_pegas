// Точечное лечение 10.09: заявки Дмитрогорского МПЗ (с. Дмитрова Гора,
// Конаковский р-н) шли без адреса погрузки — план брался с потолка
// (1 060–1 252 км на плечо ~170 км). Создаём адрес с координатами,
// привязываем активные заявки, пересчитываем план по физике.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
const db = new DatabaseSync(process.env.DATABASE_PATH);
const straight = (a, b, c, d) => { const r = v => v * Math.PI / 180;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(r(c - a) / 2) ** 2 +
    Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2)); };
const LAT = 56.585; const LON = 36.975; // с. Дмитрова Гора, Конаковский р-н
let addr = db.prepare(`SELECT id FROM addresses WHERE name LIKE '%Дмитрова Гора%'`).get();
if (!addr) {
  const id = randomUUID();
  const zone = db.prepare(`SELECT id, latitude, longitude FROM zones WHERE latitude IS NOT NULL`).all()
    .map(z => ({ ...z, d: straight(LAT, LON, z.latitude, z.longitude) }))
    .sort((a, b) => a.d - b.d)[0];
  db.prepare(`INSERT INTO addresses(id, name, region, latitude, longitude, zone_id)
    VALUES(?,?,?,?,?,?)`).run(id, 'Тверская область, Конаковский район, с. Дмитрова Гора',
    'Тверская обл', LAT, LON, zone?.id || null);
  addr = { id };
  console.log('адрес создан, зона:', zone?.id ? 'ближайшая по координатам' : '—');
}
const factor = Math.min(1.45, Math.max(1.05,
  Number(db.prepare(`SELECT value FROM app_meta WHERE key='road_factor_fact'`).get()?.value) || 1.2));
const point = db.prepare('SELECT latitude, longitude FROM addresses WHERE id=?');
for (const row of db.prepare(`SELECT o.id, o.to_address_id, t.id trip_id, t.order_no, t.distance_km
  FROM orders o JOIN trips t ON t.order_id=o.id
  WHERE t.status IN ('plan','run') AND o.from_address_id IS NULL
    AND o.from_point LIKE '%Дмитрова Гора%'`).all()) {
  db.prepare(`UPDATE orders SET from_address_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(addr.id, row.id);
  const b = row.to_address_id ? point.get(row.to_address_id) : null;
  if (b?.latitude) {
    const clean = Math.round(straight(LAT, LON, b.latitude, b.longitude) * factor);
    db.prepare(`UPDATE trips SET distance_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(clean, row.trip_id);
    db.prepare(`UPDATE orders SET planned_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(clean, row.id);
    console.log(`№${row.order_no}: ${Math.round(row.distance_km)} → ${clean} км`);
  } else console.log(`№${row.order_no}: адрес выгрузки не привязан — план не пересчитан`);
}
