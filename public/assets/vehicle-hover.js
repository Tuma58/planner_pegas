// Подсказка по сцепке при наведении: задержал курсор на госномере секунду —
// увидел, что с машиной сейчас, без клика и без открытия карточки.
//
// Данные берутся из уже загруженного bootstrap, поэтому подсказка появляется
// мгновенно и не создаёт запросов: наведение курсора не повод дёргать сервер.
import { driverRatingBadge, driverRatingOf, escapeHtml, formatDateTime, tripBusyFromMs, tripBusyUntilMs } from './api.js';

const HOVER_DELAY_MS = 1000;
const HOUR = 3_600_000;

const KIND_LABEL = {
  repair: '🔧 в ремонте', shift: '🔁 пересменка', no_driver: '👤 без водителя',
  out: '⛔ выведена', reserve: '🅿 резерв под заказ', transfer: '🚚 перегон порожним'
};

// Этап рейса словами — тот же язык, что в контроле на линии.
function tripStage(trip, stops) {
  if (trip.status === 'plan') return '🕓 подготовка выхода';
  if (trip.status === 'unloaded') return '✅ выгружен';
  const list = stops || [];
  const current = list.find(stop => !stop.actual_departure);
  if (!current) return '🛣 в пути';
  const isFirst = current === list[0];
  const isLast = current === list[list.length - 1];
  if (!current.actual_arrival) return isFirst ? '🛣 в пути на погрузку' : isLast ? '🛣 в пути на выгрузку' : '🛣 в пути';
  return isFirst ? '📦 на погрузке' : isLast ? '📥 на выгрузке' : '⏸ на промежуточной точке';
}

function buildHtml(data, vehicleId) {
  const vehicle = (data.vehicles || []).find(item => item.id === vehicleId);
  if (!vehicle) return '';
  const nowMs = Date.now();
  const trips = (data.trips || [])
    .filter(trip => trip.vehicle_id === vehicleId && trip.status !== 'rejected')
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  // Текущий рейс — тот, что уже идёт; следующий ищем среди всех
  // незавершённых, а не только «в плане»: следующий рейс часто выводят
  // на линию заранее, и он тоже получает статус «в пути».
  const active = trips.find(trip => ['run', 'plan'].includes(trip.status) &&
    tripBusyFromMs(trip) <= nowMs && tripBusyUntilMs(trip, nowMs) > nowMs)
    || trips.find(trip => ['run', 'plan'].includes(trip.status));
  const next = active
    ? trips.find(trip => trip.id !== active.id && ['run', 'plan'].includes(trip.status) &&
      String(trip.starts_at) >= String(active.starts_at))
    : null;
  const transfer = (data.dispositions || []).find(item => item.kind === 'transfer' &&
    item.vehicle_id === vehicleId && !item.arrived_at);
  const disposition = (data.dispositions || []).find(item => item.vehicle_id === vehicleId &&
    item.kind !== 'transfer' &&
    Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs);
  const driver = (data.drivers || []).find(item => item.vehicle_id === vehicleId);
  const question = (data.driverQuestions || []).find(item => item.vehicle_id === vehicleId && !item.closed_at);

  const rows = [];
  if (transfer) {
    rows.push(`<b>🚚 перегон порожним</b> → ${escapeHtml(transfer.to_name || '')}
      <small>· ${escapeHtml(transfer.purpose || '')}, прибытие ${formatDateTime(transfer.ends_at)}</small>`);
  } else if (active) {
    const late = active.status === 'run' && !active.arrived_at &&
      nowMs - Date.parse(active.ends_at) > 30 * 60_000;
    rows.push(`<b>${tripStage(active, null)}</b>
      ${escapeHtml(active.from_point || active.from_name || '')} → ${escapeHtml(active.to_point || active.to_name || '')}
      <small>· ${escapeHtml(active.customer_name || '')}</small>`);
    rows.push(`<small>выход ${formatDateTime(active.starts_at)} · выгрузка ${formatDateTime(active.ends_at)}${late
      ? ` · <span class="vhov-bad">опоздание ${Math.floor((nowMs - Date.parse(active.ends_at)) / HOUR)} ч</span>` : ''}</small>`);
  } else if (disposition) {
    rows.push(`<b>${KIND_LABEL[disposition.kind] || disposition.kind}</b>
      <small>· до ${formatDateTime(disposition.ends_at)}${disposition.note ? ` · ${escapeHtml(disposition.note)}` : ''}</small>`);
  } else {
    rows.push('<b>⚠ простой без задания</b>');
  }
  rows.push(next
    ? `<span class="vhov-next">⏭ дальше: ${escapeHtml(next.from_point || next.from_name || '')} →
       ${escapeHtml(next.to_point || next.to_name || '')} · выход ${formatDateTime(next.starts_at)}</span>`
    : '<span class="vhov-warn">⏭ следующее задание не назначено</span>');
  if (question) rows.push('<span class="vhov-warn">📞 есть незакрытый вопрос водителя</span>');

  return `<div class="vhov-head"><b class="mono">${escapeHtml(vehicle.plate)}</b>
      ${vehicle.trailer_plate ? `<span class="mono">/ ${escapeHtml(vehicle.trailer_plate)}</span>` : ''}
      <small>${escapeHtml(driver?.full_name || vehicle.driver_name || 'без водителя')}${driver?.phone
  ? ` · ${escapeHtml(driver.phone)}` : ''}</small>
      ${driverRatingBadge(driverRatingOf(data, vehicleId), { small: true })}</div>
    ${rows.map(row => `<div class="vhov-row">${row}</div>`).join('')}
    <div class="vhov-foot">клик — полная карточка сцепки</div>`;
}

// Одна подсказка на страницу: создаётся при первом наведении и переиспользуется.
let tip = null;
let timer = null;

function hide() {
  clearTimeout(timer);
  if (tip) tip.classList.remove('open');
}

function show(target, html) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'vhov';
    document.body.appendChild(tip);
    // Уход курсора с самой подсказки её закрывает: иначе она перекрывает
    // соседние строки таблицы и мешает работать.
    tip.addEventListener('mouseleave', hide);
  }
  tip.innerHTML = html;
  tip.classList.add('open');
  const rect = target.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  // Ниже элемента, а если снизу не помещается — выше; по горизонтали не
  // вылезаем за экран.
  const top = rect.bottom + box.height + 8 > window.innerHeight
    ? Math.max(8, rect.top - box.height - 6)
    : rect.bottom + 6;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - box.width - 8);
  tip.style.top = `${top + window.scrollY}px`;
  tip.style.left = `${left + window.scrollX}px`;
}

// Подключается один раз: слушаем всю страницу, потому что госномера
// рисуются в каждом блоке и постоянно перерисовываются.
export function setupVehicleHover(getData) {
  document.addEventListener('mouseover', event => {
    const target = event.target.closest('[data-vinfo]');
    if (!target) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const data = getData();
      if (!data) return;
      const html = buildHtml(data, target.dataset.vinfo);
      if (html) show(target, html);
    }, HOVER_DELAY_MS);
  });
  document.addEventListener('mouseout', event => {
    if (!event.target.closest('[data-vinfo]')) return;
    clearTimeout(timer);
    // Даём дойти курсором до самой подсказки, не закрывая её мгновенно.
    setTimeout(() => { if (!tip?.matches(':hover')) hide(); }, 150);
  });
  document.addEventListener('click', hide);
  window.addEventListener('scroll', hide, { passive: true });
}
