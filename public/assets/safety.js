// «🛡 Безопасность движения» — рабочее место специалиста БДД (чек-лист
// продукта 07.11): журнал ДТП, нарушений ПДД и режима труда и отдыха с
// расследованием и мерами, допуски и инструктажи со сроками, водители без
// действующего допуска.
import { api, escapeHtml, renderInto, toast } from './api.js';
import { excelDate, readXlsx } from './xlsx-read.js';

const ruDay = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '—';
const fmtRub = value => `${Math.round(Number(value) || 0).toLocaleString('ru-RU')} ₽`;
const ruMonth = iso => {
  const [year, month] = String(iso).split('-').map(Number);
  return `${['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][month - 1]} ${year}`;
};
const culpTag = value => value === 'guilty' ? '<span class="bi-tag neg">виновны</span>'
  : value === 'notguilty' ? '<span class="bi-tag pos">не виновны</span>' : '';

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
  const g = data.gibdd;
  // Поля с развёртыванием (заказ руководителя 14.11): секции свёрнуты,
  // в заголовке — счётчик; раскрытые запоминаются в браузере.
  let sfOpen;
  try { sfOpen = new Set(JSON.parse(localStorage.getItem('pl_sf_open') || '[]')); } catch { sfOpen = new Set(); }
  const secCls = key => sfOpen.has(key) ? '' : ' sec-closed';
  const secHead = (key, title, count, hint = '') => `<div class="sec-h"><span class="st"><span class="sec-chev">${sfOpen.has(key) ? '▾' : '▸'}</span>${title}${count ? `<span class="sec-n">${count}</span>` : ''}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  if (!renderInto(container, `<div class="bi-page sf-page">
    <div class="bi-sub"><h2>Безопасность движения</h2>
      <p>ДТП, нарушения и режим труда и отдыха — с расследованием и мерами; допуски и инструктажи — со сроками. Медосмотр и техконтроль выпуска — на экране «Выпуск».</p>
      <div class="bi-actions"><input type="date" id="sfFrom" value="${from}">
        ${data.canWrite ? `<label class="button ghost" title="Выгрузка 1С:УАТ с листом «ДТП» — повторная загрузка обновляет, а не дублирует">⬆ Импорт ДТП из 1С<input type="file" id="sfImport" accept=".xlsx" hidden></label>
        <button class="button primary" id="sfAdd">＋ Событие</button>` : ''}</div></div>
    <div class="bi-kpis">
      <div class="metric ${s.dtp ? 'neg' : 'pos'}"><span class="l">ДТП за период</span><span class="v">${s.dtp}</span>
        ${s.dtpGuilty || s.dtpNotGuilty ? `<span class="d">виновны ${s.dtpGuilty} · не виновны ${s.dtpNotGuilty}</span>` : ''}</div>
      <div class="metric"><span class="l">ДТП на 1 млн км</span><span class="v">${s.per1m == null ? '—' : s.per1m.toLocaleString('ru-RU')}</span>
        <span class="d">пробег ${Math.round(s.periodKm / 1000).toLocaleString('ru-RU')} тыс. км</span></div>
      <div class="metric ${s.rto ? 'warn' : ''}"><span class="l">Нарушения РТО</span><span class="v">${s.rto}</span></div>
      <div class="metric ${s.pdd ? 'warn' : ''}"><span class="l">Нарушения ПДД</span><span class="v">${s.pdd}</span></div>
      <div class="metric ${s.open ? 'warn' : ''}"><span class="l">Открытые расследования</span><span class="v">${s.open}</span></div>
      <div class="metric ${s.termsDue ? 'warn' : ''}"><span class="l">Сроки допусков истекают</span><span class="v">${s.termsDue}</span><span class="d">порог ${data.warnDays} дн</span></div>
      <div class="metric ${data.withoutAdmission.length ? 'neg' : 'pos'}"><span class="l">Без действующего допуска</span><span class="v">${data.withoutAdmission.length}<small>из ${s.drivers}</small></span></div>
      ${g ? `<div class="metric ${g.unpaidCount ? 'warn' : 'pos'}"><span class="l">Штрафы ГИБДД — не оплачено</span><span class="v">${g.unpaidCount}</span><span class="d">${fmtRub(g.unpaidAmount)} к оплате</span></div>
      <div class="metric ${g.burning.length ? 'neg' : ''}"><span class="l">Скидка 50 % горит</span><span class="v">${g.burning.length}</span><span class="d">порог ${data.warnDays} дн</span></div>` : ''}
    </div>
    <div class="bi-grid">
      <section class="section s6${secCls('dyn')}" data-sec="dyn">${secHead('dyn', 'ДТП — динамика 6 месяцев', '', 'аварийность — на фактический пробег рейсов')}
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Месяц</th><th class="r">ДТП</th><th class="r">виновны</th><th class="r">не виновны</th><th class="r">пробег, тыс. км</th><th class="r">на 1 млн км</th></tr></thead>
        <tbody>${(data.months || []).map(row => `<tr>
          <td>${ruMonth(row.month)}</td><td class="num">${row.dtp || ''}</td>
          <td class="num">${row.guilty ? `<span class="bi-tag neg">${row.guilty}</span>` : ''}</td>
          <td class="num">${row.notguilty || ''}</td>
          <td class="num">${Math.round(row.km / 1000).toLocaleString('ru-RU')}</td>
          <td class="num">${row.per1m == null ? '—' : row.per1m.toLocaleString('ru-RU')}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="section s6${secCls('claims')}" data-sec="claims">${secHead('claims', 'Дела страховых — открытые ДТП', (data.claims || []).length, 'от старых к свежим; возраст — дни с ДТП')}
        ${(data.claimFunnel || []).length ? `<div class="sec-b sf-tags">${data.claimFunnel.map(step => `<span class="bi-tag">${escapeHtml(step.label)}: <b>${step.count}</b></span>`).join(' ')}</div>` : ''}
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>№ 1С · дата</th><th>Машина · водитель</th><th>Этап</th><th class="r">Возраст, дн</th></tr></thead>
        <tbody>${(data.claims || []).slice().sort((a, b) => b.ageDays - a.ageDays).slice(0, 60).map(row => `<tr>
          <td>${escapeHtml(row.external_no || '—')}<div class="muted">${ruDay(row.happened_on)}</div></td>
          <td>${escapeHtml(row.plate)}${row.driver_name ? `<div class="muted">${escapeHtml(row.driver_name)}</div>` : ''}</td>
          <td>${escapeHtml((data.claimLabels || {})[row.claim_status] || row.claim_status || '—')}${row.claim_no ? `<div class="muted">дело ${escapeHtml(row.claim_no)}</div>` : ''} ${culpTag(row.culpability)}</td>
          <td class="num">${row.ageDays}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">открытых дел нет</td></tr>'}</tbody></table></div></section>
      ${(data.byVehicle || []).length ? `<section class="section s6${secCls('veh')}" data-sec="veh">${secHead('veh', 'Машины по ДТП периода', data.byVehicle.length)}
        <div class="sec-b sf-tags">${data.byVehicle.slice(0, 40).map(row => `<span class="bi-tag ${row.guilty ? 'neg' : ''}">${escapeHtml(row.plate)}: ${row.dtp}${row.guilty ? ` (виновны ${row.guilty})` : ''}</span>`).join(' ')}</div></section>` : ''}
      <section class="section s6${secCls('inv')}" data-sec="inv">${secHead('inv', 'Открытые расследования', data.open.length)}
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.open.map(row => `<tr>
          <td>${ruDay(row.happened_on)}<div class="muted">${escapeHtml(data.kinds[row.kind])}</div></td>
          <td>${escapeHtml(row.driver_name || row.plate)}<div class="muted">${escapeHtml(row.description)}</div></td>
          <td>${data.canWrite ? `<button class="button small" data-sf-close="${row.id}">Закрыть с мерами</button>` : ''}</td></tr>`).join('')
    || '<tr><td class="muted">нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6${secCls('terms')}" data-sec="terms">${secHead('terms', 'Допуски и инструктажи — истекают и просрочены', data.terms.length)}
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.terms.map(row => `<tr>
          <td>${escapeHtml(row.driver_name)}</td><td>${escapeHtml(data.kinds[row.kind])}</td>
          <td class="num"><span class="bi-tag ${row.termStatus === 'expired' ? 'neg' : 'warn'}">${row.termStatus === 'expired' ? 'истёк' : 'до'} ${ruDay(row.valid_until)}</span></td></tr>`).join('')
    || '<tr><td class="muted">сроки в порядке</td></tr>'}</tbody></table></div></section>
      <section class="section s6${secCls('drv')}" data-sec="drv">${secHead('drv', 'Водители по событиям периода', data.byDriver.length, 'ДТП весят больше')}
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Водитель</th><th class="r">ДТП</th><th class="r">РТО</th><th class="r">ПДД</th></tr></thead>
        <tbody>${data.byDriver.map(row => `<tr><td>${escapeHtml(row.name)}</td><td class="num">${row.dtp}</td><td class="num">${row.rto}</td><td class="num">${row.pdd}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">событий нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6${secCls('adm')}" data-sec="adm">${secHead('adm', 'Без действующего допуска', data.withoutAdmission.length, 'внесите допуск в журнал')}
        <div class="sec-b sf-tags">${data.withoutAdmission.slice(0, 80).map(row => `<span class="bi-tag">${escapeHtml(row.name)}</span>`).join(' ') || '<span class="muted">все допущены</span>'}</div></section>
      ${g ? `<section class="section${secCls('fines')}" data-sec="fines">${secHead('fines', 'Штрафы ГИБДД за период', g.fines.length,
    g.enabled ? (g.last?.at ? `обновлено ${ruDay(g.last.at)} · виновник — по закреплению на момент нарушения` : 'синхронизаций ещё не было') : 'коннектор OnlineГИБДД выключен — Настройки → Интеграции')}
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Нарушение</th><th>Машина · водитель</th><th>Статья · место</th><th class="r">Сумма</th><th>Скидка до</th><th>Статус</th>${data.canWrite ? '<th></th>' : ''}</tr></thead>
        <tbody>${g.fines.slice(0, 200).map(fine => `<tr>
          <td>${ruDay(fine.offense_on)}${fine.offense_time ? ` ${escapeHtml(fine.offense_time)}` : ''}</td>
          <td>${escapeHtml(fine.plate || fine.auto_cdi)}${fine.driver_name ? `<div class="muted">${escapeHtml(fine.driver_name)}</div>` : '<div class="muted">виновник не определён</div>'}</td>
          <td>${escapeHtml(fine.article_number)}<div class="muted">${escapeHtml(fine.location.slice(0, 90))}</div></td>
          <td class="num">${fine.amount_discount != null && fine.amount_discount < fine.amount && fine.status === 'nopayed'
    ? `<s class="muted">${fmtRub(fine.amount)}</s> ${fmtRub(fine.amount_discount)}` : fmtRub(fine.amount)}</td>
          <td>${fine.discount_until && fine.status === 'nopayed' ? ruDay(fine.discount_until) : '—'}</td>
          <td>${fine.status === 'payed' ? '<span class="bi-tag pos">оплачен</span>'
    : fine.status === 'revoked' ? '<span class="bi-tag">обжалован</span>'
      : '<span class="bi-tag warn">не оплачен</span>'}</td>
          ${data.canWrite ? `<td>${fine.driver_id || fine.vehicle_id ? `<button class="button small ghost" data-sf-fine="${escapeHtml(fine.bill_id)}">→ расследование</button>` : ''}</td>` : ''}</tr>`).join('')
    || `<tr><td colspan="7" class="muted">штрафов за период нет</td></tr>`}</tbody></table></div>
        ${g.withoutSts.length ? `<div class="sec-b"><span class="muted">Без СТС в паспорте ТС — не на мониторинге (${g.withoutSts.length}): ${g.withoutSts.slice(0, 40).map(escapeHtml).join(', ')}${g.withoutSts.length > 40 ? '…' : ''}</span></div>` : ''}
        ${g.last?.unknownCdi?.length ? `<div class="sec-b"><span class="muted">В сервисе есть СТС, которых нет в паспортах ТС: ${g.last.unknownCdi.slice(0, 10).map(escapeHtml).join(', ')}</span></div>` : ''}
      </section>` : ''}
      <section class="section${secCls('log')}" data-sec="log">${secHead('log', 'Журнал за период', data.events.length)}
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Дата</th><th>Вид</th><th>Водитель · машина</th><th>Что произошло</th><th>Меры</th><th>Статус</th></tr></thead>
        <tbody>${data.events.map(row => `<tr><td>${ruDay(row.happened_on)}</td><td>${escapeHtml(data.kinds[row.kind])}${row.external_no ? `<div class="muted">${escapeHtml(row.external_no)}</div>` : ''} ${culpTag(row.culpability)}</td>
          <td>${escapeHtml(row.driver_name)}${row.plate ? ` · ${escapeHtml(row.plate)}` : ''}</td><td>${escapeHtml(row.description)}${row.valid_until ? ` <span class="muted">до ${ruDay(row.valid_until)}</span>` : ''}${row.claim_status ? `<div class="muted">СК: ${escapeHtml((data.claimLabels || {})[row.claim_status] || row.claim_status)}${row.paid_rub ? ` · выплачено ${fmtRub(row.paid_rub)}` : ''}</div>` : ''}</td>
          <td>${escapeHtml(row.measures)}</td><td>${row.status === 'open' ? '<span class="bi-tag warn">расследуется</span>' : '<span class="bi-tag pos">закрыто</span>'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">записей нет</td></tr>'}</tbody></table></div></section>
    </div>
  </div>`)) return;
  const rerender = () => renderSafety(container, context);
  // Клик по заголовку секции — развернуть/свернуть, выбор запоминается.
  container.querySelectorAll('[data-sec] > .sec-h').forEach(head => {
    head.addEventListener('click', () => {
      const section = head.closest('[data-sec]');
      const opened = section.classList.toggle('sec-closed') === false;
      if (opened) sfOpen.add(section.dataset.sec); else sfOpen.delete(section.dataset.sec);
      try { localStorage.setItem('pl_sf_open', JSON.stringify([...sfOpen])); } catch { /* приват-режим */ }
      head.querySelector('.sec-chev').textContent = opened ? '▾' : '▸';
    });
  });
  container.querySelector('#sfFrom').onchange = event => { state.safetyFrom = event.currentTarget.value; rerender(); };
  container.querySelector('#sfAdd')?.addEventListener('click', () => addDialog(context, data, rerender));
  container.querySelector('#sfImport')?.addEventListener('change', async event => {
    const file = event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const result = await importDtpFile(file);
      toast(`Импорт ДТП: новых ${result.added}, обновлено ${result.updated}${result.skipped.length ? `, пропущено ${result.skipped.length}` : ''}`);
      if (result.skipped.length) {
        context.showModal(`<h2>Импорт: пропущенные строки</h2>
          <div class="sec-b">${result.skipped.slice(0, 50).map(line => `<div>${escapeHtml(line)}</div>`).join('')}</div>
          <div class="modal-actions"><button class="button" data-close>Понятно</button></div>`);
      }
      rerender();
    } catch (error) { toast(error.message); }
  });
  // Штраф → расследование: событие «Нарушение ПДД» с заполненными полями.
  container.querySelectorAll('[data-sf-fine]').forEach(button => {
    button.onclick = () => {
      const fine = (g?.fines || []).find(item => item.bill_id === button.dataset.sfFine);
      if (!fine) return;
      // Виновник мог прийти фолбэком по имени (без id) — подберём по ФИО.
      const driverId = fine.driver_id
        || data.drivers.find(driver => driver.name === fine.driver_name)?.id || '';
      addDialog(context, data, rerender, {
        kind: 'pdd', driverId, vehicleId: fine.vehicle_id || '',
        happenedOn: fine.offense_on || '',
        description: `Штраф ГИБДД ${fine.article_number}: ${fine.article || ''} — ${fine.location}`.slice(0, 300)
          + ` (УИН ${fine.bill_id}, ${fmtRub(fine.amount)})`
      });
    };
  });
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

// Выгрузка 1С:УАТ: лист «ДТП», колонки находим по заголовкам (порядок в
// 1С может меняться). Дата — excel-число с временем.
async function importDtpFile(file) {
  const rows = await readXlsx(file, 'ДТП');
  if (!rows.length) throw new Error('Лист «ДТП» пуст');
  const header = rows[0].map(cell => String(cell || '').toLowerCase().trim());
  const col = part => header.findIndex(cell => cell.startsWith(part));
  const columns = {
    externalNo: col('номер'), date: col('дата и время'), plate: col('тс'), driverName: col('водитель'),
    culpability: col('виновность'), place: col('место'), damage: col('поврежден'),
    analysis: col('анализ'), comment: col('комментар'), claimStatus: col('статус'),
    claimNo: col('номер дела'), paidRub: col('выплачено ск'), members: col('участники')
  };
  if (columns.externalNo < 0 || columns.date < 0 || columns.plate < 0) {
    throw new Error('Не похоже на выгрузку ДТП из 1С: нет колонок «Номер», «Дата и время», «ТС»');
  }
  const value = (row, key) => columns[key] >= 0 ? String(row[columns[key]] ?? '').trim() : '';
  const body = rows.slice(1)
    .filter(row => value(row, 'externalNo'))
    .map(row => {
      const members = value(row, 'members');
      // Тягач сцепки — фолбэк привязки, когда «ТС» — прицеп (их нет в парке).
      const paired = (members.match(/сцепке с\s*([а-яёa-z]{1,2}\s?\d{3,4}\s?[а-яёa-z]{0,2}\s?\d{2,3})/i) || [])[1] || '';
      return {
        externalNo: value(row, 'externalNo'),
        happenedOn: excelDate(value(row, 'date')) || String(value(row, 'date')).slice(0, 10),
        plate: value(row, 'plate'), pairedPlate: paired, driverName: value(row, 'driverName'),
        culpability: value(row, 'culpability'), place: value(row, 'place'),
        damage: value(row, 'damage') + (/сцепк/i.test(members) ? `\nУчастники: ${members}` : ''),
        analysis: value(row, 'analysis'), comment: value(row, 'comment'),
        claimStatus: value(row, 'claimStatus'), claimNo: value(row, 'claimNo'),
        paidRub: Number(value(row, 'paidRub')) || 0
      };
    });
  if (!body.length) throw new Error('В листе «ДТП» нет строк с номером документа');
  return api('/api/safety/import', { method: 'POST', body: JSON.stringify({ rows: body }) });
}

function addDialog(context, data, after, preset = {}) {
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  context.showModal(`<form id="sfForm"><h2>Событие безопасности движения</h2>
    <label class="field">Вид <select name="kind">${Object.entries(data.kinds).map(([key, label]) => `<option value="${key}" ${preset.kind === key ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
    <label class="field">Водитель <select name="driverId"><option value="">—</option>${data.drivers.map(driver => `<option value="${driver.id}" ${preset.driverId === driver.id ? 'selected' : ''}>${escapeHtml(driver.name)}</option>`).join('')}</select></label>
    <label class="field">Машина <select name="vehicleId"><option value="">—</option>${data.vehicles.map(vehicle => `<option value="${vehicle.id}" ${preset.vehicleId === vehicle.id ? 'selected' : ''}>${escapeHtml(vehicle.plate)}</option>`).join('')}</select></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="field">Дата <input type="date" name="happenedOn" value="${preset.happenedOn || today}" required></label>
      <label class="field">Действует до <small class="muted">(допуск, инструктаж)</small><input type="date" name="validUntil"></label></div>
    <label class="field">Виновность <small class="muted">(для ДТП)</small><select name="culpability">
      <option value="">— не определена —</option><option value="guilty">виновны</option><option value="notguilty">не виновны</option></select></label>
    <label class="field">Что произошло <textarea name="description" rows="3">${escapeHtml(preset.description || '')}</textarea></label>
    <label class="field">Меры <textarea name="measures" rows="2"></textarea></label>
    <div class="form-error" id="sfErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button primary">Сохранить</button></div></form>`);
  document.querySelector('#sfForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(['kind', 'driverId', 'vehicleId', 'happenedOn', 'validUntil', 'description', 'measures', 'culpability'].map(key => [key, form[key].value]));
    try {
      await api('/api/safety', { method: 'POST', body: JSON.stringify(body) });
      toast('Сохранено');
      context.closeModal(); after();
    } catch (error) { document.querySelector('#sfErr').textContent = error.message; }
  });
}
