import { randomUUID } from 'node:crypto';
import { settingsObject } from './db.mjs';

export const TRIP_STATUS = {
  plan: 'plan', run: 'run', unl: 'unloaded', unloaded: 'unloaded',
  done: 'done', pay: 'paid', paid: 'paid', rej: 'rejected', rejected: 'rejected'
};

export function resolveZone(db, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return db.prepare(`SELECT z.* FROM zones z WHERE z.name=? COLLATE NOCASE
    UNION ALL
    SELECT z.* FROM zone_aliases a JOIN zones z ON z.id=a.zone_id
    WHERE a.alias=? COLLATE NOCASE LIMIT 1`).get(normalized, normalized) || null;
}

// Транзитное время рейса: движение (50 км/ч) + две грузовые операции
// (по 2 ч), сумма × 1,5 — запас включает отдых водителя, после ends_at
// сцепка готова к следующему рейсу.
export function transitHours(distanceKm, calculation = {}, operations = 2) {
  const speed = Number(calculation.techSpeedKmh || 50);
  const perOperation = Number(calculation.handlingHoursPerOperation || 2);
  const factor = Number(calculation.transitFactor || 1.5);
  return (Number(distanceKm || 0) / speed + operations * perOperation) * factor;
}

function routeDistance(db, fromId, toId) {
  if (fromId === toId) return 40;
  return Number(db.prepare(`SELECT distance_km FROM route_rates
    WHERE (from_zone_id=? AND to_zone_id=?) OR (from_zone_id=? AND to_zone_id=?)
    ORDER BY CASE WHEN from_zone_id=? THEN 0 ELSE 1 END LIMIT 1`)
    .get(fromId, toId, toId, fromId, fromId)?.distance_km || 500);
}

function isoDate(value, field) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw Object.assign(new Error(`Некорректное поле ${field}`), { status: 422 });
  return new Date(millis).toISOString();
}

export function importTripsFrom1C(db, rows, user) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('Ожидается массив записей'), { status: 422 });
  const settings = settingsObject(db).calculation;
  const result = { imported: 0, updated: 0, skipped: 0, errors: [] };
  const defaultType = db.prepare(`SELECT id FROM vehicle_types WHERE name='Тушевоз'`).get()?.id;
  const findVehicle = db.prepare('SELECT * FROM vehicles WHERE plate=? COLLATE NOCASE');
  const insertVehicle = db.prepare(`INSERT INTO vehicles(
    id,plate,type_id,driver_name,trailer_plate,zone_id,status,external_id)
    VALUES(?,?,?,?,?,?, 'work',?)`);
  const findTrip = db.prepare('SELECT id FROM trips WHERE external_id=?');
  const insertTrip = db.prepare(`INSERT INTO trips(
    id,vehicle_id,customer_name,from_zone_id,to_zone_id,from_point,to_point,starts_at,ends_at,
    distance_km,revenue_vat,status,external_id,source_system,created_by,updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateTrip = db.prepare(`UPDATE trips SET vehicle_id=?,customer_name=?,from_zone_id=?,to_zone_id=?,
    from_point=?,to_point=?,starts_at=?,ends_at=?,distance_km=?,revenue_vat=?,status=?,source_system='1c',
    updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`);

  db.exec('BEGIN IMMEDIATE');
  try {
    rows.forEach((row, index) => {
      try {
        if (!row?.id) throw new Error('id обязателен');
        const from = resolveZone(db, row.zoneFrom ?? row.from);
        const to = resolveZone(db, row.zoneTo ?? row.to);
        if (!from || !to) throw new Error('не распознана геозона/город');
        const plate = String(row.truck || '').trim();
        if (!plate) throw new Error('truck обязателен');
        let vehicle = findVehicle.get(plate);
        if (!vehicle) {
          const requestedType = db.prepare('SELECT id FROM vehicle_types WHERE name=?').get(row.type || '')?.id;
          const id = randomUUID();
          insertVehicle.run(
            id, plate, requestedType || defaultType, String(row.driver || ''), '',
            from.id, `1c:vehicle:${plate.toLocaleLowerCase('ru-RU')}`);
          vehicle = findVehicle.get(plate);
        }
        const startsAt = isoDate(row.depDate, 'depDate');
        const distance = Number(row.km) > 0 ? Number(row.km) : routeDistance(db, from.id, to.id);
        const endsAt = row.doneDate
          ? isoDate(row.doneDate, 'doneDate')
          : new Date(Date.parse(startsAt) + transitHours(distance, settings) * 3_600_000).toISOString();
        if (Date.parse(endsAt) <= Date.parse(startsAt)) {
          throw new Error('doneDate должна быть позже depDate');
        }
        const externalId = `1c:${row.id}`;
        const current = findTrip.get(externalId);
        // Пункт из выгрузки сохраняется как есть: если это не имя зоны — маршрут
        // будет показан «из пункта в пункт» при неизменной зональной аналитике.
        const fromPoint = String(row.zoneFrom ?? row.from ?? '').trim();
        const toPoint = String(row.zoneTo ?? row.to ?? '').trim();
        const values = [
          vehicle.id, String(row.client || ''), from.id, to.id,
          fromPoint === from.name ? '' : fromPoint, toPoint === to.name ? '' : toPoint,
          startsAt, endsAt, distance, Number(row.revenue || 0), TRIP_STATUS[row.status] || 'plan'
        ];
        if (current) {
          updateTrip.run(...values, user.id, current.id);
          result.updated += 1;
        } else {
          insertTrip.run(randomUUID(), ...values, externalId, '1c', user.id, user.id);
          result.imported += 1;
        }
      } catch (error) {
        result.skipped += 1;
        if (result.errors.length < 50) result.errors.push({ index, id: row?.id || null, error: error.message });
      }
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

export function importTelematics(db, records, user) {
  if (!Array.isArray(records)) throw Object.assign(new Error('Ожидается массив записей'), { status: 422 });
  const result = { matched: 0, kmUpdated: 0, statusUpdated: 0, skipped: 0 };
  const find = db.prepare(`SELECT * FROM trips WHERE id=? OR external_id=? OR external_id=? LIMIT 1`);
  const update = db.prepare(`UPDATE trips SET actual_distance_km=?,distance_km=?,status=?,
    unloaded_at=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of records) {
      const rideId = String(row?.rideId || row?.id || '');
      const trip = find.get(rideId, rideId, `1c:${rideId}`);
      if (!trip) {
        result.skipped += 1;
        continue;
      }
      const km = Number(row.km) > 0 ? Math.round(Number(row.km)) : trip.actual_distance_km;
      const status = row.status ? (TRIP_STATUS[row.status] || trip.status) : trip.status;
      const unloadedAt = row.unloadedAt ? isoDate(row.unloadedAt, 'unloadedAt') : trip.unloaded_at;
      update.run(km, km || trip.distance_km, status, unloadedAt, user.id, trip.id);
      if (trip.order_id) {
        const stage = ({ plan: 2, run: 3, unloaded: 4, done: 5, paid: 5, rejected: 1 })[status] || 2;
        db.prepare(`UPDATE orders SET stage=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(stage, status === 'rejected' ? 'new' : 'planned', trip.order_id);
      }
      result.matched += 1;
      if (Number(row.km) > 0) result.kmUpdated += 1;
      if (row.status) result.statusUpdated += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

// Показатели сотрудников: нагрузка каждого за период [fromDay..toDay]
// (from включительно, to — исключая, как в остальных отчётах). Источники:
// журнал аудита (все действия, кроме входов),
// отметки задач (там автор — имя смены), сообщения чата и внесённые заявки
// с суммами ставок. Роль не группируем — на проде права шире должностей.
export function staffReport(db, fromDay, toDay) {
  const fromTs = `${fromDay} 00:00:00`;
  const toEx = `${toDay} 00:00:00`;
  const byId = new Map();
  const rowOf = (id, name) => {
    const key = String(name || '').trim() || id || '—';
    if (!byId.has(key)) {
      byId.set(key, { name: key, activeDays: 0, total: 0, orderCreate: 0, orderUpdate: 0,
        orderAssign: 0, ordersSum: 0, dispatchSteps: 0, stopFacts: 0, tripEdits: 0,
        dispositions: 0, routes: 0, files: 0, marks: 0, chat: 0 });
    }
    return byId.get(key);
  };
  for (const r of db.prepare(`
    SELECT u.full_name name, COUNT(*) total,
      COUNT(DISTINCT date(a.created_at)) activeDays,
      SUM(a.entity='order' AND a.action='create') orderCreate,
      SUM(a.entity='order' AND a.action='update') orderUpdate,
      SUM(a.entity='order' AND a.action='assign') orderAssign,
      SUM(a.entity='trip' AND a.action='dispatch_step') dispatchSteps,
      SUM(a.entity='trip_stop' OR (a.entity='trip' AND a.action='arrived')) stopFacts,
      SUM(a.entity='trip' AND a.action IN ('create','update','delete')) tripEdits,
      SUM(a.entity='disposition') dispositions,
      SUM(a.entity='route') routes,
      SUM(a.entity='order-file') files
    FROM audit_log a JOIN users u ON u.id=a.user_id
    WHERE a.created_at >= ? AND a.created_at < ? AND a.entity <> 'session'
    GROUP BY a.user_id`).all(fromTs, toEx)) {
    Object.assign(rowOf(null, r.name), { ...r, name: rowOf(null, r.name).name });
  }
  for (const r of db.prepare(`SELECT done_by name, COUNT(*) c FROM task_marks
    WHERE day >= ? AND day < ? GROUP BY done_by`).all(fromDay, toDay)) {
    rowOf(null, r.name).marks += r.c;
  }
  for (const r of db.prepare(`SELECT author_name name, COUNT(*) c FROM messages
    WHERE created_at >= ? AND created_at < ? AND kind='user' AND author_name <> '' GROUP BY author_name`)
    .all(fromTs, toEx)) {
    rowOf(null, r.name).chat += r.c;
  }
  for (const r of db.prepare(`SELECT u.full_name name, SUM(o.rate_vat) s FROM orders o
    JOIN users u ON u.id=o.created_by
    WHERE o.created_at >= ? AND o.created_at < ? GROUP BY o.created_by`).all(fromTs, toEx)) {
    rowOf(null, r.name).ordersSum += Number(r.s || 0);
  }
  return { items: [...byId.values()]
    .map(item => ({ ...item,
      total: item.total + item.marks + item.chat }))
    .sort((a, b) => b.total - a.total) };
}

// Вахтовый график: рабочий ли день по схеме «on дней работы / off отдыха
// от даты начала рабочего периода». Без заданной вахты день считается
// рабочим — график не ограничивает.
export function shiftIsWorkday(onDays, offDays, anchorIso, dayIso) {
  const on = Number(onDays);
  const off = Number(offDays);
  if (!on || !off || !anchorIso) return true;
  const cycle = on + off;
  const diff = Math.floor((Date.parse(`${String(dayIso).slice(0, 10)}T00:00:00Z`) -
    Date.parse(`${String(anchorIso).slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  const position = ((diff % cycle) + cycle) % cycle;
  return position < on;
}

// Явка водителей (перенос из v2, контур ОУВ): классификатор причин
// невыхода — каждый невыход обязан иметь причину.
export const ABSENCE_REASONS = {
  sick: 'Больничный',
  vacation: 'Отпуск',
  dayoff: 'Выходной по графику',
  truancy: 'Прогул',
  intern: 'Стажировка / обучение',
  other: 'Прочее'
};

// Отметка явки: upsert по (водитель, день). Невыход без причины не принимается.
export function markAttendance(db, { driverId, day, status, reason = '', note = '', userId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    throw Object.assign(new Error('Нужен день в формате ГГГГ-ММ-ДД'), { status: 422 });
  }
  if (!['present', 'absent'].includes(status)) {
    throw Object.assign(new Error('Статус явки: present или absent'), { status: 422 });
  }
  if (status === 'absent' && !ABSENCE_REASONS[reason]) {
    throw Object.assign(new Error('Невыход обязан иметь причину из классификатора'), { status: 422 });
  }
  const driver = db.prepare(`SELECT id FROM drivers WHERE id=? AND status<>'fired'`).get(driverId);
  if (!driver) throw Object.assign(new Error('Водитель не найден'), { status: 404 });
  db.prepare(`INSERT INTO driver_attendance(id,driver_id,day,status,reason,note,marked_by)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(driver_id,day) DO UPDATE SET status=excluded.status,reason=excluded.reason,
      note=excluded.note,marked_by=excluded.marked_by,marked_at=CURRENT_TIMESTAMP`)
    .run(randomUUID(), driverId, day, status,
      status === 'absent' ? reason : '', String(note || ''), userId);
  return db.prepare(`SELECT * FROM driver_attendance WHERE driver_id=? AND day=?`).get(driverId, day);
}

// Карточка сотрудника (водителя): все данные одним запросом — личные
// данные, явка за 30 дней, работа его сцепки, периодные закрепления
// и история событий из журнала (приём, перезакрепления, явка, периоды).
export function driverCardData(db, driverId) {
  const driver = db.prepare(`SELECT d.*, v.plate vehicle_plate, v.trailer_plate
    FROM drivers d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.id=?`).get(driverId);
  if (!driver) throw Object.assign(new Error('Водитель не найден'), { status: 404 });
  const att = { present: 0, absent: 0, byReason: {} };
  for (const row of db.prepare(`SELECT status, reason, COUNT(*) c FROM driver_attendance
    WHERE driver_id=? AND day >= date('now','-30 days') GROUP BY status, reason`).all(driverId)) {
    if (row.status === 'present') att.present += row.c;
    else { att.absent += row.c; att.byReason[row.reason] = (att.byReason[row.reason] || 0) + row.c; }
  }
  const trips30 = driver.vehicle_id ? db.prepare(`SELECT COUNT(*) count,
      COALESCE(SUM(distance_km + COALESCE(empty_km, 0)), 0) km,
      COALESCE(SUM(revenue_vat), 0) revenue
    FROM trips WHERE vehicle_id=? AND status<>'rejected'
      AND ends_at >= datetime('now','-30 days') AND ends_at <= datetime('now')`)
    .get(driver.vehicle_id) : { count: 0, km: 0, revenue: 0 };
  return {
    driver,
    attendance30: att,
    trips30,
    periods: db.prepare(`SELECT a.*, v.plate vehicle_plate FROM driver_assignments a
      JOIN vehicles v ON v.id=a.vehicle_id
      WHERE a.driver_id=? AND a.ends_at >= date('now') ORDER BY a.starts_at`).all(driverId),
    history: db.prepare(`SELECT action, details_json, created_at,
        (SELECT full_name FROM users WHERE id=a.user_id) by_name
      FROM audit_log a WHERE entity='driver' AND entity_id=?
      ORDER BY created_at DESC LIMIT 20`).all(driverId)
  };
}

// Периодное закрепление водителя за ТС (подмена на межвахту, командировка):
// поверх постоянного закрепления, на интервал дат. Один водитель не может
// быть закреплён на два ТС внахлёст — пересечение отклоняется.
export function createDriverAssignment(db, { driverId, vehicleId, startsAt, endsAt, note = '', userId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(startsAt || '')) || !/^\d{4}-\d{2}-\d{2}/.test(String(endsAt || '')) ||
      String(endsAt) <= String(startsAt)) {
    throw Object.assign(new Error('Нужен период: даты с и по (по — позже чем с)'), { status: 422 });
  }
  const driver = db.prepare(`SELECT id,full_name FROM drivers WHERE id=? AND status<>'fired'`).get(driverId);
  if (!driver) throw Object.assign(new Error('Водитель не найден'), { status: 404 });
  const vehicle = db.prepare(`SELECT id,plate FROM vehicles WHERE id=?`).get(vehicleId);
  if (!vehicle) throw Object.assign(new Error('Сцепка не найдена'), { status: 404 });
  const clash = db.prepare(`SELECT a.id, v.plate FROM driver_assignments a
    JOIN vehicles v ON v.id=a.vehicle_id
    WHERE a.driver_id=? AND a.starts_at < ? AND a.ends_at > ?`).get(driverId, endsAt, startsAt);
  if (clash) {
    throw Object.assign(new Error(`Пересечение: водитель уже закреплён на ${clash.plate} в этот период`), { status: 422 });
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO driver_assignments(id,driver_id,vehicle_id,starts_at,ends_at,note,created_by)
    VALUES(?,?,?,?,?,?,?)`).run(id, driverId, vehicleId, startsAt, endsAt,
    String(note || '').slice(0, 200), userId);
  return db.prepare(`SELECT * FROM driver_assignments WHERE id=?`).get(id);
}

// График работы водителей: две проекции (водители × дни → ТС;
// ТС × дни → водитель). История закреплений восстанавливается из журнала
// аудита (перезакрепление пишет vehicleId), текущее закрепление — из
// справочника; пересменки/«без водителя»/ремонты — интервалы диспозиций,
// отсутствия — из карточки водителя, факт — из явки.
export function driverScheduleData(db, fromIso, toIso) {
  const drivers = db.prepare(`SELECT d.id,d.full_name,d.status,d.vehicle_id,
      d.absent_from,d.absent_to,d.shift_on,d.shift_off,d.shift_anchor,v.plate FROM drivers d
      LEFT JOIN vehicles v ON v.id=d.vehicle_id
      WHERE d.status<>'fired' ORDER BY d.full_name`).all();
  const vehicles = db.prepare(`SELECT id,plate,trailer_plate,driver_name,status
      FROM vehicles WHERE status<>'out' ORDER BY plate`).all();
  const tsIso = value => new Date(Date.parse(String(value).includes('T')
    ? value : `${String(value).replace(' ', 'T')}Z`)).toISOString();
  const events = db.prepare(`SELECT entity_id driver_id, details_json, created_at
      FROM audit_log WHERE entity='driver' AND action='update'
      ORDER BY created_at`).all()
    .map(row => {
      try {
        const details = JSON.parse(row.details_json);
        return 'vehicleId' in details
          ? { driverId: row.driver_id, vehicleId: details.vehicleId || null, at: tsIso(row.created_at) }
          : null;
      } catch { return null; }
    })
    .filter(Boolean);
  const byDriver = new Map();
  for (const event of events) {
    if (!byDriver.has(event.driverId)) byDriver.set(event.driverId, []);
    byDriver.get(event.driverId).push(event);
  }
  // Интервалы закреплений: [событие; следующее событие). Без событий —
  // текущее закрепление на всю ось; до первого события история неизвестна.
  const assignments = {};
  for (const driver of drivers) {
    const list = byDriver.get(driver.id) || [];
    const spans = [];
    if (!list.length) {
      if (driver.vehicle_id) spans.push({ vehicleId: driver.vehicle_id, from: null, to: null });
    } else {
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].vehicleId) {
          spans.push({ vehicleId: list[index].vehicleId,
            from: list[index].at, to: list[index + 1]?.at || null });
        }
      }
    }
    assignments[driver.id] = spans;
  }
  return {
    drivers, vehicles, assignments,
    planned: db.prepare(`SELECT a.id,a.driver_id,a.vehicle_id,a.starts_at,a.ends_at,a.note
      FROM driver_assignments a WHERE a.starts_at < ? AND a.ends_at > ?`).all(toIso, fromIso),
    attendance: db.prepare(`SELECT driver_id,day,status,reason FROM driver_attendance
      WHERE day >= ? AND day <= ?`).all(fromIso.slice(0, 10), toIso.slice(0, 10)),
    dispositions: db.prepare(`SELECT vehicle_id,kind,starts_at,ends_at,note
      FROM vehicle_dispositions WHERE starts_at < ? AND ends_at > ?`)
      .all(toIso, fromIso)
  };
}

// Сводка явки за день + укомплектованность (норматив 1,45 водителя на ТС).
export function attendanceSummary(db, day) {
  const drivers = db.prepare(`SELECT COUNT(*) count FROM drivers WHERE status<>'fired'`).get().count;
  const vehicles = db.prepare(`SELECT COUNT(*) count FROM vehicles WHERE status<>'out'`).get().count;
  const rows = db.prepare(`SELECT status,reason,COUNT(*) count FROM driver_attendance
    WHERE day=? GROUP BY status,reason`).all(day);
  const byReason = {};
  let present = 0;
  let absent = 0;
  for (const row of rows) {
    if (row.status === 'present') present += row.count;
    else {
      absent += row.count;
      byReason[row.reason] = (byReason[row.reason] || 0) + row.count;
    }
  }
  return {
    drivers, vehicles, present, absent, byReason,
    unmarked: Math.max(0, drivers - present - absent),
    staffing: vehicles ? drivers / vehicles : 0,
    staffingTarget: 1.45
  };
}

export function reportSnapshot(db, fromValue, toValue) {
  const from = isoDate(fromValue, 'from');
  const to = isoDate(toValue, 'to');
  if (Date.parse(to) <= Date.parse(from)) throw Object.assign(new Error('Период задан неверно'), { status: 422 });
  const calculation = settingsObject(db).calculation;
  const trips = db.prepare(`SELECT t.*,v.plate,vt.name vehicle_type
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id JOIN vehicle_types vt ON vt.id=v.type_id
    WHERE t.status<>'rejected' AND t.ends_at>=? AND t.ends_at<? ORDER BY t.ends_at`).all(from, to);
  const vehicleCount = db.prepare(`SELECT COUNT(*) count FROM vehicles WHERE status<>'out'`).get().count;
  const days = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86_400_000);
  const byType = new Map();
  let netRevenue = 0;
  let contribution = 0;
  let factRevenue = 0;
  let emptyKmTotal = 0;
  for (const trip of trips) {
    // Наличная перевозка — ставка уже без НДС, не очищается.
    const vat = trip.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
      ? Number(calculation.individualEntrepreneurVatRate ?? 0.07)
      : Number(calculation.vatRate ?? 0.22);
    const net = Number(trip.revenue_vat) / (1 + vat);
    const tripDays = Math.max(0, (Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 86_400_000);
    // Порожний подгон — затрата этого рейса: километровые ставки на него тоже.
    const emptyKm = Number(trip.empty_km || 0);
    emptyKmTotal += emptyKm;
    const variable = (Number(trip.distance_km) + emptyKm) *
      (Number(calculation.costPerKm || 0) + Number(calculation.insuranceAndRoadsPerKm || 0)) +
      tripDays * (Number(calculation.driverPerTripDay || 0) + Number(calculation.refrigerationPerTripDay || 0));
    const margin = net - variable;
    netRevenue += net;
    contribution += margin;
    if (['done', 'paid'].includes(trip.status)) factRevenue += net;
    const item = byType.get(trip.vehicle_type) || { vehicleType: trip.vehicle_type, trips: 0, netRevenue: 0, contribution: 0, vehicles: new Set() };
    item.trips += 1;
    item.netRevenue += net;
    item.contribution += margin;
    item.vehicles.add(trip.vehicle_id);
    byType.set(trip.vehicle_type, item);
  }
  const fixedPerVehicleDay =
    Number(calculation.leasePerVehicleDay || 0) + Number(calculation.overheadPerVehicleDay || 0);
  const fixed = fixedPerVehicleDay * vehicleCount * days;
  const operationalProfit = contribution - fixed;

  // Утилизация парка по машино-дням (каскад КТГ×КВЛ×КИП из ТК 21):
  // КТГ — техническая готовность (без ремонта), КВЛ — выход на линию (есть водитель),
  // КИП — использование (в рейсе). День относится к состоянию по своей середине.
  const fleet = db.prepare(`SELECT id FROM vehicles WHERE status<>'out'`).all();
  const dispositionRows = db.prepare(`SELECT vehicle_id,kind,starts_at,ends_at
    FROM vehicle_dispositions WHERE starts_at<? AND ends_at>?`).all(to, from);
  const tripRows = db.prepare(`SELECT vehicle_id,starts_at,ends_at FROM trips
    WHERE status<>'rejected' AND starts_at<? AND ends_at>?`).all(to, from);
  const byVehicleDispositions = Map.groupBy(dispositionRows, row => row.vehicle_id);
  const byVehicleTrips = Map.groupBy(tripRows, row => row.vehicle_id);
  const dayCount = Math.round(days);
  const fromMs = Date.parse(from);
  const machineDays = { work: 0, repair: 0, noDriver: 0, shift: 0, idle: 0, out: 0 };
  const covers = (row, momentMs) => Date.parse(row.starts_at) <= momentMs && momentMs < Date.parse(row.ends_at);
  for (const vehicle of fleet) {
    const vehicleDispositions = byVehicleDispositions.get(vehicle.id) || [];
    const vehicleTrips = byVehicleTrips.get(vehicle.id) || [];
    for (let day = 0; day < dayCount; day += 1) {
      const midpoint = fromMs + (day + 0.5) * 86_400_000;
      const disposition = vehicleDispositions.find(row => row.kind !== 'reserve' && covers(row, midpoint));
      if (disposition) {
        if (disposition.kind === 'repair') machineDays.repair += 1;
        else if (disposition.kind === 'no_driver') machineDays.noDriver += 1;
        else if (disposition.kind === 'shift') machineDays.shift += 1;
        else machineDays.out += 1;
      } else if (vehicleTrips.some(row => covers(row, midpoint))) {
        machineDays.work += 1;
      } else {
        machineDays.idle += 1;
      }
    }
  }
  const calendarDays = fleet.length * dayCount;
  const techDays = calendarDays - machineDays.repair - machineDays.out;
  const lineDays = techDays - machineDays.noDriver - machineDays.shift;
  const utilizationTarget = Number(calculation.utilizationTarget ?? 0.951);
  const tripDaysTotal = trips.reduce((sum, trip) =>
    sum + Math.max(0, (Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 86_400_000), 0);
  const marginPerTripDay = tripDaysTotal ? contribution / tripDaysTotal : 0;
  const normDays = calendarDays * utilizationTarget;
  const lostProfit = Math.max(0, normDays - machineDays.work) * marginPerTripDay;
  const utilization = {
    vehicles: fleet.length, days: dayCount, calendarDays, machineDays,
    techDays, lineDays, workDays: machineDays.work, idleDays: machineDays.idle,
    ktg: calendarDays ? techDays / calendarDays : 0,
    kvl: techDays ? lineDays / techDays : 0,
    kip: lineDays ? machineDays.work / lineDays : 0,
    overall: calendarDays ? machineDays.work / calendarDays : 0,
    utilizationTarget, normDays: Math.round(normDays),
    marginPerTripDay: Math.round(marginPerTripDay),
    lostProfit: Math.round(lostProfit)
  };

  const repairKmTotal = db.prepare(`SELECT COALESCE(SUM(repair_km),0) total
    FROM vehicle_dispositions WHERE kind='repair' AND starts_at>=? AND starts_at<?`)
    .get(from, to).total;
  const loadedKmTotal = trips.reduce((sum, trip) => sum + Number(trip.distance_km || 0), 0);
  const perKmRate = Number(calculation.costPerKm || 0) + Number(calculation.insuranceAndRoadsPerKm || 0);

  return {
    utilization,
    emptyKm: Math.round(emptyKmTotal),
    repairKm: Math.round(repairKmTotal),
    loadedKm: Math.round(loadedKmTotal),
    emptyRatio: loadedKmTotal + emptyKmTotal + repairKmTotal
      ? (emptyKmTotal + repairKmTotal) / (loadedKmTotal + emptyKmTotal + repairKmTotal) : 0,
    emptyCost: Math.round((emptyKmTotal + repairKmTotal) * perKmRate),
    from, to, days, trips: trips.length, vehicles: vehicleCount,
    factRevenue: Math.round(factRevenue), netRevenue: Math.round(netRevenue),
    contribution: Math.round(contribution), fixed: Math.round(fixed),
    operationalProfit: Math.round(operationalProfit),
    operationalMargin: netRevenue ? operationalProfit / netRevenue : 0,
    byVehicleType: [...byType.values()].map(item => {
      const typeFixed = fixedPerVehicleDay * item.vehicles.size * days;
      return {
        ...item, vehicles: item.vehicles.size, netRevenue: Math.round(item.netRevenue),
        contribution: Math.round(item.contribution),
        fixed: Math.round(typeFixed), operationalProfit: Math.round(item.contribution - typeFixed)
      };
    }).sort((a, b) => b.operationalProfit - a.operationalProfit)
  };
}

// Аналитика ресурса: вклад каждой сцепки за период — машино-дни по
// состояниям (та же методика midpoint, что и в reportSnapshot), КТГ,
// использование и выручка без НДС по дате выполнения. Используется
// модалкой «Аналитика» в «Ресурсе» и отчётом руководителя «По сцепкам».
export function vehicleUtilization(db, fromValue, toValue) {
  const from = isoDate(fromValue, 'from');
  const to = isoDate(toValue, 'to');
  if (Date.parse(to) <= Date.parse(from)) {
    throw Object.assign(new Error('Период задан неверно'), { status: 422 });
  }
  const calculation = settingsObject(db).calculation;
  const dayCount = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
  const fromMs = Date.parse(from);
  const fleet = db.prepare(`SELECT v.id,v.plate,v.driver_name,vt.name type_name FROM vehicles v
    JOIN vehicle_types vt ON vt.id=v.type_id WHERE v.status<>'out' ORDER BY v.plate`).all();
  const dispositionRows = db.prepare(`SELECT vehicle_id,kind,starts_at,ends_at
    FROM vehicle_dispositions WHERE starts_at<? AND ends_at>?`).all(to, from);
  const tripRows = db.prepare(`SELECT vehicle_id,starts_at,ends_at FROM trips
    WHERE status<>'rejected' AND starts_at<? AND ends_at>?`).all(to, from);
  const revenueRows = db.prepare(`SELECT vehicle_id,customer_name,revenue_vat,cash,distance_km,empty_km
    FROM trips WHERE status<>'rejected' AND ends_at>=? AND ends_at<?`).all(from, to);
  const repairKmByVehicle = new Map(db.prepare(`SELECT vehicle_id, SUM(repair_km) total
    FROM vehicle_dispositions WHERE kind='repair' AND repair_km IS NOT NULL
      AND starts_at>=? AND starts_at<? GROUP BY vehicle_id`).all(from, to)
    .map(row => [row.vehicle_id, row.total]));
  const byVehicleDispositions = Map.groupBy(dispositionRows, row => row.vehicle_id);
  const byVehicleTrips = Map.groupBy(tripRows, row => row.vehicle_id);
  const byVehicleRevenue = Map.groupBy(revenueRows, row => row.vehicle_id);
  const covers = (row, momentMs) => Date.parse(row.starts_at) <= momentMs && momentMs < Date.parse(row.ends_at);
  const items = fleet.map(vehicle => {
    const dispositions = byVehicleDispositions.get(vehicle.id) || [];
    const trips = byVehicleTrips.get(vehicle.id) || [];
    const counts = { work: 0, repair: 0, noDriver: 0, shift: 0, idle: 0, out: 0 };
    for (let day = 0; day < dayCount; day += 1) {
      const midpoint = fromMs + (day + 0.5) * 86_400_000;
      const disposition = dispositions.find(row => row.kind !== 'reserve' && covers(row, midpoint));
      if (disposition) {
        if (disposition.kind === 'repair') counts.repair += 1;
        else if (disposition.kind === 'no_driver') counts.noDriver += 1;
        else if (disposition.kind === 'shift') counts.shift += 1;
        else counts.out += 1;
      } else if (trips.some(row => covers(row, midpoint))) {
        counts.work += 1;
      } else {
        counts.idle += 1;
      }
    }
    const netRevenue = (byVehicleRevenue.get(vehicle.id) || []).reduce((sum, trip) => {
      const vat = trip.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
        ? Number(calculation.individualEntrepreneurVatRate ?? 0.07)
        : Number(calculation.vatRate ?? 0.22);
      return sum + trip.revenue_vat / (1 + vat);
    }, 0);
    const vehicleTripRows = byVehicleRevenue.get(vehicle.id) || [];
    const loadedKm = vehicleTripRows.reduce((sum, row) => sum + Number(row.distance_km || 0), 0);
    const emptyKm = vehicleTripRows.reduce((sum, row) => sum + Number(row.empty_km || 0), 0) +
      Number(repairKmByVehicle.get(vehicle.id) || 0);
    return {
      vehicleId: vehicle.id, plate: vehicle.plate,
      driver: vehicle.driver_name || '', type: vehicle.type_name,
      ...counts,
      loadedKm: Math.round(loadedKm),
      emptyKm: Math.round(emptyKm),
      emptyRatio: loadedKm + emptyKm ? emptyKm / (loadedKm + emptyKm) : 0,
      trips: vehicleTripRows.length,
      ktg: (dayCount - counts.repair - counts.out) / dayCount,
      utilization: counts.work / dayCount,
      netRevenue: Math.round(netRevenue)
    };
  });
  return { from, to, days: dayCount, items };
}
