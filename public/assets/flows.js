// «🔀 Потоки» — управление потоками парка по геозонам: отдельный дашборд
// из плашек-зон. Цель — количественно видеть, сколько и каких ТС направить
// в каждую зону, чтобы закрыть потребности клиентов. Источники: заявки
// (потребность логиста), сетка плана вывоза (потребность продаж — заявки,
// которых ещё нет), рейсы и текущее состояние сцепок (ресурс).
import { api, escapeHtml, money, rangePickerHtml, wireRangePicker, toast } from './api.js';
import { vehicleZoneAt, vehicleFreeAt } from './transfer.js';
import { customerCardDialog } from './customer-card.js';

const DAY = 86_400_000;
const dayIso = ms => new Date(ms).toISOString().slice(0, 10);
const fmtD = value => new Date(value).toLocaleDateString('ru-RU',
  { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' });
const fmtDt = value => new Date(value).toLocaleString('ru-RU',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

// Незакрытая сетка зоны за период: план слотов по дням недели минус уже
// внесённые заявки (facts) — потребность, под которую заявок ещё нет.
function gridGapForZone(plan, zoneId, fromMs, toMs) {
  if (!plan?.slots?.length) return 0;
  const monthStart = Date.parse(`${plan.month}-01T00:00:00Z`);
  let gap = 0;
  const byLeg = new Map();
  for (const slot of plan.slots) {
    if (slot.from_zone_id !== zoneId) continue;
    const key = `${slot.customer_name}|${slot.from_zone_id}|${slot.to_zone_id}`;
    if (!byLeg.has(key)) byLeg.set(key, new Array(7).fill(0));
    byLeg.get(key)[slot.weekday] = slot.per_day;
  }
  for (let ms = Math.max(fromMs, monthStart); ms < toMs; ms += DAY) {
    const day = Math.floor((ms - monthStart) / DAY) + 1;
    if (day < 1 || day > plan.daysInMonth) continue;
    const weekday = (plan.firstWeekday + day - 1) % 7;
    for (const [key, week] of byLeg) {
      const planned = week[weekday] || 0;
      if (!planned) continue;
      const fact = plan.facts[`${key}|${day}`]?.n || 0;
      gap += Math.max(0, planned - fact);
    }
  }
  return Math.round(gap);
}

// Расчёт плашек: по каждой зоне потребности, ресурс и баланс за период.
export function zoneFlows(data, plans, fromIso, toIso, nowMs = Date.now()) {
  const fromMs = Date.parse(`${fromIso}T00:00:00Z`);
  const toMs = Date.parse(`${toIso}T00:00:00Z`) + DAY;
  const zones = (data.reference?.zones || []);
  const trips = (data.trips || []).filter(trip => trip.status !== 'rejected');
  const orders = (data.orders || []).filter(order =>
    !['cancelled', 'rejected'].includes(order.status));
  const workVehicles = (data.vehicles || []).filter(vehicle => vehicle.status === 'work');

  // Машина «направлена» — у неё есть будущий план-рейс: ресурсом не считаем.
  const plannedVehicle = new Set(trips
    .filter(trip => trip.status === 'plan' && Date.parse(trip.starts_at) >= nowMs)
    .map(trip => trip.vehicle_id));

  return zones.map(zone => {
    const zoneOrders = orders.filter(order => order.from_zone_id === zone.id &&
      Date.parse(order.window_from) < toMs && Date.parse(order.window_to) > fromMs);
    const noVehicle = zoneOrders.filter(order => !order.trip_id);
    const gridGap = (plans || []).reduce((sum, plan) =>
      sum + gridGapForZone(plan, zone.id, fromMs, toMs), 0);

    // Ресурс: свободные в зоне без будущего плана + приезжающие в периоде.
    // Свободна — уже СЕЙЧАС (vehicleFreeAt ≤ now): машина в пути считается
    // не здесь, а в «приедут», иначе она задваивалась бы в обоих списках.
    const freeNow = workVehicles.filter(vehicle =>
      !plannedVehicle.has(vehicle.id) &&
      vehicleZoneAt(data, vehicle.id, nowMs) === zone.name &&
      vehicleFreeAt(data, vehicle.id, nowMs) <= nowMs);
    const arriving = trips
      .filter(trip => ['plan', 'run'].includes(trip.status) && trip.to_zone_id === zone.id &&
        Date.parse(trip.ends_at) >= Math.max(fromMs, nowMs) && Date.parse(trip.ends_at) < toMs)
      .map(trip => ({ trip, hasNext: trips.some(next => next.vehicle_id === trip.vehicle_id &&
        next.status === 'plan' && next.id !== trip.id &&
        Date.parse(next.starts_at) >= Date.parse(trip.ends_at)) }))
      .sort((a, b) => a.trip.ends_at.localeCompare(b.trip.ends_at));
    const arrivingFree = arriving.filter(item => !item.hasNext);

    // Потоки: откуда приезжают и куда уезжают (счётчики по зонам).
    const zoneNameOf = id => zones.find(item => item.id === id)?.name || '?';
    const inbound = {};
    for (const item of arriving) {
      const name = zoneNameOf(item.trip.from_zone_id);
      inbound[name] = (inbound[name] || 0) + 1;
    }
    const outbound = {};
    for (const trip of trips) {
      if (trip.from_zone_id !== zone.id || !['plan', 'run'].includes(trip.status)) continue;
      const starts = Date.parse(trip.starts_at);
      if (starts < fromMs || starts >= toMs) continue;
      const name = zoneNameOf(trip.to_zone_id);
      outbound[name] = (outbound[name] || 0) + 1;
    }

    const customers = {};
    for (const order of zoneOrders) {
      const c = customers[order.customer_name] = customers[order.customer_name]
        || { n: 0, noVeh: 0, sumVat: 0 };
      c.n += 1;
      c.sumVat += order.rate_vat || 0;
      if (!order.trip_id) c.noVeh += 1;
    }

    const need = noVehicle.length + gridGap;
    const supply = freeNow.length + arrivingFree.length;
    return { zone, noVehicle, ordersTotal: zoneOrders.length,
      sumVat: zoneOrders.reduce((sum, order) => sum + (order.rate_vat || 0), 0),
      gridGap, freeNow, arriving, arrivingFree, inbound, outbound,
      customers: Object.entries(customers).sort((a, b) => b[1].n - a[1].n),
      need, supply, balance: supply - need };
  }).filter(tile => tile.need || tile.supply || tile.arriving.length || tile.ordersTotal)
    .sort((a, b) => a.balance - b.balance);
}

// Планы вывоза на месяцы периода (обычно один, на стыке месяцев — два).
async function loadPlans(fromIso, toIso) {
  const months = [...new Set([fromIso.slice(0, 7), toIso.slice(0, 7)])];
  const plans = [];
  for (const month of months) {
    try { plans.push(await api(`/api/delivery-plan?month=${month}`)); }
    catch { /* сетка недоступна — потоки считаются по заявкам */ }
  }
  return plans;
}

const balanceBadge = tile => tile.balance < 0
  ? `<span class="badge bad" title="Потребности минус доступный ресурс">➕ направить ${-tile.balance} ТС</span>`
  : tile.balance > 0
    ? `<span class="badge" style="background:color-mix(in srgb, var(--teal) 22%, transparent)"
        title="Свободный ресурс сверх потребностей — грузы сюда или перегон">профицит ${tile.balance} ТС</span>`
    : '<span class="badge ok">✓ закрыто</span>';

const vehicleRow = (vehicle, note) => `<div class="list-item" data-fv="${vehicle.id}" style="cursor:pointer">
  <b class="mono">${escapeHtml(vehicle.plate)}</b>
  <span class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(vehicle.driver_name || '')}</span>
  ${note || ''}</div>`;

const orderRow = order => `<div class="list-item" data-fo="${order.id}" style="cursor:pointer"
    title="Открыть назначение ТС">
  <span style="flex:1;min-width:0">${escapeHtml(order.customer_name)}
    <small class="muted" style="display:block">${escapeHtml((order.to_point || order.to_name || '').slice(0, 36))}
      · окно ${fmtD(order.window_from)}</small></span>
  <b>${money(order.rate_vat)}</b></div>`;

const arrivingRow = item => `<div class="list-item" data-ft="${item.trip.id}" style="cursor:pointer"
    title="Карточка рейса">
  <b class="mono">${escapeHtml(item.trip.vehicle_plate || '')}</b>
  <span class="muted" style="flex:1">приедет ${fmtDt(item.trip.ends_at)}</span>
  ${item.hasNext ? '<span class="badge" title="Следующий рейс уже назначен">⏭ занята</span>'
    : '<span class="badge warn" title="Следующий рейс не назначен — доступный ресурс">свободна</span>'}</div>`;

function tileHtml(tile, limit = 3) {
  const flowLine = Object.entries(tile.inbound).map(([name, n]) => `из ${name} ${n}`).join(', ');
  const outLine = Object.entries(tile.outbound).map(([name, n]) => `в ${name} ${n}`).join(', ');
  return `<div class="scol flow-tile">
    <div class="scolh" data-fz="${tile.zone.id}" style="cursor:pointer"
        title="Открыть зону целиком: все ТС, заявки и заказчики">
      ${escapeHtml(tile.zone.name)} ${balanceBadge(tile)}
      <small class="muted" style="font-weight:400">· заявок ${tile.ordersTotal} на ${money(tile.sumVat)}</small>
    </div>
    ${tile.noVehicle.length ? `<div class="flow-sec"><b>⚠ Без ТС: ${tile.noVehicle.length}</b>
      <div class="list">${tile.noVehicle.slice(0, limit).map(orderRow).join('')}</div>
      ${tile.noVehicle.length > limit ? `<small class="muted">… ещё ${tile.noVehicle.length - limit} — клик по заголовку зоны</small>` : ''}</div>` : ''}
    ${tile.gridGap ? `<div class="flow-sec muted" title="План вывоза: слоты сетки, под которые заявки ещё не внесены">
      🕳 Сетка не закрыта: ~${tile.gridGap} рейс.</div>` : ''}
    ${tile.freeNow.length ? `<div class="flow-sec"><b>🚛 Свободны в зоне: ${tile.freeNow.length}</b>
      <div class="list">${tile.freeNow.slice(0, limit).map(vehicle => vehicleRow(vehicle)).join('')}</div>
      ${tile.freeNow.length > limit ? `<small class="muted">… ещё ${tile.freeNow.length - limit}</small>` : ''}</div>` : ''}
    ${tile.arriving.length ? `<div class="flow-sec"><b>📥 Приедут: ${tile.arriving.length}</b>
      ${flowLine ? `<small class="muted"> (${escapeHtml(flowLine)})</small>` : ''}
      <div class="list">${tile.arriving.slice(0, limit).map(arrivingRow).join('')}</div>
      ${tile.arriving.length > limit ? `<small class="muted">… ещё ${tile.arriving.length - limit}</small>` : ''}</div>` : ''}
    ${outLine ? `<div class="flow-sec muted">📤 Уезжают: ${escapeHtml(outLine)}</div>` : ''}
    ${tile.customers.length ? `<div class="flow-sec"><b>👤 Заказчики</b>
      <div class="list">${tile.customers.slice(0, limit).map(([name, c]) => `
        <div class="list-item" data-fc="${escapeHtml(name)}" style="cursor:pointer" title="Карточка клиента">
          <span style="flex:1;min-width:0">${escapeHtml(name.slice(0, 30))}</span>
          <span class="muted">${c.n}${c.noVeh ? ` · без ТС ${c.noVeh}` : ''}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

function zoneDialog(tile, context) {
  context.showModal(`<h2>${escapeHtml(tile.zone.name)} ${balanceBadge(tile)}</h2>
    <p class="muted">Потребности: без ТС ${tile.noVehicle.length}${tile.gridGap ? ` + сетка ~${tile.gridGap}` : ''}
      · ресурс: свободны ${tile.freeNow.length} + освободятся ${tile.arrivingFree.length}
      (приедут всего ${tile.arriving.length})</p>
    <div class="salesboard">
      <div class="scol"><div class="scolh">⚠ Заявки без ТС <span>${tile.noVehicle.length}</span></div>
        <div class="list">${tile.noVehicle.map(orderRow).join('') || '<p class="muted">нет</p>'}</div>
        <div class="scolh" style="margin-top:8px">👤 Заказчики периода</div>
        <div class="list">${tile.customers.map(([name, c]) => `
          <div class="list-item" data-fc="${escapeHtml(name)}" style="cursor:pointer">
            <span style="flex:1">${escapeHtml(name)}</span>
            <span class="muted">${c.n} заяв. · ${money(c.sumVat)}</span></div>`).join('') || '<p class="muted">нет</p>'}</div></div>
      <div class="scol"><div class="scolh">🚛 Свободны в зоне <span>${tile.freeNow.length}</span></div>
        <div class="list">${tile.freeNow.map(vehicle => vehicleRow(vehicle)).join('') || '<p class="muted">нет</p>'}</div>
        <div class="scolh" style="margin-top:8px">📥 Приедут в периоде <span>${tile.arriving.length}</span></div>
        <div class="list">${tile.arriving.map(arrivingRow).join('') || '<p class="muted">нет</p>'}</div></div>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');
}

export async function renderFlows(container, context) {
  const state = context.state;
  const data = state.data;
  if (!state.flowsFrom) {
    state.flowsFrom = dayIso(Date.now());
    state.flowsTo = dayIso(Date.now() + 2 * DAY);
  }
  container.innerHTML = '<div class="empty-state">Считаю потоки…</div>';
  const plans = await loadPlans(state.flowsFrom, state.flowsTo);
  const tiles = zoneFlows(data, plans, state.flowsFrom, state.flowsTo);
  const deficit = tiles.filter(tile => tile.balance < 0);
  const surplus = tiles.filter(tile => tile.balance > 0);

  container.innerHTML = `<div class="salesfilter" style="margin-bottom:8px;flex-wrap:wrap;gap:6px">
      <b style="margin-right:4px">🔀 Потоки</b>
      ${rangePickerHtml('flowsFrom', 'flowsTo', state.flowsFrom, state.flowsTo, 'период')}
      <button type="button" class="button ghost small" data-flow-preset="0">Сегодня</button>
      <button type="button" class="button ghost small" data-flow-preset="2">3 дня</button>
      <button type="button" class="button ghost small" data-flow-preset="6">Неделя</button>
      <span class="muted" style="margin-left:auto">
        ${deficit.length ? `дефицит: <b>${deficit.map(tile => `${tile.zone.name} ${-tile.balance}`).join(' · ')}</b>` : 'дефицита нет'}
        ${surplus.length ? ` · профицит: ${surplus.map(tile => `${tile.zone.name} +${tile.balance}`).join(' · ')}` : ''}
      </span>
    </div>
    <div class="flow-grid">${tiles.map(tile => tileHtml(tile)).join('')
      || '<p class="muted">В выбранном периоде нет ни потребностей, ни движения парка.</p>'}</div>`;

  wireRangePicker(container, 'flowsFrom', 'flowsTo', (from, to) => {
    state.flowsFrom = from;
    state.flowsTo = to;
    renderFlows(container, context);
  });
  container.querySelectorAll('[data-flow-preset]').forEach(button =>
    button.addEventListener('click', () => {
      state.flowsFrom = dayIso(Date.now());
      state.flowsTo = dayIso(Date.now() + Number(button.dataset.flowPreset) * DAY);
      renderFlows(container, context);
    }));

  // Все клики — делегированием: плашки перерисовываются целиком.
  container.onclick = event => {
    const zoneEl = event.target.closest('[data-fz]');
    const orderEl = event.target.closest('[data-fo]');
    const tripEl = event.target.closest('[data-ft]');
    const vehEl = event.target.closest('[data-fv]');
    const custEl = event.target.closest('[data-fc]');
    if (orderEl) {
      const order = data.orders.find(item => item.id === orderEl.dataset.fo);
      if (order) context.openAssign(order);
      return;
    }
    if (tripEl) {
      const trip = data.trips.find(item => item.id === tripEl.dataset.ft);
      if (trip) context.openTrip(trip);
      return;
    }
    if (vehEl) {
      // Последний рейс машины — быстрый контекст «откуда она здесь».
      const last = (data.trips || []).filter(trip => trip.vehicle_id === vehEl.dataset.fv &&
        trip.status !== 'rejected').sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      if (last) context.openTrip(last);
      else toast('У машины нет рейсов — карточка в блоке «Ресурс»');
      return;
    }
    if (custEl) { customerCardDialog(custEl.dataset.fc, context); return; }
    if (zoneEl) {
      const tile = tiles.find(item => item.zone.id === zoneEl.dataset.fz);
      if (tile) zoneDialog(tile, context);
    }
  };
}
