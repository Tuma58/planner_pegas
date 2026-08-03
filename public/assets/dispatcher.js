// Блок «Диспетчер» — построен заново вместо «Контроля».
// Конвейер после назначения ТС: заявка уходит на подтверждение логисту,
// затем диспетчер ведёт чек-лист выхода: 1) заказ внесён в учётную систему
// (1С временно работает отдельно от продукта), 2) задание водителю отправлено,
// 3) рейс переведён на контроль на линии (статус «В пути»).
// Внештатные ситуации: отказ клиента, поломка ТС (ремонт + переназначение),
// переназначение ТС — с возвратом заявки в продажи при снятии рейса.
import { api, escapeHtml, formatDateTime, money, routeLabel, toast } from './api.js';
import { waitingLabel } from './pipeline.js';
import { replaceVehicleDialog, rejectTripDialog } from './logist.js';

const LATE_MS = 30 * 60_000;

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
  try {
    const { items } = await api('/api/control');
    delayByTrip = new Map(items.map(item => [item.id, item.delay_ms || 0]));
  } catch { /* без расчёта задержек карточки просто не показывают опоздание */ }
  const query = (state.dispatcherQuery || '').toLowerCase();
  const matches = trip => !query ||
    `${routeLabel(trip)} ${trip.vehicle_plate} ${trip.driver_name || ''} ${trip.customer_name || ''}`
      .toLowerCase().includes(query);

  const planned = data.trips.filter(trip => trip.status === 'plan' && matches(trip))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const waitingLogist = planned.filter(trip => !trip.logist_confirmed_at);
  const preparing = planned.filter(trip => trip.logist_confirmed_at);
  const online = data.trips.filter(trip => trip.status === 'run' && matches(trip))
    .sort((a, b) => a.ends_at.localeCompare(b.ends_at));

  const tripHead = trip => `<span style="flex:1;min-width:0">
      <strong>${escapeHtml(routeLabel(trip))}</strong> · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
      <small class="muted" style="display:block">${escapeHtml(trip.driver_name || 'без водителя')}
        · ${escapeHtml(trip.customer_name || 'без заказчика')}
        · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)} · ${money(trip.revenue_vat)}</small>
    </span>`;

  const prepCards = preparing.map(trip => `<div class="card" style="margin-bottom:10px;padding:10px 12px">
      <div class="list-item" style="padding:0 0 4px">
        ${tripHead(trip)}
        <button class="button ghost small" data-incident="${trip.id}" title="Поломка, отказ клиента, переназначение">⚠ Внештатная</button>
      </div>
      ${checklistBlock(trip, canAct)}
    </div>`).join('') || '<p class="muted">Нет рейсов в подготовке — очередь чиста.</p>';

  const waitCards = waitingLogist.map(trip => `<div class="list-item ordrow pipe-wait">
      ${tripHead(trip)}
      <span class="pipe-badge">Ждёт: Логист · подтверждение назначения</span>
    </div>`).join('');

  const onlineCards = online.map(trip => {
    const delay = delayByTrip.get(trip.id) || 0;
    const late = delay > LATE_MS;
    // Опоздание: подсказка уведомить клиента; кнопка шлёт авто-сообщение
    // сотруднику продаж (тост + звук) — клиента предупреждают продажи.
    const lateBlock = late
      ? `<span class="badge bad" title="Расчётное прибытие позже плана — уведомите клиента о переносе">⏰ опоздание ${waitingLabel(delay)} · уведомите клиента</span>
        ${trip.delay_notified_at
          ? `<span class="badge warn" title="Авто-сообщение продажам отправлено">продажи уведомлены ${formatDateTime(trip.delay_notified_at)}</span>`
          : (canAct ? `<button class="button small danger" data-notify-delay="${trip.id}"
              title="Авто-сообщение сотруднику продаж: уведомить клиента о задержке">Уведомить продажи</button>` : '')}`
      : `<span class="badge ok">на линии${trip.on_line_at ? ` с ${formatDateTime(trip.on_line_at)}` : ''}</span>`;
    return `<div class="list-item ordrow ${late ? 'pipe-returned' : ''}">
      ${tripHead(trip)}
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        ${lateBlock}
        <span style="display:flex;gap:5px">
          ${canAct ? `<button class="button small" data-unload="${trip.id}" title="Груз выгружен — конвейер уйдёт бухгалтерии">Выгружен</button>` : ''}
          <button class="button ghost small" data-incident="${trip.id}">⚠ Внештатная</button>
        </span>
      </span>
    </div>`;
  }).join('') || '<p class="muted">На линии никого нет.</p>';

  container.innerHTML = `<div class="saleswrap">
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

  const search = container.querySelector('#dispatcherSearch');
  search.oninput = () => {
    state.dispatcherQuery = search.value;
    const caret = search.selectionStart;
    renderDispatcher(container, context);
    const again = container.querySelector('#dispatcherSearch');
    again.focus();
    again.setSelectionRange(caret, caret);
  };

  container.querySelectorAll('[data-step]').forEach(button =>
    button.addEventListener('click', () => runStep(button.dataset.trip, button.dataset.step, context.onReload)));
  container.querySelectorAll('[data-incident]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = data.trips.find(item => item.id === button.dataset.incident);
      if (trip) incidentDialog(trip, data, context);
    }));
  container.querySelectorAll('[data-unload]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/trips/${button.dataset.unload}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'unloaded' })
        });
        toast('Выгрузка отмечена — конвейер передан бухгалтерии');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
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
}
