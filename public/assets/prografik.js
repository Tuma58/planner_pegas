// «Производственный график» — Э1 каркас (заказ руководителя 11.11,
// поднят 14.11). ОДИН экран вместо трёх вкладок (План вывоза, План
// парка, Потоки): строки — геозоны, колонки — дни; в ячейке спрос без
// машины ▲ / свободно машин 🚛 / выручка дня. Клик по зоне разворачивает
// состав на месте: плечи клиентов и машины зоны. Баланс парка закреплён
// внизу. Горизонты Неделя/Месяц, сегодня подсвечен, фокус-поиск.
// Э1 читает ТОЛЬКО готовые контуры (/api/delivery-plan, /api/fleet-plan,
// bootstrap) — ни одной новой серверной сборки; подбор кандидатов и
// черновик «что если» — этапы 2 и 5. Старые вкладки живут до Э4.
import { api, escapeHtml, money, renderInto, captureScrolls, restoreScrolls, attachSearch, toast } from './api.js';

const DAY_MS = 86_400_000;
const mskDayIso = shift => new Date(Date.now() + 3 * 3_600_000 + shift * DAY_MS).toISOString().slice(0, 10);

// Кэш на минуту: оба API зовутся разом, автообновление не дёргает сеть.
let cache = { ts: 0, month: '', dp: null, fp: null };
async function loadData(month) {
  if (cache.month === month && Date.now() - cache.ts < 60_000) return cache;
  const [dp, fp] = await Promise.all([
    api(`/api/delivery-plan?month=${month}`),
    api(`/api/fleet-plan?month=${month}`)
  ]);
  cache = { ts: Date.now(), month, dp, fp };
  return cache;
}

// Зона машины на начало дня: выгрузка последнего рейса, завершившегося
// до этого дня (фолбэк — приписка из справочника). GPS-уточнение — Э2.
function vehicleZoneOn(trips, vehicleId, dayStartMs, fallback) {
  let best = null;
  for (const trip of trips) {
    if (trip.vehicle_id !== vehicleId) continue;
    const end = Date.parse(trip.unloaded_at || trip.ends_at);
    if (end <= dayStartMs && (!best || end > best.end)) best = { end, zone: trip.to_name };
  }
  return best ? best.zone : fallback;
}

const busyOn = (trips, dispositions, vehicleId, dayStartMs) =>
  trips.some(trip => trip.vehicle_id === vehicleId && trip.status !== 'rejected' &&
    Date.parse(trip.starts_at) < dayStartMs + DAY_MS && Date.parse(trip.unloaded_at || trip.ends_at) > dayStartMs) ||
  dispositions.some(d => d.vehicle_id === vehicleId &&
    Date.parse(d.starts_at) < dayStartMs + DAY_MS && Date.parse(d.ends_at) > dayStartMs);

export async function renderPrografik(container, context) {
  const { state } = context;
  const month = state.prografikMonth || mskDayIso(0).slice(0, 7);
  const horizon = state.prografikHorizon || 'week';
  let data;
  try { data = await loadData(month); } catch (error) {
    container.innerHTML = `<div class="muted" style="padding:20px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (state.view !== 'prografik') return; // ушли с экрана, пока грузилось
  const { dp, fp } = data;
  const moneyVisible = (state.data?.user?.access?.money ?? 'full') === 'full';
  const todayIso = mskDayIso(0);
  // Дни горизонта: неделя — сегодня+6, месяц — весь выбранный месяц.
  const days = horizon === 'week'
    ? Array.from({ length: 7 }, (_, i) => mskDayIso(i))
    : Array.from({ length: fp.days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);

  const orders = (state.data.orders || []).filter(order => !order.trip_id);
  const ordersOn = (zone, iso) => orders.filter(order => order.from_name === zone &&
    String(order.window_from).slice(0, 10) <= iso && String(order.window_to).slice(0, 10) >= iso);
  const slotsFor = (zone, iso) => (dp.slots || []).filter(slot => slot.from_name === zone &&
    slot.weekday === new Date(`${iso}T12:00:00Z`).getUTCDay());
  // Выполненный спрос дня: рейсы с погрузкой из зоны в этот день.
  const tripsFrom = (zone, iso) => (fp.trips || []).filter(trip => trip.from_name === zone &&
    String(trip.starts_at).slice(0, 10) === iso);
  const tripsInto = (zone, iso) => (fp.trips || []).filter(trip => trip.to_name === zone &&
    String(trip.unloaded_at || trip.ends_at).slice(0, 10) === iso);

  // Предрасчёт по машинам: зона и занятость на каждый день горизонта.
  const vehicleDays = new Map(); // iso → Map(zone → {free:[], total:0})
  for (const iso of days) {
    const dayStart = Date.parse(`${iso}T00:00:00Z`) - 3 * 3_600_000;
    const perZone = new Map();
    for (const vehicle of fp.vehicles || []) {
      const zone = vehicleZoneOn(fp.trips || [], vehicle.id, dayStart, vehicle.zone_name || '—');
      if (!perZone.has(zone)) perZone.set(zone, { free: [], total: 0 });
      const bucket = perZone.get(zone);
      bucket.total += 1;
      if (!busyOn(fp.trips || [], fp.dispositions || [], vehicle.id, dayStart)) bucket.free.push(vehicle);
    }
    vehicleDays.set(iso, perZone);
  }

  // Состав зон: где есть спрос (слоты/заявки), машины или выручка.
  const zoneSet = new Set();
  (dp.slots || []).forEach(slot => zoneSet.add(slot.from_name));
  orders.forEach(order => order.from_name && zoneSet.add(order.from_name));
  for (const perZone of vehicleDays.values()) for (const zone of perZone.keys()) zoneSet.add(zone);
  const zoneMoney = zone => days.reduce((sum, iso) =>
    sum + tripsInto(zone, iso).reduce((s, t) => s + Number(t.revenue_vat || 0), 0), 0);
  const zones = [...zoneSet].filter(Boolean)
    .map(zone => ({ zone, money: zoneMoney(zone) }))
    .sort((a, b) => b.money - a.money);

  const query = (state.prografikQuery || '').toLowerCase();
  const open = state.prografikOpen || new Set();
  state.prografikOpen = open;

  const cellOf = (zone, iso) => {
    const perZone = vehicleDays.get(iso)?.get(zone);
    const free = perZone ? perZone.free.length : 0;
    const planned = slotsFor(zone, iso).reduce((sum, slot) => sum + Number(slot.per_day || 0), 0);
    const started = tripsFrom(zone, iso).length;
    const unassigned = ordersOn(zone, iso).length;
    // Спрос без машины: недобор сетки (план − вышло) + заявки без ТС.
    const gap = Math.max(0, planned - started) + unassigned;
    const income = tripsInto(zone, iso).reduce((sum, trip) => sum + Number(trip.revenue_vat || 0), 0);
    return { gap, free, income, planned, started, unassigned };
  };

  // Спрос сетки бывает дробным (0,5 машины/день) — показываем до одного
  // знака, хвосты двоичной арифметики не выносим на экран.
  const fmtGap = value => String(Math.round(value * 10) / 10).replace('.', ',');
  const shortMoney = value => value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace('.', ',')} млн`
    : value ? `${Math.round(value / 1000)} т` : '';

  const headRow = `<tr><th class="pg-zone">Зона</th>${days.map(iso =>
    `<th class="${iso === todayIso ? 'pg-today' : ''}">${iso.slice(8, 10)}.${iso.slice(5, 7)}</th>`).join('')}</tr>`;

  const zoneRows = zones
    .filter(({ zone }) => !query || zone.toLowerCase().includes(query)
      || (dp.slots || []).some(slot => slot.from_name === zone && String(slot.customer_name).toLowerCase().includes(query))
      || [...(vehicleDays.get(days[0]) ?? new Map()).entries()].some(([z, b]) => z === zone && b.free.some(v => v.plate.toLowerCase().includes(query))))
    .map(({ zone, money: zm }) => {
      const cells = days.map(iso => {
        const c = cellOf(zone, iso);
        const tone = c.gap > 0 && !c.free ? 'pg-bad' : c.gap > 0 ? 'pg-warn' : '';
        return `<td class="${tone} ${iso === todayIso ? 'pg-today' : ''}"
          title="${zone} · ${iso.slice(8, 10)}.${iso.slice(5, 7)}: сетка ${c.planned}, вышло ${c.started}, заявок без ТС ${c.unassigned}, свободно машин ${c.free}">
          ${c.gap >= 0.05 ? `<b class="pg-gap">▲${fmtGap(c.gap)}</b>` : ''}
          ${c.free ? `<span class="pg-free">🚛${c.free}</span>` : ''}
          ${moneyVisible && c.income ? `<small class="pg-money">${shortMoney(c.income)}</small>` : ''}
        </td>`;
      }).join('');
      const opened = open.has(zone);
      let detail = '';
      if (opened) {
        const zoneSlots = (dp.slots || []).filter(slot => slot.from_name === zone);
        const byCustomer = new Map();
        zoneSlots.forEach(slot => {
          if (!byCustomer.has(slot.customer_name)) byCustomer.set(slot.customer_name, []);
          byCustomer.get(slot.customer_name).push(slot);
        });
        const custRows = [...byCustomer.entries()].map(([name, slots]) => {
          const cell = days.map(iso => {
            const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
            const plan = slots.filter(s => s.weekday === wd).reduce((sum, s) => sum + Number(s.per_day || 0), 0);
            const fact = (fp.trips || []).filter(t => t.customer_name === name && t.from_name === zone &&
              String(t.starts_at).slice(0, 10) === iso).length;
            const cls = !plan ? '' : fact >= plan ? 'pg-ok' : iso <= todayIso ? 'pg-bad' : 'pg-warn';
            return `<td class="${cls} ${iso === todayIso ? 'pg-today' : ''}">${plan ? `${fact}/${plan}` : fact || ''}</td>`;
          }).join('');
          const seg = dp.segments?.[name]?.segment;
          return `<tr class="pg-cust"><td class="pg-zone">↳ ${escapeHtml(name)}${seg ? ` <span class="badge">${seg}</span>` : ''}</td>${cell}</tr>`;
        }).join('');
        const vehRows = days.length ? (() => {
          const todayBuckets = vehicleDays.get(days[0] <= todayIso && days.includes(todayIso) ? todayIso : days[0]);
          const bucket = todayBuckets?.get(zone);
          if (!bucket) return '';
          const list = bucket.free.slice(0, 12).map(vehicle =>
            `<span class="pg-veh" title="${escapeHtml(vehicle.driver_name || 'без водителя')}">🆓 ${escapeHtml(vehicle.plate)}</span>`).join(' ');
          return `<tr class="pg-cust"><td class="pg-zone">↳ машины зоны</td>
            <td colspan="${days.length}" class="pg-vehcell">${list || '<span class="muted">свободных сейчас нет</span>'}
            <small class="muted">· всего в зоне ${bucket.total}</small></td></tr>`;
        })() : '';
        detail = custRows + vehRows;
      }
      return `<tr class="pg-row" data-zone="${escapeHtml(zone)}">
        <td class="pg-zone"><b>${opened ? '▾' : '▸'} ${escapeHtml(zone)}</b>
          ${moneyVisible && zm ? `<small class="pg-money">${shortMoney(zm)}</small>` : ''}</td>
        ${cells}</tr>${detail}`;
    }).join('');

  // Баланс парка по дням — закреплён внизу.
  const balanceRow = `<tr class="pg-balance"><td class="pg-zone"><b>Баланс парка</b></td>${days.map(iso => {
    let gap = 0, free = 0, income = 0;
    for (const { zone } of zones) {
      const c = cellOf(zone, iso);
      gap += c.gap; free += c.free; income += c.income;
    }
    const tone = gap > free ? 'pg-bad' : gap >= 0.05 ? 'pg-warn' : '';
    return `<td class="${tone} ${iso === todayIso ? 'pg-today' : ''}">▲${fmtGap(gap)} · 🚛${free}
      ${moneyVisible && income ? `<small class="pg-money">${shortMoney(income)}</small>` : ''}</td>`;
  }).join('')}</tr>`;

  const savedScrolls = captureScrolls(container);
  const html = `<div class="bi-page pg-page">
    <div class="bi-kpis bi-kpis-row">
      <div class="metric dept-log"><span class="l">Экран-объединение</span>
        <span class="v">3→1</span><span class="d">План вывоза · План парка · Потоки</span></div>
      <div class="segmented" id="pgHorizon">
        <button data-h="week" class="${horizon === 'week' ? 'active' : ''}">Неделя</button>
        <button data-h="month" class="${horizon === 'month' ? 'active' : ''}">Месяц</button>
      </div>
      <input id="pgSearch" class="block-search" placeholder="Поиск: зона, клиент, борт" value="${escapeHtml(state.prografikQuery || '')}">
      <span class="muted" style="margin-left:auto">этап 1 — каркас; подбор в ячейке и черновик «что если» — следующие этапы.
        Старые вкладки живут как прежде.</span>
    </div>
    <section class="section"><div class="sec-b pg-wrap">
      <table class="pg-table"><thead>${headRow}</thead>
        <tbody>${zoneRows || '<tr><td class="muted" style="padding:14px">Нет данных за период</td></tr>'}</tbody>
        <tfoot>${balanceRow}</tfoot></table>
    </div></section></div>`;
  if (!renderInto(container, html)) { restoreScrolls(container, savedScrolls); return; }
  restoreScrolls(container, savedScrolls);

  container.querySelector('#pgHorizon').onclick = event => {
    const button = event.target.closest('[data-h]');
    if (!button) return;
    state.prografikHorizon = button.dataset.h;
    renderPrografik(container, context);
  };
  attachSearch(container.querySelector('#pgSearch'), value => {
    state.prografikQuery = value;
    return renderPrografik(container, context);
  });
  container.querySelectorAll('tr.pg-row').forEach(row => row.addEventListener('click', () => {
    const zone = row.dataset.zone;
    if (open.has(zone)) open.delete(zone); else open.add(zone);
    renderPrografik(container, context);
  }));
}
