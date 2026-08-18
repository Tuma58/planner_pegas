// «Конструктор маршрутов»: кольцевые цепочки заявок от субъекта базирования
// ТС и обратно, с живой экономикой к плановой выручке в сутки (48 000 ₽ —
// настройка каждого маршрута). Полуавтомат: «🧮 Собрать» предлагает цепочку
// из свободных потребностей, дальше — ручная правка. Готовый маршрут
// передаётся логисту и назначается на сцепку целиком (рейсы цепочкой).
import { api, escapeHtml, formatDateTime, money, toast, transitHours , wireSelectSearch } from './api.js';
import { orderStage } from './pipeline.js';
import { orderNet, plannedKmBetween, regionOfPlace, resolveAddress } from './sales.js';

const DAY_MS = 86_400_000;
const HOME_REGION = 'Пензенская обл';

const addressById = (data, id) =>
  id ? (data.reference.addresses || []).find(item => item.id === id) : null;

// Точка заявки: адрес из справочника (координаты для км) или резолв по тексту.
const orderFromAddress = (data, order) => addressById(data, order.from_address_id)
  || resolveAddress(data, order.from_point || order.from_name);
const orderToAddress = (data, order) => addressById(data, order.to_address_id)
  || resolveAddress(data, order.to_point || order.to_name);

// Опорная точка субъекта базирования: адрес этого субъекта из справочника.
function basePoint(data, region) {
  const items = (data.reference.addresses || []).filter(item =>
    item.region === region && Number.isFinite(item.latitude));
  return items.find(item => (item.zone_name || '') === 'Дом') || items[0] || null;
}

const orderRegionFrom = (data, order) => addressById(data, order.from_address_id)?.region
  || regionOfPlace(data, order.from_point, order.from_name);
const orderRegionTo = (data, order) => addressById(data, order.to_address_id)?.region
  || regionOfPlace(data, order.to_point, order.to_name);

// Свободные потребности для конструктора: не назначены, не в других
// маршрутах и с ещё открытым окном — просроченные в подбор не встают.
export function freeOrders(data, excludeRouteId = null, afterMs = Date.now()) {
  return (data.orders || []).filter(order => {
    const stage = orderStage(order, data).stage;
    return (stage === 0 || stage === 1) &&
      (!order.route_id || order.route_id === excludeRouteId) &&
      Date.parse(order.window_to) > afterMs;
  });
}

const viaCount = order => {
  try { return (JSON.parse(order.via_json || '[]') || []).length; } catch { return 0; }
};
const legKm = (data, order) => Number(order.planned_km) ||
  plannedKmBetween(orderFromAddress(data, order), orderToAddress(data, order)) || 500;

// Экономика цепочки: гружёные и порожние км, длительность от базы до базы,
// выручка без НДС и рублей в сутки против плана маршрута.
// Порог спота: порожний перегон длиннее — кандидат на поиск попутного груза.
export const SPOT_KM = 150;

export function routeMetrics(data, routeOrders, { baseRegion, plannedStart, targetPerDay }) {
  const calc = data.settings.calculation;
  // Время порожнего перегона — с тем же коэффициентом 1,5 (отдых водителя),
  // что и гружёный транзит, только без грузовых операций.
  const emptyLegMs = km => transitHours(km || 0, calc, 0) * 3_600_000;
  const base = basePoint(data, baseRegion || HOME_REGION);
  let position = base;
  let cursor = plannedStart ? Date.parse(plannedStart) : Date.now();
  const startMs = cursor;
  let loadedKm = 0;
  let emptyKm = 0;
  const legs = [];
  routeOrders.forEach(order => {
    const from = orderFromAddress(data, order);
    const to = orderToAddress(data, order);
    const feed = plannedKmBetween(position, from);
    if (feed != null) emptyKm += feed;
    const km = legKm(data, order);
    loadedKm += km;
    const loadAt = Math.max(cursor + emptyLegMs(feed), Date.parse(order.window_from));
    const unloadAt = loadAt + transitHours(km, calc, 2 + viaCount(order)) * 3_600_000;
    const lateStart = Date.parse(order.window_to) < loadAt;
    legs.push({ order, feed, km, loadAt, unloadAt, lateStart,
      fromRegion: orderRegionFrom(data, order), toRegion: orderRegionTo(data, order),
      feedFromRegion: position?.region || (baseRegion || HOME_REGION), feedAtIso: new Date(cursor).toISOString() });
    cursor = unloadAt;
    position = to || position;
  });
  const returnKm = routeOrders.length ? plannedKmBetween(position, base) : 0;
  if (returnKm != null) emptyKm += returnKm || 0;
  const endMs = cursor + emptyLegMs(returnKm);
  const days = Math.max(0.5, (endMs - startMs) / DAY_MS);
  const revenueNet = routeOrders.reduce((sum, order) => sum + orderNet(order, data), 0);
  const revenueVat = routeOrders.reduce((sum, order) => sum + Number(order.rate_vat || 0), 0);
  const perDay = revenueNet / days;
  const target = Number(targetPerDay) || 48000;
  const lastRegion = routeOrders.length
    ? orderRegionTo(data, routeOrders[routeOrders.length - 1]) : (baseRegion || HOME_REGION);
  return { legs, loadedKm: Math.round(loadedKm), emptyKm: Math.round(emptyKm),
    returnKm: Math.round(returnKm || 0), days, revenueNet, revenueVat, perDay, target,
    targetShare: target ? perDay / target : 0, endMs, lastRegion,
    emptyShare: loadedKm ? emptyKm / (loadedKm + emptyKm) : 0,
    closesAtBase: routeOrders.length
      ? orderRegionTo(data, routeOrders[routeOrders.length - 1]) === (baseRegion || HOME_REGION)
      : false };
}

// Полуавтомат: жадная сборка кольца. Первая заявка — погрузка в базовом
// субъекте, дальше минимальный порожний перегон, замыкание — выгрузкой в базу.
export function buildAutoRoute(data, { startIso, baseRegion, targetPerDay, maxOrders = 4, exclude = new Set() }) {
  const base = basePoint(data, baseRegion);
  const pool = freeOrders(data).filter(order =>
    !exclude.has(order.id) && Date.parse(order.window_to) > Date.parse(startIso));
  const chain = [];
  let position = base;
  let cursor = Date.parse(startIso);
  while (chain.length < maxOrders) {
    const lastLeg = chain.length ? chain[chain.length - 1] : null;
    const candidates = pool
      .filter(order => !chain.includes(order) &&
        Date.parse(order.window_to) > cursor)
      .map(order => {
        const from = orderFromAddress(data, order);
        const feed = plannedKmBetween(position, from);
        return { order, feed: feed ?? 9999,
          fromRegion: orderRegionFrom(data, order), toRegion: orderRegionTo(data, order) };
      })
      .filter(item => chain.length > 0 || item.fromRegion === baseRegion)
      .sort((a, b) => a.feed - b.feed);
    if (!candidates.length) break;
    // Последняя позиция — стараемся замкнуть кольцо выгрузкой в базе.
    const closing = candidates.find(item => item.toRegion === baseRegion);
    const metricsNow = routeMetrics(data, chain.map(l => l), { baseRegion, plannedStart: startIso, targetPerDay });
    const preferClosing = chain.length + 1 >= maxOrders ||
      (chain.length >= 1 && metricsNow.perDay >= (Number(targetPerDay) || 48000));
    const pick = (preferClosing && closing) ? closing : candidates[0];
    chain.push(pick.order);
    const km = legKm(data, pick.order);
    const loadAt = Math.max(
      cursor + transitHours(pick.feed === 9999 ? 0 : pick.feed, data.settings.calculation, 0) * 3_600_000,
      Date.parse(pick.order.window_from));
    cursor = loadAt + transitHours(km, data.settings.calculation, 2 + viaCount(pick.order)) * 3_600_000;
    position = orderToAddress(data, pick.order) || position;
    if (pick.toRegion === baseRegion && chain.length > 1) break;
  }
  return chain.map(order => order.id);
}

const perDayClass = share => share >= 1 ? 'ok' : share >= 0.8 ? 'warn' : 'bad';
const STATUS_LABELS = { draft: 'черновик', handed: 'у логиста', assigned: 'ТС назначено' };

export function renderRoutes(container, context) {
  const { state, can } = context;
  const data = state.data;
  const routes = data.routes || [];
  const ordersOf = routeId => (data.orders || [])
    .filter(order => order.route_id === routeId)
    .sort((a, b) => (a.route_seq || 0) - (b.route_seq || 0));
  const canEdit = can('orders:write') || can('trips:write');

  const regionList = [...new Set((data.reference.addresses || [])
    .map(item => item.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));

  const routeCard = route => {
    const routeOrders = ordersOf(route.id);
    const metrics = routeMetrics(data, routeOrders, {
      baseRegion: route.base_region, plannedStart: route.planned_start,
      targetPerDay: route.target_per_day });
    const chainText = routeOrders.length
      ? [escapeHtml(route.base_region || HOME_REGION),
        ...routeOrders.map(order => escapeHtml(order.to_point || order.to_name))].join(' → ')
      : 'пока пусто — откройте редактор';
    return `<div class="card route-card ${route.status}" data-route="${route.id}">
      <div class="rt-head">
        <b class="rt-no">${escapeHtml(route.route_no)}</b>
        <span class="tt-chip">${STATUS_LABELS[route.status] || route.status}</span>
        ${route.vehicle_plate ? `<span class="tt-chip mono">${escapeHtml(route.vehicle_plate)}</span>` : ''}
        <span class="muted">${escapeHtml(route.base_region || HOME_REGION)}
          · старт ${route.planned_start ? formatDateTime(route.planned_start) : '—'}</span>
        <span class="rt-perday ${perDayClass(metrics.targetShare)}"
          title="Выручка без НДС в сутки против плана ${money(metrics.target)}">
          ${money(Math.round(metrics.perDay))}/сут</span>
      </div>
      <div class="rt-chain">${chainText}${metrics.closesAtBase ? ' 🏁' : routeOrders.length
        ? ' <span class="danger" title="Последняя выгрузка не в субъекте базирования">⚠ не замкнут</span>' : ''}</div>
      <div class="rt-nums">
        <span>заявок <b>${routeOrders.length}</b></span>
        <span>гружёные <b>${metrics.loadedKm}</b> км</span>
        <span>порожние <b>${metrics.emptyKm}</b> км${metrics.emptyShare > 0.3
          ? ` <span class="danger" title="Доля порожних км — ищите спот на пустые плечи в редакторе">⚠ ${Math.round(metrics.emptyShare * 100)}%</span>` : ''}</span>
        <span>~<b>${metrics.days.toFixed(1)}</b> сут</span>
        <span>без НДС <b>${money(Math.round(metrics.revenueNet))}</b></span>
      </div>
      <div class="rt-actions">
        ${canEdit && route.status !== 'assigned' ? `<button class="button ghost small" data-edit-route="${route.id}">✎ Редактор</button>` : ''}
        ${canEdit && route.status === 'draft' ? `<button class="button small" data-hand-route="${route.id}"
          title="Маршрут уйдёт логисту на назначение ТС">→ Логисту</button>` : ''}
        ${can('trips:write') && route.status !== 'assigned' && routeOrders.length ? `<button class="button small" data-assign-route="${route.id}"
          title="Назначить сцепку на весь маршрут: рейсы создадутся цепочкой">Назначить ТС</button>` : ''}
        ${canEdit && route.status === 'handed' ? `<button class="button ghost small" data-return-route="${route.id}">↩ Вернуть</button>` : ''}
        ${canEdit && route.status !== 'assigned' ? `<button class="button ghost small danger" data-delete-route="${route.id}">✕</button>` : ''}
      </div>
    </div>`;
  };

  container.innerHTML = `<div class="saleswrap">
    <div class="salekpis">
      <div class="skpi"><span class="skl">Маршрутов в работе</span><span class="skv">${routes.length}</span></div>
      <div class="skpi"><span class="skl">Черновики</span><span class="skv">${routes.filter(r => r.status === 'draft').length}</span></div>
      <div class="skpi"><span class="skl">У логиста</span><span class="skv">${routes.filter(r => r.status === 'handed').length}</span></div>
      <div class="skpi"><span class="skl">Свободных заявок</span><span class="skv">${freeOrders(data).length}</span></div>
      <div class="salesfilter" style="flex:1;min-width:260px">
        ${canEdit ? `<button class="button" id="routeAuto"
          title="Полуавтомат: соберёт кольцо из свободных потребностей — от базы до базы, к плановой выручке">🧮 Собрать маршрут</button>
        <button class="button ghost small" id="routeBlank">+ Пустой</button>` : ''}
      </div>
    </div>
    <div class="salesboard">
      <div class="scol">
        <div class="scolh">Маршруты <span>${routes.length}</span></div>
        <div class="list">${routes.map(routeCard).join('')
          || '<p class="muted">Маршрутов пока нет — соберите первый: «🧮 Собрать маршрут».</p>'}</div>
      </div>
      <div class="scol">
        <div class="scolh">Свободные потребности <span>${freeOrders(data).length}</span></div>
        <div class="list">${freeOrders(data).slice(0, 40).map(order => `<div class="list-item ordrow">
          <span style="flex:1;min-width:0">
            <b>№${escapeHtml(order.order_no || '—')}</b> ${escapeHtml(order.customer_name)}
            <small class="muted" style="display:block">${escapeHtml(order.from_point || order.from_name)}
              → ${escapeHtml(order.to_point || order.to_name)}
              · окно ${formatDateTime(order.window_from)} · ${money(order.rate_vat)}</small>
          </span>
        </div>`).join('') || '<p class="muted">Свободных заявок нет.</p>'}</div>
        <div class="geohint">Эти потребности не входят в маршруты — сырьё для конструктора.
          Маршрут = кольцо: старт и финиш в субъекте базирования сцепки.</div>
      </div>
    </div>
  </div>`;

  // ── Диалог сборки ──
  const autoDialog = () => {
    const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
    context.showModal(`<h2>🧮 Собрать маршрут</h2>
      <label class="field">Субъект базирования
        <select id="rbRegion">${regionList.map(region =>
          `<option ${region === HOME_REGION ? 'selected' : ''}>${escapeHtml(region)}</option>`).join('')}</select></label>
      <label class="field">Старт маршрута<input type="date" id="rbStart" value="${tomorrow}"></label>
      <label class="field">План выручки без НДС, ₽/сутки<input type="number" id="rbTarget" value="48000" min="0" step="1000"></label>
      <label class="field">Максимум заявок в кольце<input type="number" id="rbMax" value="4" min="1" max="8"></label>
      <button class="button full" id="rbGo">Собрать и открыть редактор</button>`);
    document.getElementById('rbGo').onclick = async () => {
      const baseRegion = document.getElementById('rbRegion').value;
      const startIso = `${document.getElementById('rbStart').value}T06:00:00.000Z`;
      const targetPerDay = Number(document.getElementById('rbTarget').value) || 48000;
      const orderIds = buildAutoRoute(data, { startIso, baseRegion, targetPerDay,
        maxOrders: Number(document.getElementById('rbMax').value) || 4 });
      if (!orderIds.length) { toast('Не из чего собрать: нет свободных заявок из этого субъекта', 'error'); return; }
      try {
        const created = await api('/api/routes', { method: 'POST',
          body: JSON.stringify({ baseRegion, plannedStart: startIso, targetPerDay, orderIds }) });
        toast(`Маршрут ${created.routeNo} собран`);
        context.closeModal();
        await context.onReload();
        editorDialog(created.id);
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  // ── Редактор маршрута ──
  const editorDialog = routeId => {
    const route = (state.data.routes || []).find(item => item.id === routeId);
    if (!route) return;
    // Всегда свежие данные: после автосборки onReload обновляет state.data,
    // а замыкание data этого рендера уже устарело.
    let ids = (state.data.orders || []).filter(order => order.route_id === routeId)
      .sort((a, b) => (a.route_seq || 0) - (b.route_seq || 0)).map(order => order.id);
    const orderById = id => (state.data.orders || []).find(item => item.id === id);
    const renderEditor = () => {
      const routeOrders = ids.map(orderById).filter(Boolean);
      const metrics = routeMetrics(state.data, routeOrders, {
        baseRegion: route.base_region, plannedStart: route.planned_start,
        targetPerDay: route.target_per_day });
      const box = document.getElementById('routeEditorBody');
      const lastPos = routeOrders.length
        ? orderToAddress(state.data, routeOrders[routeOrders.length - 1]) : basePoint(state.data, route.base_region);
      // Кандидат должен быть погружаемым после конца цепочки: окно,
      // закрывающееся раньше последней выгрузки маршрута, не предлагается.
      const chainEndMs = metrics.legs.length
        ? metrics.legs[metrics.legs.length - 1].unloadAt
        : (route.planned_start ? Date.parse(route.planned_start) : Date.now());
      const candidates = freeOrders(state.data, routeId, Math.max(chainEndMs, Date.now()))
        .filter(order => !ids.includes(order.id))
        .map(order => ({ order, feed: plannedKmBetween(lastPos, orderFromAddress(state.data, order)) ?? 9999 }))
        .sort((a, b) => a.feed - b.feed).slice(0, 12);
      box.innerHTML = `
        <div class="rt-lane start">🏁 База: <b>${escapeHtml(route.base_region || HOME_REGION)}</b>
          · старт ${route.planned_start ? formatDateTime(route.planned_start) : '—'}</div>
        ${metrics.legs.map((leg, index) => `
          ${leg.feed ? `<div class="rt-empty-leg ${leg.feed > SPOT_KM ? 'spot' : ''}">⤷ порожний перегон ~${Math.round(leg.feed)} км${leg.feed > SPOT_KM
            ? ` · 🔍 спот: поискать груз <b>${escapeHtml(leg.feedFromRegion || '?')}</b> → <b>${escapeHtml(leg.fromRegion || '?')}</b>
              <button class="button ghost small" data-spot-from="${escapeHtml(leg.feedFromRegion || '')}"
                data-spot-to="${escapeHtml(leg.fromRegion || '')}" data-spot-km="${Math.round(leg.feed)}"
                data-spot-at="${leg.feedAtIso}" title="Запрос продажам: найти груз на это пустое плечо">→ Продажи</button>`
            : ''}</div>` : ''}
          <div class="rt-lane ${leg.lateStart ? 'late' : ''}">
            <span class="rt-idx">${index + 1}</span>
            <span style="flex:1;min-width:0">
              <b>№${escapeHtml(leg.order.order_no || '—')}</b> ${escapeHtml(leg.order.customer_name)}
              ${Number(leg.order.cash) ? '<span class="cash-badge">💵</span>' : ''}
              <small class="muted" style="display:block">⬆ ${escapeHtml(leg.order.from_point || leg.order.from_name)}
                <span class="muted">(${escapeHtml(leg.fromRegion || '?')})</span>
                · окно ${formatDateTime(leg.order.window_from)}–${formatDateTime(leg.order.window_to)}
                · погрузка ~${formatDateTime(new Date(leg.loadAt).toISOString())}${leg.lateStart
                  ? ' <span class="danger">⚠ позже окна</span>' : ''}</small>
              <small class="muted" style="display:block">⬇ ${escapeHtml(leg.order.to_point || leg.order.to_name)}
                <span class="muted">(${escapeHtml(leg.toRegion || '?')})</span>
                · выгрузка ~${formatDateTime(new Date(leg.unloadAt).toISOString())}
                · ${leg.km} км · ${money(leg.order.rate_vat)}
                <span class="muted">(без НДС ${money(Math.round(orderNet(leg.order, state.data)))})</span></small>
            </span>
            <span class="rt-lane-btns">
              <button class="button ghost small" data-up="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
              <button class="button ghost small" data-down="${index}" ${index === metrics.legs.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="button ghost small danger" data-remove="${index}">✕</button>
            </span>
          </div>`).join('') || '<p class="muted">Пусто: добавьте заявки из списка ниже.</p>'}
        <div class="rt-lane finish">🏁 Возврат на базу: ~${metrics.returnKm} км порожним
          ${metrics.closesAtBase ? '<span class="ctrl-worked-note">✓ кольцо замкнуто</span>'
            : '<span class="danger">⚠ последняя выгрузка не в субъекте базирования</span>'}
          ${metrics.returnKm > SPOT_KM ? `· 🔍 спот: поискать груз <b>${escapeHtml(metrics.lastRegion || '?')}</b>
            → <b>${escapeHtml(route.base_region || HOME_REGION)}</b>
            <button class="button ghost small" data-spot-from="${escapeHtml(metrics.lastRegion || '')}"
              data-spot-to="${escapeHtml(route.base_region || HOME_REGION)}" data-spot-km="${metrics.returnKm}"
              data-spot-at="${new Date(metrics.endMs).toISOString()}"
              title="Запрос продажам: найти обратный груз к базе">→ Продажи</button>` : ''}</div>
        <div class="rt-total ${perDayClass(metrics.targetShare)}">
          ${routeOrders.length} заявок · гружёные ${metrics.loadedKm} км · порожние ${metrics.emptyKm} км
          · ~${metrics.days.toFixed(1)} сут · без НДС ${money(Math.round(metrics.revenueNet))}
          · <b>${money(Math.round(metrics.perDay))}/сутки</b> (план ${money(metrics.target)} —
          ${Math.round(metrics.targetShare * 100)}%)</div>
        <details class="task-fold" ${candidates.length ? '' : ''}>
          <summary>+ Добавить заявку (${candidates.length} кандидатов, ближайшие к последней выгрузке)</summary>
          ${candidates.map(item => `<div class="rt-cand">
            <span style="flex:1;min-width:0"><b>№${escapeHtml(item.order.order_no || '—')}</b>
              ${escapeHtml(item.order.customer_name)}
              <small class="muted" style="display:block">${escapeHtml(item.order.from_point || item.order.from_name)}
                → ${escapeHtml(item.order.to_point || item.order.to_name)}
                · окно ${formatDateTime(item.order.window_from)} · ${money(item.order.rate_vat)}
                ${item.feed !== 9999 ? `· подгон ~${Math.round(item.feed)} км` : ''}</small></span>
            <button class="button small" data-add="${item.order.id}">+</button>
          </div>`).join('') || '<p class="muted">Кандидатов нет.</p>'}
        </details>`;
      box.querySelectorAll('[data-up]').forEach(button => button.onclick = () => {
        const index = Number(button.dataset.up);
        [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
        renderEditor();
      });
      box.querySelectorAll('[data-down]').forEach(button => button.onclick = () => {
        const index = Number(button.dataset.down);
        [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
        renderEditor();
      });
      box.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => {
        ids.splice(Number(button.dataset.remove), 1);
        renderEditor();
      });
      box.querySelectorAll('[data-add]').forEach(button => button.onclick = () => {
        ids.push(button.dataset.add);
        renderEditor();
      });
      box.querySelectorAll('[data-spot-from]').forEach(button => button.onclick = async () => {
        try {
          await api(`/api/routes/${routeId}/spot-request`, { method: 'POST',
            body: JSON.stringify({ fromRegion: button.dataset.spotFrom, toRegion: button.dataset.spotTo,
              km: Number(button.dataset.spotKm), aroundIso: button.dataset.spotAt }) });
          toast('Спот-запрос отправлен продажам');
        } catch (error) { toast(error.message, 'error'); }
      });
    };
    context.showModal(`<h2 style="margin-bottom:4px">✎ ${escapeHtml(route.route_no)}
        <span class="muted" style="font-size:var(--fs-sm)">· ${STATUS_LABELS[route.status] || route.status}</span></h2>
      <div id="routeEditorBody" style="max-height:58vh;overflow:auto"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="button" id="routeSave">Сохранить</button>
        <button class="button ghost" id="routeCancel">Отмена</button>
      </div>`);
    const modal = document.querySelector('#modalRoot .modal');
    if (modal) modal.style.width = 'min(840px, 96vw)';
    renderEditor();
    document.getElementById('routeCancel').onclick = () => context.closeModal();
    document.getElementById('routeSave').onclick = async () => {
      try {
        await api(`/api/routes/${routeId}`, { method: 'PATCH',
          body: JSON.stringify({ orderIds: ids }) });
        toast('Маршрут сохранён');
        context.closeModal();
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  // ── Назначение ТС на маршрут ──
  const assignDialogRoute = routeId => {
    const route = (state.data.routes || []).find(item => item.id === routeId);
    if (!route) return;
    const vehicles = state.data.vehicles.filter(vehicle => vehicle.status === 'work');
    context.showModal(`<h2>Назначить ТС на ${escapeHtml(route.route_no)}</h2>
      <p class="muted">Рейсы по каждой заявке создадутся цепочкой и уйдут диспетчеру
        в подготовку (назначение подтверждается автоматически).</p>
      <label class="field">Сцепка
        <input id="routeVehicleSearch" placeholder="🔍 поиск: номер, водитель, тип" autocomplete="off">
        <select id="routeVehicle" style="margin-top:4px">${vehicles.map(vehicle =>
          `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.type_name || '')}
            · ${escapeHtml(vehicle.driver_name || 'без водителя')}</option>`).join('')}</select></label>
      <button class="button full" id="routeAssignGo">Назначить маршрут</button>`);
    wireSelectSearch(document.getElementById('routeVehicleSearch'),
      document.getElementById('routeVehicle'));
    document.getElementById('routeAssignGo').onclick = async () => {
      try {
        const result = await api(`/api/routes/${routeId}/assign`, { method: 'POST',
          body: JSON.stringify({ vehicleId: document.getElementById('routeVehicle').value }) });
        toast(`Маршрут назначен: рейсов ${result.tripIds.length}`);
        context.closeModal();
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  if (canEdit) {
    const autoButton = container.querySelector('#routeAuto');
    if (autoButton) autoButton.onclick = autoDialog;
    const blankButton = container.querySelector('#routeBlank');
    if (blankButton) blankButton.onclick = async () => {
      try {
        const created = await api('/api/routes', { method: 'POST',
          body: JSON.stringify({ baseRegion: HOME_REGION,
            plannedStart: new Date(Date.now() + DAY_MS).toISOString(), targetPerDay: 48000, orderIds: [] }) });
        await context.onReload();
        editorDialog(created.id);
      } catch (error) { toast(error.message, 'error'); }
    };
  }
  container.querySelectorAll('[data-edit-route]').forEach(button =>
    button.onclick = () => editorDialog(button.dataset.editRoute));
  container.querySelectorAll('[data-assign-route]').forEach(button =>
    button.onclick = () => assignDialogRoute(button.dataset.assignRoute));
  container.querySelectorAll('[data-hand-route]').forEach(button =>
    button.onclick = async () => {
      try {
        await api(`/api/routes/${button.dataset.handRoute}`, { method: 'PATCH',
          body: JSON.stringify({ status: 'handed' }) });
        toast('Маршрут передан логисту');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    });
  container.querySelectorAll('[data-return-route]').forEach(button =>
    button.onclick = async () => {
      try {
        await api(`/api/routes/${button.dataset.returnRoute}`, { method: 'PATCH',
          body: JSON.stringify({ status: 'draft' }) });
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    });
  container.querySelectorAll('[data-delete-route]').forEach(button =>
    button.onclick = async () => {
      if (!confirm('Удалить маршрут? Заявки вернутся в свободные.')) return;
      try {
        await api(`/api/routes/${button.dataset.deleteRoute}`, { method: 'DELETE' });
        toast('Маршрут удалён, заявки свободны');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    });
}
