// Блок «Диспетчер» — построен заново вместо «Контроля».
// Конвейер после назначения ТС: заявка уходит на подтверждение логисту,
// затем диспетчер ведёт чек-лист выхода: 1) заказ внесён в учётную систему
// (1С временно работает отдельно от продукта), 2) задание водителю отправлено,
// 3) рейс переведён на контроль на линии (статус «В пути»).
// Внештатные ситуации: отказ клиента, поломка ТС (ремонт + переназначение),
// переназначение ТС — с возвратом заявки в продажи при снятии рейса.
import { api, attachSearch, escapeHtml, formValues, formatDateTime, money, parseMoney, routeLabel, toLocalInput, toast, captureScrolls, restoreScrolls, wireSelectSearch } from './api.js';
import { demurrageChipHtml, wireDemurrageChip } from './demurrage.js';
import { orderFilesOf, orderNet, resolveAddress } from './sales.js';
import { waitingLabel } from './pipeline.js';
import { replaceVehicleDialog, rejectTripDialog } from './logist.js';
import { openTransfers, transferStage, transferTaskText, transferDialog } from './transfer.js';
import { callCardDialog, closeQuestionDialog, questionDialog, setTopics, topicLabel } from './call-card.js';

const LATE_MS = 30 * 60_000;
// «ТС не выгружают»: плановое прибытие прошло более 6 часов назад,
// выгрузка не отмечена — особый контроль с выставлением простоя.
const UNLOAD_STUCK_MS = 6 * 3_600_000;

// Выставление простоя клиенту: часы сверх норматива × ставка из настроек.
function demurrageDialog(trip, data, context, stuckMs) {
  const rate = Number(data.settings.calculation.demurragePerHourVat || 1000);
  const prefillHours = Math.max(1, Math.floor(stuckMs / 3_600_000));
  context.showModal(`<form id="demurrageForm">
    <h2>Выставить простой клиенту</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      · ${escapeHtml(trip.customer_name || 'без заказчика')}
      · прибыл ${formatDateTime(trip.arrived_at || trip.ends_at)}</p>
    <div class="form-grid">
      <label class="field">Часы простоя<input name="hours" type="number" min="1" step="1" value="${prefillHours}" required></label>
      <label class="field">Ставка, ₽/ч с НДС<input name="ratePerHour" type="number" min="0" value="${rate}" required></label>
    </div>
    <p class="muted">Сумма добавится к выручке рейса, продажи получат уведомление —
      включить простой в счёт клиенту.</p>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button danger">Выставить</button>
    </div></form>`);
  document.getElementById('demurrageForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const { amount } = await api(`/api/trips/${trip.id}/demurrage`, {
        method: 'POST', body: JSON.stringify(values)
      });
      context.closeModal();
      toast(`Простой выставлен: ${amount.toLocaleString('ru-RU')} ₽ — продажи уведомлены`);
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Чек-лист диспетчера; подтверждение логиста — нулевое звено, выполняется
// в блоке «Логист» и здесь показывается только как состояние.
const CHECKLIST = [
  { step: 'entered_1c', column: 'entered_1c_at', label: 'Заказ внесён в учётную систему',
    hint: '1С ведётся отдельно — внесите заказ и отметьте здесь', action: 'Отметить' },
  { step: 'driver_notified', column: 'driver_notified_at', label: 'Задание водителю отправлено',
    hint: 'Маршрут, окна и груз переданы водителю', action: 'Отметить' },
  { step: 'on_line', column: 'on_line_at', label: 'Контроль на линии',
    hint: 'Рейс перейдёт в статус «В пути», заявка — на стадию 3', action: 'Вывести на линию' }
];

async function runStep(tripId, step, onReload) {
  try {
    const result = await api(`/api/trips/${tripId}/step`, {
      method: 'POST', body: JSON.stringify({ step })
    });
    toast(step === 'on_line' ? 'Рейс на линии — статус «В пути»'
      : step === 'defer_1c' ? '1С отложена — следующие шаги открыты, долг с напоминанием каждые 3 часа'
      : step === '1c_updated' ? 'Долг закрыт — данные в 1С обновлены'
      : 'Шаг отмечен');
    await onReload();
    return result;
  } catch (error) { toast(error.message, 'error'); }
}

// Поломка ТС: сломанную сцепку можно сразу поставить в ремонт, а рейс —
// либо пересадить на другую сцепку, либо снять (заявка вернётся в продажи).
function breakdownDialog(trip, data, context) {
  context.showModal(`<h2>Поломка ТС</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      · ${escapeHtml(trip.driver_name || 'без водителя')}</p>
    <label class="field" style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="breakRepair" checked style="width:auto;min-height:auto">
      Поставить ${escapeHtml(trip.vehicle_plate)} в ремонт на сутки
    </label>
    <p class="muted">Дальше: пересадить рейс на другую сцепку или снять его —
      заявка вернётся в продажи с причиной «Поломка на маршруте».</p>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button type="button" class="button danger" id="breakReject">Снять рейс</button>
      <button type="button" class="button" id="breakReassign">Переназначить ТС</button>
    </div>`);
  const repairIfChecked = async () => {
    if (!document.getElementById('breakRepair')?.checked) return;
    await api('/api/dispositions', {
      method: 'POST',
      body: JSON.stringify({
        vehicleId: trip.vehicle_id, kind: 'repair',
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        note: `Поломка на рейсе ${routeLabel(trip)}`
      })
    }).catch(() => toast('Не удалось поставить ремонт (нет права «Ресурс»)', 'error'));
  };
  document.getElementById('breakReassign').onclick = async () => {
    await repairIfChecked();
    replaceVehicleDialog(trip, data, context);
  };
  document.getElementById('breakReject').onclick = async () => {
    await repairIfChecked();
    try {
      await api(`/api/trips/${trip.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'rejected', rejectionReason: 'Поломка на маршруте' })
      });
      context.closeModal();
      toast('Рейс снят — заявка вернулась в продажи (Поломка на маршруте)');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Отказ клиента: рейс снимается, заявка возвращается в продажи с причиной.
function customerRefusalDialog(trip, context) {
  context.showModal(`<h2>Отказ клиента</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      · ${escapeHtml(trip.customer_name || 'без заказчика')}</p>
    <p>Рейс будет снят, ТС освободится, заявка вернётся в продажи
      с причиной «Отказ клиента»${trip.order_id ? '' : ' (для рейса из 1С будет создана заявка-возврат)'}.</p>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button type="button" class="button danger" id="refuseOk">Снять рейс</button>
    </div>`);
  document.getElementById('refuseOk').onclick = async () => {
    try {
      await api(`/api/trips/${trip.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'rejected', rejectionReason: 'Отказ клиента' })
      });
      context.closeModal();
      toast('Рейс снят — заявка вернулась в продажи (Отказ клиента)');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Груз не принят получателем: машина гружёная, поэтому это не перегон —
// к текущему рейсу добавляется точка возврата, и рейс идёт дальше по своим
// этапам до выгрузки возврата. Так машина не считается свободной раньше
// времени, а причина остаётся в истории рейса.
function returnCargoDialog(trip, data, context) {
  const addresses = (data.reference.addresses || [])
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  const now = new Date();
  const local = new Date(now.getTime() + 12 * 3_600_000 - now.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
  context.showModal(`<form id="returnCargoForm">
    <h2>📦 Груз не принят получателем</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      · ${escapeHtml(trip.customer_name || '')}</p>
    <label class="field">Куда везём возврат
      <input id="returnSearch" placeholder="🔍 поиск пункта" autocomplete="off">
      <select name="point" id="returnPoint" required size="6">
        ${addresses.map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.region
    ? ` · ${escapeHtml(item.region)}` : ''}</option>`).join('')}
      </select></label>
    <label class="field">Плановое прибытие<input type="datetime-local" name="plannedArrival" value="${local}"></label>
    <label class="field">Причина отказа получателя
      <input name="note" maxlength="200" required placeholder="например: брак упаковки, недостача, отказ по качеству"></label>
    <p class="muted">К рейсу добавится точка возврата: этапы пойдут дальше
      («в пути на выгрузку» → «выгрузка» → «освободился»), машина останется гружёной
      и под контролем. Простой у получателя и претензия клиенту оформляются
      как обычно — через «⏳ Простои П/В».</p>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button danger">Добавить точку возврата</button>
    </div></form>`);
  wireSelectSearch(document.getElementById('returnSearch'), document.getElementById('returnPoint'));
  document.getElementById('returnCargoForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(`/api/trips/${trip.id}/stops`, { method: 'POST', body: JSON.stringify({
        kind: 'D', point: values.point,
        plannedArrival: values.plannedArrival ? new Date(values.plannedArrival).toISOString() : null,
        note: `ВОЗВРАТ: ${values.note}`
      }) });
      context.closeModal();
      toast('Точка возврата добавлена — рейс продолжается до неё');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Меню внештатной ситуации: каждый сценарий продуман до конца —
// переназначение, ремонт, возврат заявки в продажи.
function incidentDialog(trip, data, context) {
  context.showModal(`<h2>Внештатная ситуация</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      · ${escapeHtml(trip.driver_name || 'без водителя')} · ${escapeHtml(trip.customer_name || '')}</p>
    <div class="list">
      <button type="button" class="list-item" id="incBreakdown">
        <span><strong>🔧 Поломка ТС</strong>
        <small class="muted" style="display:block">Ремонт сломанной сцепки, пересадка рейса или снятие</small></span></button>
      <button type="button" class="list-item" id="incRefusal">
        <span><strong>🚫 Отказ клиента</strong>
        <small class="muted" style="display:block">Рейс снимается, заявка возвращается в продажи</small></span></button>
      <button type="button" class="list-item" id="incReassign">
        <span><strong>🔁 Переназначить ТС</strong>
        <small class="muted" style="display:block">Другая сцепка; задание водителю отправляется заново</small></span></button>
      <button type="button" class="list-item" id="incReturn">
        <span><strong>📦 Груз не принят получателем</strong>
        <small class="muted" style="display:block">Везём возврат в другую точку — рейс продолжается</small></span></button>
      <button type="button" class="list-item" id="incTransfer">
        <span><strong>🚚 Перегон порожним</strong>
        <small class="muted" style="display:block">Машина едет пустой: под погрузку, на базу, в ремонт, на пересменку</small></span></button>
      <button type="button" class="list-item" id="incOther">
        <span><strong>✕ Снять рейс по другой причине</strong>
        <small class="muted" style="display:block">ДТП, погода, опоздание и прочее — с обязательной причиной</small></span></button>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button></div>`);
  document.getElementById('incBreakdown').onclick = () => breakdownDialog(trip, data, context);
  document.getElementById('incRefusal').onclick = () => customerRefusalDialog(trip, context);
  document.getElementById('incReassign').onclick = () => replaceVehicleDialog(trip, data, context);
  document.getElementById('incReturn').onclick = () => returnCargoDialog(trip, data, context);
  document.getElementById('incTransfer').onclick = () => {
    const vehicle = (data.vehicles || []).find(item => item.id === trip.vehicle_id);
    if (vehicle) transferDialog(vehicle, data, context, { fromLabel: trip.to_point || trip.to_name });
  };
  document.getElementById('incOther').onclick = () => rejectTripDialog(trip, data, context);
}

function checklistBlock(trip, canAct) {
  const rows = CHECKLIST.map((item, index) => {
    const done = trip[item.column];
    // Отложенная 1С (живой заявки ещё нет) открывает следующие шаги:
    // водителя отправляем, долг «внести в 1С» остаётся висеть.
    const deferredHere = item.step === 'entered_1c' && !done && trip.deferred_1c_at;
    const previous = index === 0 ? null : CHECKLIST[index - 1];
    const previousDone = !previous || trip[previous.column] ||
      (previous.step === 'entered_1c' && trip.deferred_1c_at);
    return `<div class="list-item" style="padding:6px 10px">
      <span style="flex:1;min-width:0">
        <strong style="${done ? 'color:var(--ok)' : deferredHere ? 'color:var(--warn)' : ''}">${done ? '✓' : deferredHere ? '⏳' : `${index + 1}.`} ${item.label}</strong>
        <small class="muted" style="display:block">${done ? `выполнено ${formatDateTime(done)}`
          : deferredHere ? `⚠ отложено ${formatDateTime(trip.deferred_1c_at)} — заявка появится, внесите и отметьте`
          : item.hint}</small>
      </span>
      ${!done && canAct && previousDone
        ? `<span style="display:flex;gap:5px">
            <button class="button small" data-step="${item.step}" data-trip="${trip.id}">${item.action}</button>
            ${item.step === 'entered_1c' && !trip.deferred_1c_at
    ? `<button class="button ghost small" data-step="defer_1c" data-trip="${trip.id}"
                title="Живой заявки от клиента ещё нет, а водителя отправлять пора: следующие шаги откроются, долг «внести в 1С» останется с напоминанием каждые 3 часа">⏭ Внесу позже</button>` : ''}
          </span>` : ''}
    </div>`;
  }).join('');
  return `<div class="list" style="margin-top:6px">${rows}</div>`;
}

export async function renderDispatcher(container, context, options = {}) {
  const { state, can } = context;
  const data = state.data;
  const canAct = can('trip-status:write');
  // Массовые операции (закрытие разборника задним числом) — только админ.
  const isAdmin = (state.data.user.roles || [state.data.user.role]).includes('admin');
  // Статус отслеживания «опоздание»: расчётная задержка по стоянкам контроля
  // (план + накопленное отставание; для идущих — не раньше «сейчас»).
  let delayByTrip = new Map();
  let controlByTrip = new Map();
  const todayIso = new Date().toISOString().slice(0, 10);
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let workedMap = new Map();
  // Фильтрация по уже загруженным данным (options.reuseNetwork — путь поиска)
  // не ходит в сеть: три запроса на каждый ввод делали набор текста рваным.
  if (options.reuseNetwork && state.dispatcherNetCache) {
    ({ delayByTrip, controlByTrip, workedMap } = state.dispatcherNetCache);
  } else {
    try {
      const { items } = await api('/api/control');
      delayByTrip = new Map(items.map(item => [item.id, item.delay_ms || 0]));
      controlByTrip = new Map(items.map(item => [item.id, item]));
    } catch { /* без расчёта задержек карточки просто не показывают опоздание */ }
    // Отметки «событие отработано»: общие для смены, ключ привязан к конкретному
    // событию рейса — сменилось событие, отметка сама теряет силу.
    try {
      const days = await Promise.all([
        api(`/api/task-marks?kind=dispatcher&day=${todayIso}`),
        api(`/api/task-marks?kind=dispatcher&day=${yesterdayIso}`)
      ]);
      // Ключи событий стабильны — одна и та же отметка может быть и вчера, и
      // сегодня: в карте остаётся самая свежая (иначе вчерашняя перекрывала
      // сегодняшнюю и карточка «не отрабатывалась»).
      workedMap = new Map();
      for (const item of days.flatMap(result => result.items)) {
        const prev = workedMap.get(item.item_key);
        if (!prev || String(item.done_at) > String(prev.done_at)) workedMap.set(item.item_key, item);
      }
    } catch { workedMap = new Map(); }
    state.dispatcherNetCache = { delayByTrip, controlByTrip, workedMap };
  }
  // Вопросы водителей: живут отдельно от рейсов — водитель звонит и когда
  // рейса ещё нет. Норматив ответа 10 минут, поэтому список всегда на виду.
  let questions = [];
  if (options.reuseNetwork && state.dispatcherQuestions) {
    questions = state.dispatcherQuestions;
  } else {
    try {
      const payload = await api('/api/driver-questions?open=1');
      // Справочник тем берём отсюда же: иначе карточка успевает отрисоваться
      // раньше загрузки списка и показывает код темы вместо названия.
      setTopics(payload.topics);
      questions = payload.items.filter(item => !item.closed_at);
    } catch { questions = []; }
    state.dispatcherQuestions = questions;
  }
  const query = (state.dispatcherQuery || '').toLowerCase();
  const matches = trip => !query ||
    `${routeLabel(trip)} ${trip.vehicle_plate} ${trip.driver_name || ''} ${trip.customer_name || ''}`
      .toLowerCase().includes(query);

  const planned = data.trips.filter(trip => trip.status === 'plan' && matches(trip))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const waitingLogist = planned.filter(trip => !trip.logist_confirmed_at);
  const preparing = planned.filter(trip => trip.logist_confirmed_at);
  const nowMs = Date.now();
  // Выгрузка и простой отсчитываются только от ФАКТА прибытия (arrived_at):
  // рейс без него — «в пути», даже если план прибытия прошёл (это опоздание).
  const stuckMsOf = trip => trip.arrived_at ? nowMs - Date.parse(trip.arrived_at) : 0;
  const isStuck = trip => trip.status === 'run' && stuckMsOf(trip) > UNLOAD_STUCK_MS;
  // Особый контроль (не выгружают) — наверху списка линии.
  // Контроль заканчивается фактом выгрузки: этап «документы получены»
  // отменён 27.08.2026 — он держал карточку на линии ради отметки о фото
  // и затягивал закрытие рейса.
  const online = data.trips.filter(trip => trip.status === 'run' && matches(trip));
  const tsRaw = value => value ? Date.parse(String(value).replace(' ', 'T') +
    (String(value).includes('Z') || String(value).includes('+') ? '' : 'Z')) : NaN;

  // Приоритет контроля: наверху рейсы, чьё следующее событие ближе всего
  // к текущему моменту (просроченные — самые первые). Время грузовых
  // операций в регионах показывается по местному поясу субъекта.
  const TZ_BY_REGION = {
    'Самарская обл': 4, 'Ульяновская обл': 4, 'Удмуртия респ': 4, 'Астраханская обл': 4,
    'Саратовская обл': 4, 'Оренбургская обл': 5, 'Башкортостан респ': 5, 'Пермский край': 5,
    'Свердловская обл': 5, 'Челябинская обл': 5, 'Тюменская обл': 5, 'ХМАО-Югра': 5,
    'Курганская обл': 5, 'Омская обл': 6, 'Новосибирская обл': 7, 'Кемеровская обл': 7,
    'Томская обл': 7, 'Красноярский край': 7
  };
  const TZ_BY_ZONE = { 'Самара': 4, 'Урал': 5, 'Восток': 6 };
  const offsetOfPoint = (point, zoneName) => {
    const region = resolveAddress(data, point)?.region;
    return TZ_BY_REGION[region] ?? TZ_BY_ZONE[zoneName] ?? 3;
  };
  const localNote = (atMs, point, zoneName) => {
    const offset = offsetOfPoint(point, zoneName);
    if (offset === 3) return '';
    const local = new Date(atMs + (offset - 3) * 3_600_000);
    return ` · местное ${formatDateTime(local.toISOString())} (МСК+${offset - 3})`;
  };
  const normOpMs = Number(data.settings.calculation.handlingHoursPerOperation || 2) * 3_600_000;
  const nextControlEvent = trip => {
    if (isStuck(trip)) {
      return { at: 0, label: '🚨 не выгружают — вмешаться',
        point: trip.to_point || trip.to_name, zone: trip.to_name };
    }
    const stops = controlByTrip.get(trip.id)?.stops || [];
    for (const stop of stops) {
      if (stop.actual_departure) continue;
      const point = stop.point || trip.to_name;
      // Пять этапов рейса вместо восьми отметок (27.08.2026): в пути на
      // погрузку → погрузка → в пути на выгрузку → выгрузка → освободился.
      // Один клик ставит сразу пару фактов (приезд + начало работ либо
      // конец работ + убытие), поэтому расчёт простоя не теряется: он
      // считается от прибытия до убытия на каждой точке.
      const isFirst = stop === stops[0];
      const isLast = stop === stops[stops.length - 1];
      if (!stop.actual_arrival) {
        const candidates = [stop.estimated_arrival,
          Date.parse(stop.planned_arrival || ''), Date.parse(trip.ends_at)];
        const at = candidates.find(Number.isFinite) ?? Date.now();
        return { at,
          label: `${isFirst ? '🛣 в пути на погрузку' : isLast ? '🛣 в пути на выгрузку' : '🛣 в пути'}: ${point}`,
          point, zone: trip.to_name, stopId: stop.id,
          stepFields: 'actualArrival,workStartedAt',
          stepLabel: isFirst ? 'Погрузка' : isLast ? 'Выгрузка' : 'Прибыл' };
      }
      return { at: Date.parse(stop.actual_arrival) + normOpMs,
        label: `${isFirst ? '📦 погрузка' : isLast ? '📥 выгрузка' : '⏸ стоянка'}: ${point}`,
        point, zone: trip.to_name, stopId: stop.id,
        stepFields: 'workFinishedAt,actualDeparture',
        stepLabel: isFirst ? 'В пути на выгрузку' : isLast ? 'Освободился' : 'Убыл' };
    }
    return { at: Date.parse(trip.ends_at), label: 'завершение рейса',
      point: trip.to_point || trip.to_name, zone: trip.to_name };
  };

  // «Взято в работу»: захват карточки на 15 минут — двое не отрабатывают
  // одну карточку параллельно. Ключ claim|tripId в общих отметках смены.
  const CLAIM_MS = 15 * 60_000;
  const claimOf = trip => {
    const mark = workedMap.get(`claim|${trip.id}`);
    if (!mark) return null;
    const at = Date.parse(String(mark.done_at).replace(' ', 'T') + 'Z');
    return Number.isFinite(at) && Date.now() - at < CLAIM_MS ? mark : null;
  };
  const claimLeftMin = claim => {
    const at = Date.parse(String(claim.done_at).replace(' ', 'T') + (String(claim.done_at).includes('Z') ? '' : 'Z'));
    return Math.max(1, Math.ceil((CLAIM_MS - (Date.now() - at)) / 60_000));
  };
  const claimBadge = (claim, mine) => claim
    ? `<span class="ctrl-claim-note ${mine ? 'mine' : 'other'}" title="Захват снимается сам через 15 минут после взятия">🖐 ${mine
        ? 'ВЫ ВЕДЁТЕ' : `ВЕДЁТ ${escapeHtml(String(claim.done_by).toUpperCase())}`} · ещё ${claimLeftMin(claim)} мин</span>` : '';
  const myName = state.data.user.fullName || '';
  // Ключ события СТАБИЛЬНЫЙ: рейс + подпись + плановая минута. Номер часа
  // просрочки в ключ не входит — раньше он «плыл» со временем, и отметка,
  // поставленная по ключу из давно отрисованной кнопки (тихое автообновление
  // не перерисовывает DOM без изменений данных), ложилась на устаревший ключ:
  // карточка после «✓ Отработано» тут же поднималась обратно наверх.
  const eventKeyOf = trip => {
    const event = nextControlEvent(trip);
    return `${trip.id}|${event.label}|${Number.isFinite(event.at) ? Math.round(event.at / 60_000) : 0}`
      .slice(0, 200);
  };
  // Ежечасный контроль сбоя — по свежести отметки: у просроченного события
  // (или «не выгружают») отметка живёт полтора часа С МОМЕНТА КОНТРОЛЯ, затем
  // протухает и карточка снова загорается. Час от факта звонка честнее
  // календарной границы часа просрочки (отметка не сгорает через минуту).
  const WORKED_TTL_MS = 1.5 * 3_600_000;
  // Событие ещё в будущем (дальнобой «в пути на выгрузку 29-го»): отметка
  // не должна прятать карточку на несколько суток — водитель может
  // выгрузиться раньше расчёта или встать. Повторный контроль каждые 12 ч.
  const RECHECK_MS = 12 * 3_600_000;
  const markDoneMs = mark => Date.parse(String(mark.done_at).replace(' ', 'T') + 'Z');
  const workedOf = trip => {
    const mark = workedMap.get(eventKeyOf(trip));
    if (!mark) return null;
    const event = nextControlEvent(trip);
    const overdue = event.at === 0 || (Number.isFinite(event.at) && event.at < Date.now());
    const doneAt = markDoneMs(mark);
    if (!Number.isFinite(doneAt)) return overdue ? null : mark;
    const ttl = overdue ? WORKED_TTL_MS : RECHECK_MS;
    return Date.now() - doneAt < ttl ? mark : null;
  };
  // Протухшая отметка будущего события — карточка на повторный контроль:
  // поднимается по моменту протухания (как «просроченная с этого времени»).
  const recheckOf = trip => {
    if (workedOf(trip)) return null;
    const mark = workedMap.get(eventKeyOf(trip));
    if (!mark) return null;
    const event = nextControlEvent(trip);
    if (!(Number.isFinite(event.at) && event.at > Date.now())) return null;
    const doneAt = markDoneMs(mark);
    return Number.isFinite(doneAt) ? { mark, sinceMs: Date.now() - doneAt } : null;
  };
  // Последний комментарий контролёра по рейсу (за сегодня-вчера) — даже если
  // событие уже сменилось: отметка «✓ отработано» привязана к конкретному
  // событию и с новым шагом карточка возвращается в очередь, но контекст
  // прошлого звонка терять нельзя.
  // Время отметки контроля (done_at в UTC «ГГГГ-ММ-ДД ЧЧ:ММ:СС») — в МСК.
  const markTime = mark => {
    const raw = String(mark?.done_at || '');
    if (!raw) return '';
    return formatDateTime(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  };
  const lastNoteOf = trip => {
    let best = null;
    for (const [key, mark] of workedMap) {
      if (!key.startsWith(`${trip.id}|`) || !mark.note) continue;
      if (!best || String(mark.done_at) > String(best.done_at)) best = mark;
    }
    return best;
  };
  // Ближайшее событие — наверх: просроченные и «не выгружают» первыми.
  // Отработанные события уходят под неотработанные и ждут своего следующего
  // события; выполненный рейс («Выгружен») из списка уходит сам.
  const eventAt = trip => {
    const recheck = recheckOf(trip);
    if (recheck) return markDoneMs(recheck.mark) + RECHECK_MS; // в прошлом — поднимает карточку
    return Number.isFinite(nextControlEvent(trip).at) ? nextControlEvent(trip).at : Infinity;
  };
  online.sort((a, b) => Number(!!workedOf(a)) - Number(!!workedOf(b)) || eventAt(a) - eventAt(b));

  // Заявка рейса — источник комментария продаж и «без НДС».
  const orderOf = trip => (data.orders || []).find(item => item.id === trip.order_id)
    || (data.orders || []).find(item => item.trip_id === trip.id) || null;

  // Полная карточка рейса: всё, что нужно для внесения в учётную систему, —
  // одним текстом с кнопкой копирования. Пункты и даты — напрямую из заявки
  // клиента (окно «с — по» как договорено с ним), БЕЗ расчётного транзитного
  // времени рейса; расчётные даты рейса — только фолбэк для 1С-рейсов без заявки.
  const tripCardText = trip => {
    const order = orderOf(trip);
    let via = [];
    try { via = JSON.parse(order?.via_json || '[]') || []; } catch { via = []; }
    const lines = [
      `№ заказа: ${trip.order_no || order?.order_no || '—'}`,
      `Маршрут: ${routeLabel(trip)}`,
      `Заказчик: ${trip.customer_name || order?.customer_name || '—'}`,
      `Погрузка: ${order?.from_point || order?.from_name || trip.from_point || trip.from_name}` +
        ` · ${formatDateTime(order?.window_from || trip.starts_at)}`,
      via.length ? `Промежуточные: ${via.map(item =>
        `${item.kind === 'P' ? '⬆' : '⬇'} ${item.point}`).join(', ')}` : '',
      `Выгрузка: ${order?.to_point || order?.to_name || trip.to_point || trip.to_name}` +
        ` · ${formatDateTime(order?.window_to || trip.ends_at)}`,
      `ТС: ${trip.vehicle_plate}${trip.trailer_plate ? ` · прицеп ${trip.trailer_plate}` : ''}` +
        `${trip.vehicle_type ? ` · ${trip.vehicle_type}` : ''}`,
      `Водитель: ${trip.driver_name || 'не назначен'}`,
      trip.temperature_mode ? `Темп. режим: ${trip.temperature_mode}` : '',
      trip.body_type ? `Кузов: ${trip.body_type}` : '',
      `Км план: ${Math.round(trip.distance_km || 0)}${trip.empty_km
        ? ` (+${Math.round(trip.empty_km)} порож.)` : ''}`,
      `Ставка с НДС: ${money(trip.revenue_vat)}`,
      order ? `Без НДС: ${money(orderNet(order, data))}` : '',
      Number(trip.cash)
        ? `Оплата: 💵 НАЛИЧНЫЕ — водителю забрать ${money(trip.revenue_vat)} после выгрузки`
        : 'Оплата: безналичный расчёт',
      order?.comment ? `Комментарий продаж: ${order.comment}` : '',
      trip.external_id ? `ID 1С: ${trip.external_id}` : ''
    ];
    return lines.filter(Boolean).join('\n');
  };
  const tripCardDialog = trip => {
    const text = tripCardText(trip);
    // Комментарий продаж — отдельным заметным блоком со своей кнопкой
    // копирования (и он же входит строкой в общий текст карточки).
    const comment = String(orderOf(trip)?.comment || '').trim();
    const orderFiles = trip.order_id ? orderFilesOf(data, trip.order_id) : [];
    context.showModal(`<h2>Карточка рейса</h2>
      <p class="muted" style="margin:0 0 8px">Полные данные для учётной системы —
        «Скопировать всё» или выделите нужные строки.</p>
      ${comment ? `<div class="sales-comment" style="display:flex;gap:8px;align-items:flex-start;margin:0 0 8px">
        <span style="flex:1;min-width:0">💬 Продажи: ${escapeHtml(comment)}</span>
        <button class="button ghost small" id="tripCardCopyComment" style="flex:none"
          title="Скопировать только комментарий">📋</button>
      </div>` : ''}
      ${orderFiles.length ? `<div class="order-files" style="margin:0 0 8px">${orderFiles.map(file =>
        `<a class="ofile" href="/api/order-files/${file.id}" target="_blank" rel="noopener">📎 ${escapeHtml(file.file_name)}</a>`).join('')}</div>` : ''}
      <textarea id="tripCardText" readonly rows="${Math.min(16, text.split('\n').length + 1)}"
        style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre">${escapeHtml(text)}</textarea>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="button" id="tripCardCopy">📋 Скопировать всё</button>
        <button class="button ghost" id="tripCardClose">Закрыть</button>
      </div>`);
    const area = document.getElementById('tripCardText');
    const copyText = async value => {
      try { await navigator.clipboard.writeText(value); } catch {
        const helper = document.createElement('textarea');
        helper.value = value; document.body.append(helper);
        helper.select(); document.execCommand('copy'); helper.remove();
      }
    };
    document.getElementById('tripCardClose').onclick = () => context.closeModal();
    document.getElementById('tripCardCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        area.focus(); area.select();
        document.execCommand('copy');
      }
      toast('Карточка рейса скопирована');
    };
    const commentButton = document.getElementById('tripCardCopyComment');
    if (commentButton) commentButton.onclick = async () => {
      await copyText(comment);
      toast('Комментарий скопирован');
    };
  };

  // Первый план — сцепка (тягач/прицеп) и водитель; маршрут — второй строкой.
  const tripHead = trip => `<span style="flex:1;min-width:0;cursor:pointer" data-trip-card="${trip.id}"
      title="Клик — карточка рейса: полные данные с копированием">
      <strong class="mono trip-plate vlink" data-vinfo="${trip.vehicle_id}"
        title="Карточка ТС: рейс, простой, ремонт, отметки контролёра">${escapeHtml(trip.vehicle_plate)}${trip.trailer_plate
        ? ` / ${escapeHtml(trip.trailer_plate)}` : ''}</strong>
      · <b class="trip-driver">${escapeHtml(trip.driver_name || 'без водителя')}</b>
      ${Number(trip.cash) ? '<span class="cash-badge">💵 наличные</span>' : ''}
      <small class="trip-sub" style="display:block">${escapeHtml(routeLabel(trip))}
        · ${escapeHtml(trip.customer_name || 'без заказчика')}
        · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}${trip.empty_km
          ? ` · +${Math.round(trip.empty_km)} км порож.` : ''} · ${money(trip.revenue_vat)}</small>
      ${Number(trip.cash) ? `<small class="cash-note">💵 За наличные: укажите в задании водителю —
        после выгрузки забрать ${money(trip.revenue_vat)} у клиента</small>` : ''}
    </span>`;

  const prepStepOf = trip => !trip.entered_1c_at && !trip.deferred_1c_at ? ['1c', 'внести заказ в 1С']
    : !trip.driver_notified_at ? ['driver', 'отправить задание водителю']
    : ['online', 'вывести на линию'];
  // Свободная заметка диспетчера на карточке подготовки: произвольный текст,
  // видимый смене (живёт в общих отметках, ключ prepnote|рейс).
  const prepNoteOf = trip => workedMap.get(`prepnote|${trip.id}`) || null;
  // Строка события левого столбца: выход по плану, горит за 2 часа.
  const prepEventLine = (trip, label) => {
    const startMs = Date.parse(trip.starts_at);
    const overdue = startMs < Date.now();
    const hot = startMs - Date.now() <= 2 * 3_600_000;
    const claim = claimOf(trip);
    const claimMine = claim && claim.done_by === myName;
    const note = prepNoteOf(trip);
    return { hot, claimed: Boolean(claim), claimMine: Boolean(claimMine),
      html: `<small class="next-ctrl ${overdue ? 'overdue' : ''}">⏱ ${escapeHtml(label)} —
        выход ${formatDateTime(trip.starts_at)}${overdue ? ' · время вышло' : ''}
        ${hot && !overdue ? '<span class="ctrl-soon">🔥 менее 2 ч</span>' : ''}
        ${claimBadge(claim, claimMine)}
        ${canAct ? `<button class="button ghost small ctrl-worked-btn" data-claim="${trip.id}"
          title="${claimMine ? 'Отпустить карточку' : claim ? `Карточку ведёт ${escapeHtml(claim.done_by)} — перехватить`
            : 'Взять карточку в работу: коллеги увидят, что подготовкой уже занимаются'}">${claimMine ? '🖐 Отпустить' : '🖐 Беру'}</button>` : ''}
        ${canAct ? `<button class="button ghost small ctrl-worked-btn" data-prepnote="${trip.id}"
          title="Заметка по подготовке в произвольной форме — видна всей смене">💬${note ? ' ✎' : ' Заметка'}</button>` : ''}</small>
        ${note ? `<small class="prep-note">💬 ${escapeHtml(note.done_by || '')}: ${escapeHtml(note.note || '')}</small>` : ''}` };
  };
  const salesCommentNote = trip => {
    const comment = orderOf(trip)?.comment;
    return comment ? `<small class="sales-comment">💬 Продажи: ${escapeHtml(comment)}</small>` : '';
  };
  const prepSorted = [...preparing].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  // Карточка подготовки оформлена как в «Контроле на линии»: справа
  // бейдж срочности по событию (плановому выходу), ниже — действия.
  const prepStatusBadge = trip => {
    const diff = Date.parse(trip.starts_at) - Date.now();
    if (diff < 0) return `<span class="badge bad"
      title="Плановый выход ${formatDateTime(trip.starts_at)} прошёл — выводите фактическим временем или переносите">⏰ выход просрочен ${waitingLabel(-diff)}</span>`;
    if (diff <= 2 * 3_600_000) return `<span class="badge warn"
      title="До планового выхода меньше двух часов — завершайте чек-лист">🔥 выход через ${waitingLabel(diff)}</span>`;
    return `<span class="badge ok">выход ${formatDateTime(trip.starts_at)}</span>`;
  };
  // Суммы заявок зачастую предварительные — в учётную систему должна уйти
  // точная: пока сумма не сверена с заявкой клиента, карточка призывает
  // «Уточнить сумму», после сверки показывает, кто и какую подтвердил.
  const sumLine = trip => {
    if (trip.sum_confirmed_at) {
      return `<div class="sum-line ok">✓ Сумма ${money(trip.revenue_vat)} уточнена по заявке клиента
        · ${escapeHtml(trip.sum_confirmed_by || '')}
        ${canAct ? `<button class="button ghost small" data-confirm-sum="${trip.id}"
          title="Поправить сумму ещё раз">✎</button>` : ''}</div>`;
    }
    return `<div class="sum-line warn">💰 ${money(trip.revenue_vat)} — предварительно.
      ${canAct ? `<button class="button small" data-confirm-sum="${trip.id}"
        title="Сверить ставку с заявкой клиента: подтвердить или внести точную — до внесения заказа в учётную систему">Уточнить сумму по заявке клиента</button>`
      : '<b>Уточнить сумму по заявке клиента</b> (диспетчер)'}</div>`;
  };
  const prepCard = trip => {
    const event = prepEventLine(trip, prepStepOf(trip)[1]);
    const overdue = Date.parse(trip.starts_at) < Date.now();
    return `<div class="card ${event.hot ? 'ctrl-hot' : ''} ${event.claimed ? `ctrl-claimed ${event.claimMine ? 'mine' : ''}` : ''}"
        style="margin-bottom:10px;padding:9px 11px">
      <div class="list-item ordrow ${overdue ? 'pipe-rejected' : event.hot ? 'pipe-returned' : ''}" style="border:0;padding:0 0 4px">
        ${tripHead(trip)}
        <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          ${prepStatusBadge(trip)}
          <button class="button ghost small" data-incident="${trip.id}" title="Поломка, отказ клиента, переназначение">⚠ Внештатная</button>
        </span>
      </div>
      ${sumLine(trip)}
      ${event.html}
      ${salesCommentNote(trip)}
      ${checklistBlock(trip, canAct)}
    </div>`;
  };
  // Выход просрочен больше суток — это уже не рабочая очередь, а разборник:
  // машина либо уехала без отметок, либо рейс не состоялся. Такие карточки
  // сворачиваются, чтобы не хоронить под собой сегодняшние выходы.
  const STALE_PREP_MS = 24 * 3_600_000;
  const freshPrep = prepSorted.filter(trip => Date.now() - Date.parse(trip.starts_at) < STALE_PREP_MS);
  const stalePrep = prepSorted.filter(trip => Date.now() - Date.parse(trip.starts_at) >= STALE_PREP_MS);
  const prepCards = freshPrep.map(prepCard).join('')
    || (stalePrep.length ? '' : '<p class="muted">Нет рейсов в подготовке — очередь чиста.</p>');
  const staleBlock = stalePrep.length ? `<details class="stale-preps" id="dispatcherStale"
      ${state.dispatcherStaleOpen ? 'open' : ''}>
    <summary>⚠ Выход просрочен больше суток <span class="scount">${stalePrep.length}</span></summary>
    <p class="geohint">Если машина уехала без отметок — проставьте шаги чек-листа фактическим
      временем (вывод на линию продолжит контроль). Если рейс не состоялся — «⚠ Внештатная»:
      отказ клиента или переназначение вернёт заявку в работу.</p>
    ${isAdmin ? (() => {
      const closable = stalePrep.filter(trip => trip.ends_at < new Date().toISOString());
      return closable.length ? `<button class="button small" id="staleCloseAll"
        title="Только администратор. Каждый рейс станет «Выгружен» фактом планового времени: карточки уйдут из подготовки и не всплывут в контроле">✅ Закрыть всё как выполненное (${closable.length})</button>` : '';
    })() : ''}
    ${stalePrep.map(prepCard).join('')}
  </details>` : '';

  const waitSorted = [...waitingLogist].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const waitCards = waitSorted.map(trip => {
    const event = prepEventLine(trip, 'напомнить логисту о подтверждении');
    return `<div class="card ${event.hot ? 'ctrl-hot' : ''}" style="padding:9px 11px">
      <div class="list-item ordrow pipe-wait" style="border:0;padding:0">
        ${tripHead(trip)}
        <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
          ${prepStatusBadge(trip)}
          <span class="pipe-badge">Ждёт: Логист · подтверждение назначения</span>
        </span>
      </div>
      ${event.html}
    </div>`;
  }).join('');

  // Лента контрольных точек рейса — как в промышленных TMS: на каждой
  // стоянке план / расчёт / факты прибытия-убытия, работы и простой;
  // отметка следующего факта одним нажатием (сервер сам двигает конвейер:
  // убытие с погрузки → «В пути», конечная выгрузка → «Выгружен»).
  const HOUR = 3_600_000;
  const stopKindLabel = stop => stop.kind === 'P' ? '⬆ Погрузка' : '⬇ Выгрузка';
  // Те же два шага, что и на карточке: приезд (начинает отсчёт на точке) и
  // убытие (закрывает его). Отдельные отметки начала и конца работ остались
  // в правке ✎ — для случаев, когда их нужно разнести по времени.
  const nextStopStep = stop => stop.actual_departure ? null
    : !stop.actual_arrival ? ['Прибыл', 'actualArrival,workStartedAt']
    : ['Убыл', 'workFinishedAt,actualDeparture'];
  const fmtShort = iso => iso ? formatDateTime(iso) : '—';
  const stopsBlock = trip => {
    const control = controlByTrip.get(trip.id);
    if (!control?.stops?.length) return '<p class="muted" style="margin:6px 0 0">Стоянки появятся после обновления контроля.</p>';
    const normMs = Number(data.settings.calculation.handlingHoursPerOperation || 2) * HOUR;
    const rows = control.stops.map(stop => {
      const arrivalMs = stop.actual_arrival ? Date.parse(stop.actual_arrival) : null;
      const departureMs = stop.actual_departure ? Date.parse(stop.actual_departure) : null;
      const dwellMs = arrivalMs ? (departureMs ?? Date.now()) - arrivalMs : null;
      const dwellClass = dwellMs == null ? '' : dwellMs > 2 * normMs ? 'danger' : dwellMs > normMs ? 'stop-warn' : 'muted';
      const dwellText = dwellMs == null ? ''
        : ` · на точке ${Math.floor(dwellMs / HOUR)} ч ${Math.round(dwellMs % HOUR / 60_000)} м${departureMs ? '' : ' (идёт)'}`;
      const lateMs = stop.planned_arrival && (arrivalMs ?? stop.estimated_arrival)
        ? (arrivalMs ?? stop.estimated_arrival) - Date.parse(stop.planned_arrival) : 0;
      const step = nextStopStep(stop);
      return `<div class="list-item" style="padding:7px 10px">
        <span style="flex:1;min-width:0">
          <strong>${stopKindLabel(stop)} · ${escapeHtml(stop.point || '—')}</strong>
          ${lateMs > 30 * 60_000 ? `<span class="badge bad" style="margin-left:6px">+${Math.round(lateMs / HOUR * 10) / 10} ч</span>` : ''}
          <small class="muted" style="display:block">план ${fmtShort(stop.planned_arrival)}
            ${!stop.actual_arrival && stop.estimated_arrival ? ` · расчёт ${fmtShort(new Date(stop.estimated_arrival).toISOString())}` : ''}
            · факт ${fmtShort(stop.actual_arrival)} → ${fmtShort(stop.actual_departure)}</small>
          <small class="${dwellClass}" style="display:block">${stop.work_started_at
            ? `работы ${fmtShort(stop.work_started_at)} → ${fmtShort(stop.work_finished_at)}` : 'работы не начаты'}${dwellText}</small>
          ${stop.note ? `<small class="muted" style="display:block">💬 ${escapeHtml(stop.note)}</small>` : ''}
        </span>
        ${canAct ? `<span style="display:flex;gap:5px;align-items:center">
          ${step ? `<button class="button small" data-stop-step="${stop.id}" data-stop-field="${step[1]}"
            title="Отметить факт текущим временем">${step[0]}</button>` : '<span class="badge ok">✓ пройдена</span>'}
          <button class="button ghost small" data-stop-edit="${stop.id}" data-stop-trip="${trip.id}"
            title="Поправить времена и заметку">✎</button>
        </span>` : ''}
      </div>`;
    }).join('');
    return `<div class="list" style="margin-top:8px">${rows}</div>
      ${canAct ? `<button class="button ghost small" style="margin-top:6px" data-stop-add="${trip.id}"
        title="Промежуточная точка: дозагрузка, санобработка, отдых">+ Стоянка</button>` : ''}`;
  };

  // Единый диалог факта: любое событие линии фиксируется с датой и временем —
  // по умолчанию «сейчас», при поздней отметке диспетчер ставит реальное время
  // (иначе опоздания и простой считались бы от момента нажатия кнопки).
  const factDialog = (title, hint, onSubmit) => {
    context.showModal(`<form id="factForm"><h2>${title}</h2>
      <p class="muted">${hint}</p>
      <label class="field">Фактические дата и время
        <input name="factAt" type="datetime-local" required value="${toLocalInput(new Date().toISOString())}"></label>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Зафиксировать</button>
      </div></form>`);
    document.getElementById('factForm').onsubmit = async event => {
      event.preventDefault();
      const iso = formValues(event.currentTarget).factAt;
      if (!iso) return;
      try {
        await onSubmit(iso);
        context.closeModal();
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  // Правка времён стоянки: все шесть отметок + заметка (PATCH /api/stops/:id).
  const stopEditDialog = stop => {
    const timeInput = (name, label, value) => `<label class="field">${label}
      <input name="${name}" type="datetime-local" value="${value ? toLocalInput(value) : ''}"></label>`;
    context.showModal(`<form id="stopEditForm"><h2>Стоянка · ${escapeHtml(stop.point || '')}</h2>
      <div class="form-grid">
        ${timeInput('actualArrival', 'Факт прибытия', stop.actual_arrival)}
        ${timeInput('actualDeparture', 'Факт убытия', stop.actual_departure)}
        ${timeInput('workStartedAt', 'Начало работ', stop.work_started_at)}
        ${timeInput('workFinishedAt', 'Окончание работ', stop.work_finished_at)}
        ${timeInput('plannedArrival', 'План прибытия', stop.planned_arrival)}
        ${timeInput('plannedDeparture', 'План убытия', stop.planned_departure)}
      </div>
      <label class="field">Заметка<input name="note" maxlength="200" value="${escapeHtml(stop.note || '')}"
        placeholder="очередь на рампе, досмотр, отдых водителя…"></label>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Сохранить</button>
      </div></form>`);
    document.getElementById('stopEditForm').onsubmit = async event => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      const body = {};
      for (const key of ['actualArrival', 'actualDeparture', 'workStartedAt', 'workFinishedAt',
        'plannedArrival', 'plannedDeparture']) body[key] = values[key] || null;
      body.note = values.note || '';
      try {
        await api(`/api/stops/${stop.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        context.closeModal();
        toast('Стоянка обновлена');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  // Промежуточная точка контроля: дозагрузка, санобработка, отдых, граница.
  const stopAddDialog = tripId => {
    context.showModal(`<form id="stopAddForm"><h2>Промежуточная стоянка</h2>
      <label class="field">Пункт<input name="point" required placeholder="город / терминал / пост"></label>
      <div class="form-grid">
        <label class="field">Тип<select name="kind">
          <option value="D">Выгрузка / контроль</option><option value="P">Погрузка</option></select></label>
        <label class="field">План прибытия<input name="plannedArrival" type="datetime-local"></label>
      </div>
      <label class="field">Заметка<input name="note" maxlength="200"></label>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Добавить</button>
      </div></form>`);
    document.getElementById('stopAddForm').onsubmit = async event => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      try {
        await api(`/api/trips/${tripId}/stops`, { method: 'POST', body: JSON.stringify(values) });
        context.closeModal();
        toast('Стоянка добавлена в маршрут');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  const ctrlCard = trip => {
    const delay = delayByTrip.get(trip.id) || 0;
    const stuck = isStuck(trip);
    const late = !trip.arrived_at && delay > LATE_MS;
    // Долги перед 1С: заказ уехал без внесения или после замены ТС данные
    // устарели — бейдж с кнопкой закрытия висит, пока долг не погашен.
    const debt1c = [];
    if (trip.deferred_1c_at && !trip.entered_1c_at) {
      debt1c.push(`<span class="badge bad" title="Рейс отправлен без внесения заказа в 1С (${formatDateTime(trip.deferred_1c_at)}) — внесите и закройте долг">📒 1С: заказ не внесён</span>
        ${canAct ? `<button class="button small" data-step="entered_1c" data-trip="${trip.id}"
          title="Заказ внесён в учётную систему — долг закрыт">✓ Внесено в 1С</button>` : ''}`);
    }
    if (trip.needs_1c_update_at) {
      debt1c.push(`<span class="badge bad" title="После замены ТС данные в учётной системе устарели">📒 1С: ${escapeHtml(trip.needs_1c_note || 'обновить данные')}</span>
        ${canAct ? `<button class="button small" data-step="1c_updated" data-trip="${trip.id}"
          title="Данные в 1С обновлены — долг закрыт">✓ 1С обновлено</button>` : ''}`);
    }
    const debtBlock = debt1c.join(' ');
    // Повторный контроль: прошлый «✓ отработано» протух (12 ч), событие ещё
    // впереди — карточка поднята, диспетчеру пора снова выйти на связь.
    const recheck = recheckOf(trip);
    const recheckBlock = recheck
      ? `<span class="badge bad" title="Прошлый контроль: ${escapeHtml(recheck.mark.done_by || '')} ${markTime(recheck.mark)}${recheck.mark.note ? ` — «${escapeHtml(recheck.mark.note)}»` : ''}. По дальним рейсам контроль минимум дважды в сутки">🔁 повторный контроль — ${Math.floor(recheck.sinceMs / 3_600_000)} ч без связи</span>` : '';
    // До факта прибытия рейс «в пути» (затянувшийся — опоздание, уведомление
    // продаж). «Прибыл на выгрузку» начинает отсчёт выгрузки: свыше 6 часов —
    // «не выгружают», особый контроль и выставление простоя клиенту.
    let statusBlock;
    if (stuck) {
      const stuckHours = Math.floor(stuckMsOf(trip) / 3_600_000);
      statusBlock = `<span class="badge bad" title="Прибыл ${formatDateTime(trip.arrived_at)}, выгрузка не отмечена более 6 часов — продажи и логисты уведомлены автоматически, диспетчерам пинг каждый час">🚨 не выгружают ${stuckHours} ч · особый контроль</span>
        ${Number(trip.demurrage_vat) > 0
          ? `<span class="badge warn" title="Простой добавлен к выручке рейса">простой выставлен: ${money(trip.demurrage_vat)}</span>`
          : (canAct ? `<button class="button small danger" data-demurrage="${trip.id}"
              title="Выставить клиенту простой на выгрузке (часы × ставка)">Выставить простой</button>` : '')}`;
    } else if (trip.arrived_at) {
      statusBlock = `<span class="badge ok" title="Факт прибытия отмечен — через 6 часов без выгрузки включится особый контроль">на выгрузке с ${formatDateTime(trip.arrived_at)}</span>
        ${Number(trip.demurrage_vat) > 0
          ? `<span class="badge warn">простой выставлен: ${money(trip.demurrage_vat)}</span>` : ''}`;
    } else if (late) {
      statusBlock = `<span class="badge bad" title="Расчётное прибытие позже плана — уведомите клиента о переносе">⏰ опоздание ${waitingLabel(delay)} · уведомите клиента</span>
        ${trip.delay_notified_at
          ? `<span class="badge warn" title="Авто-сообщение продажам отправлено">продажи уведомлены ${formatDateTime(trip.delay_notified_at)}</span>`
          : (canAct ? `<button class="button small danger" data-notify-delay="${trip.id}"
              title="Авто-сообщение сотруднику продаж: уведомить клиента о задержке">Уведомить продажи</button>` : '')}`;
    } else {
      statusBlock = `<span class="badge ok">на линии${trip.on_line_at ? ` с ${formatDateTime(trip.on_line_at)}` : ''}</span>`;
    }
    const opened = state.dispatcherStops === trip.id;
    const stopsCount = controlByTrip.get(trip.id)?.stops?.length || 0;
    const nextEvent = nextControlEvent(trip);
    const hasTime = Number.isFinite(nextEvent.at) && nextEvent.at > 0;
    const overdue = hasTime && nextEvent.at < Date.now();
    const worked = workedOf(trip);
    // «Горит»: событие ближе двух часов (или просрочено, или особый контроль)
    // и диспетчер его ещё не отработал.
    const hot = !worked && (nextEvent.at === 0 || (hasTime && nextEvent.at - Date.now() <= 2 * 3_600_000));
    const overdueHours = overdue ? Math.floor((Date.now() - nextEvent.at) / 3_600_000) : 0;
    const claim = claimOf(trip);
    const claimMine = claim && claim.done_by === myName;
    const eventLine = `<small class="next-ctrl ${overdue || nextEvent.at === 0 ? 'overdue' : ''}">⏱ далее —
      ${escapeHtml(nextEvent.label)}${hasTime ? ` · ${formatDateTime(new Date(nextEvent.at).toISOString())}
      ${localNote(nextEvent.at, nextEvent.point, nextEvent.zone)}` : ''}${overdue
        ? ` · ⏳ сбой ${overdueHours >= 1 ? `${overdueHours} ч` : '< 1 ч'} — контроль каждые 1,5 ч` : ''}
      ${hot && !overdue && nextEvent.at !== 0 ? '<span class="ctrl-soon">🔥 менее 2 ч</span>' : ''}
      ${claimBadge(claim, claimMine)}
      ${worked ? `<span class="ctrl-worked-note" ${worked.note ? `title="${escapeHtml(worked.note)}"` : ''}>✓ отработано
        · ${escapeHtml(worked.done_by || '')} · ${markTime(worked)}${worked.note ? ` — «${escapeHtml(String(worked.note).slice(0, 60))}»` : ''}</span>` : ''}
      ${(() => { const last = lastNoteOf(trip);
        return !worked && last ? `<span class="ctrl-last-note" title="${escapeHtml(last.note)}">💬 прошлый контроль
          · ${escapeHtml(last.done_by || '')} · ${markTime(last)} — «${escapeHtml(String(last.note).slice(0, 60))}»</span>` : ''; })()}
      ${(() => {
    // Заметка по рейсу общая для смены: её оставляют и в подготовке, и в
    // карточке звонка водителя — здесь она возвращается к диспетчеру.
    const note = prepNoteOf(trip);
    return note?.note ? `<span class="ctrl-last-note" title="${escapeHtml(note.note)}">💬 заметка
      · ${escapeHtml(note.done_by || '')} · ${markTime(note)} — «${escapeHtml(String(note.note).slice(0, 60))}»</span>` : '';
  })()}
      ${canAct ? `<button class="button ghost small ctrl-worked-btn" data-prepnote="${trip.id}"
        title="Комментарий по рейсу: виден всей смене и в карточке звонка водителя">💬 Заметка</button>` : ''}
      ${canAct && nextEvent.stopId && !worked ? `<button class="button small ctrl-quick"
        data-quick-stop="${nextEvent.stopId}" data-quick-field="${nextEvent.stepFields}"
        data-quick-label="${escapeHtml(nextEvent.stepLabel)}"
        title="Отметить факт «${escapeHtml(nextEvent.stepLabel)}» без открытия ленты точек">✔ ${escapeHtml(nextEvent.stepLabel)}</button>` : ''}
      ${canAct && !worked ? `<button class="button ghost small ctrl-worked-btn" data-claim="${trip.id}"
        title="${claimMine ? 'Отпустить карточку' : claim ? `Карточку ведёт ${escapeHtml(claim.done_by)} — перехватить`
          : 'Взять карточку в работу: коллеги увидят, что вы уже звоните'}">${claimMine ? '🖐 Отпустить' : '🖐 Беру'}</button>` : ''}
      ${canAct ? `<button class="button ghost small ctrl-worked-btn" data-worked="${escapeHtml(eventKeyOf(trip))}"
        ${worked ? '' : `data-worked-label="${escapeHtml(nextEvent.label)}" data-worked-trip="${trip.id}"`}
        title="${worked ? 'Снять отметку — событие вернётся в горящие' : 'Событие отработано — обязателен комментарий, карточка уйдёт вниз до следующего события'}">${worked ? '↩' : '✓ Отработано'}</button>` : ''}</small>`;
    return `<div class="card ${hot ? 'ctrl-hot' : ''} ${worked ? 'ctrl-done' : ''} ${claim ? `ctrl-claimed ${claimMine ? 'mine' : ''}` : ''}" style="padding:9px 11px">
      <div class="list-item ordrow ${stuck ? 'pipe-rejected' : late ? 'pipe-returned' : ''}" style="border:0;padding:0">
      ${tripHead(trip)}
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        ${statusBlock} ${recheckBlock} ${debtBlock}
        <span style="display:flex;gap:5px">
          <button class="button ghost small" data-stops-toggle="${trip.id}"
            title="Лента контрольных точек: прибытие, работы, убытие, простой">🧭 Точки${stopsCount ? ` (${stopsCount})` : ''}</button>
          <button class="button ghost small" data-question-new="${trip.id}"
            title="Водитель позвонил с вопросом — зафиксировать (норматив ответа 10 минут)">📞 Вопрос</button>
          <button class="button ghost small" data-incident="${trip.id}">⚠ Внештатная</button>
        </span>
      </span>
      </div>
      ${eventLine}
      ${opened ? `<div class="stops-inline">${stopsBlock(trip)}</div>` : ''}
    </div>`;
  };
  const inWork = online;
  const onlineCards = inWork.map(ctrlCard).join('')
    || '<p class="muted">На линии никого нет.</p>';
  // Перегоны порожним: машина едет пустой туда, где нужна. Этапы короче
  // рейса — задание водителю, выезд, прибытие; по прибытии сцепка числится
  // в точке назначения и уходит с контроля.
  const transfers = openTransfers(data).filter(item => !query ||
    `${item.vehicle_plate} ${item.driver_name || ''} ${item.to_name || ''} ${item.from_label || ''}`
      .toLowerCase().includes(query));
  const transferCard = transfer => {
    const stage = transferStage(transfer);
    const lateMs = stage.key === 'run' ? Date.now() - Date.parse(transfer.ends_at) : 0;
    return `<div class="card ctrl-transfer" style="margin-bottom:8px;padding:9px 11px">
      <div class="list-item ordrow" style="border:0;padding:0 0 4px">
        <span style="flex:1;min-width:0">
          <strong class="mono">${escapeHtml(transfer.vehicle_plate)}</strong>
          <small class="muted"> · ${escapeHtml(transfer.driver_name || 'без водителя')}</small>
          <small class="muted" style="display:block">🚚 порожним: ${escapeHtml(transfer.from_label || '—')}
            → <b>${escapeHtml(transfer.to_name || '—')}</b> · ${escapeHtml(transfer.purpose || '')}
            ${transfer.empty_km ? ` · ~${Math.round(transfer.empty_km)} км` : ''}</small>
          <small class="muted" style="display:block">выезд ${formatDateTime(transfer.starts_at)}
            · прибытие ${formatDateTime(transfer.ends_at)}${transfer.note
    ? ` · 💬 ${escapeHtml(transfer.note)}` : ''}</small>
        </span>
        <span class="badge ${lateMs > 2 * 3_600_000 ? 'bad' : stage.key === 'run' ? 'ok' : 'warn'}"
          title="Этап перегона">${stage.label}${lateMs > 2 * 3_600_000
    ? ` · опаздывает ${Math.floor(lateMs / 3_600_000)} ч` : ''}</span>
      </div>
      ${canAct ? `<div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="button small" data-transfer-step="${transfer.id}"
          data-transfer-action="${escapeHtml(stage.step)}"
          data-transfer-label="${escapeHtml(stage.action)}">✔ ${escapeHtml(stage.action)}</button>
        <button class="button ghost small" data-transfer-copy="${transfer.id}"
          title="Скопировать задание для водителя">📋 Задание</button>
        <button class="button ghost small danger" data-transfer-del="${transfer.id}"
          title="Отменить перегон (пока машина не прибыла)">✕</button>
      </div>` : ''}
    </div>`;
  };
  const transferCards = transfers.map(transferCard).join('');

  const QUESTION_SLA_MS = 10 * 60_000;
  const questionCard = question => {
    const openedMs = Date.parse(String(question.opened_at).replace(' ', 'T') +
      (String(question.opened_at).includes('Z') ? '' : 'Z'));
    const waitMs = Date.now() - openedMs;
    const late = waitMs > QUESTION_SLA_MS;
    const minutes = Math.max(0, Math.floor(waitMs / 60_000));
    return `<div class="card question-card ${late ? 'late' : ''}" style="padding:8px 10px;margin-bottom:6px">
      <div class="list-item ordrow" style="border:0;padding:0 0 4px">
        <span style="flex:1;min-width:0">
          <strong>${escapeHtml(topicLabel(question.topic))}</strong>
          ${question.vehicle_plate ? `<small class="muted"> · <span class="mono">${escapeHtml(question.vehicle_plate)}</span></small>` : ''}
          <small class="muted" style="display:block">${escapeHtml(question.driver_name || question.vehicle_driver || '')}
            ${question.phone ? ` · ${escapeHtml(question.phone)}` : ''}
            ${question.note ? ` · «${escapeHtml(question.note)}»` : ''}</small>
          <small class="muted" style="display:block">принял ${escapeHtml(question.opened_by_name || '')}
            · ${formatDateTime(new Date(openedMs).toISOString())}</small>
        </span>
        <span class="badge ${late ? 'bad' : 'warn'}"
          title="Норматив ответа — 10 минут">⏱ ${minutes} мин${late ? ' · просрочен' : ''}</span>
      </div>
      ${canAct ? `<div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="button small" data-question-close="${question.id}">✓ Отработано</button>
        ${question.vehicle_id ? `<button class="button ghost small" data-question-card="${question.vehicle_id}"
          title="Открыть карточку по звонку">📞 Карточка</button>` : ''}
      </div>` : ''}
    </div>`;
  };
  const questionCards = questions.map(questionCard).join('');

  const savedScrolls = captureScrolls(container);
  container.innerHTML = `<div class="saleswrap">
    ${!canAct ? `<div class="view-only">👁 Режим просмотра: отметки контроля доступны роли «Диспетчер».
      Если вы ведёте рейсы на линии — попросите администратора добавить вам роль
      в «Настройки → Пользователи».</div>` : ''}
    <div class="salekpis">
      <div class="skpi"><span class="skl">Ждут логиста</span><span class="skv">${waitingLogist.length}</span></div>
      <div class="skpi"><span class="skl">В подготовке</span><span class="skv">${preparing.length}</span></div>
      <div class="skpi"><span class="skl">На линии</span><span class="skv">${online.length}</span></div>
      ${demurrageChipHtml(data)}
      <div class="salesfilter" style="flex:1;min-width:220px">
        <input id="dispatcherSearch" class="block-search" placeholder="Поиск: маршрут, ТС, водитель, заказчик"
          value="${escapeHtml(state.dispatcherQuery || '')}" style="flex:1">
      </div>
    </div>
    ${questionCards ? `<div class="questions-strip">
      <div class="scolh">📞 Вопросы водителей <span>${questions.length}</span>
        <small class="muted" style="font-weight:400"> · норматив ответа 10 минут</small></div>
      <div class="list">${questionCards}</div>
    </div>` : ''}
    <div class="salesboard">
      <div class="scol">
        <div class="scolh">Подготовка выхода <span>${preparing.length}</span></div>
        ${staleBlock}
        ${prepCards}
        ${waitingLogist.length ? `<div class="scolh" style="margin-top:12px">Ждут подтверждения логиста <span>${waitingLogist.length}</span></div>
          <div class="list">${waitCards}</div>` : ''}
        <div class="geohint">Чек-лист по каждому рейсу: заказ в учётную систему (1С — отдельно),
          задание водителю, вывод на контроль на линии. Шаги идут по порядку.</div>
      </div>
      <div class="scol">
        ${transferCards ? `<div class="scolh">🚚 Перегоны порожним <span>${transfers.length}</span></div>
          <div class="geohint" style="margin:0 0 6px">Машина идёт пустой туда, где нужна.
            Этапы: задание водителю → выехал → прибыл. После «Прибыл» сцепка числится
            в точке назначения и доступна логисту для следующего задания.</div>
          <div class="list">${transferCards}</div>
          <div class="scolh" style="margin-top:12px">Контроль на линии <span>${inWork.length}</span></div>`
    : `<div class="scolh">Контроль на линии <span>${inWork.length}</span></div>`}
        <div class="list">${onlineCards}</div>
        <div class="geohint">Внештатная ситуация: поломка (ремонт + пересадка или снятие),
          отказ клиента, переназначение ТС. Снятый рейс возвращает заявку в продажи.</div>
      </div>
    </div>
  </div>`;
  restoreScrolls(container, savedScrolls);

  wireDemurrageChip(container, context);
  // Уточнение суммы: подтвердить текущую или внести точную из заявки клиента.
  container.querySelectorAll('[data-confirm-sum]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.confirmSum);
      if (!trip) return;
      context.showModal(`<form id="sumForm">
        <h2>💰 Сумма по заявке клиента</h2>
        <p class="muted">${escapeHtml(trip.vehicle_plate)} · ${escapeHtml(trip.customer_name || '')}
          ${trip.order_no ? `· № ${escapeHtml(trip.order_no)}` : ''}<br>
          Сверьте ставку с заявкой клиента — в учётную систему должна попасть точная сумма.</p>
        <label class="field">Ставка с НДС, ₽
          <input name="rateVat" inputmode="numeric" value="${Math.round(Number(trip.revenue_vat || 0))}"></label>
        <div class="modal-actions">
          <button type="button" class="button ghost" data-close>Отмена</button>
          <button type="button" class="button ghost" id="sumAsIs">✓ Сумма верна</button>
          <button class="button">Сохранить точную</button>
        </div></form>`);
      const submitSum = async rateVat => {
        try {
          await api(`/api/trips/${trip.id}/confirm-sum`, { method: 'POST',
            body: JSON.stringify(rateVat === undefined ? {} : { rateVat }) });
          context.closeModal();
          toast('Сумма уточнена по заявке клиента');
          await context.onReload();
        } catch (error) { toast(error.message, 'error'); }
      };
      document.getElementById('sumAsIs').onclick = () => submitSum();
      document.getElementById('sumForm').onsubmit = event => {
        event.preventDefault();
        const value = parseMoney(new FormData(event.currentTarget).get('rateVat'));
        if (!value) { toast('Введите сумму — или нажмите «Сумма верна»', 'error'); return; }
        submitSum(value);
      };
    }));

  container.querySelectorAll('[data-worked]').forEach(button =>
    button.addEventListener('click', async () => {
      const key = button.dataset.worked;
      // Снятие отметки — сразу; постановка — с обязательным комментарием.
      if (!button.dataset.workedLabel) {
        try {
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key, remove: true }) });
          await renderDispatcher(container, context);
        } catch (error) { toast(error.message, 'error'); }
        return;
      }
      const tripId = button.dataset.workedTrip;
      context.showModal(`<form id="workedForm">
        <h2>✓ Отработано</h2>
        <p class="muted">${escapeHtml(button.dataset.workedLabel)} — что выяснили по звонку?</p>
        <label class="field">Комментарий (обязательно)
          <textarea name="note" required minlength="5" maxlength="300" rows="3"
            placeholder="например: водитель в очереди на пандус, обещают через 40 минут"></textarea></label>
        <div class="modal-actions">
          <button type="button" class="button ghost" data-close>Отмена</button>
          <button class="button">Сохранить</button>
        </div></form>`);
      document.getElementById('workedForm').onsubmit = async event => {
        event.preventDefault();
        const note = String(new FormData(event.currentTarget).get('note') || '').trim();
        if (note.length < 5) { toast('Комментарий обязателен (от 5 символов)', 'error'); return; }
        try {
          // Отметка с комментарием — всегда постановка/обновление (сервер
          // не переключает): повторный контроль по тому же событию не теряется.
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key, note }) });
          // Отработка снимает мой захват карточки.
          const claim = workedMap.get(`claim|${tripId}`);
          if (claim && claim.done_by === myName) {
            await api('/api/task-marks', { method: 'POST',
              body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `claim|${tripId}` }) }).catch(() => {});
          }
          context.closeModal();
          toast('Отработано — комментарий сохранён');
          await renderDispatcher(container, context);
        } catch (error) { toast(error.message, 'error'); }
      };
    }));
  // «💬 Заметка» подготовки: произвольный текст, перезапись = снять + поставить.
  container.querySelectorAll('[data-prepnote]').forEach(button =>
    button.addEventListener('click', () => {
      const tripId = button.dataset.prepnote;
      const existing = workedMap.get(`prepnote|${tripId}`);
      context.showModal(`<form id="prepNoteForm">
        <h2>💬 Заметка по рейсу</h2>
        <label class="field">Комментарий (видит вся смена и карточка звонка водителя; пусто — удалить)
          <textarea name="note" maxlength="300" rows="3">${escapeHtml(existing?.note || '')}</textarea></label>
        <div class="modal-actions">
          <button type="button" class="button ghost" data-close>Отмена</button>
          <button class="button">Сохранить</button>
        </div></form>`);
      document.getElementById('prepNoteForm').onsubmit = async event => {
        event.preventDefault();
        const note = String(new FormData(event.currentTarget).get('note') || '').trim();
        try {
          if (existing) await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `prepnote|${tripId}`, remove: true }) });
          if (note) await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `prepnote|${tripId}`, note }) });
          context.closeModal();
          await renderDispatcher(container, context);
        } catch (error) { toast(error.message, 'error'); }
      };
    }));
  // «🖐 Беру»: захват карточки (toggle); перехват чужого — новый claim после снятия.
  container.querySelectorAll('[data-claim]').forEach(button =>
    button.addEventListener('click', async () => {
      const tripId = button.dataset.claim;
      // Мгновенная реакция и защита от дабл-клика: кнопка блокируется
      // на время запроса и перерисовки.
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = '⏳';
      try {
        const existing = workedMap.get(`claim|${tripId}`);
        const atMs = existing ? Date.parse(String(existing.done_at).replace(' ', 'T') +
          (String(existing.done_at).includes('Z') ? '' : 'Z')) : NaN;
        const alive = Number.isFinite(atMs) && Date.now() - atMs < CLAIM_MS;
        // Явные операции вместо переключателя: свой живой захват — отпустить;
        // чужой живой — перехват только с подтверждением; протухший/пустой —
        // взять. (Переключатель при вчерашней записи по тому же ключу ставил
        // и тут же снимал захват — «карточка слетает после захвата».)
        if (existing && alive && existing.done_by === myName) {
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `claim|${tripId}`, remove: true }) });
        } else {
          if (existing && alive && existing.done_by !== myName &&
              !confirm(`Карточку ведёт ${existing.done_by} (взял ${Math.round((Date.now() - atMs) / 60_000)} мин назад, ` +
                `освободится сама через ${claimLeftMin(existing)} мин).\n\nПерехватить? Коллега увидит, что карточка теперь у вас.`)) {
            button.disabled = false; button.textContent = label; return;
          }
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `claim|${tripId}`, set: true }) });
        }
        await renderDispatcher(container, context);
      } catch (error) {
        button.disabled = false;
        button.textContent = label;
        toast(error.message, 'error');
      }
    }));
  // «✔ Этап»: переход к следующему этапу прямо с карточки. Один клик ставит
  // пару фактов (приезд + начало работ либо конец работ + убытие) — этапов
  // пять, а расчёт простоя на точке не теряется.
  container.querySelectorAll('[data-quick-stop]').forEach(button =>
    button.addEventListener('click', () => factDialog(
      `Этап рейса · ${button.dataset.quickLabel}`,
      'Укажите фактическое время события на стоянке.', async iso => {
        const body = {};
        for (const field of String(button.dataset.quickField).split(',')) body[field] = iso;
        await api(`/api/stops/${button.dataset.quickStop}`, {
          method: 'PATCH', body: JSON.stringify(body)
        });
        toast('Этап отмечен');
      })));

  // Клик по плашке рейса — карточка с полными данными и копированием;
  // клики по кнопкам внутри строки карточку не открывают.
  container.querySelectorAll('[data-trip-card]').forEach(head =>
    head.addEventListener('click', event => {
      if (event.target.closest('button, [data-vinfo]')) return;
      const trip = data.trips.find(item => item.id === head.dataset.tripCard);
      if (trip) tripCardDialog(trip);
    }));

  // Автообновление раз в 60 с: захваты и отметки коллег видны без действий.
  // Пауза, когда открыт модал или идёт ввод — чтобы не сбивать работу.
  clearInterval(state.dispatcherTimer);
  state.dispatcherTimer = setInterval(() => {
    if (state.view !== 'dispatcher') { clearInterval(state.dispatcherTimer); return; }
    if (document.querySelector('#modalRoot .modal')) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    context.onReload();
  }, 60_000);

  container.querySelector('#dispatcherStale')?.addEventListener('toggle', event => {
    state.dispatcherStaleOpen = event.currentTarget.open;
  });

  // Массовое закрытие разборника: рейсы с выходом старше суток и расчётной
  // выгрузкой в прошлом закрываются задним числом — «Выгружен» фактом
  // планового времени. Рейсы с выгрузкой в будущем не трогаются (машина
  // может реально ехать — их выводят на линию).
  container.querySelector('#staleCloseAll')?.addEventListener('click', async event => {
    const nowIso = new Date().toISOString();
    const closable = preparing.filter(trip =>
      Date.now() - Date.parse(trip.starts_at) >= 24 * 3_600_000 && trip.ends_at < nowIso);
    if (!closable.length) return;
    if (!confirm(`Закрыть ${closable.length} рейс(ов) как выполненные задним числом?
`
      + 'Каждый станет «Выгружен» фактом планового времени. '
      + 'Действие видно в аудите. Рейсы, чья выгрузка ещё впереди, не трогаются.')) return;
    event.currentTarget.disabled = true;
    let done = 0;
    for (const trip of closable) {
      try {
        await api(`/api/trips/${trip.id}`, { method: 'PATCH',
          body: JSON.stringify({ status: 'unloaded', factAt: trip.ends_at }) });
        done += 1;
      } catch (error) { toast(`${trip.vehicle_plate || ''}: ${error.message}`, 'error'); }
    }
    toast(`Закрыто рейсов: ${done}`);
    await renderDispatcher(container, context);
  });
  attachSearch(container.querySelector('#dispatcherSearch'), async value => {
    state.dispatcherQuery = value;
    await renderDispatcher(container, context, { reuseNetwork: true });
  });

  container.querySelectorAll('[data-step]').forEach(button =>
    button.addEventListener('click', () => {
      if (button.dataset.step === 'on_line') {
        factDialog('Вывод на линию', 'От этого времени считаются опоздания в пути.', async iso => {
          await api(`/api/trips/${button.dataset.trip}/step`, {
            method: 'POST', body: JSON.stringify({ step: 'on_line', at: iso })
          });
          toast('Рейс на линии — контроль пошёл');
        });
        return;
      }
      runStep(button.dataset.trip, button.dataset.step, context.onReload);
    }));
  container.querySelectorAll('[data-question-new]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.questionNew);
      if (!trip) return;
      const driver = (data.drivers || []).find(item => item.vehicle_id === trip.vehicle_id);
      questionDialog(context, { vehicleId: trip.vehicle_id, tripId: trip.id,
        driverName: driver?.full_name || trip.driver_name || '', phone: driver?.phone || '' });
    }));
  container.querySelectorAll('[data-question-close]').forEach(button =>
    button.addEventListener('click', () => {
      const question = questions.find(item => item.id === button.dataset.questionClose);
      if (question) closeQuestionDialog(context, question);
    }));
  container.querySelectorAll('[data-question-card]').forEach(button =>
    button.addEventListener('click', () => callCardDialog(context, { vehicleId: button.dataset.questionCard })));
  container.querySelectorAll('[data-transfer-step]').forEach(button =>
    button.addEventListener('click', () => factDialog(
      `Перегон · ${button.dataset.transferLabel}`,
      'Укажите фактическое время события.', async iso => {
        await api(`/api/transfers/${button.dataset.transferStep}/step`, {
          method: 'POST', body: JSON.stringify({ step: button.dataset.transferAction, at: iso })
        });
        toast(button.dataset.transferAction === 'arrived'
          ? 'Перегон завершён — машина числится в точке назначения'
          : 'Этап перегона отмечен');
      })));
  container.querySelectorAll('[data-transfer-copy]').forEach(button =>
    button.addEventListener('click', async () => {
      const transfer = transfers.find(item => item.id === button.dataset.transferCopy);
      if (!transfer) return;
      try {
        await navigator.clipboard.writeText(transferTaskText(transfer));
        toast('Задание скопировано — отправьте водителю');
      } catch { toast('Не удалось скопировать', 'error'); }
    }));
  container.querySelectorAll('[data-transfer-del]').forEach(button =>
    button.addEventListener('click', async () => {
      if (!confirm('Отменить перегон? Машина останется на прежнем месте.')) return;
      try {
        await api(`/api/transfers/${button.dataset.transferDel}`, { method: 'DELETE' });
        toast('Перегон отменён');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
  container.querySelectorAll('[data-incident]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.incident);
      if (trip) incidentDialog(trip, data, context);
    }));
  container.querySelectorAll('[data-notify-delay]').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/trips/${button.dataset.notifyDelay}/notify-delay`, { method: 'POST' });
        toast('Продажи уведомлены — они предупредят клиента о задержке');
        await context.onReload();
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'error');
      }
    }));
  container.querySelectorAll('[data-stops-toggle]').forEach(button =>
    button.addEventListener('click', () => {
      const tripId = button.dataset.stopsToggle;
      const card = button.closest('.card');
      const openedBlock = card?.querySelector('.stops-inline');
      if (openedBlock) {
        state.dispatcherStops = null;
        openedBlock.remove();
        return;
      }
      state.dispatcherStops = tripId;
      const trip = data.trips.find(item => item.id === tripId);
      if (!trip || !card) return;
      const holder = document.createElement('div');
      holder.className = 'stops-inline';
      holder.innerHTML = stopsBlock(trip);
      card.append(holder);
      wireStopButtons(holder);
    }));
  const wireStopButtons = scope => {
  scope.querySelectorAll('[data-stop-step]').forEach(button =>
    button.addEventListener('click', () => factDialog(`Контрольная точка · ${button.textContent.trim()}`,
      'Укажите фактическое время события на стоянке.', async iso => {
        const body = {};
        for (const field of String(button.dataset.stopField).split(',')) body[field] = iso;
        await api(`/api/stops/${button.dataset.stopStep}`, {
          method: 'PATCH', body: JSON.stringify(body)
        });
        toast('Факт отмечен');
      })));
  scope.querySelectorAll('[data-stop-edit]').forEach(button =>
    button.addEventListener('click', () => {
      const control = controlByTrip.get(button.dataset.stopTrip);
      const stop = control?.stops?.find(item => item.id === button.dataset.stopEdit);
      if (stop) stopEditDialog(stop);
    }));
  scope.querySelectorAll('[data-stop-add]').forEach(button =>
    button.addEventListener('click', () => stopAddDialog(button.dataset.stopAdd)));
  };
  wireStopButtons(container);
  container.querySelectorAll('[data-demurrage]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.demurrage);
      if (trip) demurrageDialog(trip, data, context, stuckMsOf(trip));
    }));
}
