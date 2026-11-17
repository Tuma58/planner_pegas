// «Ресурс за день» (ТЗ Базуева №791649e4, 16.11.2026): срез парка по
// состояниям за МСК-день — на линии, в ремонте, пересменка, без экипажа,
// резерв, простой. Только чтение существующих таблиц: рейсы, диспозиции
// (канон состояний Ресурса) и заказ-наряды Ремзоны как дополнение, когда
// диспозиция ремонта не оформлена. Никаких новых порогов и констант.
// Ниже — «Эксплуатация за период» (заказ руководителя 17.11): тот же
// канон по каждому дню периода + машино-дни план/факт, явка, текучесть,
// внештатки. Деньги (цена потерь) — живой норматив из факта периода.

import { attendanceSummary } from './planner-service.mjs';
import { driverTurnover } from './turnover.mjs';
import { incidentsSummary, lateCount } from './incidents.mjs';
import { DONE_STATUSES, calcSettings, doneDayOf, tripNet } from './money.mjs';

const MSK_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

// Приоритет категории, когда день машины сложный (утром пересменка, днём
// рейс): рейс главнее всего, дальше — по убыванию «занятости».
const ORDER = ['line', 'repair', 'shift', 'no_driver', 'reserve', 'out', 'idle'];
export const RESOURCE_DAY_TITLES = {
  line: 'На линии', repair: 'В ремонте', shift: 'Пересменка',
  no_driver: 'Без экипажа', reserve: 'Резерв', out: 'Выведена', idle: 'Простой без оформления'
};

export function resourceDayData(db, dayIso) {
  const dayStart = Date.parse(`${dayIso}T00:00:00Z`) - MSK_MS;
  const dayEnd = dayStart + DAY_MS;
  const startIso = new Date(dayStart).toISOString();
  const endIso = new Date(dayEnd).toISOString();

  const vehicles = db.prepare(`SELECT v.id, v.plate, v.trailer_plate, v.driver_name, v.status,
      vt.name type_name
    FROM vehicles v LEFT JOIN vehicle_types vt ON vt.id=v.type_id
    WHERE v.status IN ('work','out') ORDER BY v.plate`).all();
  const trips = db.prepare(`SELECT t.vehicle_id, t.status, t.starts_at, t.ends_at, t.unloaded_at,
      t.customer_name, f.name from_name, d.name to_name
    FROM trips t JOIN zones f ON f.id=t.from_zone_id JOIN zones d ON d.id=t.to_zone_id
    WHERE t.status<>'rejected' AND t.starts_at < ? AND COALESCE(t.unloaded_at, t.ends_at) > ?
    ORDER BY t.starts_at`).all(endIso, startIso);
  const dispositions = db.prepare(`SELECT vehicle_id, kind, starts_at, ends_at, note
    FROM vehicle_dispositions WHERE starts_at < ? AND ends_at > ?`).all(endIso, startIso);
  // Ремзона: заказ-наряд, открытый в этот день (фолбэк, когда диспозиция
  // ремонта не оформлена — машина физически в ремзоне по доске механика).
  // В ремзоне в этот день: заказ в работе/готов, либо выпущен уже после
  // начала дня (значит, день машина ещё стояла). Очередь не считается —
  // машина в неё может стоять, продолжая ездить.
  const repairs = db.prepare(`SELECT vehicle_id, purpose, status FROM repair_orders
    WHERE status IN ('in_progress','ready')
       OR (status='released' AND released_at IS NOT NULL AND released_at > ?)`).all(startIso);

  const tripsByVehicle = new Map();
  for (const trip of trips) {
    if (!tripsByVehicle.has(trip.vehicle_id)) tripsByVehicle.set(trip.vehicle_id, []);
    tripsByVehicle.get(trip.vehicle_id).push(trip);
  }
  const dispoByVehicle = new Map();
  for (const item of dispositions) {
    if (!dispoByVehicle.has(item.vehicle_id)) dispoByVehicle.set(item.vehicle_id, []);
    dispoByVehicle.get(item.vehicle_id).push(item);
  }
  const repairByVehicle = new Map(repairs.map(row => [row.vehicle_id, row]));

  const rows = vehicles.map(vehicle => {
    const vehTrips = tripsByVehicle.get(vehicle.id) || [];
    const vehDispo = dispoByVehicle.get(vehicle.id) || [];
    const kinds = new Set(vehDispo.map(item => item.kind));
    let category = 'idle';
    let detail = '';
    if (vehicle.status === 'out') { category = 'out'; detail = 'выведена из парка'; }
    if (category === 'idle' && repairByVehicle.has(vehicle.id) && !kinds.has('repair')) {
      const order = repairByVehicle.get(vehicle.id);
      category = 'repair';
      detail = `заказ-наряд Ремзоны: ${order.purpose || 'ремонт'}`;
    }
    for (const kind of ['reserve', 'no_driver', 'shift', 'repair']) {
      if (kinds.has(kind)) {
        category = kind === 'reserve' ? 'reserve' : kind;
        const item = vehDispo.find(entry => entry.kind === kind);
        detail = item?.note || RESOURCE_DAY_TITLES[category];
      }
    }
    if (kinds.has('out') && category === 'idle') { category = 'out'; detail = 'диспозиция «вне парка»'; }
    if (vehTrips.length) {
      category = 'line';
      detail = vehTrips.map(trip =>
        `${trip.customer_name || ''} · ${trip.from_name}→${trip.to_name} (${trip.status})`).join('; ');
    }
    return { plate: vehicle.plate, trailer: vehicle.trailer_plate || '',
      driver: vehicle.driver_name || '', type: vehicle.type_name || '', category, detail };
  });

  const counters = Object.fromEntries(ORDER.map(key => [key, 0]));
  for (const row of rows) counters[row.category] += 1;
  return { day: dayIso, fleet: vehicles.length,
    fleetWork: vehicles.filter(vehicle => vehicle.status === 'work').length,
    counters, order: ORDER, titles: RESOURCE_DAY_TITLES,
    rows: rows.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category)
      || a.plate.localeCompare(b.plate)) };
}

// «Эксплуатация за период» — отчёт руководителя отдела эксплуатации.
// Дни ресурса тем же каноном (без поимённых строк — счётчиками),
// план машино-дней = рабочий парк каждого дня, факт = на линии;
// цена потерь — из факта периода (нетто выгрузок / машино-день линии),
// а не зашитой ставкой. withMoney решает сервер по уровню денег.
export function opsPeriodData(db, from, to, { withMoney = false, nowMs = Date.now() } = {}) {
  const todayIso = new Date(nowMs + MSK_MS).toISOString().slice(0, 10);
  if (to > todayIso) to = todayIso; // будущие дни — не машино-дни
  const dayCount = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  if (!(dayCount >= 1)) return { error: 'Период пуст' };
  if (dayCount > 92) return { error: 'Период до 92 дней — возьмите квартал или меньше' };

  const days = [];
  const mdSum = Object.fromEntries(ORDER.map(key => [key, 0]));
  let mdPlan = 0;
  const attendance = [];
  let staffing = null;
  let staffingTarget = null;
  for (let i = 0; i < dayCount; i += 1) {
    const day = new Date(Date.parse(from) + i * DAY_MS).toISOString().slice(0, 10);
    const r = resourceDayData(db, day);
    days.push({ day, counters: r.counters, fleet: r.fleet, fleetWork: r.fleetWork });
    for (const key of ORDER) mdSum[key] += r.counters[key] || 0;
    mdPlan += r.fleetWork;
    try {
      const a = attendanceSummary(db, day);
      attendance.push({ day, present: a.present, absent: a.absent, unmarked: a.unmarked });
      staffing = a.staffing; staffingTarget = a.staffingTarget;
    } catch { attendance.push({ day, present: null, absent: null, unmarked: null }); }
  }
  const mdLost = mdPlan - mdSum.line;

  // Деньги: живой норматив периода — нетто выгрузок на машино-день линии.
  let money = null;
  if (withMoney && mdSum.line > 0) {
    const calc = calcSettings(db);
    const net = db.prepare(`SELECT t.revenue_vat, t.cash, t.customer_name, t.unloaded_at, t.ends_at, t.status
        FROM trips t WHERE t.status<>'rejected'`).all()
      .filter(trip => DONE_STATUSES.has(trip.status) || trip.unloaded_at)
      .filter(trip => { const day = doneDayOf(trip); return day >= from && day <= to; })
      .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
    const perLineDay = net / mdSum.line;
    money = { net: Math.round(net), perLineDay: Math.round(perLineDay),
      lost: Math.round(mdLost * perLineDay) };
  }

  const fromIso = new Date(Date.parse(`${from}T00:00:00Z`) - MSK_MS).toISOString();
  const toIso = new Date(Date.parse(`${to}T00:00:00Z`) - MSK_MS + DAY_MS).toISOString();
  const incidents = (() => {
    try {
      return { ...incidentsSummary(db, fromIso, toIso), autoLate: lateCount(db, fromIso, toIso) };
    } catch { return null; }
  })();
  const turnover = (() => {
    try {
      const t = driverTurnover(db);
      return { byMonth: (t.byMonth || []).filter(m => m.to >= from && m.from <= to),
        targetPct: t.targetPct,
        recentFired: (t.recentFired || []).filter(f => f.firedOn >= from && f.firedOn <= to)
          .map(f => ({ name: f.name, firedOn: f.firedOn, tenureDays: f.tenureDays, reason: f.reason })) };
    } catch { return null; }
  })();

  return { from, to, days, order: ORDER, titles: RESOURCE_DAY_TITLES,
    md: { plan: mdPlan, sum: mdSum, lost: mdLost },
    attendance, staffing, staffingTarget,
    incidents, turnover, money };
}
