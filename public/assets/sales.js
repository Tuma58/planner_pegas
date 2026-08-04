// Доска отдела продаж — перенос renderSalesBoard из прототипа ТК 21:
// слева «Потребность от логистики» (освобождающиеся сцепки с предложением обратного груза),
// справа форма бронирования с оценкой осуществимости и портфель заявок со стадиями.
// Назначение ТС — через POST /api/orders/:id/assign (право trips:write).
import { api, escapeHtml, formatDateTime, formValues, money, routeLabel, toLocalInput, toast } from './api.js';
import { STAGES, inSalesPortfolio, myTasks, orderStage, pipelineStep, waitingLabel } from './pipeline.js';

export { STAGES, orderStage };

const fmtDay = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(value));
// Планирование ведётся с точностью до минут: окна погрузки и моменты освобождения
// показываются вместе с временем суток.
const fmtDateTime = formatDateTime;

// Значение для <input type="datetime-local"> — в часовом поясе предприятия.
const inputValue = toLocalInput;

// Дефолты планирования: погрузка с 08:00, приём груза до 18:00,
// подача под погрузку — через 2 часа после освобождения сцепки.
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 18;
const DISPATCH_LAG_MS = 2 * 3_600_000;

function atHour(date, hour) {
  const result = new Date(date);
  result.setUTCHours(hour, 0, 0, 0);
  return result;
}

function routeInfo(data, fromId, toId) {
  const rates = data.reference.routeRates;
  const rate = rates.find(item => item.from_zone_id === fromId && item.to_zone_id === toId)
    || rates.find(item => item.from_zone_id === toId && item.to_zone_id === fromId);
  const settings = data.settings.calculation;
  const distance = Number(rate?.distance_km || 500);
  const transit = distance / Number(settings.dailyMileageKm || 600) + Number(settings.handlingDays || 0.5);
  return { distance, transit, rate: Number(rate?.default_rate_vat || Math.round(distance * 120)) };
}

// Освобождающиеся сцепки: последний рейс ТС заканчивается до конца месяца —
// сцепке нужен обратный груз из зоны выгрузки.
// ТС в ремонте или без водителя в потребность не попадает: предлагать её
// клиентам рано. Появляется за сутки до окончания диспозиции с пометкой
// «выйдет из ремонта / получит водителя такого-то числа — требуется загрузка».
export function autoRequests(data, monthStartDate, monthEndDate) {
  const requests = [];
  const nowMs = Date.now();
  const zoneByName = Object.fromEntries(data.reference.zones.map(zone => [zone.name, zone]));
  data.vehicles.filter(vehicle => vehicle.status === 'work').forEach(vehicle => {
    const trips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
      .sort((a, b) => a.ends_at.localeCompare(b.ends_at));
    const last = trips[trips.length - 1] || null;
    const tripFreeMs = last ? Date.parse(last.ends_at) : 0;
    // Блокирующие интервалы (ремонт, без водителя), заканчивающиеся позже рейса:
    // сцепка реально доступна после самого позднего из них.
    const blocking = (data.dispositions || []).filter(item =>
      item.vehicle_id === vehicle.id && ['repair', 'no_driver'].includes(item.kind) &&
      Date.parse(item.ends_at) > Math.max(tripFreeMs, nowMs - 86_400_000));
    const blockEndMs = blocking.length ? Math.max(...blocking.map(item => Date.parse(item.ends_at))) : 0;
    // До выхода из ремонта/появления водителя больше суток — не потребность.
    if (blockEndMs > nowMs + 86_400_000) return;
    const blocked = blockEndMs > nowMs
      ? blocking.find(item => Date.parse(item.ends_at) === blockEndMs) : null;
    const endsAt = new Date(Math.max(tripFreeMs, blockEndMs));
    if (!tripFreeMs && !blockEndMs) return;
    // Уже простаивающие показываются независимо от месяца последнего рейса
    // (июльские хвосты — самый долгий и дорогой простой); будущие
    // освобождения — в пределах открытого месяца.
    const idleMs = nowMs - endsAt.getTime();
    if (idleMs <= 0 && (endsAt >= monthEndDate || endsAt < monthStartDate)) return;
    const zone = zoneByName[last?.to_name] || zoneByName[vehicle.zone_name];
    if (!zone) return;
    // Предложение обратного груза: самое доходное направление из зоны выгрузки.
    const lanes = data.reference.routeRates
      .filter(rate => rate.from_zone_id === zone.id)
      .sort((a, b) => b.default_rate_vat - a.default_rate_vat);
    const suggestion = lanes[0];
    const customer = suggestion
      ? data.trips.find(trip => trip.from_name === zone.name && trip.to_name === suggestion.to_name)?.customer_name
      : null;
    requests.push({
      vehicle, zone,
      freeAt: endsAt.toISOString(),
      // Простой: сцепка уже стоит без загрузки (idleMs > 0) — приоритет продаж.
      idleMs: Math.max(0, idleMs),
      // «Выйдет из ремонта / получит водителя» — пометка для менеджера.
      blockedKind: blocked?.kind || null,
      blockedUntil: blocked?.ends_at || null,
      // Погрузка возможна не раньше подачи (норматив после выгрузки);
      // для уже простаивающих — от текущего момента. Окно — до конца вторых суток.
      loadFrom: new Date(Math.max(endsAt.getTime(), nowMs) + DISPATCH_LAG_MS).toISOString(),
      windowTo: new Date(Math.min(
        atHour(new Date(Math.max(endsAt.getTime(), nowMs) + 2 * 86_400_000), WORK_END_HOUR).getTime(),
        monthEndDate.getTime()
      )).toISOString(),
      suggestTo: suggestion?.to_name || null,
      suggestToId: suggestion?.to_zone_id || null,
      suggestRate: suggestion?.default_rate_vat || 0,
      suggestCustomer: customer || ''
    });
  });
  return requests.sort((a, b) => a.freeAt.localeCompare(b.freeAt));
}

// Кандидаты на назначение: свободные в зоне отправления к началу окна, затем ближайшие.
// Занятость определяется точным пересечением по времени — две заявки в один день
// с разным временем погрузки не конфликтуют.
export function matchVehicles(data, fromZoneName, windowFrom) {
  const moment = Date.parse(windowFrom);
  const busy = new Set(data.trips
    .filter(trip => trip.status !== 'rejected' &&
      Date.parse(trip.starts_at) <= moment && Date.parse(trip.ends_at) > moment)
    .map(trip => trip.vehicle_id));
  // Недоступные на момент погрузки (ремонт, без водителя, пересменка, выведена)
  // кандидатами не предлагаются — та же логика, что и в потребности от логистики.
  const blocked = new Set((data.dispositions || [])
    .filter(item => item.kind !== 'work' &&
      Date.parse(item.starts_at) <= moment && moment < Date.parse(item.ends_at))
    .map(item => item.vehicle_id));
  return data.vehicles
    .filter(vehicle => vehicle.status === 'work' && !busy.has(vehicle.id) && !blocked.has(vehicle.id))
    .map(vehicle => {
      const lastTrip = data.trips
        .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
          Date.parse(trip.ends_at) <= moment)
        .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      const zoneName = lastTrip ? lastTrip.to_name : vehicle.zone_name;
      // Готовность к подаче: освободившейся сцепке нужен норматив на подачу под погрузку.
      const readyAt = lastTrip ? Date.parse(lastTrip.ends_at) + DISPATCH_LAG_MS : null;
      return {
        vehicle, zoneName, inZone: zoneName === fromZoneName,
        readyAt, ready: !readyAt || readyAt <= moment
      };
    })
    .sort((a, b) => Number(b.inZone) - Number(a.inZone) || Number(b.ready) - Number(a.ready));
}

export function renderSales(container, context) {
  const { state, can } = context;
  const data = state.data;
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  // Фильтр доски: геозона + диапазон дат (хранится в state, переживает перерисовки).
  const filter = state.salesFilter || (state.salesFilter = { zone: '', from: '', to: '', q: '' });
  filter.q ||= '';
  const query = filter.q.toLowerCase();
  const inDateRange = iso => {
    const day = String(iso).slice(0, 10);
    return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
  };
  const allRequests = autoRequests(data, state.month, monthEnd);
  const requests = allRequests.filter(request =>
    (!filter.zone || request.zone.name === filter.zone) && inDateRange(request.freeAt) &&
    (!query || `${request.vehicle.plate} ${request.vehicle.type_name} ${request.zone.name} ${request.suggestCustomer || ''}`
      .toLowerCase().includes(query)));
  // Заявка проходит фильтр, если зона участвует в маршруте, окно погрузки
  // пересекает диапазон, а текст поиска найден в заказчике или маршруте.
  const matchesFilter = order =>
    (!filter.zone || order.from_name === filter.zone || order.to_name === filter.zone) &&
    (!filter.from || String(order.window_to).slice(0, 10) >= filter.from) &&
    (!filter.to || String(order.window_from).slice(0, 10) <= filter.to) &&
    (!query || `${order.customer_name} ${routeLabel(order)} ${order.rejection_reason || ''}`
      .toLowerCase().includes(query));
  // Портфель продаж — заявки до назначения ТС: после назначения заявка уходит
  // к логисту в план и возвращается только при отклонении рейса.
  // Отклонённые (cancelled с причиной) — в отдельном реестре ниже.
  const allOrders = data.orders.filter(order => inSalesPortfolio(order, data));
  const orders = allOrders.filter(matchesFilter);
  // Удалённые (deleted_at) в оперативном реестре не показываются —
  // они остаются в БД и видны в отчёте «Реестр заявок» для аналитики.
  const rejectedOrders = data.orders
    .filter(order => order.status === 'cancelled' && !order.deleted_at)
    .filter(matchesFilter);
  // «В плане у логиста» — ушедшие из портфеля: ТС назначено, рейс не отклонён.
  const assigned = data.orders.filter(order =>
    order.status !== 'cancelled' && !inSalesPortfolio(order, data)).length;
  const returned = orders.filter(order => order.returned_at).length;
  const awaitingAssign = orders.filter(order => orderStage(order, data).stage === 1).length;
  const tasks = myTasks(orders, data, can);
  const onlyMine = Boolean(state.salesOnlyMine);
  const filterActive = filter.zone || filter.from || filter.to || filter.q;
  const zoneOptions = data.reference.zones.map(zone => `<option value="${zone.id}">${escapeHtml(zone.name)}</option>`).join('');
  const orderOptions = data.settings.orderOptions || {};
  const temps = (orderOptions.temperatureModes || []).map(item => `<option>${escapeHtml(item)}</option>`).join('');
  const bodies = (orderOptions.bodyTypes || []).map(item => `<option>${escapeHtml(item)}</option>`).join('');

  const blockedNote = request => request.blockedKind
    ? `<small style="display:block;color:var(--warn);font-weight:700">⚙ ${request.blockedKind === 'repair'
        ? 'выйдет из ремонта' : 'получит водителя'} ${fmtDateTime(request.blockedUntil)}
        в «${escapeHtml(request.zone.name)}» — требуется загрузка</small>` : '';
  const idleLabel = ms => {
    const days = Math.floor(ms / 86_400_000);
    return days >= 1 ? `${days} дн` : `${Math.max(1, Math.floor(ms / 3_600_000))} ч`;
  };
  // Раздел разделён на два состояния: сцепки, которые УЖЕ стоят без загрузки
  // (потерянные машино-дни, самые залежавшиеся сверху), и будущие освобождения
  // открытого месяца (планирование загрузки заранее).
  const idleRequests = requests.filter(request => request.idleMs > 0)
    .sort((a, b) => b.idleMs - a.idleMs);
  const upcomingRequests = requests.filter(request => !request.idleMs);
  const idleDaysTotal = Math.round(idleRequests.reduce((sum, request) => sum + request.idleMs, 0) / 86_400_000);
  const requestCard = request => {
    const index = requests.indexOf(request);
    const idleBadge = request.idleMs > 0
      ? `<span class="badge ${request.idleMs > 2 * 86_400_000 ? 'bad' : 'warn'}"
          title="Стоит без загрузки с ${fmtDateTime(request.freeAt)}">стоит ${idleLabel(request.idleMs)}</span>` : '';
    return `<div class="list-item req" data-req="${index}">
      <span style="flex:1;min-width:0">
        <strong class="mono">${escapeHtml(request.vehicle.plate)}</strong> · ${escapeHtml(request.vehicle.type_name)} ${idleBadge}
        <small class="muted" style="display:block">${request.idleMs > 0 ? 'стоит' : 'освободится'} в «${escapeHtml(request.zone.name)}»
          ${request.idleMs > 0 ? `с ${fmtDateTime(request.freeAt)}` : fmtDateTime(request.freeAt)} · подача с ${fmtDateTime(request.loadFrom)}</small>
        ${blockedNote(request)}
        ${request.suggestTo ? `<small class="muted" style="display:block">→ ${escapeHtml(request.zone.name)}→${escapeHtml(request.suggestTo)}${request.suggestCustomer ? `, ${escapeHtml(request.suggestCustomer)}` : ''} · ${money(request.suggestRate)}</small>` : ''}
      </span>
      <span class="reqzone" style="background:${request.zone.color}">${escapeHtml(request.zone.name)}</span>
    </div>`;
  };
  const requestList = requests.length
    ? `${idleRequests.length ? `<div class="scolh" style="margin:2px 0 6px">Простаивают сейчас
          <span>${idleRequests.length}</span>
          <small class="muted" style="text-transform:none;font-weight:600">· потеряно ${idleDaysTotal} маш-дн</small></div>
        ${idleRequests.map(requestCard).join('')}` : ''}
      ${upcomingRequests.length ? `<div class="scolh" style="margin:10px 0 6px">Освободятся в этом месяце
          <span>${upcomingRequests.length}</span></div>
        ${upcomingRequests.map(requestCard).join('')}` : ''}`
    : '<p class="muted">Нет потребности — весь парк загружен.</p>';

  const stepper = stage => `<div class="stepper">${STAGES.map((_, index) =>
    `<span class="stp ${index <= stage ? 'on' : ''}"></span>`).join('')}<span class="stpl">${STAGES[stage] || STAGES[0]}</span></div>`;

  // Карточка конвейера: стадия, чей ход, сколько ждёт и кнопка действия.
  // Порядок предсказуемый: новые заявки сверху и НЕ мигрируют по списку после
  // подтверждения — иначе при большом портфеле карточка «пропадает» из вида
  // (пользователи искали её на прежнем месте и создавали дубли).
  // Залежавшиеся видны по метке времени ожидания, задачи — по тумблеру «мои».
  const canReject = can('orders:write') || can('trips:write');
  const withStep = orders.map(order => ({ order, step: pipelineStep(order, data, can) }));
  const visible = (onlyMine ? withStep.filter(item => item.step.mine) : withStep)
    .sort((a, b) => String(b.order.created_at).localeCompare(String(a.order.created_at)));

  const portfolio = visible.map(({ order, step }) => {
    const waiting = step.waitingRole
      ? (step.mine ? '<span class="pipe-badge mine">Ваш ход</span>'
        : `<span class="pipe-badge">Ждёт: ${escapeHtml(step.waitingRole)}</span>`)
      : '<span class="pipe-badge done">Закрыта</span>';
    const since = step.sinceMs > 3_600_000 && step.waitingRole
      ? `<span class="pipe-since ${step.sinceMs > 2 * 86_400_000 ? 'stale' : ''}">${waitingLabel(step.sinceMs)}</span>` : '';
    const action = step.action && step.mine
      ? `<button class="button small" data-act="${step.action.kind}" data-order="${order.id}"
          ${step.action.status ? `data-status="${step.action.status}"` : ''}
          title="${escapeHtml(step.action.hint || '')}">${escapeHtml(step.action.label)}</button>`
      : '';
    const reassign = step.hot && can('trips:write')
      ? `<button class="button small danger" data-act="assign" data-order="${order.id}">⚠ Переназначить ТС</button>` : '';
    return `<div class="list-item ordrow pipe-${step.tone}" data-order="${order.id}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        ${step.plate ? ` · <span class="mono">${escapeHtml(step.plate)}</span>` : ''}
        <small class="muted" style="display:block">${escapeHtml(order.body_type || 'Рефрижератор')} · ${escapeHtml(order.temperature_mode || '—')} · окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)}</small>
        ${order.comment ? `<small class="muted" style="display:block">💬 ${escapeHtml(order.comment)}</small>` : ''}
        ${order.returned_at ? `<small class="returned-note">↩ вернулась из плана: ${escapeHtml(order.rejection_reason || 'без причины')}</small>` : ''}
        <div class="stepper-row">${stepper(step.stage)}<span class="pipe-inline">${waiting}${since}</span></div>
      </span>
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        <b>${money(order.rate_vat)}</b>
        ${reassign || action}
        <span style="display:flex;gap:5px">
          ${can('orders:write') ? `<button class="button ghost small" data-edit-order="${order.id}"
            title="Изменить потребность: заказчик, пункты, окно, ставка">Изменить</button>` : ''}
          ${step.canReject ? `<button class="button ghost small" data-act="reject" data-order="${order.id}">Отклонить</button>` : ''}
        </span>
      </span>
    </div>`;
  }).join('') || `<p class="muted">${onlyMine ? 'Задач для вас нет — конвейер ждёт другие роли.' : 'Потребностей клиента пока нет — заполните форму слева.'}</p>`;

  // Реестр отклонённых: заявки, на которые ТС так и не назначили.
  const rejectedList = rejectedOrders.map(order => `<div class="list-item ordrow rejected-order">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        <small class="muted" style="display:block">окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)} · ${money(order.rate_vat)}</small>
        <small class="reject-note">✕ ${escapeHtml(order.rejection_reason || 'без причины')}</small>
      </span>
      <span style="display:flex;gap:5px">
        ${canReject ? `<button class="button ghost small" data-restore="${order.id}">Вернуть в работу</button>` : ''}
        ${can('orders:write') ? `<button class="button ghost small danger" data-delete-order="${order.id}"
          title="Убрать из оперативного реестра; для аналитики останется в отчёте «Реестр заявок»">Удалить</button>` : ''}
      </span>
    </div>`).join('') || '<p class="muted">Отклонённых заявок нет.</p>';

  // Оперативная сводка (переехала из боковой панели Ганта): считается только
  // по текущему открытому периоду — рейсы, завершающиеся в выбранном месяце,
  // прошлые периоды (июль) в цифры не попадают.
  const calc = data.settings.calculation;
  const periodTrips = data.trips.filter(trip => trip.status !== 'rejected' &&
    new Date(trip.ends_at) >= state.month && new Date(trip.ends_at) < monthEnd);
  const periodNet = periodTrips.reduce((sum, trip) => {
    const vat = /\bИП\b/iu.test(trip.customer_name)
      ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22);
    return sum + trip.revenue_vat / (1 + vat);
  }, 0);
  const periodLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' }).format(state.month);

  // Плашки-KPI кликабельны: выпадающий список позиций категории,
  // выбор заявки открывает редактирование (суммы, времена и остальное).
  const inPlanOrders = data.orders
    .filter(order => order.status !== 'cancelled' && !inSalesPortfolio(order, data))
    .sort((a, b) => String(a.window_from).localeCompare(String(b.window_from)));
  const kpiDrop = (key, rows) => state.salesKpiOpen === key
    ? `<div class="skpi-drop">${rows || '<div class="skpi-row muted">Пусто</div>'}</div>` : '';
  const orderRow = order => {
    const trip = order.trip_id ? data.trips.find(item => item.id === order.trip_id) : null;
    return `<div class="skpi-row" data-kpi-order="${order.id}">
      <span style="flex:1;min-width:0"><strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        <small class="muted" style="display:block">окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)}
          ${trip ? ` · <span class="mono">${escapeHtml(trip.vehicle_plate || '')}</span>` : ''}</small></span>
      <b>${money(order.rate_vat)}</b></div>`;
  };
  const requestRow = (request, index) => `<div class="skpi-row" data-kpi-req="${index}">
      <span style="flex:1;min-width:0"><strong class="mono">${escapeHtml(request.vehicle.plate)}</strong> · ${escapeHtml(request.zone.name)}
        <small class="muted" style="display:block">${request.idleMs > 0
          ? `стоит ${Math.max(1, Math.floor(request.idleMs / 86_400_000))} дн с ${fmtDateTime(request.freeAt)}`
          : `освободится ${fmtDateTime(request.freeAt)}`}${request.blockedKind
          ? ` · ⚙ ${request.blockedKind === 'repair' ? 'из ремонта' : 'получит водителя'}` : ''}</small></span></div>`;
  container.innerHTML = `<div class="saleswrap">
    <div class="salekpis">
      <div class="skpi clickable ${state.salesKpiOpen === 'requests' ? 'open' : ''}" data-kpi="requests"
        title="Освобождающиеся сцепки — выбор заполняет форму бронирования">
        <span class="skl">Потребность от логистики</span><span class="skv">${requests.length}${filterActive ? `<small class="muted"> / ${allRequests.length}</small>` : ''}</span>
        ${kpiDrop('requests', requests.map(requestRow).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'portfolio' ? 'open' : ''}" data-kpi="portfolio"
        title="Заявки портфеля — выбор открывает редактирование">
        <span class="skl">Потребность клиента</span><span class="skv">${orders.length}${filterActive ? `<small class="muted"> / ${allOrders.length}</small>` : ''}</span>
        ${kpiDrop('portfolio', orders.map(orderRow).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'awaiting' ? 'open' : ''}" data-kpi="awaiting"
        title="Подтверждённые без ТС — выбор открывает редактирование">
        <span class="skl">Ждут назначения ТС</span><span class="skv">${awaitingAssign}</span>
        ${kpiDrop('awaiting', orders.filter(order => orderStage(order, data).stage === 1).map(orderRow).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'logist' ? 'open' : ''}" data-kpi="logist"
        title="Назначенные заявки в плане (Гант) — выбор открывает редактирование">
        <span class="skl">В плане у логиста</span><span class="skv">${assigned}</span>
        ${kpiDrop('logist', inPlanOrders.map(orderRow).join(''))}</div>
      <div class="skpi" title="Оперативная сводка по текущему периоду: рейсы, завершающиеся в открытом месяце">
        <span class="skl">Рейсов за ${escapeHtml(periodLabel)}</span><span class="skv">${periodTrips.length}</span></div>
      <div class="skpi" title="Выручка без НДС по рейсам, завершающимся в текущем периоде (ставка НДС ИП — 7%)">
        <span class="skl">Выручка б. НДС ${escapeHtml(periodLabel)}</span><span class="skv">${money(periodNet)}</span></div>
      <div class="salesfilter">
        <span class="skl">Фильтр</span>
        <input id="salesSearch" class="block-search" placeholder="Поиск: заказчик, маршрут, ТС"
          value="${escapeHtml(filter.q)}">
        <select id="salesFilterZone">
          <option value="">Все геозоны</option>
          ${data.reference.zones.map(zone =>
            `<option value="${escapeHtml(zone.name)}" ${filter.zone === zone.name ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('')}
        </select>
        <input type="date" id="salesFilterFrom" value="${filter.from}" title="С даты">
        <span class="muted">–</span>
        <input type="date" id="salesFilterTo" value="${filter.to}" title="По дату">
        ${filterActive ? '<button class="button ghost small" id="salesFilterReset">✕ Сброс</button>' : ''}
      </div>
    </div>
    <div class="salesboard">
      <div class="scol">
        <div class="scolh">Потребность от логистики <span>${requests.length}</span></div>
        <div class="list">${requestList}</div>
        <div class="geohint">Клик по строке заполняет бронирование обратного груза в форме справа.</div>
      </div>
      <div class="scol">
        <div class="scolh">Потребность клиента <span>${orders.length}</span></div>
        <form id="salesForm">
          <label class="field">Заказчик
            <input name="customerName" list="salesCustomers" placeholder="выберите из справочника или введите нового"
              autocomplete="off" required>
            <datalist id="salesCustomers"></datalist>
          </label>
          <div class="form-grid">
            <label class="field">Пункт погрузки<input name="fromPoint" id="salesFromPoint" list="salesPlaces"
              placeholder="город / посёлок" autocomplete="off"></label>
            <label class="field">Пункт выгрузки<input name="toPoint" id="salesToPoint" list="salesPlaces"
              placeholder="город / посёлок" autocomplete="off"></label>
          </div>
          <datalist id="salesPlaces">${data.reference.zones.flatMap(zone =>
            [zone.name, ...(zone.aliases || [])]).sort()
            .map(place => `<option value="${escapeHtml(place)}"></option>`).join('')}</datalist>
          <div class="form-grid">
            <label class="field">Геозона откуда<select name="fromZoneId" id="salesFrom">${zoneOptions}</select></label>
            <label class="field">Геозона куда<select name="toZoneId" id="salesTo">${zoneOptions}</select></label>
          </div>
          <div class="form-grid">
            <label class="field">Темп. режим<select name="temperatureMode">${temps}</select></label>
            <label class="field">Кузов<select name="bodyType">${bodies}</select></label>
          </div>
          <div class="form-grid">
            <label class="field">Окно с<input name="windowFrom" id="salesWinFrom" type="datetime-local" required
              value="${inputValue(atHour(state.month, WORK_START_HOUR))}"></label>
            <label class="field">Окно по<input name="windowTo" id="salesWinTo" type="datetime-local" required
              value="${inputValue(atHour(new Date(state.month.getTime() + 2 * 86_400_000), WORK_END_HOUR))}"></label>
          </div>
          <label class="field">Ставка с НДС, ₽ (пусто = рыночная)<input name="rateVat" id="salesRate" type="number" min="0"></label>
          <label class="field">Комментарий к рейсу<input name="comment" maxlength="500"
            placeholder="адрес, контакт, особенности погрузки" autocomplete="off"></label>
          <div id="salesFeas" class="feas"></div>
          <button class="button full">Забронировать</button>
        </form>
        <div class="scolh" style="margin-top:14px">Портфель · потребности клиента <span>${orders.length}</span>
          <button type="button" class="mine-toggle ${onlyMine ? 'on' : ''}" id="salesMyTasks"
            title="Показать только заявки, ожидающие вашего действия">мои: ${tasks.length}</button></div>
        <div class="list">${portfolio}</div>
        <div class="geohint">После назначения ТС заявка уходит к логисту в план (Гант) и в портфеле
          не показывается; вернётся как новая только при отклонении рейса.</div>
        <details class="rejected-details" ${state.salesRejectedOpen ? 'open' : ''} id="salesRejected">
          <summary>Отклонённые заявки <span class="scount">${rejectedOrders.length}</span></summary>
          <div class="list" style="margin-top:8px">${rejectedList}</div>
          <div class="geohint">Заявка попадает сюда, если ТС не назначено и указана причина отказа.
            «Вернуть в работу» переводит её обратно в портфель как новую.</div>
        </details>
      </div>
    </div>
  </div>`;

  const rerender = () => renderSales(container, context);
  const salesSearch = container.querySelector('#salesSearch');
  salesSearch.oninput = () => {
    filter.q = salesSearch.value;
    const caret = salesSearch.selectionStart;
    rerender();
    const again = container.querySelector('#salesSearch');
    again.focus();
    again.setSelectionRange(caret, caret);
  };
  container.querySelector('#salesFilterZone').onchange = event => {
    filter.zone = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterFrom').onchange = event => {
    filter.from = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterTo').onchange = event => {
    filter.to = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterReset')?.addEventListener('click', () => {
    state.salesFilter = { zone: '', from: '', to: '', q: '' };
    rerender();
  });

  // Справочник заказчиков для выбора в форме: загружается один раз (кэш в state),
  // datalist сохраняет и свободный ввод — нового клиента можно вписать как раньше.
  const customersDatalist = container.querySelector('#salesCustomers');
  const fillCustomers = items => {
    customersDatalist.innerHTML = [...new Set(items.map(item => item.name))]
      .map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  };
  if (state.customersDirectory) fillCustomers(state.customersDirectory);
  else {
    api('/api/customers?q=').then(result => {
      state.customersDirectory = result.items;
      fillCustomers(result.items);
    }).catch(() => { /* нет права customers:read — останется свободный ввод */ });
  }
  // Ввод пункта автоматически определяет геозону по справочнику алиасов —
  // менеджер думает городами, зональная структура заполняется сама.
  const zoneByPlace = place => {
    const needle = String(place || '').trim().toLowerCase();
    if (!needle) return null;
    return data.reference.zones.find(zone => zone.name.toLowerCase() === needle ||
      (zone.aliases || []).some(alias => alias.toLowerCase() === needle)) || null;
  };
  [['salesFromPoint', 'salesFrom'], ['salesToPoint', 'salesTo']].forEach(([pointId, zoneId]) => {
    container.querySelector(`#${pointId}`).addEventListener('change', event => {
      const zone = zoneByPlace(event.currentTarget.value);
      if (zone) {
        container.querySelector(`#${zoneId}`).value = zone.id;
        feasibility();
      }
    });
  });

  // Выбор известного клиента подставляет его основное направление и рыночную ставку.
  container.querySelector('[name="customerName"]').addEventListener('change', event => {
    const name = event.currentTarget.value.trim();
    const entries = (state.customersDirectory || []).filter(item => item.name === name);
    if (!entries.length) return;
    const main = entries.sort((a, b) => b.trip_count - a.trip_count)[0];
    if (main.from_zone_id) container.querySelector('#salesFrom').value = main.from_zone_id;
    if (main.to_zone_id) container.querySelector('#salesTo').value = main.to_zone_id;
    feasibility();
    // Средняя ставка клиента — точнее рыночной по направлению, ставим после пересчёта.
    const rate = container.querySelector('#salesRate');
    if (!rate.value && main.average_rate_vat) {
      rate.placeholder = Math.round(main.average_rate_vat).toLocaleString('ru-RU');
    }
  });

  const feasibility = () => {
    const fromId = container.querySelector('#salesFrom').value;
    const toId = container.querySelector('#salesTo').value;
    const windowFrom = container.querySelector('#salesWinFrom').value;
    const info = routeInfo(data, fromId, toId);
    const rateInput = container.querySelector('#salesRate');
    if (!rateInput.value) rateInput.placeholder = info.rate.toLocaleString('ru-RU');
    const fromName = data.reference.zones.find(zone => zone.id === fromId)?.name;
    // Значение datetime-local не содержит зоны — трактуем как UTC, как и остальные метки времени.
    const startsAt = windowFrom ? `${windowFrom}:00.000Z` : null;
    const candidates = startsAt ? matchVehicles(data, fromName, startsAt) : [];
    const best = candidates[0];
    const arrival = startsAt
      ? new Date(Date.parse(startsAt) + info.transit * 86_400_000).toISOString() : null;
    const hours = Math.round(info.transit * 24);
    container.querySelector('#salesFeas').innerHTML = `
      <div class="feas-t">Осуществимость</div>
      <div class="feas-row"><span>Рыночная ставка</span><b>${money(info.rate)}</b></div>
      <div class="feas-row"><span>Срок доставки</span><b>${hours} ч · ${info.distance.toLocaleString('ru-RU')} км</b></div>
      ${arrival ? `<div class="feas-row"><span>Прибытие ~</span><b>${fmtDateTime(arrival)}</b></div>` : ''}
      <div class="feas-row ${best ? 'ok' : 'bad'}"><span>Свободная сцепка</span>
        <b>${best
          ? `${escapeHtml(best.vehicle.plate)} · ${best.inZone ? 'в зоне' : escapeHtml(best.zoneName || 'перегон')}`
          : 'нет свободной к сроку'}</b></div>
      ${best && !best.ready
        ? `<div class="feas-row bad"><span>Готова к подаче</span><b>${fmtDateTime(best.readyAt)}</b></div>` : ''}`;
  };
  ['salesFrom', 'salesTo', 'salesWinFrom'].forEach(id =>
    container.querySelector(`#${id}`).addEventListener('change', feasibility));
  feasibility();

  const fillRequestForm = request => {
    container.querySelector('#salesFrom').value = request.zone.id;
    if (request.suggestToId) container.querySelector('#salesTo').value = request.suggestToId;
    container.querySelector('[name="customerName"]').value = request.suggestCustomer || '';
    container.querySelector('#salesRate').value = request.suggestRate || '';
    container.querySelector('#salesWinFrom').value = inputValue(request.loadFrom);
    container.querySelector('#salesWinTo').value = inputValue(request.windowTo);
    feasibility();
    toast('Бронирование обратного груза заполнено');
  };
  container.querySelectorAll('[data-req]').forEach(element =>
    element.addEventListener('click', () => {
      const request = requests[Number(element.dataset.req)];
      if (request) fillRequestForm(request);
    }));

  // Плашки-KPI: клик раскрывает список категории; выбор заявки открывает
  // редактирование, выбор сцепки — заполняет форму бронирования.
  container.querySelectorAll('[data-kpi]').forEach(badge =>
    badge.addEventListener('click', event => {
      if (event.target.closest('.skpi-drop')) return;
      const key = badge.dataset.kpi;
      state.salesKpiOpen = state.salesKpiOpen === key ? null : key;
      rerender();
    }));
  container.querySelectorAll('[data-kpi-order]').forEach(row =>
    row.addEventListener('click', () => {
      const order = data.orders.find(item => item.id === row.dataset.kpiOrder);
      state.salesKpiOpen = null;
      rerender();
      if (order) editOrderDialog(order, data, context);
    }));
  container.querySelectorAll('[data-kpi-req]').forEach(row =>
    row.addEventListener('click', () => {
      const request = requests[Number(row.dataset.kpiReq)];
      state.salesKpiOpen = null;
      rerender();
      if (request) fillRequestForm(request);
    }));

  container.querySelector('#salesForm').onsubmit = async event => {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    if (!values.rateVat) {
      values.rateVat = routeInfo(data, values.fromZoneId, values.toZoneId).rate;
    }
    // Защита от дублей: похожая заявка уже в портфеле (тот же заказчик,
    // направление и пересекающееся окно) — вероятно, её просто не нашли в списке.
    const duplicate = allOrders.find(order =>
      order.customer_name.trim().toLowerCase() === String(values.customerName).trim().toLowerCase() &&
      order.from_zone_id === values.fromZoneId && order.to_zone_id === values.toZoneId &&
      Date.parse(order.window_from) < Date.parse(values.windowTo) &&
      Date.parse(values.windowFrom) < Date.parse(order.window_to));
    if (duplicate && !confirm(`Похожая заявка «${duplicate.customer_name}» с пересекающимся окном уже в портфеле (наверху списка). Создать ещё одну?`)) {
      return;
    }
    try {
      await api('/api/orders', { method: 'POST', body: JSON.stringify(values) });
      toast('Забронировано — заявка в портфеле (первая в списке)');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };

  container.querySelector('#salesMyTasks').onclick = () => {
    state.salesOnlyMine = !state.salesOnlyMine;
    rerender();
  };
  container.querySelector('#salesRejected').addEventListener('toggle', event => {
    state.salesRejectedOpen = event.currentTarget.open;
  });

  // Единая точка выполнения шага конвейера: действие сотрудника переводит заявку
  // на следующую стадию и тем самым ставит задачу следующей роли.
  container.querySelectorAll('[data-act]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      const order = orders.find(item => item.id === button.dataset.order);
      if (!order) return;
      const kind = button.dataset.act;
      if (kind === 'assign') return context.openAssign(order);
      if (kind === 'reject') return rejectDialog(order, data, context);
      button.disabled = true;
      try {
        if (kind === 'confirm') {
          await api(`/api/orders/${order.id}`, {
            method: 'PATCH', body: JSON.stringify({ stage: 1 })
          });
          toast('Подтверждено — задача передана логисту');
        } else if (kind === 'trip-status') {
          if (!order.trip_id) throw new Error('У заявки нет рейса');
          await api(`/api/trips/${order.trip_id}`, {
            method: 'PATCH', body: JSON.stringify({ status: button.dataset.status })
          });
          const next = { run: 'Рейс в пути', unloaded: 'Выгрузка отмечена', paid: 'Оплата отмечена' };
          toast(next[button.dataset.status] || 'Статус обновлён');
        }
        await context.onReload();
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'error');
      }
    }));

  container.querySelectorAll('[data-restore]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        await api(`/api/orders/${button.dataset.restore}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'new', stage: 0 })
        });
        toast('Заявка возвращена в работу');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));

  container.querySelectorAll('[data-edit-order]').forEach(button =>
    button.addEventListener('click', event => {
      event.stopPropagation();
      const order = orders.find(item => item.id === button.dataset.editOrder);
      if (order) editOrderDialog(order, data, context);
    }));

  container.querySelectorAll('[data-delete-order]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (!confirm('Убрать заявку из оперативного реестра? Для аналитики она останется в отчёте.')) return;
      try {
        await api(`/api/orders/${button.dataset.deleteOrder}`, { method: 'DELETE' });
        toast('Заявка удалена — доступна в отчёте «Реестр заявок»');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
}

// Редактирование потребности: те же поля, что и при бронировании.
// Вызывается из портфеля продаж, из выпадающих списков плашек-KPI
// и из блока логиста (карточка рейса в Ганте). Для назначенной заявки
// новая ставка синхронизируется с рейсом на сервере.
export function editOrderDialog(order, data, context) {
  const zoneOptions = selected => data.reference.zones.map(zone =>
    `<option value="${zone.id}" ${zone.id === selected ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('');
  const orderOptions = data.settings.orderOptions || {};
  const options = (items, current) => (items || []).map(item =>
    `<option ${item === current ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('');
  // Диалог вызывается и из продаж, и из блока логиста (Гант) — datalist
  // пунктов встроен в модалку, чтобы не зависеть от разметки доски продаж.
  const trip = order.trip_id ? data.trips.find(item => item.id === order.trip_id) : null;
  context.showModal(`<form id="editOrderForm">
    <h2>Изменить потребность</h2>
    <p class="muted">${escapeHtml(routeLabel(order))} · создана ${fmtDateTime(order.created_at)}</p>
    ${trip ? `<p class="muted">В плане у логиста: <span class="mono">${escapeHtml(trip.vehicle_plate || '')}</span>
      · рейс ${fmtDateTime(trip.starts_at)} → ${fmtDateTime(trip.ends_at)} — новая ставка обновит и рейс</p>` : ''}
    <label class="field">Заказчик
      <input name="customerName" list="salesCustomers" value="${escapeHtml(order.customer_name)}" required autocomplete="off">
    </label>
    <div class="form-grid">
      <label class="field">Пункт погрузки<input name="fromPoint" id="editFromPoint" list="editPlaces"
        value="${escapeHtml(order.from_point || '')}" autocomplete="off"></label>
      <label class="field">Пункт выгрузки<input name="toPoint" id="editToPoint" list="editPlaces"
        value="${escapeHtml(order.to_point || '')}" autocomplete="off"></label>
    </div>
    <datalist id="editPlaces">${data.reference.zones.flatMap(zone =>
      [zone.name, ...(zone.aliases || [])]).sort()
      .map(place => `<option value="${escapeHtml(place)}"></option>`).join('')}</datalist>
    <div class="form-grid">
      <label class="field">Геозона откуда<select name="fromZoneId" id="editFromZone">${zoneOptions(order.from_zone_id)}</select></label>
      <label class="field">Геозона куда<select name="toZoneId" id="editToZone">${zoneOptions(order.to_zone_id)}</select></label>
    </div>
    <div class="form-grid">
      <label class="field">Темп. режим<select name="temperatureMode">${options(orderOptions.temperatureModes, order.temperature_mode)}</select></label>
      <label class="field">Кузов<select name="bodyType">${options(orderOptions.bodyTypes, order.body_type)}</select></label>
    </div>
    <div class="form-grid">
      <label class="field">Окно с<input name="windowFrom" type="datetime-local" required value="${inputValue(order.window_from)}"></label>
      <label class="field">Окно по<input name="windowTo" type="datetime-local" required value="${inputValue(order.window_to)}"></label>
    </div>
    <label class="field">Ставка с НДС, ₽<input name="rateVat" type="number" min="0" value="${Number(order.rate_vat) || 0}"></label>
    <label class="field">Комментарий к рейсу<input name="comment" maxlength="500"
      value="${escapeHtml(order.comment || '')}" placeholder="адрес, контакт, особенности погрузки"></label>
    <div class="modal-actions">
      ${trip && context.openTrip ? `<button type="button" class="button ghost" id="editOrderTrip"
        title="Открыть карточку рейса: времена подачи, статус, удаление">Рейс</button>` : ''}
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button" type="submit">Сохранить</button>
    </div>
  </form>`);
  if (trip && context.openTrip) {
    document.getElementById('editOrderTrip').onclick = () => {
      context.closeModal();
      context.openTrip(trip);
    };
  }
  // Пункт определяет геозону по алиасам — как в форме бронирования.
  const zoneByPlace = place => {
    const needle = String(place || '').trim().toLowerCase();
    if (!needle) return null;
    return data.reference.zones.find(zone => zone.name.toLowerCase() === needle ||
      (zone.aliases || []).some(alias => alias.toLowerCase() === needle)) || null;
  };
  [['editFromPoint', 'editFromZone'], ['editToPoint', 'editToZone']].forEach(([pointId, zoneId]) => {
    document.getElementById(pointId).addEventListener('change', event => {
      const zone = zoneByPlace(event.currentTarget.value);
      if (zone) document.getElementById(zoneId).value = zone.id;
    });
  });
  document.getElementById('editOrderForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`/api/orders/${order.id}`, {
        method: 'PATCH', body: JSON.stringify(formValues(event.target))
      });
      context.closeModal();
      toast('Потребность обновлена');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Отклонение заявки: причина обязательна — она попадёт в реестр и отчёт.
// Используется и продажами (портфель), и логистом (очередь назначения).
export { rejectDialog as rejectOrderDialog };
function rejectDialog(order, data, context) {
  const reasons = data.settings.rejectionReasons || [];
  context.showModal(`<form id="rejectOrderForm">
    <h2>Отклонить заявку</h2>
    <p class="muted">${escapeHtml(order.customer_name)} · ${escapeHtml(routeLabel(order))}
      · ${money(order.rate_vat)}</p>
    <label class="field">Причина отказа
      <select name="rejectionReason" required>
        <option value="">— выберите причину —</option>
        ${reasons.map(reason => `<option>${escapeHtml(reason)}</option>`).join('')}
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button danger">Отклонить</button>
    </div>
  </form>`);
  document.getElementById('rejectOrderForm').onsubmit = async event => {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('rejectionReason');
    if (!reason) { toast('Выберите причину отказа', 'error'); return; }
    try {
      await api(`/api/orders/${order.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'cancelled', rejectionReason: reason })
      });
      context.closeModal();
      toast('Заявка отклонена');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Модалка назначения ТС (маркетплейс-стиль из ТК 21).
// options.autoConfirm — назначение из вкладки «Логист»: подтверждение
// логистом проходит автоматически, рейс сразу уходит диспетчеру.
// Из продаж — без опции: назначение обязан подтвердить логист.
export function assignDialog(order, data, showModal, closeModal, onReload, options = {}) {
  const candidates = matchVehicles(data, order.from_name, order.window_from);
  const workFleet = data.vehicles.filter(vehicle => vehicle.status === 'work');
  showModal(`<h2>Назначить ТС · ${escapeHtml(routeLabel(order))}</h2>
    <p class="muted">${escapeHtml(order.customer_name)} · окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)} · ${escapeHtml(order.body_type || 'Реф')} ${escapeHtml(order.temperature_mode || '')}</p>
    ${order.comment ? `<p class="muted">💬 ${escapeHtml(order.comment)}</p>` : ''}
    <div class="list" style="max-height:220px;overflow:auto;margin-bottom:10px">
      ${candidates.slice(0, 8).map(candidate => `<button type="button" class="list-item sugtruck" data-plate="${candidate.vehicle.id}">
        <strong class="mono">${escapeHtml(candidate.vehicle.plate)}</strong>
        <small class="muted">${escapeHtml(candidate.vehicle.type_name)}${candidate.readyAt
          ? ` · свободна с ${fmtDateTime(candidate.readyAt)}` : ''}</small>
        <span class="badge ${candidate.inZone ? 'ok' : 'warn'}" style="margin-left:auto">${candidate.inZone ? 'в зоне' : escapeHtml(candidate.zoneName || 'перегон')}</span>
      </button>`).join('') || '<p class="muted">Нет свободных к сроку — выберите вручную.</p>'}
    </div>
    <label class="field">Или вручную из парка<select id="assignVehicle">
      ${workFleet.map(vehicle => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.type_name)}</option>`).join('')}
    </select></label>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button type="button" class="button" id="assignOk">Назначить</button>
    </div>`);
  const select = document.getElementById('assignVehicle');
  if (candidates[0]) select.value = candidates[0].vehicle.id;
  document.querySelectorAll('.sugtruck').forEach(element =>
    element.addEventListener('click', () => { select.value = element.dataset.plate; }));
  document.getElementById('assignOk').onclick = async () => {
    try {
      await api(`/api/orders/${order.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ vehicleId: select.value, autoConfirm: Boolean(options.autoConfirm) })
      });
      closeModal();
      toast(options.autoConfirm
        ? 'ТС назначена и подтверждена — рейс у диспетчера'
        : 'ТС назначена — рейс проведён в план');
      await onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}
