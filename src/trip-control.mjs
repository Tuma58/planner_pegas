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

// ── Диспетчеризация рейса ──
// Порядок шагов после назначения ТС: логист подтверждает назначение,
// затем диспетчер по чек-листу: заказ внесён в учётную систему (1С ведётся
// отдельно от продукта), задание водителю отправлено, рейс выведен
// на контроль на линии (это переводит рейс «В пути»).
export const DISPATCH_STEPS = [
  { step: 'logist_confirm', column: 'logist_confirmed_at', permission: 'trips:write',
    label: 'Назначение подтверждено логистом' },
  { step: 'entered_1c', column: 'entered_1c_at', permission: 'trip-status:write',
    label: 'Заказ внесён в учётную систему' },
  { step: 'driver_notified', column: 'driver_notified_at', permission: 'trip-status:write',
    label: 'Задание водителю отправлено' },
  { step: 'on_line', column: 'on_line_at', permission: 'trip-status:write',
    label: 'Контроль на линии' }
];

// Выполнение шага с проверкой порядка. Возвращает { trip, statusChanged }.
export function applyDispatchStep(db, tripId, step, userId) {
  const index = DISPATCH_STEPS.findIndex(item => item.step === step);
  if (index < 0) throw Object.assign(new Error('Неизвестный шаг диспетчеризации'), { status: 422 });
  const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(tripId);
  if (!trip) throw Object.assign(new Error('Рейс не найден'), { status: 404 });
  if (trip.status === 'rejected') {
    throw Object.assign(new Error('Рейс отклонён — шаги недоступны'), { status: 409 });
  }
  const meta = DISPATCH_STEPS[index];
  if (trip[meta.column]) return { trip, statusChanged: false };
  const previous = DISPATCH_STEPS[index - 1];
  if (previous && !trip[previous.column]) {
    throw Object.assign(new Error(`Сначала выполните шаг «${previous.label}»`), { status: 409 });
  }
  db.prepare(`UPDATE trips SET ${meta.column}=CURRENT_TIMESTAMP,updated_by=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(userId || null, tripId);
  let statusChanged = false;
  // Выход на линию = рейс «В пути»: стадия заявки и стоянки контроля двигаются
  // той же логикой, что и ручная смена статуса.
  if (step === 'on_line' && trip.status === 'plan') {
    setTripStatus(db, trip, 'run', userId);
    ensureTripStops(db, tripId);
    stampStopsFromStatus(db, tripId, 'run');
    statusChanged = true;
  }
  return { trip: db.prepare('SELECT * FROM trips WHERE id=?').get(tripId), statusChanged };
}

// Переназначение ТС отзывает отправленное водителю задание: новому водителю
// его ещё не отправляли. Внесение в 1С и контроль на линии сохраняются.
export function resetDriverNotificationOnVehicleChange(db, tripId) {
  db.prepare(`UPDATE trips SET driver_notified_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status IN ('plan','run')`).run(tripId);
}

// ── «ТС не выгружают»: затянувшаяся выгрузка на линии ──
// Рейс на линии, плановое прибытие прошло более 6 часов назад, выгрузка не
// отмечена. Первый алерт — продажам и логистам, далее ежечасные пинги
// диспетчерам (особый контроль), пока рейс не выгружен или не снят.
export const UNLOAD_STUCK_MS = 6 * 3_600_000;

export function checkStuckUnloading(db, nowMs = Date.now()) {
  const events = [];
  const trips = db.prepare(`SELECT t.*,v.plate vehicle_plate,
    f.name from_name,z.name to_name FROM trips t
    JOIN vehicles v ON v.id=t.vehicle_id
    JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
    WHERE t.status='run'`).all();
  const stamp = new Date(nowMs).toISOString();
  for (const trip of trips) {
    const waitedMs = nowMs - Date.parse(trip.ends_at);
    if (waitedMs < UNLOAD_STUCK_MS) continue;
    if (!trip.unload_alert_at) {
      db.prepare(`UPDATE trips SET unload_alert_at=?,unload_ping_at=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(stamp, stamp, trip.id);
      events.push({ kind: 'first', trip, waitedMs });
    } else if (nowMs - Date.parse(trip.unload_ping_at || trip.unload_alert_at) >= 3_600_000) {
      db.prepare(`UPDATE trips SET unload_ping_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(stamp, trip.id);
      events.push({ kind: 'hourly', trip, waitedMs });
    }
  }
  return events;
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
