// «📄 Документы» — возврат документов рейса после выгрузки (П5, чек-лист
// продукта 07.11). Диспетчер учёта отмечает, какие документы сданы;
// просрочка — по живому нормативу сдачи. Закрытие рейса не задерживает.
import { api, escapeHtml, renderInto, toast } from './api.js';

const dt = iso => iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export async function renderTripDocs(container, context) {
  const { state } = context;
  let data;
  try {
    data = await api('/api/trip-docs');
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const q = (state.docsQuery || '').toLowerCase();
  const items = data.items.filter(item => !q || `${item.plate} ${item.driver_name} ${item.customer_name} ${item.order_no}`.toLowerCase().includes(q));
  const s = data.summary;
  if (!renderInto(container, `<div class="bi-page dc-page">
    <div class="bi-sub"><h2>Документы после выгрузки</h2>
      <p>Рейсы, выгруженные с ${dt(data.since)}, у которых документы ещё не сданы. Норматив сдачи — ${data.norm != null ? `${String(data.norm).replace('.', ',')} сут (медиана факта за 60 дней)` : 'копится (нужно 5 сданных)'}.</p>
      <div class="bi-actions"><input id="dcSearch" placeholder="Машина, водитель, клиент, заказ" value="${escapeHtml(state.docsQuery || '')}"></div></div>
    <div class="bi-kpis bi-kpis-row">
      <div class="metric ${s.waiting ? 'warn' : 'pos'}"><span class="l">Ждут документов</span><span class="v">${s.waiting}</span></div>
      <div class="metric ${s.overdue ? 'neg' : 'pos'}"><span class="l">Дольше норматива</span><span class="v">${s.overdue}</span></div>
      <div class="metric"><span class="l">Сдано за 7 дней</span><span class="v">${s.returnedWeek}</span></div>
    </div>
    <section class="section"><div class="sec-h"><span class="st">Ждут документов</span><span class="hint">старые — сверху</span></div>
      <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Выгрузка</th><th>Машина · водитель</th><th>Клиент · заказ</th><th>Маршрут</th><th class="r">Ждёт</th><th></th></tr></thead>
      <tbody>${items.map(item => `<tr class="${item.overdue ? 'dc-late' : ''}">
        <td class="mono">${dt(item.unloaded)}</td>
        <td><b class="mono">${escapeHtml(item.plate)}</b><div class="muted">${escapeHtml(item.driver_name || '')}</div></td>
        <td>${escapeHtml(item.customer_name || '—')}${item.order_no ? `<div class="muted">№ ${escapeHtml(item.order_no)}</div>` : ''}</td>
        <td>${escapeHtml(item.from_name)} → ${escapeHtml(item.to_name)}</td>
        <td class="num">${String(item.waitedDays).replace('.', ',')} сут</td>
        <td>${data.canWrite ? `<select data-dc-kind="${item.id}"><option value="">Сданы…</option>${Object.entries(data.kinds)
    .map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join('')}</select>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Все документы сданы</td></tr>'}</tbody></table></div></section>
  </div>`)) return;
  const search = container.querySelector('#dcSearch');
  search.onchange = () => { state.docsQuery = search.value; renderTripDocs(container, context); };
  container.querySelectorAll('[data-dc-kind]').forEach(select => {
    select.onchange = async () => {
      if (!select.value) return;
      try {
        await api(`/api/trip-docs/${select.dataset.dcKind}`, { method: 'POST', body: JSON.stringify({ kind: select.value }) });
        toast('Документы отмечены');
        renderTripDocs(container, context);
      } catch (error) { toast(error.message); select.value = ''; }
    };
  });
}
