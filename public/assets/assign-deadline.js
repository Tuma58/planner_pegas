// Дедлайн назначения ТС: до какого момента заявку ещё можно закрыть.
//
// Разбор августа показал, где стоит время: между подтверждением заявки и
// назначением машины — медиана 6,6 ч, 57% рейсов сверх норматива. Но дело
// не в скорости логиста: 29% заявок назначаются в первый час, а вечерние
// (после 16:00) ждут до утра — 19–22 часа. При этом свободные машины были
// в 100% случаев, то есть ресурс не мешал.
//
// Норматив «назначить за 6 часов до погрузки» тоже врал: медиана порожнего
// подгона 99 км (3 часа), но у каждой четвёртой машины 281 км — 8,4 часа.
// Назначить за 6 часов до окна для такой машины означает опоздать.
//
// Поэтому считаем честный дедлайн: окно погрузки минус подгон ближайшей
// свободной машины минус время на подготовку выхода.
import { formatDateTime } from './api.js';
import { plannedKmBetween, resolveAddress } from './sales.js';

// Подготовка выхода: внести в 1С, передать задание водителю, вывести на
// линию. По факту августа медиана «назначение → линия» = 0 ч, но закладываем
// два часа: без запаса дедлайн становится недостижимым.
export const PREP_HOURS = 2;
// Если ближайшую машину найти не удалось (нет координат пункта), берём
// медианный подгон августа — 99 км ≈ 3 часа.
export const DEFAULT_FEED_HOURS = 3;

const HOUR = 3_600_000;

// Позиции свободных машин на момент — считаются ОДИН раз на всю очередь.
// Наивный вариант (перебор всех рейсов для каждой машины на каждую заявку)
// давал 4,5 секунды на сортировке 182 заявок: 128 машин × 3000 рейсов на
// каждое сравнение. Здесь тот же перебор делается однажды.
export function freeVehiclePoints(data, nowMs = Date.now()) {
  const tripsByVehicle = new Map();
  for (const trip of data.trips || []) {
    if (trip.status === 'rejected') continue;
    if (!tripsByVehicle.has(trip.vehicle_id)) tripsByVehicle.set(trip.vehicle_id, []);
    tripsByVehicle.get(trip.vehicle_id).push(trip);
  }
  const dispoByVehicle = new Map();
  for (const item of data.dispositions || []) {
    if (item.kind === 'reserve') continue;
    if (!dispoByVehicle.has(item.vehicle_id)) dispoByVehicle.set(item.vehicle_id, []);
    dispoByVehicle.get(item.vehicle_id).push(item);
  }
  const points = [];
  for (const vehicle of data.vehicles || []) {
    if (vehicle.status !== 'work') continue;
    const trips = tripsByVehicle.get(vehicle.id) || [];
    const busy = trips.some(trip => Date.parse(trip.starts_at) <= nowMs &&
      Date.parse(trip.ends_at) > nowMs);
    if (busy) continue;
    const covered = (dispoByVehicle.get(vehicle.id) || []).some(item =>
      Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs);
    if (covered) continue;
    let last = null;
    for (const trip of trips) {
      if (Date.parse(trip.ends_at) > nowMs) continue;
      if (!last || String(trip.ends_at) > String(last.ends_at)) last = trip;
    }
    const place = last
      ? resolveAddress(data, last.to_point || last.to_name)
      : resolveAddress(data, vehicle.zone_name);
    if (place) points.push(place);
  }
  return points;
}

// Часы подгона до пункта погрузки от ближайшей свободной машины.
export function feedHoursFor(data, order, nowMs = Date.now(), points = null) {
  const target = resolveAddress(data, order.from_point || order.from_name);
  if (!target) return DEFAULT_FEED_HOURS;
  const list = points || freeVehiclePoints(data, nowMs);
  let best = null;
  for (const from of list) {
    const km = plannedKmBetween(from, target);
    if (km == null) continue;
    if (best == null || km < best) best = km;
  }
  if (best == null) return DEFAULT_FEED_HOURS;
  // Та же формула, что у транзита: 50 км/ч с коэффициентом 1,5 на отдых.
  return Math.max(0.5, (best / 50) * 1.5);
}

// Дедлайн назначения и остаток времени до него. Для списка заявок
// используйте assignDeadlines: она считает позиции машин один раз.
export function assignDeadline(data, order, nowMs = Date.now(), points = null) {
  const windowFrom = Date.parse(order.window_from);
  if (!Number.isFinite(windowFrom)) return null;
  const feedHours = feedHoursFor(data, order, nowMs, points);
  const deadlineMs = windowFrom - (feedHours + PREP_HOURS) * HOUR;
  const leftMs = deadlineMs - nowMs;
  return {
    deadlineMs, leftMs, feedHours: Math.round(feedHours * 10) / 10,
    windowFrom,
    // Просрочен — уже нельзя подать вовремя даже теоретически.
    overdue: leftMs < 0,
    // Горит — меньше двух часов на решение.
    hot: leftMs >= 0 && leftMs < 2 * HOUR
  };
}

export function deadlineBadge(deadline) {
  if (!deadline) return '';
  const abs = Math.abs(deadline.leftMs);
  const hours = Math.floor(abs / HOUR);
  const minutes = Math.round((abs % HOUR) / 60_000);
  const left = hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
  // Время показываем в часовом поясе предприятия и С ДАТОЙ: «до 11:24»
  // без дня читалось как «сегодня», хотя дедлайн часто назавтра, да ещё и
  // печаталось в UTC — на три часа раньше реального.
  const at = formatDateTime(new Date(deadline.deadlineMs).toISOString());
  if (deadline.overdue) {
    return `<span class="badge bad" title="Дедлайн назначения прошёл: подгон ${deadline.feedHours} ч + подготовка ${PREP_HOURS} ч уже не укладываются в окно погрузки">
      ⛔ опоздание ${left}</span>`;
  }
  return `<span class="badge ${deadline.hot ? 'warn' : 'ok'}"
    title="Дедлайн = окно погрузки − подгон ближайшей свободной машины (${deadline.feedHours} ч) − подготовка выхода (${PREP_HOURS} ч)">
    ⏳ назначить до ${at} · осталось ${left}</span>`;
}

// Дедлайны для всей очереди разом: позиции свободных машин считаются один
// раз, каждая заявка — один проход по ним. Возвращает Map по id заявки.
export function assignDeadlines(data, orders, nowMs = Date.now()) {
  const points = freeVehiclePoints(data, nowMs);
  const result = new Map();
  for (const order of orders) result.set(order.id, assignDeadline(data, order, nowMs, points));
  return result;
}
