// «🏭 Эксплуатация (планер)» — отчёт эксплуатации парка ИЗ ДАННЫХ ПЛАНЕРА
// за произвольный период, независимо от 1С. Канон КИП (принят 15.09,
// единый с 1С-версией): на линии = «на линию» → выгрузка (+перегоны);
// под грузом = убытие с погрузки → ПРИБЫТИЕ на выгрузку; стоянка у
// клиента — потеря КИП. Печать/PDF — браузерной печатью (printable).
import { api, escapeHtml, money } from './api.js';

const pct = value => String(value).replace('.', ',') + '%';
const mln = value => (value / 1e6).toFixed(1).replace('.', ',') + ' млн';

export async function plannerParkDialog(context) {
  const { showModal } = context;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  showModal(`<form id="ppForm"><h2>🏭 Эксплуатация парка (по данным планера)</h2>
    <p class="muted">Каскад КТГ × КВЛ × КИП по единому канону, недели, клиенты и
      сценарии к плану — без выгрузок 1С. Конец периода не включается.</p>
    <div class="form-grid">
      <label class="field">С<input type="date" name="from" value="${monthStart}" required></label>
      <label class="field">По (не включая)<input type="date" name="to" value="${today}" required></label>
    </div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сформировать</button>
    </div></form>`);
  document.getElementById('ppForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    let data;
    try { data = await api(`/api/park-report?from=${values.from}&to=${values.to}`); }
    catch (error) { alert(error.message); return; }
    renderReport(context, data);
  };
}

function renderReport(context, { total, weeks, clients, canon }) {
  const plan = 160_000_000;
  const lastFull = [...weeks].reverse().find(week => week.days === 7) || total;
  const base = lastFull.rev / lastFull.days * 30;
  const scen = (name, ktg, kvl, kip) => {
    const koef = ktg * kvl * kip / 10000;
    return { name, koef, rev: base * koef / lastFull.koef };
  };
  const scenarios = [
    { name: `показатели ${lastFull.from}…${lastFull.to}`, koef: lastFull.koef, rev: base },
    scen('КТГ до 95%', 95, lastFull.kvl, lastFull.kip),
    scen('КВЛ до 85%', lastFull.ktg, 85, lastFull.kip),
    scen('КТГ 95% + КВЛ 85%', 95, 85, lastFull.kip),
  ];
  const cascade = row => `<td class="num">${pct(row.ktg)}</td><td class="num">${pct(row.kvl)}</td>
    <td class="num">${pct(row.kip)}</td><td class="num"><b>${pct(row.koef)}</b></td>`;
  context.showModal(`<div class="report printable-park">
    <h3><span style="color:var(--teal);font-weight:800">PegasLogistic</span>
      · Эксплуатация парка · ${total.from} — ${total.to}</h3>
    <div class="geohint">По данным планера (рейсы, факты контроля, диспозиции), без 1С.
      Суммы без НДС (÷1,22 организации, ÷1,07 ИП). Канон: ${escapeHtml(canon)}.</div>
    <h4>Итог периода (${total.days} дн · парк ${total.fleet})</h4>
    <table class="rep-table"><tr>
      <th>Выручка</th><th>Рейсов</th><th>На линии, ч</th><th>Под грузом, ч</th>
      <th>У клиента сверх, ч</th><th>Ремонт, ч</th><th>Без водителя, ч</th>
      <th>КТГ</th><th>КВЛ</th><th>КИП</th><th>КОЭФ</th></tr>
      <tr><td class="num"><b>${mln(total.rev)}</b></td><td class="num">${total.trips}</td>
      <td class="num">${total.lineH}</td><td class="num">${total.prodH}</td>
      <td class="num">${total.custH}</td><td class="num">${total.remH}</td>
      <td class="num">${total.noDrvH}</td>${cascade(total)}</tr></table>
    <h4>Недели периода</h4>
    <table class="rep-table"><tr><th>Неделя</th><th>Выручка</th><th>Рейсов</th>
      <th>Под грузом, ч</th><th>Ремонт, ч</th><th>КТГ</th><th>КВЛ</th><th>КИП</th><th>КОЭФ</th></tr>
      ${weeks.map(week => `<tr><td>${week.from} — ${week.to}</td>
        <td class="num">${mln(week.rev)}</td><td class="num">${week.trips}</td>
        <td class="num">${week.prodH}</td><td class="num">${week.remH}</td>${cascade(week)}</tr>`).join('')}
    </table>
    <h4>Сценарии к плану ${mln(plan)} (от последней полной недели, ×30 дней)</h4>
    <table class="rep-table"><tr><th>Сценарий</th><th>КОЭФ</th><th>Прогноз месяца</th><th>К плану</th></tr>
      ${scenarios.map(item => `<tr><td>${escapeHtml(item.name)}</td>
        <td class="num">${pct(+item.koef.toFixed(1))}</td>
        <td class="num">${mln(item.rev)}</td>
        <td class="num" style="color:${item.rev >= plan ? 'var(--ok)' : 'var(--bad)'}">
          ${item.rev >= plan ? '+' : '−'}${mln(Math.abs(item.rev - plan))}</td></tr>`).join('')}
    </table>
    <h4>Клиенты периода</h4>
    <table class="rep-table"><tr><th>Клиент</th><th>Рейсов</th><th>Выручка</th></tr>
      ${clients.map(client => `<tr><td>${escapeHtml(client.name)}</td>
        <td class="num">${client.n}</td><td class="num">${mln(client.rev)}</td></tr>`).join('')}
    </table>
  </div>
  <div class="modal-actions no-print">
    <button type="button" class="button ghost" id="ppPrint">Печать / PDF</button>
    <button type="button" class="button ghost" id="ppBack">Другой период</button>
    <button type="button" class="button" data-close>Закрыть</button>
  </div>`, 'wide printable');
  document.getElementById('ppPrint').onclick = () => window.print();
  document.getElementById('ppBack').onclick = () => plannerParkDialog(context);
}
