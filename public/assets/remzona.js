// Блок «Ремзона» — АВТОНОМНАЯ конструкция (этап 1, 14.09.2026): очередь
// заказ-нарядов механика со статусной моделью «очередь → в работе →
// готов → выдан», работами и одометрами. До этапа интеграции блок НЕ
// влияет на подбор, гант и занятость машин — копит собственные факты,
// из которых позже выучатся нормативы длительности работ.
import { api, escapeHtml, toast, renderInto } from './api.js';

const PURPOSES = ['ТО', 'плановый ремонт', 'поломка на линии', 'ДТП', 'шины', 'документы', 'прочее'];
const STATUS_LABEL = {
  queued: '📥 Очередь', in_progress: '🔧 В работе', ready: '✅ Готовы', released: '🚚 Выданы (14 дн)'
};

const fmt = iso => iso ? new Date(iso).toLocaleString('ru-RU',
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';

function orderCardHtml(order, can) {
  const jobsDone = order.jobs.filter(job => job.status === 'done').length;
  const write = can('fleet:write');
  const actions = !write ? '' : {
    queued: `<button class="button small" data-ra="start" data-ro="${order.id}">▶ В работу</button>
      <button class="button ghost small" data-ra="cancel" data-ro="${order.id}">✕</button>`,
    in_progress: `<button class="button small" data-ra="ready" data-ro="${order.id}">✅ Готово</button>`,
    ready: `<button class="button small" data-ra="release" data-ro="${order.id}">🚚 Выдать</button>
      <button class="button ghost small" data-ra="reopen" data-ro="${order.id}">↩ Доработать</button>`,
    released: ''
  }[order.status] || '';
  return `<div class="list-item" style="flex-direction:column;align-items:stretch;gap:4px">
    <div style="display:flex;gap:8px;align-items:center">
      <strong class="mono vlink" data-vinfo="${order.vehicle_id}">${escapeHtml(order.plate)}</strong>
      <span class="badge">${escapeHtml(order.purpose)}</span>
      <small class="muted">${escapeHtml(order.vehicle_type || '')}</small>
      <span style="margin-left:auto">${actions}</span>
    </div>
    ${order.complaint ? `<small>${escapeHtml(order.complaint)}</small>` : ''}
    <small class="muted">заезд ${fmt(order.arrived_at)}${order.odometer_km
      ? ` · одометр ${Math.round(order.odometer_km).toLocaleString('ru-RU')} км` : ''}${order.planned_out
      ? ` · выход план ${fmt(order.planned_out)}` : ''}${order.mechanic_name
      ? ` · ${escapeHtml(order.mechanic_name)}` : ''}</small>
    ${order.status === 'released' ? `<small class="muted">выдан ${fmt(order.released_at)}</small>` : `
    <div>
      ${order.jobs.map(job => `<div style="display:flex;gap:6px;align-items:center;padding:1px 0">
        ${write ? `<input type="checkbox" data-rj="${job.id}" ${job.status === 'done' ? 'checked' : ''}>` : (job.status === 'done' ? '☑' : '☐')}
        <span style="flex:1;${job.status === 'done' ? 'opacity:.6' : ''}">${escapeHtml(job.title)}${job.parts
          ? ` <small class="muted">(${escapeHtml(job.parts)})</small>` : ''}${job.hours ? ` <small class="muted">· ${job.hours} ч</small>` : ''}</span>
        ${write ? `<button class="button ghost small" data-rjdel="${job.id}" title="Убрать работу">✕</button>` : ''}
      </div>`).join('')}
      ${order.jobs.length ? `<small class="muted">работы: ${jobsDone}/${order.jobs.length}</small>` : ''}
      ${write && order.status !== 'released' ? `<button class="button ghost small" data-rjadd="${order.id}">＋ работа</button>` : ''}
    </div>`}
  </div>`;
}

export async function renderRemzona(container, context) {
  const { state, can, showModal, closeModal } = context;
  let payload;
  try { payload = await api('/api/repairs'); } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const groups = { queued: [], in_progress: [], ready: [], released: [] };
  for (const item of payload.items) if (groups[item.status]) groups[item.status].push(item);
  const columns = ['queued', 'in_progress', 'ready', 'released'].map(status => `
    <div style="flex:1;min-width:230px">
      <h3 style="margin:0 0 6px">${STATUS_LABEL[status]} <span class="badge">${groups[status].length}</span></h3>
      ${groups[status].map(order => orderCardHtml(order, can)).join('')
        || '<div class="muted" style="padding:8px 2px">пусто</div>'}
    </div>`).join('');
  renderInto(container, `<div style="padding:10px 14px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <h2 style="margin:0">🔧 Ремзона</h2>
      ${can('fleet:write') ? '<button class="button small" id="rzNew">🚚 Новый заезд</button>' : ''}
      <small class="muted">блок автономен: на подбор машин и гант пока не влияет —
        недоступность ТС по-прежнему ставится диспозицией в «Ресурсе»</small>
    </div>
    <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">${columns}</div>
  </div>`);
  const refresh = () => renderRemzona(container, context);
  container.querySelector('#rzNew')?.addEventListener('click', () => {
    const vehicles = (state.data.vehicles || []).filter(vehicle => vehicle.status === 'work')
      .slice().sort((a, b) => a.plate.localeCompare(b.plate, 'ru'));
    showModal(`<form id="rzForm"><h2>🚚 Новый заезд в ремзону</h2>
      <label class="field">Машина<select name="vehicleId" required>
        ${vehicles.map(vehicle => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)}</option>`).join('')}
      </select></label>
      <label class="field">Причина заезда<select name="purpose">
        ${PURPOSES.map(reason => `<option>${reason}</option>`).join('')}</select></label>
      <label class="field">Что случилось / дефекты<textarea name="complaint" rows="3"
        placeholder="со слов водителя или по осмотру"></textarea></label>
      <label class="field">Плановый выход<input type="datetime-local" name="plannedOut"></label>
      <p class="muted">Одометр борта снимется сам с CAN-датчика. Недоступность машины
        для планирования этот заезд пока НЕ ставит — до этапа интеграции её ведёт «Ресурс».</p>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Создать заказ-наряд</button>
      </div></form>`);
    document.getElementById('rzForm').onsubmit = async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.plannedOut) values.plannedOut = new Date(values.plannedOut).toISOString();
      try {
        await api('/api/repairs', { method: 'POST', body: JSON.stringify(values) });
        closeModal(); toast('Заказ-наряд создан'); refresh();
      } catch (error) { toast(error.message, 'error'); }
    };
  });
  container.querySelectorAll('[data-ra]').forEach(button => button.addEventListener('click', async () => {
    try {
      await api(`/api/repairs/${button.dataset.ro}`, {
        method: 'PATCH', body: JSON.stringify({ action: button.dataset.ra }) });
      refresh();
    } catch (error) { toast(error.message, 'error'); }
  }));
  container.querySelectorAll('[data-rjadd]').forEach(button => button.addEventListener('click', () => {
    const title = prompt('Работа (например: замена колодок передней оси)');
    if (!title) return;
    const parts = prompt('Запчасти/материалы (можно пусто)') || '';
    api(`/api/repairs/${button.dataset.rjadd}/jobs`, {
      method: 'POST', body: JSON.stringify({ title, parts })
    }).then(refresh).catch(error => toast(error.message, 'error'));
  }));
  container.querySelectorAll('[data-rj]').forEach(checkbox => checkbox.addEventListener('change', () => {
    const done = checkbox.checked;
    const hours = done ? Number(prompt('Часы работы (для нормативов, можно пусто)') || '') : null;
    api(`/api/repairs/jobs/${checkbox.dataset.rj}`, {
      method: 'PATCH', body: JSON.stringify({ done, hours: Number.isFinite(hours) && hours > 0 ? hours : undefined })
    }).then(refresh).catch(error => { toast(error.message, 'error'); refresh(); });
  }));
  container.querySelectorAll('[data-rjdel]').forEach(button => button.addEventListener('click', () => {
    api(`/api/repairs/jobs/${button.dataset.rjdel}`, { method: 'DELETE' })
      .then(refresh).catch(error => toast(error.message, 'error'));
  }));
}
