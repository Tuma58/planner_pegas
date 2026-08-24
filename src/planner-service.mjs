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

// Нормативы на АКТИВНЫЙ день по должности — для план/факта в отчёте
// «Показатели сотрудников». Значения по умолчанию; подстраиваются под
// предприятие правкой этой таблицы.
// Расчёт от суточных целей (60 отправок и 5 млн выгрузок в день) и штата
// смены: продажи 2, логист 1, диспетчер 2. Смены чередуются, поэтому за
// свой активный день состав пропускает ВЕСЬ суточный объём — норматив
// на активный день сотрудника равен суточной цели, делённой на штат смены.
// Факты прода 18–19.08: отправок 48–62, выгрузок 5,3–5,9 млн, шагов
// чек-листа 356–371/день, фактов на линии до 381/день — цели достижимы.
export const STAFF_PLANS = {
  sales: { label: 'Продажи', metrics: [
    ['orderCreate', 'Заявок внесено', 35],
    ['ordersSum', 'Сумма внесённого, ₽', 2_900_000],
    ['orderAssign', 'Назначено ТС', 8]
  ] },
  logist: { label: 'Логист', metrics: [
    ['orderAssign', 'Назначено ТС', 60],
    ['dispatchSteps', 'Подтверждений/шагов', 60],
    ['orderUpdate', 'Правок заявок', 15]
  ] },
  dispatcher: { label: 'Диспетчер', metrics: [
    ['dispatchSteps', 'Шагов чек-листа', 120],
    ['stopFacts', 'Фактов на линии', 150],
    ['marks', 'Отметок контроля', 12]
  ] },
  resource: { label: 'Ресурс', metrics: [
    ['dispositions', 'Диспозиций', 5],
    ['marks', 'Отметок явки/задач', 3],
    ['tripEdits', 'Правок парка/рейсов', 5]
  ] }
};

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
  const jobRoles = new Map(db.prepare(`SELECT full_name, job_role, id FROM users`).all()
    .map(row => [row.full_name, { jobRole: row.job_role || '', userId: row.id }]));
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
  return { plans: STAFF_PLANS, items: [...byId.values()]
    .map(item => ({ ...item,
      jobRole: jobRoles.get(item.name)?.jobRole || '',
      userId: jobRoles.get(item.name)?.userId || null,
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
// Эффективная явка дня: ручная отметка приоритетна, остальное система
// выводит сама — цель: начальник автоколонны отмечает только внештатное.
// Авто-правила: машина водителя в рейсе в этот день → «вышел» (если по
// графику у него отдых — это работа в выходной, overwork/↑ФОТ);
// отпуск/больничный по карточке → невыход с той причиной; межвахта по
// вахте или интервал «без водителя» на его машине → «выходной по графику».
// Периодная подмена уводит машину у постоянного на эти дни.
export function attendanceEffective(db, day) {
  const dayStartIso = `${day}T00:00:00.000Z`;
  const dayEndIso = `${day}T23:59:59.999Z`;
  const midIso = `${day}T12:00:00.000Z`;
  const manual = new Map(db.prepare(`SELECT * FROM driver_attendance WHERE day=?`).all(day)
    .map(row => [row.driver_id, row]));
  const drivers = db.prepare(`SELECT d.*, v.plate vehicle_plate FROM drivers d
    LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.status<>'fired'
    ORDER BY d.full_name`).all();
  const planned = db.prepare(`SELECT driver_id, vehicle_id FROM driver_assignments
    WHERE starts_at <= ? AND ends_at > ?`).all(day, day);
  const plannedByDriver = new Map(planned.map(item => [item.driver_id, item.vehicle_id]));
  const plannedVehicles = new Set(planned.map(item => item.vehicle_id));
  // Незавершённый рейс (план/в пути) покрывает день и после расчётного
  // конца — водитель за рулём, пока не проставлен факт выгрузки.
  const tripOn = db.prepare(`SELECT 1 FROM trips WHERE vehicle_id=? AND status<>'rejected'
    AND starts_at < ?
    AND (ends_at > ? OR (status IN ('plan','run') AND ends_at > datetime('now','-3 days'))) LIMIT 1`);
  const noDriverOn = db.prepare(`SELECT 1 FROM vehicle_dispositions WHERE vehicle_id=?
    AND kind='no_driver' AND starts_at < ? AND ends_at > ? LIMIT 1`);
  return drivers.map(driver => {
    const base = { driver_id: driver.id, full_name: driver.full_name,
      vehicle_plate: driver.vehicle_plate || '', note: manual.get(driver.id)?.note || '' };
    const hand = manual.get(driver.id);
    if (hand) return { ...base, status: hand.status, reason: hand.reason, source: 'manual' };
    // Машина водителя на этот день: периодная подмена приоритетнее.
    const vehicleId = plannedByDriver.get(driver.id) ||
      (driver.vehicle_id && !plannedVehicles.has(driver.vehicle_id) ? driver.vehicle_id : null);
    const restByShift = !shiftIsWorkday(driver.shift_on, driver.shift_off, driver.shift_anchor, day);
    const absentCard = driver.absent_from && driver.absent_to &&
      driver.absent_from <= dayEndIso && driver.absent_to >= dayStartIso;
    const inTrip = vehicleId && tripOn.get(vehicleId, dayEndIso, dayStartIso);
    if (inTrip) {
      return { ...base, status: 'present', reason: '', source: 'auto',
        auto: 'в рейсе', overwork: Boolean(restByShift || absentCard) };
    }
    if (absentCard) {
      return { ...base, status: 'absent',
        reason: driver.status === 'sick' ? 'sick' : 'vacation', source: 'auto',
        auto: driver.status === 'sick' ? 'больничный по карточке' : 'отпуск по карточке' };
    }
    if (restByShift) return { ...base, status: 'absent', reason: 'dayoff',
      source: 'auto', auto: 'межвахта по графику' };
    if (vehicleId && noDriverOn.get(vehicleId, dayEndIso, dayStartIso)) {
      return { ...base, status: 'absent', reason: 'dayoff', source: 'auto',
        auto: 'выходной (интервал)' };
    }
    return { ...base, status: null, reason: '', source: null };
  });
}

// Табель за период на основе эффективной явки. Коды: Я — работал,
// РВ — работа в выходной (↑ФОТ), В — выходной по графику, ОТ — отпуск,
// Б — больничный, ПР — прогул, С — стажировка, П — прочее, · — не отмечено.
export const TIMESHEET_CODES = {
  'Я': 'работал', 'РВ': 'работа в выходной (↑ФОТ)', 'В': 'выходной по графику',
  'ОТ': 'отпуск', 'Б': 'больничный', 'ПР': 'прогул', 'С': 'стажировка',
  'П': 'прочее', '·': 'не отмечено'
};
const timesheetCode = item => {
  if (item.status === 'present') return item.overwork ? 'РВ' : 'Я';
  if (item.status === 'absent') {
    return { dayoff: 'В', vacation: 'ОТ', sick: 'Б', truancy: 'ПР',
      intern: 'С', other: 'П' }[item.reason] || 'П';
  }
  return '·';
};
export function attendanceTimesheet(db, fromDay, toDay) {
  const days = [];
  for (let ms = Date.parse(`${fromDay}T00:00:00Z`);
       ms < Date.parse(`${toDay}T00:00:00Z`); ms += 86_400_000) {
    days.push(new Date(ms).toISOString().slice(0, 10));
    if (days.length > 62) throw Object.assign(new Error('Период табеля — не больше 62 дней'), { status: 422 });
  }
  const rows = new Map();
  for (const day of days) {
    for (const item of attendanceEffective(db, day)) {
      if (!rows.has(item.driver_id)) {
        rows.set(item.driver_id, { driverId: item.driver_id, name: item.full_name,
          plate: item.vehicle_plate, days: {}, totals: {} });
      }
      const row = rows.get(item.driver_id);
      const code = timesheetCode(item);
      row.days[day] = code;
      row.totals[code] = (row.totals[code] || 0) + 1;
    }
  }
  return { days, codes: TIMESHEET_CODES,
    rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
}

export function attendanceSummary(db, day) {
  const drivers = db.prepare(`SELECT COUNT(*) count FROM drivers WHERE status<>'fired'`).get().count;
  const vehicles = db.prepare(`SELECT COUNT(*) count FROM vehicles WHERE status<>'out'`).get().count;
  const items = attendanceEffective(db, day);
  const byReason = {};
  let present = 0;
  let absent = 0;
  let overwork = 0;
  for (const item of items) {
    if (item.status === 'present') { present += 1; if (item.overwork) overwork += 1; }
    else if (item.status === 'absent') {
      absent += 1;
      byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    }
  }
  return {
    drivers, vehicles, present, absent, byReason, overwork,
    unmarked: Math.max(0, drivers - present - absent),
    staffing: vehicles ? drivers / vehicles : 0,
    staffingTarget: 1.45
  };
}

// ── Занятость сцепки рейсом — по ФАКТУ, единая методика для отчётов ──
// Начало — вывод на линию (on_line_at), если он раньше плановой погрузки
// (машина едет на погрузку, ресурс занят); конец — фактическая выгрузка,
// у незавершённого (план/в пути) — не раньше «сейчас». Плановые даты рейса
// занижали «машин на линии»: выведенные заранее и опаздывающие выпадали.
const busyTs = value => value
  ? Date.parse(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`) : NaN;
export function tripBusyRange(trip, nowMs = Date.now()) {
  const plannedFrom = Date.parse(trip.starts_at);
  const onLine = busyTs(trip.on_line_at);
  const from = Number.isFinite(onLine) ? Math.min(onLine, plannedFrom) : plannedFrom;
  const plannedTo = Date.parse(trip.ends_at);
  let to;
  if (trip.status === 'plan' || trip.status === 'run') to = Math.max(plannedTo, nowMs);
  else {
    const fact = busyTs(trip.unloaded_at);
    to = Number.isFinite(fact) ? fact : plannedTo;
  }
  return { from, to: Math.max(to, from) };
}

// Состояние машино-дня: диспозиция (кроме резерва) с наибольшим пересечением
// с днём от 4 часов → её вид; иначе рейсы по факту суммарно ≥ 4 часов в дне
// → «в работе»; иначе простой. Порог в четверть суток вместо прежней
// «пробы по полудню»: короткий дневной ремонт или рейс, начатый после
// обеда, больше не теряются, а 10-минутное касание день не окрашивает.
export const DAY_STATE_MIN_MS = 4 * 3_600_000;
export function dayStateOf(trips, dispositions, dayStartMs, nowMs = Date.now()) {
  const dayEndMs = dayStartMs + 86_400_000;
  const overlap = (from, to) => Math.max(0, Math.min(to, dayEndMs) - Math.max(from, dayStartMs));
  let best = null;
  for (const row of dispositions) {
    if (row.kind === 'reserve') continue;
    const ms = overlap(Date.parse(row.starts_at), Date.parse(row.ends_at));
    if (ms >= DAY_STATE_MIN_MS && (!best || ms > best.ms)) best = { ms, kind: row.kind };
  }
  if (best) return best.kind === 'repair' ? 'repair' : best.kind === 'no_driver' ? 'noDriver'
    : best.kind === 'shift' ? 'shift' : 'out';
  const tripMs = trips.reduce((sum, trip) => {
    const range = tripBusyRange(trip, nowMs);
    return sum + overlap(range.from, range.to);
  }, 0);
  return tripMs >= DAY_STATE_MIN_MS ? 'work' : 'idle';
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
  // Будущие дни периода (открытый месяц до его конца) в машино-дни не входят:
  // по ним ещё нет ни рейсов, ни фактов — они считались бы простоем всего
  // парка и занижали КИП (за 1–31 августа 21-го числа КИП был 66% вместо 94%).
  const tomorrowIso = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(),
    new Date().getUTCDate() + 1)).toISOString();
  const effectiveTo = Date.parse(to) < Date.parse(tomorrowIso) ? to : tomorrowIso;
  const countedDays = Math.max(0, Math.round((Date.parse(effectiveTo) - Date.parse(from)) / 86_400_000));
  const byType = new Map();
  let netRevenue = 0;
  let netRevenueDone = 0;
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
    if (trip.status === 'unloaded' || trip.status === 'done' || trip.status === 'paid') netRevenueDone += net;
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
  // Рейсы — с запасом по датам (вывод на линию раньше плана, опоздание позже).
  const tripRows = db.prepare(`SELECT vehicle_id,status,starts_at,ends_at,on_line_at,unloaded_at FROM trips
    WHERE status<>'rejected' AND starts_at<datetime(?,'+3 days') AND ends_at>datetime(?,'-3 days')`).all(to, from);
  const byVehicleDispositions = Map.groupBy(dispositionRows, row => row.vehicle_id);
  const byVehicleTrips = Map.groupBy(tripRows, row => row.vehicle_id);
  const dayCount = countedDays;
  const fromMs = Date.parse(from);
  const machineDays = { work: 0, repair: 0, noDriver: 0, shift: 0, idle: 0, out: 0 };
  for (const vehicle of fleet) {
    const vehicleDispositions = byVehicleDispositions.get(vehicle.id) || [];
    const vehicleTrips = byVehicleTrips.get(vehicle.id) || [];
    for (let day = 0; day < dayCount; day += 1) {
      machineDays[dayStateOf(vehicleTrips, vehicleDispositions, fromMs + day * 86_400_000)] += 1;
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
    vehicles: fleet.length, days: dayCount, periodDays: Math.round(days),
    futureDays: Math.max(0, Math.round(days) - dayCount), calendarDays, machineDays,
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
    factRevenue: Math.round(factRevenue), netRevenue: Math.round(netRevenue), netRevenueDone: Math.round(netRevenueDone),
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
  // Будущие дни периода не учитываются (см. reportSnapshot).
  const tomorrowMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
  const dayCount = Math.max(0, Math.round((Math.min(Date.parse(to), tomorrowMs) - Date.parse(from)) / 86_400_000));
  const fromMs = Date.parse(from);
  const fleet = db.prepare(`SELECT v.id,v.plate,v.driver_name,vt.name type_name FROM vehicles v
    JOIN vehicle_types vt ON vt.id=v.type_id WHERE v.status<>'out' ORDER BY v.plate`).all();
  const dispositionRows = db.prepare(`SELECT vehicle_id,kind,starts_at,ends_at
    FROM vehicle_dispositions WHERE starts_at<? AND ends_at>?`).all(to, from);
  const tripRows = db.prepare(`SELECT vehicle_id,status,starts_at,ends_at,on_line_at,unloaded_at FROM trips
    WHERE status<>'rejected' AND starts_at<datetime(?,'+3 days') AND ends_at>datetime(?,'-3 days')`).all(to, from);
  const revenueRows = db.prepare(`SELECT vehicle_id,customer_name,revenue_vat,cash,distance_km,empty_km
    FROM trips WHERE status<>'rejected' AND ends_at>=? AND ends_at<?`).all(from, to);
  const repairKmByVehicle = new Map(db.prepare(`SELECT vehicle_id, SUM(repair_km) total
    FROM vehicle_dispositions WHERE kind='repair' AND repair_km IS NOT NULL
      AND starts_at>=? AND starts_at<? GROUP BY vehicle_id`).all(from, to)
    .map(row => [row.vehicle_id, row.total]));
  const byVehicleDispositions = Map.groupBy(dispositionRows, row => row.vehicle_id);
  const byVehicleTrips = Map.groupBy(tripRows, row => row.vehicle_id);
  const byVehicleRevenue = Map.groupBy(revenueRows, row => row.vehicle_id);
  const items = fleet.map(vehicle => {
    const dispositions = byVehicleDispositions.get(vehicle.id) || [];
    const trips = byVehicleTrips.get(vehicle.id) || [];
    const counts = { work: 0, repair: 0, noDriver: 0, shift: 0, idle: 0, out: 0 };
    for (let day = 0; day < dayCount; day += 1) {
      counts[dayStateOf(trips, dispositions, fromMs + day * 86_400_000)] += 1;
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

// ── Простой под погрузкой и под выгрузкой (претензии клиентам) ──
// Отсчёт — от планового времени операции по заявке клиента (окно «с»/«по»),
// но не раньше фактического прибытия: опоздание машины на точку виной
// клиента не является. Конец — факт завершения операции (убытие, окончание
// работ, выгрузка); у стоящих сейчас — текущий момент, простой растёт.
// Случай без отметки прибытия не фиксируется: претензия бездоказательна.
// Сверх бесплатного норматива (demurrageFreeHours) клиенту выставляется
// каждый начатый час по тарифу demurrageRatePerHour.
const demurrageTs = value => value
  ? Date.parse(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`)
  : NaN;

export function demurrageSettings(db) {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get();
  const calculation = row ? JSON.parse(row.value_json) : {};
  return {
    freeHours: Number(calculation.demurrageFreeHours ?? 8),
    rate: Number(calculation.demurrageRatePerHour ?? 1000)
  };
}

export function demurrageCases(db, nowMs = Date.now()) {
  const { freeHours, rate } = demurrageSettings(db);
  const since = new Date(nowMs - 45 * 86_400_000).toISOString();
  const trips = db.prepare(`SELECT t.id,t.status,t.starts_at,t.ends_at,t.order_id,t.order_no,
      t.customer_name,t.from_point,t.to_point,t.arrived_at,t.unloaded_at,t.on_line_at,
      v.plate vehicle_plate,v.trailer_plate,v.driver_name
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    WHERE t.status<>'rejected' AND t.ends_at>?`).all(since);
  const orderStmt = db.prepare(`SELECT * FROM orders WHERE deleted_at IS NULL AND (trip_id=? OR id=?)`);
  const stopsStmt = db.prepare(`SELECT * FROM trip_stops WHERE trip_id=? ORDER BY seq`);
  const cases = [];
  const push = (trip, order, kind, point, planMs, arrivedMs, endMs, open) => {
    // План неизвестен (нет заявки и дат) — отсчёт от прибытия.
    const startMs = Number.isFinite(planMs) ? Math.max(planMs, arrivedMs) : arrivedMs;
    const idleHours = (endMs - startMs) / 3_600_000;
    if (!(idleHours > freeHours)) return;
    const paidHours = Math.ceil(idleHours - freeHours);
    cases.push({
      tripId: trip.id, kind, open,
      customer: trip.customer_name || order?.customer_name || '',
      orderNo: String(trip.order_no || order?.order_no || ''),
      vehiclePlate: trip.vehicle_plate, trailerPlate: trip.trailer_plate || '',
      driverName: trip.driver_name || '', point: point || '',
      planAt: new Date(Number.isFinite(planMs) ? planMs : arrivedMs).toISOString(),
      arrivedAt: new Date(arrivedMs).toISOString(),
      finishedAt: open ? null : new Date(endMs).toISOString(),
      idleHours: Math.round(idleHours * 10) / 10,
      paidHours, rate, amount: paidHours * rate
    });
  };
  for (const trip of trips) {
    const order = orderStmt.get(trip.id, trip.order_id || '');
    const stops = stopsStmt.all(trip.id);
    const firstLoad = stops.find(stop => stop.kind === 'P');
    const lastUnload = [...stops].reverse().find(stop => stop.kind === 'D');
    // Погрузка: план — окно «с» заявки; факты — первая P-стоянка,
    // завершение — убытие/окончание работ/вывод на линию.
    const loadArrived = demurrageTs(firstLoad?.actual_arrival);
    if (Number.isFinite(loadArrived)) {
      const loadPlan = demurrageTs(order?.window_from) || demurrageTs(trip.starts_at);
      const loadEnd = demurrageTs(firstLoad?.actual_departure)
        || demurrageTs(firstLoad?.work_finished_at) || demurrageTs(trip.on_line_at);
      const open = !Number.isFinite(loadEnd) && trip.status === 'plan';
      if (Number.isFinite(loadEnd) || open) {
        push(trip, order, 'load', firstLoad?.point || trip.from_point,
          loadPlan, loadArrived, Number.isFinite(loadEnd) ? loadEnd : nowMs, open);
      }
    }
    // Выгрузка: план — окно «по» заявки; факты — последняя D-стоянка
    // либо этапы рейса (прибыл на выгрузку / выгружен).
    const unloadArrived = demurrageTs(lastUnload?.actual_arrival) || demurrageTs(trip.arrived_at);
    if (Number.isFinite(unloadArrived)) {
      const unloadPlan = demurrageTs(order?.window_to) || demurrageTs(trip.ends_at);
      const unloadEnd = demurrageTs(lastUnload?.actual_departure)
        || demurrageTs(lastUnload?.work_finished_at) || demurrageTs(trip.unloaded_at);
      const open = !Number.isFinite(unloadEnd) && trip.status === 'run';
      if (Number.isFinite(unloadEnd) || open) {
        push(trip, order, 'unload', lastUnload?.point || trip.to_point,
          unloadPlan, unloadArrived, Number.isFinite(unloadEnd) ? unloadEnd : nowMs, open);
      }
    }
  }
  cases.sort((a, b) => Number(b.open) - Number(a.open) || b.amount - a.amount);
  return cases;
}

// Лёгкая сводка для bootstrap: плашки во всех блоках.
export function demurrageSummary(db, nowMs = Date.now()) {
  const cases = demurrageCases(db, nowMs);
  const open = cases.filter(item => item.open);
  const monthPrefix = new Date(nowMs).toISOString().slice(0, 7);
  const month = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) s
    FROM demurrage_claims WHERE status<>'cancelled' AND created_day LIKE ?`)
    .get(`${monthPrefix}%`);
  return {
    openCount: open.length,
    openLoad: open.filter(item => item.kind === 'load').length,
    openUnload: open.filter(item => item.kind === 'unload').length,
    openAmount: open.reduce((sum, item) => sum + item.amount, 0),
    monthCount: month.c, monthAmount: month.s
  };
}

// ── Внутренний чат: видимость сообщений ──
// Четыре вида переписок (как в Telegram):
// «Общий» — людские сообщения без адресата, видят все;
// «Конвейер» — авто-уведомления процесса, каждому по его ролям
//   (target_role входит в роли сотрудника; без target_role — всем);
// личные — только отправитель и получатель;
// группы — участники чата (chat_members). Поллинг инкрементальный по id.
export function chatMessages(db, userId, userRoles = [], after = 0) {
  const rolesJson = JSON.stringify(userRoles);
  const visible = `(
    (recipient_id IS NULL AND chat_id IS NULL AND kind='user')
    OR (kind='auto' AND chat_id IS NULL AND recipient_id IS NULL
        AND (target_role IS NULL OR target_role IN (SELECT value FROM json_each(?))))
    OR recipient_id=? OR (author_id=? AND recipient_id IS NOT NULL)
    OR chat_id IN (SELECT m.chat_id FROM chat_members m
        JOIN chats c ON c.id=m.chat_id AND c.deleted_at IS NULL WHERE m.user_id=?)
  )`;
  const params = [rolesJson, userId, userId, userId];
  const items = after > 0
    ? db.prepare(`SELECT * FROM messages WHERE id>? AND ${visible} ORDER BY id LIMIT 300`)
      .all(after, ...params)
    : db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE ${visible}
        ORDER BY id DESC LIMIT 300) ORDER BY id`).all(...params);
  const lastId = db.prepare('SELECT MAX(id) id FROM messages').get().id || 0;
  return { items, lastId };
}

// Группы пользователя со списком участников — для списка чатов.
export function chatGroups(db, userId) {
  return db.prepare(`SELECT c.id, c.title, c.created_by,
      (SELECT json_group_array(json_object('id', u.id, 'name', u.full_name))
       FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=c.id) members
    FROM chats c
    WHERE c.deleted_at IS NULL
      AND c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?)
    ORDER BY c.title`).all(userId)
    .map(row => ({ ...row, members: JSON.parse(row.members || '[]') }));
}


// ── CRM-карточка клиента: праздники, ближайшие даты, сводка ──
// Поздравления — часть ведения клиента: дни рождения контактов и деловые
// праздники напоминаются продажам заранее (чат «Конвейер») и видны в карточке.
export const HOLIDAYS = [
  { mmdd: '01-01', name: 'Новый год', before: 7 },
  { mmdd: '02-23', name: 'День защитника Отечества', before: 3 },
  { mmdd: '03-08', name: 'Международный женский день', before: 3 },
  { mmdd: '05-01', name: 'Праздник Весны и Труда', before: 2 },
  { mmdd: '05-09', name: 'День Победы', before: 2 },
  { mmdd: '06-12', name: 'День России', before: 2 },
  { mmdd: '11-04', name: 'День народного единства', before: 2 },
  { mmdd: '11-20', name: 'День работника транспорта', before: 3 }
];

// Дней до ближайшей годовщины даты 'MM-DD' (или 'YYYY-MM-DD') от nowMs (UTC-дни).
export function daysUntilAnnual(value, nowMs = Date.now()) {
  const mmdd = String(value || '').slice(-5);
  if (!/^\d{2}-\d{2}$/.test(mmdd)) return null;
  const today = new Date(nowMs);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const target = Date.parse(`${year}-${mmdd}T00:00:00Z`);
    if (!Number.isFinite(target)) return null;
    const diff = Math.round((target - todayUtc) / 86_400_000);
    if (diff >= 0) return diff;
  }
  return null;
}

// Ближайшие поводы: дни рождения контактов клиентов и праздники в горизонте.
export function upcomingCustomerDates(db, nowMs = Date.now(), horizonDays = 7) {
  const items = [];
  for (const contact of db.prepare(`SELECT * FROM customer_contacts WHERE birthday IS NOT NULL AND birthday<>''`).all()) {
    const daysLeft = daysUntilAnnual(contact.birthday, nowMs);
    if (daysLeft === null || daysLeft > horizonDays) continue;
    items.push({ kind: 'birthday', customer: contact.customer_name, contactId: contact.id,
      contact: contact.full_name, position: contact.position, date: contact.birthday.slice(-5), daysLeft });
  }
  for (const holiday of HOLIDAYS) {
    const daysLeft = daysUntilAnnual(holiday.mmdd, nowMs);
    if (daysLeft === null || daysLeft > Math.max(horizonDays, holiday.before)) continue;
    items.push({ kind: 'holiday', name: holiday.name, date: holiday.mmdd, daysLeft, before: holiday.before });
  }
  return items.sort((a, b) => a.daysLeft - b.daysLeft);
}

export function customerCard(db, name, nowMs = Date.now()) {
  const profile = db.prepare('SELECT * FROM customer_profiles WHERE customer_name=?').get(name) || {
    customer_name: name, inn: '', segment: '', status: 'active', manager_id: null,
    contract_no: '', contract_until: null, payment_days: null, conditions: '', next_contact_at: null, tags: ''
  };
  const manager = profile.manager_id
    ? db.prepare('SELECT full_name FROM users WHERE id=?').get(profile.manager_id)?.full_name || '' : '';
  const contacts = db.prepare('SELECT * FROM customer_contacts WHERE customer_name=? ORDER BY full_name').all(name)
    .map(contact => ({ ...contact, daysToBirthday: contact.birthday ? daysUntilAnnual(contact.birthday, nowMs) : null }));
  const notes = db.prepare(`SELECT * FROM customer_notes WHERE customer_name=?
    ORDER BY created_at DESC LIMIT 60`).all(name);
  const orders = db.prepare(`SELECT o.*, t.status trip_status, t.vehicle_id, v.plate vehicle_plate
    FROM orders o LEFT JOIN trips t ON t.id=o.trip_id LEFT JOIN vehicles v ON v.id=t.vehicle_id
    WHERE o.customer_name=? AND o.deleted_at IS NULL ORDER BY o.window_from DESC LIMIT 40`).all(name);
  const trips = db.prepare(`SELECT status, starts_at, ends_at, revenue_vat, from_zone_id, to_zone_id,
      from_point, to_point,
      (SELECT name FROM zones WHERE id=trips.from_zone_id) from_name,
      (SELECT name FROM zones WHERE id=trips.to_zone_id) to_name
    FROM trips WHERE customer_name=? AND status<>'rejected'`).all(name);
  const ms30 = nowMs - 30 * 86_400_000;
  const ms90 = nowMs - 90 * 86_400_000;
  const doneStatuses = new Set(['unloaded', 'done', 'paid']);
  const done = trips.filter(trip => doneStatuses.has(trip.status));
  const endMs = trip => Date.parse(trip.ends_at);
  const sum = list => list.reduce((acc, trip) => acc + Number(trip.revenue_vat || 0), 0);
  const last30 = done.filter(trip => endMs(trip) >= ms30);
  const last90 = done.filter(trip => endMs(trip) >= ms90);
  const lanes = {};
  for (const trip of trips) {
    const key = `${trip.from_name || ''} → ${trip.to_name || ''}`;
    lanes[key] = (lanes[key] || 0) + 1;
  }
  const claims = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM demurrage_claims
    WHERE customer_name=? AND status<>'cancelled'`).get(name);
  const lastTripMs = done.length ? Math.max(...done.map(endMs)) : null;
  return {
    name, profile: { ...profile, manager_name: manager }, contacts, notes, orders,
    stats: {
      tripsTotal: trips.length, tripsDone: done.length,
      active: trips.filter(trip => trip.status === 'plan' || trip.status === 'run').length,
      count30: last30.length, sum30: sum(last30), count90: last90.length, sum90: sum(last90),
      sumAll: sum(done), avgCheck: done.length ? sum(done) / done.length : 0,
      lastTripAt: lastTripMs ? new Date(lastTripMs).toISOString() : null,
      daysSinceLast: lastTripMs ? Math.floor((nowMs - lastTripMs) / 86_400_000) : null,
      firstTripAt: trips.length ? trips.map(trip => trip.starts_at).sort()[0] : null,
      topLanes: Object.entries(lanes).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([lane, count]) => ({ lane, count })),
      claimsCount: claims.c, claimsSum: claims.s
    },
    dates: upcomingCustomerDates(db, nowMs, 30).filter(item => item.kind === 'holiday' || item.customer === name)
  };
}


// ── Правило «два рейса»: машины в пути без назначенного следующего рейса ──
// Выборка для сигнала логисту: плановая выгрузка в ближайшие horizonMs
// (по умолчанию 2 часа) или уже просрочена, а следующего рейса (план с
// началом не раньше текущего) у машины нет; по каждому рейсу — один раз
// (trips.next_alert_at).
export function tripsWithoutNext(db, nowMs = Date.now(), horizonMs = 2 * 3_600_000, onlyUnalerted = true) {
  const until = new Date(nowMs + horizonMs).toISOString();
  const rows = db.prepare(`SELECT t.id, t.vehicle_id, t.starts_at, t.ends_at, t.to_point, t.customer_name,
      t.next_alert_at, v.plate,
      (SELECT name FROM zones WHERE id=t.to_zone_id) to_name
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    WHERE t.status='run' AND t.ends_at<=? ORDER BY t.ends_at`).all(until);
  const hasNext = db.prepare(`SELECT 1 FROM trips WHERE vehicle_id=? AND status='plan'
    AND id<>? AND starts_at>=? LIMIT 1`);
  return rows.filter(trip => (!onlyUnalerted || !trip.next_alert_at) &&
    !hasNext.get(trip.vehicle_id, trip.id, trip.starts_at));
}

// ── Отчёт за смену: операции сотрудников по именам и время обработки ──
// Смены по 12 часов (МСК): дневная 08:00–20:00, ночная 20:00–08:00
// следующего дня. Источник операций — журнал аудита (каждое действие несёт
// исполнителя и момент); «время обработки» — сколько задание ждало этого
// шага от момента, когда предыдущее звено каскада его передало.

const MSK_MS = 3 * 3_600_000;

// Границы смены: dayIso — дата НАЧАЛА смены (по МСК), kind: day | night.
export function shiftBounds(dayIso, kind = 'day') {
  const startHour = kind === 'night' ? 20 : 8;
  const startMs = Date.parse(`${dayIso}T00:00:00Z`) + startHour * 3_600_000 - MSK_MS;
  return {
    fromIso: new Date(startMs).toISOString(),
    toIso: new Date(startMs + 12 * 3_600_000).toISOString(),
    label: kind === 'night'
      ? `ночная смена ${dayIso} 20:00 — 08:00`
      : `дневная смена ${dayIso} 08:00 — 20:00`
  };
}

// Текущая смена на момент nowMs: дата начала + вид.
export function currentShift(nowMs = Date.now()) {
  const msk = new Date(nowMs + MSK_MS);
  const hour = msk.getUTCHours();
  if (hour >= 8 && hour < 20) return { day: msk.toISOString().slice(0, 10), kind: 'day' };
  // Ночная: началась сегодня в 20:00 либо вчера (если сейчас до 08:00).
  const startDay = hour >= 20 ? msk : new Date(msk.getTime() - 86_400_000);
  return { day: startDay.toISOString().slice(0, 10), kind: 'night' };
}

// Имя собственное операции по записи аудита; null — операция не конвейерная
// (настройки, чат, справочники) и в отчёт смены не входит.
export function operationNameOf(row) {
  const details = (() => { try { return JSON.parse(row.details_json || '{}'); } catch { return {}; } })();
  if (row.entity === 'order') {
    if (row.action === 'create') return details.from === 'rejected-trip' ? null : 'Внесение заявки';
    if (row.action === 'assign') return 'Назначение ТС';
    if (row.action === 'delete') return 'Удаление заявки';
    if (row.action === 'update') {
      if (details.status === 'cancelled') return 'Отклонение заявки';
      if (details.status === 'new' && Number(details.stage) === 0) return 'Возврат заявки в работу';
      if (Number(details.stage) === 1 && Object.keys(details).length === 1) return 'Подтверждение заявки';
      return 'Правка заявки';
    }
    return null;
  }
  if (row.entity === 'trip') {
    if (row.action === 'dispatch_step') {
      return {
        logist_confirm: 'Подтверждение назначения',
        entered_1c: 'Проведение заказа в 1С',
        driver_notified: 'Задание водителю',
        on_line: 'Вывод на контроль линии',
        docs_checked: 'Проверка документов'
      }[details.step] || null;
    }
    if (row.action === 'confirm-sum') return 'Уточнение суммы по заявке';
    if (row.action === 'arrived') return 'Отметка прибытия';
    if (row.action === 'demurrage') return 'Фиксация простоя';
    if (row.action === 'notify_delay') return 'Уведомление об опоздании';
    if (row.action === 'create') return 'Создание рейса вручную';
    if (row.action === 'update') {
      if (details.status === 'rejected') return 'Снятие рейса';
      if (details.status === 'run') return 'Отметка выхода в рейс';
      if (details.status === 'unloaded') return 'Отметка выгрузки';
      if (details.status === 'done') return 'Завершение рейса';
      if (details.status === 'paid') return 'Отметка оплаты';
      return 'Правка рейса';
    }
    return null;
  }
  if (row.entity === 'control' && row.action === 'control-worked') return 'Контроль на линии';
  if (row.entity === 'demurrage') {
    if (row.action === 'demurrage-status') {
      const status = details.status;
      if (status === 'billed') return 'Выставление претензии';
      if (status === 'cancelled') return 'Отмена претензии';
      return 'Возврат претензии в работу';
    }
    return null;
  }
  if (row.entity === 'driver' && row.action === 'attendance') return 'Отметка явки водителя';
  if (row.entity === 'trip_stop') return 'Правка стоянки контроля';
  if (row.entity === 'route') {
    if (row.action === 'create') return 'Сборка маршрута';
    if (row.action === 'assign') return 'Назначение маршрута';
    return null;
  }
  return null;
}

// Метки времени в базе двух видов: ISO с зоной (клиентские) и
// «ГГГГ-ММ-ДД ЧЧ:ММ:СС» без зоны (CURRENT_TIMESTAMP, это UTC) — вторые
// без явного «Z» парсились бы как местное время (сдвиг на 3 часа).
const serverTimeMs = value => {
  const text = String(value || '');
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)
    ? `${text.replace(' ', 'T')}Z` : text);
};

// Время обработки: момент, когда задание стало доступно исполнителю
// (передано предыдущим звеном каскада), — для операции из аудита.
function operationBaseMs(db, row, name) {
  const order = () => db.prepare(
    'SELECT created_at, confirmed_at FROM orders WHERE id=?').get(row.entity_id);
  const trip = () => db.prepare(
    `SELECT created_at, logist_confirmed_at, entered_1c_at, driver_notified_at
     FROM trips WHERE id=?`).get(row.entity_id);
  try {
    if (name === 'Подтверждение заявки') return serverTimeMs(order()?.created_at);
    if (name === 'Назначение ТС') {
      const found = order();
      return serverTimeMs(found?.confirmed_at || found?.created_at);
    }
    if (name === 'Подтверждение назначения') return serverTimeMs(trip()?.created_at);
    if (name === 'Проведение заказа в 1С') return serverTimeMs(trip()?.logist_confirmed_at);
    if (name === 'Задание водителю') return serverTimeMs(trip()?.entered_1c_at);
    if (name === 'Вывод на контроль линии') return serverTimeMs(trip()?.driver_notified_at);
  } catch { return NaN; }
  return NaN;
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Каскад: очередь каждого звена в момент atIso (состояние восстанавливается
// по колонкам времени — отчёт честен и для прошлых смен).
export function cascadeQueues(db, atIso) {
  const at = atIso;
  const confirmQueue = db.prepare(`SELECT COUNT(*) c FROM orders
    WHERE deleted_at IS NULL AND created_at<=? AND (confirmed_at IS NULL OR confirmed_at>?)
      AND (status<>'cancelled' OR updated_at>?) AND trip_id IS NULL AND stage=0`).get(at, at, at).c;
  const assignQueue = db.prepare(`SELECT COUNT(*) c FROM orders
    WHERE deleted_at IS NULL AND status='new' AND stage=1 AND trip_id IS NULL
      AND confirmed_at<=?`).get(at).c;
  const dispatchQueue = db.prepare(`SELECT COUNT(*) c FROM trips
    WHERE status='plan' AND logist_confirmed_at<=? AND (on_line_at IS NULL OR on_line_at>?)`).get(at, at).c;
  const logistConfirmQueue = db.prepare(`SELECT COUNT(*) c FROM trips
    WHERE status='plan' AND created_at<=? AND (logist_confirmed_at IS NULL OR logist_confirmed_at>?)`).get(at, at).c;
  const payQueue = db.prepare(`SELECT COUNT(*) c FROM trips
    WHERE status IN ('unloaded','done') AND unloaded_at<=?`).get(at).c;
  return {
    sales: confirmQueue, logistConfirm: logistConfirmQueue,
    logist: assignQueue, dispatcher: dispatchQueue, accountant: payQueue
  };
}

// Строки аудита за интервал → операции конвейера с исполнителем,
// должностью и временем обработки (общий проход для смены и для базы
// «средний показатель системы»).
function collectOperations(db, fromIso, toIso) {
  const rows = db.prepare(`SELECT a.action, a.entity, a.entity_id, a.details_json,
      a.created_at, u.full_name, u.job_role, u.role
    FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.created_at>=? AND a.created_at<? AND a.user_id IS NOT NULL
    ORDER BY a.created_at`).all(
    fromIso.replace('T', ' ').slice(0, 19), toIso.replace('T', ' ').slice(0, 19));
  const list = [];
  let otherCount = 0;
  for (const row of rows) {
    const name = operationNameOf(row);
    if (!name) { otherCount += 1; continue; }
    const atMs = serverTimeMs(row.created_at);
    const baseMs = operationBaseMs(db, row, name);
    list.push({
      name,
      who: row.full_name || '—',
      jobRole: row.job_role || row.role || '—',
      atMs,
      waitMs: Number.isFinite(baseMs) && Number.isFinite(atMs) && atMs >= baseMs
        ? atMs - baseMs : null
    });
  }
  return { list, otherCount };
}

export function shiftReport(db, dayIso, kind = 'day') {
  const bounds = shiftBounds(dayIso, kind);
  const { list, otherCount } = collectOperations(db, bounds.fromIso, bounds.toIso);
  const staff = new Map();
  const operations = new Map();
  for (const op of list) {
    const { who, name, waitMs } = op;
    if (!staff.has(who)) staff.set(who, { name: who, jobRole: op.jobRole === '—' ? '' : op.jobRole, total: 0, ops: new Map(), waits: [] });
    const person = staff.get(who);
    person.total += 1;
    person.ops.set(name, (person.ops.get(name) || 0) + 1);
    if (waitMs !== null) person.waits.push(waitMs);
    if (!operations.has(name)) operations.set(name, { name, total: 0, waits: [], by: new Map() });
    const operation = operations.get(name);
    operation.total += 1;
    operation.by.set(who, (operation.by.get(who) || 0) + 1);
    if (waitMs !== null) operation.waits.push(waitMs);
  }
  const pack = list => [...list.values()].map(item => ({
    ...item,
    ops: item.ops ? [...item.ops.entries()].sort((a, b) => b[1] - a[1]) : undefined,
    by: item.by ? [...item.by.entries()].sort((a, b) => b[1] - a[1]) : undefined,
    medianWaitMs: median(item.waits), waits: undefined,
    withTime: item.waits.length
  }));
  // План-факт по людям: назначенные на смену по графику против фактически
  // работавших (по операциям). Не вышедшие и работавшие вне графика — отдельно.
  const planned = db.prepare(`SELECT s.user_id, u.full_name, u.job_role
    FROM staff_shifts s JOIN users u ON u.id=s.user_id
    WHERE s.day=? AND s.kind=? AND u.active=1 AND u.deleted_at IS NULL
    ORDER BY u.full_name`).all(dayIso, kind);
  const worked = new Set(staff.keys());
  const plannedNames = new Set(planned.map(person => person.full_name));

  // ── Эффективность в процентах против «среднего показателя системы» ──
  // База — операции той же ДОЛЖНОСТИ за 7 суток до конца смены (включая её):
  // средняя нагрузка на человеко-смену и медиана времени обработки.
  // Эффективность = 60% индекс нагрузки (операций к средней) +
  // 40% индекс скорости (средняя медиана к личной); компоненты ограничены
  // ×2,5, чтобы один выброс не рисовал «1000%».
  const baseFrom = new Date(Date.parse(bounds.toIso) - 7 * 86_400_000).toISOString();
  const base = collectOperations(db, baseFrom, bounds.toIso).list;
  const roleShiftLoad = new Map(); // должность → Map(сотрудник|смена → операций)
  const roleWaits = new Map();     // должность → все времена обработки
  for (const op of base) {
    const shiftKey = `${op.who}|${Math.floor(op.atMs / (12 * 3_600_000))}`;
    if (!roleShiftLoad.has(op.jobRole)) roleShiftLoad.set(op.jobRole, new Map());
    const loads = roleShiftLoad.get(op.jobRole);
    loads.set(shiftKey, (loads.get(shiftKey) || 0) + 1);
    if (op.waitMs !== null) {
      if (!roleWaits.has(op.jobRole)) roleWaits.set(op.jobRole, []);
      roleWaits.get(op.jobRole).push(op.waitMs);
    }
  }
  const roleBaseline = new Map();
  for (const [role, loads] of roleShiftLoad) {
    const perShift = [...loads.values()];
    roleBaseline.set(role, {
      avgLoad: perShift.reduce((sum, value) => sum + value, 0) / perShift.length,
      medianWait: median(roleWaits.get(role) || [])
    });
  }
  const clamp = value => Math.min(2.5, value);
  const packedStaff = pack(staff).sort((a, b) => b.total - a.total)
    .map(person => {
      const roleKey = person.jobRole || '—';
      const baseline = roleBaseline.get(roleKey);
      const loadIdx = baseline?.avgLoad ? clamp(person.total / baseline.avgLoad) : 1;
      const speedIdx = baseline?.medianWait && person.medianWaitMs
        ? clamp(baseline.medianWait / person.medianWaitMs) : 1;
      return {
        ...person, planned: plannedNames.has(person.name),
        efficiency: Math.round(100 * (0.6 * loadIdx + 0.4 * speedIdx)),
        loadIdx: Math.round(loadIdx * 100) / 100,
        speedIdx: Math.round(speedIdx * 100) / 100,
        baseLoad: baseline ? Math.round(baseline.avgLoad * 10) / 10 : null,
        baseWaitMs: baseline?.medianWait ?? null
      };
    });

  // Сигналы: неэффективные, перегруженные должности, узкое место процесса.
  const signals = [];
  for (const person of packedStaff) {
    if (person.total >= 3 && person.efficiency < 70) {
      signals.push({ kind: 'low', text: `${person.name} — ${person.efficiency}% ` +
        `(нагрузка ×${person.loadIdx} от средней по должности, скорость ×${person.speedIdx}): разобрать причины` });
    }
  }
  const byRole = new Map();
  for (const person of packedStaff) {
    const key = person.jobRole || '—';
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key).push(person);
  }

  // Сравнение должностей: те же объём и время — сколько людей и операций,
  // операций на человека, медиана обработки смены и отклонение должности
  // от СВОЕЙ базы за 7 дней (между собой должности сравниваются по
  // отклонению от нормы: операции у ролей разные по природе).
  const roleWaitsShift = new Map();
  for (const op of list) {
    if (op.waitMs === null) continue;
    if (!roleWaitsShift.has(op.jobRole)) roleWaitsShift.set(op.jobRole, []);
    roleWaitsShift.get(op.jobRole).push(op.waitMs);
  }
  const roles = [...byRole.entries()].map(([role, people]) => {
    const totalOps = people.reduce((sum, person) => sum + person.total, 0);
    const opsPerPerson = totalOps / people.length;
    const medianWaitMs = median(roleWaitsShift.get(role) || []);
    const baseline = roleBaseline.get(role);
    return {
      role, people: people.length, totalOps,
      opsPerPerson: Math.round(opsPerPerson * 10) / 10,
      medianWaitMs,
      baseLoad: baseline ? Math.round(baseline.avgLoad * 10) / 10 : null,
      baseWaitMs: baseline?.medianWait ?? null,
      // Шкала едина с личной эффективностью: индексы ограничены ×2,5.
      loadIdx: baseline?.avgLoad ? Math.round(clamp(opsPerPerson / baseline.avgLoad) * 100) / 100 : null,
      speedIdx: baseline?.medianWait && medianWaitMs
        ? Math.round(clamp(baseline.medianWait / medianWaitMs) * 100) / 100 : null
    };
  }).sort((a, b) => b.totalOps - a.totalOps);
  for (const [role, people] of byRole) {
    const baseline = roleBaseline.get(role);
    if (!baseline?.avgLoad) continue;
    const avgNow = people.reduce((sum, person) => sum + person.total, 0) / people.length;
    if (avgNow >= baseline.avgLoad * 1.5 && avgNow >= 10) {
      signals.push({ kind: 'overload', text: `Должность «${role}»: нагрузка ×${Math.round(avgNow / baseline.avgLoad * 10) / 10} ` +
        `от обычной (${Math.round(avgNow)} операций на человека при средней ${Math.round(baseline.avgLoad)}) — возможен перегруз, рассмотрите усиление` });
    }
  }
  // Узкое место процесса: операция с наибольшим суммарным временем ожидания.
  const slowest = pack(operations)
    .filter(operation => operation.medianWaitMs && operation.total >= 3)
    .sort((a, b) => b.medianWaitMs * b.total - a.medianWaitMs * a.total)[0];
  if (slowest && slowest.medianWaitMs > 3_600_000) {
    const hours = Math.round(slowest.medianWaitMs / 360_000) / 10;
    signals.push({ kind: 'process', text: `Узкое место процесса: «${slowest.name}» — задания ждут в среднем ${hours} ч ` +
      `(${slowest.total} за смену). Здесь процесс стоит упростить или добавить руки` });
  }

  return {
    ...bounds, day: dayIso, kind,
    staff: packedStaff,
    roles,
    operations: pack(operations).sort((a, b) => b.total - a.total),
    otherCount,
    signals,
    plan: {
      planned: planned.map(person => ({
        name: person.full_name, jobRole: person.job_role || '',
        worked: worked.has(person.full_name)
      })),
      noShow: planned.filter(person => !worked.has(person.full_name)).length,
      offPlan: packedStaff.filter(person => !person.planned).length
    },
    queuesStart: cascadeQueues(db, bounds.fromIso),
    queuesEnd: cascadeQueues(db, bounds.toIso)
  };
}
