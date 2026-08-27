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
import { plannedKmBetween, resolveAddress } from './sales.js';

// Подготовка выхода: внести в 1С, передать задание водителю, вывести на
// линию. По факту августа медиана «назначение → линия» = 0 ч, но закладываем
// два часа: без запаса дедлайн становится недостижимым.
export const PREP_HOURS = 2;
// Если ближайшую машину найти не удалось (нет координат пункта), берём
// медианный подгон августа — 99 км ≈ 3 часа.
export const DEFAULT_FEED_HOURS = 3;

const HOUR = 3_600_000;

// Свободна ли сцепка к моменту: нет рейса, накрывающего этот момент, и нет
// интервала недоступности. Резерв не считаем занятостью — он про обещание.
function freeAt(data, vehicleId, atMs) {
  const busyTrip = (data.trips || []).some(trip => trip.vehicle_id === vehicleId &&
    trip.status !== 'rejected' &&
    Date.parse(trip.starts_at) <= atMs && Date.parse(trip.ends_at) > atMs);
  if (busyTrip) return false;
  return !(data.dispositions || []).some(item => item.vehicle_id === vehicleId &&
    item.kind !== 'reserve' &&
    Date.parse(item.starts_at) <= atMs && Date.parse(item.ends_at) > atMs);
}

// Где сцепка окажется к моменту: точка выгрузки последнего рейса до него.
function placeAt(data, vehicleId, atMs) {
  const last = (data.trips || [])
    .filter(trip => trip.vehicle_id === vehicleId && trip.status !== 'rejected' &&
      Date.parse(trip.ends_at) <= atMs)
    .sort((a, b) => String(b.ends_at).localeCompare(String(a.ends_at)))[0];
  if (last) return resolveAddress(data, last.to_point || last.to_name);
  const vehicle = (data.vehicles || []).find(item => item.id === vehicleId);
  return vehicle ? resolveAddress(data, vehicle.zone_name) : null;
}

// Часы подгона до пункта погрузки от ближайшей свободной машины.
export function feedHoursFor(data, order, nowMs = Date.now()) {
  const target = resolveAddress(data, order.from_point || order.from_name);
  if (!target) return DEFAULT_FEED_HOURS;
  let best = null;
  for (const vehicle of data.vehicles || []) {
    if (vehicle.status !== 'work') continue;
    if (!freeAt(data, vehicle.id, nowMs)) continue;
    const from = placeAt(data, vehicle.id, nowMs);
    const km = from ? plannedKmBetween(from, target) : null;
    if (km == null) continue;
    if (best == null || km < best) best = km;
  }
  if (best == null) return DEFAULT_FEED_HOURS;
  // Та же формула, что у транзита: 50 км/ч с коэффициентом 1,5 на отдых.
  return Math.max(0.5, (best / 50) * 1.5);
}

// Дедлайн назначения и остаток времени до него.
export function assignDeadline(data, order, nowMs = Date.now()) {
  const windowFrom = Date.parse(order.window_from);
  if (!Number.isFinite(windowFrom)) return null;
  const feedHours = feedHoursFor(data, order, nowMs);
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
  const at = new Date(deadline.deadlineMs).toISOString().slice(11, 16);
  if (deadline.overdue) {
    return `<span class="badge bad" title="Дедлайн назначения прошёл: подгон ${deadline.feedHours} ч + подготовка ${PREP_HOURS} ч уже не укладываются в окно погрузки">
      ⛔ опоздание ${left}</span>`;
  }
  return `<span class="badge ${deadline.hot ? 'warn' : 'ok'}"
    title="Дедлайн = окно погрузки − подгон ближайшей свободной машины (${deadline.feedHours} ч) − подготовка выхода (${PREP_HOURS} ч)">
    ⏳ назначить до ${at} · осталось ${left}</span>`;
}
