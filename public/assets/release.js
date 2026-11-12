// «🛫 Выпуск» — единое место выпуска на линию (процесс П2, проект
// «Слияние», 07.11.2026). Машины с выходом сегодня и завтра и чек-лист из
// существующих отметок планера. Контролёр техсостояния (и эксплуатация)
// отмечает техконтроль — в путевой лист — или отправляет «В ремонт»
// (заезд в Ремзону с дефектом). Остальные пункты — ссылки на экраны,
// где их ставят: Ресурс, путевые листы, Диспетчер, КПП.
import { api, escapeHtml, renderInto, toast } from './api.js';

const TONE = { ok: ['на линии', 'pos'], ready: ['готов', 'pos'], risk: ['риск: не готов', 'warn'],
  late: ['выход прошёл', 'neg'], wait: ['готовится', ''] };
const dt = iso => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export async function renderRelease(container, context) {
  const { state } = context;
  let data;
  try {
    data = await api('/api/release');
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const f = state.releaseFilter || '';
  const items = data.items.filter(item => !f || item.tone === f);
  const mark = value => value === null ? '<span class="muted">—</span>' : value ? '<b class="rl-ok">✓</b>' : '<b class="rl-no">✗</b>';
  const s = data.summary;
  if (!renderInto(container, `<div class="bi-page rl-page">
    <div class="bi-sub"><h2>Выпуск на линию · сегодня и завтра</h2>
      <p>Чек-лист из отметок планера. «Выехал с базы» — подсказка КПП, не факт. Норматив подготовки — ${data.prepH ?? '—'} ч (регламент конвейера).</p>
      <div class="bi-actions"><span class="segmented">${[['', `Все ${s.total}`], ['risk', `Риск ${s.risk}`], ['late', `Просрочен ${s.late}`], ['wait', `Готовится ${s.wait}`], ['ready', `Готов ${s.ready}`], ['ok', `На линии ${s.onLine}`]]
    .map(([key, label]) => `<button data-rl-filter="${key}" class="${f === key ? 'active' : ''}">${label}</button>`).join('')}</span></div></div>
    <div class="bi-kpis bi-kpis-row">
      <div class="metric ${s.late ? 'neg' : 'pos'}"><span class="l">Выход прошёл, не на линии</span><span class="v">${s.late}</span></div>
      <div class="metric ${s.risk ? 'warn' : ''}"><span class="l">Риск: до выхода ≤ ${data.prepH ?? '—'} ч, не готов</span><span class="v">${s.risk}</span></div>
      <div class="metric"><span class="l">Готовы к выпуску</span><span class="v">${s.ready}</span></div>
      <div class="metric pos"><span class="l">На линии</span><span class="v">${s.onLine}</span></div>
    </div>
    <section class="section"><div class="sec-h"><span class="st">Выходы</span><span class="hint">рейсы и перегоны с выходом сегодня и завтра (МСК)</span></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table rl-table"><thead><tr><th>Выход</th><th>Машина · водитель</th><th>Маршрут</th>
        ${data.items_meta.map(([, label]) => `<th class="rl-c" title="${escapeHtml(label)}">${escapeHtml(label.split(' ')[0])}</th>`).join('')}<th>Состояние</th><th></th></tr></thead>
      <tbody>${items.map(item => {
    const [label, tone] = TONE[item.tone];
    return `<tr class="rl-${item.tone}">
        <td class="mono">${dt(item.startsAt)}</td>
        <td><b class="mono">${escapeHtml(item.plate)}</b><div class="muted">${escapeHtml(item.driver || 'водитель не закреплён')}</div></td>
        <td>${escapeHtml(item.route)}${item.orderNo ? `<div class="muted">№ ${escapeHtml(item.orderNo)}</div>` : ''}${item.kind === 'transfer' ? '<div class="muted">перегон</div>' : ''}</td>
        ${data.items_meta.map(([key]) => `<td class="rl-c">${mark(item.checks[key])}</td>`).join('')}
        <td><span class="bi-tag ${tone}">${label}</span>${item.lastCheck?.result === 'fail' ? `<div class="muted">✗ ${escapeHtml(item.lastCheck.defect)}</div>` : ''}</td>
        <td class="rl-acts">${data.canWrite && !item.checks.line ? `
          ${item.checks.tech ? '' : `<button class="button small" data-rl-ok="${item.id}" title="Техконтроль пройден — отметка в путевой лист">✓ Техконтроль</button>`}
          <button class="button small danger" data-rl-fail="${item.id}" title="Неисправность — не выпускать, заезд в Ремзону">✗ В ремонт</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="12" class="muted">Выходов нет</td></tr>'}</tbody></table></div></section>
  </div>`)) return;

  const find = id => data.items.find(item => item.id === id);
  const bodyOf = item => ({ vehicleId: item.vehicleId, tripId: item.kind === 'trip' ? item.id : null,
    transferId: item.kind === 'transfer' ? item.id : null, waybillId: item.waybillId });
  container.onclick = async event => {
    const filter = event.target.closest('[data-rl-filter]');
    if (filter) { state.releaseFilter = filter.dataset.rlFilter; renderRelease(container, context); return; }
    const ok = event.target.closest('[data-rl-ok]');
    if (ok) {
      const item = find(ok.dataset.rlOk);
      try {
        await api('/api/release/tech', { method: 'POST', body: JSON.stringify({ ...bodyOf(item), result: 'ok' }) });
        toast(`${item.plate}: техконтроль пройден${item.waybillId ? ' — отметка в путевом листе' : ' (путевой лист ещё не выдан)'}`);
        renderRelease(container, context);
      } catch (error) { toast(error.message); }
      return;
    }
    const fail = event.target.closest('[data-rl-fail]');
    if (fail) failDialog(context, find(fail.dataset.rlFail), bodyOf, () => renderRelease(container, context));
  };
}

function failDialog(context, item, bodyOf, after) {
  context.showModal(`<form id="rlFail"><h2>Не допускать к выпуску · ${escapeHtml(item.plate)}</h2>
    <p class="muted">Машина уйдёт в Ремзону с дефектом; механики и эксплуатация получат уведомление — рейс нужно перенести или заменить ТС.</p>
    <label class="field">Неисправность <textarea name="defect" rows="3" required placeholder="Что выявлено при осмотре"></textarea></label>
    <div class="form-error" id="rlFailErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button danger">✗ В ремонт</button></div></form>`);
  document.querySelector('#rlFail').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api('/api/release/tech', { method: 'POST', body: JSON.stringify({ ...bodyOf(item), result: 'fail', defect: event.currentTarget.defect.value }) });
      toast(`${item.plate}: в ремонт — Ремзона и эксплуатация уведомлены`);
      context.closeModal(); after();
    } catch (error) { document.querySelector('#rlFailErr').textContent = error.message; }
  });
}
