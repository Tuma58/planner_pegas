// ── Вкладка «⚠ Внештатки» — этап 1 (заявка Базуева из HELP DESK) ──
// Три колонки по типам: акты на выгрузке, возвраты продукции,
// опоздания. Ручные инциденты заводит диспетчер из меню внештатной
// ситуации в карточке рейса; опоздания с отметками попадают сюда
// автоматически из trip_stops. Цепочка статусов возврата и склады
// LTL — этап 2 (docs/returns-plan.md).
import { api, escapeHtml, formatDateTime, renderInto, toast } from './api.js';

const KIND_META = {
  act: ['📋 Акты на выгрузке', 'составлен акт — расхождение, бой, недостача'],
  return: ['↩ Возвраты продукции', 'груз едет назад — паллеты и коробки под контролем'],
  late: ['⏰ Опоздания', 'ручные + автоматически из отметок прибытия']
};

// Э2: цепочка статусов возврата — решение × где лежит (склад LTL).
const RETURN_LABELS = {
  open: ['🚚 возврат загрузили', ''],
  wait_decision: ['⏳ ждём решения клиента', 'warn'],
  returned: ['✅ возврат осуществлён', 'ok'],
  utilized: ['🗑 утилизация', '']
};

export async function renderIncidents(container, context) {
  const { state, can } = context;
  const today = new Date();
  const iso = date => date.toISOString().slice(0, 10);
  state.incFrom ||= iso(new Date(Date.now() - 30 * 86_400_000));
  state.incTo ||= iso(today);
  let data = { manual: [], autoLate: [] };
  try {
    data = await api(`/api/incidents?from=${state.incFrom}&to=${state.incTo}`);
  } catch (error) {
    container.innerHTML = `<p class="muted" style="padding:16px">${escapeHtml(error.message)}</p>`;
    return;
  }
  const showClosed = Boolean(state.incClosed);
  const manual = data.manual.filter(item => showClosed || !item.closed_at);
  const canAct = can('trip-status:write');
  const myRoles = state.data.user.roles || [state.data.user.role];
  const canManageWh = myRoles.some(role => ['manager', 'admin'].includes(role));
  const tsf = value => formatDateTime(String(value).includes('Z')
    ? value : String(value).replace(' ', 'T') + 'Z');

  const card = item => {
    const isReturn = item.kind === 'return';
    const [statusLabel, statusTone] = isReturn ? (RETURN_LABELS[item.status] || RETURN_LABELS.open) : ['', ''];
    return `<div class="kb-card ${item.closed_at ? 'inc-closed' : ''}">
      <div class="kbr kb1"><b class="mono">${escapeHtml(item.vehicle_plate)}</b>
        <span class="kb-drv">${item.order_no ? `№ ${escapeHtml(String(item.order_no))}` : ''}</span></div>
      <div class="kbr kb2">${escapeHtml((item.customer_name || '').slice(0, 34))}</div>
      <div class="kbr kb3">${escapeHtml((item.from_point || '').slice(0, 20))} → ${escapeHtml((item.to_point || '').slice(0, 20))}</div>
      ${item.qty ? `<div class="kbr"><b>${escapeHtml(item.qty)}</b></div>` : ''}
      ${isReturn ? `<div class="kbr"><span class="badge ${statusTone}">${statusLabel}</span>
        <small class="muted">${item.warehouse ? `📍 ${escapeHtml(item.warehouse)}` : item.closed_at ? '' : '📍 на борту'}</small></div>` : ''}
      ${item.comment ? `<div class="kbr inc-note inc-note-multi">${escapeHtml(item.comment)}</div>` : ''}
      <div class="kbr"><small class="muted">${escapeHtml(item.created_by_name)} · ${tsf(item.created_at)}</small>
        ${canAct && !item.closed_at ? `<button class="chat-act" data-inc-comment="${item.id}"
          title="Дописать комментарий — текст добавится с вашим именем">💬</button>` : ''}</div>
      ${item.closed_at ? `<div class="kbr inc-note">✓ ${escapeHtml(item.resolution)}
        <small class="muted">· ${escapeHtml(item.closed_by_name)} · ${tsf(item.closed_at)}</small></div>`
    : canAct && isReturn ? `<div class="kb-btns inc-ret-btns">
        ${item.status !== 'wait_decision' ? `<button class="button ghost small" data-inc-ret="wait_decision" data-inc-id="${item.id}" title="Решение за клиентом — сторож напомнит планированию, если зависнет">⏳ Ждём решения</button>` : ''}
        <button class="button ghost small" data-inc-wh="${item.id}" title="Груз выгружен на склад LTL — выбрать из справочника">📦 На склад…</button>
        <button class="button ghost small" data-inc-ret="returned" data-inc-id="${item.id}" title="Груз вернулся клиенту/получателю — в архив с итогом">✅ Осуществлён</button>
        <button class="button ghost small" data-inc-ret="utilized" data-inc-id="${item.id}" title="Груз утилизирован — в архив с итогом">🗑 Утилизация</button>
      </div>`
    : canAct ? `<div class="kb-btns"><button class="button ghost small" data-inc-close="${item.id}">✓ Закрыть с итогом</button></div>` : ''}
    </div>`;
  };

  // BI-вид 04.11: опоздания из отметок — строки таблицы .bi-table
  // (их десятки, карточка на каждое съедала колонку).
  const lateRow = item => `<tr class="inc-auto-row">
      <td><b class="mono">${escapeHtml(item.vehicle_plate)}</b></td>
      <td class="num">${item.order_no ? escapeHtml(String(item.order_no)) : ''}</td>
      <td>${escapeHtml((item.customer_name || '').slice(0, 34))}</td>
      <td>${item.stop_kind === 'P' ? 'погрузка' : 'выгрузка'} · ${escapeHtml((item.point || '').slice(0, 34))}</td>
      <td class="num inc-late-h">+${item.late_hours} ч</td>
      <td class="num">${tsf(item.planned_arrival)}</td>
      <td class="num">${tsf(item.actual_arrival)}</td>
    </tr>`;

  const columns = [
    ['act', manual.filter(item => item.kind === 'act').map(card)],
    ['return', manual.filter(item => item.kind === 'return').map(card)],
    ['late', [...manual.filter(item => item.kind === 'late').map(card),
      ...(data.autoLateTotal > data.autoLate.length
        ? [`<p class="muted" style="padding:4px 8px">Всего опозданий из отметок за период: ${data.autoLateTotal} — показаны ${data.autoLate.length} крупнейших. Полная картина — в отчётах руководителя.</p>`]
        : []),
      ]]
  ];
  const openOf = kind => data.manual.filter(item => item.kind === kind && !item.closed_at);
  const waitDecision = openOf('return').filter(item => item.status === 'wait_decision').length;

  const html = `<div class="inc-page bi-page disp-bi">
    <div class="resctl bi-sub">
      <label class="muted">с <input type="date" id="incFrom" value="${state.incFrom}"></label>
      <label class="muted">по <input type="date" id="incTo" value="${state.incTo}"></label>
      <label class="muted" title="Закрытые акты и возвраты — история решений">
        <input type="checkbox" id="incClosed" ${showClosed ? 'checked' : ''}> показать закрытые</label>
      ${canManageWh ? `<button class="button ghost small" id="incWarehouses"
        title="Справочник складов LTL: названия, адреса, телефоны — для статуса «на складе»">🏬 Склады LTL</button>` : ''}
      <p>Завести внештатку: Диспетчер → карточка рейса → «⋯ Внештатная ситуация» → Акт / Возврат / Опоздание</p>
    </div>
    <div class="bi-kpis bi-kpis-row disp-kpis">
      <div class="metric ${openOf('act').length ? 'warn' : 'dept-drv'}"><span class="l">📋 Акты открыты</span>
        <span class="v">${openOf('act').length}</span><span class="d">за период · ждут итога</span></div>
      <div class="metric ${openOf('return').length ? 'warn' : 'dept-drv'}"><span class="l">↩ Возвраты в работе</span>
        <span class="v">${openOf('return').length}</span><span class="d">ждут решения клиента: ${waitDecision}</span></div>
      <div class="metric ${waitDecision ? 'neg' : 'dept-drv'}"><span class="l">⏳ Ждут решения</span>
        <span class="v">${waitDecision}</span><span class="d">возвраты без решения</span></div>
      <div class="metric ${data.autoLateTotal || data.autoLate.length ? 'neg' : 'pos'}"><span class="l">⏰ Опоздания из отметок</span>
        <span class="v">${data.autoLateTotal || data.autoLate.length}</span><span class="d">ручных открыто: ${openOf('late').length}</span></div>
    </div>
    <div class="kb-board">
      ${columns.map(([kind, cards]) => `<section class="kb-col section">
        <div class="kb-chead sec-h"><span class="st">${KIND_META[kind][0]}</span><span class="kb-lim bi-tag">${cards.length}</span></div>
        <div class="kb-note">${KIND_META[kind][1]}</div>
        <div class="kb-cards">${cards.join('') || '<p class="bi-empty">Пусто — и хорошо.</p>'}</div>
      </section>`).join('')}
    </div>
    ${data.autoLate.length ? `<section class="section inc-late-sec">
      <div class="sec-h"><span class="st">⏰ Опоздания из отметок прибытия</span>
        <span class="bi-tag neg">${data.autoLate.length}${data.autoLateTotal > data.autoLate.length ? ` из ${data.autoLateTotal}` : ''}</span>
        <span class="hint">⚙ созданы автоматически — факты не закрываются, они уже случились</span></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table">
        <thead><tr><th>ТС</th><th class="r">№</th><th>Заказчик</th><th>Точка</th><th class="r">Опоздание</th>
          <th class="r">План</th><th class="r">Факт</th></tr></thead>
        <tbody>${data.autoLate.map(lateRow).join('')}</tbody></table></div>
    </section>` : ''}
  </div>`;
  if (!renderInto(container, html)) return;

  container.querySelector('#incFrom').addEventListener('change', event => {
    state.incFrom = event.target.value; renderIncidents(container, context);
  });
  container.querySelector('#incTo').addEventListener('change', event => {
    state.incTo = event.target.value; renderIncidents(container, context);
  });
  container.querySelector('#incClosed').addEventListener('change', event => {
    state.incClosed = event.target.checked; renderIncidents(container, context);
  });
  // Дописываемый комментарий (заявка Петрова, 12.11): добавляется строкой
  // с именем и датой — история общения по внештатке живёт на карточке.
  container.querySelectorAll('[data-inc-comment]').forEach(button =>
    button.addEventListener('click', async () => {
      const text = (prompt('Комментарий к внештатке (добавится с вашим именем):') || '').trim();
      if (!text) return;
      try {
        await api(`/api/incidents/${button.dataset.incComment}/comment`,
          { method: 'POST', body: JSON.stringify({ text }) });
        toast('Комментарий добавлен');
        renderIncidents(container, context);
      } catch (error) { toast(error.message, 'error'); }
    }));

  container.querySelectorAll('[data-inc-close]').forEach(button =>
    button.addEventListener('click', async () => {
      const resolution = (prompt('Итог: что решили и чем кончилось (обязательно):') || '').trim();
      if (!resolution) return;
      try {
        await api(`/api/incidents/${button.dataset.incClose}/close`,
          { method: 'POST', body: JSON.stringify({ resolution }) });
        toast('Внештатка закрыта');
        renderIncidents(container, context);
      } catch (error) { toast(error.message, 'error'); }
    }));

  // Э2: смена статуса возврата — терминальные с итогом, склад из справочника.
  const setReturnStatus = async (id, status, warehouse = '') => {
    let resolution = '';
    if (status === 'returned' || status === 'utilized') {
      resolution = (prompt('Итог (обязательно): куда делся груз, кто подтвердил:') || '').trim();
      if (!resolution) return;
    }
    try {
      await api(`/api/incidents/${id}/status`,
        { method: 'POST', body: JSON.stringify({ status, warehouse, resolution }) });
      toast('Статус возврата обновлён');
      renderIncidents(container, context);
    } catch (error) { toast(error.message, 'error'); }
  };
  container.querySelectorAll('[data-inc-ret]').forEach(button =>
    button.addEventListener('click', () =>
      setReturnStatus(button.dataset.incId, button.dataset.incRet)));
  container.querySelectorAll('[data-inc-wh]').forEach(button =>
    button.addEventListener('click', async () => {
      const incident = data.manual.find(item => item.id === button.dataset.incWh);
      let warehouses = [];
      try { warehouses = (await api('/api/warehouses')).items.filter(item => item.active); }
      catch (error) { toast(error.message, 'error'); return; }
      if (!warehouses.length) { toast('Справочник складов пуст — добавьте склад кнопкой «🏬 Склады LTL»', 'error'); return; }
      context.showModal(`<h2>📦 Возврат на склад</h2>
        <p class="muted">Груз выгружен на склад LTL — статус останется «${escapeHtml((RETURN_LABELS[incident?.status]?.[0] || '').replace(/^\S+ /, ''))}», место изменится.</p>
        <div class="list" style="max-height:320px;overflow:auto">
          ${warehouses.map(item => `<button type="button" class="list-item" data-wh-pick="${escapeHtml(item.name)}">
            <span><strong>${escapeHtml(item.name)}</strong>
            <small class="muted" style="display:block">${escapeHtml(item.address)}${item.phone ? ` · ${escapeHtml(item.phone)}` : ''}${item.contact ? ` · ${escapeHtml(item.contact)}` : ''}</small></span>
          </button>`).join('')}
        </div>
        <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button></div>`);
      document.querySelectorAll('[data-wh-pick]').forEach(pick =>
        pick.addEventListener('click', () => {
          context.closeModal();
          setReturnStatus(button.dataset.incWh,
            incident?.status === 'wait_decision' ? 'wait_decision' : 'open', pick.dataset.whPick);
        }));
    }));

  // Справочник складов LTL — руководитель/админ, прямо со вкладки.
  const warehousesButton = container.querySelector('#incWarehouses');
  if (warehousesButton) {
    warehousesButton.onclick = async () => {
      let warehouses = [];
      try { warehouses = (await api('/api/warehouses')).items; }
      catch (error) { toast(error.message, 'error'); return; }
      context.showModal(`<h2>🏬 Склады LTL</h2>
        <p class="muted">Справочник для статуса «на складе»; выключенный склад уходит из выбора, история не трогается.</p>
        <div class="list" style="max-height:300px;overflow:auto">
          ${warehouses.map(item => `<div class="list-item" style="gap:8px">
            <span style="flex:1;min-width:0"><strong style="${item.active ? '' : 'opacity:.5'}">${escapeHtml(item.name)}</strong>
              <small class="muted" style="display:block">${escapeHtml(item.address)}${item.phone ? ` · ${escapeHtml(item.phone)}` : ''}${item.contact ? ` · ${escapeHtml(item.contact)}` : ''}</small></span>
            <button type="button" class="button ghost small" data-wh-toggle="${item.id}" data-wh-active="${item.active}">${item.active ? '⏸ Выключить' : '▶ Включить'}</button>
          </div>`).join('')}
        </div>
        <form id="whForm" class="fields" style="margin-top:8px">
          <b>Новый склад</b>
          <input name="name" maxlength="80" required placeholder="Название (например: СКЛАД LTL Казань)">
          <input name="address" maxlength="300" placeholder="Адрес">
          <input name="phone" maxlength="40" placeholder="Телефон">
          <input name="contact" maxlength="80" placeholder="Контактное лицо">
          <div class="modal-actions">
            <button type="button" class="button ghost" data-close>Закрыть</button>
            <button type="submit" class="button">➕ Добавить склад</button>
          </div>
        </form>`);
      document.querySelectorAll('[data-wh-toggle]').forEach(toggle =>
        toggle.addEventListener('click', async () => {
          try {
            await api(`/api/warehouses/${toggle.dataset.whToggle}`, { method: 'PATCH',
              body: JSON.stringify({ active: toggle.dataset.whActive !== '1' }) });
            context.closeModal();
            warehousesButton.onclick();
          } catch (error) { toast(error.message, 'error'); }
        }));
      document.getElementById('whForm').onsubmit = async event => {
        event.preventDefault();
        const form = event.target;
        try {
          await api('/api/warehouses', { method: 'POST', body: JSON.stringify({
            name: form.name.value.trim(), address: form.address.value.trim(),
            phone: form.phone.value.trim(), contact: form.contact.value.trim() }) });
          toast('Склад добавлен');
          context.closeModal();
          warehousesButton.onclick();
        } catch (error) { toast(error.message, 'error'); }
      };
    };
  }
}

// Диалог «завести внештатку» — вызывается из меню внештатной ситуации
// диспетчера; тип предвыбран, для возврата количество обязательно.
export function tripIncidentDialog(trip, kind, context) {
  const [title] = KIND_META[kind];
  context.showModal(`<h2>${title}</h2>
    <p class="muted">${escapeHtml(trip.vehicle_plate || '')} · ${escapeHtml(trip.customer_name || '')}
      · ${escapeHtml((trip.from_point || '').slice(0, 24))} → ${escapeHtml((trip.to_point || '').slice(0, 24))}</p>
    <form id="incForm">
      ${kind === 'return' ? `<label class="field">Количество (паллеты / коробки)
        <input name="qty" maxlength="120" required placeholder="например: 3 паллеты, 12 коробок"></label>` : ''}
      <label class="field">Комментарий — что случилось
        <textarea name="comment" rows="3" maxlength="500" placeholder="суть одним-двумя предложениями"></textarea></label>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button type="submit" class="button">Записать во «⚠ Внештатки»</button>
      </div>
    </form>`);
  document.getElementById('incForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    try {
      await api(`/api/trips/${trip.id}/incidents`, { method: 'POST', body: JSON.stringify({
        kind, qty: form.qty?.value.trim() || '', comment: form.comment.value.trim() }) });
      context.closeModal();
      toast('Записано — планирование и руководитель получили уведомление');
      context.onReload?.();
    } catch (error) { toast(error.message, 'error'); }
  };
}
