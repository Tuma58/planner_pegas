// Рабочее место логиста — операции над планом, вынесенные из Ганта:
// назначение ТС на подтверждённые заявки, замена ТС на действующем маршруте,
// отклонение рейса с возвратом заявки в продажи, создание рейса вручную.
// Гант остаётся информационным пространством: там смотрят план,
// здесь — управляют им.
import { api, attachSearch, escapeHtml, formValues, formatDateTime, money, routeLabel, toast, dayPickerHtml, wireDayPicker, captureScrolls, restoreScrolls, renderInto } from './api.js';
import { demurrageChipHtml, wireDemurrageChip } from './demurrage.js';
import { inSalesPortfolio, orderStage, waitingLabel } from './pipeline.js';
import { DISP_KINDS } from './resource.js';
import { loadOpenQuestions, questionsForOwner, questionsStripHtml, wireQuestionsStrip } from './call-card.js';
import { assignDeadline, deadlineBadge as deadlineBadgeHtml } from './assign-deadline.js';
import { autoRequests, editOrderDialog, nextEventHint, nextVehicleEvent, plannedKmBetween, rejectOrderDialog, resolveAddress, salesTaskFor } from './sales.js';

const overlaps = (a, b) =>
  Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at);

// Занятость сцепки в период рейса: другие рейсы и интервалы недоступности.
function vehicleBusy(vehicleId, trip, data) {
  const otherTrip = data.trips.find(other => other.id !== trip.id && other.vehicle_id === vehicleId &&
    other.status !== 'rejected' && overlaps(other, trip));
  if (otherTrip) return `рейс ${otherTrip.from_point || otherTrip.from_name}→${otherTrip.to_point || otherTrip.to_name}`;
  const disposition = (data.dispositions || []).find(item => item.vehicle_id === vehicleId &&
    item.kind !== 'reserve' && overlaps(item, trip));
  if (disposition) return { repair: 'в ремонте', no_driver: 'без водителя', shift: 'пересменка', out: 'выведена' }[disposition.kind] || 'недоступна';
  return null;
}

// Замена ТС на действующем маршруте: свободные в период рейса — сверху,
// занятые показываются с причиной (заменить можно осознанно и на них).
// Используется логистом и диспетчером (внештатные ситуации).
export function replaceVehicleDialog(trip, data, context) {
  const loadMs = Date.parse(trip.starts_at);
  const candidates = data.vehicles
    .map(vehicle => ({ vehicle, busy: vehicle.id === trip.vehicle_id ? 'текущая' : vehicleBusy(vehicle.id, trip, data) }))
    .sort((a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy)) || a.vehicle.plate.localeCompare(b.vehicle.plate));
  context.showModal(`<h2>Замена ТС на маршруте</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · ${escapeHtml(trip.customer_name || 'без заказчика')}
      · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}
      · сейчас: <span class="mono">${escapeHtml(trip.vehicle_plate)}</span></p>
    <input id="replaceVehicleSearch" placeholder="🔍 поиск: номер, водитель, тип" autocomplete="off"
      style="width:100%;margin-bottom:8px">
    <div class="list" style="max-height:320px;overflow:auto;margin-bottom:10px">
      ${candidates.map(({ vehicle, busy }) => `<button type="button" class="list-item sugtruck"
        data-replace-vehicle="${vehicle.id}" ${vehicle.id === trip.vehicle_id ? 'disabled' : ''}>
        <span style="flex:1;min-width:0"><strong class="mono">${escapeHtml(vehicle.plate)}</strong>
        <small class="muted"> · ${escapeHtml(vehicle.type_name || '')} · ${escapeHtml(vehicle.driver_name || 'без водителя')}</small>
        ${busy ? '' : nextEventHint(nextVehicleEvent(data, vehicle.id, loadMs), loadMs)}</span>
        <span class="badge ${busy ? 'warn' : 'ok'}" style="margin-left:auto">${busy ? escapeHtml(busy) : 'свободна'}</span>
      </button>`).join('')}
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button></div>`);
  document.getElementById('replaceVehicleSearch').addEventListener('input', event => {
    const needle = event.currentTarget.value.trim().toLowerCase();
    document.querySelectorAll('[data-replace-vehicle]').forEach(button => {
      button.style.display = !needle || button.textContent.toLowerCase().includes(needle) ? '' : 'none';
    });
  });
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
    <p class="muted">Заявка вернётся в продажи как новая с указанной причиной${trip.order_id ? '' : ' (для рейса из 1С будет создана заявка-возврат)'}.</p>
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
      toast('Рейс отклонён — заявка вернулась в продажи');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Подходящие по времени рейсы для сцепки: окно погрузки ещё достижимо
// после освобождения (+2 ч подачи); в зоне освобождения — сверху, затем
// по близости окна к моменту готовности.
export function matchOrdersForVehicle(request, queue) {
  const readyMs = Math.max(Date.parse(request.freeAt), Date.now()) + 2 * 3_600_000;
  return queue
    .filter(order => Date.parse(order.window_to) >= readyMs)
    .map(order => ({
      order,
      inZone: order.from_name === request.zone.name,
      waitMs: Math.max(0, Date.parse(order.window_from) - readyMs)
    }))
    .sort((a, b) => Number(b.inZone) - Number(a.inZone) || a.waitMs - b.waitMs);
}

// Диалог «подобрать рейс сцепке»: заявки очереди, подходящие по времени.
// Пусто — предложение отправить запрос в продажи.
function pickOrderDialog(request, queue, data, context) {
  const matches = matchOrdersForVehicle(request, queue);
  // Подгон от места освобождения сцепки до погрузки каждой заявки.
  const originPoint = resolveAddress(data, request.zone.name) || null;
  const feedKmOf = order => {
    const target = order.from_address_id
      ? (data.reference.addresses || []).find(item => item.id === order.from_address_id)
      : resolveAddress(data, order.from_point || order.from_name);
    return originPoint && target ? plannedKmBetween(originPoint, target) : null;
  };
  const rows = matches.map(({ order, inZone }) => `
    <button type="button" class="list-item sugtruck" data-pick-order="${order.id}">
      <span style="flex:1;min-width:0"><strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        <small class="muted" style="display:block">окно ${formatDateTime(order.window_from)} → ${formatDateTime(order.window_to)}
          · ${escapeHtml(order.body_type || 'Реф')} · ${money(order.rate_vat)}${(() => {
            const feed = feedKmOf(order);
            return feed != null ? ` · подгон ~${feed} км` : ''; })()}</small></span>
      <span class="badge ${inZone ? 'ok' : 'warn'}" style="margin-left:auto">${inZone ? 'в зоне' : escapeHtml(order.from_name || 'перегон')}</span>
    </button>`).join('');
  context.showModal(`<h2>Рейс для ${escapeHtml(request.vehicle.plate)}</h2>
    <p class="muted">${escapeHtml(request.vehicle.type_name || '')} · освободится ${formatDateTime(request.freeAt)}
      в «${escapeHtml(request.zone.name)}»${request.idleMs > 0 ? ` · уже стоит ${Math.max(1, Math.floor(request.idleMs / 86_400_000))} дн` : ''}</p>
    ${rows ? `<div class="list" style="max-height:340px;overflow:auto;margin-bottom:10px">${rows}</div>`
      : `<p class="muted" style="margin:14px 0">Подходящих по времени заявок в очереди нет.
         Отправьте запрос в продажи — сцепку предложат клиентам под дату освобождения.</p>`}
    <div class="modal-actions">
      <button type="button" class="button ghost" id="pickAskSales">→ Запрос в продажи</button>
      <button type="button" class="button ghost" data-close>Закрыть</button>
    </div>`);
  document.querySelectorAll('[data-pick-order]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/orders/${button.dataset.pickOrder}/assign`, {
          method: 'POST',
          body: JSON.stringify({ vehicleId: request.vehicle.id, autoConfirm: true })
        });
        context.closeModal();
        toast(`${request.vehicle.plate} назначена — рейс у диспетчера`);
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
  document.getElementById('pickAskSales').onclick = async () => {
    try {
      await api(`/api/vehicles/${request.vehicle.id}/request-load`, { method: 'POST' });
      context.closeModal();
      toast('Запрос отправлен в продажи');
    } catch (error) { toast(error.message, 'error'); }
  };
}

// «Задание логисту» на дату: весь парк учтён — кто обеспечен рейсом,
// кто требует работы (с подбором заявок из очереди прямо из задания),
// кто недоступен; баланс «свободные сцепки ↔ доступная работа».
function logistTaskDialog(data, context, allRequests, queueAll) {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const fmtDay = iso => new Intl.DateTimeFormat('ru-RU',
    { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  const kindShort = { repair: 'ремонт', shift: 'пересменка', no_driver: 'без водителя', reserve: 'резерв' };
  const requestOf = item => allRequests.find(request => request.vehicle.id === item.vehicle.id)
    || { freeAt: item.at || item.since || new Date().toISOString(),
      zone: { name: item.vehicle.zone_name || '' }, vehicle: item.vehicle };
  const render = async dayIso => {
    const task = salesTaskFor(data, dayIso);
    const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
    const workCount = data.vehicles.filter(vehicle => vehicle.status === 'work').length;
    const allNeedWork = [...task.free, ...task.freeing];
    // Отметки «отработано» — общие для команды, привязаны к дате задания.
    let marks = [];
    try { marks = (await api(`/api/task-marks?kind=logist&day=${dayIso}`)).items; } catch { marks = []; }
    const marked = new Map(marks.map(item => [item.item_key, item]));
    const doneWork = allNeedWork.filter(item => marked.has(item.vehicle.id));
    const needWork = allNeedWork.filter(item => !marked.has(item.vehicle.id));
    const occupied = workCount - allNeedWork.length - task.unavailable.length;
    // Доступная работа: заявки очереди, чьё окно не закрылось к началу дня.
    const openQueue = queueAll.filter(order => Date.parse(order.window_to) > dayStart);
    const queueSum = openQueue.reduce((sum, order) => sum + Number(order.rate_vat || 0), 0);
    const uncovered = needWork.length - openQueue.length;
    const cards = needWork.map(item => {
      const request = requestOf(item);
      const matches = matchOrdersForVehicle(request, queueAll);
      const state = item.since != null || item.why == null
        ? `стоит${item.since ? ` с ${formatDateTime(item.since)}` : ''}`
        : `${formatDateTime(item.at)} ${item.why}`;
      return { item, request, matches, state };
    });
    // Сначала совсем без вариантов (тревога), затем давно стоящие.
    cards.sort((a, b) => Number(!!a.matches.length) - Number(!!b.matches.length)
      || String(a.item.since || a.item.at || '').localeCompare(String(b.item.since || b.item.at || '')));
    const lines = [`ЗАДАНИЕ ЛОГИСТУ на ${fmtDay(dayIso)}`, '',
      `Парк в работе: ${workCount} · обеспечены рейсами: ${occupied} · требуют работы: ${needWork.length} · недоступны: ${task.unavailable.length}`,
      `Очередь на назначение: ${openQueue.length} заявок · ${money(queueSum)}`,
      uncovered > 0
        ? `БАЛАНС: работы не хватает — ${uncovered} сцепок останутся без загрузки, запросите продажи`
        : `БАЛАНС: работы достаточно (заявок ${openQueue.length} на ${needWork.length} свободных)`, '',
      'ТРЕБУЮТ РАБОТЫ:'];
    cards.forEach(({ item, matches, state }) => {
      lines.push(`  ${item.vehicle.plate} (${item.vehicle.type_name || ''}) — ${item.place}` +
        `${item.region ? ` (${item.region})` : ''}, ${state}`);
      if (matches.length) {
        matches.slice(0, 2).forEach(({ order, inZone }) => lines.push(`    подходит: №${order.order_no || '—'} ` +
          `${order.from_point || order.from_name} → ${order.to_point || order.to_name}, ` +
          `окно ${formatDateTime(order.window_from)}, ${money(order.rate_vat)}${inZone ? ' (в зоне)' : ''}`));
      } else lines.push('    подходящих заявок в очереди нет — запросить продажи');
    });
    if (doneWork.length) {
      lines.push('', `Отработано (${doneWork.length}): ${doneWork.map(item => item.vehicle.plate).join(', ')}`);
    }
    if (task.unavailable.length) {
      lines.push('', 'НЕДОСТУПНЫ: ' + task.unavailable.map(item =>
        `${item.vehicle.plate} (${kindShort[item.kind] || item.kind} до ${formatDateTime(item.until)})`).join(', '));
    }
    const box = document.getElementById('logistTaskBody');
    box.dataset.text = lines.join('\n');
    box.innerHTML = `
      <div class="task-kpis five">
        <div class="task-kpi"><b>${workCount}</b><span>парк в работе</span></div>
        <div class="task-kpi"><b>${occupied}</b><span>обеспечены рейсами</span></div>
        <div class="task-kpi ${needWork.length ? 'warn' : ''}"><b>${needWork.length}</b><span>требуют работы</span></div>
        <div class="task-kpi muted"><b>${task.unavailable.length}</b><span>недоступны</span></div>
        <div class="task-kpi"><b>${openQueue.length}</b><span>очередь · ${money(queueSum)}</span></div>
      </div>
      <div class="task-balance-line ${uncovered > 0 ? 'bad' : 'ok'}">${uncovered > 0
        ? `⛔ Работы не хватает: <b>${uncovered}</b> сцепок останутся без загрузки — запросите продажи`
        : `✅ Работы достаточно: заявок ${openQueue.length} на ${needWork.length} свободных сцепок`}</div>
      <div class="task-sec"><b>Требуют работы (${needWork.length})</b>
        ${cards.map(({ item, matches, state }) => `<div class="task-lane ${matches.length ? '' : 'lack'}">
          <div class="task-lane-head">
            <b class="mono">${escapeHtml(item.vehicle.plate)}</b>
            <span>${escapeHtml(item.vehicle.type_name || '')}</span>
            <span class="muted">${escapeHtml(item.place)}${item.region ? ` (${escapeHtml(item.region)})` : ''} · ${escapeHtml(state)}</span>
            <span style="margin-left:auto;display:flex;gap:5px">
              <button class="button small" data-task-pick="${item.vehicle.id}">Подобрать</button>
              <button class="button ghost small" data-task-ask="${item.vehicle.id}"
                title="Запрос в продажи: сцепка без загрузки">→ Продажи</button>
              <button class="button ghost small task-done-btn" data-task-mark="${item.vehicle.id}"
                title="Отметить отработанной — уйдёт в «Отработанные», отметку видит вся команда">✓</button>
            </span>
          </div>
          ${matches.length ? matches.slice(0, 2).map(({ order, inZone }) => `<div class="task-row">
            📦 №${escapeHtml(order.order_no || '—')} ${escapeHtml(order.from_point || order.from_name)} →
            ${escapeHtml(order.to_point || order.to_name)} · окно ${formatDateTime(order.window_from)}
            · ${money(order.rate_vat)}${inZone ? ' <span class="tt-chip">в зоне</span>' : ''}</div>`).join('')
            : '<div class="task-row danger">подходящих заявок в очереди нет — запросите продажи</div>'}
        </div>`).join('') || '<p class="muted">все сцепки обеспечены работой</p>'}</div>
      ${doneWork.length ? `<details class="task-fold task-done-list">
        <summary>✓ Отработанные сцепки (${doneWork.length})</summary>
        ${doneWork.map(item => `<div class="task-row done">✓ <b class="mono">${escapeHtml(item.vehicle.plate)}</b>
          — ${escapeHtml(item.place)} <span class="muted">· ${escapeHtml(marked.get(item.vehicle.id)?.done_by || '')}</span>
          <button class="button ghost small" data-task-mark="${item.vehicle.id}" title="Вернуть в задание">↩</button>
        </div>`).join('')}
      </details>` : ''}
      <div class="task-sec"><b>Недоступны весь день (${task.unavailable.length})</b>
        <div class="task-chips">${task.unavailable.map(item => `<span class="tt-chip muted"
          title="до ${formatDateTime(item.until)}">${escapeHtml(item.vehicle.plate)} · ${escapeHtml(kindShort[item.kind] || item.kind)}</span>`).join(' ')
          || '<span class="muted">нет</span>'}</div></div>`;
    box.querySelectorAll('[data-task-mark]').forEach(button =>
      button.addEventListener('click', async () => {
        try {
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'logist', day: dayIso, key: button.dataset.taskMark }) });
          await render(dayIso);
        } catch (error) { toast(error.message, 'error'); }
      }));
    box.querySelectorAll('[data-task-pick]').forEach(button =>
      button.addEventListener('click', () => {
        const card = cards.find(entry => entry.item.vehicle.id === button.dataset.taskPick);
        if (!card) return;
        context.closeModal();
        pickOrderDialog(card.request, queueAll, data, context);
      }));
    box.querySelectorAll('[data-task-ask]').forEach(button =>
      button.addEventListener('click', async () => {
        try {
          await api(`/api/vehicles/${button.dataset.taskAsk}/request-load`, { method: 'POST' });
          toast('Запрос отправлен в продажи');
        } catch (error) { toast(error.message, 'error'); }
      }));
  };
  context.showModal(`<h2 style="margin-bottom:6px">📋 Задание логисту</h2>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      ${dayPickerHtml('logistTaskDay', tomorrow, 'на дату')}
      <button class="button small" id="logistTaskCopy" style="margin-left:auto">📋 Скопировать</button>
    </div>
    <div id="logistTaskBody" style="max-height:62vh;overflow:auto"></div>`);
  const modal = document.querySelector('#modalRoot .modal');
  if (modal) modal.style.width = 'min(820px, 96vw)';
  render(tomorrow);
  wireDayPicker(document, 'logistTaskDay', value => render(value));
  document.getElementById('logistTaskCopy').onclick = async () => {
    const text = document.getElementById('logistTaskBody').dataset.text || '';
    try { await navigator.clipboard.writeText(text); } catch {
      const area = document.createElement('textarea');
      area.value = text; document.body.append(area);
      area.select(); document.execCommand('copy'); area.remove();
    }
    toast('Задание скопировано');
  };
}

export async function renderLogist(container, context) {
  const { state, can } = context;
  const data = state.data;
  const query = (state.logistQuery || '').toLowerCase();
  const zone = state.logistZone || '';
  const region = state.logistRegion || '';
  // Период, как в продажах: заявка — окно пересекает диапазон, рейс — интервал
  // рейса пересекает диапазон, сцепка — освобождение попадает в диапазон.
  const dateFrom = state.logistFrom || '';
  const dateTo = state.logistTo || '';
  const rangeMatches = (fromIso, toIso) =>
    (!dateFrom || String(toIso).slice(0, 10) >= dateFrom) &&
    (!dateTo || String(fromIso).slice(0, 10) <= dateTo);
  const matches = text => !query || text.toLowerCase().includes(query);
  // Фильтр по геозонам: строка проходит, если зона участвует в маршруте.
  const zoneMatches = row => !zone || row.from_name === zone || row.to_name === zone;
  // Субъект РФ — по адресам заявки; у рейса — через связанную заявку.
  const addressById = id => id ? (data.reference.addresses || []).find(item => item.id === id) : null;
  const orderRegions = order => [addressById(order?.from_address_id)?.region,
    addressById(order?.to_address_id)?.region].filter(Boolean);
  const regionMatches = row => {
    if (!region) return true;
    const order = row.window_from !== undefined
      ? row : data.orders.find(item => item.trip_id === row.id || item.id === row.order_id);
    return orderRegions(order).includes(region);
  };
  const regionList = [...new Set((data.reference.addresses || [])
    .map(item => item.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));

  // Очередь на назначение: подтверждённые продажами заявки без ТС (стадия 1),
  // возвращённые из плана — с пометкой, залежавшиеся сверху.
  const queueAll = data.orders
    .filter(order => inSalesPortfolio(order, data) && orderStage(order, data).stage === 1)
    // Сверху — то, по чему время кончается раньше: сортируем по дедлайну
    // назначения, а не по окну погрузки. Дальняя погрузка с длинным подгоном
    // требует решения раньше, чем близкая с более ранним окном.
    .sort((a, b) => (assignDeadline(data, a)?.deadlineMs ?? Infinity) -
      (assignDeadline(data, b)?.deadlineMs ?? Infinity));
  const queue = queueAll
    .filter(order => zoneMatches(order) && regionMatches(order) &&
      rangeMatches(order.window_from, order.window_to) &&
      matches(`${order.customer_name} ${routeLabel(order)}`));

  // Действующие маршруты: план и в пути; завершённые логисту не нужны.
  // Рейсы на подтверждении логиста — всегда приоритетом наверху списка.
  const needsConfirm = trip => trip.status === 'plan' && !trip.logist_confirmed_at;
  const activeTrips = data.trips
    .filter(trip => ['plan', 'run'].includes(trip.status))
    .filter(trip => zoneMatches(trip) && regionMatches(trip) &&
      rangeMatches(trip.starts_at, trip.ends_at) &&
      matches(`${trip.customer_name} ${routeLabel(trip)} ${trip.vehicle_plate}`))
    .sort((a, b) => Number(needsConfirm(b)) - Number(needsConfirm(a)) ||
      a.starts_at.localeCompare(b.starts_at));

  const returnedOrders = queue.filter(order => order.returned_at);
  const returned = returnedOrders.length;
  const runTrips = activeTrips.filter(trip => trip.status === 'run');
  // «В пути» — число МАШИН (у сцепки может быть два рейса в пути: следующий
  // выведен на линию заранее); рейсы и сумма — подписью.
  const runVehicles = new Set(runTrips.map(trip => trip.vehicle_id)).size;
  const runCount = runVehicles;
  const planTrips = activeTrips.filter(trip => trip.status === 'plan');
  const unconfirmedTrips = planTrips.filter(trip => !trip.logist_confirmed_at);

  // Левый столбец: сцепки, которые простаивают или скоро освободятся, —
  // логист подбирает им рейсы из очереди или запрашивает загрузку у продаж.
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  const allVehicleRequests = autoRequests(data, state.month, monthEnd);
  const vehicleRequests = allVehicleRequests
    .filter(request => (!zone || request.zone.name === zone) &&
      (!region || request.region === region) &&
      rangeMatches(request.freeAt, request.freeAt) &&
      matches(`${request.vehicle.plate} ${request.vehicle.type_name} ${request.zone.name} ${request.region || ''}`))
    .sort((a, b) => a.freeAt.localeCompare(b.freeAt));
  // Состояние сцепки сейчас — как в ячейке Ганта: действующая диспозиция
  // («ремонт до…»), а простой без неё — «причины нет».
  const nowMs = Date.now();
  const stateNote = request => {
    const disposition = (data.dispositions || []).filter(item =>
      item.vehicle_id === request.vehicle.id &&
      Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs)
      .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
    if (disposition) {
      const meta = DISP_KINDS.find(item => item.kind === disposition.kind);
      return `<span style="color:${meta?.color || 'var(--muted)'}">${meta?.short || disposition.kind}
        до ${formatDateTime(disposition.ends_at)}</span>`;
    }
    if (request.idleMs > 0) return '<span style="color:var(--warn)">⚠ простой — причины нет</span>';
    if (request.overdueTrip) return '<span style="color:var(--warn)">🛣 ещё в рейсе — расчётное время вышло, уточните у диспетчера</span>';
    return 'в рейсе';
  };
  const vehicleCards = vehicleRequests.map((request, index) => {
    // Честная длительность: часы до суток, затем дни (раньше даже 2 часа
    // простоя показывались как «стоит 1 дн»).
    const idleDays = request.idleMs > 0 ? Math.floor(request.idleMs / 86_400_000) : 0;
    const idleLabel = request.idleMs <= 0 ? ''
      : idleDays >= 1 ? `стоит ${idleDays} дн`
      : `стоит ${Math.max(1, Math.floor(request.idleMs / 3_600_000))} ч`;
    const fits = matchOrdersForVehicle(request, queue).length;
    const blockedNote = request.blockedKind
      ? ` · ⚙ ${({ repair: 'из ремонта', no_driver: 'получит водителя', reserve: 'выйдет из резерва' })[request.blockedKind] || request.blockedKind}`
      : '';
    // Строка 3: ближайшее БУДУЩЕЕ событие сцепки (пересменка, ремонт,
    // запланированный рейс…) со временем — логист видит горизонт, а не
    // только текущее состояние.
    const nextEvent = nextVehicleEvent(data, request.vehicle.id, nowMs);
    const nextLabel = nextEvent
      ? `⏭ ${escapeHtml(String(nextEvent.label).replace('Запланирован рейс ', 'рейс ').slice(0, 52))} — <b>${formatDateTime(nextEvent.at)}</b>`
      : '⏭ планов нет — можно продавать';
    // Бронь «🔒»: машина предварительно занята под сделку (радар продаж).
    const hold = (data.vehicleHolds || []).find(item => item.vehicle_id === request.vehicle.id);
    return `<div class="list-item ordrow ${idleDays > 2 ? 'pipe-returned' : ''}">
      <span style="flex:1;min-width:0">
        <strong class="mono">${escapeHtml(request.vehicle.plate)}</strong>
        ${hold ? `<span class="badge warn" title="Забронирована: ${escapeHtml(hold.held_by_name)}${hold.note ? ` — ${escapeHtml(hold.note)}` : ''}">🔒 до ${formatDateTime(hold.until)}</span>` : ''}
        · ${escapeHtml(request.vehicle.type_name || '')} · ${escapeHtml(request.region || request.zone.name || 'субъект не определён')}
        <span style="display:block;margin:2px 0 1px">${request.idleMs > 0
          ? `<b style="color:var(--warn)">⌛ ${idleLabel}</b> · с <b>${formatDateTime(request.freeAt)}</b>`
          : request.overdueTrip ? '<b class="danger">⏳ выгрузка ожидается — расчётное время вышло</b>'
          : `⏱ освободится <b>${formatDateTime(request.freeAt)}</b>`}${blockedNote}</span>
        <small class="muted" style="display:block">📍 геозона ${escapeHtml(request.zone.name || '—')}
          · ${stateNote(request)} · ${nextLabel}</small>
        ${request.nextMissing ? '<small class="next-missing">⏭ следующий рейс не назначен — назначьте до освобождения</small>' : ''}
      </span>
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        <span class="badge ${fits ? 'ok' : 'warn'}" title="Заявок очереди, подходящих по времени">${fits
          ? `рейсов: ${fits}` : 'нет рейсов'}</span>
        <span style="display:flex;gap:5px">
          <button class="button small" data-pick="${index}" title="Заявки очереди, подходящие по времени освобождения">Подобрать рейс</button>
          <button class="button ghost small" data-ask-sales="${request.vehicle.id}"
            title="Уведомить продажи: сцепка свободна, нужна загрузка">→ Продажи</button>
          <button class="button ghost small" data-hold-toggle="${request.vehicle.id}"
            title="${hold ? `Снять бронь (${escapeHtml(hold.held_by_name)})` : 'Забронировать под свой план на 24 ч — продажи не продадут её под другую сделку'}">${hold ? '🔓 Снять' : '🔒 Бронь'}</button>
        </span>
      </span>
    </div>`;
  }).join('') || '<p class="muted">Простаивающих и освобождающихся сцепок нет — парк загружен.</p>';

  const orderWaitMs = order => order.stage_changed_at
    ? Date.now() - Date.parse(String(order.stage_changed_at).replace(' ', 'T') +
        (String(order.stage_changed_at).includes('Z') ? '' : 'Z'))
    : 0;
  // Дедлайн назначения считается по каждой заявке отдельно: окно погрузки
  // минус подгон ближайшей свободной машины минус подготовка выхода.
  // Прежний плоский норматив «6 часов до погрузки» врал: подгон бывает и
  // 8 часов, и заявка «в нормативе» уже была обречена опоздать.
  const deadlineOf = order => assignDeadline(state.data, order);
  const deadlineBadge = order => deadlineBadgeHtml(deadlineOf(order));
  const queueCard = order => {
    const waiting = orderWaitMs(order);
    return `<div class="list-item ordrow ${order.returned_at ? 'pipe-returned' : 'pipe-mine'}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        ${deadlineBadge(order)}
        <small class="muted" style="display:block">окно ${formatDateTime(order.window_from)} → ${formatDateTime(order.window_to)}
          · ${escapeHtml(order.body_type || 'Реф')} ${waiting > 3_600_000 ? ` · ждёт ${waitingLabel(waiting)}` : ''}</small>
        ${order.comment ? `<small class="muted" style="display:block">💬 ${escapeHtml(order.comment)}</small>` : ''}
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
  };
  // Архив очереди: окно погрузки уже закрылось — в заявленном виде заявку
  // не выполнить. Такие уходят в свёрнутый блок, чтобы не хоронить живую
  // очередь; «Изменить» (новое окно) возвращает заявку в работу,
  // «Отклонить» — в реестр с причиной.
  const nowIso = new Date().toISOString();
  const liveQueue = queue.filter(order => String(order.window_to) >= nowIso);
  const archiveQueue = queue.filter(order => String(order.window_to) < nowIso);
  const queueCards = liveQueue.map(queueCard).join('')
    || (archiveQueue.length ? '' : '<p class="muted">Очередь пуста — все подтверждённые заявки обеспечены ТС.</p>');
  const archiveBlock = archiveQueue.length ? `<details class="stale-preps" id="logistArchive"
      ${state.logistArchiveOpen ? 'open' : ''}>
    <summary>🗄 Архив · окно погрузки истекло <span class="scount">${archiveQueue.length}</span></summary>
    <p class="geohint">Окно закрылось — заявка в этом виде невыполнима. Согласуйте с продажами:
      «Изменить» с новым окном вернёт её в очередь, «Отклонить» с причиной отправит в реестр отчёта.</p>
    ${archiveQueue.map(queueCard).join('')}
  </details>` : '';

  const statusMeta = Object.fromEntries((data.settings.statuses || []).map(([id, label, color]) => [id, { label, color }]));
  // Новые назначения ждут подтверждения логиста — только после него рейс
  // уходит в блок «Диспетчер» на подготовку выхода.
  const needConfirm = unconfirmedTrips.length;

  const confirmedTrips = activeTrips.filter(trip =>
    !(trip.status === 'plan' && !trip.logist_confirmed_at));
  const tripCard = trip => {
    const meta = statusMeta[trip.status] || { label: trip.status, color: 'var(--muted)' };
    const unconfirmed = trip.status === 'plan' && !trip.logist_confirmed_at;
    return `<div class="list-item ordrow ${unconfirmed ? 'pipe-mine' : ''}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(routeLabel(trip))}</strong>
        · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
        <small class="muted" style="display:block">${escapeHtml(trip.customer_name || 'без заказчика')}
          · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}
          · ${Number(trip.distance_km).toLocaleString('ru-RU')} км${trip.empty_km
            ? ` <span class="muted">+ ${Math.round(trip.empty_km)} порож.</span>` : ''} · ${money(trip.revenue_vat)}</small>
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
  };
  const confirmCards = unconfirmedTrips.map(tripCard).join('');
  const tripCards = confirmedTrips.map(tripCard).join('')
    || '<p class="muted">Действующих маршрутов нет.</p>';
  const returnedCards = returnedOrders.map(order => queueCard(order)).join('')
    || '<p class="muted">Возвратов нет.</p>';
  const focusTripCards = (state.logistFocus === 'run'
    ? runTrips.map(tripCard).join('')
    : state.logistFocus === 'plan'
      ? confirmedTrips.filter(trip => trip.status === 'plan').map(tripCard).join('')
      : tripCards) || '<p class="muted">Пусто.</p>';

  // Плашки — переключатели правой колонки: клик оставляет только свою
  // секцию (повторный — сброс). В плашке: счётчик, деньги и возраст хвоста.
  const focus = state.logistFocus || null;
  const oldestWait = Math.max(0, ...queue.map(orderWaitMs));
  const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const queueSum = sum(queue, 'rate_vat');
  const confirmSum = sum(unconfirmedTrips, 'revenue_vat');
  const planSum = sum(confirmedTrips.filter(trip => trip.status === 'plan'), 'revenue_vat');
  const runSum = sum(runTrips, 'revenue_vat');

  // Вопросы водителей по зоне ответственности логиста (следующее задание) и
  // всё, что просрочено: вопрос не должен висеть ни у кого.
  const questions = questionsForOwner(await loadOpenQuestions(), 'Логист');
  const savedScrolls = captureScrolls(container);
  const html = `<div class="saleswrap">
    ${questionsStripHtml(questions, { title: '📞 Вопросы водителей — логисту' })}
    <div class="salekpis">
      <div class="skpi clickable ${focus === 'queue' ? 'open' : ''}" data-kpi="queue"
        title="Показать только очередь на назначение">
        <span class="skl">Ждут назначения ТС</span><span class="skv">${queue.length}</span>
        <small class="skm">${money(queueSum)}${oldestWait > 3_600_000 ? ` · ждёт ${waitingLabel(oldestWait)}` : ''}</small></div>
      <div class="skpi clickable ${focus === 'returned' ? 'open' : ''} ${returned ? 'skpi-warn' : ''}" data-kpi="returned"
        title="Показать только возвраты из плана — их причины требуют решения">
        <span class="skl">Возвраты из плана</span><span class="skv">${returned}</span>
        <small class="skm">${returned ? 'разобрать причины' : 'возвратов нет'}</small></div>
      <div class="skpi clickable ${focus === 'confirm' ? 'open' : ''} ${needConfirm ? 'skpi-hot' : ''}" data-kpi="confirm"
        title="Показать только рейсы на подтверждении — приоритет №1">
        <span class="skl">На подтверждении</span><span class="skv">${needConfirm}</span>
        <small class="skm">${needConfirm ? `${money(confirmSum)} · диспетчер ждёт` : 'всё подтверждено'}</small></div>
      <div class="skpi clickable ${focus === 'plan' ? 'open' : ''}" data-kpi="plan"
        title="Показать только рейсы в плане">
        <span class="skl">В плане</span><span class="skv">${confirmedTrips.filter(trip => trip.status === 'plan').length}</span>
        <small class="skm">${money(planSum)}</small></div>
      <div class="skpi clickable ${focus === 'run' ? 'open' : ''}" data-kpi="run"
        title="Машин в пути (у сцепки может быть два рейса: следующий выведен заранее) — показать только рейсы в пути">
        <span class="skl">В пути · машин</span><span class="skv">${runCount}</span>
        <small class="skm">рейсов ${runTrips.length} · ${money(runSum)}</small></div>
      ${demurrageChipHtml(data)}
      <div class="salesfilter" style="flex:1;min-width:260px">
        <select id="logistZone" title="Фильтр по геозоне маршрута">
          <option value="">Все геозоны</option>
          ${data.reference.zones.map(item =>
            `<option value="${escapeHtml(item.name)}" ${zone === item.name ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
        <select id="logistRegion" title="Субъект РФ — по адресам заявки маршрута">
          <option value="">Все субъекты</option>
          ${regionList.map(item =>
            `<option value="${escapeHtml(item)}" ${region === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
        </select>
        <input type="date" id="logistFilterFrom" value="${dateFrom}" title="Период: окно заявки / даты рейса / освобождение сцепки — с даты">
        <span class="muted">–</span>
        <input type="date" id="logistFilterTo" value="${dateTo}" title="Период — по дату">
        <button class="button ghost small" id="logistPresetToday" title="Только сегодняшний день">Сегодня</button>
        <button class="button ghost small" id="logistPresetWeek" title="Ближайшие 7 дней">7 дн</button>
        ${zone || region || dateFrom || dateTo || query ? '<button class="button ghost small" id="logistFilterReset" title="Сбросить все фильтры">✕ Сброс</button>' : ''}
        <input id="logistSearch" class="block-search" placeholder="Поиск: заказчик, маршрут, ТС" value="${escapeHtml(state.logistQuery || '')}" style="flex:1">
        <button class="button small" id="logistTask"
          title="Срез на дату: весь парк учтён — кто обеспечен рейсом, кто требует работы, баланс с очередью">📋 Задание</button>
        ${can('trips:write') ? '<button class="button small" id="logistNewTrip">+ Рейс</button>' : ''}
      </div>
    </div>
    <div class="salesboard">
      <div class="scol">
        <div class="scolh">Сцепки: простаивают и освобождаются <span>${vehicleRequests.length}</span></div>
        <div class="list">${vehicleCards}</div>
        <div class="geohint">«Подобрать рейс» — заявки очереди, подходящие по времени освобождения;
          «→ Продажи» — запрос загрузки, если подходящего рейса нет.</div>
      </div>
      <div class="scol">
        <div class="scolh">Назначение и подтверждение <span>${queue.length + needConfirm}</span>
          ${focus ? `<button class="button ghost small" id="logistFocusOff" style="margin-left:auto"
            title="Показать все секции">✕ показать всё</button>` : ''}</div>
        ${(!focus || focus === 'confirm') && (needConfirm || focus === 'confirm')
          ? `<div class="scolh" style="font-size:var(--fs-sm);margin-top:2px">Подтвердите назначение <span>${needConfirm}</span></div>
        <div class="list" style="margin-bottom:12px">${confirmCards || '<p class="muted">Подтверждений не ждут.</p>'}</div>` : ''}
        ${!focus || focus === 'queue' || focus === 'returned'
          ? `<div class="scolh" style="font-size:var(--fs-sm);margin-top:2px">${focus === 'returned'
              ? 'Возвраты из плана' : 'Очередь на назначение'} <span>${focus === 'returned' ? returned : queue.length}</span></div>
        <div class="list" style="margin-bottom:12px">${focus === 'returned' ? returnedCards : `${queueCards}${archiveBlock}`}</div>` : ''}
        ${!focus || focus === 'plan' || focus === 'run'
          ? `<div class="scolh" style="font-size:var(--fs-sm)">${focus === 'run'
              ? 'Рейсы в пути' : focus === 'plan' ? 'Рейсы в плане' : 'Действующие маршруты'}
            <span>${focus === 'run' ? runCount : focus === 'plan'
              ? confirmedTrips.filter(trip => trip.status === 'plan').length : confirmedTrips.length}</span></div>
        <div class="list">${focusTripCards}</div>` : ''}
        <div class="geohint">Назначение создаёт рейс и передаёт его диспетчеру; «Заменить ТС» —
          с проверкой занятости; отклонение возвращает заявку в продажи.</div>
      </div>
    </div>
  </div>`;

  // Разметка не изменилась — DOM не трогаем: без мигания, без прыжков
  // списков и прокрутки. Обработчики остались на прежних узлах.
  if (!renderInto(container, html)) {
    restoreScrolls(container, savedScrolls);
    return;
  }
  wireQuestionsStrip(container, context, questions);
  restoreScrolls(container, savedScrolls);

  attachSearch(container.querySelector('#logistSearch'), value => {
    state.logistQuery = value;
    renderLogist(container, context);
  });
  const dayIsoLocal = shift => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  container.querySelector('#logistFilterFrom').onchange = event => {
    state.logistFrom = event.currentTarget.value; rerender();
  };
  container.querySelector('#logistFilterTo').onchange = event => {
    state.logistTo = event.currentTarget.value; rerender();
  };
  container.querySelector('#logistPresetToday').onclick = () => {
    state.logistFrom = dayIsoLocal(0); state.logistTo = dayIsoLocal(0); rerender();
  };
  container.querySelector('#logistPresetWeek').onclick = () => {
    state.logistFrom = dayIsoLocal(0); state.logistTo = dayIsoLocal(7); rerender();
  };
  container.querySelector('#logistFilterReset')?.addEventListener('click', () => {
    state.logistZone = ''; state.logistRegion = ''; state.logistFrom = ''; state.logistTo = '';
    state.logistQuery = ''; rerender();
  });
  container.querySelector('#logistZone').onchange = event => {
    state.logistZone = event.currentTarget.value;
    renderLogist(container, context);
  };
  container.querySelector('#logistRegion').onchange = event => {
    state.logistRegion = event.currentTarget.value;
    renderLogist(container, context);
  };
  container.querySelector('#logistNewTrip')?.addEventListener('click', () => context.openNewTrip());

  const rerender = () => renderLogist(container, context);
  container.querySelectorAll('[data-kpi]').forEach(badge =>
    badge.addEventListener('click', () => {
      const key = badge.dataset.kpi;
      state.logistFocus = state.logistFocus === key ? null : key;
      rerender();
    }));
  container.querySelector('#logistFocusOff')?.addEventListener('click', event => {
    event.stopPropagation();
    state.logistFocus = null;
    rerender();
  });

  container.querySelector('#logistArchive')?.addEventListener('toggle', event => {
    state.logistArchiveOpen = event.currentTarget.open;
  });
  container.querySelectorAll('[data-assign]').forEach(button =>
    button.addEventListener('click', () => {
      const order = data.orders.find(item => item.id === button.dataset.assign);
      if (order) context.openAssign(order);
    }));
  container.querySelectorAll('[data-pick]').forEach(button =>
    button.addEventListener('click', () => {
      const request = vehicleRequests[Number(button.dataset.pick)];
      if (request) pickOrderDialog(request, queue, data, context);
    }));
  wireDemurrageChip(container, context);
  container.querySelector('#logistTask').onclick = () =>
    logistTaskDialog(data, context, allVehicleRequests, queueAll);
  container.querySelectorAll('[data-hold-toggle]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      const vehicleId = button.dataset.holdToggle;
      const held = (data.vehicleHolds || []).some(item => item.vehicle_id === vehicleId);
      try {
        if (held) {
          await api('/api/vehicle-holds', { method: 'POST', body: JSON.stringify({ vehicleId, remove: true }) });
          toast('Бронь снята');
        } else {
          const note = prompt('Бронь на 24 часа. Под что держите машину:', '') ?? null;
          if (note === null) return;
          await api('/api/vehicle-holds', { method: 'POST', body: JSON.stringify({ vehicleId, note, hours: 24 }) });
          toast('Забронирована на 24 ч — продажи видят бронь в радаре и форме');
        }
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
  container.querySelectorAll('[data-ask-sales]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/vehicles/${button.dataset.askSales}/request-load`, { method: 'POST' });
        toast('Запрос отправлен в продажи');
      } catch (error) { toast(error.message, 'error'); }
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
