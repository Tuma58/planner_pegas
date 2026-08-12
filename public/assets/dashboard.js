// Общий дашборд предприятия: план-факт по ролям на текущий день и прогноз
// месяца. Считается целиком из bootstrap (доступен каждой роли) — вкладку
// видят все сотрудники, цель — общая видимость достижения плана.
// Автообновление раз в 90 секунд, пока вкладка открыта.
import { escapeHtml, money } from './api.js';
import { orderStage } from './pipeline.js';
import { orderNet } from './sales.js';

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
  const factBeforeToday = monthFact - dayFact;

  const periodKey = new Date(monthStart).toISOString().slice(0, 10);
  const monthPlan = Number((data.revenuePlans || [])
    .find(item => item.period_start === periodKey)?.target_net || 0) || DEFAULT_MONTH_PLAN;
  // Дневной план — остаток плана на остаток дней (включая сегодня).
  const dayPlan = Math.max(0, (monthPlan - factBeforeToday) / Math.max(1, remainingDays));
  // Прогноз месяца — линейный ранрейт по прошедшим дням.
  const forecast = dayOfMonth > 1
    ? monthFact / dayOfMonth * daysInMonth : monthFact * daysInMonth;

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
  const online = activeTrips.filter(trip => trip.status === 'run').length;

  // Ресурс/парк: занятость сегодня.
  const fleet = (data.vehicles || []).filter(vehicle => vehicle.status === 'work');
  const inTripIds = new Set(activeTrips.filter(trip =>
    Date.parse(trip.starts_at) < dayEnd && Date.parse(trip.ends_at) > dayStart)
    .map(trip => trip.vehicle_id));
  let unavailable = 0;
  let idle = 0;
  for (const vehicle of fleet) {
    if (inTripIds.has(vehicle.id)) continue;
    const covered = (data.dispositions || []).some(item => item.vehicle_id === vehicle.id &&
      Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart);
    if (covered) unavailable += 1;
    else idle += 1;
  }

  return { monthPlan, monthFact, dayPlan, dayFact, forecast, daysInMonth, dayOfMonth,
    remainingDays, dayTripsCount: dayTrips.length,
    avgDayCheck: dayTrips.length ? dayFact / dayTrips.length : 0,
    sales: { createdToday: createdToday.length, createdSum, avgCheck, queue },
    logist: { assignedToday, queue },
    dispatcher: { onLineToday, startingToday, unloadedToday, online },
    fleet: { total: fleet.length, inTrip: inTripIds.size, unavailable, idle } };
}

const pctOf = (value, base) => base ? Math.round(value / base * 100) : 0;
const shortMln = value => `${(Number(value || 0) / 1e6).toLocaleString('ru-RU',
  { maximumFractionDigits: 1 })} млн`;

export function renderDashboard(container, context) {
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
    ${rows.map(row => `<div class="dash-row ${row.cls || ''}">
      <span>${row.label}</span><b>${row.value}</b></div>`).join('')}
  </div>`;

  container.innerHTML = `<div class="dashwrap">
    <div class="dash-main">
      <div class="dash-goal">
        <div class="dash-goal-head">
          <span>Выручка без НДС · ${escapeHtml(monthLabel)}</span>
          <b>${money(Math.round(metrics.monthFact))}</b>
          <span class="muted">из ${shortMln(metrics.monthPlan)} · ${donePct}%</span>
        </div>
        ${gauge(donePct, donePct >= Math.round(metrics.dayOfMonth / metrics.daysInMonth * 100) ? 'ok' : 'warn')}
        <div class="dash-goal-sub">
          <span>Прогноз месяца: <b class="${forecastPct >= 100 ? 'good' : forecastPct >= 90 ? 'warn' : 'bad'}">
            ${shortMln(metrics.forecast)} (${forecastPct}%)</b></span>
          <span>Осталось дней: <b>${metrics.remainingDays}</b></span>
        </div>
      </div>
      <div class="dash-goal">
        <div class="dash-goal-head">
          <span>План на сегодня</span>
          <b>${money(Math.round(metrics.dayFact))}</b>
          <span class="muted">из ${money(Math.round(metrics.dayPlan))} · ${dayPct}%</span>
        </div>
        ${gauge(dayPct, dayPct >= 60 ? 'ok' : 'warn')}
        <div class="dash-goal-sub">
          <span>Выгружено сегодня: <b>${metrics.dayTripsCount}</b> рейсов</span>
          <span>Средний чек: <b>${money(Math.round(metrics.avgDayCheck))}</b></span>
        </div>
      </div>
    </div>
    <div class="dash-roles">
      ${roleCard('📦 Продажи', [
        { label: 'Внесено заявок сегодня', value: metrics.sales.createdToday },
        { label: 'Сумма внесённого (бНДС)', value: money(Math.round(metrics.sales.createdSum)) },
        { label: 'Средний чек внесённого', value: money(Math.round(metrics.sales.avgCheck)) },
        { label: 'Очередь без ТС', value: metrics.sales.queue, cls: metrics.sales.queue ? 'warn' : 'ok' }
      ])}
      ${roleCard('🚚 Логист', [
        { label: 'Назначено рейсов сегодня', value: metrics.logist.assignedToday },
        { label: 'Очередь на назначение', value: metrics.logist.queue, cls: metrics.logist.queue ? 'warn' : 'ok' },
        { label: 'Парк в рейсе сегодня', value: `${metrics.fleet.inTrip} из ${metrics.fleet.total}` },
        { label: 'Простой без причины', value: metrics.fleet.idle, cls: metrics.fleet.idle ? 'bad' : 'ok' }
      ])}
      ${roleCard('🎧 Диспетчер', [
        { label: 'Выведено на линию сегодня', value: metrics.dispatcher.onLineToday },
        { label: 'Ждут выхода сегодня', value: metrics.dispatcher.startingToday,
          cls: metrics.dispatcher.startingToday ? 'warn' : 'ok' },
        { label: 'Выгружено сегодня', value: metrics.dispatcher.unloadedToday },
        { label: 'На линии сейчас', value: metrics.dispatcher.online }
      ])}
      ${roleCard('🔧 Ресурс', [
        { label: 'Парк в работе', value: metrics.fleet.total },
        { label: 'В рейсе сегодня', value: `${metrics.fleet.inTrip} (${pctOf(metrics.fleet.inTrip, metrics.fleet.total)}%)` },
        { label: 'Недоступны (оформлено)', value: metrics.fleet.unavailable },
        { label: 'Простой без причины', value: metrics.fleet.idle, cls: metrics.fleet.idle ? 'bad' : 'ok' }
      ])}
    </div>
    <p class="muted dash-note">Факт — по выгрузкам, без НДС (ИП 7%). Дневной план —
      остаток месячного плана, делённый на оставшиеся дни. Прогноз — текущий темп
      на весь месяц. Обновляется автоматически.</p>
  </div>`;

  // Автообновление, пока открыта вкладка: один живой таймер на сессию.
  clearInterval(state.dashboardTimer);
  state.dashboardTimer = setInterval(() => {
    if (state.view === 'dashboard') context.onReload();
    else clearInterval(state.dashboardTimer);
  }, 90_000);
}
