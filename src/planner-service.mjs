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
        const defaultDays = distance / Number(settings.dailyMileageKm || 600) + Number(settings.handlingDays || 0.5);
        const endsAt = row.doneDate
          ? isoDate(row.doneDate, 'doneDate')
          : new Date(Date.parse(startsAt) + defaultDays * 86_400_000).toISOString();
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
  for (const trip of trips) {
    // Наличная перевозка — ставка уже без НДС, не очищается.
    const vat = trip.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
      ? Number(calculation.individualEntrepreneurVatRate ?? 0.07)
      : Number(calculation.vatRate ?? 0.22);
    const net = Number(trip.revenue_vat) / (1 + vat);
    const tripDays = Math.max(0, (Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 86_400_000);
    const variable = Number(trip.distance_km) *
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

  return {
    utilization,
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
  const revenueRows = db.prepare(`SELECT vehicle_id,customer_name,revenue_vat,cash FROM trips
    WHERE status<>'rejected' AND ends_at>=? AND ends_at<?`).all(from, to);
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
    return {
      vehicleId: vehicle.id, plate: vehicle.plate,
      driver: vehicle.driver_name || '', type: vehicle.type_name,
      ...counts,
      trips: (byVehicleRevenue.get(vehicle.id) || []).length,
      ktg: (dayCount - counts.repair - counts.out) / dayCount,
      utilization: counts.work / dayCount,
      netRevenue: Math.round(netRevenue)
    };
  });
  return { from, to, days: dayCount, items };
}
