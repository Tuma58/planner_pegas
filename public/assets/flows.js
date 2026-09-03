// «🔀 Потоки» — управление потоками парка по геозонам: отдельный дашборд
// из плашек-зон. Цель — количественно видеть, сколько и каких ТС направить
// в каждую зону, чтобы закрыть потребности клиентов. Источники: заявки
// (потребность логиста), сетка плана вывоза (потребность продаж — заявки,
// которых ещё нет), рейсы и текущее состояние сцепок (ресурс).
import { api, driverRatingBadge, driverRatingOf, escapeHtml, money, rangePickerHtml, wireRangePicker, toast } from './api.js';
import { vehicleZoneAt, vehicleFreeAt } from './transfer.js';
import { customerCardDialog } from './customer-card.js';
import { orderStage } from './pipeline.js';
import { matchVehicles } from './sales.js';
import { roundByKey } from './rounds.js';

// Круг машины из «Плана парка»: бейдж «🎡 К1» — предупреждение, что машина
// закреплена за маятником и её плечи расписаны (с866ко58 на К1 предлагалась
// черноземским заявкам без пометки).
const ROUND_LABEL = { k1: 'К1', k2: 'К2', k2p: 'К2п', k3: 'К3', k4a: 'К4а',
  k4b: 'К4б', k5: 'К5', k6: 'К6', k7: 'К7', k8: 'К8' };
const roundOfVehicle = (data, vehicleId) =>
  (data.roundPlans || []).find(item => item.vehicle_id === vehicleId)?.round_key || null;
const roundBadge = roundKey => roundKey
  ? `<span class="badge" title="Закреплена за кругом ${ROUND_LABEL[roundKey] || roundKey} в Плане парка — направлять в другое плечо только осознанно">🎡 ${ROUND_LABEL[roundKey] || roundKey}</span>`
  : '';
// Плечо заявки входит в круг машины? Сверяем зоны плеча с legs шаблона.
const legFitsRound = (roundKey, fromName, toName) => {
  const round = roundByKey(roundKey);
  if (!round) return true;
  return round.legs.some(leg => leg.from === fromName && leg.to === toName);
};

// Совместимость кузовов — правила сервера из bootstrap (единая логика
// автоподбора): тушевозный груз — только тушевозу, 41 паллета не в 33-й.
const bodyMatches = (data, orderBodyType, vehicleTypeName) => {
  const allowed = (data.settings?.bodyCompat || {})[String(orderBodyType || '').trim()];
  return !allowed || allowed.includes(String(vehicleTypeName || '').trim());
};

const DAY = 86_400_000;
const dayIso = ms => new Date(ms).toISOString().slice(0, 10);
const fmtD = value => new Date(value).toLocaleDateString('ru-RU',
  { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' });
const fmtDt = value => new Date(value).toLocaleString('ru-RU',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

// Незакрытая сетка зоны за период: план слотов по дням недели минус уже
// внесённые заявки (facts) — потребность, под которую заявок ещё нет.
// Возвращает и разбивку по клиентам — «потенциальные заказы из сетки».
function gridGapForZone(plan, zoneId, fromMs, toMs) {
  const result = { total: 0, byCustomer: new Map() };
  if (!plan?.slots?.length) return result;
  const monthStart = Date.parse(`${plan.month}-01T00:00:00Z`);
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
      const gap = Math.max(0, planned - (plan.facts[`${key}|${day}`]?.n || 0));
      if (!gap) continue;
      result.total += gap;
      const customer = key.split('|')[0];
      result.byCustomer.set(customer, (result.byCustomer.get(customer) || 0) + gap);
    }
  }
  result.total = Math.round(result.total);
  return result;
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

  // Машина «направлена» — у неё есть будущее задание: план-рейс ИЛИ уже
  // проведённый run-рейс со стартом в будущем (диспетчер выводит заранее —
  // р892ху58 висела «свободна в Урале» при двух назначенных рейсах).
  const plannedVehicle = new Set(trips
    .filter(trip => ['plan', 'run'].includes(trip.status) &&
      Date.parse(trip.starts_at) >= nowMs)
    .map(trip => trip.vehicle_id));

  return zones.map(zone => {
    // Потребность — только ПОДТВЕРЖДЁННЫЕ заявки (stage ≥ 1): черновик
    // продаж без подтверждения — ещё не обязательство перед клиентом.
    // stage 1 = подтверждена без ТС, включая заявки с отклонённым рейсом.
    const zoneOrders = orders.filter(order => order.from_zone_id === zone.id &&
      Date.parse(order.window_from) < toMs && Date.parse(order.window_to) > fromMs &&
      orderStage(order, data).stage >= 1);
    const noVehicle = zoneOrders.filter(order => orderStage(order, data).stage === 1);
    const gridByCustomer = new Map();
    let gridGap = 0;
    for (const plan of plans || []) {
      const gaps = gridGapForZone(plan, zone.id, fromMs, toMs);
      gridGap += gaps.total;
      for (const [customer, gap] of gaps.byCustomer) {
        gridByCustomer.set(customer, (gridByCustomer.get(customer) || 0) + gap);
      }
    }

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
        ['plan', 'run'].includes(next.status) && next.id !== trip.id &&
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
    return { zone, zoneOrders, noVehicle, ordersTotal: zoneOrders.length,
      sumVat: zoneOrders.reduce((sum, order) => sum + (order.rate_vat || 0), 0),
      gridGap, gridByCustomer, freeNow, arriving, arrivingFree, inbound, outbound,
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

const arrivingRow = (item, data) => `<div class="list-item" data-ft="${item.trip.id}" style="cursor:pointer"
    title="Карточка рейса">
  <b class="mono">${escapeHtml(item.trip.vehicle_plate || '')}</b>
  <span class="muted" style="flex:1">приедет ${fmtDt(item.trip.ends_at)}</span>
  ${data ? roundBadge(roundOfVehicle(data, item.trip.vehicle_id)) : ''}
  ${item.hasNext ? '<span class="badge" title="Следующее задание уже назначено (план или проведённый рейс)">⏭ есть задание</span>'
    : '<span class="badge warn" title="Следующего задания нет — доступный ресурс, назначить до прибытия">⚠ без задания</span>'}</div>`;

// Плашка — только счётчики, чтобы не замыливался глаз. Каждая строка —
// своя вкладка окна зоны: зона → субъекты, рейсы → список заявок,
// клиенты → клиенты + потенциал сетки, ТС → в зоне и направленные,
// направить → подбор по логике автоназначения.
function tileHtml(tile) {
  const toSend = Math.max(0, -tile.balance);
  return `<div class="scol flow-tile" data-fz="${tile.zone.id}">
    <div class="scolh" data-fz-tab="subjects" style="cursor:pointer"
      title="Субъекты РФ и города зоны">${escapeHtml(tile.zone.name)} ${balanceBadge(tile)}</div>
    <div class="flow-kv" data-fz-tab="orders" style="cursor:pointer" title="Все подтверждённые заявки периода">
      📦 Рейсов: <b>${tile.ordersTotal}</b>${tile.noVehicle.length
      ? ` <span class="danger">(без ТС ${tile.noVehicle.length})</span>` : ''}
      ${tile.gridGap ? `<span class="muted" title="План вывоза: слоты сетки без внесённых заявок"> + сетка ~${tile.gridGap}</span>` : ''}</div>
    <div class="flow-kv" data-fz-tab="customers" style="cursor:pointer" title="Клиенты зоны и потенциал сетки">
      👤 Клиентов: <b>${tile.customers.length}</b>
      <span class="muted">${escapeHtml(tile.customers.slice(0, 2).map(([name]) => name.slice(0, 14)).join(', '))}${tile.customers.length > 2 ? '…' : ''}</span></div>
    <div class="flow-kv" data-fz-tab="vehicles" style="cursor:pointer" title="ТС в зоне и направленные в зону">
      🚛 ТС в зоне: <b>${tile.freeNow.length}</b>
      · будут: <b>${tile.arriving.length}</b>${tile.arriving.length !== tile.arrivingFree.length
        ? `<span class="muted" title="Приезжают без следующего задания — доступный ресурс"> (без задания ${tile.arrivingFree.length})</span>` : ''}</div>
    <div class="flow-kv" data-fz-tab="send" style="cursor:pointer"
      title="Подбор ТС на незакрытые заявки — по логике автоназначения, с учётом кузова">
      ${toSend ? `➕ Направить: <b class="danger">${toSend}</b>`
      : tile.balance > 0 ? `Свободный ресурс: <b>+${tile.balance}</b> — нужны грузы`
      : '✓ Зона закрыта'}</div>
  </div>`;
}

// Вкладка «Направить»: заявки без ТС + кандидаты по логике автоназначения —
// ночной черновик подбора первым, затем matchVehicles с фильтром кузова.
function sendTabHtml(tile, data) {
  if (!tile.noVehicle.length) {
    return `<p class="muted">Незакрытых заявок нет.${tile.balance > 0
      ? ` Свободный ресурс +${tile.balance} — сюда нужны грузы (задача продаж).` : ''}</p>`;
  }
  const addressById = id => id ? (data.reference.addresses || []).find(item => item.id === id) : null;
  return tile.noVehicle.map(order => {
    const draft = (data.assignDrafts || []).find(item => item.order_id === order.id);
    const candidates = matchVehicles(data, order.from_name, order.window_from,
      addressById(order.from_address_id))
      .filter(item => bodyMatches(data, order.body_type, item.vehicle.type_name))
      .filter(item => !draft || item.vehicle.id !== draft.vehicle_id)
      .map(item => ({ ...item, round: roundOfVehicle(data, item.vehicle.id) }))
      // Машины, закреплённые за ЧУЖИМ кругом, — в конец: их плечи расписаны.
      .sort((a, b) =>
        Number(Boolean(a.round) && !legFitsRound(a.round, order.from_name, order.to_name))
        - Number(Boolean(b.round) && !legFitsRound(b.round, order.from_name, order.to_name)))
      .slice(0, 3);
    const candidateRow = (plate, typeName, note, extra) => `
      <div class="list-item"><b class="mono">${escapeHtml(plate)}</b>
        <span class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${escapeHtml(typeName || '')}${note ? ` · ${note}` : ''}</span>${extra || ''}</div>`;
    return `<div class="flow-send" style="margin-bottom:10px">
      <div class="list-item" data-fo="${order.id}" style="cursor:pointer" title="Открыть назначение ТС">
        <span style="flex:1;min-width:0"><b>${escapeHtml(order.customer_name)}</b>
          <small class="muted" style="display:block">${escapeHtml((order.from_point || order.from_name || '').slice(0, 30))} →
            ${escapeHtml((order.to_point || order.to_name || '').slice(0, 30))}
            · окно ${fmtD(order.window_from)} · ${escapeHtml(order.body_type || 'Реф')}</small></span>
        <b>${money(order.rate_vat)}</b></div>
      <div class="list" style="margin:2px 0 0 14px">
        ${draft ? candidateRow(draft.vehicle_plate, '', `порожняк ${Math.round(draft.empty_km || 0)} км`,
          '<span class="badge ok" title="Рекомендация ночного подбора/стыковки">⚡ подбор</span>') : ''}
        ${candidates.map(item => candidateRow(item.vehicle.plate, item.vehicle.type_name,
          `${escapeHtml(item.zoneName || '')}${item.emptyKm != null ? ` · подгон ~${Math.round(item.emptyKm)} км` : ''}${item.stillRunning ? ' · ещё едет' : ''}`,
          roundBadge(item.round) + driverRatingBadge(driverRatingOf(data, item.vehicle.id), { small: true }))).join('')
          || (draft ? '' : '<p class="muted" style="margin:2px 8px">свободных ТС с подходящим кузовом нет — смотреть соседние зоны</p>')}
      </div>
    </div>`;
  }).join('');
}

const ZONE_TABS = [
  ['subjects', '🗺 Субъекты'], ['orders', '📦 Рейсы'], ['customers', '👤 Клиенты'],
  ['vehicles', '🚛 ТС'], ['send', '➕ Направить']
];

function zoneDialog(tile, context, data, tab = 'subjects') {
  const zoneRef = (data.reference?.zones || []).find(zone => zone.id === tile.zone.id);
  const body = {
    subjects: () => `<p class="muted">Города и субъекты, по которым адреса попадают в зону
        «${escapeHtml(tile.zone.name)}» (справочник алиасов; правится в «Настройки → Геозоны»).</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${(zoneRef?.aliases || [])
        .map(alias => `<span class="badge">${escapeHtml(alias)}</span>`).join('')
        || '<p class="muted">У зоны нет алиасов.</p>'}</div>`,
    orders: () => `<div class="list">${tile.zoneOrders.map(order => {
        const stage = orderStage(order, data);
        return `<div class="list-item" data-fo="${order.id}" style="cursor:pointer"
            title="${stage.stage === 1 ? 'Назначить ТС' : 'Карточка рейса'}">
          <span style="flex:1;min-width:0">${escapeHtml(order.customer_name)}
            <small class="muted" style="display:block">${escapeHtml((order.from_point || order.from_name || '').slice(0, 28))} →
              ${escapeHtml((order.to_point || order.to_name || '').slice(0, 28))}
              · окно ${fmtD(order.window_from)} · ${escapeHtml(order.body_type || 'Реф')}</small></span>
          ${stage.stage === 1 ? '<span class="badge bad">⚠ без ТС</span>'
            : `<span class="badge"><b class="mono">${escapeHtml(stage.plate || '')}</b></span>`}
          <b>${money(order.rate_vat)}</b></div>`;
      }).join('') || '<p class="muted">Подтверждённых заявок в периоде нет.</p>'}</div>`,
    customers: () => {
      const names = new Set([...tile.customers.map(([name]) => name), ...tile.gridByCustomer.keys()]);
      return `<div class="list">${[...names].map(name => {
        const c = tile.customers.find(([n]) => n === name)?.[1];
        const potential = Math.round(tile.gridByCustomer.get(name) || 0);
        return `<div class="list-item" data-fc="${escapeHtml(name)}" style="cursor:pointer" title="Карточка клиента">
          <span style="flex:1;min-width:0">${escapeHtml(name)}</span>
          <span class="muted">${c ? `${c.n} заяв.${c.noVeh ? ` (без ТС ${c.noVeh})` : ''} · ${money(c.sumVat)}` : 'заявок нет'}</span>
          ${potential ? `<span class="badge warn" title="Слоты сетки плана вывоза за период, под которые заявки ещё не внесены">потенциал +${potential}</span>` : ''}</div>`;
      }).join('') || '<p class="muted">Клиентов в периоде нет.</p>'}</div>`;
    },
    vehicles: () => `<div class="scolh">🚛 В зоне сейчас <span>${tile.freeNow.length}</span></div>
      <div class="list">${tile.freeNow.map(vehicle =>
        vehicleRow(vehicle, roundBadge(roundOfVehicle(data, vehicle.id)))).join('') || '<p class="muted">нет</p>'}</div>
      <div class="scolh" style="margin-top:8px">📥 Направлены в зону (приедут в периоде) <span>${tile.arriving.length}</span></div>
      <div class="list">${tile.arriving.map(item => arrivingRow(item, data)).join('') || '<p class="muted">нет</p>'}</div>`,
    send: () => sendTabHtml(tile, data)
  };
  context.showModal(`<h2>${escapeHtml(tile.zone.name)} ${balanceBadge(tile)}</h2>
    <div class="salesfilter" style="margin:6px 0 10px;flex-wrap:wrap">
      ${ZONE_TABS.map(([key, label]) => `<button type="button"
        class="button small ${key === tab ? '' : 'ghost'}" data-fz-dialog-tab="${key}">${label}</button>`).join('')}
    </div>
    <div style="max-height:62vh;overflow:auto">${body[tab] ? body[tab]() : ''}</div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');
  // Модалка живёт вне контейнера вкладки — клики по заявкам/ТС/клиентам
  // обрабатываются здесь же (заявка → назначение, рейс → карточка).
  document.getElementById('modalRoot').querySelector('.modal').onclick = event => {
    const tabEl = event.target.closest('[data-fz-dialog-tab]');
    const orderEl = event.target.closest('[data-fo]');
    const tripEl = event.target.closest('[data-ft]');
    const vehEl = event.target.closest('[data-fv]');
    const custEl = event.target.closest('[data-fc]');
    if (tabEl) {
      zoneDialog(tile, context, data, tabEl.dataset.fzDialogTab);
    } else if (orderEl) {
      const order = data.orders.find(item => item.id === orderEl.dataset.fo);
      if (!order) return;
      context.closeModal();
      // Из вкладок: заявка без ТС — в назначение, с рейсом — в карточку.
      if (order.trip_id && orderStage(order, data).stage >= 2) {
        const trip = data.trips.find(item => item.id === order.trip_id);
        if (trip) { context.openTrip(trip); return; }
      }
      context.openAssign(order);
    } else if (tripEl) {
      const trip = data.trips.find(item => item.id === tripEl.dataset.ft);
      if (trip) { context.closeModal(); context.openTrip(trip); }
    } else if (vehEl) {
      const last = (data.trips || []).filter(trip => trip.vehicle_id === vehEl.dataset.fv &&
        trip.status !== 'rejected').sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      if (last) { context.closeModal(); context.openTrip(last); }
    } else if (custEl) {
      context.closeModal();
      customerCardDialog(custEl.dataset.fc, context);
    }
  };
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
    <div class="flow-grid" style="--flow-cols:${Math.max(2, Math.ceil(tiles.length / 2))}">${
      tiles.map(tile => tileHtml(tile)).join('')
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
      const tab = event.target.closest('[data-fz-tab]')?.dataset.fzTab || 'subjects';
      if (tile) zoneDialog(tile, context, data, tab);
    }
  };
}
