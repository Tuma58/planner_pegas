// Ревизия перегонов и порожних подгонов: ищем записи, где место «Откуда»
// или километраж посчитаны не от той точки, где сцепка будет к моменту
// выезда. Логика резолва точек — точная копия серверной (server.mjs:
// addressPointByText / addressPointById / vehiclePositionBefore).
// Запуск: node revizia-transfers.mjs <путь к базе> [--apply] [--history]
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
const withHistory = process.argv.includes('--history');
const db = new DatabaseSync(dbPath, { readOnly: !apply });

const R = 6371;
const toRad = deg => (deg * Math.PI) / 180;
function roadKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 1.2);
}

// Имя геозоны — координаты её центра (иначе «Дом» находил бы Домодедово).
function addressPointByText(text) {
  const needle = String(text || '').trim();
  if (needle.length < 2) return null;
  return db.prepare(`SELECT latitude,longitude FROM zones
      WHERE name=? COLLATE NOCASE AND latitude IS NOT NULL`).get(needle)
    || db.prepare(`SELECT latitude,longitude FROM addresses
      WHERE name=? COLLATE NOCASE AND latitude IS NOT NULL LIMIT 1`).get(needle)
    || db.prepare(`SELECT latitude,longitude FROM addresses
      WHERE name LIKE ? AND latitude IS NOT NULL LIMIT 1`).get(`${needle}%`)
    || db.prepare(`SELECT latitude,longitude FROM addresses
      WHERE name LIKE ? AND latitude IS NOT NULL LIMIT 1`).get(`%${needle}%`)
    || null;
}
const addressPointById = id => id
  ? db.prepare('SELECT latitude,longitude FROM addresses WHERE id=? AND latitude IS NOT NULL').get(id) || null
  : null;

function positionBefore(vehicleId, beforeIso, excludeTripId = '') {
  const prevTrip = db.prepare(`SELECT t.to_point, z.name to_zone_name, t.ends_at
    FROM trips t JOIN zones z ON z.id=t.to_zone_id
    WHERE t.vehicle_id=? AND t.status<>'rejected' AND t.id<>? AND t.starts_at<?
    ORDER BY t.ends_at DESC LIMIT 1`).get(vehicleId, excludeTripId, beforeIso);
  const prevPlace = db.prepare(`SELECT COALESCE(d.arrived_at,d.ends_at) at, a.name, a.latitude, a.longitude
    FROM vehicle_dispositions d JOIN addresses a ON a.id=d.address_id
    WHERE d.vehicle_id=? AND a.latitude IS NOT NULL AND d.starts_at<?
      AND (d.kind='repair' OR (d.kind='transfer' AND d.arrived_at IS NOT NULL))
    ORDER BY at DESC LIMIT 1`).get(vehicleId, beforeIso);
  if (prevPlace && (!prevTrip || String(prevPlace.at) >= String(prevTrip.ends_at))) {
    return { label: prevPlace.name, latitude: prevPlace.latitude, longitude: prevPlace.longitude };
  }
  if (!prevTrip) return null;
  const point = addressPointByText(prevTrip.to_point || prevTrip.to_zone_name);
  return { label: prevTrip.to_point || prevTrip.to_zone_name,
    latitude: point?.latitude, longitude: point?.longitude };
}

// ── 1. Перегоны, которые ещё не завершены ──
const transfers = db.prepare(`SELECT d.id,d.vehicle_id,d.starts_at,d.ends_at,d.from_label,
    d.empty_km,d.departed_at,d.arrived_at,v.plate,a.name to_name,a.latitude,a.longitude
  FROM vehicle_dispositions d JOIN vehicles v ON v.id=d.vehicle_id
  LEFT JOIN addresses a ON a.id=d.address_id
  WHERE d.kind='transfer' AND d.arrived_at IS NULL ORDER BY d.starts_at`).all();

console.log(`── Перегоны в работе: ${transfers.length}`);
const fixes = [];
for (const item of transfers) {
  const origin = positionBefore(item.vehicle_id, item.starts_at);
  const km = origin && Number.isFinite(origin.latitude) && Number.isFinite(item.latitude)
    ? roadKm(origin.latitude, origin.longitude, item.latitude, item.longitude) : null;
  // Занятость проверяем только у перегонов, которые ещё не начались: после
  // отметки «Выехал» факт главнее плана — машина могла выгрузиться раньше
  // срока, а отметку «выгружен» диспетчер поставить не успел.
  const busy = item.departed_at ? null : db.prepare(`SELECT t.ends_at, t.to_point FROM trips t
    WHERE t.vehicle_id=? AND t.status<>'rejected' AND t.starts_at<=? AND t.ends_at>?
    ORDER BY t.ends_at DESC LIMIT 1`).get(item.vehicle_id, item.starts_at, item.starts_at);
  const labelWrong = Boolean(origin?.label) && item.from_label !== origin.label;
  const kmWrong = km != null && Math.abs((item.empty_km || 0) - km) > 5;
  // Если водитель уже выехал, план подгоняем под факт, а не наоборот.
  const departedEarly = item.departed_at && Date.parse(item.departed_at) < Date.parse(item.starts_at);
  if (!labelWrong && !kmWrong && !busy && !departedEarly) continue;
  fixes.push({ item, origin, km, busy });
  console.log(`⚠ ${item.plate} · выезд ${item.starts_at.slice(5, 16)} → ${item.to_name || '?'}`);
  if (labelWrong) console.log(`   Откуда: «${item.from_label}» → «${origin.label}»`);
  if (kmWrong) console.log(`   Км: ${item.empty_km} → ${km}`);
  if (busy) console.log(`   Занята до ${busy.ends_at.slice(5, 16)} — выезд раньше освобождения`);
  if (departedEarly) console.log(`   Отметка «Выехал» ${item.departed_at.slice(5, 16)} раньше планового выезда ${item.starts_at.slice(5, 16)}`);
}

// ── 2. Порожний подгон рейсов ──
// Цель — адрес погрузки заявки (как на сервере), иначе текст пункта.
function tripEmptyKm(trip) {
  const origin = positionBefore(trip.vehicle_id, trip.starts_at, trip.id);
  const target = addressPointById(trip.from_address_id) || addressPointByText(trip.from_point);
  if (!origin || !target || !Number.isFinite(origin.latitude) || !Number.isFinite(target.latitude)) return null;
  return { km: roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude), origin };
}

const scope = withHistory ? "t.status<>'rejected'" : "t.status IN ('plan','run')";
const trips = db.prepare(`SELECT t.id,t.vehicle_id,t.starts_at,t.empty_km,t.status,t.order_no,
    t.from_point,o.from_address_id,v.plate FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
  LEFT JOIN orders o ON o.id=t.order_id
  WHERE ${scope} ORDER BY t.starts_at`).all();
console.log(`\n── Рейсы в проверке: ${trips.length} (${withHistory ? 'вся история' : 'план и в пути'})`);
const tripFixes = [];
let sumBefore = 0;
let sumAfter = 0;
for (const trip of trips) {
  const calc = tripEmptyKm(trip);
  if (!calc) continue;
  const current = Number(trip.empty_km) || 0;
  // Порог: и абсолютный, и относительный — мелкие расхождения от округления
  // координат не трогаем.
  if (Math.abs(current - calc.km) <= 15 || (current && Math.abs(current - calc.km) / current < 0.1)) continue;
  tripFixes.push({ trip, ...calc });
  sumBefore += current;
  sumAfter += calc.km;
  if (tripFixes.length <= 25) {
    console.log(`⚠ ${trip.plate} · №${trip.order_no} ${trip.starts_at.slice(5, 16)} [${trip.status}]: ` +
      `порожний ${trip.empty_km ?? '—'} → ${calc.km} (от «${(calc.origin.label || '').slice(0, 38)}»)`);
  }
}
if (tripFixes.length > 25) console.log(`   … и ещё ${tripFixes.length - 25}`);

console.log(`\nИтого: перегонов к правке ${fixes.length}, рейсов с расхождением ${tripFixes.length}` +
  ` (порожняк ${Math.round(sumBefore)} км → ${Math.round(sumAfter)} км)`);

if (apply) {
  const calcSettings = JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key='calculation'").get().value_json);
  const speed = Number(calcSettings.techSpeedKmh) || 50;
  const factor = Number(calcSettings.transitFactor) || 1.5;
  console.log('\n── Правки ──');
  for (const fix of fixes) {
    const { item, origin, km, busy } = fix;
    // Факт выезда главнее плана и главнее расчётного освобождения:
    // отметка «Выехал» означает, что машина уже в пути.
    const startsAt = item.departed_at
      ? item.departed_at
      : busy ? busy.ends_at : item.starts_at;
    const hours = Number.isFinite(km) ? Math.max(1, (km / speed) * factor) : 12;
    const endsAt = new Date(Date.parse(startsAt) + hours * 3_600_000).toISOString();
    db.prepare(`UPDATE vehicle_dispositions SET from_label=?, empty_km=?, starts_at=?, ends_at=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(origin?.label || item.from_label, km ?? item.empty_km, startsAt, endsAt, item.id);
    console.log(`✔ ${item.plate}: «${origin?.label}», ${km} км, выезд ${startsAt.slice(5, 16)} → прибытие ${endsAt.slice(5, 16)}`);
  }
  for (const fix of tripFixes) {
    db.prepare('UPDATE trips SET empty_km=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(fix.km, fix.trip.id);
    console.log(`✔ №${fix.trip.order_no} (${fix.trip.plate}): ${fix.trip.empty_km ?? '—'} → ${fix.km} км`);
  }
}
