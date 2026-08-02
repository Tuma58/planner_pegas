// Доска отдела продаж — перенос renderSalesBoard из прототипа ТК 21:
// слева «Потребность от логистики» (освобождающиеся сцепки с предложением обратного груза),
// справа форма бронирования с оценкой осуществимости и портфель заявок со стадиями.
// Назначение ТС — через POST /api/orders/:id/assign (право trips:write).
import { api, escapeHtml, formatDateTime, formValues, money, toLocalInput, toast } from './api.js';

export const STAGES = ['Заявка принята', 'Подтверждена', 'Назначена ТС', 'В пути', 'Выгружена', 'Документы'];

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
export function autoRequests(data, monthStartDate, monthEndDate) {
  const requests = [];
  const zoneByName = Object.fromEntries(data.reference.zones.map(zone => [zone.name, zone]));
  data.vehicles.filter(vehicle => vehicle.status === 'work').forEach(vehicle => {
    const trips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
      .sort((a, b) => a.ends_at.localeCompare(b.ends_at));
    if (!trips.length) return;
    const last = trips[trips.length - 1];
    const endsAt = new Date(last.ends_at);
    if (endsAt >= monthEndDate || endsAt < monthStartDate) return;
    const zone = zoneByName[last.to_name];
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
      freeAt: last.ends_at,
      // Погрузка возможна не раньше подачи (норматив после выгрузки), окно — до конца вторых суток.
      loadFrom: new Date(endsAt.getTime() + DISPATCH_LAG_MS).toISOString(),
      windowTo: new Date(Math.min(
        atHour(new Date(endsAt.getTime() + 2 * 86_400_000), WORK_END_HOUR).getTime(),
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

export function orderStage(order, data) {
  if (order.trip_id) {
    const trip = data.trips.find(item => item.id === order.trip_id);
    if (trip) {
      if (trip.status === 'rejected') return { stage: 1, hot: true, plate: trip.vehicle_plate };
      const map = { plan: 2, run: 3, unloaded: 4, done: 5, paid: 5 };
      return { stage: map[trip.status] || 2, plate: trip.vehicle_plate };
    }
  }
  return { stage: Number(order.stage) || 0 };
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
  return data.vehicles
    .filter(vehicle => vehicle.status === 'work' && !busy.has(vehicle.id))
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
  const filter = state.salesFilter || (state.salesFilter = { zone: '', from: '', to: '' });
  const inDateRange = iso => {
    const day = String(iso).slice(0, 10);
    return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
  };
  const allRequests = autoRequests(data, state.month, monthEnd);
  const requests = allRequests.filter(request =>
    (!filter.zone || request.zone.name === filter.zone) && inDateRange(request.freeAt));
  const allOrders = data.orders;
  // Заявка проходит фильтр, если зона участвует в маршруте, а окно погрузки пересекает диапазон.
  const orders = allOrders.filter(order =>
    (!filter.zone || order.from_name === filter.zone || order.to_name === filter.zone) &&
    (!filter.from || String(order.window_to).slice(0, 10) >= filter.from) &&
    (!filter.to || String(order.window_from).slice(0, 10) <= filter.to));
  const assigned = orders.filter(order => order.trip_id).length;
  const filterActive = filter.zone || filter.from || filter.to;
  const zoneOptions = data.reference.zones.map(zone => `<option value="${zone.id}">${escapeHtml(zone.name)}</option>`).join('');
  const orderOptions = data.settings.orderOptions || {};
  const temps = (orderOptions.temperatureModes || []).map(item => `<option>${escapeHtml(item)}</option>`).join('');
  const bodies = (orderOptions.bodyTypes || []).map(item => `<option>${escapeHtml(item)}</option>`).join('');

  const requestList = requests.length ? requests.map((request, index) =>
    `<div class="list-item req" data-req="${index}">
      <span style="flex:1;min-width:0">
        <strong class="mono">${escapeHtml(request.vehicle.plate)}</strong> · ${escapeHtml(request.vehicle.type_name)}
        <small class="muted" style="display:block">освободится в «${escapeHtml(request.zone.name)}» ${fmtDateTime(request.freeAt)} · подача с ${fmtDateTime(request.loadFrom)}</small>
        ${request.suggestTo ? `<small class="muted" style="display:block">→ ${escapeHtml(request.zone.name)}→${escapeHtml(request.suggestTo)}${request.suggestCustomer ? `, ${escapeHtml(request.suggestCustomer)}` : ''} · ${money(request.suggestRate)}</small>` : ''}
      </span>
      <span class="reqzone" style="background:${request.zone.color}">${escapeHtml(request.zone.name)}</span>
    </div>`).join('')
    : '<p class="muted">Нет потребности — весь парк загружен.</p>';

  const stepper = stage => `<div class="stepper">${STAGES.map((_, index) =>
    `<span class="stp ${index <= stage ? 'on' : ''}"></span>`).join('')}<span class="stpl">${STAGES[stage] || STAGES[0]}</span></div>`;

  const portfolio = orders.map(order => {
    const st = orderStage(order, data);
    return `<div class="list-item ordrow" data-order="${order.id}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(order.from_name)}→${escapeHtml(order.to_name)}
        ${st.plate ? ` · <span class="mono">${escapeHtml(st.plate)}</span>` : ''}
        <small class="muted" style="display:block">${escapeHtml(order.body_type || 'Рефрижератор')} · ${escapeHtml(order.temperature_mode || '—')} · окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)}</small>
        ${stepper(st.stage)}
      </span>
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        <b>${money(order.rate_vat)}</b>
        ${can('trips:write') ? `<button class="button ghost small ${st.hot ? 'danger' : ''}" data-assign="${order.id}">
          ${st.hot ? '⚠ Переназначить ТС' : (order.trip_id ? 'Сменить ТС' : 'Назначить ТС')}</button>` : ''}
      </span>
    </div>`;
  }).join('') || '<p class="muted">Потребностей клиента пока нет — заполните форму слева.</p>';

  container.innerHTML = `<div class="saleswrap">
    <div class="salekpis">
      <div class="skpi"><span class="skl">Потребность от логистики</span><span class="skv">${requests.length}${filterActive ? `<small class="muted"> / ${allRequests.length}</small>` : ''}</span></div>
      <div class="skpi"><span class="skl">Потребность клиента</span><span class="skv">${orders.length}${filterActive ? `<small class="muted"> / ${allOrders.length}</small>` : ''}</span></div>
      <div class="skpi"><span class="skl">Назначено ТС</span><span class="skv">${assigned}</span></div>
      <div class="skpi"><span class="skl">Осталось назначить</span><span class="skv">${Math.max(0, orders.length - assigned)}</span></div>
      <div class="salesfilter">
        <span class="skl">Фильтр</span>
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
          <label class="field">Заказчик<input name="customerName" placeholder="наименование" required></label>
          <div class="form-grid">
            <label class="field">Откуда<select name="fromZoneId" id="salesFrom">${zoneOptions}</select></label>
            <label class="field">Куда<select name="toZoneId" id="salesTo">${zoneOptions}</select></label>
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
          <div id="salesFeas" class="feas"></div>
          <button class="button full">Забронировать</button>
        </form>
        <div class="scolh" style="margin-top:14px">Портфель · потребности клиента <span>${orders.length}</span></div>
        <div class="list">${portfolio}</div>
      </div>
    </div>
  </div>`;

  const rerender = () => renderSales(container, context);
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
    state.salesFilter = { zone: '', from: '', to: '' };
    rerender();
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

  container.querySelectorAll('[data-req]').forEach(element =>
    element.addEventListener('click', () => {
      const request = requests[Number(element.dataset.req)];
      if (!request) return;
      container.querySelector('#salesFrom').value = request.zone.id;
      if (request.suggestToId) container.querySelector('#salesTo').value = request.suggestToId;
      container.querySelector('[name="customerName"]').value = request.suggestCustomer || '';
      container.querySelector('#salesRate').value = request.suggestRate || '';
      container.querySelector('#salesWinFrom').value = inputValue(request.loadFrom);
      container.querySelector('#salesWinTo').value = inputValue(request.windowTo);
      feasibility();
      toast('Бронирование обратного груза заполнено');
    }));

  container.querySelector('#salesForm').onsubmit = async event => {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    if (!values.rateVat) {
      values.rateVat = routeInfo(data, values.fromZoneId, values.toZoneId).rate;
    }
    try {
      await api('/api/orders', { method: 'POST', body: JSON.stringify(values) });
      toast('Забронировано — заявка в портфеле');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };

  container.querySelectorAll('[data-assign]').forEach(button =>
    button.addEventListener('click', event => {
      event.stopPropagation();
      const order = orders.find(item => item.id === button.dataset.assign);
      if (order) context.openAssign(order);
    }));
}

// Модалка назначения ТС (маркетплейс-стиль из ТК 21).
export function assignDialog(order, data, showModal, closeModal, onReload) {
  const candidates = matchVehicles(data, order.from_name, order.window_from);
  const workFleet = data.vehicles.filter(vehicle => vehicle.status === 'work');
  showModal(`<h2>Назначить ТС · ${escapeHtml(order.from_name)}→${escapeHtml(order.to_name)}</h2>
    <p class="muted">${escapeHtml(order.customer_name)} · окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)} · ${escapeHtml(order.body_type || 'Реф')} ${escapeHtml(order.temperature_mode || '')}</p>
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
        method: 'POST', body: JSON.stringify({ vehicleId: select.value })
      });
      closeModal();
      toast('ТС назначена — рейс проведён в план');
      await onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}
