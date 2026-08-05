import { api, attachSearch, escapeHtml, formatDate, formatDateTime, formValues, logout, money, routeLabel, setTimeZone, setupTheme, timeZone, toLocalInput, toast } from './api.js';
import { renderGeoMap } from './map.js';
import { renderBoss } from './boss.js';
import { buildReport } from './reports.js';
import { assignDialog, editOrderDialog, renderSales } from './sales.js';
import { renderLogist } from './logist.js';
import { setupChat } from './chat.js';
import { setupGuide } from './guide.js';
import { DISP_KINDS, renderResource } from './resource.js';
import { renderDispatcher } from './dispatcher.js';
import { waitingLabel } from './pipeline.js';

const state = {
  data: null,
  month: null,
  type: 'all',
  panel: null,
  view: 'gantt',
  permissions: new Set()
};

const byId = id => document.getElementById(id);
const can = permission => state.permissions.has(permission);
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86_400_000;
const isoInput = date => toLocalInput(date);

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
  setTimeZone(state.data.settings.general.timezone);
  const user = state.data.user;
  state.permissions = new Set(user.permissions);
  byId('profileName').textContent = user.fullName;
  byId('profileRole').textContent = user.roleLabel;
  byId('avatar').textContent = user.fullName.trim().charAt(0).toUpperCase();
  byId('settingsLink').classList.toggle('hidden', !(user.roles || [user.role]).includes('admin'));
}

function setupFilters() {
  const types = ['all', ...state.data.reference.vehicleTypes.map(type => type.name)];
  byId('typeFilter').innerHTML = `${types.map(type =>
    `<button data-type="${escapeHtml(type)}" class="${type === state.type ? 'active' : ''}">
      ${type === 'all' ? 'Все ТС' : escapeHtml(type)}
    </button>`).join('')}
    <input id="ganttSearch" class="block-search" placeholder="Поиск: ТС, водитель, заказчик, маршрут"
      value="${escapeHtml(state.ganttQuery || '')}">`;
  byId('typeFilter').onclick = event => {
    const button = event.target.closest('[data-type]');
    if (!button) return;
    state.type = button.dataset.type;
    setupFilters();
    renderTimeline();
  };
  attachSearch(byId('ganttSearch'), value => {
    state.ganttQuery = value;
    renderTimeline();
  });
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
  // «Резерв под заказ» — не недоступность, критичность не создаёт.
  return new Set(trips.filter(trip => trip.status !== 'rejected' && dispositions.some(item =>
    item.kind !== 'reserve' && item.vehicle_id === trip.vehicle_id &&
    new Date(trip.starts_at) < new Date(item.ends_at) &&
    new Date(item.starts_at) < new Date(trip.ends_at))).map(trip => trip.id));
}

function renderTimeline() {
  const days = monthDays(state.month);
  const dayWidth = Number(state.data.settings.general.plannerCellWidth || 44);
  document.documentElement.style.setProperty('--planner-day-width', `${dayWidth}px`);
  const monthEnd = addMonths(state.month, 1);
  const visibleTrips = state.data.trips.filter(trip =>
    new Date(trip.starts_at) < monthEnd && new Date(trip.ends_at) > state.month);
  // Поиск по странице: строка остаётся, если совпала сцепка (номер, водитель,
  // тип) или любой её рейс месяца (маршрут, заказчик).
  const ganttQuery = (state.ganttQuery || '').toLowerCase();
  const vehicleMatches = vehicle =>
    `${vehicle.plate} ${vehicle.driver_name || ''} ${vehicle.type_name || ''}`.toLowerCase().includes(ganttQuery) ||
    visibleTrips.some(trip => trip.vehicle_id === vehicle.id &&
      `${routeLabel(trip)} ${trip.customer_name || ''}`.toLowerCase().includes(ganttQuery));
  const vehicles = state.data.vehicles.filter(vehicle =>
    vehicle.status !== 'out' && (state.type === 'all' || vehicle.type_name === state.type) &&
    (!ganttQuery || vehicleMatches(vehicle)));
  const conflicts = conflictIds(state.data.trips);
  const critical = criticalIds(state.data.trips, state.data.dispositions || []);
  byId('periodLabel').textContent = new Intl.DateTimeFormat('ru-RU', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(state.month);
  const todayIndex = Math.floor((Date.now() - state.month.getTime()) / 86_400_000);
  const isToday = index => index === todayIndex;
  const headerDays = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
    const weekend = [0, 6].includes(date.getUTCDay());
    return `<div class="day-cell ${weekend ? 'weekend' : ''} ${isToday(index) ? 'today' : ''}"><strong>${index + 1}</strong>
      <small>${new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(date)}</small></div>`;
  }).join('');
  // Цвета и подписи видов диспозиций — те же, что в «Ресурсе»: ремонт,
  // пересменка, без водителя и плановая работа различимы прямо на канве.
  const dispositionMeta = kind => DISP_KINDS.find(item => item.kind === kind) ||
    { label: kind, short: kind, color: 'var(--muted)' };
  // Экономика сцепки за открытый месяц: текущая — по рейсам, уже
  // завершившимся ко «вчера-сегодня», прогноз — включая запланированные.
  const calc = state.data.settings.calculation;
  const tripMargin = trip => {
    const vat = trip.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
      ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22);
    const net = trip.revenue_vat / (1 + vat);
    const days = Math.max(0, daysBetween(trip.starts_at, trip.ends_at));
    const variable = trip.distance_km *
      (Number(calc.costPerKm || 0) + Number(calc.insuranceAndRoadsPerKm || 0)) +
      days * (Number(calc.driverPerTripDay || 0) + Number(calc.refrigerationPerTripDay || 0));
    return net - variable;
  };
  const thousands = value => `${Math.round(value / 1000).toLocaleString('ru-RU')} т₽`;
  const nowMs = Date.now();
  const rows = vehicles.map(vehicle => {
    const vehicleTrips = visibleTrips.filter(trip => trip.vehicle_id === vehicle.id);
    const monthTrips = vehicleTrips.filter(trip => trip.status !== 'rejected' &&
      new Date(trip.ends_at) >= state.month && new Date(trip.ends_at) < monthEnd);
    const factMargin = monthTrips.filter(trip => Date.parse(trip.ends_at) <= nowMs)
      .reduce((sum, trip) => sum + tripMargin(trip), 0);
    const forecastMargin = monthTrips.reduce((sum, trip) => sum + tripMargin(trip), 0);
    const grid = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
      return `<div class="grid-day ${[0, 6].includes(date.getUTCDay()) ? 'weekend' : ''} ${isToday(index) ? 'today' : ''}"></div>`;
    }).join('');
    const dispositionBlocks = (state.data.dispositions || [])
      .filter(item => item.vehicle_id === vehicle.id &&
        new Date(item.starts_at) < monthEnd && new Date(item.ends_at) > state.month)
      .map(item => {
        const visibleStart = new Date(Math.max(new Date(item.starts_at), state.month));
        const visibleEnd = new Date(Math.min(new Date(item.ends_at), monthEnd));
        const left = Math.max(0, daysBetween(state.month, visibleStart)) * dayWidth;
        const width = Math.max(10, daysBetween(visibleStart, visibleEnd) * dayWidth - 2);
        const meta = dispositionMeta(item.kind);
        // «Резерв» — фоновая пометка плана, не событие: приглушается,
        // чтобы не спорить с плашками рейсов и проблемными диспозициями.
        return `<span class="dispo ${item.kind === 'reserve' ? 'reserve' : ''}" data-disposition="${item.id}"
          style="left:${left}px;width:${width}px;--dc:${meta.color}"
          title="${meta.label} · ${formatDateTime(item.starts_at)} → ${formatDateTime(item.ends_at)}${item.note ? `
${escapeHtml(item.note)}` : ''}"><b>${meta.short}</b>${item.note && width > 90 ? ` · ${escapeHtml(item.note)}` : ''}</span>`;
      }).join('');
    const trips = vehicleTrips.map(trip => {
      const visibleStart = new Date(Math.max(new Date(trip.starts_at), state.month));
      const visibleEnd = new Date(Math.min(new Date(trip.ends_at), monthEnd));
      const left = Math.max(0, daysBetween(state.month, visibleStart)) * dayWidth;
      const width = Math.max(28, daysBetween(visibleStart, visibleEnd) * dayWidth - 3);
      const color = trip.from_color || '#3b6ea5';
      return `<button class="trip ${conflicts.has(trip.id) ? 'conflict' : ''} ${critical.has(trip.id) ? 'critical' : ''} ${trip.status === 'rejected' ? 'rejected' : ''}"
        data-trip="${trip.id}" style="left:${left}px;width:${width}px;background-color:${color}"
        title="${escapeHtml(routeLabel(trip))}&#10;Геозоны: ${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}&#10;${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}&#10;${escapeHtml(trip.customer_name)}">
        <strong>${escapeHtml(routeLabel(trip))}</strong>
        <small>${escapeHtml(trip.customer_name)}</small>
      </button>`;
    }).join('');
    return `<div class="vehicle-row">
      <div class="vehicle-cell"><span class="vehicle-stripe"></span>
        <span class="vehicle-title res-vtitle"><strong class="mono">${escapeHtml(vehicle.plate)}</strong>
        <small>${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name)}</small>
        <small title="Маржинальный доход сцепки за месяц: факт — по завершившимся рейсам, прогноз — включая запланированные">
          МД: <b style="color:var(--ok)">${thousands(factMargin)}</b> · прогноз <b>${thousands(forecastMargin)}</b> · ${monthTrips.length} р.</small></span>
      </div>
      <div class="track" data-vehicle="${vehicle.id}" style="width:${days * dayWidth}px"><div class="track-grid">${grid}</div>${dispositionBlocks}${trips}</div>
    </div>`;
  }).join('');
  byId('timeline').innerHTML = vehicles.length
    ? `<div class="timeline-head"><div class="vehicle-cell">Сцепка · водитель</div>${headerDays}</div>${rows}`
    : '<div class="empty-state">Нет ТС по выбранному фильтру</div>';
  document.querySelectorAll('[data-trip]').forEach(button =>
    button.addEventListener('click', () => {
      if (button.dataset.suppress) { delete button.dataset.suppress; return; }
      openTrip(state.data.trips.find(trip => trip.id === button.dataset.trip));
    }));
  document.querySelectorAll('[data-disposition]').forEach(block =>
    block.addEventListener('click', () => openDisposition(
      (state.data.dispositions || []).find(item => item.id === block.dataset.disposition))));
  enableTripDrag(dayWidth);
  enableDispositionDraw(dayWidth);
  // При первом показе месяца с текущим днём фокус на «сегодня −3 … +7 дней»:
  // канва прокручивается так, чтобы слева было видно три прошедших дня,
  // а неделя вперёд оставалась в кадре.
  if (todayIndex >= 0 && todayIndex < days && state.autoScrolledMonth !== state.month.getTime()) {
    state.autoScrolledMonth = state.month.getTime();
    document.querySelector('.board').scrollLeft = Math.max(0, todayIndex - 3) * dayWidth;
  }
  const horizonStart = monthStart(new Date(`${state.data.settings.general.horizonStart}T00:00:00Z`));
  const horizonEnd = addMonths(horizonStart, Number(state.data.settings.general.horizonMonths || 12) - 1);
  byId('periodPrev').disabled = state.month <= horizonStart;
  byId('periodNext').disabled = state.month >= horizonEnd;
}

function showDragLabel(x, y, text) {
  let element = document.getElementById('draglabel');
  if (!element) {
    element = document.createElement('div');
    element.id = 'draglabel';
    element.className = 'draglabel';
    document.body.append(element);
  }
  element.style.left = `${x + 12}px`;
  element.style.top = `${y - 32}px`;
  element.innerHTML = text;
  element.style.display = 'block';
}

function hideDragLabel() {
  const element = document.getElementById('draglabel');
  if (element) element.style.display = 'none';
}

// Перетаскивание рейсов по канве (перенос по дням/сцепкам, ручки изменения длительности) — по ТК 21.
function enableTripDrag(dayWidth) {
  if (!can('trips:write')) return;
  const dayMs = 86_400_000;
  document.querySelectorAll('.trip').forEach(element => {
    const trip = state.data.trips.find(item => item.id === element.dataset.trip);
    if (!trip || trip.status === 'rejected') return;
    element.insertAdjacentHTML('beforeend', '<span class="hres l"></span><span class="hres r"></span>');
    const durationDays = Math.max(1, Math.round(daysBetween(trip.starts_at, trip.ends_at)));
    let mode = null, startX = 0, moved = false, deltaDays = 0, targetVehicle = null;
    let originLeft = 0, originWidth = 0;
    element.addEventListener('pointerdown', event => {
      mode = event.target.classList.contains('hres')
        ? (event.target.classList.contains('l') ? 'l' : 'r') : 'move';
      startX = event.clientX; moved = false; deltaDays = 0; targetVehicle = null;
      originLeft = parseFloat(element.style.left); originWidth = parseFloat(element.style.width);
      element.setPointerCapture(event.pointerId);
      element.classList.add('dragging');
      event.preventDefault();
    });
    element.addEventListener('pointermove', event => {
      if (!mode) return;
      const dx = event.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      deltaDays = Math.round(dx / dayWidth);
      if (mode === 'move') {
        element.style.left = `${originLeft + deltaDays * dayWidth}px`;
        element.style.pointerEvents = 'none';
        const track = document.elementFromPoint(event.clientX, event.clientY)?.closest('.track');
        element.style.pointerEvents = '';
        targetVehicle = track?.dataset.vehicle && track.dataset.vehicle !== trip.vehicle_id
          ? track.dataset.vehicle : null;
      } else if (mode === 'r') {
        deltaDays = Math.max(deltaDays, 1 - durationDays);
        element.style.width = `${Math.max(28, originWidth + deltaDays * dayWidth)}px`;
      } else {
        deltaDays = Math.min(deltaDays, durationDays - 1);
        element.style.left = `${originLeft + deltaDays * dayWidth}px`;
        element.style.width = `${Math.max(28, originWidth - deltaDays * dayWidth)}px`;
      }
      const shiftStart = mode !== 'r' ? deltaDays : 0;
      const shiftEnd = mode !== 'l' ? deltaDays : 0;
      const from = new Date(Date.parse(trip.starts_at) + shiftStart * dayMs);
      const to = new Date(Date.parse(trip.ends_at) + shiftEnd * dayMs);
      const plate = targetVehicle
        ? state.data.vehicles.find(vehicle => vehicle.id === targetVehicle)?.plate : '';
      showDragLabel(event.clientX, event.clientY,
        `${formatDateTime(from)} → ${formatDateTime(to)}${plate ? `<span> · на ${escapeHtml(plate)}</span>` : ''}`);
    });
    element.addEventListener('pointerup', async event => {
      if (!mode) return;
      const finished = mode;
      mode = null;
      element.releasePointerCapture(event.pointerId);
      element.classList.remove('dragging');
      hideDragLabel();
      if (!moved) return;
      element.dataset.suppress = '1';
      const shift = value => new Date(Date.parse(value) + deltaDays * dayMs).toISOString();
      let payload = null;
      if (finished === 'move' && (deltaDays || targetVehicle)) {
        payload = { startsAt: shift(trip.starts_at), endsAt: shift(trip.ends_at) };
        if (targetVehicle) payload.vehicleId = targetVehicle;
      } else if (finished === 'r' && deltaDays) {
        payload = { endsAt: shift(trip.ends_at) };
      } else if (finished === 'l' && deltaDays) {
        payload = { startsAt: shift(trip.starts_at) };
      }
      if (!payload) { renderTimeline(); return; }
      try {
        await api(`/api/trips/${trip.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast(targetVehicle ? 'Рейс перенесён на другую сцепку' : 'Сроки рейса обновлены');
        await reload();
      } catch (error) {
        toast(error.message, 'error');
        renderTimeline();
      }
    });
  });
}

// Рисование интервала недоступности мышью по пустой области строки ТС — по ТК 21.
function enableDispositionDraw(dayWidth) {
  if (!can('fleet:write')) return;
  const dayMs = 86_400_000;
  document.querySelectorAll('.track').forEach(track => {
    track.addEventListener('pointerdown', event => {
      if (event.target.closest('.trip') || event.target.closest('.dispo')) return;
      const rect = track.getBoundingClientRect();
      const startDay = Math.floor((event.clientX - rect.left) / dayWidth);
      const selection = document.createElement('span');
      selection.className = 'draw-select';
      track.append(selection);
      let range = [startDay, startDay + 1];
      const update = day => {
        range = [Math.min(startDay, day), Math.max(startDay, day) + 1];
        selection.style.left = `${range[0] * dayWidth}px`;
        selection.style.width = `${(range[1] - range[0]) * dayWidth - 2}px`;
      };
      update(startDay);
      track.setPointerCapture(event.pointerId);
      const onMove = moveEvent => update(Math.floor((moveEvent.clientX - rect.left) / dayWidth));
      const onUp = () => {
        track.removeEventListener('pointermove', onMove);
        track.removeEventListener('pointerup', onUp);
        selection.remove();
        openDisposition(null, {
          vehicle_id: track.dataset.vehicle,
          starts_at: new Date(state.month.getTime() + range[0] * dayMs).toISOString(),
          ends_at: new Date(state.month.getTime() + range[1] * dayMs).toISOString()
        });
      };
      track.addEventListener('pointermove', onMove);
      track.addEventListener('pointerup', onUp);
    });
  });
}

function renderLegend() {
  byId('legend').innerHTML = state.data.reference.zones.map(zone =>
    `<span class="lg"><span class="sw" style="background:${zone.color}"></span>${escapeHtml(zone.name)}</span>`).join('');
}

// Главные экраны (перенос ролевых экранов ТК 21), доступ по правам.
const MAIN_VIEWS = [
  { id: 'gantt', title: 'Гант', show: () => true },
  { id: 'sales', title: 'Продажи', show: () => can('orders:write') },
  { id: 'logist', title: 'Логист', show: () => can('trips:write') },
  { id: 'dispatcher', title: 'Диспетчер', show: () => true },
  { id: 'resource', title: 'Ресурс', show: () => can('fleet:write') },
  { id: 'boss', title: 'Руководитель', show: () => can('reports:read') }
];

function renderViewTabs() {
  const views = MAIN_VIEWS.filter(view => view.show());
  byId('viewTabs').innerHTML = views.length > 1
    ? views.map(view =>
        `<button data-view="${view.id}" class="${view.id === state.view ? 'active' : ''}">${view.title}</button>`).join('')
    : '';
  byId('viewTabs').onclick = event => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    if (state.view === 'boss') state.bossWarm = true;
    renderViewTabs();
    renderMain();
  };
}

function renderMain() {
  const isGantt = state.view === 'gantt';
  const isResource = state.view === 'resource';
  // Ресурс — тоже гант: ему нужны навигация по месяцу, прокрутка и боковая панель заданий.
  const timelineView = isGantt || isResource;
  ['periodPrev', 'periodLabel', 'periodNext', 'scrollNav'].forEach(id =>
    byId(id).classList.toggle('hidden', !timelineView));
  byId('typeFilter').classList.toggle('hidden', !isGantt);
  byId('legend').classList.toggle('hidden', !isGantt);
  // Правая панель осталась только у «Ресурса» (задания сотрудника):
  // Гант — информационное пространство на всю ширину, оперативная
  // сводка переехала на доску продаж.
  byId('sidepanel').classList.toggle('hidden', !isResource);
  document.querySelector('.planner-layout').classList.toggle('full', !isResource);
  if (isGantt) {
    renderTimeline();
  } else if (state.view === 'boss') {
    byId('timeline').innerHTML = '<div class="empty-state">Загрузка отчёта…</div>';
    renderBoss(byId('timeline'), { state, onReload: reload, openReport });
  } else if (state.view === 'sales') {
    renderSales(byId('timeline'), {
      state, can, onReload: reload, showModal, closeModal, openTrip,
      openAssign: order => assignDialog(order, state.data, showModal, closeModal, reload)
    });
  } else if (state.view === 'resource') {
    renderResource(byId('timeline'), {
      state, openDisposition, openFleet: openFleetDirectory,
      openDrivers: openDriversDirectory, openStats: openResourceStats,
      onReload: reload, taskContainer: byId('sidepanel')
    });
  } else if (state.view === 'dispatcher') {
    renderDispatcher(byId('timeline'), { state, can, showModal, closeModal, onReload: reload });
  } else if (state.view === 'logist') {
    renderLogist(byId('timeline'), {
      state, can, onReload: reload, showModal, closeModal, openTrip, openNewTrip,
      // Логист назначает сам — его подтверждение проходит автоматически.
      openAssign: order => assignDialog(order, state.data, showModal, closeModal, reload, { autoConfirm: true })
    });
  }
}

async function openReport(kind, from, to) {
  showModal('<div class="empty-state">Формирование отчёта…</div>', 'wide');
  try {
    const content = await buildReport(kind, from, to, state.data);
    showModal(`${content}
      <div class="modal-actions no-print">
        <button type="button" class="button ghost" id="reportPrint">Печать / PDF</button>
        <button type="button" class="button" data-close>Закрыть</button>
      </div>`, 'wide printable');
    byId('reportPrint').onclick = () => window.print();
  } catch (error) {
    toast(error.message, 'error');
    closeModal();
  }
}

async function refreshExceptions() {
  try {
    state.exceptions = await api('/api/exceptions');
    const chip = byId('exceptionsChip');
    chip.textContent = `⚠ Требует решения ${state.exceptions.count}`;
    chip.classList.remove('hidden');
    chip.classList.toggle('warn', state.exceptions.count > 0);
  } catch { /* нет права planner:read — чип остаётся скрытым */ }
}

// После выполненного действия проблема исчезает из реестра: данные перезагружаются,
// шторка перерисовывается уже без решённой позиции (или закрывается, если проблем нет).
async function resolveAndRefresh(action, successMessage) {
  try {
    await action();
    toast(successMessage);
    await reload();
    await refreshExceptions();
    if (state.exceptions?.count > 0 || (state.exceptions?.unavailableVehicles || []).length) openExceptions();
    else closeModal();
  } catch (error) { toast(error.message, 'error'); }
}

function openExceptions() {
  const data = state.exceptions;
  if (!data) return;
  const tripRow = (trip, badge, title, actions) => `<div class="list-item exrow">
    <span style="flex:1;min-width:0">
      <strong>${escapeHtml(routeLabel(trip))}</strong>
      <small class="muted" style="display:block"><span class="mono">${escapeHtml(trip.vehicle_plate || '')}</span>
        · ${formatDateTime(trip.starts_at)} · ${escapeHtml(trip.customer_name)}
        ${trip.rejection_reason ? ` · ${escapeHtml(trip.rejection_reason)}` : ''}</small>
    </span>
    <span class="exactions"><span class="badge ${badge}">${title}</span>${actions}</span>
  </div>`;
  const section = (title, items, badge, actionsFor) => items.length
    ? `<h3>${title} (${items.length})</h3><div class="list">${items.map(trip =>
        tripRow(trip, badge, title, actionsFor(trip))).join('')}</div>`
    : '';

  const criticalActions = trip => `
    ${can('trips:write') ? `<button class="button ghost small" data-ex-shift="${trip.id}"
      title="Перенести начало рейса на конец интервала недоступности">Сдвинуть после простоя</button>` : ''}
    <button class="button ghost small" data-ex-open="${trip.id}">Открыть</button>`;
  const conflictActions = trip => `
    <button class="button ghost small" data-ex-open="${trip.id}"
      title="Откройте рейс и измените сроки или сцепку — конфликт уйдёт сам">Открыть</button>`;
  // Отклонённые рейсы ушли из оперативного реестра — их реестр с причинами
  // формирует отчёт руководителя «Отклонённые рейсы».
  // Опоздания в пути временно убраны из оперативного реестра (по решению
  // пользователя, вернёмся позже) — пунктуальность видна в отчёте
  // «Контроль выполнения рейсов».
  const delayedSection = '';

  const orderSection = (title, items, badge, note, actionsFor) => items.length
    ? `<h3>${title} (${items.length})</h3><div class="list">${items.map(order => `<div class="list-item exrow">
        <span style="flex:1;min-width:0">
          <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
          <small class="muted" style="display:block">${note}: ${escapeHtml(order.rejection_reason || 'без причины')}</small>
        </span>
        <span class="exactions"><span class="badge ${badge}">${title}</span>${actionsFor(order)}</span>
      </div>`).join('')}</div>`
    : '';
  // Отклонённые заявки не показываются в оперативном реестре: они
  // архивируются с причиной в «Отклонённых заявках» доски продаж
  // (оттуда же возвращаются в работу) и в отчёте «Реестр заявок».
  const returnedOrderActions = () => `<button class="button ghost small" data-ex-to-sales
    title="Перейти в продажи и назначить ТС заново">В продажи</button>`;

  const unavailable = (data.unavailableVehicles || []).length
    ? `<h3>ТС вне работы</h3><div class="list">${data.unavailableVehicles.map(row =>
        `<div class="list-item"><span>${{ repair: 'В ремонте', no_driver: 'Без водителя', out: 'Выведены' }[row.status] || row.status}</span>
         <span class="badge warn">${row.count}</span></div>`).join('')}
      <div class="geohint">Управляется в «Ресурсе» и карточках ТС; счётчик информационный.</div>`
    : '';
  showModal(`<h2>Требует решения</h2>
    ${data.count === 0 ? '<p class="muted">Проблем нет — план чист.</p>' : ''}
    ${delayedSection}
    ${section('Критичный', data.critical, 'bad', criticalActions)}
    ${section('Конфликт', data.conflicts, 'warn', conflictActions)}
    ${orderSection('Вернулась из плана', data.returnedOrders || [], 'warn', 'причина возврата', returnedOrderActions)}
    ${unavailable}
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);

  const tripById = id => state.data.trips.find(item => item.id === id);
  document.querySelectorAll('[data-ex-open]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = tripById(button.dataset.exOpen);
      if (trip) { closeModal(); openTrip(trip); }
    }));
  // Критичный: перенос рейса за конец пересекающего интервала недоступности.
  document.querySelectorAll('[data-ex-shift]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = tripById(button.dataset.exShift);
      if (!trip) return;
      const blocker = (state.data.dispositions || [])
        .filter(item => item.kind !== 'reserve' && item.vehicle_id === trip.vehicle_id &&
          Date.parse(trip.starts_at) < Date.parse(item.ends_at) &&
          Date.parse(item.starts_at) < Date.parse(trip.ends_at))
        .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      if (!blocker) { toast('Интервал недоступности уже снят', 'error'); return; }
      const duration = Date.parse(trip.ends_at) - Date.parse(trip.starts_at);
      const startsAt = blocker.ends_at;
      const endsAt = new Date(Date.parse(startsAt) + duration).toISOString();
      resolveAndRefresh(
        () => api(`/api/trips/${trip.id}`, { method: 'PATCH', body: JSON.stringify({ startsAt, endsAt }) }),
        `Рейс перенесён на ${formatDateTime(startsAt)}`);
    }));
  document.querySelectorAll('[data-ex-to-sales]').forEach(button =>
    button.addEventListener('click', () => {
      closeModal();
      document.querySelector('[data-view="sales"]')?.click();
    }));
  document.querySelectorAll('[data-ex-control]').forEach(button =>
    button.addEventListener('click', () => {
      closeModal();
      document.querySelector('[data-view="dispatcher"]')?.click();
    }));
}

function openGeoMap() {
  // День по умолчанию: сегодня, если попадает в открытый месяц, иначе 1-е число месяца.
  const monthEnd = addMonths(state.month, 1);
  let day = new Date();
  if (day < state.month || day >= monthEnd) day = new Date(state.month);
  const dayMs = 86_400_000;
  const rerender = () => {
    const dayIso = day.toISOString().slice(0, 10);
    byId('geoLabel').textContent = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'long', timeZone: 'UTC'
    }).format(day);
    byId('geoBody').innerHTML = renderGeoMap(state.data, dayIso);
  };
  showModal(`<h2>🗺 Карта геозон</h2>
    <div class="period-nav" style="margin:8px 0 12px">
      <button class="button ghost small" id="geoPrev">←</button>
      <strong id="geoLabel"></strong>
      <button class="button ghost small" id="geoNext">→</button>
    </div>
    <div id="geoBody"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');
  byId('geoPrev').onclick = () => { day = new Date(day.getTime() - dayMs); rerender(); };
  byId('geoNext').onclick = () => { day = new Date(day.getTime() + dayMs); rerender(); };
  rerender();
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
  const vat = /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(customerName)
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

function showModal(content, variant = '') {
  byId('modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal ${variant}">${content}</div></div>`;
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
    const values = formValues(form);
    const result = calculation(values.fromZoneId, values.toZoneId, values.revenueVat, values.customerName);
    byId('tripCalculation').innerHTML =
      `<span>${result.distance.toLocaleString('ru-RU')} км · ${result.days.toFixed(1)} сут.</span>
       <strong class="${result.profit < 0 ? 'danger' : ''}">Прибыль ${money(result.profit)}</strong>`;
  };
  form.addEventListener('input', update);
  update();
  form.onsubmit = async event => {
    event.preventDefault();
    const values = formValues(form);
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
  // Набор статусов — по правам (с мульти-ролями права объединяются):
  // только payments:write → доступна лишь отметка оплаты.
  const allowedStatuses = !editable && !can('trip-status:write') && can('payments:write')
    ? state.data.settings.statuses.filter(([id]) => [trip.status, 'paid'].includes(id))
    : state.data.settings.statuses;
  const statuses = allowedStatuses.map(([id, label]) =>
    `<option value="${id}" ${trip.status === id ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  showModal(`<form id="editTripForm">
    <h2>${escapeHtml(routeLabel(trip))}</h2>
    ${trip.from_point || trip.to_point ? `<p class="muted">Геозоны: ${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}</p>` : ''}
    <p class="muted mono">${escapeHtml(trip.vehicle_plate)} · ${escapeHtml(trip.customer_name || 'без заказчика')}</p>
    <p class="muted">${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)} ·
      ${Math.round(daysBetween(trip.starts_at, trip.ends_at) * 24)} ч в рейсе</p>
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
      ${trip.order_id && (editable || can('orders:write')) ? `<button type="button" class="button ghost" id="tripToOrder"
        title="Изменить потребность клиента: сумму, окно, пункты">Заявка</button>` : ''}
      <button type="button" class="button ghost" id="tripToControl"
        title="Подготовка выхода, линия и внештатные ситуации">Диспетчер</button>
      <button type="button" class="button ghost" data-close>Закрыть</button>
      ${statusEditable ? '<button class="button">Сохранить</button>' : ''}
    </div>
  </form>`);
  byId('tripToControl').onclick = () => {
    closeModal();
    state.dispatcherQuery = trip.vehicle_plate || '';
    document.querySelector('[data-view="dispatcher"]')?.click();
  };
  // Блок логиста: правка потребности (сумма, окно) прямо из карточки рейса.
  const tripToOrder = byId('tripToOrder');
  if (tripToOrder) tripToOrder.onclick = () => {
    const order = state.data.orders.find(item => item.id === trip.order_id);
    if (!order) { toast('Заявка не найдена', 'error'); return; }
    closeModal();
    editOrderDialog(order, state.data, { showModal, closeModal, onReload: reload, openTrip });
  };
  const form = byId('editTripForm');
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`/api/trips/${trip.id}`, {
        method: 'PATCH', body: JSON.stringify(formValues(form))
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

// Карточка ТС: правка существующей сцепки или создание новой (vehicle = null).
// after — возврат в вызвавший экран (например, в справочник ТС) после сохранения.
function openVehicle(vehicle = null, after = null) {
  const types = state.data.reference.vehicleTypes.map(type =>
    `<option value="${type.id}" ${type.id === vehicle?.type_id ? 'selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
  const statuses = [['work', 'В работе'], ['no_driver', 'Без водителя'], ['repair', 'В ремонте'], ['out', 'Выведен']];
  showModal(`<form id="vehicleForm"><h2>${vehicle ? 'Карточка ТС' : 'Новая сцепка'}</h2>
    <div class="fields">
      <label class="field">Госномер<input name="plate" value="${escapeHtml(vehicle?.plate || '')}" required></label>
      <label class="field">Прицеп<input name="trailerPlate" value="${escapeHtml(vehicle?.trailer_plate || '')}"></label>
      <label class="field">Тип<select name="typeId">${types}</select></label>
      <label class="field">Водитель<input name="driverName" value="${escapeHtml(vehicle?.driver_name || '')}"></label>
      <label class="field">Зона<select name="zoneId">${zoneOptions(vehicle?.zone_id)}</select></label>
      <label class="field">Состояние<select name="status">${statuses.map(([id, label]) =>
        `<option value="${id}" ${(vehicle?.status || 'work') === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button></div></form>`);
  byId('vehicleForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(vehicle ? `/api/vehicles/${vehicle.id}` : '/api/vehicles', {
        method: vehicle ? 'PATCH' : 'POST',
        body: JSON.stringify(formValues(event.currentTarget))
      });
      closeModal(); toast(vehicle ? 'Состав ТС обновлен' : 'Сцепка добавлена'); await reload();
      if (after) after();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Быстрая замена одного поля сцепки (водитель, прицеп) из справочника ТС.
function replaceVehicleField(vehicle, field, title, after) {
  const current = field === 'driverName' ? vehicle.driver_name : vehicle.trailer_plate;
  showModal(`<form id="replaceForm"><h2>${title}</h2>
    <p class="muted"><span class="mono">${escapeHtml(vehicle.plate)}</span> · сейчас: ${escapeHtml(current || '—')}</p>
    <label class="field">${field === 'driverName' ? 'Новый водитель' : 'Новый прицеп'}
      <input name="${field}" value="${escapeHtml(current || '')}" required autofocus></label>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Заменить</button></div></form>`);
  byId('replaceForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`/api/vehicles/${vehicle.id}`, {
        method: 'PATCH', body: JSON.stringify(formValues(event.currentTarget))
      });
      closeModal(); toast('Замена выполнена'); await reload();
      if (after) after();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Аналитика ресурса: вклад каждой сцепки за открытый месяц — машино-дни
// по состояниям, КТГ, использование со светофором и выручка. Те же формулы,
// что в отчёте руководителя (общий серверный расчёт).
async function openResourceStats() {
  const from = state.month.toISOString().slice(0, 10);
  const to = addMonths(state.month, 1).toISOString().slice(0, 10);
  showModal('<div class="empty-state">Расчёт аналитики…</div>', 'wide');
  let stats;
  try {
    stats = await api(`/api/resource-stats?from=${from}&to=${to}`);
  } catch (error) { toast(error.message, 'error'); closeModal(); return; }
  const rows = [...stats.items].sort((a, b) => a.utilization - b.utilization);
  const light = value => value >= 0.7 ? 'ok' : value >= 0.45 ? 'warn' : 'bad';
  const monthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(state.month);
  showModal(`<h2>Аналитика ресурса · ${escapeHtml(monthLabel)}</h2>
    <p class="muted">${stats.days} дн · машино-дни по состояниям, проблемные сверху ·
      те же формулы, что в отчёте руководителя (КТГ, использование фонда)</p>
    <div style="overflow:auto;max-height:62vh"><table class="rtable"><thead><tr>
      <th>Сцепка</th><th class="num">Работа</th><th class="num">Ремонт</th><th class="num">Без вод.</th>
      <th class="num">Пересм.</th><th class="num">Простой</th><th class="num">КТГ</th>
      <th class="num">Использование</th><th class="num">Рейсов</th><th class="num">Выручка б.НДС</th>
    </tr></thead><tbody>
    ${rows.map(row => `<tr>
      <td><strong class="mono">${escapeHtml(row.plate)}</strong>
        <small class="muted" style="display:block">${escapeHtml(row.driver || 'без водителя')} · ${escapeHtml(row.type)}</small></td>
      <td class="num">${row.work}</td><td class="num ${row.repair > 5 ? 'bad' : ''}">${row.repair}</td>
      <td class="num ${row.noDriver > 5 ? 'bad' : ''}">${row.noDriver}</td>
      <td class="num">${row.shift}</td>
      <td class="num ${row.idle > 7 ? 'bad' : row.idle > 3 ? 'warn' : ''}">${row.idle}</td>
      <td class="num">${(row.ktg * 100).toFixed(0)}%</td>
      <td class="num"><span class="badge ${light(row.utilization)}">${(row.utilization * 100).toFixed(0)}%</span></td>
      <td class="num">${row.trips}</td>
      <td class="num">${money(row.netRevenue)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');
}

// Справочник водителей блока «Ресурс»: закрепление за сцепками,
// отпуска/болезни (авто-интервал «без водителя» на ТС), «кто без машины».
function openDriversDirectory() {
  const drivers = state.data.drivers || [];
  const vehicles = state.data.vehicles;
  const back = () => openDriversDirectory();
  const query = (state.driversQuery || '').toLowerCase();
  const filtered = drivers.filter(driver => !query ||
    `${driver.full_name} ${driver.phone} ${driver.vehicle_plate || ''}`.toLowerCase().includes(query));
  const freeDrivers = filtered.filter(driver => !driver.vehicle_id && driver.status === 'active');
  const statusMeta = {
    active: ['в строю', 'ok'], vacation: ['отпуск', 'warn'], sick: ['болен', 'warn']
  };
  // Свободные сцепки + текущая сцепка водителя — для перезакрепления.
  const vehicleOptionsFor = driver => {
    const taken = new Set(drivers.filter(d => d.vehicle_id && d.id !== driver.id).map(d => d.vehicle_id));
    return `<option value="">— без машины —</option>` + vehicles
      .filter(vehicle => vehicle.status !== 'out' && (!taken.has(vehicle.id) || vehicle.id === driver.vehicle_id))
      .map(vehicle => `<option value="${vehicle.id}" ${vehicle.id === driver.vehicle_id ? 'selected' : ''}>${escapeHtml(vehicle.plate)}</option>`).join('');
  };
  const row = driver => {
    const [label, tone] = statusMeta[driver.status] || [driver.status, 'warn'];
    return `<tr>
      <td>${escapeHtml(driver.full_name)}
        ${driver.absent_from ? `<small class="muted" style="display:block">отсутствие ${formatDate(driver.absent_from)} — ${formatDate(driver.absent_to)}</small>` : ''}</td>
      <td class="mono">${escapeHtml(driver.phone || '—')}</td>
      <td><select data-drv-vehicle="${driver.id}" title="Закрепление за сцепкой">${vehicleOptionsFor(driver)}</select></td>
      <td><span class="badge ${tone}">${label}</span></td>
      <td class="num" style="white-space:nowrap">
        <button class="button ghost small" data-drv-absent="${driver.id}" title="Отпуск или больничный с датами — на сцепку встанет интервал «без водителя»">Отсутствие</button>
        <button class="button ghost small" data-drv-edit="${driver.id}" title="ФИО, телефон, примечание">✎</button>
        <button class="button ghost small danger" data-drv-fire="${driver.id}" title="Уволить (мягко, с открепления сцепки)">✕</button>
      </td></tr>`;
  };
  showModal(`<h2>Справочник водителей</h2>
    <div class="salesfilter" style="margin-bottom:8px">
      <input id="driversSearch" class="block-search" placeholder="Поиск: ФИО, телефон, сцепка" value="${escapeHtml(state.driversQuery || '')}" style="flex:1;min-width:170px">
      <span class="muted">${filtered.length} из ${drivers.length}</span>
      <button class="button small" id="driverAdd">+ Водитель</button>
    </div>
    ${freeDrivers.length ? `<div class="geohint" style="margin-bottom:8px">🚶 Без машины: ${freeDrivers.map(d => escapeHtml(d.full_name)).join(', ')} — закрепите за свободной сцепкой.</div>` : ''}
    <div style="overflow:auto;max-height:60vh"><table class="rtable"><thead><tr>
      <th>Водитель</th><th>Телефон</th><th>Сцепка</th><th>Статус</th><th></th>
    </tr></thead><tbody>${filtered.map(row).join('') || '<tr><td colspan=5 class="muted">Никого не найдено</td></tr>'}</tbody></table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');

  attachSearch(byId('driversSearch'), value => {
    state.driversQuery = value;
    openDriversDirectory();
  });
  byId('driverAdd').onclick = () => driverEditDialog(null, back);
  const byDriver = id => drivers.find(driver => driver.id === id);
  document.querySelectorAll('[data-drv-vehicle]').forEach(select =>
    select.onchange = async () => {
      try {
        await api(`/api/drivers/${select.dataset.drvVehicle}`, {
          method: 'PATCH', body: JSON.stringify({ vehicleId: select.value || null })
        });
        toast(select.value ? 'Водитель закреплён за сцепкой' : 'Водитель откреплён');
        await reload();
        back();
      } catch (error) { toast(error.message, 'error'); }
    });
  document.querySelectorAll('[data-drv-absent]').forEach(button =>
    button.onclick = () => driverAbsentDialog(byDriver(button.dataset.drvAbsent), back));
  document.querySelectorAll('[data-drv-edit]').forEach(button =>
    button.onclick = () => driverEditDialog(byDriver(button.dataset.drvEdit), back));
  document.querySelectorAll('[data-drv-fire]').forEach(button =>
    button.onclick = async () => {
      const driver = byDriver(button.dataset.drvFire);
      if (!confirm(`Уволить водителя «${driver.full_name}»? Сцепка будет откреплена.`)) return;
      try {
        await api(`/api/drivers/${driver.id}`, { method: 'DELETE' });
        toast('Водитель уволен');
        await reload();
        back();
      } catch (error) { toast(error.message, 'error'); }
    });
}

// Карточка водителя: создание или правка ФИО/телефона/примечания.
function driverEditDialog(driver, after) {
  showModal(`<form id="driverForm"><h2>${driver ? 'Карточка водителя' : 'Новый водитель'}</h2>
    <label class="field">ФИО<input name="fullName" value="${escapeHtml(driver?.full_name || '')}" required></label>
    <label class="field">Телефон<input name="phone" value="${escapeHtml(driver?.phone || '')}"></label>
    <label class="field">Примечание<input name="note" value="${escapeHtml(driver?.note || '')}"></label>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button></div></form>`);
  byId('driverForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(driver ? `/api/drivers/${driver.id}` : '/api/drivers', {
        method: driver ? 'PATCH' : 'POST',
        body: JSON.stringify(formValues(event.currentTarget))
      });
      closeModal(); toast(driver ? 'Водитель обновлён' : 'Водитель добавлен');
      await reload();
      if (after) after();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Отсутствие водителя: отпуск/болезнь с датами. На закреплённую сцепку
// автоматически ставится интервал «без водителя» — календарь и потребность
// сразу видят недоступность.
function driverAbsentDialog(driver, after) {
  showModal(`<form id="absentForm"><h2>Отсутствие · ${escapeHtml(driver.full_name)}</h2>
    ${driver.vehicle_plate ? `<p class="muted">Сцепка <span class="mono">${escapeHtml(driver.vehicle_plate)}</span>
      получит интервал «без водителя» на эти даты.</p>` : '<p class="muted">Водитель не закреплён за сцепкой.</p>'}
    <label class="field">Причина<select name="status">
      <option value="vacation" ${driver.status === 'vacation' ? 'selected' : ''}>Отпуск</option>
      <option value="sick" ${driver.status === 'sick' ? 'selected' : ''}>Больничный</option>
      <option value="active">Вернулся в строй</option>
    </select></label>
    <div class="form-grid">
      <label class="field">С<input name="absentFrom" type="datetime-local" value="${toLocalInput(driver.absent_from) || ''}"></label>
      <label class="field">По<input name="absentTo" type="datetime-local" value="${toLocalInput(driver.absent_to) || ''}"></label>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button></div></form>`);
  byId('absentForm').onsubmit = async event => {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    if (values.status === 'active') { values.absentFrom = null; values.absentTo = null; }
    try {
      await api(`/api/drivers/${driver.id}`, { method: 'PATCH', body: JSON.stringify(values) });
      closeModal();
      toast(values.status === 'active' ? 'Водитель в строю' : 'Отсутствие оформлено');
      await reload();
      if (after) after();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Справочник ТС блока «Ресурс»: весь парк с поиском, правкой карточки,
// заменой водителя/прицепа и планированием диспозиций.
function openFleetDirectory() {
  const vehicles = state.data.vehicles;
  const back = () => openFleetDirectory();
  const statusLabel = { work: 'В работе', repair: 'В ремонте', no_driver: 'Без водителя', out: 'Выведен' };
  const statusTone = { work: 'ok', repair: 'warn', no_driver: 'warn', out: '' };
  const query = (state.fleetQuery || '').toLowerCase();
  const filtered = vehicles.filter(vehicle => !query ||
    [vehicle.plate, vehicle.trailer_plate, vehicle.driver_name, vehicle.type_name]
      .some(value => String(value || '').toLowerCase().includes(query)));
  showModal(`<h2>Справочник ТС</h2>
    <div class="salesfilter" style="margin-bottom:8px">
      <input id="fleetSearch" placeholder="Поиск: тягач, прицеп, водитель, тип" value="${escapeHtml(state.fleetQuery || '')}" style="flex:1;min-width:180px">
      <span class="muted">${filtered.length} из ${vehicles.length}</span>
      <button class="button small" id="fleetAdd">+ Сцепка</button>
    </div>
    <div style="overflow:auto;max-height:60vh"><table class="rtable"><thead><tr>
      <th>Тягач</th><th>Прицеп</th><th>Тип</th><th>Водитель</th><th>Зона</th><th>Состояние</th><th></th>
    </tr></thead><tbody>${filtered.map(vehicle => `<tr>
      <td class="mono"><strong>${escapeHtml(vehicle.plate)}</strong></td>
      <td class="mono">${escapeHtml(vehicle.trailer_plate || '—')}</td>
      <td>${escapeHtml(vehicle.type_name || '—')}</td>
      <td>${escapeHtml(vehicle.driver_name || '—')}</td>
      <td>${escapeHtml(vehicle.zone_name || '—')}</td>
      <td><span class="badge ${statusTone[vehicle.status] || 'warn'}">${statusLabel[vehicle.status] || vehicle.status}</span></td>
      <td class="num" style="white-space:nowrap">
        <button class="button ghost small" data-fleet-edit="${vehicle.id}" title="Карточка ТС">✎</button>
        <button class="button ghost small" data-fleet-driver="${vehicle.id}" title="Замена водителя">Водитель</button>
        <button class="button ghost small" data-fleet-trailer="${vehicle.id}" title="Замена прицепа">Прицеп</button>
        <button class="button ghost small" data-fleet-plan="${vehicle.id}" title="Планировать диспозицию">План</button>
      </td></tr>`).join('') || '<tr><td colspan=7 class="muted">Ничего не найдено</td></tr>'}</tbody></table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');
  attachSearch(byId('fleetSearch'), value => {
    state.fleetQuery = value;
    openFleetDirectory();
  });
  byId('fleetAdd').onclick = () => openVehicle(null, back);
  const byVehicle = id => vehicles.find(vehicle => vehicle.id === id);
  document.querySelectorAll('[data-fleet-edit]').forEach(button =>
    button.onclick = () => openVehicle(byVehicle(button.dataset.fleetEdit), back));
  document.querySelectorAll('[data-fleet-driver]').forEach(button =>
    button.onclick = () => replaceVehicleField(byVehicle(button.dataset.fleetDriver), 'driverName', 'Замена водителя', back));
  document.querySelectorAll('[data-fleet-trailer]').forEach(button =>
    button.onclick = () => replaceVehicleField(byVehicle(button.dataset.fleetTrailer), 'trailerPlate', 'Замена прицепа', back));
  document.querySelectorAll('[data-fleet-plan]').forEach(button =>
    button.onclick = () => openDisposition(null, {
      vehicle_id: button.dataset.fleetPlan,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86_400_000).toISOString()
    }));
}

function openDisposition(item = null, prefill = null) {
  // Планирование ТС по диспозициям: «Резерв» — сцепка обещана под заказ
  // (уходит из потребности и подбора), остальные виды — недоступность.
  const kinds = [
    ['reserve', 'Резерв под заказ'], ['repair', 'В ремонте'], ['no_driver', 'Без водителя'],
    ['shift', 'Пересменка'], ['out', 'Выведен']
  ];
  const source = item || prefill;
  const start = source?.starts_at || new Date().toISOString();
  const end = source?.ends_at || new Date(Date.now() + 86_400_000).toISOString();
  showModal(`<form id="dispositionForm"><h2>${item ? 'Диспозиция ТС' : 'Новая диспозиция'}</h2>
    <label class="field">Сцепка<select name="vehicleId">${vehicleOptions(source?.vehicle_id)}</select></label>
    <label class="field">Вид<select name="kind">${kinds.map(([id, label]) =>
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
        body: JSON.stringify(formValues(event.currentTarget))
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

async function showCustomers() {
  try {
    const { items } = await api('/api/customers');
    const canAdd = can('orders:write');
    showModal(`<h2>Справочник заказчиков</h2><p class="muted">${items.length} записей из БД ·
        новый клиент прикрепляется к геозонам основного направления</p>
      ${canAdd ? `<form id="newCustomerForm" class="salesfilter" style="margin-bottom:10px;flex-wrap:wrap">
        <input name="name" placeholder="Название клиента" required style="flex:1;min-width:170px">
        <select name="fromZoneId" title="Геозона погрузки (прикрепление)">${zoneOptions()}</select>
        <span class="muted">→</span>
        <select name="toZoneId" title="Геозона выгрузки">${zoneOptions()}</select>
        <input name="averageRateVat" type="number" min="0" placeholder="ставка, ₽" style="width:110px">
        <button class="button small">+ Клиент</button>
      </form>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Заказчик</th><th>Маршрут</th><th>Рейсов</th><th>Средняя ставка</th></tr></thead>
      <tbody>${items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.from_name || '—')} → ${escapeHtml(item.to_name || '—')}</td>
      <td>${item.trip_count}</td><td>${money(item.average_rate_vat)}</td></tr>`).join('')}</tbody></table></div>
      <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button></div>`, 'wide');
    const form = byId('newCustomerForm');
    if (form) form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/customers', {
          method: 'POST', body: JSON.stringify(formValues(event.currentTarget))
        });
        toast('Клиент добавлен и прикреплён к геозоне');
        state.customersDirectory = null;
        showCustomers();
      } catch (error) { toast(error.message, 'error'); }
    };
  } catch (error) { toast(error.message, 'error'); }
}

// Справочник адресов из 1С: пункты погрузки/выгрузки с геозоной, координатами
// и плановым расстоянием от базы (Пенза). Выбор адреса в заявке даёт
// плановый километраж маршрута — он уходит в рейс и экономику.
function openAddressBook(query = '') {
  const items = state.data.reference.addresses || [];
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? items.filter(item => `${item.name} ${item.address} ${item.zone_name || ''}`.toLowerCase().includes(needle))
    : items;
  const shown = filtered.slice(0, 80);
  const canAdd = can('orders:write');
  showModal(`<h2>Справочник адресов</h2>
    <p class="muted">${items.length} пунктов · геозона и плановое расстояние от базы (Пенза) ·
      выбор адреса в заявке даёт плановый километраж маршрута</p>
    <input id="addressSearch" class="block-search" placeholder="Поиск: пункт, адрес, геозона"
      value="${escapeHtml(query)}" style="margin-bottom:8px;width:100%">
    ${canAdd ? `<form id="newAddressForm" class="salesfilter" style="margin-bottom:10px;flex-wrap:wrap">
      <input name="name" placeholder="Наименование пункта" required style="flex:1;min-width:170px">
      <input name="address" placeholder="Полный адрес" style="flex:2;min-width:220px">
      <select name="zoneId" title="Геозона">${zoneOptions()}</select>
      <input name="latitude" placeholder="широта" style="width:90px">
      <input name="longitude" placeholder="долгота" style="width:90px">
      <button class="button small">+ Адрес</button>
    </form>` : ''}
    <div class="table-wrap" style="max-height:50vh;overflow:auto"><table>
      <thead><tr><th>Пункт</th><th>Геозона</th><th class="num">От базы, км</th><th>Адрес</th></tr></thead>
      <tbody>${shown.map(item => `<tr>
        <td><b>${escapeHtml(item.name)}</b>${item.external_code ? `<br><small class="muted mono">${escapeHtml(item.external_code)}</small>` : ''}</td>
        <td>${escapeHtml(item.zone_name || '—')}</td>
        <td class="num">${item.base_distance_km ? Math.round(item.base_distance_km) : '—'}</td>
        <td><small class="muted">${escapeHtml(item.address || '')}</small></td></tr>`).join('')}</tbody>
    </table></div>
    ${filtered.length > shown.length
      ? `<p class="muted">Показано ${shown.length} из ${filtered.length} — уточните поиск.</p>` : ''}
    <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button></div>`, 'wide');
  attachSearch(byId('addressSearch'), value => openAddressBook(value));
  const form = byId('newAddressForm');
  if (form) form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/addresses', {
        method: 'POST', body: JSON.stringify(formValues(event.currentTarget))
      });
      toast('Адрес добавлен в справочник');
      await reload();
      openAddressBook(query);
    } catch (error) { toast(error.message, 'error'); }
  };
}

async function reload() {
  byId('syncState').textContent = '● обновление…';
  state.data = await api('/api/bootstrap');
  byId('syncState').textContent = '● синхронно';
  setupUser();
  setupFilters();
  renderLegend();
  renderViewTabs();
  renderMain();
  refreshExceptions();
}

byId('logout').onclick = logout;
setupTheme();
byId('customersButton').onclick = showCustomers;
byId('addressesButton').onclick = () => openAddressBook();
byId('exceptionsChip').onclick = openExceptions;
byId('geoButton').onclick = openGeoMap;
byId('periodPrev').onclick = () => {
  if (!byId('periodPrev').disabled) state.month = addMonths(state.month, -1);
  renderMain();
};
byId('periodNext').onclick = () => {
  if (!byId('periodNext').disabled) state.month = addMonths(state.month, 1);
  renderMain();
};

// ── Горизонтальная прокрутка ганта ─────────────────────────────────────────
const board = document.querySelector('.board');

function dayWidthNow() {
  return Number(state.data?.settings.general.plannerCellWidth || 44);
}

// Плавная прокрутка своими силами: нативный behavior:'smooth' доступен не везде.
function smoothScrollTo(left) {
  const start = board.scrollLeft;
  const target = Math.max(0, Math.min(left, board.scrollWidth - board.clientWidth));
  const delta = target - start;
  if (!delta) return;
  // В фоновой вкладке requestAnimationFrame заморожен — прокручиваем мгновенно.
  if (document.hidden) { board.scrollLeft = target; return; }
  const startedAt = performance.now();
  const duration = 220;
  const step = now => {
    const t = Math.min(1, (now - startedAt) / duration);
    board.scrollLeft = start + delta * (1 - (1 - t) ** 3);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Прокрутка к дню месяца (0-based), день оказывается у левого края видимой канвы.
function scrollToDay(index) {
  smoothScrollTo(Math.max(0, index * dayWidthNow() - 2));
}

byId('scrollLeft').onclick = () => smoothScrollTo(board.scrollLeft - 7 * dayWidthNow());
byId('scrollRight').onclick = () => smoothScrollTo(board.scrollLeft + 7 * dayWidthNow());
byId('scrollToday').onclick = () => {
  const todayIndex = Math.floor((Date.now() - state.month.getTime()) / 86_400_000);
  const days = monthDays(state.month);
  if (todayIndex < 0 || todayIndex >= days) {
    // Сегодня вне открытого месяца — сначала переключаем месяц.
    state.month = monthStart(new Date());
    renderTimeline();
  }
  // Фокус «сегодня −3 … +7»: слева видны три прошедших дня.
  scrollToDay(Math.max(0, Math.floor((Date.now() - state.month.getTime()) / 86_400_000) - 3));
};

// Перетаскивание канвы за шапку дней (drag-scroll) — как в настольных гантах.
board.addEventListener('pointerdown', event => {
  const head = event.target.closest('.timeline-head');
  if (!head || event.target.closest('.vehicle-cell')) return;
  const startX = event.clientX;
  const startLeft = board.scrollLeft;
  try { head.setPointerCapture(event.pointerId); } catch { /* синтетические события без capture */ }
  head.classList.add('dragging-scroll');
  const onMove = moveEvent => { board.scrollLeft = startLeft - (moveEvent.clientX - startX); };
  const stop = () => {
    head.removeEventListener('pointermove', onMove);
    head.classList.remove('dragging-scroll');
  };
  head.addEventListener('pointermove', onMove);
  head.addEventListener('pointerup', stop, { once: true });
  head.addEventListener('pointercancel', stop, { once: true });
});

// Shift+колесо и тачпад работают нативно; обычное колесо над шапкой дней —
// тоже горизонтально (вертикали у шапки нет).
board.addEventListener('wheel', event => {
  if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
      event.target.closest('.timeline-head')) {
    board.scrollLeft += event.deltaY;
    event.preventDefault();
  }
}, { passive: false });

try {
  state.data = await api('/api/bootstrap');
  // Планер открывается на текущем месяце (фокус на «сегодня −3 … +7 дней»);
  // если сегодня вне горизонта планирования — на начале горизонта.
  const horizonStart = monthStart(new Date(`${state.data.settings.general.horizonStart}T00:00:00Z`));
  const horizonEnd = addMonths(horizonStart, Number(state.data.settings.general.horizonMonths || 12));
  const currentMonth = monthStart(new Date());
  state.month = currentMonth >= horizonStart && currentMonth < horizonEnd ? currentMonth : horizonStart;
  setupUser();
  setupFilters();
  renderLegend();
  renderViewTabs();
  renderMain();
  refreshExceptions();
  setupChat(state);
  setupGuide({
    views: () => MAIN_VIEWS.filter(view => view.show()).map(view => view.id),
    activeView: () => state.view,
    showModal
  });
} catch (error) {
  if (!error.message.includes('Требуется вход')) toast(error.message, 'error');
}
