// Рабочее место логиста — операции над планом, вынесенные из Ганта:
// назначение ТС на подтверждённые заявки, замена ТС на действующем маршруте,
// отклонение рейса с возвратом заявки в продажи, создание рейса вручную.
// Гант остаётся информационным пространством: там смотрят план,
// здесь — управляют им.
import { api, escapeHtml, formValues, formatDateTime, money, routeLabel, toast } from './api.js';
import { inSalesPortfolio, orderStage, waitingLabel } from './pipeline.js';
import { editOrderDialog, rejectOrderDialog } from './sales.js';

const overlaps = (a, b) =>
  Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at);

// Занятость сцепки в период рейса: другие рейсы и интервалы недоступности.
function vehicleBusy(vehicleId, trip, data) {
  const otherTrip = data.trips.find(other => other.id !== trip.id && other.vehicle_id === vehicleId &&
    other.status !== 'rejected' && overlaps(other, trip));
  if (otherTrip) return `рейс ${otherTrip.from_point || otherTrip.from_name}→${otherTrip.to_point || otherTrip.to_name}`;
  const disposition = (data.dispositions || []).find(item => item.vehicle_id === vehicleId &&
    item.kind !== 'work' && overlaps(item, trip));
  if (disposition) return { repair: 'в ремонте', no_driver: 'без водителя', shift: 'пересменка', out: 'выведена' }[disposition.kind] || 'недоступна';
  return null;
}

// Замена ТС на действующем маршруте: свободные в период рейса — сверху,
// занятые показываются с причиной (заменить можно осознанно и на них).
// Используется логистом и диспетчером (внештатные ситуации).
export function replaceVehicleDialog(trip, data, context) {
  const candidates = data.vehicles
    .map(vehicle => ({ vehicle, busy: vehicle.id === trip.vehicle_id ? 'текущая' : vehicleBusy(vehicle.id, trip, data) }))
    .sort((a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy)) || a.vehicle.plate.localeCompare(b.vehicle.plate));
  context.showModal(`<h2>Замена ТС на маршруте</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · ${escapeHtml(trip.customer_name || 'без заказчика')}
      · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}
      · сейчас: <span class="mono">${escapeHtml(trip.vehicle_plate)}</span></p>
    <div class="list" style="max-height:320px;overflow:auto;margin-bottom:10px">
      ${candidates.map(({ vehicle, busy }) => `<button type="button" class="list-item sugtruck"
        data-replace-vehicle="${vehicle.id}" ${vehicle.id === trip.vehicle_id ? 'disabled' : ''}>
        <strong class="mono">${escapeHtml(vehicle.plate)}</strong>
        <small class="muted">${escapeHtml(vehicle.type_name || '')} · ${escapeHtml(vehicle.driver_name || 'без водителя')}</small>
        <span class="badge ${busy ? 'warn' : 'ok'}" style="margin-left:auto">${busy ? escapeHtml(busy) : 'свободна'}</span>
      </button>`).join('')}
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button></div>`);
  document.querySelectorAll('[data-replace-vehicle]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/trips/${trip.id}`, {
          method: 'PATCH', body: JSON.stringify({ vehicleId: button.dataset.replaceVehicle })
        });
        context.closeModal();
        toast('ТС заменено — рейс переставлен в плане');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
}

// Отклонение рейса: причина обязательна — заявка вернётся в продажи как новая.
export function rejectTripDialog(trip, data, context) {
  const reasons = data.settings.rejectionReasons || [];
  context.showModal(`<form id="rejectTripForm">
    <h2>Отклонить рейс</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      · ${escapeHtml(trip.customer_name || 'без заказчика')}</p>
    ${trip.order_id ? '<p class="muted">Связанная заявка вернётся в продажи как новая с указанной причиной.</p>' : ''}
    <label class="field">Причина отклонения
      <select name="rejectionReason" required>
        <option value="">— выберите причину —</option>
        ${reasons.map(reason => `<option>${escapeHtml(reason)}</option>`).join('')}
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button danger">Отклонить рейс</button>
    </div></form>`);
  document.getElementById('rejectTripForm').onsubmit = async event => {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('rejectionReason');
    if (!reason) { toast('Выберите причину', 'error'); return; }
    try {
      await api(`/api/trips/${trip.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'rejected', rejectionReason: reason })
      });
      context.closeModal();
      toast(trip.order_id ? 'Рейс отклонён — заявка вернулась в продажи' : 'Рейс отклонён');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

export function renderLogist(container, context) {
  const { state, can } = context;
  const data = state.data;
  const query = (state.logistQuery || '').toLowerCase();
  const matches = text => !query || text.toLowerCase().includes(query);

  // Очередь на назначение: подтверждённые продажами заявки без ТС (стадия 1),
  // возвращённые из плана — с пометкой, залежавшиеся сверху.
  const queue = data.orders
    .filter(order => inSalesPortfolio(order, data) && orderStage(order, data).stage === 1)
    .filter(order => matches(`${order.customer_name} ${routeLabel(order)}`))
    .sort((a, b) => String(a.window_from).localeCompare(String(b.window_from)));

  // Действующие маршруты: план и в пути; завершённые логисту не нужны.
  const activeTrips = data.trips
    .filter(trip => ['plan', 'run'].includes(trip.status))
    .filter(trip => matches(`${trip.customer_name} ${routeLabel(trip)} ${trip.vehicle_plate}`))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const returned = queue.filter(order => order.returned_at).length;
  const runCount = activeTrips.filter(trip => trip.status === 'run').length;

  const queueCards = queue.map(order => {
    const waiting = order.stage_changed_at
      ? Date.now() - Date.parse(String(order.stage_changed_at).replace(' ', 'T') + (String(order.stage_changed_at).includes('Z') ? '' : 'Z'))
      : 0;
    return `<div class="list-item ordrow ${order.returned_at ? 'pipe-returned' : 'pipe-mine'}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        <small class="muted" style="display:block">окно ${formatDateTime(order.window_from)} → ${formatDateTime(order.window_to)}
          · ${escapeHtml(order.body_type || 'Реф')} ${waiting > 3_600_000 ? ` · ждёт ${waitingLabel(waiting)}` : ''}</small>
        ${order.returned_at ? `<small class="returned-note">↩ вернулась из плана: ${escapeHtml(order.rejection_reason || 'без причины')}</small>` : ''}
      </span>
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        <b>${money(order.rate_vat)}</b>
        <button class="button small" data-assign="${order.id}">Назначить ТС</button>
        <span style="display:flex;gap:5px">
          <button class="button ghost small" data-edit="${order.id}">Изменить</button>
          <button class="button ghost small" data-reject-order="${order.id}">Отклонить</button>
        </span>
      </span>
    </div>`;
  }).join('') || '<p class="muted">Очередь пуста — все подтверждённые заявки обеспечены ТС.</p>';

  const statusMeta = Object.fromEntries((data.settings.statuses || []).map(([id, label, color]) => [id, { label, color }]));
  // Новые назначения ждут подтверждения логиста — только после него рейс
  // уходит в блок «Диспетчер» на подготовку выхода.
  const needConfirm = activeTrips.filter(trip => trip.status === 'plan' && !trip.logist_confirmed_at).length;
  const tripCards = activeTrips.map(trip => {
    const meta = statusMeta[trip.status] || { label: trip.status, color: 'var(--muted)' };
    const unconfirmed = trip.status === 'plan' && !trip.logist_confirmed_at;
    return `<div class="list-item ordrow ${unconfirmed ? 'pipe-mine' : ''}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(routeLabel(trip))}</strong>
        · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
        <small class="muted" style="display:block">${escapeHtml(trip.customer_name || 'без заказчика')}
          · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}
          · ${Number(trip.distance_km).toLocaleString('ru-RU')} км · ${money(trip.revenue_vat)}</small>
      </span>
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        <span class="badge" style="background:${meta.color};color:#fff">${escapeHtml(meta.label)}</span>
        <span style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
          ${unconfirmed && can('trips:write') ? `<button class="button small" data-confirm="${trip.id}"
            title="Проверить сцепку и сроки — рейс уйдёт диспетчеру на подготовку выхода">Подтвердить назначение</button>` : ''}
          <button class="button ${unconfirmed ? 'ghost ' : ''}small" data-replace="${trip.id}" title="Подобрать другую сцепку на этот маршрут">Заменить ТС</button>
          <button class="button ghost small" data-open="${trip.id}" title="Времена, статус, заявка">Карточка</button>
          <button class="button ghost small" data-reject-trip="${trip.id}" title="Причина обязательна; заявка вернётся в продажи">Отклонить</button>
        </span>
      </span>
    </div>`;
  }).join('') || '<p class="muted">Действующих маршрутов нет.</p>';

  container.innerHTML = `<div class="saleswrap">
    <div class="salekpis">
      <div class="skpi"><span class="skl">Ждут назначения ТС</span><span class="skv">${queue.length}</span></div>
      <div class="skpi"><span class="skl">Возвраты из плана</span><span class="skv">${returned}</span></div>
      <div class="skpi" title="Новые назначения: подтвердите — рейс уйдёт диспетчеру"><span class="skl">На подтверждении</span><span class="skv">${needConfirm}</span></div>
      <div class="skpi"><span class="skl">В плане</span><span class="skv">${activeTrips.length - runCount}</span></div>
      <div class="skpi"><span class="skl">В пути</span><span class="skv">${runCount}</span></div>
      <div class="salesfilter" style="flex:1;min-width:220px">
        <input id="logistSearch" class="block-search" placeholder="Поиск: заказчик, маршрут, ТС" value="${escapeHtml(state.logistQuery || '')}" style="flex:1">
        ${can('trips:write') ? '<button class="button small" id="logistNewTrip">+ Рейс</button>' : ''}
      </div>
    </div>
    <div class="salesboard">
      <div class="scol">
        <div class="scolh">Очередь на назначение ТС <span>${queue.length}</span></div>
        <div class="list">${queueCards}</div>
        <div class="geohint">Сюда попадают заявки, подтверждённые продажами, и возвраты из плана.
          Назначение создаёт рейс и передаёт заявку диспетчеру.</div>
      </div>
      <div class="scol">
        <div class="scolh">Действующие маршруты <span>${activeTrips.length}</span></div>
        <div class="list">${tripCards}</div>
        <div class="geohint">«Заменить ТС» переставляет рейс на другую сцепку с проверкой занятости;
          отклонение возвращает заявку в продажи. Гант — просмотр плана, управление — здесь.</div>
      </div>
    </div>
  </div>`;

  const search = container.querySelector('#logistSearch');
  search.oninput = () => {
    state.logistQuery = search.value;
    const caret = search.selectionStart;
    renderLogist(container, context);
    const again = container.querySelector('#logistSearch');
    again.focus();
    again.setSelectionRange(caret, caret);
  };
  container.querySelector('#logistNewTrip')?.addEventListener('click', () => context.openNewTrip());

  container.querySelectorAll('[data-assign]').forEach(button =>
    button.addEventListener('click', () => {
      const order = data.orders.find(item => item.id === button.dataset.assign);
      if (order) context.openAssign(order);
    }));
  container.querySelectorAll('[data-edit]').forEach(button =>
    button.addEventListener('click', () => {
      const order = data.orders.find(item => item.id === button.dataset.edit);
      if (order) editOrderDialog(order, data, context);
    }));
  container.querySelectorAll('[data-reject-order]').forEach(button =>
    button.addEventListener('click', () => {
      const order = data.orders.find(item => item.id === button.dataset.rejectOrder);
      if (order) rejectOrderDialog(order, data, context);
    }));
  container.querySelectorAll('[data-confirm]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/trips/${button.dataset.confirm}/step`, {
          method: 'POST', body: JSON.stringify({ step: 'logist_confirm' })
        });
        toast('Назначение подтверждено — рейс у диспетчера');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
  container.querySelectorAll('[data-replace]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.replace);
      if (trip) replaceVehicleDialog(trip, data, context);
    }));
  container.querySelectorAll('[data-open]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.open);
      if (trip) context.openTrip(trip);
    }));
  container.querySelectorAll('[data-reject-trip]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.rejectTrip);
      if (trip) rejectTripDialog(trip, data, context);
    }));
}
