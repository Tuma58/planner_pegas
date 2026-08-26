// «Конструктор маршрутов»: кольцевые цепочки заявок от субъекта базирования
// ТС и обратно, с живой экономикой к плановой выручке в сутки (48 000 ₽ —
// настройка каждого маршрута). Полуавтомат: «🧮 Собрать» предлагает цепочку
// из свободных потребностей, дальше — ручная правка. Готовый маршрут
// передаётся логисту и назначается на сцепку целиком (рейсы цепочкой).
import { api, escapeHtml, formatDateTime, money, toast, transitHours , wireSelectSearch, captureScrolls, restoreScrolls } from './api.js';
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

// Точка выгрузки рейса (для старта цепочки от машины): адрес по тексту
// пункта, иначе — по имени геозоны.
const tripToPoint = (data, trip) => resolveAddress(data, trip.to_point || trip.to_name) || null;

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
// Допуск планирования по транзитному времени: если расчёт выходит за окно
// заявки не более чем на 3 часа, цепочку не бракуем — плечо берётся с
// пометкой «договориться с клиентом» (сдвинуть погрузку/выгрузку на часы
// проще, чем искать другой груз). Сверх допуска — плечо неисполнимо.
export const TOLERANCE_H = 3;
// Порожний подгон между звеньями: цель — в пределах города/области,
// предел — дальше маршрут теряет смысл (кроме первого плеча от базы).
export const FEED_TARGET_KM = 50;
export const FEED_LIMIT_KM = 250;
// Себестоимость порожнего километра — для оценки «деньги минус порожняк».
export const EMPTY_KM_COST = 35;

// Фактический транзит плеча: медиана рейсов этого направления за 60 дней.
// Формула (км/скорость + операции) × 1,5 завышает короткие плечи в 1,5–1,7
// раза (Дзержинск→Москва: формула 21 ч, факт 12 ч) и отбраковывала
// исполнимые цепочки — факт точнее, формула остаётся фолбэком.
export function legTransitHours(data, order, calc) {
  const since = Date.now() - 60 * DAY_MS;
  const list = (data.trips || [])
    .filter(trip => trip.status !== 'rejected' &&
      trip.from_name === order.from_name && trip.to_name === order.to_name &&
      Date.parse(trip.starts_at) >= since)
    .map(trip => (Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 3_600_000)
    .sort((a, b) => a - b);
  if (list.length >= 5) return list[Math.floor(list.length / 2)];
  return transitHours(legKm(data, order), calc, 2 + viaCount(order));
}

// Плановое плечо для спота: самое ходовое направление из зоны за 60 дней
// (медианы ставки, км и транзита) плюс клиенты-кандидаты. Так в цепочке
// появляется звено «здесь будет груз» с датой из расчёта маршрута —
// продажи продают под слот, а не маршрут ждёт заявку.
// Спот — плановое плечо, которое продажам предстоит закрыть. Поэтому он
// должен быть типовым и исполнимым: слишком длинное плечо «съедает» неделю
// и оставляет машину без обратной загрузки.
export const SPOT_MAX_HOURS = 48;

export function spotLegFrom(data, zoneName, { baseZone = null, maxHours = SPOT_MAX_HOURS } = {}) {
  const since = Date.now() - 60 * DAY_MS;
  const byLeg = new Map();
  for (const trip of data.trips || []) {
    if (trip.status === 'rejected' || trip.from_name !== zoneName) continue;
    if (Date.parse(trip.starts_at) < since) continue;
    const key = trip.to_name;
    if (!byLeg.has(key)) byLeg.set(key, { to: key, rates: [], kms: [], trs: [], custs: new Map() });
    const item = byLeg.get(key);
    item.rates.push(trip.revenue_vat);
    item.kms.push(trip.distance_km || 0);
    item.trs.push((Date.parse(trip.ends_at) - Date.parse(trip.starts_at)) / 3_600_000);
    item.custs.set(trip.customer_name, (item.custs.get(trip.customer_name) || 0) + 1);
  }
  const median = list => { const s2 = [...list].sort((a, b) => a - b); return s2.length ? s2[Math.floor(s2.length / 2)] : 0; };
  const options = [...byLeg.values()]
    .filter(item => item.rates.length >= 5 && item.to !== zoneName)
    .map(item => ({ to: item.to, n: item.rates.length,
      rate: median(item.rates), km: median(item.kms), transit: median(item.trs),
      customers: [...item.custs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([name, count]) => `${name} (${count})`).join(', ') }))
    // Плечо должно укладываться в разумный срок и вести туда, откуда есть
    // регулярный выезд, — иначе спот превращается в неделю в один конец
    // и порожний ход обратно.
    .filter(item => item.transit <= maxHours)
    .filter(item => item.to === baseZone || outflowPerWeek(data, item.to) >= 1);
  if (!options.length) return null;
  // Домой — приоритет: спот к базе замыкает кольцо.
  const home = baseZone ? options.find(item => item.to === baseZone) : null;
  // Иначе — по ₽ за сутки занятости (транзит плюс сутки на поиск и погрузку).
  return home || options.sort((a, b) => (b.rate / (b.transit + 24)) - (a.rate / (a.transit + 24)))[0];
}

// Есть ли чем продолжить цепочку после этого плеча: свободная заявка с
// погрузкой рядом с точкой выгрузки и сходящимся окном. История потока
// (outflowPerWeek) говорит о направлении «вообще», а это — о конкретных
// днях: без такой проверки алгоритм заходит в зону, где заявок сейчас нет,
// и маршрут обрывается на первом же плече.
function hasContinuation(data, pool, pick, { feedLimitKm, bodyType, baseRegion }) {
  if (pick.toRegion === baseRegion) return true; // кольцо замкнулось — продолжение не нужно
  const calc = data.settings.calculation;
  const to = orderToAddress(data, pick.order);
  return pool.some(order => {
    if (order === pick.order) return false;
    if (bodyType && order.body_type && order.body_type !== bodyType &&
      !['Рефрижератор', 'Изотерм'].includes(order.body_type)) return false;
    const feed = plannedKmBetween(to, orderFromAddress(data, order)) ?? 9999;
    if (feed > feedLimitKm) return false;
    const readyAt = pick.unloadAt + transitHours(feed, calc, 0) * 3_600_000;
    const loadAt = Math.max(readyAt, Date.parse(order.window_from));
    const unloadAt = loadAt + legTransitHours(data, order, calc) * 3_600_000;
    return (unloadAt - Date.parse(order.window_to)) / 3_600_000 <= TOLERANCE_H;
  });
}

// Регулярность обратного потока из зоны выгрузки: рейсов в неделю за 60 дней.
// Ноль — тупик: заходить в такую зону нельзя, оттуда нечем выехать
// (жадность по подгону загоняла машину в Питер, а дальше 3 697 км порожняком).
export function outflowPerWeek(data, zoneName) {
  const since = Date.now() - 60 * DAY_MS;
  const count = (data.trips || []).filter(trip => trip.status !== 'rejected' &&
    trip.from_name === zoneName && trip.to_name !== zoneName &&
    Date.parse(trip.starts_at) >= since).length;
  return count / (60 / 7);
}

export function routeMetrics(data, routeOrders, { baseRegion, plannedStart, targetPerDay, startPoint = null }) {
  const calc = data.settings.calculation;
  // Время порожнего перегона — с тем же коэффициентом 1,5 (отдых водителя),
  // что и гружёный транзит, только без грузовых операций.
  const emptyLegMs = km => transitHours(km || 0, calc, 0) * 3_600_000;
  // Старт цепочки: от машины (место выгрузки текущего задания), если передан,
  // иначе — от базы, как раньше.
  const base = basePoint(data, baseRegion || HOME_REGION);
  const origin = startPoint || base;
  let position = origin;
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
    // Готовность машины = предыдущая выгрузка + порожний подгон; погрузка не
    // раньше окна «с». Разница между ними — ОЖИДАНИЕ: простой бьёт по
    // эффективности так же, как порожняк, поэтому он считается отдельно.
    const readyAt = cursor + emptyLegMs(feed);
    const loadAt = Math.max(readyAt, Date.parse(order.window_from));
    const waitMs = Math.max(0, loadAt - readyAt);
    const unloadAt = loadAt + legTransitHours(data, order, calc) * 3_600_000;
    // Допуск ±3 часа: выход за окно в его пределах — не брак, а разговор
    // с клиентом; сверх допуска плечо неисполнимо.
    const overshootMs = Math.max(0, unloadAt - Date.parse(order.window_to));
    const needDeal = overshootMs > 0 && overshootMs <= TOLERANCE_H * 3_600_000;
    const impossible = overshootMs > TOLERANCE_H * 3_600_000;
    const lateStart = Date.parse(order.window_to) < loadAt;
    legs.push({ order, feed, km, loadAt, unloadAt, lateStart,
      readyAt, waitMs, overshootMs, needDeal, impossible,
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
  const waitMs = legs.reduce((sum, leg) => sum + (leg.waitMs || 0), 0);
  const dealLegs = legs.filter(leg => leg.needDeal).length;
  const impossibleLegs = legs.filter(leg => leg.impossible).length;
  const driveMs = legs.reduce((sum, leg) => sum + (leg.unloadAt - leg.loadAt), 0);
  return { legs, loadedKm: Math.round(loadedKm), emptyKm: Math.round(emptyKm),
    waitMs, dealLegs, impossibleLegs, driveMs,
    returnKm: Math.round(returnKm || 0), days, revenueNet, revenueVat, perDay, target,
    targetShare: target ? perDay / target : 0, endMs, lastRegion,
    emptyShare: loadedKm ? emptyKm / (loadedKm + emptyKm) : 0,
    closesAtBase: routeOrders.length
      ? orderRegionTo(data, routeOrders[routeOrders.length - 1]) === (baseRegion || HOME_REGION)
      : false };
}

// Полуавтомат: жадная сборка кольца. Первая заявка — погрузка в базовом
// субъекте, дальше минимальный порожний перегон, замыкание — выгрузкой в базу.
export function buildAutoRoute(data, { startIso, baseRegion, targetPerDay, maxOrders = 4,
  exclude = new Set(), startPoint = null, bodyType = null, feedLimitKm = FEED_LIMIT_KM,
  horizonDays = null }) {
  const calc = data.settings.calculation;
  const base = basePoint(data, baseRegion);
  const origin = startPoint || base;
  const pool = freeOrders(data).filter(order =>
    !exclude.has(order.id) && Date.parse(order.window_to) > Date.parse(startIso));
  const chain = [];
  let position = origin;
  let cursor = Date.parse(startIso);
  const horizonMs = horizonDays ? Date.parse(startIso) + horizonDays * DAY_MS : null;
  while (chain.length < maxOrders) {
    const candidates = pool
      .filter(order => !chain.includes(order))
      // Кузов: тип парка в заявке — жёсткое требование, «Рефрижератор»,
      // «Изотерм» и пустой берёт любая машина (правило задания продаж).
      .filter(order => !bodyType || !order.body_type ||
        order.body_type === bodyType || ['Рефрижератор', 'Изотерм'].includes(order.body_type))
      .map(order => {
        const from = orderFromAddress(data, order);
        const feed = plannedKmBetween(position, from) ?? 9999;
        const readyAt = cursor + transitHours(feed === 9999 ? 0 : feed, calc, 0) * 3_600_000;
        const loadAt = Math.max(readyAt, Date.parse(order.window_from));
        const waitH = Math.max(0, (loadAt - readyAt) / 3_600_000);
        const transit = legTransitHours(data, order, calc);
        const unloadAt = loadAt + transit * 3_600_000;
        const overshootH = Math.max(0, (unloadAt - Date.parse(order.window_to)) / 3_600_000);
        const toRegion = orderRegionTo(data, order);
        const busyH = (unloadAt - cursor) / 3_600_000;
        // Оценка: деньги минус стоимость порожняка, делённые на всё время
        // занятости (подгон + ожидание + транзит). Так один критерий сразу
        // жмёт и порожняк, и простой в ожидании окна.
        const score = (orderNet(order, data) - (feed === 9999 ? 0 : feed) * EMPTY_KM_COST) /
          Math.max(1, busyH);
        return { order, feed, loadAt, unloadAt, waitH, overshootH, toRegion, score,
          fromRegion: orderRegionFrom(data, order) };
      })
      // Первое плечо — от места старта (машина/база), дальше подгон в пределах лимита.
      .filter(item => item.feed <= (chain.length === 0 ? Math.max(feedLimitKm, 400) : feedLimitKm))
      // Допуск ±3 часа: сверх него плечо неисполнимо и в цепочку не идёт.
      .filter(item => item.overshootH <= TOLERANCE_H)
      // Не заходить в зону, откуда нет обратного потока: тупик рождает
      // тысячи километров порожняком.
      .filter(item => item.toRegion === baseRegion ||
        outflowPerWeek(data, item.order.to_name) >= 1)
      .filter(item => !horizonMs || item.unloadAt <= horizonMs + 12 * 3_600_000)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) break;
    // Тупики отсекаются: плечо, после которого цепочку нечем продолжить,
    // берётся только если других нет (тогда оно закрывает маршрут).
    const lastStep = chain.length + 1 >= maxOrders;
    const withNext = lastStep ? candidates
      : candidates.filter(item => hasContinuation(data, pool.filter(o => !chain.includes(o)), item,
        { feedLimitKm, bodyType, baseRegion }));
    const usable = withNext.length ? withNext : candidates;
    // Замыкание кольца: на последнем шаге или при выполненном плане ₽/сутки
    // предпочитаем плечо с выгрузкой в базовом субъекте.
    const closing = usable.find(item => item.toRegion === baseRegion);
    const metricsNow = routeMetrics(data, chain, { baseRegion, plannedStart: startIso, targetPerDay, startPoint: origin });
    const preferClosing = chain.length + 1 >= maxOrders ||
      (chain.length >= 1 && metricsNow.perDay >= (Number(targetPerDay) || 48000));
    const pick = (preferClosing && closing) ? closing : usable[0];
    chain.push(pick.order);
    cursor = pick.unloadAt;
    position = orderToAddress(data, pick.order) || position;
    if (pick.toRegion === baseRegion && chain.length > 1 && !horizonDays) break;
  }
  return chain.map(order => order.id);
}

// Недельная сборка: цепочка звеньев на горизонт (7/14 дней). Заявка — если
// есть подходящая, иначе СПОТ из истории плеча с датой из расчёта: маршрут
// остаётся целым планом, дырки закрывают продажи. Возвращает смешанный
// список звеньев в порядке следования.
export function buildWeekPlan(data, { startIso, baseRegion, baseZone, targetPerDay,
  startPoint = null, bodyType = null, horizonDays = 7, feedLimitKm = FEED_LIMIT_KM }) {
  const calc = data.settings.calculation;
  const endMs = Date.parse(startIso) + horizonDays * DAY_MS;
  const chain = [];
  const usedOrders = new Set();
  let position = startPoint || basePoint(data, baseRegion);
  let zone = position?.zone_name || baseZone || null;
  let cursor = Date.parse(startIso);
  let guard = 0;
  while (cursor < endMs && guard < 20) {
    guard += 1;
    const ids = buildAutoRoute(data, {
      startIso: new Date(cursor).toISOString(), baseRegion, targetPerDay,
      maxOrders: 3, exclude: usedOrders, startPoint: position, bodyType, feedLimitKm,
      horizonDays: (endMs - cursor) / DAY_MS
    });
    if (ids.length) {
      const orders = ids.map(id => (data.orders || []).find(order => order.id === id));
      const metrics = routeMetrics(data, orders, { baseRegion, plannedStart: new Date(cursor).toISOString(),
        targetPerDay, startPoint: position });
      metrics.legs.forEach(leg => {
        chain.push({ kind: 'order', order: leg.order, loadAt: leg.loadAt, unloadAt: leg.unloadAt,
          feed: leg.feed, waitMs: leg.waitMs, needDeal: leg.needDeal, overshootMs: leg.overshootMs,
          km: leg.km, rate: Number(leg.order.rate_vat || 0) });
        usedOrders.add(leg.order.id);
      });
      const last = metrics.legs[metrics.legs.length - 1];
      cursor = last.unloadAt;
      position = orderToAddress(data, last.order) || position;
      zone = last.order.to_name || zone;
      continue;
    }
    // Заявок нет — ставим спот: направление из истории зоны, дата из цепочки.
    const spot = spotLegFrom(data, zone, { baseZone,
      maxHours: Math.min(SPOT_MAX_HOURS, (endMs - cursor) / 3_600_000 - 8) });
    if (!spot) break;
    const loadAt = cursor + 8 * 3_600_000;
    const unloadAt = loadAt + spot.transit * 3_600_000;
    if (unloadAt > endMs + 12 * 3_600_000) break;
    chain.push({ kind: 'spot', fromZone: zone, toZone: spot.to, loadAt, unloadAt,
      feed: 0, waitMs: 0, km: Math.round(spot.km), rate: Math.round(spot.rate),
      candidates: spot.customers, perWeek: spot.n / (60 / 7) });
    cursor = unloadAt;
    zone = spot.to;
    position = (data.reference.addresses || []).find(item => (item.zone_name || '') === spot.to
      && Number.isFinite(item.latitude)) || position;
  }
  return chain;
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

  const savedScrolls = captureScrolls(container);
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
  restoreScrolls(container, savedScrolls);

  // ── Диалог сборки ──
  const autoDialog = () => {
    const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
    // Машины со свободным ближайшим временем: старт цепочки — от места и
    // времени, где машина освободится (выгрузка последнего задания).
    const fleet = (data.vehicles || []).filter(vehicle => vehicle.status === 'work')
      .map(vehicle => {
        const trips = (data.trips || []).filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
          .sort((a, b) => a.ends_at.localeCompare(b.ends_at));
        const last = trips[trips.length - 1] || null;
        return { vehicle, last };
      }).sort((a, b) => (a.vehicle.plate || '').localeCompare(b.vehicle.plate || ''));
    context.showModal(`<h2>🧮 Собрать маршрут</h2>
      <label class="field">Машина <small class="muted">(старт цепочки — от её освобождения)</small>
        <select id="rbVehicle">
          <option value="">— от базы, без привязки к ТС —</option>
          ${fleet.map(item => `<option value="${item.vehicle.id}">${escapeHtml(item.vehicle.plate)} · ${escapeHtml(item.vehicle.type_name || '')}${item.last ? ` · свободна с ${formatDateTime(item.last.ends_at)} (${escapeHtml(item.last.to_point || item.last.to_name || '')})` : ''}</option>`).join('')}
        </select></label>
      <label class="field">Субъект базирования
        <select id="rbRegion">${regionList.map(region =>
          `<option ${region === HOME_REGION ? 'selected' : ''}>${escapeHtml(region)}</option>`).join('')}</select></label>
      <label class="field">Старт маршрута<input type="date" id="rbStart" value="${tomorrow}"></label>
      <label class="field">План выручки без НДС, ₽/сутки<input type="number" id="rbTarget" value="48000" min="0" step="1000"></label>
      <label class="field">Максимум заявок в кольце<input type="number" id="rbMax" value="4" min="1" max="8"></label>
      <label class="field">Горизонт планирования
        <select id="rbHorizon">
          <option value="0">Одно кольцо (до базы)</option>
          <option value="7" selected>Неделя — цепочка колец, разрывы закрываем спотами</option>
          <option value="14">Две недели</option>
        </select>
        <small class="muted">На неделю/две: где живой заявки нет — встанет спот из истории плеча,
          его закрывают продажи.</small></label>
      <button class="button full" id="rbGo">Собрать и открыть редактор</button>`);
    document.getElementById('rbGo').onclick = async () => {
      const baseRegion = document.getElementById('rbRegion').value;
      const startIso = `${document.getElementById('rbStart').value}T06:00:00.000Z`;
      const targetPerDay = Number(document.getElementById('rbTarget').value) || 48000;
      // Старт от машины: место и время выгрузки её последнего задания,
      // кузов — тип ТС (жёсткое требование по заявкам своего типа).
      const vehicleId = document.getElementById('rbVehicle').value;
      const picked = fleet.find(item => item.vehicle.id === vehicleId);
      const startPoint = picked?.last ? tripToPoint(data, picked.last) : null;
      const startFrom = picked?.last ? Math.max(Date.parse(picked.last.ends_at), Date.now()) : null;
      const realStart = startFrom ? new Date(startFrom).toISOString() : startIso;
      const bodyType = picked?.vehicle.type_name || null;
      const horizonDays = Number(document.getElementById('rbHorizon').value) || 0;
      // Кольцо — только заявки. Неделя/две — цепочка звеньев: заявки плюс
      // споты на разрывах, которые потом закрывают продажи.
      const plan = horizonDays
        ? buildWeekPlan(data, { startIso: realStart, baseRegion, baseZone: startPoint?.zone_name || null,
          targetPerDay, startPoint, bodyType, horizonDays })
        : buildAutoRoute(data, { startIso: realStart, baseRegion, targetPerDay, startPoint, bodyType,
          maxOrders: Number(document.getElementById('rbMax').value) || 4 })
          .map(id => ({ kind: 'order', order: (data.orders || []).find(order => order.id === id) }));
      const orderIds = plan.filter(item => item.kind === 'order').map(item => item.order.id);
      const spotLegs = plan.filter(item => item.kind === 'spot');
      if (!orderIds.length && !spotLegs.length) {
        toast('Не из чего собрать: нет свободных заявок из этого субъекта', 'error'); return;
      }
      try {
        const created = await api('/api/routes', { method: 'POST',
          body: JSON.stringify({ baseRegion, plannedStart: startIso, targetPerDay, orderIds }) });
        for (const [index, spot] of spotLegs.entries()) {
          await api(`/api/routes/${created.id}/spots`, { method: 'POST', body: JSON.stringify({
            seq: plan.indexOf(spot), fromLabel: spot.fromZone, toLabel: spot.toZone,
            plannedLoad: new Date(spot.loadAt).toISOString(),
            plannedUnload: new Date(spot.unloadAt).toISOString(),
            expectedRate: spot.rate, expectedKm: spot.km, candidates: spot.candidates || ''
          }) });
          void index;
        }
        toast(`Маршрут ${created.routeNo} собран: заявок ${orderIds.length}` +
          (spotLegs.length ? `, спотов ${spotLegs.length}` : ''));
        context.closeModal();
        await context.onReload();
        editorDialog(created.id);
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  // ── Лента маршрута: цепочка по дням, как в «Плане вывоза» ──
  // Строка на сутки, блоки по времени: гружёный ход, подгон, ожидание, спот.
  // Видно не «список заявок», а как машина проживает неделю.
  const ribbonHtml = (chain, startMs) => {
    if (!chain.length) return '<p class="muted">Цепочка пуста.</p>';
    const dayStart = ms => { const d = new Date(ms + 3 * 3_600_000); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 3 * 3_600_000; };
    const endMs = chain[chain.length - 1].unloadAt;
    const days = [];
    for (let ms = dayStart(startMs); ms <= dayStart(endMs); ms += DAY_MS) days.push(ms);
    const pctOf = (from, to, dayFrom) => {
      const a2 = Math.max(from, dayFrom), b2 = Math.min(to, dayFrom + DAY_MS);
      return b2 <= a2 ? null : { left: (a2 - dayFrom) / DAY_MS * 100, width: (b2 - a2) / DAY_MS * 100 };
    };
    const label = item => item.kind === 'spot'
      ? `🔍 ${item.fromZone}→${item.toZone} ~${money(item.rate)}`
      : `№${item.order.order_no || '—'} ${item.order.customer_name || ''}`;
    return `<div class="rt-ribbon">
      ${days.map(dayFrom => {
    const date = new Date(dayFrom + 3 * 3_600_000);
    const title = date.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    const blocks = chain.map(item => {
      const parts = [];
      // подгон и ожидание — перед погрузкой
      const feedFrom = item.loadAt - (item.waitMs || 0) - (item.feed ? item.feed / 50 * 1.5 * 3_600_000 : 0);
      if (item.feed) {
        const p = pctOf(feedFrom, feedFrom + item.feed / 50 * 1.5 * 3_600_000, dayFrom);
        if (p) parts.push(`<i class="rt-b feed" style="left:${p.left}%;width:${p.width}%" title="Порожний подгон ~${Math.round(item.feed)} км"></i>`);
      }
      if (item.waitMs > 3_600_000) {
        const p = pctOf(item.loadAt - item.waitMs, item.loadAt, dayFrom);
        if (p) parts.push(`<i class="rt-b wait" style="left:${p.left}%;width:${p.width}%" title="Ожидание окна ${Math.round(item.waitMs / 3_600_000)} ч"></i>`);
      }
      const p = pctOf(item.loadAt, item.unloadAt, dayFrom);
      if (p) parts.push(`<i class="rt-b ${item.kind === 'spot' ? 'spot' : item.needDeal ? 'deal' : 'load'}"
        style="left:${p.left}%;width:${p.width}%"
        title="${escapeHtml(label(item))} · ${formatDateTime(new Date(item.loadAt).toISOString())} → ${formatDateTime(new Date(item.unloadAt).toISOString())}${item.needDeal ? ` · 🤝 договориться +${(item.overshootMs / 3_600_000).toFixed(1)} ч` : ''}">${p.width > 12 ? escapeHtml(label(item)).slice(0, 28) : ''}</i>`);
      return parts.join('');
    }).join('');
    return `<div class="rt-day"><span class="rt-day-t">${title}</span><span class="rt-track">${blocks}</span></div>`;
  }).join('')}
      <div class="rt-legend"><i class="rt-b load"></i> гружёный ход
        <i class="rt-b deal"></i> договориться с клиентом
        <i class="rt-b spot"></i> спот (продать)
        <i class="rt-b feed"></i> порожний подгон
        <i class="rt-b wait"></i> ожидание</div>
    </div>`;
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
      // Споты этого маршрута — звенья без заявки; показываем вместе с плечами.
      const spots = (state.data.routeSpots || []).filter(item => item.route_id === routeId && item.status !== 'closed');
      const ribbonChain = [
        ...metrics.legs.map(leg => ({ kind: 'order', order: leg.order, loadAt: leg.loadAt,
          unloadAt: leg.unloadAt, feed: leg.feed, waitMs: leg.waitMs, needDeal: leg.needDeal,
          overshootMs: leg.overshootMs })),
        ...spots.filter(spot => spot.planned_load && spot.planned_unload).map(spot => ({
          kind: 'spot', fromZone: spot.from_label || '?', toZone: spot.to_label || '?',
          loadAt: Date.parse(spot.planned_load), unloadAt: Date.parse(spot.planned_unload),
          feed: 0, waitMs: 0, rate: spot.expected_rate }))
      ].sort((a2, b2) => a2.loadAt - b2.loadAt);
      box.innerHTML = `
        ${ribbonChain.length ? ribbonHtml(ribbonChain, ribbonChain[0].loadAt) : ''}
        ${spots.length ? `<div class="rt-spots">${spots.map(spot => `<div class="rt-lane spot-lane">
          <span class="rt-idx">🔍</span>
          <span style="flex:1;min-width:0"><b>Спот: ${escapeHtml(spot.from_label)} → ${escapeHtml(spot.to_label)}</b>
            <small class="muted" style="display:block">погрузка ~${spot.planned_load ? formatDateTime(spot.planned_load) : '—'}
              · ориентир ${money(Math.round(spot.expected_rate))} с НДС · ~${Math.round(spot.expected_km)} км
              ${spot.candidates ? `· кандидаты: ${escapeHtml(spot.candidates)}` : ''}</small></span>
          <span class="rt-lane-btns">
            <button class="button ghost small" data-spot-sales="${spot.id}" title="Запрос продажам на это плечо">→ Продажи</button>
            <button class="button ghost small danger" data-spot-del="${spot.id}">✕</button>
          </span></div>`).join('')}</div>` : ''}
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
                  ? ' <span class="danger">⚠ позже окна</span>' : ''}${leg.waitMs > 6 * 3_600_000
                  ? ` <span class="badge warn" title="Машина готова раньше окна погрузки — простой в ожидании">⏳ ожидание ${Math.round(leg.waitMs / 3_600_000)} ч</span>` : ''}</small>
              <small class="muted" style="display:block">⬇ ${escapeHtml(leg.order.to_point || leg.order.to_name)}
                <span class="muted">(${escapeHtml(leg.toRegion || '?')})</span>
                · выгрузка ~${formatDateTime(new Date(leg.unloadAt).toISOString())}
                · ${leg.km} км · ${money(leg.order.rate_vat)}${leg.needDeal
                  ? ` <span class="badge bad" title="Расчётная выгрузка выходит за окно клиента на ${(leg.overshootMs / 3_600_000).toFixed(1)} ч — в пределах допуска планирования ${TOLERANCE_H} ч: согласуйте сдвиг с клиентом">🤝 договориться: +${(leg.overshootMs / 3_600_000).toFixed(1)} ч к окну</span>` : ''}
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
          ${Math.round(metrics.targetShare * 100)}%)
          ${metrics.waitMs > 6 * 3_600_000 ? ` · <span class="badge warn" title="Суммарный простой в ожидании окон погрузки — бьёт по эффективности так же, как порожняк">⏳ ожидание ${Math.round(metrics.waitMs / 3_600_000)} ч</span>` : ''}
          ${metrics.dealLegs ? ` · <span class="badge bad" title="Плечи, где расчёт выходит за окно клиента в пределах допуска ${TOLERANCE_H} ч — согласуйте сдвиг">🤝 договориться: ${metrics.dealLegs}</span>` : ''}</div>
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
      box.querySelectorAll('[data-spot-del]').forEach(button =>
        button.addEventListener('click', async () => {
          try {
            await api(`/api/routes/${routeId}/spots/${button.dataset.spotDel}`, { method: 'DELETE' });
            toast('Спот убран из маршрута');
            await context.onReload();
            renderEditor();
          } catch (error) { toast(error.message, 'error'); }
        }));
      box.querySelectorAll('[data-spot-sales]').forEach(button =>
        button.addEventListener('click', async () => {
          const spot = spots.find(item => item.id === button.dataset.spotSales);
          if (!spot) return;
          try {
            await api(`/api/routes/${routeId}/spot-request`, { method: 'POST', body: JSON.stringify({
              fromRegion: spot.from_label, toRegion: spot.to_label,
              aroundIso: spot.planned_load, km: spot.expected_km
            }) });
            toast('Запрос продажам отправлен');
          } catch (error) { toast(error.message, 'error'); }
        }));
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
