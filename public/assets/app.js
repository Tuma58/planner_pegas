import { api, attachSearch, escapeHtml, formatDate, formatDateTime, formValues, logout, money, routeLabel, setTimeZone, setupTheme, timeZone, toLocalInput, toast, transitHours, wireSelectSearch } from './api.js';
import { renderGeoMap } from './map.js';
import { vehicleInfoDialog } from './vehicle-info.js';
import { renderBoss } from './boss.js';
import { renderRoutes } from './routes.js';
import { renderDashboard } from './dashboard.js';
import { buildReport } from './reports.js';
import { assignDialog, editOrderDialog, renderSales, regionOfPlace } from './sales.js';
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

// Обозримый период канвы: неделя (−2…+5 от выбранной даты, по умолчанию),
// две недели (−3…+11) или календарный месяц. Чем короче период, тем шире
// день — на неделе видна почасовая детализация.
function ganttView() {
  const range = state.ganttRange || 'week';
  const anchorIso = state.selectedDay || new Date().toISOString().slice(0, 10);
  const anchorMs = Date.parse(`${anchorIso}T00:00:00Z`);
  const base = Number(state.data.settings.general.plannerCellWidth || 44);
  if (range === 'month') {
    const start = monthStart(new Date(anchorMs));
    return { range, start, days: monthDays(start), dayWidth: base };
  }
  if (range === 'two') return { range, start: new Date(anchorMs - 3 * 86_400_000), days: 14, dayWidth: base * 2 };
  return { range, start: new Date(anchorMs - 2 * 86_400_000), days: 7, dayWidth: base * 4 };
}

function renderTimeline() {
  const view = ganttView();
  const days = view.days;
  const dayWidth = view.dayWidth;
  const viewStart = view.start;
  const viewEnd = new Date(viewStart.getTime() + days * 86_400_000);
  document.documentElement.style.setProperty('--planner-day-width', `${dayWidth}px`);
  const visibleTrips = state.data.trips.filter(trip =>
    new Date(trip.starts_at) < viewEnd && new Date(trip.ends_at) > viewStart);
  // Поиск по странице: строка остаётся, если совпала сцепка (номер, водитель,
  // тип) или любой её рейс месяца (маршрут, заказчик).
  const ganttQuery = (state.ganttQuery || '').toLowerCase();
  const vehicleMatches = vehicle =>
    `${vehicle.plate} ${vehicle.driver_name || ''} ${vehicle.type_name || ''}`.toLowerCase().includes(ganttQuery) ||
    visibleTrips.some(trip => trip.vehicle_id === vehicle.id &&
      `${routeLabel(trip)} ${trip.customer_name || ''}`.toLowerCase().includes(ganttQuery));
  // Фильтр по геозоне (клик в легенде): где сцепка находится НА ДАТУ —
  // выбранный день (клик по шапке / календарик) или сегодня. Позиция — зона
  // выгрузки последнего рейса, начавшегося к концу этой даты (идущий рейс —
  // зона, куда движется); без рейсов — зона приписки.
  const nowMoment = Date.now();
  const zoneDayIso = state.selectedDay || new Date().toISOString().slice(0, 10);
  const zoneDayEndMs = Date.parse(`${zoneDayIso}T23:59:59Z`);
  const legendDayLabelOf = () => new Intl.DateTimeFormat('ru-RU',
    { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${zoneDayIso}T12:00:00Z`));
  const zoneOfVehicleAt = vehicle => {
    const lastTrip = state.data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
        Date.parse(trip.starts_at) <= zoneDayEndMs)
      .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
    return lastTrip ? lastTrip.to_name : vehicle.zone_name;
  };
  const vehicleInZone = vehicle => zoneOfVehicleAt(vehicle) === state.ganttZone;
  // Субъект местоположения сцепки на дату — тот же каскад, что в продажах:
  // адрес выгрузки заявки последнего рейса, иначе пункт/зона по справочнику.
  const regionOfVehicleAt = vehicle => {
    const lastTrip = state.data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
        Date.parse(trip.starts_at) <= zoneDayEndMs)
      .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
    if (!lastTrip) return regionOfPlace(state.data, '', vehicle.zone_name);
    const order = lastTrip.order_id
      ? (state.data.orders || []).find(item => item.id === lastTrip.order_id) : null;
    const byOrder = order?.to_address_id ? (state.data.reference.addresses || [])
      .find(item => item.id === order.to_address_id)?.region : '';
    if (byOrder) return byOrder;
    return regionOfPlace(state.data, lastTrip.to_point, lastTrip.to_name);
  };
  const vehicles = state.data.vehicles.filter(vehicle =>
    vehicle.status !== 'out' && (state.type === 'all' || vehicle.type_name === state.type) &&
    (!ganttQuery || vehicleMatches(vehicle)) &&
    (!state.ganttZone || vehicleInZone(vehicle)) &&
    (!state.ganttRegion || regionOfVehicleAt(vehicle) === state.ganttRegion) &&
    (!state.ganttState || vehicleDayState(vehicle, zoneDayIso).key === state.ganttState));
  const conflicts = conflictIds(state.data.trips);
  const critical = criticalIds(state.data.trips, state.data.dispositions || []);
  const dayLabel = ms => new Intl.DateTimeFormat('ru-RU',
    { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(ms));
  byId('periodLabel').textContent = view.range === 'month'
    ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(viewStart)
    : `${dayLabel(viewStart.getTime())} – ${dayLabel(viewEnd.getTime() - 86_400_000)}`;
  byId('rangeTabs').innerHTML = [['week', 'Неделя'], ['two', '2 нед'], ['month', 'Месяц']]
    .map(([key, label]) => `<button data-range="${key}" class="${view.range === key ? 'active' : ''}">${label}</button>`).join('');
  byId('rangeTabs').onclick = event => {
    const button = event.target.closest('[data-range]');
    if (!button) return;
    state.ganttRange = button.dataset.range;
    renderTimeline();
  };
  const todayIndex = Math.floor((Date.now() - viewStart.getTime()) / 86_400_000);
  const isToday = index => index === todayIndex;
  const dayIsoOf = index => new Date(viewStart.getTime() + index * 86_400_000).toISOString().slice(0, 10);
  const isSelected = index => state.selectedDay === dayIsoOf(index);
  const headerDays = Array.from({ length: days }, (_, index) => {
    const date = new Date(viewStart.getTime() + index * 86_400_000);
    const weekend = [0, 6].includes(date.getUTCDay());
    const hours = view.range === 'week'
      ? '<span class="hrs"><i>06</i><i>12</i><i>18</i></span>' : '';
    return `<div class="day-cell ${weekend ? 'weekend' : ''} ${isToday(index) ? 'today' : ''} ${isSelected(index) ? 'selected' : ''}"
      data-day-iso="${dayIsoOf(index)}" title="Аналитика дня"><strong>${date.getUTCDate()}</strong>
      <small>${new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(date)}</small>${hours}</div>`;
  }).join('');
  // Цвета и подписи видов диспозиций — те же, что в «Ресурсе»: ремонт,
  // пересменка, без водителя и плановая работа различимы прямо на канве.
  const dispositionMeta = kind => DISP_KINDS.find(item => item.kind === kind) ||
    { label: kind, short: kind, color: 'var(--muted)' };
  const nowMs = Date.now();
  const rows = vehicles.map(vehicle => {
    const vehicleTrips = visibleTrips.filter(trip => trip.vehicle_id === vehicle.id);
    const dayStatus = vehicleDayState(vehicle, zoneDayIso);
    const grid = Array.from({ length: days }, (_, index) => {
      const date = new Date(viewStart.getTime() + index * 86_400_000);
      return `<div class="grid-day ${view.range === 'week' ? 'hours6' : ''} ${[0, 6].includes(date.getUTCDay()) ? 'weekend' : ''} ${isToday(index) ? 'today' : ''} ${isSelected(index) ? 'selected' : ''}"></div>`;
    }).join('');
    const dispositionBlocks = (state.data.dispositions || [])
      .filter(item => item.vehicle_id === vehicle.id &&
        new Date(item.starts_at) < viewEnd && new Date(item.ends_at) > viewStart)
      .map(item => {
        const visibleStart = new Date(Math.max(new Date(item.starts_at), viewStart));
        const visibleEnd = new Date(Math.min(new Date(item.ends_at), viewEnd));
        const left = Math.max(0, daysBetween(viewStart, visibleStart)) * dayWidth;
        const width = Math.max(10, daysBetween(visibleStart, visibleEnd) * dayWidth - 2);
        const meta = dispositionMeta(item.kind);
        // «Резерв» — фоновая пометка плана, не событие: приглушается,
        // чтобы не спорить с плашками рейсов и проблемными диспозициями.
        return `<span class="dispo ${item.kind === 'reserve' ? 'reserve' : ''}" data-disposition="${item.id}"
          style="left:${left}px;width:${width}px;--dc:${meta.color}"
          title="${meta.label} · ${formatDateTime(item.starts_at)} → ${formatDateTime(item.ends_at)}${item.note ? `
${escapeHtml(item.note)}` : ''}"><b>${meta.short}</b>${item.note && width > 90 ? ` · ${escapeHtml(item.note)}` : ''}</span>`;
      }).join('');
    const calcSettings = state.data.settings.calculation;
    // Пересекающиеся рейсы (конфликт назначения) раскладываются в два яруса
    // половинной высоты — наложение видно, оба рейса читаются целиком.
    let lastConflict = null;
    const laneOf = trip => {
      if (!conflicts.has(trip.id)) return '';
      const overlapsPrev = lastConflict &&
        Date.parse(trip.starts_at) < Date.parse(lastConflict.trip.ends_at);
      const lane = overlapsPrev && lastConflict.lane === 0 ? 1 : 0;
      lastConflict = { trip, lane };
      return lane === 0 ? 'split-top' : 'split-bottom';
    };
    const trips = vehicleTrips.map(trip => {
      const visibleStart = new Date(Math.max(new Date(trip.starts_at), viewStart));
      const visibleEnd = new Date(Math.min(new Date(trip.ends_at), viewEnd));
      const left = Math.max(0, daysBetween(viewStart, visibleStart)) * dayWidth;
      const width = Math.max(28, daysBetween(visibleStart, visibleEnd) * dayWidth - 3);
      const color = trip.from_color || '#3b6ea5';
      // Порожний подгон перед рейсом: штрихованный хвост длиной во время
      // перегона (км/50 × 1,5 — отдых включён), обрезается краем окна.
      let emptyTail = '';
      const emptyKm = Number(trip.empty_km) || 0;
      if (emptyKm > 0 && trip.status !== 'rejected') {
        const tailMs = transitHours(emptyKm, calcSettings, 0) * 3_600_000;
        const tailStart = new Date(Math.max(Date.parse(trip.starts_at) - tailMs, viewStart.getTime()));
        const tailEnd = new Date(Math.min(Date.parse(trip.starts_at), viewEnd.getTime()));
        const tailWidth = daysBetween(tailStart, tailEnd) * dayWidth - 1;
        if (tailWidth > 3) {
          emptyTail = `<span class="empty-tail" data-empty-trip="${trip.id}" style="left:${Math.max(0,
            daysBetween(viewStart, tailStart) * dayWidth)}px;width:${tailWidth}px"
            title="Порожний подгон ~${Math.round(emptyKm)} км (~${Math.round(tailMs / 3_600_000)} ч)&#10;Клик — спот-запрос продажам: найти груз на это плечо"></span>`;
        }
      }
      return `${emptyTail}<button class="trip ${conflicts.has(trip.id) ? 'conflict' : ''} ${laneOf(trip)} ${critical.has(trip.id) ? 'critical' : ''} ${trip.status === 'rejected' ? 'rejected' : ''} ${trip.status === 'plan' ? 'plan' : ''} ${width < 70 ? 'tiny' : ''}"
        data-trip="${trip.id}" style="left:${left}px;width:${width}px;background-color:${color}"
        title="${escapeHtml(routeLabel(trip))}&#10;Геозоны: ${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}&#10;${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}&#10;${escapeHtml(trip.customer_name)}${emptyKm
          ? `&#10;Порожний подгон ~${Math.round(emptyKm)} км` : ''}">
        <strong>${escapeHtml(routeLabel(trip))}</strong>
        <small>${escapeHtml(trip.customer_name)}</small>
      </button>`;
    }).join('');
    // ── Разрывы между плашками ──
    // «Ожидание погрузки» (>6 ч до назначенного рейса, сверх подгона) —
    // пунктир; >24 ч — жёлтый и кликабельный (спот-запрос, как хвост).
    // «Простой без работы» (>24 ч после последнего события, впереди пусто) —
    // янтарная штриховка до линии «сейчас», клик — запрос загрузки продажам.
    const allVehicleTrips = state.data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const vehicleDispositions = (state.data.dispositions || [])
      .filter(item => item.vehicle_id === vehicle.id);
    const dispoCovers = (fromMs, toMs) => vehicleDispositions.some(item =>
      Date.parse(item.starts_at) < toMs && Date.parse(item.ends_at) > fromMs);
    const gapBar = (fromMs, toMs, cls, title, dataAttr) => {
      const visFrom = Math.max(fromMs, viewStart.getTime());
      const visTo = Math.min(toMs, viewEnd.getTime());
      if (visTo - visFrom < 30 * 60_000) return '';
      const left = daysBetween(viewStart, new Date(visFrom)) * dayWidth;
      const width = daysBetween(new Date(visFrom), new Date(visTo)) * dayWidth - 1;
      return `<span class="${cls}" style="left:${left}px;width:${Math.max(4, width)}px"
        title="${title}" ${dataAttr || ''}></span>`;
    };
    let gapBars = '';
    for (let i = 1; i < allVehicleTrips.length; i += 1) {
      const previous = allVehicleTrips[i - 1];
      const next = allVehicleTrips[i];
      const tailMs = Number(next.empty_km)
        ? transitHours(Number(next.empty_km), calcSettings, 0) * 3_600_000 : 0;
      const waitFrom = Date.parse(previous.ends_at);
      const waitTo = Date.parse(next.starts_at) - tailMs;
      const waitMs = waitTo - waitFrom;
      if (waitMs > 6 * 3_600_000 && !dispoCovers(waitFrom, waitTo)) {
        const long = waitMs > 24 * 3_600_000;
        gapBars += gapBar(waitFrom, waitTo, `gap-wait ${long ? 'long' : ''}`,
          `Ожидание погрузки ~${Math.round(waitMs / 3_600_000)} ч (рейс назначен)${long
            ? '&#10;Клик — спот: вставить короткое плечо в паузу' : ''}`,
          long ? `data-empty-trip="${next.id}"` : '');
      }
    }
    const lastEndMs = Math.max(0,
      ...allVehicleTrips.map(trip => Date.parse(trip.ends_at)),
      ...vehicleDispositions.map(item => Date.parse(item.ends_at)));
    const hasFuture = allVehicleTrips.some(trip => Date.parse(trip.ends_at) > nowMoment) ||
      vehicleDispositions.some(item => Date.parse(item.ends_at) > nowMoment);
    if (!hasFuture && lastEndMs > 0 && nowMoment - lastEndMs > 24 * 3_600_000) {
      const idleDays = Math.floor((nowMoment - lastEndMs) / 86_400_000);
      gapBars += gapBar(lastEndMs, nowMoment, 'gap-idle',
        `Простой ${idleDays} дн с ${formatDateTime(new Date(lastEndMs).toISOString())} — работы нет&#10;Клик — запрос загрузки в продажи`,
        `data-request-load="${vehicle.id}"`);
    }
    return `<div class="vehicle-row">
      <div class="vehicle-cell ${dayStatus.cls === 'idle' ? 'cell-idle' : ''}"><span class="vehicle-stripe"></span>
        <span class="vehicle-title res-vtitle"><strong class="mono vlink" data-vinfo="${vehicle.id}"
          title="Карточка ТС: рейс, простой, ремонт, отметки контролёра">${escapeHtml(vehicle.plate)}</strong>
        <small>${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name)}</small>
        <small class="vday vday-${dayStatus.cls}" ${dayStatus.color ? `style="color:${dayStatus.color}"` : ''}
          title="Занятость сцепки на ${legendDayLabelOf()}">${escapeHtml(dayStatus.text)}</small></span>
      </div>
      <div class="track" data-vehicle="${vehicle.id}" style="width:${days * dayWidth}px"><div class="track-grid">${grid}</div>${gapBars}${dispositionBlocks}${trips}</div>
    </div>`;
  }).join('');
  const nowLine = (nowMoment > viewStart.getTime() && nowMoment < viewEnd.getTime())
    ? `<div class="now-line" style="left:${236 + daysBetween(viewStart, new Date(nowMoment)) * dayWidth}px"
        title="Сейчас · ${formatDateTime(new Date(nowMoment).toISOString())}"></div>` : '';
  byId('timeline').innerHTML = vehicles.length
    ? `<div class="timeline-head"><div class="vehicle-cell">Сцепка · водитель</div>${headerDays}</div>${rows}${nowLine}`
    : '<div class="empty-state">Нет ТС по выбранному фильтру</div>';
  document.querySelectorAll('[data-trip]').forEach(button =>
    button.addEventListener('click', () => {
      if (button.dataset.suppress) { delete button.dataset.suppress; return; }
      openTrip(state.data.trips.find(trip => trip.id === button.dataset.trip));
    }));
  document.querySelectorAll('[data-disposition]').forEach(block =>
    block.addEventListener('click', () => openDisposition(
      (state.data.dispositions || []).find(item => item.id === block.dataset.disposition))));
  // Клик по полосе простоя: запрос загрузки в продажи по сцепке.
  document.querySelectorAll('[data-request-load]').forEach(bar =>
    bar.addEventListener('click', async () => {
      const vehicle = state.data.vehicles.find(item => item.id === bar.dataset.requestLoad);
      if (!vehicle) return;
      if (!confirm(`Запросить продажи: сцепка ${vehicle.plate} простаивает — нужна загрузка?`)) return;
      try {
        await api(`/api/vehicles/${vehicle.id}/request-load`, { method: 'POST' });
        toast('Запрос загрузки отправлен продажам');
      } catch (error) { toast(error.message, 'error'); }
    }));
  // Клик по порожнему хвосту: спот-запрос продажам — найти груз на пустое
  // плечо (откуда сцепка гонит порожняк → куда едет под погрузку).
  document.querySelectorAll('[data-empty-tail], [data-empty-trip]').forEach(tail =>
    tail.addEventListener('click', async () => {
      const trip = state.data.trips.find(item => item.id === tail.dataset.emptyTrip);
      if (!trip) return;
      const previous = state.data.trips
        .filter(item => item.vehicle_id === trip.vehicle_id && item.status !== 'rejected' &&
          item.ends_at <= trip.starts_at)
        .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      const fromRegion = previous
        ? regionOfPlace(state.data, previous.to_point, previous.to_name)
        : regionOfPlace(state.data, '', state.data.vehicles
            .find(vehicle => vehicle.id === trip.vehicle_id)?.zone_name);
      const toRegion = regionOfPlace(state.data, trip.from_point, trip.from_name);
      if (!fromRegion || !toRegion) { toast('Субъекты плеча не распознаны', 'error'); return; }
      if (!confirm(`Спот-запрос продажам: найти груз ${fromRegion} → ${toRegion}` +
        ` (~${Math.round(trip.empty_km)} км порожним, ${trip.vehicle_plate})?`)) return;
      try {
        await api('/api/spot-request', { method: 'POST', body: JSON.stringify({
          fromRegion, toRegion, km: trip.empty_km, aroundIso: trip.starts_at,
          vehicleId: trip.vehicle_id, vehiclePlate: trip.vehicle_plate }) });
        toast('Спот-запрос отправлен продажам');
      } catch (error) { toast(error.message, 'error'); }
    }));
  enableTripDrag(dayWidth);
  enableDispositionDraw(dayWidth, viewStart);
  // При первом показе месяца с текущим днём фокус на «сегодня −3 … +7 дней»:
  // канва прокручивается так, чтобы слева было видно три прошедших дня,
  // а неделя вперёд оставалась в кадре.
  if (view.range === 'month' && todayIndex >= 0 && todayIndex < days &&
      state.autoScrolledMonth !== viewStart.getTime()) {
    state.autoScrolledMonth = viewStart.getTime();
    document.querySelector('.board').scrollLeft = Math.max(0, todayIndex - 3) * dayWidth;
  }
  const horizonStart = monthStart(new Date(`${state.data.settings.general.horizonStart}T00:00:00Z`));
  const horizonEnd = addMonths(horizonStart, Number(state.data.settings.general.horizonMonths || 12) - 1);
  byId('periodPrev').disabled = view.range === 'month' && state.month <= horizonStart;
  byId('periodNext').disabled = view.range === 'month' && state.month >= horizonEnd;
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
function enableDispositionDraw(dayWidth, viewStart) {
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
          starts_at: new Date(viewStart.getTime() + range[0] * dayMs).toISOString(),
          ends_at: new Date(viewStart.getTime() + range[1] * dayMs).toISOString()
        });
      };
      track.addEventListener('pointermove', onMove);
      track.addEventListener('pointerup', onUp);
    });
  });
}

// Занятость сцепки на дату: активный рейс, оформленная диспозиция или простой.
// Используется ячейками Ганта, фильтрами состояний и их счётчиками.
function vehicleDayState(vehicle, dayIso) {
  const dayStartMs = Date.parse(`${dayIso}T00:00:00Z`);
  const dayEndMs = dayStartMs + 86_399_000;
  const shortPlace = value => String(value || '').split(',')[0].trim().slice(0, 20);
  const activeTrip = state.data.trips
    .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
      Date.parse(trip.starts_at) <= dayEndMs && Date.parse(trip.ends_at) > dayStartMs)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  if (activeTrip) {
    return { key: 'trip', cls: 'trip', color: 'var(--teal)',
      text: `⇢ из ${shortPlace(activeTrip.from_point || activeTrip.from_name)} в ${shortPlace(activeTrip.to_point || activeTrip.to_name)}` };
  }
  // Диспозиция объясняет день, если ПЕРЕСЕКАЕТ его (короткий дневной ремонт
  // 08:00–15:00 — тоже причина); из нескольких берётся большая по перекрытию.
  const dayCeilMs = dayStartMs + 86_400_000;
  const overlapMs = item => Math.min(Date.parse(item.ends_at), dayCeilMs) -
    Math.max(Date.parse(item.starts_at), dayStartMs);
  const disposition = (state.data.dispositions || [])
    .filter(item => item.vehicle_id === vehicle.id &&
      Date.parse(item.starts_at) < dayCeilMs && Date.parse(item.ends_at) > dayStartMs)
    .sort((a, b) => overlapMs(b) - overlapMs(a))[0];
  if (disposition) {
    const meta = DISP_KINDS.find(item => item.kind === disposition.kind) ||
      { label: disposition.kind, color: 'var(--muted)' };
    return { key: disposition.kind, cls: 'dispo', color: meta.color,
      text: `${meta.label} до ${formatDate(disposition.ends_at)}` };
  }
  const lastTrip = state.data.trips
    .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
      Date.parse(trip.starts_at) <= dayEndMs)
    .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
  const zone = lastTrip ? lastTrip.to_name : vehicle.zone_name;
  return { key: 'idle', cls: 'idle', color: 'var(--warn)',
    text: `⚠ простой в «${zone}» — причины нет` };
}

function renderLegend() {
  // Зоны легенды — фильтр строк Ганта: остаются сцепки, чьи рейсы месяца
  // проходят через зону или которые освобождаются в ней. Повторный клик — сброс.
  const legendDay = state.selectedDay || new Date().toISOString().slice(0, 10);
  const legendDayLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${legendDay}T12:00:00Z`));
  byId('legend').innerHTML = state.data.reference.zones.map(zone =>
    `<span class="lg clickable ${state.ganttZone === zone.name ? 'active' : ''}" data-lg-zone="${escapeHtml(zone.name)}"
      title="Сцепки в зоне «${escapeHtml(zone.name)}» на ${legendDayLabel} (сегодня или выбранный день)">
      <span class="sw" style="background:${zone.color}"></span>${escapeHtml(zone.name)}${state.ganttZone === zone.name
        ? ` · ${legendDayLabel} ✕` : ''}</span>`).join('');
  // Фильтры по состоянию на ту же дату: в рейсе, простой, ремонт, резерв…
  const legendDayIso = state.selectedDay || new Date().toISOString().slice(0, 10);
  const activeFleet = state.data.vehicles.filter(vehicle => vehicle.status !== 'out');
  const stateCount = key => activeFleet
    .filter(vehicle => vehicleDayState(vehicle, legendDayIso).key === key).length;
  const stateChips = [
    { key: 'trip', label: 'в рейсе', color: 'var(--teal)' },
    { key: 'idle', label: 'простой', color: 'var(--warn)' },
    ...DISP_KINDS.filter(item => ['reserve', 'repair', 'no_driver', 'shift'].includes(item.kind))
      .map(item => ({ key: item.kind, label: item.short, color: item.color }))
  ];
  byId('legend').innerHTML += `<span class="lg-sep"></span>` + stateChips.map(chip =>
    `<span class="lg clickable ${state.ganttState === chip.key ? 'active' : ''}" data-lg-state="${chip.key}"
      title="Сцепки в состоянии «${chip.label}» на ${legendDayLabel}">
      <span class="sw" style="background:${chip.color}"></span>${chip.label} ${stateCount(chip.key)}${state.ganttState === chip.key ? ' ✕' : ''}</span>`).join('');
  // Фильтр по субъекту РФ: местоположение сцепки на дату (по пункту выгрузки
  // последнего рейса через справочник адресов).
  const regionList = [...new Set((state.data.reference.addresses || [])
    .map(item => item.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  byId('legend').innerHTML += `<span class="lg-sep"></span>
    <select id="ganttRegionFilter" class="lg-region ${state.ganttRegion ? 'active' : ''}"
      title="Сцепки в субъекте РФ на ${legendDayLabel}">
      <option value="">Все субъекты</option>
      ${regionList.map(region => `<option value="${escapeHtml(region)}"
        ${state.ganttRegion === region ? 'selected' : ''}>${escapeHtml(region)}</option>`).join('')}
    </select>`;
  byId('ganttRegionFilter').onchange = event => {
    state.ganttRegion = event.currentTarget.value || null;
    renderLegend();
    renderTimeline();
  };
  byId('legend').onclick = event => {
    const zoneChip = event.target.closest('[data-lg-zone]');
    if (zoneChip) {
      state.ganttZone = state.ganttZone === zoneChip.dataset.lgZone ? null : zoneChip.dataset.lgZone;
      renderLegend();
      renderTimeline();
      return;
    }
    const stateChip = event.target.closest('[data-lg-state]');
    if (stateChip) {
      state.ganttState = state.ganttState === stateChip.dataset.lgState ? null : stateChip.dataset.lgState;
      renderLegend();
      renderTimeline();
    }
  };
}

// Главные экраны (перенос ролевых экранов ТК 21), доступ по правам.
const MAIN_VIEWS = [
  { id: 'gantt', title: 'Гант', show: () => true },
  { id: 'sales', title: 'Продажи', show: () => can('orders:write') },
  { id: 'logist', title: 'Логист', show: () => can('trips:write') },
  { id: 'routes', title: 'Конструктор', show: () => can('orders:write') || can('trips:write') },
  { id: 'dispatcher', title: 'Диспетчер', show: () => true },
  { id: 'resource', title: 'Ресурс', show: () => can('fleet:write') },
  { id: 'boss', title: 'Руководитель', show: () => can('reports:read') },
  { id: 'dashboard', title: 'Дашборд', show: () => true }
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
  // Ресурс — тоже гант: ему нужны навигация по месяцу и прокрутка, но его
  // канва скроллится внутри .resscroll (шапка фильтров закреплена), поэтому
  // класс .canvas (ширина по контенту) — только у Ганта.
  const timelineView = isGantt || isResource;
  ['periodPrev', 'periodLabel', 'periodNext', 'scrollNav'].forEach(id =>
    byId(id).classList.toggle('hidden', !timelineView));
  byId('typeFilter').classList.toggle('hidden', !isGantt);
  byId('rangeTabs').classList.toggle('hidden', !isGantt);
  byId('legend').classList.toggle('hidden', !isGantt);
  // Правая панель осталась только у «Ресурса» (задания сотрудника):
  // Гант — информационное пространство на всю ширину, оперативная
  // сводка переехала на доску продаж.
  byId('sidepanel').classList.toggle('hidden', !isResource);
  document.querySelector('.planner-layout').classList.toggle('full', !isResource);
  // Канва тянется по контенту (месяц дней), доски — по ширине окна.
  byId('timeline').classList.toggle('canvas', isGantt);
  if (isGantt) {
    renderTimeline();
  } else if (state.view === 'boss') {
    byId('timeline').innerHTML = '<div class="empty-state">Загрузка отчёта…</div>';
    renderBoss(byId('timeline'), { state, onReload: reload, openReport, showModal, closeModal });
  } else if (state.view === 'sales') {
    renderSales(byId('timeline'), {
      state, can, onReload: reload, showModal, closeModal, openTrip,
      openAssign: order => assignDialog(order, state.data, showModal, closeModal, reload)
    });
  } else if (state.view === 'resource') {
    renderResource(byId('timeline'), {
      state, openDisposition, openFleet: openFleetDirectory,
      openDrivers: openDriversDirectory, openStats: openResourceStats,
      showModal, closeModal,
      onReload: reload, taskContainer: byId('sidepanel')
    });
  } else if (state.view === 'dashboard') {
    renderDashboard(byId('timeline'), { state, can, onReload: reload });
  } else if (state.view === 'routes') {
    renderRoutes(byId('timeline'), { state, can, onReload: reload, showModal, closeModal });
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
  const days = transitHours(distance, settings) / 24;
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
    `<option value="${vehicle.id}" ${vehicle.id === selected ? 'selected' : ''}>${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.type_name)} · ${escapeHtml(vehicle.driver_name || 'без водителя')}</option>`).join('');
}

// Карточка ТС: клик по госномеру с data-vinfo в любой вкладке (Гант,
// продажи, ресурс) — полная картина по сцепке для всех ролей.
document.addEventListener('click', event => {
  const link = event.target.closest('[data-vinfo]');
  if (!link || !state.data) return;
  event.stopPropagation();
  vehicleInfoDialog(link.dataset.vinfo, state.data, { showModal, closeModal });
});

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
    <label class="field">Сцепка
      <input id="tripVehicleSearch" placeholder="🔍 поиск: номер, водитель, тип" autocomplete="off">
      <select name="vehicleId" required style="margin-top:4px">${vehicleOptions()}</select></label>
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
  wireSelectSearch(byId('tripVehicleSearch'), form.querySelector('[name=vehicleId]'));
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
      <th class="num">Использование</th><th class="num">Порожн., км</th><th class="num">%</th><th class="num">Рейсов</th><th class="num">Выручка б.НДС</th>
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
    <label class="field" id="repairPlaceField" style="display:none">Место ремонта (сервис)
      <input name="repairPlace" list="repairPlaces" autocomplete="off"
        placeholder="адрес из справочника — посчитается ремонтный пробег"
        value="${escapeHtml(item?.address_id
          ? (state.data.reference.addresses || []).find(a => a.id === item.address_id)?.name || '' : '')}">
      <datalist id="repairPlaces">${(state.data.reference.addresses || [])
        .map(a => `<option value="${escapeHtml(a.name)}"></option>`).join('')}</datalist>
    </label>
    <label class="field">Комментарий<input name="note" value="${escapeHtml(item?.note || '')}"></label>
    <div class="modal-actions">
      ${item ? '<button type="button" class="button danger" id="deleteDisposition">Удалить</button>' : ''}
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button>
    </div></form>`);
  // Поле сервиса видно только для «В ремонте».
  const dispositionForm = byId('dispositionForm');
  const toggleRepairPlace = () => {
    byId('repairPlaceField').style.display =
      dispositionForm.elements.kind.value === 'repair' ? '' : 'none';
  };
  dispositionForm.elements.kind.addEventListener('change', toggleRepairPlace);
  toggleRepairPlace();
  byId('dispositionForm').onsubmit = async event => {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    // Текст сервиса → адрес справочника (точное имя/начало/подстрока).
    const repairAddress = values.kind === 'repair' && values.repairPlace
      ? (state.data.reference.addresses || []).find(a =>
          a.name.toLowerCase() === values.repairPlace.trim().toLowerCase())
        || (state.data.reference.addresses || []).find(a =>
          a.name.toLowerCase().startsWith(values.repairPlace.trim().toLowerCase()))
      : null;
    values.addressId = repairAddress?.id || null;
    delete values.repairPlace;
    try {
      await api(item ? `/api/dispositions/${item.id}` : '/api/dispositions', {
        method: item ? 'PATCH' : 'POST',
        body: JSON.stringify(values)
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
function openAddressBook(query = '', region = '') {
  const items = state.data.reference.addresses || [];
  const needle = query.trim().toLowerCase();
  const regions = [...new Set(items.map(item => item.region).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
  const filtered = items.filter(item =>
    (!region || item.region === region) &&
    (!needle || `${item.name} ${item.address} ${item.region || ''} ${item.zone_name || ''}`
      .toLowerCase().includes(needle)));
  const shown = filtered.slice(0, 80);
  const canAdd = can('orders:write');
  showModal(`<h2>Справочник адресов</h2>
    <p class="muted">${items.length} пунктов · геозона и плановое расстояние от базы (Пенза) ·
      выбор адреса в заявке даёт плановый километраж маршрута</p>
    <div class="salesfilter" style="margin-bottom:8px">
      <input id="addressSearch" class="block-search" placeholder="Поиск: пункт, адрес, субъект, геозона"
        value="${escapeHtml(query)}" style="flex:1">
      <select id="addressRegion" title="Фильтр по субъекту РФ">
        <option value="">Все субъекты</option>
        ${regions.map(item =>
          `<option value="${escapeHtml(item)}" ${region === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
      </select>
    </div>
    ${canAdd ? `<form id="newAddressForm" class="salesfilter" style="margin-bottom:6px;flex-wrap:wrap">
      <input name="name" placeholder="Наименование пункта" required style="flex:1;min-width:170px">
      <input name="address" placeholder="Полный адрес" style="flex:2;min-width:220px">
      <button type="button" class="button ghost small" id="geoLookup"
        title="Найти адрес и координаты в OpenStreetMap">🌍 Найти</button>
      <input name="region" placeholder="Субъект (обл/респ)" style="width:150px">
      <select name="zoneId" title="Геозона">${zoneOptions()}</select>
      <input name="latitude" placeholder="широта" style="width:90px">
      <input name="longitude" placeholder="долгота" style="width:90px">
      <button class="button small">+ Адрес</button>
    </form>
    <div id="geoResults" class="list" style="margin-bottom:8px"></div>` : ''}
    <div class="table-wrap" style="max-height:50vh;overflow:auto"><table>
      <thead><tr><th>Пункт</th><th>Субъект</th><th>Геозона</th><th class="num">От базы, км</th><th>Адрес</th></tr></thead>
      <tbody>${shown.map(item => `<tr>
        <td><b>${escapeHtml(item.name)}</b>${item.external_code ? `<br><small class="muted mono">${escapeHtml(item.external_code)}</small>` : ''}</td>
        <td>${escapeHtml(item.region || '—')}</td>
        <td>${escapeHtml(item.zone_name || '—')}</td>
        <td class="num">${item.base_distance_km ? Math.round(item.base_distance_km) : '—'}</td>
        <td><small class="muted">${escapeHtml(item.address || '')}</small></td></tr>`).join('')}</tbody>
    </table></div>
    ${filtered.length > shown.length
      ? `<p class="muted">Показано ${shown.length} из ${filtered.length} — уточните поиск.</p>` : ''}
    <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button></div>`, 'wide');
  attachSearch(byId('addressSearch'), value => openAddressBook(value, region));
  byId('addressRegion').onchange = event => openAddressBook(query, event.currentTarget.value);
  // Геокодинг из OSM: варианты списком, клик заполняет адрес и координаты.
  byId('geoLookup')?.addEventListener('click', async () => {
    const form = byId('newAddressForm');
    // Ищем по полю «адрес»; если оно пусто — по наименованию (без склейки:
    // произвольные названия складов ломают поиск по карте).
    const queryText = (form.elements.address.value || form.elements.name.value).trim();
    if (queryText.length < 3) return toast('Введите наименование или адрес для поиска', 'error');
    byId('geoResults').innerHTML = '<p class="muted">Ищем в OpenStreetMap…</p>';
    try {
      const { items } = await api(`/api/geocode?q=${encodeURIComponent(queryText)}`);
      byId('geoResults').innerHTML = items.length ? items.map((item, index) =>
        `<button type="button" class="list-item sugtruck" data-geo="${index}">
          <span style="flex:1;min-width:0"><small>${escapeHtml(item.name)}</small>
          <small class="muted" style="display:block">${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}${item.region ? ` · ${escapeHtml(item.region)}` : ''}</small></span>
        </button>`).join('')
        : '<p class="muted">Ничего не найдено — уточните запрос.</p>';
      byId('geoResults').querySelectorAll('[data-geo]').forEach(button =>
        button.addEventListener('click', () => {
          const item = items[Number(button.dataset.geo)];
          form.elements.address.value = item.name;
          form.elements.latitude.value = item.latitude;
          form.elements.longitude.value = item.longitude;
          if (item.region && !form.elements.region.value) form.elements.region.value = item.region;
          byId('geoResults').innerHTML =
            '<p class="muted">✓ Координаты подставлены — проверьте геозону и нажмите «+ Адрес».</p>';
        }));
    } catch (error) {
      byId('geoResults').innerHTML = `<p class="danger">${escapeHtml(error.message)}</p>`;
    }
  });
  const form = byId('newAddressForm');
  if (form) form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/addresses', {
        method: 'POST', body: JSON.stringify(formValues(event.currentTarget))
      });
      toast('Адрес добавлен в справочник');
      await reload();
      openAddressBook(query, region);
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Аналитика выбранного дня: рейсы (выходят / в работе / прибывают),
// состояние парка на полдень, выручка дня и конфликты. Открывается кнопкой
// «Сегодня», выбором даты в тулбаре и кликом по дню в шапке Ганта.
function showDayAnalytics(dayIso) {
  const data = state.data;
  state.selectedDay = dayIso;
  renderMain();
  renderLegend();
  const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  const midpoint = dayStart + 43_200_000;
  const dayLabel = new Intl.DateTimeFormat('ru-RU',
    { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(dayStart));

  const trips = state.data.trips.filter(trip => trip.status !== 'rejected');
  const active = trips.filter(trip =>
    Date.parse(trip.starts_at) < dayEnd && Date.parse(trip.ends_at) > dayStart);
  const starting = active.filter(trip => Date.parse(trip.starts_at) >= dayStart);
  const ending = active.filter(trip => Date.parse(trip.ends_at) <= dayEnd);

  // Парк на полдень: рейс важнее диспозиции, резерв и простой различаются.
  const dispositionAt = {};
  (state.data.dispositions || [])
    .filter(item => Date.parse(item.starts_at) <= midpoint && midpoint < Date.parse(item.ends_at))
    .forEach(item => { dispositionAt[item.vehicle_id] = item.kind; });
  const busy = new Set(active.map(trip => trip.vehicle_id));
  const fleet = state.data.vehicles.filter(vehicle => vehicle.status === 'work');
  const counts = { work: 0, reserve: 0, repair: 0, no_driver: 0, shift: 0, out: 0, idle: 0 };
  fleet.forEach(vehicle => {
    if (busy.has(vehicle.id)) counts.work += 1;
    else if (dispositionAt[vehicle.id]) counts[dispositionAt[vehicle.id]] += 1;
    else counts.idle += 1;
  });

  // Выручка дня — по рейсам, завершающимся в этот день (б. НДС, наличные целиком).
  const calc = state.data.settings.calculation;
  const netOf = trip => trip.revenue_vat / (1 + (trip.cash ? 0
    : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
      ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22)));
  const dayNet = ending.reduce((sum, trip) => sum + netOf(trip), 0);

  // Конфликты дня: рейс пересекается с недоступностью сцепки (резерв — не конфликт).
  const conflicts = active.filter(trip => (state.data.dispositions || []).some(item =>
    item.kind !== 'reserve' && item.vehicle_id === trip.vehicle_id &&
    Date.parse(trip.starts_at) < Date.parse(item.ends_at) &&
    Date.parse(item.starts_at) < Date.parse(trip.ends_at) &&
    Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart));

  const tripRow = (trip, note) => `<div class="skpi-row" data-day-trip="${trip.id}" title="Открыть карточку рейса">
    <span style="flex:1;min-width:0"><strong>${escapeHtml(routeLabel(trip))}</strong>
      · <span class="mono">${escapeHtml(trip.vehicle_plate || '')}</span>
      <small class="muted" style="display:block">${escapeHtml(trip.customer_name || 'без заказчика')} · ${note}</small></span>
    <b>${money(trip.revenue_vat)}</b></div>`;
  const listBlock = (title, rows, empty) => `<h3 style="margin:14px 0 6px;font-size:var(--fs-sm);color:var(--muted);text-transform:uppercase">${title}</h3>
    <div class="list">${rows || `<p class="muted">${empty}</p>`}</div>`;

  showModal(`<h2>Аналитика дня · ${dayLabel}</h2>
    <div class="summary-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="metric"><span>Рейсов в работе</span><strong>${active.length}</strong></div>
      <div class="metric"><span>Выходят на линию</span><strong>${starting.length}</strong></div>
      <div class="metric"><span>Прибывают / выгрузка</span><strong>${ending.length}</strong></div>
      <div class="metric"><span>Выручка дня б. НДС</span><strong>${money(dayNet)}</strong></div>
    </div>
    <p class="muted" style="margin:4px 0 0">Парк на этот день: в рейсе ${counts.work} ·
      резерв ${counts.reserve} · ремонт ${counts.repair} · без водителя ${counts.no_driver} ·
      пересменка ${counts.shift} · <b>простаивают ${counts.idle}</b>${conflicts.length
        ? ` · <span class="danger">конфликтов: ${conflicts.length}</span>` : ''}</p>
    ${listBlock(`Выходят на линию (${starting.length})`,
      starting.slice(0, 8).map(trip => tripRow(trip, `выход ${formatDateTime(trip.starts_at)}`)).join(''),
      'Выходов в этот день нет.')}
    ${listBlock(`Прибывают на выгрузку (${ending.length})`,
      ending.slice(0, 8).map(trip => tripRow(trip, `прибытие ${formatDateTime(trip.ends_at)}`)).join(''),
      'Прибытий в этот день нет.')}
    ${conflicts.length ? listBlock(`⚠ Конфликты (${conflicts.length})`,
      conflicts.slice(0, 5).map(trip => tripRow(trip, 'рейс пересекается с недоступностью сцепки')).join(''), '') : ''}
    <div class="modal-actions">
      <button type="button" class="button ghost" id="dayShowOnCanvas">Показать на канве</button>
      <button type="button" class="button ghost" data-close>Закрыть</button>
    </div>`, 'wide');
  document.querySelectorAll('[data-day-trip]').forEach(row =>
    row.addEventListener('click', () => {
      const trip = state.data.trips.find(item => item.id === row.dataset.dayTrip);
      if (trip) { closeModal(); openTrip(trip); }
    }));
  byId('dayShowOnCanvas').onclick = () => {
    closeModal();
    if (state.view !== 'gantt') { state.view = 'gantt'; renderViewTabs(); renderMain(); }
    const index = Math.floor((dayStart - state.month.getTime()) / 86_400_000);
    if (index < 0 || index >= monthDays(state.month)) {
      state.month = monthStart(new Date(dayStart));
      renderTimeline();
    }
    scrollToDay(Math.max(0, Math.floor((dayStart - state.month.getTime()) / 86_400_000) - 3));
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
const shiftGanttAnchor = direction => {
  const view = ganttView();
  const anchorIso = state.selectedDay || new Date().toISOString().slice(0, 10);
  const shiftDays = view.range === 'two' ? 14 : 7;
  selectDay(new Date(Date.parse(`${anchorIso}T00:00:00Z`) + direction * shiftDays * 86_400_000)
    .toISOString().slice(0, 10));
};
byId('periodPrev').onclick = () => {
  if (state.view === 'gantt' && (state.ganttRange || 'week') !== 'month') return shiftGanttAnchor(-1);
  if (!byId('periodPrev').disabled) state.month = addMonths(state.month, -1);
  renderMain();
};
byId('periodNext').onclick = () => {
  if (state.view === 'gantt' && (state.ganttRange || 'week') !== 'month') return shiftGanttAnchor(1);
  if (!byId('periodNext').disabled) state.month = addMonths(state.month, 1);
  renderMain();
};

// ── Горизонтальная прокрутка ганта ─────────────────────────────────────────
const board = document.querySelector('.board');

function dayWidthNow() {
  return Number(state.data?.settings.general.plannerCellWidth || 44);
}

// Актуальный горизонтальный скроллер: у «Ресурса» — внутренний .resscroll,
// у Ганта — сама доска.
function hScroller() {
  return document.querySelector('.resscroll') || board;
}

// Плавная прокрутка своими силами: нативный behavior:'smooth' доступен не везде.
function smoothScrollTo(left) {
  const scroller = hScroller();
  const start = scroller.scrollLeft;
  const target = Math.max(0, Math.min(left, scroller.scrollWidth - scroller.clientWidth));
  const delta = target - start;
  if (!delta) return;
  // В фоновой вкладке requestAnimationFrame заморожен — прокручиваем мгновенно.
  if (document.hidden) { scroller.scrollLeft = target; return; }
  const startedAt = performance.now();
  const duration = 220;
  const step = now => {
    const t = Math.min(1, (now - startedAt) / duration);
    scroller.scrollLeft = start + delta * (1 - (1 - t) ** 3);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Прокрутка к дню месяца (0-based), день оказывается у левого края видимой канвы.
function scrollToDay(index) {
  smoothScrollTo(Math.max(0, index * dayWidthNow() - 2));
}

byId('scrollLeft').onclick = () => smoothScrollTo(hScroller().scrollLeft - 7 * dayWidthNow());
byId('scrollRight').onclick = () => smoothScrollTo(hScroller().scrollLeft + 7 * dayWidthNow());
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
  selectDay(new Date().toISOString().slice(0, 10));
};
// Выбор даты: подсветка дня, пересчёт занятости и фильтров — без модалки.
// Аналитика дня осталась на клике по дню в шапке канвы.
function selectDay(dayIso) {
  state.selectedDay = dayIso;
  const dayMs = Date.parse(`${dayIso}T00:00:00Z`);
  if (dayMs < state.month.getTime() || dayMs >= addMonths(state.month, 1).getTime()) {
    state.month = monthStart(new Date(dayMs));
  }
  renderMain();
  renderLegend();
  scrollToDay(Math.max(0, Math.floor((dayMs - state.month.getTime()) / 86_400_000) - 3));
}
byId('dayPicker').onchange = event => {
  if (event.currentTarget.value) selectDay(event.currentTarget.value);
};
// Клик по дню в шапке Ганта — аналитика дня (drag-прокрутка клик подавляет).
board.addEventListener('click', event => {
  const cell = event.target.closest('.day-cell[data-day-iso]');
  if (!cell) return;
  const head = event.target.closest('.timeline-head');
  if (head?.dataset.suppressClick) { delete head.dataset.suppressClick; return; }
  showDayAnalytics(cell.dataset.dayIso);
});

// Перетаскивание канвы за шапку дней (drag-scroll) — как в настольных гантах.
board.addEventListener('pointerdown', event => {
  const head = event.target.closest('.timeline-head');
  if (!head || event.target.closest('.vehicle-cell')) return;
  // В «Ресурсе» канва прокручивается внутри .resscroll, в Ганте — доской.
  const scroller = head.closest('.resscroll') || board;
  const startX = event.clientX;
  const startLeft = scroller.scrollLeft;
  try { head.setPointerCapture(event.pointerId); } catch { /* синтетические события без capture */ }
  head.classList.add('dragging-scroll');
  const onMove = moveEvent => {
    if (Math.abs(moveEvent.clientX - startX) > 5) head.dataset.suppressClick = '1';
    scroller.scrollLeft = startLeft - (moveEvent.clientX - startX);
  };
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
  const head = event.target.closest('.timeline-head');
  if (!event.shiftKey && head && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    (head.closest('.resscroll') || board).scrollLeft += event.deltaY;
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
