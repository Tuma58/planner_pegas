// Печатные отчёты — перенос reportDoc из прототипа ТК 21 (6 видов).
// Экономика и утилизация — с сервера (/api/reports), разрез по клиентам и
// отклонённые — по данным bootstrap, история — /api/periods/history.
import { api, escapeHtml, formatDateTime, routeLabel } from './api.js';
import { pipelineStep, waitingLabel } from './pipeline.js';

export const REPORT_TITLES = {
  summary: 'Сводный отчёт руководителя',
  util: 'Использование парка',
  econ: 'Экономика по типам ТС',
  clients: 'Экономика по клиентам',
  rejected: 'Отклонённые рейсы',
  execution: 'Контроль выполнения рейсов',
  conflicts: 'История конфликтов',
  'rejected-orders': 'Реестр заявок',
  history: 'История отчётных периодов'
};

const rub = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
const pct = value => `${(value * 100).toFixed(1)}%`;
const isIP = name => /\bИП\b/iu.test(String(name || ''));
const fmtDay = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(`${iso}T12:00:00Z`));

const inRange = (trip, from, to) =>
  trip.ends_at >= `${from}T00:00:00` && trip.ends_at < `${to}T23:59:59` &&
  Date.parse(trip.ends_at) >= Date.parse(`${from}T00:00:00Z`) &&
  Date.parse(trip.ends_at) < Date.parse(`${to}T00:00:00Z`);

// Экономика по клиентам — клиентская свёртка по правилам ТК 21 (НДС ИП 7%).
function econByClient(data, from, to) {
  const calculation = data.settings.calculation;
  const map = new Map();
  data.trips.filter(trip => trip.status !== 'rejected' && inRange(trip, from, to)).forEach(trip => {
    const vat = isIP(trip.customer_name)
      ? Number(calculation.individualEntrepreneurVatRate ?? 0.07)
      : Number(calculation.vatRate ?? 0.22);
    const net = Number(trip.revenue_vat) / (1 + vat);
    const days = Math.max(0, (Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 86_400_000);
    const variable = Number(trip.distance_km) *
      (Number(calculation.costPerKm || 0) + Number(calculation.insuranceAndRoadsPerKm || 0)) +
      days * (Number(calculation.driverPerTripDay || 0) + Number(calculation.refrigerationPerTripDay || 0));
    const item = map.get(trip.customer_name) || { customer: trip.customer_name, trips: 0, revenue: 0, profit: 0 };
    item.trips += 1;
    item.revenue += net;
    item.profit += net - variable;
    map.set(trip.customer_name, item);
  });
  return [...map.values()].map(item => ({ ...item, margin: item.revenue ? item.profit / item.revenue : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
}

export async function buildReport(kind, from, to, data) {
  const report = await api(`/api/reports?from=${from}&to=${to}`);
  const u = report.utilization;
  const md = u.machineDays;
  let body = '';

  const typeRows = mapRow => report.byVehicleType.map(mapRow).join('');
  const rejectedTrips = data.trips
    .filter(trip => trip.status === 'rejected' && inRange(trip, from, to))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  if (kind === 'summary') {
    body = `<div class="rsums">
        <span class="rsum">КТГ: <b>${pct(u.ktg)}</b></span><span class="rsum">КВЛ: <b>${pct(u.kvl)}</b></span>
        <span class="rsum">КИП: <b>${pct(u.kip)}</b></span><span class="rsum">В работе: <b>${pct(u.overall)}</b></span></div>
      <div class="rsums">
        <span class="rsum">Выручка б.НДС: <b>${rub(report.netRevenue)}</b></span>
        <span class="rsum">Марж. доход: <b>${rub(report.contribution)}</b></span>
        <span class="rsum">Постоянные: <b>${rub(report.fixed)}</b></span>
        <span class="rsum">Опер. прибыль: <b>${rub(report.operationalProfit)}</b></span>
        <span class="rsum">Опер. маржа: <b>${pct(report.operationalMargin)}</b></span>
        <span class="rsum">Упущено: <b>${rub(u.lostProfit)}</b></span></div>
      <h4>Экономика по типам ТС</h4>
      <table class="rtable"><thead><tr><th>Тип</th><th class="num">Рейсов</th><th class="num">Машин</th><th class="num">Выручка б.НДС</th><th class="num">Опер. прибыль</th><th class="num">Опер. маржа</th></tr></thead>
        <tbody>${typeRows(row => `<tr><td>${escapeHtml(row.vehicleType)}</td><td class="num">${row.trips}</td><td class="num">${row.vehicles}</td>
          <td class="num">${rub(row.netRevenue)}</td><td class="num">${rub(row.operationalProfit)}</td>
          <td class="num">${row.netRevenue ? pct(row.operationalProfit / row.netRevenue) : '—'}</td></tr>`) ||
          '<tr><td colspan=6>Нет рейсов за период</td></tr>'}</tbody></table>
      <h4>Отклонённые рейсы за период: ${rejectedTrips.length}</h4>
      <table class="rtable"><thead><tr><th>ТС</th><th>Маршрут</th><th>Начало</th><th>Причина</th></tr></thead>
        <tbody>${rejectedTrips.map(trip => `<tr><td class="mono">${escapeHtml(trip.vehicle_plate || '')}</td>
          <td>${escapeHtml(routeLabel(trip))}</td><td>${formatDateTime(trip.starts_at)}</td>
          <td>${escapeHtml(trip.rejection_reason || '—')}</td></tr>`).join('') ||
          '<tr><td colspan=4>Отклонённых нет</td></tr>'}</tbody></table>`;
  } else if (kind === 'util') {
    body = `<div class="rsums">
        <span class="rsum">Списочный: <b>${u.vehicles}</b></span>
        <span class="rsum">КТГ: <b>${pct(u.ktg)}</b></span><span class="rsum">КВЛ: <b>${pct(u.kvl)}</b></span>
        <span class="rsum">КИП: <b>${pct(u.kip)}</b></span>
        <span class="rsum">В работе от списка: <b>${pct(u.overall)}</b> (норма ${(u.utilizationTarget * 100).toFixed(1)}%)</span></div>
      <h4>Машино-дни</h4>
      <table class="rtable"><tbody>
        <tr><td>Календарный ресурс (списочный × ${u.days})</td><td class="num">${u.calendarDays}</td></tr>
        <tr><td>Плановые (норма ${(u.utilizationTarget * 100).toFixed(1)}%)</td><td class="num">${u.normDays}</td></tr>
        <tr><td>Фактические в работе</td><td class="num">${u.workDays}</td></tr>
        <tr><td>Отклонение от нормы</td><td class="num">${u.workDays - u.normDays}</td></tr>
        <tr><td>Марж. доход на машино-день</td><td class="num">${rub(u.marginPerTripDay)}</td></tr>
        <tr><td><b>Упущенный марж. доход за период</b></td><td class="num"><b>${rub(u.lostProfit)}</b></td></tr></tbody></table>
      <h4>Операционная прибыль</h4>
      <table class="rtable"><tbody>
        <tr><td>Выручка без НДС</td><td class="num">${rub(report.netRevenue)}</td></tr>
        <tr><td>− Переменные затраты (путевые, страх./дороги, водитель, ХОУ)</td><td class="num">${rub(report.netRevenue - report.contribution)}</td></tr>
        <tr><td>= Маржинальный доход</td><td class="num">${rub(report.contribution)}</td></tr>
        <tr><td>− Постоянные затраты (лизинг+накладные · ${u.vehicles}×${u.days} маш-дней)</td><td class="num">${rub(report.fixed)}</td></tr>
        <tr><td><b>= Операционная прибыль</b></td><td class="num"><b>${rub(report.operationalProfit)}</b></td></tr>
        <tr><td>Операционная маржа</td><td class="num">${pct(report.operationalMargin)}</td></tr></tbody></table>
      <h4>Простой по причинам · машино-дни</h4>
      <table class="rtable"><thead><tr><th>Причина</th><th>Ответственный</th><th class="num">Маш-дни</th></tr></thead><tbody>
        <tr><td>В ремонте</td><td>КТГ · ТОиР</td><td class="num">${md.repair}</td></tr>
        <tr><td>Без водителя</td><td>КВЛ · Упр. водителями</td><td class="num">${md.noDriver}</td></tr>
        <tr><td>Пересменка</td><td>смена вахты</td><td class="num">${md.shift}</td></tr>
        <tr><td>Без рейса</td><td>КИП · Логистика</td><td class="num">${md.idle}</td></tr></tbody></table>`;
  } else if (kind === 'econ') {
    body = `<div class="rsums">
        <span class="rsum">Выручка б.НДС: <b>${rub(report.netRevenue)}</b></span>
        <span class="rsum">Марж. доход: <b>${rub(report.contribution)}</b></span>
        <span class="rsum">Постоянные: <b>${rub(report.fixed)}</b></span>
        <span class="rsum">Опер. прибыль: <b>${rub(report.operationalProfit)}</b></span>
        <span class="rsum">Опер. маржа: <b>${pct(report.operationalMargin)}</b></span></div>
      <div class="geohint">Постоянные затраты (лизинг+накладные) отнесены на календарные машино-дни сцепок каждого типа за период.</div>
      <table class="rtable"><thead><tr><th>Тип ТС</th><th class="num">Рейсов</th><th class="num">Машин</th><th class="num">Выручка б.НДС</th><th class="num">Марж. доход</th><th class="num">Постоянные</th><th class="num">Опер. прибыль</th><th class="num">Опер. маржа</th></tr></thead>
        <tbody>${typeRows(row => `<tr><td>${escapeHtml(row.vehicleType)}</td><td class="num">${row.trips}</td><td class="num">${row.vehicles}</td>
          <td class="num">${rub(row.netRevenue)}</td><td class="num">${rub(row.contribution)}</td><td class="num">${rub(row.fixed)}</td>
          <td class="num ${row.operationalProfit < 0 ? 'danger' : ''}">${rub(row.operationalProfit)}</td>
          <td class="num">${row.netRevenue ? pct(row.operationalProfit / row.netRevenue) : '—'}</td></tr>`) ||
          '<tr><td colspan=8>Нет рейсов за период</td></tr>'}
        <tr class="tot"><td>Итого</td><td class="num">${report.trips}</td><td class="num"></td>
          <td class="num">${rub(report.netRevenue)}</td><td class="num">${rub(report.contribution)}</td>
          <td class="num">${rub(report.fixed)}</td><td class="num">${rub(report.operationalProfit)}</td>
          <td class="num">${pct(report.operationalMargin)}</td></tr></tbody></table>`;
  } else if (kind === 'clients') {
    const clients = econByClient(data, from, to);
    const ipCount = clients.filter(row => isIP(row.customer)).length;
    const totals = clients.reduce((sum, row) =>
      ({ trips: sum.trips + row.trips, revenue: sum.revenue + row.revenue, profit: sum.profit + row.profit }),
      { trips: 0, revenue: 0, profit: 0 });
    body = `<div class="rsums"><span class="rsum">Заказчиков: <b>${clients.length}</b></span>
        <span class="rsum">из них ИП (НДС 7%): <b>${ipCount}</b></span>
        <span class="rsum">Выручка б.НДС: <b>${rub(totals.revenue)}</b></span>
        <span class="rsum">Марж. доход: <b>${rub(totals.profit)}</b></span>
        <span class="rsum">Маржа: <b>${totals.revenue ? pct(totals.profit / totals.revenue) : '—'}</b></span></div>
      <div class="geohint">Сортировка по выручке${clients.length > 40 ? ' · показаны первые 40' : ''}. Выручка без НДС учитывает ставку по клиенту (ИП — 7%).</div>
      <table class="rtable"><thead><tr><th>Заказчик</th><th class="num">НДС</th><th class="num">Рейсов</th><th class="num">Выручка б.НДС</th><th class="num">Марж. доход</th><th class="num">Маржа</th></tr></thead>
        <tbody>${clients.slice(0, 40).map(row => `<tr><td>${escapeHtml(row.customer)}${isIP(row.customer) ? ' <span class="badge">ИП</span>' : ''}</td>
          <td class="num">${isIP(row.customer) ? '7%' : '22%'}</td><td class="num">${row.trips}</td>
          <td class="num">${rub(row.revenue)}</td><td class="num">${rub(row.profit)}</td>
          <td class="num ${row.margin < 0 ? 'danger' : ''}">${pct(row.margin)}</td></tr>`).join('') ||
          '<tr><td colspan=6>Нет рейсов за период</td></tr>'}</tbody></table>`;
  } else if (kind === 'conflicts') {
    // История конфликтов за период: оперативный реестр «Требует решения»
    // очищается от прошлого автоматически, а здесь конфликты воспроизводятся
    // из данных рейсов на любую глубину.
    const periodTrips = data.trips.filter(trip => trip.status !== 'rejected' && inRange(trip, from, to));
    const byVehicle = new Map();
    periodTrips.forEach(trip => {
      if (!byVehicle.has(trip.vehicle_id)) byVehicle.set(trip.vehicle_id, []);
      byVehicle.get(trip.vehicle_id).push(trip);
    });
    const pairs = [];
    for (const vehicleTrips of byVehicle.values()) {
      for (let i = 0; i < vehicleTrips.length; i += 1) {
        for (let j = i + 1; j < vehicleTrips.length; j += 1) {
          const a = vehicleTrips[i], b = vehicleTrips[j];
          const overlap = Math.min(Date.parse(a.ends_at), Date.parse(b.ends_at)) -
            Math.max(Date.parse(a.starts_at), Date.parse(b.starts_at));
          if (overlap > 6 * 3_600_000) pairs.push({ a, b, hours: Math.round(overlap / 3_600_000) });
        }
      }
    }
    pairs.sort((x, y) => y.hours - x.hours);
    const criticalTrips = periodTrips.filter(trip => (data.dispositions || []).some(item =>
      item.vehicle_id === trip.vehicle_id &&
      Date.parse(trip.starts_at) < Date.parse(item.ends_at) &&
      Date.parse(item.starts_at) < Date.parse(trip.ends_at)));
    const topVehicles = new Map();
    pairs.forEach(pair => topVehicles.set(pair.a.vehicle_plate,
      (topVehicles.get(pair.a.vehicle_plate) || 0) + 1));
    const topRows = [...topVehicles.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)
      .map(([plate, count]) => `<tr><td class="mono">${escapeHtml(plate)}</td><td class="num">${count}</td></tr>`).join('');
    body = `<div class="rsums">
        <span class="rsum">Конфликтных пар: <b>${pairs.length}</b></span>
        <span class="rsum">Рейсов на простое (критичных): <b>${criticalTrips.length}</b></span>
        <span class="rsum">Рейсов за период: <b>${periodTrips.length}</b></span></div>
      <h4>Наложения рейсов по одной сцепке (пересечение &gt; 6 ч)</h4>
      <table class="rtable"><thead><tr><th>ТС</th><th>Рейс 1</th><th>Рейс 2</th><th class="num">Пересечение</th></tr></thead>
        <tbody>${pairs.map(pair => `<tr><td class="mono">${escapeHtml(pair.a.vehicle_plate || '')}</td>
          <td>${escapeHtml(routeLabel(pair.a))} · ${formatDateTime(pair.a.starts_at)}</td>
          <td>${escapeHtml(routeLabel(pair.b))} · ${formatDateTime(pair.b.starts_at)}</td>
          <td class="num">${pair.hours} ч</td></tr>`).join('') ||
          '<tr><td colspan=4>Конфликтов за период не было</td></tr>'}</tbody></table>
      <h4>ТС с наибольшим числом конфликтов</h4>
      <table class="rtable"><thead><tr><th>ТС</th><th class="num">Конфликтов</th></tr></thead>
        <tbody>${topRows || '<tr><td colspan=2>—</td></tr>'}</tbody></table>
      <h4>Рейсы, пересекавшиеся с простоями (ремонт/без водителя)</h4>
      <table class="rtable"><thead><tr><th>ТС</th><th>Маршрут</th><th>Начало</th><th>Заказчик</th></tr></thead>
        <tbody>${criticalTrips.map(trip => `<tr><td class="mono">${escapeHtml(trip.vehicle_plate || '')}</td>
          <td>${escapeHtml(routeLabel(trip))}</td>
          <td>${formatDateTime(trip.starts_at)}</td><td>${escapeHtml(trip.customer_name || '—')}</td></tr>`).join('') ||
          '<tr><td colspan=4>Таких рейсов не было</td></tr>'}</tbody></table>`;
  } else if (kind === 'rejected') {
    const byReason = {};
    rejectedTrips.forEach(trip => {
      const reason = trip.rejection_reason || 'не указана';
      byReason[reason] = (byReason[reason] || 0) + 1;
    });
    const summary = Object.entries(byReason).sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `<span class="rsum">${escapeHtml(reason)}: <b>${count}</b></span>`).join('');
    body = `<div class="geohint">Всего отклонено за период: <b>${rejectedTrips.length}</b></div>
      <div class="rsums">${summary || '—'}</div>
      <table class="rtable"><thead><tr><th>ТС</th><th>Маршрут</th><th>Начало</th><th>Заказчик</th><th>Причина</th></tr></thead>
        <tbody>${rejectedTrips.map(trip => `<tr><td class="mono">${escapeHtml(trip.vehicle_plate || '')}</td>
          <td>${escapeHtml(routeLabel(trip))}</td><td>${formatDateTime(trip.starts_at)}</td>
          <td>${escapeHtml(trip.customer_name || '—')}</td><td>${escapeHtml(trip.rejection_reason || 'не указана')}</td></tr>`).join('') ||
          '<tr><td colspan=5>Отклонённых нет</td></tr>'}</tbody></table>`;
  } else if (kind === 'execution') {
    // Дисциплина выполнения: план/факт прибытия по стоянкам контроля.
    // Рейсы без диспетчерских отметок показываются отдельно — по ним
    // пунктуальность оценить нельзя.
    const LATE_MS = 30 * 60_000;
    const { items } = await api(`/api/control?from=${from}T00:00:00.000Z&to=${to}T23:59:59.999Z`);
    const rows = items.map(trip => {
      const last = trip.stops[trip.stops.length - 1] || {};
      const hasFacts = trip.stops.some(stop => stop.actual_arrival || stop.actual_departure);
      const delay = hasFacts && last.actual_arrival && last.planned_arrival
        ? Date.parse(last.actual_arrival) - Date.parse(last.planned_arrival) : null;
      return { trip, last, hasFacts, delay };
    });
    const withFacts = rows.filter(row => row.delay != null);
    const late = withFacts.filter(row => row.delay > LATE_MS);
    const onTime = withFacts.length - late.length;
    const avgLate = late.length
      ? late.reduce((sum, row) => sum + row.delay, 0) / late.length : 0;
    const byDirection = new Map();
    late.forEach(row => byDirection.set(row.trip.to_name,
      (byDirection.get(row.trip.to_name) || 0) + 1));
    const directionRows = [...byDirection.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([zone, count]) => `<tr><td>${escapeHtml(zone)}</td><td class="num">${count}</td></tr>`).join('');
    const deviation = row => row.delay == null ? '<span class="muted">без отметок</span>'
      : row.delay > LATE_MS ? `<span style="color:var(--bad);font-weight:700">+${waitingLabel(row.delay)}</span>`
        : '<span style="color:var(--ok);font-weight:700">вовремя</span>';
    body = `<div class="rsums">
        <span class="rsum">Рейсов в периоде: <b>${rows.length}</b></span>
        <span class="rsum">С отметками контроля: <b>${withFacts.length}</b></span>
        <span class="rsum">Вовремя (±30 мин): <b>${withFacts.length ? pct(onTime / withFacts.length) : '—'}</b></span>
        <span class="rsum">Опозданий: <b>${late.length}</b></span>
        <span class="rsum">Средняя задержка: <b>${late.length ? waitingLabel(avgLate) : '—'}</b></span></div>
      <div class="geohint">Факты отмечает диспетчер на вкладке «Контроль»; рейсы без отметок в пунктуальности не участвуют.</div>
      <table class="rtable"><thead><tr><th>ТС</th><th>Маршрут</th><th>Заказчик</th>
        <th>План прибытия</th><th>Факт прибытия</th><th class="num">Отклонение</th></tr></thead>
        <tbody>${rows.sort((a, b) => (b.delay ?? -1) - (a.delay ?? -1)).map(row => `<tr>
          <td class="mono">${escapeHtml(row.trip.vehicle_plate || '')}</td>
          <td>${escapeHtml(routeLabel(row.trip))}</td>
          <td>${escapeHtml(row.trip.customer_name || '—')}</td>
          <td>${row.last.planned_arrival ? formatDateTime(row.last.planned_arrival) : '—'}</td>
          <td>${row.last.actual_arrival ? formatDateTime(row.last.actual_arrival) : '—'}</td>
          <td class="num">${deviation(row)}</td></tr>`).join('') ||
          '<tr><td colspan=6>Рейсов за период нет</td></tr>'}</tbody></table>
      <h4>Опоздания по направлениям</h4>
      <table class="rtable"><thead><tr><th>Геозона назначения</th><th class="num">Опозданий</th></tr></thead>
        <tbody>${directionRows || '<tr><td colspan=2>Опозданий не было</td></tr>'}</tbody></table>`;
  } else if (kind === 'rejected-orders') {
    // Реестр заявок: подтверждённые в работе, отклонённые и вернувшиеся из плана —
    // с причинами, плюс где конвейер стоит дольше всего.
    const all = data.orders || [];
    const rejected = all.filter(order => order.status === 'cancelled');
    const returned = all.filter(order => order.status === 'new' && order.returned_at);
    const confirmed = all.filter(order => order.status !== 'cancelled' && order.confirmed_at);
    const byStage = {};
    confirmed.forEach(order => {
      const step = pipelineStep(order, data, () => false);
      const bucket = (byStage[step.label] ||= { count: 0, waitMs: 0 });
      bucket.count += 1;
      bucket.waitMs += step.sinceMs;
    });
    const stageRows = Object.entries(byStage)
      .sort((a, b) => b[1].waitMs / b[1].count - a[1].waitMs / a[1].count)
      .map(([label, item]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${item.count}</td>
        <td class="num">${waitingLabel(item.waitMs / item.count)}</td></tr>`).join('');
    const confirmedRows = confirmed.map(order => {
      const step = pipelineStep(order, data, () => false);
      return `<tr><td>${escapeHtml(order.customer_name)}</td>
        <td>${escapeHtml(routeLabel(order))}</td>
        <td>${formatDateTime(order.window_from)}</td>
        <td class="num">${rub(order.rate_vat)}</td>
        <td class="mono">${escapeHtml(step.plate || '—')}</td>
        <td>${escapeHtml(step.label)}</td></tr>`;
    }).join('');
    const byReason = {};
    [...rejected, ...returned].forEach(order => {
      const reason = order.rejection_reason || 'не указана';
      byReason[reason] = (byReason[reason] || 0) + 1;
    });
    const summary = Object.entries(byReason).sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `<span class="rsum">${escapeHtml(reason)}: <b>${count}</b></span>`).join('');
    const rows = items => items.map(order => `<tr>
      <td>${escapeHtml(order.customer_name)}</td>
      <td>${escapeHtml(routeLabel(order))}</td>
      <td>${formatDateTime(order.window_from)}</td>
      <td class="num">${rub(order.rate_vat)}</td>
      <td>${escapeHtml(order.rejection_reason || 'не указана')}${order.deleted_at
        ? ` <span class="badge">удалена ${formatDateTime(order.deleted_at)}</span>` : ''}</td></tr>`).join('');
    body = `<div class="geohint">Подтверждено: <b>${confirmed.length}</b> ·
        отклонено: <b>${rejected.length}</b> · вернулось из плана: <b>${returned.length}</b></div>
      <div class="rsums">${summary || '—'}</div>
      <h4>Где конвейер ждёт дольше всего</h4>
      <table class="rtable"><thead><tr><th>Стадия</th><th>Заявок</th><th>Среднее ожидание</th></tr></thead>
        <tbody>${stageRows || '<tr><td colspan=3>Нет заявок в работе</td></tr>'}</tbody></table>
      <h4>Подтверждённые заявки в работе</h4>
      <table class="rtable"><thead><tr><th>Заказчик</th><th>Маршрут</th><th>Окно с</th><th>Ставка</th><th>ТС</th><th>Стадия</th></tr></thead>
        <tbody>${confirmedRows || '<tr><td colspan=6>Подтверждённых заявок нет</td></tr>'}</tbody></table>
      <h4>Отклонённые заявки</h4>
      <table class="rtable"><thead><tr><th>Заказчик</th><th>Маршрут</th><th>Окно с</th><th>Ставка</th><th>Причина</th></tr></thead>
        <tbody>${rows(rejected) || '<tr><td colspan=5>Отклонённых заявок нет</td></tr>'}</tbody></table>
      <h4>Вернулись из плана в продажи</h4>
      <table class="rtable"><thead><tr><th>Заказчик</th><th>Маршрут</th><th>Окно с</th><th>Ставка</th><th>Причина возврата</th></tr></thead>
        <tbody>${rows(returned) || '<tr><td colspan=5>Возвратов нет</td></tr>'}</tbody></table>`;
  } else if (kind === 'history') {
    const history = await api('/api/periods/history');
    const plans = Object.fromEntries((data.revenuePlans || []).map(plan => [plan.period_start, Number(plan.target_net)]));
    const liveLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${from}T00:00:00Z`));
    const livePlan = plans[`${from.slice(0, 7)}-01`] || 0;
    const rows = [{
      label: liveLabel, live: true, revenuePlan: livePlan, metrics: report
    }, ...history.items.map(item => ({
      label: item.label, live: false,
      revenuePlan: Number(item.metrics.revenuePlan || 0), metrics: item.metrics
    }))].map(row => {
      const m = row.metrics;
      const util = m.utilization || { ktg: 0, kvl: 0, kip: 0 };
      const execution = row.revenuePlan ? Math.round(m.netRevenue / row.revenuePlan * 100) : null;
      return `<tr><td>${escapeHtml(row.label)}${row.live ? ' <span class="badge ok">текущий</span>' : ''}</td>
        <td class="num">${row.revenuePlan ? rub(row.revenuePlan) : '—'}</td>
        <td class="num">${rub(m.factRevenue)}</td><td class="num">${rub(m.netRevenue)}</td>
        <td class="num ${execution != null && execution < 90 ? 'danger' : ''}">${execution != null ? `${execution}%` : '—'}</td>
        <td class="num ${m.operationalProfit < 0 ? 'danger' : ''}">${rub(m.operationalProfit)}</td>
        <td class="num">${pct(m.operationalMargin)}</td>
        <td class="num">${pct(util.ktg)}/${pct(util.kvl)}/${pct(util.kip)}</td>
        <td class="num">${m.trips}</td></tr>`;
    }).join('');
    body = `<div class="geohint">Завершённые периоды фиксируются кнопкой «🏁 Закрыть период» в кабине руководителя.
      «Заработано» — вся выручка без НДС по дате выгрузки; «Выполнено» — уже выгружено. Текущий период показан живым.</div>
      <table class="rtable"><thead><tr><th>Период</th><th class="num">План</th><th class="num">Выполнено</th><th class="num">Заработано</th><th class="num">Вып. плана</th><th class="num">Опер. прибыль</th><th class="num">Опер. маржа</th><th class="num">КТГ/КВЛ/КИП</th><th class="num">Рейсов</th></tr></thead>
        <tbody>${rows}</tbody></table>
      ${history.items.length ? '' : '<div class="geohint" style="margin-top:8px">Завершённых периодов пока нет.</div>'}`;
  }

  return `<div class="report">
    <h3><span style="color:var(--teal);font-weight:800">PegasLogistic</span> · ${REPORT_TITLES[kind] || 'Отчёт'}</h3>
    <div class="geohint">Период: ${fmtDay(from)} – ${fmtDay(to)} (${u.days} дн) · сформирован ${new Date().toLocaleDateString('ru-RU')}</div>
    ${body}
  </div>`;
}
