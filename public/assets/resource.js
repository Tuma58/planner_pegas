// Диспетчерская доска ресурса — гант по аналогии с главным планером:
// строки ТС с рейсами (тонкие полосы) и интервалами недоступности (цветные бары),
// плашки-счётчики состояний, справа — панель заданий сотрудника.
import { escapeHtml, formatDateTime, fromLocalInput } from './api.js';

export const DISP_KINDS = [
  { kind: 'work', label: 'В работе', short: 'работа', color: 'var(--teal)' },
  { kind: 'repair', label: 'В ремонте', short: 'ремонт', color: '#bd8f42' },
  { kind: 'no_driver', label: 'Без водителя', short: 'без вод.', color: '#b06a55' },
  { kind: 'shift', label: 'Пересменка', short: 'пересм.', color: '#5e87ad' },
  { kind: 'idle', label: 'Без заказа', short: 'без заказа', color: '#8a7fb3' },
  { kind: 'out', label: 'Выведен', short: 'выведен', color: '#8f9aa6' }
];

const kindMeta = kind => DISP_KINDS.find(item => item.kind === kind) || DISP_KINDS[0];

const nextDayIso = dayIso => new Date(Date.parse(`${dayIso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// Состояние сцепки на день: диспозиция > статус ТС > рейс > без заказа.
export function vehicleStateAt(vehicle, data, dayIso) {
  const midpoint = Date.parse(`${dayIso}T12:00:00Z`);
  const disposition = (data.dispositions || []).find(item =>
    item.vehicle_id === vehicle.id &&
    Date.parse(item.starts_at) <= midpoint && midpoint < Date.parse(item.ends_at));
  if (disposition) return kindMeta(disposition.kind);
  if (vehicle.status === 'out') return kindMeta('out');
  if (vehicle.status === 'repair') return kindMeta('repair');
  if (vehicle.status === 'no_driver' || !vehicle.driver_name) return kindMeta('no_driver');
  const onTrip = data.trips.some(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
    Date.parse(trip.starts_at) <= midpoint && midpoint < Date.parse(trip.ends_at));
  return onTrip ? kindMeta('work') : kindMeta('idle');
}

// Задания ресурсника: машины, по которым на выбранную дату нет ни заказа,
// ни заполненной диспозиции — по каждой нужно либо дать заказ (логисту),
// либо оформить причину простоя. Давно простаивающие — сверху.
function renderResourceTasks(container, context, refDay, withState) {
  const { state } = context;
  const data = state.data;
  const midpoint = Date.parse(`${refDay}T12:00:00Z`);
  const tasks = withState
    .filter(({ stateNow }) => stateNow.kind === 'idle' || stateNow.kind === 'no_driver')
    .map(({ vehicle, stateNow }) => {
      // Незаполненная диспозиция: состояние вычислено из карточки/простоя,
      // но интервального объяснения в календаре нет.
      const hasDisposition = (data.dispositions || []).some(item =>
        item.vehicle_id === vehicle.id &&
        Date.parse(item.starts_at) <= midpoint && midpoint < Date.parse(item.ends_at));
      if (hasDisposition) return null;
      const lastTrip = data.trips
        .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
          Date.parse(trip.ends_at) <= midpoint)
        .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      const idleMs = lastTrip ? midpoint - Date.parse(lastTrip.ends_at) : null;
      return { vehicle, stateNow, lastTrip, idleMs };
    })
    .filter(Boolean)
    .sort((a, b) => (b.idleMs ?? Infinity) - (a.idleMs ?? Infinity));

  const idleLabel = ms => {
    if (ms == null) return 'без рейсов в данных';
    const days = Math.floor(ms / 86_400_000);
    return days >= 1 ? `простой ${days} дн` : `простой ${Math.max(1, Math.floor(ms / 3_600_000))} ч`;
  };

  container.innerHTML = `<h2>Задания ресурса</h2>
    <p class="muted">На ${refDay.split('-').reverse().join('.')}: ТС без заказа и без
      заполненной диспозиции — оформите причину простоя или передайте логисту.</p>
    <div class="summary-grid">
      <div class="metric"><span>Требуют внимания</span><strong>${tasks.length}</strong></div>
      <div class="metric"><span>Всего в парке</span><strong>${withState.length}</strong></div>
    </div>
    <div class="list">${tasks.map(({ vehicle, stateNow, lastTrip, idleMs }) => `
      <div class="list-item pipe-mine" style="flex-wrap:wrap">
        <span style="flex:1;min-width:0">
          <strong class="mono">${escapeHtml(vehicle.plate)}</strong>
          <span style="color:${stateNow.color};font-size:var(--fs-xs);font-weight:700"> · ${stateNow.label}</span>
          <small class="muted" style="display:block">${escapeHtml(vehicle.driver_name || 'без водителя')} · ${idleLabel(idleMs)}</small>
          ${lastTrip ? `<small class="muted" style="display:block">последний рейс: ${escapeHtml(lastTrip.to_point || lastTrip.to_name)} · ${formatDateTime(lastTrip.ends_at)}</small>` : ''}
        </span>
        <button class="button ghost small" data-task-disposition="${vehicle.id}">Диспозиция</button>
      </div>`).join('') || '<p class="muted">Все машины при деле: у каждой есть заказ или оформленный простой.</p>'}
    </div>`;

  container.querySelectorAll('[data-task-disposition]').forEach(button =>
    button.addEventListener('click', () => context.openDisposition(null, {
      vehicle_id: button.dataset.taskDisposition,
      // Сутки refDay в часовом поясе предприятия, а не UTC.
      starts_at: fromLocalInput(`${refDay}T00:00`),
      ends_at: fromLocalInput(`${nextDayIso(refDay)}T00:00`)
    })));
}

export function renderResource(container, context) {
  const { state } = context;
  const data = state.data;
  // Разметка и метрики главного ганта: та же ширина дня, sticky-шапка и колонка,
  // выходные и маркер «сегодня» — ресурс выглядит и ведёт себя как гант.
  const dayWidth = Number(data.settings.general.plannerCellWidth || 44);
  document.documentElement.style.setProperty('--planner-day-width', `${dayWidth}px`);
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  const days = Math.round((monthEnd - state.month) / 86_400_000);
  const today = new Date().toISOString().slice(0, 10);
  const monthIso = state.month.toISOString().slice(0, 10);
  const inMonth = today >= monthIso && today < monthEnd.toISOString().slice(0, 10);
  const refDay = state.resourceDay || (inMonth ? today : monthIso);
  const filter = state.resourceFilter || null;
  const todayIndex = Math.floor((Date.now() - state.month.getTime()) / 86_400_000);

  const withState = data.vehicles.map(vehicle => ({
    vehicle, stateNow: vehicleStateAt(vehicle, data, refDay)
  }));
  const counts = {};
  withState.forEach(({ stateNow }) => { counts[stateNow.kind] = (counts[stateNow.kind] || 0) + 1; });
  // Режим фильтрации: состояние на день + текстовый поиск по сцепке.
  const query = (state.resourceQuery || '').toLowerCase();
  const visible = withState
    .filter(({ stateNow }) => !filter || stateNow.kind === filter)
    .filter(({ vehicle }) => !query ||
      `${vehicle.plate} ${vehicle.trailer_plate || ''} ${vehicle.driver_name || ''} ${vehicle.type_name || ''}`
        .toLowerCase().includes(query));

  const badges = DISP_KINDS.map(item =>
    `<button class="dbadge ${filter === item.kind ? 'on' : ''}" data-kind="${item.kind}" style="--dc:${item.color}">
      <span class="dbn">${counts[item.kind] || 0}</span><span class="dbl">${item.short}</span></button>`).join('');

  const headerDays = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
    const weekend = [0, 6].includes(date.getUTCDay());
    return `<div class="day-cell ${weekend ? 'weekend' : ''} ${index === todayIndex ? 'today' : ''}"><strong>${index + 1}</strong>
      <small>${new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(date)}</small></div>`;
  }).join('');

  const grid = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
    return `<div class="grid-day ${[0, 6].includes(date.getUTCDay()) ? 'weekend' : ''} ${index === todayIndex ? 'today' : ''}"></div>`;
  }).join('');

  const rows = visible.map(({ vehicle, stateNow }) => {
    const monthTrips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
        new Date(trip.starts_at) < monthEnd && new Date(trip.ends_at) > state.month);
    const trips = monthTrips.map(trip => {
      const start = Math.max(0, (Date.parse(trip.starts_at) - state.month.getTime()) / 86_400_000);
      const end = Math.min(days, (Date.parse(trip.ends_at) - state.month.getTime()) / 86_400_000);
      const width = Math.max((end - start) * dayWidth - 2, 6);
      const route = `${trip.from_point || trip.from_name}→${trip.to_point || trip.to_name}`;
      // Информативная плашка: маршрут прямо на полосе (когда влезает) и полный
      // тултип — заказчик, времена, статус.
      return `<span class="tripu" style="left:${(start * dayWidth).toFixed(0)}px;width:${width.toFixed(0)}px"
        title="${escapeHtml(route)} · ${escapeHtml(trip.customer_name || 'без заказчика')}
${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}">${width >= 68 ? escapeHtml(route) : ''}</span>`;
    }).join('');
    const bars = (data.dispositions || [])
      .filter(item => item.vehicle_id === vehicle.id &&
        new Date(item.starts_at) < monthEnd && new Date(item.ends_at) > state.month)
      .map(item => {
        const meta = kindMeta(item.kind);
        const start = Math.max(0, (Date.parse(item.starts_at) - state.month.getTime()) / 86_400_000);
        const end = Math.min(days, (Date.parse(item.ends_at) - state.month.getTime()) / 86_400_000);
        return `<span class="dbar" data-disposition="${item.id}"
          style="left:${(start * dayWidth).toFixed(0)}px;width:${Math.max((end - start) * dayWidth - 3, 18).toFixed(0)}px;background:${meta.color}"
          title="${meta.label} · ${formatDateTime(item.starts_at)} → ${formatDateTime(item.ends_at)}${item.note ? `
${escapeHtml(item.note)}` : ''}"><b>${meta.short}</b>${item.note ? ` · ${escapeHtml(item.note)}` : ''}</span>`;
      }).join('');
    // Занятость за месяц — сразу видно недогруженные сцепки.
    const busyDays = Math.min(days, Math.round(monthTrips.reduce((sum, trip) =>
      sum + (Math.min(monthEnd, new Date(trip.ends_at)) - Math.max(state.month, new Date(trip.starts_at))) / 86_400_000, 0)));
    return `<div class="vehicle-row">
      <div class="vehicle-cell"><span class="vehicle-stripe" style="background:${stateNow.color}"></span>
        <span class="vehicle-title res-vtitle"><strong class="mono">${escapeHtml(vehicle.plate)}</strong>
        <small>${escapeHtml(vehicle.driver_name || 'без водителя')} · <span style="color:${stateNow.color}">${stateNow.label}</span></small>
        <small>${escapeHtml(vehicle.trailer_plate || 'без прицепа')} · ${escapeHtml(vehicle.type_name || '')} · ${monthTrips.length} р. / ${busyDays} дн</small></span>
      </div>
      <div class="track" data-vehicle="${vehicle.id}" style="width:${days * dayWidth}px">
        <div class="track-grid">${grid}</div>${trips}${bars}</div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="resboard">
    <div class="reshead">
      <div class="dbadges">${badges}${filter ? '<button class="dbadge clear" data-kind="">✕ сброс</button>' : ''}</div>
      <div class="resctl">
        <input id="resourceSearch" class="block-search" placeholder="Поиск: тягач, прицеп, водитель"
          value="${escapeHtml(state.resourceQuery || '')}">
        ${filter || query ? `<span class="muted" style="font-size:var(--fs-xs)">показано ${visible.length} из ${withState.length}</span>` : ''}
        <span class="muted" style="font-size:var(--fs-xs)">Состояние на день</span>
        <input type="date" id="resourceDay" value="${refDay}">
        ${context.openFleet ? '<button class="button ghost small" id="resourceFleet" title="Весь парк: карточки, замена водителя и прицепа, планирование">Справочник ТС</button>' : ''}
        <button class="button small" id="resourceAdd">+ диспозиция</button>
      </div>
    </div>
    <div class="timeline">
      <div class="timeline-head"><div class="vehicle-cell">Сцепка · водитель</div>${headerDays}</div>
      ${rows || '<div class="empty-state">Нет ТС в выбранном состоянии</div>'}
    </div>
  </div>`;

  // Фокус как в главном ганте: «сегодня −3 дня» при первом показе месяца.
  if (todayIndex >= 0 && todayIndex < days && state.resourceScrolledMonth !== state.month.getTime()) {
    state.resourceScrolledMonth = state.month.getTime();
    document.querySelector('.board').scrollLeft = Math.max(0, todayIndex - 3) * dayWidth;
  }

  // Панель заданий сотрудника справа (по аналогии с боковой панелью ганта).
  if (context.taskContainer) renderResourceTasks(context.taskContainer, context, refDay, withState);

  container.querySelectorAll('.dbadge').forEach(button =>
    button.addEventListener('click', () => {
      const kind = button.dataset.kind;
      state.resourceFilter = kind && kind !== filter ? kind : null;
      renderResource(container, context);
    }));
  container.querySelector('#resourceDay').onchange = event => {
    state.resourceDay = event.currentTarget.value;
    renderResource(container, context);
  };
  const searchInput = container.querySelector('#resourceSearch');
  searchInput.oninput = () => {
    state.resourceQuery = searchInput.value;
    const caret = searchInput.selectionStart;
    renderResource(container, context);
    const again = container.querySelector('#resourceSearch');
    again.focus();
    again.setSelectionRange(caret, caret);
  };
  if (context.openFleet) container.querySelector('#resourceFleet').onclick = () => context.openFleet();
  container.querySelector('#resourceAdd').onclick = () => context.openDisposition(null, {
    vehicle_id: data.vehicles[0]?.id,
    starts_at: fromLocalInput(`${refDay}T00:00`),
    ends_at: fromLocalInput(`${nextDayIso(refDay)}T00:00`)
  });
  container.querySelectorAll('[data-disposition]').forEach(bar =>
    bar.addEventListener('click', () => {
      const item = (data.dispositions || []).find(row => row.id === bar.dataset.disposition);
      if (item) context.openDisposition(item);
    }));
  container.querySelectorAll('.track[data-vehicle]').forEach(track =>
    track.addEventListener('click', event => {
      if (event.target.closest('.dbar')) return;
      const rect = track.getBoundingClientRect();
      const day = Math.floor((event.clientX - rect.left) / dayWidth);
      const startsAt = new Date(state.month.getTime() + day * 86_400_000);
      context.openDisposition(null, {
        vehicle_id: track.dataset.vehicle,
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + 86_400_000).toISOString()
      });
    }));
}
