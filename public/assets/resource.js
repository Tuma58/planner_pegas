// Диспозиционный календарь ресурса — перенос renderResourceBoard из прототипа ТК 21:
// плашки-счётчики состояний парка на выбранный день, строки ТС с рейсами (тонкие полосы)
// и интервалами недоступности (цветные бары), клик по свободному дню — новая диспозиция.
import { escapeHtml } from './api.js';

export const DISP_KINDS = [
  { kind: 'work', label: 'В работе', short: 'работа', color: 'var(--teal)' },
  { kind: 'repair', label: 'В ремонте', short: 'ремонт', color: '#ad9268' },
  { kind: 'no_driver', label: 'Без водителя', short: 'без вод.', color: '#a4906f' },
  { kind: 'shift', label: 'Пересменка', short: 'пересм.', color: '#6d84a6' },
  { kind: 'idle', label: 'Без заказа', short: 'без заказа', color: '#8a86a4' },
  { kind: 'out', label: 'Выведен', short: 'выведен', color: '#9aa7b3' }
];

const kindMeta = kind => DISP_KINDS.find(item => item.kind === kind) || DISP_KINDS[0];

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

export function renderResource(container, context) {
  const { state } = context;
  const data = state.data;
  const dayWidth = 30;
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  const days = Math.round((monthEnd - state.month) / 86_400_000);
  const today = new Date().toISOString().slice(0, 10);
  const monthIso = state.month.toISOString().slice(0, 10);
  const inMonth = today >= monthIso && today < monthEnd.toISOString().slice(0, 10);
  const refDay = state.resourceDay || (inMonth ? today : monthIso);
  const filter = state.resourceFilter || null;

  const fleet = data.vehicles;
  const counts = {};
  fleet.forEach(vehicle => {
    const kind = vehicleStateAt(vehicle, data, refDay).kind;
    counts[kind] = (counts[kind] || 0) + 1;
  });

  const badges = DISP_KINDS.map(item =>
    `<button class="dbadge ${filter === item.kind ? 'on' : ''}" data-kind="${item.kind}" style="--dc:${item.color}">
      <span class="dbn">${counts[item.kind] || 0}</span><span class="dbl">${item.short}</span></button>`).join('');

  const head = Array.from({ length: days }, (_, index) => {
    const date = new Date(state.month.getTime() + index * 86_400_000);
    const weekend = [0, 6].includes(date.getUTCDay());
    return `<div class="rday ${weekend ? 'we' : ''}">${index + 1}</div>`;
  }).join('');

  const rows = fleet.map(vehicle => {
    const stateNow = vehicleStateAt(vehicle, data, refDay);
    const dim = filter && stateNow.kind !== filter;
    const trips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
        new Date(trip.starts_at) < monthEnd && new Date(trip.ends_at) > state.month)
      .map(trip => {
        const start = Math.max(0, (Date.parse(trip.starts_at) - state.month.getTime()) / 86_400_000);
        const end = Math.min(days, (Date.parse(trip.ends_at) - state.month.getTime()) / 86_400_000);
        return `<span class="tripu" style="left:${(start * dayWidth).toFixed(0)}px;width:${Math.max((end - start) * dayWidth - 2, 6).toFixed(0)}px"
          title="${escapeHtml(trip.from_name)}→${escapeHtml(trip.to_name)}"></span>`;
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
          title="${meta.label}"><b>${meta.short}</b></span>`;
      }).join('');
    return `<div class="rrow ${dim ? 'dim' : ''}">
      <div class="rfix"><strong class="mono">${escapeHtml(vehicle.plate)}</strong>
        <small class="muted">${escapeHtml(vehicle.driver_name || '—')}</small></div>
      <div class="rtrack" data-vehicle="${vehicle.id}" style="width:${days * dayWidth}px">${trips}${bars}</div>
      <div class="rstate" style="color:${stateNow.color}">${stateNow.label}</div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="resboard">
    <div class="reshead">
      <div class="dbadges">${badges}${filter ? '<button class="dbadge clear" data-kind="">✕ сброс</button>' : ''}</div>
      <div class="resctl">
        <span class="muted" style="font-size:var(--fs-xs)">Плашки на день</span>
        <input type="date" id="resourceDay" value="${refDay}">
        <button class="button small" id="resourceAdd">+ диспозиция</button>
      </div>
    </div>
    <div class="geohint" style="padding:0 2px 8px">Клик по плашке — фильтр ТС по состоянию. Клик по свободному дню строки — добавить период недоступности. Клик по интервалу — изменить.</div>
    <div class="rgridwrap">
      <div class="rrow rhead"><div class="rfix">Сцепка · водитель</div>
        <div class="rtrack rdays" style="width:${days * dayWidth}px">${head}</div>
        <div class="rstate muted">Состояние<br><small>на ${refDay.split('-').reverse().slice(0, 2).join('.')}</small></div></div>
      ${rows}
    </div>
  </div>`;

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
  container.querySelector('#resourceAdd').onclick = () => context.openDisposition(null, {
    vehicle_id: fleet[0]?.id,
    starts_at: `${refDay}T00:00:00.000Z`,
    ends_at: new Date(Date.parse(`${refDay}T00:00:00Z`) + 86_400_000).toISOString()
  });
  container.querySelectorAll('[data-disposition]').forEach(bar =>
    bar.addEventListener('click', () => {
      const item = (data.dispositions || []).find(row => row.id === bar.dataset.disposition);
      if (item) context.openDisposition(item);
    }));
  container.querySelectorAll('.rtrack:not(.rdays)').forEach(track =>
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
