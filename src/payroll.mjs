// ∑ ФОТ водителей — сдельная зарплата водителей-экспедиторов (блок «ФОТ»,
// процесс П5, этап «Расчёт ЗП по рейсу»; 07.11.2026). Положение об оплате
// «Рабочей среды СТ»: сдельно ₽/км, гарантия ₽ за сутки работы.
//
// Здесь нет своих расчётов явки и «кто за рулём» — только сборка готовых:
//   • дни работы — табель явки attendanceTimesheet (коды «Я» — работал и
//     «РВ» — работа в выходной; он же стоит на эффективной явке
//     attendanceEffective: ручная отметка → факт-слой графика → «в рейсе»);
//   • машина водителя на день — канон activeVehicleForDriver (периодное
//     закрепление driver_assignments → постоянное из справочника);
//   • сверхвахта к доплате — дни «РВ» того же табеля (как секция
//     «сверхвахта к доплате» отчёта сотрудников);
//   • рейсы водителя — driverPeriodMetrics (справочная колонка).
// Пробег = пробег машины в дни, когда водитель работал на ней: разность
// снимков одометра vehicle_odometers (00:00 МСК, канон «Пробегов») на
// краях каждого непрерывного отрезка; нет снимка/снимок не внушает веры —
// км рейсов этой машины в отрезке (доля по времени, как «по координатам»
// в «Пробегах»). Источник помечен по каждому отрезку и по строке.
//
// ФОРМУЛА (решение руководителя 07.11.2026):
//   за каждые сутки работы: max(км суток × ставка ₽/км, гарантия ₽/сутки);
//   сверхвахта (дни «РВ») — доплата ₽/сутки, входит в «к выплате»;
//   км — весь пробег (гружёный + порожний) по одной ставке, по положению.
//   к выплате = Σ по суткам + сверхвахта.
// Км суток — разность снимков одометра на 00:00 МСК этих суток; нет веры
// снимкам — доля км рейсов, пришедшаяся на сутки.

import { activeVehicleForDriver, attendanceTimesheet, driverPeriodMetrics } from './planner-service.mjs';
import { settingsObject } from './db.mjs';

const MSK = 3 * 3_600_000;
const DAY = 86_400_000;
const WORK_CODES = ['Я', 'РВ'];
// Коридор физики одометра за сутки — тот же, что в «Пробегах»
// (mileageData в server.mjs): разность сверх него — сбой датчика.
const ODO_MAX_PER_DAY = 2000;

const addDay = (day, n = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
// Пустота → дефолт; ноль в настройке — осознанное значение (принцип 2).
const numOr = (value, fallback) => value === '' || value == null || !Number.isFinite(Number(value))
  ? fallback : Number(value);

// Ставки из настроек калькуляции. Дефолты 12 ₽/км, 4 000 ₽/сутки и
// 2 000 ₽/сутки сверхвахты — по Положению среды СТ, правятся в Настройках.
export function payrollRates(settings = {}) {
  const calc = settings.calculation || {};
  return {
    ratePerKm: numOr(calc.driverRatePerKm, 12),
    guaranteePerDay: numOr(calc.driverGuaranteePerDay, 4000),
    overtimePerDay: numOr(calc.driverOvertimePerDay, 2000),
    rateSource: calc.driverRatePerKm == null || calc.driverRatePerKm === '' ? 'положение СТ (по умолчанию)' : 'настройки',
    guaranteeSource: calc.driverGuaranteePerDay == null || calc.driverGuaranteePerDay === '' ? 'положение СТ (по умолчанию)' : 'настройки'
  };
}

// Таблиц не требуется: ведомость считается на лету из канонов. Закрытие
// периода (фиксация ведомости) — следующий шаг, если руководитель решит.
export function migratePayroll() {}

// Км машины на отрезке [fromDay, toDayExcl) (сутки МСК): одометр → рейсы.
function segmentKm(db, stmts, vehicleId, fromDay, toDayExcl) {
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`) - MSK;
  const toMs = Date.parse(`${toDayExcl}T00:00:00Z`) - MSK;
  let tripsKm = 0;
  for (const trip of stmts.trips.all(vehicleId, new Date(toMs).toISOString(), new Date(fromMs).toISOString())) {
    const a = Date.parse(trip.starts_at);
    const b = Date.parse(trip.unloaded_at || trip.ends_at);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    const share = Math.max(0, Math.min(toMs, b) - Math.max(fromMs, a)) / (b - a);
    tripsKm += (Number(trip.distance_km || 0) + Number(trip.empty_km || 0)) * share;
  }
  const a = stmts.odo.get(vehicleId, fromDay)?.odo_km;
  const b = stmts.odo.get(vehicleId, toDayExcl)?.odo_km;
  const days = (toMs - fromMs) / DAY;
  if (Number.isFinite(a) && Number.isFinite(b)) {
    const delta = b - a;
    // Залипший одометр (правило «Пробегов»): рейсы насчитали заметный
    // пробег, а разность — меньше его десятой доли → веры нет.
    const stuck = tripsKm > 0 && delta < tripsKm * 0.1;
    if (delta >= 0 && delta <= days * ODO_MAX_PER_DAY && !stuck) {
      return { km: delta, source: 'одометр' };
    }
    return { km: tripsKm, source: 'рейсы', why: 'одометр вне коридора/залип' };
  }
  return { km: tripsKm, source: 'рейсы', why: 'нет снимков одометра' };
}

// Ведомость за период [from, to] включительно (дни ГГГГ-ММ-ДД).
export function payrollReport(db, { from, to, ratePerKm, guaranteePerDay, overtimePerDay = null } = {}) {
  if (!isDay(from) || !isDay(to) || to < from) {
    throw Object.assign(new Error('Период задан неверно'), { status: 422 });
  }
  const defaults = payrollRates(settingsObject(db));
  const rate = numOr(ratePerKm, defaults.ratePerKm);
  const guaranteeRate = numOr(guaranteePerDay, defaults.guaranteePerDay);
  const overtimeRate = numOr(overtimePerDay, defaults.overtimePerDay);
  const toExcl = addDay(to);
  // Табель сам ограничивает период 62 днями (422) — ведомость наследует.
  const sheet = attendanceTimesheet(db, from, toExcl);
  const stmts = {
    odo: db.prepare(`SELECT odo_km FROM vehicle_odometers WHERE vehicle_id=? AND day=?`),
    trips: db.prepare(`SELECT starts_at, unloaded_at, ends_at, distance_km, empty_km FROM trips
      WHERE vehicle_id=? AND status IN ('unloaded','done','paid','run')
        AND starts_at < ? AND COALESCE(unloaded_at, ends_at) > ?`)
  };
  let tripsByName = new Map();
  let unassignedTrips = 0;
  try {
    const metrics = driverPeriodMetrics(db, `${from}T00:00:00.000Z`, `${toExcl}T00:00:00.000Z`);
    for (const item of metrics.drivers) {
      if (item.name.startsWith('⚠')) unassignedTrips += item.trips;
      else tripsByName.set(item.name.trim(), item.trips);
    }
  } catch { tripsByName = new Map(); /* справочная колонка — без неё ведомость верна */ }

  const rows = [];
  for (const sheetRow of sheet.rows) {
    const workDays = sheet.days.filter(day => WORK_CODES.includes(sheetRow.days[day]));
    const overtimeDays = sheet.days.filter(day => sheetRow.days[day] === 'РВ').length;
    // Отрезки работы на одной машине → км отрезка (одометр на краях →
    // рейсы) → раскладка по суткам: сутки со своими снимками одометра —
    // как есть, остаток отрезка — по доле км рейсов суток (рейсов нет —
    // поровну). Затем по каждым суткам max(сдельно суток, гарантия).
    const segments = [];
    let noVehicleDays = 0;
    const dayKm = new Map();
    for (const day of workDays) {
      dayKm.set(day, 0);
      const vehicle = activeVehicleForDriver(db, sheetRow.driverId, day);
      if (!vehicle.vehicleId) { noVehicleDays += 1; continue; }
      const last = segments[segments.length - 1];
      if (last && last.vehicleId === vehicle.vehicleId && last.toExcl === day) { last.toExcl = addDay(day); last.days.push(day); }
      else segments.push({ vehicleId: vehicle.vehicleId, plate: vehicle.plate, from: day, toExcl: addDay(day), days: [day] });
    }
    const why = new Set();
    for (const segment of segments) {
      const total = segmentKm(db, stmts, segment.vehicleId, segment.from, segment.toExcl);
      if (total.why) why.add(total.why);
      const perDay = segment.days.map(day => ({ day, own: segmentKm(db, stmts, segment.vehicleId, day, addDay(day)) }));
      const known = perDay.filter(item => item.own.source === 'одометр');
      const knownKm = known.reduce((sum, item) => sum + item.own.km, 0);
      const rest = Math.max(0, total.km - knownKm);
      const unknown = perDay.filter(item => item.own.source !== 'одометр');
      const weight = unknown.reduce((sum, item) => sum + item.own.km, 0);
      for (const item of known) dayKm.set(item.day, item.own.km);
      for (const item of unknown) dayKm.set(item.day, weight > 0 ? rest * item.own.km / weight : rest / unknown.length);
      segment.km = Math.round(total.km);
      segment.source = total.source;
      segment.to = addDay(segment.toExcl, -1);
      delete segment.toExcl;
      delete segment.days;
    }
    let km = 0;
    let piece = 0;
    let payDays = 0;
    let guaranteeDays = 0;
    for (const day of workDays) {
      const dayPiece = dayKm.get(day) * rate;
      km += dayKm.get(day);
      piece += dayPiece;
      payDays += Math.max(dayPiece, guaranteeRate);
      if (guaranteeRate > dayPiece) guaranteeDays += 1;
    }
    const days = workDays.length;
    if (!days && !km) continue;
    const sources = new Set(segments.map(segment => segment.source));
    const kmSource = !sources.size ? '—' : sources.size > 1 ? 'смешанный' : [...sources][0];
    const overtimeAmount = Math.round(overtimeDays * overtimeRate);
    const notes = [];
    if (why.size) notes.push(`км по рейсам: ${[...why].join('; ')}`);
    if (noVehicleDays) notes.push(`дней без машины: ${noVehicleDays} (только гарантия)`);
    if (sheetRow.totals['·']) notes.push(`не отмечено в табеле: ${sheetRow.totals['·']} дн`);
    piece = Math.round(piece);
    const byDays = Math.round(payDays);
    rows.push({
      driverId: sheetRow.driverId, name: sheetRow.name, plate: sheetRow.plate || '',
      km: Math.round(km), kmSource, days, trips: tripsByName.get(String(sheetRow.name).trim()) ?? 0,
      piece, guarantee: Math.round(days * guaranteeRate), guaranteeDays,
      payable: byDays + overtimeAmount,
      basis: !guaranteeDays ? 'сдельно' : guaranteeDays === days ? 'гарантия' : `гарантия ${guaranteeDays} из ${days} сут`,
      topUp: byDays - piece,
      overtime: { days: overtimeDays, amount: overtimeAmount },
      segments, notes
    });
  }
  rows.sort((a, b) => b.payable - a.payable || a.name.localeCompare(b.name, 'ru'));
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  const totals = {
    drivers: rows.length, km: sum('km'), days: sum('days'),
    piece: sum('piece'), guarantee: sum('guarantee'), payable: sum('payable'), topUp: sum('topUp'),
    byGuarantee: rows.filter(row => row.guaranteeDays > 0).length,
    guaranteeDays: rows.reduce((total, row) => total + row.guaranteeDays, 0),
    overtimeDays: rows.reduce((total, row) => total + row.overtime.days, 0),
    overtimeAmount: rows.reduce((total, row) => total + row.overtime.amount, 0),
    kmSources: rows.reduce((acc, row) => ({ ...acc, [row.kmSource]: (acc[row.kmSource] || 0) + 1 }), {}),
    unassignedTrips
  };
  return {
    from, to, days: sheet.days.length,
    rates: { ratePerKm: rate, guaranteePerDay: guaranteeRate, overtimePerDay: overtimeRate,
      rateSource: defaults.rateSource, guaranteeSource: defaults.guaranteeSource },
    method: 'day',
    methodNote: 'Каждые сутки работы: больший из «км суток × ставка» и гарантии; плюс сверхвахта за сутки «РВ». Порожние км — по той же ставке',
    rows, totals,
    questions: []
  };
}

// Право на ведомость — коммерческая тайна: уровень денег «все»; без
// наборов ролей (прежняя модель) — право на отчёты руководителя.
// ОТКРЫТЫЙ ВОПРОС: руководитель эксплуатации (money 'none') ведомость не
// видит — решает руководитель направления.
export function canSeePayroll(ctx) {
  const { access, user, hasPermission } = ctx;
  if (!user) return false;
  if (access?.legacy) return Boolean(hasPermission?.(user, 'reports:read'));
  // Ведомость видят по экрану «ФОТ водителей» (руководитель направления
  // и руководитель эксплуатации — решение 07.11) или уровень денег «все».
  return access?.money === 'full' || Boolean(access?.views?.includes('payroll'));
}

// GET /api/payroll?from&to — true, если маршрут обработан.
export function payrollApi(ctx) {
  const { db, request, response, url, pathname, json, errorJson } = ctx;
  if (pathname !== '/api/payroll') return false;
  if (request.method !== 'GET') { errorJson(response, 405, 'Только чтение'); return true; }
  if (!ctx.user) { errorJson(response, 401, 'Нужен вход'); return true; }
  if (!canSeePayroll(ctx)) {
    errorJson(response, 403, 'Ведомость ФОТ — коммерческая тайна: доступна уровню денег «все»');
    return true;
  }
  const today = new Date(Date.now() + MSK).toISOString().slice(0, 10);
  const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
  const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : `${to.slice(0, 7)}-01`;
  const rates = payrollRates((ctx.settingsObject || settingsObject)(db));
  try {
    json(response, 200, payrollReport(db, { from, to, ...rates }));
  } catch (error) {
    errorJson(response, error.status || 500, error.message);
  }
  return true;
}
