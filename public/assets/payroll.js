// Экран «∑ ФОТ водителей» (блок «ФОТ», процесс П5 — расчёт ЗП, 07.11.2026).
// Ведомость сдельной зарплаты по Положению об оплате среды СТ: км × ставка
// против гарантии за сутки работы, к выплате — больший за ПЕРИОД;
// сверхвахта — отдельной строкой. Все расчёты — на сервере (/api/payroll),
// экран только показывает. Ведомость — коммерческая тайна (уровень денег
// «все»), сервер сам отдаёт 403.
import { api, escapeHtml, money, renderInto } from './api.js';

const ruDay = iso => String(iso || '').split('-').reverse().join('.');
const km = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')}`;
// Крупно: от миллиона — «млн», меньше — «тыс» (неделя по одной машине не
// должна читаться как «0,00 млн»).
const big = value => {
  const n = Number(value || 0);
  return Math.abs(n) >= 1e6
    ? `${(n / 1e6).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<small>млн</small>`
    : `${(n / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}<small>тыс</small>`;
};
const SOURCE_TAG = { 'одометр': 'pos', 'рейсы': 'warn', 'смешанный': 'warn', '—': '' };

function rowHtml(row) {
  const ot = row.overtime || {};
  return `<tr class="${row.guaranteeDays ? 'pr-guar' : ''}" data-driver="${escapeHtml(row.driverId)}">
    <td><b>${escapeHtml(row.name)}</b>${row.plate ? ` <span class="muted">${escapeHtml(row.plate)}</span>` : ''}
      ${row.notes.length ? `<div class="pr-notes muted">${row.notes.map(escapeHtml).join(' · ')}</div>` : ''}</td>
    <td class="num">${row.days}</td>
    <td class="num">${row.trips || '—'}</td>
    <td class="num" title="${escapeHtml(row.segments.map(s => `${s.plate} ${ruDay(s.from)}–${ruDay(s.to)}: ${km(s.km)} км (${s.source})`).join('\n'))}">${km(row.km)}</td>
    <td><span class="bi-tag ${SOURCE_TAG[row.kmSource] || ''}">${escapeHtml(row.kmSource)}</span></td>
    <td class="num">${money(row.piece)}</td>
    <td class="num">${money(row.guarantee)}</td>
    <td class="num pr-pay"><b>${money(row.payable)}</b><div class="pr-basis muted">${row.basis}</div></td>
    <td class="num">${ot.days ? `${ot.days} дн · ${money(ot.amount)}` : '—'}</td>
  </tr>`;
}

function pageHtml(data, from, to) {
  const t = data.totals;
  const r = data.rates;
  return `<div class="bi-page pr-page">
    <div class="bi-sub"><h2>Ведомость сдельной зарплаты водителей</h2>
      <p>Положение об оплате среды СТ: ${km(r.ratePerKm)} ₽/км · гарантия ${money(r.guaranteePerDay)} за сутки работы
        · сверхвахта ${money(r.overtimePerDay)} за сутки
        (${escapeHtml(r.rateSource)}). ${ruDay(data.from)}–${ruDay(data.to)}, ${data.days} сут.</p>
      <div class="bi-actions pr-noprint"><span class="pr-period"><input type="date" id="prFrom" value="${from}"> — <input type="date" id="prTo" value="${to}"></span>
        <button class="button ghost" id="prPrint" type="button">🖨 Печать</button></div></div>
    <div class="bi-kpis">
      <div class="metric dept-staff hero"><span class="l">Итого к выплате</span><span class="v">${big(t.payable)}</span>
        <span class="d">${money(t.payable)}</span></div>
      <div class="metric dept-drv"><span class="l">Сдельно</span><span class="v">${big(t.piece)}</span>
        <span class="d">${km(t.km)} км × ${km(r.ratePerKm)} ₽</span></div>
      <div class="metric ${t.byGuarantee ? 'warn' : ''}"><span class="l">Гарантия · доплата</span><span class="v">${big(t.topUp)}</span>
        <span class="d">${t.guaranteeDays} сут на гарантии · ${t.byGuarantee} вод.</span></div>
      <div class="metric"><span class="l">Сверхвахта</span><span class="v">${t.overtimeDays}<small>дн</small></span>
        <span class="d">${money(t.overtimeAmount)} · входит в итог</span></div>
      <div class="metric"><span class="l">Водителей</span><span class="v">${t.drivers}</span>
        <span class="d">${Object.entries(t.kmSources).map(([k, n]) => `${escapeHtml(k)} ${n}`).join(' · ')}</span></div>
    </div>
    <div class="bi-grid">
      <section class="section s9 dept-staff"><div class="sec-h"><span class="st">По водителям</span>
        <span class="hint">к выплате = по каждым суткам больший из «сдельно» и «гарантия» + сверхвахта</span></div>
        <div class="sec-b flush bi-scroll pr-scroll"><table class="bi-table pr-table"><thead><tr>
          <th>Водитель</th><th class="r">Дни</th><th class="r">Рейсы</th><th class="r">Км</th><th>Источник км</th>
          <th class="r">Сдельно</th><th class="r">Гарантия</th><th class="r">К выплате</th><th class="r">Сверхвахта</th>
        </tr></thead>
        <tbody>${data.rows.map(rowHtml).join('') || '<tr><td colspan=9 class="bi-empty">За период нет отработанных дней в табеле</td></tr>'}</tbody>
        ${data.rows.length ? `<tfoot><tr><td>Итого · ${t.drivers} вод.</td><td class="num">${t.days}</td><td></td><td class="num">${km(t.km)}</td><td></td>
          <td class="num">${money(t.piece)}</td><td class="num">${money(t.guarantee)}</td><td class="num">${money(t.payable)}</td>
          <td class="num">${t.overtimeDays ? `${t.overtimeDays} дн` : '—'}</td></tr></tfoot>` : ''}
        </table></div></section>
      <section class="section s3"><div class="sec-h"><span class="st">Как считано</span></div>
        <div class="sec-b pr-how">
          <div class="bi-row"><span class="k">Дни работы</span><span class="v">табель «Я» + «РВ»</span></div>
          <div class="bi-row"><span class="k">Км</span><span class="v">одометр → рейсы, вместе с порожними</span></div>
          <div class="bi-row"><span class="k">Сравнение</span><span class="v">по каждым суткам</span></div>
          ${t.unassignedTrips ? `<div class="bi-row"><span class="k">Рейсы без закрепления</span><span class="v">${t.unassignedTrips}</span></div>` : ''}
          <p class="muted">${escapeHtml(data.methodNote)}</p>
          ${data.questions.length ? `<div class="pr-q"><b>Вопросы руководителю</b><ol>${data.questions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ol></div>` : ''}
        </div></section>
    </div>
  </div>`;
}

export async function renderPayroll(container, context) {
  const { state } = context;
  const today = new Date().toISOString().slice(0, 10);
  const from = state.payrollFrom || `${today.slice(0, 7)}-01`;
  const to = state.payrollTo || today;
  let data;
  try {
    data = await api(`/api/payroll?from=${from}&to=${to}`);
  } catch (error) {
    renderInto(container, `<div class="bi-page"><div class="bi-empty">${escapeHtml(error.message)}</div></div>`);
    return;
  }
  renderInto(container, pageHtml(data, from, to));
  const reload = () => renderPayroll(container, context);
  container.querySelector('#prFrom').onchange = event => { state.payrollFrom = event.currentTarget.value; reload(); };
  container.querySelector('#prTo').onchange = event => { state.payrollTo = event.currentTarget.value; reload(); };
  container.querySelector('#prPrint').onclick = () => window.print();
}
