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
  const tsf = value => formatDateTime(String(value).includes('Z')
    ? value : String(value).replace(' ', 'T') + 'Z');

  const card = item => `<div class="kb-card ${item.closed_at ? 'inc-closed' : ''}">
      <div class="kbr kb1"><b class="mono">${escapeHtml(item.vehicle_plate)}</b>
        <span class="kb-drv">${item.order_no ? `№ ${escapeHtml(String(item.order_no))}` : ''}</span></div>
      <div class="kbr kb2">${escapeHtml((item.customer_name || '').slice(0, 34))}</div>
      <div class="kbr kb3">${escapeHtml((item.from_point || '').slice(0, 20))} → ${escapeHtml((item.to_point || '').slice(0, 20))}</div>
      ${item.qty ? `<div class="kbr"><b>${escapeHtml(item.qty)}</b></div>` : ''}
      ${item.comment ? `<div class="kbr inc-note">${escapeHtml(item.comment)}</div>` : ''}
      <div class="kbr"><small class="muted">${escapeHtml(item.created_by_name)} · ${tsf(item.created_at)}</small></div>
      ${item.closed_at ? `<div class="kbr inc-note">✓ ${escapeHtml(item.resolution)}
        <small class="muted">· ${escapeHtml(item.closed_by_name)} · ${tsf(item.closed_at)}</small></div>`
    : canAct ? `<div class="kb-btns"><button class="button ghost small" data-inc-close="${item.id}">✓ Закрыть с итогом</button></div>` : ''}
    </div>`;

  const lateCard = item => `<div class="kb-card inc-auto">
      <div class="kbr kb1"><b class="mono">${escapeHtml(item.vehicle_plate)}</b>
        <span class="kb-drv">${item.order_no ? `№ ${escapeHtml(String(item.order_no))}` : ''}</span></div>
      <div class="kbr kb2">${escapeHtml((item.customer_name || '').slice(0, 34))}</div>
      <div class="kbr"><b style="color:var(--bad)">+${item.late_hours} ч</b>
        на ${item.stop_kind === 'P' ? 'погрузке' : 'выгрузке'} ${escapeHtml((item.point || '').slice(0, 26))}</div>
      <div class="kbr"><small class="muted">план ${tsf(item.planned_arrival)} · факт ${tsf(item.actual_arrival)}
        · <span class="badge" title="Создано автоматически из отметки прибытия — факты не закрываются, они уже случились">⚙ из отметок</span></small></div>
    </div>`;

  const columns = [
    ['act', manual.filter(item => item.kind === 'act').map(card)],
    ['return', manual.filter(item => item.kind === 'return').map(card)],
    ['late', [...manual.filter(item => item.kind === 'late').map(card),
      ...(data.autoLateTotal > data.autoLate.length
        ? [`<p class="muted" style="padding:4px 8px">Всего опозданий из отметок за период: ${data.autoLateTotal} — показаны ${data.autoLate.length} крупнейших. Полная картина — в отчётах руководителя.</p>`]
        : []),
      ...data.autoLate.map(lateCard)]]
  ];

  const html = `<div class="inc-page">
    <div class="resctl" style="margin-bottom:8px">
      <strong>⚠ Внештатки</strong>
      <label class="muted">с <input type="date" id="incFrom" value="${state.incFrom}"></label>
      <label class="muted">по <input type="date" id="incTo" value="${state.incTo}"></label>
      <label class="muted" title="Закрытые акты и возвраты — история решений">
        <input type="checkbox" id="incClosed" ${showClosed ? 'checked' : ''}> показать закрытые</label>
      <small class="muted">Завести внештатку: Диспетчер → карточка рейса → «⋯ Внештатная ситуация» → Акт / Возврат / Опоздание</small>
    </div>
    <div class="kb-board">
      ${columns.map(([kind, cards]) => `<section class="kb-col">
        <div class="kb-chead"><span>${KIND_META[kind][0]}</span><span class="kb-lim">${cards.length}</span></div>
        <div class="kb-note">${KIND_META[kind][1]}</div>
        <div class="kb-cards">${cards.join('') || '<p class="muted" style="padding:8px">Пусто — и хорошо.</p>'}</div>
      </section>`).join('')}
    </div>
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
      toast('Записано — продажи и руководитель получили уведомление');
      context.onReload?.();
    } catch (error) { toast(error.message, 'error'); }
  };
}
