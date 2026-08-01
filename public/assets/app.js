import { api, escapeHtml, formatDate, logout, money, setupTheme, toast } from './api.js';

const state = {
  data: null,
  month: null,
  type: 'all',
  panel: null,
  permissions: new Set()
};

const byId = id => document.getElementById(id);
const can = permission => state.permissions.has(permission);
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86_400_000;
const isoInput = date => new Date(date).toISOString().slice(0, 16);

function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date, count) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function monthDays(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function setupUser() {
  const user = state.data.user;
  state.permissions = new Set(user.permissions);
  byId('profileName').textContent = user.fullName;
  byId('profileRole').textContent = user.roleLabel;
  byId('avatar').textContent = user.fullName.trim().charAt(0).toUpperCase();
  byId('settingsLink').classList.toggle('hidden', user.role !== 'admin');
}

function setupFilters() {
  const types = ['all', ...state.data.reference.vehicleTypes.map(type => type.name)];
  byId('typeFilter').innerHTML = types.map(type =>
    `<button data-type="${escapeHtml(type)}" class="${type === state.type ? 'active' : ''}">
      ${type === 'all' ? 'Все ТС' : escapeHtml(type)}
    </button>`).join('');
  byId('typeFilter').onclick = event => {
    const button = event.target.closest('[data-type]');
    if (!button) return;
    state.type = button.dataset.type;
    setupFilters();
    renderTimeline();
  };
}

function conflictIds(trips) {
  const conflicts = new Set();
  const grouped = {};
  for (const trip of trips.filter(item => item.status !== 'rejected')) {
    (grouped[trip.vehicle_id] ||= []).push(trip);
  }
  for (const vehicleTrips of Object.values(grouped)) {
    for (let i = 0; i < vehicleTrips.length; i += 1) {
      for (let j = i + 1; j < vehicleTrips.length; j += 1) {
        const a = vehicleTrips[i];
        const b = vehicleTrips[j];
        const overlap = Math.min(new Date(a.ends_at), new Date(b.ends_at)) -
          Math.max(new Date(a.starts_at), new Date(b.starts_at));
        if (overlap > 6 * 3_600_000) {
          conflicts.add(a.id);
          conflicts.add(b.id);
        }
      }
    }
  }
  return conflicts;
}

function criticalIds(trips, dispositions) {
  return new Set(trips.filter(trip => trip.status !== 'rejected' && dispositions.some(item =>
    item.vehicle_id === trip.vehicle_id &&
    new Date(trip.starts_at) < new Date(item.ends_at) &&
    new Date(item.starts_at) < new Date(trip.ends_at))).map(trip => trip.id));
}

function renderTimeline() {
  const days = monthDays(state.month);
  const dayWidth = Number(state.data.settings.general.plannerCellWidth || 44);
  document.documentElement.style.setProperty('--planner-day-width', `${dayWidth}px`);
  const monthEnd = addMonths(state.month, 1);
  const vehicles = state.data.vehicles.filter(vehicle =>
    vehicle.status !== 'out' && (state.type === 'all' || vehicle.type_name === state.type));
  const visibleTrips = state.data.trips.filter(trip =>
    new Date(trip.starts_at) < monthEnd && new Date(trip.ends_at) > state.month);
  const conflicts = conflictIds(state.data.trips);
  const critical = criticalIds(state.data.trips, state.data.dispositions || []);
  byId('periodLabel').textContent = new Intl.DateTimeFormat('ru-RU', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(state.month);
  const headerDays = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
    const weekend = [0, 6].includes(date.getUTCDay());
    return `<div class="day-cell ${weekend ? 'weekend' : ''}"><strong>${index + 1}</strong>
      <small>${new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(date)}</small></div>`;
  }).join('');
  const rows = vehicles.map(vehicle => {
    const vehicleTrips = visibleTrips.filter(trip => trip.vehicle_id === vehicle.id);
    const grid = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
      return `<div class="grid-day ${[0, 6].includes(date.getUTCDay()) ? 'weekend' : ''}"></div>`;
    }).join('');
    const trips = vehicleTrips.map(trip => {
      const visibleStart = new Date(Math.max(new Date(trip.starts_at), state.month));
      const visibleEnd = new Date(Math.min(new Date(trip.ends_at), monthEnd));
      const left = Math.max(0, daysBetween(state.month, visibleStart)) * dayWidth;
      const width = Math.max(28, daysBetween(visibleStart, visibleEnd) * dayWidth - 3);
      const color = trip.from_color || '#3b6ea5';
      return `<button class="trip ${conflicts.has(trip.id) ? 'conflict' : ''} ${critical.has(trip.id) ? 'critical' : ''} ${trip.status === 'rejected' ? 'rejected' : ''}"
        data-trip="${trip.id}" style="left:${left}px;width:${width}px;background-color:${color}">
        <strong>${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}</strong>
        <small>${escapeHtml(trip.customer_name)}</small>
      </button>`;
    }).join('');
    return `<div class="vehicle-row">
      <div class="vehicle-cell"><span class="vehicle-stripe"></span>
        <span class="vehicle-title"><strong class="mono">${escapeHtml(vehicle.plate)}</strong>
        <small>${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name)}</small></span>
      </div>
      <div class="track" style="width:${days * dayWidth}px"><div class="track-grid">${grid}</div>${trips}</div>
    </div>`;
  }).join('');
  byId('timeline').innerHTML = vehicles.length
    ? `<div class="timeline-head"><div class="vehicle-cell">Сцепка · водитель</div>${headerDays}</div>${rows}`
    : '<div class="empty-state">Нет ТС по выбранному фильтру</div>';
  document.querySelectorAll('[data-trip]').forEach(button =>
    button.addEventListener('click', () => openTrip(state.data.trips.find(trip => trip.id === button.dataset.trip))));
  const horizonStart = monthStart(new Date(`${state.data.settings.general.horizonStart}T00:00:00Z`));
  const horizonEnd = addMonths(horizonStart, Number(state.data.settings.general.horizonMonths || 12) - 1);
  byId('periodPrev').disabled = state.month <= horizonStart;
  byId('periodNext').disabled = state.month >= horizonEnd;
}

function calculation(fromId, toId, revenue = 0, customerName = '') {
  const settings = state.data.settings.calculation;
  const rate = state.data.reference.routeRates.find(item =>
    item.from_zone_id === fromId && item.to_zone_id === toId)
    || state.data.reference.routeRates.find(item =>
      item.from_zone_id === toId && item.to_zone_id === fromId);
  const distance = Number(rate?.distance_km || 700);
  const gross = Number(revenue || rate?.default_rate_vat || 0);
  const days = distance / settings.dailyMileageKm + settings.handlingDays;
  const vat = /\bИП\b/iu.test(customerName)
    ? Number(settings.individualEntrepreneurVatRate ?? 0.07)
    : Number(settings.vatRate ?? 0.22);
  const variable = distance *
    (Number(settings.costPerKm || 0) + Number(settings.insuranceAndRoadsPerKm || 0)) +
    days * (Number(settings.driverPerTripDay || 0) + Number(settings.refrigerationPerTripDay || 0));
  const profit = gross / (1 + vat) - variable;
  return { distance, gross, days, profit };
}

function zoneOptions(selected) {
  return state.data.reference.zones.map(zone =>
    `<option value="${zone.id}" ${zone.id === selected ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('');
}

function vehicleOptions(selected) {
  return state.data.vehicles.filter(vehicle => vehicle.status === 'work').map(vehicle =>
    `<option value="${vehicle.id}" ${vehicle.id === selected ? 'selected' : ''}>${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.type_name)}</option>`).join('');
}

function showModal(content) {
  byId('modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal">${content}</div></div>`;
  byId('modalRoot').querySelector('.modal-backdrop').onclick = event => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  };
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = closeModal);
}

function closeModal() {
  byId('modalRoot').innerHTML = '';
}

function openNewTrip(order = null) {
  const start = order?.window_from || new Date(state.month).toISOString();
  const end = order?.window_to || new Date(new Date(start).getTime() + 2 * 86_400_000).toISOString();
  showModal(`<form id="tripForm">
    <h2>Новый рейс</h2><p class="muted">Рейс будет сохранен в БД, а для 1С появится исходящее изменение.</p>
    <label class="field">Сцепка<select name="vehicleId" required>${vehicleOptions()}</select></label>
    <div class="form-grid">
      <label class="field">Откуда<select name="fromZoneId">${zoneOptions(order?.from_zone_id)}</select></label>
      <label class="field">Куда<select name="toZoneId">${zoneOptions(order?.to_zone_id)}</select></label>
    </div>
    <label class="field">Заказчик<input name="customerName" value="${escapeHtml(order?.customer_name || '')}"></label>
    <div class="form-grid">
      <label class="field">Температурный режим<input name="temperatureMode" value="${escapeHtml(order?.temperature_mode || '')}"></label>
      <label class="field">Тип кузова<input name="bodyType" value="${escapeHtml(order?.body_type || '')}"></label>
    </div>
    <div class="form-grid">
      <label class="field">Начало<input name="startsAt" type="datetime-local" value="${isoInput(start)}" required></label>
      <label class="field">Окончание<input name="endsAt" type="datetime-local" value="${isoInput(end)}" required></label>
    </div>
    <label class="field">Выручка с НДС, ₽<input name="revenueVat" type="number" min="0" value="${order?.rate_vat || ''}"></label>
    <div class="metric" id="tripCalculation"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button">Добавить рейс</button></div>
  </form>`);
  const form = byId('tripForm');
  const update = () => {
    const values = Object.fromEntries(new FormData(form));
    const result = calculation(values.fromZoneId, values.toZoneId, values.revenueVat, values.customerName);
    byId('tripCalculation').innerHTML =
      `<span>${result.distance.toLocaleString('ru-RU')} км · ${result.days.toFixed(1)} сут.</span>
       <strong class="${result.profit < 0 ? 'danger' : ''}">Прибыль ${money(result.profit)}</strong>`;
  };
  form.addEventListener('input', update);
  update();
  form.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const calc = calculation(values.fromZoneId, values.toZoneId, values.revenueVat, values.customerName);
    try {
      await api('/api/trips', { method: 'POST', body: JSON.stringify({
        ...values, orderId: order?.id, distanceKm: calc.distance,
        revenueVat: Number(values.revenueVat || calc.gross)
      }) });
      closeModal();
      toast('Рейс добавлен');
      await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

function openTrip(trip) {
  const editable = can('trips:write');
  const statusEditable = editable || can('trip-status:write') || can('payments:write');
  const allowedStatuses = state.data.user.role === 'accountant'
    ? state.data.settings.statuses.filter(([id]) => [trip.status, 'paid'].includes(id))
    : state.data.settings.statuses;
  const statuses = allowedStatuses.map(([id, label]) =>
    `<option value="${id}" ${trip.status === id ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  showModal(`<form id="editTripForm">
    <h2>${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}</h2>
    <p class="muted mono">${escapeHtml(trip.vehicle_plate)} · ${escapeHtml(trip.customer_name || 'без заказчика')}</p>
    <div class="summary-grid">
      <div class="metric"><span>Пробег</span><strong>${Number(trip.distance_km).toLocaleString('ru-RU')} км</strong></div>
      <div class="metric"><span>Выручка с НДС</span><strong>${money(trip.revenue_vat)}</strong></div>
    </div>
    ${statusEditable ? `<label class="field">Статус<select name="status">${statuses}</select></label>
      <label class="field">Причина отклонения<select name="rejectionReason">
        <option value="">— не указана —</option>
        ${state.data.settings.rejectionReasons.map(reason => `<option ${trip.rejection_reason === reason ? 'selected' : ''}>${escapeHtml(reason)}</option>`).join('')}
      </select></label>` : ''}
    ${editable ? `<div class="form-grid">
      <label class="field">Начало<input name="startsAt" type="datetime-local" value="${isoInput(trip.starts_at)}"></label>
      <label class="field">Окончание<input name="endsAt" type="datetime-local" value="${isoInput(trip.ends_at)}"></label>
    </div>` : ''}
    <div class="modal-actions">
      ${editable ? '<button type="button" class="button danger" id="deleteTrip">Удалить</button>' : ''}
      <button type="button" class="button ghost" data-close>Закрыть</button>
      ${statusEditable ? '<button class="button">Сохранить</button>' : ''}
    </div>
  </form>`);
  const form = byId('editTripForm');
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`/api/trips/${trip.id}`, {
        method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      closeModal(); toast('Рейс обновлен'); await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
  if (editable) byId('deleteTrip').onclick = async () => {
    if (!confirm('Удалить рейс?')) return;
    try {
      await api(`/api/trips/${trip.id}`, { method: 'DELETE' });
      closeModal(); toast('Рейс удален'); await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

function renderSidePanel() {
  const { user, vehicles, trips, orders, settings } = state.data;
  const calculationSettings = settings.calculation;
  const netRevenue = trips.reduce((sum, trip) => {
    const vat = /\bИП\b/iu.test(trip.customer_name)
      ? Number(calculationSettings.individualEntrepreneurVatRate ?? 0.07)
      : Number(calculationSettings.vatRate ?? 0.22);
    return sum + trip.revenue_vat / (1 + vat);
  }, 0);
  const cost = trips.reduce((sum, trip) => {
    const duration = Math.max(0, daysBetween(trip.starts_at, trip.ends_at));
    return sum + trip.distance_km *
      (Number(calculationSettings.costPerKm || 0) + Number(calculationSettings.insuranceAndRoadsPerKm || 0)) +
      duration * (Number(calculationSettings.driverPerTripDay || 0) +
        Number(calculationSettings.refrigerationPerTripDay || 0));
  }, 0);
  const metrics = `<div class="summary-grid">
    <div class="metric"><span>Рейсов</span><strong>${trips.length}</strong></div>
    <div class="metric"><span>Маржинальный доход</span><strong>${money(netRevenue - cost)}</strong></div>
  </div>`;
  // Панели доступны по правам, а не по роли: администратор с полным набором прав
  // видит все вкладки, остальные роли — свою (вкладки скрыты, если панель одна).
  const availablePanels = [
    { id: 'planning', title: 'Планирование', show: can('trips:write') },
    { id: 'fleet', title: 'Состав ТС', show: can('fleet:write') },
    { id: 'orders', title: 'Заявки', show: can('orders:write') },
    { id: 'summary', title: 'Сводка', show: true }
  ].filter(panel => panel.show);
  if (!availablePanels.some(panel => panel.id === state.panel)) state.panel = availablePanels[0].id;
  const tabs = availablePanels.length > 1
    ? `<div class="segmented panel-tabs">${availablePanels.map(panel =>
        `<button data-panel="${panel.id}" class="${panel.id === state.panel ? 'active' : ''}">${panel.title}</button>`).join('')}</div>`
    : '';

  if (state.panel === 'planning') {
    const newOrders = orders.filter(order => order.status === 'new');
    byId('sidepanel').innerHTML = `${tabs}<h2>Планирование рейсов</h2><p class="muted">Создание и распределение заявок</p>
      ${metrics}<button class="button full" id="newTrip">+ Добавить рейс</button>
      <h3>Новые заявки</h3><div class="list">${newOrders.slice(0, 8).map(order =>
        `<div class="list-item"><span><strong>${escapeHtml(order.from_name)} → ${escapeHtml(order.to_name)}</strong>
        <small class="muted">${escapeHtml(order.customer_name)}</small></span>
        <button class="button ghost small" data-order="${order.id}">В план</button></div>`).join('')
        || '<p class="muted">Новых заявок нет</p>'}</div>`;
    byId('newTrip').onclick = () => openNewTrip();
    document.querySelectorAll('[data-order]').forEach(button =>
      button.onclick = () => openNewTrip(orders.find(order => order.id === button.dataset.order)));
  } else if (state.panel === 'fleet') {
    const work = vehicles.filter(vehicle => vehicle.status === 'work').length;
    const dispositions = state.data.dispositions || [];
    byId('sidepanel').innerHTML = `${tabs}<h2>Состав ТС</h2><p class="muted">Доступность парка и водителей</p>
      <div class="summary-grid"><div class="metric"><span>В работе</span><strong>${work}</strong></div>
      <div class="metric"><span>Всего</span><strong>${vehicles.length}</strong></div></div>
      <button class="button full" id="newDisposition">+ Период недоступности</button>
      <h3>Ремонт, водитель, пересменка</h3>
      <div class="list">${dispositions.slice(0, 12).map(item => `<button class="list-item" data-disposition="${item.id}">
        <span><strong class="mono">${escapeHtml(item.vehicle_plate)}</strong>
        <small class="muted">${escapeHtml(item.kind)} · ${formatDate(item.starts_at)} — ${formatDate(item.ends_at)}</small></span></button>`).join('')
        || '<p class="muted">Интервалов нет</p>'}</div>
      <h3>Парк</h3>
      <div class="list">${vehicles.map(vehicle => `<button class="list-item" data-vehicle="${vehicle.id}"><span>
        <strong class="mono">${escapeHtml(vehicle.plate)}</strong><small class="muted">${escapeHtml(vehicle.driver_name || 'без водителя')}</small>
      </span><span class="badge ${vehicle.status === 'work' ? 'ok' : 'warn'}">${escapeHtml(vehicle.status)}</span></button>`).join('')}</div>`;
    document.querySelectorAll('[data-vehicle]').forEach(button =>
      button.onclick = () => openVehicle(vehicles.find(vehicle => vehicle.id === button.dataset.vehicle)));
    byId('newDisposition').onclick = () => openDisposition();
    document.querySelectorAll('[data-disposition]').forEach(button =>
      button.onclick = () => openDisposition(dispositions.find(item => item.id === button.dataset.disposition)));
  } else if (state.panel === 'orders') {
    byId('sidepanel').innerHTML = `${tabs}<h2>Портфель заявок</h2><p class="muted">Подготовка груза для логиста</p>
      <button class="button full" id="newOrder">+ Новая заявка</button><h3>Ожидают планирования</h3>
      <div class="list">${orders.map(order => `<div class="list-item"><span><strong>${escapeHtml(order.customer_name)}</strong>
      <small class="muted">${escapeHtml(order.from_name)} → ${escapeHtml(order.to_name)}</small></span><b>${money(order.rate_vat)}</b></div>`).join('')}</div>`;
    byId('newOrder').onclick = openNewOrder;
  } else {
    const summaryTitle = availablePanels.length > 1 ? 'Сводка' : user.roleLabel;
    byId('sidepanel').innerHTML = `${tabs}<h2>${escapeHtml(summaryTitle)}</h2><p class="muted">Оперативная сводка по плану</p>${metrics}
      <h3>Активные рейсы</h3><div class="list">${trips.filter(trip => ['run', 'unloaded', 'done'].includes(trip.status)).slice(0, 10).map(trip =>
        `<button class="list-item" data-open-trip="${trip.id}"><span><strong>${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}</strong>
        <small class="muted mono">${escapeHtml(trip.vehicle_plate)}</small></span><span class="badge">${escapeHtml(trip.status)}</span></button>`).join('')}</div>`;
    document.querySelectorAll('[data-open-trip]').forEach(button =>
      button.onclick = () => openTrip(trips.find(trip => trip.id === button.dataset.openTrip)));
  }

  document.querySelectorAll('[data-panel]').forEach(button =>
    button.onclick = () => { state.panel = button.dataset.panel; renderSidePanel(); });
}

function openVehicle(vehicle) {
  const types = state.data.reference.vehicleTypes.map(type =>
    `<option value="${type.id}" ${type.id === vehicle.type_id ? 'selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
  const statuses = [['work', 'В работе'], ['no_driver', 'Без водителя'], ['repair', 'В ремонте'], ['out', 'Выведен']];
  showModal(`<form id="vehicleForm"><h2>Состав ТС</h2>
    <div class="fields">
      <label class="field">Госномер<input name="plate" value="${escapeHtml(vehicle.plate)}" required></label>
      <label class="field">Прицеп<input name="trailerPlate" value="${escapeHtml(vehicle.trailer_plate || '')}"></label>
      <label class="field">Тип<select name="typeId">${types}</select></label>
      <label class="field">Водитель<input name="driverName" value="${escapeHtml(vehicle.driver_name || '')}"></label>
      <label class="field">Зона<select name="zoneId">${zoneOptions(vehicle.zone_id)}</select></label>
      <label class="field">Состояние<select name="status">${statuses.map(([id, label]) =>
        `<option value="${id}" ${vehicle.status === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button></div></form>`);
  byId('vehicleForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`/api/vehicles/${vehicle.id}`, {
        method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      closeModal(); toast('Состав ТС обновлен'); await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

function openDisposition(item = null) {
  const kinds = [
    ['repair', 'В ремонте'], ['no_driver', 'Без водителя'],
    ['shift', 'Пересменка'], ['out', 'Выведен']
  ];
  const start = item?.starts_at || new Date().toISOString();
  const end = item?.ends_at || new Date(Date.now() + 86_400_000).toISOString();
  showModal(`<form id="dispositionForm"><h2>${item ? 'Интервал недоступности' : 'Новый интервал'}</h2>
    <label class="field">Сцепка<select name="vehicleId">${vehicleOptions(item?.vehicle_id)}</select></label>
    <label class="field">Причина<select name="kind">${kinds.map(([id, label]) =>
      `<option value="${id}" ${item?.kind === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <div class="form-grid">
      <label class="field">С<input name="startsAt" type="datetime-local" value="${isoInput(start)}" required></label>
      <label class="field">До<input name="endsAt" type="datetime-local" value="${isoInput(end)}" required></label>
    </div>
    <label class="field">Комментарий<input name="note" value="${escapeHtml(item?.note || '')}"></label>
    <div class="modal-actions">
      ${item ? '<button type="button" class="button danger" id="deleteDisposition">Удалить</button>' : ''}
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button>
    </div></form>`);
  byId('dispositionForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(item ? `/api/dispositions/${item.id}` : '/api/dispositions', {
        method: item ? 'PATCH' : 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      closeModal(); toast('Интервал сохранен'); await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
  if (item) byId('deleteDisposition').onclick = async () => {
    try {
      await api(`/api/dispositions/${item.id}`, { method: 'DELETE' });
      closeModal(); toast('Интервал удален'); await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

function openNewOrder() {
  const start = new Date();
  const end = new Date(Date.now() + 2 * 86_400_000);
  showModal(`<form id="orderForm"><h2>Новая заявка</h2>
    <label class="field">Заказчик<input name="customerName" required></label>
    <div class="form-grid"><label class="field">Откуда<select name="fromZoneId">${zoneOptions()}</select></label>
    <label class="field">Куда<select name="toZoneId">${zoneOptions()}</select></label></div>
    <div class="form-grid">
      <label class="field">Температурный режим<select name="temperatureMode">${state.data.settings.orderOptions.temperatureModes.map(item =>
        `<option>${escapeHtml(item)}</option>`).join('')}</select></label>
      <label class="field">Кузов<select name="bodyType">${state.data.settings.orderOptions.bodyTypes.map(item =>
        `<option>${escapeHtml(item)}</option>`).join('')}</select></label>
    </div>
    <label class="field">Ставка с НДС, ₽<input name="rateVat" type="number" min="0" required></label>
    <div class="form-grid"><label class="field">Окно с<input name="windowFrom" type="datetime-local" value="${isoInput(start)}"></label>
    <label class="field">Окно до<input name="windowTo" type="datetime-local" value="${isoInput(end)}"></label></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button">Создать</button></div>
  </form>`);
  byId('orderForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/orders', {
        method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      closeModal(); toast('Заявка создана'); await reload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

async function showCustomers() {
  try {
    const { items } = await api('/api/customers');
    showModal(`<h2>Справочник заказчиков</h2><p class="muted">${items.length} записей из БД</p>
      <div class="table-wrap"><table><thead><tr><th>Заказчик</th><th>Маршрут</th><th>Рейсов</th><th>Средняя ставка</th></tr></thead>
      <tbody>${items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.from_name || '—')} → ${escapeHtml(item.to_name || '—')}</td>
      <td>${item.trip_count}</td><td>${money(item.average_rate_vat)}</td></tr>`).join('')}</tbody></table></div>
      <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button></div>`);
  } catch (error) { toast(error.message, 'error'); }
}

async function reload() {
  byId('syncState').textContent = '● обновление…';
  state.data = await api('/api/bootstrap');
  byId('syncState').textContent = '● синхронно';
  setupUser();
  setupFilters();
  renderTimeline();
  renderSidePanel();
}

byId('logout').onclick = logout;
setupTheme();
byId('customersButton').onclick = showCustomers;
byId('periodPrev').onclick = () => {
  if (!byId('periodPrev').disabled) state.month = addMonths(state.month, -1);
  renderTimeline();
};
byId('periodNext').onclick = () => {
  if (!byId('periodNext').disabled) state.month = addMonths(state.month, 1);
  renderTimeline();
};

try {
  state.data = await api('/api/bootstrap');
  state.month = monthStart(new Date(`${state.data.settings.general.horizonStart}T00:00:00Z`));
  setupUser();
  setupFilters();
  renderTimeline();
  renderSidePanel();
} catch (error) {
  if (!error.message.includes('Требуется вход')) toast(error.message, 'error');
}
