// Контроль выполнения рейса: стоянки (контрольные точки) с плановым, расчётным
// и фактическим временем — модель «Транспортировок» корпоративных TMS.
// Стоянки синхронизированы с конвейером в обе стороны: факты диспетчера двигают
// статус рейса и стадию заявки, а смена статуса рейса проставляет ключевые факты.
import { randomUUID } from 'node:crypto';

const HOUR = 3_600_000;

// Окно грузовых работ на стоянке: два часа, но не больше четверти рейса —
// короткие плечи (Дом→Дом за 4 часа) не должны состоять из одной погрузки.
function workWindowMs(trip) {
  return Math.max(30 * 60_000,
    Math.min(2 * HOUR, (Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 4));
}

const tripWithNames = (db, tripId) => db.prepare(`SELECT t.*,f.name from_name,z.name to_name
  FROM trips t JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
  WHERE t.id=?`).get(tripId);

// Автогенерация каркаса: погрузка в пункте отправления и выгрузка в пункте
// назначения с плановыми временами из рейса. Дальше диспетчер уточняет и
// добавляет промежуточные стоянки.
export function ensureTripStops(db, tripId) {
  const trip = tripWithNames(db, tripId);
  if (!trip || trip.status === 'rejected') return trip;
  if (db.prepare('SELECT 1 FROM trip_stops WHERE trip_id=? LIMIT 1').get(tripId)) return trip;
  const windowMs = workWindowMs(trip);
  const insert = db.prepare(`INSERT INTO trip_stops(id,trip_id,seq,kind,point,
    planned_arrival,planned_departure,distance_km) VALUES(?,?,?,?,?,?,?,?)`);
  insert.run(randomUUID(), tripId, 1, 'P', trip.from_point || trip.from_name,
    trip.starts_at, new Date(Date.parse(trip.starts_at) + windowMs).toISOString(), 0);
  insert.run(randomUUID(), tripId, 2, 'D', trip.to_point || trip.to_name,
    new Date(Date.parse(trip.ends_at) - windowMs).toISOString(), trip.ends_at,
    Number(trip.distance_km) || 0);
  return trip;
}

export function listTripStops(db, tripId) {
  return db.prepare('SELECT * FROM trip_stops WHERE trip_id=? ORDER BY seq,planned_arrival').all(tripId);
}

// Расчётное время (как «Расчетное время прибытия» в TMS): план, сдвинутый на
// накопленное опоздание. Отставание берётся из последнего известного факта;
// для идущего рейса без свежих отметок — от текущего момента: если плановое
// отправление прошло, а факта нет, раньше «сейчас» машина уже не отправится.
export function stopsWithEstimates(stops, tripStatus, nowMs = Date.now()) {
  let lagMs = 0;
  const active = tripStatus === 'run';
  return stops.map(stop => {
    const plannedArrival = stop.planned_arrival ? Date.parse(stop.planned_arrival) : null;
    let estimatedArrival = stop.actual_arrival ? Date.parse(stop.actual_arrival)
      : plannedArrival == null ? null : plannedArrival + Math.max(0, lagMs);
    if (active && !stop.actual_arrival && estimatedArrival != null && nowMs > estimatedArrival) {
      estimatedArrival = nowMs;
    }
    if (stop.actual_arrival && plannedArrival != null) {
      lagMs = Date.parse(stop.actual_arrival) - plannedArrival;
    }
    const plannedDeparture = stop.planned_departure ? Date.parse(stop.planned_departure) : null;
    let estimatedDeparture = stop.actual_departure ? Date.parse(stop.actual_departure)
      : plannedDeparture == null ? null
        : Math.max(plannedDeparture + Math.max(0, lagMs), estimatedArrival ?? 0);
    if (active && !stop.actual_departure && estimatedDeparture != null && nowMs > estimatedDeparture) {
      estimatedDeparture = nowMs;
    }
    if (stop.actual_departure && plannedDeparture != null) {
      lagMs = Date.parse(stop.actual_departure) - plannedDeparture;
    }
    return {
      ...stop,
      estimated_arrival: estimatedArrival == null ? null : new Date(estimatedArrival).toISOString(),
      estimated_departure: estimatedDeparture == null ? null : new Date(estimatedDeparture).toISOString()
    };
  });
}

// Задержка рейса = расчётное прибытие на конечную стоянку минус плановое.
export function tripDelayMs(estimatedStops) {
  const last = estimatedStops[estimatedStops.length - 1];
  if (!last?.planned_arrival || !last.estimated_arrival) return 0;
  return Date.parse(last.estimated_arrival) - Date.parse(last.planned_arrival);
}

// Стадию заявки двигает та же карта, что и в PATCH /api/trips: контрольные
// факты и ручная смена статуса ведут конвейер одинаково.
const ORDER_STAGE_BY_STATUS = { plan: 2, run: 3, unloaded: 4, done: 4, paid: 5 };

function setTripStatus(db, trip, status, userId) {
  db.prepare(`UPDATE trips SET status=?,unloaded_at=COALESCE(unloaded_at,
    CASE WHEN ? IN ('unloaded','done') THEN CURRENT_TIMESTAMP END),
    updated_by=COALESCE(?,updated_by),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, status, userId || null, trip.id);
  if (trip.order_id) {
    const stage = ORDER_STAGE_BY_STATUS[status] ?? 2;
    db.prepare(`UPDATE orders SET stage=?,status='planned',
      stage_changed_at=CASE WHEN stage<>? THEN CURRENT_TIMESTAMP ELSE stage_changed_at END,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(stage, stage, trip.order_id);
  }
}

// Факты на стоянках → статус рейса: отправление с погрузки выводит машину
// «В пути», прибытие с завершёнными работами на конечной — «Выгружен».
// Возвращает новый статус, если он изменился (для outbox/аудита на сервере).
export function syncTripFromStops(db, tripId, userId) {
  const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(tripId);
  if (!trip || ['rejected', 'done', 'paid'].includes(trip.status)) return null;
  const stops = listTripStops(db, tripId);
  if (!stops.length) return null;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (trip.status === 'plan' && first.actual_departure) {
    setTripStatus(db, trip, 'run', userId);
    return 'run';
  }
  if (['plan', 'run'].includes(trip.status) && last.actual_arrival &&
      (last.work_finished_at || last.actual_departure)) {
    setTripStatus(db, trip, 'unloaded', userId);
    return 'unloaded';
  }
  return null;
}

// Обратная связь: ручной статус рейса проставляет ключевые факты на стоянках,
// чтобы контроль не расходился с конвейером продаж/диспетчера.
export function stampStopsFromStatus(db, tripId, status) {
  const stops = listTripStops(db, tripId);
  if (!stops.length) return;
  const nowIso = new Date().toISOString();
  const first = stops[0];
  const last = stops[stops.length - 1];
  const set = (stopId, field) => db.prepare(
    `UPDATE trip_stops SET ${field}=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND ${field} IS NULL`)
    .run(nowIso, stopId);
  if (['run', 'unloaded', 'done', 'paid'].includes(status)) set(first.id, 'actual_departure');
  if (['unloaded', 'done', 'paid'].includes(status)) {
    set(last.id, 'actual_arrival');
    set(last.id, 'work_finished_at');
  }
}

// Сводка для вкладки «Контроль» и отчёта: рейсы периода (плюс все идущие —
// опоздавший рейс остаётся проблемой и после планового окончания) со
// стоянками, расчётом и задержкой.
export function controlSnapshot(db, fromIso, toIso, nowMs = Date.now()) {
  const trips = db.prepare(`SELECT t.*,v.plate vehicle_plate,v.driver_name,
    f.name from_name,z.name to_name FROM trips t
    JOIN vehicles v ON v.id=t.vehicle_id
    JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
    WHERE t.status<>'rejected' AND (t.status='run' OR (t.starts_at<? AND t.ends_at>?))
    ORDER BY t.starts_at`).all(toIso, fromIso);
  return trips.map(trip => {
    ensureTripStops(db, trip.id);
    const stops = stopsWithEstimates(listTripStops(db, trip.id), trip.status, nowMs);
    return { ...trip, stops, delay_ms: tripDelayMs(stops) };
  });
}
