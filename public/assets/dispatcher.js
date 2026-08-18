// Блок «Диспетчер» — построен заново вместо «Контроля».
// Конвейер после назначения ТС: заявка уходит на подтверждение логисту,
// затем диспетчер ведёт чек-лист выхода: 1) заказ внесён в учётную систему
// (1С временно работает отдельно от продукта), 2) задание водителю отправлено,
// 3) рейс переведён на контроль на линии (статус «В пути»).
// Внештатные ситуации: отказ клиента, поломка ТС (ремонт + переназначение),
// переназначение ТС — с возвратом заявки в продажи при снятии рейса.
import { api, attachSearch, escapeHtml, formValues, formatDateTime, money, routeLabel, toLocalInput, toast } from './api.js';
import { orderFilesOf, orderNet, resolveAddress } from './sales.js';
import { waitingLabel } from './pipeline.js';
import { replaceVehicleDialog, rejectTripDialog } from './logist.js';

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
    toast(step === 'on_line' ? 'Рейс на линии — статус «В пути»' : 'Шаг отмечен');
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
      <button type="button" class="list-item" id="incOther">
        <span><strong>✕ Снять рейс по другой причине</strong>
        <small class="muted" style="display:block">ДТП, погода, опоздание и прочее — с обязательной причиной</small></span></button>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button></div>`);
  document.getElementById('incBreakdown').onclick = () => breakdownDialog(trip, data, context);
  document.getElementById('incRefusal').onclick = () => customerRefusalDialog(trip, context);
  document.getElementById('incReassign').onclick = () => replaceVehicleDialog(trip, data, context);
  document.getElementById('incOther').onclick = () => rejectTripDialog(trip, data, context);
}

function checklistBlock(trip, canAct) {
  const rows = CHECKLIST.map((item, index) => {
    const done = trip[item.column];
    const previousDone = index === 0 || trip[CHECKLIST[index - 1].column];
    return `<div class="list-item" style="padding:6px 10px">
      <span style="flex:1;min-width:0">
        <strong style="${done ? 'color:var(--ok)' : ''}">${done ? '✓' : `${index + 1}.`} ${item.label}</strong>
        <small class="muted" style="display:block">${done ? `выполнено ${formatDateTime(done)}` : item.hint}</small>
      </span>
      ${!done && canAct && previousDone
        ? `<button class="button small" data-step="${item.step}" data-trip="${trip.id}">${item.action}</button>` : ''}
    </div>`;
  }).join('');
  return `<div class="list" style="margin-top:6px">${rows}</div>`;
}

export async function renderDispatcher(container, context) {
  const { state, can } = context;
  const data = state.data;
  const canAct = can('trip-status:write');
  // Статус отслеживания «опоздание»: расчётная задержка по стоянкам контроля
  // (план + накопленное отставание; для идущих — не раньше «сейчас»).
  let delayByTrip = new Map();
  let controlByTrip = new Map();
  try {
    const { items } = await api('/api/control');
    delayByTrip = new Map(items.map(item => [item.id, item.delay_ms || 0]));
    controlByTrip = new Map(items.map(item => [item.id, item]));
  } catch { /* без расчёта задержек карточки просто не показывают опоздание */ }
  // Отметки «событие отработано»: общие для смены, ключ привязан к конкретному
  // событию рейса — сменилось событие, отметка сама теряет силу.
  const todayIso = new Date().toISOString().slice(0, 10);
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let workedMap = new Map();
  try {
    const days = await Promise.all([
      api(`/api/task-marks?kind=dispatcher&day=${todayIso}`),
      api(`/api/task-marks?kind=dispatcher&day=${yesterdayIso}`)
    ]);
    workedMap = new Map(days.flatMap(result => result.items)
      .map(item => [item.item_key, item]));
  } catch { workedMap = new Map(); }
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
  const online = data.trips.filter(trip => (trip.status === 'run' ||
    (trip.status === 'unloaded' && !trip.docs_checked_at &&
      Date.now() - Date.parse(String(trip.unloaded_at || trip.ends_at).replace(' ', 'T') +
        (String(trip.unloaded_at || trip.ends_at).includes('Z') ? '' : 'Z')) < 72 * 3_600_000)) &&
    matches(trip));
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
  const DOCS_NORM_MS = 2 * 3_600_000;
  const nextControlEvent = trip => {
    // После выгрузки рейс остаётся на контроле до проверки документов
    // (фото, без печатей и актов): норматив 2 часа, дальше — сбой ежечасно.
    if (trip.status === 'unloaded') {
      const at = (Number.isFinite(tsRaw(trip.unloaded_at)) ? tsRaw(trip.unloaded_at) : Date.now()) + DOCS_NORM_MS;
      return { at, label: `📄 документы: ${trip.customer_name || 'клиент'}`,
        point: trip.to_point || trip.to_name, zone: trip.to_name, docsStep: true };
    }
    if (isStuck(trip)) {
      return { at: 0, label: '🚨 не выгружают — вмешаться',
        point: trip.to_point || trip.to_name, zone: trip.to_name };
    }
    const stops = controlByTrip.get(trip.id)?.stops || [];
    for (const stop of stops) {
      if (stop.actual_departure) continue;
      const point = stop.point || trip.to_name;
      // Этапность словами конвейера: первая точка — погрузка, последняя —
      // выгрузка, между ними промежуточные и контроль в пути.
      const isFirst = stop === stops[0];
      const isLast = stop === stops[stops.length - 1];
      const stage = isFirst ? { arr: 'Прибыл на погрузку', start: 'Погрузка начата',
          done: 'Загружен', dep: 'Выехал с погрузки' }
        : isLast ? { arr: 'Прибыл на выгрузку', start: 'Выгрузка начата', done: 'Выгружен', dep: 'Убыл' }
        : { arr: 'Прибыл', start: 'Начало работ', done: 'Работы завершены', dep: 'Убыл' };
      if (!stop.actual_arrival) {
        const candidates = [stop.estimated_arrival,
          Date.parse(stop.planned_arrival || ''), Date.parse(trip.ends_at)];
        const at = candidates.find(Number.isFinite) ?? Date.now();
        return { at, label: `${isFirst ? 'в пути на погрузку' : isLast ? 'в пути на выгрузку' : 'прибытие'}: ${point}`,
          point, zone: trip.to_name,
          stopId: stop.id, stepField: 'actualArrival', stepLabel: stage.arr };
      }
      if (!stop.work_finished_at) {
        return { at: Date.parse(stop.actual_arrival) + normOpMs,
          label: `${stop.kind === 'P' ? 'погрузка' : 'выгрузка'}: ${point}`, point, zone: trip.to_name,
          stopId: stop.id,
          stepField: stop.work_started_at ? 'workFinishedAt' : 'workStartedAt',
          stepLabel: stop.work_started_at ? stage.done : stage.start };
      }
      return { at: Date.parse(stop.work_finished_at), label: `убытие: ${point}`, point, zone: trip.to_name,
        stopId: stop.id, stepField: 'actualDeparture', stepLabel: stage.dep };
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
  const myName = state.data.user.fullName || '';
  const eventKeyOf = trip => {
    const event = nextControlEvent(trip);
    // Сбой на точке (событие просрочено) требует контроля каждый час:
    // номер часа просрочки входит в ключ — отметка «отработано» протухает
    // с началом следующего часа, карточка снова загорается.
    let overdueHour = -1;
    if (event.at === 0) overdueHour = Math.floor(stuckMsOf(trip) / 3_600_000);
    else if (Number.isFinite(event.at) && event.at < Date.now()) {
      overdueHour = Math.floor((Date.now() - event.at) / 3_600_000);
    }
    return `${trip.id}|${event.label}|${Number.isFinite(event.at) ? Math.round(event.at / 60_000) : 0}` +
      `${overdueHour >= 0 ? `|h${overdueHour}` : ''}`.slice(0, 200);
  };
  const workedOf = trip => workedMap.get(eventKeyOf(trip)) || null;
  // Последний комментарий контролёра по рейсу (за сегодня-вчера) — даже если
  // событие уже сменилось: отметка «✓ отработано» привязана к конкретному
  // событию и с новым шагом карточка возвращается в очередь, но контекст
  // прошлого звонка терять нельзя.
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
  const eventAt = trip => Number.isFinite(nextControlEvent(trip).at) ? nextControlEvent(trip).at : Infinity;
  online.sort((a, b) => Number(!!workedOf(a)) - Number(!!workedOf(b)) || eventAt(a) - eventAt(b));

  // Заявка рейса — источник комментария продаж и «без НДС».
  const orderOf = trip => (data.orders || []).find(item => item.id === trip.order_id)
    || (data.orders || []).find(item => item.trip_id === trip.id) || null;

  // Полная карточка рейса: всё, что нужно для внесения в учётную систему, —
  // одним текстом с кнопкой копирования.
  const tripCardText = trip => {
    const order = orderOf(trip);
    let via = [];
    try { via = JSON.parse(order?.via_json || '[]') || []; } catch { via = []; }
    const lines = [
      `№ заказа: ${trip.order_no || order?.order_no || '—'}`,
      `Маршрут: ${routeLabel(trip)}`,
      `Заказчик: ${trip.customer_name || order?.customer_name || '—'}`,
      `Погрузка: ${trip.from_point || trip.from_name} · ${formatDateTime(trip.starts_at)}`,
      via.length ? `Промежуточные: ${via.map(item =>
        `${item.kind === 'P' ? '⬆' : '⬇'} ${item.point}`).join(', ')}` : '',
      `Выгрузка: ${trip.to_point || trip.to_name} · ${formatDateTime(trip.ends_at)}`,
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
      <small class="muted" style="display:block">${escapeHtml(routeLabel(trip))}
        · ${escapeHtml(trip.customer_name || 'без заказчика')}
        · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}${trip.empty_km
          ? ` · +${Math.round(trip.empty_km)} км порож.` : ''} · ${money(trip.revenue_vat)}</small>
      ${Number(trip.cash) ? `<small class="cash-note">💵 За наличные: укажите в задании водителю —
        после выгрузки забрать ${money(trip.revenue_vat)} у клиента</small>` : ''}
    </span>`;

  const prepStepOf = trip => !trip.entered_1c_at ? ['1c', 'внести заказ в 1С']
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
    return { hot,
      html: `<small class="next-ctrl ${overdue ? 'overdue' : ''}">⏱ ${escapeHtml(label)} —
        выход ${formatDateTime(trip.starts_at)}${overdue ? ' · время вышло' : ''}
        ${hot && !overdue ? '<span class="ctrl-soon">🔥 менее 2 ч</span>' : ''}
        ${claim ? `<span class="ctrl-claim-note">🖐 ${claimMine ? 'вы ведёте' : `у ${escapeHtml(claim.done_by)}`}</span>` : ''}
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
  const prepCard = trip => {
    const event = prepEventLine(trip, prepStepOf(trip)[1]);
    return `<div class="card ${event.hot ? 'ctrl-hot' : ''}"
        style="margin-bottom:10px;padding:10px 12px">
      <div class="list-item" style="padding:0 0 4px">
        ${tripHead(trip)}
        <button class="button ghost small" data-incident="${trip.id}" title="Поломка, отказ клиента, переназначение">⚠ Внештатная</button>
      </div>
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
    ${canAct ? (() => {
      const closable = stalePrep.filter(trip => trip.ends_at < new Date().toISOString());
      return closable.length ? `<button class="button small" id="staleCloseAll"
        title="Каждый рейс станет «Выгружен» фактом планового времени, документы — «получены»: карточки уйдут из подготовки и не всплывут в контроле">✅ Закрыть всё как выполненное (${closable.length})</button>` : '';
    })() : ''}
    ${stalePrep.map(prepCard).join('')}
  </details>` : '';

  const waitSorted = [...waitingLogist].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const waitCards = waitSorted.map(trip => {
    const event = prepEventLine(trip, 'напомнить логисту о подтверждении');
    return `<div class="card ${event.hot ? 'ctrl-hot' : ''}" style="padding:9px 11px">
      <div class="list-item ordrow pipe-wait" style="border:0;padding:0">
        ${tripHead(trip)}
        <span class="pipe-badge">Ждёт: Логист · подтверждение назначения</span>
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
  // Стоянка с фактом убытия пройдена: пропущенные отметки дозаполняются через ✎.
  const nextStopStep = stop => stop.actual_departure ? null
    : !stop.actual_arrival ? ['Прибыл', 'actualArrival']
    : !stop.work_started_at ? ['Начало работ', 'workStartedAt']
    : !stop.work_finished_at ? ['Работы завершены', 'workFinishedAt']
    : ['Убыл', 'actualDeparture'];
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

  const onlineCards = online.map(trip => {
    const delay = delayByTrip.get(trip.id) || 0;
    const stuck = isStuck(trip);
    const late = !trip.arrived_at && delay > LATE_MS;
    // До факта прибытия рейс «в пути» (затянувшийся — опоздание, уведомление
    // продаж). «Прибыл на выгрузку» начинает отсчёт выгрузки: свыше 6 часов —
    // «не выгружают», особый контроль и выставление простоя клиенту.
    let statusBlock;
    if (trip.status === 'unloaded') {
      statusBlock = `<span class="badge warn" title="Рейс выгружен ${formatDateTime(trip.unloaded_at || trip.ends_at)} —
        остаётся на контроле до проверки фото документов (без печатей и актов)">📄 выгружен · документы не проверены</span>`;
    } else if (stuck) {
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
        ? ` · ⏳ сбой ${overdueHours >= 1 ? `${overdueHours} ч` : '< 1 ч'} — контроль каждый час` : ''}
      ${hot && !overdue && nextEvent.at !== 0 ? '<span class="ctrl-soon">🔥 менее 2 ч</span>' : ''}
      ${claim ? `<span class="ctrl-claim-note">🖐 ${claimMine ? 'вы ведёте' : `у ${escapeHtml(claim.done_by)}`}</span>` : ''}
      ${worked ? `<span class="ctrl-worked-note" ${worked.note ? `title="${escapeHtml(worked.note)}"` : ''}>✓ отработано
        · ${escapeHtml(worked.done_by || '')}${worked.note ? ` — «${escapeHtml(String(worked.note).slice(0, 60))}»` : ''}</span>` : ''}
      ${(() => { const last = lastNoteOf(trip);
        return !worked && last ? `<span class="ctrl-last-note" title="${escapeHtml(last.note)}">💬 прошлый контроль
          · ${escapeHtml(last.done_by || '')} — «${escapeHtml(String(last.note).slice(0, 60))}»</span>` : ''; })()}
      ${canAct && nextEvent.docsStep && !worked ? `<button class="button small ctrl-quick"
        data-docs="${trip.id}" title="Фото документов получены и проверены (без печатей и актов) — рейс уйдёт с контроля">✔ Документы получены</button>` : ''}
      ${canAct && nextEvent.stopId && !worked ? `<button class="button small ctrl-quick"
        data-quick-stop="${nextEvent.stopId}" data-quick-field="${nextEvent.stepField}"
        data-quick-label="${escapeHtml(nextEvent.stepLabel)}"
        title="Отметить факт «${escapeHtml(nextEvent.stepLabel)}» без открытия ленты точек">✔ ${escapeHtml(nextEvent.stepLabel)}</button>` : ''}
      ${canAct && !worked ? `<button class="button ghost small ctrl-worked-btn" data-claim="${trip.id}"
        title="${claimMine ? 'Отпустить карточку' : claim ? `Карточку ведёт ${escapeHtml(claim.done_by)} — перехватить`
          : 'Взять карточку в работу: коллеги увидят, что вы уже звоните'}">${claimMine ? '🖐 Отпустить' : '🖐 Беру'}</button>` : ''}
      ${canAct ? `<button class="button ghost small ctrl-worked-btn" data-worked="${escapeHtml(eventKeyOf(trip))}"
        ${worked ? '' : `data-worked-label="${escapeHtml(nextEvent.label)}" data-worked-trip="${trip.id}"`}
        title="${worked ? 'Снять отметку — событие вернётся в горящие' : 'Событие отработано — обязателен комментарий, карточка уйдёт вниз до следующего события'}">${worked ? '↩' : '✓ Отработано'}</button>` : ''}</small>`;
    return `<div class="card ${hot ? 'ctrl-hot' : ''} ${worked ? 'ctrl-done' : ''}" style="padding:9px 11px">
      <div class="list-item ordrow ${stuck ? 'pipe-rejected' : late ? 'pipe-returned' : ''}" style="border:0;padding:0">
      ${tripHead(trip)}
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        ${statusBlock}
        <span style="display:flex;gap:5px">
          <button class="button ghost small" data-stops-toggle="${trip.id}"
            title="Лента контрольных точек: прибытие, работы, убытие, простой">🧭 Точки${stopsCount ? ` (${stopsCount})` : ''}</button>
          <button class="button ghost small" data-incident="${trip.id}">⚠ Внештатная</button>
        </span>
      </span>
      </div>
      ${eventLine}
      ${opened ? `<div class="stops-inline">${stopsBlock(trip)}</div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">На линии никого нет.</p>';

  container.innerHTML = `<div class="saleswrap">
    ${!canAct ? `<div class="view-only">👁 Режим просмотра: отметки контроля доступны роли «Диспетчер».
      Если вы ведёте рейсы на линии — попросите администратора добавить вам роль
      в «Настройки → Пользователи».</div>` : ''}
    <div class="salekpis">
      <div class="skpi"><span class="skl">Ждут логиста</span><span class="skv">${waitingLogist.length}</span></div>
      <div class="skpi"><span class="skl">В подготовке</span><span class="skv">${preparing.length}</span></div>
      <div class="skpi"><span class="skl">На линии</span><span class="skv">${online.length}</span></div>
      <div class="salesfilter" style="flex:1;min-width:220px">
        <input id="dispatcherSearch" class="block-search" placeholder="Поиск: маршрут, ТС, водитель, заказчик"
          value="${escapeHtml(state.dispatcherQuery || '')}" style="flex:1">
      </div>
    </div>
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
        <div class="scolh">Контроль на линии <span>${online.length}</span></div>
        <div class="list">${onlineCards}</div>
        <div class="geohint">Внештатная ситуация: поломка (ремонт + пересадка или снятие),
          отказ клиента, переназначение ТС. Снятый рейс возвращает заявку в продажи.</div>
      </div>
    </div>
  </div>`;

  container.querySelectorAll('[data-worked]').forEach(button =>
    button.addEventListener('click', async () => {
      const key = button.dataset.worked;
      // Снятие отметки — сразу; постановка — с обязательным комментарием.
      if (!button.dataset.workedLabel) {
        try {
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key }) });
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
        <h2>💬 Заметка по подготовке</h2>
        <label class="field">Произвольный комментарий (видит вся смена; пусто — удалить)
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
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `prepnote|${tripId}` }) });
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
      try {
        const existing = workedMap.get(`claim|${tripId}`);
        await api('/api/task-marks', { method: 'POST',
          body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `claim|${tripId}` }) });
        if (existing && existing.done_by !== myName) {
          // Сняли чужой протухающий захват — сразу ставим свой.
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'dispatcher', day: todayIso, key: `claim|${tripId}` }) });
        }
        await renderDispatcher(container, context);
      } catch (error) { toast(error.message, 'error'); }
    }));
  // «✔ Шаг»: факт следующего события прямо с карточки — без ленты точек.
  container.querySelectorAll('[data-quick-stop]').forEach(button =>
    button.addEventListener('click', () => factDialog(
      `Контрольная точка · ${button.dataset.quickLabel}`,
      'Укажите фактическое время события на стоянке.', async iso => {
        await api(`/api/stops/${button.dataset.quickStop}`, {
          method: 'PATCH', body: JSON.stringify({ [button.dataset.quickField]: iso })
        });
        toast('Факт отмечен');
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
  // планового времени + «Документы получены». Рейсы с выгрузкой в будущем
  // не трогаются (машина может реально ехать — их выводят на линию).
  container.querySelector('#staleCloseAll')?.addEventListener('click', async event => {
    const nowIso = new Date().toISOString();
    const closable = preparing.filter(trip =>
      Date.now() - Date.parse(trip.starts_at) >= 24 * 3_600_000 && trip.ends_at < nowIso);
    if (!closable.length) return;
    if (!confirm(`Закрыть ${closable.length} рейс(ов) как выполненные задним числом?
`
      + 'Каждый станет «Выгружен» фактом планового времени, документы — «получены». '
      + 'Действие видно в аудите. Рейсы, чья выгрузка ещё впереди, не трогаются.')) return;
    event.currentTarget.disabled = true;
    let done = 0;
    for (const trip of closable) {
      try {
        await api(`/api/trips/${trip.id}`, { method: 'PATCH',
          body: JSON.stringify({ status: 'unloaded', factAt: trip.ends_at }) });
        await api(`/api/trips/${trip.id}/step`, { method: 'POST',
          body: JSON.stringify({ step: 'docs_checked', at: trip.ends_at }) });
        done += 1;
      } catch (error) { toast(`${trip.vehicle_plate || ''}: ${error.message}`, 'error'); }
    }
    toast(`Закрыто рейсов: ${done}`);
    await renderDispatcher(container, context);
  });
  attachSearch(container.querySelector('#dispatcherSearch'), async value => {
    state.dispatcherQuery = value;
    await renderDispatcher(container, context);
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
  container.querySelectorAll('[data-incident]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.incident);
      if (trip) incidentDialog(trip, data, context);
    }));
  container.querySelectorAll('[data-docs]').forEach(button =>
    button.addEventListener('click', () => factDialog('Документы получены',
      'Фото документов получены и проверены (без печатей и актов) — рейс уйдёт с контроля.', async iso => {
        await api(`/api/trips/${button.dataset.docs}/step`, {
          method: 'POST', body: JSON.stringify({ step: 'docs_checked', at: iso })
        });
        toast('Документы проверены — рейс закрыт на контроле');
      })));
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
        await api(`/api/stops/${button.dataset.stopStep}`, {
          method: 'PATCH', body: JSON.stringify({ [button.dataset.stopField]: iso })
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
