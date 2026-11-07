// «🛡 Безопасность движения» — рабочее место специалиста БДД (чек-лист
// продукта 07.11): журнал ДТП, нарушений ПДД и режима труда и отдыха с
// расследованием и мерами, допуски и инструктажи со сроками, водители без
// действующего допуска.
import { api, escapeHtml, renderInto, toast } from './api.js';

const ruDay = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '—';

export async function renderSafety(container, context) {
  const { state } = context;
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const from = state.safetyFrom || `${today.slice(0, 7)}-01`;
  let data;
  try {
    data = await api(`/api/safety?from=${from}&to=${today}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const s = data.summary;
  if (!renderInto(container, `<div class="bi-page sf-page">
    <div class="bi-sub"><h2>Безопасность движения</h2>
      <p>ДТП, нарушения и режим труда и отдыха — с расследованием и мерами; допуски и инструктажи — со сроками. Медосмотр и техконтроль выпуска — на экране «Выпуск».</p>
      <div class="bi-actions"><input type="date" id="sfFrom" value="${from}">
        ${data.canWrite ? '<button class="button primary" id="sfAdd">＋ Событие</button>' : ''}</div></div>
    <div class="bi-kpis">
      <div class="metric ${s.dtp ? 'neg' : 'pos'}"><span class="l">ДТП за период</span><span class="v">${s.dtp}</span></div>
      <div class="metric ${s.rto ? 'warn' : ''}"><span class="l">Нарушения РТО</span><span class="v">${s.rto}</span></div>
      <div class="metric ${s.pdd ? 'warn' : ''}"><span class="l">Нарушения ПДД</span><span class="v">${s.pdd}</span></div>
      <div class="metric ${s.open ? 'warn' : ''}"><span class="l">Открытые расследования</span><span class="v">${s.open}</span></div>
      <div class="metric ${s.termsDue ? 'warn' : ''}"><span class="l">Сроки допусков истекают</span><span class="v">${s.termsDue}</span><span class="d">порог ${data.warnDays} дн</span></div>
      <div class="metric ${data.withoutAdmission.length ? 'neg' : 'pos'}"><span class="l">Без действующего допуска</span><span class="v">${data.withoutAdmission.length}<small>из ${s.drivers}</small></span></div>
    </div>
    <div class="bi-grid">
      <section class="section s6"><div class="sec-h"><span class="st">Открытые расследования</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.open.map(row => `<tr>
          <td>${ruDay(row.happened_on)}<div class="muted">${escapeHtml(data.kinds[row.kind])}</div></td>
          <td>${escapeHtml(row.driver_name || row.plate)}<div class="muted">${escapeHtml(row.description)}</div></td>
          <td>${data.canWrite ? `<button class="button small" data-sf-close="${row.id}">Закрыть с мерами</button>` : ''}</td></tr>`).join('')
    || '<tr><td class="muted">нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">Допуски и инструктажи — истекают и просрочены</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.terms.map(row => `<tr>
          <td>${escapeHtml(row.driver_name)}</td><td>${escapeHtml(data.kinds[row.kind])}</td>
          <td class="num"><span class="bi-tag ${row.termStatus === 'expired' ? 'neg' : 'warn'}">${row.termStatus === 'expired' ? 'истёк' : 'до'} ${ruDay(row.valid_until)}</span></td></tr>`).join('')
    || '<tr><td class="muted">сроки в порядке</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">Водители по событиям периода</span><span class="hint">ДТП весят больше</span></div>
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Водитель</th><th class="r">ДТП</th><th class="r">РТО</th><th class="r">ПДД</th></tr></thead>
        <tbody>${data.byDriver.map(row => `<tr><td>${escapeHtml(row.name)}</td><td class="num">${row.dtp}</td><td class="num">${row.rto}</td><td class="num">${row.pdd}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">событий нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">Без действующего допуска</span><span class="hint">внесите допуск в журнал</span></div>
        <div class="sec-b sf-tags">${data.withoutAdmission.slice(0, 80).map(row => `<span class="bi-tag">${escapeHtml(row.name)}</span>`).join(' ') || '<span class="muted">все допущены</span>'}</div></section>
      <section class="section"><div class="sec-h"><span class="st">Журнал за период</span></div>
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Дата</th><th>Вид</th><th>Водитель · машина</th><th>Что произошло</th><th>Меры</th><th>Статус</th></tr></thead>
        <tbody>${data.events.map(row => `<tr><td>${ruDay(row.happened_on)}</td><td>${escapeHtml(data.kinds[row.kind])}</td>
          <td>${escapeHtml(row.driver_name)}${row.plate ? ` · ${escapeHtml(row.plate)}` : ''}</td><td>${escapeHtml(row.description)}${row.valid_until ? ` <span class="muted">до ${ruDay(row.valid_until)}</span>` : ''}</td>
          <td>${escapeHtml(row.measures)}</td><td>${row.status === 'open' ? '<span class="bi-tag warn">расследуется</span>' : '<span class="bi-tag pos">закрыто</span>'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">записей нет</td></tr>'}</tbody></table></div></section>
    </div>
  </div>`)) return;
  const rerender = () => renderSafety(container, context);
  container.querySelector('#sfFrom').onchange = event => { state.safetyFrom = event.currentTarget.value; rerender(); };
  container.querySelector('#sfAdd')?.addEventListener('click', () => addDialog(context, data, rerender));
  container.querySelectorAll('[data-sf-close]').forEach(button => {
    button.onclick = async () => {
      const measures = prompt('Принятые меры (обязательно)');
      if (!measures) return;
      try {
        await api(`/api/safety/${button.dataset.sfClose}/close`, { method: 'POST', body: JSON.stringify({ measures }) });
        toast('Расследование закрыто');
        rerender();
      } catch (error) { toast(error.message); }
    };
  });
}

function addDialog(context, data, after) {
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  context.showModal(`<form id="sfForm"><h2>Событие безопасности движения</h2>
    <label class="field">Вид <select name="kind">${Object.entries(data.kinds).map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join('')}</select></label>
    <label class="field">Водитель <select name="driverId"><option value="">—</option>${data.drivers.map(driver => `<option value="${driver.id}">${escapeHtml(driver.name)}</option>`).join('')}</select></label>
    <label class="field">Машина <select name="vehicleId"><option value="">—</option>${data.vehicles.map(vehicle => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)}</option>`).join('')}</select></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="field">Дата <input type="date" name="happenedOn" value="${today}" required></label>
      <label class="field">Действует до <small class="muted">(допуск, инструктаж)</small><input type="date" name="validUntil"></label></div>
    <label class="field">Что произошло <textarea name="description" rows="3"></textarea></label>
    <label class="field">Меры <textarea name="measures" rows="2"></textarea></label>
    <div class="form-error" id="sfErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button primary">Сохранить</button></div></form>`);
  document.querySelector('#sfForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(['kind', 'driverId', 'vehicleId', 'happenedOn', 'validUntil', 'description', 'measures'].map(key => [key, form[key].value]));
    try {
      await api('/api/safety', { method: 'POST', body: JSON.stringify(body) });
      toast('Сохранено');
      context.closeModal(); after();
    } catch (error) { document.querySelector('#sfErr').textContent = error.message; }
  });
}
