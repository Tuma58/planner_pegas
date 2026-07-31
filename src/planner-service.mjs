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
    id,vehicle_id,customer_name,from_zone_id,to_zone_id,starts_at,ends_at,
    distance_km,revenue_vat,status,external_id,source_system,created_by,updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateTrip = db.prepare(`UPDATE trips SET vehicle_id=?,customer_name=?,from_zone_id=?,to_zone_id=?,
    starts_at=?,ends_at=?,distance_km=?,revenue_vat=?,status=?,source_system='1c',
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
        const values = [
          vehicle.id, String(row.client || ''), from.id, to.id, startsAt, endsAt,
          distance, Number(row.revenue || 0), TRIP_STATUS[row.status] || 'plan'
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
    const vat = /\bИП\b/iu.test(trip.customer_name)
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
  return {
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
