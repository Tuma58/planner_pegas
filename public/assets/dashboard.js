// Общий дашборд предприятия: план-факт по ролям на текущий день и прогноз
// месяца. Считается целиком из bootstrap (доступен каждой роли) — вкладку
// видят все сотрудники, цель — общая видимость достижения плана.
// Автообновление раз в 90 секунд, пока вкладка открыта.
import { api, escapeHtml, money, toast, tripBusyUntilMs, captureScrolls, restoreScrolls, tripBusyFromMs, renderInto } from './api.js';
import { vehicleZoneAt } from './transfer.js';
import { orderStage } from './pipeline.js';
import { orderNet } from './sales.js';
import { loadOpenQuestions } from './call-card.js';
import { boardDialog, boardNotesHtml, wireBoardNotes } from './board.js';

const DAY_MS = 86_400_000;
const DEFAULT_MONTH_PLAN = 160_000_000;

// SQLite CURRENT_TIMESTAMP пишет «YYYY-MM-DD HH:MM:SS» в UTC — приводим к ISO.
const tsMs = value => value ? Date.parse(String(value).replace(' ', 'T') +
  (String(value).includes('Z') || String(value).includes('+') ? '' : 'Z')) : NaN;

const tripNet = (trip, calc) => trip.revenue_vat / (1 + (trip.cash ? 0
  : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name || '')
    ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22)));

// Все план-фактные показатели дашборда одним расчётом (тестируемо отдельно).
export function dashboardMetrics(data, nowMs = Date.now()) {
  const calc = data.settings.calculation;
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayEnd = dayStart + DAY_MS;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysInMonth = Math.round((monthEnd - monthStart) / DAY_MS);
  const dayOfMonth = now.getUTCDate();
  const remainingDays = daysInMonth - dayOfMonth + 1;

  const activeTrips = (data.trips || []).filter(trip => trip.status !== 'rejected');
  const inMonth = trip => {
    const ends = Date.parse(trip.ends_at);
    return ends >= monthStart && ends < monthEnd;
  };
  const monthTrips = activeTrips.filter(inMonth);
  const monthFact = monthTrips.reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  const dayTrips = monthTrips.filter(trip => {
    const ends = Date.parse(trip.ends_at);
    return ends >= dayStart && ends < dayEnd;
  });
  const dayFact = dayTrips.reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  // Факт действительно прошедших дней: только выгрузки до начала сегодняшних
  // суток. Забронированное будущее (и незакрытый сегодняшний день) сюда не
  // входит — иначе темп и план дня искажаются ещё не привезённой выручкой.
  const factPast = monthTrips.filter(trip => Date.parse(trip.ends_at) < dayStart)
    .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  // «Забито на сегодня» = все расчётные выгрузки дня; из них выгружено
  // фактически (статус после выгрузки) и ещё едет/ждёт выхода.
  const doneStatuses = new Set(['unloaded', 'done', 'paid']);
  const dayDone = dayTrips.filter(trip => doneStatuses.has(trip.status))
    .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  // «Выгружено за месяц» — только фактически выгруженные рейсы месяца
  // (статус после выгрузки); главная цифра плашки — «забито» (monthFact:
  // факт + ещё не привезённая выручка броней до конца месяца).
  const monthDone = monthTrips.filter(trip => doneStatuses.has(trip.status))
    .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  const dayExpected = dayFact - dayDone;
  // Динамика внутри дня: что по расчётному времени выгрузки уже ДОЛЖНО быть
  // выгружено к текущему моменту — против фактически выгруженного. Даёт
  // опережение/отставание в любой час смены, а не только по итогу дня.
  const dueByNow = dayTrips.filter(trip => Date.parse(trip.ends_at) <= nowMs)
    .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  // Погрузки сегодняшнего дня — опережающий индикатор: смена влияет на него
  // прямо сейчас, а деньгами он станет при выгрузке через ~1–2 дня.
  const dayLoads = activeTrips.filter(trip => {
    const starts = Date.parse(trip.starts_at);
    return starts >= dayStart && starts < dayEnd;
  });
  const dayLoadsSum = dayLoads.reduce((sum, trip) => sum + tripNet(trip, calc), 0);

  const periodKey = new Date(monthStart).toISOString().slice(0, 10);
  const monthPlan = Number((data.revenuePlans || [])
    .find(item => item.period_start === periodKey)?.target_net || 0) || DEFAULT_MONTH_PLAN;
  // Дневной план — остаток плана на остаток дней (включая сегодня); остаток
  // считается от факта прошедших дней — как в ленте «Вчера/Сегодня/Завтра».
  const dayPlan = Math.max(0, (monthPlan - factPast) / Math.max(1, remainingDays));
  // Прогноз месяца — темп по фактическим выгрузкам прошедших полных дней.
  // 1-го числа темпа ещё нет — прогнозом служит забитое на месяц.
  const forecast = dayOfMonth > 1
    ? factPast / (dayOfMonth - 1) * daysInMonth : monthFact;
  // Урок августа: прогноз «129» опирался на забитое, из которого 116 рейсов
  // отклонили, а 100 выгрузились уже в сентябре — итог 110. Раскладываем
  // честно: выгружено + доедет (за вычетом риска отклонений по доле
  // последних 14 дней) + переходящие в следующий месяц (выручка не месяца).
  const monthBooked = monthFact - monthDone; // назначено, ещё не выгружено
  const rej14 = (data.trips || []).filter(trip => trip.status === 'rejected' &&
    tsMs(trip.updated_at) >= nowMs - 14 * 86_400_000)
    .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  const base14 = factPast > 0 ? factPast / Math.max(1, dayOfMonth - 1) * 14 : 0;
  const rejShare = base14 > 0 ? Math.min(0.35, rej14 / (base14 + rej14)) : 0.1;
  const carryOver = activeTrips.filter(trip => {
    const starts = Date.parse(trip.starts_at);
    return starts >= monthStart && starts < monthEnd && Date.parse(trip.ends_at) >= monthEnd;
  }).reduce((sum, trip) => sum + tripNet(trip, calc), 0);
  const forecastHonest = monthDone + monthBooked * (1 - rejShare);

  // Продажи: внесено за день, суммы и средний чек, назначено из внесённого пула.
  const orders = (data.orders || []).filter(order => order.status !== 'cancelled');
  const createdToday = orders.filter(order => {
    const created = tsMs(order.created_at);
    return created >= dayStart && created < dayEnd;
  });
  const createdSum = createdToday.reduce((sum, order) => sum + orderNet(order, data), 0);
  const avgCheck = createdToday.length ? createdSum / createdToday.length : 0;

  // Логист: назначено рейсов за день (создание рейса в планере), очередь без ТС.
  const assignedToday = activeTrips.filter(trip => trip.order_id &&
    trip.source_system !== '1c' && (() => {
      const created = tsMs(trip.created_at);
      return created >= dayStart && created < dayEnd;
    })()).length;
  const queue = orders.filter(order => orderStage(order, data).stage === 1).length;

  // Диспетчер: выведено на линию и выгружено за день, на линии сейчас.
  const onLineToday = activeTrips.filter(trip => {
    const at = tsMs(trip.on_line_at);
    return at >= dayStart && at < dayEnd;
  }).length;
  const unloadedToday = activeTrips.filter(trip => {
    const at = tsMs(trip.unloaded_at);
    return at >= dayStart && at < dayEnd;
  }).length;
  const startingToday = activeTrips.filter(trip => trip.status === 'plan' && (() => {
    const starts = Date.parse(trip.starts_at);
    return starts >= dayStart && starts < dayEnd;
  })()).length;
  // «На линии сейчас» — МАШИНЫ (у сцепки бывает два рейса в пути: следующий
  // выведен заранее), рейсы — отдельной цифрой.
  const onlineTrips = activeTrips.filter(trip => trip.status === 'run');
  const online = new Set(onlineTrips.map(trip => trip.vehicle_id)).size;
  const onlineTripCount = onlineTrips.length;

  // Правило «минимум два назначенных рейса»: у каждой машины на линии (в пути)
  // должен быть назначен СЛЕДУЮЩИЙ рейс (план после текущего). Машины без
  // следующего — задача логисту назначить / продажам найти груз до освобождения.
  const tripsByVehicle = new Map();
  for (const trip of activeTrips) {
    if (!tripsByVehicle.has(trip.vehicle_id)) tripsByVehicle.set(trip.vehicle_id, []);
    tripsByVehicle.get(trip.vehicle_id).push(trip);
  }
  const noNextList = [];
  for (const vehicleId of new Set(onlineTrips.map(trip => trip.vehicle_id))) {
    const list = tripsByVehicle.get(vehicleId) || [];
    const current = list.filter(trip => trip.status === 'run')
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0];
    const hasNext = list.some(trip => trip.status === 'plan' &&
      Date.parse(trip.starts_at) >= Date.parse(current.starts_at));
    if (!hasNext) noNextList.push({ vehicle_id: vehicleId, current });
  }

  // Ресурс/парк: занятость сегодня.
  const fleet = (data.vehicles || []).filter(vehicle => vehicle.status === 'work');
  // Рейс без факта выгрузки занимает машину и после расчётного конца.
  // Долги перед 1С: заказ уехал без внесения или требует обновления после замены ТС.
  const debt1c = activeTrips.filter(trip =>
    (trip.deferred_1c_at && !trip.entered_1c_at) || trip.needs_1c_update_at);

  const inTripIds = new Set(activeTrips.filter(trip =>
    tripBusyFromMs(trip) < dayEnd && tripBusyUntilMs(trip, nowMs) > dayStart)
    .map(trip => trip.vehicle_id));
  // «Простой без причины» — только машины БЕЗ назначения: машина с
  // назначенным будущим рейсом (сегодня-послезавтра) едет к погрузке или
  // ждёт её — это «⏭ ждёт следующей погрузки», а не простой (кейс т947ук58:
  // выгрузилась в Новосибирске, погрузка через день из Омской области).
  const pendingIds = new Set(activeTrips.filter(trip =>
    ['plan', 'run'].includes(trip.status) &&
    Date.parse(trip.starts_at) >= dayEnd && Date.parse(trip.starts_at) < dayEnd + 2 * DAY_MS)
    .map(trip => trip.vehicle_id));
  let unavailable = 0;
  let idle = 0;
  let pending = 0;
  for (const vehicle of fleet) {
    if (inTripIds.has(vehicle.id)) continue;
    const covered = (data.dispositions || []).some(item => item.vehicle_id === vehicle.id &&
      Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart);
    if (covered) unavailable += 1;
    else if (pendingIds.has(vehicle.id)) pending += 1;
    else idle += 1;
  }

  const dayGap = Math.max(0, dayPlan - dayFact);

  // Лента «вчера / сегодня / завтра»: план каждого дня — остаток месячного
  // плана на его дату (для завтра — с учётом забитого на сегодня), «забито» —
  // расчётные выгрузки дня, раскладка выгружено/едет, остаток до плана.
  const dayMetricsAt = offsetDays => {
    const start = dayStart + offsetDays * DAY_MS;
    const end = start + DAY_MS;
    const date = new Date(start);
    const inMonth = start >= monthStart && start < monthEnd;
    const trips = activeTrips.filter(trip => {
      const ends = Date.parse(trip.ends_at);
      return ends >= start && ends < end;
    });
    const booked = trips.reduce((sum, trip) => sum + tripNet(trip, calc), 0);
    const done = trips.filter(trip => doneStatuses.has(trip.status))
      .reduce((sum, trip) => sum + tripNet(trip, calc), 0);
    const factBefore = activeTrips.filter(trip => {
      const ends = Date.parse(trip.ends_at);
      return ends >= monthStart && ends < start;
    }).reduce((sum, trip) => sum + tripNet(trip, calc), 0);
    const remaining = daysInMonth - date.getUTCDate() + 1;
    const plan = inMonth ? Math.max(0, (monthPlan - factBefore) / Math.max(1, remaining)) : null;
    return { dateIso: date.toISOString().slice(0, 10), inMonth, plan,
      booked, done, expected: booked - done, trips: trips.length,
      gap: plan != null ? Math.max(0, plan - booked) : 0 };
  };
  const days = { yesterday: dayMetricsAt(-1), today: dayMetricsAt(0), tomorrow: dayMetricsAt(1) };

  return { monthPlan, monthFact, monthDone, monthBooked, rejShare, carryOver, forecastHonest,
    dayPlan, dayFact, dayDone, dayExpected, dayGap, days,
    dayPace: { due: dueByNow, done: dayDone, diff: dayDone - dueByNow },
    dayLoads: { count: dayLoads.length, sum: dayLoadsSum,
      online: dayLoads.filter(trip => trip.on_line_at).length },
    monthPace: { schedule: monthPlan * dayOfMonth / daysInMonth, fact: factPast + dayDone,
      diff: factPast + dayDone - monthPlan * dayOfMonth / daysInMonth },
    forecast, daysInMonth, dayOfMonth,
    remainingDays, dayTripsCount: dayTrips.length,
    avgDayCheck: dayTrips.length ? dayFact / dayTrips.length : 0,
    sales: { createdToday: createdToday.length, createdSum, avgCheck, queue },
    logist: { assignedToday, queue, noNext: noNextList.length },
    dispatcher: { onLineToday, startingToday, unloadedToday, online, onlineTripCount, debt1c: debt1c.length },
    fleet: { total: fleet.length, inTrip: inTripIds.size, unavailable, idle, pending },
    // Списки для раскрытия плашек по клику.
    details: {
      salesCreated: createdToday,
      salesQueue: orders.filter(order => orderStage(order, data).stage === 1),
      logistAssigned: activeTrips.filter(trip => trip.order_id && trip.source_system !== '1c' &&
        tsMs(trip.created_at) >= dayStart && tsMs(trip.created_at) < dayEnd),
      logistNoNext: noNextList,
      dispOnLine: activeTrips.filter(trip => tsMs(trip.on_line_at) >= dayStart && tsMs(trip.on_line_at) < dayEnd),
      dispStarting: activeTrips.filter(trip => trip.status === 'plan' &&
        Date.parse(trip.starts_at) >= dayStart && Date.parse(trip.starts_at) < dayEnd),
      dispUnloaded: activeTrips.filter(trip => tsMs(trip.unloaded_at) >= dayStart && tsMs(trip.unloaded_at) < dayEnd),
      dispOnline: onlineTrips,
      dispDebt1c: debt1c,
      fleetInTrip: fleet.filter(vehicle => inTripIds.has(vehicle.id)),
      fleetIdle: fleet.filter(vehicle => !inTripIds.has(vehicle.id) && !pendingIds.has(vehicle.id) &&
        !(data.dispositions || []).some(item =>
        item.vehicle_id === vehicle.id && Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart)),
      fleetPending: fleet.filter(vehicle => !inTripIds.has(vehicle.id) && pendingIds.has(vehicle.id) &&
        !(data.dispositions || []).some(item =>
        item.vehicle_id === vehicle.id && Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart)),
      fleetUnavailable: fleet.filter(vehicle => !inTripIds.has(vehicle.id) && (data.dispositions || []).some(item =>
        item.vehicle_id === vehicle.id && Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart))
    } };
}

// Столбики выручки по дням месяца: прошлые и сегодня — насыщенные,
// будущие (забронированные выгрузки) — полупрозрачные; пунктир — средний
// дневной темп для цели месяца.
function monthSpark(data, metrics, nowMs) {
  const calc = data.settings.calculation;
  const now = new Date(nowMs);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const daily = Array(metrics.daysInMonth).fill(0);
  (data.trips || []).filter(trip => trip.status !== 'rejected').forEach(trip => {
    const idx = Math.floor((Date.parse(trip.ends_at) - monthStart) / DAY_MS);
    if (idx >= 0 && idx < metrics.daysInMonth) daily[idx] += tripNet(trip, calc);
  });
  const avgTarget = metrics.monthPlan / metrics.daysInMonth;
  const maxValue = Math.max(avgTarget, ...daily) * 1.05;
  const W = 620, H = 74, gap = 2;
  const barW = (W - gap * metrics.daysInMonth) / metrics.daysInMonth;
  const bars = daily.map((value, idx) => {
    const h = Math.max(1.5, value / maxValue * (H - 16));
    const x = idx * (barW + gap);
    const today = idx + 1 === metrics.dayOfMonth;
    const future = idx + 1 > metrics.dayOfMonth;
    return `<rect x="${x.toFixed(1)}" y="${(H - 14 - h).toFixed(1)}" width="${barW.toFixed(1)}"
      height="${h.toFixed(1)}" rx="1.5" class="spark-bar ${today ? 'today' : future ? 'future' : ''}">
      <title>${idx + 1} число · ${money(Math.round(value))}${future ? ' (забронировано)' : ''}</title></rect>
      ${(idx + 1) % 5 === 0 || today ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 3}"
        class="spark-tick ${today ? 'today' : ''}">${idx + 1}</text>` : ''}`;
  }).join('');
  // Кумулятив к цели (своя шкала — до плана месяца): сплошная линия — факт
  // нарастающим итогом, пунктирное продолжение — с учётом забронированного
  // будущего; прямая — равномерный график к цели. Зазор между линиями и есть
  // отставание/опережение месяца, видимое с любого расстояния.
  const lineScale = Math.max(metrics.monthPlan, daily.reduce((a, b) => a + b, 0)) * 1.05;
  const yOf = value => H - 14 - value / lineScale * (H - 16);
  const xOf = idx => idx * (barW + gap) + barW / 2;
  let cum = 0;
  const points = daily.map((value, idx) => { cum += value; return { idx, cum }; });
  const factPts = points.filter(pt => pt.idx + 1 <= metrics.dayOfMonth);
  const futurePts = points.filter(pt => pt.idx + 1 >= metrics.dayOfMonth);
  const toPoly = pts => pts.map(pt => `${xOf(pt.idx).toFixed(1)},${yOf(pt.cum).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" class="dash-spark" preserveAspectRatio="none">
    <line x1="${xOf(0).toFixed(1)}" y1="${yOf(metrics.monthPlan / metrics.daysInMonth).toFixed(1)}"
      x2="${xOf(metrics.daysInMonth - 1).toFixed(1)}" y2="${yOf(metrics.monthPlan).toFixed(1)}" class="spark-goal"/>
    ${bars}
    <polyline class="spark-cum future" points="${toPoly(futurePts)}"/>
    <polyline class="spark-cum" points="${toPoly(factPts)}"/></svg>`;
}

const pctOf = (value, base) => base ? Math.round(value / base * 100) : 0;
const shortMln = value => `${(Number(value || 0) / 1e6).toLocaleString('ru-RU',
  { maximumFractionDigits: 1 })} млн`;

const DETAIL_TITLES = {
  salesCreated: 'Внесено заявок сегодня', salesQueue: 'Очередь на назначение (без ТС)',
  logistAssigned: 'Назначено рейсов сегодня', logistNoNext: 'На линии без следующего рейса',
  dispOnLine: 'Выведено на линию сегодня', dispStarting: 'Ждут выхода сегодня',
  dispUnloaded: 'Выгружено сегодня', dispOnline: 'Рейсы на контроле', dispDebt1c: 'Долги перед 1С',
  fleetInTrip: 'Парк в рейсе сегодня', fleetIdle: 'Простой без причины',
  fleetPending: 'Ждут следующей погрузки (рейс назначен)', fleetUnavailable: 'Недоступны (оформлено)'
};
const fmtDt = value => value ? new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`)
  .toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
const placeShort = value => String(value || '').split(',')[0].trim().slice(0, 28);

// Детализация плашки дашборда: список строк того типа, что стоит за цифрой.
function dashDetailDialog(key, metrics, data, context) {
  if (typeof context.showModal !== 'function') return;
  const items = metrics.details?.[key] || [];
  const vehicleById = id => (data.vehicles || []).find(item => item.id === id);
  let rows = '';
  if (key === 'salesCreated' || key === 'salesQueue') {
    rows = items.map(order => `<div class="dash-detail-row"><b>${order.order_no ? `№ ${escapeHtml(order.order_no)}` : '—'}</b>
      · ${escapeHtml(order.customer_name)} · ${escapeHtml(placeShort(order.from_point || order.from_name))} → ${escapeHtml(placeShort(order.to_point || order.to_name))}
      <small class="muted" style="display:block">окно ${fmtDt(order.window_from)} → ${fmtDt(order.window_to)} · ${money(order.rate_vat)}</small></div>`).join('');
  } else if (key === 'logistNoNext') {
    rows = items.map(({ vehicle_id, current }) => {
      const vehicle = vehicleById(vehicle_id);
      return `<div class="dash-detail-row"><b class="mono">${escapeHtml(vehicle?.plate || '')}</b>
        · сейчас: ${escapeHtml(placeShort(current.from_point || current.from_name))} → ${escapeHtml(placeShort(current.to_point || current.to_name))}
        <small class="muted" style="display:block">план выгрузки ${fmtDt(current.ends_at)} · ${escapeHtml(current.customer_name || '')}
          · <b class="danger">следующий рейс не назначен</b></small></div>`;
    }).join('');
  } else if (key.startsWith('disp') || key === 'logistAssigned') {
    rows = items.map(trip => `<div class="dash-detail-row"><b class="mono">${escapeHtml(trip.vehicle_plate || '')}</b>
      · ${escapeHtml(placeShort(trip.from_point || trip.from_name))} → ${escapeHtml(placeShort(trip.to_point || trip.to_name))} · ${escapeHtml(trip.customer_name || '')}
      <small class="muted" style="display:block">выход ${fmtDt(trip.starts_at)} · выгрузка ${fmtDt(trip.ends_at)}${trip.on_line_at ? ` · на линии с ${fmtDt(trip.on_line_at)}` : ''}${trip.unloaded_at ? ` · выгружен ${fmtDt(trip.unloaded_at)}` : ''} · ${money(trip.revenue_vat)}</small></div>`).join('');
  } else {
    // Зона машины — расчётная (по последнему рейсу/перегону, как в Ганте),
    // а не справочная из карточки: справочная почти всегда «Дом» и врёт.
    rows = items.map(vehicle => {
      const zone = vehicleZoneAt(data, vehicle.id) || vehicle.zone_name || '';
      const myTrips = (data.trips || []).filter(trip => trip.vehicle_id === vehicle.id &&
        trip.status !== 'rejected');
      const last = myTrips.filter(trip => trip.unloaded_at || Date.parse(trip.ends_at) < Date.now())
        .sort((a, b) => String(b.ends_at).localeCompare(String(a.ends_at)))[0];
      const next = myTrips.filter(trip => trip.status === 'plan')
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0];
      const context2 = key === 'fleetIdle' || key === 'fleetPending'
        ? `${last ? ` · выгрузка ${fmtDt(last.unloaded_at || last.ends_at)} (${escapeHtml(placeShort(last.to_point || last.to_name))})` : ''}${
          next ? ` · <b>следующая погрузка ${fmtDt(next.starts_at)}</b> (${escapeHtml(placeShort(next.from_point || next.from_name))})` : ''}`
        : '';
      return `<div class="dash-detail-row"><b class="mono">${escapeHtml(vehicle.plate)}</b>
      · ${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name || '')}
      <small class="muted" style="display:block">сейчас: ${escapeHtml(zone)}${context2}</small></div>`;
    }).join('');
  }
  context.showModal(`<h2>${DETAIL_TITLES[key] || key} <span class="badge">${items.length}</span></h2>
    ${key === 'logistNoNext' ? '<p class="muted">Правило: у машины на линии должен быть назначен следующий рейс — логист назначает из очереди, продажи ищут груз под освобождение.</p>' : ''}
    <div class="dash-detail-list">${rows || '<p class="muted">Пусто.</p>'}</div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');
}

// «Обычно к этому часу» — средний кумулятивный счёт события к текущему
// времени суток за четыре последних ТАКИХ ЖЕ дня недели (нагрузка по
// неделе неравномерна: понедельник сравнивается с понедельниками), плюс
// +5% на прогрессию — норма всегда чуть выше вчерашней, команда растёт.
export function usualByNow(rows, pickTs, nowMs = Date.now()) {
  const msk = 3 * 3_600_000;
  const dayStartMsk = ms => Math.floor((ms + msk) / 86_400_000) * 86_400_000 - msk;
  const today0 = dayStartMsk(nowMs);
  const timeOfDay = nowMs - today0;
  let total = 0;
  let daysCounted = 0;
  for (let week = 1; week <= 4; week += 1) {
    const start = today0 - week * 7 * 86_400_000;
    let dayTotal = 0;
    for (const row of rows) {
      const ts = pickTs(row);
      if (ts >= start && ts < start + timeOfDay) dayTotal += 1;
    }
    // День без единого события за весь такой день недели считаем «не рабочим»
    // для события (данные могли ещё не вестись) — в среднее не включаем.
    const wholeDay = rows.some(row => {
      const ts = pickTs(row);
      return ts >= start && ts < start + 86_400_000;
    });
    if (wholeDay) { total += dayTotal; daysCounted += 1; }
  }
  if (!daysCounted) return 0;
  return (total / daysCounted) * 1.05;
}

// Светофор «факт против обычного»: ✅ не хуже, ⚠ просели, ❌ сильно ниже.
function normBadge(fact, usual) {
  if (usual < 0.5) return '';
  const ratio = fact / usual;
  const icon = ratio >= 0.95 ? '✅' : ratio >= 0.6 ? '⚠' : '❌';
  return ` <small class="muted" title="Среднее к этому часу по четырём последним таким же дням недели, +5% на рост">· обычно ~${Math.round(usual)} ${icon}</small>`;
}

export async function renderDashboard(container, context) {
  const { state } = context;
  const metrics = dashboardMetrics(state.data);
  const donePct = Math.min(100, pctOf(metrics.monthFact, metrics.monthPlan));
  const forecastPct = pctOf(metrics.forecast, metrics.monthPlan);
  const dayPct = pctOf(metrics.dayFact, metrics.dayPlan);
  const monthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' })
    .format(new Date());
  const gauge = (share, cls) => `<div class="dash-gauge"><i class="${cls}"
    style="width:${Math.min(100, share)}%"></i></div>`;
  const roleCard = (title, rows) => `<div class="dash-role">
    <div class="dash-role-title">${title}</div>
    ${rows.map(row => `<div class="dash-row ${row.cls || ''} ${row.detail ? 'clickable' : ''}"
        ${row.detail ? `data-dash-detail="${row.detail}" title="Раскрыть список"` : ''}>
      <span>${row.label}</span><b>${row.value}${row.detail ? ' <small class="dash-more">›</small>' : ''}</b></div>`).join('')}
  </div>`;

  const fmtDayShort = iso => new Intl.DateTimeFormat('ru-RU',
    { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  const dayCard = (day, title, mode) => {
    const pct = day.plan ? Math.min(999, Math.round(day.booked / day.plan * 100)) : 0;
    const met = day.plan != null && day.booked >= day.plan;
    let verdict = '';
    if (day.plan == null) {
      verdict = '<span class="muted">план соседнего месяца — не считается</span>';
    } else if (mode === 'past') {
      verdict = met
        ? `✅ выполнен ${day.plan ? `+${money(Math.round(day.booked - day.plan))}` : ''}`
        : `✗ недобор ${money(Math.round(day.plan - day.booked))} — перетёк в план сегодня`;
    } else if (day.gap > 0) {
      verdict = `⛔ добрать: <b>${money(Math.round(day.gap))}</b>`;
    } else {
      verdict = `✅ забит${day.booked - day.plan > 0 ? ` с запасом +${money(Math.round(day.booked - day.plan))}` : ''}`;
    }
    return `<div class="dash-day ${mode === 'today' ? 'today' : ''} ${day.plan != null && (mode === 'past' ? !met : day.gap > 0) ? 'lack' : 'met'}">
      <div class="dd-head"><b>${title}</b><span class="muted">${fmtDayShort(day.dateIso)}</span></div>
      <div class="dd-plan"><span>план</span><b>${day.plan != null ? money(Math.round(day.plan)) : '—'}</b></div>
      <div class="dd-fact"><span>${mode === 'past' ? 'факт' : 'забито'}</span>
        <b>${money(Math.round(day.booked))}</b>
        ${day.plan ? `<em>${pct}%</em>` : ''}</div>
      ${(() => {
        const base = day.plan || day.booked || 1;
        const donePart = Math.min(100, day.done / base * 100);
        const restPart = Math.max(0, Math.min(100 - donePart, day.expected / base * 100));
        return `<div class="dash-gauge split"><i class="ok" style="width:${donePart.toFixed(1)}%"></i><i
          class="${mode === 'past' ? 'lag' : 'ride'}" style="width:${restPart.toFixed(1)}%"></i></div>`;
      })()}
      <div class="dd-split">${mode === 'past'
        ? `выгружено ${money(Math.round(day.done))}${day.expected > 0.5
            ? ` · <span class="danger">не выгружено ${money(Math.round(day.expected))}</span>` : ''}`
        : `выгружено ${money(Math.round(day.done))} · едет ${money(Math.round(day.expected))} · ${day.trips} рейс.`}</div>
      ${mode === 'today' ? `<div class="dd-loads">🚚 Вбито погрузок сегодня: <b>${metrics.dayLoads.count}</b>
        на <b>${money(Math.round(metrics.dayLoads.sum))}</b> · на линии ${metrics.dayLoads.online}
        — станут выгрузками завтра-послезавтра</div>` : ''}
      ${mode === 'today' ? (() => {
        const pace = metrics.dayPace;
        const clock = new Date().toLocaleTimeString('ru-RU',
          { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
        if (pace.due < 1) return '<div class="dd-pace muted">⏱ выгрузок по графику пока не ожидалось</div>';
        // Общий обратный отсчёт: сколько осталось до цели дня и когда закроем
        // при текущем темпе (темп — от начала рабочего дня 08:00 МСК).
        const left = Math.max(0, metrics.dayPlan - metrics.dayDone);
        const nowMs2 = Date.now();
        const mskDay0 = Math.floor((nowMs2 + 3 * 3_600_000) / 86_400_000) * 86_400_000 - 3 * 3_600_000;
        const workedH = Math.max(0.5, (nowMs2 - (mskDay0 + 8 * 3_600_000)) / 3_600_000);
        const rate = metrics.dayDone / workedH;
        const etaText = left < 1 ? ''
          : rate > 0
            ? ` · при текущем темпе закроем к ${new Date(nowMs2 + left / rate * 3_600_000)
              .toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}`
            : '';
        const goalLine = left < 1
          ? `<div class="dd-pace good">🏁 Цель дня взята — ${money(Math.round(metrics.dayDone))} выгружено</div>`
          : `<div class="dd-pace ${pace.diff >= -0.5 ? 'good' : 'bad'}">🎯 До цели дня осталось <b>${money(Math.round(left))}</b>${etaText}</div>`;
        return `<div class="dd-pace ${pace.diff >= -0.5 ? 'good' : 'bad'}">⏱ к ${clock} должно быть выгружено
          ${money(Math.round(pace.due))} — ${pace.diff >= -0.5
            ? `✓ в темпе${pace.diff > 0.5 ? ` +${money(Math.round(pace.diff))}` : ''}`
            : `⚠ отстаём на ${money(Math.round(-pace.diff))}`}</div>${goalLine}`;
      })() : ''}
      <div class="dd-verdict">${verdict}</div>
    </div>`;
  };

  // Нормы «к этому часу» для главных счётчиков дня.
  const data = state.data;
  const tsOf = value => {
    const text = String(value || '');
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}Z` : text);
  };
  const norms = {
    created: usualByNow(data.orders.filter(order => !order.deleted_at), order => tsOf(order.created_at)),
    assigned: usualByNow(data.trips.filter(trip => trip.order_id && trip.source_system !== '1c' &&
      trip.status !== 'rejected'), trip => tsOf(trip.created_at)),
    onLine: usualByNow(data.trips.filter(trip => trip.on_line_at && trip.status !== 'rejected'),
      trip => tsOf(trip.on_line_at)),
    unloaded: usualByNow(data.trips.filter(trip => trip.unloaded_at && trip.status !== 'rejected'),
      trip => tsOf(trip.unloaded_at))
  };
  // Воронка ресурса дня: можно задействовать → задействовано → упущено.
  const canUse = metrics.fleet.total - metrics.fleet.unavailable;
  const unusedLoss = metrics.fleet.idle * 77_000; // средняя выручка машино-дня (август)
  // «Моя смена» — только сотрудникам конвейера; табло (manager) и гостям не показывается.
  const myRoles = data.user.roles || [data.user.role];
  const showMyShift = !Number(data.user.guest) &&
    myRoles.some(role => ['sales', 'logist', 'dispatcher', 'resource', 'accountant', 'admin'].includes(role));

  // Открытые вопросы водителей — общая цифра смены на дашборде.
  const questions = await loadOpenQuestions();
  const overdueQuestions = questions.filter(item => Date.now() -
    Date.parse(String(item.opened_at).replace(' ', 'T') +
      (String(item.opened_at).includes('Z') ? '' : 'Z')) > 10 * 60_000).length;
  const savedScrolls = captureScrolls(container);
  const html = `<div class="dashwrap" id="dashRoot">
    <div class="dash-top">
      <span class="dash-title">🏁 ПегасLogistic · план-факт</span>
      <span class="dash-clock" id="dashClock"></span>
      <span class="dash-upd muted">обновлено ${new Date().toLocaleTimeString('ru-RU',
        { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК · авто раз в 90 с</span>
      ${context.can('settings:write') ? `<button class="button ghost small" id="dashBoard"
        title="Вывести объявление на общий экран: планёрка, сбой 1С, аврал">📢 На табло</button>` : ''}
      <button class="button ghost small" id="dashFull" title="Полноэкранный режим для общего экрана (выход — Esc)">⛶ На весь экран</button>
    </div>
    ${boardNotesHtml(context.state.data.boardNotes)}
    <div class="dash-goal dash-month">
      <div class="dash-goal-head">
        <span>Выручка без НДС · ${escapeHtml(monthLabel)} · <b>забито</b></span>
        <b title="Забито на месяц: выгружено + расчётные выгрузки броней до конца месяца">${money(Math.round(metrics.monthFact))}</b>
        <span class="muted">из ${shortMln(metrics.monthPlan)} · ${donePct}%
          · <span class="dash-done" title="Фактически выгружено с начала месяца (статус «выгружен» и далее)">выгружено <b>${money(Math.round(metrics.monthDone))}</b></span></span>
        <span class="dash-month-side">Прогноз: <b class="${forecastPct >= 100 ? 'good' : forecastPct >= 90 ? 'warn' : 'bad'}">
          ${shortMln(metrics.forecast)} (${forecastPct}%)</b> · осталось дней: <b>${metrics.remainingDays}</b>
          · средний чек: <b>${money(Math.round(metrics.avgDayCheck))}</b></span>
      </div>
      <div class="dash-pace" title="Урок августа: прогноз опирался на «забитое», из которого часть рейсов отклонили, а часть выгрузилась уже в следующем месяце. Риск отклонений — по доле отклонённой выручки за последние 14 дней">
        🧮 Честно: <b>${shortMln(metrics.forecastHonest)}</b> = выгружено ${shortMln(metrics.monthDone)}
        + доедет ~${shortMln(metrics.monthBooked * (1 - metrics.rejShare))}
        <span class="muted">(назначено ${shortMln(metrics.monthBooked)}, риск отклонений −${Math.round(metrics.rejShare * 100)}%)</span>${metrics.carryOver > 100_000
    ? ` · переходят в следующий месяц: <b>${shortMln(metrics.carryOver)}</b> <span class="muted">(выгрузка за пределами месяца — не в этой цели)</span>` : ''}</div>
      <div class="dash-pace ${metrics.monthPace.diff >= 0 ? 'good' : 'bad'}">
        ⏱ По графику к концу ${metrics.dayOfMonth}-го: <b>${shortMln(metrics.monthPace.schedule)}</b>
        · выгружено: <b>${shortMln(metrics.monthPace.fact)}</b>
        · ${metrics.monthPace.diff >= 0 ? `опережение +${shortMln(metrics.monthPace.diff)}`
          : `отставание ${shortMln(-metrics.monthPace.diff)}`}
        — чтобы успеть к цели, дальше нужно по <b>${money(Math.round(metrics.dayPlan))}</b> в день</div>
      ${gauge(donePct, donePct >= Math.round(metrics.dayOfMonth / metrics.daysInMonth * 100) ? 'ok' : 'warn')}
      ${monthSpark(state.data, metrics, Date.now())}
    </div>
    <div class="dash-days">
      ${dayCard(metrics.days.yesterday, 'Вчера', 'past')}
      ${dayCard(metrics.days.today, 'Сегодня', 'today')}
      ${dayCard(metrics.days.tomorrow, 'Завтра', 'future')}
    </div>
    <div class="dash-roles">
      ${showMyShift ? `<div class="dash-role my-shift" id="myShiftCard">
      <div class="dash-role-title">🏅 Моя смена</div>
      <div class="dash-row"><span>Загружаю личную сводку…</span></div>
    </div>` : ''}
      ${roleCard('📦 Продажи', [
        { label: 'Внесено заявок сегодня', value: `${metrics.sales.createdToday}${normBadge(metrics.sales.createdToday, norms.created)}`, detail: 'salesCreated' },
        { label: 'Сумма внесённого (бНДС)', value: money(Math.round(metrics.sales.createdSum)) },
        { label: 'Средний чек внесённого', value: money(Math.round(metrics.sales.avgCheck)) },
        { label: 'Очередь без ТС', value: metrics.sales.queue, cls: metrics.sales.queue ? 'warn' : 'ok', detail: 'salesQueue' }
      ])}
      ${roleCard('🚚 Логист', [
        { label: 'Назначено рейсов сегодня', value: `${metrics.logist.assignedToday}${normBadge(metrics.logist.assignedToday, norms.assigned)}`, detail: 'logistAssigned' },
        { label: 'Очередь на назначение', value: metrics.logist.queue, cls: metrics.logist.queue ? 'warn' : 'ok', detail: 'salesQueue' },
        { label: 'На линии без следующего рейса', value: `${metrics.logist.noNext} из ${metrics.dispatcher.online}`,
          cls: metrics.logist.noNext ? 'bad' : 'ok', detail: 'logistNoNext' },
        { label: 'Парк в рейсе сегодня', value: `${metrics.fleet.inTrip} из ${metrics.fleet.total}`, detail: 'fleetInTrip' },
        { label: '⏭ Ждут следующей погрузки', value: metrics.fleet.pending,
          cls: metrics.fleet.pending ? 'warn' : 'ok', detail: 'fleetPending' },
        { label: 'Простой без причины', value: metrics.fleet.idle, cls: metrics.fleet.idle ? 'bad' : 'ok', detail: 'fleetIdle' }
      ])}
      ${roleCard('🎧 Диспетчер', [
        { label: 'Выведено на линию сегодня', value: `${metrics.dispatcher.onLineToday}${normBadge(metrics.dispatcher.onLineToday, norms.onLine)}`, detail: 'dispOnLine' },
        { label: 'Ждут выхода сегодня', value: metrics.dispatcher.startingToday,
          cls: metrics.dispatcher.startingToday ? 'warn' : 'ok', detail: 'dispStarting' },
        { label: 'Выгружено сегодня', value: `${metrics.dispatcher.unloadedToday}${normBadge(metrics.dispatcher.unloadedToday, norms.unloaded)}`, detail: 'dispUnloaded' },
        { label: 'На линии сейчас · машин', value: metrics.dispatcher.online, detail: 'dispOnline' },
        { label: 'Рейсов на контроле', value: metrics.dispatcher.onlineTripCount, detail: 'dispOnline' },
        { label: 'Долги перед 1С', value: metrics.dispatcher.debt1c,
          cls: metrics.dispatcher.debt1c ? 'bad' : 'ok', detail: 'dispDebt1c' },
        // Вопросы водителей: висящие дольше десяти минут — красным. Водитель
        // стоит на погрузке и ждёт ответа, это дороже любой другой цифры.
        { label: 'Вопросы водителей', value: `${questions.length}${overdueQuestions
          ? ` · ⏱ ${overdueQuestions}` : ''}`,
        cls: overdueQuestions ? 'bad' : questions.length ? 'warn' : 'ok' }
      ])}
      ${roleCard('🔧 Ресурс — воронка дня', [
        { label: 'Парк в работе', value: metrics.fleet.total },
        { label: '− Недоступны (ремонт, пересменка, без вод., резерв)', value: `−${metrics.fleet.unavailable}`, detail: 'fleetUnavailable' },
        { label: '= Можно задействовать сегодня', value: `<b>${canUse}</b>` },
        { label: 'Задействовано (в рейсе сегодня)', value: `${metrics.fleet.inTrip} из ${canUse} (${pctOf(metrics.fleet.inTrip, canUse)}%)`,
          cls: metrics.fleet.inTrip >= canUse * 0.85 ? 'ok' : 'warn', detail: 'fleetInTrip' },
        { label: 'НЕ задействовано — упущено', value: `${metrics.fleet.idle}${metrics.fleet.idle ? ` · ≈ −${money(unusedLoss)}` : ''}`,
          cls: metrics.fleet.idle ? 'bad' : 'ok', detail: 'fleetIdle' }
      ])}
    </div>

  </div>`;

  // Разметка не изменилась — DOM не трогаем: без мигания, без прыжков
  // списков и прокрутки. Обработчики остались на прежних узлах.
  if (!renderInto(container, html)) {
    restoreScrolls(container, savedScrolls);
    return;
  }
  restoreScrolls(container, savedScrolls);

  // «Моя смена»: личная сводка подгружается отдельно — дашборд не ждёт её.
  if (showMyShift) {
    api('/api/my-shift').then(my => {
      const card = document.getElementById('myShiftCard');
      if (!card) return;
      const barPct = Math.min(100, my.normToNow ? Math.round(my.ops / my.normToNow * 100) : 100);
      const effCls = my.effPct >= 120 ? 'ok' : my.effPct < 70 ? 'bad' : '';
      card.innerHTML = `
        <div class="dash-role-title">🏅 Моя смена <small class="muted">${escapeHtml(my.shiftLabel)}</small></div>
        <div class="dash-row"><span>Операций за смену</span>
          <b>${my.ops}${my.normToNow ? ` <small class="muted" title="Норма должности к этому часу (среднее за 7 дней)">· норма к часу ~${my.normToNow}</small>` : ''}</b></div>
        <div class="dash-gauge"><i class="${barPct >= 95 ? 'ok' : 'ride'}" style="width:${barPct}%"></i></div>
        <div class="dash-row ${effCls}"><span>Эффективность</span>
          <b title="60% нагрузка (×${my.loadIdx}) + 40% скорость (×${my.speedIdx}) к средней по должности «${escapeHtml(my.roleKey)}» за 7 дней">${my.effPct}%</b></div>
        ${my.medianWaitMs ? `<div class="dash-row"><span>Обработка задания (медиана)</span>
          <b>${Math.round(my.medianWaitMs / 60000)} мин${my.baseWaitMs ? ` <small class="muted">· по должности ${Math.round(my.baseWaitMs / 60000)} мин</small>` : ''}</b></div>` : ''}
        <div class="dash-row"><span>Вклад в операции смены</span><b>${my.sharePct}%</b></div>`;
    }).catch(() => {
      const card = document.getElementById('myShiftCard');
      if (card) card.remove();
    });
  }

  // Раскрытие плашек ролей: список за цифрой (заявки / рейсы / машины).
  container.querySelectorAll('[data-dash-detail]').forEach(row =>
    row.addEventListener('click', () => dashDetailDialog(row.dataset.dashDetail, metrics, context.state.data, context)));

  // Бары «наполняются» при каждой отрисовке: вставляем нулевыми и через
  // кадр отпускаем к целевой ширине (CSS transition делает движение).
  container.querySelectorAll('.dash-gauge i').forEach(bar => {
    const target = bar.style.width;
    bar.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = target; }));
  });
  // Живые часы — каждую секунду, без перерисовки дашборда.
  clearInterval(state.dashClockTimer);
  const tickClock = () => {
    const el = document.getElementById('dashClock');
    if (!el) { clearInterval(state.dashClockTimer); return; }
    el.textContent = new Date().toLocaleTimeString('ru-RU',
      { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Moscow' });
  };
  tickClock();
  state.dashClockTimer = setInterval(tickClock, 1000);
  wireBoardNotes(container, state);
  container.querySelector('#dashBoard')?.addEventListener('click', () => boardDialog(context));
  const fullButton = container.querySelector('#dashFull');
  const setTvButton = on => { if (fullButton) fullButton.textContent = on ? '✕ Выйти (Esc)' : '⛶ На весь экран'; };
  if (fullButton) fullButton.onclick = async () => {
    const root = document.getElementById('dashRoot');
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (root.classList.contains('dash-tv')) { root.classList.remove('dash-tv'); setTvButton(false); return; }
    try { await root.requestFullscreen(); } catch {
      // Нативный fullscreen запрещён (встроенные панели, киоски) —
      // включаем киоск-класс с теми же стилями поверх окна.
      root.classList.add('dash-tv');
      setTvButton(true);
    }
  };
  if (!state.dashEscBound) {
    state.dashEscBound = true;
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const root = document.getElementById('dashRoot');
      if (root?.classList.contains('dash-tv')) {
        root.classList.remove('dash-tv');
        const button = document.getElementById('dashFull');
        if (button) button.textContent = '⛶ На весь экран';
      }
    });
  }

  // Автообновление, пока открыта вкладка: один живой таймер на сессию.
  clearInterval(state.dashboardTimer);
  state.dashboardTimer = setInterval(() => {
    if (state.view === 'dashboard') context.onReload();
    else clearInterval(state.dashboardTimer);
  }, 90_000);
}
