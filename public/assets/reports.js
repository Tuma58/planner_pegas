// Печатные отчёты — перенос reportDoc из прототипа ТК 21 (6 видов).
// Экономика и утилизация — с сервера (/api/reports), разрез по клиентам и
// отклонённые — по данным bootstrap, история — /api/periods/history.
import { api, escapeHtml, formatDateTime } from './api.js';

export const REPORT_TITLES = {
  summary: 'Сводный отчёт руководителя',
  util: 'Использование парка',
  econ: 'Экономика по типам ТС',
  clients: 'Экономика по клиентам',
  rejected: 'Отклонённые рейсы',
  history: 'История отчётных периодов'
};

const rub = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
const pct = value => `${(value * 100).toFixed(1)}%`;
const isIP = name => /\bИП\b/iu.test(String(name || ''));
const fmtDay = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(`${iso}T00:00:00Z`));

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
          <td>${escapeHtml(trip.from_name)}→${escapeHtml(trip.to_name)}</td><td>${formatDateTime(trip.starts_at)}</td>
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
          <td>${escapeHtml(trip.from_name)}→${escapeHtml(trip.to_name)}</td><td>${formatDateTime(trip.starts_at)}</td>
          <td>${escapeHtml(trip.customer_name || '—')}</td><td>${escapeHtml(trip.rejection_reason || 'не указана')}</td></tr>`).join('') ||
          '<tr><td colspan=5>Отклонённых нет</td></tr>'}</tbody></table>`;
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
