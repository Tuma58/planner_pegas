// Блок «Диспетчер» — построен заново вместо «Контроля».
// Конвейер после назначения ТС: заявка уходит на подтверждение логисту,
// затем диспетчер ведёт чек-лист выхода: 1) заказ внесён в учётную систему
// (1С временно работает отдельно от продукта), 2) задание водителю отправлено,
// 3) рейс переведён на контроль на линии (статус «В пути»).
// Внештатные ситуации: отказ клиента, поломка ТС (ремонт + переназначение),
// переназначение ТС — с возвратом заявки в продажи при снятии рейса.
import { api, attachSearch, escapeHtml, formValues, formatDateTime, money, routeLabel, toLocalInput, toast } from './api.js';
import { orderNet, resolveAddress } from './sales.js';
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
  const isStuck = trip => stuckMsOf(trip) > UNLOAD_STUCK_MS;
  // Особый контроль (не выгружают) — наверху списка линии.
  const online = data.trips.filter(trip => trip.status === 'run' && matches(trip));

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
      if (!stop.actual_arrival) {
        const candidates = [stop.estimated_arrival,
          Date.parse(stop.planned_arrival || ''), Date.parse(trip.ends_at)];
        const at = candidates.find(Number.isFinite) ?? Date.now();
        return { at, label: `прибытие: ${point}`, point, zone: trip.to_name };
      }
      if (!stop.work_finished_at) {
        return { at: Date.parse(stop.actual_arrival) + normOpMs,
          label: `${stop.kind === 'P' ? 'погрузка' : 'выгрузка'}: ${point}`, point, zone: trip.to_name };
      }
      return { at: Date.parse(stop.work_finished_at), label: `убытие: ${point}`, point, zone: trip.to_name };
    }
    return { at: Date.parse(trip.ends_at), label: 'завершение рейса',
      point: trip.to_point || trip.to_name, zone: trip.to_name };
  };

  // Ближайшее событие — наверх: просроченные и «не выгружают» первыми.
  online.sort((a, b) => (Number.isFinite(nextControlEvent(a).at) ? nextControlEvent(a).at : Infinity) -
    (Number.isFinite(nextControlEvent(b).at) ? nextControlEvent(b).at : Infinity));

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
    context.showModal(`<h2>Карточка рейса</h2>
      <p class="muted" style="margin:0 0 8px">Полные данные для учётной системы —
        «Скопировать всё» или выделите нужные строки.</p>
      <textarea id="tripCardText" readonly rows="${Math.min(16, text.split('\n').length + 1)}"
        style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre">${escapeHtml(text)}</textarea>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="button" id="tripCardCopy">📋 Скопировать всё</button>
        <button class="button ghost" id="tripCardClose">Закрыть</button>
      </div>`);
    const area = document.getElementById('tripCardText');
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
  };

  const tripHead = trip => `<span style="flex:1;min-width:0;cursor:pointer" data-trip-card="${trip.id}"
      title="Клик — карточка рейса: полные данные с копированием">
      <strong>${escapeHtml(routeLabel(trip))}</strong> · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      ${Number(trip.cash) ? '<span class="cash-badge">💵 наличные</span>' : ''}
      <small class="muted" style="display:block">${escapeHtml(trip.driver_name || 'без водителя')}
        · ${escapeHtml(trip.customer_name || 'без заказчика')}
        · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}${trip.empty_km
          ? ` · +${Math.round(trip.empty_km)} км порож.` : ''} · ${money(trip.revenue_vat)}</small>
      ${Number(trip.cash) ? `<small class="cash-note">💵 За наличные: укажите в задании водителю —
        после выгрузки забрать ${money(trip.revenue_vat)} у клиента</small>` : ''}
    </span>`;

  const salesCommentNote = trip => {
    const comment = orderOf(trip)?.comment;
    return comment ? `<small class="sales-comment">💬 Продажи: ${escapeHtml(comment)}</small>` : '';
  };
  const prepCards = preparing.map(trip => `<div class="card" style="margin-bottom:10px;padding:10px 12px">
      <div class="list-item" style="padding:0 0 4px">
        ${tripHead(trip)}
        <button class="button ghost small" data-incident="${trip.id}" title="Поломка, отказ клиента, переназначение">⚠ Внештатная</button>
      </div>
      ${salesCommentNote(trip)}
      ${checklistBlock(trip, canAct)}
    </div>`).join('') || '<p class="muted">Нет рейсов в подготовке — очередь чиста.</p>';

  const waitCards = waitingLogist.map(trip => `<div class="list-item ordrow pipe-wait">
      ${tripHead(trip)}
      <span class="pipe-badge">Ждёт: Логист · подтверждение назначения</span>
    </div>`).join('');

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
    const eventLine = `<small class="next-ctrl ${overdue || nextEvent.at === 0 ? 'overdue' : ''}">⏱ далее —
      ${escapeHtml(nextEvent.label)}${hasTime ? ` · ${formatDateTime(new Date(nextEvent.at).toISOString())}
      ${localNote(nextEvent.at, nextEvent.point, nextEvent.zone)}` : ''}${overdue ? ' · просрочено' : ''}</small>`;
    return `<div class="card" style="padding:9px 11px">
      <div class="list-item ordrow ${stuck ? 'pipe-rejected' : late ? 'pipe-returned' : ''}" style="border:0;padding:0">
      ${tripHead(trip)}
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        ${statusBlock}
        <span style="display:flex;gap:5px">
          <button class="button ghost small" data-stops-toggle="${trip.id}"
            title="Лента контрольных точек: прибытие, работы, убытие, простой">🧭 Точки${stopsCount ? ` (${stopsCount})` : ''}</button>
          ${canAct && !trip.arrived_at ? `<button class="button ghost small" data-arrived="${trip.id}"
            title="ТС встало под выгрузку — с этого момента отсчитываются выгрузка и простой">Прибыл на выгрузку</button>` : ''}
          ${canAct ? `<button class="button small" data-unload="${trip.id}" title="Груз выгружен — конвейер уйдёт бухгалтерии">Выгружен</button>` : ''}
          <button class="button ghost small" data-incident="${trip.id}">⚠ Внештатная</button>
        </span>
      </span>
      </div>
      ${eventLine}
      ${opened ? stopsBlock(trip) : ''}
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

  // Клик по плашке рейса — карточка с полными данными и копированием;
  // клики по кнопкам внутри строки карточку не открывают.
  container.querySelectorAll('[data-trip-card]').forEach(head =>
    head.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      const trip = data.trips.find(item => item.id === head.dataset.tripCard);
      if (trip) tripCardDialog(trip);
    }));

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
  container.querySelectorAll('[data-unload]').forEach(button =>
    button.addEventListener('click', () => factDialog('Факт выгрузки',
      'Груз выгружен у клиента — конвейер уйдёт бухгалтерии.', async iso => {
        await api(`/api/trips/${button.dataset.unload}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'unloaded', factAt: iso })
        });
        toast('Выгрузка отмечена — конвейер передан бухгалтерии');
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
      state.dispatcherStops = state.dispatcherStops === button.dataset.stopsToggle
        ? null : button.dataset.stopsToggle;
      renderDispatcher(container, context);
    }));
  container.querySelectorAll('[data-stop-step]').forEach(button =>
    button.addEventListener('click', () => factDialog(`Контрольная точка · ${button.textContent.trim()}`,
      'Укажите фактическое время события на стоянке.', async iso => {
        await api(`/api/stops/${button.dataset.stopStep}`, {
          method: 'PATCH', body: JSON.stringify({ [button.dataset.stopField]: iso })
        });
        toast('Факт отмечен');
      })));
  container.querySelectorAll('[data-stop-edit]').forEach(button =>
    button.addEventListener('click', () => {
      const control = controlByTrip.get(button.dataset.stopTrip);
      const stop = control?.stops?.find(item => item.id === button.dataset.stopEdit);
      if (stop) stopEditDialog(stop);
    }));
  container.querySelectorAll('[data-stop-add]').forEach(button =>
    button.addEventListener('click', () => stopAddDialog(button.dataset.stopAdd)));
  container.querySelectorAll('[data-arrived]').forEach(button =>
    button.addEventListener('click', () => factDialog('Факт прибытия на выгрузку',
      'От этого времени считаются выгрузка и простой у клиента.', async iso => {
        await api(`/api/trips/${button.dataset.arrived}/arrived`, {
          method: 'POST', body: JSON.stringify({ at: iso })
        });
        toast('Прибытие отмечено — пошёл отсчёт выгрузки');
      })));
  container.querySelectorAll('[data-demurrage]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.demurrage);
      if (trip) demurrageDialog(trip, data, context, stuckMsOf(trip));
    }));
}
