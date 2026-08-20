// Карточка ТС для всех ролей: клик по госномеру (Гант, продажи, ресурс)
// открывает окно с полной картиной по сцепке — текущий рейс со ставкой и
// этапом контроля, ремонт/недоступность, простой, ближайший план, комментарий
// продаж с файлами заявки и отметки контролёра (диспетчера) по рейсу.
import { api, escapeHtml, formatDateTime, money, routeLabel } from './api.js';
import { orderFileLinks, orderNet } from './sales.js';
import { shiftStateAt } from './resource.js';

const DAY_MS = 86_400_000;
const KIND_LABEL = { repair: '🔧 Ремонт', shift: '🔁 Пересменка',
  no_driver: '🚫 Без водителя', reserve: '📦 Резерв', out: '⛔ Выведена' };

const tsOf = value => value ? Date.parse(String(value).includes('T')
  ? value : `${String(value).replace(' ', 'T')}Z`) : NaN;

// Статус активного рейса словами — этап конвейера диспетчера.
function tripStage(trip) {
  if (trip.status === 'plan') return '🕓 Подготовка выхода (на линию не выведен)';
  if (trip.status === 'run') {
    if (trip.arrived_at) return `📍 Прибыл на выгрузку ${formatDateTime(trip.arrived_at)} — идёт выгрузка`;
    const lateMs = Date.now() - Date.parse(trip.ends_at);
    return lateMs > 30 * 60_000
      ? `🛣 В пути · опаздывает ~${Math.round(lateMs / 3_600_000 * 10) / 10} ч к расчётной выгрузке`
      : '🛣 В пути · идёт по графику';
  }
  if (trip.status === 'unloaded') {
    return trip.docs_checked_at
      ? `✅ Выгружен ${formatDateTime(trip.unloaded_at)} · документы проверены`
      : `📄 Выгружен ${formatDateTime(trip.unloaded_at)} · документы НЕ проверены`;
  }
  return trip.status;
}

// Отметки контролёра по рейсу за последние дни: «✓ Отработано» с
// обязательным комментарием, свободные заметки подготовки и захват «Беру».
async function dispatcherNotes(tripId, days = 3) {
  const today = Date.now();
  const lists = await Promise.all(Array.from({ length: days }, (_, offset) => {
    const day = new Date(today - offset * DAY_MS).toISOString().slice(0, 10);
    return api(`/api/task-marks?kind=dispatcher&day=${day}`)
      .then(payload => payload.items.map(item => ({ ...item, day })))
      .catch(() => []);
  }));
  return lists.flat().filter(item => item.item_key.includes(tripId));
}

export async function vehicleInfoDialog(vehicleId, data, context) {
  const vehicle = (data.vehicles || []).find(item => item.id === vehicleId);
  if (!vehicle) return;
  const nowMs = Date.now();
  const trips = (data.trips || []).filter(trip =>
    trip.vehicle_id === vehicle.id && trip.status !== 'rejected');

  // Активный рейс: в пути / свежевыгружен без документов (на отслеживании) /
  // в подготовке с уже наступившим выходом.
  const active = trips.find(trip => trip.status === 'run')
    || trips.filter(trip => trip.status === 'unloaded' && !trip.docs_checked_at &&
        nowMs - tsOf(trip.unloaded_at || trip.ends_at) < 3 * DAY_MS)
      .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0]
    || trips.filter(trip => trip.status === 'plan' && Date.parse(trip.starts_at) <= nowMs + DAY_MS)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];

  const dispoNow = (data.dispositions || []).find(item =>
    item.vehicle_id === vehicle.id &&
    Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs);

  // Простой: от последней выгрузки/окончания рейса до «сейчас».
  const lastDone = trips.filter(trip => Date.parse(trip.ends_at) <= nowMs)
    .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
  const idleDays = lastDone ? Math.floor((nowMs - Date.parse(lastDone.ends_at)) / DAY_MS) : null;

  // Ближайший план после «сейчас» (рейс или недоступность).
  const nextTrip = trips.filter(trip => Date.parse(trip.starts_at) > nowMs &&
      trip.id !== active?.id)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const nextDispo = (data.dispositions || []).filter(item =>
    item.vehicle_id === vehicle.id && Date.parse(item.starts_at) > nowMs)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];

  const order = active?.order_id
    ? (data.orders || []).find(item => item.id === active.order_id) : null;

  let stateBlock;
  if (active && (active.status !== 'plan' || !dispoNow)) {
    stateBlock = `<div class="vinfo-state">
      <div class="vinfo-row"><b>${escapeHtml(routeLabel(active))}</b> · ${escapeHtml(active.customer_name || '')}
        ${active.order_no ? `· № ${escapeHtml(active.order_no)}` : ''}</div>
      <div class="vinfo-row muted">выход ${formatDateTime(active.starts_at)} → выгрузка ${formatDateTime(active.ends_at)}
        · ставка ${money(active.revenue_vat)}${Number(active.cash) ? ' 💵 наличные'
          : order ? ` (без НДС ${money(orderNet(order, data))})` : ''}</div>
      <div class="vinfo-row">${tripStage(active)}</div>
      ${order?.comment ? `<div class="sales-comment">💬 Продажи: ${escapeHtml(order.comment)}</div>` : ''}
      ${order ? orderFileLinks(data, order.id) : ''}
      <div class="vinfo-notes" id="vinfoNotes"><small class="muted">⏳ отметки контролёра…</small></div>
    </div>`;
  } else if (dispoNow) {
    stateBlock = `<div class="vinfo-state">
      <div class="vinfo-row"><b>${KIND_LABEL[dispoNow.kind] || dispoNow.kind}</b>
        с ${formatDateTime(dispoNow.starts_at)} по ${formatDateTime(dispoNow.ends_at)}</div>
      ${dispoNow.note ? `<div class="vinfo-row">💬 ${escapeHtml(dispoNow.note)}</div>` : ''}
    </div>`;
  } else {
    stateBlock = `<div class="vinfo-state">
      <div class="vinfo-row"><b>⏸ Простой${idleDays != null && idleDays >= 1 ? ` ${idleDays} дн` : ''}</b>
        ${lastDone ? `— свободна с ${formatDateTime(lastDone.ends_at)} после выгрузки
          в «${escapeHtml(lastDone.to_point || lastDone.to_name || '—')}»` : '— рейсов ещё не было'}</div>
      <div class="vinfo-row muted">Простой — прямые потери: предложите сцепку продажам.</div>
    </div>`;
  }

  context.showModal(`<h2>🚛 <span class="mono">${escapeHtml(vehicle.plate)}${vehicle.trailer_plate
      ? ` / ${escapeHtml(vehicle.trailer_plate)}` : ''}</span></h2>
    ${(() => {
      // Активная периодная подмена: карточку ведёт подменный, не постоянный.
      const sub = (data.driverAssignments || []).find(item =>
        item.vehicle_id === vehicle.id &&
        Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs);
      return `<p class="muted">${sub
        ? `<b>${escapeHtml(sub.driver_name)}</b> <span class="badge warn">подменный до ${String(sub.ends_at).slice(0, 10).split('-').reverse().slice(0, 2).join('.')}</span>
           · постоянный: ${escapeHtml(vehicle.driver_name || '—')}`
        : escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name || '')}
      · приписка: ${escapeHtml(vehicle.zone_name || '—')}
      ${vehicle.status !== 'work' ? ' · <b class="danger">выведена из работы</b>' : ''}</p>`;
    })()}
    ${(() => {
      const subNow = (data.driverAssignments || []).some(item =>
        item.vehicle_id === vehicle.id &&
        Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs);
      const driver = (data.drivers || []).find(item => item.vehicle_id === vehicle.id);
      if (subNow) return '';
      const shift = driver ? shiftStateAt(driver, new Date().toISOString()) : null;
      return shift ? `<p class="${shift.rest ? 'danger' : 'muted'}" style="margin-top:-6px">
        Вахта ${driver.shift_on}/${driver.shift_off}: ${shift.rest
          ? `<b>межвахта до ${new Date(`${shift.until}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</b> — машине нужен подменный водитель`
          : `работает до ${new Date(`${shift.until}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} включительно, дальше межвахта ${driver.shift_off} дн`}</p>` : '';
    })()}
    ${stateBlock}
    ${nextTrip || nextDispo ? `<div class="vinfo-next muted">Дальше по плану: ${nextTrip
      ? `рейс ${escapeHtml(routeLabel(nextTrip))} · выход ${formatDateTime(nextTrip.starts_at)}`
      : `${KIND_LABEL[nextDispo.kind] || nextDispo.kind} с ${formatDateTime(nextDispo.starts_at)}`}</div>` : ''}
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);

  // Отметки контролёра подгружаются после открытия окна (3 последних дня).
  if (active && document.getElementById('vinfoNotes')) {
    const items = await dispatcherNotes(active.id).catch(() => []);
    const box = document.getElementById('vinfoNotes');
    if (!box) return;
    const lines = items.map(item => {
      const key = item.item_key;
      const label = key.startsWith('claim|') ? '🖐 ведёт рейс'
        : key.startsWith('prepnote|') ? '💬 заметка' : '✓ отработано';
      return `<div class="vinfo-note"><b>${escapeHtml(item.done_by || '')}</b> · ${label}
        ${item.note ? `: ${escapeHtml(item.note)}` : ''}
        <small class="muted">${formatDateTime(new Date(tsOf(item.done_at)).toISOString())}</small></div>`;
    });
    box.innerHTML = lines.length
      ? `<div class="vinfo-row"><b>Контролёр:</b></div>${lines.join('')}`
      : '<small class="muted">Отметок контролёра по рейсу пока нет.</small>';
  }
}
